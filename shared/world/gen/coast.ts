// Stage 1: island archetype, peaks/ridges skeleton, and the coastline.
// Produces ctx.land, ctx.coast (signed distance), ctx.cliff, ctx.shelter,
// plus detected bays, headlands and islets for later stages.
import { Noise, warp2, warpOut } from "../../math/noise";
import type { Rng } from "../../math/rng";
import { atan2, cos, sin, TAU } from "../../math/trig";
import { smax, smin, smoothstep } from "../../math/vec";
import type { ArchetypeKind, Ctx, Peak, Ridge } from "../context";
import { boxBlur, edt, gx, N, NN } from "../grid";
import { CELL } from "../types";

interface Blob {
  x: number;
  z: number;
  rx: number;
  rz: number;
  c: number;
  s: number;
}

function blob(x: number, z: number, rx: number, rz: number, rot: number): Blob {
  return { x, z, rx, rz, c: cos(rot), s: sin(rot) };
}

function ellipseE(b: Blob, x: number, z: number): number {
  const dx = x - b.x, dz = z - b.z;
  const lx = (dx * b.c + dz * b.s) / b.rx;
  const lz = (-dx * b.s + dz * b.c) / b.rz;
  return Math.sqrt(lx * lx + lz * lz);
}

interface Shape {
  blobs: Blob[];
  cuts: Blob[];
  noiseAmp: number;
  peaks: Peak[];
  ridges: Ridge[];
  cliffBias: number;
}

const ARCHETYPES: ArchetypeKind[] = ["volcano", "twinPeaks", "spine", "crescent", "archipelago", "horseshoe"];

function polar(cx: number, cz: number, a: number, r: number): { x: number; z: number } {
  return { x: cx + sin(a) * r, z: cz + cos(a) * r };
}

