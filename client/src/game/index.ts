// Lobby entry: the networked match behind the app's StartMatch seam
// (client/src/app/match.ts loads this module lazily).
//
//   startMatch(ctx)  generate the world (Web Worker), report worldReady, and
//                    listen for match messages right away (the server's
//                    MatchInit + snapshots can arrive before MatchBegin).
//   begin(info)      once the first snapshot is in: renderer, world view and
//                    the Game over a RemoteSource.
//
// Debug (window.__debug): the Game's hooks plus net helpers — net(), players(),
// aimAt(id), and server-side dev commands tp(x, z), bots(mode), summon(id, d).
import type { MatchContext, MatchHandle } from "../app/match";
import {
  DebugCmd, DebugOp, ErrCode, MatchInit, NetStats, Roster, Snapshot,
  type MatchInitMsg, type NetStatsMsg, type RosterMsg, type SnapshotMsg,
} from "../../../shared/net/index";
import { createEnv } from "../../../shared/sim/index";
import { worldChecksum } from "../../../shared/world/checksum";
import type { World } from "../../../shared/world/types";
import { createWorldRenderer, createWorldViewAsync, type WorldView } from "../render/worldView";
import { loadWorld } from "../world/load";
import { Game } from "./game";
import { NetClient } from "./net/client";
import { NetOverlay } from "./net/overlay";
import { netFlags } from "./net/lagsim";
import { RemoteSource } from "./net/remote";
import { loadSettings } from "./settings";
import { sfxReady } from "./sfx";

export { Game } from "./game";
export { LocalSource, type GameSource } from "./source";
export { startPractice } from "./practice";

type Buffered =
  | { k: "init"; m: MatchInitMsg }
  | { k: "roster"; m: RosterMsg }
  | { k: "snap"; m: SnapshotMsg; at: number }
  | { k: "stats"; m: NetStatsMsg };

