// Collision and spatial queries against a generated World. Shared by the
// client-side prediction, the authoritative server and the renderer (caves).
// Deterministic: only + - * / and Math.sqrt/floor/abs/min/max.
//
// Rotation convention for Solid.rotY (three.js Object3D.rotation.y):
//   world = center + (lx*cos r + lz*sin r, ly, -lx*sin r + lz*cos r)
//   local = (dx*cos r - dz*sin r, dy, dx*sin r + dz*cos r)
import { Noise } from "../math/noise";
import { Rng } from "../math/rng";
import { cos, sin } from "../math/trig";
import { INV_CELL, N, sample } from "./grid";
import {
  NO_WATER, PROP_COLLIDER_HEIGHT, PROP_COLLIDER_RADIUS, PROP_STRIDE, SEA_LEVEL, WORLD_HALF, WORLD_SIZE,
  type World,
} from "./types";

// ---------------------------------------------------------------------------
// Uniform grid (CSR) used for solids, props and cave edges.

const HC = 4; // hash cell size (m)
const HR = WORLD_SIZE / HC; // cells per side
/** Objects are listed in every cell their AABB (grown by MARGIN) touches. */
const MARGIN = 2.5;

interface Csr {
  start: Int32Array; // HR*HR + 1
  items: Int32Array;
}

function buildCsr(count: number, bounds: (i: number, out: number[]) => void, margin: number): Csr {
  const b = [0, 0, 0, 0];
  const cnt = new Int32Array(HR * HR + 1);
  const range = (i: number): [number, number, number, number] => {
    bounds(i, b);
    const x0 = Math.max(0, Math.floor((b[0] - margin + WORLD_HALF) / HC));
    const z0 = Math.max(0, Math.floor((b[1] - margin + WORLD_HALF) / HC));
    const x1 = Math.min(HR - 1, Math.floor((b[2] + margin + WORLD_HALF) / HC));
    const z1 = Math.min(HR - 1, Math.floor((b[3] + margin + WORLD_HALF) / HC));
    return [x0, z0, x1, z1];
  };
  for (let i = 0; i < count; i++) {
    const [x0, z0, x1, z1] = range(i);
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) cnt[z * HR + x + 1]++;
  }
  for (let k = 0; k < HR * HR; k++) cnt[k + 1] += cnt[k];
  const items = new Int32Array(cnt[HR * HR]);
  const fill = cnt.slice(0, HR * HR);
  for (let i = 0; i < count; i++) {
    const [x0, z0, x1, z1] = range(i);
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) items[fill[z * HR + x]++] = i;
  }
  return { start: cnt, items };
}

function hashCell(x: number, z: number): number {
  let cx = Math.floor((x + WORLD_HALF) / HC), cz = Math.floor((z + WORLD_HALF) / HC);
  if (cx < 0 || cz < 0 || cx >= HR || cz >= HR) return -1;
  return cz * HR + cx;
}

/** Distance from (x, z) to the nearest face of its hash cell. */
function faceDist(x: number, z: number): number {
  const fx = (x + WORLD_HALF) / HC, fz = (z + WORLD_HALF) / HC;
  const ax = fx - Math.floor(fx), az = fz - Math.floor(fz);
  let m = ax < 1 - ax ? ax : 1 - ax;
  const mz = az < 1 - az ? az : 1 - az;
  if (mz < m) m = mz;
  return m * HC;
}

// ---------------------------------------------------------------------------
// Caves

interface CavePrep {
  /** Per edge: ax ay az bx by bz ra rb fa fb (fa/fb = floor heights at the ends). */
  e: Float64Array;
  ne: number;
  /** Per chamber node: x y z r floor */
  c: Float64Array;
  nc: number;
  grid: Csr; // indices: edges [0, ne), chambers [ne, ne + nc)
  noise: Noise;
}
const EF = 10;
const CF = 5;
/** Tunnel floor sits this fraction of the radius below the axis. */
export const CAVE_FLOOR = 0.55;
export const CHAMBER_R = 7;

