// Vehicles: jetski, speedboat (a Riva-style runabout), Vespa, gyrocopter. Each
// is a small Group with a handful of draw calls, seat anchors (put a blob on
// them with `state.seat`), hand grip anchors, and simple procedural animation
// (planing attitude, bank into carves, bow spray / rooster tail / wake; wheel
// spin + lean; rotor + prop spin and banking).
//
// Local frame: +Z = forward (bow / headlight / nose), +Y up, origin on the
// water line (boats) or the ground under the wheels (Vespa, gyrocopter).
// pos = that origin in world space.
import * as THREE from "three";
import { ParametricGeometry } from "three/addons/geometries/ParametricGeometry.js";
import { MeshBuilder, mat, clamp, damp, lerp } from "./builder";
import { makeToonMaterial, PALETTE } from "../style";
import { VehicleKind } from "../../../../shared/world/types";
import type { BlobMode } from "./blob";
import type { PaintFx, Vec3Like } from "./paintFx";

export interface VehicleState {
  pos: Vec3Like;
  yaw: number;
  /** Forward speed, m/s (negative = reversing). */
  speed?: number;
  /** -1..1, + = turning left. */
  steer?: number;
  /** Throttle -1..1 (exhaust puffs, prop speed). */
  throttle?: number;
  occupied?: boolean;
  /** Water surface height for boats (defaults to pos.y); ignored while airborne. */
  waterY?: number;
  /** Nose-up attitude (rad) from the sim: planing boats, climbing gyros. */
  pitch?: number;
  /** Jetski mid-hop / gyro flying. */
  airborne?: boolean;
}

export interface VehicleActor {
  readonly kind: VehicleKind;
  readonly object: THREE.Group;
  /** Seat anchors: pass as BlobState.seat. `driver` always exists. */
  readonly seats: { driver: THREE.Object3D; passenger?: THREE.Object3D; passenger2?: THREE.Object3D };
  /** Blob mode + standing flag to use for the driver. */
  readonly driverMode: BlobMode;
  readonly driverStanding: boolean;
  /** Driver hand targets in world space (handlebar / wheel / stick grips), refreshed by update(). */
  readonly gripL: THREE.Vector3;
  readonly gripR: THREE.Vector3;
  update(dt: number, state: VehicleState): void;
  dispose(): void;
}

type Hull = { len: number; beam: number; depth: number; sheerBow: number; sheerStern: number; transom: number; pow: number; rake?: number };

/** Parametric boat hull: u 0..1 stern→bow, v 0..1 port gunwale → keel → starboard gunwale. */
function hullPoint(h: Hull, u: number, v: number, inset: number, out: THREE.Vector3): THREE.Vector3 {
  const z = (u - 0.5) * h.len;
  const zn = (u - 0.5) * 2; // -1 stern … +1 bow
  // half-width: pointed bow, blunter stern with a small transom
  const bow = Math.max(0, 1 - Math.pow(Math.max(0, zn), 2));
  const stern = Math.max(h.transom, 1 - Math.pow(Math.max(0, -zn), 2.2));
  const w = (h.beam / 2) * Math.sqrt(zn > 0 ? bow : stern) * (1 - inset);
  const d = h.depth * (1 - 0.35 * zn * zn) * (1 - inset * 0.6);
  const sheer = 0.12 + (zn > 0 ? h.sheerBow : h.sheerStern) * Math.pow(Math.abs(zn), h.pow);
  const a = (v - 0.5) * Math.PI; // -90° … +90°
  const down = Math.pow(Math.cos(a), 0.7);
  // raked stem: the forefoot sweeps back under a flared bow
  const rake = zn > 0 ? (h.rake ?? 0) * zn * zn * zn * down : 0;
  out.set(Math.sin(a) * w, sheer - d * down - inset * 0.02, z - rake);
  return out;
}

function hullGeometry(h: Hull, inset: number, uSeg = 20, vSeg = 10): THREE.BufferGeometry {
  const g = new ParametricGeometry((u, v, target) => hullPoint(h, u, v, inset, target), uSeg, vSeg);
  g.computeVertexNormals();
  return g;
}

/** Crowned deck closing the hull top: u stern→bow, v port→starboard. */
function deckGeometry(h: Hull, crown: number, u0 = 0.005, u1 = 0.995, uSeg = 24, vSeg = 16): THREE.BufferGeometry {
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  const g = new ParametricGeometry((u, v, target) => {
    const uu = u0 + (u1 - u0) * u;
    hullPoint(h, uu, 0, 0, a);
    hullPoint(h, uu, 1, 0, b);
    const s = v * 2 - 1;
    target.set(lerp(a.x, b.x, v), lerp(a.y, b.y, v) + crown * (1 - s * s) * Math.min(1, Math.abs(a.x) * 3), a.z);
  }, uSeg, vSeg);
  g.computeVertexNormals();
  return g;
}

