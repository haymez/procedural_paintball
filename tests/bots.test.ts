// Bot world-knowledge layer: nav graph, pathfinding, tactics.
import { describe, expect, it } from "vitest";
import { generateWorld } from "../shared/world/generate";
import { buildCollision, sdf, terrainHeight, type CollisionWorld, type Vec3 } from "../shared/world/collide";
import { StructureKind, type World } from "../shared/world/types";
import { Rng } from "../shared/math/rng";
import {
  Act, BALL_GRAVITY, BALL_SPEED, DangerMap, DROP_LAND, EYE_H, MANTLE_MAX, NF, PathPlanner, SWIM_DEPTH, SWIM_MANTLE,
  ZIP_FEET, ZIP_GRAB_R, ballisticAim, buildBotWorld, buildNav, findCover, findPath, lineOfSight, nearestNode,
  nearestWater, randomReachablePoint, trajectoryClear, type BotWorld, type NavGraph, type PathResult,
} from "../shared/bots";

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

interface Ctx {
  w: World;
  cw: CollisionWorld;
  bw: BotWorld;
}
const cache = new Map<number, Ctx>();
function ctx(seed: number): Ctx {
  let c = cache.get(seed);
  if (!c) {
    const w = generateWorld(seed, { skipDecor: true });
    const cw = buildCollision(w);
    c = { w, cw, bw: buildBotWorld(w, cw) };
    cache.set(seed, c);
  }
  return c;
}

// ---------------------------------------------------------------- helpers

/** Every waypoint's body centre must be in free space. */
function expectClear(cw: CollisionWorld, r: PathResult, what: string) {
  for (const p of r.waypoints) {
    const d = sdf(cw, p.x, p.y + 0.9, p.z);
    if (!(d > 0.05)) throw new Error(`${what}: waypoint (${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}) ${p.action} inside solid (sdf ${d.toFixed(3)})`);
  }
}

function reachSet(g: NavGraph, start: number, reverse: boolean): Uint8Array {
  const seen = new Uint8Array(g.n);
  let adj: Int32Array[] | null = null;
  if (reverse) {
    const lists: number[][] = Array.from({ length: g.n }, () => []);
    for (let a = 0; a < g.n; a++) for (let e = g.eStart[a]; e < g.eStart[a + 1]; e++) lists[g.eTo[e]].push(a);
    adj = lists.map((l) => Int32Array.from(l));
  }
  const q = [start];
  seen[start] = 1;
  while (q.length) {
    const a = q.pop()!;
    if (adj) {
      for (const b of adj[a]) if (!seen[b]) { seen[b] = 1; q.push(b); }
    } else
      for (let e = g.eStart[a]; e < g.eStart[a + 1]; e++) {
        const b = g.eTo[e];
        if (!seen[b]) { seen[b] = 1; q.push(b); }
      }
  }
  return seen;
}

/**
 * Why is `to` unreachable from `from`? Looks at every pair (u reachable from
 * `from`, v that can reach `to`) close together horizontally. If some pair is
 * a free-standing climb of at most MANTLE_MAX, the nav graph is missing a
 * link (returns a description); otherwise the gap is a real ledge / wall the
 * sim can't climb either (returns null).
 */
