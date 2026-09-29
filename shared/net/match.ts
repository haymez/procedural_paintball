// Match-phase messages (ids 64..239 in each direction, debug 240+).
//
// Timing: the sim steps at 60 Hz (shared/sim TICK_HZ); the room ticks at
// 30 Hz and runs two sim steps per room tick, so every snapshot advances the
// sim tick by 2. All ticks on the wire are sim ticks.
//
// C2S
//   Input      (64)  batched InputCmds (~every 33 ms) + the tick the client was
//                    rendering remote players at (lag compensation). The last
//                    two already-sent cmds ride along again as cheap insurance.
//   DebugCmd  (240)  dev-only helpers (teleport, freeze bots…); the server
//                    ignores them unless it runs locally.
// S2C
//   MatchInit  (64)  on (re)entering the match: roster, pickups, recent paint.
//   Roster     (65)  players joining / leaving mid-match.
//   Snapshot   (66)  per client, 30 Hz: own full state + ack, other players,
//                    vehicles and pickups as deltas, and this tick's events.
//   NetStats  (240)  dev-only server timing, every 2 s.
import type { InputCmd } from "../sim/types";
import { WORLD_HALF } from "../world/types";
import { OWN, REMOTE, VEHICLE, Y_MAX, Y_MIN } from "./entities";
import { quantize, readWire, writeWire, type Schema } from "./schema";
import { readEvent, writeEvent, type NetEvent } from "./events";
import { C2S, S2C } from "./registry";
import type { Reader, Writer } from "./codec";
import { MAX_PLAYERS } from "./rules";

export { OWN, REMOTE, VEHICLE, PF, Y_MIN, Y_MAX, playerFlags, setPlayerFlags, packSeats, unpackSeats } from "./entities";
export { readEvent, writeEvent, EV_TYPES, type NetEvent } from "./events";
export * from "./schema";

/** Sim ticks per room tick (snapshot). */
export const SIM_PER_TICK = 2;
/** Max cmds in one Input message. */
export const MAX_BATCH = 24;
/** Lag compensation never rewinds further than this (sim ticks, 250 ms). */
export const MAX_REWIND = 15;

// --- input -------------------------------------------------------------------

const PITCH_MAX = 1.6;

/**
 * Quantize a cmd in place exactly as the wire will, so the client predicts
 * with the very values the server steps with.
 */
export function quantizeCmd(c: InputCmd): InputCmd {
  c.moveX = Math.max(-127, Math.min(127, Math.round(c.moveX * 127))) / 127;
  c.moveZ = Math.max(-127, Math.min(127, Math.round(c.moveZ * 127))) / 127;
  let a = c.yaw % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  if (!(a >= 0)) a = 0;
  c.yaw = ((Math.round((a / (Math.PI * 2)) * 65536) % 65536) / 65536) * Math.PI * 2;
  const p = Math.max(-PITCH_MAX, Math.min(PITCH_MAX, Number.isFinite(c.pitch) ? c.pitch : 0));
  c.pitch = (Math.round((p / PITCH_MAX) * 32767) / 32767) * PITCH_MAX;
  c.buttons = c.buttons & 0xffff;
  return c;
}

export interface InputMsg {
  /** Seq of cmds[0]; the rest follow consecutively. */
  seq: number;
  cmds: InputCmd[];
  /** Sim tick (fractional) the client was rendering remote players at when it made the newest cmd. */
  view: number;
}

export const Input = C2S.define<InputMsg>(
  64,
  "input",
  (w, m) => {
    const n = Math.min(MAX_BATCH, m.cmds.length);
    const view = Math.max(0, m.view);
    const vt = Math.floor(view);
    w.u32(m.seq).u8(n).u32(vt).u8(Math.min(255, Math.round((view - vt) * 256)));
    for (let i = 0; i < n; i++) {
      const c = m.cmds[i]!;
      w.i8(Math.max(-127, Math.min(127, Math.round(c.moveX * 127))));
      w.i8(Math.max(-127, Math.min(127, Math.round(c.moveZ * 127))));
      w.angle(c.yaw, 16);
      w.i16(Math.round((Math.max(-PITCH_MAX, Math.min(PITCH_MAX, c.pitch)) / PITCH_MAX) * 32767));
      w.varu(c.buttons & 0xffff);
    }
  },
  (r) => {
    const seq = r.u32();
    const n = r.u8();
    if (n > MAX_BATCH) throw new RangeError("input batch too long");
    const vt = r.u32();
    const view = vt + r.u8() / 256;
    const cmds: InputCmd[] = [];
    for (let i = 0; i < n; i++) {
      const moveX = r.i8() / 127, moveZ = r.i8() / 127, yaw = r.angle(16);
      const pitch = (r.i16() / 32767) * PITCH_MAX;
      cmds.push({ seq: seq + i, moveX, moveZ, yaw, pitch, buttons: r.varu() & 0xffff });
    }
    return { seq, cmds, view };
  },
);

