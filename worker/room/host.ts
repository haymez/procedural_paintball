// MatchHost — the authoritative match on the server, behind the room's
// MatchSim seam (worker/room/match.ts). Pure TS: runs in the Room DO and
// under Node (tests, load tools).
//
// Per room tick (30 Hz):
//   2 × { feed one cmd per human (InputBuffer) and bot (BotController);
//         MatchSim.step(1/60); record lag-comp history; collect events }
//   then one snapshot per connected client (see sendSnapshot):
//     header   sim tick, ack = seq of the client's last stepped cmd
//     own      full float32 state, delta vs what this client last got
//     players  others within 120 m every snapshot, ≤250 m every 3rd, beyond
//              every 6th; a player listed with an empty mask = "unchanged"
//     vehicles within 150 m every snapshot, else every 3rd
//     pickups  add / on / off / remove vs what the client knows
//     events   this tick's events, filtered by interest
//
// Baselines are per client and per entity and are simply "the last values
// sent" — the socket is reliable and ordered. A (re)connecting client gets a
// MatchInit and empty baselines, i.e. a full snapshot next tick.
import {
  DebugCmd,
  DebugOp,
  Input,
  MatchInit,
  NetStats,
  OWN,
  PLAYER_COLORS,
  REMOTE,
  Roster,
  SIM_PER_TICK,
  Snapshot,
  SnapFlag,
  VEHICLE,
  Writer,
  newWire,
  quantizeInto,
  writeDelta,
  writePickupDelta,
  writeSnapshotEvents,
  writeSnapshotHeader,
  PickupOp,
  type DebugCmdMsg,
  type InputMsg,
  type MsgDef,
  type NetEvent,
  type PaintRec,
  type PickupDelta,
  type PickupInit,
  type ResultRow,
  type RosterEntry,
} from "../../shared/net/index";
import { Btn, MatchSim, TICK_DT, createEnv, emptyCmd, type InputCmd, type PlayerState } from "../../shared/sim/index";
import { atan2 } from "../../shared/math/trig";
import { worldChecksum } from "../../shared/world/checksum";
import { generateWorld } from "../../shared/world/generate";
import type { World } from "../../shared/world/types";
import { createBot, type BotController } from "./bots";
import { prepareBotWorld } from "../../shared/bots/brain/index";
import { InputBuffer } from "./inputs";
import { LagComp } from "./lagcomp";
import type { BotSeat, MatchContext, MatchSetup, MatchSim as MatchSeam, SimPlayer } from "./match";

const NEAR = 120;
const MID = 250;
const NEAR_VEH = 150;
const FAR_VEH_EVERY = 3; // room ticks (10 Hz); the client interpolates them with extra delay
const SHOT_RANGE = 170;
const MOVE_FX_RANGE = 100;
const PAINT_KEEP = 600;
const STATS_EVERY = 60; // room ticks (2 s)
const LOG_EVERY = 300; // room ticks (10 s)
const TIMING_WINDOW = 300;

export interface HostOptions {
  /** Accept DebugCmd (local dev only). */
  debug?: boolean;
  /** Pre-generated world (tests / tools skip the ~1 s generation). */
  world?: World;
  /** High-resolution clock for timing, ms. */
  clock?: () => number;
}

interface Client {
  id: number;
  name: string;
  color: number;
  connected: boolean;
  /** Entered (receives snapshots). */
  active: boolean;
  input: InputBuffer;
  own: Float64Array | null;
  remote: Map<number, Float64Array>;
  veh: Map<number, Float64Array>;
  pick: Map<number, boolean>;
  projs: Set<number>;
  bytes: number;
  snaps: number;
}

interface Bot {
  id: number;
  ctl: BotController;
  cmd: InputCmd;
}

/** Pre-encoded snapshot body under the Snapshot id (the host encodes once, streaming). */
const SnapshotRaw: MsgDef<Uint8Array> = {
  id: Snapshot.id,
  name: "snapshot(raw)",
  dir: "s2c",
  write: (w, b) => void w.raw(b),
  read: () => {
    throw new Error("encode-only");
  },
};

