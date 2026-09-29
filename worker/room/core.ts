// RoomCore — the room's state machine, free of Workers globals so tests can
// drive it under Node with fake connections and a fake clock.
//
// The DO shell (room.ts) owns sockets and timers and forwards events here:
//   join(conn, params)   a socket was accepted
//   message(conn, data)  a binary frame arrived
//   closed(conn)         the socket closed / errored
//   service()            every SERVICE_MS while the room has players
//   tick()               every TICK_MS while the match is playing
//
// Phases: lobby -> loading -> playing -> results -> lobby. Rooms are ephemeral
// and in-memory: when the last player is gone the core resets and reports
// itself gone to the lobby registry.

import {
  BOT_NAMES,
  BackToLobby,
  C2S,
  COLOR_COUNT,
  Chat,
  ChatMsg,
  Close,
  Dispatcher,
  EndMatch,
  ErrCode,
  ErrorMsgDef,
  GRACE_MS,
  ID_MATCH_MIN,
  IDLE_CLOSE_MS,
  LOAD_TIMEOUT_MS,
  Leave,
  LoadProgress,
  MATCH_MINUTES_MAX,
  MATCH_MINUTES_MIN,
  MAX_BOTS,
  MAX_PLAYERS,
  MatchBegin,
  Phase,
  Ping,
  PlayerStatus,
  Pong,
  ProtoError,
  RESULTS_MS,
  ROOM_NAMES,
  ROOM_NAME_MAX,
  Results,
  RoomStateMsg,
  SetColor,
  SetName,
  StartMatch,
  TICK_HZ,
  TICK_MS,
  UpdateSettings,
  Welcome,
  WorldReady,
  clampInt,
  decode,
  defaultSettings,
  encode,
  randomPlayerName,
  randomSeed,
  sanitizeChat,
  sanitizeName,
  type ChatLine,
  type MsgDef,
  type PlayerInfo,
  type ResultRow,
  type ResultsMsg,
  type RoomListing,
  type RoomSettings,
  type RoomState,
  type SettingsPatch,
} from "../../shared/net/index";
import type { BotSeat, MatchContext, MatchSim, SimPlayer } from "./match";

/** How often service() runs (grace reaping, timeouts, throttled broadcasts). */
export const SERVICE_MS = 250;
/** Heartbeat to the lobby registry even when nothing changed. */
export const REPORT_HEARTBEAT_MS = 30_000;
const CHAT_HISTORY = 30;
const CHAT_BURST = 4;
const CHAT_REFILL_MS = 2500;
const MSG_PER_SEC = 180;
const MAX_BAD_FRAMES = 20;
const MAX_TICK_CATCHUP = 5;
const HUMAN_ID_MAX = 127;
const BOT_ID_BASE = 128;

export interface Conn {
  /** Must never throw; false if the peer is gone. */
  send(data: Uint8Array): boolean;
  close(code: number, reason: string): void;
}

export interface RoomEnv {
  now(): number;
  random(): number;
  setTicking(on: boolean): void;
  setService(on: boolean): void;
  /** Tell the lobby registry about the room; null = the room is gone. Fire-and-forget. */
  report(listing: RoomListing | null): void;
  createSim(ctx: MatchContext): MatchSim;
  log(...args: unknown[]): void;
}

export interface JoinParams {
  token: string;
  name: string;
  /** Preferred color index, -1 for none. */
  color: number;
  /** Seed of the world this tab already has loaded, -1 for none (reconnect after reload). */
  world: number;
}

export interface FreshRoomOptions {
  public: boolean;
  region: string;
}

interface Player extends SimPlayer {
  id: number;
  token: string;
  name: string;
  color: number;
  conn: Conn | null;
  /** When the socket dropped (0 = connected). */
  goneAt: number;
  joinedAt: number;
  status: PlayerStatus;
  progress: number;
  rtt: number;
  checksum: number;
  /** Currently registered with the sim. */
  inSim: boolean;
  chatTokens: number;
  chatAt: number;
  msgWindow: number;
  msgCount: number;
  badFrames: number;
}

const TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;

