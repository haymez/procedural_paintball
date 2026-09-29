// Stage 9: props. Jittered-grid (blue-ish noise) scatter per kind, density
// from biome, moisture and clustering noise; groves, clearings and flower
// meadows; Riviera plants (lemon, bougainvillea, cypress rows) near ruins and
// paths. Collider kinds are placed first on their own RNG streams so that
// skipDecor (which skips zero-radius kinds) cannot change them.
import { Noise } from "../../math/noise";
import type { Rng } from "../../math/rng";
import { atan2, TAU } from "../../math/trig";
import { smoothstep } from "../../math/vec";
import type { Ctx } from "../context";
import { edt, gx, N, NN, sample, toG } from "../grid";
import { Biome, NO_WATER, PROP_COLLIDER_RADIUS, PropKind, type PropSet } from "../types";
import { BLOCK_CAVE, BLOCK_DOCK, BLOCK_PATH, BLOCK_STRUCT } from "./sites";

interface Env {
  i: number;
  x: number;
  z: number;
  h: number;
  b: Biome;
  m: number; // moisture 0..1
  c: number; // coast distance
  s: number; // slope
  site: number; // distance to structures (m)
  path: number; // distance to paths (m)
  wd: number; // distance to fresh water
  cl: number; // generic cluster noise 0..1 (per kind)
  open: number; // clearing factor 0..1 (0 = clearing)
  st: number; // forest stand noise 0..1 shared by all kinds: < 0.5 oak-dominated, > 0.5 pine-dominated
}

interface Rule {
  kind: PropKind;
  sp: number;
  p: (e: Env) => number;
  scale: [number, number];
  minDist?: number;
  maxSlope?: number;
  wet?: boolean; // may stand in shallow water
  sink?: number;
  lean?: boolean;
}

const B = Biome;

