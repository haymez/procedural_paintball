import * as THREE from "three";

export type Quality = "low" | "medium" | "high";

export interface QualityPreset {
  /** Scene render-target scale relative to the drawing buffer. */
  scale: number;
  /** Max device pixel ratio the game/viewer should use for the canvas. */
  maxPixelRatio: number;
  msaa: number;
  bloom: boolean;
  shadowMapSize: number; // per cascade
  shadowDistance: number;
  foliageDensity: number; // fraction of small-prop instances kept
  foliageDistance: number; // multiplier on per-kind draw distances
  groundCover: number; // render-only undergrowth amount (0 = off)
  terrainLod: number[];
  waterSegments: number;
  paintResolution: number;
  clouds: number;
}

export const QUALITY: Record<Quality, QualityPreset> = {
  low: {
    scale: 0.8, maxPixelRatio: 1, msaa: 0, bloom: false,
    shadowMapSize: 1024, shadowDistance: 70,
    foliageDensity: 0.45, foliageDistance: 0.6, groundCover: 0.6,
    terrainLod: [140, 300, 560], waterSegments: 96, paintResolution: 2048, clouds: 8,
  },
  medium: {
    scale: 1, maxPixelRatio: 1, msaa: 4, bloom: true,
    shadowMapSize: 2048, shadowDistance: 120,
    foliageDensity: 0.8, foliageDistance: 0.85, groundCover: 1,
    terrainLod: [200, 420, 720], waterSegments: 160, paintResolution: 4096, clouds: 11,
  },
  high: {
    scale: 1, maxPixelRatio: 1.5, msaa: 4, bloom: true,
    shadowMapSize: 2048, shadowDistance: 170,
    foliageDensity: 1, foliageDistance: 1.1, groundCover: 1.3,
    terrainLod: [260, 520, 860], waterSegments: 200, paintResolution: 4096, clouds: 13,
  },
};

/**
 * Recommended renderer for the world view (reversed-Z float depth for the
 * horizon-to-nose depth range; the scene is rendered into our own MSAA target).
 */
export function createWorldRenderer(canvas: HTMLCanvasElement | undefined, quality: Quality, opts: { reversedDepth?: boolean } = {}): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    powerPreference: "high-performance",
    stencil: false,
    reversedDepthBuffer: opts.reversedDepth ?? true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, QUALITY[quality].maxPixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  return renderer;
}
