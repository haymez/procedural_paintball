// Rivers must visibly and physically reach the water they flow into: no strip
// of dry beach between a stream and the sea, no stream dead-ending in a
// sea-level puddle short of a cove, no channel filled back in by a later stage.
import { describe, expect, it } from "vitest";
import { generateWorld } from "../shared/world/generate";
import { NO_WATER, type World } from "../shared/world/types";

const N = 513;
const SEEDS = [...Array.from({ length: 22 }, (_, i) => i + 1), 42, 99, 1234];

const cache = new Map<number, World>();
function world(seed: number): World {
  let w = cache.get(seed);
  if (!w) cache.set(seed, (w = generateWorld(seed, { skipDecor: true })));
  return w;
}

const cellOf = (x: number, z: number) => {
  const ix = Math.max(0, Math.min(N - 1, Math.round((x + 512) / 2)));
  const iz = Math.max(0, Math.min(N - 1, Math.round((z + 512) / 2)));
  return iz * N + ix;
};

/** Open sea: below sea level, no fresh water, 4-connected to the world border (or a big, deep lagoon). */
function openSea(w: World): Uint8Array {
  const H = w.height, W = w.water;
  const sea = (i: number) => H[i] < 0 && W[i] === NO_WATER;
  const lab = new Uint8Array(N * N);
  const flood = (seeds: number[], mark: number, comp?: number[]) => {
    const st = seeds.filter((i) => sea(i) && !lab[i]);
    for (const i of st) lab[i] = mark;
    while (st.length) {
      const c = st.pop()!;
      comp?.push(c);
      const x = c % N;
      for (const n of [x > 0 ? c - 1 : -1, x < N - 1 ? c + 1 : -1, c - N, c + N]) {
        if (n < 0 || n >= N * N || lab[n] || !sea(n)) continue;
        lab[n] = mark;
        st.push(n);
      }
    }
  };
  const border: number[] = [];
  for (let k = 0; k < N; k++) border.push(k, (N - 1) * N + k, k * N, k * N + N - 1);
  flood(border, 1);
  for (let s = 0; s < N * N; s++) {
    if (lab[s] || !sea(s)) continue;
    const comp: number[] = [];
    flood([s], 2, comp);
    let lo = 0;
    for (const i of comp) lo = Math.min(lo, H[i]);
    if (comp.length >= 100 && lo < -0.6) for (const i of comp) lab[i] = 1;
  }
  for (let i = 0; i < N * N; i++) if (lab[i] !== 1) lab[i] = 0;
  return lab;
}

describe.each(SEEDS)("island %i rivers", (seed) => {
  it("reach their sea, lake or river through wet ground", () => {
    const w = world(seed);
    const H = w.height, W = w.water;
    const ocean = openSea(w);
    const wet = (i: number) => (W[i] !== NO_WATER && W[i] > H[i] - 0.05) || H[i] < 0;
    let seaRivers = 0;
    for (const [ri, r] of w.rivers.entries()) {
      const P = r.points;
      const tag = `river ${ri} (${P[0].x.toFixed(0)}, ${P[0].z.toFixed(0)}) → (${P[P.length - 1].x.toFixed(0)}, ${P[P.length - 1].z.toFixed(0)})`;
      // the whole course holds water: nothing filled the channel back in
      for (const p of P) expect(wet(cellOf(p.x, p.z)), `${tag}: dry at (${p.x.toFixed(0)}, ${p.z.toFixed(0)})`).toBe(true);
      const e = P[P.length - 1];
      if (e.y > 0.01) continue;
      seaRivers++;
      // a sea-level mouth opens onto the open sea (or a lagoon) within a few metres of wet ground
      const start = cellOf(e.x, e.z);
      const seen = new Map<number, number>([[start, 0]]);
      const q = [start];
      let reached = ocean[start] === 1;
      while (q.length && !reached) {
        const c = q.shift()!;
        const d = seen.get(c)!;
        if (d >= 6) continue;
        const x = c % N;
        for (const n of [x > 0 ? c - 1 : -1, x < N - 1 ? c + 1 : -1, c - N, c + N]) {
          if (n < 0 || n >= N * N || seen.has(n) || !wet(n)) continue;
          if (ocean[n]) { reached = true; break; }
          seen.set(n, d + 1);
          q.push(n);
        }
      }
      expect(reached, `${tag}: mouth not connected to the open sea`).toBe(true);
      // a river that drops off a cliff into the sea shows a waterfall there
      for (let k = 1; k < P.length; k++) {
        if (P[k - 1].y - P[k].y < 4) continue;
        const fall = w.waterfalls.some((f) => Math.hypot(f.x - P[k].x, f.z - P[k].z) < 24 && f.top - f.bottom > 3);
        if (P[k].y <= 0.01) expect(fall, `${tag}: drops ${(P[k - 1].y - P[k].y).toFixed(1)} m into the sea without a waterfall`).toBe(true);
      }
    }
    expect(seaRivers).toBeGreaterThanOrEqual(1);
  });

  it("leave no sea-level pockets cut off from the sea at river mouths", () => {
    const w = world(seed);
    const ocean = openSea(w);
    const H = w.height, W = w.water;
    for (const r of w.rivers) {
      const e = r.points[r.points.length - 1];
      if (e.y > 0.01) continue;
      // every sub-sea-level cell within 30 m of the mouth belongs to the open sea
      const c = cellOf(e.x, e.z), cx = c % N, cz = (c / N) | 0;
      for (let dz = -15; dz <= 15; dz++)
        for (let dx = -15; dx <= 15; dx++) {
          const x = cx + dx, z = cz + dz;
          if (x < 0 || z < 0 || x >= N || z >= N) continue;
          const i = z * N + x;
          if (H[i] < 0 && W[i] === NO_WATER) expect(ocean[i], `cut-off pocket at (${-512 + x * 2}, ${-512 + z * 2})`).toBe(1);
        }
    }
  });
});
