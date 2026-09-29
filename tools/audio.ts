// Audio test bench: trigger every sound, move a source around the listener,
// drive the ambience with sliders, play the music — and analyse sounds
// headlessly via OfflineAudioContext.
//
// window.__debug:
//   render(name, seconds?)  name = sfx name | "bed:surf" | "music:menu" | "jingle:win" | "jingle:lose"
//                           → { peakDb, rmsDb, stRmsDb, clipped, silent, … }
//   renderAll()             every sfx + bed → table rows
//   seam(key)               loop seam ratio for "sfx:vespa_engine" / "bed:surf" (≈ <1.5 = seamless)
//   pan(name, x, z)         L/R RMS of a positional render with the listener at the origin facing -z
//   perf(voices?, model?)   offline-render cost of all ambience beds + N moving positional voices
//   grid(names, cols?)      draw waveform + spectrogram grid full-screen (for scripts/shot.mjs)
//   hideGrid()
//   stats()                 engine stats
// window.__ready = true once every sound, bed and music note is rendered.

import { createAudio, SFX_NAMES, BED_NAMES, type AmbienceState, type AudioEngineImpl, type SfxName, type AmbienceBiome } from "../client/src/audio";
import { SFX, type SfxDef } from "../client/src/audio/recipes";
import { scheduleOffline, scheduleJingleOffline } from "../client/src/audio/music";
import type { Bank } from "../client/src/audio/bank";

const t0 = performance.now();
const audio = createAudio() as unknown as AudioEngineImpl;
const bank: Bank = audio.debug.bank;
audio.offlineOk = true;

// ---------------------------------------------------------------- tiny DOM helper
type Props = Record<string, unknown>;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...kids: (Node | string | null)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith("on")) e.addEventListener(k.slice(2), v as EventListener);
    else if (k === "class") e.className = String(v);
    else (e as unknown as Record<string, unknown>)[k] = v;
  }
  for (const k of kids) if (k !== null) e.append(k);
  return e;
}
function slider(label: string, min: number, max: number, step: number, value: number, on: (v: number) => void, fmt = (v: number) => v.toFixed(2)): HTMLLabelElement {
  const out = el("span", { class: "val" }, fmt(value));
  const inp = el("input", { type: "range", min, max, step, value });
  inp.addEventListener("input", () => {
    const v = Number(inp.value);
    out.textContent = fmt(v);
    on(v);
  });
  const row = el("label", { class: "row" }, label, inp, out);
  (row as unknown as { set(v: number): void }).set = (v: number) => {
    inp.value = String(v);
    out.textContent = fmt(v);
    on(v);
  };
  return row;
}
const setSlider = (row: HTMLLabelElement, v: number) => (row as unknown as { set(v: number): void }).set(v);

const app = document.getElementById("app")!;

// ---------------------------------------------------------------- header
const status = el("span", { id: "status" }, "rendering…");
const unlockBtn = el("button", { class: "big", onclick: async () => { await audio.unlock(); refreshStatus(); } }, "▶ Enable audio");
const muteBtn = el("button", { onclick: () => { audio.setMuted(!audio.muted); muteBtn.classList.toggle("on", audio.muted); } }, "Mute");
muteBtn.classList.toggle("on", audio.muted);
app.append(el("h1", {}, "Isola audio bench", unlockBtn, muteBtn, status));
function refreshStatus(): void {
  const s = audio.stats();
  status.textContent = `ctx ${s.state} · ${s.loaded} loaded, ${s.pending} pending · voices ${s.voices} · loops ${s.loops} · beds ${s.beds} · music srcs ${s.musicSources}`;
  unlockBtn.style.display = s.state === "running" ? "none" : "";
}
setInterval(refreshStatus, 250);

