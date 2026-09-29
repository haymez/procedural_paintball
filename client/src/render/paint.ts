// Persistent paint.
//
// Ground: a paged virtual texture. The world is split into 32 m pages; a page
// gets a 256² slot in a shared atlas (2 px gutter, ~12.7 cm/texel) the first
// time a splat touches it. A 32x32 page table maps page -> slot for the
// terrain shader. When the atlas is full the least recently painted page is
// recycled. Splats are premultiplied color + coverage; the terrain shader
// thresholds coverage so edges stay crisp.
//
// Everything else (structures, props, cave walls): pooled decal quads.
import * as THREE from "three";
import { WORLD_HALF, WORLD_SIZE, type World } from "../../../shared/world/types";
import { heightAt, gridIndex } from "./worldTextures";
import { makeStyledMaterial } from "./patch";

export interface PaintLayer {
  uniforms: Record<string, THREE.IUniform>;
  decals: THREE.InstancedMesh;
  splat(x: number, y: number, z: number, nx: number, ny: number, nz: number, radius: number, color: THREE.ColorRepresentation): void;
  /** Draw queued ground splats into the paint atlas. Call once per frame before rendering. */
  flush(renderer: THREE.WebGLRenderer): void;
  clear(renderer: THREE.WebGLRenderer): void;
  stats(): { pages: number; decals: number };
  dispose(): void;
}

const PAGE = 32; // meters
const NP = WORLD_SIZE / PAGE; // 32 pages per side
const SLOT = 256; // px
const GUT = 2; // px gutter
const INNER = SLOT - 2 * GUT;
const MAX_BATCH = 512;
const MAX_DECALS = 1024;

/** GLSL for the terrain: sample the paint atlas at world xz. Returns premultiplied rgba. */
export const PAINT_SAMPLE_GLSL = /* glsl */ `
uniform sampler2D tPaint, tPaintPages;
uniform vec4 uPaintAtlas; // slots per side, inner/slot, gutter/slot, 1/PAGE
vec4 samplePaint(vec2 xz) {
  vec2 pg = (xz + ${WORLD_HALF.toFixed(1)}) * uPaintAtlas.w;
  if (pg.x < 0.0 || pg.y < 0.0 || pg.x >= ${NP.toFixed(1)} || pg.y >= ${NP.toFixed(1)}) return vec4(0.0);
  vec4 e = texture2D(tPaintPages, (floor(pg) + 0.5) / ${NP.toFixed(1)});
  if (e.b < 0.5) return vec4(0.0);
  vec2 slot = floor(e.rg * 255.0 + 0.5);
  vec2 uv = (slot + uPaintAtlas.z + fract(pg) * uPaintAtlas.y) / uPaintAtlas.x;
  return texture2D(tPaint, uv);
}
`;

const SPLAT_GLSL = /* glsl */ `
float splatShape(vec2 q, float seed) {
  // q in units of splat radius, centered
  float r = length(q);
  float a = atan(q.y, q.x);
  float wob = 1.0 + 0.09 * sin(a * 3.0 + seed * 6.1) + 0.06 * sin(a * 7.0 + seed * 13.7) + 0.035 * sin(a * 13.0 + seed * 3.3);
  float spikes = pow(max(sin(a * 4.0 + seed * 9.0), 0.0), 18.0) * 0.45 + pow(max(sin(a * 7.0 - seed * 5.0), 0.0), 30.0) * 0.3;
  float R = 0.82 * wob + spikes * smoothstep(0.3, 0.8, r);
  float body = clamp(0.5 + (R - r) * 9.0, 0.0, 1.0);
  float drops = 0.0;
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    float da = seed * 17.0 + fi * 2.39996;
    float dr = 1.05 + fract(seed * 7.13 + fi * 0.618) * 0.45;
    float ds = 0.06 + fract(seed * 3.7 + fi * 0.37) * 0.08;
    vec2 c = vec2(cos(da), sin(da)) * dr;
    drops = max(drops, clamp(0.5 + (ds - length(q - c)) * 8.0, 0.0, 1.0));
  }
  return max(body, drops);
}
`;

