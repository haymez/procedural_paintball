// Render-only ground cover. The generator places the gameplay props; this adds
// dense, purely decorative, NON-colliding undergrowth (grass, flower drifts,
// ferns, bush clumps around trunks, reeds, pebbles) from the biome/moisture
// grids so hills read lush up close. Only kinds with PROP_COLLIDER_RADIUS 0 are
// used, so collision and shots are unaffected. Distance culling keeps it near
// the camera.
import {
  Biome, CELL, GRID_RES, NO_WATER, PROP_COLLIDER_RADIUS, PROP_STRIDE, PropKind, WORLD_HALF,
  type PropSet, type World,
} from "../../../../shared/world/types";

type Rule = [PropKind, number, number, number]; // kind, expected per 2 m cell, min scale, max scale

const RULES: Partial<Record<Biome, Rule[]>> = {
  [Biome.Meadow]: [[PropKind.GrassTuft, 0.45, 0.6, 1.1], [PropKind.Flowers, 0.45, 0.8, 1.3], [PropKind.Bush, 0.1, 0.8, 1.5], [PropKind.RockSmall, 0.02, 0.6, 1.2]],
  [Biome.PalmGrove]: [[PropKind.GrassTuft, 0.3, 0.6, 1.1], [PropKind.Flowers, 0.1, 0.8, 1.2], [PropKind.Fern, 0.1, 0.7, 1.2], [PropKind.Bush, 0.1, 0.8, 1.5], [PropKind.Bougainvillea, 0.004, 0.8, 1.2]],
  // jungle floor: ferns and big-leaf understory everywhere, a few logs, hardly any grass
  [Biome.Jungle]: [[PropKind.Fern, 0.75, 0.8, 1.6], [PropKind.Understory, 0.2, 0.8, 1.4], [PropKind.TiPlant, 0.025, 0.7, 1.2], [PropKind.GrassTuft, 0.05, 0.6, 1.0], [PropKind.Bush, 0.05, 0.8, 1.4], [PropKind.Log, 0.004, 0.8, 1.3], [PropKind.RockSmall, 0.015, 0.6, 1.2], [PropKind.Flowers, 0.01, 0.8, 1.1]],
  // Mediterranean woodland: maquis thickets, sparse ferns, dry grass in clearings, logs and stones
  [Biome.Forest]: [[PropKind.Bush, 0.12, 0.7, 1.4], [PropKind.GrassTuft, 0.22, 0.5, 0.9], [PropKind.Fern, 0.08, 0.7, 1.1], [PropKind.Log, 0.005, 0.8, 1.3], [PropKind.RockSmall, 0.05, 0.6, 1.3], [PropKind.Flowers, 0.04, 0.7, 1.0]],
  [Biome.Scrub]: [[PropKind.GrassTuft, 0.55, 0.5, 1.0], [PropKind.Bush, 0.14, 0.6, 1.2], [PropKind.RockSmall, 0.08, 0.6, 1.3], [PropKind.Agave, 0.02, 0.7, 1.1], [PropKind.Flowers, 0.05, 0.7, 1.0]],
  [Biome.Riverbank]: [[PropKind.GrassTuft, 0.4, 0.8, 1.3], [PropKind.Fern, 0.25, 0.8, 1.3], [PropKind.Reed, 0.2, 0.8, 1.3], [PropKind.Flowers, 0.06, 0.8, 1.2]],
  [Biome.Village]: [[PropKind.GrassTuft, 0.05, 0.6, 1.0], [PropKind.Flowers, 0.12, 0.8, 1.2]],
  [Biome.Mangrove]: [[PropKind.Fern, 0.2, 0.8, 1.2], [PropKind.Reed, 0.15, 0.8, 1.2], [PropKind.GrassTuft, 0.2, 0.7, 1.1]],
  [Biome.Rock]: [[PropKind.RockSmall, 0.05, 0.6, 1.3], [PropKind.GrassTuft, 0.12, 0.6, 1.0]],
  [Biome.Cliff]: [[PropKind.GrassTuft, 0.05, 0.6, 1.0]],
  [Biome.Beach]: [[PropKind.GrassTuft, 0.04, 0.6, 1.0]],
};