// ---------------------------------------------------------------- volumes & mix
{
  const v = audio.getVolumes();
  const sec = el("section", {}, el("h2", {}, "Volumes & mix"));
  for (const k of ["master", "sfx", "ambience", "music"] as const) sec.append(slider(k, 0, 1, 0.01, v[k], (x) => audio.setVolume(k, x)));
  sec.append(el("h3", {}, "Mix reactions"));
  sec.append(el("button", { onclick: () => audio.duck(0.6, 900) }, "duck(0.6, 900 ms)"));
  sec.append(el("button", { onclick: () => { audio.play("eliminate", { bus: "self" }); audio.duck(0.5, 1200); } }, "elimination + duck"));
  let breathOn = false;
  let breath = 1;
  const bBtn = el("button", { onclick: () => { breathOn = !breathOn; bBtn.classList.toggle("on", breathOn); audio.setBreath(breathOn ? breath : null); } }, "breath → heartbeat");
  sec.append(bBtn, slider("breath left", 0, 1, 0.01, 1, (x) => { breath = x; if (breathOn) audio.setBreath(x); }));
  app.append(sec);
}

// ---------------------------------------------------------------- one-shots
let spatial: "center" | "right" | "random" = "center";
function playOpts() {
  if (spatial === "center") return {};
  if (spatial === "right") return { pos: { x: 4, y: 0, z: -2 } };
  const a = Math.random() * Math.PI * 2, d = 2 + Math.random() * 35;
  return { pos: { x: Math.cos(a) * d, y: 0, z: Math.sin(a) * d } };
}
{
  const sec = el("section", { class: "wide" }, el("h2", {}, "Sounds"));
  const modes = el("div", {});
  const mb: HTMLButtonElement[] = [];
  for (const m of ["center", "right", "random"] as const) {
    const b = el("button", { onclick: () => { spatial = m; mb.forEach((x) => x.classList.toggle("on", x === b)); } }, m === "center" ? "2D / centre" : m === "right" ? "positional 4 m right" : "positional random 2–37 m");
    b.classList.toggle("on", m === spatial);
    mb.push(b);
    modes.append(b);
  }
  sec.append(modes);
  const groups: Record<string, SfxName[]> = { world: [], self: [], ui: [], amb: [] };
  for (const n of SFX_NAMES) if (!("loop" in SFX[n])) groups[SFX[n].cat].push(n);
  for (const [g, names] of Object.entries(groups)) {
    sec.append(el("h3", {}, g));
    const row = el("div", {});
    for (const n of names) row.append(el("button", { onclick: () => audio.play(n, playOpts()) }, n));
    sec.append(row);
  }
  app.append(sec);
}

// ---------------------------------------------------------------- loops
{
  const sec = el("section", {}, el("h2", {}, "Loops"));
  for (const n of SFX_NAMES.filter((n) => "loop" in SFX[n])) {
    let h: ReturnType<typeof audio.loop> | null = null;
    let pitch = 1, vol = 1;
    const b = el("button", {
      onclick: () => {
        if (h) { h.stop(300); h = null; } else h = audio.loop(n, { pitch, volume: vol, ...(spatial === "center" ? {} : { pos: { x: 3, y: 0, z: -3 } }) });
        b.classList.toggle("on", !!h);
      },
    }, n);
    sec.append(el("h3", {}, n), b,
      slider("pitch (speed)", 0.5, 2.5, 0.01, 1, (x) => { pitch = x; h?.setPitch(x); }),
      slider("volume", 0, 1.5, 0.01, 1, (x) => { vol = x; h?.setVolume(x); }));
  }
  app.append(sec);
}