function buildShape(kind: ArchetypeKind, rng: Rng, cx: number, cz: number): Shape {
  const rot = rng.range(0, TAU);
  const blobs: Blob[] = [];
  const cuts: Blob[] = [];
  const peaks: Peak[] = [];
  const ridges: Ridge[] = [];
  let noiseAmp = rng.range(0.2, 0.3);
  let cliffBias = 0;
  const R = rng.range(378, 420);

  switch (kind) {
    case "volcano": {
      const elong = rng.range(0.68, 0.95);
      blobs.push(blob(cx, cz, R * rng.range(0.92, 1.02), R * elong, rot));
      const lobes = rng.intRange(1, 3);
      for (let i = 0; i < lobes; i++) {
        const a = rot + (i / lobes) * TAU + rng.range(-0.6, 0.6);
        const p = polar(cx, cz, a, R * rng.range(0.5, 0.7));
        blobs.push(blob(p.x, p.z, R * rng.range(0.32, 0.5), R * rng.range(0.25, 0.4), a));
      }
      const off = polar(cx, cz, rng.range(0, TAU), rng.range(10, 110));
      const cald = rng.chance(0.7);
      peaks.push({
        x: off.x, z: off.z, h: rng.range(150, 185), r: R * rng.range(0.72, 0.88), sharp: rng.range(0.7, 0.95),
        caldera: cald ? rng.range(32, 50) : undefined,
      });
      // parasitic cones / a second summit on the flank
      const nsec = rng.weighted([0, 1, 2], [0.2, 0.55, 0.25]);
      for (let k = 0; k < nsec; k++) {
        const p = polar(off.x, off.z, rng.range(0, TAU), R * rng.range(0.42, 0.62));
        peaks.push({ x: p.x, z: p.z, h: rng.range(55, 105), r: rng.range(85, 150), sharp: rng.range(0.4, 0.8) });
      }
      cliffBias = 0.15;
      break;
    }
    case "twinPeaks": {
      const a = polar(cx, cz, rot, R * 0.42);
      const b = polar(cx, cz, rot + Math.PI, R * 0.42);
      blobs.push(blob(a.x, a.z, R * rng.range(0.62, 0.72), R * rng.range(0.55, 0.65), rot + 0.3));
      blobs.push(blob(b.x, b.z, R * rng.range(0.58, 0.68), R * rng.range(0.52, 0.62), rot - 0.2));
      blobs.push(blob(cx, cz, R * 0.45, R * 0.35, rot + Math.PI / 2));
      const pa = polar(a.x, a.z, rng.range(0, TAU), rng.range(10, 50));
      const pb = polar(b.x, b.z, rng.range(0, TAU), rng.range(10, 50));
      const ha = rng.range(125, 175), hb = rng.range(90, 135);
      peaks.push({ x: pa.x, z: pa.z, h: ha, r: R * 0.58, sharp: rng.range(0.5, 0.9) });
      peaks.push({ x: pb.x, z: pb.z, h: hb, r: R * 0.52, sharp: rng.range(0.4, 0.8) });
      ridges.push({
        pts: [
          { x: pa.x, z: pa.z, h: ha * 0.6 },
          { x: cx + rng.range(-30, 30), z: cz + rng.range(-30, 30), h: rng.range(38, 58) },
          { x: pb.x, z: pb.z, h: hb * 0.6 },
        ],
        width: rng.range(120, 160),
      });
      // bays on either side of the saddle
      for (const side of [-1, 1]) {
        if (rng.chance(0.75)) {
          const p = polar(cx, cz, rot + side * Math.PI / 2, R * rng.range(0.62, 0.78));
          cuts.push(blob(p.x, p.z, rng.range(55, 95), rng.range(70, 110), rot));
        }
      }
      cliffBias = 0.05;
      break;
    }
    case "spine": {
      const rx = Math.min(R * 1.2, 430), rz = R * rng.range(0.58, 0.68);
      blobs.push(blob(cx, cz, rx, rz, rot));
      const side = polar(cx, cz, rot + Math.PI / 2 + rng.range(-0.4, 0.4), rx * 0.45);
      blobs.push(blob(side.x, side.z, rz * 0.9, rz * 0.8, rot));
      // ridge along local X axis (sin/cos of rot give the rotated axis)
      const n = 6;
      const pts: Ridge["pts"] = [];
      const bend = rng.range(-50, 50);
      const pk1 = rng.int(n - 2) + 1;
      let pk2 = rng.int(n - 2) + 1;
      if (pk2 === pk1) pk2 = pk1 < n - 2 ? pk1 + 1 : pk1 - 1;
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1) - 0.5;
        const lx = t * rx * 1.45;
        const lz = bend * (1 - 4 * t * t) + rng.range(-25, 25);
        // local (lx, lz) -> world with rotation rot (three.js convention)
        const x = cx + lx * cos(rot) + lz * sin(rot);
        const z = cz - lx * sin(rot) + lz * cos(rot);
        const edge = 1 - 2 * Math.abs(t);
        let h = 35 + 55 * edge + rng.range(-10, 10);
        if (i === pk1) h = rng.range(140, 180);
        else if (i === pk2) h = rng.range(95, 130);
        pts.push({ x, z, h });
      }
      ridges.push({ pts, width: rz * rng.range(0.85, 1.05) });
      for (const p of [pts[pk1], pts[pk2]]) peaks.push({ x: p.x, z: p.z, h: p.h, r: 150, sharp: 0.7 });
      // deep bays along the flanks
      const nb = rng.intRange(2, 3);
      for (let i = 0; i < nb; i++) {
        const t = rng.range(-0.35, 0.35);
        const side = rng.chance(0.5) ? 1 : -1;
        const lx = t * rx * 1.6, lz = side * rz * rng.range(0.85, 1.0);
        const x = cx + lx * cos(rot) + lz * sin(rot);
        const z = cz - lx * sin(rot) + lz * cos(rot);
        cuts.push(blob(x, z, rng.range(45, 75), rng.range(70, 110), rot + rng.range(-0.3, 0.3)));
      }
      cliffBias = 0.2;
      noiseAmp *= 0.85;
      break;
    }
    case "crescent": {
      const Rc = R * rng.range(0.62, 0.7);
      const span = rng.range(3.9, 4.6); // radians of arc
      const nb = 7;
      const arcPts: Ridge["pts"] = [];
      for (let i = 0; i < nb; i++) {
        const a = rot - span / 2 + (span * i) / (nb - 1);
        const p = polar(cx, cz, a, Rc);
        const w = 1 - Math.abs(i / (nb - 1) - 0.5) * 1.1;
        blobs.push(blob(p.x, p.z, R * (0.3 + 0.17 * w), R * (0.27 + 0.15 * w), a));
        arcPts.push({ x: p.x, z: p.z, h: 25 + 70 * w + rng.range(-10, 10) });
      }
      // lagoon: cut the middle; keep the open side toward rot + PI
      cuts.push(blob(cx, cz, Rc * rng.range(0.62, 0.72), Rc * rng.range(0.6, 0.7), rot));
      const pk = rng.intRange(2, 4);
      arcPts[pk].h = rng.range(130, 170);
      peaks.push({ x: arcPts[pk].x, z: arcPts[pk].z, h: arcPts[pk].h, r: 150, sharp: 0.75 });
      const pk2 = pk <= 3 ? pk + 2 : pk - 2;
      arcPts[pk2].h = rng.range(80, 115);
      peaks.push({ x: arcPts[pk2].x, z: arcPts[pk2].z, h: arcPts[pk2].h, r: 120, sharp: 0.6 });
      ridges.push({ pts: arcPts, width: R * 0.42 });
      noiseAmp *= 0.8;
      cliffBias = 0.1;
      break;
    }
    case "archipelago": {
      const mr = R * rng.range(0.8, 0.9);
      const mo = polar(cx, cz, rot, rng.range(20, 70));
      blobs.push(blob(mo.x, mo.z, mr, mr * rng.range(0.78, 0.92), rot + 0.5));
      const pk = polar(mo.x, mo.z, rng.range(0, TAU), rng.range(0, 60));
      peaks.push({ x: pk.x, z: pk.z, h: rng.range(130, 175), r: mr * 0.8, sharp: rng.range(0.6, 0.9) });
      const ns = rng.intRange(2, 3);
      const base = rot + Math.PI + rng.range(-0.4, 0.4);
      for (let i = 0; i < ns; i++) {
        const a = base + (i - (ns - 1) / 2) * rng.range(1.0, 1.3);
        const r = rng.range(70, 115);
        const p = polar(mo.x, mo.z, a, mr + r + rng.range(22, 55));
        // keep satellites in the world
        const lim = 440 - r;
        p.x = Math.max(-lim, Math.min(lim, p.x));
        p.z = Math.max(-lim, Math.min(lim, p.z));
        blobs.push(blob(p.x, p.z, r, r * rng.range(0.6, 0.9), a));
        peaks.push({ x: p.x, z: p.z, h: rng.range(35, 70), r: r * 0.95, sharp: 0.4 });
      }
      noiseAmp *= 0.9;
      cliffBias = 0.1;
      break;
    }
    case "horseshoe": {
      blobs.push(blob(cx, cz, R * rng.range(0.95, 1.05), R * rng.range(0.85, 0.95), rot));
      const bayDir = rng.range(0, TAU);
      const bp = polar(cx, cz, bayDir, R * rng.range(0.55, 0.65));
      cuts.push(blob(bp.x, bp.z, R * rng.range(0.3, 0.38), R * rng.range(0.5, 0.6), bayDir + Math.PI / 2));
      // mountains wrap around the bay
      const back = polar(cx, cz, bayDir + Math.PI, R * 0.35);
      const armL = polar(cx, cz, bayDir + 1.4, R * 0.55);
      const armR = polar(cx, cz, bayDir - 1.4, R * 0.55);
      const hb = rng.range(130, 180);
      ridges.push({
        pts: [
          { x: armL.x, z: armL.z, h: rng.range(55, 85) },
          { x: back.x, z: back.z, h: hb },
          { x: armR.x, z: armR.z, h: rng.range(60, 95) },
        ],
        width: R * 0.5,
      });
      peaks.push({ x: back.x, z: back.z, h: hb, r: R * 0.5, sharp: rng.range(0.6, 0.9) });
      cliffBias = 0.12;
      break;
    }
  }
  return { blobs, cuts, noiseAmp, peaks, ridges, cliffBias };
}

