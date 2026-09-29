// BotBrain: one server bot. Per sim step (60 Hz) it
//   1. perceives (10 Hz, staggered): who it can see (range + FOV + line of
//      sight, with a reaction delay), hears (shots nearby, balls whizzing
//      past, getting painted) and remembers (last seen position / velocity);
//   2. decides (every ~0.2-0.4 s, or when something happens): a utility pick
//      between roam / engage / chase / cover / wash / ammo / upgrade / flank /
//      perch / hide / investigate / ride, weighted by personality;
//   3. acts: nav-path movement or local combat moves, human-like aim with a
//      spring + drifting error, burst fire, reloads;
//   4. writes one InputCmd, exactly like a human client would.
// Deterministic for a given (sim, seed, id): all randomness is a seeded Rng.
import { Rng } from "../../math/rng";
import { atan2, cos, sin, wrapAngle } from "../../math/trig";
import {
  BALL_GRAVITY, BALL_LIFE, BREATH_TIME, Btn, canShootIn, emptyCmd, eyeHeight, hopperCap, ballSpeed, hasUpgrade, Move,
  NO_WATER_Y, probeGround, BLOCKED, SNORKEL_MULT, RESPAWN_DELAY,
  type InputCmd, type MatchSim, type PickupState, type PlayerState,
} from "../../sim/index";
import { PickupKind } from "../../world/types";
import { terrainHeight } from "../../world/collide";
import { Act, actBit, DEFAULT_ACTS, NF } from "../constants";
import { nearestNode } from "../nav";
import { randomReachablePoint } from "../path";
import { ballisticAim, findCover, segmentClear, trajectoryClear, type CoverSpot } from "../tactics";
import type { PathOptions } from "../path";
import { AimSpring, bodyAimY, scratchPlayer, solveCrosshair, type AimOut } from "./aim";
import { makeConfig, type BotConfig } from "./config";
import { getHub, type BotHub, type ShotRec } from "./hub";
import { clearMove, Navigator, NavStatus, safeStep, type MoveOut } from "./mover";
import { newStats, St, type BotController, type BotSeatInfo, type BotStats, type PersonalityName } from "./types";

interface Contact {
  id: number;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  /** Sim time last seen / heard / shot at us by them. */
  seenT: number;
  heardT: number;
  threatT: number;
  /** Awareness 0..1.5; visible once >= 1 with line of sight. */
  spot: number;
  visible: boolean;
}

const NEVER = -1e9;
const PERC_EVERY = 6; // sim steps (10 Hz)
const SOLVE_EVERY = 3; // aim solution refresh (20 Hz)

const _from = { x: 0, y: 0, z: 0 };
const _to = { x: 0, y: 0, z: 0 };
const _vel = { x: 0, y: 0, z: 0 };
const _dir = { x: 0, y: 0, z: 0 };
const _shots: ShotRec[] = [];

function hyp(x: number, z: number): number {
  return Math.sqrt(x * x + z * z);
}

export interface BrainOptions extends BotSeatInfo {}

export class BotBrain implements BotController {
  readonly id: number;
  readonly name: string;
  readonly cfg: BotConfig;
  readonly stats: BotStats = newStats();
  state: St = St.Roam;
  stateT = 0;

  private readonly rng: Rng;
  private hub: BotHub | null = null;
  private nav: Navigator | null = null;
  private readonly aim = new AimSpring();
  private readonly cmd: InputCmd = emptyCmd();
  private readonly mv: MoveOut = clearMove({} as MoveOut);
  private readonly scratch: PlayerState;
  private readonly slot: number;
  private seq = 0;

  // perception
  private readonly contacts = new Map<number, Contact>();
  private target: Contact | null = null;
  private lastShotTick = -1;
  private alertX = 0;
  private alertY = 0;
  private alertZ = 0;
  private alertT = NEVER;
  private prevCoats = 0;
  private lastHitT = NEVER;
  private newlySeen = false;

  // decisions
  private thinkT = 0;
  private interrupt = true;
  private holdT = 0;
  private visited: number[] = [];
  /** Queued roam legs; `vespa` >= 0 means "hop on that scooter and ride this leg". */
  private roamChain: { x: number; y: number; z: number; vespa: number }[] = [];
  private noTargetT = 0;
  /** Fighting style for the current target: 0 duel (strafe), 1 peek from cover, 2 push. */
  private style = 0;
  /** When the target is lost: 0 chase, 1 flank. */
  private lostPlan = 0;
  private holdCooldown = 0;
  private pickGoal = -1;
  private arrivedT = 0;
  private readonly skipPickups: number[] = [];
  private readonly skipUntil: number[] = [];
  private washGoal = -1;
  private readonly badWash: number[] = [];
  private coverFailT = NEVER;
  private held = false;
  private navNoted = false;

  // combat
  private readonly sol: AimOut = { yaw: 0, pitch: 0, t: 0 };
  private wantYaw = 0;
  private wantPitch = 0;
  private wantVy = 0;
  private wantVp = 0;
  private solveT = 0;
  private solvedFor = -1;
  private shootable = false;
  private lob = false;
  private blockedT = 0;
  private onTargetT = 0;
  private burstLeft = 0;
  private burstPause = 0;
  private lastSeqShot = 0;
  private lastFireT = NEVER;
  private leadK = 1;
  private useAds = false;
  private strafeDir = 1;
  private strafeT = 0;
  private reloadCd = 0;
  private cover: CoverSpot | null = null;
  private coverPhase = 0;
  private coverT = 0;
  private coverCycles = 0;
  private peekSide = 1;
  private flankT = 0;

  // body
  private jumpHold = 0;
  private jumpGap = false;
  private prevButtons = 0;
  private wasAlive = false;
  private spawnPressed = false;
  private lastDeadT = 0;
  private spawnDelay = 2.5;
  private glanceT = 3;
  private glanceYaw = 0;
  private glanceDur = 0;
  private washDiveCd = 0;

  constructor(opts: BrainOptions) {
    this.id = opts.id;
    this.name = opts.name ?? `bot${opts.id}`;
    this.cfg = makeConfig(opts.seed, opts.id, opts.difficulty, opts.personality);
    this.rng = new Rng(Math.imul(opts.seed | 0, 0x27d4eb2d) ^ Math.imul(opts.id + 1, 0x165667b1)).fork("bot-brain");
    this.scratch = scratchPlayer(opts.id);
    this.slot = ((opts.id * 7) >>> 0) % PERC_EVERY;
    this.thinkT = this.rng.next() * 0.3;
  }

  get personality(): PersonalityName {
    return this.cfg.pers.name;
  }

  /** Debug / harness: what the bot is doing. */
  debug(): { state: St; target: number; goal: [number, number, number] | null; stuck: number; path: number } {
    const n = this.nav;
    return {
      state: this.state,
      target: this.target ? this.target.id : -1,
      goal: n && n.hasGoal ? [n.gx, n.gy, n.gz] : null,
      stuck: n ? n.stuckLevel : 0,
      path: n ? n.path.length - n.wi : 0,
    };
  }

  dispose(): void {
    this.nav?.stop();
    this.contacts.clear();
  }

  // =================================================================== think
  think(sim: MatchSim, _playerId: number, dt: number): InputCmd {
    if (!this.hub) {
      this.hub = getHub(sim);
      this.nav = new Navigator(this.hub, this.rng.fork("nav"), this.stats);
    }
    const hub = this.hub;
    hub.update(sim);
    const c = this.cmd;
    c.seq = ++this.seq;
    c.buttons = 0;
    c.moveX = 0;
    c.moveZ = 0;
    const p = sim.player(this.id);
    if (!p) return c;
    if (!p.alive) {
      this.dead(sim, p, dt);
      c.yaw = this.aim.yaw;
      c.pitch = 0;
      this.stats.stateTime[St.Dead] += dt;
      this.prevButtons = c.buttons;
      return c;
    }
    if (!this.wasAlive) this.onSpawn(sim, p);
    this.stateT += dt;
    this.stats.stateTime[this.state] += dt;
    this.noticeOwnState(sim, p);
    if ((sim.tick + this.slot) % PERC_EVERY === 0) this.perceive(sim, p, dt * PERC_EVERY);
    else this.trackVisible(sim, dt);
    this.thinkT -= dt;
    if (this.thinkT <= 0 || this.interrupt) {
      this.decide(sim, p);
      this.thinkT = this.cfg.skill.thinkEvery * (0.8 + this.rng.next() * 0.4);
      this.interrupt = false;
    }
    this.act(sim, p, dt);
    this.compose(p, dt);
    return c;
  }

