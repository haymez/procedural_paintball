// Paintball marker math shared by the sim and the client (trajectory preview).
import { hash2f } from "../math/rng";
import { cos, sin, TAU } from "../math/trig";
import { raycast, type Vec3 } from "../world/collide";
import { PickupKind } from "../world/types";
import * as C from "./constants";
import { NO_WATER_Y, waterAt, type SimEnv } from "./env";
import { aimDir, eyeHeight, hasUpgrade } from "./player";
import { Move, type PlayerState } from "./types";

export function hopperCap(p: PlayerState): number {
  return hasUpgrade(p, PickupKind.BigHopper) ? C.BIG_HOPPER : C.HOPPER;
}
export function fireInterval(p: PlayerState): number {
  return hasUpgrade(p, PickupKind.RapidFire) ? C.RAPID_INTERVAL : C.FIRE_INTERVAL;
}
export function ballSpeed(p: PlayerState): number {
  return C.BALL_SPEED * (hasUpgrade(p, PickupKind.LongBarrel) ? C.LONGBARREL_MULT : 1);
}

/** Aim origin: the sim's eye point. The client derives cmd.yaw/pitch so this ray passes through its crosshair. */
export function eyePos(p: PlayerState, out: Vec3): Vec3 {
  out.x = p.x;
  out.y = p.y + (p.move === Move.Vehicle ? 1.25 : eyeHeight(p.move));
  out.z = p.z;
  return out;
}

/** Where balls leave the marker (approximates the blob's muzzle while aiming). */
export function muzzlePos(p: PlayerState, out: Vec3): Vec3 {
  const sy = sin(p.yaw), cy = cos(p.yaw);
  const e = eyePos(p, out);
  // forward 0.55, right 0.2, below the eye 0.42
  e.x += sy * 0.55 - cy * 0.2;
  e.z += cy * 0.55 + sy * 0.2;
  e.y -= 0.42;
  return e;
}

export interface Launch {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  /** Aim point the launch converges on. */
  tx: number; ty: number; tz: number;
}

const _e: Vec3 = { x: 0, y: 0, z: 0 };
const _d: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * Ball launch from p's muzzle converging on the eye-ray target. `extraHit`
 * (players) may shorten the ray. `spread` in radians, (u1, u2) in [0,1) pick
 * the offset inside the cone.
 */
export function computeLaunch(
  env: SimEnv, p: PlayerState, spread: number, u1: number, u2: number, out: Launch,
  extraHit?: (ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number) => number,
): Launch {
  const e = eyePos(p, _e);
  const d = aimDir(p.yaw, p.pitch, _d);
  let t = C.AIM_RANGE;
  const hit = raycast(env.cw, e.x, e.y, e.z, d.x, d.y, d.z, C.AIM_RANGE);
  if (hit) t = hit.t;
  if (extraHit) { const tp = extraHit(e.x, e.y, e.z, d.x, d.y, d.z, t); if (tp < t) t = tp; }
  if (t < 1.5) t = 8; // point blank at a wall: just shoot straight
  out.tx = e.x + d.x * t; out.ty = e.y + d.y * t; out.tz = e.z + d.z * t;
  muzzlePos(p, out);
  let lx = out.tx - out.x, ly = out.ty - out.y, lz = out.tz - out.z;
  const L = Math.sqrt(lx * lx + ly * ly + lz * lz) || 1;
  lx /= L; ly /= L; lz /= L;
  // spread cone
  if (spread > 0) {
    const ang = spread * Math.sqrt(u1);
    const phi = TAU * u2;
    // basis perpendicular to l
    let ax = lz, az = -lx; // cross(l, up)
    let al = Math.sqrt(ax * ax + az * az);
    if (al < 1e-5) { ax = 1; az = 0; al = 1; }
    ax /= al; az /= al;
    // b = cross(a, l)
    const bx = -az * ly, by = az * lx - ax * lz, bz = ax * ly;
    const ca = cos(phi) * ang, sa = sin(phi) * ang;
    lx += ax * ca + bx * sa; ly += by * sa; lz += az * ca + bz * sa;
    const n = Math.sqrt(lx * lx + ly * ly + lz * lz);
    lx /= n; ly /= n; lz /= n;
  }
  const speed = ballSpeed(p);
  const zero = hasUpgrade(p, PickupKind.LongBarrel) ? C.ZERO_DIST_LONG : C.ZERO_DIST;
  const c = L < zero ? L : zero;
  const tf = c / speed;
  out.vx = lx * speed;
  out.vy = ly * speed + 0.5 * C.BALL_GRAVITY * tf;
  out.vz = lz * speed;
  return out;
}

