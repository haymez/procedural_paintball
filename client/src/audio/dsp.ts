// Pure-JS DSP toolkit for rendering sounds into Float32Arrays.
// No DOM / Web Audio here: this runs in a Web Worker, on the main thread as a
// fallback, and in Node (vitest).

export const TAU = Math.PI * 2;

/** A rendered sound: one Float32Array per channel (1 = mono, 2 = stereo). */
export type Chans = Float32Array[];

/** mulberry32 — small, fast, good enough for audio randomness. */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 0x9e3779b9;
  }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  int(a: number, b: number): number {
    return Math.floor(this.range(a, b + 1));
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
  /** Bipolar uniform in [-1, 1). */
  bi(): number {
    return this.next() * 2 - 1;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

export function hashName(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export const samples = (sr: number, sec: number): number => Math.max(1, Math.round(sec * sr));
export const dbToGain = (db: number): number => Math.pow(10, db / 20);
export const gainToDb = (g: number): number => (g <= 1e-9 ? -180 : 20 * Math.log10(g));
export const mtof = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);
export const clamp = (x: number, a: number, b: number): number => (x < a ? a : x > b ? b : x);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smooth01 = (t: number): number => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};

// ---------------------------------------------------------------- noise

export function white(n: number, rng: Rng): Float32Array {
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) o[i] = rng.next() * 2 - 1;
  return o;
}

