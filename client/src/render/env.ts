// Time-of-day environment: sun direction/colors, sky gradient, fog and the
// shared uniform bag every world shader references (by object identity, so a
// change here reaches every material without recompiling).
import * as THREE from "three";

export interface Env {
  sunDir: THREE.Vector3;
  sunLight: THREE.Color; // directional light color (linear), multiply by sunIntensity
  sunIntensity: number;
  sunDisc: THREE.Color;
  sunGlow: THREE.Color;
  skyZenith: THREE.Color;
  skyHorizon: THREE.Color;
  haze: THREE.Color;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemiIntensity: number;
  fogDensity: number;
  exposure: number;
  warmth: number; // 0 morning .. 1 golden afternoon
}

const c = (hex: number) => new THREE.Color(hex);
const lerpC = (a: number, b: number, t: number) => c(a).lerp(c(b), t);

export function computeEnv(timeOfDay: number): Env {
  const t = THREE.MathUtils.clamp(timeOfDay, 7.5, 18);
  // Sun arc: rises east (+X), noon to the south (+Z), sets west (-X).
  const dayT = (t - 6) / 13; // 0 at 6:00, 1 at 19:00
  const elev = Math.sin(Math.PI * dayT) * THREE.MathUtils.degToRad(64);
  const az = Math.PI * (dayT - 0.5); // -pi/2 morning .. +pi/2 evening
  const sunDir = new THREE.Vector3(
    -Math.sin(az) * Math.cos(elev),
    Math.sin(elev),
    Math.cos(az) * Math.cos(elev) * 0.85 + 0.15,
  ).normalize();

  const morning = 1 - THREE.MathUtils.smoothstep(t, 8.5, 11.5);
  const golden = THREE.MathUtils.smoothstep(t, 13.5, 17.5);
  const warmth = golden;

  const sunLight = lerpC(0xfff3df, 0xffc98a, golden).lerp(c(0xf2f4ff), morning * 0.35);
  const sunDisc = lerpC(0xfff6e6, 0xffd9a0, golden);
  const sunGlow = lerpC(0xffe9c4, 0xffb46b, golden).multiplyScalar(0.9);
  const skyZenith = lerpC(0x2f86dd, 0x3a86cf, golden).lerp(c(0x2a7fe0), morning * 0.5);
  const skyHorizon = lerpC(0xb3e1f6, 0xf3dcc0, golden * 0.8).lerp(c(0xc9ebfa), morning * 0.4);
  const haze = lerpC(0xd4edf6, 0xf6d9b6, golden).lerp(c(0xdcefff), morning * 0.4);
  const hemiSky = lerpC(0x9fd0f5, 0xa9c3e6, golden).lerp(c(0xa6d4ff), morning * 0.3);
  const hemiGround = lerpC(0xc6a978, 0xd09a68, golden);

  return {
    sunDir,
    sunLight,
    sunIntensity: 2.9 - golden * 0.2,
    sunDisc,
    sunGlow,
    skyZenith,
    skyHorizon,
    haze,
    hemiSky,
    hemiGround,
    hemiIntensity: 2.1,
    fogDensity: 0.00055 + golden * 0.0001,
    exposure: 1.0,
    warmth,
  };
}

