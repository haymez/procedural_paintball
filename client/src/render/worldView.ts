// The world renderer the game uses:
//
//   const view = createWorldView(renderer, world, { quality: "medium" });
//   // per frame
//   view.update(dt, camera, time);
//   view.render(camera);
//   // paintballs
//   view.paint.splat(x, y, z, nx, ny, nz, radius, color);
//
// Add actors to `view.scene`; they get sun shadows, fog and grading for free.
import * as THREE from "three";
import { SunLight } from "three/examples/jsm/lights/SunLight.js";
import { NO_WATER, SEA_LEVEL, type World } from "../../../shared/world/types";
import { computeEnv, makeEnvUniforms, makeNoiseTexture, type Env, type EnvUniforms } from "./env";
import { createPaintLayer } from "./paint";
import { createPost } from "./post";
import { QUALITY, type Quality, type QualityPreset } from "./quality";
import { createClouds } from "./sky";
import { createTerrain } from "./terrain";
import { buildWorldTextures, freshWaterAt, heightAt } from "./worldTextures";
import { createWater } from "./water";
import { createProps } from "./props/props";
import { createStructures } from "./structures";
import { createCaves, type CaveSdf } from "./caves";

export type { Quality, QualityPreset } from "./quality";
export { createWorldRenderer, QUALITY } from "./quality";

export interface WorldViewOptions {
  quality: Quality;
  /** Override the cave SDF (default: shared/world/collide.ts caveSdf; negative inside the air). */
  caveSdf?: CaveSdf;
  /** Override individual preset values (tuning / settings menu). */
  overrides?: Partial<QualityPreset>;
}

export interface WorldView {
  scene: THREE.Scene;
  env: Env;
  /** LOD, culling, wind, water animation, shadows following the camera. */
  update(dt: number, camera: THREE.PerspectiveCamera, time: number): void;
  /** Renders scene + sky + fog + post to the canvas. */
  render(camera: THREE.PerspectiveCamera): void;
  paint: {
    splat(x: number, y: number, z: number, nx: number, ny: number, nz: number, radius: number, color: THREE.ColorRepresentation): void;
    clear(): void;
  };
  /** True while caves are still being meshed in the background (a few ms per update()). */
  readonly loading: boolean;
  /** Finish all background work now (e.g. behind a loading screen). */
  finishLoading(): void;
  /** Do up to ms of background work (cave meshing). */
  stepLoading(ms: number): void;
  /** Caves still to mesh. */
  readonly cavesLeft: number;
  /** True while the last update() found the camera below a water surface. */
  readonly underwater: boolean;
  /** 0..1, how far inside a cave the camera is (drives cave fog). */
  readonly caveFactor: number;
  /** Ocean wave displacement (m) at x,z — matches the rendered swell (bob boats with it). */
  waveHeight(x: number, z: number, time: number): number;
  /** Surface height of the water (sea or fresh) at x,z, or null if dry. */
  waterLevelAt(x: number, z: number): number | null;
  /**
   * Player position (feet) for the third-person camera: leafy props between the
   * lens and the player's head dither out. null disables. Foliage within ~2.5 m
   * of the camera always dithers out.
   */
  setFocus(feet: { x: number; y: number; z: number } | null, headHeight?: number): void;
  /** Force the underwater look (e.g. from the game's swim state); null = auto from camera. */
  setUnderwater(v: boolean | null): void;
  /** Visible-world stats for debugging (props instances drawn etc.). */
  debugInfo(): Record<string, number>;
  /** Per-kind prop instance/triangle breakdown (debug). */
  propBreakdown(): Record<string, [number, number, number]>;
  dispose(): void;
}

/** Build steps createWorldViewAsync reports (ids for loading screens). */
export type WorldViewStep = "textures" | "terrain" | "water" | "props" | "structures" | "caves" | "shaders";

export function createWorldView(renderer: THREE.WebGLRenderer, world: World, opts: WorldViewOptions): WorldView {
  const it = buildWorldView(renderer, world, opts);
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
  }
}

/**
 * Same as createWorldView, yielding to the browser between build steps (and
 * while meshing caves) so a loading screen can animate and report progress.
 * onStep(step, t) — t in [0, 1] across the whole build.
 */
export async function createWorldViewAsync(
  renderer: THREE.WebGLRenderer, world: World, opts: WorldViewOptions, onStep?: (step: WorldViewStep, t: number) => void,
): Promise<WorldView> {
  const order: WorldViewStep[] = ["textures", "terrain", "water", "props", "structures", "caves"];
  const it = buildWorldView(renderer, world, opts);
  const frame = () => new Promise<void>((r) => setTimeout(r, 0));
  for (;;) {
    const r = it.next();
    if (r.done) {
      const view = r.value;
      // caves mesh in slices; keep the page alive while they do
      const total = world.caves.length || 1;
      while (view.loading) {
        view.stepLoading(24);
        onStep?.("caves", (order.length - 1 + 1 - view.cavesLeft / total) / order.length);
        await frame();
      }
      // compile the world's shaders now rather than on the first frame of play
      onStep?.("shaders", 1);
      await frame();
      try {
        const cam = new THREE.PerspectiveCamera(70, 16 / 9, 0.2, 7000);
        cam.position.set(0, 60, 0);
        cam.updateMatrixWorld();
        const hidden: THREE.Object3D[] = [];
        view.scene.traverse((o) => { if (!o.visible) { hidden.push(o); o.visible = true; } });
        try { await renderer.compileAsync(view.scene, cam); }
        finally { for (const o of hidden) o.visible = false; }
      } catch (e) {
        console.warn("[world view] shader warm-up failed", e);
      }
      return view;
    }
    onStep?.(r.value, order.indexOf(r.value) / order.length);
    await frame();
  }
}

