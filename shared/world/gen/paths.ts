// Stage 7: dirt paths. A slope-aware A* on a 4 m grid links the sites (plus a
// cave mouth and a beach or two) into a small network; paths are smoothed,
// the ground is gently flattened across them, and footbridges are built where
// they cross streams. The village joins at its street ends, and a wider main
// road always runs from the village to the boathouse.
import { Noise } from "../../math/noise";
import type { Rng } from "../../math/rng";
import { atan2, cos, sin } from "../../math/trig";
import { smoothstep } from "../../math/vec";
import type { Ctx } from "../context";
import { D8L, D8X, D8Z, gx, Heap, N, sample, toI } from "../grid";
import { NO_WATER, StructureKind, type Path } from "../types";
import { Builder, bridgeDeck } from "./build";
import { addStructure, BLOCK_CAVE, BLOCK_FIELD, BLOCK_PATH, BLOCK_STRUCT } from "./sites";

const W = 257; // A* grid (4 m)
const CS = 4;

interface Node {
  x: number;
  z: number;
}

export function pathsStage(ctx: Ctx, rng: Rng): void {
  const h = ctx.height;
  // coarse cost grid
  const hc = new Float32Array(W * W);
  const bad = new Uint8Array(W * W); // 1 impassable, 2 river (costly)
  for (let iz = 0; iz < W; iz++)
    for (let ix = 0; ix < W; ix++) {
      const j = iz * 2 * N + ix * 2;
      const k = iz * W + ix;
      hc[k] = h[j];
      if (h[j] < 0.4 || ctx.holes[j] || (ctx.blocked[j] & (BLOCK_STRUCT | BLOCK_CAVE | BLOCK_FIELD))) bad[k] = 1;
      else if (ctx.water[j] !== NO_WATER) {
        const isLake = ctx.lakeCells.length > 0 && ctx.water[j] > h[j] + 1.6;
        bad[k] = isLake ? 1 : 2;
      }
    }
  const onPath = new Uint8Array(W * W);
  // gentle meander: a noisy cost field
  const wig = new Float32Array(W * W);
  const wn = new Noise(rng.fork("meander"));
  for (let iz = 0; iz < W; iz++)
    for (let ix = 0; ix < W; ix++) wig[iz * W + ix] = 1 + 0.6 * (0.5 + 0.5 * wn.fbm(ix / 9, iz / 9, 2));

  // nodes: site doors (the village has a gate at each street end and the lane)
  const nodes: Node[] = [];
  const owner: number[] = []; // site index per node (-1: cave / beach)
  ctx.sites.forEach((s, si) => {
    const gates = s.spots.filter((p) => p.tag === "gate");
    if (gates.length) for (const g of gates) { nodes.push(clampFree(ctx, g.x, g.z)); owner.push(si); }
    else { nodes.push(clampFree(ctx, s.door.x, s.door.z)); owner.push(si); }
  });
  for (const c of ctx.caves) {
    const e = c.entrances.find((q) => q.y > 1);
    if (e) { nodes.push(clampFree(ctx, e.x + e.dx * 7, e.z + e.dz * 7)); owner.push(-1); }
  }
  // one or two beaches far from the other nodes
  for (let tries = 0; tries < 2; tries++) {
    let bestS = -1, bx = 0, bz = 0;
    for (let iz = 6; iz < N - 6; iz += 6)
      for (let ix = 6; ix < N - 6; ix += 6) {
        const i = iz * N + ix;
        const c = ctx.coast[i];
        if (c < 14 || c > 26 || ctx.cliff[i] > 0.3 || h[i] < 1 || h[i] > 5) continue;
        const x = gx(ix), z = gx(iz);
        let md = 1e9;
        for (const n of nodes) md = Math.min(md, (n.x - x) * (n.x - x) + (n.z - z) * (n.z - z));
        const sc = Math.sqrt(md) + rng.next() * 30;
        if (sc > bestS) {
          bestS = sc;
          bx = x;
          bz = z;
        }
      }
    if (bestS > 140) { nodes.push({ x: bx, z: bz }); owner.push(-1); }
  }
  if (nodes.length < 2) return;

  // MST (Prim) + a couple of loop edges. Gates of the same site are already
  // joined by its own streets: distance 0, no path built.
  const n = nodes.length;
  const same = (a: number, b: number) => owner[a] >= 0 && owner[a] === owner[b];
  const inT = new Uint8Array(n);
  const edges: [number, number][] = [];
  inT[0] = 1;
  for (let it = 1; it < n; it++) {
    let ba = -1, bb = -1, bd = 1e18;
    for (let a = 0; a < n; a++) {
      if (!inT[a]) continue;
      for (let b = 0; b < n; b++) {
        if (inT[b]) continue;
        const d = same(a, b) ? -1 : (nodes[a].x - nodes[b].x) * (nodes[a].x - nodes[b].x) + (nodes[a].z - nodes[b].z) * (nodes[a].z - nodes[b].z);
        if (d < bd) {
          bd = d;
          ba = a;
          bb = b;
        }
      }
    }
    inT[bb] = 1;
    if (!same(ba, bb)) edges.push([ba, bb]);
  }
  const extra: [number, number, number][] = [];
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++) {
      if (same(a, b) || edges.some(([p, q]) => (p === a && q === b) || (p === b && q === a))) continue;
      const d = Math.sqrt((nodes[a].x - nodes[b].x) * (nodes[a].x - nodes[b].x) + (nodes[a].z - nodes[b].z) * (nodes[a].z - nodes[b].z));
      if (d < 420) extra.push([a, b, d]);
    }
  extra.sort((p, q) => p[2] - q[2]);
  const nExtra = Math.min(extra.length, rng.intRange(1, 2));
  for (let k = 0; k < nExtra; k++) edges.push([extra[k][0], extra[k][1]]);
  // the village's main road runs to the boathouse
  const vi = ctx.sites.findIndex((s) => s.kind === "village"), bi = ctx.sites.findIndex((s) => s.kind === "boathouse");
  let mainRoad: [number, number] | null = null;
  if (vi >= 0 && bi >= 0) {
    const bn = owner.indexOf(bi);
    let gn = -1, gd = 1e18;
    owner.forEach((o, k) => {
      if (o !== vi) return;
      const d = (nodes[k].x - nodes[bn].x) * (nodes[k].x - nodes[bn].x) + (nodes[k].z - nodes[bn].z) * (nodes[k].z - nodes[bn].z);
      if (d < gd) { gd = d; gn = k; }
    });
    if (gn >= 0 && bn >= 0) {
      mainRoad = [gn, bn];
      if (!edges.some(([p, q]) => (p === gn && q === bn) || (p === bn && q === gn))) edges.unshift([gn, bn]);
    }
  }

  // A*
  const g = new Float32Array(W * W);
  const came = new Int32Array(W * W);
  const closed = new Uint8Array(W * W);
  const heap = new Heap(1 << 14);
  const astar = (a: Node, b: Node): number[] | null => {
    const sx = Math.round((a.x + 512) / CS), sz = Math.round((a.z + 512) / CS);
    const tx = Math.round((b.x + 512) / CS), tz = Math.round((b.z + 512) / CS);
    const s = sz * W + sx, t = tz * W + tx;
    g.fill(1e30);
    closed.fill(0);
    heap.size = 0;
    g[s] = 0;
    came[s] = -1;
    heap.push(0, s);
    while (heap.size > 0) {
      const c = heap.pop();
      if (c === t) break;
      if (closed[c]) continue;
      closed[c] = 1;
      const cx = c % W, cz = (c / W) | 0;
      for (let d = 0; d < 8; d++) {
        const nx = cx + D8X[d], nz = cz + D8Z[d];
        if (nx < 1 || nz < 1 || nx >= W - 1 || nz >= W - 1) continue;
        const k = nz * W + nx;
        if (closed[k]) continue;
        const nearEnd = Math.abs(nx - tx) + Math.abs(nz - tz) <= 2 || Math.abs(nx - sx) + Math.abs(nz - sz) <= 2;
        if (bad[k] === 1 && !nearEnd) continue;
        const L = D8L[d] * CS;
        const dh = Math.abs(hc[k] - hc[c]);
        const sl = dh / L;
        if (sl > 0.42 && !nearEnd) continue;
        let cost = L * (wig[k] + 26 * sl * sl + (sl > 0.25 ? 6 : 0));
        if (bad[k] === 2) cost += 60;
        if (onPath[k]) cost *= 0.55;
        const ng = g[c] + cost;
        if (ng < g[k]) {
          g[k] = ng;
          came[k] = c;
          const hx = nx - tx, hz = nz - tz;
          heap.push(ng + Math.sqrt(hx * hx + hz * hz) * CS * 0.55, k);
        }
      }
    }
    if (g[t] >= 1e30) return null;
    const out: number[] = [];
    for (let c = t; c !== -1; c = came[c]) out.push(c);
    return out.reverse();
  };

  const rd = new Float32Array(N * N).fill(1e9);
  const target = new Float32Array(N * N);
  const allPts: { pts: { x: number; z: number; y: number }[]; w: number }[] = [];
  for (const [a, b] of edges) {
    const cells = astar(nodes[a], nodes[b]);
    if (!cells || cells.length < 3) continue;
    for (const c of cells) onPath[c] = 1;
    let pts = cells.map((c) => ({ x: (c % W) * CS - 512, z: ((c / W) | 0) * CS - 512 }));
    pts[0] = { x: nodes[a].x, z: nodes[a].z };
    pts[pts.length - 1] = { x: nodes[b].x, z: nodes[b].z };
    pts = smoothPts(pts, 3);
    pts = resamplePts(pts, 2);
    // smoothed height profile along the path
    const raw = pts.map((p) => sample(h, p.x, p.z));
    const ys = raw.map((_, k) => {
      let s = 0, c = 0;
      for (let j = -4; j <= 4; j++) {
        const q = k + j;
        if (q < 0 || q >= raw.length) continue;
        s += raw[q];
        c++;
      }
      return s / c;
    });
    const isMain = mainRoad !== null && ((a === mainRoad[0] && b === mainRoad[1]) || (a === mainRoad[1] && b === mainRoad[0]));
    const width = isMain ? 4.2 : rng.range(2.4, 3.1);
    allPts.push({ pts: pts.map((p, k) => ({ x: p.x, z: p.z, y: ys[k] })), w: width });
  }

  // flatten & paint: nearest path point per cell
  for (const P of allPts) {
    const R = P.w / 2 + 2.2;
    for (let k = 0; k < P.pts.length - 1; k++) {
      const a = P.pts[k], b = P.pts[k + 1];
      const x0 = toI(Math.min(a.x, b.x) - R), x1 = toI(Math.max(a.x, b.x) + R);
      const z0 = toI(Math.min(a.z, b.z) - R), z1 = toI(Math.max(a.z, b.z) + R);
      const abx = b.x - a.x, abz = b.z - a.z;
      const l2 = abx * abx + abz * abz || 1;
      for (let iz = z0; iz <= z1; iz++)
        for (let ix = x0; ix <= x1; ix++) {
          const x = gx(ix), z = gx(iz);
          let t = ((x - a.x) * abx + (z - a.z) * abz) / l2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const dx = x - a.x - abx * t, dz = z - a.z - abz * t;
          const d = Math.sqrt(dx * dx + dz * dz);
          const i = iz * N + ix;
          if (d < rd[i]) {
            rd[i] = d;
            target[i] = a.y + (b.y - a.y) * t;
          }
          const cov = 1 - smoothstep(P.w * 0.3, P.w / 2 + 0.8, d);
          const v = Math.round(cov * 255);
          if (v > ctx.path[i]) ctx.path[i] = v;
        }
    }
  }
  for (let i = 0; i < N * N; i++) {
    const d = rd[i];
    if (d > 4) continue;
    if (ctx.water[i] !== NO_WATER || ctx.holes[i] || (ctx.blocked[i] & BLOCK_STRUCT)) continue;
    if (ctx.path[i] > 90) ctx.blocked[i] |= BLOCK_PATH;
    // leave stream banks as hydrology carved them (the smoothed path profile dips
    // into the channel at a crossing; the bridge spans it instead)
    if (ctx.waterDist[i] < 4) continue;
    const w = 1 - smoothstep(1.4, 4, d);
    let nh = h[i] + (target[i] - h[i]) * w * 0.85;
    // never dig dry ground down toward the water line (no wet pockets by the sea)
    if (nh < h[i] && nh < 0.3) nh = h[i] < 0.3 ? h[i] : 0.3;
    h[i] = nh;
  }

  // bridges where paths cross rivers
  for (const P of allPts) {
    const pts = P.pts;
    let k = 0;
    while (k < pts.length) {
      const i = toI(pts[k].z) * N + toI(pts[k].x);
      if (ctx.water[i] === NO_WATER) {
        k++;
        continue;
      }
      let e = k;
      while (e < pts.length - 1 && ctx.water[toI(pts[e + 1].z) * N + toI(pts[e + 1].x)] !== NO_WATER) e++;
      const a = pts[Math.max(0, k - 2)], b = pts[Math.min(pts.length - 1, e + 2)];
      const dx = b.x - a.x, dz = b.z - a.z;
      const L = Math.sqrt(dx * dx + dz * dz);
      const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
      const dup = ctx.structures.some((st) => st.kind === StructureKind.Bridge && (st.x - mx) * (st.x - mx) + (st.z - mz) * (st.z - mz) < 12 * 12);
      if (L > 1 && L < 30 && !dup) {
        const ux = dx / L, uz = dz / L;
        const wl = ctx.water[i];
        const y = Math.max(sample(h, a.x, a.z), sample(h, b.x, b.z), wl + 0.8) + 0.15;
        const bld = new Builder((a.x + b.x) / 2, 0, (a.z + b.z) / 2, atan2(-uz, ux));
        bridgeDeck(bld, L + 2.5, y);
        addStructure(ctx, StructureKind.Bridge, bld);
      }
      k = e + 3;
    }
  }

  // (the village streets are already in ctx.paths)
  ctx.paths.push(...allPts.map((P): Path => ({ points: P.pts.map((p) => ({ x: p.x, z: p.z })), width: P.w })));
}

