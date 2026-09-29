// Zipline: a sagging cable between two anchor points + a pulley with a
// T-handle that slides along it. The cable dips under the rider's weight.
import * as THREE from "three";
import { MeshBuilder, mat, clamp, damp, lerp, Spring } from "./builder";
import { makeToonMaterial } from "../style";
import type { Vec3Like } from "./paintFx";

export interface ZiplineActor {
  readonly object: THREE.Group;
  readonly length: number;
  /** Cable point at parameter t (0 = a, 1 = b), including the current rider dip. */
  pointAt(t: number, out: THREE.Vector3): THREE.Vector3;
  /** Where the rider's hands go: left / right handle ends (world), after update. */
  readonly gripL: THREE.Vector3;
  readonly gripR: THREE.Vector3;
  /** Where to put the rider's `pos` (feet), after update. */
  readonly riderPos: THREE.Vector3;
  /** Rider yaw (facing down the line). */
  readonly yaw: number;
  /**
   * t = pulley position 0..1 (null = parked at the top). `loaded` = someone is hanging on.
   * Call every frame.
   */
  update(dt: number, t: number | null, loaded?: boolean): void;
  dispose(): void;
}

export const ZIP_HANDLE_DROP = 0.32;

class Zip implements ZiplineActor {
  readonly object = new THREE.Group();
  readonly length: number;
  readonly gripL = new THREE.Vector3();
  readonly gripR = new THREE.Vector3();
  readonly riderPos = new THREE.Vector3();
  readonly yaw: number;
  private a: THREE.Vector3;
  private b: THREE.Vector3;
  private sag: number;
  private load = 0;
  private tp = 0.02;
  private cable: THREE.Mesh;
  private pulley: THREE.Group;
  private handle: THREE.Group;
  private swing = new Spring(14, 1.2);
  private prevT = 0.02;
  private vel = 0;
  private SEG = 48;
  private RAD = 5;
  private wheel: THREE.Mesh;

  constructor(a: Vec3Like, b: Vec3Like, sagFrac = 0.03, private hang = 1.95) {
    this.a = new THREE.Vector3(a.x, a.y, a.z);
    this.b = new THREE.Vector3(b.x, b.y, b.z);
    this.length = this.a.distanceTo(this.b);
    this.sag = this.length * sagFrac;
    this.yaw = Math.atan2(this.b.x - this.a.x, this.b.z - this.a.z);

    // cable: a hand-rolled tube so we can re-bend it every frame without allocations
    const n = (this.SEG + 1) * this.RAD;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
    const idx: number[] = [];
    for (let i = 0; i < this.SEG; i++)
      for (let j = 0; j < this.RAD; j++) {
        const a0 = i * this.RAD + j, a1 = i * this.RAD + ((j + 1) % this.RAD);
        const b0 = a0 + this.RAD, b1 = a1 + this.RAD;
        idx.push(a0, b0, a1, a1, b0, b1);
      }
    g.setIndex(idx);
    this.cable = new THREE.Mesh(g, makeToonMaterial({ color: 0x5a4636 }));
    this.cable.frustumCulled = false;
    this.cable.castShadow = true;
    this.object.add(this.cable);

    // end anchors: chunky rings on little brackets
    const eb = new MeshBuilder();
    for (const p of [this.a, this.b]) {
      eb.add(new THREE.TorusGeometry(0.12, 0.04, 6, 10), { color: 0x7d838c, matrix: mat(p.x, p.y, p.z, 0, this.yaw + Math.PI / 2, 0) });
      eb.add(new THREE.SphereGeometry(0.1, 8, 6), { color: 0xc8643c, matrix: mat(p.x, p.y, p.z) });
    }
    const ends = new THREE.Mesh(eb.build(), makeToonMaterial({ vertexColors: true }));
    this.object.add(ends);

    // pulley: wheel in a housing, a drop rod and a T-handle with red grips
    this.pulley = new THREE.Group();
    const pb = new MeshBuilder();
    pb.add(new THREE.BoxGeometry(0.05, 0.2, 0.2), { color: 0xf2c68c, matrix: mat(0.045, -0.04, 0) });
    pb.add(new THREE.BoxGeometry(0.05, 0.2, 0.2), { color: 0xf2c68c, matrix: mat(-0.045, -0.04, 0) });
    pb.add(new THREE.CylinderGeometry(0.02, 0.02, 0.14, 6), { color: 0x7d838c, matrix: mat(0, 0, 0, 0, 0, Math.PI / 2) });
    const pulleyMesh = new THREE.Mesh(pb.build(), makeToonMaterial({ vertexColors: true }));
    pulleyMesh.castShadow = true;
    this.pulley.add(pulleyMesh);
    const wg = new MeshBuilder();
    wg.add(new THREE.CylinderGeometry(0.075, 0.075, 0.04, 10), { color: 0x7d838c, matrix: mat(0, 0, 0, 0, 0, Math.PI / 2) });
    wg.add(new THREE.BoxGeometry(0.045, 0.02, 0.13), { color: 0x3b3440 });
    this.wheel = new THREE.Mesh(wg.build(), makeToonMaterial({ vertexColors: true }));
    this.pulley.add(this.wheel);
    this.handle = new THREE.Group();
    const hb = new MeshBuilder();
    hb.add(new THREE.CylinderGeometry(0.018, 0.018, ZIP_HANDLE_DROP, 6), { color: 0x7d838c, matrix: mat(0, -ZIP_HANDLE_DROP / 2, 0) });
    hb.add(new THREE.CapsuleGeometry(0.025, 0.42, 2, 6), { color: 0x7d838c, matrix: mat(0, -ZIP_HANDLE_DROP, 0, 0, 0, Math.PI / 2) });
    for (const side of [1, -1]) hb.add(new THREE.CapsuleGeometry(0.035, 0.1, 2, 6), { color: 0xe0404a, matrix: mat(side * 0.16, -ZIP_HANDLE_DROP, 0, 0, 0, Math.PI / 2) });
    const handleMesh = new THREE.Mesh(hb.build(), makeToonMaterial({ vertexColors: true }));
    handleMesh.castShadow = true;
    this.handle.add(handleMesh);
    this.pulley.add(this.handle);
    this.object.add(this.pulley);
    this.update(0, null, false);
  }