export const DebugOp = {
  /** a,b = x,z (c = NaN → ground) */
  Teleport: 1,
  /** a: 0 frozen, 1 roam, 2 roam without shooting */
  Bots: 2,
  /** Put player id a in front of me at distance b (facing me). */
  Summon: 3,
  /** Clear my shield. */
  NoShield: 4,
} as const;

export interface DebugCmdMsg {
  op: number;
  a: number;
  b: number;
  c: number;
}
export const DebugCmd = C2S.define<DebugCmdMsg>(
  240,
  "debugCmd",
  (w, m) => void w.u8(m.op).f32(m.a).f32(m.b).f32(m.c),
  (r) => ({ op: r.u8(), a: r.f32(), b: r.f32(), c: r.f32() }),
);

// --- match init / roster ---------------------------------------------------------

export interface RosterEntry {
  id: number;
  name: string;
  /** Palette index (PLAYER_COLORS). */
  color: number;
  bot: boolean;
}

export interface PickupInit {
  id: number;
  kind: number;
  x: number;
  y: number;
  z: number;
  active: boolean;
  drop: number;
}

export interface PaintRec {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  r: number;
  /** Palette index. */
  color: number;
}

export interface MatchInitMsg {
  you: number;
  tick: number;
  /** Server time (ms) the match ends. */
  endsAt: number;
  /** Server accepts DebugCmd. */
  debug: boolean;
  roster: RosterEntry[];
  pickups: PickupInit[];
  /** Recent splats so late joiners see the paint that's already on the island. */
  paint: PaintRec[];
}

function wpos(w: Writer, x: number, y: number, z: number): void {
  w.quant(x, -WORLD_HALF, WORLD_HALF, 16).quant(y, Y_MIN, Y_MAX, 16).quant(z, -WORLD_HALF, WORLD_HALF, 16);
}
function rpos(r: Reader): { x: number; y: number; z: number } {
  return { x: r.quant(-WORLD_HALF, WORLD_HALF, 16), y: r.quant(Y_MIN, Y_MAX, 16), z: r.quant(-WORLD_HALF, WORLD_HALF, 16) };
}

function writeRosterEntry(w: Writer, e: RosterEntry): void {
  w.u8(e.id).str(e.name).u8(e.color).bool(e.bot);
}
function readRosterEntry(r: Reader): RosterEntry {
  return { id: r.u8(), name: r.str(128), color: r.u8(), bot: r.bool() };
}

export function writePickupInit(w: Writer, k: PickupInit): void {
  w.varu(k.id).u8(k.kind);
  wpos(w, k.x, k.y, k.z);
  w.bool(k.active).u8(k.drop);
}
export function readPickupInit(r: Reader): PickupInit {
  const id = r.varu(), kind = r.u8();
  const p = rpos(r);
  return { id, kind, ...p, active: r.bool(), drop: r.u8() };
}

export const MatchInit = S2C.define<MatchInitMsg>(
  64,
  "matchInit",
  (w, m) => {
    w.u8(m.you).u32(m.tick).f64(m.endsAt).bool(m.debug);
    w.varu(m.roster.length);
    for (const e of m.roster) writeRosterEntry(w, e);
    w.varu(m.pickups.length);
    for (const k of m.pickups) writePickupInit(w, k);
    w.varu(m.paint.length);
    for (const s of m.paint) {
      wpos(w, s.x, s.y, s.z);
      w.i8(Math.round(s.nx * 127)).i8(Math.round(s.ny * 127)).i8(Math.round(s.nz * 127));
      w.quant(s.r, 0, 1, 8).u8(s.color);
    }
  },
  (r) => {
    const you = r.u8(), tick = r.u32(), endsAt = r.f64(), debug = r.bool();
    const roster: RosterEntry[] = [];
    for (let i = r.count(MAX_PLAYERS + 32); i > 0; i--) roster.push(readRosterEntry(r));
    const pickups: PickupInit[] = [];
    for (let i = r.count(4096); i > 0; i--) pickups.push(readPickupInit(r));
    const paint: PaintRec[] = [];
    for (let i = r.count(8192); i > 0; i--) {
      const p = rpos(r);
      paint.push({ ...p, nx: r.i8() / 127, ny: r.i8() / 127, nz: r.i8() / 127, r: r.quant(0, 1, 8), color: r.u8() });
    }
    return { you, tick, endsAt, debug, roster, pickups, paint };
  },
);

