// Plant models for the instanced props: trees, palms, ferns, shrubs, flowers.
//
// Stylized realism: crowns are an opaque, dark inner core (cheap, hides the
// overdraw behind it) wrapped in alpha-tested leaf cards painted in atlas.ts,
// with bent "crown" normals so the whole mass shades softly like a volume.
// Fronds (palm, fern, banana) are textured wings along a curved rachis.
// Trunks are tubes with CC0 bark photos. Three LODs each: the far LOD keeps
// the same textures and colors (fewer, bigger cards) so forests read the same
// from the sky drop as up close.
//
// Units are meters at scale 1; the base sits at y = 0.
import * as THREE from "three";
import { Builder, col, rng, v3, wobble, type Wind } from "./builder";
import { BARK, CELL, cellUV, leafLayer, type Cell } from "./atlas";

type V3 = THREE.Vector3;
const UP = v3(0, 1, 0);
const grey = (k: number) => new THREE.Color(k, k, k);
const tint = (r: number, g: number, b: number) => new THREE.Color(r, g, b);
const lerpC = (a: THREE.Color, b: THREE.Color, t: number) => a.clone().lerp(b, Math.min(1, Math.max(0, t)));
const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** flags in tuv.w: bent crown normals, dry/dead foliage, optional per instance (flowers on some bushes) */
const F_BENT = 1, F_DRY = 2, F_OPT = 4;

export function curve(p0: V3, p1: V3, p2: V3, n: number): V3[] {
  const out: V3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push(v3(u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x, u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y, u * u * p0.z + 2 * u * t * p1.z + t * t * p2.z));
  }
  return out;
}
function cubic(p0: V3, p1: V3, p2: V3, p3: V3, n: number): V3[] {
  const out: V3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    out.push(v3(a * p0.x + b * p1.x + c * p2.x + d * p3.x, a * p0.y + b * p1.y + c * p2.y + d * p3.y, a * p0.z + b * p1.z + c * p2.z + d * p3.z));
  }
  return out;
}

function randDir(r: () => number, minY = -1, maxY = 1): V3 {
  const y = minY + (maxY - minY) * r(), a = r() * Math.PI * 2, s = Math.sqrt(Math.max(0, 1 - y * y));
  return v3(Math.cos(a) * s, y, Math.sin(a) * s);
}
function basis(n: V3, spin: number): [V3, V3] {
  const ref = Math.abs(n.y) > 0.92 ? v3(1, 0, 0) : UP;
  const a = new THREE.Vector3().crossVectors(ref, n).normalize();
  const b = new THREE.Vector3().crossVectors(n, a).normalize();
  const c = Math.cos(spin), s = Math.sin(spin);
  return [a.clone().multiplyScalar(c).addScaledVector(b, s), b.clone().multiplyScalar(c).addScaledVector(a, -s)];
}

/** One textured quad. ax/ay: half extents along the cell's s/t axes. Normal per corner from nrm(). */
function card(b: Builder, c: V3, ax: V3, ay: V3, cell: Cell, nrm: (p: V3) => V3, color: (p: V3) => THREE.Color, wind: (p: V3) => Wind, flags = F_BENT, st: [number, number, number, number] = [0, 0, 1, 1]) {
  const L = leafLayer(cell);
  const ids: number[] = [];
  for (const [s, t] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
    const p = c.clone().addScaledVector(ax, s * 2 - 1).addScaledVector(ay, t * 2 - 1);
    const [u, v] = cellUV(cell, st[0] + (st[2] - st[0]) * s, st[1] + (st[3] - st[1]) * t);
    ids.push(b.vertex(p, nrm(p), color(p), wind(p), [u, v, L, flags]));
  }
  b.quad(ids[0], ids[1], ids[2], ids[3]);
}

// ---------------------------------------------------------------- crowns
export interface Lobe { x: number; y: number; z: number; r: number; sq: number }

interface CrownOpts {
  lobes: Lobe[];
  cell: Cell; far: Cell;
  /** cards per lobe at lod 0 / 1 / 2 */
  cards: [number, number, number];
  /** card half-size relative to the lobe radius */
  size: number;
  /** leaf tint (multiplies the painted atlas): shaded underside, sunlit top */
  under: THREE.Color; top: THREE.Color;
  /** inner core color (dark interior), 0 = no core */
  core?: THREE.Color;
  /** core radius relative to the lobe (default 0.6); lobes smaller than coreMin get none */
  coreR?: number; coreMin?: number;
  /** 0 random card facing .. 1 all cards face up (flat-topped pines) */
  upFacing?: number;
  /** fraction of lobe radius where cards sit (min, max) */
  shell?: [number, number];
  flatBottom?: number;
  flutter?: number;
}

/** Crown lobes: opaque core + leaf cards with bent normals. */
function crown(b: Builder, lod: number, o: CrownOpts, r: () => number) {
  const cc = new THREE.Vector3();
  let y0 = 1e9, y1 = -1e9, R = 0;
  for (const L of o.lobes) { cc.add(v3(L.x, L.y, L.z)); y0 = Math.min(y0, L.y - L.r * L.sq); y1 = Math.max(y1, L.y + L.r * L.sq); }
  cc.multiplyScalar(1 / o.lobes.length);
  for (const L of o.lobes) R = Math.max(R, Math.hypot(L.x - cc.x, L.z - cc.z) + L.r);
  const span = Math.max(1, y1 - y0);
  const ccy = (y0 + y1) / 2;
  const hsq = span / 2 / R;
  // bent normal: direction from the crown center on a squashed ellipsoid
  const bent = (p: V3) => v3((p.x - cc.x) / R, ((p.y - ccy) / (R * hsq)) * 0.85 + 0.15, (p.z - cc.z) / R).normalize();
  const hgt = (p: V3) => Math.min(1, Math.max(0, (p.y - y0) / span));
  const windOf = (p: V3): Wind => [Math.min(1, 0.45 + hgt(p) * 0.45), o.flutter ?? 0.6, 0];
  let list = o.lobes;
  if (lod === 1 && list.length > 5) list = [...list].sort((a, c) => c.r - a.r).slice(0, Math.ceil(list.length * 0.6));
  if (lod === 2) list = [...list].sort((a, c) => c.r - a.r).slice(0, Math.min(4, list.length));
  const grow = lod === 0 ? 1 : 1 + (1 - list.length / o.lobes.length) * 0.35;
  // 1) opaque core
  if (o.core) {
    let coreList = o.coreMin ? list.filter((L) => L.r >= o.coreMin!) : list;
    if (lod === 2) coreList = [...coreList].sort((a, c) => c.r - a.r).slice(0, 3);
    for (const L of coreList) {
      const g = lod ? new THREE.OctahedronGeometry(1, 0) : new THREE.OctahedronGeometry(1, 1);
      const rr = L.r * (o.coreR ?? 0.55) * grow;
      const m = new THREE.Matrix4().compose(v3(L.x, L.y, L.z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, r() * 3, 0)), v3(rr, rr * L.sq, rr));
      b.add(g, m, (p) => {
        const h = hgt(p);
        return o.core!.clone().multiplyScalar(0.7 + 0.45 * h);
      }, (p) => { const w = windOf(p); return [w[0], 0.25, 0]; }, { sphereCenter: v3(cc.x, ccy, cc.z), sphereBlend: 0.75, displace: (p) => wobble(p, 3.1, L.x) * 0.1 });
      g.dispose();
    }
  }
  // 2) leaf cards
  const cell = lod === 0 ? o.cell : o.far;
  const meanR = o.lobes.reduce((a, L) => a + L.r, 0) / o.lobes.length;
  for (const L of list) {
    const n = Math.max(2, Math.round(o.cards[lod] * (lod === 0 ? Math.min(1.4, Math.max(0.6, L.r / meanR)) : 1)));
    const size = L.r * o.size * (lod === 0 ? 1 : lod === 1 ? 1.25 : 1.45) * grow;
    const [s0, s1] = o.shell ?? [0.5, 0.95];
    for (let k = 0; k < n; k++) {
      let d: V3;
      if (lod === 2 && k < 3) {
        // three crossed cards per lobe: one flat, two upright
        d = k === 0 ? v3(0, 1, 0) : k === 1 ? v3(1, 0.15, 0).normalize() : v3(0, 0.15, 1).normalize();
      } else {
        d = randDir(r, -0.55, 1);
      }
      const f = lod === 2 && k < 3 ? (k === 0 ? 0.55 : 0.1) : s0 + (s1 - s0) * Math.sqrt(r());
      const p = v3(L.x + d.x * L.r * f * grow, L.y + d.y * L.r * L.sq * f * grow, L.z + d.z * L.r * f * grow);
      if (lod === 2 && k < 3 && k > 0) p.set(L.x, L.y, L.z);
      const up = o.upFacing ?? 0.2;
      const face = lod === 2 && k < 3 ? d.clone() : d.clone().lerp(UP, up).add(randDir(r).multiplyScalar(0.45)).normalize();
      const [ax, ay] = basis(face, r() * Math.PI * 2);
      const s = size * (0.8 + r() * 0.4);
      card(b, p, ax.multiplyScalar(s), ay.multiplyScalar(s), cell, bent, (q) => {
        // interior darker, top and outside brighter
        const out = Math.min(1, v3((q.x - L.x) / L.r, (q.y - L.y) / (L.r * L.sq), (q.z - L.z) / L.r).length());
        const k2 = Math.min(1, hgt(q) * 0.75 + out * 0.35);
        return lerpC(o.under, o.top, k2).multiplyScalar(0.72 + 0.28 * smooth(0.2, 0.9, out));
      }, windOf);
    }
  }
}

