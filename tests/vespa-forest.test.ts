// Drives Vespas through the densest forest patches of generated worlds (and
// the same patches with twice the trees) and measures how often they get
// stuck: a glancing hit on a trunk should deflect, not stop the scooter dead.
import { beforeAll, describe, expect, it } from "vitest";
import { generateWorld } from "../shared/world/generate";
import { sdf, terrainHeight } from "../shared/world/collide";
import {
  PROP_COLLIDER_HEIGHT, PROP_COLLIDER_RADIUS, PROP_STRIDE, VehicleKind, type PropSet, type World,
} from "../shared/world/types";
import { createEnv, probeGround, stepVehicle, waterAt, BLOCKED, NO_WATER_Y, TICK_DT, type InputCmd, type SimEnv } from "../shared/sim/index";
import { createVehicleState } from "../shared/sim/vehicle";

interface Stats { trials: number; stuck: number; bumps: number; progress: number; inside: number }

function isTree(kind: number): boolean {
  const r = PROP_COLLIDER_RADIUS[kind as keyof typeof PROP_COLLIDER_RADIUS] ?? 0;
  const h = PROP_COLLIDER_HEIGHT[kind as keyof typeof PROP_COLLIDER_HEIGHT] ?? 0;
  return r > 0.2 && r <= 1.0 && h >= 2.5;
}

/** Same world with an extra jittered copy of every tree (≈ 2× forest density). */
function doubleTrees(world: World): World {
  const extra: PropSet[] = [];
  for (const ps of world.props) {
    if (!isTree(ps.kind)) continue;
    const data = new Float32Array(ps.count * PROP_STRIDE);
    let n = 0;
    for (let j = 0; j < ps.count; j++) {
      const q = j * PROP_STRIDE;
      const h = ((j * 2654435761) >>> 0) / 4294967296;
      const a = h * Math.PI * 2, d = 2.6 + 1.6 * (((j * 40503) >>> 0) % 1000) / 1000;
      const x = ps.data[q] + Math.cos(a) * d, z = ps.data[q + 2] + Math.sin(a) * d;
      const o = n * PROP_STRIDE;
      data[o] = x; data[o + 1] = terrainHeight(world, x, z); data[o + 2] = z;
      data[o + 3] = ps.data[q + 3]; data[o + 4] = ps.data[q + 4];
      n++;
    }
    extra.push({ kind: ps.kind, count: n, data });
  }
  return { ...world, props: [...world.props, ...extra] };
}

/** Centres of the densest dry, drivable forest cells. */
function forestSpots(world: World, env: SimEnv, max: number): { x: number; z: number; n: number }[] {
  const C = 16;
  const cells = new Map<number, { x: number; z: number; n: number }>();
  for (const ps of world.props) {
    if (!isTree(ps.kind)) continue;
    for (let j = 0; j < ps.count; j++) {
      const x = ps.data[j * PROP_STRIDE], z = ps.data[j * PROP_STRIDE + 2];
      const k = Math.floor(x / C) * 100000 + Math.floor(z / C);
      const c = cells.get(k);
      if (c) { c.x += x; c.z += z; c.n++; } else cells.set(k, { x, z, n: 1 });
    }
  }
  const out: { x: number; z: number; n: number }[] = [];
  for (const c of [...cells.values()].sort((a, b) => b.n - a.n)) {
    const x = c.x / c.n, z = c.z / c.n;
    if (waterAt(env, x, z) !== NO_WATER_Y) continue;
    // not a cliff: a few samples around within ±3 m of each other
    const h0 = terrainHeight(world, x, z);
    let ok = true;
    for (const [dx, dz] of [[8, 0], [-8, 0], [0, 8], [0, -8]]) if (Math.abs(terrainHeight(world, x + dx, z + dz) - h0) > 3.5) ok = false;
    if (!ok) continue;
    out.push({ x, z, n: c.n });
    if (out.length >= max) break;
  }
  return out;
}

function cmd(moveX: number, moveZ: number): InputCmd {
  return { seq: 0, moveX, moveZ, yaw: 0, pitch: 0, buttons: 0 };
}

/** Free spot near (x, z) for the scooter to start. */
function startAt(env: SimEnv, x: number, z: number): { x: number; y: number; z: number } | null {
  for (let r = 0; r < 8; r += 0.7) {
    for (let a = 0; a < 6.28; a += 0.8) {
      const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
      const g = probeGround(env, px, terrainHeight(env.world, px, pz) + 3, pz, 6);
      if (g === BLOCKED || g === -Infinity) continue;
      if (sdf(env.cw, px, g + 1.6, pz) > 0.75) return { x: px, y: g, z: pz };
    }
  }
  return null;
}

