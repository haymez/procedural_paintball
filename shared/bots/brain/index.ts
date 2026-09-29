// Bot brain: server bots that play like people.
//
//   prepareBotWorld(world, env.cw)          // once while the match loads (~200 ms, cached per World)
//   const bot = createBotBrain({ id, difficulty, seed, name })
//   sim.applyInput(id, bot.think(sim, id, TICK_DT))   // every sim step, before sim.step()
//
// createBotBrain() returns a BotController structurally identical to
// worker/room/bots.ts, so the server hook is one line:
//
//   setBotFactory((seat) => createBotBrain(seat));
//
// All bots of one MatchSim share a hub (planner, danger map, shot log) that
// advances itself on the first think() of each sim step.
import { BotBrain, type BrainOptions } from "./brain";
import type { BotController } from "./types";

export { BotBrain, type BrainOptions } from "./brain";
export { prepareBotWorld, getHub, setBotIgnore, BotHub, PATH_BUDGET } from "./hub";
export { makeConfig, type BotConfig, type Skill, type Personality } from "./config";
export { solveCrosshair, AimSpring } from "./aim";
export * from "./types";

export function createBotBrain(seat: BrainOptions): BotBrain & BotController {
  return new BotBrain(seat);
}