export function startMatch(ctx: MatchContext): MatchHandle {
  let disposed = false;
  let world: World | null = null;
  let net: NetClient | null = null;
  let game: Game | null = null;
  let view: WorldView | null = null;
  let overlay: NetOverlay | null = null;
  let renderer: ReturnType<typeof createWorldRenderer> | null = null;
  let waitTimer: ReturnType<typeof setTimeout> | null = null;
  const settings = loadSettings();
  const buffered: Buffered[] = [];
  const params = new URLSearchParams(location.search);

  const feed = (b: Buffered) => {
    if (!net) {
      buffered.push(b);
      return;
    }
    if (b.k === "init") net.onInit(b.m);
    else if (b.k === "roster") net.onRoster(b.m);
    else if (b.k === "snap") net.onSnapshot(b.m, b.at);
    else net.onStats(b.m);
  };
  const offs = [
    ctx.net.on(MatchInit, (m) => feed({ k: "init", m })),
    ctx.net.on(Roster, (m) => feed({ k: "roster", m })),
    ctx.net.on(Snapshot, (m) => feed({ k: "snap", m, at: performance.now() })),
    ctx.net.on(NetStats, (m) => feed({ k: "stats", m })),
    ctx.room.onEvent("error", (e) => {
      if (e.code === ErrCode.WorldMismatch) console.error(`[net] WORLD CHECKSUM MISMATCH for seed ${ctx.seed}: ${e.text}`);
    }),
  ];
  ctx.net.setPingInterval(1000);

  // Loading = generate (worker) → build the renderer's world (meshes, caves)
  // → sound bank; all behind the loading screen, so the match starts hitch-free.
  const GEN = 0.62, BUILD = 0.94;
  loadWorld(ctx.seed, (stage, t) => ctx.loading.setProgress(stage, t * GEN))
    .then(async (w) => {
      if (disposed) return;
      const sum = worldChecksum(w);
      console.info(`[net] world #${ctx.seed} checksum ${sum}`);
      const r = createWorldRenderer(undefined, settings.quality);
      renderer = r;
      r.domElement.style.visibility = "hidden";
      ctx.mount.style.position = ctx.mount.style.position || "fixed";
      ctx.mount.appendChild(r.domElement);
      const v = await createWorldViewAsync(r, w, { quality: settings.quality }, (step, t) => {
        if (!disposed) ctx.loading.setProgress(`render:${step}`, GEN + (BUILD - GEN) * t);
      });
      if (disposed) { v.dispose(); return; }
      view = v;
      ctx.loading.setProgress("audio", BUILD);
      await sfxReady(3000);
      if (disposed) return;
      ctx.loading.setProgress("done", 1);
      world = w;
      ctx.worldReady(sum);
    })
    .catch((e) => console.error("[game] world generation failed", e));

  const makeNet = (w: World): NetClient => {
    const n = new NetClient(w, createEnv(w), ctx.room.me, {
      send: (def, msg) => ctx.net.send(def, msg),
      now: () => performance.now(),
      serverNow: () => ctx.net.serverNow(),
      endsAt: () => ctx.room.begin?.endsAt ?? null,
    });
    for (const b of buffered.splice(0)) {
      net = n;
      feed(b);
    }
    return n;
  };

  const launch = () => {
    if (disposed || !world || !net) return;
    if (!net.ready) {
      waitTimer = setTimeout(launch, 30);
      return;
    }
    if (!renderer || !view) return;
    renderer.domElement.style.visibility = "";
    for (const p of net.paintInit) view.paint.splat(p.x, p.y, p.z, p.nx, p.ny, p.nz, p.r, p.color);
    net.paintInit = [];
    const source = new RemoteSource(net);
    game = new Game({
      mount: ctx.mount, world, source, renderer, view, settings, intro: true,
      onLeave: () => ctx.exit(),
      onPlayAgain: () => ctx.exit(),
    });
    overlay = new NetOverlay(ctx.mount, net, () => ctx.net.rtt(), netFlags.overlay || params.get("net") === "1");
    const n = net;
    const send = (op: number, a = 0, b = 0, c = NaN) => ctx.net.send(DebugCmd, { op, a, b, c });
    const W = window as unknown as { __debug: Record<string, unknown>; __stats: unknown; __netgame: unknown };
    const g = game;
    W.__debug = {
      ...g.debugApi(),
      net: () => ({ stats: n.stats, totals: n.totals, ack: n.ackSeq, unacked: n.unackedCount, renderTick: n.renderTick, presentTick: n.presentTick, rates: overlay?.rates }),
      players: () => n.snap.players.map((p) => ({ id: p.id, x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2), alive: p.alive, coats: p.coats.length, move: p.move, score: p.score })),
      /** Point the camera at a player's chest (as displayed here). */
      aimAt: (id: number, lead = 0) => {
        const t = n.snap.players.find((p) => p.id === id);
        const me = n.me();
        if (!t || !me) return false;
        const x = t.x + t.vx * lead, y = t.y + 1.0, z = t.z + t.vz * lead;
        g.input.yaw = Math.atan2(x - me.x, z - me.z);
        g.input.pitch = Math.atan2(y - (me.y + 1.55), Math.hypot(x - me.x, z - me.z));
        return true;
      },
      tp: (x: number, z: number) => send(DebugOp.Teleport, x, z),
      bots: (mode: number) => send(DebugOp.Bots, mode),
      summon: (id: number, dist = 10) => send(DebugOp.Summon, id, dist),
      noShield: () => send(DebugOp.NoShield),
      overlay: (on?: boolean) => { overlay?.toggle(on); return true; },
    };
    W.__netgame = { ready: true, localId: n.localId };
    let frames = 0;
    g.frameHook = () => {
      if (++frames % 15 === 0) W.__stats = { ...g.getStats(), rtt: Math.round(ctx.net.rtt()), ...n.stats, server: undefined };
    };
    game.start();
  };

  // The world may finish before or after begin(); the NetClient needs it.
  const tryMakeNet = () => {
    if (disposed) return;
    if (!world) {
      waitTimer = setTimeout(tryMakeNet, 30);
      return;
    }
    net ??= makeNet(world);
    launch();
  };

  return {
    begin() {
      if (disposed) return;
      tryMakeNet();
    },
    dispose() {
      disposed = true;
      if (waitTimer) clearTimeout(waitTimer);
      offs.forEach((o) => o());
      ctx.net.setPingInterval(2000);
      overlay?.dispose();
      game?.dispose();
      view?.dispose();
      renderer?.dispose();
      renderer?.forceContextLoss(); // free the GPU context now, not whenever GC gets to it
      renderer?.domElement.remove();
      game = null;
      net = null;
      view = null;
      renderer = null;
      const W = window as unknown as { __netgame?: unknown };
      W.__netgame = undefined;
    },
  };
}
