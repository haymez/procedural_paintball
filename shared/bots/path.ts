// Pathfinding over the nav graph: hierarchical corridor A* (region graph
// first, then node-level A* restricted to the corridor), string-pulling with
// walkability line checks, a resumable budgeted planner for many bots, and
// Dijkstra "nearest X" searches. Deterministic (ties break on node index).
import { sdf, type Vec3 } from "../world/collide";
import { Heap, N } from "../world/grid";
import { WORLD_HALF } from "../world/types";
import { Act, ACT_NAMES, DEFAULT_ACTS, EDGE_SLOPE, NF, RUN_SPEED, AGENT_H, type Act as ActT, type ActionName } from "./constants";
import { nearestNode, type NavGraph, type NavPatch } from "./nav";
import type { DangerMap } from "./tactics";

export interface PathOptions {
  /** Allowed actions, bitmask of 1 << Act.X (default: all but Act.Vehicle). */
  allow?: number;
  /** Multiplier on swim / dive costs: > 1 avoids water, < 1 seeks it (washing paint). Default 1. */
  swimCost?: number;
  /** Extra cost for crossing dangerous ground: cost *= 1 + dangerWeight * danger. */
  danger?: DangerMap;
  dangerWeight?: number;
  /** Node expansions before giving up with the best partial path (default 60000). */
  maxExpansions?: number;
  /** Heuristic weight (default 1.5: ~2-3% longer than optimal, ~8x fewer expansions; 1 = optimal within the corridor). */
  heuristicWeight?: number;
  /** Use the region corridor (default true). */
  hierarchical?: boolean;
  /** String-pull the node path (default true). */
  smooth?: boolean;
}

export interface Waypoint {
  x: number;
  y: number;
  z: number;
  /** How to get here from the previous waypoint (first waypoint: Walk). */
  act: ActT;
  action: ActionName;
  node: number;
  /** Zipline / vehicle index for Zipline / Vehicle waypoints, else -1. */
  link: number;
}

export interface PathResult {
  ok: boolean;
  /** Ran out of expansions: waypoints lead to the node closest to the goal. */
  partial: boolean;
  waypoints: Waypoint[];
  /** Raw node path and the action into each node. */
  nodes: number[];
  acts: number[];
  /** Estimated travel time (s). */
  cost: number;
  expanded: number;
}

export type Target = Vec3 | number;

const EMPTY = (expanded = 0): PathResult => ({ ok: false, partial: false, waypoints: [], nodes: [], acts: [], cost: 0, expanded });

function resolve(g: NavGraph, t: Target): number {
  if (typeof t === "number") return t >= 0 && t < g.n ? t : -1;
  return nearestNode(g, t.x, t.y, t.z);
}

// ---------------------------------------------------------------------------

const S_IDLE = 0, S_RUN = 1, S_DONE = 2, S_FAIL = 3;

/** One resumable search. Arrays are sized to the graph and reused across queries. */
export class NavSearch {
  readonly g: NavGraph;
  private gs: Float64Array;
  private par: Int32Array;
  private parE: Int32Array;
  private seen: Uint32Array;
  private closed: Uint32Array;
  private stamp = 0;
  private heap = new Heap(4096);
  // region level
  private rg: Float64Array;
  private rpar: Int32Array;
  private rseen: Uint32Array;
  private rclosed: Uint32Array;
  private rheap = new Heap(1024);
  private corridor: Uint32Array;
  // current query
  status = S_IDLE;
  start = -1;
  goal = -1;
  expanded = 0;
  private best = -1;
  private bestH = Infinity;
  private allow = DEFAULT_ACTS;
  private swimMul = 1;
  private danger: DangerMap | undefined;
  private dangerW = 0;
  private hw = 1.2;
  private maxExp = 60000;
  private useCorridor = true;
  private smooth = true;
  private triedFull = false;
  private goalCheck: ((n: number) => boolean) | null = null;
  private maxCost = Infinity;

