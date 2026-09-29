// Stage 0: island character. A handful of seed-picked knobs, independent of
// the archetype (the mountain skeleton), that make islands read differently:
// climate (lush rainforest island ... dry Mediterranean rock), coast style
// (long beaches, sheer cliffs, cliff-walled coves), relief (low and rolling
// ... tall and alpine) and vegetation zoning. Later stages read ctx.ch.
import type { Rng } from "../../math/rng";

export type Climate = "lush" | "tropical" | "mediterranean" | "dry";
export type CoastStyle = "beaches" | "cliffs" | "coves" | "mixed";

export interface Character {
  climate: Climate;
  coastStyle: CoastStyle;
  /** Multiplier on peak / ridge heights. */
  relief: number;
  /** Tableland: flatten the massif at this height (m), or 1e9. */
  plateau: number;
  /** Added to coastal cliffiness before its smoothstep (-0.4 .. +0.5). */
  cliffBias: number;
  /** Cliff-top height range (m) for cliffy coasts. */
  cliffTop: [number, number];
  /** Narrow inlets (calanques) cut into the coast. */
  coves: number;
  /** Added to moisture (0..1 scale). */
  moisture: number;
  /** Forest cover: shifts the moisture threshold for forest (+ = more forest). */
  forest: number;
  /** Width multiplier of the palm belt behind beaches. */
  palms: number;
  /** Altitude (m) below which wet forest is rainforest (Jungle); above it, Forest. */
  jungleTop: number;
  /** Fraction (0..1) of forest that is Mediterranean woodland even at low altitude. */
  woodland: number;
  /** Extra offshore islets. */
  islets: number;
}

export function pickCharacter(rng: Rng): Character {
  const climate = rng.weighted<Climate>(["lush", "tropical", "mediterranean", "dry"], [0.24, 0.3, 0.3, 0.16]);
  const coastStyle = rng.weighted<CoastStyle>(["beaches", "cliffs", "coves", "mixed"], [0.24, 0.24, 0.26, 0.26]);
  const reliefKind = rng.weighted([0, 1, 2], [0.26, 0.46, 0.28]);
  const relief = reliefKind === 0 ? rng.range(0.5, 0.7) : reliefKind === 1 ? rng.range(0.85, 1.05) : rng.range(1.1, 1.3);
  // cliff-ringed islands sometimes get a flat-topped tableland (Capri / Malta)
  const plateau = coastStyle === "cliffs" && rng.chance(0.45) ? rng.range(55, 85) : 1e9;

  let cliffBias = 0, cliffTop: [number, number] = [10, 32], coves = 0;
  switch (coastStyle) {
    case "beaches": cliffBias = -0.32; cliffTop = [8, 20]; coves = rng.intRange(0, 1); break;
    case "cliffs": cliffBias = 0.42; cliffTop = [26, 52]; coves = rng.intRange(1, 3); break;
    case "coves": cliffBias = 0.18; cliffTop = [16, 36]; coves = rng.intRange(4, 7); break;
    case "mixed": cliffBias = 0; cliffTop = [12, 34]; coves = rng.intRange(1, 3); break;
  }

  let moisture = 0, forest = 0, palms = 1, jungleTop = 60, woodland = 0;
  switch (climate) {
    case "lush": moisture = rng.range(0.1, 0.18); forest = rng.range(0.08, 0.14); palms = 0.9; jungleTop = 140; woodland = 0; break;
    case "tropical": moisture = rng.range(0.02, 0.08); forest = rng.range(0.02, 0.08); palms = 1.35; jungleTop = rng.range(45, 75); woodland = 0.1; break;
    case "mediterranean": moisture = rng.range(-0.08, -0.02); forest = rng.range(0.02, 0.1); palms = 0.6; jungleTop = rng.range(8, 20); woodland = 0.85; break;
    case "dry": moisture = rng.range(-0.2, -0.12); forest = rng.range(-0.04, 0.04); palms = 0.4; jungleTop = 0; woodland = 1; break;
  }
  return {
    climate, coastStyle, relief, plateau, cliffBias, cliffTop, coves, moisture, forest, palms, jungleTop, woodland,
    islets: rng.intRange(0, 3),
  };
}
