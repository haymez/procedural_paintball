// Helper to build "stylized toon" materials: MeshToonMaterial (so three.js
// handles lights, cascaded sun shadows, instancing plumbing) with our own
// lighting equation and injectable shader hooks.
import * as THREE from "three";
import { ENV_PARS, NOISE_FNS, STYLE_LIGHT_PARS, WIND_FN } from "./glsl";
import { worldRamp } from "./style";

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
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, env, hooks.uniforms ?? {});
    let vs = shader.vertexShader;
    let fs = shader.fragmentShader;
    vs = vs.replace(
      "#include <common>",
      `#include <common>\n${ENV_PARS}\n${NOISE_FNS}\n${WIND_FN}\nvarying vec3 vWPos;\n${hooks.vertexPars ?? ""}`,
    );
    vs = vs.replace("#include <beginnormal_vertex>", `#include <beginnormal_vertex>\n${hooks.vertexNormal ?? ""}`);
    vs = vs.replace("#include <begin_vertex>", `#include <begin_vertex>\n${hooks.vertexTransform ?? ""}`);
    // beginnormal runs before begin_vertex in three's shaders; make objectNormal mutable after transform
    vs = vs.replace(/}\s*$/, `  #ifdef USE_INSTANCING\n  vWPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;\n  #else\n  vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\n  #endif\n${hooks.vertexEnd ?? ""}\n}`);
    fs = fs.replace(
      "#include <common>",
      `#include <common>\n${ENV_PARS}\n${NOISE_FNS}\nvarying vec3 vWPos;\n${hooks.fragPars ?? ""}`,
    );
    fs = fs.replace("#include <lights_toon_pars_fragment>", STYLE_LIGHT_PARS);
    fs = fs.replace("#include <color_fragment>", `#include <color_fragment>\n${hooks.fragColor ?? ""}`);
    fs = fs.replace("#include <normal_fragment_begin>", `#include <normal_fragment_begin>\n${hooks.fragNormal ?? ""}`);
    fs = fs.replace(
      "vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;",
      `${hooks.fragLight ?? ""}\nvec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + reflectedLight.directSpecular + totalEmissiveRadiance;\n${hooks.fragOutput ?? ""}`,
    );
    shader.vertexShader = vs;
    shader.fragmentShader = fs;
  };
  m.customProgramCacheKey = () => hooks.key;
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
