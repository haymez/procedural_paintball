// Vehicles: rowboat, gondola, Vespa. Each is a small Group with 1–4 draw calls,
// seat anchors (put a blob on them with `state.seat`), hand grip anchors, and
// simple procedural animation (boat bob + oar strokes, wheel spin + lean).
//
// Local frame: +Z = forward (bow / headlight), +Y up, origin on the water line
// (boats) or the ground (Vespa). pos = that origin in world space.
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
  /** Boats: is someone pulling the oars? (defaults to |speed| > 0.3) */
  rowing?: boolean;
  /** Vespa: throttle 0..1 for exhaust puffs. */
  throttle?: number;
  occupied?: boolean;
  /** Water surface height for boats (defaults to pos.y). */
  waterY?: number;
}

export interface VehicleActor {
  readonly kind: VehicleKind;
  readonly object: THREE.Group;
  /** Seat anchors: pass as BlobState.seat. `driver` always exists. */
  readonly seats: { driver: THREE.Object3D; passenger?: THREE.Object3D; passenger2?: THREE.Object3D };
  /** Blob mode + standing flag to use for the driver. */
  readonly driverMode: BlobMode;
  readonly driverStanding: boolean;
  /** Driver hand targets in world space (oar handles / handlebar grips), refreshed by update(). */
  readonly gripL: THREE.Vector3;
  readonly gripR: THREE.Vector3;
  update(dt: number, state: VehicleState): void;
  dispose(): void;
}

type Hull = { len: number; beam: number; depth: number; sheerBow: number; sheerStern: number; transom: number; pow: number };

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
  out.set(Math.sin(a) * w, sheer - d * Math.pow(Math.cos(a), 0.7) - inset * 0.02, z);
  return out;
}

