// Structure geometry builders: compose ruins from boxes, wedges and cylinders.
// All placement is in a local frame (origin on the ground at the site anchor,
// rotated by rot about Y using the three.js convention, see collide.ts).
import type { Rng } from "../../math/rng";
import { atan2, cos, sin } from "../../math/trig";
import { Material, type Solid, type SolidShape } from "../types";

export const TINT = {
  white: 0xffffff,
  stone: 0xe9dcc8,
  stoneDark: 0xc9b9a3,
  wood: 0xffffff,
  shutter: 0x4f8a6b,
  shutterBlue: 0x4f7fa0,
  terracotta: 0xffffff,
  metal: 0xd8d8d0,
  lamp: 0xfff1b0,
  stucco: [0xf2c68c, 0xe8a87c, 0xf5e0b5, 0xe89f8f, 0xf7d9a0, 0xb8d8c8] as const,
};

export interface Opening {
  /** Center position along the wall (m from its start). */
  at: number;
  w: number;
  y0: number;
  y1: number;
}

export class Builder {
  solids: Solid[] = [];
  private c: number;
  private s: number;
  constructor(public ox: number, public oy: number, public oz: number, public rot: number) {
    this.c = cos(rot);
    this.s = sin(rot);
  }

  /** Local → world. */
  wx(lx: number, lz: number): number {
    return this.ox + lx * this.c + lz * this.s;
  }
  wz(lx: number, lz: number): number {
    return this.oz - lx * this.s + lz * this.c;
  }

  add(shape: SolidShape, lx: number, ly: number, lz: number, hx: number, hy: number, hz: number, lrot: number, mat: Material, tint: number): void {
    this.solids.push({
      shape, cx: this.wx(lx, lz), cy: this.oy + ly, cz: this.wz(lx, lz), hx, hy, hz, rotY: this.rot + lrot, mat, tint,
    });
  }

  /** Box by bottom height: y0..y0+h. */
  box(lx: number, y0: number, lz: number, hx: number, h: number, hz: number, mat: Material, tint: number, lrot = 0): void {
    this.add("box", lx, y0 + h / 2, lz, hx, h / 2, hz, lrot, mat, tint);
  }

  /** Gable wedge sitting on y0 with ridge height h, ridge along local X (after lrot). */
  wedge(lx: number, y0: number, lz: number, hx: number, h: number, hz: number, mat: Material, tint: number, lrot = 0): void {
    this.add("wedge", lx, y0 + h / 2, lz, hx, h / 2, hz, lrot, mat, tint);
  }

  cyl(lx: number, y0: number, lz: number, r: number, h: number, mat: Material, tint: number): void {
    this.add("cylinder", lx, y0 + h / 2, lz, r, h / 2, r, 0, mat, tint);
  }

  /**
   * Straight wall from (x0,z0) to (x1,z1) (local), thickness t, from y0 up to
   * height H, with door/window openings. ruin (0..1) breaks the top unevenly.
   */
  wall(
    x0: number, z0: number, x1: number, z1: number, t: number, y0: number, H: number,
    openings: Opening[], mat: Material, tint: number, rng?: Rng, ruin = 0,
  ): void {
    const dx = x1 - x0, dz = z1 - z0;
    const L = Math.sqrt(dx * dx + dz * dz);
    if (L < 0.05) return;
    const ux = dx / L, uz = dz / L;
    // box local X along the wall: world dir (cos r, -sin r) => r = atan2(-uz, ux)
    const lrot = atan2(-uz, ux);
    const piece = (a: number, b: number, ya: number, yb: number) => {
      if (b - a < 0.08 || yb - ya < 0.08) return;
      const m = (a + b) / 2;
      this.box(x0 + ux * m, y0 + ya, z0 + uz * m, (b - a) / 2, yb - ya, t / 2, mat, tint, lrot);
    };
    const ops = openings.slice().sort((p, q) => p.at - q.at);
    let cur = 0;
    const solidRun = (a: number, b: number) => {
      if (b - a < 0.08) return;
      if (!rng || ruin <= 0) {
        piece(a, b, 0, H);
        return;
      }
      // broken top: split into chunks of varying height
      const n = Math.max(1, Math.round((b - a) / 1.6));
      for (let k = 0; k < n; k++) {
        const pa = a + ((b - a) * k) / n, pb = a + ((b - a) * (k + 1)) / n;
        let hh = H;
        if (rng.chance(ruin)) hh = H * rng.range(0.45, 0.95);
        piece(pa, pb, 0, hh);
      }
    };
    for (const o of ops) {
      const a = o.at - o.w / 2, b = o.at + o.w / 2;
      solidRun(cur, a);
      if (o.y0 > 0.05) piece(a, b, 0, o.y0);
      if (o.y1 < H - 0.1 && (!rng || !rng.chance(ruin * 0.4))) piece(a, b, o.y1, H);
      cur = b;
    }
    solidRun(cur, L);
  }
}

