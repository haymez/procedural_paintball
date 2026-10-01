// Structures: the analytic solids rendered exactly (collision stays the
// solids), their render-only visual parts (trims, balusters, signs, spires),
// plus a little procedural decoration on the old Riviera ruins (framed
// windows with shutters, ivy, lanterns, laundry lines). Everything for a
// 128 m cell is merged into one mesh with a single material. Surfaces are
// CC0 photo textures (lap siding, corrugated iron, thatch, lava rock,
// fieldstone, plaster, brick, planks, clay tiles, rust) in one texture array
// with packed normal/height maps, sampled with box-projected UVs in meters;
// painted materials take their colour from the per-vertex tint.
import * as THREE from "three";
import { Material, StructureKind, type Solid, type Structure, type VisualPart, type World } from "../../../shared/world/types";
import { loadTextureArray, texUrl } from "./assets";
import { makeStyledMaterial } from "./patch";
import { heightAt } from "./worldTextures";
import { PALETTE } from "./style";

// extra (render-only) material ids used by the procedural Riviera decoration
const M_SHUTTER = 32, M_POT = 33, M_STRIPE = 34, M_LANTERN = 35;
const M_GLASS = Material.Glass, M_LEAF = Material.Foliage, M_CLOTH = Material.Cloth, M_GLOW = Material.Lamp, M_RAIL = Material.Railing;

/** Texture array layers (public/tex/<id>/<id>_c.jpg and _nh.jpg). */
const LAYERS = [
  "brown_planks_05", // 0 painted lap siding
  "corrugated_iron", // 1
  "reed_roof_04", // 2 thatch
  "rock_wall_13", // 3 lava rock
  "old_stone_wall", // 4 fieldstone
  "painted_plaster_wall", // 5
  "broken_brick_wall", // 6
  "brown_planks_03", // 7 bare planks
  "clay_roof_tiles_02", // 8
  "rusty_metal_05", // 9
];
/** Fallback (sRGB) colours while the images load. */
const FALLBACK = [[196, 192, 182], [170, 176, 178], [168, 140, 92], [62, 58, 56], [128, 118, 104], [214, 212, 206], [150, 82, 58], [112, 106, 98], [178, 92, 56], [128, 72, 44]];
const TEX_SIZE = 512;

const BASE: Record<number, number> = {
  [Material.Stucco]: 0xffffff,
  [Material.Stone]: 0xffffff,
  [Material.Brick]: 0xffffff,
  [Material.Terracotta]: 0xffffff,
  [Material.Wood]: 0xe8d4b8,
  [Material.WoodDark]: 0x9a7a5e,
  [Material.Metal]: 0x5a6466,
  [Material.Plaster]: 0xf6f0e4,
  [Material.PaintedWood]: 0xffffff,
  [Material.Corrugated]: 0xffffff,
  [Material.Thatch]: 0xffffff,
  [Material.LavaRock]: 0xffffff,
  [Material.Rust]: 0xffffff,
  [M_GLASS]: 0x2b3d4a,
  [M_RAIL]: 0xffffff,
  [M_CLOTH]: 0xffffff,
  [Material.Sign]: 0xffffff,
  [M_LEAF]: 0xffffff,
  [M_GLOW]: 0xffd27a,
  [M_SHUTTER]: PALETTE.shutterGreen,
  [M_POT]: 0xc2643e,
  [M_STRIPE]: 0xf6f0e4,
  [M_LANTERN]: 0x2b3d4a,
};