  // =================================================================== life cycle
  private dead(sim: MatchSim, p: PlayerState, dt: number): void {
    const newDeath = this.wasAlive || p.deadT < this.lastDeadT;
    this.lastDeadT = p.deadT;
    if (newDeath) {
      this.wasAlive = false;
      this.nav!.stop();
      this.contacts.clear();
      this.target = null;
      this.state = St.Dead;
      this.spawnPressed = false;
      this.cover = null;
      // humans take a moment to pick: 2-4 s (the sim auto-picks at 5.5 s)
      this.spawnDelay = RESPAWN_DELAY - 0.9 + this.rng.next() * 1.5 * (1.3 - this.cfg.difficulty * 0.3);
    }
    void dt;
    if (this.spawnPressed || p.spawnChoices.length < 2 || p.deadT < this.spawnDelay) return;
    const sp = sim.world.spawns;
    const score = (i: number) => {
      const s = sp[i];
      if (!s) return -1;
      let d = 1e9;
      for (const o of sim.players) {
        if (o.id === this.id || !o.alive) continue;
        const dx = o.x - s.x, dz = o.z - s.z;
        const dd = dx * dx + dz * dz;
        if (dd < d) d = dd;
      }
      return Math.sqrt(d);
    };
    let pick = score(p.spawnChoices[0]) >= score(p.spawnChoices[1]) ? 0 : 1;
    // easy bots don't study the map much; aggressive ones sometimes want the action
    const r = this.rng.next();
    if (r < (this.cfg.difficulty === 0 ? 0.35 : 0.1) + this.cfg.pers.aggression * 0.15) pick = 1 - pick;
    this.cmd.buttons |= pick === 0 ? Btn.SpawnA : Btn.SpawnB;
    this.spawnPressed = true;
  }

  private onSpawn(sim: MatchSim, p: PlayerState): void {
    this.wasAlive = true;
    this.aim.reset(p.yaw, 0);
    this.prevCoats = p.coats.length;
    this.setState(St.Roam, sim);
    this.interrupt = true;
    this.noTargetT = 0;
    this.roamChain.length = 0;
    this.alertT = NEVER;
    this.lastHitT = NEVER;
    this.burstLeft = 0;
    this.burstPause = 0;
    this.lastSeqShot = p.shotSeq;
  }

  private setState(s: St, sim: MatchSim): void {
    if (s === this.state) return;
    this.state = s;
    this.stateT = 0;
    this.holdT = 0;
    this.coverPhase = 0;
    this.coverCycles = 0;
    if (s !== St.Cover) this.cover = null;
    void sim;
  }

  // =================================================================== perception
  private contact(id: number): Contact {
    let c = this.contacts.get(id);
    if (!c) {
      c = { id, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, seenT: NEVER, heardT: NEVER, threatT: NEVER, spot: 0, visible: false };
      this.contacts.set(id, c);
    }
    return c;
  }

  private noticeOwnState(sim: MatchSim, p: PlayerState): void {
    const n = p.coats.length;
    if (n > this.prevCoats) {
      // painted! we feel where it came from
      const by = p.coatBy[n - 1];
      const o = sim.player(by);
      this.lastHitT = sim.time;
      if (o && o.alive && !this.hub!.ignore.has(by)) {
        const c = this.contact(by);
        c.threatT = sim.time;
        c.spot = Math.max(c.spot, 0.75);
        if (!c.visible) { c.x = o.x; c.y = o.y; c.z = o.z; }
        this.alert(o.x, o.y + 1, o.z, sim.time);
      }
      this.aim.kick(this.cfg.skill.aimErr * 1.5, this.rng);
      this.interrupt = true;
    }
    this.prevCoats = n;
  }

  private alert(x: number, y: number, z: number, t: number): void {
    this.alertX = x; this.alertY = y; this.alertZ = z; this.alertT = t;
  }

  /** Between perception ticks: keep visible contacts' positions live. */
  private trackVisible(sim: MatchSim, dt: number): void {
    const k = Math.min(1, this.cfg.skill.velTrack * dt);
    for (const c of this.contacts.values()) {
      if (!c.visible) continue;
      const o = sim.player(c.id);
      if (!o || !o.alive) { c.visible = false; continue; }
      c.x = o.x; c.y = o.y; c.z = o.z;
      c.vx += (o.vx - c.vx) * k; c.vy += (o.vy - c.vy) * k; c.vz += (o.vz - c.vz) * k;
      c.seenT = sim.time;
    }
  }

  private perceive(sim: MatchSim, p: PlayerState, dt: number): void {
    const S = this.cfg.skill, hub = this.hub!, cw = sim.env.cw, now = sim.time;
    const ex = p.x, ey = p.y + (p.move === Move.Vehicle ? 1.25 : eyeHeight(p.move)), ez = p.z;
    const facing = this.aim.yaw;
    const scope = hasUpgrade(p, PickupKind.Scope) ? 1.3 : 1;
    const eyesOpen = p.move !== Move.Underwater;
    // candidates in range + FOV, nearest first; line-of-sight checks are budgeted
    let n = 0;
    const cand = this.candBuf;
    for (const o of sim.players) {
      if (o.id === this.id) continue;
      const c = this.contacts.get(o.id);
      if (!o.alive || hub.ignore.has(o.id)) {
        if (c) this.contacts.delete(o.id);
        if (this.target && this.target.id === o.id) { this.target = null; this.interrupt = true; }
        continue;
      }
      if (c) c.visible = c.visible && eyesOpen;
      if (!eyesOpen) continue;
      const dx = o.x - ex, dz = o.z - ez;
      const d = hyp(dx, dz);
      const range = S.viewRange * scope * (o.move === Move.Underwater ? 0.14 : 1);
      if (d > range) { if (c) c.visible = false; continue; }
      const off = Math.abs(wrapAngle(atan2(dx, dz) - facing));
      const fov = S.fovHalf + (c && c.spot > 0.4 ? 0.35 : 0);
      if (d > 8 && off > fov) { if (c) c.visible = false; continue; }
      cand[n * 2] = d; cand[n * 2 + 1] = o.id;
      n++;
    }
    // sort by distance (tiny n, insertion sort, deterministic)
    for (let i = 1; i < n; i++) {
      const d = cand[i * 2], id = cand[i * 2 + 1];
      let j = i - 1;
      while (j >= 0 && (cand[j * 2] > d || (cand[j * 2] === d && cand[j * 2 + 1] > id))) { cand[(j + 1) * 2] = cand[j * 2]; cand[(j + 1) * 2 + 1] = cand[j * 2 + 1]; j--; }
      cand[(j + 1) * 2] = d; cand[(j + 1) * 2 + 1] = id;
    }
    const checks = Math.min(n, 6);
    for (let i = 0; i < n; i++) {
      const id = cand[i * 2 + 1], d = cand[i * 2];
      const o = sim.player(id)!;
      const c = this.contact(id);
      if (i >= checks) { c.visible = false; continue; }
      const ty = bodyAimY(o);
      const los = segmentClear(cw, ex, ey, ez, o.x, ty, o.z) || (o.move !== Move.Swim && segmentClear(cw, ex, ey, ez, o.x, o.y + 1.55, o.z));
      if (los) {
        const spd = hyp(o.vx, o.vz);
        let rate = dt / (S.reaction * (0.55 + d / 40));
        if (spd > 2) rate *= 1.4;
        if (now - c.threatT < 3 || now - c.heardT < 2) rate *= 1.8;
        if (o.move === Move.Swim) rate *= 0.8;
        c.spot = Math.min(1.5, c.spot + rate);
        if (c.spot >= 1) {
          if (!c.visible) {
            this.newlySeen = true;
            if (!this.target || !this.target.visible) this.interrupt = true;
            if (now - c.seenT > 2) { c.vx = 0; c.vy = 0; c.vz = 0; }
          }
          c.visible = true;
          c.x = o.x; c.y = o.y; c.z = o.z;
          c.seenT = now;
        }
      } else {
        if (c.visible) this.interrupt = this.target === c;
        c.visible = false;
        c.spot = Math.max(0, c.spot - dt * 0.6);
      }
    }
    // hearing: shots fired nearby since the last perception tick
    hub.shotsSince(this.lastShotTick, _shots);
    this.lastShotTick = sim.tick;
    for (const s of _shots) {
      if (s.owner === this.id || hub.ignore.has(s.owner)) continue;
      const dx = s.x - p.x, dz = s.z - p.z, d = hyp(dx, dz);
      if (d > S.hearRange) continue;
      const c = this.contact(s.owner);
      c.heardT = now;
      if (!c.visible) {
        // a rough fix on the sound: +-12 % of the distance
        const err = d * 0.12;
        c.x = s.x + (this.rng.next() * 2 - 1) * err;
        c.z = s.z + (this.rng.next() * 2 - 1) * err;
        c.y = s.y - 1.2;
        if (d < 30) c.spot = Math.max(c.spot, 0.45);
      }
      if (now - this.alertT > 1.5 && !(this.target && this.target.visible)) this.alert(s.x, s.y, s.z, now);
    }
    // balls whizzing past: someone is shooting at me, and I know from where
    for (const b of sim.projectiles) {
      if (b.owner === this.id || hub.ignore.has(b.owner)) continue;
      const dx = b.x - p.x, dy = b.y - (p.y + 1), dz = b.z - p.z;
      if (dx * dx + dy * dy + dz * dz > 9) continue;
      const o = sim.player(b.owner);
      if (!o || !o.alive) continue;
      const c = this.contact(b.owner);
      if (now - c.threatT > 1) this.interrupt = true;
      c.threatT = now;
      c.spot = Math.max(c.spot, 0.7);
      if (!c.visible) { c.x = b.x - b.vx * b.age; c.z = b.z - b.vz * b.age; c.y = o.y; }
      this.alert(c.x, c.y + 1.2, c.z, now);
    }
    // forget stale contacts
    for (const c of this.contacts.values()) {
      if (c.visible || c.spot > 0.02) continue;
      const last = Math.max(c.seenT, c.heardT, c.threatT);
      if (now - last > S.memory * 2.5) {
        this.contacts.delete(c.id);
        if (this.target === c) this.target = null;
      }
    }
  }
  private readonly candBuf = new Float64Array(64);