export function pickStucco(rng: Rng): number {
  return rng.pick(TINT.stucco);
}

// ---------------------------------------------------------------------------
// Buildings. Each returns interior spots (local coords) for pickups.

export interface Spot {
  x: number;
  y: number;
  z: number;
  tag: string;
}

function worldSpot(b: Builder, lx: number, ly: number, lz: number, tag: string): Spot {
  return { x: b.wx(lx, lz), y: b.oy + ly, z: b.wz(lx, lz), tag };
}

/**
 * Ruined cottage centered at local (cx, cz) with its door facing local +Z
 * rotated by lrot. Size w (along X) × d (along Z).
 */
export function cottage(b: Builder, rng: Rng, w: number, d: number, twoStory: boolean): Spot[] {
  const tint = pickStucco(rng);
  const t = 0.4;
  const H = twoStory ? 5.8 : rng.range(2.9, 3.4);
  const ruin = rng.range(0.15, 0.5);
  const hw = w / 2, hd = d / 2;
  const spots: Spot[] = [];
  // floor
  b.box(0, -0.3, 0, hw, 0.42, hd, Material.Stone, TINT.stone);
  const fy = 0.12;
  // front (door) wall at +Z
  const doorAt = rng.range(w * 0.3, w * 0.7);
  const winF = doorAt < w / 2 ? rng.range(doorAt + 1.3, w - 0.8) : rng.range(0.8, doorAt - 1.3);
  b.wall(-hw, hd - t / 2, hw, hd - t / 2, t, fy, H, [
    { at: doorAt, w: 1.25, y0: 0, y1: 2.25 },
    { at: winF, w: 0.9, y0: 1.0, y1: 1.95 },
  ], Material.Stucco, tint, rng, ruin);
  // back wall
  b.wall(hw, -hd + t / 2, -hw, -hd + t / 2, t, fy, H, [{ at: w * rng.range(0.3, 0.7), w: 0.9, y0: 1.0, y1: 1.95 }], Material.Stucco, tint, rng, ruin);
  // side walls (between front/back)
  const sideOps = (L: number): Opening[] => (rng.chance(0.7) ? [{ at: L * rng.range(0.35, 0.65), w: 0.85, y0: 1.0, y1: 1.9 }] : []);
  // two-story: outside stair along +X up to a landing and a doorway into the upper floor
  const upY = 2.9;
  const steps = 7, rise = upY / steps;
  const zDoor = (-hd + t) / 2; // centred on the upper floor
  const runZ = 0.53;
  const zLast = zDoor + 1.2; // the landing (in front of the door) starts right after the last step
  const stepZ = (k: number) => zLast + (steps - 1 - k) * runZ;
  const rightOps: Opening[] = twoStory
    ? [{ at: hd - t - zDoor, w: Math.min(1.8, hd - t - 0.3), y0: upY - 0.02, y1: upY + 2.2 }]
    : sideOps(d - 2 * t);
  b.wall(-hw + t / 2, -hd + t, -hw + t / 2, hd - t, t, fy, H, sideOps(d - 2 * t), Material.Stucco, tint, rng, ruin);
  b.wall(hw - t / 2, hd - t, hw - t / 2, -hd + t, t, fy, H, rightOps, Material.Stucco, tint, rng, twoStory ? 0 : ruin);
  // shutters beside the front window
  const sh = rng.chance(0.5) ? TINT.shutter : TINT.shutterBlue;
  b.box(-hw + winF - 0.75, fy + 0.95, hd + 0.02, 0.28, 1.05, 0.04, Material.Wood, sh);
  if (rng.chance(0.6)) b.box(-hw + winF + 0.75, fy + 0.95, hd + 0.02, 0.28, 1.05, 0.04, Material.Wood, sh);

  if (twoStory) {
    // upper floor over the back half
    b.box(0, fy + upY - 0.2, -hd / 2 + t / 2, hw - t, 0.2, hd / 2 - t / 2, Material.Wood, TINT.wood);
    for (let k = 0; k < steps; k++) b.box(hw + 0.7, fy, stepZ(k), 0.65, rise * (k + 1), 0.32, Material.Stone, TINT.stoneDark);
    // landing in front of the doorway, flush with the upper floor
    const z0 = zLast - runZ * 0.6, z1 = Math.max(zDoor - 0.9, -hd - 0.3);
    b.box(hw + 0.7, fy, (z0 + z1) / 2, 0.65, upY, (z0 - z1) / 2, Material.Stone, TINT.stoneDark);
    // threshold through the wall
    b.box(hw - t / 2, fy + upY - 0.2, zDoor, t / 2 + 0.35, 0.2, 0.85, Material.Wood, TINT.wood);
    spots.push(worldSpot(b, 0, fy + upY + 0.1, -hd / 2, "upper"));
  }
  // roof: whole, partial, or gone
  const roll = rng.next();
  const roofH = rng.range(1.0, 1.35);
  if (roll < 0.4) b.wedge(0, fy + H, 0, hw + 0.35, roofH, hd + 0.4, Material.Terracotta, TINT.terracotta);
  else if (roll < 0.8) {
    const f = rng.range(0.45, 0.65);
    const side = rng.chance(0.5) ? 1 : -1;
    const phx = (w * f) / 2 + 0.2;
    b.wedge(side * (hw + 0.35 - phx), fy + H, 0, phx, roofH, hd + 0.4, Material.Terracotta, TINT.terracotta);
  }
  // rubble inside / outside
  const nr = rng.intRange(2, 5);
  for (let k = 0; k < nr; k++) {
    const inside = rng.chance(0.5);
    const x = inside ? rng.range(-hw + 0.8, hw - 0.8) : rng.range(-hw - 1.5, hw + 1.5);
    const z = inside ? rng.range(-hd + 0.8, hd - 1.2) : (rng.chance(0.5) ? -hd - rng.range(0.6, 1.4) : hd + rng.range(0.8, 1.6));
    const s = rng.range(0.25, 0.5);
    const sx = s * rng.range(0.8, 1.6), rr = rng.range(0, 3);
    if (twoStory && !inside && x + sx > hw - 0.8) continue; // keep the outside stair clear
    b.box(x, 0, z, sx, s * 1.2, s, Material.Stone, TINT.stoneDark, rr);
  }
  spots.push(worldSpot(b, rng.range(-hw + 1, hw - 1), fy + 0.2, rng.range(-hd + 1, 0), "interior"));
  return spots;
}

