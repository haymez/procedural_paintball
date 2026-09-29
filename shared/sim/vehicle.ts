// Vehicle physics: boats float on flat water and can't touch land; the Vespa
// follows the ground on two wheel probes, launches off crests, bounces on
// landing and refuses cliffs and deep water. stepVehicle is pure w.r.t. `v`.
import { atan, atan2, cos, sin, wrapAngle } from "../math/trig";
import { sdfNormal, terrainHeight, terrainNormal, type Vec3 } from "../world/collide";
import { VehicleKind, WORLD_HALF, type VehicleSpawn } from "../world/types";
import * as C from "./constants";
import { BLOCKED, NO_WATER_Y, dist, probeGround, waterAt, type SimEnv } from "./env";
import type { InputCmd, VehicleState } from "./types";

/** Seat anchors in vehicle-local space (x left, y up, z forward) + facing offset. Matches the renderer. */
export const SEATS: Record<VehicleKind, { x: number; y: number; z: number; yaw: number }[]> = {
  [VehicleKind.Rowboat]: [
    { x: 0, y: 0.43, z: -0.15, yaw: Math.PI },
    { x: 0, y: 0.47, z: -1.25, yaw: 0 },
  ],
  [VehicleKind.Gondola]: [
    { x: 0, y: 0.52, z: -2.45, yaw: 0 },
    { x: 0, y: 0.5, z: -0.55, yaw: 0 },
    { x: 0, y: 0.48, z: 0.75, yaw: Math.PI },
  ],
  [VehicleKind.Vespa]: [
    { x: 0, y: 0.72, z: -0.2, yaw: 0 },
    { x: 0, y: 0.73, z: -0.52, yaw: 0 },
  ],
};

/** Hull half-length / half-beam for boats; wheelbase half for the Vespa. */
export const HULL: Record<VehicleKind, { hl: number; hb: number }> = {
  [VehicleKind.Rowboat]: { hl: 1.8, hb: 0.68 },
  [VehicleKind.Gondola]: { hl: 3.2, hb: 0.63 },
  [VehicleKind.Vespa]: { hl: 0.65, hb: 0.3 },
};

export const VEHICLE_NAMES: Record<VehicleKind, string> = {
  [VehicleKind.Rowboat]: "boat",
  [VehicleKind.Gondola]: "gondola",
  [VehicleKind.Vespa]: "Vespa",
};

export function createVehicleState(id: number, s: VehicleSpawn, env: SimEnv): VehicleState {
  const v: VehicleState = {
    id, kind: s.kind, x: s.x, y: s.y, z: s.z, yaw: s.rotY, speed: 0, vy: 0, steer: 0, throttle: 0, pitch: 0,
    airborne: false, seats: SEATS[s.kind].map(() => -1), idle: 0, sx: s.x, sy: s.y, sz: s.z, syaw: s.rotY,
  };
  resetVehicle(v, env);
  return v;
}

export function resetVehicle(v: VehicleState, env: SimEnv): void {
  v.x = v.sx; v.z = v.sz; v.yaw = v.syaw; v.speed = 0; v.vy = 0; v.steer = 0; v.throttle = 0; v.pitch = 0; v.airborne = false;
  if (v.kind === VehicleKind.Vespa) {
    const g = probeGround(env, v.x, v.sy + 2, v.z, 6);
    v.y = g === BLOCKED || g === -Infinity ? v.sy : g;
  } else {
    const w = waterAt(env, v.x, v.z);
    v.y = w === NO_WATER_Y ? v.sy : w;
  }
  v.idle = 0;
}

/** World position of a seat (feet/anchor) into out. */
export function seatWorld(v: VehicleState, seat: number, out: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  const s = SEATS[v.kind][seat];
  const sy = sin(v.yaw), cy = cos(v.yaw);
  // local x is the vehicle's left: world = (lx*cos + lz*sin, ., -lx*sin + lz*cos)
  out.x = v.x + s.x * cy + s.z * sy;
  out.z = v.z - s.x * sy + s.z * cy;
  out.y = v.y + s.y + s.z * (v.kind === VehicleKind.Vespa ? -sin(v.pitch) : 0);
  return out;
}