  private known(c: Contact, now: number): boolean {
    return c.visible || now - c.seenT < this.cfg.skill.memory || now - c.threatT < 3;
  }

  private chooseTarget(sim: MatchSim, p: PlayerState): void {
    const now = sim.time;
    let best: Contact | null = null, bs = -1e9;
    for (const c of this.contacts.values()) {
      if (!this.known(c, now)) continue;
      const o = sim.player(c.id);
      if (!o || !o.alive) continue;
      const d = hyp(c.x - p.x, c.z - p.z);
      let s = (c.visible ? 2 : 0.4) + 25 / (d + 8) + o.coats.length * 0.35;
      if (now - c.threatT < 3) s += 1.4;
      if (c === this.target) s += 0.9;
      if (o.shield > 0) s -= 1;
      if (o.move === Move.Underwater) s -= 1.5;
      if (s > bs) { bs = s; best = c; }
    }
    if (best !== this.target) {
      this.target = best;
      this.onTargetT = 0;
      this.solvedFor = -1;
      if (best) {
        const S = this.cfg.skill, P = this.cfg.pers;
        this.aim.kick(S.aimErr * 0.8, this.rng);
        this.useAds = this.rng.next() < S.ads;
        const r = this.rng.next();
        const pCover = S.tactics * (0.15 + 0.6 * P.caution), pPush = 0.5 * P.aggression;
        this.style = r < pCover ? 1 : r < pCover + pPush ? 2 : 0;
        this.lostPlan = this.rng.next() < S.tactics * (0.25 + 0.5 * P.caution) ? 1 : 0;
      }
    }
  }

  // =================================================================== decide
  private decide(sim: MatchSim, p: PlayerState): void {
    const now = sim.time, S = this.cfg.skill, P = this.cfg.pers, hub = this.hub!, nav = this.nav!;
    this.chooseTarget(sim, p);
    const t = this.target;
    const tVis = !!t && t.visible;
    const tD = t ? hyp(t.x - p.x, t.z - p.z) : 1e9;
    const tp = t ? sim.player(t.id) : undefined;
    const coats = p.coats.length;
    const ammo = p.hopper + p.reserve;
    const underFire = now - this.lastHitT < 2.5 || (!!t && now - t.threatT < 2);
    if (tVis) this.noTargetT = 0;
    else this.noTargetT += S.thinkEvery;
    const cur = this.state;
    const inWater = p.move === Move.Swim || p.move === Move.Underwater;

    // ---- utilities
    let uWash = 0;
    if (coats >= 2) {
      uWash = 0.82 + 0.2 * P.caution;
      if (tVis && tp && tp.coats.length >= 2 && tD < 25) uWash -= 0.45 * P.aggression; // go for the trade
    } else if (coats === 1 && !tVis && !underFire) {
      uWash = (0.15 + 0.4 * P.caution) * S.tactics;
    }
    if (cur === St.Wash && coats > 0) uWash += inWater ? 0.5 : 0.15;
    const uAmmo = ammo < 6 ? 1.05 : p.reserve < 12 ? 0.6 : p.reserve < 35 && !tVis ? 0.3 : 0;
    const canShoot = ammo > 0;
    const range = S.maxRange * (hasUpgrade(p, PickupKind.Scope) ? 1.25 : 1);
    let uEngage = tVis && canShoot && tD < range * 1.2 ? 0.7 + 0.25 * P.aggression : 0;
    if (tVis && tp && tp.coats.length >= 2) uEngage += 0.1;
    // cover: the "peek" fighting style, or ducking out to reload / after getting painted
    let uCover = 0;
    if (tVis && canShoot && tD > 9 && now - this.coverFailT > 4) {
      if (this.style === 1) uCover = 0.8 + 0.2 * P.caution;
      if (underFire || p.reload > 0 || p.hopper === 0) {
        uCover = Math.max(uCover, (0.3 + 0.55 * P.caution) * S.tactics + (coats >= 1 ? 0.15 : 0) + (p.reload > 0 || p.hopper === 0 ? 0.25 : 0));
      }
    }
    if (cur === St.Cover && this.cover) uCover += 0.3;
    // lost sight of them: chase straight in, or swing around (flank)
    let uFlank = 0, uChase = 0;
    if (t && canShoot && tD < range * 1.2) {
      const lost = !tVis && now - t.seenT < S.memory;
      if (lost || (tVis && this.blockedT > 1.2)) {
        if (this.lostPlan === 1 || (tVis && this.blockedT > 1.2)) uFlank = 0.6 + 0.3 * S.tactics;
        else if (lost) uChase = 0.4 + 0.45 * P.aggression;
      }
    }
    if (cur === St.Flank && this.flankT > 0) uFlank += 0.2;
    let uInvestigate = 0;
    if (!tVis && canShoot && now - this.alertT < 6) uInvestigate = 0.36 + 0.4 * P.aggression - 0.15 * P.caution;
    if (cur === St.Investigate) uInvestigate += 0.1;
    // pickups
    let upg = this.bestUpgrade(sim, p);
    const uUpgrade = upg ? upg.u : 0;
    let uPerch = 0, uHide = 0;
    if (!tVis && !underFire && coats === 0 && (now > this.holdCooldown || cur === St.Perch || cur === St.Hide)) {
      const lonely = Math.min(1, this.noTargetT / 20);
      uPerch = P.name === "sniper" ? 0.3 + 0.3 * P.patience : 0.12 * P.patience;
      uHide = P.name === "sneaky" ? 0.25 + 0.3 * P.patience * (1 - lonely * 0.5) : 0.06 * P.patience;
      if (cur === St.Perch || cur === St.Hide) {
        // stay a while, then get bored
        const bored = this.stateT > 12 + 25 * P.patience;
        if (bored) { uPerch = 0; uHide = 0; this.holdCooldown = now + 25 + 30 * (1 - P.patience); }
        else { uPerch += cur === St.Perch ? 0.25 : 0; uHide += cur === St.Hide ? 0.25 : 0; }
      }
    }
    let uRoam = 0.3;
    if (cur === St.Roam) uRoam += 0.05;

    // ---- pick
    let best = St.Roam as St, bu = uRoam;
    const cand = (s: St, u: number) => { if (u > bu) { bu = u; best = s; } };
    cand(St.Wash, uWash);
    cand(St.Ammo, uAmmo);
    cand(St.Engage, uEngage);
    cand(St.Cover, uCover);
    cand(St.Flank, uFlank);
    cand(St.Chase, uChase);
    cand(St.Investigate, uInvestigate);
    cand(St.Upgrade, uUpgrade);
    cand(St.Perch, uPerch);
    cand(St.Hide, uHide);
    if (p.move === Move.Vehicle || (cur === St.Ride && nav.vespa >= 0 && !(tVis && tD < 25))) best = St.Ride;
    else if (nav.vespa >= 0 && tVis && tD < 25) nav.vespa = -1;
    const prev = this.state;
    this.setState(best, sim);
    const fresh = prev !== best;

    // ---- plan for the chosen state
    const g = hub.bw.nav;
    const cautiousOpts: PathOptions = P.caution > 0.4 ? { danger: hub.danger, dangerWeight: P.caution * 1.2 } : {};
    switch (best as St) {
      case St.Wash: {
        if (inWater && this.deepHere(sim, p)) { nav.stop(); break; }
        if (nav.status === NavStatus.Arrived && this.washGoal >= 0) {
          // got there but it's too shallow to duck under: try another spot
          this.badWash.push(this.washGoal);
          if (this.badWash.length > 8) this.badWash.shift();
          this.washGoal = -1;
        }
        if (fresh || !nav.hasGoal || nav.status === NavStatus.Failed) {
          const q = this.pickWash(sim, p, t);
          this.washGoal = q;
          if (q >= 0) nav.go(sim, p, g.x[q], g.y[q], g.z[q], { ...cautiousOpts, swimCost: 0.7 }, 2, 3, fresh, "wash");
          else this.setState(St.Roam, sim);
        }
        break;
      }
      case St.Ammo: {
        const k = this.nearestPickup(sim, p, (kind, drop) => kind === PickupKind.Ammo || drop !== 0);
        if (k) { this.pickGoal = k.id; nav.go(sim, p, k.x, k.y, k.z, cautiousOpts, 0.9, 2, fresh, "ammo"); }
        else this.setState(St.Roam, sim);
        break;
      }
      case St.Upgrade:
        if (upg) { this.pickGoal = upg.id; nav.go(sim, p, upg.x, upg.y, upg.z, {}, 0.9, 2, fresh, "upgrade"); }
        upg = null;
        break;
      case St.Engage:
        break; // local movement in act()
      case St.Cover:
        if (fresh || !this.cover) this.findCoverSpot(sim, p);
        if (!this.cover) { this.coverFailT = now; this.setState(uFlank > 0.2 ? St.Flank : St.Engage, sim); }
        if (this.state === St.Flank) this.planFlank(sim, p);
        break;
      case St.Flank:
        if (fresh || this.flankT <= 0 || nav.status === NavStatus.Failed) this.planFlank(sim, p);
        break;
      case St.Chase:
        if (t) nav.go(sim, p, t.x, t.y, t.z, {}, 2, 4, fresh, "chase");
        break;
      case St.Investigate: {
        // approach the noise, but stop short of it
        const dx = this.alertX - p.x, dz = this.alertZ - p.z, d = hyp(dx, dz);
        const k = d > 15 ? (d - 10) / d : 0.3;
        nav.go(sim, p, p.x + dx * k, this.alertY - 1, p.z + dz * k, {}, 2.5, 6, fresh, "investigate");
        break;
      }
      case St.Perch:
      case St.Hide:
        if (fresh) this.pickHold(sim, p, best);
        break;
      case St.Roam:
        if (fresh || nav.status === NavStatus.Failed || nav.status === NavStatus.Idle) this.pickRoam(sim, p);
        else if (nav.status === NavStatus.Arrived && this.holdT <= 0) {
          if (!this.held && this.roamChain.length === 0) {
            // look around for a moment before moving on
            this.holdT = 0.5 + this.rng.next() * 2 * (0.5 + P.patience);
            this.held = true;
          } else this.pickRoam(sim, p);
        }
        break;
      case St.Ride:
        break;
    }
    if (this.newlySeen) this.newlySeen = false;
  }

