// Stage 5: caves. Each cave is a hub chamber deep under a massif joined by
// winding tunnels to 2–3 entrances on hillsides / cliff bases (one may be a
// sea grotto opening at water level). Tunnels keep gentle floor grades,
// radii >= 2.5 m and stay underground except at the entrances.
import type { Rng } from "../../math/rng";
import { cos, sin, atan2 } from "../../math/trig";
import { caveSdf, CAVE_FLOOR, CHAMBER_R } from "../collide";
import type { Ctx } from "../context";
import { gx, N, sample, slopeAt, toI } from "../grid";
import { NO_WATER, type Cave, type CaveNode, type World } from "../types";

interface Entr {
  x: number;
  z: number;
  floor: number;
  dx: number;
  dz: number;
  grotto: boolean;
}

const MAX_GRADE = 0.42;

function cover(ctx: Ctx, x: number, z: number, r: number): number {
  // lowest terrain over a small disc
  let m = sample(ctx.height, x, z);
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * 6.283185307179586;
    const v = sample(ctx.height, x + cos(a) * r, z + sin(a) * r);
    if (v < m) m = v;
  }
  return m;
}

export function cavesStage(ctx: Ctx, rng: Rng): void {
  const h = ctx.height;
  const target = rng.weighted([1, 2, 3], [0.25, 0.5, 0.25]);

  // entrance candidates
  const cands: Entr[] = [];
  const grottos: Entr[] = [];
  for (let iz = 6; iz < N - 6; iz += 3)
    for (let ix = 6; ix < N - 6; ix += 3) {
      const i = iz * N + ix;
      const hv = h[i];
      if (ctx.water[i] !== NO_WATER || ctx.waterDist[i] < 10) continue;
      const x = gx(ix), z = gx(iz);
      // downhill direction
      const gxv = (h[i + 1] - h[i - 1]) / 4, gzv = (h[i + N] - h[i - N]) / 4;
      const gl = Math.sqrt(gxv * gxv + gzv * gzv);
      if (gl < 1e-4) continue;
      const dx = -gxv / gl, dz = -gzv / gl;
      const coast = ctx.coast[i];
      if (coast > 1 && coast < 9 && ctx.cliff[i] > 0.6 && hv > 4) {
        // sea grotto at the base of a cliff: floor under water
        const ex = x + dx * (coast - 1), ez = z + dz * (coast - 1);
        const inland = sample(h, x - dx * 16, z - dz * 16);
        if (inland > 12) grottos.push({ x: ex, z: ez, floor: -1.3, dx, dz, grotto: true });
        continue;
      }
      if (hv < 4 || hv > 120 || coast < 25) continue;
      const s = slopeAt(h, ix, iz);
      if (s < 0.5 || s > 1.7) continue;
      const in20 = sample(h, x - dx * 20, z - dz * 20);
      if (in20 - hv < 11) continue;
      cands.push({ x, z, floor: hv - 0.4, dx, dz, grotto: false });
    }
  rng.shuffle(cands);
  rng.shuffle(grottos);

  const used: { x: number; z: number; r: number }[] = [];
  let grottoLeft = grottos.length > 0 && rng.chance(0.6) ? 1 : 0;

  for (let attempt = 0; attempt < 160 && ctx.caves.length < target; attempt++) {
    let A: Entr;
    if (grottoLeft > 0 && attempt < 40) A = grottos[attempt % grottos.length];
    else {
      if (cands.length === 0) break;
      A = cands[rng.int(cands.length)];
    }
    let far = true;
    for (const u of used) if ((u.x - A.x) * (u.x - A.x) + (u.z - A.z) * (u.z - A.z) < u.r * u.r) far = false;
    if (!far) continue;
    const cave = tryCave(ctx, rng, A, cands);
    if (!cave) continue;
    if (A.grotto) grottoLeft = 0;
    ctx.caves.push(cave);
    const hub = cave.nodes[0];
    used.push({ x: hub.x, z: hub.z, r: 190 });
  }

  // holes: terrain cells whose surface lies inside a cave void, plus the lower
  // cell of any steep face (cliff) that the tunnel passes through, so an
  // opening in a cliff is not covered by a stretched heightfield face.
  const tmp = { seed: ctx.seed, caves: ctx.caves } as unknown as World;
  for (const c of ctx.caves) {
    for (const e of c.entrances) {
      const i0 = toI(e.x - 18), i1 = toI(e.x + 18), j0 = toI(e.z - 18), j1 = toI(e.z + 18);
      for (let iz = j0; iz <= j1; iz++)
        for (let ix = i0; ix <= i1; ix++) {
          const i = iz * N + ix;
          const x = gx(ix), z = gx(iz);
          const ddx = x - e.x, ddz = z - e.z;
          if (ddx * ddx + ddz * ddz < 12 * 12) ctx.blocked[i] |= 4;
          if (caveSdf(tmp, x, h[i], z) < -0.15) {
            ctx.holes[i] = 1;
            continue;
          }
          for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const j = i + oz * N + ox;
            const lo = h[i], hi = h[j];
            if (hi - lo < 1.5) continue;
            const mx = x + ox, mz = z + oz; // midway between the two samples
            const steps = Math.min(20, Math.ceil((hi - lo) / 0.6));
            let cut = false;
            for (let k = 1; k < steps && !cut; k++) if (caveSdf(tmp, mx, lo + ((hi - lo) * k) / steps, mz) < -0.3) cut = true;
            if (cut) {
              ctx.holes[i] = 1;
              break;
            }
          }
        }
    }
  }
}

