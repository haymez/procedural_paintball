// NetClient — the networked match as the renderer sees it. DOM-free (tests
// drive it under Node); RemoteSource (remote.ts) adapts it to GameSource.
//
//   own player   predicted every client tick with the same InputCmds that go
//                to the server (quantized first); each snapshot restores the
//                authoritative state and replays the unacked cmds. The visual
//                difference is folded into an offset that decays over ~100 ms
//                (the collision state itself is never smoothed).
//   own shots    predicted: ball + muzzle flash at once, splats on walls at
//                once; the server's shot event (pid, shotSeq) links the
//                server ball id to the predicted one and duplicates are dropped.
//   others       interpolated at SnapClock.renderTick (see interp.ts).
//   their balls  appear when their shooter visibly fires (render time), then
//                catch up to real time over 0.25 s, so impacts line up.
//   events       dispatched in order, each when it becomes visible: remote
//                shots/moves at render time, impacts when the ball gets there;
//                anything that happens *to me* flushes the queue at once.
import {
  BALL_GRAVITY, BALL_LIFE, BALL_RADIUS, HIT_R, HULL, SEATS, INTERACT_R, Move, NO_WATER_Y, TICK_DT, VEHICLE_NAMES, ZIP_FEET, ZIP_GRAB_R,
  ZIP_START_SPEED, copyPlayerState, createPlayerState, seatWorld, segCapsule, waterAt, zipPoint,
  type InputCmd, type InteractTarget, type PickupState, type PlayerInfo, type PlayerState, type ProjectileState, type SimEnv,
  type SimEvent, type SimSnapshot, type VehicleState,
} from "../../../../shared/sim/index";
import { raycast } from "../../../../shared/world/collide";
import { VehicleKind, type World } from "../../../../shared/world/types";
import { atan2, cos, sin } from "../../../../shared/math/trig";
import {
  Input, OWN, PLAYER_COLORS, PickupOp, REMOTE, VEHICLE, applyDeltaRec, applyWire, newWire, quantizeCmd,
  type MatchInitMsg, type MsgDef, type NetEvent, type NetStatsMsg, type PaintRec, type RosterMsg, type SnapshotMsg,
} from "../../../../shared/net/index";
import { SnapClock } from "./clock";
import { RemotePlayer, RemoteVehicle, copyVehicle } from "./interp";
import { predictStep, type StepOut } from "./predict";

const _zp = { x: 0, y: 0, z: 0 };

export interface NetLink {
  send<T>(def: MsgDef<T>, msg: T): boolean;
  /** Local monotonic clock, ms. */
  now(): number;
  /** Estimated server clock, ms (match timer). */
  serverNow(): number;
  /** Match end (server ms) if the room told us. */
  endsAt(): number | null;
}

const SEND_EVERY = 2; // client ticks per Input message (~33 ms)
const REDUNDANT = 2;
const MAX_UNACKED = 180;
const CATCHUP = 0.25; // s: remote balls converge from render time to real time
const QUEUE_TIMEOUT = 350; // ms
const OWN_SMOOTH = 0.06; // s (error decay time constant)
const SNAP_OWN = 4; // m: bigger corrections snap
// Input clock: run a few % fast/slow so the server holds 1–3 of our cmds.
const BUF_LOW = 1;
const BUF_HIGH = 3;
const RATE_FAST = 1.04;
const RATE_SLOW = 0.97;

const C_NOW = 0, C_RENDER = 1, C_BALL = 2;

interface Ball {
  /** Display id (Actors key): server proj id, or -(shotSeq+1) for predicted own balls. */
  id: number;
  own: boolean;
  seq: number;
  serverId: number;
  owner: number;
  x0: number; y0: number; z0: number;
  vx: number; vy: number; vz: number;
  /** Remote: sim tick at which age = 0. */
  tick0: number;
  /** Own: seconds since launch. */
  age: number;
  shown: boolean;
  /** Show at real time (no catch-up): unpredicted own shots. */
  present: boolean;
  ended: boolean;
  ex: number; ey: number; ez: number;
  st: ProjectileState;
}

interface Queued {
  e: SimEvent;
  cond: number;
  tick: number;
  ball: Ball | null;
  impactAge: number;
  t: number;
  urgent: boolean;
}

interface RemoteEntry {
  wire: Float64Array;
  state: PlayerState;
  rp: RemotePlayer;
}

interface VehEntry {
  wire: Float64Array;
  state: VehicleState;
  rv: RemoteVehicle;
}

export interface NetClientStats {
  snapsPerSec: number;
  interpDelayMs: number;
  renderLagMs: number;
  jitterMs: number;
  corrPerSec: number;
  corrAvgCm: number;
  corrMaxCm: number;
  unacked: number;
  remoteJerkMm: number;
  extrapolating: number;
  queue: number;
  server: NetStatsMsg | null;
}

export interface NetTotals {
  ticks: number;
  snapshots: number;
  corrections: number;
  corrSum: number;
  corrMax: number;
  bigCorrections: number;
  jerkSum: number;
  jerkN: number;
  shotsPredicted: number;
  shotsConfirmed: number;
  shotsUnpredicted: number;
  hitsOnMe: number;
  hitsByMe: number;
  /** Correction sizes: < 2 cm, < 10 cm, < 30 cm, larger. */
  corrHist: number[];
}

