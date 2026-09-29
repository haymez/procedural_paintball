// Stage 6: sites. Picks spots for a handful of remote ruins (hamlet, lighthouse,
// chapel, watchtower, boathouse + dock, Vespa shed, aqueduct fragment),
// flattens/terraces the ground under them and builds their solids.
import type { Rng } from "../../math/rng";
import { atan2, cos, sin } from "../../math/trig";
import { smoothstep } from "../../math/vec";
import type { Ctx, Site } from "../context";
import { gx, N, sample, slopeGrid, toI } from "../grid";
import { NO_WATER, StructureKind, Material, type Solid } from "../types";
import { aqueduct, boathouse, Builder, chapel, cottage, jetty, lighthouse, TINT, vespaShed, watchtower, well, type Spot } from "./build";

export const BLOCK_STRUCT = 1;
export const BLOCK_PATH = 2;
export const BLOCK_CAVE = 4;
export const BLOCK_WATER = 8;
export const BLOCK_DOCK = 16;
export const BLOCK_VILLAGE = 32;

interface Stats {
  mean: number;
  min: number;
  max: number;
  wet: boolean;
}

function stats(ctx: Ctx, x: number, z: number, r: number): Stats {
  let sum = 0, n = 0, mn = 1e9, mx = -1e9, wet = false;
  const h = ctx.height;
  for (let ring = 0; ring <= 2; ring++) {
    const rr = (r * ring) / 2;
    const cnt = ring === 0 ? 1 : ring * 8;
    for (let k = 0; k < cnt; k++) {
      const a = (k / cnt) * 6.283185307179586 + ring * 0.3;
      const px = x + sin(a) * rr, pz = z + cos(a) * rr;
      const v = sample(h, px, pz);
      sum += v;
      n++;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
      const i = toI(pz) * N + toI(px);
      if (ctx.water[i] !== NO_WATER || ctx.holes[i] || (ctx.blocked[i] & (BLOCK_CAVE | BLOCK_STRUCT))) wet = true;
    }
  }
  return { mean: sum / n, min: mn, max: mx, wet };
}

/** Flatten ground to Y inside radius r, blending over margin. */
export function flatten(ctx: Ctx, x: number, z: number, r: number, margin: number, Y: number): void {
  const h = ctx.height;
  const R = r + margin;
  for (let iz = toI(z - R); iz <= toI(z + R); iz++)
    for (let ix = toI(x - R); ix <= toI(x + R); ix++) {
      const dx = gx(ix) - x, dz = gx(iz) - z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d > R) continue;
      const i = iz * N + ix;
      if (ctx.water[i] !== NO_WATER || ctx.holes[i]) continue;
      const w = 1 - smoothstep(r, R, d);
      h[i] = h[i] + (Y - h[i]) * w;
    }
}

function markFootprint(ctx: Ctx, solids: Solid[], bit: number, pad: number): void {
  for (const s of solids) {
    const r = (s.shape === "cylinder" ? s.hx : Math.sqrt(s.hx * s.hx + s.hz * s.hz)) + pad;
    for (let iz = toI(s.cz - r); iz <= toI(s.cz + r); iz++)
      for (let ix = toI(s.cx - r); ix <= toI(s.cx + r); ix++) {
        const dx = gx(ix) - s.cx, dz = gx(iz) - s.cz;
        if (dx * dx + dz * dz <= r * r) ctx.blocked[iz * N + ix] |= bit;
      }
  }
}

function markDisc(ctx: Ctx, x: number, z: number, r: number, bit: number): void {
  for (let iz = toI(z - r); iz <= toI(z + r); iz++)
    for (let ix = toI(x - r); ix <= toI(x + r); ix++) {
      const dx = gx(ix) - x, dz = gx(iz) - z;
      if (dx * dx + dz * dz <= r * r) ctx.blocked[iz * N + ix] |= bit;
    }
}