export function well(b: Builder, lx: number, lz: number): void {
  b.cyl(lx, 0, lz, 0.95, 0.95, Material.Stone, TINT.stone);
  b.box(lx - 0.8, 0.9, lz, 0.08, 1.3, 0.08, Material.WoodDark, TINT.wood);
  b.box(lx + 0.8, 0.9, lz, 0.08, 1.3, 0.08, Material.WoodDark, TINT.wood);
  b.box(lx, 2.15, lz, 0.95, 0.1, 0.1, Material.WoodDark, TINT.wood);
  b.wedge(lx, 2.25, lz, 1.1, 0.45, 0.7, Material.Terracotta, TINT.terracotta);
}

const TAN15 = 0.2679491924311228; // tan(pi / 12)

export function lighthouse(b: Builder, rng: Rng): Spot[] {
  const H = rng.range(14, 17);
  const R = 3.2, t = 0.55, seg = 12;
  const spots: Spot[] = [];
  const band = rng.chance(0.5);
  b.cyl(0, -0.4, 0, R + 0.6, 0.55, Material.Stone, TINT.stone); // plinth
  // hollow tower: ring of wall boxes with a door gap facing +Z
  for (let k = 0; k < seg; k++) {
    const a = ((k + 0.5) / seg) * 6.283185307179586;
    const mid = R - t / 2;
    const x = sin(a) * mid, z = cos(a) * mid;
    const half = TAN15 * R + 0.02;
    const lrot = a; // box local X tangent: world dir (cos a, -sin a) is tangent for angle a
    const isDoor = k === 0;
    if (isDoor) {
      b.add("box", x, 0.15 + 2.4 + (H - 2.4) / 2, z, half, (H - 2.4) / 2, t / 2, lrot, Material.Plaster, TINT.white);
    } else {
      b.add("box", x, 0.15 + H / 2, z, half, H / 2, t / 2, lrot, Material.Plaster, TINT.white);
    }
    if (band) b.add("box", sin(a) * (R + 0.02), 0.15 + H * 0.62, cos(a) * (R + 0.02), half + 0.03, 0.4, 0.05, lrot, Material.Plaster, 0xd9543c);
  }
  // newel and spiral steps
  b.cyl(0, 0.15, 0, 0.55, H, Material.Stone, TINT.stone);
  const nSteps = Math.round(H / 0.4);
  const rise = H / nSteps;
  const dA = 0.5;
  for (let k = 0; k < nSteps; k++) {
    const a = 0.9 + k * dA;
    const rr = 1.75;
    b.add("box", sin(a) * rr, 0.15 + rise * (k + 1) - 0.1, cos(a) * rr, 0.46, 0.1, 1.0, a, Material.Stone, TINT.stoneDark);
  }
  // top floor: sectors, leaving a hole above the last steps
  const lastA = 0.9 + (nSteps - 1) * dA;
  const top = 0.15 + H;
  for (let k = 0; k < seg; k++) {
    const a = ((k + 0.5) / seg) * 6.283185307179586;
    let da = a - lastA;
    da -= 6.283185307179586 * Math.floor((da + Math.PI) / 6.283185307179586);
    if (da > -3.2 && da < 0.45) continue; // stair hole
    const half = TAN15 * 2.4;
    b.add("box", sin(a) * 2.2, top - 0.1, cos(a) * 2.2, half, 0.1, 1.2, a, Material.Stone, TINT.stone);
  }
  // gallery ring + parapet outside the tower wall
  for (let k = 0; k < seg; k++) {
    const a = ((k + 0.5) / seg) * 6.283185307179586;
    const half = TAN15 * (R + 1.1) + 0.02;
    b.add("box", sin(a) * (R + 0.55), top - 0.1, cos(a) * (R + 0.55), half, 0.12, 0.6, a, Material.Stone, TINT.stone);
    b.add("box", sin(a) * (R + 1.05), top + 0.5, cos(a) * (R + 1.05), half, 0.5, 0.07, a, Material.Metal, TINT.metal);
  }
  // lantern
  b.cyl(0, top, 0, 1.0, 2.3, Material.Metal, TINT.lamp);
  b.cyl(0, top + 2.3, 0, 1.35, 0.25, Material.Metal, 0xc8643c);
  b.cyl(0, top + 2.55, 0, 0.7, 0.5, Material.Metal, 0xc8643c);
  spots.push({ x: b.wx(0, 2.4), y: b.oy + top + 0.1, z: b.wz(0, 2.4), tag: "top" });
  spots.push({ x: b.wx(1.8, 0), y: b.oy + 0.35, z: b.wz(1.8, 0), tag: "interior" });
  return spots;
}

