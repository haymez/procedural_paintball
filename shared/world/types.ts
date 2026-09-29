// The world contract. Everything that generates, renders, simulates or
// networks the island agrees on these shapes. Keep this file free of logic.
//
// Coordinates: meters, right-handed, +Y up. The world is a square centered on
// the origin spanning [-WORLD_HALF, WORLD_HALF] on X and Z. Sea level is y = 0.
// Grids are row-major: index = iz * GRID_RES + ix, sample (ix, iz) sits at
// x = -WORLD_HALF + ix * CELL, z = -WORLD_HALF + iz * CELL.
//
// A World must be structured-cloneable (plain objects, arrays, typed arrays)
// so it can be built in a Web Worker and transferred to the main thread.

export const WORLD_SIZE = 1024;
export const WORLD_HALF = WORLD_SIZE / 2;
export const GRID_RES = 513;
export const CELL = WORLD_SIZE / (GRID_RES - 1); // 2 m
export const SEA_LEVEL = 0;
/** Sentinel in World.water for "no fresh water here". */
export const NO_WATER = -1000;

export enum Biome {
  DeepOcean = 0,
  Shallows = 1, // reef / turquoise shelf
  Beach = 2,
  PalmGrove = 3,
  Jungle = 4,
  Mangrove = 5,
  Meadow = 6, // grassy highland, olive and umbrella-pine country
  Scrub = 7, // dry maquis on upper slopes
  Rock = 8, // bare peaks
  Cliff = 9, // steep faces (also assigned by slope)
  Riverbank = 10,
  Village = 11, // paved / packed earth around ruins
  Forest = 12, // Mediterranean woodland: holm oak and pine, shady needle/leaf-litter floor
}

export enum PropKind {
  Palm = 0,
  PalmLeaning = 1,
  Broadleaf = 2, // big canopy jungle tree
  UmbrellaPine = 3, // Mediterranean stone pine
  Cypress = 4,
  Olive = 5,
  Banana = 6,
  Fern = 7,
  Bush = 8,
  Bougainvillea = 9, // flowering bush, magenta
  Agave = 10,
  GrassTuft = 11,
  Flowers = 12,
  RockSmall = 13,
  RockMedium = 14,
  Boulder = 15,
  Driftwood = 16,
  Reed = 17,
  Mangrove = 18,
  LemonTree = 19,
  JungleGiant = 20, // emergent rainforest tree (kapok/fig): buttresses, high umbrella crown, lianas
  TreeFern = 21, // slender scaly trunk with a crown of arching fronds
  HolmOak = 22, // dense dark evergreen oak, the Mediterranean forest tree
  Pine = 23, // tall Aleppo pine: leaning trunk, tiered irregular crown
  Understory = 24, // big-leaf forest-floor plant (monstera / elephant ear / philodendron)
  Log = 25, // fallen mossy log (decor, walk over)
}

/**
 * Collision radius (m) at scale 1 for props that block movement and shots,
 * measured at the trunk / body. 0 = no collision (walk and shoot through).
 * Collision is a vertical capsule of this radius from the prop base up to
 * PROP_COLLIDER_HEIGHT * scale.
 */
