// World generation pipeline. Pure and bit-deterministic (see AGENTS.md):
// every stage draws from its own named RNG stream forked from the seed.
import { Rng } from "../math/rng";
import type { Ctx } from "./context";
import { NN } from "./grid";
import { NO_WATER, type GenerateOptions, type World } from "./types";
import { coastStage } from "./gen/coast";
import { composeCoarse, composeFine, inlandFields } from "./gen/elevation";
import { dropletErosion, streamPower, terraceStage, thermal } from "./gen/erosion";
import { coveBeds, seaStacks } from "./gen/coast";
import { hydrologyStage } from "./gen/hydrology";
import { cavesStage } from "./gen/caves";
import { sitesStage } from "./gen/sites";
import { pathsStage } from "./gen/paths";
import { trapsStage } from "./gen/traps";
import { biomesStage } from "./gen/biomes";
import { propsStage } from "./gen/props";
import { gameplayStage } from "./gen/gameplay";
import { namesStage } from "./gen/names";
import { cos, sin, TAU } from "../math/trig";
import { pickCharacter } from "./gen/character";

export const STAGES = [
  "coast", "elevation", "erosion", "hydrology", "caves", "sites", "paths", "traps", "biomes", "props", "gameplay", "names",
] as const;

function newCtx(seed: number, skipDecor: boolean): Ctx {
  return {
    seed, rng: new Rng(seed), skipDecor, archetype: "volcano", ch: pickCharacter(new Rng(seed).fork("character")), peaks: [], ridges: [], cx: 0, cz: 0,
    windDir: 0, windX: 0, windZ: 1,
    height: new Float32Array(NN), land: new Uint8Array(NN), coast: new Float32Array(NN),
    cliff: new Float32Array(NN), shelter: new Float32Array(NN), slope: new Float32Array(NN),
    water: new Float32Array(NN).fill(NO_WATER), flow: new Float32Array(NN * 2), biome: new Uint8Array(NN),
    moisture: new Uint8Array(NN), path: new Uint8Array(NN), holes: new Uint8Array(NN),
    accum: new Float32Array(NN), waterDist: new Float32Array(NN), blocked: new Uint8Array(NN), reach: new Uint8Array(NN),
    rivers: [], waterfalls: [], lakes: [], lakeCells: [], caves: [], paths: [], structures: [], sites: [], props: [],
    landmarks: [], pickups: [], vehicles: [], ziplines: [], spawns: [], name: "", usedNames: new Set(),
    bays: [], headlands: [], islets: [], stacks: [], coves: [],
  };
}

export function generateWorld(seed: number, opts: GenerateOptions = {}): World {
  seed = seed >>> 0;
  const ctx = newCtx(seed, !!opts.skipDecor);
  const root = ctx.rng;
  const progress = (stage: (typeof STAGES)[number]) => opts.onProgress?.(stage, STAGES.indexOf(stage) / STAGES.length);

  const sky = root.fork("sky");
  const timeOfDay = Math.round(sky.range(8, 17.5) * 100) / 100;
  ctx.windDir = sky.range(0, TAU);
  ctx.windX = sin(ctx.windDir);
  ctx.windZ = cos(ctx.windDir);

  progress("coast");
  coastStage(ctx, root.fork("coast"));

  progress("elevation");
  const erng = root.fork("elevation");
  const fields = inlandFields(ctx, erng);
  const h4 = composeCoarse(ctx, fields);

  progress("erosion");
  const xrng = root.fork("erosion");
  const delta = streamPower(ctx, h4, xrng.fork("stream"));
  composeFine(ctx, fields, delta, erng);
  dropletErosion(ctx, xrng.fork("drops"), 30000);
  thermal(ctx, 6, 1.1, 0.4);
  terraceStage(ctx, xrng.fork("terraces"));
  coveBeds(ctx);
  seaStacks(ctx, root.fork("coast").fork("stacks"));

  progress("hydrology");
  hydrologyStage(ctx, root.fork("hydrology"));

  progress("caves");
  cavesStage(ctx, root.fork("caves"));

  progress("sites");
  sitesStage(ctx, root.fork("sites"));

  progress("paths");
  pathsStage(ctx, root.fork("paths"));

  progress("traps");
  trapsStage(ctx, root.fork("traps"));

  progress("biomes");
  biomesStage(ctx, root.fork("biomes"));

  progress("props");
  propsStage(ctx, root.fork("props"));

  progress("gameplay");
  gameplayStage(ctx, root.fork("gameplay"));

  progress("names");
  namesStage(ctx, root.fork("names"));

  opts.onProgress?.("done", 1);
  return {
    seed, name: ctx.name, timeOfDay, windDir: ctx.windDir, archetype: ctx.archetype,
    climate: ctx.ch.climate, coastStyle: ctx.ch.coastStyle,
    height: ctx.height, water: ctx.water, flow: ctx.flow, biome: ctx.biome, moisture: ctx.moisture,
    path: ctx.path, holes: ctx.holes, rivers: ctx.rivers, waterfalls: ctx.waterfalls, lakes: ctx.lakes,
    caves: ctx.caves, paths: ctx.paths, structures: ctx.structures, props: ctx.props, landmarks: ctx.landmarks,
    pickups: ctx.pickups, vehicles: ctx.vehicles, ziplines: ctx.ziplines, spawns: ctx.spawns,
  };
}
