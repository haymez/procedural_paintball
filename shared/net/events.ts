// Sim events on the wire. Bundled into snapshots (reliable + ordered).
//
// Colors are never sent where the receiver can derive them from a player id
// (shot/hit/splat use the shooter's roster color), and elim `place` names are
// recomputed from the world on the client, so decoded events carry
// placeholders (color 0, place "") that the client fills in.
import type { SimEvent } from "../sim/types";
import { WORLD_HALF } from "../world/types";
import { ProtoError, type Reader, type Writer } from "./codec";
import { Y_MAX, Y_MIN } from "./entities";

/** A sim event plus the sim tick it happened on (and the shot sequence for shots). */
export type NetEvent = SimEvent & { tick: number; seq?: number };

export const EV_TYPES = [
  "shot", "hit", "shield", "vest", "splat", "splash", "projEnd", "elim", "respawn",
  "pickup", "pickupSpawn", "vehicleEnter", "vehicleExit", "vehicleBump", "vehicleReset", "zipStart", "zipEnd",
  "wash", "move", "reload", "reloaded", "empty", "join", "leave", "matchEnd", "wear",
] as const;
type EvType = SimEvent["type"];
const EV_ID = new Map<EvType, number>(EV_TYPES.map((t, i) => [t as EvType, i]));

function wpos(w: Writer, x: number, y: number, z: number): void {
  w.quant(x, -WORLD_HALF, WORLD_HALF, 16).quant(y, Y_MIN, Y_MAX, 16).quant(z, -WORLD_HALF, WORLD_HALF, 16);
}
function rpos(r: Reader): { x: number; y: number; z: number } {
  return { x: r.quant(-WORLD_HALF, WORLD_HALF, 16), y: r.quant(Y_MIN, Y_MAX, 16), z: r.quant(-WORLD_HALF, WORLD_HALF, 16) };
}
function unit8(w: Writer, v: number): void {
  w.i8(Math.max(-127, Math.min(127, Math.round(v * 127))));
}
function runit8(r: Reader): number {
  return r.i8() / 127;
}

/** Writes one event (without its tick; the snapshot writes that). */
export function writeEvent(w: Writer, e: SimEvent & { seq?: number }): void {
  const id = EV_ID.get(e.type);
  if (id === undefined) throw new Error(`unknown event ${e.type}`);
  w.u8(id);
  switch (e.type) {
    case "shot":
      w.u8(e.pid).varu(e.proj).varu(e.seq ?? 0);
      wpos(w, e.x, e.y, e.z);
      w.f16(e.vx).f16(e.vy).f16(e.vz);
      break;
    case "hit":
      w.u8(e.target).u8(e.shooter);
      wpos(w, e.x, e.y, e.z);
      unit8(w, e.dx);
      unit8(w, e.dz);
      w.u8(e.coats);
      break;
    case "shield":
    case "vest":
      w.u8(e.target).u8(e.shooter);
      wpos(w, e.x, e.y, e.z);
      break;
    case "splat":
      w.varu(e.proj).u8(e.shooter);
      wpos(w, e.x, e.y, e.z);
      unit8(w, e.nx);
      unit8(w, e.ny);
      unit8(w, e.nz);
      w.quant(e.r, 0, 1, 8).u8(e.surf);
      break;
    case "splash":
      w.varu(e.proj);
      wpos(w, e.x, e.y, e.z);
      w.quant(e.size, 0, 4, 8);
      break;
    case "projEnd":
      w.varu(e.proj);
      break;
    case "elim":
      w.u8(e.victim).vari(e.killer);
      wpos(w, e.x, e.y, e.z);
      w.u8(e.tags).f16(e.dist);
      break;
    case "respawn":
      w.u8(e.pid);
      wpos(w, e.x, e.y, e.z);
      break;
    case "pickup":
      w.u8(e.pid).varu(e.pickup).u8(e.kind).u8(e.drop);
      wpos(w, e.x, e.y, e.z);
      break;
    case "pickupSpawn":
      w.varu(e.pickup);
      break;
    case "vehicleEnter":
      w.u8(e.pid).u8(e.vehicle).u8(e.seat);
      break;
    case "vehicleExit":
      w.u8(e.pid).u8(e.vehicle);
      break;
    case "vehicleBump":
      w.u8(e.vehicle).f16(e.speed);
      break;
    case "vehicleReset":
      w.u8(e.vehicle);
      break;
    case "zipStart":
    case "zipEnd":
      w.u8(e.pid).vari(e.zip);
      break;
    case "wash":
    case "wear":
      w.u8(e.pid).u8(e.coats).u32(e.color);
      break;
    case "move":
      w.u8(e.pid).varu(e.fx);
      wpos(w, e.x, e.y, e.z);
      w.f16(e.speed);
      break;
    case "reload":
    case "reloaded":
    case "empty":
    case "join":
    case "leave":
      w.u8(e.pid);
      break;
    case "matchEnd":
      break;
  }
}