/** A 256x256 RGBA tiling noise texture: r fbm, g cellular, b fine, a low fbm. */
export function makeNoiseTexture(): THREE.DataTexture {
  const N = 256;
  const data = new Uint8Array(N * N * 4);
  let s = 1337;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const lattice = (per: number) => {
    const g = new Float32Array(per * per);
    for (let i = 0; i < g.length; i++) g[i] = rnd();
    return (x: number, y: number) => {
      const xi = Math.floor(x), yi = Math.floor(y);
      const fx = x - xi, fy = y - yi;
      const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
      const i0 = ((xi % per) + per) % per, j0 = ((yi % per) + per) % per;
      const i1 = (i0 + 1) % per, j1 = (j0 + 1) % per;
      const a = g[j0 * per + i0], b = g[j0 * per + i1], c2 = g[j1 * per + i0], d = g[j1 * per + i1];
      return a + (b - a) * ux + (c2 - a) * uy + (a - b - c2 + d) * ux * uy;
    };
  };
  const fbm = (base: number, oct: number) => {
    const ls = Array.from({ length: oct }, (_, o) => lattice(base << o));
    return (u: number, v: number) => {
      let sum = 0, amp = 0.5, norm = 0;
      for (let o = 0; o < oct; o++) {
        const f = base << o;
        sum += ls[o](u * f, v * f) * amp;
        norm += amp;
        amp *= 0.5;
      }
      return sum / norm;
    };
  };
  const f1 = fbm(8, 5);
  const f2 = fbm(4, 4);
  const fine = fbm(64, 2);
  // cellular: 16x16 jittered points, F2-F1 edge distance
  const CN = 16;
  const pts = new Float32Array(CN * CN * 2);
  for (let i = 0; i < CN * CN; i++) { pts[i * 2] = rnd(); pts[i * 2 + 1] = rnd(); }
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = x / N, v = y / N;
      const cx = u * CN, cy = v * CN;
      const ix = Math.floor(cx), iy = Math.floor(cy);
      let d1 = 9, d2 = 9;
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        const gx = ix + ox, gy = iy + oy;
        const wx = ((gx % CN) + CN) % CN, wy = ((gy % CN) + CN) % CN;
        const px = gx + pts[(wy * CN + wx) * 2], py = gy + pts[(wy * CN + wx) * 2 + 1];
        const d = Math.hypot(px - cx, py - cy);
        if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
      }
      const i = (y * N + x) * 4;
      const contrast = (q: number) => Math.min(1, Math.max(0, (q - 0.5) * 1.6 + 0.5));
      data[i] = contrast(f1(u, v)) * 255;
      data[i + 1] = Math.min(1, (d2 - d1) * 1.6) * 255;
      data[i + 2] = fine(u, v) * 255;
      data[i + 3] = contrast(f2(u, v)) * 255;
    }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

export interface EnvUniforms {
  uTime: { value: number };
  uSunDir: { value: THREE.Vector3 };
  uSunColor: { value: THREE.Color };
  uSkyZenith: { value: THREE.Color };
  uSkyHorizon: { value: THREE.Color };
  uHazeColor: { value: THREE.Color };
  uSunGlow: { value: THREE.Color };
  uWind: { value: THREE.Vector2 };
  uNoise: { value: THREE.Texture };
  uFog: { value: THREE.Vector4 };
  uFocus: { value: THREE.Vector4 };
  /** Canopy-cover map (see props/canopy.ts); a 1x1 "no cover" placeholder until props set it. */
  uCanopy: { value: THREE.Texture };
  /** x shade strength (0 = off), y sun-shadow distance (m), z/w unused. */
  uCanopyP: { value: THREE.Vector4 };
  [k: string]: THREE.IUniform;
}

export function makeEnvUniforms(env: Env, windDir: number, noise: THREE.Texture): EnvUniforms {
  return {
    uTime: { value: 0 },
    uSunDir: { value: env.sunDir.clone() },
    uSunColor: { value: env.sunDisc.clone() },
    uSkyZenith: { value: env.skyZenith.clone() },
    uSkyHorizon: { value: env.skyHorizon.clone() },
    uHazeColor: { value: env.haze.clone() },
    uSunGlow: { value: env.sunGlow.clone() },
    uWind: { value: new THREE.Vector2(Math.sin(windDir), Math.cos(windDir)) },
    uNoise: { value: noise },
    // density at sea level, height falloff, base height, start distance
    uFog: { value: new THREE.Vector4(env.fogDensity, 0.012, 0, 60) },
    // player head for the camera-to-player foliage fade; w = 1 when active
    uFocus: { value: new THREE.Vector4(0, 0, 0, 0) },
    uCanopy: { value: noCanopyTexture() },
    uCanopyP: { value: new THREE.Vector4(0, 120, 0, 0) },
  };
}

let noCanopy: THREE.DataTexture | null = null;
function noCanopyTexture(): THREE.DataTexture {
  if (noCanopy) return noCanopy;
  noCanopy = new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat);
  noCanopy.needsUpdate = true;
  return noCanopy;
}
