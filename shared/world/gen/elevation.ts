// Stage 2: elevation. Mountains come from the archetype skeleton (peaks and
// ridges) shaped by ridged noise; the coastal band is analytic from the
// signed coast distance so beaches stay gentle and cliffs stay sheer.
//
// Smooth inland fields are evaluated on a 4 m grid (the erosion grid) and
// upsampled; the coastal profile is evaluated at full resolution.
import { Noise, warp2, warpOut } from "../../math/noise";
import type { Rng } from "../../math/rng";
import { TAU, cos, sin } from "../../math/trig";
import { distSeg2Sq, segOut, smax, smoothstep } from "../../math/vec";
import type { Ctx } from "../context";
import { gx, N } from "../grid";

export const H4 = 257;
export const NN4 = H4 * H4;

export interface InlandFields {
  mountain: Float32Array;
  hills: Float32Array;
  cliffTop: Float32Array;
  reef: Float32Array;
}

function peakProfile(t: number, sharp: number): number {
  if (t >= 1) return 0;
  const u = 1 - t;
  const dome = (1 - t * t) * (1 - t * t);
  // concave flanks with a rounded summit (avoids a needle-sharp, unclimbable top)
  const cone = u * Math.sqrt(u) * (1 - 0.35 * u * u * u * u);
  return dome + (cone - dome) * sharp;
}

export function inlandFields(ctx: Ctx, rng: Rng): InlandFields {
  const mountain = new Float32Array(NN4);
  const hills = new Float32Array(NN4);
  const cliffTop = new Float32Array(NN4);
  const reef = new Float32Array(NN4);
  const wn = new Noise(rng.fork("warp"));
  const rn = new Noise(rng.fork("ridged"));
  const hn = new Noise(rng.fork("hills"));
  const cn = new Noise(rng.fork("cliffTop"));
  const peaks = ctx.peaks, ridges = ctx.ridges;
  const ridgeScale = rng.range(130, 190);
  const ridgeAmt = rng.range(0.18, 0.3);
  const hillAmt = rng.range(6, 13);
  const plateau = Math.min(ctx.ch.plateau, ctx.archetype === "spine" || rng.chance(0.25) ? rng.range(70, 110) * ctx.ch.relief : 1e9);
  const [ct0, ct1] = ctx.ch.cliffTop;
  const rot = rng.range(0, TAU);
  const rc = cos(rot), rs = sin(rot);

  for (let iz = 0; iz < H4; iz++) {
    for (let ix = 0; ix < H4; ix++) {
      const i = iz * H4 + ix;
      const x = -512 + ix * 4, z = -512 + iz * 4;
      warp2(wn, x, z, 1 / 220, 38, 2);
      const wx = warpOut.x, wz = warpOut.y;
      let m = 0;
      for (const p of peaks) {
        const dx = wx - p.x, dz = wz - p.z;
        const d = Math.sqrt(dx * dx + dz * dz);
        const t = d / (p.r * 1.08);
        if (t >= 1) continue;
        let v = p.h * 0.86 * peakProfile(t, p.sharp);
        if (p.caldera) {
          const tr = p.caldera / (p.r * 1.08);
          const rim = p.h * 0.86 * peakProfile(tr, p.sharp);
          if (d < p.caldera) {
            const q = d / p.caldera;
            v = rim - 22 * (1 - q * q) + 4 * q * q;
          }
          // slight crater rim lip
          v += 6 * smoothstep(p.caldera * 1.6, p.caldera, d) * (d > p.caldera ? 1 : 0);
        }
        m = smax(m, v, 18);
      }
      for (const r of ridges) {
        let best = 1e18, bh = 0;
        for (let k = 0; k < r.pts.length - 1; k++) {
          const a = r.pts[k], b = r.pts[k + 1];
          const d2 = distSeg2Sq(wx, wz, a.x, a.z, b.x, b.z);
          if (d2 < best) {
            best = d2;
            const t = segOut.t;
            // ease heights along the segment
            const e = t * t * (3 - 2 * t);
            bh = a.h + (b.h - a.h) * e;
          }
        }
        const s = Math.sqrt(best) / r.width;
        if (s < 1) {
          const u = 1 - s;
          m = smax(m, bh * u * Math.sqrt(u) * (0.6 + 0.4 * u), 18);
        }
      }
      // Ridged detail: crests radiating over the massif.
      const ax = (wx * rc - wz * rs) / ridgeScale, az = (wx * rs + wz * rc) / (ridgeScale * 0.8);
      const rd = rn.ridged(ax, az, 4, 2.05, 0.45);
      const mf = smoothstep(5, 70, m);
      // keep caldera rims intact so they hold a lake
      let cw = 1;
      for (const p of peaks) {
        if (!p.caldera) continue;
        const dx = wx - p.x, dz = wz - p.z;
        cw = Math.min(cw, smoothstep(p.caldera * 1.1, p.caldera * 2.6, Math.sqrt(dx * dx + dz * dz)));
      }
      const mod = m * (1 - ridgeAmt + ridgeAmt * 1.35 * rd) + 9 * (rd - 0.45) * mf;
      m = m + (mod - m) * cw;
      if (m > plateau) m = plateau + (m - plateau) * 0.3;
      mountain[i] = m > 0 ? m : 0;

      const hv = hn.fbm(x / 260, z / 260, 4) * 0.8 + 0.25 + 0.35 * hn.fbm(x / 90 + 3.1, z / 90, 3);
      hills[i] = hv > 0 ? hv * hillAmt : hv * 2;
      cliffTop[i] = ct0 + (ct1 - ct0) * (0.5 + 0.5 * cn.fbm(x / 160, z / 160, 3));
      reef[i] = cn.fbm(x / 110 + 40, z / 110, 3);
    }
  }
  return { mountain, hills, cliffTop, reef };
}

