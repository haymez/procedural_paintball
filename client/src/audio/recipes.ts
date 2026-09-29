// Sound-effect recipes: every SFX in the game is synthesised here into
// Float32Arrays (no audio files, no licences). Pure — runs in a worker/Node.
//
// Techniques: filtered-noise bursts with swept state-variable filters
// (splats, air, water), modal synthesis (wood/metal/stone knocks, bells,
// marimba/celesta blips), Minnaert-style rising-sine bubbles, granular
// grains (sand, hopper rattle, pebbles), stick-slip pulse trains through
// resonators (creaks), Karplus–Strong plucks, FM chirps (birds), formant-
// filtered noise (gasps, gulls).

import {
  Rng, TAU, adEnv, addInto, applyEnv, clamp, fadeEdges, lineEnv, mixTo, modal, mtof, osc, pluck,
  resonators, reverb, samples, saturate, scale, stereoize, svf, white, onePole, brown, periodic, periodicLfo,
  hashName as hash, normalize, peakOf, rmsOf, dbToGain, trimTail, type Chans,
} from "./dsp";

type Mono = Float32Array;

// ---------------------------------------------------------------- building blocks

/** Noise burst through a (possibly swept) filter with an attack/decay envelope. */
function burst(sr: number, rng: Rng, dur: number, mode: "lp" | "hp" | "bp", f: number | ((t: number) => number), q: number, attack: number, tau: number, delay = 0): Mono {
  const n = samples(sr, dur);
  const fc = typeof f === "number" ? f : (i: number) => f(i / sr - delay);
  return applyEnv(svf(white(n, rng), sr, mode, fc, q), adEnv(sr, attack, tau, delay));
}

/** Exponential sweep a→b with time constant tau (seconds). */
const sweep = (a: number, b: number, tau: number) => (t: number) => b + (a - b) * Math.exp(-Math.max(0, t) / tau);

/** Sine "thump" whose pitch drops f0→f1. */
function thump(sr: number, dur: number, f0: number, f1: number, tau: number, delay = 0, pitchTau = 0.03): Mono {
  const n = samples(sr, dur);
  const d = delay * sr;
  const s = sweep(f0, f1, pitchTau);
  const x = osc(n, sr, (i) => (i < d ? 0 : s((i - d) / sr)), "sine");
  return applyEnv(x, adEnv(sr, 0.001, tau, delay));
}

/** One bubble: sine with rising pitch (Minnaert resonance of a shrinking cavity). */
function bubble(sr: number, f0: number, life: number, rise = 1.6): Mono {
  const n = samples(sr, life * 4);
  const o = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f = f0 * (1 + rise * (1 - Math.exp(-t / life)));
    ph += f / sr;
    const env = Math.min(1, t / 0.0015) * Math.exp(-t / life);
    o[i] = Math.sin(TAU * ph) * env;
  }
  return o;
}

/** Scatter many bubbles over a window. */
function bubbles(sr: number, rng: Rng, n: number, count: number, t0: number, t1: number, fLo: number, fHi: number, amp: number, lifeLo = 0.01, lifeHi = 0.035, ascending = false, wrap = false): Mono {
  const o = new Float32Array(n);
  for (let k = 0; k < count; k++) {
    const u = ascending ? k / Math.max(1, count - 1) : rng.next();
    const t = t0 + (t1 - t0) * (ascending ? (k + rng.next() * 0.8) / count : rng.next());
    const f = ascending ? fLo * Math.pow(fHi / fLo, clamp(u + rng.bi() * 0.15, 0, 1)) : fLo * Math.pow(fHi / fLo, rng.next());
    const life = rng.range(lifeLo, lifeHi) * Math.sqrt(600 / f);
    addInto(o, bubble(sr, f, life, rng.range(1.0, 2.2)), t * sr, amp * rng.range(0.4, 1), wrap);
  }
  return o;
}

/** Tiny water droplets ("plip"): quick rising chirps, decaying in amplitude over time. */
function droplets(sr: number, rng: Rng, n: number, count: number, t0: number, t1: number, fLo: number, fHi: number, amp: number): Mono {
  const o = new Float32Array(n);
  for (let k = 0; k < count; k++) {
    const u = rng.next();
    const t = t0 + (t1 - t0) * u * u;
    const f = rng.range(fLo, fHi);
    addInto(o, bubble(sr, f, rng.range(0.004, 0.009), rng.range(0.6, 1.4)), t * sr, amp * (1 - 0.7 * u) * rng.range(0.4, 1));
  }
  return o;
}

/** Granular crunch: many micro noise grains through a bandpass. */
function grains(sr: number, rng: Rng, n: number, count: number, t0: number, t1: number, fLo: number, fHi: number, amp: number, grainDur = 0.002, shape = 1): Mono {
  const o = new Float32Array(n);
  for (let k = 0; k < count; k++) {
    const u = Math.pow(rng.next(), shape);
    const t = t0 + (t1 - t0) * u;
    const g = white(samples(sr, grainDur * rng.range(0.5, 1.6)), rng);
    const gs = svf(g, sr, "bp", rng.range(fLo, fHi), 2.5);
    applyEnv(gs, (i) => Math.sin((Math.PI * i) / gs.length));
    addInto(o, gs, t * sr, amp * rng.range(0.2, 1));
  }
  return o;
}

/** Wet squelch: noise bandpass swept downward with bubbly crackle AM. */
function squelch(sr: number, rng: Rng, dur: number, fStart: number, fEnd: number, sweepTau: number, q: number, attack: number, tau: number, delay = 0): Mono {
  const n = samples(sr, dur);
  const x = svf(white(n, rng), sr, "bp", (i) => sweep(fStart, fEnd, sweepTau)(i / sr - delay), q);
  // crackle: rectified low-passed noise gives an irregular "blubbing" amplitude
  const am = onePole(white(n, rng), sr, "lp", 90);
  let m = 0;
  for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(am[i]));
  const env = adEnv(sr, attack, tau, delay);
  for (let i = 0; i < n; i++) x[i] *= env(i) * (0.35 + 0.65 * Math.abs(am[i]) / (m || 1));
  return x;
}

/** Marimba-ish bar: modal partials 1 : 3.93 : 9.2. */
function marimba(sr: number, f: number, dur: number, decay = 0.25): Mono {
  return modal(samples(sr, dur), sr, [[f, decay, 1], [f * 3.93, decay * 0.3, 0.22], [f * 9.2, decay * 0.1, 0.06]]);
}

/** Celesta/glockenspiel-ish: nearly harmonic partials, longer ring. */
function celesta(sr: number, f: number, dur: number, decay = 0.6): Mono {
  return modal(samples(sr, dur), sr, [[f, decay, 1], [f * 2.0, decay * 0.45, 0.28], [f * 3.01, decay * 0.25, 0.12], [f * 4.2, decay * 0.15, 0.05]]);
}

/** Pea whistle (referee): high sine with pea-rattle FM/AM plus breath noise. */
function peaWhistle(sr: number, rng: Rng, n: number, segs: readonly (readonly [number, number])[], f0 = 2850): Mono {
  const env = (t: number) => {
    let v = 0;
    for (const [a, d] of segs) {
      if (t >= a && t < a + d) v = Math.max(v, Math.min(1, (t - a) / 0.015, (a + d - t) / 0.03));
    }
    return v;
  };
  const rattle = 38 + rng.range(-4, 4);
  const o = new Float32Array(n);
  let ph = 0;
  const br = svf(white(n, rng), sr, "bp", f0, 6);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const r = Math.sin(TAU * rattle * t + 0.8 * Math.sin(TAU * 7 * t));
    const f = f0 * (1 + 0.035 * r) * (1 + 0.02 * Math.min(1, t * 8));
    ph += f / sr;
    const e = env(t);
    o[i] = e * ((Math.sin(TAU * ph) + 0.18 * Math.sin(2 * TAU * ph)) * (0.72 + 0.28 * r) + br[i] * 0.5);
  }
  return o;
}

/** Stick-slip friction: irregular pulse train through resonators (creaks, oarlocks). */
function creak(sr: number, rng: Rng, dur: number, rateLo: number, rateHi: number, modes: readonly (readonly [number, number, number])[], envPts: readonly (readonly [number, number])[]): Mono {
  const n = samples(sr, dur);
  const x = new Float32Array(n);
  let t = 0, rate = rng.range(rateLo, rateHi);
  while (t < dur) {
    const i = Math.floor(t * sr);
    x[i] += rng.range(0.5, 1);
    if (i + 1 < n) x[i + 1] -= 0.5;
    rate = clamp(rate + rng.bi() * (rateHi - rateLo) * 0.12, rateLo, rateHi);
    t += 1 / rate;
  }
  const y = resonators(x, sr, modes);
  return applyEnv(y, lineEnv(sr, envPts));
}

