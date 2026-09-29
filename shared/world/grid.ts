// Grid helpers shared by the generator stages and the collision code.
import { CELL, GRID_RES, WORLD_HALF } from "./types";

export const N = GRID_RES;
export const NN = GRID_RES * GRID_RES;
export const INV_CELL = 1 / CELL;

export function gx(ix: number): number {
  return -WORLD_HALF + ix * CELL;
}
/** Continuous grid coordinate of world x (or z). */
export function toG(x: number): number {
  return (x + WORLD_HALF) * INV_CELL;
}
/** Nearest grid index of world x (or z), clamped. */
export function toI(x: number): number {
  const i = Math.round((x + WORLD_HALF) * INV_CELL);
  return i < 0 ? 0 : i >= N ? N - 1 : i;
}
export function cellIndex(x: number, z: number): number {
  return toI(z) * N + toI(x);
}

/** Bilinear sample of a scalar grid at world (x, z), clamped to the grid. */
export function sample(a: ArrayLike<number>, x: number, z: number): number {
  let fx = (x + WORLD_HALF) * INV_CELL;
  let fz = (z + WORLD_HALF) * INV_CELL;
  if (fx < 0) fx = 0;
  else if (fx > N - 1.000001) fx = N - 1.000001;
  if (fz < 0) fz = 0;
  else if (fz > N - 1.000001) fz = N - 1.000001;
  const ix = Math.floor(fx), iz = Math.floor(fz);
  const tx = fx - ix, tz = fz - iz;
  const i = iz * N + ix;
  const a00 = a[i], a10 = a[i + 1], a01 = a[i + N], a11 = a[i + N + 1];
  return (a00 + (a10 - a00) * tx) * (1 - tz) + (a01 + (a11 - a01) * tx) * tz;
}

/** Gradient magnitude (rise over run) at a grid cell via central differences. */
export function slopeAt(h: ArrayLike<number>, ix: number, iz: number): number {
  const x0 = ix > 0 ? ix - 1 : ix, x1 = ix < N - 1 ? ix + 1 : ix;
  const z0 = iz > 0 ? iz - 1 : iz, z1 = iz < N - 1 ? iz + 1 : iz;
  const dx = (h[iz * N + x1] - h[iz * N + x0]) / ((x1 - x0) * CELL);
  const dz = (h[z1 * N + ix] - h[z0 * N + ix]) / ((z1 - z0) * CELL);
  return Math.sqrt(dx * dx + dz * dz);
}

/** Slope magnitude grid. */
export function slopeGrid(h: Float32Array, out: Float32Array = new Float32Array(NN)): Float32Array {
  for (let iz = 0; iz < N; iz++) for (let ix = 0; ix < N; ix++) out[iz * N + ix] = slopeAt(h, ix, iz);
  return out;
}

/**
 * Exact Euclidean distance transform (Felzenszwalb–Huttenlocher), in cells.
 * Input: mask (1 = feature). Output: distance from each cell to the nearest feature cell.
 */
export function edt(
  mask: Uint8Array, w: number, hgt: number, out: Float32Array = new Float32Array(w * hgt), nearest?: Int32Array,
): Float32Array {
  const INF = 1e20;
  const n = w > hgt ? w : hgt;
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const arg = new Int32Array(n);
  const v = new Int32Array(n);
  const zz = new Float64Array(n + 1);
  const tmp = new Float64Array(w * hgt);
  const nearRow = nearest ? new Int32Array(w * hgt) : null;
  for (let i = 0; i < w * hgt; i++) tmp[i] = mask[i] ? 0 : INF;
  const pass = (len: number) => {
    let k = 0;
    v[0] = 0;
    zz[0] = -INF;
    zz[1] = INF;
    for (let q = 1; q < len; q++) {
      let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= zz[k]) {
        k--;
        s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      zz[k] = s;
      zz[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (zz[k + 1] < q) k++;
      const dq = q - v[k];
      d[q] = dq * dq + f[v[k]];
      arg[q] = v[k];
    }
  };
  // columns
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < hgt; y++) f[y] = tmp[y * w + x];
    pass(hgt);
    for (let y = 0; y < hgt; y++) {
      tmp[y * w + x] = d[y];
      if (nearRow) nearRow[y * w + x] = arg[y];
    }
  }
  // rows
  for (let y = 0; y < hgt; y++) {
    for (let x = 0; x < w; x++) f[x] = tmp[y * w + x];
    pass(w);
    for (let x = 0; x < w; x++) {
      out[y * w + x] = Math.sqrt(d[x]);
      if (nearest && nearRow) {
        const cx = arg[x];
        nearest[y * w + x] = nearRow[y * w + cx] * w + cx;
      }
    }
  }
  return out;
}