export class NetClient {
  readonly snap: SimSnapshot;
  readonly clock = new SnapClock();
  /** MatchInit + first snapshot processed. */
  ready = false;
  inited = false;
  debugAllowed = false;
  /** Paint that was on the island before we arrived (the game applies and clears it). */
  paintInit: { x: number; y: number; z: number; nx: number; ny: number; nz: number; r: number; color: number }[] = [];
  renderTick = 0;
  presentTick = 0;
  stats: NetClientStats = {
    snapsPerSec: 0, interpDelayMs: 0, renderLagMs: 0, jitterMs: 0, corrPerSec: 0, corrAvgCm: 0, corrMaxCm: 0, unacked: 0,
    remoteJerkMm: 0, extrapolating: 0, queue: 0, server: null,
  };
  readonly totals: NetTotals = {
    ticks: 0, snapshots: 0, corrections: 0, corrSum: 0, corrMax: 0, bigCorrections: 0, jerkSum: 0, jerkN: 0,
    shotsPredicted: 0, shotsConfirmed: 0, shotsUnpredicted: 0, hitsOnMe: 0, hitsByMe: 0, corrHist: [0, 0, 0, 0],
  };

  private endsAtInit = 0;
  private readonly colors = new Map<number, number>();
  private readonly info = new Map<number, PlayerInfo>();
  private readonly paletteOf = new Map<number, number>();
  // own
  private readonly ownWire = newWire(OWN);
  readonly auth: PlayerState;
  readonly pred: PlayerState;
  private readonly display: PlayerState;
  private predVeh: VehicleState | null = null;
  private predVehObj: VehicleState | null = null;
  private ownKnown = false;
  private ack = 0;
  private readonly cmds: InputCmd[] = [];
  private readonly views = new Map<number, number>();
  private readonly fresh: InputCmd[] = [];
  private sentUpTo = 0; // highest seq sent
  /** Our own cmd numbering (the server's guesses can move it forward). */
  private seqCounter = 0;
  private needReconcile = false;
  private ox = 0; private oy = 0; private oz = 0;
  // others
  private readonly remotes = new Map<number, RemoteEntry>();
  private readonly vehicles = new Map<number, VehEntry>();
  private readonly pickups = new Map<number, PickupState>();
  private readonly balls = new Map<number, Ball>();
  private readonly ownBySeq = new Map<number, Ball>();
  private readonly ownByServer = new Map<number, Ball>();
  private readonly queue: Queued[] = [];
  /** My balls that visibly hit someone here, awaiting the server's verdict. */
  private readonly predHits: { target: number; t: number }[] = [];
  private readonly out: SimEvent[] = [];
  private readonly others: PlayerState[] = [];
  /** Last few corrections (debugging): tick, size (cm), move state, seq acked. */
  readonly corrLog: { tick: number; cm: number; move: number; ack: number; replayed: number }[] = [];
  /** Input clock speed (cmds per 1/60 s); the game ticks every tickDt. */
  private rate = 1;
  /** Server's reported input buffer depth. */
  serverBuf = 0;
  private listsDirty = true;
  private tickN = 0;
  private readonly stepOut: StepOut = { events: [], shots: [] };
  // stats window
  private winStart = 0;
  private winSnaps = 0;
  private winCorr = 0;
  private winCorrSum = 0;
  private winCorrMax = 0;

  constructor(
    readonly world: World,
    readonly env: SimEnv,
    readonly localId: number,
    private readonly link: NetLink,
  ) {
    this.auth = createPlayerState(localId);
    this.pred = createPlayerState(localId);
    this.display = createPlayerState(localId);
    const self = this;
    this.snap = {
      get tick() { return Math.floor(self.presentTick); },
      get time() { return self.presentTick / 60; },
      get timeLeft() { return Math.max(0, ((self.link.endsAt() ?? self.endsAtInit) - self.link.serverNow()) / 1000); },
      ended: false,
      players: [],
      info: this.info,
      projectiles: [],
      pickups: [],
      vehicles: [],
      ziplines: env.ziplines,
      spawns: world.spawns,
    };
    world.vehicles.forEach((v, i) => {
      // placeholder until the first snapshot says where it is
      const st: VehicleState = {
        id: i, kind: v.kind, x: v.x, y: v.y, z: v.z, yaw: v.rotY, speed: 0, vy: 0, steer: 0, throttle: 0, pitch: 0, airborne: false,
        seats: SEATS[v.kind].map(() => -1), idle: 0, sx: v.x, sy: v.y, sz: v.z, syaw: v.rotY,
      };
      this.vehicles.set(i, { wire: newWire(VEHICLE), state: st, rv: new RemoteVehicle(i, st) });
    });
  }

  // --- inbound ----------------------------------------------------------------------

  onInit(m: MatchInitMsg): void {
    // (Re)entry: forget everything that was built on the old stream.
    for (const b of this.balls.values()) if (b.shown || b.own) this.out.push({ type: "projEnd", proj: b.id });
    this.balls.clear();
    this.ownBySeq.clear();
    this.ownByServer.clear();
    this.queue.length = 0;
    this.predHits.length = 0;
    this.remotes.clear();
    this.ownKnown = false;
    this.ready = false;
    this.inited = true;
    this.debugAllowed = m.debug;
    this.endsAtInit = m.endsAt;
    this.info.clear();
    this.onRoster({ add: m.roster, remove: [] });
    this.pickups.clear();
    for (const k of m.pickups) this.pickups.set(k.id, { id: k.id, kind: k.kind, x: k.x, y: k.y, z: k.z, active: k.active, respawn: 0, drop: k.drop, ttl: 0 });
    this.paintInit = m.paint.map((p: PaintRec) => ({ ...p, color: hexOf(p.color) }));
    this.listsDirty = true;
  }

