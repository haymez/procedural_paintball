// Own-player prediction: one sim step for the local player, mirroring what
// MatchSim.step does for a single player (movement, spawn shield, marker,
// and — for a driver — the vehicle), without touching anyone else.
//
// Server-only effects (hits, pickups, washing, respawning, most interacting) are
// not predicted; they arrive in the authoritative state and replaying the
// unacknowledged cmds on top of it carries them forward.
import {
  Btn, Move, RELOAD_TIME, TICK_DT, canShootIn, computeLaunch, currentSpread, fireInterval, hopperCap, seatWorld, segCapsule, stepPlayer, stepVehicle, HIT_R,
  type InputCmd, type Launch, type PlayerState, type SimEnv, type SimEvent, type VehicleState,
} from "../../../../shared/sim/index";
import { shotRandom } from "../../../../shared/sim/weapon";
import { cos, sin } from "../../../../shared/math/trig";

export interface PredictedShot {
  seq: number;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
}

/** Local interact (E) prediction: the NetClient mirrors MatchSim.interact where it's safe. */
export type InteractHook = (p: PlayerState, out: StepOut | null) => void;

export interface StepOut {
  /** Movement/weapon events for the local player (only when emitting). */
  events: SimEvent[];
  shots: PredictedShot[];
}

const _launch: Launch = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, tx: 0, ty: 0, tz: 0 };
const _seat = { x: 0, y: 0, z: 0 };

/** Ray vs the displayed hit capsules of other players (the aim ray's "zero"). */
function rayOthers(others: readonly PlayerState[], skip: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): number {
  let best = Infinity;
  for (const o of others) {
    if (o.id === skip || !o.alive) continue;
    const t = segCapsule(ox, oy, oz, dx * maxT, dy * maxT, dz * maxT, o, HIT_R * 0.8);
    if (t >= 0 && t * maxT < best) best = t * maxT;
  }
  return best;
}

/**
 * One predicted step. `veh` = the vehicle p drives (predicted alongside), or
 * null. `out` null = replay (no events, no shots).
 */
export function predictStep(
  p: PlayerState, cmd: InputCmd, veh: VehicleState | null, env: SimEnv, others: readonly PlayerState[], out: StepOut | null,
  interact: InteractHook | null = null,
): void {
  const dt = TICK_DT;
  const pressed = cmd.buttons & ~p.prevButtons;
  if (!p.alive) {
    p.prevButtons = cmd.buttons;
    p.yaw = cmd.yaw;
    p.pitch = cmd.pitch;
    p.deadT += dt;
    p.lastSeq = cmd.seq;
    return;
  }
  const driving = p.move === Move.Vehicle && p.seat === 0 && veh !== null && veh.id === p.vehicle ? veh : null;
  const fx = stepPlayer(p, cmd, dt, env);
  if (fx && out) {
    const s = Math.sqrt(p.vx * p.vx + p.vy * p.vy + p.vz * p.vz);
    out.events.push({ type: "move", pid: p.id, fx, x: p.x, y: p.y, z: p.z, speed: s });
  }
  if (p.shield > 0) p.shield -= dt;
  // same order as MatchSim.step: move, shield, interact, weapon
  if ((pressed & Btn.Interact) && interact) interact(p, out);
  weapon(p, cmd, pressed, env, others, out);
  if (driving) {
    stepVehicle(driving, cmd, dt, env);
    seatWorld(driving, p.seat, _seat);
    p.x = _seat.x; p.y = _seat.y; p.z = _seat.z;
    p.vx = sin(driving.yaw) * driving.speed; p.vy = driving.vy; p.vz = cos(driving.yaw) * driving.speed;
    p.grounded = true;
  }
}

function weapon(p: PlayerState, cmd: InputCmd, pressed: number, env: SimEnv, others: readonly PlayerState[], out: StepOut | null): void {
  const dt = TICK_DT;
  if (p.fireCd > 0) p.fireCd -= dt;
  const cap = hopperCap(p);
  if (p.reload > 0) {
    p.reload -= dt;
    if (p.reload <= 0) {
      p.reload = 0;
      const take = Math.min(cap - p.hopper, p.reserve);
      p.hopper += take;
      p.reserve -= take;
      out?.events.push({ type: "reloaded", pid: p.id });
    }
    return;
  }
  const driver = p.move === Move.Vehicle && p.seat === 0;
  if ((pressed & Btn.Reload) && p.hopper < cap && p.reserve > 0) {
    p.reload = RELOAD_TIME;
    out?.events.push({ type: "reload", pid: p.id });
    return;
  }
  if (!(cmd.buttons & Btn.Fire) || driver || !canShootIn(p.move) || p.fireCd > 0) return;
  if (p.hopper <= 0) {
    if (p.reserve > 0) {
      p.reload = RELOAD_TIME;
      out?.events.push({ type: "reload", pid: p.id });
    } else if (pressed & Btn.Fire) out?.events.push({ type: "empty", pid: p.id });
    return;
  }
  const spread = currentSpread(p);
  const u1 = shotRandom(p.id, p.shotSeq, 1), u2 = shotRandom(p.id, p.shotSeq, 2);
  const L = computeLaunch(env, p, spread, u1, u2, _launch, (ox, oy, oz, dx, dy, dz, maxT) => rayOthers(others, p.id, ox, oy, oz, dx, dy, dz, maxT));
  const seq = p.shotSeq;
  p.shotSeq++;
  p.hopper--;
  p.fireCd += fireInterval(p);
  if (p.fireCd < 0) p.fireCd = 0;
  if (p.shield > 0) p.shield = Math.min(p.shield, 0.15);
  out?.shots.push({ seq, x: L.x, y: L.y, z: L.z, vx: L.vx, vy: L.vy, vz: L.vz });
}
