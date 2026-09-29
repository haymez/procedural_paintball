// The authoritative match simulation. Pure TS: runs in the browser (offline
// "listen server"), in the Room Durable Object and under Node for tests.
//
//   const sim = new MatchSim(world, { durationSec: 600 });
//   sim.addPlayer(1, { name: "Pesce Veloce", color: 0xff9eb5, isBot: false });
//   sim.applyInput(1, cmd);          // one InputCmd per player per tick (queued)
//   sim.step();                      // fixed TICK_DT
//   for (const e of sim.events) ...; sim.events.length = 0;
//   sim.snapshot()                   // live read-only view for rendering / snapshots
import { Rng } from "../math/rng";
import { atan2, cos, sin } from "../math/trig";
import { raycast, terrainHeight, type Vec3 } from "../world/collide";
import { PickupKind, VehicleKind, type World } from "../world/types";
import * as C from "./constants";
import { createEnv, dist, NO_WATER_Y, probeGround, waterAt, zipPoint, BLOCKED, type SimEnv } from "./env";
import { bodyHeight, canShootIn, createPlayerState, stepPlayer } from "./player";
import { canBoard, createVehicleState, HULL, resetVehicle, seatWorld, stepVehicle, vehicleVerb, VEHICLE_NAMES } from "./vehicle";
import { computeLaunch, currentSpread, fireInterval, hopperCap, shotRandom, type Launch } from "./weapon";
import { ActionLog, HOT_W, type HotZone } from "./hotzones";
import { dropSite, type DropSite } from "./skydrop";
import {
  Btn, emptyCmd, Fx, Move, Style,
  type InputCmd, type PickupState, type PlayerInfo, type PlayerState, type ProjectileState, type SimEvent, type SimSnapshot, type VehicleState,
} from "./types";

export interface MatchOptions {
  durationSec?: number;
  /** Reuse an existing env (collision build is ~100 ms). */
  env?: SimEnv;
  seed?: number;
}

export type InteractKind = "vehicle" | "zip" | "pickup" | "exit";
export interface InteractTarget {
  kind: InteractKind;
  id: number;
  seat: number;
  label: string;
  dist: number;
}

const _v: Vec3 = { x: 0, y: 0, z: 0 };
const _w: Vec3 = { x: 0, y: 0, z: 0 };
const _launch: Launch = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, tx: 0, ty: 0, tz: 0 };
const _zones: HotZone[] = [];

const UPGRADE_NAMES: Record<PickupKind, string> = {
  [PickupKind.Ammo]: "paint",
  [PickupKind.BigHopper]: "Big Hopper",
  [PickupKind.RapidFire]: "Rapid Fire",
  [PickupKind.LongBarrel]: "Long Barrel",
  [PickupKind.Scope]: "Scope",
  [PickupKind.Vest]: "Vest",
  [PickupKind.QuickFeet]: "Quick Feet",
  [PickupKind.Snorkel]: "Snorkel",
};
export function upgradeName(k: PickupKind): string {
  return UPGRADE_NAMES[k];
}

export class MatchSim {
  readonly world: World;
  readonly env: SimEnv;
  readonly duration: number;
  tick = 0;
  time = 0;
  ended = false;
  readonly players: PlayerState[] = [];
  readonly info = new Map<number, PlayerInfo>();
  readonly projectiles: ProjectileState[] = [];
  readonly pickups: PickupState[] = [];
  readonly vehicles: VehicleState[] = [];
  /** Events produced since the consumer last cleared this array. */
  readonly events: SimEvent[] = [];
  private queues = new Map<number, InputCmd[]>();
  private last = new Map<number, InputCmd>();
  private rng: Rng;
  private nextProj = 1;
  private nextPickup: number;
  private snap: SimSnapshot;
  private driverCmd: (InputCmd | null)[] = [];
  /**
   * Lag compensation (set by the network host): the state of target `o` as
   * `owner` saw it when shooting ball `proj` (0 = the aim ray at fire time).
   * Return `o` for no rewind, null to skip the target. Null hook = no rewind.
   */
  lagView: ((owner: number, proj: number, o: PlayerState) => PlayerState | null) | null = null;
  /** Recent hits and eliminations (hot zones for sky drops: bots steer into the action). */
  readonly action = new ActionLog();
  /** Where sky drops start (island middle, altitude). */
  readonly drop: DropSite;

