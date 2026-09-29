// Paintballs in flight + all the little juicy bits (impact bursts, water
// splashes, muzzle puffs, dust, bubbles, sparkles, spray). Everything is
// pooled into exactly TWO instanced draw calls:
//   1. glossy toon spheres  (balls, droplets, specks, bubbles)
//   2. flat sprites          (splat flashes, rings, puffs, foam)
import * as THREE from "three";
import { makeToonMaterial } from "../style";

export interface Vec3Like { x: number; y: number; z: number }

export interface PaintFxOptions {
  /** Gravity used to integrate balls you don't give explicit positions for. */
  gravity?: number;
  /** Optional ground height query; droplets die when they fall below it. */
  ground?: (x: number, z: number) => number;
  maxSpheres?: number;
  maxSprites?: number;
}

export interface PaintFx {
  readonly object: THREE.Group;
  spawnBall(id: number, pos: Vec3Like, vel: Vec3Like, color: THREE.ColorRepresentation): void;
  removeBall(id: number): void;
  /** Integrates balls (or snaps them to `positions`) AND ticks all particles. Call once per frame. */
  updateBalls(dt: number, positions?: Map<number, Vec3Like>): void;
  /** Camera position: far balls are drawn a little larger so incoming fire stays readable. */
  setViewer(pos: Vec3Like): void;
  /** Paint impact: droplets flying out along `normal` + a splat flash. */
  burst(pos: Vec3Like, normal: Vec3Like, color: THREE.ColorRepresentation, scale?: number): void;
  /** Something hit water at pos (y = surface). */
  splashWater(pos: Vec3Like, scale?: number): void;
  muzzle(pos: Vec3Like, dir: Vec3Like, color: THREE.ColorRepresentation): void;
  dust(pos: Vec3Like, count?: number, color?: THREE.ColorRepresentation): void;
  bubbles(pos: Vec3Like, count?: number): void;
  sparkle(pos: Vec3Like, color: THREE.ColorRepresentation, count?: number): void;
  /** Water spray (boat bows, wakes). */
  spray(pos: Vec3Like, vel: Vec3Like, count?: number): void;
  /** Expanding ring on a horizontal plane (pickup collect, landing shock). */
  ring(pos: Vec3Like, color: THREE.ColorRepresentation, size?: number, life?: number): void;
  readonly stats: { balls: number; spheres: number; sprites: number };
  clear(): void;
  dispose(): void;
}

// sphere particle kinds (balls are kept separately)
const K_DROP = 1, K_SPECK = 2, K_BUBBLE = 3, K_WATER = 4;
// sprite shapes (must match shader)
const S_RING = 0, S_SPLAT = 1, S_PUFF = 2, S_FOAM = 3, S_STAR = 4;

const _c = new THREE.Color();

