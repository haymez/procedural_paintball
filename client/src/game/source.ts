// Where the game's state comes from. The client renders only from a
// GameSource: `local` runs the authoritative MatchSim in the page (offline /
// listen server); a later `remote` source will receive snapshots + events from
// the Room DO, predict the local player with stepPlayer and interpolate others.
import type { World } from "../../../shared/world/types";
import { Dummy } from "../../../shared/sim/dummy";
import {
  MatchSim, createEnv, TICK_DT,
  type InputCmd, type InteractTarget, type SimEnv, type SimEvent, type SimSnapshot, type PlayerState,
} from "../../../shared/sim/index";
import { BLOB_COLORS } from "../render/actors/index";
import { dummyName } from "./names";

export interface GameSource {
  readonly kind: "local" | "remote";
  readonly world: World;
  /** Collision/water queries for camera, aim and prediction. */
  readonly env: SimEnv;
  readonly localId: number;
  /** Latest state to render (players, projectiles, pickups, vehicles…). */
  snapshot(): SimSnapshot;
  /** The local player's state (predicted for remote). */
  me(): PlayerState | undefined;
  /** Submit the local player's input for the next tick. */
  sendInput(cmd: InputCmd): void;
  /** Advance one fixed tick (local: step the sim; remote: predict). */
  tick(): void;
  /** Events since the last drain (appended to `out`). */
  drainEvents(out: SimEvent[]): void;
  /** What E would do for the local player. */
  interactTarget(): InteractTarget | null;
  readonly tickDt: number;
  /** After a stall (hidden tab, frozen frames): drop the backlog and rejoin the present. */
  resync?(): void;
  dispose(): void;
}

export interface LocalSourceOptions {
  localId?: number;
  name?: string;
  color?: number;
  dummies?: number;
  durationSec?: number;
}

/** Offline: the full match sim runs in the page, dummies drive themselves through InputCmds. */
export class LocalSource implements GameSource {
  readonly kind = "local" as const;
  readonly env: SimEnv;
  readonly sim: MatchSim;
  readonly localId: number;
  readonly tickDt = TICK_DT;
  readonly dummies: Dummy[] = [];
  dummiesActive = true;
  dummiesShoot = true;
  private pending: InputCmd | null = null;

  constructor(readonly world: World, opts: LocalSourceOptions = {}) {
    this.env = createEnv(world);
    this.sim = new MatchSim(world, { env: this.env, durationSec: opts.durationSec });
    this.localId = opts.localId ?? 1;
    this.sim.addPlayer(this.localId, { name: opts.name ?? "You", color: opts.color ?? BLOB_COLORS[0], isBot: false });
    const n = opts.dummies ?? 0;
    for (let i = 0; i < n; i++) this.addDummy();
  }

  addDummy(): number {
    const id = 100 + this.dummies.length;
    const i = this.dummies.length;
    this.sim.addPlayer(id, { name: dummyName(i), color: BLOB_COLORS[(i + 1) % BLOB_COLORS.length], isBot: true });
    this.dummies.push(new Dummy(id, this.world.seed, 0.35 + ((i * 37) % 10) / 20));
    return id;
  }

  snapshot(): SimSnapshot {
    return this.sim.snapshot();
  }

  me(): PlayerState | undefined {
    return this.sim.player(this.localId);
  }

  sendInput(cmd: InputCmd): void {
    this.pending = cmd;
  }

  tick(): void {
    if (this.pending) {
      this.sim.applyInput(this.localId, this.pending);
      this.pending = null;
    }
    for (const d of this.dummies) {
      if (!this.dummiesActive) {
        const p = this.sim.player(d.id);
        this.sim.applyInput(d.id, { seq: 0, moveX: 0, moveZ: 0, yaw: p?.yaw ?? 0, pitch: 0, buttons: p && !p.alive ? 128 : 0 });
        continue;
      }
      const c = d.think(this.sim, TICK_DT);
      if (!this.dummiesShoot) c.buttons &= ~1;
      this.sim.applyInput(d.id, { ...c });
    }
    this.sim.step(TICK_DT);
  }

  drainEvents(out: SimEvent[]): void {
    const ev = this.sim.events;
    for (let i = 0; i < ev.length; i++) out.push(ev[i]);
    ev.length = 0;
  }

  interactTarget(): InteractTarget | null {
    const p = this.me();
    return p ? this.sim.findInteract(p) : null;
  }

  dispose(): void {
    this.dummies.length = 0;
  }
}