export class RoomCore {
  phase: Phase = Phase.Lobby;
  /** The host typed/picked this seed; keep it across matches instead of rerolling. */
  private seedPinned = false;
  phaseEndsAt = 0;
  hostId = 0;
  settings: RoomSettings = defaultSettings();
  bots: BotSeat[] = [];

  private readonly players = new Map<string, Player>(); // token -> player
  private readonly byConn = new Map<Conn, Player>();
  private region = "";
  private fresh: FreshRoomOptions = { public: false, region: "" };
  private chatLog: ChatLine[] = [];
  private results: ResultsMsg | null = null;
  private lastActivity = 0;
  private stateDirty = false;
  private pingDirtyAt = 0;
  private lastReportJson = "";
  private lastReportAt = 0;
  private serviceOn = false;
  private tickingOn = false;

  // match
  private sim: MatchSim | null = null;
  private simReady = false;
  private matchGen = 0;
  private matchSeed = 0;
  private matchStartAt = 0;
  private matchEndsAt = 0;
  private tickNo = 0;
  private simErrors = 0;
  private endRequested = false;
  private firstChecksum: number | null = null;

  private readonly handlers = new Dispatcher<Player>();

  constructor(
    readonly code: string,
    private readonly env: RoomEnv,
  ) {
    const h = this.handlers;
    h.on(Ping, (m, p) => this.onPing(p, m.t, m.rtt));
    h.on(SetName, (m, p) => this.onSetName(p, m.name));
    h.on(SetColor, (m, p) => this.onSetColor(p, m.color));
    h.on(Chat, (m, p) => this.onChat(p, m.text));
    h.on(UpdateSettings, (m, p) => this.onUpdateSettings(p, m));
    h.on(StartMatch, (_m, p) => this.onStart(p));
    h.on(LoadProgress, (m, p) => this.onProgress(p, m.t));
    h.on(WorldReady, (m, p) => this.onWorldReady(p, m.seed, m.checksum));
    h.on(BackToLobby, (_m, p) => this.onBackToLobby(p));
    h.on(EndMatch, (_m, p) => this.onEndMatch(p));
    h.on(Leave, (_m, p) => this.onLeave(p));
  }

  // --- queries ---------------------------------------------------------------

  get isEmpty(): boolean {
    return this.players.size === 0;
  }
  get humanCount(): number {
    return this.players.size;
  }
  get isTicking(): boolean {
    return this.tickingOn;
  }
  get isServicing(): boolean {
    return this.serviceOn;
  }

  /** Set before the first join of a fresh room (from the lobby's reservation). */
  prepare(opts: FreshRoomOptions): void {
    this.fresh = opts;
  }

