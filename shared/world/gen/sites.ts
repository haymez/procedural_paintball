// Stage 6: sites. Picks spots for the lighthouse, the boathouse + dock, the
// plantation village (village.ts) and a handful of remote ruins (a heiau or a
// chapel on a hilltop, a watchtower, a sugar mill, a ruined plantation house
// or an aqueduct fragment, a Vespa shed), flattens/terraces the ground under
// them and builds their solids. Lush / tropical islands get the Pacific look
// (lava rock, painted boards, tin roofs); Mediterranean / dry ones keep the
// Riviera ruins.
import type { Rng } from "../../math/rng";
import { atan2, cos, sin } from "../../math/trig";
import type { Ctx, Site } from "../context";
import { gx, N, sample, slopeGrid, toI } from "../grid";
import { StructureKind } from "../types";
import { aqueduct, boathouse, Builder, chapel, cottage, jetty, lighthouse, vespaShed, watchtower, type SiteStyle } from "./build";
import { heiau, manor, sugarMill } from "./ruins";
import { addStructure, BLOCK_DOCK, BLOCK_STRUCT, flatten, markDisc, stats } from "./siteutil";
import { hale, placeVillage, villageStyle } from "./village";
import { computeReach } from "../reach";
import { worldFromCtx } from "./gameplay";

export { addStructure, BLOCK_CAVE, BLOCK_DOCK, BLOCK_FIELD, BLOCK_PATH, BLOCK_STRUCT, BLOCK_VILLAGE, BLOCK_WATER, flatten } from "./siteutil";

interface Cand {
  x: number;
  z: number;
  score: number;
}

function best(cands: Cand[]): Cand | null {
  let b: Cand | null = null;
  for (const c of cands) if (!b || c.score > b.score) b = c;
  return b;
}

