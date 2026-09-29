// Ambience beds: long, seamless stereo loops. Every source is built periodic
// (events wrap around the loop end, LFOs have integer cycles) and filtered
// via `periodic()` so the last sample flows into the first.
// Sporadic sounds (birds, gulls, bells, drips, frogs) are NOT baked in — the
// ambience manager fires them as positional one-shots so they never repeat
// in a recognisable pattern.

import {
  Rng, TAU, addInto, applyEnv, brown, hashName, lineEnv, onePole, osc, periodic, periodicLfo,
  pink, rmsOf, peakOf, dbToGain, samples, scale, svf, white, type Chans,
} from "./dsp";

export interface BedDef {
  seconds: number;
  /** Long-term RMS target (dBFS). */
  target: number;
  render: (sr: number, rng: Rng, n: number) => Chans;
}

/** Periodic envelope array built from events (wrap-around). */
function envArray(n: number): Float32Array {
  return new Float32Array(n);
}

function addShape(arr: Float32Array, sr: number, at: number, pts: readonly (readonly [number, number])[], amp = 1): void {
  const f = lineEnv(sr, pts);
  const len = samples(sr, pts[pts.length - 1][0]);
  const n = arr.length;
  const off = Math.round(at * sr);
  for (let i = 0; i < len; i++) arr[(off + i) % n] += f(i) * amp;
}

/** Surf on a Riviera pebble beach: low ocean roar + swell → crash → hiss & pebble drag. */
function surf(sr: number, rng: Rng, n: number): Chans {
  const secs = n / sr;
  const swell = envArray(n), crash = envArray(n), wash = envArray(n);
  let t = rng.range(0, 2);
  while (t < secs) {
    const big = rng.range(0.6, 1);
    addShape(swell, sr, t, [[0, 0], [1.4, big], [1.7, 0]]);
    addShape(crash, sr, t + 1.45, [[0, 0], [0.12, big], [0.6, big * 0.55], [1.8, 0]]);
    addShape(wash, sr, t + 1.8, [[0, 0], [0.4, big * 0.8], [1.8, big * 0.35], [3.6, 0]]);
    t += rng.range(5.5, 8.5);
  }
  const lfo = periodicLfo(n, rng, 1, 5);
  const chans: Chans = [];
  for (let c = 0; c < 2; c++) {
    const r = new Rng(rng.next() * 1e9);
    const roar = periodic(white(n, r), (x) => svf(onePole(x, sr, "lp", 400), sr, "lp", 350, 0.6));
    const sw = periodic(white(n, r), (x) => svf(x, sr, "lp", (i) => 250 + 1400 * swell[i % n], 0.8));
    const cr = periodic(white(n, r), (x) => svf(x, sr, "lp", (i) => 1200 + 5500 * crash[i % n], 0.6));
    const hiss = periodic(white(n, r), (x) => svf(x, sr, "hp", 1800, 0.6));
    // pebbles: sparse clicks while the water drains back
    const peb = new Float32Array(n);
    for (let i = 0; i < n; i++) if (r.next() < 0.004 * wash[i]) peb[i] = r.bi();
    const pebF = periodic(peb, (x) => svf(x, sr, "bp", 3800, 2.5));
    const o = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      o[i] = roar[i] * (1.6 + 0.4 * lfo(i)) + sw[i] * swell[i] * 1.1 + cr[i] * crash[i] * 1.2 + hiss[i] * wash[i] * 0.45 + pebF[i] * 1.6;
    }
    chans.push(o);
  }
  return chans;
}

/** Wind: bandpassed pink noise with gusts + palm-frond rustle flutter. */
function wind(sr: number, rng: Rng, n: number): Chans {
  const gust = periodicLfo(n, rng, 1, 6, 5);
  const centre = periodicLfo(n, rng, 1, 4);
  const chans: Chans = [];
  for (let c = 0; c < 2; c++) {
    const r = new Rng(rng.next() * 1e9);
    const g = (i: number) => {
      const v = 0.55 + 0.45 * gust((i + c * Math.round(0.3 * sr)) % n);
      return v * v;
    };
    const body = periodic(pink(n, r), (x) => svf(x, sr, "bp", (i) => 420 + 260 * centre(i % n) + 300 * g(i % n), (i) => 0.9 + 0.8 * g(i % n)));
    const rust = periodic(white(n, r), (x) => svf(x, sr, "hp", 2600, 0.6));
    const flutterRaw = periodic(white(n, r), (x) => onePole(onePole(x, sr, "lp", 18), sr, "lp", 18));
    let fm = 0;
    for (let i = 0; i < n; i++) fm = Math.max(fm, Math.abs(flutterRaw[i]));
    const o = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const gi = g(i);
      const fl = Math.abs(flutterRaw[i]) / (fm || 1);
      o[i] = body[i] * (0.25 + gi) + rust[i] * gi * (0.15 + 0.6 * fl) * 0.35;
    }
    chans.push(o);
  }
  return chans;
}

