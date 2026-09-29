// Prop showcase: every PropKind lined up on flat ground, plus a dense jungle
// stand and a Mediterranean forest stand, rendered by the real world renderer
// (terrain, canopy shade, ground cover, shadows) on a synthetic flat island.
//   ?view=trees|trees2|small|jungle|jungle-in|jungle-edge|forest|forest-in|forest-edge|above
//   ?x=..&y=..&z=..&yaw=deg&pitch=deg   free camera
//   ?quality=low|medium|high  ?time=h  ?canopy=0 (disable canopy shade)  ?hud=0
// Drag to look, WASD/QE to move (Shift fast).
import * as THREE from "three";
import {
  Biome, CELL, GRID_RES, NO_WATER, PROP_STRIDE, PropKind, WORLD_HALF, type PropSet, type World,
} from "../shared/world/types";
import { createWorldRenderer, createWorldView, type Quality } from "../client/src/render/worldView";
import { propModels } from "../client/src/render/props/models";
import { makeToonMaterial } from "../client/src/render/style";
import { applyCanopyShade } from "../client/src/render/patch";

const params = new URLSearchParams(location.search);
const quality = (params.get("quality") ?? "medium") as Quality;
document.body.style.cssText = "margin:0;overflow:hidden;background:#000;font-family:ui-monospace,Menlo,monospace";
const hud = document.createElement("div");
hud.style.cssText = "position:fixed;left:8px;top:8px;color:#fff;font-size:12px;line-height:1.4;background:rgba(0,0,0,.35);padding:6px 8px;border-radius:6px;pointer-events:none;white-space:pre;z-index:2";
document.body.appendChild(hud);

const GROUND = 3;
const LINE_Z = -20, SMALL_Z = -50;
// stand areas
const JUNGLE = { x0: -230, x1: -20, z0: 50, z1: 260 };
const FOREST = { x0: 20, x1: 230, z0: 50, z1: 260 };

let s = 12345;
const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
const inRect = (x: number, z: number, r: { x0: number; x1: number; z0: number; z1: number }) => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1;
const groundAt = (x: number, z: number) => {
  if (Math.abs(x) > 420 || Math.abs(z) > 420) return -8;
  // gentle undulation inside the stands so the floor isn't a billiard table
  const st = inRect(x, z, JUNGLE) || inRect(x, z, FOREST) ? 1 : 0;
  return GROUND + st * (Math.sin(x * 0.05) * Math.cos(z * 0.043) * 1.2 + Math.sin(x * 0.13 + z * 0.09) * 0.35);
};