/** Irregular ring-of-lobes crown: a central lobe plus `n` around it. */
export function ringCrown(seed: number, n: number, y: number, R: number, rMin: number, rMax: number, sq: number, yJit: number, center: { r: number; dy: number }, cx = 0, cz = 0): Lobe[] {
  const r = rng(seed);
  const out: Lobe[] = center.r > 0 ? [{ x: cx, y: y + center.dy, z: cz, r: center.r, sq }] : [];
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 + (r() - 0.5) * 0.9;
    const d = R * (0.55 + r() * 0.35);
    out.push({ x: cx + Math.cos(a) * d, y: y + (r() - 0.5) * 2 * yJit, z: cz + Math.sin(a) * d, r: rMin + r() * (rMax - rMin), sq: sq * (0.9 + r() * 0.2) });
  }
  return out;
}

// ---------------------------------------------------------------- trunks
interface TreeOpts {
  seed: number;
  trunkH: number; trunkR: number; leanX?: number; leanZ?: number; bend?: number;
  bark: number; barkTex: number; barkRep?: number;
  /** trunk continues up through the crown to this height (pines) */
  leader?: number;
  fins?: number; finReach?: number; finH?: number;
  lianas?: number; lianaLen?: [number, number];
  moss?: number;
  crown: Omit<CrownOpts, "lobes"> & { lobes: Lobe[] };
  /** limbs per lod (default 6/3/0) */
  limbs?: [number, number, number];
  /** extra twigs from limbs into each lobe at lod 0 */
  twigs?: number;
}

/** Plank buttress root: a thin concave fin from the trunk down to the ground. */
function fin(b: Builder, dir: V3, trunkR: number, h: number, reach: number, thick: number, c: THREE.Color, n: number, layer: number) {
  const lat = v3(-dir.z, 0, dir.x);
  const inner: V3[] = [], outer: V3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, y = h * t - 0.25;
    inner.push(dir.clone().multiplyScalar(trunkR * 0.5).setY(y));
    outer.push(dir.clone().multiplyScalar(trunkR * 0.7 + reach * Math.pow(1 - t, 2.1)).setY(y));
  }
  for (const s of [1, -1]) {
    const nrm = lat.clone().multiplyScalar(s).addScaledVector(dir, 0.35).normalize();
    let pi = -1, po = -1;
    for (let i = 0; i <= n; i++) {
      const t = i / n, th = thick * (1 - t * 0.6);
      const a = b.vertex(inner[i].clone().addScaledVector(lat, s * th), nrm, c.clone().multiplyScalar(0.75), [0, 0, 0], [0, inner[i].y * 0.7, layer, 0]);
      const o = b.vertex(outer[i].clone().addScaledVector(lat, s * th * 0.6), nrm, c, [0, 0, 0], [(outer[i].length() - trunkR * 0.5) * 0.7, outer[i].y * 0.7, layer, 0]);
      if (pi >= 0) { if (s > 0) b.quad(pi, po, o, a); else b.quad(pi, a, o, po); }
      pi = a; po = o;
    }
  }
  let p0 = -1, p1 = -1;
  for (let i = 0; i <= n; i++) {
    const t = i / n, th = thick * (1 - t * 0.6) * 0.6;
    const tn = outer[Math.min(n, i + 1)].clone().sub(outer[Math.max(0, i - 1)]).normalize();
    const nrm = new THREE.Vector3().crossVectors(lat, tn).normalize();
    if (nrm.dot(dir) < 0) nrm.negate();
    const a = b.vertex(outer[i].clone().addScaledVector(lat, th), nrm, c, [0, 0, 0], [0, outer[i].y * 0.7, layer, 0]);
    const o = b.vertex(outer[i].clone().addScaledVector(lat, -th), nrm, c, [0, 0, 0], [0.15, outer[i].y * 0.7, layer, 0]);
    if (p0 >= 0) b.quad(p0, a, o, p1);
    p0 = a; p1 = o;
  }
}

/** Hanging liana / aerial root. */
function liana(b: Builder, top: V3, len: number, r: () => number, c0: THREE.Color, segs: number, width: number, layer: number) {
  const drift = v3((r() - 0.5) * 0.6, 0, (r() - 0.5) * 0.6);
  const pts: V3[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    pts.push(top.clone().add(v3(drift.x * t * t + Math.sin(t * 5 + top.x) * 0.08, -len * t, drift.z * t * t)));
  }
  b.tube(pts, (t) => width * (1 - t * 0.4), 3, (t) => c0.clone().multiplyScalar(0.85 + t * 0.2), (t) => [0.5 + t * 0.5, 0.3, 0], false, { layer, around: 0.25, perMeter: 0.6 });
}

