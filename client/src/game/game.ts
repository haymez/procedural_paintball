// The game client: fixed-tick input → GameSource, render from its snapshot,
// turn sim events into juice (paint, particles, shake, HUD, sounds).
import * as THREE from "three";
import { raycast, terrainHeight } from "../../../shared/world/collide";
import { PickupKind, VehicleKind, type World } from "../../../shared/world/types";
import {
  Btn, ELIM_ANIM, Fx, Move, NO_WATER_Y, TICK_DT, canShootIn, currentSpread, eyePos, hasUpgrade, segCapsule, upgradeName,
  type InputCmd, type PlayerState, type SimEvent,
} from "../../../shared/sim/index";
import type { WorldView } from "../render/worldView";
import { Actors } from "./actors";
import { AimArc } from "./arc";
import { CameraRig, type CamContext } from "./camera";
import { Hud, type HudFrame } from "./hud/hud";
import { Input, type InputOverride, type MoveSample } from "./input";
import { DEATH_TITLES, ELIM_TITLES, STREAK_TITLES } from "./names";
import { saveSettings, type Settings } from "./settings";
import { audioStats, initSfx, recentSfx, sfx, sfxStopAll, sfxVolume } from "./sfx";
import { AudioScene } from "./audioScene";
import { SkyDropView } from "./skydrop";
import type { GameSource } from "./source";

export interface GameOptions {
  mount: HTMLElement;
  world: World;
  source: GameSource;
  renderer: THREE.WebGLRenderer;
  view: WorldView;
  settings: Settings;
  /** Open with a short fly-in over the island to the player (match start). */
  intro?: boolean;
  onLeave?(): void;
  onPlayAgain?(): void;
}

/** A frame gap longer than this (s) is a stall (hidden tab, debugger, GC storm): resync instead of catching up. */
const RESYNC_GAP = 0.25;
/** Subtitles for a sky-drop touchdown. */
const LANDING_QUIPS = ["nailed the landing", "graceful. mostly.", "boing!", "10 / 10 from the judges", "that'll buff out", "gummy physics"];
/** Seconds the last attacker stays marked. */
const ATTACKER_SHOW = 4.5;

const _v2 = new THREE.Vector3();
const _feet = new THREE.Vector3();
const _e = { x: 0, y: 0, z: 0 };

export class Game {
  readonly source: GameSource;
  readonly actors: Actors;
  readonly rig: CameraRig;
  readonly input: Input;
  readonly hud: Hud;
  readonly arc: AimArc;
  readonly audio: AudioScene;
  readonly sky: SkyDropView;
  private view: WorldView;
  private renderer: THREE.WebGLRenderer;
  private settings: Settings;
  private acc = 0;
  private last = 0;
  private raf = 0;
  private running = false;
  private seq = 0;
  private sample: MoveSample = { moveX: 0, moveZ: 0, buttons: 0 };
  private cmd: InputCmd = { seq: 0, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0 };
  private events: SimEvent[] = [];
  private hitStop = 0;
  private time = 0;
  private noise = new Map<number, number>();
  /** Sky drop: was I gliding / splatting last frame; seconds left of easing the view back after touch-down. */
  private wasDropping = false;
  private landEase = 0;
  private deathT = 0;
  private dropMapShown = false;
  private resultsShown = false;
  private camCtx: CamContext = { move: Move.Ground, aiming: false, scope: false, sprinting: false, speed: 0, vehicle: -1, driver: false, steer: 0, dead: false, deathT: 0 };
  private deathPos = new THREE.Vector3();
  private stats = { fps: 0, frameMs: 0, cpuMs: 0, simMs: 0, drawCalls: 0, triangles: 0, players: 0, projectiles: 0 };
  private frames = 0;
  private fpsAcc = 0;
  private cpuAvg = 0;
  private simAvg = 0;
  private footT = 0;
  private lookIdle = 0;
  /** Gyro yaw last frame (A/D turns carry the view along). */
  private gyroYaw: number | null = null;
  private aimOnPlayer = false;
  private whizzed = new Set<number>();
  private lastSecond = -1;
  private prevButtons = 0;
  /** The death card / spawn map is up. */
  private deathUi: 0 | 1 | 2 = 0;
  private deathUiT = 0;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  /** My splats since my last elimination (streak callouts). */
  private streak = 0;
  /** Who last painted me: their marker hangs over them for a few seconds. */
  private attacker = -1;
  private attackerT = 0;
  private lastPlace = "";
  private placeT = 0;

  frameHook: ((dt: number) => void) | null = null;

  constructor(private opts: GameOptions) {
    this.source = opts.source;
    this.view = opts.view;
    this.renderer = opts.renderer;
    this.settings = opts.settings;
    const snap = this.source.snapshot();
    this.actors = new Actors(this.view, this.source.env, snap, this.source.localId);
    this.rig = new CameraRig(this.source.env, this.settings.fov);
    this.rig.side = this.settings.shoulder;
    const myColor = snap.info.get(this.source.localId)?.color ?? 0xffffff;
    this.arc = new AimArc(myColor);
    this.audio = new AudioScene(opts.world);
    this.view.scene.add(this.arc.group);
    this.sky = new SkyDropView(this.view.scene, this.source.env);
    this.hud = new Hud(opts.mount, opts.world, {
      onResume: () => { this.hud.showPause(false); this.input.lock(); },
      onLeave: () => this.opts.onLeave?.(),
      onSettings: (s) => { saveSettings(s); this.rig.baseFov = s.fov; sfxVolume(s.volume); },
    }, this.settings);
    this.hud.setColor(myColor);
    this.input = new Input(this.renderer.domElement, this.settings, {
      onPause: () => {
        if (this.hud.mapIsOpen && !this.deadNow()) { this.hud.toggleMap(false); return; }
        const open = !this.hud.paused;
        this.hud.showPause(open);
        if (open) this.input.unlock();
        else this.input.lock();
      },
      onMap: () => { if (!this.deadNow()) this.hud.toggleMap(); },
      onScoreboard: (o) => this.hud.setScoreboard(o),
      onShoulder: () => { this.rig.side = this.rig.side > 0 ? -1 : 1; this.settings.shoulder = this.rig.side as 1 | -1; saveSettings(this.settings); },
      onLockChange: (locked) => { if (!locked && !this.hud.paused && !this.resultsShown) { /* Esc via browser */ this.hud.showPause(true); } else if (locked) this.hud.showPause(false); },
    });
    const me = this.source.me();
    if (me && me.move === Move.Glide) this.startDrop(me);
    else if (me) { this.input.yaw = this.landward(me.x, me.z, me.yaw); this.input.pitch = -0.08; }
    void initSfx().then(() => sfxVolume(this.settings.volume));
    window.addEventListener("resize", this.onResize);
    this.onResize();
  }