export function coastStage(ctx: Ctx, rng: Rng): void {
  const kind = rng.pick(ARCHETYPES);
  ctx.archetype = kind;
  const cx = rng.range(-35, 35), cz = rng.range(-35, 35);
  ctx.cx = cx;
  ctx.cz = cz;
  const shape = buildShape(kind, rng.fork("shape"), cx, cz);
  const ch = ctx.ch;
  for (const p of shape.peaks) p.h *= ch.relief;
  for (const r of shape.ridges) for (const p of r.pts) p.h *= ch.relief;
  shape.cliffBias += ch.cliffBias;

  // A few random offshore islets.
  const islets: { x: number; z: number; r: number }[] = [];
  const nIslets = rng.intRange(1, 3) + ch.islets;
  for (let i = 0; i < nIslets; i++) {
    const a = rng.range(0, TAU);
    const d = rng.range(390, 440);
    const r = rng.range(16, 34);
    const p = polar(cx, cz, a, d);
    if (Math.abs(p.x) < 430 - r && Math.abs(p.z) < 430 - r) {
      islets.push({ x: p.x, z: p.z, r });
      shape.blobs.push(blob(p.x, p.z, r, r * rng.range(0.6, 1), a));
    }
  }
  ctx.peaks = shape.peaks;
  ctx.ridges = shape.ridges;

  const noise = new Noise(rng.fork("coastNoise"));
  const detail = new Noise(rng.fork("coastDetail"));

  // Evaluate the mask on a 4 m grid, upsample bilinearly, add fine detail.
  const H = 257;
  const coarse = new Float32Array(H * H);
  const amp = shape.noiseAmp;
  for (let iz = 0; iz < H; iz++) {
    for (let ix = 0; ix < H; ix++) {
      const x = -512 + ix * 4, z = -512 + iz * 4;
      warp2(noise, x, z, 1 / 300, 55, 2);
      const wx = warpOut.x, wz = warpOut.y;
      let v = -10;
      for (const b of shape.blobs) v = smax(v, 1 - ellipseE(b, wx, wz), 0.12);
      for (const c of shape.cuts) v = smin(v, ellipseE(c, wx, wz) - 1, 0.1);
      v += amp * noise.fbm(wx / 240, wz / 240, 4, 2.1, 0.5);
      // mid-frequency coves and small headlands
      v += 0.07 * noise.fbm(wx / 70 + 11.3, wz / 70 - 4.1, 2);
      // keep open sea at the world edge
      const edge = (440 - Math.max(Math.abs(x), Math.abs(z))) / 120;
      v = smin(v, edge, 0.1);
      coarse[iz * H + ix] = v;
    }
  }
  // Coastline accents: a couple of peninsulas and narrow inlets at random
  // points of the coarse coastline.
  {
    const coastPts: number[] = [];
    for (let iz = 2; iz < H - 2; iz++)
      for (let ix = 2; ix < H - 2; ix++) {
        const i = iz * H + ix;
        if (coarse[i] > 0 && (coarse[i - 1] <= 0 || coarse[i + 1] <= 0 || coarse[i - H] <= 0 || coarse[i + H] <= 0)) coastPts.push(i);
      }
    const acc = rng.fork("accents");
    const nPen = acc.weighted([0, 1, 2], [0.3, 0.45, 0.25]);
    const nInl = acc.weighted([0, 1, 2, 3], [0.2, 0.35, 0.3, 0.15]);
    for (let k = 0; k < nPen + nInl && coastPts.length > 0; k++) {
      const pen = k < nPen;
      const ci = coastPts[acc.int(coastPts.length)];
      const px = -512 + (ci % H) * 4, pz = -512 + ((ci / H) | 0) * 4;
      // outward normal from the coarse gradient
      const gxv = coarse[ci + 1] - coarse[ci - 1], gzv = coarse[ci + H] - coarse[ci - H];
      const gl = Math.sqrt(gxv * gxv + gzv * gzv) || 1;
      const ox = -gxv / gl, oz = -gzv / gl;
      const len = pen ? acc.range(60, 120) : acc.range(45, 95);
      const wid = pen ? acc.range(22, 40) : acc.range(12, 24);
      const bend = acc.range(-0.5, 0.5);
      const bx = px + ox * (pen ? len * 0.45 : -len * 0.35), bz = pz + oz * (pen ? len * 0.45 : -len * 0.35);
      if (pen && (Math.abs(bx + ox * len * 0.6) > 430 || Math.abs(bz + oz * len * 0.6) > 430)) continue;
      const rot = atan2(ox, oz) + bend * 0.4;
      const cr = cos(rot), sr = sin(rot);
      const rad = Math.ceil((len + wid) / 4) + 2;
      const cx4 = ((bx + 512) / 4) | 0, cz4 = ((bz + 512) / 4) | 0;
      for (let dz = -rad; dz <= rad; dz++)
        for (let dx = -rad; dx <= rad; dx++) {
          const ix = cx4 + dx, iz = cz4 + dz;
          if (ix < 1 || iz < 1 || ix >= H - 1 || iz >= H - 1) continue;
          const x = -512 + ix * 4 - bx, z = -512 + iz * 4 - bz;
          // local frame: lz along the outward axis
          const lx = x * cr - z * sr, lz = x * sr + z * cr;
          const curve = lx - bend * (lz * lz) / len;
          const e = Math.sqrt((curve / wid) * (curve / wid) + (lz / (len * 0.6)) * (lz / (len * 0.6)));
          if (e >= 1) continue;
          const f = (1 - e * e) * 0.5;
          const i = iz * H + ix;
          coarse[i] = pen ? Math.max(coarse[i], coarse[i] * 0.3 + f) : Math.min(coarse[i], coarse[i] - f * 1.3);
        }
    }
  }

  // Normalise the land area into a playable range by shifting the threshold.
  {
    const areaAt = (d: number) => {
      let n = 0;
      for (let i = 0; i < H * H; i++) if (coarse[i] + d > 0) n++;
      return n * 16;
    };
    const A = areaAt(0);
    if (A < 340000 || A > 510000) {
      const target = A < 340000 ? 350000 : 500000;
      let lo = -0.25, hi = 0.25;
      for (let it = 0; it < 14; it++) {
        const mid = (lo + hi) / 2;
        if (areaAt(mid) < target) lo = mid;
        else hi = mid;
      }
      const d = (lo + hi) / 2;
      for (let i = 0; i < H * H; i++) coarse[i] += d;
    }
  }

  carveCoves(ctx, coarse, H, rng.fork("coves"));

  const land = ctx.land;
  const mask = new Float32Array(NN);
  for (let iz = 0; iz < N; iz++) {
    const cz4 = iz >> 1, tz = (iz & 1) * 0.5;
    for (let ix = 0; ix < N; ix++) {
      const cx4 = ix >> 1, tx = (ix & 1) * 0.5;
      const i4 = cz4 * H + cx4;
      const x1 = cx4 < H - 1 ? 1 : 0, z1 = cz4 < H - 1 ? H : 0;
      const a = coarse[i4] + (coarse[i4 + x1] - coarse[i4]) * tx;
      const b = coarse[i4 + z1] + (coarse[i4 + z1 + x1] - coarse[i4 + z1]) * tx;
      let v = a + (b - a) * tz;
      if (v > -0.08 && v < 0.08) v += 0.022 * detail.n2(gx(ix) / 18, gx(iz) / 18);
      mask[iz * N + ix] = v;
      land[iz * N + ix] = v > 0 ? 1 : 0;
    }
  }

  removeSpecks(land, 120);

  // Signed coast distance.
  const sea = new Uint8Array(NN);
  for (let i = 0; i < NN; i++) sea[i] = land[i] ? 0 : 1;
  const dl = edt(sea, N, N);
  const ds = edt(land, N, N);
  const coast = ctx.coast;
  for (let i = 0; i < NN; i++) coast[i] = land[i] ? dl[i] * CELL : -ds[i] * CELL;

  // Shelter: fraction of land within ~90 m.
  const lf = new Float32Array(NN);
  for (let i = 0; i < NN; i++) lf[i] = land[i];
  boxBlur(lf, N, N, 45, ctx.shelter);
  const near = new Float32Array(NN);
  boxBlur(lf, N, N, 14, near);

  // Cliffiness: noise + exposure + proximity of mountains.
  const cn = new Noise(rng.fork("cliffNoise"));
  const cliff = ctx.cliff;
  // Evaluate cliffiness on the coastline only, then give every cell the value
  // of its nearest coast cell (EDT nearest-feature) so cliff-top plateaus and
  // the deep water at their feet stay consistent away from the shore. Far from
  // the shore the value relaxes to a wide average to hide Voronoi seams.
  const src = new Float32Array(NN);
  const isCoast = new Uint8Array(NN);
  for (let iz = 1; iz < N - 1; iz++) {
    for (let ix = 1; ix < N - 1; ix++) {
      const i = iz * N + ix;
      if (!land[i]) continue;
      if (land[i - 1] && land[i + 1] && land[i - N] && land[i + N]) continue;
      const x = gx(ix), z = gx(iz);
      let m = 0;
      for (const p of shape.peaks) {
        const dx = x - p.x, dz = z - p.z;
        const t = Math.sqrt(dx * dx + dz * dz) / (p.r * 1.25);
        if (t < 1) m = Math.max(m, (1 - t) * (p.h / 160));
      }
      const exposure = 0.5 - ctx.shelter[i] + (0.5 - near[i]) * 0.6;
      const raw = cn.fbm(x / 230, z / 230, 3) * 0.9 + exposure * 1.1 + m * 0.6 + shape.cliffBias - 0.25;
      let cv = smoothstep(0.0, 0.28, raw);
      // coves: rock walls along the sides, a small beach at the head
      for (const cv0 of ctx.coves) {
        const rx = x - cv0.x, rz = z - cv0.z;
        const t = rx * cv0.dx + rz * cv0.dz, l = Math.abs(rx * cv0.dz - rz * cv0.dx);
        if (t < -cv0.wid * 1.5 || t > cv0.len * 1.1 || l > cv0.wid * 2.2) continue;
        if (t < cv0.wid * 1.2) cv = Math.min(cv, 0.08 * smoothstep(0, cv0.wid * 1.2, t));
        else cv = Math.max(cv, ch.coastStyle === "beaches" ? 0.45 : 0.9);
      }
      src[i] = cv;
      isCoast[i] = 1;
    }
  }
  const nearest = new Int32Array(NN);
  edt(isCoast, N, N, undefined, nearest);
  const prop = new Float32Array(NN);
  for (let i = 0; i < NN; i++) prop[i] = src[nearest[i]];
  const nearB = boxBlur(prop, N, N, 5);
  const farB = boxBlur(prop, N, N, 36);
  for (let i = 0; i < NN; i++) {
    const t = smoothstep(16, 90, Math.abs(coast[i]));
    cliff[i] = nearB[i] + (farB[i] - nearB[i]) * t;
  }

  detectCoastFeatures(ctx, islets);
}