  constructor(g: NavGraph) {
    this.g = g;
    this.gs = new Float64Array(g.n);
    this.par = new Int32Array(g.n);
    this.parE = new Int32Array(g.n);
    this.seen = new Uint32Array(g.n);
    this.closed = new Uint32Array(g.n);
    const rc = g.regions.count;
    this.rg = new Float64Array(rc);
    this.rpar = new Int32Array(rc);
    this.rseen = new Uint32Array(rc);
    this.rclosed = new Uint32Array(rc);
    this.corridor = new Uint32Array(rc);
  }

  private setOpts(o: PathOptions): void {
    this.allow = o.allow ?? DEFAULT_ACTS;
    this.swimMul = o.swimCost ?? 1;
    this.danger = o.danger;
    this.dangerW = o.dangerWeight ?? (o.danger ? 1 : 0);
    this.hw = o.heuristicWeight ?? 1.5;
    this.maxExp = o.maxExpansions ?? 60000;
    this.useCorridor = o.hierarchical ?? true;
    this.smooth = o.smooth ?? true;
  }

  /** Starts an A* query. Returns false if start/goal can't be resolved or are disconnected. */
  begin(from: Target, to: Target, opts: PathOptions = {}): boolean {
    this.setOpts(opts);
    this.goalCheck = null;
    this.maxCost = Infinity;
    this.start = resolve(this.g, from);
    this.goal = resolve(this.g, to);
    this.expanded = 0;
    this.triedFull = false;
    if (this.start < 0 || this.goal < 0) { this.status = S_FAIL; return false; }
    const r = this.g.regions;
    if (r.comp[this.g.region[this.start]] !== r.comp[this.g.region[this.goal]]) { this.status = S_FAIL; return false; }
    if (this.useCorridor && !this.regionCorridor()) { this.status = S_FAIL; return false; }
    this.initOpen();
    return true;
  }

  /** Starts a Dijkstra search for the cheapest node satisfying `pred`. */
  beginNearest(from: Target, pred: (n: number) => boolean, maxCost: number, opts: PathOptions = {}): boolean {
    this.setOpts(opts);
    this.useCorridor = false;
    this.hw = 0;
    this.goalCheck = pred;
    this.maxCost = maxCost;
    this.start = resolve(this.g, from);
    this.goal = -1;
    this.expanded = 0;
    this.triedFull = true;
    if (this.start < 0) { this.status = S_FAIL; return false; }
    this.initOpen();
    return true;
  }

  private initOpen(): void {
    this.stamp++;
    if (this.stamp === 0xffffffff) { this.seen.fill(0); this.closed.fill(0); this.stamp = 1; }
    this.heap.size = 0;
    const s = this.start;
    this.gs[s] = 0;
    this.par[s] = -1;
    this.parE[s] = -1;
    this.seen[s] = this.stamp;
    this.heap.push(this.h(s), s);
    this.best = s;
    this.bestH = Infinity;
    this.status = S_RUN;
  }

  private h(a: number): number {
    if (this.goal < 0) return 0;
    const g = this.g, b = this.goal;
    const dx = g.x[a] - g.x[b], dy = g.y[a] - g.y[b], dz = g.z[a] - g.z[b];
    return (Math.sqrt(dx * dx + dy * dy * 0.25 + dz * dz) / RUN_SPEED) * this.hw;
  }

  private edgeCost(e: number, b: number): number {
    const act = this.g.eAct[e];
    if (!(this.allow & (1 << act))) return -1;
    let c = this.g.eCost[e];
    if (act === Act.Swim || act === Act.Dive) c *= this.swimMul;
    if (this.danger && this.dangerW > 0) c *= 1 + this.dangerW * this.danger.at(this.g.x[b], this.g.z[b]);
    return c;
  }