  onRoster(m: RosterMsg): void {
    for (const e of m.add) {
      const hex = hexOf(e.color);
      this.colors.set(e.id, hex);
      this.paletteOf.set(e.id, e.color);
      this.info.set(e.id, { id: e.id, name: e.name, color: hex, isBot: e.bot });
    }
    for (const id of m.remove) {
      this.info.delete(id);
      this.remotes.delete(id);
    }
    this.listsDirty = true;
  }

  onStats(m: NetStatsMsg): void {
    this.stats.server = m;
  }

  onSnapshot(m: SnapshotMsg, arrivalMs = this.link.now()): void {
    if (!this.inited) return;
    this.clock.arrive(m.tick, arrivalMs);
    this.totals.snapshots++;
    this.winSnaps++;
    if (m.own) {
      applyDeltaRec(OWN, m.own, this.ownWire);
      applyWire(OWN, this.ownWire, this.auth);
      this.auth.id = this.localId;
      this.fillCoats(this.auth);
      this.ownKnown = true;
    }
    this.ack = m.ack;
    // The server stood in for cmds we hadn't made yet (we stalled): continue
    // after its timeline, or everything we send next would be skipped as late.
    if (m.ack > this.seqCounter) this.seqCounter = m.ack;
    this.serverBuf = m.buf;
    const want = m.buf < BUF_LOW ? RATE_FAST : m.buf > BUF_HIGH ? RATE_SLOW : 1;
    this.rate += (want - this.rate) * 0.15;
    this.needReconcile = true;
    for (const { id, d } of m.players) {
      let r = this.remotes.get(id);
      if (!r) {
        r = { wire: newWire(REMOTE), state: createPlayerState(id), rp: new RemotePlayer(id) };
        this.remotes.set(id, r);
        this.listsDirty = true;
      }
      applyDeltaRec(REMOTE, d, r.wire);
      applyWire(REMOTE, r.wire, r.state);
      this.fillCoats(r.state);
      r.rp.push(m.tick, r.state);
    }
    for (const { id, d } of m.vehicles) {
      const v = this.vehicles.get(id);
      if (!v) continue;
      applyDeltaRec(VEHICLE, d, v.wire);
      applyWire(VEHICLE, v.wire, v.state);
      v.rv.push(m.tick, v.state);
    }
    for (const p of m.pickups) {
      if (p.op === PickupOp.Add && p.init) {
        const k = p.init;
        this.pickups.set(k.id, { id: k.id, kind: k.kind, x: k.x, y: k.y, z: k.z, active: k.active, respawn: 0, drop: k.drop, ttl: 0 });
        this.listsDirty = true;
      } else if (p.op === PickupOp.Remove) {
        this.pickups.delete(p.id);
        this.listsDirty = true;
      } else {
        const k = this.pickups.get(p.id);
        if (k) k.active = p.op === PickupOp.On;
      }
    }
    for (const e of m.events) this.enqueue(e);
    if (!this.ready && this.ownKnown) {
      this.ready = true;
      this.reconcile();
      this.ox = this.oy = this.oz = 0;
      this.updateOwnDisplay(0);
      this.renderTick = this.clock.renderTick;
      this.presentTick = this.clock.present(arrivalMs);
    }
  }

  // --- outbound -----------------------------------------------------------------------

  /** The local player's cmd for the next tick (copied and quantized). */
  input(cmd: InputCmd): void {
    const c = quantizeCmd({ ...cmd });
    this.fresh.push(c);
  }

  // --- the fixed tick -----------------------------------------------------------------

  tick(): void {
    if (!this.ready) {
      this.fresh.length = 0;
      return;
    }
    const now = this.link.now();
    const dt = TICK_DT;
    this.tickN++;
    this.totals.ticks++;
    if (this.needReconcile) this.reconcile();
    this.renderTick = this.clock.advance(now);
    this.presentTick = this.clock.present(now);
    if (this.listsDirty) this.rebuildLists();

    // others at render time
    const rt = this.renderTick;
    let extrap = 0;
    for (const r of this.remotes.values()) {
      const d = r.rp.update(rt, dt);
      d.waterY = waterAt(this.env, d.x, d.z);
      if (r.rp.extrapolating) extrap++;
    }
    for (const v of this.vehicles.values()) v.rv.update(rt);
    this.stats.extrapolating = extrap;

    // predict this tick's cmd(s)
    const so = this.stepOut;
    for (const c of this.fresh) {
      c.seq = ++this.seqCounter;
      so.events.length = 0;
      so.shots.length = 0;
      this.views.set(c.seq, rt);
      predictStep(this.pred, c, this.drivingVeh(), this.env, this.others, so, this.predictInteract);
      this.cmds.push(c);
      for (const e of so.events) this.out.push(e);
      for (const s of so.shots) this.spawnOwnBall(s.seq, s.x, s.y, s.z, s.vx, s.vy, s.vz);
    }
    this.fresh.length = 0;
    while (this.cmds.length > MAX_UNACKED) {
      this.views.delete(this.cmds[0]!.seq);
      this.cmds.shift();
    }
    // the vehicle I drive is shown where I predict it
    if (this.predVeh) {
      const v = this.vehicles.get(this.predVeh.id);
      if (v) copyVehicle(this.predVeh, v.rv.display);
    }

    this.stepBalls(dt);
    if (this.tickN % SEND_EVERY === 0) this.sendInputs();
    this.pump(now);
    this.updateOwnDisplay(dt);
    this.windowStats(now);
  }

