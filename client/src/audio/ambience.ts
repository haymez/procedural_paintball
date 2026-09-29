// Biome-aware ambience: crossfaded looping beds + sporadic positional events
// (birds, gulls, frogs, drips, bubbles, a distant church bell).

import { Rng, clamp, smooth01 } from "./dsp";
import { BED_NAMES, type BedName } from "./beds";
import type { Bank } from "./bank";
import type { AmbienceState, Dir2, PlayOpts, SfxName, SoundHandle, Vec3 } from "./types";

export interface AmbienceHost {
  readonly ctx: AudioContext;
  readonly bank: Bank;
  /** Beds that live "outside" (muffled in caves / under water). */
  readonly outdoorIn: AudioNode;
  /** Beds / events that are local to the listener's space (cave tone, underwater). */
  readonly insideIn: AudioNode;
  readonly outdoorFilter: BiquadFilterNode;
  readonly caveSend: GainNode;
  /** Target cave reverb send level (JS-side, so the engine can connect the convolver lazily). */
  caveWet: number;
  readonly worldFilter: BiquadFilterNode;
  listenerPos: Vec3;
  listenerFwd: Vec3;
  play(name: SfxName, opts: PlayOpts & { internalBus?: "ambOut" | "ambIn" }): SoundHandle;
}

interface Bed {
  src: AudioBufferSourceNode;
  gain: GainNode;
  pan: StereoPannerNode;
  filter: BiquadFilterNode | null;
  target: number;
  silentFor: number;
}

const OUTDOOR: Record<BedName, boolean> = {
  surf: true, wind: true, jungle: true, cicadas: true, stream: true, waterfall: true, mangrove: true, cave: false, underwater: false,
};
const FILTERED: Partial<Record<BedName, boolean>> = { surf: true, waterfall: true, stream: true };

const TICK = 0.1;

export class Ambience {
  private beds = new Map<BedName, Bed>();
  private state: AmbienceState | null = null;
  private lastUpdate = -1;
  private rng = new Rng(4242);
  private active = false;
  private bellQueue: number[] = [];
  private nextBellCheck = 0;
  private lastTod = -1;
  private randomBellAt = 0;
  private bellPos: Vec3 | null = null;
  gainTargets: Partial<Record<BedName, number>> = {};

  constructor(private readonly h: AmbienceHost) {}

  get bedCount(): number {
    return this.beds.size;
  }

  set(state: AmbienceState): void {
    this.state = state;
    this.active = true;
    const now = this.h.ctx.currentTime;
    if (now - this.lastUpdate >= TICK) {
      const dt = this.lastUpdate < 0 ? TICK : Math.min(0.5, now - this.lastUpdate);
      this.lastUpdate = now;
      this.update(dt);
    }
  }

  stop(fadeMs = 1500): void {
    this.active = false;
    this.state = null;
    const now = this.h.ctx.currentTime;
    for (const [name, b] of this.beds) {
      b.gain.gain.cancelScheduledValues(now);
      b.gain.gain.setTargetAtTime(0, now, fadeMs / 3000);
      b.target = 0;
      setTimeout(() => this.killBed(name, b), fadeMs + 200);
    }
    this.bellQueue = [];
    this.lastUpdate = -1;
    this.setFilters(false, 0, 0.3);
  }

  private killBed(name: BedName, b: Bed): void {
    if (this.beds.get(name) !== b || b.target > 0) return;
    try {
      b.src.stop();
    } catch {
      /* noop */
    }
    b.gain.disconnect();
    this.beds.delete(name);
  }

  private setFilters(underwater: boolean, cave: number, tau: number): void {
    const now = this.h.ctx.currentTime;
    const outdoorHz = underwater ? 380 : 20000 * Math.pow(700 / 20000, clamp(cave, 0, 1));
    this.h.outdoorFilter.frequency.setTargetAtTime(outdoorHz, now, tau);
    this.h.worldFilter.frequency.setTargetAtTime(underwater ? 650 : 20000, now, underwater ? 0.05 : tau);
    this.h.caveWet = 0.55 * clamp(cave, 0, 1);
    this.h.caveSend.gain.setTargetAtTime(this.h.caveWet, now, tau);
  }

