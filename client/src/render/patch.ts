// Helper to build "stylized toon" materials: MeshToonMaterial (so three.js
// handles lights, cascaded sun shadows, instancing plumbing) with our own
// lighting equation and injectable shader hooks.
import * as THREE from "three";
import { CLOUD_DENSITY_FN, ENV_PARS, NOISE_FNS, STYLE_LIGHT_PARS, WIND_FN } from "./glsl";
import { worldRamp } from "./style";
import { WORLD_HALF, WORLD_SIZE } from "../../../shared/world/types";

/**
 * Canopy shade (env uniforms uCanopy / uCanopyP, map built in props/canopy.ts):
 * under dense crowns the sky is hidden and the sun only gets through in
 * flecks. Real shadow maps already cut direct sun near the camera, so the cut
 * here is partial there and full past the shadow distance; the ambient
 * darkening/cooling is what makes a forest feel like a forest.
 */
const CANOPY_PARS = /* glsl */ `
uniform sampler2D uCanopy;
uniform vec4 uCanopyP;
vec2 canopyUV(vec2 xz) { return (xz + ${WORLD_HALF.toFixed(1)}) / ${WORLD_SIZE.toFixed(1)}; }
`;
const CANOPY_LIGHT = /* glsl */ `
if (uCanopyP.x > 0.0) {
  vec4 C0 = texture2D(uCanopy, canopyUV(vWPos.xz));
  float over = C0.g - vWPos.y;
  float below = (1.0 - smoothstep(C0.g, C0.b, vWPos.y)) * (1.0 - smoothstep(25.0, 45.0, over));
  if (below > 0.0 && C0.r + C0.a > 0.004) {
    vec2 off = uSunDir.xz / max(uSunDir.y, 0.3) * clamp(over, 0.0, 14.0);
    float cov = texture2D(uCanopy, canopyUV(vWPos.xz + off)).r * below;
    float reg = C0.a * below;
    vec2 fp = (vWPos.xz + off) * 0.21 + uWind * sin(uTime * 0.6) * 0.25;
    float fl = smoothstep(0.6, 0.7, noiseT(fp).r * 0.6 + noiseT(fp * 2.3 + 0.37).b * 0.4);
    float farK = smoothstep(uCanopyP.y * 0.6, uCanopyP.y, length(vWPos - cameraPosition));
    float sunCut = clamp(cov * mix(0.6, 0.94, farK) * (1.0 - fl * 0.9) * uCanopyP.x, 0.0, 1.0);
    reflectedLight.directDiffuse *= 1.0 - sunCut;
    reflectedLight.directSpecular *= 1.0 - sunCut;
    float amb = clamp((cov * 0.45 + reg * 0.55) * uCanopyP.x, 0.0, 1.0);
    reflectedLight.indirectDiffuse *= mix(vec3(1.0), vec3(0.72, 0.8, 0.7), amb);
    reflectedLight.indirectDiffuse += diffuseColor.rgb * vec3(0.02, 0.05, 0.025) * amb;
  }
}
`;

/**
 * Canopy shade for materials that don't go through makeStyledMaterial (e.g.
 * actors on a plain MeshToonMaterial): call once after creating the material.
 * Needs the world's env uniforms (they carry uCanopy); chains any existing onBeforeCompile.
 */
export function applyCanopyShade(m: THREE.Material, env: Record<string, THREE.IUniform>): void {
  if (!("uCanopy" in env)) return;
  const prev = m.onBeforeCompile;
  const prevKey = m.customProgramCacheKey;
  m.onBeforeCompile = (shader, r) => {
    prev?.call(m, shader, r);
    shader.uniforms.uCanopy = env.uCanopy;
    shader.uniforms.uCanopyP = env.uCanopyP;
    shader.uniforms.uSunDir = env.uSunDir;
    shader.uniforms.uWind = env.uWind;
    shader.uniforms.uTime = env.uTime;
    shader.uniforms.uNoise = env.uNoise;
    let vs = shader.vertexShader, fs = shader.fragmentShader;
    if (!/varying vec3 vWPos;/.test(vs)) {
      vs = vs.replace("#include <common>", "#include <common>\nvarying vec3 vWPos;");
      vs = vs.replace(/}\s*$/, "  #ifdef USE_INSTANCING\n  vWPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;\n  #else\n  vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\n  #endif\n}");
      fs = fs.replace("#include <common>", `#include <common>\nvarying vec3 vWPos;\nuniform float uTime; uniform vec3 uSunDir; uniform vec2 uWind; uniform sampler2D uNoise;\n${NOISE_FNS}`);
    }
    fs = fs.replace("#include <common>", `#include <common>\n${CANOPY_PARS}`);
    fs = fs.replace("#include <opaque_fragment>", `{\n${CANOPY_LIGHT}\noutgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + reflectedLight.directSpecular + reflectedLight.indirectSpecular + totalEmissiveRadiance;\n}\n#include <opaque_fragment>`);
    shader.vertexShader = vs;
    shader.fragmentShader = fs;
  };
  m.customProgramCacheKey = () => (prevKey ? prevKey.call(m) : "") + "+canopy";
  m.needsUpdate = true;
}