function tree(lod: number, o: TreeOpts): THREE.BufferGeometry {
  const b = new Builder();
  const r = rng(o.seed);
  const lx = o.leanX ?? 0, lz = o.leanZ ?? 0;
  const top = v3(lx, o.trunkH, lz);
  const bendV = v3(-lx * (o.bend ?? 0.3), 0, -lz * (o.bend ?? 0.3));
  const tp0 = v3(0, -0.3, 0), tp1 = v3(lx * 0.25, o.trunkH * 0.5, lz * 0.25).add(bendV);
  const trunkPts = curve(tp0, tp1, top, lod === 2 ? 2 : lod ? 4 : 8);
  const barkC = col(o.bark);
  const barkF = (t: number, a: number) => {
    const c = barkC.clone().multiplyScalar(0.92 + t * 0.12);
    if (o.moss && lod < 2) c.lerp(tint(0.32, 0.42, 0.18), Math.max(0, Math.sin(a + 1.3)) * o.moss * (1 - t) * 0.55);
    return c;
  };
  const circ = Math.PI * 2 * o.trunkR;
  const rep = o.barkRep ?? 1.3; // m per texture repeat
  const tex = { layer: o.barkTex, around: Math.max(1, Math.round(circ / rep)), perMeter: 1 / rep };
  const flare = (t: number) => (t < 0.12 ? (0.12 - t) * o.trunkR * 5 : 0);
  b.tube(trunkPts, (t) => o.trunkR * (1 - t * 0.4) + flare(t), lod === 2 ? 4 : lod ? 6 : 9, barkF, (t) => [t * 0.12, 0, 0], !o.leader, tex);
  if (o.leader) {
    const lead = curve(top, top.clone().add(v3(lx * 0.15, (o.leader - o.trunkH) * 0.5, lz * 0.15)), top.clone().add(v3(lx * 0.1, o.leader - o.trunkH, lz * 0.2)), lod ? 2 : 4);
    b.tube(lead, (t) => o.trunkR * 0.6 * (1 - t * 0.8), lod === 2 ? 3 : lod ? 4 : 6, barkF, (t) => [0.2 + t * 0.3, 0, 0], true, { ...tex, around: 1 });
  }
  if (o.fins && (lod === 0 || (lod === 1 && o.fins > 4))) {
    const n = lod ? 3 : o.fins;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + r() * 0.5;
      fin(b, v3(Math.cos(a), 0, Math.sin(a)), o.trunkR, (o.finH ?? 3) * (0.75 + r() * 0.5), (o.finReach ?? 2.5) * (0.7 + r() * 0.5), o.trunkR * 0.16, barkC.clone().multiplyScalar(0.72).lerp(tint(0.2, 0.25, 0.12), (o.moss ?? 0) * 0.35), lod ? 2 : 4, o.barkTex);
    }
  }
  // limbs from the upper trunk out to the outer lobes, staggered
  const lobes = o.crown.lobes;
  const [n0, n1, n2] = o.limbs ?? [6, 3, 0];
  const branchN = Math.min(lod === 0 ? n0 : lod === 1 ? n1 : n2, lobes.length);
  const order = [...lobes].sort((a, c) => Math.hypot(c.x - lx, c.z - lz) - Math.hypot(a.x - lx, a.z - lz));
  const onTrunk = (t: number) => { const u = 1 - t; return v3(u * u * tp0.x + 2 * u * t * tp1.x + t * t * top.x, u * u * tp0.y + 2 * u * t * tp1.y + t * t * top.y, u * u * tp0.z + 2 * u * t * tp1.z + t * t * top.z); };
  for (let k = 0; k < branchN; k++) {
    const L = order[k];
    const end = v3(L.x, L.y - L.r * L.sq * 0.2, L.z);
    let start: V3;
    if (o.leader) {
      const along = Math.min(1, Math.max(0, (end.y - 1.2 - o.trunkH) / Math.max(1, o.leader - o.trunkH)));
      start = top.clone().lerp(top.clone().add(v3(0, o.leader - o.trunkH, 0)), along * 0.85).add(v3(0, -1.2, 0));
    } else start = onTrunk(0.72 + ((k * 0.37) % 1) * 0.26);
    const midP = start.clone().lerp(end, 0.45).add(v3(0, (o.leader ? 0.1 : 0.7) + r() * 0.4, 0));
    const pts = curve(start, midP, end, lod ? 2 : 3);
    const br = o.trunkR * (o.leader ? 0.3 : 0.4);
    b.tube(pts, (t) => br * (1 - t * 0.65), lod ? 3 : 4, barkF, (t) => [0.15 + t * 0.25, 0, 0], false, { layer: o.barkTex, around: 1, perMeter: 1 / rep });
    // twigs fanning into the lobe (visible through gaps in the leaves)
    if (lod === 0) {
      for (let j = 0; j < (o.twigs ?? 2); j++) {
        const d = randDir(r, -0.1, 0.9);
        const tEnd = end.clone().add(v3(d.x * L.r * 0.8, d.y * L.r * L.sq * 0.7, d.z * L.r * 0.8));
        b.tube(curve(end, end.clone().lerp(tEnd, 0.5).add(v3(0, 0.2, 0)), tEnd, 2), (t) => br * 0.35 * (1 - t * 0.7), 3, barkF, (t) => [0.4 + t * 0.4, 0.1, 0], false, { layer: o.barkTex, around: 1, perMeter: 1 / rep });
      }
    }
  }
  crown(b, lod, o.crown as CrownOpts, r);
  const nl = lod === 2 ? 0 : lod ? Math.ceil((o.lianas ?? 0) / 3) : o.lianas ?? 0;
  const [l0, l1] = o.lianaLen ?? [2, 5];
  for (let k = 0; k < nl; k++) {
    const L = lobes[(k * 3 + 1) % lobes.length];
    const a = r() * Math.PI * 2;
    const s = v3(L.x + Math.cos(a) * L.r * 0.6, L.y - L.r * L.sq * 0.5, L.z + Math.sin(a) * L.r * 0.6);
    liana(b, s, l0 + r() * (l1 - l0), r, tint(0.42, 0.36, 0.26), lod ? 1 : 4, 0.035 + r() * 0.03, BARK.smooth);
  }
  return b.build();
}

// ------------------------------------------------------------------ palms
/**
 * Pinnate frond: a rachis curve with a wing of leaflets on each side. The
 * leaflets hang (droop) more toward the tip; their texture (a band cell)
 * runs along the frond.
 */
function frond(b: Builder, pts: V3[], o: {
  cell: Cell; width: (t: number) => number; droop: (t: number) => number; curl?: number; across?: number;
  color: (t: number, f: number) => THREE.Color; wind: (t: number) => Wind; flags?: number; rachis?: THREE.Color; rachisR?: number; up?: number; fold?: number;
}) {
  const n = pts.length - 1;
  const m = o.across ?? 2;
  const L = leafLayer(o.cell);
  const tan = new THREE.Vector3();
  for (const side of [-1, 1]) {
    let prev: number[] | null = null;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      tan.subVectors(pts[Math.min(n, i + 1)], pts[Math.max(0, i - 1)]).normalize();
      const lat = new THREE.Vector3().crossVectors(tan, UP);
      if (lat.lengthSq() < 1e-6) lat.set(1, 0, 0);
      lat.normalize().multiplyScalar(side);
      const down = new THREE.Vector3().crossVectors(lat, tan).normalize();
      if (down.y > 0) down.negate();
      const a0 = o.droop(t);
      const w = o.width(t);
      const cur: number[] = [];
      // wing normal: the surface spanned by tan and the leaflet direction, facing up
      for (let j = 0; j <= m; j++) {
        const f = j / m;
        const a = a0 + (o.curl ?? 0.25) * f;
        const dir = lat.clone().multiplyScalar(Math.cos(a)).addScaledVector(down, Math.sin(a));
        const p = pts[i].clone().addScaledVector(dir, w * f).addScaledVector(UP, (o.fold ?? 0) * w * (j === 0 ? 0 : 1) * 0.15);
        const nrm = new THREE.Vector3().crossVectors(tan, dir).normalize();
        if (nrm.y < 0) nrm.negate();
        nrm.lerp(UP, o.up ?? 0.35).normalize();
        const [u, v] = cellUV(o.cell, t, f);
        const wv = o.wind(t);
        cur.push(b.vertex(p, nrm, o.color(t, f), [wv[0], wv[1] * (0.6 + f * 0.6), wv[2]], [u, v, L, o.flags ?? 0]));
      }
      if (prev) for (let j = 0; j < m; j++) b.quad(prev[j], prev[j + 1], cur[j + 1], cur[j]);
      prev = cur;
    }
  }
  if (o.rachis) {
    const rc = o.rachis;
    b.tube(pts, (t) => (o.rachisR ?? 0.03) * (1 - t * 0.7), 3, () => rc, (t) => { const w = o.wind(t); return [w[0], w[1] * 0.4, 0]; }, false);
  }
}

function palm(lod: number, lean: number): THREE.BufferGeometry {
  const b = new Builder();
  const r = rng(lean > 0.3 ? 11 : 7);
  const H = lean > 0.3 ? 7.4 : 8.6;
  // trunk: swollen bole, gentle S-curve, leaning top
  const top = v3(lean * H * 0.62, H, 0);
  const trunk = cubic(v3(0, -0.2, 0), v3(lean * H * 0.02, H * 0.33, 0.08), v3(lean * H * 0.3, H * 0.7, -0.05), top, lod === 2 ? 3 : lod ? 6 : 12);
  const barkC = tint(0.44, 0.4, 0.33);
  b.tube(trunk, (t) => 0.2 * (1 - t * 0.28) + (t < 0.1 ? (0.1 - t) * 1.5 : 0), lod === 2 ? 4 : lod ? 6 : 9,
    (t) => barkC.clone().multiplyScalar(0.88 + t * 0.15), (t) => [t * 0.35, 0, 0], false, { layer: BARK.palm, around: 1, perMeter: 0.85 });
  // crown shaft / boots
  const crownC = tint(0.42, 0.42, 0.24);
  if (lod < 2) {
    const tdir = top.clone().sub(trunk[trunk.length - 2]).normalize();
    b.tube([top.clone().addScaledVector(tdir, -0.45), top.clone().addScaledVector(tdir, 0.1), top.clone().addScaledVector(tdir, 0.3)], (t) => 0.24 * (1 - t * 0.6), lod ? 5 : 7, () => crownC, () => [0.35, 0, 0], true);
  }
  // coconuts in a couple of bunches under the crown
  if (lod < 2) {
    const nuts = lod ? 4 : 10;
    for (let c = 0; c < nuts; c++) {
      const a = (c % 3) * 2.1 + r() * 0.8;
      const rr = 0.24 + r() * 0.12;
      const g = new THREE.IcosahedronGeometry(1, 0);
      const nc = r() < 0.7 ? tint(0.36, 0.42, 0.14) : tint(0.5, 0.36, 0.16);
      b.add(g, new THREE.Matrix4().compose(top.clone().add(v3(Math.cos(a) * rr, -0.32 - r() * 0.25, Math.sin(a) * rr)), new THREE.Quaternion(), v3(0.13, 0.15, 0.13)), nc, [0.35, 0, 0]);
      g.dispose();
    }
  }
  // fronds: a rosette of arching fronds, younger ones upright, a few dead ones hanging
  const fronds = lod === 2 ? 8 : lod ? 11 : 16;
  const segs = lod === 2 ? 4 : lod ? 6 : 9;
  const golden = 2.39996;
  for (let f = 0; f < fronds; f++) {
    const a = f * golden + r() * 0.2;
    const dir = v3(Math.cos(a), 0, Math.sin(a));
    const age = f / fronds; // 0 young (up) .. 1 old (low)
    const dead = lod === 0 && f >= fronds - 2;
    const len = (dead ? 3.8 : 3.8 + age * 1.6) + r() * 0.5;
    const rise = dead ? -1.2 : 2.0 - age * 1.6;
    const droop = dead ? 2.4 : 0.8 + age * 3.2 + r() * 0.5;
    const pts: V3[] = [];
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      pts.push(top.clone().add(v3(0, 0.15, 0)).addScaledVector(dir, len * t * (1 - 0.18 * t)).add(v3(0, Math.sin(t * Math.PI * 0.5) * rise - Math.pow(t, 2) * droop, 0)));
    }
    const leafTint = dead ? tint(0.92, 0.74, 0.5) : lerpC(tint(0.95, 1.0, 0.86), tint(1.0, 1.0, 0.9), age);
    frond(b, pts, {
      cell: CELL.palm,
      width: (t) => (dead ? 0.55 : 1.0) * Math.pow(Math.sin(Math.PI * Math.min(1, 0.1 + t * 0.92)), 0.6),
      droop: (t) => (dead ? 1.25 : 0.25 + t * 0.75 + age * 0.25),
      curl: 0.35,
      across: lod ? 1 : 2,
      color: (t, fq) => leafTint.clone().multiplyScalar(0.8 + 0.25 * fq + 0.1 * t),
      wind: (t) => [0.35 + t * 0.65, dead ? 0.15 : 0.35 + t * 0.6, 0],
      flags: dead ? F_DRY : 0,
      rachis: lod === 0 && dead ? tint(0.55, 0.45, 0.3) : undefined,
      rachisR: 0.035,
      up: 0.4,
    });
  }
  return b.build();
}