export function chapel(b: Builder, rng: Rng): Spot[] {
  const w = rng.range(6, 7), d = rng.range(10, 12.5);
  const hw = w / 2, hd = d / 2, t = 0.55, H = rng.range(4.6, 5.4);
  const tint = rng.chance(0.5) ? TINT.white : pickStucco(rng);
  const ruin = rng.range(0.1, 0.35);
  const spots: Spot[] = [];
  b.box(0, -0.4, 0, hw + 0.3, 0.52, hd + 0.3, Material.Stone, TINT.stone);
  const fy = 0.12;
  // door at +Z (front)
  b.wall(-hw, hd - t / 2, hw, hd - t / 2, t, fy, H, [{ at: hw, w: 1.6, y0: 0, y1: 3.0 }], Material.Stucco, tint, rng, ruin * 0.3);
  b.wall(hw, -hd + t / 2, -hw, -hd + t / 2, t, fy, H, [{ at: hw, w: 0.7, y0: 2.4, y1: 3.6 }], Material.Stucco, tint, rng, ruin * 0.3);
  const win = (L: number): Opening[] => [
    { at: L * 0.25, w: 0.7, y0: 2.0, y1: 3.7 },
    { at: L * 0.5, w: 0.7, y0: 2.0, y1: 3.7 },
    { at: L * 0.75, w: 0.7, y0: 2.0, y1: 3.7 },
  ];
  b.wall(-hw + t / 2, -hd + t, -hw + t / 2, hd - t, t, fy, H, win(d - 2 * t), Material.Stucco, tint, rng, ruin);
  b.wall(hw - t / 2, hd - t, hw - t / 2, -hd + t, t, fy, H, win(d - 2 * t), Material.Stucco, tint, rng, ruin);
  // apse behind the back wall
  b.cyl(0, fy, -hd - 1.2, hw * 0.8, H * 0.8, Material.Stucco, tint);
  // roof: front part intact, back collapsed sometimes (ridge along Z => lrot 90°)
  const roofFrac = rng.chance(0.55) ? rng.range(0.45, 0.7) : 1;
  const rl = d * roofFrac;
  b.wedge(0, fy + H, hd + 0.4 - rl / 2, rl / 2 + 0.2, 1.9, hw + 0.45, Material.Terracotta, TINT.terracotta, Math.PI / 2);
  // bell tower at the back-left corner
  const tx = -hw - 1.4, tz = -hd + 1.6;
  const tH = H + rng.range(3.5, 5);
  b.box(tx, 0, tz, 1.3, tH - 2.2, 1.3, Material.Stucco, tint);
  for (const [px, pz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) b.box(tx + px * 1.05, tH - 2.2, tz + pz * 1.05, 0.25, 1.7, 0.25, Material.Stucco, tint);
  b.box(tx, tH - 0.5, tz, 1.45, 0.3, 1.45, Material.Stone, TINT.stone);
  b.wedge(tx, tH - 0.2, tz, 1.45, 1.4, 1.45, Material.Terracotta, TINT.terracotta);
  b.cyl(tx, tH - 1.8, tz, 0.45, 0.8, Material.Metal, 0xc9a13c);
  // altar + pews
  b.box(0, fy, -hd + 1.3, 1.2, 1.0, 0.5, Material.Stone, TINT.white);
  const rows = Math.floor((d - 4.5) / 1.4);
  for (let k = 0; k < rows; k++) {
    if (rng.chance(0.3)) continue;
    const z = -hd + 3.0 + k * 1.4;
    b.box(-hw / 2 - 0.1, fy, z, hw / 2 - 0.6, 0.5, 0.22, Material.WoodDark, TINT.wood, rng.range(-0.08, 0.08));
    b.box(hw / 2 + 0.1, fy, z, hw / 2 - 0.6, 0.5, 0.22, Material.WoodDark, TINT.wood, rng.range(-0.08, 0.08));
  }
  spots.push(worldSpot(b, 0, fy + 0.2, -hd + 2.3, "altar"));
  return spots;
}

export function watchtower(b: Builder, rng: Rng): Spot[] {
  const S = 2.6, t = 0.6, H = rng.range(8.5, 10.5);
  const spots: Spot[] = [];
  b.box(0, -0.4, 0, S + 0.4, 0.55, S + 0.4, Material.Stone, TINT.stone);
  const fy = 0.15;
  const ruin = 0.25;
  // four walls with a door on +Z and arrow slits
  b.wall(-S, S - t / 2, S, S - t / 2, t, fy, H, [{ at: S, w: 1.2, y0: 0, y1: 2.3 }, { at: S * 0.5, w: 0.3, y0: 5.5, y1: 6.6 }], Material.Stone, TINT.stone, rng, 0);
  b.wall(S, -S + t / 2, -S, -S + t / 2, t, fy, H, [{ at: S, w: 0.3, y0: 3.2, y1: 4.4 }, { at: S * 1.4, w: 0.3, y0: 6.4, y1: 7.5 }], Material.Stone, TINT.stone, rng, 0);
  b.wall(-S + t / 2, -S + t, -S + t / 2, S - t, t, fy, H, [{ at: S - t, w: 0.3, y0: 4.8, y1: 6.0 }], Material.Stone, TINT.stone, rng, 0);
  b.wall(S - t / 2, S - t, S - t / 2, -S + t, t, fy, H, [{ at: S - t, w: 0.3, y0: 2.4, y1: 3.6 }], Material.Stone, TINT.stone, rng, 0);
  // square spiral stair along the inner walls, starting at the back-left
  const inner = S - t; // inner half size
  const rise = 0.42, run = 0.72, sw = 0.5; // stair half width
  const cornerPath: [number, number, number, number][] = [
    [-inner + sw, -inner + sw, 0, 1], // along +Z on the left wall... (x const)
    [-inner + sw, inner - sw, 1, 0], // along +X on the front wall
    [inner - sw, inner - sw, 0, -1], // along -Z right wall
    [inner - sw, -inner + sw, -1, 0], // along -X back wall
  ];
  let y = fy;
  const topY = fy + H - 0.9;
  let side = 0, pos = 0.4;
  const legLen = 2 * inner - 2 * sw;
  let last = { x: 0, z: 0 };
  const recent: { x: number; z: number }[] = [];
  for (let k = 0; k < 60 && y + rise < topY; k++) {
    const [sx, sz, ux, uz] = cornerPath[side % 4];
    const x = sx + ux * pos, z = sz + uz * pos;
    y += rise;
    b.box(x, y - 0.2, z, ux !== 0 ? run / 2 : sw, 0.2, uz !== 0 ? run / 2 : sw, Material.Stone, TINT.stoneDark);
    last = { x, z };
    recent.push(last);
    if (recent.length > 4) recent.shift();
    pos += run;
    if (pos > legLen - 0.3) {
      side++;
      pos = 0.4;
    }
  }
  // top platform with a hole over the last step
  const py = y;
  const cells = 4, cs = (2 * inner) / cells;
  for (let i = 0; i < cells; i++)
    for (let j = 0; j < cells; j++) {
      const cx = -inner + cs * (i + 0.5), cz = -inner + cs * (j + 0.5);
      if (recent.some((p) => Math.abs(cx - p.x) < cs * 0.85 && Math.abs(cz - p.z) < cs * 0.85)) continue;
      b.box(cx, py - 0.05, cz, cs / 2, 0.2, cs / 2, Material.Wood, TINT.wood);
    }
  // crenellations
  for (let k = -2; k <= 2; k += 2) {
    for (const [ox, oz, rx] of [[k * 0.9, S - 0.3, 0], [k * 0.9, -S + 0.3, 0], [S - 0.3, k * 0.9, 1], [-S + 0.3, k * 0.9, 1]]) {
      if (rng.chance(ruin)) continue;
      b.box(ox, fy + H, oz, rx ? 0.3 : 0.45, 0.8, rx ? 0.45 : 0.3, Material.Stone, TINT.stone);
    }
  }
  spots.push({ x: b.wx(0, 0), y: b.oy + py + 0.2, z: b.wz(0, 0), tag: "top" });
  spots.push({ x: b.wx(0.3, 0.6), y: b.oy + fy + 0.2, z: b.wz(0.3, 0.6), tag: "interior" });
  return spots;
}

/** Boathouse on the shore facing local -Z (the water), dock extends along -Z. */
export function boathouse(b: Builder, rng: Rng, dockLen: number, dockY: number, seabed: (lx: number, lz: number) => number): Spot[] {
  const w = 6.5, d = 7.5, hw = w / 2, hd = d / 2, t = 0.35, H = 3.4;
  const tint = pickStucco(rng);
  const spots: Spot[] = [];
  b.box(0, -0.6, 0, hw, 0.72, hd, Material.Wood, TINT.wood);
  const fy = 0.12;
  // land-side back wall (+Z) with a door, water-side (-Z) wide opening
  b.wall(-hw, hd - t / 2, hw, hd - t / 2, t, fy, H, [{ at: hw, w: 1.2, y0: 0, y1: 2.2 }], Material.Stucco, tint, rng, 0.15);
  b.wall(hw, -hd + t / 2, -hw, -hd + t / 2, t, fy, H, [{ at: hw, w: 3.6, y0: 0, y1: 2.9 }], Material.Wood, TINT.wood, rng, 0);
  b.wall(-hw + t / 2, -hd + t, -hw + t / 2, hd - t, t, fy, H, [{ at: 3.2, w: 0.9, y0: 1.0, y1: 1.9 }], Material.Stucco, tint, rng, 0.15);
  b.wall(hw - t / 2, hd - t, hw - t / 2, -hd + t, t, fy, H, [], Material.Stucco, tint, rng, 0.15);
  if (rng.chance(0.7)) b.wedge(0, fy + H, 0, hw + 0.3, 1.2, hd + 0.4, Material.Terracotta, TINT.terracotta, Math.PI / 2);
  // dock
  const dw = 1.2;
  const z0 = -hd, z1 = -hd - dockLen;
  const top = dockY - b.oy; // local height of the dock deck top
  b.box(0, top - 0.25, (z0 + z1) / 2, dw, 0.25, (z0 - z1) / 2, Material.Wood, TINT.wood);
  for (let z = z0 - 1.5; z > z1; z -= 3) {
    for (const x of [-dw + 0.15, dw - 0.15]) {
      const bed = seabed(x, z) - b.oy;
      const hgt = top - 0.2 - bed;
      if (hgt > 0.3) b.cyl(x, bed, z, 0.14, hgt, Material.WoodDark, TINT.wood);
    }
  }
  // bollards at the end
  b.cyl(-dw + 0.25, top, z1 + 0.4, 0.15, 0.45, Material.WoodDark, TINT.wood);
  b.cyl(dw - 0.25, top, z1 + 0.4, 0.15, 0.45, Material.WoodDark, TINT.wood);
  spots.push(worldSpot(b, 0, fy + 0.2, 0.8, "interior"));
  spots.push(worldSpot(b, 0, top + 0.1, z1 + 1.5, "dockEnd"));
  return spots;
}

/**
 * Wooden jetty from the shore (origin) out along local -Z over the water:
 * plank deck on piles, a mooring pole or two and bollards at the end.
 */
export function jetty(b: Builder, rng: Rng, len: number, top: number, seabed: (lx: number, lz: number) => number): Spot[] {
  const dw = 0.9;
  const z0 = 1.5, z1 = -len;
  b.box(0, top - 0.22, (z0 + z1) / 2, dw, 0.22, (z0 - z1) / 2, Material.Wood, TINT.wood);
  for (let z = z0 - 1.2; z > z1; z -= 2.6) {
    for (const x of [-dw + 0.12, dw - 0.12]) {
      const bed = seabed(x, z) - b.oy;
      const hgt = top - 0.2 - bed;
      if (hgt > 0.3) b.cyl(x, bed, z, 0.12, hgt, Material.WoodDark, TINT.wood);
    }
  }
  b.cyl(-dw + 0.22, top, z1 + 0.35, 0.13, 0.42, Material.WoodDark, TINT.wood);
  b.cyl(dw - 0.22, top, z1 + 0.35, 0.13, 0.42, Material.WoodDark, TINT.wood);
  // tall striped mooring poles (paline) beside the end, Venetian style
  const side = rng.chance(0.5) ? 1 : -1;
  for (let k = 0; k < 2; k++) {
    const x = side * (dw + 2.6 + k * 0.1), z = z1 + 1.2 + k * 3.2;
    const bed = seabed(x, z) - b.oy;
    if (top + 1.6 - bed > 0.5) b.cyl(x, bed, z, 0.13, top + 1.6 - bed, Material.Wood, rng.pick([0x4f7fa0, 0xd8584a, 0x4f8a6b]));
  }
  return [worldSpot(b, 0, top + 0.1, z1 + 1.2, "dockEnd")];
}

export function vespaShed(b: Builder, rng: Rng): Spot[] {
  const w = 4.2, d = 3.2, hw = w / 2, hd = d / 2, t = 0.3, H = 2.7;
  const tint = pickStucco(rng);
  b.box(0, -0.3, 0, hw, 0.4, hd, Material.Stone, TINT.stone);
  b.wall(hw, -hd + t / 2, -hw, -hd + t / 2, t, 0.1, H, [], Material.Stucco, tint);
  b.wall(-hw + t / 2, -hd + t, -hw + t / 2, hd, t, 0.1, H, [], Material.Stucco, tint);
  b.wall(hw - t / 2, hd, hw - t / 2, -hd + t, t, 0.1, H, [], Material.Stucco, tint);
  b.box(0, 0.1 + H, 0.2, hw + 0.3, 0.14, hd + 0.5, Material.Metal, 0xb8c4c8);
  // a workbench
  b.box(-hw + 0.8, 0.1, -hd + 0.6, 0.5, 0.85, 0.3, Material.WoodDark, TINT.wood);
  return [worldSpot(b, 0.6, 0.3, 0, "interior")];
}

/**
 * Aqueduct fragment: piers along local X with arches, one span broken, and a
 * rubble stair (a collapsed pier) climbing to the deck at the intact end.
 */
export function aqueduct(b: Builder, rng: Rng, groundAt: (lx: number) => number): Spot[] {
  const n = rng.intRange(3, 5);
  const span = 4.6;
  const H = rng.range(5.5, 7);
  const broken = rng.int(n - 1);
  const x0 = (-(n - 1) * span) / 2;
  const DZ = 1.1; // deck half width
  for (let k = 0; k < n; k++) {
    const x = x0 + k * span;
    const g = groundAt(x);
    const hh = k === broken + 1 && k !== n - 1 && rng.chance(0.5) ? H * 0.6 : H;
    b.box(x, g - 0.5, 0, 0.7, hh + 0.5 - g, DZ, Material.Stone, TINT.stone);
  }
  for (let k = 0; k < n - 1; k++) {
    if (k === broken) continue;
    const x = x0 + (k + 0.5) * span;
    // stepped arch soffit + deck with low channel walls
    b.box(x, H - 1.3, 0, span / 2 - 0.7, 0.45, DZ, Material.Stone, TINT.stone);
    b.box(x, H - 0.85, 0, span / 2 + 0.05, 0.85, DZ, Material.Stone, TINT.stone);
    b.box(x, H, DZ - 0.15, span / 2 + 0.05, 0.35, 0.15, Material.Stone, TINT.stoneDark);
    b.box(x, H, -DZ + 0.15, span / 2 + 0.05, 0.35, 0.15, Material.Stone, TINT.stoneDark);
  }
  // rubble stair at the end with more intact spans
  const left = broken >= n - 2 - broken;
  const dir = left ? -1 : 1;
  const xe = left ? x0 : x0 + (n - 1) * span;
  const rise = 0.42, run = 0.55;
  for (let j = 1; j < 40; j++) {
    const top = H - j * rise;
    const x = xe + dir * (0.7 + (j - 0.5) * run);
    const g = groundAt(x);
    if (top <= g + 0.15) break;
    b.box(x + rng.range(-0.04, 0.04), g - 0.4, rng.range(-0.08, 0.08), run / 2 + 0.03, top - g + 0.4, 0.95, Material.Stone, TINT.stoneDark, rng.range(-0.06, 0.06));
  }
  const spanTop = left ? 0 : n - 2;
  return [worldSpot(b, x0 + (spanTop + 0.5) * span, H + 0.1, 0, "top")];
}

export function bridgeDeck(b: Builder, len: number, y: number): void {
  const hw = 1.2;
  b.box(0, y - 0.3, 0, len / 2, 0.3, hw, Material.Wood, TINT.wood);
  b.box(0, y, hw - 0.08, len / 2, 0.95, 0.06, Material.WoodDark, TINT.wood);
  b.box(0, y, -hw + 0.08, len / 2, 0.95, 0.06, Material.WoodDark, TINT.wood);
}
