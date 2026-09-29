// Player movement: one pure function, stepPlayer(state, cmd, dt, env), used by
// the authoritative sim and (later) client-side prediction. It reads and writes
// only the plain-data PlayerState, never allocates, and never touches other
// players, vehicles or combat (the MatchSim layers those on top).
//
// Collision model ("floating capsule"): the body is three spheres of radius
// BODY_R stacked from STEP_H + R up to the head; anything lower than STEP_H is
// the legs' business — a ray under the feet snaps to stairs, rubble, slopes and
// docks, so thresholds and doorways never snag. Walls push the body out
// horizontally while grounded (no popping up), fully in 3D while airborne.
import { cos, sin } from "../math/trig";
import * as C from "./constants";
import { BLOCKED, NO_WATER_Y, dist, normal, probeGround, waterAt, zipPoint, type SimEnv } from "./env";
import { Btn, Fx, Move, type InputCmd, type MoveState, type PlayerState } from "./types";
import { PickupKind, WORLD_HALF } from "../world/types";
import { terrainHeight } from "../world/collide";

export function createPlayerState(id: number): PlayerState {
  return {
    id,
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0,
    move: Move.Dead, moveT: 0, grounded: false, gnx: 0, gny: 1, gnz: 0,
    coyote: 0, jumpBuf: 0, jumpHeld: false, prevButtons: 0,
    sprinting: false, aiming: false, stamina: 1, staminaDelay: 0, exhausted: false,
    slideCd: 0, stumble: 0, dived: false,
    mx0: 0, my0: 0, mz0: 0, mx1: 0, my1: 0, mz1: 0, mDur: 0,
    waterY: NO_WATER_Y, breath: 1, gasp: 0, wash: 0, paintT: 0,
    vehicle: -1, seat: -1, zip: -1, zipT: 0, zipV: 0,
    alive: false, coats: [], coatBy: [], upgrades: 0,
    hopper: C.HOPPER, reserve: C.RESERVE_START, reload: 0, fireCd: 0, shotSeq: 0,
    shield: 0, deadT: 0, lastHitBy: -1, lastKiller: -1,
    score: 0, deaths: 0, style: 0, streak: 0, lastSeq: 0,
  };
}

/** Deep copy (prediction snapshots / rollback). */
export function copyPlayerState(src: PlayerState, dst: PlayerState): PlayerState {
  const coats = dst.coats, coatBy = dst.coatBy;
  Object.assign(dst, src);
  coats.length = 0; for (const c of src.coats) coats.push(c);
  coatBy.length = 0; for (const c of src.coatBy) coatBy.push(c);
  dst.coats = coats; dst.coatBy = coatBy;
  return dst;
}

export function hasUpgrade(p: PlayerState, k: PickupKind): boolean {
  return (p.upgrades & (1 << k)) !== 0;
}

/** Body height for the current state. */
export function bodyHeight(move: MoveState): number {
  return move === Move.Slide || move === Move.Dive || move === Move.Swim || move === Move.Underwater || move === Move.SteepSlide ||
    move === Move.Glide || move === Move.Splat
    ? C.BODY_H_LOW : C.BODY_H;
}

export function eyeHeight(move: MoveState): number {
  return move === Move.Slide || move === Move.Dive || move === Move.SteepSlide || move === Move.Glide || move === Move.Splat ? C.EYE_H_LOW : C.EYE_H;
}

/** Can this state fire the marker (ignoring ammo / reload)? Vehicle seats are checked by the sim. */
export function canShootIn(move: MoveState): boolean {
  return move === Move.Ground || move === Move.Air || move === Move.Slide || move === Move.Dive ||
    move === Move.SteepSlide || move === Move.Zipline || move === Move.Vehicle;
}

// ---------------------------------------------------------------------------
// helpers (module scratch, no allocations)

let wx = 0, wz = 0, wlen = 0; // wish direction (unit) and input magnitude

