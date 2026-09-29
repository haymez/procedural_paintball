// Navigation graph for server-side bots. Pure TS (runs in the Durable Object).
//
// Layout: one graph, three kinds of nodes, all stored in flat typed arrays.
//  - coarse nodes: one per 2 m heightfield sample that is walkable land,
//    shallow water (wade) or deep water near land (swim);
//  - structure patches: rectangles around every structure rasterized at
//    0.5 m into columns of floor "spans" (terrain, floors, stairs, roofs,
//    docks), validated against the real collision SDF. A structure patch
//    replaces the coarse nodes it covers;
//  - cave patches: 1 m columns over each cave's floor, overlaid on the coarse
//    grid (tunnels run under the terrain), linked to the surface at the mouths.
// Edges carry a cost in seconds and an action (walk, mantle, jump-down, ...).
// Special links: drops / cliff jumps (arc traced against the heightfield),
// mantles, ziplines (top -> bottom) and optional boat rides across bays.
// A region layer (32 m sectors x connected components) supports the
// hierarchical corridor search in path.ts.
import { buildCollision, CHAMBER_R, freshWater, sdf, sdfNormal, terrainHeight, type CollisionWorld } from "../world/collide";
import { N, NN, gx, toI } from "../world/grid";
import { NO_WATER, SEA_LEVEL, WORLD_HALF, isBoat, type World } from "../world/types";
import {
  Act, AGENT_H, BOAT_SPEED, DROP_LAND, DROP_STUMBLE, DROP_WATER, EDGE_SLOPE, FALL_MULT, GRAVITY, INTERACT_R,
  JUMP_SPEED, MANTLE_MAX, MAX_FALL, NF, NODE_SLOPE, RUN_SPEED, STEP_H, SWIM_DEPTH, SWIM_ENTER, SWIM_MANTLE,
  SWIM_SPEED, WADE_SPEED, WASH_DEPTH, WATER_REACH, ZIP_FEET, ZIP_GRAB_R, ZIP_MAX_SPEED, AGENT_R,
} from "./constants";

export const NO_LEVEL = -1e9;
/** Region sector size (m). */
export const SECTOR = 32;
const SECTORS = Math.ceil((2 * WORLD_HALF) / SECTOR);
const STRUCT_RES = 0.5;
const CAVE_RES = 1;
const PATCH_MARGIN = 2;

export interface NavPatch {
  /** Cave overlay (true) or structure patch that replaces the coarse grid (false). */
  cave: boolean;
  /** Structure indices (structure patch) or the cave index (cave overlay). */
  sources: number[];
  x0: number;
  z0: number;
  res: number;
  w: number;
  h: number;
  /** Owned coarse sample range, inclusive (structure patches only). */
  ix0: number;
  iz0: number;
  ix1: number;
  iz1: number;
  /** Column c = cz * w + cx holds nodes colNodes[colStart[c] .. colStart[c + 1]), highest first. */
  colStart: Int32Array;
  colNodes: Int32Array;
}

export interface NavLink {
  act: Act;
  from: number;
  to: number;
  /** Zipline index (world.ziplines) or vehicle index (world.vehicles). */
  id: number;
}

export interface NavRegions {
  count: number;
  /** Representative node (closest to the region's centroid). */
  rep: Int32Array;
  /** Weakly connected component of the region graph (0 = the biggest). */
  comp: Int32Array;
  /** Abstract edges (CSR). cls: 0 ground, 1 water, 2 zipline, 3 vehicle. */
  start: Int32Array;
  to: Int32Array;
  cost: Float32Array;
  cls: Uint8Array;
}

export interface NavStats {
  buildMs: number;
  phases: Record<string, number>;
  nodes: number;
  coarseNodes: number;
  structNodes: number;
  caveNodes: number;
  edges: number;
  regions: number;
  links: number;
  bytes: number;
}

export interface NavGraph {
  world: World;
  cw: CollisionWorld;
  radius: number;
  n: number;
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  flags: Uint8Array;
  /** Patch index of a node, -1 for coarse nodes. */
  patch: Int16Array;
  /** Grid sample index (coarse) or column index (patch) of a node. */
  cell: Int32Array;
  region: Int32Array;
  eStart: Int32Array;
  eTo: Int32Array;
  /** Seconds. */
  eCost: Float32Array;
  eAct: Uint8Array;
  /** Grid sample -> coarse node or -1. */
  coarse: Int32Array;
  /** Grid sample -> structure patch that owns it, or -1. */
  owner: Int16Array;
  /** Grid sample -> water surface (sea or fresh) or NO_LEVEL. */
  level: Float32Array;
  patches: NavPatch[];
  links: NavLink[];
  regions: NavRegions;
  stats: NavStats;
}

export interface NavBuildOptions {
  /** Clearance radius (default AGENT_R). */
  radius?: number;
  /** Add boat links across bays (default true; paths only use them with Act.Vehicle allowed). */
  boats?: boolean;
}

const perf = (globalThis as { performance?: { now(): number } }).performance;
/** Wall-clock ms for build stats only (never feeds back into results). */
export const nowMs = (): number => (perf ? perf.now() : 0);
const now = nowMs;

/** Sim-equivalent open-water surface at (x, z) (see sim/env waterAt) or NO_LEVEL. */
export function waterLevel(world: World, x: number, z: number): number {
  if (x < -WORLD_HALF || z < -WORLD_HALF || x > WORLD_HALF || z > WORLD_HALF) return SEA_LEVEL;
  const ground = terrainHeight(world, x, z);
  const fresh = freshWater(world, x, z);
  const w = fresh > SEA_LEVEL ? fresh : SEA_LEVEL;
  if (ground < w) return w;
  if (fresh > -1e8 && ground < fresh + 0.05) return fresh;
  return NO_LEVEL;
}

/** Time to fall h meters (sim falling gravity). */
export function fallTime(h: number): number {
  return h > 0 ? Math.sqrt((2 * h) / (GRAVITY * FALL_MULT)) : 0;
}

// ---------------------------------------------------------------------------
// growable edge list

class EdgeBuf {
  from: Int32Array;
  to: Int32Array;
  cost: Float32Array;
  act: Uint8Array;
  n = 0;
  constructor(cap = 1 << 16) {
    this.from = new Int32Array(cap);
    this.to = new Int32Array(cap);
    this.cost = new Float32Array(cap);
    this.act = new Uint8Array(cap);
  }
  add(a: number, b: number, c: number, act: number): void {
    if (this.n === this.from.length) {
      const m = this.n * 2;
      const f = new Int32Array(m); f.set(this.from); this.from = f;
      const t = new Int32Array(m); t.set(this.to); this.to = t;
      const cc = new Float32Array(m); cc.set(this.cost); this.cost = cc;
      const aa = new Uint8Array(m); aa.set(this.act); this.act = aa;
    }
    const k = this.n++;
    this.from[k] = a;
    this.to[k] = b;
    this.cost[k] = c;
    this.act[k] = act;
  }
}

// ---------------------------------------------------------------------------
// solid tops (structure floor candidates)

const HC = 4;
const HR = (2 * WORLD_HALF) / HC;
function hashCell(x: number, z: number): number {
  const cx = Math.floor((x + WORLD_HALF) / HC), cz = Math.floor((z + WORLD_HALF) / HC);
  if (cx < 0 || cz < 0 || cx >= HR || cz >= HR) return -1;
  return cz * HR + cx;
}

/** Top surface of solid i at (x, z) if (x, z) is over it and it is big enough to stand on, else NaN. */
function solidTop(cw: CollisionWorld, i: number, x: number, z: number): number {
  const s = cw.solids, o = i * 10;
  const dx = x - s[o + 1], dz = z - s[o + 3];
  const c = s[o + 7], sn = s[o + 8];
  const lx = dx * c - dz * sn, lz = dx * sn + dz * c;
  const shape = s[o], hx = s[o + 4], hy = s[o + 5], hz = s[o + 6];
  if (shape === 2) {
    if (hx < 0.45 || lx * lx + lz * lz > hx * hx) return NaN;
    return s[o + 2] + hy;
  }
  const ax = lx < 0 ? -lx : lx, az = lz < 0 ? -lz : lz;
  if (ax > hx || az > hz) return NaN;
  if (shape === 0) {
    if (hx < 0.3 || hz < 0.3) return NaN;
    return s[o + 2] + hy;
  }
  // wedge: ridge along local X, slopes down to +-hz
  if ((2 * hy) / hz > EDGE_SLOPE || hx < 0.3) return NaN;
  return s[o + 2] + hy - (2 * hy * az) / hz;
}