function hullGeometry(h: Hull, inset: number, uSeg = 20, vSeg = 10): THREE.BufferGeometry {
  const g = new ParametricGeometry((u, v, target) => hullPoint(h, u, v, inset, target), uSeg, vSeg);
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

// ---------------------------------------------------------------------------
// Boats

interface BoatParts {
  hull: Hull;
  body: THREE.Mesh;
  oars: { mesh: THREE.Object3D; pivot: THREE.Vector3; side: number; handle: THREE.Vector3; dir?: THREE.Vector3 }[];
  seats: { driver: THREE.Object3D; passenger?: THREE.Object3D; passenger2?: THREE.Object3D };
  wake: THREE.Mesh;
  standing: boolean;
  /** Raise the hull so its floor sits above the water plane. */
  lift: number;
}

class Boat implements VehicleActor {
  readonly object = new THREE.Group();
  readonly seats: VehicleActor["seats"];
  readonly driverMode: BlobMode = "row";
  readonly driverStanding: boolean;
  readonly gripL = new THREE.Vector3();
  readonly gripR = new THREE.Vector3();
  private rock = new THREE.Group();
  private t = Math.random() * 10;
  private stroke = 0;
  private roll = 0;
  private pitch = 0;
  private sprayT = 0;
  private wakeMat: THREE.ShaderMaterial;

  constructor(readonly kind: VehicleKind, private parts: BoatParts, private fx: PaintFx | null) {
    this.object.add(this.rock);
    this.rock.add(parts.body);
    for (const o of parts.oars) this.rock.add(o.mesh);
    this.seats = parts.seats;
    for (const s of Object.values(parts.seats)) if (s) this.rock.add(s);
    this.driverStanding = parts.standing;
    this.object.add(parts.wake);
    this.wakeMat = parts.wake.material as THREE.ShaderMaterial;
  }

  update(dtIn: number, s: VehicleState): void {
    const dt = Math.min(dtIn, 0.05);
    this.t += dt;
    const sp = s.speed ?? 0;
    const steer = s.steer ?? 0;
    const wy = s.waterY ?? s.pos.y;
    this.object.position.set(s.pos.x, wy, s.pos.z);
    this.object.rotation.set(0, s.yaw, 0);
    // bob on gentle swell, lean out of turns, bow lifts with speed
    const t = this.t;
    this.roll = lerp(this.roll, -steer * Math.abs(sp) * 0.035, damp(3, dt));
    this.pitch = lerp(this.pitch, -clamp(sp * 0.012, -0.05, 0.08), damp(2, dt));
    this.rock.position.y = this.parts.lift + Math.sin(t * 1.3) * 0.035 + Math.sin(t * 2.1 + 1) * 0.015 - (s.occupied ? 0.04 : 0);
    this.rock.rotation.set(this.pitch + Math.sin(t * 1.1) * 0.02, 0, this.roll + Math.sin(t * 0.9 + 2) * 0.03);

    // oar strokes
    const rowing = s.rowing ?? Math.abs(sp) > 0.3;
    if (rowing) this.stroke += dt * (this.parts.standing ? 1.9 : 2.6) * Math.PI * (sp < 0 ? -1 : 1);
    const k = rowing ? 1 : 0;
    this.rock.updateMatrixWorld(true);
    for (const o of this.parts.oars) {
      const ph = this.stroke;
      if (this.parts.standing) {
        // gondola: one long oar sweeping in the forcola, blade trailing aft
        const sweep = Math.sin(ph) * 0.35 * k;
        const dip = (Math.cos(ph) * 0.06 - 0.02) * k;
        o.mesh.rotation.set(0, sweep, 0);
        o.mesh.children[0].rotation.set(dip, 0, 0);
      } else {
        // rowboat: blades feather out of the water on the recovery
        const sweep = (Math.sin(ph) * 0.5) * k - 0.1;
        const drive = Math.cos(ph) > 0 ? 1 : 0;
        const lift = k ? lerp(0.22, -0.02, drive * Math.min(1, Math.abs(Math.cos(ph)) * 3)) : 0.35;
        o.mesh.rotation.set(0, sweep * o.side, 0);
        o.mesh.children[0].rotation.set(0, 0, lift * o.side);
      }
    }
    this.rock.updateMatrixWorld(true);
    // grips: oar handles in world space
    const oars = this.parts.oars;
    if (this.parts.standing) {
      const o = oars[0];
      o.mesh.children[0].localToWorld(this.gripR.copy(o.handle));
      o.mesh.children[0].localToWorld(this.gripL.copy(o.handle).addScaledVector(o.dir ?? _v.set(0, 0, 1), 0.45));
    } else {
      // rower faces the stern, so the starboard (-X) oar is in the LEFT hand
      for (const o of oars) o.mesh.children[0].localToWorld((o.side < 0 ? this.gripL : this.gripR).copy(o.handle));
    }

    // wake + spray
    const wk = clamp(Math.abs(sp) / 4, 0, 1);
    this.wakeMat.uniforms.uAmt.value = lerp(this.wakeMat.uniforms.uAmt.value, wk, damp(3, dt));
    this.wakeMat.uniforms.uTime.value = t * (0.6 + wk);
    this.parts.wake.visible = this.wakeMat.uniforms.uAmt.value > 0.02;
    if (this.fx && Math.abs(sp) > 1.5) {
      this.sprayT -= dt;
      if (this.sprayT <= 0) {
        this.sprayT = 0.08;
        const L = this.parts.hull.len;
        for (const side of [1, -1]) {
          _v.set(side * 0.25, 0.05, L * 0.42).applyMatrix4(this.object.matrixWorld);
          const fwdX = Math.sin(s.yaw), fwdZ = Math.cos(s.yaw);
          const sx = Math.cos(s.yaw) * side, sz = -Math.sin(s.yaw) * side;
          this.fx.spray(_v, { x: sx * 1.2 + fwdX * sp * 0.4, y: 1 + Math.abs(sp) * 0.15, z: sz * 1.2 + fwdZ * sp * 0.4 }, 2);
        }
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

/** V-shaped foam wake trailing from the stern. */
function makeWake(len: number, spread: number, stern: number): THREE.Mesh {
  const b = new THREE.BufferGeometry();
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  const segs = 10;
  for (const side of [1, -1]) {
    const base = pos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const z = stern - t * len;
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
  /** Hull paint color (rowboat). */
  color?: THREE.ColorRepresentation;
  fx?: PaintFx | null;
}

export function createRowboat(opts: BoatOptions = {}): VehicleActor {
  const hull: Hull = { len: 3.6, beam: 1.35, depth: 0.5, sheerBow: 0.2, sheerStern: 0.1, transom: 0.45, pow: 2 };
  const paint = new THREE.Color(opts.color ?? 0x3fa7b5);
  const stripe = new THREE.Color(0xfff4dc);
  const bottom = new THREE.Color(0xc0513a);
  const b = new MeshBuilder();
  const outer = hullGeometry(hull, 0);
  b.add(outer, {
    colorFn: (p, _n, c) => {
      const top = hullPoint(hull, p.z / hull.len + 0.5, 0, 0, _v).y;
      const dy = top - p.y;
      c.copy(dy < 0.08 ? stripe : dy < 0.32 ? paint : bottom);
    },
  });
  const inner = hullGeometry(hull, 0.07);
  b.add(inner, { color: PALETTE.wood, flip: true });
  b.add(rimGeometry(hull, 0.045), { color: PALETTE.woodDark });
  // thwarts (seats) + floor boards
  const plank = new THREE.BoxGeometry(1, 1, 1);
  const thwart = (z: number, y: number) => {
    const w = hullPoint(hull, z / hull.len + 0.5, 0, 0.06, _v).x * 2;
    b.add(plank, { color: PALETTE.wood, matrix: mat(0, y, z, 0, 0, 0, Math.abs(w), 0.05, 0.28) });
  };
  thwart(-0.15, 0.1);
  thwart(0.95, 0.12);
  thwart(-1.25, 0.14);
  b.add(plank, { color: PALETTE.woodDark, matrix: mat(0, -0.3, 0, 0, 0, 0, 0.6, 0.03, 2.6) });
  // oarlocks
  const lock = new THREE.TorusGeometry(0.05, 0.015, 4, 8);
  for (const side of [1, -1]) {
    const w = hullPoint(hull, 0.05 / hull.len + 0.5, 0, 0, _v);
    b.add(lock, { color: 0x6b6f78, matrix: mat(side * Math.abs(w.x), w.y + 0.06, 0.05, 0, Math.PI / 2, 0) });
  }
  // little bow name plate / eye
  b.add(new THREE.CircleGeometry(0.07, 10), { color: 0xfff4dc, matrix: mat(0.32, 0.22, 1.42, 0, 0.9, 0) });
  b.add(new THREE.CircleGeometry(0.07, 10), { color: 0xfff4dc, matrix: mat(-0.32, 0.22, 1.42, 0, -0.9, 0) });
  const body = toonMesh(b.build());

  // oars: pivot at the oarlocks; inner group gets the feather/dip rotation
  const oars: BoatParts["oars"] = [];
  const oarGeo = (() => {
    const ob = new MeshBuilder();
    ob.add(new THREE.CylinderGeometry(0.028, 0.028, 2.3, 6), { color: PALETTE.wood, matrix: mat(0.55, 0, 0, 0, 0, Math.PI / 2) });
    ob.add(new THREE.BoxGeometry(0.5, 0.03, 0.16), { color: paint, matrix: mat(1.55, 0, 0) });
    ob.add(new THREE.CapsuleGeometry(0.035, 0.14, 2, 6), { color: PALETTE.woodDark, matrix: mat(-0.52, 0, 0, 0, 0, Math.PI / 2) });
    return ob.build();
  })();
  const oarMat = makeToonMaterial({ vertexColors: true });
  for (const side of [1, -1]) {
    const w = hullPoint(hull, 0.05 / hull.len + 0.5, 0, 0, new THREE.Vector3());
    const pivot = new THREE.Vector3(side * Math.abs(w.x), w.y + 0.08, 0.05);
    const outerG = new THREE.Group();
    outerG.position.copy(pivot);
    const innerG = new THREE.Group();
    const m = new THREE.Mesh(oarGeo, oarMat);
    m.castShadow = true;
    if (side < 0) m.rotation.y = Math.PI;
    innerG.add(m);
    outerG.add(innerG);
    oars.push({ mesh: outerG, pivot, side, handle: new THREE.Vector3(-0.55 * side, 0, 0) });
  }
  const seats = {
    // rower faces the stern (classic rowing), passengers face the bow
    driver: anchor("driver", 0, 0.125, -0.15, Math.PI),
    passenger: anchor("passenger", 0, 0.165, -1.25, 0),
    passenger2: anchor("passenger2", 0, 0.145, 0.95, Math.PI),
  };
  return new Boat(VehicleKind.Rowboat, { hull, body, oars, seats, wake: makeWake(4, 1.4, -1.7), standing: false, lift: 0.3 }, opts.fx ?? null);
}

export function createGondola(opts: BoatOptions = {}): VehicleActor {
  const hull: Hull = { len: 6.4, beam: 1.25, depth: 0.5, sheerBow: 0.75, sheerStern: 0.55, transom: 0.0, pow: 4 };
  const black = new THREE.Color(0x221e2a);
  const trim = new THREE.Color(0xd9b56a);
  const b = new MeshBuilder();
  b.add(hullGeometry(hull, 0, 28, 10), {
    colorFn: (p, _n, c) => {
      const top = hullPoint(hull, p.z / hull.len + 0.5, 0, 0, _v).y;
      c.copy(top - p.y < 0.035 ? trim : black);
    },
  });
  b.add(hullGeometry(hull, 0.06, 28, 10), { color: 0x3a2a24, flip: true });
  b.add(rimGeometry(hull, 0.035), { color: 0x2c2733 });
  const box = new THREE.BoxGeometry(1, 1, 1);
  // deck boards front and back, stern platform for the gondolier
  b.add(box, { color: PALETTE.woodDark, matrix: mat(0, 0.12, 2.3, 0, 0, 0, 0.55, 0.04, 1.2) });
  b.add(box, { color: PALETTE.woodDark, matrix: mat(0, 0.2, -2.4, 0, 0, 0, 0.5, 0.05, 0.9) });
  b.add(box, { color: 0x5b3a2a, matrix: mat(0, -0.26, 0, 0, 0, 0, 0.7, 0.03, 3.6) });
  // passenger bench: red velvet cushion with gold piping + a backrest
  b.add(new THREE.CapsuleGeometry(0.16, 0.5, 3, 8), { color: 0xb8323f, matrix: mat(0, 0.05, -0.55, 0, 0, Math.PI / 2, 1, 1, 1.4) });
  b.add(new THREE.CapsuleGeometry(0.12, 0.55, 3, 8), { color: 0xb8323f, matrix: mat(0, 0.32, -0.85, 0.3, 0, Math.PI / 2, 1, 1, 0.6) });
  b.add(new THREE.TorusGeometry(0.36, 0.02, 4, 16, Math.PI), { color: trim, matrix: mat(0, 0.33, -0.87, -0.3, 0, 0, 1.05, 1, 1) });
  b.add(new THREE.CapsuleGeometry(0.13, 0.35, 3, 8), { color: 0xb8323f, matrix: mat(0, 0.05, 0.75, 0, 0, Math.PI / 2, 1, 1, 1.3) });
  // forcola (oarlock post) on the starboard (right, -X) side near the stern
  b.add(new THREE.CylinderGeometry(0.05, 0.07, 0.5, 6), { color: PALETTE.wood, matrix: mat(-0.5, 0.45, -1.7, 0, 0, 0.1) });
  b.add(new THREE.TorusGeometry(0.07, 0.03, 4, 8, Math.PI * 1.3), { color: PALETTE.wood, matrix: mat(-0.52, 0.72, -1.7, 0, Math.PI / 2, 0) });
  // the ferro: a silver comb on the bow topped by a curling scroll
  const ferro = new THREE.Shape();
  ferro.moveTo(0, 0);
  ferro.lineTo(0.05, 0.62);
  ferro.quadraticCurveTo(0.2, 0.78, 0.4, 0.66);
  ferro.lineTo(0.36, 0.56);
  for (let i = 0; i < 6; i++) {
    const y = 0.5 - i * 0.075;
    ferro.lineTo(0.3, y);
    ferro.lineTo(0.14, y - 0.02);
    ferro.lineTo(0.14, y - 0.045);
  }
  ferro.lineTo(0.1, 0);
  ferro.lineTo(0, 0);
  const fg = new THREE.ExtrudeGeometry(ferro, { depth: 0.03, bevelEnabled: false, curveSegments: 4 });
  fg.translate(0, 0, -0.015);
  const bowTop = hullPoint(hull, 0.985, 0.5, 0, new THREE.Vector3());
  b.add(fg, { color: 0xe6e9ef, matrix: mat(0, bowTop.y + 0.02, bowTop.z - 0.12, 0, -Math.PI / 2, 0) });
  // curled prow scroll (brass)
  const curl: THREE.Vector3[] = [];
  for (let i = 0; i <= 24; i++) {
    const a = (i / 24) * Math.PI * 2.4;
    const r = 0.2 * (1 - i / 30);
    curl.push(new THREE.Vector3(0, bowTop.y + 0.66 + Math.sin(a) * r, bowTop.z + 0.22 + (1 - Math.cos(a)) * r * -1 + 0.2));
  }
  b.add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(curl), 30, 0.028, 5), { color: trim });
  // stern curl
  const scurl: THREE.Vector3[] = [];
  const sternTop = hullPoint(hull, 0.015, 0.5, 0, new THREE.Vector3());
  for (let i = 0; i <= 16; i++) {
    const a = (i / 16) * Math.PI * 1.6;
    scurl.push(new THREE.Vector3(0, sternTop.y + Math.sin(a) * 0.14, sternTop.z - 0.02 - (1 - Math.cos(a)) * 0.14 * -1 - 0.1));
  }
  b.add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(scurl), 20, 0.035, 5), { color: 0x2c2733 });
  // brass seahorse-ish side ornaments
  for (const side of [1, -1]) {
    b.add(new THREE.SphereGeometry(0.07, 8, 6), { color: trim, matrix: mat(side * 0.5, 0.32, -0.3) });
    b.add(new THREE.ConeGeometry(0.05, 0.22, 6), { color: trim, matrix: mat(side * 0.5, 0.45, -0.3) });
  }
  const body = toonMesh(b.build());

  // long single oar in the forcola, blade trailing aft into the water
  // oar: from the gondolier's hands, through the forcola, forward-down into the water
  const H = new THREE.Vector3(0.3, 0.22, -0.65), T = new THREE.Vector3(-0.55, -1.0, 2.3);
  const od = T.clone().sub(H);
  const olen = od.length();
  od.normalize();
  const oq = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), od);
  const ob = new MeshBuilder();
  ob.add(new THREE.CylinderGeometry(0.03, 0.03, olen, 6), { color: PALETTE.wood, matrix: new THREE.Matrix4().compose(H.clone().addScaledVector(od, olen / 2), oq, new THREE.Vector3(1, 1, 1)) });
  ob.add(new THREE.BoxGeometry(0.04, 0.7, 0.2), { color: PALETTE.wood, matrix: new THREE.Matrix4().compose(T.clone().addScaledVector(od, -0.3), oq, new THREE.Vector3(1, 1, 1)) });
  const oarMesh = new THREE.Mesh(ob.build(), makeToonMaterial({ vertexColors: true }));
  oarMesh.castShadow = true;
  const outerG = new THREE.Group();
  outerG.position.set(-0.55, 0.78, -1.7);
  const innerG = new THREE.Group();
  innerG.add(oarMesh);
  outerG.add(innerG);
  // handle: the oar runs forward-up from the forcola toward the gondolier's hands
  const handle = H.clone().addScaledVector(od, 0.05);
  const seats = {
    driver: anchor("driver", 0, 0.225, -2.45, 0),
    passenger: anchor("passenger", 0, 0.2, -0.55, 0),
    passenger2: anchor("passenger2", 0, 0.18, 0.75, Math.PI),
  };
  return new Boat(VehicleKind.Gondola, { hull, body, oars: [{ mesh: outerG, pivot: outerG.position.clone(), side: -1, handle, dir: od.clone() }], seats, wake: makeWake(6, 1.8, -3.0), standing: true, lift: 0.3 }, opts.fx ?? null);
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

export function createVehicle(kind: VehicleKind, opts: { color?: THREE.ColorRepresentation; fx?: PaintFx | null } = {}): VehicleActor {
  switch (kind) {
    case VehicleKind.Rowboat: return createRowboat(opts);
    case VehicleKind.Gondola: return createGondola(opts);
    case VehicleKind.Vespa: return createVespa(opts);
  }
}