/** Separable box blur of a float grid (radius in cells). */
export function boxBlur(src: Float32Array, w: number, hgt: number, r: number, out: Float32Array = new Float32Array(w * hgt)): Float32Array {
  const tmp = new Float32Array(w * hgt);
  const inv = 1 / (2 * r + 1);
  for (let y = 0; y < hgt; y++) {
    const row = y * w;
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[row + (x < 0 ? 0 : x >= w ? w - 1 : x)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc * inv;
      const xa = x + r + 1, xr = x - r;
      acc += src[row + (xa >= w ? w - 1 : xa)] - src[row + (xr < 0 ? 0 : xr)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[(y < 0 ? 0 : y >= hgt ? hgt - 1 : y) * w + x];
    for (let y = 0; y < hgt; y++) {
      out[y * w + x] = acc * inv;
      const ya = y + r + 1, yr = y - r;
      acc += tmp[(ya >= hgt ? hgt - 1 : ya) * w + x] - tmp[(yr < 0 ? 0 : yr) * w + x];
    }
  }
  return out;
}

/**
 * Binary min-heap of (priority, index) with deterministic tie-break on index.
 * Preallocated typed arrays; no per-push allocation.
 */
export class Heap {
  pri: Float64Array;
  idx: Int32Array;
  size = 0;
  constructor(cap: number) {
    this.pri = new Float64Array(cap);
    this.idx = new Int32Array(cap);
  }
  private less(a: number, b: number): boolean {
    const pa = this.pri[a], pb = this.pri[b];
    return pa < pb || (pa === pb && this.idx[a] < this.idx[b]);
  }
  push(p: number, i: number): void {
    if (this.size >= this.pri.length) {
      const np = new Float64Array(this.pri.length * 2);
      np.set(this.pri);
      this.pri = np;
      const ni = new Int32Array(this.idx.length * 2);
      ni.set(this.idx);
      this.idx = ni;
    }
    let c = this.size++;
    this.pri[c] = p;
    this.idx[c] = i;
    while (c > 0) {
      const par = (c - 1) >> 1;
      if (!this.less(c, par)) break;
      this.swap(c, par);
      c = par;
    }
  }
  /** Pops the min; returns index, priority in lastPri. */
  lastPri = 0;
  pop(): number {
    const top = this.idx[0];
    this.lastPri = this.pri[0];
    this.size--;
    if (this.size > 0) {
      this.pri[0] = this.pri[this.size];
      this.idx[0] = this.idx[this.size];
      let c = 0;
      for (;;) {
        const l = 2 * c + 1, r = l + 1;
        let m = c;
        if (l < this.size && this.less(l, m)) m = l;
        if (r < this.size && this.less(r, m)) m = r;
        if (m === c) break;
        this.swap(c, m);
        c = m;
      }
    }
    return top;
  }
  private swap(a: number, b: number): void {
    const p = this.pri[a];
    this.pri[a] = this.pri[b];
    this.pri[b] = p;
    const i = this.idx[a];
    this.idx[a] = this.idx[b];
    this.idx[b] = i;
  }
}

/** 8-neighbour offsets (dx, dz) and their lengths in cells. */
export const D8X = [1, 1, 0, -1, -1, -1, 0, 1];
export const D8Z = [0, 1, 1, 1, 0, -1, -1, -1];
export const D8L = [1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2];
