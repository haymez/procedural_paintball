// Plain-data shapes of the match simulation. Everything here is numbers,
// booleans and small arrays so state can be copied, rolled back (client
// prediction) and quantized into snapshots cheaply.
import type { PickupKind, VehicleKind } from "../world/types";

/** InputCmd.buttons bits. */
export const Btn = {
  Fire: 1,
  Aim: 2,
  Jump: 4,
  Crouch: 8,
  Sprint: 16,
  Reload: 32,
  Interact: 64,
} as const;

/** One fixed-rate (TICK_HZ) input sample. yaw/pitch are the AIM direction from the eye. */
export interface InputCmd {
  seq: number;
  /** -1..1, + = strafe right. */
  moveX: number;
  /** -1..1, + = forward. */
  moveZ: number;
  /** World yaw, 0 = +Z, facing = (sin yaw, 0, cos yaw). */
  yaw: number;
  /** + = up. */
  pitch: number;
  buttons: number;
}

export function emptyCmd(): InputCmd {
  return { seq: 0, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0 };
}

export const Move = {
  Ground: 0,
  Air: 1,
  Slide: 2,
  Dive: 3,
  Swim: 4,
  Underwater: 5,
  Mantle: 6,
  Vehicle: 7,
  Zipline: 8,
  Dead: 9,
  /** Sliding down a slope too steep to stand on. */
  SteepSlide: 10,
  /** Sky drop: spread out like a flying squirrel, gliding down onto the island (after every respawn). */
  Glide: 11,
  /** Sky drop landing: pancaked on the ground for SPLAT_TIME, then back up. */
  Splat: 12,
} as const;
export type MoveState = (typeof Move)[keyof typeof Move];

/** Movement-side things that happened during one stepPlayer (bitmask). */
export const Fx = {
  Jump: 1,
  Land: 2,
  LandHard: 4,
  Slide: 8,
  Dive: 16,
  Mantle: 32,
  WaterEnter: 64,
  BellyFlop: 128,
  Submerge: 256,
  Surface: 512,
  Gasp: 1024,
  SlideJump: 2048,
  ZipEnd: 4096,
  /** A sky drop touched down (splat on land, or the steep-slope / water variants). */
  SkyLand: 8192,
} as const;

/** Per-player state. The movement part is what stepPlayer reads and writes. */
export interface PlayerState {
  id: number;
  // ---- kinematics (feet position) -------------------------------------------
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  yaw: number;
  pitch: number;
  move: MoveState;
  /** Time in the current move state. */
  moveT: number;
  grounded: boolean;
  /** Ground normal under the feet (valid when grounded). */
  gnx: number; gny: number; gnz: number;
  coyote: number;
  jumpBuf: number;
  jumpHeld: boolean;
  /** Previous tick's buttons (edge detection). */
  prevButtons: number;
  sprinting: boolean;
  aiming: boolean;
  /** Sprint is unlimited: stamina stays 1 and exhausted false (kept for the wire format). */
  stamina: number;
  staminaDelay: number;
  exhausted: boolean;
  slideCd: number;
  stumble: number;
  /** Air: dive already used this jump. */
  dived: boolean;
  /** Mantle: start + target feet position. */
  mx0: number; my0: number; mz0: number;
  mx1: number; my1: number; mz1: number;
  mDur: number;
  /** Water surface at the feet column (or -1e9). */
  waterY: number;
  breath: number;
  gasp: number;
  wash: number;
  /** Seconds since the last coat landed (paint wears off, PAINT_WEAR_*); 0 while clean. */
  paintT: number;
  // ---- mounts ---------------------------------------------------------------
  vehicle: number; // vehicle id or -1
  seat: number;
  zip: number; // zipline index or -1
  zipT: number;
  zipV: number;
  // ---- combat ---------------------------------------------------------------
  alive: boolean;
  /** Shooter colors, oldest first; length = coats of paint. */
  coats: number[];
  coatBy: number[];
  upgrades: number; // bitmask of 1 << PickupKind
  hopper: number;
  reserve: number;
  reload: number;
  fireCd: number;
  shotSeq: number;
  shield: number;
  deadT: number;
  lastHitBy: number;
  lastKiller: number;
  score: number;
  deaths: number;
  style: number;
  streak: number;
  lastSeq: number;
}