const SPRITE_VERT = /* glsl */ `
attribute vec4 aCol;
attribute vec2 aShape; // x = shape, y = seed
attribute float aBill;
varying vec4 vCol;
varying vec2 vUv;
varying vec2 vShape;
void main() {
  vCol = aCol;
  vUv = position.xy * 2.0;
  vShape = aShape;
  vec4 mv;
  if (aBill > 0.5) {
    vec4 c = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    float s = length(instanceMatrix[0].xyz);
    mv = c + vec4(position.xy * s, 0.0, 0.0);
  } else {
    mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }
  gl_Position = projectionMatrix * mv;
}
`;
const SPRITE_FRAG = /* glsl */ `
varying vec4 vCol;
varying vec2 vUv;
varying vec2 vShape;
void main() {
  float d = length(vUv);
  float th = atan(vUv.y, vUv.x);
  float seed = vShape.y;
  float a = 0.0;
  vec3 col = vCol.rgb;
  int s = int(vShape.x + 0.5);
  if (s == 0) { // ring
    float w = 0.13;
    a = smoothstep(1.0 - w * 2.0, 1.0 - w, d) * (1.0 - smoothstep(0.93, 1.0, d));
    a *= 0.75 + 0.25 * sin(th * 9.0 + seed * 6.0);
  } else if (s == 1) { // splat
    float r = 0.62 + 0.16 * sin(th * 5.0 + seed * 11.0) + 0.09 * sin(th * 9.0 + seed * 3.0) + 0.05 * sin(th * 17.0 + seed);
    a = 1.0 - smoothstep(r - 0.03, r, d);
    // satellite dots
    vec2 q = vUv * 3.2 + seed * 3.0;
    float dots = step(length(fract(q) - 0.5), 0.18) * step(0.8, d) * step(d, 1.0);
    a = max(a, dots);
    col *= 0.88 + 0.22 * smoothstep(0.2, -0.4, vUv.y - vUv.x * 0.3);
  } else if (s == 2) { // puff (toon cloud)
    float r = 0.84 + 0.06 * sin(th * 5.0 + seed * 7.0) + 0.03 * sin(th * 3.0 - seed);
    a = 1.0 - smoothstep(r - 0.04, r, d);
    float lit = step(0.0, dot(normalize(vUv + 0.0001), normalize(vec2(-0.5, 0.8))) * (1.0 - d * 0.4) - 0.05);
    col *= mix(0.86, 1.05, lit);
  } else if (s == 3) { // foam disc
    float n = sin(vUv.x * 9.0 + seed) * sin(vUv.y * 9.0 - seed) * 0.5 + 0.5;
    a = (1.0 - smoothstep(0.55, 1.0, d)) * step(0.35, n + (1.0 - d) * 0.5);
  } else { // star sparkle
    float st = pow(abs(cos(th * 2.0)), 18.0);
    a = (1.0 - smoothstep(0.05 + 0.9 * st, 0.1 + 0.95 * st, d)) + (1.0 - smoothstep(0.12, 0.2, d));
    a = clamp(a, 0.0, 1.0);
  }
  a *= vCol.a;
  if (a < 0.01) discard;
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}
`;

/** Toon material with a crisp glossy highlight (paintballs are shiny!). */
export function makeGlossyToon(): THREE.MeshToonMaterial {
  const m = makeToonMaterial({ color: 0xffffff });
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace(
      "#include <opaque_fragment>",
      /* glsl */ `
      {
        vec3 V = normalize(vViewPosition);
        #if NUM_DIR_LIGHTS > 0
          vec3 L = directionalLights[0].direction;
        #else
          vec3 L = normalize(vec3(0.3, 0.8, 0.5));
        #endif
        float nh = max(dot(normal, normalize(L + V)), 0.0);
        outgoingLight += vec3(1.0) * (smoothstep(0.9, 0.93, nh) * 0.6);
        float rim = smoothstep(0.6, 0.95, 1.0 - max(dot(normal, V), 0.0));
        outgoingLight += diffuseColor.rgb * rim * 0.25;
      }
      #include <opaque_fragment>`,
    );
  };
  m.customProgramCacheKey = () => "isola-glossy-toon";
  return m;
}

