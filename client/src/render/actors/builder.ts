// Tiny mesh-merging helper for actors: bake many primitive geometries into ONE
// BufferGeometry with vertex colors (and optionally skin weights + blob "part"
// masks) so each actor is 1 draw call.
import * as THREE from "three";

export interface PartOpts {
  /** Fixed vertex color (sRGB hex or THREE.Color). */
  color?: THREE.ColorRepresentation;
  /** Per-vertex color override (p, n are in final/bind space). */
  colorFn?: (p: THREE.Vector3, n: THREE.Vector3, out: THREE.Color) => void;
  /** Local transform applied before merging. */
  matrix?: THREE.Matrix4;
  /** Skinned builders: a single bone for every vertex… */
  bone?: number;
  /** …or a per-vertex weight function filling [i0, w0, i1, w1]. */
  skin?: (p: THREE.Vector3, out: [number, number, number, number]) => void;
  /** Blob parts: weight of body color, crest color, belly tint, paint mask. */
  part?: [number, number, number, number] | ((p: THREE.Vector3, n: THREE.Vector3) => [number, number, number, number]);
  /** Flip triangle winding + normals (inner shells). */
  flip?: boolean;
  /** Optional per-vertex float attribute (e.g. FX kind) */
  extra?: number;
}

const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _c = new THREE.Color();
const _nm = new THREE.Matrix3();

export class MeshBuilder {
  private pos: number[] = [];
  private nor: number[] = [];
  private col: number[] = [];
  private idx: number[] = [];
  private si: number[] = [];
  private sw: number[] = [];
  private prt: number[] = [];
  private ext: number[] = [];
  private skinned: boolean;
  private parts: boolean;
  private extras: boolean;

  constructor(opts: { skinned?: boolean; parts?: boolean; extras?: boolean } = {}) {
    this.skinned = !!opts.skinned;
    this.parts = !!opts.parts;
    this.extras = !!opts.extras;
  }

  /** Number of vertices so far (useful for picking sample points). */
  get vertexCount(): number {
    return this.pos.length / 3;
  }

  add(src: THREE.BufferGeometry, o: PartOpts = {}): this {
    const g = src.index ? src : src;
    const P = g.getAttribute("position") as THREE.BufferAttribute;
    let N = g.getAttribute("normal") as THREE.BufferAttribute | undefined;
    if (!N) {
      g.computeVertexNormals();
      N = g.getAttribute("normal") as THREE.BufferAttribute;
    }
    const m = o.matrix;
    if (m) _nm.getNormalMatrix(m);
    const base = this.pos.length / 3;
    const fixed = new THREE.Color(o.color ?? 0xffffff);
    const w: [number, number, number, number] = [0, 1, 0, 0];
    for (let i = 0; i < P.count; i++) {
      _p.fromBufferAttribute(P, i);
      _n.fromBufferAttribute(N, i);
      if (m) {
        _p.applyMatrix4(m);
        _n.applyMatrix3(_nm).normalize();
      }
      if (o.flip) _n.negate();
      this.pos.push(_p.x, _p.y, _p.z);
      this.nor.push(_n.x, _n.y, _n.z);
      _c.copy(fixed);
      if (o.colorFn) o.colorFn(_p, _n, _c);
      this.col.push(_c.r, _c.g, _c.b);
      if (this.skinned) {
        if (o.skin) {
          w[0] = 0; w[1] = 1; w[2] = 0; w[3] = 0;
          o.skin(_p, w);
          this.si.push(w[0], w[2], 0, 0);
          this.sw.push(w[1], w[3], 0, 0);
        } else {
          this.si.push(o.bone ?? 0, 0, 0, 0);
          this.sw.push(1, 0, 0, 0);
        }
      }
      if (this.parts) {
        const pp = typeof o.part === "function" ? o.part(_p, _n) : (o.part ?? [0, 0, 0, 0]);
        this.prt.push(pp[0], pp[1], pp[2], pp[3]);
      }
      if (this.extras) this.ext.push(o.extra ?? 0);
    }
    if (g.index) {
      const I = g.index;
      for (let i = 0; i < I.count; i += 3) {
        const a = I.getX(i), b = I.getX(i + 1), c = I.getX(i + 2);
        if (o.flip) this.idx.push(base + a, base + c, base + b);
        else this.idx.push(base + a, base + b, base + c);
      }
    } else {
      for (let i = 0; i < P.count; i += 3) {
        if (o.flip) this.idx.push(base + i, base + i + 2, base + i + 1);
        else this.idx.push(base + i, base + i + 1, base + i + 2);
      }
    }
    return this;
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    if (this.skinned) {
      g.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(this.si, 4));
      g.setAttribute("skinWeight", new THREE.Float32BufferAttribute(this.sw, 4));
    }
    if (this.parts) g.setAttribute("aPart", new THREE.Float32BufferAttribute(this.prt, 4));
    if (this.extras) g.setAttribute("aExtra", new THREE.Float32BufferAttribute(this.ext, 1));
    const n = this.pos.length / 3;
    g.setIndex(n > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

// ---------------------------------------------------------------------------
// Small math helpers shared by actors.

export const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
/** Frame-rate independent exponential approach factor. */
export const damp = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);

/** Compose a matrix from translation, euler (XYZ) and scale. */
export function mat(
  x = 0, y = 0, z = 0,
  rx = 0, ry = 0, rz = 0,
  sx = 1, sy = sx, sz = sx,
): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(sx, sy, sz),
  );
}

/** Damped spring (semi-implicit Euler, sub-stepped for stability). */
export class Spring {
  x: number;
  v = 0;
  target: number;
  constructor(public k: number, public c: number, x0 = 0) {
    this.x = x0;
    this.target = x0;
  }
  step(dt: number): number {
    const n = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      this.v += (-this.k * (this.x - this.target) - this.c * this.v) * h;
      this.x += this.v * h;
    }
    return this.x;
  }
}

/** Deterministic tiny PRNG for cosmetic variety. */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    s ^= s >>> 12;
    return (s >>> 0) / 4294967296;
  };
}
