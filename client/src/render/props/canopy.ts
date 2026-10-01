// Canopy-cover map: a low-res world-space texture built from the tree props,
// sampled by every styled material (see patch.ts) to shade whatever sits under
// dense crowns — darker, cooler ambient and dappled, reduced sun. Real sun
// shadows exist near the camera; this carries the forest mood past the shadow
// distance and adds the "sky is hidden" ambient occlusion shadows can't.
//
//   r  local cover 0..1 (small blur)        -> direct sun cut
//   g  crown mid height, absolute y (m)      -> full shade below this
//   b  crown top height, absolute y (m)      -> no shade above this
//   a  regional cover 0..1 (wide blur)       -> "inside the forest" ambient
import * as THREE from "three";
import { PROP_STRIDE, PropKind, WORLD_HALF, WORLD_SIZE, type PropSet } from "../../../../shared/world/types";

export const CANOPY_RES = 512;

/** crown radius, cover weight, crown mid / top height (all at scale 1), crown offset x/z from the trunk */
type CanopyDef = [r: number, w: number, mid: number, top: number, ox?: number, oz?: number];
const DEFS: Partial<Record<PropKind, CanopyDef>> = {
  [PropKind.Palm]: [4.0, 0.3, 8.2, 10.2, 0.6, 0],
  [PropKind.PalmLeaning]: [4.0, 0.28, 6.8, 8.6, 2.5, 0],
  [PropKind.Broadleaf]: [6.2, 0.85, 9.8, 12.8, 0.3, 0.1],
  [PropKind.JungleGiant]: [10.8, 0.85, 17.6, 21.2, -0.6, 0.4],
  [PropKind.UmbrellaPine]: [5.2, 0.75, 7.0, 8.4, 0.6, 0.2],
  [PropKind.Cypress]: [1.4, 0.35, 5, 10],
  [PropKind.Olive]: [2.4, 0.5, 2.8, 4.3],
  [PropKind.LemonTree]: [1.6, 0.45, 2.1, 3.3],
  [PropKind.Mangrove]: [2.9, 0.65, 4.4, 5.9],
  [PropKind.Banana]: [1.9, 0.3, 2.4, 3.8],
  [PropKind.TreeFern]: [2.4, 0.35, 3.7, 5],
  [PropKind.HolmOak]: [4.3, 0.66, 5.6, 9],
  [PropKind.Pine]: [3.6, 0.5, 9.6, 14, 1.0, 0.3],
};

function blur(src: Float32Array, n: number, r: number): Float32Array {
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  const w = 1 / (2 * r + 1);
  for (let z = 0; z < n; z++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[z * n + Math.min(n - 1, Math.max(0, k))];
    for (let x = 0; x < n; x++) {
      tmp[z * n + x] = acc * w;
      acc += src[z * n + Math.min(n - 1, x + r + 1)] - src[z * n + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < n; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += tmp[Math.min(n - 1, Math.max(0, k)) * n + x];
    for (let z = 0; z < n; z++) {
      out[z * n + x] = acc * w;
      acc += tmp[Math.min(n - 1, z + r + 1) * n + x] - tmp[Math.max(0, z - r) * n + x];
    }
  }
  return out;
}

export function buildCanopyTexture(props: PropSet[]): THREE.DataTexture {
  const N = CANOPY_RES, T = WORLD_SIZE / N;
  const cov = new Float32Array(N * N);
  const wSum = new Float32Array(N * N), midSum = new Float32Array(N * N), topSum = new Float32Array(N * N);
  for (const ps of props) {
    const def = DEFS[ps.kind];
    if (!def) continue;
    const [R0, w, mid, top, ox = 0, oz = 0] = def;
    for (let i = 0; i < ps.count; i++) {
      const o = i * PROP_STRIDE;
      const rot = ps.data[o + 3], s = ps.data[o + 4];
      const c = Math.cos(rot), sn = Math.sin(rot);
      const x = ps.data[o] + (c * ox + sn * oz) * s, z = ps.data[o + 2] + (-sn * ox + c * oz) * s;
      const y = ps.data[o + 1];
      const R = R0 * s;
      const gx = (x + WORLD_HALF) / T - 0.5, gz = (z + WORLD_HALF) / T - 0.5;
      const rt = R / T;
      const i0 = Math.max(0, Math.floor(gx - rt)), i1 = Math.min(N - 1, Math.ceil(gx + rt));
      const j0 = Math.max(0, Math.floor(gz - rt)), j1 = Math.min(N - 1, Math.ceil(gz + rt));
      for (let j = j0; j <= j1; j++) for (let ii = i0; ii <= i1; ii++) {
        const d = Math.hypot(ii - gx, j - gz) / rt;
        if (d >= 1) continue;
        const t = Math.min(1, (1 - d) / 0.45);
        const f = w * t * t * (3 - 2 * t);
        const k = j * N + ii;
        cov[k] = 1 - (1 - cov[k]) * (1 - f);
        wSum[k] += f; midSum[k] += f * (y + mid * s); topSum[k] += f * (y + top * s);
      }
    }
  }
  const local = blur(cov, N, 1);
  const region = blur(blur(cov, N, 5), N, 5);
  const wL = blur(wSum, N, 1), mL = blur(midSum, N, 1), tL = blur(topSum, N, 1);
  const wW = blur(blur(wSum, N, 6), N, 6), mW = blur(blur(midSum, N, 6), N, 6), tW = blur(blur(topSum, N, 6), N, 6);
  const data = new Uint16Array(N * N * 4);
  const h = THREE.DataUtils.toHalfFloat;
  for (let k = 0; k < N * N; k++) {
    const wl = wL[k] + wW[k] * 0.05 + 1e-6;
    let mid = (mL[k] + mW[k] * 0.05) / wl, top = (tL[k] + tW[k] * 0.05) / wl;
    if (wL[k] + wW[k] < 1e-4) { mid = -1000; top = -999; }
    data[k * 4] = h(Math.min(1, local[k]));
    data[k * 4 + 1] = h(mid);
    data[k * 4 + 2] = h(Math.max(top, mid + 0.5));
    data[k * 4 + 3] = h(Math.min(1, Math.max(0, (region[k] - 0.12) / 0.6)));
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** Tree kinds that feed the canopy map (debug / tools). */
export const CANOPY_KINDS = Object.keys(DEFS).map(Number) as PropKind[];
