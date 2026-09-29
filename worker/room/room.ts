// IsolaRoom — one Durable Object per room code (/ws/room/:code).
//
// A thin shell: accepts sockets, owns the timers, and forwards everything to
// RoomCore (core.ts), which holds the state machine. Every entry point into
// the core is guarded so a throw can't take the room (and every player in it)
// down, and every send goes through a Conn that swallows dropped-peer errors.
//
// Standard accept(), not hibernation: the room is in-memory and a running
// match needs a 30 Hz setInterval anyway. When the last player is gone the
// core stops both timers, so an idle room holds nothing open.

import { DurableObject } from "cloudflare:workers";
import { Close, ErrCode, ErrorMsgDef, TICK_MS, encode, normalizeCode, type RoomListing } from "../../shared/net/index";
import { RoomCore, SERVICE_MS, type Conn } from "./core";
import { createMatchSim } from "./match";

export class IsolaRoom extends DurableObject<Env> {
  private core: RoomCore | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private serviceTimer: ReturnType<typeof setInterval> | null = null;
  /** Local dev (localhost): the match accepts DebugCmd and reports NetStats. */
  private dev = false;

  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/ws\/room\/([^/]+)$/);
    const code = m ? normalizeCode(m[1]!) : null;
    if (!code) return new Response("bad room code", { status: 400 });
    if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });

    this.dev = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    const core = this.getCore(code);
    const q = url.searchParams;
    const params = {
      token: q.get("tk") ?? "",
      name: q.get("name") ?? "",
      color: intParam(q.get("c")),
      world: intParam(q.get("w")),
    };

    if (core.isEmpty) {
      // A fresh room only opens for codes the lobby handed out (or still lists),
      // so a mistyped code doesn't silently create a ghost room.
      let claim = { ok: false, public: false };
      try {
        claim = await this.lobby().claim(code);
      } catch (e) {
        console.error(`room ${code}: lobby claim failed`, e);
      }
      if (!claim.ok && core.isEmpty) return refuse(ErrCode.NotFound, `No room with code ${code}.`, Close.NotFound);
      if (core.isEmpty) core.prepare({ public: claim.public, region: req.headers.get("x-isola-region") ?? "" });
    }

    const pair = new WebSocketPair();
    const ws = pair[1];
    ws.accept();
    const conn = wrap(ws);
    let joined = false;
    guard(() => {
      joined = core.join(conn, params);
    });
    if (joined) {
      // Binary frames are ArrayBuffers in production workerd but can arrive as
      // Blobs in local dev; normalize, keeping frames in order.
      let chain: Promise<void> | null = null;
      let pending = 0;
      const deliver = (d: ArrayBuffer | Uint8Array | string) => guard(() => core.message(conn, d));
      ws.addEventListener("message", (e) => {
        const d: unknown = e.data;
        if (!pending && (typeof d === "string" || d instanceof ArrayBuffer || ArrayBuffer.isView(d))) {
          deliver(ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : (d as ArrayBuffer | string));
          return;
        }
        pending++;
        const read =
          d && typeof (d as Blob).arrayBuffer === "function" ? (d as Blob).arrayBuffer() : Promise.resolve(d as ArrayBuffer);
        chain = (chain ?? Promise.resolve())
          .then(() => read)
          .then((buf) => deliver(buf))
          .catch((err: unknown) => console.error("room: bad frame", err))
          .finally(() => void pending--);
      });
      const drop = () => {
        guard(() => core.closed(conn));
        conn.close(1000, "bye");
      };
      ws.addEventListener("close", drop);
      ws.addEventListener("error", drop);
    }
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private getCore(code: string): RoomCore {
    if (this.core && this.core.code === code) return this.core;
    this.core = new RoomCore(code, {
      now: () => Date.now(),
      random: Math.random,
      setTicking: (on) => {
        if (this.tickTimer) clearInterval(this.tickTimer);
        this.tickTimer = on ? setInterval(() => guard(() => this.core?.tick()), TICK_MS) : null;
      },
      setService: (on) => {
        if (this.serviceTimer) clearInterval(this.serviceTimer);
        this.serviceTimer = on ? setInterval(() => guard(() => this.core?.service()), SERVICE_MS) : null;
      },
      report: (listing) => this.report(code, listing),
      createSim: (ctx) => createMatchSim(ctx, { debug: this.dev }),
      log: (...a) => console.log(...a),
    });
    return this.core;
  }

  private lobby() {
    return this.env.LOBBY.get(this.env.LOBBY.idFromName("global"));
  }

  private report(code: string, listing: RoomListing | null): void {
    const p = listing ? this.lobby().report(listing) : this.lobby().remove(code);
    p.catch((e: unknown) => console.error(`room ${code}: lobby report failed`, e));
  }
}

function intParam(v: string | null): number {
  if (v === null || v === "") return -1;
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : -1;
}

function guard(fn: () => void): void {
  try {
    fn();
  } catch (e) {
    console.error("room: uncaught", e);
  }
}

/** Accepts, explains, closes. Returning 101 lets the client read the reason. */
function refuse(code: ErrCode, text: string, close: number): Response {
  const pair = new WebSocketPair();
  const ws = pair[1];
  ws.accept();
  const conn = wrap(ws);
  conn.send(encode(ErrorMsgDef, { code, text }));
  conn.close(close, text.slice(0, 120));
  return new Response(null, { status: 101, webSocket: pair[0] });
}

/** Guarded socket: a vanished peer makes workerd throw from send/close. */
function wrap(ws: WebSocket): Conn {
  return {
    send(data) {
      if (ws.readyState !== undefined && ws.readyState !== 1) return false;
      try {
        ws.send(data);
        return true;
      } catch {
        return false;
      }
    },
    close(code, reason) {
      try {
        ws.close(code, reason);
      } catch {
        /* already closing or gone */
      }
    },
  };
}