/** Is (x, z) within `m` (horizontally) of solid i's footprint? */
function solidNear(cw: CollisionWorld, i: number, x: number, z: number, m: number): boolean {
  const s = cw.solids, o = i * 10;
  const dx = x - s[o + 1], dz = z - s[o + 3];
  if (s[o] === 2) {
    const r = s[o + 4] + m;
    return dx * dx + dz * dz <= r * r;
  }
  const c = s[o + 7], sn = s[o + 8];
  const lx = dx * c - dz * sn, lz = dx * sn + dz * c;
  return (lx < 0 ? -lx : lx) <= s[o + 4] + m && (lz < 0 ? -lz : lz) <= s[o + 6] + m;
}

// ---------------------------------------------------------------------------
// builder (split into small methods so V8 optimizes each hot loop)

interface Temp {
  /** Per patch: column counts then spans (y, flags, offset from the column centre) in column order. */
  colCount: Int32Array;
  ys: number[];
  fs: number[];
  ox: number[];
  oz: number[];
}

/** Sub-cell offsets tried when a column centre is too close to a wall (doorways, stairs). */
const OFF = 0.17;
const OFF_X = [OFF, -OFF, 0, 0, OFF, OFF, -OFF, -OFF], OFF_Z = [0, 0, OFF, -OFF, OFF, -OFF, OFF, -OFF];
/** Candidate floor sources. */
const SRC_TERRAIN = -1, SRC_PROBE = -2;

/**
 * Highest floor at or below y0 within maxDown (sphere-trace + bisection, robust
 * to the non-Lipschitz noisy cave walls), NaN if none or if y0 is inside rock.
 */
export function probeFloor(cw: CollisionWorld, x: number, y0: number, z: number, maxDown: number): number {
  let y = y0;
  let d = sdf(cw, x, y, z);
  if (d < 0) return NaN;
  for (let it = 0; it < 64; it++) {
    let step = d * 0.9;
    if (step < 0.02) step = 0.02;
    const ny = y - step;
    const nd = sdf(cw, x, ny, z);
    if (nd <= 0.004) {
      let lo = ny, hi = y;
      for (let k = 0; k < 6; k++) {
        const m = (lo + hi) * 0.5;
        if (sdf(cw, x, m, z) > 0.004) hi = m;
        else lo = m;
      }
      return hi;
    }
    y = ny;
    d = nd;
    if (y0 - y > maxDown) return NaN;
  }
  return NaN;
}

const DX = [1, 1, 0, -1, -1, -1, 0, 1], DZ = [0, 1, 1, 1, 0, -1, -1, -1];
const SQ2 = 1.4142135623730951;

class Builder {
  readonly world: World;
  readonly cw: CollisionWorld;
  readonly R: number;
  readonly H: Float32Array;
  readonly level = new Float32Array(NN);
  /** 0 none, 1 land, 2 wade, 3 swim */
  readonly kind = new Uint8Array(NN);
  readonly dry = new Uint8Array(NN);
  readonly owner = new Int16Array(NN).fill(-1);
  readonly coarse = new Int32Array(NN).fill(-1);
  patches: NavPatch[] = [];
  temps: Temp[] = [];
  caveEdge0: number[] = [];
  caveCh0: number[] = [];
  n = 0;
  nCoarse = 0;
  nStruct = 0;
  nCave = 0;
  X = new Float32Array(0);
  Y = new Float32Array(0);
  Z = new Float32Array(0);
  F = new Uint8Array(0);
  P = new Int16Array(0);
  CELLI = new Int32Array(0);
  eb!: EdgeBuf;
  private cands: number[] = [];
  private candF: number[] = [];

  constructor(world: World, cw: CollisionWorld, R: number) {
    this.world = world;
    this.cw = cw;
    this.R = R;
    this.H = world.height;
  }

  // ---------------------------------------------------------------- cells
  classify(): void {
    const H = this.H, water = this.world.water, holes = this.world.holes, level = this.level, kind = this.kind, dry = this.dry;
    const inv2 = 1 / (2 * 2); // central differences over 2 cells of 2 m
    for (let iz = 0; iz < N; iz++) {
      const z0 = iz > 0 ? iz - 1 : iz, z1 = iz < N - 1 ? iz + 1 : iz;
      const fz = (z1 - z0) === 2 ? inv2 : 0.5;
      for (let ix = 0; ix < N; ix++) {
        const i = iz * N + ix;
        const h = H[i], fw = water[i];
        const fresh = fw === NO_WATER ? -Infinity : fw;
        const w = fresh > SEA_LEVEL ? fresh : SEA_LEVEL;
        let lv = NO_LEVEL;
        if (h < w) lv = w;
        else if (fresh > -1e8 && h < fresh + 0.05) lv = fresh;
        level[i] = lv;
        if (lv === NO_LEVEL) dry[i] = 1;
        else if (lv - h >= SWIM_ENTER) { kind[i] = 3; continue; }
        if (holes[i]) continue;
        const x0 = ix > 0 ? ix - 1 : ix, x1 = ix < N - 1 ? ix + 1 : ix;
        const fx = (x1 - x0) === 2 ? inv2 : 0.5;
        const gxv = (H[iz * N + x1] - H[iz * N + x0]) * fx, gzv = (H[z1 * N + ix] - H[z0 * N + ix]) * fz;
        const s2 = gxv * gxv + gzv * gzv;
        if (lv === NO_LEVEL) { if (s2 <= NODE_SLOPE * NODE_SLOPE) kind[i] = 1; }
        else if (s2 <= EDGE_SLOPE * EDGE_SLOPE) kind[i] = 2;
      }
    }
  }

  /** Drops swim / wade cells farther than WATER_REACH (chessboard distance) from dry land. */
  waterReach(): void {
    const d = new Uint8Array(NN), dry = this.dry, kind = this.kind;
    this.kind0 = kind.slice();
    for (let i = 0; i < NN; i++) d[i] = dry[i] ? 0 : 255;
    for (let iz = 0; iz < N; iz++)
      for (let ix = 0; ix < N; ix++) {
        const i = iz * N + ix;
        let m = d[i];
        if (m === 0) continue;
        if (ix > 0 && d[i - 1] + 1 < m) m = d[i - 1] + 1;
        if (iz > 0) {
          if (d[i - N] + 1 < m) m = d[i - N] + 1;
          if (ix > 0 && d[i - N - 1] + 1 < m) m = d[i - N - 1] + 1;
          if (ix < N - 1 && d[i - N + 1] + 1 < m) m = d[i - N + 1] + 1;
        }
        d[i] = m;
      }
    for (let iz = N - 1; iz >= 0; iz--)
      for (let ix = N - 1; ix >= 0; ix--) {
        const i = iz * N + ix;
        let m = d[i];
        if (m === 0) continue;
        if (ix < N - 1 && d[i + 1] + 1 < m) m = d[i + 1] + 1;
        if (iz < N - 1) {
          if (d[i + N] + 1 < m) m = d[i + N] + 1;
          if (ix > 0 && d[i + N - 1] + 1 < m) m = d[i + N - 1] + 1;
          if (ix < N - 1 && d[i + N + 1] + 1 < m) m = d[i + N + 1] + 1;
        }
        d[i] = m;
        if (m > WATER_REACH && kind[i] > 1) kind[i] = 0;
      }
  }

  kind0 = new Uint8Array(0);

  /**
   * Islets farther than WATER_REACH from the main island lost their water
   * link: keep the shortest open-water corridor (3 cells wide) back to it.
   */
  bridgeIslands(): void {
    const kind = this.kind, kind0 = this.kind0;
    const label = new Int32Array(NN).fill(-1);
    const stack = new Int32Array(NN);
    const land: number[] = [], wet: number[] = [];
    let nl = 0;
    for (let s0 = 0; s0 < NN; s0++) {
      if (!kind[s0] || label[s0] >= 0) continue;
      let sp = 0, lc = 0, wc = 0;
      stack[sp++] = s0;
      label[s0] = nl;
      while (sp > 0) {
        const i = stack[--sp];
        if (kind[i] === 1) lc++;
        else if (kind[i] === 3) wc++;
        const ix = i % N, iz = (i - ix) / N;
        for (let k = 0; k < 8; k++) {
          const jx = ix + DX[k], jz = iz + DZ[k];
          if (jx < 0 || jz < 0 || jx >= N || jz >= N) continue;
          const j = jz * N + jx;
          if (kind[j] && label[j] < 0) { label[j] = nl; stack[sp++] = j; }
        }
      }
      land.push(lc);
      wet.push(wc);
      nl++;
    }
    let main = 0;
    for (let c = 1; c < nl; c++) if (land[c] > land[main]) main = c;
    let others = 0;
    // islets: separate land with its own ring of deep water (not plateaus cut off by cliffs)
    for (let c = 0; c < nl; c++) if (c !== main && land[c] >= 4 && wet[c] > 0) others++;
    if (others === 0) return;
    // BFS outward from the main island's kept water through the cut-off open
    // water; the first time it touches an islet, walk back and keep that corridor
    const par = new Int32Array(NN).fill(-2);
    let qh = 0, qt = 0;
    for (let i = 0; i < NN; i++) if (label[i] === main && kind[i] >= 2) { par[i] = -1; stack[qt++] = i; }
    const done = new Uint8Array(nl);
    let left = others;
    while (qh < qt && left > 0) {
      const i = stack[qh++];
      const ix = i % N, iz = (i - ix) / N;
      for (let k = 0; k < 8; k++) {
        const jx = ix + DX[k], jz = iz + DZ[k];
        if (jx < 0 || jz < 0 || jx >= N || jz >= N) continue;
        const j = jz * N + jx;
        const c = label[j];
        if (c >= 0 && c !== main && !done[c] && land[c] >= 4 && wet[c] > 0) {
          done[c] = 1;
          left--;
          for (let q = i; q >= 0 && label[q] !== main; q = par[q]) {
            const qx = q % N, qz = (q - qx) / N;
            for (let oz = -1; oz <= 1; oz++)
              for (let ox = -1; ox <= 1; ox++) {
                const rx = qx + ox, rz = qz + oz;
                if (rx < 0 || rz < 0 || rx >= N || rz >= N) continue;
                const r = rz * N + rx;
                if (!kind[r] && kind0[r] >= 2) kind[r] = kind0[r];
              }
          }
        }
        if (par[j] !== -2 || kind[j] || kind0[j] < 2) continue;
        par[j] = i;
        stack[qt++] = j;
      }
    }
  }