  /**
   * After a stall (hidden tab, a long freeze): the cmds we predicted went out
   * late or never and the server stood in for us, so replaying them would only
   * produce a string of corrections. Forget them, restart from the latest
   * authoritative state, snap remote interpolation to the present and drop the
   * stale cosmetic events that piled up (paint, eliminations, respawns stay).
   */
  resync(): void {
    if (!this.ready) return;
    this.fresh.length = 0;
    this.cmds.length = 0;
    this.views.clear();
    if (this.ack > this.seqCounter) this.seqCounter = this.ack;
    this.sentUpTo = this.seqCounter;
    this.rate = 1;
    this.predVeh = null;
    this.needReconcile = true;
    this.reconcile();
    for (const r of this.remotes.values()) r.rp.resetSmoothing();
    const keep: Queued[] = [];
    for (const q of this.queue) {
      const t = q.e.type;
      const stale = t === "shot" || t === "move" || t === "splash" || t === "projEnd" || t === "vehicleBump" ||
        ((t === "hit" || t === "shield" || t === "vest") && !q.urgent);
      if (!stale) { keep.push(q); continue; }
      const b = q.ball;
      if (b && !b.own && t !== "shot" && !b.ended) this.endBall(b, b.shown ? { type: "projEnd", proj: b.id } : null);
    }
    this.queue.length = 0;
    // a backlog of splats still has to reach the island, but not hundreds in one frame
    let splats = 0;
    for (let i = keep.length - 1; i >= 0; i--) {
      const q = keep[i]!;
      if (q.e.type !== "splat" || ++splats <= 120) continue;
      const b = q.ball;
      if (b && !b.own && !b.ended) this.endBall(b, b.shown ? { type: "projEnd", proj: b.id } : null);
      keep.splice(i, 1);
    }
    for (const q of keep) this.queue.push(q);
    this.updateOwnDisplay(0);
  }

  drain(out: SimEvent[]): void {
    for (const e of this.out) out.push(e);
    this.out.length = 0;
  }

  /** Real seconds between client ticks (the sim step is always TICK_DT). */
  get tickDt(): number {
    return TICK_DT / this.rate;
  }

  me(): PlayerState | undefined {
    return this.ready ? this.pred : undefined;
  }

  // --- prediction -----------------------------------------------------------------------

  private drivingVeh(): VehicleState | null {
    const p = this.pred;
    if (p.alive && p.move === Move.Vehicle && p.seat === 0 && p.vehicle >= 0) {
      if (!this.predVeh || this.predVeh.id !== p.vehicle) {
        const v = this.vehicles.get(p.vehicle);
        if (!v) return null;
        this.predVehObj ??= { ...v.state, seats: v.state.seats.slice() };
        this.predVeh = copyVehicle(v.state, this.predVehObj);
      }
      return this.predVeh;
    }
    this.predVeh = null;
    return null;
  }

  /**
   * E, predicted where the outcome can't be contested: grabbing a zipline
   * (static, one rider per line isn't a rule) and taking the driver's seat of
   * a parked, empty vehicle. Everything else waits for the server.
   */
  private readonly predictInteract = (p: PlayerState, out: StepOut | null): void => {
    const t = this.interactFor(p, true);
    if (!t) return;
    if (t.kind === "zip") {
      const z = this.env.ziplines[t.id];
      if (!z) return;
      p.zip = t.id;
      p.zipT = 0.01;
      p.zipV = ZIP_START_SPEED;
      p.move = Move.Zipline;
      p.moveT = 0;
      p.grounded = false;
      zipPoint(z, p.zipT, _zp);
      p.x = _zp.x; p.y = _zp.y - ZIP_FEET; p.z = _zp.z;
      if (out) { out.events.push({ type: "zipStart", pid: p.id, zip: t.id }); this.predInteract = { type: "zipStart", t: this.link.now() }; }
    } else if (t.kind === "vehicle" && t.seat === 0) {
      const v = this.vehicles.get(t.id)?.state;
      if (!v || Math.abs(v.speed) > 0.3 || v.airborne || v.seats.some((s) => s >= 0)) return;
      p.vehicle = v.id;
      p.seat = 0;
      p.move = Move.Vehicle;
      p.moveT = 0;
      p.vx = 0; p.vy = 0; p.vz = 0;
      if (p.reload > 0) p.reload = 0;
      seatWorld(v, 0, _zp);
      p.x = _zp.x; p.y = _zp.y; p.z = _zp.z;
      if (out) { out.events.push({ type: "vehicleEnter", pid: p.id, vehicle: v.id, seat: 0 }); this.predInteract = { type: "vehicleEnter", t: this.link.now() }; }
    }
  };
  private predInteract: { type: string; t: number } | null = null;

