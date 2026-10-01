import { describe, expect, it } from "vitest";
import { generateWorld } from "../shared/world/generate";
import { buildCollision, groundBelow, sdf, terrainHeight, type CollisionWorld } from "../shared/world/collide";
import { Material, StructureKind, type Structure, type World } from "../shared/world/types";

/**
 * Flood-fill a 0.25 m lattice of standable spots starting outside a
 * structure's front (local +Z): step-ups <= 0.55 m, upper body (0.95–1.5 m)
 * needs 0.3 m of clearance. Returns the highest floor reached within R m.
 */
function climb(w: World, cw: CollisionWorld, st: Structure, R = 9): number {
  // walk out of the front until we stand on open ground
  let sx = st.x, sz = st.z, g0 = -Infinity;
  for (let d = 0; d < 20; d += 0.5) {
    const x = st.x + Math.sin(st.rotY) * d, z = st.z + Math.cos(st.rotY) * d;
    const g = groundBelow(cw, x, st.y + 1.5, z);
    if (Math.abs(g - terrainHeight(w, x, z)) < 0.15 && sdf(cw, x, g + 0.95, z) > 0.4 && sdf(cw, x, g + 1.5, z) > 0.4) {
      sx = x; sz = z; g0 = g;
      R = Math.max(R, d + 1.5);
      break;
    }
  }
  const key = (x: number, z: number, y: number) => `${Math.round(x * 4)},${Math.round(z * 4)},${Math.round(y * 2)}`;
  const seen = new Set<string>();
  const q: [number, number, number][] = [];
  q.push([sx, sz, g0]);
  seen.add(key(sx, sz, g0));
  let maxY = g0;
  for (let head = 0; head < q.length && head < 160000; head++) {
    const [x, z, y] = q[head];
    if (y > maxY) maxY = y;
    for (const [dx, dz] of [[0.25, 0], [-0.25, 0], [0, 0.25], [0, -0.25]]) {
      const nx = x + dx, nz = z + dz;
      if (Math.abs(nx - st.x) > R || Math.abs(nz - st.z) > R) continue;
      const g = groundBelow(cw, nx, y + 0.6, nz);
      if (!(g > y - 1.2) || g - y > 0.55) continue;
      if (sdf(cw, nx, g + 0.95, nz) < 0.3 || sdf(cw, nx, g + 1.5, nz) < 0.3) continue;
      const k = key(nx, nz, g);
      if (seen.has(k)) continue;
      seen.add(k);
      q.push([nx, nz, g]);
    }
  }
  return maxY;
}

/** Top of the highest thin floor slab of a given material (upper floors, decks, lofts). */
function slabTop(st: Structure, mat: Material, maxHy: number): number {
  let top = -Infinity, area = 0;
  for (const s of st.solids) {
    if (s.shape !== "box" || s.mat !== mat || s.hy > maxHy) continue;
    const a = s.hx * s.hz;
    if (a < 2) continue;
    const t = s.cy + s.hy;
    if (t > top + 0.5 || (Math.abs(t - top) <= 0.5 && a > area)) { top = t; area = a; }
  }
  return top;
}

describe("structures are enterable and climbable", () => {
  for (const seed of [2, 3, 7, 11]) {
    it(`seed ${seed}: towers, upper floors, roof decks, ruins and interiors are reachable`, () => {
      const w = generateWorld(seed, { skipDecor: true });
      const cw = buildCollision(w);
      let checked = 0, village = 0;
      for (const st of w.structures) {
        const top = Math.max(...st.solids.map((s) => s.cy + s.hy));
        const tag = `${StructureKind[st.kind]} at ${st.x.toFixed(0)},${st.z.toFixed(0)}`;
        switch (st.kind) {
          case StructureKind.Lighthouse:
            // top floor is ~3 m below the lantern roof
            expect(climb(w, cw, st), tag).toBeGreaterThan(top - 3.4);
            break;
          case StructureKind.Watchtower:
            expect(climb(w, cw, st), tag).toBeGreaterThan(top - 2.2);
            break;
          case StructureKind.Cottage:
            // the door leads in: we can stand on the floor slab
            expect(climb(w, cw, st), tag).toBeGreaterThan(st.y + 0.05);
            break;
          case StructureKind.House:
          case StructureKind.Hale:
          case StructureKind.Church:
            // up the front steps onto the raised floor
            expect(climb(w, cw, st, 10), tag).toBeGreaterThan(st.y + 0.3);
            village++;
            break;
          case StructureKind.Hotel:
            // inside or outside stair to the upper floor / balcony
            expect(climb(w, cw, st, 11), tag).toBeGreaterThan(slabTop(st, Material.Wood, 0.12) - 0.2);
            village++;
            break;
          case StructureKind.Store:
            // outside stair to the roof deck
            expect(climb(w, cw, st, 10), tag).toBeGreaterThan(slabTop(st, Material.Corrugated, 0.12) - 0.2);
            village++;
            break;
          case StructureKind.SugarMill:
            expect(climb(w, cw, st, 12), tag).toBeGreaterThan(slabTop(st, Material.Wood, 0.3) - 0.2);
            break;
          case StructureKind.Manor:
            expect(climb(w, cw, st, 12), tag).toBeGreaterThan(slabTop(st, Material.Wood, 0.12) - 0.2);
            break;
          case StructureKind.Heiau:
            // up the terraces to the top platform
            expect(climb(w, cw, st, 13), tag).toBeGreaterThan(st.y + 3.4);
            break;
          default:
            continue;
        }
        checked++;
      }
      expect(checked).toBeGreaterThanOrEqual(6);
      expect(village).toBeGreaterThanOrEqual(5);
    });
  }
});
