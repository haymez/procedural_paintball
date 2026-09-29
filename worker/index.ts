// Worker entry: routes sockets and the lobby API to the Durable Objects.
//   /ws/room/:code      -> IsolaRoom (one per code)
//   /ws/lobby, /api/*   -> IsolaLobby ("global")
export { IsolaLobby } from "./lobby/lobby";
export { IsolaRoom } from "./room/room";
import { normalizeCode } from "../shared/net/index";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const room = url.pathname.match(/^\/ws\/room\/([^/]+)$/);
    if (room) {
      const code = normalizeCode(decodeURIComponent(room[1]!));
      if (!code) return new Response("bad room code", { status: 400 });
      // Region hint for the room list (the DO sees it on its first join).
      const cf = (req as Request & { cf?: { colo?: string; country?: string } }).cf;
      const headers = new Headers(req.headers);
      headers.set("x-isola-region", String(cf?.colo ?? cf?.country ?? "local"));
      const fwd = new Request(new URL(`/ws/room/${code}${url.search}`, url), { headers, method: req.method });
      return env.ROOM.get(env.ROOM.idFromName(code)).fetch(fwd);
    }
    if (url.pathname === "/ws/lobby" || url.pathname.startsWith("/api/")) {
      return env.LOBBY.get(env.LOBBY.idFromName("global")).fetch(req);
    }
    return new Response("not found", { status: 404 });
  },
};
