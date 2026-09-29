// Stage 3: erosion.
//  1. Stream-power fluvial erosion (implicit Braun–Willett solver) on the 4 m
//     grid: carves dendritic valley networks and sharp ridgelines.
//  2. Particle (droplet) hydraulic erosion at full resolution for gullies and
//     sediment fans.
//  3. A light thermal pass to relax spikes (cliff coasts are protected).
import { Noise } from "../../math/noise";
import type { Rng } from "../../math/rng";
import type { Ctx } from "../context";
import { D8X, D8Z, Heap, N, NN, slopeAt } from "../grid";
import { smoothstep } from "../../math/vec";
import { H4, NN4 } from "./elevation";

/** Receivers + topological order via priority flood (handles depressions). */
export function floodOrder(
  h: Float32Array, W: number, order: Int32Array, rcv: Int32Array, heap: Heap, isOutlet: (i: number) => boolean,
  filled?: Float32Array, eps = 1e-4,
): number {
  const n = W * W;
  const seen = new Uint8Array(n);
  let count = 0;
  heap.size = 0;
  for (let i = 0; i < n; i++) {
    if (isOutlet(i)) {
      seen[i] = 1;
      rcv[i] = -1;
      order[count++] = i;
      if (filled) filled[i] = h[i];
    }
  }
  // push outlet cells that border non-outlets
  for (let k = 0; k < count; k++) {
    const i = order[k];
    const ix = i % W, iz = (i / W) | 0;
    let border = false;
    for (let d = 0; d < 8; d++) {
      const nx = ix + D8X[d], nz = iz + D8Z[d];
      if (nx < 0 || nz < 0 || nx >= W || nz >= W) continue;
      if (!seen[nz * W + nx]) {
        border = true;
        break;
      }
    }
    if (border) heap.push(h[i], i);
  }
  // Outlets that are not on the border are already in order; re-walk from heap.
  while (heap.size > 0) {
    const c = heap.pop();
    const pc = heap.lastPri;
    if (!isOutlet(c)) {
      order[count++] = c;
      if (filled) filled[c] = pc;
    }
    const ix = c % W, iz = (c / W) | 0;
    for (let d = 0; d < 8; d++) {
      const nx = ix + D8X[d], nz = iz + D8Z[d];
      if (nx < 0 || nz < 0 || nx >= W || nz >= W) continue;
      const j = nz * W + nx;
      if (seen[j]) continue;
      seen[j] = 1;
      rcv[j] = c;
      const hj = h[j];
      heap.push(hj > pc ? hj : pc + eps, j);
    }
  }
  // Cells never reached (no outlets at all) keep rcv -1.
  for (let i = 0; i < n; i++) if (!seen[i]) {
    rcv[i] = -1;
    order[count++] = i;
    if (filled) filled[i] = h[i];
  }
  return count;
}

export function streamPower(ctx: Ctx, h4: Float32Array, rng: Rng): Float32Array {
  const W = H4;
  const before = h4.slice();
  const order = new Int32Array(NN4);
  const rcv = new Int32Array(NN4);
  const area = new Float32Array(NN4);
  const erod = new Float32Array(NN4);
  const heap = new Heap(NN4);
  for (let iz = 0; iz < W; iz++)
    for (let ix = 0; ix < W; ix++) {
      const j = iz * 2 * N + ix * 2;
      const d = ctx.coast[j];
      let e = smoothstep(4, 50, d) * (1 - 0.55 * ctx.cliff[j]);
      for (const p of ctx.peaks) {
        if (!p.caldera) continue;
        const dx = -512 + ix * 4 - p.x, dz = -512 + iz * 4 - p.z;
        const dd = Math.sqrt(dx * dx + dz * dz);
        e *= smoothstep(p.caldera * 1.3, p.caldera * 2.2, dd);
      }
      erod[iz * W + ix] = e;
    }
  const iters = 22;
  const K = rng.range(0.0075, 0.011);
  const isOutlet = (i: number) => h4[i] <= 0;
  for (let it = 0; it < iters; it++) {
    const count = floodOrder(h4, W, order, rcv, heap, isOutlet);
    for (let i = 0; i < NN4; i++) area[i] = 16;
    for (let k = count - 1; k >= 0; k--) {
      const i = order[k];
      const r = rcv[i];
      if (r >= 0) area[r] += area[i];
    }
    for (let k = 0; k < count; k++) {
      const i = order[k];
      const r = rcv[i];
      if (r < 0) continue;
      const hr = h4[r];
      const hi = h4[i];
      if (hi <= hr) continue;
      const dx = (i % W) - (r % W), dz = ((i / W) | 0) - ((r / W) | 0);
      const dist = (dx !== 0 && dz !== 0 ? 1.4142135623730951 : 1) * 4;
      const f = (K * erod[i] * Math.sqrt(area[i])) / dist;
      h4[i] = (hi + f * hr) / (1 + f);
    }
    // gentle hillslope diffusion every few iterations
    if (it % 4 === 3) diffuse(h4, W, 0.12, erod);
  }
  // coarse talus relaxation: keeps most mountain faces climbable
  const talus = 0.5 * 4;
  for (let it = 0; it < 30; it++) {
    for (let iz = 1; iz < W - 1; iz++)
      for (let ix = 1; ix < W - 1; ix++) {
        const i = iz * W + ix;
        const hi = h4[i];
        if (hi < 1 || erod[i] <= 0.05) continue;
        let maxD = 0, mj = -1;
        const a = hi - h4[i - 1], b = hi - h4[i + 1], c = hi - h4[i - W], d = hi - h4[i + W];
        if (a > maxD) { maxD = a; mj = i - 1; }
        if (b > maxD) { maxD = b; mj = i + 1; }
        if (c > maxD) { maxD = c; mj = i - W; }
        if (d > maxD) { maxD = d; mj = i + W; }
        if (maxD > talus && erod[mj] > 0.05) {
          const mv = (maxD - talus) * 0.45;
          h4[i] -= mv;
          h4[mj] += mv;
        }
      }
  }
  const delta = new Float32Array(NN4);
  for (let i = 0; i < NN4; i++) delta[i] = h4[i] - before[i];
  return delta;
}

