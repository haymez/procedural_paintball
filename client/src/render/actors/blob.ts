// The Isola blob: a squishy gummy figure with big eyes, a Luca sea-monster
// crest, stubby noodle limbs and a toy paintball marker. Fully procedural
// animation driven by a plain state object each frame.
//
// Conventions: pos = feet on the ground (world). yaw = facing, 0 = +Z,
// increasing counter-clockwise seen from above (facing = (sin yaw, 0, cos yaw)).
// aimPitch radians, + = aiming up.
import * as THREE from "three";
import { B, buildBlobGeometry, buildRig, SHOULDER_L, HIP_L, ARM_REST_LEN, LEG_REST_LEN } from "./blobRig";
import { makeBlobMaterial, makeBlobUniforms, type BlobUniforms } from "./blobMaterial";
import { MARKER_MUZZLE, MuzzlePuff } from "./marker";
import { clamp, damp, lerp, smoothstep, Spring, rng } from "./builder";
import type { PaintFx, Vec3Like } from "./paintFx";
import { makeToonMaterial } from "../style";

export type BlobMode =
  | "idle" | "run" | "sprint" | "jump" | "fall" | "slide" | "dive" | "swim" | "underwater"
  | "mantle" | "ride-vespa" | "row" | "passenger" | "zipline" | "eliminated" | "spawn"
  /** Sky drop: spread out flat like a flying squirrel, skin flaps between arms and legs. */
  | "glide"
  /** Sky drop landing: pancaked flat on the ground, googly-eyed, then pops back up. */
  | "splat";

export const BLOB_MODES: BlobMode[] = [
  "idle", "run", "sprint", "jump", "fall", "slide", "dive", "swim", "underwater",
  "mantle", "ride-vespa", "row", "passenger", "zipline", "eliminated", "spawn", "glide", "splat",
];

export interface BlobState {
  pos: Vec3Like;
  yaw: number;
  aimPitch: number;
  vel: Vec3Like;
  grounded: boolean;
  mode: BlobMode;
  /** True on frames a shot goes out (held true = auto-repeat kick every ~0.11 s). Prefer blob.fire() per shot. */
  firing: boolean;
  /** Up to 3 shooter colors (hex), oldest first. The last one is the eliminator. */
  coats: readonly number[];
  wetness: number;
  breath: number;
  // ---- optional extras --------------------------------------------------------
  /** World aim yaw if different from body yaw (passengers twist their upper body toward it). */
  aimYaw?: number;
  /** Seat anchor (vehicle): the blob copies its full world transform instead of pos/yaw. */
  seat?: THREE.Object3D | null;
  /** World-space hand targets (oar handles, handlebars, zipline handle, ledge). */
  grips?: { l?: Vec3Like | null; r?: Vec3Like | null } | null;
  /** Water surface height; in 'swim' the blob floats with its eyes just above it. */
  waterY?: number;
  /** 'row' standing up (gondolier). */
  standing?: boolean;
  /** Spawn-shield strength 0..1 (the shimmer bubble); defaults to 1 during 'spawn'. */
  shield?: number;
}

/** In 'swim', if waterY is not given, the water surface is assumed at pos.y + this. */
export const SWIM_WATERLINE = 1.0;
/** Zipline: feet hang this far below the handle. */
export const ZIP_HANG = 1.95;

export type BlobFx = Pick<PaintFx, "burst" | "bubbles" | "dust" | "sparkle" | "splashWater">;

export interface BlobOptions {
  color: THREE.ColorRepresentation;
  crestColor?: THREE.ColorRepresentation;
  /** Optional shared FX system for elimination bursts, spawn bubbles, slide dust… */
  fx?: BlobFx | null;
  seed?: number;
}

export interface BlobActor {
  readonly object: THREE.Group;
  readonly mesh: THREE.SkinnedMesh;
  readonly color: THREE.Color;
  update(dt: number, state: BlobState): void;
  /** Kick for one shot (recoil, squint, muzzle puff). */
  fire(): void;
  /** Explicit hit reaction (coats increasing triggers this automatically). */
  hit(fromDir?: Vec3Like): void;
  /** Muzzle world position (+ direction) after the last update. */
  getMuzzle(outPos: THREE.Vector3, outDir?: THREE.Vector3): THREE.Vector3;
  /** Where a name tag should float (world), after the last update. */
  getTagAnchor(out: THREE.Vector3): THREE.Vector3;
  setColors(color: THREE.ColorRepresentation, crestColor?: THREE.ColorRepresentation): void;
  dispose(): void;
}

/** Pastel player palette (20). */
export const BLOB_COLORS = [
  0xff9eb5, 0x8fe0c0, 0xb9a4f5, 0xffc48a, 0x8cc8ff, 0xfff08a, 0xff8f80, 0xd6a2e8, 0x7fd8d8, 0xffb38f,
  0x9fb2ff, 0xf7a1c4, 0xc2ec8a, 0x86e3f0, 0xffe0a3, 0xf59e9e, 0xe7b1ff, 0x6fcfb5, 0xffab66, 0xa9d4ff,
];

/** A crest color that pops against the body: hue-shifted, richer, darker. */
export function crestFor(color: THREE.ColorRepresentation): THREE.Color {
  const hsl = { h: 0, s: 0, l: 0 };
  new THREE.Color(color).getHSL(hsl);
  return new THREE.Color().setHSL((hsl.h + 0.93) % 1, Math.min(1, hsl.s * 0.9 + 0.25), clamp(hsl.l - 0.14, 0.35, 0.7));
}

// ---------------------------------------------------------------------------
// Pose channels (all blended together on mode changes).
const enum P {
  rootY, rootZ, rootPitch, rootRoll, hipsPitch, hipsYaw, chestPitch, chestYaw, chestRoll,
  headPitch, headYaw, headRoll, gunAim, gunLower,
  hLx, hLy, hLz, hRx, hRy, hRz, grip,
  fLx, fLy, fLz, fRx, fRy, fRz, fLp, fRp,
  squash, crest, eyeOpen, mouthO, smile, slant, gunScale, aimFollow,
  /** Roll about the body's own long axis (banking while gliding belly-down). */
  rootBank, COUNT,
}

const Y = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();

function wrapAngle(a: number): number {
  return a - Math.PI * 2 * Math.floor((a + Math.PI) / (Math.PI * 2));
}

// Gun slung on the back (chest-local): barrel up over the left shoulder, hopper out.
const BACK_POS = new THREE.Vector3();
const BACK_QUAT = new THREE.Quaternion();
{
  const z = new THREE.Vector3(0.55, 0.8, -0.1).normalize();
  const y = new THREE.Vector3(0, 0, -1);
  y.addScaledVector(z, -y.dot(z)).normalize();
  const x = new THREE.Vector3().crossVectors(y, z);
  BACK_QUAT.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
  BACK_POS.set(0.0, 0.12, -0.36).addScaledVector(z, -0.14);
}
// right hand on the rear grip, left under the foregrip (gun-local)
const GRIP_R = new THREE.Vector3(-0.035, -0.085, -0.01);
const GRIP_L = new THREE.Vector3(0.03, -0.075, 0.2);

let blobSeed = 1;

class Blob implements BlobActor {
  readonly object = new THREE.Group();
  readonly mesh: THREE.SkinnedMesh;
  readonly color = new THREE.Color();
  private bones: THREE.Bone[];
  private u: BlobUniforms;
  private material: THREE.MeshToonMaterial;
  private splatPoints: THREE.Vector3[];
  private fx: BlobFx | null;
  private rand: () => number;
  private puff = new MuzzlePuff();
  private shield: THREE.Mesh;
  private shieldMat: THREE.ShaderMaterial;

  // pose blending
  private out = new Float32Array(P.COUNT);
  private from = new Float32Array(P.COUNT);
  private tgt = new Float32Array(P.COUNT);
  private fade = 1;
  private mode: BlobMode | "" = "";
  private modeT = 0;