function tryCave(ctx: Ctx, rng: Rng, A: Entr, cands: Entr[]): Cave | null {
  // hub chamber inward from A: try several spots, keep the best-covered one
  const R = A.grotto ? rng.range(7.5, 9.5) : rng.range(8.5, 13);
  const ceilMargin = 0.45 * R + 0.8 * R + 5;
  let hx = 0, hz = 0, floor = 0, bestM = -1e9;
  const baseAng = atan2(-A.dx, -A.dz);
  for (let k = 0; k < 14; k++) {
    const ang = baseAng + rng.range(-0.6, 0.6);
    const L = rng.range(A.grotto ? 40 : 38, A.grotto ? 110 : 95);
    const x = A.x + sin(ang) * L, z = A.z + cos(ang) * L;
    const minFloor = A.grotto ? 1.2 : A.floor - MAX_GRADE * 0.7 * L;
    const maxFloor = A.floor + MAX_GRADE * 0.7 * L;
    const ground = cover(ctx, x, z, R + 4);
    let f = A.floor + rng.range(-0.15, 0.3) * L;
    if (f < minFloor) f = minFloor;
    if (f > maxFloor) f = maxFloor;
    if (ground - (f + ceilMargin) < 0) f = ground - ceilMargin;
    if (f < minFloor || f > maxFloor || f < 1.2) continue;
    const m = ground - (f + ceilMargin) + rng.range(0, 3);
    if (m > bestM) {
      bestM = m;
      hx = x;
      hz = z;
      floor = f;
    }
  }
  if (bestM < -1e8) return null;
  const hub: CaveNode = { x: hx, y: floor + 0.45 * R, z: hz, r: R };

  // other entrances: around the hub, on other sides
  const others: Entr[] = [];
  const aA = atan2(A.x - hx, A.z - hz);
  const want = rng.chance(0.4) ? 2 : 1;
  const order = cands.slice();
  rng.shuffle(order);
  for (const B of order) {
    if (others.length >= want) break;
    const dx = B.x - hx, dz = B.z - hz;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < 40 || d > 150) continue;
    const aB = atan2(dx, dz);
    let da = aB - aA;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    if (Math.abs(da) < 1.3) continue;
    let ok = true;
    for (const o of others) {
      let db = aB - atan2(o.x - hx, o.z - hz);
      while (db > Math.PI) db -= 2 * Math.PI;
      while (db < -Math.PI) db += 2 * Math.PI;
      if (Math.abs(db) < 1.1) ok = false;
    }
    if (!ok) continue;
    if ((B.dx * dx + B.dz * dz) / d < 0.35) continue; // must face away from the hub
    if (Math.abs(B.floor - floor) > MAX_GRADE * 0.75 * (d - R)) continue;
    others.push(B);
  }
  if (others.length === 0) return null;

  const nodes: CaveNode[] = [hub];
  const edges: [number, number][] = [];
  const entrances: Cave["entrances"] = [];
  const tunnels: number[][] = [];
  for (const E of [A, ...others]) {
    const t = buildTunnel(ctx, rng, E, hub, R, nodes, edges);
    if (!t) return null;
    tunnels.push(t);
    const r0 = nodes[t[0]].r;
    entrances.push({ x: E.x, y: nodes[t[0]].y - CAVE_FLOOR * r0, z: E.z, dx: E.dx, dz: E.dz });
  }
  // optional side gallery with a small chamber (treasure room)
  if (rng.chance(0.65)) {
    const t = tunnels[rng.int(tunnels.length)];
    const mid = t[Math.floor(t.length / 2)];
    const m = nodes[mid];
    const a = rng.range(0, 6.283185307179586);
    const len = rng.range(22, 34);
    const sx = m.x + sin(a) * len, sz = m.z + cos(a) * len;
    const sr = rng.range(7.2, 8.5);
    const sfloor = m.y - CAVE_FLOOR * m.r + rng.range(-0.25, 0.25) * len * 0.5;
    const g = cover(ctx, sx, sz, sr + 3);
    if (g - (sfloor + 1.25 * sr + 4) > 0 && sfloor > 1.2) {
      const mid2: CaveNode = { x: (m.x + sx) / 2 + rng.range(-4, 4), y: 0, z: (m.z + sz) / 2 + rng.range(-4, 4), r: 2.8 };
      mid2.y = (m.y - CAVE_FLOOR * m.r + sfloor) / 2 + CAVE_FLOOR * mid2.r;
      const side: CaveNode = { x: sx, y: sfloor + 0.45 * sr, z: sz, r: sr };
      if (cover(ctx, mid2.x, mid2.z, 3) - (mid2.y + mid2.r + 3) > 0) {
        nodes.push(mid2, side);
        edges.push([mid, nodes.length - 2], [nodes.length - 2, nodes.length - 1]);
      }
    }
  }

  const cave: Cave = { nodes, edges, entrances };
  if (!validate(ctx, cave)) return null;
  return cave;
}