class Geo {
  pos: number[] = []; nrm: number[] = []; col: number[] = []; uv: number[] = []; mat: number[] = [];
  idx: number[] = [];
  /** Per-structure texture offset (m), breaks up tiling between neighbours. */
  ou = 0; ov = 0;
  private c = new THREE.Color();
  v(p: THREE.Vector3, n: THREE.Vector3, u: number, w: number, mat: number, tint: THREE.Color, h: number): number {
    const i = this.pos.length / 3;
    this.pos.push(p.x, p.y, p.z); this.nrm.push(n.x, n.y, n.z);
    this.c.set(BASE[mat] ?? 0xffffff).multiply(tint);
    this.col.push(this.c.r, this.c.g, this.c.b);
    this.uv.push(u + this.ou, w + this.ov);
    this.mat.push(mat, h);
    return i;
  }
  quad(a: number, b: number, c: number, d: number) { this.idx.push(a, b, c, a, c, d); }
  tri(a: number, b: number, c: number) { this.idx.push(a, b, c); }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute("aUv", new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute("aMat", new THREE.Float32BufferAttribute(this.mat, 2));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
  get empty() { return this.idx.length === 0; }
}

/** Local frame of a solid: world = center + R(rotY) * local. Matches collide.ts. */
class Frame {
  c: number; s: number;
  constructor(public cx: number, public cy: number, public cz: number, rot: number) { this.c = Math.cos(rot); this.s = Math.sin(rot); }
  p(x: number, y: number, z: number) { return new THREE.Vector3(this.cx + x * this.c + z * this.s, this.cy + y, this.cz - x * this.s + z * this.c); }
  d(x: number, y: number, z: number) { return new THREE.Vector3(x * this.c + z * this.s, y, -x * this.s + z * this.c); }
}

/** Oriented box (decoration or solid). uv in meters per face. */
function box(g: Geo, f: Frame, x: number, y: number, z: number, hx: number, hy: number, hz: number, mat: number, tint: THREE.Color, baseY: number, faces = 0b111111) {
  const P = (a: number, b: number, c: number) => f.p(x + a, y + b, z + c);
  const H = (p: THREE.Vector3) => p.y - baseY;
  const face = (bit: number, n: THREE.Vector3, corners: THREE.Vector3[], uvs: [number, number][]) => {
    if (!(faces & bit)) return;
    const ids = corners.map((p, i) => g.v(p, n, uvs[i][0], uvs[i][1], mat, tint, H(p)));
    g.quad(ids[0], ids[1], ids[2], ids[3]);
  };
  const y0 = y - hy + (f.cy - baseY), y1 = y + hy + (f.cy - baseY);
  // +X / -X faces (u along z)
  face(1, f.d(1, 0, 0), [P(hx, -hy, hz), P(hx, -hy, -hz), P(hx, hy, -hz), P(hx, hy, hz)], [[z + hz, y0], [z - hz, y0], [z - hz, y1], [z + hz, y1]]);
  face(2, f.d(-1, 0, 0), [P(-hx, -hy, -hz), P(-hx, -hy, hz), P(-hx, hy, hz), P(-hx, hy, -hz)], [[z - hz, y0], [z + hz, y0], [z + hz, y1], [z - hz, y1]]);
  // +Z / -Z faces (u along x)
  face(4, f.d(0, 0, 1), [P(-hx, -hy, hz), P(hx, -hy, hz), P(hx, hy, hz), P(-hx, hy, hz)], [[x - hx, y0], [x + hx, y0], [x + hx, y1], [x - hx, y1]]);
  face(8, f.d(0, 0, -1), [P(hx, -hy, -hz), P(-hx, -hy, -hz), P(-hx, hy, -hz), P(hx, hy, -hz)], [[x + hx, y0], [x - hx, y0], [x - hx, y1], [x + hx, y1]]);
  // top / bottom (u,v = local x,z)
  face(16, f.d(0, 1, 0), [P(-hx, hy, hz), P(hx, hy, hz), P(hx, hy, -hz), P(-hx, hy, -hz)], [[x - hx, z + hz], [x + hx, z + hz], [x + hx, z - hz], [x - hx, z - hz]]);
  face(32, f.d(0, -1, 0), [P(-hx, -hy, -hz), P(hx, -hy, -hz), P(hx, -hy, hz), P(-hx, -hy, hz)], [[x - hx, z - hz], [x + hx, z - hz], [x + hx, z + hz], [x - hx, z + hz]]);
}

function wedge(g: Geo, s: Solid | VisualPart, tint: THREE.Color, gableTint: THREE.Color, gableMat: number, baseY: number) {
  const f = new Frame(s.cx, s.cy, s.cz, s.rotY);
  const { hx, hy, hz } = s;
  const H = (p: THREE.Vector3) => p.y - baseY;
  const slope = Math.hypot(hz, 2 * hy);
  // slopes: ridge at (x, +hy, 0), eaves at (x, -hy, ±hz)
  for (const sgn of [1, -1]) {
    const n = f.d(0, hz, sgn * 2 * hy).normalize();
    const a = f.p(-hx, hy, 0), b = f.p(hx, hy, 0), c = f.p(hx, -hy, sgn * hz), d = f.p(-hx, -hy, sgn * hz);
    const ids = [g.v(a, n, -hx * sgn, 0, s.mat, tint, H(a)), g.v(b, n, hx * sgn, 0, s.mat, tint, H(b)), g.v(c, n, hx * sgn, slope, s.mat, tint, H(c)), g.v(d, n, -hx * sgn, slope, s.mat, tint, H(d))];
    if (sgn > 0) g.quad(ids[0], ids[3], ids[2], ids[1]); else g.quad(ids[0], ids[1], ids[2], ids[3]);
  }
  // gable ends
  for (const sgn of [1, -1]) {
    const n = f.d(sgn, 0, 0);
    const a = f.p(sgn * hx, -hy, -hz), b = f.p(sgn * hx, -hy, hz), c = f.p(sgn * hx, hy, 0);
    const y0 = s.cy - hy - baseY;
    const ia = g.v(a, n, -hz * sgn, y0, gableMat, gableTint, H(a)), ib = g.v(b, n, hz * sgn, y0, gableMat, gableTint, H(b)), ic = g.v(c, n, 0, y0 + 2 * hy, gableMat, gableTint, H(c));
    if (sgn > 0) g.tri(ia, ic, ib); else g.tri(ia, ib, ic);
  }
  // underside: thatch, painted ceiling boards under tin, dark beams under tiles
  const n = f.d(0, -1, 0);
  const sm = s.mat === Material.Thatch ? Material.Thatch : s.mat === Material.Corrugated ? Material.Wood : Material.WoodDark;
  const st = new THREE.Color(s.mat === Material.Thatch ? 0x9a8a6a : s.mat === Material.Corrugated ? 0xe0d8c8 : 0xffffff);
  const ids = [f.p(-hx, -hy, -hz), f.p(hx, -hy, -hz), f.p(hx, -hy, hz), f.p(-hx, -hy, hz)].map((p, i) => g.v(p, n, (i === 0 || i === 3 ? -hx : hx), (i < 2 ? -hz : hz), sm, st, H(p)));
  g.quad(ids[0], ids[1], ids[2], ids[3]);
  // ridge caps
  if (s.mat === Material.Terracotta) {
    const r = 0.13;
    const seg = 5;
    const ring: number[][] = [];
    for (const ex of [-hx - 0.05, hx + 0.05]) {
      const row: number[] = [];
      for (let k = 0; k <= seg; k++) {
        const a = (k / seg) * Math.PI;
        const nn = f.d(0, Math.sin(a), Math.cos(a));
        const p = f.p(ex, hy + Math.sin(a) * r * 0.8, Math.cos(a) * r);
        row.push(g.v(p, nn, ex, a * 0.3, Material.Terracotta, tint.clone().multiplyScalar(0.85), H(p)));
      }
      ring.push(row);
    }
    for (let k = 0; k < seg; k++) g.quad(ring[0][k], ring[1][k], ring[1][k + 1], ring[0][k + 1]);
  } else if (s.mat === Material.Corrugated) {
    // folded sheet-metal cap over the ridge
    const w = 0.2, lift = 0.03;
    const k = w / slope;
    const capT = tint.clone().multiplyScalar(0.8);
    for (const sgn of [1, -1]) {
      const nn = f.d(0, hz, sgn * 2 * hy).normalize();
      const a = f.p(-hx - 0.04, hy + lift, 0), b = f.p(hx + 0.04, hy + lift, 0);
      const c = f.p(hx + 0.04, hy + lift - 2 * hy * k, sgn * hz * k), d = f.p(-hx - 0.04, hy + lift - 2 * hy * k, sgn * hz * k);
      const q = [g.v(a, nn, -hx, 0, Material.Metal, capT, H(a)), g.v(b, nn, hx, 0, Material.Metal, capT, H(b)), g.v(c, nn, hx, w, Material.Metal, capT, H(c)), g.v(d, nn, -hx, w, Material.Metal, capT, H(d))];
      if (sgn > 0) g.quad(q[0], q[3], q[2], q[1]); else g.quad(q[0], q[1], q[2], q[3]);
    }
  }
}

function cylinder(g: Geo, s: Solid | VisualPart, tint: THREE.Color, baseY: number, seg = 18) {
  const H = (p: THREE.Vector3) => p.y - baseY;
  const r = s.hx, y0 = s.cy - s.hy, y1 = s.cy + s.hy;
  const top: number[] = [], bot: number[] = [];
  const circ = 2 * Math.PI * r;
  for (let k = 0; k <= seg; k++) {
    const a = (k / seg) * Math.PI * 2;
    const n = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    const pb = new THREE.Vector3(s.cx + n.x * r, y0, s.cz + n.z * r), pt = new THREE.Vector3(s.cx + n.x * r, y1, s.cz + n.z * r);
    bot.push(g.v(pb, n, (k / seg) * circ, y0 - baseY, s.mat, tint, H(pb)));
    top.push(g.v(pt, n, (k / seg) * circ, y1 - baseY, s.mat, tint, H(pt)));
  }
  for (let k = 0; k < seg; k++) g.quad(bot[k], top[k], top[k + 1], bot[k + 1]);
  for (const [y, ny] of [[y1, 1], [y0, -1]] as const) {
    const n = new THREE.Vector3(0, ny, 0);
    const c = g.v(new THREE.Vector3(s.cx, y, s.cz), n, 0, 0, s.mat, tint, y - baseY);
    const ring: number[] = [];
    for (let k = 0; k <= seg; k++) {
      const a = (k / seg) * Math.PI * 2;
      ring.push(g.v(new THREE.Vector3(s.cx + Math.cos(a) * r, y, s.cz + Math.sin(a) * r), n, Math.cos(a) * r, Math.sin(a) * r, s.mat, tint, y - baseY));
    }
    for (let k = 0; k < seg; k++) ny > 0 ? g.tri(c, ring[k + 1], ring[k]) : g.tri(c, ring[k], ring[k + 1]);
  }
}

/** Four-sided pyramid: base hx × hz at cy - hy, apex at cy + hy. */
function pyramid(g: Geo, s: VisualPart, tint: THREE.Color, baseY: number) {
  const f = new Frame(s.cx, s.cy, s.cz, s.rotY);
  const { hx, hy, hz } = s;
  const H = (p: THREE.Vector3) => p.y - baseY;
  const apex = f.p(0, hy, 0);
  const corners: [number, number][] = [[-hx, hz], [hx, hz], [hx, -hz], [-hx, -hz]];
  for (let k = 0; k < 4; k++) {
    const [ax, az] = corners[k], [bx, bz] = corners[(k + 1) % 4];
    const a = f.p(ax, -hy, az), b = f.p(bx, -hy, bz);
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(apex, a)).normalize();
    const L = Math.hypot(bx - ax, bz - az), sl = Math.hypot(2 * hy, k % 2 ? hx : hz);
    g.tri(g.v(a, n, 0, 0, s.mat, tint, H(a)), g.v(b, n, L, 0, s.mat, tint, H(b)), g.v(apex, n, L / 2, sl, s.mat, tint, H(apex)));
  }
}

