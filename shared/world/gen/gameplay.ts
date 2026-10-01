// Stage 10: gameplay placement — spawns, ammo caches, upgrades, speedboats,
// jetskis, Vespas, gyrocopters, ziplines — with a reachability check over the
// walkable (and swimmable) surface plus cave tunnels.
import type { Rng } from "../../math/rng";
import { atan2, cos, sin } from "../../math/trig";
import { buildCollision, caveSdf, groundBelow, sdf, type CollisionWorld } from "../collide";
import { CAVE_FLOOR } from "../collide";
import type { Ctx } from "../context";
import { gx, N, NN, sample, toI } from "../grid";
import { Biome, NO_WATER, PickupKind, PROP_STRIDE, PropKind, VehicleKind, type PickupSpawn, type World } from "../types";
import { BLOCK_CAVE, BLOCK_DOCK, BLOCK_STRUCT } from "./sites";
import { caveAt, computeReach } from "../reach";
import { zipCableY, ZIP_RIDER_FEET } from "../zipline";

export function worldFromCtx(ctx: Ctx): World {
  return {
    seed: ctx.seed, name: ctx.name, timeOfDay: 12, windDir: ctx.windDir, height: ctx.height, water: ctx.water,
    flow: ctx.flow, biome: ctx.biome, moisture: ctx.moisture, path: ctx.path, holes: ctx.holes, rivers: ctx.rivers,
    waterfalls: ctx.waterfalls, lakes: ctx.lakes, caves: ctx.caves, paths: ctx.paths, structures: ctx.structures,
    props: ctx.props, landmarks: ctx.landmarks, pickups: ctx.pickups, vehicles: ctx.vehicles, ziplines: ctx.ziplines,
    spawns: ctx.spawns,
  };
}

const UPGRADES_RISKY = [PickupKind.RapidFire, PickupKind.LongBarrel, PickupKind.Vest, PickupKind.Scope];
const UPGRADES_COMMON = [PickupKind.BigHopper, PickupKind.QuickFeet, PickupKind.Snorkel, PickupKind.Scope, PickupKind.Vest];

interface P2 {
  x: number;
  z: number;
}

