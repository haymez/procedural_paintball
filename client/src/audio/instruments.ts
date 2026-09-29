// Menu-music instruments, rendered per note (pure DSP, runs in the worker).
//  mandolin  — two detuned Karplus–Strong courses + small body resonances
//  guitar    — darker nylon-string KS
//  bass      — dark KS + sine fundamental
//  accordion — wavetable reeds, musette detune (the "Italian" beating), nasal formant
//  whistle   — sine with scoop, delayed vibrato, breath noise
//  shaker    — tiny noise grains
// Sustained instruments render a long note; the player releases them with a gain ramp.

import { Rng, TAU, adEnv, applyEnv, clamp, fadeEdges, mtof, onePole, peakOf, pluck, resonators, samples, scale, svf, white, type Chans } from "./dsp";

export type Inst = "mandolin" | "guitar" | "bass" | "accordion" | "whistle" | "shaker";

/** Length of each rendered note (s). Sustained ones are released by the player. */
export const NOTE_LEN: Record<Inst, number> = {
  mandolin: 1.8,
  guitar: 2.6,
  bass: 2.0,
  accordion: 3.4,
  whistle: 3.4,
  shaker: 0.12,
};

export const SUSTAINED: Record<Inst, boolean> = {
  mandolin: false, guitar: false, bass: false, accordion: true, whistle: true, shaker: false,
};

function mandolin(sr: number, midi: number, rng: Rng): Float32Array {
  const f = mtof(midi), dur = NOTE_LEN.mandolin;
  const t60 = clamp(2.4 - (midi - 60) * 0.05, 0.8, 2.2);
  const a = pluck(sr, f * 1.0009, dur, rng, { t60, bright: 0.88, pick: 0.12 });
  const b = pluck(sr, f * 0.9991, dur, rng, { t60: t60 * 0.95, bright: 0.84, pick: 0.13 });
  const n = a.length;
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = a[i] + b[i];
  const body = resonators(s, sr, [[300, 2, 0.5], [580, 3, 0.35], [1250, 2, 0.2], [3000, 1.5, 0.15]]);
  for (let i = 0; i < n; i++) s[i] = s[i] * 0.7 + body[i] * 0.6;
  return s;
}

function guitar(sr: number, midi: number, rng: Rng): Float32Array {
  const f = mtof(midi), dur = NOTE_LEN.guitar;
  const s = pluck(sr, f, dur, rng, { t60: clamp(3.2 - (midi - 48) * 0.05, 1.5, 3.2), bright: 0.45, pick: 0.2 });
  const body = resonators(s, sr, [[105, 2, 0.5], [220, 2.5, 0.4], [480, 2, 0.2]]);
  for (let i = 0; i < s.length; i++) s[i] = s[i] * 0.8 + body[i] * 0.5;
  return svf(s, sr, "lp", 3800, 0.7);
}

function bass(sr: number, midi: number, rng: Rng): Float32Array {
  const f = mtof(midi), dur = NOTE_LEN.bass;
  const s = pluck(sr, f, dur, rng, { t60: 1.6, bright: 0.25, pick: 0.25 });
  const n = s.length;
  const env = adEnv(sr, 0.006, 0.45);
  for (let i = 0; i < n; i++) s[i] = s[i] * 0.7 + Math.sin((TAU * f * i) / sr) * env(i) * 0.6;
  return svf(s, sr, "lp", 1100, 0.7);
}

/** One period of a reed-like waveform (band-limited additive), as a lookup table. */
function reedTable(f: number, sr: number): Float32Array {
  const size = 2048;
  const t = new Float32Array(size);
  const maxH = Math.max(1, Math.floor(Math.min(sr * 0.45, 7000) / f));
  for (let h = 1; h <= maxH; h++) {
    // bright reed spectrum with a little odd-harmonic emphasis
    const a = (1 / Math.pow(h, 1.05)) * (h % 2 ? 1 : 0.75);
    for (let i = 0; i < size; i++) t[i] += a * Math.sin((TAU * h * i) / size + h * 0.3);
  }
  let m = 0;
  for (let i = 0; i < size; i++) m = Math.max(m, Math.abs(t[i]));
  for (let i = 0; i < size; i++) t[i] /= m;
  return t;
}

