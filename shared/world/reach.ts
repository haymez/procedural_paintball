// Reachability over the island surface: walkable land (slope < ~40°), any
// water (you can always swim), joined through cave tunnels. Used by the
// generator to validate placements and by tests.
import { N, NN, slopeAt, toI } from "./grid";
import { NO_WATER, type World } from "./types";

/** tan(35°): steepest ground we count as walkable (the sim allows ~46°, margin for bilinear cells). */
export const MAX_WALK_SLOPE = 0.7;

export interface Reach {
  /** 1 where the cell belongs to the main connected region. */
  main: Uint8Array;
  /** Is (x, z) (or a cell within r cells) in the main region? */
  at(x: number, z: number, r?: number): boolean;
}

export function computeReach(world: World): Reach {
  const h = world.height;
  // cells: 2 = water (always swimmable), 1 = dry land; neighbours join when the
  // step between the two samples is walkable (or either is water)
  const trav = new Uint8Array(NN);
  for (let i = 0; i < NN; i++) {
    const wet = h[i] <= 0.2 || (world.water[i] !== NO_WATER && world.water[i] > h[i]);
    trav[i] = wet ? 2 : world.holes[i] ? 0 : 1;
  }
  // dry cells must also be gentle as a whole (central differences), which
  // drops knife-edge ridges and cliff lips the sim can't hold
  for (let iz = 1; iz < N - 1; iz++)
    for (let ix = 1; ix < N - 1; ix++) {
      const i = iz * N + ix;
      if (trav[i] === 1 && slopeAt(h, ix, iz) > MAX_WALK_SLOPE) trav[i] = 0;
    }
  const maxDh = MAX_WALK_SLOPE * 2; // per 2 m cell
  const link = (i: number, j: number) => {
    if (!trav[j]) return false;
    if (trav[i] === 2 && trav[j] === 2) {
      // you can't swim up a waterfall (and a big drop is not a way back up)
      const si = world.water[i] !== NO_WATER && world.water[i] > 0 ? world.water[i] : 0;
      const sj = world.water[j] !== NO_WATER && world.water[j] > 0 ? world.water[j] : 0;
      return si - sj < 1.3 && sj - si < 1.3;
    }
    if (trav[i] === 2 || trav[j] === 2) {
      // climbing out of the water: the bank must be low enough to scramble onto
      const wi = trav[i] === 2 ? i : j, li = wi === i ? j : i;
      const surf = world.water[wi] !== NO_WATER && world.water[wi] > 0 ? world.water[wi] : 0;
      return h[li] - surf < 1.3;
    }
    const d = h[i] - h[j];
    return d < maxDh && d > -maxDh;
  };
  const label = new Int32Array(NN).fill(-1);
  const stack = new Int32Array(NN);
  const landCount: number[] = [];
  let nComp = 0;
  for (let s = 0; s < NN; s++) {
    if (!trav[s] || label[s] >= 0) continue;
    let sp = 0, lc = 0;
    stack[sp++] = s;
    label[s] = nComp;
    while (sp > 0) {
      const i = stack[--sp];
      if (trav[i] === 1) lc++;
      const ix = i % N, iz = (i / N) | 0;
      if (ix > 0 && label[i - 1] < 0 && link(i, i - 1)) { label[i - 1] = nComp; stack[sp++] = i - 1; }
      if (ix < N - 1 && label[i + 1] < 0 && link(i, i + 1)) { label[i + 1] = nComp; stack[sp++] = i + 1; }
      if (iz > 0 && label[i - N] < 0 && link(i, i - N)) { label[i - N] = nComp; stack[sp++] = i - N; }
      if (iz < N - 1 && label[i + N] < 0 && link(i, i + N)) { label[i + N] = nComp; stack[sp++] = i + N; }
    }
    landCount.push(lc);
    nComp++;
  }
  const parent = new Int32Array(nComp);
  for (let k = 0; k < nComp; k++) parent[k] = k;
  const find = (a: number): number => {
    while (parent[a] !== a) a = parent[a] = parent[parent[a]];
    return a;
  };
  const labelNear = (x: number, z: number, r: number): number => {
    const ci = toI(x), cj = toI(z);
    for (let d = 0; d <= r; d++)
      for (let dz = -d; dz <= d; dz++)
        for (let dx = -d; dx <= d; dx++) {
          const ix = ci + dx, iz = cj + dz;
          if (ix < 0 || iz < 0 || ix >= N || iz >= N) continue;
          const l = label[iz * N + ix];
          if (l >= 0) return l;
        }
    return -1;
  };
  // caves join the regions at their entrances
  for (const c of world.caves) {
    let first = -1;
    for (const e of c.entrances) {
      if (e.sky) continue; // a skylight is a one-way drop in, not a way out
      const l = labelNear(e.x + e.dx * 4, e.z + e.dz * 4, 4);
      if (l < 0) continue;
      if (first < 0) first = find(l);
      else parent[find(l)] = first;
    }
  }
  const tot = new Float64Array(nComp);
  for (let k = 0; k < nComp; k++) tot[find(k)] += landCount[k];
  let best = 0;
  for (let k = 0; k < nComp; k++) if (tot[k] > tot[best]) best = k;
  const main = new Uint8Array(NN);
  for (let i = 0; i < NN; i++) main[i] = label[i] >= 0 && find(label[i]) === best ? 1 : 0;
  return {
    main,
    at(x: number, z: number, r = 2): boolean {
      const l = labelNear(x, z, r);
      return l >= 0 && find(l) === best;
    },
  };
}