export function gameplayStage(ctx: Ctx, rng: Rng): CollisionWorld {
  const h = ctx.height;
  plantLandmarkTrees(ctx);
  const world = worldFromCtx(ctx);
  const cw = buildCollision(world);

  // ---- reachability (walkable land + water + caves) --------------------------------
  const R = computeReach(world);
  ctx.reach.set(R.main);
  const reachable = (x: number, z: number) => R.at(x, z, 2);

  const clear = (x: number, y: number, z: number, r: number) => sdf(cw, x, y + 0.9, z) >= r;
  const landOk = (i: number) =>
    h[i] > 1 && ctx.water[i] === NO_WATER && !ctx.holes[i] && ctx.slope[i] < 0.45 && ctx.reach[i] === 1 &&
    !(ctx.blocked[i] & (BLOCK_STRUCT | BLOCK_CAVE | BLOCK_DOCK));

  // ---- spawns: farthest-point sampling ----------------------------------------------
  const cand: number[] = [];
  for (let iz = 4; iz < N - 4; iz += 3)
    for (let ix = 4; ix < N - 4; ix += 3) {
      const i = iz * N + ix;
      if (landOk(i)) cand.push(i);
    }
  const srng = rng.fork("spawns");
  const minD = new Float64Array(cand.length).fill(1e18);
  const spawnTarget = 40;
  const updateMin = (x: number, z: number) => {
    for (let k = 0; k < cand.length; k++) {
      const i = cand[k];
      const dx = gx(i % N) - x, dz = gx((i / N) | 0) - z;
      const d = dx * dx + dz * dz;
      if (d < minD[k]) minD[k] = d;
    }
  };
  // avoid spawning on top of structures' doorsteps: seed distances with site centers
  // (the village is a whole town, not a doorstep: its open streets and green may hold spawns)
  for (const s of ctx.sites) if (s.kind !== "village") updateMin(s.x, s.z);
  const taken = new Uint8Array(cand.length);
  for (let n = 0; n < spawnTarget && cand.length > 0; n++) {
    let bk = -1, bv = -1;
    for (let k = 0; k < cand.length; k++) {
      if (taken[k]) continue;
      const v = minD[k] * (0.85 + 0.3 * srng.next());
      if (v > bv) {
        bv = v;
        bk = k;
      }
    }
    if (bk < 0) break;
    taken[bk] = 1;
    const i = cand[bk];
    let x = gx(i % N) + srng.range(-1, 1), z = gx((i / N) | 0) + srng.range(-1, 1);
    let y = sample(h, x, z);
    if (y < 0.9) {
      // the jitter slid down a bank toward the water: stand on the sample itself
      x = gx(i % N);
      z = gx((i / N) | 0);
      y = h[i];
    }
    if (!clear(x, y, z, 0.8) || sdf(cw, x, y + 2.9, z) < 1.8 || caveSdf(world, x, y + 1, z) < 0.5) {
      n--;
      minD[bk] = 0;
      continue;
    }
    ctx.spawns.push({ x, y, z });
    updateMin(x, z);
  }

  // ---- pickups ---------------------------------------------------------------------
  const prng = rng.fork("pickups");
  const pickups: PickupSpawn[] = [];
  // nudge a pickup to the nearest spot with ~0.4 m of clearance around it
  const addP = (kind: PickupKind, x: number, y: number, z: number) => {
    for (let r = 0; r <= 3; r += 0.75) {
      const cnt = r === 0 ? 1 : 8;
      for (let k = 0; k < cnt; k++) {
        const a = (k / cnt) * 6.283185307179586;
        const px = x + sin(a) * r, pz = z + cos(a) * r;
        let py = y;
        if (r > 0) {
          const g = groundBelow(cw, px, y + 1.0, pz);
          if (!(g > y - 1.5)) continue;
          py = g;
        }
        if (sdf(cw, px, py + 0.6, pz) > 0.4) {
          pickups.push({ kind, x: px, y: py, z: pz });
          return;
        }
      }
    }
  };
  const snap = (x: number, y: number, z: number) => {
    const g = groundBelow(cw, x, y + 1.2, z);
    return g > -1e9 && y + 1.2 - g < 4 ? g : y;
  };
  let risky = 0;
  const riskyKind = () => UPGRADES_RISKY[(risky++ + prng.int(2)) % UPGRADES_RISKY.length];
  // structure spots
  for (const s of ctx.sites) {
    for (const sp of s.spots) {
      if (sp.tag === "tree" || sp.tag === "gate") continue;
      const y = snap(sp.x, sp.y, sp.z);
      if (sp.tag === "top") addP(riskyKind(), sp.x, y, sp.z);
      else if (sp.tag === "dockEnd") addP(PickupKind.Snorkel, sp.x, y, sp.z);
      else addP(PickupKind.Ammo, sp.x, y, sp.z);
    }
  }
  // caves: upgrade in chambers, ammo mid-tunnel
  for (const c of ctx.caves) {
    if (c.spots) {
      // the cave stage suggests spots on the real floor (main hall, dead-end rooms, tunnels)
      for (const s of c.spots) addP(s.upgrade ? riskyKind() : PickupKind.Ammo, s.x, s.y + 0.05, s.z);
      continue;
    }
    for (let k = 0; k < c.nodes.length; k++) {
      const n = c.nodes[k];
      if (n.r >= 7) addP(riskyKind(), n.x, n.y - 0.45 * n.r + 0.05, n.z);
    }
    const mid = c.nodes[Math.min(c.nodes.length - 1, 3)];
    if (mid.r < 7) addP(PickupKind.Ammo, mid.x, mid.y - CAVE_FLOOR * mid.r + 0.05, mid.z);
  }
  // summits
  for (const p of ctx.peaks) {
    let best = -1, bh = -1e9;
    const ci = toI(p.x), cj = toI(p.z);
    for (let dz = -25; dz <= 25; dz++)
      for (let dx = -25; dx <= 25; dx++) {
        const ix = ci + dx, iz = cj + dz;
        if (ix < 0 || iz < 0 || ix >= N || iz >= N) continue;
        const i = iz * N + ix;
        if (h[i] > bh && ctx.slope[i] < 0.6 && ctx.reach[i] && ctx.water[i] === NO_WATER && !ctx.holes[i]) {
          bh = h[i];
          best = i;
        }
      }
    if (best >= 0 && bh > 30) addP(riskyKind(), gx(best % N), bh, gx((best / N) | 0));
  }
  // islets
  for (const s of ctx.islets) {
    const i = toI(s.z) * N + toI(s.x);
    if (h[i] > 0.8 && ctx.reach[i]) addP(prng.pick(UPGRADES_COMMON), s.x, h[i], s.z);
  }
  // waterfalls: a snorkel in the plunge pool area
  for (const f of ctx.waterfalls.slice(0, 2)) {
    const x = f.x + prng.range(-4, 4), z = f.z + prng.range(-4, 4);
    const i = toI(z) * N + toI(x);
    if (h[i] > 0.3 && ctx.water[i] === NO_WATER && ctx.reach[i]) addP(PickupKind.Snorkel, x, h[i], z);
  }
  // bridges & chokepoints
  for (const st of ctx.structures) {
    if (st.kind !== 8) continue;
    const x = st.x + prng.range(-3, 3), z = st.z + prng.range(-3, 3);
    const y = snap(x, st.solids[0].cy + 0.5, z);
    addP(PickupKind.Ammo, x, y, z);
  }
  // fill: farthest-point over land, path cells preferred for ammo
  const fillPick = (target: (k: PickupKind) => boolean, count: number, kindFn: () => PickupKind, minSpacing: number) => {
    const pts: P2[] = pickups.filter((p) => target(p.kind)).map((p) => ({ x: p.x, z: p.z }));
    const md = new Float64Array(cand.length).fill(1e18);
    for (let k = 0; k < cand.length; k++) {
      const i = cand[k];
      const x = gx(i % N), z = gx((i / N) | 0);
      for (const p of pts) {
        const d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
        if (d < md[k]) md[k] = d;
      }
    }
    for (let n = 0; n < count; n++) {
      let bk = -1, bv = -1;
      for (let k = 0; k < cand.length; k++) {
        const i = cand[k];
        let v = md[k] * (0.8 + 0.4 * prng.next());
        if (ctx.path[i] > 60) v *= 1.5;
        if (v > bv) {
          bv = v;
          bk = k;
        }
      }
      if (bk < 0 || bv < minSpacing * minSpacing) break;
      const i = cand[bk];
      const x = gx(i % N), z = gx((i / N) | 0);
      addP(kindFn(), x, sample(h, x, z), z);
      for (let k = 0; k < cand.length; k++) {
        const j = cand[k];
        const d = (gx(j % N) - x) * (gx(j % N) - x) + (gx((j / N) | 0) - z) * (gx((j / N) | 0) - z);
        if (d < md[k]) md[k] = d;
      }
    }
  };
  const ammoNow = pickups.filter((p) => p.kind === PickupKind.Ammo).length;
  fillPick((k) => k === PickupKind.Ammo, Math.max(0, prng.intRange(46, 56) - ammoNow), () => PickupKind.Ammo, 18);
  const upNow = pickups.filter((p) => p.kind !== PickupKind.Ammo).length;
  fillPick((k) => k !== PickupKind.Ammo, Math.max(0, prng.intRange(16, 21) - upNow), () => prng.pick(UPGRADES_COMMON), 40);
  // keep only reachable ones (caves are reachable through their entrances)
  for (const p of pickups) {
    const c = caveAt(world, p.x, p.y, p.z);
    if (c >= 0) {
      if (ctx.caves[c].entrances.some((e) => reachable(e.x + e.dx * 4, e.z + e.dz * 4))) ctx.pickups.push(p);
    } else if (reachable(p.x, p.z)) ctx.pickups.push(p);
  }

  // ---- vehicles -------------------------------------------------------------------
  const vrng = rng.fork("vehicles");
  const boathouse = ctx.sites.find((s) => s.kind === "boathouse");
  if (boathouse) {
    const end = boathouse.spots.find((s) => s.tag === "dockEnd");
    if (end) {
      // beside the dock end, in the water
      const ax = end.x - boathouse.x, az = end.z - boathouse.z;
      const L = Math.sqrt(ax * ax + az * az) || 1;
      const px = -az / L, pz = ax / L;
      // a runabout moored alongside, a jetski tied up on the other side
      const b1 = waterSpot(ctx, cw, end.x - px * 3.4 - (ax / L) * 3, end.z - pz * 3.4 - (az / L) * 3, SPEEDBOAT_CLEAR);
      if (b1) ctx.vehicles.push({ kind: VehicleKind.Speedboat, x: b1.x, y: 0, z: b1.z, rotY: atan2(ax, az) });
      const b2 = waterSpot(ctx, cw, end.x + px * 2.6, end.z + pz * 2.6);
      if (b2) ctx.vehicles.push({ kind: VehicleKind.Jetski, x: b2.x, y: 0, z: b2.z, rotY: atan2(ax, az) });
    }
  }
  boatRoute(ctx, cw, vrng);
  // speedboats (and the odd jetski) moored at the cove jetties
  for (const j of ctx.sites) {
    if (j.kind !== "jetty") continue;
    const end = j.spots.find((s) => s.tag === "dockEnd");
    if (!end) continue;
    const ax = end.x - j.x, az = end.z - j.z;
    const L = Math.sqrt(ax * ax + az * az) || 1;
    const px = -az / L, pz = ax / L;
    const side = vrng.chance(0.5) ? 1 : -1;
    const speedboat = vrng.chance(0.75);
    const b1 = speedboat
      ? waterSpot(ctx, cw, end.x + px * 3.0 * side, end.z + pz * 3.0 * side, SPEEDBOAT_CLEAR)
      : waterSpot(ctx, cw, end.x + px * 2.4 * side, end.z + pz * 2.4 * side);
    if (b1) ctx.vehicles.push({ kind: speedboat ? VehicleKind.Speedboat : VehicleKind.Jetski, x: b1.x, y: 0, z: b1.z, rotY: atan2(ax, az) + vrng.range(-0.25, 0.25) });
  }
  // Vespas: at the shed, then on paths far apart
  const shed = ctx.sites.find((s) => s.kind === "shed");
  const vespas: P2[] = [];
  const pathPts: { x: number; z: number; dx: number; dz: number }[] = [];
  for (const p of ctx.paths)
    for (let k = 2; k < p.points.length - 2; k += 3) {
      const a = p.points[k - 1], b = p.points[k + 1];
      pathPts.push({ x: p.points[k].x, z: p.points[k].z, dx: b.x - a.x, dz: b.z - a.z });
    }
  if (shed) {
    const x = shed.door.x, z = shed.door.z;
    vespas.push({ x, z });
    ctx.vehicles.push({ kind: VehicleKind.Vespa, x, y: sample(h, x, z), z, rotY: shed.rot + 2.4 });
  }
  const nV = vrng.intRange(2, 4);
  for (let tries = 0; tries < 200 && vespas.length < nV && pathPts.length > 0; tries++) {
    const p = pathPts[vrng.int(pathPts.length)];
    const i = toI(p.z) * N + toI(p.x);
    if (ctx.water[i] !== NO_WATER || h[i] < 0.8 || ctx.slope[i] > 0.3 || !ctx.reach[i]) continue;
    if (vespas.some((v) => (v.x - p.x) * (v.x - p.x) + (v.z - p.z) * (v.z - p.z) < 120 * 120)) continue;
    // park on the verge
    const l = Math.sqrt(p.dx * p.dx + p.dz * p.dz) || 1;
    const x = p.x + (-p.dz / l) * 1.6, z = p.z + (p.dx / l) * 1.6;
    if (!clear(x, sample(h, x, z), z, 0.6)) continue;
    vespas.push({ x, z });
    ctx.vehicles.push({ kind: VehicleKind.Vespa, x, y: sample(h, x, z), z, rotY: atan2(p.dx, p.dz) });
  }

  // ---- gyrocopters: open, flat ground with a clear take-off run ---------------------------
  gyrocopters(ctx, cw, rng.fork("gyros"), landOk);

  // ---- ziplines ------------------------------------------------------------------------
  ziplines(ctx, cw, rng.fork("ziplines"));
  return cw;
}

