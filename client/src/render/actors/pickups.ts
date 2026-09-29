// Pickups: an ammo cache (crate of paint pods) and one little toy per upgrade,
// floating + spinning above a soft glowing ring with a faint beacon beam that
// reads from range. 2 draw calls per pickup (item + beacon).
import * as THREE from "three";
import { MeshBuilder, mat, clamp, Spring } from "./builder";
import { makeToonMaterial, PALETTE } from "../style";
import { PickupKind } from "../../../../shared/world/types";
import { addMarker } from "./marker";
import type { PaintFx } from "./paintFx";

export const PICKUP_COLORS: Record<PickupKind, number> = {
  [PickupKind.Ammo]: 0xff9e6b,
  [PickupKind.BigHopper]: 0xffd84a,
  [PickupKind.RapidFire]: 0xff6a4d,
  [PickupKind.LongBarrel]: 0x5fa8ff,
  [PickupKind.Scope]: 0xb07cff,
  [PickupKind.Vest]: 0xff8a2a,
  [PickupKind.QuickFeet]: 0x6fdc7a,
  [PickupKind.Snorkel]: 0x3fd6d0,
};

export interface PickupActor {
  readonly kind: PickupKind;
  readonly object: THREE.Group;
  readonly active: boolean;
  /** camPos lets the beacon fade out when you're standing next to it. */
  update(dt: number, camPos?: THREE.Vector3): void;
  /** Play the collect animation (sparkles via fx), then hide until respawn(). */
  collect(fx?: PaintFx | null): void;
  /** Pop back in. */
  respawn(): void;
  dispose(): void;
}

const POD_COLORS = [0xff9eb5, 0x8fe0c0, 0xb9a4f5, 0xffc48a, 0x8cc8ff, 0xfff08a, 0xff8f80, 0x7fd8d8];