export function createPaintLayer(world: World, env: Record<string, THREE.IUniform>, resolution: number): PaintLayer {
  const slotsPerSide = Math.max(4, Math.floor(resolution / SLOT));
  const atlasPx = slotsPerSide * SLOT;
  const nSlots = slotsPerSide * slotsPerSide;
  const rt = new THREE.WebGLRenderTarget(atlasPx, atlasPx, { depthBuffer: false, type: THREE.UnsignedByteType });
  rt.texture.minFilter = THREE.LinearFilter;
  rt.texture.magFilter = THREE.LinearFilter;
  rt.texture.generateMipmaps = false;

  const pageData = new Uint8Array(NP * NP * 4);
  const pages = new THREE.DataTexture(pageData, NP, NP, THREE.RGBAFormat);
  pages.magFilter = pages.minFilter = THREE.NearestFilter;
  pages.needsUpdate = true;
  const pageSlot = new Int32Array(NP * NP).fill(-1);
  const slotPage = new Int32Array(nSlots).fill(-1);
  const slotUsed = new Float64Array(nSlots); // last paint time for LRU
  let clock = 0;

  const uniforms: Record<string, THREE.IUniform> = {
    tPaint: { value: rt.texture },
    tPaintPages: { value: pages },
    uPaintAtlas: { value: new THREE.Vector4(slotsPerSide, INNER / SLOT, GUT / SLOT, 1 / PAGE) },
  };

  // --- splat batch: one instance per (splat, page) ---
  const quad = new THREE.PlaneGeometry(2, 2);
  const inst = new THREE.InstancedBufferGeometry();
  inst.index = quad.index;
  inst.setAttribute("position", quad.getAttribute("position"));
  const aSplat = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BATCH * 4), 4); // page-local x, z (m), radius, seed
  const aSlot = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BATCH * 2), 2);
  const aCol = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BATCH * 4), 4); // rgb, clear flag
  for (const a of [aSplat, aSlot, aCol]) { a.setUsage(THREE.DynamicDrawUsage); }
  inst.setAttribute("aSplat", aSplat);
  inst.setAttribute("aSlot", aSlot);
  inst.setAttribute("aCol", aCol);
  const splatMat = new THREE.ShaderMaterial({
    uniforms: { uAtlas: { value: new THREE.Vector4(slotsPerSide, SLOT, GUT, PAGE) } },
    vertexShader: /* glsl */ `
      attribute vec4 aSplat; attribute vec2 aSlot; attribute vec4 aCol;
      uniform vec4 uAtlas; // slots, slot px, gutter px, page m
      varying vec2 vQ; varying vec4 vCol; varying float vSeed; varying vec2 vPx; varying vec2 vSlotMin;
      void main() {
        float pxPerM = (uAtlas.y - 2.0 * uAtlas.z) / uAtlas.w;
        vec2 slotMin = aSlot * uAtlas.y;
        vec2 pagePx;
        if (aCol.w > 0.5) {
          // clear the whole slot
          pagePx = (position.xy * 0.5 + 0.5) * uAtlas.y;
          vQ = vec2(0.0);
        } else {
          float s = aSplat.z * 1.75;
          float ang = aSplat.w * 6.2831;
          vec2 p = mat2(cos(ang), sin(ang), -sin(ang), cos(ang)) * position.xy;
          vQ = position.xy * 1.75;
          vec2 w = aSplat.xy + p * s;
          pagePx = uAtlas.z + w * pxPerM;
        }
        vCol = aCol; vSeed = aSplat.w;
        vPx = pagePx; vSlotMin = slotMin;
        vec2 atlasPx = slotMin + pagePx;
        gl_Position = vec4(atlasPx / (uAtlas.x * uAtlas.y) * 2.0 - 1.0, 0.0, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec4 uAtlas;
      varying vec2 vQ; varying vec4 vCol; varying float vSeed; varying vec2 vPx; varying vec2 vSlotMin;
      ${SPLAT_GLSL}
      void main() {
        if (vPx.x < 0.0 || vPx.y < 0.0 || vPx.x > uAtlas.y || vPx.y > uAtlas.y) discard;
        if (vCol.w > 0.5) { gl_FragColor = vec4(0.0); return; }
        float a = splatShape(vQ, vSeed);
        if (a <= 0.0) discard;
        gl_FragColor = vec4(vCol.rgb * a, a);
      }`,
    transparent: true,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    depthTest: false,
    depthWrite: false,
  });
  // clears must replace, not blend: a separate material with no blending
  const clearMat = splatMat.clone();
  clearMat.blending = THREE.NoBlending;
  clearMat.transparent = false;
  const splatMesh = new THREE.Mesh(inst, splatMat);
  splatMesh.frustumCulled = false;
  const splatScene = new THREE.Scene();
  splatScene.add(splatMesh);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
  let queued = 0;
  const clears: number[] = [];
  let needsClear = true;

  function slotFor(page: number): number {
    let s = pageSlot[page];
    if (s >= 0) { slotUsed[s] = ++clock; return s; }
    // free slot, else LRU
    let best = -1;
    for (let i = 0; i < nSlots; i++) if (slotPage[i] < 0) { best = i; break; }
    if (best < 0) {
      let oldest = Infinity;
      for (let i = 0; i < nSlots; i++) if (slotUsed[i] < oldest) { oldest = slotUsed[i]; best = i; }
      const old = slotPage[best];
      pageSlot[old] = -1;
      pageData[old * 4 + 2] = 0;
    }
    s = best;
    slotPage[s] = page;
    pageSlot[page] = s;
    slotUsed[s] = ++clock;
    pageData[page * 4] = s % slotsPerSide;
    pageData[page * 4 + 1] = Math.floor(s / slotsPerSide);
    pageData[page * 4 + 2] = 255;
    pages.needsUpdate = true;
    clears.push(s);
    return s;
  }

  // --- decals ---
  const decalGeo = new THREE.PlaneGeometry(2, 2);
  const aDecal = new THREE.InstancedBufferAttribute(new Float32Array(MAX_DECALS), 1);
  decalGeo.setAttribute("aSeed", aDecal);
  const decalMat = makeStyledMaterial(env, {
    key: "paint-decal",
    vertexPars: "attribute float aSeed; varying float vSeed; varying vec2 vQ;",
    vertexTransform: "vSeed = aSeed; vQ = position.xy * 1.75;",
    fragPars: `varying float vSeed; varying vec2 vQ;\n${SPLAT_GLSL}`,
    fragColor: `
      float sa = splatShape(vQ, vSeed);
      if (sa < 0.5) discard;
      gSpec = 0.8; gShine = 60.0;
    `,
  }, { color: 0xffffff });
  decalMat.polygonOffset = true;
  decalMat.polygonOffsetFactor = -2;
  decalMat.polygonOffsetUnits = -4;
  const decals = new THREE.InstancedMesh(decalGeo, decalMat, MAX_DECALS);
  decals.count = 0;
  decals.frustumCulled = false;
  decals.receiveShadow = true;
  decals.name = "paint-decals";
  decals.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  decals.setColorAt(0, new THREE.Color(1, 1, 1));
  let decalHead = 0;
  let decalTotal = 0;

  const col = new THREE.Color();
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const zAxis = new THREE.Vector3(0, 0, 1);
  const nrm = new THREE.Vector3();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const spin = new THREE.Quaternion();
  const gutM = (GUT / INNER) * PAGE;

  function splat(x: number, y: number, z: number, nx: number, ny: number, nz: number, radius: number, color: THREE.ColorRepresentation) {
    col.set(color);
    const th = heightAt(world, x, z);
    const onGround = Math.abs(y - th) < 0.45 && ny > 0.25 && !world.holes[gridIndex(x, z)];
    if (onGround) {
      const seed = Math.random();
      const ext = radius * 1.75 * 1.45 + gutM;
      const gx = x + WORLD_HALF, gz = z + WORLD_HALF;
      const p0x = Math.max(0, Math.floor((gx - ext) / PAGE)), p1x = Math.min(NP - 1, Math.floor((gx + ext) / PAGE));
      const p0z = Math.max(0, Math.floor((gz - ext) / PAGE)), p1z = Math.min(NP - 1, Math.floor((gz + ext) / PAGE));
      for (let pz = p0z; pz <= p1z; pz++) for (let px = p0x; px <= p1x; px++) {
        if (queued >= MAX_BATCH) return;
        const page = pz * NP + px;
        const s = slotFor(page);
        aSplat.setXYZW(queued, gx - px * PAGE, gz - pz * PAGE, radius, seed);
        aSlot.setXY(queued, s % slotsPerSide, Math.floor(s / slotsPerSide));
        aCol.setXYZW(queued, col.r, col.g, col.b, 0);
        queued++;
      }
      return;
    }
    // on a water surface with nothing solid near: dissolves
    if (Math.abs(y) < 0.3 && th < y - 0.5) return;
    nrm.set(nx, ny, nz).normalize();
    q.setFromUnitVectors(zAxis, nrm);
    spin.setFromAxisAngle(zAxis, Math.random() * Math.PI * 2);
    q.multiply(spin);
    pos.set(x, y, z).addScaledVector(nrm, 0.02);
    const sc = radius * 1.75;
    m4.compose(pos, q, scl.set(sc, sc, sc));
    const i = decalHead;
    decals.setMatrixAt(i, m4);
    decals.setColorAt(i, col);
    aDecal.setX(i, Math.random());
    decalHead = (decalHead + 1) % MAX_DECALS;
    decalTotal = Math.min(MAX_DECALS, decalTotal + 1);
    decals.count = decalTotal;
    decals.instanceMatrix.needsUpdate = true;
    if (decals.instanceColor) decals.instanceColor.needsUpdate = true;
    aDecal.needsUpdate = true;
  }

  function clearAll(renderer: THREE.WebGLRenderer) {
    const prev = renderer.getRenderTarget();
    const cc = renderer.getClearColor(new THREE.Color());
    const ca = renderer.getClearAlpha();
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);
    renderer.setClearColor(cc, ca);
    renderer.setRenderTarget(prev);
    needsClear = false;
  }

  function drawBatch(renderer: THREE.WebGLRenderer, count: number, mat: THREE.ShaderMaterial) {
    inst.instanceCount = count;
    aSplat.needsUpdate = true; aSlot.needsUpdate = true; aCol.needsUpdate = true;
    splatMesh.material = mat;
    renderer.render(splatScene, cam);
  }

  return {
    uniforms,
    decals,
    splat,
    flush(renderer) {
      if (needsClear) clearAll(renderer);
      if (queued === 0 && clears.length === 0) return;
      const prev = renderer.getRenderTarget();
      const auto = renderer.autoClear;
      renderer.autoClear = false;
      renderer.setRenderTarget(rt);
      if (clears.length) {
        // stash queued splats, draw slot clears first
        const saveS = (aSplat.array as Float32Array).slice(0, queued * 4);
        const saveL = (aSlot.array as Float32Array).slice(0, queued * 2);
        const saveC = (aCol.array as Float32Array).slice(0, queued * 4);
        clears.forEach((s, i) => {
          aSlot.setXY(i, s % slotsPerSide, Math.floor(s / slotsPerSide));
          aCol.setXYZW(i, 0, 0, 0, 1);
        });
        drawBatch(renderer, clears.length, clearMat);
        (aSplat.array as Float32Array).set(saveS);
        (aSlot.array as Float32Array).set(saveL);
        (aCol.array as Float32Array).set(saveC);
        clears.length = 0;
      }
      if (queued) drawBatch(renderer, queued, splatMat);
      renderer.setRenderTarget(prev);
      renderer.autoClear = auto;
      queued = 0;
    },
    clear(renderer) {
      clearAll(renderer);
      pageSlot.fill(-1); slotPage.fill(-1); pageData.fill(0); pages.needsUpdate = true;
      decals.count = 0; decalHead = 0; decalTotal = 0;
    },
    stats() {
      let n = 0;
      for (let i = 0; i < nSlots; i++) if (slotPage[i] >= 0) n++;
      return { pages: n, decals: decalTotal };
    },
    dispose() {
      rt.dispose(); pages.dispose(); quad.dispose(); inst.dispose(); splatMat.dispose(); clearMat.dispose(); decalGeo.dispose(); decalMat.dispose();
    },
  };
}