/**
 * The shade tree on the village green (site spots tagged "tree"): a banyan-like
 * emergent tree on lush / tropical islands, an umbrella pine elsewhere. It is a
 * collider prop, so it is planted here (after the prop scatter, before the
 * collision world is built) and skipDecor worlds get it too.
 */
function plantLandmarkTrees(ctx: Ctx): void {
  const pac = ctx.ch.climate === "lush" || ctx.ch.climate === "tropical";
  const kind = pac ? PropKind.JungleGiant : PropKind.UmbrellaPine;
  const scale = pac ? 0.95 : 1.35;
  const add: number[] = [];
  for (const s of ctx.sites)
    for (const sp of s.spots) {
      if (sp.tag !== "tree") continue;
      add.push(sp.x, sample(ctx.height, sp.x, sp.z) - 0.12 * scale, sp.z, (s.rot * 1.7) % 6.283185307179586, scale);
    }
  if (!add.length) return;
  let set = ctx.props.find((p) => p.kind === kind);
  if (!set) {
    set = { kind, count: 0, data: new Float32Array(0) };
    ctx.props.push(set);
    ctx.props.sort((a, b) => a.kind - b.kind);
  }
  const data = new Float32Array(set.data.length + add.length);
  data.set(set.data);
  data.set(add, set.data.length);
  set.data = data;
  set.count = data.length / PROP_STRIDE;
}

