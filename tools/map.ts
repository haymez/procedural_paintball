// 2D debug map of a generated island.
//
//   /tools/map.html?seed=N               single view (zoom / pan, overlays, stats)
//   /tools/map.html?gallery=1&from=N     3x3 grid of seeds N..N+8
//   extra: &skipDecor=1  &fake=1 (stub terrain + fake features, no worker)
//          &layers=a,b,c  &hide=<prop kind ids>   (overlay state, kept in the URL)
import {
  CELL, NO_WATER, PickupKind, PropKind, VehicleKind, WORLD_HALF, WORLD_SIZE, type World,
} from "../shared/world/types";
import { loadWorldWithStats, type StageTiming } from "../client/src/world/load";
import { fakeWorld } from "./map-fake";
import * as D from "./map-draw";

declare global {
  interface Window {
    __map?: unknown;
  }
}

// worldChecksum lives in shared/world/checksum.ts (owned by world-gen). Loaded
// through a glob so this page still works if that file is briefly missing.
const checksumModules = import.meta.glob("../shared/world/checksum.ts");
async function computeChecksum(world: World): Promise<number | null> {
  const load = checksumModules["../shared/world/checksum.ts"];
  if (!load) return null;
  const mod = (await load()) as { worldChecksum?: (w: World) => number };
  return mod.worldChecksum ? mod.worldChecksum(world) : null;
}

// ------------------------------------------------------------------ URL ---
const params = new URLSearchParams(location.search);
const FAKE = params.get("fake") === "1";
const num = (v: string | null, d: number) => (v !== null && v.trim() !== "" && Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : d);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const fmt = (n: number) => n.toLocaleString("en-US");
const fmtMs = (ms: number) => (ms >= 100 ? ms.toFixed(0) : ms.toFixed(1));

function landArea(w: World): number {
  let n = 0;
  for (let i = 0; i < w.height.length; i++) if (w.height[i] > 0) n++;
  return n * CELL * CELL;
}