/**
 * Trap analysis. Moves between 4-neighbour cells:
 *  - land → land: stepping down any amount (falling / sliding) is allowed;
 *    stepping up needs both cells walkable and a rise under MAX_WALK_SLOPE.
 *  - land → water: always (jump in); water → land: the bank must be < 1.3 m
 *    above the surface; water → water: always.
 * Returns the cells you can get to from the main region but from which there
 * is no way back to it (1 = trapped), plus the forward/back sets.
 */
/** Steepest cell (central differences) the sim can still walk up (~44°, the sim allows ~46°). */
export const TRAP_WALK_SLOPE = 0.95;

export function trapCells(world: World, main: Uint8Array): { trap: Uint8Array; count: number; back: Uint8Array } {
  const h = world.height;
  const kind = new Uint8Array(NN); // 0 none (hole), 1 land, 2 land walkable, 3 water
  const surf = new Float32Array(NN);
  for (let iz = 0; iz < N; iz++)
    for (let ix = 0; ix < N; ix++) {
      const i = iz * N + ix;
      const fw = world.water[i];
      if (h[i] <= 0.2 || (fw !== NO_WATER && fw > h[i])) {
        kind[i] = 3;
        surf[i] = fw !== NO_WATER && fw > 0 ? fw : 0;
      } else if (world.holes[i]) kind[i] = 0;
      else kind[i] = ix > 0 && iz > 0 && ix < N - 1 && iz < N - 1 && slopeAt(h, ix, iz) <= TRAP_WALK_SLOPE ? 2 : 1;
    }
  const maxDh = MAX_WALK_SLOPE * 2;
  const can = (a: number, b: number): boolean => {
    const ka = kind[a], kb = kind[b];
    if (!kb) return ka !== 0 && world.holes[b] === 1; // into a cave mouth
    if (!ka) return false;
    if (ka === 3) return kb === 3 || h[b] - surf[a] < 1.3;
    if (kb === 3) return true;
    const up = h[b] - h[a];
    if (up <= 0) return true;
    // small steps are always fine; bigger ones need walkable ground on both sides
    return up < 0.5 || (ka === 2 && kb === 2 && up < maxDh);
  };
  const fwd = new Uint8Array(NN), back = new Uint8Array(NN);
  const q = new Int32Array(NN);
  const flood = (mark: Uint8Array, forward: boolean) => {
    let qh = 0, qt = 0;
    // cave mouths (holes) lead into the tunnels, which join the main region
    for (let i = 0; i < NN; i++) if (main[i] || world.holes[i]) { mark[i] = 1; q[qt++] = i; }
    while (qh < qt) {
      const c = q[qh++];
      const ix = c % N, iz = (c / N) | 0;
      for (let k = 0; k < 4; k++) {
        const nx = ix + (k === 0 ? 1 : k === 1 ? -1 : 0), nz = iz + (k === 2 ? 1 : k === 3 ? -1 : 0);
        if (nx < 0 || nz < 0 || nx >= N || nz >= N) continue;
        const n = nz * N + nx;
        if (mark[n]) continue;
        if (forward ? can(c, n) : can(n, c)) {
          mark[n] = 1;
          q[qt++] = n;
        }
      }
    }
  };
  flood(fwd, true);
  flood(back, false);
  const trap = new Uint8Array(NN);
  let count = 0;
  for (let i = 0; i < NN; i++)
    if (fwd[i] && !back[i]) {
      trap[i] = 1;
      count++;
    }
  return { trap, count, back };
}

/** Is (x, y, z) inside a cave tunnel/chamber of the world (roughly)? Returns the cave index or -1. */
export function caveAt(world: World, x: number, y: number, z: number): number {
  for (let c = 0; c < world.caves.length; c++) {
    for (const n of world.caves[c].nodes) {
      const dx = n.x - x, dy = n.y - y, dz = n.z - z;
      if (dx * dx + dz * dz < n.r * n.r * 1.6 && dy * dy < n.r * n.r * 2.2) return c;
    }
  }
  return -1;
}