function unexplainedGap(g: NavGraph, from: number, to: number): string | null {
  const fwd = reachSet(g, from, false), bwd = reachSet(g, to, true);
  const cw = g.cw;
  const cell = (x: number) => Math.floor(x / 2);
  const buckets = new Map<number, number[]>();
  for (let v = 0; v < g.n; v++) {
    if (!bwd[v]) continue;
    const k = cell(g.x[v]) * 100000 + cell(g.z[v]);
    let l = buckets.get(k);
    if (!l) buckets.set(k, (l = []));
    l.push(v);
  }
  for (let u = 0; u < g.n; u++) {
    if (!fwd[u] || bwd[u]) continue;
    const cx = cell(g.x[u]), cz = cell(g.z[u]);
    for (let ox = -1; ox <= 1; ox++)
      for (let oz = -1; oz <= 1; oz++) {
        const l = buckets.get((cx + ox) * 100000 + cz + oz);
        if (!l) continue;
        for (const v of l) {
          const dx = g.x[v] - g.x[u], dz = g.z[v] - g.z[u], d = Math.sqrt(dx * dx + dz * dz);
          const lim = g.patch[u] < 0 && g.patch[v] < 0 ? 2.1 : 1.1;
          const climb = g.y[v] - g.y[u];
          if (d > lim || climb > MANTLE_MAX - 0.1 || climb < -0.5) continue;
          // the pair must see each other at body height (no wall / floor between)
          const top = Math.max(g.y[u], g.y[v]);
          let clear = true;
          for (let t = 0; t <= 1.001 && clear; t += 0.125) {
            const x = g.x[u] + dx * t, z = g.z[u] + dz * t;
            if (sdf(cw, x, top + 0.95, z) < 0.3 || sdf(cw, x, top + 1.4, z) < 0.3) clear = false;
          }
          if (clear) return `(${g.x[u].toFixed(1)},${g.y[u].toFixed(2)},${g.z[u].toFixed(1)}) -> (${g.x[v].toFixed(1)},${g.y[v].toFixed(2)},${g.z[v].toFixed(1)}) climb ${climb.toFixed(2)} m`;
        }
      }
  }
  return null;
}

// ---------------------------------------------------------------- per seed

