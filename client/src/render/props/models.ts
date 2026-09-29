// Procedural low-poly models for every PropKind, two LODs each. Vertex
// colored, soft (puffy normals on canopies), with wind weights baked in.
// Units are meters at scale 1; the base sits at y = 0.
import * as THREE from "three";
import { PropKind } from "../../../../shared/world/types";
import { Builder, col, rng, v3, wobble, type Wind } from "./builder";

export interface PropModel { lod0: THREE.BufferGeometry; lod1: THREE.BufferGeometry; lod2: THREE.BufferGeometry; height: number; radius: number }

const tmpC = new THREE.Color();
const mixC = (a: number, b: number, t: number) => tmpC.set(a).lerp(col(b), t).clone();
const vary = (c: THREE.Color, r: () => number, amt = 0.08) => c.clone().multiplyScalar(1 - amt + r() * amt * 2);

function curve(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, n: number): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push(v3(u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x, u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y, u * u * p0.z + 2 * u * t * p1.z + t * t * p2.z));
  }
  return out;
}

function blob(b: Builder, center: THREE.Vector3, r: number, squash: number, detail: number, color: (p: THREE.Vector3, n: THREE.Vector3) => THREE.Color, wind: Wind | ((p: THREE.Vector3) => Wind), puffCenter: THREE.Vector3, seed: number, bump = 0.12) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const m = new THREE.Matrix4().compose(center, new THREE.Quaternion(), v3(r, r * squash, r));
  b.add(g, m, color, wind, { sphereCenter: puffCenter, sphereBlend: 0.75, displace: (p) => wobble(p, 3.1, seed) * bump });
  g.dispose();
}

/** Leaf cards scattered over a blob surface: breaks the silhouette into leafy clumps. */
function fringe(b: Builder, center: THREE.Vector3, r: number, sq: number, count: number, size: number, color: (p: THREE.Vector3, n: THREE.Vector3) => THREE.Color, wind: (p: THREE.Vector3) => Wind, puffCenter: THREE.Vector3, rand: () => number) {
  const up = v3(0, 1, 0);
  for (let k = 0; k < count; k++) {
    const u = rand() * 1.6 - 0.6, a = rand() * Math.PI * 2;
    const d = v3(Math.sqrt(1 - u * u) * Math.cos(a), u, Math.sqrt(1 - u * u) * Math.sin(a));
    const p = center.clone().add(v3(d.x * r * 0.98, d.y * r * sq * 0.98, d.z * r * 0.98));
    const t1 = new THREE.Vector3().crossVectors(d, Math.abs(d.y) > 0.9 ? v3(1, 0, 0) : up).normalize();
    const t2 = new THREE.Vector3().crossVectors(d, t1).normalize();
    const out = d.clone().multiplyScalar(0.22);
    const sz = size * (0.7 + rand() * 0.6);
    const n = p.clone().sub(puffCenter).normalize().lerp(d, 0.5).normalize();
    const c = color(p, n);
    const w = wind(p);
    // rounded leaf: hexagon fan, tilted slightly outward
    const ctr = b.vertex(p.clone().addScaledVector(t2.clone().add(out), sz * 0.35), n, c.clone().multiplyScalar(1.06), [w[0], w[1] + 0.3, w[2]]);
    const ring: number[] = [];
    for (let e = 0; e < 5; e++) {
      const ang = (e / 5) * Math.PI * 2 + 0.3;
      const q = p.clone().addScaledVector(t1, Math.cos(ang) * sz * 0.42).addScaledVector(t2, (Math.sin(ang) * 0.6 + 0.35) * sz).addScaledVector(out, (Math.sin(ang) * 0.5 + 0.5) * sz);
      ring.push(b.vertex(q, n, c, [w[0], w[1] + 0.5, w[2]]));
    }
    for (let e = 0; e < 5; e++) b.tri(ctr, ring[e], ring[(e + 1) % 5]);
  }
}

