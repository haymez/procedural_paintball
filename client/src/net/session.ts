// Per-tab identity and local preferences.
//
// The room token lives in sessionStorage, per room code: two tabs on one
// machine are two players (how you playtest alone), and a reload keeps the
// token, which is what lets the server hand a dropped player their slot back.

import { CODE_RE, COLOR_COUNT, normalizeCode, randomPlayerName } from "../../../shared/net/index";

function store(kind: "local" | "session"): Storage | null {
  try {
    return kind === "local" ? localStorage : sessionStorage;
  } catch {
    return null;
  }
}

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function tokenFor(code: string): string {
  const s = store("session");
  const key = `isola:tk:${code}`;
  const existing = s?.getItem(key);
  if (existing) return existing;
  const tk = newToken();
  s?.setItem(key, tk);
  return tk;
}

/** Forget this tab's identity for a room (after leaving on purpose). */
export function forgetToken(code: string): void {
  store("session")?.removeItem(`isola:tk:${code}`);
}

export const prefs = {
  get name(): string {
    const v = store("local")?.getItem("isola:name");
    if (v) return v;
    const n = randomPlayerName(Math.random);
    store("local")?.setItem("isola:name", n);
    return n;
  },
  set name(v: string) {
    store("local")?.setItem("isola:name", v);
  },
  /** Preferred color index, -1 = none yet. */
  get color(): number {
    const v = Number(store("local")?.getItem("isola:color") ?? "-1");
    return Number.isInteger(v) && v >= 0 && v < COLOR_COUNT ? v : -1;
  },
  set color(v: number) {
    store("local")?.setItem("isola:color", String(v));
  },
};

/** `/r/ABCD` -> "ABCD". */
export function codeFromPath(path: string): string | null {
  const m = path.match(/^\/r\/([^/]+)\/?$/);
  if (!m) return null;
  const c = normalizeCode(decodeURIComponent(m[1]!));
  return c && CODE_RE.test(c) ? c : null;
}

export function roomPath(code: string): string {
  return `/r/${code}`;
}

export function inviteLink(code: string): string {
  return `${location.origin}${roomPath(code)}`;
}

export function wsUrl(path: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${path}`;
}