function buildWorld(): World {
  const N = GRID_RES, n = N * N;
  const height = new Float32Array(n), biome = new Uint8Array(n), moisture = new Uint8Array(n);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = j * N + i, x = -WORLD_HALF + i * CELL, z = -WORLD_HALF + j * CELL;
    const h = groundAt(x, z);
    height[k] = h;
    let b = h < -2 ? Biome.DeepOcean : Math.abs(x) > 400 || Math.abs(z) > 400 ? Biome.Beach : Biome.Meadow;
    let m = 120;
    if (b === Biome.Meadow && inRect(x, z, JUNGLE)) { b = Biome.Jungle; m = 215; }
    if (b === Biome.Meadow && inRect(x, z, FOREST)) { b = Biome.Forest; m = 95; }
    biome[k] = b; moisture[k] = m;
  }
  const lists = new Map<PropKind, number[]>();
  const put = (kind: PropKind, x: number, z: number, scale: number, rot = rnd() * Math.PI * 2) => {
    let l = lists.get(kind);
    if (!l) { l = []; lists.set(kind, l); }
    l.push(x, groundAt(x, z), z, rot, scale);
  };
  // lineups: trees on one row, small stuff on another
  const models = propModels();
  const kinds = Object.values(PropKind).filter((v): v is PropKind => typeof v === "number");
  const big = kinds.filter((k) => (models.get(k)?.height ?? 0) >= 3.3), small = kinds.filter((k) => (models.get(k)?.height ?? 0) < 3.3);
  const lineup = (ks: PropKind[], z: number, gap: number) => {
    const widths = ks.map((k) => (models.get(k)?.radius ?? 1) * 2 + gap);
    let x = -widths.reduce((a, b) => a + b, 0) / 2;
    const out: { kind: PropKind; x: number }[] = [];
    for (let i = 0; i < ks.length; i++) { x += widths[i] / 2; put(ks[i], x, z, 1, 0.4); out.push({ kind: ks[i], x }); x += widths[i] / 2; }
    return out;
  };
  lineupInfo.big = lineup(big, LINE_Z, 2);
  lineupInfo.small = lineup(small, SMALL_Z, 1.2);

  // stands: jittered grid with rejection against a min distance per placed tree
  const placed: { x: number; z: number; r: number }[] = [];
  const free = (x: number, z: number, r: number) => placed.every((p) => (p.x - x) ** 2 + (p.z - z) ** 2 > (p.r + r) ** 2);
  const scatter = (area: typeof JUNGLE, kind: PropKind, spacing: number, r: number, prob: number, s0: number, s1: number, block = true) => {
    for (let z = area.z0 + 3; z < area.z1 - 3; z += spacing) for (let x = area.x0 + 3; x < area.x1 - 3; x += spacing) {
      if (rnd() > prob) continue;
      const px = x + (rnd() - 0.5) * spacing, pz = z + (rnd() - 0.5) * spacing;
      if (Math.abs(px - (area.x0 + area.x1) / 2) < 3) continue; // a trail down the middle
      if (block && !free(px, pz, r)) continue;
      if (block) placed.push({ x: px, z: pz, r });
      put(kind, px, pz, s0 + (s1 - s0) * rnd());
    }
  };
  scatter(JUNGLE, PropKind.JungleGiant, 26, 6, 0.8, 0.85, 1.15);
  scatter(JUNGLE, PropKind.Broadleaf, 6.5, 2.6, 0.9, 0.8, 1.3);
  scatter(JUNGLE, PropKind.TreeFern, 7, 1.2, 0.35, 0.8, 1.2);
  scatter(JUNGLE, PropKind.Banana, 8, 1.0, 0.3, 0.8, 1.2);
  scatter(JUNGLE, PropKind.Palm, 18, 1.5, 0.2, 0.9, 1.2);
  scatter(JUNGLE, PropKind.Understory, 4, 0.5, 0.35, 0.8, 1.3, false);
  scatter(JUNGLE, PropKind.Fern, 3, 0.4, 0.3, 0.8, 1.4, false);
  scatter(JUNGLE, PropKind.Log, 18, 2, 0.4, 0.8, 1.2);
  scatter(JUNGLE, PropKind.RockMedium, 30, 1.5, 0.4, 0.7, 1.2);
  scatter(FOREST, PropKind.HolmOak, 6, 2.2, 0.85, 0.8, 1.25);
  scatter(FOREST, PropKind.Pine, 9, 1.6, 0.8, 0.85, 1.2);
  scatter(FOREST, PropKind.UmbrellaPine, 24, 3, 0.4, 0.9, 1.2);
  scatter(FOREST, PropKind.Olive, 20, 1.5, 0.25, 0.8, 1.1);
  scatter(FOREST, PropKind.Bush, 6, 0.8, 0.4, 0.7, 1.3, false);
  scatter(FOREST, PropKind.Log, 16, 2, 0.4, 0.8, 1.2);
  scatter(FOREST, PropKind.RockMedium, 22, 1.5, 0.5, 0.7, 1.3);
  scatter(FOREST, PropKind.Boulder, 60, 3, 0.4, 0.7, 1.0);

  const props: PropSet[] = [...lists.entries()].map(([kind, l]) => ({ kind, count: l.length / PROP_STRIDE, data: new Float32Array(l) }));
  return {
    seed: 7, name: "Isola dei Modelli", timeOfDay: Number(params.get("time") ?? 11.5), windDir: 0.6,
    height, water: new Float32Array(n).fill(NO_WATER), flow: new Float32Array(n * 2), biome, moisture,
    path: new Uint8Array(n), holes: new Uint8Array(n),
    rivers: [], waterfalls: [], lakes: [], caves: [], paths: [], structures: [], props, landmarks: [],
    pickups: [], vehicles: [], ziplines: [], spawns: [{ x: 0, y: GROUND + 1, z: 0 }],
  };
}
const lineupInfo: { big: { kind: PropKind; x: number }[]; small: { kind: PropKind; x: number }[] } = { big: [], small: [] };

