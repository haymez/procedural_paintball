// Snapshot capture: a deep, plain-data copy of everything a client needs to
// render the match (and to reconcile its predicted player). The netcode phase
// quantizes these fields into shared/net/match.ts messages; field notes below
// say what each is for.
import { copyPlayerState, createPlayerState } from "./player";
import type { MatchSim } from "./match";
import type { PickupState, PlayerState, ProjectileState, VehicleState } from "./types";

export interface MatchSnapshot {
  tick: number;
  time: number;
  timeLeft: number;
  ended: boolean;
  /**
   * Full player states. For REMOTE players a client needs only:
   *   id x y z vx vy vz yaw pitch move moveT grounded sprinting aiming alive
   *   coats (colors) upgrades vehicle seat zip zipT zipV breath shield waterY
   *   mx0..mz1 mDur (mantle) score deaths style
   * For the LOCAL player (prediction / HUD) additionally everything stepPlayer
   * reads: coyote jumpBuf jumpHeld prevButtons stamina staminaDelay exhausted
   * slideCd stumble dived gasp wash gnx gny gnz, plus hopper reserve reload
   * fireCd shotSeq deadT lastSeq (ack for reconciliation).
   */
  players: PlayerState[];
  /** Balls in flight (clients extrapolate with BALL_GRAVITY between snapshots). */
  projectiles: ProjectileState[];
  /** Only id/active/respawn change after the start; drops (drop !== 0) come and go. */
  pickups: PickupState[];
  vehicles: VehicleState[];
}

export function captureSnapshot(sim: MatchSim): MatchSnapshot {
  return {
    tick: sim.tick,
    time: sim.time,
    timeLeft: Math.max(0, sim.duration - sim.time),
    ended: sim.ended,
    players: sim.players.map((p) => copyPlayerState(p, createPlayerState(p.id))),
    projectiles: sim.projectiles.map((b) => ({ ...b })),
    pickups: sim.pickups.map((k) => ({ ...k })),
    vehicles: sim.vehicles.map((v) => ({ ...v, seats: v.seats.slice() })),
  };
}

/** Write a captured player state back into a live one (client reconciliation). */
export function restorePlayer(dst: PlayerState, src: PlayerState): PlayerState {
  return copyPlayerState(src, dst);
}
