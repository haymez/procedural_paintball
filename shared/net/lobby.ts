// Core + lobby-phase messages (ids 1..63). See registry.ts for framing.

import type { Reader, Writer } from "./codec";
import { C2S, S2C } from "./registry";
import {
  Difficulty,
  MATCH_MINUTES_DEFAULT,
  MAX_PLAYERS,
  Phase,
  PlayerStatus,
} from "./rules";

// --- shared shapes -----------------------------------------------------------

export interface RoomSettings {
  name: string;
  public: boolean;
  /** u32 world seed. */
  seed: number;
  /** Hide the seed from the public room list. */
  hideSeed: boolean;
  bots: number;
  difficulty: Difficulty;
  matchMinutes: number;
}

export function defaultSettings(): RoomSettings {
  return {
    name: "",
    public: false,
    seed: 0,
    hideSeed: false,
    bots: 0,
    difficulty: Difficulty.Normal,
    matchMinutes: MATCH_MINUTES_DEFAULT,
  };
}

export interface PlayerInfo {
  id: number;
  name: string;
  /** Index into PLAYER_COLORS. */
  color: number;
  host: boolean;
  bot: boolean;
  /** False while a human is inside the reconnect grace window. */
  connected: boolean;
  status: PlayerStatus;
  /** Loading progress 0..1 (quantized to 1/255). */
  progress: number;
  /** Last RTT the client reported, ms (0 = unknown). */
  ping: number;
}

export interface RoomState {
  code: string;
  phase: Phase;
  /** Server time (ms) when the current phase ends automatically, 0 = never. */
  phaseEndsAt: number;
  hostId: number;
  settings: RoomSettings;
  /** Humans first (join order), then bots. */
  players: PlayerInfo[];
}

export interface ResultRow {
  id: number;
  name: string;
  color: number;
  bot: boolean;
  /** Eliminations. */
  score: number;
  deaths: number;
}

export interface RoomListing {
  code: string;
  name: string;
  host: string;
  /** Humans in the room. */
  players: number;
  max: number;
  bots: number;
  phase: Phase;
  /** Null when the host hides it. */
  seed: number | null;
  /** Colo / region hint, e.g. "FRA". */
  region: string;
  public: boolean;
}

// --- field codecs (reused by messages; exported for the match phase) ---------

export function writeSettings(w: Writer, s: RoomSettings): void {
  w.str(s.name).u8((s.public ? 1 : 0) | (s.hideSeed ? 2 : 0)).u32(s.seed).u8(s.bots).u8(s.difficulty).u8(s.matchMinutes);
}
export function readSettings(r: Reader): RoomSettings {
  const name = r.str(128);
  const flags = r.u8();
  return {
    name,
    public: !!(flags & 1),
    hideSeed: !!(flags & 2),
    seed: r.u32(),
    bots: r.u8(),
    difficulty: r.u8() as Difficulty,
    matchMinutes: r.u8(),
  };
}

function writePlayer(w: Writer, p: PlayerInfo): void {
  w.u8(p.id).str(p.name).u8(p.color);
  w.u8((p.host ? 1 : 0) | (p.bot ? 2 : 0) | (p.connected ? 4 : 0));
  w.u8(p.status).quant(p.progress, 0, 1, 8).u16(Math.min(65535, Math.round(p.ping)));
}
function readPlayer(r: Reader): PlayerInfo {
  const id = r.u8();
  const name = r.str(128);
  const color = r.u8();
  const f = r.u8();
  return {
    id,
    name,
    color,
    host: !!(f & 1),
    bot: !!(f & 2),
    connected: !!(f & 4),
    status: r.u8() as PlayerStatus,
    progress: r.quant(0, 1, 8),
    ping: r.u16(),
  };
}

function writeListing(w: Writer, l: RoomListing): void {
  w.str(l.code).str(l.name).str(l.host).u8(l.players).u8(l.max).u8(l.bots).u8(l.phase);
  w.u8((l.public ? 1 : 0) | (l.seed !== null ? 2 : 0));
  if (l.seed !== null) w.u32(l.seed);
  w.str(l.region);
}
function readListing(r: Reader): RoomListing {
  const code = r.str(16);
  const name = r.str(128);
  const host = r.str(128);
  const players = r.u8();
  const max = r.u8();
  const bots = r.u8();
  const phase = r.u8() as Phase;
  const f = r.u8();
  const seed = f & 2 ? r.u32() : null;
  return { code, name, host, players, max, bots, phase, seed, region: r.str(32), public: !!(f & 1) };
}

