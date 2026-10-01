// Stage 4: hydrology. Priority-flood depression filling → lakes; flow
// accumulation → rivers traced from the sea upstream; channels carved with
// banks; waterfalls where the river surface drops steeply; water + flow grids.
import { Noise } from "../../math/noise";
import type { Rng } from "../../math/rng";
import { atan2 } from "../../math/trig";
import { smoothstep } from "../../math/vec";
import type { Ctx } from "../context";
import { D8X, D8Z, edt, gx, Heap, N, NN, sample, slopeAt, toG } from "../grid";
import { CELL, NO_WATER, type River, type RiverPoint } from "../types";
import { floodOrder, SHORE_FLOOR } from "./erosion";

interface Pt {
  x: number;
  z: number;
}

function chaikin(pts: Pt[], iters: number): Pt[] {
  let p = pts;
  for (let it = 0; it < iters; it++) {
    if (p.length < 3) return p;
    const q: Pt[] = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i], b = p[i + 1];
      q.push({ x: a.x * 0.75 + b.x * 0.25, z: a.z * 0.75 + b.z * 0.25 });
      q.push({ x: a.x * 0.25 + b.x * 0.75, z: a.z * 0.25 + b.z * 0.75 });
    }
    q.push(p[p.length - 1]);
    p = q;
  }
  return p;
}

function resample(pts: Pt[], step: number): Pt[] {
  const out: Pt[] = [pts[0]];
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
  const last = pts[pts.length - 1];
  const lo = out[out.length - 1];
  if ((lo.x - last.x) * (lo.x - last.x) + (lo.z - last.z) * (lo.z - last.z) > step * step * 0.25) out.push(last);
  return out;
}

interface RiverRun {
  cells: number[];
  startLevel: number; // NaN when it starts at a spring
  endLevel: number; // floor level at the end (sea 0, lake level, or junction surface)
  toSea: boolean;
}

/** Enclosed sub-sea-level pockets smaller than this (cells), or shallow, are filled in; others are lagoons. */
const MAX_PIT = 100;

/**
 * Small hollows below sea level that aren't connected to the open sea (beach
 * dips, erosion pits on a valley floor) acted as river outlets: rivers ended
 * in them 10–50 m short of the shore, leaving a strip of dry beach between the
 * stream and the sea. Raise them to dry ground so the drainage carries on to
 * the real coast. Large, deep enclosed sea-level lagoons are kept.
 * (Also: shallow sub-sea-level flats left by erosion are dry ground too.)
 */
function fillSeaPits(h: Float32Array): void {
  const label = new Uint8Array(NN); // 1 open sea, 2 enclosed
  const stack = new Int32Array(NN);
  let sp = 0;
  const seed = (i: number) => {
    if (!label[i] && h[i] <= 0) {
      label[i] = 1;
      stack[sp++] = i;
    }
  };
  for (let k = 0; k < N; k++) {
    seed(k);
    seed((N - 1) * N + k);
    seed(k * N);
    seed(k * N + N - 1);
  }
  // 4-connected: a pocket touching the sea only at a corner is still cut off by dry ground
  const flood = (mark: number, comp: number[] | null) => {
    while (sp > 0) {
      const i = stack[--sp];
      if (comp) comp.push(i);
      const ix = i % N;
      if (ix > 0 && !label[i - 1] && h[i - 1] <= 0) { label[i - 1] = mark; stack[sp++] = i - 1; }
      if (ix < N - 1 && !label[i + 1] && h[i + 1] <= 0) { label[i + 1] = mark; stack[sp++] = i + 1; }
      if (i >= N && !label[i - N] && h[i - N] <= 0) { label[i - N] = mark; stack[sp++] = i - N; }
      if (i < NN - N && !label[i + N] && h[i + N] <= 0) { label[i + N] = mark; stack[sp++] = i + N; }
    }
  };
  flood(1, null);
  const comp: number[] = [];
  for (let s = 0; s < NN; s++) {
    if (label[s] || h[s] > 0) continue;
    label[s] = 2;
    stack[sp++] = s;
    comp.length = 0;
    flood(2, comp);
    // droplet erosion bottoms out at exactly 0, leaving flat "sea" floors on
    // valley bottoms; a real lagoon is big and has some depth
    let lo = 0;
    for (const i of comp) if (h[i] < lo) lo = h[i];
    if (comp.length < MAX_PIT || lo > -0.6) for (const i of comp) h[i] = SHORE_FLOOR;
  }
}