  /** Region-graph A*; marks the corridor (path regions + neighbours). */
  private regionCorridor(): boolean {
    const g = this.g, r = g.regions;
    const rs = g.region[this.start], rt = g.region[this.goal];
    this.stamp++;
    const st = this.stamp;
    if (rs === rt) {
      this.markCorridor(rs, st);
      return true;
    }
    const heap = this.rheap;
    heap.size = 0;
    const tx = g.x[r.rep[rt]], ty = g.y[r.rep[rt]], tz = g.z[r.rep[rt]];
    const hr = (q: number) => {
      const n = r.rep[q];
      const dx = g.x[n] - tx, dy = g.y[n] - ty, dz = g.z[n] - tz;
      return Math.sqrt(dx * dx + dy * dy * 0.25 + dz * dz) / RUN_SPEED;
    };
    this.rg[rs] = 0;
    this.rpar[rs] = -1;
    this.rseen[rs] = st;
    heap.push(hr(rs), rs);
    const okW = (this.allow & (1 << Act.Swim)) !== 0, okZ = (this.allow & (1 << Act.Zipline)) !== 0;
    const okV = (this.allow & (1 << Act.Vehicle)) !== 0;
    let found = false;
    while (heap.size > 0) {
      const q = heap.pop();
      if (this.rclosed[q] === st) continue;
      this.rclosed[q] = st;
      if (q === rt) { found = true; break; }
      for (let k = r.start[q]; k < r.start[q + 1]; k++) {
        const cls = r.cls[k];
        if ((cls === 1 && !okW) || (cls === 2 && !okZ) || (cls === 3 && !okV)) continue;
        const v = r.to[k];
        if (this.rclosed[v] === st) continue;
        let c = r.cost[k];
        if (cls === 1) c *= this.swimMul;
        const ng = this.rg[q] + c;
        if (this.rseen[v] !== st || ng < this.rg[v]) {
          this.rseen[v] = st;
          this.rg[v] = ng;
          this.rpar[v] = q;
          heap.push(ng + hr(v), v);
        }
      }
    }
    if (!found) return false;
    for (let q = rt; q >= 0; q = this.rpar[q]) this.markCorridor(q, st);
    return true;
  }

  private markCorridor(q: number, st: number): void {
    const r = this.g.regions;
    this.corridor[q] = st;
    for (let k = r.start[q]; k < r.start[q + 1]; k++) this.corridor[r.to[k]] = st;
  }

  /**
   * Runs up to `budget` expansions. Returns the expansions used. When the
   * search ends, status becomes done / fail and result() is ready.
   */
  run(budget: number): number {
    if (this.status !== S_RUN) return 0;
    const g = this.g, heap = this.heap, st = this.stamp;
    const corridorSt = this.useCorridor ? st - 1 : 0;
    let used = 0;
    while (used < budget) {
      if (heap.size === 0) {
        // corridor exhausted (options excluded an abstract edge): retry unrestricted once
        if (this.useCorridor && !this.triedFull && this.goal >= 0) {
          this.triedFull = true;
          this.useCorridor = false;
          this.initOpen();
          return used + this.run(budget - used);
        }
        this.status = this.goalCheck ? S_FAIL : this.best >= 0 && this.best !== this.start ? S_DONE : S_FAIL;
        this.partialEnd = this.goalCheck ? -1 : this.best;
        return used;
      }
      const a = heap.pop();
      if (this.closed[a] === st) continue;
      this.closed[a] = st;
      used++;
      this.expanded++;
      if (a === this.goal || (this.goalCheck && this.goalCheck(a))) {
        this.status = S_DONE;
        this.partialEnd = a;
        this.goalReached = true;
        return used;
      }
      const ga = this.gs[a];
      if (ga > this.maxCost) continue;
      if (this.goal >= 0) {
        const ha = this.h(a);
        if (ha < this.bestH) { this.bestH = ha; this.best = a; }
      }
      if (this.expanded >= this.maxExp) {
        this.status = this.goalCheck ? S_FAIL : S_DONE;
        this.partialEnd = this.goalCheck ? -1 : this.best;
        return used;
      }
      for (let e = g.eStart[a]; e < g.eStart[a + 1]; e++) {
        const b = g.eTo[e];
        if (this.closed[b] === st) continue;
        if (corridorSt && this.corridor[g.region[b]] !== corridorSt) continue;
        const c = this.edgeCost(e, b);
        if (c < 0) continue;
        const nb = ga + c;
        if (this.seen[b] !== st || nb < this.gs[b]) {
          this.seen[b] = st;
          this.gs[b] = nb;
          this.par[b] = a;
          this.parE[b] = e;
          heap.push(nb + this.h(b), b);
        }
      }
    }
    return used;
  }