function cone(g: Geo, x: number, y: number, z: number, r: number, h: number, mat: number, tint: THREE.Color, baseY: number, seg = 16) {
  const tip = new THREE.Vector3(x, y + h, z);
  const ring: number[] = [];
  const tipIds: number[] = [];
  for (let k = 0; k <= seg; k++) {
    const a = (k / seg) * Math.PI * 2;
    const n = new THREE.Vector3(Math.cos(a) * h, r, Math.sin(a) * h).normalize();
    ring.push(g.v(new THREE.Vector3(x + Math.cos(a) * r, y, z + Math.sin(a) * r), n, (k / seg) * 6.28 * r, 0, mat, tint, y - baseY));
    tipIds.push(g.v(tip, n, (k / seg) * 6.28 * r, Math.hypot(r, h), mat, tint, y + h - baseY));
  }
  for (let k = 0; k < seg; k++) g.tri(ring[k], tipIds[k], ring[k + 1]);
}

function rng(seed: number) {
  let a = seed >>> 0 || 1;
  return () => { a = (Math.imul(a, 1664525) + 1013904223) >>> 0; return a / 4294967296; };
}

const isWallMat = (m: Material) => m === Material.Stucco || m === Material.Plaster || m === Material.Stone || m === Material.Brick;
const isGableMat = (m: Material) => isWallMat(m) || m === Material.PaintedWood || m === Material.LavaRock || m === Material.Thatch || m === Material.Wood;

/** Kinds that get the procedural Riviera windows / ivy / lanterns. */
const RIVIERA = new Set<StructureKind>([StructureKind.Cottage, StructureKind.Hamlet, StructureKind.Chapel, StructureKind.Watchtower, StructureKind.Boathouse, StructureKind.VespaShed, StructureKind.Arch]);

