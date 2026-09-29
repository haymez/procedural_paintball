// Difficulty presets and personalities. A bot's final tuning = difficulty
// preset (skill: senses, aim, reactions) x personality (taste: what it wants
// to do) x a few per-bot random tweaks, so no two bots feel identical.
import { Rng } from "../../math/rng";
import { PickupKind } from "../../world/types";
import { BotDifficulty, PERSONALITIES, type PersonalityName } from "./types";

/** Skill knobs (scaled by difficulty). Angles in radians, times in seconds. */
export interface Skill {
  /** Time to notice a clearly visible target at ~20 m (grows with distance, shrinks if it moves / shoots). */
  reaction: number;
  /** Half field of view for spotting (targets closer than 5 m are always sensed). */
  fovHalf: number;
  viewRange: number;
  /** Hearing radius for shots (m). */
  hearRange: number;
  /** Seconds a lost target stays "known". */
  memory: number;
  /** Aim spring natural frequency (rad/s) and damping ratio (< 1 overshoots). */
  aimFreq: number;
  aimDamp: number;
  /** Max crosshair angular speed (rad/s). */
  turnSpeed: number;
  /** Base aim error (rad) on a fresh target. */
  aimErr: number;
  /** Fraction of the error left after fully settling on a target. */
  settleFloor: number;
  /** Seconds holding on a target to settle. */
  settleTime: number;
  /** Tracking feed-forward (0..1): how well the crosshair keeps pace with a moving target. */
  track: number;
  /** Fraction of the true lead used (with noise). */
  lead: number;
  leadNoise: number;
  /** Velocity estimate smoothing rate (1/s): low = laggy lead. */
  velTrack: number;
  burstMin: number;
  burstMax: number;
  pauseMin: number;
  pauseMax: number;
  /** Chance to aim down sights (ADS) when shooting beyond ~15 m. */
  ads: number;
  /** Strafe while shooting (0..1). */
  strafe: number;
  /** Fraction of strafing dropped while bursting at mid range (stop and shoot). */
  plant: number;
  /** Probability-ish of smart tactics: cover, flanks, washing early, tactical reloads. */
  tactics: number;
  /** Seconds between decisions. */
  thinkEvery: number;
  /** Max engagement range (m). */
  maxRange: number;
}

const SKILLS: Record<BotDifficulty, Skill> = {
  [BotDifficulty.Easy]: {
    reaction: 0.85, fovHalf: 1.25, viewRange: 55, hearRange: 55, memory: 3,
    aimFreq: 6.5, aimDamp: 0.5, turnSpeed: 3.2, aimErr: 0.06, settleFloor: 0.6, settleTime: 1.8, track: 0.35,
    lead: 0.45, leadNoise: 0.4, velTrack: 3,
    burstMin: 2, burstMax: 3, pauseMin: 0.9, pauseMax: 1.8, ads: 0.15, strafe: 0.2, tactics: 0.2, plant: 0.15,
    thinkEvery: 0.4, maxRange: 38,
  },
  [BotDifficulty.Normal]: {
    reaction: 0.5, fovHalf: 1.45, viewRange: 72, hearRange: 70, memory: 5,
    aimFreq: 10, aimDamp: 0.6, turnSpeed: 5.5, aimErr: 0.04, settleFloor: 0.45, settleTime: 1.2, track: 0.65,
    lead: 0.75, leadNoise: 0.22, velTrack: 5,
    burstMin: 3, burstMax: 5, pauseMin: 0.5, pauseMax: 1.1, ads: 0.5, strafe: 0.45, tactics: 0.55, plant: 0.45,
    thinkEvery: 0.28, maxRange: 46,
  },
  [BotDifficulty.Hard]: {
    reaction: 0.3, fovHalf: 1.65, viewRange: 88, hearRange: 85, memory: 7,
    aimFreq: 14, aimDamp: 0.7, turnSpeed: 8.5, aimErr: 0.024, settleFloor: 0.28, settleTime: 0.75, track: 0.9,
    lead: 0.94, leadNoise: 0.1, velTrack: 9,
    burstMin: 3, burstMax: 7, pauseMin: 0.28, pauseMax: 0.65, ads: 0.85, strafe: 0.6, tactics: 0.85, plant: 0.7,
    thinkEvery: 0.2, maxRange: 52,
  },
};

