// Mutable state threaded through the generator stages.
import type { Rng } from "../math/rng";
import type {
  Cave, Lake, Landmark, Path, PickupSpawn, PropSet, River, SpawnPoint, Structure, VehicleSpawn,
  Waterfall, Zipline,
} from "./types";

export type ArchetypeKind =
  | "volcano"
  | "twinPeaks"
  | "spine"
  | "crescent"
  | "archipelago"
  | "horseshoe";

export interface Peak {
  x: number;
  z: number;
  h: number;
  r: number;
  /** 0 = rounded dome, 1 = sharp cone. */
  sharp: number;
  caldera?: number; // caldera radius (m) for volcanoes
}

export interface Ridge {
  pts: { x: number; z: number; h: number }[];
  width: number;
}

/** A place a site / feature was chosen, reused by later stages. */
export interface Site {
  kind: string;
  x: number;
  z: number;
  y: number;
  rot: number;
  radius: number;
  name?: string;
  structureIds: number[];
  /** Local points of interest (interior spots, tower tops) for pickups. */
  spots: { x: number; y: number; z: number; tag: string }[];
  /** Where paths should connect to (door side). */
  door: { x: number; z: number };
}

export interface Ctx {
  seed: number;
  rng: Rng;
  skipDecor: boolean;
  archetype: ArchetypeKind;
  peaks: Peak[];
  ridges: Ridge[];
  /** Island center-ish (for radial logic). */
  cx: number;
  cz: number;
  windDir: number;
  windX: number;
  windZ: number;

  // grids
  height: Float32Array;
  /** Land mask from the coast stage (1 land). */
  land: Uint8Array;
  /** Signed coast distance in meters: + inland, - offshore. */
  coast: Float32Array;
  /** 0..1 how cliffy the coast is here. */
  cliff: Float32Array;
  /** 0..1 fraction of land in an ~90 m radius: high in bays / lagoons. */
  shelter: Float32Array;
  /** Slope magnitude, refreshed by stages that need it. */
  slope: Float32Array;
  water: Float32Array;
  flow: Float32Array;
  biome: Uint8Array;
  moisture: Uint8Array;
  path: Uint8Array;
  holes: Uint8Array;
  /** Flow accumulation (m² of catchment) from hydrology. */
  accum: Float32Array;
  /** Distance to fresh water (m), capped. */
  waterDist: Float32Array;
  /** Occupancy for scatter: bit 1 structure, 2 path, 4 cave mouth, 8 river/lake, 16 dock/boat. */
  blocked: Uint8Array;
  /** Main walkable region label (1 = main) filled by gameplay. */
  reach: Uint8Array;

  rivers: River[];
  waterfalls: Waterfall[];
  lakes: Lake[];
  lakeCells: Int32Array[];
  caves: Cave[];
  paths: Path[];
  structures: Structure[];
  sites: Site[];
  props: PropSet[];
  landmarks: Landmark[];
  pickups: PickupSpawn[];
  vehicles: VehicleSpawn[];
  ziplines: Zipline[];
  spawns: SpawnPoint[];
  name: string;
  usedNames: Set<string>;
  /** Named coastal features found during the coast stage. */
  bays: { x: number; z: number; size: number; mouthX: number; mouthZ: number }[];
  headlands: { x: number; z: number; score: number }[];
  islets: { x: number; z: number; r: number }[];
  stacks: { x: number; z: number; r: number; h: number }[];
}