  nodeY(i: number): number {
    return this.kind[i] === 3 ? this.level[i] - SWIM_DEPTH : this.H[i];
  }

  /** Props block the samples whose capsule they intersect. */
  blockProps(): void {
    const p = this.cw.props, kind = this.kind, R = this.R;
    for (let k = 0; k < this.cw.nProps; k++) {
      const o = k * 5;
      const px = p[o], y0 = p[o + 1], pz = p[o + 2], rr = p[o + 3] + R, y1 = p[o + 4];
      const i0 = toI(px - rr), i1 = toI(px + rr), j0 = toI(pz - rr), j1 = toI(pz + rr);
      for (let jz = j0; jz <= j1; jz++)
        for (let jx = i0; jx <= i1; jx++) {
          const i = jz * N + jx;
          if (!kind[i]) continue;
          const dx = gx(jx) - px, dz = gx(jz) - pz;
          if (dx * dx + dz * dz > rr * rr) continue;
          const ys = this.nodeY(i);
          if (ys + AGENT_H > y0 && ys < y1 + 0.1) kind[i] = 0;
        }
    }
  }

  // ---------------------------------------------------------------- patches
  makePatches(): void {
    const world = this.world, patches = this.patches, owner = this.owner;
    const rects: { ix0: number; iz0: number; ix1: number; iz1: number; src: number[] }[] = [];
    const c = (v: number) => (v < 0 ? 0 : v > N - 1 ? N - 1 : v);
    world.structures.forEach((st, si) => {
      if (st.solids.length === 0) return;
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const s of st.solids) {
        const r = s.shape === "cylinder" ? s.hx : Math.sqrt(s.hx * s.hx + s.hz * s.hz);
        if (s.cx - r < x0) x0 = s.cx - r;
        if (s.cx + r > x1) x1 = s.cx + r;
        if (s.cz - r < z0) z0 = s.cz - r;
        if (s.cz + r > z1) z1 = s.cz + r;
      }
      rects.push({
        ix0: c(Math.floor((x0 - PATCH_MARGIN + WORLD_HALF) / 2)), iz0: c(Math.floor((z0 - PATCH_MARGIN + WORLD_HALF) / 2)),
        ix1: c(Math.ceil((x1 + PATCH_MARGIN + WORLD_HALF) / 2)), iz1: c(Math.ceil((z1 + PATCH_MARGIN + WORLD_HALF) / 2)),
        src: [si],
      });
    });
    for (let merged = true; merged;) {
      merged = false;
      for (let a = 0; a < rects.length && !merged; a++)
        for (let b = a + 1; b < rects.length; b++) {
          const A = rects[a], B = rects[b];
          if (A.ix0 > B.ix1 + 1 || B.ix0 > A.ix1 + 1 || A.iz0 > B.iz1 + 1 || B.iz0 > A.iz1 + 1) continue;
          A.ix0 = Math.min(A.ix0, B.ix0); A.iz0 = Math.min(A.iz0, B.iz0);
          A.ix1 = Math.max(A.ix1, B.ix1); A.iz1 = Math.max(A.iz1, B.iz1);
          A.src.push(...B.src);
          rects.splice(b, 1);
          merged = true;
          break;
        }
    }
    for (const r of rects) {
      const pi = patches.length;
      const w = (r.ix1 - r.ix0 + 1) * (2 / STRUCT_RES), h = (r.iz1 - r.iz0 + 1) * (2 / STRUCT_RES);
      patches.push({
        cave: false, sources: r.src.sort((a, b) => a - b), x0: gx(r.ix0) - 1, z0: gx(r.iz0) - 1, res: STRUCT_RES, w, h,
        ix0: r.ix0, iz0: r.iz0, ix1: r.ix1, iz1: r.iz1, colStart: new Int32Array(w * h + 1), colNodes: new Int32Array(0),
      });
      for (let iz = r.iz0; iz <= r.iz1; iz++) for (let ix = r.ix0; ix <= r.ix1; ix++) owner[iz * N + ix] = pi;
    }
    world.caves.forEach((cave, ci) => {
      if (cave.nodes.length === 0) return;
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const n of cave.nodes) {
        x0 = Math.min(x0, n.x - n.r - 1); x1 = Math.max(x1, n.x + n.r + 1);
        z0 = Math.min(z0, n.z - n.r - 1); z1 = Math.max(z1, n.z + n.r + 1);
      }
      x0 = Math.floor(x0); z0 = Math.floor(z0);
      const w = Math.ceil((x1 - x0) / CAVE_RES), h = Math.ceil((z1 - z0) / CAVE_RES);
      patches.push({
        cave: true, sources: [ci], x0, z0, res: CAVE_RES, w, h, ix0: -1, iz0: -1, ix1: -2, iz1: -2,
        colStart: new Int32Array(w * h + 1), colNodes: new Int32Array(0),
      });
    });
    // per-cave ranges into cw.cave's edge / chamber arrays (same order as collide.prepCaves)
    let e = 0, ch = 0;
    for (const cave of world.caves) {
      this.caveEdge0.push(e);
      this.caveCh0.push(ch);
      e += cave.edges.length;
      for (const n of cave.nodes) if (n.r >= CHAMBER_R) ch++;
    }
    this.caveEdge0.push(e);
    this.caveCh0.push(ch);
  }

  private floorAt(src: number, x: number, yHint: number, z: number): number {
    if (src === SRC_TERRAIN) return this.world.holes[toI(z) * N + toI(x)] ? NaN : terrainHeight(this.world, x, z);
    if (src === SRC_PROBE) return probeFloor(this.cw, x, yHint + 0.8, z, 1.6);
    return solidTop(this.cw, src, x, z);
  }

  /**
   * Can the sim body stand here? Legs + body sphere must be clear; the head
   * sphere may touch a flat ceiling (the grounded sim ignores near-vertical
   * contact normals, so you can walk up stairs under a low landing).
   */
  private landOk(x: number, yf: number, z: number): boolean {
    const cw = this.cw, R = this.R;
    if (sdf(cw, x, yf + 0.08, z) < 0.02 || sdf(cw, x, yf + STEP_H + R, z) < R) return false;
    const hy = yf + AGENT_H - R;
    if (sdf(cw, x, hy, z) >= R) return true;
    return sdfNormal(cw, x, hy, z, this.nrm).y < -0.9;
  }
  private nrm = { x: 0, y: 1, z: 0 };

  private swimOk(x: number, lv: number, z: number): boolean {
    return sdf(this.cw, x, lv - 0.5, z) >= this.R * 0.9 && sdf(this.cw, x, lv + 0.2, z) >= this.R * 0.8;
  }

  private sortCands(): void {
    const c = this.cands, f = this.candF;
    for (let a = 1; a < c.length; a++) {
      const v = c[a], fv = f[a];
      let b = a - 1;
      while (b >= 0 && c[b] < v) { c[b + 1] = c[b]; f[b + 1] = f[b]; b--; }
      c[b + 1] = v;
      f[b + 1] = fv;
    }
  }

  /** Validates the column's candidate floors (sorted high -> low) and appends its spans. */
  private emitColumn(tmp: Temp, col: number, x: number, z: number, isCave: boolean, open = false): void {
    const cands = this.cands, candF = this.candF;
    const lv = waterLevel(this.world, x, z);
    const th = isCave ? terrainHeight(this.world, x, z) : 0;
    const extra = isCave ? 0 : NF.Struct;
    let last = Infinity, swimDone = false, count = 0;
    for (let k = 0; k < cands.length; k++) {
      let yf = cands[k];
      if (last - yf < (isCave ? 0.6 : 0.3)) continue;
      let f = 0;
      if (lv > NO_LEVEL && yf < lv) {
        if (lv - yf >= SWIM_ENTER) {
          if (swimDone) continue;
          swimDone = true;
          if (!open && !this.swimOk(x, lv, z)) continue;
          tmp.ys.push(lv - SWIM_DEPTH);
          tmp.fs.push(NF.Swim | (lv - yf >= WASH_DEPTH ? NF.Wash : 0) | extra);
          tmp.ox.push(0);
          tmp.oz.push(0);
          last = yf;
          count++;
          continue;
        }
        f |= NF.Wade;
      } else f |= NF.Land;
      let ox = 0, oz = 0;
      if (!open && !this.landOk(x, yf, z)) {
        // too close to a wall at the column centre: try sub-cell positions (doorways, stairs)
        let found = false;
        for (let o = 0; o < 8 && !found; o++) {
          const y2 = this.floorAt(candF[k], x + OFF_X[o], yf, z + OFF_Z[o]);
          if (!(Math.abs(y2 - yf) < 0.3)) continue;
          if (this.landOk(x + OFF_X[o], y2, z + OFF_Z[o])) { found = true; ox = OFF_X[o]; oz = OFF_Z[o]; yf = y2; }
        }
        if (!found) continue;
      }
      if (isCave && th > yf + 2.2) f |= NF.Cave;
      tmp.ys.push(yf);
      tmp.fs.push(f | extra);
      tmp.ox.push(ox);
      tmp.oz.push(oz);
      last = yf;
      count++;
    }
    tmp.colCount[col] = count;
  }

  rasterStruct(p: NavPatch, tmp: Temp): void {
    const world = this.world, cw = this.cw, sg = cw.solidGrid, holes = world.holes;
    const cands = this.cands, candF = this.candF;
    for (let cz = 0; cz < p.h; cz++)
      for (let cx = 0; cx < p.w; cx++) {
        const x = p.x0 + (cx + 0.5) * p.res, z = p.z0 + (cz + 0.5) * p.res;
        cands.length = 0;
        candF.length = 0;
        if (!holes[toI(z) * N + toI(x)]) {
          const th = terrainHeight(world, x, z);
          const gxs = terrainHeight(world, x + 0.5, z) - terrainHeight(world, x - 0.5, z);
          const gzs = terrainHeight(world, x, z + 0.5) - terrainHeight(world, x, z - 0.5);
          if (gxs * gxs + gzs * gzs <= NODE_SLOPE * NODE_SLOPE) { cands.push(th); candF.push(SRC_TERRAIN); }
        }
        const cell = hashCell(x, z);
        let near = false;
        if (cell >= 0)
          for (let k = sg.start[cell], e = sg.start[cell + 1]; k < e; k++) {
            const top = solidTop(cw, sg.items[k], x, z);
            if (top === top) { cands.push(top); candF.push(sg.items[k]); }
            if (!near && solidNear(cw, sg.items[k], x, z, this.R + 0.3)) near = true;
          }
        if (cands.length === 0) continue;
        // open ground (no solid, prop or cave close by): the terrain floor needs no SDF checks
        const open = !near && cell >= 0 && cw.cave.grid.start[cell] === cw.cave.grid.start[cell + 1] && !this.propNear(cell, x, z);
        this.sortCands();
        this.emitColumn(tmp, cz * p.w + cx, x, z, false, open);
      }
  }

  private probed: number[] = [];

  private propNear(cell: number, x: number, z: number): boolean {
    const pg = this.cw.propGrid, pp = this.cw.props;
    for (let k = pg.start[cell], e = pg.start[cell + 1]; k < e; k++) {
      const o = pg.items[k] * 5;
      const dx = pp[o] - x, dz = pp[o + 2] - z, r = pp[o + 3] + this.R + 0.2;
      if (dx * dx + dz * dz < r * r) return true;
    }
    return false;
  }

  rasterCave(p: NavPatch, tmp: Temp): void {
    const cw = this.cw, cv = cw.cave;
    const ci = p.sources[0];
    const e0 = this.caveEdge0[ci], e1 = this.caveEdge0[ci + 1], c0 = this.caveCh0[ci], c1 = this.caveCh0[ci + 1];
    const E = cv.e, C = cv.c, g = cv.grid;
    const cands = this.cands, candF = this.candF;
    for (let cz = 0; cz < p.h; cz++)
      for (let cx = 0; cx < p.w; cx++) {
        const x = p.x0 + (cx + 0.5) * p.res, z = p.z0 + (cz + 0.5) * p.res;
        const cell = hashCell(x, z);
        if (cell < 0 || g.start[cell] === g.start[cell + 1]) continue;
        cands.length = 0;
        candF.length = 0;
        this.probed.length = 0;
        for (let k = g.start[cell], e = g.start[cell + 1]; k < e; k++) {
          const id = g.items[k];
          let fl = NaN;
          if (id < cv.ne) {
            if (id < e0 || id >= e1) continue;
            const o = id * 10;
            const ax = E[o], az = E[o + 2], ux = E[o + 3] - ax, uz = E[o + 5] - az;
            const l2 = ux * ux + uz * uz;
            let u = l2 > 0 ? ((x - ax) * ux + (z - az) * uz) / l2 : 0;
            u = u < 0 ? 0 : u > 1 ? 1 : u;
            const qx = ax + ux * u - x, qz = az + uz * u - z;
            const r = E[o + 6] + (E[o + 7] - E[o + 6]) * u;
            // generous footprint: overlapping voids and wobbly walls move the real floor
            if (qx * qx + qz * qz <= r * r) fl = E[o + 8] + (E[o + 9] - E[o + 8]) * u;
          } else {
            const cid = id - cv.ne;
            if (cid < c0 || cid >= c1) continue;
            const o = cid * 5;
            const dx = x - C[o], dz = z - C[o + 2], lim = 0.95 * C[o + 3];
            if (dx * dx + dz * dz <= lim * lim) fl = C[o + 4];
          }
          if (fl !== fl) continue;
          // one probe per distinct analytic floor
          let seenFl = false;
          for (let q = 0; q < this.probed.length; q++) if (Math.abs(this.probed[q] - fl) < 0.8) seenFl = true;
          if (seenFl) continue;
          this.probed.push(fl);
          // refine against the real SDF (walls wobble, tubes overlap)
          let gy = probeFloor(cw, x, fl + 1.2, z, 3.2);
          if (gy !== gy) gy = probeFloor(cw, x, fl + 2.2, z, 4.2);
          if (!(gy > fl - 3.0)) continue;
          let dup = false;
          for (let q = 0; q < cands.length; q++) if (Math.abs(cands[q] - gy) < 0.3) dup = true;
          if (dup) continue;
          cands.push(gy);
          candF.push(SRC_PROBE);
        }
        if (cands.length === 0) continue;
        this.sortCands();
        this.emitColumn(tmp, cz * p.w + cx, x, z, true);
      }
  }

  caveMs = 0;
  rasterPatches(): void {
    for (const p of this.patches) {
      const tmp: Temp = { colCount: new Int32Array(p.w * p.h), ys: [], fs: [], ox: [], oz: [] };
      this.temps.push(tmp);
      const t = now();
      if (p.cave) this.rasterCave(p, tmp);
      else this.rasterStruct(p, tmp);
      if (p.cave) this.caveMs += now() - t;
    }
  }

  // ---------------------------------------------------------------- nodes
  createNodes(): void {
    const kind = this.kind, owner = this.owner, H = this.H, level = this.level, coarse = this.coarse;
    let nCoarse = 0;
    for (let i = 0; i < NN; i++) if (kind[i] && owner[i] < 0) nCoarse++;
    let nPatch = 0;
    for (let k = 0; k < this.patches.length; k++) {
      const c = this.temps[k].ys.length;
      nPatch += c;
      if (this.patches[k].cave) this.nCave += c;
      else this.nStruct += c;
    }
    const n = nCoarse + nPatch;
    this.n = n;
    this.nCoarse = nCoarse;
    const X = (this.X = new Float32Array(n)), Y = (this.Y = new Float32Array(n)), Z = (this.Z = new Float32Array(n));
    const F = (this.F = new Uint8Array(n)), P = (this.P = new Int16Array(n)), CELLI = (this.CELLI = new Int32Array(n));
    let id = 0;
    for (let iz = 0; iz < N; iz++)
      for (let ix = 0; ix < N; ix++) {
        const i = iz * N + ix;
        const k = kind[i];
        if (!k || owner[i] >= 0) continue;
        coarse[i] = id;
        X[id] = gx(ix);
        Z[id] = gx(iz);
        Y[id] = k === 3 ? level[i] - SWIM_DEPTH : H[i];
        F[id] = NF.Coarse | (k === 1 ? NF.Land : k === 2 ? NF.Wade : NF.Swim) | (k === 3 && level[i] - H[i] >= WASH_DEPTH ? NF.Wash : 0);
        P[id] = -1;
        CELLI[id] = i;
        id++;
      }
    for (let pi = 0; pi < this.patches.length; pi++) {
      const p = this.patches[pi], tmp = this.temps[pi];
      const cols = p.w * p.h;
      p.colNodes = new Int32Array(tmp.ys.length);
      let s = 0;
      for (let c = 0; c < cols; c++) {
        p.colStart[c] = s;
        const cnt = tmp.colCount[c];
        if (cnt === 0) continue;
        const cx = c % p.w, cz = (c - cx) / p.w;
        for (let k = 0; k < cnt; k++) {
          X[id] = p.x0 + (cx + 0.5) * p.res + tmp.ox[s];
          Z[id] = p.z0 + (cz + 0.5) * p.res + tmp.oz[s];
          Y[id] = tmp.ys[s];
          F[id] = tmp.fs[s];
          P[id] = pi;
          CELLI[id] = c;
          p.colNodes[s] = id;
          s++;
          id++;
        }
      }
      p.colStart[cols] = s;
    }
    this.eb = new EdgeBuf(nCoarse * 8 + nPatch * 9 + 1024);
  }

  // ---------------------------------------------------------------- edges
  private surf(a: number): number {
    return this.F[a] & NF.Swim ? this.Y[a] + SWIM_DEPTH : NO_LEVEL;
  }

  /** Adjacent move a -> b over horizontal distance d (walk / wade / cave / swim / mantle / enter-exit water). */
  addPair(a: number, b: number, d: number, lim: number, ortho: boolean): void {
    const F = this.F, Y = this.Y, eb = this.eb;
    const fa = F[a], fb = F[b];
    const ya = Y[a], yb = Y[b];
    const dy = yb - ya;
    const sa = fa & NF.Swim, sb = fb & NF.Swim;
    if (!sa && !sb) {
      if (dy <= lim && dy >= -lim) {
        const len = Math.sqrt(d * d + dy * dy);
        const act = (fa | fb) & NF.Cave ? Act.Cave : (fa | fb) & NF.Wade ? Act.Wade : Act.Walk;
        eb.add(a, b, len / (act === Act.Wade ? WADE_SPEED : RUN_SPEED) + (dy > 0 ? dy * 0.08 : 0), act);
      } else if (ortho && dy > lim && dy <= MANTLE_MAX && sdf(this.cw, this.X[a], yb + AGENT_H - this.R, this.Z[a]) >= this.R * 0.7) {
        eb.add(a, b, d / RUN_SPEED + 0.9, Act.Mantle);
      }
      return;
    }
    if (sa && sb) {
      if (dy <= 0.6 && dy >= -0.6) eb.add(a, b, Math.sqrt(d * d + dy * dy) / SWIM_SPEED, Act.Swim);
      else if (dy < 0 && -dy <= DROP_WATER) eb.add(a, b, d / SWIM_SPEED + fallTime(-dy) + 1, Act.Dive);
      return;
    }
    if (!sa) {
      const above = ya - this.surf(b);
      if (above <= SWIM_MANTLE) eb.add(a, b, Math.sqrt(d * d + dy * dy) / SWIM_SPEED + 0.2, Act.Swim);
      else if (above <= DROP_WATER) eb.add(a, b, fallTime(above) + 0.8, Act.Dive);
      return;
    }
    const ledge = yb - this.surf(a);
    if (ledge <= 0.35) eb.add(a, b, Math.sqrt(d * d + dy * dy) / SWIM_SPEED + 0.2, Act.Swim);
    else if (ledge <= SWIM_MANTLE) eb.add(a, b, d / SWIM_SPEED + 1.0, Act.Mantle);
  }

  /** Does a prop capsule cut the segment a-b (feet heights ya, yb)? */
  propCuts(ax: number, ya: number, az: number, bx: number, yb: number, bz: number): boolean {
    const cell = hashCell((ax + bx) * 0.5, (az + bz) * 0.5);
    if (cell < 0) return false;
    const pg = this.cw.propGrid;
    const k0 = pg.start[cell], k1 = pg.start[cell + 1];
    if (k0 === k1) return false;
    const pp = this.cw.props;
    const lo = ya < yb ? ya : yb, hi = (ya > yb ? ya : yb) + AGENT_H;
    const sx = bx - ax, sz = bz - az, l2 = sx * sx + sz * sz;
    const R = this.R * 0.9;
    for (let k = k0; k < k1; k++) {
      const o = pg.items[k] * 5;
      if (pp[o + 4] < lo || pp[o + 1] > hi) continue;
      let u = l2 > 0 ? ((pp[o] - ax) * sx + (pp[o + 2] - az) * sz) / l2 : 0;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const qx = ax + sx * u - pp[o], qz = az + sz * u - pp[o + 2];
      const rr = pp[o + 3] + R;
      if (qx * qx + qz * qz < rr * rr) return true;
    }
    return false;
  }

  coarseEdges(): void {
    const coarse = this.coarse, CELLI = this.CELLI, X = this.X, Y = this.Y, Z = this.Z;
    for (let a = 0; a < this.nCoarse; a++) {
      const i = CELLI[a], ix = i % N, iz = (i - ix) / N;
      for (let k = 0; k < 4; k++) {
        const jx = ix + DX[k], jz = iz + DZ[k];
        if (jx < 0 || jz >= N || jx >= N) continue;
        const b = coarse[jz * N + jx];
        if (b < 0) continue;
        const diag = (k & 1) === 1;
        // diagonal past blocked samples: props are caught by propCuts; for steep
        // samples make sure the diagonal doesn't cross a bump or a gully
        if (diag && (coarse[iz * N + jx] < 0 || coarse[jz * N + ix] < 0)) {
          const mid = terrainHeight(this.world, (X[a] + X[b]) * 0.5, (Z[a] + Z[b]) * 0.5);
          const lin = (Y[a] + Y[b]) * 0.5;
          if (mid - lin > 0.7 || lin - mid > 0.7 || this.owner[iz * N + jx] >= 0 || this.owner[jz * N + ix] >= 0) continue;
        }
        if (this.propCuts(X[a], Y[a], Z[a], X[b], Y[b], Z[b])) continue;
        const d = diag ? 2 * SQ2 : 2;
        this.addPair(a, b, d, EDGE_SLOPE * d, !diag);
        this.addPair(b, a, d, EDGE_SLOPE * d, !diag);
      }
    }
  }

  /** Drops / cliff jumps from coarse nodes: trace a running jump arc over the heightfield. */
  coarseDrops(): void {
    const coarse = this.coarse, owner = this.owner, H = this.H, F = this.F, Y = this.Y, CELLI = this.CELLI;
    for (let a = 0; a < this.nCoarse; a++) {
      if (F[a] & NF.Swim) continue;
      const i = CELLI[a], ix = i % N, iz = (i - ix) / N;
      const ya = Y[a];
      for (let k = 0; k < 8; k++) {
        const jx = ix + DX[k], jz = iz + DZ[k];
        if (jx < 0 || jz < 0 || jx >= N || jz >= N) continue;
        const j = jz * N + jx;
        if (owner[j] >= 0) continue;
        const b0 = coarse[j];
        if (b0 >= 0) {
          if (F[b0] & NF.Swim) continue; // adjacent water handled by addPair
          if (ya - Y[b0] <= EDGE_SLOPE * ((k & 1) === 1 ? 2 * SQ2 : 2)) continue; // walkable neighbour
        } else if (H[j] > ya - 1) continue; // rising ground / wall / prop, not a drop
        this.traceDrop(a, k);
      }
    }
  }

  private traceDrop(a: number, k: number): void {
    const world = this.world, level = this.level, coarse = this.coarse, owner = this.owner, F = this.F, Y = this.Y;
    const inv = (k & 1) === 1 ? 0.7071067811865476 : 1;
    const vx = DX[k] * inv * RUN_SPEED, vz = DZ[k] * inv * RUN_SPEED;
    const ya = Y[a];
    let px = this.X[a], py = ya + 0.05, pz = this.Z[a], vy = JUMP_SPEED * 0.85;
    const dt = 0.04;
    for (let t = dt; t < 3.2; t += dt) {
      vy -= (vy > 0 ? GRAVITY : GRAVITY * FALL_MULT) * dt;
      if (vy < -MAX_FALL) vy = -MAX_FALL;
      px += vx * dt; pz += vz * dt; py += vy * dt;
      if (px < -WORLD_HALF || pz < -WORLD_HALF || px > WORLD_HALF || pz > WORLD_HALF) return;
      const si = toI(pz) * N + toI(px);
      if (owner[si] >= 0) return;
      const tg = terrainHeight(world, px, pz);
      const lv = level[si];
      if (lv > NO_LEVEL && py <= lv) {
        if (lv - tg < 2.2) return; // shallow: belly-flop onto the seabed isn't a plan
        const b = coarse[si];
        if (b >= 0 && F[b] & NF.Swim && ya - lv <= DROP_WATER) this.eb.add(a, b, t + 1.0, Act.Dive);
        return;
      }
      if (py <= tg) {
        if (ya - tg > DROP_LAND) return;
        let b = coarse[si], slide = 0;
        if (b < 0) {
          // landed on a slope too steep to stand on: the sim slides you down it
          const r = this.slideDown(si);
          if (r < 0) return;
          b = r & 0xfffffff;
          slide = r >>> 28;
        }
        const drop = ya - Y[b];
        if (drop < 1) return;
        const cost = t + 0.4 + (ya - tg > DROP_STUMBLE ? 0.6 : 0) + slide * 0.5;
        this.eb.add(a, b, cost, F[b] & NF.Swim ? Act.Dive : Act.JumpDown);
        return;
      }
    }
  }

  /**
   * Follows the steepest descent from grid sample i until it reaches a node.
   * Returns node | (steps / 2) << 28 (steps capped), or -1.
   */
  private slideDown(i: number): number {
    const H = this.H, coarse = this.coarse, owner = this.owner, level = this.level;
    for (let step = 0; step < 24; step++) {
      if (owner[i] >= 0) return -1;
      const b = coarse[i];
      if (b >= 0) return b | (Math.min(7, step >> 1) << 28);
      if (level[i] > NO_LEVEL) return -1;
      const ix = i % N, iz = (i - ix) / N;
      let best = -1, bh = H[i] - 0.05, near = -1, nearD = 1.2;
      for (let k = 0; k < 8; k++) {
        const jx = ix + DX[k], jz = iz + DZ[k];
        if (jx < 0 || jz < 0 || jx >= N || jz >= N) continue;
        const j = jz * N + jx;
        if (H[j] < bh) { bh = H[j]; best = j; }
        const q = coarse[j];
        if (q >= 0 && Math.abs(this.Y[q] - H[i]) < nearD) { nearD = Math.abs(this.Y[q] - H[i]); near = q; }
      }
      if (best < 0) return near >= 0 ? near | (Math.min(7, step >> 1) << 28) : -1;
      i = best;
    }
    return -1;
  }

  private spanNear(p: NavPatch, cx: number, cz: number, y: number, lim: number): boolean {
    if (cx < 0 || cz < 0 || cx >= p.w || cz >= p.h) return false;
    const c = cz * p.w + cx, Y = this.Y;
    for (let s = p.colStart[c]; s < p.colStart[c + 1]; s++) {
      const dy = Y[p.colNodes[s]] - y;
      if (dy <= lim && dy >= -lim) return true;
    }
    return false;
  }

  patchEdges(p: NavPatch): void {
    const res = p.res, Y = this.Y, F = this.F;
    const limO = Math.max(0.55, EDGE_SLOPE * res), limD = Math.max(0.55, EDGE_SLOPE * res * SQ2);
    for (let cz = 0; cz < p.h; cz++)
      for (let cx = 0; cx < p.w; cx++) {
        const c = cz * p.w + cx;
        for (let s = p.colStart[c]; s < p.colStart[c + 1]; s++) {
          const a = p.colNodes[s];
          const ya = Y[a];
          const swimA = F[a] & NF.Swim;
          for (let k = 0; k < 8; k++) {
            const nx = cx + DX[k], nz = cz + DZ[k];
            if (nx < 0 || nz < 0 || nx >= p.w || nz >= p.h) continue;
            const diag = (k & 1) === 1;
            const lim = diag ? limD : limO;
            if (diag && !swimA && (!this.spanNear(p, nx, cz, ya, limO) || !this.spanNear(p, cx, nz, ya, limO))) continue;
            const c2 = nz * p.w + nx;
            for (let s2 = p.colStart[c2]; s2 < p.colStart[c2 + 1]; s2++) {
              const b = p.colNodes[s2];
              if (!swimA && !(F[b] & NF.Swim) && Y[b] - ya < -lim) continue; // drops: patchDrops
              const ddx = this.X[b] - this.X[a], ddz = this.Z[b] - this.Z[a];
              this.addPair(a, b, Math.sqrt(ddx * ddx + ddz * ddz), lim, !diag);
            }
          }
          if (!swimA) this.patchDrops(p, cx, cz, a, limO, limD);
        }
      }
  }

  /** Walk off an edge up to 3 columns out and fall to a lower floor / into water. */
  private patchDrops(p: NavPatch, cx: number, cz: number, a: number, limO: number, limD: number): void {
    const cw = this.cw, R = this.R, Y = this.Y, F = this.F, res = p.res;
    const ya = Y[a];
    for (let k = 0; k < 8; k++) {
      const lim = (k & 1) === 1 ? limD : limO;
      for (let step = 1; step <= 3; step++) {
        const nx = cx + DX[k] * step, nz = cz + DZ[k] * step;
        if (nx < 0 || nz < 0 || nx >= p.w || nz >= p.h) break;
        if (this.spanNear(p, nx, nz, ya, lim * step)) break; // the floor continues: no edge here
        const x = p.x0 + (nx + 0.5) * res, z = p.z0 + (nz + 0.5) * res;
        if (sdf(cw, x, ya + 0.9, z) < R * 0.9 || sdf(cw, x, ya + 1.4, z) < R * 0.9) break;
        const c2 = nz * p.w + nx;
        let b = -1;
        for (let s2 = p.colStart[c2]; s2 < p.colStart[c2 + 1]; s2++) {
          const q = p.colNodes[s2];
          if (Y[q] < ya - lim) { b = q; break; }
        }
        if (b < 0) continue;
        const drop = ya - Y[b];
        const swimB = (F[b] & NF.Swim) !== 0;
        if (drop > (swimB ? DROP_WATER : DROP_LAND)) break;
        let clear = true;
        for (let yy = ya + 0.3; yy > Y[b] + 1.4 && clear; yy -= 0.6) if (sdf(cw, x, yy, z) < R * 0.8) clear = false;
        if (clear) {
          const t = fallTime(drop) + 0.3;
          if (swimB) this.eb.add(a, b, t + 0.8, Act.Dive);
          else this.eb.add(a, b, t + 0.2 + (drop > DROP_STUMBLE ? 0.6 : 0), Act.JumpDown);
        }
        break;
      }
    }
  }

  /** Structure patch borders <-> coarse nodes; cave mouths <-> coarse nodes. */
  stitch(): void {
    const coarse = this.coarse, X = this.X, Y = this.Y, Z = this.Z, F = this.F;
    for (const p of this.patches) {
      if (p.cave) continue;
      for (let iz = p.iz0 - 1; iz <= p.iz1 + 1; iz++)
        for (let ix = p.ix0 - 1; ix <= p.ix1 + 1; ix++) {
          if (ix < 0 || iz < 0 || ix >= N || iz >= N) continue;
          if (ix >= p.ix0 && ix <= p.ix1 && iz >= p.iz0 && iz <= p.iz1) continue;
          const c = coarse[iz * N + ix];
          if (c < 0) continue;
          const x = X[c], z = Z[c];
          const cx0 = Math.max(0, Math.floor((x - 1.6 - p.x0) / p.res)), cx1 = Math.min(p.w - 1, Math.floor((x + 1.6 - p.x0) / p.res));
          const cz0 = Math.max(0, Math.floor((z - 1.6 - p.z0) / p.res)), cz1 = Math.min(p.h - 1, Math.floor((z + 1.6 - p.z0) / p.res));
          for (let cz = cz0; cz <= cz1; cz++)
            for (let cx = cx0; cx <= cx1; cx++) {
              const col = cz * p.w + cx;
              for (let s = p.colStart[col]; s < p.colStart[col + 1]; s++) {
                const b = p.colNodes[s];
                const dx = X[b] - x, dz = Z[b] - z, d = Math.sqrt(dx * dx + dz * dz);
                if (d > 1.6) continue;
                const lim = 0.6 + EDGE_SLOPE * d;
                this.addPair(c, b, d, lim, true);
                this.addPair(b, c, d, lim, true);
              }
            }
        }
    }
    for (const p of this.patches) {
      if (!p.cave) continue;
      for (let k = 0; k < p.colNodes.length; k++) {
        const a = p.colNodes[k];
        if (F[a] & NF.Cave) continue;
        const ix = toI(X[a]), iz = toI(Z[a]);
        for (let oz = -1; oz <= 1; oz++)
          for (let ox = -1; ox <= 1; ox++) {
            const jx = ix + ox, jz = iz + oz;
            if (jx < 0 || jz < 0 || jx >= N || jz >= N) continue;
            const c = coarse[jz * N + jx];
            if (c < 0) continue;
            const dx = X[c] - X[a], dz = Z[c] - Z[a], d = Math.sqrt(dx * dx + dz * dz);
            if (d > 2.3) continue;
            const my = (Y[a] + Y[c]) * 0.5;
            if (sdf(this.cw, (X[a] + X[c]) * 0.5, my + 0.9, (Z[a] + Z[c]) * 0.5) < this.R * 0.9) continue;
            const lim = 0.6 + 0.5 * d;
            this.addPair(a, c, d, lim, true);
            this.addPair(c, a, d, lim, true);
          }
      }
    }
  }

  /** Assembles the graph shell (edges / regions filled in later). */
  graph(phases: Record<string, number>): NavGraph {
    return {
      world: this.world, cw: this.cw, radius: this.R, n: this.n, x: this.X, y: this.Y, z: this.Z, flags: this.F,
      patch: this.P, cell: this.CELLI, region: new Int32Array(this.n),
      eStart: new Int32Array(0), eTo: new Int32Array(0), eCost: new Float32Array(0), eAct: new Uint8Array(0),
      coarse: this.coarse, owner: this.owner, level: this.level, patches: this.patches, links: [],
      regions: {
        count: 0, rep: new Int32Array(0), comp: new Int32Array(0), start: new Int32Array(1), to: new Int32Array(0),
        cost: new Float32Array(0), cls: new Uint8Array(0),
      },
      stats: {
        buildMs: 0, phases, nodes: this.n, coarseNodes: this.nCoarse, structNodes: this.nStruct, caveNodes: this.nCave,
        edges: 0, regions: 0, links: 0, bytes: 0,
      },
    };
  }
}

