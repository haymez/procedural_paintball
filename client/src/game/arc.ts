// Aiming preview: a dotted paintball trajectory from the muzzle and a landing
// marker where it will splat — the thing that makes lobbing over cover a skill.
import * as THREE from "three";
import { computeLaunch, traceArc, BALL_LIFE, type ArcResult, type Launch, type PlayerState, type SimEnv } from "../../../shared/sim/index";

const MAX_DOTS = 90;
const SPACING = 0.9;

export class AimArc {
  readonly group = new THREE.Group();
  private dots: THREE.InstancedMesh;
  private marker: THREE.Mesh;
  private markerMat: THREE.MeshBasicMaterial;
  private ring: THREE.Mesh;
  private pts = new Float32Array(3 * 200);
  private res: ArcResult = { count: 0, hit: false, x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, water: false, time: 0 };
  private launch: Launch = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, tx: 0, ty: 0, tz: 0 };
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3();
  private p = new THREE.Vector3();
  private col = new THREE.Color();
  private k = 0;
  private t = 0;
  /** Seconds of flight to the landing point (HUD reads it). */
  flightTime = 0;
  landing = new THREE.Vector3();
  landed = false;

  constructor(color: number) {
    const g = new THREE.SphereGeometry(0.055, 8, 6);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthWrite: false });
    this.dots = new THREE.InstancedMesh(g, mat, MAX_DOTS);
    this.dots.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.dots.frustumCulled = false;
    this.dots.renderOrder = 5;
    for (let i = 0; i < MAX_DOTS; i++) this.dots.setColorAt(i, this.col.set(color));
    this.group.add(this.dots);
    // landing marker: a soft splat disc + outline ring
    this.markerMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 });
    this.marker = new THREE.Mesh(splatShape(), this.markerMat);
    this.marker.renderOrder = 5;
    this.group.add(this.marker);
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.62, 0.72, 32), new THREE.MeshBasicMaterial({ color: 0xfffaf0, transparent: true, opacity: 0.9, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }));
    this.ring.renderOrder = 6;
    this.group.add(this.ring);
    this.group.visible = false;
  }

  setColor(c: number): void {
    this.markerMat.color.set(c);
    for (let i = 0; i < MAX_DOTS; i++) this.dots.setColorAt(i, this.col.set(c).lerp(new THREE.Color(0xffffff), 0.35));
    if (this.dots.instanceColor) this.dots.instanceColor.needsUpdate = true;
  }

  update(dt: number, show: boolean, env: SimEnv, p: PlayerState | undefined, muzzle: THREE.Vector3 | null): void {
    this.t += dt;
    this.k += ((show ? 1 : 0) - this.k) * (1 - Math.exp(-dt * 16));
    if (this.k < 0.02 || !p) { this.group.visible = false; this.landed = false; return; }
    this.group.visible = true;
    const L = computeLaunch(env, p, 0, 0, 0, this.launch);
    // start at the visible muzzle when we have it
    const sx = muzzle ? muzzle.x : L.x, sy = muzzle ? muzzle.y : L.y, sz = muzzle ? muzzle.z : L.z;
    const r = traceArc(env, sx, sy, sz, L.vx, L.vy, L.vz, BALL_LIFE, 1 / 30, this.pts, this.res);
    this.flightTime = r.time;
    this.landed = r.hit;
    this.landing.set(r.x, r.y, r.z);
    // resample the polyline by arc length, marching dots along it
    const pts = this.pts;
    let n = 0;
    const phase = (this.t * 3.2) % 1;
    let acc = SPACING * (1 - phase);
    let total = 0;
    for (let i = 1; i < r.count && n < MAX_DOTS; i++) {
      const ax = pts[i * 3 - 3], ay = pts[i * 3 - 2], az = pts[i * 3 - 1];
      const bx = pts[i * 3], by = pts[i * 3 + 1], bz = pts[i * 3 + 2];
      const seg = Math.hypot(bx - ax, by - ay, bz - az);
      while (acc <= seg && n < MAX_DOTS) {
        const f = acc / seg;
        this.p.set(ax + (bx - ax) * f, ay + (by - ay) * f, az + (bz - az) * f);
        const d = total + acc;
        // tiny near the muzzle, grow, then shrink toward the end
        const sc = Math.min(1, d / 3) * (0.7 + 0.3 * this.k) * (1 + Math.min(1.2, d / 35));
        this.s.setScalar(sc);
        this.m.compose(this.p, this.q, this.s);
        this.dots.setMatrixAt(n++, this.m);
        acc += SPACING;
      }
      acc -= seg;
      total += seg;
    }
    this.dots.count = n;
    this.dots.instanceMatrix.needsUpdate = true;
    (this.dots.material as THREE.MeshBasicMaterial).opacity = 0.9 * this.k;

    this.marker.visible = this.ring.visible = r.hit;
    if (r.hit) {
      const nrm = this.p.set(r.nx, r.ny, r.nz);
      this.q.setFromUnitVectors(Z, nrm);
      this.marker.quaternion.copy(this.q);
      this.ring.quaternion.copy(this.q);
      this.marker.position.set(r.x + r.nx * 0.03, r.y + r.ny * 0.03, r.z + r.nz * 0.03);
      this.ring.position.copy(this.marker.position);
      const pulse = 1 + Math.sin(this.t * 7) * 0.08;
      const dist = Math.hypot(r.x - sx, r.y - sy, r.z - sz);
      const size = (0.55 + dist * 0.012) * this.k;
      this.marker.scale.setScalar(size * pulse);
      this.ring.scale.setScalar(size * (1.2 - 0.1 * pulse));
      this.markerMat.opacity = 0.5 * this.k;
      this.q.identity();
    }
    this.q.identity();
  }

  dispose(): void {
    this.dots.geometry.dispose();
    (this.dots.material as THREE.Material).dispose();
    this.marker.geometry.dispose();
    this.markerMat.dispose();
    this.ring.geometry.dispose();
    (this.ring.material as THREE.Material).dispose();
    this.group.removeFromParent();
  }
}

const Z = new THREE.Vector3(0, 0, 1);

function splatShape(): THREE.ShapeGeometry {
  const s = new THREE.Shape();
  const N = 22;
  for (let i = 0; i <= N; i++) {
    const a = (i / N) * Math.PI * 2;
    const r = 0.55 + 0.1 * Math.sin(a * 5 + 1) + 0.06 * Math.sin(a * 9);
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    if (i === 0) s.moveTo(x, y);
    else s.lineTo(x, y);
  }
  return new THREE.ShapeGeometry(s);
}