function computeWish(cmd: InputCmd): void {
  const sy = sin(cmd.yaw), cy = cos(cmd.yaw);
  let mx = cmd.moveX, mz = cmd.moveZ;
  let l = Math.sqrt(mx * mx + mz * mz);
  if (l > 1) { mx /= l; mz /= l; l = 1; }
  // forward (sin, cos), right (-cos, sin)
  const x = sy * mz - cy * mx, z = cy * mz + sy * mx;
  const n = Math.sqrt(x * x + z * z);
  wlen = l;
  if (n > 1e-6) { wx = x / n; wz = z / n; } else { wx = 0; wz = 0; wlen = 0; }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function hspeed(p: PlayerState): number {
  return Math.sqrt(p.vx * p.vx + p.vz * p.vz);
}

function setMove(p: PlayerState, m: MoveState): void {
  if (p.move !== m) { p.move = m; p.moveT = 0; }
}

/** Push the body spheres out of solids. grounded = horizontal pushes only. */
function resolveBody(p: PlayerState, env: SimEnv, grounded: boolean, h: number): boolean {
  const R = C.BODY_R;
  const lo = C.STEP_H + R;
  let hi = h - R;
  if (hi < lo) hi = lo;
  let hit = false;
  for (let iter = 0; iter < 3; iter++) {
    let any = false;
    for (let k = 0; k < 3; k++) {
      const oy = k === 0 ? lo : k === 1 ? (lo + hi) * 0.5 : hi;
      if (k > 0 && hi === lo) break;
      const cy = p.y + oy;
      const d = dist(env, p.x, cy, p.z);
      if (d >= R) continue;
      const n = normal(env, p.x, cy, p.z);
      if (grounded) {
        const nh = Math.sqrt(n.x * n.x + n.z * n.z);
        if (nh < 0.25) continue; // floor/ceiling-ish: legs + ground snap handle it
        const ux = n.x / nh, uz = n.z / nh;
        let push = (R - d) / nh;
        if (push > R) push = R;
        p.x += ux * (push + 0.001);
        p.z += uz * (push + 0.001);
        const vn = p.vx * ux + p.vz * uz;
        if (vn < 0) { p.vx -= ux * vn; p.vz -= uz * vn; }
      } else {
        const push = R - d + 0.001;
        p.x += n.x * push; p.y += n.y * push; p.z += n.z * push;
        const vn = p.vx * n.x + p.vy * n.y + p.vz * n.z;
        if (vn < 0) { p.vx -= n.x * vn; p.vy -= n.y * vn; p.vz -= n.z * vn; }
      }
      any = true;
      hit = true;
    }
    if (!any) break;
  }
  return hit;
}

/**
 * Grounded ground-follow at the current x/z after a horizontal move from (ox, oz).
 * Returns false if the ground vanished (walked off an edge).
 */
function followGround(p: PlayerState, env: SimEnv, ox: number, oz: number, oy: number): boolean {
  let g = probeGround(env, p.x, oy + C.STEP_H, p.z, C.STEP_H + C.SNAP_DOWN);
  if (g === BLOCKED) {
    // leg-height obstacle: slide along it axis by axis
    const nz = p.z;
    p.z = oz;
    g = probeGround(env, p.x, oy + C.STEP_H, p.z, C.STEP_H + C.SNAP_DOWN);
    if (g === BLOCKED) {
      p.x = ox; p.z = nz;
      g = probeGround(env, p.x, oy + C.STEP_H, p.z, C.STEP_H + C.SNAP_DOWN);
      if (g === BLOCKED) { p.x = ox; p.z = oz; g = oy; p.vx *= 0.5; p.vz *= 0.5; }
      else p.vx = 0;
    } else p.vz = 0;
  }
  if (g === -Infinity) return false;
  const n = normal(env, p.x, g + 0.04, p.z);
  if (n.y < C.WALK_NY && g > oy + 0.03) {
    // walking up something too steep: treat the slope like a wall
    const nh = Math.sqrt(n.x * n.x + n.z * n.z) || 1;
    const ux = n.x / nh, uz = n.z / nh;
    const mx = p.x - ox, mz = p.z - oz;
    const into = mx * ux + mz * uz;
    if (into < 0) {
      p.x -= ux * into; p.z -= uz * into;
      const vn = p.vx * ux + p.vz * uz;
      if (vn < 0) { p.vx -= ux * vn; p.vz -= uz * vn; }
      const g2 = probeGround(env, p.x, oy + C.STEP_H, p.z, C.STEP_H + C.SNAP_DOWN);
      if (g2 !== BLOCKED && g2 !== -Infinity && g2 <= oy + 0.05) g = g2;
      else { p.x = ox; p.z = oz; g = oy; }
    }
  }
  p.y = g;
  const n2 = normal(env, p.x, g + 0.04, p.z);
  p.gnx = n2.x; p.gny = n2.y; p.gnz = n2.z;
  return true;
}

// ---------------------------------------------------------------------------
// mantle

function tryMantle(p: PlayerState, env: SimEnv, dx: number, dz: number, hmin: number, hmax: number): boolean {
  const l = Math.sqrt(dx * dx + dz * dz);
  if (l < 1e-4) return false;
  dx /= l; dz /= l;
  const R = C.BODY_R;
  // headroom above where we are now
  for (let r = 0; r < 2; r++) {
    const reach = R + (r === 0 ? 0.22 : C.MANTLE_REACH);
    const qx = p.x + dx * reach, qz = p.z + dz * reach;
    const top = probeGround(env, qx, p.y + hmax + 0.05, qz, hmax - hmin + 0.1);
    if (top === BLOCKED || top === -Infinity) continue;
    const h = top - p.y;
    if (h < hmin || h > hmax) continue;
    const n = normal(env, qx, top + 0.05, qz);
    if (n.y < 0.62) continue;
    // stand a little further in
    const tx = p.x + dx * (reach + 0.32), tz = p.z + dz * (reach + 0.32);
    const gt = probeGround(env, tx, top + 0.6, tz, 1.2);
    if (gt === BLOCKED || gt === -Infinity || gt < top - 0.4 || gt > top + 0.45) continue;
    if (dist(env, tx, gt + C.STEP_H + R + 0.05, tz) < R * 0.85) continue;
    if (dist(env, tx, gt + C.BODY_H - R, tz) < R * 0.85) continue;
    if (dist(env, p.x, top + C.BODY_H - R, p.z) < R * 0.7) continue;
    p.mx0 = p.x; p.my0 = p.y; p.mz0 = p.z;
    p.mx1 = tx; p.my1 = gt; p.mz1 = tz;
    p.mDur = C.MANTLE_TIME * (0.55 + 0.45 * clamp(h / C.MANTLE_MAX, 0, 1));
    p.vx = 0; p.vy = 0; p.vz = 0;
    p.grounded = false;
    setMove(p, Move.Mantle);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// state steps

function stepMantle(p: PlayerState, env: SimEnv, dt: number): number {
  const t = clamp(p.moveT / p.mDur, 0, 1);
  const ox = p.x, oy = p.y, oz = p.z;
  // rise first (hands on the ledge), then roll forward over it
  const up = clamp(t / 0.6, 0, 1);
  const eu = 1 - (1 - up) * (1 - up);
  const fw = clamp((t - 0.35) / 0.65, 0, 1);
  const ef = fw * fw * (3 - 2 * fw);
  p.y = p.my0 + (p.my1 + 0.06 - p.my0) * eu;
  p.x = p.mx0 + (p.mx1 - p.mx0) * (0.12 * up + 0.88 * ef);
  p.z = p.mz0 + (p.mz1 - p.mz0) * (0.12 * up + 0.88 * ef);
  p.vx = (p.x - ox) / dt; p.vy = (p.y - oy) / dt; p.vz = (p.z - oz) / dt;
  if (t >= 1) {
    p.y = p.my1;
    const dx = p.mx1 - p.mx0, dz = p.mz1 - p.mz0;
    const l = Math.sqrt(dx * dx + dz * dz) || 1;
    p.vx = (dx / l) * 2.5; p.vz = (dz / l) * 2.5; p.vy = 0;
    p.grounded = true;
    p.coyote = C.COYOTE_TIME;
    const n = normal(env, p.x, p.y + 0.04, p.z);
    p.gnx = n.x; p.gny = n.y; p.gnz = n.z;
    setMove(p, Move.Ground);
  }
  return 0;
}

function stepZipline(p: PlayerState, cmd: InputCmd, env: SimEnv, dt: number, pressed: number): number {
  const z = env.ziplines[p.zip];
  if (!z) { p.zip = -1; setMove(p, Move.Air); return 0; }
  p.zipV = Math.min(C.ZIP_MAX_SPEED, p.zipV + C.ZIP_ACCEL * dt);
  p.zipT += (p.zipV * dt) / z.length;
  const dx = (z.bx - z.ax) / z.length, dy = (z.by - z.ay) / z.length, dz = (z.bz - z.az) / z.length;
  const ox = p.x, oy = p.y, oz = p.z;
  const t = Math.min(p.zipT, 1);
  const q = zipPoint(z, t, _q);
  p.x = q.x; p.y = q.y - C.ZIP_FEET; p.z = q.z;
  p.vx = (p.x - ox) / dt; p.vy = (p.y - oy) / dt; p.vz = (p.z - oz) / dt;
  const feetBlocked = dist(env, p.x, p.y + 0.25, p.z) < 0.2;
  if (p.zipT >= 0.985 || (pressed & Btn.Jump) || feetBlocked) {
    p.vx = dx * p.zipV; p.vz = dz * p.zipV;
    p.vy = dy * p.zipV * 0.3 + ((pressed & Btn.Jump) ? C.JUMP_SPEED * 0.6 : 1.5);
    p.zip = -1;
    p.dived = false;
    p.grounded = false;
    p.coyote = 0;
    if (feetBlocked) p.y += 0.3;
    setMove(p, Move.Air);
    return Fx.ZipEnd;
  }
  void cmd;
  return 0;
}
const _q = { x: 0, y: 0, z: 0 };

function stepSwim(p: PlayerState, cmd: InputCmd, env: SimEnv, dt: number, pressed: number): number {
  let fx = 0;
  const W = waterAt(env, p.x, p.z);
  p.waterY = W;
  if (W === NO_WATER_Y) { setMove(p, Move.Air); p.grounded = false; return 0; }
  computeWish(cmd);
  const sprint = (cmd.buttons & Btn.Sprint) !== 0;
  let speed = (sprint ? C.SWIM_SPRINT : C.SWIM_SPEED) * wlen;
  if (p.upgrades & (1 << PickupKind.QuickFeet)) speed *= 1.1;
  const tvx = wx * speed, tvz = wz * speed;
  approach(p, tvx, tvz, C.SWIM_ACCEL * dt);
  // bob to the float depth
  const target = W - C.SWIM_DEPTH;
  p.vy += ((target - p.y) * 45 - p.vy * 11) * dt;
  p.breath = Math.min(1, p.breath + C.BREATH_REFILL * dt);

  const ox = p.x, oz = p.z;
  integrateFree(p, env, dt, C.BODY_H_LOW);
  // floor under us shallow enough to stand?
  const g = probeGround(env, p.x, p.y + C.STEP_H + 0.4, p.z, C.STEP_H + 1.2);
  if (g !== BLOCKED && g !== -Infinity) {
    if (W - g < C.SWIM_EXIT) {
      const n = normal(env, p.x, g + 0.04, p.z);
      if (n.y >= C.WALK_NY) {
        p.y = g; p.vy = 0; p.grounded = true;
        p.gnx = n.x; p.gny = n.y; p.gnz = n.z;
        setMove(p, Move.Ground);
        return fx;
      }
    }
    if (p.y < g) { p.y = g; if (p.vy < 0) p.vy = 0; }
  }
  // climb out onto docks / banks
  if (wlen > 0.3 && cmd.moveZ > 0.2 && ((pressed & Btn.Jump) || p.moveT > 0.25)) {
    const hmax = Math.min(C.MANTLE_MAX, W - p.y + 1.1);
    if (tryMantle(p, env, wx, wz, 0.25, hmax)) return fx | Fx.Mantle;
  }
  if ((pressed & Btn.Crouch) && p.gasp <= 0) {
    p.vy = -3.5;
    setMove(p, Move.Underwater);
    return fx | Fx.Submerge;
  }
  if ((pressed & Btn.Jump) && p.gasp <= 0) {
    // dolphin hop
    p.vy = C.JUMP_SPEED * 0.72;
    p.y = Math.max(p.y, W - C.SWIM_DEPTH * 0.8);
    p.grounded = false;
    p.dived = false;
    setMove(p, Move.Air);
    return fx | Fx.Jump;
  }
  void ox; void oz;
  return fx;
}

function stepUnderwater(p: PlayerState, cmd: InputCmd, env: SimEnv, dt: number): number {
  let fx = 0;
  const W = waterAt(env, p.x, p.z);
  p.waterY = W;
  if (W === NO_WATER_Y) { setMove(p, Move.Air); return 0; }
  const cp = cos(cmd.pitch), sp = sin(cmd.pitch), sy = sin(cmd.yaw), cy = cos(cmd.yaw);
  let mx = cmd.moveX, mz = cmd.moveZ;
  const ml = Math.sqrt(mx * mx + mz * mz);
  if (ml > 1) { mx /= ml; mz /= ml; }
  let tx = sy * cp * mz - cy * mx;
  let ty = sp * mz;
  let tz = cy * cp * mz + sy * mx;
  const up = (cmd.buttons & Btn.Jump) ? 1 : 0, down = (cmd.buttons & Btn.Crouch) ? 1 : 0;
  ty += up - down;
  const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
  let speed = C.UNDERWATER_SPEED;
  if (p.upgrades & (1 << PickupKind.QuickFeet)) speed *= 1.1;
  if (tl > 1) { tx /= tl; ty /= tl; tz /= tl; }
  tx *= speed; ty *= speed; tz *= speed;
  const a = C.UNDERWATER_ACCEL * dt;
  let dx = tx - p.vx, dy = ty - p.vy, dz = tz - p.vz;
  const dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dl > a) { dx *= a / dl; dy *= a / dl; dz *= a / dl; }
  p.vx += dx; p.vy += dy; p.vz += dz;
  if (!up && !down && Math.abs(cmd.moveZ) < 0.1) p.vy += C.BUOYANCY * dt;

  const snorkel = (p.upgrades & (1 << PickupKind.Snorkel)) !== 0;
  p.breath -= dt / (C.BREATH_TIME * (snorkel ? C.SNORKEL_MULT : 1));

  integrateFree(p, env, dt, C.BODY_H_LOW);
  const g = probeGround(env, p.x, p.y + C.STEP_H, p.z, C.STEP_H + 0.2);
  if (g !== BLOCKED && g !== -Infinity && p.y < g) { p.y = g; if (p.vy < 0) p.vy = 0; }

  if (p.breath <= 0) {
    p.breath = 0;
    p.gasp = C.GASP_TIME;
    p.vy = 7;
    setMove(p, Move.Swim);
    return fx | Fx.Gasp | Fx.Surface;
  }
  if (p.y >= W - C.SWIM_DEPTH - 0.05 && p.vy >= -0.1 && !down) {
    p.y = Math.min(p.y, W - C.SWIM_DEPTH + 0.1);
    setMove(p, Move.Swim);
    fx |= Fx.Surface;
  }
  return fx;
}

// ---------------------------------------------------------------------------
// sky drop: flying-squirrel glide, then a splat landing

/** Target (horizontal speed, sink rate) for the glide input: S flares ← neutral → W dives; Shift tucks. */
function glideTargets(cmd: InputCmd): void {
  const mz = clamp(cmd.moveZ, -1, 1);
  if (cmd.buttons & Btn.Sprint) { gHs = C.GLIDE_TUCK_SPEED; gVs = C.GLIDE_TUCK_SINK; }
  else if (mz >= 0) {
    gHs = C.GLIDE_SPEED + (C.GLIDE_DIVE_SPEED - C.GLIDE_SPEED) * mz;
    gVs = C.GLIDE_SINK + (C.GLIDE_DIVE_SINK - C.GLIDE_SINK) * mz;
  } else {
    gHs = C.GLIDE_SPEED + (C.GLIDE_FLARE_SPEED - C.GLIDE_SPEED) * -mz;
    gVs = C.GLIDE_SINK + (C.GLIDE_FLARE_SINK - C.GLIDE_SINK) * -mz;
  }
}
let gHs = 0, gVs = 0;

function stepGlide(p: PlayerState, cmd: InputCmd, env: SimEnv, dt: number): number {
  let fx = 0;
  glideTargets(cmd);
  // the view steers: glide along it, slip sideways with A/D
  const sy = sin(cmd.yaw), cy = cos(cmd.yaw);
  const mx = clamp(cmd.moveX, -1, 1) * C.GLIDE_STRAFE;
  approach(p, sy * gHs - cy * mx, cy * gHs + sy * mx, C.GLIDE_ACCEL * dt);
  const dv = -gVs - p.vy, a = C.GLIDE_VACCEL * dt;
  p.vy += dv > a ? a : dv < -a ? -a : dv;
  p.grounded = false;
  p.sprinting = false;

  const oy = p.y;
  integrateFree(p, env, dt, C.BODY_H_LOW);
  // touch down: on the ground (splat), a roof or slope too steep to stand on (slide off), or water (swim)
  if (p.vy <= 0.5) {
    let g = probeGround(env, p.x, Math.max(oy, p.y) + C.STEP_H, p.z, C.STEP_H + Math.abs(oy - p.y) + 0.06);
    if (g === BLOCKED) {
      // wedged into something (fast sink against a cliff): stand on the terrain under us
      const th = terrainHeight(env.world, p.x, p.z);
      g = th >= p.y - 1 ? th : -Infinity;
    }
    if (g !== BLOCKED && g !== -Infinity && p.y <= g + 0.02) {
      p.y = g;
      const nrm = normal(env, p.x, g + 0.04, p.z);
      p.gnx = nrm.x; p.gny = nrm.y; p.gnz = nrm.z;
      p.grounded = true;
      p.vy = 0;
      p.dived = false;
      p.coyote = 0;
      fx |= Fx.SkyLand;
      if (nrm.y < C.WALK_NY) setMove(p, Move.SteepSlide);
      else {
        p.vx *= 0.3; p.vz *= 0.3;
        setMove(p, Move.Splat);
      }
    }
  }
  const W = waterAt(env, p.x, p.z);
  p.waterY = W;
  if (W !== NO_WATER_Y && W - p.y > (p.grounded ? C.SWIM_ENTER : C.SWIM_DEPTH * 0.85)) {
    // belly-flop into a swim (never a plunge: you'd come up gasping)
    p.grounded = false;
    p.vx *= 0.3; p.vz *= 0.3; p.vy = 0;
    p.y = Math.max(p.y, W - C.SWIM_DEPTH);
    setMove(p, Move.Swim);
    fx |= Fx.SkyLand | Fx.WaterEnter | Fx.BellyFlop;
  }
  return fx;
}

function stepSplat(p: PlayerState, env: SimEnv, dt: number): number {
  // pancaked: skid to a stop, can't act until we pop back up
  const s = hspeed(p);
  if (s > 1e-4) { const ns = Math.max(0, s - 16 * dt); p.vx *= ns / s; p.vz *= ns / s; }
  p.vy = 0;
  const ox = p.x, oy = p.y, oz = p.z;
  p.x += p.vx * dt; p.z += p.vz * dt;
  resolveBody(p, env, true, C.BODY_H_LOW);
  if (!followGround(p, env, ox, oz, oy)) {
    p.grounded = false;
    p.coyote = 0;
    setMove(p, Move.Air);
    return 0;
  }
  p.grounded = true;
  if (p.moveT >= C.SPLAT_TIME) {
    p.coyote = C.COYOTE_TIME;
    setMove(p, Move.Ground);
  }
  return 0;
}

/** Accelerate horizontal velocity toward (tx, tz) by at most `a`. */
function approach(p: PlayerState, tx: number, tz: number, a: number): void {
  let dx = tx - p.vx, dz = tz - p.vz;
  const l = Math.sqrt(dx * dx + dz * dz);
  if (l > a) { dx *= a / l; dz *= a / l; }
  p.vx += dx; p.vz += dz;
}

/** 3D integration with full body resolution (air, water). */
function integrateFree(p: PlayerState, env: SimEnv, dt: number, h: number): void {
  const dx = p.vx * dt, dy = p.vy * dt, dz = p.vz * dt;
  const m = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
  const n = Math.min(10, Math.max(1, Math.ceil(m / C.MAX_SUBSTEP)));
  for (let i = 0; i < n; i++) {
    p.x += (p.vx * dt) / n; p.y += (p.vy * dt) / n; p.z += (p.vz * dt) / n;
    resolveBody(p, env, false, h);
  }
}

function stepLand(p: PlayerState, cmd: InputCmd, env: SimEnv, dt: number, pressed: number): number {
  let fx = 0;
  const b = cmd.buttons;
  computeWish(cmd);
  const quick = (p.upgrades & (1 << PickupKind.QuickFeet)) !== 0;
  const W0 = waterAt(env, p.x, p.z);
  const depth = W0 - p.y;
  const wading = depth > C.WADE_DEPTH;

  // ---- action transitions ------------------------------------------------------
  const onGround = p.move === Move.Ground || p.move === Move.Slide || p.move === Move.SteepSlide;
  const canJump = (onGround && p.grounded) || (p.move === Move.Air && p.coyote > 0);
  if (p.jumpBuf > 0 && canJump) {
    // a ledge in front? climb it instead of hopping
    const fdx = wlen > 0.3 ? wx : sin(cmd.yaw), fdz = wlen > 0.3 ? wz : cos(cmd.yaw);
    if (p.move !== Move.SteepSlide && cmd.moveZ >= 0 && tryMantle(p, env, fdx, fdz, 1.05, C.MANTLE_MAX)) {
      p.jumpBuf = 0;
      return fx | Fx.Mantle;
    }
    const fromSlide = p.move === Move.Slide;
    p.vy = C.JUMP_SPEED * (p.move === Move.SteepSlide ? 0.75 : 1);
    if (p.move === Move.SteepSlide) { p.vx += p.gnx * 3; p.vz += p.gnz * 3; }
    if (fromSlide) {
      const s = hspeed(p);
      if (s > 0.1) { const k = Math.min(C.SLIDE_MAX, s * C.SLIDE_JUMP_KEEP) / s; p.vx *= k; p.vz *= k; }
      fx |= Fx.SlideJump;
    }
    p.grounded = false;
    p.coyote = 0;
    p.jumpBuf = 0;
    p.jumpHeld = true;
    p.dived = false;
    setMove(p, Move.Air);
    fx |= Fx.Jump;
  }
  if (p.move === Move.Ground && p.grounded && (pressed & Btn.Crouch) && p.slideCd <= 0 && !wading) {
    const s = hspeed(p);
    if (s > C.SLIDE_MIN_SPEED) {
      const ns = Math.min(C.SLIDE_MAX, Math.max(s + 2.5, Math.min(C.SLIDE_BOOST, s * 1.3)));
      p.vx *= ns / s; p.vz *= ns / s;
      setMove(p, Move.Slide);
      fx |= Fx.Slide;
    }
  }
  if (p.move === Move.Air && (pressed & Btn.Crouch) && !p.dived) {
    const fdx = sin(cmd.yaw), fdz = cos(cmd.yaw);
    p.vx += fdx * C.DIVE_BOOST; p.vz += fdz * C.DIVE_BOOST;
    const s = hspeed(p);
    if (s > C.DIVE_MAX_H) { p.vx *= C.DIVE_MAX_H / s; p.vz *= C.DIVE_MAX_H / s; }
    if (p.vy > -6) p.vy = Math.max(p.vy, C.DIVE_HOP);
    p.dived = true;
    setMove(p, Move.Dive);
    fx |= Fx.Dive;
  }

  // ---- horizontal velocity -------------------------------------------------------
  const move = p.move;
  p.sprinting = false;
  if (move === Move.Ground) {
    const wantSprint = (b & Btn.Sprint) !== 0 && cmd.moveZ > 0.3 && !p.aiming && !wading && p.stumble <= 0;
    let max = p.aiming ? C.AIM_SPEED : wantSprint ? C.SPRINT_SPEED : C.RUN_SPEED;
    if (cmd.moveZ < -0.1) max *= C.BACK_MULT;
    if (quick) max *= C.QUICKFEET_MULT;
    if (wading) max *= C.WADE_MULT;
    if (p.stumble > 0) max *= C.STUMBLE_MULT;
    const tx = wx * max * wlen, tz = wz * max * wlen;
    const s = hspeed(p);
    const acc = wlen > 0.05 ? (s > max + 0.5 ? C.GROUND_DECEL * 0.6 : C.GROUND_ACCEL) : C.GROUND_DECEL;
    approach(p, tx, tz, acc * dt);
    p.sprinting = wantSprint && hspeed(p) > C.RUN_SPEED * 0.8;
  } else if (move === Move.Air || move === Move.Dive) {
    let max = p.aiming ? C.AIM_SPEED : (b & Btn.Sprint) ? C.SPRINT_SPEED : C.RUN_SPEED;
    if (quick) max *= C.QUICKFEET_MULT;
    const accel = (move === Move.Dive ? C.AIR_ACCEL * 0.3 : C.AIR_ACCEL) * dt;
    if (wlen > 0.05) {
      const cur = p.vx * wx + p.vz * wz;
      const add = max * wlen - cur;
      if (add > 0) { const k = Math.min(add, accel); p.vx += wx * k; p.vz += wz * k; }
      // bleed the sideways part a little so steering feels responsive
      const sx = p.vx - wx * (p.vx * wx + p.vz * wz), sz = p.vz - wz * (p.vx * wx + p.vz * wz);
      const bleed = Math.min(1, 1.2 * dt);
      p.vx -= sx * bleed; p.vz -= sz * bleed;
    } else {
      const k = 1 - Math.min(1, C.AIR_DRAG * dt);
      p.vx *= k; p.vz *= k;
    }
  } else if (move === Move.Slide) {
    const s = hspeed(p);
    // gravity along the ground (downhill = horizontal part of the normal)
    p.vx += p.gnx * C.SLIDE_SLOPE_ACCEL * dt;
    p.vz += p.gnz * C.SLIDE_SLOPE_ACCEL * dt;
    // friction
    const s2 = hspeed(p);
    if (s2 > 1e-4) {
      const ns = Math.max(0, s2 - C.SLIDE_FRICTION * dt);
      p.vx *= ns / s2; p.vz *= ns / s2;
    }
    // steer toward the wished direction
    if (wlen > 0.2 && s > 0.5) {
      const cross = p.vx * wz - p.vz * wx;
      const ang = clamp(cross / (s || 1), -1, 1) * C.SLIDE_STEER * dt;
      const ca = cos(ang), sa = sin(ang);
      const nvx = p.vx * ca - p.vz * sa, nvz = p.vx * sa + p.vz * ca;
      p.vx = nvx; p.vz = nvz;
    }
    const s3 = hspeed(p);
    if (s3 > C.SLIDE_MAX) { p.vx *= C.SLIDE_MAX / s3; p.vz *= C.SLIDE_MAX / s3; }
    if (p.moveT > C.SLIDE_MIN_TIME && (s3 < C.SLIDE_END_SPEED || !(b & Btn.Crouch))) {
      setMove(p, Move.Ground);
      p.slideCd = C.SLIDE_COOLDOWN;
    }
  } else if (move === Move.SteepSlide) {
    p.vx += p.gnx * C.STEEP_SLIDE_ACCEL * dt;
    p.vz += p.gnz * C.STEEP_SLIDE_ACCEL * dt;
    approach(p, p.vx + wx * wlen * 2, p.vz + wz * wlen * 2, 6 * dt);
  }

  // ---- vertical + integrate ------------------------------------------------------
  const h = bodyHeight(p.move);
  const grounded = p.grounded && (p.move === Move.Ground || p.move === Move.Slide || p.move === Move.SteepSlide);
  if (grounded) {
    p.vy = 0;
    const dx = p.vx * dt, dz = p.vz * dt;
    const n = Math.min(8, Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dz)) / C.MAX_SUBSTEP)));
    for (let i = 0; i < n; i++) {
      const ox = p.x, oy = p.y, oz = p.z;
      p.x += (p.vx * dt) / n;
      p.z += (p.vz * dt) / n;
      resolveBody(p, env, true, h);
      if (!followGround(p, env, ox, oz, oy)) {
        // walked off an edge
        p.grounded = false;
        p.coyote = p.move === Move.Slide ? C.COYOTE_TIME * 0.6 : C.COYOTE_TIME;
        p.vy = p.move === Move.Slide ? -1 : 0;
        p.dived = false;
        setMove(p, Move.Air);
        break;
      }
    }
    if (p.grounded) {
      if (p.gny < C.WALK_NY && p.move !== Move.SteepSlide) setMove(p, Move.SteepSlide);
      else if (p.gny >= C.WALK_NY + 0.03 && p.move === Move.SteepSlide) setMove(p, Move.Ground);
    }
  } else {
    // airborne
    if (p.jumpHeld && !(b & Btn.Jump)) {
      if (p.vy > 0) p.vy *= C.JUMP_CUT;
      p.jumpHeld = false;
    }
    if (p.vy < 0) p.jumpHeld = false;
    p.vy -= C.GRAVITY * (p.vy < 0 ? C.FALL_MULT : 1) * dt;
    if (p.vy < -C.MAX_FALL) p.vy = -C.MAX_FALL;
    const oy = p.y;
    const impactVy = p.vy;
    integrateFree(p, env, dt, h);
    if (p.vy <= 0.5) {
      const g = probeGround(env, p.x, Math.max(oy, p.y) + C.STEP_H, p.z, C.STEP_H + Math.abs(oy - p.y) + 0.06);
      if (g !== BLOCKED && g !== -Infinity && p.y <= g + 0.02) {
        p.y = g;
        const nrm = normal(env, p.x, g + 0.04, p.z);
        p.gnx = nrm.x; p.gny = nrm.y; p.gnz = nrm.z;
        p.grounded = true;
        const impact = -impactVy;
        const wasDive = p.move === Move.Dive;
        p.vy = 0;
        if (nrm.y < C.WALK_NY) setMove(p, Move.SteepSlide);
        else if (wasDive || ((b & Btn.Crouch) && hspeed(p) > C.SLIDE_MIN_SPEED)) {
          const s = hspeed(p);
          const fdx = sin(cmd.yaw), fdz = cos(cmd.yaw);
          if (s < 5) { p.vx += fdx * (5 - s); p.vz += fdz * (5 - s); }
          setMove(p, Move.Slide);
          fx |= Fx.Slide;
        } else setMove(p, Move.Ground);
        if (impact > C.STUMBLE_VY && !wasDive) { p.stumble = C.STUMBLE_TIME; fx |= Fx.LandHard; p.vx *= 0.3; p.vz *= 0.3; }
        else if (impact > 2) fx |= Fx.Land;
        p.dived = false;
      }
    }
    // grab ledges while jumping into them
    if (!p.grounded && p.vy < 3.5 && cmd.moveZ > 0.3 && wlen > 0.3) {
      if (tryMantle(p, env, wx, wz, C.STEP_H * 0.8, 1.55)) fx |= Fx.Mantle;
    }
  }

  // ---- water -----------------------------------------------------------------------
  if (p.move !== Move.Mantle) {
    const W = waterAt(env, p.x, p.z);
    p.waterY = W;
    const d = W - p.y;
    if (W !== NO_WATER_Y) {
      if (p.grounded && d > C.SWIM_ENTER) {
        p.grounded = false;
        setMove(p, Move.Swim);
      } else if (!p.grounded && d > C.SWIM_DEPTH * 0.85) {
        const impact = -p.vy;
        fx |= Fx.WaterEnter;
        if (p.move === Move.Dive) fx |= Fx.BellyFlop;
        p.vx *= 0.55; p.vz *= 0.55;
        if (impact > C.PLUNGE_VY && W - terrainHeight(env.world, p.x, p.z) > 2.6 && p.gasp <= 0) {
          p.vy = -Math.min(6, impact * 0.28);
          setMove(p, Move.Underwater);
          fx |= Fx.Submerge;
        } else {
          p.vy *= 0.2;
          setMove(p, Move.Swim);
        }
      }
    }
  }
  return fx;
}