describe.each(SEEDS)("seed %i", (seed) => {
  it("builds a well-formed graph", () => {
    const { w, bw } = ctx(seed);
    const g = bw.nav;
    expect(g.n).toBeGreaterThan(50000);
    expect(g.stats.structNodes).toBeGreaterThan(1000);
    if (w.caves.length) expect(g.stats.caveNodes).toBeGreaterThan(200);
    expect(g.eStart[g.n]).toBe(g.eTo.length);
    for (let a = 0; a < g.n; a++) {
      if (!(Number.isFinite(g.x[a]) && Number.isFinite(g.y[a]) && Number.isFinite(g.z[a]))) throw new Error("bad node " + a);
      if (g.eStart[a + 1] < g.eStart[a]) throw new Error("CSR not monotonic");
    }
    for (let e = 0; e < g.eTo.length; e++) {
      if (g.eTo[e] < 0 || g.eTo[e] >= g.n || !(g.eCost[e] > 0)) throw new Error("bad edge " + e);
    }
    expect(bw.cover.count).toBeGreaterThan(1000);
    expect(bw.pois.pickups.length).toBe(w.pickups.length);
    expect(bw.pois.perches.length).toBeGreaterThan(0);
  });

  it("connects every spawn point both ways", () => {
    const { w, cw, bw } = ctx(seed);
    const s0 = w.spawns[0];
    for (let i = 1; i < w.spawns.length; i++) {
      const a = findPath(bw.nav, s0, w.spawns[i]);
      const b = findPath(bw.nav, w.spawns[i], s0);
      expect(a.ok, `spawn 0 -> ${i}`).toBe(true);
      expect(b.ok, `spawn ${i} -> 0`).toBe(true);
      expectClear(cw, a, `spawn 0 -> ${i}`);
      expectClear(cw, b, `spawn ${i} -> 0`);
      expect(a.waypoints[0].node).toBe(a.nodes[0]);
      expect(a.waypoints[a.waypoints.length - 1].node).toBe(a.nodes[a.nodes.length - 1]);
    }
  });

  it("reaches every pickup, or it sits behind a ledge the sim can't climb either", () => {
    const { w, cw, bw } = ctx(seed);
    const g = bw.nav;
    const s0 = nearestNode(g, w.spawns[0].x, w.spawns[0].y, w.spawns[0].z);
    const gaps: string[] = [];
    w.pickups.forEach((p, i) => {
      const t = nearestNode(g, p.x, p.y, p.z, 3);
      expect(t, `pickup ${i} has no nav node within 3 m`).toBeGreaterThanOrEqual(0);
      const to = findPath(g, s0, t), back = findPath(g, t, s0);
      if (to.ok) expectClear(cw, to, `to pickup ${i}`);
      if (back.ok) expectClear(cw, back, `from pickup ${i}`);
      if (to.ok && back.ok) return;
      const why = !to.ok ? unexplainedGap(g, s0, t) : unexplainedGap(g, t, s0);
      if (why) throw new Error(`pickup ${i} (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}) ${to.ok ? "can't get back" : "unreachable"}: missing link ${why}`);
      const st = w.structures.reduce((b, s) => (Math.hypot(s.x - p.x, s.z - p.z) < Math.hypot(b.x - p.x, b.z - p.z) ? s : b));
      gaps.push(`#${i} ${to.ok ? "one-way out" : "unreachable"} y+${(p.y - terrainHeight(w, p.x, p.z)).toFixed(1)} near ${StructureKind[st.kind]}`);
    });
    // known generator gaps: cottage upper floors (no doorway from the outside
    // stair), aqueduct tops (no stairs), cave side rooms above a lower tunnel
    expect(gaps.length, gaps.join("; ")).toBeLessThanOrEqual(3);
  });

  it("paths lead into and out of every cave", () => {
    const { w, cw, bw } = ctx(seed);
    const g = bw.nav;
    const s0 = nearestNode(g, w.spawns[0].x, w.spawns[0].y, w.spawns[0].z);
    w.caves.forEach((cave, ci) => {
      const hub = cave.nodes[0];
      const t = nearestNode(g, hub.x, hub.y - 0.45 * hub.r, hub.z, 8);
      expect(t, `cave ${ci} hub has a node`).toBeGreaterThanOrEqual(0);
      expect(g.flags[t] & NF.Cave, `cave ${ci} hub node is under rock`).toBeTruthy();
      const inn = findPath(g, s0, t), out = findPath(g, t, s0);
      expect(inn.ok, `into cave ${ci}: ${inn.ok ? "" : unexplainedGap(g, s0, t)}`).toBe(true);
      expect(out.ok, `out of cave ${ci}: ${out.ok ? "" : unexplainedGap(g, t, s0)}`).toBe(true);
      expect(inn.waypoints.some((p) => p.action === "cave")).toBe(true);
      expectClear(cw, inn, `into cave ${ci}`);
      expectClear(cw, out, `out of cave ${ci}`);
    });
  });

  it("special links are physically valid", () => {
    const { w, bw } = ctx(seed);
    const g = bw.nav;
    const counts = new Array(9).fill(0);
    for (let a = 0; a < g.n; a++)
      for (let e = g.eStart[a]; e < g.eStart[a + 1]; e++) {
        const b = g.eTo[e], act = g.eAct[e];
        counts[act]++;
        const dy = g.y[b] - g.y[a];
        const dh = Math.hypot(g.x[b] - g.x[a], g.z[b] - g.z[a]);
        switch (act) {
          case Act.Walk:
          case Act.Wade:
          case Act.Cave:
            if (Math.abs(dy) > 0.6 + 1.0 * dh || dh > 3) throw new Error(`walk edge too steep/long ${a}->${b} dy ${dy} dh ${dh}`);
            break;
          case Act.JumpDown:
            if (!(dy < -0.5)) throw new Error(`jump-down goes up ${a}->${b} dy ${dy}`);
            if (g.patch[a] >= 0 && -dy > DROP_LAND + 0.01) throw new Error(`jump-down too high ${dy}`);
            break;
          case Act.Dive:
            if (!(g.flags[b] & NF.Swim)) throw new Error(`dive into dry node ${a}->${b}`);
            break;
          case Act.Mantle: {
            const climb = g.flags[a] & NF.Swim ? g.y[b] - (g.y[a] + SWIM_DEPTH) : dy;
            if (!(climb > 0 && climb <= (g.flags[a] & NF.Swim ? SWIM_MANTLE : MANTLE_MAX) + 1e-6)) throw new Error(`bad mantle climb ${climb}`);
            // fine grid: a ledge right ahead; 2 m grid: swim / walk up to the bank, then mantle
            if (dh > (g.patch[a] >= 0 && g.patch[b] >= 0 ? 1.7 : 2.9)) throw new Error(`mantle reach ${dh}`);
            break;
          }
          case Act.Vehicle: {
            const v = g.links.find((l) => l.from === a && l.to === b)!;
            const boat = w.vehicles[v.id];
            expect(Math.hypot(g.x[a] - boat.x, g.z[a] - boat.z)).toBeLessThan(5);
            break;
          }
        }
      }
    expect(counts[Act.Walk]).toBeGreaterThan(100000);
    expect(counts[Act.JumpDown]).toBeGreaterThan(0);
    expect(counts[Act.Dive]).toBeGreaterThan(0);
    // every world zipline becomes a grab -> landing link the sim would accept
    w.ziplines.forEach((z, zi) => {
      const l = g.links.find((k) => k.act === Act.Zipline && k.id === zi);
      expect(l, `zipline ${zi} linked`).toBeTruthy();
      const top = z.ay >= z.by ? { x: z.ax, y: z.ay, z: z.az } : { x: z.bx, y: z.by, z: z.bz };
      const bot = z.ay >= z.by ? { x: z.bx, y: z.by, z: z.bz } : { x: z.ax, y: z.ay, z: z.az };
      expect(Math.hypot(g.x[l!.from] - top.x, g.z[l!.from] - top.z)).toBeLessThanOrEqual(ZIP_GRAB_R);
      const dy = g.y[l!.from] - (top.y - ZIP_FEET);
      expect(dy).toBeGreaterThanOrEqual(-1.5);
      expect(dy).toBeLessThanOrEqual(3);
      expect(Math.hypot(g.x[l!.to] - bot.x, g.z[l!.to] - bot.z)).toBeLessThanOrEqual(5);
    });
  });
});

