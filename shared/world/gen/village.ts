// The plantation village: a living town of 12–16 buildings in the style of an
// old Hawaiian plantation town (Hanapepe / Lahaina) mixed with thatched
// Polynesian hale. Layout (village frame: main street along local X, the
// "north" side +Z is uphill):
//
//          church                         water tower
//   house  [green + big tree]  store        house
//   ======== main street (dirt) ==================  -> road to the boathouse
//   house  hale  [lane]  hotel   house  house
//               house | house
//
// Rules: the site is a gentle, walkable disc (radius 46 m, else 38 / 32)
// whose ground is blended to its best-fit plane, so every lot sits on smooth
// ground; the street grid is squared to the world axes (doors line up with the
// bots' nav lattice). Buildings stand on lava-rock / stone plinths that absorb
// what slope is left (hillside lots get a cut pad) and face the street with a
// lanai or porch and steps that start on the real ground. Lots are dropped when
// their footprint gets wet, steep or crowded. Streets and lanes are dirt
// (ctx.path), lots, green and ballfield packed earth (Biome.Village); gaps keep
// the island's own vegetation. A ballfield (open, level lawn) sits beside the
// main street at one end of town when the ground allows.
import type { Rng } from "../../math/rng";
import { atan2, cos, HALF_PI, sin } from "../../math/trig";
import { smoothstep } from "../../math/vec";
import type { Ctx, Site } from "../context";
import { gx, N, sample, toI } from "../grid";
import { Material, NO_WATER, StructureKind, type Path } from "../types";
import { barrel, beam, Builder, crate, railing, stair, TINT, well, worldSpot, type Opening, type Spot, type WallTrim } from "./build";
import {
  addStructure, BLOCK_CAVE, BLOCK_DOCK, BLOCK_FIELD, BLOCK_PATH, BLOCK_STRUCT, BLOCK_VILLAGE, flatten, flattenPlane, groundRect, markDisc, markRect,
} from "./siteutil";

export interface VStyle {
  /** Lush / tropical islands: lava rock, more hale. */
  pac: boolean;
  found: Material;
  foundTint: number;
  /** Share of plastered (instead of board) houses. */
  plaster: number;
  /** Share of hale among the small lots. */
  hale: number;
}

export function villageStyle(ctx: Ctx): VStyle {
  const c = ctx.ch.climate;
  if (c === "lush" || c === "tropical") return { pac: true, found: Material.LavaRock, foundTint: TINT.lava, plaster: 0, hale: c === "lush" ? 0.45 : 0.35 };
  return { pac: false, found: c === "dry" ? Material.LavaRock : Material.Stone, foundTint: c === "dry" ? TINT.lavaDark : TINT.stone, plaster: 0.35, hale: 0.12 };
}

// Treads at least as deep as the bots' 0.5 m nav lattice, so no lattice step skips a riser.
const STEP_RUN = 0.5;
const STEP_RISE = 0.34;

/** Local ground height (relative to the builder origin). */
export type Ground = (lx: number, lz: number) => number;

/**
 * Steps climbing from the ground in front of zEdge (local +Z) up to fh at
 * zEdge; the first riser starts at the real ground at their foot. Returns their run.
 */
function frontSteps(b: Builder, x: number, zEdge: number, halfW: number, fh: number, below: number, mat: Material, tint: number, ground: Ground): number {
  let y0 = 0, n = 1;
  for (let it = 0; it < 3; it++) {
    n = Math.max(1, Math.ceil((fh - y0) / STEP_RISE - 1e-6));
    y0 = Math.min(0, ground(x, zEdge + n * STEP_RUN), ground(x - halfW * 0.8, zEdge + n * STEP_RUN), ground(x + halfW * 0.8, zEdge + n * STEP_RUN));
  }
  n = Math.max(1, Math.ceil((fh - y0) / STEP_RISE - 1e-6));
  if (fh - y0 < 0.12) return 0;
  const run = n * STEP_RUN;
  stair(b, x, zEdge + run, 0, -1, halfW, y0, fh, mat, tint, STEP_RUN, STEP_RISE, below + y0);
  return run;
}

/** Outside stair along the local axis (dx, dz) ending at (xe, ze) at height top; starts on the real ground. */
function sideStair(b: Builder, xe: number, ze: number, dx: number, dz: number, halfW: number, top: number, mat: Material, tint: number, below: number, ground: Ground, run = 0.52): number {
  let y0 = 0, n = 1;
  for (let it = 0; it < 3; it++) {
    n = Math.max(1, Math.ceil((top - y0) / 0.36 - 1e-6));
    y0 = Math.min(0, ground(xe - dx * n * run, ze - dz * n * run));
  }
  n = Math.max(1, Math.ceil((top - y0) / 0.36 - 1e-6));
  stair(b, xe - dx * n * run, ze - dz * n * run, dx, dz, halfW, y0, top, mat, tint, run, 0.36, below + y0);
  return n * run;
}

/** Steps needed to reach a floor at fh. */
function stepRun(fh: number): number {
  return fh < 0.12 ? 0 : Math.max(1, Math.ceil(fh / STEP_RISE - 1e-6)) * STEP_RUN;
}

/** n evenly spaced openings along a wall of length L. */
function row(L: number, n: number, w: number, y0: number, y1: number, skip: (at: number) => boolean = () => false): Opening[] {
  const out: Opening[] = [];
  for (let k = 0; k < n; k++) {
    const at = (L * (k + 0.5)) / n;
    if (!skip(at)) out.push({ at, w, y0, y1 });
  }
  return out;
}

function trimTint(rng: Rng, paint: number): number {
  const light = ((paint >> 16) & 255) + ((paint >> 8) & 255) + (paint & 255) > 600;
  return light && rng.chance(0.35) ? rng.pick([0x4f6b55, 0x6b4a36, 0x55606e]) : TINT.trim;
}

/** Potted plant / hanging fern (render-only). */
function plant(b: Builder, x: number, y: number, z: number, rng: Rng): void {
  b.vcyl(x, y, z, 0.16, 0.3, Material.Terracotta, 0xd8a080);
  b.vbox(x, y + 0.28, z, 0.24, 0.32, 0.24, Material.Foliage, rng.pick([0x5f8a3c, 0x6f9a48, 0x4f7a3a]), rng.range(0, 1.5));
}

// ---------------------------------------------------------------------------
// Buildings. Local frame: origin at the centre of the main body on the ground
// in front of the steps (y = 0); the body spans x in [-w/2, w/2], z in
// [-d/2, d/2]; the front (+Z) faces the street.

export interface BodyPlan {
  w: number;
  d: number;
  /** Lanai / porch depth in front of the body. */
  pd: number;
  /** Floor (plinth top) height, local. */
  fh: number;
  /** Plinth bottom, local (negative: buried). */
  base: number;
  /** How far step boxes reach below y = 0. */
  below: number;
  paint: number;
  trim: number;
  roof: number;
  /** Ground height under the builder's local (x, z), relative to its origin. */
  ground: Ground;
}