/** Flat transom closing the hull's open stern (u = 0), fanned from its middle. */
function transomGeometry(h: Hull, n = 12): THREE.BufferGeometry {
  const pos: number[] = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  const top = hullPoint(h, 0, 0, 0, new THREE.Vector3()).y;
  for (let i = 0; i < n; i++) {
    hullPoint(h, 0, i / n, 0, a);
    hullPoint(h, 0, (i + 1) / n, 0, b);
    pos.push(0, top, a.z, b.x, b.y, b.z, a.x, a.y, a.z);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** Tube along the gunwale (rim) of the hull. */
function rimGeometry(h: Hull, r: number): THREE.BufferGeometry {
  const pts: THREE.Vector3[] = [];
  const n = 24;
  for (let i = 0; i <= n; i++) pts.push(hullPoint(h, 0.01 + (i / n) * 0.98, 0, 0, new THREE.Vector3()));
  for (let i = n; i >= 0; i--) pts.push(hullPoint(h, 0.01 + (i / n) * 0.98, 1, 0, new THREE.Vector3()));
  const curve = new THREE.CatmullRomCurve3(pts, true);
  return new THREE.TubeGeometry(curve, 60, r, 5, true);
}

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();

// ---------------------------------------------------------------------------
// Power boats (jetski + speedboat)

interface PowerParts {
  hull: Hull;
  body: THREE.Object3D[];
  /** Handlebar / steering wheel assembly (grips are its descendants) and how to turn it. */
  steer: THREE.Object3D;
  turn: (steer: number) => void;
  gl: THREE.Object3D;
  gr: THREE.Object3D;
  seats: { driver: THREE.Object3D; passenger?: THREE.Object3D; passenger2?: THREE.Object3D };
  wake: THREE.Mesh;
  /** Raise the hull so the water line sits right. */
  lift: number;
  jet: boolean;
}

class PowerBoat implements VehicleActor {
  readonly object = new THREE.Group();
  readonly seats: VehicleActor["seats"];
  readonly driverMode: BlobMode = "ride-vespa";
  readonly driverStanding = false;
  readonly gripL = new THREE.Vector3();
  readonly gripR = new THREE.Vector3();
  private rock = new THREE.Group();
  private t = Math.random() * 10;
  private roll = 0;
  private pitch = 0;
  private steerA = 0;
  private sprayT = 0;
  private puffT = 0;
  private wasAir = false;
  private wakeMat: THREE.ShaderMaterial;

  constructor(readonly kind: VehicleKind, private parts: PowerParts, private fx: PaintFx | null) {
    this.object.add(this.rock);
    for (const b of parts.body) this.rock.add(b);
    this.rock.add(parts.steer);
    this.seats = parts.seats;
    for (const s of Object.values(parts.seats)) if (s) this.rock.add(s);
    this.object.add(parts.wake);
    this.wakeMat = parts.wake.material as THREE.ShaderMaterial;
  }

  update(dtIn: number, s: VehicleState): void {
    const dt = Math.min(dtIn, 0.05);
    this.t += dt;
    const t = this.t;
    const P = this.parts;
    const sp = s.speed ?? 0;
    const asp = Math.abs(sp);
    const steer = clamp(s.steer ?? 0, -1, 1);
    const air = !!s.airborne;
    const wy = air ? s.pos.y : s.waterY ?? s.pos.y;
    this.object.position.set(s.pos.x, wy, s.pos.z);
    this.object.rotation.set(0, s.yaw, 0);
    // bank into carves (jetskis like a motorbike), sim attitude + a little chop slap at speed
    const bankK = P.jet ? 0.032 : 0.011, bankMax = P.jet ? 0.5 : 0.14;
    this.roll = lerp(this.roll, clamp(-steer * asp * bankK, -bankMax, bankMax), damp(P.jet ? 5 : 2.5, dt));
    this.pitch = lerp(this.pitch, s.pitch ?? 0, damp(8, dt));
    const calm = 1 - clamp(asp / 8, 0, 0.8);
    const slap = air ? 0 : clamp((asp - 6) / 12, 0, 1) * (P.jet ? 0.018 : 0.01);
    this.rock.position.y = P.lift + (Math.sin(t * 1.3) * 0.035 + Math.sin(t * 2.1 + 1) * 0.015) * calm + Math.abs(Math.sin(t * 7.3)) * slap - (s.occupied ? 0.03 : 0);
    this.rock.rotation.set(-this.pitch + Math.sin(t * 1.1) * 0.02 * calm - Math.sin(t * 7.3) * slap, 0, this.roll + Math.sin(t * 0.9 + 2) * 0.03 * calm, "YXZ");
    // handlebar / wheel
    this.steerA = lerp(this.steerA, steer, damp(10, dt));
    P.turn(this.steerA);
    this.object.updateMatrixWorld(true);
    P.gl.getWorldPosition(this.gripL);
    P.gr.getWorldPosition(this.gripR);

    // wake: longer and whiter with speed
    const wk = air ? 0 : clamp(asp / 6, 0, 1);
    this.wakeMat.uniforms.uAmt.value = lerp(this.wakeMat.uniforms.uAmt.value, wk, damp(3, dt));
    this.wakeMat.uniforms.uTime.value = t * (0.6 + wk * 1.5);
    P.wake.scale.set(1 + wk * 0.4, 1, 0.5 + clamp(asp / 14, 0, 1.2));
    P.wake.visible = this.wakeMat.uniforms.uAmt.value > 0.02;

    if (!this.fx) { this.wasAir = air; return; }
    const fwdX = Math.sin(s.yaw), fwdZ = Math.cos(s.yaw);
    const L = P.hull.len;
    // splash down after a hop
    if (this.wasAir && !air) this.fx.splashWater(_v.set(s.pos.x, wy, s.pos.z), P.jet ? 0.7 : 1);
    this.wasAir = air;
    // exhaust burble while someone's at the helm
    if (s.occupied) {
      this.puffT -= dt;
      if (this.puffT <= 0) {
        this.puffT = 0.22 - Math.max(0, s.throttle ?? 0) * 0.12;
        _v.set(P.jet ? 0 : 0.5, P.lift + (P.jet ? 0.25 : 0.2), -L * 0.5).applyMatrix4(this.rock.matrixWorld);
        this.fx.dust(_v, 1, 0xeeeaf2);
      }
    }
    if (air || asp < 2) return;
    this.sprayT -= dt;
    if (this.sprayT > 0) return;
    this.sprayT = P.jet ? 0.045 : 0.06;
    // bow spray peeling off both sides
    for (const side of [1, -1]) {
      _v.set(side * P.hull.beam * 0.3, 0.05, L * (P.jet ? 0.3 : 0.28)).applyMatrix4(this.object.matrixWorld);
      _v.y = wy + 0.05;
      const sx = Math.cos(s.yaw) * side, sz = -Math.sin(s.yaw) * side;
      const out = 1 + asp * 0.12;
      this.fx.spray(_v, { x: sx * out + fwdX * sp * 0.25, y: 0.6 + asp * 0.1, z: sz * out + fwdZ * sp * 0.25 }, P.jet ? 1 : 2);
    }
    // jetski rooster tail; everyone throws a sheet off the outside of a hard carve
    if (P.jet && asp > 5) {
      _v.set(0, 0.1, -L * 0.52).applyMatrix4(this.object.matrixWorld);
      _v.y = wy + 0.1;
      this.fx.spray(_v, { x: -fwdX * asp * 0.25, y: 2.2 + asp * 0.14, z: -fwdZ * asp * 0.25 }, 2);
    }
    const carve = Math.abs(steer) * asp;
    if (carve > (P.jet ? 6 : 9)) {
      const side = steer > 0 ? -1 : 1; // outside of the turn
      _v.set(side * P.hull.beam * 0.5, 0.05, -L * 0.2).applyMatrix4(this.object.matrixWorld);
      _v.y = wy + 0.05;
      const sx = Math.cos(s.yaw) * side, sz = -Math.sin(s.yaw) * side;
      this.fx.spray(_v, { x: sx * (2 + carve * 0.15), y: 1.5 + carve * 0.08, z: sz * (2 + carve * 0.15) }, P.jet ? 3 : 2);
    }
  }

  dispose(): void {
    disposeTree(this.object);
  }
}

function disposeTree(root: THREE.Object3D): void {
  root.removeFromParent();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
  });
}

