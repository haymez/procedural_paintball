// Instanced foliage & props. Instances are bucketed into 64 m cells per kind.
// Each update (when the camera moved/turned enough) the visible cells are
// packed near-first into one dynamic instance buffer per (kind, LOD), so draw
// calls stay bounded at 2 per kind. Only the leading (near) instances are
// drawn into the sun shadow map (onBeforeShadow trims instanceCount).
// Foliage is static (no wind sway); per-instance tint and distance shrink
// happen in the vertex shader.
import * as THREE from "three";
import { Biome, GRID_RES, PROP_STRIDE, PropKind, WORLD_HALF, WORLD_SIZE, type World } from "../../../../shared/world/types";
import { makeStyledMaterial, type PatchHooks } from "../patch";
import { ENV_PARS, NOISE_FNS } from "../glsl";
import { propModels } from "./models";
import { foliageTextures, LEAF_RES, type FoliageTextures } from "./atlas";
import type { WorldTextures } from "../worldTextures";
import { createGrass } from "./grass";
import { groundCover } from "./decor";
import { buildCanopyTexture } from "./canopy";
import { GROUND_GLSL, LAYER, type GroundLayers } from "../ground";

export interface PropsOptions {
  density: number; distance: number; shadowDistance: number; groundCover?: number;
  /** canopy shade strength (default 1, 0 = off) */ canopyShade?: number;
  /** MSAA samples of the scene target: leaf cards use alpha-to-coverage when > 0 */ msaa?: number;
  /** world grid textures (ground color, height): enables the GPU grass */ textures?: WorldTextures;
  /** paint layer uniforms (grass blades take the paint color) */ paint?: Record<string, THREE.IUniform>;
  /** terrain ground layers (terrain.ground): rocks use the island's rock textures */ ground?: GroundLayers["uniforms"];
}

/** stretch: per-instance vertical scale variation (± fraction) so stands of one tree kind vary in height */
/** biome: recolor foliage by the biome underneath (ground plants shared across biomes) */
interface KindCfg { maxDist: number; lodDist: number; shadow: boolean; thin: boolean; lod2?: number; stretch?: number; biome?: boolean }
const CFG: Record<PropKind, KindCfg> = {
  [PropKind.Palm]: { maxDist: 900, lodDist: 98, shadow: true, thin: false, lod2: 190 },
  [PropKind.PalmLeaning]: { maxDist: 900, lodDist: 98, shadow: true, thin: false, lod2: 190 },
  [PropKind.Broadleaf]: { maxDist: 900, lodDist: 52, shadow: true, thin: false, lod2: 110, stretch: 0.14 },
  [PropKind.UmbrellaPine]: { maxDist: 900, lodDist: 112, shadow: true, thin: false, lod2: 220 },
  [PropKind.Cypress]: { maxDist: 900, lodDist: 105, shadow: true, thin: false, lod2: 220 },
  [PropKind.Olive]: { maxDist: 550, lodDist: 70, shadow: true, thin: false, lod2: 150 },
  [PropKind.LemonTree]: { maxDist: 400, lodDist: 49, shadow: true, thin: false, lod2: 120 },
  [PropKind.Mangrove]: { maxDist: 550, lodDist: 70, shadow: true, thin: false, lod2: 150 },
  [PropKind.Banana]: { maxDist: 280, lodDist: 42, shadow: true, thin: false, lod2: 110 },
  [PropKind.Bush]: { maxDist: 360, lodDist: 30, shadow: true, thin: true, lod2: 80, biome: true },
  [PropKind.Bougainvillea]: { maxDist: 300, lodDist: 42, shadow: true, thin: false, lod2: 100 },
  [PropKind.Fern]: { maxDist: 62, lodDist: 15, shadow: false, thin: true, lod2: 30, biome: true },
  [PropKind.Agave]: { maxDist: 170, lodDist: 31, shadow: true, thin: true },
  [PropKind.GrassTuft]: { maxDist: 60, lodDist: 14, shadow: false, thin: true, biome: true },
  [PropKind.Flowers]: { maxDist: 65, lodDist: 17, shadow: false, thin: true },
  [PropKind.RockSmall]: { maxDist: 120, lodDist: 28, shadow: false, thin: true },
  [PropKind.RockMedium]: { maxDist: 420, lodDist: 62, shadow: true, thin: false },
  [PropKind.Boulder]: { maxDist: 900, lodDist: 105, shadow: true, thin: false },
  [PropKind.Driftwood]: { maxDist: 160, lodDist: 35, shadow: true, thin: true },
  [PropKind.Reed]: { maxDist: 95, lodDist: 24, shadow: false, thin: true },
  [PropKind.JungleGiant]: { maxDist: 1100, lodDist: 95, shadow: true, thin: false, lod2: 210, stretch: 0.1 },
  [PropKind.TreeFern]: { maxDist: 300, lodDist: 38, shadow: true, thin: false, lod2: 110, stretch: 0.14 },
  [PropKind.HolmOak]: { maxDist: 800, lodDist: 64, shadow: true, thin: false, lod2: 170, stretch: 0.08 },
  [PropKind.Pine]: { maxDist: 900, lodDist: 84, shadow: true, thin: false, lod2: 210, stretch: 0.12 },
  [PropKind.Understory]: { maxDist: 68, lodDist: 20, shadow: false, thin: true, lod2: 38 },
  [PropKind.Log]: { maxDist: 150, lodDist: 32, shadow: true, thin: true, lod2: 80 },
  [PropKind.TiPlant]: { maxDist: 130, lodDist: 24, shadow: true, thin: true, lod2: 60 },
};