const cavePreps = new WeakMap<World, CavePrep>();

function prepCaves(world: World): CavePrep {
  let p = cavePreps.get(world);
  if (p) return p;
  let ne = 0, nc = 0;
  for (const c of world.caves) {
    ne += c.edges.length;
    for (const n of c.nodes) if (n.r >= CHAMBER_R) nc++;
  }
  const e = new Float64Array(ne * EF);
  const ch = new Float64Array(nc * CF);
  let k = 0, m = 0;
  for (const c of world.caves) {
    for (const [ia, ib] of c.edges) {
      const a = c.nodes[ia], b = c.nodes[ib];
      const o = k * EF;
      // Tunnels entering a chamber taper to 4.5 m and meet its floor level.
      const ra = a.r >= CHAMBER_R ? 4.5 : a.r;
      const rb = b.r >= CHAMBER_R ? 4.5 : b.r;
      const ay = a.r >= CHAMBER_R ? a.y - 0.45 * a.r + CAVE_FLOOR * ra : a.y;
      const by = b.r >= CHAMBER_R ? b.y - 0.45 * b.r + CAVE_FLOOR * rb : b.y;
      e[o] = a.x; e[o + 1] = ay; e[o + 2] = a.z;
      e[o + 3] = b.x; e[o + 4] = by; e[o + 5] = b.z;
      e[o + 6] = ra; e[o + 7] = rb;
      e[o + 8] = ay - CAVE_FLOOR * ra; e[o + 9] = by - CAVE_FLOOR * rb;
      k++;
    }
    for (const n of c.nodes) {
      if (n.r < CHAMBER_R) continue;
      const o = m * CF;
      ch[o] = n.x; ch[o + 1] = n.y; ch[o + 2] = n.z; ch[o + 3] = n.r; ch[o + 4] = n.y - 0.45 * n.r;
      m++;
    }
  }
  const grid = buildCsr(ne + nc, (i, out) => {
    if (i < ne) {
      const o = i * EF, r = Math.max(e[o + 6], e[o + 7]) + 1;
      out[0] = Math.min(e[o], e[o + 3]) - r; out[1] = Math.min(e[o + 2], e[o + 5]) - r;
      out[2] = Math.max(e[o], e[o + 3]) + r; out[3] = Math.max(e[o + 2], e[o + 5]) + r;
    } else {
      const o = (i - ne) * CF, r = ch[o + 3] + 1;
      out[0] = ch[o] - r; out[1] = ch[o + 2] - r; out[2] = ch[o] + r; out[3] = ch[o + 2] + r;
    }
  }, 3);
  p = { e, ne, c: ch, nc, grid, noise: new Noise(new Rng(world.seed).fork("caveWalls")) };
  cavePreps.set(world, p);
  return p;
}