  private deepHere(sim: MatchSim, p: PlayerState): boolean {
    if (p.waterY === NO_WATER_Y) return false;
    const g = probeGround(sim.env, p.x, p.y + 0.3, p.z, 12);
    const floor = g === BLOCKED || g === -Infinity ? p.y - 12 : g;
    return p.waterY - floor > 1.7;
  }

  private pickWash(sim: MatchSim, p: PlayerState, threat: Contact | null): number {
    const hub = this.hub!, g = hub.bw.nav;
    let best = -1, bs = 1e18;
    for (const q of hub.washSpots) {
      if (this.badWash.includes(q)) continue;
      const dx = g.x[q] - p.x, dz = g.z[q] - p.z, dy = g.y[q] - p.y;
      let s = dx * dx + dz * dz + dy * dy * 9;
      if (threat) {
        // prefer water away from the shooter
        const tx = threat.x - p.x, tz = threat.z - p.z;
        const tl = hyp(tx, tz) || 1, dl = Math.sqrt(dx * dx + dz * dz) || 1;
        const dot = (dx * tx + dz * tz) / (tl * dl);
        if (dot > 0.3) s *= 1 + dot * 1.5;
      }
      if (s < bs) { bs = s; best = q; }
    }
    return best;
  }

  private nearestPickup(sim: MatchSim, p: PlayerState, ok: (kind: PickupKind, drop: number) => boolean): PickupState | null {
    let best = null as null | PickupState, bd = 200 * 200;
    for (const k of sim.pickups) {
      if (!k.active || !ok(k.kind, k.drop) || this.badPickup(k.id, sim.time)) continue;
      const dx = k.x - p.x, dz = k.z - p.z, dy = k.y - p.y;
      const d = dx * dx + dz * dz + dy * dy * 4;
      if (d < bd) { bd = d; best = k; }
    }
    return best;
  }

  private badPickup(id: number, now: number): boolean {
    const i = this.skipPickups.indexOf(id);
    return i >= 0 && this.skipUntil[i] > now;
  }

  private skipPickup(id: number, now: number): void {
    this.skipPickups.push(id);
    this.skipUntil.push(now + 60);
    if (this.skipPickups.length > 6) { this.skipPickups.shift(); this.skipUntil.shift(); }
  }

  private bestUpgrade(sim: MatchSim, p: PlayerState): { x: number; y: number; z: number; u: number; id: number } | null {
    const P = this.cfg.pers;
    let best = null as null | { x: number; y: number; z: number; u: number; id: number };
    let bu = 0.2;
    for (const k of sim.pickups) {
      if (!k.active || this.badPickup(k.id, sim.time)) continue;
      let w: number;
      if (k.drop) w = 0.8;
      else if (k.kind === PickupKind.Ammo) continue;
      else if (p.upgrades & (1 << k.kind)) continue;
      else w = P.wants[k.kind];
      const dx = k.x - p.x, dz = k.z - p.z;
      const d = hyp(dx, dz) + Math.abs(k.y - p.y) * 2;
      const reach = 50 + 90 * P.curiosity;
      if (d > reach) continue;
      const u = w * (0.3 + 0.35 * P.curiosity) * (1 - d / reach) + (k.drop ? 0.1 : 0);
      if (u > bu) { bu = u; best = { x: k.x, y: k.y, z: k.z, u, id: k.id }; }
    }
    return best;
  }

  private findCoverSpot(sim: MatchSim, p: PlayerState): void {
    const t = this.target;
    this.cover = null;
    if (!t) return;
    const hub = this.hub!;
    _from.x = t.x; _from.y = t.y + 1.45; _from.z = t.z;
    _to.x = p.x; _to.y = p.y; _to.z = p.z;
    const spots = findCover(hub.bw.nav, hub.bw.cover, _from, _to, 14, { max: 3, budget: 18, minThreatDist: 7 });
    let best: CoverSpot | null = null;
    for (const s of spots) if (!best || (s.peek && !best.peek)) best = s;
    if (best) {
      this.cover = best;
      this.coverPhase = 0;
      this.nav!.go(sim, p, best.x, best.y, best.z, {}, 0.6, 1, true);
    }
  }