// --- client -> server --------------------------------------------------------

export interface PingMsg {
  /** Client clock (performance.now() based), echoed back. */
  t: number;
  /** The client's current smoothed RTT estimate, ms (shown to others). */
  rtt: number;
}
export const Ping = C2S.define<PingMsg>(
  1,
  "ping",
  (w, m) => void w.f64(m.t).u16(Math.min(65535, Math.max(0, Math.round(m.rtt)))),
  (r) => ({ t: r.f64(), rtt: r.u16() }),
);

export const SetName = C2S.define<{ name: string }>(2, "setName", (w, m) => void w.str(m.name), (r) => ({ name: r.str(256) }));

export const SetColor = C2S.define<{ color: number }>(3, "setColor", (w, m) => void w.u8(m.color), (r) => ({ color: r.u8() }));

export const Chat = C2S.define<{ text: string }>(4, "chat", (w, m) => void w.str(m.text), (r) => ({ text: r.str(1024) }));

/**
 * Host-only. Only the present fields change. `seedRandom` marks a dice-rolled
 * seed: the room keeps rerolling after each match instead of pinning it.
 */
export type SettingsPatch = Partial<RoomSettings> & { seedRandom?: boolean };
const PATCH_KEYS = ["name", "public", "seed", "hideSeed", "bots", "difficulty", "matchMinutes"] as const;
export const UpdateSettings = C2S.define<SettingsPatch>(
  5,
  "updateSettings",
  (w, m) => {
    let flags = 0;
    PATCH_KEYS.forEach((k, i) => {
      if (m[k] !== undefined) flags |= 1 << i;
    });
    if (m.seedRandom) flags |= 128;
    w.u8(flags);
    if (m.name !== undefined) w.str(m.name);
    if (m.public !== undefined) w.bool(m.public);
    if (m.seed !== undefined) w.u32(m.seed);
    if (m.hideSeed !== undefined) w.bool(m.hideSeed);
    if (m.bots !== undefined) w.u8(m.bots);
    if (m.difficulty !== undefined) w.u8(m.difficulty);
    if (m.matchMinutes !== undefined) w.u8(m.matchMinutes);
  },
  (r) => {
    const f = r.u8();
    const m: SettingsPatch = {};
    if (f & 1) m.name = r.str(256);
    if (f & 2) m.public = r.bool();
    if (f & 4) m.seed = r.u32();
    if (f & 8) m.hideSeed = r.bool();
    if (f & 16) m.bots = r.u8();
    if (f & 32) m.difficulty = r.u8() as Difficulty;
    if (f & 64) m.matchMinutes = r.u8();
    if (f & 128) m.seedRandom = true;
    return m;
  },
);

/** Host-only: lobby -> loading. */
export const StartMatch = C2S.signal(6, "startMatch");

export interface LoadProgressMsg {
  /** Short stage label index is not needed server-side; we only relay t. */
  t: number;
}
export const LoadProgress = C2S.define<LoadProgressMsg>(
  7,
  "loadProgress",
  (w, m) => void w.quant(m.t, 0, 1, 8),
  (r) => ({ t: r.quant(0, 1, 8) }),
);

/** The client finished generating the world for `seed`. */
export const WorldReady = C2S.define<{ seed: number; checksum: number }>(
  8,
  "worldReady",
  (w, m) => void w.u32(m.seed).u32(m.checksum),
  (r) => ({ seed: r.u32(), checksum: r.u32() }),
);

/** Host-only: any phase -> lobby (aborts a running match). */
export const BackToLobby = C2S.signal(9, "backToLobby");

/** Host-only: end the running match now (-> results). */
export const EndMatch = C2S.signal(10, "endMatch");

/** Leaving for good: frees the slot immediately instead of after the grace window. */
export const Leave = C2S.signal(11, "leave");

// --- server -> client --------------------------------------------------------

export interface PongMsg {
  /** The client's `t`, echoed. */
  t: number;
  /** Server clock (ms since epoch) when the pong was sent. */
  server: number;
}
export const Pong = S2C.define<PongMsg>(
  1,
  "pong",
  (w, m) => void w.f64(m.t).f64(m.server),
  (r) => ({ t: r.f64(), server: r.f64() }),
);