export interface PatchHooks {
  key: string;
  uniforms?: Record<string, THREE.IUniform>;
  defines?: Record<string, string | number | boolean>;
  /** Declarations for the vertex shader (attributes, varyings, functions). */
  vertexPars?: string;
  /** Runs after beginnormal_vertex (before normals are transformed): may modify `objectNormal`. */
  vertexNormal?: string;
  /** Runs after begin_vertex: may modify `transformed` (object space). Also used by the depth material. */
  vertexTransform?: string;
  /** Runs at the end of main(): `vWPos` already holds the world position. */
  vertexEnd?: string;
  fragPars?: string;
  /** After color_fragment: modify diffuseColor, set gSpec/gShine/gTransl. vWPos available. */
  fragColor?: string;
  /** After normal_fragment_begin: may modify `normal` (view space). */
  fragNormal?: string;
  /** Before outgoingLight: may modify totalEmissiveRadiance / reflectedLight. */
  fragLight?: string;
  /** After outgoingLight is computed: may modify `outgoingLight`. */
  fragOutput?: string;
}

export interface StyleOptions {
  color?: THREE.ColorRepresentation;
  vertexColors?: boolean;
  side?: THREE.Side;
  transparent?: boolean;
  emissive?: THREE.ColorRepresentation;
}

/**
 * A MeshToonMaterial using the world ramp + our RE_Direct (specular, translucency),
 * with shared env uniforms and optional hooks. `env` uniforms are shared by reference.
 */
export function makeStyledMaterial(env: Record<string, THREE.IUniform>, hooks: PatchHooks, opts: StyleOptions = {}): THREE.MeshToonMaterial {
  const m = new THREE.MeshToonMaterial({
    color: opts.color ?? 0xffffff,
    vertexColors: opts.vertexColors ?? false,
    gradientMap: worldRamp(),
    side: opts.side ?? THREE.FrontSide,
    transparent: opts.transparent ?? false,
    emissive: opts.emissive ?? 0x000000,
  });
  applyPatch(m, env, hooks);
  return m;
}

export function applyPatch(m: THREE.Material, env: Record<string, THREE.IUniform>, hooks: PatchHooks): void {
  if (hooks.defines) m.defines = { ...(m.defines ?? {}), ...hooks.defines };
  const canopy = "uCanopy" in env;
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, env, hooks.uniforms ?? {});
    let vs = shader.vertexShader;
    let fs = shader.fragmentShader;
    vs = vs.replace(
      "#include <common>",
      `#include <common>\n${ENV_PARS}\n${NOISE_FNS}\n${WIND_FN}\n${CLOUD_DENSITY_FN}\nvarying vec3 vWPos;\nvarying float vCloudSh;\n${hooks.vertexPars ?? ""}`,
    );
    vs = vs.replace("#include <beginnormal_vertex>", `#include <beginnormal_vertex>\n${hooks.vertexNormal ?? ""}`);
    vs = vs.replace("#include <begin_vertex>", `#include <begin_vertex>\n${hooks.vertexTransform ?? ""}`);
    // beginnormal runs before begin_vertex in three's shaders; make objectNormal mutable after transform
    vs = vs.replace(/}\s*$/, `  #ifdef USE_INSTANCING\n  vWPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;\n  #else\n  vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\n  #endif\n${hooks.vertexEnd ?? ""}\n  vCloudSh = cloudShadow(vWPos); // clouds are 100 m+ features: per-vertex is plenty\n}`);
    fs = fs.replace(
      "#include <common>",
      `#include <common>\n${ENV_PARS}\n${NOISE_FNS}\nvarying vec3 vWPos;\nvarying float vCloudSh;\n${canopy ? CANOPY_PARS : ""}\n${hooks.fragPars ?? ""}`,
    );
    fs = fs.replace("#include <lights_toon_pars_fragment>", STYLE_LIGHT_PARS);
    fs = fs.replace("#include <color_fragment>", `#include <color_fragment>\n${hooks.fragColor ?? ""}`);
    fs = fs.replace("#include <normal_fragment_begin>", `#include <normal_fragment_begin>\n${hooks.fragNormal ?? ""}`);
    fs = fs.replace(
      "vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;",
      `{ float cs = vCloudSh; reflectedLight.directDiffuse *= cs; reflectedLight.directSpecular *= cs; }\n${canopy ? CANOPY_LIGHT : ""}\n${hooks.fragLight ?? ""}\nvec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + reflectedLight.directSpecular + totalEmissiveRadiance;\n${hooks.fragOutput ?? ""}`,
    );
    shader.vertexShader = vs;
    shader.fragmentShader = fs;
  };
  m.customProgramCacheKey = () => hooks.key + (canopy ? "+c" : "");
}

/** Depth material for shadow casting that runs the same vertex transform. */
export function makeDepthMaterial(env: Record<string, THREE.IUniform>, hooks: PatchHooks): THREE.MeshDepthMaterial {
  const d = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  const vhooks: PatchHooks = { key: hooks.key + "-depth", uniforms: hooks.uniforms, defines: hooks.defines, vertexPars: hooks.vertexPars, vertexTransform: hooks.vertexTransform };
  d.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, env, vhooks.uniforms ?? {});
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${ENV_PARS}\n${NOISE_FNS}\n${WIND_FN}\n${vhooks.vertexPars ?? ""}`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\n${vhooks.vertexTransform ?? ""}`);
    shader.fragmentShader = shader.fragmentShader.replace("#include <common>", `#include <common>\n${ENV_PARS}`);
  };
  d.defines = { ...(hooks.defines ?? {}), IS_DEPTH: 1 };
  d.customProgramCacheKey = () => vhooks.key;
  return d;
}
