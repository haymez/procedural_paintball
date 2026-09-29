// Remote entity interpolation: a short history of server states per entity,
// sampled at render time (SnapClock.renderTick).
//
//   positions  cubic Hermite between the bracketing samples using the server
//              velocities (smooth curves through jumps and turns), falling
//              back to linear per axis when the velocities disagree with the
//              motion (collisions) and for grounded y (vy is 0 on slopes)
//   yaw        shortest-arc lerp
//   discrete   (move, alive, coats…) from the sample at or before render time
//   gaps       past the newest sample: extrapolate with velocity ≤ 200 ms, then hold
//   teleports  (respawn, > 6 m jumps) snap instead of sliding across the map
//
// Display positions pass through a small error offset: when the interpolated
// path jumps (an extrapolation guess turned out wrong), the jump is folded
// into the offset and decays over ~100 ms instead of popping.
import { copyPlayerState, createPlayerState, Move, type PlayerState, type VehicleState } from "../../../../shared/sim/index";

const MAX_EXTRAP = 12; // ticks
const TELEPORT = 6;
const MISMATCH = 3; // m/s: velocity vs motion disagreement → linear
const HIST = 24;
const TICK_S = 1 / 60;

export interface Kin {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  yaw: number;
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  d -= Math.PI * 2 * Math.floor((d + Math.PI) / (Math.PI * 2));
  return a + d * t;
}

/** Hermite on one axis. dt in seconds between samples. */
export function hermite(p0: number, v0: number, p1: number, v1: number, dt: number, t: number): number {
  const t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * p0 + (t3 - 2 * t2 + t) * v0 * dt + (-2 * t3 + 3 * t2) * p1 + (t3 - t2) * v1 * dt;
}

function axis(p0: number, v0: number, p1: number, v1: number, dt: number, t: number, smooth: boolean): number {
  if (!smooth || dt <= 0) return p0 + (p1 - p0) * t;
  const implied = (p1 - p0) / dt;
  if (Math.abs(v0 - implied) > MISMATCH || Math.abs(v1 - implied) > MISMATCH) return p0 + (p1 - p0) * t;
  return hermite(p0, v0, p1, v1, dt, t);
}

/** Interpolate kinematics between a (tick ta) and b (tick tb) at tick t into out. */
export function interpKin(a: Kin, ta: number, b: Kin, tb: number, t: number, out: Kin, smoothY: boolean, smooth = true): Kin {
  const span = tb - ta;
  const f = span > 0 ? Math.max(0, Math.min(1, (t - ta) / span)) : 1;
  const dt = span * TICK_S;
  out.x = axis(a.x, a.vx, b.x, b.vx, dt, f, smooth);
  out.z = axis(a.z, a.vz, b.z, b.vz, dt, f, smooth);
  out.y = axis(a.y, a.vy, b.y, b.vy, dt, f, smooth && smoothY);
  out.vx = a.vx + (b.vx - a.vx) * f;
  out.vy = a.vy + (b.vy - a.vy) * f;
  out.vz = a.vz + (b.vz - a.vz) * f;
  out.yaw = lerpAngle(a.yaw, b.yaw, f);
  return out;
}

interface PSample {
  tick: number;
  s: PlayerState;
}

/** One remote player's history + display state. */
export class RemotePlayer {
  readonly hist: PSample[] = [];
  private pool: PSample[] = [];
  /** What gets rendered (Actors / HUD read this). */
  readonly display: PlayerState;
  private ox = 0; private oy = 0; private oz = 0;
  private lx = NaN; private ly = 0; private lz = 0;
  private lastAlive = false;
  /** Sum of |second difference| of displayed positions (smoothness metric). */
  jerkSum = 0;
  jerkN = 0;
  private px1 = NaN; private py1 = 0; private pz1 = 0;
  private px2 = NaN; private py2 = 0; private pz2 = 0;
  extrapolating = false;

  constructor(readonly id: number) {
    this.display = createPlayerState(id);
  }

  /** Record the authoritative state at `tick` (copied). */
  push(tick: number, s: PlayerState): void {
    const last = this.hist[this.hist.length - 1];
    if (last && tick <= last.tick) {
      if (tick === last.tick) copyPlayerState(s, last.s);
      return;
    }
    const smp = this.pool.pop() ?? { tick: 0, s: createPlayerState(this.id) };
    smp.tick = tick;
    copyPlayerState(s, smp.s);
    this.hist.push(smp);
    while (this.hist.length > HIST) this.pool.push(this.hist.shift()!);
  }