export const PROP_COLLIDER_RADIUS: Record<PropKind, number> = {
  [PropKind.Palm]: 0.35,
  [PropKind.PalmLeaning]: 0.35,
  [PropKind.Broadleaf]: 0.8,
  [PropKind.UmbrellaPine]: 0.5,
  [PropKind.Cypress]: 0.6,
  [PropKind.Olive]: 0.45,
  [PropKind.Banana]: 0.25,
  [PropKind.Fern]: 0,
  [PropKind.Bush]: 0,
  [PropKind.Bougainvillea]: 0,
  [PropKind.Agave]: 0,
  [PropKind.GrassTuft]: 0,
  [PropKind.Flowers]: 0,
  [PropKind.RockSmall]: 0,
  [PropKind.RockMedium]: 0.9,
  [PropKind.Boulder]: 2.2,
  [PropKind.Driftwood]: 0,
  [PropKind.Reed]: 0,
  [PropKind.Mangrove]: 0.6,
  [PropKind.LemonTree]: 0.3,
  [PropKind.JungleGiant]: 1.2,
  [PropKind.TreeFern]: 0.2,
  [PropKind.HolmOak]: 0.45,
  [PropKind.Pine]: 0.35,
  [PropKind.Understory]: 0,
  [PropKind.Log]: 0,
};
export const PROP_COLLIDER_HEIGHT: Record<PropKind, number> = {
  [PropKind.Palm]: 8,
  [PropKind.PalmLeaning]: 8,
  [PropKind.Broadleaf]: 10,
  [PropKind.UmbrellaPine]: 7,
  [PropKind.Cypress]: 9,
  [PropKind.Olive]: 3,
  [PropKind.Banana]: 3,
  [PropKind.Fern]: 0,
  [PropKind.Bush]: 0,
  [PropKind.Bougainvillea]: 0,
  [PropKind.Agave]: 0,
  [PropKind.GrassTuft]: 0,
  [PropKind.Flowers]: 0,
  [PropKind.RockSmall]: 0,
  [PropKind.RockMedium]: 1.2,
  [PropKind.Boulder]: 3.5,
  [PropKind.Driftwood]: 0,
  [PropKind.Reed]: 0,
  [PropKind.Mangrove]: 4,
  [PropKind.LemonTree]: 2.5,
  [PropKind.JungleGiant]: 16,
  [PropKind.TreeFern]: 3.5,
  [PropKind.HolmOak]: 4,
  [PropKind.Pine]: 10,
  [PropKind.Understory]: 0,
  [PropKind.Log]: 0,
};

/** Instances of one prop kind. data is packed [x, y, z, rotY, scale] * count. */
export interface PropSet {
  kind: PropKind;
  count: number;
  data: Float32Array;
}
export const PROP_STRIDE = 5;

export enum Material {
  Stucco = 0, // pastel plaster; tint picked per structure
  Stone = 1, // rough fieldstone
  Brick = 2,
  Terracotta = 3, // roof tiles
  Wood = 4, // planks, docks, shutters
  WoodDark = 5,
  Metal = 6,
  Plaster = 7, // white-washed
}

/**
 * Structure geometry is a small set of analytic solids so that the renderer,
 * collision (SDF) and projectile tests all agree exactly.
 * All solids rotate about Y only.
 *  - box:      half extents (hx, hy, hz) around the center
 *  - wedge:    gable roof / ramp. Base is the box footprint (hx, hz) at cy - hy,
 *              ridge runs along local X at cy + hy. Solid below the two slopes.
 *  - cylinder: radius hx, half height hy (hz ignored)
 */
export type SolidShape = "box" | "wedge" | "cylinder";
export interface Solid {
  shape: SolidShape;
  cx: number;
  cy: number;
  cz: number;
  hx: number;
  hy: number;
  hz: number;
  rotY: number;
  mat: Material;
  /** Packed 0xRRGGBB tint multiplied into the material's base color. */
  tint: number;
}

export enum StructureKind {
  Cottage = 0, // ruined fisherman's house
  Hamlet = 1, // cluster of 2–4 ruined cottages around a tiny piazza
  Lighthouse = 2,
  Chapel = 3,
  Watchtower = 4,
  Boathouse = 5, // with a dock into a bay
  Dock = 6,
  VespaShed = 7,
  Bridge = 8, // footbridge over a stream
  Well = 9,
  Arch = 10, // lone ruined archway / aqueduct fragment
}

export interface Structure {
  id: number;
  kind: StructureKind;
  /** Anchor point (for labels, minimap icons, spawn scoring). */
  x: number;
  y: number;
  z: number;
  rotY: number;
  solids: Solid[];
  /** Walkable-only surfaces (e.g. dock planks you stand on, stairs) are still solids. */
}

export interface Landmark {
  /** Italian-flavored place name shown on the map and in the kill feed, e.g. "Faro Vecchio". */
  name: string;
  x: number;
  z: number;
  kind: "peak" | "bay" | "cove" | "village" | "ruin" | "lake" | "falls" | "cave" | "beach" | "point";
}

export interface RiverPoint {
  x: number;
  z: number;
  /** Water surface height. */
  y: number;
  width: number;
  depth: number;
}
export interface River {
  points: RiverPoint[]; // source -> mouth
}
export interface Waterfall {
  x: number;
  z: number;
  top: number;
  bottom: number;
  width: number;
  /** Direction the water falls toward, radians around Y (0 = +Z). */
  dir: number;
}
export interface Lake {
  level: number;
  /** Representative center for labels / audio. */
  x: number;
  z: number;
}

