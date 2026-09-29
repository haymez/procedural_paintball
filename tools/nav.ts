// Bot navigation debug view: nav graph overlay, paths with action tags,
// cover points, line-of-sight and timing.
//
//   /tools/nav.html?seed=N
//   click: set path start / end · shift+click: set threat (cover + LOS)
//   drag: pan · wheel: zoom · extra URL params: &a=x,z&b=x,z&t=x,z&zoom=s&at=x,z
import { buildCollision, terrainHeight, type CollisionWorld } from "../shared/world/collide";
import { WORLD_HALF, type World } from "../shared/world/types";
import { loadWorldWithStats } from "../client/src/world/load";
import {
  Act, ACT_NAMES, buildCover, buildNav, buildPois, findCover, findPath, lineOfSight, nearestNode, nearestWater, NF,
  PathPlanner, CoverKind, EYE_H, type CoverSet, type NavGraph, type PathResult, type Pois, type CoverSpot,
} from "../shared/bots";
import * as D from "./map-draw";

const params = new URLSearchParams(location.search);
const seed = (Number(params.get("seed") ?? 1) || 1) >>> 0;
const parsePt = (s: string | null) => {
  if (!s) return null;
  const [x, z] = s.split(",").map(Number);
  return Number.isFinite(x) && Number.isFinite(z) ? { x, z } : null;
};

const ACT_COLOR: Record<number, string> = {
  [Act.Walk]: "#ffffff",
  [Act.Wade]: "#9fe8ff",
  [Act.Swim]: "#3d8bff",
  [Act.Dive]: "#00e1ff",
  [Act.JumpDown]: "#ff5ad1",
  [Act.Mantle]: "#b46bff",
  [Act.Zipline]: "#ffe066",
  [Act.Cave]: "#ff9a3d",
  [Act.Vehicle]: "#7dff7a",
};

// ------------------------------------------------------------------ DOM ---
document.body.innerHTML = `
<div id="app">
  <div id="mapwrap">
    <canvas id="map"></canvas>
    <div class="hud" id="help"><kbd>click</kbd> start / end · <kbd>shift</kbd>+click threat · <kbd>drag</kbd> pan · <kbd>wheel</kbd> zoom · <kbd>c</kbd> clear</div>
    <div class="hud" id="readout"></div>
    <div class="hud" id="progress">Generating…</div>
    <div id="error"></div>
  </div>
  <div id="panel">
    <h1>Bot navigation</h1>
    <div class="sub" id="sub">seed ${seed}</div>
    <div class="row"><input type="number" id="seed" value="${seed}"><button class="btn" id="go">Load</button><button class="btn" id="bench">Bench</button></div>
    <div class="card"><h2>Build</h2><table class="t" id="build"></table><div class="kv" id="sizes" style="margin-top:6px"></div></div>
    <div class="card"><h2>Path</h2><div class="kv" id="pathkv"></div><div class="wps" id="wps"></div></div>
    <div class="card"><h2>Threat / cover</h2><div class="kv" id="coverkv"></div></div>
    <div class="card"><h2>Bench</h2><div class="kv" id="benchkv"><span class="k">press Bench</span><span class="v"></span></div></div>
    <div class="card"><h2>Layers</h2><div id="layers"></div></div>
    <div class="card"><h2>Actions</h2><div class="legend">${ACT_NAMES.map((n, i) => `<div><span class="sw" style="background:${ACT_COLOR[i]}"></span>${n}</div>`).join("")}</div></div>
  </div>
</div>`;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>("map");
const ctx = canvas.getContext("2d")!;

const LAYERS = [
  ["coverage", "Walkable grid", true],
  ["regions", "Regions (tint)", false],
  ["patches", "Structure / cave nodes", true],
  ["edges", "Edges (zoomed in)", true],
  ["links", "Drops / mantles / zips / boats", true],
  ["cover", "Cover points", false],
  ["pois", "Perches · pickups · spawns", true],
  ["structures", "Structures", true],
  ["low", "Clicks pick the lowest layer (caves)", false],
] as const;
type LayerKey = (typeof LAYERS)[number][0];
const layerOn: Record<string, boolean> = {};
$("layers").innerHTML = LAYERS.map(([k, name, on]) => {
  layerOn[k] = on;
  return `<label class="chk"><input type="checkbox" data-k="${k}" ${on ? "checked" : ""}>${name}</label>`;
}).join("");
$("layers").addEventListener("change", (e) => {
  const t = e.target as HTMLInputElement;
  layerOn[t.dataset.k!] = t.checked;
  if (t.dataset.k === "low") recompute();
  draw();
});
const on = (k: LayerKey) => layerOn[k];