/** Tropical insects: pulsed crickets, katydid rasps, soft high hiss, distant low forest hum. */
function jungle(sr: number, rng: Rng, n: number): Chans {
  const secs = n / sr;
  const L = new Float32Array(n), R = new Float32Array(n);
  const crickets = 6;
  for (let k = 0; k < crickets; k++) {
    const f = Math.round(rng.range(3900, 6400) * secs) / secs; // integer cycles per loop
    const chirpRate = Math.round(rng.range(1.6, 3.2) * secs) / secs; // integer chirps per loop
    const pulses = rng.int(2, 4), pulseRate = rng.range(22, 34);
    const pan = rng.range(-0.9, 0.9), amp = rng.range(0.3, 1);
    const tone = osc(n, sr, f, "sine");
    const e = envArray(n);
    const period = 1 / chirpRate;
    const phase = rng.next() * period;
    for (let t = phase; t < secs + phase; t += period) {
      for (let p = 0; p < pulses; p++) addShape(e, sr, t + p / pulseRate, [[0, 0], [0.004, 1], [0.014, 0.7], [0.022, 0]], amp);
    }
    for (let i = 0; i < n; i++) {
      const v = tone[i] * e[i];
      L[i] += v * Math.sqrt(0.5 * (1 - pan));
      R[i] += v * Math.sqrt(0.5 * (1 + pan));
    }
  }
  // katydids: "tsk-tsk" rasps
  for (let k = 0; k < 2; k++) {
    const e = envArray(n);
    const pan = k ? 0.6 : -0.5;
    let t = rng.next();
    while (t < secs) {
      for (let p = 0; p < 3; p++) addShape(e, sr, t + p * 0.09, [[0, 0], [0.01, 1], [0.05, 0]], 0.5);
      t += rng.range(0.9, 1.6);
    }
    const nz = periodic(white(n, rng), (x) => svf(x, sr, "bp", 7200 - 1500 * k, 3));
    for (let i = 0; i < n; i++) {
      const v = nz[i] * e[i];
      L[i] += v * Math.sqrt(0.5 * (1 - pan));
      R[i] += v * Math.sqrt(0.5 * (1 + pan));
    }
  }
  const lfo = periodicLfo(n, rng, 1, 3);
  for (const [ch, s] of [[L, 1], [R, 2]] as const) {
    const r = new Rng(s * 99991 + rng.int(0, 1e6));
    const hiss = periodic(white(n, r), (x) => svf(x, sr, "hp", 6000, 0.6));
    const hum = periodic(pink(n, r), (x) => svf(x, sr, "bp", 350, 0.8));
    for (let i = 0; i < n; i++) ch[i] += hiss[i] * 0.03 + hum[i] * (0.18 + 0.05 * lfo(i));
  }
  return [L, R];
}

/** Mediterranean cicadas: a few loud buzzing singers with long swelling phrases. */
function cicadas(sr: number, rng: Rng, n: number): Chans {
  const secs = n / sr;
  const L = new Float32Array(n), R = new Float32Array(n);
  const singers = 4;
  for (let k = 0; k < singers; k++) {
    const r = new Rng(rng.next() * 1e9);
    const e = envArray(n);
    let t = r.range(0, 3);
    while (t < secs) {
      const hold = r.range(2.5, 5.5), amp = r.range(0.5, 1);
      addShape(e, sr, t, [[0, 0], [1.2, amp], [1.2 + hold, amp * 0.9], [2.2 + hold, 0]]);
      t += 2.2 + hold + r.range(0.8, 3);
    }
    const fc = r.range(4800, 6800);
    const pulseHz = Math.round(r.range(85, 130) * secs) / secs;
    const buzz = periodic(white(n, r), (x) => svf(x, sr, "bp", fc, 5));
    const tone = osc(n, sr, Math.round(fc * 0.8 * secs) / secs, "sine");
    const pan = r.range(-0.8, 0.8);
    for (let i = 0; i < n; i++) {
      const ph = (i * pulseHz / sr) % 1;
      const pulse = ph < 0.35 ? Math.sin((Math.PI * ph) / 0.35) : 0;
      const v = e[i] * pulse * (buzz[i] + tone[i] * 0.25);
      L[i] += v * Math.sqrt(0.5 * (1 - pan));
      R[i] += v * Math.sqrt(0.5 * (1 + pan));
    }
  }
  return [L, R];
}