/**
 * Narrow inlets (calanques) cut into the coarse coast mask, bottle-shaped:
 * a slightly wider pool at the head behind a narrower mouth. Recorded in
 * ctx.coves (head + outward axis) for cliff shaping, boats and names.
 */
function carveCoves(ctx: Ctx, coarse: Float32Array, H: number, rng: Rng): void {
  const want = ctx.ch.coves;
  if (want <= 0) return;
  const pts: number[] = [];
  for (let iz = 3; iz < H - 3; iz++)
    for (let ix = 3; ix < H - 3; ix++) {
      const i = iz * H + ix;
      if (coarse[i] > 0 && (coarse[i - 1] <= 0 || coarse[i + 1] <= 0 || coarse[i - H] <= 0 || coarse[i + H] <= 0)) pts.push(i);
    }
  const at = (x: number, z: number) => {
    const ix = Math.round((x + 512) / 4), iz = Math.round((z + 512) / 4);
    if (ix < 0 || iz < 0 || ix >= H || iz >= H) return -1;
    return coarse[iz * H + ix];
  };
  for (let tries = 0; tries < 120 && ctx.coves.length < want && pts.length; tries++) {
    const ci = pts[rng.int(pts.length)];
    const ix0 = ci % H, iz0 = (ci / H) | 0;
    const px = -512 + ix0 * 4, pz = -512 + iz0 * 4;
    // outward normal from a wide gradient (smooth over coastline wiggles)
    const gxv = coarse[ci + 2] - coarse[ci - 2], gzv = coarse[ci + 2 * H] - coarse[ci - 2 * H];
    const gl = Math.sqrt(gxv * gxv + gzv * gzv);
    if (gl < 1e-4) continue;
    const ox = -gxv / gl, oz = -gzv / gl;
    const len = rng.range(55, 105), wid = rng.range(11, 19);
    // needs solid land around the head and on both flanks, and open sea outside
    const hx = px - ox * len, hz = pz - oz * len;
    if (at(hx - ox * 40, hz - oz * 40) < 0.12 || at(px + ox * 30, pz + oz * 30) > -0.02) continue;
    const mx = px - ox * len * 0.5, mz = pz - oz * len * 0.5;
    if (at(mx - oz * (wid + 34), mz + ox * (wid + 34)) < 0.05 || at(mx + oz * (wid + 34), mz - ox * (wid + 34)) < 0.05) continue;
    if (ctx.coves.some((c) => (c.x - hx) * (c.x - hx) + (c.z - hz) * (c.z - hz) < 130 * 130)) continue;
    if (Math.abs(hx) > 420 || Math.abs(hz) > 420) continue;
    const bend = rng.range(-0.35, 0.35);
    // carve: along-axis t from the head (0) to past the mouth (len + 20)
    const r4 = Math.ceil((len + wid * 3 + 30) / 4);
    const cx4 = Math.round((hx + 512) / 4), cz4 = Math.round((hz + 512) / 4);
    for (let dz = -r4; dz <= r4; dz++)
      for (let dx = -r4; dx <= r4; dx++) {
        const jx = cx4 + dx, jz = cz4 + dz;
        if (jx < 1 || jz < 1 || jx >= H - 1 || jz >= H - 1) continue;
        const rx = -512 + jx * 4 - hx, rz = -512 + jz * 4 - hz;
        const t = rx * ox + rz * oz;
        if (t < -wid * 2 || t > len + 30) continue;
        const tt = Math.max(0, Math.min(1, t / len));
        const lat = (rx * oz - rz * ox) - bend * len * tt * (1 - tt) * 2;
        // half width: round pool at the head, pinched middle, flaring mouth
        const hw = wid * (1.25 - 0.45 * sin(Math.PI * Math.min(1, tt * 1.3)) + 0.5 * tt * tt);
        const e = t < 0 ? Math.sqrt((t / (wid * 1.2)) * (t / (wid * 1.2)) + (lat / hw) * (lat / hw)) : Math.abs(lat) / hw;
        const k = jz * H + jx;
        const v = (e - 0.85) * 0.55;
        if (v < coarse[k]) coarse[k] = v;
      }
    ctx.coves.push({ x: hx, z: hz, dx: ox, dz: oz, len, wid });
  }
}

