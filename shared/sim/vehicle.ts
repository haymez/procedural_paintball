// Vehicle physics, shared by the server and client prediction (pure w.r.t. `v`):
//   Jetski / Speedboat  arcade water physics: throttle + carve on the water
//                       surface, slide up gentle beaches and stop (reverse or
//                       the slope pushes you back off), bounce off rocks /
//                       docks / steep banks, jetskis hop off swells and on Jump.
//   Vespa               follows the ground on two wheel probes, launches off
//                       crests, bounces on landing, refuses cliffs and deep water.
//   Gyrocopter          arcade autogyro: ground run → lift-off, climb / dive on
//                       mouse pitch or Jump / Crouch, turns toward where the
//                       pilot looks (or A/D), auto-rotation sink when slow,
//                       ceiling, bounces off terrain instead of crashing.
import { atan, atan2, cos, sin, wrapAngle } from "../math/trig";
import { sdfNormal, terrainHeight, terrainNormal, type Vec3 } from "../world/collide";
import { VehicleKind, WORLD_HALF, isBoat, type VehicleSpawn } from "../world/types";
import * as C from "./constants";
import { BLOCKED, NO_WATER_Y, dist, probeGround, waterAt, type SimEnv } from "./env";
import { Btn, Move, type InputCmd, type MoveState, type VehicleState } from "./types";

/** Seat anchors in vehicle-local space (x left, y up, z forward) + facing offset. Matches the renderer. */
export const SEATS: Record<VehicleKind, { x: number; y: number; z: number; yaw: number }[]> = {
  [VehicleKind.Jetski]: [
    { x: 0, y: 0.62, z: -0.2, yaw: 0 },
  ],
  [VehicleKind.Speedboat]: [
    { x: -0.4, y: 0.55, z: 0.3, yaw: 0 },
    { x: 0.4, y: 0.55, z: 0.3, yaw: 0 },
    { x: 0, y: 0.55, z: -1.05, yaw: 0 },
  ],
  [VehicleKind.Vespa]: [
    { x: 0, y: 0.72, z: -0.2, yaw: 0 },
    { x: 0, y: 0.73, z: -0.52, yaw: 0 },
  ],
  [VehicleKind.Gyrocopter]: [
    { x: 0, y: 0.85, z: 0.02, yaw: 0 },
  ],
};

/** Hull half-length / half-beam (boats, gyro body); wheelbase half for the Vespa. */
export const HULL: Record<VehicleKind, { hl: number; hb: number }> = {
  [VehicleKind.Jetski]: { hl: 1.4, hb: 0.5 },
  [VehicleKind.Speedboat]: { hl: 3.0, hb: 1.0 },
  [VehicleKind.Vespa]: { hl: 0.65, hb: 0.3 },
  [VehicleKind.Gyrocopter]: { hl: 1.5, hb: 0.6 },
};

export const VEHICLE_NAMES: Record<VehicleKind, string> = {
  [VehicleKind.Jetski]: "jetski",
  [VehicleKind.Speedboat]: "speedboat",
  [VehicleKind.Vespa]: "Vespa",
  [VehicleKind.Gyrocopter]: "gyrocopter",
};

/** Interact prompt for taking `seat` of a vehicle. */
export function vehicleVerb(kind: VehicleKind, seat: number): string {
  switch (kind) {
    case VehicleKind.Jetski: return "Ride the jetski";
    case VehicleKind.Speedboat: return seat === 0 ? "Drive the speedboat" : "Hop in the speedboat";
    case VehicleKind.Vespa: return seat === 0 ? "Ride the Vespa" : "Hop on the back";
    case VehicleKind.Gyrocopter: return "Fly the gyrocopter";
  }
  return "Get in";
}