  private partialEnd = -1;
  private goalReached = false;

  get done(): boolean {
    return this.status === S_DONE || this.status === S_FAIL;
  }

  /** Builds the result of a finished search. */
  result(): PathResult {
    if (this.status !== S_DONE || this.partialEnd < 0) {
      this.goalReached = false;
      return EMPTY(this.expanded);
    }
    const g = this.g;
    const end = this.partialEnd;
    const nodes: number[] = [], acts: number[] = [];
    for (let q = end; q >= 0; q = this.par[q]) {
      nodes.push(q);
      acts.push(this.parE[q] >= 0 ? g.eAct[this.parE[q]] : Act.Walk);
    }
    nodes.reverse();
    acts.reverse();
    const ok = this.goalReached;
    this.goalReached = false;
    return {
      ok, partial: !ok, nodes, acts, cost: this.gs[end], expanded: this.expanded,
      waypoints: this.smooth ? smoothPath(g, nodes, acts) : rawWaypoints(g, nodes, acts),
    };
  }
}

// ---------------------------------------------------------------------------
// waypoints

function linkId(g: NavGraph, a: number, b: number, act: number): number {
  if (act !== Act.Zipline && act !== Act.Vehicle) return -1;
  for (const l of g.links) if (l.from === a && l.to === b) return l.id;
  return -1;
}

function wp(g: NavGraph, node: number, act: number, link: number): Waypoint {
  return { x: g.x[node], y: g.y[node], z: g.z[node], act: act as ActT, action: ACT_NAMES[act], node, link };
}

function rawWaypoints(g: NavGraph, nodes: number[], acts: number[]): Waypoint[] {
  return nodes.map((n, i) => wp(g, n, acts[i], i > 0 ? linkId(g, nodes[i - 1], n, acts[i]) : -1));
}

/** Smoothing class of an action: runs of the same class may be string-pulled. */
function smoothClass(act: number): number {
  if (act === Act.Walk || act === Act.Wade) return 1;
  if (act === Act.Swim) return 2;
  if (act === Act.Cave) return 3;
  return 0;
}