/** Taste knobs (0..1 unless noted). */
export interface Personality {
  name: PersonalityName;
  /** Push fights, chase, roam toward action. */
  aggression: number;
  /** Take cover, retreat, wash early. */
  caution: number;
  /** Visit pickups, POIs, ziplines, vehicles. */
  curiosity: number;
  /** Hold a spot (perch / hide) and wait. */
  patience: number;
  /** Preferred fighting distance (m). */
  range: number;
  vehicleLove: number;
  zipLove: number;
  /** Upgrade wish list weights by PickupKind. */
  wants: number[];
}

const BASE: Record<PersonalityName, Omit<Personality, "name">> = {
  aggressive: {
    aggression: 0.9, caution: 0.25, curiosity: 0.35, patience: 0.1, range: 14, vehicleLove: 0.4, zipLove: 0.5,
    wants: [0, 0.8, 1, 0.2, 0.1, 0.7, 0.8, 0.2],
  },
  sneaky: {
    aggression: 0.4, caution: 0.75, curiosity: 0.3, patience: 0.8, range: 22, vehicleLove: 0.15, zipLove: 0.3,
    wants: [0, 0.6, 0.5, 0.4, 0.4, 0.9, 0.4, 0.8],
  },
  explorer: {
    aggression: 0.5, caution: 0.45, curiosity: 0.95, patience: 0.2, range: 18, vehicleLove: 0.9, zipLove: 1,
    wants: [0, 0.7, 0.7, 0.6, 0.5, 0.7, 0.9, 0.7],
  },
  sniper: {
    aggression: 0.35, caution: 0.6, curiosity: 0.4, patience: 0.7, range: 34, vehicleLove: 0.25, zipLove: 0.6,
    wants: [0, 0.5, 0.3, 1, 1, 0.6, 0.3, 0.3],
  },
};

export interface BotConfig {
  difficulty: BotDifficulty;
  skill: Skill;
  pers: Personality;
}

function jitter(rng: Rng, v: number, amount: number, lo = 0, hi = 1): number {
  const r = v * (1 + (rng.next() * 2 - 1) * amount);
  return r < lo ? lo : r > hi ? hi : r;
}

export function clampDifficulty(d: number): BotDifficulty {
  return (d <= 0 ? 0 : d >= 2 ? 2 : Math.round(d)) as BotDifficulty;
}

/** Deterministic config for bot `id` in a match seeded `seed`. */
export function makeConfig(seed: number, id: number, difficulty: number, personality?: PersonalityName): BotConfig {
  const rng = new Rng(Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(id + 17, 0x85ebca6b)).fork("bot-config");
  const diff = clampDifficulty(difficulty);
  const name = personality ?? PERSONALITIES[rng.int(PERSONALITIES.length)];
  const b = BASE[name];
  const s = SKILLS[diff];
  // skill varies +-12 % per bot so a lobby of "normal" bots isn't uniform
  const skill: Skill = {
    ...s,
    reaction: jitter(rng, s.reaction, 0.15, 0.1, 3),
    aimErr: jitter(rng, s.aimErr, 0.15, 0.005, 1),
    aimFreq: jitter(rng, s.aimFreq, 0.12, 2, 40),
    turnSpeed: jitter(rng, s.turnSpeed, 0.12, 1, 20),
    lead: jitter(rng, s.lead, 0.15),
    settleTime: jitter(rng, s.settleTime, 0.15, 0.2, 5),
  };
  const pers: Personality = {
    name,
    aggression: jitter(rng, b.aggression, 0.2),
    caution: jitter(rng, b.caution, 0.2),
    curiosity: jitter(rng, b.curiosity, 0.2),
    patience: jitter(rng, b.patience, 0.25),
    range: jitter(rng, b.range, 0.15, 6, 60),
    vehicleLove: jitter(rng, b.vehicleLove, 0.3),
    zipLove: jitter(rng, b.zipLove, 0.3),
    wants: b.wants.map((w) => jitter(rng, w, 0.25)),
  };
  pers.wants[PickupKind.Ammo] = 0;
  return { difficulty: diff, skill, pers };
}
