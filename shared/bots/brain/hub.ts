// Per-match state shared by every bot brain in one MatchSim: the bot world
// (nav graph, cover, POIs — built once per world), one budgeted PathPlanner,
// a danger heat map and a log of recent shots ("hearing"). The first brain
// to think in a sim step advances the hub, so it runs exactly once per step
// without the host having to call anything.
import type { MatchSim } from "../../sim/index";
import type { World } from "../../world/types";
import type { CollisionWorld } from "../../world/collide";
import { NF } from "../constants";
import { nearestNode } from "../nav";
import { buildBotWorld, type BotWorld } from "../index";
import { PathPlanner, type PathOptions, type PathResult, type Target } from "../path";
import { DangerMap } from "../tactics";

export interface ShotRec {
  /** Sim tick the ball was first seen. */
  tick: number;
  owner: number;
  x: number;
  y: number;
  z: number;
}

const SHOT_LOG = 128;
/** Path search node expansions per sim step (~0.6 µs each): ~0.7 ms per step worst case, shared by all bots. */
export const PATH_BUDGET = 1200;

const worlds = new WeakMap<World, BotWorld>();
const hubs = new WeakMap<MatchSim, BotHub>();

/**
 * Builds (or returns the cached) nav / cover / POI data for a world. Call it
 * once while the match is loading (~200 ms) so the first bot tick doesn't pay.
 */
export function prepareBotWorld(world: World, cw?: CollisionWorld): BotWorld {
  let bw = worlds.get(world);
  if (!bw) {
    bw = buildBotWorld(world, cw);
    worlds.set(world, bw);
  }
  return bw;
}

export function getHub(sim: MatchSim): BotHub {
  let h = hubs.get(sim);
  if (!h) {
    h = new BotHub(prepareBotWorld(sim.world, sim.env.cw));
    hubs.set(sim, h);
  }
  return h;
}

/** Players the bots must never target or notice (e.g. a spectating camera in debug tools). */
export function setBotIgnore(sim: MatchSim, ids: number[]): void {
  const h = getHub(sim);
  h.ignore.clear();
  for (const id of ids) h.ignore.add(id);
}

export class BotHub {
  readonly bw: BotWorld;
  readonly planner: PathPlanner;
  readonly danger = new DangerMap(16, 25);
  readonly ignore = new Set<number>();
  /** Last sim tick processed. */
  tick = -1;
  /** Ring buffer of recent shots. */
  readonly shots: ShotRec[] = [];
  shotHead = 0;
  private lastProj = 0;
  private waiting = new Map<number, (r: PathResult) => void>();
  private prevCoats = new Map<number, number>();
  private prevAlive = new Map<number, boolean>();
  /** Deep water nodes to wash in, one per ~20 m cell. */
  readonly washSpots: number[] = [];
  /** Cave floor nodes, one per ~14 m cell. */
  readonly caveSpots: number[] = [];
  /** Expansions spent by the planner (perf stats). */
  expansions = 0;
  budget = PATH_BUDGET;
  /**
   * 1 for nav regions you can drop into but never get out of (pits, slots:
   * the nav's components are weakly connected, so these look "reachable").
   * Goals there are refused.
   */
  readonly trapRegion: Uint8Array;