/** Remove land components smaller than minCells, and fill tiny enclosed ponds of sea. */
function removeSpecks(land: Uint8Array, minCells: number): void {
  const label = new Int32Array(NN).fill(-1);
  const stack = new Int32Array(NN);
  const comp: number[] = [];
  for (let s = 0; s < NN; s++) {
    if (label[s] !== -1) continue;
    const val = land[s];
    let sp = 0;
    stack[sp++] = s;
    label[s] = s;
    comp.length = 0;
    let touchesEdge = false;
    while (sp > 0) {
      const i = stack[--sp];
      comp.push(i);
      const ix = i % N, iz = (i / N) | 0;
      if (ix === 0 || iz === 0 || ix === N - 1 || iz === N - 1) touchesEdge = true;
      if (ix > 0 && label[i - 1] === -1 && land[i - 1] === val) { label[i - 1] = s; stack[sp++] = i - 1; }
      if (ix < N - 1 && label[i + 1] === -1 && land[i + 1] === val) { label[i + 1] = s; stack[sp++] = i + 1; }
      if (iz > 0 && label[i - N] === -1 && land[i - N] === val) { label[i - N] = s; stack[sp++] = i - N; }
      if (iz < N - 1 && label[i + N] === -1 && land[i + N] === val) { label[i + N] = s; stack[sp++] = i + N; }
    }
    if (val === 1 && comp.length < minCells) for (const i of comp) land[i] = 0;
    else if (val === 0 && !touchesEdge && comp.length < 60) for (const i of comp) land[i] = 1;
  }
}

