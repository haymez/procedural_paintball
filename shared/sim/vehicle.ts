// Vehicle physics: boats float on flat water and can't touch land; the Vespa
// follows the ground on two wheel probes, launches off crests, bounces on
// landing and refuses cliffs and deep water. stepVehicle is pure w.r.t. `v`.
import { atan, cos, sin } from "../math/trig";
import { terrainHeight } from "../world/collide";
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
  const nyaw = v.yaw + yawRate * dt;
  const fx = sin(nyaw), fz = cos(nyaw);
  const nx = v.x + fx * v.speed * dt, nz = v.z + fz * v.speed * dt;
  const hl = HULL[VehicleKind.Vespa].hl;
  const dir = v.speed >= 0 ? 1 : -1;
  const lx = nx + fx * hl * dir, lz = nz + fz * hl * dir;
  const tx = nx - fx * hl * dir, tz = nz - fz * hl * dir;
  const gl = groundAt(env, lx, v.y, lz);
  const gt = groundAt(env, tx, v.y, tz);
  let blocked = false;
  if (Math.abs(v.speed) > 0.05) {
    if (gl === BLOCKED) blocked = true;
    else if (gl !== -Infinity && gt !== -Infinity && gt !== BLOCKED) {
      const rise = (gl - gt) / (2 * hl);
      if (!v.airborne && rise > C.VESPA_MAX_SLOPE) blocked = true;
      if (v.airborne && gl > v.y + 0.6) blocked = true;
    }
    if (!blocked && gl !== -Infinity) {
      const W = waterAt(env, lx, lz);
      if (W !== NO_WATER_Y && W - gl > C.VESPA_MAX_WADE) blocked = true;
    }
    if (!blocked && dist(env, lx + fx * 0.25 * dir, v.y + 0.75, lz + fz * 0.25 * dir) < 0.32) blocked = true;
  }
  if (blocked) {
    bump = Math.abs(v.speed);
    v.speed = -v.speed * 0.3;
    v.yaw = nyaw;
    return bump > 1.5 ? bump : 0;
  }
  v.x = nx; v.z = nz; v.yaw = nyaw;
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