  constructor(world: World, opts: MatchOptions = {}) {
    this.world = world;
    this.env = opts.env ?? createEnv(world);
    this.duration = opts.durationSec ?? C.MATCH_SECONDS;
    this.rng = new Rng((opts.seed ?? world.seed) ^ 0x6d617463);
    world.pickups.forEach((p, i) => {
      const g = probeGround(this.env, p.x, p.y + 1.5, p.z, 4);
      this.pickups.push({ id: i, kind: p.kind, x: p.x, y: g === BLOCKED || g === -Infinity ? p.y : g, z: p.z, active: true, respawn: 0, drop: 0, ttl: 0 });
    });
    this.nextPickup = world.pickups.length;
    this.drop = dropSite(world);
    world.vehicles.forEach((v, i) => this.vehicles.push(createVehicleState(i, v, this.env)));
    const self = this;
    this.snap = {
      get tick() { return self.tick; },
      get time() { return self.time; },
      get timeLeft() { return Math.max(0, self.duration - self.time); },
      get ended() { return self.ended; },
      players: this.players,
      info: this.info,
      projectiles: this.projectiles,
      pickups: this.pickups,
      vehicles: this.vehicles,
      ziplines: this.env.ziplines,
      spawns: world.spawns,
    };
  }

  // ---------------------------------------------------------------- players
  addPlayer(id: number, info: Omit<PlayerInfo, "id">): PlayerState {
    const existing = this.player(id);
    if (existing) return existing;
    const p = createPlayerState(id);
    this.players.push(p);
    this.info.set(id, { id, ...info });
    this.queues.set(id, []);
    // everybody starts the match (or joins it) dropping in from the sky
    this.skyDrop(p);
    this.events.push({ type: "join", pid: id });
    return p;
  }

  removePlayer(id: number): void {
    const i = this.players.findIndex((p) => p.id === id);
    if (i < 0) return;
    const p = this.players[i];
    this.leaveVehicle(p, false);
    this.players.splice(i, 1);
    this.info.delete(id);
    this.queues.delete(id);
    this.last.delete(id);
    this.events.push({ type: "leave", pid: id });
  }

  player(id: number): PlayerState | undefined {
    for (const p of this.players) if (p.id === id) return p;
    return undefined;
  }

  /** Queue one input for the player's next step (keeps at most 8). */
  applyInput(id: number, cmd: InputCmd): void {
    const q = this.queues.get(id);
    if (!q) return;
    if (q.length >= 8) q.shift();
    q.push(cmd);
  }

  snapshot(): SimSnapshot {
    return this.snap;
  }

  results(): { id: number; name: string; color: number; bot: boolean; score: number; deaths: number; style: number }[] {
    return this.players
      .map((p) => {
        const i = this.info.get(p.id)!;
        return { id: p.id, name: i.name, color: i.color, bot: i.isBot, score: p.score, deaths: p.deaths, style: p.style };
      })
      .sort((a, b) => b.score - a.score || a.deaths - b.deaths || b.style - a.style);
  }

  // ---------------------------------------------------------------- step
  step(dt: number = C.TICK_DT): void {
    if (this.ended) return;
    this.tick++;
    this.time += dt;
    const nv = this.vehicles.length;
    this.driverCmd.length = nv;
    for (let i = 0; i < nv; i++) this.driverCmd[i] = null;

    for (const p of this.players) {
      const q = this.queues.get(p.id)!;
      let cmd = q.shift();
      if (cmd) this.last.set(p.id, cmd);
      else cmd = this.last.get(p.id) ?? emptyCmd();
      const pressed = cmd.buttons & ~p.prevButtons;
      if (!p.alive) {
        p.prevButtons = cmd.buttons;
        p.yaw = cmd.yaw; p.pitch = cmd.pitch;
        this.stepDead(p, dt);
        continue;
      }
      if (p.move === Move.Vehicle && p.seat === 0) {
        const vi = this.vehicleIndex(p.vehicle);
        if (vi >= 0) this.driverCmd[vi] = cmd;
      }
      const fx = stepPlayer(p, cmd, dt, this.env);
      if (fx) this.moveEvent(p, fx);
      if (p.shield > 0) p.shield -= dt;
      if (pressed & Btn.Interact) this.interact(p);
      this.stepWeapon(p, cmd, pressed, dt);
      this.stepPaint(p, dt);
      if (p.y < -80) this.skyDrop(p);
    }

    for (let i = 0; i < nv; i++) {
      const v = this.vehicles[i];
      const bump = stepVehicle(v, this.driverCmd[i], dt, this.env);
      if (bump > 0) this.events.push({ type: "vehicleBump", vehicle: v.id, speed: bump });
      let occ = false;
      for (let s = 0; s < v.seats.length; s++) {
        const pid = v.seats[s];
        if (pid < 0) continue;
        const p = this.player(pid);
        if (!p || !p.alive || p.vehicle !== v.id) { v.seats[s] = -1; continue; }
        occ = true;
        seatWorld(v, s, _v);
        const vx = sin(v.yaw) * v.speed, vz = cos(v.yaw) * v.speed;
        p.x = _v.x; p.y = _v.y; p.z = _v.z; p.vx = vx; p.vy = v.vy; p.vz = vz;
        p.grounded = true;
      }
      if (occ) v.idle = 0;
      else {
        v.idle += dt;
        if (v.idle > C.VEHICLE_ABANDON) {
          const dx = v.x - v.sx, dz = v.z - v.sz;
          if (dx * dx + dz * dz > 225 && !this.anyoneNear(v.x, v.z, 25) && !this.anyoneNear(v.sx, v.sz, 12)) {
            resetVehicle(v, this.env);
            this.events.push({ type: "vehicleReset", vehicle: v.id });
          } else v.idle = C.VEHICLE_ABANDON * 0.8;
        }
      }
    }

    this.stepProjectiles(dt);
    this.stepPickups(dt);

    if (this.time >= this.duration) {
      this.ended = true;
      this.events.push({ type: "matchEnd" });
    }
  }