const WAKE_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;
const WAKE_FRAG = /* glsl */ `
uniform float uTime;
uniform float uAmt;
varying vec2 vUv;
void main() {
  // vUv.x across the V (0 inner edge, 1 outer), vUv.y along (0 at hull → 1 far behind)
  float along = vUv.y;
  float band = sin(along * 26.0 - uTime * 6.0 + vUv.x * 5.0) * 0.5 + 0.5;
  float edge = smoothstep(0.0, 0.25, vUv.x) * (1.0 - smoothstep(0.55, 1.0, vUv.x));
  float a = edge * (1.0 - along) * step(0.35, band + (1.0 - along) * 0.4) * uAmt;
  if (a < 0.02) discard;
  gl_FragColor = vec4(vec3(1.0), a * 0.85);
  #include <colorspace_fragment>
}
`;

/** V-shaped foam wake trailing from the stern (plus a churned strip down the middle). */
function makeWake(len: number, spread: number, stern: number, centre = 0): THREE.Mesh {
  const b = new THREE.BufferGeometry();
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  const segs = 12;
  for (const side of [1, -1]) {
    const base = pos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const z = -t * len;
      const cx = side * (0.25 + t * spread);
      const w = 0.25 + t * 0.9;
      pos.push(cx - side * w * 0.5, 0.02, z, cx + side * w * 0.5, 0.02, z);
      uv.push(0, t, 1, t);
      if (i < segs) {
        const a = base + i * 2;
        if (side > 0) idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
        else idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
  }
  if (centre > 0) {
    // prop wash: a straight churned strip
    const base = pos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const z = -t * len * 0.7;
      const w = centre * (1 + t);
      pos.push(-w, 0.025, z, w, 0.025, z);
      uv.push(0.2, t, 0.8, t);
      if (i < segs) {
        const a = base + i * 2;
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
  }
  b.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  b.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  b.setIndex(idx);
  const m = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uAmt: { value: 0 } },
    vertexShader: WAKE_VERT,
    fragmentShader: WAKE_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(b, m);
  mesh.position.z = stern;
  mesh.renderOrder = 3;
  mesh.visible = false;
  return mesh;
}

function anchor(name: string, x: number, y: number, z: number, yaw = 0): THREE.Object3D {
  const o = new THREE.Object3D();
  o.name = name;
  o.position.set(x, y, z);
  o.rotation.y = yaw;
  return o;
}

function toonMesh(g: THREE.BufferGeometry, shadow = true): THREE.Mesh {
  const m = new THREE.Mesh(g, makeToonMaterial({ vertexColors: true }));
  m.castShadow = shadow;
  m.receiveShadow = true;
  return m;
}

export interface BoatOptions {
  /** Main paint color (jetski cowl, speedboat boot stripe, gyro body). */
  color?: THREE.ColorRepresentation;
  fx?: PaintFx | null;
}

const CREAM = 0xfff4dc;
const CHROME = 0xd8dde3;
const INK = 0x3b3440;

export const JETSKI_COLORS = [0x9fd8c8, 0xf6b8c0, 0xffe39a, 0xa9cdf0, 0xd9b8ef];

/** A stubby retro water scooter: pastel cowl, cream saddle, chrome bars, racing roundel. */
export function createJetski(opts: BoatOptions = {}): VehicleActor {
  const hull: Hull = { len: 2.9, beam: 0.95, depth: 0.5, sheerBow: 0.2, sheerStern: 0.04, transom: 0.72, pow: 2, rake: 0.7 };
  const paint = new THREE.Color(opts.color ?? JETSKI_COLORS[0]);
  const white = new THREE.Color(0xf7f3ea);
  const stripe = new THREE.Color(0xe0644f);
  const b = new MeshBuilder();
  b.add(hullGeometry(hull, 0, 20, 12), {
    colorFn: (p, _n, c) => {
      const top = hullPoint(hull, p.z / hull.len + 0.5, 0, 0, _v).y;
      const dy = top - p.y;
      c.copy(dy < 0.07 ? paint : dy < 0.12 ? stripe : white);
    },
  });
  b.add(deckGeometry(hull, 0.06), { color: paint });
  b.add(transomGeometry(hull), { color: white });
  b.add(rimGeometry(hull, 0.035), { color: white });
  const sph = new THREE.SphereGeometry(1, 16, 10);
  // front cowl hump + footwells
  b.add(sph, { color: paint, matrix: mat(0, 0.2, 0.55, -0.12, 0, 0, 0.4, 0.36, 0.75) });
  b.add(sph, { color: stripe, matrix: mat(0, 0.2, 0.55, -0.12, 0, 0, 0.405, 0.2, 0.7) });
  b.add(sph, { color: paint, matrix: mat(0, 0.12, -0.55, 0, 0, 0, 0.44, 0.2, 0.9) });
  // saddle (two-tone) on a pedestal
  b.add(new THREE.BoxGeometry(0.36, 0.24, 1.15), { color: paint, matrix: mat(0, 0.2, -0.42) });
  b.add(new THREE.CapsuleGeometry(0.15, 0.95, 4, 10), { color: 0xfff0d2, matrix: mat(0, 0.38, -0.42, Math.PI / 2, 0, 0, 1.15, 1, 0.8) });
  b.add(new THREE.TorusGeometry(0.16, 0.014, 4, 16), { color: 0xc98d5c, matrix: mat(0, 0.38, -0.42, 0, Math.PI / 2, 0, 1, 0.8, 3.4) });
  // racing roundel on both flanks + a jet nozzle at the stern
  for (const side of [1, -1]) {
    b.add(new THREE.CircleGeometry(0.12, 16), { color: CREAM, matrix: mat(side * 0.5, 0.04, 0.3, 0, side * Math.PI / 2, 0) });
    b.add(new THREE.CircleGeometry(0.07, 16), { color: stripe, matrix: mat(side * 0.505, 0.04, 0.3, 0, side * Math.PI / 2, 0) });
  }
  b.add(new THREE.CylinderGeometry(0.1, 0.12, 0.2, 10, 1, true), { color: INK, matrix: mat(0, -0.06, -1.45, Math.PI / 2, 0, 0) });
  // round headlight on the cowl nose
  b.add(new THREE.CylinderGeometry(0.08, 0.075, 0.06, 12), { color: CHROME, matrix: mat(0, 0.4, 1.13, Math.PI / 2 - 0.5, 0, 0) });
  b.add(new THREE.SphereGeometry(0.07, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), { color: 0xfffbe0, matrix: mat(0, 0.41, 1.16, Math.PI / 2 - 0.5, 0, 0, 1, 0.45, 1) });
  const body = toonMesh(b.build());

  // handlebar on a steering post, with a little windscreen
  const hb = new MeshBuilder();
  hb.add(new THREE.CylinderGeometry(0.035, 0.045, 0.42, 8), { color: paint, matrix: mat(0, 0.16, 0, -0.35, 0, 0) });
  hb.add(new THREE.CapsuleGeometry(0.022, 0.58, 2, 6), { color: CHROME, matrix: mat(0, 0.36, -0.08, 0, 0, Math.PI / 2) });
  for (const side of [1, -1]) hb.add(new THREE.CapsuleGeometry(0.03, 0.08, 2, 6), { color: INK, matrix: mat(side * 0.3, 0.36, -0.08, 0, 0, Math.PI / 2) });
  hb.add(new THREE.CylinderGeometry(0.2, 0.2, 0.16, 12, 1, true, -Math.PI * 0.4, Math.PI * 0.8), { color: 0xcdeef5, matrix: mat(0, 0.44, 0.02, -0.35, 0, 0) });
  const steer = new THREE.Group();
  steer.position.set(0, 0.36, 0.4);
  steer.add(toonMesh(hb.build()));
  const gl = anchor("gripL", 0.3, 0.36, -0.08), gr = anchor("gripR", -0.3, 0.36, -0.08);
  steer.add(gl, gr);
  // seat anchors are in hull space: world height (shared SEATS) minus the lift
  const seats = { driver: anchor("driver", 0, 0.62 - 0.12, -0.2, 0) };
  return new PowerBoat(VehicleKind.Jetski, {
    hull, body: [body], steer, turn: (a) => { steer.rotation.y = a * 0.4; }, gl, gr, seats,
    wake: makeWake(9, 2.2, -1.3, 0.25), lift: 0.12, jet: true,
  }, opts.fx ?? null);
}

/** A 1950s Riva-style runabout: varnished mahogany, pastel boot stripe, cream leather, chrome. */
export function createSpeedboat(opts: BoatOptions = {}): VehicleActor {
  const hull: Hull = { len: 6.3, beam: 2.05, depth: 0.95, sheerBow: 0.22, sheerStern: 0.04, transom: 0.8, pow: 2, rake: 1.1 };
  const trim = new THREE.Color(opts.color ?? 0x8fd6c9);
  const mahogany = new THREE.Color(0xa4552f);
  const mahoganyDark = new THREE.Color(0x7d3b22);
  const caulk = new THREE.Color(0xf1d9b0);
  const bottom = new THREE.Color(0xf4efe6);
  const b = new MeshBuilder();
  b.add(hullGeometry(hull, 0, 28, 14), {
    colorFn: (p, _n, c) => {
      const top = hullPoint(hull, p.z / hull.len + 0.5, 0, 0, _v).y;
      const dy = top - p.y;
      // varnished topsides with plank seams, a pastel boot stripe at the water line, white bottom
      if (dy < 0.5) c.copy(Math.abs(((dy * 9) % 1) - 0.5) < 0.06 ? mahoganyDark : mahogany);
      else if (dy < 0.62) c.copy(trim);
      else c.copy(bottom);
    },
  });
  // the famous striped deck: mahogany planks with blond caulking lines
  b.add(deckGeometry(hull, 0.1, 0.005, 0.995, 30, 28), {
    colorFn: (p, _n, c) => {
      const s = Math.abs(p.x) / 0.14;
      c.copy(Math.abs((s % 1) - 0.5) > 0.4 && Math.abs(p.x) > 0.03 ? caulk : mahogany);
      if (Math.abs(p.x) < 0.03) c.copy(caulk);
    },
  });
  b.add(transomGeometry(hull, 16), { color: mahogany });
  b.add(rimGeometry(hull, 0.03), { color: CHROME });
  // cockpit wells (dark leather-lined tubs) with cream bench seats + backrests
  const box = new THREE.BoxGeometry(1, 1, 1);
  // (seats sit low in the wells: only the rounded backrests show above the deck)
  const tub = (z: number, len: number) => {
    b.add(box, { color: 0x5a2f1f, matrix: mat(0, 0.2, z, 0, 0, 0, 1.55, 0.07, len) });
    for (const side of [1, -1]) b.add(new THREE.BoxGeometry(0.66, 0.06, len * 0.62), { color: CREAM, matrix: mat(side * 0.37, 0.235, z + len * 0.08) });
    b.add(new THREE.CapsuleGeometry(0.13, 1.15, 3, 10), { color: CREAM, matrix: mat(0, 0.34, z - len * 0.42, 0.3, 0, Math.PI / 2, 1, 1, 0.9) });
    for (let i = -2; i <= 2; i++) b.add(new THREE.BoxGeometry(0.018, 0.2, 0.018), { color: trim, matrix: mat(i * 0.25, 0.35, z - len * 0.42 + 0.1, 0.3, 0, 0) });
  };
  tub(0.3, 1.2);
  tub(-1.05, 1.0);
  // windscreen: chrome frame (glass is its own translucent mesh)
  const ws: THREE.Vector3[] = [];
  for (let i = 0; i <= 16; i++) {
    const a = (i / 16 - 0.5) * Math.PI * 0.8;
    ws.push(new THREE.Vector3(Math.sin(a) * 0.85, 0.24, 0.95 + Math.cos(a) * 0.3));
  }
  b.add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(ws), 24, 0.022, 5), { color: CHROME });
  const wsTop = ws.map((p) => new THREE.Vector3(p.x * 0.96, p.y + 0.3, p.z - 0.1));
  b.add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(wsTop), 24, 0.02, 5), { color: CHROME });
  for (const side of [1, -1]) b.add(new THREE.CylinderGeometry(0.015, 0.015, 0.32, 5), { color: CHROME, matrix: mat(side * 0.66, 0.39, 1.1, -0.3, 0, 0) });
  // chrome deck fittings: bow cleat, running light, stern flag staff
  b.add(new THREE.CapsuleGeometry(0.025, 0.18, 2, 6), { color: CHROME, matrix: mat(0, 0.34, 2.8, 0, 0, Math.PI / 2) });
  b.add(new THREE.SphereGeometry(0.05, 8, 6), { color: 0xfff1b0, matrix: mat(0, 0.36, 2.55) });
  b.add(new THREE.CylinderGeometry(0.015, 0.015, 0.75, 5), { color: CHROME, matrix: mat(0, 0.5, -3.02, -0.25, 0, 0) });
  // a little pastel pennant on the staff
  const flag = new THREE.BufferGeometry();
  flag.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 0, -0.22, 0, 0, -0.11, -0.4], 3));
  flag.computeVertexNormals();
  b.add(flag, { color: trim, matrix: mat(0, 0.86, -3.12, -0.25, 0, 0) });
  b.add(flag, { color: trim, matrix: mat(0, 0.86, -3.12, -0.25, 0, 0), flip: true });
  // transom name plate + chrome rub strakes along the sheer
  b.add(new THREE.BoxGeometry(0.7, 0.14, 0.02), { color: CHROME, matrix: mat(0, 0.0, -3.14) });
  const body = toonMesh(b.build());
  const glass = new THREE.Mesh(
    new THREE.CylinderGeometry(0.87, 0.85, 0.36, 20, 1, true, -Math.PI * 0.4, Math.PI * 0.8),
    makeToonMaterial({ color: 0xcfeef7, transparent: true, opacity: 0.35, side: THREE.DoubleSide }),
  );
  glass.position.set(0, 0.39, 0.93);
  glass.scale.set(1, 0.85, 0.36);
  glass.rotation.x = -0.28;

  // steering wheel (cream rim, chrome spokes) on the starboard (-X) side
  const wb = new MeshBuilder();
  wb.add(new THREE.TorusGeometry(0.19, 0.022, 6, 20), { color: CREAM });
  for (let i = 0; i < 3; i++) wb.add(new THREE.BoxGeometry(0.018, 0.19, 0.012), { color: CHROME, matrix: mat(0, 0, 0, 0, 0, (i / 3) * Math.PI * 2, 1, 1, 1).multiply(mat(0, 0.095, 0)) });
  wb.add(new THREE.CylinderGeometry(0.04, 0.04, 0.05, 10), { color: CHROME, matrix: mat(0, 0, 0, Math.PI / 2, 0, 0) });
  wb.add(new THREE.CylinderGeometry(0.02, 0.02, 0.4, 6), { color: INK, matrix: mat(0, 0, 0.2, Math.PI / 2, 0, 0) });
  const wheel = new THREE.Group();
  wheel.add(toonMesh(wb.build()));
  // the column leans back toward the driver; the wheel spins about it
  const steer = new THREE.Group();
  steer.position.set(-0.4, 0.46, 0.78);
  steer.rotation.x = -0.5;
  const spin = new THREE.Group();
  steer.add(spin);
  spin.add(wheel);
  const gl = anchor("gripL", 0.17, 0.03, 0), gr = anchor("gripR", -0.17, 0.03, 0);
  spin.add(gl, gr);
  const lift = 0.45;
  const seats = {
    driver: anchor("driver", -0.4, 0.55 - lift, 0.3, 0),
    passenger: anchor("passenger", 0.4, 0.55 - lift, 0.3, 0),
    passenger2: anchor("passenger2", 0, 0.55 - lift, -1.05, 0),
  };
  return new PowerBoat(VehicleKind.Speedboat, {
    hull, body: [body, glass], steer, turn: (a) => { spin.rotation.z = -a * 1.8; }, gl, gr, seats,
    wake: makeWake(16, 4.2, -3.0, 0.5), lift, jet: false,
  }, opts.fx ?? null);
}
// ---------------------------------------------------------------------------
// Vespa