/** Tunnel from entrance E to the hub; returns node indices (entrance first). */
function buildTunnel(
  ctx: Ctx, rng: Rng, E: Entr, hub: CaveNode, R: number, nodes: CaveNode[], edges: [number, number][],
): number[] | null {
  const r0 = E.grotto ? 3.8 : rng.range(3.0, 3.8);
  // mouth node slightly outside the slope so the tube breaks the surface
  const mouth: CaveNode = { x: E.x + E.dx * 1.0, y: E.floor + CAVE_FLOOR * r0, z: E.z + E.dz * 1.0, r: r0 };
  const inner: CaveNode = { x: E.x - E.dx * 9, y: 0, z: E.z - E.dz * 9, r: rng.range(2.8, 3.6) };
  const f0 = E.floor;
  inner.y = f0 + (E.grotto ? 0.6 : rng.range(-0.3, 1.2)) + CAVE_FLOOR * inner.r;
  const idx: number[] = [];
  nodes.push(mouth);
  idx.push(nodes.length - 1);
  nodes.push(inner);
  idx.push(nodes.length - 1);
  edges.push([idx[0], idx[1]]);

  // hub edge point: chamber floor
  const hubFloor = hub.y - 0.45 * R;
  const sx = inner.x, sz = inner.z, sf = inner.y - CAVE_FLOOR * inner.r;
  const dx = hub.x - sx, dz = hub.z - sz;
  const D = Math.sqrt(dx * dx + dz * dz);
  const steps = Math.max(1, Math.round((D - R * 0.6) / 11));
  const px = -dz / D, pz = dx / D;
  const wob = rng.range(6, 14) * (rng.chance(0.5) ? 1 : -1);
  const ph = rng.range(0, 3);
  let prev = idx[1];
  let prevFloor = sf;
  for (let k = 1; k < steps; k++) {
    const t = k / steps;
    const off = wob * sin(t * Math.PI) + 3 * sin(ph + t * 9);
    const x = sx + dx * t + px * off, z = sz + dz * t + pz * off;
    const r = rng.range(2.6, 4.0);
    let fl = sf + (hubFloor - sf) * t + rng.range(-0.6, 0.6);
    // ensure cover: push the floor down if needed (within grade)
    const g = cover(ctx, x, z, r + 2);
    const need = fl + (1 + CAVE_FLOOR) * r + 3.5;
    if (g < need) fl -= need - g;
    const prevN = nodes[prev];
    const hd = Math.sqrt((x - prevN.x) * (x - prevN.x) + (z - prevN.z) * (z - prevN.z));
    if (Math.abs(fl - prevFloor) > MAX_GRADE * hd) return null;
    if (fl < (E.grotto ? -1.5 : 1)) return null;
    nodes.push({ x, y: fl + CAVE_FLOOR * r, z, r });
    edges.push([prev, nodes.length - 1]);
    prev = nodes.length - 1;
    prevFloor = fl;
    idx.push(prev);
  }
  const hd = Math.sqrt((hub.x - nodes[prev].x) * (hub.x - nodes[prev].x) + (hub.z - nodes[prev].z) * (hub.z - nodes[prev].z));
  if (Math.abs(hubFloor - prevFloor) > MAX_GRADE * Math.max(1, hd - R * 0.5)) return null;
  edges.push([prev, 0]);
  return idx;
}