// ---------------------------------------------------------------- positional demo
{
  const sec = el("section", {}, el("h2", {}, "Positional demo (listener at centre facing up = −z)"));
  const cv = el("canvas", { width: 320, height: 320 });
  let radius = 8, speed = 0.5, interval = 450, on = false, ang = 0, useLoop = false;
  let name: SfxName = "shoot";
  const sel = el("select", {});
  for (const n of SFX_NAMES) sel.append(el("option", { value: n, selected: n === name }, n));
  sel.addEventListener("change", () => { name = sel.value as SfxName; });
  let loopH: ReturnType<typeof audio.loop> | null = null;
  const btn = el("button", {
    onclick: () => {
      on = !on;
      btn.classList.toggle("on", on);
      if (!on) { loopH?.stop(200); loopH = null; }
    },
  }, "orbit");
  const loopBox = el("input", { type: "checkbox", onchange: (e: Event) => { useLoop = (e.target as HTMLInputElement).checked; } });
  sec.append(el("div", {}, sel, btn, el("label", {}, loopBox, " as loop (setPos each frame)")), cv,
    slider("radius m", 1, 60, 0.5, radius, (x) => (radius = x)),
    slider("speed rad/s", -3, 3, 0.05, speed, (x) => (speed = x)),
    slider("retrigger ms", 80, 2000, 10, interval, (x) => (interval = x), (x) => x.toFixed(0)));
  app.append(sec);
  const g = cv.getContext("2d")!;
  let last = performance.now(), lastFire = 0;
  const frame = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    audio.setListener({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
    if (on) ang += speed * dt;
    const pos = { x: Math.sin(ang) * radius, y: 0, z: -Math.cos(ang) * radius };
    if (on) {
      if (useLoop) {
        if (!loopH) loopH = audio.loop(name, { pos });
        loopH.setPos(pos);
      } else if (now - lastFire > interval) {
        lastFire = now;
        audio.play(name, { pos });
      }
    }
    g.clearRect(0, 0, 320, 320);
    g.strokeStyle = "#ecdcc6";
    for (const r of [10, 20, 40, 60]) { g.beginPath(); g.arc(160, 160, r * 2.5, 0, Math.PI * 2); g.stroke(); }
    g.fillStyle = "#5a3a2a";
    g.beginPath(); g.moveTo(160, 150); g.lineTo(153, 168); g.lineTo(167, 168); g.fill();
    g.fillStyle = on ? "#2a9d9b" : "#bbb";
    g.beginPath(); g.arc(160 + pos.x * 2.5, 160 + pos.z * 2.5, 7, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#8a6a58";
    g.fillText("rings: 10 / 20 / 40 / 60 m", 8, 14);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- ambience
{
  const sec = el("section", {}, el("h2", {}, "Ambience"));
  const st: AmbienceState = {
    biomeWeights: { beach: 1 }, seaDistance: 10, riverDistance: 200, waterfallDistance: 300, altitude: 5, cave: 0, underwater: false, timeOfDay: 13,
    dirs: { sea: { x: 1, z: 0 }, village: { x: 0, z: -1 } },
  };
  let enabled = false;
  const enBtn = el("button", {
    onclick: () => {
      enabled = !enabled;
      enBtn.classList.toggle("on", enabled);
      if (!enabled) audio.stopAmbience();
    },
  }, "ambience on/off");
  sec.append(enBtn);
  const biomes: AmbienceBiome[] = ["beach", "jungle", "meadow", "rock", "village", "mangrove"];
  const rows: Record<string, HTMLLabelElement> = {};
  for (const b of biomes) rows[b] = slider(b, 0, 1, 0.01, st.biomeWeights[b] ?? 0, (x) => (st.biomeWeights[b] = x));
  rows.sea = slider("seaDistance m", 0, 300, 1, st.seaDistance, (x) => (st.seaDistance = x), (x) => x.toFixed(0));
  rows.river = slider("riverDistance m", 0, 200, 1, st.riverDistance, (x) => (st.riverDistance = x), (x) => x.toFixed(0));
  rows.fall = slider("waterfallDistance", 0, 300, 1, st.waterfallDistance, (x) => (st.waterfallDistance = x), (x) => x.toFixed(0));
  rows.alt = slider("altitude m", 0, 120, 1, st.altitude, (x) => (st.altitude = x), (x) => x.toFixed(0));
  rows.cave = slider("cave", 0, 1, 0.01, st.cave, (x) => (st.cave = x));
  rows.tod = slider("timeOfDay h", 6, 20, 0.01, st.timeOfDay, (x) => (st.timeOfDay = x));
  const uw = el("input", { type: "checkbox", onchange: (e: Event) => { st.underwater = (e.target as HTMLInputElement).checked; } });
  const presets: Record<string, Record<string, number | boolean>> = {
    Beach: { beach: 1, sea: 5, river: 200, fall: 300, alt: 2, cave: 0 },
    Jungle: { jungle: 1, sea: 90, river: 25, fall: 120, alt: 20, cave: 0 },
    Meadow: { meadow: 1, sea: 140, river: 200, fall: 300, alt: 45, cave: 0 },
    Village: { village: 0.7, meadow: 0.3, sea: 60, river: 200, fall: 300, alt: 15, cave: 0 },
    Mangrove: { mangrove: 1, sea: 20, river: 30, fall: 300, alt: 1, cave: 0 },
    Peak: { rock: 1, sea: 200, river: 200, fall: 300, alt: 100, cave: 0 },
    Waterfall: { jungle: 0.8, rock: 0.2, sea: 150, river: 5, fall: 12, alt: 30, cave: 0 },
    Cave: { rock: 1, sea: 100, river: 200, fall: 300, alt: 20, cave: 1 },
    Underwater: { beach: 1, sea: 0, river: 200, fall: 300, alt: 0, cave: 0, uw: true },
  };
  const pr = el("div", {});
  for (const [name, p] of Object.entries(presets)) {
    pr.append(el("button", {
      onclick: () => {
        for (const b of biomes) setSlider(rows[b], Number(p[b] ?? 0));
        for (const k of ["sea", "river", "fall", "alt", "cave"]) if (p[k] !== undefined) setSlider(rows[k], Number(p[k]));
        uw.checked = !!p.uw;
        st.underwater = !!p.uw;
        if (!enabled) enBtn.click();
      },
    }, name));
  }
  sec.append(el("h3", {}, "Presets"), pr, el("h3", {}, "State"));
  for (const r of Object.values(rows)) sec.append(r);
  sec.append(el("label", {}, uw, " underwater"));
  const gains = el("pre", { style: "font-size:11px;margin:6px 0 0" });
  sec.append(el("h3", {}, "Bed gain targets"), gains);
  app.append(sec);
  const loop = () => {
    if (enabled) audio.setAmbience(st);
    const t = audio.debug.ambience.gainTargets;
    gains.textContent = BED_NAMES.map((b) => `${b.padEnd(11)} ${"█".repeat(Math.round((t[b] ?? 0) * 20)).padEnd(20, "·")} ${(t[b] ?? 0).toFixed(2)}`).join("\n");
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

// ---------------------------------------------------------------- music
{
  const sec = el("section", {}, el("h2", {}, "Music"));
  sec.append(
    el("button", { onclick: () => audio.music.play("menu") }, "▶ menu loop"),
    el("button", { onclick: () => audio.music.stop(1500) }, "■ stop (fade)"),
    el("button", { onclick: () => audio.music.jingle("win") }, "jingle: win"),
    el("button", { onclick: () => audio.music.jingle("lose") }, "jingle: lose"),
  );
  app.append(sec);
}

// ---------------------------------------------------------------- analysis
interface Stats {
  name: string;
  seconds: number;
  peakDb: number;
  rmsDb: number;
  stRmsDb: number;
  lrDb: number;
  dc: number;
  tailDb: number;
  clipped: boolean;
  silent: boolean;
  renderMs: number;
}

const db = (x: number) => (x <= 1e-9 ? -180 : 20 * Math.log10(x));
let lastRender: AudioBuffer | null = null;
let meterNode: AnalyserNode | null = null;

function analyse(name: string, b: AudioBuffer, ms: number): Stats {
  const L = b.getChannelData(0), R = b.numberOfChannels > 1 ? b.getChannelData(1) : L;
  let peak = 0, ss = 0, sl = 0, sr = 0, dc = 0;
  for (let i = 0; i < L.length; i++) {
    peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
    ss += (L[i] * L[i] + R[i] * R[i]) / 2;
    sl += L[i] * L[i];
    sr += R[i] * R[i];
    dc += (L[i] + R[i]) / 2;
  }
  const w = Math.round(0.05 * b.sampleRate);
  let acc = 0, best = 0;
  for (let i = 0; i < L.length; i++) {
    acc += (L[i] * L[i] + R[i] * R[i]) / 2;
    if (i >= w) acc -= (L[i - w] * L[i - w] + R[i - w] * R[i - w]) / 2;
    best = Math.max(best, acc);
  }
  let tail = 0;
  const tn = Math.round(0.01 * b.sampleRate);
  for (let i = L.length - tn; i < L.length; i++) tail += L[i] * L[i];
  return {
    name, seconds: b.duration, renderMs: Math.round(ms),
    peakDb: +db(peak).toFixed(2), rmsDb: +db(Math.sqrt(ss / L.length)).toFixed(2), stRmsDb: +db(Math.sqrt(best / Math.min(w, L.length))).toFixed(2),
    lrDb: +(db(Math.sqrt(sr / L.length)) - db(Math.sqrt(sl / L.length))).toFixed(2), dc: +(dc / L.length).toFixed(5), tailDb: +db(Math.sqrt(tail / tn)).toFixed(1),
    clipped: peak >= 0.999, silent: peak < 1e-4,
  };
}

async function render(name: string, seconds?: number): Promise<Stats> {
  await audio.fullyLoaded;
  const sr = bank.sr;
  let dur = seconds ?? 2;
  let setup: (ctx: OfflineAudioContext) => void;
  if (name.startsWith("bed:")) {
    const buf = bank.get(name)![0];
    dur = seconds ?? 10;
    setup = (ctx) => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.connect(ctx.destination); s.start(); };
  } else if (name.startsWith("music:menu")) {
    // "music:menu" or "music:menu@<startBar>"
    dur = seconds ?? 60;
    const startBar = Number(name.split("@")[1] ?? 0);
    setup = (ctx) => scheduleOffline(ctx, bank, ctx.destination, dur - 0.5, 1, startBar);
  } else if (name.startsWith("jingle:")) {
    dur = seconds ?? 3.5;
    setup = (ctx) => scheduleJingleOffline(ctx, bank, ctx.destination, name.slice(7) as "win" | "lose");
  } else {
    const bufs = bank.get("sfx:" + name);
    if (!bufs) throw new Error("unknown sound " + name);
    const buf = bufs[0];
    const isLoop = "loop" in SFX[name as SfxName];
    dur = seconds ?? (isLoop ? buf.duration * 2 : buf.duration + 0.05);
    setup = (ctx) => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = isLoop; s.connect(ctx.destination); s.start(); };
  }
  const ctx = new OfflineAudioContext(2, Math.ceil(dur * sr), sr);
  setup(ctx);
  const t = performance.now();
  const b = await ctx.startRendering();
  lastRender = b;
  return analyse(name, b, performance.now() - t);
}

async function renderAll(): Promise<Stats[]> {
  const out: Stats[] = [];
  for (const n of SFX_NAMES) out.push(await render(n));
  for (const b of BED_NAMES) out.push(await render("bed:" + b, 8));
  return out;
}

/** Wrap-around discontinuity vs the 99.9th-percentile sample step (per channel, worst). */
function seam(key: string): number {
  const buf = bank.get(key)?.[0];
  if (!buf) return NaN;
  let worst = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const x = buf.getChannelData(c);
    const steps = new Float32Array(x.length - 1);
    for (let i = 1; i < x.length; i++) steps[i - 1] = Math.abs(x[i] - x[i - 1]);
    steps.sort();
    const p = steps[Math.floor(steps.length * 0.999)] || 1e-9;
    worst = Math.max(worst, Math.abs(x[0] - x[x.length - 1]) / p);
  }
  return +worst.toFixed(3);
}

async function pan(name: SfxName, x: number, z: number): Promise<{ lDb: number; rDb: number; totalDb: number }> {
  await audio.ready;
  const buf = bank.get("sfx:" + name)![0];
  const sr = bank.sr;
  const ctx = new OfflineAudioContext(2, Math.ceil((buf.duration + 0.1) * sr), sr);
  const s = ctx.createBufferSource();
  s.buffer = buf;
  const p = ctx.createPanner();
  p.panningModel = "HRTF";
  p.distanceModel = "inverse";
  p.refDistance = (SFX[name] as SfxDef).ref ?? 2;
  p.positionX.value = x;
  p.positionZ.value = z;
  s.connect(p).connect(ctx.destination);
  s.start();
  const b = await ctx.startRendering();
  const r = (c: Float32Array) => Math.sqrt(c.reduce((a, v) => a + v * v, 0) / c.length);
  const l = r(b.getChannelData(0)), rr = r(b.getChannelData(1));
  return { lDb: +db(l).toFixed(1), rDb: +db(rr).toFixed(1), totalDb: +db(Math.sqrt((l * l + rr * rr) / 2)).toFixed(1) };
}

/** Offline-render cost: all ambience beds (+filters, panners, cave convolver) + N positional voices moving every 16 ms. */
async function perf(voices = 20, model: PanningModelType = "HRTF", seconds = 10, o: { conv?: boolean; beds?: boolean; moving?: boolean; air?: boolean } = {}): Promise<Record<string, number>> {
  const { conv: useConv = true, beds = true, moving = true, air: useAir = true } = o;
  await audio.fullyLoaded;
  const sr = bank.sr;
  const ctx = new OfflineAudioContext(2, seconds * sr, sr);
  const tb = performance.now();
  let nodes = 0;
  const master = ctx.createGain();
  const lim = ctx.createDynamicsCompressor();
  master.connect(lim).connect(ctx.destination);
  const conv = ctx.createConvolver();
  conv.normalize = false;
  conv.buffer = bank.get("ir:cave")![0];
  const send = ctx.createGain();
  send.gain.value = 0.3;
  if (useConv) send.connect(conv).connect(master);
  nodes += 5;
  for (const b of beds ? BED_NAMES : []) {
    const s = ctx.createBufferSource();
    s.buffer = bank.get("bed:" + b)![0];
    s.loop = true;
    const f = ctx.createBiquadFilter();
    const g = ctx.createGain();
    g.gain.value = 0.3;
    const p = ctx.createStereoPanner();
    s.connect(f).connect(g).connect(p).connect(master);
    s.start();
    nodes += 4;
  }
  const names: SfxName[] = ["shoot", "splat_ground", "step_sand", "splat_player", "whiz", "vespa_engine"];
  const movers: ((t: number) => void)[] = [];
  for (let v = 0; v < voices; v++) {
    const s = ctx.createBufferSource();
    s.buffer = bank.get("sfx:" + names[v % names.length])![0];
    s.loop = true;
    const g = ctx.createGain();
    const air = ctx.createBiquadFilter();
    const p = ctx.createPanner();
    p.panningModel = model;
    p.distanceModel = "inverse";
    const r0 = 3 + (v * 37) % 35;
    const place = (t: number) => {
      const a = v + t * (0.3 + (v % 5) * 0.2);
      p.positionX.value = Math.cos(a) * r0;
      p.positionZ.value = Math.sin(a) * r0;
    };
    place(0);
    movers.push(place);
    if (useAir) s.connect(g).connect(air).connect(p).connect(master);
    else s.connect(g).connect(p).connect(master);
    p.connect(send);
    s.start(v * 0.01);
    nodes += 4;
  }
  const buildMs = performance.now() - tb;
  // emulate per-frame position updates (like the game calling setPos each frame) at 30 Hz
  if (moving) {
    for (let t = 1 / 30; t < seconds - 0.05; t += 1 / 30) {
      const tt = t;
      void ctx.suspend(tt).then(() => { for (const m of movers) m(tt); void ctx.resume(); });
    }
  }
  const tr = performance.now();
  await ctx.startRendering();
  const renderMs = performance.now() - tr;
  return { voices, seconds, nodes, buildMs: +buildMs.toFixed(1), renderMs: +renderMs.toFixed(1), cpuPct: +((renderMs / (seconds * 1000)) * 100).toFixed(2) };
}

// --- spectrogram drawing

function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k], ai = im[i + k];
        const br = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const bi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ar + br; im[i + k] = ai + bi;
        re[i + k + len / 2] = ar - br; im[i + k + len / 2] = ai - bi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

function heat(v: number): string {
  // v in 0..1 → dark blue → teal → yellow → white
  const stops = [[10, 12, 40], [30, 60, 140], [42, 157, 155], [246, 201, 76], [255, 250, 235]];
  const x = Math.max(0, Math.min(0.9999, v)) * (stops.length - 1);
  const i = Math.floor(x), f = x - i;
  const c = stops[i].map((a, k) => Math.round(a + (stops[i + 1][k] - a) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function drawSound(g: CanvasRenderingContext2D, b: AudioBuffer, x0: number, y0: number, w: number, h: number, title: string, st?: Stats): void {
  const x = b.getChannelData(0);
  const sr = b.sampleRate;
  g.fillStyle = "#fff";
  g.fillRect(x0, y0, w, h);
  const waveH = Math.round(h * 0.28), specH = h - waveH - 16;
  // waveform (min/max per column)
  g.fillStyle = "#2a9d9b";
  const per = x.length / w;
  for (let c = 0; c < w; c++) {
    let mn = 1, mx = -1;
    for (let i = Math.floor(c * per); i < Math.min(x.length, Math.floor((c + 1) * per)); i++) {
      if (x[i] < mn) mn = x[i];
      if (x[i] > mx) mx = x[i];
    }
    const cy = y0 + 16 + waveH / 2;
    g.fillRect(x0 + c, cy - (mx * waveH) / 2, 1, Math.max(1, ((mx - mn) * waveH) / 2));
  }
  g.strokeStyle = "rgba(200,0,0,.35)";
  g.beginPath();
  g.moveTo(x0, y0 + 16); g.lineTo(x0 + w, y0 + 16);
  g.moveTo(x0, y0 + 16 + waveH); g.lineTo(x0 + w, y0 + 16 + waveH);
  g.stroke();
  // spectrogram (log frequency 40 Hz – 20 kHz)
  const N = 1024;
  const re = new Float32Array(N), im = new Float32Array(N);
  const top = y0 + 16 + waveH;
  const fLo = 40, fHi = Math.min(20000, sr / 2);
  for (let c = 0; c < w; c++) {
    const start = Math.floor((c / w) * (x.length - N));
    for (let i = 0; i < N; i++) {
      const s = start + i;
      re[i] = (s >= 0 && s < x.length ? x[s] : 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
      im[i] = 0;
    }
    fft(re, im);
    for (let yy = 0; yy < specH; yy++) {
      const f = fLo * Math.pow(fHi / fLo, 1 - yy / specH);
      const bin = Math.min(N / 2 - 1, Math.round((f * N) / sr));
      const mag = Math.hypot(re[bin], im[bin]) / (N / 4);
      const d = 20 * Math.log10(mag + 1e-9);
      g.fillStyle = heat((d + 80) / 80);
      g.fillRect(x0 + c, top + yy, 1, 1);
    }
  }
  g.fillStyle = "#5a3a2a";
  g.font = "11px ui-rounded, system-ui";
  const info = st ? ` pk ${st.peakDb} · st ${st.stRmsDb} · rms ${st.rmsDb} dB · ${st.seconds.toFixed(2)}s` : "";
  g.fillText(title + info, x0 + 3, y0 + 12);
  g.fillStyle = "rgba(255,255,255,.7)";
  for (const f of [100, 1000, 10000]) {
    const yy = top + specH * (1 - Math.log(f / fLo) / Math.log(fHi / fLo));
    g.fillRect(x0, yy, 6, 1);
    g.fillText(f >= 1000 ? f / 1000 + "k" : String(f), x0 + 8, yy + 4);
  }
}

async function grid(names: string[], cols = 4, seconds?: number): Promise<Stats[]> {
  const cv = document.getElementById("shotGrid") as HTMLCanvasElement;
  cv.width = innerWidth;
  cv.height = innerHeight;
  cv.classList.add("show");
  const g = cv.getContext("2d")!;
  g.fillStyle = "#fdf6ea";
  g.fillRect(0, 0, cv.width, cv.height);
  const rows = Math.ceil(names.length / cols);
  const w = Math.floor(cv.width / cols), h = Math.floor(cv.height / rows);
  const out: Stats[] = [];
  for (let k = 0; k < names.length; k++) {
    const st = await render(names[k], seconds);
    out.push(st);
    drawSound(g, lastRender!, (k % cols) * w + 2, Math.floor(k / cols) * h + 2, w - 4, h - 4, names[k], st);
  }
  return out;
}

{
  const sec = el("section", { class: "wide" }, el("h2", {}, "Analysis (offline render)"));
  const sel = el("select", {});
  for (const n of [...SFX_NAMES, ...BED_NAMES.map((b) => "bed:" + b), "music:menu", "jingle:win", "jingle:lose"]) sel.append(el("option", { value: n }, n));
  const cv = el("canvas", { width: 1200, height: 260 });
  const out = el("div", {});
  sec.append(
    sel,
    el("button", {
      onclick: async () => {
        const st = await render(sel.value);
        drawSound(cv.getContext("2d")!, lastRender!, 0, 0, cv.width, cv.height, sel.value, st);
      },
    }, "analyse"),
    el("button", {
      onclick: async () => {
        const rows = await renderAll();
        const t = el("table", {}, el("tr", {}, ...["name", "sec", "peak dB", "st-RMS dB", "RMS dB", "tail dB", "ms"].map((h) => el("th", {}, h))));
        for (const r of rows) {
          t.append(el("tr", {}, el("td", {}, r.name), el("td", {}, r.seconds.toFixed(2)),
            el("td", { class: r.peakDb > -0.9 ? "bad" : "" }, String(r.peakDb)), el("td", {}, String(r.stRmsDb)),
            el("td", {}, String(r.rmsDb)), el("td", {}, String(r.tailDb)), el("td", {}, String(r.renderMs))));
        }
        out.replaceChildren(t);
      },
    }, "analyse all"),
    el("button", { onclick: async () => { out.textContent = JSON.stringify(await perf(20, "HRTF")); } }, "perf: beds + 20 HRTF voices"),
    cv, out,
  );
  app.append(sec);
}

window.__debug = {
  render, renderAll, seam, pan, perf, grid,
  hideGrid: () => document.getElementById("shotGrid")!.classList.remove("show"),
  stats: () => audio.stats(),
  /** RMS / mean / peak (dB) of a time region of the last offline render. */
  region: (a: number, b: number) => {
    const x = lastRender!.getChannelData(0);
    const i0 = Math.floor(a * lastRender!.sampleRate), i1 = Math.min(x.length, Math.floor(b * lastRender!.sampleRate));
    let s2 = 0, m = 0, p = 0;
    for (let i = i0; i < i1; i++) { s2 += x[i] * x[i]; m += x[i]; p = Math.max(p, Math.abs(x[i])); }
    const n = Math.max(1, i1 - i0);
    return { rmsDb: +db(Math.sqrt(s2 / n)).toFixed(1), mean: m / n, peakDb: +db(p).toFixed(1) };
  },
  /** dB magnitudes of the first `bins` FFT bins (1024-pt Hann) at time t of the last render. */
  spec: (t: number, bins = 8) => {
    const x = lastRender!.getChannelData(0);
    const N = 1024, re = new Float32Array(N), im = new Float32Array(N);
    const s0 = Math.floor(t * lastRender!.sampleRate);
    for (let i = 0; i < N; i++) re[i] = (x[s0 + i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
    fft(re, im);
    return Array.from({ length: bins }, (_, k) => +db(Math.hypot(re[k], im[k]) / (N / 4)).toFixed(1));
  },
  loadMs: 0,
  /** Live output level (dB RMS / peak over the last ~43 ms) from the real-time master bus. */
  meter: () => {
    meterNode ??= (() => {
      const a = audio.ctx.createAnalyser();
      a.fftSize = 2048;
      audio.debug.master.connect(a);
      return a;
    })();
    const buf = new Float32Array(meterNode.fftSize);
    meterNode.getFloatTimeDomainData(buf);
    let s2 = 0, p = 0;
    for (const v of buf) { s2 += v * v; p = Math.max(p, Math.abs(v)); }
    return { rmsDb: +db(Math.sqrt(s2 / buf.length)).toFixed(1), peakDb: +db(p).toFixed(1) };
  },
  reverbOn: () => audio.debug.reverbOn,
  audio,
};

void audio.fullyLoaded.then(() => {
  (window.__debug as Record<string, unknown>).loadMs = Math.round(performance.now() - t0);
  refreshStatus();
  window.__ready = true;
});