function accordion(sr: number, midi: number, rng: Rng): Float32Array {
  const f = mtof(midi), n = samples(sr, NOTE_LEN.accordion);
  const tab = reedTable(f, sr);
  const size = tab.length;
  // musette: centre reed + one ~11 cents sharp + a quieter one ~6 cents flat
  const reeds: [number, number, number][] = [[f, 1, rng.next()], [f * Math.pow(2, 11 / 1200), 0.8, rng.next()], [f * Math.pow(2, -6 / 1200), 0.45, rng.next()]];
  const o = new Float32Array(n);
  for (const [rf, amp, ph0] of reeds) {
    let ph = ph0 * size;
    const inc = (rf * size) / sr;
    for (let i = 0; i < n; i++) {
      const k = ph | 0, fr = ph - k;
      o[i] += amp * (tab[k % size] * (1 - fr) + tab[(k + 1) % size] * fr);
      ph += inc;
      if (ph >= size) ph -= size;
    }
  }
  // nasal formant + gentle top roll-off
  const form = resonators(o, sr, [[1400, 1.6, 0.8], [2600, 2, 0.35]]);
  for (let i = 0; i < n; i++) o[i] = o[i] * 0.45 + form[i];
  const y = onePole(svf(o, sr, "lp", 4500, 0.6), sr, "hp", 90);
  // bellows: soft attack, slight swell
  applyEnv(y, (i) => {
    const t = i / sr;
    return Math.min(1, t / 0.07) * (0.9 + 0.1 * Math.min(1, t / 1.2));
  });
  return fadeEdges(y, sr, 0.002, 0.08);
}

function whistle(sr: number, midi: number, rng: Rng): Float32Array {
  const f = mtof(midi), n = samples(sr, NOTE_LEN.whistle);
  const o = new Float32Array(n);
  const vibHz = rng.range(5.2, 5.9);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const scoop = 1 - 0.035 * Math.exp(-t / 0.035);
    const vib = 1 + 0.007 * clamp((t - 0.18) / 0.35, 0, 1) * Math.sin(TAU * vibHz * t);
    ph += (f * scoop * vib) / sr;
    o[i] = Math.sin(TAU * ph) + 0.05 * Math.sin(2 * TAU * ph);
  }
  const breath = svf(white(n, rng), sr, "bp", f, 12);
  for (let i = 0; i < n; i++) o[i] += breath[i] * 0.35;
  applyEnv(o, (i) => Math.min(1, i / sr / 0.035));
  return fadeEdges(o, sr, 0.002, 0.08);
}

function shaker(sr: number, _midi: number, rng: Rng): Float32Array {
  const n = samples(sr, NOTE_LEN.shaker);
  const x = svf(white(n, rng), sr, "hp", 5500, 0.7);
  return applyEnv(x, adEnv(sr, 0.006, 0.022));
}

const RENDER: Record<Inst, (sr: number, midi: number, rng: Rng) => Float32Array> = {
  mandolin, guitar, bass, accordion, whistle, shaker,
};

/** Per-instrument peak level of a rendered note (the mix is done with gains later). */
const LEVEL: Record<Inst, number> = { mandolin: 0.5, guitar: 0.5, bass: 0.6, accordion: 0.4, whistle: 0.4, shaker: 0.3 };

export function renderNote(inst: Inst, midi: number, sr: number): Chans {
  const rng = new Rng((midi * 7331 + inst.length * 131 + inst.charCodeAt(0) * 17) >>> 0);
  const x = RENDER[inst](sr, midi, rng);
  if (!SUSTAINED[inst]) fadeEdges(x, sr, 0.0005, 0.05);
  const p = peakOf([x]);
  if (p > 0) scale(x, LEVEL[inst] / p);
  return [x];
}

export const noteKey = (inst: Inst, midi: number): string => `${inst}:${midi}`;