  // ---------------------------------------------------------------- movement events
  private moveEvent(p: PlayerState, fx: number): void {
    const s = Math.sqrt(p.vx * p.vx + p.vy * p.vy + p.vz * p.vz);
    this.events.push({ type: "move", pid: p.id, fx, x: p.x, y: p.y, z: p.z, speed: s });
    if (fx & Fx.ZipEnd) this.events.push({ type: "zipEnd", pid: p.id, zip: -1 });
  }

  // ---------------------------------------------------------------- death / respawn
  private stepDead(p: PlayerState, dt: number): void {
    p.deadT += dt;
    if (p.deadT >= C.RESPAWN_DELAY) this.skyDrop(p);
  }

  /** Back to life with a fresh loadout (position and movement are the caller's). */
  private revive(p: PlayerState): void {
    this.leaveVehicle(p, false);
    p.vx = 0; p.vy = 0; p.vz = 0;
    p.moveT = 0; p.grounded = false; p.coyote = 0; p.dived = false; p.jumpBuf = 0;
    p.alive = true;
    p.coats.length = 0; p.coatBy.length = 0;
    p.upgrades = 0;
    p.hopper = C.HOPPER; p.reserve = C.RESERVE_START; p.reload = 0; p.fireCd = 0.3;
    p.shield = C.SPAWN_SHIELD;
    p.breath = 1; p.gasp = 0; p.wash = 0; p.paintT = 0; p.stamina = 1; p.exhausted = false; p.stumble = 0;
    p.deadT = 0;
    p.zip = -1; p.vehicle = -1; p.seat = -1;
  }

  /** Respawn on the ground at a spawn point (tests, debug; normal respawns are sky drops). */
  respawn(p: PlayerState, spawnIndex: number, at?: { x: number; y: number; z: number }): void {
    const s = at ?? this.world.spawns[spawnIndex] ?? { x: 0, y: 50, z: 0 };
    let y = s.y;
    const g = probeGround(this.env, s.x, s.y + 3, s.z, 10);
    if (g !== BLOCKED && g !== -Infinity) y = g;
    this.revive(p);
    p.x = s.x; p.y = y + 0.05; p.z = s.z;
    p.move = Move.Air;
    // face the island centre-ish so you don't spawn staring at a wall of sea
    p.yaw = atan2(-p.x, -p.z);
    this.events.push({ type: "respawn", pid: p.id, x: p.x, y: p.y, z: p.z });
  }

  /**
   * Sky drop: appear high over the middle of the island, gliding (Move.Glide)
   * wherever you steer, facing the action. Shielded until DROP_LAND_SHIELD s
   * after touching down.
   */
  skyDrop(p: PlayerState): void {
    const d = this.drop;
    this.revive(p);
    const a = this.rng.next() * 6.283185307179586, r = Math.sqrt(this.rng.next()) * C.DROP_SCATTER;
    p.x = d.cx + sin(a) * r;
    p.z = d.cz + cos(a) * r;
    p.y = d.y;
    p.move = Move.Glide;
    p.shield = C.DROP_LAND_SHIELD;
    // face the hottest fight, else the other players, else the island's middle
    const hot = this.action.zones(this.time, _zones, 1)[0];
    let tx = d.cx, tz = d.cz, n = 0;
    if (hot) { tx = hot.x; tz = hot.z; } else {
      let sx = 0, sz = 0;
      for (const o of this.players) if (o !== p && o.alive && o.move !== Move.Glide) { sx += o.x; sz += o.z; n++; }
      if (n) { tx = sx / n; tz = sz / n; }
    }
    const fx = tx - p.x, fz = tz - p.z;
    p.yaw = fx * fx + fz * fz > 25 ? atan2(fx, fz) : this.rng.next() * 6.283185307179586;
    this.events.push({ type: "respawn", pid: p.id, x: p.x, y: p.y, z: p.z });
  }

