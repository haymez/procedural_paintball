// Blob skin shader: the shared toon material + per-vertex part masks for
// player/crest/belly color, paint coats (splats + drips), wet sheen, the Luca
// sea-monster scale shimmer, jelly wobble, hit flash and elimination swirl.
import * as THREE from "three";
import { makeToonMaterial } from "../style";

export interface BlobUniforms {
  uBody: { value: THREE.Color };
  uBelly: { value: THREE.Color };
  uCrest: { value: THREE.Color };
  uCoatCol: { value: THREE.Color[] };
  uCoatC: { value: THREE.Vector3[] };
  uCoatAmt: { value: THREE.Vector3 };
  uWet: { value: number };
  uSea: { value: number };
  uTime: { value: number };
  uWobble: { value: number };
  uFlash: { value: number };
  uPop: { value: number };
  uPopCol: { value: THREE.Color };
  uSeed: { value: number };
}

export function makeBlobUniforms(): BlobUniforms {
  return {
    uBody: { value: new THREE.Color() },
    uBelly: { value: new THREE.Color() },
    uCrest: { value: new THREE.Color() },
    uCoatCol: { value: [new THREE.Color(), new THREE.Color(), new THREE.Color()] },
    uCoatC: { value: [new THREE.Vector3(0, 1, 0.3), new THREE.Vector3(0, 1, 0.3), new THREE.Vector3(0, 1, 0.3)] },
    uCoatAmt: { value: new THREE.Vector3() },
    uWet: { value: 0 },
    uSea: { value: 0 },
    uTime: { value: 0 },
    uWobble: { value: 0 },
    uFlash: { value: 0 },
    uPop: { value: 0 },
    uPopCol: { value: new THREE.Color() },
    uSeed: { value: 0 },
  };
}

const VERT_PARS = /* glsl */ `
attribute vec4 aPart;
varying vec4 vPart;
varying vec3 vRest;
uniform float uTime;
uniform float uWobble;
`;

const VERT_MAIN = /* glsl */ `
#include <begin_vertex>
vPart = aPart;
vRest = position;
// jelly wobble: a travelling ripple over the skin after hits / landings
transformed += normal * (sin(uTime * 23.0 - position.y * 11.0 + position.x * 5.0) * uWobble * 0.03 * aPart.x);
`;

const FRAG_PARS = /* glsl */ `
varying vec4 vPart;
varying vec3 vRest;
uniform vec3 uBody;
uniform vec3 uBelly;
uniform vec3 uCrest;
uniform vec3 uCoatCol[3];
uniform vec3 uCoatC[3];
uniform vec3 uCoatAmt;
uniform float uWet;
uniform float uSea;
uniform float uTime;
uniform float uFlash;
uniform float uPop;
uniform vec3 uPopCol;
uniform float uSeed;

float bHash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float bNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(bHash(i), bHash(i + vec3(1,0,0)), f.x),
                 mix(bHash(i + vec3(0,1,0)), bHash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(bHash(i + vec3(0,0,1)), bHash(i + vec3(1,0,1)), f.x),
                 mix(bHash(i + vec3(0,1,1)), bHash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float bHash1(float n) { return fract(sin(n * 91.345) * 43758.5453); }

// One paint coat: a blobby splat with satellite droplets and drips running down.
float coatMask(vec3 p, vec3 c, float amt, float seed) {
  if (amt < 0.002) return 0.0;
  vec3 d = p - c;
  float dist = length(d);
  float r = 0.25 * amt + 0.04 * amt * amt;
  float n = bNoise(p * 7.0 + seed * 13.1);
  float rr = r * (0.72 + 0.6 * n);
  float m = smoothstep(rr + 0.012, rr - 0.012, dist);
  float n2 = bNoise(p * 19.0 + seed * 5.7);
  m = max(m, step(0.76, n2) * smoothstep(r * 1.9, r * 1.05, dist));
  // drips: columns around the body axis, below the splat centre
  float thp = atan(p.x, p.z);
  float thc = atan(c.x, c.z);
  float dth = thp - thc;
  dth = dth - 6.2831853 * floor((dth + 3.1415926) / 6.2831853);
  float arc = dth * 0.32;
  float colW = 0.045;
  float col = floor(arc / colW);
  float len = (bHash1(col + seed * 7.0) * 0.28 + 0.03) * amt;
  float fx = abs(fract(arc / colW) - 0.5);
  float below = c.y - p.y;
  float inside = step(abs(arc), r * 0.85) * step(0.0, below) * step(below, r * 0.55 + len);
  float taper = 0.34 - 0.12 * clamp((below - r * 0.5) / max(len, 0.01), 0.0, 1.0);
  m = max(m, inside * step(fx, taper) * step(0.35, bHash1(col * 3.1 + seed)));
  return clamp(m, 0.0, 1.0);
}
`;