export function sitesStage(ctx: Ctx, rng: Rng): void {
  slopeGrid(ctx.height, ctx.slope);
  const h = ctx.height;
  const sites = ctx.sites;
  // only build where players can walk to (tablelands ringed by cliffs are out)
  const reach = computeReach(worldFromCtx(ctx)).main;
  const style: SiteStyle = { pacific: ctx.ch.climate === "lush" || ctx.ch.climate === "tropical" };
  // distance to every site so far, counting the village's own radius
  const farFrom = (x: number, z: number, d: number) =>
    sites.every((s) => {
      const r = d + (s.kind === "village" ? s.radius : 0);
      return (s.x - x) * (s.x - x) + (s.z - z) * (s.z - z) >= r * r;
    });
  const distTo = (s: Site | undefined, x: number, z: number) => (s ? Math.sqrt((s.x - x) * (s.x - x) + (s.z - z) * (s.z - z)) : 0);
  const grid: { x: number; z: number; i: number }[] = [];
  for (let iz = 8; iz < N - 8; iz += 4)
    for (let ix = 8; ix < N - 8; ix += 4) {
      const i = iz * N + ix;
      if (h[i] > 0.6 && reach[i]) grid.push({ x: gx(ix), z: gx(iz), i });
    }
  const prominence = (x: number, z: number, r: number) => {
    let s = 0;
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * 6.283185307179586;
      s += sample(h, x + sin(a) * r, z + cos(a) * r);
    }
    return sample(h, x, z) - s / 12;
  };
  const toCenter = (x: number, z: number) => atan2(ctx.cx - x, ctx.cz - z);

  // ---- lighthouse on the most exposed headland ------------------------------
  {
    const cands: Cand[] = [];
    const mainLand = mainLandmass(ctx);
    for (const g of grid) {
      const c = ctx.coast[g.i];
      if (c < 9 || c > 34 || ctx.shelter[g.i] > 0.46 || !mainLand[g.i]) continue;
      const hv = h[g.i];
      if (hv < 3) continue;
      const st = stats(ctx, g.x, g.z, 6);
      if (st.wet || st.min < 1.2 || st.max - st.min > 5) continue;
      cands.push({ x: g.x, z: g.z, score: (0.5 - ctx.shelter[g.i]) * 3 + Math.min(hv, 40) / 40 + ctx.cliff[g.i] * 0.4 + rng.next() * 0.3 });
    }
    const c = best(cands);
    if (c) {
      const st = stats(ctx, c.x, c.z, 6);
      const Y = st.mean;
      flatten(ctx, c.x, c.z, 6.5, 6, Y);
      const rot = toCenter(c.x, c.z);
      const b = new Builder(c.x, Y, c.z, rot);
      const spots = lighthouse(b, rng.fork("lighthouse"), style);
      const id = addStructure(ctx, StructureKind.Lighthouse, b);
      // keeper's cottage beside the tower
      const kb = new Builder(b.wx(-7.5, 1), 0, b.wz(-7.5, 1), rot);
      const kst = stats(ctx, kb.ox, kb.oz, 4.5);
      const ids = [id];
      if (!kst.wet && kst.max - kst.min < 4 && kst.min > 1) {
        kb.oy = kst.mean;
        flatten(ctx, kb.ox, kb.oz, 4.5, 4, kb.oy);
        spots.push(...cottage(kb, rng.fork("keeper"), 5.5, 4.4, false, style));
        ids.push(addStructure(ctx, StructureKind.Cottage, kb));
      }
      sites.push({ kind: "lighthouse", x: c.x, z: c.z, y: Y, rot, radius: 14, structureIds: ids, spots, door: { x: b.wx(0, 6), z: b.wz(0, 6) } });
    }
  }

  // ---- boathouse + dock in the most sheltered bay ------------------------------
  {
    const cands: Cand[] = [];
    for (const g of grid) {
      const c = ctx.coast[g.i];
      if (c < 5 || c > 11) continue;
      const hv = h[g.i];
      if (hv < 0.7 || hv > 4.5 || ctx.shelter[g.i] < 0.42 || ctx.waterDist[g.i] < 14 || ctx.cliff[g.i] > 0.4) continue;
      // seaward direction from the coast-distance gradient
      const dxv = ctx.coast[g.i + 2] - ctx.coast[g.i - 2], dzv = ctx.coast[g.i + 2 * N] - ctx.coast[g.i - 2 * N];
      const l = Math.sqrt(dxv * dxv + dzv * dzv);
      if (l < 1e-3) continue;
      const sx = -dxv / l, sz = -dzv / l;
      const d20 = sample(h, g.x + sx * 22, g.z + sz * 22);
      const d30 = sample(h, g.x + sx * 32, g.z + sz * 32);
      if (d20 > -1.1 || d30 > -1.3) continue;
      if (!farFrom(g.x, g.z, 90)) continue;
      cands.push({ x: g.x, z: g.z, score: ctx.shelter[g.i] * 2 + rng.next() * 0.4 });
    }
    const c = best(cands);
    if (c) {
      const i = toI(c.z) * N + toI(c.x);
      const dxv = ctx.coast[i + 2] - ctx.coast[i - 2], dzv = ctx.coast[i + 2 * N] - ctx.coast[i - 2 * N];
      const l = Math.sqrt(dxv * dxv + dzv * dzv);
      const sx = -dxv / l, sz = -dzv / l;
      const rot = atan2(-sx, -sz); // local -Z faces the water
      const Y = Math.max(1.1, stats(ctx, c.x, c.z, 4).mean);
      flatten(ctx, c.x, c.z, 5.5, 5, Y);
      // dock length: until ~1.8 m deep, plus a bit
      let len = 10;
      while (len < 30 && sample(h, c.x + sx * (len + 3.75), c.z + sz * (len + 3.75)) > -1.8) len += 1;
      len = Math.min(30, len + 4);
      const b = new Builder(c.x, Y, c.z, rot);
      const spots = boathouse(b, rng.fork("boathouse"), len, 0.9, (lx, lz) => sample(h, b.wx(lx, lz), b.wz(lx, lz)), style);
      const id = addStructure(ctx, StructureKind.Boathouse, b);
      markDisc(ctx, b.wx(0, -3.75 - len / 2), b.wz(0, -3.75 - len / 2), len / 2 + 3, BLOCK_DOCK);
      const ids = [id];
      // Pacific islands: a thatched canoe house on the beach beside it, open end to the water
      if (style.pacific) {
        for (const side of [1, -1]) {
          const cx = b.wx(side * 11, 1.0), cz = b.wz(side * 11, 1.0);
          const st = stats(ctx, cx, cz, 5.5);
          if (st.wet || st.max - st.min > 1.6 || st.min < 0.7) continue;
          flatten(ctx, cx, cz, 5.2, 3, st.mean);
          const hb = new Builder(cx, st.mean, cz, rot + Math.PI);
          const ground = (lx: number, lz: number) => sample(h, hb.wx(lx, lz), hb.wz(lx, lz)) - st.mean;
          hale(hb, rng.fork("canoe"), { w: 8.8, d: 4.4, pd: 0, fh: 0.45, base: -0.7, below: 0.7, paint: 0, trim: 0, roof: 0, ground }, villageStyle(ctx), true);
          ids.push(addStructure(ctx, StructureKind.Hale, hb));
          break;
        }
      }
      sites.push({ kind: "boathouse", x: c.x, z: c.z, y: Y, rot, radius: 10, structureIds: ids, spots, door: { x: b.wx(0, 6.5), z: b.wz(0, 6.5) } });
    }
  }

  // ---- the plantation village: gentle ground, ideally a short road from the boathouse -------
  const village = placeVillage(ctx, rng.fork("village"), { grid, sites, boat: sites.find((s) => s.kind === "boathouse"), reach });
  if (village) sites.push(village);

  // ---- hilltop: a heiau (Pacific islands) or a chapel, overlooking the village ---------------
  {
    const R = style.pacific ? 13 : 10;
    const cands: Cand[] = [];
    for (const g of grid) {
      const hv = h[g.i];
      if (hv < 20 || hv > 115 || ctx.slope[g.i] > 0.3) continue;
      if (!farFrom(g.x, g.z, 110)) continue;
      const pr = prominence(g.x, g.z, 40);
      if (pr < 1.5) continue;
      const st = stats(ctx, g.x, g.z, R);
      if (st.wet || st.max - st.min > (style.pacific ? 8 : 7)) continue;
      let score = pr / 8 + rng.next() * 0.4 - (st.max - st.min) * 0.05;
      if (village) {
        const d = distTo(village, g.x, g.z);
        score += d > 110 && d < 330 ? 0.7 : 0;
      }
      cands.push({ x: g.x, z: g.z, score });
    }
    const c = best(cands);
    if (c) {
      const st = stats(ctx, c.x, c.z, R);
      const Y = st.mean;
      flatten(ctx, c.x, c.z, R, 8, Y);
      const rot = village ? atan2(village.x - c.x, village.z - c.z) : toCenter(c.x, c.z) + Math.PI;
      const b = new Builder(c.x, Y, c.z, rot);
      if (style.pacific) {
        const spots = heiau(b, rng.fork("heiau"));
        const ids = [addStructure(ctx, StructureKind.Heiau, b)];
        sites.push({ kind: "heiau", x: c.x, z: c.z, y: Y, rot, radius: 15, structureIds: ids, spots, door: { x: b.wx(0, 12), z: b.wz(0, 12) } });
      } else {
        const spots = chapel(b, rng.fork("chapel"));
        const ids = [addStructure(ctx, StructureKind.Chapel, b)];
        sites.push({ kind: "chapel", x: c.x, z: c.z, y: Y, rot, radius: 14, structureIds: ids, spots, door: { x: b.wx(0, 10), z: b.wz(0, 10) } });
      }
    }
  }

  // ---- watchtower on a high shoulder, far from the others ----------------------------
  {
    const cands: Cand[] = [];
    for (const g of grid) {
      const hv = h[g.i];
      if (hv < 30 || ctx.slope[g.i] > 0.45) continue;
      if (!farFrom(g.x, g.z, 170)) continue;
      const st = stats(ctx, g.x, g.z, 5.5);
      if (st.wet || st.max - st.min > 5) continue;
      const pr = prominence(g.x, g.z, 30);
      cands.push({ x: g.x, z: g.z, score: Math.min(hv, 120) / 90 + pr / 10 + rng.next() * 0.5 });
    }
    const c = best(cands);
    if (c) {
      const st = stats(ctx, c.x, c.z, 5.5);
      const Y = st.mean;
      flatten(ctx, c.x, c.z, 5.5, 6, Y);
      // door faces downhill
      const i = toI(c.z) * N + toI(c.x);
      const rot = atan2(-(h[i + 2] - h[i - 2]), -(h[i + 2 * N] - h[i - 2 * N]));
      const b = new Builder(c.x, Y, c.z, rot);
      const spots = watchtower(b, rng.fork("tower"), style);
      const ids = [addStructure(ctx, StructureKind.Watchtower, b)];
      sites.push({ kind: "watchtower", x: c.x, z: c.z, y: Y, rot, radius: 8, structureIds: ids, spots, door: { x: b.wx(0, 6), z: b.wz(0, 6) } });
    }
  }

  // ---- sugar mill: lowland, near a stream, not far from the sea --------------------------
  {
    const cands: Cand[] = [];
    for (const g of grid) {
      const hv = h[g.i];
      if (hv < 3 || hv > 50 || ctx.slope[g.i] > 0.22) continue;
      const wd = ctx.waterDist[g.i];
      if (wd < 16) continue;
      if (!farFrom(g.x, g.z, 105)) continue;
      const st = stats(ctx, g.x, g.z, 12);
      if (st.wet || st.max - st.min > 4.5) continue;
      cands.push({ x: g.x, z: g.z, score: rng.next() * 0.5 + (wd < 80 ? 0.45 : 0) + (ctx.coast[g.i] < 170 ? 0.3 : 0) - (st.max - st.min) * 0.1 });
    }
    const c = best(cands);
    if (c) {
      const st = stats(ctx, c.x, c.z, 12);
      flatten(ctx, c.x, c.z, 11, 9, st.mean);
      const rot = village ? atan2(village.x - c.x, village.z - c.z) : toCenter(c.x, c.z);
      const b = new Builder(c.x, st.mean, c.z, rot);
      const spots = sugarMill(b, rng.fork("mill"), style, (lx, lz) => sample(h, b.wx(lx, lz), b.wz(lx, lz)) - b.oy);
      const ids = [addStructure(ctx, StructureKind.SugarMill, b)];
      sites.push({ kind: "mill", x: c.x, z: c.z, y: st.mean, rot, radius: 14, structureIds: ids, spots, door: { x: b.wx(0, 9), z: b.wz(0, 9) } });
    }
  }

  // ---- Vespa shed just outside the village (or anywhere flat) -------------------------------
  {
    const anchor = village ?? sites[0];
    const cands: Cand[] = [];
    for (const g of grid) {
      const hv = h[g.i];
      if (hv < 2 || ctx.slope[g.i] > 0.2) continue;
      const d = anchor ? distTo(anchor, g.x, g.z) : 100;
      const r0 = anchor ? anchor.radius : 0;
      if (anchor && (d < r0 + 12 || d > r0 + 80)) continue;
      if (!sites.every((s) => s === anchor || distTo(s, g.x, g.z) > 70 + (s.kind === "village" ? s.radius : 0))) continue;
      const st = stats(ctx, g.x, g.z, 4.5);
      if (st.wet || st.max - st.min > 2.5) continue;
      cands.push({ x: g.x, z: g.z, score: rng.next() - (st.max - st.min) * 0.2 });
    }
    const c = best(cands);
    if (c) {
      const st = stats(ctx, c.x, c.z, 4.5);
      flatten(ctx, c.x, c.z, 5, 5, st.mean);
      const rot = anchor ? atan2(anchor.x - c.x, anchor.z - c.z) : 0;
      const b = new Builder(c.x, st.mean, c.z, rot);
      const spots = vespaShed(b, rng.fork("shed"), style);
      const ids = [addStructure(ctx, StructureKind.VespaShed, b)];
      sites.push({ kind: "shed", x: c.x, z: c.z, y: st.mean, rot, radius: 6, structureIds: ids, spots, door: { x: b.wx(0, 5), z: b.wz(0, 5) } });
    }
  }

  // ---- open country: a ruined plantation house (Pacific) or an aqueduct fragment ---------------
  if (style.pacific ? rng.chance(0.8) : rng.chance(0.65)) {
    const R = style.pacific ? 10 : 11;
    const cands: Cand[] = [];
    for (const g of grid) {
      const hv = h[g.i];
      if (hv < 6 || hv > 70 || ctx.slope[g.i] > 0.22 || ctx.coast[g.i] < 50) continue;
      if (!farFrom(g.x, g.z, 110)) continue;
      const st = stats(ctx, g.x, g.z, R);
      if (st.wet || st.max - st.min > 5) continue;
      cands.push({ x: g.x, z: g.z, score: rng.next() - (st.max - st.min) * 0.1 });
    }
    const c = best(cands);
    if (c) {
      const i = toI(c.z) * N + toI(c.x);
      if (style.pacific) {
        const st = stats(ctx, c.x, c.z, R);
        flatten(ctx, c.x, c.z, R, 8, st.mean);
        // the veranda looks downhill
        const rot = atan2(-(h[i + 2] - h[i - 2]), -(h[i + 2 * N] - h[i - 2 * N]));
        const b = new Builder(c.x, st.mean, c.z, rot);
        const spots = manor(b, rng.fork("manor"), style);
        const ids = [addStructure(ctx, StructureKind.Manor, b)];
        sites.push({ kind: "manor", x: c.x, z: c.z, y: st.mean, rot, radius: 12, structureIds: ids, spots, door: { x: b.wx(0, 10.5), z: b.wz(0, 10.5) } });
      } else {
        // run along the contour
        const gxv = h[i + 2] - h[i - 2], gzv = h[i + 2 * N] - h[i - 2 * N];
        const rot = atan2(gxv, gzv) + Math.PI / 2;
        const Y = sample(h, c.x, c.z);
        const b = new Builder(c.x, Y, c.z, rot);
        const spots = aqueduct(b, rng.fork("aqueduct"), (lx) => sample(h, b.wx(lx, 0), b.wz(lx, 0)) - Y);
        const ids = [addStructure(ctx, StructureKind.Arch, b)];
        sites.push({ kind: "aqueduct", x: c.x, z: c.z, y: Y, rot, radius: 12, structureIds: ids, spots, door: { x: b.wx(0, 5), z: b.wz(0, 5) } });
      }
    }
  }
  // ---- jetties at the heads of coves ---------------------------------------------
  for (const cv of ctx.coves) {
    // walk from the head pool inland to the shore; where a stream runs into
    // the head, step sideways so the jetty stands beside its mouth, not in it
    let bx = 0, bz = 0, found = false;
    for (const side of [0, 0.8, -0.8]) {
      const sx = -cv.dz * cv.wid * side, sz = cv.dx * cv.wid * side;
      for (let t = 0; t < cv.wid * 2.5; t += 1) {
        const x = cv.x + sx - cv.dx * t, z = cv.z + sz - cv.dz * t;
        if (ctx.waterDist[toI(z) * N + toI(x)] < 4) break;
        if (sample(h, x, z) > 0.35) { bx = x; bz = z; found = true; break; }
      }
      if (found) break;
    }
    if (!found || ctx.blocked[toI(bz) * N + toI(bx)] & (BLOCK_STRUCT | BLOCK_DOCK)) continue;
    let len = 5;
    while (len < 14 && sample(h, bx + cv.dx * (len + 1), bz + cv.dz * (len + 1)) > -1.5) len += 1;
    if (sample(h, bx + cv.dx * len, bz + cv.dz * len) > -0.8) continue;
    // run on a few metres into deeper water, if the cove allows it
    for (let k = 0; k < 5 && sample(h, bx + cv.dx * (len + 3), bz + cv.dz * (len + 3)) < -1.2; k++) len += 1;
    const rot = atan2(-cv.dx, -cv.dz); // local -Z faces the water
    const b = new Builder(bx, 0, bz, rot);
    const spots = jetty(b, rng.fork("jetty" + ctx.coves.indexOf(cv)), len, 0.85, (lx, lz) => sample(h, b.wx(lx, lz), b.wz(lx, lz)));
    const id = addStructure(ctx, StructureKind.Dock, b);
    markDisc(ctx, b.wx(0, -len / 2), b.wz(0, -len / 2), len / 2 + 2, BLOCK_DOCK);
    sites.push({ kind: "jetty", x: bx, z: bz, y: 0.85, rot, radius: 4, structureIds: [id], spots, door: { x: b.wx(0, 4), z: b.wz(0, 4) } });
  }

  slopeGrid(ctx.height, ctx.slope);
}

