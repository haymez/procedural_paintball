// Tiny mesh builder for procedural props. Every vertex carries position,
// normal, color (linear) and wind = (sway, flutter, tintMask):
//   sway    0 at the base .. 1 at the tip (bends with the wind)
//   flutter leaf-level jitter amount
//   tint    1 = recolored per instance (flower petals)
import * as THREE from "three";

export type Wind = [number, number, number];

export class Builder {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  wind: number[] = [];
  idx: number[] = [];

  vertex(p: THREE.Vector3, n: THREE.Vector3, c: THREE.Color, w: Wind): number {
    const i = this.pos.length / 3;
    this.pos.push(p.x, p.y, p.z);
    this.nrm.push(n.x, n.y, n.z);
    this.col.push(c.r, c.g, c.b);
    this.wind.push(w[0], w[1], w[2]);
    return i;
  }

  tri(a: number, b: number, c: number) { this.idx.push(a, b, c); }
  quad(a: number, b: number, c: number, d: number) { this.idx.push(a, b, c, a, c, d); }

  /**
   * Append a three.js geometry transformed by m.
   * color/wind may be functions of the transformed position and normal.
   * sphereCenter: blend normals toward "puffy" spherical normals (canopies).
   */
  add(
    geo: THREE.BufferGeometry,
    m: THREE.Matrix4,
    color: THREE.Color | ((p: THREE.Vector3, n: THREE.Vector3) => THREE.Color),
    wind: Wind | ((p: THREE.Vector3) => Wind),
    opts: { sphereCenter?: THREE.Vector3; sphereBlend?: number; displace?: (p: THREE.Vector3, n: THREE.Vector3) => number } = {},
  ) {
    const g = geo.index ? geo : geo;
    const pa = g.getAttribute("position") as THREE.BufferAttribute;
    const na = g.getAttribute("normal") as THREE.BufferAttribute;
    const nm = new THREE.Matrix3().getNormalMatrix(m);
    const base = this.pos.length / 3;
    const p = new THREE.Vector3(), n = new THREE.Vector3(), s = new THREE.Vector3();
    for (let i = 0; i < pa.count; i++) {
      p.fromBufferAttribute(pa, i);
      n.fromBufferAttribute(na, i);
      if (opts.displace) p.addScaledVector(n, opts.displace(p, n));
      p.applyMatrix4(m);
      n.applyMatrix3(nm).normalize();
      if (opts.sphereCenter) {
        s.copy(p).sub(opts.sphereCenter).normalize();
        n.lerp(s, opts.sphereBlend ?? 0.7).normalize();
      }
      const c = typeof color === "function" ? color(p, n) : color;
      const w = typeof wind === "function" ? wind(p) : wind;
      this.vertex(p, n, c, w);
    }
    if (g.index) {
      const ia = g.index;
      for (let i = 0; i < ia.count; i++) this.idx.push(base + ia.getX(i));
    } else {
      for (let i = 0; i < pa.count; i++) this.idx.push(base + i);
    }
  }

  /**
   * Tapered tube along a polyline. radius(t) and color(t) with t in 0..1.
   */
  tube(points: THREE.Vector3[], radius: (t: number) => number, sides: number, color: (t: number, a: number) => THREE.Color, wind: (t: number, p: THREE.Vector3) => Wind, capTop = true) {
    const rings: number[][] = [];
    const up = new THREE.Vector3(0, 1, 0);
    const tan = new THREE.Vector3(), side = new THREE.Vector3(), bin = new THREE.Vector3(), p = new THREE.Vector3(), n = new THREE.Vector3();
    for (let i = 0; i < points.length; i++) {
      const t = i / (points.length - 1);
      const a = points[Math.max(0, i - 1)], b = points[Math.min(points.length - 1, i + 1)];
      tan.subVectors(b, a).normalize();
      side.crossVectors(tan, Math.abs(tan.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : up).normalize();
      bin.crossVectors(side, tan).normalize();
      const r = radius(t);
      const ring: number[] = [];
      for (let k = 0; k <= sides; k++) {
        const ang = (k / sides) * Math.PI * 2;
        n.copy(side).multiplyScalar(Math.cos(ang)).addScaledVector(bin, Math.sin(ang));
        p.copy(points[i]).addScaledVector(n, r);
        ring.push(this.vertex(p, n, color(t, ang), wind(t, points[i])));
      }
      rings.push(ring);
    }
    for (let i = 0; i < rings.length - 1; i++) {
      for (let k = 0; k < sides; k++) {
        this.quad(rings[i][k], rings[i][k + 1], rings[i + 1][k + 1], rings[i + 1][k]);
      }
    }
    if (capTop) {
      const last = points[points.length - 1];
      const c = this.vertex(last, tan.clone(), color(1, 0), wind(1, last));
      const r = rings[rings.length - 1];
      for (let k = 0; k < sides; k++) this.tri(r[k], r[k + 1], c);
    }
  }

  /**
   * Ribbon along a curve (leaves, fronds, blades). width(t) half-width,
   * sideDir(t) lateral axis, fold lifts/drops the edges (V-shaped leaves).
   * serrate > 0 alternates edge width to make comb-like palm leaflets.
   */
  ribbon(
    points: THREE.Vector3[],
    width: (t: number) => number,
    lateral: THREE.Vector3,
    color: (t: number, edge: number) => THREE.Color,
    wind: (t: number) => Wind,
    opts: { fold?: number; serrate?: number; normalUp?: number } = {},
  ) {
    const fold = opts.fold ?? 0;
    const serr = opts.serrate ?? 0;
    const tan = new THREE.Vector3(), nrm = new THREE.Vector3(), lat = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    let prev: number[] | null = null;
    for (let i = 0; i < points.length; i++) {
      const t = i / (points.length - 1);
      const a = points[Math.max(0, i - 1)], b = points[Math.min(points.length - 1, i + 1)];
      tan.subVectors(b, a).normalize();
      lat.copy(lateral).addScaledVector(tan, -lateral.dot(tan)).normalize();
      nrm.crossVectors(lat, tan).normalize();
      if (nrm.y < 0) nrm.negate();
      if (opts.normalUp) nrm.lerp(up, opts.normalUp).normalize();
      let w = width(t);
      if (serr > 0 && i % 2 === 1) w *= 1 - serr;
      const c = points[i];
      const L = c.clone().addScaledVector(lat, -w).addScaledVector(nrm, -fold * w);
      const R = c.clone().addScaledVector(lat, w).addScaledVector(nrm, -fold * w);
      const wv = wind(t);
      const cur = [
        this.vertex(L, nrm, color(t, 1), wv),
        this.vertex(c.clone(), nrm, color(t, 0), wv),
        this.vertex(R, nrm, color(t, 1), wv),
      ];
      if (prev) {
        this.quad(prev[0], cur[0], cur[1], prev[1]);
        this.quad(prev[1], cur[1], cur[2], prev[2]);
      }
      prev = cur;
    }
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute("wind", new THREE.Float32BufferAttribute(this.wind, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

/** Deterministic RNG for model building. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const col = (hex: number) => new THREE.Color(hex);
export const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** smooth 3D value-ish noise for displacing blobs (cheap, deterministic) */
export function wobble(p: THREE.Vector3, f: number, seed = 0): number {
  return Math.sin(p.x * f + seed) * Math.sin(p.y * f * 1.3 + seed * 2.1) * Math.sin(p.z * f * 0.9 + seed * 0.7);
}