// ------------------------------------------------------------------ state ---
let world: World | null = null;
let cw: CollisionWorld | null = null;
let nav: NavGraph | null = null;
let cover: CoverSet | null = null;
let pois: Pois | null = null;
let base: HTMLCanvasElement | null = null;
let coverage: HTMLCanvasElement | null = null;
let regionTint: HTMLCanvasElement | null = null;
type Pick = { x: number; z: number; y?: number };
let A: Pick | null = parsePt(params.get("a"));
let B: Pick | null = parsePt(params.get("b"));
let threat: { x: number; z: number } | null = parsePt(params.get("t"));
let path: PathResult | null = null;
let pathMs = 0;
let spots: CoverSpot[] = [];
let coverMs = 0;
let losA: boolean | null = null;
const timings: Record<string, number> = {};
const view = { scale: 1, ox: 0, oy: 0 };

function fitView() {
  const r = canvas.getBoundingClientRect();
  const s = Math.min(r.width, r.height) / (2 * WORLD_HALF);
  view.scale = s;
  view.ox = (r.width - 2 * WORLD_HALF * s) / 2;
  view.oy = (r.height - 2 * WORLD_HALF * s) / 2;
}
function setView(scale: number, x: number, z: number) {
  const r = canvas.getBoundingClientRect();
  view.scale = scale;
  view.ox = r.width / 2 - (x + WORLD_HALF) * scale;
  view.oy = r.height / 2 - (z + WORLD_HALF) * scale;
  draw();
}
const toWorld = (px: number, py: number) => ({ x: (px - view.ox) / view.scale - WORLD_HALF, z: (py - view.oy) / view.scale - WORLD_HALF });
const SX = (x: number) => D.sx(view, x);
const SY = (z: number) => D.sy(view, z);

// ------------------------------------------------------------------ load ---
async function load(s: number) {
  $("progress").style.display = "block";
  $("progress").textContent = `Generating seed ${s}…`;
  try {
    const t0 = performance.now();
    const res = await loadWorldWithStats(s, undefined, { skipDecor: true });
    timings.worldgen = performance.now() - t0;
    world = res.world;
    $("progress").textContent = "Building nav…";
    await new Promise((r) => setTimeout(r, 0));
    let t = performance.now();
    cw = buildCollision(world);
    timings.collision = performance.now() - t;
    t = performance.now();
    nav = buildNav(world, cw);
    timings.nav = performance.now() - t;
    t = performance.now();
    cover = buildCover(nav);
    timings.cover = performance.now() - t;
    t = performance.now();
    pois = buildPois(nav);
    timings.pois = performance.now() - t;
    base = D.renderBase(world, 1024);
    coverage = renderCoverage(nav, false);
    regionTint = renderCoverage(nav, true);
    $("progress").style.display = "none";
    $("sub").textContent = `${world.name} · seed ${s} · ${world.archetype ?? ""}`;
    showBuild();
    const zoom = Number(params.get("zoom"));
    const at = parsePt(params.get("at"));
    fitView();
    if (zoom > 0) setView(zoom, at?.x ?? 0, at?.z ?? 0);
    recompute();
    draw();
    window.__stats = { seed: s, timings, nav: nav.stats, cover: cover.count, perches: pois.perches.length };
    window.__ready = true;
  } catch (e) {
    $("error").style.display = "block";
    $("error").textContent = String((e as Error).stack ?? e);
    window.__ready = true;
  }
}