const world = buildWorld();
const renderer = createWorldRenderer(undefined, quality);
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);
const overrides: Record<string, number | boolean> = {};
for (const k of ["shadowDistance", "foliageDensity", "foliageDistance", "groundCover"]) if (params.has(k)) overrides[k] = Number(params.get(k));
const view = createWorldView(renderer, world, { quality, overrides });
// canopy shade strength lives on the props group (see props.ts)
const canopyP = view.scene.getObjectByName("props")?.userData.canopyP as { value: THREE.Vector4 } | undefined;
if (params.has("canopy") && canopyP) canopyP.value.x = Number(params.get("canopy"));

// stand-in "characters" on a plain toon material (like actors) with applyCanopyShade:
// one in the open, one inside each stand, to check they darken with the terrain
{
  const env = view.scene.getObjectByName("props")?.userData.canopyEnv as Record<string, THREE.IUniform> | undefined;
  const geo = new THREE.CapsuleGeometry(0.45, 0.9, 4, 12).translate(0, 0.9, 0);
  const spots: [number, number][] = [[0, 30], [(JUNGLE.x0 + JUNGLE.x1) / 2 + 1, 118], [(FOREST.x0 + FOREST.x1) / 2 + 1, 118], [(JUNGLE.x0 + JUNGLE.x1) / 2 + 1, 60], [(FOREST.x0 + FOREST.x1) / 2 + 1, 60]];
  for (const [x, z] of spots) {
    const m = makeToonMaterial({ color: 0xff8fb0 });
    if (env && params.get("actorShade") !== "0") applyCanopyShade(m, env);
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, groundAt(x, z), z);
    mesh.castShadow = mesh.receiveShadow = true;
    view.scene.add(mesh);
  }
}

const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.2, 7000);
let yaw = 0, pitch = 0;
const applyLook = () => {
  pitch = THREE.MathUtils.clamp(pitch, -1.5, 1.5);
  camera.lookAt(camera.position.clone().add(new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch))));
};
const setCam = (x: number, y: number, z: number, yd: number, pd: number) => {
  camera.position.set(x, y, z); yaw = THREE.MathUtils.degToRad(yd); pitch = THREE.MathUtils.degToRad(pd); applyLook();
};
const eye = GROUND + 2.6;
const VIEWS: Record<string, [number, number, number, number, number]> = {
  trees: [42, eye + 3, LINE_Z + 30, 180, 4],
  trees2: [-40, eye + 3, LINE_Z + 30, 180, 4],
  small: [0, eye + 0.5, SMALL_Z + 12, 180, -10],
  jungle: [(JUNGLE.x0 + JUNGLE.x1) / 2 + 1, eye, 110, 0, 4],
  "jungle-in": [(JUNGLE.x0 + JUNGLE.x1) / 2 + 12, eye, 150, 60, 2],
  "jungle-edge": [(JUNGLE.x0 + JUNGLE.x1) / 2, eye + 1, 22, 0, 6],
  forest: [(FOREST.x0 + FOREST.x1) / 2 + 1, eye, 110, 0, 4],
  "forest-in": [(FOREST.x0 + FOREST.x1) / 2 - 12, eye, 150, -60, 2],
  "forest-edge": [(FOREST.x0 + FOREST.x1) / 2, eye + 1, 22, 0, 6],
  above: [0, 90, -90, 0, -32],
};
if (params.has("x")) setCam(Number(params.get("x")), Number(params.get("y") ?? eye), Number(params.get("z")), Number(params.get("yaw") ?? 0), Number(params.get("pitch") ?? 0));
else setCam(...(VIEWS[params.get("view") ?? "trees"] ?? VIEWS.trees));

