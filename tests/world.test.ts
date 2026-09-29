import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateWorld } from "../shared/world/generate";
import { worldChecksum } from "../shared/world/checksum";
import {
  buildCollision, caveSdf, groundBelow, raycast, sdf, solidSdf, terrainHeight, waterSurface, CAVE_FLOOR,
  type CollisionWorld,
} from "../shared/world/collide";
import { caveAt, computeReach, trapCells } from "../shared/world/reach";
import { zipCableY } from "../shared/world/zipline";
import { NO_WATER, PickupKind, PROP_COLLIDER_RADIUS, PROP_STRIDE, VehicleKind, type World } from "../shared/world/types";

const cache = new Map<number, World>();
function world(seed: number): World {
  let w = cache.get(seed);
  if (!w) {
    w = generateWorld(seed);
    cache.set(seed, w);
  }
  return w;
}
const cws = new Map<number, CollisionWorld>();
function cw(seed: number): CollisionWorld {
  let c = cws.get(seed);
  if (!c) {
    c = buildCollision(world(seed));
    cws.set(seed, c);
  }
  return c;
}

const SEEDS = Array.from({ length: 22 }, (_, i) => i + 1);

describe("determinism", () => {
  it("same seed gives the same checksum, different seeds differ", () => {
    const a = generateWorld(1234);
    const b = generateWorld(1234);
    expect(worldChecksum(a)).toBe(worldChecksum(b));
    expect(a.name).toBe(b.name);
    expect(worldChecksum(world(1))).not.toBe(worldChecksum(a));
    expect(worldChecksum(world(2))).not.toBe(worldChecksum(world(1)));
  });

  it("skipDecor keeps all checksum-relevant data and drops decor", () => {
    for (const seed of [1, 5]) {
      const full = world(seed);
      const lite = generateWorld(seed, { skipDecor: true });
      expect(worldChecksum(lite)).toBe(worldChecksum(full));
      for (const p of lite.props) expect(PROP_COLLIDER_RADIUS[p.kind]).toBeGreaterThan(0);
      expect(lite.spawns.length).toBe(full.spawns.length);
      expect(lite.pickups).toEqual(full.pickups);
    }
  });
});

