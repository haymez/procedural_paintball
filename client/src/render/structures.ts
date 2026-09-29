// Structures: the analytic solids rendered exactly (collision stays the
// solids), plus non-colliding Riviera decoration — framed windows with green
// shutters, sills with potted geraniums, roof ridge caps, hanging ivy, wall
// lanterns, laundry lines between neighbouring cottages. Everything for a
// 128 m cell is merged into one mesh with a single material that draws
// stucco / stone / brick / terracotta tiles / planks procedurally from a
// per-vertex material id and face-local UVs in meters.
import * as THREE from "three";
import { Material, StructureKind, type Solid, type Structure, type World } from "../../../shared/world/types";
import { makeStyledMaterial } from "./patch";
import { heightAt } from "./worldTextures";
import { PALETTE } from "./style";

// extra (render-only) material ids
const M_GLASS = 8, M_SHUTTER = 9, M_LEAF = 10, M_CLOTH = 11, M_GLOW = 12, M_POT = 13, M_STRIPE = 14, M_LANTERN = 15, M_RAIL = 16;

const BASE: Record<number, number> = {
  [Material.Stucco]: 0xffffff,
  [Material.Stone]: 0xd6cab2,
  [Material.Brick]: 0xc07352,
  [Material.Terracotta]: 0xd8683c,
  [Material.Wood]: 0xb08254,
  [Material.WoodDark]: 0x6e4c33,
  [Material.Metal]: 0x4a5558,
  [Material.Plaster]: 0xf6f0e4,
  [M_GLASS]: 0x2b3d4a,
  [M_SHUTTER]: PALETTE.shutterGreen,
  [M_LEAF]: 0xffffff,
  [M_CLOTH]: 0xffffff,
  [M_GLOW]: 0xffd27a,
  [M_POT]: 0xc2643e,
  [M_STRIPE]: 0xf6f0e4,
  [M_LANTERN]: 0x2b3d4a,
  [M_RAIL]: 0x3c4a4f,
};