  // timers & state
  private t = Math.random() * 100;
  private phase = 0;
  private speed = 0;
  private lvx = 0;
  private lvz = 0;
  private prevVel = new THREE.Vector3();
  private prevGrounded = true;
  private prevYaw = 0;
  private yawRate = 0;
  private sinceFire = 99;
  private autoFire = 0;
  private recoil = 0;
  private blinkT = 2;
  private blink = 0;
  private wince = 0;
  private flash = 0;
  private wobble = 0;
  private surprise = 0;
  private gasp = 0;
  private lookX = 0;
  private lookY = 0;
  private saccT = 1;
  private saccX = 0;
  private saccY = 0;
  private sea = 0;
  private wet = 0;
  private dustT = 0;
  private bubbleT = 0;
  private coatN = 0;
  private coatAmt = [new Spring(260, 14), new Spring(260, 14), new Spring(260, 14)];
  private coatCol = [-1, -1, -1];
  private elimT = 0;
  private burst = false;
  private popColor = new THREE.Color();
  private shieldA = 0;
  private flail = 0;
  /** Glide: how far the limbs (and skin flaps) are spread, 0..1 (set by the pose). */
  private spread = 0;
  private flapOpen = 0;
  private flaps: Flaps;
  /** Googly-eye wobble after a splat landing. */
  private googly = 0;

  // springs
  private squash = new Spring(320, 11, 1);
  private jp = new Spring(90, 7);
  private jr = new Spring(90, 7);
  private hl = new Spring(150, 9);
  private crestFlop = new Spring(120, 6);
  private swing = new Spring(18, 1.6);
  private pop = new Spring(190, 9, 1);
  private pudY = new Spring(160, 10, 1);
  private pudXZ = new Spring(120, 8, 1);

  private muzzleW = new THREE.Vector3();
  private muzzleDir = new THREE.Vector3(0, 0, 1);
  private tagW = new THREE.Vector3();