function itemGeometry(kind: PickupKind): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const sph = new THREE.SphereGeometry(1, 12, 9);
  const box = new THREE.BoxGeometry(1, 1, 1);
  const c = PICKUP_COLORS[kind];
  switch (kind) {
    case PickupKind.Ammo: {
      // wooden crate, open top, heaped with colourful paint pods
      const w = PALETTE.wood, d = PALETTE.woodDark;
      b.add(box, { color: w, matrix: mat(0, 0.25, 0, 0, 0, 0, 0.9, 0.5, 0.65) });
      for (const sx of [1, -1]) for (const sz of [1, -1]) b.add(box, { color: d, matrix: mat(sx * 0.45, 0.25, sz * 0.325, 0, 0, 0, 0.07, 0.52, 0.07) });
      for (const y of [0.04, 0.48]) {
        b.add(box, { color: d, matrix: mat(0, y, 0.33, 0, 0, 0, 0.92, 0.06, 0.03) });
        b.add(box, { color: d, matrix: mat(0, y, -0.33, 0, 0, 0, 0.92, 0.06, 0.03) });
      }
      // painted splat on the side
      b.add(new THREE.CircleGeometry(0.13, 9), { color: 0xff6a8a, matrix: mat(0.12, 0.26, 0.336) });
      b.add(new THREE.CircleGeometry(0.05, 7), { color: 0xff6a8a, matrix: mat(0.3, 0.36, 0.336) });
      b.add(new THREE.CircleGeometry(0.035, 7), { color: 0xff6a8a, matrix: mat(-0.05, 0.1, 0.336) });
      let i = 0;
      for (let x = -0.33; x <= 0.34; x += 0.165)
        for (let z = -0.2; z <= 0.21; z += 0.165) {
          const h = 0.52 + 0.05 * Math.sin(i * 2.3) + (Math.abs(x) < 0.2 && Math.abs(z) < 0.1 ? 0.07 : 0);
          b.add(new THREE.SphereGeometry(0.085, 8, 6), { color: POD_COLORS[i++ % POD_COLORS.length], matrix: mat(x, h, z) });
        }
      break;
    }
    case PickupKind.BigHopper: {
      // a huge hopper bucket overflowing with balls
      b.add(new THREE.CylinderGeometry(0.28, 0.2, 0.42, 14, 1, true), { color: c, matrix: mat(0, 0, 0) });
      b.add(new THREE.CylinderGeometry(0.2, 0.2, 0.02, 14), { color: c, matrix: mat(0, -0.21, 0) });
      b.add(new THREE.TorusGeometry(0.28, 0.035, 6, 16), { color: 0xfff4dc, matrix: mat(0, 0.21, 0, Math.PI / 2, 0, 0) });
      b.add(new THREE.CylinderGeometry(0.2, 0.2, 0.02, 14), { color: 0xfff4dc, matrix: mat(0, -0.05, 0, 0, 0, 0, 1.2, 1, 1.2), flip: false });
      for (let i = 0; i < 9; i++) {
        const a = i * 2.4, r = i === 0 ? 0 : 0.15;
        b.add(sph, { color: POD_COLORS[i % POD_COLORS.length], matrix: mat(Math.cos(a) * r, 0.22 + (i === 0 ? 0.1 : 0.02), Math.sin(a) * r, 0, 0, 0, 0.085) });
      }
      break;
    }
    case PickupKind.RapidFire: {
      // chunky lightning bolt
      const s = new THREE.Shape();
      s.moveTo(0.06, 0.4); s.lineTo(-0.2, -0.02); s.lineTo(-0.02, -0.02); s.lineTo(-0.1, -0.4);
      s.lineTo(0.2, 0.06); s.lineTo(0.02, 0.06); s.lineTo(0.14, 0.4); s.lineTo(0.06, 0.4);
      const g = new THREE.ExtrudeGeometry(s, { depth: 0.1, bevelEnabled: true, bevelSize: 0.03, bevelThickness: 0.03, bevelSegments: 1 });
      g.translate(0, 0, -0.05);
      b.add(g, { color: c });
      // speed lines
      for (let i = 0; i < 3; i++) b.add(new THREE.CapsuleGeometry(0.018, 0.14 + i * 0.03, 2, 4), { color: 0xfff4dc, matrix: mat(-0.28, 0.12 - i * 0.12, 0, 0, 0, Math.PI / 2) });
      break;
    }
    case PickupKind.LongBarrel: {
      b.add(new THREE.CylinderGeometry(0.045, 0.05, 0.9, 10), { color: 0x4a4550, matrix: mat(0, 0, 0, 0, 0, 0.9) });
      for (const t of [-0.35, -0.1, 0.15]) b.add(new THREE.CylinderGeometry(0.062, 0.062, 0.04, 10), { color: c, matrix: mat(-Math.sin(0.9) * t * -1, Math.cos(0.9) * t, 0, 0, 0, 0.9) });
      b.add(new THREE.CylinderGeometry(0.08, 0.07, 0.1, 10), { color: c, matrix: mat(-Math.sin(0.9) * 0.45, Math.cos(0.9) * 0.45, 0, 0, 0, 0.9) });
      break;
    }
    case PickupKind.Scope: {
      b.add(new THREE.CylinderGeometry(0.06, 0.06, 0.4, 12), { color: 0x3b3440, matrix: mat(0, 0, 0, Math.PI / 2, 0, 0) });
      b.add(new THREE.CylinderGeometry(0.1, 0.07, 0.12, 12), { color: c, matrix: mat(0, 0, 0.24, Math.PI / 2, 0, 0) });
      b.add(new THREE.CylinderGeometry(0.075, 0.09, 0.1, 12), { color: c, matrix: mat(0, 0, -0.22, Math.PI / 2, 0, 0) });
      b.add(new THREE.CircleGeometry(0.085, 12), { color: 0x9fe6ff, matrix: mat(0, 0, 0.301) });
      b.add(new THREE.CircleGeometry(0.03, 8), { color: 0xffffff, matrix: mat(0.03, 0.03, 0.303) });
      b.add(new THREE.CylinderGeometry(0.035, 0.035, 0.08, 8), { color: c, matrix: mat(0, 0.09, 0) });
      b.add(box, { color: 0x3b3440, matrix: mat(0, -0.08, 0, 0, 0, 0, 0.06, 0.05, 0.22) });
      break;
    }
    case PickupKind.Vest: {
      // puffy orange life vest with cream stripes
      for (const side of [1, -1]) {
        b.add(new THREE.CapsuleGeometry(0.13, 0.28, 3, 10), { color: c, matrix: mat(side * 0.13, 0, 0.04, 0, 0, side * 0.08, 1, 1, 0.6) });
        b.add(new THREE.CylinderGeometry(0.135, 0.135, 0.04, 10, 1, true), { color: 0xfff4dc, matrix: mat(side * 0.13, 0.05, 0.04, 0, 0, side * 0.08, 1, 1, 0.62) });
        b.add(new THREE.TorusGeometry(0.07, 0.035, 5, 8, Math.PI), { color: c, matrix: mat(side * 0.12, 0.26, -0.02, 0, Math.PI / 2, 0) });
      }
      b.add(new THREE.CapsuleGeometry(0.15, 0.2, 3, 10), { color: 0xe06a1a, matrix: mat(0, 0.0, -0.1, 0, 0, Math.PI / 2, 1, 1.3, 0.5) });
      b.add(box, { color: 0x3b3440, matrix: mat(0, -0.05, 0.12, 0, 0, 0, 0.08, 0.05, 0.03) });
      break;
    }
    case PickupKind.QuickFeet: {
      // a sneaker with little wings
      b.add(new THREE.CapsuleGeometry(0.1, 0.26, 3, 10), { color: 0xfff4dc, matrix: mat(0, -0.1, 0, Math.PI / 2, 0, 0, 1.1, 1, 0.45) });
      b.add(new THREE.CapsuleGeometry(0.11, 0.18, 3, 10), { color: c, matrix: mat(0, 0.0, -0.03, Math.PI / 2, 0, 0, 1, 1, 0.9) });
      b.add(new THREE.CylinderGeometry(0.09, 0.1, 0.14, 10), { color: c, matrix: mat(0, 0.1, -0.1) });
      b.add(new THREE.TorusGeometry(0.08, 0.018, 4, 10), { color: 0xfff4dc, matrix: mat(0, 0.17, -0.1, Math.PI / 2, 0, 0) });
      for (const side of [1, -1]) {
        const wing = new THREE.Shape();
        wing.moveTo(0, 0); wing.quadraticCurveTo(0.1, 0.22, 0.3, 0.26); wing.quadraticCurveTo(0.22, 0.16, 0.26, 0.12);
        wing.quadraticCurveTo(0.16, 0.08, 0.2, 0.02); wing.quadraticCurveTo(0.1, 0.02, 0, 0);
        const g = new THREE.ExtrudeGeometry(wing, { depth: 0.02, bevelEnabled: false, curveSegments: 4 });
        b.add(g, { color: 0xffffff, matrix: mat(side * 0.1, 0.05, -0.12, 0, side > 0 ? -Math.PI / 2 - 0.4 : Math.PI / 2 + 0.4, 0) });
      }
      break;
    }
    case PickupKind.Snorkel: {
      // mask + J snorkel
      b.add(new THREE.TorusGeometry(0.13, 0.04, 6, 14), { color: c, matrix: mat(0, 0, 0, 0, 0, 0, 1.35, 0.9, 1) });
      b.add(new THREE.CircleGeometry(0.13, 14), { color: 0xaeeaff, matrix: mat(0, 0, -0.005, 0, 0, 0, 1.35, 0.9, 1) });
      b.add(new THREE.CircleGeometry(0.035, 8), { color: 0xffffff, matrix: mat(0.08, 0.04, 0.0) });
      b.add(new THREE.TorusGeometry(0.2, 0.012, 4, 16, Math.PI), { color: 0x3b3440, matrix: mat(0, 0, -0.1, 0, Math.PI / 2, 0, 1, 0.5, 1) });
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(0.24, 0.42, -0.04), new THREE.Vector3(0.25, 0.1, -0.02), new THREE.Vector3(0.24, -0.16, 0.02),
        new THREE.Vector3(0.14, -0.22, 0.08), new THREE.Vector3(0.05, -0.18, 0.1),
      ]);
      b.add(new THREE.TubeGeometry(curve, 16, 0.03, 6), { color: 0xffd84a });
      b.add(new THREE.CylinderGeometry(0.045, 0.04, 0.05, 8), { color: 0xff6a4d, matrix: mat(0.24, 0.44, -0.04) });
      break;
    }
  }
  return b.build();
}

