// Sky-drop visuals: while you're dropping in, the fights down below glow —
// a soft paint-colored light column and a pulsing ring over every hot zone —
// your predicted landing spot is marked on the ground, and every glider in
// the sky trails two wisps of wind from its wingtips.
import * as THREE from "three";
import { terrainHeight } from "../../../shared/world/collide";
import { ActionLog, HOT_RADIUS, HOT_W, Move, type HotZone, type PlayerState, type SimEnv } from "../../../shared/sim/index";

const MAX_BEACONS = 5;
const COLUMN_H = 150;
const TRAIL_PTS = 22;
const TRAIL_STEP = 0.8;
const MAX_TRAILS = 24;

const BEAM_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`;
const BEAM_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uAlpha;
uniform float uTime;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
void main() {
  float facing = abs(dot(normalize(vN), normalize(vV)));
  float body = pow(facing, 1.6);
  float fade = pow(1.0 - vUv.y, 1.7) * smoothstep(0.0, 0.03, vUv.y);
  // soft bands drifting upward
  float bands = 0.8 + 0.2 * sin(vUv.y * 40.0 - uTime * 3.0);
  vec3 col = mix(uColor, vec3(1.0), 0.35 * body);
  gl_FragColor = vec4(col * body * fade * bands * uAlpha, 1.0);
  #include <colorspace_fragment>
}
`;
const RING_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uAlpha;
uniform float uTime;
varying vec2 vUv;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  // a bright rim, a soft fill and a ripple running outward
  float rim = smoothstep(0.84, 0.93, r) * (1.0 - smoothstep(0.95, 1.0, r));
  float ripple = smoothstep(0.08, 0.0, abs(r - fract(uTime * 0.45))) * (1.0 - r);
  float fill = (1.0 - smoothstep(0.0, 1.0, r)) * 0.18;
  float a = (rim + ripple * 0.8 + fill) * uAlpha;
  gl_FragColor = vec4(mix(uColor, vec3(1.0), rim * 0.4) * a, 1.0);
  #include <colorspace_fragment>
}
`;
/** Landing target: ink outline, cream ring, my color inside, a dot in the middle. */
const LAND_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uAlpha;
uniform float uTime;
varying vec2 vUv;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  float pulse = 0.5 + 0.5 * sin(uTime * 5.0);
  float ink = smoothstep(0.66, 0.7, r) * (1.0 - smoothstep(0.97, 1.0, r));
  float cream = smoothstep(0.73, 0.77, r) * (1.0 - smoothstep(0.9, 0.94, r));
  float centre = 1.0 - smoothstep(0.14, 0.18, r);
  float dotInk = 1.0 - smoothstep(0.2, 0.24, r);
  float fill = (1.0 - smoothstep(0.62, 0.68, r)) * (0.22 + 0.12 * pulse);
  vec3 col = vec3(0.137, 0.216, 0.294);
  col = mix(col, vec3(1.0, 0.98, 0.94), cream);
  float a = max(ink, dotInk);
  col = mix(col, uColor, centre);
  vec3 outCol = mix(uColor, col, a);
  float outA = max(a, fill) * uAlpha;
  if (outA < 0.01) discard;
  gl_FragColor = vec4(outCol, outA);
  #include <colorspace_fragment>
}
`;
const PLAIN_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

interface Beacon {
  group: THREE.Group;
  beam: THREE.Mesh;
  ring: THREE.Mesh;
  beamMat: THREE.ShaderMaterial;
  ringMat: THREE.ShaderMaterial;
  a: number;
  x: number;
  z: number;
}

interface Trail {
  pts: Float32Array; // TRAIL_PTS * 2 wingtips * xyz
  n: number;
  head: number;
  lx: number; ly: number; lz: number;
  seen: number;
  fade: number;
}

const _v = new THREE.Vector3();
const _c = new THREE.Color();
const _zones: HotZone[] = [];

export class SkyDropView {
  readonly group = new THREE.Group();
  /** Recent action from the (broadcast) hit / elim / splat events. */
  readonly log = new ActionLog();
  /** The hottest zones right now (refreshed in update). */
  readonly zones: HotZone[] = [];
  /** Where the local glider will touch down if it keeps flying like this. */
  readonly landing = new THREE.Vector3();
  landingValid = false;
  private beacons: Beacon[] = [];
  private show = 0;
  private time = 0;
  private landMark: THREE.Mesh;
  private landMat: THREE.ShaderMaterial;
  private trails = new Map<number, Trail>();
  private trailGeo: THREE.BufferGeometry;
  private trailPos: Float32Array;
  private trailCol: Float32Array;
  private trailMesh: THREE.Mesh;
  private frame = 0;