  constructor(opts: BlobOptions) {
    this.fx = opts.fx ?? null;
    this.rand = rng(opts.seed ?? blobSeed++ * 7919);
    this.color.set(opts.color);
    this.u = makeBlobUniforms();
    this.u.uSeed.value = this.rand() * 10;
    this.material = makeBlobMaterial(this.u);
    const { geo, splatPoints } = buildBlobGeometry(this.color);
    this.splatPoints = splatPoints;
    const rig = buildRig(geo, this.material);
    this.mesh = rig.mesh;
    this.bones = rig.bones;
    this.object.add(this.mesh);
    this.object.name = "blob";
    this.setColors(opts.color, opts.crestColor);

    // muzzle puff lives on the gun bone
    this.bones[B.gun].add(this.puff.mesh);

    // spawn shield bubble
    this.shieldMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color() }, uTime: { value: 0 }, uAlpha: { value: 0 } },
      vertexShader: SHIELD_VERT,
      fragmentShader: SHIELD_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.shield = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 2), this.shieldMat);
    this.shield.position.set(0, 0.95, 0.05);
    this.shield.scale.set(0.78, 1.08, 0.8);
    this.shield.visible = false;
    this.shield.renderOrder = 4;
    this.object.add(this.shield);

    this.flaps = new Flaps(this.color);
    this.object.add(this.flaps.mesh);

    neutral(this.out);
    this.from.set(this.out);
  }

  setColors(color: THREE.ColorRepresentation, crestColor?: THREE.ColorRepresentation): void {
    const changed = !this.color.equals(new THREE.Color(color));
    this.color.set(color);
    this.u.uBody.value.copy(this.color);
    this.u.uBelly.value.copy(this.color).lerp(new THREE.Color(0xfff6e6), 0.45);
    this.flaps?.setColor(this.color);
    this.u.uCrest.value.copy(crestColor !== undefined ? new THREE.Color(crestColor) : crestFor(color));
    if (changed && this.mesh) {
      const old = this.mesh.geometry;
      this.mesh.geometry = buildBlobGeometry(this.color).geo;
      old.dispose();
    }
  }

  fire(): void {
    this.recoil = 1;
    this.sinceFire = 0;
    this.squash.v -= 0.6;
    this.puff.fire(this.color);
  }

  hit(fromDir?: Vec3Like): void {
    this.wince = 1;
    this.flash = 1;
    this.wobble = 1;
    this.surprise = 1;
    this.squash.v -= 3.5;
    if (fromDir) {
      // push away from the shooter
      _v.set(fromDir.x, 0, fromDir.z).applyQuaternion(_q.copy(this.object.quaternion).invert());
      this.jp.v += clamp(_v.z, -1, 1) * 5;
      this.jr.v -= clamp(_v.x, -1, 1) * 5;
    } else {
      this.jp.v -= 4;
    }
    this.hl.v -= 5;
  }

  getMuzzle(outPos: THREE.Vector3, outDir?: THREE.Vector3): THREE.Vector3 {
    if (outDir) outDir.copy(this.muzzleDir);
    return outPos.copy(this.muzzleW);
  }

  getTagAnchor(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.tagW);
  }

  // -------------------------------------------------------------------------
  update(dtIn: number, s: BlobState): void {
    const dt = clamp(dtIn, 0, 0.05);
    this.t += dt;
    this.modeT += dt;
    const bones = this.bones;

    // ---- mode changes ------------------------------------------------------
    if (s.mode !== this.mode) this.enterMode(s.mode, s);

    // ---- world transform --------------------------------------------------
    let bodyYaw = s.yaw;
    if (s.seat) {
      s.seat.updateWorldMatrix(true, false);
      s.seat.matrixWorld.decompose(this.object.position, this.object.quaternion, _s);
      _e.setFromQuaternion(this.object.quaternion, "YXZ");
      bodyYaw = _e.y;
    } else {
      this.object.position.set(s.pos.x, s.pos.y, s.pos.z);
      this.object.quaternion.setFromAxisAngle(Y, s.yaw);
    }
    this.object.updateMatrixWorld(false);

    // ---- velocities -------------------------------------------------------
    const cy = Math.cos(bodyYaw), sy = Math.sin(bodyYaw);
    const lvx = s.vel.x * cy - s.vel.z * sy; // local +X (left)
    const lvz = s.vel.x * sy + s.vel.z * cy; // local +Z (forward)
    const k = damp(10, dt);
    this.lvx = lerp(this.lvx, lvx, k);
    this.lvz = lerp(this.lvz, lvz, k);
    this.speed = Math.hypot(this.lvx, this.lvz);
    if (dt > 0) {
      const ax = clamp((s.vel.x - this.prevVel.x) / dt, -40, 40);
      const ay = clamp((s.vel.y - this.prevVel.y) / dt, -60, 60);
      const az = clamp((s.vel.z - this.prevVel.z) / dt, -40, 40);
      const alx = ax * cy - az * sy, alz = ax * sy + az * cy;
      if (!s.seat) {
        this.jp.v += -alz * 0.2 * dt;
        this.jr.v += alx * 0.2 * dt;
      }
      this.crestFlop.v += -ay * 0.08 * dt - alz * 0.1 * dt;
      this.swing.v += -alz * 0.35 * dt;
      const yr = wrapAngle(s.yaw - this.prevYaw) / dt;
      this.yawRate = lerp(this.yawRate, clamp(yr, -8, 8), damp(8, dt));
    }
    // landing splat
    if (s.grounded && !this.prevGrounded) {
      const impact = Math.max(0, -this.prevVel.y);
      if (impact > 1.5) {
        this.squash.v -= Math.min(9, 1.5 + impact * 0.65);
        this.wobble = Math.max(this.wobble, Math.min(1, impact * 0.08));
        if (this.fx && impact > 5) this.fx.dust(this.object.position, 4);
      }
    }
    this.prevVel.set(s.vel.x, s.vel.y, s.vel.z);
    this.prevGrounded = s.grounded;
    this.prevYaw = s.yaw;

    // ---- firing ------------------------------------------------------------
    this.sinceFire += dt;
    if (s.firing) {
      this.autoFire -= dt;
      if (this.autoFire <= 0) {
        this.fire();
        this.autoFire = 0.11;
      }
    } else this.autoFire = 0;
    this.recoil = Math.max(0, this.recoil - dt * 9);

    // ---- gait phase ------------------------------------------------------------
    const sprint = s.mode === "sprint";
    const stride = sprint ? clamp(0.14 + this.speed * 0.035, 0.14, 0.42) : clamp(0.1 + this.speed * 0.035, 0.1, 0.32);
    const cadence = clamp(this.speed / (4 * stride), sprint ? 1.6 : 1.3, sprint ? 3.6 : 3.0);
    this.phase += dt * Math.PI * 2 * (this.speed > 0.15 ? cadence : 1.2);

    // ---- pose target + crossfade ------------------------------------------
    this.computePose(s, this.tgt, stride);
    this.fade = Math.min(1, this.fade + dt / 0.17);
    const w = this.fade * this.fade * (3 - 2 * this.fade);
    const o = this.out;
    for (let i = 0; i < P.COUNT; i++) o[i] = this.from[i] + (this.tgt[i] - this.from[i]) * w;

    // ---- springs + expression timers -----------------------------------------
    this.squash.target = 1;
    if (s.mode === "jump" && s.vel.y > 0) this.squash.target = 1 + clamp(s.vel.y * 0.018, 0, 0.14);
    if (s.mode === "fall") this.squash.target = 1.06;
    this.squash.step(dt);
    this.googly = Math.max(0, this.googly - dt * 0.7);
    this.jp.step(dt);
    this.jr.step(dt);
    this.hl.step(dt);
    this.crestFlop.step(dt);
    this.swing.step(dt);
    this.pop.step(dt);
    this.pudY.step(dt);
    this.pudXZ.step(dt);
    this.jp.x = clamp(this.jp.x, -0.5, 0.5);
    this.jr.x = clamp(this.jr.x, -0.5, 0.5);
    this.wince = Math.max(0, this.wince - dt * 4.5);
    this.flash = Math.max(0, this.flash - dt * 7);
    this.wobble = Math.max(0, this.wobble - dt * 1.6);
    this.surprise = Math.max(0, this.surprise - dt * 2.5);
    this.gasp = Math.max(0, this.gasp - dt * 0.9);

    // blink: random, sometimes a double blink
    this.blinkT -= dt;
    if (this.blinkT <= 0) {
      this.blink = 1;
      this.blinkT = this.rand() < 0.2 ? 0.22 : 1.6 + this.rand() * 3.5;
    }
    this.blink = Math.max(0, this.blink - dt * 8);
    // eye saccades
    this.saccT -= dt;
    if (this.saccT <= 0) {
      this.saccT = 0.4 + this.rand() * 1.6;
      const idle = s.mode === "idle" || s.mode === "passenger";
      this.saccX = (this.rand() - 0.5) * (idle ? 0.7 : 0.25);
      this.saccY = (this.rand() - 0.5) * (idle ? 0.3 : 0.12);
    }

    this.applyBones(s, bodyYaw, dt);
    this.applyMaterial(s, dt);
    // skin flaps between arms and legs
    this.flapOpen = lerp(this.flapOpen, s.mode === "glide" ? this.spread : 0, damp(s.mode === "glide" ? 12 : 20, dt));
    this.flaps.update(this.flapOpen, this.bones, this.object, this.t);

    // FX bits
    if (this.fx) {
      if (s.mode === "slide" && this.speed > 2) {
        this.dustT -= dt;
        if (this.dustT <= 0) { this.dustT = 0.06; this.fx.dust(_v.set(0, 0.05, 0.4).applyMatrix4(this.object.matrixWorld), 1); }
      }
      if (s.mode === "underwater") {
        this.bubbleT -= dt;
        if (this.bubbleT <= 0) {
          this.bubbleT = s.breath < 0.3 ? 0.15 : 0.7 + this.rand() * 0.8;
          bones[B.head].getWorldPosition(_v);
          this.fx.bubbles(_v.add(_v2.set(0, 0.1, 0)), s.breath < 0.3 ? 2 : 1);
        }
      }
    }
  }

  private enterMode(m: BlobMode, s: BlobState): void {
    const prev = this.mode;
    this.from.set(this.out);
    this.fade = prev === "" ? 1 : 0;
    this.mode = m;
    this.modeT = 0;
    const grounded = prev === "idle" || prev === "run" || prev === "sprint" || prev === "slide";
    if (m === "jump" && grounded) {
      this.squash.v -= 3.2; // anticipation squash, the spring then flings it into a stretch
      this.squash.x = Math.min(this.squash.x, 0.9);
    }
    if (m === "dive") { this.squash.v += 3; this.surprise = 1; }
    if (m === "fall") this.flail = 0;
    if (m === "glide") { this.surprise = 1; this.spread = 0; }
    if (m === "splat") {
      // SPLORT: pancake flat, limbs splayed, eyes rattling
      this.squash.v -= 7;
      this.pudXZ.v += 5; this.pudXZ.target = 1.18;
      this.wobble = 1;
      this.googly = 1;
      this.surprise = 1;
      this.fade = 0.55;
    }
    if (prev === "splat") {
      // ...and boing back up
      this.squash.v += 12;
      this.pudXZ.target = 1;
      this.wobble = Math.max(this.wobble, 0.8);
    }
    if (m === "swim" && prev === "underwater" && s.breath < 0.25) { this.gasp = 1; this.squash.v += 4; }
    if ((m === "swim" || m === "underwater") && (prev === "dive" || prev === "fall" || prev === "jump")) {
      this.wobble = 1;
      if (this.fx) this.fx.splashWater({ x: s.pos.x, y: s.waterY ?? s.pos.y + SWIM_WATERLINE, z: s.pos.z }, 1.3);
    }
    if (m === "eliminated") {
      this.elimT = 0;
      this.burst = false;
      this.surprise = 1;
      const last = s.coats.length ? s.coats[s.coats.length - 1] : 0xffffff;
      this.popColor.set(last);
      this.pudY.x = 1; this.pudY.v = 0; this.pudY.target = 1.25;
      this.pudXZ.x = 1; this.pudXZ.v = 0; this.pudXZ.target = 0.9;
    }
    if (prev === "eliminated") {
      this.pudY.x = this.pudY.target = 1; this.pudY.v = 0;
      this.pudXZ.x = this.pudXZ.target = 1; this.pudXZ.v = 0;
      this.u.uPop.value = 0;
      this.mesh.visible = true;
    }
    if (m === "spawn") {
      this.pop.x = 0.02; this.pop.v = 0; this.pop.target = 1;
      this.u.uPop.value = 0;
      this.mesh.visible = true;
      this.from.set(this.tgt);
      this.fade = 1;
      if (this.fx) {
        this.fx.bubbles({ x: s.pos.x, y: s.pos.y + 0.6, z: s.pos.z }, 10);
        this.fx.sparkle({ x: s.pos.x, y: s.pos.y + 1.0, z: s.pos.z }, this.color, 10);
      }
    }
  }

  // -------------------------------------------------------------------------
  private computePose(s: BlobState, o: Float32Array, stride: number): void {
    neutral(o);
    const t = this.t, mt = this.modeT, ph = this.phase;
    const sp = this.speed;
    const inv = sp > 0.05 ? 1 / sp : 0;
    const dx = this.lvx * inv, dz = this.lvz * inv;
    const moving = smoothstep(0.15, 1.2, sp);
    const relaxed = this.sinceFire > 1.6 ? 1 : 0;

    switch (s.mode) {
      case "idle":
      case "spawn": {
        const br = Math.sin(t * 2.3);
        o[P.squash] = 1 + br * 0.018;
        o[P.chestPitch] += br * 0.02;
        o[P.headYaw] += Math.sin(t * 0.37) * 0.22 + Math.sin(t * 0.91) * 0.08;
        o[P.headRoll] += Math.sin(t * 0.7) * 0.05;
        o[P.rootRoll] = Math.sin(t * 0.9) * 0.02;
        o[P.gunLower] = relaxed * 0.45;
        if (s.mode === "spawn" && mt < 0.9) {
          // ta-da!
          const k = 1 - smoothstep(0.55, 0.9, mt);
          o[P.gunAim] = 1 - k;
          setHand(o, P.hLx, 0.48, 1.4 + Math.sin(t * 14) * 0.04, 0.12, k);
          setHand(o, P.hRx, -0.48, 1.4 + Math.cos(t * 14) * 0.04, 0.12, k);
          o[P.mouthO] = 0.55 * k;
          o[P.crest] = 0.5 * k + 0.15;
        }
        // run gait bleeds in when idle-with-velocity
        if (moving > 0.01) this.gait(o, ph, stride, dx, dz, moving * 0.7, false);
        break;
      }
      case "run":
        o[P.gunLower] = relaxed * 0.2;
        this.gait(o, ph, stride, dx, dz, moving, false);
        break;
      case "sprint":
        this.gait(o, ph, stride, dx, dz, Math.max(moving, 0.4), true);
        o[P.gunAim] = 0;
        // Naruto arms trailing back
        setHand(o, P.hLx, 0.33, 0.78 + Math.sin(ph * 2) * 0.03, -0.42);
        setHand(o, P.hRx, -0.33, 0.78 + Math.cos(ph * 2) * 0.03, -0.42);
        o[P.mouthO] = 0.35;
        o[P.slant] = 0.35;
        o[P.crest] = 0.35;
        o[P.eyeOpen] = 0.85;
        break;
      case "jump":
      case "fall": {
        const falling = s.mode === "fall";
        o[P.gunLower] = -0.15;
        setFoot(o, P.fLx, 0.17, 0.26, 0.08);
        setFoot(o, P.fRx, -0.17, 0.2, -0.02);
        o[P.fLp] = -0.4;
        o[P.fRp] = 0.3;
        o[P.hipsPitch] = clamp(this.lvz * 0.02, -0.1, 0.15);
        o[P.mouthO] = 0.25;
        o[P.crest] = 0.4;
        if (falling) {
          setFoot(o, P.fLx, 0.18, 0.04, -0.02);
          setFoot(o, P.fRx, -0.18, 0.06, 0.04);
          if (mt > 0.35 && s.vel.y < -5) this.flail = Math.min(1, this.flail + 0.1);
          const f = this.flail;
          if (f > 0) {
            // cartoon panic: windmill arms, pedalling feet
            o[P.gunAim] = 1 - f;
            setHand(o, P.hLx, 0.5, 1.3 + Math.sin(t * 17) * 0.14, 0.1 + Math.cos(t * 17) * 0.18, f);
            setHand(o, P.hRx, -0.5, 1.3 + Math.sin(t * 17 + 2) * 0.14, 0.1 + Math.cos(t * 17 + 2) * 0.18, f);
            o[P.fLy] += Math.max(0, Math.sin(t * 16)) * 0.2 * f;
            o[P.fRy] += Math.max(0, -Math.sin(t * 16)) * 0.2 * f;
            o[P.mouthO] = lerp(0.25, 1, f);
            o[P.eyeOpen] = 1;
          }
        }
        break;
      }
      case "slide":
        o[P.rootPitch] = -0.6;
        o[P.rootY] = -0.26;
        o[P.rootZ] = -0.05;
        o[P.headPitch] = 0.4;
        o[P.chestPitch] = 0.1;
        setFoot(o, P.fLx, 0.17, 0.2, 0.55);
        setFoot(o, P.fRx, -0.14, 0.28, 0.45);
        o[P.fLp] = -0.5;
        o[P.fRp] = -0.3;
        o[P.squash] = 0.9;
        o[P.mouthO] = 0.15;
        o[P.smile] = 1;
        o[P.slant] = 0.2;
        o[P.crest] = 0.45;
        break;
      case "dive": {
        o[P.rootPitch] = 1.45;
        o[P.rootY] = 0.1;
        o[P.headPitch] = -0.55;
        o[P.gunAim] = 0;
        o[P.aimFollow] = 0;
        setHand(o, P.hLx, 0.2, 1.72, 0.2);
        setHand(o, P.hRx, -0.2, 1.72, 0.2);
        setFoot(o, P.fLx, 0.16, 0.05, -0.12);
        setFoot(o, P.fRx, -0.16, 0.08, -0.1);
        o[P.fLp] = 0.9;
        o[P.fRp] = 0.9;
        o[P.squash] = 1.1;
        o[P.mouthO] = 0.7;
        o[P.crest] = 0.9;
        o[P.eyeOpen] = 1;
        break;
      }
      case "swim": {
        const pace = 0.35 + moving;
        const a = t * (3 + moving * 3.5);
        o[P.rootPitch] = 0.85 + moving * 0.3;
        o[P.headPitch] = -0.75 - moving * 0.25;
        o[P.chestPitch] = -0.1;
        o[P.gunAim] = 0;
        o[P.aimFollow] = 0;
        const wl = s.waterY !== undefined ? s.waterY - s.pos.y - SWIM_WATERLINE : 0;
        o[P.rootY] = wl + Math.sin(t * 2.2) * 0.03 - 0.02;
        // doggy paddle
        setHand(o, P.hLx, 0.3, 1.18 + Math.sin(a) * 0.17 * pace, 0.3 + Math.cos(a) * 0.14 * pace);
        setHand(o, P.hRx, -0.3, 1.18 + Math.sin(a + Math.PI) * 0.17 * pace, 0.3 + Math.cos(a + Math.PI) * 0.14 * pace);
        setFoot(o, P.fLx, 0.15, 0.08, -0.05 + Math.sin(a * 2) * 0.14);
        setFoot(o, P.fRx, -0.15, 0.08, -0.05 - Math.sin(a * 2) * 0.14);
        o[P.fLp] = 0.8;
        o[P.fRp] = 0.8;
        o[P.chestYaw] = Math.sin(a) * 0.1;
        o[P.headRoll] = Math.sin(a) * 0.06;
        o[P.crest] = 0.6;
        o[P.mouthO] = this.gasp;
        break;
      }
      case "underwater": {
        const vp = Math.atan2(s.vel.y, Math.max(0.3, Math.hypot(s.vel.x, s.vel.z)));
        const a = t * (4 + moving * 4);
        o[P.rootPitch] = lerp(1.1, Math.PI / 2 - vp, moving);
        o[P.rootY] = 0.0;
        o[P.headPitch] = -0.45;
        o[P.gunAim] = 0;
        o[P.aimFollow] = 0;
        const stroke = Math.max(0, Math.sin(a * 0.5));
        setHand(o, P.hLx, 0.34 - stroke * 0.12, 0.9 + stroke * 0.55, 0.12);
        setHand(o, P.hRx, -0.34 + stroke * 0.12, 0.9 + stroke * 0.55, 0.12);
        setFoot(o, P.fLx, 0.13, 0.06, Math.sin(a) * 0.12);
        setFoot(o, P.fRx, -0.13, 0.06, -Math.sin(a) * 0.12);
        o[P.fLp] = 1;
        o[P.fRp] = 1;
        o[P.squash] = 1.05;
        o[P.crest] = 1;
        o[P.mouthO] = 0;
        o[P.smile] = 0.3;
        const worry = 1 - smoothstep(0.1, 0.35, s.breath);
        o[P.eyeOpen] = 1;
        o[P.slant] = -0.4 * worry;
        break;
      }
      case "mantle": {
        const p = smoothstep(0, 0.45, mt);
        o[P.rootPitch] = 0.35 * (1 - p * 0.5);
        o[P.gunAim] = 0;
        o[P.aimFollow] = 0;
        setHand(o, P.hLx, 0.24, 1.45 - p * 0.35, 0.42);
        setHand(o, P.hRx, -0.24, 1.45 - p * 0.35, 0.42);
        o[P.grip] = 1;
        setFoot(o, P.fLx, 0.15, 0.3 + p * 0.1, 0.3);
        setFoot(o, P.fRx, -0.15, 0.03, -0.12);
        o[P.fRp] = 0.5;
        o[P.squash] = 1.06 - p * 0.1;
        o[P.mouthO] = 0.3;
        o[P.eyeOpen] = 0.75;
        o[P.slant] = 0.3;
        break;
      }
      case "ride-vespa":
        this.seated(o);
        o[P.hipsPitch] = 0.12;
        o[P.chestPitch] = 0.08;
        setFoot(o, P.fLx, 0.17, 0.05, 0.3);
        setFoot(o, P.fRx, -0.17, 0.05, 0.3);
        setHand(o, P.hLx, 0.28, 0.98, 0.5);
        setHand(o, P.hRx, -0.28, 0.98, 0.5);
        o[P.grip] = 1;
        o[P.gunAim] = 0;
        o[P.aimFollow] = 0.4;
        o[P.mouthO] = 0.3 * moving;
        o[P.crest] = 0.3 + moving * 0.3;
        o[P.headRoll] = Math.sin(t * 1.3) * 0.05;
        break;
      case "row": {
        o[P.gunAim] = 0;
        o[P.aimFollow] = 0.3;
        o[P.grip] = 1;
        if (s.standing) {
          // gondolier: stand tall, both hands on one long oar on the right side
          const a = t * 2.2;
          setFoot(o, P.fLx, 0.12, 0.08, 0.16);
          setFoot(o, P.fRx, -0.17, 0.08, -0.18);
          setHand(o, P.hLx, -0.05, 1.05, 0.25 + Math.cos(a) * 0.25);
          setHand(o, P.hRx, -0.3, 1.0, 0.1 + Math.cos(a) * 0.25);
          o[P.chestYaw] = -0.35;
          o[P.hipsPitch] = 0.1;
        } else {
          this.seated(o);
          const a = t * 3;
          setFoot(o, P.fLx, 0.17, 0.05, 0.42);
          setFoot(o, P.fRx, -0.17, 0.05, 0.42);
          setHand(o, P.hLx, 0.3, 0.95 + Math.sin(a) * 0.1, 0.35 + Math.cos(a) * 0.25);
          setHand(o, P.hRx, -0.3, 0.95 + Math.sin(a) * 0.1, 0.35 + Math.cos(a) * 0.25);
        }
        // follow the oar handles: lean into the catch, lay back on the drive
        if (s.grips && s.grips.l && s.grips.r) {
          _tp.set((s.grips.l.x + s.grips.r.x) / 2, (s.grips.l.y + s.grips.r.y) / 2, (s.grips.l.z + s.grips.r.z) / 2);
          this.object.worldToLocal(_tp);
          const lean = clamp((_tp.z - (s.standing ? 0.35 : 0.35)) * 1.1, -0.45, 0.5);
          o[P.hipsPitch] += lean * 0.55;
          o[P.chestPitch] += lean * 0.45;
          o[P.headPitch] -= lean * 0.6;
          if (s.standing) o[P.chestYaw] = clamp(Math.atan2(-_tp.x, Math.max(0.2, _tp.z)) * 0.6, -0.6, 0.2);
        }
        o[P.slant] = 0.15;
        o[P.mouthO] = 0.1;
        break;
      }
      case "passenger":
        this.seated(o);
        setFoot(o, P.fLx, 0.16, 0.14 + Math.max(0, Math.sin(t * 3.1)) * 0.08, 0.36);
        setFoot(o, P.fRx, -0.16, 0.14 + Math.max(0, Math.sin(t * 3.1 + 2.2)) * 0.08, 0.36);
        o[P.gunLower] = relaxed * 0.3;
        o[P.headYaw] += Math.sin(t * 0.5) * 0.25 * relaxed;
        break;
      case "zipline": {
        o[P.gunAim] = 0;
        o[P.aimFollow] = 0;
        o[P.grip] = 1;
        setHand(o, P.hLx, 0.14, ZIP_HANG, 0.05);
        setHand(o, P.hRx, -0.14, ZIP_HANG, 0.05);
        o[P.rootPitch] = clamp(this.swing.x, -0.6, 0.6);
        setFoot(o, P.fLx, 0.15, 0.1 + Math.max(0, Math.sin(t * 7)) * 0.08, 0.05);
        setFoot(o, P.fRx, -0.15, 0.1 + Math.max(0, -Math.sin(t * 7)) * 0.08, 0.05);
        o[P.fLp] = 0.5;
        o[P.fRp] = 0.5;
        o[P.squash] = 1.08;
        o[P.mouthO] = 0.85;
        o[P.eyeOpen] = 0.85;
        o[P.crest] = 0.8;
        o[P.headPitch] = -0.1;
        break;
      }
      case "glide": {
        // flying squirrel: belly down, arms and legs stretched wide, flaps taut
        const hs = Math.hypot(s.vel.x, s.vel.z), sink = Math.max(0, -s.vel.y);
        const ang = Math.atan2(sink, Math.max(1, hs)); // ~0.25 flare, ~0.4 glide, ~0.6 dive, ~1.4 tuck
        const tuck = smoothstep(0.8, 1.15, ang);
        const flare = 1 - smoothstep(0.26, 0.42, ang);
        const open = smoothstep(0.05, 0.6, mt);
        const sp = open * (1 - tuck);
        this.spread = sp;
        const fl = Math.sin(t * 19) * 0.03 + Math.sin(t * 31 + 1) * 0.015;
        o[P.rootPitch] = 1.02 + ang * 0.55 - flare * 0.12 + tuck * 0.15 + (1 - open) * 0.3;
        o[P.rootY] = 0.15;
        o[P.rootBank] = clamp(this.yawRate * 0.2 + this.lvx * 0.035, -0.7, 0.7);
        o[P.headPitch] = -0.95 + tuck * 0.35;
        o[P.chestPitch] = -0.12;
        o[P.gunAim] = 0;
        o[P.aimFollow] = 0;
        setHand(o, P.hLx, lerp(0.3, 0.8, sp), lerp(1.42, 1.05 + fl, sp), lerp(0.2, 0.12 + flare * 0.14, sp));
        setHand(o, P.hRx, lerp(-0.3, -0.8, sp), lerp(1.42, 1.05 - fl, sp), lerp(0.2, 0.12 + flare * 0.14, sp));
        setFoot(o, P.fLx, lerp(0.1, 0.44, sp), lerp(0.02, 0.12 - fl, sp), lerp(-0.08, -0.1, sp));
        setFoot(o, P.fRx, lerp(-0.1, -0.44, sp), lerp(0.02, 0.12 + fl, sp), lerp(-0.08, -0.1, sp));
        o[P.fLp] = 1.2;
        o[P.fRp] = 1.2;
        o[P.squash] = 1 - sp * 0.08;
        o[P.mouthO] = 0.35 + tuck * 0.55 + (1 - open) * 0.5;
        o[P.smile] = 1;
        o[P.eyeOpen] = 1;
        o[P.crest] = 1;
        o[P.slant] = tuck * 0.45 - flare * 0.1;
        break;
      }
      case "splat": {
        // pancake: squashed flat, limbs splayed like a dropped gummy
        o[P.squash] = 0.36;
        o[P.gunAim] = 0;
        o[P.aimFollow] = 0;
        o[P.headPitch] = -0.15;
        setHand(o, P.hLx, 0.4, 0.34, 0.2);
        setHand(o, P.hRx, -0.4, 0.34, 0.2);
        setFoot(o, P.fLx, 0.22, 0.02, -0.1);
        setFoot(o, P.fRx, -0.22, 0.02, -0.1);
        o[P.fLp] = -0.4;
        o[P.fRp] = -0.4;
        o[P.mouthO] = 0.55;
        o[P.smile] = 0.6;
        o[P.eyeOpen] = 1;
        o[P.crest] = 1.1;
        break;
      }
      case "eliminated":
        o[P.gunAim] = 0;
        o[P.gunScale] = 0;
        o[P.aimFollow] = 0;
        // limbs melt back into the puddle
        setHand(o, P.hLx, 0.3, 0.7, 0.12);
        setHand(o, P.hRx, -0.3, 0.7, 0.12);
        setFoot(o, P.fLx, 0.14, 0.06, 0.05);
        setFoot(o, P.fRx, -0.14, 0.06, 0.05);
        o[P.mouthO] = this.elimT < 0.2 ? 1 : 0.4;
        o[P.eyeOpen] = 1;
        o[P.crest] = 1;
        break;
    }
  }

  private seated(o: Float32Array): void {
    o[P.rootY] = -0.32;
    o[P.hipsPitch] = -0.05;
  }

  /** Bouncy run / sprint gait. w scales the amplitude (0 = standing). */
  private gait(o: Float32Array, ph: number, stride: number, dx: number, dz: number, w: number, sprint: boolean): void {
    const lift = (sprint ? 0.2 : 0.14) * w;
    const sL = Math.sin(ph), cL = Math.cos(ph);
    const st = stride * w;
    o[P.fLx] += dx * sL * st;
    o[P.fLz] += dz * sL * st;
    o[P.fLy] += Math.max(0, cL) * lift;
    o[P.fRx] -= dx * sL * st;
    o[P.fRz] -= dz * sL * st;
    o[P.fRy] += Math.max(0, -cL) * lift;
    o[P.fLp] = -cL * 0.5 * w * dz;
    o[P.fRp] = cL * 0.5 * w * dz;
    const bounce = Math.abs(cL);
    o[P.rootY] += (bounce * (sprint ? 0.1 : 0.075) - 0.02) * w;
    o[P.squash] *= 1 + (bounce * 2 - 1) * 0.05 * w;
    const fwd = clamp(dz, -1, 1);
    o[P.hipsPitch] += (sprint ? 0.28 : 0.12) * fwd * w;
    o[P.chestPitch] += (sprint ? 0.22 : 0.02) * fwd * w;
    o[P.headPitch] -= (sprint ? 0.3 : 0.08) * fwd * w;
    o[P.rootRoll] += -dx * 0.14 * w;
    o[P.hipsYaw] += -Math.sin(ph) * 0.14 * w;
    o[P.chestYaw] += Math.sin(ph) * 0.1 * w;
    o[P.chestRoll] += Math.cos(ph) * 0.05 * w;
    o[P.headRoll] += Math.sin(ph) * 0.05 * w;
    o[P.crest] += 0.2 * w;
  }

  // -------------------------------------------------------------------------
  private applyBones(s: BlobState, bodyYaw: number, dt: number): void {
    const o = this.out;
    const bn = this.bones;
    const t = this.t;
    const aim = clamp(s.aimPitch, -1.2, 1.2) * o[P.aimFollow];
    const twist = s.aimYaw !== undefined ? clamp(wrapAngle(s.aimYaw - bodyYaw), -1.9, 1.9) : 0;

    // ---- root: pivot around the body center, squash & stretch ----------------
    const root = bn[B.root];
    let sy = clamp(this.squash.x * o[P.squash], this.mode === "splat" ? 0.26 : 0.55, 1.5);
    let sxz = 1 / Math.sqrt(sy);
    if (this.mode === "eliminated") this.stepElimination(dt);
    const popS = this.mode === "spawn" ? Math.max(0.001, this.pop.x) : 1;
    sy *= this.pudY.x * popS;
    sxz *= this.pudXZ.x * popS;
    _e.set(o[P.rootPitch], o[P.rootBank], o[P.rootRoll]);
    root.quaternion.setFromEuler(_e);
    const pivot = 0.9;
    _v.set(0, pivot, 0).applyQuaternion(root.quaternion);
    root.position.set(0, o[P.rootY] + pivot - _v.y, o[P.rootZ] - _v.z);
    root.position.x -= _v.x;
    root.scale.set(sxz, sy, sxz);

    bn[B.hips].rotation.set(o[P.hipsPitch] + this.jp.x * 0.3, o[P.hipsYaw] + twist * 0.2, this.jr.x * 0.3);
    bn[B.chest].rotation.set(o[P.chestPitch] - aim * 0.22 + this.jp.x * 0.7, o[P.chestYaw] + twist * 0.45, o[P.chestRoll] + this.jr.x * 0.7);
    bn[B.head].rotation.set(o[P.headPitch] - aim * 0.3 + this.hl.x * 0.4 - this.jp.x * 0.3, o[P.headYaw] + twist * 0.35 + clamp(this.yawRate * 0.04, -0.3, 0.3), o[P.headRoll] - this.jr.x * 0.4);
    this.object.updateMatrixWorld(true);

    // ---- gun: blend between aiming (world-locked direction) and slung on back
    const chest = bn[B.chest];
    const gun = bn[B.gun];
    const gunAim = clamp(o[P.gunAim], 0, 1);
    const pitch = -aim + o[P.gunLower] - this.recoil * 0.25;
    // aim placement in chest space
    const pv = _v.set(-0.3, 0.1, 0.06);
    const off = _v2.set(0.0, -0.15, 0.3).applyAxisAngle(_X, pitch * 0.8).add(pv);
    // desired world orientation → chest-local
    _q.setFromEuler(_e.set(pitch, (s.aimYaw !== undefined ? s.aimYaw : bodyYaw), 0, "YXZ"));
    chest.matrixWorld.decompose(_tp, _q2, _s);
    _q2.invert().multiply(_q);
    // remove the (small) seat tilt: fine for a toy
    gun.position.copy(off).lerp(BACK_POS, 1 - gunAim);
    gun.quaternion.copy(BACK_QUAT).slerp(_q2, gunAim);
    // recoil kick back along the barrel
    _tp.set(0, 0, -this.recoil * 0.07).applyQuaternion(gun.quaternion);
    gun.position.add(_tp);
    gun.scale.setScalar(Math.max(0.001, o[P.gunScale]));
    gun.updateMatrixWorld(true);

    // ---- hands ---------------------------------------------------------------
    const gripW = o[P.grip];
    for (let side = 0; side < 2; side++) {
      const hand = bn[side === 0 ? B.handL : B.handR];
      const hi = side === 0 ? P.hLx : P.hRx;
      // pose target (root/body space) → world
      _tp.set(o[hi], o[hi + 1], o[hi + 2]).applyMatrix4(root.matrixWorld);
      if (gunAim > 0.001) {
        _tq.copy(side === 0 ? GRIP_L : GRIP_R).applyMatrix4(gun.matrixWorld);
        _tp.lerp(_tq, gunAim);
      }
      const g = s.grips ? (side === 0 ? s.grips.l : s.grips.r) : null;
      if (g && gripW > 0) _tp.lerp(_tq.set(g.x, g.y, g.z), gripW);
      chest.worldToLocal(_tp);
      hand.position.copy(_tp);
      hand.rotation.set(0, 0, 0);
      // noodle arm: aim the shoulder bone at the hand and stretch
      const arm = bn[side === 0 ? B.armL : B.armR];
      _tq.set(SHOULDER_L[0] * (side === 0 ? 1 : -1), SHOULDER_L[1] - 0.9, SHOULDER_L[2]);
      arm.position.copy(_tq);
      _tp.sub(_tq);
      const len = Math.max(0.05, _tp.length());
      arm.quaternion.setFromUnitVectors(Y, _tp.divideScalar(len));
      const st = len / ARM_REST_LEN;
      const thin = clamp(1 / Math.sqrt(st), 0.7, 1.15);
      arm.scale.set(thin, st, thin);
    }

    // ---- feet + legs -----------------------------------------------------------
    for (let side = 0; side < 2; side++) {
      const foot = bn[side === 0 ? B.footL : B.footR];
      const fi = side === 0 ? P.fLx : P.fRx;
      foot.position.set(o[fi], o[fi + 1], o[fi + 2]);
      foot.rotation.set(o[side === 0 ? P.fLp : P.fRp], 0, 0);
      foot.updateMatrixWorld(false);
      const leg = bn[side === 0 ? B.legL : B.legR];
      const hips = bn[B.hips];
      _tp.setFromMatrixPosition(foot.matrixWorld);
      hips.worldToLocal(_tp);
      _tq.set(HIP_L[0] * (side === 0 ? 1 : -1), HIP_L[1] - 0.55, HIP_L[2]);
      leg.position.copy(_tq);
      _tp.sub(_tq);
      const len = Math.max(0.05, _tp.length());
      leg.quaternion.setFromUnitVectors(Y, _tp.divideScalar(len));
      const st = len / LEG_REST_LEN;
      const thin = clamp(1 / Math.sqrt(st), 0.75, 1.1);
      leg.scale.set(thin, st, thin);
    }

    // ---- face ------------------------------------------------------------------
    const elim = this.mode === "eliminated";
    const flat = elim || this.mode === "splat";
    const closed = clamp(Math.max(1 - o[P.eyeOpen], this.blink > 0 ? Math.sin(this.blink * Math.PI) : 0, this.wince, (this.sinceFire < 0.35 ? 0.3 : 0)), 0, 1);
    const eyeScale = 1 + this.surprise * 0.18 + this.gasp * 0.1;
    const lookP = clamp(s.aimPitch * 0.45, -0.35, 0.35) + this.saccY;
    const lookYw = clamp(this.yawRate * 0.12, -0.45, 0.45) + this.saccX;
    this.lookX = lerp(this.lookX, lookYw, damp(18, dt));
    this.lookY = lerp(this.lookY, lookP, damp(18, dt));
    for (let side = 0; side < 2; side++) {
      const sgn = side === 0 ? 1 : -1;
      const eye = bn[side === 0 ? B.eyeL : B.eyeR];
      eye.scale.setScalar(eyeScale);
      if (flat) {
        // keep the eyes round and poking out of the puddle
        eye.scale.set(eyeScale / Math.max(0.2, root.scale.x), eyeScale / Math.max(0.12, root.scale.y), eyeScale / Math.max(0.2, root.scale.z));
      }
      const pupil = bn[side === 0 ? B.pupilL : B.pupilR];
      if (elim && this.elimT > 0.3) {
        // dazed spinning pupils
        const a = t * 9 + side * Math.PI;
        pupil.rotation.set(Math.sin(a) * 0.35, Math.cos(a) * 0.35, 0);
      } else if (this.googly > 0) {
        // googly eyes rattling after a splat landing
        const g = this.googly * this.googly;
        pupil.rotation.set(-this.lookY + Math.sin(t * 17 + side * 2.1) * 0.45 * g, this.lookX + Math.cos(t * 13 + side) * 0.45 * g, 0);
      } else pupil.rotation.set(-this.lookY, this.lookX - sgn * 0.06, 0);
      const lid = bn[side === 0 ? B.lidL : B.lidR];
      lid.rotation.set(lerp(-0.9, 1.5, closed), 0, sgn * o[P.slant] * 0.5);
    }
    const mo = clamp(Math.max(o[P.mouthO], this.wince * 0.8, this.gasp, this.surprise * 0.6), 0, 1);
    bn[B.mouthO].scale.set(mo > 0.02 ? 0.55 + 0.45 * mo : 0.001, mo > 0.02 ? mo * 1.1 : 0.001, mo > 0.02 ? 1 : 0.001);
    const sm = clamp(o[P.smile] * (1 - mo * 1.5), 0, 1);
    bn[B.smile].scale.setScalar(Math.max(0.001, sm));

    // ---- fins ------------------------------------------------------------------
    const flare = clamp(Math.max(o[P.crest], this.sea), 0, 1.2);
    bn[B.crest].scale.set(1, 0.7 + flare * 0.7, 1 + flare * 0.15);
    bn[B.crest].rotation.x = clamp(this.crestFlop.x, -0.5, 0.5) + Math.sin(t * 9) * 0.03 * flare;
    for (let side = 0; side < 2; side++) {
      const sgn = side === 0 ? 1 : -1;
      const fin = bn[side === 0 ? B.finL : B.finR];
      fin.scale.setScalar(0.75 + flare * 0.55);
      fin.rotation.set(-flare * 0.15, sgn * (flare * 0.25 + Math.sin(t * 6 + side) * 0.06 * flare), -sgn * flare * 0.3);
    }
    bn[B.dorsal].scale.set(1, 0.55 + flare * 0.7, 0.55 + flare * 0.7);
    const tail = bn[B.tail];
    const ts = Math.max(0.001, this.sea);
    tail.scale.setScalar(ts);
    tail.rotation.set(0, Math.sin(t * (s.mode === "underwater" ? 9 : 3)) * 0.4 * this.sea, 0);

    // ---- muzzle + tag ---------------------------------------------------------------
    this.object.updateMatrixWorld(true);
    this.muzzleW.copy(MARKER_MUZZLE).applyMatrix4(gun.matrixWorld);
    this.muzzleDir.set(0, 0, 1).transformDirection(gun.matrixWorld);
    this.puff.update(dt);
    bn[B.head].getWorldPosition(this.tagW);
    this.tagW.y += elim ? 0.4 : 0.85 * root.scale.y;
  }

  private stepElimination(dt: number): void {
    this.elimT += dt;
    const e = this.elimT;
    if (e < 0.14) {
      this.u.uPop.value = e / 0.14 * 0.5;
      this.wobble = 1;
    } else if (!this.burst) {
      this.burst = true;
      this.pudY.target = 0.1;
      this.pudXZ.target = 2.1;
      this.pudY.v = -6;
      this.u.uPop.value = 1;
      if (this.fx) {
        _tp.set(0, 0.8, 0).applyMatrix4(this.object.matrixWorld);
        this.fx.burst(_tp, { x: 0, y: 1, z: 0 }, this.popColor, 2.2);
        this.fx.burst(_tp, { x: 0, y: 1, z: 0 }, this.color, 1.2);
      }
    }
    if (e > 2.4) {
      this.pudXZ.target = 0;
      this.pudY.target = 0;
    }
    if (e > 3.2) this.mesh.visible = false;
  }

  // -------------------------------------------------------------------------
  private applyMaterial(s: BlobState, dt: number): void {
    const u = this.u;
    u.uTime.value = this.t;
    u.uWobble.value = this.wobble;
    u.uFlash.value = this.flash * 0.55;
    this.wet = lerp(this.wet, clamp(s.wetness, 0, 1), damp(4, dt));
    u.uWet.value = this.wet;
    const seaT = s.mode === "underwater" ? 1 : smoothstep(0.6, 0.95, s.wetness);
    this.sea += (seaT - this.sea) * damp(seaT > this.sea ? 1.4 : 0.45, dt);
    u.uSea.value = this.sea;

    // coats: new ones splat in with overshoot, washed ones shrink away
    const n = Math.min(3, s.coats.length);
    if (n > this.coatN) this.hit();
    for (let i = 0; i < 3; i++) {
      const sp = this.coatAmt[i];
      if (i < n) {
        const c = s.coats[i];
        if (this.coatCol[i] !== c || sp.target === 0) {
          if (sp.x < 0.05 || this.coatCol[i] !== c) {
            sp.x = 0;
            sp.v = 9;
            u.uCoatC.value[i].copy(this.pickSplat(i));
          }
          this.coatCol[i] = c;
          u.uCoatCol.value[i].set(c);
        }
        sp.target = 1;
        sp.step(dt);
      } else {
        sp.target = 0;
        sp.v = 0;
        sp.x = Math.max(0, sp.x - dt * 0.7);
        if (sp.x === 0) this.coatCol[i] = -1;
      }
    }
    this.coatN = n;
    u.uCoatAmt.value.set(Math.max(0, this.coatAmt[0].x), Math.max(0, this.coatAmt[1].x), Math.max(0, this.coatAmt[2].x));
    u.uPopCol.value.copy(this.popColor);

    // spawn shield
    const shieldT = s.shield ?? (s.mode === "spawn" ? 1 : 0);
    this.shieldA = lerp(this.shieldA, shieldT, damp(shieldT > this.shieldA ? 10 : 3, dt));
    this.shield.visible = this.shieldA > 0.02;
    if (this.shield.visible) {
      this.shieldMat.uniforms.uAlpha.value = this.shieldA;
      this.shieldMat.uniforms.uTime.value = this.t;
      (this.shieldMat.uniforms.uColor.value as THREE.Color).copy(this.color);
      const pz = this.mode === "spawn" ? Math.max(0.01, this.pop.x) : 1;
      this.shield.scale.set(0.8 * pz, 1.08 * pz, 0.82 * pz);
    }
  }

  private pickSplat(i: number): THREE.Vector3 {
    const pts = this.splatPoints;
    let best = pts[0];
    let bestD = -1;
    for (let tries = 0; tries < 8; tries++) {
      const p = pts[Math.floor(this.rand() * pts.length)];
      // prefer the front / sides where the camera sees them
      if (p.z < -0.15 && tries < 5) continue;
      let d = 9;
      for (let j = 0; j < 3; j++) if (j !== i && this.coatCol[j] >= 0) d = Math.min(d, p.distanceTo(this.u.uCoatC.value[j]));
      if (d > bestD) { bestD = d; best = p; }
      if (d > 0.45) break;
    }
    return best;
  }

  dispose(): void {
    this.object.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.shield.geometry.dispose();
    this.shieldMat.dispose();
    this.puff.dispose();
    this.flaps.dispose();
  }
}