interface GenResult {
  world: World;
  timings: StageTiming[];
  totalMs: number;
}
async function generate(seed: number, skipDecor: boolean, onProgress?: (stage: string, t: number) => void): Promise<GenResult> {
  if (FAKE) {
    onProgress?.("fake", 0);
    await new Promise((r) => setTimeout(r, 0));
    return fakeWorld(seed, skipDecor);
  }
  return loadWorldWithStats(seed, onProgress, { skipDecor });
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

// ================================================================ single ===
const LAYERS = [
  { key: "landmarks", name: "Landmarks" },
  { key: "rivers", name: "Rivers" },
  { key: "lakes", name: "Lakes" },
  { key: "waterfalls", name: "Waterfalls" },
  { key: "caves", name: "Caves" },
  { key: "structures", name: "Structures" },
  { key: "paths", name: "Paths" },
  { key: "props", name: "Props" },
  { key: "pickups", name: "Pickups" },
  { key: "vehicles", name: "Vehicles" },
  { key: "ziplines", name: "Ziplines" },
  { key: "spawns", name: "Spawns" },
] as const;
type LayerKey = (typeof LAYERS)[number]["key"];

function runSingle() {
  let seed = num(params.get("seed"), 1) >>> 0;
  let skipDecor = params.get("skipDecor") === "1";
  const layerParam = params.get("layers");
  const layers = new Set<LayerKey>(
    layerParam === null ? LAYERS.map((l) => l.key) : (layerParam.split(",").filter((k) => LAYERS.some((l) => l.key === k)) as LayerKey[]),
  );
  const hiddenProps = new Set<number>((params.get("hide") ?? "").split(",").filter(Boolean).map(Number));

  document.body.innerHTML = `
    <div id="app">
      <div id="mapwrap">
        <canvas id="map"></canvas>
        <div id="readout" class="hud num"><span class="k">move the cursor over the map</span></div>
        <div id="zoomctl" class="hud"><button id="zin" title="zoom in">+</button><button id="zout" title="zoom out">−</button><span class="z num" id="zlevel">1.0×</span><button id="zreset" title="reset view">⤢</button></div>
        <div id="progress" class="hud"><div id="pstage">generating…</div><div class="bar"><i id="pbar"></i></div></div>
        <div id="error"></div>
      </div>
      <aside id="panel">
        <div class="brand"><span>Isola · map${FAKE ? " · fake" : ""}</span><a id="gallink" href="#">gallery ↗</a></div>
        <h1 id="iname">…</h1>
        <div class="sub num" id="isub">&nbsp;</div>
        <div class="seedrow">
          <button class="btn" id="prev" title="previous seed (←)">‹</button>
          <input type="number" id="seed" min="0" step="1" />
          <button class="btn" id="next" title="next seed (→)">›</button>
          <button class="btn" id="rand" title="random seed (R)">Random</button>
          <button class="btn primary" id="go">Go</button>
        </div>
        <div class="seedrow links">
          <a class="btn" id="viewlink" href="#" title="fly around this island in 3D">Open 3D view ↗</a>
          <button class="btn" id="copyseed" title="copy the seed to paste into the lobby's seed field">Copy seed</button>
        </div>
        <div class="opts"><label class="chk"><input type="checkbox" id="skipdecor" /> skipDecor</label></div>
        <div class="card" id="stats"></div>
        <div class="card"><h2>Timings <span id="ttotal"></span></h2><table class="t num" id="timings"></table></div>
        <div class="card"><h2>Layers <span>counts</span></h2><div class="layers" id="layers"></div></div>
        <div class="card"><h2>Biomes <span>% of land</span></h2><div class="legend" id="legend"></div></div>
        <div class="hint">Wheel to zoom, drag to pan, double-click to reset. <kbd>←</kbd>/<kbd>→</kbd> previous / next seed, <kbd>R</kbd> random. North (−Z) is up, +X is right.</div>
      </aside>
    </div>`;

  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const canvas = $<HTMLCanvasElement>("map");
  const ctx = canvas.getContext("2d")!;
  const seedInput = $<HTMLInputElement>("seed");
  const skipBox = $<HTMLInputElement>("skipdecor");
  seedInput.value = String(seed);
  skipBox.checked = skipDecor;

  let world: World | null = null;
  let base: HTMLCanvasElement | null = null;
  let propsLayer: HTMLCanvasElement | null = null;
  let S = 800; // canvas CSS size
  let dpr = 1;
  let zoom = 1;
  let ox = 0, oy = 0; // CSS px offset of world corner (-HALF, -HALF)
  let genToken = 0;
  const BASE_N = 2052;

  const view = (): D.View => ({ scale: (S / WORLD_SIZE) * zoom, ox, oy });

  function syncUrl() {
    const q = new URLSearchParams();
    q.set("seed", String(seed));
    if (skipDecor) q.set("skipDecor", "1");
    if (FAKE) q.set("fake", "1");
    if (layers.size !== LAYERS.length) q.set("layers", LAYERS.filter((l) => layers.has(l.key)).map((l) => l.key).join(","));
    if (hiddenProps.size) q.set("hide", [...hiddenProps].sort((a, b) => a - b).join(","));
    history.replaceState(null, "", `${location.pathname}?${q}`);
    const g = new URLSearchParams({ gallery: "1", from: String(seed) });
    if (skipDecor) g.set("skipDecor", "1");
    if (FAKE) g.set("fake", "1");
    $<HTMLAnchorElement>("gallink").href = `${location.pathname}?${g}`;
    $<HTMLAnchorElement>("viewlink").href = `/tools/view.html?seed=${seed}`;
  }

  // ---- layout / view ----
  function resize() {
    const wrap = $("mapwrap");
    S = Math.max(200, Math.floor(Math.min(wrap.clientWidth, wrap.clientHeight)));
    dpr = window.devicePixelRatio || 1;
    canvas.style.width = canvas.style.height = `${S}px`;
    canvas.width = canvas.height = Math.round(S * dpr);
    clampView();
    draw();
  }
  function clampView() {
    zoom = Math.min(Math.max(zoom, 1), 32);
    const size = S * zoom;
    ox = Math.min(0, Math.max(S - size, ox));
    oy = Math.min(0, Math.max(S - size, oy));
    $("zlevel").textContent = `${zoom < 10 ? zoom.toFixed(1) : zoom.toFixed(0)}×`;
  }
  function zoomAt(f: number, cx: number, cy: number) {
    const nz = Math.min(Math.max(zoom * f, 1), 32);
    const k = nz / zoom;
    ox = cx - (cx - ox) * k;
    oy = cy - (cy - oy) * k;
    zoom = nz;
    clampView();
    requestDraw();
  }
  let drawQueued = false;
  function requestDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(() => {
      drawQueued = false;
      draw();
    });
  }

  // ---- drawing ----
  function drawScaleBar(v: D.View) {
    const targetPx = 110;
    const m = targetPx / v.scale;
    const nice = [5, 10, 20, 25, 50, 100, 200, 250, 500];
    const len = nice.reduce((a, b) => (Math.abs(b - m) < Math.abs(a - m) ? b : a));
    const px = len * v.scale;
    const x = S - 14 - px, y = S - 18;
    ctx.fillStyle = "rgba(14,17,22,0.75)";
    ctx.beginPath();
    ctx.roundRect(x - 8, y - 17, px + 16, 27, 6);
    ctx.fill();
    ctx.fillStyle = "#e7e9ec";
    ctx.fillRect(x, y, px, 2);
    ctx.fillRect(x, y - 4, 1.5, 6);
    ctx.fillRect(x + px - 1.5, y - 4, 1.5, 6);
    ctx.font = `600 10.5px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(`${len} m`, x + px / 2, y - 5);
    // north arrow
    const nx = 26, ny = 26;
    ctx.fillStyle = "rgba(14,17,22,0.75)";
    ctx.beginPath();
    ctx.arc(nx, ny, 13, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#e7e9ec";
    ctx.beginPath();
    ctx.moveTo(nx, ny - 9);
    ctx.lineTo(nx + 4.5, ny + 2);
    ctx.lineTo(nx - 4.5, ny + 2);
    ctx.closePath();
    ctx.fill();
    ctx.font = `700 8px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillText("N", nx, ny + 10);
  }

  function draw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#0c1a2c";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!world || !base) return;
    const v = view();
    const size = WORLD_SIZE * v.scale;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(base, v.ox, v.oy, size, size);
    const w = world;
    const on = (k: LayerKey) => layers.has(k);
    if (on("props") && propsLayer) ctx.drawImage(propsLayer, v.ox, v.oy, size, size);
    if (on("paths")) D.drawPaths(ctx, w, v);
    if (on("rivers")) D.drawRivers(ctx, w, v);
    if (on("caves")) D.drawCaves(ctx, w, v);
    if (on("structures")) D.drawStructures(ctx, w.structures, v);
    if (on("waterfalls")) D.drawWaterfalls(ctx, w, v);
    if (on("ziplines")) D.drawZiplines(ctx, w, v);
    if (on("pickups")) D.drawPickups(ctx, w, v);
    if (on("vehicles")) D.drawVehicles(ctx, w, v);
    if (on("spawns")) D.drawSpawns(ctx, w, v);
    if (on("lakes")) D.drawLakes(ctx, w, v);
    if (on("landmarks")) D.drawLandmarks(ctx, w, v);
    drawScaleBar(v);
  }

  function rebuildProps() {
    propsLayer = world && world.props.length ? D.renderProps(world, BASE_N, (k) => !hiddenProps.has(k)) : null;
  }

  // ---- panel ----
  function renderStats(res: GenResult, checksum: number | null | undefined) {
    const w = res.world;
    const area = landArea(w);
    const hh = Math.floor(w.timeOfDay), mm = Math.round((w.timeOfDay - hh) * 60);
    const windDeg = (w.windDir * 180) / Math.PI;
    let maxH = -Infinity;
    for (let i = 0; i < w.height.length; i++) if (w.height[i] > maxH) maxH = w.height[i];
    $("iname").textContent = w.name;
    $("isub").textContent = `seed ${w.seed}${skipDecor ? " · skipDecor" : ""}`;
    const cs = checksum === undefined ? "…" : checksum === null ? "<span style='color:var(--faint)'>n/a</span>" : `0x${(checksum >>> 0).toString(16).padStart(8, "0")}`;
    $("stats").innerHTML = `
      <h2>Island</h2>
      <div class="kv num">
        <span class="k">Time of day</span><span class="v">${String(hh).padStart(2, "0")}:${String(mm % 60).padStart(2, "0")} <span style="color:var(--faint)">(${w.timeOfDay.toFixed(2)} h)</span></span>
        <span class="k">Wind</span><span class="v wind"><svg viewBox="-8 -8 16 16" style="transform:rotate(${180 - windDeg}deg)"><path d="M0,-7 L4.5,1 L1.3,0 L1.3,7 L-1.3,7 L-1.3,0 L-4.5,1 Z" fill="#4fd6d0"/></svg>${windDeg.toFixed(0)}°</span>
        <span class="k">Land area</span><span class="v">${(area / 1e6).toFixed(3)} km² <span style="color:var(--faint)">(${fmt(area)} m²)</span></span>
        <span class="k">Highest point</span><span class="v">${maxH.toFixed(1)} m</span>
        <span class="k">Checksum</span><span class="v" id="csum">${cs}</span>
      </div>`;
    const max = Math.max(...res.timings.map((t) => t.ms), 1);
    $("timings").innerHTML =
      res.timings
        .map((t) => `<tr><td>${esc(t.stage)}</td><td class="ms">${fmtMs(t.ms)} ms</td><td class="barc"><div class="bar" style="width:${(t.ms / max) * 100}%"></div></td></tr>`)
        .join("") + `<tr class="total"><td>total</td><td class="ms">${fmtMs(res.totalMs)} ms</td><td></td></tr>`;
    $("ttotal").textContent = `${fmtMs(res.totalMs)} ms${FAKE ? " (fake)" : ""}`;
    renderLayers();
    renderLegend();
  }

  function countBy<T>(items: T[], key: (t: T) => number): Map<number, number> {
    const m = new Map<number, number>();
    for (const it of items) m.set(key(it), (m.get(key(it)) ?? 0) + 1);
    return m;
  }

  function renderLayers() {
    const w = world!;
    const entrances = w.caves.reduce((a, c) => a + c.entrances.length, 0);
    const solids = w.structures.reduce((a, s) => a + s.solids.length, 0);
    const propTotal = w.props.reduce((a, p) => a + p.count, 0);
    const pk = countBy(w.pickups, (p) => p.kind);
    const vk = countBy(w.vehicles, (v) => v.kind);
    const sk = countBy(w.structures, (s) => s.kind);
    const counts: Record<LayerKey, string> = {
      landmarks: `${w.landmarks.length}`,
      rivers: `${w.rivers.length}`,
      lakes: `${w.lakes.length}`,
      waterfalls: `${w.waterfalls.length}`,
      caves: `${w.caves.length} · ${entrances} entr.`,
      structures: `${w.structures.length} · ${solids} solids`,
      paths: `${w.paths.length}`,
      props: fmt(propTotal),
      pickups: `${w.pickups.length}`,
      vehicles: `${w.vehicles.length}`,
      ziplines: `${w.ziplines.length}`,
      spawns: `${w.spawns.length}`,
    };
    const structNames = ["cottage", "hamlet", "lighthouse", "chapel", "watchtower", "boathouse", "dock", "vespa shed", "bridge", "well", "arch", "house", "store", "hotel", "church", "hale", "water tower", "stall", "wall", "sugar mill", "heiau", "manor"];
    const details: Partial<Record<LayerKey, string>> = {
      structures: [...sk.entries()].sort((a, b) => a[0] - b[0]).map(([k, n]) => `${structNames[k] ?? k} ${n}`).join(" · "),
      pickups: D.PICKUP_INFO.filter((p) => pk.has(p.kind))
        .map((p) =>
          p.kind === PickupKind.Ammo
            ? `<span style="display:inline-flex;align-items:center;gap:4px"><span class="sw" style="background:${D.css(p.color)};border-radius:50%"></span>${p.name} ${pk.get(p.kind)}</span>`
            : `<span style="display:inline-flex;align-items:center;gap:4px"><span class="dia" style="background:${D.css(p.color)}"><b>${p.letter}</b></span>${p.name} ${pk.get(p.kind)}</span>`,
        )
        .join(" &nbsp;"),
      vehicles: [VehicleKind.Jetski, VehicleKind.Speedboat, VehicleKind.Vespa, VehicleKind.Gyrocopter].map((k) => `${D.VEHICLE_NAMES[k].toLowerCase()} ${vk.get(k) ?? 0}`).join(" · "),
    };
    const host = $("layers");
    host.innerHTML = "";
    for (const l of LAYERS) {
      const row = document.createElement("div");
      row.innerHTML = `<div class="layer"><label class="chk"><input type="checkbox" data-k="${l.key}" ${layers.has(l.key) ? "checked" : ""}/> ${l.name}</label><span class="cnt num">${counts[l.key]}</span></div>${
        details[l.key] ? `<div class="detail num">${details[l.key]}</div>` : ""
      }`;
      host.appendChild(row);
      if (l.key === "props") host.appendChild(propsDetails());
    }
    host.querySelectorAll<HTMLInputElement>("input[data-k]").forEach((inp) =>
      inp.addEventListener("change", () => {
        const k = inp.dataset.k as LayerKey;
        if (inp.checked) layers.add(k);
        else layers.delete(k);
        syncUrl();
        requestDraw();
      }),
    );
  }

  let propsOpen = false;
  function propsDetails(): HTMLElement {
    const w = world!;
    const det = document.createElement("details");
    det.className = "props";
    det.open = propsOpen;
    det.addEventListener("toggle", () => (propsOpen = det.open));
    const byKind = new Map<number, number>();
    for (const p of w.props) byKind.set(p.kind, (byKind.get(p.kind) ?? 0) + p.count);
    const shown = D.PROP_INFO.filter((p) => byKind.has(p.kind));
    const visibleCount = shown.filter((p) => !hiddenProps.has(p.kind)).length;
    det.innerHTML = `<summary><span>per kind</span><span class="num" style="font-size:11px">${visibleCount}/${shown.length} kinds shown</span></summary>
      <div class="plist">${shown
        .map(
          (p) =>
            `<label class="chk"><input type="checkbox" data-pk="${p.kind}" ${hiddenProps.has(p.kind) ? "" : "checked"}/><span class="sw" style="background:${D.css(p.color)}"></span>${p.name}<span class="c num">${fmt(byKind.get(p.kind) ?? 0)}</span></label>`,
        )
        .join("")}</div>
      <div class="plist-actions"><button class="btn" data-all="1">all</button><button class="btn" data-all="0">none</button><button class="btn" data-all="trees">trees only</button></div>`;
    const apply = () => {
      rebuildProps();
      syncUrl();
      renderLayers();
      requestDraw();
    };
    det.querySelectorAll<HTMLInputElement>("input[data-pk]").forEach((inp) =>
      inp.addEventListener("change", () => {
        const k = Number(inp.dataset.pk);
        if (inp.checked) hiddenProps.delete(k);
        else hiddenProps.add(k);
        apply();
      }),
    );
    const trees = new Set<number>([PropKind.Palm, PropKind.PalmLeaning, PropKind.Broadleaf, PropKind.UmbrellaPine, PropKind.Cypress, PropKind.Olive, PropKind.Mangrove, PropKind.LemonTree, PropKind.Banana]);
    det.querySelectorAll<HTMLButtonElement>("button[data-all]").forEach((b) =>
      b.addEventListener("click", () => {
        hiddenProps.clear();
        if (b.dataset.all === "0") D.PROP_INFO.forEach((p) => hiddenProps.add(p.kind));
        if (b.dataset.all === "trees") D.PROP_INFO.forEach((p) => !trees.has(p.kind) && hiddenProps.add(p.kind));
        apply();
      }),
    );
    return det;
  }

  function renderLegend() {
    const w = world!;
    const counts = new Array<number>(256).fill(0);
    let land = 0;
    for (let i = 0; i < w.biome.length; i++) {
      if (w.height[i] > 0) {
        counts[w.biome[i]]++;
        land++;
      }
    }
    const missing = D.biomeMissing(w);
    $("legend").innerHTML = (missing ? `<div style="grid-column:1/-1;color:#ffb86b">biome grid empty — map uses a height-based fallback</div>` : "") + D.BIOME_INFO.map(
      (b) =>
        `<div><span class="sw" style="background:${D.css(b.color)}"></span>${b.name}<span class="pct num">${
          b.biome <= 1 ? "" : land ? ((counts[b.biome] / land) * 100).toFixed(1) + "%" : ""
        }</span></div>`,
    ).join("");
  }

  // ---- cursor readout ----
  function readout(e: PointerEvent) {
    if (!world) return;
    const r = canvas.getBoundingClientRect();
    const v = view();
    const x = (e.clientX - r.left - v.ox) / v.scale - WORLD_HALF;
    const z = (e.clientY - r.top - v.oy) / v.scale - WORLD_HALF;
    if (x < -WORLD_HALF || x > WORLD_HALF || z < -WORLD_HALF || z > WORLD_HALF) return;
    const h = D.sampleGrid(world.height, x, z);
    const i = D.nearestIndex(x, z);
    const wl = world.water[i];
    const fresh = wl !== NO_WATER && wl > world.height[i] ? `<span class="k">water</span> <b>${(wl - world.height[i]).toFixed(1)} m</b> deep (lvl ${wl.toFixed(1)}) · ` : "";
    const sea = h < 0 && !fresh ? `<span class="k">sea depth</span> <b>${(-h).toFixed(1)} m</b> · ` : "";
    $("readout").innerHTML = `<span class="k">x</span> <b>${x.toFixed(1)}</b> &nbsp;<span class="k">z</span> <b>${z.toFixed(1)}</b> &nbsp;<span class="k">h</span> <b>${h.toFixed(2)} m</b><br>
      ${fresh}${sea}<span class="k">biome</span> <b>${D.biomeName(world.biome[i])}</b> · <span class="k">moist</span> ${world.moisture[i]}${
      world.path[i] ? ` · <span class="k">path</span> ${world.path[i]}` : ""
    }${world.holes[i] ? ` · <b>hole</b>` : ""}`;
  }

  // ---- interaction ----
  let drag: { x: number; y: number; ox: number; oy: number; id: number } | null = null;
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    zoomAt(Math.exp(-dy * 0.0018), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  canvas.addEventListener("pointerdown", (e) => {
    drag = { x: e.clientX, y: e.clientY, ox, oy, id: e.pointerId };
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add("dragging");
  });
  canvas.addEventListener("pointermove", (e) => {
    if (drag && drag.id === e.pointerId) {
      ox = drag.ox + e.clientX - drag.x;
      oy = drag.oy + e.clientY - drag.y;
      clampView();
      requestDraw();
    }
    readout(e);
  });
  const endDrag = () => {
    drag = null;
    canvas.classList.remove("dragging");
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("dblclick", () => {
    zoom = 1;
    ox = oy = 0;
    clampView();
    requestDraw();
  });
  $("zin").onclick = () => zoomAt(1.6, S / 2, S / 2);
  $("zout").onclick = () => zoomAt(1 / 1.6, S / 2, S / 2);
  $("zreset").onclick = () => {
    zoom = 1;
    ox = oy = 0;
    clampView();
    requestDraw();
  };

  const setSeed = (s: number) => {
    seed = s >>> 0;
    seedInput.value = String(seed);
    regenerate();
  };
  $("prev").onclick = () => setSeed(Math.max(0, seed - 1));
  $("next").onclick = () => setSeed(seed + 1);
  $("rand").onclick = () => setSeed(Math.floor(Math.random() * 1_000_000));
  $("go").onclick = () => setSeed(num(seedInput.value, seed));
  seedInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") setSeed(num(seedInput.value, seed));
  });
  let copyTimer = 0;
  $("copyseed").onclick = async () => {
    const btn = $("copyseed");
    try {
      await navigator.clipboard.writeText(String(seed));
      btn.textContent = `Copied ${seed} ✓`;
    } catch {
      btn.textContent = "Copy failed";
    }
    clearTimeout(copyTimer);
    copyTimer = window.setTimeout(() => (btn.textContent = "Copy seed"), 1500);
  };
  skipBox.addEventListener("change", () => {
    skipDecor = skipBox.checked;
    regenerate();
  });
  window.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement && e.target.type === "number") return;
    if (e.key === "ArrowLeft") setSeed(Math.max(0, seed - 1));
    else if (e.key === "ArrowRight") setSeed(seed + 1);
    else if (e.key === "r" || e.key === "R") setSeed(Math.floor(Math.random() * 1_000_000));
  });
  window.addEventListener("resize", resize);

  // ---- generation ----
  async function regenerate() {
    const token = ++genToken;
    syncUrl();
    const prog = $("progress");
    prog.classList.add("on");
    $("error").style.display = "none";
    $("pstage").textContent = `seed ${seed} · starting…`;
    $<HTMLElement>("pbar").style.width = "0%";
    try {
      const res = await generate(seed, skipDecor, (stage, t) => {
        if (token !== genToken) return;
        $("pstage").textContent = `seed ${seed} · ${stage}`;
        $<HTMLElement>("pbar").style.width = `${Math.round(t * 100)}%`;
      });
      if (token !== genToken) return;
      $("pstage").textContent = `seed ${seed} · rendering map…`;
      $<HTMLElement>("pbar").style.width = "100%";
      await nextFrame();
      world = res.world;
      base = D.renderBase(world, BASE_N);
      rebuildProps();
      renderStats(res, undefined);
      prog.classList.remove("on");
      draw();
      window.__map = { world, timings: res.timings, totalMs: res.totalMs };
      let cs: number | null = null;
      try {
        cs = await computeChecksum(world);
      } catch (err) {
        console.warn("worldChecksum failed", err);
      }
      if (token !== genToken) return;
      $("csum").innerHTML = cs === null ? "<span style='color:var(--faint)'>n/a</span>" : `0x${(cs >>> 0).toString(16).padStart(8, "0")}`;
      await nextFrame();
      window.__ready = true;
    } catch (err) {
      if (token !== genToken) return;
      prog.classList.remove("on");
      const el = $("error");
      el.style.display = "block";
      el.textContent = err instanceof Error ? err.message : String(err);
      console.error(err);
      window.__ready = true;
    }
  }

  window.__debug = {
    /** Center the view on world (x, z) at the given zoom. */
    view(z: number, wx: number, wz: number) {
      zoom = z;
      const sc = (S / WORLD_SIZE) * Math.min(Math.max(z, 1), 32);
      ox = S / 2 - (wx + WORLD_HALF) * sc;
      oy = S / 2 - (wz + WORLD_HALF) * sc;
      clampView();
      draw();
    },
  };

  resize();
  regenerate();
}