  constructor(bw: BotWorld) {
    this.bw = bw;
    this.planner = new PathPlanner(bw.nav);
    for (let i = 0; i < SHOT_LOG; i++) this.shots.push({ tick: -1, owner: -1, x: 0, y: 0, z: 0 });
    const g = bw.nav;
    const cell = (x: number, z: number, s: number) => Math.floor(x / s) * 4096 + Math.floor(z / s);
    const wash = new Map<number, number>(), cave = new Map<number, number>();
    for (let q = 0; q < g.n; q++) {
      const f = g.flags[q];
      if (f & NF.Wash && g.regions.comp[g.region[q]] === 0) {
        const k = cell(g.x[q], g.z[q], 20);
        if (!wash.has(k)) wash.set(k, q);
      }
      if (f & NF.Cave && f & NF.Land) {
        const k = cell(g.x[q], g.z[q], 14);
        if (!cave.has(k)) cave.set(k, q);
      }
    }
    this.washSpots.push(...wash.values());
    this.caveSpots.push(...cave.values());
    // regions that can reach the biggest region (reverse BFS over the region graph)
    const R = g.regions, rc = R.count;
    const size = new Int32Array(rc);
    for (let q = 0; q < g.n; q++) size[g.region[q]]++;
    let main = 0;
    for (let r = 1; r < rc; r++) if (size[r] > size[main]) main = r;
    const rstart = new Int32Array(rc + 1);
    for (let r = 0; r < rc; r++) for (let k = R.start[r]; k < R.start[r + 1]; k++) rstart[R.to[k] + 1]++;
    for (let r = 0; r < rc; r++) rstart[r + 1] += rstart[r];
    const fill = rstart.slice(0, rc), rfrom = new Int32Array(R.to.length);
    for (let r = 0; r < rc; r++) for (let k = R.start[r]; k < R.start[r + 1]; k++) rfrom[fill[R.to[k]]++] = r;
    const ok = new Uint8Array(rc);
    const stack = [main];
    ok[main] = 1;
    while (stack.length) {
      const r = stack.pop()!;
      for (let k = rstart[r]; k < rstart[r + 1]; k++) {
        const f = rfrom[k];
        if (!ok[f]) { ok[f] = 1; stack.push(f); }
      }
    }
    this.trapRegion = new Uint8Array(rc);
    for (let r = 0; r < rc; r++) this.trapRegion[r] = ok[r] ? 0 : 1;
  }

  /** Is (x, y, z) somewhere a bot could walk into but not out of? */
  isTrap(x: number, y: number, z: number): boolean {
    const g = this.bw.nav;
    const q = nearestNode(g, x, y, z, 4);
    return q >= 0 && this.trapRegion[g.region[q]] === 1;
  }

  /** Advance shared state once per sim step (idempotent within a step). */
  update(sim: MatchSim): void {
    if (sim.tick === this.tick) return;
    this.tick = sim.tick;
    // new balls in flight = shots somebody can hear
    const pr = sim.projectiles;
    let maxId = this.lastProj;
    for (let i = pr.length - 1; i >= 0; i--) {
      const b = pr[i];
      if (b.id <= this.lastProj) break;
      if (b.id > maxId) maxId = b.id;
      const s = this.shots[this.shotHead];
      this.shotHead = (this.shotHead + 1) % SHOT_LOG;
      s.tick = sim.tick; s.owner = b.owner; s.x = b.x; s.y = b.y; s.z = b.z;
    }
    this.lastProj = maxId;
    // hits and eliminations heat up the danger map
    for (const p of sim.players) {
      const c = p.coats.length, pc = this.prevCoats.get(p.id) ?? 0;
      const wasAlive = this.prevAlive.get(p.id) ?? p.alive;
      if (p.alive && c > pc) this.danger.bump(p.x, p.z, 0.35 * (c - pc), 22);
      if (wasAlive && !p.alive) this.danger.bump(p.x, p.z, 1.2, 30);
      this.prevCoats.set(p.id, c);
      this.prevAlive.set(p.id, p.alive);
    }
    if (sim.tick % 30 === 0) this.danger.decay(0.5);
    // path searches: fixed budget per step, results dispatched to the requesting brains
    if (this.planner.pending > 0) {
      const done = this.planner.update(this.budget);
      for (const d of done) {
        this.expansions += d.result.expanded;
        const cb = this.waiting.get(d.ticket);
        if (cb) {
          this.waiting.delete(d.ticket);
          cb(d.result);
        }
      }
    }
  }

  request(from: Target, to: Target, opts: PathOptions, cb: (r: PathResult) => void): number {
    const t = this.planner.request(from, to, opts);
    this.waiting.set(t, cb);
    return t;
  }

  cancel(ticket: number): void {
    if (ticket <= 0) return;
    this.waiting.delete(ticket);
    this.planner.cancel(ticket);
  }

  /** Recent shots after tick `since` (newest last), appended to out. */
  shotsSince(since: number, out: ShotRec[]): ShotRec[] {
    out.length = 0;
    for (let k = 0; k < SHOT_LOG; k++) {
      const s = this.shots[(this.shotHead + k) % SHOT_LOG];
      if (s.tick > since) out.push(s);
    }
    return out;
  }
}