// ---------------------------------------------------------------- recipes

export type Category = "world" | "self" | "ui" | "amb";

export interface SfxDef {
  cat: Category;
  /** Number of pre-rendered random variants. */
  variants?: number;
  /** Loudest-50ms RMS target in dBFS. */
  target: number;
  /** Default playback volume. */
  vol?: number;
  /** Default ± semitone jitter. */
  pj?: number;
  /** Max simultaneous voices of this sound. */
  max?: number;
  /** PannerNode refDistance (m) / rolloffFactor / cull distance. */
  ref?: number;
  rolloff?: number;
  maxDist?: number;
  loop?: boolean;
  render: (sr: number, rng: Rng, v: number) => Mono | Chans;
}

// --- marker

function shoot(sr: number, rng: Rng): Mono {
  const dur = 0.4, n = samples(sr, dur);
  const click = burst(sr, rng, dur, "hp", 3500, 0.7, 0.0002, 0.0012);
  const air = burst(sr, rng, dur, "bp", sweep(rng.range(2600, 3200), 700, 0.03), 0.9, 0.0008, 0.03);
  const pop = burst(sr, rng, dur, "bp", (t) => 330 + 800 * clamp(t / 0.05, 0, 1) ** 0.7, 5, 0.002, 0.028);
  const body = thump(sr, dur, rng.range(150, 175), 55, 0.045);
  const hiss = burst(sr, rng, dur, "hp", 5000, 0.7, 0.012, 0.08);
  const bolt = modal(n, sr, [[rng.range(1700, 1900), 0.03, 0.4], [rng.range(3000, 3300), 0.02, 0.25]]);
  const boltD = new Float32Array(n);
  addInto(boltD, bolt, rng.range(0.045, 0.06) * sr);
  const x = mixTo(n, [click, 0.7], [air, 1.0], [pop, 1.9], [body, 0.6], [hiss, 0.12], [boltD, 0.25]);
  return saturate(x, 1.4);
}

function shootEmpty(sr: number, rng: Rng): Mono {
  const n = samples(sr, 0.18);
  const c1 = modal(n, sr, [[rng.range(2500, 2800), 0.02, 1], [rng.range(4000, 4400), 0.012, 0.6], [1500, 0.03, 0.4]]);
  const c2 = modal(n, sr, [[rng.range(1600, 1800), 0.025, 0.8], [3100, 0.015, 0.5]]);
  const o = new Float32Array(n);
  addInto(o, onePole(c1, sr, "hp", 600), 0);
  addInto(o, onePole(c2, sr, "hp", 500), rng.range(0.03, 0.045) * sr, 0.8);
  addInto(o, burst(sr, rng, 0.18, "bp", 1500, 1, 0.002, 0.012), 0, 0.15);
  return o;
}

function reload(sr: number, rng: Rng): Mono {
  const dur = 0.8, n = samples(sr, dur);
  const o = new Float32Array(n);
  // balls tumbling into the feed neck
  const count = rng.int(20, 28);
  for (let k = 0; k < count; k++) {
    const u = rng.next();
    const t = 0.03 + 0.48 * (0.5 - 0.5 * Math.cos(Math.PI * u)) + rng.range(-0.01, 0.01);
    const f = rng.range(1800, 4300);
    const tick = modal(samples(sr, 0.04), sr, [[f, 0.012, 1], [f * 1.73, 0.007, 0.5]], rng);
    addInto(o, tick, t * sr, rng.range(0.25, 1) * Math.sin(Math.PI * clamp(u * 1.1, 0, 1)) + 0.15);
  }
  // shuffling shake underneath
  const shake = svf(white(n, rng), sr, "bp", 2600, 1.1);
  const am = onePole(white(n, rng), sr, "lp", 30);
  const shEnv = lineEnv(sr, [[0, 0], [0.05, 1], [0.45, 0.8], [0.55, 0]]);
  for (let i = 0; i < n; i++) shake[i] *= shEnv(i) * Math.abs(am[i]) * 4;
  addInto(o, shake, 0, 0.35);
  // lid snaps shut
  const lidT = rng.range(0.6, 0.64);
  const lid = modal(samples(sr, 0.15), sr, [[rng.range(850, 950), 0.05, 1], [2300, 0.03, 0.6], [1450, 0.04, 0.5], [4200, 0.01, 0.3]]);
  addInto(o, lid, lidT * sr, 0.9);
  addInto(o, thump(sr, 0.1, 180, 90, 0.02), lidT * sr, 0.5);
  return o;
}

function whiz(sr: number, rng: Rng): Mono {
  const dur = 0.45, n = samples(sr, dur);
  const mid = rng.range(0.18, 0.22), w = rng.range(0.055, 0.075);
  const hi = rng.range(2300, 2800), lo = rng.range(900, 1200);
  const fc = (t: number) => lo + (hi - lo) * (0.5 - 0.5 * Math.tanh((t - mid) / 0.035));
  const nz = svf(white(n, rng), sr, "bp", (i) => fc(i / sr), 2.8);
  const tone = osc(n, sr, (i) => fc(i / sr) * 0.55, "sine");
  const air = svf(white(n, rng), sr, "hp", 3500, 0.7);
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const e = Math.exp(-(((t - mid) / w) ** 2));
    o[i] = e * (nz[i] + tone[i] * 0.18 + air[i] * 0.15);
  }
  return o;
}

interface SplatOpts {
  size: number;
  bright: number;
  wet: number;
  thud: number;
  surface: "ground" | "wood" | "stone" | "water" | "player" | "self";
}

function splat(sr: number, rng: Rng, o: SplatOpts): Mono {
  const dur = 0.35 + 0.5 * o.size, n = samples(sr, dur);
  const s = o.size;
  const x = new Float32Array(n);
  const water = o.surface === "water";
  if (!water) {
    addInto(x, burst(sr, rng, dur, "lp", 2500 + 6500 * o.bright, 0.7, 0.0004, 0.005 + 0.008 * s), 0, 1.0);
    addInto(x, burst(sr, rng, dur, "bp", rng.range(900, 1400), 0.8, 0.001, 0.018 * s), 0, 0.7);
  }
  // the wet squish
  const sq = water ? 0.5 : 1;
  addInto(x, squelch(sr, rng, dur, rng.range(1800, 2600) * (0.7 + 0.3 * o.bright), rng.range(350, 500), 0.05 * s, 2.2, 0.003, 0.045 * s * o.wet), 0, 1.1 * sq);
  if (o.surface === "player" || o.surface === "self") {
    // blob body wobble + second squish
    const wob = osc(n, sr, (i) => rng.range(160, 190) * (1 + 0.12 * Math.sin((TAU * 22 * i) / sr)), "sine");
    applyEnv(wob, adEnv(sr, 0.004, 0.06 * s));
    addInto(x, wob, 0, 0.55);
    addInto(x, squelch(sr, rng, dur, 1400, 280, 0.06, 2.5, 0.01, 0.05 * s, 0.05), 0, 0.6);
  }
  if (o.thud > 0) addInto(x, thump(sr, dur, 120, 55, 0.04 * s), 0, o.thud);
  if (o.surface === "wood") {
    addInto(x, modal(n, sr, [[rng.range(210, 260), 0.14, 0.9], [rng.range(540, 640), 0.09, 0.6], [rng.range(1100, 1400), 0.05, 0.35], [rng.range(2300, 2700), 0.025, 0.15]], rng), 0, 0.45);
  }
  if (o.surface === "stone") {
    addInto(x, modal(n, sr, [[rng.range(2300, 2800), 0.02, 1], [rng.range(4000, 4600), 0.012, 0.6], [rng.range(1200, 1500), 0.03, 0.4]], rng), 0, 0.35);
  }
  if (water) {
    addInto(x, bubble(sr, rng.range(500, 800), 0.03, 1.8), 0.004 * sr, 1.2);
    addInto(x, burst(sr, rng, dur, "hp", 1200, 0.7, 0.002, 0.07), 0, 0.5);
    addInto(x, bubbles(sr, rng, n, 5, 0.03, 0.2, 500, 1400, 0.35), 0, 1);
  }
  const drops = Math.round((water ? 6 : 8) * o.wet * (o.surface === "stone" ? 1.5 : 1) * (0.7 + 0.3 * s));
  addInto(x, droplets(sr, rng, n, drops, 0.02, 0.12 + 0.3 * s, 900, 3200 * (0.6 + 0.4 * o.bright), 0.3), 0, 1);
  return x;
}

