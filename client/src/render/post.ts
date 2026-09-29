// Scene is rendered to an HDR (half float, optionally MSAA) target with a
// depth texture. The composite pass then:
//  - draws the analytic sky (sun disc, glow, haze) where nothing was drawn,
//  - applies height fog / aerial perspective that blends into the sky color,
//  - underwater: short teal fog, caustics on submerged surfaces, wobble,
//  - inside caves: dark cool fog,
//  - adds bloom, tone maps (Khronos PBR Neutral), warm grade, vignette, dither.
import * as THREE from "three";
import { ENV_PARS, FOG_FN, NOISE_FNS, SKY_FN } from "./glsl";

export interface PostOptions {
  msaa: number;
  bloom: boolean;
  scale: number; // resolution scale on top of pixel ratio
}

const FS_VERT = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

function fullscreenTriangle(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  return g;
}

export interface Post {
  target: THREE.WebGLRenderTarget;
  uniforms: Record<string, THREE.IUniform>;
  setSize(w: number, h: number): void;
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera): void;
  dispose(): void;
}

export function createPost(renderer: THREE.WebGLRenderer, env: Record<string, THREE.IUniform>, opts: PostOptions): Post {
  const reversed = renderer.capabilities.reversedDepthBuffer === true;
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const w = Math.max(1, Math.round(size.x * opts.scale)), h = Math.max(1, Math.round(size.y * opts.scale));
  const depthTex = new THREE.DepthTexture(w, h, THREE.FloatType);
  depthTex.format = THREE.DepthFormat;
  const target = new THREE.WebGLRenderTarget(w, h, {
    // packed float HDR: half the bandwidth of RGBA16F (no alpha needed)
    type: THREE.UnsignedInt101111Type,
    format: THREE.RGBFormat,
    samples: opts.msaa,
    depthTexture: depthTex,
    depthBuffer: true,
  });
  target.texture.minFilter = THREE.LinearFilter;
  target.texture.generateMipmaps = false;

  const tri = fullscreenTriangle();
  const orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  // --- bloom: threshold+downsample to 1/4, blur at 1/4 and 1/8 ---
  const mkRT = (ww: number, hh: number) => {
    const rt = new THREE.WebGLRenderTarget(ww, hh, { type: THREE.HalfFloatType, depthBuffer: false });
    rt.texture.minFilter = rt.texture.magFilter = THREE.LinearFilter;
    return rt;
  };
  let bw = Math.max(1, w >> 2), bh = Math.max(1, h >> 2);
  const bloomA = mkRT(bw, bh), bloomB = mkRT(bw, bh);
  const bloomC = mkRT(Math.max(1, bw >> 1), Math.max(1, bh >> 1)), bloomD = mkRT(Math.max(1, bw >> 1), Math.max(1, bh >> 1));

  const brightMat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: { tSrc: { value: target.texture }, uTexel: { value: new THREE.Vector2(1 / w, 1 / h) }, uThreshold: { value: 1.05 } },
    vertexShader: FS_VERT,
    fragmentShader: /* glsl */ `
      precision highp float;
      in vec2 vUv; out vec4 o;
      uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uThreshold;
      void main() {
        vec3 c = vec3(0.0);
        for (int y = -1; y <= 1; y += 2) for (int x = -1; x <= 1; x += 2)
          c += texture(tSrc, vUv + vec2(x, y) * uTexel * 1.5).rgb;
        c *= 0.25;
        c = min(c, vec3(40.0));
        float l = max(max(c.r, c.g), c.b);
        float k = smoothstep(uThreshold, uThreshold + 1.2, l);
        o = vec4(c * k, 1.0);
      }`,
    depthTest: false, depthWrite: false,
  });
  const blurMat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } },
    vertexShader: FS_VERT,
    fragmentShader: /* glsl */ `
      precision highp float;
      in vec2 vUv; out vec4 o;
      uniform sampler2D tSrc; uniform vec2 uDir;
      void main() {
        vec3 c = texture(tSrc, vUv).rgb * 0.227;
        c += texture(tSrc, vUv + uDir * 1.385).rgb * 0.316;
        c += texture(tSrc, vUv - uDir * 1.385).rgb * 0.316;
        c += texture(tSrc, vUv + uDir * 3.231).rgb * 0.070;
        c += texture(tSrc, vUv - uDir * 3.231).rgb * 0.070;
        o = vec4(c, 1.0);
      }`,
    depthTest: false, depthWrite: false,
  });

  const uniforms: Record<string, THREE.IUniform> = {
    ...env,
    tColor: { value: target.texture },
    tDepth: { value: depthTex },
    tBloom1: { value: bloomA.texture },
    tBloom2: { value: bloomC.texture },
    uBloom: { value: opts.bloom ? 0.22 : 0 },
    uInvProj: { value: new THREE.Matrix4() },
    uCamWorld: { value: new THREE.Matrix4() },
    uCamPos: { value: new THREE.Vector3() },
    uExposure: { value: 1.0 },
    uUnderwater: { value: 0 }, // 0..1
    uWaterLevel: { value: 0 },
    uCave: { value: 0 }, // 0..1 camera inside cave
    uSatBoost: { value: 1.03 },
    uVignette: { value: 0.22 },
    uResolution: { value: new THREE.Vector2(w, h) },
  };
  const compMat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms,
    defines: { REVERSED_Z: reversed ? 1 : 0 },
    vertexShader: /* glsl */ `
      uniform mat4 uInvProj; uniform mat4 uCamWorld;
      out vec2 vUv; out vec3 vRay;
      void main() {
        vUv = position.xy * 0.5 + 0.5;
        vec4 v = uInvProj * vec4(position.xy, 0.5, 1.0);
        vRay = (uCamWorld * vec4(v.xyz / v.w, 0.0)).xyz;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      precision highp float;
      ${ENV_PARS}
      ${NOISE_FNS}
      ${SKY_FN}
      ${FOG_FN}
      in vec2 vUv; in vec3 vRay; out vec4 o;
      uniform sampler2D tColor, tDepth, tBloom1, tBloom2;
      uniform float uBloom, uExposure, uUnderwater, uWaterLevel, uCave, uSatBoost, uVignette;
      uniform mat4 uInvProj, uCamWorld;
      uniform vec3 uCamPos;
      uniform vec2 uResolution;

      vec3 pbrNeutral(vec3 color) {
        const float startCompression = 0.8 - 0.04;
        const float desaturation = 0.15;
        float x = min(color.r, min(color.g, color.b));
        float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
        color -= offset;
        float peak = max(color.r, max(color.g, color.b));
        if (peak < startCompression) return color;
        const float d = 1.0 - startCompression;
        float newPeak = 1.0 - d * d / (peak + d - startCompression);
        color *= newPeak / peak;
        float g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
        return mix(color, vec3(newPeak), g);
      }
      vec3 toSRGB(vec3 c) {
        c = clamp(c, 0.0, 1.0);
        return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
      }

      void main() {
        vec2 uv = vUv;
        vec3 rd = normalize(vRay);
        // underwater wobble
        if (uUnderwater > 0.0) {
          uv += vec2(sin(uv.y * 40.0 + uTime * 2.0), cos(uv.x * 30.0 + uTime * 1.7)) * 0.0022 * uUnderwater;
        }
        float d = texture(tDepth, uv).r;
        vec3 col = texture(tColor, uv).rgb;
        #if REVERSED_Z
          bool isSky = d <= 0.0;
          float ndcZ = d;
        #else
          bool isSky = d >= 1.0;
          float ndcZ = d * 2.0 - 1.0;
        #endif
        vec3 fogSkyDir = normalize(vec3(rd.x, max(rd.y, 0.0) * 0.35, rd.z));
        if (isSky) {
          col = rd.y < 0.0 ? skyColor(fogSkyDir, 0.0) : skyColor(rd, 1.0);
        } else {
          vec4 vp = uInvProj * vec4(uv * 2.0 - 1.0, ndcZ, 1.0);
          vp /= vp.w;
          vec3 wp = (uCamWorld * vec4(vp.xyz, 1.0)).xyz;
          float dist = length(wp - uCamPos);
          if (uUnderwater < 0.5) {
            float od = fogOpticalDepth(uCamPos, rd, dist);
            float f = 1.0 - exp(-od);
            f = max(f, smoothstep(2200.0, 5200.0, dist)); // fully hazed before the ocean mesh ends
            vec3 fc = skyColor(fogSkyDir, 0.0);
            // in-scatter: warmer toward the sun
            float mu = max(dot(rd, uSunDir), 0.0);
            fc += uSunGlow * pow(mu, 8.0) * 0.25;
            col = mix(col, fc, f * (1.0 - uCave * 0.9 * (1.0 - smoothstep(35.0, 70.0, dist))));
          }
          // caves: cool darkness swallows distance
          if (uCave > 0.0) {
            float cf = (1.0 - exp(-dist * 0.035)) * (1.0 - smoothstep(35.0, 70.0, dist)); // only cave-scale distances
            col = mix(col, vec3(0.012, 0.018, 0.03), cf * uCave * 0.85);
          }
          if (uUnderwater > 0.0) {
            float depthBelow = max(uWaterLevel - uCamPos.y, 0.0);
            vec3 wfog = mix(vec3(0.06, 0.42, 0.48), vec3(0.02, 0.16, 0.3), smoothstep(0.0, 12.0, depthBelow));
            float wf = 1.0 - exp(-dist * 0.075);
            col = mix(col * vec3(0.5, 0.85, 0.92), wfog, wf);
            // sun shafts slanting down through the water
            float sh = noiseT(vec2(dot(rd.xz, vec2(0.8, 0.6)) * 2.5 + uTime * 0.01, rd.y * 0.2)).r;
            float shafts = pow(smoothstep(0.45, 0.9, sh), 2.0) * smoothstep(-0.3, 0.6, rd.y) * exp(-depthBelow * 0.08);
            col += vec3(0.35, 0.7, 0.7) * shafts * 0.35 * min(dist * 0.05, 1.0);
          }
        }
        if (isSky && uUnderwater > 0.0) {
          col = mix(col, vec3(0.2, 0.7, 0.75), 0.6);
        }
        // bloom
        if (uBloom > 0.0) {
          vec3 bl = texture(tBloom1, uv).rgb * 0.6 + texture(tBloom2, uv).rgb * 0.9;
          col += bl * uBloom;
        }
        col *= uExposure;
        col = pbrNeutral(col);
        // grade: saturation, lifted cool shadows, warm highlights
        float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
        col = mix(vec3(l), col, uSatBoost);
        col = mix(col, col * vec3(0.96, 1.0, 1.06), (1.0 - smoothstep(0.0, 0.35, l)) * 0.6);
        col = mix(col, col * vec3(1.03, 1.0, 0.95), smoothstep(0.5, 1.0, l) * 0.5);
        col = max(col, vec3(0.0));
        // vignette
        vec2 q = vUv - 0.5;
        col *= 1.0 - uVignette * smoothstep(0.25, 0.85, dot(q, q) * 2.2);
        vec3 srgb = toSRGB(col);
        srgb += (hash12(gl_FragCoord.xy + fract(uTime) * 91.0) - 0.5) / 255.0;
        o = vec4(srgb, 1.0);
      }`,
    depthTest: false,
    depthWrite: false,
  });

  const quad = new THREE.Mesh(tri, compMat);
  quad.frustumCulled = false;
  const quadScene = new THREE.Scene();
  quadScene.add(quad);

  function pass(mat: THREE.ShaderMaterial, rt: THREE.WebGLRenderTarget | null) {
    quad.material = mat;
    renderer.setRenderTarget(rt);
    renderer.render(quadScene, orthoCam);
  }

  return {
    target,
    uniforms,
    setSize(nw: number, nh: number) {
      const tw = Math.max(1, Math.round(nw * opts.scale)), th = Math.max(1, Math.round(nh * opts.scale));
      target.setSize(tw, th);
      bw = Math.max(1, tw >> 2); bh = Math.max(1, th >> 2);
      bloomA.setSize(bw, bh); bloomB.setSize(bw, bh);
      bloomC.setSize(Math.max(1, bw >> 1), Math.max(1, bh >> 1)); bloomD.setSize(Math.max(1, bw >> 1), Math.max(1, bh >> 1));
      brightMat.uniforms.uTexel.value.set(1 / tw, 1 / th);
      uniforms.uResolution.value.set(tw, th);
    },
    render(r, scene, camera) {
      r.setRenderTarget(target);
      r.render(scene, camera);
      uniforms.uInvProj.value.copy(camera.projectionMatrixInverse);
      uniforms.uCamWorld.value.copy(camera.matrixWorld);
      uniforms.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
      if (opts.bloom) {
        pass(brightMat, bloomA);
        blurMat.uniforms.tSrc.value = bloomA.texture; blurMat.uniforms.uDir.value.set(1 / bw, 0); pass(blurMat, bloomB);
        blurMat.uniforms.tSrc.value = bloomB.texture; blurMat.uniforms.uDir.value.set(0, 1 / bh); pass(blurMat, bloomA);
        const cw = Math.max(1, bw >> 1), chh = Math.max(1, bh >> 1);
        blurMat.uniforms.tSrc.value = bloomA.texture; blurMat.uniforms.uDir.value.set(2 / cw, 0); pass(blurMat, bloomD);
        blurMat.uniforms.tSrc.value = bloomD.texture; blurMat.uniforms.uDir.value.set(0, 2 / chh); pass(blurMat, bloomC);
      }
      pass(compMat, null);
    },
    dispose() {
      target.dispose(); depthTex.dispose(); bloomA.dispose(); bloomB.dispose(); bloomC.dispose(); bloomD.dispose();
      brightMat.dispose(); blurMat.dispose(); compMat.dispose(); tri.dispose();
    },
  };
}