// ------------------------------------------------------------------ palms
function palm(lod: number, lean: number): THREE.BufferGeometry {
  const b = new Builder();
  const r = rng(lean > 0.3 ? 11 : 7);
  const H = lean > 0.3 ? 7.2 : 8.2;
  const top = v3(lean * H * 0.55, H, 0);
  const trunk = curve(v3(0, 0, 0), v3(lean * H * 0.05, H * 0.55, 0), top, lod === 2 ? 2 : lod ? 4 : 10);
  b.tube(trunk, (t) => 0.3 * (1 - t * 0.45) + (t < 0.08 ? (0.08 - t) * 2.5 : 0), lod === 2 ? 3 : lod ? 4 : 7,
    (t) => {
      const ring = lod ? 0.5 : (Math.sin(t * 70) > 0.3 ? 1 : 0);
      return mixC(0x9b7a55, 0x7a5d40, ring * 0.6).multiplyScalar(0.9 + t * 0.2);
    },
    (t) => [t * 0.35, 0, 0], false);
  // crown bulb
  if (lod < 2) blob(b, top.clone().add(v3(0, -0.15, 0)), 0.42, 1.0, 0, () => col(0x6d7a3a), [0.35, 0, 0], top, 3, 0.02);
  const fronds = lod === 2 ? 6 : lod ? 7 : 11;
  for (let f = 0; f < fronds; f++) {
    const a = (f / fronds) * Math.PI * 2 + r() * 0.35;
    const young = f % 4 === 0; // a few younger fronds stand up
    const dir = v3(Math.cos(a), 0, Math.sin(a));
    const len = (young ? 2.8 : 3.8) + r() * 1.2;
    const rise = young ? 1.6 + r() * 0.5 : 0.7 + r() * 0.5;
    const droop = young ? 1.2 + r() * 0.6 : 2.8 + r() * 1.2;
    const pts: THREE.Vector3[] = [];
    const n = lod === 2 ? 2 : lod ? 5 : 10;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      pts.push(top.clone().addScaledVector(dir, len * t * (1 - 0.22 * t)).add(v3(0, Math.sin(t * Math.PI * 0.5) * rise - Math.pow(t, 2.2) * droop, 0)));
    }
    const lateral = v3(-dir.z, 0, dir.x);
    const baseC = 0x4a9434, tipC = 0x9ccf52;
    b.ribbon(pts, (t) => (t < 0.1 ? 0.3 + t * 7 : 1) * 0.78 * Math.pow(Math.sin(Math.PI * Math.min(1, t * 0.92 + 0.08)), 0.45), lateral,
      (t, e) => mixC(baseC, tipC, t * 0.65).multiplyScalar(e ? 0.95 : 1.1),
      (t) => [0.35 + t * 0.65, 0.3 + t * 0.7, 0], { fold: 0.32, serrate: lod ? 0 : 0.28, normalUp: 0.45 });
  }
  if (!lod) {
    for (let c = 0; c < 4; c++) {
      const a = r() * Math.PI * 2;
      blob(b, top.clone().add(v3(Math.cos(a) * 0.3, -0.35, Math.sin(a) * 0.3)), 0.16, 1.0, 0, () => col(0x5a4a24), [0.35, 0, 0], top, c, 0.02);
    }
  }
  return b.build();
}