/** Plantation cottage: plinth, board walls, front lanai under the main roof, tin roof. */
export function house(b: Builder, rng: Rng, p: BodyPlan, sty: VStyle, plastered: boolean): Spot[] {
  const { w, d, pd, fh, base } = p;
  const hw = w / 2, hd = d / 2, t = 0.24;
  const H = rng.range(2.8, 3.05);
  const wallMat = plastered ? Material.Plaster : Material.PaintedWood;
  const raised = sty.pac && fh > 0.65;
  // plinth (lava rock / stone, or a dark timber skirt with lattice on raised houses)
  b.box(0, base, pd / 2, hw, fh - base, hd + pd / 2, raised ? Material.WoodDark : sty.found, raised ? 0x8a7a6a : sty.foundTint);
  b.vbox(0, fh, pd / 2, hw - 0.03, 0.025, hd + pd / 2 - 0.03, Material.Wood, 0xcdb79a); // floor boards
  const shutter = rng.chance(0.45) ? rng.pick([0x5f8a72, 0x5d7f98, 0x8a5a48, p.trim]) : 0;
  const trim: WallTrim = { tint: p.trim, cx: 0, cz: 0, shutter };
  // front wall: door + a window either side
  const doorAt = w * rng.range(0.4, 0.6);
  const fo: Opening[] = [{ at: doorAt, w: 1.4, y0: 0, y1: 2.25 }];
  if (doorAt - 1.9 > 0.75) fo.push({ at: doorAt - 1.9, w: 1.0, y0: 0.85, y1: 2.0 });
  if (w - doorAt - 1.9 > 0.75) fo.push({ at: doorAt + 1.9, w: 1.0, y0: 0.85, y1: 2.0 });
  b.wall(-hw, hd - t / 2, hw, hd - t / 2, t, fh, H, fo, wallMat, p.paint, undefined, 0, trim);
  // back wall (runs +x -> -x)
  const backDoor = rng.chance(0.6);
  const bo: Opening[] = backDoor
    ? [{ at: w * 0.25, w: 1.35, y0: 0, y1: 2.2 }, { at: w * 0.7, w: 1.0, y0: 0.85, y1: 2.0 }]
    : row(w, w > 7.2 ? 2 : 1, 1.0, 0.85, 2.0);
  b.wall(hw, -hd + t / 2, -hw, -hd + t / 2, t, fh, H, bo, wallMat, p.paint, undefined, 0, trim);
  // sides
  const L = d - 2 * t;
  b.wall(-hw + t / 2, -hd + t, -hw + t / 2, hd - t, t, fh, H, row(L, d > 6.2 ? 2 : 1, 0.95, 0.85, 2.0), wallMat, p.paint, undefined, 0, trim);
  b.wall(hw - t / 2, hd - t, hw - t / 2, -hd + t, t, fh, H, row(L, d > 6.2 ? 2 : 1, 0.95, 0.85, 2.0), wallMat, p.paint, undefined, 0, trim);
  // interior partition with a doorway: front room / back room
  const zp = rng.range(-0.7, 0.2);
  if (rng.chance(0.55)) {
    const at = rng.range(1.3, w - 2 * t - 1.3);
    b.wall(-hw + t, zp, hw - t, zp, 0.14, fh, H, [{ at, w: 1.4, y0: 0, y1: 2.2 }], wallMat, 0xe8e2d6);
    // furniture in the back room
    b.box(rng.chance(0.5) ? -hw + 1.2 : hw - 1.2, fh, (zp - hd) / 2, 0.75, 0.55, 0.95, Material.Wood, 0xd0c0a8, 0); // bed
  } else {
    b.box(rng.range(-hw + 1.4, hw - 1.4), fh, -hd + 0.9, 0.7, 0.8, 0.4, Material.WoodDark, TINT.wood); // dresser
  }
  // roof: side gable over body + lanai, or a front gable with a lean-to lanai roof
  const rr = rng.range(1.5, 2.1);
  const roofMat = plastered && rng.chance(0.5) ? Material.Terracotta : Material.Corrugated;
  const roofT = roofMat === Material.Terracotta ? 0xffffff : p.roof;
  if (rng.chance(0.72)) {
    b.wedge(0, fh + H, pd / 2, hw + 0.42, rr, hd + pd / 2 + 0.32, roofMat, roofT);
    for (const s of [1, -1]) b.vbox(0, fh + H - 0.16, pd / 2 + s * (hd + pd / 2 + 0.3), hw + 0.42, 0.16, 0.025, Material.Plaster, p.trim);
  } else {
    b.wedge(0, fh + H, 0, hd + 0.4, rr + 0.3, hw + 0.38, roofMat, roofT, Math.PI / 2);
    b.box(0, fh + H - 0.32, hd + pd / 2 + 0.1, hw + 0.15, 0.1, pd / 2 + 0.22, Material.Corrugated, p.roof);
  }
  // lanai posts, railing, steps
  const zf = hd + pd - 0.15;
  const nPost = Math.max(2, Math.ceil(w / 2.7) + 1);
  for (let k = 0; k < nPost; k++) {
    const x = -hw + 0.15 + ((w - 0.3) * k) / (nPost - 1);
    b.box(x, fh, zf, 0.07, H - (H > 0 ? 0.32 : 0), 0.07, Material.Plaster, p.trim);
  }
  const sx = -hw + doorAt; // steps in front of the door
  if (rng.chance(0.65)) {
    if (sx - 0.8 > -hw + 0.4) railing(b, -hw + 0.15, zf, sx - 0.8, zf, fh, p.trim);
    if (sx + 0.8 < hw - 0.4) railing(b, sx + 0.8, zf, hw - 0.15, zf, fh, p.trim);
    railing(b, -hw + 0.15, hd + 0.1, -hw + 0.15, zf, fh, p.trim);
    railing(b, hw - 0.15, hd + 0.1, hw - 0.15, zf, fh, p.trim);
  }
  const run = frontSteps(b, sx, hd + pd, 0.72, fh, p.below, Material.Wood, 0xc8b49a, p.ground);
  const step = worldSpot(b, sx, 0, hd + pd + run + 0.3, "step");
  // stovepipe, lanai plants and a rocking chair
  b.vcyl(hw * 0.45, fh + H + rr * 0.35, -hd * 0.45, 0.09, rr * 0.7 + 0.5, Material.Rust, 0xa09890);
  plant(b, sx - 1.0, fh, hd + pd - 0.45, rng);
  if (rng.chance(0.6)) plant(b, sx + 1.0, fh, hd + pd - 0.45, rng);
  if (rng.chance(0.6)) {
    const cx = rng.chance(0.5) ? -hw + 0.9 : hw - 0.9;
    b.vbox(cx, fh + 0.4, hd + 0.9, 0.3, 0.06, 0.3, Material.Wood, 0x8a6a4a, 0.3);
    b.vbox(cx, fh + 0.4, hd + 0.62, 0.3, 0.55, 0.04, Material.Wood, 0x8a6a4a, 0.3);
  }
  return [worldSpot(b, rng.range(-hw + 1.2, hw - 1.2), fh + 0.05, (zp + hd) / 2 + 0.3, "interior"), step];
}

/** Thatched hale on a lava-rock platform: open sided (or with thatch walls), steep thatch roof. */
export function hale(b: Builder, rng: Rng, p: BodyPlan, sty: VStyle, canoe = false): Spot[] {
  const { w, d, fh, base } = p;
  const hw = w / 2, hd = d / 2;
  const E = 2.2;
  const rise = rng.range(2.6, 3.3);
  b.box(0, base, 0, hw + 0.7, fh - base, hd + 0.7, sty.pac ? Material.LavaRock : sty.found, sty.pac ? TINT.lava : sty.foundTint);
  const posts: [number, number][] = [];
  const nx = Math.max(2, Math.round(w / 2.6) + 1);
  for (let k = 0; k < nx; k++) {
    const x = -hw + (w * k) / (nx - 1);
    posts.push([x, hd], [x, -hd]);
  }
  for (const [x, z] of posts) {
    if (z > 0 && x > -1.1 && x < 1.1) continue; // keep the entrance clear
    b.box(x, fh, z, 0.11, E + 0.05, 0.11, Material.WoodDark, 0x9a8470);
  }
  b.wedge(0, fh + E, 0, hw + 0.5, rise, hd + 0.65, Material.Thatch, TINT.thatch);
  b.vbox(0, fh + E + rise - 0.1, 0, hw + 0.62, 0.16, 0.13, Material.Thatch, TINT.thatchDark); // ridge bundle
  // eave fringe (render-only, hangs a little below the eaves)
  for (const s of [1, -1]) b.vbox(0, fh + E - 0.14, s * (hd + 0.62), hw + 0.5, 0.16, 0.05, Material.Thatch, TINT.thatchDark);
  const walled = !canoe && rng.chance(0.45);
  if (walled) {
    const t = 0.16;
    const trim: WallTrim = { tint: 0x6a5240, cx: 0, cz: 0 };
    b.wall(hw, -hd, -hw, -hd, t, fh, E, row(w, 1, 1.0, 0.9, 1.8), Material.Thatch, TINT.thatchDark);
    b.wall(-hw, -hd + t / 2, -hw, hd - t / 2, t, fh, E, [], Material.Thatch, TINT.thatchDark);
    b.wall(hw, hd - t / 2, hw, -hd + t / 2, t, fh, E, row(d - t, 1, 0.9, 0.9, 1.8), Material.Thatch, TINT.thatchDark);
    b.wall(-hw, hd, hw, hd, t, fh, E, [{ at: hw, w: 1.5, y0: 0, y1: E }], Material.Thatch, TINT.thatchDark, undefined, 0, trim);
  } else if (!canoe && rng.chance(0.6)) {
    // low woven screen across the back
    b.box(0, fh, -hd, hw, 1.0, 0.07, Material.Thatch, TINT.thatchDark);
  }
  const run = frontSteps(b, 0, hd + 0.7, 0.85, fh, p.below, sty.pac ? Material.LavaRock : sty.found, sty.pac ? TINT.lavaDark : sty.foundTint, p.ground);
  const step = worldSpot(b, 0, 0, hd + 0.7 + run + 0.3, "step");
  if (canoe) {
    // outrigger canoe on the platform: a solid hull (cover), render-only float and booms
    b.box(-0.6, fh, 0, hw - 0.6, 0.55, 0.3, Material.WoodDark, 0x7a5a42);
    b.vbox(-0.6, fh + 0.55, 0, hw - 0.7, 0.05, 0.32, Material.Wood, 0xb0946e);
    b.vbox(-0.6, fh + 0.05, 1.7, hw * 0.55, 0.22, 0.12, Material.Wood, 0xc8b49a);
    for (const x of [-hw * 0.3, hw * 0.25]) b.vbox(x - 0.6, fh + 0.42, 0.85, 0.05, 0.05, 0.95, Material.Wood, 0xb0946e);
  } else {
    // woven mats and a calabash
    b.vbox(rng.range(-hw + 1, hw - 1), fh, rng.range(-hd + 0.8, 0), 0.8, 0.02, 0.6, Material.Cloth, rng.pick([0xc8b088, 0xb89a70]), rng.range(0, 1));
    b.vcyl(rng.range(-hw + 0.6, hw - 0.6), fh, -hd + 0.5, 0.22, 0.32, Material.Wood, 0x9a7048);
  }
  return [worldSpot(b, rng.range(-hw + 1, hw - 1), fh + 0.05, rng.range(-0.5, hd - 0.8), "interior"), step];
}