  private onResize = (): void => {
    const w = this.opts.mount.clientWidth || window.innerWidth, h = this.opts.mount.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h);
    this.rig.setAspect(w / h);
  };

  /** Spawns face the island, not the open sea: the heading with the most land ahead (ties → `fallback`). */
  private landward(x: number, z: number, fallback: number): number {
    const w = this.opts.world;
    let best = fallback, bestScore = -1;
    for (let i = 0; i < 24; i++) {
      const a = fallback + (i / 24) * Math.PI * 2;
      const sx = Math.sin(a), sz = Math.cos(a);
      let score = 0;
      for (let d = 8; d <= 96; d += 8) if (terrainHeight(w, x + sx * d, z + sz * d) > 0.5) score += 1 - d / 200;
      // gentle preference for the server's pick (toward the centre)
      score -= Math.min(i, 24 - i) * 0.02;
      if (score > bestScore) { bestScore = score; best = a; }
    }
    return best;
  }

  private deadNow(): boolean {
    return !(this.source.me()?.alive ?? true);
  }

  /** Dropping in from the sky: face the action, look down at the island. */
  private startDrop(me: PlayerState): void {
    this.sky.refresh(this.source.snapshot().time);
    this.input.yaw = this.dropFacing(me);
    this.input.pitch = -0.45;
    this.wasDropping = true;
    this.landEase = 0;
  }

  /** Heading toward the hottest fight, else the other players, else the island. */
  private dropFacing(me: PlayerState): number {
    const z = this.sky.zones[0];
    if (z) return Math.atan2(z.x - me.x, z.z - me.z);
    let sx = 0, sz = 0, n = 0;
    for (const o of this.source.snapshot().players) {
      if (o.id === me.id || !o.alive || o.move === Move.Glide) continue;
      sx += o.x; sz += o.z; n++;
    }
    if (n) return Math.atan2(sx / n - me.x, sz / n - me.z);
    return me.yaw;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const mins = Math.round(this.source.snapshot().timeLeft / 60);
    // a sky drop is its own intro: no swoop down to the shoulder
    if (this.opts.intro && this.source.me()?.move !== Move.Glide) {
      // swoop down from over the island, then the title card as we land
      this.rig.intro(3.2);
      this.startTimer = setTimeout(() => this.hud.bigText(this.opts.world.name, `most splats in ${mins} minutes wins · paint wears off · water washes it faster`), 2300);
    } else this.startTimer = setTimeout(() => this.hud.bigText(this.opts.world.name, `most splats in ${mins} minutes wins · paint wears off · water washes it faster`), 600);
    this.lastPlace = this.hud.placeAt(this.source.me()?.x ?? 0, this.source.me()?.z ?? 0);
    this.last = performance.now();
    const loop = () => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      const now = performance.now();
      const gap = (now - this.last) / 1000;
      this.last = now;
      if (gap > RESYNC_GAP || this.hiddenSince) {
        // back from a hidden tab or a long freeze: don't replay the gap, rejoin the present
        this.hiddenSince = 0;
        this.resync();
        this.frame(1 / 60);
        return;
      }
      // visuals step at most 0.1 s; the networked sim catches up on the real time
      this.frame(Math.min(0.1, gap), gap);
    };
    this.raf = requestAnimationFrame(loop);
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    document.removeEventListener("visibilitychange", this.onVisibility);
  }

  private hiddenSince = 0;
  private onVisibility = (): void => {
    if (document.hidden) this.hiddenSince = performance.now();
  };

  /** Drop the backlog after a stall: authoritative state, fresh interpolation, calm camera. */
  private resync(): void {
    this.acc = 0;
    this.hitStop = 0;
    this.source.resync?.();
    this.actors.capturePrev();
    this.input.lookDX = 0;
    this.input.lookDY = 0;
  }

  // ------------------------------------------------------------------ frame
  frame(dtIn: number, simDt = dtIn): void {
    const c0 = performance.now();
    let dt = dtIn;
    this.time += dt;
    // ---- fixed ticks ------------------------------------------------------------
    if (this.hitStop > 0) {
      this.hitStop -= dt;
      dt *= 0.08;
      this.acc = Math.min(this.acc + dtIn, TICK_DT * 4);
    } else {
      // networked: keep every tick (a skipped tick is a cmd the server has to invent);
      // offline: the sim can simply slow down
      const maxTicks = this.source.kind === "remote" ? 16 : 5;
      this.acc += this.source.kind === "remote" ? simDt : dt;
      let n = 0;
      const s0 = performance.now();
      while (this.acc >= this.source.tickDt && n < maxTicks) {
        this.acc -= this.source.tickDt;
        this.actors.capturePrev();
        this.buildCmd();
        this.source.sendInput(this.cmd);
        this.source.tick();
        n++;
      }
      if (n === maxTicks) this.acc = 0;
      this.simAvg = this.simAvg * 0.9 + (performance.now() - s0) * 0.1;
    }
    this.events.length = 0;
    this.source.drainEvents(this.events);
    for (const e of this.events) this.handle(e);
    const simTime = this.source.snapshot().time;
    for (const e of this.events) {
      if (e.type === "hit" && e.pred !== 2) this.sky.note("hit", simTime, e.x, e.z, e.color);
      else if (e.type === "elim") this.sky.note("elim", simTime, e.x, e.z, e.killer >= 0 ? this.name(e.killer).color : 0);
      else if (e.type === "splat") this.sky.note("splat", simTime, e.x, e.z, e.color);
    }
    for (const [k, v] of this.noise) this.noise.set(k, v + dt);

    const alpha = Math.min(1, this.acc / this.source.tickDt);
    const me = this.source.me();
    this.frameHook?.(dt);

    // ---- actors -----------------------------------------------------------------------
    this.actors.localYaw = me && me.alive ? this.cmd.yaw : me?.yaw ?? 0;
    this.actors.localPitch = this.cmd.pitch;
    this.actors.hideLocal = this.rig.distance < 0.9 && !!me?.alive;
    this.actors.update(dt, alpha, this.rig.camera);
    this.sky.update(dt, this.source.snapshot().time, me, this.snapColor(), this.rig.camera, this.source.snapshot().players, (id, out) => this.actors.playerPos(id, out));
    // sky drop → on your feet: bring the view back up from looking at the ground
    const dropping = !!me && me.alive && (me.move === Move.Glide || me.move === Move.Splat);
    if (this.wasDropping && !dropping) { this.landEase = 0.9; this.placeT = Math.max(this.placeT, 1.6); }
    this.wasDropping = dropping;
    if (this.landEase > 0) {
      this.landEase -= dt;
      if (this.input.pitch < -0.12) this.input.pitch += (-0.1 - this.input.pitch) * (1 - Math.exp(-dt * 5));
    }

    // ---- camera -------------------------------------------------------------------------
    const snap = this.source.snapshot();
    const c = this.camCtx;
    if (this.input.lookDX !== 0 || this.input.lookDY !== 0) { this.lookIdle = 0; this.input.lookDX = 0; this.input.lookDY = 0; }
    else this.lookIdle += dt;
    // gyro pilots turning on A/D: the view turns with the craft (it flies toward the view otherwise)
    const piloting = me && me.alive && me.move === Move.Vehicle && me.seat === 0 ? snap.vehicles.find((v) => v.id === me.vehicle) : undefined;
    if (piloting && piloting.kind === VehicleKind.Gyrocopter) {
      if (this.gyroYaw !== null && this.cmd.moveX !== 0) {
        let d = piloting.yaw - this.gyroYaw;
        d -= Math.PI * 2 * Math.floor((d + Math.PI) / (Math.PI * 2));
        this.input.yaw += d;
      }
      this.gyroYaw = piloting.yaw;
    } else this.gyroYaw = null;
    if (me && me.alive && me.move === Move.Vehicle && me.seat === 0 && this.lookIdle > 0.9) {
      // drivers: ease the camera back behind the vehicle when the mouse rests
      const v = snap.vehicles.find((v) => v.id === me.vehicle);
      if (v && Math.abs(v.speed) > 0.8) {
        let d = v.yaw - this.input.yaw;
        d -= Math.PI * 2 * Math.floor((d + Math.PI) / (Math.PI * 2));
        const k = (1 - Math.exp(-dt * 1.6)) * Math.min(1, Math.abs(v.speed) / 4);
        this.input.yaw += d * k;
        // (the gyro climbs / dives on the view pitch: leave it where the pilot put it)
        if (v.kind !== VehicleKind.Gyrocopter) this.input.pitch += (-0.16 - this.input.pitch) * k;
      }
    }
    if (me) {
      this.actors.playerPos(me.id, _feet) ?? _feet.set(me.x, me.y, me.z);
      c.move = me.move;
      c.aiming = me.alive && this.input.isHeld(Btn.Aim) && canShootIn(me.move) && !(me.move === Move.Vehicle && me.seat === 0);
      c.scope = c.aiming && hasUpgrade(me, PickupKind.Scope);
      c.sprinting = me.sprinting;
      c.speed = Math.hypot(me.vx, me.vz);
      c.dead = !me.alive;
      c.deathT = this.deathT;
      c.vehicle = -1; c.driver = false; c.steer = 0;
      if (me.move === Move.Vehicle) {
        const v = snap.vehicles.find((v) => v.id === me.vehicle);
        if (v) { c.vehicle = v.kind; c.driver = me.seat === 0; c.steer = v.steer; c.speed = Math.abs(v.speed); }
      }
      if (!me.alive) { this.deathT += dt; _feet.copy(this.deathPos); } else this.deathT = 0;
      this.input.aimSensMult = c.aiming ? this.settings.aimSensitivity * (c.scope ? 0.55 : 1) : 1;
    }
    this.rig.update(dt, _feet, this.input.yaw, this.input.pitch, c);
    this.view.setFocus(me ? _feet : null);
    const cam = this.rig.camera;
    // underwater look follows the lens
    const W = this.rig.waterY;
    this.view.setUnderwater(W !== NO_WATER_Y ? cam.position.y < W - 0.05 : false);

    // ---- aim arc -------------------------------------------------------------------------
    const showArc = !!me && me.alive && c.aiming && canShootIn(me.move);
    let muzzle: THREE.Vector3 | null = null;
    if (showArc) {
      const blob = this.actors.blobOf(me!.id);
      if (blob) muzzle = blob.getMuzzle(_v2);
    }
    if (me) {
      // arc uses the latest look, not last tick's
      const y0 = me.yaw, p0 = me.pitch;
      me.yaw = this.cmd.yaw; me.pitch = this.cmd.pitch;
      this.arc.update(dt, showArc, this.source.env, me, muzzle);
      me.yaw = y0; me.pitch = p0;
    }

    // ---- world -------------------------------------------------------------------------
    this.view.update(dt, cam, this.time);
    this.view.render(cam);
    this.audio.update(dt, cam, this.rig.forward, snap, me, this.view.caveFactor, this.view.underwater);

    // ---- HUD ---------------------------------------------------------------------------
    const it = me?.alive && !dropping ? this.source.interactTarget() : null;
    this.hud.update(dt, {
      me, snap, camYaw: this.input.yaw,
      interact: it ? it.label : null,
      canShoot: !!me && canShootIn(me.move) && !(me.move === Move.Vehicle && me.seat === 0) && me.reload <= 0,
      spread: me ? currentSpread(me) : 0,
      locked: this.input.locked || this.input.scripted,
      noise: this.noise,
      scoped: c.scope && this.rig.aimAmount > 0.8,
      onTarget: this.aimOnPlayer,
      fps: this.settings.showFps ? `${this.stats.fps} fps  ${this.stats.drawCalls} draws  sim ${this.simAvg.toFixed(2)} ms` : null,
      drop: dropping && me ? this.dropHud(me) : null,
      zones: this.sky.zones,
    });
    if (me && !me.alive && this.deathT > ELIM_ANIM && !this.dropMapShown) {
      this.dropMapShown = true;
      this.hud.openDropMap();
    }
    // back on your feet: the death card and spawn map go, whatever order the events came in
    if (me && !me.alive && this.deathUi) this.deathUi = 2;
    else if (me?.alive && (this.deathUi === 2 || (this.deathUi === 1 && (this.deathUiT += dt) > 1.5))) { this.deathUi = 0; this.deathUiT = 0; this.hud.hideDeath(); }
    if (snap.ended && !this.resultsShown) {
      this.resultsShown = true;
      this.input.unlock();
      const rows = [...snap.players].map((p) => {
        const i = snap.info.get(p.id)!;
        return { id: p.id, name: i.name, color: i.color, score: p.score, deaths: p.deaths, style: p.style };
      }).sort((a, b) => b.score - a.score || a.deaths - b.deaths);
      this.hud.showResults(rows, this.source.localId, () => this.opts.onPlayAgain?.());
      sfx("matchEnd");
    }

    // near misses: enemy balls whizzing past your head
    if (me?.alive) {
      const hx = me.x, hy = me.y + 1.4, hz = me.z;
      for (const b of snap.projectiles) {
        if (b.owner === me.id || this.whizzed.has(b.id)) continue;
        const dx = b.x - hx, dy = b.y - hy, dz = b.z - hz;
        if (dx * dx + dy * dy + dz * dz < 2.4 * 2.4) { this.whizzed.add(b.id); sfx("whiz", b); }
      }
      if (this.whizzed.size > 200) this.whizzed.clear();
    }
    // last ten seconds
    const secs = Math.ceil(snap.timeLeft);
    if (secs !== this.lastSecond) {
      this.lastSecond = secs;
      if (secs <= 10 && secs > 0 && !snap.ended) sfx("countdown");
    }

    // footsteps
    if (me?.alive && me.move === Move.Ground) {
      const s = Math.hypot(me.vx, me.vz);
      if (s > 1) {
        this.footT -= dt * s * (me.sprinting ? 0.42 : 0.5);
        if (this.footT <= 0) { this.footT = 1; sfx("footstep", me, { volume: me.sprinting ? 1 : 0.7, surface: this.audio.footSurface(me) }); }
      }
    }

    // ---- who's shooting me: a marker over them (through walls), an edge arrow off screen
    if (this.attackerT > 0) {
      this.attackerT -= dt;
      const a = snap.players.find((p) => p.id === this.attacker);
      if (a && a.alive && this.attackerT > 0 && this.actors.playerPos(a.id, _v2)) {
        _v2.y += 2.35;
        const i = snap.info.get(a.id);
        this.hud.attacker(i?.name ?? "?", i?.color ?? 0xffffff, _v2.project(cam), Math.min(1, this.attackerT / 0.6));
      } else { this.attackerT = 0; this.hud.attacker(null); }
    }
    // ---- entering a named place: a quiet title card
    this.placeT -= dt;
    if (me?.alive && this.placeT <= 0 && !this.rig.introActive && !dropping) {
      this.placeT = 0.5;
      const place = this.hud.placeAt(me.x, me.z, 55);
      if (place && place !== this.lastPlace) { this.lastPlace = place; this.hud.areaTitle(place); this.placeT = 8; }
      else if (!place && this.hud.placeAt(me.x, me.z, 120) !== this.lastPlace) this.lastPlace = "";
    }

    // ---- stats ------------------------------------------------------------------------
    this.cpuAvg = this.cpuAvg * 0.9 + (performance.now() - c0) * 0.1;
    this.frames++;
    this.fpsAcc += dtIn;
    if (this.fpsAcc >= 0.5) {
      const info = this.renderer.info;
      this.stats.fps = Math.round(this.frames / this.fpsAcc);
      this.stats.frameMs = +((this.fpsAcc / this.frames) * 1000).toFixed(2);
      this.stats.cpuMs = +this.cpuAvg.toFixed(2);
      this.stats.simMs = +this.simAvg.toFixed(3);
      this.stats.drawCalls = info.render.calls;
      this.stats.triangles = info.render.triangles;
      this.stats.players = snap.players.length;
      this.stats.projectiles = snap.projectiles.length;
      this.frames = 0;
      this.fpsAcc = 0;
    }
  }

  getStats(): Record<string, number> {
    return { ...this.stats };
  }

  // ------------------------------------------------------------------ input → cmd
  /** Debug autopilot: walk through waypoints (x, z), steering the camera. */
  private auto: { pts: { x: number; z: number }[]; i: number; o: InputOverride; t: number; done: (r: unknown) => void } | null = null;
  followPath(pts: { x: number; z: number }[], o: InputOverride = {}, timeoutMs = 60000): Promise<unknown> {
    return new Promise((resolve) => { this.auto = { pts, i: 0, o, t: timeoutMs / 1000, done: resolve }; });
  }

  private stepAuto(s: MoveSample): void {
    const a = this.auto!;
    const me = this.source.me();
    a.t -= this.source.tickDt;
    if (!me || a.i >= a.pts.length || a.t <= 0) {
      this.auto = null;
      a.done({ reached: a.i, of: a.pts.length, timedOut: a.t <= 0 });
      return;
    }
    const p = a.pts[a.i];
    const dx = p.x - me.x, dz = p.z - me.z;
    if (dx * dx + dz * dz < 2.5 * 2.5) { a.i++; return; }
    const want = Math.atan2(dx, dz);
    let d = want - this.input.yaw;
    d -= Math.PI * 2 * Math.floor((d + Math.PI) / (Math.PI * 2));
    this.input.yaw += d * 0.25;
    s.moveZ = 1; s.moveX = 0;
    s.buttons = (a.o.sprint ? Btn.Sprint : 0) | (a.o.jump && me.grounded && Math.random() < 0.02 ? Btn.Jump : 0);
    // hop over things we're stuck on
    if (Math.hypot(me.vx, me.vz) < 0.8 && me.move === Move.Ground) s.buttons |= Btn.Jump;
  }

  private buildCmd(): void {
    const s = this.input.sample(this.sample, this.source.tickDt);
    if (this.auto) this.stepAuto(s);
    const cmd = this.cmd;
    const me = this.source.me();
    cmd.seq = ++this.seq;
    cmd.buttons = s.buttons;
    // E: answer at once (click + prompt squish); the server (or prediction) does the rest
    if ((s.buttons & Btn.Interact) && !(this.prevButtons & Btn.Interact) && me?.alive && this.source.interactTarget()) {
      this.hud.promptPress();
      sfx("uiClick", null, { self: true, volume: 0.6 });
    }
    this.prevButtons = s.buttons;
    const camYaw = this.input.yaw, camPitch = this.input.pitch;
    let yaw = camYaw, pitch = camPitch;
    // (gliding / driving: no marker, so no aim ray — the view itself steers, e.g. the gyrocopter)
    if (me && me.alive && me.move !== Move.Glide && me.move !== Move.Splat && !(me.move === Move.Vehicle && me.seat === 0)) {
      // aim: the eye ray must pass through what the crosshair covers
      const cam = this.rig.camera;
      const cp = Math.cos(camPitch);
      const fx = Math.sin(camYaw) * cp, fy = Math.sin(camPitch), fz = Math.cos(camYaw) * cp;
      const ox = cam.position.x, oy = cam.position.y, oz = cam.position.z;
      let t = 220;
      const hit = raycast(this.source.env.cw, ox, oy, oz, fx, fy, fz, t);
      if (hit) t = hit.t;
      const snap = this.source.snapshot();
      let onPlayer = false;
      for (const o of snap.players) {
        if (o.id === me.id || !o.alive) continue;
        const k = segCapsule(ox, oy, oz, fx * t, fy * t, fz * t, o, 0.45);
        if (k >= 0) { t *= k; onPlayer = true; }
      }
      this.aimOnPlayer = onPlayer && t < 70;
      const tx = ox + fx * t, ty = oy + fy * t, tz = oz + fz * t;
      const e = eyePos(me, _e);
      const dx = tx - e.x, dy = ty - e.y, dz = tz - e.z;
      const ahead = dx * fx + dy * fy + dz * fz;
      if (ahead > 2.5) {
        yaw = Math.atan2(dx, dz);
        pitch = Math.atan2(dy, Math.hypot(dx, dz));
      }
    }
    // keep movement relative to the camera, not the aim ray
    const d = camYaw - yaw;
    const cd = Math.cos(d), sd = Math.sin(d);
    cmd.moveZ = s.moveZ * cd + s.moveX * sd;
    cmd.moveX = -s.moveZ * sd + s.moveX * cd;
    cmd.yaw = yaw;
    cmd.pitch = pitch;
  }

  // ------------------------------------------------------------------ events → juice
  private name(pid: number): { name: string; color: number } {
    const i = this.source.snapshot().info.get(pid);
    return { name: i?.name ?? "?", color: i?.color ?? 0xffffff };
  }

  private relAngleTo(x: number, z: number): number {
    const me = this.source.me();
    if (!me) return 0;
    const b = Math.atan2(x - me.x, z - me.z);
    let d = b - this.input.yaw;
    d -= Math.PI * 2 * Math.floor((d + Math.PI) / (Math.PI * 2));
    return -d;
  }

  private handle(e: SimEvent): void {
    const local = this.source.localId;
    const fx = this.actors.fx;
    const paint = this.view.paint;
    switch (e.type) {
      case "shot": {
        this.actors.onShot(e.pid, e.proj, e.x, e.y, e.z, e.vx, e.vy, e.vz, e.color);
        this.noise.set(e.pid, 0);
        if (e.pid === local) { this.rig.kick(0.006 + Math.random() * 0.004); this.hud.shotKick(); sfx("shoot", e, { self: true }); }
        else sfx("shootOther", e);
        break;
      }
      case "splat": {
        this.actors.onBallEnd(e.proj);
        paint.splat(e.x, e.y, e.z, e.nx, e.ny, e.nz, e.r, e.color);
        fx.burst(e, { x: e.nx, y: e.ny, z: e.nz }, e.color, 0.75);
        sfx("splat", e, { volume: e.shooter === local ? 1 : 0.8, surface: e.surf === 1 || e.surf === 3 ? "stone" : e.surf === 2 ? "wood" : "ground" });
        break;
      }
      case "splash":
        this.actors.onBallEnd(e.proj);
        fx.splashWater(e, e.size);
        sfx("plop", e);
        break;
      case "projEnd":
        this.actors.onBallEnd(e.proj);
        break;
      case "hit": {
        // pred 1: my ball hit them here (burst now, soft marker); pred 2: the server agrees (marker only)
        const t = this.source.snapshot().players.find((p) => p.id === e.target);
        if (e.pred !== 2) {
          if (e.pred === 1 && t && t.shield > 0) fx.sparkle(e, 0xbfefff, 6);
          else {
            fx.burst(e, { x: -e.dx, y: 0.4, z: -e.dz }, e.color, 1.15);
            // drips on the ground under the target
            if (t && t.move !== Move.Swim && t.move !== Move.Underwater) {
              const g = raycast(this.source.env.cw, e.x, e.y, e.z, e.dx * 0.3, -1, e.dz * 0.3, 4);
              if (g) paint.splat(g.x, g.y, g.z, g.nx, g.ny, g.nz, 0.35 + Math.random() * 0.2, e.color);
            }
            this.actors.blobOf(e.target)?.hit({ x: e.dx, y: 0, z: e.dz });
          }
        }
        if (e.pred === 1) {
          this.hud.hitMarker(false, true);
          sfx("hit", e);
          break;
        }
        if (e.target === local) {
          const shooter = this.source.snapshot().players.find((p) => p.id === e.shooter);
          const rel = shooter ? this.relAngleTo(shooter.x, shooter.z) : 0;
          this.hud.damage(rel);
          this.hud.drip(e.color, rel);
          if (e.shooter !== local) { this.attacker = e.shooter; this.attackerT = ATTACKER_SHOW; }
          this.rig.shake(0.35);
          sfx("hitMe", e);
        } else if (e.pred !== 2) sfx("hit", e);
        if (e.shooter === local) { this.hud.hitMarker(false); sfx("hitConfirm"); }
        break;
      }
      case "shield":
        fx.sparkle(e, 0xbfefff, 8);
        if (e.shooter === local) this.hud.hitMarker(false);
        sfx("shield", e);
        break;
      case "vest":
        fx.burst(e, { x: 0, y: 1, z: 0 }, 0xff8a2a, 0.6);
        fx.sparkle(e, 0xffd08a, 8);
        if (e.target === local) this.hud.toast("Vest saved you!", "Next hit counts", "#ffae66");
        if (e.shooter === local) this.hud.hitMarker(false);
        sfx("vest", e);
        break;
      case "elim": {
        const killer = e.killer >= 0 ? this.name(e.killer) : null;
        const victim = this.name(e.victim);
        const vp = this.source.snapshot().players.find((p) => p.id === e.victim);
        const color = killer ? killer.color : victim.color;
        // a big puddle where they popped
        const g = raycast(this.source.env.cw, e.x, e.y + 1, e.z, 0, -1, 0, 6);
        if (g) paint.splat(g.x, g.y, g.z, g.nx, g.ny, g.nz, 1.5, color);
        fx.burst(e, { x: 0, y: 1, z: 0 }, color, 2.2);
        fx.ring({ x: e.x, y: (g?.y ?? e.y) + 0.05, z: e.z }, color, 3, 0.7);
        this.hud.feed(killer, victim, e.tags, e.place, e.killer === local || e.victim === local, e.victim * 3 + e.killer);
        sfx("killfeed");
        if (e.killer === local && e.victim !== local) {
          this.hitStop = 0.075;
          this.hud.hitMarker(true);
          sfx("elimPop", e);
          this.streak++;
          const title = this.streak >= 2 ? STREAK_TITLES[Math.min(this.streak, STREAK_TITLES.length - 1)]! : ELIM_TITLES[(Math.random() * ELIM_TITLES.length) | 0];
          this.hud.bigText(title, this.streak >= 2 ? `${this.streak} in a row · ${victim.name}` : `${victim.name} · ${e.place}`, this.streak >= 2);
          if (this.attacker === e.victim) this.attackerT = 0; // revenge served
          this.rig.shake(0.25);
          sfx("elim", e);
        } else sfx("elimOther", e);
        if (e.victim === local) {
          this.streak = 0;
          if (e.killer >= 0 && e.killer !== local) { this.attacker = e.killer; this.attackerT = ATTACKER_SHOW + ELIM_ANIM + 2; }
          this.deathPos.set(vp?.x ?? e.x, vp?.y ?? e.y, vp?.z ?? e.z);
          const kp = this.source.snapshot().players.find((p) => p.id === e.killer);
          if (kp && e.killer !== local) this.input.yaw = Math.atan2(kp.x - this.deathPos.x, kp.z - this.deathPos.z);
          this.deathT = 0;
          this.dropMapShown = false;
          this.deathUi = 1;
          this.deathUiT = 0;
          this.hud.showDeath(DEATH_TITLES[(Math.random() * DEATH_TITLES.length) | 0], killer && e.killer !== local ? killer.name : null, color);
          this.rig.shake(0.6);
          sfx("elimMe", null, { self: true });
        }
        break;
      }
      case "respawn":
        this.actors.onRespawn(e.pid);
        if (e.pid === local) {
          this.hud.hideDeath();
          this.rig.snap();
          const me = this.source.me();
          if (me && me.move === Move.Glide) {
            this.startDrop(me);
            sfx("skyDrop");
          } else {
            if (me) { this.input.yaw = this.landward(me.x, me.z, me.yaw); this.input.pitch = -0.1; }
            sfx("respawn");
          }
        }
        break;
      case "pickup": {
        this.actors.onPickup(e.pickup);
        if (e.pid === local) {
          if (e.drop) {
            const names: string[] = [];
            for (let k = 1; k <= 7; k++) if (e.drop & (1 << k)) names.push(upgradeName(k as PickupKind));
            if (e.ammo) names.push(`+${e.ammo} paint`);
            this.hud.toast("Loot!", names.join(" · "), "#f6c94c");
          } else if (e.ammo) this.hud.toast("+Paint", `Scavenged ${e.ammo} paintballs`, "#ffc9a8");
          else if (e.kind === PickupKind.Ammo) this.hud.toast("+Paint", "Reserve refilled", "#ffc9a8");
          else this.hud.upgradeToast(e.kind as PickupKind);
          sfx(e.kind === PickupKind.Ammo ? "pickup" : "upgrade");
        }
        break;
      }
      case "pickupSpawn":
        this.actors.onPickupSpawn(e.pickup);
        break;
      case "vehicleEnter": {
        const v = this.source.snapshot().vehicles.find((v) => v.id === e.vehicle);
        if (e.pid === local) {
          sfx(v?.kind === VehicleKind.Vespa && e.seat === 0 ? "vespaStart" : "vehicleEnter");
          if (v && e.seat === 0) {
            const [title, help] = v.kind === VehicleKind.Vespa ? ["Andiamo!", "W/S throttle · A/D steer · E hop off"]
              : v.kind === VehicleKind.Jetski ? ["Vroom!", "W/S throttle · A/D carve · Space hop · E hop off"]
              : v.kind === VehicleKind.Speedboat ? ["Dolce vita!", "W/S throttle · A/D steer · E hop off"]
              : ["Buon volo!", "W/S throttle · mouse / A/D steer · mouse or Space/Ctrl climb · E bail out"];
            this.hud.toast(title, help);
            // the gyro flies where you look: start level, facing down the take-off run
            if (v.kind === VehicleKind.Gyrocopter) { this.input.yaw = v.yaw; this.input.pitch = -0.14; }
          }
          else if (v) this.hud.toast("Passenger", "You can shoot from here!");
        }
        break;
      }
      case "vehicleExit":
        if (e.pid === local) sfx("vehicleExit");
        break;
      case "vehicleBump": {
        const v = this.source.snapshot().vehicles.find((v) => v.id === e.vehicle);
        if (v) {
          if (v.kind === VehicleKind.Vespa || v.kind === VehicleKind.Gyrocopter) fx.dust({ x: v.x, y: v.y + 0.2, z: v.z }, v.kind === VehicleKind.Gyrocopter ? 9 : 5);
          else fx.spray({ x: v.x, y: v.y + 0.2, z: v.z }, { x: 0, y: 2, z: 0 }, 6);
          const me = this.source.me();
          if (me && me.vehicle === v.id) this.rig.shake(Math.min(0.5, e.speed * 0.05));
          sfx("bump", v, { volume: Math.min(1, e.speed / 8) });
        }
        break;
      }
      case "zipStart":
        if (e.pid === local) {
          sfx("zipStart", null, { self: true });
          this.hud.toast("Wheee!", "Space to let go · you can shoot!");
          const z = this.source.snapshot().ziplines[e.zip];
          if (z) { this.input.yaw = Math.atan2(z.bx - z.ax, z.bz - z.az); this.input.pitch = -0.2; }
        } else sfx("zipStart", this.source.snapshot().players.find((p) => p.id === e.pid));
        break;
      case "zipEnd":
        if (e.pid === local) sfx("zipEnd");
        break;
      case "wash": {
        const p = this.source.snapshot().players.find((p) => p.id === e.pid);
        if (p) {
          fx.bubbles({ x: p.x, y: p.y + 0.9, z: p.z }, 14);
          fx.burst({ x: p.x, y: p.y + 0.9, z: p.z }, { x: 0, y: 1, z: 0 }, e.color, 0.9);
        }
        if (e.pid === local) { this.hud.toast(e.coats === 0 ? "Squeaky clean!" : "Washed off!", e.coats ? `${e.coats} coat${e.coats > 1 ? "s" : ""} left` : "All paint gone", "#c4e9e2"); sfx("wash"); }
        break;
      }
      case "wear": {
        // a coat dried and flaked off: a small puff of its color, no fanfare
        const p = this.source.snapshot().players.find((p) => p.id === e.pid);
        if (p) {
          fx.burst({ x: p.x, y: p.y + 1, z: p.z }, { x: 0, y: 1, z: 0 }, e.color, 0.45);
          fx.dust({ x: p.x, y: p.y + 0.9, z: p.z }, 3, e.color);
        }
        if (e.pid === local && e.coats === 0) this.hud.toast("Paint wore off", "Clean again", "#c4e9e2");
        break;
      }
      case "move": this.moveFx(e); break;
      case "reload": if (e.pid === local) sfx("reload"); break;
      case "reloaded": if (e.pid === local) sfx("reloaded"); break;
      case "empty": if (e.pid === local) { sfx("empty"); this.hud.toast("Out of paint!", "Find an ammo crate", "#ffc9a8"); } break;
      case "matchEnd": break;
      default: break;
    }
  }

  private moveFx(e: Extract<SimEvent, { type: "move" }>): void {
    const local = e.pid === this.source.localId;
    const fx = this.actors.fx;
    const b = e.fx;
    const p = this.source.snapshot().players.find((q) => q.id === e.pid);
    const W = p ? p.waterY : 0;
    if (b & Fx.Jump) { sfx("jump", e); if (p && p.move !== Move.Swim) fx.dust(e, 3); }
    if (b & Fx.LandHard) { fx.dust(e, 10); fx.ring({ x: e.x, y: e.y + 0.05, z: e.z }, 0xf3e0bb, 2.2, 0.5); if (local) { this.rig.shake(0.3); this.rig.dip(e.speed + 12); } sfx("landHard", e); }
    else if (b & Fx.Land) { fx.dust(e, 4); if (local) this.rig.dip(6); sfx("land", e); }
    if (b & Fx.Slide) sfx("slide", e);
    if (b & Fx.Dive) sfx("dive", e);
    if (b & Fx.Mantle) sfx("mantle", e);
    if (b & Fx.WaterEnter) {
      const belly = (b & Fx.BellyFlop) !== 0;
      const y = W > NO_WATER_Y ? W : e.y + 1;
      const s = belly ? 2.6 : Math.min(2, 0.6 + e.speed * 0.08);
      fx.splashWater({ x: e.x, y, z: e.z }, s);
      if (belly) { fx.splashWater({ x: e.x + 0.6, y, z: e.z + 0.3 }, 1.6); if (local) { this.rig.shake(0.35); this.hud.bigText("Splash!", "belly-flop"); } }
      sfx(belly ? "bellyflop" : "splash", e);
    }
    if (b & Fx.SkyLand) {
      // SPLORT: a sky diver pancakes onto the ground (or belly-flops into the water, above)
      if (!(b & Fx.WaterEnter)) {
        const g = raycast(this.source.env.cw, e.x, e.y + 1, e.z, 0, -1, 0, 3);
        const y = (g?.y ?? e.y) + 0.06;
        fx.ring({ x: e.x, y, z: e.z }, 0xf3e0bb, 3.2, 0.55);
        fx.dust({ x: e.x, y: y + 0.1, z: e.z }, 14);
        fx.dust({ x: e.x, y: y + 0.1, z: e.z }, 6, p ? this.name(p.id).color : undefined);
        sfx("skySplat", e);
      }
      if (local) {
        this.rig.shake(0.4);
        this.rig.dip(22);
        if (!(b & Fx.WaterEnter)) this.hud.bigText("Splat!", LANDING_QUIPS[(Math.random() * LANDING_QUIPS.length) | 0]);
      }
    }
    if (b & Fx.Submerge) sfx("submerge", e);
    if (b & Fx.Gasp) { sfx("gasp", e); if (local) this.hud.toast("*gasp*", "Out of breath — can't dive for a moment", "#c4e9e2"); }
    else if (b & Fx.Surface) sfx("surface", e);

  }

  private snapColor(): number {
    return this.source.snapshot().info.get(this.source.localId)?.color ?? 0xffffff;
  }

  /** Sky-drop HUD: altitude and predicted landing. */
  private dropHud(me: PlayerState): NonNullable<HudFrame["drop"]> {
    const g = Math.max(0, terrainHeight(this.opts.world, me.x, me.z));
    return { alt: me.y - g, landing: this.sky.landingValid ? { x: this.sky.landing.x, z: this.sky.landing.z } : null };
  }

  // ------------------------------------------------------------------ debug API
  debugApi(): Record<string, unknown> {
    const src = this.source as GameSource & { sim?: import("../../../shared/sim/index").MatchSim; dummiesActive?: boolean; dummiesShoot?: boolean };
    const sim = src.sim;
    const me = () => this.source.me();
    return {
      sim,
      game: this,
      /** Local player's sim state (plain copy). */
      state: () => {
        const p = me();
        if (!p) return null;
        return {
          x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2), vx: +p.vx.toFixed(2), vy: +p.vy.toFixed(2), vz: +p.vz.toFixed(2),
          move: Object.entries(Move).find(([, v]) => v === p.move)?.[0], grounded: p.grounded, alive: p.alive,
          coats: p.coats.length, breath: +p.breath.toFixed(2), gasp: +p.gasp.toFixed(2), stamina: +p.stamina.toFixed(2),
          hopper: p.hopper, reserve: p.reserve, upgrades: p.upgrades, score: p.score, deaths: p.deaths, vehicle: p.vehicle, zip: p.zip,
          waterY: p.waterY > NO_WATER_Y ? +p.waterY.toFixed(2) : null, shield: +p.shield.toFixed(2), yaw: +p.yaw.toFixed(3),
        };
      },
      teleport: (x: number, y: number | null, z: number) => { sim?.teleport(this.source.localId, x, y ?? NaN, z); this.rig.snap(); return true; },
      give: (kind: keyof typeof PickupKind | number) => { const k = typeof kind === "number" ? kind : PickupKind[kind]; sim?.giveUpgrade(this.source.localId, k); return true; },
      /** Camera look (degrees). */
      look: (yawDeg: number, pitchDeg = -5) => { this.input.yaw = (yawDeg * Math.PI) / 180; this.input.pitch = (pitchDeg * Math.PI) / 180; return true; },
      /** Face a world point. */
      lookAt: (x: number, y: number, z: number) => { const p = me(); if (!p) return false; this.input.yaw = Math.atan2(x - p.x, z - p.z); this.input.pitch = Math.atan2(y - (p.y + 1.5), Math.hypot(x - p.x, z - p.z)); return true; },
      /** Scripted input for ms; resolves with the resulting state. */
      input: async (o: InputOverride, ms: number) => { await this.input.setOverride(o, ms); return (this.debugApi().state as () => unknown)(); },
      /** Walk through waypoints [{x,z},…] (autopilot); resolves when done. */
      follow: (pts: { x: number; z: number }[], o: InputOverride = {}, timeoutMs = 60000) => this.followPath(pts, o, timeoutMs),
      /** Waypoints through cave k from entrance a to entrance b (BFS over the node graph). */
      cavePath: (k: number, a = 0, b = 1) => {
        const c = this.opts.world.caves[k];
        if (!c) return null;
        const near = (e: { x: number; z: number; y: number }) => { let bi = 0, bd = 1e9; c.nodes.forEach((n, i) => { const d = (n.x - e.x) ** 2 + (n.z - e.z) ** 2 + (n.y - e.y) ** 2; if (d < bd) { bd = d; bi = i; } }); return bi; };
        const s0 = near(c.entrances[a]), s1 = near(c.entrances[b]);
        const adj: number[][] = c.nodes.map(() => []);
        for (const [i, j] of c.edges) { adj[i].push(j); adj[j].push(i); }
        const prev = new Map<number, number>([[s0, -1]]);
        const q = [s0];
        while (q.length) { const n = q.shift()!; if (n === s1) break; for (const m of adj[n]) if (!prev.has(m)) { prev.set(m, n); q.push(m); } }
        const path: { x: number; z: number; y: number }[] = [];
        for (let n = s1; n !== -1 && n !== undefined; n = prev.get(n)!) path.unshift({ x: c.nodes[n].x, z: c.nodes[n].z, y: c.nodes[n].y });
        const ea = c.entrances[a], eb = c.entrances[b];
        return [{ x: ea.x + ea.dx * 4, z: ea.z + ea.dz * 4, y: ea.y }, { x: ea.x, z: ea.z, y: ea.y }, ...path, { x: eb.x, z: eb.z, y: eb.y }, { x: eb.x + eb.dx * 6, z: eb.z + eb.dz * 6, y: eb.y }];
      },
      /** Chain scripted inputs without gaps: [[{moveZ:1,sprint:true},1000],[{crouch:true,moveZ:1},400]]. */
      inputSeq: async (steps: [InputOverride, number][]) => { await this.input.setOverrideSeq(steps); return (this.debugApi().state as () => unknown)(); },
      wait: (ms: number) => new Promise((r) => setTimeout(r, ms)),
      paint: (n = 1, from = -1) => { const p = me(); if (!p || !sim) return 0; const s = from >= 0 ? from : sim.players.find((q) => q.id !== p.id)?.id ?? p.id; p.shield = 0; for (let i = 0; i < n; i++) sim.paint(p.id, s); return p.coats.length; },
      /** Drop me back in from the sky (offline). */
      skyDrop: () => { const p = me(); if (!p || !sim) return false; const q = sim.player(p.id); if (q) sim.skyDrop(q); return true; },
      /** Hot zones as the client sees them. */
      zones: () => this.sky.zones.map((z) => ({ x: +z.x.toFixed(1), z: +z.z.toFixed(1), heat: +z.heat.toFixed(2), color: z.color })),
      landing: () => (this.sky.landingValid ? { x: +this.sky.landing.x.toFixed(1), y: +this.sky.landing.y.toFixed(1), z: +this.sky.landing.z.toFixed(1) } : null),
      dummies: (active: boolean, shoot = active) => { src.dummiesActive = active; src.dummiesShoot = shoot; return true; },
      dummy: (i = 0) => sim?.players.filter((p) => p.id !== this.source.localId)[i] ?? null,
      /** Put dummy i at a spot relative to me (meters ahead / right). */
      placeDummy: (i: number, ahead: number, right = 0) => {
        const p = me(); const d = sim?.players.filter((q) => q.id !== this.source.localId)[i];
        if (!p || !d || !sim) return false;
        const fx = Math.sin(this.input.yaw), fz = Math.cos(this.input.yaw);
        sim.teleport(d.id, p.x + fx * ahead - fz * right, NaN, p.z + fz * ahead + fx * right);
        d.shield = 0;
        return true;
      },
      interact: () => this.source.interactTarget(),
      vehicles: () => this.source.snapshot().vehicles.map((v) => ({ id: v.id, kind: v.kind, x: +v.x.toFixed(1), y: +v.y.toFixed(1), z: +v.z.toFixed(1), yaw: +v.yaw.toFixed(2), speed: +v.speed.toFixed(2), seats: v.seats })),
      ziplines: () => this.source.snapshot().ziplines.map((z) => ({ a: [z.ax, z.ay, z.az].map((n) => +n.toFixed(1)), b: [z.bx, z.by, z.bz].map((n) => +n.toFixed(1)), len: +z.length.toFixed(1) })),
      caves: () => this.opts.world.caves.map((c) => c.entrances.map((e) => ({ x: +e.x.toFixed(1), y: +e.y.toFixed(1), z: +e.z.toFixed(1), dx: +e.dx.toFixed(2), dz: +e.dz.toFixed(2) }))),
      structures: () => this.opts.world.structures.map((s) => ({ kind: s.kind, x: +s.x.toFixed(1), y: +s.y.toFixed(1), z: +s.z.toFixed(1), n: s.solids.length })),
      pickups: () => this.source.snapshot().pickups.filter((p) => p.kind !== 0).map((p) => ({ id: p.id, kind: p.kind, x: +p.x.toFixed(1), y: +p.y.toFixed(1), z: +p.z.toFixed(1), active: p.active })),
      events: () => this.events.map((e) => e.type),
      sfx: () => recentSfx(),
      audio: () => audioStats(),
      hud: (v: boolean) => { this.hud.root.style.display = v ? "" : "none"; return true; },
      map: (open: boolean) => { this.hud.toggleMap(open); return true; },
      scoreboard: (open: boolean) => { this.hud.setScoreboard(open); return true; },
      shoulder: () => { this.rig.side *= -1; return this.rig.side; },
      endMatch: () => { if (sim) (sim as unknown as { time: number }).time = sim.duration - 0.05; return true; },
      water: (x: number, z: number) => { const p = me(); return p ? p.waterY : null; void x; void z; },
    };
  }

  dispose(): void {
    this.stop();
    if (this.startTimer) clearTimeout(this.startTimer);
    sfxStopAll();
    window.removeEventListener("resize", this.onResize);
    this.input.dispose();
    this.hud.dispose();
    this.arc.dispose();
    this.sky.dispose();
    this.actors.dispose();
    this.source.dispose();
  }
}