/** Cave-void SDF from explicit candidate list; exact near walls, bounded far. */
function caveEval(p: CavePrep, x: number, y: number, z: number, cell: number): number {
  const g = p.grid;
  const s = g.start[cell], t = g.start[cell + 1];
  if (s === t) return 3 + faceDist(x, z);
  let best = 1e9;
  const e = p.e;
  for (let k = s; k < t; k++) {
    const id = g.items[k];
    let d: number;
    if (id < p.ne) {
      const o = id * EF;
      const ax = e[o], ay = e[o + 1], az = e[o + 2];
      const bx = e[o + 3] - ax, by = e[o + 4] - ay, bz = e[o + 5] - az;
      const px = x - ax, py = y - ay, pz = z - az;
      const l2 = bx * bx + by * by + bz * bz;
      let u = l2 > 0 ? (px * bx + py * by + pz * bz) / l2 : 0;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const qx = px - bx * u, qy = py - by * u, qz = pz - bz * u;
      const r = e[o + 6] + (e[o + 7] - e[o + 6]) * u;
      const dc = Math.sqrt(qx * qx + qy * qy + qz * qz) - r;
      const fl = e[o + 8] + (e[o + 9] - e[o + 8]) * u;
      d = dc > fl - y ? dc : fl - y;
    } else {
      const o = (id - p.ne) * CF;
      const c = p.c;
      const dx = x - c[o], dy = (y - c[o + 1]) * 1.25, dz = z - c[o + 2];
      // squashed sphere (vertical radius r/1.25); scaled to stay conservative
      const dc = (Math.sqrt(dx * dx + dy * dy + dz * dz) - c[o + 3]) * 0.8;
      const fl = c[o + 4];
      d = dc > fl - y ? dc : fl - y;
    }
    if (d < best) best = d;
  }
  if (best > -2.5 && best < 2.5) {
    // organic wobble on the walls, faded out smoothly so the field stays continuous
    const a = best < 0 ? -best : best;
    const t = a < 1.5 ? 1 : 1 - (a - 1.5);
    best += 0.35 * t * t * (3 - 2 * t) * p.noise.n3(x * 0.22, y * 0.22, z * 0.22);
  }
  const bound = 3 + faceDist(x, z);
  return best < bound ? best : bound;
}

/**
 * Signed distance to the cave void (negative inside a tunnel or chamber).
 * Tunnels are tapered capsules with flat floors; chambers are squashed spheres.
 * Exact within ~3 m of a cave, a positive lower bound further away.
 */
export function caveSdf(world: World, x: number, y: number, z: number): number {
  const p = prepCaves(world);
  const cell = hashCell(x, z);
  if (cell < 0) return 10;
  return caveEval(p, x, y, z, cell);
}

// ---------------------------------------------------------------------------
// Terrain