/** Tunnels must stay underground except near their entrances, and must not sit under water. */
function validate(ctx: Ctx, cave: Cave): boolean {
  const tmp = { seed: ctx.seed, caves: [cave] } as unknown as World;
  let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
  for (const n of cave.nodes) {
    x0 = Math.min(x0, n.x - n.r - 2);
    x1 = Math.max(x1, n.x + n.r + 2);
    z0 = Math.min(z0, n.z - n.r - 2);
    z1 = Math.max(z1, n.z + n.r + 2);
  }
  const h = ctx.height;
  for (let iz = toI(z0); iz <= toI(z1); iz++)
    for (let ix = toI(x0); ix <= toI(x1); ix++) {
      const x = gx(ix), z = gx(iz);
      const i = iz * N + ix;
      // near an entrance breaching is expected
      let nearE = false;
      for (const e of cave.entrances) {
        const dx = x - e.x, dz = z - e.z;
        if (dx * dx + dz * dz < 16 * 16) nearE = true;
      }
      if (nearE) continue;
      // test a little above the surface too, to keep a solid roof
      if (caveSdf(tmp, x, h[i] - 1.5, z) < 0) return false;
    }
  // entrances must sit on the surface
  for (const e of cave.entrances) {
    const t = sample(h, e.x, e.z);
    if (Math.abs(t - e.y) > 2.5 && e.y > 0) return false;
  }
  // no two unconnected parts of the cave may overlap in plan at different
  // floor heights (that makes ledges the player cannot climb)
  const S: { x: number; z: number; f: number; r: number; a: number; b: number }[] = [];
  const floorOf = (n: CaveNode, r: number) => (n.r >= CHAMBER_R ? n.y - 0.45 * n.r : n.y - CAVE_FLOOR * r);
  cave.edges.forEach(([ia, ib]) => {
    const A = cave.nodes[ia], Bn = cave.nodes[ib];
    const ra = A.r >= CHAMBER_R ? 4.5 : A.r, rb = Bn.r >= CHAMBER_R ? 4.5 : Bn.r;
    const fa = floorOf(A, ra), fb = floorOf(Bn, rb);
    const L = Math.sqrt((Bn.x - A.x) * (Bn.x - A.x) + (Bn.z - A.z) * (Bn.z - A.z));
    const k = Math.max(1, Math.ceil(L / 1.5));
    for (let j = 0; j <= k; j++) {
      const t = j / k;
      S.push({ x: A.x + (Bn.x - A.x) * t, z: A.z + (Bn.z - A.z) * t, f: fa + (fb - fa) * t, r: ra + (rb - ra) * t, a: ia, b: ib });
    }
  });
  cave.nodes.forEach((n, i) => {
    if (n.r >= CHAMBER_R) S.push({ x: n.x, z: n.z, f: n.y - 0.45 * n.r, r: n.r, a: i, b: i });
  });
  for (let p = 0; p < S.length; p++)
    for (let q = p + 1; q < S.length; q++) {
      const P = S[p], Q = S[q];
      if (P.a === Q.a || P.a === Q.b || P.b === Q.a || P.b === Q.b) continue;
      const dx = P.x - Q.x, dz = P.z - Q.z;
      const rr = (P.r + Q.r) * 0.9;
      if (dx * dx + dz * dz >= rr * rr) continue;
      const df = P.f - Q.f;
      if (df > 1.8 || df < -1.8) return false;
    }
  // sanity: every cave node is inside the world
  for (const n of cave.nodes) if (Math.abs(n.x) > 500 || Math.abs(n.z) > 500) return false;
  return true;
}
