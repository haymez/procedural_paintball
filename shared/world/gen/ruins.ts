// Remote ruins in the Pacific / plantation setting: a sugar mill with a tall
// brick chimney, a heiau (stepped lava-rock temple platform) and a ruined
// two-storey plantation house. Roofless where they are ruined, with broken
// wall tops, rubble and fallen beams; floors are left as open ground where
// possible so the island's plants can grow back inside.
import type { Rng } from "../../math/rng";
import { cos, sin } from "../../math/trig";
import { Material } from "../types";
import { beam, Builder, railing, stair, TINT, worldSpot, type SiteStyle, type Spot } from "./build";

function masonry(sty: SiteStyle): [Material, number] {
  return sty.pacific ? [Material.LavaRock, TINT.lava] : [Material.Stone, TINT.stone];
}

/** Rubble: a few tumbled blocks around (x, z) within radius r. */
function rubble(b: Builder, rng: Rng, x: number, z: number, r: number, n: number, mat: Material, tint: number, y = 0): void {
  for (let k = 0; k < n; k++) {
    const a = rng.range(0, 6.283185307179586), d = rng.range(0, r);
    const s = rng.range(0.22, 0.45);
    b.box(x + sin(a) * d, y - 0.1, z + cos(a) * d, s * rng.range(0.9, 1.6), s * 1.3, s, mat, tint, rng.range(0, 3));
  }
}

/** A fallen roof beam lying on the ground (solid, low cover). */
function fallenBeam(b: Builder, rng: Rng, x: number, z: number, len: number, y = 0): void {
  b.box(x, y, z, len / 2, 0.26, 0.13, Material.WoodDark, 0x8a7a68, rng.range(0, 3.14));
}

/**
 * Sugar mill ruin: roofless mill house (masonry walls with brick arches),
 * a boiling train with rusted kettles, a corner loft reached by a stone stair,
 * a tall brick chimney and an animal-driven cane crusher outside.
 * Front (+Z) is the big doorway.
 */
