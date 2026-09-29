// Movement execution: turns a nav path into per-step movement intent
// (world-space direction + jump / crouch / interact), handles the special
// waypoint actions (mantle, jump-down, dive, zipline, boat), drives vehicles,
// and detects + recovers from getting stuck. Path searches go through the
// hub's budgeted planner so many bots re-planning never spike a tick.
import { atan2, wrapAngle } from "../../math/trig";
import {
  BLOCKED, INTERACT_R, Move, NO_WATER_Y, probeGround, waterAt, ZIP_GRAB_R,
  type MatchSim, type PlayerState, type VehicleState,
} from "../../sim/index";
import { VehicleKind, isBoat } from "../../world/types";
import { Act, actBit, DEFAULT_ACTS } from "../constants";
import type { PathOptions, PathResult, Waypoint } from "../path";
import { DangerMap } from "../tactics";
import type { Rng } from "../../math/rng";
import type { BotHub } from "./hub";
import type { BotStats } from "./types";

export interface MoveOut {
  /** Wished world-space move direction (unit) and magnitude 0..1. */
  dx: number;
  dz: number;
  mag: number;
  jump: boolean;
  crouch: boolean;
  interact: boolean;
  /** Sprinting is fine (open ground, not fighting). */
  sprint: boolean;
  /** Driving: raw vehicle controls replace dx/dz. */
  drive: boolean;
  throttle: number;
  /** + = steer right (cmd.moveX). */
  steer: number;
}

export function clearMove(o: MoveOut): MoveOut {
  o.dx = 0; o.dz = 0; o.mag = 0; o.jump = false; o.crouch = false; o.interact = false; o.sprint = false;
  o.drive = false; o.throttle = 0; o.steer = 0;
  return o;
}

export const NavStatus = { Idle: 0, Planning: 1, Moving: 2, Arrived: 3, Failed: 4 } as const;
export type NavStatus = (typeof NavStatus)[keyof typeof NavStatus];

const ARRIVE_R = 1.3;

/** Is it OK to step ~1.4 m in direction (dx, dz)? (no cliff, no deep water, not into a wall). */
export function safeStep(sim: MatchSim, p: PlayerState, dx: number, dz: number, reach = 1.4): boolean {
  const x = p.x + dx * reach, z = p.z + dz * reach;
  const g = probeGround(sim.env, x, p.y + 1.2, z, 3.2);
  if (g === BLOCKED || g === -Infinity) return false;
  if (p.y - g > 1.6) return false;
  const W = waterAt(sim.env, x, z);
  if (W !== NO_WATER_Y && W - g > 0.9 && p.move !== Move.Swim) return false;
  return true;
}

export class Navigator {
  status: NavStatus = NavStatus.Idle;
  path: Waypoint[] = [];
  wi = 0;
  gx = 0;
  gy = 0;
  gz = 0;
  arriveR = ARRIVE_R;
  private ticket = 0;
  private opts: PathOptions = {};
  private reqT = -1e9;
  // stuck
  private bestD = 1e9;
  private progT = 0;
  stuckLevel = 0;
  private stuckT = 0;
  private recoverT = 0;
  private recoverX = 0;
  private recoverZ = 0;
  private jumpCd = 0;
  private interactCd = 0;
  // special actions
  private zipTried = 0;
  private boardTries = 0;
  private wasZip = false;
  private wasVehicle = false;
  /** Vespa ride: vehicle id we are going for / riding, -1 = none. */
  vespa = -1;
  private vespaStuck = 0;
  private vespaStuckT = 0;
  private reverseT = 0;
  private driveT = 0;
  private driving = false;
  private pathT = 0;
  /** Per-bot map of trap spots (lazily created). */
  private avoid: DangerMap | null = null;
  private avoidT = 0;
  private trapT = -1e9;
  // progress watchdog: positions every 4 s
  private wdT = 0;
  private readonly wdX: number[] = [];
  private readonly wdZ: number[] = [];
  private readonly wdG: number[] = [];
  private steepT = 0;
  private offPathT = -1e9;
  private offPathN = 0;
  /** Total failed attempts on this goal (for the brain). */
  fails = 0;
  lastPlanOk = true;
  private readonly lastPos = { x: 0, z: 0 };

