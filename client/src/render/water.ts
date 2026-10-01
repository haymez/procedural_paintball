// Water: a camera-following ocean grid out to the horizon, river ribbons,
// still-water lakes/pools from the water grid, and waterfalls with foam + mist.
// Depth-based color comes from the terrain height texture (turquoise over sand
// shallows → deep blue), with animated foam bands at the shore, sun glitter and
// sky fresnel. Waves are gentle and mirrored on the CPU (waveHeight) so the
// game can bob boats / detect submersion consistently.
import * as THREE from "three";
import { CELL, GRID_RES, NO_WATER, WORLD_HALF, type World } from "../../../shared/world/types";
import { CLOUD_FN, ENV_PARS, NOISE_FNS, SKY_FN } from "./glsl";
import { GRID_UV_GLSL, type WorldTextures } from "./worldTextures";

export interface WaterOptions { segments: number }

export interface Water {
  group: THREE.Group;
  update(camera: THREE.Camera, time: number): void;
  /** Ocean wave displacement at x,z (m above sea level). */
  waveHeight(x: number, z: number, time: number): number;
  dispose(): void;
}

const lin = (hex: number) => {
  const c = new THREE.Color(hex);
  return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;
};

// wave set: dir (unit xz), wavelength, amplitude, speed
const WAVES = [
  { dx: 0.8, dz: 0.6, k: 2 * Math.PI / 23, a: 0.14, s: 1.1 },
  { dx: -0.3, dz: 0.95, k: 2 * Math.PI / 11, a: 0.07, s: 1.5 },
  { dx: 0.95, dz: -0.3, k: 2 * Math.PI / 6.5, a: 0.035, s: 2.0 },
];
const WAVE_GLSL = /* glsl */ `
float waveH(vec2 p, float t, out vec2 grad) {
  float h = 0.0; grad = vec2(0.0);
  ${WAVES.map((w) => `{
    vec2 d = vec2(${w.dx.toFixed(3)}, ${w.dz.toFixed(3)});
    float ph = dot(p, d) * ${w.k.toFixed(5)} - t * ${(w.s * w.k * 2.4).toFixed(5)};
    h += sin(ph) * ${w.a.toFixed(4)};
    grad += d * cos(ph) * ${(w.a * w.k).toFixed(5)};
  }`).join("\n")}
  return h;
}
`;

/**
 * Tiling ripple normal map: a periodic sum of sines with integer wave vectors
 * (so it wraps), amplitude falling with frequency. rgb = normal * 0.5 + 0.5.
 */