/** Land-only BFS distance (m, 8-neighbour) from a start cell. */
function landDistance(ctx: Ctx, start: number, out: Float32Array, queue: Int32Array): void {
  out.fill(1e9);
  const h = ctx.height;
  let qh = 0, qt = 0;
  out[start] = 0;
  queue[qt++] = start;
  while (qh < qt) {
    const i = queue[qh++];
    const ix = i % N, iz = (i / N) | 0;
    const d0 = out[i];
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        const x = ix + dx, z = iz + dz;
        if (x < 0 || z < 0 || x >= N || z >= N) continue;
        const j = z * N + x;
        if (out[j] < 1e9) continue;
        if (h[j] <= 0.15 || ctx.slope[j] > 0.84) continue;
        out[j] = d0 + (dx && dz ? 2.83 : 2);
        queue[qt++] = j;
      }
  }
}

/** Jetskis on two beaches where crossing the water beats walking around. */
function boatRoute(ctx: Ctx, cw: CollisionWorld, rng: Rng): void {
  const h = ctx.height;
  const beaches: { i: number; x: number; z: number; sx: number; sz: number }[] = [];
  for (let iz = 4; iz < N - 4; iz += 3)
    for (let ix = 4; ix < N - 4; ix += 3) {
      const i = iz * N + ix;
      if (ctx.biome[i] !== Biome.Beach || !ctx.reach[i]) continue;
      const c = ctx.coast[i];
      if (c < 2 || c > 9 || ctx.shelter[i] < 0.35) continue;
      const gxv = ctx.coast[i + 1] - ctx.coast[i - 1], gzv = ctx.coast[i + N] - ctx.coast[i - N];
      const l = Math.sqrt(gxv * gxv + gzv * gzv);
      if (l < 1e-3) continue;
      beaches.push({ i, x: gx(ix), z: gx(iz), sx: -gxv / l, sz: -gzv / l });
    }
  if (beaches.length < 2) return;
  // thin out to ~24 well spread candidates
  const pick: typeof beaches = [];
  const md = new Float64Array(beaches.length).fill(1e18);
  let cur = rng.int(beaches.length);
  for (let n = 0; n < 24; n++) {
    pick.push(beaches[cur]);
    let bk = -1, bv = -1;
    for (let k = 0; k < beaches.length; k++) {
      const d = (beaches[k].x - beaches[cur].x) * (beaches[k].x - beaches[cur].x) + (beaches[k].z - beaches[cur].z) * (beaches[k].z - beaches[cur].z);
      if (d < md[k]) md[k] = d;
      if (md[k] > bv) {
        bv = md[k];
        bk = k;
      }
    }
    if (bv < 60 * 60) break;
    cur = bk;
  }
  const dist = new Float32Array(NN);
  const queue = new Int32Array(NN);
  let best: [number, number] | null = null, bestS = 0;
  for (let a = 0; a < pick.length; a++) {
    landDistance(ctx, pick[a].i, dist, queue);
    for (let b = 0; b < pick.length; b++) {
      if (b === a) continue;
      const A = pick[a], Bp = pick[b];
      const dx = Bp.x - A.x, dz = Bp.z - A.z;
      const dw = Math.sqrt(dx * dx + dz * dz);
      if (dw < 80 || dw > 480) continue;
      // mostly open water in between
      let wet = 0;
      for (let t = 0.1; t < 0.95; t += 0.05) if (sample(h, A.x + dx * t, A.z + dz * t) < -0.6) wet++;
      if (wet < 13) continue;
      const dl = dist[Bp.i];
      const s = (dl > 1e8 ? dw * 4 : dl) - dw * 1.4;
      if (s > bestS) {
        bestS = s;
        best = [a, b];
      }
    }
  }
  if (!best) return;
  for (const k of best) {
    const p = pick[k];
    const o = pick[k === best[0] ? best[1] : best[0]];
    let x = p.x + p.sx * 5, z = p.z + p.sz * 5;
    for (let s = 5; s < 30 && sample(h, x, z) > -0.9; s += 1) {
      x = p.x + p.sx * s;
      z = p.z + p.sz * s;
    }
    const w = waterSpot(ctx, cw, x, z);
    if (w) ctx.vehicles.push({ kind: VehicleKind.Jetski, x: w.x, y: 0, z: w.z, rotY: atan2(o.x - p.x, o.z - p.z) });
  }
}

