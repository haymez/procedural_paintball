// RoomClient — one room connection: lobby state, chat, pings, and the typed
// send/on surface the match phase uses for its own messages.
//
//   const room = new RoomClient("ABCD");
//   room.onEvent("state", (s) => …);         // RoomState, after every change
//   room.on(Snapshot, (m) => …);             // any S2C message, incl. match ones
//   room.send(Input, {...});                 // any C2S message
//   room.serverNow();                        // estimated server clock, ms
//   room.rtt;                                // smoothed round trip, ms

import {
  BackToLobby,
  Chat,
  ChatMsg,
  EndMatch,
  ErrorMsgDef,
  Leave,
  LoadProgress,
  MatchBegin,
  Phase,
  Ping,
  PlayerStatus,
  Pong,
  Results,
  RoomStateMsg,
  S2C,
  SetColor,
  SetName,
  StartMatch,
  UpdateSettings,
  Welcome,
  WorldReady,
  type ChatLine,
  type ErrorMsg,
  type MatchBeginMsg,
  type MsgDef,
  type PlayerInfo,
  type ResultsMsg,
  type RoomState,
  type SettingsPatch,
  type WelcomeMsg,
} from "../../../shared/net/index";
import { ClockSync } from "./clock";
import { Connection, type ConnStatus } from "./connection";
import { forgetToken, prefs, tokenFor, wsUrl } from "./session";

export interface RoomEvents {
  welcome: WelcomeMsg;
  state: RoomState;
  chat: ChatLine;
  error: ErrorMsg;
  results: ResultsMsg;
  begin: MatchBeginMsg;
  status: ConnStatus;
  pong: { rtt: number };
}

type Listener<K extends keyof RoomEvents> = (v: RoomEvents[K]) => void;

const CHAT_KEEP = 100;

export class RoomClient {
  readonly conn: Connection;
  readonly clock = new ClockSync();
  state: RoomState | null = null;
  /** My player id (0 until welcomed). */
  me = 0;
  welcome: WelcomeMsg | null = null;
  chat: ChatLine[] = [];
  results: ResultsMsg | null = null;
  /** Latest MatchBegin for me (null outside a match). */
  begin: MatchBeginMsg | null = null;
  lastError: ErrorMsg | null = null;
  /**
   * Seed of the world this tab has loaded (-1 = none). The game sets this once
   * its world is ready; it rides along on reconnects so the server knows
   * whether a returning tab must load again.
   */
  worldSeed = -1;

  private readonly listeners = new Map<keyof RoomEvents, Set<Listener<never>>>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pingMs = 2000;
  private disposed = false;

  constructor(readonly code: string) {
    this.conn = new Connection({
      registry: S2C,
      url: () => {
        const q = new URLSearchParams({
          tk: tokenFor(code),
          name: prefs.name,
          c: String(prefs.color),
          w: String(this.worldSeed),
        });
        return wsUrl(`/ws/room/${code}?${q}`);
      },
      onOpen: () => this.onOpen(),
    });
    const c = this.conn;
    c.onStatus((s) => {
      this.emit("status", s);
      if (s !== "open") this.stopPings();
    });
    c.on(Welcome, (m) => {
      this.me = m.you;
      this.welcome = m;
      this.clock.seed(m.server);
      this.chat = []; // the server replays recent chat after every welcome
      this.emit("welcome", m);
    });
    c.on(RoomStateMsg, (m) => {
      const prev = this.state;
      this.state = m;
      if (m.phase !== Phase.Playing && m.phase !== Phase.Loading) this.begin = null;
      if (prev && prev.phase === Phase.Results && m.phase !== Phase.Results) this.results = null;
      this.emit("state", m);
    });
    c.on(ChatMsg, (m) => {
      this.chat.push(m);
      if (this.chat.length > CHAT_KEEP) this.chat.shift();
      this.emit("chat", m);
    });
    c.on(ErrorMsgDef, (m) => {
      this.lastError = m;
      this.emit("error", m);
    });
    c.on(Results, (m) => {
      this.results = m;
      this.emit("results", m);
    });
    c.on(MatchBegin, (m) => {
      this.begin = m;
      this.emit("begin", m);
    });
    c.on(Pong, (m) => {
      this.clock.sample(m.t, m.server);
      this.emit("pong", { rtt: this.clock.rtt });
    });
  }

  // --- events ---------------------------------------------------------------------

  onEvent<K extends keyof RoomEvents>(ev: K, fn: Listener<K>): () => void {
    let set = this.listeners.get(ev);
    if (!set) this.listeners.set(ev, (set = new Set()));
    set.add(fn as Listener<never>);
    return () => set!.delete(fn as Listener<never>);
  }

  private emit<K extends keyof RoomEvents>(ev: K, v: RoomEvents[K]): void {
    const set = this.listeners.get(ev);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        (fn as Listener<K>)(v);
      } catch (e) {
        console.error(`room event ${ev} handler threw`, e);
      }
    }
  }

  // --- generic message API (the match phase uses these) ---------------------------

  send<T>(def: MsgDef<T>, msg: T): boolean {
    return this.conn.send(def, msg);
  }

  on<T>(def: MsgDef<T>, fn: (msg: T) => void): () => void {
    return this.conn.on(def, fn);
  }

  serverNow(): number {
    return this.clock.serverNow();
  }

  get rtt(): number {
    return this.clock.rtt;
  }

  /** Ping more often during a match (e.g. 1000 ms) for a tighter clock. */
  setPingInterval(ms: number): void {
    this.pingMs = Math.max(250, ms);
    if (this.pingTimer) this.startPings();
  }

  // --- derived state ------------------------------------------------------------------

  get myPlayer(): PlayerInfo | undefined {
    return this.state?.players.find((p) => p.id === this.me);
  }

  get isHost(): boolean {
    return !!this.state && this.state.hostId === this.me && this.me !== 0;
  }

  get myStatus(): PlayerStatus {
    return this.myPlayer?.status ?? PlayerStatus.Idle;
  }

  // --- lobby actions ---------------------------------------------------------------------

  setName(name: string): void {
    prefs.name = name;
    this.send(SetName, { name });
  }
  setColor(color: number): void {
    prefs.color = color;
    this.send(SetColor, { color });
  }
  say(text: string): void {
    this.send(Chat, { text });
  }
  updateSettings(patch: SettingsPatch): void {
    this.send(UpdateSettings, patch);
  }
  start(): void {
    this.send(StartMatch, {});
  }
  progress(t: number): void {
    this.send(LoadProgress, { t });
  }
  worldReady(seed: number, checksum: number): void {
    this.worldSeed = seed;
    this.send(WorldReady, { seed, checksum });
  }
  backToLobby(): void {
    this.send(BackToLobby, {});
  }
  endMatch(): void {
    this.send(EndMatch, {});
  }

  /** Leave for good: frees the slot immediately. */
  leave(): void {
    this.send(Leave, {});
    forgetToken(this.code);
    this.dispose();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopPings();
    this.conn.close(1000, "leaving");
    this.listeners.clear();
  }

  // --- internals ---------------------------------------------------------------------------

  private onOpen(): void {
    this.startPings();
    // A few quick pings so the clock settles right away.
    for (const d of [0, 150, 300]) setTimeout(() => this.ping(), d);
  }

  private ping(): void {
    this.send(Ping, { t: this.clock.local(), rtt: this.clock.rtt });
  }

  private startPings(): void {
    this.stopPings();
    this.pingTimer = setInterval(() => this.ping(), this.pingMs);
  }

  private stopPings(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }
}