export function createPaintFx(scene: THREE.Object3D, opts: PaintFxOptions = {}): PaintFx {
  const G = opts.gravity ?? 9.81;
  const ground = opts.ground;
  const MAXS = opts.maxSpheres ?? 3000;
  const MAXF = opts.maxSprites ?? 600;
  const group = new THREE.Group();
  group.name = "paint-fx";
  scene.add(group);

  // ---------------------------------------------------------------- spheres
  const sphGeo = new THREE.IcosahedronGeometry(1, 1);
  const sphMat = makeGlossyToon();
  const sph = new THREE.InstancedMesh(sphGeo, sphMat, MAXS);
  sph.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  sph.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAXS * 3), 3);
  sph.instanceColor.setUsage(THREE.DynamicDrawUsage);
  sph.frustumCulled = false;
  sph.count = 0;
  sph.castShadow = false;
  group.add(sph);

  // particle SoA
  const N = MAXS;
  const px = new Float32Array(N), py = new Float32Array(N), pz = new Float32Array(N);
  const vx = new Float32Array(N), vy = new Float32Array(N), vz = new Float32Array(N);
  const life = new Float32Array(N), maxLife = new Float32Array(N), size = new Float32Array(N);
  const cr = new Float32Array(N), cg = new Float32Array(N), cb = new Float32Array(N);
  const grav = new Float32Array(N), drag = new Float32Array(N), kind = new Uint8Array(N);
  let pCount = 0;

  function addP(k: number, x: number, y: number, z: number, ux: number, uy: number, uz: number, s: number, l: number, col: THREE.Color, g = 1, d = 0.5): void {
    if (pCount >= N - 400) return; // keep headroom for balls
    const i = pCount++;
    px[i] = x; py[i] = y; pz[i] = z; vx[i] = ux; vy[i] = uy; vz[i] = uz;
    size[i] = s; life[i] = 0; maxLife[i] = l; cr[i] = col.r; cg[i] = col.g; cb[i] = col.b;
    grav[i] = g; drag[i] = d; kind[i] = k;
  }

  // balls
  interface Ball { x: number; y: number; z: number; vx: number; vy: number; vz: number; c: THREE.Color; trail: number }
  const balls = new Map<number, Ball>();

  // ---------------------------------------------------------------- sprites
  const sprGeo = new THREE.PlaneGeometry(1, 1);
  const aCol = new THREE.InstancedBufferAttribute(new Float32Array(MAXF * 4), 4).setUsage(THREE.DynamicDrawUsage);
  const aShape = new THREE.InstancedBufferAttribute(new Float32Array(MAXF * 2), 2).setUsage(THREE.DynamicDrawUsage);
  const aBill = new THREE.InstancedBufferAttribute(new Float32Array(MAXF), 1).setUsage(THREE.DynamicDrawUsage);
  sprGeo.setAttribute("aCol", aCol);
  sprGeo.setAttribute("aShape", aShape);
  sprGeo.setAttribute("aBill", aBill);
  const sprMat = new THREE.ShaderMaterial({
    vertexShader: SPRITE_VERT,
    fragmentShader: SPRITE_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const spr = new THREE.InstancedMesh(sprGeo, sprMat, MAXF);
  spr.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  spr.frustumCulled = false;
  spr.count = 0;
  spr.renderOrder = 5;
  group.add(spr);

  interface Sprite {
    shape: number; seed: number; bill: boolean;
    x: number; y: number; z: number; vx: number; vy: number; vz: number;
    q: THREE.Quaternion; s0: number; s1: number; t: number; life: number;
    r: number; g: number; b: number; a: number; rise: number;
  }
  const sprites: Sprite[] = [];
  const sprPool: Sprite[] = [];
  function addS(shape: number, pos: Vec3Like, normal: Vec3Like | null, s0: number, s1: number, lifeS: number, col: THREE.Color, a = 1, vel?: Vec3Like): void {
    if (sprites.length >= MAXF) return;
    const s = sprPool.pop() ?? { shape: 0, seed: 0, bill: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, q: new THREE.Quaternion(), s0: 0, s1: 0, t: 0, life: 1, r: 1, g: 1, b: 1, a: 1, rise: 0 };
    s.shape = shape; s.seed = Math.random() * 10; s.bill = !normal;
    s.x = pos.x; s.y = pos.y; s.z = pos.z;
    s.vx = vel?.x ?? 0; s.vy = vel?.y ?? 0; s.vz = vel?.z ?? 0;
    if (normal) {
      _n.set(normal.x, normal.y, normal.z).normalize();
      s.q.setFromUnitVectors(_z, _n);
      _q.setFromAxisAngle(_z, Math.random() * Math.PI * 2);
      s.q.multiply(_q);
    }
    s.s0 = s0; s.s1 = s1; s.t = 0; s.life = lifeS; s.r = col.r; s.g = col.g; s.b = col.b; s.a = a;
    sprites.push(s);
  }

  const _z = new THREE.Vector3(0, 0, 1);
  const _n = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _m = new THREE.Matrix4();
  const _p = new THREE.Vector3();
  const _s = new THREE.Vector3();
  const white = new THREE.Color(0xffffff);
  const waterCol = new THREE.Color(0xe9fbff);
  const foamCol = new THREE.Color(0xffffff);
  const dustCol = new THREE.Color(0xf0dcb4);

  function randDir(out: THREE.Vector3): THREE.Vector3 {
    const u = Math.random() * 2 - 1, t = Math.random() * Math.PI * 2, r = Math.sqrt(1 - u * u);
    return out.set(r * Math.cos(t), u, r * Math.sin(t));
  }
  const _d = new THREE.Vector3();

  // write one sphere instance, stretched along its velocity
  const arr = sph.instanceMatrix.array as Float32Array;
  const carr = sph.instanceColor.array as Float32Array;
  function writeSphere(slot: number, x: number, y: number, z: number, ux: number, uy: number, uz: number, s: number, stretch: number, r: number, g: number, b: number): void {
    const o = slot * 16;
    const sp = Math.sqrt(ux * ux + uy * uy + uz * uz);
    if (stretch > 0 && sp > 0.5) {
      const st = 1 + Math.min(sp * stretch, 1.6);
      const yx = ux / sp, yy = uy / sp, yz = uz / sp;
      // any perpendicular
      let ax = 0, ay = 1, az = 0;
      if (Math.abs(yy) > 0.9) { ax = 1; ay = 0; }
      // x = normalize(a × y)
      let xx = ay * yz - az * yy, xy = az * yx - ax * yz, xz = ax * yy - ay * yx;
      const xl = Math.hypot(xx, xy, xz);
      xx /= xl; xy /= xl; xz /= xl;
      const zx = xy * yz - xz * yy, zy = xz * yx - xx * yz, zz = xx * yy - xy * yx;
      const sq = s / Math.sqrt(st);
      arr[o] = xx * sq; arr[o + 1] = xy * sq; arr[o + 2] = xz * sq; arr[o + 3] = 0;
      arr[o + 4] = yx * s * st; arr[o + 5] = yy * s * st; arr[o + 6] = yz * s * st; arr[o + 7] = 0;
      arr[o + 8] = zx * sq; arr[o + 9] = zy * sq; arr[o + 10] = zz * sq; arr[o + 11] = 0;
    } else {
      arr[o] = s; arr[o + 1] = 0; arr[o + 2] = 0; arr[o + 3] = 0;
      arr[o + 4] = 0; arr[o + 5] = s; arr[o + 6] = 0; arr[o + 7] = 0;
      arr[o + 8] = 0; arr[o + 9] = 0; arr[o + 10] = s; arr[o + 11] = 0;
    }
    arr[o + 12] = x; arr[o + 13] = y; arr[o + 14] = z; arr[o + 15] = 1;
    carr[slot * 3] = r; carr[slot * 3 + 1] = g; carr[slot * 3 + 2] = b;
  }

  const BALL_R = 0.06;
  const viewer = { x: 0, y: 0, z: 0, set: false };

  function update(dt: number, positions?: Map<number, Vec3Like>): void {
    dt = Math.min(dt, 0.05);
    let slot = 0;
    // --- balls
    for (const [id, b] of balls) {
      const p = positions?.get(id);
      if (p) {
        if (dt > 0) { b.vx = (p.x - b.x) / dt; b.vy = (p.y - b.y) / dt; b.vz = (p.z - b.z) / dt; }
        b.x = p.x; b.y = p.y; b.z = p.z;
      } else {
        b.vy -= G * dt;
        b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
      }
      // keep ~2-3 px on screen at range (a 6 cm ball is sub-pixel beyond ~30 m)
      let grow = 1;
      if (viewer.set) {
        const dx = b.x - viewer.x, dy = b.y - viewer.y, dz = b.z - viewer.z;
        grow = Math.min(3, Math.max(1, Math.sqrt(dx * dx + dy * dy + dz * dz) / 18));
      }
      b.trail += dt;
      if (b.trail > 0.02) {
        b.trail = 0;
        addP(K_SPECK, b.x - b.vx * 0.012, b.y - b.vy * 0.012, b.z - b.vz * 0.012, b.vx * 0.05, b.vy * 0.05, b.vz * 0.05, 0.03 * grow, 0.26, b.c, 0.2, 2);
      }
      if (slot < MAXS) writeSphere(slot++, b.x, b.y, b.z, b.vx, b.vy, b.vz, BALL_R * grow, 0.012, b.c.r, b.c.g, b.c.b);
    }
    // --- particles (swap-remove dead ones)
    for (let i = 0; i < pCount; ) {
      life[i] += dt;
      const k = kind[i];
      let dead = life[i] >= maxLife[i];
      if (!dead) {
        const dr = Math.exp(-drag[i] * dt);
        vx[i] *= dr; vz[i] *= dr;
        vy[i] = vy[i] * dr - G * grav[i] * dt;
        if (k === K_BUBBLE) { vx[i] += Math.sin(life[i] * 13 + i) * dt * 1.5; }
        px[i] += vx[i] * dt; py[i] += vy[i] * dt; pz[i] += vz[i] * dt;
        if (ground && (k === K_DROP || k === K_WATER) && vy[i] < 0 && py[i] < ground(px[i], pz[i])) dead = true;
      }
      if (dead) {
        const j = --pCount;
        px[i] = px[j]; py[i] = py[j]; pz[i] = pz[j]; vx[i] = vx[j]; vy[i] = vy[j]; vz[i] = vz[j];
        life[i] = life[j]; maxLife[i] = maxLife[j]; size[i] = size[j]; cr[i] = cr[j]; cg[i] = cg[j]; cb[i] = cb[j];
        grav[i] = grav[j]; drag[i] = drag[j]; kind[i] = kind[j];
        continue;
      }
      const t = life[i] / maxLife[i];
      let s = size[i];
      if (k === K_BUBBLE) s *= t < 0.15 ? t / 0.15 : 1 - Math.max(0, (t - 0.85) / 0.15);
      else if (k === K_DROP || k === K_WATER) s *= t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4;
      else s *= 1 - t;
      if (slot < MAXS) writeSphere(slot++, px[i], py[i], pz[i], vx[i], vy[i], vz[i], Math.max(0.001, s), k === K_BUBBLE ? 0 : 0.06, cr[i], cg[i], cb[i]);
      i++;
    }
    sph.count = slot;
    sph.instanceMatrix.needsUpdate = true;
    sph.instanceColor!.needsUpdate = true;
    if (slot > 0) {
      sph.instanceMatrix.clearUpdateRanges();
      sph.instanceMatrix.addUpdateRange(0, slot * 16);
      sph.instanceColor!.clearUpdateRanges();
      sph.instanceColor!.addUpdateRange(0, slot * 3);
    }

    // --- sprites
    let fslot = 0;
    const ca = aCol.array as Float32Array, sa = aShape.array as Float32Array, ba = aBill.array as Float32Array;
    for (let i = 0; i < sprites.length; ) {
      const s = sprites[i];
      s.t += dt;
      if (s.t >= s.life) {
        sprPool.push(s);
        sprites[i] = sprites[sprites.length - 1];
        sprites.pop();
        continue;
      }
      const t = s.t / s.life;
      s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
      s.vx *= Math.exp(-3 * dt); s.vy *= Math.exp(-3 * dt); s.vz *= Math.exp(-3 * dt);
      const e = 1 - Math.pow(1 - t, 3);
      let sc = s.s0 + (s.s1 - s.s0) * e;
      let a = s.a;
      if (s.shape === S_SPLAT) { sc = s.s1 * (t < 0.2 ? 0.5 + 0.7 * (t / 0.2) : 1.2 - 0.2 * (t - 0.2) / 0.8); a *= t < 0.55 ? 1 : 1 - (t - 0.55) / 0.45; }
      else if (s.shape === S_PUFF || s.shape === S_STAR) a *= t < 0.5 ? 1 : 1 - (t - 0.5) / 0.5;
      else a *= 1 - t;
      _p.set(s.x, s.y, s.z);
      _s.setScalar(Math.max(0.001, sc));
      _m.compose(_p, s.bill ? _qi : s.q, _s);
      _m.toArray(spr.instanceMatrix.array, fslot * 16);
      ca[fslot * 4] = s.r; ca[fslot * 4 + 1] = s.g; ca[fslot * 4 + 2] = s.b; ca[fslot * 4 + 3] = a;
      sa[fslot * 2] = s.shape; sa[fslot * 2 + 1] = s.seed;
      ba[fslot] = s.bill ? 1 : 0;
      fslot++;
      i++;
    }
    spr.count = fslot;
    spr.instanceMatrix.needsUpdate = true;
    aCol.needsUpdate = true;
    aShape.needsUpdate = true;
    aBill.needsUpdate = true;
  }
  const _qi = new THREE.Quaternion();

  const fx: PaintFx = {
    object: group,
    spawnBall(id, pos, vel, color) {
      balls.set(id, { x: pos.x, y: pos.y, z: pos.z, vx: vel.x, vy: vel.y, vz: vel.z, c: new THREE.Color(color), trail: 0 });
    },
    removeBall(id) {
      balls.delete(id);
    },
    updateBalls: update,
    setViewer(p) { viewer.x = p.x; viewer.y = p.y; viewer.z = p.z; viewer.set = true; },
    burst(pos, normal, color, scale = 1) {
      _c.set(color);
      _n.set(normal.x, normal.y, normal.z).normalize();
      const n = Math.round(16 * Math.sqrt(scale));
      for (let i = 0; i < n; i++) {
        randDir(_d).addScaledVector(_n, 1.3).normalize();
        const sp = (2 + Math.random() * 3.5) * Math.sqrt(scale);
        addP(K_DROP, pos.x + _n.x * 0.05, pos.y + _n.y * 0.05, pos.z + _n.z * 0.05, _d.x * sp, _d.y * sp + 1.2, _d.z * sp,
          (0.03 + Math.random() * 0.045) * Math.sqrt(scale), 0.45 + Math.random() * 0.45, _c, 1, 0.8);
      }
      // a couple of big lazy globs
      for (let i = 0; i < 3; i++) {
        randDir(_d).addScaledVector(_n, 2).normalize();
        addP(K_DROP, pos.x, pos.y, pos.z, _d.x * 1.6, _d.y * 1.6 + 2.2, _d.z * 1.6, 0.08 * Math.sqrt(scale), 0.7, _c, 1, 0.5);
      }
      addS(S_SPLAT, { x: pos.x + _n.x * 0.03, y: pos.y + _n.y * 0.03, z: pos.z + _n.z * 0.03 }, _n, 0.2 * scale, 0.55 * scale, 0.45, _c, 1);
      addS(S_RING, { x: pos.x + _n.x * 0.04, y: pos.y + _n.y * 0.04, z: pos.z + _n.z * 0.04 }, _n, 0.2 * scale, 0.9 * scale, 0.3, _c.clone().lerp(white, 0.4), 0.9);
    },
    splashWater(pos, scale = 1) {
      const k = Math.sqrt(scale);
      for (let i = 0; i < 18 * k; i++) {
        const a = Math.random() * Math.PI * 2, r = Math.random();
        const up = 3 + Math.random() * 3.5;
        addP(K_WATER, pos.x + Math.cos(a) * 0.15 * r, pos.y + 0.05, pos.z + Math.sin(a) * 0.15 * r,
          Math.cos(a) * (0.6 + r * 1.6) * k, up * k, Math.sin(a) * (0.6 + r * 1.6) * k, (0.04 + Math.random() * 0.05) * k, 0.8 + Math.random() * 0.4, waterCol, 1, 0.4);
      }
      const up = { x: 0, y: 1, z: 0 };
      addS(S_RING, { x: pos.x, y: pos.y + 0.03, z: pos.z }, up, 0.3 * k, 2.0 * k, 0.9, foamCol, 0.95);
      addS(S_RING, { x: pos.x, y: pos.y + 0.035, z: pos.z }, up, 0.1 * k, 1.2 * k, 1.1, foamCol, 0.7);
      addS(S_FOAM, { x: pos.x, y: pos.y + 0.04, z: pos.z }, up, 0.5 * k, 1.1 * k, 1.4, foamCol, 0.9);
    },
    muzzle(pos, dir, color) {
      _c.set(color).lerp(white, 0.5);
      addS(S_PUFF, { x: pos.x + dir.x * 0.08, y: pos.y + dir.y * 0.08, z: pos.z + dir.z * 0.08 }, null, 0.08, 0.26, 0.2, _c, 0.95,
        { x: dir.x * 1.5, y: dir.y * 1.5 + 0.3, z: dir.z * 1.5 });
      _c.set(color);
      for (let i = 0; i < 3; i++) {
        randDir(_d).multiplyScalar(0.8).add(dir as THREE.Vector3);
        addP(K_SPECK, pos.x, pos.y, pos.z, _d.x * 3, _d.y * 3, _d.z * 3, 0.022, 0.18, _c, 0.5, 3);
      }
    },
    dust(pos, count = 3, color) {
      const c = color !== undefined ? _c.set(color) : dustCol;
      for (let i = 0; i < count; i++) {
        addS(S_PUFF, { x: pos.x + (Math.random() - 0.5) * 0.3, y: pos.y + 0.08, z: pos.z + (Math.random() - 0.5) * 0.3 }, null,
          0.06, 0.18 + Math.random() * 0.12, 0.35 + Math.random() * 0.2, c, 0.6, { x: (Math.random() - 0.5) * 0.8, y: 0.5 + Math.random() * 0.5, z: (Math.random() - 0.5) * 0.8 });
      }
    },
    bubbles(pos, count = 4) {
      for (let i = 0; i < count; i++) {
        addP(K_BUBBLE, pos.x + (Math.random() - 0.5) * 0.3, pos.y + (Math.random() - 0.5) * 0.3, pos.z + (Math.random() - 0.5) * 0.3,
          (Math.random() - 0.5) * 0.4, 0.8 + Math.random() * 0.6, (Math.random() - 0.5) * 0.4, 0.03 + Math.random() * 0.05, 0.8 + Math.random() * 0.8, waterCol, -0.12, 1.5);
      }
    },
    sparkle(pos, color, count = 8) {
      _c.set(color).lerp(white, 0.3);
      for (let i = 0; i < count; i++) {
        randDir(_d);
        addS(S_STAR, { x: pos.x + _d.x * 0.3, y: pos.y + _d.y * 0.3, z: pos.z + _d.z * 0.3 }, null, 0.05, 0.22 + Math.random() * 0.12, 0.45 + Math.random() * 0.4, _c, 1,
          { x: _d.x * 2.5, y: _d.y * 2.5 + 1.5, z: _d.z * 2.5 });
      }
    },
    spray(pos, vel, count = 3) {
      for (let i = 0; i < count; i++) {
        randDir(_d).multiplyScalar(0.8);
        addP(K_WATER, pos.x, pos.y, pos.z, vel.x + _d.x, vel.y + _d.y + 1, vel.z + _d.z, 0.03 + Math.random() * 0.04, 0.5 + Math.random() * 0.3, waterCol, 1, 0.6);
      }
    },
    ring(pos, color, sz = 1.5, lifeS = 0.6) {
      _c.set(color);
      addS(S_RING, pos, { x: 0, y: 1, z: 0 }, 0.2, sz, lifeS, _c, 1);
    },
    get stats() {
      return { balls: balls.size, spheres: sph.count, sprites: spr.count };
    },
    clear() {
      balls.clear();
      pCount = 0;
      sprPool.push(...sprites);
      sprites.length = 0;
    },
    dispose() {
      scene.remove(group);
      sphGeo.dispose(); sphMat.dispose(); sprGeo.dispose(); sprMat.dispose();
      sph.dispose(); spr.dispose();
    },
  };
  return fx;
}
