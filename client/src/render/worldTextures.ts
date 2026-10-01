// GPU textures derived from the World grids, plus CPU-side samplers.
// All grid textures are GRID_RES^2 with texel centers on grid samples:
//   uv = ((x + WORLD_HALF) / CELL + 0.5) / GRID_RES
import * as THREE from "three";
import { Biome, CELL, GRID_RES, NO_WATER, WORLD_HALF, type World } from "../../../shared/world/types";
import { PALETTE, WORLD_PALETTE } from "./style";

export interface WorldTextures {
  height: THREE.DataTexture; // R16F height
  ground: THREE.DataTexture; // sRGB base color, a = AO
  mask: THREE.DataTexture; // r rock, g sand, b path, a paving (village)
  normal: THREE.DataTexture; // rg normal xz, b shore/wet (unused), a holes
  floor: THREE.DataTexture; // r jungle floor, g Mediterranean forest floor (blurred biome weights)
  normals: Float32Array; // CPU normals, 3 per sample
  ao: Float32Array;
  dispose(): void;
}

/** GLSL: map world xz to grid-texture uv. */
export const GRID_UV_GLSL = /* glsl */ `
vec2 gridUV(vec2 xz) { return ((xz + ${WORLD_HALF.toFixed(1)}) / ${CELL.toFixed(4)} + 0.5) / ${GRID_RES.toFixed(1)}; }
`;

export function heightAt(world: World, x: number, z: number): number {
  const gx = (x + WORLD_HALF) / CELL, gz = (z + WORLD_HALF) / CELL;
  const ix = Math.max(0, Math.min(GRID_RES - 2, Math.floor(gx)));
  const iz = Math.max(0, Math.min(GRID_RES - 2, Math.floor(gz)));
  const fx = Math.max(0, Math.min(1, gx - ix)), fz = Math.max(0, Math.min(1, gz - iz));
  const h = world.height;
  const i = iz * GRID_RES + ix;
  const a = h[i], b = h[i + 1], c = h[i + GRID_RES], d = h[i + GRID_RES + 1];
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}

export function gridIndex(x: number, z: number): number {
  const ix = Math.max(0, Math.min(GRID_RES - 1, Math.round((x + WORLD_HALF) / CELL)));
  const iz = Math.max(0, Math.min(GRID_RES - 1, Math.round((z + WORLD_HALF) / CELL)));
  return iz * GRID_RES + ix;
}

/** Fresh water level at (x,z), or NO_WATER. */
export function freshWaterAt(world: World, x: number, z: number): number {
  return world.water[gridIndex(x, z)];
}

// Mean ground colors (sRGB); the terrain shader adds photo-texture detail on top.
const BIOME_COLOR: Record<number, number> = {
  [Biome.DeepOcean]: 0xb9a780,
  [Biome.Shallows]: WORLD_PALETTE.seabed,
  [Biome.Beach]: PALETTE.sand,
  [Biome.PalmGrove]: 0x8c9a58,
  [Biome.Jungle]: 0x4f6a32,
  [Biome.Forest]: 0x76683f,
  [Biome.Mangrove]: 0x5c7240,
  [Biome.Meadow]: 0x7b9645,
  [Biome.Scrub]: 0x8f8b56,
  [Biome.Rock]: 0x6f7a48,
  [Biome.Cliff]: 0x667345,
  [Biome.Riverbank]: 0x5e8a3e,
  [Biome.Village]: 0x9c8a6c,
};

/** Climate tint on vegetated ground: [target sRGB, amount]. */
const CLIMATE_TINT: Record<string, [number, number]> = {
  lush: [0x3f6a2c, 0.3],
  tropical: [0x557a34, 0.12],
  mediterranean: [0x9a9358, 0.22],
  dry: [0xb0a062, 0.42],
};

function boxBlur(src: Float32Array, n: number, r: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const w = 1 / (2 * r + 1);
  for (let z = 0; z < n; z++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[z * n + Math.min(n - 1, Math.max(0, k))];
    for (let x = 0; x < n; x++) {
      tmp[z * n + x] = acc * w;
      const xa = Math.min(n - 1, x + r + 1), xr = Math.max(0, x - r);
      acc += src[z * n + xa] - src[z * n + xr];
    }
  }
  for (let x = 0; x < n; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += tmp[Math.min(n - 1, Math.max(0, k)) * n + x];
    for (let z = 0; z < n; z++) {
      out[z * n + x] = acc * w;
      const za = Math.min(n - 1, z + r + 1), zr = Math.max(0, z - r);
      acc += tmp[za * n + x] - tmp[zr * n + x];
    }
  }
  return out;
}