/**
 * Advance one player by one fixed step. Pure w.r.t. everything but `p`.
 * Returns Fx bits describing what happened (for sounds/particles).
 */
export function stepPlayer(p: PlayerState, cmd: InputCmd, dt: number, env: SimEnv): number {
  const b = cmd.buttons;
  const pressed = b & ~p.prevButtons;
  p.prevButtons = b;
  p.lastSeq = cmd.seq;
  p.yaw = cmd.yaw;
  p.pitch = clamp(cmd.pitch, -1.45, 1.45);
  p.moveT += dt;
  if (p.move === Move.Dead) return 0;

  if (p.coyote > 0) p.coyote -= dt;
  p.jumpBuf = (pressed & Btn.Jump) ? C.JUMP_BUFFER : Math.max(0, p.jumpBuf - dt);
  if (p.slideCd > 0) p.slideCd -= dt;
  if (p.stumble > 0) p.stumble -= dt;
  if (p.gasp > 0) p.gasp -= dt;
  p.aiming = (b & Btn.Aim) !== 0 && canShootIn(p.move) && p.move !== Move.Slide;

  let fx = 0;
  switch (p.move) {
    case Move.Vehicle:
      p.breath = Math.min(1, p.breath + C.BREATH_REFILL * dt);
      break;
    case Move.Zipline:
      fx = stepZipline(p, cmd, env, dt, pressed);
      break;
    case Move.Mantle:
      fx = stepMantle(p, env, dt);
      break;
    case Move.Swim:
      fx = stepSwim(p, cmd, env, dt, pressed);
      break;
    case Move.Underwater:
      fx = stepUnderwater(p, cmd, env, dt);
      break;
    case Move.Glide:
      fx = stepGlide(p, cmd, env, dt);
      p.breath = 1;
      break;
    case Move.Splat:
      fx = stepSplat(p, env, dt);
      break;
    default:
      fx = stepLand(p, cmd, env, dt, pressed);
      if ((p.move as MoveState) !== Move.Swim && (p.move as MoveState) !== Move.Underwater) p.breath = Math.min(1, p.breath + C.BREATH_REFILL * dt);
      break;
  }
  // spawn shield for the whole drop (the sim counts it down from DROP_LAND_SHIELD after touch-down)
  if ((p.move === Move.Glide || p.move === Move.Splat) && p.shield < C.DROP_LAND_SHIELD + dt) p.shield = C.DROP_LAND_SHIELD + dt;
  // the edge of the map: an invisible current pushes you back
  const lim = WORLD_HALF - 12;
  if (p.x > lim) { p.x = lim; if (p.vx > 0) p.vx = 0; }
  else if (p.x < -lim) { p.x = -lim; if (p.vx < 0) p.vx = 0; }
  if (p.z > lim) { p.z = lim; if (p.vz > 0) p.vz = 0; }
  else if (p.z < -lim) { p.z = -lim; if (p.vz < 0) p.vz = 0; }
  return fx;
}

/** Aim direction from yaw/pitch. */
export function aimDir(yaw: number, pitch: number, out: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  const cp = cos(pitch);
  out.x = sin(yaw) * cp;
  out.y = sin(pitch);
  out.z = cos(yaw) * cp;
  return out;
}