  snapshot(): RoomState {
    const humans = this.humansInOrder();
    const players: PlayerInfo[] = humans.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      host: p.id === this.hostId,
      bot: false,
      connected: !!p.conn,
      status: p.status,
      progress: p.progress,
      ping: p.rtt,
    }));
    const botStatus = this.phase === Phase.Playing ? PlayerStatus.Ready : PlayerStatus.Idle;
    for (const b of this.bots) {
      players.push({
        id: b.id,
        name: b.name,
        color: b.color,
        host: false,
        bot: true,
        connected: true,
        status: botStatus,
        progress: 1,
        ping: 0,
      });
    }
    return {
      code: this.code,
      phase: this.phase,
      phaseEndsAt: this.phaseEndsAt,
      hostId: this.hostId,
      settings: { ...this.settings },
      players,
    };
  }

  listing(): RoomListing {
    const host = [...this.players.values()].find((p) => p.id === this.hostId);
    return {
      code: this.code,
      name: this.settings.name,
      host: host?.name ?? "",
      players: this.players.size,
      max: MAX_PLAYERS,
      bots: this.settings.bots,
      phase: this.phase,
      seed: this.settings.hideSeed ? null : this.settings.seed,
      region: this.region,
      public: this.settings.public,
    };
  }

  // --- connection lifecycle --------------------------------------------------

  /** Returns false if the connection was refused (and closed). */
  join(conn: Conn, params: JoinParams): boolean {
    const now = this.env.now();
    if (!TOKEN_RE.test(params.token)) {
      this.refuse(conn, ErrCode.BadHandshake, "Bad session token.", Close.BadHandshake);
      return false;
    }
    const existing = this.players.get(params.token);
    if (existing) {
      this.reconnect(existing, conn, params);
      return true;
    }
    if (this.players.size >= MAX_PLAYERS) {
      this.refuse(conn, ErrCode.Full, "This room is full.", Close.Full);
      return false;
    }

    const first = this.players.size === 0;
    if (first) this.resetForFirstJoin(now);

    const p: Player = {
      id: this.freeHumanId(),
      token: params.token,
      name: sanitizeName(params.name) || randomPlayerName(() => this.env.random()),
      color: this.pickColor(params.color),
      conn,
      goneAt: 0,
      joinedAt: now,
      status: this.phase === Phase.Loading || this.phase === Phase.Playing ? PlayerStatus.Loading : PlayerStatus.Idle,
      progress: 0,
      rtt: 0,
      checksum: 0,
      inSim: false,
      chatTokens: CHAT_BURST,
      chatAt: now,
      msgWindow: now,
      msgCount: 0,
      badFrames: 0,
    };
    this.players.set(p.token, p);
    this.byConn.set(conn, p);
    if (first) this.hostId = p.id;
    this.lastActivity = now;

    // Bots yield their seats to humans.
    if (this.players.size + this.settings.bots > MAX_PLAYERS) {
      this.settings.bots = MAX_PLAYERS - this.players.size;
    }
    this.rebuildBots();

    this.sendTo(p, Welcome, {
      you: p.id,
      code: this.code,
      rejoined: false,
      server: now,
      tickHz: TICK_HZ,
      graceMs: GRACE_MS,
    });
    for (const line of this.chatLog) this.sendTo(p, ChatMsg, line);
    if (this.phase === Phase.Results && this.results) this.sendTo(p, Results, this.results);
    this.notice(`${p.name} joined`);
    this.broadcastState();
    this.maybeReport(now, true);
    return true;
  }

  private reconnect(p: Player, conn: Conn, params: JoinParams): void {
    const now = this.env.now();
    if (p.conn && p.conn !== conn) {
      this.byConn.delete(p.conn);
      p.conn.close(Close.Replaced, "replaced by a newer connection");
    }
    p.conn = conn;
    p.goneAt = 0;
    this.byConn.set(conn, p);

    const inMatchPhase = this.phase === Phase.Loading || this.phase === Phase.Playing;
    if (inMatchPhase && p.status === PlayerStatus.Ready && params.world !== this.matchSeed) {
      // The tab reloaded and lost its world: load again, then re-enter.
      if (p.inSim) this.simLeave(p, "reload");
      p.status = PlayerStatus.Loading;
      p.progress = 0;
    } else if (p.inSim) {
      this.safeSim((s) => s.onPlayerConnection(p, true));
    }

    this.sendTo(p, Welcome, {
      you: p.id,
      code: this.code,
      rejoined: true,
      server: now,
      tickHz: TICK_HZ,
      graceMs: GRACE_MS,
    });
    for (const line of this.chatLog) this.sendTo(p, ChatMsg, line);
    if (this.phase === Phase.Results && this.results) this.sendTo(p, Results, this.results);
    if (this.phase === Phase.Playing && p.inSim) this.sendBegin(p);
    this.broadcastState();
  }

  closed(conn: Conn): void {
    const p = this.byConn.get(conn);
    this.byConn.delete(conn);
    if (!p || p.conn !== conn) return; // superseded by a reconnect
    p.conn = null;
    p.goneAt = this.env.now();
    if (p.inSim) this.safeSim((s) => s.onPlayerConnection(p, false));
    if (this.phase === Phase.Loading) this.checkAllReady();
    this.broadcastState();
  }

  private refuse(conn: Conn, code: ErrCode, text: string, close: number): void {
    conn.send(encode(ErrorMsgDef, { code, text }));
    conn.close(close, text);
  }

  private remove(p: Player, reason: "left" | "timeout"): void {
    this.players.delete(p.token);
    if (p.conn) {
      this.byConn.delete(p.conn);
      p.conn = null;
    }
    if (p.inSim) this.simLeave(p, reason);
    if (this.players.size === 0) {
      this.shutdown();
      return;
    }
    if (p.id === this.hostId) this.promoteHost();
    this.notice(reason === "left" ? `${p.name} left` : `${p.name} lost connection`);
    this.rebuildBots();
    if (this.phase === Phase.Loading) this.checkAllReady();
    this.broadcastState();
  }

  private promoteHost(): void {
    const order = this.humansInOrder();
    const next = order.find((p) => p.conn) ?? order[0];
    if (!next) return;
    this.hostId = next.id;
    this.notice(`${next.name} is now the host`);
  }

  /** Last player gone: stop everything and forget the room. */
  private shutdown(): void {
    this.disposeSim();
    this.setTicking(false);
    this.setService(false);
    this.env.report(null);
    for (const p of this.players.values()) p.conn?.close(Close.Idle, "room closed");
    this.players.clear();
    this.byConn.clear();
    this.chatLog = [];
    this.results = null;
    this.phase = Phase.Lobby;
    this.phaseEndsAt = 0;
    this.hostId = 0;
    this.settings = defaultSettings();
    this.bots = [];
    this.lastReportJson = "";
    this.lastReportAt = 0;
    this.stateDirty = false;
  }

  private resetForFirstJoin(now: number): void {
    this.settings = defaultSettings();
    this.settings.public = this.fresh.public;
    this.settings.name = ROOM_NAMES[Math.floor(this.env.random() * ROOM_NAMES.length)]!;
    this.settings.seed = randomSeed(() => this.env.random());
    this.seedPinned = false;
    this.region = this.fresh.region;
    this.phase = Phase.Lobby;
    this.phaseEndsAt = 0;
    this.chatLog = [];
    this.results = null;
    this.lastActivity = now;
    this.setService(true);
  }

  // --- inbound ---------------------------------------------------------------

  message(conn: Conn, data: ArrayBuffer | Uint8Array | string): void {
    const p = this.byConn.get(conn);
    if (!p || typeof data === "string") return;
    const now = this.env.now();

    if (now - p.msgWindow >= 1000) {
      p.msgWindow = now;
      p.msgCount = 0;
    }
    if (++p.msgCount > MSG_PER_SEC) return;

    let decoded;
    try {
      decoded = decode(C2S, data);
    } catch (e) {
      if (!(e instanceof ProtoError)) throw e;
      if (++p.badFrames > MAX_BAD_FRAMES) {
        conn.close(Close.BadHandshake, "malformed frames");
        this.closed(conn);
      }
      return;
    }

    if (decoded.def.id >= ID_MATCH_MIN) {
      if (this.phase === Phase.Playing && p.inSim) {
        const { def, msg } = decoded;
        this.safeSim((s) => s.onInput(p, def, msg));
      }
      return;
    }
    this.handlers.dispatch(decoded, p);
  }

  private isHost(p: Player): boolean {
    return p.id === this.hostId;
  }

  private onPing(p: Player, t: number, rtt: number): void {
    if (Math.abs(rtt - p.rtt) >= 5) this.pingDirtyAt ||= this.env.now();
    p.rtt = rtt;
    this.sendTo(p, Pong, { t, server: this.env.now() });
  }

  private menuPhase(): boolean {
    return this.phase === Phase.Lobby || this.phase === Phase.Results;
  }

  private onSetName(p: Player, raw: string): void {
    if (!this.menuPhase()) return;
    const name = sanitizeName(raw);
    if (!name || name === p.name) return;
    this.lastActivity = this.env.now();
    const old = p.name;
    p.name = name;
    this.notice(`${old} is now ${name}`);
    this.broadcastState();
  }

  private onSetColor(p: Player, color: number): void {
    if (!this.menuPhase()) return;
    if (!Number.isInteger(color) || color < 0 || color >= COLOR_COUNT || color === p.color) return;
    for (const o of this.players.values()) {
      if (o !== p && o.color === color) {
        this.sendTo(p, ErrorMsgDef, { code: ErrCode.ColorTaken, text: "Someone already has that color." });
        return;
      }
    }
    this.lastActivity = this.env.now();
    p.color = color;
    this.rebuildBots();
    this.broadcastState();
  }

  private onChat(p: Player, raw: string): void {
    const now = this.env.now();
    const text = sanitizeChat(raw);
    if (!text) return;
    p.chatTokens = Math.min(CHAT_BURST, p.chatTokens + (now - p.chatAt) / CHAT_REFILL_MS);
    p.chatAt = now;
    if (p.chatTokens < 1) {
      this.sendTo(p, ErrorMsgDef, { code: ErrCode.RateLimited, text: "Slow down a little." });
      return;
    }
    p.chatTokens -= 1;
    this.lastActivity = now;
    this.pushChat({ from: p.id, name: p.name, color: p.color, text, at: now });
  }

  private onUpdateSettings(p: Player, m: SettingsPatch): void {
    if (!this.isHost(p) || this.phase !== Phase.Lobby) return;
    const s = this.settings;
    if (m.name !== undefined) {
      const n = sanitizeName(m.name, ROOM_NAME_MAX);
      if (n) s.name = n;
    }
    if (m.public !== undefined) s.public = !!m.public;
    if (m.hideSeed !== undefined) s.hideSeed = !!m.hideSeed;
    if (m.seed !== undefined) {
      s.seed = m.seed >>> 0;
      this.seedPinned = !m.seedRandom;
    }
    if (m.difficulty !== undefined) s.difficulty = clampInt(m.difficulty, 0, 2, s.difficulty);
    if (m.matchMinutes !== undefined) {
      s.matchMinutes = clampInt(m.matchMinutes, MATCH_MINUTES_MIN, MATCH_MINUTES_MAX, s.matchMinutes);
    }
    if (m.bots !== undefined) {
      s.bots = clampInt(m.bots, 0, Math.min(MAX_BOTS, MAX_PLAYERS - this.players.size), s.bots);
      this.rebuildBots();
    }
    this.lastActivity = this.env.now();
    this.broadcastState();
  }

  private onStart(p: Player): void {
    if (!this.isHost(p) || this.phase !== Phase.Lobby) return;
    this.lastActivity = this.env.now();
    this.startLoading();
  }

  private onProgress(p: Player, t: number): void {
    if (p.status !== PlayerStatus.Loading) return;
    p.progress = Math.min(1, Math.max(0, t));
    this.stateDirty = true; // throttled: flushed by service()
  }

  private onWorldReady(p: Player, seed: number, checksum: number): void {
    if (p.status !== PlayerStatus.Loading || seed !== this.matchSeed) return;
    if (this.phase !== Phase.Loading && this.phase !== Phase.Playing) return;
    const expected = this.safeSim((s) => s.worldChecksum?.() ?? null) ?? this.firstChecksum;
    if (expected !== null && expected !== undefined && checksum !== expected) {
      this.env.log(`room ${this.code}: world checksum mismatch from ${p.id}: ${checksum} != ${expected}`);
      this.sendTo(p, ErrorMsgDef, {
        code: ErrCode.WorldMismatch,
        text: "Your island came out different from everyone else's. Expect odd collisions.",
      });
    }
    if (this.firstChecksum === null) this.firstChecksum = checksum;
    p.checksum = checksum;
    p.status = PlayerStatus.Ready;
    p.progress = 1;
    if (this.phase === Phase.Playing) this.enterMatch(p);
    else this.checkAllReady();
    this.broadcastState();
  }

  private onBackToLobby(p: Player): void {
    if (!this.isHost(p) || this.phase === Phase.Lobby) return;
    this.lastActivity = this.env.now();
    this.toLobby();
  }

  private onEndMatch(p: Player): void {
    if (!this.isHost(p)) return;
    if (this.phase === Phase.Playing) this.endMatch();
    else if (this.phase === Phase.Loading) this.toLobby();
  }

  private onLeave(p: Player): void {
    const conn = p.conn;
    this.remove(p, "left");
    conn?.close(Close.Left, "left");
  }

  // --- match flow --------------------------------------------------------------

  private startLoading(): void {
    const now = this.env.now();
    this.disposeSim();
    this.phase = Phase.Loading;
    this.phaseEndsAt = now + LOAD_TIMEOUT_MS;
    this.matchSeed = this.settings.seed;
    this.firstChecksum = null;
    this.simErrors = 0;
    this.endRequested = false;
    this.results = null;
    for (const p of this.players.values()) {
      p.status = PlayerStatus.Loading;
      p.progress = 0;
      p.checksum = 0;
      p.inSim = false;
    }

    const gen = ++this.matchGen;
    const sim = this.env.createSim(this.matchContext(gen));
    this.sim = sim;
    this.simReady = false;
    const setup = {
      seed: this.matchSeed,
      settings: { ...this.settings },
      humans: this.humansInOrder().map((p) => ({ id: p.id, name: p.name, color: p.color })),
      bots: this.bots.slice(),
    };
    let pending: void | Promise<void>;
    try {
      pending = sim.onMatchStart(this.matchSeed, setup);
    } catch (e) {
      this.env.log(`room ${this.code}: onMatchStart threw`, e);
      this.notice("The island failed to load on the server.");
      this.toLobby();
      return;
    }
    if (pending && typeof (pending as Promise<void>).then === "function") {
      (pending as Promise<void>).then(
        () => {
          if (gen !== this.matchGen) return;
          this.simReady = true;
          this.checkAllReady();
        },
        (e: unknown) => {
          if (gen !== this.matchGen) return;
          this.env.log(`room ${this.code}: onMatchStart rejected`, e);
          this.notice("The island failed to load on the server.");
          this.toLobby();
        },
      );
    } else {
      this.simReady = true;
    }
    this.notice(`Loading island #${this.matchSeed}`);
    this.broadcastState();
  }

  private checkAllReady(): void {
    if (this.phase !== Phase.Loading || !this.simReady) return;
    let ready = 0;
    for (const p of this.players.values()) {
      if (!p.conn) continue; // a dropped player doesn't hold everyone up
      if (p.status !== PlayerStatus.Ready) return;
      ready++;
    }
    if (ready > 0) this.beginPlaying();
  }

  private beginPlaying(): void {
    const now = this.env.now();
    this.phase = Phase.Playing;
    this.matchStartAt = now;
    this.matchEndsAt = now + this.settings.matchMinutes * 60_000;
    this.phaseEndsAt = this.matchEndsAt;
    this.tickNo = 0;
    for (const p of this.humansInOrder()) {
      if (p.status === PlayerStatus.Ready) this.enterMatch(p);
    }
    this.setTicking(true);
    this.broadcastState();
  }

  private enterMatch(p: Player): void {
    if (!this.sim || p.inSim) return;
    p.inSim = true;
    this.safeSim((s) => s.onPlayerEnter(p));
    if (!p.conn) this.safeSim((s) => s.onPlayerConnection(p, false));
    this.sendBegin(p);
  }

  private sendBegin(p: Player): void {
    this.sendTo(p, MatchBegin, {
      seed: this.matchSeed,
      startAt: this.matchStartAt,
      endsAt: this.matchEndsAt,
      tick: this.tickNo,
    });
  }

  private simLeave(p: Player, reason: "left" | "timeout" | "reload"): void {
    p.inSim = false;
    this.safeSim((s) => s.onPlayerLeave(p, reason));
  }

  tick(): void {
    if (this.phase !== Phase.Playing || !this.sim) {
      this.setTicking(false);
      return;
    }
    const now = this.env.now();
    const due = Math.floor((now - this.matchStartAt) / TICK_MS) + 1;
    if (due - this.tickNo > MAX_TICK_CATCHUP) this.tickNo = due - MAX_TICK_CATCHUP;
    while (this.tickNo < due && this.sim && !this.endRequested) {
      const t = this.tickNo++;
      const ok = this.safeSim((s) => {
        s.tick(t, 1 / TICK_HZ);
        return true;
      });
      if (!ok && ++this.simErrors > 30) {
        this.notice("The match hit an error and was stopped.");
        this.toLobby();
        return;
      }
    }
    if (this.endRequested || now >= this.matchEndsAt) this.endMatch();
  }

  private endMatch(): void {
    if (this.phase !== Phase.Playing) return;
    const now = this.env.now();
    const rows: ResultRow[] = this.safeSim((s) => s.results()) ?? [];
    rows.sort((a, b) => b.score - a.score || a.deaths - b.deaths);
    this.results = { seed: this.matchSeed, endedAt: now, rows };
    this.disposeSim();
    this.setTicking(false);
    this.phase = Phase.Results;
    this.phaseEndsAt = now + RESULTS_MS;
    for (const p of this.players.values()) {
      p.status = PlayerStatus.Idle;
      p.progress = 0;
    }
    this.broadcast(Results, this.results);
    this.broadcastState();
  }

  private toLobby(): void {
    // After a finished match, sail to a fresh island unless the host chose one.
    if (this.phase === Phase.Results && !this.seedPinned) {
      this.settings.seed = randomSeed(() => this.env.random());
    }
    this.disposeSim();
    this.setTicking(false);
    this.phase = Phase.Lobby;
    this.phaseEndsAt = 0;
    this.results = null;
    for (const p of this.players.values()) {
      p.status = PlayerStatus.Idle;
      p.progress = 0;
    }
    this.broadcastState();
  }

  private disposeSim(): void {
    const sim = this.sim;
    this.sim = null;
    this.simReady = false;
    this.matchGen++;
    this.endRequested = false;
    for (const p of this.players.values()) p.inSim = false;
    if (sim) {
      try {
        sim.dispose();
      } catch (e) {
        this.env.log(`room ${this.code}: sim.dispose threw`, e);
      }
    }
  }

  private matchContext(gen: number): MatchContext {
    return {
      now: () => this.env.now(),
      broadcast: (def, msg) => {
        if (gen !== this.matchGen) return;
        const bytes = encode(def, msg);
        for (const p of this.players.values()) if (p.inSim && p.conn) p.conn.send(bytes);
      },
      send: (id, def, msg) => {
        if (gen !== this.matchGen) return false;
        for (const p of this.players.values()) {
          if (p.id === id) return !!p.conn && p.conn.send(encode(def, msg));
        }
        return false;
      },
      endMatch: () => {
        if (gen === this.matchGen && this.phase === Phase.Playing) this.endRequested = true;
      },
      log: (...a) => this.env.log(`room ${this.code}:`, ...a),
    };
  }

  /** Runs fn against the sim; a throwing sim is logged, never propagated. */
  private safeSim<R>(fn: (s: MatchSim) => R): R | undefined {
    const sim = this.sim;
    if (!sim) return undefined;
    try {
      return fn(sim);
    } catch (e) {
      this.env.log(`room ${this.code}: sim threw`, e);
      return undefined;
    }
  }

  // --- periodic ----------------------------------------------------------------

  service(): void {
    const now = this.env.now();
    for (const p of [...this.players.values()]) {
      if (p.goneAt && now - p.goneAt >= GRACE_MS) this.remove(p, "timeout");
    }
    if (this.players.size === 0) return;

    if (this.phase === Phase.Loading && now >= this.phaseEndsAt) this.loadTimedOut();
    else if (this.phase === Phase.Results && now >= this.phaseEndsAt) this.toLobby();
    else if (this.phase === Phase.Playing && !this.tickingOn) this.setTicking(true);

    if (this.phase === Phase.Lobby && now - this.lastActivity >= IDLE_CLOSE_MS) {
      for (const p of this.players.values()) {
        if (p.conn) {
          this.sendTo(p, ErrorMsgDef, { code: ErrCode.Idle, text: "The room closed after a long quiet spell." });
          p.conn.close(Close.Idle, "idle");
        }
      }
      this.shutdown();
      return;
    }

    if (this.pingDirtyAt && now - this.pingDirtyAt >= 2000 && this.phase !== Phase.Playing) {
      this.stateDirty = true;
    }
    if (this.stateDirty) this.broadcastState();
    this.maybeReport(now, false);
  }

  private loadTimedOut(): void {
    const anyReady = [...this.players.values()].some((p) => p.status === PlayerStatus.Ready);
    if (this.simReady && anyReady) {
      // Stragglers keep loading and drop in when they finish.
      this.beginPlaying();
    } else {
      this.notice("Loading took too long. Back to the lobby.");
      this.toLobby();
    }
  }

  private maybeReport(now: number, force: boolean): void {
    if (this.players.size === 0) return;
    const json = JSON.stringify(this.listing());
    const changed = json !== this.lastReportJson;
    if (!changed && now - this.lastReportAt < REPORT_HEARTBEAT_MS) return;
    if (changed && !force && now - this.lastReportAt < 1000) return;
    this.lastReportJson = json;
    this.lastReportAt = now;
    this.env.report(this.listing());
  }

  // --- helpers -----------------------------------------------------------------

  private setTicking(on: boolean): void {
    if (on === this.tickingOn) return;
    this.tickingOn = on;
    this.env.setTicking(on);
  }

  private setService(on: boolean): void {
    if (on === this.serviceOn) return;
    this.serviceOn = on;
    this.env.setService(on);
  }

  private humansInOrder(): Player[] {
    return [...this.players.values()].sort((a, b) => a.joinedAt - b.joinedAt || a.id - b.id);
  }

  private freeHumanId(): number {
    const used = new Set([...this.players.values()].map((p) => p.id));
    for (let id = 1; id <= HUMAN_ID_MAX; id++) if (!used.has(id)) return id;
    return HUMAN_ID_MAX; // unreachable with MAX_PLAYERS humans
  }

  private pickColor(pref: number): number {
    const used = new Set([...this.players.values()].map((p) => p.color));
    if (Number.isInteger(pref) && pref >= 0 && pref < COLOR_COUNT && !used.has(pref)) return pref;
    for (let c = 0; c < COLOR_COUNT; c++) if (!used.has(c)) return c;
    return 0;
  }

  private rebuildBots(): void {
    const n = Math.max(0, Math.min(this.settings.bots, MAX_PLAYERS - this.players.size));
    this.settings.bots = n;
    const used = new Set([...this.players.values()].map((p) => p.color));
    const bots: BotSeat[] = [];
    let c = COLOR_COUNT - 1; // bots take colors from the end of the palette
    for (let i = 0; i < n; i++) {
      while (c >= 0 && used.has(c)) c--;
      const color = c >= 0 ? c : i % COLOR_COUNT;
      used.add(color);
      bots.push({ id: BOT_ID_BASE + i, name: BOT_NAMES[i % BOT_NAMES.length]!, color });
    }
    const changed =
      bots.length !== this.bots.length ||
      bots.some((b, i) => b.color !== this.bots[i]!.color || b.name !== this.bots[i]!.name);
    this.bots = bots;
    if (changed && this.phase === Phase.Playing) {
      const snapshot = bots.slice();
      this.safeSim((s) => s.onBotsChanged(snapshot));
    }
  }

  private notice(text: string): void {
    this.pushChat({ from: 0, name: "", color: 0, text, at: this.env.now() });
  }

  private pushChat(line: ChatLine): void {
    this.chatLog.push(line);
    if (this.chatLog.length > CHAT_HISTORY) this.chatLog.shift();
    this.broadcast(ChatMsg, line);
  }

  private sendTo<T>(p: Player, def: MsgDef<T>, msg: T): boolean {
    return !!p.conn && p.conn.send(encode(def, msg));
  }

  private broadcast<T>(def: MsgDef<T>, msg: T): void {
    const bytes = encode(def, msg);
    for (const p of this.players.values()) if (p.conn) p.conn.send(bytes);
  }

  private broadcastState(): void {
    this.stateDirty = false;
    this.pingDirtyAt = 0;
    this.broadcast(RoomStateMsg, this.snapshot());
  }
}