export function sugarMill(b: Builder, rng: Rng, sty: SiteStyle, groundAt: (lx: number, lz: number) => number): Spot[] {
  // dressed fieldstone walls (lava rock footings and chimney base on volcanic islands)
  const M = Material.Stone, MT = sty.pacific ? 0xd8d4cc : TINT.stone;
  const [F, FT] = masonry(sty);
  const w = rng.range(13, 15.5), d = rng.range(9.4, 10.2), t = 0.6, H = rng.range(5.0, 5.8);
  const hw = w / 2, hd = d / 2;
  const ruin = 0.5;
  // footing course (the floor inside stays open ground)
  b.box(0, -0.5, hd - t / 2, hw, 0.62, t / 2 + 0.08, F, FT);
  b.box(0, -0.5, -hd + t / 2, hw, 0.62, t / 2 + 0.08, F, FT);
  b.box(-hw + t / 2, -0.5, 0, t / 2 + 0.08, 0.62, hd, F, FT);
  b.box(hw - t / 2, -0.5, 0, t / 2 + 0.08, 0.62, hd, F, FT);
  const fy = 0.1;
  const P = 3.1; // loft floor top
  const front = [
    { at: hw, w: 2.6, y0: 0, y1: 3.3 },
    { at: w * 0.2, w: 1.3, y0: P + 0.75, y1: P + 1.7 },
    { at: w * 0.8, w: 1.3, y0: 1.2, y1: 2.9 },
  ];
  b.wall(-hw, hd - t / 2, hw, hd - t / 2, t, fy, H, front, M, MT, rng, ruin * 0.5);
  b.wall(hw, -hd + t / 2, -hw, -hd + t / 2, t, fy, H, [{ at: w * 0.25, w: 1.3, y0: 1.3, y1: 3.0 }, { at: w * 0.5, w: 1.3, y0: 1.3, y1: 3.0 }, { at: w * 0.75, w: 1.3, y0: 1.3, y1: 3.0 }], M, MT, rng, ruin);
  b.wall(-hw + t / 2, -hd + t, -hw + t / 2, hd - t, t, fy, H, [{ at: (d - 2 * t) * 0.3, w: 1.2, y0: 1.3, y1: 2.9 }], M, MT, rng, ruin * 0.4);
  b.wall(hw - t / 2, hd - t, hw - t / 2, -hd + t, t, fy, H, [{ at: (d - 2 * t) * 0.5, w: 2.0, y0: 0, y1: 2.8 }], M, MT, rng, ruin);
  // loft in the front-left corner, stone stair up the left wall
  const lx0 = -hw + t, lz1 = hd - t, L = 3.4;
  b.box(lx0 + L / 2, P - 0.25, lz1 - L / 2, L / 2, 0.25, L / 2, Material.Wood, 0x9a8a78);
  b.box(lx0 + L - 0.25, fy - 0.1, lz1 - L + 0.25, 0.25, P - 0.25 - fy + 0.1, 0.25, M, MT); // pier
  const run = 0.52;
  const n = Math.ceil((P - fy) / 0.4 - 1e-6);
  stair(b, lx0 + 0.55, lz1 - L - n * run, 0, 1, 0.5, fy, P, M, TINT.stoneDark, run, 0.4, 0.3);
  // broken parapet on the loft's open sides (cover up there)
  b.box(lx0 + L - 0.15, P, lz1 - L / 2 + 0.6, 0.15, 0.55, L / 2 - 0.6, M, MT);
  b.box(lx0 + L / 2 + 0.85, P, lz1 - L + 0.15, L / 2 - 0.85, 0.45, 0.15, M, MT);
  // boiling train along the back wall with rusted kettles
  const bw = w * 0.32;
  b.box(hw * 0.25, fy - 0.1, -hd + t + 0.8, bw, 1.05, 0.75, Material.Brick, 0xffffff);
  for (let k = 0; k < 3; k++) {
    const x = hw * 0.25 - bw + bw * (k + 0.5) * (2 / 3);
    b.cyl(x, fy + 0.95, -hd + t + 0.8, 0.55, 0.35, Material.Rust, TINT.rust);
    b.vcyl(x, fy + 1.28, -hd + t + 0.8, 0.6, 0.06, Material.Rust, 0xc8b0a0);
  }
  // fallen roof beams and rubble inside
  for (let k = 0; k < 3; k++) fallenBeam(b, rng, rng.range(-hw + 4.5, hw - 2), rng.range(-hd + 2.6, hd - 2), rng.range(3, 5.5), fy);
  rubble(b, rng, rng.range(-1, hw - 2), rng.range(-1, 1), 2, 5, M, TINT.lavaDark, fy);
  rubble(b, rng, hw + 1.2, rng.range(-hd, hd), 1.6, 4, M, TINT.lavaDark, groundAt(hw + 1.2, 0));
  // chimney behind the back-right corner
  const cx = hw - 1.2, cz = -hd - 2.0;
  const g = groundAt(cx, cz);
  const ch = rng.range(13, 17);
  b.box(cx, g - 0.6, cz, 1.6, 3.8, 1.6, F, FT);
  b.cyl(cx, g + 3.2, cz, 1.05, ch, Material.Brick, 0xffffff);
  b.vcyl(cx, g + 3.2 + ch - 0.9, cz, 1.18, 0.45, Material.Brick, 0xe8d8d0);
  b.vcyl(cx, g + 3.2 + ch - 0.04, cz, 0.78, 0.05, Material.Rust, 0x302a26); // sooty mouth
  beam(b, cx - 1.6, cz + 1.0, hw - t, -hd + 0.2, g + 0.4, 0.5, 0.35, Material.Brick, 0xffffff); // flue
  // cane crusher: stone ring, rusted roller, a long sweep arm (render-only)
  const kx = -hw - 4.8, kz = rng.range(-1.5, 1.5);
  const kg = groundAt(kx, kz);
  b.cyl(kx, kg - 0.3, kz, 2.4, 0.7, F, FT);
  b.cyl(kx, kg + 0.4, kz, 0.55, 1.4, Material.Rust, TINT.rust);
  const a = rng.range(0, 6.283185307179586);
  beam(b, kx, kz, kx + sin(a) * 4.5, kz + cos(a) * 4.5, kg + 1.3, 0.16, 0.08, Material.WoodDark, 0x8a7a68, true);
  return [
    worldSpot(b, lx0 + L * 0.6, P + 0.02, lz1 - L * 0.4, "top"),
    worldSpot(b, rng.range(0, hw - 2.5), fy + 0.1, rng.range(-0.5, hd - 1.8), "interior"),
  ];
}

/**
 * Heiau: three stepped lava-rock terraces with stairs up the front, a
 * collapsed corner to scramble up, low walls, ki'i (carved posts), an
 * 'anu'u oracle tower wrapped in kapa and a small thatched hale on top.
 * Front (+Z).
 */
