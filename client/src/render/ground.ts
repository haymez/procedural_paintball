// Ground material layers for the terrain: CC0 photo textures (public/tex/,
// packed as <id>_c.jpg sRGB color and <id>_nh.jpg normal xy + height) in two
// texture arrays, picked per island climate. Volcanic islands (lush /
// tropical) get dark basalt and red laterite dirt; mediterranean / dry ones
// pale limestone and pale gravel.
import * as THREE from "three";
import type { World } from "../../../shared/world/types";
import { loadTextureArray, texUrl } from "./assets";

/** Array layer indices (keep in sync with GROUND_GLSL). */
export const LAYER = { grass: 0, jungle: 1, forest: 2, sand: 3, rockTop: 4, rockFace: 5, dirt: 6, pave: 7 } as const;

interface LayerSet { ids: string[]; fallback: number[][] }

function layerSet(climate: World["climate"]): LayerSet {
  const volcanic = climate === "lush" || climate === "tropical" || climate === undefined;
  const ids = [
    "grass004",
    "forest_leaves_02",
    "forest_leaves_04",
    "coast_sand_01",
    volcanic ? "lichen_rock" : "rock_boulder_cracked",
    volcanic ? "dark_rock" : "rock_face_03",
    volcanic ? "red_laterite_soil_stones" : "rocky_trail",
    "rocky_trail",
  ];
  const fallback = [
    [86, 110, 52], [92, 74, 50], [120, 96, 66], [200, 182, 140],
    volcanic ? [72, 70, 64] : [176, 160, 134], volcanic ? [58, 56, 54] : [168, 150, 124],
    volcanic ? [120, 62, 44] : [150, 132, 108], [150, 132, 108],
  ];
  return { ids, fallback };
}

/** Per-climate shading knobs, uClimate: x vegetation on steep ground, y rock detail contrast, z volcanic (0/1), w dryness. */
export function climateKnobs(climate: World["climate"]): THREE.Vector4 {
  switch (climate) {
    case "lush": return new THREE.Vector4(1.0, 1.15, 1, 0);
    case "mediterranean": return new THREE.Vector4(0.35, 1.0, 0, 0.45);
    case "dry": return new THREE.Vector4(0.15, 1.0, 0, 1);
    case "tropical":
    default: return new THREE.Vector4(0.75, 1.15, 1, 0.1);
  }
}

const lin = (c: number) => (c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4));
const linHex = (hex: number) => new THREE.Vector3(lin(((hex >> 16) & 255) / 255), lin(((hex >> 8) & 255) / 255), lin((hex & 255) / 255));

/** Target mean colors (linear): rock top, rock face, dirt, sand. */
function groundTargets(climate: World["climate"]): THREE.Vector3[] {
  const volcanic = climate === "lush" || climate === "tropical" || climate === undefined;
  return volcanic
    ? [linHex(0x64604f), linHex(0x4f4a44), linHex(0x76503c), linHex(0xe6c993)]
    : [linHex(0xbcae94), linHex(0xae9e84), linHex(0xa48e6e), linHex(0xeedcb6)];
}

export interface GroundLayers {
  uniforms: {
    tLayerC: { value: THREE.Texture };
    tLayerN: { value: THREE.Texture };
    uLayerMean: { value: THREE.Vector3[] };
    uClimate: { value: THREE.Vector4 };
    uGroundT: { value: THREE.Vector3[] };
  };
  dispose(): void;
}

export function loadGroundLayers(world: World): GroundLayers {
  const set = layerSet(world.climate);
  const color = loadTextureArray(set.ids.map((id) => texUrl(`${id}/${id}_c.jpg`)), 1024, { srgb: true, fallback: set.fallback, anisotropy: 4 });
  const nh = loadTextureArray(set.ids.map((id) => texUrl(`${id}/${id}_nh.jpg`)), 1024, { srgb: false, fallback: set.ids.map(() => [128, 128, 128]), anisotropy: 1 });
  const toLinear = (v: THREE.Vector3) => new THREE.Vector3(lin(v.x), lin(v.y), lin(v.z));
  const uniforms: GroundLayers["uniforms"] = {
    tLayerC: { value: color.texture },
    tLayerN: { value: nh.texture },
    uLayerMean: { value: color.mean.map(toLinear) },
    uClimate: { value: climateKnobs(world.climate) },
    uGroundT: { value: groundTargets(world.climate) },
  };
  color.ready.then(() => {
    uniforms.tLayerC.value = color.texture;
    uniforms.uLayerMean.value = color.mean.map(toLinear);
  });
  nh.ready.then(() => { uniforms.tLayerN.value = nh.texture; });
  return {
    uniforms,
    dispose() { color.texture.dispose(); nh.texture.dispose(); },
  };
}