function* buildWorldView(renderer: THREE.WebGLRenderer, world: World, opts: WorldViewOptions): Generator<WorldViewStep, WorldView, void> {
  const q: QualityPreset = { ...QUALITY[opts.quality], ...(opts.overrides ?? {}) };
  const env = computeEnv(world.timeOfDay);
  const noise = makeNoiseTexture();
  const U: EnvUniforms = makeEnvUniforms(env, world.windDir, noise);

  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.info.autoReset = false;

  const scene = new THREE.Scene();
  scene.background = null;

  // --- lights ---
  const hemi = new THREE.HemisphereLight(env.hemiSky, env.hemiGround, env.hemiIntensity);
  scene.add(hemi);
  const sun = new SunLight(env.sunLight, env.sunIntensity);
  sun.position.copy(env.sunDir);
  sun.castShadow = true;
  sun.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = q.shadowDistance;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.14;
  sun.shadow.radius = 2;
  scene.add(sun);

  const buildTimes: Record<string, number> = {};
  let tb = performance.now();
  const lap = (k: string) => { const n = performance.now(); buildTimes[k] = Math.round(n - tb); tb = n; };
  yield "textures";
  const tex = buildWorldTextures(world);
  lap("textures");
  yield "terrain";
  const paint = createPaintLayer(world, U, q.paintResolution);
  scene.add(paint.decals);

  const terrain = createTerrain(world, tex, U, paint.uniforms, { lodDistances: q.terrainLod });
  scene.add(terrain.group);
  lap("terrain");

  const clouds = createClouds(world.seed, U, q.clouds);
  scene.add(clouds.mesh);
  lap("clouds");
  yield "water";

  const water = createWater(world, tex, U, { segments: q.waterSegments });
  scene.add(water.group);
  lap("water");
  yield "props";

  const props = createProps(world, U, { density: q.foliageDensity, distance: q.foliageDistance, shadowDistance: q.shadowDistance, groundCover: q.groundCover });
  scene.add(props.group);
  lap("props");
  yield "structures";

  const structures = createStructures(world, U);
  scene.add(structures.group);
  lap("structures");
  yield "caves";

  const caves = createCaves(world, U, opts.caveSdf, terrain.material);
  scene.add(caves.group);
  lap("caves");

  const post = createPost(renderer, U, { msaa: q.msaa, bloom: q.bloom, scale: q.scale });

  let underwater = false;
  let forcedUnderwater: boolean | null = null;
  let caveFactor = 0;
  const bufSize = new THREE.Vector2();
  const lastSize = new THREE.Vector2();
  renderer.getDrawingBufferSize(lastSize);

  function waterLevelAt(x: number, z: number): number | null {
    const fresh = freshWaterAt(world, x, z);
    const ground = heightAt(world, x, z);
    if (fresh !== NO_WATER && fresh > ground) return fresh;
    if (ground < SEA_LEVEL) return SEA_LEVEL;
    return null;
  }

  return {
    scene,
    env,
    get underwater() { return underwater; },
    get loading() { return caves.pending; },
    finishLoading() { caves.finish(); },
    stepLoading(ms) { caves.step(ms); },
    get cavesLeft() { return caves.left; },
    get caveFactor() { return caveFactor; },
    waterLevelAt,
    waveHeight: (x, z, t) => water.waveHeight(x, z, t),
    setUnderwater(v) { forcedUnderwater = v; },
    setFocus(feet, headHeight = 1.3) {
      if (feet) U.uFocus.value.set(feet.x, feet.y + headHeight, feet.z, 1);
      else U.uFocus.value.w = 0;
    },
    update(dt, camera, time) {
      U.uTime.value = time;
      camera.updateMatrixWorld();
      const cp = camera.position;
      terrain.update(camera);
      clouds.update(camera, time);
      water.update(camera, time);
      props.update(camera);
      structures.update(camera);
      caveFactor = caves.update(camera, dt);

      const wl = waterLevelAt(cp.x, cp.z);
      const waveY = wl === SEA_LEVEL ? water.waveHeight(cp.x, cp.z, time) : 0;
      underwater = forcedUnderwater ?? (wl !== null && cp.y < wl + waveY - 0.05);
      post.uniforms.uUnderwater.value = underwater ? 1 : 0;
      post.uniforms.uWaterLevel.value = wl ?? SEA_LEVEL;
      post.uniforms.uCave.value = caveFactor;
      // sun and hemi dim a bit deep in caves / underwater for actors
      hemi.intensity = env.hemiIntensity * (1 - caveFactor * 0.75);
      sun.intensity = env.sunIntensity * (1 - caveFactor * 0.85);
    },
    render(camera) {
      renderer.getDrawingBufferSize(bufSize);
      if (!bufSize.equals(lastSize)) {
        lastSize.copy(bufSize);
        post.setSize(bufSize.x, bufSize.y);
      }
      renderer.info.reset();
      paint.flush(renderer);
      post.render(renderer, scene, camera);
    },
    paint: {
      splat: paint.splat,
      clear: () => paint.clear(renderer),
    },
    debugInfo() {
      return { ...props.debugInfo(), ...Object.fromEntries(Object.entries(buildTimes).map(([k, v]) => ["build_" + k, v])), caveFactor: +caveFactor.toFixed(2), paintPages: paint.stats().pages, decals: paint.stats().decals };
    },
    propBreakdown: () => props.breakdown(),
    dispose() {
      terrain.dispose(); clouds.dispose(); water.dispose(); props.dispose(); structures.dispose(); caves.dispose();
      paint.dispose(); post.dispose(); tex.dispose(); noise.dispose();
      sun.dispose();
    },
  };
}