function decorate(g: Geo, st: Structure, r: () => number) {
  const white = new THREE.Color(1, 1, 1);
  const shutterTints = [0xffffff, 0xffffff, 0x9fd0d8, 0xd8e8a8, 0xc9e0ff];
  const shutterTint = new THREE.Color(shutterTints[Math.floor(r() * shutterTints.length)]);
  const frameTint = new THREE.Color(0xf8f1e2);
  let lamps = 0;
  for (const s of st.solids) {
    if (s.shape !== "box" || !isWallMat(s.mat)) continue;
    const thinX = s.hx < s.hz;
    const thin = thinX ? s.hx : s.hz;
    const len = 2 * (thinX ? s.hz : s.hx);
    const height = 2 * s.hy;
    if (thin > 0.45 || len < 1.6 || height < 2.4) continue;
    // outward side: away from the structure anchor
    const f = new Frame(s.cx, s.cy, s.cz, s.rotY);
    const axis = thinX ? f.d(1, 0, 0) : f.d(0, 0, 1);
    const out = (s.cx - st.x) * axis.x + (s.cz - st.z) * axis.z >= 0 ? 1 : -1;
    const bottom = -s.hy;
    const stories = Math.max(1, Math.floor((height + 0.3) / 3));
    const nWin = Math.max(1, Math.floor(len / 2.6));
    for (let story = 0; story < stories; story++) {
      const wy = bottom + 1.55 + story * 3.0;
      if (wy + 0.75 > s.hy - 0.2) continue;
      for (let k = 0; k < nWin; k++) {
        if (r() < 0.12) continue;
        const along = (k + 0.5) / nWin * len - len / 2;
        // local coordinates: along axis a (the long one), out along thin axis
        const L = (a: number, y: number, o: number): [number, number, number] => thinX ? [o, y, a] : [a, y, o];
        const face = out * (thin + 0.0);
        const W = 0.42, Hh = 0.58, fr = 0.07;
        // glass (slightly recessed look: dark pane on the surface)
        { const [x, y, z] = L(along, wy, face + out * 0.005); box(g, f, x, y, z, thinX ? 0.004 : W, Hh, thinX ? W : 0.004, M_GLASS, white, st.y); }
        // frame
        for (const [da, dy, ha, hh] of [[0, Hh + fr, W + fr * 2, fr], [0, -Hh - fr, W + fr * 2, fr], [W + fr, 0, fr, Hh], [-W - fr, 0, fr, Hh]] as const) {
          const [x, y, z] = L(along + da, wy + dy, face + out * 0.04);
          box(g, f, x, y, z, thinX ? 0.04 : ha, hh, thinX ? ha : 0.04, Material.Plaster, frameTint, st.y);
        }
        // sill
        { const [x, y, z] = L(along, wy - Hh - fr * 2 - 0.04, face + out * 0.1); box(g, f, x, y, z, thinX ? 0.1 : W + 0.18, 0.05, thinX ? W + 0.18 : 0.1, Material.Stone, white, st.y); }
        // shutters: open flat against the wall, closed, or missing
        const mode = r();
        if (mode < 0.72) {
          for (const side of [-1, 1]) {
            if (mode > 0.6 && side > 0) continue; // one lost
            const [x, y, z] = L(along + side * (W + fr * 2 + W * 0.5), wy, face + out * 0.05);
            box(g, f, x, y, z, thinX ? 0.03 : W * 0.5, Hh + 0.04, thinX ? W * 0.5 : 0.03, M_SHUTTER, shutterTint, st.y);
          }
        } else if (mode < 0.85) {
          const [x, y, z] = L(along, wy, face + out * 0.03);
          box(g, f, x, y, z, thinX ? 0.03 : W, Hh, thinX ? W : 0.03, M_SHUTTER, shutterTint, st.y);
        }
        // geranium pot on some sills
        if (story === 0 && r() < 0.35) {
          const [x, y, z] = L(along + (r() - 0.5) * 0.4, wy - Hh - fr * 2 + 0.12, face + out * 0.14);
          box(g, f, x, y, z, 0.1, 0.1, 0.1, M_POT, white, st.y);
          const [x2, y2, z2] = L(along, wy - Hh - fr * 2 + 0.3, face + out * 0.14);
          const fl = [0xe8404a, 0xff6fa0, 0xf05030][Math.floor(r() * 3)];
          box(g, f, x2, y2, z2, 0.16, 0.1, 0.16, M_LEAF, new THREE.Color(fl), st.y);
        }
      }
    }
    // ivy cascade down a wall end
    if (r() < 0.45) ivy(g, f, s, thinX, thin, len, height, out, st.y, r);
    // a wall lantern beside the first big wall of dwellings
    if (lamps === 0 && (st.kind === StructureKind.Cottage || st.kind === StructureKind.Hamlet || st.kind === StructureKind.Chapel || st.kind === StructureKind.Boathouse) && height > 2.6) {
      lamps++;
      const L = (a: number, y: number, o: number): [number, number, number] => thinX ? [o, y, a] : [a, y, o];
      const a0 = len / 2 - 0.4;
      let [x, y, z] = L(a0, bottom + 2.3, out * (thin + 0.15));
      box(g, f, x, y, z, 0.03 + (thinX ? 0.12 : 0), 0.03, 0.03 + (thinX ? 0 : 0.12), Material.Metal, white, st.y);
      [x, y, z] = L(a0, bottom + 2.12, out * (thin + 0.28));
      box(g, f, x, y, z, 0.09, 0.14, 0.09, M_GLOW, white, st.y);
      [x, y, z] = L(a0, bottom + 2.3, out * (thin + 0.28));
      box(g, f, x, y, z, 0.12, 0.03, 0.12, Material.Metal, white, st.y);
    }
  }
}

/** Creeper leaves cascading down a wall from its top. */
function ivy(g: Geo, f: Frame, s: Solid, thinX: boolean, thin: number, len: number, height: number, out: number, baseY: number, r: () => number) {
  const L = (a: number, y: number, o: number): [number, number, number] => thinX ? [o, y, a] : [a, y, o];
  const along = (r() - 0.5) * len * 0.8;
  const drop = height * (0.4 + r() * 0.5);
  const leaves = Math.floor(drop * 16);
  for (let k = 0; k < leaves; k++) {
    const t = k / leaves;
    const spread = 0.25 + t * 0.5;
    const [x, y, z] = L(along + (r() - 0.5) * spread * 2, s.hy - t * drop, out * (thin + 0.02 + r() * 0.04));
    const sz = 0.05 + r() * 0.05;
    const shade = new THREE.Color(0x355a24).lerp(new THREE.Color(0x5f8a38), r());
    box(g, f, x, y, z, thinX ? 0.01 : sz, sz, thinX ? sz : 0.01, M_LEAF, shade, baseY);
  }
}

/** Ruins: creepers and moss tufts on the broken masonry (render-only). */
function overgrow(g: Geo, st: Structure, r: () => number) {
  for (const s of st.solids) {
    if (s.shape !== "box" || (s.mat !== Material.LavaRock && s.mat !== Material.Stone && s.mat !== Material.Brick)) continue;
    const thinX = s.hx < s.hz;
    const thin = thinX ? s.hx : s.hz;
    const len = 2 * (thinX ? s.hz : s.hx);
    const height = 2 * s.hy;
    if (thin > 0.5 || len < 1.2 || height < 1.6 || r() > 0.4) continue;
    const f = new Frame(s.cx, s.cy, s.cz, s.rotY);
    ivy(g, f, s, thinX, thin, len, height, r() < 0.5 ? 1 : -1, st.y, r);
  }
}