  constructor(scene: THREE.Scene, private env: SimEnv) {
    scene.add(this.group);
    const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 24, 1, true);
    beamGeo.translate(0, 0.5, 0);
    const ringGeo = new THREE.PlaneGeometry(2, 2);
    ringGeo.rotateX(-Math.PI / 2);
    for (let i = 0; i < MAX_BEACONS; i++) {
      const beamMat = new THREE.ShaderMaterial({
        uniforms: { uColor: { value: new THREE.Color() }, uAlpha: { value: 0 }, uTime: { value: 0 } },
        vertexShader: BEAM_VERT, fragmentShader: BEAM_FRAG,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      });
      const ringMat = new THREE.ShaderMaterial({
        uniforms: { uColor: { value: new THREE.Color() }, uAlpha: { value: 0 }, uTime: { value: 0 } },
        vertexShader: PLAIN_VERT, fragmentShader: RING_FRAG,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      });
      const beam = new THREE.Mesh(beamGeo, beamMat);
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.renderOrder = 2;
      beam.renderOrder = 3;
      const group = new THREE.Group();
      group.add(beam, ring);
      group.visible = false;
      this.group.add(group);
      this.beacons.push({ group, beam, ring, beamMat, ringMat, a: 0, x: 0, z: 0 });
    }
    // landing marker: a ring in my color
    this.landMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(0xffffff) }, uAlpha: { value: 0 }, uTime: { value: 0 } },
      vertexShader: PLAIN_VERT, fragmentShader: LAND_FRAG,
      transparent: true, depthWrite: false, depthTest: false,
    });
    this.landMark = new THREE.Mesh(ringGeo, this.landMat);
    this.landMark.renderOrder = 5;
    this.landMark.visible = false;
    this.group.add(this.landMark);
    // wingtip trails: one ribbon mesh for everybody
    const nv = MAX_TRAILS * 2 * TRAIL_PTS * 2;
    this.trailPos = new Float32Array(nv * 3);
    this.trailCol = new Float32Array(nv * 4);
    this.trailGeo = new THREE.BufferGeometry();
    this.trailGeo.setAttribute("position", new THREE.BufferAttribute(this.trailPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.trailGeo.setAttribute("color", new THREE.BufferAttribute(this.trailCol, 4).setUsage(THREE.DynamicDrawUsage));
    const idx: number[] = [];
    for (let s = 0; s < MAX_TRAILS * 2; s++) {
      const b = s * TRAIL_PTS * 2;
      for (let i = 0; i < TRAIL_PTS - 1; i++) {
        const a = b + i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    this.trailGeo.setIndex(idx);
    this.trailMesh = new THREE.Mesh(this.trailGeo, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    }));
    this.trailMesh.frustumCulled = false;
    this.trailMesh.renderOrder = 4;
    this.group.add(this.trailMesh);
  }

  /** Recompute the hot zones now (e.g. right as a drop starts). */
  refresh(simTime: number): void {
    this.log.zones(simTime, _zones, MAX_BEACONS);
    this.zones.length = 0;
    for (const z of _zones) this.zones.push({ ...z });
  }

  /** Feed the action log from sim events (hit / elim / splat positions). */
  note(type: "hit" | "elim" | "splat", t: number, x: number, z: number, color: number): void {
    this.log.add(t, x, z, HOT_W[type], color);
  }

  /**
   * dropping: the local player is gliding (beacons + landing marker fade in).
   * gliders: every player (interpolated feet position via `pos`).
   */
  update(dt: number, simTime: number, me: PlayerState | undefined, myColor: number, cam: THREE.Camera,
    players: readonly PlayerState[], pos: (id: number, out: THREE.Vector3) => THREE.Vector3 | null): void {
    this.time += dt;
    this.frame++;
    const dropping = !!me && me.alive && (me.move === Move.Glide || me.move === Move.Splat);
    this.show += ((dropping ? 1 : 0) - this.show) * Math.min(1, dt * (dropping ? 3 : 1.6));
    if (this.frame % 6 === 0) this.refresh(simTime);
    this.updateBeacons(dt, cam);
    this.updateLanding(me, myColor, dropping);
    this.updateTrails(dt, cam, players, pos, me ? me.id : -1);
  }

  private updateBeacons(dt: number, cam: THREE.Camera): void {
    const vis = this.show > 0.01;
    for (let i = 0; i < MAX_BEACONS; i++) {
      const b = this.beacons[i];
      const z = this.zones[i];
      const want = vis && z ? Math.min(1, 0.45 + z.heat / 6) * (1 - Math.min(1, z.age / 20) * 0.5) : 0;
      if (z) {
        // glide to a moving zone instead of popping
        if (b.a < 0.02) { b.x = z.x; b.z = z.z; }
        const k = Math.min(1, dt * 2);
        b.x += (z.x - b.x) * k; b.z += (z.z - b.z) * k;
        _c.set(z.color || 0xff8a5c);
        // pastel paint → a touch richer so it reads against the island
        const hsl = { h: 0, s: 0, l: 0 };
        _c.getHSL(hsl);
        _c.setHSL(hsl.h, Math.min(1, hsl.s * 1.1 + 0.15), Math.min(0.62, hsl.l));
        (b.beamMat.uniforms.uColor.value as THREE.Color).copy(_c);
        (b.ringMat.uniforms.uColor.value as THREE.Color).copy(_c);
      }
      b.a += (want - b.a) * Math.min(1, dt * 2.5);
      b.group.visible = b.a > 0.01;
      if (!b.group.visible) continue;
      const g = Math.max(0, terrainHeight(this.env.world, b.x, b.z));
      const pulse = 0.85 + 0.15 * Math.sin(this.time * 3 + i * 1.7);
      const r = HOT_RADIUS * 0.55;
      b.group.position.set(b.x, g, b.z);
      // wide enough to read from across the island
      const w = Math.max(4.5, Math.hypot(b.x - cam.position.x, b.z - cam.position.z) * 0.02) * (0.9 + 0.2 * pulse);
      b.beam.scale.set(w, COLUMN_H, w);
      b.ring.position.y = 0.6;
      b.ring.scale.setScalar(r * (0.92 + 0.08 * pulse));
      // (fade the beam out as you come in to land right next to it: it's a signpost, not a wall)
      const near = Math.hypot(b.x - cam.position.x, b.z - cam.position.z);
      const clear = Math.min(1, Math.max(0, (near - 18) / 40));
      b.beamMat.uniforms.uAlpha.value = b.a * this.show * 1.1 * clear;
      b.ringMat.uniforms.uAlpha.value = b.a * this.show * 1.4;
      b.beamMat.uniforms.uTime.value = this.time;
      b.ringMat.uniforms.uTime.value = this.time + i;
    }
  }

  private updateLanding(me: PlayerState | undefined, myColor: number, dropping: boolean): void {
    this.landingValid = false;
    if (dropping && me && me.move === Move.Glide) {
      // coast along the current velocity until we meet the ground or the water
      let x = me.x, y = me.y, z = me.z;
      const vx = me.vx, vy = Math.min(-1, me.vy), vz = me.vz;
      const w = this.env.world;
      for (let i = 0; i < 160; i++) {
        const st = 0.2;
        const nx = x + vx * st, ny = y + vy * st, nz = z + vz * st;
        const g = Math.max(0, terrainHeight(w, nx, nz));
        if (ny <= g) {
          // refine
          const g0 = Math.max(0, terrainHeight(w, x, z));
          const k = Math.max(0, Math.min(1, (y - g0) / Math.max(1e-3, (y - g0) - (ny - g))));
          x += (nx - x) * k; z += (nz - z) * k; y = Math.max(0, terrainHeight(w, x, z));
          this.landingValid = true;
          break;
        }
        x = nx; y = ny; z = nz;
      }
      if (this.landingValid) this.landing.set(x, y, z);
    }
    const on = this.landingValid && this.show > 0.05;
    this.landMark.visible = on;
    if (on) {
      const d = me ? Math.hypot(me.x - this.landing.x, me.y - this.landing.y, me.z - this.landing.z) : 50;
      this.landMark.position.set(this.landing.x, this.landing.y + 0.3, this.landing.z);
      this.landMark.scale.setScalar(Math.max(1.6, Math.min(8, d * 0.05)));
      (this.landMat.uniforms.uColor.value as THREE.Color).set(myColor);
      this.landMat.uniforms.uAlpha.value = this.show * 1.1;
      this.landMat.uniforms.uTime.value = this.time * 1.6;
    }
  }

  private updateTrails(dt: number, cam: THREE.Camera, players: readonly PlayerState[], pos: (id: number, out: THREE.Vector3) => THREE.Vector3 | null, localId: number): void {
    const f = this.frame;
    for (const p of players) {
      // (not my own: the camera sits right in my wake)
      if (!p.alive || p.move !== Move.Glide || p.id === localId) continue;
      if (!pos(p.id, _v)) continue;
      let t = this.trails.get(p.id);
      if (!t) {
        if (this.trails.size >= MAX_TRAILS) continue;
        t = { pts: new Float32Array(TRAIL_PTS * 6), n: 0, head: 0, lx: 1e9, ly: 0, lz: 0, seen: f, fade: 1 };
        this.trails.set(p.id, t);
      }
      t.seen = f;
      t.fade = Math.min(1, t.fade + dt * 3);
      const d = Math.hypot(_v.x - t.lx, _v.y - t.ly, _v.z - t.lz);
      if (d > 30) t.n = 0; // respawned / teleported
      if (d >= TRAIL_STEP || t.n === 0) {
        // wingtips: out to the sides of the travel direction, about hand height
        const sp = Math.hypot(p.vx, p.vz) || 1;
        const rx = -p.vz / sp, rz = p.vx / sp;
        const k = t.head * 6, P = t.pts;
        const y = _v.y + 1.0;
        P[k] = _v.x + rx * 0.95; P[k + 1] = y; P[k + 2] = _v.z + rz * 0.95;
        P[k + 3] = _v.x - rx * 0.95; P[k + 4] = y; P[k + 5] = _v.z - rz * 0.95;
        t.head = (t.head + 1) % TRAIL_PTS;
        t.n = Math.min(TRAIL_PTS, t.n + 1);
        t.lx = _v.x; t.ly = _v.y; t.lz = _v.z;
      }
    }
    // fade out trails whose glider landed or left
    for (const [id, t] of this.trails) {
      if (t.seen !== f) { t.fade -= dt * 1.5; if (t.fade <= 0) this.trails.delete(id); }
    }
    // build ribbons (camera-facing width)
    const P = this.trailPos, C = this.trailCol;
    const cp = cam.position;
    let s = 0;
    for (const t of this.trails.values()) {
      for (let wing = 0; wing < 2; wing++) {
        if (s >= MAX_TRAILS * 2) break;
        const base = s * TRAIL_PTS * 2;
        for (let i = 0; i < TRAIL_PTS; i++) {
          const vi = (base + i * 2) * 3, ci = (base + i * 2) * 4;
          if (i >= t.n) {
            // collapse unused points onto the last real one (zero-area, invisible)
            const pv = (base + (t.n - 1) * 2) * 3;
            for (let q = 0; q < 6; q++) P[vi + q] = P[pv + q];
            for (let q = 0; q < 8; q++) C[ci + q] = 0;
            continue;
          }
          // newest first
          const j = (t.head - 1 - i + TRAIL_PTS * 2) % TRAIL_PTS;
          const k = j * 6 + wing * 3;
          const x = t.pts[k], y = t.pts[k + 1], z = t.pts[k + 2];
          // tangent toward the next (older) point
          const j2 = (j - 1 + TRAIL_PTS) % TRAIL_PTS;
          const k2 = (i + 1 < t.n ? j2 : j) * 6 + wing * 3;
          let tx = t.pts[k2] - x, ty = t.pts[k2 + 1] - y, tz = t.pts[k2 + 2] - z;
          if (i + 1 >= t.n) { tx = 0; ty = 0; tz = 1; }
          const ex = cp.x - x, ey = cp.y - y, ez = cp.z - z;
          let sx = ty * ez - tz * ey, sy = tz * ex - tx * ez, sz = tx * ey - ty * ex;
          const sl = Math.hypot(sx, sy, sz) || 1;
          const u = i / (TRAIL_PTS - 1);
          const w = 0.07 * (1 - u * 0.6);
          sx *= w / sl; sy *= w / sl; sz *= w / sl;
          P[vi] = x + sx; P[vi + 1] = y + sy; P[vi + 2] = z + sz;
          P[vi + 3] = x - sx; P[vi + 4] = y - sy; P[vi + 5] = z - sz;
          const a = (1 - u) * (1 - u) * 0.55 * Math.max(0, t.fade);
          C[ci] = 1; C[ci + 1] = 1; C[ci + 2] = 1; C[ci + 3] = a;
          C[ci + 4] = 1; C[ci + 5] = 1; C[ci + 6] = 1; C[ci + 7] = a;
        }
        s++;
      }
    }
    this.trailGeo.setDrawRange(0, s * (TRAIL_PTS - 1) * 6);
    this.trailMesh.visible = s > 0;
    (this.trailGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.trailGeo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const b of this.beacons) { b.beamMat.dispose(); b.ringMat.dispose(); }
    this.beacons[0]?.beam.geometry.dispose();
    this.beacons[0]?.ring.geometry.dispose();
    this.landMat.dispose();
    this.trailGeo.dispose();
    (this.trailMesh.material as THREE.Material).dispose();
  }
}