class Geo {
  pos: number[] = []; nrm: number[] = []; col: number[] = []; uv: number[] = []; mat: number[] = [];
  idx: number[] = [];
  private c = new THREE.Color();
  v(p: THREE.Vector3, n: THREE.Vector3, u: number, w: number, mat: number, tint: THREE.Color, h: number): number {
    const i = this.pos.length / 3;
    this.pos.push(p.x, p.y, p.z); this.nrm.push(n.x, n.y, n.z);
    this.c.set(BASE[mat] ?? 0xffffff).multiply(tint);
    this.col.push(this.c.r, this.c.g, this.c.b);
    this.uv.push(u, w);
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

function wedge(g: Geo, s: Solid, tint: THREE.Color, gableTint: THREE.Color, gableMat: number, baseY: number) {
  const f = new Frame(s.cx, s.cy, s.cz, s.rotY);
  const { hx, hy, hz } = s;
  const H = (p: THREE.Vector3) => p.y - baseY;
  const slope = Math.hypot(hz, 2 * hy);
  // slopes: ridge at (x, +hy, 0), eaves at (x, -hy, ±hz)
  for (const sgn of [1, -1]) {
    const n = f.d(0, hz, sgn * 2 * hy).normalize();
    const a = f.p(-hx, hy, 0), b = f.p(hx, hy, 0), c = f.p(hx, -hy, sgn * hz), d = f.p(-hx, -hy, sgn * hz);
    const ids = [g.v(a, n, -hx, 0, s.mat, tint, H(a)), g.v(b, n, hx, 0, s.mat, tint, H(b)), g.v(c, n, hx, slope, s.mat, tint, H(c)), g.v(d, n, -hx, slope, s.mat, tint, H(d))];
    if (sgn > 0) g.quad(ids[0], ids[3], ids[2], ids[1]); else g.quad(ids[0], ids[1], ids[2], ids[3]);
  }
  // gable ends (wall material)
  for (const sgn of [1, -1]) {
    const n = f.d(sgn, 0, 0);
    const a = f.p(sgn * hx, -hy, -hz), b = f.p(sgn * hx, -hy, hz), c = f.p(sgn * hx, hy, 0);
    const y0 = s.cy - hy - baseY;
    const ia = g.v(a, n, -hz, y0, gableMat, gableTint, H(a)), ib = g.v(b, n, hz, y0, gableMat, gableTint, H(b)), ic = g.v(c, n, 0, y0 + 2 * hy, gableMat, gableTint, H(c));
    if (sgn > 0) g.tri(ia, ic, ib); else g.tri(ia, ib, ic);
  }
  // underside
  const n = f.d(0, -1, 0);
  const ids = [f.p(-hx, -hy, -hz), f.p(hx, -hy, -hz), f.p(hx, -hy, hz), f.p(-hx, -hy, hz)].map((p) => g.v(p, n, p.x, p.z, Material.WoodDark, new THREE.Color(1, 1, 1), H(p)));
  g.quad(ids[0], ids[1], ids[2], ids[3]);
  // ridge cap (decoration)
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
  }
}

function cylinder(g: Geo, s: Solid, tint: THREE.Color, baseY: number, seg = 18) {
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

function rng(seed: number) {
  let a = seed >>> 0 || 1;
  return () => { a = (Math.imul(a, 1664525) + 1013904223) >>> 0; return a / 4294967296; };
}

const isWallMat = (m: Material) => m === Material.Stucco || m === Material.Plaster || m === Material.Stone || m === Material.Brick;

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
    if (r() < 0.45) {
      const L = (a: number, y: number, o: number): [number, number, number] => thinX ? [o, y, a] : [a, y, o];
      const along = (r() - 0.5) * len * 0.8;
      const drop = height * (0.4 + r() * 0.5);
      const leaves = Math.floor(drop * 9);
      for (let k = 0; k < leaves; k++) {
        const t = k / leaves;
        const spread = 0.25 + t * 0.5;
        const [x, y, z] = L(along + (r() - 0.5) * spread * 2, s.hy - t * drop, out * (thin + 0.03 + r() * 0.05));
        const sz = 0.09 + r() * 0.07;
        const shade = new THREE.Color(0x4f8f3a).lerp(new THREE.Color(0x8cc152), r());
        box(g, f, x, y, z, thinX ? 0.01 : sz, sz, thinX ? sz : 0.01, M_LEAF, shade, st.y);
      }
    }
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
    const tilt = Math.atan2(q1.y - q0.y, q0.distanceTo(q1));
    const seg = new Frame(m.x, m.y, m.z, rot);
    void tilt;
    box(g, seg, 0, 0, 0, 0.02, 0.02, q0.distanceTo(q1) / 2 + 0.01, Material.Plaster, wood, baseY);
  }
  const cloths = [0xffffff, 0x9fd0ee, 0xf29a9a, 0xffe27a, 0xffffff, 0xb8e0a8, 0xf5b8d8];
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
    for (const s of st.solids) {
      const f = new Frame(s.cx, s.cy, s.cz, s.rotY);
      const dx = x - s.cx, dz = z - s.cz;
      const lx = dx * f.c - dz * f.s, lz = dx * f.s + dz * f.c;
      const hz = s.shape === "cylinder" ? s.hx : s.hz;
      if (Math.abs(lx) < s.hx + m && Math.abs(lz) < hz + m) return false;
    }
  }
  return true;
}