  constructor(private readonly hub: BotHub, private readonly rng: Rng, private readonly stats: BotStats) {}

  get hasGoal(): boolean {
    return this.status === NavStatus.Planning || this.status === NavStatus.Moving;
  }

  get busy(): boolean {
    return this.wasZip || this.wasVehicle || this.vespa >= 0;
  }

  distToGoal(p: PlayerState): number {
    const dx = this.gx - p.x, dz = this.gz - p.z;
    return Math.sqrt(dx * dx + dz * dz);
  }

  /**
   * Head for (x, y, z). Re-plans only if the goal moved more than `slack`
   * meters (or force), and at most once per second unless forced.
   */
  go(sim: MatchSim, p: PlayerState, x: number, y: number, z: number, opts: PathOptions = {}, arriveR = ARRIVE_R, slack = 3, force = false, tag = "go"): void {
    const moved = Math.abs(x - this.gx) + Math.abs(z - this.gz) + Math.abs(y - this.gy) * 0.5;
    this.arriveR = arriveR;
    if (!force) {
      // same goal: keep going (or stay arrived); a failed goal is retried at most every 2 s
      if ((this.hasGoal || this.status === NavStatus.Arrived) && moved < slack) return;
      if (this.status === NavStatus.Failed && moved < slack && sim.time - this.reqT < 2) return;
      if (this.hasGoal && sim.time - this.reqT < 1 && moved < 25) {
        this.gx = x; this.gy = y; this.gz = z;
        return;
      }
    }
    if (moved > slack) this.fails = 0;
    this.gx = x; this.gy = y; this.gz = z;
    this.opts = opts;
    if (this.hub.isTrap(x, y, z) && !this.hub.isTrap(p.x, p.y, p.z)) {
      // a pit with no way back out: don't go
      this.hub.cancel(this.ticket);
      this.ticket = 0;
      this.status = NavStatus.Failed;
      this.fails++;
      this.reqT = sim.time;
      return;
    }
    this.plan(sim, p, tag);
  }

  stop(): void {
    this.hub.cancel(this.ticket);
    this.ticket = 0;
    this.status = NavStatus.Idle;
    this.path = [];
    this.wi = 0;
    this.stuckLevel = 0;
    this.stuckT = 0;
  }

  /** Replan counts by cause (debug / harness). */
  static why: Record<string, number> = {};

  private plan(sim: MatchSim, p: PlayerState, why: string): void {
    Navigator.why[why] = (Navigator.why[why] ?? 0) + 1;
    this.hub.cancel(this.ticket);
    this.reqT = sim.time;
    this.status = NavStatus.Planning;
    this.stats.replans++;
    const from = { x: p.x, y: p.y, z: p.z };
    let opts = this.opts;
    if (this.avoid && sim.time - this.trapT < 120) {
      // steer around places where we got trapped (steep slides, snags) for a while
      this.avoid.decay(sim.time - this.avoidT);
      this.avoidT = sim.time;
      opts = { ...opts, danger: this.avoid, dangerWeight: 6 };
    }
    const t = this.hub.request(from, { x: this.gx, y: this.gy, z: this.gz }, opts, (r) => this.onPath(r));
    this.ticket = t;
  }

  private onPath(r: PathResult): void {
    this.ticket = 0;
    if (!r.ok && !r.partial || r.waypoints.length === 0) {
      this.status = NavStatus.Failed;
      this.lastPlanOk = false;
      this.fails++;
      this.path = [];
      this.wi = 0;
      return;
    }
    this.lastPlanOk = r.ok;
    this.path = r.waypoints;
    // start at the first node if we're not standing on it (knocked off the graph, on a steep slope)
    const w0 = this.path[0];
    const off0 = w0 ? Math.sqrt((w0.x - this.lastPos.x) ** 2 + (w0.z - this.lastPos.z) ** 2) : 0;
    this.wi = this.path.length > 1 && off0 < 2.5 ? 1 : 0;
    this.pathT = 0;
    this.status = NavStatus.Moving;
    this.bestD = 1e9;
    this.progT = 0;
    this.zipTried = 0;
    this.boardTries = 0;
  }