/** Stream babble: dense granular bubbles over a soft rush (Farnell-style running water). */
function stream(sr: number, rng: Rng, n: number): Chans {
  const secs = n / sr;
  const chans: Chans = [];
  for (let c = 0; c < 2; c++) {
    const r = new Rng(rng.next() * 1e9);
    const o = new Float32Array(n);
    const count = Math.round(secs * 90);
    for (let k = 0; k < count; k++) {
      const f = 300 * Math.pow(6, r.next());
      const life = r.range(0.004, 0.012) * Math.sqrt(700 / f);
      const m = samples(sr, life * 4);
      const b = new Float32Array(m);
      let ph = 0;
      for (let i = 0; i < m; i++) {
        const tt = i / sr;
        ph += (f * (1 + 1.4 * (1 - Math.exp(-tt / life)))) / sr;
        b[i] = Math.sin(TAU * ph) * Math.min(1, tt / 0.001) * Math.exp(-tt / life);
      }
      addInto(o, b, r.next() * n, r.range(0.1, 0.45), true);
    }
    const rush = periodic(white(n, r), (x) => svf(x, sr, "bp", 1500, 0.5));
    const lfo = periodicLfo(n, r, 3, 12);
    for (let i = 0; i < n; i++) o[i] += rush[i] * (0.12 + 0.04 * lfo(i));
    chans.push(o);
  }
  return chans;
}

function waterfall(sr: number, rng: Rng, n: number): Chans {
  const chans: Chans = [];
  const lfo = periodicLfo(n, rng, 2, 9);
  for (let c = 0; c < 2; c++) {
    const r = new Rng(rng.next() * 1e9);
    const roar = periodic(pink(n, r), (x) => svf(x, sr, "lp", 2400, 0.6));
    const rumble = periodic(brown(n, r), (x) => svf(x, sr, "lp", 160, 0.7));
    const spray = periodic(white(n, r), (x) => svf(x, sr, "hp", 4500, 0.6));
    const o = new Float32Array(n);
    for (let i = 0; i < n; i++) o[i] = roar[i] * (1 + 0.12 * lfo(i)) + rumble[i] * 0.9 + spray[i] * 0.12;
    chans.push(o);
  }
  return chans;
}

/** Cave room tone: very low rumble + a hollow resonant moan. */
function cave(sr: number, rng: Rng, n: number): Chans {
  const chans: Chans = [];
  const lfo = periodicLfo(n, rng, 1, 3);
  for (let c = 0; c < 2; c++) {
    const r = new Rng(rng.next() * 1e9);
    const rumble = periodic(brown(n, r), (x) => svf(x, sr, "lp", 140, 0.7));
    const moan = periodic(white(n, r), (x) => svf(x, sr, "bp", (i) => 230 + 30 * lfo(i % n), 9));
    const o = new Float32Array(n);
    for (let i = 0; i < n; i++) o[i] = rumble[i] + moan[i] * (0.5 + 0.4 * lfo(i));
    chans.push(o);
  }
  return chans;
}

/** Underwater: muffled pressure rumble, a faint high fizz and slow bubble trains. */
function underwater(sr: number, rng: Rng, n: number): Chans {
  const secs = n / sr;
  const chans: Chans = [];
  const lfo = periodicLfo(n, rng, 1, 4);
  for (let c = 0; c < 2; c++) {
    const r = new Rng(rng.next() * 1e9);
    const rumble = periodic(brown(n, r), (x) => svf(x, sr, "lp", 260, 0.8));
    const fizz = periodic(white(n, r), (x) => svf(x, sr, "bp", 1100, 0.7));
    const b = new Float32Array(n);
    for (let k = 0; k < secs * 2.5; k++) {
      const f = r.range(250, 900);
      const life = r.range(0.015, 0.04);
      const m = samples(sr, life * 4);
      const s = new Float32Array(m);
      let ph = 0;
      for (let i = 0; i < m; i++) {
        const tt = i / sr;
        ph += (f * (1 + 1.5 * (1 - Math.exp(-tt / life)))) / sr;
        s[i] = Math.sin(TAU * ph) * Math.min(1, tt / 0.002) * Math.exp(-tt / life);
      }
      addInto(b, s, r.next() * n, r.range(0.2, 0.6), true);
    }
    const bl = periodic(b, (x) => svf(x, sr, "lp", 1400, 0.7));
    const o = new Float32Array(n);
    for (let i = 0; i < n; i++) o[i] = rumble[i] * (1.2 + 0.3 * lfo(i)) + fizz[i] * 0.05 + bl[i] * 0.5;
    chans.push(o);
  }
  return chans;
}