/** Height from the coastal profile + inland fields at one location. */
export function composeHeight(
  d: number, c: number, sh: number, M: number, hills: number, cliffTop: number, reef: number,
): number {
  if (d > 0) {
    const beach = 1.9 * smoothstep(0, 50, d) + 0.25 + d * 0.012;
    const cp = cliffTop * smoothstep(0, 7, d) + 0.4;
    const C = beach + (cp - beach) * c;
    const inl = smoothstep(18, 180, d);
    const m0 = smoothstep(8, 140, d), m1 = smoothstep(0, 14, d);
    const mm = m0 + (m1 - m0) * c;
    return C + hills * inl + M * mm;
  }
  const ds = -d;
  const shelfW = (24 + 60 * (0.5 + 0.5 * reef) + 70 * sh) * (1 - c) + 5 * c;
  let shallow: number;
  if (ds < shelfW) {
    const t = ds / shelfW;
    shallow = 0.25 + 2.7 * t * Math.sqrt(t);
  } else shallow = 2.95 + 24 * smoothstep(shelfW, shelfW + 150, ds);
  // reef patches further out stay shallow
  if (reef > 0.4 && ds < shelfW + 90) {
    const rs = 1.0 + (0.62 - reef) * 9 + smoothstep(shelfW + 40, shelfW + 90, ds) * 20;
    if (rs < shallow) shallow = rs;
  }
  let deep = 4.5 + ds * 0.3;
  if (deep > 30) deep = 30;
  const depth = shallow + (deep - shallow) * c;
  return -depth;
}

/** Push the seabed down near the world border so the edges are always open, deep sea. */
export function edgeDeepen(v: number, x: number, z: number): number {
  const m = Math.max(Math.abs(x), Math.abs(z));
  if (m < 450) return v;
  const t = smoothstep(450, 500, m);
  const deep = -26;
  return v > deep ? v + (deep - v) * t : v;
}

/** Coast-distance etc. sampled onto the 4 m grid. */
export function composeCoarse(ctx: Ctx, f: InlandFields): Float32Array {
  const h4 = new Float32Array(NN4);
  for (let iz = 0; iz < H4; iz++)
    for (let ix = 0; ix < H4; ix++) {
      const i = iz * H4 + ix;
      const j = iz * 2 * N + ix * 2;
      h4[i] = edgeDeepen(composeHeight(ctx.coast[j], ctx.cliff[j], ctx.shelter[j], f.mountain[i], f.hills[i], f.cliffTop[i], f.reef[i]), -512 + ix * 4, -512 + iz * 4);
    }
  return h4;
}

/** Bilinear upsample of a 257² grid at full-res cell (ix, iz). */
export function up4(a: Float32Array, ix: number, iz: number): number {
  const cx = ix >> 1, cz = iz >> 1;
  const tx = (ix & 1) * 0.5, tz = (iz & 1) * 0.5;
  const i = cz * H4 + cx;
  const x1 = cx < H4 - 1 ? 1 : 0, z1 = cz < H4 - 1 ? H4 : 0;
  const a0 = a[i] + (a[i + x1] - a[i]) * tx;
  const b0 = a[i + z1] + (a[i + z1 + x1] - a[i + z1]) * tx;
  return a0 + (b0 - a0) * tz;
}

export function composeFine(ctx: Ctx, f: InlandFields, delta: Float32Array, rng: Rng): void {
  const h = ctx.height;
  const fine = new Noise(rng.fork("fine"));
  for (let iz = 0; iz < N; iz++)
    for (let ix = 0; ix < N; ix++) {
      const i = iz * N + ix;
      const d = ctx.coast[i];
      let v = composeHeight(d, ctx.cliff[i], ctx.shelter[i], up4(f.mountain, ix, iz), up4(f.hills, ix, iz), up4(f.cliffTop, ix, iz), up4(f.reef, ix, iz));
      v += up4(delta, ix, iz);
      if (d > 6) {
        // fine bumpiness scaled by elevation (rocky highlands are rougher)
        const r = 0.25 + Math.min(v, 120) * 0.005;
        v += r * fine.n2(gx(ix) / 22, gx(iz) / 22);
      }
      h[i] = edgeDeepen(v, gx(ix), gx(iz));
    }
}