  /** Advance one step: fills `out` with movement intent. */
  step(sim: MatchSim, p: PlayerState, dt: number, out: MoveOut): void {
    clearMove(out);
    if (this.jumpCd > 0) this.jumpCd -= dt;
    if (this.interactCd > 0) this.interactCd -= dt;
    { const mx = p.x - this.lastPos.x, mz = p.z - this.lastPos.z; const m = Math.sqrt(mx * mx + mz * mz); if (m < 5) this.stats.distance += m; this.lastPos.x = p.x; this.lastPos.z = p.z; }
    if (this.watchdog(sim, p, dt)) return;

    // riding something?
    if (p.move === Move.Zipline) {
      if (!this.wasZip) this.stats.zipRides++;
      this.wasZip = true;
      return;
    }
    if (this.wasZip) {
      this.wasZip = false;
      // landed from a zipline: skip past the zipline waypoint
      for (let i = this.wi; i < this.path.length; i++) if (this.path[i].act === Act.Zipline) { this.wi = Math.min(i + 1, this.path.length - 1); break; }
      this.resetProgress();
    }
    if (p.move === Move.Vehicle) {
      this.wasVehicle = true;
      this.drive(sim, p, dt, out);
      return;
    }
    this.driving = false;
    if (this.wasVehicle) {
      this.wasVehicle = false;
      this.vespa = -1;
      if (this.hasGoal || this.status === NavStatus.Arrived) this.plan(sim, p, "vehicleExit");
      return;
    }
    if (p.move === Move.Mantle) return; // progress is judged after the climb
    if (p.move === Move.Underwater) out.jump = true; // swim up (washing is the brain's business)

    if (this.vespa >= 0 && this.approachVespa(sim, p, out)) return;

    if (this.status === NavStatus.Planning) {
      // the path is a tick or two away: drift toward the goal if it's close
      const dx = this.gx - p.x, dz = this.gz - p.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d > 0.5 && d < 20 && safeStep(sim, p, dx / d, dz / d)) { out.dx = dx / d; out.dz = dz / d; out.mag = 0.6; }
      return;
    }
    if (this.status !== NavStatus.Moving) return;

    // stuck recovery maneuvers
    if (this.recoverT > 0) {
      this.recoverT -= dt;
      out.dx = this.recoverX; out.dz = this.recoverZ; out.mag = 1;
      if (this.jumpCd <= 0 && p.grounded) { out.jump = true; this.jumpCd = 0.5; }
      this.stuckT += dt;
      this.stats.stuckTime += dt;
      return;
    }

    const path = this.path;
    let w = path[this.wi];
    // advance past reached waypoints
    for (let guard = 0; guard < 4 && w; guard++) {
      if (!this.reached(p, this.wi)) break;
      if (this.wi >= path.length - 1) {
        this.status = NavStatus.Arrived;
        this.endStuck();
        return;
      }
      this.wi++;
      w = path[this.wi];
      this.resetProgress();
    }
    if (!w) { this.status = NavStatus.Arrived; return; }

    const dx = w.x - p.x, dz = w.z - p.z, dy = w.y - p.y;
    const hd = Math.sqrt(dx * dx + dz * dz);
    const ux = hd > 1e-3 ? dx / hd : 0, uz = hd > 1e-3 ? dz / hd : 0;
    out.dx = ux; out.dz = uz; out.mag = 1;
    // slow down onto the final spot so we don't orbit it
    if (this.wi === path.length - 1 && hd < 2.5) out.mag = 0.45 + hd * 0.2;
    const act = w.act;
    const inWater = p.move === Move.Swim;
    // swimming carries momentum: ease off near every waypoint or we circle it
    if (inWater && hd < 4) out.mag = Math.min(out.mag, 0.35 + hd * 0.16);
    out.sprint = !inWater && (act === Act.Walk || act === Act.Cave || act === Act.JumpDown) && hd > 4;
    if (inWater) out.sprint = p.stamina > 0.5;