// =============================================================== gallery ===
function runGallery() {
  const from = Math.max(0, num(params.get("from"), 1));
  const skipDecor = params.get("skipDecor") === "1";
  const extra = new URLSearchParams();
  if (skipDecor) extra.set("skipDecor", "1");
  if (FAKE) extra.set("fake", "1");
  const link = (q: Record<string, string>) => `${location.pathname}?${new URLSearchParams({ ...q, ...Object.fromEntries(extra) })}`;
  const COUNT = 9;

  document.body.innerHTML = `
    <div id="gallery">
      <header>
        <div class="title">Isola · gallery<span class="num">seeds ${from}–${from + COUNT - 1}${skipDecor ? " · skipDecor" : ""}${FAKE ? " · fake" : ""}</span></div>
        <a class="btn" href="${link({ gallery: "1", from: String(Math.max(0, from - COUNT)) })}">‹ prev page</a>
        <a class="btn" href="${link({ gallery: "1", from: String(from + COUNT) })}">next page ›</a>
        <a class="btn" href="${link({ seed: String(from) })}">single view</a>
      </header>
      <div id="grid"></div>
    </div>`;
  document.querySelectorAll<HTMLAnchorElement>("a.btn").forEach((a) => (a.style.textDecoration = "none"));

  const header = document.querySelector("#gallery header") as HTMLElement;
  const avail = Math.min((window.innerWidth - 32 - 24 - 36) / 3, (window.innerHeight - header.offsetHeight - 36 - 24 - 3 * 34) / 3);
  const T = Math.max(160, Math.floor(avail));
  const dpr = window.devicePixelRatio || 1;
  const grid = document.getElementById("grid")!;
  const tiles = Array.from({ length: COUNT }, (_, k) => {
    const seed = from + k;
    const el = document.createElement("div");
    el.className = "tile";
    el.innerHTML = `<canvas style="width:${T}px;height:${T}px"></canvas>
      <div class="wait num">seed ${seed}<br><span class="st">queued</span><div class="bar"><i></i></div></div>
      <div class="lbl num" style="width:${T}px"><span class="n"><i>#${seed}</i>…</span><span class="m"></span></div>`;
    el.onclick = () => (location.href = link({ seed: String(seed) }));
    grid.appendChild(el);
    const cv = el.querySelector("canvas")!;
    cv.width = cv.height = Math.round(T * dpr);
    return { seed, el, cv };
  });

  (async () => {
    for (const t of tiles) {
      const st = t.el.querySelector(".st") as HTMLElement;
      const bar = t.el.querySelector(".bar i") as HTMLElement;
      st.textContent = "generating…";
      try {
        const res = await generate(t.seed, skipDecor, (stage, p) => {
          st.textContent = stage;
          bar.style.width = `${Math.round(p * 100)}%`;
        });
        const w = res.world;
        const N = Math.min(1026, Math.ceil((T * dpr) / 2) * 2 + 2);
        const base = D.renderBase(w, N, { contours: T * dpr > 400 });
        const ctx = t.cv.getContext("2d")!;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(base, 0, 0, T, T);
        const v: D.View = { scale: T / WORLD_SIZE, ox: 0, oy: 0 };
        D.drawPaths(ctx, w, v, true);
        D.drawRivers(ctx, w, v, 1);
        D.drawStructures(ctx, w.structures, v, true);
        D.drawCaves(ctx, w, v, true);
        (t.el.querySelector(".wait") as HTMLElement).remove();
        const area = landArea(w);
        t.el.querySelector(".lbl")!.innerHTML = `<span class="n" title="${esc(w.name)}"><i>#${t.seed}</i>${esc(w.name)}</span><span class="m">${fmtMs(res.totalMs)} ms · ${(area / 1e6).toFixed(2)} km²</span>`;
      } catch (err) {
        st.textContent = `error: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`;
        st.style.color = "#ff9b9b";
        console.error(err);
      }
      await nextFrame();
    }
    await nextFrame();
    window.__ready = true;
  })();
}

if (params.get("gallery") === "1") runGallery();
else runSingle();