  private planFlank(sim: MatchSim, p: PlayerState): void {
    const t = this.target, nav = this.nav!, g = this.hub!.bw.nav;
    if (!t) return;
    const bx = p.x - t.x, bz = p.z - t.z;
    const b = atan2(bx, bz);
    const side = this.rng.next() < 0.5 ? 1 : -1;
    const r = Math.max(12, Math.min(28, this.cfg.pers.range));
    for (let k = 0; k < 3; k++) {
      const a = b + side * (0.9 + this.rng.next() * 0.6) * (k === 1 ? -1 : 1);
      const fx = t.x + sin(a) * r, fz = t.z + cos(a) * r;
      const q = nearestNode(g, fx, terrainHeight(sim.world, fx, fz), fz, 8);
      if (q < 0 || !(g.flags[q] & NF.Land)) continue;
      nav.go(sim, p, g.x[q], g.y[q], g.z[q], {}, 1.5, 3, true, "flank");
      this.flankT = 10 + this.rng.next() * 5;
      return;
    }
    this.flankT = 0;
    this.setState(St.Engage, sim);
  }

  private pickHold(sim: MatchSim, p: PlayerState, s: St): void {
    const hub = this.hub!, g = hub.bw.nav, nav = this.nav!;
    if (s === St.Perch) {
      let best = -1, bs = 1e18;
      const pr = hub.bw.pois.perches;
      for (let i = 0; i < pr.length; i++) {
        if (this.visited.includes(pr[i].node)) continue;
        const dx = pr[i].x - p.x, dz = pr[i].z - p.z;
        const d = dx * dx + dz * dz;
        if (d > 180 * 180) continue;
        const sc = d - pr[i].prominence * 200 + this.rng.next() * 1500;
        if (sc < bs) { bs = sc; best = i; }
      }
      if (best < 0) { this.setState(St.Roam, sim); this.pickRoam(sim, p); return; }
      const q = pr[best];
      this.remember(q.node);
      nav.go(sim, p, q.x, q.y, q.z, {}, 1.2, 1, true, "perch");
      return;
    }
    // hide: a cave nook or a cover point near where the action was
    const useCave = hub.caveSpots.length > 0 && this.rng.next() < 0.45;
    if (useCave) {
      let best = -1, bs = 1e18;
      for (const q of hub.caveSpots) {
        if (this.visited.includes(q)) continue;
        const dx = g.x[q] - p.x, dz = g.z[q] - p.z;
        const d = dx * dx + dz * dz + this.rng.next() * 900;
        if (d < bs && d < 140 * 140) { bs = d; best = q; }
      }
      if (best >= 0) { this.remember(best); nav.go(sim, p, g.x[best], g.y[best], g.z[best], {}, 1.2, 1, true, "cave"); return; }
    }
    const cv = hub.bw.cover;
    for (let k = 0; k < 8; k++) {
      const i = this.rng.int(cv.count);
      const dx = cv.x[i] - p.x, dz = cv.z[i] - p.z;
      if (dx * dx + dz * dz > 90 * 90 || !cv.high[i]) continue;
      nav.go(sim, p, cv.x[i], cv.y[i], cv.z[i], {}, 0.8, 1, true, "hide");
      return;
    }
    this.setState(St.Roam, sim);
    this.pickRoam(sim, p);
  }

  private remember(node: number): void {
    this.visited.push(node);
    if (this.visited.length > 6) this.visited.shift();
  }

  private pickRoam(sim: MatchSim, p: PlayerState): void {
    this.held = false;
    const P = this.cfg.pers, hub = this.hub!, g = hub.bw.nav, nav = this.nav!, rng = this.rng;
    const opts: PathOptions = {};
    if (P.caution > 0.45) { opts.danger = hub.danger; opts.dangerWeight = P.caution; }
    if (rng.next() < P.vehicleLove * 0.5) opts.allow = DEFAULT_ACTS | actBit(Act.Vehicle);
    if (this.roamChain.length) {
      const nx = this.roamChain.shift()!;
      if (nx.vespa >= 0) {
        const v = sim.vehicles.find((q) => q.id === nx.vespa);
        if (v && v.seats[0] === -1 && hyp(v.x - p.x, v.z - p.z) < 25) { nav.rideVespa(v.id); this.setState(St.Ride, sim); }
      }
      nav.go(sim, p, nx.x, nx.y, nx.z, opts, 2, 1, true, "chain");
      return;
    }
    // weighted options
    const wRumor = 0.45 + 0.6 * P.aggression;
    const wHot = 0.5 * P.aggression;
    const wPick = 0.5 * P.curiosity;
    const wZip = hub.bw.pois.ziplineTops.length ? 0.4 * P.zipLove : 0;
    const vespa = P.vehicleLove > 0.3 ? Navigator.freeVespa(sim, p, 110) : null;
    const wVespa = vespa ? 0.45 * P.vehicleLove : 0;
    const wRand = 0.3;
    const total = wRumor + wHot + wPick + wZip + wVespa + wRand;
    let r = rng.next() * total;
    let gx = NaN, gy = 0, gz = 0;
    if ((r -= wRumor) < 0) {
      // "I heard there's someone over there": a live player's rough area
      const others = sim.players.filter((o) => o.alive && o.id !== this.id && !hub.ignore.has(o.id));
      if (others.length) {
        let o = others[rng.int(others.length)];
        // prefer somewhat nearby people
        for (let k = 0; k < 2; k++) {
          const o2 = others[rng.int(others.length)];
          if (hyp(o2.x - p.x, o2.z - p.z) < hyp(o.x - p.x, o.z - p.z)) o = o2;
        }
        // …and the humans: bots exist to keep people busy, not each other
        const humans = others.filter((q) => sim.info.get(q.id)?.isBot === false);
        if (humans.length && rng.next() < 0.45) o = humans[rng.int(humans.length)];
        const e = 12 + rng.next() * 20, a = rng.next() * 6.283;
        const q = nearestNode(g, o.x + sin(a) * e, o.y, o.z + cos(a) * e, 12);
        if (q >= 0) { gx = g.x[q]; gy = g.y[q]; gz = g.z[q]; }
      }
    } else if ((r -= wHot) < 0) {
      let bd = 0.15;
      for (let k = 0; k < 10; k++) {
        const q = randomReachablePoint(g, { x: p.x, y: p.y, z: p.z }, 140, rng, 6);
        if (!q) continue;
        const d = hub.danger.at(q.x, q.z);
        if (d > bd) { bd = d; gx = q.x; gy = q.y; gz = q.z; }
      }
    } else if ((r -= wPick) < 0) {
      const k = this.nearestPickup(sim, p, (kind, drop) => drop !== 0 || kind === PickupKind.Ammo ? p.reserve < 100 : (p.upgrades & (1 << kind)) === 0);
      if (k && hyp(k.x - p.x, k.z - p.z) > 4) { gx = k.x; gy = k.y; gz = k.z; }
    } else if ((r -= wZip) < 0) {
      const zs = hub.bw.pois.ziplineTops;
      let best = -1, bd = (150 + 150 * P.zipLove) ** 2;
      for (let i = 0; i < zs.length; i++) {
        const d = (zs[i].x - p.x) ** 2 + (zs[i].z - p.z) ** 2;
        if (d < bd && d > 25) { bd = d; best = i; }
      }
      if (best >= 0) {
        const z = zs[best];
        gx = z.x; gy = z.y; gz = z.z;
        this.roamChain.push({ x: g.x[z.bottom], y: g.y[z.bottom], z: g.z[z.bottom], vespa: -1 });
      }
    } else if ((r -= wVespa) < 0 && vespa) {
      // walk to the scooter, then ride it somewhere far
      const q = randomReachablePoint(g, { x: vespa.x, y: vespa.y, z: vespa.z }, 220, rng, 16);
      if (q && hyp(q.x - vespa.x, q.z - vespa.z) > 90) {
        gx = vespa.x; gy = vespa.y; gz = vespa.z;
        this.roamChain.push({ x: q.x, y: q.y, z: q.z, vespa: vespa.id });
      }
    }
    if (Number.isNaN(gx)) {
      const q = randomReachablePoint(g, { x: p.x, y: p.y, z: p.z }, 30 + rng.next() * 50, rng, 16);
      if (q) { gx = q.x; gy = q.y; gz = q.z; }
      else {
        // nowhere reachable from here (fell somewhere odd): wiggle toward the island centre
        gx = p.x * 0.8; gz = p.z * 0.8; gy = terrainHeight(sim.world, gx, gz);
      }
    }
    // long trip + a scooter nearby: ride it
    const far = hyp(gx - p.x, gz - p.z);
    if (far > 80 && rng.next() < P.vehicleLove * 0.75) {
      const v = Navigator.freeVespa(sim, p, 28);
      if (v) { nav.rideVespa(v.id); this.setState(St.Ride, sim); }
    }
    nav.go(sim, p, gx, gy, gz, opts, 2, 1, true, "roam");
  }