function hitMe(sr: number, rng: Rng): Chans {
  const x = splat(sr, rng, { size: 1.3, bright: 0.8, wet: 1.3, thud: 0.9, surface: "self" });
  // cold shiver: fizzing high noise, like paint running down
  const n = x.length;
  const fizz = svf(white(n, rng), sr, "hp", 4500, 0.7);
  for (let i = 0; i < n; i++) fizz[i] *= Math.max(0, Math.sin((TAU * 28 * i) / sr)) * adEnv(sr, 0.06, 0.12, 0.04)(i);
  addInto(x, fizz, 0, 0.18);
  return stereoize(x, sr, 0.45, rng.int(1, 999));
}

function eliminate(sr: number, rng: Rng): Mono {
  const dur = 1.5, n = samples(sr, dur);
  const x = new Float32Array(n);
  addInto(x, splat(sr, rng, { size: 1.8, bright: 0.7, wet: 1.6, thud: 1.2, surface: "player" }), 0, 1);
  addInto(x, squelch(sr, rng, dur, 1200, 250, 0.08, 3, 0.01, 0.06, 0.12), 0, 0.8);
  // big bubbly pop
  addInto(x, bubble(sr, rng.range(200, 240), 0.06, 3), 0.16 * sr, 1.4);
  addInto(x, bubbles(sr, rng, n, 12, 0.24, 1.0, 450, 1700, 0.55, 0.012, 0.035, true), 0, 1);
  addInto(x, droplets(sr, rng, n, 14, 0.05, 0.9, 900, 2800, 0.35), 0, 1);
  return x;
}

function respawn(sr: number, rng: Rng): Mono {
  const dur = 1.1, n = samples(sr, dur);
  const x = new Float32Array(n);
  const bl = osc(n, sr, (i) => {
    const t = i / sr;
    return (280 + 900 * clamp(t / 0.16, 0, 1) ** 1.5) * (1 + 0.04 * Math.sin(TAU * 14 * t));
  }, "sine");
  applyEnv(bl, adEnv(sr, 0.01, 0.08));
  addInto(x, bl, 0, 0.9);
  addInto(x, bubbles(sr, rng, n, 9, 0.08, 0.55, 500, 1800, 0.5, 0.01, 0.03, true), 0, 1);
  const notes = [84, 88, 91, 93]; // C6 E6 G6 A6
  notes.forEach((m, k) => addInto(x, celesta(sr, mtof(m), 0.8, 0.35), (0.12 + k * 0.07) * sr, 0.28));
  return x;
}

// --- movement

type Surface = "sand" | "grass" | "stone" | "wood" | "water";

function step(sr: number, rng: Rng, s: Surface): Mono {
  const dur = 0.3, n = samples(sr, dur);
  const x = new Float32Array(n);
  // the blob "pomf": a soft squishy foot (kept low so the surface texture reads)
  addInto(x, thump(sr, dur, rng.range(170, 210), 100, 0.02, 0, 0.015), 0, s === "water" ? 0.15 : 0.25);
  addInto(x, burst(sr, rng, dur, "lp", 600, 0.7, 0.002, 0.018), 0, 0.2);
  switch (s) {
    case "sand":
      addInto(x, grains(sr, rng, n, rng.int(50, 70), 0.004, 0.11, 1500, 4500, 1.0, 0.003, 1.6), 0, 1);
      addInto(x, burst(sr, rng, dur, "bp", rng.range(2000, 2600), 0.8, 0.006, 0.04), 0, 0.5);
      break;
    case "grass":
      addInto(x, burst(sr, rng, dur, "hp", rng.range(2200, 3000), 0.6, 0.008, 0.06), 0, 1.0);
      addInto(x, burst(sr, rng, dur, "bp", 1200, 0.8, 0.004, 0.03), 0, 0.3);
      addInto(x, grains(sr, rng, n, 14, 0.005, 0.09, 2500, 6000, 0.6, 0.0015), 0, 1);
      break;
    case "stone":
      addInto(x, burst(sr, rng, dur, "bp", rng.range(1600, 2100), 1.2, 0.0005, 0.012), 0, 1.0);
      addInto(x, burst(sr, rng, dur, "hp", 4000, 0.7, 0.0003, 0.002), 0, 0.5);
      addInto(x, modal(n, sr, [[rng.range(550, 700), 0.04, 0.5], [rng.range(1300, 1600), 0.025, 0.35]], rng), 0, 0.4);
      addInto(x, grains(sr, rng, n, 8, 0.0, 0.035, 3000, 6000, 0.5), 0, 1);
      break;
    case "wood": {
      const knock = modal(n, sr, [[rng.range(220, 260), 0.1, 1], [rng.range(520, 600), 0.07, 0.7], [rng.range(1100, 1300), 0.05, 0.4], [rng.range(2300, 2600), 0.025, 0.25]], rng);
      addInto(x, svf(knock, sr, "lp", 5000, 0.7), 0, 0.9);
      addInto(x, burst(sr, rng, dur, "bp", 1500, 1, 0.0005, 0.006), 0, 0.6);
      break;
    }
    case "water":
      addInto(x, burst(sr, rng, dur, "bp", rng.range(1200, 2000), 0.8, 0.005, 0.07), 0, 1.0);
      addInto(x, bubble(sr, rng.range(450, 650), 0.03, 1.5), 0.01 * sr, 0.6);
      addInto(x, droplets(sr, rng, n, 4, 0.04, 0.2, 1200, 2800, 0.35), 0, 1);
      addInto(x, burst(sr, rng, dur, "lp", 500, 0.7, 0.01, 0.06), 0, 0.35);
      break;
  }
  return x;
}

function jump(sr: number, rng: Rng): Mono {
  const dur = 0.35, n = samples(sr, dur);
  const f0 = rng.range(160, 190);
  const tone = osc(n, sr, (i) => {
    const t = i / sr;
    return f0 * (1 + 1.5 * (1 - Math.exp(-t / 0.05))) * (1 + 0.06 * Math.exp(-t / 0.1) * Math.sin(TAU * 16 * t));
  }, "sine");
  applyEnv(tone, adEnv(sr, 0.004, 0.045));
  const whoosh = burst(sr, rng, dur, "bp", (t) => 500 + 1600 * clamp(t / 0.12, 0, 1), 1.2, 0.02, 0.05);
  return mixTo(n, [tone, 0.7], [whoosh, 0.5], [squelch(sr, rng, dur, 1500, 600, 0.03, 2, 0.002, 0.025), 0.6]);
}

function land(sr: number, rng: Rng): Mono {
  const dur = 0.4, n = samples(sr, dur);
  const th = thump(sr, dur, rng.range(110, 130), 50, 0.05);
  const sq = squelch(sr, rng, dur, 1500, 450, 0.05, 2, 0.002, 0.06);
  for (let i = 0; i < n; i++) sq[i] *= 0.7 + 0.3 * Math.sin((TAU * 22 * i) / sr);
  const nz = burst(sr, rng, dur, "lp", 1200, 0.7, 0.001, 0.03);
  return mixTo(n, [th, 0.7], [sq, 1.3], [nz, 0.5]);
}

function slide(sr: number, rng: Rng): Mono {
  const dur = 0.85, n = samples(sr, dur);
  const body = svf(white(n, rng), sr, "bp", (i) => 1300 - 600 * (i / n), 0.7);
  const grit = svf(white(n, rng), sr, "hp", 2800, 0.7);
  const am = onePole(white(n, rng), sr, "lp", 12);
  let m = 0;
  for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(am[i]));
  const env = lineEnv(sr, [[0, 0], [0.06, 1], [0.5, 0.8], [0.84, 0]]);
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) o[i] = env(i) * (0.6 + 0.4 * am[i] / (m || 1)) * (body[i] + grit[i] * 0.3);
  addInto(o, grains(sr, rng, n, 30, 0.03, 0.7, 2500, 6000, 0.35), 0, 1);
  return o;
}

function mantle(sr: number, rng: Rng): Mono {
  const dur = 0.3, n = samples(sr, dur);
  const bw = osc(n, sr, (i) => 200 + 140 * clamp(i / sr / 0.06, 0, 1), "sine");
  applyEnv(bw, adEnv(sr, 0.005, 0.035));
  return mixTo(n, [bw, 0.5], [squelch(sr, rng, dur, 1200, 500, 0.04, 2, 0.003, 0.04), 0.7], [burst(sr, rng, dur, "hp", 2500, 0.7, 0.01, 0.04), 0.25]);
}