/** Gyrocopters per island, and how far apart. */
const GYRO_COUNT = 2;
const GYRO_SPACING = 170;
/** Take-off run that must be flat and clear ahead of a parked gyro (m). */
const GYRO_RUN = 26;

/**
 * Gyrocopters on open, flat ground (meadows, hilltops, village greens) with a
 * clear, level take-off run ahead of them. Candidates are ranked by flatness,
 * height and biome, then the runway is checked against the collision SDF
 * (trunks, rocks, walls) in 8 headings; the best heading wins.
 */
function gyrocopters(ctx: Ctx, cw: CollisionWorld, rng: Rng, landOk: (i: number) => boolean): void {
  const placed: P2[] = [];
  // strict first (meadow-ish, long flat run), then anything open enough
  gyroPass(ctx, cw, rng, landOk, placed, 0.22, GYRO_RUN, false);
  if (placed.length < GYRO_COUNT) gyroPass(ctx, cw, rng, landOk, placed, 0.32, 18, true);
}

function gyroPass(ctx: Ctx, cw: CollisionWorld, rng: Rng, landOk: (i: number) => boolean, placed: P2[], maxSlope: number, run: number, anyBiome: boolean): void {
  const h = ctx.height;
  const cand: { x: number; z: number; s: number; k: number }[] = [];
  for (let iz = 6; iz < N - 6; iz += 3)
    for (let ix = 6; ix < N - 6; ix += 3) {
      const i = iz * N + ix;
      if (!landOk(i) || h[i] < 2) continue;
      const b = ctx.biome[i];
      // (not in town: streets are lined with buildings and lamp posts)
      const bonus = b === Biome.Meadow ? 1 : b === Biome.Scrub || b === Biome.PalmGrove ? 0.4 : b === Biome.Beach ? 0.2 : -1;
      if (bonus < 0 && !anyBiome) continue;
      // flat neighbourhood (±6 m)
      let sl = 0;
      for (let dz = -3; dz <= 3; dz += 3)
        for (let dx = -3; dx <= 3; dx += 3) {
          const s = ctx.slope[(iz + dz) * N + ix + dx];
          if (s > sl) sl = s;
        }
      if (sl > maxSlope) continue;
      cand.push({ x: gx(ix), z: gx(iz), s: bonus + (maxSlope - sl) * 4 + Math.min(h[i], 60) * 0.015 + rng.next() * 0.35, k: cand.length });
    }
  cand.sort((a, b) => b.s - a.s || a.k - b.k);
  const clearAt = (x: number, z: number): number => {
    const i = toI(z) * N + toI(x);
    if (ctx.water[i] !== NO_WATER || ctx.holes[i] || h[i] < 0.8) return NaN;
    const y = sample(h, x, z);
    if (sdf(cw, x, y + 0.8, z) < 0.6 || sdf(cw, x, y + 2, z) < 1.4) return NaN;
    return y;
  };
  let tried = 0;
  for (const c of cand) {
    if (placed.length >= GYRO_COUNT || tried > 600) break;
    if (placed.some((p) => (p.x - c.x) * (p.x - c.x) + (p.z - c.z) * (p.z - c.z) < GYRO_SPACING * GYRO_SPACING)) continue;
    tried++;
    const y0 = clearAt(c.x, c.z);
    if (y0 !== y0 || sdf(cw, c.x, y0 + 2.4, c.z) < 2.3) continue;
    // best heading: the run stays level and clear the longest
    let bestA = -1, bestL = 0;
    const a0 = rng.int(8);
    for (let q = 0; q < 8; q++) {
      const a = ((a0 + q) % 8) * 0.7853981633974483;
      const dx = sin(a), dz = cos(a);
      let prev = y0, L = 0;
      for (let t = 2; t <= run; t += 2) {
        const y = clearAt(c.x + dx * t, c.z + dz * t);
        if (y !== y || Math.abs(y - prev) > 0.5 || Math.abs(y - y0) > 3) break;
        prev = y;
        L = t;
      }
      if (L > bestL) { bestL = L; bestA = a; }
      if (L >= run) break;
    }
    if (bestL < run) continue;
    placed.push({ x: c.x, z: c.z });
    ctx.vehicles.push({ kind: VehicleKind.Gyrocopter, x: c.x, y: y0, z: c.z, rotY: bestA });
  }
}