export interface VespaOptions {
  color?: THREE.ColorRepresentation;
  fx?: PaintFx | null;
}

class Vespa implements VehicleActor {
  readonly kind = VehicleKind.Vespa;
  readonly object = new THREE.Group();
  readonly seats: VehicleActor["seats"];
  readonly driverMode: BlobMode = "ride-vespa";
  readonly driverStanding = false;
  readonly gripL = new THREE.Vector3();
  readonly gripR = new THREE.Vector3();
  private lean = new THREE.Group();
  private steerG = new THREE.Group();
  private front: THREE.Mesh;
  private rear: THREE.Mesh;
  private gl: THREE.Object3D;
  private gr: THREE.Object3D;
  private spin = 0;
  private leanA = 0;
  private steerA = 0;
  private t = 0;
  private puffT = 0;

  constructor(color: THREE.ColorRepresentation, private fx: PaintFx | null) {
    const paint = new THREE.Color(color);
    const cream = 0xfff4dc;
    const chrome = 0xd8dde3;
    const dark = 0x3b3440;
    const b = new MeshBuilder();
    const sph = new THREE.SphereGeometry(1, 14, 10);
    // bulbous rear cowl + side bulges
    b.add(sph, { color: paint, matrix: mat(0, 0.4, -0.38, 0, 0, 0, 0.25, 0.25, 0.44) });
    b.add(sph, { color: paint, matrix: mat(0.07, 0.36, -0.42, 0, 0, 0, 0.21, 0.2, 0.36) });
    b.add(sph, { color: paint, matrix: mat(-0.07, 0.36, -0.42, 0, 0, 0, 0.21, 0.2, 0.36) });
    // cream pinstripe on the cowl
    b.add(new THREE.TorusGeometry(0.25, 0.012, 4, 20, Math.PI), { color: cream, matrix: mat(0, 0.4, -0.38, 0, Math.PI / 2, 0, 1, 1, 1.76) });
    // floorboard + tunnel
    b.add(new THREE.BoxGeometry(0.34, 0.06, 0.62), { color: paint, matrix: mat(0, 0.2, 0.12) });
    b.add(new THREE.BoxGeometry(0.3, 0.012, 0.56), { color: dark, matrix: mat(0, 0.235, 0.12) });
    // leg shield: curved front apron
    b.add(new THREE.CylinderGeometry(0.2, 0.28, 0.8, 14, 1, true, -Math.PI * 0.45, Math.PI * 0.9), { color: paint, matrix: mat(0, 0.58, 0.36, -0.2, 0, 0) });
    b.add(new THREE.CylinderGeometry(0.195, 0.275, 0.8, 14, 1, true, -Math.PI * 0.45, Math.PI * 0.9), { color: cream, flip: true, matrix: mat(0, 0.58, 0.36, -0.2, 0, 0) });
    // saddle (two-tone brown)
    b.add(new THREE.CapsuleGeometry(0.12, 0.42, 3, 8), { color: 0x8a5634, matrix: mat(0, 0.64, -0.3, Math.PI / 2, 0, 0, 1.1, 1, 0.55) });
    // rear rack + taillight + exhaust
    b.add(new THREE.TorusGeometry(0.12, 0.012, 4, 10, Math.PI), { color: chrome, matrix: mat(0, 0.6, -0.72, -Math.PI / 2, 0, 0, 1, 1.3, 1) });
    b.add(new THREE.BoxGeometry(0.08, 0.05, 0.04), { color: 0xe0404a, matrix: mat(0, 0.52, -0.86) });
    b.add(new THREE.CylinderGeometry(0.035, 0.04, 0.3, 6), { color: chrome, matrix: mat(-0.2, 0.2, -0.55, Math.PI / 2, 0, 0) });
    // rear wheel fender
    b.add(new THREE.SphereGeometry(1, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), { color: paint, matrix: mat(0, 0.2, -0.52, 0, 0, 0, 0.14, 0.18, 0.26) });
    const body = toonMesh(b.build());
    this.lean.add(body);

    // wheels
    const wb = new MeshBuilder();
    wb.add(new THREE.TorusGeometry(0.15, 0.055, 6, 14), { color: 0x2f2a33, matrix: mat(0, 0, 0, 0, Math.PI / 2, 0) });
    wb.add(new THREE.CylinderGeometry(0.1, 0.1, 0.09, 10), { color: cream, matrix: mat(0, 0, 0, 0, 0, Math.PI / 2) });
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      wb.add(new THREE.SphereGeometry(0.018, 5, 4), { color: chrome, matrix: mat(0.05, Math.sin(a) * 0.055, Math.cos(a) * 0.055) });
      wb.add(new THREE.SphereGeometry(0.018, 5, 4), { color: chrome, matrix: mat(-0.05, Math.sin(a) * 0.055, Math.cos(a) * 0.055) });
    }
    const wheelGeo = wb.build();
    const wheelMat = makeToonMaterial({ vertexColors: true });
    this.rear = new THREE.Mesh(wheelGeo, wheelMat);
    this.rear.position.set(0, 0.2, -0.5);
    this.rear.castShadow = true;
    this.lean.add(this.rear);