/** Cells of the largest connected land mass. */
function mainLandmass(ctx: Ctx): Uint8Array {
  const land = ctx.land;
  const lab = new Int32Array(N * N).fill(-1);
  const stack = new Int32Array(N * N);
  let best = -1, bestN = 0, id = 0;
  for (let s = 0; s < N * N; s++) {
    if (!land[s] || lab[s] >= 0) continue;
    let sp = 0, n = 0;
    stack[sp++] = s;
    lab[s] = id;
    while (sp > 0) {
      const i = stack[--sp];
      n++;
      const ix = i % N;
      if (ix > 0 && land[i - 1] && lab[i - 1] < 0) { lab[i - 1] = id; stack[sp++] = i - 1; }
      if (ix < N - 1 && land[i + 1] && lab[i + 1] < 0) { lab[i + 1] = id; stack[sp++] = i + 1; }
      if (i >= N && land[i - N] && lab[i - N] < 0) { lab[i - N] = id; stack[sp++] = i - N; }
      if (i < N * N - N && land[i + N] && lab[i + N] < 0) { lab[i + N] = id; stack[sp++] = i + N; }
    }
    if (n > bestN) {
      bestN = n;
      best = id;
    }
    id++;
  }
  const out = new Uint8Array(N * N);
  for (let i = 0; i < N * N; i++) out[i] = lab[i] === best ? 1 : 0;
  return out;
}