  pointAt(t: number, out: THREE.Vector3): THREE.Vector3 {
    t = clamp(t, 0, 1);
    out.lerpVectors(this.a, this.b, t);
    const tp = clamp(this.tp, 0.02, 0.98);
    const tri = t < tp ? t / tp : (1 - t) / (1 - tp);
    out.y -= this.sag * 4 * t * (1 - t) + this.load * this.length * 0.035 * tri * Math.sqrt(4 * tp * (1 - tp));
    return out;
  }

  update(dt: number, t: number | null, loaded = false): void {
    const target = t ?? 0.02;
    this.tp = target;
    this.load = lerp(this.load, loaded ? 1 : 0, damp(6, dt || 1));
    // swing the handle with pulley acceleration
    if (dt > 0) {
      const v = ((target - this.prevT) * this.length) / dt;
      const acc = (v - this.vel) / dt;
      this.vel = v;
      this.swing.v += -clamp(acc, -30, 30) * 0.03 * dt;
      this.swing.step(dt);
      this.wheel.rotation.x -= (v / 0.075) * dt;
    }
    this.prevT = target;

    // rebuild cable
    const P = this.cable.geometry.getAttribute("position") as THREE.BufferAttribute;
    const N = this.cable.geometry.getAttribute("normal") as THREE.BufferAttribute;
    const r = 0.022;
    for (let i = 0; i <= this.SEG; i++) {
      const u = i / this.SEG;
      this.pointAt(u, _p);
      this.pointAt(Math.min(1, u + 0.01), _t).sub(this.pointAt(Math.max(0, u - 0.01), _q)).normalize();
      _side.crossVectors(_t, _up).normalize();
      _nrm.crossVectors(_side, _t).normalize();
      for (let j = 0; j < this.RAD; j++) {
        const a = (j / this.RAD) * Math.PI * 2;
        const cx = Math.cos(a), sy = Math.sin(a);
        const nx = _side.x * cx + _nrm.x * sy, ny = _side.y * cx + _nrm.y * sy, nz = _side.z * cx + _nrm.z * sy;
        const k = i * this.RAD + j;
        P.setXYZ(k, _p.x + nx * r, _p.y + ny * r, _p.z + nz * r);
        N.setXYZ(k, nx, ny, nz);
      }
    }
    P.needsUpdate = true;
    N.needsUpdate = true;

    // pulley rides on top of the cable
    this.pointAt(target, _p);
    this.pointAt(Math.min(1, target + 0.01), _t).sub(this.pointAt(Math.max(0, target - 0.01), _q)).normalize();
    this.pulley.position.copy(_p);
    this.pulley.rotation.set(-Math.asin(clamp(_t.y, -1, 1)), this.yaw, 0, "YXZ");
    this.handle.rotation.x = clamp(this.swing.x, -0.5, 0.5) + Math.asin(clamp(_t.y, -1, 1));
    this.object.updateMatrixWorld(true);
    this.handle.localToWorld(this.gripL.set(0.14, -ZIP_HANDLE_DROP, 0));
    this.handle.localToWorld(this.gripR.set(-0.14, -ZIP_HANDLE_DROP, 0));
    this.riderPos.copy(this.gripL).add(this.gripR).multiplyScalar(0.5);
    this.riderPos.y -= this.hang;
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

const _p = new THREE.Vector3();
const _t = new THREE.Vector3();
const _q = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _side = new THREE.Vector3();
const _nrm = new THREE.Vector3();

/** a / b are the cable end points (world). `hang` = handle-to-feet drop of the rider (ZIP_HANG). */
export function createZipline(a: Vec3Like, b: Vec3Like, opts: { sag?: number; hang?: number } = {}): ZiplineActor {
  return new Zip(a, b, opts.sag ?? 0.03, opts.hang ?? 1.95);
}
