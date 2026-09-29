import { describe, expect, it } from "vitest";
import { generateWorld } from "../shared/world/generate";
import { buildCollision, groundBelow, sdf, type CollisionWorld } from "../shared/world/collide";
import { StructureKind, type Structure } from "../shared/world/types";

/**
 * Flood-fill a 0.25 m lattice of standable spots starting outside a
 * structure's door: step-ups <= 0.55 m, upper body (0.95–1.5 m) needs 0.3 m of
 * clearance. Returns the highest floor reached.
 */
function climb(cw: CollisionWorld, st: Structure, startDist: number): number {
  const sx = st.x + Math.sin(st.rotY) * startDist, sz = st.z + Math.cos(st.rotY) * startDist;
  const key = (x: number, z: number, y: number) => `${Math.round(x * 4)},${Math.round(z * 4)},${Math.round(y * 2)}`;
  const seen = new Set<string>();
  const q: [number, number, number][] = [];
  const g0 = groundBelow(cw, sx, st.y + 1.5, sz);
  q.push([sx, sz, g0]);
  seen.add(key(sx, sz, g0));
  let maxY = g0;
  for (let head = 0; head < q.length && head < 40000; head++) {
    const [x, z, y] = q[head];
    if (y > maxY) maxY = y;
    for (const [dx, dz] of [[0.25, 0], [-0.25, 0], [0, 0.25], [0, -0.25]]) {
      const nx = x + dx, nz = z + dz;
      if (Math.abs(nx - st.x) > 9 || Math.abs(nz - st.z) > 9) continue;
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

describe("structures are enterable and climbable", () => {
  for (const seed of [2, 3, 7]) {
    it(`seed ${seed}: lighthouse / watchtower tops and cottage interiors are reachable`, () => {
      const w = generateWorld(seed, { skipDecor: true });
      const cw = buildCollision(w);
      let checked = 0;
      for (const st of w.structures) {
        const top = Math.max(...st.solids.map((s) => s.cy + s.hy));
        if (st.kind === StructureKind.Lighthouse) {
          // top floor is ~3 m below the lantern roof
          expect(climb(cw, st, 6)).toBeGreaterThan(top - 3.4);
          checked++;
        } else if (st.kind === StructureKind.Watchtower) {
          expect(climb(cw, st, 6)).toBeGreaterThan(top - 2.2);
          checked++;
        } else if (st.kind === StructureKind.Cottage) {
          // the door leads in: we can stand on the floor slab
          expect(climb(cw, st, 4.5)).toBeGreaterThan(st.y + 0.05);
          checked++;
        }
      }
      expect(checked).toBeGreaterThanOrEqual(3);
    });
  }
});