/** General store: false front with a sign, porch awning, flat tin roof deck reached by an outside stair. */
export function store(b: Builder, rng: Rng, p: BodyPlan, sty: VStyle): Spot[] {
  const { w, d, pd, fh, base } = p;
  const hw = w / 2, hd = d / 2, t = 0.26, H = 3.9;
  const D = fh + H + 0.2; // roof deck top
  const plastered = rng.chance(sty.plaster);
  const wallMat = plastered ? Material.Plaster : Material.PaintedWood;
  b.box(0, base, pd / 2, hw, fh - base, hd + pd / 2, sty.found, sty.foundTint);
  b.vbox(0, fh, pd / 2, hw - 0.03, 0.025, hd + pd / 2 - 0.03, Material.Wood, 0xc9b294);
  const trim: WallTrim = { tint: p.trim, cx: 0, cz: 0 };
  // false front
  const FH = H + 0.2 + 2.3;
  b.wall(-hw, hd - t / 2, hw, hd - t / 2, t, fh, FH, [
    { at: hw, w: 1.8, y0: 0, y1: 2.5 },
    { at: hw - 2.75, w: 2.0, y0: 0.6, y1: 2.6 },
    { at: hw + 2.75, w: 2.0, y0: 0.6, y1: 2.6 },
    { at: w * 0.22, w: 1.3, y0: H + 1.0, y1: H + 1.85 },
    { at: w * 0.78, w: 1.3, y0: H + 1.0, y1: H + 1.85 },
  ], wallMat, p.paint, undefined, 0, trim);
  b.box(0, fh + FH, hd - t / 2, w * 0.17, 0.55, t / 2, wallMat, p.paint); // raised crown
  b.vbox(0, fh + FH - 0.05, hd + 0.02, hw + 0.12, 0.2, 0.09, Material.Plaster, p.trim); // cornice
  b.vbox(0, fh + FH + 0.5, hd + 0.02, w * 0.17 + 0.1, 0.12, 0.09, Material.Plaster, p.trim);
  b.vbox(0, fh + 3.3, hd + 0.04, hw * 0.72, 1.15, 0.035, Material.Sign, rng.pick([0x7a3a32, 0x2f4f5a, 0x3a5a3a, 0xe8dcc0]));
  // sides and back, parapet 0.9 m over the deck
  const PH = H + 0.2 + 0.9;
  const L = d - 2 * t;
  // outside stair up the right-hand wall, front to back, onto a landing at deck height
  const run = STEP_RUN + 0.04;
  const zTop = Math.max(-hd + 1.9, hd - 0.1 - Math.ceil(D / 0.36) * run); // top of the stair
  const gapAt = hd - t - (zTop - 0.85);
  b.wall(-hw + t / 2, -hd + t, -hw + t / 2, hd - t, t, fh, PH, row(L, 2, 1.0, 0.9, 2.2), wallMat, p.paint, undefined, 0, trim);
  b.wall(hw - t / 2, hd - t, hw - t / 2, -hd + t, t, fh, PH, [
    { at: L * 0.25, w: 1.0, y0: 0.9, y1: 2.2 },
    { at: gapAt, w: 1.6, y0: H + 0.2, y1: PH + 1 },
  ], wallMat, p.paint, undefined, 0, trim);
  b.wall(hw, -hd + t / 2, -hw, -hd + t / 2, t, fh, PH, [{ at: w * 0.3, w: 1.1, y0: 0, y1: 2.2 }, { at: w * 0.72, w: 1.0, y0: 0.9, y1: 2.2 }], wallMat, p.paint, undefined, 0, trim);
  // roof deck
  b.box(0, fh + H, 0, hw - t, 0.2, hd - t, Material.Corrugated, 0xb8b4ac);
  b.vbox(0, D - 0.02, 0, hw - t - 0.05, 0.03, hd - t - 0.05, Material.Corrugated, 0x9a9a96);
  sideStair(b, hw + 0.65, zTop, 0, -1, 0.5, D, Material.Wood, 0xb8a084, p.below, p.ground, run);
  b.box(hw - t / 2, D - 0.12, zTop - 0.85, t / 2 + 0.45, 0.12, 0.8, Material.Wood, 0xb8a084); // threshold over the wall top
  b.box(hw + 0.8, -p.below - 0.5, zTop - 0.85, 0.8, D + p.below + 0.5, 0.85, Material.Wood, 0xb8a084);
  // porch awning on posts
  b.box(0, fh + 3.0, hd + pd / 2 + 0.1, hw + 0.15, 0.1, pd / 2 + 0.2, Material.Corrugated, p.roof);
  const nPost = Math.max(3, Math.ceil(w / 3) + 1);
  for (let k = 0; k < nPost; k++) b.box(-hw + 0.15 + ((w - 0.3) * k) / (nPost - 1), fh, hd + pd - 0.13, 0.07, 3.0, 0.07, Material.Plaster, p.trim);
  frontSteps(b, 0, hd + pd, 1.4, fh, p.below, Material.Wood, 0xc8b49a, p.ground);
  // interior: counter, shelves, sacks and barrels
  b.box(rng.range(-1.2, 1.2), fh, -hd + 2.4, 1.8, 1.0, 0.4, Material.WoodDark, TINT.wood);
  b.box(0, fh, -hd + t + 0.22, hw - t - 0.4, 2.1, 0.2, Material.WoodDark, 0xb09880);
  b.box(-hw + t + 0.22, fh, 0.3, 0.2, 2.1, hd - 1.6, Material.WoodDark, 0xb09880);
  for (let k = 0; k < 5; k++) b.vbox(0, fh + 0.5 + k * 0.4, -hd + t + 0.3, hw - t - 0.5, 0.15, 0.12, Material.Cloth, rng.pick([0xc8b088, 0x9a7a5a, 0x7a8a6a, 0xb86a4a]));
  barrel(b, hw - 0.9, fh, hd - 1.0);
  crate(b, hw - 1.0, fh, 0.6, 0.38, rng.range(0, 1));
  // goods on the porch
  barrel(b, -hw + 0.6, fh, hd + 0.55);
  crate(b, -hw + 1.4, fh, hd + 0.5, 0.33, 0.2);
  return [
    worldSpot(b, rng.range(-1.5, 1.5), fh + 0.05, 0.6, "interior"),
    worldSpot(b, rng.range(-hw + 1.5, 0), D + 0.02, rng.range(-hd + 1.5, hd - 1.8), "top"),
  ];
}

/** Two-storey hotel: porch + covered street balcony, inside stair and an outside stair to the balcony. */
export function hotel(b: Builder, rng: Rng, p: BodyPlan, sty: VStyle): Spot[] {
  const { w, d, pd, fh, base } = p;
  const hw = w / 2, hd = d / 2, t = 0.26;
  const H1 = 3.3, H2 = 3.0;
  const U = fh + H1 + 0.2; // upper floor top
  const plastered = rng.chance(sty.plaster * 0.6);
  const wallMat = plastered ? Material.Plaster : Material.PaintedWood;
  const X = 1.35; // balcony / porch extension on the +x side, where the outside stair arrives
  b.box(X / 2, base, pd / 2, hw + X / 2, fh - base, hd + pd / 2, sty.found, sty.foundTint);
  b.box(0, base, 0, hw, fh - base, hd, sty.found, sty.foundTint);
  b.vbox(0, fh, pd / 2, hw - 0.03, 0.025, hd + pd / 2 - 0.03, Material.Wood, 0xc9b294);
  const trim: WallTrim = { tint: p.trim, cx: 0, cz: 0, shutter: rng.chance(0.5) ? rng.pick([0x5f8a72, 0x5d7f98, 0x7a4a3a]) : 0 };
  // ground floor
  b.wall(-hw, hd - t / 2, hw, hd - t / 2, t, fh, H1, [
    { at: hw, w: 1.6, y0: 0, y1: 2.4 },
    ...row(w, 4, 1.15, 0.8, 2.3, (a) => Math.abs(a - hw) < 1.5),
  ], wallMat, p.paint, undefined, 0, trim);
  b.wall(hw, -hd + t / 2, -hw, -hd + t / 2, t, fh, H1, [{ at: w * 0.25, w: 1.4, y0: 0, y1: 2.3 }, { at: w * 0.55, w: 1.1, y0: 0.85, y1: 2.2 }, { at: w * 0.8, w: 1.1, y0: 0.85, y1: 2.2 }], wallMat, p.paint, undefined, 0, trim);
  const L = d - 2 * t;
  b.wall(-hw + t / 2, -hd + t, -hw + t / 2, hd - t, t, fh, H1, row(L, 2, 1.0, 0.9, 2.2), wallMat, p.paint, undefined, 0, trim);
  b.wall(hw - t / 2, hd - t, hw - t / 2, -hd + t, t, fh, H1, row(L, 2, 1.0, 0.9, 2.2), wallMat, p.paint, undefined, 0, trim);
  // inside stair along the left wall, climbing toward the back
  const sx = -hw + t + 0.56;
  const iz0 = hd - t - 0.2;
  const nIn = Math.ceil((U - fh) / 0.36 - 1e-6), runIn = 0.52;
  stair(b, sx, iz0, 0, -1, 0.5, fh, U, Material.Wood, 0xb09070, runIn, 0.36, 0.1);
  const ze = iz0 - nIn * runIn; // top of the stair
  const xw = -hw + t + 1.15; // stairwell edge
  // upper floor with the stairwell cut out (slabs run under the walls)
  b.box((xw + hw) / 2, U - 0.2, 0, (hw - xw) / 2, 0.2, hd, Material.Wood, 0xc0a888);
  b.box((-hw + xw) / 2, U - 0.2, (-hd + ze) / 2, (xw + hw) / 2, 0.2, (ze + hd) / 2, Material.Wood, 0xc0a888);
  b.box(-hw + t / 2, U - 0.2, (ze + hd) / 2, t / 2, 0.2, (hd - ze) / 2, wallMat, p.paint);
  railing(b, xw + 0.05, ze + 0.55, xw + 0.05, hd - t - 0.1, U, p.trim);
  // upper floor walls: French doors onto the balcony
  b.wall(-hw, hd - t / 2, hw, hd - t / 2, t, U, H2, row(w, 3, 1.4, 0, 2.3), wallMat, p.paint, undefined, 0, trim);
  b.wall(hw, -hd + t / 2, -hw, -hd + t / 2, t, U, H2, row(w, 3, 1.05, 0.9, 2.1), wallMat, p.paint, undefined, 0, trim);
  b.wall(-hw + t / 2, -hd + t, -hw + t / 2, hd - t, t, U, H2, row(L, 2, 1.0, 0.9, 2.1), wallMat, p.paint, undefined, 0, trim);
  b.wall(hw - t / 2, hd - t, hw - t / 2, -hd + t, t, U, H2, row(L, 2, 1.0, 0.9, 2.1), wallMat, p.paint, undefined, 0, trim);
  // upstairs partition and beds
  const zq = rng.range(-1.2, -0.4);
  const lq = hw - t - xw - 0.2;
  b.wall(xw + 0.2, zq, hw - t, zq, 0.14, U, H2, [{ at: rng.range(1.2, lq - 1.2), w: 1.5, y0: 0, y1: 2.3 }], wallMat, 0xe6e0d4);
  b.box(hw - 1.4, U, -hd + 1.2, 0.95, 0.5, 0.75, Material.Wood, 0xd8ccb8);
  b.box(xw + 1.6, U, -hd + 1.2, 0.95, 0.5, 0.75, Material.Wood, 0xd8ccb8);
  // balcony over the porch, under the main roof
  b.box(X / 2, U - 0.2, hd + pd / 2, hw + X / 2, 0.2, pd / 2, Material.Wood, 0xc0a888);
  const zr = hd + pd - 0.1;
  railing(b, -hw + 0.1, zr, hw + X - 0.1, zr, U, p.trim);
  railing(b, -hw + 0.1, hd + 0.05, -hw + 0.1, zr, U, p.trim);
  railing(b, hw + X - 0.1, hd + 0.05, hw + X - 0.1, zr, U, p.trim, 0.95, false);
  const nPost = Math.max(3, Math.ceil((w + X) / 3) + 1);
  for (let k = 0; k < nPost; k++) {
    const x = -hw + 0.12 + ((w + X - 0.24) * k) / (nPost - 1);
    b.box(x, fh, zr, 0.08, U - 0.2 - fh, 0.08, Material.Plaster, p.trim);
    if (x < hw + 0.3) b.box(x, U, zr, 0.07, H2, 0.07, Material.Plaster, p.trim);
  }
  b.wedge(0, U + H2, pd / 2, hw + 0.42, rng.range(1.9, 2.4), hd + pd / 2 + 0.32, Material.Corrugated, p.roof);
  for (const s of [1, -1]) b.vbox(0, U + H2 - 0.16, pd / 2 + s * (hd + pd / 2 + 0.3), hw + 0.42, 0.16, 0.025, Material.Plaster, p.trim);
  b.vbox(0, U + H2 - 0.85, zr + 0.12, Math.min(hw * 0.55, 3.2), 0.33, 0.03, Material.Sign, rng.pick([0x2f4f5a, 0x7a3a32, 0xe8dcc0]));
  // outside stair along the +x wall, climbing to the balcony extension
  sideStair(b, hw + 0.65, hd, 0, 1, 0.5, U, Material.Wood, 0xb09070, p.below, p.ground);
  frontSteps(b, 0, hd + pd, 1.2, fh, p.below, Material.Wood, 0xc8b49a, p.ground);
  // lobby desk and porch chairs
  b.box(hw - 1.6, fh, -hd + 1.6, 0.9, 1.05, 0.35, Material.WoodDark, TINT.wood);
  for (const x of [-hw + 1.2, hw - 1.2]) {
    b.vbox(x, fh + 0.4, hd + 0.7, 0.28, 0.06, 0.28, Material.Wood, 0x8a6a4a);
    b.vbox(x, fh + 0.4, hd + 0.44, 0.28, 0.55, 0.04, Material.Wood, 0x8a6a4a);
  }
  plant(b, -hw + 0.5, U, zr - 0.35, rng);
  plant(b, hw - 0.5, U, zr - 0.35, rng);
  return [
    worldSpot(b, rng.range(0, hw - 2), fh + 0.05, rng.range(0, hd - 1.2), "interior"),
    worldSpot(b, rng.range(xw + 1.2, hw - 1.2), U + 0.02, rng.range(zq + 0.8, hd - 0.9), "top"),
  ];
}