// ----------------------------------------------------------- canopy trees
function canopyTree(lod: number, o: {
  seed: number; trunkH: number; trunkR: number; bark: number; leafDark: number; leafLight: number;
  blobs: { x: number; y: number; z: number; r: number; sq: number }[]; buttress?: boolean; forks?: number; vines?: number; twist?: number; fruit?: { color: number; count: number; size: number };
}): THREE.BufferGeometry {
  const b = new Builder();
  const r = rng(o.seed);
  const top = v3(0.2, o.trunkH, 0.1);
  const trunk = curve(v3(0, -0.2, 0), v3(o.twist ?? 0, o.trunkH * 0.5, -(o.twist ?? 0) * 0.5), top, lod === 2 ? 1 : lod ? 3 : 6);
  const bark = (t: number, a: number) => col(o.bark).multiplyScalar(0.85 + 0.15 * Math.sin(a * 3 + t * 9) + t * 0.1);
  b.tube(trunk, (t) => o.trunkR * (1 - t * 0.35) + (t < 0.1 ? (0.1 - t) * o.trunkR * 4 : 0), lod === 2 ? 4 : lod ? 5 : 8, bark, (t) => [t * 0.15, 0, 0]);
  if (o.buttress && !lod) {
    for (let k = 0; k < 4; k++) {
      const a = k * Math.PI / 2 + 0.4;
      const d = v3(Math.cos(a), 0, Math.sin(a));
      b.tube([d.clone().multiplyScalar(o.trunkR * 3).add(v3(0, -0.2, 0)), d.clone().multiplyScalar(o.trunkR * 1.6).add(v3(0, 0.8, 0)), d.clone().multiplyScalar(o.trunkR * 0.5).add(v3(0, 2.2, 0))], (t) => o.trunkR * 0.35 * (1 - t * 0.6), 4, bark, () => [0, 0, 0]);
    }
  }
  const forks = lod ? 0 : o.forks ?? 3;
  for (let k = 0; k < forks; k++) {
    const a = (k / forks) * Math.PI * 2 + r();
    const bb = o.blobs[k % o.blobs.length];
    const start = top.clone().add(v3(0, -o.trunkH * 0.12, 0));
    b.tube([start, start.clone().lerp(v3(bb.x, bb.y, bb.z), 0.5).add(v3(Math.cos(a) * 0.3, 0, Math.sin(a) * 0.3)), v3(bb.x, bb.y - bb.r * bb.sq * 0.3, bb.z)], (t) => o.trunkR * 0.45 * (1 - t * 0.6), 4, bark, (t) => [0.15 + t * 0.2, 0, 0], false);
  }
  const cc = new THREE.Vector3();
  for (const bb of o.blobs) cc.add(v3(bb.x, bb.y, bb.z));
  cc.multiplyScalar(1 / o.blobs.length);
  const list = lod === 2 ? [...o.blobs].sort((a, b2) => b2.r - a.r).slice(0, 3) : lod ? o.blobs.filter((_, i) => i % 2 === 0 || o.blobs.length <= 3) : o.blobs;
  list.forEach((bb, i) => {
    const center = v3(bb.x, bb.y, bb.z);
    const rr = lod === 2 ? bb.r * 1.3 : lod && o.blobs.length > 3 ? bb.r * 1.2 : bb.r;
    blob(b, center, rr, bb.sq, lod === 2 ? 0 : 1, (p, n) => {
      const up = n.y * 0.5 + 0.5;
      const c = mixC(o.leafDark, o.leafLight, Math.min(1, up * 0.9 + (p.y - cc.y) * 0.08));
      return vary(c, r, 0.06);
    }, (p) => [Math.min(1, 0.4 + (p.y / (o.trunkH + 3)) * 0.6), 0.45, 0], cc, i + o.seed, 0.1 * rr);
    if (!lod) fringe(b, center, rr, bb.sq, Math.round(4 + rr * 3.5), 0.42 + rr * 0.2, (p, n) => vary(mixC(o.leafDark, o.leafLight, Math.min(1, (n.y * 0.5 + 0.5) * 0.9 + 0.1 + (p.y - cc.y) * 0.08)), r, 0.08), (p) => [Math.min(1, 0.4 + (p.y / (o.trunkH + 3)) * 0.6), 0.6, 0], cc, r);
  });
  if (o.vines && !lod) {
    for (let k = 0; k < o.vines; k++) {
      const bb = o.blobs[k % o.blobs.length];
      const a = r() * Math.PI * 2;
      const s = v3(bb.x + Math.cos(a) * bb.r * 0.8, bb.y - bb.r * bb.sq * 0.5, bb.z + Math.sin(a) * bb.r * 0.8);
      const L = 2 + r() * 2.5;
      b.ribbon([s, s.clone().add(v3(0.1, -L * 0.5, 0)), s.clone().add(v3(0.15, -L, 0.05))], (t) => 0.07 * (1 - t * 0.5), v3(Math.cos(a), 0, Math.sin(a)), () => col(0x3f7d2c), (t) => [0.6 + t * 0.4, 0.6, 0]);
    }
  }
  if (o.fruit && !lod) {
    for (let k = 0; k < o.fruit.count; k++) {
      const bb = o.blobs[k % o.blobs.length];
      const u = r() * 2 - 1, a = r() * Math.PI * 2;
      const d = v3(Math.sqrt(1 - u * u) * Math.cos(a), u * 0.6 - 0.2, Math.sqrt(1 - u * u) * Math.sin(a)).normalize();
      const p = v3(bb.x, bb.y, bb.z).add(v3(d.x * bb.r * 1.02, d.y * bb.r * bb.sq * 1.02, d.z * bb.r * 1.02));
      const g = new THREE.OctahedronGeometry(1, 0);
      b.add(g, new THREE.Matrix4().compose(p, new THREE.Quaternion(), v3(o.fruit.size, o.fruit.size * 1.3, o.fruit.size)), col(o.fruit.color), [0.6, 0.3, 0]);
      g.dispose();
    }
  }
  return b.build();
}

