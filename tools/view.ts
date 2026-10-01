// Free-fly world viewer.
//   ?seed=N&quality=low|medium|high&x=..&y=..&z=..&yaw=deg&pitch=deg
//   ?tour=1        cycle through preset viewpoints (N / P keys, or __debug.shot(i))
//   ?fixtures=1    force synthetic river/cave/structures/props onto the world
//   ?time=h        override time of day
// Controls: WASD move, mouse drag look, Q/E down/up, Shift fast, 1-6 tour shots,
//           F splat paint where you look, U toggle forced underwater.
import * as THREE from "three";
import { stubWorld } from "../shared/world/stub";
import type { World } from "../shared/world/types";
import { createWorldView, createWorldRenderer, type Quality, type WorldView } from "../client/src/render/worldView";
import { addFixtures } from "../client/src/render/dev/fixtures";
import { tourViewpoints, type Viewpoint } from "../client/src/render/dev/tour";
import { raycastWorld } from "../client/src/render/dev/raycast";

const W = window as unknown as { __ready: boolean; __stats: Record<string, number | string>; __debug: Record<string, unknown> };

const params = new URLSearchParams(location.search);
const seed = Number(params.get("seed") ?? 42);
const quality = (params.get("quality") ?? "medium") as Quality;

document.body.style.cssText = "margin:0;overflow:hidden;background:#000;font-family:ui-monospace,Menlo,monospace";
const hud = document.createElement("div");
hud.style.cssText = "position:fixed;left:8px;top:8px;color:#fff;font-size:12px;line-height:1.4;background:rgba(0,0,0,.35);padding:6px 8px;border-radius:6px;pointer-events:none;white-space:pre;z-index:2";
hud.textContent = "loading world…";
document.body.appendChild(hud);

type LoadFn = (seed: number, onProgress?: (stage: string, t: number) => void) => Promise<World>;
type GenFn = (seed: number, opts?: { onProgress?: (stage: string, t: number) => void }) => World;

async function obtainWorld(): Promise<{ world: World; source: string }> {
  const loaders = import.meta.glob("../client/src/world/load.ts");
  const gens = import.meta.glob("../shared/world/generate.ts");
  const progress = (stage: string, t: number) => { hud.textContent = `generating… ${stage} ${(t * 100) | 0}%`; };
  const forceStub = params.get("stub") === "1";
  if (!forceStub) {
    for (const k in loaders) {
      try {
        const mod = (await loaders[k]()) as { loadWorld?: LoadFn };
        if (mod.loadWorld) return { world: await mod.loadWorld(seed, progress), source: "loadWorld" };
      } catch (e) { console.warn("loadWorld failed, falling back", e); }
    }
    for (const k in gens) {
      try {
        const mod = (await gens[k]()) as { generateWorld?: GenFn; generate?: GenFn };
        const fn = mod.generateWorld ?? mod.generate;
        if (fn) return { world: fn(seed, { onProgress: progress }), source: "generate" };
      } catch (e) { console.warn("generate failed, falling back", e); }
    }
  }
  return { world: stubWorld(seed), source: "stub" };
}

