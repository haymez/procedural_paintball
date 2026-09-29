// Tactical queries for the bot brain: line of sight, cover, ballistic aim,
// points of interest and a decaying danger map. Pure TS, allocation-light.
import { sdf, terrainHeight, type CollisionWorld, type Vec3 } from "../world/collide";
import { N } from "../world/grid";
import { exp, atan2 } from "../math/trig";
import { PickupKind, WORLD_HALF } from "../world/types";
import { Act, BALL_RADIUS, EYE_H, NF } from "./constants";
import { nearestWhere, octant, OCT_X, OCT_Z, type NavGraph } from "./nav";

// ---------------------------------------------------------------------------
// line of sight

/**
 * Is the straight segment a -> b free of terrain, structures, props and cave
 * rock (sphere-traced against the collision SDF)? `pad` thickens the ray
 * (e.g. BALL_RADIUS). Cheap: ~10-40 SDF evaluations for typical ranges.
 */
export function lineOfSight(cw: CollisionWorld, a: Vec3, b: Vec3, pad = 0): boolean {
  return segmentClear(cw, a.x, a.y, a.z, b.x, b.y, b.z, pad);
}

export function segmentClear(
  cw: CollisionWorld, ax: number, ay: number, az: number, bx: number, by: number, bz: number, pad = 0,
): boolean {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const L = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (L < 1e-6) return true;
  const ux = dx / L, uy = dy / L, uz = dz / L;
  const eps = 0.02 + pad;
  let t = 0;
  for (let it = 0; it < 400; it++) {
    const d = sdf(cw, ax + ux * t, ay + uy * t, az + uz * t);
    if (d < eps) return false;
    t += d - pad > 0.05 ? d - pad : 0.05;
    if (t >= L) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// cover points

export const CoverKind = { Solid: 0, Prop: 1, Terrain: 2 } as const;

export interface CoverSet {
  count: number;
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  node: Int32Array;
  /** Octant bitmasks (see nav.octant): cover at chest (~1.0 m) and head (~1.5 m) height toward that direction. */
  low: Uint8Array;
  high: Uint8Array;
  kind: Uint8Array;
  /** 16 m bucket grid (CSR). */
  start: Int32Array;
  items: Int32Array;
}
const CB = 16;
const CBN = (2 * WORLD_HALF) / CB;

/**
 * Precomputes positions next to solid cover: ruin walls (structure patches),
 * big trunks / boulders (props), terrain lips (ridges and banks you can hide
 * behind). Each point knows which octants it is covered toward.
 */
export function buildCover(g: NavGraph): CoverSet {
  const cw = g.cw, w = g.world;
  const xs: number[] = [], ys: number[] = [], zs: number[] = [], ns: number[] = [], lo: number[] = [], hi: number[] = [], ks: number[] = [];
  const push = (x: number, y: number, z: number, node: number, l: number, h: number, k: number) => {
    xs.push(x); ys.push(y); zs.push(z); ns.push(node); lo.push(l); hi.push(h); ks.push(k);
  };
  // structures: every other 0.5 m column, probing 0.75 m out in 8 directions
  for (const p of g.patches) {
    if (p.cave) continue;
    for (let cz = 0; cz < p.h; cz += 2)
      for (let cx = (cz >> 1) & 1; cx < p.w; cx += 2) {
        const c = cz * p.w + cx;
        for (let s = p.colStart[c]; s < p.colStart[c + 1]; s++) {
          const q = p.colNodes[s];
          if (!(g.flags[q] & NF.Land)) continue;
          const x = g.x[q], y = g.y[q], z = g.z[q];
          if (sdf(cw, x, y + 1.0, z) > 1.0) continue;
          let l = 0, h = 0;
          for (let k = 0; k < 8; k++) {
            const px = x + OCT_X[k] * 0.8, pz = z + OCT_Z[k] * 0.8;
            if (sdf(cw, px, y + 1.0, pz) < 0.25) {
              l |= 1 << k;
              if (sdf(cw, px, y + 1.55, pz) < 0.25) h |= 1 << k;
            }
          }
          if (l) push(x, y, z, q, l, h, CoverKind.Solid);
        }
      }
  }
  // big props: a ring of points around each trunk / boulder
  {
    const pp = cw.props;
    for (let k = 0; k < cw.nProps; k++) {
      const o = k * 5;
      const r = pp[o + 3];
      if (r < 0.45) continue;
      const px = pp[o], pz = pp[o + 2], top = pp[o + 4];
      const dirs = r >= 1 ? 8 : 4;
      for (let d = 0; d < 8; d += 8 / dirs) {
        const x = px + OCT_X[d] * (r + 0.55), z = pz + OCT_Z[d] * (r + 0.55);
        const gy = terrainHeight(w, x, z);
        const q = nearestWhere(g, x, gy, z, 1.2, (n) => (g.flags[n] & NF.Land) !== 0 && Math.abs(g.y[n] - gy) < 0.8);
        if (q < 0) continue;
        if (sdf(cw, x, gy + 0.95, z) < g.radius * 0.85) continue;
        const toward = (d + 4) & 7;
        const bits = (1 << toward) | (r >= 1 ? (1 << ((toward + 1) & 7)) | (1 << ((toward + 7) & 7)) : 0);
        push(x, gy, z, q, top > gy + 1.0 ? bits : 0, top > gy + 1.6 ? bits : 0, CoverKind.Prop);
      }
    }
  }
  // terrain lips: ground rising above chest height close by, then falling away again
  {
    const H = w.height;
    for (let q = 0; q < g.n; q++) {
      const f = g.flags[q];
      if (!(f & NF.Coarse) || !(f & NF.Land)) continue;
      const i = g.cell[q], ix = i % N, iz = (i / N) | 0;
      if (ix < 3 || iz < 3 || ix >= N - 3 || iz >= N - 3) continue;
      const y = g.y[q];
      let l = 0, h = 0;
      for (let k = 0; k < 8; k++) {
        const ox = k === 0 || k === 1 || k === 7 ? 1 : k === 3 || k === 4 || k === 5 ? -1 : 0;
        const oz = k === 1 || k === 2 || k === 3 ? 1 : k === 5 || k === 6 || k === 7 ? -1 : 0;
        const h1 = H[(iz + oz) * N + ix + ox];
        if (h1 < y + 1.1) continue;
        const h3 = H[(iz + 3 * oz) * N + ix + 3 * ox];
        if (h3 > h1 + 0.8) continue; // a long climb, not a lip
        l |= 1 << k;
        if (h1 >= y + 1.6) h |= 1 << k;
      }
      if (l) push(g.x[q], y, g.z[q], q, l, h, CoverKind.Terrain);
    }
  }
  const count = xs.length;
  const set: CoverSet = {
    count, x: Float32Array.from(xs), y: Float32Array.from(ys), z: Float32Array.from(zs), node: Int32Array.from(ns),
    low: Uint8Array.from(lo), high: Uint8Array.from(hi), kind: Uint8Array.from(ks),
    start: new Int32Array(CBN * CBN + 1), items: new Int32Array(count),
  };
  const bucket = (k: number) => {
    let bx = Math.floor((set.x[k] + WORLD_HALF) / CB), bz = Math.floor((set.z[k] + WORLD_HALF) / CB);
    bx = bx < 0 ? 0 : bx >= CBN ? CBN - 1 : bx;
    bz = bz < 0 ? 0 : bz >= CBN ? CBN - 1 : bz;
    return bz * CBN + bx;
  };
  for (let k = 0; k < count; k++) set.start[bucket(k) + 1]++;
  for (let b = 0; b < CBN * CBN; b++) set.start[b + 1] += set.start[b];
  const fill = set.start.slice(0, CBN * CBN);
  for (let k = 0; k < count; k++) set.items[fill[bucket(k)]++] = k;
  return set;
}

export interface CoverSpot {
  index: number;
  x: number;
  y: number;
  z: number;
  node: number;
  /** Distance from the query point. */
  dist: number;
  /** Covered at head height too (not just chest). */
  full: boolean;
  /** Stepping ~0.8 m sideways gives a line of sight to the threat (peek & shoot). */
  peek: boolean;
}

export interface CoverQuery {
  /** Max results (default 4). */
  max?: number;
  /** Max LOS checks spent (default 32). */
  budget?: number;
  /** Ignore spots closer than this to the threat (default 6 m). */
  minThreatDist?: number;
  /** Also compute `peek` (default true). */
  peek?: boolean;
}

/**
 * Cover spots within `radius` of `near` hidden from a threat's eye point,
 * best (closest, fully covered) first.
 */
export function findCover(g: NavGraph, cover: CoverSet, threat: Vec3, near: Vec3, radius: number, q: CoverQuery = {}): CoverSpot[] {
  const max = q.max ?? 4, budget = q.budget ?? 32, minT = q.minThreatDist ?? 6, wantPeek = q.peek ?? true;
  const cand: { k: number; s: number; d: number; full: boolean }[] = [];
  const b0x = Math.max(0, Math.floor((near.x - radius + WORLD_HALF) / CB)), b1x = Math.min(CBN - 1, Math.floor((near.x + radius + WORLD_HALF) / CB));
  const b0z = Math.max(0, Math.floor((near.z - radius + WORLD_HALF) / CB)), b1z = Math.min(CBN - 1, Math.floor((near.z + radius + WORLD_HALF) / CB));
  const r2 = radius * radius, m2 = minT * minT;
  for (let bz = b0z; bz <= b1z; bz++)
    for (let bx = b0x; bx <= b1x; bx++) {
      const b = bz * CBN + bx;
      for (let t = cover.start[b]; t < cover.start[b + 1]; t++) {
        const k = cover.items[t];
        const dx = cover.x[k] - near.x, dz = cover.z[k] - near.z, dy = cover.y[k] - near.y;
        const d2 = dx * dx + dz * dz;
        if (d2 > r2) continue;
        const tx = threat.x - cover.x[k], tz = threat.z - cover.z[k];
        if (tx * tx + tz * tz < m2) continue;
        const o = octant(tx, tz);
        const mask = (1 << o) | (1 << ((o + 1) & 7)) | (1 << ((o + 7) & 7));
        if (!(cover.low[k] & mask)) continue;
        const full = (cover.high[k] & (1 << o)) !== 0;
        const d = Math.sqrt(d2 + dy * dy);
        cand.push({ k, s: d + (full ? 0 : 4) + (cover.low[k] & (1 << o) ? 0 : 2), d, full });
      }
    }
  cand.sort((a, b) => a.s - b.s || a.k - b.k);
  const out: CoverSpot[] = [];
  let spent = 0;
  for (const c of cand) {
    if (out.length >= max || spent >= budget) break;
    const k = c.k;
    const x = cover.x[k], y = cover.y[k], z = cover.z[k];
    spent++;
    if (segmentClear(g.cw, threat.x, threat.y, threat.z, x, y + 1.0, z)) continue;
    if (segmentClear(g.cw, threat.x, threat.y, threat.z, x, y + EYE_H, z)) continue;
    let peek = false;
    if (wantPeek) {
      const tx = threat.x - x, tz = threat.z - z, tl = Math.sqrt(tx * tx + tz * tz) || 1;
      const sx = -tz / tl, sz = tx / tl;
      for (const side of [1, -1]) {
        const px = x + sx * side * 0.8, pz = z + sz * side * 0.8;
        if (sdf(g.cw, px, y + EYE_H, pz) < 0.3) continue;
        if (segmentClear(g.cw, px, y + EYE_H, pz, threat.x, threat.y, threat.z)) { peek = true; break; }
      }
    }
    out.push({ index: k, x, y, z, node: cover.node[k], dist: c.d, full: c.full, peek });
  }
  return out;
}

// ---------------------------------------------------------------------------
// ballistics

export interface AimSolution {
  /** Unit launch direction. */
  dx: number;
  dy: number;
  dz: number;
  /** Flight time to the intercept (s). */
  t: number;
  /** Intercept point (where the target will be). */
  x: number;
  y: number;
  z: number;
  /** InputCmd-style angles of the launch direction: yaw 0 = +Z, facing (sin yaw, 0, cos yaw); pitch + = up. */
  yaw: number;
  pitch: number;
}

/**
 * Launch directions that hit a target moving at constant velocity with a
 * projectile of `speed` under `gravity` (m/s², pulling -Y). Up to two
 * solutions, direct (flattest, shortest flight) first, then the lob.
 * Solves |D + V t + (0, g t²/2, 0)| = s t for t by scanning + bisection.
 */
export function ballisticAim(
  from: Vec3, target: Vec3, targetVel: Vec3, speed: number, gravity: number, maxT = 6,
): AimSolution[] {
  const Dx = target.x - from.x, Dy = target.y - from.y, Dz = target.z - from.z;
  const Vx = targetVel.x, Vy = targetVel.y, Vz = targetVel.z;
  const hg = gravity * 0.5, s2 = speed * speed;
  const f = (t: number) => {
    const x = Dx + Vx * t, y = Dy + Vy * t + hg * t * t, z = Dz + Vz * t;
    return x * x + y * y + z * z - s2 * t * t;
  };
  const roots: number[] = [];
  const D = Math.sqrt(Dx * Dx + Dy * Dy + Dz * Dz);
  let dt = Math.min(0.02, D / speed / 8 + 1e-4);
  let t0 = 0, f0 = f(0);
  for (let t = dt; t <= maxT && roots.length < 2; t += dt) {
    const f1 = f(t);
    if ((f0 > 0) !== (f1 > 0)) {
      let lo = t0, hi = t;
      const flo = f0;
      for (let k = 0; k < 40; k++) {
        const m = (lo + hi) * 0.5;
        if ((f(m) > 0) === (flo > 0)) lo = m;
        else hi = m;
      }
      roots.push((lo + hi) * 0.5);
    }
    t0 = t;
    f0 = f1;
    if (t > 0.2) dt = 0.02;
  }
  const out: AimSolution[] = [];
  for (const t of roots) {
    if (t <= 0) continue;
    let vx = (Dx + Vx * t) / t, vy = (Dy + Vy * t) / t + hg * t, vz = (Dz + Vz * t) / t;
    const l = Math.sqrt(vx * vx + vy * vy + vz * vz);
    vx /= l; vy /= l; vz /= l;
    const hl = Math.sqrt(vx * vx + vz * vz);
    out.push({
      dx: vx, dy: vy, dz: vz, t,
      x: target.x + Vx * t, y: target.y + Vy * t, z: target.z + Vz * t,
      yaw: atan2(vx, vz), pitch: atan2(vy, hl),
    });
  }
  return out;
}

export interface ArcResult {
  clear: boolean;
  /** Time of the hit (or maxT if clear). */
  t: number;
  x: number;
  y: number;
  z: number;
}

/**
 * Traces a ballistic arc (launch dir * speed, gravity pulling -Y) against
 * the world for maxT seconds. clear = nothing solid hit before maxT.
 */
export function trajectoryClear(
  cw: CollisionWorld, from: Vec3, dir: Vec3, speed: number, gravity: number, maxT: number, radius = BALL_RADIUS,
): ArcResult {
  const dl = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z) || 1;
  const vx = (dir.x / dl) * speed, vy0 = (dir.y / dl) * speed, vz = (dir.z / dl) * speed;
  let t = 0;
  for (let it = 0; it < 2000; it++) {
    const x = from.x + vx * t, y = from.y + vy0 * t - 0.5 * gravity * t * t, z = from.z + vz * t;
    const d = sdf(cw, x, y, z) - radius;
    if (d < 0.01) return { clear: false, t, x, y, z };
    if (t >= maxT) return { clear: true, t: maxT, x, y, z };
    const vy = vy0 - gravity * t;
    const sp = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
    let step = (d * 0.9) / sp;
    if (step < 0.002) step = 0.002;
    t = t + step > maxT ? maxT : t + step;
  }
  return { clear: false, t, x: from.x, y: from.y, z: from.z };
}

// ---------------------------------------------------------------------------
// points of interest

export interface Poi {
  x: number;
  y: number;
  z: number;
  node: number;
}
export interface PickupPoi extends Poi {
  kind: PickupKind;
  /** Index into world.pickups. */
  index: number;
}
export interface PerchPoi extends Poi {
  /** Height above the surroundings (m). */
  prominence: number;
  /** On a structure (tower / roof) rather than a hilltop. */
  structure: boolean;
}
export interface ZipPoi extends Poi {
  /** Index into world.ziplines. */
  index: number;
  /** Nav node at the bottom. */
  bottom: number;
}
export interface Pois {
  pickups: PickupPoi[];
  perches: PerchPoi[];
  ziplineTops: ZipPoi[];
}

/** Pickups, high ground / sniper perches and zipline tops, each snapped to a nav node. */
export function buildPois(g: NavGraph): Pois {
  const w = g.world;
  const pickups: PickupPoi[] = w.pickups.map((p, index) => ({
    kind: p.kind, index, x: p.x, y: p.y, z: p.z, node: nearestWhere(g, p.x, p.y, p.z, 3),
  }));
  const ziplineTops: ZipPoi[] = [];
  for (const l of g.links) {
    if (l.act !== Act.Zipline) continue;
    ziplineTops.push({ index: l.id, x: g.x[l.from], y: g.y[l.from], z: g.z[l.from], node: l.from, bottom: l.to });
  }
  // perches: per 32 m sector, the highest walkable coarse node if it stands
  // well above a 30 m ring; plus elevated structure floors (tower tops, roofs)
  const perches: PerchPoi[] = [];
  const S = 16; // coarse cells per sector
  const H = w.height;
  const ring = (x: number, z: number) => {
    let s = 0;
    for (let k = 0; k < 8; k++) s += terrainHeight(w, x + OCT_X[k] * 30, z + OCT_Z[k] * 30);
    return s / 8;
  };
  for (let sz = 0; sz < N - 1; sz += S)
    for (let sx = 0; sx < N - 1; sx += S) {
      let best = -1, by = -Infinity;
      for (let iz = sz; iz < sz + S && iz < N; iz++)
        for (let ix = sx; ix < sx + S && ix < N; ix++) {
          const q = g.coarse[iz * N + ix];
          if (q < 0 || !(g.flags[q] & NF.Land)) continue;
          if (H[iz * N + ix] > by) { by = H[iz * N + ix]; best = q; }
        }
      if (best < 0) continue;
      const pr = g.y[best] - ring(g.x[best], g.z[best]);
      if (pr >= 8) perches.push({ x: g.x[best], y: g.y[best], z: g.z[best], node: best, prominence: pr, structure: false });
    }
  // keep the most prominent hilltop within 60 m
  perches.sort((a, b) => b.prominence - a.prominence || a.node - b.node);
  const kept: PerchPoi[] = [];
  for (const p of perches) if (!kept.some((q) => (q.x - p.x) * (q.x - p.x) + (q.z - p.z) * (q.z - p.z) < 60 * 60)) kept.push(p);
  perches.length = 0;
  perches.push(...kept);
  for (const p of g.patches) {
    if (p.cave) continue;
    let best = -1, bp = 0;
    for (let s = 0; s < p.colNodes.length; s++) {
      const q = p.colNodes[s];
      if (!(g.flags[q] & NF.Land)) continue;
      const pr = g.y[q] - terrainHeight(w, g.x[q], g.z[q]);
      if (pr > bp + 0.5 || (pr > bp - 0.01 && best < 0)) { bp = pr; best = q; }
    }
    if (best >= 0 && bp >= 4) perches.push({ x: g.x[best], y: g.y[best], z: g.z[best], node: best, prominence: bp, structure: true });
  }
  perches.sort((a, b) => b.prominence - a.prominence || a.node - b.node);
  return { pickups, perches, ziplineTops };
}

// ---------------------------------------------------------------------------
// danger map

/**
 * Coarse heat map of recent violence (eliminations, hits). bump() when
 * something happens, decay() every tick; at() samples it (bilinear) and can
 * be fed to PathOptions.danger to route around hot spots.
 */
export class DangerMap {
  readonly res: number;
  readonly n: number;
  readonly v: Float32Array;
  /** Seconds for the heat to halve. */
  halfLife: number;

  constructor(res = 16, halfLife = 30) {
    this.res = res;
    this.n = Math.ceil((2 * WORLD_HALF) / res);
    this.v = new Float32Array(this.n * this.n);
    this.halfLife = halfLife;
  }

  /** Adds `amount` with a linear falloff to zero at `radius` meters. */
  bump(x: number, z: number, amount = 1, radius = 24): void {
    const r = this.res, n = this.n;
    const c0x = Math.max(0, Math.floor((x - radius + WORLD_HALF) / r)), c1x = Math.min(n - 1, Math.floor((x + radius + WORLD_HALF) / r));
    const c0z = Math.max(0, Math.floor((z - radius + WORLD_HALF) / r)), c1z = Math.min(n - 1, Math.floor((z + radius + WORLD_HALF) / r));
    for (let cz = c0z; cz <= c1z; cz++)
      for (let cx = c0x; cx <= c1x; cx++) {
        const px = -WORLD_HALF + (cx + 0.5) * r, pz = -WORLD_HALF + (cz + 0.5) * r;
        const d = Math.sqrt((px - x) * (px - x) + (pz - z) * (pz - z));
        if (d < radius) this.v[cz * n + cx] += amount * (1 - d / radius);
      }
  }

  decay(dt: number): void {
    const f = exp((-dt * 0.6931471805599453) / this.halfLife);
    const v = this.v;
    for (let i = 0; i < v.length; i++) v[i] = v[i] < 1e-4 ? 0 : v[i] * f;
  }

  at(x: number, z: number): number {
    const r = this.res, n = this.n;
    let fx = (x + WORLD_HALF) / r - 0.5, fz = (z + WORLD_HALF) / r - 0.5;
    fx = fx < 0 ? 0 : fx > n - 1.001 ? n - 1.001 : fx;
    fz = fz < 0 ? 0 : fz > n - 1.001 ? n - 1.001 : fz;
    const ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz;
    const i = iz * n + ix, v = this.v;
    return (v[i] * (1 - tx) + v[i + 1] * tx) * (1 - tz) + (v[i + n] * (1 - tx) + v[i + n + 1] * tx) * tz;
  }

  clear(): void {
    this.v.fill(0);
  }
}
