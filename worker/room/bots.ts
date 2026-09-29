// Server bots. A BotController turns the sim state into one InputCmd per sim
// step, exactly like a human's client would. The default brain is
// shared/bots/brain; DummyBot (the sim's wandering Dummy) stays available via
// setBotFactory() for tests.
//
// Bots never get lag compensation (they see the present) and their cmds skip
// the network entirely.
import { Difficulty } from "../../shared/net/index";
import { Dummy } from "../../shared/sim/dummy";
import { createBotBrain } from "../../shared/bots/brain/index";
import type { InputCmd, MatchSim } from "../../shared/sim/index";

export interface BotController {
  /** One cmd for `playerId` for the next sim step (dt = 1/60 s). May reuse its return object. */
  think(sim: MatchSim, playerId: number, dt: number): InputCmd;
  dispose?(): void;
}

export interface BotSeatInfo {
  id: number;
  name: string;
  difficulty: Difficulty;
  /** World seed (deterministic per-match behavior). */
  seed: number;
}

export type BotFactory = (seat: BotSeatInfo) => BotController;

const AGGRESSION: Record<Difficulty, number> = {
  [Difficulty.Easy]: 0.2,
  [Difficulty.Normal]: 0.5,
  [Difficulty.Hard]: 0.9,
};

/** Placeholder brain: wander, hop, take potshots. */
export class DummyBot implements BotController {
  private readonly d: Dummy;
  constructor(seat: BotSeatInfo) {
    this.d = new Dummy(seat.id, seat.seed, AGGRESSION[seat.difficulty] ?? 0.5);
  }
  think(sim: MatchSim, _playerId: number, dt: number): InputCmd {
    return this.d.think(sim, dt);
  }
}

let factory: BotFactory = (seat) => createBotBrain(seat);

export function setBotFactory(f: BotFactory): void {
  factory = f;
}

export function createBot(seat: BotSeatInfo): BotController {
  return factory(seat);
}