function diffuse(h: Float32Array, W: number, k: number, mask: Float32Array): void {
  const src = h.slice();
  for (let iz = 1; iz < W - 1; iz++)
    for (let ix = 1; ix < W - 1; ix++) {
      const i = iz * W + ix;
      if (mask[i] <= 0) continue;
      const lap = src[i - 1] + src[i + 1] + src[i - W] + src[i + W] - 4 * src[i];
      h[i] = src[i] + k * mask[i] * lap;
    }
}

/**
 * Droplet erosion (after Hans Beyer / S. Lague) on the full-res grid.
 * Heights in meters, cell = 2 m. Only runs on land away from cliff coasts.
 */
export function dropletErosion(ctx: Ctx, rng: Rng, drops: number): void {
  const h = ctx.height;
  const R = 2; // brush radius in cells
  const bOff: number[] = [], bW: number[] = [], bX: number[] = [], bZ: number[] = [];
  let wsum = 0;
  for (let z = -R; z <= R; z++)
    for (let x = -R; x <= R; x++) {
      const d = Math.sqrt(x * x + z * z);
      if (d <= R) {
        const w = 1 - d / (R + 0.5);
        bOff.push(z * N + x);
        bX.push(x);
        bZ.push(z);
        bW.push(w);
        wsum += w;
      }
    }
  for (let k = 0; k < bW.length; k++) bW[k] /= wsum;
  const BL = bW.length;
  const inertia = 0.3, capF = 3.2, minCap = 0.01, erodeS = 0.35, depS = 0.25, evap = 0.03, grav = 9, life = 48;

  // candidate start cells: land above 3 m, not cliffy coast
  const starts: number[] = [];
  for (let iz = 4; iz < N - 4; iz += 2)
    for (let ix = 4; ix < N - 4; ix += 2) {
      const i = iz * N + ix;
      if (h[i] > 3 && ctx.cliff[i] < 0.6) starts.push(i);
    }
  if (starts.length === 0) return;
  const cal = calderaMask(ctx);
  const protect = (i: number) => (ctx.coast[i] < 16 && ctx.cliff[i] > 0.35) || cal[i] === 1;

  for (let n = 0; n < drops; n++) {
    const s = starts[rng.int(starts.length)];
    let px = (s % N) + rng.next() * 2, pz = ((s / N) | 0) + rng.next() * 2;
    let dx = 0, dz = 0, speed = 1, water = 1, sed = 0;
    for (let l = 0; l < life; l++) {
      const ix = Math.floor(px), iz = Math.floor(pz);
      if (ix < 3 || iz < 3 || ix >= N - 4 || iz >= N - 4) break;
      const i = iz * N + ix;
      const fx = px - ix, fz = pz - iz;
      const h00 = h[i], h10 = h[i + 1], h01 = h[i + N], h11 = h[i + N + 1];
      const gxv = (h10 - h00) * (1 - fz) + (h11 - h01) * fz;
      const gzv = (h01 - h00) * (1 - fx) + (h11 - h10) * fx;
      const hOld = h00 * (1 - fx) * (1 - fz) + h10 * fx * (1 - fz) + h01 * (1 - fx) * fz + h11 * fx * fz;
      dx = dx * inertia - gxv * (1 - inertia);
      dz = dz * inertia - gzv * (1 - inertia);
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len < 1e-6) break;
      dx /= len;
      dz /= len;
      px += dx;
      pz += dz;
      const nx = Math.floor(px), nz = Math.floor(pz);
      if (nx < 3 || nz < 3 || nx >= N - 4 || nz >= N - 4) break;
      const nfx = px - nx, nfz = pz - nz;
      const j = nz * N + nx;
      const hNew = h[j] * (1 - nfx) * (1 - nfz) + h[j + 1] * nfx * (1 - nfz) + h[j + N] * (1 - nfx) * nfz + h[j + N + 1] * nfx * nfz;
      const dh = hNew - hOld;
      if (hNew < 0.2) {
        // reached the sea: drop sediment
        break;
      }
      const cap = Math.max(-dh * speed * water * capF, minCap);
      if (sed > cap || dh > 0) {
        const dep = dh > 0 ? Math.min(dh, sed) : (sed - cap) * depS;
        sed -= dep;
        if (cal[i]) break;
        if (!protect(i)) {
          h[i] += dep * (1 - fx) * (1 - fz);
          h[i + 1] += dep * fx * (1 - fz);
          h[i + N] += dep * (1 - fx) * fz;
          h[i + N + 1] += dep * fx * fz;
        }
      } else {
        let er = Math.min((cap - sed) * erodeS, -dh);
        if (protect(i)) er *= 0.1;
        for (let k = 0; k < BL; k++) {
          const c = i + bOff[k];
          const w = er * bW[k];
          const cur = h[c];
          const take = cur < w ? cur : w;
          h[c] = cur - take;
          sed += take;
        }
      }
      const sp2 = speed * speed + dh * grav * -1;
      speed = sp2 > 0 ? Math.sqrt(sp2) : 0;
      water *= 1 - evap;
    }
  }
  void bX;
  void bZ;
}