  private eliminate(victim: PlayerState, killer: PlayerState | undefined, x: number, y: number, z: number): void {
    let tags = 0;
    let d = 0;
    if (killer && killer !== victim) {
      { const ex = killer.x - victim.x, ey = killer.y - victim.y, ez = killer.z - victim.z; d = Math.sqrt(ex * ex + ey * ey + ez * ez); }
      if (killer.move === Move.Air || killer.move === Move.Dive) tags |= Style.Airborne;
      if (d > 35) tags |= Style.Longshot;
      if (killer.move === Move.Vehicle) tags |= Style.FromVehicle;
      if (killer.move === Move.Zipline) tags |= Style.Zipline;
      if (killer.move === Move.Slide) tags |= Style.Sliding;
      if (victim.move === Move.Swim || victim.move === Move.Underwater) tags |= Style.Swimmer;
      if (killer.lastKiller === victim.id) { tags |= Style.Revenge; killer.lastKiller = -1; }
      killer.score++;
      killer.streak++;
      if (killer.streak >= 3) tags |= Style.Streak;
      let bits = tags, n = 0;
      while (bits) { n += bits & 1; bits >>= 1; }
      killer.style += n;
    }
    victim.deaths++;
    victim.streak = 0;
    victim.lastKiller = killer && killer !== victim ? killer.id : -1;
    if (victim.upgrades) {
      const id = this.nextPickup++;
      // pick the "headline" upgrade for the visual
      let kind = PickupKind.Vest;
      for (let k = 1; k <= 7; k++) if (victim.upgrades & (1 << k)) { kind = k as PickupKind; break; }
      const g = probeGround(this.env, victim.x, victim.y + 1, victim.z, 30);
      const W = waterAt(this.env, victim.x, victim.z);
      let py = g === BLOCKED || g === -Infinity ? victim.y : g;
      if (W !== NO_WATER_Y && W > py) py = W; // floats
      this.pickups.push({ id, kind, x: victim.x, y: py, z: victim.z, active: true, respawn: 0, drop: victim.upgrades, ttl: C.DROP_LIFETIME });
    }
    this.leaveVehicle(victim, false);
    victim.zip = -1;
    victim.alive = false;
    victim.move = Move.Dead;
    victim.moveT = 0;
    victim.vx = 0; victim.vy = 0; victim.vz = 0;
    victim.deadT = 0;
    victim.upgrades = 0;
    victim.reload = 0;
    this.action.add(this.time, x, z, HOT_W.elim);
    this.events.push({ type: "elim", victim: victim.id, killer: killer ? killer.id : -1, x, y, z, tags, place: this.placeName(victim.x, victim.z), dist: d });
  }

