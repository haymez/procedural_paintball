// A binary WebSocket that reconnects with backoff and dispatches typed messages.
//
// Close codes in FATAL_CLOSE_CODES (room not found, full, left, …) end it for
// good; anything else — a network blip, a laptop lid — retries with backoff
// capped well inside the server's 20 s grace window.

import {
  Dispatcher,
  FATAL_CLOSE_CODES,
  ProtoError,
  decode,
  encode,
  type MsgDef,
  type Registry,
} from "../../../shared/net/index";

export type ConnStatus = "connecting" | "open" | "reconnecting" | "offline" | "closed";

const BASE_BACKOFF = 250;
const MAX_BACKOFF = 3000;
/** After this many failed attempts in a row the status reads "offline". */
const OFFLINE_AFTER = 5;

export interface ConnectionOptions {
  /** Built fresh for every attempt (query params may change between attempts). */
  url: () => string;
  /** Registry for incoming frames. */
  registry: Registry;
  /** Called on every successful (re)open, before queued sends. */
  onOpen?: () => void;
}

export class Connection {
  status: ConnStatus = "connecting";
  /** Set when the socket closed for good. */
  closeInfo: { code: number; reason: string } | null = null;
  /** Consecutive failed attempts. */
  fails = 0;

  private ws: WebSocket | null = null;
  private backoff = BASE_BACKOFF;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private readonly dispatcher = new Dispatcher<void>();
  private readonly statusFns = new Set<(s: ConnStatus) => void>();
  private readonly anyFns = new Set<(def: MsgDef<unknown>, msg: unknown) => void>();

  constructor(private readonly opts: ConnectionOptions) {
    this.open();
  }

  on<T>(def: MsgDef<T>, fn: (msg: T) => void): () => void {
    return this.dispatcher.on(def, (m) => fn(m));
  }

  /** Every decoded message (after typed handlers). */
  onAny(fn: (def: MsgDef<unknown>, msg: unknown) => void): () => void {
    this.anyFns.add(fn);
    return () => this.anyFns.delete(fn);
  }

  onStatus(fn: (s: ConnStatus) => void): () => void {
    this.statusFns.add(fn);
    return () => this.statusFns.delete(fn);
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Sends if open; returns false otherwise (no queueing — callers resend state on open). */
  send<T>(def: MsgDef<T>, msg: T): boolean {
    return this.sendRaw(encode(def, msg));
  }

  sendRaw(bytes: Uint8Array<ArrayBuffer>): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(bytes);
      return true;
    } catch {
      return false;
    }
  }

  /** Close for good (no reconnect). */
  close(code = 1000, reason = "bye"): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close(code, reason);
    } catch {
      /* already closing */
    }
    this.closeInfo ??= { code, reason };
    this.setStatus("closed");
  }

  /** Drop the socket as if the network blipped (testing / debug). */
  simulateDrop(): void {
    try {
      this.ws?.close(4000, "simulated drop");
    } catch {
      /* ignore */
    }
  }

  /** Try again now (e.g. after "offline", or a user click). */
  retryNow(): void {
    if (this.stopped) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.backoff = BASE_BACKOFF;
    if (!this.ws) this.open();
  }

  private setStatus(s: ConnStatus): void {
    if (s === this.status) return;
    this.status = s;
    for (const fn of [...this.statusFns]) fn(s);
  }

  private open(): void {
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.url());
    } catch {
      this.scheduleRetry();
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.addEventListener("open", () => {
      if (this.ws !== ws) return;
      this.fails = 0;
      this.backoff = BASE_BACKOFF;
      this.setStatus("open");
      this.opts.onOpen?.();
    });

    ws.addEventListener("message", (e) => {
      if (this.ws !== ws || !(e.data instanceof ArrayBuffer)) return;
      let d;
      try {
        d = decode(this.opts.registry, e.data);
      } catch (err) {
        if (err instanceof ProtoError) console.warn("net: bad frame", err.message);
        else throw err;
        return;
      }
      this.dispatcher.dispatch(d);
      for (const fn of [...this.anyFns]) fn(d.def, d.msg);
    });

    ws.addEventListener("close", (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.stopped) return;
      if (FATAL_CLOSE_CODES.includes(e.code)) {
        this.stopped = true;
        this.closeInfo = { code: e.code, reason: e.reason };
        this.setStatus("closed");
        return;
      }
      this.scheduleRetry();
    });

    ws.addEventListener("error", () => {
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    });
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    this.fails++;
    this.setStatus(this.fails > OFFLINE_AFTER ? "offline" : "reconnecting");
    const delay = this.backoff * (0.8 + Math.random() * 0.4);
    this.backoff = Math.min(this.backoff * 1.6, MAX_BACKOFF);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.open();
    }, delay);
  }
}