// ---------------------------------------------------------------- one-offs

describe("nav extras", () => {
  it("adds zipline links and uses them when they save time", () => {
    const { w, bw } = ctx(1);
    // synthetic cable from a high coarse node to a distant low one
    const base = bw.nav;
    let hi = -1;
    for (let a = 0; a < base.n; a++) {
      if (!(base.flags[a] & NF.Coarse) || !(base.flags[a] & NF.Land)) continue;
      if (hi < 0 || base.y[a] > base.y[hi]) hi = a;
    }
    let best = -1;
    for (let a = 0; a < base.n; a++) {
      if (!(base.flags[a] & NF.Coarse) || !(base.flags[a] & NF.Land)) continue;
      const d = Math.hypot(base.x[a] - base.x[hi], base.z[a] - base.z[hi]);
      if (d < 150 || d > 250 || base.y[a] > base.y[hi] - 40 || base.y[a] < 3) continue;
      if (base.regions.comp[base.region[a]] !== 0) continue;
      if (best < 0 || base.y[a] < base.y[best]) best = a;
    }
    const lo = best;
    expect(hi).toBeGreaterThanOrEqual(0);
    expect(lo).toBeGreaterThanOrEqual(0);
    const zw: World = {
      ...w,
      ziplines: [{ ax: base.x[hi], ay: base.y[hi] + ZIP_FEET + 0.1, az: base.z[hi], bx: base.x[lo], by: base.y[lo] + ZIP_FEET, bz: base.z[lo] }],
    };
    const nav = buildNav(zw, buildCollision(zw));
    const link = nav.links.find((l) => l.act === Act.Zipline);
    expect(link).toBeTruthy();
    const from = { x: base.x[hi], y: base.y[hi], z: base.z[hi] }, to = { x: base.x[lo], y: base.y[lo], z: base.z[lo] };
    const r = findPath(nav, from, to);
    expect(r.ok).toBe(true);
    const zipWp = r.waypoints.find((p) => p.action === "zipline");
    expect(zipWp, "path rides the zipline").toBeTruthy();
    expect(zipWp!.link).toBe(0);
    const noZip = findPath(nav, from, to, { allow: 0x1ff & ~(1 << Act.Zipline) & ~(1 << Act.Vehicle) });
    expect(noZip.ok).toBe(true);
    expect(noZip.cost).toBeGreaterThan(r.cost);
  });

  it("is deterministic", () => {
    const { w } = ctx(2);
    const a = buildNav(w, buildCollision(w)), b = buildNav(w, buildCollision(w));
    const hash = (g: NavGraph) => {
      let h = 0x811c9dc5;
      for (const arr of [g.x, g.y, g.z, g.flags, g.eStart, g.eTo, g.eCost, g.eAct, g.region]) {
        const u8 = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
        for (let i = 0; i < u8.length; i++) h = Math.imul(h ^ u8[i], 0x01000193);
      }
      return h >>> 0;
    };
    expect(hash(a)).toBe(hash(b));
    const pa = findPath(a, w.spawns[3], w.spawns[17]), pb = findPath(b, w.spawns[3], w.spawns[17]);
    expect(pa.nodes).toEqual(pb.nodes);
    expect(pa.waypoints).toEqual(pb.waypoints);
  });

  it("builds and queries fast", () => {
    const { w, cw } = ctx(3);
    buildBotWorld(w, cw); // warm up the JIT
    const t0 = performance.now();
    const bw = buildBotWorld(w, cw);
    const buildMs = performance.now() - t0;
    // ~200 ms in Chrome / plain Node; vitest's module runner is slower, so the bound is loose
    expect(buildMs).toBeLessThan(1500);
    expect(bw.nav.stats.bytes).toBeLessThan(32 * 1048576);
    const rng = new Rng(7);
    const pts: Vec3[] = [...w.spawns, ...w.pickups];
    const times: number[] = [];
    for (let k = 0; k < 200; k++) {
      const a = pts[rng.int(pts.length)], b = pts[rng.int(pts.length)];
      const t = performance.now();
      findPath(bw.nav, a, b);
      times.push(performance.now() - t);
    }
    times.sort((p, q) => p - q);
    const avg = times.reduce((p, q) => p + q, 0) / times.length;
    console.log(`bots: build ${buildMs.toFixed(0)} ms (nav ${bw.ms.nav.toFixed(0)}, cover ${bw.ms.cover.toFixed(0)}, pois ${bw.ms.pois.toFixed(0)}), ` +
      `${bw.nav.n} nodes, ${bw.nav.eTo.length} edges, ${(bw.nav.stats.bytes / 1048576).toFixed(1)} MB; ` +
      `findPath avg ${avg.toFixed(2)} ms, p95 ${times[190].toFixed(2)} ms, max ${times[199].toFixed(2)} ms`);
    expect(avg).toBeLessThan(4);
    expect(times[190]).toBeLessThan(12);
  });

  it("budgeted planner spreads work across ticks and matches findPath", () => {
    const { w, bw } = ctx(4);
    const planner = new PathPlanner(bw.nav);
    const tickets = new Map<number, [Vec3, Vec3]>();
    for (let k = 0; k < 19; k++) {
      const a = w.spawns[k], b = w.spawns[(k * 7 + 5) % w.spawns.length];
      tickets.set(planner.request(a, b), [a, b]);
    }
    const BUDGET = 2500;
    const done = new Map<number, PathResult>();
    let ticks = 0;
    while (planner.pending > 0) {
      ticks++;
      expect(ticks).toBeLessThan(500);
      for (const d of planner.update(BUDGET)) done.set(d.ticket, d.result);
    }
    expect(done.size).toBe(19);
    expect(ticks).toBeGreaterThan(1);
    let total = 0;
    for (const [t, [a, b]] of tickets) {
      const r = done.get(t)!;
      const ref = findPath(bw.nav, a, b);
      expect(r.ok).toBe(ref.ok);
      expect(r.nodes).toEqual(ref.nodes);
      total += r.expanded;
    }
    // work per tick stays within the budget (+ small per-request overhead)
    expect(total / ticks).toBeLessThanOrEqual(BUDGET);
  });

  it("finds water to wash in, random reachable points and respects danger", () => {
    const { w, bw } = ctx(5);
    const g = bw.nav;
    const s = w.spawns[10];
    const wr = nearestWater(g, s);
    expect(wr).toBeTruthy();
    expect(g.flags[wr!.node] & NF.Wash).toBeTruthy();
    expect(wr!.path.waypoints[wr!.path.waypoints.length - 1].act === Act.Swim || wr!.path.waypoints.some((p) => p.act === Act.Swim || p.act === Act.Dive)).toBe(true);
    const rng = new Rng(3);
    const s0 = nearestNode(g, s.x, s.y, s.z);
    for (let k = 0; k < 20; k++) {
      const p = randomReachablePoint(g, s, 40, rng);
      expect(p).toBeTruthy();
      expect(Math.hypot(p!.x - g.x[s0], p!.z - g.z[s0])).toBeLessThan(40 * 1.42 + 4);
      expect(findPath(g, s0, p!.node).ok || findPath(g, p!.node, s0).ok).toBe(true);
    }
    // danger: a hot spot on the direct route makes the path detour (or at least cost more)
    const a = w.spawns[0], b = w.spawns[20];
    const plain = findPath(g, a, b);
    const mid = plain.waypoints[Math.floor(plain.waypoints.length / 2)];
    const dm = new DangerMap();
    dm.bump(mid.x, mid.z, 5, 40);
    expect(dm.at(mid.x, mid.z)).toBeGreaterThan(2);
    const careful = findPath(g, a, b, { danger: dm, dangerWeight: 2 });
    expect(careful.ok).toBe(true);
    const inDanger = (r: PathResult) => r.nodes.reduce((s, n) => s + dm.at(g.x[n], g.z[n]), 0);
    expect(inDanger(careful)).toBeLessThan(inDanger(plain));
    dm.decay(30);
    expect(dm.at(mid.x, mid.z)).toBeLessThan(dm.halfLife > 0 ? 3 : 0);
    dm.decay(600);
    expect(dm.at(mid.x, mid.z)).toBeLessThan(0.01);
  });
});