  placeName(x: number, z: number): string {
    let best = "", bd = 180 * 180;
    for (const l of this.world.landmarks) {
      const dx = l.x - x, dz = l.z - z;
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = l.name; }
    }
    return best || this.world.name;
  }

  // ---------------------------------------------------------------- paint wear + washing
  private stepPaint(p: PlayerState, dt: number): void {
    if (p.coats.length === 0) { p.wash = 0; p.paintT = 0; return; }
    // wears off by itself: PAINT_WEAR_DELAY after the last hit, then a coat every PAINT_WEAR_TIME
    p.paintT += dt;
    if (p.paintT >= C.PAINT_WEAR_DELAY + C.PAINT_WEAR_TIME) {
      const color = p.coats.pop()!;
      p.coatBy.pop();
      p.paintT = p.coats.length ? C.PAINT_WEAR_DELAY : 0;
      this.events.push({ type: "wear", pid: p.id, coats: p.coats.length, color });
      if (p.coats.length === 0) { p.wash = 0; return; }
    }
    if (p.move !== Move.Underwater) return;
    // fully submerged: head under the surface
    if (p.y + 1.1 > p.waterY) return;
    p.wash += dt;
    if (p.wash >= C.WASH_TIME) {
      p.wash = 0;
      const color = p.coats.pop()!;
      p.coatBy.pop();
      this.events.push({ type: "wash", pid: p.id, coats: p.coats.length, color });
    }
  }

  // ---------------------------------------------------------------- weapon
  private stepWeapon(p: PlayerState, cmd: InputCmd, pressed: number, dt: number): void {
    if (p.fireCd > 0) p.fireCd -= dt;
    const cap = hopperCap(p);
    if (p.reload > 0) {
      p.reload -= dt;
      if (p.reload <= 0) {
        p.reload = 0;
        const take = Math.min(cap - p.hopper, p.reserve);
        p.hopper += take;
        p.reserve -= take;
        this.events.push({ type: "reloaded", pid: p.id });
      }
      return;
    }
    const driver = p.move === Move.Vehicle && p.seat === 0;
    if ((pressed & Btn.Reload) && p.hopper < cap && p.reserve > 0) {
      p.reload = C.RELOAD_TIME;
      this.events.push({ type: "reload", pid: p.id });
      return;
    }
    if (!(cmd.buttons & Btn.Fire) || driver || !canShootIn(p.move) || p.fireCd > 0) return;
    if (p.hopper <= 0) {
      if (p.reserve > 0) {
        p.reload = C.RELOAD_TIME;
        this.events.push({ type: "reload", pid: p.id });
      } else if (pressed & Btn.Fire) this.events.push({ type: "empty", pid: p.id });
      return;
    }
    this.fire(p);
  }

  private fire(p: PlayerState): void {
    const spread = currentSpread(p);
    const u1 = shotRandom(p.id, p.shotSeq, 1), u2 = shotRandom(p.id, p.shotSeq, 2);
    const L = computeLaunch(this.env, p, spread, u1, u2, _launch, (ox, oy, oz, dx, dy, dz, maxT) => this.rayPlayers(p.id, ox, oy, oz, dx, dy, dz, maxT));
    p.shotSeq++;
    p.hopper--;
    p.fireCd += fireInterval(p);
    if (p.fireCd < 0) p.fireCd = 0;
    const color = this.info.get(p.id)?.color ?? 0xffffff;
    const id = this.nextProj++;
    this.projectiles.push({ id, owner: p.id, color, x: L.x, y: L.y, z: L.z, vx: L.vx, vy: L.vy, vz: L.vz, age: 0 });
    // spawn shield ends when you start shooting
    if (p.shield > 0) p.shield = Math.min(p.shield, 0.15);
    this.events.push({ type: "shot", pid: p.id, proj: id, x: L.x, y: L.y, z: L.z, vx: L.vx, vy: L.vy, vz: L.vz, color });
  }

  /** Ray vs living player hit capsules (excluding `skip`): distance or Infinity. */
  rayPlayers(skip: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): number {
    let best = Infinity;
    for (const o of this.players) {
      if (o.id === skip || !o.alive) continue;
      const v = this.lagView ? this.lagView(skip, 0, o) : o;
      if (!v) continue;
      const t = segCapsule(ox, oy, oz, dx * maxT, dy * maxT, dz * maxT, v, C.HIT_R * 0.8);
      if (t >= 0 && t * maxT < best) best = t * maxT;
    }
    return best;
  }

  // ---------------------------------------------------------------- projectiles
  private stepProjectiles(dt: number): void {
    const list = this.projectiles;
    for (let i = list.length - 1; i >= 0; i--) {
      const b = list[i];
      b.age += dt;
      const ox = b.x, oy = b.y, oz = b.z;
      const nvy = b.vy - C.BALL_GRAVITY * dt;
      const nx = ox + b.vx * dt, ny = oy + (b.vy + nvy) * 0.5 * dt, nz = oz + b.vz * dt;
      b.vy = nvy;
      const sx = nx - ox, sy = ny - oy, sz = nz - oz;
      const len = Math.sqrt(sx * sx + sy * sy + sz * sz);
      // players
      let bestT = 2;
      let target: PlayerState | null = null;
      for (const o of this.players) {
        if (!o.alive || o.id === b.owner && b.age < 0.5) continue;
        if (o.id === b.owner) continue;
        const v = this.lagView ? this.lagView(b.owner, b.id, o) : o;
        if (!v) continue;
        const mx = (ox + nx) * 0.5 - v.x, mz = (oz + nz) * 0.5 - v.z;
        if (mx * mx + mz * mz > (len * 0.5 + 2) * (len * 0.5 + 2)) continue;
        const t = segCapsule(ox, oy, oz, sx, sy, sz, v, C.HIT_R);
        if (t >= 0 && t < bestT) { bestT = t; target = o; }
      }
      // world
      let hit = null as ReturnType<typeof raycast>;
      if (len > 0) {
        hit = raycast(this.env.cw, ox, oy, oz, sx, sy, sz, len + C.BALL_RADIUS);
        if (hit && hit.t / len > 1 + C.BALL_RADIUS / len) hit = null;
      }
      const hitT = hit ? Math.min(1, hit.t / len) : 2;
      // water
      const W = waterAt(this.env, nx, nz);
      let waterT = 2;
      if (W !== NO_WATER_Y && ny < W && oy >= W) waterT = (oy - W) / (oy - ny || 1);
      else if (W !== NO_WATER_Y && oy < W) waterT = 0;

      const tmin = Math.min(bestT, hitT, waterT);
      if (tmin <= 1) {
        const hx = ox + sx * tmin, hy = oy + sy * tmin, hz = oz + sz * tmin;
        if (target && bestT === tmin) {
          this.hitPlayer(target, b, hx, hy, hz);
        } else if (hit && hitT === tmin) {
          this.events.push({ type: "splat", proj: b.id, shooter: b.owner, x: hit.x, y: hit.y, z: hit.z, nx: hit.nx, ny: hit.ny, nz: hit.nz, color: b.color, r: 0.42 + shotRandom(b.id, 3, 7) * 0.3, surf: hit.kind === "structure" ? 1 : hit.kind === "prop" ? 2 : hit.kind === "cave" ? 3 : 0 });
        } else {
          this.events.push({ type: "splash", proj: b.id, x: hx, y: W, z: hz, size: 0.35 });
        }
        list.splice(i, 1);
        continue;
      }
      b.x = nx; b.y = ny; b.z = nz;
      if (b.age > C.BALL_LIFE || b.y < -40) {
        this.events.push({ type: "projEnd", proj: b.id });
        list.splice(i, 1);
      }
    }
  }

  private hitPlayer(t: PlayerState, b: ProjectileState, x: number, y: number, z: number): void {
    const sl = Math.sqrt(b.vx * b.vx + b.vz * b.vz) || 1;
    const dx = b.vx / sl, dz = b.vz / sl;
    this.events.push({ type: "projEnd", proj: b.id });
    if (t.shield > 0) {
      this.events.push({ type: "shield", target: t.id, shooter: b.owner, x, y, z });
      return;
    }
    if (t.upgrades & (1 << PickupKind.Vest)) {
      t.upgrades &= ~(1 << PickupKind.Vest);
      this.events.push({ type: "vest", target: t.id, shooter: b.owner, x, y, z });
      return;
    }
    t.coats.push(b.color);
    t.coatBy.push(b.owner);
    t.paintT = 0;
    t.lastHitBy = b.owner;
    if (t.move !== Move.Vehicle && t.move !== Move.Zipline && t.move !== Move.Mantle) {
      t.vx += dx * C.HIT_KNOCKBACK; t.vz += dz * C.HIT_KNOCKBACK;
    }
    this.action.add(this.time, x, z, HOT_W.hit);
    this.events.push({ type: "hit", target: t.id, shooter: b.owner, x, y, z, dx, dz, coats: t.coats.length, color: b.color });
    if (t.coats.length >= C.MAX_COATS) this.eliminate(t, this.player(b.owner), x, y, z);
  }

  // ---------------------------------------------------------------- pickups
  private stepPickups(dt: number): void {
    const list = this.pickups;
    for (let i = list.length - 1; i >= 0; i--) {
      const k = list[i];
      if (k.drop) {
        k.ttl -= dt;
        if (k.ttl <= 0 || !k.active) { list.splice(i, 1); continue; }
      } else if (!k.active) {
        k.respawn -= dt;
        if (k.respawn <= 0) {
          k.active = true;
          this.events.push({ type: "pickupSpawn", pickup: k.id });
        }
        continue;
      }
      for (const p of this.players) {
        if (!p.alive || p.move === Move.Vehicle) continue;
        const dx = p.x - k.x, dz = p.z - k.z, dy = p.y - k.y;
        if (dx * dx + dz * dz > C.PICKUP_R * C.PICKUP_R || dy < -2 || dy > 2.5) continue;
        if (this.collect(p, k)) break;
      }
    }
  }

  /** Try to collect; false if the player doesn't need it. */
  collect(p: PlayerState, k: PickupState): boolean {
    if (!k.active) return false;
    if (k.drop) {
      p.upgrades |= k.drop;
      p.reserve = Math.min(C.RESERVE_MAX, p.reserve + 20);
    } else if (k.kind === PickupKind.Ammo) {
      if (p.reserve >= C.RESERVE_MAX && p.hopper >= hopperCap(p)) return false;
      p.reserve = Math.min(C.RESERVE_MAX, p.reserve + C.AMMO_CACHE);
    } else {
      if (p.upgrades & (1 << k.kind)) return false;
      p.upgrades |= 1 << k.kind;
    }
    k.active = false;
    k.respawn = k.kind === PickupKind.Ammo ? C.AMMO_RESPAWN : C.UPGRADE_RESPAWN;
    this.events.push({ type: "pickup", pid: p.id, pickup: k.id, kind: k.kind, drop: k.drop, x: k.x, y: k.y, z: k.z });
    return true;
  }

  // ---------------------------------------------------------------- interaction
  /** What pressing E would do right now (drives the HUD prompt too). */
  findInteract(p: PlayerState): InteractTarget | null {
    if (!p.alive) return null;
    if (p.move === Move.Vehicle) {
      const v = this.vehicles.find((v) => v.id === p.vehicle);
      return { kind: "exit", id: p.vehicle, seat: p.seat, label: v ? `Hop off the ${VEHICLE_NAMES[v.kind]}` : "Hop off", dist: 0 };
    }
    if (p.move === Move.Zipline || p.move === Move.Mantle || p.move === Move.Glide || p.move === Move.Splat) return null;
    let best: InteractTarget | null = null;
    const consider = (t: InteractTarget) => { if (!best || t.dist < best.dist) best = t; };
    for (const v of this.vehicles) {
      const d = hullDist(v, p.x, p.z);
      if (d > C.INTERACT_R || Math.abs(p.y - v.y) > 2.6) continue;
      const seat = v.seats.indexOf(-1);
      if (seat < 0) continue;
      if (!canBoard(v.kind, p.move)) continue;
      consider({ kind: "vehicle", id: v.id, seat, label: vehicleVerb(v.kind, seat), dist: d });
    }
    const zs = this.env.ziplines;
    for (let i = 0; i < zs.length; i++) {
      const z = zs[i];
      const dx = p.x - z.ax, dz = p.z - z.az;
      const d = Math.sqrt(dx * dx + dz * dz);
      const dy = p.y - (z.ay - C.ZIP_FEET);
      if (d > C.ZIP_GRAB_R || dy < -3.6 || dy > 3) continue;
      consider({ kind: "zip", id: i, seat: 0, label: "Zip down", dist: d });
    }
    return best;
  }

  private interact(p: PlayerState): void {
    const t = this.findInteract(p);
    if (!t) return;
    if (t.kind === "exit") this.leaveVehicle(p, true);
    else if (t.kind === "vehicle") this.enterVehicle(p, t.id, t.seat);
    else if (t.kind === "zip") this.startZip(p, t.id);
  }

  private vehicleIndex(id: number): number {
    for (let i = 0; i < this.vehicles.length; i++) if (this.vehicles[i].id === id) return i;
    return -1;
  }

  enterVehicle(p: PlayerState, vid: number, seat: number): boolean {
    const v = this.vehicles[this.vehicleIndex(vid)];
    if (!v || v.seats[seat] !== -1) return false;
    v.seats[seat] = p.id;
    p.vehicle = v.id;
    p.seat = seat;
    p.move = Move.Vehicle;
    p.moveT = 0;
    p.vx = 0; p.vy = 0; p.vz = 0;
    p.reload = p.reload > 0 && seat === 0 ? 0 : p.reload;
    seatWorld(v, seat, _v);
    p.x = _v.x; p.y = _v.y; p.z = _v.z;
    this.events.push({ type: "vehicleEnter", pid: p.id, vehicle: v.id, seat });
    return true;
  }

  leaveVehicle(p: PlayerState, place: boolean): void {
    if (p.vehicle < 0) return;
    const vi = this.vehicleIndex(p.vehicle);
    const v = this.vehicles[vi];
    const vid = p.vehicle;
    p.vehicle = -1;
    p.seat = -1;
    if (!v) return;
    for (let s = 0; s < v.seats.length; s++) if (v.seats[s] === p.id) v.seats[s] = -1;
    this.events.push({ type: "vehicleExit", pid: p.id, vehicle: vid });
    if (!place) return;
    const sy = sin(v.yaw), cy = cos(v.yaw);
    const h = HULL[v.kind];
    // right, left, behind, ahead
    const offs = [[-(h.hb + 0.8), 0], [h.hb + 0.8, 0], [0, -(h.hl + 0.8)], [0, h.hl + 0.8]];
    const vx = sy * v.speed, vz = cy * v.speed;
    if (v.kind === VehicleKind.Gyrocopter && v.airborne) {
      // bail out mid-flight: drop from beside the cockpit, keeping the craft's momentum
      for (const lx of [-(h.hb + 0.5), h.hb + 0.5]) {
        const x = v.x + lx * cy, z = v.z - lx * sy, y = v.y - 0.3;
        if (dist(this.env, x, y + C.BODY_R + 0.05, z) < C.BODY_R || dist(this.env, x, y + C.BODY_H - C.BODY_R, z) < C.BODY_R) continue;
        p.x = x; p.y = y; p.z = z;
        p.vx = vx * 0.85; p.vy = Math.min(v.vy, 1); p.vz = vz * 0.85;
        p.move = Move.Air; p.moveT = 0; p.grounded = false; p.dived = false;
        return;
      }
    }
    for (const [lx, lz] of offs) {
      const x = v.x + lx * cy + lz * sy, z = v.z - lx * sy + lz * cy;
      const g = probeGround(this.env, x, v.y + 2.2, z, 12);
      if (g === BLOCKED) continue;
      const W = waterAt(this.env, x, z);
      if (W !== NO_WATER_Y && (g === -Infinity || W - g > C.SWIM_ENTER)) {
        if (dist(this.env, x, W - 0.3, z) < C.BODY_R) continue;
        p.x = x; p.z = z; p.y = W - C.SWIM_DEPTH;
        p.vx = vx * 0.5; p.vy = 0; p.vz = vz * 0.5;
        p.move = Move.Swim; p.moveT = 0; p.grounded = false;
        return;
      }
      if (g === -Infinity) continue;
      if (dist(this.env, x, g + C.STEP_H + C.BODY_R + 0.05, z) < C.BODY_R) continue;
      if (dist(this.env, x, g + C.BODY_H - C.BODY_R, z) < C.BODY_R) continue;
      p.x = x; p.z = z; p.y = g + 0.02;
      p.vx = vx * 0.6; p.vy = 2; p.vz = vz * 0.6;
      p.move = Move.Air; p.moveT = 0; p.grounded = false; p.dived = false;
      return;
    }
    // nowhere to go: pop straight up
    p.y += 1.4; p.vy = 3; p.move = Move.Air; p.moveT = 0; p.grounded = false;
  }

  private startZip(p: PlayerState, zid: number): void {
    const z = this.env.ziplines[zid];
    if (!z) return;
    p.zip = zid;
    p.zipT = 0.01;
    p.zipV = C.ZIP_START_SPEED;
    p.move = Move.Zipline;
    p.moveT = 0;
    p.grounded = false;
    zipPoint(z, p.zipT, _w);
    p.x = _w.x; p.y = _w.y - C.ZIP_FEET; p.z = _w.z;
    this.events.push({ type: "zipStart", pid: p.id, zip: zid });
  }

  private anyoneNear(x: number, z: number, r: number): boolean {
    for (const p of this.players) {
      if (!p.alive) continue;
      const dx = p.x - x, dz = p.z - z;
      if (dx * dx + dz * dz < r * r) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- debug helpers
  teleport(id: number, x: number, y: number, z: number): void {
    const p = this.player(id);
    if (!p) return;
    this.leaveVehicle(p, false);
    p.zip = -1;
    let yy = y;
    if (!Number.isFinite(y)) {
      const g = probeGround(this.env, x, Math.max(0, terrainHeight(this.world, x, z)) + 2.5, z, 30);
      yy = g === BLOCKED || g === -Infinity ? 50 : g;
    }
    p.x = x; p.y = yy; p.z = z; p.vx = 0; p.vy = 0; p.vz = 0;
    p.move = Move.Air; p.moveT = 0; p.grounded = false;
    if (!p.alive) { p.alive = true; p.coats.length = 0; p.coatBy.length = 0; p.paintT = 0; }
  }

  giveUpgrade(id: number, kind: PickupKind): void {
    const p = this.player(id);
    if (!p) return;
    if (kind === PickupKind.Ammo) p.reserve = C.RESERVE_MAX;
    else p.upgrades |= 1 << kind;
  }

  /** Paint a player directly (tests / debug). */
  paint(targetId: number, shooterId: number): void {
    const t = this.player(targetId);
    if (!t || !t.alive) return;
    const color = this.info.get(shooterId)?.color ?? 0xffffff;
    this.hitPlayer(t, { id: 0, owner: shooterId, color, x: t.x, y: t.y + 1, z: t.z, vx: 1, vy: 0, vz: 0, age: 0 }, t.x, t.y + 1, t.z);
  }
}

/** Distance from (x, z) to a vehicle's hull centreline segment. */
function hullDist(v: VehicleState, x: number, z: number): number {
  const h = HULL[v.kind];
  const fx = sin(v.yaw), fz = cos(v.yaw);
  const px = x - v.x, pz = z - v.z;
  let t = px * fx + pz * fz;
  if (t > h.hl) t = h.hl;
  else if (t < -h.hl) t = -h.hl;
  const qx = px - fx * t, qz = pz - fz * t;
  return Math.max(0, Math.sqrt(qx * qx + qz * qz) - h.hb);
}

/**
 * Segment (o, o + s) vs a player's vertical hit capsule. Returns the segment
 * parameter [0, 1] of first contact (approximate), or -1.
 */
export function segCapsule(ox: number, oy: number, oz: number, sx: number, sy: number, sz: number, p: PlayerState, r: number): number {
  const h = p.move === Move.Vehicle ? 1.2 : bodyHeight(p.move);
  const baseY = p.move === Move.Vehicle ? p.y - 0.2 : p.y;
  const ya = baseY + r * 0.6, yb = baseY + Math.max(h - r * 0.5, r * 0.6 + 0.05);
  // closest approach in XZ
  const px = p.x - ox, pz = p.z - oz;
  const hh = sx * sx + sz * sz;
  let t = hh > 1e-9 ? (px * sx + pz * sz) / hh : 0;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  // refine: a couple of iterations using the true 3D distance to the axis segment
  let best = -1;
  for (let k = 0; k < 3; k++) {
    const qx = ox + sx * t, qy = oy + sy * t, qz = oz + sz * t;
    const cy = qy < ya ? ya : qy > yb ? yb : qy;
    const dx = qx - p.x, dy = qy - cy, dz = qz - p.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 <= r * r) {
      // step back to the entry point along the segment
      const L2 = sx * sx + sy * sy + sz * sz;
      const back = L2 > 0 ? Math.sqrt(Math.max(0, r * r - d2)) / Math.sqrt(L2) : 0;
      best = Math.max(0, t - back);
      break;
    }
    // move t toward the capsule's y range if we're above/below it
    if (Math.abs(sy) > 1e-6 && (qy < ya || qy > yb)) {
      const ty = ((qy < ya ? ya : yb) - oy) / sy;
      t = ty < 0 ? 0 : ty > 1 ? 1 : ty;
    } else break;
  }
  return best;
}
