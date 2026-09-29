// Tuning for the bot world-knowledge layer (navigation + tactics). Movement
// numbers come from the sim's tuning file so the nav graph only offers moves
// the real player controller can perform.
import * as S from "../sim/constants";

/** Capsule radius used for clearance tests (sim BODY_R plus 1 cm: tight ruin stairs are built for the real body). */
export const AGENT_R = S.BODY_R + 0.01;
/** Standing capsule height used for clearance tests (the sim body). */
export const AGENT_H = S.BODY_H;
/** Legs step over anything lower than this. */
export const STEP_H = S.STEP_H;
/** Steepest terrain a grid node may sit on (rise / run). Sim: WALK_NY ≈ 46° ≈ 1.04. */
export const NODE_SLOPE = 1.0;
/** Steepest average grade along a walk edge (rise / run). */
export const EDGE_SLOPE = 1.0;
/** Highest ledge a mantle link climbs (sim MANTLE_MAX = 2.15 with a margin). */
export const MANTLE_MAX = 2.0;
/** A swimmer can mantle out onto a ledge this far above the water surface. */
export const SWIM_MANTLE = 1.0;
/** Longest drop onto land a jump-down link allows (no fall damage; > ~4.9 m stumbles). */
export const DROP_LAND = 8;
/** Drops above this stumble on landing (cost penalty). */
export const DROP_STUMBLE = 4.9;
/** Longest cliff jump into deep water. */
export const DROP_WATER = 45;
/** Water at least this deep lets a diver fully submerge (washing paint off). */
export const WASH_DEPTH = 1.8;
/** Deep water is kept as swim nodes up to this many grid cells from dry land. */
export const WATER_REACH = 15;

export const RUN_SPEED = S.RUN_SPEED;
export const SWIM_SPEED = S.SWIM_SPEED;
export const WADE_SPEED = S.RUN_SPEED * S.WADE_MULT;
export const SWIM_ENTER = S.SWIM_ENTER;
export const SWIM_DEPTH = S.SWIM_DEPTH;
export const JUMP_SPEED = S.JUMP_SPEED;
export const GRAVITY = S.GRAVITY;
export const FALL_MULT = S.FALL_MULT;
export const MAX_FALL = S.MAX_FALL;
export const EYE_H = S.EYE_H;
export const ZIP_FEET = S.ZIP_FEET;
export const ZIP_GRAB_R = S.ZIP_GRAB_R;
export const ZIP_MAX_SPEED = S.ZIP_MAX_SPEED;
export const BOAT_SPEED = S.ROWBOAT_SPEED;
export const INTERACT_R = S.INTERACT_R;
export const BALL_SPEED = S.BALL_SPEED;
export const BALL_GRAVITY = S.BALL_GRAVITY;
export const BALL_RADIUS = S.BALL_RADIUS;

/** Edge / waypoint actions: how to get from the previous waypoint to this one. */
export const Act = {
  Walk: 0,
  Wade: 1,
  Swim: 2,
  /** Jump into deep water (cliff jump, off a dock, down a waterfall). */
  Dive: 3,
  JumpDown: 4,
  Mantle: 5,
  Zipline: 6,
  /** Walking inside a cave tunnel / chamber. */
  Cave: 7,
  /** Row a boat across a bay (optional, see PathOptions.allow). */
  Vehicle: 8,
} as const;
export type Act = (typeof Act)[keyof typeof Act];
export type ActionName = "walk" | "wade" | "swim" | "dive" | "jump-down" | "mantle" | "zipline" | "cave" | "vehicle";
export const ACT_NAMES: readonly ActionName[] = ["walk", "wade", "swim", "dive", "jump-down", "mantle", "zipline", "cave", "vehicle"];
export const ACT_COUNT = 9;
/** Bitmask helper for PathOptions.allow. */
export const actBit = (a: Act) => 1 << a;
export const ALL_ACTS = (1 << ACT_COUNT) - 1;
/** Default: everything except vehicles (boats may have been moved or taken). */
export const DEFAULT_ACTS = ALL_ACTS & ~(1 << Act.Vehicle);

/** Node flags. */
export const NF = {
  /** Standing on dry ground / a floor. */
  Land: 1,
  /** Standing in shallow water (slower). */
  Wade: 2,
  /** Floating in deep water (y = surface - SWIM_DEPTH, the swimmer's feet). */
  Swim: 4,
  /** Under rock (cave tunnel or chamber). */
  Cave: 8,
  /** Fine node in a structure patch (0.5 m grid). */
  Struct: 16,
  /** Node of the 2 m terrain grid. */
  Coarse: 32,
  /** Deep enough to dive under and wash paint off. */
  Wash: 64,
} as const;
