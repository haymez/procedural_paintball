// GameSource over the network: a thin adapter from the Game to NetClient.
import { type InputCmd, type InteractTarget, type PlayerState, type SimEnv, type SimEvent, type SimSnapshot } from "../../../../shared/sim/index";
import type { World } from "../../../../shared/world/types";
import type { GameSource } from "../source";
import type { NetClient } from "./client";

export class RemoteSource implements GameSource {
  readonly kind = "remote" as const;
  /** Varies by a few % so the server's input buffer stays small but never empty. */
  get tickDt(): number {
    return this.net.tickDt;
  }
  readonly world: World;
  readonly env: SimEnv;
  readonly localId: number;

  constructor(readonly net: NetClient) {
    this.world = net.world;
    this.env = net.env;
    this.localId = net.localId;
  }

  snapshot(): SimSnapshot {
    return this.net.snap;
  }
  me(): PlayerState | undefined {
    return this.net.me();
  }
  sendInput(cmd: InputCmd): void {
    this.net.input(cmd);
  }
  tick(): void {
    this.net.tick();
  }
  drainEvents(out: SimEvent[]): void {
    this.net.drain(out);
  }
  interactTarget(): InteractTarget | null {
    return this.net.interactTarget();
  }
  resync(): void {
    this.net.resync();
  }
  dispose(): void {}
}
