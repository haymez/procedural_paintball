// "Hot zones": where the fighting is right now. A short log of recent action
// (hits, eliminations, paint splats) clustered into a handful of weighted
// spots. The sim keeps one for bots dropping in; clients build their own from
// the (broadcast) hit / elim / splat events to guide a player's sky drop.
// Pure arithmetic, deterministic: bots depend on it.
import { HOT_RADIUS, HOT_WINDOW } from "./constants";

export interface ActionRec {
  /** Sim time (s). */
  t: number;
  x: number;
  z: number;
  /** Weight: an elimination counts more than a hit, a hit more than a stray splat. */
  w: number;
  /** Paint color involved (client beacons); 0 when unknown. */
  color: number;
}

export interface HotZone {
  x: number;
  z: number;
  /** Decayed summed weight. */
  heat: number;
  /** Color of the heaviest contribution. */
  color: number;
  /** Seconds since the latest action in this zone. */
  age: number;
}

/** Action weights. */
export const HOT_W = { splat: 0.25, hit: 1, elim: 3 } as const;

const MAX_LOG = 96;

/** A rolling log of recent action. */
export class ActionLog {
  readonly recs: ActionRec[] = [];

  add(t: number, x: number, z: number, w: number, color = 0): void {
    const r = this.recs;
    this.prune(t);
    if (r.length >= MAX_LOG) r.shift();
    r.push({ t, x, z, w, color });
  }

  prune(now: number): void {
    const r = this.recs;
    let n = 0;
    while (n < r.length && now - r[n].t > HOT_WINDOW) n++;
    if (n) r.splice(0, n);
  }

  clear(): void {
    this.recs.length = 0;
  }

  /** The hottest zones, hottest first (at most `max`), written into `out`. */
  zones(now: number, out: HotZone[], max = 5): HotZone[] {
    return hotZones(this.recs, now, out, max);
  }
}

const _heavy: number[] = [];

/**
 * Greedy clustering: each record joins the nearest zone within HOT_RADIUS
 * (weighted centre) or starts a new one. Weights fade linearly over
 * HOT_WINDOW. Zones lighter than `minHeat` are dropped.
 */
export function hotZones(recs: readonly ActionRec[], now: number, out: HotZone[], max = 5, minHeat = 0.6): HotZone[] {
  out.length = 0;
  _heavy.length = 0;
  const R2 = HOT_RADIUS * HOT_RADIUS;
  for (const r of recs) {
    const age = now - r.t;
    if (age < 0 || age > HOT_WINDOW) continue;
    const w = r.w * (1 - age / HOT_WINDOW);
    if (w <= 0) continue;
    let best = -1, bd = R2;
    for (let i = 0; i < out.length; i++) {
      const dx = out[i].x - r.x, dz = out[i].z - r.z;
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = i; }
    }
    if (best < 0) {
      out.push({ x: r.x, z: r.z, heat: w, color: r.color, age });
      _heavy.push(w);
    } else {
      const z = out[best];
      const k = w / (z.heat + w);
      z.x += (r.x - z.x) * k;
      z.z += (r.z - z.z) * k;
      z.heat += w;
      if (age < z.age) z.age = age;
      if (w > _heavy[best]) { _heavy[best] = w; if (r.color) z.color = r.color; }
    }
  }
  // hottest first (insertion sort: tiny n, stable, deterministic)
  for (let i = 1; i < out.length; i++) {
    const z = out[i];
    let j = i - 1;
    while (j >= 0 && out[j].heat < z.heat) { out[j + 1] = out[j]; j--; }
    out[j + 1] = z;
  }
  let n = 0;
  while (n < out.length && n < max && out[n].heat >= minHeat) n++;
  out.length = n;
  return out;
}