const RULES: Rule[] = [
  // --- colliders (big first) ---
  { kind: PropKind.Boulder, sp: 15, minDist: 7, maxSlope: 1.2, scale: [0.7, 1.35], sink: 0.6,
    p: (e) => (e.b === B.Rock ? 0.14 : e.b === B.Scrub ? 0.05 : e.b === B.Meadow ? 0.025 : e.b === B.Beach && e.c > 8 ? 0.04 : e.b === B.Jungle ? 0.03 : e.b === B.Forest ? 0.035 : 0) * (0.4 + e.cl) },
  // rainforest: sparse emergent giants over a closed broadleaf canopy
  { kind: PropKind.JungleGiant, sp: 19, minDist: 10, maxSlope: 0.6, scale: [0.85, 1.2],
    p: (e) => (e.b === B.Jungle ? 0.42 * (0.5 + 0.5 * e.open) * (0.5 + e.cl) : e.b === B.Riverbank && e.m > 0.6 ? 0.06 : 0) },
  { kind: PropKind.Broadleaf, sp: 4.8, minDist: 4.2, scale: [0.75, 1.3],
    p: (e) => (e.b === B.Jungle ? 0.86 * (0.3 + 0.7 * e.open) * (0.75 + 0.35 * e.cl) : e.b === B.Riverbank ? 0.3 : e.b === B.PalmGrove && e.m > 0.62 ? 0.1 : e.b === B.Forest && e.wd < 25 ? 0.15 : 0) },
  // Mediterranean woodland: holm oak stands and pine stands that interleave
  { kind: PropKind.HolmOak, sp: 5.2, minDist: 4.2, scale: [0.8, 1.3],
    p: (e) => (e.b === B.Forest ? 0.85 * (0.3 + 0.7 * e.open) * (1 - smoothstep(0.45, 0.72, e.st)) : e.b === B.Scrub ? 0.035 * e.cl : e.b === B.Meadow ? 0.02 * e.cl : 0) },
  { kind: PropKind.Pine, sp: 6.2, minDist: 4.6, scale: [0.8, 1.25], lean: true,
    p: (e) => {
      if (e.b === B.Forest) return 0.72 * (0.35 + 0.65 * e.open) * smoothstep(0.35, 0.6, e.st);
      // wind-bent pines on cliff tops and rocky coasts
      if ((e.b === B.Scrub || e.b === B.Meadow || e.b === B.Rock || e.b === B.Beach) && e.c > 4 && e.c < 45 && e.h > 6) return 0.14 * e.cl;
      return e.b === B.Scrub ? 0.03 : 0;
    } },
  { kind: PropKind.UmbrellaPine, sp: 11, minDist: 7, scale: [0.8, 1.3],
    p: (e) => (e.b === B.Meadow ? 0.3 : e.b === B.Scrub ? 0.14 : e.b === B.PalmGrove && e.c > 60 ? 0.06 : e.b === B.Forest ? 0.2 * (1 - e.open) + 0.04 : 0) * e.open * smoothstep(0.35, 0.7, e.cl) * 1.5 },
  { kind: PropKind.Mangrove, sp: 4.5, minDist: 3.2, wet: true, scale: [0.8, 1.25], sink: 0.1,
    p: (e) => (e.b === B.Mangrove ? 0.55 : 0) },
  { kind: PropKind.Palm, sp: 6.5, minDist: 3.2, scale: [0.85, 1.25],
    p: (e) => (e.b === B.PalmGrove ? 0.5 * (0.5 + e.cl) * (0.4 + 0.6 * e.open) : e.b === B.Beach && e.c > 6 ? 0.12 : e.b === B.Jungle && e.h < 25 ? 0.08 : e.b === B.Mangrove ? 0.04 : 0) },
  { kind: PropKind.PalmLeaning, sp: 8, minDist: 3.2, lean: true, scale: [0.85, 1.2],
    p: (e) => (e.b === B.Beach && e.c > 3 && e.c < 20 ? 0.2 : e.b === B.PalmGrove && e.c < 40 ? 0.08 : 0) },
  { kind: PropKind.Cypress, sp: 6, minDist: 3, scale: [0.8, 1.25],
    p: (e) => {
      if (e.b !== B.Meadow && e.b !== B.Scrub && e.b !== B.Village && e.b !== B.PalmGrove) return 0;
      if (e.path > 2.6 && e.path < 6.5 && e.site < 140) return 0.4; // cypress-lined lanes near ruins
      return e.b === B.Meadow ? 0.02 : 0;
    } },
  { kind: PropKind.Olive, sp: 6, minDist: 4, scale: [0.8, 1.2],
    p: (e) => (e.b === B.Meadow ? 0.5 * smoothstep(0.45, 0.8, e.cl) + 0.03 : e.b === B.Scrub ? 0.1 * e.cl : 0) * e.open },
  { kind: PropKind.LemonTree, sp: 5, minDist: 3, scale: [0.8, 1.15],
    p: (e) => (e.site > 3 && e.site < 40 && e.b !== B.Beach && e.b !== B.Rock ? 0.22 * (1 - e.site / 40) + 0.04 : 0) },
  { kind: PropKind.Banana, sp: 4, minDist: 2, scale: [0.8, 1.2],
    p: (e) => (e.b === B.Jungle ? (0.08 + 0.2 * (1 - e.open)) * (0.3 + e.cl) : e.b === B.PalmGrove && e.m > 0.55 ? 0.05 : 0) },
  { kind: PropKind.TreeFern, sp: 4.2, minDist: 2.4, scale: [0.75, 1.3],
    p: (e) => (e.b === B.Jungle ? 0.26 * (0.6 + 0.6 * e.cl) : e.b === B.Riverbank && e.m > 0.55 ? 0.12 : e.b === B.Forest && e.wd < 20 ? 0.06 : 0) },
  { kind: PropKind.RockMedium, sp: 8, minDist: 3, maxSlope: 1.3, scale: [0.7, 1.4], sink: 0.35,
    p: (e) => (e.b === B.Rock ? 0.2 : e.b === B.Cliff ? 0.08 : e.b === B.Scrub ? 0.06 : e.b === B.Meadow ? 0.015 : e.b === B.Riverbank ? 0.05 : 0) },
  // --- decor ---
  { kind: PropKind.Fern, sp: 2.2, scale: [0.7, 1.3],
    p: (e) => (e.b === B.Jungle ? 0.5 : e.b === B.Riverbank ? 0.22 : e.b === B.PalmGrove && e.m > 0.55 ? 0.07 : e.b === B.Forest ? 0.06 + 0.1 * e.m : 0) },
  { kind: PropKind.Understory, sp: 2.8, scale: [0.7, 1.35],
    p: (e) => (e.b === B.Jungle ? 0.32 * (0.5 + e.cl) : e.b === B.Riverbank && e.m > 0.55 ? 0.08 : e.b === B.PalmGrove && e.m > 0.62 ? 0.03 : 0) },
  { kind: PropKind.Log, sp: 13, maxSlope: 0.5, scale: [0.8, 1.25], sink: 0.08,
    p: (e) => (e.b === B.Jungle ? 0.2 : e.b === B.Forest ? 0.16 : e.b === B.Riverbank ? 0.05 : 0) },
  { kind: PropKind.Bush, sp: 3.5, scale: [0.6, 1.4],
    p: (e) => (e.b === B.Scrub ? 0.35 * (0.4 + e.cl) : e.b === B.Meadow ? 0.08 : e.b === B.Jungle ? 0.12 : e.b === B.Forest ? 0.2 + 0.2 * (1 - e.open) : e.b === B.PalmGrove ? 0.1 : e.b === B.Beach && e.c > 14 ? 0.03 : 0) },
  { kind: PropKind.Bougainvillea, sp: 3, scale: [0.7, 1.3],
    p: (e) => (e.site > 1.2 && e.site < 8 ? 0.16 * (1 - e.site / 10) : e.b === B.Village ? 0.03 : 0) },
  { kind: PropKind.Agave, sp: 4, maxSlope: 1.2, scale: [0.6, 1.3],
    p: (e) => (e.b === B.Scrub ? 0.18 : e.b === B.Rock && e.h < 90 ? 0.05 : e.b === B.Cliff ? 0.05 : e.b === B.Beach && e.c > 12 ? 0.03 : 0) },
  { kind: PropKind.GrassTuft, sp: 2.2, scale: [0.6, 1.4],
    p: (e) => (e.b === B.Meadow ? 0.35 : e.b === B.PalmGrove ? 0.2 : e.b === B.Scrub ? 0.14 : e.b === B.Riverbank ? 0.25 : e.b === B.Village ? 0.04 : e.b === B.Jungle ? 0.03 : e.b === B.Forest ? 0.12 * (1 - e.open * 0.6) : 0) },
  { kind: PropKind.Flowers, sp: 3, scale: [0.6, 1.3],
    p: (e) => (e.b === B.Meadow ? 0.45 * smoothstep(0.55, 0.85, e.cl) + 0.02 : e.b === B.Village ? 0.08 : e.site < 20 ? 0.06 : e.b === B.Forest ? 0.05 * (1 - e.open) : 0) },
  { kind: PropKind.RockSmall, sp: 4, maxSlope: 1.4, scale: [0.5, 1.5], sink: 0.1,
    p: (e) => (e.b === B.Rock ? 0.25 : e.b === B.Cliff ? 0.15 : e.b === B.Scrub ? 0.08 : e.b === B.Riverbank ? 0.08 : e.b === B.Beach ? 0.02 : e.b === B.Meadow ? 0.02 : e.b === B.Forest ? 0.05 : e.b === B.Jungle ? 0.02 : 0) },
  { kind: PropKind.Driftwood, sp: 9, scale: [0.7, 1.3],
    p: (e) => (e.b === B.Beach && e.c < 12 ? 0.09 : 0) },
  { kind: PropKind.Reed, sp: 1.8, wet: true, scale: [0.7, 1.3],
    p: (e) => (e.wd < 3.5 && e.c > 10 ? 0.45 : e.b === B.Mangrove ? 0.05 : 0) },
];