// ------------------------------------------------------------------ plants
function banana(lod: number): THREE.BufferGeometry {
  const b = new Builder();
  const r = rng(21);
  const H = 2.3;
  // pseudostem: a few overlapping sheaths
  b.tube([v3(0, -0.1, 0), v3(0.04, H * 0.5, 0), v3(0.08, H, 0)], (t) => 0.15 * (1 - t * 0.35), lod ? 5 : 7, (t) => lerpC(tint(0.42, 0.4, 0.22), tint(0.5, 0.6, 0.28), t), (t) => [t * 0.3, 0, 0], true);
  const leaves = lod === 2 ? 5 : lod ? 6 : 9;
  for (let k = 0; k < leaves; k++) {
    const a = k * 2.39996 + r() * 0.3;
    const d = v3(Math.cos(a), 0, Math.sin(a));
    const old = k >= leaves - 2;
    const len = 2.0 + r() * 0.7;
    const s = v3(0.08, H - 0.1 + r() * 0.15, 0);
    const lift = old ? 0.4 : 1.1 + r() * 0.5;
    const pts = curve(s, s.clone().addScaledVector(d, len * 0.35).add(v3(0, lift, 0)), s.clone().addScaledVector(d, len).add(v3(0, old ? -1.3 : -0.25 - r() * 0.5, 0)), lod === 2 ? 3 : lod ? 4 : 8);
    // petiole bare for the first bit, then the blade
    const tint0 = old ? tint(0.85, 0.8, 0.72) : tint(1.0, 1.0, 0.95);
    frond(b, pts, {
      cell: CELL.banana,
      width: (t) => 0.36 * (t < 0.12 ? t / 0.12 * 0.3 : 1) * Math.pow(Math.sin(Math.PI * Math.min(1, 0.06 + t * 0.94)), 0.35),
      droop: (t) => (old ? 0.7 : 0.18 + t * 0.12),
      curl: 0.25,
      across: lod ? 1 : 2,
      color: (t, f) => tint0.clone().multiplyScalar(0.85 + f * 0.15 + t * 0.1),
      wind: (t) => [0.3 + t * 0.7, 0.4 + t * 0.5, 0],
      flags: old ? F_DRY : 0,
      up: 0.3,
    });
  }
  return b.build();
}

function fern(lod: number): THREE.BufferGeometry {
  const b = new Builder();
  const r = rng(31);
  const n = lod === 2 ? 4 : lod ? 5 : 9;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 + r() * 0.4;
    const d = v3(Math.cos(a), 0, Math.sin(a));
    const len = (0.95 + r() * 0.45) * (lod ? 1.1 : 1);
    const young = k % 4 === 0;
    const pts = curve(v3(0, 0.02, 0), d.clone().multiplyScalar(len * 0.35).add(v3(0, young ? 0.95 : 0.7, 0)), d.clone().multiplyScalar(len).add(v3(0, young ? 0.55 : 0.12, 0)), lod === 2 ? 1 : lod ? 2 : 6);
    frond(b, pts, {
      cell: CELL.fern,
      width: (t) => 0.2 * Math.pow(Math.sin(Math.PI * Math.min(1, 0.05 + t * 0.95)), 0.7),
      droop: () => 0.15, curl: 0.3, across: 1,
      color: (t) => (young ? tint(1.05, 1.1, 0.9) : grey(0.95)).clone().multiplyScalar(0.8 + 0.25 * t),
      wind: (t) => [t, 0.8, 0], up: 0.45,
    });
  }
  return b.build();
}

function treeFern(lod: number): THREE.BufferGeometry {
  const b = new Builder();
  const r = rng(91);
  const H = 3.9;
  const top = v3(0.25, H, 0.1);
  const trunk = curve(v3(0, -0.2, 0), v3(-0.1, H * 0.5, 0.05), top, lod === 2 ? 2 : lod ? 3 : 7);
  b.tube(trunk, (t) => 0.16 * (1 - t * 0.2) + (t < 0.1 ? (0.1 - t) * 1.3 : 0) + (t > 0.88 ? (t - 0.88) * 1.0 : 0), lod === 2 ? 4 : lod ? 5 : 7,
    (t) => tint(0.36, 0.28, 0.2).multiplyScalar(0.85 + t * 0.2), (t) => [t * 0.25, 0, 0], false, { layer: BARK.palm, around: 1, perMeter: 1.2 });
  const n = lod === 2 ? 6 : lod ? 9 : 14;
  const segs = lod === 2 ? 3 : lod ? 4 : 7;
  for (let f = 0; f < n; f++) {
    const a = (f / n) * Math.PI * 2 + r() * 0.25;
    const inner = f % 5 === 0;
    const d = v3(Math.cos(a), 0, Math.sin(a));
    const len = (inner ? 1.8 : 2.5) + r() * 0.5;
    const rise = inner ? 0.9 + r() * 0.3 : 0.4 + r() * 0.25;
    const droop = inner ? 0.35 : 1.0 + r() * 0.5;
    const pts: V3[] = [];
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      pts.push(top.clone().addScaledVector(d, len * t).add(v3(0, Math.sin(t * Math.PI * 0.5) * rise - t * t * t * droop, 0)));
    }
    frond(b, pts, {
      cell: CELL.fern,
      width: (t) => 0.5 * Math.pow(Math.sin(Math.PI * Math.min(1, 0.08 + t * 0.92)), 0.8),
      droop: (t) => 0.12 + t * 0.3, curl: 0.25, across: lod ? 1 : 2,
      color: (t, fq) => (inner ? tint(1.05, 1.12, 0.9) : grey(1)).clone().multiplyScalar(0.78 + 0.2 * fq + 0.12 * t),
      wind: (t) => [0.45 + t * 0.55, 0.4 + t * 0.6, 0], up: 0.45,
      rachis: lod === 0 && f % 2 === 0 ? tint(0.3, 0.26, 0.16) : undefined, rachisR: 0.025,
    });
  }
  if (!lod) {
    for (let k = 0; k < 3; k++) {
      const a = r() * Math.PI * 2;
      const g = new THREE.TorusGeometry(0.07, 0.025, 4, 8, Math.PI * 1.5);
      b.add(g, new THREE.Matrix4().compose(top.clone().add(v3(Math.cos(a) * 0.12, 0.25 + r() * 0.1, Math.sin(a) * 0.12)), new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, a, 0)), v3(1, 1, 1)), tint(0.45, 0.5, 0.22), [0.3, 0, 0]);
      g.dispose();
    }
  }
  return b.build();
}

