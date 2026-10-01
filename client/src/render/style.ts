// Shared art direction. Every mesh in the game should get its material from
// here so the whole island reads as one style. The world aims at stylized
// realism (a lush volcanic Pacific island: photo-textured ground, natural
// greens, Lambert-ish light); characters keep the softer Luca look.
//
// Owners may add helpers and palette entries; don't change existing signatures.
import * as THREE from "three";

export const PALETTE = {
  sand: 0xf3dcaa,
  wetSand: 0xd9b980,
  grass: 0x8cc152,
  jungle: 0x4f9a3a,
  meadow: 0xa9c867,
  scrub: 0xa3a05a,
  rock: 0xa89a8a,
  cliff: 0x9a8574,
  dirt: 0xc49a6c,
  shallows: 0x4fd6d0,
  sea: 0x1d8fc4,
  deepSea: 0x145d96,
  stuccoWarm: [0xf2c68c, 0xe8a87c, 0xf5e0b5, 0xe89f8f, 0xf7d9a0, 0xb8d8c8],
  terracotta: 0xc8643c,
  shutterGreen: 0x4f8a6b,
  wood: 0x9b6b43,
  woodDark: 0x6b4428,
  skyTop: 0x3f9be0,
  skyHorizon: 0xbfe6f5,
  sun: 0xfff1d6,
} as const;

let ramp: THREE.DataTexture | null = null;

/** 4-step soft light ramp for MeshToonMaterial: shadow is lifted, never black. */
export function toonRamp(): THREE.DataTexture {
  if (ramp) return ramp;
  const steps = [150, 190, 230, 255];
  const data = new Uint8Array(steps.length * 4);
  steps.forEach((v, i) => data.set([v, v, v, 255], i * 4));
  ramp = new THREE.DataTexture(data, steps.length, 1, THREE.RGBAFormat);
  ramp.minFilter = THREE.LinearFilter;
  ramp.magFilter = THREE.LinearFilter;
  ramp.needsUpdate = true;
  return ramp;
}

export interface ToonOptions {
  color?: THREE.ColorRepresentation;
  vertexColors?: boolean;
  side?: THREE.Side;
  transparent?: boolean;
  opacity?: number;
}

/** The default material for props, structures, actors. */
export function makeToonMaterial(opts: ToonOptions = {}): THREE.MeshToonMaterial {
  return new THREE.MeshToonMaterial({
    color: opts.color ?? 0xffffff,
    vertexColors: opts.vertexColors ?? false,
    gradientMap: toonRamp(),
    side: opts.side ?? THREE.FrontSide,
    transparent: opts.transparent ?? false,
    opacity: opts.opacity ?? 1,
  });
}

// ---------------------------------------------------------------------------
// World renderer additions (render/ owner). Additive only.

/** Extra palette entries used by the world renderer. */
export const WORLD_PALETTE = {
  limestone: 0xd9c9ab,
  limestoneWarm: 0xc9a883,
  seabed: 0xe6d4a0,
  jungleDeep: 0x3f8a3a,
  palmFrond: 0x6fb83f,
  pineCanopy: 0x4c7f3a,
  cypress: 0x35602f,
  olive: 0x9aae78,
  bougainvillea: 0xd63fa0,
  lemon: 0xf7d83a,
  agave: 0x8fb3a0,
  bark: 0x8a6a4f,
  barkPale: 0xb09a80,
  driftwood: 0xcdbfa8,
  foam: 0xffffff,
  caveRock: 0x5a6070,
  glowTeal: 0x5ff5e0,
  glowViolet: 0xb57bff,
} as const;

let worldRampTex: THREE.DataTexture | null = null;

/**
 * Light ramp for world materials (coord = N·L * 0.5 + 0.5): a slightly
 * wrapped Lambert, so slopes shade gradually like real ground instead of the
 * flat "lit or not" toon look. Faces turned away from the sun get no direct
 * light, so they match cast shadows; the hemisphere ambient fills them.
 */
export function worldRamp(): THREE.DataTexture {
  if (worldRampTex) return worldRampTex;
  const n = 128;
  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const nl = (i / (n - 1)) * 2 - 1;
    const x = Math.min(1, Math.max(0, (nl + 0.1) / 1.1));
    // soft (C1) toe at the terminator
    const a = 0.12;
    const v = (x < a ? (x * x) / (2 * a) : x - a / 2) / (1 - a / 2);
    const b = Math.round(Math.min(1, v) * 255);
    data.set([b, b, b, 255], i * 4);
  }
  worldRampTex = new THREE.DataTexture(data, n, 1, THREE.RGBAFormat);
  worldRampTex.minFilter = THREE.LinearFilter;
  worldRampTex.magFilter = THREE.LinearFilter;
  worldRampTex.needsUpdate = true;
  return worldRampTex;
}