  // =================================================================== act
  private act(sim: MatchSim, p: PlayerState, dt: number): void {
    const mv = this.mv, nav = this.nav!;
    clearMove(mv);
    this.look = 0;
    if (this.reloadCd > 0) this.reloadCd -= dt;
    if (this.flankT > 0) this.flankT -= dt;
    if (this.holdT > 0) this.holdT -= dt;
    if (this.washDiveCd > 0) this.washDiveCd -= dt;
    const t = this.target;
    const tp = t ? sim.player(t.id) : undefined;
    let fight = false;
    switch (this.state) {
      case St.Engage:
        if (t && tp && t.visible) this.engageMove(sim, p, t, tp, dt);
        else nav.step(sim, p, dt, mv);
        fight = true;
        break;
      case St.Cover:
        this.coverMove(sim, p, dt);
        fight = true;
        break;
      case St.Wash:
        this.washMove(sim, p, dt);
        fight = p.move !== Move.Underwater && p.move !== Move.Swim;
        break;
      case St.Perch:
      case St.Hide:
        if (nav.status === NavStatus.Moving || nav.status === NavStatus.Planning) nav.step(sim, p, dt, mv);
        else this.scan(dt);
        fight = true;
        break;
      case St.Roam:
        if (this.holdT > 0) this.scan(dt);
        else nav.step(sim, p, dt, mv);
        fight = true;
        break;
      default:
        nav.step(sim, p, dt, mv);
        fight = true;
    }
    // arrived somewhere but the errand didn't resolve (pickup out of reach, nobody there): move on
    const errand = this.state === St.Upgrade || this.state === St.Ammo || this.state === St.Chase || this.state === St.Investigate || this.state === St.Flank;
    if (errand && nav.status === NavStatus.Arrived) {
      this.arrivedT += dt;
      if (this.arrivedT > (this.state === St.Chase || this.state === St.Investigate ? 3 : 1.5)) {
        if ((this.state === St.Upgrade || this.state === St.Ammo) && this.pickGoal >= 0) this.skipPickup(this.pickGoal, sim.time);
        if (this.target && !this.target.visible && (this.state === St.Chase || this.state === St.Flank)) this.target.seenT = NEVER;
        if (this.state === St.Investigate) this.alertT = NEVER;
        this.arrivedT = 0;
        this.setState(St.Roam, sim);
        this.pickRoam(sim, p);
      }
    } else this.arrivedT = 0;
    const navDone = nav.status === NavStatus.Failed || nav.status === NavStatus.Arrived;
    if (!navDone) this.navNoted = false;
    else if (!this.navNoted) {
      this.navNoted = true;
      if (this.state !== St.Engage && this.state !== St.Perch && this.state !== St.Hide) this.interrupt = true;
      if (nav.status === NavStatus.Failed && nav.fails > 2) {
        // hopeless goal: wander nearby instead
        const g = this.hub!.bw.nav;
        const q = randomReachablePoint(g, { x: p.x, y: p.y, z: p.z }, 14, this.rng, 10);
        if (q) nav.go(sim, p, q.x, q.y, q.z, {}, 1.5, 0, true, "wander");
        this.setState(St.Roam, sim);
      }
    }
    // shooting layer: any visible target in range gets shot at, whatever we're doing
    if (fight && t && tp && t.visible && p.hopper + p.reserve > 0) this.shoot(sim, p, t, tp, dt);
    else {
      this.burstLeft = 0;
      this.onTargetT = Math.max(0, this.onTargetT - dt * 2);
      this.lookAround(sim, p, dt);
    }
    // reloads: empty, or a tactical reload when nobody's in sight
    const cap = hopperCap(p);
    if (p.reload <= 0 && p.reserve > 0 && this.reloadCd <= 0) {
      const calm = !t || !t.visible;
      if (p.hopper === 0 || (calm && p.hopper < cap * 0.45 && this.rng.next() < this.cfg.skill.tactics) || (this.state === St.Cover && this.coverPhase === 1 && p.hopper < cap * 0.7)) {
        this.fireReload = true;
        this.reloadCd = 1.5;
      }
    }
  }
  private fireReload = false;
  private firing = false;
  private aiming = false;
  /** 0 = move-look, 1 = aiming at a target, 2 = scanning. */
  private look = 0;

  private engageMove(sim: MatchSim, p: PlayerState, t: Contact, o: PlayerState, dt: number): void {
    const S = this.cfg.skill, P = this.cfg.pers, mv = this.mv, nav = this.nav!;
    const dx = o.x - p.x, dz = o.z - p.z, d = hyp(dx, dz) || 1;
    const ux = dx / d, uz = dz / d;
    const pref = P.range * (hasUpgrade(p, PickupKind.Scope) || hasUpgrade(p, PickupKind.LongBarrel) ? 1.3 : 1) * (this.style === 2 ? 0.6 : 1);
    if (d > pref * 1.6 || (this.blockedT > 0.8 && d > 8)) {
      // close in along a path, aiming as we go
      nav.go(sim, p, o.x, o.y, o.z, {}, 3, 5, false, "engage");
      nav.step(sim, p, dt, mv);
      mv.sprint = mv.sprint && d > pref * 2.5 && this.burstLeft <= 0;
      return;
    }
    nav.stop();
    // strafe + range keeping
    this.strafeT -= dt;
    if (this.strafeT <= 0) {
      this.strafeT = 0.45 + this.rng.next() * 0.9;
      this.strafeDir = this.rng.next() < S.strafe ? (this.rng.next() < 0.5 ? 1 : -1) : 0;
      // standing still to settle the aim is a thing snipers do
      if (this.aiming && P.name === "sniper" && this.rng.next() < 0.6) this.strafeDir = 0;
    }
    let fwd = (d - pref) / pref;
    fwd = fwd > 1 ? 1 : fwd < -1 ? -1 : fwd;
    if (o.coats.length >= 2 && P.aggression > 0.6) fwd = Math.max(fwd, 0.6);
    // right = (-uz, ux) rotated from the target direction
    let mx = -uz * this.strafeDir + ux * fwd * 0.8;
    let mz = ux * this.strafeDir + uz * fwd * 0.8;
    const ml = hyp(mx, mz);
    if (ml > 1e-3) {
      mx /= ml; mz /= ml;
      if (!safeStep(sim, p, mx, mz)) {
        this.strafeDir = -this.strafeDir;
        mx = -uz * this.strafeDir + ux * fwd * 0.8;
        mz = ux * this.strafeDir + uz * fwd * 0.8;
        const l2 = hyp(mx, mz);
        if (l2 > 1e-3 && safeStep(sim, p, mx / l2, mz / l2)) { mx /= l2; mz /= l2; }
        else { mx = 0; mz = 0; }
      }
      mv.dx = mx; mv.dz = mz; mv.mag = hyp(mx, mz) > 0 ? 1 : 0;
    }
    // good players plant their feet for a mid-range burst
    if (this.burstLeft > 0 && d > 14) mv.mag *= 1 - S.plant;
    // the odd hop / slide, more from twitchy bots
    if (p.grounded && this.rng.next() < dt * 0.35 * S.strafe * (0.5 + P.aggression)) mv.jump = true;
  }