export function buildWorldTextures(world: World): WorldTextures {
  const N = GRID_RES;
  const n = N * N;
  const h = world.height;

  // --- height (half float) ---
  const hHalf = new Uint16Array(n);
  for (let i = 0; i < n; i++) hHalf[i] = THREE.DataUtils.toHalfFloat(h[i]);
  const height = new THREE.DataTexture(hHalf, N, N, THREE.RedFormat, THREE.HalfFloatType);
  height.magFilter = height.minFilter = THREE.LinearFilter;
  height.wrapS = height.wrapT = THREE.ClampToEdgeWrapping;
  height.needsUpdate = true;

  // --- normals ---
  const normals = new Float32Array(n * 3);
  const nrmData = new Uint8Array(n * 4);
  for (let z = 0; z < N; z++) {
    for (let x = 0; x < N; x++) {
      const i = z * N + x;
      const hl = h[z * N + Math.max(0, x - 1)], hr = h[z * N + Math.min(N - 1, x + 1)];
      const hd = h[Math.max(0, z - 1) * N + x], hu = h[Math.min(N - 1, z + 1) * N + x];
      let nx = -(hr - hl) / (2 * CELL), ny = 1, nz = -(hu - hd) / (2 * CELL);
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      normals[i * 3] = nx; normals[i * 3 + 1] = ny; normals[i * 3 + 2] = nz;
      nrmData[i * 4] = Math.round((nx * 0.5 + 0.5) * 255);
      nrmData[i * 4 + 1] = Math.round((nz * 0.5 + 0.5) * 255);
      nrmData[i * 4 + 2] = world.water[i] !== NO_WATER ? 255 : 0;
      nrmData[i * 4 + 3] = world.holes[i] ? 255 : 0;
    }
  }
  const normal = new THREE.DataTexture(nrmData, N, N, THREE.RGBAFormat);
  normal.magFilter = normal.minFilter = THREE.LinearFilter;
  normal.needsUpdate = true;

  // --- AO: concavity at two scales ---
  const hf = new Float32Array(h);
  const blurBig = boxBlur(boxBlur(hf, N, 5), N, 5);
  const blurSmall = boxBlur(hf, N, 2);
  const ao = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const cBig = blurBig[i] - h[i];
    const cSmall = blurSmall[i] - h[i];
    let a = 1 - Math.max(0, cBig) * 0.045 - Math.max(0, cSmall) * 0.12;
    a += Math.max(0, -cBig) * 0.01; // ridges slightly brighter
    ao[i] = Math.max(0.4, Math.min(1, a));
  }

  // --- ground base color: biome colors blurred, moisture-tinted ---
  const cr = new Float32Array(n), cg = new Float32Array(n), cb = new Float32Array(n);
  const rock = new Float32Array(n), sand = new Float32Array(n), pave = new Float32Array(n);
  const jf = new Float32Array(n), ff = new Float32Array(n);
  const tmp = new THREE.Color();
  const cache = new Map<number, THREE.Color>();
  const dryC = new THREE.Color(0xa89c58), wetC = new THREE.Color(0x4a7a36);
  const [climHex, climK] = CLIMATE_TINT[world.climate ?? "tropical"] ?? CLIMATE_TINT.tropical;
  const climC = new THREE.Color(climHex);
  for (let i = 0; i < n; i++) {
    const b = world.biome[i];
    let col = cache.get(b);
    if (!col) { col = new THREE.Color(BIOME_COLOR[b] ?? PALETTE.grass); cache.set(b, col); }
    tmp.copy(col);
    const m0 = world.moisture[i] / 255;
    if (b === Biome.Jungle) {
      // dark, rich forest floor: wetter -> deeper green, drier -> browner litter
      tmp.lerp(new THREE.Color(0x4a6a30), Math.max(0, m0 - 0.5) * 0.8);
      tmp.lerp(new THREE.Color(0x6f6a3a), Math.max(0, 0.5 - m0) * 0.9);
    } else if (b === Biome.Forest) {
      // warm needle / oak-leaf duff: a touch greener where it's wetter
      tmp.lerp(new THREE.Color(0x707a44), Math.max(0, m0 - 0.45) * 0.7);
    }
    const veg = b === Biome.Meadow || b === Biome.PalmGrove || b === Biome.Scrub || b === Biome.Riverbank || b === Biome.Mangrove || b === Biome.Rock || b === Biome.Cliff;
    if (veg) {
      const m = world.moisture[i] / 255;
      // dry -> straw, wet -> deep lush
      tmp.lerp(dryC, Math.max(0, 0.45 - m) * 0.9);
      tmp.multiplyScalar(0.94 + (1 - m) * 0.1);
      if (m > 0.6) tmp.lerp(wetC, (m - 0.6) * 0.5);
    }
    if (veg || b === Biome.Jungle) tmp.lerp(climC, climK);
    cr[i] = tmp.r; cg[i] = tmp.g; cb[i] = tmp.b;
    rock[i] = b === Biome.Rock || b === Biome.Cliff ? 1 : 0;
    sand[i] = b === Biome.Beach || b === Biome.Shallows || b === Biome.DeepOcean ? 1 : b === Biome.PalmGrove ? 0.35 : 0;
    pave[i] = b === Biome.Village ? 1 : 0;
    jf[i] = b === Biome.Jungle ? 1 : 0;
    ff[i] = b === Biome.Forest ? 1 : 0;
  }
  const jfB = boxBlur(boxBlur(jf, N, 2), N, 1), ffB = boxBlur(boxBlur(ff, N, 2), N, 1);
  const fData = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    // ramp so the floor reaches full strength a few meters inside the biome edge
    fData[i * 4] = Math.round(Math.min(1, jfB[i] * 1.6) * 255);
    fData[i * 4 + 1] = Math.round(Math.min(1, ffB[i] * 1.6) * 255);
  }
  const floor = new THREE.DataTexture(fData, N, N, THREE.RGBAFormat);
  floor.magFilter = THREE.LinearFilter;
  floor.minFilter = THREE.LinearMipmapLinearFilter;
  floor.generateMipmaps = true;
  floor.needsUpdate = true;
  const br = boxBlur(cr, N, 1), bg = boxBlur(cg, N, 1), bb = boxBlur(cb, N, 1);
  const rockB = boxBlur(rock, N, 1), sandB = boxBlur(sand, N, 1), paveB = boxBlur(pave, N, 1);
  const gData = new Uint8Array(n * 4);
  const mData = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    tmp.setRGB(br[i], bg[i], bb[i]); // linear
    tmp.convertLinearToSRGB();
    gData[i * 4] = Math.round(Math.min(1, tmp.r) * 255);
    gData[i * 4 + 1] = Math.round(Math.min(1, tmp.g) * 255);
    gData[i * 4 + 2] = Math.round(Math.min(1, tmp.b) * 255);
    gData[i * 4 + 3] = Math.round(ao[i] * 255);
    mData[i * 4] = Math.round(rockB[i] * 255);
    mData[i * 4 + 1] = Math.round(sandB[i] * 255);
    mData[i * 4 + 2] = world.path[i];
    mData[i * 4 + 3] = Math.round(paveB[i] * 255);
  }
  const ground = new THREE.DataTexture(gData, N, N, THREE.RGBAFormat);
  ground.colorSpace = THREE.SRGBColorSpace;
  ground.magFilter = THREE.LinearFilter;
  ground.minFilter = THREE.LinearMipmapLinearFilter;
  ground.generateMipmaps = true;
  ground.needsUpdate = true;
  const mask = new THREE.DataTexture(mData, N, N, THREE.RGBAFormat);
  mask.magFilter = THREE.LinearFilter;
  mask.minFilter = THREE.LinearMipmapLinearFilter;
  mask.generateMipmaps = true;
  mask.needsUpdate = true;

  return {
    height, ground, mask, normal, floor, normals, ao,
    dispose() { height.dispose(); ground.dispose(); mask.dispose(); normal.dispose(); floor.dispose(); },
  };
}