export function vehicleMaxSpeed(kind: VehicleKind): number {
  return kind === VehicleKind.Rowboat ? C.ROWBOAT_SPEED : kind === VehicleKind.Gondola ? C.GONDOLA_SPEED : C.VESPA_SPEED;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function boatFits(env: SimEnv, kind: VehicleKind, x: number, z: number, yaw: number, W: number): boolean {
  const h = HULL[kind];
  const sy = sin(yaw), cy = cos(yaw);
  for (let i = 0; i < 5; i++) {
    const lz = i === 0 ? h.hl : i === 1 ? -h.hl : i === 2 ? 0 : i === 3 ? 0 : h.hl * 0.5;
    const lx = i === 2 ? h.hb : i === 3 ? -h.hb : 0;
    const px = x + lx * cy + lz * sy, pz = z - lx * sy + lz * cy;
    const w = waterAt(env, px, pz);
    if (w === NO_WATER_Y || Math.abs(w - W) > 0.6) return false;
    if (terrainHeight(env.world, px, pz) > w - C.BOAT_DRAFT) return false;
    if (dist(env, px, w + 0.35, pz) < 0.12) return false;
  }
  return true;
}

/** Advance a vehicle one step; cmd = the driver's input (null = nobody driving). Returns bump speed (0 = none). */
export function stepVehicle(v: VehicleState, cmd: InputCmd | null, dt: number, env: SimEnv): number {
  const throttle = cmd ? clamp(cmd.moveZ, -1, 1) : 0;
  const steerIn = cmd ? clamp(-cmd.moveX, -1, 1) : 0;
  v.throttle = throttle;
  const sk = Math.min(1, dt * 7);
  v.steer += (steerIn - v.steer) * sk;
  if (v.kind === VehicleKind.Vespa) return stepVespa(v, throttle, dt, env);

  const max = vehicleMaxSpeed(v.kind);
  const target = throttle >= 0 ? throttle * max : throttle * max * 0.5;
  if (throttle !== 0) v.speed += clamp(target - v.speed, -C.BOAT_ACCEL * dt, C.BOAT_ACCEL * dt);
  else v.speed -= v.speed * Math.min(1, C.BOAT_DRAG * dt * 0.6);
  const turnK = 0.4 + 0.6 * Math.min(1, Math.abs(v.speed) / max);
  const nyaw = v.yaw + v.steer * C.BOAT_TURN * turnK * dt * (v.speed < -0.1 ? -1 : 1);
  const nx = v.x + sin(nyaw) * v.speed * dt, nz = v.z + cos(nyaw) * v.speed * dt;
  const W = waterAt(env, nx, nz);
  if (W === NO_WATER_Y || !boatFits(env, v.kind, nx, nz, nyaw, W)) {
    // try just turning in place
    const Wh = waterAt(env, v.x, v.z);
    if (Wh !== NO_WATER_Y && boatFits(env, v.kind, v.x, v.z, nyaw, Wh)) v.yaw = nyaw;
    const bump = Math.abs(v.speed);
    v.speed = -v.speed * 0.25;
    return bump > 0.8 ? bump : 0;
  }
  const lim = WORLD_HALF - 14;
  if (Math.abs(nx) > lim || Math.abs(nz) > lim) { v.speed = -v.speed * 0.25; v.yaw = nyaw; return 0; }
  v.x = nx; v.z = nz; v.yaw = nyaw; v.y = W;
  return 0;
}

function groundAt(env: SimEnv, x: number, yRef: number, z: number): number {
  const g = probeGround(env, x, yRef + 1.4, z, 4.5);
  return g;
}

const _n: Vec3 = { x: 0, y: 1, z: 0 };
/** Horizontal normal of the last thing vespaBlocked() ran into (points out of it). */
const _hn = { x: 0, z: 0 };

/** Horizontal part of the SDF normal at a point into _hn; false if it's (nearly) flat. */
function hNormal(env: SimEnv, x: number, y: number, z: number): boolean {
  const n = sdfNormal(env.cw, x, y, z, _n);
  const l = Math.sqrt(n.x * n.x + n.z * n.z);
  if (l < 0.2) return false;
  _hn.x = n.x / l; _hn.z = n.z / l;
  return true;
}

/**
 * Would the scooter centred at (x, z), travelling along (ux, uz), hit
 * something? Checks the leading wheel (inside a solid, too steep a climb,
 * too deep water) and the body just ahead of it (trunks, rocks, walls — the
 * body is probed ~0.75 m above the ground there, so terrain slopes and small
 * bumps never count as walls). Sets _hn to the obstacle's horizontal normal;
 * without a usable one it's treated as head-on.
 */
function vespaBlocked(env: SimEnv, v: VehicleState, x: number, z: number, ux: number, uz: number): boolean {
  const hl = HULL[VehicleKind.Vespa].hl;
  const lx = x + ux * hl, lz = z + uz * hl;
  const gl = groundAt(env, lx, v.y, lz);
  _hn.x = -ux; _hn.z = -uz;
  if (gl === BLOCKED) {
    hNormal(env, lx, v.y + 1.4, lz);
    return true;
  }
  if (gl !== -Infinity) {
    let wall = false;
    if (v.airborne) wall = gl > v.y + 0.6;
    else if (gl - v.y > C.VESPA_STEP) {
      const gt = groundAt(env, x - ux * hl, v.y, z - uz * hl);
      if (gt !== -Infinity && gt !== BLOCKED && (gl - gt) / (2 * hl) > C.VESPA_MAX_SLOPE) wall = true;
    }
    if (wall) {
      hNormal(env, lx, Math.min(gl, v.y + 0.3), lz);
      return true;
    }
    const W = waterAt(env, lx, lz);
    if (W !== NO_WATER_Y && W - gl > C.VESPA_MAX_WADE) {
      // the shore is uphill: slide along it
      const n = terrainNormal(env.world, lx, lz, _n);
      const l = Math.sqrt(n.x * n.x + n.z * n.z);
      if (l > 0.05) { _hn.x = -n.x / l; _hn.z = -n.z / l; }
      return true;
    }
  }
  const bx = lx + ux * 0.25, bz = lz + uz * 0.25;
  const by = (gl !== -Infinity && gl > v.y - 1 ? gl : v.y) + 0.75;
  if (dist(env, bx, by, bz) < C.VESPA_BODY_R) {
    hNormal(env, bx, by, bz);
    return true;
  }
  return false;
}

function stepVespa(v: VehicleState, throttle: number, dt: number, env: SimEnv): number {
  let bump = 0;
  if (!v.airborne) {
    if (throttle > 0) v.speed += C.VESPA_ACCEL * throttle * dt * (v.speed < 0 ? 2 : 1);
    else if (throttle < 0) {
      if (v.speed > 0.4) v.speed -= C.VESPA_BRAKE * -throttle * dt;
      else v.speed = Math.max(-C.VESPA_REVERSE, v.speed - C.VESPA_ACCEL * 0.6 * -throttle * dt);
    } else {
      const f = (C.VESPA_DRAG + Math.abs(v.speed) * 0.08) * dt;
      v.speed = Math.abs(v.speed) <= f ? 0 : v.speed - Math.sign(v.speed) * f;
    }
    // gravity along the slope
    v.speed -= sin(v.pitch) * 9 * dt;
    v.speed = clamp(v.speed, -C.VESPA_REVERSE, C.VESPA_SPEED);
  }
  const spK = clamp(Math.abs(v.speed) / 4, 0, 1) * (1 - 0.35 * clamp(Math.abs(v.speed) / C.VESPA_SPEED, 0, 1));
  const yawRate = v.steer * C.VESPA_TURN * spK * (v.speed >= 0 ? 1 : -1) * (v.airborne ? 0.3 : 1);
  v.yaw += yawRate * dt;
  const dir = v.speed >= 0 ? 1 : -1;
  // travel direction (backwards when reversing)
  const ux = sin(v.yaw) * dir, uz = cos(v.yaw) * dir;
  let nx = v.x + ux * Math.abs(v.speed) * dt, nz = v.z + uz * Math.abs(v.speed) * dt;
  if (Math.abs(v.speed) > 0.05 && vespaBlocked(env, v, nx, nz, ux, uz)) {
    // how head-on: 1 = straight into it, 0 = skimming along it
    let c = -(ux * _hn.x + uz * _hn.z);
    const sp = Math.abs(v.speed);
   
    if (c > C.VESPA_HEADON) {
      v.speed = -v.speed * C.VESPA_REBOUND;
      // glance off to whichever side we were already favouring so the next try slides past
      v.yaw += (ux * _hn.z - uz * _hn.x >= 0 ? -1 : 1) * dir * C.VESPA_HEADON_NUDGE;
      return sp > 1.5 ? sp : 0;
    }
    if (c < 0.05) c = 0.05;
    // glancing: slide along the obstacle, keep most of the speed, swing the nose round
    let tx = ux + c * _hn.x, tz = uz + c * _hn.z;
    const tl = Math.sqrt(tx * tx + tz * tz) || 1;
    tx /= tl; tz /= tl;
    v.speed *= 1 - C.VESPA_SCRAPE * c * c;
    const turn = wrapAngle(atan2(tx * dir, tz * dir) - v.yaw);
    const maxTurn = C.VESPA_DEFLECT_TURN * dt;
    v.yaw += clamp(turn, -maxTurn, maxTurn);
    bump = sp * c > 3 ? sp * c : 0;
    const hx = _hn.x, hz = _hn.z;
    nx = v.x + tx * Math.abs(v.speed) * dt;
    nz = v.z + tz * Math.abs(v.speed) * dt;
    // wedged (a second obstacle along the slide): hold still and lose speed
    if (vespaBlocked(env, v, nx, nz, tx, tz) && -(tx * _hn.x + tz * _hn.z) > 0.2) {
      nx = v.x + hx * 0.02; nz = v.z + hz * 0.02;
      v.speed = -v.speed * C.VESPA_REBOUND;
    }
  }
  v.x = nx; v.z = nz;
  // never rest inside a trunk / wall: push the body out horizontally
  {
    const d = dist(env, v.x, v.y + 0.75, v.z);
    if (d < C.VESPA_BODY_R - 0.02 && env.cw.lastKind !== "terrain") {
      const n = sdfNormal(env.cw, v.x, v.y + 0.75, v.z, _n);
      const hl = Math.sqrt(n.x * n.x + n.z * n.z);
      if (hl > 0.3) {
        const push = Math.min(0.15, C.VESPA_BODY_R - d);
        v.x += (n.x / hl) * push; v.z += (n.z / hl) * push;
      }
    }
  }
  const fx = sin(v.yaw), fz = cos(v.yaw);
  const hl = HULL[VehicleKind.Vespa].hl;
  // ground height under both wheels (front = +z)
  const gf = groundAt(env, v.x + fx * hl, v.y, v.z + fz * hl);
  const gr = groundAt(env, v.x - fx * hl, v.y, v.z - fz * hl);
  const okF = gf !== -Infinity && gf !== BLOCKED, okR = gr !== -Infinity && gr !== BLOCKED;
  const gy = okF && okR ? (gf + gr) * 0.5 : okF ? gf : okR ? gr : -Infinity;
  const tp = okF && okR ? atan((gf - gr) / (2 * hl)) : v.pitch;
  if (v.airborne) {
    v.vy -= C.GRAVITY * dt;
    v.y += v.vy * dt;
    v.pitch += (clamp(v.vy * 0.03, -0.35, 0.3) - v.pitch) * Math.min(1, dt * 3);
    if (gy !== -Infinity && v.y <= gy) {
      const impact = -v.vy;
      v.y = gy;
      v.pitch = tp;
      if (impact > 4) {
        v.vy = impact * C.VESPA_BOUNCE;
        bump = impact;
        v.airborne = v.vy > 1.2;
        if (!v.airborne) v.vy = 0;
      } else { v.airborne = false; v.vy = 0; }
    }
  } else {
    if (gy === -Infinity) {
      v.airborne = true;
    } else {
      const ballistic = v.y + v.vy * dt - 0.5 * C.GRAVITY * dt * dt;
      if (gy < ballistic - 0.04 && v.vy > -1) {
        v.airborne = true;
        v.y = ballistic;
        v.vy -= C.GRAVITY * dt;
      } else {
        v.vy = clamp((gy - v.y) / dt, -12, 12);
        v.y = gy;
        v.pitch += (tp - v.pitch) * Math.min(1, dt * 12);
      }
    }
  }
  // fell into the sea somehow: stop
  const W = waterAt(env, v.x, v.z);
  if (W !== NO_WATER_Y && v.y < W - 0.6) { v.speed *= 0.9; }
  return bump;
}
