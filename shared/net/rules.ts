// Room rules, limits and the pure helpers both ends agree on (sanitizers,
// palette, default names). Nothing here touches the network.

export const MAX_PLAYERS = 20; // humans + bots
export const MAX_BOTS = MAX_PLAYERS - 1;
export const TICK_HZ = 30;
export const TICK_MS = 1000 / TICK_HZ;
/** A dropped player's slot is held this long. */
export const GRACE_MS = 20_000;
/** Loading waits at most this long for stragglers before the match starts. */
export const LOAD_TIMEOUT_MS = 60_000;
/** Results screen lasts this long before the room returns to the lobby. */
export const RESULTS_MS = 25_000;
/** A lobby with no activity for this long closes. */
export const IDLE_CLOSE_MS = 20 * 60_000;
export const NAME_MAX = 18;
export const ROOM_NAME_MAX = 28;
export const CHAT_MAX = 160;
export const MATCH_MINUTES_MIN = 1;
export const MATCH_MINUTES_MAX = 30;
export const MATCH_MINUTES_DEFAULT = 10;

export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no I/L/O/0/1
export const CODE_LEN = 4;
export const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/;

/** Uppercases and maps look-alikes (O->0 is invalid, so O stays out), returns null if not a code. */
export function normalizeCode(raw: string): string | null {
  const c = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  return CODE_RE.test(c) ? c : null;
}

export function randomCode(rand: () => number): string {
  let s = "";
  for (let i = 0; i < CODE_LEN; i++) s += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)];
  return s;
}

// --- phases & statuses -------------------------------------------------------

export enum Phase {
  Lobby = 0,
  Loading = 1,
  Playing = 2,
  Results = 3,
}
export const PHASE_NAMES = ["lobby", "loading", "playing", "results"] as const;

export enum PlayerStatus {
  /** In the menus (lobby / results). */
  Idle = 0,
  /** Generating the world for the current match. */
  Loading = 1,
  /** World ready; in the match once the room is playing. */
  Ready = 2,
}

export enum Difficulty {
  Easy = 0,
  Normal = 1,
  Hard = 2,
}
export const DIFFICULTY_NAMES = ["Easy", "Normal", "Hard"] as const;

/** WebSocket close codes the room uses. The client never retries these. */
export const Close = {
  NotFound: 4001,
  Full: 4002,
  Replaced: 4003,
  BadHandshake: 4004,
  Idle: 4008,
  Left: 4009,
} as const;
export const FATAL_CLOSE_CODES: readonly number[] = [
  Close.NotFound,
  Close.Full,
  Close.Replaced,
  Close.BadHandshake,
  Close.Idle,
  Close.Left,
];

/** Error codes carried by the Error message. */
export enum ErrCode {
  NotFound = 1,
  Full = 2,
  BadHandshake = 3,
  NotHost = 4,
  BadPhase = 5,
  ColorTaken = 6,
  RateLimited = 7,
  WorldMismatch = 8,
  Idle = 9,
}

// --- palette -----------------------------------------------------------------

/** 20 distinct pastel-bright player colors (index is what goes on the wire). */
export const PLAYER_COLORS: readonly { hex: string; name: string }[] = [
  { hex: "#ff6b6b", name: "Anguria" }, // watermelon red
  { hex: "#ff9f5a", name: "Arancia" }, // orange
  { hex: "#ffd23f", name: "Limone" }, // lemon
  { hex: "#b5e655", name: "Pistacchio" }, // pistachio
  { hex: "#4cd97b", name: "Basilico" }, // basil
  { hex: "#2ec4b6", name: "Laguna" }, // lagoon teal
  { hex: "#4fc3f7", name: "Cielo" }, // sky
  { hex: "#3d7bf7", name: "Mare" }, // sea blue
  { hex: "#8c7cf0", name: "Lavanda" }, // lavender
  { hex: "#c77dff", name: "Glicine" }, // wisteria
  { hex: "#ff7ac6", name: "Bouganville" }, // bougainvillea pink
  { hex: "#ff9eb5", name: "Fragola" }, // strawberry cream
  { hex: "#e0475b", name: "Ciliegia" }, // cherry
  { hex: "#f4a261", name: "Albicocca" }, // apricot
  { hex: "#c9a227", name: "Miele" }, // honey
  { hex: "#7bd3a8", name: "Menta" }, // mint
  { hex: "#1f9e89", name: "Smeraldo" }, // emerald
  { hex: "#a0c4ff", name: "Nuvola" }, // cloud blue
  { hex: "#b08968", name: "Nocciola" }, // hazelnut
  { hex: "#f7f0e0", name: "Panna" }, // cream
];
export const COLOR_COUNT = PLAYER_COLORS.length;