/** A big single leaf (cell with the petiole at the bottom center) on a petiole. */
function bigLeaf(b: Builder, base: V3, dir: V3, stemH: number, L: number, W: number, pitch: number, cell: Cell, c: THREE.Color, stemC: THREE.Color, r: () => number, segs: number) {
  const lat = v3(-dir.z, 0, dir.x);
  const attach = dir.clone().multiplyScalar(0.18 + r() * 0.15).setY(stemH).add(base);
  const stem = curve(base, base.clone().addScaledVector(dir, 0.06).setY(base.y + stemH * 0.6), attach, segs > 1 ? 2 : 1);
  b.tube(stem, () => 0.022, 3, () => stemC, (t) => [t * 0.5, 0.2, 0], false);
  // blade: leaf "up" (cell t) runs from the attachment outward/down along dir, slightly cupped
  const fwd = dir.clone().multiplyScalar(Math.cos(pitch)).setY(Math.sin(pitch)).normalize();
  const nrm = new THREE.Vector3().crossVectors(fwd, lat).normalize();
  if (nrm.y < 0) nrm.negate();
  const Lr = leafLayer(cell);
  const rows = segs, colsN = 2;
  const ids: number[][] = [];
  for (let i = 0; i <= rows; i++) {
    const t = i / rows;
    const row: number[] = [];
    for (let j = 0; j <= colsN; j++) {
      const s = j / colsN;
      const x = (s - 0.5) * 2;
      // the attachment sits at t = 0.2 of the cell: blade extends a bit behind it (lobes)
      const along = (t - 0.2) * L;
      const p = attach.clone().addScaledVector(fwd, along).addScaledVector(lat, x * W).addScaledVector(nrm, -0.1 * Math.abs(x) * W - 0.08 * Math.max(0, along) * Math.max(0, along) / L);
      const n = nrm.clone().addScaledVector(lat, x * 0.35).normalize();
      const [u, v] = cellUV(cell, s, t);
      row.push(b.vertex(p, n, c.clone().multiplyScalar(0.85 + t * 0.2), [0.5 + t * 0.4, 0.6, 0], [u, v, Lr, 0]));
    }
    ids.push(row);
  }
  for (let i = 0; i < rows; i++) for (let j = 0; j < colsN; j++) b.quad(ids[i][j], ids[i][j + 1], ids[i + 1][j + 1], ids[i + 1][j]);
}

/** Forest-floor big leaves: monstera and elephant ear in one clump. */
function understory(lod: number): THREE.BufferGeometry {
  const b = new Builder();
  const r = rng(101);
  const n = lod === 2 ? 4 : lod ? 5 : 7;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 + r() * 0.6;
    const d = v3(Math.cos(a), 0, Math.sin(a));
    const mon = k % 3 !== 2;
    const stemH = 0.5 + r() * 0.6;
    const L = mon ? 0.85 + r() * 0.3 : 0.95 + r() * 0.3;
    bigLeaf(b, v3(0, 0, 0), d, stemH, L, L * 0.5, -0.2 - r() * 0.45, mon ? CELL.monstera : CELL.heart, grey(0.95 + r() * 0.1), tint(0.36, 0.48, 0.2), r, lod ? 1 : 2);
  }
  return b.build();
}

/** Ti plant / ginger clump: long strap leaves on short canes, some red. */
function tiPlant(lod: number): THREE.BufferGeometry {
  const b = new Builder();
  const r = rng(131);
  const canes = lod ? 2 : 3;
  for (let c = 0; c < canes; c++) {
    const a = (c / canes) * Math.PI * 2 + r();
    const base = v3(Math.cos(a) * 0.15, 0, Math.sin(a) * 0.15);
    const h = 0.9 + r() * 0.8;
    const topP = base.clone().add(v3((r() - 0.5) * 0.25, h, (r() - 0.5) * 0.25));
    b.tube([base, base.clone().lerp(topP, 0.5).add(v3(0.03, 0, 0)), topP], (t) => 0.035 * (1 - t * 0.3), 4, () => tint(0.42, 0.34, 0.24), (t) => [t * 0.4, 0, 0], true);
    const red = c === 0;
    const nl = lod === 2 ? 4 : lod ? 6 : 9;
    for (let k = 0; k < nl; k++) {
      const la = k * 2.39996 + r() * 0.3;
      const d = v3(Math.cos(la), 0, Math.sin(la));
      const len = 0.55 + r() * 0.3;
      const rise = 0.35 + r() * 0.35;
      const pts = curve(topP, topP.clone().addScaledVector(d, len * 0.4).add(v3(0, rise, 0)), topP.clone().addScaledVector(d, len).add(v3(0, rise * 0.4 - 0.15, 0)), lod ? 2 : 4);
      const cell = red ? CELL.ti : CELL.strap;
      const Lr = leafLayer(cell);
      b.ribbon(pts, (t) => 0.06 * Math.pow(Math.sin(Math.PI * Math.min(1, 0.04 + t)), 0.6), v3(-d.z, 0, d.x), (t) => grey(0.85 + t * 0.2), (t) => [0.4 + t * 0.6, 0.7, 0],
        { fold: 0.25, normalUp: 0.35, uv: (t, e) => { const [u, v] = cellUV(cell, t, 0.5 - e * 0.48); return [u, v, Lr, 0]; } });
    }
  }
  return b.build();
}

/** Shrub: short stems with a mound of leaf cards (biome-tinted in the shader). */
function shrub(lod: number, o: { seed: number; n: number; r: number; cell: Cell; far: Cell; under: THREE.Color; top: THREE.Color; flowers?: Cell; flowerN?: number; optFlowers?: boolean }): THREE.BufferGeometry {
  const b = new Builder();
  const r = rng(o.seed);
  const lobes: Lobe[] = [];
  for (let k = 0; k < o.n; k++) {
    const a = (k / o.n) * Math.PI * 2 + r();
    const d = k === 0 ? 0 : o.r * (0.5 + r() * 0.35);
    const rr = o.r * (k === 0 ? 1 : 0.65 + r() * 0.3);
    lobes.push({ x: Math.cos(a) * d, y: rr * 0.78, z: Math.sin(a) * d, r: rr, sq: 0.8 });
  }
  if (lod === 0) {
    for (let k = 0; k < 4; k++) {
      const a = r() * Math.PI * 2;
      b.tube([v3(0, -0.05, 0), v3(Math.cos(a) * o.r * 0.4, o.r * 0.7, Math.sin(a) * o.r * 0.4)], (t) => 0.035 * (1 - t * 0.5), 3, () => tint(0.4, 0.32, 0.24), () => [0, 0, 0], false);
    }
  }
  crown(b, lod, { lobes, cell: o.cell, far: o.far, cards: [12, 6, 4], size: 0.95, under: o.under, top: o.top, core: tint(0.04, 0.08, 0.03), coreR: 0.5, coreMin: o.r * 0.9, shell: [0.35, 0.85], flutter: 0.7 }, r);
  if (o.flowers && lod < 2) {
    const fc = o.flowers;
    const nf = Math.round((o.flowerN ?? 8) * (lod ? 0.5 : 1));
    for (let k = 0; k < nf; k++) {
      const L = lobes[k % lobes.length];
      const d = randDir(r, -0.1, 1);
      const p = v3(L.x + d.x * L.r * 1.0, L.y + d.y * L.r * L.sq * 1.0, L.z + d.z * L.r * 1.0);
      const face = d.clone().lerp(UP, 0.3).normalize();
      const [ax, ay] = basis(face, r() * 6.28);
      const s = o.r * (o.optFlowers ? 0.13 + r() * 0.05 : 0.32 + r() * 0.15);
      card(b, p, ax.multiplyScalar(s), ay.multiplyScalar(s), fc, () => face.clone().lerp(UP, 0.4).normalize(), () => grey(1), (q) => [Math.min(1, q.y / (o.r * 2)), 0.6, 0], o.optFlowers ? F_OPT : 0);
    }
  }
  return b.build();
}

function agave(lod: number): THREE.BufferGeometry {
  const b = new Builder();
  const r = rng(41);
  const n = lod ? 9 : 18;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 * 1.618 + r() * 0.2;
    const tilt = 0.25 + (k / n) * 0.95;
    const d = v3(Math.cos(a) * Math.sin(tilt), Math.cos(tilt), Math.sin(a) * Math.sin(tilt));
    const len = 0.75 + r() * 0.4;
    const tip = d.clone().multiplyScalar(len);
    const pts = curve(v3(0, 0.05, 0), tip.clone().multiplyScalar(0.5).add(v3(0, 0.12, 0)), tip.add(v3(0, 0.03, 0)), lod ? 2 : 5);
    b.ribbon(pts, (t) => 0.11 * Math.pow(1 - t, 0.8), v3(-Math.sin(a), 0, Math.cos(a)),
      (t, e) => lerpC(tint(0.38, 0.5, 0.46), tint(0.6, 0.66, 0.56), t * 0.4).lerp(tint(0.72, 0.66, 0.36), e * 0.35 * (1 - t)),
      (t) => [t * 0.3, 0, 0], { fold: -0.6, normalUp: 0.3 });
  }
  return b.build();
}