    switch (act) {
      case Act.Mantle:
        if (hd < 1.6 && dy > 0.4 && this.jumpCd <= 0 && (p.grounded || inWater)) { out.jump = true; this.jumpCd = 0.45; }
        break;
      case Act.JumpDown:
      case Act.Dive: {
        const prev = path[this.wi - 1];
        if (prev && p.grounded && this.jumpCd <= 0) {
          const px = prev.x - p.x, pz = prev.z - p.z;
          if (px * px + pz * pz < 1.2 * 1.2 && p.y > w.y + 1) { out.jump = true; this.jumpCd = 0.6; }
        }
        out.sprint = false;
        break;
      }
      case Act.Zipline:
        this.zipAction(sim, p, w, out);
        break;
      case Act.Vehicle:
        this.boatAction(sim, p, w, out);
        break;
    }

    // off the path (knocked back, slid down a slope, fell): re-plan, but not in a loop
    this.pathT += dt;
    if (act !== Act.JumpDown && act !== Act.Dive && act !== Act.Zipline && this.wi > 0 && this.pathT > 1 && sim.time - this.offPathT > 2) {
      const a = path[this.wi - 1];
      const off = segDist(p.x, p.z, a.x, a.z, w.x, w.z);
      if (off > 7 || (p.grounded && p.y < Math.min(a.y, w.y) - 4.5)) {
        this.offPathT = sim.time;
        if (++this.offPathN >= 3) {
          // keeps happening: treat it as being stuck
          this.offPathN = 0;
          this.progT = 1e9;
          this.trackStuck(sim, p, hd, dt, out);
          return;
        }
        this.plan(sim, p, "offPath");
        return;
      }
    }
    this.trackStuck(sim, p, hd, dt, out);
  }

  private reached(p: PlayerState, i: number): boolean {
    const w = this.path[i];
    const dx = w.x - p.x, dz = w.z - p.z, dy = w.y - p.y;
    const hd = Math.sqrt(dx * dx + dz * dz);
    const last = i === this.path.length - 1;
    switch (w.act) {
      case Act.Mantle:
        return p.move !== Move.Mantle && hd < 1.4 && dy < 0.45;
      case Act.JumpDown:
      case Act.Dive:
        return (p.grounded || p.move === Move.Swim || p.move === Move.Underwater) && hd < 3 && dy > -1.2;
      case Act.Zipline:
        return hd < 3.5 && Math.abs(dy) < 3;
      case Act.Vehicle:
        return hd < 6 && Math.abs(dy) < 3;
      case Act.Swim:
        if (hd < (last ? this.arriveR + 0.6 : 2.4) && Math.abs(dy) < 2.5) return true;
        break;
      default:
        if (hd < (last ? this.arriveR : 0.75) && Math.abs(dy) < 1.9) return true;
    }
    if (last || i === 0) return false;
    // passed it: beyond the waypoint along the segment, close to the line
    const a = this.path[i - 1], n = this.path[i + 1];
    if (w.act !== Act.Walk && w.act !== Act.Wade && w.act !== Act.Cave && w.act !== Act.Swim) return false;
    if (n.act !== Act.Walk && n.act !== Act.Wade && n.act !== Act.Cave && n.act !== Act.Swim) {
      return hd < 1.1 && Math.abs(dy) < 1.9;
    }
    const sx = w.x - a.x, sz = w.z - a.z;
    const L2 = sx * sx + sz * sz;
    if (L2 < 1e-4) return true;
    const t = ((p.x - a.x) * sx + (p.z - a.z) * sz) / L2;
    return t > 1 && hd < 2.2 && Math.abs(dy) < 1.9;
  }

  private resetProgress(): void {
    this.bestD = 1e9;
    this.progT = 0;
    this.offPathN = 0;
    this.endStuck();
  }

  private endStuck(): void {
    if (this.stuckT > 0) {
      if (this.stuckT > this.stats.stuckMax) this.stats.stuckMax = this.stuckT;
    }
    this.stuckT = 0;
    this.stuckLevel = 0;
  }

  private trackStuck(sim: MatchSim, p: PlayerState, d: number, dt: number, out: MoveOut): void {
    if (this.stuckLevel > 0) { this.stuckT += dt; this.stats.stuckTime += dt; }
    if (d < this.bestD - 0.3 && this.progT < 1e8) {
      if (d < this.bestD - 1.2 && this.bestD < 1e8 && this.stuckLevel > 0) this.endStuck();
      this.bestD = d;
      this.progT = 0;
      return;
    }
    this.progT += dt;
    const limit = p.move === Move.Swim ? 1.6 : 1.1;
    if (this.progT < limit) return;
    this.progT = 0;
    this.bestD = d;
    this.stuckLevel++;
    this.stats.stuckEvents++;
    const lvl = this.stuckLevel;
    if (lvl === 1) {
      out.jump = true;
      this.jumpCd = 0.4;
    } else if (lvl === 2 || lvl === 5) {
      const side = this.rng.next() < 0.5 ? 1 : -1;
      this.recoverX = -out.dz * side * 0.8 + out.dx * 0.2;
      this.recoverZ = out.dx * side * 0.8 + out.dz * 0.2;
      this.recoverT = 0.55;
    } else if (lvl === 3) {
      this.plan(sim, p, "stuck3");
    } else if (lvl === 4) {
      this.recoverX = -out.dx; this.recoverZ = -out.dz;
      this.recoverT = 0.7;
    } else if (lvl === 6) {
      this.plan(sim, p, "stuck6");
    } else {
      // give up on this goal; the brain picks another
      this.status = NavStatus.Failed;
      this.fails++;
      if (this.stuckT > this.stats.stuckMax) this.stats.stuckMax = this.stuckT;
      this.stuckLevel = 0;
      this.stuckT = 0;
    }
  }

  /**
   * Independent of waypoint bookkeeping: if we've been trying to travel for
   * 12 s but barely moved and got no closer to the goal (or keep sliding
   * down a too-steep slope), mark the spot as a trap and give up the goal.
   */
  private watchdog(sim: MatchSim, p: PlayerState, dt: number): boolean {
    const moving = this.status === NavStatus.Moving || this.status === NavStatus.Planning;
    if (!moving || p.move === Move.Vehicle || p.move === Move.Zipline) {
      this.wdX.length = 0; this.wdZ.length = 0; this.wdG.length = 0; this.wdT = 0; this.steepT = 0;
      return false;
    }
    if (p.move === Move.SteepSlide) this.steepT += dt;
    else this.steepT = Math.max(0, this.steepT - dt * 0.25);
    this.wdT += dt;
    let trapped = this.steepT > 3;
    if (this.wdT >= 4) {
      this.wdT = 0;
      this.wdX.push(p.x); this.wdZ.push(p.z); this.wdG.push(this.distToGoal(p));
      if (this.wdX.length > 4) { this.wdX.shift(); this.wdZ.shift(); this.wdG.shift(); }
      if (this.wdX.length === 4) {
        const disp = Math.sqrt((p.x - this.wdX[0]) ** 2 + (p.z - this.wdZ[0]) ** 2);
        const gain = this.wdG[0] - this.distToGoal(p);
        if (disp < 5 && gain < 4) trapped = true;
      }
    }
    if (!trapped) return false;
    if (!this.avoid) { this.avoid = new DangerMap(8, 60); this.avoidT = sim.time; }
    this.avoid.bump(p.x, p.z, 3, 10);
    this.trapT = sim.time;
    this.stats.stuckEvents++;
    this.stats.stuckTime += 4;
    this.wdX.length = 0; this.wdZ.length = 0; this.wdG.length = 0; this.steepT = 0;
    this.hub.cancel(this.ticket);
    this.ticket = 0;
    this.status = NavStatus.Failed;
    this.fails += 3;
    this.stuckLevel = 0;
    this.stuckT = 0;
    Navigator.why.watchdog = (Navigator.why.watchdog ?? 0) + 1;
    return true;
  }

  // ---------------------------------------------------------------- zipline

  private zipAction(sim: MatchSim, p: PlayerState, w: Waypoint, out: MoveOut): void {
    const z = sim.env.ziplines[w.link];
    if (!z) return;
    const dx = z.ax - p.x, dz = z.az - p.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    // walk to the top anchor, then grab
    out.dx = d > 1e-3 ? dx / d : 0; out.dz = d > 1e-3 ? dz / d : 0;
    out.mag = d > 1.2 ? 1 : 0.3;
    out.sprint = false;
    if (d < ZIP_GRAB_R - 0.4 && this.interactCd <= 0) {
      out.interact = true;
      this.interactCd = 0.4;
      if (++this.zipTried > 6) {
        // can't grab it: plan without ziplines
        this.opts = { ...this.opts, allow: (this.opts.allow ?? DEFAULT_ACTS) & ~actBit(Act.Zipline) };
        this.plan(sim, p, "zipFail");
      }
    }
  }

  // ---------------------------------------------------------------- boats (nav vehicle links)

  private boatAction(sim: MatchSim, p: PlayerState, w: Waypoint, out: MoveOut): void {
    const v = sim.vehicles[w.link];
    const noBoats = () => {
      this.opts = { ...this.opts, allow: (this.opts.allow ?? DEFAULT_ACTS) & ~actBit(Act.Vehicle) };
      this.plan(sim, p, "boatFail");
    };
    if (!v || v.seats[0] !== -1) { noBoats(); return; }
    const dx = v.x - p.x, dz = v.z - p.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d > 14) { noBoats(); return; }
    out.dx = d > 1e-3 ? dx / d : 0; out.dz = d > 1e-3 ? dz / d : 0;
    out.mag = d > 2 ? 1 : 0.4;
    out.sprint = false;
    if (d < INTERACT_R + 1.2 && this.interactCd <= 0) {
      out.interact = true;
      this.interactCd = 0.4;
      if (++this.boardTries > 5) noBoats();
    }
  }

  // ---------------------------------------------------------------- vespa

  /** Try riding Vespa `vid` toward the current goal. */
  rideVespa(vid: number): void {
    this.vespa = vid;
    this.vespaStuck = 0;
    this.vespaStuckT = 0;
    this.boardTries = 0;
    this.driveT = 0;
  }

  /** Walking to the Vespa; true while this overrides path following. */
  private approachVespa(sim: MatchSim, p: PlayerState, out: MoveOut): boolean {
    const v = sim.vehicles.find((q) => q.id === this.vespa);
    if (!v || v.seats[0] !== -1 || v.kind !== VehicleKind.Vespa) { this.vespa = -1; return false; }
    const dx = v.x - p.x, dz = v.z - p.z, d = Math.sqrt(dx * dx + dz * dz);
    if (d > 30) { this.vespa = -1; return false; }
    out.dx = d > 1e-3 ? dx / d : 0; out.dz = d > 1e-3 ? dz / d : 0;
    out.mag = d > 1.5 ? 1 : 0.3;
    out.sprint = d > 5;
    if (d < 2.4 && p.move === Move.Ground && this.interactCd <= 0) {
      out.interact = true;
      this.interactCd = 0.35;
      if (++this.boardTries > 6) this.vespa = -1;
    }
    return true;
  }

  // ---------------------------------------------------------------- driving

  private drive(sim: MatchSim, p: PlayerState, dt: number, out: MoveOut): void {
    const v = sim.vehicles.find((q) => q.id === p.vehicle);
    out.drive = true;
    if (!v || p.seat !== 0) {
      // passenger (shouldn't happen): hop off
      if (this.interactCd <= 0) { out.interact = true; this.interactCd = 0.5; }
      return;
    }
    if (v.kind === VehicleKind.Gyrocopter) {
      // bots don't fly: throttle back and hop off
      out.throttle = -1;
      if (this.interactCd <= 0) { out.interact = true; this.interactCd = 0.5; }
      return;
    }
    if (!this.driving) {
      this.driving = true;
      this.driveT = 0;
      this.vespaStuck = 0;
      if (v.kind === VehicleKind.Vespa) this.stats.vespaRides++;
      else this.stats.boatRides++;
    }
    this.driveT += dt;
    // where to: boat -> the landing waypoint; vespa -> a point ahead on the walking path
    let tx = this.gx, tz = this.gz, exitR = 10;
    const boat = isBoat(v.kind);
    if (boat) {
      for (let i = this.wi; i < this.path.length; i++) if (this.path[i].act === Act.Vehicle) { tx = this.path[i].x; tz = this.path[i].z; break; }
      exitR = 7;
    } else if (this.path.length) {
      // advance along the path while driving; bail before anything a scooter can't do
      while (this.wi < this.path.length - 1) {
        const w = this.path[this.wi];
        const d2 = (w.x - v.x) * (w.x - v.x) + (w.z - v.z) * (w.z - v.z);
        if (d2 < 36) this.wi++;
        else break;
      }
      const w = this.path[this.wi];
      tx = w.x; tz = w.z;
      if (w.act === Act.Mantle || w.act === Act.Swim || w.act === Act.Dive || w.act === Act.Zipline || w.act === Act.Vehicle || w.act === Act.Cave) {
        exitR = 1e9; // get off now
      }
    }
    const gdx = this.gx - v.x, gdz = this.gz - v.z;
    const goalD = Math.sqrt(gdx * gdx + gdz * gdz);
    const dx = tx - v.x, dz = tz - v.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < exitR && (boat || goalD < 14 || exitR > 1e8) || this.vespaStuck >= 3 || this.driveT > 90) {
      if (this.interactCd <= 0 && Math.abs(v.speed) < (boat ? 2.5 : 4)) { out.interact = true; this.interactCd = 0.5; }
      out.throttle = -0.6;
      return;
    }
    const ang = wrapAngle(atan2(dx, dz) - v.yaw);
    let steerLeft = ang * 2.2;
    steerLeft = steerLeft > 1 ? 1 : steerLeft < -1 ? -1 : steerLeft;
    out.steer = -steerLeft;
    out.throttle = Math.abs(ang) > 1.3 ? 0.35 : 1;
    if (!boat && d < 12 && Math.abs(ang) > 0.5) out.throttle = 0.5;
    // fast boats: ease off coming in to the landing (they beach themselves anyway)
    if (boat && d < 35) out.throttle = Math.min(out.throttle, 0.3 + d / 40);
    // unstick: speed ~0 while trying to go -> reverse with opposite lock
    if (this.reverseT > 0) {
      this.reverseT -= dt;
      out.throttle = -1;
      out.steer = -out.steer;
      return;
    }
    if (this.driveT > 1.2 && Math.abs(v.speed) < 0.8) {
      this.vespaStuckT += dt;
      if (this.vespaStuckT > 1.0) {
        this.vespaStuckT = 0;
        this.vespaStuck++;
        this.reverseT = 0.9;
      }
    } else this.vespaStuckT = 0;
    void sim;
  }

  /** Nearest empty Vespa within r of p (by hull centre), or null. */
  static freeVespa(sim: MatchSim, p: PlayerState, r: number): VehicleState | null {
    let best: VehicleState | null = null, bd = r * r;
    for (const v of sim.vehicles) {
      if (v.kind !== VehicleKind.Vespa || v.seats[0] !== -1) continue;
      const dx = v.x - p.x, dz = v.z - p.z, d2 = dx * dx + dz * dz;
      if (d2 < bd && Math.abs(v.y - p.y) < 4) { bd = d2; best = v; }
    }
    return best;
  }
}

function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const sx = bx - ax, sz = bz - az;
  const L2 = sx * sx + sz * sz;
  let t = L2 > 0 ? ((px - ax) * sx + (pz - az) * sz) / L2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + sx * t - px, qz = az + sz * t - pz;
  return Math.sqrt(qx * qx + qz * qz);
}