/** Poles + sagging rope + sheets pegged to it, between p0 and p1 (xz), ground at y0/y1. */
function laundry(g: Geo, p0x: number, p0z: number, y0: number, p1x: number, p1z: number, y1: number, baseY: number, r: () => number) {
  const white = new THREE.Color(1, 1, 1);
  const wood = new THREE.Color(0.85, 0.8, 0.75);
  const dx = p1x - p0x, dz = p1z - p0z;
  const d = Math.hypot(dx, dz);
  const ux = dx / d, uz = dz / d;
  const rot = Math.atan2(ux, uz);
  const topY = Math.max(y0, y1) + 2.9;
  // poles with a small crossbar
  for (const [px, pz, gy] of [[p0x, p0z, y0], [p1x, p1z, y1]] as const) {
    const ph = topY + 0.15 - gy;
    box(g, new Frame(px, gy + ph / 2, pz, rot), 0, 0, 0, 0.055, ph / 2, 0.055, Material.WoodDark, white, baseY);
    box(g, new Frame(px, topY + 0.05, pz, rot), 0, 0, 0, 0.35, 0.04, 0.04, Material.WoodDark, white, baseY);
  }
  const p0 = new THREE.Vector3(p0x, topY, p0z), p1 = new THREE.Vector3(p1x, topY, p1z);
  const sag = d * 0.05;
  const pt = (t: number) => p0.clone().lerp(p1, t).add(new THREE.Vector3(0, -Math.sin(Math.PI * t) * sag, 0));
  const n = 12;
  for (let k = 0; k < n; k++) {
    const q0 = pt(k / n), q1 = pt((k + 1) / n);
    const m = q0.clone().add(q1).multiplyScalar(0.5);
    const seg = new Frame(m.x, m.y, m.z, rot);
    box(g, seg, 0, 0, 0, 0.02, 0.02, q0.distanceTo(q1) / 2 + 0.01, Material.Plaster, wood, baseY);
  }
  const cloths = [0xf0ece4, 0x9fc0d8, 0xd8a09a, 0xe8d48a, 0xf0ece4, 0xb0c8a0, 0xd8b8c8];
  let t = 0.08 + r() * 0.05;
  while (t < 0.9) {
    const w = 0.22 + r() * 0.22, h = 0.45 + r() * 0.45;
    const tc = t + (w / d);
    if (tc > 0.93) break;
    const top = pt(tc);
    const fr = new Frame(top.x, top.y - h / 2 - 0.01, top.z, rot);
    box(g, fr, 0, 0, 0, 0.012, h / 2, w, M_CLOTH, new THREE.Color(cloths[Math.floor(r() * cloths.length)]), baseY);
    // pegs
    for (const e of [-w * 0.8, w * 0.8]) {
      const pp = pt(tc + e / d);
      box(g, new Frame(pp.x, pp.y - 0.03, pp.z, rot), 0, 0, 0, 0.02, 0.045, 0.012, Material.Wood, white, baseY);
    }
    t = tc + w / d + 0.04 + r() * 0.12;
  }
}

/** Is the xz point clear of every solid footprint (plus margin)? */
function clearOf(world: World, x: number, z: number, m: number): boolean {
  for (const st of world.structures) {
    if (Math.hypot(st.x - x, st.z - z) > 40) continue;
    for (const s of [...st.solids, ...(st.visual ?? [])]) {
      const f = new Frame(s.cx, s.cy, s.cz, s.rotY);
      const dx = x - s.cx, dz = z - s.cz;
      const lx = dx * f.c - dz * f.s, lz = dx * f.s + dz * f.c;
      const hz = s.shape === "cylinder" || s.shape === "cone" ? s.hx : s.hz;
      if (Math.abs(lx) < s.hx + m && Math.abs(lz) < hz + m) return false;
    }
  }
  return true;
}

function decorateLighthouse(g: Geo, st: Structure, r: () => number) {
  const white = new THREE.Color(1, 1, 1);
  // a few small windows spiralling up the tower
  const walls = st.solids.filter((s) => s.shape === "box" && s.mat === Material.Plaster && s.hy > 3);
  if (walls.length) {
    const H = walls[0].hy * 2;
    const picks = [0.3, 0.55, 0.8];
    picks.forEach((hf, i) => {
      const s = walls[(3 + i * 4) % walls.length];
      const f = new Frame(s.cx, s.cy, s.cz, s.rotY);
      const out = (s.cx - st.x) * f.d(0, 0, 1).x + (s.cz - st.z) * f.d(0, 0, 1).z >= 0 ? 1 : -1;
      const wy = -s.hy + H * hf;
      box(g, f, 0, wy, out * (s.hz + 0.005), 0.22, 0.34, 0.004, M_GLASS, white, st.y);
      box(g, f, 0, wy + 0.4, out * (s.hz + 0.03), 0.3, 0.05, 0.04, Material.Stone, white, st.y);
      box(g, f, 0, wy - 0.4, out * (s.hz + 0.05), 0.32, 0.05, 0.07, Material.Stone, white, st.y);
    });
  }
  // cone cap on the topmost cylinder
  let topC: Solid | null = null;
  for (const s of st.solids) if (s.shape === "cylinder" && (!topC || s.cy + s.hy > topC.cy + topC.hy)) topC = s;
  if (topC) {
    cone(g, topC.cx, topC.cy + topC.hy, topC.cz, topC.hx * 0.95, 0.9, Material.Terracotta, new THREE.Color(0xb83a30).multiplyScalar(1.2), st.y);
    box(g, new Frame(topC.cx, topC.cy + topC.hy + 1.0, topC.cz, 0), 0, 0, 0, 0.05, 0.2, 0.05, Material.Metal, white, st.y);
  }
  void r;
}