describe.each(SEEDS)("island %i invariants", (seed) => {
  it("is well formed", () => {
    const w = world(seed);
    for (const a of [w.height, w.water, w.flow]) for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) throw new Error("NaN in grid at " + i);
    for (const p of w.props) {
      expect(p.data.length).toBe(p.count * PROP_STRIDE);
      for (let i = 0; i < p.data.length; i++) if (!Number.isFinite(p.data[i])) throw new Error("NaN prop");
    }
    for (const s of w.structures) for (const o of s.solids) for (const v of [o.cx, o.cy, o.cz, o.hx, o.hy, o.hz, o.rotY]) expect(Number.isFinite(v)).toBe(true);
    expect(w.timeOfDay).toBeGreaterThanOrEqual(8);
    expect(w.timeOfDay).toBeLessThanOrEqual(17.5);
    expect(w.name.length).toBeGreaterThan(4);
    expect(w.landmarks.length).toBeGreaterThan(6);
  });

  it("has a land area in range and open sea at the edges", () => {
    const w = world(seed);
    let land = 0;
    for (let i = 0; i < w.height.length; i++) if (w.height[i] > 0) land += 4;
    expect(land).toBeGreaterThan(300_000);
    expect(land).toBeLessThan(560_000);
    const N = 513;
    for (let k = 0; k < N; k += 8) {
      expect(w.height[k]).toBeLessThan(-5);
      expect(w.height[(N - 1) * N + k]).toBeLessThan(-5);
      expect(w.height[k * N]).toBeLessThan(-5);
    }
  });

  it("has no traps: everything you can fall or slide into leads back to the main region", () => {
    const w = world(seed);
    const R = computeReach(w);
    const { count, trap } = trapCells(w, R.main);
    let where = "";
    for (let i = 0; i < trap.length && where.length < 80; i++) if (trap[i]) where += ` (${-512 + (i % 513) * 2}, ${-512 + ((i / 513) | 0) * 2})`;
    expect(count, `trapped cells:${where}`).toBe(0);
    // no narrow slots (< ~3 m wide, > 2 m deep) the player capsule could wedge in
    const h = w.height, N = 513;
    let slots = 0;
    for (let iz = 2; iz < N - 2; iz++)
      for (let ix = 2; ix < N - 2; ix++) {
        const i = iz * N + ix;
        if (h[i] <= 0.3 || w.water[i] !== NO_WATER || w.holes[i]) continue;
        for (const o of [1, N, N + 1, N - 1]) if (Math.min(h[i - o], h[i + o]) - h[i] > 2.05) { slots++; break; }
      }
    expect(slots).toBe(0);
  });

  it("rivers flow downhill and end in the sea, a lake or another river", () => {
    const w = world(seed);
    expect(w.rivers.length).toBeGreaterThanOrEqual(1);
    expect(w.rivers.length).toBeLessThanOrEqual(6);
    for (const r of w.rivers) {
      for (let k = 1; k < r.points.length; k++) expect(r.points[k].y).toBeLessThanOrEqual(r.points[k - 1].y + 1e-4);
      const e = r.points[r.points.length - 1];
      const toSea = terrainHeight(w, e.x, e.z) < 0.5 || e.y <= 0.01;
      const toLake = w.lakes.some((l) => Math.abs(l.level - e.y) < 0.05);
      const toRiver = w.rivers.some((o) => o !== r && o.points.some((p) => (p.x - e.x) ** 2 + (p.z - e.z) ** 2 < 16 * 16));
      expect(toSea || toLake || toRiver).toBe(true);
      for (const p of r.points) {
        expect(p.width).toBeGreaterThanOrEqual(2.9);
        expect(p.depth).toBeGreaterThan(0.5);
      }
    }
  });

  it("caves open on the surface, stay underground and are traversable", () => {
    const w = world(seed);
    expect(w.caves.length).toBeGreaterThanOrEqual(1);
    for (const c of w.caves) {
      expect(c.entrances.length).toBeGreaterThanOrEqual(2);
      for (const e of c.entrances) {
        const t = terrainHeight(w, e.x, e.z);
        if (e.y > 0) expect(Math.abs(t - e.y)).toBeLessThan(2.6);
        expect(Math.abs(e.dx * e.dx + e.dz * e.dz - 1)).toBeLessThan(1e-3);
      }
      let holes = 0;
      for (let i = 0; i < w.holes.length; i++) holes += w.holes[i];
      expect(holes).toBeGreaterThan(0);
      for (const n of c.nodes) {
        expect(n.r).toBeGreaterThanOrEqual(2.5);
        const nearE = c.entrances.some((e) => (e.x - n.x) ** 2 + (e.z - n.z) ** 2 < 16 * 16);
        if (!nearE) {
          const ceil = n.r >= 7 ? n.y + 0.8 * n.r : n.y + n.r;
          expect(terrainHeight(w, n.x, n.z)).toBeGreaterThan(ceil + 0.5);
          // inside the tunnel is free space
          const fy = n.r >= 7 ? n.y - 0.45 * n.r : n.y - CAVE_FLOOR * n.r;
          expect(caveSdf(w, n.x, fy + 1.0, n.z)).toBeLessThan(0);
          expect(sdf(cw(seed), n.x, fy + 1.0, n.z)).toBeGreaterThan(0.2);
        }
      }
      for (const [a, b] of c.edges) {
        const A = c.nodes[a], B = c.nodes[b];
        const fa = A.r >= 7 ? A.y - 0.45 * A.r : A.y - CAVE_FLOOR * A.r;
        const fb = B.r >= 7 ? B.y - 0.45 * B.r : B.y - CAVE_FLOOR * B.r;
        const hd = Math.sqrt((A.x - B.x) ** 2 + (A.z - B.z) ** 2);
        expect(Math.abs(fa - fb) / Math.max(hd, 1)).toBeLessThan(0.62);
      }
    }
  });

  it("places reachable spawns, pickups and vehicles", () => {
    const w = world(seed);
    const R = computeReach(w);
    const c = cw(seed);
    expect(w.spawns.length).toBeGreaterThanOrEqual(36);
    for (const s of w.spawns) {
      expect(s.y).toBeGreaterThan(0.5);
      expect(R.at(s.x, s.z)).toBe(true);
      expect(caveSdf(w, s.x, s.y + 1, s.z)).toBeGreaterThan(0);
      expect(sdf(c, s.x, s.y + 1, s.z)).toBeGreaterThan(0.5);
      const i = Math.round((s.z + 512) / 2) * 513 + Math.round((s.x + 512) / 2);
      expect(w.water[i] === NO_WATER || w.water[i] < s.y).toBe(true);
    }
    for (let a = 0; a < w.spawns.length; a++)
      for (let b = a + 1; b < w.spawns.length; b++) {
        const d = Math.hypot(w.spawns[a].x - w.spawns[b].x, w.spawns[a].z - w.spawns[b].z);
        expect(d).toBeGreaterThan(20);
      }
    const ammo = w.pickups.filter((p) => p.kind === PickupKind.Ammo).length;
    const ups = w.pickups.length - ammo;
    expect(ammo).toBeGreaterThanOrEqual(40);
    expect(ammo).toBeLessThanOrEqual(64);
    expect(ups).toBeGreaterThanOrEqual(12);
    expect(ups).toBeLessThanOrEqual(26);
    for (const p of w.pickups) {
      const cave = caveAt(w, p.x, p.y, p.z);
      if (cave < 0) expect(R.at(p.x, p.z, 3)).toBe(true);
      expect(sdf(c, p.x, p.y + 0.6, p.z)).toBeGreaterThan(0.05);
    }
    const vespas = w.vehicles.filter((v) => v.kind === VehicleKind.Vespa);
    expect(vespas.length).toBeGreaterThanOrEqual(2);
    for (const v of vespas) expect(R.at(v.x, v.z)).toBe(true);
    for (const v of w.vehicles.filter((v) => v.kind !== VehicleKind.Vespa)) {
      expect(terrainHeight(w, v.x, v.z)).toBeLessThan(v.y - 0.3);
      expect(waterSurface(c, v.x, v.z)).toBeCloseTo(v.y, 1);
    }
    expect(w.ziplines.length).toBeLessThanOrEqual(3);
    for (const z of w.ziplines) {
      // top handle: 2.2–2.6 m above a standing spot within 1.5 m where a player fits
      let grab = false;
      for (let r = 0; r <= 1.5 && !grab; r += 0.5)
        for (let k = 0; k < (r === 0 ? 1 : 8) && !grab; k++) {
          const x = z.ax + Math.sin(k * 0.785) * r, zz = z.az + Math.cos(k * 0.785) * r;
          const g = groundBelow(c, x, z.ay, zz);
          const dy = z.ay - g;
          if (dy >= 2.2 && dy <= 2.6 && sdf(c, x, g + 1, zz) > 0.3 && sdf(c, x, g + 1.5, zz) > 0.3) grab = true;
        }
      expect(grab, `zipline top at ${z.ax.toFixed(0)},${z.az.toFixed(0)} not grabbable`).toBe(true);
      // bottom: a safe 1–2 m drop, or over water
      const gb = groundBelow(c, z.bx, z.by, z.bz);
      const overWater = waterSurface(c, z.bx, z.bz) > gb;
      expect(overWater || (z.by - gb >= 1 && z.by - gb <= 2)).toBe(true);
    }
    for (const z of w.ziplines) {
      expect(z.ay).toBeGreaterThan(z.by);
      for (let t = 0.1; t < 0.9; t += 0.02) {
        const y = zipCableY(z, t);
        const x = z.ax + (z.bx - z.ax) * t, zz = z.az + (z.bz - z.az) * t;
        expect(y - terrainHeight(w, x, zz)).toBeGreaterThan(1.9);
        // the hanging rider's feet (2.27 m below the cable) stay clear too
        expect(sdf(c, x, y - 2.27 + 0.25, zz)).toBeGreaterThan(0.2);
      }
    }
  });

  it("keeps collider props out of structures and off paths", () => {
    const w = world(seed);
    const c = cw(seed);
    for (const ps of w.props) {
      if (PROP_COLLIDER_RADIUS[ps.kind] <= 0) continue;
      for (let k = 0; k < ps.count; k++) {
        const x = ps.data[k * 5], y = ps.data[k * 5 + 1], z = ps.data[k * 5 + 2];
        const r = PROP_COLLIDER_RADIUS[ps.kind] * ps.data[k * 5 + 4];
        let m = 1e9;
        for (let s = 0; s < c.nSolids; s++) {
          const d = solidSdf(c, s, x, y + 1, z);
          if (d < m) m = d;
          if (m < r) break;
        }
        expect(m).toBeGreaterThan(r);
      }
    }
  });
});

