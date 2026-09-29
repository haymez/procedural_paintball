// Lag compensation for slow projectiles: "what you saw is what you hit".
//
// A client renders other players ~interp-delay in the past and its own
// inputs reach the server ~half an RTT later, so at the server step where a
// cmd fires, the shooter was looking at targets from tick `view` (sent with
// the cmd). Rewind R = stepTick - view (capped at MAX_REWIND). The ball then
// flies in real server time, but every hit test of that ball — its whole
// flight — is made against targets as they were R ticks earlier. That is
// exactly the relation between the ball and the targets on the shooter's
// screen: both advance one tick per tick from the moment of firing. The aim
// ray that sets the marker's zero distance is rewound the same way.
//
// The cost lands on the target: they can be hit up to R ticks (≤ 250 ms)
// after they visually ducked behind cover on their own screen. Rewinding
// only happens for human shooters; bots have R = 0.
import { MAX_REWIND } from "../../shared/net/index";
import { createPlayerState, type MatchSim, type MoveState, type PlayerState } from "../../shared/sim/index";

const HIST = 32;
const TELEPORT2 = 5 * 5;

interface Sample {
  tick: number;
  x: number;
  y: number;
  z: number;
  move: MoveState;
  alive: boolean;
}

export class LagComp {
  private hist = new Map<number, Sample[]>();
  private rewindNow = new Map<number, number>();
  private projRewind = new Map<number, number>();
  private readonly view: PlayerState = createPlayerState(0);
  enabled = true;
  /** Stats: rewinds applied (ticks) for the tick window. */
  rewindSum = 0;
  rewindN = 0;

  constructor(private readonly sim: MatchSim) {}

  /** Record where everyone is at the end of a step. */
  record(): void {
    const t = this.sim.tick;
    for (const p of this.sim.players) {
      let h = this.hist.get(p.id);
      if (!h) this.hist.set(p.id, (h = []));
      let s: Sample;
      if (h.length >= HIST) s = h.shift()!;
      else s = { tick: 0, x: 0, y: 0, z: 0, move: 0, alive: false };
      s.tick = t; s.x = p.x; s.y = p.y; s.z = p.z; s.move = p.move; s.alive = p.alive;
      h.push(s);
    }
  }

  forget(id: number): void {
    this.hist.delete(id);
    this.rewindNow.delete(id);
  }

  /** Rewind (sim ticks) for `owner`'s cmd being stepped now. */
  setRewind(owner: number, ticks: number): void {
    const r = ticks > 0 ? Math.min(MAX_REWIND, ticks) : 0;
    this.rewindNow.set(owner, r);
  }

  rewindOf(owner: number): number {
    return this.rewindNow.get(owner) ?? 0;
  }

  /** A ball left play: stop tracking its rewind. */
  endProj(id: number): void {
    this.projRewind.delete(id);
  }

  readonly hook = (owner: number, proj: number, o: PlayerState): PlayerState | null => {
    if (!this.enabled) return o;
    let r = proj ? this.projRewind.get(proj) : undefined;
    if (r === undefined) {
      r = this.rewindNow.get(owner) ?? 0;
      if (proj) {
        this.projRewind.set(proj, r);
        if (r > 0) { this.rewindSum += r; this.rewindN++; }
      }
    }
    if (r <= 0) return o;
    return this.at(o, this.sim.tick - r);
  };

  /** Target state at (fractional) tick t, or null if it wasn't in play then. */
  at(o: PlayerState, t: number): PlayerState | null {
    const h = this.hist.get(o.id);
    if (!h || !h.length || t < h[0]!.tick) return o; // no history that far back: don't rewind
    // bracket samples; the live state stands in for the current tick
    let a: { x: number; y: number; z: number; move: MoveState; alive: boolean; tick: number } | null = null;
    let b: { x: number; y: number; z: number; move: MoveState; alive: boolean; tick: number } | null = null;
    for (let i = h.length - 1; i >= 0; i--) {
      if (h[i]!.tick <= t) {
        a = h[i]!;
        b = h[i + 1] ?? { tick: this.sim.tick, x: o.x, y: o.y, z: o.z, move: o.move, alive: o.alive };
        break;
      }
    }
    if (!a || !b) return o;
    const span = b.tick - a.tick;
    const f = span > 0 ? Math.min(1, Math.max(0, (t - a.tick) / span)) : 0;
    const near = f < 0.5 ? a : b;
    if (!a.alive || !b.alive) return near.alive ? this.fill(near, near, 0) : null;
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    if (dx * dx + dy * dy + dz * dz > TELEPORT2) return this.fill(near, near, 0);
    return this.fill(a, b, f);
  }

  private fill(a: { x: number; y: number; z: number; move: MoveState }, b: { x: number; y: number; z: number; move: MoveState }, f: number): PlayerState {
    const v = this.view;
    v.x = a.x + (b.x - a.x) * f;
    v.y = a.y + (b.y - a.y) * f;
    v.z = a.z + (b.z - a.z) * f;
    v.move = f < 0.5 ? a.move : b.move;
    v.alive = true;
    return v;
  }
}