/** Material + tint for the gable ends of a roof wedge: the wall it sits on, else by roof type. */
function gableFor(st: Structure, w: Solid | VisualPart): { mat: Material; tint: number } {
  if (w.mat === Material.Thatch) return { mat: Material.Thatch, tint: 0xd8c8a8 };
  const base = w.cy - w.hy;
  let best: Solid | null = null, bd = 1e9;
  for (const s of st.solids) {
    if (s.shape !== "box" || !isGableMat(s.mat) || s.hy < 0.5 || Math.max(s.hx, s.hz) < 1.0) continue;
    const top = s.cy + s.hy;
    const dy = Math.abs(top - base);
    if (dy > 0.6) continue;
    const dh = Math.hypot(s.cx - w.cx, s.cz - w.cz);
    if (dh > Math.max(w.hx, w.hz) + 1.5) continue;
    if (dy + dh * 0.05 < bd) { bd = dy + dh * 0.05; best = s; }
  }
  if (best) return { mat: best.mat, tint: best.tint };
  if (w.mat === Material.Corrugated) return { mat: Material.PaintedWood, tint: 0xe8e2d4 };
  return { mat: Material.Stucco, tint: 0xe9c99a };
}

/** Render-only material looks for a structure's solids (lighthouse stripes, see-through gallery). */
function remap(st: Structure, s: Solid): { s: Solid; base: number } {
  if (st.kind !== StructureKind.Lighthouse) return { s, base: st.y };
  if (s.shape === "box" && s.mat === Material.Plaster && s.hy > 3) return { s: { ...s, mat: M_STRIPE as Material }, base: st.y };
  if (s.shape === "cylinder" && s.mat === Material.Metal && s.hy > 0.8) return { s: { ...s, mat: M_LANTERN as Material }, base: st.y };
  if (s.shape === "box" && s.mat === Material.Metal && Math.min(s.hx, s.hz) < 0.1) return { s: { ...s, mat: M_RAIL as Material }, base: s.cy - s.hy };
  return { s, base: st.y };
}

function addPart(g: Geo, st: Structure, s: Solid | VisualPart, base: number) {
  const tint = new THREE.Color(s.tint);
  if (s.shape === "box") {
    // balusters / lattice: bars measured from the part's own bottom
    const b = s.mat === Material.Railing || s.mat === Material.Sign ? s.cy - s.hy : base;
    box(g, new Frame(s.cx, s.cy, s.cz, s.rotY), 0, 0, 0, s.hx, s.hy, s.hz, s.mat, tint, b);
  } else if (s.shape === "wedge") {
    const gb = gableFor(st, s);
    wedge(g, s, tint, new THREE.Color(gb.tint), gb.mat, base);
  } else if (s.shape === "cylinder") cylinder(g, s, tint, base, s.hx > 1.2 ? 24 : s.hx < 0.2 ? 8 : 16);
  else if (s.shape === "pyramid") pyramid(g, s, tint, base);
  else cone(g, s.cx, s.cy - s.hy, s.cz, s.hx, s.hy * 2, s.mat, tint, base, s.hx > 1 ? 20 : 12);
}