function showBuild() {
  if (!nav || !cover || !pois) return;
  const rows: [string, number][] = [
    ["worldgen (worker)", timings.worldgen], ["collision", timings.collision],
    ...Object.entries(nav.stats.phases).map(([k, v]) => ["nav." + k, v] as [string, number]),
    ["nav total", timings.nav], ["cover", timings.cover], ["pois", timings.pois],
  ];
  const max = Math.max(...rows.slice(2).map((r) => r[1]));
  $("build").innerHTML = rows.map(([k, v]) =>
    `<tr${k === "nav total" ? ' style="font-weight:650"' : ""}><td>${k}</td><td class="barc">${k.startsWith("nav.") ? `<div class="bar" style="width:${(v / max) * 100}%"></div>` : ""}</td><td class="ms">${v.toFixed(1)} ms</td></tr>`).join("");
  const st = nav.stats;
  const kv: [string, string][] = [
    ["nodes", `${st.nodes.toLocaleString()} (grid ${st.coarseNodes.toLocaleString()}, struct ${st.structNodes.toLocaleString()}, cave ${st.caveNodes.toLocaleString()})`],
    ["edges", st.edges.toLocaleString()], ["regions", String(st.regions)],
    ["links", `${nav.links.filter((l) => l.act === Act.Zipline).length} zip, ${nav.links.filter((l) => l.act === Act.Vehicle).length} boat`],
    ["memory", `${(st.bytes / 1048576).toFixed(1)} MB`], ["cover pts", cover.count.toLocaleString()], ["perches", String(pois.perches.length)],
  ];
  $("sizes").innerHTML = kv.map(([k, v]) => `<span class="k">${k}</span><span class="v">${v}</span>`).join("");
}

/** 513² image of the coarse grid: walkable / wade / swim / blocked, or region tint. */
function renderCoverage(g: NavGraph, regions: boolean): HTMLCanvasElement {
  const n = 513;
  const c = D.makeCanvas(n, n);
  const cx = c.getContext("2d")!;
  const img = cx.createImageData(n, n);
  const H = g.world.height;
  for (let i = 0; i < n * n; i++) {
    const q = g.coarse[i];
    let r = 0, gg = 0, b = 0, a = 0;
    if (q >= 0) {
      const f = g.flags[q];
      if (regions) {
        const h = Math.imul(g.region[q] + 1, 0x9e3779b1) >>> 0;
        r = 60 + (h & 0xbf); gg = 60 + ((h >> 8) & 0xbf); b = 60 + ((h >> 16) & 0xbf); a = 120;
      } else if (f & NF.Swim) { r = 40; gg = 110; b = 255; a = f & NF.Wash ? 70 : 40; }
      else if (f & NF.Wade) { r = 110; gg = 220; b = 255; a = 90; }
      else { r = 90; gg = 255; b = 120; a = 60; }
    } else if (g.owner[i] < 0 && H[i] > 0 && g.level[i] < -1e8) { r = 255; gg = 40; b = 60; a = 110; }
    img.data[i * 4] = r; img.data[i * 4 + 1] = gg; img.data[i * 4 + 2] = b; img.data[i * 4 + 3] = a;
  }
  cx.putImageData(img, 0, 0);
  return c;
}

// ------------------------------------------------------------- queries ---
function recompute() {
  if (!nav || !world || !cw || !cover) return;
  path = null;
  spots = [];
  losA = null;
  if (A && B) {
    const yOf = (p: { x: number; z: number; y?: number }) => p.y ?? (on("low") ? -1000 : terrainHeight(world!, p.x, p.z));
    const a = { x: A.x, y: yOf(A), z: A.z };
    const b = { x: B.x, y: yOf(B), z: B.z };
    const t = performance.now();
    path = findPath(nav, a, b);
    pathMs = performance.now() - t;
  }
  if (threat) {
    const te = { x: threat.x, y: terrainHeight(world, threat.x, threat.z) + EYE_H, z: threat.z };
    const near = A ? { x: A.x, y: terrainHeight(world, A.x, A.z), z: A.z } : { x: threat.x + 20, y: te.y, z: threat.z };
    const t = performance.now();
    spots = findCover(nav, cover, te, near, 30, { max: 6 });
    coverMs = performance.now() - t;
    if (A) losA = lineOfSight(cw, te, { x: A.x, y: near.y + EYE_H, z: A.z });
  }
  showPath();
}