    // steering assembly: fork, fender, handlebar, round headlight
    const sb = new MeshBuilder();
    sb.add(new THREE.CylinderGeometry(0.035, 0.035, 0.7, 6), { color: paint, matrix: mat(0, 0.3, -0.03, -0.2, 0, 0) });
    sb.add(new THREE.SphereGeometry(1, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), { color: paint, matrix: mat(0, -0.06, 0.02, 0.15, 0, 0, 0.13, 0.2, 0.26) });
    sb.add(new THREE.CapsuleGeometry(0.03, 0.5, 2, 6), { color: paint, matrix: mat(0, 0.62, -0.1, 0, 0, Math.PI / 2) });
    sb.add(new THREE.CapsuleGeometry(0.075, 0.12, 3, 10), { color: paint, matrix: mat(0, 0.61, -0.08, 0, 0, Math.PI / 2, 1, 1, 1.3) });
    for (const side of [1, -1]) sb.add(new THREE.CapsuleGeometry(0.033, 0.09, 2, 6), { color: dark, matrix: mat(side * 0.3, 0.62, -0.1, 0, 0, Math.PI / 2) });
    // headlight: chrome bucket + glowing cream lens
    sb.add(new THREE.CylinderGeometry(0.085, 0.07, 0.08, 12), { color: chrome, matrix: mat(0, 0.64, 0.0, Math.PI / 2, 0, 0) });
    sb.add(new THREE.SphereGeometry(0.075, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), { color: 0xfffbe0, matrix: mat(0, 0.64, 0.035, Math.PI / 2, 0, 0, 1, 0.45, 1) });
    // little horn grille on the apron
    sb.add(new THREE.CylinderGeometry(0.045, 0.045, 0.02, 8), { color: chrome, matrix: mat(0, 0.38, 0.1, Math.PI / 2 - 0.2, 0, 0) });
    const steerMesh = toonMesh(sb.build());
    this.steerG.position.set(0, 0.35, 0.62);
    this.steerG.rotation.x = -0.2;
    const steerInner = new THREE.Group();
    steerInner.rotation.x = 0.2;
    this.steerG.add(steerInner);
    steerInner.add(steerMesh);
    this.front = new THREE.Mesh(wheelGeo, wheelMat);
    this.front.position.set(0, -0.15, 0.03);
    this.front.castShadow = true;
    steerInner.add(this.front);
    this.gl = anchor("gripL", 0.31, 0.62, -0.1);
    this.gr = anchor("gripR", -0.31, 0.62, -0.1);
    steerInner.add(this.gl, this.gr);
    this.lean.add(this.steerG);
    this.object.add(this.lean);
    this.seats = {
      driver: anchor("driver", 0, 0.72, -0.2, 0),
      passenger: anchor("passenger", 0, 0.73, -0.52, 0),
    };
    this.lean.add(this.seats.driver, this.seats.passenger!);
  }

  update(dtIn: number, s: VehicleState): void {
    const dt = Math.min(dtIn, 0.05);
    this.t += dt;
    const sp = s.speed ?? 0;
    const steer = clamp(s.steer ?? 0, -1, 1);
    this.object.position.set(s.pos.x, s.pos.y, s.pos.z);
    this.object.rotation.set(0, s.yaw, 0);
    this.spin += (sp / 0.2) * dt;
    this.front.rotation.x = this.spin;
    this.rear.rotation.x = this.spin;
    this.steerA = lerp(this.steerA, steer * 0.45, damp(8, dt));
    this.steerG.rotation.y = this.steerA;
    // lean into turns; parked Vespas sit on their stand, a touch tilted
    const target = s.occupied || Math.abs(sp) > 0.5 ? clamp(-steer * Math.abs(sp) * 0.06, -0.4, 0.4) : 0.0;
    this.leanA = lerp(this.leanA, target, damp(4, dt));
    this.lean.rotation.z = this.leanA;
    this.lean.position.y = s.occupied ? Math.sin(this.t * 25) * 0.004 * Math.min(1, Math.abs(sp)) - 0.01 : 0;
    this.object.updateMatrixWorld(true);
    this.gl.getWorldPosition(this.gripL);
    this.gr.getWorldPosition(this.gripR);
    if (this.fx && s.occupied) {
      this.puffT -= dt;
      if (this.puffT <= 0) {
        this.puffT = 0.18 - (s.throttle ?? 0) * 0.1;
        _v.set(-0.2, 0.2, -0.75).applyMatrix4(this.object.matrixWorld);
        this.fx.dust(_v, 1, 0xe8e4f0);
        if (Math.abs(sp) > 4) this.fx.dust(_v.set(0, 0.02, -0.55).applyMatrix4(this.object.matrixWorld), 1);
      }
    }
  }

  dispose(): void {
    this.object.removeFromParent();
    this.object.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
    });
  }
}