/** Mangrove: warm night-ish chorus — distant frog trills, lapping water, soft insects. */
function mangrove(sr: number, rng: Rng, n: number): Chans {
  const secs = n / sr;
  const L = new Float32Array(n), R = new Float32Array(n);
  // distant frog chorus: many quiet pulse trains
  for (let k = 0; k < 7; k++) {
    const r = new Rng(rng.next() * 1e9);
    const f0 = r.range(160, 320), rate = r.range(14, 30);
    const pan = r.range(-0.9, 0.9);
    const dry = new Float32Array(n);
    let t = r.range(0, 2);
    while (t < secs) {
      const pulses = r.int(4, 12);
      for (let p = 0; p < pulses; p++) {
        const m = samples(sr, 0.02);
        const s = osc(m, sr, f0, "saw");
        applyEnv(s, (i) => Math.sin((Math.PI * i) / m));
        addInto(dry, s, (t + p / rate) * sr, r.range(0.6, 1), true);
      }
      t += pulses / rate + r.range(0.6, 2.5);
    }
    const y = periodic(dry, (x) => svf(svf(x, sr, "bp", r.range(500, 900), 3), sr, "lp", 1600, 0.7));
    for (let i = 0; i < n; i++) {
      L[i] += y[i] * Math.sqrt(0.5 * (1 - pan)) * 0.6;
      R[i] += y[i] * Math.sqrt(0.5 * (1 + pan)) * 0.6;
    }
  }
  for (const ch of [L, R]) {
    const r = new Rng(rng.next() * 1e9);
    const lap = new Float32Array(n);
    let t = 0;
    while (t < secs) {
      const m = samples(sr, 0.3);
      const s = svf(white(m, r), sr, "bp", r.range(250, 600), 1.5);
      applyEnv(s, lineEnv(sr, [[0, 0], [0.05, 1], [0.3, 0]]));
      addInto(lap, s, t * sr, r.range(0.3, 0.8), true);
      t += r.range(0.7, 1.8);
    }
    const hiss = periodic(white(n, r), (x) => svf(x, sr, "hp", 5500, 0.6));
    for (let i = 0; i < n; i++) ch[i] += lap[i] * 0.5 + hiss[i] * 0.025;
  }
  return [L, R];
}

export const BEDS = {
  surf: { seconds: 26, target: -20, render: surf },
  wind: { seconds: 20, target: -24, render: wind },
  jungle: { seconds: 16, target: -23, render: jungle },
  cicadas: { seconds: 18, target: -24, render: cicadas },
  stream: { seconds: 10, target: -24, render: stream },
  waterfall: { seconds: 10, target: -20, render: waterfall },
  cave: { seconds: 12, target: -28, render: cave },
  underwater: { seconds: 12, target: -20, render: underwater },
  mangrove: { seconds: 14, target: -27, render: mangrove },
} satisfies Record<string, BedDef>;

export type BedName = keyof typeof BEDS;
export const BED_NAMES = Object.keys(BEDS) as BedName[];

export function renderBed(name: BedName, sr: number): Chans {
  const def: BedDef = BEDS[name];
  const n = samples(sr, def.seconds);
  const chans = def.render(sr, new Rng(hashName("bed:" + name)), n);
  for (const c of chans) {
    let m = 0;
    for (let i = 0; i < n; i++) m += c[i];
    m /= n;
    for (let i = 0; i < n; i++) c[i] -= m;
  }
  const r = rmsOf(chans), p = peakOf(chans);
  let g = dbToGain(def.target) / Math.max(1e-9, r);
  if (p * g > dbToGain(-3)) g = dbToGain(-3) / p;
  for (const c of chans) scale(c, g);
  return chans;
}