function bigSplash(sr: number, rng: Rng, size: number): Mono {
  const dur = 0.6 + 1.1 * size, n = samples(sr, dur);
  const x = new Float32Array(n);
  addInto(x, burst(sr, rng, dur, "lp", 7000, 0.7, 0.0005, 0.018 * size), 0, 1.1);
  addInto(x, burst(sr, rng, dur, "bp", sweep(1900, 800, 0.2), 0.6, 0.01, 0.25 * size), 0, 0.9);
  addInto(x, thump(sr, dur, 110, 55, 0.08 * size), 0, 0.8 * size);
  // cavity "bloomp"
  const bl = osc(n, sr, (i) => 170 + 260 * clamp((i / sr - 0.07) / 0.1, 0, 1), "sine");
  applyEnv(bl, adEnv(sr, 0.01, 0.07, 0.07));
  addInto(x, bl, 0, 0.6 * size);
  addInto(x, droplets(sr, rng, n, Math.round(30 * size), 0.12, 0.2 + 0.9 * size, 700, 2600, 0.4), 0, 1);
  addInto(x, burst(sr, rng, dur, "hp", 3000, 0.7, 0.1, 0.25 * size, 0.1), 0, 0.2);
  return x;
}

/** Sky-drop landing: a soft pancake "splort", then a rubbery boing as the blob pops back up. */
function skySplat(sr: number, rng: Rng): Mono {
  const dur = 1.2, n = samples(sr, dur);
  const x = new Float32Array(n);
  // the pancake: a low squishy thud and a wet flappy squelch
  addInto(x, thump(sr, dur, rng.range(95, 115), 45, 0.09), 0, 1.1);
  const sq = squelch(sr, rng, dur, 1700, 320, 0.06, 2.4, 0.002, 0.09);
  for (let i = 0; i < n; i++) sq[i] *= 0.65 + 0.35 * Math.sin((TAU * 26 * i) / sr);
  addInto(x, sq, 0, 1.2);
  addInto(x, burst(sr, rng, dur, "lp", 900, 0.7, 0.002, 0.05), 0, 0.5);
  // ...the boing: a springy sine that wobbles up and settles (0.42 s later: SPLAT_TIME)
  const t0 = 0.4, f0 = rng.range(150, 175);
  const boing = osc(n, sr, (i) => {
    const t = Math.max(0, i / sr - t0);
    return f0 * (1 + 1.2 * (1 - Math.exp(-t / 0.06))) * (1 + 0.12 * Math.exp(-t / 0.18) * Math.sin(TAU * 13 * t));
  }, "sine");
  applyEnv(boing, adEnv(sr, 0.008, 0.16, t0));
  addInto(x, boing, 0, 0.75);
  addInto(x, bubbles(sr, rng, n, 4, t0, t0 + 0.2, 600, 1400, 0.35, 0.01, 0.025, true), 0, 1);
  return x;
}

/** Wind rushing past a gliding blob, with the skin flaps fluttering (loop). */
function skyWind(sr: number, rng: Rng): Mono {
  const n = samples(sr, 4);
  const gust = periodicLfo(n, rng, 1, 5);
  const rush = periodic(brown(n, rng), (t) => svf(t, sr, "lp", 900, 0.7));
  const hiss = periodic(white(n, rng), (t) => svf(t, sr, "bp", 2400, 0.8));
  const flap = 17; // Hz, integer cycles per loop
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const g = 0.6 + 0.4 * gust(i);
    const f = 0.75 + 0.25 * Math.sin((TAU * flap * i) / sr);
    o[i] = rush[i] * g * 1.4 + hiss[i] * g * f * 0.35;
  }
  return o;
}

function swimStroke(sr: number, rng: Rng): Mono {
  const dur = 0.7, n = samples(sr, dur);
  const sw = svf(white(n, rng), sr, "bp", (i) => 500 + 900 * clamp(i / sr / 0.3, 0, 1), 1);
  applyEnv(sw, lineEnv(sr, [[0, 0], [0.12, 1], [0.35, 0.4], [0.65, 0]]));
  const o = mixTo(n, [sw, 1]);
  addInto(o, bubbles(sr, rng, n, 3, 0.05, 0.3, 250, 550, 0.4, 0.02, 0.04), 0, 1);
  addInto(o, droplets(sr, rng, n, 4, 0.2, 0.55, 1200, 2600, 0.3), 0, 1);
  return o;
}

function dive(sr: number, rng: Rng): Mono {
  const dur = 1.3, n = samples(sr, dur);
  const x = new Float32Array(n);
  addInto(x, burst(sr, rng, dur, "lp", 6000, 0.7, 0.0008, 0.02), 0, 0.9);
  addInto(x, burst(sr, rng, dur, "bp", 1400, 0.7, 0.004, 0.06), 0, 0.6);
  const bl = osc(n, sr, (i) => sweep(170, 70, 0.1)(i / sr - 0.03), "sine");
  applyEnv(bl, adEnv(sr, 0.01, 0.12, 0.03));
  addInto(x, bl, 0, 0.9);
  const rush = svf(brown(n, rng), sr, "lp", 700, 0.7);
  applyEnv(rush, adEnv(sr, 0.05, 0.35, 0.05));
  addInto(x, rush, 0, 0.9);
  addInto(x, svf(bubbles(sr, rng, n, 16, 0.08, 1.0, 280, 1000, 0.6, 0.015, 0.04, true), sr, "lp", 1600, 0.7), 0, 1);
  return x;
}

function surfaceGasp(sr: number, rng: Rng): Mono {
  const dur = 1.0, n = samples(sr, dur);
  const x = new Float32Array(n);
  addInto(x, burst(sr, rng, dur, "bp", 1500, 0.8, 0.003, 0.05), 0, 0.6);
  addInto(x, droplets(sr, rng, n, 6, 0.02, 0.5, 1000, 2600, 0.3), 0, 1);
  // "haah!" inhale: formant-filtered breath + a little voiced squeak
  const f1 = rng.range(750, 850), f2 = rng.range(1150, 1300);
  const breath = resonators(white(n, rng), sr, [[f1, 5, 1], [f2, 6, 0.7], [2600, 7, 0.35]]);
  const inh = lineEnv(sr, [[0, 0], [0.05, 0], [0.1, 1], [0.32, 0.65], [0.48, 0]]);
  const voiced = resonators(osc(n, sr, (i) => 380 + 90 * clamp(i / sr / 0.2, 0, 1), "saw"), sr, [[f1, 5, 1], [f2, 6, 0.7]]);
  const vEnv = lineEnv(sr, [[0, 0], [0.06, 0], [0.1, 1], [0.22, 0.4], [0.3, 0]]);
  const exh = lineEnv(sr, [[0, 0], [0.55, 0], [0.62, 0.35], [0.9, 0]]);
  for (let i = 0; i < n; i++) x[i] += breath[i] * (inh(i) + exh(i)) * 1.0 + voiced[i] * vEnv(i) * 0.12;
  return x;
}

function bubbleBurst(sr: number, rng: Rng): Mono {
  const n = samples(sr, 0.9);
  return bubbles(sr, rng, n, rng.int(10, 15), 0, 0.6, 350, 1400, 0.7);
}

function washoff(sr: number, rng: Rng): Mono {
  const dur = 1.2, n = samples(sr, dur);
  const x = new Float32Array(n);
  const penta = [0, 2, 4, 7, 9];
  for (let k = 0; k < 14; k++) {
    const t = 0.05 + (k / 14) * 0.65 + rng.range(-0.02, 0.02);
    const m = 88 + penta[rng.int(0, 4)] + 12 * Math.floor(k / 7) - 12 * rng.int(0, 1);
    addInto(x, celesta(sr, mtof(m), 0.5, 0.18), t * sr, 0.25 * rng.range(0.5, 1));
  }
  const sw = svf(white(n, rng), sr, "bp", (i) => 3000 + 3000 * (i / n), 4);
  applyEnv(sw, lineEnv(sr, [[0, 0], [0.2, 1], [0.8, 0.5], [1.15, 0]]));
  addInto(x, sw, 0, 0.35);
  addInto(x, bubbles(sr, rng, n, 6, 0, 0.5, 500, 1300, 0.4), 0, 1);
  return x;
}

function heartbeat(sr: number, rng: Rng): Mono {
  const dur = 0.5, n = samples(sr, dur);
  const x = new Float32Array(n);
  addInto(x, thump(sr, dur, 70, 48, 0.07, 0, 0.04), 0, 1);
  addInto(x, burst(sr, rng, dur, "lp", 160, 0.7, 0.005, 0.04), 0, 0.5);
  addInto(x, thump(sr, dur, 62, 44, 0.06, 0, 0.04), 0.17 * sr, 0.75);
  return saturate(x, 2.2);
}

// --- pickups