  private reconcile(): void {
    this.needReconcile = false;
    if (!this.ownKnown) return;
    const p = this.pred;
    const bx = p.x, by = p.y, bz = p.z, wasAlive = p.alive, hadState = this.ready;
    while (this.cmds.length && this.cmds[0]!.seq <= this.ack) {
      this.views.delete(this.cmds[0]!.seq);
      this.cmds.shift();
    }
    copyPlayerState(this.auth, p);
    p.id = this.localId;
    this.predVeh = null;
    const veh = this.drivingVeh();
    if (veh) {
      const v = this.vehicles.get(veh.id);
      if (v) copyVehicle(v.state, veh);
    }
    // (drivingVeh per step: a replayed E can put us in a seat mid-replay)
    for (const c of this.cmds) predictStep(p, c, this.drivingVeh(), this.env, this.others, null, this.predictInteract);
    if (!hadState) return;
    const ex = bx - p.x, ey = by - p.y, ez = bz - p.z;
    const mag = Math.sqrt(ex * ex + ey * ey + ez * ez);
    if (!wasAlive || !p.alive || mag > SNAP_OWN) {
      this.ox = this.oy = this.oz = 0;
      if (wasAlive && p.alive) this.totals.bigCorrections++;
      return;
    }
    if (mag > 0.002) {
      this.ox += ex; this.oy += ey; this.oz += ez;
      this.totals.corrections++;
      this.totals.corrSum += mag;
      this.totals.corrMax = Math.max(this.totals.corrMax, mag);
      this.totals.corrHist[mag < 0.02 ? 0 : mag < 0.1 ? 1 : mag < 0.3 ? 2 : 3]!++;
      this.winCorr++;
      this.winCorrSum += mag;
      this.winCorrMax = Math.max(this.winCorrMax, mag);
      this.corrLog.push({ tick: Math.round(this.presentTick), cm: +(mag * 100).toFixed(2), move: p.move, ack: this.ack, replayed: this.cmds.length });
      if (this.corrLog.length > 20) this.corrLog.shift();
    }
  }

  private updateOwnDisplay(dt: number): void {
    const k = dt > 0 ? Math.exp(-dt / OWN_SMOOTH) : 1;
    this.ox *= k; this.oy *= k; this.oz *= k;
    if (Math.abs(this.ox) + Math.abs(this.oy) + Math.abs(this.oz) < 1e-4) this.ox = this.oy = this.oz = 0;
    const d = copyPlayerState(this.pred, this.display);
    d.x += this.ox; d.y += this.oy; d.z += this.oz;
  }

  private sendInputs(): void {
    const unsent = this.cmds.filter((c) => c.seq > this.sentUpTo);
    if (!unsent.length) return;
    let start = this.cmds.indexOf(unsent[0]!);
    start = Math.max(0, start - REDUNDANT);
    const batch = this.cmds.slice(start);
    const newest = batch[batch.length - 1]!;
    const ok = this.link.send(Input, { seq: batch[0]!.seq, cmds: batch, view: this.views.get(newest.seq) ?? this.renderTick });
    if (ok) this.sentUpTo = newest.seq;
  }

  // --- balls ------------------------------------------------------------------------------

  private newBall(id: number, owner: number, x: number, y: number, z: number, vx: number, vy: number, vz: number): Ball {
    return {
      id, own: false, seq: -1, serverId: id, owner, x0: x, y0: y, z0: z, vx, vy, vz, tick0: 0, age: 0, shown: false, present: false,
      ended: false, ex: 0, ey: 0, ez: 0,
      st: { id, owner, color: this.colors.get(owner) ?? 0xffffff, x, y, z, vx, vy, vz, age: 0 },
    };
  }

  private spawnOwnBall(seq: number, x: number, y: number, z: number, vx: number, vy: number, vz: number): void {
    const id = -(seq + 1);
    const old = this.ownBySeq.get(seq);
    if (old) this.endBall(old, { type: "projEnd", proj: old.id });
    const b = this.newBall(id, this.localId, x, y, z, vx, vy, vz);
    b.own = true;
    b.seq = seq;
    b.serverId = 0;
    b.shown = true;
    this.balls.set(id, b);
    this.ownBySeq.set(seq, b);
    (this.snap.projectiles as ProjectileState[]).push(b.st);
    this.totals.shotsPredicted++;
    this.out.push({ type: "shot", pid: this.localId, proj: id, x, y, z, vx, vy, vz, color: b.st.color });
  }

  private endBall(b: Ball, e: SimEvent | null): void {
    if (b.ended && !e) return;
    b.ended = true;
    b.ex = b.st.x; b.ey = b.st.y; b.ez = b.st.z;
    const list = this.snap.projectiles as ProjectileState[];
    const i = list.indexOf(b.st);
    if (i >= 0) list.splice(i, 1);
    if (!b.own) this.balls.delete(b.id);
    if (e) this.out.push(e);
  }

  /** Remote ball age as displayed: render time, catching up to real time. */
  private displayAge(b: Ball): number {
    const ageP = (this.presentTick - b.tick0) / 60;
    if (b.present) return ageP;
    const ageR = (this.renderTick - b.tick0) / 60;
    const k = Math.max(0, Math.min(1, ageR / CATCHUP));
    return Math.max(0, ageR + (ageP - ageR) * k);
  }