/** Zipline handle height above the standing spot at the top, and above ground at the bottom. */
export const ZIP_GRAB = 2.5;
export const ZIP_DROP = 1.6;

function ziplines(ctx: Ctx, cw: CollisionWorld, rng: Rng): void {
  const h = ctx.height;
  // A standing spot is grabbable when there is a floor under it and a player fits there.
  const standAt = (x: number, y: number, z: number): number => {
    const g = groundBelow(cw, x, y, z);
    if (!(g > y - 3)) return NaN;
    if (sdf(cw, x, g + 0.95, z) < 0.35 || sdf(cw, x, g + 1.5, z) < 0.35) return NaN;
    return g;
  };
  // The handle must be reachable from a standing spot within 1.5 m on a coarse
  // ring (what players and bots actually probe), not only from the exact spot;
  // trees near cliff tops can otherwise crowd the ring.
  const grabbable = (ax: number, ay: number, az: number): boolean => {
    for (let r = 0; r <= 1.5; r += 0.5)
      for (let k = 0; k < (r === 0 ? 1 : 8); k++) {
        const x = ax + sin(k * 0.785) * r, z = az + cos(k * 0.785) * r;
        const g = groundBelow(cw, x, ay, z);
        const dy = ay - g;
        if (dy >= 2.2 && dy <= 2.6 && sdf(cw, x, g + 1, z) > 0.3 && sdf(cw, x, g + 1.5, z) > 0.3) return true;
      }
    return false;
  };
  // Launch points: a standable spot at the brink of a drop (cliff top, ridge
  // shoulder) so the hanging rider clears the ground as the cable dips away.
  // The handle hangs 1.4 m out from the standing spot (0.9 m past the lip), ZIP_GRAB above it.
  const starts: { x: number; y: number; z: number; dir: number; p: number }[] = [];
  for (let iz = 8; iz < N - 8; iz += 3)
    for (let ix = 8; ix < N - 8; ix += 3) {
      const i = iz * N + ix;
      if (h[i] < 14 || ctx.slope[i] > 0.5 || !ctx.reach[i] || ctx.water[i] !== NO_WATER || ctx.blocked[i] & (BLOCK_STRUCT | BLOCK_CAVE)) continue;
      const x = gx(ix), z = gx(iz);
      // walk out to the lip in each direction, then require a real drop beyond it
      let best: { x: number; z: number; g: number; dir: number; drop: number } | null = null;
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * 6.283185307179586;
        const sx = sin(a), sz = cos(a);
        let lx = x, lz = z;
        const h0 = h[i];
        for (let d = 0.5; d <= 8; d += 0.5) {
          const v = sample(h, x + sx * d, z + sz * d);
          if (v < h0 - 0.5) break;
          if (v > h0 + 0.8) {
            lx = NaN;
            break;
          }
          lx = x + sx * d;
          lz = z + sz * d;
        }
        if (lx !== lx) continue;
        const hl = sample(h, lx, lz);
        // terrain must fall away faster than the rider's swing (~1 m/m at first)
        const f3 = hl - sample(h, lx + sx * 3.5, lz + sz * 3.5);
        const f7 = hl - sample(h, lx + sx * 7, lz + sz * 7);
        const f14 = hl - sample(h, lx + sx * 14, lz + sz * 14);
        if (f3 < 2.6 || f7 < 4.8 || f14 < 8) continue;
        if (!best || f14 > best.drop) best = { x: lx, z: lz, g: hl, dir: a, drop: f14 };
      }
      if (!best) continue;
      // stand half a metre back from the lip, on flat ground the sim (and bots) can use
      const sx0 = best.x - sin(best.dir) * 0.5, sz0 = best.z - cos(best.dir) * 0.5;
      const bi = toI(sz0) * N + toI(sx0);
      if (!ctx.reach[bi] || ctx.slope[bi] > 0.7 || ctx.blocked[bi] & (BLOCK_STRUCT | BLOCK_CAVE)) continue;
      const g = standAt(sx0, best.g + 1, sz0);
      if (g !== g) continue;
      if (!grabbable(sx0 + sin(best.dir) * 1.4, g + ZIP_GRAB, sz0 + cos(best.dir) * 1.4)) continue;
      starts.push({
        x: sx0 + sin(best.dir) * 1.4, y: g + ZIP_GRAB, z: sz0 + cos(best.dir) * 1.4, dir: best.dir,
        p: h[i] / 30 + best.drop / 10 + rng.next() * 2,
      });
    }
  starts.sort((p, q) => q.p - p.p);
  const target = rng.intRange(1, 3);
  const made: { ax: number; az: number; bx: number; bz: number }[] = [];
  let tried = 0;
  for (const a of starts) {
    if (ctx.ziplines.length >= target || tried >= 140) break;
    if (made.some((m) => (m.ax - a.x) * (m.ax - a.x) + (m.az - a.z) * (m.az - a.z) < 100 * 100)) continue;
    tried++;
    let best: { x: number; y: number; z: number; s: number } | null = null;
    for (let k = 0; k < 160; k++) {
      const ang = a.dir + rng.range(-0.5, 0.5);
      const L = rng.range(45, 200);
      const bx = a.x + L * sin(ang), bz = a.z + L * cos(ang);
      if (Math.abs(bx) > 480 || Math.abs(bz) > 480) continue;
      const i = toI(bz) * N + toI(bx);
      if (h[i] < 1 || ctx.water[i] !== NO_WATER || ctx.slope[i] > 0.35 || !ctx.reach[i] || ctx.blocked[i] & (BLOCK_STRUCT | BLOCK_CAVE | BLOCK_DOCK)) continue;
      const bg = standAt(bx, sample(h, bx, bz) + 1, bz);
      if (bg !== bg) continue;
      const by = bg + ZIP_DROP;
      const drop = a.y - by;
      if (drop < 0.08 * L || drop > 0.5 * L) continue;
      if (made.some((m) => (m.bx - bx) * (m.bx - bx) + (m.bz - bz) * (m.bz - bz) < 90 * 90)) continue;
      // clearance along the sagging cable (same curve the sim rides): the
      // cable keeps >= 2 m, the hanging rider's feet >= 0.6 m
      const zl = { ax: a.x, ay: a.y, az: a.z, bx, by, bz };
      let ok = true;
      const steps = Math.ceil(L / 1.5);
      for (let s = 1; s < steps && ok; s++) {
        const t = s / steps;
        const d = t * L;
        const x = a.x + (bx - a.x) * t, z = a.z + (bz - a.z) * t;
        const y = zipCableY(zl, t);
        const feet = y - ZIP_RIDER_FEET;
        if (d > 4 && L - d > 4 && (y - sample(h, x, z) < 2.2 || sdf(cw, x, y, z) < 2)) ok = false;
        // right after launch the rider swings down steeply: a smaller margin there
        if (d > 1.5 && L - d > 3 && sdf(cw, x, feet + 0.25, z) < (d < 10 ? 0.3 : 0.6)) ok = false;
      }
      if (!ok) continue;
      // prefer long rides that land near paths / sites
      const near = ctx.path[i] > 0 ? 1 : 0;
      const s = L + drop * 0.5 + near * 40 + rng.next() * 30;
      if (!best || s > best.s) best = { x: bx, y: by, z: bz, s };
    }
    if (best) {
      ctx.ziplines.push({ ax: a.x, ay: a.y, az: a.z, bx: best.x, by: best.y, bz: best.z });
      made.push({ ax: a.x, az: a.z, bx: best.x, bz: best.z });
    }
  }
}


