// Every pickup and spawn must be reachable from every other one, both ways,
// by the sim's movement rules (as encoded in the bot nav graph).
import { describe, expect, it } from "vitest";
import { generateWorld } from "../shared/world/generate";
import { buildCollision, caveSdf, groundBelow, raycast, sdf } from "../shared/world/collide";
import { CAVE_FLOOR } from "../shared/world/collide";
import { buildBotWorld, findPath, nearestNode } from "../shared/bots";

const SEEDS = [2, 3, 8, 9, 11, 17];

describe.each(SEEDS)("seed %i reachability (sim rules)", (seed) => {
  it("all pickups and spawns are reachable from spawn 0 and back", () => {
    const w = generateWorld(seed, { skipDecor: true });
    const cw = buildCollision(w);
    const g = buildBotWorld(w, cw).nav;
    const s0 = nearestNode(g, w.spawns[0].x, w.spawns[0].y, w.spawns[0].z);
    expect(s0).toBeGreaterThanOrEqual(0);
    const bad: string[] = [];
    const check = (what: string, x: number, y: number, z: number) => {
      const t = nearestNode(g, x, y, z, 3);
      if (t < 0) return void bad.push(`${what} has no nav node`);
      if (!findPath(g, s0, t).ok) bad.push(`${what} (${x.toFixed(0)}, ${y.toFixed(1)}, ${z.toFixed(0)}) unreachable`);
      else if (!findPath(g, t, s0).ok) bad.push(`${what} (${x.toFixed(0)}, ${y.toFixed(1)}, ${z.toFixed(0)}) is a one-way trap`);
    };
    w.pickups.forEach((p, i) => check(`pickup ${i}`, p.x, p.y, p.z));
    w.spawns.forEach((p, i) => check(`spawn ${i}`, p.x, p.y, p.z));
    expect(bad, bad.join("; ")).toEqual([]);
  });

  it("groundBelow returns a free-standing floor inside caves", () => {
    const w = generateWorld(seed, { skipDecor: true });
    const cw = buildCollision(w);
    let n = 0;
    for (const c of w.caves)
      for (const [a, b] of c.edges) {
        const A = c.nodes[a], B = c.nodes[b];
        for (let t = 0.1; t < 1; t += 0.2) {
          const x = A.x + (B.x - A.x) * t, z = A.z + (B.z - A.z) * t;
          const y = A.y + (B.y - A.y) * t;
          if (caveSdf(w, x, y, z) > -0.5) continue;
          const f = groundBelow(cw, x, y, z);
          expect(sdf(cw, x, f + 0.02, z)).toBeGreaterThan(0);
          expect(sdf(cw, x, f - 0.15, z)).toBeLessThan(0.01);
          const r = A.r < 7 ? A.r : 4.5;
          expect(f).toBeLessThan(y);
          expect(f).toBeGreaterThan(y - r - 8);
          void CAVE_FLOOR;
          n++;
        }
      }
    if (w.caves.length) expect(n).toBeGreaterThan(5);
  });

  it("cave rocks are solid cover you can stand on, and never block a room", () => {
    const w = generateWorld(seed, { skipDecor: true });
    const cw = buildCollision(w);
    const g = buildBotWorld(w, cw).nav;
    const s0 = nearestNode(g, w.spawns[0].x, w.spawns[0].y, w.spawns[0].z);
    let rocks = 0, tops = 0;
    const bad: string[] = [];
    w.caves.forEach((c, ci) => {
      for (const r of c.rocks ?? []) {
        rocks++;
        // the middle of the rock is solid for movement and paintballs
        const mx = (r.ax + r.bx) / 2, my = (r.ay + r.by) / 2, mz = (r.az + r.bz) / 2;
        if (Math.min(r.ra, r.rb) > 0.3) {
          expect(sdf(cw, mx, my, mz)).toBeLessThan(0);
          const hit = raycast(cw, mx + 3 + Math.max(r.ra, r.rb), my, mz, -1, 0, 0, 3 + Math.max(r.ra, r.rb));
          expect(hit, `ray into rock ${ci}`).not.toBeNull();
        }
        // a rock with headroom above it is something you can land on
        const top = r.ay + r.ra > r.by + r.rb ? { x: r.ax, y: r.ay + r.ra, z: r.az } : { x: r.bx, y: r.by + r.rb, z: r.bz };
        if (caveSdf(w, top.x, top.y + 2.2, top.z) > -0.6 || caveSdf(w, top.x, top.y + 1.2, top.z) > -0.6) continue;
        const f = groundBelow(cw, top.x, top.y + 1.2, top.z);
        expect(f).toBeGreaterThan(top.y - 0.8);
        expect(sdf(cw, top.x, f + 0.05, top.z)).toBeGreaterThan(0);
        tops++;
      }
      // every chamber and every pickup spot is reachable from spawn 0 and back (rocks never wall a room off)
      const chk = (what: string, x: number, y: number, z: number, r: number) => {
        const t = nearestNode(g, x, y, z, r);
        if (t < 0) return void bad.push(`cave ${ci} ${what} has no nav node`);
        if (!findPath(g, s0, t).ok || !findPath(g, t, s0).ok) bad.push(`cave ${ci} ${what} (${x.toFixed(0)}, ${y.toFixed(1)}, ${z.toFixed(0)}) cut off`);
      };
      c.nodes.forEach((n, i) => { if (n.r >= 7) chk(`chamber ${i}`, n.x, n.y - 0.45 * n.r, n.z, 5); });
      (c.spots ?? []).forEach((p, i) => chk(`spot ${i}`, p.x, p.y, p.z, 3));
    });
    expect(bad, bad.join("; ")).toEqual([]);
    if (w.caves.length) {
      expect(rocks).toBeGreaterThan(10);
      expect(tops).toBeGreaterThan(2);
    }
  });
});