/** Land vehicles can only be boarded standing on the ground; boats from the water too. */
export function canBoard(kind: VehicleKind, move: MoveState): boolean {
  return isBoat(kind) || move === Move.Ground;
}

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
  if (isBoat(v.kind)) {
    const w = waterAt(env, v.x, v.z);
    v.y = w === NO_WATER_Y ? v.sy : w;
  } else {
    const g = probeGround(env, v.x, v.sy + 2, v.z, 6);
    v.y = g === BLOCKED || g === -Infinity ? v.sy : g;
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
  out.y = v.y + s.y + s.z * sin(v.pitch);
  return out;
}

export function vehicleMaxSpeed(kind: VehicleKind): number {
  switch (kind) {
    case VehicleKind.Jetski: return C.JETSKI_SPEED;
    case VehicleKind.Speedboat: return C.SPEEDBOAT_SPEED;
    case VehicleKind.Gyrocopter: return C.GYRO_SPEED;
    default: return C.VESPA_SPEED;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Advance a vehicle one step; cmd = the driver's input (null = nobody driving). Returns bump speed (0 = none). */
export function stepVehicle(v: VehicleState, cmd: InputCmd | null, dt: number, env: SimEnv): number {
  const throttle = cmd ? clamp(cmd.moveZ, -1, 1) : 0;
  let steerIn = cmd ? clamp(-cmd.moveX, -1, 1) : 0;
  // the gyro turns toward where the pilot looks unless A/D says otherwise
  if (v.kind === VehicleKind.Gyrocopter && cmd && steerIn === 0 && Number.isFinite(cmd.yaw)) steerIn = clamp(wrapAngle(cmd.yaw - v.yaw) * 1.6, -1, 1);
  v.throttle = throttle;
  const sk = Math.min(1, dt * 7);
  v.steer += (steerIn - v.steer) * sk;
  if (v.kind === VehicleKind.Vespa) return stepVespa(v, throttle, dt, env);
  if (v.kind === VehicleKind.Gyrocopter) return stepGyro(v, cmd, throttle, dt, env);
  return stepBoat(v, cmd, throttle, dt, env);
}

// ---------------------------------------------------------------------------
// shared: bumping into things

/**
 * Travelling along (ux, uz) (dir = ±1 for reversing) into an obstacle whose
 * horizontal normal is in _hn: head-on bounces back, glancing slides along it
 * and swings the nose round. Writes the new position to _mv; returns the
 * bump speed (0 = none worth a sound).
 */
function deflect(
  v: VehicleState, env: SimEnv, ux: number, uz: number, dir: number, dt: number, headon: number, rebound: number,
  blocked: (env: SimEnv, v: VehicleState, x: number, z: number, ux: number, uz: number) => boolean,
): number {
  let c = -(ux * _hn.x + uz * _hn.z);
  const sp = Math.abs(v.speed);
  if (c > headon) {
    v.speed = -v.speed * rebound;
    v.yaw += (ux * _hn.z - uz * _hn.x >= 0 ? -1 : 1) * dir * 0.4;
    _mv.x = v.x + _hn.x * 0.03; _mv.z = v.z + _hn.z * 0.03;
    return sp > 1.5 ? sp : 0;
  }
  if (c < 0.05) c = 0.05;
  let tx = ux + c * _hn.x, tz = uz + c * _hn.z;
  const tl = Math.sqrt(tx * tx + tz * tz) || 1;
  tx /= tl; tz /= tl;
  v.speed *= 1 - 0.5 * c * c;
  const turn = wrapAngle(atan2(tx * dir, tz * dir) - v.yaw);
  const maxTurn = 6 * dt;
  v.yaw += clamp(turn, -maxTurn, maxTurn);
  const hx = _hn.x, hz = _hn.z;
  _mv.x = v.x + tx * Math.abs(v.speed) * dt;
  _mv.z = v.z + tz * Math.abs(v.speed) * dt;
  // wedged (a second obstacle along the slide): hold still and lose speed
  if (blocked(env, v, _mv.x, _mv.z, tx, tz) && -(tx * _hn.x + tz * _hn.z) > 0.2) {
    _mv.x = v.x + hx * 0.03; _mv.z = v.z + hz * 0.03;
    v.speed = -v.speed * rebound;
  }
  return sp * c > 3 ? sp * c : 0;
}
const _mv = { x: 0, z: 0 };

/** Push the body at height y out of anything solid it ended up inside (never terrain: that's the ground). */
function pushOut(env: SimEnv, v: VehicleState, y: number, r: number): void {
  const d = dist(env, v.x, y, v.z);
  if (d < r - 0.02 && env.cw.lastKind !== "terrain") {
    const n = sdfNormal(env.cw, v.x, y, v.z, _n);
    const hl = Math.sqrt(n.x * n.x + n.z * n.z);
    if (hl > 0.3) {
      const push = Math.min(0.2, r - d);
      v.x += (n.x / hl) * push; v.z += (n.z / hl) * push;
    }
  }
}

// ---------------------------------------------------------------------------
// boats

/** Water surface, or -Infinity on dry land. */
function surfaceY(env: SimEnv, x: number, z: number): number {
  const w = waterAt(env, x, z);
  return w === NO_WATER_Y ? -Infinity : w;
}

/** Where the hull rests at (x, z): floating on the water, or on the bottom once it's too shallow. */
function hullRest(env: SimEnv, x: number, z: number): number {
  const w = surfaceY(env, x, z);
  const g = terrainHeight(env.world, x, z) + C.BOAT_DRAFT;
  return g > w ? g : w;
}

/**
 * Would the hull centred at (x, z) heading along (ux, uz) hit something? Rocks,
 * docks, piles, walls at deck height (three bow probes), or ground rising
 * too steeply under the bow (a bank, not a beach). Sets _hn.
 */
function boatBlocked(env: SimEnv, v: VehicleState, x: number, z: number, ux: number, uz: number): boolean {
  const h = HULL[v.kind];
  const r = 0.12 + h.hb * 0.25;
  // at the height the hull would sit there (riding up a beach under a dock counts)
  const ny = v.airborne ? v.y : Math.max(v.y, hullRest(env, x, z));
  // probes: bow, both bow shoulders at the hull, and the bow again at seat height (dock decks)
  for (let k = 0; k < 4; k++) {
    const side = k === 1 ? 1 : k === 2 ? -1 : 0;
    const fwd = k === 1 || k === 2 ? h.hl * 0.55 : h.hl;
    const py = ny + (k === 3 ? 0.95 : 0.4);
    const ox = ux * fwd - uz * side * h.hb * 0.8, oz = uz * fwd + ux * side * h.hb * 0.8;
    const bx = x + ox, bz = z + oz;
    const d = dist(env, bx, py, bz);
    if (d < r) {
      if (k === 3 && env.cw.lastKind === "terrain") continue;
      // already that close where we are: only block moving deeper in (so it can always back out)
      const d0 = dist(env, v.x + ox, py, v.z + oz);
      if (d0 < r && d >= d0 - 0.002) continue;
      dist(env, bx, py, bz);
      _hn.x = -ux; _hn.z = -uz;
      if (env.cw.lastKind === "terrain") {
        // terrain at deck height: a bank (use the slope's downhill direction)
        const n = terrainNormal(env.world, bx, bz, _n);
        const l = Math.sqrt(n.x * n.x + n.z * n.z);
        if (l > 0.05) { _hn.x = n.x / l; _hn.z = n.z / l; }
        // a gentle beach is ridden up, not bounced off
        const gb = terrainHeight(env.world, bx, bz), gc = terrainHeight(env.world, x, z);
        if ((gb - gc) / fwd < C.BOAT_BEACH_SLOPE && gb < v.y + 0.55) continue;
      } else hNormal(env, bx, py, bz);
      return true;
    }
  }
  // headroom: no sliding under low dock decks (unless it gets us out from under one)
  const hd = dist(env, x, ny + 0.75, z);
  if (hd < 0.3 && env.cw.lastKind === "structure" && !(hd > dist(env, v.x, v.y + 0.75, v.z) + 0.001)) {
    _hn.x = -ux; _hn.z = -uz;
    return true;
  }
  // no motoring up waterfalls / weirs
  if (surfaceY(env, x + ux * h.hl, z + uz * h.hl) > v.y + 0.3) { _hn.x = -ux; _hn.z = -uz; return true; }
  const gb = terrainHeight(env.world, x + ux * h.hl, z + uz * h.hl);
  const gc = terrainHeight(env.world, x, z);
  if (gb + C.BOAT_DRAFT > v.y + 0.1 && (gb - gc) / h.hl > C.BOAT_BEACH_SLOPE) {
    const n = terrainNormal(env.world, x + ux * h.hl, z + uz * h.hl, _n);
    const l = Math.sqrt(n.x * n.x + n.z * n.z);
    if (l > 0.05) { _hn.x = n.x / l; _hn.z = n.z / l; } else { _hn.x = -ux; _hn.z = -uz; }
    return true;
  }
  return false;
}

/** Deterministic swell crests (lines across the wind) — only the crossings matter. */
function swellIndex(env: SimEnv, x: number, z: number): number {
  const a = env.world.windDir;
  return Math.floor((x * sin(a) + z * cos(a)) / C.SWELL_SPACING);
}

function stepBoat(v: VehicleState, cmd: InputCmd | null, throttle: number, dt: number, env: SimEnv): number {
  const jet = v.kind === VehicleKind.Jetski;
  const h = HULL[v.kind];
  const max = jet ? C.JETSKI_SPEED : C.SPEEDBOAT_SPEED;
  const accel = jet ? C.JETSKI_ACCEL : C.SPEEDBOAT_ACCEL;
  let bump = 0;
  // how far the hull sits out of the water (0 afloat … 1 high and dry on the sand)
  const W = surfaceY(env, v.x, v.z);
  const out = v.airborne ? 0 : W === -Infinity ? 1 : clamp((v.y - W) / 0.45, 0, 1);
  const wet = v.airborne ? 0 : 1 - out;

  // bow-up slope of the bottom along the hull (only matters once it's touching)
  let slope = 0;
  if (out > 0) {
    const fx = sin(v.yaw), fz = cos(v.yaw);
    slope = (terrainHeight(env.world, v.x + fx * h.hl, v.z + fz * h.hl) - terrainHeight(env.world, v.x - fx * h.hl, v.z - fz * h.hl)) / (2 * h.hl);
  }

  // ---- throttle / drag
  // beached: the prop still bites enough to back off / slide down into the water, never to climb further up
  // (reversing works unless the stern would climb a real slope; forward only downhill)
  const bite = (dir: number) => ((dir > 0 ? slope < -0.02 : slope > -0.1) ? Math.max(wet, 0.6) : wet);
  if (throttle > 0) {
    if (v.speed < max * throttle) v.speed += accel * throttle * bite(1) * dt * (v.speed < 0 ? 2 : 1 - 0.45 * clamp(v.speed / max, 0, 1));
  } else if (throttle < 0) {
    // reverse the prop: brakes when moving forward, then backs up
    if (v.speed > 0.4) v.speed -= accel * 1.3 * -throttle * Math.max(wet, 0.5) * dt;
    else if (v.speed > -max * C.BOAT_REVERSE) v.speed -= accel * 0.5 * -throttle * bite(-1) * dt;
  }
  if (!v.airborne && (throttle === 0 || v.speed > max * Math.max(0, throttle) + 0.5)) {
    const f = (C.BOAT_DRAG * Math.abs(v.speed) + C.BOAT_DRAG_C) * dt;
    v.speed = Math.abs(v.speed) <= f ? 0 : v.speed - Math.sign(v.speed) * f;
  }
  if (out > 0) {
    // scraping up the sand stops it quickly; sliding back down barely drags
    const uphill = v.speed > 0 ? slope > -0.02 : slope < -0.1;
    const f = (C.BOAT_BEACH_FRICTION + C.BOAT_BEACH_LIFT_FRICTION * out) * out * dt * (uphill ? 1 : 0.05);
    v.speed = Math.abs(v.speed) <= f ? 0 : v.speed - Math.sign(v.speed) * f;
    // and the slope slides it back toward the water
    v.speed -= clamp(slope, -0.5, 0.5) * 6 * out * dt;
  }

  // ---- steering: carve harder at mid speed, rudder barely works when beached / airborne
  const asp = Math.abs(v.speed);
  const turnK = clamp(0.3 + asp / 5, 0.3, 1) * (1 - 0.3 * clamp(asp / max, 0, 1)) * (v.airborne ? 0.35 : 1 - 0.85 * out);
  v.yaw += v.steer * (jet ? C.JETSKI_TURN : C.SPEEDBOAT_TURN) * turnK * dt * (v.speed < -0.1 ? -1 : 1);

  // ---- move + collide
  const dir = v.speed >= 0 ? 1 : -1;
  const ux = sin(v.yaw) * dir, uz = cos(v.yaw) * dir;
  let nx = v.x + ux * asp * dt, nz = v.z + uz * asp * dt;
  if (asp > 0.05 && boatBlocked(env, v, nx, nz, ux, uz)) {
    bump = deflect(v, env, ux, uz, dir, dt, C.BOAT_HEADON, C.BOAT_REBOUND, boatBlocked);
    nx = _mv.x; nz = _mv.z;
  }
  const lim = WORLD_HALF - 14;
  if (Math.abs(nx) > lim || Math.abs(nz) > lim) {
    v.speed = -v.speed * 0.3;
    nx = clamp(nx, -lim, lim); nz = clamp(nz, -lim, lim);
  }
  const s0 = jet ? swellIndex(env, v.x, v.z) : 0;
  v.x = nx; v.z = nz;
  pushOut(env, v, v.y + 0.4, h.hb * 0.7);

  // ---- vertical: float, beach, hop
  const rest = hullRest(env, v.x, v.z);
  if (v.airborne) {
    v.vy -= C.GRAVITY * dt;
    v.y += v.vy * dt;
    if (v.y <= rest) {
      const impact = -v.vy;
      v.y = rest;
      v.vy = 0;
      v.airborne = false;
      v.speed *= 0.97;
      if (impact > 3) bump = Math.max(bump, impact);
    }
  } else if (rest < v.y - 0.35) {
    // dropped off something (a weir, a sand bar edge)
    v.airborne = true;
    v.vy = Math.min(0, v.vy);
  } else {
    const W2 = surfaceY(env, v.x, v.z);
    const afloat = W2 > -Infinity && rest - W2 < 0.1;
    v.vy = clamp((rest - v.y) / dt, -8, 8);
    v.y = rest;
    if (jet && afloat) {
      const hop = cmd !== null && (cmd.buttons & Btn.Jump) !== 0 && asp > C.JETSKI_HOP_MIN_SPEED;
      const swell = asp > C.SWELL_SPEED && swellIndex(env, v.x, v.z) !== s0;
      if (hop || swell) {
        v.vy = hop ? C.JETSKI_HOP : 1 + (asp - C.SWELL_SPEED) * 0.3;
        v.airborne = true;
      }
    } else v.vy = 0;
  }

  // ---- attitude: speedboats plane bow-up, jetskis nose into the air on hops
  const fx = sin(v.yaw), fz = cos(v.yaw);
  let tp: number;
  if (v.airborne) tp = clamp(v.vy * 0.045, -0.3, 0.3);
  else if (out > 0.05) tp = atan((terrainHeight(env.world, v.x + fx * h.hl, v.z + fz * h.hl) - terrainHeight(env.world, v.x - fx * h.hl, v.z - fz * h.hl)) / (2 * h.hl)) * out;
  else if (jet) tp = 0.05 * clamp(asp / 10, 0, 1);
  else {
    // the planing hump: bow climbs as it gets going, settles once on the plane
    const a = clamp(v.speed / 7, 0, 1), b = clamp((v.speed - 7) / 13, 0, 1);
    tp = 0.12 * a * (1 - 0.45 * b);
  }
  v.pitch += (tp - v.pitch) * Math.min(1, dt * (v.airborne ? 3 : 4));
  return bump;
}

// ---------------------------------------------------------------------------
// gyrocopter

/**
 * Would the gyro centred at (x, z) flying/rolling along (ux, uz) hit something?
 * Probes the nose and the body; on the ground a too-steep climb is a wall too.
 */
function gyroBlocked(env: SimEnv, v: VehicleState, x: number, z: number, ux: number, uz: number): boolean {
  const h = HULL[VehicleKind.Gyrocopter];
  _hn.x = -ux; _hn.z = -uz;
  const nx = x + ux * h.hl, nz = z + uz * h.hl;
  // nose (cockpit height) and the rotor mast / tail
  for (let k = 0; k < 2; k++) {
    const py = v.y + (k === 0 ? 0.75 : 1.9);
    const ox = ux * (k === 0 ? h.hl : 0.3), oz = uz * (k === 0 ? h.hl : 0.3);
    const px = x + ox, pz = z + oz;
    const d = dist(env, px, py, pz), r = k === 0 ? 0.45 : 0.5;
    if (d < r) {
      // already that close: only block moving deeper in
      const d0 = dist(env, v.x + ox, py, v.z + oz);
      if (d0 < r && d >= d0 - 0.002) continue;
      dist(env, px, py, pz);
      if (env.cw.lastKind === "terrain") {
        const n = terrainNormal(env.world, px, pz, _n);
        const l = Math.sqrt(n.x * n.x + n.z * n.z);
        if (!v.airborne && n.y > 0.8) continue; // rolling up a gentle slope
        if (l > 0.05) { _hn.x = n.x / l; _hn.z = n.z / l; }
      } else hNormal(env, px, py, pz);
      return true;
    }
  }
  if (!v.airborne) {
    const gl = probeGround(env, nx, v.y + 1.4, nz, 4.5);
    if (gl === BLOCKED) { hNormal(env, nx, v.y + 1.4, nz); return true; }
    if (gl !== -Infinity && gl - v.y > 0.35 && (gl - v.y) / h.hl > C.VESPA_MAX_SLOPE) {
      hNormal(env, nx, Math.min(gl, v.y + 0.3), nz);
      return true;
    }
  }
  return false;
}

function stepGyro(v: VehicleState, cmd: InputCmd | null, throttle: number, dt: number, env: SimEnv): number {
  let bump = 0;
  // climb input: Jump / Crouch, else the pilot's look pitch (level ≈ the default -0.14)
  let climb = 0;
  if (cmd) {
    const up = ((cmd.buttons & Btn.Jump) ? 1 : 0) - ((cmd.buttons & Btn.Crouch) ? 1 : 0);
    if (up !== 0) climb = up;
    else {
      const p = (Number.isFinite(cmd.pitch) ? cmd.pitch : 0) + 0.14;
      const dz = 0.07;
      climb = Math.abs(p) < dz ? 0 : clamp((p - Math.sign(p) * dz) * 2.8, -1, 1);
    }
  }
  const W = surfaceY(env, v.x, v.z);
  const swimming = !v.airborne && W > -Infinity && v.y <= W + 0.05 && terrainHeight(env.world, v.x, v.z) < W - 0.3;

  // ---- airspeed
  if (v.airborne) {
    // W: full power, neutral: cruise, S: throttle back (sinks gently once slow)
    const target = !cmd ? 0 : throttle > 0 ? C.GYRO_SPEED : throttle < 0 ? 0 : C.GYRO_CRUISE;
    if (v.speed < target) v.speed = Math.min(target, v.speed + C.GYRO_ACCEL * (throttle > 0 ? throttle : 0.6) * dt);
    else v.speed = Math.max(target, v.speed - (throttle < 0 ? 5 : 1.6) * dt);
    // trading height for speed and back
    v.speed = clamp(v.speed - v.vy * 0.3 * dt, 0, C.GYRO_SPEED * 1.15);
  } else {
    const max = swimming ? 4 : C.GYRO_SPEED;
    if (throttle > 0) { if (v.speed < max) v.speed = Math.min(max, v.speed + C.GYRO_ACCEL * throttle * dt); }
    else if (throttle < 0) {
      if (v.speed > 0.3) v.speed -= 12 * -throttle * dt;
      else v.speed = Math.max(-2.5, v.speed - 3 * -throttle * dt);
    }
    if (throttle === 0 || v.speed > max) {
      const f = ((swimming ? 3 : 1.8) + Math.abs(v.speed) * (swimming ? 0.8 : 0.05)) * dt;
      v.speed = Math.abs(v.speed) <= f ? 0 : v.speed - Math.sign(v.speed) * f;
    }
    // rolling down / up hills
    if (!swimming) v.speed -= sin(v.pitch) * 6 * dt;
  }

  // ---- heading
  const lift = clamp((v.speed - C.GYRO_MIN_SPEED) / 6, 0, 1);
  if (v.airborne) v.yaw += v.steer * C.GYRO_TURN * (0.55 + 0.45 * lift) * dt;
  else v.yaw += v.steer * C.GYRO_GROUND_TURN * clamp(Math.abs(v.speed) / 3, 0, 1) * (v.speed >= 0 ? 1 : -1) * dt;

  // ---- move + collide
  const dir = v.speed >= 0 ? 1 : -1;
  const ux = sin(v.yaw) * dir, uz = cos(v.yaw) * dir;
  const asp = Math.abs(v.speed);
  let nx = v.x + ux * asp * dt, nz = v.z + uz * asp * dt;
  if (asp > 0.05 && gyroBlocked(env, v, nx, nz, ux, uz)) {
    if (v.airborne) {
      // bonk: bounce off (mirror the heading about the obstacle), lose most of the speed
      const c = -(ux * _hn.x + uz * _hn.z);
      if (c > 0.3) {
        bump = asp;
        const rx = ux + 2 * c * _hn.x, rz = uz + 2 * c * _hn.z;
        v.yaw = atan2(rx, rz);
        v.speed = asp * (0.55 - 0.3 * c);
        v.vy = Math.max(v.vy, 1.5);
        nx = v.x + _hn.x * 0.1; nz = v.z + _hn.z * 0.1;
      } else {
        bump = deflect(v, env, ux, uz, dir, dt, 2, 0.3, gyroBlocked);
        nx = _mv.x; nz = _mv.z;
      }
    } else {
      bump = deflect(v, env, ux, uz, dir, dt, C.VESPA_HEADON, C.VESPA_REBOUND, gyroBlocked);
      nx = _mv.x; nz = _mv.z;
    }
  }
  // the edge of the map: turn back toward the island
  const lim = WORLD_HALF - 14;
  if (Math.abs(nx) > lim || Math.abs(nz) > lim) {
    nx = clamp(nx, -lim, lim); nz = clamp(nz, -lim, lim);
    v.yaw += wrapAngle(atan2(-nx, -nz) - v.yaw) * Math.min(1, dt * 2);
  }
  v.x = nx; v.z = nz;
  pushOut(env, v, v.y + 0.8, 0.5);

  // ---- vertical
  if (v.airborne) {
    let vyT: number;
    if (!cmd) vyT = -(1 - lift) * C.GYRO_SINK - 0.6;
    else if (climb > 0) vyT = climb * C.GYRO_CLIMB * lift - (1 - lift) * C.GYRO_SINK;
    else if (climb < 0) vyT = climb * C.GYRO_DIVE;
    else {
      vyT = -(1 - lift) * C.GYRO_SINK;
      // hands off near the ground: keep climbing out (clears the trees after a take-off run)
      if (lift > 0.3 && probeGround(env, v.x, v.y + 0.3, v.z, C.GYRO_CLIMB_OUT) > -Infinity) vyT = C.GYRO_CLIMB * 0.55 * lift;
    }
    if (v.y > C.GYRO_CEILING - 12) vyT = Math.min(vyT, (C.GYRO_CEILING - v.y) * 0.6);
    v.vy += (vyT - v.vy) * Math.min(1, dt * 2.5);
    v.y += v.vy * dt;
    if (v.y > C.GYRO_CEILING) { v.y = C.GYRO_CEILING; if (v.vy > 0) v.vy = 0; }
    // touch down on ground / water
    const g = probeGround(env, v.x, v.y + 1.2, v.z, 1.5 + Math.max(0, -v.vy * dt));
    const W2 = surfaceY(env, v.x, v.z);
    const floor = g === BLOCKED ? v.y + 0.05 : g === -Infinity ? -Infinity : g;
    const top = floor > W2 ? floor : W2;
    if (top > -Infinity && v.y <= top) {
      const impact = -v.vy;
      v.y = top;
      if (impact > C.GYRO_BOUNCE_V && top !== W2) {
        v.vy = impact * 0.35;
        v.speed *= 0.8;
        bump = Math.max(bump, impact);
      } else {
        v.vy = 0;
        v.airborne = false;
        if (top === W2) { v.speed *= 0.5; bump = Math.max(bump, impact > 3 ? impact : 0); }
        else if (impact > 3) bump = Math.max(bump, impact);
      }
    }
  } else {
    const g = probeGround(env, v.x, v.y + 1.4, v.z, 4.5);
    const W2 = surfaceY(env, v.x, v.z);
    if (W2 > -Infinity && (g === -Infinity || g === BLOCKED || g < W2 - 0.3)) {
      // bobbing on the water (the pod floats); it can't get up to take-off speed here
      v.vy = 0;
      v.y = W2;
    } else if (g === -Infinity) {
      // rolled off a ledge: glide
      v.airborne = true;
      v.vy = Math.min(0, v.vy);
    } else if (g !== BLOCKED) {
      v.vy = clamp((g - v.y) / dt, -12, 12);
      v.y = g;
    }
    // lift-off: by itself at take-off speed (unless pushing down), earlier when pulling up
    if (cmd && !swimming && ((v.speed > C.GYRO_TAKEOFF_SPEED && !(cmd.buttons & Btn.Crouch)) || (v.speed > C.GYRO_MIN_SPEED + 1.5 && climb > 0.3))) {
      v.airborne = true;
      v.vy = 2.5;
      v.y += 0.05;
    }
  }

  // ---- attitude: nose follows the climb in the air, the slope on the ground
  let tp: number;
  if (v.airborne) tp = clamp(v.vy * 0.035, -0.3, 0.25) + 0.04;
  else {
    const fx = sin(v.yaw), fz = cos(v.yaw), hl = HULL[VehicleKind.Gyrocopter].hl * 0.6;
    const gf = probeGround(env, v.x + fx * hl, v.y + 1.2, v.z + fz * hl, 3);
    const gr = probeGround(env, v.x - fx * hl, v.y + 1.2, v.z - fz * hl, 3);
    tp = gf > -Infinity && gr > -Infinity && gf !== BLOCKED && gr !== BLOCKED ? atan((gf - gr) / (2 * hl)) : 0;
  }
  v.pitch += (tp - v.pitch) * Math.min(1, dt * 5);
  return bump;
}

// ---------------------------------------------------------------------------
// Vespa

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
