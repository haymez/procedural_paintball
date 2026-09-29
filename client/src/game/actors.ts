// Sim state → three.js actors. Blobs, vehicles, ziplines, pickups, paintballs
// and name tags are created lazily and driven every frame from the snapshot,
// interpolated between the last two ticks.
import * as THREE from "three";
import { PickupKind, VehicleKind } from "../../../shared/world/types";
import { sdf, terrainHeight } from "../../../shared/world/collide";
import {
  Move, SPAWN_SHIELD, WASH_TIME, NO_WATER_Y,
  type PlayerState, type SimSnapshot, type VehicleState, type ProjectileState, type SimEnv,
} from "../../../shared/sim/index";
import {
  createBlob, createNameTag, createPaintFx, createPickup, createVehicle, createZipline,
  type BlobActor, type BlobMode, type BlobState, type NameTag, type PaintFx, type PickupActor, type VehicleActor, type ZiplineActor,
} from "../render/actors/index";
import type { WorldView } from "../render/worldView";

interface PlayerActor {
  id: number;
  blob: BlobActor;
  st: BlobState;
  tag: NameTag | null;
  px: number; py: number; pz: number; pyaw: number;
  wet: number;
  spawnT: number;
  losT: number;
  los: boolean;
  deadHidden: boolean;
  coats: number[];
  washSwirlT: number;
  dripD: number;
}

interface VehicleWrap {
  id: number;
  actor: VehicleActor;
  holder: THREE.Group | null;
  px: number; py: number; pz: number; pyaw: number;
}

interface BallFix { ox: number; oy: number; oz: number; t: number }

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  d -= Math.PI * 2 * Math.floor((d + Math.PI) / (Math.PI * 2));
  return a + d * t;
}

export class Actors {
  readonly fx: PaintFx;
  readonly group = new THREE.Group();
  readonly players = new Map<number, PlayerActor>();
  private vehicles = new Map<number, VehicleWrap>();
  private zips: ZiplineActor[] = [];
  private pickups = new Map<number, PickupActor>();
  private ballFix = new Map<number, BallFix>();
  private ballPos = new Map<number, THREE.Vector3>();
  private ballPool: THREE.Vector3[] = [];
  private time = 0;
  private frame = 0;
  localId: number;
  /** Local player's latest input yaw/pitch (rendered without tick latency). */
  localYaw = 0;
  localPitch = 0;
  /** Hide the local blob (camera inside it). */
  hideLocal = false;

  constructor(private view: WorldView, private env: SimEnv, private snap: SimSnapshot, localId: number) {
    this.localId = localId;
    view.scene.add(this.group);
    this.fx = createPaintFx(this.group, { gravity: 9, ground: (x, z) => waterOrGround(env, x, z) });
    // ziplines (static)
    for (const z of snap.ziplines) {
      const a = createZipline({ x: z.ax, y: z.ay, z: z.az }, { x: z.bx, y: z.by, z: z.bz });
      this.group.add(a.object);
      this.zips.push(a);
    }
  }

  /** Remember where everything was before the next tick (for interpolation). */
  capturePrev(): void {
    for (const p of this.snap.players) {
      const a = this.players.get(p.id);
      if (a) { a.px = p.x; a.py = p.y; a.pz = p.z; a.pyaw = p.yaw; }
    }
    for (const v of this.snap.vehicles) {
      const w = this.vehicles.get(v.id);
      if (w) { w.px = v.x; w.py = v.y; w.pz = v.z; w.pyaw = v.yaw; }
    }
  }