/** Pink-ish noise (Paul Kellet's refined filter), roughly unit peak. */
export function pink(n: number, rng: Rng): Float32Array {
  const o = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = rng.next() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    o[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return o;
}

/** Brown (red) noise via a leaky integrator, roughly unit peak. */
export function brown(n: number, rng: Rng): Float32Array {
  const o = new Float32Array(n);
  let y = 0;
  for (let i = 0; i < n; i++) {
    y = (y + 0.02 * (rng.next() * 2 - 1)) / 1.02;
    o[i] = y * 3.5;
  }
  return o;
}

// ---------------------------------------------------------------- filters

export type Mode = "lp" | "hp" | "bp" | "notch";
/** Cutoff / Q either constant or a function of the sample index. */
export type Param = number | ((i: number) => number);

/**
 * Topology-preserving-transform state variable filter (Zavalishin / Simper).
 * Stable under fast modulation. "bp" is normalised to unity gain at centre.
 * Params that are functions are re-evaluated every 16 samples.
 */
export function svf(x: Float32Array, sr: number, mode: Mode, cutoff: Param, q: Param = 0.707): Float32Array {
  const n = x.length;
  const o = new Float32Array(n);
  let ic1 = 0, ic2 = 0;
  let a1 = 0, a2 = 0, a3 = 0, k = 1;
  const nyq = sr * 0.49;
  const fc = typeof cutoff === "number" ? null : cutoff;
  const fq = typeof q === "number" ? null : q;
  const setup = (i: number) => {
    const f = clamp(fc ? fc(i) : (cutoff as number), 5, nyq);
    const qq = Math.max(0.05, fq ? fq(i) : (q as number));
    const g = Math.tan((Math.PI * f) / sr);
    k = 1 / qq;
    a1 = 1 / (1 + g * (g + k));
    a2 = g * a1;
    a3 = g * a2;
  };
  setup(0);
  const dyn = fc !== null || fq !== null;
  for (let i = 0; i < n; i++) {
    if (dyn && (i & 15) === 0) setup(i);
    const v0 = x[i];
    const v3 = v0 - ic2;
    const v1 = a1 * ic1 + a2 * v3;
    const v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1;
    ic2 = 2 * v2 - ic2;
    switch (mode) {
      case "lp": o[i] = v2; break;
      case "bp": o[i] = k * v1; break;
      case "hp": o[i] = v0 - k * v1 - v2; break;
      case "notch": o[i] = v0 - k * v1; break;
    }
  }
  return o;
}

/** One-pole lowpass/highpass (6 dB/oct). */
export function onePole(x: Float32Array, sr: number, mode: "lp" | "hp", fc: number): Float32Array {
  const o = new Float32Array(x.length);
  const a = Math.exp((-TAU * fc) / sr);
  let y = 0;
  for (let i = 0; i < x.length; i++) {
    y = (1 - a) * x[i] + a * y;
    o[i] = mode === "lp" ? y : x[i] - y;
  }
  return o;
}

/** Sum of parallel resonant bandpasses (modal body / formants). */
export function resonators(x: Float32Array, sr: number, modes: readonly (readonly [freq: number, q: number, gain: number])[]): Float32Array {
  const o = new Float32Array(x.length);
  for (const [f, q, g] of modes) {
    const y = svf(x, sr, "bp", f, q);
    for (let i = 0; i < o.length; i++) o[i] += y[i] * g;
  }
  return o;
}

/** Damped sinusoid bank (modal synthesis): freq Hz, T60-ish decay seconds, amp. */
export function modal(n: number, sr: number, modes: readonly (readonly [freq: number, decay: number, amp: number])[], rng?: Rng): Float32Array {
  const o = new Float32Array(n);
  for (const [f, d, a] of modes) {
    if (f >= sr * 0.49) continue;
    const w = (TAU * f) / sr;
    const r = Math.exp(-6.9 / (d * sr));
    // recursive oscillator: y[n] = 2 r cos(w) y[n-1] - r^2 y[n-2]
    const c = 2 * r * Math.cos(w);
    const r2 = r * r;
    const ph = rng ? rng.next() * 0.5 : 0;
    let y1 = Math.sin(ph) * a, y2 = Math.sin(ph - w) * a / r;
    for (let i = 0; i < n; i++) {
      const y = c * y1 - r2 * y2;
      o[i] += y1;
      y2 = y1;
      y1 = y;
    }
  }
  return o;
}

// ---------------------------------------------------------------- oscillators

export type Shape = "sine" | "saw" | "square" | "tri";

function polyBlep(t: number, dt: number): number {
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1;
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
}

/** Band-limited-ish oscillator with a frequency that may vary per sample. */
export function osc(n: number, sr: number, freq: Param, shape: Shape = "sine", phase0 = 0): Float32Array {
  const o = new Float32Array(n);
  const ff = typeof freq === "number" ? null : freq;
  let ph = phase0 - Math.floor(phase0);
  let tri = 0;
  for (let i = 0; i < n; i++) {
    const f = ff ? ff(i) : (freq as number);
    const dt = Math.min(0.49, Math.abs(f) / sr);
    let v: number;
    switch (shape) {
      case "sine": v = Math.sin(TAU * ph); break;
      case "saw": v = 2 * ph - 1 - polyBlep(ph, dt); break;
      case "square": {
        v = (ph < 0.5 ? 1 : -1) + polyBlep(ph, dt) - polyBlep((ph + 0.5) % 1, dt);
        break;
      }
      case "tri": {
        const sq = (ph < 0.5 ? 1 : -1) + polyBlep(ph, dt) - polyBlep((ph + 0.5) % 1, dt);
        tri = dt * sq * 4 + (1 - 0.002) * tri; // leaky integrated square
        v = tri;
        break;
      }
    }
    o[i] = v;
    ph += dt * Math.sign(f || 1);
    ph -= Math.floor(ph);
  }
  return o;
}

// ---------------------------------------------------------------- envelopes & mixing

/** Multiply in place by env(i). */
export function applyEnv(x: Float32Array, env: (i: number) => number): Float32Array {
  for (let i = 0; i < x.length; i++) x[i] *= env(i);
  return x;
}

/** Linear-attack, exponential-decay envelope in samples. tau = time constant. */
export function adEnv(sr: number, attack: number, tau: number, delay = 0): (i: number) => number {
  const a = Math.max(1, attack * sr), d = delay * sr, k = 1 / Math.max(1, tau * sr);
  return (i) => {
    const j = i - d;
    if (j < 0) return 0;
    return j < a ? j / a : Math.exp(-(j - a) * k);
  };
}

/** Piecewise-linear envelope from [time s, level] points. */
export function lineEnv(sr: number, pts: readonly (readonly [number, number])[]): (i: number) => number {
  const P = pts.map(([t, v]) => [t * sr, v] as const);
  return (i) => {
    if (i <= P[0][0]) return P[0][1];
    for (let k = 1; k < P.length; k++) {
      if (i <= P[k][0]) {
        const [t0, v0] = P[k - 1], [t1, v1] = P[k];
        return v0 + ((v1 - v0) * (i - t0)) / Math.max(1, t1 - t0);
      }
    }
    return P[P.length - 1][1];
  };
}

/** dst[off + i] += src[i] * gain, optionally wrapping around (for loops). */
export function addInto(dst: Float32Array, src: Float32Array, off: number, gain = 1, wrap = false): void {
  const n = dst.length;
  off = Math.round(off);
  if (wrap) {
    off = ((off % n) + n) % n;
    for (let i = 0; i < src.length; i++) dst[(off + i) % n] += src[i] * gain;
    return;
  }
  const s = Math.max(0, -off), e = Math.min(src.length, n - off);
  for (let i = s; i < e; i++) dst[off + i] += src[i] * gain;
}

export function scale(x: Float32Array, g: number): Float32Array {
  for (let i = 0; i < x.length; i++) x[i] *= g;
  return x;
}

export function mixTo(n: number, ...parts: [Float32Array, number][]): Float32Array {
  const o = new Float32Array(n);
  for (const [p, g] of parts) for (let i = 0; i < Math.min(n, p.length); i++) o[i] += p[i] * g;
  return o;
}

/** Soft saturation (tanh), drive > 0. */
export function saturate(x: Float32Array, drive: number): Float32Array {
  const norm = 1 / Math.tanh(drive);
  for (let i = 0; i < x.length; i++) x[i] = Math.tanh(x[i] * drive) * norm;
  return x;
}

export function fadeEdges(x: Float32Array, sr: number, inSec = 0.0006, outSec = 0.012): Float32Array {
  const a = Math.min(x.length, Math.ceil(inSec * sr));
  for (let i = 0; i < a; i++) x[i] *= i / a;
  const b = Math.min(x.length, Math.ceil(outSec * sr));
  for (let i = 0; i < b; i++) x[x.length - 1 - i] *= i / b;
  return x;
}

/** Trim trailing near-silence (below -70 dB relative to peak), keeping a fade. */
export function trimTail(chs: Chans, sr: number, floorDb = -70): Chans {
  let peak = 0;
  for (const c of chs) for (let i = 0; i < c.length; i++) peak = Math.max(peak, Math.abs(c[i]));
  const thr = peak * dbToGain(floorDb);
  let last = 0;
  for (const c of chs) for (let i = c.length - 1; i > last; i--) if (Math.abs(c[i]) > thr) { last = i; break; }
  const n = Math.min(chs[0].length, last + Math.ceil(0.01 * sr));
  return chs.map((c) => fadeEdges(c.slice(0, n), sr, 0, 0.01));
}

// ---------------------------------------------------------------- analysis & normalisation

export function peakOf(chs: Chans): number {
  let p = 0;
  for (const c of chs) for (let i = 0; i < c.length; i++) {
    const a = Math.abs(c[i]);
    if (a > p) p = a;
  }
  return p;
}

export function rmsOf(chs: Chans): number {
  let s = 0, n = 0;
  for (const c of chs) {
    for (let i = 0; i < c.length; i++) s += c[i] * c[i];
    n += c.length;
  }
  return Math.sqrt(s / Math.max(1, n));
}

/** Highest RMS over a sliding window (default 50 ms): a loudness proxy for transients. */
export function maxShortRms(chs: Chans, sr: number, win = 0.05): number {
  const w = Math.max(1, Math.round(win * sr));
  const n = chs[0].length;
  if (n <= w) return rmsOf(chs);
  let s = 0, best = 0;
  const sq = (i: number) => {
    let v = 0;
    for (const c of chs) v += c[i] * c[i];
    return v / chs.length;
  };
  for (let i = 0; i < w; i++) s += sq(i);
  best = s;
  for (let i = w; i < n; i++) {
    s += sq(i) - sq(i - w);
    if (s > best) best = s;
  }
  return Math.sqrt(Math.max(0, best) / w);
}

/**
 * Scale so the loudest 50 ms window sits at targetDb (RMS dBFS), then make sure
 * the sample peak stays under ceilDb. Returns the gain applied.
 */
export function normalize(chs: Chans, sr: number, targetDb: number, ceilDb = -1): number {
  const r = maxShortRms(chs, sr);
  const p = peakOf(chs);
  if (r <= 1e-9 || p <= 1e-9) return 1;
  let g = dbToGain(targetDb) / r;
  const ceil = dbToGain(ceilDb);
  if (p * g > ceil) g = ceil / p;
  for (const c of chs) scale(c, g);
  return g;
}

export function removeDC(x: Float32Array, sr: number): Float32Array {
  return onePole(x, sr, "hp", 15);
}

// ---------------------------------------------------------------- loops

/**
 * Render a seamless loop: `dry` is a periodic source of length n (build it with
 * wrap-around writes), `fx` a (possibly time-varying, periodic) processor. The
 * source is tiled so filters/reverbs reach steady state, and the last period
 * is returned — its end flows exactly into its start.
 */
export function periodic(dry: Float32Array, fx: (x: Float32Array) => Float32Array, warm = 1): Float32Array {
  const n = dry.length;
  const t = new Float32Array(n * (warm + 1));
  for (let k = 0; k <= warm; k++) t.set(dry, k * n);
  const y = fx(t);
  return y.slice(warm * n, (warm + 1) * n);
}

/** Periodic index helper for time-varying params inside `periodic`. */
export const modN = (n: number) => (i: number) => i % n;

/** Periodic smooth random curve (sum of a few sines with integer cycles per loop). */
export function periodicLfo(n: number, rng: Rng, minCycles: number, maxCycles: number, terms = 4): (i: number) => number {
  const parts: [number, number, number][] = [];
  let norm = 0;
  for (let k = 0; k < terms; k++) {
    const cyc = rng.int(minCycles, maxCycles);
    const a = 1 / (k + 1);
    parts.push([(TAU * cyc) / n, rng.next() * TAU, a]);
    norm += a;
  }
  return (i) => {
    let v = 0;
    for (const [w, p, a] of parts) v += Math.sin(w * i + p) * a;
    return v / norm; // in [-1, 1]
  };
}

// ---------------------------------------------------------------- synthesis building blocks

export interface PluckOpts {
  /** Seconds to decay 60 dB. */
  t60?: number;
  /** 0 dark … 1 bright (loop filter + excitation colour). */
  bright?: number;
  /** Pluck position 0..0.5 (comb on the excitation). */
  pick?: number;
  amp?: number;
}

/** Karplus–Strong plucked string with fractional-delay tuning. */
export function pluck(sr: number, f: number, dur: number, rng: Rng, o: PluckOpts = {}): Float32Array {
  const n = samples(sr, dur);
  const out = new Float32Array(n);
  const bright = clamp(o.bright ?? 0.6, 0, 1);
  const t60 = o.t60 ?? 1.5;
  const b = 0.5 - 0.42 * bright; // loop lowpass tap weight (0.5 = darkest)
  const P = sr / f;
  const dl = P - b;
  const N = Math.max(2, Math.floor(dl - 0.2));
  const frac = dl - N;
  const C = (1 - frac) / (1 + frac);
  const g = Math.pow(10, -3 / (f * t60));
  // excitation: coloured noise burst, pick-position comb, zero-mean
  let exc = white(N, rng);
  exc = onePole(exc, sr, "lp", 800 + 9000 * bright * bright);
  const pk = Math.max(1, Math.round(N * (o.pick ?? 0.18)));
  const e2 = new Float32Array(N);
  let mean = 0;
  for (let i = 0; i < N; i++) {
    e2[i] = exc[i] - (i >= pk ? exc[i - pk] : 0);
    mean += e2[i];
  }
  mean /= N;
  let ep = 0;
  for (let i = 0; i < N; i++) {
    e2[i] -= mean;
    ep = Math.max(ep, Math.abs(e2[i]));
  }
  const buf = new Float32Array(N);
  let idx = 0, prev = 0, apx = 0, apy = 0;
  const amp = (o.amp ?? 1) / Math.max(1e-6, ep);
  for (let i = 0; i < n; i++) {
    const d = buf[idx];
    const lp = (1 - b) * d + b * prev;
    prev = d;
    const ap = C * lp + apx - C * apy;
    apx = lp;
    apy = ap;
    const v = g * ap + (i < N ? e2[i] * amp : 0);
    buf[idx] = v;
    idx = idx + 1 === N ? 0 : idx + 1;
    out[i] = v;
  }
  return out;
}

/** Freeverb-style mono reverb (tail rendered into a longer buffer). */
export function reverb(x: Float32Array, sr: number, o: { size?: number; damp?: number; wet?: number; dry?: number; tail?: number } = {}): Float32Array {
  const size = o.size ?? 0.7, damp = o.damp ?? 0.4, wet = o.wet ?? 0.3, dry = o.dry ?? 1;
  const n = x.length + samples(sr, o.tail ?? 0);
  const s = sr / 44100;
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map((l) => Math.round(l * s));
  const aps = [556, 441, 341, 225].map((l) => Math.round(l * s));
  const fb = 0.7 + 0.28 * size;
  const out = new Float32Array(n);
  const acc = new Float32Array(n);
  for (const L of combs) {
    const buf = new Float32Array(L);
    let idx = 0, filt = 0;
    for (let i = 0; i < n; i++) {
      const y = buf[idx];
      filt = y * (1 - damp) + filt * damp;
      buf[idx] = (i < x.length ? x[i] * 0.015 : 0) + filt * fb;
      idx = idx + 1 === L ? 0 : idx + 1;
      acc[i] += y;
    }
  }
  for (const L of aps) {
    const buf = new Float32Array(L);
    let idx = 0;
    for (let i = 0; i < n; i++) {
      const b = buf[idx];
      const v = acc[i];
      acc[i] = -v + b;
      buf[idx] = v + b * 0.5;
      idx = idx + 1 === L ? 0 : idx + 1;
    }
  }
  for (let i = 0; i < n; i++) out[i] = (i < x.length ? x[i] * dry : 0) + acc[i] * wet;
  return out;
}

/**
 * Stereo impulse response for a ConvolverNode: sparse early reflections, then
 * an exponentially decaying noise tail that darkens over time.
 */
export function impulseResponse(sr: number, seconds: number, o: { t60?: number; pre?: number; bright?: number; early?: number; seed?: number } = {}): Chans {
  const rng = new Rng(o.seed ?? 1234);
  const n = samples(sr, seconds);
  const t60 = o.t60 ?? seconds * 0.8;
  const pre = samples(sr, o.pre ?? 0.012);
  const chans: Chans = [];
  for (let c = 0; c < 2; c++) {
    let x: Float32Array = new Float32Array(n);
    for (let i = pre; i < n; i++) {
      const t = (i - pre) / sr;
      x[i] = (rng.next() * 2 - 1) * Math.exp((-6.9 * t) / t60) * Math.min(1, t / 0.02 + 0.2);
    }
    const bright = o.bright ?? 0.5;
    x = svf(x, sr, "lp", (i) => 1200 + (9000 * bright) * Math.exp(-(i - pre) / (sr * t60 * 0.35)), 0.6);
    const early = o.early ?? 0.6;
    for (let k = 0; k < 10; k++) {
      const at = pre + samples(sr, rng.range(0.003, 0.07));
      if (at < n) x[at] += rng.bi() * early * (1 - k / 12);
    }
    chans.push(x);
  }
  // normalise each channel's energy so a full-scale input gives a reverb of similar loudness
  for (const c of chans) {
    let e = 0;
    for (let i = 0; i < c.length; i++) e += c[i] * c[i];
    scale(c, 0.7 / Math.max(1e-9, Math.sqrt(e)));
  }
  return chans;
}

/** Stereo decorrelate a mono signal with two short all-pass chains. */
export function stereoize(x: Float32Array, sr: number, width = 0.5, seed = 7): Chans {
  const rng = new Rng(seed);
  const mk = () => {
    let y = x;
    for (let k = 0; k < 3; k++) {
      const L = Math.round(rng.range(0.002, 0.012) * sr);
      const buf = new Float32Array(L);
      const o = new Float32Array(y.length);
      let idx = 0;
      const g = 0.5;
      for (let i = 0; i < y.length; i++) {
        const b = buf[idx];
        const v = y[i] + g * b;
        o[i] = b - g * v;
        buf[idx] = v;
        idx = idx + 1 === L ? 0 : idx + 1;
      }
      y = o;
    }
    return y;
  };
  const a = mk(), b = mk();
  const L = new Float32Array(x.length), R = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    L[i] = x[i] * (1 - width) + a[i] * width;
    R[i] = x[i] * (1 - width) + b[i] * width;
  }
  return [L, R];
}