function pickupAmmo(sr: number, rng: Rng): Mono {
  const dur = 0.5, n = samples(sr, dur);
  const x = new Float32Array(n);
  for (let k = 0; k < 7; k++) {
    const f = rng.range(2000, 4000);
    addInto(x, modal(samples(sr, 0.04), sr, [[f, 0.012, 1], [f * 1.7, 0.007, 0.5]]), rng.range(0, 0.1) * sr, rng.range(0.3, 0.7));
  }
  addInto(x, modal(n, sr, [[620, 0.06, 1], [1500, 0.03, 0.4]]), 0, 0.5);
  addInto(x, marimba(sr, mtof(76), dur, 0.12), 0.04 * sr, 0.7);
  addInto(x, marimba(sr, mtof(81), dur, 0.18), 0.11 * sr, 0.8);
  return x;
}

function pickupUpgrade(sr: number, rng: Rng): Mono {
  const dur = 1.3, n = samples(sr, dur);
  const x = new Float32Array(n);
  [84, 88, 91, 96].forEach((m, k) => addInto(x, celesta(sr, mtof(m), 1.0, 0.45 + 0.15 * k), k * 0.065 * sr, 0.55));
  addInto(x, marimba(sr, mtof(72), dur, 0.3), 0, 0.5);
  for (let k = 0; k < 5; k++) addInto(x, celesta(sr, mtof(rng.pick([100, 103, 105, 108])), 0.4, 0.12), rng.range(0.25, 0.6) * sr, 0.12);
  const sh = burst(sr, rng, dur, "hp", 7000, 0.7, 0.15, 0.2, 0.15);
  addInto(x, sh, 0, 0.08);
  return reverb(x, sr, { size: 0.5, damp: 0.5, wet: 0.35, tail: 0 });
}

// --- vehicles

function vespaHorn(sr: number, rng: Rng): Mono {
  const dur = 0.55, n = samples(sr, dur);
  const f0 = rng.range(415, 445);
  const env = (t: number) => {
    const b = (a: number, d: number) => (t >= a && t < a + d ? Math.min(1, (t - a) / 0.006, (a + d - t) / 0.012) : 0);
    return Math.max(b(0, 0.13), b(0.2, 0.2));
  };
  const src = osc(n, sr, (i) => f0 * (1 - 0.03 * Math.exp(-((i / sr) % 0.2) / 0.01)), "square");
  const buzz = resonators(src, sr, [[f0 * 2, 4, 1], [2400, 3, 0.7], [3500, 4, 0.35]]);
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) o[i] = (buzz[i] + src[i] * 0.25) * env(i / sr);
  return saturate(o, 1.8);
}

function rowStroke(sr: number, rng: Rng): Mono {
  const dur = 1.0, n = samples(sr, dur);
  const x = new Float32Array(n);
  addInto(x, creak(sr, rng, 0.16, 90, 150, [[rng.range(480, 560), 6, 1], [1100, 6, 0.6], [2200, 6, 0.3]], [[0, 0], [0.02, 1], [0.12, 0.6], [0.16, 0]]), 0, 0.5);
  addInto(x, bubble(sr, rng.range(320, 420), 0.03, 1.5), 0.1 * sr, 0.7);
  const sw = svf(white(n, rng), sr, "bp", (i) => 400 + 600 * clamp((i / sr - 0.1) / 0.35, 0, 1), 1.2);
  applyEnv(sw, lineEnv(sr, [[0, 0], [0.08, 0], [0.2, 1], [0.55, 0.3], [0.85, 0]]));
  addInto(x, sw, 0, 0.9);
  addInto(x, droplets(sr, rng, n, 6, 0.55, 0.95, 1000, 2400, 0.35), 0, 1);
  return x;
}

function ziplineAttach(sr: number, rng: Rng): Mono {
  const n = samples(sr, 0.6);
  const f = rng.range(580, 660);
  const x = modal(n, sr, [[f, 0.3, 1], [f * 2.76, 0.18, 0.5], [f * 5.4, 0.09, 0.3], [f * 8.93, 0.05, 0.2]]);
  addInto(x, burst(sr, rng, 0.6, "hp", 3000, 0.7, 0.0003, 0.004), 0, 0.6);
  return x;
}

// --- UI

function uiClick(sr: number, rng: Rng): Mono {
  const n = samples(sr, 0.12);
  const x = modal(n, sr, [[rng.range(1000, 1100), 0.04, 1], [2500, 0.02, 0.3]]);
  addInto(x, burst(sr, rng, 0.12, "hp", 4000, 0.7, 0.0002, 0.001), 0, 0.3);
  return x;
}
function uiHover(sr: number): Mono {
  const n = samples(sr, 0.09);
  return applyEnv(osc(n, sr, (i) => 1600 + 200 * (i / n), "sine"), adEnv(sr, 0.004, 0.018));
}
function twoNotes(sr: number, a: number, b: number): Mono {
  const n = samples(sr, 0.45);
  const x = new Float32Array(n);
  addInto(x, marimba(sr, mtof(a), 0.45, 0.14), 0, 0.8);
  addInto(x, marimba(sr, mtof(b), 0.45, 0.2), 0.07 * sr, 0.9);
  return x;
}
function woodblock(sr: number, rng: Rng, f = 880): Mono {
  const n = samples(sr, 0.25);
  const x = modal(n, sr, [[f, 0.06, 1], [f * 2.5, 0.03, 0.4], [f * 4.1, 0.02, 0.15]]);
  addInto(x, burst(sr, rng, 0.25, "hp", 3000, 0.7, 0.0002, 0.0015), 0, 0.3);
  return x;
}
function countdownGo(sr: number, rng: Rng): Mono {
  const n = samples(sr, 0.9);
  const x = celesta(sr, mtof(88), 0.9, 0.5);
  addInto(x, celesta(sr, mtof(100), 0.9, 0.35), 0, 0.3);
  addInto(x, woodblock(sr, rng, 1320), 0, 0.5);
  return mixTo(n, [x, 1]);
}
function strum(sr: number, rng: Rng, midis: number[], dur: number, spread = 0.018, bright = 0.8): Mono {
  const n = samples(sr, dur);
  const x = new Float32Array(n);
  midis.forEach((m, k) => addInto(x, pluck(sr, mtof(m), dur, rng, { t60: 1.4, bright, pick: 0.14 }), k * spread * sr, 0.6));
  return x;
}
function matchStart(sr: number, rng: Rng): Mono {
  const dur = 1.6, n = samples(sr, dur);
  const x = peaWhistle(sr, rng, n, [[0, 0.32]]);
  addInto(x, strum(sr, rng, [55, 59, 62, 67, 71], 1.4), 0.35 * sr, 0.9);
  addInto(x, strum(sr, rng, [55, 59, 62, 67, 71], 1.2, 0.012), 0.62 * sr, 0.7);
  return x;
}
function matchEnd(sr: number, rng: Rng): Mono {
  const dur = 1.8, n = samples(sr, dur);
  return peaWhistle(sr, rng, n, [[0, 0.16], [0.24, 0.16], [0.5, 1.1]]);
}
function killfeed(sr: number): Mono {
  const x = marimba(sr, mtof(81), 0.2, 0.05);
  addInto(x, marimba(sr, mtof(86), 0.2, 0.06), 0.045 * sr, 0.7);
  return x;
}
function hitmarker(sr: number, rng: Rng): Mono {
  const n = samples(sr, 0.09);
  const x = modal(n, sr, [[rng.range(3300, 3500), 0.03, 1], [5200, 0.02, 0.5]]);
  addInto(x, burst(sr, rng, 0.09, "hp", 5000, 0.7, 0.0002, 0.001), 0, 0.3);
  return x;
}
function hitmarkerKill(sr: number, rng: Rng): Mono {
  const n = samples(sr, 0.4);
  const x = new Float32Array(n);
  addInto(x, hitmarker(sr, rng), 0, 1);
  addInto(x, modal(samples(sr, 0.09), sr, [[4400, 0.03, 1], [6600, 0.02, 0.5]]), 0.06 * sr, 1);
  addInto(x, bubble(sr, 650, 0.04, 1.6), 0.1 * sr, 0.9);
  return x;
}

// --- ambient one-shots (triggered by the ambience manager at random positions)

function birdWhistle(sr: number, rng: Rng): Mono {
  const notes = rng.int(2, 4);
  const dur = notes * 0.35 + 0.2, n = samples(sr, dur);
  const x = new Float32Array(n);
  let t = 0.02;
  const up = rng.chance(0.5);
  const base = rng.range(1500, 2300);
  for (let k = 0; k < notes; k++) {
    const d = rng.range(0.12, 0.24);
    const f0 = base * rng.range(0.92, 1.08), f1 = f0 * (up ? rng.range(1.3, 1.7) : rng.range(0.55, 0.75));
    const m = samples(sr, d);
    const s = osc(m, sr, (i) => f0 + (f1 - f0) * (i / m) ** 0.8, "sine");
    const h = osc(m, sr, (i) => 2 * (f0 + (f1 - f0) * (i / m) ** 0.8), "sine");
    for (let i = 0; i < m; i++) s[i] = (s[i] + 0.12 * h[i]) * Math.sin((Math.PI * i) / m) ** 1.5;
    addInto(x, s, t * sr);
    t += d + rng.range(0.06, 0.16);
  }
  return x;
}