export function buildNav(world: World, cw: CollisionWorld = buildCollision(world), opts: NavBuildOptions = {}): NavGraph {
  const T0 = now();
  const phases: Record<string, number> = {};
  let tp = T0;
  const phase = (name: string) => {
    const t = now();
    phases[name] = t - tp;
    tp = t;
  };
  const B = new Builder(world, cw, opts.radius ?? AGENT_R);
  B.classify();
  B.waterReach();
  B.bridgeIslands();
  B.blockProps();
  phase("classify");
  B.makePatches();
  B.rasterPatches();
  phase("patches");
  phases["patches.cave"] = B.caveMs;
  B.createNodes();
  phase("nodes");
  B.coarseEdges();
  phase("coarseEdges");
  B.coarseDrops();
  phase("drops");
  for (const p of B.patches) B.patchEdges(p);
  phase("patchEdges");
  B.stitch();
  phase("stitch");
  const g = B.graph(phases);
  const eb = B.eb;
  zipLinks(g, eb);
  if (opts.boats !== false) boatLinks(g, eb, B.kind);
  phase("links");
  toCsr(g, eb);
  phase("csr");
  buildRegions(g);
  phase("regions");
  g.stats.edges = g.eTo.length;
  g.stats.regions = g.regions.count;
  g.stats.links = g.links.length;
  let bytes = 0;
  for (const a of [g.x, g.y, g.z, g.flags, g.patch, g.cell, g.region, g.eStart, g.eTo, g.eCost, g.eAct, g.coarse, g.owner, g.level]) bytes += a.byteLength;
  for (const p of g.patches) bytes += p.colStart.byteLength + p.colNodes.byteLength;
  const r = g.regions;
  for (const a of [r.rep, r.comp, r.start, r.to, r.cost, r.cls]) bytes += a.byteLength;
  g.stats.bytes = bytes;
  g.stats.buildMs = now() - T0;
  return g;
}