  private ensurePlayer(p: PlayerState): PlayerActor {
    let a = this.players.get(p.id);
    if (a) return a;
    const info = this.snap.info.get(p.id);
    const color = info?.color ?? 0xffffff;
    const blob = createBlob({ color, fx: this.fx, seed: p.id * 13 + 7 });
    this.group.add(blob.object);
    const st: BlobState = {
      pos: new THREE.Vector3(p.x, p.y, p.z), yaw: p.yaw, aimPitch: 0, vel: new THREE.Vector3(),
      grounded: true, mode: "idle", firing: false, coats: [], wetness: 0, breath: 1,
    };
    let tag: NameTag | null = null;
    if (p.id !== this.localId) {
      tag = createNameTag(info?.name ?? "?", color);
      this.group.add(tag.sprite);
    }
    a = { id: p.id, blob, st, tag, px: p.x, py: p.y, pz: p.z, pyaw: p.yaw, wet: 0, spawnT: 9, losT: Math.random(), los: true, deadHidden: false, coats: [], washSwirlT: 0, dripD: 0 };
    this.players.set(p.id, a);
    return a;
  }

  private ensureVehicle(v: VehicleState): VehicleWrap {
    let w = this.vehicles.get(v.id);
    if (w) return w;
    const actor = createVehicle(v.kind, { fx: this.fx, color: v.kind === VehicleKind.Vespa ? undefined : undefined });
    let holder: THREE.Group | null = null;
    if (v.kind === VehicleKind.Vespa) {
      holder = new THREE.Group();
      holder.add(actor.object);
      this.group.add(holder);
    } else this.group.add(actor.object);
    w = { id: v.id, actor, holder, px: v.x, py: v.y, pz: v.z, pyaw: v.yaw };
    this.vehicles.set(v.id, w);
    return w;
  }

  onRespawn(pid: number): void {
    const a = this.players.get(pid);
    if (a) { a.spawnT = 0; a.deadHidden = false; }
  }

  onShot(pid: number, proj: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, color: number): void {
    const a = this.players.get(pid);
    const pos = _v.set(x, y, z);
    if (a) {
      a.blob.fire();
      // start the visual ball at the blob's real muzzle and blend into the sim path
      a.blob.getMuzzle(_v2);
      if (_v2.distanceToSquared(pos) < 4) {
        this.ballFix.set(proj, { ox: _v2.x - x, oy: _v2.y - y, oz: _v2.z - z, t: 0 });
        pos.copy(_v2);
      }
      this.fx.muzzle(pos, _v2.set(vx, vy, vz).normalize(), color);
    }
    this.fx.spawnBall(proj, pos, { x: vx, y: vy, z: vz }, color);
  }

  onBallEnd(proj: number): void {
    this.fx.removeBall(proj);
    this.ballFix.delete(proj);
  }

  onPickup(id: number): void {
    const a = this.pickups.get(id);
    if (a && a.active) a.collect(this.fx);
  }

  onPickupSpawn(id: number): void {
    const a = this.pickups.get(id);
    if (a && !a.active) a.respawn();
  }

  blobOf(pid: number): BlobActor | undefined {
    return this.players.get(pid)?.blob;
  }

  /** Interpolated feet position of a player. */
  playerPos(pid: number, out: THREE.Vector3): THREE.Vector3 | null {
    const a = this.players.get(pid);
    if (!a) return null;
    return out.set(a.st.pos.x, a.st.pos.y, a.st.pos.z);
  }