export function propsStage(ctx: Ctx, rng: Rng): void {
  const h = ctx.height;
  // distance fields
  const sm = new Uint8Array(NN), pm = new Uint8Array(NN);
  for (let i = 0; i < NN; i++) {
    sm[i] = ctx.blocked[i] & BLOCK_STRUCT ? 1 : 0;
    pm[i] = ctx.path[i] > 90 ? 1 : 0;
  }
  const siteD = edt(sm, N, N);
  const pathD = edt(pm, N, N);
  const noise = new Noise(rng.fork("clusters"));
  const clearN = new Noise(rng.fork("clearings"));
  const standN = new Noise(rng.fork("stands"));
  const trunk = new Uint8Array(NN); // collider occupancy
  // land bbox
  let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
  for (let iz = 0; iz < N; iz++)
    for (let ix = 0; ix < N; ix++) {
      if (h[iz * N + ix] > -1) {
        const x = gx(ix), z = gx(iz);
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (z < z0) z0 = z;
        if (z > z1) z1 = z;
      }
    }
  const e: Env = { i: 0, x: 0, z: 0, h: 0, b: 0, m: 0, c: 0, s: 0, site: 0, path: 0, wd: 0, cl: 0, open: 1, st: 0.5 };
  const out: PropSet[] = [];

  for (let r = 0; r < RULES.length; r++) {
    const rule = RULES[r];
    const collider = PROP_COLLIDER_RADIUS[rule.kind] > 0;
    if (!collider && ctx.skipDecor) continue;
    const pr = rng.fork("prop:" + rule.kind);
    const data: number[] = [];
    const sp = rule.sp;
    const nx = Math.ceil((x1 - x0) / sp), nz = Math.ceil((z1 - z0) / sp);
    const off = rule.kind * 13.7;
    const maxS = rule.maxSlope ?? 0.75;
    const rOcc = rule.minDist ? Math.ceil(rule.minDist / 2 / 2) : 0;
    for (let jz = 0; jz < nz; jz++)
      for (let jx = 0; jx < nx; jx++) {
        const x = x0 + (jx + pr.next()) * sp;
        const z = z0 + (jz + pr.next()) * sp;
        const roll = pr.next();
        const fx = toG(x), fz = toG(z);
        const ix = Math.round(fx), iz = Math.round(fz);
        if (ix < 1 || iz < 1 || ix >= N - 1 || iz >= N - 1) continue;
        const i = iz * N + ix;
        const hv = sample(h, x, z);
        if (hv < (rule.wet ? -0.9 : 0.25)) continue;
        if (ctx.holes[i] || ctx.blocked[i] & (BLOCK_STRUCT | BLOCK_PATH | BLOCK_CAVE | BLOCK_DOCK)) continue;
        const wv = ctx.water[i];
        if (wv !== NO_WATER && wv > hv - 0.05 && (!rule.wet || wv - hv > 0.5)) continue;
        e.i = i;
        e.x = x;
        e.z = z;
        e.h = hv;
        e.b = ctx.biome[i];
        e.s = ctx.slope[i];
        if (e.s > maxS) continue;
        e.m = ctx.moisture[i] / 255;
        e.c = ctx.coast[i];
        e.site = siteD[i] * 2;
        e.path = pathD[i] * 2;
        e.wd = ctx.waterDist[i];
        e.cl = 0.5 + 0.5 * noise.fbm(x / 55 + off, z / 55 - off, 2);
        e.open = smoothstep(-0.45, 0.05, clearN.fbm(x / 90, z / 90, 2));
        e.st = 0.5 + 0.5 * standN.fbm(x / 70, z / 70, 2);
        const p = rule.p(e);
        if (p <= 0 || roll >= p) continue;
        if (collider) {
          let hit = false;
          for (let dz = -rOcc; dz <= rOcc && !hit; dz++)
            for (let dx = -rOcc; dx <= rOcc; dx++) {
              const qx = ix + dx, qz = iz + dz;
              if (qx < 0 || qz < 0 || qx >= N || qz >= N) continue;
              if (trunk[qz * N + qx]) {
                hit = true;
                break;
              }
            }
          if (hit) continue;
        }
        const scale = pr.range(rule.scale[0], rule.scale[1]);
        let rot = pr.range(0, TAU);
        if (collider) {
          // keep the collider clear of structures
          const rr = PROP_COLLIDER_RADIUS[rule.kind] * scale + 0.4;
          let bad = false;
          for (let k = 0; k < 4 && !bad; k++) {
            const px = x + (k === 0 ? rr : k === 1 ? -rr : 0), pz = z + (k === 2 ? rr : k === 3 ? -rr : 0);
            const j = Math.round(toG(pz)) * N + Math.round(toG(px));
            if (ctx.blocked[j] & (BLOCK_STRUCT | BLOCK_CAVE | BLOCK_DOCK)) bad = true;
          }
          if (bad) continue;
          trunk[i] = 1;
        }
        if (rule.lean) {
          // lean out toward the sea
          const gxv = ctx.coast[i + 1] - ctx.coast[i - 1], gzv = ctx.coast[i + N] - ctx.coast[i - N];
          if (gxv !== 0 || gzv !== 0) rot = atan2(-gxv, -gzv) + pr.range(-0.5, 0.5);
        }
        data.push(x, hv - (rule.sink ?? 0.12) * scale, z, rot, scale);
      }
    out.push({ kind: rule.kind, count: data.length / 5, data: Float32Array.from(data) });
  }
  out.sort((a, b) => a.kind - b.kind);
  ctx.props = out;
}