  private update(dt: number): void {
    const s = this.state;
    if (!s || !this.active) return;
    const w = s.biomeWeights;
    const W = (k: keyof typeof w) => clamp(w[k] ?? 0, 0, 1);
    const cave = clamp(s.cave, 0, 1);
    const uw = s.underwater;
    const coast = Math.pow(clamp(1 - s.seaDistance / 150, 0, 1), 1.6);
    const altitude = clamp(s.altitude / 70, 0, 1);
    const tod = s.timeOfDay;
    const heat = 0.45 + 0.55 * smooth01((tod - 9) / 3) * (1 - 0.4 * smooth01((tod - 16.5) / 1.5));
    const river = Math.pow(clamp(1 - s.riverDistance / 40, 0, 1), 2);
    const fall = Math.pow(clamp(1 - s.waterfallDistance / 90, 0, 1), 1.5);

    const t: Record<BedName, number> = {
      surf: 0.05 + 0.95 * coast,
      wind: 0.14 + 0.5 * altitude + 0.35 * W("rock") + 0.12 * W("beach"),
      jungle: 0.9 * W("jungle") + 0.35 * W("mangrove"),
      cicadas: (0.85 * W("meadow") + 0.3 * W("rock") + 0.6 * W("village") + 0.15 * W("beach")) * heat,
      // near rivers; a soft trickle in the village doubles as the piazza fountain
      stream: Math.max(river, 0.18 * W("village")),
      waterfall: fall,
      mangrove: W("mangrove"),
      cave: cave,
      underwater: uw ? 1 : 0,
    };
    // outdoor beds duck inside caves and under water (plus the filter)
    const outdoorMul = (1 - 0.8 * cave) * (uw ? 0.45 : 1);
    for (const k of BED_NAMES) if (OUTDOOR[k]) t[k] *= outdoorMul;
    this.gainTargets = t;

    this.setFilters(uw, cave, 0.25);

    const now = this.h.ctx.currentTime;
    const fwd = this.h.listenerFwd;
    const panFor = (d: Dir2 | undefined, amt: number) => {
      if (!d) return 0;
      // right vector = forward × up(0,1,0) = (-fz, 0, fx)
      const len = Math.hypot(fwd.x, fwd.z) || 1;
      const rx = -fwd.z / len, rz = fwd.x / len;
      const dl = Math.hypot(d.x, d.z) || 1;
      return clamp(((d.x * rx + d.z * rz) / dl) * amt, -1, 1);
    };
    for (const name of BED_NAMES) {
      const target = t[name];
      let bed = this.beds.get(name);
      if (!bed && target > 0.004) bed = this.startBed(name) ?? undefined;
      if (!bed) continue;
      bed.target = target;
      bed.gain.gain.setTargetAtTime(target, now, 0.6);
      bed.silentFor = target <= 0.004 ? bed.silentFor + dt : 0;
      if (bed.silentFor > 6) this.killBed(name, bed);
      if (name === "surf") {
        bed.pan.pan.setTargetAtTime(panFor(s.dirs?.sea, 0.55 * (1 - coast * 0.5)), now, 0.4);
        bed.filter?.frequency.setTargetAtTime(700 + 16000 * coast * coast, now, 0.5);
      } else if (name === "waterfall") {
        bed.pan.pan.setTargetAtTime(panFor(s.dirs?.waterfall, 0.6), now, 0.4);
        bed.filter?.frequency.setTargetAtTime(900 + 15000 * fall * fall, now, 0.5);
      } else if (name === "stream") {
        bed.pan.pan.setTargetAtTime(panFor(s.dirs?.river, 0.5), now, 0.4);
        bed.filter?.frequency.setTargetAtTime(1500 + 15000 * river, now, 0.5);
      }
    }

    this.events(dt, s, { coast, cave, uw, river });
  }

  private startBed(name: BedName): Bed | null {
    const buf = this.h.bank.get("bed:" + name)?.[0];
    if (!buf) return null;
    const ctx = this.h.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const pan = ctx.createStereoPanner();
    let filter: BiquadFilterNode | null = null;
    let head: AudioNode = src;
    if (FILTERED[name]) {
      filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.Q.value = 0.5;
      head.connect(filter);
      head = filter;
    }
    head.connect(gain).connect(pan).connect(OUTDOOR[name] ? this.h.outdoorIn : this.h.insideIn);
    src.start(ctx.currentTime, this.rng.next() * buf.duration);
    const bed: Bed = { src, gain, pan, filter, target: 0, silentFor: 0 };
    this.beds.set(name, bed);
    return bed;
  }

  // ---------------------------------------------------------------- events