/** No water and no terrain steeper than the scooter climbs along the straight line (trees don't count). */
function drivableLine(env: SimEnv, x0: number, z0: number, x1: number, z1: number): boolean {
  const n = 45;
  let prev = terrainHeight(env.world, x0, z0);
  for (let i = 1; i <= n; i++) {
    const x = x0 + ((x1 - x0) * i) / n, z = z0 + ((z1 - z0) * i) / n;
    if (waterAt(env, x, z) !== NO_WATER_Y) return false;
    const h = terrainHeight(env.world, x, z);
    if (Math.abs(h - prev) > 0.55) return false;
    prev = h;
  }
  return true;
}

/**
 * Each trial: full throttle toward a point 45 m away, steering at it like a
 * player would. Stuck = moved < 1.5 m over any 1.5 s window.
 */
function drive(env: SimEnv, spots: { x: number; z: number }[], headings: number, steer: boolean): Stats {
  const st: Stats = { trials: 0, stuck: 0, bumps: 0, progress: 0, inside: 0 };
  for (const s of spots) {
    const p0 = startAt(env, s.x, s.z);
    if (!p0) continue;
    for (let h = 0; h < headings; h++) {
      const yaw0 = (h / headings) * Math.PI * 2 + 0.3;
      const tx = p0.x + Math.sin(yaw0) * 45, tz = p0.z + Math.cos(yaw0) * 45;
      if (!drivableLine(env, p0.x, p0.z, tx, tz)) continue;
      const v = createVehicleState(0, { kind: VehicleKind.Vespa, x: p0.x, y: p0.y, z: p0.z, rotY: yaw0 }, env);
      const hist: { x: number; z: number }[] = [];
      let stuck = false;
      const W = Math.round(1.5 / TICK_DT);
      for (let i = 0; i < 12 / TICK_DT; i++) {
        let mx = 0;
        if (steer) {
          let d = Math.atan2(tx - v.x, tz - v.z) - v.yaw;
          while (d > Math.PI) d -= Math.PI * 2;
          while (d < -Math.PI) d += Math.PI * 2;
          mx = -Math.max(-1, Math.min(1, d * 2));
        }
        const b = stepVehicle(v, cmd(mx, 1), TICK_DT, env);
        if (b > 0) st.bumps++;
        if (sdf(env.cw, v.x, v.y + 0.75, v.z) < 0.05) st.inside++;
        hist.push({ x: v.x, z: v.z });
        if (hist.length > W) {
          const o = hist[hist.length - 1 - W];
          if (Math.hypot(v.x - o.x, v.z - o.z) < 1.5) stuck = true;
        }
        if (Math.hypot(tx - v.x, tz - v.z) < 3) break;
      }
      const d0 = 45, d1 = Math.hypot(tx - v.x, tz - v.z);
      st.progress += Math.max(0, d0 - d1) / d0;
      st.trials++;
      if (stuck) st.stuck++;
    }
  }
  st.progress /= Math.max(1, st.trials);
  return st;
}

const SEEDS = [42, 7, 1234];
const worlds: { seed: number; env: SimEnv; env2: SimEnv; spots: { x: number; z: number; n: number }[] }[] = [];

beforeAll(() => {
  for (const seed of SEEDS) {
    const world = generateWorld(seed, { skipDecor: true });
    const env = createEnv(world);
    const spots = forestSpots(world, env, 8);
    worlds.push({ seed, env, env2: createEnv(doubleTrees(world)), spots });
  }
}, 120_000);

describe("vespa in the forest", () => {
  it("drives through dense forest without getting stuck", () => {
    const tot = { steer: [0, 0, 0], steer2: [0, 0, 0], straight2: [0, 0, 0] };
    const add = (t: number[], s: Stats) => { t[0] += s.trials; t[1] += s.stuck; t[2] += s.progress * s.trials; };
    for (const w of worlds) {
      const a = drive(w.env, w.spots, 8, true);
      const b = drive(w.env2, w.spots, 8, true);
      const c = drive(w.env2, w.spots, 8, false);
      const f = (s: Stats) => `stuck ${s.stuck}/${s.trials} progress ${(s.progress * 100).toFixed(0)}% bumps ${s.bumps} insideTicks ${s.inside}`;
      console.log(`seed ${w.seed} (densest ${w.spots[0]?.n} trees per 16 m cell)\n  steer       ${f(a)}\n  steer 2x    ${f(b)}\n  straight 2x ${f(c)}`);
      add(tot.steer, a); add(tot.steer2, b); add(tot.straight2, c);
      // never ends up inside a trunk / rock
      expect(a.inside + b.inside + c.inside).toBeLessThan(40);
    }
    console.log("total [trials, stuck, progress]", JSON.stringify(tot));
    expect(tot.steer[0]).toBeGreaterThan(40);
    // before the glancing / slide collision: ~80% of steered runs got stuck (~95% with 2x trees)
    expect(tot.steer[1] / tot.steer[0]).toBeLessThan(0.2);
    expect(tot.steer2[1] / tot.steer2[0]).toBeLessThan(0.3);
    expect(tot.steer[2] / tot.steer[0]).toBeGreaterThan(0.8);
    expect(tot.steer2[2] / tot.steer2[0]).toBeGreaterThan(0.75);
  }, 120_000);
});