/** Grass tussock (taller accent clumps; the lawn itself is the GPU grass). */
function grassTuft(lod: number): THREE.BufferGeometry {
  const b = new Builder();
  const r = rng(51);
  const n = lod ? 9 : 22;
  for (let k = 0; k < n; k++) {
    const a = r() * Math.PI * 2;
    const off = v3(Math.cos(a) * r() * 0.16, 0, Math.sin(a) * r() * 0.16);
    const lean = v3(Math.cos(a), 0, Math.sin(a)).multiplyScalar(0.12 + r() * 0.3);
    const h = 0.45 + r() * 0.45;
    const w = 0.022 + r() * 0.014;
    const dry = r() < 0.15;
    const base = dry ? tint(0.24, 0.2, 0.1) : tint(0.07, 0.13, 0.035), tip = dry ? tint(0.5, 0.42, 0.22) : tint(0.24, 0.32, 0.1);
    const pts = curve(off, off.clone().addScaledVector(lean, 0.3).add(v3(0, h * 0.6, 0)), off.clone().add(lean).add(v3(0, h, 0)), lod ? 1 : 3);
    b.ribbon(pts, (t) => w * (1 - t * 0.9), v3(-Math.sin(a), 0, Math.cos(a)), (t) => lerpC(base, tip, t), (t) => [t, 0.3 + t * 0.6, 0], { normalUp: 0.6 });
  }
  return b.build();
}

/** Wildflowers: thin stems with painted flower heads (one species per clump half). */
function flowers(lod: number): THREE.BufferGeometry {
  const b = new Builder();
  const r = rng(61);
  const n = lod ? 4 : 8;
  const heads = [CELL.daisy, CELL.yellow, CELL.pink, CELL.daisy];
  for (let k = 0; k < n; k++) {
    const a = r() * Math.PI * 2;
    const base = v3(Math.cos(a) * r() * 0.28, 0, Math.sin(a) * r() * 0.28);
    const h = 0.22 + r() * 0.3;
    const topP = base.clone().add(v3((r() - 0.5) * 0.12, h, (r() - 0.5) * 0.12));
    b.tube([base, base.clone().lerp(topP, 0.5).add(v3(0.02, 0, 0)), topP], () => 0.008, 3, () => tint(0.25, 0.38, 0.14), (t) => [t, 0.4, 0], false);
    const face = v3((r() - 0.5) * 0.6, 1, (r() - 0.5) * 0.6).normalize();
    const [ax, ay] = basis(face, r() * 6.28);
    const s = 0.05 + r() * 0.03;
    const cell = heads[(k + (r() < 0.25 ? 1 : 0)) % 2 + (r() < 0.3 ? 2 : 0)];
    card(b, topP, ax.multiplyScalar(s), ay.multiplyScalar(s), cell, () => face.clone().lerp(UP, 0.5).normalize(), () => grey(1), () => [1, 0.6, 0], 0);
    if (!lod) {
      const la = r() * 6.28;
      b.ribbon([base.clone().add(v3(0, 0.03, 0)), base.clone().add(v3(Math.cos(la) * 0.1, 0.12, Math.sin(la) * 0.1))], (t) => 0.025 * Math.sin(Math.PI * t + 0.3), v3(-Math.sin(la), 0, Math.cos(la)), () => tint(0.24, 0.4, 0.16), (t) => [t * 0.5, 0.4, 0]);
    }
  }
  return b.build();
}

function reeds(lod: number): THREE.BufferGeometry {
  const b = new Builder();
  const r = rng(71);
  const n = lod ? 8 : 18;
  for (let k = 0; k < n; k++) {
    const a = r() * Math.PI * 2;
    const base = v3(Math.cos(a) * r() * 0.35, -0.1, Math.sin(a) * r() * 0.35);
    const h = 1.1 + r() * 0.8;
    const lean = v3(Math.cos(a), 0, Math.sin(a)).multiplyScalar(0.15 + r() * 0.25);
    const pts = [base, base.clone().addScaledVector(lean, 0.3).add(v3(0, h * 0.5, 0)), base.clone().add(lean).add(v3(0, h, 0))];
    b.ribbon(pts, (t) => 0.03 * (1 - t * 0.8), v3(-Math.sin(a), 0, Math.cos(a)), (t) => lerpC(tint(0.22, 0.34, 0.12), tint(0.55, 0.58, 0.3), t), (t) => [t, 0.4, 0], { normalUp: 0.6 });
    if (k % 5 === 0) {
      const tip = pts[2];
      b.tube([tip.clone().add(v3(0, -0.35, 0)), tip.clone().add(v3(0, -0.05, 0))], () => 0.04, 5, () => tint(0.3, 0.2, 0.12), () => [1, 0.2, 0]);
    }
  }
  return b.build();
}

function driftwood(lod: number): THREE.BufferGeometry {
  const b = new Builder();
  const pale = tint(0.82, 0.78, 0.7);
  const tex = { layer: BARK.furrow, around: 1, perMeter: 0.6 };
  b.tube(curve(v3(-1.3, 0.14, 0), v3(0, 0.26, 0.3), v3(1.3, 0.12, -0.1), lod ? 3 : 7), (t) => 0.16 * (1 - t * 0.4), lod ? 4 : 7, () => pale, () => [0, 0, 0], false, tex);
  if (!lod) b.tube([v3(0.3, 0.2, 0.2), v3(0.6, 0.45, 0.7), v3(0.7, 0.55, 1.0)], (t) => 0.07 * (1 - t * 0.6), 4, () => pale, () => [0, 0, 0], true, tex);
  return b.build();
}

function fallenLog(lod: number): THREE.BufferGeometry {
  const b = new Builder();
  const r = rng(111);
  const R = 0.34;
  const pts = curve(v3(-1.8, R * 0.8, 0.1), v3(0, R * 0.95, -0.25), v3(1.7, R * 0.75, 0.15), lod === 2 ? 1 : lod ? 3 : 7);
  const bark = (_t: number, a: number) => lerpC(tint(0.5, 0.42, 0.34), tint(0.36, 0.44, 0.2), Math.max(0, Math.sin(a) + 0.15) * 0.9);
  b.tube(pts, (t) => R * (1 - t * 0.2), lod === 2 ? 5 : lod ? 6 : 10, bark, () => [0, 0, 0], false, { layer: BARK.furrow, around: 2, perMeter: 0.7 });
  if (lod < 2) {
    for (const [pi, sgn] of [[0, -1], [pts.length - 1, 1]] as [number, number][]) {
      const c = pts[pi], tn = pts[Math.min(pts.length - 1, Math.max(0, pi - sgn))].clone().sub(c).normalize().negate();
      const rr = R * (pi ? 0.8 : 1);
      const sideV = new THREE.Vector3().crossVectors(tn, UP).normalize(), bin = new THREE.Vector3().crossVectors(sideV, tn).normalize();
      const ctr = b.vertex(c.clone().addScaledVector(tn, 0.04), tn, tint(0.62, 0.5, 0.34), [0, 0, 0]);
      const ring: number[] = [];
      const k = lod ? 6 : 9;
      for (let e = 0; e <= k; e++) {
        const a = (e / k) * Math.PI * 2;
        const jag = lod ? 0 : (e % 2 ? 0.06 : -0.01) * (1 + r());
        ring.push(b.vertex(c.clone().addScaledVector(sideV, Math.cos(a) * rr).addScaledVector(bin, Math.sin(a) * rr).addScaledVector(tn, jag), tn, tint(0.5, 0.4, 0.27), [0, 0, 0]));
      }
      for (let e = 0; e < k; e++) { if (sgn > 0) b.tri(ctr, ring[e], ring[e + 1]); else b.tri(ctr, ring[e + 1], ring[e]); }
    }
  }
  if (!lod) {
    for (let k = 0; k < 4; k++) {
      const t = 0.2 + r() * 0.6;
      const p = pts[Math.round(t * (pts.length - 1))].clone().add(v3(0, -0.02 + r() * 0.12, (R + 0.05) * (k % 2 ? 1 : -1)));
      const g = new THREE.IcosahedronGeometry(1, 0);
      b.add(g, new THREE.Matrix4().compose(p, new THREE.Quaternion(), v3(0.14 + r() * 0.05, 0.035, 0.11)), (_p, n) => lerpC(tint(0.55, 0.38, 0.2), tint(0.82, 0.7, 0.5), n.y * 0.5 + 0.5), [0, 0, 0]);
      g.dispose();
    }
    // fern sprigs growing off it
    for (let k = 0; k < 3; k++) {
      const a = r() * Math.PI * 2;
      const s = pts[2 + k * 2].clone().add(v3(0, R * 0.7, 0));
      const d = v3(Math.cos(a), 0, Math.sin(a));
      frond(b, curve(s, s.clone().addScaledVector(d, 0.2).add(v3(0, 0.35, 0)), s.clone().addScaledVector(d, 0.55).add(v3(0, 0.12, 0)), 3), {
        cell: CELL.fern, width: (t) => 0.1 * Math.sin(Math.PI * Math.min(1, t + 0.05)), droop: () => 0.2, across: 1,
        color: () => grey(0.9), wind: (t) => [t, 0.8, 0], up: 0.45,
      });
    }
  }
  return b.build();
}