function detectCoastFeatures(ctx: Ctx, islets: { x: number; z: number; r: number }[]): void {
  const { coast, shelter } = ctx;
  // Bays: connected sea regions with high shelter, near the coast.
  const S = 4; // sample every 4 cells (8 m)
  const W = Math.ceil(N / S);
  const flag = new Uint8Array(W * W);
  for (let jz = 0; jz < W; jz++)
    for (let jx = 0; jx < W; jx++) {
      const i = jz * S * N + jx * S;
      if (coast[i] < -1 && coast[i] > -160 && shelter[i] > 0.52) flag[jz * W + jx] = 1;
    }
  const seen = new Uint8Array(W * W);
  const bays: Ctx["bays"] = [];
  for (let s = 0; s < W * W; s++) {
    if (!flag[s] || seen[s]) continue;
    const q = [s];
    seen[s] = 1;
    let sx = 0, sz = 0, n = 0, minSh = 2, mx = 0, mz = 0;
    while (q.length) {
      const c = q.pop()!;
      const jx = c % W, jz = (c / W) | 0;
      const x = gx(jx * S), z = gx(jz * S);
      sx += x;
      sz += z;
      n++;
      const sh = shelter[jz * S * N + jx * S];
      if (sh < minSh) {
        minSh = sh;
        mx = x;
        mz = z;
      }
      for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = jx + ox, nz = jz + oz;
        if (nx < 0 || nz < 0 || nx >= W || nz >= W) continue;
        const k = nz * W + nx;
        if (flag[k] && !seen[k]) {
          seen[k] = 1;
          q.push(k);
        }
      }
    }
    if (n >= 20) bays.push({ x: sx / n, z: sz / n, size: n * 64, mouthX: mx, mouthZ: mz });
  }
  bays.sort((a, b) => b.size - a.size);
  ctx.bays = bays.slice(0, 5);

  // Headlands: coastal land with low shelter; greedy pick with spacing.
  const cand: { x: number; z: number; score: number }[] = [];
  for (let iz = 2; iz < N - 2; iz += 3)
    for (let ix = 2; ix < N - 2; ix += 3) {
      const i = iz * N + ix;
      if (coast[i] > 6 && coast[i] < 40 && shelter[i] < 0.42) cand.push({ x: gx(ix), z: gx(iz), score: 0.42 - shelter[i] + coast[i] * 0.001 });
    }
  cand.sort((a, b) => b.score - a.score || a.x - b.x || a.z - b.z);
  const heads: typeof cand = [];
  for (const c of cand) {
    if (heads.length >= 6) break;
    let ok = true;
    for (const h of heads) if ((h.x - c.x) * (h.x - c.x) + (h.z - c.z) * (h.z - c.z) < 150 * 150) ok = false;
    if (ok) heads.push(c);
  }
  ctx.headlands = heads;
  ctx.islets = islets.filter((p) => ctx.land[(Math.round((p.z + 512) / CELL)) * N + Math.round((p.x + 512) / CELL)] === 1);
}

