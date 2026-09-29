// Stage: trap removal. Finds places a player can fall or slide into but never
// walk / swim out of, and fixes them:
//  - narrow slots (< ~3 m wide, > 2 m deep) are filled so the capsule can't wedge;
//  - big closed pits become pools (>= 2 m deep, one low bank to climb out);
//  - everything else is back-filled into a walkable bowl (slopes <= ~29°).
import type { Rng } from "../../math/rng";
import type { Ctx } from "../context";
import { edt, gx, Heap, N, NN } from "../grid";
import { computeReach, trapCells } from "../reach";
import { CELL, NO_WATER } from "../types";
import { worldFromCtx } from "./gameplay";
import { BLOCK_STRUCT } from "./sites";


export function trapsStage(ctx: Ctx, rng: Rng): void {
  void rng;
  for (let round = 0; round < 2; round++) {
    fillSlots(ctx);
    for (let pass = 0; pass < 4; pass++) {
      const world = worldFromCtx(ctx);
      const main = computeReach(world).main;
      const { trap, count, back } = trapCells(world, main);
      if (count === 0) break;
      if (round === 0 && pass === 0 && makePools(ctx, trap)) continue;
      backfill(ctx, trap, back);
    }
  }
  // backfill can leave a narrow ledge at the foot of a tall cliff
  fillSlots(ctx);
  // fresh water may have changed
  const wm = new Uint8Array(NN);
  for (let i = 0; i < NN; i++) wm[i] = ctx.water[i] !== NO_WATER ? 1 : 0;
  const wd = edt(wm, N, N);
  for (let i = 0; i < NN; i++) ctx.waterDist[i] = wd[i] > 1e6 ? 1e6 : wd[i] * CELL;
}

/** Raise the floor of slots whose walls on both sides stand > 2 m higher within 2–2.8 m. */
function fillSlots(ctx: Ctx): void {
  const h = ctx.height;
  const offs = [1, N, N + 1, N - 1];
  for (let it = 0; it < 12; it++) {
    let changed = 0;
    for (let iz = 2; iz < N - 2; iz++)
      for (let ix = 2; ix < N - 2; ix++) {
        const i = iz * N + ix;
        if (h[i] <= 0.3 || ctx.water[i] !== NO_WATER || ctx.holes[i] || ctx.blocked[i] & BLOCK_STRUCT) continue;
        let target = h[i];
        for (const o of offs) {
          const a = h[i - o], b = h[i + o];
          const m = a < b ? a : b;
          if (m - h[i] > 2 && m - 1.2 > target) target = m - 1.2;
        }
        if (target > h[i]) {
          h[i] = target;
          changed++;
        }
      }
    if (!changed) break;
  }
}

/** Closed pits that are deep and wide enough become pools with a low exit bank. */
function makePools(ctx: Ctx, trap: Uint8Array): boolean {
  const h = ctx.height;
  const seen = new Uint8Array(NN);
  const stack: number[] = [];
  let made = false;
  for (let s = 0; s < NN; s++) {
    if (!trap[s] || seen[s]) continue;
    const comp: number[] = [];
    stack.push(s);
    seen[s] = 1;
    let rim = 1e9, lo = 1e9, wet = false;
    while (stack.length) {
      const c = stack.pop()!;
      comp.push(c);
      if (h[c] < lo) lo = h[c];
      if (ctx.water[c] !== NO_WATER) wet = true;
      for (const n of [c - 1, c + 1, c - N, c + N]) {
        if (n < 0 || n >= NN) continue;
        if (trap[n]) {
          if (!seen[n]) {
            seen[n] = 1;
            stack.push(n);
          }
        } else if (h[n] < rim) rim = h[n];
      }
    }
    const level = rim - 0.2;
    const depth = level - lo;
    if (wet || depth < 2.1 || comp.length < 25) continue;
    const cells: number[] = [];
    for (const c of comp) if (h[c] < level) {
      ctx.water[c] = level;
      cells.push(c);
    }
    if (cells.length < 12) {
      for (const c of cells) ctx.water[c] = NO_WATER;
      continue;
    }
    let deep = cells[0];
    for (const c of cells) if (h[c] < h[deep]) deep = c;
    ctx.lakes.push({ level, x: gx(deep % N), z: gx((deep / N) | 0) });
    ctx.lakeCells.push(Int32Array.from(cells));
    made = true;
  }
  return made;
}

/**
 * Priority-flood from the escape region into the trap cells: each trap cell is
 * raised to at least (lowest escapable neighbour - 0.45 m), which leaves a shallow bowl
 * whose every step can be walked back up.
 */
function backfill(ctx: Ctx, trap: Uint8Array, back: Uint8Array): void {
  const h = ctx.height;
  const done = new Uint8Array(NN);
  const heap = new Heap(4096);
  for (let i = 0; i < NN; i++) {
    if (!trap[i]) continue;
    for (const n of [i - 1, i + 1, i - N, i + N]) {
      if (n < 0 || n >= NN || trap[n] || done[n]) continue;
      if (!back[n]) continue;
      done[n] = 1;
      heap.push(ctx.water[n] !== NO_WATER && ctx.water[n] > h[n] ? ctx.water[n] : h[n], n);
    }
  }
  const STEP = 0.45; // below the sim step height, so every step out is walkable regardless of slope
  while (heap.size > 0) {
    const c = heap.pop();
    const hc = heap.lastPri;
    for (const n of [c - 1, c + 1, c - N, c + N]) {
      if (n < 0 || n >= NN || done[n] || !trap[n]) continue;
      done[n] = 1;
      let v = h[n];
      // (pads by structures / cave mouths may be raised too: the fill never rises above a neighbour)
      if (!ctx.holes[n] && v < hc - STEP) v = hc - STEP;
      h[n] = v;
      heap.push(v, n);
    }
  }
}