  private coverMove(sim: MatchSim, p: PlayerState, dt: number): void {
    const nav = this.nav!, mv = this.mv, cv = this.cover, S = this.cfg.skill;
    if (!cv) { nav.step(sim, p, dt, mv); return; }
    if (nav.status === NavStatus.Moving || nav.status === NavStatus.Planning) {
      nav.step(sim, p, dt, mv);
      return;
    }
    const t = this.target;
    this.coverT -= dt;
    const dx = cv.x - p.x, dz = cv.z - p.z;
    if (this.coverPhase === 0) {
      // arrived: settle in
      this.coverPhase = 1;
      this.coverT = 0.7 + this.rng.next() * 1.2;
    }
    if (this.coverPhase === 1) {
      // hiding: hug the spot, reload
      const d = hyp(dx, dz);
      if (d > 0.35) { mv.dx = dx / d; mv.dz = dz / d; mv.mag = Math.min(1, d); }
      if (this.coverT <= 0 && p.reload <= 0) {
        if (!cv.peek || !t || this.coverCycles >= 2 + (this.cfg.pers.patience * 3 | 0)) {
          // done hiding: fight it out or move on
          this.interrupt = true;
          this.cover = null;
          this.setState(St.Engage, sim);
          return;
        }
        this.coverPhase = 2;
        this.coverT = 0.9 + this.rng.next() * 1.3;
        this.coverCycles++;
        // which side has a view?
        const tx = t.x - cv.x, tz = t.z - cv.z, tl = hyp(tx, tz) || 1;
        const sx = -tz / tl, sz = tx / tl;
        this.peekSide = 1;
        for (const side of [1, -1]) {
          if (segmentClear(sim.env.cw, cv.x + sx * side * 0.9, cv.y + 1.45, cv.z + sz * side * 0.9, t.x, t.y + 1.2, t.z)) { this.peekSide = side; break; }
        }
      }
    } else {
      // peeking: step out sideways, shoot (shoot() runs since the target is visible)
      if (!t) { this.coverPhase = 1; return; }
      const tx = t.x - cv.x, tz = t.z - cv.z, tl = hyp(tx, tz) || 1;
      const px = cv.x - (tz / tl) * this.peekSide * 1.0, pz = cv.z + (tx / tl) * this.peekSide * 1.0;
      const ex = px - p.x, ez = pz - p.z, el = hyp(ex, ez);
      if (el > 0.25) { mv.dx = ex / el; mv.dz = ez / el; mv.mag = Math.min(1, el * 1.5); }
      if (this.coverT <= 0 || (p.hopper === 0) || (this.lastHitT > sim.time - dt * 1.5 && S.tactics > 0.5)) {
        this.coverPhase = 1;
        this.coverT = 0.6 + this.rng.next() * 1.4;
      }
    }
  }

  private washMove(sim: MatchSim, p: PlayerState, dt: number): void {
    const nav = this.nav!, mv = this.mv;
    if (p.coats.length === 0) {
      if (p.move === Move.Underwater) mv.jump = true;
      this.interrupt = true;
      return;
    }
    const inWater = p.move === Move.Swim || p.move === Move.Underwater;
    if (!inWater || !this.deepHere(sim, p)) {
      if (!nav.hasGoal && nav.status !== NavStatus.Arrived) this.interrupt = true;
      nav.step(sim, p, dt, mv);
      if (p.move === Move.Underwater) mv.jump = false;
      if (nav.status === NavStatus.Arrived && !inWater) this.interrupt = true;
      return;
    }
    nav.stop();
    const breathLeft = p.breath * BREATH_TIME * (hasUpgrade(p, PickupKind.Snorkel) ? SNORKEL_MULT : 1);
    if (p.move === Move.Swim) {
      // surface: catch a breath, then dive
      if (p.gasp <= 0 && p.breath > 0.5 && this.washDiveCd <= 0) {
        mv.crouch = true;
        this.washDiveCd = 1;
        this.stats.dives++;
      }
      return;
    }
    // underwater: stay down while there's paint and breath
    if (breathLeft > 1.0) mv.crouch = true;
    else mv.jump = true;
  }

  // =================================================================== shooting
  private shoot(sim: MatchSim, p: PlayerState, t: Contact, o: PlayerState, dt: number): void {
    const S = this.cfg.skill;
    this.look = 1;
    const dx = o.x - p.x, dz = o.z - p.z;
    const d = Math.sqrt(dx * dx + dz * dz + (o.y - p.y) * (o.y - p.y));
    const scope = hasUpgrade(p, PickupKind.Scope);
    const range = S.maxRange * (scope ? 1.25 : 1);
    // refresh the ballistic solution at 20 Hz
    this.solveT -= dt;
    if (this.solveT <= 0 || this.solvedFor !== t.id) {
      this.solveT = SOLVE_EVERY / 60;
      if (this.solvedFor !== t.id) {
        this.leadK = S.lead * (1 + (this.rng.next() * 2 - 1) * S.leadNoise);
        this.onTargetT = 0;
      }
      const fresh = this.solvedFor !== t.id;
      const py = this.wantYaw, pp = this.wantPitch;
      this.solvedFor = t.id;
      this.solveAim(sim, p, t, o);
      // how fast the aim point slides (feed-forward for tracking), smoothed
      const k = fresh ? 0 : 0.5;
      const iv = 60 / SOLVE_EVERY;
      this.wantVy = fresh ? 0 : this.wantVy * k + wrapAngle(this.wantYaw - py) * iv * (1 - k);
      this.wantVp = fresh ? 0 : this.wantVp * k + (this.wantPitch - pp) * iv * (1 - k);
    } else {
      // between solutions: slide the aim point along
      this.wantYaw = wrapAngle(this.wantYaw + this.wantVy * dt);
      this.wantPitch += this.wantVp * dt;
    }
    // error model
    const spd = hyp(o.vx, o.vz);
    const meSpd = hyp(p.vx, p.vz);
    const settle = Math.min(1, this.onTargetT / S.settleTime);
    // movers are harder, less so for players who track well
    let mag = S.aimErr * (1 + (spd / 7) * (1.2 - S.track)) * (0.8 + d / 60) * (1 - (1 - S.settleFloor) * settle);
    if (meSpd > 2) mag *= 1.3;
    if (!p.grounded && p.move !== Move.Vehicle) mag *= 1.7;
    if (sim.time - this.lastHitT < 1) mag *= 1.4;
    this.aim.drift(dt, mag, this.rng);
    const wy = this.wantYaw + this.aim.ex, wp = this.wantPitch + this.aim.ey;
    const tol = Math.max(0.01, 0.42 / Math.max(d, 1)) * (this.cfg.difficulty === 0 ? 1.8 : this.cfg.difficulty === 1 ? 1.3 : 1);
    const ey = Math.abs(wrapAngle(this.aim.yaw - wy)), ep = Math.abs(this.aim.pitch - wp);
    const onTarget = ey < tol && ep < tol;
    if (onTarget && this.aim.speed < 2.5) this.onTargetT += dt;
    else this.onTargetT = Math.max(0, this.onTargetT - dt * 1.5);
    this.aiming = this.useAds && d > 14 && canShootIn(p.move) && p.move !== Move.Slide && this.state !== St.Wash;
    // burst fire
    const canFire = canShootIn(p.move) && !(p.move === Move.Vehicle && p.seat === 0) && p.reload <= 0 && p.hopper > 0 &&
      d < range && (this.shootable || this.lob) && o.shield <= 0.2;
    if (p.shotSeq !== this.lastSeqShot) {
      const shots = p.shotSeq - this.lastSeqShot;
      this.lastSeqShot = p.shotSeq;
      if (this.burstLeft > 0) {
        this.burstLeft -= shots;
        if (this.burstLeft <= 0) {
          this.burstPause = S.pauseMin + this.rng.next() * (S.pauseMax - S.pauseMin);
          if (d > 35) this.burstPause *= 1.3;
          this.onTargetT *= 0.7; // recoil-ish: re-settle a little
        }
      }
      const b = Math.min(7, (d / 10) | 0);
      this.stats.shotsAt[b] += shots;
      if (this.lob) this.stats.lobs += shots;
    }
    if (this.burstPause > 0) { this.burstPause -= dt; return; }
    if (!canFire) return;
    // fire discipline: disciplined players don't spray at far runners unless settled on them
    if (d > 35 && S.tactics > 0.5 && spd > 4 && !scope && this.onTargetT < S.settleTime) return;
    if (this.burstLeft <= 0) {
      // wait for the aim to be on before opening up
      if (!onTarget && !(ey < tol * 2.5 && this.rng.next() < dt * (3 - this.cfg.difficulty))) return;
      this.burstLeft = S.burstMin + this.rng.int(S.burstMax - S.burstMin + 1) + (hasUpgrade(p, PickupKind.RapidFire) ? 2 : 0);
      if (sim.time - this.lastFireT > 8) this.stats.fights++;
      this.leadK = S.lead * (1 + (this.rng.next() * 2 - 1) * S.leadNoise);
    }
    this.firing = true;
    this.lastFireT = sim.time;
    this.stats.lastShotDist = d;
    this.stats.lastShotTarget = t.id;
  }

