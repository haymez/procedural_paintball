// Human-like aiming. The bot has a "crosshair" (yaw, pitch) driven by a
// damped spring toward where it wants to aim (so flicks overshoot and
// tracking lags), plus a slowly drifting error offset that is large on a
// fresh target and shrinks while the bot holds still on it. Where it wants
// to aim comes from the ballistic solution: lead the (imperfectly estimated)
// target velocity, then convert the physical intercept point into the sim's
// zeroed crosshair aim (shots converge on whatever the eye ray hits, up to
// ZERO_DIST) by iterating the sim's own computeLaunch.
import { atan2, cos, wrapAngle } from "../../math/trig";
import {
  BALL_GRAVITY, computeLaunch, createPlayerState, eyePos, Move,
  type Launch, type MatchSim, type PlayerState,
} from "../../sim/index";
import type { Rng } from "../../math/rng";

const _L: Launch = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, tx: 0, ty: 0, tz: 0 };
const _e = { x: 0, y: 0, z: 0 };

export interface AimOut {
  yaw: number;
  pitch: number;
  /** Flight time to the aim point (s), Infinity if out of reach. */
  t: number;
}

/**
 * Crosshair yaw/pitch for `me` so the ball passes through (tx, ty, tz).
 * `scratch` is a PlayerState the solver may overwrite. 3 launch evaluations
 * (yaw fixed-point + pitch secant); cheap (~3 short raycasts).
 */
export function solveCrosshair(
  sim: MatchSim, me: PlayerState, scratch: PlayerState, tx: number, ty: number, tz: number, out: AimOut,
): AimOut {
  scratch.x = me.x; scratch.y = me.y; scratch.z = me.z;
  scratch.move = me.move; scratch.upgrades = me.upgrades;
  const e = eyePos(scratch, _e);
  let dx = tx - e.x, dz = tz - e.z;
  let hd = Math.sqrt(dx * dx + dz * dz);
  let yaw = atan2(dx, dz);
  let pitch = atan2(ty - e.y, hd);
  const hit = (ox: number, oy: number, oz: number, ux: number, uy: number, uz: number, maxT: number) => sim.rayPlayers(me.id, ox, oy, oz, ux, uy, uz, maxT);
  let p0 = 0, f0 = 0;
  out.t = Infinity;
  for (let k = 0; k < 3; k++) {
    scratch.yaw = yaw;
    scratch.pitch = pitch;
    computeLaunch(sim.env, scratch, 0, 0, 0, _L, hit);
    dx = tx - _L.x; dz = tz - _L.z;
    hd = Math.sqrt(dx * dx + dz * dz);
    const hv = Math.sqrt(_L.vx * _L.vx + _L.vz * _L.vz);
    if (hv < 0.5 || hd < 0.3) break;
    const t = hd / hv;
    const yAt = _L.y + _L.vy * t - 0.5 * BALL_GRAVITY * t * t;
    const f = yAt - ty;
    out.t = t;
    yaw = wrapAngle(yaw + wrapAngle(atan2(dx, dz) - atan2(_L.vx, _L.vz)));
    let np: number;
    if (k === 0 || Math.abs(f - f0) < 1e-6) {
      const c = cos(pitch);
      np = pitch - (f / hd) * c * c;
    } else np = pitch - (f * (pitch - p0)) / (f - f0);
    p0 = pitch; f0 = f;
    pitch = np < -1.44 ? -1.44 : np > 1.44 ? 1.44 : np;
  }
  out.yaw = yaw;
  out.pitch = pitch;
  return out;
}

/** Aim point on a body (feet position + state): chest-ish, lower when low. */
export function bodyAimY(o: PlayerState): number {
  switch (o.move) {
    case Move.Swim: return o.y + 0.62;
    case Move.Underwater: return o.y + 0.5;
    case Move.Slide: case Move.Dive: case Move.SteepSlide: return o.y + 0.55;
    case Move.Vehicle: return o.y + 0.7;
    default: return o.y + 1.0;
  }
}

/**
 * The crosshair: a damped spring toward the wanted angles with a speed cap,
 * plus a drifting error offset.
 */
export class AimSpring {
  yaw = 0;
  pitch = 0;
  private vy = 0;
  private vp = 0;
  /** Current error offset (rad) and where it is drifting to. */
  ex = 0;
  ey = 0;
  private gx = 0;
  private gy = 0;
  private driftT = 0;

  reset(yaw: number, pitch: number): void {
    this.yaw = yaw; this.pitch = pitch; this.vy = 0; this.vp = 0;
  }

  /**
   * Spring step toward (wy, wp). (fy, fp) is the feed-forward angular
   * velocity (how fast the aim point is sliding across the view): a skilled
   * player matches it and tracks without lag, a novice trails behind.
   */
  step(dt: number, wy: number, wp: number, freq: number, damp: number, maxSpeed: number, fy = 0, fp = 0): void {
    const w2 = freq * freq, c = 2 * damp * freq;
    const dy = wrapAngle(wy - this.yaw), dp = wp - this.pitch;
    this.vy += (w2 * dy + c * (fy - this.vy)) * dt;
    this.vp += (w2 * dp + c * (fp - this.vp)) * dt;
    const s = Math.sqrt(this.vy * this.vy + this.vp * this.vp);
    if (s > maxSpeed) { this.vy *= maxSpeed / s; this.vp *= maxSpeed / s; }
    this.yaw = wrapAngle(this.yaw + this.vy * dt);
    this.pitch += this.vp * dt;
    if (this.pitch > 1.4) { this.pitch = 1.4; this.vp = 0; }
    else if (this.pitch < -1.4) { this.pitch = -1.4; this.vp = 0; }
  }

  /** Angular speed of the crosshair right now (rad/s). */
  get speed(): number {
    return Math.sqrt(this.vy * this.vy + this.vp * this.vp);
  }

  /**
   * Drift the error offset toward a new random point every ~0.3-0.6 s;
   * `mag` is the current error size (rad). Vertical error is a bit smaller
   * (people misjudge lead more than height).
   */
  drift(dt: number, mag: number, rng: Rng): void {
    this.driftT -= dt;
    if (this.driftT <= 0) {
      this.driftT = 0.3 + rng.next() * 0.35;
      // sum of two uniforms: triangular, centre-weighted
      this.gx = (rng.next() + rng.next() - 1) * 1.6;
      this.gy = (rng.next() + rng.next() - 1) * 1.1;
    }
    const k = Math.min(1, dt * 5);
    this.ex += (this.gx * mag - this.ex) * k;
    this.ey += (this.gy * mag - this.ey) * k;
  }

  /** Kick the error (new target, got hit, jumped). */
  kick(mag: number, rng: Rng): void {
    this.ex += (rng.next() * 2 - 1) * mag;
    this.ey += (rng.next() * 2 - 1) * mag * 0.6;
    this.driftT = 0;
  }
}

/** Fresh scratch player for the solver. */
export function scratchPlayer(id: number): PlayerState {
  const s = createPlayerState(id);
  s.alive = true;
  s.move = Move.Ground;
  return s;
}