  update(dt: number, alpha: number, camera: THREE.PerspectiveCamera): void {
    this.time += dt;
    this.frame++;
    const snap = this.snap;
    const camPos = camera.position;

    // ---- vehicles first (seats + grips) -------------------------------------------
    for (const v of snap.vehicles) {
      const w = this.ensureVehicle(v);
      const x = w.px + (v.x - w.px) * alpha, y = w.py + (v.y - w.py) * alpha, z = w.pz + (v.z - w.pz) * alpha;
      const yaw = lerpAngle(w.pyaw, v.yaw, alpha);
      let occupied = false;
      for (let i = 0; i < v.seats.length; i++) if (v.seats[i] >= 0) occupied = true;
      if (w.holder) {
        w.holder.position.set(x, y, z);
        w.holder.rotation.set(-v.pitch, yaw, 0, "YXZ");
        w.holder.updateMatrixWorld(true);
        w.actor.update(dt, { pos: { x: 0, y: 0, z: 0 }, yaw: 0, speed: v.speed, steer: v.steer, throttle: Math.max(0, v.throttle), occupied });
      } else {
        const wy = y + (y > -0.5 && y < 0.5 ? this.view.waveHeight(x, z, this.time) * 0.8 : 0);
        w.actor.update(dt, { pos: { x, y, z }, yaw, speed: v.speed, steer: v.steer, rowing: v.seats[0] >= 0 && Math.abs(v.throttle) > 0.05, occupied, waterY: wy });
      }
    }

    // ---- ziplines: pulley follows the first rider ----------------------------------
    for (let i = 0; i < this.zips.length; i++) {
      let rider: PlayerState | null = null;
      for (const p of snap.players) if (p.alive && p.move === Move.Zipline && p.zip === i) { rider = p; break; }
      this.zips[i].update(dt, rider ? Math.min(1, rider.zipT) : null, !!rider);
    }

    // ---- players --------------------------------------------------------------------
    const seen = this.frame;
    for (const p of snap.players) {
      const a = this.ensurePlayer(p);
      (a as unknown as { seen: number }).seen = seen;
      const st = a.st;
      const local = p.id === this.localId;
      const x = a.px + (p.x - a.px) * alpha, y = a.py + (p.y - a.py) * alpha, z = a.pz + (p.z - a.pz) * alpha;
      (st.pos as THREE.Vector3).set(x, y, z);
      (st.vel as THREE.Vector3).set(p.vx, p.vy, p.vz);
      st.yaw = local ? this.localYaw : lerpAngle(a.pyaw, p.yaw, alpha);
      st.aimPitch = local ? this.localPitch : p.pitch;
      st.grounded = p.grounded || p.move === Move.Ground || p.move === Move.Slide;
      st.breath = p.breath;
      st.seat = null;
      st.grips = null;
      st.standing = false;
      st.aimYaw = undefined;
      st.waterY = p.waterY > NO_WATER_Y ? p.waterY : undefined;
      // coats: copy so the blob sees changes as new arrays
      let coatsChanged = a.coats.length !== p.coats.length;
      for (let i = 0; !coatsChanged && i < p.coats.length; i++) if (a.coats[i] !== p.coats[i]) coatsChanged = true;
      if (coatsChanged) {
        if (p.coats.length < a.coats.length && p.alive && (p.move === Move.Swim || p.move === Move.Underwater)) a.washSwirlT = 0.6;
        a.coats = p.coats.slice();
        st.coats = a.coats;
      }
      // wetness
      const inWater = p.move === Move.Swim || p.move === Move.Underwater || (p.waterY > NO_WATER_Y && p.waterY > p.y + 0.4);
      a.wet = inWater ? 1 : Math.max(0, a.wet - dt * 0.12);
      st.wetness = a.wet;
      a.spawnT += dt;
      st.shield = p.alive && p.shield > 0 ? Math.min(1, p.shield / SPAWN_SHIELD + 0.2) : 0;
      st.mode = this.modeFor(p, a);
      if (p.move === Move.Vehicle && p.vehicle >= 0) {
        const w = this.vehicles.get(p.vehicle);
        if (w) {
          const seats = w.actor.seats;
          st.seat = p.seat === 0 ? seats.driver : p.seat === 1 ? seats.passenger ?? seats.driver : seats.passenger2 ?? seats.driver;
          if (p.seat === 0) {
            st.grips = { l: w.actor.gripL, r: w.actor.gripR };
            st.standing = w.actor.driverStanding;
          } else st.aimYaw = local ? this.localYaw : p.yaw;
        }
      } else if (p.move === Move.Zipline && p.zip >= 0 && this.zips[p.zip]) {
        const zp = this.zips[p.zip];
        (st.pos as THREE.Vector3).copy(zp.riderPos);
        st.grips = { l: zp.gripL, r: zp.gripR };
        st.aimYaw = local ? this.localYaw : p.yaw;
        st.yaw = zp.yaw;
      } else if (p.move === Move.Mantle) {
        // hands on the ledge edge
        const dx = p.mx1 - p.mx0, dz = p.mz1 - p.mz0;
        const l = Math.hypot(dx, dz) || 1;
        const ex = p.mx0 + (dx / l) * 0.45, ez = p.mz0 + (dz / l) * 0.45;
        const rx = -dz / l * 0.24, rz = dx / l * 0.24;
        st.grips = { l: { x: ex - rx, y: p.my1 + 0.04, z: ez - rz }, r: { x: ex + rx, y: p.my1 + 0.04, z: ez + rz } };
        st.yaw = Math.atan2(dx, dz);
      }
      a.blob.object.visible = !(local && this.hideLocal) && !a.deadHidden;
      a.blob.update(dt, st);

      // painted blobs drip their coats on the ground: trails to follow
      if (p.alive && p.coats.length && p.grounded && (p.move === Move.Ground || p.move === Move.Slide)) {
        const sp = Math.hypot(p.vx, p.vz);
        a.dripD += (sp + 0.5) * dt * (0.5 + p.coats.length * 0.4);
        if (a.dripD > 1.6) {
          a.dripD = Math.random() * 0.6;
          const g = terrainHeight(this.env.world, x, z);
          if (Math.abs(g - y) < 0.25) {
            const c = p.coats[(Math.random() * p.coats.length) | 0];
            const j = 0.25;
            this.view.paint.splat(x + (Math.random() - 0.5) * j, g, z + (Math.random() - 0.5) * j, 0, 1, 0, 0.09 + Math.random() * 0.06 + p.coats.length * 0.025, c);
          }
        }
      }

      // wash swirl: the old paint color curls off into the water
      if (a.washSwirlT > 0) {
        a.washSwirlT -= dt;
        if (Math.random() < dt * 30) this.fx.bubbles({ x: x + (Math.random() - 0.5) * 0.6, y: y + 0.8, z: z + (Math.random() - 0.5) * 0.6 }, 2);
      }
      if (p.move === Move.Underwater && p.coats.length && p.wash > WASH_TIME * 0.2 && Math.random() < dt * 14) {
        const c = p.coats[p.coats.length - 1];
        const ang = this.time * 6 + p.id;
        this.fx.burst({ x: x + Math.cos(ang) * 0.5, y: y + 0.7 + Math.random() * 0.6, z: z + Math.sin(ang) * 0.5 }, { x: Math.cos(ang + 1.6), y: 0.6, z: Math.sin(ang + 1.6) }, c, 0.22);
      }

      // name tag with line-of-sight check (staggered)
      if (a.tag) {
        a.blob.getTagAnchor(_v);
        const d = _v.distanceTo(camPos);
        a.losT -= dt;
        if (a.losT <= 0 && d < 70) {
          a.losT = 0.2 + Math.random() * 0.1;
          a.los = clearLine(this.env, camPos, _v, d);
        }
        a.tag.update(_v, p.alive && d < 55 && a.los);
      }
    }
    // players that left
    for (const [id, a] of this.players) {
      if ((a as unknown as { seen: number }).seen !== seen) {
        a.blob.dispose();
        a.blob.object.removeFromParent();
        a.tag?.dispose();
        this.players.delete(id);
      }
    }

    // ---- pickups ---------------------------------------------------------------------
    for (const k of snap.pickups) {
      let a = this.pickups.get(k.id);
      if (!a) {
        a = createPickup(k.kind);
        a.object.position.set(k.x, k.y, k.z);
        toneDownBeacon(a, k.kind, k.drop !== 0);
        this.group.add(a.object);
        this.pickups.set(k.id, a);
        if (!k.active) a.collect(null);
      }
      (a as unknown as { seen: number }).seen = seen;
      if (!k.active && a.active) a.collect(null);
      else if (k.active && !a.active) a.respawn();
      const dx = k.x - camPos.x, dz = k.z - camPos.z;
      const near = dx * dx + dz * dz < 95 * 95;
      if (near) a.update(dt, camPos);
      if (a.active || !near) a.object.visible = near;
    }
    for (const [id, a] of this.pickups) {
      if ((a as unknown as { seen: number }).seen !== seen) {
        a.dispose();
        this.pickups.delete(id);
      }
    }

    // ---- paintballs ---------------------------------------------------------------
    this.ballPool.push(...this.ballPos.values());
    this.ballPos.clear();
    const tick = 1 / 60;
    for (const b of snap.projectiles) this.ballPos.set(b.id, this.ballPosFor(b, alpha * tick, dt));
    this.fx.setViewer(camPos);
    this.fx.updateBalls(dt, this.ballPos);
  }