export function hydrologyStage(ctx: Ctx, rng: Rng): void {
  const h = ctx.height;
  fillSeaPits(h);
  const order = new Int32Array(NN);
  const rcv = new Int32Array(NN);
  const filled = new Float32Array(NN);
  const heap = new Heap(1 << 16);
  let count = floodOrder(h, N, order, rcv, heap, (i) => h[i] <= 0, filled, 1e-5);
  const area = ctx.accum;
  const accumulate = () => {
    for (let i = 0; i < NN; i++) area[i] = h[i] > 0 ? CELL * CELL : 0;
    for (let k = count - 1; k >= 0; k--) {
      const i = order[k];
      const r = rcv[i];
      if (r >= 0) area[r] += area[i];
    }
  };
  accumulate();

  // Without a caldera lake, usually dam a valley on the largest river into a
  // lake (a landslide / moraine dam): basin carved below the target level and
  // a mound across the valley downstream, so the river spills over it.
  const hasCaldera = ctx.peaks.some((p) => p.caldera);
  if (!hasCaldera && rng.chance(0.75)) {
    // the biggest rivers first: the largest may have no gentle, inland stretch to dam
    const mouths: number[] = [];
    for (let i = 0; i < NN; i++) {
      const r = rcv[i];
      if (r >= 0 && h[i] > 0 && h[r] <= 0 && area[i] >= 2500) mouths.push(i);
    }
    mouths.sort((a, b) => area[b] - area[a] || a - b);
    const r = rng.range(24, 36);
    const kd = Math.round((r * 0.9) / CELL);
    let pick = -1;
    let path: number[] = [];
    for (let m = 0; m < mouths.length && m < 4 && pick < 0; m++) {
      // path upstream along the biggest tributary (mouth first)
      path = [];
      for (let cur = mouths[m], guard = 0; cur >= 0 && guard < 3000; guard++) {
        path.push(cur);
        let nb = -1, na = 0;
        const cx = cur % N, cz = (cur / N) | 0;
        for (let dz = -1; dz <= 1; dz++)
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dz) continue;
            const x = cx + dx, z = cz + dz;
            if (x < 0 || z < 0 || x >= N || z >= N) continue;
            const j = z * N + x;
            if (rcv[j] === cur && area[j] > na) {
              na = area[j];
              nb = j;
            }
          }
        if (na < 2500) break;
        cur = nb;
      }
      let pickS = 1e9;
      for (let k = kd + 2; k < path.length - 10; k++) {
        const i = path[k];
        const hv = h[i];
        if (hv < 6 || hv > 90 || ctx.coast[i] < 45) continue;
        const sl = slopeAt(h, i % N, (i / N) | 0) + slopeAt(h, path[k - kd] % N, (path[k - kd] / N) | 0) * 0.5 + (hv < 14 ? 0.3 : 0);
        if (sl < pickS) {
          pickS = sl;
          pick = k;
        }
      }
    }
    if (pick >= 0) {
      const P = path[pick], D = path[pick - kd];
      const px = gx(P % N), pz = gx((P / N) | 0), dx0 = gx(D % N), dz0 = gx((D / N) | 0);
      let ux = px - dx0, uz = pz - dz0;
      const ul = Math.sqrt(ux * ux + uz * uz) || 1;
      ux /= ul;
      uz /= ul;
      const L = h[P] + rng.range(3, 5);
      const lakeNoise = new Noise(rng.fork("lakeShape"));
      const depth = rng.range(3.5, 6);
      const R = r * 2.0;
      const ri = Math.ceil(R / CELL) + 2;
      const ci = P % N, cj = (P / N) | 0;
      for (let dz = -ri; dz <= ri; dz++)
        for (let dx = -ri; dx <= ri; dx++) {
          const ix = ci + dx, iz = cj + dz;
          if (ix < 0 || iz < 0 || ix >= N || iz >= N) continue;
          const i = iz * N + ix;
          const x = gx(ix), z = gx(iz);
          // elongated along the valley, with a wobbly shore
          const la = (x - px) * ux + (z - pz) * uz, lc = -(x - px) * uz + (z - pz) * ux;
          const wob = 1 + 0.2 * lakeNoise.n2(x / 22, z / 22);
          const d = Math.sqrt((la / 1.35) * (la / 1.35) + (lc / 0.8) * (lc / 0.8)) / (r * wob);
          if (d < 1) {
            const v = L - depth * (1 - d * d);
            if (v < h[i]) h[i] = v;
          } else if (d < 1.45) {
            // low natural berm so the hollow holds water on open ground
            const t = (d - 1) / 0.45;
            const v = L + 0.9 - t * t * 2.5;
            if (v > h[i]) h[i] = v;
          }
          // dam across the valley at D
          const along = (x - dx0) * ux + (z - dz0) * uz, across = -(x - dx0) * uz + (z - dz0) * ux;
          if (along > -8 && along < 8 && across > -R && across < R) {
            const crest = L + 1.3 - (along / 8) * (along / 8) * 4;
            const fade = 1 - smoothstep(R * 0.75, R, across < 0 ? -across : across);
            const v = h[i] + (crest - h[i]) * fade;
            if (v > h[i]) h[i] = v;
          }
        }
      count = floodOrder(h, N, order, rcv, heap, (i) => h[i] <= 0, filled, 1e-5);
      accumulate();
    }
  }

  // ---- lakes -------------------------------------------------------------
  const lakeOf = new Int32Array(NN).fill(-1);
  const seen = new Uint8Array(NN);
  const stack = new Int32Array(NN);
  const comp: number[] = [];
  for (let s = 0; s < NN; s++) {
    if (seen[s] || !(filled[s] - h[s] > 0.05) || h[s] <= 0) continue;
    let sp = 0;
    stack[sp++] = s;
    seen[s] = 1;
    comp.length = 0;
    let minF = 1e9, minH = 1e9, deep = s;
    while (sp > 0) {
      const i = stack[--sp];
      comp.push(i);
      if (filled[i] < minF) minF = filled[i];
      if (h[i] < minH) {
        minH = h[i];
        deep = i;
      }
      const ix = i % N, iz = (i / N) | 0;
      const l = ix > 0, r = ix < N - 1, u = iz > 0, d = iz < N - 1;
      const nb = [l ? i - 1 : -1, r ? i + 1 : -1, u ? i - N : -1, d ? i + N : -1,
        l && u ? i - N - 1 : -1, r && u ? i - N + 1 : -1, l && d ? i + N - 1 : -1, r && d ? i + N + 1 : -1];
      for (const j of nb) {
        if (j < 0 || seen[j] || h[j] <= 0) continue;
        if (filled[j] - h[j] > 0.05) {
          seen[j] = 1;
          stack[sp++] = j;
        }
      }
    }
    // the spill level is the lowest filled level on the rim; use the min filled
    const level = minF;
    const depth = level - minH;
    if (comp.length >= 60 && depth >= 1.2) {
      const id = ctx.lakes.length;
      const cells: number[] = [];
      for (const i of comp) if (h[i] < level) {
        lakeOf[i] = id;
        ctx.water[i] = level;
        cells.push(i);
      }
      ctx.lakes.push({ level, x: gx(deep % N), z: gx((deep / N) | 0) });
      ctx.lakeCells.push(Int32Array.from(cells));
    }
  }

  const head = new Int32Array(NN).fill(-1);
  const next = new Int32Array(NN).fill(-1);
  for (let i = 0; i < NN; i++) {
    const r = rcv[i];
    if (r >= 0) {
      next[i] = head[r];
      head[r] = i;
    }
  }
  const traceUp = (start: number, minArea: number, avoid?: (i: number) => boolean): number[] => {
    const path = [start];
    let cur = start;
    for (let guard = 0; guard < 4000; guard++) {
      let best = -1, ba = 0;
      for (let c = head[cur]; c >= 0; c = next[c]) {
        if (avoid && avoid(c)) continue;
        if (area[c] > ba || (area[c] === ba && c < best)) {
          ba = area[c];
          best = c;
        }
      }
      if (best < 0 || ba < minArea) break;
      path.push(best);
      cur = best;
    }
    return path.reverse();
  };

  // ---- choose river mouths -----------------------------------------------
  const want = rng.intRange(2, 4);
  const chosen: number[][] = [];
  for (const [minMouth, minLen, minSrc] of [[6000, 70, 18], [2500, 40, 10], [1200, 30, 6]]) {
    if (chosen.length > 0) break;
    const mouths: number[] = [];
    for (let i = 0; i < NN; i++) {
      const r = rcv[i];
      if (r >= 0 && h[i] > 0 && h[r] <= 0 && area[i] >= minMouth) mouths.push(i);
    }
    mouths.sort((a, b) => area[b] - area[a] || a - b);
    for (const m of mouths) {
      if (chosen.length >= want) break;
      const mx = gx(m % N), mz = gx((m / N) | 0);
      let ok = true;
      for (const c of chosen) {
        const e = c[c.length - 1];
        const dx = gx(e % N) - mx, dz = gx((e / N) | 0) - mz;
        if (dx * dx + dz * dz < 150 * 150) ok = false;
      }
      if (!ok) continue;
      const path = traceUp(m, Math.min(900, minMouth / 3));
      if (path.length < minLen) continue;
      if (h[path[0]] < minSrc) continue;
      chosen.push(path);
    }
  }

  // Split each main path at lakes into runs; add one tributary to the largest river.
  const runs: RiverRun[] = [];
  const splitRuns = (path: number[], endLevel: number, toSea: boolean) => {
    let cur: number[] = [];
    let startLevel = NaN;
    for (let k = 0; k < path.length; k++) {
      const i = path[k];
      const lk = lakeOf[i];
      if (lk >= 0) {
        if (cur.length >= 20) runs.push({ cells: cur.concat([i]), startLevel, endLevel: ctx.lakes[lk].level, toSea: false });
        cur = [];
        startLevel = ctx.lakes[lk].level;
      } else cur.push(i);
    }
    if (cur.length >= 20) runs.push({ cells: cur, startLevel, endLevel, toSea });
  };
  for (const p of chosen) splitRuns(p, 0, true);

  // ---- build profiles, carve, fill water ------------------------------------
  const rd = new Float32Array(NN).fill(1e9);
  const rs = new Float32Array(NN);
  const rw = new Float32Array(NN);
  const rdp = new Float32Array(NN);
  const rfx = new Float32Array(NN);
  const rfz = new Float32Array(NN);
  const onRiver = new Uint8Array(NN);

  interface Prof {
    pts: Pt[];
    s: number[];
    w: number[];
    d: number[];
    sp: number[];
  }
  const profiles: Prof[] = [];

  /**
   * Cells from a river mouth out into open water: starts at the mouth's
   * receiver (the first sea cell) and heads offshore (down the coast distance,
   * i.e. along a cove's axis inside a cove) until the water is > 1.2 m deep,
   * so the carved channel and the river ribbon always run into the sea.
   */
  const seaTail = (mouth: number): number[] => {
    const out: number[] = [];
    let cur = rcv[mouth];
    let px = mouth % N, pz = (mouth / N) | 0;
    let walked = 0;
    for (let guard = 0; guard < 24 && cur >= 0; guard++) {
      out.push(cur);
      const cx = cur % N, cz = (cur / N) | 0;
      const dx0 = cx - px, dz0 = cz - pz;
      walked += dx0 !== 0 && dz0 !== 0 ? CELL * 1.4142135623730951 : CELL;
      if ((walked >= 14 && h[cur] < -1.2) || walked >= 40) break;
      let best = -1, bs = 1e9;
      for (let d = 0; d < 8; d++) {
        const nx = cx + D8X[d], nz = cz + D8Z[d];
        if (nx < 1 || nz < 1 || nx >= N - 1 || nz >= N - 1) continue;
        if (D8X[d] * dx0 + D8Z[d] * dz0 < 0) continue; // no doubling back
        const j = nz * N + nx;
        if (h[j] > 0) continue;
        const sc = ctx.coast[j] + h[j] * 0.5;
        if (sc < bs) {
          bs = sc;
          best = j;
        }
      }
      px = cx;
      pz = cz;
      cur = best;
    }
    return out;
  };

  const buildProfile = (run: RiverRun): Prof | null => {
    const cells = run.toSea ? run.cells.concat(seaTail(run.cells[run.cells.length - 1])) : run.cells;
    let pts: Pt[] = cells.map((i) => ({ x: gx(i % N), z: gx((i / N) | 0) }));
    pts = resample(chaikin(pts, 3), 2);
    if (pts.length < 10) return null;
    const n = pts.length;
    const s: number[] = new Array(n), w: number[] = new Array(n), d: number[] = new Array(n), sp: number[] = new Array(n);
    // where the river meets the sea (first point over open water)
    let shore = n - 1;
    if (run.toSea) for (let k = 0; k < n; k++) if (sample(h, pts[k].x, pts[k].z) <= 0) { shore = k; break; }
    // catchment only grows downstream (smoothed points can sample a cell off
    // the flow line, and sea cells past the mouth have none): running max
    let aRun = 0;
    for (let k = 0; k < n; k++) {
      const p = pts[k];
      const ci = Math.round(toG(p.z)) * N + Math.round(toG(p.x));
      if (area[ci] > aRun) aRun = area[ci];
      const a = aRun;
      const toEnd = (shore > k ? shore - k : 0) * 2;
      const boost = run.toSea ? smoothstep(110, 10, toEnd) : 0;
      let width = 2.6 + 1.7 * Math.sqrt(a / 10000);
      if (width > 8.5) width = 8.5;
      if (width < 3) width = 3;
      width *= 1 + 0.65 * boost;
      w[k] = width;
      d[k] = 0.7 + 0.1 * width + 1.1 * boost;
    }
    // surface: monotone non-increasing, below the lowest bank sample
    const floor = run.endLevel;
    for (let k = 0; k < n; k++) {
      const p = pts[k];
      const q = pts[k < n - 1 ? k + 1 : k], o = pts[k > 0 ? k - 1 : k];
      let tx = q.x - o.x, tz = q.z - o.z;
      const tl = Math.sqrt(tx * tx + tz * tz) || 1;
      tx /= tl;
      tz /= tl;
      const hw = w[k] * 0.5;
      let tmin = sample(h, p.x, p.z);
      const l = sample(h, p.x - tz * hw, p.z + tx * hw), r = sample(h, p.x + tz * hw, p.z - tx * hw);
      if (l < tmin) tmin = l;
      if (r < tmin) tmin = r;
      let v = tmin - 0.45;
      if (k === 0 && !Number.isNaN(run.startLevel)) v = run.startLevel;
      if (k > 0 && v > s[k - 1]) v = s[k - 1];
      if (v < floor) v = floor;
      s[k] = v;
    }
    // runs that end in a lake or another river finish exactly at its surface
    if (!run.toSea) s[n - 1] = floor;
    // past the shoreline the river is the sea
    else for (let k = shore; k < n; k++) s[k] = 0;
    for (let k = 0; k < n; k++) {
      const a = s[k > 1 ? k - 2 : 0], b = s[k < n - 2 ? k + 2 : n - 1];
      const g = (a - b) / 8;
      let v = 0.45 + g * 22;
      if (v > 2.6) v = 2.6;
      sp[k] = v * (1 - 0.6 * (run.toSea ? smoothstep(60, 0, (shore > k ? shore - k : 0) * 2) : 0));
    }
    return { pts, s, w, d, sp };
  };

  for (const run of runs) {
    const pr = buildProfile(run);
    if (pr) profiles.push(pr);
  }

  // tributary for the first (largest) river
  if (chosen.length > 0 && profiles.length > 0) {
    const main = chosen[0];
    const onMain = new Set(main);
    let bestJ = -1, bestA = 0, bestC = -1;
    for (let k = 20; k < main.length - 40; k++) {
      const c = main[k];
      for (let ch = head[c]; ch >= 0; ch = next[ch]) {
        if (onMain.has(ch) || lakeOf[ch] >= 0) continue;
        if (area[ch] > bestA) {
          bestA = area[ch];
          bestJ = c;
          bestC = ch;
        }
      }
    }
    if (bestC >= 0 && bestA >= 5000) {
      const tp = traceUp(bestC, 900);
      if (tp.length >= 50 && h[tp[0]] > 15) {
        // junction surface: nearest point on main profile
        const jx = gx(bestJ % N), jz = gx((bestJ / N) | 0);
        const mp = profiles[0];
        let bk = 0, bd = 1e18;
        for (let k = 0; k < mp.pts.length; k++) {
          const dx = mp.pts[k].x - jx, dz = mp.pts[k].z - jz;
          if (dx * dx + dz * dz < bd) {
            bd = dx * dx + dz * dz;
            bk = k;
          }
        }
        const run: RiverRun = { cells: tp.concat([bestJ]), startLevel: NaN, endLevel: mp.s[bk], toSea: false };
        if (!tp.some((i) => lakeOf[i] >= 0)) {
          const pr = buildProfile(run);
          if (pr) profiles.push(pr);
        }
      }
    }
  }

  // nearest-segment assignment
  for (const pr of profiles) {
    const { pts, s, w, d, sp } = pr;
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k], b = pts[k + 1];
      const R = Math.max(w[k], w[k + 1]) * 0.5 + 3 + Math.max(w[k], w[k + 1]) * 0.8;
      const x0 = Math.max(0, Math.floor(toG(Math.min(a.x, b.x) - R))), x1 = Math.min(N - 1, Math.ceil(toG(Math.max(a.x, b.x) + R)));
      const z0 = Math.max(0, Math.floor(toG(Math.min(a.z, b.z) - R))), z1 = Math.min(N - 1, Math.ceil(toG(Math.max(a.z, b.z) + R)));
      const abx = b.x - a.x, abz = b.z - a.z;
      const l2 = abx * abx + abz * abz || 1;
      const il = 1 / Math.sqrt(l2);
      for (let iz = z0; iz <= z1; iz++)
        for (let ix = x0; ix <= x1; ix++) {
          const x = gx(ix), z = gx(iz);
          let t = ((x - a.x) * abx + (z - a.z) * abz) / l2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const dx = x - (a.x + abx * t), dz = z - (a.z + abz * t);
          const dist = Math.sqrt(dx * dx + dz * dz);
          const i = iz * N + ix;
          if (dist < rd[i]) {
            rd[i] = dist;
            rs[i] = s[k] + (s[k + 1] - s[k]) * t;
            rw[i] = w[k] + (w[k + 1] - w[k]) * t;
            rdp[i] = d[k] + (d[k + 1] - d[k]) * t;
            const spd = sp[k] + (sp[k + 1] - sp[k]) * t;
            rfx[i] = abx * il * spd;
            rfz[i] = abz * il * spd;
          }
        }
    }
  }

  for (let i = 0; i < NN; i++) {
    const r = rd[i];
    if (r > 60) continue;
    const half = rw[i] * 0.5;
    const bank = 3 + rw[i] * 0.8;
    if (r > half + bank) continue;
    const s = rs[i];
    const cur = h[i];
    let nh: number;
    if (r < half) {
      const q = r / half;
      nh = s - rdp[i] * (1 - q * q * 0.85);
      if (cur < nh) nh = cur;
    } else {
      // (banks of a sea-level mouth stay dry ground, not a 0 m wet-sand strip)
      let target = s + 0.1 + (r - half) * 0.55;
      if (target < SHORE_FLOOR) target = SHORE_FLOOR;
      const blend = smoothstep(half + bank * 0.55, half + bank, r);
      nh = cur > target ? target + (cur - target) * blend : cur;
      // levee to hold the water in where the ground is lower than the surface
      if (s > 0.6 && r < half + 1.6 && nh < s + 0.12 && lakeOf[i] < 0) nh = s + 0.12;
    }
    h[i] = nh;
    if (r <= half + 0.6 && s > 0.05 && lakeOf[i] < 0) {
      if (s > ctx.water[i]) ctx.water[i] = s;
      onRiver[i] = 1;
    }
    if (r <= half + 1 && lakeOf[i] < 0) {
      const f = 1 - (r / (half + 1)) * (r / (half + 1));
      ctx.flow[i * 2] = rfx[i] * f;
      ctx.flow[i * 2 + 1] = rfz[i] * f;
    }
  }

  // ---- record rivers and waterfalls ------------------------------------------
  for (const pr of profiles) {
    const pts: RiverPoint[] = [];
    const n = pr.pts.length;
    // A river that reaches the sea (or joins one in its estuary) is recorded
    // up to where its surface meets sea level: past that its carved channel
    // holds sea water (drawn and simulated as the sea), and a fresh-water
    // ribbon lying on the sea only shows as a darker patch.
    let nr = n;
    for (let k = 1; k < n; k++) if (pr.s[k] <= 0.01) { nr = k + 1; break; }
    for (let k = 0; k < nr; k += 2) {
      pts.push({ x: pr.pts[k].x, z: pr.pts[k].z, y: pr.s[k], width: pr.w[k], depth: pr.d[k] });
    }
    if ((nr - 1) % 2 !== 0) {
      const k = nr - 1;
      pts.push({ x: pr.pts[k].x, z: pr.pts[k].z, y: pr.s[k], width: pr.w[k], depth: pr.d[k] });
    }
    ctx.rivers.push({ points: pts } as River);
    // waterfalls: a big surface drop over a short run; keep the best 2, spaced
    const falls: typeof ctx.waterfalls = [];
    let k = 0;
    while (k < n - 4) {
      const drop = pr.s[k] - pr.s[k + 3];
      if (drop > 3.0) {
        let e = k + 3;
        while (e < n - 1 && pr.s[e] - pr.s[e + 1] > 0.5) e++;
        const total = pr.s[k] - pr.s[e];
        if (total >= 4 && (e - k) * 2 <= total * 2.5 + 6) {
          const a = pr.pts[k], b = pr.pts[Math.min(n - 1, k + 2)];
          falls.push({
            x: a.x, z: a.z, top: pr.s[k], bottom: pr.s[e], width: pr.w[k],
            dir: atan2(b.x - a.x, b.z - a.z),
          });
        }
        k = e + 1;
      } else k++;
    }
    // a river that leaves a cliff top always shows its fall into the sea
    const atSea = (f: (typeof falls)[number]) => (f.bottom <= 0.05 ? 1 : 0);
    falls.sort((a, b) => atSea(b) - atSea(a) || b.top - b.bottom - (a.top - a.bottom));
    const keep: typeof falls = [];
    for (const f of falls) {
      if (keep.length >= 2) break;
      if (keep.some((q) => (q.x - f.x) * (q.x - f.x) + (q.z - f.z) * (q.z - f.z) < 40 * 40)) continue;
      keep.push(f);
    }
    ctx.waterfalls.push(...keep);
  }

  // distance to fresh water (m)
  const wm = new Uint8Array(NN);
  for (let i = 0; i < NN; i++) wm[i] = ctx.water[i] !== NO_WATER ? 1 : 0;
  const wd = edt(wm, N, N);
  for (let i = 0; i < NN; i++) ctx.waterDist[i] = wd[i] > 1e6 ? 1e6 : wd[i] * CELL;
  void onRiver;
}
