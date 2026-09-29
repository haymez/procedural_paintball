// Chunky toy paintball marker. Local frame: origin at the rear (trigger) grip,
// +Z toward the muzzle, +Y up (hopper on top). ~0.7 m long.
import * as THREE from "three";
import { MeshBuilder, mat, type PartOpts } from "./builder";
import { makeToonMaterial } from "../style";

export const MARKER_GRIP_R = new THREE.Vector3(0, -0.085, 0.0);
export const MARKER_GRIP_L = new THREE.Vector3(0, -0.075, 0.2);
export const MARKER_MUZZLE = new THREE.Vector3(0, 0.03, 0.52);

/** Marker body tint derived from a player color: richer + a bit darker. */
export function markerTint(color: THREE.ColorRepresentation): THREE.Color {
  const c = new THREE.Color(color);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  return new THREE.Color().setHSL(hsl.h, Math.min(1, hsl.s * 1.1 + 0.2), Math.max(0.3, hsl.l - 0.18));
}

/** Bake a marker into a builder (used by the blob so it costs no extra draw call). */
export function addMarker(b: MeshBuilder, color: THREE.ColorRepresentation, base: Omit<PartOpts, "color" | "matrix">, root?: THREE.Matrix4): void {
  const body = markerTint(color);
  const light = new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.45);
  const dark = 0x3b3440;
  const cream = 0xfff4dc;
  const at = (m: THREE.Matrix4) => (root ? root.clone().multiply(m) : m);
  const add = (g: THREE.BufferGeometry, c: THREE.ColorRepresentation, m: THREE.Matrix4) => {
    b.add(g, { ...base, color: c, matrix: at(m) });
    g.dispose();
  };
  // receiver: fat rounded capsule
  add(new THREE.CapsuleGeometry(0.056, 0.2, 3, 8), body, mat(0, 0.015, 0.1, Math.PI / 2, 0, 0, 0.85, 1, 1.15));
  // cream stripe band on the receiver
  add(new THREE.CylinderGeometry(0.052, 0.052, 0.035, 8, 1), cream, mat(0, 0.015, 0.2, Math.PI / 2, 0, 0, 1, 1, 1.2));
  // barrel
  add(new THREE.CylinderGeometry(0.023, 0.026, 0.3, 8, 1, true), dark, mat(0, 0.03, 0.36, Math.PI / 2));
  // muzzle ring (colored lip)
  add(new THREE.CylinderGeometry(0.036, 0.034, 0.05, 8, 1), light, mat(0, 0.03, 0.5, Math.PI / 2));
  // hopper neck + bulb + lid
  add(new THREE.CylinderGeometry(0.024, 0.03, 0.06, 6, 1, true), dark, mat(0, 0.085, 0.07));
  add(new THREE.SphereGeometry(0.09, 10, 7), light, mat(0, 0.155, 0.05, 0, 0, 0, 0.95, 0.85, 1.25));
  add(new THREE.CylinderGeometry(0.035, 0.04, 0.025, 8, 1), body, mat(0, 0.23, 0.04));
  // grip + trigger guard
  add(new THREE.BoxGeometry(0.042, 0.11, 0.05), dark, mat(0, -0.06, -0.005, -0.25));
  add(new THREE.TorusGeometry(0.026, 0.007, 4, 8, Math.PI), dark, mat(0, -0.04, 0.05, 0, Math.PI / 2, Math.PI));
  // foregrip
  add(new THREE.CylinderGeometry(0.02, 0.024, 0.08, 6, 1), dark, mat(0, -0.04, 0.2));
  // air tank (stock)
  add(new THREE.CapsuleGeometry(0.037, 0.16, 2, 8), 0xd7ebe6, mat(0, 0.0, -0.14, Math.PI / 2));
  add(new THREE.CylinderGeometry(0.039, 0.039, 0.03, 8, 1), body, mat(0, 0.0, -0.06, Math.PI / 2));
}

/** Standalone marker mesh (showcase, pickups, dropped weapons). */
export function createMarkerMesh(color: THREE.ColorRepresentation): THREE.Mesh {
  const b = new MeshBuilder();
  addMarker(b, color, {});
  const mesh = new THREE.Mesh(b.build(), makeToonMaterial({ vertexColors: true }));
  mesh.castShadow = true;
  return mesh;
}

/**
 * Muzzle puff: three little toon cloud balls that pop out and vanish in ~0.16 s.
 * Parent it to the gun (local +Z = barrel) and set `base` to the muzzle.
 */
export class MuzzlePuff {
  readonly mesh: THREE.Mesh;
  readonly base = MARKER_MUZZLE.clone();
  private t = 1;
  private mat: THREE.MeshToonMaterial;
  constructor() {
    const b = new MeshBuilder();
    const ball = new THREE.IcosahedronGeometry(0.05, 0);
    b.add(ball, { matrix: mat(0, 0, 0.02) });
    b.add(ball, { matrix: mat(0.035, 0.02, 0.07, 0, 0, 0, 0.7) });
    b.add(ball, { matrix: mat(-0.03, 0.015, 0.1, 0, 0, 0, 0.55) });
    ball.dispose();
    this.mat = makeToonMaterial({ vertexColors: true, color: 0xffffff });
    this.mesh = new THREE.Mesh(b.build(), this.mat);
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
  }
  fire(color: THREE.ColorRepresentation): void {
    this.t = 0;
    this.mat.color.set(color).lerp(_white, 0.55);
    this.mesh.rotation.z = Math.random() * Math.PI * 2;
  }
  update(dt: number): void {
    this.t += dt;
    const k = this.t / 0.16;
    if (k >= 1) {
      this.mesh.visible = false;
      return;
    }
    this.mesh.visible = true;
    const s = k < 0.3 ? (k / 0.3) * 1.4 : 1.4 * (1 - (k - 0.3) / 0.7);
    this.mesh.position.copy(this.base);
    this.mesh.position.z += 0.02 + k * 0.12;
    this.mesh.scale.setScalar(Math.max(0.001, s));
  }
  dispose(): void {
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}
const _white = new THREE.Color(0xffffff);