/** Thermal relaxation of slopes above the talus threshold. */
export function thermal(ctx: Ctx, iters: number, talus: number, rate: number): void {
  const h = ctx.height;
  const cal = calderaMask(ctx);
  for (let it = 0; it < iters; it++) {
    for (let iz = 1; iz < N - 1; iz++)
      for (let ix = 1; ix < N - 1; ix++) {
        const i = iz * N + ix;
        const hi = h[i];
        if (hi < 0.5) continue;
        if ((ctx.cliff[i] > 0.3 && ctx.coast[i] < 20) || cal[i]) continue;
        let maxD = 0, mj = -1;
        const a = hi - h[i - 1], b = hi - h[i + 1], c = hi - h[i - N], d = hi - h[i + N];
        if (a > maxD) { maxD = a; mj = i - 1; }
        if (b > maxD) { maxD = b; mj = i + 1; }
        if (c > maxD) { maxD = c; mj = i - N; }
        if (d > maxD) { maxD = d; mj = i + N; }
        if (maxD > talus) {
          const mv = (maxD - talus) * rate;
          h[i] -= mv;
          h[mj] += mv;
        }
      }
  }
  void NN;
}

/** Mediterranean terracing on gentle mid-slopes, masked by noise. */
export function terraces(ctx: Ctx, mask: (ix: number, iz: number) => number, step: number): void {
  const h = ctx.height;
  for (let iz = 0; iz < N; iz++)
    for (let ix = 0; ix < N; ix++) {
      const i = iz * N + ix;
      const v = h[i];
      if (v < 8 || v > 95) continue;
      const m = mask(ix, iz);
      if (m <= 0) continue;
      const q = v / step;
      const k = Math.floor(q);
      const f = q - k;
      const t = step * (k + smoothstep(0.25, 0.75, f));
      h[i] = v + (t - v) * m;
    }
}

/** Terraced hillsides (Ligurian-style) in noise-masked patches of gentle slope. */
export function terraceStage(ctx: Ctx, rng: Rng): void {
  const tn = new Noise(rng.fork("mask"));
  const step = rng.range(2.3, 3.0);
  const h = ctx.height;
  terraces(ctx, (ix, iz) => {
    const i = iz * N + ix;
    if (ctx.coast[i] < 35) return 0;
    const m = smoothstep(0.12, 0.38, tn.fbm((ix * 2 - 512) / 170, (iz * 2 - 512) / 170, 2));
    if (m <= 0) return 0;
    const sl = slopeAt(h, ix, iz);
    return m * smoothstep(0.05, 0.12, sl) * (1 - smoothstep(0.42, 0.58, sl)) * 0.85;
  }, step);
}

/** 1 inside and around volcanic calderas (kept intact so they hold a lake). */
export function calderaMask(ctx: Ctx): Uint8Array {
  const m = new Uint8Array(NN);
  for (const p of ctx.peaks) {
    if (!p.caldera) continue;
    const R = p.caldera * 2.2;
    const ci = Math.round((p.x + 512) / 2), cj = Math.round((p.z + 512) / 2);
    const ri = Math.ceil(R / 2);
    for (let dz = -ri; dz <= ri; dz++)
      for (let dx = -ri; dx <= ri; dx++) {
        const ix = ci + dx, iz = cj + dz;
        if (ix < 0 || iz < 0 || ix >= N || iz >= N) continue;
        if ((dx * dx + dz * dz) * 4 <= R * R) m[iz * N + ix] = 1;
      }
  }
  return m;
}