// --- names -------------------------------------------------------------------

const NOUNS = [
  "Pesce", "Gelato", "Limone", "Polpo", "Gabbiano", "Granchio", "Delfino", "Pomodoro",
  "Basilico", "Cannolo", "Tonno", "Riccio", "Cavalluccio", "Carciofo", "Biscotto",
  "Fico", "Pinolo", "Scoglio", "Ravanello", "Tortellino", "Calamaro", "Gambero",
];
const ADJS = [
  "Veloce", "Furioso", "Allegro", "Pazzo", "Felice", "Coraggioso", "Dorato", "Ribelle",
  "Birichino", "Magnifico", "Salato", "Selvaggio", "Fortunato", "Volante", "Ruggente",
  "Brillante", "Curioso", "Frizzante", "Tremendo", "Gigante",
];

export function randomPlayerName(rand: () => number): string {
  const n = NOUNS[Math.floor(rand() * NOUNS.length)]!;
  const a = ADJS[Math.floor(rand() * ADJS.length)]!;
  return `${n} ${a}`;
}

export const ROOM_NAMES = [
  "Baia dei Gabbiani", "Cala Limone", "Punta Gelato", "Porto Sirena", "Scoglio Azzurro",
  "Spiaggia dei Fichi", "Marina Piccola", "Cala dei Polpi", "Isola Bella", "Capo Pistacchio",
  "Riva dei Pescatori", "Grotta Verde", "Lido Allegro", "Faro Rosso", "Molo Vecchio",
];

export const BOT_NAMES = [
  "Nonna Bot", "Robo Ciccio", "Bip Bop", "Signor Ingranaggio", "Tostapane", "Pilota Auto",
  "Bullone", "Cavo Elettrico", "Vite Sciolta", "Motorino", "Circuito", "Radar",
  "Antenna", "Transistor", "Bobina", "Dinamo", "Pixel", "Rotella", "Sprocket",
];

// --- sanitizers --------------------------------------------------------------

// Control chars, bidi overrides and zero-width chars never belong in a name.
const JUNK = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿]/g;

function clip(s: string, max: number): string {
  // Clip by code point so we never split a surrogate pair.
  const cps = Array.from(s);
  return cps.length > max ? cps.slice(0, max).join("") : s;
}

export function sanitizeName(raw: unknown, max = NAME_MAX): string {
  return clip(String(raw ?? "").replace(JUNK, "").replace(/\s+/g, " ").trim(), max).trim();
}

export function sanitizeChat(raw: unknown): string {
  return clip(String(raw ?? "").replace(JUNK, "").replace(/\s+/g, " ").trim(), CHAT_MAX);
}

/** Seeds are u32. Digits are taken literally (mod 2^32); any other text is hashed (FNV-1a). */
export function seedFromText(text: string): number {
  const t = text.trim();
  if (/^\d{1,10}$/.test(t)) return Number(t) % 4294967296;
  let h = 0x811c9dc5;
  for (const ch of t.toLowerCase()) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function randomSeed(rand: () => number): number {
  return Math.floor(rand() * 4294967296) >>> 0;
}

export function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return n < min ? min : n > max ? max : n;
}