const FRAG_COLOR = /* glsl */ `
#include <color_fragment>
{
  vec3 p = vRest;
  float bw = vPart.x;
  float cw = vPart.y;
  float pm = vPart.w;
  vec3 skin = mix(uBody, uBelly, vPart.z);
  vec3 crestC = uCrest;

  // --- Luca sea-monster skin: sweeps up from the feet as uSea rises -------
  float th = atan(p.x, p.z);
  float front = uSea * 2.3 - 0.25;
  float seaN = bNoise(p * 9.0 + uSeed);
  float sea = smoothstep(front + 0.12, front - 0.12, p.y + (seaN - 0.5) * 0.3);
  if (sea > 0.001) {
    // overlapping round scales, rows offset; softer on the face
    vec2 sc = vec2(th * 0.32 / 0.085, p.y / 0.07);
    float row = floor(sc.y);
    sc.x += 0.5 * mod(row, 2.0);
    vec2 f = fract(sc) - vec2(0.5, 0.15);
    float dd = length(f * vec2(1.0, 1.25));
    float face = smoothstep(1.18, 1.3, p.y) * smoothstep(0.12, 0.25, p.z);
    float edge = smoothstep(0.5, 0.62, dd) * (1.0 - face * 0.8);
    float tint = bHash(vec3(floor(sc), 3.0));
    vec3 seaBack = mix(vec3(0.16, 0.55, 0.62), uBody * vec3(0.55, 0.85, 0.95), 0.22);
    vec3 seaBelly = vec3(0.55, 0.9, 0.8);
    vec3 seaC = mix(seaBack, seaBelly, max(vPart.z, face * 0.5));
    seaC *= (1.0 - 0.14 * edge) * (0.95 + 0.1 * tint);
    float shim = sin(uTime * 3.0 + p.y * 12.0 - th * 3.0) * 0.5 + 0.5;
    seaC += vec3(0.3, 0.6, 0.55) * pow(shim, 6.0) * (1.0 - edge) * 0.35;
    skin = mix(skin, seaC, sea);
    crestC = mix(crestC, vec3(0.95, 0.42, 0.55), sea * 0.8);
  }

  // rosy cheeks
  vec3 ck = vec3(abs(p.x) - 0.215, p.y - 1.325, p.z - 0.265);
  float blush = smoothstep(0.075, 0.035, length(ck * vec3(1.0, 1.4, 1.6)));
  skin = mix(skin, vec3(1.0, 0.45, 0.5), blush * 0.32 * (1.0 - sea * 0.5));

  vec3 col = diffuseColor.rgb * (1.0 - bw - cw) + skin * bw + crestC * cw;

  // --- paint coats --------------------------------------------------------
  float paint = 0.0;
  for (int i = 0; i < 3; i++) {
    float a = uCoatAmt[i];
    float m = coatMask(p, uCoatC[i], a, float(i) * 3.7 + uSeed) * pm;
    col = mix(col, uCoatCol[i], m);
    paint = max(paint, m);
  }

  // --- elimination: the whole blob swirls into paint -------------------------
  if (uPop > 0.001) {
    float sw = bNoise(p * 5.0 + vec3(0.0, uTime * 2.0, 0.0));
    vec3 pc = mix(uPopCol, uBody, step(0.55, sw));
    col = mix(col, pc, uPop * (bw + cw + pm * 0.5));
  }

  // wet skin reads slightly deeper / more saturated
  col *= 1.0 - 0.1 * uWet * bw;
  diffuseColor.rgb = col;
  vPaintAmt = paint;
  vSeaAmt = sea;
}
`;

const FRAG_OUT = /* glsl */ `
{
  vec3 V = normalize(vViewPosition);
  vec3 Nn = normal;
  float ndv = clamp(dot(Nn, V), 0.0, 1.0);
  float skinW = clamp(vPart.x + vPart.y, 0.0, 1.0);
  // soft warm rim: gummy / clay translucency
  float rim = smoothstep(0.62, 0.95, 1.0 - ndv);
  outgoingLight += mix(diffuseColor.rgb, vec3(1.0, 0.93, 0.8), 0.5) * rim * 0.28 * skinW;
  #if NUM_DIR_LIGHTS > 0
    vec3 L = directionalLights[0].direction;
  #else
    vec3 L = normalize(vec3(0.3, 0.8, 0.5));
  #endif
  vec3 H = normalize(L + V);
  float nh = max(dot(Nn, H), 0.0);
  float gloss = max(max(uWet * skinW, vPaintAmt * 0.9), vSeaAmt * 0.6 * skinW);
  // stepped toon highlight: a crisp blob plus a soft halo
  float spec = smoothstep(0.955, 0.97, nh) * 0.45 + smoothstep(0.8, 0.92, nh) * 0.08;
  outgoingLight += vec3(1.0, 0.98, 0.92) * spec * gloss;
  // tiny always-on gloss on the gummy skin
  outgoingLight += vec3(1.0) * smoothstep(0.975, 0.985, nh) * 0.18 * skinW;
  outgoingLight = mix(outgoingLight, vec3(1.0, 0.97, 0.9), uFlash * skinW);
}
#include <opaque_fragment>
`;

/** Create the (per-blob) skin material. Shares one compiled program across blobs. */
export function makeBlobMaterial(u: BlobUniforms): THREE.MeshToonMaterial {
  const m = makeToonMaterial({ vertexColors: true });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\n" + VERT_PARS)
      .replace("#include <begin_vertex>", VERT_MAIN);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\n" + FRAG_PARS + "\nfloat vPaintAmt = 0.0;\nfloat vSeaAmt = 0.0;\n")
      .replace("#include <color_fragment>", FRAG_COLOR)
      .replace("#include <opaque_fragment>", FRAG_OUT);
  };
  m.customProgramCacheKey = () => "isola-blob-v1";
  return m;
}