export function terrainHeight(world: World, x: number, z: number): number {
  return sample(world.height, x, z);
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export function terrainNormal(world: World, x: number, z: number, out: Vec3 = { x: 0, y: 1, z: 0 }): Vec3 {
  const e = 1;
  const dx = sample(world.height, x + e, z) - sample(world.height, x - e, z);
  const dz = sample(world.height, x, z + e) - sample(world.height, x, z - e);
  const nx = -dx, ny = 2 * e, nz = -dz;
  const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
  out.x = nx / l;
  out.y = ny / l;
  out.z = nz / l;
  return out;
}

/** Approximate signed distance to the heightfield: vertical gap scaled by the local slope. */
function terrainSdf(h: Float32Array, x: number, y: number, z: number): number {
  let fx = (x + WORLD_HALF) * INV_CELL;
  let fz = (z + WORLD_HALF) * INV_CELL;
  if (fx < 0) fx = 0;
  else if (fx > N - 1.000001) fx = N - 1.000001;
  if (fz < 0) fz = 0;
  else if (fz > N - 1.000001) fz = N - 1.000001;
  const ix = Math.floor(fx), iz = Math.floor(fz);
  const tx = fx - ix, tz = fz - iz;
  const i = iz * N + ix;
  const a = h[i], b = h[i + 1], c = h[i + N], d = h[i + N + 1];
  const ht = (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
  const gx = ((b - a) * (1 - tz) + (d - c) * tz) * INV_CELL;
  const gz = ((c - a) * (1 - tx) + (d - b) * tx) * INV_CELL;
  return (y - ht) / Math.sqrt(1 + gx * gx + gz * gz);
}

// ---------------------------------------------------------------------------
// Collision world

export type HitKind = "terrain" | "structure" | "prop" | "cave";

export interface CollisionWorld {
  world: World;
  /** Per solid: shape(0 box,1 wedge,2 cyl) cx cy cz hx hy hz cos sin structureIndex */
  solids: Float64Array;
  nSolids: number;
  solidGrid: Csr;
  /** Per collider prop: x y0 z r y1 */
  props: Float64Array;
  nProps: number;
  propGrid: Csr;
  cave: CavePrep;
  /** Kind of the last component that produced the minimum in sdf(). */
  lastKind: HitKind;
}
const SF = 10;
const PF = 5;

export function buildCollision(world: World): CollisionWorld {
  let ns = 0;
  for (const s of world.structures) ns += s.solids.length;
  const solids = new Float64Array(ns * SF);
  let k = 0;
  world.structures.forEach((st, si) => {
    for (const s of st.solids) {
      const o = k * SF;
      solids[o] = s.shape === "box" ? 0 : s.shape === "wedge" ? 1 : 2;
      solids[o + 1] = s.cx; solids[o + 2] = s.cy; solids[o + 3] = s.cz;
      solids[o + 4] = s.hx; solids[o + 5] = s.hy; solids[o + 6] = s.hz;
      solids[o + 7] = cos(s.rotY); solids[o + 8] = sin(s.rotY);
      solids[o + 9] = si;
      k++;
    }
  });
  const solidGrid = buildCsr(ns, (i, out) => {
    const o = i * SF;
    const r = solids[o] === 2 ? solids[o + 4] : Math.sqrt(solids[o + 4] * solids[o + 4] + solids[o + 6] * solids[o + 6]);
    out[0] = solids[o + 1] - r; out[1] = solids[o + 3] - r; out[2] = solids[o + 1] + r; out[3] = solids[o + 3] + r;
  }, MARGIN);

  let np = 0;
  for (const ps of world.props) if (PROP_COLLIDER_RADIUS[ps.kind] > 0) np += ps.count;
  const props = new Float64Array(np * PF);
  k = 0;
  for (const ps of world.props) {
    const r0 = PROP_COLLIDER_RADIUS[ps.kind];
    if (r0 <= 0) continue;
    const h0 = PROP_COLLIDER_HEIGHT[ps.kind];
    for (let j = 0; j < ps.count; j++) {
      const q = j * PROP_STRIDE;
      const sc = ps.data[q + 4];
      const o = k * PF;
      props[o] = ps.data[q];
      props[o + 1] = ps.data[q + 1] - 0.5;
      props[o + 2] = ps.data[q + 2];
      props[o + 3] = r0 * sc;
      props[o + 4] = ps.data[q + 1] + h0 * sc;
      k++;
    }
  }
  const propGrid = buildCsr(np, (i, out) => {
    const o = i * PF, r = props[o + 3];
    out[0] = props[o] - r; out[1] = props[o + 2] - r; out[2] = props[o] + r; out[3] = props[o + 2] + r;
  }, MARGIN);

  return { world, solids, nSolids: ns, solidGrid, props, nProps: np, propGrid, cave: prepCaves(world), lastKind: "terrain" };
}

function sdBox(px: number, py: number, pz: number, hx: number, hy: number, hz: number): number {
  const qx = (px < 0 ? -px : px) - hx, qy = (py < 0 ? -py : py) - hy, qz = (pz < 0 ? -pz : pz) - hz;
  const mx = qx > 0 ? qx : 0, my = qy > 0 ? qy : 0, mz = qz > 0 ? qz : 0;
  const inner = Math.max(qx, qy, qz);
  return Math.sqrt(mx * mx + my * my + mz * mz) + (inner < 0 ? inner : 0);
}

/** Gable prism: ridge along local X at +hy, base (width 2hz) at -hy. */
function sdWedge(px: number, py: number, pz: number, hx: number, hy: number, hz: number): number {
  // 2D isosceles triangle, apex at origin pointing up, base at y' = H
  const H = 2 * hy, W = hz;
  const qx = pz < 0 ? -pz : pz;
  const qy = hy - py; // apex (py = hy) -> 0, base (py = -hy) -> H
  const qq = W * W + H * H;
  let t = (qx * W + qy * H) / qq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ax = qx - W * t, ay = qy - H * t;
  let u = qx / W;
  u = u < 0 ? 0 : u > 1 ? 1 : u;
  const bx = qx - W * u, by = qy - H;
  const da = ax * ax + ay * ay, db = bx * bx + by * by;
  const sa = -(qx * H - qy * W), sb = -(qy - H);
  const dd = da < db ? da : db;
  const ss = sa < sb ? sa : sb;
  const d2 = ss > 0 ? -Math.sqrt(dd) : Math.sqrt(dd);
  const wx = d2, wy = (px < 0 ? -px : px) - hx;
  const mx = wx > 0 ? wx : 0, my = wy > 0 ? wy : 0;
  const inner = wx > wy ? wx : wy;
  return (inner < 0 ? inner : 0) + Math.sqrt(mx * mx + my * my);
}

function sdCyl(px: number, py: number, pz: number, r: number, hy: number): number {
  const dx = Math.sqrt(px * px + pz * pz) - r, dy = (py < 0 ? -py : py) - hy;
  const mx = dx > 0 ? dx : 0, my = dy > 0 ? dy : 0;
  const inner = dx > dy ? dx : dy;
  return (inner < 0 ? inner : 0) + Math.sqrt(mx * mx + my * my);
}

/** SDF of one solid (index into cw.solids). */
export function solidSdf(cw: CollisionWorld, i: number, x: number, y: number, z: number): number {
  const s = cw.solids, o = i * SF;
  const dx = x - s[o + 1], dy = y - s[o + 2], dz = z - s[o + 3];
  const c = s[o + 7], sn = s[o + 8];
  const lx = dx * c - dz * sn, lz = dx * sn + dz * c;
  const shape = s[o];
  if (shape === 0) return sdBox(lx, dy, lz, s[o + 4], s[o + 5], s[o + 6]);
  if (shape === 1) return sdWedge(lx, dy, lz, s[o + 4], s[o + 5], s[o + 6]);
  return sdCyl(lx, dy, lz, s[o + 4], s[o + 5]);
}

/** Signed distance to anything solid (negative inside). */
export function sdf(cw: CollisionWorld, x: number, y: number, z: number): number {
  const world = cw.world;
  let d = terrainSdf(world.height, x, y, z);
  let kind: HitKind = "terrain";
  const cell = hashCell(x, z);
  if (cell >= 0) {
    const cv = cw.cave;
    if (cv.grid.start[cell] !== cv.grid.start[cell + 1]) {
      const c = -caveEval(cv, x, y, z, cell);
      if (c > d) {
        d = c;
        kind = "cave";
      }
    }
    const bound = MARGIN + faceDist(x, z);
    let g = cw.solidGrid;
    for (let k = g.start[cell], e = g.start[cell + 1]; k < e; k++) {
      const v = solidSdf(cw, g.items[k], x, y, z);
      if (v < d) {
        d = v;
        kind = "structure";
      }
    }
    g = cw.propGrid;
    const p = cw.props;
    for (let k = g.start[cell], e = g.start[cell + 1]; k < e; k++) {
      const o = g.items[k] * PF;
      const dx = x - p[o], dz = z - p[o + 2];
      const y0 = p[o + 1], y1 = p[o + 4];
      const cy = y < y0 ? y0 : y > y1 ? y1 : y;
      const dy = y - cy;
      const v = Math.sqrt(dx * dx + dy * dy + dz * dz) - p[o + 3];
      if (v < d) {
        d = v;
        kind = "prop";
      }
    }
    if (bound < d) d = bound;
  }
  cw.lastKind = kind;
  return d;
}

export function sdfNormal(cw: CollisionWorld, x: number, y: number, z: number, out: Vec3 = { x: 0, y: 1, z: 0 }): Vec3 {
  const e = 0.05;
  // tetrahedron technique: 4 evaluations
  const a = sdf(cw, x + e, y - e, z - e);
  const b = sdf(cw, x - e, y - e, z + e);
  const c = sdf(cw, x - e, y + e, z - e);
  const d = sdf(cw, x + e, y + e, z + e);
  const nx = a - b - c + d, ny = -a - b + c + d, nz = -a + b - c + d;
  const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (l < 1e-9) {
    out.x = 0;
    out.y = 1;
    out.z = 0;
  } else {
    out.x = nx / l;
    out.y = ny / l;
    out.z = nz / l;
  }
  return out;
}

export interface RayHit {
  t: number;
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  kind: HitKind;
}

/** Sphere-traced raycast. (dx, dy, dz) need not be normalized. */
export function raycast(
  cw: CollisionWorld, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number,
): RayHit | null {
  const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (l === 0) return null;
  dx /= l;
  dy /= l;
  dz /= l;
  let t = 0;
  const eps = 0.01;
  for (let it = 0; it < 512 && t <= maxDist; it++) {
    const x = ox + dx * t, y = oy + dy * t, z = oz + dz * t;
    const d = sdf(cw, x, y, z);
    if (d < eps) {
      const kind = cw.lastKind;
      const n = sdfNormal(cw, x, y, z);
      return { t, x, y, z, nx: n.x, ny: n.y, nz: n.z, kind };
    }
    let step = d * 0.9;
    if (step > 8) step = 8;
    if (step < eps) step = eps;
    t += step;
  }
  return null;
}

/**
 * Height of the highest solid surface at or below (x, y, z): the floor you
 * would land on falling straight down from there (terrain, cave floor,
 * building floor, roof...). -Infinity if nothing within 200 m.
 */
export function groundBelow(cw: CollisionWorld, x: number, y: number, z: number): number {
  let yy = y;
  let d = sdf(cw, x, yy, z);
  if (d < 0) return y;
  for (let it = 0; it < 256; it++) {
    let step = d * 0.9;
    if (step < 0.02) step = 0.02;
    const ny = yy - step;
    const nd = sdf(cw, x, ny, z);
    if (nd <= 0.004) {
      // crossed (or touched) the surface: bisect to the free side
      let lo = ny, hi = yy;
      for (let k = 0; k < 10; k++) {
        const m = (lo + hi) * 0.5;
        if (sdf(cw, x, m, z) > 0.004) hi = m;
        else lo = m;
      }
      return hi;
    }
    yy = ny;
    d = nd;
    if (y - yy > 200) break;
  }
  return -Infinity;
}

/**
 * Water surface height at (x, z): the higher of the sea (always present at
 * SEA_LEVEL) and any fresh water (lakes, rivers). Whether a point is actually
 * submerged also depends on the ground below it.
 */
export function waterSurface(cw: CollisionWorld, x: number, z: number): number {
  const fresh = freshWater(cw.world, x, z);
  return fresh > SEA_LEVEL ? fresh : SEA_LEVEL;
}

/** Fresh-water surface, weighted over the valid neighbouring samples, or -Infinity. */
export function freshWater(world: World, x: number, z: number): number {
  let fx = (x + WORLD_HALF) * INV_CELL, fz = (z + WORLD_HALF) * INV_CELL;
  if (fx < 0 || fz < 0 || fx > N - 1.000001 || fz > N - 1.000001) return -Infinity;
  const ix = Math.floor(fx), iz = Math.floor(fz);
  const tx = fx - ix, tz = fz - iz;
  const i = iz * N + ix;
  const w = world.water;
  let sum = 0, ws = 0;
  const a = w[i], b = w[i + 1], c = w[i + N], d = w[i + N + 1];
  if (a !== NO_WATER) { const k = (1 - tx) * (1 - tz) + 1e-6; sum += a * k; ws += k; }
  if (b !== NO_WATER) { const k = tx * (1 - tz) + 1e-6; sum += b * k; ws += k; }
  if (c !== NO_WATER) { const k = (1 - tx) * tz + 1e-6; sum += c * k; ws += k; }
  if (d !== NO_WATER) { const k = tx * tz + 1e-6; sum += d * k; ws += k; }
  return ws > 0 ? sum / ws : -Infinity;
}