function toCsr(g: NavGraph, eb: EdgeBuf): void {
  const n = g.n, ne = eb.n;
  const eStart = new Int32Array(n + 1);
  const from = eb.from;
  for (let k = 0; k < ne; k++) eStart[from[k] + 1]++;
  for (let k = 0; k < n; k++) eStart[k + 1] += eStart[k];
  const fill = eStart.slice(0, n);
  const eTo = new Int32Array(ne), eCost = new Float32Array(ne), eAct = new Uint8Array(ne);
  for (let k = 0; k < ne; k++) {
    const o = fill[from[k]]++;
    eTo[o] = eb.to[k];
    eCost[o] = eb.cost[k];
    eAct[o] = eb.act[k];
  }
  g.eStart = eStart;
  g.eTo = eTo;
  g.eCost = eCost;
  g.eAct = eAct;
}

// ---------------------------------------------------------------------------
// ziplines: grab node near the top anchor -> landing node at the bottom

function zipLinks(g: NavGraph, eb: EdgeBuf): void {
  g.world.ziplines.forEach((zl, zi) => {
    const top = zl.ay >= zl.by;
    const ax = top ? zl.ax : zl.bx, ay = top ? zl.ay : zl.by, az = top ? zl.az : zl.bz;
    const bx = top ? zl.bx : zl.ax, by = top ? zl.by : zl.ay, bz = top ? zl.bz : zl.az;
    const grab = nearestWhere(g, ax, ay - ZIP_FEET, az, ZIP_GRAB_R - 0.4, (q) => {
      const dy = g.y[q] - (ay - ZIP_FEET);
      return dy >= -1.4 && dy <= 2.8 && !(g.flags[q] & NF.Swim);
    });
    const land = nearestWhere(g, bx, by - ZIP_FEET, bz, 5, (q) => Math.abs(g.y[q] - (by - ZIP_FEET)) < 3);
    if (grab < 0 || land < 0) return;
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const L = Math.sqrt(dx * dx + dy * dy + dz * dz);
    eb.add(grab, land, 1.2 + L / (ZIP_MAX_SPEED * 0.8), Act.Zipline);
    g.links.push({ act: Act.Zipline, from: grab, to: land, id: zi });
  });
}

