// Zipline cable shape shared by the generator's clearance checks. Mirrors
// shared/sim/env.ts zipPoint() (sag 3 % of length plus the rider's weight
// dip), so the rider path the sim follows is the one validated here.
import type { Zipline } from "./types";

export const ZIP_SAG = 0.03;
/** Feet of a hanging rider below the cable. */
export const ZIP_RIDER_FEET = 2.27;

/** Cable height at parameter t in [0, 1] from a (top) to b. */
export function zipCableY(z: Zipline, t: number): number {
  const dx = z.bx - z.ax, dy = z.by - z.ay, dz = z.bz - z.az;
  const L = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return z.ay + dy * t - L * ZIP_SAG * 4 * t * (1 - t) - L * 0.035 * 2 * Math.sqrt(t * (1 - t));
}