/**
 * Coves get clear, boat-deep water: the seabed drops ~0.45 m per metre from
 * the shore down to ~4.5 m, leaving a gently shelving beach at the head.
 */
export function coveBeds(ctx: Ctx): void {
  const h = ctx.height;
  for (const cv of ctx.coves) {
    const R = cv.len + cv.wid * 3 + 30;
    const i0 = Math.max(1, Math.floor((cv.x - R + 512) / CELL)), i1 = Math.min(N - 2, Math.ceil((cv.x + R + 512) / CELL));
    const j0 = Math.max(1, Math.floor((cv.z - R + 512) / CELL)), j1 = Math.min(N - 2, Math.ceil((cv.z + R + 512) / CELL));
    for (let iz = j0; iz <= j1; iz++)
      for (let ix = i0; ix <= i1; ix++) {
        const i = iz * N + ix;
        if (ctx.land[i]) continue; // cove water per the coast mask, even where erosion silted it up
        const rx = gx(ix) - cv.x, rz = gx(iz) - cv.z;
        const t = rx * cv.dx + rz * cv.dz;
        if (t < -cv.wid * 1.6 || t > cv.len + 25) continue;
        if (Math.abs(rx * cv.dz - rz * cv.dx) > cv.wid * 2.6) continue;
        const d = -ctx.coast[i];
        const want = -Math.min(4.5, 0.3 + d * 0.45);
        if (want < h[i]) h[i] = want;
      }
  }
}

