import { Biome } from "../../../shared/world/types";
import type { AmbienceBiome } from "./types";

/**
 * Map a world Biome to the ambience bucket it sounds like. Accumulate
 * `weights[ambienceBiome(b)] += w` over a few samples around the listener
 * (e.g. a 5×5 grid, 10 m apart) and normalise, then pass to setAmbience.
 */
export function ambienceBiome(b: Biome): AmbienceBiome {
  switch (b) {
    case Biome.DeepOcean:
    case Biome.Shallows:
    case Biome.Beach:
      return "beach";
    case Biome.PalmGrove:
    case Biome.Jungle:
    case Biome.Riverbank:
      return "jungle";
    case Biome.Mangrove:
      return "mangrove";
    case Biome.Meadow:
    case Biome.Scrub:
      return "meadow";
    case Biome.Rock:
    case Biome.Cliff:
      return "rock";
    case Biome.Village:
      return "village";
    default:
      return "meadow";
  }
}