  private around(minD: number, maxD: number, hLo: number, hHi: number, dir?: Dir2, spreadRad = Math.PI): Vec3 {
    const p = this.h.listenerPos;
    let a = this.rng.range(-Math.PI, Math.PI);
    if (dir) a = Math.atan2(dir.z, dir.x) + this.rng.range(-spreadRad, spreadRad);
    const d = this.rng.range(minD, maxD);
    return { x: p.x + Math.cos(a) * d, y: p.y + this.rng.range(hLo, hHi), z: p.z + Math.sin(a) * d };
  }

  private fire(rate: number, dt: number): boolean {
    return rate > 0 && this.rng.next() < rate * dt;
  }

  private events(dt: number, s: AmbienceState, e: { coast: number; cave: number; uw: boolean; river: number }): void {
    const w = s.biomeWeights;
    const W = (k: keyof typeof w) => clamp(w[k] ?? 0, 0, 1);
    const outside = (1 - e.cave) * (e.uw ? 0 : 1);
    const day = smooth01((s.timeOfDay - 6) / 2);
    const out = (name: SfxName, pos: Vec3, vol = 1) => this.h.play(name, { pos, volume: vol, internalBus: "ambOut" });

    const jungle = W("jungle") + 0.4 * W("mangrove");
    if (this.fire(0.28 * jungle * outside, dt)) out("bird_whistle", this.around(10, 35, 4, 14), 0.9);
    if (this.fire(0.12 * jungle * outside, dt)) out("bird_trill", this.around(8, 30, 4, 12), 0.8);
    if (this.fire(0.035 * jungle * outside, dt)) out("parrot", this.around(20, 45, 6, 16), 0.7);
    const open = W("meadow") + 0.5 * W("village") + 0.3 * W("beach") + 0.3 * W("rock");
    if (this.fire(0.12 * open * outside * day, dt)) out("bird_song", this.around(10, 30, 2, 10), 0.8);
    if (this.fire(0.05 * (W("village") + 0.5 * W("meadow")) * outside, dt)) out("bird_coo", this.around(12, 35, 4, 10), 0.8);
    if (this.fire(0.1 * e.coast * outside, dt)) out("gull", this.around(20, 55, 10, 25, s.dirs?.sea, 0.9), 0.9);
    if (this.fire(0.25 * W("mangrove") * outside + 0.04 * e.river * outside, dt)) out("frog", this.around(6, 25, -1, 1), 0.8);
    if (this.fire(1.1 * e.cave * (e.uw ? 0 : 1), dt)) {
      this.h.play("drip", { pos: this.around(2, 14, 1, 5), volume: this.rng.range(0.4, 1), internalBus: "ambIn" });
    }
    if (e.uw && this.fire(0.5, dt)) this.h.play("bubbles", { pos: this.around(1, 5, -1, 2), volume: 0.5, internalBus: "ambIn" });

    this.bells(s, outside);
  }

  /** Church bell: tolls the hour (≤6 strokes) or two strokes on the half hour; occasionally otherwise. */
  private bells(s: AmbienceState, outside: number): void {
    const now = this.h.ctx.currentTime;
    const village = clamp(s.biomeWeights.village ?? 0, 0, 1);
    const audible = (village > 0.08 || (s.dirs?.village && village > 0.02)) && outside > 0.2;
    if (this.bellQueue.length && this.bellQueue[0] <= now) {
      this.bellQueue.shift();
      if (this.bellPos) this.h.play("bell", { pos: this.bellPos, volume: 0.55 + 0.45 * village, internalBus: "ambOut" });
    }
    if (now < this.nextBellCheck) return;
    this.nextBellCheck = now + 1;
    const tod = s.timeOfDay;
    let strokes = 0;
    if (this.lastTod >= 0 && tod !== this.lastTod) {
      const crossed = (mark: number) => this.lastTod < mark && tod >= mark;
      for (let h = Math.ceil(this.lastTod * 2) / 2; h <= tod; h += 0.5) {
        if (crossed(h)) strokes = Number.isInteger(h) ? Math.min(6, ((h + 11) % 12) + 1) : 2;
      }
    }
    this.lastTod = tod;
    if (!strokes && audible) {
      if (this.randomBellAt === 0) this.randomBellAt = now + this.rng.range(40, 90);
      if (now >= this.randomBellAt) {
        strokes = this.rng.int(2, 4);
        this.randomBellAt = now + this.rng.range(90, 180);
      }
    }
    if (strokes && audible && !this.bellQueue.length) {
      this.bellPos = this.around(120, 160, 15, 25, s.dirs?.village, s.dirs?.village ? 0.1 : Math.PI);
      for (let k = 0; k < strokes; k++) this.bellQueue.push(now + 0.2 + k * 2.3);
    }
  }
}