export function heiau(b: Builder, rng: Rng): Spot[] {
  const M = Material.LavaRock;
  const W = rng.range(19, 23), D = rng.range(14.5, 17);
  const tiers = [
    { hx: W / 2, hz: D / 2, cz: 0, y0: -1.2, top: 1.3 },
    { hx: W / 2 - 2.6, hz: D / 2 - 2.5, cz: -0.9, y0: 1.1, top: 2.5 },
    { hx: W / 2 - 5.8, hz: D / 2 - 5.2, cz: -2.0, y0: 2.3, top: 3.6 },
  ];
  for (const [k, tr] of tiers.entries()) b.box(0, tr.y0, tr.cz, tr.hx, tr.top - tr.y0, tr.hz, M, k === 0 ? TINT.lava : k === 1 ? 0xe8e4de : TINT.lava);
  // stairs up the front of each tier
  const run = 0.52;
  let prevTop = 0;
  for (const tr of tiers) {
    const n = Math.ceil((tr.top - prevTop) / 0.34 - 1e-6);
    const edge = tr.cz + tr.hz;
    stair(b, 0, edge + n * run, 0, -1, tr === tiers[0] ? 1.6 : 1.2, prevTop, tr.top, M, TINT.lavaDark, run, 0.34, 0.6);
    prevTop = tr.top;
  }
  // collapsed back corner: a scree of blocks climbing to the first and second terraces
  const sx = (rng.chance(0.5) ? 1 : -1);
  for (let k = 0; k < 4; k++) {
    const top = 0.33 * (k + 1);
    b.box(sx * (W / 2 + 1.6 - k * 0.5), -0.4, -D / 2 + 1.4 + k * 0.1, 0.65, top + 0.4, 0.9, M, TINT.lavaDark, sx * 0.15 * k);
  }
  for (let k = 0; k < 4; k++) {
    const top = 1.3 + 0.3 * (k + 1);
    b.box(sx * (W / 2 - 1.0 - k * 0.5), 1.0, -D / 2 + 1.4, 0.6, top - 1.0, 0.8, M, TINT.lavaDark, -sx * 0.1 * k);
  }
  rubble(b, rng, sx * (W / 2 + 1.8), -D / 2 + 3.2, 1.5, 4, M, TINT.lavaDark);
  // low walls along the second terrace edge (cover), gaps at the stairs and the scree
  const t2 = tiers[1];
  const wy = t2.top;
  b.box(-(t2.hx + 1.6) / 2 - 0.3, wy, t2.cz + t2.hz - 0.3, (t2.hx - 1.6) / 2 - 0.3, 0.65, 0.28, M, TINT.lava);
  b.box((t2.hx + 1.6) / 2 + 0.3, wy, t2.cz + t2.hz - 0.3, (t2.hx - 1.6) / 2 - 0.3, 0.65, 0.28, M, TINT.lava);
  b.box(-sx * (t2.hx - 0.3), wy, t2.cz, 0.28, 0.65, t2.hz - 1.2, M, TINT.lava);
  // top terrace: ki'i along the front, the 'anu'u tower, a small hale, an offering stand
  const t3 = tiers[2];
  const ty = t3.top;
  const nK = rng.intRange(3, 5);
  for (let k = 0; k < nK; k++) {
    const x = -t3.hx + 1.0 + ((2 * t3.hx - 2.0) * k) / (nK - 1);
    if (Math.abs(x) < 1.4) continue;
    const kh = rng.range(2.0, 3.4), r = rng.range(0.22, 0.3);
    const kz = t3.cz + t3.hz - 0.6;
    // carved figure: big head with a gaping mouth and shell eyes, a crest, a pot belly
    b.cyl(x, ty, kz, r, kh, Material.WoodDark, 0x7a6450);
    b.vbox(x, ty + kh - 0.8, kz, r * 1.3, 0.78, r * 1.2, Material.WoodDark, 0x6a5444);
    b.vbox(x, ty + kh - 0.58, kz + r * 1.2, r * 0.95, 0.16, 0.04, Material.WoodDark, 0x241c16);
    for (const e of [-1, 1]) b.vbox(x + e * r * 0.55, ty + kh - 0.3, kz + r * 1.22, r * 0.22, 0.08, 0.02, Material.Plaster, 0xe8dcc0);
    b.vcyl(x, ty + kh - 0.04, kz, r * 1.5, 0.08, Material.WoodDark, 0x5a463a);
    b.vpyr(x, ty + kh + 0.04, kz, r * 1.0, 0.55, r * 0.45, Material.WoodDark, 0x6a5444);
    b.vbox(x, ty + kh * 0.36, kz, r * 1.25, 0.45, r * 1.15, Material.WoodDark, 0x6a5444);
  }
  // 'anu'u: tall wicker oracle tower wrapped in white kapa, lashed to four posts
  const ax = -sx * (t3.hx - 1.2), az = t3.cz - t3.hz + 1.2;
  const AH = 5.6;
  b.box(ax, ty, az, 0.62, AH, 0.62, Material.Cloth, 0xe6dcc4);
  for (const [px, pz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) b.vbox(ax + px * 0.68, ty, az + pz * 0.68, 0.07, AH + 0.7, 0.07, Material.WoodDark, 0x7a6450);
  for (let y = 0.9; y < AH; y += 1.15)
    for (const [px, pz, hx, hz] of [[0, 0.68, 0.72, 0.035], [0, -0.68, 0.72, 0.035], [0.68, 0, 0.035, 0.72], [-0.68, 0, 0.035, 0.72]])
      b.vbox(ax + px, ty + y, az + pz, hx, 0.06, hz, Material.WoodDark, 0x7a6450);
  b.vpyr(ax, ty + AH + 0.1, az, 0.85, 1.0, 0.85, Material.Thatch, TINT.thatch);
  // small hale at the back
  const hx0 = sx * 1.5, hz0 = t3.cz - t3.hz + 1.9;
  for (const [px, pz] of [[-1.7, -1.2], [1.7, -1.2], [-1.7, 1.2], [1.7, 1.2]]) b.box(hx0 + px, ty, hz0 + pz, 0.1, 2.15, 0.1, Material.WoodDark, 0x8a7460);
  if (rng.chance(0.7)) b.wedge(hx0, ty + 2.15, hz0, 2.2, 2.1, 1.7, Material.Thatch, TINT.thatch);
  else b.wedge(hx0 - 0.9, ty + 2.15, hz0, 1.3, 2.1, 1.7, Material.Thatch, TINT.thatchDark); // half fallen
  // lele: offering stand (render-only)
  const lx = sx * -1.8, lz = t3.cz + 0.4;
  for (const [px, pz] of [[-0.6, -0.4], [0.6, -0.4], [-0.6, 0.4], [0.6, 0.4]]) b.vbox(lx + px, ty, lz + pz, 0.05, 1.5, 0.05, Material.WoodDark, 0x8a7460);
  b.vbox(lx, ty + 1.45, lz, 0.75, 0.06, 0.55, Material.Wood, 0xa08a70);
  b.vbox(lx, ty + 1.51, lz, 0.3, 0.14, 0.25, Material.Foliage, 0x8aa048);
  return [
    worldSpot(b, -sx * 1.2, ty + 0.02, t3.cz + 0.6, "top"),
    worldSpot(b, sx * (W / 2 - 2.2), 1.32, D / 2 - 1.4, "interior"),
  ];
}

/**
 * Ruined plantation house: raised lava-rock ground floor with a front veranda,
 * an interior wall, one surviving corner of the timber upper floor (reached
 * by an inside stair) under a scrap of rusted roof, and a tall chimney.
 * Front (+Z).
 */
export function manor(b: Builder, rng: Rng, sty: SiteStyle): Spot[] {
  const [M, MT] = masonry(sty);
  const w = rng.range(13.2, 15), d = rng.range(10, 11.4), t = 0.5, H1 = 3.4, pd = 3.0;
  const hw = w / 2, hd = d / 2;
  const fh = 0.9;
  b.box(0, -0.8, pd / 2, hw + 0.2, fh + 0.8, hd + pd / 2, M, MT);
  const ruin = 0.3;
  b.wall(-hw, hd - t / 2, hw, hd - t / 2, t, fh, H1, [
    { at: hw, w: 2.1, y0: 0, y1: 2.9 },
    { at: w * 0.16, w: 1.3, y0: 0.8, y1: 2.6 }, { at: w * 0.33, w: 1.3, y0: 0.8, y1: 2.6 },
    { at: w * 0.67, w: 1.3, y0: 0.8, y1: 2.6 }, { at: w * 0.84, w: 1.3, y0: 0.8, y1: 2.6 },
  ], M, MT, rng, ruin);
  b.wall(hw, -hd + t / 2, -hw, -hd + t / 2, t, fh, H1, [{ at: w * 0.2, w: 1.2, y0: 0.9, y1: 2.5 }, { at: w * 0.62, w: 1.3, y0: 0, y1: 2.6 }], M, MT, rng, 0.1);
  const L = d - 2 * t;
  b.wall(-hw + t / 2, -hd + t, -hw + t / 2, hd - t, t, fh, H1, [{ at: L * 0.3, w: 1.2, y0: 0.9, y1: 2.5 }, { at: L * 0.75, w: 1.2, y0: 0.9, y1: 2.5 }], M, MT, rng, 0.1);
  b.wall(hw - t / 2, hd - t, hw - t / 2, -hd + t, t, fh, H1, [{ at: L * 0.3, w: 1.2, y0: 0.9, y1: 2.5 }, { at: L * 0.72, w: 1.2, y0: 0.9, y1: 2.5 }], M, MT, rng, ruin);
  // interior wall with a doorway, carries the surviving upper floor
  const zi = -0.6;
  b.wall(-hw + t, zi, hw - t, zi, 0.4, fh, H1, [{ at: w * 0.55, w: 2.0, y0: 0, y1: 2.6 }], M, MT, rng, 0);
  // surviving upper floor over the back-left room
  const U = fh + H1 + 0.22;
  const xr = rng.range(-1.2, 0.2);
  b.box((-hw + xr) / 2, U - 0.22, (-hd + zi) / 2, (xr + hw) / 2, 0.22, (zi + hd) / 2, Material.Wood, 0x8a7a68);
  // stair along the back wall, climbing toward -x onto it
  const run = 0.52, n = Math.ceil((U - fh) / 0.38 - 1e-6);
  stair(b, xr + n * run, -hd + t + 0.55, -1, 0, 0.5, fh, U, M, TINT.stoneDark, run, 0.38, 0.2);
  // upper walls on the two outer sides of that corner (painted boards, broken)
  const paint = rng.pick([0xe8e2d4, 0xd8d0bc, 0xc8d0c0]);
  b.wall(xr, -hd + 0.14, -hw, -hd + 0.14, 0.24, U, 2.7, [{ at: (xr + hw) * 0.5, w: 1.1, y0: 0.9, y1: 2.1 }], Material.PaintedWood, paint, rng, 0.45);
  b.wall(-hw + 0.14, -hd + 0.24, -hw + 0.14, zi, 0.24, U, 2.7, [{ at: (zi + hd) * 0.5, w: 1.0, y0: 0.9, y1: 2.1 }], Material.PaintedWood, paint, rng, 0.45);
  // low broken parapet on the open edges of the upper floor
  b.box(xr - 0.1, U, (-hd + zi) / 2 + 0.9, 0.1, 0.5, (zi + hd) / 2 - 1.4, M, MT);
  if (rng.chance(0.7)) b.wedge((-hw + xr) / 2 - 0.15, U + 2.4, (-hd + zi) / 2, (xr + hw) / 2 + 0.35, 1.5, (zi + hd) / 2 + 0.45, Material.Corrugated, 0xb07a5c);
  // veranda: a few surviving pillars and a broken beam, wide front steps
  const nP = 6;
  for (let k = 0; k < nP; k++) {
    if (rng.chance(0.35)) continue;
    const x = -hw + 0.5 + ((w - 1.0) * k) / (nP - 1);
    const ph = rng.chance(0.3) ? rng.range(0.8, 2.0) : 2.9;
    b.box(x, fh, hd + pd - 0.35, 0.22, ph, 0.22, M, MT);
  }
  b.vbox(-hw * 0.3, fh + 2.9, hd + pd - 0.35, hw * 0.55, 0.16, 0.12, Material.WoodDark, 0x8a7a68);
  const sn = Math.ceil(fh / 0.34 - 1e-6);
  stair(b, 0, hd + pd + sn * 0.52, 0, -1, 2.2, 0, fh, M, TINT.stoneDark, 0.52, 0.34, 0.4);
  // chimney on the right gable
  b.box(hw + 0.55, -0.6, -hd * 0.3, 0.75, fh + H1 + 4.6, 0.75, M, MT);
  // fallen roof sheets and beams inside, rubble
  for (let k = 0; k < 2; k++) b.box(rng.range(0, hw - 2), fh, rng.range(zi + 1.2, hd - 1.5), 1.2, 0.06, 0.9, Material.Corrugated, 0xa0705a, rng.range(0, 3));
  for (let k = 0; k < 2; k++) fallenBeam(b, rng, rng.range(-hw + 2, hw - 2), rng.range(zi + 1.0, hd - 1.2), rng.range(2.5, 4), fh);
  rubble(b, rng, rng.range(1, hw - 1.5), rng.range(-hd + 1.5, zi - 1.0), 1.2, 4, M, TINT.lavaDark, fh);
  railing(b, xr + 0.3, -hd + t + 1.2, xr + 0.3, zi + 0.2, U, 0xd8d0bc, 0.95, false);
  return [
    worldSpot(b, (-hw + xr) / 2, U + 0.02, (-hd + zi) / 2 + 0.4, "top"),
    worldSpot(b, rng.range(-hw + 2, hw - 2), fh + 0.05, rng.range(zi + 1.2, hd - 1.2), "interior"),
  ];
}
