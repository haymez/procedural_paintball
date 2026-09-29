// IsolaLobby — singleton ("global") registry of rooms.
//
//   GET  /api/rooms          public room list (JSON)
//   POST /api/rooms          reserve a new code  {public?: boolean} -> {code}
//   POST /api/quick          best public room with a seat, or a new one -> {code, created}
//   GET  /api/rooms/:code    does this code exist? -> {code, exists, public, players, phase}
//   GET  /ws/lobby           binary LobbyList pushes (WebSocket Hibernation API)
//
// Rooms call report()/remove()/claim() over DO RPC. The registry is mirrored
// into the SQLite-backed KV so a hibernation eviction doesn't lose it; an
// alarm sweeps rooms that stopped heartbeating.

import { DurableObject } from "cloudflare:workers";
import { LobbyList, encode, normalizeCode, type RoomListing } from "../../shared/net/index";
import { LobbyRegistry, type Reservation } from "./registry";

const SWEEP_MS = 30_000;
const PUSH_COALESCE_MS = 250;

export class IsolaLobby extends DurableObject<Env> {
  private readonly reg: LobbyRegistry;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const kv = ctx.storage.kv;
    this.reg = new LobbyRegistry({
      putRoom: (c, l) => kv.put(`r:${c}`, l),
      deleteRoom: (c) => void kv.delete(`r:${c}`),
      putReservation: (c, r) => kv.put(`v:${c}`, r),
      deleteReservation: (c) => void kv.delete(`v:${c}`),
    });
    const rooms: RoomListing[] = [];
    for (const [, l] of kv.list<RoomListing>({ prefix: "r:" })) rooms.push(l);
    const res: [string, Reservation][] = [];
    for (const [k, r] of kv.list<Reservation>({ prefix: "v:" })) res.push([k.slice(2), r]);
    this.reg.load(rooms, res, Date.now());
  }

  // --- RPC (called by IsolaRoom) ------------------------------------------------

  async report(listing: RoomListing): Promise<void> {
    if (this.reg.report(listing, Date.now())) this.schedulePush();
    await this.ensureAlarm();
  }

  async remove(code: string): Promise<void> {
    if (this.reg.remove(code)) this.schedulePush();
  }

  async claim(code: string): Promise<{ ok: boolean; public: boolean }> {
    return this.reg.claim(code);
  }

  // --- HTTP / WebSocket -------------------------------------------------------------

  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/ws/lobby") {
      if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
      const pair = new WebSocketPair();
      const server = pair[1];
      this.ctx.acceptWebSocket(server);
      try {
        server.send(encode(LobbyList, { rooms: this.reg.publicList() }));
      } catch {
        /* gone already */
      }
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (path === "/api/rooms" && req.method === "GET") {
      return json({ rooms: this.reg.publicList() });
    }
    if (path === "/api/rooms" && req.method === "POST") {
      const body = await readJson(req);
      const code = this.reg.create(body?.public === true, Date.now(), Math.random);
      await this.ensureAlarm();
      return json({ code });
    }
    if (path === "/api/quick" && req.method === "POST") {
      const r = this.reg.quickJoin(Date.now(), Math.random);
      if (r.created) await this.ensureAlarm();
      return json(r);
    }
    const m = path.match(/^\/api\/rooms\/([^/]+)$/);
    if (m && req.method === "GET") {
      const code = normalizeCode(decodeURIComponent(m[1]!));
      // 200 either way: "no such room" is an answer, not an error.
      if (!code) return json({ code: m[1], exists: false });
      return json(this.reg.lookup(code));
    }
    return new Response("not found", { status: 404 });
  }

  override async webSocketMessage(ws: WebSocket, _msg: string | ArrayBuffer): Promise<void> {
    // Any message is a request for the current list.
    try {
      ws.send(encode(LobbyList, { rooms: this.reg.publicList() }));
    } catch {
      /* gone */
    }
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "bye");
    } catch {
      /* already closed */
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011, "error");
    } catch {
      /* already closed */
    }
  }

  override async alarm(): Promise<void> {
    if (this.reg.sweep(Date.now())) this.schedulePush();
    if (!this.reg.isEmpty) await this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
  }

  // --- helpers ------------------------------------------------------------------------

  private async ensureAlarm(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
  }

  private schedulePush(): void {
    if (this.pushTimer) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      const sockets = this.ctx.getWebSockets();
      if (!sockets.length) return;
      const bytes = encode(LobbyList, { rooms: this.reg.publicList() });
      for (const ws of sockets) {
        try {
          ws.send(bytes);
        } catch {
          /* dropped peer; its close event cleans up */
        }
      }
    }, PUSH_COALESCE_MS);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const v = (await req.json()) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