const _X = new THREE.Vector3(1, 0, 0);
const _tp = new THREE.Vector3();
const _tq = new THREE.Vector3();

function neutral(o: Float32Array): void {
  o.fill(0);
  o[P.chestYaw] = -0.12;
  o[P.headYaw] = 0.1;
  o[P.gunAim] = 1;
  setHand(o, P.hLx, 0.37, 0.72, 0.07);
  setHand(o, P.hRx, -0.37, 0.72, 0.07);
  setFoot(o, P.fLx, 0.15, 0.08, 0.02);
  setFoot(o, P.fRx, -0.15, 0.08, 0.02);
  o[P.squash] = 1;
  o[P.crest] = 0.15;
  o[P.eyeOpen] = 1;
  o[P.smile] = 1;
  o[P.gunScale] = 1;
  o[P.aimFollow] = 1;
}

function setHand(o: Float32Array, i: number, x: number, y: number, z: number, w = 1): void {
  o[i] = lerp(o[i], x, w);
  o[i + 1] = lerp(o[i + 1], y, w);
  o[i + 2] = lerp(o[i + 2], z, w);
}
const setFoot = setHand;

const SHIELD_VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vV;
varying vec3 vP;
void main() {
  vP = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`;
const SHIELD_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uTime;
uniform float uAlpha;
varying vec3 vN;
varying vec3 vV;
varying vec3 vP;
void main() {
  float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
  float rim = pow(f, 2.5);
  // soap-bubble iridescence bands drifting upward
  float band = sin(vP.y * 9.0 - uTime * 3.0 + sin(vP.x * 6.0 + uTime) * 1.5);
  vec3 irid = 0.5 + 0.5 * cos(6.2831 * (vec3(0.0, 0.33, 0.67) + f * 1.2 + band * 0.15 + uTime * 0.1));
  vec3 col = mix(uColor, irid, 0.55) * (rim * 1.1 + 0.06) + vec3(1.0) * smoothstep(0.93, 1.0, band) * 0.12;
  // sparkly hex-ish glints
  float g = step(0.985, fract(sin(dot(floor(vP * 14.0), vec3(12.9898, 78.233, 37.719))) * 43758.5453 + uTime * 0.5));
  col += g * 0.5;
  gl_FragColor = vec4(col * uAlpha * 0.6, 1.0);
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------
// Skin flaps (patagia): a soft membrane per side from shoulder to hip on the
// body and from hand to foot on the outside, billowing up between them.

const FU = 7; // along (shoulder → hip)
const FV = 4; // across (body → hand/foot edge)
const _fs = new THREE.Vector3(), _fh = new THREE.Vector3(), _fa = new THREE.Vector3(), _ff = new THREE.Vector3();
const _fi = new THREE.Vector3(), _fo = new THREE.Vector3(), _fup = new THREE.Vector3();

class Flaps {
  readonly mesh: THREE.Mesh;
  private pos: Float32Array;
  private geo: THREE.BufferGeometry;
  private mat: THREE.MeshToonMaterial;

  constructor(color: THREE.Color) {
    this.geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(2 * FU * FV * 3);
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    const idx: number[] = [];
    for (let side = 0; side < 2; side++) {
      const b = side * FU * FV;
      for (let u = 0; u < FU - 1; u++)
        for (let v = 0; v < FV - 1; v++) {
          const a = b + u * FV + v, c = a + FV;
          if (side === 0) idx.push(a, c, a + 1, a + 1, c, c + 1);
          else idx.push(a, a + 1, c, a + 1, c + 1, c);
        }
    }
    this.geo.setIndex(idx);
    this.mat = makeToonMaterial({ side: THREE.DoubleSide });
    this.setColor(color);
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.name = "flaps";
  }

  setColor(c: THREE.Color): void {
    this.mat.color.copy(c).lerp(new THREE.Color(0xfff6e6), 0.1);
  }

  /** open 0..1; positions from the rig bones (object-local). */
  update(open: number, bones: THREE.Bone[], obj: THREE.Object3D, t: number): void {
    this.mesh.visible = open > 0.03;
    if (!this.mesh.visible) return;
    // the blob's back (billow direction), object-local
    _fup.set(0, 0, -1).applyQuaternion(bones[B.root].quaternion); // root sits directly under the object
    const p = this.pos;
    for (let side = 0; side < 2; side++) {
      obj.worldToLocal(bones[side === 0 ? B.armL : B.armR].getWorldPosition(_fs));
      obj.worldToLocal(bones[side === 0 ? B.legL : B.legR].getWorldPosition(_fh));
      obj.worldToLocal(bones[side === 0 ? B.handL : B.handR].getWorldPosition(_fa));
      obj.worldToLocal(bones[side === 0 ? B.footL : B.footR].getWorldPosition(_ff));
      const b = side * FU * FV;
      for (let u = 0; u < FU; u++) {
        const fu = u / (FU - 1);
        _fi.lerpVectors(_fs, _fh, fu);
        _fo.lerpVectors(_fa, _ff, fu);
        // scalloped outer edge: sags inward between wrist and ankle
        const scallop = Math.sin(Math.PI * fu) * 0.28;
        _fo.lerp(_fi, scallop);
        for (let v = 0; v < FV; v++) {
          const fv = (v / (FV - 1)) * open;
          const k = (b + u * FV + v) * 3;
          const billow = Math.sin(Math.PI * fu) * Math.sin(Math.PI * Math.min(1, fv * 1.15)) * (0.1 + Math.sin(t * 23 + u * 1.3 + side) * 0.012);
          p[k] = _fi.x + (_fo.x - _fi.x) * fv + _fup.x * billow;
          p[k + 1] = _fi.y + (_fo.y - _fi.y) * fv + _fup.y * billow;
          p[k + 2] = _fi.z + (_fo.z - _fi.z) * fv + _fup.z * billow;
        }
      }
    }
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    this.geo.computeVertexNormals();
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}

export function createBlob(opts: BlobOptions): BlobActor {
  return new Blob(opts);
}