const keys = new Set<string>();
window.addEventListener("keydown", (e) => keys.add(e.code));
window.addEventListener("keyup", (e) => keys.delete(e.code));
let dragging = false;
renderer.domElement.addEventListener("mousedown", () => { dragging = true; });
window.addEventListener("mouseup", () => { dragging = false; });
window.addEventListener("mousemove", (e) => { if (dragging) { yaw -= e.movementX * 0.003; pitch -= e.movementY * 0.003; applyLook(); } });
window.addEventListener("resize", () => { renderer.setSize(window.innerWidth, window.innerHeight); camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix(); });

let t = 0, frames = 0, acc = 0, fps = 0, last = performance.now(), ready = 0;
function frame(dt: number) {
  const sp = (keys.has("ShiftLeft") ? 40 : 8) * dt;
  const fw = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
  const rt = new THREE.Vector3(-Math.cos(yaw), 0, Math.sin(yaw));
  if (keys.has("KeyW")) camera.position.addScaledVector(fw, sp);
  if (keys.has("KeyS")) camera.position.addScaledVector(fw, -sp);
  if (keys.has("KeyA")) camera.position.addScaledVector(rt, -sp);
  if (keys.has("KeyD")) camera.position.addScaledVector(rt, sp);
  if (keys.has("KeyE")) camera.position.y += sp;
  if (keys.has("KeyQ")) camera.position.y -= sp;
  t += dt;
  view.update(dt, camera, t);
  view.render(camera);
}
function stats() {
  const i = renderer.info.render;
  const st = { fps: Math.round(fps), drawCalls: i.calls, triangles: i.triangles, ...view.debugInfo() };
  window.__stats = st;
  const p = camera.position;
  hud.textContent = `props showcase · ${quality}\n${st.fps} fps  draws ${st.drawCalls}  tris ${(st.triangles / 1000).toFixed(0)}k\npos ${p.x.toFixed(0)} ${p.y.toFixed(1)} ${p.z.toFixed(0)} yaw ${THREE.MathUtils.radToDeg(yaw).toFixed(0)} pitch ${THREE.MathUtils.radToDeg(pitch).toFixed(0)}`;
}
window.__debug = {
  camera: (x: number, y: number, z: number, yd: number, pd: number) => { setCam(x, y, z, yd, pd); return true; },
  view: (name: string) => { const v = VIEWS[name]; if (v) setCam(...v); return !!v; },
  props: () => view.propBreakdown(),
  lineup: () => lineupInfo.big.concat(lineupInfo.small).map((e) => `${PropKind[e.kind]} @x=${e.x.toFixed(1)}`),
  /** triangles per LOD for each model */
  models: () => Object.fromEntries([...propModels().entries()].map(([k, m]) => [PropKind[k], [m.lod0, m.lod1, m.lod2].map((g) => g.index!.count / 3)])),
  canopy: (v: number) => { if (canopyP) canopyP.value.x = v; return !!canopyP; },
  bench: (n = 60) => {
    const gl = renderer.getContext(), px = new Uint8Array(4);
    frame(1 / 60); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const b0 = performance.now();
    for (let i = 0; i < n; i++) { frame(1 / 60); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); }
    return { msPerFrame: +((performance.now() - b0) / n).toFixed(2), drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
  },
  hud: (v: boolean) => { hud.style.display = v ? "" : "none"; },
};
if (params.get("hud") === "0") hud.style.display = "none";
function loop() {
  const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  frame(dt);
  frames++; acc += dt;
  if (acc >= 0.5) { fps = frames / acc; frames = 0; acc = 0; stats(); }
  if (ready < 3 && ++ready === 3) { stats(); window.__ready = true; }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
