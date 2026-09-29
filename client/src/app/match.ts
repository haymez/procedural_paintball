// The seam between the menus and the game.
//
// When the room enters loading (or a late joiner / reloaded tab needs the
// world), the app calls startMatch(ctx) exactly once for that match and
// shows the loading screen. The game:
//   1. generates the world from ctx.seed, reporting ctx.loading.setProgress(stage, t)
//   2. calls ctx.worldReady(checksum) — the server starts the match when every
//      connected player is ready (late joiners drop straight in)
//   3. gets handle.begin(info) when the server lets this player in; the app
//      reveals ctx.mount (a full-screen container) at the same moment
//   4. talks to the server with ctx.net.send / ctx.net.on (match messages,
//      ids 64+ in shared/net/match.ts) and reads ctx.net.serverNow()
//   5. gets handle.dispose() when the match ends (results), is aborted, or the
//      player leaves the room. Tear down everything; the mount is emptied after.
//
// The implementation is the networked game in client/src/game/index.ts.

import type { MatchBeginMsg, MsgDef } from "../../../shared/net/index";
import type { RoomClient } from "../net/room";

export interface MatchNet {
  send<T>(def: MsgDef<T>, msg: T): boolean;
  /** Subscribe to a server message; returns an unsubscribe function. */
  on<T>(def: MsgDef<T>, fn: (msg: T) => void): () => void;
  /** Estimated server clock (ms, server's Date.now()). */
  serverNow(): number;
  /** Smoothed round trip (ms). */
  rtt(): number;
  /** Tighten pings during play (default 2000 ms). */
  setPingInterval(ms: number): void;
}

export interface MatchContext {
  seed: number;
  /** Live room: state (players, settings, phase), me, events. */
  room: RoomClient;
  net: MatchNet;
  /** Full-screen container for the game; hidden until begin(). */
  mount: HTMLElement;
  loading: {
    /** Drives the loading screen and relays progress to the other players. */
    setProgress(stage: string, t: number): void;
  };
  /** Report the finished world. Call once. */
  worldReady(checksum: number): void;
  /** Leave the match view: the host returns the whole room to the lobby; others leave the room. */
  exit(): void;
}

export interface MatchHandle {
  begin(info: MatchBeginMsg): void;
  dispose(): void;
}

export type StartMatch = (ctx: MatchContext) => MatchHandle;

// The game (three.js and all) loads on demand so the menus stay light.
// Network shim first: byte counters + ?lag=&jitter=&loss= simulation must
// wrap WebSocket before the room connection opens.
import { installNetShim } from "../game/net/lagsim";
installNetShim(location.search);

type GameModule = typeof import("../game/index");
let gameModule: Promise<GameModule> | null = null;
export function loadGame(): Promise<GameModule> {
  return (gameModule ??= import("../game/index"));
}

export const startMatch: StartMatch = (ctx) => {
  let inner: MatchHandle | null = null;
  let begun: MatchBeginMsg | null = null;
  let disposed = false;
  loadGame()
    .then((m) => {
      if (disposed) return;
      inner = m.startMatch(ctx);
      if (begun) inner.begin(begun);
    })
    .catch((e) => console.error("[match] failed to load the game", e));
  return {
    begin(info) {
      begun = info;
      inner?.begin(info);
    },
    dispose() {
      disposed = true;
      inner?.dispose();
    },
  };
};