export interface WelcomeMsg {
  /** Your player id in this room. */
  you: number;
  code: string;
  /** True when this connection reclaimed a slot held by the grace window. */
  rejoined: boolean;
  server: number;
  tickHz: number;
  graceMs: number;
}
export const Welcome = S2C.define<WelcomeMsg>(
  2,
  "welcome",
  (w, m) => void w.u8(m.you).str(m.code).bool(m.rejoined).f64(m.server).u8(m.tickHz).u32(m.graceMs),
  (r) => ({ you: r.u8(), code: r.str(16), rejoined: r.bool(), server: r.f64(), tickHz: r.u8(), graceMs: r.u32() }),
);

export const RoomStateMsg = S2C.define<RoomState>(
  3,
  "roomState",
  (w, m) => {
    w.str(m.code).u8(m.phase).f64(m.phaseEndsAt).u8(m.hostId);
    writeSettings(w, m.settings);
    w.varu(m.players.length);
    for (const p of m.players) writePlayer(w, p);
  },
  (r) => {
    const code = r.str(16);
    const phase = r.u8() as Phase;
    const phaseEndsAt = r.f64();
    const hostId = r.u8();
    const settings = readSettings(r);
    const n = r.count(MAX_PLAYERS + 8);
    const players: PlayerInfo[] = [];
    for (let i = 0; i < n; i++) players.push(readPlayer(r));
    return { code, phase, phaseEndsAt, hostId, settings, players };
  },
);

export interface ChatLine {
  /** Sender id, 0 = system notice. */
  from: number;
  name: string;
  color: number;
  text: string;
  /** Server time. */
  at: number;
}
export const ChatMsg = S2C.define<ChatLine>(
  4,
  "chat",
  (w, m) => void w.u8(m.from).str(m.name).u8(m.color).str(m.text).f64(m.at),
  (r) => ({ from: r.u8(), name: r.str(128), color: r.u8(), text: r.str(1024), at: r.f64() }),
);

export interface ErrorMsg {
  code: number;
  text: string;
}
export const ErrorMsgDef = S2C.define<ErrorMsg>(
  5,
  "error",
  (w, m) => void w.u8(m.code).str(m.text),
  (r) => ({ code: r.u8(), text: r.str(512) }),
);

/** Sent to each player as they enter the running match (on start, or late). */
export interface MatchBeginMsg {
  seed: number;
  /** Server times (ms). */
  startAt: number;
  endsAt: number;
  /** Server tick number at the moment of sending. */
  tick: number;
}
export const MatchBegin = S2C.define<MatchBeginMsg>(
  6,
  "matchBegin",
  (w, m) => void w.u32(m.seed).f64(m.startAt).f64(m.endsAt).u32(m.tick),
  (r) => ({ seed: r.u32(), startAt: r.f64(), endsAt: r.f64(), tick: r.u32() }),
);

export interface ResultsMsg {
  seed: number;
  endedAt: number;
  /** Sorted, best first. */
  rows: ResultRow[];
}
export const Results = S2C.define<ResultsMsg>(
  7,
  "results",
  (w, m) => {
    w.u32(m.seed).f64(m.endedAt).varu(m.rows.length);
    for (const row of m.rows) {
      w.u8(row.id).str(row.name).u8(row.color).bool(row.bot).varu(row.score).varu(row.deaths);
    }
  },
  (r) => {
    const seed = r.u32();
    const endedAt = r.f64();
    const n = r.count(MAX_PLAYERS + 8);
    const rows: ResultRow[] = [];
    for (let i = 0; i < n; i++) {
      rows.push({ id: r.u8(), name: r.str(128), color: r.u8(), bot: r.bool(), score: r.varu(), deaths: r.varu() });
    }
    return { seed, endedAt, rows };
  },
);

/** Pushed on /ws/lobby: the full public room list. */
export const LobbyList = S2C.define<{ rooms: RoomListing[] }>(
  8,
  "lobbyList",
  (w, m) => {
    w.varu(m.rooms.length);
    for (const l of m.rooms) writeListing(w, l);
  },
  (r) => {
    const n = r.count(10_000);
    const rooms: RoomListing[] = [];
    for (let i = 0; i < n; i++) rooms.push(readListing(r));
    return { rooms };
  },
);