/** Wooden church with a front steeple (belfry + spire). Front (+Z) faces the green. */
export function church(b: Builder, rng: Rng, p: BodyPlan, sty: VStyle): Spot[] {
  const { w, d, fh, base } = p;
  const hw = w / 2, hd = d / 2, t = 0.24, H = 4.3;
  const T = 3.0, th = T / 2; // tower size
  const paint = rng.chance(0.7) ? 0xece6da : p.paint;
  const trim: WallTrim = { tint: p.trim === TINT.trim && paint === 0xece6da ? 0xd8d2c4 : p.trim, cx: 0, cz: 0 };
  b.box(0, base, 0, hw, fh - base, hd, sty.found, sty.foundTint);
  b.box(0, base, hd + (T + 0.7) / 2, th + 0.3, fh - base, (T + 0.7) / 2, sty.found, sty.foundTint);
  b.vbox(0, fh, 0, hw - 0.03, 0.025, hd - 0.03, Material.Wood, 0xb89a78);
  // nave
  b.wall(-hw, hd - t / 2, hw, hd - t / 2, t, fh, H, [{ at: hw, w: 1.6, y0: 0, y1: 2.7 }], Material.PaintedWood, paint, undefined, 0, trim);
  b.wall(hw, -hd + t / 2, -hw, -hd + t / 2, t, fh, H, [], Material.PaintedWood, paint);
  const L = d - 2 * t;
  const win = row(L - 1.0, 3, 0.9, 1.1, 3.4).map((o) => ({ ...o, at: o.at + 1.0 }));
  b.wall(-hw + t / 2, -hd + t, -hw + t / 2, hd - t, t, fh, H, win, Material.PaintedWood, paint, undefined, 0, trim);
  b.wall(hw - t / 2, hd - t, hw - t / 2, -hd + t, t, fh, H, win, Material.PaintedWood, paint, undefined, 0, trim);
  b.wedge(0, fh + H, 0, hd + 0.45, 3.5, hw + 0.45, Material.Corrugated, p.roof, Math.PI / 2);
  b.vcyl(0, fh + H + 1.1, -hd - 0.02, 0.55, 0.04, Material.Glass, 0xffffff); // rose window (back gable)
  // tower: hollow base you walk through, closed above the nave roof, belfry and spire
  const TH = H + 3.3;
  const zt0 = hd, zt1 = hd + T;
  b.wall(-th, zt1 - t / 2, th, zt1 - t / 2, t, fh, 3.8, [{ at: th, w: 1.6, y0: 0, y1: 2.6 }], Material.PaintedWood, paint, undefined, 0, trim);
  b.wall(-th, zt1 - t / 2, th, zt1 - t / 2, t, fh + 3.8, TH - 3.8, [{ at: th, w: 0.6, y0: 0.6, y1: 1.8 }], Material.PaintedWood, paint, undefined, 0, trim);
  b.wall(-th + t / 2, zt0, -th + t / 2, zt1 - t, t, fh, TH, [{ at: T / 2, w: 0.6, y0: 3.4, y1: 4.6 }], Material.PaintedWood, paint, undefined, 0, trim);
  b.wall(th - t / 2, zt1 - t, th - t / 2, zt0, t, fh, TH, [{ at: T / 2 - 0.1, w: 0.6, y0: 3.4, y1: 4.6 }], Material.PaintedWood, paint, undefined, 0, trim);
  b.box(0, fh + H, zt0 + t / 2, th, TH - H, t / 2, Material.PaintedWood, paint);
  b.box(0, fh + TH, (zt0 + zt1) / 2, th + 0.08, 0.2, th + 0.08, Material.Plaster, p.trim);
  const BH = 1.9;
  for (const [px, pz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) b.box(px * (th - 0.12), fh + TH + 0.2, (zt0 + zt1) / 2 + pz * (th - 0.12), 0.12, BH, 0.12, Material.PaintedWood, paint);
  railing(b, -th + 0.1, zt1 - 0.12, th - 0.1, zt1 - 0.12, fh + TH + 0.2, p.trim, 0.8, false);
  b.box(0, fh + TH + 0.2 + BH, (zt0 + zt1) / 2, th + 0.14, 0.18, th + 0.14, Material.Plaster, p.trim);
  const spireY = fh + TH + 0.38 + BH;
  b.vpyr(0, spireY, (zt0 + zt1) / 2, th + 0.02, 4.4, th + 0.02, Material.Corrugated, p.roof);
  b.cyl(0, spireY, (zt0 + zt1) / 2, 0.75, 1.9, Material.Corrugated, p.roof);
  b.vbox(0, spireY + 4.3, (zt0 + zt1) / 2, 0.04, 0.9, 0.04, Material.Metal, 0xc8b070);
  b.vbox(0, spireY + 4.85, (zt0 + zt1) / 2, 0.25, 0.04, 0.04, Material.Metal, 0xc8b070);
  b.vcyl(0, fh + TH + 0.75, (zt0 + zt1) / 2, 0.42, 0.62, Material.Rust, 0xc09050); // bell
  frontSteps(b, 0, zt1 + 0.7, 1.4, fh, p.below, sty.found, sty.foundTint, p.ground);
  // pews either side of the aisle, altar platform
  for (let z = hd - 2.4; z > -hd + 3.0; z -= 1.3) {
    for (const s of [-1, 1]) {
      b.box(s * (hw / 2 + 0.25), fh, z, hw / 2 - 0.65, 0.48, 0.22, Material.WoodDark, 0xb09070);
      b.vbox(s * (hw / 2 + 0.25), fh + 0.48, z - 0.2, hw / 2 - 0.65, 0.45, 0.04, Material.WoodDark, 0xb09070);
    }
  }
  b.box(0, fh, -hd + t + 1.0, hw - t - 0.4, 0.3, 1.0, Material.Wood, 0xb89a78);
  b.box(0, fh + 0.3, -hd + t + 0.8, 1.0, 0.75, 0.4, Material.Wood, 0xece6da);
  return [worldSpot(b, 0, fh + 0.05, rng.range(-hd + 3.5, hd - 2.5), "interior")];
}

/** Wooden water tank on a timber trestle. */
export function waterTower(b: Builder, rng: Rng, base: number, roofTint: number): void {
  const P = rng.range(5.2, 6.0), S = 1.55;
  for (const [x, z] of [[-S, -S], [S, -S], [-S, S], [S, S]]) b.box(x, base, z, 0.13, P - base, 0.13, Material.WoodDark, 0x9a8470);
  for (const y of [1.9, 3.7]) {
    beam(b, -S, -S, S, -S, y, 0.14, 0.05, Material.WoodDark, 0x9a8470, true);
    beam(b, -S, S, S, S, y, 0.14, 0.05, Material.WoodDark, 0x9a8470, true);
    beam(b, -S, -S, -S, S, y, 0.14, 0.05, Material.WoodDark, 0x9a8470, true);
    beam(b, S, -S, S, S, y, 0.14, 0.05, Material.WoodDark, 0x9a8470, true);
  }
  b.box(0, P, 0, 2.0, 0.16, 2.0, Material.Wood, TINT.wood);
  b.cyl(0, P + 0.16, 0, 1.75, 3.3, Material.Wood, 0xd8c8b0);
  for (const y of [0.5, 1.6, 2.7]) b.vcyl(0, P + 0.16 + y, 0, 1.79, 0.07, Material.Rust, 0xffffff);
  b.cyl(0, P + 3.46, 0, 0.9, 0.5, Material.Corrugated, roofTint);
  b.vcone(0, P + 3.46, 0, 1.95, 1.1, Material.Corrugated, roofTint);
  b.vcyl(0.9, 0, 0.9, 0.08, P + 0.2, Material.Rust, 0xffffff);
  railing(b, -2.0, 1.95, 2.0, 1.95, P + 0.16, 0xb8a888, 0.8, false);
}

/** Market stall: posts, a thatch or tin roof, a counter with produce. Front (+Z) to the street. */
export function stall(b: Builder, rng: Rng, sty: VStyle): void {
  const w = rng.range(2.6, 3.2), d = 2.0, hw = w / 2, hd = d / 2;
  for (const [x, z] of [[-hw, -hd], [hw, -hd], [-hw, hd], [hw, hd]]) b.box(x * 0.96, -0.2, z * 0.94, 0.06, 2.5, 0.06, Material.WoodDark, 0x9a8470);
  if (sty.pac && rng.chance(0.6)) b.wedge(0, 2.3, 0, hw + 0.25, 0.75, hd + 0.35, Material.Thatch, TINT.thatch);
  else {
    b.box(0, 2.3, 0, hw + 0.2, 0.08, hd + 0.3, Material.Corrugated, rng.pick(TINT.roof));
    b.vbox(0, 2.1, hd + 0.3, hw + 0.2, 0.2, 0.02, Material.Cloth, rng.pick([0xb86a5a, 0x5a7a92, 0xc8a868, 0x6a8a6a]));
  }
  b.box(0, 0, hd - 0.32, hw - 0.1, 0.95, 0.28, Material.Wood, TINT.wood);
  // baskets of fruit on the counter: bananas, limes, papayas, taro
  const goods = [0xd8c048, 0x8aa848, 0xc87838, 0x8a6a48, 0xb84a3a];
  for (let k = 0; k < 4; k++) {
    const x = -hw + 0.45 + ((w - 0.9) * k) / 3;
    const gc = rng.pick(goods);
    b.vcyl(x, 0.95, hd - 0.32, 0.24, 0.1, Material.Thatch, TINT.thatchDark);
    for (let j = 0; j < 5; j++) {
      const a = (j / 5) * 6.283185307179586 + k;
      b.vbox(x + sin(a) * 0.1, 1.03 + (j & 1) * 0.05, hd - 0.32 + cos(a) * 0.08, 0.07, 0.06, 0.05, Material.Foliage, gc, a);
    }
  }
  crate(b, -hw + 0.5, 0, -hd + 0.4, 0.3, rng.range(0, 1));
}

// ---------------------------------------------------------------------------
// Layout

interface Slot {
  /** Village-local point on the street edge in front of the lot. */
  x: number;
  z: number;
  /** Unit direction from the building toward the street. */
  fx: number;
  fz: number;
  front: number;
  depth: number;
  role: "home" | "store" | "hotel" | "church";
  /** Lot sits at a street end (hale-friendly). */
  edge?: boolean;
}

/** Ring sample offsets (radius 1) for the plane fit: 1 + 8 + 12 + 16 + 20 points. */
const RINGS: [number, number][] = (() => {
  const out: [number, number][] = [[0, 0]];
  const rings: [number, number][] = [[0.26, 8], [0.52, 12], [0.78, 16], [1, 20]];
  for (const [r, n] of rings) for (let k = 0; k < n; k++) {
    const a = ((k + 0.5) / n) * 6.283185307179586;
    out.push([sin(a) * r, cos(a) * r]);
  }
  return out;
})();

interface Fit {
  x: number;
  z: number;
  a: number;
  gx: number;
  gz: number;
  score: number;
}

function fitPlane(ctx: Ctx, reach: Uint8Array, x: number, z: number, R: number, relax: number): Fit | null {
  const h = ctx.height;
  let sh = 0, sxh = 0, szh = 0, sxx = 0, szz = 0;
  const vals: number[] = [];
  for (const [ox, oz] of RINGS) {
    const px = x + ox * R, pz = z + oz * R;
    const i = toI(pz) * N + toI(px);
    if (ctx.water[i] !== NO_WATER || ctx.holes[i] || !reach[i] || ctx.blocked[i] & (BLOCK_CAVE | BLOCK_STRUCT | BLOCK_DOCK)) return null;
    const v = sample(h, px, pz);
    if (v < 0.8) return null;
    vals.push(v);
    sh += v;
    sxh += ox * R * v;
    szh += oz * R * v;
    sxx += ox * R * ox * R;
    szz += oz * R * oz * R;
  }
  const a = sh / RINGS.length, gxs = sxh / sxx, gzs = szh / szz;
  let res = 0;
  let minPlane = 1e9;
  for (let k = 0; k < RINGS.length; k++) {
    const [ox, oz] = RINGS[k];
    const pl = a + gxs * ox * R + gzs * oz * R;
    const e = vals[k] - pl;
    if (e > res) res = e;
    if (-e > res) res = -e;
    if (pl < minPlane) minPlane = pl;
  }
  const slope = Math.sqrt(gxs * gxs + gzs * gzs);
  if (slope > 0.1 + 0.035 * relax || res > 4.5 + 2 * relax || minPlane < 1.1) return null;
  return { x, z, a, gx: gxs, gz: gzs, score: -res * 0.25 - slope * 6 };
}

export interface VillageSearch {
  grid: { x: number; z: number; i: number }[];
  sites: Site[];
  boat?: Site;
  /** Walkable main region (1) at the time of the search. */
  reach: Uint8Array;
}

/** Find a spot, flatten it and build the village. Returns its site, or undefined. */
export function placeVillage(ctx: Ctx, rng: Rng, q: VillageSearch): Site | undefined {
  // a big town on gentle ground first, then rougher ground, then a smaller town
  for (const [R, relax] of [[46, 0], [46, 1], [38, 0], [38, 1], [32, 2]]) {
    let best: Fit | null = null;
    for (const g of q.grid) {
      const i = g.i;
      const c = ctx.coast[i];
      if (c < R + 8 || c > 300) continue;
      if (ctx.waterDist[i] < R + 4 - relax * 4) continue;
      const hv = ctx.height[i];
      if (hv < 1.6 || hv > 70 || ctx.slope[i] > 0.3) continue;
      if (!q.sites.every((s) => (s.x - g.x) * (s.x - g.x) + (s.z - g.z) * (s.z - g.z) >= (R + (s.kind === "boathouse" ? 20 : 36)) * (R + (s.kind === "boathouse" ? 20 : 36)))) continue;
      const f = fitPlane(ctx, q.reach, g.x, g.z, R, relax);
      if (!f) continue;
      f.score += ctx.shelter[i] * 0.8 + rng.next() * 0.35 + (hv > 4 && hv < 35 ? 0.2 : 0);
      if (q.boat) {
        const d = Math.sqrt((q.boat.x - g.x) * (q.boat.x - g.x) + (q.boat.z - g.z) * (q.boat.z - g.z));
        f.score += d > R + 20 && d < R + 190 ? 0.6 : -0.3;
      }
      if (!best || f.score > best.score) best = f;
    }
    if (best) return buildVillage(ctx, rng, best, R, q);
  }
  return undefined;
}

function buildVillage(ctx: Ctx, rng: Rng, f: Fit, R: number, q: VillageSearch): Site {
  const boat = q.boat;
  const sty = villageStyle(ctx);
  flattenPlane(ctx, f.x, f.z, R + 2, 16, f.a, f.gx, f.gz);
  const planeY = (x: number, z: number) => f.a + f.gx * (x - f.x) + f.gz * (z - f.z);
  // street axis (local +X) toward the boathouse, or along the contour
  let ux: number, uz: number;
  if (boat) {
    ux = boat.x - f.x;
    uz = boat.z - f.z;
  } else {
    ux = -f.gz;
    uz = f.gx;
  }
  const ul = Math.sqrt(ux * ux + uz * uz);
  if (ul < 1e-6) {
    ux = 1;
    uz = 0;
  } else {
    ux /= ul;
    uz /= ul;
  }
  // Square to the world axes: doors and stairs then line up with the bots' 0.5 m
  // nav lattice, so every doorway has a straight row of standing spots through it.
  let rotV = Math.round(atan2(-uz, ux) / HALF_PI) * HALF_PI;
  // the green and the church go on the uphill side (local +Z = world (sin, cos))
  const upZ = sin(rotV) * f.gx + cos(rotV) * f.gz;
  const zs = upZ >= 0 ? 1 : -1;
  const V = new Builder(f.x, planeY(f.x, f.z), f.z, rotV);
  rotV = V.rot;
  const ids: number[] = [];
  const spots: Spot[] = [];
  const big = R >= 44;
  const XL = R - 10;
  const F = 5.0; // street half width 3.5 + 1.5 m verge
  const xg = rng.range(-4, 4) * (R / 46);
  const GW = big ? 11 : 9, GD = big ? 12 : 9;
  const lane = true;
  const xl = xg + (rng.chance(0.5) ? 1 : -1) * (big ? rng.range(17, 21) : rng.range(14, 17));
  const laneLen = big ? 35 : 28;

  // ---- the camp ballfield: a level, open lawn beside the town (planned first: lots keep clear of it)
  const field = planField(ctx, rng.fork("field"), V, XL, zs, xl > xg ? 1 : -1, q);
  const inField = (wx: number, wz: number, m: number) => {
    if (!field) return false;
    const dx = wx - field.b.ox, dz = wz - field.b.oz;
    const c = cos(field.b.rot), sn = sin(field.b.rot);
    const lx = dx * c - dz * sn, lz = dx * sn + dz * c;
    return lx > -FIELD_X - m && lx < FIELD_X + m && lz > -FIELD_Z - m && lz < FIELD_Z + m;
  };

  // ---- lots ----------------------------------------------------------------
  const slots: Slot[] = [];
  const fillRow = (a: number, b: number, side: number, gaps: [number, number][] = []) => {
    // split [a, b] into lots of 10.5–12.5 m, skipping gaps
    let x = a;
    while (x < b - 7.5) {
      let wLot = rng.range(10.5, 12.5);
      if (b - (x + wLot) < 7.5) wLot = b - x;
      let hit: [number, number] | undefined;
      for (const gp of gaps) if (x < gp[1] && x + wLot > gp[0]) hit = gp;
      if (hit) {
        if (hit[0] - x >= 7.5) wLot = hit[0] - x;
        else {
          x = hit[1];
          continue;
        }
      }
      slots.push({ x: x + wLot / 2, z: side * zs * F, fx: 0, fz: -side * zs, front: wLot, depth: 15, role: "home", edge: x <= -XL + 1 || x + wLot >= XL - 1 });
      x += wLot;
    }
  };
  // north (uphill): homes | green | store | homes
  fillRow(-XL, xg - GW - 0.5, 1);
  slots.push({ x: xg + GW + 6.5, z: zs * F, fx: 0, fz: -zs, front: 12, depth: 15, role: "store" });
  fillRow(xg + GW + 14.5, XL, 1);
  // south: homes | hotel | homes, minus the lane mouth
  const laneGap: [number, number][] = lane ? [[xl - 2.8, xl + 2.8]] : [];
  fillRow(-XL, xg - 8, -1, laneGap);
  slots.push({ x: xg, z: -zs * F, fx: 0, fz: zs, front: 15, depth: 15, role: "hotel" });
  fillRow(xg + 8, XL, -1, laneGap);
  // the lane: one lot either side, facing it
  if (lane) {
    for (const s of [-1, 1]) slots.push({ x: xl + s * 3.3, z: -zs * (laneLen - (big ? 8 : 4)), fx: -s, fz: 0, front: big ? 11 : 10, depth: 14, role: "home" });
  }
  slots.push({ x: xg, z: zs * (F + GD), fx: 0, fz: -zs, front: 9, depth: 22, role: "church" });

  // ---- buildings ---------------------------------------------------------------
  const place = (s: Slot, hw: number, hd: number, front: number, back: number, sideX: number, setback: number) => {
    const dist = hd + front + setback;
    const lx = s.x - s.fx * dist, lz = s.z - s.fz * dist;
    const rot = rotV + atan2(s.fx, s.fz);
    const b0 = new Builder(V.wx(lx, lz), 0, V.wz(lx, lz), rot);
    // keep inside the flattened disc
    for (const [cx, cz] of [[-hw - sideX, -hd - back], [hw + sideX, -hd - back], [-hw - sideX, hd + front], [hw + sideX, hd + front], [0, 0]]) {
      const dx = b0.wx(cx, cz) - f.x, dz = b0.wz(cx, cz) - f.z;
      if (dx * dx + dz * dz > (R + 5) * (R + 5)) return null;
      if (inField(b0.wx(cx, cz), b0.wz(cx, cz), 2)) return null;
    }
    let g = groundRect(ctx, b0, -hw - sideX, hw + sideX, -hd - back, hd + front);
    if (g.wet) return null;
    if (g.max - g.min > 2.6) {
      // hillside lot: cut a level pad, if the blend stays clear of the neighbours
      const m = 3.5;
      const around = groundRect(ctx, b0, -hw - sideX - m, hw + sideX + m, -hd - back - m, hd + front + m);
      if (around.wet || g.max - g.min > 7) return null;
      const pz = (front - back) / 2;
      const r = Math.sqrt((hw + sideX) * (hw + sideX) + ((hd * 2 + front + back) / 2) * ((hd * 2 + front + back) / 2)) + 0.3;
      flatten(ctx, b0.wx(0, pz), b0.wz(0, pz), r, 3, g.mean);
      g = groundRect(ctx, b0, -hw - sideX, hw + sideX, -hd - back, hd + front);
      if (g.max - g.min > 2.6) return null;
    }
    const gF = sample(ctx.height, b0.wx(0, hd + front), b0.wz(0, hd + front));
    const b = new Builder(b0.ox, gF, b0.oz, rot);
    const ground: Ground = (gx2, gz2) => sample(ctx.height, b.wx(gx2, gz2), b.wz(gx2, gz2)) - gF;
    return { b, g, gF, ground };
  };
  const homes: { x: number; z: number; s: Slot }[] = [];
  let homeSpots = 0;
  // landmarks first (they need the room), then the homes
  const rank = (r: Slot["role"]) => (r === "hotel" ? 0 : r === "store" ? 1 : r === "church" ? 2 : 3);
  const order = slots.map((_, k) => k).sort((a, b) => rank(slots[a].role) - rank(slots[b].role) || a - b);
  for (const k of order) {
    const s = slots[k];
    const br = rng.fork("lot" + k);
    if (s.role === "church") {
      const w = br.range(7.0, 7.8), d = br.range(11.5, 13), fh = 0.6;
      const front = 3.7 + stepRun(fh + 0.4);
      const pl = place(s, w / 2, d / 2, front, 0.5, 0.5, br.range(0, 1));
      if (!pl) continue;
      const fhh = Math.max(0.5, pl.g.max - pl.gF + 0.3);
      const plan: BodyPlan = { w, d, pd: 0, fh: fhh, base: pl.g.min - pl.gF - 0.5, below: Math.max(0.4, pl.gF - pl.g.min + 0.3), paint: br.pick(TINT.paint), trim: TINT.trim, roof: br.pick([0x9a4a3c, 0x5f7a62, 0x6f7a84]), ground: pl.ground };
      spots.push(...church(pl.b, br, plan, sty));
      ids.push(addStructure(ctx, StructureKind.Church, pl.b));
      continue;
    }
    if (s.role === "store" || s.role === "hotel") {
      const isHotel = s.role === "hotel";
      const w = isHotel ? br.range(12, Math.min(13.4, s.front - 2.2)) : br.range(9.6, Math.min(11, s.front - 1.2));
      const d = isHotel ? br.range(8.8, 9.6) : br.range(8.4, 9.4);
      const pd = isHotel ? 2.5 : 2.6;
      const front = pd + stepRun(0.8);
      const pl = place(s, w / 2, d / 2, front, 0.3, isHotel ? 1.4 : 1.3, br.range(0, 0.6));
      if (!pl) continue;
      const fh = Math.max(0.4, pl.g.max - pl.gF + 0.25);
      const paint = br.pick(TINT.paint);
      const plan: BodyPlan = { w, d, pd, fh, base: pl.g.min - pl.gF - 0.5, below: Math.max(0.4, pl.gF - pl.g.min + 0.3), paint, trim: trimTint(br, paint), roof: br.pick(TINT.roof), ground: pl.ground };
      spots.push(...(isHotel ? hotel(pl.b, br, plan, sty) : store(pl.b, br, plan, sty)));
      ids.push(addStructure(ctx, isHotel ? StructureKind.Hotel : StructureKind.Store, pl.b));
      if (!isHotel) {
        // water tower out back of the store
        const tb = rng.fork("tower");
        const tx = s.x + (tb.chance(0.5) ? 1 : -1) * 2.5, tz = s.z - s.fz * (d + pd + 6.5);
        const t0 = new Builder(V.wx(tx, tz), 0, V.wz(tx, tz), rotV + tb.range(-0.3, 0.3));
        const tg = groundRect(ctx, t0, -2.1, 2.1, -2.1, 2.1);
        const dx = t0.ox - f.x, dz = t0.oz - f.z;
        if (!tg.wet && tg.max - tg.min < 1.5 && dx * dx + dz * dz < (R + 4) * (R + 4)) {
          const tb2 = new Builder(t0.ox, tg.max, t0.oz, t0.rot);
          waterTower(tb2, tb, tg.min - tg.max - 0.4, plan.roof);
          ids.push(addStructure(ctx, StructureKind.WaterTower, tb2));
        }
      }
      continue;
    }
    // homes: plantation cottage or hale
    const haleP = s.edge || Math.abs(s.fx) > 0.5 ? sty.hale * 1.5 : sty.hale * 0.6;
    const isHale = br.chance(haleP);
    const plastered = !isHale && br.chance(sty.plaster);
    const w = isHale ? br.range(5.4, Math.min(7.0, s.front - 3.2)) : br.range(6.6, Math.min(8.4, s.front - 2.4));
    if (w < 5.0) continue;
    const d = isHale ? br.range(4.2, 5.0) : br.range(5.6, 6.8);
    const pd = isHale ? 0.7 : br.range(2.0, 2.4);
    const fh0 = isHale ? 0.55 : sty.pac ? br.range(0.45, 0.95) : br.range(0.35, 0.6);
    const front = pd + stepRun(fh0 + 0.3);
    const slack = Math.max(0, (s.front - w - (isHale ? 1.4 : 0) - 1.2) / 2);
    const setback = br.range(0.2, 1.6);
    let pl: ReturnType<typeof place> = null;
    for (const xoff of [br.range(-1, 1) * slack, slack, -slack]) {
      const s2 = { ...s, x: s.x + (Math.abs(s.fz) > 0.5 ? xoff : 0), z: s.z + (Math.abs(s.fx) > 0.5 ? xoff : 0) };
      pl = place(s2, w / 2 + (isHale ? 0.7 : 0), d / 2 + (isHale ? 0.7 : 0), front, 0.3, 0.2, setback);
      if (pl) break;
    }
    if (!pl) continue;
    const fh = Math.max(fh0, pl.g.max - pl.gF + 0.25);
    const paint = br.pick(TINT.paint);
    const plan: BodyPlan = { w, d, pd, fh, base: pl.g.min - pl.gF - 0.5, below: Math.max(0.4, pl.gF - pl.g.min + 0.3), paint, trim: trimTint(br, paint), roof: br.pick(TINT.roof), ground: pl.ground };
    const sp = isHale ? hale(pl.b, br, plan, sty) : house(pl.b, br, plan, sty, plastered);
    const step = sp.find((q) => q.tag === "step")!;
    // not every home holds paint: about every other one
    if (homeSpots < 3 && br.chance(0.5)) {
      spots.push(...sp.filter((q) => q.tag !== "step"));
      homeSpots++;
    }
    ids.push(addStructure(ctx, isHale ? StructureKind.Hale : StructureKind.House, pl.b));
    homes.push({ x: step.x, z: step.z, s });
  }

  // ---- yard walls and fences along the street fronts of the homes -----------------------
  const yr = rng.fork("yards");
  for (const hm of homes) {
    const s = hm.s;
    const roll = yr.next();
    if (roll < 0.22) continue;
    const lava = roll < 0.62;
    // the fence line runs along the slot's street edge, 0.35 m out toward the street
    const ax = -s.fz, az = s.fx; // along the street
    const half = s.front / 2 - 0.4;
    const cx = s.x + s.fx * 0.35, cz = s.z + s.fz * 0.35;
    const wb = new Builder(V.wx(cx, cz), planeY(V.wx(cx, cz), V.wz(cx, cz)), V.wz(cx, cz), rotV);
    // gate gap in front of the house's steps
    const hlx = (hm.x - V.ox) * cos(rotV) - (hm.z - V.oz) * sin(rotV);
    const hlz = (hm.x - V.ox) * sin(rotV) + (hm.z - V.oz) * cos(rotV);
    const gateAt = (hlx - cx) * ax + (hlz - cz) * az;
    const segs: [number, number][] = [[-half, gateAt - 1.0], [gateAt + 1.0, half]];
    for (const [a0, a1] of segs) {
      if (a1 - a0 < 0.8) continue;
      const x0 = cx + ax * a0, z0 = cz + az * a0;
      const x1 = cx + ax * a1, z1 = cz + az * a1;
      // builder-local coords relative to wb (same rotation as V, origin at (cx, cz))
      const p0x = x0 - cx, p0z = z0 - cz, p1x = x1 - cx, p1z = z1 - cz;
      const gy0 = sample(ctx.height, V.wx(x0, z0), V.wz(x0, z0)) - wb.oy, gy1 = sample(ctx.height, V.wx(x1, z1), V.wz(x1, z1)) - wb.oy;
      const gy = Math.min(gy0, gy1);
      if (lava) beam(wb, p0x, p0z, p1x, p1z, gy - 0.4, 0.4 + 0.85 + Math.abs(gy1 - gy0), 0.22, sty.pac ? Material.LavaRock : sty.found, sty.pac ? TINT.lava : sty.foundTint);
      else railing(wb, p0x, p0z, p1x, p1z, (gy0 + gy1) / 2 - 0.05, 0xe8e4da, 0.95);
    }
    if (wb.solids.length) ids.push(addStructure(ctx, StructureKind.Wall, wb));
  }

  // ---- the green: lava-rock kerb, stalls, benches, a pump, the big tree ---------------------
  const gr = rng.fork("green");
  const G = new Builder(V.wx(xg, zs * (F + GD / 2)), planeY(V.wx(xg, zs * (F + GD / 2)), V.wz(xg, zs * (F + GD / 2))), V.wz(xg, zs * (F + GD / 2)), rotV + (zs > 0 ? Math.PI : 0));
  // G local: +Z toward the street, x across. Kerb on the three non-street sides with gaps.
  const kerb = (x0: number, z0: number, x1: number, z1: number) => beam(G, x0, z0, x1, z1, -0.3, 0.55, 0.2, sty.pac ? Material.LavaRock : sty.found, sty.pac ? TINT.lava : sty.foundTint);
  kerb(-GW + 0.3, -GD / 2 + 0.3, -1.6, -GD / 2 + 0.3);
  kerb(1.6, -GD / 2 + 0.3, GW - 0.3, -GD / 2 + 0.3);
  kerb(-GW + 0.3, -GD / 2 + 0.6, -GW + 0.3, GD / 2 - 2.5);
  kerb(GW - 0.3, -GD / 2 + 0.6, GW - 0.3, GD / 2 - 2.5);
  const treeX = -GW * gr.range(0.35, 0.5), treeZ = gr.range(-1.5, 1.0);
  for (let k = 0; k < 3; k++) {
    const a = gr.range(0, 6.283185307179586);
    const bx = treeX + sin(a) * 4.6, bz = treeZ + cos(a) * 4.6;
    G.box(bx, 0, bz, 0.8, 0.45, 0.22, Material.Wood, 0xb09070, a);
    G.vbox(bx - cos(a) * 0.0, 0.45, bz, 0.8, 0.4, 0.04, Material.Wood, 0xb09070, a);
  }
  well(G, GW * 0.55, -GD / 2 + 2.6, { pacific: sty.pac });
  // lamp posts (thin solid post, render-only lantern)
  for (const [lx, lz] of [[-GW + 1.2, GD / 2 - 0.8], [GW - 1.2, GD / 2 - 0.8]]) {
    G.box(lx, 0, lz, 0.07, 3.2, 0.07, Material.Metal, 0x3c4448);
    G.vbox(lx, 3.0, lz, 0.17, 0.32, 0.17, Material.Lamp, 0xffffff);
    G.vpyr(lx, 3.32, lz, 0.24, 0.22, 0.24, Material.Metal, 0x3c4448);
  }
  spots.push({ x: G.wx(treeX, treeZ), y: G.oy, z: G.wz(treeX, treeZ), tag: "tree" });
  spots.push(worldSpot(G, GW * 0.3, 0.05, -GD / 2 + 2.0, "piazza"));
  ids.push(addStructure(ctx, StructureKind.Hamlet, G));
  // market stalls along the street edge of the green
  const nStall = big ? gr.intRange(2, 3) : 2;
  for (let k = 0; k < nStall; k++) {
    const sxl = GW * 0.05 + k * 3.6 - (nStall - 1) * 0.6, szl = GD / 2 - 1.6;
    const sb = new Builder(G.wx(sxl, szl), 0, G.wz(sxl, szl), G.rot + gr.range(-0.08, 0.08));
    sb.oy = sample(ctx.height, sb.ox, sb.oz);
    stall(sb, gr.fork("s" + k), sty);
    ids.push(addStructure(ctx, StructureKind.Stall, sb));
  }

  // ---- streets: dirt in ctx.path, cover and lamps along the main street ---------------------------
  const P = (lx: number, lz: number) => ({ x: V.wx(lx, lz), z: V.wz(lx, lz) });
  const streets: { pts: { x: number; z: number }[]; w: number }[] = [
    { pts: [P(-(XL + 10), 0), P(-XL / 2, 0), P(0, 0), P(XL / 2, 0), P(XL + 10, 0)], w: 6.6 },
    { pts: [P(xg, 3), P(xg, zs * (F + GD + 0.5))], w: 2.4 },
  ];
  if (lane) streets.push({ pts: [P(xl, -zs * 3), P(xl, -zs * 18), P(xl, -zs * laneLen)], w: 4.2 });
  for (const s of streets) paintStreet(ctx, s.pts, s.w);
  for (const s of streets) ctx.paths.push({ points: s.pts, width: s.w } satisfies Path);
  // cover on the street: barrels and crates by the porches, a handcart
  // (each group is its own small structure: one street-wide structure would merge
  // both rows of houses into a single huge nav patch for the bots)
  const cr = rng.fork("cover");
  const item = (lx: number, lz: number) => {
    const wx = V.wx(lx, lz), wz = V.wz(lx, lz);
    if (ctx.blocked[toI(wz) * N + toI(wx)] & BLOCK_STRUCT) return null;
    return new Builder(wx, sample(ctx.height, wx, wz), wz, rotV);
  };
  for (let k = 0; k < 5; k++) {
    const c = item(cr.range(-XL + 4, XL - 4), (cr.chance(0.5) ? 1 : -1) * cr.range(4.3, 4.7));
    const barrels = cr.chance(0.5), rusty = cr.chance(0.3), twoCrates = cr.chance(0.6), r0 = cr.range(0, 1), r1 = cr.range(0, 1);
    if (!c) continue;
    if (barrels) {
      barrel(c, 0, 0, 0, rusty);
      barrel(c, 0.7, 0, 0.15, false);
    } else {
      crate(c, 0, 0, 0, 0.38, r0);
      if (twoCrates) crate(c, 0.15, 0.76, 0, 0.3, r1);
    }
    ids.push(addStructure(ctx, StructureKind.Wall, c));
  }
  for (let k = -2; k <= 2; k++) {
    const c = item(k * (XL / 2.5) + cr.range(-2, 2), (k & 1 ? 1 : -1) * 4.6);
    if (!c) continue;
    c.box(0, -0.3, 0, 0.07, 3.5, 0.07, Material.Metal, 0x3c4448);
    c.vbox(0, 3.0, 0, 0.17, 0.32, 0.17, Material.Lamp, 0xffffff);
    c.vpyr(0, 3.32, 0, 0.24, 0.22, 0.24, Material.Metal, 0x3c4448);
    ids.push(addStructure(ctx, StructureKind.Wall, c));
  }

  // ---- ground: packed earth (Village biome) around streets, lots and the green -------------------
  for (const s of streets) for (let k = 0; k < s.pts.length - 1; k++) {
    const a = s.pts[k], b = s.pts[k + 1];
    const L = Math.sqrt((b.x - a.x) * (b.x - a.x) + (b.z - a.z) * (b.z - a.z));
    for (let t = 0; t <= L; t += 2) markDisc(ctx, a.x + ((b.x - a.x) * t) / L, a.z + ((b.z - a.z) * t) / L, s.w / 2 + 3, BLOCK_VILLAGE);
  }
  for (const id of ids) {
    const st = ctx.structures[id];
    for (const so of st.solids) markRect(ctx, so.cx, so.cz, so.shape === "cylinder" ? so.hx : so.hx, so.shape === "cylinder" ? so.hx : so.hz, so.rotY, 2.5, BLOCK_VILLAGE);
  }
  // the green stays open (no trees but the planted one)
  markRect(ctx, G.ox, G.oz, GW, GD / 2, G.rot, 0, BLOCK_VILLAGE | BLOCK_PATH);

  // gates where roads join: both street ends and the end of the lane
  const gates = [P(XL + 10, 0), P(-(XL + 10), 0)];
  if (lane) gates.push(P(xl, -zs * laneLen));
  let radius = R;
  if (field) {
    ids.push(...buildField(ctx, field, villageStyle(ctx), spots));
    radius = Math.max(R, Math.sqrt((field.b.ox - f.x) * (field.b.ox - f.x) + (field.b.oz - f.z) * (field.b.oz - f.z)) + 26);
  }
  for (const gt of gates) spots.push({ x: gt.x, y: sample(ctx.height, gt.x, gt.z), z: gt.z, tag: "gate" });
  const door = gates[0];
  return { kind: "village", x: f.x, z: f.z, y: V.oy, rot: rotV, radius, structureIds: ids, spots, door };
}

/** Half sizes of the ballfield's open lawn (across, along its axis). */
const FIELD_X = 17, FIELD_Z = 17;

interface FieldPlan {
  /** Frame: origin at the lawn centre, +Z away from the main street. */
  b: Builder;
}

/**
 * A plantation-camp ballfield: a level 34 m lawn (open ground for long shots
 * and a take-off run for gyrocopters) beside the main street at one end of
 * town, on the side away from the lane. Picks the flatter of the free
 * corners, cuts / fills it level, and keeps trees off it. Null when no corner
 * is dry, walkable and gentle enough.
 */
function planField(ctx: Ctx, rng: Rng, V: Builder, XL: number, zs: number, laneSide: number, q: VillageSearch): FieldPlan | null {
  const cands: [number, number][] = [[-1, zs], [1, zs], [-laneSide, -zs], [laneSide, -zs]];
  let best: { lx: number; lz: number; sz: number; score: number; Y: number } | null = null;
  for (const [sx, sz] of cands) {
    for (const extra of [-6, 0, 6]) {
      const lx = sx * (XL + FIELD_X + 1.5 + extra), lz = sz * (FIELD_Z + 5.6);
      const cx = V.wx(lx, lz), cz = V.wz(lx, lz);
      let mn = 1e9, mx = -1e9, sum = 0, n = 0, ok = true;
      for (let oz = -FIELD_Z - 3; oz <= FIELD_Z + 3 && ok; oz += 3)
        for (let ox = -FIELD_X - 3; ox <= FIELD_X + 3 && ok; ox += 3) {
          const px = cx + ox, pz = cz + oz;
          const j = toI(pz) * N + toI(px);
          if (j < 0 || j >= N * N || ctx.water[j] !== NO_WATER || ctx.holes[j] || !q.reach[j] || ctx.blocked[j] & (BLOCK_STRUCT | BLOCK_CAVE | BLOCK_DOCK) || ctx.coast[j] < 6) ok = false;
          const v = sample(ctx.height, px, pz);
          if (v < mn) mn = v;
          if (v > mx) mx = v;
          sum += v;
          n++;
        }
      if (!ok || mx - mn > 9 || mn < 1.4) continue;
      const score = -(mx - mn) * 0.3 - Math.abs(extra) * 0.04 + rng.next() * 0.2 + (sx < 0 ? 0.3 : 0) - (sz !== zs && sx === laneSide ? 0.8 : 0);
      if (!best || score > best.score) best = { lx, lz, sz, score, Y: sum / n };
    }
  }
  if (!best) return null;
  const cx = V.wx(best.lx, best.lz), cz = V.wz(best.lx, best.lz);
  flatten(ctx, cx, cz, 26, 8, Math.max(best.Y, 1.6));
  return { b: new Builder(cx, Math.max(best.Y, 1.6), cz, V.rot + (best.sz > 0 ? 0 : Math.PI)) };
}

/**
 * Backstop, dugouts, bleachers and a scoreboard round the lawn's edge; infield
 * of packed earth. Each group is its own small structure so the bots' nav
 * patches stay local instead of one rectangle over the whole field.
 */
function buildField(ctx: Ctx, p: FieldPlan, sty: VStyle, spots: Spot[]): number[] {
  const F = p.b;
  const sub = (lx: number, lz: number) => new Builder(F.wx(lx, lz), F.oy, F.wz(lx, lz), F.rot);
  const ids: number[] = [];
  const hz = -12; // home plate (the street end)
  // backstop (a low board wall with a mesh above) and the bleachers behind first base
  {
    const b = sub(0, -FIELD_Z - 0.6);
    b.box(0, -0.3, 0, 6, 1.4, 0.12, Material.PaintedWood, 0x5f7a62);
    b.vbox(0, 1.1, 0, 6, 2.6, 0.02, Material.Railing, 0xb8bcc0);
    for (const x of [-6, -2, 2, 6]) b.vbox(x, 0, 0, 0.05, 3.8, 0.05, Material.Metal, 0x9aa0a4);
    for (let r = 0; r < 3; r++) b.box(10, -0.3, -0.4 - r * 0.75, 3.4, 0.45 * (r + 1) + 0.3, 0.38, Material.Wood, 0xb8a084);
    ids.push(addStructure(ctx, StructureKind.Wall, b));
  }
  // dugouts down the base lines (cover): three low walls and a tin roof on posts
  for (const sgn of [-1, 1]) {
    const b = sub(sgn * (FIELD_X + 1.0), hz + 5);
    b.box(sgn * 0.9, -0.3, 0, 0.15, 1.5, 3.2, sty.found, sty.foundTint);
    b.box(0, -0.3, -3.2, 1.05, 1.5, 0.15, sty.found, sty.foundTint);
    b.box(0, -0.3, 3.2, 1.05, 1.5, 0.15, sty.found, sty.foundTint);
    for (const pz of [-3.0, 3.0]) b.box(-sgn * 0.9, 0, pz, 0.06, 2.3, 0.06, Material.Metal, 0x7a8084);
    b.box(0, 2.3, 0, 1.2, 0.08, 3.4, Material.Corrugated, 0xa8645a);
    b.box(sgn * 0.5, 0, 0, 0.25, 0.45, 2.6, Material.Wood, 0xb09070);
    if (sgn > 0) spots.push(worldSpot(b, 0, 0.05, 1.2, "interior"));
    ids.push(addStructure(ctx, StructureKind.Wall, b));
  }
  // scoreboard past centre field
  {
    const b = sub(0, FIELD_Z + 1.2);
    b.box(0, -0.3, 0, 2.6, 3.4, 0.12, Material.PaintedWood, 0x3a5a4a);
    b.vbox(0, 1.6, 0.13, 2.3, 1.2, 0.02, Material.Sign, 0x2f3f36);
    for (const x of [-2.4, 2.4]) b.box(x, -0.3, 0.2, 0.1, 3.5, 0.1, Material.WoodDark, 0x8a7a68);
    ids.push(addStructure(ctx, StructureKind.Wall, b));
  }
  // pitcher's mound and bases (render-only)
  {
    const b = sub(0, hz + 9);
    b.cyl(0, -0.2, 0.2, 2.2, 0.38, Material.Rust, 0x8a6a4a);
    for (const [x, z] of [[0, -9], [9, 0], [0, 9], [-9, 0]]) b.vbox(x, 0.02, z, 0.25, 0.06, 0.25, Material.Plaster, 0xf0ece4, Math.PI / 4);
    ids.push(addStructure(ctx, StructureKind.Wall, b));
  }
  // the lawn stays open; infield and base paths are packed earth
  markRect(ctx, F.ox, F.oz, FIELD_X + 1, FIELD_Z + 1, F.rot, 0, BLOCK_PATH | BLOCK_FIELD | BLOCK_VILLAGE);
  markRect(ctx, F.wx(0, hz + 9), F.wz(0, hz + 9), 7.4, 7.4, F.rot + HALF_PI / 2, 0, BLOCK_VILLAGE);
  return ids;
}


/** Dirt street: path coverage, gentle crown flattening already done by the plane; blocks props. */
function paintStreet(ctx: Ctx, pts: { x: number; z: number }[], w: number): void {
  const R = w / 2 + 1.8;
  for (let k = 0; k < pts.length - 1; k++) {
    const a = pts[k], b = pts[k + 1];
    const x0 = toI(Math.min(a.x, b.x) - R), x1 = toI(Math.max(a.x, b.x) + R);
    const z0 = toI(Math.min(a.z, b.z) - R), z1 = toI(Math.max(a.z, b.z) + R);
    const abx = b.x - a.x, abz = b.z - a.z;
    const l2 = abx * abx + abz * abz || 1;
    for (let iz = z0; iz <= z1; iz++)
      for (let ix = x0; ix <= x1; ix++) {
        if (ix < 0 || iz < 0 || ix >= N || iz >= N) continue;
        const x = gx(ix), z = gx(iz);
        let t = ((x - a.x) * abx + (z - a.z) * abz) / l2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const dx = x - a.x - abx * t, dz = z - a.z - abz * t;
        const d = Math.sqrt(dx * dx + dz * dz);
        const i = iz * N + ix;
        const cov = 1 - smoothstep(w * 0.38, w / 2 + 0.7, d);
        const v = Math.round(cov * 255);
        if (v > ctx.path[i]) ctx.path[i] = v;
        if (d < w / 2 + 1.7) ctx.blocked[i] |= BLOCK_PATH; // street + verge stay clear of trees
      }
  }
}