function birdTrill(sr: number, rng: Rng): Mono {
  const dur = rng.range(0.6, 1.0), n = samples(sr, dur + 0.1);
  const x = new Float32Array(n);
  const rate = rng.range(16, 24), f = rng.range(3400, 4400);
  for (let t = 0.02, k = 0; t < dur; t += 1 / rate, k++) {
    const m = samples(sr, 0.035);
    const c = osc(m, sr, (i) => f * (1.15 - 0.3 * (i / m)), "sine");
    applyEnv(c, (i) => Math.sin((Math.PI * i) / m));
    addInto(x, c, t * sr, Math.sin(Math.PI * clamp(t / dur, 0, 1)) ** 0.5);
  }
  return x;
}

function birdSong(sr: number, rng: Rng): Mono {
  const count = rng.int(9, 16);
  const n = samples(sr, count * 0.12 + 0.2);
  const x = new Float32Array(n);
  let t = 0.01;
  for (let k = 0; k < count; k++) {
    const d = rng.range(0.035, 0.09);
    const f0 = rng.range(2600, 5800), f1 = f0 * rng.range(0.6, 1.5);
    const m = samples(sr, d);
    const fm = rng.range(40, 90);
    const c = osc(m, sr, (i) => (f0 + (f1 - f0) * (i / m)) * (1 + 0.05 * Math.sin((TAU * fm * i) / sr)), "sine");
    applyEnv(c, (i) => Math.sin((Math.PI * i) / m));
    addInto(x, c, t * sr, rng.range(0.5, 1));
    t += d + rng.range(0.015, 0.06);
  }
  return x;
}

function birdCoo(sr: number, rng: Rng): Mono {
  // collared dove: "coo-COOO-coo"
  const pattern: [number, number, number][] = [[0, 0.22, 0.7], [0.32, 0.5, 1], [0.95, 0.3, 0.8]];
  const f = rng.range(430, 520);
  const n = samples(sr, 1.4);
  const x = new Float32Array(n);
  for (const [at, d, a] of pattern) {
    const m = samples(sr, d);
    const s = osc(m, sr, (i) => f * (1.04 - 0.08 * (i / m)), "sine");
    const h = osc(m, sr, (i) => 2 * f * (1.04 - 0.08 * (i / m)), "sine");
    for (let i = 0; i < m; i++) s[i] = (s[i] + 0.15 * h[i]) * Math.min(1, i / (0.05 * sr)) * Math.min(1, (m - i) / (0.08 * sr));
    addInto(x, s, at * sr, a);
  }
  addInto(x, svf(white(n, rng), sr, "bp", f, 3), 0, 0.02);
  return x;
}

function parrot(sr: number, rng: Rng): Mono {
  const dur = rng.range(0.22, 0.35), n = samples(sr, dur + 0.05);
  const fc = rng.range(800, 1100);
  const mod = osc(n, sr, rng.range(150, 200), "sine");
  const car = osc(n, sr, (i) => fc * (1 + 0.1 * Math.sin((Math.PI * i) / n)) + mod[i] * fc * 0.9, "saw");
  const y = resonators(car, sr, [[1800, 3, 1], [3200, 4, 0.5]]);
  return applyEnv(y, lineEnv(sr, [[0, 0], [0.02, 1], [dur * 0.7, 0.8], [dur, 0]]));
}

function gull(sr: number, rng: Rng): Mono {
  const syl = rng.int(3, 6);
  const n = samples(sr, syl * 0.34 + 0.3);
  const x = new Float32Array(n);
  let t = 0.02;
  const base = rng.range(1000, 1200);
  for (let k = 0; k < syl; k++) {
    const d = rng.range(0.18, 0.28) * (k === 0 ? 1.4 : 1);
    const m = samples(sr, d);
    const f = (i: number) => {
      const u = i / m;
      return base * (u < 0.3 ? 1 + 0.7 * (u / 0.3) : 1.7 - 0.6 * ((u - 0.3) / 0.7)) * (1 - 0.1 * k / syl);
    };
    const s = osc(m, sr, f, "saw");
    for (let i = 0; i < m; i++) s[i] *= 1 + 0.25 * Math.sin((TAU * 70 * i) / sr);
    const y = resonators(s, sr, [[1700, 3, 1], [2900, 4, 0.5], [900, 2, 0.3]]);
    applyEnv(y, (i) => Math.min(1, i / (0.015 * sr)) * Math.min(1, (m - i) / (0.05 * sr)));
    addInto(x, y, t * sr, rng.range(0.7, 1));
    t += d + rng.range(0.07, 0.14);
  }
  return x;
}

function bell(sr: number, rng: Rng): Mono {
  const dur = 5, n = samples(sr, dur);
  const f = rng.range(300, 340); // nominal/2 ≈ E4
  const x = modal(n, sr, [
    [f * 0.5, 5, 0.5], [f, 3.5, 0.8], [f * 1.19, 2.6, 0.55], [f * 1.5, 2, 0.35], [f * 2, 1.8, 0.7],
    [f * 2.52, 1.1, 0.25], [f * 3.01, 0.9, 0.2], [f * 4.2, 0.5, 0.12], [f * 5.4, 0.3, 0.06],
  ]);
  addInto(x, burst(sr, rng, 0.2, "bp", 2400, 1, 0.0005, 0.01), 0, 0.3);
  const d = svf(x, sr, "lp", 2600, 0.7);
  return reverb(d, sr, { size: 0.85, damp: 0.6, wet: 0.5, dry: 0.7 }).subarray(0, n);
}

function drip(sr: number, rng: Rng): Mono {
  const n = samples(sr, 0.35);
  const x = bubble(sr, rng.range(1200, 2600), rng.range(0.012, 0.02), rng.range(0.5, 1));
  const o = mixTo(n, [x, 1]);
  addInto(o, burst(sr, rng, 0.05, "hp", 4000, 0.7, 0.0002, 0.0015), 0, 0.2);
  if (rng.chance(0.5)) addInto(o, bubble(sr, rng.range(1800, 3200), 0.008, 0.8), rng.range(0.07, 0.14) * sr, 0.35);
  return o;
}

function frog(sr: number, rng: Rng): Mono {
  const groups = rng.int(1, 3);
  const n = samples(sr, groups * 0.45 + 0.2);
  const x = new Float32Array(n);
  const f0 = rng.range(170, 260), rate = rng.range(20, 28);
  let t = 0.02;
  for (let g = 0; g < groups; g++) {
    const pulses = rng.int(5, 9);
    for (let k = 0; k < pulses; k++) {
      const m = samples(sr, 0.018);
      const p = osc(m, sr, f0 * (1 + 0.05 * k / pulses), "saw");
      applyEnv(p, (i) => Math.sin((Math.PI * i) / m));
      addInto(x, p, (t + k / rate) * sr, Math.sin((Math.PI * (k + 0.5)) / pulses));
    }
    t += pulses / rate + rng.range(0.08, 0.15);
  }
  return resonators(x, sr, [[rng.range(450, 600), 4, 1], [rng.range(1200, 1500), 5, 0.5], [2400, 5, 0.15]]);
}

// ---------------------------------------------------------------- loops (seamless)

/** Vespa: 2-stroke single-cylinder buzz; loop is 84 firings (42 Hz) in 2 s. Pitch it by speed. */
function vespaEngine(sr: number, rng: Rng): Mono {
  const n = samples(sr, 2);
  const firings = 84;
  const dry = new Float32Array(n);
  for (let k = 0; k < firings; k++) {
    const at = Math.round((k * n) / firings + rng.range(-0.0006, 0.0006) * sr);
    const amp = (k % 4 === 3 ? 0.65 : 1) * rng.range(0.8, 1.15);
    const m = samples(sr, 0.004);
    for (let i = 0; i < m; i++) dry[(at + i + n) % n] += amp * (1 - i / m) * (i === 0 ? 1 : rng.bi() * 0.6);
  }
  const hissDry = white(n, rng);
  const body = periodic(dry, (t) => {
    const r = resonators(t, sr, [[170, 3, 1], [420, 4, 0.8], [950, 5, 0.5], [2100, 4, 0.25]]);
    return svf(r, sr, "lp", 3800, 0.7);
  });
  const hiss = periodic(hissDry, (t) => svf(t, sr, "bp", 1400, 0.7));
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const ph = ((i * firings) / n) % 1;
    o[i] = body[i] + hiss[i] * 0.06 * (0.6 + 0.4 * Math.cos(TAU * ph));
  }
  return saturate(o, 1.5);
}