export const VESPA_COLORS = [0x9fd8c8, 0xf6c7c0, 0xfff0b8, 0xb7d7f0, 0xe9c6ef];

export function createVespa(opts: VespaOptions = {}): VehicleActor {
  return new Vespa(opts.color ?? VESPA_COLORS[0], opts.fx ?? null);
}

// ---------------------------------------------------------------------------
// Gyrocopter

export const GYRO_COLORS = [0xf7d77a, 0xf4a99a, 0x9fd8c8, 0xb7d7f0];

class Gyrocopter implements VehicleActor {
  readonly kind = VehicleKind.Gyrocopter;
  readonly object = new THREE.Group();
  readonly seats: VehicleActor["seats"];
  readonly driverMode: BlobMode = "ride-vespa";
  readonly driverStanding = false;
  readonly gripL = new THREE.Vector3();
  readonly gripR = new THREE.Vector3();
  private tilt = new THREE.Group();
  private rotor = new THREE.Group();
  private prop = new THREE.Group();
  private propDisc: THREE.Mesh;
  private wheels: THREE.Mesh[] = [];
  private stick = new THREE.Group();
  private gl: THREE.Object3D;
  private gr: THREE.Object3D;
  private rotorRate = 0;
  private propRate = 0;
  private roll = 0;
  private pitch = 0;
  private wheelSpin = 0;
  private puffT = 0;
  private wasAir = false;