/** Current spread cone half-angle for p. */
export function currentSpread(p: PlayerState): number {
  let s = p.aiming ? C.SPREAD_AIM : C.SPREAD_HIP;
  const hs = Math.sqrt(p.vx * p.vx + p.vz * p.vz);
  const mv = Math.min(1.5, hs / C.RUN_SPEED);
  s += C.SPREAD_MOVE * mv * (p.aiming ? 0.35 : 1);
  if (p.move === Move.Air || p.move === Move.Dive || p.move === Move.Zipline) s += C.SPREAD_AIR * (p.aiming ? 0.35 : 1);
  if (p.move === Move.Vehicle) s += 0.01;
  return s;
}

/** Deterministic per-shot random numbers (same on server and client prediction). */
export function shotRandom(pid: number, seq: number, k: number): number {
  return hash2f(pid * 7 + k, seq, 0x5eed);
}

export interface ArcResult {
  /** Points written (xyz triplets). */
  count: number;
  hit: boolean;
  x: number; y: number; z: number;
  nx: number; ny: number; nz: number;
  water: boolean;
  time: number;
}

/**
 * Trace a ballistic arc for the aiming preview. Writes up to points.length/3
 * points every `stepDt` seconds. Stops at the first world/water hit.
 */
export function traceArc(
  env: SimEnv, x: number, y: number, z: number, vx: number, vy: number, vz: number,
  maxT: number, stepDt: number, points: Float32Array, out: ArcResult,
): ArcResult {
  const maxPts = (points.length / 3) | 0;
  let n = 0;
  let t = 0;
  out.hit = false; out.water = false;
  points[0] = x; points[1] = y; points[2] = z; n = 1;
  while (t < maxT && n < maxPts) {
    const nvy = vy - C.BALL_GRAVITY * stepDt;
    const nx = x + vx * stepDt, ny = y + (vy + nvy) * 0.5 * stepDt, nz = z + vz * stepDt;
    vy = nvy;
    const dx = nx - x, dy = ny - y, dz = nz - z;
    const L = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const h = raycast(env.cw, x, y, z, dx, dy, dz, L);
    const W = waterAt(env, nx, nz);
    if (h) {
      out.hit = true; out.x = h.x; out.y = h.y; out.z = h.z; out.nx = h.nx; out.ny = h.ny; out.nz = h.nz;
      out.time = t + (h.t / L) * stepDt;
      points[n * 3] = h.x; points[n * 3 + 1] = h.y; points[n * 3 + 2] = h.z; n++;
      break;
    }
    if (W !== NO_WATER_Y && ny < W && y >= W) {
      const f = (y - W) / (y - ny || 1);
      out.hit = true; out.water = true;
      out.x = x + dx * f; out.y = W; out.z = z + dz * f; out.nx = 0; out.ny = 1; out.nz = 0;
      out.time = t + f * stepDt;
      points[n * 3] = out.x; points[n * 3 + 1] = W; points[n * 3 + 2] = out.z; n++;
      break;
    }
    x = nx; y = ny; z = nz; t += stepDt;
    points[n * 3] = x; points[n * 3 + 1] = y; points[n * 3 + 2] = z; n++;
  }
  out.count = n;
  if (!out.hit) { out.x = x; out.y = y; out.z = z; out.nx = 0; out.ny = 1; out.nz = 0; out.time = t; }
  return out;
}
