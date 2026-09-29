// Public shapes of the bot brain. The server's BotController seam lives in
// worker/room/bots.ts; these mirror it structurally so a BotBrain can be
// handed straight to setBotFactory() without shared/ importing worker code.
import type { InputCmd, MatchSim } from "../../sim/index";

/** Same numeric values as shared/net Difficulty (Easy 0, Normal 1, Hard 2). */
export const BotDifficulty = { Easy: 0, Normal: 1, Hard: 2 } as const;
export type BotDifficulty = (typeof BotDifficulty)[keyof typeof BotDifficulty];

export type PersonalityName = "aggressive" | "sneaky" | "explorer" | "sniper";
export const PERSONALITIES: readonly PersonalityName[] = ["aggressive", "sneaky", "explorer", "sniper"];

/** Structurally identical to worker/room/bots.ts BotController. */
export interface BotController {
  /** One cmd for `playerId` for the next sim step (dt = 1/60 s). Reuses its return object. */
  think(sim: MatchSim, playerId: number, dt: number): InputCmd;
  dispose?(): void;
}

/** Structurally compatible with worker/room/bots.ts BotSeatInfo (+ optional extras). */
export interface BotSeatInfo {
  id: number;
  name?: string;
  /** 0 easy, 1 normal, 2 hard (shared/net Difficulty). */
  difficulty: number;
  /** World / match seed: behavior is deterministic per (seed, id). */
  seed: number;
  /** Force a personality (default: picked from seed + id). */
  personality?: PersonalityName;
}

/** High-level activity. Index into BotStats.stateTime. */
export const St = {
  Dead: 0,
  Roam: 1,
  Engage: 2,
  Chase: 3,
  Cover: 4,
  Wash: 5,
  Ammo: 6,
  Upgrade: 7,
  Flank: 8,
  Perch: 9,
  Hide: 10,
  Investigate: 11,
  Ride: 12,
} as const;
export type St = (typeof St)[keyof typeof St];
export const ST_NAMES = [
  "dead", "roam", "engage", "chase", "cover", "wash", "ammo", "upgrade", "flank", "perch", "hide", "investigate", "ride",
] as const;
export const ST_COUNT = ST_NAMES.length;

/** Counters the harness reads (everything else comes from sim events). */
export interface BotStats {
  /** Seconds spent per St. */
  stateTime: Float64Array;
  /** Seconds flagged as stuck (no progress along a path). */
  stuckTime: number;
  stuckEvents: number;
  /** Longest single stuck episode (s). */
  stuckMax: number;
  replans: number;
  /** Horizontal meters moved while alive. */
  distance: number;
  /** Times the bot started firing at someone after >= 8 s of not firing. */
  fights: number;
  /** Shots fired with a target; per 10 m distance bucket (0-10, 10-20, ... 70+). */
  shotsAt: Float64Array;
  /** Last shot's target distance (m) and id — the harness joins them with hit events. */
  lastShotDist: number;
  lastShotTarget: number;
  lobs: number;
  vespaRides: number;
  boatRides: number;
  zipRides: number;
  dives: number;
}

export function newStats(): BotStats {
  return {
    stateTime: new Float64Array(ST_COUNT), stuckTime: 0, stuckEvents: 0, stuckMax: 0, replans: 0, distance: 0,
    fights: 0, shotsAt: new Float64Array(8), lastShotDist: 0, lastShotTarget: -1, lobs: 0, vespaRides: 0, boatRides: 0, zipRides: 0, dives: 0,
  };
}
