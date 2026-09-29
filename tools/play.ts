// Offline playable entry: the whole match sim runs in the page.
//   /tools/play.html?seed=42&dummies=8&quality=medium&spawn=x,z&duration=600&fps=1
//   /tools/play.html?seed=42&bots=12&difficulty=hard   real bot brains (shared/bots/brain) instead of dummies
//     &spectate=1  bots ignore you (camera mode for screenshots; see __debug.bots() / __debug.watch(i))
// Sets window.__ready when playable; exposes window.__stats and window.__debug
// (see Game.debugApi: state(), teleport(), input({moveZ:1, sprint:true}, 1500), give("Scope")…).
import { loadWorld } from "../client/src/world/load";
import { createWorldRenderer, createWorldView, type Quality } from "../client/src/render/worldView";
import { LocalSource } from "../client/src/game/source";
import { Game } from "../client/src/game/game";
import { loadSettings } from "../client/src/game/settings";
import { showLoading } from "../client/src/game/loading";
import { BLOB_COLORS } from "../client/src/render/actors/index";
import { dummyName } from "../client/src/game/names";
import { Move, type Dummy, type MatchSim } from "../shared/sim/index";
import { BotBrain, prepareBotWorld, setBotIgnore, ST_NAMES } from "../shared/bots/brain/index";

const W = window as unknown as { __ready: boolean; __stats: Record<string, unknown>; __debug: Record<string, unknown> };
const params = new URLSearchParams(location.search);
const seed = Number(params.get("seed") ?? 42);
const settings = loadSettings();
const quality = (params.get("quality") ?? settings.quality) as Quality;
const nBots = Number(params.get("bots") ?? 0);
const dummies = Number(params.get("dummies") ?? (nBots > 0 ? 0 : 6));
const difficulty = ["easy", "normal", "hard"].indexOf(params.get("difficulty") ?? "normal");
const duration = params.has("duration") ? Number(params.get("duration")) : undefined;
if (params.get("fps") === "1") settings.showFps = true;
if (params.has("sens")) settings.sensitivity = Number(params.get("sens"));

const mount = document.getElementById("game")!;

async function main(): Promise<void> {
  const loading = showLoading(mount, `Isola · seed ${seed}`);
  const world = await loadWorld(seed, (stage, t) => loading.progress(stage, t * 0.85));
  loading.progress("painting the island", 0.9);
  await new Promise((r) => setTimeout(r, 0));
  const renderer = createWorldRenderer(undefined, quality);
  mount.appendChild(renderer.domElement);
  const view = createWorldView(renderer, world, { quality });
  view.finishLoading();
  const source = new LocalSource(world, { dummies, name: params.get("name") ?? "Tu", color: BLOB_COLORS[Number(params.get("color") ?? 0) % BLOB_COLORS.length], durationSec: duration });
  const brains: BotBrain[] = [];
  if (nBots > 0) {
    // real bot brains: they ride LocalSource's dummy loop (it only needs .id and .think(sim, dt))
    loading.progress("teaching the bots", 0.95);
    await new Promise((r) => setTimeout(r, 0));
    prepareBotWorld(world, source.env.cw);
    for (let i = 0; i < nBots; i++) {
      const id = 200 + i;
      const brain = new BotBrain({ id, seed, difficulty: difficulty < 0 ? 1 : difficulty, name: dummyName(i + 3) });
      source.sim.addPlayer(id, { name: dummyName(i + 3), color: BLOB_COLORS[(i + 1 + dummies) % BLOB_COLORS.length], isBot: true });
      brains.push(brain);
      source.dummies.push({ id, think: (sim: MatchSim, dt: number) => brain.think(sim, id, dt) } as unknown as Dummy);
    }
    if (params.get("spectate") === "1") setBotIgnore(source.sim, [source.localId]);
  }
  if (params.has("spawn")) {
    const [x, z] = params.get("spawn")!.split(",").map(Number);
    source.sim.teleport(source.localId, x, NaN, z);
  }
  const game = new Game({
    mount, world, source, renderer, view, settings,
    onLeave: () => location.reload(),
    onPlayAgain: () => location.reload(),
  });
  W.__debug = game.debugApi();
  const moveName = (m: number) => Object.entries(Move).find(([, v]) => v === m)?.[0];
  /** Bot brains: what each is doing. */
  W.__debug.bots = () => brains.map((b) => {
    const p = source.sim.player(b.id)!;
    const d = b.debug();
    return { id: b.id, name: b.name, pers: b.personality, state: ST_NAMES[d.state], target: d.target, x: +p.x.toFixed(1), y: +p.y.toFixed(1), z: +p.z.toFixed(1), move: moveName(p.move), coats: p.coats.length, score: p.score };
  });
  /** Put the camera (you) `back` m behind bot i, `up` m above, looking at it. */
  W.__debug.watch = (i: number, back = 7, up = 2.5, side = 0) => {
    const b = brains[i];
    const p = b && source.sim.player(b.id);
    if (!p) return false;
    const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw);
    source.sim.teleport(source.localId, p.x - fx * back - fz * side, p.y + up, p.z - fz * back + fx * side);
    const me = source.me()!;
    me.vx = 0; me.vy = 0; me.vz = 0;
    (W.__debug.lookAt as (x: number, y: number, z: number) => boolean)(p.x, p.y + 1, p.z);
    return true;
  };
  /** Frame bot i and whoever it's fighting from the side (falls back to watch()). */
  W.__debug.watchFight = (i: number, dist = 1, up = 3) => {
    const b = brains[i];
    const p = b && source.sim.player(b.id);
    const t = p && source.sim.player(b.debug().target);
    if (!p || !t) return (W.__debug.watch as (i: number) => boolean)(i);
    const mx = (p.x + t.x) / 2, mz = (p.z + t.z) / 2, my = Math.max(p.y, t.y);
    const dx = t.x - p.x, dz = t.z - p.z, d = Math.hypot(dx, dz) || 1;
    const off = Math.max(7, d * 0.75) * dist;
    // pick the side with open air (higher camera spot = less likely inside a hill)
    source.sim.teleport(source.localId, mx - (dz / d) * off, my + up, mz + (dx / d) * off);
    const me = source.me()!;
    me.vx = 0; me.vy = 0; me.vz = 0;
    (W.__debug.lookAt as (x: number, y: number, z: number) => boolean)(mx, (p.y + t.y) / 2 + 1, mz);
    return true;
  };
  /** First bot index in a given state (e.g. "engage", "wash", "cover"), or -1. */
  W.__debug.findBot = (state: string, move?: string) => brains.findIndex((b) => {
    const p = source.sim.player(b.id)!;
    return p.alive && ST_NAMES[b.state] === state && (!move || moveName(p.move) === move);
  });
  W.__stats = {};
  game.start();
  loading.progress("ready", 1);
  let frames = 0;
  game.frameHook = () => {
    W.__stats = game.getStats();
    if (++frames === 4) {
      loading.done();
      W.__ready = true;
    }
  };
}

main().catch((e) => {
  console.error(e);
  mount.innerHTML = `<pre style="color:#fff;padding:20px">${String(e?.stack ?? e)}</pre>`;
});