function cone(g: Geo, x: number, y: number, z: number, r: number, h: number, mat: number, tint: THREE.Color, baseY: number, seg = 16) {
  const tip = new THREE.Vector3(x, y + h, z);
  const ring: number[] = [];
  const tipIds: number[] = [];
  for (let k = 0; k <= seg; k++) {
    const a = (k / seg) * Math.PI * 2;
    const n = new THREE.Vector3(Math.cos(a) * h, r, Math.sin(a) * h).normalize();
    ring.push(g.v(new THREE.Vector3(x + Math.cos(a) * r, y, z + Math.sin(a) * r), n, (k / seg) * 6.28 * r, 0, mat, tint, y - baseY));
    tipIds.push(g.v(tip, n, (k / seg) * 6.28 * r, h, mat, tint, y + h - baseY));
  }
  for (let k = 0; k < seg; k++) g.tri(ring[k], tipIds[k], ring[k + 1]);
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
    cone(g, topC.cx, topC.cy + topC.hy, topC.cz, topC.hx * 0.95, 0.9, Material.Terracotta, new THREE.Color(0xd23c32).multiplyScalar(1.3), st.y);
    box(g, new Frame(topC.cx, topC.cy + topC.hy + 1.0, topC.cz, 0), 0, 0, 0, 0.05, 0.2, 0.05, Material.Metal, white, st.y);
  }
  void r;
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
    // dominant wall color for gable ends
    const wall = st.solids.find((s) => isWallMat(s.mat) && s.shape === "box" && s.hy > 1);
    const gableMat = wall ? wall.mat : Material.Stucco;
    const gableTint = new THREE.Color(wall ? wall.tint : 0xf2c68c);
    const isLH = st.kind === StructureKind.Lighthouse;
    for (const s0 of st.solids) {
      let s = s0;
      let base = st.y;
      if (isLH) {
        // render-only material remap: striped tower, glass lantern, see-through gallery railing
        if (s.shape === "box" && s.mat === Material.Plaster && s.hy > 3) s = { ...s, mat: M_STRIPE as Material };
        else if (s.shape === "cylinder" && s.mat === Material.Metal && s.hy > 0.8) s = { ...s, mat: M_LANTERN as Material };
        else if (s.shape === "box" && s.mat === Material.Metal && Math.min(s.hx, s.hz) < 0.1) { s = { ...s, mat: M_RAIL as Material }; base = s.cy - s.hy; }
      }
      const tint = new THREE.Color(s.tint);
      if (s.shape === "box") box(g, new Frame(s.cx, s.cy, s.cz, s.rotY), 0, 0, 0, s.hx, s.hy, s.hz, s.mat, tint, base);
      else if (s.shape === "wedge") wedge(g, s, tint, gableTint, gableMat, st.y);
      else cylinder(g, s, tint, st.y);
    }
    if (isLH) decorateLighthouse(g, st, r);
    else decorate(g, st, r);
  }
  // laundry lines on poles in the open ground between neighbouring dwellings
  const homes = world.structures.filter((s) => s.kind === StructureKind.Cottage || s.kind === StructureKind.Hamlet);
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
      laundry(getGeo(A.x, A.z), p0x, p0z, heightAt(world, p0x, p0z), p1x, p1z, heightAt(world, p1x, p1z), A.y, lr);
      lines++;
      break;
    }
  }

  const material = makeStyledMaterial(env, {
    key: "structures-v1",
    vertexPars: `attribute vec2 aUv; attribute vec2 aMat; varying vec2 vUv2; varying vec2 vMat; varying vec3 vObjN;`,
    vertexTransform: `vUv2 = aUv; vMat = aMat; vObjN = normal;`,
    fragPars: /* glsl */ `
      varying vec2 vUv2; varying vec2 vMat; varying vec3 vObjN;
      vec3 gBump = vec3(0.0);
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
        if (m == 0 || m == 7) {
          // stucco / plaster: mottled, sun-faded, patches of exposed brick, cracks, grime
          float mot = noiseT(uv * 0.11 + seed).r * 0.6 + noiseT(uv * 0.5).b * 0.4;
          c *= 0.88 + 0.2 * mot;
          float patchN = noiseT(uv * 0.07 + vec2(seed * 3.0, 0.0)).a + noiseT(uv * 0.4).b * 0.15;
          float patchM = smoothstep(0.76, 0.79, patchN) * (m == 0 ? 1.0 : 0.4);
          vec2 b = uv / vec2(0.26, 0.085); b.x += floor(b.y) * 0.5;
          vec2 fb = fract(b);
          float mortar = aaStep(0.07, fb.x) * aaStep(0.1, fb.y);
          vec3 brick = mix(vec3(0.62, 0.55, 0.45), vec3(0.72, 0.3, 0.18) * (0.8 + 0.4 * hash12(floor(b))), mix(0.6, mortar, detail));
          c = mix(c, brick, patchM);
          float crack = 1.0 - smoothstep(0.0, 0.025, abs(noiseT(uv * vec2(0.09, 0.05) + seed).r - 0.5));
          c *= 1.0 - crack * 0.35 * detail * (1.0 - patchM);
          c *= mix(0.72, 1.0, smoothstep(0.0, 0.9, hgt)); // splash grime at the base
        } else if (m == 1) {
          // fieldstone: irregular stones with mortar
          float cell = noiseT(uv * vec2(0.09, 0.14) + seed).g;
          float stoneShade = 0.82 + 0.3 * noiseT(uv * 0.13 + 7.0).r;
          c *= stoneShade;
          c = mix(c * 0.62, c, mix(0.7, aaStep(0.1, cell), detail));
        } else if (m == 2) {
          vec2 b = uv / vec2(0.24, 0.08); b.x += floor(b.y) * 0.5;
          vec2 fb = fract(b);
          float mortar = aaStep(0.06, fb.x) * aaStep(0.1, fb.y);
          c *= 0.8 + 0.4 * hash12(floor(b));
          c = mix(vec3(0.7, 0.64, 0.55), c, mix(0.8, mortar, detail));
        } else if (m == 3) {
          // barrel tiles: columns along the ridge (u), overlapping rows down the slope (v)
          float cu = uv.x / 0.24, rv = uv.y / 0.34;
          float row = floor(rv);
          float cu2 = cu + row * 0.5 * 0.0;
          float barrel = sin(fract(cu2) * 3.14159);
          float lip = smoothstep(0.78, 0.98, fract(rv));
          float tv = hash12(vec2(floor(cu2), row));
          c *= 0.78 + 0.35 * tv;
          c = mix(c, c * vec3(1.0, 0.85, 0.7), step(0.8, tv) * 0.6);
          c *= mix(0.72, 1.0, mix(0.8, barrel, detail));
          c *= 1.0 - lip * 0.25 * detail;
          float lichen = smoothstep(0.6, 0.75, noiseT(uv * 0.12 + seed).a);
          c = mix(c, vec3(0.62, 0.66, 0.42), lichen * 0.45);
          gBump = vec3(cos(fract(cu2) * 3.14159) * 0.5, 0.0, 0.0) * detail;
        } else if (m == 4 || m == 5) {
          float plank = uv.x / 0.2;
          float gap = aaStep(0.05, fract(plank));
          float grain = noiseT(vec2(uv.y * 0.3, uv.x * 4.0) + floor(plank) * 0.37).r;
          c *= (0.82 + 0.3 * grain) * (0.85 + 0.3 * hash12(vec2(floor(plank), 1.0)));
          c *= mix(0.55, 1.0, mix(0.8, gap, detail));
        } else if (m == 6) {
          c *= 0.8 + 0.3 * noiseT(uv * 0.8).r;
          c = mix(c, vec3(0.45, 0.25, 0.14), smoothstep(0.6, 0.8, noiseT(uv * 0.5 + 3.0).a) * 0.5);
          gSpec = 0.3; gShine = 30.0;
        } else if (m == 8) {
          // window glass: dark interior with a sky glint band
          float glint = smoothstep(0.35, 0.5, fract(uv.x * 0.8 + uv.y * 0.6));
          c = mix(c * 0.6, c * 1.6 + vec3(0.05, 0.08, 0.1), glint * 0.35);
          gSpec = 1.0; gShine = 90.0;
        } else if (m == 9) {
          float slat = fract(uv.y / 0.07);
          c *= 0.82 + 0.25 * smoothstep(0.2, 0.8, slat);
          c *= 0.85 + 0.25 * noiseT(uv * 0.9 + seed).r; // weathered paint
        } else if (m == 10) {
          gTransl = c * 0.9;
        } else if (m == 12) {
          c = vec3(1.0, 0.85, 0.55);
        } else if (m == 14) {
          // lighthouse: bold red bands on white plaster
          float band = step(0.5, fract(vWPos.y / 2.6 + 0.25));
          c = mix(c, vec3(0.72, 0.12, 0.08), band);
          c *= 0.9 + 0.15 * noiseT(uv * 0.3).r;
        } else if (m == 15) {
          // lantern room: glass panes with mullions and a warm lamp inside
          float mull = step(0.9, fract(uv.x / 0.5));
          vec3 glass = vec3(0.12, 0.2, 0.22) + vec3(1.0, 0.75, 0.35) * 0.35;
          c = mix(glass, vec3(0.2, 0.22, 0.24), mull);
          gSpec = 1.0; gShine = 90.0;
        } else if (m == 16) {
          // gallery railing: bars + top/bottom rails, open in between
          float bar = step(0.82, fract(uv.x / 0.22));
          float rails = step(uv.y, 0.07) + step(0.9, uv.y);
          if (bar + rails < 0.5 && abs(N.y) < 0.5) discard;
        } else if (m == 13) {
          c *= 0.9 + 0.2 * noiseT(uv * 2.0).r;
        }
        // moss on upward faces of old stone / stucco / tiles
        if (m <= 3 || m == 7) {
          float up = smoothstep(0.55, 0.9, N.y);
          float mossN = smoothstep(0.55, 0.75, noiseT(vWPos.xz * 0.18 + seed).r);
          c = mix(c, vec3(0.36, 0.5, 0.2), up * mossN * 0.6);
          // subtle green creep at the foot of walls
          c = mix(c, c * vec3(0.8, 0.95, 0.7), (1.0 - smoothstep(0.0, 0.5, hgt)) * 0.5 * (1.0 - up));
        }
        diffuseColor.rgb = c;
      }
    `,
    fragNormal: /* glsl */ `
      if (gBump.x != 0.0) {
        normal = normalize(normal + (viewMatrix * vec4(cross(vec3(0.0, 1.0, 0.0), normalize(vObjN)) * gBump.x, 0.0)).xyz);
      }
    `,
    fragLight: /* glsl */ `
      if (int(vMat.x + 0.5) == 12) totalEmissiveRadiance += vec3(2.2, 1.5, 0.7);
      if (int(vMat.x + 0.5) == 15) totalEmissiveRadiance += vec3(0.9, 0.62, 0.25) * (1.0 - step(0.9, fract(vUv2.x / 0.5)));
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
    dispose() { meshes.forEach((m) => m.geometry.dispose()); material.dispose(); },
  };
}