// ---------------------------------------------------------------------------
// boats: board next to the boat, get off at spread-out shores of the same bay

function boatLinks(g: NavGraph, eb: EdgeBuf, kind: Uint8Array): void {
  const w = g.world;
  const H = w.height;
  const MAXD = 90; // BFS steps (x ~2.2 m)
  const dist = new Int16Array(NN);
  const q = new Int32Array(NN);
  w.vehicles.forEach((v, vi) => {
    if (!isBoat(v.kind)) return;
    const board = nearestWhere(g, v.x, 0, v.z, INTERACT_R + 1.5, (n) => Math.abs(g.y[n] - v.y) < 2.6);
    if (board < 0) return;
    dist.fill(-1);
    const s = toI(v.z) * N + toI(v.x);
    let qh = 0, qt = 0;
    q[qt++] = s;
    dist[s] = 0;
    // landing candidates per 45° sector, keep the farthest by water distance
    const best = new Int32Array(8).fill(-1), bestD = new Int32Array(8).fill(0);
    while (qh < qt) {
      const i = q[qh++];
      const d = dist[i];
      if (d >= MAXD) continue;
      const ix = i % N, iz = (i / N) | 0;
      for (let oz = -1; oz <= 1; oz++)
        for (let ox = -1; ox <= 1; ox++) {
          const jx = ix + ox, jz = iz + oz;
          if (jx < 0 || jz < 0 || jx >= N || jz >= N) continue;
          const j = jz * N + jx;
          if (dist[j] >= 0) continue;
          const lv = g.level[j];
          if (lv > NO_LEVEL && lv - H[j] >= 0.6) {
            dist[j] = d + 1;
            q[qt++] = j;
          } else if (kind[j] === 1 && g.coarse[j] >= 0 && d >= 25) {
            dist[j] = d + 1;
            const dx = g.x[g.coarse[j]] - v.x, dz = g.z[g.coarse[j]] - v.z;
            const sec = octant(dx, dz);
            if (d > bestD[sec]) { bestD[sec] = d; best[sec] = g.coarse[j]; }
          }
        }
    }
    for (let sec = 0; sec < 8; sec++) {
      if (best[sec] < 0) continue;
      eb.add(board, best[sec], 5 + (bestD[sec] * 2.2) / BOAT_SPEED, Act.Vehicle);
      g.links.push({ act: Act.Vehicle, from: board, to: best[sec], id: vi });
    }
  });
}