/**
 * GLSL helpers (needs uNoise / noiseT). Layer UVs are world meters / tile size.
 * groundC/groundN sample one layer with a second rotated, larger-scale sample
 * blended in by low-frequency noise to break up tiling.
 */
export const GROUND_GLSL = /* glsl */ `
uniform highp sampler2DArray tLayerC;
uniform highp sampler2DArray tLayerN;
uniform vec3 uLayerMean[8];
uniform vec4 uClimate;
uniform vec3 uGroundT[4]; // target means: rock top, rock face, dirt, sand
const mat2 ROT_A = mat2(0.8, -0.6, 0.6, 0.8);
vec4 layerC(float l, vec2 uv) { return texture(tLayerC, vec3(uv, l)); }
vec4 layerN(float l, vec2 uv) { return texture(tLayerN, vec3(uv, l)); }
// When 0, skip the normal/height maps (far ground: flat normal, mid height). Set by the caller.
float gNearN = 1.0;
// Color (rgb) + height (a) of a layer with anti-tiling: k in 0..1 blends in a second, rotated,
// larger-scale sample. Explicit gradients (uv derivatives) so it can run inside branches;
// each half is only fetched when its weight matters.
vec4 groundC(float l, vec2 uv, vec2 gx, vec2 gy, float k, out vec2 nxy, out float h) {
  vec3 c = vec3(0.0);
  nxy = vec2(0.0);
  h = gNearN > 0.5 ? 0.0 : 0.5;
  if (k < 0.995) {
    float w = k > 0.005 ? 1.0 - k : 1.0;
    c = textureGrad(tLayerC, vec3(uv, l), gx, gy).rgb * w;
    if (gNearN > 0.5) {
      vec4 n = textureGrad(tLayerN, vec3(uv, l), gx, gy);
      nxy = (n.xy * 2.0 - 1.0) * w;
      h = n.b * w;
    }
  }
  if (k > 0.005) {
    float w = k < 0.995 ? k : 1.0;
    vec2 uv2 = ROT_A * uv * 0.43 + vec2(0.31, 0.57);
    vec2 g2x = ROT_A * gx * 0.43, g2y = ROT_A * gy * 0.43;
    c += textureGrad(tLayerC, vec3(uv2, l), g2x, g2y).rgb * w;
    if (gNearN > 0.5) {
      vec4 n = textureGrad(tLayerN, vec3(uv2, l), g2x, g2y);
      nxy += ((n.xy * 2.0 - 1.0) * ROT_A) * w; // rotate the second sample's normal back
      h += n.b * w;
    }
  }
  return vec4(c, h);
}
// color relative to the layer mean (detail only, ~1 on average)
vec3 detailOf(vec3 c, float l) {
  vec3 m = max(uLayerMean[int(l)], vec3(0.004));
  vec3 d = c / m;
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722)) / max(dot(m, vec3(0.2126, 0.7152, 0.0722)), 0.004);
  return clamp(mix(vec3(lum), clamp(d, vec3(lum * 0.5), vec3(lum * 1.8)), 0.4), 0.0, 3.0);
}
// height-aware blend factor: new layer with coverage w and height hNew over the current one (height hOld)
float hblend(float w, float hNew, float hOld) {
  float a = 0.5 * hOld + 1.0 - w, b = 0.5 * hNew + w;
  float ma = max(a, b) - 0.18;
  float wa = max(a - ma, 0.0), wb = max(b - ma, 0.0);
  return wb / (wa + wb + 1e-5);
}
`;