/** Seamless train of short pulses: `firings` per loop, amplitude per firing from amp(k). */
function pulseTrain(n: number, sr: number, rng: Rng, firings: number, amp: (k: number) => number, jitter: number, len: number): Float32Array {
  const dry = new Float32Array(n);
  for (let k = 0; k < firings; k++) {
    const at = Math.round((k * n) / firings + rng.range(-jitter, jitter) * sr);
    const a = amp(k);
    const m = samples(sr, len);
    for (let i = 0; i < m; i++) dry[(at + i + n) % n] += a * (1 - i / m) * (i === 0 ? 1 : rng.bi() * 0.6);
  }
  return dry;
}

/** Jetski: a revvy little 2-stroke twin (70 Hz firing) + the hiss of the water jet. Pitch it by speed. */
function jetskiEngine(sr: number, rng: Rng): Mono {
  const n = samples(sr, 2);
  const firings = 140;
  const dry = pulseTrain(n, sr, rng, firings, (k) => (k % 2 ? 0.8 : 1) * rng.range(0.85, 1.1), 0.0004, 0.003);
  const body = periodic(dry, (t) => {
    const r = resonators(t, sr, [[260, 3, 0.8], [880, 5, 1], [1750, 6, 0.6], [3300, 5, 0.25]]);
    return svf(r, sr, "lp", 5200, 0.7);
  });
  const jet = periodic(white(n, rng), (t) => svf(t, sr, "bp", 2600, 0.6));
  const lfo = periodicLfo(n, rng, 3, 9);
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) o[i] = body[i] + jet[i] * (0.09 + 0.03 * lfo(i));
  return saturate(o, 2);
}

/** Speedboat: a burbly V8 inboard — lumpy low firing (46 Hz), wet exhaust blubbing at the water line. */
function inboardEngine(sr: number, rng: Rng): Mono {
  const n = samples(sr, 2);
  const firings = 92;
  // cross-plane V8 lope: uneven pairs of strong / weak pulses
  const lope = [1, 0.55, 0.85, 0.6, 1, 0.5, 0.9, 0.65];
  const dry = pulseTrain(n, sr, rng, firings, (k) => lope[k % 8] * rng.range(0.85, 1.15), 0.0012, 0.009);
  const body = periodic(dry, (t) => {
    const r = resonators(t, sr, [[95, 2.5, 1.2], [210, 3, 0.9], [480, 4, 0.4], [1100, 4, 0.12]]);
    return svf(r, sr, "lp", 1800, 0.7);
  });
  // the exhaust outlets gulp in and out of the wake
  const gulp = periodicLfo(n, rng, 5, 11);
  const blub = bubbles(sr, rng, n, 40, 0, 2, 90, 260, 0.6, 0.02, 0.06, false, true);
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) o[i] = body[i] * (0.8 + 0.2 * gulp(i)) + blub[i] * 0.5;
  return saturate(o, 1.6);
}

/** Gyrocopter: a small flat-four aero engine, the pusher prop's buzz and the rotor's slow whup-whup. */
function gyroEngine(sr: number, rng: Rng): Mono {
  const n = samples(sr, 2);
  const firings = 120; // 60 Hz
  const dry = pulseTrain(n, sr, rng, firings, (k) => (k % 4 === 1 ? 0.75 : 1) * rng.range(0.9, 1.1), 0.0005, 0.005);
  const body = periodic(dry, (t) => {
    const r = resonators(t, sr, [[150, 3, 1], [390, 4, 0.7], [820, 4, 0.35]]);
    return svf(r, sr, "lp", 2600, 0.7);
  });
  // prop: 2 blades, blade-pass 90 Hz, a buzzy saw through a lowpass
  const prop = periodic(osc(n, sr, 90, "saw"), (t) => svf(t, sr, "lp", 900, 1.1));
  const air = periodic(white(n, rng), (t) => svf(t, sr, "bp", 700, 0.5));
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    // rotor: 2 blades at ~4 rev/s → 8 whups a second (16 per 2 s loop, seamless)
    const whup = 0.5 + 0.5 * Math.cos(TAU * 8 * t);
    o[i] = body[i] * 0.9 + prop[i] * 0.22 + air[i] * (0.12 + 0.35 * whup * whup * whup);
  }
  return saturate(o, 1.4);
}

function ziplineLoop(sr: number, rng: Rng): Mono {
  const n = samples(sr, 1);
  const wheel = 90; // Hz, integer cycles per loop
  const buzz = periodic(osc(n, sr, wheel, "saw"), (t) => svf(t, sr, "lp", 700, 0.9));
  const roll = periodic(white(n, rng), (t) => svf(t, sr, "bp", 2200, 1.2));
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const w = 0.5 + 0.5 * Math.sin(TAU * wheel * t);
    const sing = Math.sin(TAU * 1850 * t + 0.4 * Math.sin(TAU * 5 * t)) + 0.6 * Math.sin(TAU * 2710 * t + 0.3 * Math.sin(TAU * 4 * t));
    o[i] = buzz[i] * 0.18 + roll[i] * (0.35 + w * w) * 1.1 + sing * 0.07;
  }
  return o;
}

function boatWake(sr: number, rng: Rng): Mono {
  const n = samples(sr, 4);
  const lfo = periodicLfo(n, rng, 2, 7);
  const body = periodic(white(n, rng), (t) => svf(t, sr, "lp", 1100, 0.7));
  const hiss = periodic(white(n, rng), (t) => svf(t, sr, "hp", 3200, 0.7));
  const gur = bubbles(sr, rng, n, 26, 0, 4, 180, 650, 0.5, 0.02, 0.05, false, true);
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) o[i] = body[i] * (0.7 + 0.3 * lfo(i)) + hiss[i] * 0.2 * (0.6 + 0.4 * lfo((i + (n >> 1)) % n)) + gur[i];
  return o;
}

function waterLap(sr: number, rng: Rng): Mono {
  const n = samples(sr, 6);
  const dry = new Float32Array(n);
  let t = 0;
  while (t < 6 - 0.3) {
    const m = samples(sr, 0.25);
    const s = svf(white(m, rng), sr, "bp", rng.range(300, 700), 1.5);
    applyEnv(s, lineEnv(sr, [[0, 0], [0.03, 1], [0.24, 0]]));
    addInto(dry, s, t * sr, rng.range(0.4, 1), true);
    if (rng.chance(0.6)) addInto(dry, bubble(sr, rng.range(300, 600), 0.03, 1.2), (t + 0.02) * sr, 0.4, true);
    t += rng.range(0.6, 1.4);
  }
  const bed = periodic(white(n, rng), (x) => svf(x, sr, "lp", 400, 0.7));
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) o[i] = dry[i] + bed[i] * 0.25;
  return o;
}

// ---------------------------------------------------------------- registry

const splatDef = (o: SplatOpts, target = -16): SfxDef => ({ cat: "world", variants: 4, target, max: 10, pj: 1.5, render: (sr, rng) => splat(sr, rng, o) });
const stepDef = (s: Surface): SfxDef => ({ cat: "world", variants: 5, target: -23, max: 8, pj: 1.2, ref: 1.5, maxDist: 35, render: (sr, rng) => step(sr, rng, s) });

