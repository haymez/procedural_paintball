// Throwaway island used only until the real generator lands, so rendering and
// gameplay work can start in parallel. Not deterministic across engines.
import {
  Biome, CELL, GRID_RES, NO_WATER, WORLD_HALF, type World,
} from "./types";

export function stubWorld(seed = 1): World {
  const n = GRID_RES * GRID_RES;
  const height = new Float32Array(n);
  const biome = new Uint8Array(n);
  const water = new Float32Array(n).fill(NO_WATER);
  for (let iz = 0; iz < GRID_RES; iz++) {
    for (let ix = 0; ix < GRID_RES; ix++) {
      const x = -WORLD_HALF + ix * CELL;
      const z = -WORLD_HALF + iz * CELL;
      const d = Math.hypot(x, z) / 420;
      const bumps = Math.sin(x * 0.013 + seed) * Math.cos(z * 0.017) * 18 + Math.sin(x * 0.05) * 3;
      const h = (1 - d * d) * 60 + bumps - 8;
      const i = iz * GRID_RES + ix;
      height[i] = h;
      biome[i] = h < -4 ? Biome.DeepOcean : h < 0 ? Biome.Shallows : h < 3 ? Biome.Beach : h < 25 ? Biome.Jungle : h < 45 ? Biome.Meadow : Biome.Rock;
    }
  }
  return {
    seed, name: "Isola Stub", timeOfDay: 11, windDir: 0.6,
    height, water, flow: new Float32Array(n * 2), biome,
    moisture: new Uint8Array(n).fill(128), path: new Uint8Array(n), holes: new Uint8Array(n),
    rivers: [], waterfalls: [], lakes: [], caves: [], paths: [], structures: [], props: [],
    landmarks: [], pickups: [], vehicles: [], ziplines: [], spawns: [{ x: 0, y: 50, z: 0 }],
  };
}