function cypress(lod: number): THREE.BufferGeometry {
  const b = new Builder();
  b.tube([v3(0, -0.2, 0), v3(0, 1.2, 0)], () => 0.28, 5, () => col(0x6a5240), () => [0, 0, 0], false);
  const H = 9.5, R = 1.25;
  const g = new THREE.LatheGeometry(
    Array.from({ length: lod === 2 ? 5 : lod ? 7 : 16 }, (_: unknown, i: number) => {
      const t = i / ((lod === 2 ? 5 : lod ? 7 : 16) - 1);
      const rr = R * Math.pow(Math.sin(Math.PI * Math.min(1, t * 0.92 + 0.08)), 0.7) * (1 - t * 0.35);
      return new THREE.Vector2(Math.max(0.001, rr), 0.8 + t * (H - 0.8));
    }), lod === 2 ? 4 : lod ? 6 : 12);
  const m = new THREE.Matrix4();
  b.add(g, m, (p, n) => mixC(0x2f5a2b, 0x4f8a3b, Math.min(1, (n.y * 0.5 + 0.5) * 0.6 + (p.y / H) * 0.4)), (p) => [Math.min(1, p.y / H), 0.25, 0], {
    sphereCenter: v3(0, H * 0.45, 0), sphereBlend: 0.35,
    displace: lod ? undefined : (p) => wobble(p, 4.5, 2) * 0.12 + Math.sin(p.y * 3.2 + Math.atan2(p.z, p.x) * 3) * 0.06,
  });
  g.dispose();
  return b.build();
}

// ----------------------------------------------------------------- plants
function banana(lod: number): THREE.BufferGeometry {
  const b = new Builder();
  const r = rng(21);
  const H = 2.4;
  b.tube([v3(0, 0, 0), v3(0.05, H * 0.5, 0), v3(0.1, H, 0)], (t) => 0.16 * (1 - t * 0.3), lod ? 4 : 6, (t) => mixC(0x7e8a3c, 0x9aa84a, t), (t) => [t * 0.3, 0, 0]);
  const leaves = lod ? 5 : 8;
  for (let k = 0; k < leaves; k++) {
    const a = (k / leaves) * Math.PI * 2 + r() * 0.5;
    const d = v3(Math.cos(a), 0, Math.sin(a));
    const len = 2.2 + r() * 0.8;
    const s = v3(0.1, H - 0.1, 0);
    const pts = curve(s, s.clone().addScaledVector(d, len * 0.35).add(v3(0, 1.3 + r() * 0.5, 0)), s.clone().addScaledVector(d, len).add(v3(0, -0.2 - r() * 0.6, 0)), lod ? 4 : 9);
    b.ribbon(pts, (t) => 0.38 * Math.pow(Math.sin(Math.PI * Math.min(1, t * 0.9 + 0.1)), 0.5) * (t < 0.1 ? t * 10 : 1), v3(-d.z, 0, d.x),
      (t, e) => mixC(0x6fb03a, 0xa8d45a, t * 0.5).multiplyScalar(e ? 1 : 0.85), (t) => [0.3 + t * 0.7, 0.5 + t * 0.5, 0], { fold: 0.25, normalUp: 0.3 });
  }
  return b.build();
}

function fern(lod: number): THREE.BufferGeometry {
  const b = new Builder();
  const r = rng(31);
  const n = lod ? 5 : 9;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 + r() * 0.4;
    const d = v3(Math.cos(a), 0, Math.sin(a));
    const len = 0.9 + r() * 0.5;
    const pts = curve(v3(0, 0.05, 0), d.clone().multiplyScalar(len * 0.4).add(v3(0, 0.75, 0)), d.clone().multiplyScalar(len).add(v3(0, 0.15, 0)), lod ? 2 : 6);
    b.ribbon(pts, (t) => 0.2 * Math.sin(Math.PI * Math.min(1, t + 0.05)), v3(-d.z, 0, d.x), (t) => mixC(0x3d8a33, 0x86c24a, t), (t) => [t, 0.8, 0], { fold: 0.3, serrate: lod ? 0 : 0.7, normalUp: 0.5 });
  }
  return b.build();
}