const BEACON_VERT = /* glsl */ `
attribute float aExtra;
varying float vKind;
varying vec3 vP;
varying vec3 vN;
varying vec3 vV;
void main() {
  vKind = aExtra;
  vP = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`;
const BEACON_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uTime;
uniform float uAlpha;
uniform float uBeam;
uniform float uHeight;
varying float vKind;
varying vec3 vP;
varying vec3 vN;
varying vec3 vV;
void main() {
  float a;
  if (vKind < 0.5) {
    // beam: bright at the base, fading up, soft cylinder edges, drifting bands
    float h = clamp(vP.y / uHeight, 0.0, 1.0);
    float edge = pow(abs(dot(normalize(vN), normalize(vV))), 1.6);
    float bands = 0.8 + 0.2 * sin(vP.y * 3.0 - uTime * 2.5);
    a = pow(1.0 - h, 1.8) * edge * bands * 0.13 * uBeam;
  } else {
    // ground ring: soft disc with a pulsing ring
    float d = length(vP.xz) / 0.95;
    float pulse = fract(uTime * 0.6);
    float ring = smoothstep(0.1, 0.0, abs(d - pulse)) * (1.0 - pulse);
    a = (smoothstep(1.0, 0.3, d) * 0.12 + smoothstep(0.07, 0.0, abs(d - 0.85)) * 0.4 + ring * 0.35);
  }
  a *= uAlpha;
  if (a < 0.003) discard;
  gl_FragColor = vec4(uColor * uColor * a * 1.3, 1.0);
  #include <colorspace_fragment>
}
`;

function beaconGeometry(height: number, radius: number): THREE.BufferGeometry {
  const b = new MeshBuilder({ extras: true });
  const beam = new THREE.CylinderGeometry(radius * 0.6, radius, height, 12, 1, true);
  beam.translate(0, height / 2, 0);
  b.add(beam, { extra: 0 });
  const disc = new THREE.CircleGeometry(0.95, 24);
  b.add(disc, { extra: 1, matrix: mat(0, 0.03, 0, -Math.PI / 2, 0, 0) });
  return b.build();
}

class Pickup implements PickupActor {
  readonly object = new THREE.Group();
  private item: THREE.Mesh;
  private holder = new THREE.Group();
  private beacon: THREE.Mesh;
  private bmat: THREE.ShaderMaterial;
  private t = Math.random() * 10;
  private state: "idle" | "collecting" | "gone" = "idle";
  private ct = 0;
  private pop = new Spring(200, 10, 1);
  private floatH: number;
  private color: THREE.Color;
  active = true;

  constructor(readonly kind: PickupKind) {
    this.color = new THREE.Color(PICKUP_COLORS[kind]);
    const isAmmo = kind === PickupKind.Ammo;
    this.floatH = isAmmo ? 0 : 1.05;
    this.item = new THREE.Mesh(itemGeometry(kind), makeToonMaterial({ vertexColors: true }));
    this.item.castShadow = true;
    // upgrades are toys ~2x real size so they read from a distance
    this.item.scale.setScalar(isAmmo ? 1 : 1.35);
    this.holder.add(this.item);
    this.object.add(this.holder);
    const H = isAmmo ? 7 : 11;
    this.bmat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: this.color.clone() },
        uTime: { value: 0 },
        uAlpha: { value: 1 },
        uBeam: { value: 1 },
        uHeight: { value: H },
      },
      vertexShader: BEACON_VERT,
      fragmentShader: BEACON_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.beacon = new THREE.Mesh(beaconGeometry(H, isAmmo ? 0.4 : 0.32), this.bmat);
    this.beacon.renderOrder = 2;
    this.object.add(this.beacon);
  }

  update(dtIn: number, camPos?: THREE.Vector3): void {
    const dt = Math.min(dtIn, 0.05);
    this.t += dt;
    const t = this.t;
    this.pop.step(dt);
    const isAmmo = this.kind === PickupKind.Ammo;
    let s = Math.max(0.001, this.pop.x);
    let y = this.floatH + (isAmmo ? 0 : Math.sin(t * 2) * 0.09);
    let spin = isAmmo ? 0 : t * 1.1;
    if (this.state === "collecting") {
      this.ct += dt;
      const k = this.ct / 0.45;
      s = k < 0.25 ? 1 + k * 1.6 : Math.max(0.001, 1.4 * (1 - (k - 0.25) / 0.75));
      y += k * 1.1;
      spin += k * 14;
      this.bmat.uniforms.uAlpha.value = Math.max(0, 1 - k);
      if (k >= 1) {
        this.state = "gone";
        this.object.visible = false;
      }
    }
    this.holder.position.y = y;
    this.holder.rotation.y = spin;
    // ammo crate: a little happy wobble; pods jiggle via squash
    if (isAmmo) {
      const w = Math.sin(t * 3) * 0.03;
      this.holder.rotation.z = w * 0.5;
      this.holder.scale.set(s * (1 - w * 0.3), s * (1 + w), s * (1 - w * 0.3));
    } else this.holder.scale.setScalar(s);
    this.bmat.uniforms.uTime.value = t;
    if (camPos) {
      const d = camPos.distanceTo(this.object.position);
      this.bmat.uniforms.uBeam.value = clamp((d - 6) / 14, 0, 1);
    }
  }

  collect(fx?: PaintFx | null): void {
    if (this.state !== "idle") return;
    this.state = "collecting";
    this.ct = 0;
    this.active = false;
    if (fx) {
      const p = this.object.getWorldPosition(new THREE.Vector3());
      fx.sparkle({ x: p.x, y: p.y + this.floatH + 0.4, z: p.z }, this.color, 14);
      fx.ring({ x: p.x, y: p.y + 0.05, z: p.z }, this.color, 2.2, 0.6);
    }
  }

  respawn(): void {
    this.state = "idle";
    this.active = true;
    this.object.visible = true;
    this.pop.x = 0.01;
    this.pop.v = 0;
    this.pop.target = 1;
    this.bmat.uniforms.uAlpha.value = 1;
  }

  dispose(): void {
    this.object.removeFromParent();
    this.item.geometry.dispose();
    (this.item.material as THREE.Material).dispose();
    this.beacon.geometry.dispose();
    this.bmat.dispose();
  }
}

export function createPickup(kind: PickupKind): PickupActor {
  return new Pickup(kind);
}

/** A dropped marker lying on the ground (e.g. after elimination) — just a mesh. */
export function createDroppedMarker(color: THREE.ColorRepresentation): THREE.Mesh {
  const b = new MeshBuilder();
  addMarker(b, color, {}, mat(0, 0.06, 0, 0, 0, Math.PI / 2));
  const m = new THREE.Mesh(b.build(), makeToonMaterial({ vertexColors: true }));
  m.castShadow = true;
  return m;
}