  /** Ballistic solution: lead the target, pick direct or lob, convert to crosshair angles. */
  private solveAim(sim: MatchSim, p: PlayerState, t: Contact, o: PlayerState): void {
    const eyeY = p.y + (p.move === Move.Vehicle ? 1.25 : eyeHeight(p.move));
    _from.x = p.x; _from.y = eyeY - 0.42; _from.z = p.z;
    _to.x = o.x; _to.y = bodyAimY(o); _to.z = o.z;
    const k = this.leadK;
    _vel.x = t.vx * k; _vel.y = (o.grounded ? 0 : t.vy * k * 0.5); _vel.z = t.vz * k;
    const speed = ballSpeed(p);
    const sols = ballisticAim(_from, _to, _vel, speed, BALL_GRAVITY, BALL_LIFE - 0.1);
    const cw = sim.env.cw;
    this.shootable = false;
    this.lob = false;
    let ax = _to.x, ay = _to.y, az = _to.z;
    if (sols.length) {
      const s0 = sols[0];
      ax = s0.x; ay = s0.y; az = s0.z;
      _dir.x = s0.dx; _dir.y = s0.dy; _dir.z = s0.dz;
      const tr = trajectoryClear(cw, _from, _dir, speed, BALL_GRAVITY, Math.max(0.01, s0.t - 0.9 / speed));
      this.shootable = tr.clear;
      if (!tr.clear && sols.length > 1) {
        const s1 = sols[1];
        _dir.x = s1.dx; _dir.y = s1.dy; _dir.z = s1.dz;
        const tl = trajectoryClear(cw, _from, _dir, speed, BALL_GRAVITY, Math.max(0.01, s1.t - 0.9 / speed));
        if (tl.clear) { this.lob = true; ax = s1.x; ay = s1.y; az = s1.z; }
      }
    }
    if (this.shootable || this.lob) this.blockedT = 0;
    else this.blockedT += SOLVE_EVERY / 60;
    solveCrosshair(sim, p, this.scratch, ax, ay, az, this.sol);
    if (Number.isFinite(this.sol.yaw) && Number.isFinite(this.sol.pitch)) {
      this.wantYaw = this.sol.yaw;
      this.wantPitch = this.sol.pitch;
    }
  }

  // =================================================================== looking
  private scan(dt: number): void {
    this.look = 2;
    this.glanceT -= dt;
    if (this.glanceT <= 0) {
      this.glanceT = 1.2 + this.rng.next() * 2.2;
      this.glanceYaw = wrapAngle(this.aim.yaw + (this.rng.next() * 2 - 1) * 1.6);
    }
  }

  private lookYaw = 0;
  private lookPitch = 0;

  private lookAround(sim: MatchSim, p: PlayerState, dt: number): void {
    const now = sim.time, mv = this.mv;
    this.firing = false;
    this.aiming = false;
    const t = this.target;
    if (now - this.alertT < 1.6) {
      const dx = this.alertX - p.x, dz = this.alertZ - p.z;
      this.lookYaw = atan2(dx, dz);
      this.lookPitch = atan2(this.alertY - (p.y + 1.45), hyp(dx, dz) || 1) * 0.5;
      return;
    }
    if (t && !t.visible && now - t.seenT < 2.5) {
      // keep watching where they went
      const dx = t.x - p.x, dz = t.z - p.z;
      this.lookYaw = atan2(dx, dz);
      this.lookPitch = 0;
      this.aiming = this.useAds && this.cfg.pers.name === "sniper";
      return;
    }
    if (this.look === 2) {
      this.lookYaw = this.glanceYaw;
      this.lookPitch = -0.04;
      return;
    }
    if (mv.mag > 0.1 && !mv.drive) {
      let y = atan2(mv.dx, mv.dz);
      // glance around every few seconds (spots people, looks alive)
      this.glanceT -= dt;
      if (this.glanceT <= 0) {
        this.glanceT = 1.4 + this.rng.next() * 2.4;
        this.glanceDur = 0.45 + this.rng.next() * 0.5;
        this.glanceYaw = (this.rng.next() < 0.5 ? -1 : 1) * (0.8 + this.rng.next() * 1.3);
      }
      if (this.glanceDur > 0) { this.glanceDur -= dt; y += this.glanceYaw; }
      this.lookYaw = y;
      this.lookPitch = p.move === Move.Swim ? 0 : -0.06;
    } else if (p.move === Move.Vehicle) {
      const v = sim.vehicles.find((q) => q.id === p.vehicle);
      if (v) this.lookYaw = v.yaw;
      this.lookPitch = -0.05;
    }
  }

  // =================================================================== compose the cmd
  private compose(p: PlayerState, dt: number): void {
    const c = this.cmd, S = this.cfg.skill, mv = this.mv;
    // crosshair
    if (this.look === 1) {
      this.aim.step(dt, this.wantYaw + this.aim.ex, this.wantPitch + this.aim.ey, S.aimFreq, S.aimDamp, S.turnSpeed, this.wantVy * S.track, this.wantVp * S.track);
    } else {
      this.aim.ex *= 0.9; this.aim.ey *= 0.9;
      this.aim.step(dt, this.lookYaw, this.lookPitch, S.aimFreq * 0.45, 0.9, S.turnSpeed * 0.6);
    }
    c.yaw = this.aim.yaw;
    c.pitch = this.aim.pitch;
    // movement relative to where we look
    if (mv.drive) {
      c.moveZ = mv.throttle;
      c.moveX = mv.steer;
    } else if (mv.mag > 0) {
      const fy = c.yaw, sy = sin(fy), cy = cos(fy);
      // forward (sin, cos); right (-cos, sin)
      c.moveZ = (mv.dx * sy + mv.dz * cy) * mv.mag;
      c.moveX = (-mv.dx * cy + mv.dz * sy) * mv.mag;
    }
    let b = 0;
    if (mv.sprint && c.moveZ > 0.5 && !this.aiming && !this.firing && p.stamina > 0.15) b |= Btn.Sprint;
    // jump: hold ~0.3 s for a full-height jump, then release for at least a step
    if (mv.jump && this.jumpHold <= 0 && !this.jumpGap && !(this.prevButtons & Btn.Jump)) this.jumpHold = 0.3;
    if (this.jumpHold > 0) {
      this.jumpHold -= dt;
      b |= Btn.Jump;
      if (this.jumpHold <= 0) this.jumpGap = true;
    } else this.jumpGap = false;
    if (p.move === Move.Underwater && mv.jump) b |= Btn.Jump;
    if (mv.crouch) b |= Btn.Crouch;
    if (mv.interact && !(this.prevButtons & Btn.Interact)) b |= Btn.Interact;
    if (this.firing) b |= Btn.Fire;
    if (this.aiming) b |= Btn.Aim;
    if (this.fireReload) { if (!(this.prevButtons & Btn.Reload)) b |= Btn.Reload; this.fireReload = false; }
    c.buttons |= b;
    this.firing = false;
    // NaN guard: never hand the sim garbage
    if (!Number.isFinite(c.yaw)) { c.yaw = 0; this.aim.reset(p.yaw, 0); }
    if (!Number.isFinite(c.pitch)) c.pitch = 0;
    if (!Number.isFinite(c.moveX)) c.moveX = 0;
    if (!Number.isFinite(c.moveZ)) c.moveZ = 0;
    c.moveX = c.moveX > 1 ? 1 : c.moveX < -1 ? -1 : c.moveX;
    c.moveZ = c.moveZ > 1 ? 1 : c.moveZ < -1 ? -1 : c.moveZ;
    this.prevButtons = c.buttons;
  }
}