function bush(lod: number, o: { seed: number; n: number; r: number; dark: number; light: number; flowers?: number[]; flowerAmt?: number }): THREE.BufferGeometry {
  const b = new Builder();
  const r = rng(o.seed);
  const blobs = lod === 2 ? 1 : lod ? Math.max(2, Math.ceil(o.n / 2)) : o.n;
  const cc = v3(0, o.r * 0.7, 0);
  for (let k = 0; k < blobs; k++) {
    const a = (k / blobs) * Math.PI * 2 + r();
    const d = k === 0 ? 0 : o.r * (0.55 + r() * 0.3);
    const rr = o.r * (k === 0 ? 1 : 0.65 + r() * 0.3) * (lod === 2 ? 1.45 : lod ? 1.15 : 1);
    const c = v3(Math.cos(a) * d, rr * 0.75, Math.sin(a) * d);
    const leafC = (_p: THREE.Vector3, n: THREE.Vector3) => vary(mixC(o.dark, o.light, n.y * 0.5 + 0.5), r, 0.05);
    const w = (p: THREE.Vector3): Wind => [Math.min(1, p.y / (o.r * 2)), 0.6, 0];
    blob(b, c, rr, 0.8, lod ? 0 : 1, leafC, w, cc, k + o.seed, 0.12 * rr);
    if (!lod) fringe(b, c, rr, 0.8, Math.round(5 + rr * 5), 0.26 + rr * 0.14, leafC, w, cc, r);
    if (o.flowers) {
      const fc = (_p: THREE.Vector3, n: THREE.Vector3) => vary(col(o.flowers![Math.floor(r() * o.flowers!.length)]), r, 0.1).multiplyScalar(0.9 + n.y * 0.2);
      fringe(b, c, rr * 1.03, 0.82, Math.round((lod === 2 ? 3 : lod ? 8 : 26) * (o.flowerAmt ?? 0.6) * rr), lod ? 0.4 : 0.22, fc, w, cc, r);
    }
  }
  return b.build();
}

function agave(lod: number): THREE.BufferGeometry {
  const b = new Builder();
  const r = rng(41);
  const n = lod ? 8 : 15;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 * 1.618 + r() * 0.2;
    const tilt = 0.25 + (k / n) * 0.9;
    const d = v3(Math.cos(a) * Math.sin(tilt), Math.cos(tilt), Math.sin(a) * Math.sin(tilt));
    const len = 0.7 + r() * 0.4;
    const tip = d.clone().multiplyScalar(len);
    const pts = curve(v3(0, 0.05, 0), tip.clone().multiplyScalar(0.5).add(v3(0, 0.12, 0)), tip.add(v3(0, 0.05, 0)), lod ? 2 : 4);
    b.ribbon(pts, (t) => 0.11 * (1 - t), v3(-Math.sin(a), 0, Math.cos(a)), (t, e) => mixC(0x6f9a8a, 0xa9c7a4, t * 0.5 + e * 0.3), (t) => [t * 0.3, 0, 0], { fold: -0.6, normalUp: 0.3 });
  }
  return b.build();
}

function grass(lod: number): THREE.BufferGeometry {
  const b = new Builder();
  const r = rng(51);
  const n = lod ? 5 : 11;
  const up = v3(0, 1, 0);
  for (let k = 0; k < n; k++) {
    const a = r() * Math.PI * 2;
    const off = v3(Math.cos(a) * r() * 0.18, 0, Math.sin(a) * r() * 0.18);
    const lean = v3(Math.cos(a), 0, Math.sin(a)).multiplyScalar(0.1 + r() * 0.25);
    const h = 0.35 + r() * 0.4;
    const w = 0.035 + r() * 0.02;
    const side = v3(-Math.sin(a), 0, Math.cos(a)).multiplyScalar(w);
    const base = mixC(0x5e9a34, 0x78a83c, r()), tip = mixC(0xb8d86a, 0xd8d078, r() * 0.5);
    const p0 = off.clone().sub(side), p1 = off.clone().add(side);
    const m = off.clone().addScaledVector(lean, 0.4).add(v3(0, h * 0.55, 0));
    const t = off.clone().add(lean).add(v3(0, h, 0));
    const i0 = b.vertex(p0, up, base, [0, 0.2, 0]);
    const i1 = b.vertex(p1, up, base, [0, 0.2, 0]);
    const i2 = b.vertex(m.clone().sub(side.clone().multiplyScalar(0.6)), up, base.clone().lerp(tip, 0.5), [0.55, 0.6, 0]);
    const i3 = b.vertex(m.clone().add(side.clone().multiplyScalar(0.6)), up, base.clone().lerp(tip, 0.5), [0.55, 0.6, 0]);
    const i4 = b.vertex(t, up, tip, [1, 1, 0]);
    b.quad(i0, i1, i3, i2);
    b.tri(i2, i3, i4);
  }
  return b.build();
}