function makeWaterNormals(size = 256): THREE.DataTexture {
  let s = 977;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const waves: { kx: number; kz: number; a: number; ph: number }[] = [];
  for (let i = 0; i < 48; i++) {
    const ang = rnd() * Math.PI * 2;
    const f = 2 + Math.floor(Math.pow(rnd(), 1.6) * 22);
    const kx = Math.round(Math.cos(ang) * f), kz = Math.round(Math.sin(ang) * f);
    if (kx === 0 && kz === 0) continue;
    waves.push({ kx, kz, a: 1 / Math.pow(Math.hypot(kx, kz), 1.35), ph: rnd() * Math.PI * 2 });
  }
  const data = new Uint8Array(size * size * 4);
  const TAU = Math.PI * 2;
  let maxG = 1e-6;
  const gx = new Float32Array(size * size), gz = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size;
    let dx = 0, dz = 0;
    for (const w of waves) {
      const c = Math.cos(TAU * (w.kx * u + w.kz * v) + w.ph) * w.a;
      dx += c * w.kx; dz += c * w.kz;
    }
    const i = y * size + x;
    gx[i] = dx; gz[i] = dz;
    maxG = Math.max(maxG, Math.abs(dx), Math.abs(dz));
  }
  for (let i = 0; i < size * size; i++) {
    const nx = -gx[i] / maxG * 0.9, nz = -gz[i] / maxG * 0.9;
    const ny = Math.sqrt(Math.max(0, 1 - nx * nx - nz * nz));
    data[i * 4] = Math.round((nx * 0.5 + 0.5) * 255);
    data[i * 4 + 1] = Math.round((nz * 0.5 + 0.5) * 255);
    data[i * 4 + 2] = Math.round((ny * 0.5 + 0.5) * 255);
    data[i * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

const COMMON_WATER = /* glsl */ `
${ENV_PARS}
${NOISE_FNS}
${SKY_FN}
${CLOUD_FN}
${GRID_UV_GLSL}
uniform sampler2D tHeight;
uniform sampler2D uCanopy;
uniform sampler2D tWaterN;
// ripple normal perturbation (xz) from three scrolling layers of the ripple map
vec2 ripples(vec2 p, float t, float fine) {
  vec2 w = uWind;
  vec2 a = texture2D(tWaterN, p / 31.0 + w * t * 0.011).xy * 2.0 - 1.0;
  vec2 b = texture2D(tWaterN, mat2(0.6, -0.8, 0.8, 0.6) * p / 11.0 - vec2(w.y, -w.x) * t * 0.019).xy * 2.0 - 1.0;
  if (fine < 0.01) return a * 0.5;
  vec2 c = texture2D(tWaterN, mat2(-0.8, 0.6, -0.6, -0.8) * p / 4.3 + w * t * 0.04).xy * 2.0 - 1.0;
  return a * 0.5 + (b * 0.4 + c * 0.3) * fine;
}
// organic foam streaks: ridged contours of two drifting fbm layers, patchy
float foamLace(vec2 p, float t) {
  float a = noiseT(p * 0.07 + vec2(t * 0.009, -t * 0.006)).r;
  float b = noiseT(p * 0.19 - vec2(t * 0.012, t * 0.01) + 0.31).r;
  float r1 = 1.0 - smoothstep(0.0, 0.07, abs(a - 0.5));
  float r2 = 1.0 - smoothstep(0.0, 0.05, abs(b - 0.5));
  float patchy = smoothstep(0.35, 0.65, noiseT(p * 0.031 + 0.7).a);
  return clamp(max(r1 * 0.9, r2 * 0.7) * (0.4 + 0.6 * patchy) + smoothstep(0.62, 0.8, b) * 0.35, 0.0, 1.0);
}
// sky + clouds seen in a reflection from p
vec3 reflSky(vec3 p, vec3 r) {
  vec3 c = skyColor(r, 0.0);
  // ripples blur reflected clouds: soft and faint (one density tap, no lighting), gone toward the horizon
  float k = 0.35 * smoothstep(0.05, 0.3, r.y);
  if (k > 0.0 && uCloud.x > 0.0) {
    float d = cloudDensity(p.xz + r.xz * ((uCloud.w - p.y) / r.y));
    vec3 cc = mix(uSkyHorizon * 0.85, vec3(1.0), 0.7);
    c = mix(c, cc, d * k);
  }
  return c;
}
float terrainHeight(vec2 xz) {
  vec2 uv = gridUV(xz);
  float h = texture2D(tHeight, clamp(uv, vec2(0.0), vec2(1.0))).r;
  // beyond the generated square the seabed keeps dropping
  float outside = max(max(abs(xz.x), abs(xz.y)) - ${(WORLD_HALF - 8).toFixed(1)}, 0.0);
  return mix(h, -80.0, clamp(outside / 60.0, 0.0, 1.0));
}
// seabed slope (m/m)
float seabedGrad(vec2 xz) {
  float e = 1.5;
  float gx = terrainHeight(xz + vec2(e, 0.0)) - terrainHeight(xz - vec2(e, 0.0));
  float gz = terrainHeight(xz + vec2(0.0, e)) - terrainHeight(xz - vec2(0.0, e));
  return length(vec2(gx, gz)) / (2.0 * e);
}
// distance (m) to the waterline estimated from depth and the seabed slope
float shoreDist(vec2 xz, float depth) {
  return depth / max(seabedGrad(xz), 0.015);
}
vec3 detailNormal(vec2 p, float t, float strength) {
  vec2 w = uWind;
  vec2 p1 = p * 0.045 + w * t * 0.012;
  vec2 p2 = p * 0.11 - vec2(w.y, -w.x) * t * 0.018;
  float e = 0.004;
  float a0 = noiseT(p1).r + noiseT(p2).a;
  float ax = noiseT(p1 + vec2(e, 0.0)).r + noiseT(p2 + vec2(e * 2.44, 0.0)).a;
  float az = noiseT(p1 + vec2(0.0, e)).r + noiseT(p2 + vec2(0.0, e * 2.44)).a;
  return vec3(-(ax - a0), 0.0, -(az - a0)) * strength;
}
`;

export function createWater(world: World, tex: WorldTextures, env: Record<string, THREE.IUniform>, opts: WaterOptions): Water {
  const group = new THREE.Group();
  group.name = "water";

  // ---------------------------------------------------------------- ocean
  const N = opts.segments;
  const R = 5500;
  const oceanGeo = new THREE.BufferGeometry();
  {
    const pos = new Float32Array((N + 1) * (N + 1) * 3);
    const map = (u: number) => R * (0.012 * u + 0.988 * u * u * u);
    for (let j = 0; j <= N; j++) {
      for (let i = 0; i <= N; i++) {
        const u = (i / N) * 2 - 1, v = (j / N) * 2 - 1;
        const k = (j * (N + 1) + i) * 3;
        pos[k] = map(u); pos[k + 1] = 0; pos[k + 2] = map(v);
      }
    }
    const idx: number[] = [];
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const a = j * (N + 1) + i, b = a + 1, c = a + N + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    oceanGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    oceanGeo.setIndex(idx);
  }
  const waterN = makeWaterNormals();
  const oceanUniforms = { ...env, tHeight: { value: tex.height }, tWaterN: { value: waterN } };
  const oceanMat = new THREE.ShaderMaterial({
    uniforms: oceanUniforms,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: true,
    vertexShader: /* glsl */ `
      ${ENV_PARS}
      ${WAVE_GLSL}
      varying vec3 vW; varying vec2 vGrad; varying float vWave;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        float camD = length(w.xz - cameraPosition.xz);
        float fade = 1.0 - smoothstep(150.0, 600.0, camD);
        vec2 g;
        float h = waveH(w.xz, uTime, g) * fade;
        w.y += h;
        vW = w.xyz; vGrad = g * fade; vWave = h;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      ${COMMON_WATER}
      varying vec3 vW; varying vec2 vGrad; varying float vWave;
      void main() {
        float th = terrainHeight(vW.xz);
        // water visible above "land" only happens inside sea grottos (terrain holes)
        float grotto = smoothstep(0.4, 3.0, th);
        if (grotto > 0.0) th = mix(th, -1.6, grotto);
        float depth = max(-th, 0.0);
        vec3 v = normalize(cameraPosition - vW);
        float camD = length(cameraPosition - vW);
        float fine = 1.0 - smoothstep(30.0, 320.0, camD);
        vec2 rp = ripples(vW.xz, uTime, fine) * mix(0.08, 0.26, fine);
        vec3 n = normalize(vec3(-vGrad.x + rp.x, 1.0, -vGrad.y + rp.y));
        bool below = !gl_FrontFacing;
        if (below) n = -n;

        // water body: clear turquoise over sand, blue over the shelf, navy offshore
        float d1 = smoothstep(0.8, 7.0, depth);
        float d2 = smoothstep(6.0, 34.0, depth);
        vec3 body = mix(mix(${lin(0x2fb3ad)}, ${lin(0x15739f)}, d1), ${lin(0x0a3463)}, d2);
        body *= 0.55 + 0.45 * max(uSunDir.y, 0.0);
        // light through the backs of swells
        float sss = pow(max(dot(-v, uSunDir) * 0.5 + 0.5, 0.0), 4.0) * max(vWave * 4.0 + 0.4, 0.0);
        body += ${lin(0x2fb3a0)} * sss * 0.35 * (1.0 - d2);

        float nv = max(dot(n, v), 0.0);
        float fres = 0.02 + 0.98 * pow(1.0 - nv, 5.0);
        vec3 r = reflect(-v, n);
        r.y = abs(r.y);
        vec3 refl = reflSky(vW, r) * (1.0 - grotto * 0.94); // a cave roof, not sky, above grotto water
        // how much of the seabed shows through: Beer-Lambert over the view path
        float path = depth / max(v.y, 0.12);
        float a = 1.0 - exp(-path * 0.32);
        a = mix(a, 1.0, smoothstep(14.0, 40.0, depth));
        float alpha = fres + (1.0 - fres) * a;
        vec3 col = (refl * fres + body * a * (1.0 - fres)) / max(alpha, 1e-4);

        // sun glint (HDR, feeds bloom)
        vec3 hv = normalize(uSunDir + v);
        float nh = max(dot(n, hv), 0.0);
        float spark = smoothstep(0.55, 0.85, noiseT(vW.xz * 0.35 + uTime * 0.05).b);
        vec3 glint = uSunColor * (pow(nh, 1400.0) * 18.0 * (0.25 + spark) + pow(nh, 160.0) * 0.35);
        col += glint / max(alpha, 0.35) * 0.9;

        // shoreline foam: lacy swash at the edge + broken lines rolling in
        if (depth < 3.5) { // shoreline foam (nothing to break on further out)
          float sgrad = depth < 3.5 ? seabedGrad(vW.xz) : 1.0;
          float sd = depth < 3.5 ? depth / max(sgrad, 0.015) : 99.0;
          // dead-flat sea-level ground (wet flats, carved mouths): no surf line to break on
          float flatK = smoothstep(0.004, 0.02, sgrad);
          float shore = 1.0 - smoothstep(2.0, 18.0, sd);
          float nz = noiseT(vW.xz * 0.045 + vec2(uTime * 0.008, 0.0)).r;
          // lacy foam: cell edges broken up by fbm so it never reads as a regular net
          float lace = foamLace(vW.xz, uTime);
          float bubbles = smoothstep(0.45, 0.75, noiseT(vW.xz * 0.9 + uTime * 0.03).b);
          float ph = sd * 0.5 - uTime * 1.15 + nz * 6.0;
          float crest = fract(ph / 6.2832);
          float wave = smoothstep(0.82, 0.97, crest) + (1.0 - smoothstep(0.0, 0.35, crest)) * 0.55; // crest, then a fading trail
          float band = wave * shore * mix(0.35, 1.0, lace) * smoothstep(0.25, 0.6, nz + 0.2);
          float edge = 1.0 - smoothstep(0.0, 1.0 + 1.6 * nz, sd - vWave * 3.0);
          float foam = max(band * 0.75, edge * mix(0.45, 1.0, max(lace, bubbles))) * flatK;
          foam *= smoothstep(-2.0, 0.0, th + 2.0); // only near actual ground
          vec3 foamC = vec3(0.96, 0.97, 0.95) * (0.65 + 0.4 * max(uSunDir.y, 0.0));
          col = mix(col, foamC, clamp(foam, 0.0, 1.0));
          alpha = max(alpha, clamp(foam, 0.0, 1.0));
        }

        if (grotto > 0.0) {
          // dim, glassy cave water
          vec3 cw = vec3(0.006, 0.03, 0.04) + vec3(0.012, 0.05, 0.05) * smoothstep(0.5, 0.9, noiseT(vW.xz * 0.2 + uTime * 0.02).r);
          col = mix(col, cw, grotto);
          alpha = mix(alpha, 0.92, grotto);
        }
        if (below) {
          // looking up from underwater: bright window + total internal reflection
          float win = smoothstep(0.55, 0.8, nv);
          col = mix(vec3(0.03, 0.22, 0.28), vec3(0.55, 0.9, 1.0) * 1.2, win);
          col += vec3(0.25, 0.4, 0.4) * smoothstep(0.6, 0.9, noiseT(vW.xz * 0.12 + uTime * 0.02).r) * win;
          alpha = 1.0;
        }
        gl_FragColor = vec4(col, alpha);
      }`,
  });
  const ocean = new THREE.Mesh(oceanGeo, oceanMat);
  ocean.frustumCulled = false;
  ocean.name = "ocean";
  ocean.renderOrder = 1;
  group.add(ocean);

  // ---------------------------------------------------------- fresh water
  const freshMat = new THREE.ShaderMaterial({
    uniforms: { ...env, tHeight: { value: tex.height }, tWaterN: { value: waterN } },
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: true,
    vertexShader: /* glsl */ `
      attribute vec3 aFlow; // flow dir xz, speed
      attribute vec2 aUv;   // across (-1..1), along (m)
      varying vec3 vW; varying vec3 vFlow; varying vec2 vUv2;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz; vFlow = aFlow; vUv2 = aUv;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      ${COMMON_WATER}
      varying vec3 vW; varying vec3 vFlow; varying vec2 vUv2;
      void main() {
        float th = terrainHeight(vW.xz);
        float depth = max(vW.y - th, 0.0);
        vec3 v = normalize(cameraPosition - vW);
        float speed = vFlow.z;
        vec2 fdir = speed > 0.01 ? normalize(vFlow.xy) : vec2(0.0);
        // flow-advected noise: two phases blended to avoid stretching
        float t = uTime;
        float ph0 = fract(t * 0.25), ph1 = fract(t * 0.25 + 0.5);
        float wA = abs(ph0 - 0.5) * 2.0;
        vec2 adv0 = fdir * speed * ph0 * 4.0, adv1 = fdir * speed * ph1 * 4.0;
        vec4 nA = noiseT((vW.xz - adv0) * 0.12);
        vec4 nB = noiseT((vW.xz - adv1) * 0.12 + 0.5);
        vec4 nn = mix(nA, nB, wA);
        // ripples carried by the current (two phases, like the noise above)
        vec2 r0 = ripples((vW.xz - adv0) * 1.6, t * 0.5, 1.0), r1 = ripples((vW.xz - adv1) * 1.6 + 7.0, t * 0.5, 1.0);
        vec2 rp = mix(r0, r1, wA) * (0.05 + 0.14 * smoothstep(0.3, 2.5, speed));
        vec3 n = normalize(vec3((nn.r - 0.5) * 0.25 + rp.x, 1.0, (nn.b - 0.5) * 0.25 + rp.y));
        if (cameraPosition.y < vW.y) n = -n; // river strips aren't consistently wound: decide by the eye
        // clear stream water: tea-green in the shallows, dark green-teal in pools
        float d1 = smoothstep(0.1, 2.2, depth);
        vec3 body = mix(${lin(0x5a7a52)}, ${lin(0x1f4a44)}, d1) * (0.55 + 0.45 * max(uSunDir.y, 0.0));
        float nv = max(dot(n, v), 0.0);
        float fres = 0.02 + 0.98 * pow(1.0 - nv, 5.0);
        vec3 r = reflect(-v, n); r.y = abs(r.y);
        vec3 refl = reflSky(vW, r);
        // under a forest canopy the reflection is of leaves, not sky
        vec4 C0 = texture2D(uCanopy, (vW.xz + ${WORLD_HALF.toFixed(1)}) / ${(WORLD_HALF * 2).toFixed(1)});
        float under = clamp((C0.r + C0.a) * 1.4, 0.0, 1.0) * step(vW.y, C0.b);
        refl = mix(refl, ${lin(0x1c2a14)} * (0.6 + 0.4 * max(uSunDir.y, 0.0)), under * 0.85);
        float a = 1.0 - exp(-depth / max(v.y, 0.15) * 0.9);
        float alpha = fres + (1.0 - fres) * a;
        vec3 col = (refl * fres + body * a * (1.0 - fres)) / max(alpha, 1e-4);
        vec3 hv = normalize(uSunDir + v);
        float nh = max(dot(n, hv), 0.0);
        col += uSunColor * (pow(nh, 900.0) * 22.0 + pow(nh, 80.0) * 0.3) / max(alpha, 0.2);
        // white water: fast current, shallow rocks, banks
        float lace = foamLace((vW.xz - mix(adv0, adv1, 1.0 - wA) * 1.5) * 1.6, t);
        float streak = smoothstep(0.62, 0.85, nn.r + nn.g * 0.3);
        float rapids = smoothstep(1.5, 4.0, speed) * max(streak, lace * 0.8);
        // banks foam only where the water moves; still pools just fade out at their edges
        float edge = (1.0 - smoothstep(0.0, 0.18 + 0.15 * nn.b, depth)) * mix(0.3, 1.0, lace) * smoothstep(0.25, 1.2, speed);
        float foam = max(rapids, edge * 0.7) + lace * smoothstep(0.6, 2.0, speed) * 0.3;
        col = mix(col, vec3(0.93, 0.95, 0.94) * (0.7 + 0.35 * uSunDir.y), clamp(foam, 0.0, 1.0));
        alpha = max(alpha, clamp(foam, 0.0, 1.0));
        alpha *= smoothstep(0.0, 7.0, vUv2.y); // hand over to the sea at the mouth
        gl_FragColor = vec4(col, alpha);
      }`,
  });

  const riverGeos: THREE.BufferGeometry[] = [];
  for (const river of world.rivers) {
    const pts = river.points;
    if (pts.length < 2) continue;
    const pos: number[] = [], flow: number[] = [], uv: number[] = [], idx: number[] = [];
    let along = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const pa = pts[Math.max(0, i - 1)], pb = pts[Math.min(pts.length - 1, i + 1)];
      let tx = pb.x - pa.x, tz = pb.z - pa.z;
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl; tz /= tl;
      if (i > 0) along += Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z);
      const half = p.width * 0.5 + 1.2;
      // speed from the flow grid, fallback to surface slope
      const gi = Math.round((p.z + WORLD_HALF) / CELL) * GRID_RES + Math.round((p.x + WORLD_HALF) / CELL);
      let speed = Math.hypot(world.flow[gi * 2] ?? 0, world.flow[gi * 2 + 1] ?? 0);
      if (!(speed > 0)) {
        const dy = (pa.y - pb.y) / tl;
        speed = 0.6 + Math.min(4, Math.max(0, dy * 40));
      }
      const across = 5;
      for (let a = 0; a < across; a++) {
        const s = (a / (across - 1)) * 2 - 1;
        pos.push(p.x - tz * half * s, p.y, p.z + tx * half * s);
        flow.push(tx, tz, speed * (1 - 0.35 * s * s));
        uv.push(s, along);
      }
      if (i > 0) {
        const b0 = (i - 1) * across, b1 = i * across;
        for (let a = 0; a < across - 1; a++) idx.push(b0 + a, b1 + a, b0 + a + 1, b0 + a + 1, b1 + a, b1 + a + 1);
      }
    }
    // aUv.y becomes the distance left to a sea mouth (rivers ending at sea level fade into the sea)
    const seaMouth = pts[pts.length - 1].y < 0.4;
    for (let k = 1; k < uv.length; k += 2) uv[k] = seaMouth ? along - uv[k] : 1e4;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("aFlow", new THREE.Float32BufferAttribute(flow, 3));
    g.setAttribute("aUv", new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeBoundingSphere();
    riverGeos.push(g);
    const m = new THREE.Mesh(g, freshMat);
    m.name = "river";
    m.renderOrder = 2;
    group.add(m);
  }

  // still water (lakes / pools): cells of the water grid with ~zero flow
  {
    const pos: number[] = [], flow: number[] = [], uv: number[] = [], idx: number[] = [];
    const W = world.water, F = world.flow, H = world.height;
    const still = (i: number) => W[i] !== NO_WATER && Math.hypot(F[i * 2], F[i * 2 + 1]) < 0.05;
    const vid = new Int32Array(GRID_RES * GRID_RES).fill(-1);
    const levelAtVertex = (ix: number, iz: number) => {
      let sum = 0, cnt = 0;
      for (let dz = -1; dz <= 0; dz++) for (let dx = -1; dx <= 0; dx++) {
        const cx = ix + dx, cz = iz + dz;
        if (cx < 0 || cz < 0 || cx >= GRID_RES || cz >= GRID_RES) continue;
        const i = cz * GRID_RES + cx;
        if (still(i)) { sum += W[i]; cnt++; }
      }
      return cnt ? sum / cnt : NO_WATER;
    };
    const vert = (ix: number, iz: number) => {
      const k = iz * GRID_RES + ix;
      if (vid[k] >= 0) return vid[k];
      const y = levelAtVertex(ix, iz);
      vid[k] = pos.length / 3;
      pos.push(-WORLD_HALF + ix * CELL, y, -WORLD_HALF + iz * CELL);
      flow.push(0, 0, 0);
      uv.push(0, 1e4); // not a river mouth
      return vid[k];
    };
    for (let iz = 0; iz < GRID_RES - 1; iz++) {
      for (let ix = 0; ix < GRID_RES - 1; ix++) {
        const i = iz * GRID_RES + ix;
        if (!still(i)) continue;
        // skip cells deep under terrain (fully dry) — keep if any corner is below the level
        const lvl = W[i];
        if (H[i] > lvl + 1 && H[i + 1] > lvl + 1 && H[i + GRID_RES] > lvl + 1 && H[i + GRID_RES + 1] > lvl + 1) continue;
        const a = vert(ix, iz), b = vert(ix + 1, iz), c = vert(ix, iz + 1), d = vert(ix + 1, iz + 1);
        idx.push(a, c, b, b, c, d);
      }
    }
    if (idx.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute("aFlow", new THREE.Float32BufferAttribute(flow, 3));
      g.setAttribute("aUv", new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      g.computeBoundingSphere();
      riverGeos.push(g);
      const m = new THREE.Mesh(g, freshMat);
      m.name = "lakes";
      m.renderOrder = 2;
      group.add(m);
    }
  }

  // ------------------------------------------------------------ waterfalls
  const fallMat = new THREE.ShaderMaterial({
    uniforms: { ...env },
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
    vertexShader: /* glsl */ `
      attribute vec2 aFall; // u across 0..1, v down 0..1
      varying vec2 vF; varying vec3 vW; varying float vLen;
      uniform float uDummy;
      void main() {
        vF = aFall;
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      ${ENV_PARS}
      ${NOISE_FNS}
      varying vec2 vF; varying vec3 vW;
      void main() {
        float t = uTime;
        vec2 p = vec2(vF.x * 3.0, vF.y * 0.35 - t * 0.9);
        float s1 = noiseT(p * vec2(1.0, 0.25)).r;
        float s2 = noiseT(p * vec2(2.3, 0.4) + 0.3 - vec2(0.0, t * 0.4)).b;
        float streak = smoothstep(0.35, 0.75, s1 * 0.7 + s2 * 0.5);
        vec3 base = mix(vec3(0.3, 0.75, 0.8), vec3(0.95, 0.99, 1.0), streak);
        base *= 0.85 + 0.3 * max(uSunDir.y, 0.0);
        float edgeFade = smoothstep(0.0, 0.12, vF.x) * smoothstep(1.0, 0.88, vF.x);
        float foamBottom = smoothstep(0.75, 1.0, vF.y);
        base = mix(base, vec3(1.0), foamBottom * 0.8);
        float a = (0.55 + 0.4 * streak) * edgeFade;
        gl_FragColor = vec4(base * 1.1, a);
      }`,
  });
  const foamMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.92 });
  const mistMat = new THREE.ShaderMaterial({
    uniforms: { ...env },
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */ `
      ${ENV_PARS}
      attribute vec4 aMist; // base xyz, phase
      varying float vA; varying vec2 vQ;
      void main() {
        float ph = fract(uTime * 0.18 + aMist.w);
        vec3 c = aMist.xyz + vec3(sin(aMist.w * 40.0) * ph * 3.0, ph * 5.0, cos(aMist.w * 31.0) * ph * 3.0);
        float size = 1.5 + ph * 4.0;
        vec4 mv = viewMatrix * vec4(c, 1.0);
        mv.xy += position.xy * size;
        vA = sin(ph * 3.14159) * 0.28;
        vQ = position.xy;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying float vA; varying vec2 vQ;
      void main() {
        float d = length(vQ);
        float a = smoothstep(1.0, 0.0, d) * vA;
        gl_FragColor = vec4(vec3(1.0), a);
      }`,
  });
  const fallGeos: THREE.BufferGeometry[] = [];
  const foamGeo = new THREE.IcosahedronGeometry(1, 1);
  const quadGeo = new THREE.PlaneGeometry(1, 1);
  for (const wf of world.waterfalls) {
    const dx = Math.sin(wf.dir), dz = Math.cos(wf.dir);
    const px = dz, pz = -dx; // across
    const H = Math.max(0.5, wf.top - wf.bottom);
    const segV = 12, segU = 6;
    const pos: number[] = [], fa: number[] = [], idx: number[] = [];
    for (let j = 0; j <= segV; j++) {
      const v = j / segV;
      // ballistic lip: pushes out then falls
      const out = Math.sqrt(v) * Math.min(3, H * 0.25) + 0.3;
      const y = wf.top - v * H;
      for (let i = 0; i <= segU; i++) {
        const u = i / segU;
        const s = (u - 0.5) * wf.width * (1 + v * 0.25);
        pos.push(wf.x + px * s + dx * out, y, wf.z + pz * s + dz * out);
        fa.push(u, v);
      }
    }
    for (let j = 0; j < segV; j++) for (let i = 0; i < segU; i++) {
      const a = j * (segU + 1) + i, b = a + 1, c = a + segU + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("aFall", new THREE.Float32BufferAttribute(fa, 2));
    g.setIndex(idx);
    g.computeBoundingSphere();
    fallGeos.push(g);
    const m = new THREE.Mesh(g, fallMat);
    m.renderOrder = 3;
    m.name = "waterfall";
    group.add(m);

    // foam puffs at the base
    const puffs = 9;
    const foam = new THREE.InstancedMesh(foamGeo, foamMat, puffs);
    const mm = new THREE.Matrix4();
    const baseOut = Math.min(3, H * 0.25) + 0.3;
    for (let i = 0; i < puffs; i++) {
      const s = ((i / (puffs - 1)) - 0.5) * wf.width * 1.2;
      const r = 0.5 + Math.random() * 0.6;
      mm.makeScale(r, r * 0.55, r).setPosition(wf.x + px * s + dx * (baseOut + Math.random()), wf.bottom + 0.05, wf.z + pz * s + dz * (baseOut + Math.random()));
      foam.setMatrixAt(i, mm);
    }
    foam.name = "waterfall-foam";
    group.add(foam);

    // mist sprites
    const mistCount = 14;
    const mg = new THREE.InstancedBufferGeometry();
    mg.index = quadGeo.index;
    mg.setAttribute("position", quadGeo.getAttribute("position"));
    const md = new Float32Array(mistCount * 4);
    for (let i = 0; i < mistCount; i++) {
      const s = (Math.random() - 0.5) * wf.width;
      md[i * 4] = wf.x + px * s + dx * baseOut;
      md[i * 4 + 1] = wf.bottom + 0.3;
      md[i * 4 + 2] = wf.z + pz * s + dz * baseOut;
      md[i * 4 + 3] = Math.random();
    }
    mg.setAttribute("aMist", new THREE.InstancedBufferAttribute(md, 4));
    mg.instanceCount = mistCount;
    fallGeos.push(mg);
    const mist = new THREE.Mesh(mg, mistMat);
    mist.frustumCulled = false;
    mist.renderOrder = 4;
    mist.name = "waterfall-mist";
    group.add(mist);
  }

  function waveHeight(x: number, z: number, t: number): number {
    let h = 0;
    for (const w of WAVES) h += Math.sin((x * w.dx + z * w.dz) * w.k - t * w.s * w.k * 2.4) * w.a;
    return h;
  }

  return {
    group,
    waveHeight,
    update(camera, time) {
      const snap = 8;
      ocean.position.set(Math.round(camera.position.x / snap) * snap, 0, Math.round(camera.position.z / snap) * snap);
      ocean.updateMatrixWorld();
      void time;
    },
    dispose() {
      oceanGeo.dispose(); oceanMat.dispose(); waterN.dispose(); freshMat.dispose(); fallMat.dispose(); foamMat.dispose(); mistMat.dispose();
      riverGeos.forEach((g) => g.dispose()); fallGeos.forEach((g) => g.dispose()); foamGeo.dispose(); quadGeo.dispose();
    },
  };
}