/** A cave is a graph of spherical nodes joined by tapered tubes. */
export interface CaveNode {
  x: number;
  y: number;
  z: number;
  r: number;
}
export interface Cave {
  nodes: CaveNode[];
  /** Pairs of node indices joined by a tapered tube (capsule with lerped radius). */
  edges: [number, number][];
  /** Where the cave breaks the terrain surface. dir points outward (unit, XZ). */
  entrances: { x: number; y: number; z: number; dx: number; dz: number }[];
}

export interface Path {
  points: { x: number; z: number }[];
  width: number;
}

export enum PickupKind {
  Ammo = 0,
  BigHopper = 1, // magazine capacity up
  RapidFire = 2, // fire rate up
  LongBarrel = 3, // muzzle velocity / range up
  Scope = 4, // zoom aim
  Vest = 5, // absorbs one coat of paint
  QuickFeet = 6, // move speed up
  Snorkel = 7, // longer breath
}
export interface PickupSpawn {
  kind: PickupKind;
  x: number;
  y: number;
  z: number;
}

export enum VehicleKind {
  /** 1 rider, very fast and nimble, hops off swells. (Wire value 0 was the rowboat.) */
  Jetski = 0,
  /** Riva-style runabout: driver + 2 passengers, planes bow-up. (Wire value 1 was the gondola.) */
  Speedboat = 1,
  Vespa = 2,
  /** Open-cockpit autogyro: 1 pilot, arcade flight. */
  Gyrocopter = 3,
}
/** Jetski / Speedboat: lives on the water. */
export function isBoat(kind: VehicleKind): boolean {
  return kind === VehicleKind.Jetski || kind === VehicleKind.Speedboat;
}
export interface VehicleSpawn {
  kind: VehicleKind;
  x: number;
  y: number;
  z: number;
  rotY: number;
}

export interface Zipline {
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
}

export interface SpawnPoint {
  x: number;
  y: number;
  z: number;
}

export interface World {
  seed: number;
  /** Island name, e.g. "Isola di Sant'Erasmo". */
  name: string;
  /** Hours, 8.0 (morning) – 17.5 (golden afternoon). */
  timeOfDay: number;
  /** Prevailing wind, radians around Y. */
  windDir: number;
  /** Island archetype picked by the generator (debug / map display), e.g. "volcano". */
  archetype?: string;
  /** Island character (debug / map display / renderer palette hints). */
  climate?: "lush" | "tropical" | "mediterranean" | "dry";
  coastStyle?: "beaches" | "cliffs" | "coves" | "mixed";

  // --- grids, GRID_RES * GRID_RES each ---------------------------------------
  /** Terrain surface height (m). Seabed is negative. */
  height: Float32Array;
  /** Fresh water surface height (lakes, rivers, pools) or NO_WATER. The sea is implicit at SEA_LEVEL. */
  water: Float32Array;
  /** River flow direction * speed (m/s), interleaved [vx, vz]. Zero where still. */
  flow: Float32Array;
  biome: Uint8Array;
  /** 0–255 moisture, drives foliage density and ground tint. */
  moisture: Uint8Array;
  /** 0–255 dirt-path coverage for ground shading. */
  path: Uint8Array;
  /** 1 where the terrain surface is cut away (cave mouths). */
  holes: Uint8Array;

  // --- features --------------------------------------------------------------
  rivers: River[];
  waterfalls: Waterfall[];
  lakes: Lake[];
  caves: Cave[];
  paths: Path[];
  structures: Structure[];
  props: PropSet[];
  landmarks: Landmark[];

  // --- gameplay --------------------------------------------------------------
  pickups: PickupSpawn[];
  vehicles: VehicleSpawn[];
  ziplines: Zipline[];
  spawns: SpawnPoint[];
}

export interface GenerateOptions {
  /** Called as each stage runs; t in [0, 1] is overall progress. */
  onProgress?: (stage: string, t: number) => void;
  /** Skip purely visual decoration (small props) — used by the server. */
  skipDecor?: boolean;
}
