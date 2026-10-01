// Sky: the gradient, sun and the fair-weather cumulus layer are drawn
// analytically in the composite pass (glsl.ts SKY_FN / CLOUD_FN) and in water
// reflections. This module just sets the per-island cloud layer: trade-wind
// cumulus, more of it over lush islands, little over dry ones.
import * as THREE from "three";
import type { World } from "../../../shared/world/types";

export interface Clouds {
  mesh: THREE.Object3D;
  update(camera: THREE.Camera, time: number): void;
  dispose(): void;
}

const COVERAGE: Record<string, [number, number]> = {
  lush: [0.5, 0.7],
  tropical: [0.38, 0.58],
  mediterranean: [0.22, 0.45],
  dry: [0.1, 0.32],
};

export function createClouds(world: World, env: Record<string, THREE.IUniform>, density = 1): Clouds {
  let s = (world.seed * 2654435761) >>> 0 || 1;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const [lo, hi] = COVERAGE[world.climate ?? "tropical"] ?? COVERAGE.tropical;
  const cov = lo + (hi - lo) * rnd();
  (env.uCloud.value as THREE.Vector4).set(cov * Math.min(1, density), rnd() * 7.3, rnd() * 5.1, 1500 + rnd() * 500);
  const mesh = new THREE.Group();
  mesh.name = "clouds";
  return { mesh, update() {}, dispose() {} };
}