  get newest(): number {
    return this.hist.length ? this.hist[this.hist.length - 1]!.tick : -1;
  }

  /** Next update jumps straight to its sample (after a stall) instead of sliding there. */
  resetSmoothing(): void {
    this.lx = NaN;
    this.ox = this.oy = this.oz = 0;
    this.px1 = NaN;
    this.px2 = NaN;
  }

  private readonly k: Kin = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0 };

  /** Update `display` for render tick t. dt = seconds since the last update. */
  update(t: number, dt: number): PlayerState {
    const h = this.hist;
    const d = this.display;
    if (!h.length) return d;
    let i = h.length - 1;
    while (i > 0 && h[i]!.tick > t) i--;
    const a = h[i]!;
    const b = h[i + 1];
    const k = this.k;
    let teleport = false;
    if (b && t >= a.tick) {
      const as = a.s, bs = b.s;
      const jump = Math.hypot(bs.x - as.x, bs.y - as.y, bs.z - as.z);
      // fast movers (sky-drop gliders at 30-40 m/s, sparse far updates) legitimately cover more than TELEPORT
      const travel = Math.hypot(as.vx + bs.vx, as.vy + bs.vy, as.vz + bs.vz) * 0.5 * (b.tick - a.tick) * TICK_S;
      const discontinuous = as.alive !== bs.alive || jump > TELEPORT + travel * 1.25 || as.move === Move.Dead || bs.move === Move.Dead;
      if (discontinuous) {
        const src = t - a.tick < b.tick - t ? as : bs;
        k.x = src.x; k.y = src.y; k.z = src.z; k.vx = src.vx; k.vy = src.vy; k.vz = src.vz; k.yaw = src.yaw;
        copyPlayerState(src, d);
        teleport = true;
      } else {
        const smoothable = as.move !== Move.Mantle && as.move !== Move.Zipline && as.move !== Move.Vehicle && bs.move !== Move.Mantle;
        const groundY = as.grounded && bs.grounded;
        interpKin(as, a.tick, bs, b.tick, t, k, !groundY, smoothable);
        copyPlayerState(t - a.tick < (b.tick - a.tick) * 0.999 ? as : bs, d);
        const f = Math.max(0, Math.min(1, (t - a.tick) / (b.tick - a.tick)));
        d.pitch = as.pitch + (bs.pitch - as.pitch) * f;
        d.zipT = as.zipT + (bs.zipT - as.zipT) * f;
      }
      this.extrapolating = false;
    } else {
      // before the oldest sample (rare) or past the newest: extrapolate briefly
      const s = a.s;
      const ahead = Math.max(0, Math.min(MAX_EXTRAP, t - a.tick)) * TICK_S;
      const moving = s.alive && s.move !== Move.Dead && s.move !== Move.Vehicle && s.move !== Move.Mantle;
      k.x = s.x + (moving ? s.vx * ahead : 0);
      k.z = s.z + (moving ? s.vz * ahead : 0);
      k.y = s.y + (moving && !s.grounded ? s.vy * ahead : 0);
      k.vx = s.vx; k.vy = s.vy; k.vz = s.vz; k.yaw = s.yaw;
      copyPlayerState(s, d);
      this.extrapolating = t > a.tick;
    }
    if (d.alive !== this.lastAlive) teleport = true;
    this.lastAlive = d.alive;
    // fold unexpected jumps into a decaying offset
    if (!Number.isNaN(this.lx) && !teleport) {
      const ex = this.lx + k.vx * dt, ey = this.ly + k.vy * dt, ez = this.lz + k.vz * dt;
      const jx = k.x - ex, jy = k.y - ey, jz = k.z - ez;
      const j = Math.hypot(jx, jy, jz);
      if (j > 0.25 && j < TELEPORT) { this.ox -= jx; this.oy -= jy; this.oz -= jz; }
    } else if (teleport) { this.ox = 0; this.oy = 0; this.oz = 0; }
    this.lx = k.x; this.ly = k.y; this.lz = k.z;
    const decay = Math.exp(-dt / 0.07);
    this.ox *= decay; this.oy *= decay; this.oz *= decay;
    d.x = k.x + this.ox; d.y = k.y + this.oy; d.z = k.z + this.oz;
    d.vx = k.vx; d.vy = k.vy; d.vz = k.vz;
    d.yaw = k.yaw;
    // smoothness metric: |x[n] - 2x[n-1] + x[n-2]|
    if (!teleport && !Number.isNaN(this.px2) && d.alive) {
      const jx = d.x - 2 * this.px1 + this.px2, jy = d.y - 2 * this.py1 + this.py2, jz = d.z - 2 * this.pz1 + this.pz2;
      const jm = Math.hypot(jx, jy, jz);
      if (jm < 1) { this.jerkSum += jm; this.jerkN++; }
    }
    if (teleport) this.px1 = NaN;
    this.px2 = this.px1; this.py2 = this.py1; this.pz2 = this.pz1;
    this.px1 = d.x; this.py1 = d.y; this.pz1 = d.z;
    return d;
  }
}