describe("collision API", () => {
  it("sdf, raycast and groundBelow agree with the terrain", () => {
    const w = world(3);
    const c = cw(3);
    let n = 0;
    for (const s of w.spawns.slice(0, 15)) {
      const t = terrainHeight(w, s.x, s.z);
      expect(sdf(c, s.x, t + 1.5, s.z)).toBeGreaterThan(0.5);
      expect(sdf(c, s.x, t - 1, s.z)).toBeLessThan(0);
      const hit = raycast(c, s.x, t + 30, s.z, 0.05, -1, 0.02, 60);
      expect(hit).not.toBeNull();
      expect(Math.abs(hit!.y - terrainHeight(w, hit!.x, hit!.z))).toBeLessThan(0.15);
      expect(["terrain", "prop", "structure"]).toContain(hit!.kind);
      expect(hit!.ny).toBeGreaterThan(0.3);
      const g = groundBelow(c, s.x, t + 5, s.z);
      expect(Math.abs(g - t)).toBeLessThan(0.1);
      n++;
    }
    expect(n).toBeGreaterThan(10);
    // a ray into the sky misses
    expect(raycast(c, 0, 400, 0, 0.3, 1, 0.2, 200)).toBeNull();
  });

  it("structures block rays and hold you up", () => {
    const w = world(3);
    const c = cw(3);
    const st = w.structures.find((s) => s.solids.some((o) => o.shape === "box" && o.hy > 1.2 && o.hx > 1));
    expect(st).toBeDefined();
    const o = st!.solids.find((o) => o.shape === "box" && o.hy > 1.2 && o.hx > 1)!;
    // shoot at the wall center from 10 m away along its local Z axis
    const nz = Math.cos(o.rotY), nx = Math.sin(o.rotY);
    const d0 = o.hz + 1.2;
    const hit = raycast(c, o.cx + nx * d0, o.cy, o.cz + nz * d0, -nx, 0, -nz, 5);
    expect(hit).not.toBeNull();
    expect(hit!.kind).toBe("structure");
    expect(sdf(c, o.cx, o.cy, o.cz)).toBeLessThan(0);
    const top = groundBelow(c, o.cx, o.cy + o.hy + 3, o.cz);
    expect(top).toBeGreaterThan(o.cy + o.hy - 0.3);
  });

  it("water surface covers the sea and rivers", () => {
    const w = world(4);
    const c = cw(4);
    expect(waterSurface(c, 500, 500)).toBe(0);
    const r = w.rivers[0];
    const p = r.points[Math.floor(r.points.length / 3)];
    expect(Math.abs(waterSurface(c, p.x, p.z) - p.y)).toBeLessThan(0.6);
  });
});

describe("performance", () => {
  it("generates within budget", () => {
    let t0 = performance.now();
    generateWorld(99);
    const full = performance.now() - t0;
    t0 = performance.now();
    generateWorld(98, { skipDecor: true });
    const lite = performance.now() - t0;
    expect(full).toBeLessThan(4000);
    expect(lite).toBeLessThan(3000);
  });
});

describe("determinism rules", () => {
  it("generator sources avoid engine-dependent Math functions", () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts") && !p.endsWith("stub.ts")) files.push(p);
      }
    };
    walk(join(__dirname, "../shared/math"));
    walk(join(__dirname, "../shared/world"));
    expect(files.length).toBeGreaterThan(10);
    const bad = /\bMath\.(sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|exp|expm1|log|log1p|log2|log10|pow|hypot|cbrt|random)\b|\bDate\b|\bperformance\b|\*\*/;
    for (const f of files) {
      // strip comments and strings
      const src = readFileSync(f, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "")
        .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
      const m = src.match(bad);
      expect(m, `${f}: ${m?.[0]}`).toBeNull();
    }
  });
});
