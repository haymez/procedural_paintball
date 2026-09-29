// Where sky drops start: high over the middle of the island's land, clear of
// its highest peak. Computed once per world from the height grid (plain
// arithmetic, so server and clients agree).
import { CELL, GRID_RES, WORLD_HALF, type World } from "../world/types";
import { DROP_CLEARANCE, DROP_MAX_Y, DROP_MIN_Y, GLIDE_FLARE_SINK, GLIDE_FLARE_SPEED, GLIDE_SINK, GLIDE_SPEED } from "./constants";

export interface DropSite {
  /** Centroid of the land (m). */
  cx: number;
  cz: number;
  /** Drop altitude (feet). */
  y: number;
  /** Highest ground on the island. */
  maxH: number;
}

const cache = new WeakMap<World, DropSite>();

export function dropSite(world: World): DropSite {
  let d = cache.get(world);
  if (d) return d;
  const h = world.height;
  let sx = 0, sz = 0, n = 0, maxH = 0;
  for (let iz = 0; iz < GRID_RES; iz += 4) {
    for (let ix = 0; ix < GRID_RES; ix += 4) {
      const y = h[iz * GRID_RES + ix];
      if (y > maxH) maxH = y;
      if (y > 0.5) { sx += ix; sz += iz; n++; }
    }
  }
  const cx = n ? -WORLD_HALF + (sx / n) * CELL : 0;
  const cz = n ? -WORLD_HALF + (sz / n) * CELL : 0;
  const y = Math.min(DROP_MAX_Y, Math.max(DROP_MIN_Y, maxH + DROP_CLEARANCE));
  d = { cx, cz, y, maxH };
  cache.set(world, d);
  return d;
}

/** How far (m) a glider `height` m above the ground can still get: neutral and flared. */
export function glideReach(height: number): { neutral: number; flare: number } {
  const h = height > 0 ? height : 0;
  return { neutral: (h / GLIDE_SINK) * GLIDE_SPEED, flare: (h / GLIDE_FLARE_SINK) * GLIDE_FLARE_SPEED };
}