  private stepBalls(dt: number): void {
    const g = BALL_GRAVITY;
    for (const b of [...this.balls.values()]) {
      if (b.ended) {
        if (b.own && b.age > BALL_LIFE + 3) this.forgetOwn(b);
        b.age += dt;
        continue;
      }
      if (!b.shown) continue;
      if (b.own) {
        const a0 = b.age, a1 = b.age + dt;
        b.age = a1;
        const ox = b.x0 + b.vx * a0, oy = b.y0 + b.vy * a0 - 0.5 * g * a0 * a0, oz = b.z0 + b.vz * a0;
        const nx = b.x0 + b.vx * a1, ny = b.y0 + b.vy * a1 - 0.5 * g * a1 * a1, nz = b.z0 + b.vz * a1;
        if (this.ownBallHits(b, ox, oy, oz, nx, ny, nz)) continue;
        this.setBall(b, nx, ny, nz, b.vy - g * a1);
        if (a1 > BALL_LIFE || ny < -40) this.endBall(b, { type: "projEnd", proj: b.id });
      } else {
        const a = this.displayAge(b);
        this.setBall(b, b.x0 + b.vx * a, b.y0 + b.vy * a - 0.5 * g * a * a, b.z0 + b.vz * a, b.vy - g * a);
        if (a > BALL_LIFE + 0.5) this.endBall(b, { type: "projEnd", proj: b.id });
      }
    }
  }

  private setBall(b: Ball, x: number, y: number, z: number, vy: number): void {
    const s = b.st;
    s.x = x; s.y = y; s.z = z; s.vx = b.vx; s.vy = vy; s.vz = b.vz;
  }

  /** Predicted impact of my own ball against the world, water and the players I see. */
  private ownBallHits(b: Ball, ox: number, oy: number, oz: number, nx: number, ny: number, nz: number): boolean {
    const sx = nx - ox, sy = ny - oy, sz = nz - oz;
    const len = Math.sqrt(sx * sx + sy * sy + sz * sz);
    let bestT = 2;
    let target: PlayerState | null = null;
    for (const o of this.others) {
      if (!o.alive) continue;
      const mx = (ox + nx) * 0.5 - o.x, mz = (oz + nz) * 0.5 - o.z;
      if (mx * mx + mz * mz > (len * 0.5 + 2) * (len * 0.5 + 2)) continue;
      const t = segCapsule(ox, oy, oz, sx, sy, sz, o, HIT_R);
      if (t >= 0 && t < bestT) { bestT = t; target = o; }
    }
    let hit = null as ReturnType<typeof raycast>;
    if (len > 0) {
      hit = raycast(this.env.cw, ox, oy, oz, sx, sy, sz, len + BALL_RADIUS);
      if (hit && hit.t / len > 1 + BALL_RADIUS / len) hit = null;
    }
    const hitT = hit ? Math.min(1, hit.t / len) : 2;
    const W = waterAt(this.env, nx, nz);
    let waterT = 2;
    if (W !== NO_WATER_Y && ny < W && oy >= W) waterT = (oy - W) / (oy - ny || 1);
    else if (W !== NO_WATER_Y && oy < W) waterT = 0;
    const tmin = Math.min(bestT, hitT, waterT);
    if (tmin > 1) return false;
    const hx = ox + sx * tmin, hy = oy + sy * tmin, hz = oz + sz * tmin;
    this.setBall(b, hx, hy, hz, 0);
    if (bestT === tmin && target) {
      // show the burst now; the server's hit event (pred 2) only adds the confirmation
      this.endBall(b, { type: "projEnd", proj: b.id });
      const sl = Math.sqrt(b.vx * b.vx + b.vz * b.vz) || 1;
      const e: SimEvent = { type: "hit", target: target.id, shooter: this.localId, x: hx, y: hy, z: hz, dx: b.vx / sl, dz: b.vz / sl, coats: -1, color: b.st.color, pred: 1 };
      this.out.push(e);
      this.predHits.push({ target: target.id, t: this.link.now() });
      if (this.predHits.length > 16) this.predHits.shift();
    } else if (hit && hitT === tmin) {
      const surf = hit.kind === "structure" ? 1 : hit.kind === "prop" ? 2 : hit.kind === "cave" ? 3 : 0;
      this.endBall(b, {
        type: "splat", proj: b.id, shooter: this.localId, x: hit.x, y: hit.y, z: hit.z, nx: hit.nx, ny: hit.ny, nz: hit.nz,
        color: b.st.color, r: 0.42 + ((b.seq * 0.618) % 1) * 0.3, surf,
      });
      b.ex = hit.x; b.ey = hit.y; b.ez = hit.z;
    } else {
      this.endBall(b, { type: "splash", proj: b.id, x: hx, y: W, z: hz, size: 0.35 });
    }
    return true;
  }

  private forgetOwn(b: Ball): void {
    this.balls.delete(b.id);
    if (this.ownBySeq.get(b.seq) === b) this.ownBySeq.delete(b.seq);
    if (b.serverId && this.ownByServer.get(b.serverId) === b) this.ownByServer.delete(b.serverId);
  }

  // --- events -----------------------------------------------------------------------------

  private fill(e: NetEvent): SimEvent {
    switch (e.type) {
      case "shot": e.color = this.colors.get(e.pid) ?? 0xffffff; break;
      case "hit":
      case "splat": e.color = this.colors.get(e.shooter) ?? 0xffffff; break;
      case "elim": e.place = this.placeName(e.x, e.z); break;
    }
    return e;
  }