/** 0..7 sector of a direction (0 = +X, counter-clockwise toward +Z), no trig. */
export function octant(dx: number, dz: number): number {
  const ax = dx < 0 ? -dx : dx, az = dz < 0 ? -dz : dz;
  const T = 0.41421356237309503; // tan(22.5°)
  let o: number;
  if (az <= ax * T) o = 0;
  else if (ax <= az * T) o = 2;
  else o = 1;
  // o in first quadrant: 0 (+X), 1 (diag), 2 (+Z); mirror into the others
  if (dx >= 0 && dz >= 0) return o;
  if (dx < 0 && dz >= 0) return 4 - o;
  if (dx < 0 && dz < 0) return (4 + o) & 7;
  return (8 - o) & 7;
}
/** Unit direction of octant k (matches octant()). */
export const OCT_X = [1, 0.7071067811865476, 0, -0.7071067811865476, -1, -0.7071067811865476, 0, 0.7071067811865476];
export const OCT_Z = [0, 0.7071067811865476, 1, 0.7071067811865476, 0, -0.7071067811865476, -1, -0.7071067811865476];

// ---------------------------------------------------------------------------
// regions: 32 m sectors x connected components (walk / wade / swim / cave)

function findRoot(parent: Int32Array, a: number): number {
  while (parent[a] !== a) a = parent[a] = parent[parent[a]];
  return a;
}