/** String-pulls runs of walk / swim / cave edges; special moves keep both endpoints. */
export function smoothPath(g: NavGraph, nodes: number[], acts: number[]): Waypoint[] {
  const out: Waypoint[] = [];
  if (nodes.length === 0) return out;
  out.push(wp(g, nodes[0], Act.Walk, -1));
  let i = 0;
  while (i < nodes.length - 1) {
    const cls = smoothClass(acts[i + 1]);
    if (cls === 0) {
      out.push(wp(g, nodes[i + 1], acts[i + 1], linkId(g, nodes[i], nodes[i + 1], acts[i + 1])));
      i++;
      continue;
    }
    let end = i + 1;
    while (end + 1 < nodes.length && smoothClass(acts[end + 1]) === cls) end++;
    // greedy: from anchor i, jump to the farthest visible node of the run
    while (i < end) {
      let good = i + 1, bad = -1;
      for (let step = 2; ; step *= 2) {
        const j = i + step > end ? end : i + step;
        if (lineClear(g, nodes[i], nodes[j], cls)) {
          good = j;
          if (j === end) break;
        } else { bad = j; break; }
      }
      if (bad > 0) {
        let lo = good, hi = bad;
        while (hi - lo > 1) {
          const m = (lo + hi) >> 1;
          if (lineClear(g, nodes[i], nodes[m], cls)) lo = m;
          else hi = m;
        }
        good = lo;
      }
      out.push(wp(g, nodes[good], acts[good], -1));
      i = good;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// walkability line checks

function classOk(f: number, cls: number): boolean {
  if (cls === 2) return (f & (NF.Swim | NF.Wade)) !== 0;
  return (f & (NF.Land | NF.Wade)) !== 0;
}

/**
 * Can an agent go straight from node a to node b (same layer) staying on
 * walkable (cls 1), swimmable (2) or cave (3) ground? Coarse-to-coarse lines
 * walk the 2 m grid (supercover) with slope + prop checks; lines inside one
 * patch follow the floor spans column by column and test capsule clearance.
 */
export function lineClear(g: NavGraph, a: number, b: number, cls = 1): boolean {
  const pa = g.patch[a], pb = g.patch[b];
  if (pa < 0 && pb < 0) return coarseLine(g, a, b, cls);
  if (pa >= 0 && pa === pb) return patchLine(g, g.patches[pa], a, b, cls);
  return false;
}

function coarseLine(g: NavGraph, a: number, b: number, cls: number): boolean {
  const ax = g.x[a], az = g.z[a], bx = g.x[b], bz = g.z[b];
  // cell k covers [gx(k) - 1, gx(k) + 1]: grid coordinate u = (x + HALF) / 2 + 0.5
  const ua = (ax + WORLD_HALF) / 2 + 0.5, va = (az + WORLD_HALF) / 2 + 0.5;
  const ub = (bx + WORLD_HALF) / 2 + 0.5, vb = (bz + WORLD_HALF) / 2 + 0.5;
  let cx = Math.floor(ua), cz = Math.floor(va);
  const ex = Math.floor(ub), ez = Math.floor(vb);
  const du = ub - ua, dv = vb - va;
  const sx = du > 0 ? 1 : du < 0 ? -1 : 0, sz = dv > 0 ? 1 : dv < 0 ? -1 : 0;
  const tdx = sx !== 0 ? Math.abs(1 / du) : Infinity, tdz = sz !== 0 ? Math.abs(1 / dv) : Infinity;
  let tmx = sx > 0 ? (cx + 1 - ua) * tdx : sx < 0 ? (ua - cx) * tdx : Infinity;
  let tmz = sz > 0 ? (cz + 1 - va) * tdz : sz < 0 ? (va - cz) * tdz : Infinity;
  let prevY = g.y[a];
  const maxDy = cls === 2 ? 0.6 : EDGE_SLOPE * 2;
  for (let it = 0; it < 2048; it++) {
    const q = g.coarse[cz * N + cx];
    if (q < 0 || !classOk(g.flags[q], cls)) return false;
    const dy = g.y[q] - prevY;
    if (dy > maxDy || dy < -maxDy) return false;
    prevY = g.y[q];
    if (cx === ex && cz === ez) break;
    if (tmx < tmz) { tmx += tdx; cx += sx; }
    else { tmz += tdz; cz += sz; }
    if (cx < 0 || cz < 0 || cx >= N || cz >= N) return false;
  }
  if (cls === 2) return true;
  // props along the line, in <= 2 m pieces
  const dx = bx - ax, dz = bz - az;
  const L = Math.sqrt(dx * dx + dz * dz);
  const pieces = Math.max(1, Math.ceil(L / 2));
  const ay = g.y[a], by = g.y[b];
  for (let k = 0; k < pieces; k++) {
    const t0 = k / pieces, t1 = (k + 1) / pieces;
    if (propCutsSeg(g, ax + dx * t0, ay + (by - ay) * t0, az + dz * t0, ax + dx * t1, ay + (by - ay) * t1, az + dz * t1)) return false;
  }
  return true;
}

function propCutsSeg(g: NavGraph, ax: number, ya: number, az: number, bx: number, yb: number, bz: number): boolean {
  const cw = g.cw, pp = cw.props, pg = cw.propGrid;
  const mx = (ax + bx) * 0.5, mz = (az + bz) * 0.5;
  const hx = Math.floor((mx + WORLD_HALF) / 4), hz = Math.floor((mz + WORLD_HALF) / 4);
  if (hx < 0 || hz < 0 || hx >= 256 || hz >= 256) return false;
  const cell = hz * 256 + hx;
  const lo = ya < yb ? ya : yb, hi = (ya > yb ? ya : yb) + AGENT_H;
  const sx = bx - ax, sz = bz - az, l2 = sx * sx + sz * sz;
  const R = g.radius * 0.9;
  for (let k = pg.start[cell], e = pg.start[cell + 1]; k < e; k++) {
    const o = pg.items[k] * 5;
    if (pp[o + 4] < lo || pp[o + 1] > hi) continue;
    let u = l2 > 0 ? ((pp[o] - ax) * sx + (pp[o + 2] - az) * sz) / l2 : 0;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const qx = ax + sx * u - pp[o], qz = az + sz * u - pp[o + 2];
    const rr = pp[o + 3] + R;
    if (qx * qx + qz * qz < rr * rr) return true;
  }
  return false;
}

function patchLine(g: NavGraph, p: NavPatch, a: number, b: number, cls: number): boolean {
  const res = p.res;
  const ax = g.x[a], az = g.z[a], bx = g.x[b], bz = g.z[b];
  const ua = (ax - p.x0) / res, va = (az - p.z0) / res, ub = (bx - p.x0) / res, vb = (bz - p.z0) / res;
  let cx = Math.floor(ua), cz = Math.floor(va);
  const ex = Math.floor(ub), ez = Math.floor(vb);
  const du = ub - ua, dv = vb - va;
  const sx = du > 0 ? 1 : du < 0 ? -1 : 0, sz = dv > 0 ? 1 : dv < 0 ? -1 : 0;
  const tdx = sx !== 0 ? Math.abs(1 / du) : Infinity, tdz = sz !== 0 ? Math.abs(1 / dv) : Infinity;
  let tmx = sx > 0 ? (cx + 1 - ua) * tdx : sx < 0 ? (ua - cx) * tdx : Infinity;
  let tmz = sz > 0 ? (cz + 1 - va) * tdz : sz < 0 ? (va - cz) * tdz : Infinity;
  const lim = cls === 2 ? 0.6 : Math.max(0.55, EDGE_SLOPE * res);
  let y = g.y[a];
  let cur = a;
  for (let it = 0; it < 4096; it++) {
    if (!(cx === Math.floor(ua) && cz === Math.floor(va))) {
      const c = cz * p.w + cx;
      let pick = -1, pd = Infinity;
      for (let s = p.colStart[c]; s < p.colStart[c + 1]; s++) {
        const q = p.colNodes[s];
        if (!classOk(g.flags[q], cls)) continue;
        if (cls === 3 && !(g.flags[q] & NF.Cave) && !(g.flags[b] & NF.Cave) && !(g.flags[a] & NF.Cave)) continue;
        const d = Math.abs(g.y[q] - y);
        if (d <= lim && d < pd) { pd = d; pick = q; }
      }
      if (pick < 0) return false;
      y = g.y[pick];
      cur = pick;
    }
    if (cx === ex && cz === ez) break;
    if (tmx < tmz) { tmx += tdx; cx += sx; }
    else { tmz += tdz; cz += sz; }
    if (cx < 0 || cz < 0 || cx >= p.w || cz >= p.h) return false;
  }
  if (cur !== b) return false;
  if (cls === 2) return true;
  // capsule clearance along the line (spans are only validated at column centres)
  const dx = bx - ax, dz = bz - az, dyl = g.y[b] - g.y[a];
  const L = Math.sqrt(dx * dx + dz * dz);
  const steps = Math.ceil(L / 0.4);
  const r = g.radius * 0.9;
  for (let k = 1; k < steps; k++) {
    const t = k / steps;
    const x = ax + dx * t, z = az + dz * t, yy = g.y[a] + dyl * t;
    if (sdf(g.cw, x, yy + 0.95, z) < r || sdf(g.cw, x, yy + 1.4, z) < r) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// one-shot API

const searches = new WeakMap<NavGraph, NavSearch>();
function sharedSearch(g: NavGraph): NavSearch {
  let s = searches.get(g);
  if (!s) {
    s = new NavSearch(g);
    searches.set(g, s);
  }
  return s;
}

/** A* path between two points (or node ids). Synchronous; see PathPlanner for a budgeted version. */
export function findPath(g: NavGraph, from: Target, to: Target, opts: PathOptions = {}): PathResult {
  const s = sharedSearch(g);
  if (!s.begin(from, to, opts)) return EMPTY(0);
  while (!s.done) s.run(1 << 20);
  return s.result();
}

export interface NearestResult {
  node: number;
  cost: number;
  path: PathResult;
}

/** Dijkstra from `from` to the cheapest node where pred(node) holds, within maxCost seconds. */
export function findNearest(
  g: NavGraph, from: Target, pred: (n: number) => boolean, maxCost = 120, opts: PathOptions = {},
): NearestResult | null {
  const s = sharedSearch(g);
  if (!s.beginNearest(from, pred, maxCost, opts)) return null;
  while (!s.done) s.run(1 << 20);
  const path = s.result();
  if (!path.ok) return null;
  return { node: path.nodes[path.nodes.length - 1], cost: path.cost, path };
}

/** Nearest deep water to wash paint off (travel-time-wise). */
export function nearestWater(g: NavGraph, from: Target, maxCost = 120, opts: PathOptions = {}): NearestResult | null {
  return findNearest(g, from, (n) => (g.flags[n] & NF.Wash) !== 0, maxCost, opts);
}

export interface RandomSource {
  next(): number;
}

/** A random node within `radius` of `near` that is connected to it. */
export function randomReachablePoint(
  g: NavGraph, near: Target, radius: number, rng: RandomSource, tries = 24,
): { x: number; y: number; z: number; node: number } | null {
  const s = resolve(g, near);
  if (s < 0) return null;
  const comp = g.regions.comp[g.region[s]];
  const cx = g.x[s], cz = g.z[s];
  for (let t = 0; t < tries; t++) {
    const u = rng.next() * 2 - 1, v = rng.next() * 2 - 1;
    if (u * u + v * v > 1) continue;
    const x = cx + u * radius, z = cz + v * radius;
    const q = nearestNode(g, x, g.y[s] + (rng.next() - 0.5) * radius * 0.5, z, 4);
    if (q < 0 || q === s) continue;
    if (g.regions.comp[g.region[q]] !== comp) continue;
    return { x: g.x[q], y: g.y[q], z: g.z[q], node: q };
  }
  return null;
}

// ---------------------------------------------------------------------------
// budgeted planner

export interface PlanDone {
  ticket: number;
  result: PathResult;
}

interface Req {
  ticket: number;
  from: Target;
  to: Target;
  opts: PathOptions;
}

/**
 * Queue of path requests served under a per-tick node-expansion budget, so
 * 19 bots re-planning at once never spike a server tick. One search runs at a
 * time and is resumed across update() calls. Deterministic: results depend
 * only on the requests and budgets, not on wall-clock time.
 */
export class PathPlanner {
  private search: NavSearch;
  private queue: Req[] = [];
  private cur: Req | null = null;
  private nextTicket = 1;

  constructor(g: NavGraph) {
    this.search = new NavSearch(g);
  }

  request(from: Target, to: Target, opts: PathOptions = {}): number {
    const ticket = this.nextTicket++;
    this.queue.push({ ticket, from, to, opts });
    return ticket;
  }

  cancel(ticket: number): void {
    if (this.cur && this.cur.ticket === ticket) this.cur = null;
    this.queue = this.queue.filter((r) => r.ticket !== ticket);
  }

  get pending(): number {
    return this.queue.length + (this.cur ? 1 : 0);
  }

  /** Spends up to `budget` node expansions (~0.6 µs each in V8: 3000 ≈ 2 ms); returns the requests that finished. */
  update(budget = 3000): PlanDone[] {
    const out: PlanDone[] = [];
    let left = budget;
    while (left > 0) {
      if (!this.cur) {
        const r = this.queue.shift();
        if (!r) break;
        this.cur = r;
        left -= 16; // start-up cost: node lookups + region search
        if (!this.search.begin(r.from, r.to, r.opts)) {
          out.push({ ticket: r.ticket, result: EMPTY(0) });
          this.cur = null;
          continue;
        }
      }
      left -= this.search.run(left);
      if (this.search.done) {
        out.push({ ticket: this.cur.ticket, result: this.search.result() });
        this.cur = null;
      }
    }
    return out;
  }
}