function flowers(lod: number): THREE.BufferGeometry {
  const b = new Builder();
  const r = rng(61);
  const up = v3(0, 1, 0);
  const n = lod ? 3 : 6;
  for (let k = 0; k < n; k++) {
    const a = r() * Math.PI * 2;
    const base = v3(Math.cos(a) * r() * 0.25, 0, Math.sin(a) * r() * 0.25);
    const h = 0.25 + r() * 0.3;
    const top = base.clone().add(v3((r() - 0.5) * 0.1, h, (r() - 0.5) * 0.1));
    const side = v3(0.012, 0, 0.012);
    b.quad(b.vertex(base.clone().sub(side), up, col(0x5c8f34), [0, 0, 0]), b.vertex(base.clone().add(side), up, col(0x5c8f34), [0, 0, 0]), b.vertex(top.clone().add(side), up, col(0x6ea03a), [1, 0.5, 0]), b.vertex(top.clone().sub(side), up, col(0x6ea03a), [1, 0.5, 0]));
    const petals = 5, pr = 0.09 + r() * 0.05;
    const c = b.vertex(top.clone().add(v3(0, 0.01, 0)), up, col(0xffd84a), [1, 0.6, 0]);
    const ring: number[] = [];
    for (let p = 0; p < petals * 2; p++) {
      const ang = (p / (petals * 2)) * Math.PI * 2;
      const rr = p % 2 ? pr * 0.45 : pr;
      ring.push(b.vertex(top.clone().add(v3(Math.cos(ang) * rr, 0, Math.sin(ang) * rr)), up, col(0xffffff), [1, 0.6, 1]));
    }
    for (let p = 0; p < ring.length; p++) b.tri(c, ring[(p + 1) % ring.length], ring[p]);
    // leaf pair
    if (!lod) b.ribbon([base.clone().add(v3(0, 0.05, 0)), base.clone().add(v3(Math.cos(a) * 0.12, 0.14, Math.sin(a) * 0.12))], (t) => 0.04 * Math.sin(Math.PI * t + 0.3), v3(-Math.sin(a), 0, Math.cos(a)), () => col(0x5c9a3a), (t) => [t * 0.5, 0.4, 0]);
  }
  return b.build();
}

function reeds(lod: number): THREE.BufferGeometry {
  const b = new Builder();
  const r = rng(71);
  const up = v3(0, 1, 0);
  const n = lod ? 7 : 16;
  for (let k = 0; k < n; k++) {
    const a = r() * Math.PI * 2;
    const base = v3(Math.cos(a) * r() * 0.35, -0.1, Math.sin(a) * r() * 0.35);
    const h = 1.1 + r() * 0.8;
    const lean = v3(Math.cos(a), 0, Math.sin(a)).multiplyScalar(0.15 + r() * 0.2);
    const pts = [base, base.clone().addScaledVector(lean, 0.3).add(v3(0, h * 0.5, 0)), base.clone().add(lean).add(v3(0, h, 0))];
    b.ribbon(pts, (t) => 0.035 * (1 - t * 0.8), v3(-Math.sin(a), 0, Math.cos(a)), (t) => mixC(0x5f8f3a, 0xb8c46a, t), (t) => [t, 0.4, 0], { normalUp: 0.6 });
    if (k % 5 === 0) {
      const tip = pts[2];
      b.tube([tip.clone().add(v3(0, -0.35, 0)), tip.clone().add(v3(0, -0.05, 0))], () => 0.045, 5, () => col(0x6b4a2c), () => [1, 0.2, 0]);
      void up;
    }
  }
  return b.build();
}

