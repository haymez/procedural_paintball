// Helpers shared by the site builders (sites.ts, village.ts, ruins.ts):
// occupancy bits, ground statistics, flattening and structure registration.
import { cos, sin } from "../../math/trig";
import { smoothstep } from "../../math/vec";
import type { Ctx } from "../context";
import { gx, N, sample, toI } from "../grid";
import { NO_WATER, type Solid, type StructureKind, type VisualPart } from "../types";
import type { Builder } from "./build";

export const BLOCK_STRUCT = 1;
export const BLOCK_PATH = 2;
export const BLOCK_CAVE = 4;
export const BLOCK_WATER = 8;
export const BLOCK_DOCK = 16;
export const BLOCK_VILLAGE = 32;
/** Open lawns (the ballfield): no trees, and roads go round. */
export const BLOCK_FIELD = 64;

export interface Stats {
  mean: number;
  min: number;
  max: number;
  wet: boolean;
}

/** Ground height stats on 3 rings out to radius r; wet if water, a hole, a cave or a structure is there. */
export function stats(ctx: Ctx, x: number, z: number, r: number): Stats {
  let sum = 0, n = 0, mn = 1e9, mx = -1e9, wet = false;
  const h = ctx.height;
  for (let ring = 0; ring <= 2; ring++) {
    const rr = (r * ring) / 2;
    const cnt = ring === 0 ? 1 : ring * 8;
    for (let k = 0; k < cnt; k++) {
      const a = (k / cnt) * 6.283185307179586 + ring * 0.3;
      const px = x + sin(a) * rr, pz = z + cos(a) * rr;
      const v = sample(h, px, pz);
      sum += v;
      n++;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
      const i = toI(pz) * N + toI(px);
      if (ctx.water[i] !== NO_WATER || ctx.holes[i] || (ctx.blocked[i] & (BLOCK_CAVE | BLOCK_STRUCT))) wet = true;
    }
  }
  return { mean: sum / n, min: mn, max: mx, wet };
}

/** Flatten ground to Y inside radius r, blending over margin. */
export function flatten(ctx: Ctx, x: number, z: number, r: number, margin: number, Y: number): void {
  const h = ctx.height;
  const R = r + margin;
  for (let iz = toI(z - R); iz <= toI(z + R); iz++)
    for (let ix = toI(x - R); ix <= toI(x + R); ix++) {
      const dx = gx(ix) - x, dz = gx(iz) - z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d > R) continue;
      const i = iz * N + ix;
      if (ctx.water[i] !== NO_WATER || ctx.holes[i]) continue;
      const w = 1 - smoothstep(r, R, d);
      h[i] = h[i] + (Y - h[i]) * w;
    }
}

/** Blend the ground toward the plane a + gx * (x - cx) + gz * (z - cz) inside radius r (+ margin). */
export function flattenPlane(ctx: Ctx, cx: number, cz: number, r: number, margin: number, a: number, gxs: number, gzs: number): void {
  const h = ctx.height;
  const R = r + margin;
  for (let iz = toI(cz - R); iz <= toI(cz + R); iz++)
    for (let ix = toI(cx - R); ix <= toI(cx + R); ix++) {
      const dx = gx(ix) - cx, dz = gx(iz) - cz;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d > R) continue;
      const i = iz * N + ix;
      if (ctx.water[i] !== NO_WATER || ctx.holes[i]) continue;
      const w = 1 - smoothstep(r, R, d);
      const Y = a + gxs * dx + gzs * dz;
      h[i] = h[i] + (Y - h[i]) * w;
    }
}

/** Mark the cells under an oriented rectangle (half sizes hx, hz, rotation like Solid.rotY) plus pad. */
export function markRect(ctx: Ctx, cx: number, cz: number, hx: number, hz: number, rotY: number, pad: number, bit: number): void {
  const c = cos(rotY), s = sin(rotY);
  const ax = hx + pad, az = hz + pad;
  const r = Math.sqrt(ax * ax + az * az);
  for (let iz = toI(cz - r); iz <= toI(cz + r); iz++)
    for (let ix = toI(cx - r); ix <= toI(cx + r); ix++) {
      if (ix < 0 || iz < 0 || ix >= N || iz >= N) continue;
      const dx = gx(ix) - cx, dz = gx(iz) - cz;
      // world -> local (inverse of Builder.wx/wz)
      const lx = dx * c - dz * s, lz = dx * s + dz * c;
      if (lx <= ax && lx >= -ax && lz <= az && lz >= -az) ctx.blocked[iz * N + ix] |= bit;
    }
}

export function markDisc(ctx: Ctx, x: number, z: number, r: number, bit: number): void {
  for (let iz = toI(z - r); iz <= toI(z + r); iz++)
    for (let ix = toI(x - r); ix <= toI(x + r); ix++) {
      if (ix < 0 || iz < 0 || ix >= N || iz >= N) continue;
      const dx = gx(ix) - x, dz = gx(iz) - z;
      if (dx * dx + dz * dz <= r * r) ctx.blocked[iz * N + ix] |= bit;
    }
}

/** Exact footprints (oriented boxes / discs) of solids or visual parts, grown by pad. */
export function markFootprint(ctx: Ctx, solids: (Solid | VisualPart)[], bit: number, pad: number): void {
  for (const s of solids) {
    if (s.shape === "cylinder" || s.shape === "cone") markDisc(ctx, s.cx, s.cz, s.hx + pad, bit);
    else markRect(ctx, s.cx, s.cz, s.hx, s.hz, s.rotY, pad, bit);
  }
}

export function addStructure(ctx: Ctx, kind: StructureKind, b: Builder): number {
  const id = ctx.structures.length;
  ctx.structures.push({ id, kind, x: b.ox, y: b.oy, z: b.oz, rotY: b.rot, solids: b.solids, ...(b.visual.length ? { visual: b.visual } : {}) });
  markFootprint(ctx, b.solids, BLOCK_STRUCT, 1.0);
  markFootprint(ctx, b.visual, BLOCK_STRUCT, 0.3);
  return id;
}

/** Ground min / max / mean over a builder-local rectangle (sampled every ~1.5 m). */
export function groundRect(ctx: Ctx, b: Builder, x0: number, x1: number, z0: number, z1: number): { min: number; max: number; mean: number; wet: boolean } {
  const nx = Math.max(2, Math.ceil((x1 - x0) / 1.5)), nz = Math.max(2, Math.ceil((z1 - z0) / 1.5));
  let mn = 1e9, mx = -1e9, sum = 0, wet = false;
  for (let j = 0; j <= nz; j++)
    for (let i = 0; i <= nx; i++) {
      const lx = x0 + ((x1 - x0) * i) / nx, lz = z0 + ((z1 - z0) * j) / nz;
      const x = b.wx(lx, lz), z = b.wz(lx, lz);
      const v = sample(ctx.height, x, z);
      if (v < mn) mn = v;
      if (v > mx) mx = v;
      sum += v;
      const k = toI(z) * N + toI(x);
      if (ctx.water[k] !== NO_WATER || ctx.holes[k] || ctx.blocked[k] & (BLOCK_CAVE | BLOCK_STRUCT | BLOCK_DOCK)) wet = true;
    }
  return { min: mn, max: mx, mean: sum / ((nx + 1) * (nz + 1)), wet };
}