describe("tactics", () => {
  it("line of sight and cover", () => {
    const { w, cw, bw } = ctx(6);
    const s = w.spawns[5];
    const eye = { x: s.x, y: s.y + EYE_H, z: s.z };
    expect(lineOfSight(cw, eye, { x: s.x, y: s.y + 3, z: s.z })).toBe(true);
    expect(lineOfSight(cw, eye, { x: s.x, y: terrainHeight(w, s.x, s.z) - 3, z: s.z })).toBe(false);
    let checked = 0;
    for (let k = 0; k < w.spawns.length && checked < 8; k++) {
      const t = w.spawns[k];
      const threat = { x: t.x + 25, y: terrainHeight(w, t.x + 25, t.z) + EYE_H, z: t.z };
      const spots = findCover(bw.nav, bw.cover, threat, t, 35, { max: 3 });
      for (const sp of spots) {
        checked++;
        expect(lineOfSight(cw, threat, { x: sp.x, y: sp.y + 1.0, z: sp.z })).toBe(false);
        expect(lineOfSight(cw, threat, { x: sp.x, y: sp.y + EYE_H, z: sp.z })).toBe(false);
        expect(sp.node).toBeGreaterThanOrEqual(0);
        expect(Math.hypot(sp.x - t.x, sp.z - t.z)).toBeLessThanOrEqual(35);
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("ballisticAim hits moving targets (direct and lob)", () => {
    // tiny local integrator: semi-implicit Euler at 4 kHz
    const fly = (from: Vec3, dir: Vec3, speed: number, g: number, target: Vec3, vel: Vec3, T: number) => {
      let x = from.x, y = from.y, z = from.z;
      let vx = dir.x * speed, vy = dir.y * speed, vz = dir.z * speed;
      const dt = 1 / 4000;
      let best = Infinity;
      for (let t = 0; t <= T; t += dt) {
        const tx = target.x + vel.x * t, ty = target.y + vel.y * t, tz = target.z + vel.z * t;
        best = Math.min(best, Math.hypot(x - tx, y - ty, z - tz));
        vy -= g * dt;
        x += vx * dt; y += vy * dt; z += vz * dt;
      }
      return best;
    };
    const rng = new Rng(11);
    for (const [speed, g] of [[BALL_SPEED, BALL_GRAVITY], [45, 9.81], [45, 25]]) {
      for (let k = 0; k < 40; k++) {
        const from = { x: rng.range(-5, 5), y: rng.range(0, 10), z: rng.range(-5, 5) };
        const ang = rng.range(0, 6.28), dist = rng.range(3, 45);
        const target = { x: from.x + Math.cos(ang) * dist, y: from.y + rng.range(-10, 10), z: from.z + Math.sin(ang) * dist };
        const vel = { x: rng.range(-8, 8), y: rng.range(-2, 2), z: rng.range(-8, 8) };
        const sols = ballisticAim(from, target, vel, speed, g);
        expect(sols.length, `speed ${speed} g ${g} d ${dist.toFixed(1)}`).toBeGreaterThanOrEqual(1);
        for (const s of sols) {
          expect(Math.hypot(s.dx, s.dy, s.dz)).toBeCloseTo(1, 6);
          expect(fly(from, { x: s.dx, y: s.dy, z: s.dz }, speed, g, target, vel, s.t + 0.05)).toBeLessThan(0.08);
          // yaw / pitch reproduce the direction (yaw 0 = +Z)
          const c = Math.cos(s.pitch);
          expect(Math.sin(s.yaw) * c).toBeCloseTo(s.dx, 5);
          expect(Math.cos(s.yaw) * c).toBeCloseTo(s.dz, 5);
          expect(Math.sin(s.pitch)).toBeCloseTo(s.dy, 5);
        }
        if (sols.length === 2) expect(sols[0].t).toBeLessThan(sols[1].t);
      }
    }
    // out of range: no solution
    expect(ballisticAim({ x: 0, y: 0, z: 0 }, { x: 600, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 46, 9)).toEqual([]);
  });

  it("trajectoryClear stops at terrain", () => {
    const { w, cw } = ctx(6);
    const s = w.spawns[2];
    const from = { x: s.x, y: s.y + 1.2, z: s.z };
    const down = trajectoryClear(cw, from, { x: 0.3, y: -1, z: 0 }, 46, 9, 2);
    expect(down.clear).toBe(false);
    expect(down.y).toBeLessThan(from.y);
    expect(Math.abs(sdf(cw, down.x, down.y, down.z))).toBeLessThan(0.2);
    const up = trajectoryClear(cw, from, { x: 0, y: 1, z: 0 }, 46, 9, 1);
    expect(up.clear).toBe(true);
    // an aimed shot at a visible nearby point is clear up to the intercept
    const target = { x: s.x + 6, y: terrainHeight(w, s.x + 6, s.z) + 1.2, z: s.z };
    if (lineOfSight(cw, from, target)) {
      const [sol] = ballisticAim(from, target, { x: 0, y: 0, z: 0 }, 46, 9);
      expect(trajectoryClear(cw, from, { x: sol.dx, y: sol.dy, z: sol.dz }, 46, 9, sol.t - 0.01).clear).toBe(true);
    }
  });
});