/** Trees that get an undergrowth clump at their feet. */
const TRUNKS = new Set<PropKind>([PropKind.Broadleaf, PropKind.UmbrellaPine, PropKind.Olive, PropKind.Palm, PropKind.PalmLeaning, PropKind.LemonTree, PropKind.Cypress, PropKind.Banana,
  PropKind.JungleGiant, PropKind.TreeFern, PropKind.HolmOak, PropKind.Pine]);

function hash(a: number, b: number, c: number): number {
  let h = Math.imul(a, 0x27d4eb2d) ^ Math.imul(b, 0x165667b1) ^ Math.imul(c + 0x9e3779b9, 0x85ebca77);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
/** smooth-ish clump noise: bilinear over a coarse hashed lattice */
function clump(x: number, z: number, scale: number, seed: number): number {
  const fx = x / scale, fz = z / scale;
  const ix = Math.floor(fx), iz = Math.floor(fz);
  const tx = fx - ix, tz = fz - iz;
  const sx = tx * tx * (3 - 2 * tx), sz = tz * tz * (3 - 2 * tz);
  const a = hash(ix, iz, seed), b = hash(ix + 1, iz, seed), c = hash(ix, iz + 1, seed), d = hash(ix + 1, iz + 1, seed);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}

export function groundCover(world: World, amount = 1): PropSet[] {
  const N = GRID_RES;
  const H = world.height;
  const out = new Map<PropKind, number[]>();
  const push = (k: PropKind, x: number, y: number, z: number, rot: number, s: number) => {
    let l = out.get(k);
    if (!l) { l = []; out.set(k, l); }
    l.push(x, y, z, rot, s);
  };
  const hAt = (x: number, z: number) => {
    const gx = (x + WORLD_HALF) / CELL, gz = (z + WORLD_HALF) / CELL;
    const ix = Math.max(0, Math.min(N - 2, Math.floor(gx))), iz = Math.max(0, Math.min(N - 2, Math.floor(gz)));
    const tx = gx - ix, tz = gz - iz, i = iz * N + ix;
    return H[i] * (1 - tx) * (1 - tz) + H[i + 1] * tx * (1 - tz) + H[i + N] * (1 - tx) * tz + H[i + N + 1] * tx * tz;
  };

  // keep clear of structures: coarse occupancy from solid footprints (+1 m)
  const occ = new Uint8Array(N * N);
  for (const st of world.structures) for (const s of st.solids) {
    const r = Math.hypot(s.hx, s.shape === "cylinder" ? s.hx : s.hz) + 1;
    const i0 = Math.max(0, Math.floor((s.cx - r + WORLD_HALF) / CELL)), i1 = Math.min(N - 1, Math.ceil((s.cx + r + WORLD_HALF) / CELL));
    const j0 = Math.max(0, Math.floor((s.cz - r + WORLD_HALF) / CELL)), j1 = Math.min(N - 1, Math.ceil((s.cz + r + WORLD_HALF) / CELL));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) occ[j * N + i] = 1;
  }
  const blocked = (k: number) => occ[k] || world.holes[k] || world.path[k] > 70 || (world.water[k] !== NO_WATER && world.water[k] > H[k] - 0.05);

  const seed = world.seed | 0;
  for (let j = 1; j < N - 1; j++) for (let i = 1; i < N - 1; i++) {
    const k = j * N + i;
    const b = world.biome[k] as Biome;
    const rules = RULES[b];
    if (!rules || blocked(k)) continue;
    const h = H[k];
    if (h < 0.4) continue;
    const sl = Math.hypot(H[k + 1] - H[k - 1], H[k + N] - H[k - N]) / (2 * CELL);
    if (sl > 0.9) continue;
    const x0 = -WORLD_HALF + i * CELL, z0 = -WORLD_HALF + j * CELL;
    const m = world.moisture[k] / 255;
    for (let r = 0; r < rules.length; r++) {
      const [kind, per, s0, s1] = rules[r];
      // drifts: grass/flowers/ferns clump; moisture boosts ferns, dryness boosts grass
      let n = per * amount * (1 - sl * 0.8);
      if (kind === PropKind.Flowers) n *= Math.max(0, clump(x0, z0, 14, seed + 1) * 2.4 - 1.1);
      else if (kind === PropKind.GrassTuft && b === Biome.Forest) n *= Math.max(0, clump(x0, z0, 16, seed + 6) * 2.6 - 1.2); // dry-grass clearings
      else if (kind === PropKind.GrassTuft) n *= 0.35 + clump(x0, z0, 9, seed + 2) * 1.3;
      else if (kind === PropKind.Fern) n *= (0.4 + m) * (0.3 + clump(x0, z0, 7, seed + 3) * 1.4);
      else if (kind === PropKind.Understory) n *= Math.max(0, clump(x0, z0, 11, seed + 5) * 2.2 - 0.5);
      else if (kind === PropKind.Bush || kind === PropKind.Bougainvillea) n *= Math.max(0, clump(x0, z0, 22, seed + 4) * 3 - 1.2); // thickets
      const whole = Math.floor(n);
      const count = whole + (hash(i, j, seed + r * 131) < n - whole ? 1 : 0);
      for (let c = 0; c < count; c++) {
        const u = hash(i * 7 + c, j, seed + r * 17 + 5), v = hash(i, j * 5 + c, seed + r * 29 + 9), w = hash(i + c, j + c * 3, seed + r * 7);
        const x = x0 + (u - 0.5) * CELL, z = z0 + (v - 0.5) * CELL;
        push(kind, x, hAt(x, z) - 0.05, z, w * Math.PI * 2, s0 + (s1 - s0) * hash(c, i + j, seed + r));
      }
    }
  }

  // undergrowth clumps at the feet of trees: canopy + bush mass reads as lush clusters
  for (const ps of world.props) {
    if (!TRUNKS.has(ps.kind)) continue;
    for (let q = 0; q < ps.count; q++) {
      const o = q * PROP_STRIDE;
      const tx = ps.data[o], tz = ps.data[o + 2];
      const gi = Math.round((tz + WORLD_HALF) / CELL) * N + Math.round((tx + WORLD_HALF) / CELL);
      if (gi < 0 || gi >= N * N || blocked(gi)) continue;
      const jungle = world.biome[gi] === Biome.Jungle || world.biome[gi] === Biome.Riverbank;
      const forest = world.biome[gi] === Biome.Forest;
      const nClump = 2 + Math.floor(hash(q, ps.kind, seed + 77) * 3 * amount);
      for (let c = 0; c < nClump; c++) {
        const a = hash(q, c, seed + 91) * Math.PI * 2;
        const d = 1.4 + hash(c, q, seed + 93) * 2.4;
        const x = tx + Math.cos(a) * d, z = tz + Math.sin(a) * d;
        const g2 = Math.round((z + WORLD_HALF) / CELL) * N + Math.round((x + WORLD_HALF) / CELL);
        if (g2 < 0 || g2 >= N * N || blocked(g2)) continue;
        const pick = hash(c, q, seed + 95);
        const kind = jungle ? (pick < 0.5 ? PropKind.Fern : pick < 0.8 ? PropKind.Understory : PropKind.Bush)
          : forest ? (pick < 0.55 ? PropKind.Bush : pick < 0.8 ? PropKind.Fern : PropKind.RockSmall)
          : pick < 0.45 ? PropKind.Bush : pick < 0.75 ? PropKind.GrassTuft : PropKind.Flowers;
        push(kind, x, hAt(x, z) - 0.05, z, a * 3.1, 0.8 + hash(q, c, seed + 97) * 0.6);
      }
    }
  }

  const sets: PropSet[] = [];
  for (const [kind, l] of out) {
    if (PROP_COLLIDER_RADIUS[kind] !== 0) continue; // never add anything that would need collision
    sets.push({ kind, count: l.length / PROP_STRIDE, data: new Float32Array(l) });
  }
  return sets;
}