function mangrove(lod: number): THREE.BufferGeometry {
  const r = rng(81);
  const lobes: Lobe[] = [{ x: 0, y: 4.8, z: 0, r: 1.8, sq: 0.7 }, { x: 1.4, y: 4.4, z: 0.6, r: 1.3, sq: 0.7 }, { x: -1.2, y: 4.3, z: -0.5, r: 1.4, sq: 0.7 }, { x: 0.3, y: 4.2, z: -1.4, r: 1.2, sq: 0.7 }, { x: -0.4, y: 4.5, z: 1.4, r: 1.2, sq: 0.7 }];
  const g = tree(lod, {
    seed: 81, trunkH: 3.6, trunkR: 0.2, leanX: 0.15, bark: 0x6a5a48, barkTex: BARK.furrow, barkRep: 0.9,
    crown: { lobes, cell: CELL.small, far: CELL.denseBroad, cards: [10, 5, 3], size: 0.8, under: tint(0.62, 0.7, 0.6), top: tint(1.0, 1.05, 0.9), core: tint(0.08, 0.15, 0.06), flutter: 0.5 },
    limbs: [4, 2, 0], twigs: 2,
  });
  // prop roots arching into the water
  const b = new Builder();
  const bark = () => tint(0.2, 0.16, 0.12);
  const roots = lod === 2 ? 3 : lod ? 5 : 9;
  for (let k = 0; k < roots; k++) {
    const a = (k / roots) * Math.PI * 2 + r() * 0.3;
    const d = v3(Math.cos(a), 0, Math.sin(a));
    const s = v3(0, 1.0 + r() * 0.9, 0);
    const e = d.clone().multiplyScalar(1.3 + r() * 1.2).add(v3(0, -0.3, 0));
    b.tube(curve(s, s.clone().addScaledVector(d, 0.9).add(v3(0, 0.6, 0)), e, lod ? 3 : 6), (t) => 0.09 * (1 - t * 0.4), lod ? 3 : 4, bark, () => [0, 0, 0], false, { layer: BARK.furrow, around: 1, perMeter: 1 });
  }
  return merge(g, b.build());
}

function merge(a: THREE.BufferGeometry, b: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = new Builder();
  for (const g of [a, b]) {
    const base = out.pos.length / 3;
    const names = ["position", "normal", "color", "wind", "tuv"] as const;
    const arrs = names.map((n) => g.getAttribute(n).array as Float32Array);
    out.pos.push(...arrs[0]); out.nrm.push(...arrs[1]); out.col.push(...arrs[2]); out.wind.push(...arrs[3]); out.tuv.push(...arrs[4]);
    const idx = g.getIndex()!.array;
    for (let i = 0; i < idx.length; i++) out.idx.push(base + idx[i]);
    g.dispose();
  }
  return out.build();
}

function cypress(lod: number): THREE.BufferGeometry {
  const b = new Builder();
  const r = rng(19);
  const H = 9.5, R = 1.2;
  b.tube([v3(0, -0.2, 0), v3(0, 1.4, 0)], () => 0.26, 6, () => tint(0.46, 0.38, 0.32), () => [0, 0, 0], false, { layer: BARK.pine, around: 1, perMeter: 0.8 });
  const prof = (t: number) => R * Math.pow(Math.sin(Math.PI * Math.min(1, t * 0.92 + 0.08)), 0.7) * (1 - t * 0.35);
  // dark columnar core
  const rows = lod === 2 ? 5 : lod ? 7 : 12;
  const g = new THREE.LatheGeometry(Array.from({ length: rows }, (_, i) => { const t = i / (rows - 1); return new THREE.Vector2(Math.max(0.001, prof(t) * 0.72), 0.9 + t * (H - 0.9)); }), lod === 2 ? 5 : lod ? 6 : 9);
  b.add(g, new THREE.Matrix4(), (p) => tint(0.07, 0.12, 0.06).multiplyScalar(0.8 + 0.5 * (p.y / H)), (p) => [Math.min(1, p.y / H), 0.2, 0], { sphereCenter: v3(0, H * 0.45, 0), sphereBlend: 0.3 });
  g.dispose();
  // scale-foliage cards around the column, facing out and up
  const n = lod === 2 ? 14 : lod ? 30 : 70;
  const cell = lod === 0 ? CELL.scale : CELL.denseNeedle;
  for (let k = 0; k < n; k++) {
    const t = Math.pow(r(), 0.85);
    const y = 1.0 + t * (H - 1.4);
    const a = r() * Math.PI * 2;
    const rad = prof((y - 0.9) / (H - 0.9)) * (0.75 + r() * 0.3);
    const p = v3(Math.cos(a) * rad, y, Math.sin(a) * rad);
    const face = v3(Math.cos(a), 0.35 + r() * 0.4, Math.sin(a)).normalize();
    const [ax, ay] = basis(face, r() * 6.28);
    const s = (lod === 0 ? 0.75 : lod === 1 ? 1.0 : 1.3) * (0.8 + r() * 0.4) * (0.6 + 0.4 * (1 - t));
    card(b, p, ax.multiplyScalar(s), ay.multiplyScalar(s * 1.2), cell, (q) => v3(q.x / R, (q.y - H * 0.45) / (H * 0.6) + 0.2, q.z / R).normalize(), (q) => lerpC(tint(0.62, 0.66, 0.58), tint(1.0, 1.0, 0.92), q.y / H), (q) => [Math.min(1, q.y / H), 0.3, 0]);
  }
  return b.build();
}

// --------------------------------------------------------------- catalog
export interface PlantModel { lod0: THREE.BufferGeometry; lod1: THREE.BufferGeometry; lod2: THREE.BufferGeometry; height: number; radius: number }

const pineLobes: Lobe[] = (() => {
  const r = rng(17);
  const out: Lobe[] = [];
  const tiers = [[8.0, 3.0, 4], [9.6, 2.6, 4], [11.1, 2.0, 3], [12.5, 1.1, 2]] as const;
  let a0 = 0.4;
  for (const [y, R, n] of tiers) {
    for (let k = 0; k < n; k++) {
      if (r() < 0.2) continue;
      const a = a0 + (k / n) * Math.PI * 2 + (r() - 0.5) * 1.0;
      const lean = (y / 13) * 1.3;
      out.push({ x: lean + Math.cos(a) * R * (0.55 + r() * 0.45), y: y + (r() - 0.5) * 0.9, z: lean * 0.3 + Math.sin(a) * R * (0.55 + r() * 0.45), r: 1.1 + r() * 0.6 + (R > 2.5 ? 0.25 : 0), sq: 0.5 + r() * 0.12 });
    }
    a0 += 1.1;
  }
  return out;
})();