function rock(lod: number, o: { seed: number; r: number; sq: number; moss: number }): THREE.BufferGeometry {
  const b = new Builder();
  const r = rng(o.seed);
  const g = new THREE.IcosahedronGeometry(1, lod ? 1 : 2);
  const m = new THREE.Matrix4().compose(v3(0, o.r * o.sq * 0.55, 0), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, r(), 0)), v3(o.r * 1.1, o.r * o.sq, o.r * 0.9));
  b.add(g, m, (p, n) => {
    const moss = n.y > 0.55 ? Math.min(1, (n.y - 0.55) * 3) * o.moss : 0;
    const base = mixC(0xb9ab94, 0xd8cbb2, 0.5 + wobble(p, 2.3, o.seed) * 0.5);
    return base.lerp(col(0x7a9a45), moss * 0.8);
  }, [0, 0, 0], {
    displace: (p) => wobble(p, 2.2, o.seed) * 0.16 + wobble(p, 5.1, o.seed + 1) * 0.05 + (p.y < -0.4 ? 0.1 : 0),
    sphereCenter: v3(0, o.r * o.sq * 0.4, 0), sphereBlend: 0.25,
  });
  g.dispose();
  return b.build();
}

function driftwood(lod: number): THREE.BufferGeometry {
  const b = new Builder();
  const bleach = (t: number, a: number) => mixC(0xcdbfa8, 0xa8998a, 0.3 + 0.3 * Math.sin(a * 2 + t * 20));
  b.tube(curve(v3(-1.3, 0.14, 0), v3(0, 0.26, 0.3), v3(1.3, 0.12, -0.1), lod ? 3 : 7), (t) => 0.16 * (1 - t * 0.4), lod ? 4 : 6, bleach, () => [0, 0, 0]);
  if (!lod) b.tube([v3(0.3, 0.2, 0.2), v3(0.6, 0.45, 0.7), v3(0.7, 0.55, 1.0)], (t) => 0.07 * (1 - t * 0.6), 4, bleach, () => [0, 0, 0]);
  return b.build();
}

function mangrove(lod: number): THREE.BufferGeometry {
  const b = new Builder();
  const r = rng(81);
  const bark = () => col(0x5d4a3a);
  b.tube([v3(0, 1.4, 0), v3(0.1, 2.8, 0), v3(0.2, 3.8, 0.1)], (t) => 0.22 * (1 - t * 0.3), lod ? 4 : 6, bark, (t) => [t * 0.2, 0, 0]);
  const roots = lod ? 4 : 8;
  for (let k = 0; k < roots; k++) {
    const a = (k / roots) * Math.PI * 2 + r() * 0.3;
    const d = v3(Math.cos(a), 0, Math.sin(a));
    const s = v3(0, 1.3 + r() * 0.8, 0);
    const e = d.clone().multiplyScalar(1.4 + r() * 1.2).add(v3(0, -0.3, 0));
    b.tube(curve(s, s.clone().addScaledVector(d, 0.9).add(v3(0, 0.6, 0)), e, lod ? 3 : 6), (t) => 0.1 * (1 - t * 0.4), 4, bark, () => [0, 0, 0], false);
  }
  const cc = v3(0.2, 4.6, 0.1);
  const blobs = [[0, 4.8, 0, 1.8], [1.4, 4.4, 0.6, 1.3], [-1.2, 4.3, -0.5, 1.4], [0.3, 4.2, -1.4, 1.2], [-0.4, 4.5, 1.4, 1.2]];
  blobs.slice(0, lod ? 3 : 5).forEach(([x, y, z, rr], i) => blob(b, v3(x, y, z), rr * (lod ? 1.2 : 1), 0.7, 1, (_p, n) => mixC(0x2f6a33, 0x5d9a44, n.y * 0.5 + 0.5), (p) => [Math.min(1, p.y / 6), 0.4, 0], cc, i + 9, 0.12));
  return b.build();
}

// --------------------------------------------------------------- catalog
let cache: Map<PropKind, PropModel> | null = null;