export function readEvent(r: Reader, tick: number): NetEvent {
  const id = r.u8();
  const type = EV_TYPES[id];
  if (!type) throw new ProtoError(`unknown event id ${id}`);
  switch (type) {
    case "shot": {
      const pid = r.u8(), proj = r.varu(), seq = r.varu();
      const p = rpos(r);
      return { type, pid, proj, seq, ...p, vx: r.f16(), vy: r.f16(), vz: r.f16(), color: 0, tick };
    }
    case "hit": {
      const target = r.u8(), shooter = r.u8();
      const p = rpos(r);
      return { type, target, shooter, ...p, dx: runit8(r), dz: runit8(r), coats: r.u8(), color: 0, tick };
    }
    case "shield":
    case "vest": {
      const target = r.u8(), shooter = r.u8();
      return { type, target, shooter, ...rpos(r), tick };
    }
    case "splat": {
      const proj = r.varu(), shooter = r.u8();
      const p = rpos(r);
      const nx = runit8(r), ny = runit8(r), nz = runit8(r);
      return { type, proj, shooter, ...p, nx, ny, nz, r: r.quant(0, 1, 8), surf: r.u8(), color: 0, tick };
    }
    case "splash": {
      const proj = r.varu();
      const p = rpos(r);
      return { type, proj, ...p, size: r.quant(0, 4, 8), tick };
    }
    case "projEnd":
      return { type, proj: r.varu(), tick };
    case "elim": {
      const victim = r.u8(), killer = r.vari();
      const p = rpos(r);
      return { type, victim, killer, ...p, tags: r.u8(), dist: r.f16(), place: "", tick };
    }
    case "respawn": {
      const pid = r.u8();
      return { type, pid, ...rpos(r), tick };
    }
    case "pickup": {
      const pid = r.u8(), pickup = r.varu(), kind = r.u8(), drop = r.u8();
      return { type, pid, pickup, kind, drop, ...rpos(r), tick };
    }
    case "pickupSpawn":
      return { type, pickup: r.varu(), tick };
    case "vehicleEnter":
      return { type, pid: r.u8(), vehicle: r.u8(), seat: r.u8(), tick };
    case "vehicleExit":
      return { type, pid: r.u8(), vehicle: r.u8(), tick };
    case "vehicleBump":
      return { type, vehicle: r.u8(), speed: r.f16(), tick };
    case "vehicleReset":
      return { type, vehicle: r.u8(), tick };
    case "zipStart":
    case "zipEnd":
      return { type, pid: r.u8(), zip: r.vari(), tick };
    case "wash":
    case "wear":
      return { type, pid: r.u8(), coats: r.u8(), color: r.u32(), tick };
    case "move": {
      const pid = r.u8(), fx = r.varu();
      const p = rpos(r);
      return { type, pid, fx, ...p, speed: r.f16(), tick };
    }
    case "reload":
    case "reloaded":
    case "empty":
    case "join":
    case "leave":
      return { type, pid: r.u8(), tick };
    case "matchEnd":
      return { type, tick };
  }
}