interface VSample {
  tick: number;
  s: VehicleState;
}

function copyVehicle(src: VehicleState, dst: VehicleState): VehicleState {
  const seats = dst.seats;
  Object.assign(dst, src);
  seats.length = src.seats.length;
  for (let i = 0; i < src.seats.length; i++) seats[i] = src.seats[i]!;
  dst.seats = seats;
  return dst;
}
export { copyVehicle };

/** One remote vehicle's history + display state. */
export class RemoteVehicle {
  readonly hist: VSample[] = [];
  private pool: VSample[] = [];
  readonly display: VehicleState;
  private readonly k: Kin = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0 };
  private readonly ka: Kin = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0 };
  private readonly kb: Kin = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0 };

  constructor(readonly id: number, init: VehicleState) {
    this.display = copyVehicle(init, { ...init, seats: init.seats.slice() });
  }

  /** Recent spacing of this vehicle's samples (ticks): far ones arrive at a lower rate. */
  private gap = 2;
  /** Extra render delay (ticks) on top of renderTick so sparse samples still bracket t. */
  private extra = 0;

  push(tick: number, s: VehicleState): void {
    const last = this.hist[this.hist.length - 1];
    if (last && tick <= last.tick) {
      if (tick === last.tick) copyVehicle(s, last.s);
      return;
    }
    // Sparse (far) updates are real samples of a moving vehicle: interpolate
    // between them with a little extra delay instead of holding still.
    if (last) {
      const g = Math.min(30, tick - last.tick);
      this.gap = g > this.gap ? g : this.gap + (g - this.gap) * 0.2;
    }
    const smp = this.pool.pop() ?? { tick: 0, s: { ...s, seats: s.seats.slice() } };
    smp.tick = tick;
    copyVehicle(s, smp.s);
    this.hist.push(smp);
    while (this.hist.length > HIST) this.pool.push(this.hist.shift()!);
  }

  private kin(s: VehicleState, out: Kin): Kin {
    out.x = s.x; out.y = s.y; out.z = s.z;
    out.vx = Math.sin(s.yaw) * s.speed; out.vz = Math.cos(s.yaw) * s.speed; out.vy = s.vy;
    out.yaw = s.yaw;
    return out;
  }

  update(tIn: number): VehicleState {
    const h = this.hist;
    const d = this.display;
    if (!h.length) return d;
    // renderTick already allows for the normal 2-tick snapshot spacing
    const want = Math.max(0, this.gap - 2);
    this.extra += Math.max(-0.08, Math.min(0.08, want - this.extra));
    const t = tIn - this.extra;
    let i = h.length - 1;
    while (i > 0 && h[i]!.tick > t) i--;
    const a = h[i]!;
    const b = h[i + 1];
    if (b && t >= a.tick) {
      const f = Math.max(0, Math.min(1, (t - a.tick) / (b.tick - a.tick)));
      const jump = Math.hypot(b.s.x - a.s.x, b.s.z - a.s.z);
      copyVehicle(f < 0.5 ? a.s : b.s, d);
      if (jump < TELEPORT * 2) {
        interpKin(this.kin(a.s, this.ka), a.tick, this.kin(b.s, this.kb), b.tick, t, this.k, a.s.airborne || b.s.airborne);
        d.x = this.k.x; d.y = this.k.y; d.z = this.k.z; d.yaw = this.k.yaw;
        d.speed = a.s.speed + (b.s.speed - a.s.speed) * f;
        d.steer = a.s.steer + (b.s.steer - a.s.steer) * f;
        d.pitch = a.s.pitch + (b.s.pitch - a.s.pitch) * f;
      }
    } else {
      const s = a.s;
      copyVehicle(s, d);
      const ahead = Math.max(0, Math.min(MAX_EXTRAP, t - a.tick)) * TICK_S;
      d.x = s.x + Math.sin(s.yaw) * s.speed * ahead;
      d.z = s.z + Math.cos(s.yaw) * s.speed * ahead;
    }
    return d;
  }
}