export const SFX = {
  // marker & combat
  shoot: { cat: "world", variants: 4, target: -13, max: 10, pj: 0.8, ref: 3, render: shoot },
  shoot_empty: { cat: "world", variants: 2, target: -22, max: 2, pj: 0.5, ref: 1.5, maxDist: 20, render: shootEmpty },
  reload: { cat: "world", variants: 3, target: -20, max: 3, pj: 0.4, ref: 1.5, maxDist: 25, render: reload },
  whiz: { cat: "world", variants: 3, target: -17, max: 4, pj: 1.5, ref: 2, maxDist: 15, render: whiz },
  splat_ground: splatDef({ size: 0.9, bright: 0.35, wet: 1, thud: 0.5, surface: "ground" }),
  splat_wood: splatDef({ size: 0.9, bright: 0.55, wet: 1, thud: 0.2, surface: "wood" }),
  splat_stone: splatDef({ size: 0.8, bright: 0.9, wet: 1.2, thud: 0.1, surface: "stone" }),
  splat_water: splatDef({ size: 0.8, bright: 0.6, wet: 0.8, thud: 0, surface: "water" }, -18),
  splat_player: splatDef({ size: 1.1, bright: 0.6, wet: 1.2, thud: 0.7, surface: "player" }, -14),
  hit_me: { cat: "self", variants: 3, target: -12, max: 3, pj: 1, render: hitMe },
  eliminate: { cat: "world", variants: 3, target: -12, max: 4, pj: 1, ref: 4, maxDist: 90, render: eliminate },
  respawn: { cat: "world", variants: 2, target: -17, max: 4, pj: 0.5, ref: 3, render: respawn },
  // movement
  step_sand: stepDef("sand"),
  step_grass: stepDef("grass"),
  step_stone: stepDef("stone"),
  step_wood: stepDef("wood"),
  step_water: stepDef("water"),
  jump: { cat: "world", variants: 3, target: -21, max: 4, pj: 1, ref: 1.5, maxDist: 35, render: jump },
  land: { cat: "world", variants: 3, target: -18, max: 4, pj: 1, ref: 1.5, maxDist: 40, render: land },
  slide: { cat: "world", variants: 3, target: -21, max: 3, pj: 0.8, ref: 1.5, maxDist: 35, render: slide },
  mantle: { cat: "world", variants: 3, target: -22, max: 3, pj: 1, ref: 1.5, maxDist: 30, render: mantle },
  bellyflop: { cat: "world", variants: 3, target: -12, max: 3, pj: 0.8, ref: 3, render: (sr, rng) => bigSplash(sr, rng, 1) },
  splash: { cat: "world", variants: 3, target: -16, max: 4, pj: 1, ref: 2, render: (sr, rng) => bigSplash(sr, rng, 0.5) },
  swim_stroke: { cat: "world", variants: 4, target: -22, max: 6, pj: 1, ref: 1.5, maxDist: 35, render: swimStroke },
  dive: { cat: "world", variants: 3, target: -15, max: 3, pj: 0.6, ref: 2, render: dive },
  surface_gasp: { cat: "world", variants: 3, target: -16, max: 3, pj: 0.6, ref: 2, maxDist: 40, render: surfaceGasp },
  bubbles: { cat: "world", variants: 4, target: -22, max: 6, pj: 1.5, ref: 1.5, maxDist: 25, render: bubbleBurst },
  washoff: { cat: "self", variants: 2, target: -19, max: 2, pj: 0.3, render: washoff },
  sky_splat: { cat: "world", variants: 3, target: -14, max: 4, pj: 0.6, ref: 3, maxDist: 70, render: skySplat },
  sky_wind: { cat: "world", variants: 1, target: -21, loop: true, ref: 3, maxDist: 60, render: skyWind },
  heartbeat: { cat: "self", variants: 1, target: -16, max: 2, pj: 0, render: heartbeat },
  // pickups
  pickup_ammo: { cat: "self", variants: 2, target: -17, max: 3, pj: 0.3, render: pickupAmmo },
  pickup_upgrade: { cat: "self", variants: 1, target: -16, max: 2, pj: 0, render: pickupUpgrade },
  // vehicles
  vespa_horn: { cat: "world", variants: 2, target: -14, max: 3, pj: 0.3, ref: 4, maxDist: 110, render: vespaHorn },
  row_stroke: { cat: "world", variants: 4, target: -21, max: 4, pj: 0.8, ref: 2, maxDist: 45, render: rowStroke },
  zipline_attach: { cat: "world", variants: 2, target: -18, max: 3, pj: 0.5, ref: 2, maxDist: 50, render: ziplineAttach },
  // loops
  vespa_engine: { cat: "world", variants: 1, target: -18, loop: true, ref: 3, maxDist: 120, render: vespaEngine },
  jetski_engine: { cat: "world", variants: 1, target: -19, loop: true, ref: 3, maxDist: 130, render: jetskiEngine },
  inboard_engine: { cat: "world", variants: 1, target: -18, loop: true, ref: 4, maxDist: 140, render: inboardEngine },
  gyro_engine: { cat: "world", variants: 1, target: -18, loop: true, ref: 4, maxDist: 200, render: gyroEngine },
  zipline_whirr: { cat: "world", variants: 1, target: -20, loop: true, ref: 2, maxDist: 70, render: ziplineLoop },
  boat_wake: { cat: "world", variants: 1, target: -22, loop: true, ref: 2, maxDist: 50, render: boatWake },
  water_lap: { cat: "world", variants: 1, target: -24, loop: true, ref: 2, maxDist: 30, render: waterLap },
  // UI (non-positional, unaffected by underwater / ducking)
  ui_click: { cat: "ui", variants: 2, target: -21, max: 4, pj: 0.3, render: uiClick },
  ui_hover: { cat: "ui", variants: 1, target: -30, max: 2, pj: 0.3, render: uiHover },
  ui_confirm: { cat: "ui", variants: 1, target: -20, max: 2, pj: 0, render: (sr) => twoNotes(sr, 79, 86) },
  ui_back: { cat: "ui", variants: 1, target: -21, max: 2, pj: 0, render: (sr) => twoNotes(sr, 86, 79) },
  countdown_tick: { cat: "ui", variants: 1, target: -18, max: 2, pj: 0, render: (sr, rng) => woodblock(sr, rng) },
  countdown_go: { cat: "ui", variants: 1, target: -16, max: 2, pj: 0, render: countdownGo },
  match_start: { cat: "ui", variants: 1, target: -15, max: 1, pj: 0, render: matchStart },
  match_end: { cat: "ui", variants: 1, target: -15, max: 1, pj: 0, render: matchEnd },
  killfeed: { cat: "ui", variants: 1, target: -25, max: 3, pj: 0.2, render: killfeed },
  hitmarker: { cat: "ui", variants: 2, target: -20, max: 4, pj: 0.4, render: hitmarker },
  hitmarker_kill: { cat: "ui", variants: 1, target: -17, max: 2, pj: 0, render: hitmarkerKill },
  // ambience one-shots (the ambience manager places these around the listener)
  bird_whistle: { cat: "amb", variants: 5, target: -24, max: 3, pj: 1.5, ref: 6, maxDist: 150, render: birdWhistle },
  bird_trill: { cat: "amb", variants: 4, target: -26, max: 2, pj: 1.5, ref: 6, maxDist: 150, render: birdTrill },
  bird_song: { cat: "amb", variants: 5, target: -25, max: 2, pj: 1, ref: 6, maxDist: 150, render: birdSong },
  bird_coo: { cat: "amb", variants: 3, target: -24, max: 2, pj: 0.8, ref: 6, maxDist: 150, render: birdCoo },
  parrot: { cat: "amb", variants: 3, target: -24, max: 1, pj: 1, ref: 6, maxDist: 150, render: parrot },
  gull: { cat: "amb", variants: 4, target: -23, max: 2, pj: 1, ref: 8, maxDist: 200, render: gull },
  bell: { cat: "amb", variants: 1, target: -18, max: 4, pj: 0, ref: 40, rolloff: 0.6, maxDist: 2000, render: bell },
  drip: { cat: "amb", variants: 5, target: -24, max: 4, pj: 2, ref: 3, maxDist: 60, render: drip },
  frog: { cat: "amb", variants: 4, target: -25, max: 2, pj: 1, ref: 5, maxDist: 100, render: frog },
} satisfies Record<string, SfxDef>;

export type SfxName = keyof typeof SFX;
export const SFX_NAMES = Object.keys(SFX) as SfxName[];

/** Render all variants of one SFX, trimmed, faded and loudness-normalised. */
export function renderSfx(name: SfxName, sr: number): Chans[] {
  const def: SfxDef = SFX[name];
  const out: Chans[] = [];
  const count = def.variants ?? 1;
  for (let v = 0; v < count; v++) {
    const rng = new Rng((hash(name) + v * 7919) >>> 0);
    const r = def.render(sr, rng, v);
    let chans: Chans = r instanceof Float32Array ? [r] : r;
    if (def.loop) {
      chans = chans.map((c) => removeDCLoop(c));
    } else {
      chans = chans.map((c) => fadeEdges(onePole(c, sr, "hp", 20), sr, 0.0005, 0.015));
      chans = trimTail(chans, sr);
    }
    normalizeTo(chans, sr, def.target, def.loop);
    out.push(chans);
  }
  return out;
}

/** Remove DC from a loop without breaking periodicity. */
function removeDCLoop(x: Float32Array): Float32Array {
  let m = 0;
  for (let i = 0; i < x.length; i++) m += x[i];
  m /= x.length;
  for (let i = 0; i < x.length; i++) x[i] -= m;
  return x;
}

function normalizeTo(chans: Chans, sr: number, target: number, loop?: boolean): void {
  if (loop) {
    // loops: long-term RMS target, peak ceiling
    const r = rmsOf(chans), p = peakOf(chans);
    let g = dbToGain(target) / Math.max(1e-9, r);
    if (p * g > dbToGain(-1)) g = dbToGain(-1) / p;
    for (const c of chans) scale(c, g);
    return;
  }
  normalize(chans, sr, target, -1);
}