const CELL = 64;
const NC = WORLD_SIZE / CELL;
const IF = 8; // floats per instance: x y z rot | scale var phase seed

const FLOWER_TINTS = [0xfff6e8, 0xffe14a, 0xff5f86, 0xb884ff, 0xff8a3c, 0xff4f5a];

/** 256^2 biome weights for tinting shared ground plants: r jungle, g forest, b scrub. */
function buildBiomeTint(world: World): THREE.DataTexture {
  const R = 256, step = (GRID_RES - 1) / R;
  const data = new Uint8Array(R * R * 4);
  for (let j = 0; j < R; j++) for (let i = 0; i < R; i++) {
    let jn = 0, fo = 0, sc = 0, n = 0;
    for (let dz = 0; dz < step; dz++) for (let dx = 0; dx < step; dx++) {
      const b = world.biome[(Math.floor(j * step) + dz) * GRID_RES + Math.floor(i * step) + dx];
      jn += b === Biome.Jungle ? 1 : 0; fo += b === Biome.Forest ? 1 : 0; sc += b === Biome.Scrub ? 1 : 0; n++;
    }
    const o = (j * R + i) * 4;
    data[o] = (jn / n) * 255; data[o + 1] = (fo / n) * 255; data[o + 2] = (sc / n) * 255; data[o + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, R, R, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** Per-kind look: value / warm-cool jitter between instances, fraction of pale (kukui-like) crowns. */
const VARIETY: Partial<Record<PropKind, [number, number, number]>> = {
  [PropKind.Broadleaf]: [0.12, 0.55, 0.16],
  [PropKind.JungleGiant]: [0.1, 0.4, 0.0],
  [PropKind.Palm]: [0.08, 0.5, 0],
  [PropKind.PalmLeaning]: [0.08, 0.5, 0],
  [PropKind.HolmOak]: [0.1, 0.3, 0],
  [PropKind.Pine]: [0.1, 0.35, 0],
  [PropKind.UmbrellaPine]: [0.08, 0.3, 0],
  [PropKind.Olive]: [0.08, 0.25, 0],
  [PropKind.TreeFern]: [0.1, 0.4, 0],
  [PropKind.Banana]: [0.08, 0.4, 0],
  [PropKind.Bush]: [0.12, 0.5, 0.1],
  [PropKind.Fern]: [0.12, 0.4, 0],
  [PropKind.Understory]: [0.1, 0.3, 0],
  [PropKind.TiPlant]: [0.12, 0.3, 0],
};

const PROP_VERT_PARS = /* glsl */ `
  attribute vec4 iA; // x y z rot
  attribute vec4 iB; // scale, colorVar, phase, seed
  attribute vec3 wind; // (unused sway), leafiness, tint mask
  attribute vec4 tuv; // u v layer flags
  uniform vec2 uFade; // start, end distance
  uniform float uStretch;
  varying vec3 vVar;
  varying float vLeaf;
  varying float vTint;
  varying vec4 vUv;
`;
const PROP_VERT_TRANSFORM = /* glsl */ `
  {
    float c = cos(iA.w), s = sin(iA.w);
    float d = length(iA.xz - cameraPosition.xz);
    float shrink = 1.0 - smoothstep(uFade.x, uFade.y, d);
    vec3 p = transformed * iB.x * shrink;
    p.y *= 1.0 + iB.y * uStretch;
    p = vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
    transformed = iA.xyz + p;
    vUv = tuv;
    #ifndef IS_DEPTH
    vVar = vec3(iB.y, iB.w, 0.0);
    vLeaf = wind.y;
    vTint = wind.z;
    #endif
  }
`;

function hooks(key: string, tex: FoliageTextures): PatchHooks {
  return {
    key: "props-" + key,
    uniforms: {},
    vertexPars: PROP_VERT_PARS,
    vertexNormal: /* glsl */ `
      {
        float c = cos(iA.w), s = sin(iA.w);
        objectNormal = vec3(c * objectNormal.x + s * objectNormal.z, objectNormal.y, -s * objectNormal.x + c * objectNormal.z);
      }
    `,
    vertexTransform: PROP_VERT_TRANSFORM,
    fragPars: /* glsl */ `
      varying vec3 vVar; varying float vLeaf; varying float vTint; varying vec4 vUv;
      uniform vec3 uTints[6];
      uniform float uBiomeTint;
      uniform sampler2D tBiome; // r jungle, g Mediterranean forest, b scrub
      uniform vec4 uFocus;
      uniform highp sampler2DArray tLeaf;
      uniform highp sampler2DArray tBark;
      uniform vec3 uBarkMean[${tex.barkMean.length}];
      uniform vec3 uVariety; // value jitter, warm/cool jitter, pale-crown fraction
      uniform float uFlowers; // fraction of instances that show their optional flower cards
      // dithered see-through for leafy parts near the lens or between the lens and the player
      float foliageFade(vec3 p) {
        float a = smoothstep(1.3, 2.8, distance(p, cameraPosition));
        if (uFocus.w > 0.5) {
          vec3 ab = uFocus.xyz - cameraPosition;
          float L = length(ab);
          vec3 dir = ab / max(L, 1e-3);
          float t = dot(p - cameraPosition, dir);
          if (t > 0.0 && t < L - 0.35) {
            float r = length(p - cameraPosition - dir * t);
            a = min(a, smoothstep(0.75, 1.5, r));
          }
        }
        return a;
      }
    `,
    fragColor: /* glsl */ `
      if (mod(floor(vUv.w * 0.25 + 0.1), 2.0) > 0.5 && vVar.y >= uFlowers) discard;
      float leafA = 1.0;
      {
        // derivatives in uniform control flow, then pick the texture by layer
        vec2 uvx = dFdx(vUv.xy), uvy = dFdy(vUv.xy);
        float lay = floor(vUv.z + 0.5);
        if (lay > 15.5) {
          vec4 t = textureGrad(tLeaf, vec3(vUv.xy, lay - 16.0), uvx, uvy);
          // keep alpha coverage as the texture minifies (mips average leaves into the gaps)
          float mip = max(0.0, 0.5 * log2(max(dot(uvx, uvx), dot(uvy, uvy)) * ${(LEAF_RES * LEAF_RES).toFixed(1)}));
          leafA = t.a * (1.0 + mip * 0.32);
          vec3 tc = t.rgb;
          if (mod(floor(vUv.w * 0.5 + 0.25), 2.0) > 0.5) {
            // dry / dead foliage: straw brown from the painted value
            float l = dot(tc, vec3(0.3, 0.59, 0.11));
            tc = vec3(l) * vec3(1.45, 1.15, 0.72);
          }
          diffuseColor.rgb *= tc;
        } else if (lay > -0.5) {
          vec3 t = textureGrad(tBark, vec3(vUv.xy, lay), uvx, uvy).rgb;
          diffuseColor.rgb *= t / uBarkMean[int(lay)];
        }
      }
      {
        float fw = fwidth(leafA);
        leafA = clamp((leafA - 0.5) / max(fw, 1e-4) + 0.5, 0.0, 1.0);
        #ifdef ALPHA_TO_COVERAGE
        if (leafA < 0.02) discard;
        diffuseColor.a = leafA;
        #else
        if (leafA < 0.5) discard;
        #endif
      }
      if (vLeaf > 0.1) {
        float fa = foliageFade(vWPos);
        if (fa < 1.0) {
          float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
          if (fa <= ign) discard;
        }
      }
      {
        float v = vVar.x; // -1..1 per instance
        vec3 c = diffuseColor.rgb;
        c *= 1.0 + v * uVariety.x;
        if (vLeaf > 0.1) {
          c = mix(c, c * vec3(1.12, 1.05, 0.78), max(v, 0.0) * uVariety.y); // sunnier, yellower
          c = mix(c, c * vec3(0.84, 0.97, 0.9), max(-v, 0.0) * uVariety.y); // deeper, darker green
          if (vVar.y < uVariety.z) {
            // pale yellow-green crowns (kukui, hau) scattered through the forest
            float l = dot(c, vec3(0.3, 0.59, 0.11));
            c = mix(c, vec3(l) * vec3(1.15, 1.3, 0.62) * 1.3, 0.4);
          }
        }
        if (vTint > 0.5) c = uTints[int(floor(vVar.y * 5.999))];
        if (uBiomeTint > 0.5 && vLeaf > 0.1) {
          vec3 bw = texture2D(tBiome, (vWPos.xz + ${WORLD_HALF.toFixed(1)}) / ${WORLD_SIZE.toFixed(1)}).rgb;
          float l = dot(c, vec3(0.3, 0.59, 0.11));
          // Mediterranean woodland / scrub: dusty grey-olive maquis, sun-dried grass
          vec3 olive = mix(vec3(l), c, 0.55) * vec3(1.0, 0.96, 0.7);
          c = mix(c, olive, clamp(bw.g + bw.b * 0.6, 0.0, 1.0));
          // jungle: deeper, cooler green
          c = mix(c, c * vec3(0.8, 0.95, 0.86), bw.r);
        }
        diffuseColor.rgb = c;
        gTransl = diffuseColor.rgb * vLeaf * 1.6;
      }
    `,
    fragNormal: /* glsl */ `
      if (mod(vUv.w, 2.0) > 0.5) {
        // crown cards: bent normals light both faces alike
        normal *= faceDirection;
      } else if (vLeaf > 0.15) {
        // fronds / blades: light leaves as if their face points to the sky
        vec3 upV = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
        if (dot(normal, upV) < 0.0) normal = -normal;
        normal = normalize(mix(normal, upV, 0.25));
      }
    `,
  };
}

function copyInst(src: Float32Array, i: number, dst: Float32Array, o: number): void {
  for (let k = 0; k < IF; k++) dst[o + k] = src[i + k];
}

const ROCK_KINDS = new Set([PropKind.RockSmall, PropKind.RockMedium, PropKind.Boulder]);

/**
 * Rocks: the terrain's own rock textures (ground.ts arrays), world-space
 * triplanar so boulders match the cliffs, with moss / lichen on their tops.
 */
function rockHooks(): PatchHooks {
  return {
    key: "props-rock",
    uniforms: {},
    vertexPars: PROP_VERT_PARS + "\nvarying vec3 vRockN;\nvarying float vRockBase;",
    vertexNormal: /* glsl */ `
      {
        float c = cos(iA.w), s = sin(iA.w);
        objectNormal = vec3(c * objectNormal.x + s * objectNormal.z, objectNormal.y, -s * objectNormal.x + c * objectNormal.z);
      }
    `,
    vertexTransform: PROP_VERT_TRANSFORM,
    vertexEnd: /* glsl */ `vRockN = normalize(objectNormal); vRockBase = iA.y;`,
    fragPars: /* glsl */ `
      varying vec3 vVar; varying vec4 vUv; varying vec3 vRockN; varying float vRockBase;
      ${GROUND_GLSL}
      vec3 gRockN;
    `,
    fragColor: /* glsl */ `
      {
        vec3 N = normalize(vRockN);
        vec3 w = pow(abs(N), vec3(4.0)); w /= (w.x + w.y + w.z);
        vec3 P = vWPos + vVar.y * 17.0; // per-instance offset so neighbours differ
        float sc = 1.0 / 3.2;
        float lf = ${LAYER.rockFace}.0, lt = ${LAYER.rockTop}.0;
        vec4 cx = layerC(lf, P.zy * sc), cy = layerC(lt, P.xz * sc), cz = layerC(lf, P.xy * sc);
        vec4 nx = layerN(lf, P.zy * sc), ny = layerN(lt, P.xz * sc), nz = layerN(lf, P.xy * sc);
        vec3 face = uGroundT[1] * pow(detailOf(cx.rgb * w.x + cz.rgb * w.z, lf) * (w.x + w.z) + vec3(w.y), vec3(uClimate.y));
        vec3 top = uGroundT[0] * pow(detailOf(cy.rgb, lt), vec3(uClimate.y));
        vec3 c = mix(face, top, w.y);
        c *= 0.85 + 0.3 * noiseT(P.xz * 0.11).a;
        c *= 1.0 + vVar.x * 0.12;
        // moss / lichen on the upper faces (strongest on lush islands); damp dark foot
        float moss = smoothstep(0.45, 0.8, N.y + (noiseT(P.xz * 0.6).r - 0.5) * 0.5) * (0.25 + 0.6 * uClimate.x);
        vec3 mossC = mix(${"vec3(0.12, 0.17, 0.05)"}, vec3(0.22, 0.24, 0.12), uClimate.w);
        c = mix(c, mossC * (0.8 + 0.4 * cy.a), moss * 0.85);
        c *= mix(0.55, 1.0, smoothstep(-0.2, 0.6, vWPos.y - vRockBase));
        diffuseColor.rgb = c * diffuseColor.rgb;
        // triplanar detail normals (UDN blend)
        vec2 tx = nx.xy * 2.0 - 1.0, ty = ny.xy * 2.0 - 1.0, tz = nz.xy * 2.0 - 1.0;
        gRockN = normalize(N + (vec3(0.0, tx.y, tx.x) * w.x + vec3(ty.x, 0.0, ty.y) * w.y + vec3(tz.x, tz.y, 0.0) * w.z) * 0.9);
      }
    `,
    fragNormal: /* glsl */ `
      normal = normalize((viewMatrix * vec4(gRockN, 0.0)).xyz);
    `,
  };
}

/** Shadow-map depth material: same vertex transform, leaf cards alpha-tested. */
function leafDepthMaterial(env: Record<string, THREE.IUniform>, hk: PatchHooks): THREE.MeshDepthMaterial {
  const d = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  d.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, env, hk.uniforms ?? {});
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${ENV_PARS}\n${NOISE_FNS}\n${PROP_VERT_PARS}`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\n${PROP_VERT_TRANSFORM}`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\nvarying vec4 vUv;\nuniform highp sampler2DArray tLeaf;`)
      .replace("#include <clipping_planes_fragment>", `#include <clipping_planes_fragment>\n  if (vUv.z > 15.5 && texture(tLeaf, vec3(vUv.xy, floor(vUv.z + 0.5) - 16.0)).a < 0.5) discard;`);
  };
  d.defines = { IS_DEPTH: 1 };
  // PCF sun shadows only read the depth attachment: skip writing packed depth to the unused color one
  d.colorWrite = false;
  d.customProgramCacheKey = () => hk.key + "-leafdepth";
  return d;
}

interface Batch {
  kind: PropKind;
  cfg: KindCfg;
  cells: Float32Array[]; // per cell instance data
  cellMinY: Float32Array;
  cellMaxY: Float32Array;
  lod: [THREE.Mesh, THREE.Mesh, THREE.Mesh];
  buf: [THREE.InstancedInterleavedBuffer, THREE.InstancedInterleavedBuffer, THREE.InstancedInterleavedBuffer];
  shadowCount: number;
  proxy?: THREE.Mesh;
  /** Scratch for shadow casters not drawn at LOD0 (shadow kinds only). */
  tail: Float32Array | null;
  drawn: [number, number, number];
}

export function createProps(world: World, env: Record<string, THREE.IUniform>, opts: PropsOptions) {
  const group = new THREE.Group();
  group.name = "props";
  const models = propModels();
  const ftex = foliageTextures();
  const pacific = world.climate === "lush" || world.climate === "tropical";
  const batches: Batch[] = [];
  const tints = FLOWER_TINTS.map((h) => new THREE.Color(h));

  // one material + depth material per kind (same program, own fade uniform)
  const mats: THREE.Material[] = [];
  // generator props + render-only ground cover, merged per kind
  const byKind = new Map<PropKind, Float32Array[]>();
  const all = [...world.props, ...((opts.groundCover ?? 1) > 0 ? groundCover(world, opts.groundCover ?? 1) : [])];
  for (const ps of all) {
    const l = byKind.get(ps.kind) ?? [];
    l.push(ps.data.subarray(0, ps.count * PROP_STRIDE));
    byKind.set(ps.kind, l);
  }
  // canopy-cover map from the generator's trees: shades everything under dense crowns
  const tc0 = performance.now();
  const canopyTex = buildCanopyTexture(world.props);
  const canopyMs = performance.now() - tc0;
  if (env.uCanopy && env.uCanopyP) {
    env.uCanopy.value = canopyTex;
    (env.uCanopyP.value as THREE.Vector4).set(opts.canopyShade ?? 1, opts.shadowDistance, 0, 0);
    group.userData.canopyP = env.uCanopyP; // debug handle (tools: strength in .value.x)
    // what patch.applyCanopyShade needs, for materials built outside the world renderer (actors)
    group.userData.canopyEnv = { uCanopy: env.uCanopy, uCanopyP: env.uCanopyP, uSunDir: env.uSunDir, uWind: env.uWind, uTime: env.uTime, uNoise: env.uNoise };
  }
  const biomeTex = buildBiomeTint(world);
  const grass = opts.textures && (opts.groundCover ?? 1) > 0
    ? createGrass(world, opts.textures, env, { radius: 52 * opts.distance, density: Math.min(1, 0.25 + opts.density * 0.75), paint: opts.paint })
    : null;
  if (grass) group.add(grass.group);
  const merged = [...byKind.entries()].map(([kind, parts]) => {
    const n = parts.reduce((a, p) => a + p.length, 0);
    const data = new Float32Array(n);
    let o = 0;
    for (const p of parts) { data.set(p, o); o += p.length; }
    return { kind, count: n / PROP_STRIDE, data };
  });
  for (const ps of merged) {
    const model = models.get(ps.kind);
    if (!model || ps.count === 0) continue;
    const cfg = { ...CFG[ps.kind] };
    cfg.maxDist *= opts.distance;
    cfg.lodDist *= opts.distance;
    cfg.lod2 = (cfg.lod2 ?? 1e9) * opts.distance;
    // bucket
    const lists: number[][] = Array.from({ length: NC * NC }, () => []);
    const minY = new Float32Array(NC * NC).fill(1e9), maxY = new Float32Array(NC * NC).fill(-1e9);
    for (let i = 0; i < ps.count; i++) {
      const o = i * PROP_STRIDE;
      const x = ps.data[o], y = ps.data[o + 1], z = ps.data[o + 2];
      // hash for density thinning and variation
      let h = Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(Math.floor(x * 7), 0x85ebca6b) ^ Math.imul(Math.floor(z * 7), 0xc2b2ae35);
      h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12;
      const u = (h >>> 0) / 4294967296;
      if (cfg.thin && u > opts.density) continue;
      const cx = Math.min(NC - 1, Math.max(0, Math.floor((x + WORLD_HALF) / CELL)));
      const cz = Math.min(NC - 1, Math.max(0, Math.floor((z + WORLD_HALF) / CELL)));
      const c = cz * NC + cx;
      const u2 = ((Math.imul(h, 0x27d4eb2f) >>> 0) / 4294967296);
      lists[c].push(x, y, z, ps.data[o + 3], ps.data[o + 4], u2 * 2 - 1, u * 6.283, (u * 7.77) % 1);
      if (y < minY[c]) minY[c] = y;
      if (y > maxY[c]) maxY[c] = y;
    }
    const total = lists.reduce((a, l) => a + l.length / IF, 0);
    if (total === 0) continue;
    const mk = (geo: THREE.BufferGeometry, lod: number) => {
      const g = new THREE.InstancedBufferGeometry();
      for (const name of ["position", "normal", "color", "wind", "tuv"]) g.setAttribute(name, geo.getAttribute(name));
      g.setIndex(geo.getIndex());
      const arr = new Float32Array(total * IF);
      const ib = new THREE.InstancedInterleavedBuffer(arr, IF, 1);
      ib.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute("iA", new THREE.InterleavedBufferAttribute(ib, 4, 0));
      g.setAttribute("iB", new THREE.InterleavedBufferAttribute(ib, 4, 4));
      g.instanceCount = 0;
      const fade = { value: lod === 0 ? new THREE.Vector2(1e5, 1e5 + 1) : new THREE.Vector2(cfg.maxDist * 0.8, cfg.maxDist) };
      void 0;
      const isRock = ROCK_KINDS.has(ps.kind) && !!opts.ground;
      const hk = isRock ? rockHooks() : hooks("k", ftex);
      hk.uniforms = {
        uFade: fade, uTints: { value: tints }, uStretch: { value: cfg.stretch ?? 0 }, uBiomeTint: { value: cfg.biome ? 1 : 0 }, tBiome: { value: biomeTex },
        tLeaf: { value: ftex.leaf }, tBark: ftex.bark, uBarkMean: { value: ftex.barkMean }, uVariety: { value: new THREE.Vector3(...(VARIETY[ps.kind] ?? [0.08, 0.3, 0])) },
        uFlowers: { value: ps.kind === PropKind.Bush && pacific ? 0.2 : 0 },
        ...(isRock ? opts.ground : {}),
      };
      const mat = makeStyledMaterial(env, hk, { vertexColors: true, side: THREE.DoubleSide });
      mat.alphaToCoverage = (opts.msaa ?? 0) > 0;
      const dmat = leafDepthMaterial(env, hk);
      mats.push(mat, dmat);
      const mesh = new THREE.Mesh(g, mat);
      mesh.frustumCulled = false;
      mesh.customDepthMaterial = dmat;
      mesh.castShadow = cfg.shadow && lod === 0;
      mesh.receiveShadow = true;
      mesh.name = `props-${PropKind[ps.kind]}-lod${lod}`;
      mesh.matrixAutoUpdate = false;
      // farther LODs draw after the near scene so their (alpha-tested, overdraw-heavy) leaves
      // are depth-rejected behind houses, hills and near crowns instead of shaded and then covered
      mesh.renderOrder = lod;
      group.add(mesh);
      return { mesh, ib };
    };
    const a = mk(model.lod0, 0), b = mk(model.lod1, 1), c2 = mk(model.lod2, 2);
    // shadow proxy: cheapest LOD shape over the LOD0 instance buffer, drawn only into the shadow map
    const pg = new THREE.InstancedBufferGeometry();
    for (const name of ["position", "normal", "color", "wind", "tuv"]) pg.setAttribute(name, model.lod2.getAttribute(name));
    pg.setIndex(model.lod2.getIndex());
    pg.setAttribute("iA", a.mesh.geometry.getAttribute("iA"));
    pg.setAttribute("iB", a.mesh.geometry.getAttribute("iB"));
    pg.instanceCount = 0;
    const proxy = new THREE.Mesh(pg, a.mesh.material);
    proxy.customDepthMaterial = a.mesh.customDepthMaterial;
    proxy.frustumCulled = false;
    proxy.castShadow = cfg.shadow;
    proxy.receiveShadow = false;
    proxy.matrixAutoUpdate = false;
    proxy.name = `props-${PropKind[ps.kind]}-shadow`;
    a.mesh.castShadow = false;
    group.add(proxy);
    const batch: Batch = {
      kind: ps.kind, cfg,
      cells: lists.map((l) => new Float32Array(l)),
      cellMinY: minY, cellMaxY: maxY,
      lod: [a.mesh, b.mesh, c2.mesh],
      buf: [a.ib, b.ib, c2.ib],
      shadowCount: 0,
      tail: cfg.shadow ? new Float32Array(total * IF) : null,
      drawn: [0, 0, 0],
    };
    proxy.onBeforeShadow = () => { pg.instanceCount = batch.shadowCount; };
    proxy.onAfterShadow = () => { pg.instanceCount = 0; };
    batch.proxy = proxy;
    batch.lod[0].userData.height = model.height;
    batches.push(batch);
  }

  // --- per-update visibility ---
  const frustum = new THREE.Frustum();
  const projView = new THREE.Matrix4();
  const box = new THREE.Box3();
  const lastPos = new THREE.Vector3(1e9, 0, 0);
  const lastDir = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const order: { c: number; d: number }[] = [];
  for (let c = 0; c < NC * NC; c++) order.push({ c, d: 0 });
  let totalDrawn = 0;

  function rebuild(camera: THREE.Camera) {
    projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projView, THREE.WebGLCoordinateSystem, (camera as THREE.PerspectiveCamera).reversedDepth);
    const cp = camera.position;
    for (const o of order) {
      const cx = o.c % NC, cz = Math.floor(o.c / NC);
      const x0 = -WORLD_HALF + cx * CELL, z0 = -WORLD_HALF + cz * CELL;
      const dx = Math.max(x0 - cp.x, 0, cp.x - x0 - CELL), dz = Math.max(z0 - cp.z, 0, cp.z - z0 - CELL);
      o.d = Math.hypot(dx, dz);
    }
    order.sort((a, b) => a.d - b.d);
    totalDrawn = 0;
    for (const b of batches) {
      const h = (b.lod[0].userData.height as number) * 1.4 + 1;
      const [ib0, ib1, ib2] = b.buf;
      const arr0 = ib0.array as Float32Array, arr1 = ib1.array as Float32Array, arr2 = ib2.array as Float32Array;
      let n0 = 0, n1 = 0, n2 = 0, nt = 0;
      const tail = b.tail;
      const lod0Sq = b.cfg.lodDist * b.cfg.lodDist;
      // Main pass: visible cells, LOD0 only inside lodDist (split per instance
      // where a cell straddles it). Shadow casters that aren't drawn at LOD0
      // (farther, or off screen) go to a tail after the LOD0 run: the shadow
      // proxy draws LOD0 + tail, the LOD0 mesh only its own run.
      for (const o of order) {
        if (o.d > b.cfg.maxDist) break;
        const data = b.cells[o.c];
        if (data.length === 0) continue;
        const cx = o.c % NC, cz = Math.floor(o.c / NC);
        const x0 = -WORLD_HALF + cx * CELL, z0 = -WORLD_HALF + cz * CELL;
        const pad = h * 0.5 + 2;
        box.min.set(x0 - pad, b.cellMinY[o.c] - 1, z0 - pad);
        box.max.set(x0 + CELL + pad, b.cellMaxY[o.c] + h, z0 + CELL + pad);
        const inShadow = b.cfg.shadow && o.d < (b.cfg.thin ? Math.min(40, opts.shadowDistance) : opts.shadowDistance);
        const visible = frustum.intersectsBox(box);
        if (!visible) {
          if (inShadow) { tail!.set(data, nt * IF); nt += data.length / IF; }
          continue;
        }
        if (o.d < b.cfg.lodDist) {
          const fx = Math.max(cp.x - x0, x0 + CELL - cp.x), fz = Math.max(cp.z - z0, z0 + CELL - cp.z);
          if (fx * fx + fz * fz <= lod0Sq) {
            arr0.set(data, n0 * IF);
            n0 += data.length / IF;
          } else {
            for (let i = 0; i < data.length; i += IF) {
              const dx = data[i] - cp.x, dz = data[i + 2] - cp.z;
              // per-instance copies without subarray views (no garbage per rebuild)
              if (dx * dx + dz * dz < lod0Sq) { copyInst(data, i, arr0, n0 * IF); n0++; }
              else {
                copyInst(data, i, arr1, n1 * IF); n1++;
                if (inShadow) { copyInst(data, i, tail!, nt * IF); nt++; }
              }
            }
          }
        } else {
          if (inShadow) { tail!.set(data, nt * IF); nt += data.length / IF; }
          if (o.d < (b.cfg.lod2 ?? 1e9)) {
            arr1.set(data, n1 * IF);
            n1 += data.length / IF;
          } else {
            arr2.set(data, n2 * IF);
            n2 += data.length / IF;
          }
        }
      }
      const nMain = n0;
      if (nt) { arr0.set(tail!.subarray(0, nt * IF), n0 * IF); n0 += nt; }
      const shadow = b.cfg.shadow ? n0 : 0;
      ib0.clearUpdateRanges(); ib0.addUpdateRange(0, n0 * IF); ib0.needsUpdate = true;
      ib1.clearUpdateRanges(); ib1.addUpdateRange(0, n1 * IF); ib1.needsUpdate = true;
      ib2.clearUpdateRanges(); ib2.addUpdateRange(0, n2 * IF); ib2.needsUpdate = true;
      (b.lod[2].geometry as THREE.InstancedBufferGeometry).instanceCount = n2;
      b.lod[2].visible = n2 > 0;
      (b.lod[0].geometry as THREE.InstancedBufferGeometry).instanceCount = nMain;
      (b.lod[1].geometry as THREE.InstancedBufferGeometry).instanceCount = n1;
      b.lod[0].visible = nMain > 0;
      b.lod[1].visible = n1 > 0;
      b.drawn = [nMain, n1, n2];
      b.shadowCount = shadow;
      if (b.proxy) b.proxy.visible = shadow > 0;
      totalDrawn += nMain + n1 + n2;
    }
  }

  return {
    group,
    update(camera: THREE.Camera) {
      grass?.update(camera);
      camera.getWorldDirection(dir);
      if (camera.position.distanceToSquared(lastPos) > 1 || dir.dot(lastDir) < 0.9994) {
        lastPos.copy(camera.position);
        lastDir.copy(dir);
        rebuild(camera);
      }
    },
    debugInfo(): Record<string, number> {
      return { propInstances: totalDrawn, propKinds: batches.length, canopyMs: Math.round(canopyMs), atlasMs: Math.round(ftex.paintMs), grassTiles: grass?.tiles() ?? 0, grassMs: Math.round(grass?.buildMs ?? 0) };
    },
    /** triangles submitted per kind in the main pass (lod0, lod1) */
    breakdown(): Record<string, [number, number, number]> {
      const out: Record<string, [number, number, number]> = {};
      for (const b of batches) {
        const t0 = b.lod[0].geometry.index!.count / 3, t1 = b.lod[1].geometry.index!.count / 3, t2 = b.lod[2].geometry.index!.count / 3;
        out[PropKind[b.kind]] = [b.drawn[0], b.drawn[1] + b.drawn[2], Math.round((b.drawn[0] * t0 + b.drawn[1] * t1 + b.drawn[2] * t2) / 1000)];
      }
      return out;
    },
    dispose() {
      for (const b of batches) { for (const m of b.lod) m.geometry.dispose(); b.proxy?.geometry.dispose(); }
      mats.forEach((m) => m.dispose());
      canopyTex.dispose();
      biomeTex.dispose();
      ftex.dispose();
      grass?.dispose();
    },
  };
}