/** Union-find over the symmetric moves (walk / wade / swim / cave) that stay inside one sector. */
function unionSectors(g: NavGraph, sec: Int32Array): Int32Array {
  const n = g.n, eStart = g.eStart, eTo = g.eTo, eAct = g.eAct;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  for (let a = 0; a < n; a++) {
    const sa = sec[a];
    for (let e = eStart[a], e1 = eStart[a + 1]; e < e1; e++) {
      const b = eTo[e];
      if (b < a || sec[b] !== sa) continue;
      const act = eAct[e];
      if (act !== Act.Walk && act !== Act.Wade && act !== Act.Swim && act !== Act.Cave) continue;
      const ra = findRoot(parent, a), rb = findRoot(parent, b);
      if (ra !== rb) { if (ra < rb) parent[rb] = ra; else parent[ra] = rb; }
    }
  }
  return parent;
}

function buildRegions(g: NavGraph): void {
  const n = g.n;
  const sec = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    let sx = Math.floor((g.x[i] + WORLD_HALF) / SECTOR), sz = Math.floor((g.z[i] + WORLD_HALF) / SECTOR);
    sx = sx < 0 ? 0 : sx >= SECTORS ? SECTORS - 1 : sx;
    sz = sz < 0 ? 0 : sz >= SECTORS ? SECTORS - 1 : sz;
    sec[i] = sz * SECTORS + sx;
  }
  const parent = unionSectors(g, sec);
  const find = (a: number) => findRoot(parent, a);
  const region = g.region;
  const rootId = new Int32Array(n).fill(-1);
  let count = 0;
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (rootId[r] < 0) rootId[r] = count++;
    region[i] = rootId[r];
  }
  // representative: node closest to the centroid
  const sx = new Float64Array(count), sy = new Float64Array(count), sz = new Float64Array(count), cnt = new Int32Array(count);
  for (let i = 0; i < n; i++) {
    const r = region[i];
    sx[r] += g.x[i]; sy[r] += g.y[i]; sz[r] += g.z[i]; cnt[r]++;
  }
  for (let r = 0; r < count; r++) { sx[r] /= cnt[r]; sy[r] /= cnt[r]; sz[r] /= cnt[r]; }
  const rep = new Int32Array(count).fill(-1);
  const repD = new Float64Array(count).fill(Infinity);
  for (let i = 0; i < n; i++) {
    const r = region[i];
    const dx = g.x[i] - sx[r], dy = g.y[i] - sy[r], dz = g.z[i] - sz[r];
    const d = dx * dx + dy * dy * 4 + dz * dz;
    if (d < repD[r]) { repD[r] = d; rep[r] = i; }
  }
  // abstract edges: min over crossing edges of (rep->u) + edge + (v->rep)
  const keyCost = new Map<number, number>();
  const clsOf = (act: number) => (act === Act.Swim || act === Act.Dive ? 1 : act === Act.Zipline ? 2 : act === Act.Vehicle ? 3 : 0);
  const dist = (a: number, b: number) => {
    const dx = g.x[a] - g.x[b], dy = g.y[a] - g.y[b], dz = g.z[a] - g.z[b];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  };
  for (let a = 0; a < n; a++) {
    const ra = region[a];
    for (let e = g.eStart[a]; e < g.eStart[a + 1]; e++) {
      const b = g.eTo[e], rb = region[b];
      if (ra === rb) continue;
      const c = dist(rep[ra], a) / RUN_SPEED + g.eCost[e] + dist(b, rep[rb]) / RUN_SPEED;
      const key = (ra * count + rb) * 4 + clsOf(g.eAct[e]);
      const old = keyCost.get(key);
      if (old === undefined || c < old) keyCost.set(key, c);
    }
  }
  const keys = Array.from(keyCost.keys()).sort((p, q) => p - q);
  const start = new Int32Array(count + 1);
  const to = new Int32Array(keys.length), cost = new Float32Array(keys.length), cls = new Uint8Array(keys.length);
  for (let k = 0; k < keys.length; k++) {
    const key = keys[k];
    const pair = Math.floor(key / 4);
    const ra = Math.floor(pair / count);
    start[ra + 1]++;
    to[k] = pair - ra * count;
    cost[k] = keyCost.get(key)!;
    cls[k] = key - pair * 4;
  }
  for (let r = 0; r < count; r++) start[r + 1] += start[r];
  // weak components over the region graph, biggest (by node count) = 0
  const par = new Int32Array(count);
  for (let r = 0; r < count; r++) par[r] = r;
  const f2 = (a: number): number => {
    while (par[a] !== a) a = par[a] = par[par[a]];
    return a;
  };
  for (let r = 0; r < count; r++)
    for (let k = start[r]; k < start[r + 1]; k++) {
      const a = f2(r), b = f2(to[k]);
      if (a !== b) { if (a < b) par[b] = a; else par[a] = b; }
    }
  const size = new Float64Array(count);
  for (let r = 0; r < count; r++) size[f2(r)] += cnt[r];
  const roots: number[] = [];
  for (let r = 0; r < count; r++) if (f2(r) === r) roots.push(r);
  roots.sort((a, b) => size[b] - size[a] || a - b);
  const compOfRoot = new Int32Array(count).fill(-1);
  roots.forEach((r, k) => (compOfRoot[r] = k));
  const comp = new Int32Array(count);
  for (let r = 0; r < count; r++) comp[r] = compOfRoot[f2(r)];
  g.regions = { count, rep, comp, start, to, cost, cls };
}

// ---------------------------------------------------------------------------
// lookups

/**
 * Nearest node to (x, y, z) within maxDist (horizontal) that passes `ok`,
 * scoring horizontal distance plus doubled vertical mismatch. -1 if none.
 */
export function nearestWhere(g: NavGraph, x: number, y: number, z: number, maxDist: number, ok?: (n: number) => boolean): number {
  let best = -1, bestS = Infinity;
  const md2 = maxDist * maxDist;
  const consider = (q: number) => {
    const dx = g.x[q] - x, dz = g.z[q] - z, dy = g.y[q] - y;
    const h2 = dx * dx + dz * dz;
    if (h2 > md2) return;
    const s = h2 + 4 * dy * dy;
    if (s < bestS && (!ok || ok(q))) { bestS = s; best = q; }
  };
  for (const p of g.patches) {
    const r = p.cave ? Math.min(maxDist, 4) : Math.min(maxDist, 3);
    if (x + r < p.x0 || z + r < p.z0 || x - r > p.x0 + p.w * p.res || z - r > p.z0 + p.h * p.res) continue;
    const cx0 = Math.max(0, Math.floor((x - r - p.x0) / p.res)), cx1 = Math.min(p.w - 1, Math.floor((x + r - p.x0) / p.res));
    const cz0 = Math.max(0, Math.floor((z - r - p.z0) / p.res)), cz1 = Math.min(p.h - 1, Math.floor((z + r - p.z0) / p.res));
    for (let cz = cz0; cz <= cz1; cz++)
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = cz * p.w + cx;
        for (let s = p.colStart[c]; s < p.colStart[c + 1]; s++) consider(p.colNodes[s]);
      }
  }
  const rc = Math.ceil(maxDist / 2);
  const ix = toI(x), iz = toI(z);
  for (let jz = iz - rc; jz <= iz + rc; jz++) {
    if (jz < 0 || jz >= N) continue;
    for (let jx = ix - rc; jx <= ix + rc; jx++) {
      if (jx < 0 || jx >= N) continue;
      const q = g.coarse[jz * N + jx];
      if (q >= 0) consider(q);
    }
  }
  return best;
}

/** Nearest node to a point (see nearestWhere); widens the search if nothing is close. */
export function nearestNode(g: NavGraph, x: number, y: number, z: number, maxDist = 6): number {
  let r = nearestWhere(g, x, y, z, maxDist);
  if (r < 0 && maxDist < 24) r = nearestWhere(g, x, y, z, 24);
  return r;
}