export interface PlayerInfo {
  id: number;
  name: string;
  color: number;
  isBot: boolean;
}

export interface ProjectileState {
  id: number;
  owner: number;
  color: number;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  age: number;
}

export interface PickupState {
  id: number;
  kind: PickupKind;
  x: number; y: number; z: number;
  active: boolean;
  respawn: number;
  /** Dropped by an eliminated player: bitmask of upgrades; world pickups: 0. */
  drop: number;
  /** Dropped pickups vanish after this many seconds. */
  ttl: number;
}

export interface VehicleState {
  id: number;
  kind: VehicleKind;
  x: number; y: number; z: number;
  yaw: number;
  /** Forward speed (m/s). */
  speed: number;
  vy: number;
  /** -1..1, + = turning left. */
  steer: number;
  throttle: number;
  pitch: number;
  airborne: boolean;
  /** Player id per seat (0 = driver), -1 = empty. */
  seats: number[];
  idle: number;
  sx: number; sy: number; sz: number; syaw: number;
}

export interface ZiplineInfo {
  /** Top (start) and bottom anchors. */
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
  length: number;
}

export type SimEvent =
  | { type: "shot"; pid: number; proj: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; color: number }
  /** pred (network client only): 1 = my own ball hit someone as predicted here, not yet confirmed; 2 = the server's confirmation of a hit already shown as predicted. */
  | { type: "hit"; target: number; shooter: number; x: number; y: number; z: number; dx: number; dz: number; coats: number; color: number; pred?: number }
  | { type: "shield"; target: number; shooter: number; x: number; y: number; z: number }
  | { type: "vest"; target: number; shooter: number; x: number; y: number; z: number }
  /** surf: 0 terrain, 1 structure, 2 prop (trunks, boulders), 3 cave. */
  | { type: "splat"; proj: number; shooter: number; x: number; y: number; z: number; nx: number; ny: number; nz: number; color: number; r: number; surf: number }
  | { type: "splash"; proj: number; x: number; y: number; z: number; size: number }
  | { type: "projEnd"; proj: number }
  | { type: "elim"; victim: number; killer: number; x: number; y: number; z: number; tags: number; place: string; dist: number }
  | { type: "respawn"; pid: number; x: number; y: number; z: number }
  | { type: "pickup"; pid: number; pickup: number; kind: number; drop: number; x: number; y: number; z: number }
  | { type: "pickupSpawn"; pickup: number }
  | { type: "vehicleEnter"; pid: number; vehicle: number; seat: number }
  | { type: "vehicleExit"; pid: number; vehicle: number }
  | { type: "vehicleBump"; vehicle: number; speed: number }
  | { type: "vehicleReset"; vehicle: number }
  | { type: "zipStart"; pid: number; zip: number }
  | { type: "zipEnd"; pid: number; zip: number }
  | { type: "wash"; pid: number; coats: number; color: number }
  /** A coat wore off by itself (no water). */
  | { type: "wear"; pid: number; coats: number; color: number }
  | { type: "move"; pid: number; fx: number; x: number; y: number; z: number; speed: number }
  | { type: "reload"; pid: number }
  | { type: "reloaded"; pid: number }
  | { type: "empty"; pid: number }
  | { type: "join"; pid: number }
  | { type: "leave"; pid: number }
  | { type: "matchEnd" };

/** Style tags on eliminations (bitmask) — flavor in the kill feed. */
export const Style = {
  Airborne: 1,
  Longshot: 2,
  FromVehicle: 4,
  Zipline: 8,
  Swimmer: 16,
  Revenge: 32,
  Streak: 64,
  Sliding: 128,
} as const;

/** What the client renders from: the local sim exposes this directly; the network source will rebuild it. */
export interface SimSnapshot {
  tick: number;
  time: number;
  timeLeft: number;
  ended: boolean;
  players: readonly PlayerState[];
  info: ReadonlyMap<number, PlayerInfo>;
  projectiles: readonly ProjectileState[];
  pickups: readonly PickupState[];
  vehicles: readonly VehicleState[];
  ziplines: readonly ZiplineInfo[];
  spawns: readonly { x: number; y: number; z: number }[];
}