function showPath() {
  const kv: [string, string][] = [];
  if (!path) kv.push(["", "click two points"]);
  else {
    const counts: Record<string, number> = {};
    for (const w of path.waypoints) counts[w.action] = (counts[w.action] ?? 0) + 1;
    kv.push(["ok", path.ok ? "yes" : path.partial ? "partial" : "no"], ["query", `${pathMs.toFixed(2)} ms`], ["expanded", path.expanded.toLocaleString()],
      ["est. time", `${path.cost.toFixed(1)} s`], ["nodes → waypoints", `${path.nodes.length} → ${path.waypoints.length}`],
      ["actions", Object.entries(counts).map(([k, v]) => `${k}×${v}`).join(" ")]);
  }
  $("pathkv").innerHTML = kv.map(([k, v]) => `<span class="k">${k}</span><span class="v">${v}</span>`).join("");
  $("wps").innerHTML = path ? path.waypoints.map((w, i) =>
    `<div><span style="color:${ACT_COLOR[w.act]}">■</span> ${i} ${w.action.padEnd(9)} ${w.x.toFixed(1)}, ${w.y.toFixed(1)}, ${w.z.toFixed(1)}${w.link >= 0 ? ` #${w.link}` : ""}</div>`).join("") : "";
  const ck: [string, string][] = threat ? [
    ["cover spots", `${spots.length} (${coverMs.toFixed(2)} ms)`], ["full / peek", `${spots.filter((s) => s.full).length} / ${spots.filter((s) => s.peek).length}`],
    ["threat sees start", losA === null ? "–" : losA ? "yes" : "no"],
  ] : [["", "shift+click a threat"]];
  $("coverkv").innerHTML = ck.map(([k, v]) => `<span class="k">${k}</span><span class="v">${v}</span>`).join("");
}

// ---------------------------------------------------------------- bench ---
function bench() {
  if (!nav || !world) return;
  const g = nav;
  let s = 12345;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const pts = world.spawns.concat(world.pickups);
  const times: number[] = [];
  let exp = 0, ok = 0;
  for (let k = 0; k < 300; k++) {
    const a = pts[Math.floor(rnd() * pts.length)], b = pts[Math.floor(rnd() * pts.length)];
    const t = performance.now();
    const r = findPath(g, a, b);
    times.push(performance.now() - t);
    exp += r.expanded;
    if (r.ok) ok++;
  }
  times.sort((p, q) => p - q);
  // planner: 19 bots re-plan at once, 4000 expansions per 30 Hz tick
  const planner = new PathPlanner(g);
  for (let k = 0; k < 19; k++) planner.request(world.spawns[k], world.spawns[(k * 7 + 5) % world.spawns.length]);
  const ticks: number[] = [];
  let done = 0;
  while (planner.pending > 0 && ticks.length < 200) {
    const t = performance.now();
    done += planner.update(4000).length;
    ticks.push(performance.now() - t);
  }
  const t0 = performance.now();
  let wn = 0;
  for (let k = 0; k < 50; k++) if (nearestWater(g, world.spawns[k % world.spawns.length])) wn++;
  const waterMs = (performance.now() - t0) / 50;
  const res: [string, string][] = [
    ["findPath ×300", `avg ${(times.reduce((p, q) => p + q, 0) / times.length).toFixed(2)} ms`],
    ["p50 / p95 / max", `${times[150].toFixed(2)} / ${times[285].toFixed(2)} / ${times[299].toFixed(2)} ms`],
    ["ok / avg expanded", `${ok} / ${Math.round(exp / 300)}`],
    ["planner 19 paths", `${ticks.length} ticks, ${done} done`],
    ["tick max / avg", `${Math.max(...ticks).toFixed(2)} / ${(ticks.reduce((p, q) => p + q, 0) / ticks.length).toFixed(2)} ms`],
    ["nearestWater", `${waterMs.toFixed(2)} ms (${wn}/50)`],
  ];
  $("benchkv").innerHTML = res.map(([k, v]) => `<span class="k">${k}</span><span class="v">${v}</span>`).join("");
  window.__stats = { ...(window.__stats as object), bench: Object.fromEntries(res) };
}

// ----------------------------------------------------------------- draw ---
function draw() {
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  if (canvas.width !== Math.round(r.width * dpr) || canvas.height !== Math.round(r.height * dpr)) {
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#0c1a2c";
  ctx.fillRect(0, 0, r.width, r.height);
  if (!world || !nav || !base) return;
  const size = 2 * WORLD_HALF * view.scale;
  ctx.imageSmoothingEnabled = view.scale < 2;
  ctx.drawImage(base, view.ox, view.oy, size, size);
  // coarse samples sit on the grid points: the image pixel k covers [gx(k) - 1, gx(k) + 1]
  const half = view.scale;
  ctx.imageSmoothingEnabled = false;
  if (on("coverage") && coverage) ctx.drawImage(coverage, view.ox - half, view.oy - half, size + 2 * half, size + 2 * half);
  if (on("regions") && regionTint) ctx.drawImage(regionTint, view.ox - half, view.oy - half, size + 2 * half, size + 2 * half);
  if (on("structures") && view.scale > 1.2) D.drawStructures(ctx, world.structures, view, view.scale < 3);
  const x0 = toWorld(0, 0), x1 = toWorld(r.width, r.height);
  const inView = (x: number, z: number, m = 4) => x > x0.x - m && x < x1.x + m && z > x0.z - m && z < x1.z + m;
  const g = nav;
  if (on("patches")) {
    for (const p of g.patches) {
      if (!inView(p.x0 + (p.w * p.res) / 2, p.z0 + (p.h * p.res) / 2, p.w * p.res)) continue;
      if (view.scale < 2.5) {
        ctx.strokeStyle = p.cave ? "rgba(255,154,61,0.8)" : "rgba(255,224,102,0.8)";
        ctx.lineWidth = 1;
        ctx.strokeRect(SX(p.x0), SY(p.z0), p.w * p.res * view.scale, p.h * p.res * view.scale);
      }
      const s = Math.max(1.2, p.res * view.scale * 0.7);
      for (const q of p.colNodes) {
        if (!inView(g.x[q], g.z[q], 1)) continue;
        const f = g.flags[q];
        const up = g.y[q] - terrainHeight(world, g.x[q], g.z[q]);
        let col = f & NF.Swim ? "#3d8bff" : f & NF.Cave ? "#ff9a3d" : f & NF.Wade ? "#9fe8ff" : "#ffe066";
        if (!(f & NF.Cave) && !(f & NF.Swim) && up > 1.5) col = up > 5 ? "#ff5ad1" : "#ffa8e8";
        if (p.cave && !(f & NF.Cave)) col = "#ffd2a8";
        ctx.fillStyle = col;
        ctx.fillRect(SX(g.x[q]) - s / 2, SY(g.z[q]) - s / 2, s, s);
      }
    }
  }
  if (on("edges") && view.scale >= 5) {
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.strokeStyle = "rgba(255,255,255,0.28)";
    let count = 0;
    for (let a = 0; a < g.n && count < 60000; a++) {
      if (!inView(g.x[a], g.z[a], 2)) continue;
      for (let e = g.eStart[a]; e < g.eStart[a + 1]; e++) {
        const act = g.eAct[e];
        if (act !== Act.Walk && act !== Act.Wade && act !== Act.Swim && act !== Act.Cave) continue;
        const b = g.eTo[e];
        if (b < a) continue;
        ctx.moveTo(SX(g.x[a]), SY(g.z[a]));
        ctx.lineTo(SX(g.x[b]), SY(g.z[b]));
        count++;
      }
    }
    ctx.stroke();
  }
  if (on("links")) drawLinks(g, inView);
  if (on("cover") && cover && view.scale >= 1.5) {
    for (let k = 0; k < cover.count; k++) {
      const x = cover.x[k], z = cover.z[k];
      if (!inView(x, z)) continue;
      const kind = cover.kind[k];
      ctx.fillStyle = kind === CoverKind.Solid ? "#ffffff" : kind === CoverKind.Prop ? "#7dff7a" : "#d2a26b";
      const px = SX(x), py = SY(z);
      ctx.fillRect(px - 1.5, py - 1.5, 3, 3);
      if (view.scale >= 6) {
        ctx.strokeStyle = ctx.fillStyle;
        ctx.beginPath();
        for (let o = 0; o < 8; o++) {
          if (!(cover.low[k] & (1 << o))) continue;
          const L = cover.high[k] & (1 << o) ? 7 : 4;
          const ang = (o * Math.PI) / 4;
          ctx.moveTo(px, py);
          ctx.lineTo(px + Math.cos(ang) * L, py + Math.sin(ang) * L);
        }
        ctx.stroke();
      }
    }
  }
  if (on("pois") && pois) {
    D.drawSpawns(ctx, world, view);
    D.drawPickups(ctx, world, view);
    for (const p of pois.perches) {
      const px = SX(p.x), py = SY(p.z);
      ctx.beginPath();
      ctx.moveTo(px, py - 6);
      ctx.lineTo(px + 5, py + 3);
      ctx.lineTo(px - 5, py + 3);
      ctx.closePath();
      ctx.fillStyle = p.structure ? "#ff5ad1" : "#c7a0ff";
      ctx.fill();
      ctx.strokeStyle = "#1c1c26";
      ctx.stroke();
    }
  }
  drawPath();
  drawThreat();
  showReadout();
}

function drawLinks(g: NavGraph, inView: (x: number, z: number, m?: number) => boolean) {
  const arrow = (ax: number, az: number, bx: number, bz: number, col: string, w: number, dash: number[] = []) => {
    const x0 = SX(ax), y0 = SY(az), x1 = SX(bx), y1 = SY(bz);
    ctx.save();
    ctx.setLineDash(dash);
    ctx.strokeStyle = col;
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    const dx = x1 - x0, dy = y1 - y0, l = Math.hypot(dx, dy) || 1;
    const hs = Math.min(6, l * 0.5);
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 - (dx / l) * hs - (dy / l) * hs * 0.5, y1 - (dy / l) * hs + (dx / l) * hs * 0.5);
    ctx.lineTo(x1 - (dx / l) * hs + (dy / l) * hs * 0.5, y1 - (dy / l) * hs - (dx / l) * hs * 0.5);
    ctx.closePath();
    ctx.fillStyle = col;
    ctx.fill();
    ctx.restore();
  };
  const showSmall = view.scale >= 2;
  for (let a = 0; a < g.n; a++) {
    for (let e = g.eStart[a]; e < g.eStart[a + 1]; e++) {
      const act = g.eAct[e];
      if (act === Act.Walk || act === Act.Wade || act === Act.Swim || act === Act.Cave) continue;
      const b = g.eTo[e];
      if (act === Act.Zipline) arrow(g.x[a], g.z[a], g.x[b], g.z[b], ACT_COLOR[act], 2.5);
      else if (act === Act.Vehicle) arrow(g.x[a], g.z[a], g.x[b], g.z[b], ACT_COLOR[act], 1.5, [5, 4]);
      else if (showSmall && inView(g.x[a], g.z[a])) arrow(g.x[a], g.z[a], g.x[b], g.z[b], ACT_COLOR[act], 1);
    }
  }
}

function drawPath() {
  if (A) marker(A.x, A.z, "#7dff7a", "A");
  if (B) marker(B.x, B.z, "#ff6b6b", "B");
  if (!path || !nav) return;
  const g = nav;
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(0,0,0,0.5)";
  ctx.beginPath();
  path.nodes.forEach((q, i) => (i ? ctx.lineTo(SX(g.x[q]), SY(g.z[q])) : ctx.moveTo(SX(g.x[q]), SY(g.z[q]))));
  ctx.stroke();
  const wps = path.waypoints;
  for (let i = 1; i < wps.length; i++) {
    const p = wps[i - 1], q = wps[i];
    ctx.strokeStyle = "#101418";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(SX(p.x), SY(p.z));
    ctx.lineTo(SX(q.x), SY(q.z));
    ctx.stroke();
    ctx.strokeStyle = ACT_COLOR[q.act];
    ctx.lineWidth = 2.6;
    ctx.stroke();
  }
  for (const w of wps) {
    ctx.beginPath();
    ctx.arc(SX(w.x), SY(w.z), 2.6, 0, Math.PI * 2);
    ctx.fillStyle = ACT_COLOR[w.act];
    ctx.fill();
    ctx.strokeStyle = "#101418";
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

function drawThreat() {
  if (!threat || !world || !cw) return;
  const tx = SX(threat.x), ty = SY(threat.z);
  for (const s of spots) {
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = "rgba(255,255,255,0.6)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(SX(s.x), SY(s.z));
    ctx.stroke();
    ctx.restore();
    ctx.beginPath();
    ctx.arc(SX(s.x), SY(s.z), 5, 0, Math.PI * 2);
    ctx.fillStyle = s.full ? "#7dff7a" : "#d6ff7a";
    ctx.fill();
    ctx.strokeStyle = s.peek ? "#ff5ad1" : "#101418";
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  if (A && losA !== null) {
    ctx.save();
    ctx.setLineDash(losA ? [] : [6, 4]);
    ctx.strokeStyle = losA ? "#ff4040" : "#40ff90";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(SX(A.x), SY(A.z));
    ctx.stroke();
    ctx.restore();
  }
  ctx.strokeStyle = "#ff4040";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(tx - 6, ty - 6); ctx.lineTo(tx + 6, ty + 6);
  ctx.moveTo(tx + 6, ty - 6); ctx.lineTo(tx - 6, ty + 6);
  ctx.stroke();
}

function marker(x: number, z: number, col: string, label: string) {
  const px = SX(x), py = SY(z);
  ctx.beginPath();
  ctx.arc(px, py, 7, 0, Math.PI * 2);
  ctx.fillStyle = col;
  ctx.fill();
  ctx.strokeStyle = "#101418";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = "#101418";
  ctx.font = "700 9px ui-sans-serif, system-ui";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, px, py + 0.5);
}

let mouse = { x: 0, z: 0 };
function showReadout() {
  if (!world || !nav) return;
  const q = nearestNode(nav, mouse.x, terrainHeight(world, mouse.x, mouse.z), mouse.z, 3);
  const f = q >= 0 ? nav.flags[q] : 0;
  const names = Object.entries(NF).filter(([, v]) => f & v).map(([k]) => k).join(" ");
  $("readout").innerHTML = `<b>${mouse.x.toFixed(1)}, ${mouse.z.toFixed(1)}</b> · h ${terrainHeight(world, mouse.x, mouse.z).toFixed(1)} m · ${view.scale.toFixed(2)} px/m<br>` +
    (q >= 0 ? `node ${q} y ${nav.y[q].toFixed(2)} · ${names} · region ${nav.region[q]} (comp ${nav.regions.comp[nav.region[q]]}) · ${nav.eStart[q + 1] - nav.eStart[q]} edges` : "no node");
}

// ----------------------------------------------------------- interaction ---
let drag: { x: number; y: number; ox: number; oy: number; moved: boolean } | null = null;
canvas.addEventListener("mousedown", (e) => {
  drag = { x: e.clientX, y: e.clientY, ox: view.ox, oy: view.oy, moved: false };
});
window.addEventListener("mousemove", (e) => {
  const r = canvas.getBoundingClientRect();
  mouse = toWorld(e.clientX - r.left, e.clientY - r.top);
  if (drag) {
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    if (drag.moved) { view.ox = drag.ox + dx; view.oy = drag.oy + dy; draw(); return; }
  }
  showReadout();
});
window.addEventListener("mouseup", (e) => {
  if (drag && !drag.moved && e.target === canvas) {
    const r = canvas.getBoundingClientRect();
    const p = toWorld(e.clientX - r.left, e.clientY - r.top);
    if (e.shiftKey) threat = p;
    else if (!A || (A && B)) { A = p; B = null; }
    else B = p;
    recompute();
    draw();
  }
  drag = null;
});
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  const px = e.clientX - r.left, py = e.clientY - r.top;
  const w = toWorld(px, py);
  const f = Math.exp(-e.deltaY * 0.0015);
  view.scale = Math.min(40, Math.max(0.3, view.scale * f));
  view.ox = px - (w.x + WORLD_HALF) * view.scale;
  view.oy = py - (w.z + WORLD_HALF) * view.scale;
  draw();
}, { passive: false });
window.addEventListener("keydown", (e) => {
  if (e.key === "c") { A = B = threat = null; recompute(); draw(); }
});
window.addEventListener("resize", () => draw());
$("go").addEventListener("click", () => {
  const s = Number($<HTMLInputElement>("seed").value) >>> 0;
  const u = new URL(location.href);
  u.searchParams.set("seed", String(s));
  location.href = u.toString();
});
$("bench").addEventListener("click", () => bench());

window.__debug = {
  view: (scale: number, x: number, z: number) => setView(scale, x, z),
  path: (ax: number, az: number, bx: number, bz: number, ay?: number, by?: number) => {
    A = { x: ax, z: az, y: ay }; B = { x: bx, z: bz, y: by }; recompute(); draw();
    return path && { ok: path.ok, ms: pathMs, wps: path.waypoints.length, cost: path.cost, actions: path.waypoints.map((w) => w.action).join(",") };
  },
  threat: (x: number, z: number) => { threat = { x, z }; recompute(); draw(); return spots.length; },
  layer: (k: string, v: boolean) => { layerOn[k] = v; draw(); },
  bench: () => { bench(); return (window.__stats as { bench?: unknown }).bench; },
  nav: () => nav,
};

load(seed);