  private ballPosFor(b: ProjectileState, ahead: number, dt: number): THREE.Vector3 {
    const v = this.ballPool.pop() ?? new THREE.Vector3();
    v.set(b.x + b.vx * ahead, b.y + (b.vy - 4.5 * ahead) * ahead, b.z + b.vz * ahead);
    const f = this.ballFix.get(b.id);
    if (f) {
      f.t += dt;
      const k = Math.max(0, 1 - f.t / 0.12);
      v.x += f.ox * k; v.y += f.oy * k; v.z += f.oz * k;
      if (k <= 0) this.ballFix.delete(b.id);
    }
    return v;
  }

  private modeFor(p: PlayerState, a: PlayerActor): BlobMode {
    if (!p.alive) return "eliminated";
    if (a.spawnT < 0.55) return "spawn";
    switch (p.move) {
      case Move.Ground: {
        const s = Math.hypot(p.vx, p.vz);
        if (s < 0.4) return "idle";
        return p.sprinting ? "sprint" : "run";
      }
      case Move.Air: return p.vy > 0.5 ? "jump" : "fall";
      case Move.Slide: case Move.SteepSlide: return "slide";
      case Move.Dive: return "dive";
      case Move.Swim: return "swim";
      case Move.Underwater: return "underwater";
      case Move.Mantle: return "mantle";
      case Move.Zipline: return "zipline";
      case Move.Vehicle: {
        if (p.seat === 0) {
          const w = this.vehicles.get(p.vehicle);
          return w ? w.actor.driverMode : "passenger";
        }
        return "passenger";
      }
      default: return "idle";
    }
  }