export function createStructures(world: World, env: Record<string, THREE.IUniform>) {
  const group = new THREE.Group();
  group.name = "structures";
  const CELL = 128;
  const geos = new Map<string, Geo>();
  const getGeo = (x: number, z: number) => {
    const k = `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
    let g = geos.get(k);
    if (!g) { g = new Geo(); geos.set(k, g); }
    return g;
  };
  for (const st of world.structures) {
    const g = getGeo(st.x, st.z);
    const r = rng(st.id * 7919 + world.seed);
    g.ou = Math.floor(r() * 7) * 0.37;
    g.ov = Math.floor(r() * 7) * 0.53;
    for (const s0 of st.solids) {
      const { s, base } = remap(st, s0);
      addPart(g, st, s, base);
    }
    for (const v of st.visual ?? []) addPart(g, st, v, st.y);
    g.ou = g.ov = 0;
    if (st.kind === StructureKind.Lighthouse) decorateLighthouse(g, st, r);
    else if (RIVIERA.has(st.kind) && !st.solids.some((s) => s.mat === Material.PaintedWood || s.mat === Material.LavaRock)) decorate(g, st, r);
    else if (st.kind === StructureKind.SugarMill || st.kind === StructureKind.Manor || st.kind === StructureKind.Heiau || st.kind === StructureKind.Watchtower) overgrow(g, st, r);
  }
  // laundry lines on poles in the open ground between neighbouring dwellings
  const homeKinds = new Set<StructureKind>([StructureKind.Cottage, StructureKind.Hamlet, StructureKind.House, StructureKind.Hale]);
  const homes = world.structures.filter((s) => homeKinds.has(s.kind));
  const lr = rng(world.seed + 3);
  let lines = 0;
  for (let i = 0; i < homes.length && lines < 6; i++) {
    for (let j = i + 1; j < homes.length; j++) {
      const A = homes[i], B = homes[j];
      const d = Math.hypot(A.x - B.x, A.z - B.z);
      if (d < 9 || d > 26 || Math.abs(A.y - B.y) > 1.5) continue;
      const ux = (B.x - A.x) / d, uz = (B.z - A.z) / d;
      const t0 = 0.36, t1 = 0.64;
      const p0x = A.x + (B.x - A.x) * t0 + -uz * 1.5, p0z = A.z + (B.z - A.z) * t0 + ux * 1.5;
      const p1x = A.x + (B.x - A.x) * t1 + -uz * 1.5, p1z = A.z + (B.z - A.z) * t1 + ux * 1.5;
      if (Math.hypot(p1x - p0x, p1z - p0z) < 3.2) continue;
      if (!clearOf(world, p0x, p0z, 0.6) || !clearOf(world, p1x, p1z, 0.6) || !clearOf(world, (p0x + p1x) / 2, (p0z + p1z) / 2, 0.4)) continue;
      // backyards only: never across a street or a lane
      let onPath = false;
      for (let t = 0; t <= 1.001 && !onPath; t += 0.125) {
        const x = p0x + (p1x - p0x) * t, z = p0z + (p1z - p0z) * t;
        const i = Math.round((z + 512) / 2) * 513 + Math.round((x + 512) / 2);
        if (world.path[i] > 40) onPath = true;
      }
      if (onPath) continue;
      laundry(getGeo(A.x, A.z), p0x, p0z, heightAt(world, p0x, p0z), p1x, p1z, heightAt(world, p1x, p1z), A.y, lr);
      lines++;
      break;
    }
  }

  const alb = loadTextureArray(LAYERS.map((id) => texUrl(`${id}/${id}_c.jpg`)), TEX_SIZE, { srgb: true, fallback: FALLBACK });
  const nh = loadTextureArray(LAYERS.map((id) => texUrl(`${id}/${id}_nh.jpg`)), TEX_SIZE, { srgb: false, fallback: LAYERS.map(() => [128, 128, 128]) });
  // per-layer mean colour (linear), for the painted materials' normalisation
  const toLin = (v: THREE.Vector3) => new THREE.Vector3(...[v.x, v.y, v.z].map((c) => new THREE.Color().setRGB(c, c, c, THREE.SRGBColorSpace).r) as [number, number, number]);
  const uniforms = {
    uStructAlb: { value: alb.texture as THREE.Texture },
    uStructNH: { value: nh.texture as THREE.Texture },
    uLayerMean: { value: alb.mean.map(toLin) },
  };
  alb.ready.then(() => {
    uniforms.uStructAlb.value = alb.texture;
    uniforms.uLayerMean.value = alb.mean.map(toLin);
  });
  nh.ready.then(() => { uniforms.uStructNH.value = nh.texture; });

  const material = makeStyledMaterial(env, {
    key: "structures-v2",
    uniforms,
    vertexPars: `attribute vec2 aUv; attribute vec2 aMat; varying vec2 vUv2; varying vec2 vMat; varying vec3 vObjN;`,
    vertexTransform: `vUv2 = aUv; vMat = aMat; vObjN = normal;`,
    fragPars: /* glsl */ `
      varying vec2 vUv2; varying vec2 vMat; varying vec3 vObjN;
      uniform highp sampler2DArray uStructAlb;
      uniform highp sampler2DArray uStructNH;
      uniform vec3 uLayerMean[10];
      // per material: texture layer (-1 procedural), meters per tile, normal strength, mode (0 natural, 1 painted)
      const int LAYER[19] = int[19](5, 4, 6, 8, 7, 7, 9, 5, 0, 1, 2, 3, 9, -1, -1, -1, -1, -1, -1);
      const float SCALE[19] = float[19](3.0, 2.6, 2.4, 2.6, 1.8, 1.8, 2.0, 3.0, 2.0, 2.0, 2.2, 2.4, 2.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0);
      const float NSTR[19] = float[19](0.7, 1.0, 1.0, 1.0, 0.9, 0.9, 0.5, 0.6, 1.0, 1.3, 1.0, 1.1, 0.8, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
      vec3 gTexN = vec3(0.0, 0.0, 1.0);
      float gNStr = 0.0;
      vec2 gTuv = vec2(0.0);
      float aaStep(float e, float x) { float w = fwidth(x) * 1.2; return smoothstep(e - w, e + w, x); }
    `,
    fragColor: /* glsl */ `
      {
        int m = int(vMat.x + 0.5);
        float hgt = vMat.y;
        vec2 uv = vUv2;
        vec3 c = diffuseColor.rgb;
        vec3 N = normalize(vObjN);
        float dist = length(vWPos - cameraPosition);
        float detail = 1.0 - smoothstep(40.0, 140.0, dist);
        float seed = hash12(floor(vWPos.xz * 0.25));
        // photo texture: sampled for every fragment (outside any branch) so mip selection stays valid
        int mi = m == 34 ? 7 : (m < 19 ? m : 13);
        int layer = LAYER[mi];
        float lay = float(max(layer, 0));
        gTuv = uv / SCALE[mi];
        vec3 alb = texture(uStructAlb, vec3(gTuv, lay)).rgb;
        vec3 avg = uLayerMean[max(layer, 0)];
        vec3 nhs = texture(uStructNH, vec3(gTuv, lay)).rgb;
        // rust only on tin and metal; explicit gradients keep mip selection valid inside the branch
        vec2 rdx = dFdx(gTuv) * 0.7, rdy = dFdy(gTuv) * 0.7;
        vec3 rust = vec3(0.3, 0.15, 0.08);
        if (m == 9 || m == 6) rust = textureGrad(uStructAlb, vec3(gTuv * 0.7 + 0.31, 9.0), rdx, rdy).rgb;
        if (layer >= 0) {
          gTexN = vec3(nhs.rg * 2.0 - 1.0, 1.0);
          gNStr = NSTR[mi];
          float lum = max(dot(avg, vec3(0.3, 0.55, 0.15)), 0.02);
          if (m == 0 || m == 7 || m == 8 || m == 9 || m == 34) {
            // painted surfaces: the tint is the paint; the photo adds wear, gaps and grain
            vec3 rel = alb / lum;
            c *= mix(vec3(1.0), rel, m == 8 ? 0.85 : 0.65);
            c = mix(c, vec3(dot(c, vec3(0.3, 0.55, 0.15))), 0.12); // sun-bleached
            // sun-faded, chalky paint varies from board to board and house to house
            float fade = noiseT(uv * 0.09 + seed).r;
            c = mix(c, c * 0.82 + vec3(0.06), smoothstep(0.35, 0.8, fade) * 0.5);
            if (m == 9) {
              // rust bleeding down from laps and nail lines
              float streak = noiseT(vec2(uv.x * 0.9, uv.y * 0.08) + seed * 3.0).r;
              float bare = smoothstep(0.55, 0.75, min(min(diffuseColor.r, diffuseColor.g), diffuseColor.b) / max(max(diffuseColor.r, diffuseColor.g), max(diffuseColor.b, 0.01)));
              float rm = smoothstep(0.62 - bare * 0.12, 0.85, streak + noiseT(uv * 0.2 + 1.7).a * 0.35);
              c = mix(c, rust * 0.95, rm * 0.75);
              gSpec = 0.25 * (1.0 - rm); gShine = 24.0;
            }
          } else {
            c *= alb;
            if (m == 5) c *= 0.78;
            if (m == 6) { c = mix(c, rust, 0.35); gSpec = 0.15; gShine = 20.0; }
            if (m == 11) c = mix(c, avg * diffuseColor.rgb, 0.3) * 1.45; // soften the stone/mortar contrast a little
          }
          if (m == 34) {
            // lighthouse: bold red bands on white plaster
            float band = step(0.5, fract(vWPos.y / 2.6 + 0.25));
            c = mix(c, vec3(0.62, 0.14, 0.1) * (0.85 + 0.3 * dot(alb, vec3(0.33))), band);
          }
          // grime and splash at the foot of walls
          c *= mix(0.74, 1.0, smoothstep(0.0, 0.9, hgt));
        } else if (m == 13) {
          // window glass: dark interior with a sky glint band
          float glint = smoothstep(0.35, 0.5, fract(uv.x * 0.8 + uv.y * 0.6));
          c = mix(c * 0.6, c * 1.6 + vec3(0.05, 0.08, 0.1), glint * 0.35);
          gSpec = 1.0; gShine = 90.0;
        } else if (m == 14) {
          // balusters / pickets / lattice: bars, open in between
          float bar = aaStep(0.62, fract(uv.x / 0.13));
          if (bar < 0.5 && abs(N.y) < 0.5) discard;
          c *= 0.9 + 0.15 * noiseT(uv * 2.0).r;
        } else if (m == 15) {
          // cloth: woven, faded, a few stripes on some
          c *= 0.86 + 0.18 * noiseT(uv * 1.6 + seed).r;
          c = mix(c, c * 0.72, step(0.8, fract(uv.x * 2.2 + seed)) * step(0.5, seed));
        } else if (m == 16) {
          // painted sign board: rows of blocky hand-painted letters (v from the board's bottom)
          float rowF = (hgt - 0.12) / 0.5;
          float row = floor(rowF), fy = fract(rowF) * 0.5 / 0.42;
          float cw = 0.27;
          float cell = floor(uv.x / cw), fx = fract(uv.x / cw) * 1.25;
          float hsh = hash12(vec2(cell, row + floor(seed * 17.0)));
          float gap = step(0.16, hsh) * step(fy, 1.0) * step(fx, 1.0) * step(0.0, rowF);
          float t = 0.2;
          float vL = step(fx, t) * step(0.3, fract(hsh * 7.1)), vR = step(1.0 - t, fx) * step(0.4, fract(hsh * 3.7));
          float hT = step(1.0 - t * 0.8, fy) * step(0.35, fract(hsh * 5.3)), hM = step(abs(fy - 0.5), t * 0.4) * step(0.5, fract(hsh * 9.1));
          float hB = step(fy, t * 0.8) * step(0.3, fract(hsh * 2.3));
          float letters = gap * clamp(vL + vR + hT + hM + hB, 0.0, 1.0);
          vec3 ink = dot(c, vec3(0.33)) > 0.45 ? vec3(0.16, 0.13, 0.11) : vec3(0.86, 0.8, 0.66);
          c = mix(c, ink, letters * 0.9);
          c *= 0.85 + 0.2 * noiseT(uv * 0.7).r;
        } else if (m == 17) {
          // leaves
          float lv = noiseT(vWPos.xz * 1.7 + vWPos.y * 0.9).r;
          c *= 0.7 + 0.5 * lv;
          gTransl = c * 0.9;
        } else if (m == 18) {
          c = vec3(1.0, 0.85, 0.55);
        } else if (m == 32) {
          float slat = fract(uv.y / 0.07);
          c *= 0.82 + 0.25 * smoothstep(0.2, 0.8, slat);
          c *= 0.85 + 0.25 * noiseT(uv * 0.9 + seed).r; // weathered paint
        } else if (m == 33) {
          c *= 0.9 + 0.2 * noiseT(uv * 2.0).r;
        } else if (m == 35) {
          // lantern room: glass panes with mullions and a warm lamp inside
          float mull = step(0.9, fract(uv.x / 0.5));
          vec3 glass = vec3(0.12, 0.2, 0.22) + vec3(1.0, 0.75, 0.35) * 0.35;
          c = mix(glass, vec3(0.2, 0.22, 0.24), mull);
          gSpec = 1.0; gShine = 90.0;
        }
        // moss on upward faces of old masonry, tiles and thatch
        if (m <= 3 || m == 7 || m == 10 || m == 11) {
          float up = smoothstep(0.55, 0.9, N.y);
          float mossN = smoothstep(0.55, 0.75, noiseT(vWPos.xz * 0.18 + seed).r);
          c = mix(c, vec3(0.2, 0.3, 0.1), up * mossN * 0.55);
          // green creep at the foot of walls
          c = mix(c, c * vec3(0.78, 0.92, 0.66), (1.0 - smoothstep(0.0, 0.6, hgt)) * 0.5 * (1.0 - up));
        }
        diffuseColor.rgb = c;
      }
    `,
    fragNormal: /* glsl */ `
      {
        // tangent frame from screen-space derivatives (computed unconditionally)
        vec3 sp = -vViewPosition;
        vec3 dp1 = dFdx(sp), dp2 = dFdy(sp);
        vec2 du1 = dFdx(gTuv), du2 = dFdy(gTuv);
        if (gNStr > 0.0) {
          vec3 dp2p = cross(dp2, normal), dp1p = cross(normal, dp1);
          vec3 T = dp2p * du1.x + dp1p * du2.x;
          vec3 B = dp2p * du1.y + dp1p * du2.y;
          float im = inversesqrt(max(max(dot(T, T), dot(B, B)), 1e-12));
          vec3 tn = vec3(gTexN.xy * gNStr, 1.0);
          normal = normalize(mat3(T * im, B * im, normal) * tn);
        }
      }
    `,
    fragLight: /* glsl */ `
      if (int(vMat.x + 0.5) == 18) totalEmissiveRadiance += vec3(2.2, 1.5, 0.7);
      if (int(vMat.x + 0.5) == 35) totalEmissiveRadiance += vec3(0.9, 0.62, 0.25) * (1.0 - step(0.9, fract(vUv2.x / 0.5)));
    `,
  }, { vertexColors: true, side: THREE.DoubleSide });
  // solids are closed: cast from back faces so lit faces never self-shadow (acne)
  material.shadowSide = THREE.BackSide;

  const meshes: THREE.Mesh[] = [];
  for (const [k, g] of geos) {
    if (g.empty) continue;
    const mesh = new THREE.Mesh(g.build(), material);
    mesh.name = `structures-${k}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
    meshes.push(mesh);
  }
  return {
    group,
    update(_c: THREE.Camera) {},
    dispose() {
      meshes.forEach((m) => m.geometry.dispose());
      material.dispose();
      alb.texture.dispose();
      nh.texture.dispose();
    },
  };
}
