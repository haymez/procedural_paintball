// Static environment the sim steps against: the world, its collision
// structures and a few allocation-free queries built on shared/world/collide.
import { buildCollision, freshWater, sdf, sdfNormal, terrainHeight, type CollisionWorld, type Vec3 } from "../world/collide";
import { SEA_LEVEL, WORLD_HALF, type World } from "../world/types";
import { ZIP_SAG } from "./constants";
import type { ZiplineInfo } from "./types";

export interface SimEnv {
  world: World;
  cw: CollisionWorld;
  ziplines: ZiplineInfo[];
}

export const NO_WATER_Y = -1e9;
/** probeGround(): the start point is inside something solid. */
export const BLOCKED = 1e9;

export function createEnv(world: World, cw?: CollisionWorld): SimEnv {
  const ziplines: ZiplineInfo[] = world.ziplines.map((z) => {
    const top = z.ay >= z.by;
    const ax = top ? z.ax : z.bx, ay = top ? z.ay : z.by, az = top ? z.az : z.bz;
    const bx = top ? z.bx : z.ax, by = top ? z.by : z.ay, bz = top ? z.bz : z.az;
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    return { ax, ay, az, bx, by, bz, length: Math.sqrt(dx * dx + dy * dy + dz * dz) };
  });
  return { world, cw: cw ?? buildCollision(world), ziplines };
}

/** Open-water surface over (x, z), or NO_WATER_Y (dry land, or a cave under a hill). */
export function waterAt(env: SimEnv, x: number, z: number): number {
  if (x < -WORLD_HALF || z < -WORLD_HALF || x > WORLD_HALF || z > WORLD_HALF) return SEA_LEVEL;
  const ground = terrainHeight(env.world, x, z);
  const fresh = freshWater(env.world, x, z);
  const w = fresh > SEA_LEVEL ? fresh : SEA_LEVEL;
  if (ground < w) return w;
  // fresh water carved by rivers can sit slightly below the interpolated terrain on banks
  if (fresh > -1e8 && ground < fresh + 0.05) return fresh;
  return NO_WATER_Y;
}

export function dist(env: SimEnv, x: number, y: number, z: number): number {
  return sdf(env.cw, x, y, z);
}

const _n: Vec3 = { x: 0, y: 1, z: 0 };
export function normal(env: SimEnv, x: number, y: number, z: number): Vec3 {
  return sdfNormal(env.cw, x, y, z, _n);
}

/**
 * Sphere-trace straight down from (x, y0, z) at most maxDown meters.
 * Returns the surface height, -Infinity if nothing within range, or BLOCKED
 * if the start point is inside solid.
 */
export function probeGround(env: SimEnv, x: number, y0: number, z: number, maxDown: number): number {
  let y = y0;
  let d = sdf(env.cw, x, y, z);
  if (d < 0) return BLOCKED;
  for (let it = 0; it < 80; it++) {
    if (d < 0.008) return y - d;
    let step = d * 0.92;
    if (step < 0.006) step = 0.006;
    y -= step;
    if (y0 - y > maxDown) return -Infinity;
    d = sdf(env.cw, x, y, z);
    if (d < 0) {
      // overshot into a thin feature: back off by bisection
      let lo = y, hi = y + step;
      for (let k = 0; k < 6; k++) {
        const m = (lo + hi) * 0.5;
        if (sdf(env.cw, x, m, z) < 0) lo = m;
        else hi = m;
      }
      return hi;
    }
  }
  return -Infinity;
}

/** Zipline cable point (rider hangs below): straight line with the renderer's sag. */
export function zipPoint(z: ZiplineInfo, t: number, out: Vec3): Vec3 {
  out.x = z.ax + (z.bx - z.ax) * t;
  out.y = z.ay + (z.by - z.ay) * t - z.length * ZIP_SAG * 4 * t * (1 - t) - z.length * 0.035 * 2 * Math.sqrt(t * (1 - t));
  out.z = z.az + (z.bz - z.az) * t;
  return out;
}
