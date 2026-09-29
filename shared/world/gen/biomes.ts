// Stage 8: moisture and biomes. Moisture comes from fresh water, the sea
// breeze and the rain shadow of the prevailing wind; biomes from height,
// slope, moisture, coast distance and the sites' village ground.
import { Noise } from "../../math/noise";
import type { Rng } from "../../math/rng";
import { clamp01, smoothstep } from "../../math/vec";
import type { Ctx } from "../context";
import { gx, N, NN, sample, slopeGrid } from "../grid";
import { Biome, NO_WATER } from "../types";
import { up4, H4 } from "./elevation";
import { BLOCK_VILLAGE } from "./sites";

export function biomesStage(ctx: Ctx, rng: Rng): void {
  const h = ctx.height;
  slopeGrid(h, ctx.slope);
  const noise = new Noise(rng.fork("moistNoise"));
  const bn = new Noise(rng.fork("biomeNoise"));

  // rain shadow on the 4 m grid
  const shadow = new Float32Array(H4 * H4);
  const wx = ctx.windX, wz = ctx.windZ; // wind blows toward (wx, wz)
  for (let iz = 0; iz < H4; iz++)
    for (let ix = 0; ix < H4; ix++) {
      const x = -512 + ix * 4, z = -512 + iz * 4;
      const h0 = sample(h, x, z);
      if (h0 <= 0) continue;
      let s = 0;
      for (let k = 1; k <= 14; k++) {
        const d = k * 18;
        const v = sample(h, x - wx * d, z - wz * d) - h0 - d * 0.12;
        if (v > s) s = v;
      }
      // windward slopes get an orographic bonus (negative shadow)
      const gxv = sample(h, x + 4, z) - sample(h, x - 4, z), gzv = sample(h, x, z + 4) - sample(h, x, z - 4);
      const facing = -(gxv * wx + gzv * wz) / 8; // >0 when the slope faces the wind
      shadow[iz * H4 + ix] = clamp01(s / 45) - clamp01(facing * 1.5) * 0.35;
    }

  let peakH = 0;
  for (let i = 0; i < NN; i++) if (h[i] > peakH) peakH = h[i];
  const rockLine = Math.max(70, peakH * 0.74);

  for (let iz = 0; iz < N; iz++)
    for (let ix = 0; ix < N; ix++) {
      const i = iz * N + ix;
      const x = gx(ix), z = gx(iz);
      const hv = h[i];
      const c = ctx.coast[i];
      const wd = ctx.waterDist[i];
      // moisture
      const nz = noise.fbm(x / 140, z / 140, 3);
      let m = 0.46 + 0.4 * (1 - smoothstep(0, 110, wd)) + 0.12 * (1 - smoothstep(0, 180, c)) - 0.5 * up4(shadow, ix, iz) + 0.28 * nz - Math.max(0, hv - 60) * 0.004;
      m = clamp01(m);
      ctx.moisture[i] = Math.round(m * 255);

      // biome
      let b: Biome;
      const s = ctx.slope[i];
      const bnz = bn.fbm(x / 45, z / 45, 2);
      const inWater = ctx.water[i] !== NO_WATER && ctx.water[i] > hv - 0.05;
      if (hv < 0 && !inWater) {
        b = hv < -6 ? Biome.DeepOcean : Biome.Shallows;
      } else if (inWater) {
        b = Biome.Riverbank;
      } else if (s > 1.05) {
        b = Biome.Cliff;
      } else if (ctx.blocked[i] & BLOCK_VILLAGE) {
        b = Biome.Village;
      } else if (c < 11 + 10 * bnz + 12 * (1 - ctx.cliff[i]) && hv < 2.9 && s < 0.3 && ctx.cliff[i] < 0.55) {
        b = Biome.Beach;
      } else if (hv < 2.6 && m > 0.55 && ((ctx.shelter[i] > 0.62 && c < 45) || (wd < 22 && c < 70)) && bnz > -0.25) {
        b = Biome.Mangrove;
      } else if (wd < 5 + 3 * bnz) {
        b = Biome.Riverbank;
      } else if (hv > rockLine + 14 * bnz || s > 0.92 + 0.1 * bnz) {
        b = Biome.Rock;
      } else if (c < 55 + 25 * bnz && hv < 16 && m > 0.3) {
        b = Biome.PalmGrove;
      } else if (m > 0.56 + 0.08 * bnz && hv < 100) {
        b = Biome.Jungle;
      } else if (m < 0.3 + 0.06 * bnz || (hv > rockLine * 0.75 && m < 0.42)) {
        b = Biome.Scrub;
      } else {
        b = Biome.Meadow;
      }
      ctx.biome[i] = b;
    }
}