/** Nearest open sea spot (>= 0.9 m deep, clear of docks) around (x, z). */
/** Clearance a moored speedboat needs around its middle (it's ~6 m long). */
const SPEEDBOAT_CLEAR = 2.2;

function waterSpot(ctx: Ctx, cw: CollisionWorld, x: number, z: number, clear = 1.1): P2 | null {
  for (let r = 0; r <= 40; r += 1.5) {
    const cnt = r === 0 ? 1 : Math.max(8, Math.round(r * 2));
    for (let k = 0; k < cnt; k++) {
      const a = (k / cnt) * 6.283185307179586;
      const px = x + sin(a) * r, pz = z + cos(a) * r;
      if (sample(ctx.height, px, pz) > -0.7) continue;
      if (sdf(cw, px, 0.5, pz) < clear) continue;
      // big hulls: deep enough under the bow and stern whichever way they swing
      if (clear > 1.1) {
        let ok = true;
        for (let q = 0; q < 4 && ok; q++) {
          const qx = px + (q === 0 ? 3 : q === 1 ? -3 : 0), qz = pz + (q === 2 ? 3 : q === 3 ? -3 : 0);
          if (sample(ctx.height, qx, qz) > -0.7 || sdf(cw, qx, 0.5, qz) < 0.6) ok = false;
        }
        if (!ok) continue;
      }
      return { x: px, z: pz };
    }
  }
  return null;
}