  dispose(): void {
    for (const a of this.players.values()) { a.blob.dispose(); a.tag?.dispose(); }
    for (const w of this.vehicles.values()) w.actor.dispose();
    for (const z of this.zips) z.dispose();
    for (const k of this.pickups.values()) k.dispose();
    this.fx.dispose();
    this.group.removeFromParent();
  }
}

function waterOrGround(env: SimEnv, x: number, z: number): number {
  const w = env.world;
  const ix = Math.max(0, Math.min(512, Math.round((x + 512) / 2)));
  const iz = Math.max(0, Math.min(512, Math.round((z + 512) / 2)));
  const h = w.height[iz * 513 + ix];
  return h < 0 ? 0 : h;
}

/** Coarse line-of-sight (camera → tag) through the collision SDF. */
function clearLine(env: SimEnv, a: THREE.Vector3, b: THREE.Vector3, d: number): boolean {
  const dx = (b.x - a.x) / d, dy = (b.y - a.y) / d, dz = (b.z - a.z) / d;
  let t = 0.5;
  for (let i = 0; i < 40 && t < d - 1; i++) {
    const s = sdf(env.cw, a.x + dx * t, a.y + dy * t, a.z + dz * t);
    if (s < 0.05) return false;
    t += Math.max(0.3, s * 0.9);
  }
  return true;
}

/** Pickup beacons are tuned for a showcase; in play they should whisper, not shout. */
function toneDownBeacon(a: PickupActor, kind: PickupKind, dropped: boolean): void {
  a.object.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && (m.material as THREE.ShaderMaterial).isShaderMaterial) {
      const isAmmo = kind === PickupKind.Ammo;
      m.scale.set(isAmmo ? 0.7 : 0.85, isAmmo ? 0.35 : dropped ? 0.8 : 0.6, isAmmo ? 0.7 : 0.85);
    }
  });
}