export function propModels(): Map<PropKind, PropModel> {
  if (cache) return cache;
  const m = new Map<PropKind, PropModel>();
  const both = (kind: PropKind, fn: (lod: number) => THREE.BufferGeometry, height: number, radius: number) => m.set(kind, { lod0: fn(0), lod1: fn(1), lod2: fn(2), height, radius });
  both(PropKind.Palm, (l) => palm(l, 0.12), 10, 4.5);
  both(PropKind.PalmLeaning, (l) => palm(l, 0.55), 9, 5.5);
  both(PropKind.Broadleaf, (l) => canopyTree(l, {
    seed: 3, trunkH: 7.5, trunkR: 0.55, bark: 0x8a7560, leafDark: 0x3d8636, leafLight: 0x86c450, buttress: true, vines: 3, forks: 3,
    blobs: [{ x: 0, y: 9.4, z: 0, r: 3.2, sq: 0.7 }, { x: 2.6, y: 8.5, z: 0.8, r: 2.4, sq: 0.7 }, { x: -2.4, y: 8.7, z: -0.6, r: 2.5, sq: 0.7 }, { x: 0.6, y: 8.3, z: 2.6, r: 2.2, sq: 0.7 }, { x: -0.5, y: 8.6, z: -2.6, r: 2.3, sq: 0.7 }, { x: 0.3, y: 10.8, z: 0.2, r: 2.0, sq: 0.8 }],
  }), 12, 5.5);
  both(PropKind.UmbrellaPine, (l) => canopyTree(l, {
    seed: 5, trunkH: 6.2, trunkR: 0.32, bark: 0x7d5a45, leafDark: 0x3b6d38, leafLight: 0x74a84e, forks: 4, twist: 0.6,
    blobs: [{ x: 0, y: 7.4, z: 0, r: 3.2, sq: 0.38 }, { x: 2.7, y: 7.0, z: 0.9, r: 2.3, sq: 0.42 }, { x: -2.5, y: 7.1, z: -1, r: 2.4, sq: 0.42 }, { x: 0.8, y: 7.0, z: -2.6, r: 2.2, sq: 0.42 }, { x: -0.9, y: 6.9, z: 2.5, r: 2.1, sq: 0.42 }],
  }), 8.5, 5.5);
  both(PropKind.Cypress, cypress, 10, 1.4);
  both(PropKind.Olive, (l) => canopyTree(l, {
    seed: 9, trunkH: 1.9, trunkR: 0.26, bark: 0x857564, leafDark: 0x71865a, leafLight: 0xb7c690, forks: 3, twist: 0.5,
    blobs: [{ x: 0, y: 3.0, z: 0, r: 1.4, sq: 0.7 }, { x: 1.2, y: 2.6, z: 0.4, r: 1.0, sq: 0.7 }, { x: -1.1, y: 2.7, z: -0.3, r: 1.05, sq: 0.7 }, { x: 0.2, y: 2.5, z: 1.1, r: 0.9, sq: 0.7 }, { x: -0.2, y: 3.7, z: -0.4, r: 0.8, sq: 0.8 }],
  }), 4.3, 2.4);
  both(PropKind.LemonTree, (l) => canopyTree(l, {
    seed: 13, trunkH: 1.3, trunkR: 0.14, bark: 0x7a6250, leafDark: 0x2c6a2e, leafLight: 0x58a23e, forks: 2,
    blobs: [{ x: 0, y: 2.2, z: 0, r: 1.15, sq: 0.9 }, { x: 0.7, y: 1.9, z: 0.3, r: 0.8, sq: 0.9 }, { x: -0.6, y: 2.0, z: -0.3, r: 0.8, sq: 0.9 }],
    fruit: { color: 0xffd42a, count: 14, size: 0.1 },
  }), 3.4, 1.7);
  both(PropKind.Banana, banana, 3.8, 2.4);
  both(PropKind.Fern, fern, 0.9, 1.3);
  both(PropKind.Bush, (l) => bush(l, { seed: 17, n: 4, r: 0.8, dark: 0x3c7a35, light: 0x7cb84e }), 1.6, 1.4);
  both(PropKind.Bougainvillea, (l) => bush(l, { seed: 19, n: 5, r: 1.1, dark: 0x3f7a35, light: 0x6aa84a, flowers: [0xd63fa0, 0xe8589f, 0xb72f8a, 0xf07ac0], flowerAmt: 0.62 }), 2.2, 1.9);
  both(PropKind.Agave, agave, 1.1, 0.9);
  both(PropKind.GrassTuft, grass, 0.7, 0.35);
  both(PropKind.Flowers, flowers, 0.55, 0.35);
  both(PropKind.RockSmall, (l) => rock(l, { seed: 23, r: 0.35, sq: 0.6, moss: 0.3 }), 0.4, 0.4);
  both(PropKind.RockMedium, (l) => rock(l, { seed: 29, r: 1.0, sq: 0.75, moss: 0.6 }), 1.3, 1.1);
  both(PropKind.Boulder, (l) => rock(l, { seed: 37, r: 2.3, sq: 0.85, moss: 0.8 }), 3.4, 2.6);
  both(PropKind.Driftwood, driftwood, 0.5, 1.4);
  both(PropKind.Reed, reeds, 2, 0.6);
  both(PropKind.Mangrove, mangrove, 6, 3);
  cache = m;
  return m;
}