export interface RosterMsg {
  add: RosterEntry[];
  remove: number[];
}
export const Roster = S2C.define<RosterMsg>(
  65,
  "roster",
  (w, m) => {
    w.varu(m.add.length);
    for (const e of m.add) writeRosterEntry(w, e);
    w.varu(m.remove.length);
    for (const id of m.remove) w.u8(id);
  },
  (r) => {
    const add: RosterEntry[] = [];
    for (let i = r.count(MAX_PLAYERS + 32); i > 0; i--) add.push(readRosterEntry(r));
    const remove: number[] = [];
    for (let i = r.count(MAX_PLAYERS + 32); i > 0; i--) remove.push(r.u8());
    return { add, remove };
  },
);

// --- snapshot --------------------------------------------------------------------

/** Sparse field update: field indices + values as read (dq fields: differences unless abs). */
export interface DeltaRec {
  idx: number[];
  vals: number[];
  /** Values are absolute (first send of this entity since the client's MatchInit). */
  abs?: boolean;
}

export const PickupOp = { Remove: 0, Off: 1, On: 2, Add: 3 } as const;

export interface PickupDelta {
  id: number;
  op: number;
  /** For Add. */
  init?: PickupInit;
}

export interface SnapshotMsg {
  tick: number;
  /** Seq of the recipient's last input cmd the server has stepped. */
  ack: number;
  /** Fewest of the recipient's cmds waiting in the server's input buffer over the last 0.5 s. */
  buf: number;
  own: DeltaRec | null;
  players: { id: number; d: DeltaRec }[];
  vehicles: { id: number; d: DeltaRec }[];
  pickups: PickupDelta[];
  events: NetEvent[];
}

export const SnapFlag = { Own: 1, Players: 2, Vehicles: 4, Pickups: 8, Events: 16 } as const;

const WORD = 30;

export function writeDeltaRec<S>(w: Writer, sc: Schema<S>, d: DeltaRec): void {
  const mask = new Array<number>(sc.words).fill(0);
  for (const i of d.idx) mask[(i / WORD) | 0]! += 2 ** (i % WORD);
  if (d.abs) mask[sc.words - 1]! += 2 ** (WORD - 1);
  for (const m of mask) w.varu(m);
  // values go in field order
  const order = d.idx.map((i, k) => [i, d.vals[k]!] as const).sort((a, b) => a[0] - b[0]);
  for (const [i, v] of order) {
    const kind = sc.fields[i]!.kind;
    if (kind === "dq") {
      if (d.abs) w.varu(v);
      else w.vari(v);
    } else writeWire(w, kind, v, null);
  }
}

export function readDeltaRec<S>(r: Reader, sc: Schema<S>): DeltaRec {
  const idx: number[] = [];
  const vals: number[] = [];
  const masks: number[] = [];
  for (let k = 0; k < sc.words; k++) masks.push(r.varu());
  const top = 2 ** (WORD - 1);
  const abs = masks[sc.words - 1]! >= top;
  if (abs) masks[sc.words - 1]! -= top;
  for (let k = 0; k < sc.words; k++) {
    let m = masks[k]!;
    for (let b = 0; m && b < WORD; b++) {
      const bit = 2 ** b;
      if (m % (bit * 2) >= bit) {
        const i = k * WORD + b;
        if (i >= sc.fields.length) throw new RangeError(`${sc.name}: mask bit ${i} out of range`);
        idx.push(i);
        vals.push(readWire(r, sc.fields[i]!.kind, abs));
        m -= bit;
      }
    }
  }
  return { idx, vals, abs };
}

/** Apply a sparse update to a wire array. */
export function applyDeltaRec<S>(sc: Schema<S>, d: DeltaRec, wire: Float64Array): void {
  for (let k = 0; k < d.idx.length; k++) {
    const i = d.idx[k]!;
    wire[i] = sc.fields[i]!.kind === "dq" && !d.abs ? wire[i]! + d.vals[k]! : d.vals[k]!;
  }
}

/** Build an absolute DeltaRec from raw state values (tests / tools). */
export function deltaFromState<S>(sc: Schema<S>, s: S, only?: readonly string[]): DeltaRec {
  const idx: number[] = [];
  const vals: number[] = [];
  sc.fields.forEach((f, i) => {
    if (only && !only.includes(f.name)) return;
    idx.push(i);
    vals.push(quantize(f as never, f.get(s)));
  });
  return { idx, vals, abs: true };
}

export function writePickupDelta(w: Writer, p: PickupDelta): void {
  w.varu(p.id).u8(p.op);
  if (p.op === PickupOp.Add) writePickupInit(w, p.init!);
}

export function readPickupDelta(r: Reader): PickupDelta {
  const id = r.varu();
  const op = r.u8();
  if (op === PickupOp.Add) return { id, op, init: readPickupInit(r) };
  if (op > PickupOp.Add) throw new RangeError(`bad pickup op ${op}`);
  return { id, op };
}