export function addStructure(ctx: Ctx, kind: StructureKind, b: Builder): number {
  const id = ctx.structures.length;
  ctx.structures.push({ id, kind, x: b.ox, y: b.oy, z: b.oz, rotY: b.rot, solids: b.solids });
  markFootprint(ctx, b.solids, BLOCK_STRUCT, 1.0);
  return id;
}

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
  const farFrom = (x: number, z: number, d: number) => sites.every((s) => (s.x - x) * (s.x - x) + (s.z - z) * (s.z - z) >= d * d);
  const distTo = (s: Site | undefined, x: number, z: number) => (s ? Math.sqrt((s.x - x) * (s.x - x) + (s.z - z) * (s.z - z)) : 0);
  const grid: { x: number; z: number; i: number }[] = [];
  for (let iz = 8; iz < N - 8; iz += 4)
    for (let ix = 8; ix < N - 8; ix += 4) {
      const i = iz * N + ix;
      if (h[i] > 0.6) grid.push({ x: gx(ix), z: gx(iz), i });
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
      const spots = lighthouse(b, rng.fork("lighthouse"));
      const id = addStructure(ctx, StructureKind.Lighthouse, b);
      // keeper's cottage beside the tower
      const kb = new Builder(b.wx(-7.5, 1), 0, b.wz(-7.5, 1), rot);
      const kst = stats(ctx, kb.ox, kb.oz, 4.5);
      const ids = [id];
      if (!kst.wet && kst.max - kst.min < 4 && kst.min > 1) {
        kb.oy = kst.mean;
        flatten(ctx, kb.ox, kb.oz, 4.5, 4, kb.oy);
        spots.push(...cottage(kb, rng.fork("keeper"), 5.5, 4.4, false));
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
      const ix = g.i % N, iz = (g.i / N) | 0;
      const dxv = ctx.coast[g.i + 2] - ctx.coast[g.i - 2], dzv = ctx.coast[g.i + 2 * N] - ctx.coast[g.i - 2 * N];
      const l = Math.sqrt(dxv * dxv + dzv * dzv);
      if (l < 1e-3) continue;
      const sx = -dxv / l, sz = -dzv / l;
      const d20 = sample(h, g.x + sx * 22, g.z + sz * 22);
      const d30 = sample(h, g.x + sx * 32, g.z + sz * 32);
      if (d20 > -1.1 || d30 > -1.3) continue;
      if (!farFrom(g.x, g.z, 90)) continue;
      void ix;
      void iz;
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
      const spots = boathouse(b, rng.fork("boathouse"), len, 0.9, (lx, lz) => sample(h, b.wx(lx, lz), b.wz(lx, lz)));
      const id = addStructure(ctx, StructureKind.Boathouse, b);
      markDisc(ctx, b.wx(0, -3.75 - len / 2), b.wz(0, -3.75 - len / 2), len / 2 + 3, BLOCK_DOCK);
      sites.push({ kind: "boathouse", x: c.x, z: c.z, y: Y, rot, radius: 10, structureIds: [id], spots, door: { x: b.wx(0, 6.5), z: b.wz(0, 6.5) } });
    }
  }

  // ---- hamlet: gentle ground near a sheltered shore, ideally near the boathouse -------
  let hamlet: Site | undefined;
  {
    const boat = sites.find((s) => s.kind === "boathouse");
    const cands: Cand[] = [];
    for (const g of grid) {
      const c = ctx.coast[g.i];
      if (c < 35 || c > 190) continue;
      const hv = h[g.i];
      if (hv < 2.5 || hv > 40) continue;
      if (ctx.slope[g.i] > 0.25) continue;
      if (!farFrom(g.x, g.z, boat ? 60 : 100)) continue;
      const st = stats(ctx, g.x, g.z, 22);
      if (st.wet || st.max - st.min > 9 || st.min < 1.5) continue;
      let score = ctx.shelter[g.i] * 1.2 - (st.max - st.min) * 0.08 + rng.next() * 0.35;
      const wd = ctx.waterDist[g.i];
      if (wd > 25 && wd < 110) score += 0.35;
      if (boat) {
        const d = distTo(boat, g.x, g.z);
        score += d > 60 && d < 230 ? 0.6 : -0.3;
      }
      cands.push({ x: g.x, z: g.z, score });
    }
    const c = best(cands);
    if (c) {
      const hr = rng.fork("hamlet");
      const st = stats(ctx, c.x, c.z, 9);
      const Y0 = st.mean;
      flatten(ctx, c.x, c.z, 9, 7, Y0);
      const pb = new Builder(c.x, Y0, c.z, hr.range(0, 6.283185307179586));
      pb.cyl(0, -0.4, 0, 7, 0.45, Material.Stone, TINT.stone);
      // benches
      for (let k = 0; k < 2; k++) {
        const a = hr.range(0, 6.283185307179586);
        pb.box(sin(a) * 5.2, 0.1, cos(a) * 5.2, 0.9, 0.45, 0.25, Material.Stone, TINT.stoneDark, a);
      }
      const hamletId = addStructure(ctx, StructureKind.Hamlet, pb);
      const wb = new Builder(c.x, Y0 + 0.1, c.z, 0);
      well(wb, hr.range(-1.5, 1.5), hr.range(-1.5, 1.5));
      const wellId = addStructure(ctx, StructureKind.Well, wb);
      const ids = [hamletId, wellId];
      const spots: Spot[] = [{ x: c.x + 2.5, y: Y0 + 0.2, z: c.z, tag: "piazza" }];
      // 3–4 cottages around the piazza: try 10 slots, keep the ones on good ground
      const want = hr.intRange(3, 4);
      const base = hr.range(0, 6.283185307179586);
      const slots = 10;
      const placed: { x: number; z: number; r: number }[] = [];
      let tallDone = false;
      for (let k = 0; k < slots && placed.length < want; k++) {
        const a = base + (k * 3 % slots) / slots * 6.283185307179586 + hr.range(-0.2, 0.2);
        const dist = hr.range(13, 17);
        const px = c.x + sin(a) * dist, pz = c.z + cos(a) * dist;
        const w = hr.range(6, 7.6), d = hr.range(4.8, 5.8);
        const rr = Math.sqrt(w * w + d * d) / 2 + 0.6;
        if (placed.some((q) => (q.x - px) * (q.x - px) + (q.z - pz) * (q.z - pz) < (q.r + rr + 2.5) * (q.r + rr + 2.5))) continue;
        const cs = stats(ctx, px, pz, rr);
        if (cs.wet || cs.max - cs.min > 5 || cs.min < 1.2) continue;
        const Y = cs.mean;
        flatten(ctx, px, pz, rr, 4, Y);
        const rot = atan2(c.x - px, c.z - pz); // door (+Z) faces the piazza
        const b = new Builder(px, Y, pz, rot);
        const tall = !tallDone && hr.chance(0.6);
        if (tall) tallDone = true;
        spots.push(...cottage(b, hr.fork("c" + k), w, d, tall));
        ids.push(addStructure(ctx, StructureKind.Cottage, b));
        markDisc(ctx, px, pz, rr + 3, BLOCK_VILLAGE);
        placed.push({ x: px, z: pz, r: rr });
      }
      // low dry-stone garden walls between the houses
      const gw = new Builder(c.x, Y0, c.z, 0);
      for (let k = 0; k < placed.length; k++) {
        const p = placed[k], q = placed[(k + 1) % placed.length];
        if (placed.length < 2 || hr.chance(0.35)) continue;
        const mx = (p.x + q.x) / 2, mz = (p.z + q.z) / 2;
        const dx = mx - c.x, dz = mz - c.z;
        const dl = Math.sqrt(dx * dx + dz * dz) || 1;
        const ox = c.x + (dx / dl) * (dl + 4), oz = c.z + (dz / dl) * (dl + 4);
        const L = hr.range(4, 7);
        const ga = atan2(dx, dz);
        const gy = sample(ctx.height, ox, oz) - Y0;
        const st = stats(ctx, ox, oz, L / 2);
        if (st.wet || st.max - st.min > 1.5) continue;
        gw.box(ox - c.x, gy - 0.2, oz - c.z, L / 2, 1.1, 0.3, Material.Stone, TINT.stoneDark, ga);
      }
      if (gw.solids.length) ids.push(addStructure(ctx, StructureKind.Hamlet, gw));
      markDisc(ctx, c.x, c.z, 11, BLOCK_VILLAGE);
      hamlet = { kind: "hamlet", x: c.x, z: c.z, y: Y0, rot: 0, radius: 24, structureIds: ids, spots, door: { x: c.x, z: c.z } };
      sites.push(hamlet);
    }
  }

  // ---- chapel on a hilltop, overlooking the hamlet ------------------------------
  {
    const cands: Cand[] = [];
    for (const g of grid) {
      const hv = h[g.i];
      if (hv < 20 || hv > 115 || ctx.slope[g.i] > 0.3) continue;
      if (!farFrom(g.x, g.z, 110)) continue;
      const pr = prominence(g.x, g.z, 40);
      if (pr < 1.5) continue;
      const st = stats(ctx, g.x, g.z, 10);
      if (st.wet || st.max - st.min > 7) continue;
      let score = pr / 8 + rng.next() * 0.4 - (st.max - st.min) * 0.05;
      if (hamlet) {
        const d = distTo(hamlet, g.x, g.z);
        score += d > 110 && d < 330 ? 0.7 : 0;
      }
      cands.push({ x: g.x, z: g.z, score });
    }
    const c = best(cands);
    if (c) {
      const st = stats(ctx, c.x, c.z, 10);
      const Y = st.mean;
      flatten(ctx, c.x, c.z, 10, 8, Y);
      const rot = hamlet ? atan2(hamlet.x - c.x, hamlet.z - c.z) : toCenter(c.x, c.z) + Math.PI;
      const b = new Builder(c.x, Y, c.z, rot);
      const spots = chapel(b, rng.fork("chapel"));
      const ids = [addStructure(ctx, StructureKind.Chapel, b)];
      markDisc(ctx, c.x, c.z, 13, BLOCK_VILLAGE);
      sites.push({ kind: "chapel", x: c.x, z: c.z, y: Y, rot, radius: 14, structureIds: ids, spots, door: { x: b.wx(0, 10), z: b.wz(0, 10) } });
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
      const spots = watchtower(b, rng.fork("tower"));
      const ids = [addStructure(ctx, StructureKind.Watchtower, b)];
      sites.push({ kind: "watchtower", x: c.x, z: c.z, y: Y, rot, radius: 8, structureIds: ids, spots, door: { x: b.wx(0, 6), z: b.wz(0, 6) } });
    }
  }

  // ---- Vespa shed near the hamlet (or anywhere flat) -------------------------------
  {
    const anchor = hamlet ?? sites[0];
    const cands: Cand[] = [];
    for (const g of grid) {
      const hv = h[g.i];
      if (hv < 2 || ctx.slope[g.i] > 0.2) continue;
      const d = anchor ? distTo(anchor, g.x, g.z) : 100;
      if (anchor && (d < 42 || d > 120)) continue;
      if (!sites.every((s) => s === anchor || distTo(s, g.x, g.z) > 70)) continue;
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
      const spots = vespaShed(b, rng.fork("shed"));
      const ids = [addStructure(ctx, StructureKind.VespaShed, b)];
      sites.push({ kind: "shed", x: c.x, z: c.z, y: st.mean, rot, radius: 6, structureIds: ids, spots, door: { x: b.wx(0, 5), z: b.wz(0, 5) } });
    }
  }

  // ---- aqueduct / arch fragment in open country ---------------------------------------
  if (rng.chance(0.65)) {
    const cands: Cand[] = [];
    for (const g of grid) {
      const hv = h[g.i];
      if (hv < 6 || hv > 70 || ctx.slope[g.i] > 0.22 || ctx.coast[g.i] < 50) continue;
      if (!farFrom(g.x, g.z, 110)) continue;
      const st = stats(ctx, g.x, g.z, 11);
      if (st.wet || st.max - st.min > 5) continue;
      cands.push({ x: g.x, z: g.z, score: rng.next() - (st.max - st.min) * 0.1 });
    }
    const c = best(cands);
    if (c) {
      const i = toI(c.z) * N + toI(c.x);
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
  // ---- jetties at the heads of coves ---------------------------------------------
  for (const cv of ctx.coves) {
    // walk from the head pool inland to the shore
    let bx = 0, bz = 0, found = false;
    for (let t = 0; t < cv.wid * 2.5; t += 1) {
      const x = cv.x - cv.dx * t, z = cv.z - cv.dz * t;
      if (sample(h, x, z) > 0.35) { bx = x; bz = z; found = true; break; }
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
  void cos;
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