  constructor(color: THREE.ColorRepresentation, private fx: PaintFx | null) {
    const paint = new THREE.Color(color);
    const coral = new THREE.Color(0xe0644f);
    const cream = new THREE.Color(CREAM);
    this.object.add(this.tilt);
    const b = new MeshBuilder();
    const sph = new THREE.SphereGeometry(1, 20, 14);
    // egg-shaped pod: paint on top, cream belly, a coral cheat line
    b.add(sph, {
      matrix: mat(0, 0.86, 0.2, 0, 0, 0, 0.64, 0.56, 1.15),
      colorFn: (p, _n, c) => { c.copy(p.y > 0.9 ? paint : p.y > 0.8 ? coral : cream); },
    });
    // cockpit opening: dark tub + leather padded coaming
    b.add(sph, { color: 0x4a3530, matrix: mat(0, 1.25, 0.02, 0, 0, 0, 0.38, 0.12, 0.5) });
    b.add(new THREE.TorusGeometry(0.4, 0.055, 6, 22), { color: 0x8a5634, matrix: mat(0, 1.3, 0.02, Math.PI / 2, 0, 0, 1, 1.3, 1) });
    // little windscreen + nose cap + side roundels
    b.add(new THREE.CylinderGeometry(0.34, 0.3, 0.22, 14, 1, true, -Math.PI * 0.45, Math.PI * 0.9), { color: 0xcfeef7, matrix: mat(0, 1.38, 0.42, -0.35, 0, 0, 1, 1, 0.6) });
    b.add(sph, { color: coral, matrix: mat(0, 0.86, 1.33, 0, 0, 0, 0.16, 0.15, 0.08) });
    for (const side of [1, -1]) {
      b.add(new THREE.CircleGeometry(0.16, 16), { color: cream, matrix: mat(side * 0.64, 0.92, 0.3, 0, side * Math.PI / 2, 0) });
      b.add(new THREE.CircleGeometry(0.09, 16), { color: coral, matrix: mat(side * 0.645, 0.92, 0.3, 0, side * Math.PI / 2, 0) });
    }
    // rotor mast (a slim tripod) and hub
    for (const [x, z] of [[0, -0.42], [0.14, -0.15], [-0.14, -0.15]]) {
      const top = new THREE.Vector3(0, 2.5, -0.38), foot = new THREE.Vector3(x, 1.2, z - 0.05);
      const d = top.clone().sub(foot);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
      b.add(new THREE.CylinderGeometry(0.03, 0.035, d.length(), 6), { color: INK, matrix: new THREE.Matrix4().compose(foot.clone().addScaledVector(d, 0.5), q, new THREE.Vector3(1, 1, 1)) });
    }
    b.add(new THREE.CylinderGeometry(0.07, 0.09, 0.14, 10), { color: CHROME, matrix: mat(0, 2.52, -0.38) });
    // engine + tail boom (under the prop disc) + twin-finned tail
    b.add(new THREE.CylinderGeometry(0.2, 0.24, 0.42, 12), { color: CHROME, matrix: mat(0, 1.08, -0.95, Math.PI / 2, 0, 0) });
    b.add(new THREE.CylinderGeometry(0.06, 0.06, 0.1, 8), { color: INK, matrix: mat(0, 1.08, -1.2, Math.PI / 2, 0, 0) });
    {
      const a = new THREE.Vector3(0, 0.45, -0.7), c = new THREE.Vector3(0, 0.78, -2.55);
      const d = c.clone().sub(a);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
      b.add(new THREE.CylinderGeometry(0.045, 0.07, d.length(), 8), { color: paint, matrix: new THREE.Matrix4().compose(a.clone().addScaledVector(d, 0.5), q, new THREE.Vector3(1, 1, 1)) });
    }
    b.add(new THREE.BoxGeometry(1.3, 0.04, 0.34), { color: paint, matrix: mat(0, 0.8, -2.5) });
    for (const side of [1, -1]) {
      b.add(new THREE.BoxGeometry(0.04, 0.5, 0.4), {
        matrix: mat(side * 0.64, 0.98, -2.52),
        colorFn: (p, _n, c) => { c.copy(p.y > 1.12 ? coral : p.y > 0.98 ? cream : coral); },
      });
    }
    // landing gear: struts to three fat little tyres
    const strut = (x: number, z: number, top: THREE.Vector3) => {
      const foot = new THREE.Vector3(x, 0.2, z);
      const d = top.clone().sub(foot);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
      b.add(new THREE.CylinderGeometry(0.025, 0.025, d.length(), 6), { color: INK, matrix: new THREE.Matrix4().compose(foot.clone().addScaledVector(d, 0.5), q, new THREE.Vector3(1, 1, 1)) });
    };
    strut(0.72, -0.2, new THREE.Vector3(0.3, 0.55, 0.05));
    strut(0.72, -0.2, new THREE.Vector3(0.3, 0.5, -0.45));
    strut(-0.72, -0.2, new THREE.Vector3(-0.3, 0.55, 0.05));
    strut(-0.72, -0.2, new THREE.Vector3(-0.3, 0.5, -0.45));
    strut(0, 1.02, new THREE.Vector3(0, 0.5, 0.95));
    const body = toonMesh(b.build());
    this.tilt.add(body);

    const wb = new MeshBuilder();
    wb.add(new THREE.TorusGeometry(0.14, 0.065, 8, 16), { color: 0x2f2a33, matrix: mat(0, 0, 0, 0, Math.PI / 2, 0) });
    wb.add(new THREE.CylinderGeometry(0.09, 0.09, 0.1, 10), { color: cream, matrix: mat(0, 0, 0, 0, 0, Math.PI / 2) });
    const wheelGeo = wb.build();
    const wheelMat = makeToonMaterial({ vertexColors: true });
    for (const [x, z] of [[0.72, -0.2], [-0.72, -0.2], [0, 1.02]]) {
      const w = new THREE.Mesh(wheelGeo, wheelMat);
      w.position.set(x, 0.2, z);
      w.castShadow = true;
      this.tilt.add(w);
      this.wheels.push(w);
    }

    // rotor: two long cream blades with coral tips, drooping a touch
    const rb = new MeshBuilder();
    for (const side of [1, -1]) {
      rb.add(new THREE.BoxGeometry(3.3, 0.035, 0.22), {
        matrix: mat(side * 1.72, 0, 0, 0, 0, side * -0.035),
        colorFn: (p, _n, c) => { c.copy(Math.abs(p.x) > 3.05 ? coral : cream); },
      });
    }
    rb.add(new THREE.CylinderGeometry(0.1, 0.1, 0.08, 10), { color: CHROME });
    this.rotor.add(toonMesh(rb.build()));
    this.rotor.position.set(0, 2.6, -0.38);
    const rotorTilt = new THREE.Group();
    rotorTilt.rotation.x = -0.08;
    rotorTilt.position.copy(this.rotor.position);
    this.rotor.position.set(0, 0, 0);
    rotorTilt.add(this.rotor);
    this.tilt.add(rotorTilt);

    // pusher prop behind the engine (+ a faint disc once it's a blur)
    const pb = new MeshBuilder();
    for (const side of [1, -1]) pb.add(new THREE.BoxGeometry(0.1, 0.5, 0.03), { color: PALETTE.wood, matrix: mat(0, side * 0.27, 0, 0, 0.3 * side, 0) });
    pb.add(new THREE.ConeGeometry(0.07, 0.14, 10), { color: coral, matrix: mat(0, 0, -0.06, -Math.PI / 2, 0, 0) });
    this.prop.add(toonMesh(pb.build()));
    this.prop.position.set(0, 1.08, -1.28);
    this.tilt.add(this.prop);
    this.propDisc = new THREE.Mesh(new THREE.CircleGeometry(0.55, 24), makeToonMaterial({ color: 0xfff4dc, transparent: true, opacity: 0.25, side: THREE.DoubleSide }));
    this.propDisc.position.set(0, 1.08, -1.28);
    this.propDisc.visible = false;
    this.tilt.add(this.propDisc);

    // control stick: the pilot's hands
    const sb = new MeshBuilder();
    sb.add(new THREE.CylinderGeometry(0.018, 0.022, 0.42, 6), { color: INK, matrix: mat(0, 0.21, 0) });
    sb.add(new THREE.CapsuleGeometry(0.03, 0.2, 2, 6), { color: 0x8a5634, matrix: mat(0, 0.42, 0, 0, 0, Math.PI / 2) });
    this.stick.add(toonMesh(sb.build(), false));
    this.stick.position.set(0, 0.82, 0.45);
    this.gl = anchor("gripL", 0.1, 0.42, 0);
    this.gr = anchor("gripR", -0.1, 0.42, 0);
    this.stick.add(this.gl, this.gr);
    this.tilt.add(this.stick);

    this.seats = { driver: anchor("driver", 0, 0.85, 0.02, 0) };
    this.tilt.add(this.seats.driver);
  }

