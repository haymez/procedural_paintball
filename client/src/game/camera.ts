// Third-person camera: over-the-shoulder, spring-smoothed, never inside the
// world (sphere-cast against the collision SDF), with FOV kicks, aim zoom,
// trauma shake, landing dips and vehicle / zipline / swim / death variants.
import * as THREE from "three";
import { sdf } from "../../../shared/world/collide";
import { AIM_ZOOM, Move, SCOPE_ZOOM, type MoveState } from "../../../shared/sim/index";
import type { SimEnv } from "../../../shared/sim/index";
import { NO_WATER_Y, waterAt } from "../../../shared/sim/index";

export interface CamContext {
  move: MoveState;
  aiming: boolean;
  scope: boolean;
  sprinting: boolean;
  speed: number;
  /** Vehicle kind when seated (0 rowboat, 1 gondola, 2 vespa) or -1. */
  vehicle: number;
  driver: boolean;
  steer: number;
  dead: boolean;
  deathT: number;
}

const damp = (k: number, dt: number) => 1 - Math.exp(-k * dt);
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _t = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  side = 1;
  private sideCur = 1;
  private pivot = new THREE.Vector3();
  private pivotInit = false;
  private distCur = 3.4;
  private fovCur = 72;
  private trauma = 0;
  private t = 0;
  private dipY = 0;
  private dipV = 0;
  private kickP = 0;
  private roll = 0;
  private aimK = 0;
  private deathYaw = 0;
  /** Distance from the camera to the pivot after collision (hide the local blob when tiny). */
  distance = 3.4;
  readonly forward = new THREE.Vector3();
  readonly right = new THREE.Vector3();
  waterY = NO_WATER_Y;

  constructor(private env: SimEnv, public baseFov = 72) {
    this.camera = new THREE.PerspectiveCamera(baseFov, 16 / 9, 0.2, 7000);
    this.fovCur = baseFov;
  }

  /** Add screen shake (0..1, stacks). */
  shake(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }
  /** Vertical landing dip (m/s of impact). */
  dip(v: number): void {
    this.dipV -= Math.min(v, 30) * 0.12;
  }
  /** Recoil kick (visual only). */
  kick(a: number): void {
    this.kickP += a;
  }
  get aimAmount(): number {
    return this.aimK;
  }
  snap(): void {
    this.pivotInit = false;
  }
  /** Match-start swoop: from high over the island down onto the player's shoulder. */
  intro(seconds = 3.2): void {
    this.introDur = seconds;
    this.introT = 0;
  }
  get introActive(): boolean {
    return this.introT < this.introDur;
  }
  private introT = 0;
  private introDur = 0;

  update(dt: number, feet: THREE.Vector3, yaw: number, pitch: number, c: CamContext): void {
    this.t += dt;
    // ---- desired rig ---------------------------------------------------------
    let pivotH = 1.62, shoulder = 0.78, back = 3.9, up = 0.3;
    let fovAdd = 0;
    const aimTarget = c.aiming ? 1 : 0;
    this.aimK += (aimTarget - this.aimK) * damp(14, dt);
    const ak = this.aimK;
    switch (c.move) {
      case Move.Slide: case Move.Dive: case Move.SteepSlide: pivotH = 1.05; back = 3.6; break;
      case Move.Swim: pivotH = 1.25; back = 3.8; up = 0.35; break;
      case Move.Underwater: pivotH = 0.7; back = 3.2; break;
      case Move.Zipline: pivotH = 1.7; back = 4.4; shoulder = 0.4; break;
      case Move.Vehicle: {
        const boat = c.vehicle === 0 || c.vehicle === 1;
        pivotH = boat ? 1.35 : 1.3;
        back = c.vehicle === 1 ? 7.5 : boat ? 5.8 : 5.2;
        shoulder = c.driver ? 0 : 0.5;
        up = c.driver ? 0.9 : 0.4;
        if (c.vehicle === 2) fovAdd += Math.min(12, c.speed * 0.75);
        break;
      }
    }
    if (c.sprinting) { back += 0.45; fovAdd += 7; }
    back = back * (1 - ak) + (c.scope ? 2.0 : 2.7) * ak;
    shoulder = shoulder * (1 - ak) + 1.02 * ak;
    up = up * (1 - ak) + 0.42 * ak;
    // looking down pulls the camera in a little, looking up pushes it out
    back *= 1 + Math.max(-0.25, Math.min(0.15, -pitch * 0.25));

    // ---- pivot smoothing -------------------------------------------------------
    const tx = feet.x, ty = feet.y + pivotH, tz = feet.z;
    if (!this.pivotInit) {
      this.pivot.set(tx, ty, tz);
      this.distCur = back;
      this.pivotInit = true;
    } else {
      const kxz = damp(c.move === Move.Vehicle ? 18 : 32, dt);
      const ky = damp(c.move === Move.Ground || c.move === Move.Slide ? 16 : 22, dt);
      this.pivot.x += (tx - this.pivot.x) * kxz;
      this.pivot.z += (tz - this.pivot.z) * kxz;
      this.pivot.y += (ty - this.pivot.y) * ky;
    }
    // landing dip spring
    this.dipV += (-this.dipY * 120 - this.dipV * 13) * dt;
    this.dipY += this.dipV * dt;
    this.dipY = Math.max(-0.5, Math.min(0.3, this.dipY));

    // ---- death cam: orbit the puddle -------------------------------------------
    let yawR = yaw, pitchR = pitch;
    if (c.dead) {
      this.deathYaw += dt * 0.35;
      yawR = yaw + this.deathYaw;
      pitchR = -0.55 - Math.min(0.25, c.deathT * 0.08);
      back = 5.5 + Math.min(3, c.deathT * 1.5);
      shoulder = 0;
      up = 0.6;
    } else this.deathYaw = 0;

    // ---- orientation --------------------------------------------------------------
    this.kickP += (0 - this.kickP) * damp(12, dt);
    const cp = Math.cos(pitchR), sp = Math.sin(pitchR);
    const f = this.forward.set(Math.sin(yawR) * cp, sp, Math.cos(yawR) * cp);
    const r = this.right.set(-Math.cos(yawR), 0, Math.sin(yawR));
    this.sideCur += (this.side - this.sideCur) * damp(10, dt);

    // shoulder point, then back along -forward; both sphere-cast
    const px = this.pivot.x, py = this.pivot.y + this.dipY, pz = this.pivot.z;
    const sx = r.x * shoulder * this.sideCur, sy = up, sz = r.z * shoulder * this.sideCur;
    const k1 = this.cast(px, py, pz, sx, sy, sz, 0.26);
    const ax = px + sx * k1, ay = py + sy * k1, az = pz + sz * k1;
    const want = back;
    const got = this.cast(ax, ay, az, -f.x * want, -f.y * want, -f.z * want, 0.3) * want;
    if (got < this.distCur) this.distCur = got;
    else this.distCur += (got - this.distCur) * damp(3.5, dt);
    const d = this.distCur;
    let cx = ax - f.x * d, cy = ay - f.y * d, cz = az - f.z * d;

    // keep the lens on the right side of the water surface
    const W = waterAt(this.env, cx, cz);
    this.waterY = W;
    if (W !== NO_WATER_Y && !c.dead) {
      if (c.move === Move.Underwater) { if (cy > W - 0.35) cy = W - 0.35; }
      else if (cy < W + 0.4 && feet.y > W - 1.6) cy = W + 0.4;
    }

    // ---- shake ---------------------------------------------------------------------
    this.trauma = Math.max(0, this.trauma - dt * 1.7);
    const s = this.trauma * this.trauma;
    const n1 = Math.sin(this.t * 37.1) * 0.6 + Math.sin(this.t * 71.3) * 0.4;
    const n2 = Math.sin(this.t * 43.7 + 1.3) * 0.6 + Math.sin(this.t * 63.1 + 2) * 0.4;
    const n3 = Math.sin(this.t * 29.9 + 4) * 0.7 + Math.sin(this.t * 53.3) * 0.3;
    cx += r.x * n1 * s * 0.18; cz += r.z * n1 * s * 0.18; cy += n2 * s * 0.14;

    // roll into vespa turns / slides
    const rollT = c.move === Move.Vehicle && c.vehicle === 2 ? -c.steer * Math.min(1, c.speed / 10) * 0.07 : c.move === Move.Slide ? 0.02 * this.side : 0;
    this.roll += (rollT - this.roll) * damp(5, dt);

    const cam = this.camera;
    cam.position.set(cx, cy, cz);
    cam.rotation.set(pitchR + this.kickP + n3 * s * 0.035, yawR + Math.PI + n1 * s * 0.03, this.roll + n2 * s * 0.05, "YXZ");
    this.distance = Math.hypot(cx - px, cy - py, cz - pz);

    // ---- FOV ---------------------------------------------------------------------
    let fov = this.baseFov + fovAdd;
    if (ak > 0.001) {
      const z = c.scope ? SCOPE_ZOOM : AIM_ZOOM;
      const zf = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(this.baseFov) / 2) / z));
      fov = fov * (1 - ak) + zf * ak;
    }
    this.fovCur += (fov - this.fovCur) * damp(10, dt);
    if (Math.abs(cam.fov - this.fovCur) > 0.01) {
      cam.fov = this.fovCur;
      cam.updateProjectionMatrix();
    }
    if (this.introT < this.introDur) this.applyIntro(dt, px, py, pz);
    cam.updateMatrixWorld();
  }

  /** Blend the finished rig pose with a high orbit around the pivot, easing into the rig. */
  private applyIntro(dt: number, px: number, py: number, pz: number): void {
    this.introT += dt;
    const cam = this.camera;
    const u = Math.min(1, this.introT / this.introDur);
    const k = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2; // ease in-out cubic
    // final pose relative to the pivot, in spherical terms
    const ox = cam.position.x - px, oy = cam.position.y - py, oz = cam.position.z - pz;
    const d1 = Math.max(0.5, Math.hypot(ox, oy, oz));
    const e1 = Math.asin(Math.max(-1, Math.min(1, oy / d1)));
    const a1 = Math.atan2(ox, oz);
    const d = 95 + (d1 - 95) * k, e = 0.72 + (e1 - 0.72) * k, a = a1 + 2.1 * (1 - k);
    cam.position.set(px + Math.sin(a) * Math.cos(e) * d, py + Math.sin(e) * d, pz + Math.cos(a) * Math.cos(e) * d);
    _q1.copy(cam.quaternion);
    _m.lookAt(cam.position, _t.set(px, py, pz), _up);
    _q0.setFromRotationMatrix(_m);
    cam.quaternion.copy(_q0).slerp(_q1, k * k);
    const f = this.baseFov + 8 * (1 - k);
    if (Math.abs(cam.fov - f) > 0.01) { cam.fov = f; cam.updateProjectionMatrix(); }
  }

  /** Sphere-cast from o along d (not normalized); returns the free fraction 0..1. */
  private cast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, r: number): number {
    const L = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (L < 1e-5) return 1;
    const cw = this.env.cw;
    let t = 0;
    for (let i = 0; i < 48; i++) {
      const x = ox + (dx * t) / L, y = oy + (dy * t) / L, z = oz + (dz * t) / L;
      const d = sdf(cw, x, y, z) - r;
      if (d < 0.01) return Math.max(0, (t - 0.05) / L);
      t += Math.max(d * 0.9, 0.03);
      if (t >= L) return 1;
    }
    return Math.min(1, t / L);
  }

  setAspect(a: number): void {
    this.camera.aspect = a;
    this.camera.updateProjectionMatrix();
  }
}
