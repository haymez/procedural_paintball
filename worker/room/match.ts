// The seam between the room (connections, lobby, phases) and the match
// simulation. The room never touches game state; it drives a MatchSim.
//
// Lifecycle, as the room calls it:
//
//   lobby --Start--> loading:   sim = createMatchSim(ctx); sim.onMatchStart(seed, setup)
//                               (may return a Promise, e.g. server world gen;
//                                the room waits for it AND every client's WorldReady)
//   loading -> playing:         sim.onPlayerEnter(p) for each ready human,
//                               then the room calls sim.tick() at 30 Hz
//   during playing:             sim.onInput(p, def, msg)   C2S ids >= 64
//                               sim.onPlayerEnter(p)       late joiner / reloaded tab finished loading
//                               sim.onPlayerLeave(p, why)  left, timed out, or reloading
//                               sim.onPlayerConnection(p, connected)  grace-window drop / return
//                               sim.onBotsChanged(bots)    a late human bumped a bot
//   timer / host ends match:    rows = sim.results(); sim.dispose()   -> results
//   host aborts:                sim.dispose()                         -> lobby
//
// Keep this file free of Workers globals: tests import it under Node.

import type { MsgDef, ResultRow, RoomSettings } from "../../shared/net/index";
import { MatchHost, type HostOptions } from "./host";

export interface SimPlayer {
  readonly id: number;
  readonly name: string;
  readonly color: number;
}

export interface BotSeat {
  readonly id: number;
  readonly name: string;
  readonly color: number;
}

export interface MatchSetup {
  seed: number;
  settings: RoomSettings;
  /** Humans in the room at start (some may still be loading). */
  humans: SimPlayer[];
  bots: BotSeat[];
}

/** What the room gives the sim. */
export interface MatchContext {
  /** Server clock, ms. */
  now(): number;
  /** Broadcast to every human currently in the match (status Ready, connected). */
  broadcast<T>(def: MsgDef<T>, msg: T): void;
  /** Send to one player; false if they are gone. */
  send<T>(playerId: number, def: MsgDef<T>, msg: T): boolean;
  /** End the match now (e.g. score limit). Results come from results(). */
  endMatch(): void;
  log(...args: unknown[]): void;
}

export interface MatchSim {
  /** Called once when loading begins. Resolve when the server-side world is ready. */
  onMatchStart(seed: number, setup: MatchSetup): void | Promise<void>;
  /** Optional expected world checksum; clients reporting another value get a warning. */
  worldChecksum?(): number | null;
  onPlayerEnter(p: SimPlayer): void;
  onPlayerLeave(p: SimPlayer, reason: "left" | "timeout" | "reload"): void;
  onPlayerConnection(p: SimPlayer, connected: boolean): void;
  onBotsChanged(bots: BotSeat[]): void;
  onInput(p: SimPlayer, def: MsgDef<unknown>, msg: unknown): void;
  /** Fixed step: dt is always 1/TICK_HZ seconds; `tick` counts from 0 at match start. */
  tick(tick: number, dt: number): void;
  results(): ResultRow[];
  dispose(): void;
}

/** The real match host (worker/room/host.ts). `debug` enables DebugCmd (local dev only). */
export function createMatchSim(ctx: MatchContext, opts: HostOptions = {}): MatchSim {
  return new MatchHost(ctx, opts);
}