export function paletteHex(i: number): number {
  const c = PLAYER_COLORS[((i % PLAYER_COLORS.length) + PLAYER_COLORS.length) % PLAYER_COLORS.length];
  return c ? parseInt(c.hex.slice(1), 16) : 0xffffff;
}

function defaultClock(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export class MatchHost implements MatchSeam {
  sim: MatchSim | null = null;
  world: World | null = null;
  private checksum: number | null = null;
  private lag: LagComp | null = null;
  private setup: MatchSetup | null = null;
  private readonly clients = new Map<number, Client>();
  private readonly bots = new Map<number, Bot>();
  private readonly roster = new Map<number, RosterEntry>();
  private readonly pending: NetEvent[] = [];
  private readonly paint: PaintRec[] = [];
  private readonly w = new Writer(4096);
  private readonly remoteWire = new Map<number, Float64Array>();
  private readonly vehWire = new Map<number, Float64Array>();
  private readonly ownScratch = newWire(OWN);
  private readonly pickDeltas: PickupDelta[] = [];
  private readonly evScratch: NetEvent[] = [];
  private readonly ids: number[] = [];
  private readonly vids: number[] = [];
  private readonly pickIds = new Set<number>();
  private endsAt = 0;
  private roomTick = 0;
  private botMode = 1;
  private disposed = false;
  private readonly clock: () => number;
  // timing
  private readonly tickMs: number[] = [];
  private simAcc = 0;
  private snapAcc = 0;
  private statN = 0;
  private statStart = 0;
  private liveClock = false;
  genMs = 0;

  constructor(
    private readonly ctx: MatchContext,
    private readonly opts: HostOptions = {},
  ) {
    this.clock = opts.clock ?? defaultClock;
  }

  // --- lifecycle ----------------------------------------------------------------

  async onMatchStart(seed: number, setup: MatchSetup): Promise<void> {
    this.setup = setup;
    // Yield to the event loop so the room's "loading" state goes out first.
    await new Promise((r) => setTimeout(r, 0));
    if (this.disposed) return;
    const t0 = this.clock();
    const d0 = Date.now();
    const world = this.opts.world ?? generateWorld(seed, { skipDecor: true });
    const env = createEnv(world);
    this.genMs = this.clock() - t0;
    this.world = world;
    this.checksum = worldChecksum(world);
    // Nav + cover build (~200 ms) happens here, behind the loading screen,
    // rather than on the first tick. Bots added mid-match reuse it.
    prepareBotWorld(world, env.cw);
    const sim = new MatchSim(world, { env, durationSec: setup.settings.matchMinutes * 60 + 10, seed });
    this.sim = sim;
    this.lag = new LagComp(sim);
    sim.lagView = this.lag.hook;
    for (const b of setup.bots) this.addBot(b);
    sim.events.length = 0;
    this.ctx.log(`world #${seed} ready in ${this.genMs.toFixed(0)} ms (wall ${Date.now() - d0} ms), checksum ${this.checksum}`);
  }

  worldChecksum(): number | null {
    return this.checksum;
  }

  onPlayerEnter(p: SimPlayer): void {
    const sim = this.sim;
    if (!sim) return;
    if (!this.endsAt && this.setup) this.endsAt = this.ctx.now() + this.setup.settings.matchMinutes * 60_000;
    let c = this.clients.get(p.id);
    if (!c) {
      c = {
        id: p.id, name: p.name, color: p.color, connected: true, active: false, input: new InputBuffer(),
        own: null, remote: new Map(), veh: new Map(), pick: new Map(), projs: new Set(), bytes: 0, snaps: 0,
      };
      this.clients.set(p.id, c);
    }
    c.connected = true;
    c.active = true;
    c.input.reset();
    if (!sim.player(p.id)) {
      sim.addPlayer(p.id, { name: p.name, color: paletteHex(p.color), isBot: false });
      const entry = { id: p.id, name: p.name, color: p.color, bot: false };
      this.roster.set(p.id, entry);
      this.sendRoster([entry], []);
    }
    this.sendInit(c);
  }

  onPlayerLeave(p: SimPlayer, reason: "left" | "timeout" | "reload"): void {
    const c = this.clients.get(p.id);
    if (reason === "reload") {
      // Keep their blob and score; they re-enter once the world is loaded again.
      if (c) {
        c.active = false;
        c.connected = false;
      }
      return;
    }
    this.clients.delete(p.id);
    this.removeFromSim(p.id);
  }

  onPlayerConnection(p: SimPlayer, connected: boolean): void {
    const c = this.clients.get(p.id);
    if (!c) return;
    c.connected = connected;
    // Messages sent while the socket was down are gone: resync from scratch.
    if (connected && c.active) this.sendInit(c);
  }

  onBotsChanged(bots: BotSeat[]): void {
    const sim = this.sim;
    if (!sim) return;
    const want = new Map(bots.map((b) => [b.id, b]));
    for (const id of [...this.bots.keys()]) if (!want.has(id)) this.removeFromSim(id);
    const changed: RosterEntry[] = [];
    for (const b of bots) {
      if (!this.bots.has(b.id)) {
        this.addBot(b);
        changed.push(this.roster.get(b.id)!);
        continue;
      }
      const r = this.roster.get(b.id);
      if (r && (r.color !== b.color || r.name !== b.name)) {
        r.color = b.color;
        r.name = b.name;
        const info = sim.info.get(b.id);
        if (info) {
          info.color = paletteHex(b.color);
          info.name = b.name;
        }
        changed.push(r);
      }
    }
    if (changed.length) this.sendRoster(changed, []);
  }

  onInput(p: SimPlayer, def: MsgDef<unknown>, msg: unknown): void {
    const c = this.clients.get(p.id);
    if (!c) return;
    if (def === Input) c.input.push(msg as InputMsg);
    else if (def === DebugCmd && this.opts.debug) this.debugCmd(c, msg as DebugCmdMsg);
  }

  results(): ResultRow[] {
    const sim = this.sim;
    if (!sim) return [];
    return sim.results().map((r) => ({
      id: r.id,
      name: r.name,
      color: this.roster.get(r.id)?.color ?? 0,
      bot: r.bot,
      score: r.score,
      deaths: r.deaths,
    }));
  }

  dispose(): void {
    this.disposed = true;
    for (const b of this.bots.values()) b.ctl.dispose?.();
    this.bots.clear();
    this.clients.clear();
    this.sim = null;
    this.lag = null;
  }

  // --- roster ---------------------------------------------------------------------

  private addBot(b: BotSeat): void {
    const sim = this.sim!;
    sim.addPlayer(b.id, { name: b.name, color: paletteHex(b.color), isBot: true });
    const ctl = createBot({ id: b.id, name: b.name, difficulty: this.setup?.settings.difficulty ?? 1, seed: sim.world.seed });
    this.bots.set(b.id, { id: b.id, ctl, cmd: emptyCmd() });
    this.roster.set(b.id, { id: b.id, name: b.name, color: b.color, bot: true });
  }

  private removeFromSim(id: number): void {
    const bot = this.bots.get(id);
    bot?.ctl.dispose?.();
    this.bots.delete(id);
    this.sim?.removePlayer(id);
    this.lag?.forget(id);
    this.remoteWire.delete(id);
    for (const c of this.clients.values()) c.remote.delete(id);
    if (this.roster.delete(id)) this.sendRoster([], [id]);
  }

  private sendRoster(add: RosterEntry[], remove: number[]): void {
    for (const c of this.clients.values()) {
      if (c.active && c.connected) this.ctx.send(c.id, Roster, { add, remove });
    }
  }

  private sendInit(c: Client): void {
    const sim = this.sim!;
    c.own = null;
    c.remote.clear();
    c.veh.clear();
    c.pick.clear();
    c.projs.clear();
    const pickups: PickupInit[] = sim.pickups.map((k) => {
      c.pick.set(k.id, k.active);
      return { id: k.id, kind: k.kind, x: k.x, y: k.y, z: k.z, active: k.active, drop: k.drop };
    });
    this.ctx.send(c.id, MatchInit, {
      you: c.id,
      tick: sim.tick,
      endsAt: this.endsAt,
      debug: !!this.opts.debug,
      roster: [...this.roster.values()],
      pickups,
      paint: this.paint,
    });
  }

  // --- tick -------------------------------------------------------------------------

  tick(tick: number, _dt: number): void {
    const sim = this.sim;
    if (!sim || this.disposed) return;
    this.roomTick = tick;
    const t0 = this.clock();
    for (let s = 0; s < SIM_PER_TICK; s++) this.step(sim);
    const t1 = this.clock();
    this.sendSnapshots(sim);
    this.pending.length = 0;
    const t2 = this.clock();
    this.account(t0, t1, t2);
    if (sim.ended) this.ctx.endMatch();
  }

  private step(sim: MatchSim): void {
    const lag = this.lag!;
    const next = sim.tick + 1;
    for (const c of this.clients.values()) {
      if (!sim.player(c.id)) continue;
      const n = c.input.next();
      if (n.real && Number.isFinite(n.view)) lag.setRewind(c.id, next - n.view);
      sim.applyInput(c.id, n.cmd);
    }
    for (const b of this.bots.values()) sim.applyInput(b.id, this.botCmd(sim, b));
    sim.step(TICK_DT);
    lag.record();
    const t = sim.tick;
    for (const e of sim.events) this.collect(sim, e as NetEvent, t);
    sim.events.length = 0;
  }

  private botCmd(sim: MatchSim, b: Bot): InputCmd {
    const out = b.cmd;
    const p = sim.player(b.id);
    if (this.botMode === 0 || !p) {
      out.seq++;
      out.moveX = 0;
      out.moveZ = 0;
      out.yaw = p?.yaw ?? 0;
      out.pitch = 0;
      out.buttons = p && !p.alive ? Btn.SpawnA : 0;
      return out;
    }
    const c = b.ctl.think(sim, b.id, TICK_DT);
    out.seq = c.seq;
    out.moveX = c.moveX;
    out.moveZ = c.moveZ;
    out.yaw = c.yaw;
    out.pitch = c.pitch;
    out.buttons = this.botMode === 2 ? c.buttons & ~Btn.Fire : c.buttons;
    return out;
  }

  private collect(sim: MatchSim, e: NetEvent, tick: number): void {
    e.tick = tick;
    switch (e.type) {
      case "shot": {
        const p = sim.player(e.pid);
        e.seq = p ? p.shotSeq - 1 : 0;
        break;
      }
      case "splat": {
        this.lag!.endProj(e.proj);
        const color = this.roster.get(e.shooter)?.color ?? 0;
        if (this.paint.length >= PAINT_KEEP) this.paint.shift();
        this.paint.push({ x: e.x, y: e.y, z: e.z, nx: e.nx, ny: e.ny, nz: e.nz, r: e.r, color });
        break;
      }
      case "splash":
      case "projEnd":
        this.lag!.endProj(e.proj);
        break;
      case "join":
      case "leave":
      case "matchEnd":
      case "reload":
      case "reloaded":
      case "empty":
        return; // roster / prediction / room cover these
    }
    this.pending.push(e);
  }

  // --- snapshots ---------------------------------------------------------------------

  private sendSnapshots(sim: MatchSim): void {
    for (const p of sim.players) {
      let wv = this.remoteWire.get(p.id);
      if (!wv) this.remoteWire.set(p.id, (wv = newWire(REMOTE)));
      quantizeInto(REMOTE, p, wv);
    }
    for (const v of sim.vehicles) {
      let wv = this.vehWire.get(v.id);
      if (!wv) this.vehWire.set(v.id, (wv = newWire(VEHICLE)));
      quantizeInto(VEHICLE, v, wv);
    }
    this.pickIds.clear();
    for (const k of sim.pickups) this.pickIds.add(k.id);
    for (const c of this.clients.values()) {
      if (!c.active || !c.connected) continue;
      const me = sim.player(c.id);
      if (me) this.sendSnapshot(sim, c, me);
    }
  }

  private sendSnapshot(sim: MatchSim, c: Client, me: PlayerState): void {
    const rt = this.roomTick;
    // players
    const ids = this.ids;
    ids.length = 0;
    for (const p of sim.players) {
      if (p.id === c.id) continue;
      const dx = p.x - me.x, dz = p.z - me.z;
      const d2 = dx * dx + dz * dz;
      const every = d2 < NEAR * NEAR ? 1 : d2 < MID * MID ? 3 : 6;
      if (every > 1 && c.remote.has(p.id) && (rt + p.id) % every !== 0) continue;
      ids.push(p.id);
    }
    // vehicles
    const vids = this.vids;
    vids.length = 0;
    for (const v of sim.vehicles) {
      const dx = v.x - me.x, dz = v.z - me.z;
      const near = dx * dx + dz * dz < NEAR_VEH * NEAR_VEH || v.seats.includes(c.id);
      if (!near && c.veh.has(v.id) && (rt + v.id) % FAR_VEH_EVERY !== 0) continue;
      vids.push(v.id);
    }
    // pickups
    const pd = this.pickDeltas;
    pd.length = 0;
    for (const k of sim.pickups) {
      const known = c.pick.get(k.id);
      if (known === undefined) {
        pd.push({ id: k.id, op: PickupOp.Add, init: { id: k.id, kind: k.kind, x: k.x, y: k.y, z: k.z, active: k.active, drop: k.drop } });
        c.pick.set(k.id, k.active);
      } else if (known !== k.active) {
        pd.push({ id: k.id, op: k.active ? PickupOp.On : PickupOp.Off });
        c.pick.set(k.id, k.active);
      }
    }
    if (c.pick.size > this.pickIds.size) {
      for (const id of c.pick.keys()) {
        if (!this.pickIds.has(id)) {
          pd.push({ id, op: PickupOp.Remove });
          c.pick.delete(id);
        }
      }
    }
    // events
    const ev = this.evScratch;
    ev.length = 0;
    for (const e of this.pending) if (this.wants(c, me, e)) ev.push(e);

    const flags =
      SnapFlag.Own |
      (ids.length ? SnapFlag.Players : 0) |
      (vids.length ? SnapFlag.Vehicles : 0) |
      (pd.length ? SnapFlag.Pickups : 0) |
      (ev.length ? SnapFlag.Events : 0);
    const w = this.w.reset();
    writeSnapshotHeader(w, sim.tick, c.input.lastApplied, c.input.reportDepth, flags);
    quantizeInto(OWN, me, this.ownScratch);
    if (!c.own) {
      writeDelta(w, OWN, this.ownScratch, null);
      c.own = this.ownScratch.slice();
    } else writeDelta(w, OWN, this.ownScratch, c.own);
    if (ids.length) {
      w.varu(ids.length);
      for (const id of ids) {
        w.u8(id);
        const cur = this.remoteWire.get(id)!;
        const base = c.remote.get(id);
        if (!base) {
          writeDelta(w, REMOTE, cur, null);
          c.remote.set(id, cur.slice());
        } else writeDelta(w, REMOTE, cur, base);
      }
    }
    if (vids.length) {
      w.varu(vids.length);
      for (const id of vids) {
        w.u8(id);
        const cur = this.vehWire.get(id)!;
        const base = c.veh.get(id);
        if (!base) {
          writeDelta(w, VEHICLE, cur, null);
          c.veh.set(id, cur.slice());
        } else writeDelta(w, VEHICLE, cur, base);
      }
    }
    if (pd.length) {
      w.varu(pd.length);
      for (const p of pd) writePickupDelta(w, p);
    }
    if (ev.length) writeSnapshotEvents(w, sim.tick, ev);
    const body = w.view();
    if (this.ctx.send(c.id, SnapshotRaw, body)) {
      c.bytes += body.length + 1;
      c.snaps++;
    }
  }

  /** Interest filter for events. */
  private wants(c: Client, me: PlayerState, e: NetEvent): boolean {
    switch (e.type) {
      case "shot": {
        if (e.pid !== c.id) {
          const dx = e.x - me.x, dz = e.z - me.z;
          if (dx * dx + dz * dz > SHOT_RANGE * SHOT_RANGE) return false;
        }
        c.projs.add(e.proj);
        return true;
      }
      case "splat":
        c.projs.delete(e.proj);
        return true; // paint persists: everyone gets every splat
      case "splash":
      case "projEnd":
        return c.projs.delete(e.proj);
      case "move": {
        if (e.pid === c.id) return false; // predicted locally
        const dx = e.x - me.x, dz = e.z - me.z;
        return dx * dx + dz * dz < MOVE_FX_RANGE * MOVE_FX_RANGE;
      }
      case "spawnChoices":
        return e.pid === c.id;
      default:
        return true;
    }
  }

  // --- stats -------------------------------------------------------------------------

  private account(t0: number, t1: number, t2: number): void {
    const dt = t2 - t0;
    if (dt > 0) this.liveClock = true;
    if (this.tickMs.length >= TIMING_WINDOW) this.tickMs.shift();
    this.tickMs.push(dt);
    this.simAcc += t1 - t0;
    this.snapAcc += t2 - t1;
    this.statN++;
    if (!this.statStart) this.statStart = this.ctx.now();
    if (this.statN % STATS_EVERY !== 0) return;
    const now = this.ctx.now();
    const secs = Math.max(0.001, (now - this.statStart) / 1000);
    const sorted = this.tickMs.slice().sort((a, b) => a - b);
    const pct = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
    const base = {
      tickP50: pct(0.5),
      tickP95: pct(0.95),
      tickP99: pct(0.99),
      tickMax: sorted[sorted.length - 1] ?? 0,
      simMs: this.simAcc / STATS_EVERY,
      snapMs: this.snapAcc / STATS_EVERY,
      tickRate: STATS_EVERY / secs,
      humans: this.clients.size,
      bots: this.bots.size,
      clockLive: this.liveClock,
    };
    let bytesMax = 0, bytesSum = 0, n = 0;
    for (const c of this.clients.values()) {
      const bps = c.bytes / secs;
      const st = c.input.takeStats();
      if (this.opts.debug && c.active && c.connected) {
        this.ctx.send(c.id, NetStats, { ...base, bytesOut: bps, snapsPerSec: c.snaps / secs, inputDepth: st.depth, starved: st.starved / secs, dropped: st.dropped / secs });
      }
      if (c.active) { bytesMax = Math.max(bytesMax, bps); bytesSum += bps; n++; }
      c.bytes = 0;
      c.snaps = 0;
    }
    if (this.statN % LOG_EVERY === 0) {
      this.ctx.log(
        `tick p50 ${base.tickP50.toFixed(2)} p95 ${base.tickP95.toFixed(2)} p99 ${base.tickP99.toFixed(2)} max ${base.tickMax.toFixed(2)} ms` +
          ` (sim ${base.simMs.toFixed(2)} snap ${base.snapMs.toFixed(2)}) · ${base.tickRate.toFixed(1)} Hz · ${n} clients` +
          ` ${(bytesSum / Math.max(1, n) / 1024).toFixed(1)} KB/s avg ${(bytesMax / 1024).toFixed(1)} max · ${this.bots.size} bots` +
          (this.liveClock ? "" : " (clock frozen during ticks)"),
      );
    }
    this.simAcc = 0;
    this.snapAcc = 0;
    this.statStart = now;
  }

  // --- debug --------------------------------------------------------------------------

  private debugCmd(c: Client, m: DebugCmdMsg): void {
    const sim = this.sim;
    if (!sim) return;
    const me = sim.player(c.id);
    switch (m.op) {
      case DebugOp.Teleport:
        sim.teleport(c.id, m.a, Number.isFinite(m.c) ? m.c : NaN, m.b);
        break;
      case DebugOp.Bots:
        this.botMode = Math.max(0, Math.min(2, Math.round(m.a)));
        break;
      case DebugOp.Summon: {
        const t = sim.player(Math.round(m.a));
        if (!me || !t || t === me) return;
        const yaw = me.yaw;
        const x = me.x + Math.sin(yaw) * m.b, z = me.z + Math.cos(yaw) * m.b;
        sim.teleport(t.id, x, NaN, z);
        t.yaw = atan2(me.x - t.x, me.z - t.z);
        t.shield = 0;
        break;
      }
      case DebugOp.NoShield:
        if (me) me.shield = 0;
        break;
    }
  }

  // --- introspection (tests / tools) ---------------------------------------------------

  inputOf(id: number): InputBuffer | undefined {
    return this.clients.get(id)?.input;
  }
  get lagComp(): LagComp | null {
    return this.lag;
  }
  /** Room time when the match ends (ms). */
  get endTime(): number {
    return this.endsAt;
  }
  get tickDurations(): readonly number[] {
    return this.tickMs;
  }
}
