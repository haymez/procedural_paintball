// Small, output-identical tweaks to three.js shader chunks. Imported for its
// side effect by worldView.ts before any program is compiled.
import * as THREE from "three";

/**
 * PCF soft shadows (sun cascades) take 5 Vogel-disk taps, each computing
 * sqrt + cos + sin of `i * goldenAngle + phi`. The disk is the same for every
 * pixel up to the per-pixel rotation phi, so precompute the 5 points and
 * rotate them once: 2 trig ops per lookup instead of 10, same samples.
 */
function patchPcfVogel(): void {
  const src = THREE.ShaderChunk.shadowmap_pars_fragment;
  const g = 2.399963229728653;
  const consts = [0, 1, 2, 3, 4].map((i) => {
    const r = Math.sqrt((i + 0.5) / 5), a = i * g;
    return `const vec2 VOGEL5_${i} = vec2( ${(Math.cos(a) * r).toFixed(9)}, ${(Math.sin(a) * r).toFixed(9)} );`;
  }).join("\n");
  const anchor = "float getShadow( sampler2DShadow shadowMap";
  const phiRe = /(float phi = interleavedGradientNoise\( gl_FragCoord\.xy \) \* PI2;)(\s*shadow = \(\s*texture\( shadowMap, vec3\( shadowCoord\.xy \+ vogelDiskSample)/;
  const tapRe = /vogelDiskSample\( (\d), 5, phi \) \* radius/g;
  if (src.includes("VOGEL5_0") || !src.includes(anchor) || !phiRe.test(src) || (src.match(tapRe)?.length ?? 0) !== 5) {
    if (!src.includes("VOGEL5_0")) console.warn("[render] shadowmap_pars_fragment changed; PCF tap patch skipped");
    return;
  }
  THREE.ShaderChunk.shadowmap_pars_fragment = src
    .replace(anchor, `${consts}\n\t\t${anchor}`)
    .replace(phiRe, "$1\n\t\t\t\tvec2 vogelCS = vec2( cos( phi ), sin( phi ) );\n\t\t\t\tmat2 vogelR = mat2( vogelCS.x, vogelCS.y, - vogelCS.y, vogelCS.x );$2")
    .replace(tapRe, "( vogelR * VOGEL5_$1 ) * radius");
}

patchPcfVogel();