/** A few sea stacks (faraglioni) off the cliffy coasts. */
export function seaStacks(ctx: Ctx, rng: Rng): void {
  const h = ctx.height;
  const cands: number[] = [];
  for (let iz = 4; iz < N - 4; iz += 3)
    for (let ix = 4; ix < N - 4; ix += 3) {
      const i = iz * N + ix;
      const c = ctx.coast[i];
      if (c > -48 && c < -14 && ctx.cliff[i] > 0.45 && h[i] < -2.5) cands.push(i);
    }
  if (!cands.length) return;
  rng.shuffle(cands);
  const want = rng.intRange(2, 6);
  const noise = new Noise(rng.fork("n"));
  for (const i of cands) {
    if (ctx.stacks.length >= want) break;
    const x = gx(i % N), z = gx((i / N) | 0);
    if (ctx.stacks.some((s) => (s.x - x) * (s.x - x) + (s.z - z) * (s.z - z) < 30 * 30)) continue;
    // cluster: stacks like to come in groups, but keep some spread
    if (ctx.stacks.length > 0 && !ctx.stacks.some((s) => (s.x - x) * (s.x - x) + (s.z - z) * (s.z - z) < 140 * 140) && rng.chance(0.6)) continue;
    const r = rng.range(4.5, 9);
    const top = rng.range(9, 24);
    const R = r * 1.5;
    const ci = i % N, cj = (i / N) | 0;
    const ri = Math.ceil(R / CELL) + 1;
    for (let dz = -ri; dz <= ri; dz++)
      for (let dx = -ri; dx <= ri; dx++) {
        const ix = ci + dx, iz = cj + dz;
        if (ix < 0 || iz < 0 || ix >= N || iz >= N) continue;
        const px = gx(ix), pz = gx(iz);
        const wob = 1 + 0.18 * noise.n2(px / 6, pz / 6);
        const d = Math.sqrt((px - x) * (px - x) + (pz - z) * (pz - z)) / (r * wob);
        let v: number;
        if (d < 1) v = top * (1 - d * d * d * d) + 0.8 * noise.n2(px / 3, pz / 3);
        else if (d < 1.5) v = -1.2 - (d - 1) * 2;
        else continue;
        const j = iz * N + ix;
        if (v > h[j]) h[j] = v;
      }
    ctx.stacks.push({ x, z, r, h: top });
  }
}