/** Header of a snapshot; the host streams the body with the same layout. */
export function writeSnapshotHeader(w: Writer, tick: number, ack: number, buf: number, flags: number): void {
  w.u32(tick).varu(ack).u8(Math.max(0, Math.min(255, buf))).u8(flags);
}

export function writeSnapshotEvents(w: Writer, tick: number, events: readonly NetEvent[]): void {
  w.varu(events.length);
  for (const e of events) {
    w.u8(Math.max(0, Math.min(255, tick - e.tick)));
    writeEvent(w, e);
  }
}

export const Snapshot = S2C.define<SnapshotMsg>(
  66,
  "snapshot",
  (w, m) => {
    const flags =
      (m.own ? SnapFlag.Own : 0) |
      (m.players.length ? SnapFlag.Players : 0) |
      (m.vehicles.length ? SnapFlag.Vehicles : 0) |
      (m.pickups.length ? SnapFlag.Pickups : 0) |
      (m.events.length ? SnapFlag.Events : 0);
    writeSnapshotHeader(w, m.tick, m.ack, m.buf, flags);
    if (m.own) writeDeltaRec(w, OWN, m.own);
    if (m.players.length) {
      w.varu(m.players.length);
      for (const p of m.players) {
        w.u8(p.id);
        writeDeltaRec(w, REMOTE, p.d);
      }
    }
    if (m.vehicles.length) {
      w.varu(m.vehicles.length);
      for (const v of m.vehicles) {
        w.u8(v.id);
        writeDeltaRec(w, VEHICLE, v.d);
      }
    }
    if (m.pickups.length) {
      w.varu(m.pickups.length);
      for (const p of m.pickups) writePickupDelta(w, p);
    }
    if (m.events.length) writeSnapshotEvents(w, m.tick, m.events);
  },
  (r) => {
    const tick = r.u32();
    const ack = r.varu();
    const buf = r.u8();
    const flags = r.u8();
    const own = flags & SnapFlag.Own ? readDeltaRec(r, OWN) : null;
    const players: SnapshotMsg["players"] = [];
    if (flags & SnapFlag.Players) for (let i = r.count(256); i > 0; i--) players.push({ id: r.u8(), d: readDeltaRec(r, REMOTE) });
    const vehicles: SnapshotMsg["vehicles"] = [];
    if (flags & SnapFlag.Vehicles) for (let i = r.count(256); i > 0; i--) vehicles.push({ id: r.u8(), d: readDeltaRec(r, VEHICLE) });
    const pickups: PickupDelta[] = [];
    if (flags & SnapFlag.Pickups) for (let i = r.count(8192); i > 0; i--) pickups.push(readPickupDelta(r));
    const events: NetEvent[] = [];
    if (flags & SnapFlag.Events) {
      for (let i = r.count(4096); i > 0; i--) {
        const back = r.u8();
        events.push(readEvent(r, tick - back));
      }
    }
    return { tick, ack, buf, own, players, vehicles, pickups, events };
  },
);

// --- debug stats -----------------------------------------------------------------

export interface NetStatsMsg {
  /** Room tick() duration percentiles, ms. */
  tickP50: number;
  tickP95: number;
  tickP99: number;
  tickMax: number;
  /** Mean ms per room tick spent stepping the sim / building snapshots. */
  simMs: number;
  snapMs: number;
  /** Room ticks per second actually run. */
  tickRate: number;
  humans: number;
  bots: number;
  /** This client: bytes/s sent to it, snapshots/s, input buffer depth, starved + dropped cmds/s. */
  bytesOut: number;
  snapsPerSec: number;
  inputDepth: number;
  starved: number;
  dropped: number;
  /** False when the server clock doesn't advance during a tick (Workers freezes timers). */
  clockLive: boolean;
}
export const NetStats = S2C.define<NetStatsMsg>(
  240,
  "netStats",
  (w, m) => {
    w.f32(m.tickP50).f32(m.tickP95).f32(m.tickP99).f32(m.tickMax).f32(m.simMs).f32(m.snapMs).f32(m.tickRate);
    w.u8(m.humans).u8(m.bots).f32(m.bytesOut).f32(m.snapsPerSec).f32(m.inputDepth).f32(m.starved).f32(m.dropped).bool(m.clockLive);
  },
  (r) => ({
    tickP50: r.f32(), tickP95: r.f32(), tickP99: r.f32(), tickMax: r.f32(), simMs: r.f32(), snapMs: r.f32(), tickRate: r.f32(),
    humans: r.u8(), bots: r.u8(), bytesOut: r.f32(), snapsPerSec: r.f32(), inputDepth: r.f32(), starved: r.f32(), dropped: r.f32(), clockLive: r.bool(),
  }),
);