function clampFree(ctx: Ctx, x: number, z: number): Node {
  // nudge off structure / water cells
  for (let r = 0; r <= 14; r += 2) {
    const cnt = r === 0 ? 1 : 8;
    for (let k = 0; k < cnt; k++) {
      const a = (k / cnt) * 6.283185307179586;
      const px = x + sin(a) * r, pz = z + cos(a) * r;
      const i = toI(pz) * N + toI(px);
      if (!(ctx.blocked[i] & BLOCK_STRUCT) && ctx.height[i] > 0.5 && ctx.water[i] === NO_WATER) return { x: px, z: pz };
    }
  }
  return { x, z };
}

function smoothPts(pts: { x: number; z: number }[], iters: number): { x: number; z: number }[] {
  let p = pts;
  for (let it = 0; it < iters; it++) {
    if (p.length < 3) return p;
    const q = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i], b = p[i + 1];
      q.push({ x: a.x * 0.75 + b.x * 0.25, z: a.z * 0.75 + b.z * 0.25 }, { x: a.x * 0.25 + b.x * 0.75, z: a.z * 0.25 + b.z * 0.75 });
    }
    q.push(p[p.length - 1]);
    p = q;
  }
  return p;
}

function resamplePts(pts: { x: number; z: number }[], step: number): { x: number; z: number }[] {
  const out = [pts[0]];
  let carry = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z;
    const L = Math.sqrt(dx * dx + dz * dz);
    let d = step - carry;
    while (d <= L) {
      out.push({ x: a.x + (dx * d) / L, z: a.z + (dz * d) / L });
      d += step;
    }
    carry = L - (d - step);
  }
  out.push(pts[pts.length - 1]);
  return out;
}