  update(dtIn: number, s: VehicleState): void {
    const dt = Math.min(dtIn, 0.05);
    const sp = s.speed ?? 0;
    const steer = clamp(s.steer ?? 0, -1, 1);
    const air = !!s.airborne;
    const occ = !!s.occupied;
    this.object.position.set(s.pos.x, s.pos.y, s.pos.z);
    this.object.rotation.set(0, s.yaw, 0);
    // bank into turns in the air, attitude from the sim
    const k = clamp(Math.abs(sp) / 12, 0, 1);
    this.roll = lerp(this.roll, -steer * (air ? 0.55 : 0.06) * k, damp(3, dt));
    this.pitch = lerp(this.pitch, s.pitch ?? 0, damp(6, dt));
    this.tilt.rotation.set(-this.pitch, 0, this.roll, "XZY");
    // the rotor free-wheels: spun up by the airflow, winds down slowly on the ground
    const rotorT = air ? 5.5 + Math.abs(sp) * 0.06 : occ ? 1.5 + Math.abs(sp) * 0.3 : 0;
    this.rotorRate = lerp(this.rotorRate, rotorT, damp(rotorT > this.rotorRate ? 1.2 : 0.35, dt));
    this.rotor.rotation.y += this.rotorRate * Math.PI * 2 * dt;
    const propT = occ ? 9 + Math.max(0, s.throttle ?? 0) * 11 : 0;
    this.propRate = lerp(this.propRate, propT, damp(propT > this.propRate ? 4 : 1, dt));
    this.prop.rotation.z += this.propRate * Math.PI * 2 * dt;
    this.propDisc.visible = this.propRate > 6;
    (this.propDisc.material as THREE.MeshToonMaterial).opacity = clamp((this.propRate - 6) / 14, 0, 1) * 0.3;
    // stick follows the controls; wheels roll on the ground
    this.stick.rotation.set(clamp((s.pitch ?? 0) * -1.2, -0.3, 0.3), 0, -steer * 0.25);
    if (!air) this.wheelSpin += (sp / 0.2) * dt;
    for (const w of this.wheels) w.rotation.x = this.wheelSpin;
    this.object.updateMatrixWorld(true);
    this.gl.getWorldPosition(this.gripL);
    this.gr.getWorldPosition(this.gripR);
    if (!this.fx) { this.wasAir = air; return; }
    if (this.wasAir && !air) this.fx.dust(_v.set(s.pos.x, s.pos.y + 0.1, s.pos.z), 8);
    this.wasAir = air;
    if (!occ) return;
    this.puffT -= dt;
    if (this.puffT > 0) return;
    this.puffT = 0.16 - Math.max(0, s.throttle ?? 0) * 0.08;
    _v.set(0.15, 1.1, -1.0).applyMatrix4(this.tilt.matrixWorld);
    this.fx.dust(_v, 1, 0xeeeaf2);
    // prop wash kicks up dust on the ground run
    if (!air && Math.abs(sp) > 4) this.fx.dust(_w.set(0, 0.05, -1.4).applyMatrix4(this.tilt.matrixWorld), 1);
  }

  dispose(): void {
    disposeTree(this.object);
  }
}

export function createGyrocopter(opts: BoatOptions = {}): VehicleActor {
  return new Gyrocopter(opts.color ?? GYRO_COLORS[0], opts.fx ?? null);
}

export function createVehicle(kind: VehicleKind, opts: { color?: THREE.ColorRepresentation; fx?: PaintFx | null } = {}): VehicleActor {
  switch (kind) {
    case VehicleKind.Jetski: return createJetski(opts);
    case VehicleKind.Speedboat: return createSpeedboat(opts);
    case VehicleKind.Vespa: return createVespa(opts);
    case VehicleKind.Gyrocopter: return createGyrocopter(opts);
  }
}