async function main() {
  const { world, source } = await obtainWorld();
  // stub: build every feature; real world: only fill layers the generator doesn't produce yet
  const fixtureMode = params.get("fixtures") === "0" ? null : source === "stub" || params.get("fixtures") === "full" ? "full" : "fill";
  const filled = fixtureMode ? addFixtures(world, fixtureMode).filled : [];
  const useFixtures = filled.length > 0;
  if (params.has("time")) world.timeOfDay = Number(params.get("time"));

  const renderer = createWorldRenderer(undefined, quality, { reversedDepth: params.get("rz") !== "0" });
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer.domElement);

  const t0 = performance.now();
  const overrides: Record<string, number | boolean> = {};
  for (const k of ["msaa", "scale", "shadowMapSize", "shadowDistance", "foliageDensity", "foliageDistance"]) if (params.has(k)) overrides[k] = Number(params.get(k));
  if (params.has("bloom")) overrides.bloom = params.get("bloom") === "1";
  const view: WorldView = createWorldView(renderer, world, { quality, overrides });
  const buildMs = performance.now() - t0;

  const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.2, 7000);
  const tour = tourViewpoints(world);
  let yaw = 0, pitch = 0;
  const setCam = (x: number, y: number, z: number, yawDeg: number, pitchDeg: number) => {
    camera.position.set(x, y, z);
    yaw = THREE.MathUtils.degToRad(yawDeg);
    pitch = THREE.MathUtils.degToRad(pitchDeg);
    applyLook();
  };
  const applyLook = () => {
    pitch = THREE.MathUtils.clamp(pitch, -1.5, 1.5);
    const f = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
    camera.lookAt(camera.position.clone().add(f));
  };
  const goShot = (i: number) => {
    const v: Viewpoint | undefined = tour[((i % tour.length) + tour.length) % tour.length];
    if (v) setCam(v.x, v.y, v.z, v.yaw, v.pitch);
    return v?.name;
  };
  if (params.has("x")) {
    setCam(Number(params.get("x")), Number(params.get("y") ?? 30), Number(params.get("z")), Number(params.get("yaw") ?? 0), Number(params.get("pitch") ?? 0));
  } else if (params.has("shot")) {
    goShot(Number(params.get("shot")));
  } else {
    goShot(2);
  }

  // --- input ---
  const keys = new Set<string>();
  window.addEventListener("keydown", (e) => {
    keys.add(e.code);
    if (/^Digit[1-9]$/.test(e.code)) goShot(Number(e.code.slice(5)) - 1);
    if (e.code === "KeyF") splatAhead();
    if (e.code === "KeyU") { forcedUw = forcedUw === null ? true : null; view.setUnderwater(forcedUw); }
  });
  window.addEventListener("keyup", (e) => keys.delete(e.code));
  let forcedUw: boolean | null = null;
  let dragging = false;
  renderer.domElement.addEventListener("mousedown", () => { dragging = true; });
  window.addEventListener("mouseup", () => { dragging = false; });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    yaw -= e.movementX * 0.003;
    pitch -= e.movementY * 0.003;
    applyLook();
  });
  window.addEventListener("resize", () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  });

  const colors = [0xff3b6b, 0x3bd1ff, 0xffd23b, 0x7bff3b, 0xb53bff, 0xff8a3b];
  function splatAhead(n = 1) {
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    let hits = 0;
    for (let i = 0; i < n; i++) {
      const d = dir.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.25, (Math.random() - 0.5) * 0.15, (Math.random() - 0.5) * 0.25)).normalize();
      const hit = raycastWorld(world, view.scene, camera.position, d, 300);
      if (hit) {
        view.paint.splat(hit.point.x, hit.point.y, hit.point.z, hit.normal.x, hit.normal.y, hit.normal.z, 0.5 + Math.random() * 0.6, colors[(Math.random() * colors.length) | 0]);
        hits++;
      }
    }
    return hits;
  }

  // --- stats ---
  W.__stats = {};
  let frames = 0, acc = 0, fps = 0, cpuMs = 0;
  let lastT = performance.now();
  const clock = { t: 0 };

  function frame(dt: number) {
    const speed = (keys.has("ShiftLeft") || keys.has("ShiftRight") ? 60 : 12) * dt;
    const f = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const r = new THREE.Vector3(-Math.cos(yaw), 0, Math.sin(yaw));
    const fw = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
    if (keys.has("KeyW")) camera.position.addScaledVector(fw, speed);
    if (keys.has("KeyS")) camera.position.addScaledVector(fw, -speed);
    if (keys.has("KeyA")) camera.position.addScaledVector(r, -speed);
    if (keys.has("KeyD")) camera.position.addScaledVector(r, speed);
    if (keys.has("KeyE")) camera.position.y += speed;
    if (keys.has("KeyQ")) camera.position.y -= speed;
    void f;
    clock.t += dt;
    const c0 = performance.now();
    view.update(dt, camera, clock.t);
    view.render(camera);
    cpuMs = cpuMs * 0.9 + (performance.now() - c0) * 0.1;
  }

  function publishStats() {
    const info = renderer.info;
    const s = {
      fps: Math.round(fps),
      frameMs: +(fps ? 1000 / fps : 0).toFixed(2),
      cpuMs: +cpuMs.toFixed(2),
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      buildMs: Math.round(buildMs),
      quality,
      source: source + (useFixtures ? `+fixtures(${filled.join(",")})` : ""),
      underwater: view.underwater ? 1 : 0,
      ...view.debugInfo(),
    } as Record<string, number | string>;
    W.__stats = s;
    const p = camera.position;
    hud.textContent =
      `${world.name} · seed ${seed} · ${s.source} · ${quality}\n` +
      `${s.fps} fps  ${s.frameMs} ms  cpu ${s.cpuMs} ms\n` +
      `draws ${s.drawCalls}  tris ${(Number(s.triangles) / 1000).toFixed(0)}k\n` +
      `pos ${p.x.toFixed(0)} ${p.y.toFixed(1)} ${p.z.toFixed(0)}  yaw ${THREE.MathUtils.radToDeg(yaw).toFixed(0)} pitch ${THREE.MathUtils.radToDeg(pitch).toFixed(0)}` +
      (tourOn ? `\ntour ${((tourIdx % tour.length) + tour.length) % tour.length}: ${tour[((tourIdx % tour.length) + tour.length) % tour.length]?.name}  (N/P)` : "") +
      (view.underwater ? "  [underwater]" : "") + (view.caveFactor > 0.01 ? `  [cave ${view.caveFactor.toFixed(2)}]` : "");
  }

  W.__debug = {
    camera: (x: number, y: number, z: number, yawDeg: number, pitchDeg: number) => { setCam(x, y, z, yawDeg, pitchDeg); return true; },
    shot: (i: number) => goShot(i),
    scene: view.scene,
    renderer,
    props: () => view.propBreakdown(),
    look: (yawDeg: number, pitchDeg: number) => { yaw = THREE.MathUtils.degToRad(yawDeg); pitch = THREE.MathUtils.degToRad(pitchDeg); applyLook(); return true; },
    pos: () => [camera.position.x, camera.position.y, camera.position.z, THREE.MathUtils.radToDeg(yaw), THREE.MathUtils.radToDeg(pitch)],
    rivers: () => world.rivers.map((r) => ({ n: r.points.length, first: [r.points[0].x, r.points[0].y, r.points[0].z, r.points[0].width].map((v) => +v.toFixed(1)), last: [r.points[r.points.length - 1].x, r.points[r.points.length - 1].y, r.points[r.points.length - 1].z].map((v) => +v.toFixed(1)) })),
    water: () => { let flowing = 0, still = 0; for (let i = 0; i < world.water.length; i++) if (world.water[i] > -999) { if (Math.hypot(world.flow[i * 2], world.flow[i * 2 + 1]) > 0.05) flowing++; else still++; } return { flowing, still, lakes: world.lakes, falls: world.waterfalls }; },
    probe: (x: number, z: number) => { const ix = Math.round((x + 512) / 2), iz = Math.round((z + 512) / 2); const i = iz * 513 + ix; return { h: world.height[i], water: world.water[i], flow: [world.flow[i * 2], world.flow[i * 2 + 1]], biome: world.biome[i] }; },
    caves: () => world.caves.map((c) => ({ nodes: c.nodes.map((n) => [n.x, n.y, n.z, n.r].map((v) => +v.toFixed(1))), edges: c.edges, entrances: c.entrances.map((e) => [e.x, e.y, e.z].map((v) => +v.toFixed(1))), sky: c.entrances.filter((e) => e.sky).map((e) => [e.x, e.y, e.z].map((v) => +v.toFixed(1)))[0] ?? null, rocks: c.rocks?.length ?? 0 })),
    structs: () => world.structures.map((s) => [s.kind, Math.round(s.x), Math.round(s.y), Math.round(s.z), s.solids.length]),
    /** Camera [x, y, z, yaw, pitch] a few meters from the i-th (spread out) instance of a prop kind, looking at it. */
    nearProp: (kind: number, i = 0, dist = 7) => {
      const ps = world.props.find((p) => p.kind === kind);
      if (!ps || ps.count === 0) return null;
      const k = Math.floor(((i * 0.618034) % 1) * ps.count);
      const x = ps.data[k * 5], y = ps.data[k * 5 + 1], z = ps.data[k * 5 + 2], sc = ps.data[k * 5 + 4];
      const a = i * 2.1, d = dist * Math.max(1, sc);
      const cx = x + Math.sin(a) * d, cz = z + Math.cos(a) * d;
      const cy = y + 1.7 + sc;
      return [cx, cy, cz, THREE.MathUtils.radToDeg(Math.atan2(x - cx, z - cz)), THREE.MathUtils.radToDeg(Math.atan2(y + sc - cy, d))];
    },
    tour: () => tour.map((v, i) => `${i}: ${v.name}`),
    splat: (n = 20) => splatAhead(n),
    underwater: (v: boolean | null) => view.setUnderwater(v),
    hud: (v: boolean) => { hud.style.display = v ? "" : "none"; },
    world: () => ({ biomes: Array.from(world.biome).reduce((m: Record<number, number>, b) => { m[b] = (m[b] ?? 0) + 1; return m; }, {}), moist: world.moisture.reduce((a, b) => a + b, 0) / world.moisture.length, path: world.path.reduce((a, b) => a + (b > 0 ? 1 : 0), 0), wet: world.water.reduce((a, b) => a + (b > -999 ? 1 : 0), 0), holes: world.holes.reduce((a, b) => a + b, 0), hmin: world.height.reduce((a, b) => Math.min(a, b), 1e9), hmax: world.height.reduce((a, b) => Math.max(a, b), -1e9), hlen: world.height.length, name: world.name, time: world.timeOfDay, rivers: world.rivers.length, caves: world.caves.length, structures: world.structures.length, props: world.props.reduce((a, p) => a + p.count, 0) }),
    /** Render n frames synchronously (GPU-synced) and return average ms per frame. */
    bench: (n = 60) => {
      const gl = renderer.getContext();
      const px = new Uint8Array(4);
      frame(1 / 60);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const b0 = performance.now();
      for (let i = 0; i < n; i++) {
        frame(1 / 60);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      }
      const ms = (performance.now() - b0) / n;
      publishStats();
      return { msPerFrame: +ms.toFixed(2), drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
    },
  };
  if (params.get("hud") === "0") hud.style.display = "none";
  // ?tour=1: step through the preset viewpoints (N / P, auto-advance every 6 s)
  let tourIdx = Number(params.get("shot") ?? 0);
  let tourTimer = 0;
  const tourOn = params.get("tour") === "1";
  if (tourOn) goShot(tourIdx);
  window.addEventListener("keydown", (e) => {
    if (e.code === "KeyN") { tourIdx++; goShot(tourIdx); tourTimer = 0; }
    if (e.code === "KeyP") { tourIdx--; goShot(tourIdx); tourTimer = 0; }
  });

  let readyFrames = 0;
  function loop() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - lastT) / 1000);
    lastT = now;
    frame(dt);
    if (tourOn && (tourTimer += dt) > 6) { tourTimer = 0; tourIdx++; goShot(tourIdx); }
    frames++; acc += dt;
    if (acc >= 0.5) { fps = frames / acc; frames = 0; acc = 0; publishStats(); }
    if (readyFrames < 3 && !view.loading && ++readyFrames === 3) { publishStats(); W.__ready = true; }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

main().catch((e) => {
  hud.textContent = `error: ${e?.stack ?? e}`;
  console.error(e);
});