  private placeName(x: number, z: number): string {
    let best = "", bd = 180 * 180;
    for (const l of this.world.landmarks) {
      const dx = l.x - x, dz = l.z - z;
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = l.name; }
    }
    return best || this.world.name;
  }

  private push(e: SimEvent, tick: number, cond: number, urgent = false, ball: Ball | null = null, impactAge = 0): void {
    this.queue.push({ e, tick, cond, ball, impactAge, t: this.link.now(), urgent });
  }

  private enqueue(ne: NetEvent): void {
    const me = this.localId;
    const e = this.fill(ne);
    const tick = ne.tick;
    switch (e.type) {
      case "shot": {
        if (e.pid === me) {
          const b = this.ownBySeq.get(ne.seq ?? -1);
          if (b && !b.serverId) {
            b.serverId = e.proj;
            this.ownByServer.set(e.proj, b);
            this.totals.shotsConfirmed++;
            return;
          }
          this.totals.shotsUnpredicted++;
        }
        const b = this.newBall(e.proj, e.pid, e.x, e.y, e.z, e.vx, e.vy, e.vz);
        b.tick0 = tick - 1;
        b.present = e.pid === me;
        this.balls.set(b.id, b);
        this.push(e, tick, e.pid === me ? C_NOW : C_RENDER, false, b);
        return;
      }
      case "splat":
      case "splash":
      case "projEnd": {
        const own = this.ownByServer.get(e.proj);
        if (own) {
          this.ownByServer.delete(e.proj);
          if (!own.ended) {
            const ev = { ...e, proj: own.id } as SimEvent;
            this.endBall(own, ev);
          } else if (e.type === "splat") {
            const dx = own.ex - e.x, dy = own.ey - e.y, dz = own.ez - e.z;
            if (dx * dx + dy * dy + dz * dz > 0.75 * 0.75) this.out.push({ ...e, proj: 0 });
          }
          return;
        }
        const b = this.balls.get(e.proj);
        if (b && !b.own) {
          this.push(e, tick, C_BALL, false, b, (tick - b.tick0 - 0.5) / 60);
          return;
        }
        if (e.type === "splat") this.push(e, tick, C_NOW);
        return;
      }
      case "hit":
      case "shield":
      case "vest": {
        const mine = e.target === me || e.shooter === me;
        if (e.type === "hit" && e.target === me) this.totals.hitsOnMe++;
        if (e.type === "hit" && e.shooter === me) this.totals.hitsByMe++;
        if (e.shooter === me && e.target !== me) {
          // already burst here? then this only confirms it
          const now = this.link.now();
          const i = this.predHits.findIndex((h) => h.target === e.target && now - h.t < 1500);
          if (i >= 0) {
            this.predHits.splice(i, 1);
            if (e.type === "hit") e.pred = 2;
          }
        }
        this.push(e, tick, C_NOW, mine);
        return;
      }
      case "elim":
        this.push(e, tick, C_NOW, e.victim === me || e.killer === me);
        return;
      case "vehicleEnter":
      case "zipStart":
        if (e.pid === me && this.predInteract && this.predInteract.type === e.type && this.link.now() - this.predInteract.t < 2000) {
          this.predInteract = null; // already shown when we predicted it
          return;
        }
        this.push(e, tick, e.pid === me ? C_NOW : C_RENDER, e.pid === me);
        return;
      case "respawn":
      case "vehicleExit":
      case "zipEnd":
      case "wash":
        this.push(e, tick, e.pid === me ? C_NOW : C_RENDER, e.pid === me);
        return;
      case "move":
        this.push(e, tick, C_RENDER);
        return;
      case "spawnChoices":
        this.push(e, tick, C_NOW, true);
        return;
      default:
        this.push(e, tick, C_NOW);
    }
  }

  private isReady(q: Queued): boolean {
    if (q.cond === C_NOW) return true;
    if (q.cond === C_RENDER) return this.renderTick >= q.tick;
    const b = q.ball!;
    return b.ended || (b.shown && this.displayAge(b) >= q.impactAge);
  }

  private pump(now: number): void {
    const q = this.queue;
    let flush = -1;
    for (let i = q.length - 1; i >= 0; i--) if (q[i]!.urgent) { flush = i; break; }
    let n = 0;
    while (n < q.length) {
      const it = q[n]!;
      if (!(n <= flush || now - it.t > QUEUE_TIMEOUT || this.isReady(it))) break;
      this.fire(it);
      n++;
    }
    if (n) q.splice(0, n);
    this.stats.queue = q.length;
  }

  private fire(q: Queued): void {
    const e = q.e;
    switch (e.type) {
      case "shot": {
        const b = q.ball;
        if (b && !b.ended) {
          b.shown = true;
          const a = this.displayAge(b);
          this.setBall(b, b.x0 + b.vx * a, b.y0 + b.vy * a - 0.5 * BALL_GRAVITY * a * a, b.z0 + b.vz * a, b.vy - BALL_GRAVITY * a);
          (this.snap.projectiles as ProjectileState[]).push(b.st);
        }
        this.out.push(e);
        return;
      }
      case "splat":
      case "splash":
      case "projEnd":
        if (q.ball && !q.ball.ended) this.endBall(q.ball, e);
        else this.out.push(e);
        return;
      case "respawn":
        if (e.pid === this.localId) {
          // the server faces a respawned player toward the island centre
          this.pred.yaw = atan2(-e.x, -e.z);
          this.ox = this.oy = this.oz = 0;
        }
        this.out.push(e);
        return;
      default:
        this.out.push(e);
    }
  }

  // --- helpers -------------------------------------------------------------------------------

  private fillCoats(s: PlayerState): void {
    s.coats.length = 0;
    for (const id of s.coatBy) s.coats.push(this.colors.get(id) ?? 0xffffff);
  }

  private rebuildLists(): void {
    this.listsDirty = false;
    const players = this.snap.players as PlayerState[];
    players.length = 0;
    players.push(this.display);
    this.others.length = 0;
    for (const [id, r] of this.remotes) {
      if (!this.info.has(id)) continue;
      players.push(r.rp.display);
      this.others.push(r.rp.display);
    }
    const vs = this.snap.vehicles as VehicleState[];
    vs.length = 0;
    for (const v of this.vehicles.values()) vs.push(v.rv.display);
    const ks = this.snap.pickups as PickupState[];
    ks.length = 0;
    for (const k of this.pickups.values()) ks.push(k);
  }

  private windowStats(now: number): void {
    if (!this.winStart) this.winStart = now;
    const span = (now - this.winStart) / 1000;
    if (span < 1) return;
    let jerk = 0, jn = 0;
    for (const r of this.remotes.values()) {
      jerk += r.rp.jerkSum;
      jn += r.rp.jerkN;
      r.rp.jerkSum = 0;
      r.rp.jerkN = 0;
    }
    this.totals.jerkSum += jerk;
    this.totals.jerkN += jn;
    const s = this.stats;
    s.snapsPerSec = this.winSnaps / span;
    s.interpDelayMs = this.clock.delayMs;
    s.renderLagMs = this.clock.lagMs(now);
    s.jitterMs = this.clock.jitterMs;
    s.corrPerSec = this.winCorr / span;
    s.corrAvgCm = this.winCorr ? (this.winCorrSum / this.winCorr) * 100 : 0;
    s.corrMaxCm = this.winCorrMax * 100;
    s.unacked = this.cmds.length;
    s.remoteJerkMm = jn ? (jerk / jn) * 1000 : 0;
    this.winStart = now;
    this.winSnaps = 0;
    this.winCorr = 0;
    this.winCorrSum = 0;
    this.winCorrMax = 0;
  }

  /** What E would do (mirrors MatchSim.findInteract on what this client sees). */
  interactTarget(): InteractTarget | null {
    if (!this.ready) return null;
    return this.interactFor(this.pred, false);
  }

  /** findInteract for p, against displayed vehicles or (auth) the latest server vehicle states. */
  private interactFor(p: PlayerState, auth: boolean): InteractTarget | null {
    if (!p.alive) return null;
    if (p.move === Move.Vehicle) {
      const v = this.vehicles.get(p.vehicle)?.state;
      return { kind: "exit", id: p.vehicle, seat: p.seat, label: v ? `Hop off the ${VEHICLE_NAMES[v.kind]}` : "Hop off", dist: 0 };
    }
    if (p.move === Move.Zipline || p.move === Move.Mantle) return null;
    let best: InteractTarget | null = null;
    for (const e of this.vehicles.values()) {
      const v = auth ? e.state : e.rv.display;
      const d = hullDist(v, p.x, p.z);
      if (d > INTERACT_R || Math.abs(p.y - v.y) > 2.6) continue;
      const seat = v.seats.indexOf(-1);
      if (seat < 0) continue;
      if (v.kind === VehicleKind.Vespa && p.move !== Move.Ground) continue;
      const label = v.kind === VehicleKind.Vespa ? (seat === 0 ? "Ride the Vespa" : "Hop on the back") :
        v.kind === VehicleKind.Rowboat ? (seat === 0 ? "Row the boat" : "Ride along") :
        seat === 0 ? "Pole the gondola" : "Ride the gondola";
      if (!best || d < best.dist) best = { kind: "vehicle", id: v.id, seat, label, dist: d };
    }
    const zs = this.env.ziplines;
    for (let i = 0; i < zs.length; i++) {
      const z = zs[i]!;
      const dx = p.x - z.ax, dz = p.z - z.az;
      const d = Math.sqrt(dx * dx + dz * dz);
      const dy = p.y - (z.ay - ZIP_FEET);
      if (d > ZIP_GRAB_R || dy < -3.6 || dy > 3) continue;
      if (!best || d < best.dist) best = { kind: "zip", id: i, seat: 0, label: "Zip down", dist: d };
    }
    return best;
  }

  /** Remote display state by id (tests / debug). */
  remote(id: number): PlayerState | undefined {
    return this.remotes.get(id)?.rp.display;
  }
  remoteIds(): number[] {
    return [...this.remotes.keys()];
  }
  get unackedCount(): number {
    return this.cmds.length;
  }
  get ackSeq(): number {
    return this.ack;
  }
}

function hexOf(i: number): number {
  const c = PLAYER_COLORS[((i % PLAYER_COLORS.length) + PLAYER_COLORS.length) % PLAYER_COLORS.length];
  return c ? parseInt(c.hex.slice(1), 16) : 0xffffff;
}

function hullDist(v: VehicleState, x: number, z: number): number {
  const h = HULL[v.kind];
  const fx = sin(v.yaw), fz = cos(v.yaw);
  const px = x - v.x, pz = z - v.z;
  let t = px * fx + pz * fz;
  if (t > h.hl) t = h.hl;
  else if (t < -h.hl) t = -h.hl;
  const qx = px - fx * t, qz = pz - fz * t;
  return Math.max(0, Math.sqrt(qx * qx + qz * qz) - h.hb);
}