/** Builders keyed by name; models.ts maps PropKinds to these. */
export const PLANTS = {
  palm: (l: number) => palm(l, 0.12),
  palmLeaning: (l: number) => palm(l, 0.55),
  // rainforest canopy tree (kukui / mango / albizia): tall clean trunk, broad irregular crown
  broadleaf: (l: number) => tree(l, {
    seed: 3, trunkH: 8.4, trunkR: 0.45, leanX: 0.3, leanZ: 0.1, bark: 0x8c7f70, barkTex: BARK.smooth, barkRep: 1.6, fins: 4, finReach: 1.6, finH: 2.2,
    moss: 0.4, lianas: 3, lianaLen: [2.5, 6],
    crown: {
      lobes: [...ringCrown(4, 8, 10.0, 5.0, 2.1, 3.0, 0.7, 1.3, { r: 3.1, dy: 1.6 }, 0.3, 0.1), ...ringCrown(5, 2, 12.3, 2.0, 1.9, 2.2, 0.75, 0.4, { r: 0, dy: 0 }, 0.3, 0.1)],
      cell: CELL.broad, far: CELL.denseBroad, cards: [9, 5, 4], size: 0.66, under: tint(0.6, 0.66, 0.6), top: tint(1.05, 1.06, 0.92), core: tint(0.07, 0.13, 0.05), flatBottom: 0.35,
    },
  }),
  // emergent monkeypod / banyan: buttresses, aerial roots, wide flat umbrella crown of fine leaflets
  jungleGiant: (l: number) => tree(l, {
    seed: 7, trunkH: 15, trunkR: 0.9, leanX: -0.6, leanZ: 0.4, bend: 0.5, bark: 0x9a8c7a, barkTex: BARK.smooth, barkRep: 2.2, fins: 6, finReach: 3.6, finH: 4.6,
    moss: 0.6, lianas: 10, lianaLen: [6, 13], limbs: [7, 4, 2], twigs: 3,
    crown: {
      lobes: [...ringCrown(8, 9, 18.0, 7.2, 2.8, 3.6, 0.55, 0.9, { r: 3.8, dy: 1.2 }, -0.6, 0.4), ...ringCrown(9, 4, 20.2, 3.6, 2.3, 2.8, 0.6, 0.5, { r: 0, dy: 0 }, -0.6, 0.4)],
      cell: CELL.fine, far: CELL.denseBroad, cards: [10, 5, 4], size: 0.66, under: tint(0.62, 0.68, 0.6), top: tint(1.08, 1.06, 0.9), core: tint(0.07, 0.13, 0.05), flatBottom: 0.5, upFacing: 0.3,
    },
  }),
  holmOak: (l: number) => tree(l, {
    seed: 12, trunkH: 3.3, trunkR: 0.38, leanX: 0.35, leanZ: -0.2, bend: 0.6, bark: 0x7a6e60, barkTex: BARK.furrow, barkRep: 1.1, moss: 0.2,
    crown: {
      lobes: [...ringCrown(13, 7, 5.9, 3.3, 1.5, 2.0, 0.74, 0.5, { r: 2.4, dy: 1.2 }, 0.35, -0.2), ...ringCrown(14, 3, 7.5, 1.7, 1.3, 1.6, 0.8, 0.3, { r: 0, dy: 0 }, 0.35, -0.2)],
      cell: CELL.small, far: CELL.denseBroad, cards: [10, 6, 4], size: 0.78, under: tint(0.6, 0.66, 0.58), top: tint(0.96, 1.0, 0.84), core: tint(0.06, 0.1, 0.05), flatBottom: 0.4,
    },
  }),
  pine: (l: number) => tree(l, {
    seed: 19, trunkH: 7.4, trunkR: 0.3, leanX: 0.75, leanZ: 0.2, bend: 0.8, leader: 12.4, bark: 0x9a7a66, barkTex: BARK.pine, barkRep: 1.0,
    crown: { lobes: pineLobes, cell: CELL.needles, far: CELL.denseNeedle, cards: [8, 4, 3], size: 0.88, under: tint(0.62, 0.66, 0.6), top: tint(1.0, 1.0, 0.9), core: tint(0.06, 0.1, 0.05), upFacing: 0.45, flatBottom: 0.7 },
  }),
  // stone pine: bare forked trunk, flat umbrella canopy of needle pads
  umbrellaPine: (l: number) => tree(l, {
    seed: 5, trunkH: 5.4, trunkR: 0.3, leanX: 0.5, leanZ: 0.2, bend: 0.5, bark: 0x9a7866, barkTex: BARK.pine, barkRep: 1.0, limbs: [6, 4, 2], twigs: 2,
    crown: {
      lobes: [{ x: 0.5, y: 7.6, z: 0.2, r: 3.0, sq: 0.36 }, { x: 3.0, y: 7.2, z: 1.1, r: 2.3, sq: 0.4 }, { x: -2.1, y: 7.3, z: -0.8, r: 2.4, sq: 0.4 }, { x: 1.3, y: 7.1, z: -2.4, r: 2.2, sq: 0.4 }, { x: -0.4, y: 7.0, z: 2.7, r: 2.1, sq: 0.4 }, { x: 2.6, y: 7.5, z: -1.0, r: 1.8, sq: 0.4 }],
      cell: CELL.needles, far: CELL.denseNeedle, cards: [12, 6, 4], size: 0.68, under: tint(0.62, 0.68, 0.6), top: tint(1.02, 1.04, 0.9), core: tint(0.06, 0.11, 0.05), upFacing: 0.7, flatBottom: 0.8, shell: [0.4, 0.9],
    },
  }),
  olive: (l: number) => tree(l, {
    seed: 9, trunkH: 1.8, trunkR: 0.26, leanX: 0.3, leanZ: 0.15, bend: 1.2, bark: 0x8a8274, barkTex: BARK.furrow, barkRep: 0.8, limbs: [5, 3, 0], twigs: 2,
    crown: {
      lobes: [{ x: 0, y: 3.0, z: 0, r: 1.4, sq: 0.7 }, { x: 1.2, y: 2.6, z: 0.4, r: 1.0, sq: 0.7 }, { x: -1.1, y: 2.7, z: -0.3, r: 1.05, sq: 0.7 }, { x: 0.2, y: 2.5, z: 1.1, r: 0.9, sq: 0.7 }, { x: -0.2, y: 3.7, z: -0.4, r: 0.8, sq: 0.8 }],
      cell: CELL.olive, far: CELL.denseBroad, cards: [12, 6, 3], size: 0.85, under: tint(0.55, 0.58, 0.52), top: tint(0.85, 0.86, 0.8), core: tint(0.08, 0.1, 0.06), shell: [0.4, 1.0],
    },
  }),
  lemon: (l: number) => {
    const g = tree(l, {
      seed: 13, trunkH: 1.3, trunkR: 0.13, bark: 0x7a6a5a, barkTex: BARK.furrow, barkRep: 0.7, limbs: [3, 2, 0], twigs: 1,
      crown: {
        lobes: [{ x: 0, y: 2.2, z: 0, r: 1.15, sq: 0.9 }, { x: 0.7, y: 1.9, z: 0.3, r: 0.8, sq: 0.9 }, { x: -0.6, y: 2.0, z: -0.3, r: 0.8, sq: 0.9 }],
        cell: CELL.small, far: CELL.denseBroad, cards: [14, 7, 4], size: 0.8, under: tint(0.55, 0.62, 0.52), top: tint(0.95, 1.0, 0.85), core: tint(0.05, 0.11, 0.04),
      },
    });
    if (l === 2) return g;
    const b = new Builder();
    const r = rng(14);
    const lobes = [[0, 2.2, 0, 1.15], [0.7, 1.9, 0.3, 0.8], [-0.6, 2.0, -0.3, 0.8]];
    for (let k = 0; k < (l ? 8 : 16); k++) {
      const L = lobes[k % 3];
      const d = randDir(r, -0.6, 0.5);
      const p = v3(L[0] + d.x * L[3] * 0.85, L[1] + d.y * L[3] * 0.8, L[2] + d.z * L[3] * 0.85);
      const og = l ? new THREE.OctahedronGeometry(1, 0) : new THREE.IcosahedronGeometry(1, 0);
      b.add(og, new THREE.Matrix4().compose(p, new THREE.Quaternion(), v3(0.09, 0.11, 0.09)), tint(0.95, 0.75, 0.08), [0.6, 0.3, 0]);
      og.dispose();
    }
    return merge(g, b.build());
  },
  mangrove,
  banana,
  fern,
  treeFern,
  understory,
  tiPlant,
  // hibiscus flowers show on some bushes on Pacific islands (shader uFlowers)
  bush: (l: number) => shrub(l, { seed: 17, n: 4, r: 0.8, cell: CELL.small, far: CELL.denseBroad, under: tint(0.6, 0.66, 0.58), top: tint(1.05, 1.08, 0.92), flowers: CELL.hibiscus, flowerN: 7, optFlowers: true }),
  bougainvillea: (l: number) => shrub(l, { seed: 19, n: 5, r: 1.05, cell: CELL.bougain, far: CELL.bougain, under: tint(0.68, 0.7, 0.68), top: tint(1.05, 1.05, 1.0), flowers: CELL.hibiscus, flowerN: 0 }),
  agave,
  grassTuft,
  flowers,
  reeds,
  driftwood,
  log: fallenLog,
  cypress,
};
