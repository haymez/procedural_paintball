// Isola audio engine (Web Audio). All sounds are synthesised at startup in
// workers (see recipes.ts / beds.ts / instruments.ts) — no audio files.
//
// Usage (game):
//   const audio = getAudio();                 // singleton; starts rendering immediately
//   button.onclick = () => audio.unlock();    // (also auto-unlocks on first pointer/key)
//   audio.music.play("menu");                 // menus only
//   // each frame in a match:
//   audio.setListener(camPos, camForward);
//   audio.setAmbience({ biomeWeights, seaDistance, ... });
//   audio.play("shoot", { pos });  audio.play("hit_me");
//   const eng = audio.loop("vespa_engine", { pos }); eng.setPitch(1 + speed / 10); eng.setPos(p); eng.stop();
//
// Graph:
//   world voices ─► worldIn ─► worldFilter(lp: underwater) ─► worldDuck ─► sfxVol ─┐
//                    └► caveSend ─► convolver ─┘                                      │
//   self voices ──► selfIn ──────────────────────────────────────────► sfxVol ──────┤
//   ui voices ────► uiIn ────────────────────────────────────────────► sfxVol ──────┤
//   outdoor beds/events ─► outdoorIn ─► outdoorFilter ─► ambDuck ─► ambVol ─────────┤
//   cave/underwater beds, drips ─► insideIn ─► ambDuck (+ caveSend)                  │
//   music ─► musicVol ───────────────────────────────────────────────────────────── master ─► limiter ─► out

import { Rng, clamp } from "./dsp";
import { SFX, SFX_NAMES, type SfxDef } from "./recipes";
import { BED_NAMES } from "./beds";
import { Bank } from "./bank";
import { Ambience, type AmbienceHost } from "./ambience";
import { MusicPlayer } from "./music";
import type { Job } from "./render";
import type {
  AmbienceState, AudioEngine, AudioStats, Category, PlayOpts, SfxName, SoundHandle, Vec3, Volumes,
} from "./types";

export * from "./types";
export { SFX_NAMES } from "./recipes";
export { BED_NAMES } from "./beds";

const STORE_KEY = "isola.audio.v1";
const MAX_VOICES = 48;
const DEFAULT_VOL: Volumes = { master: 0.8, sfx: 0.9, ambience: 0.75, music: 0.6 };

/** Order in which sounds are rendered: what's heard first comes first. */
const PRIORITY: SfxName[] = [
  "ui_click", "ui_hover", "ui_confirm", "ui_back", "countdown_tick", "countdown_go", "match_start", "match_end",
  "shoot", "shoot_empty", "reload", "whiz", "splat_ground", "splat_player", "hit_me", "hitmarker", "hitmarker_kill",
  "eliminate", "respawn", "killfeed", "step_sand", "step_grass", "step_stone", "step_wood", "step_water", "jump", "land",
];

type InternalBus = Category | "ambOut" | "ambIn";
type IPlayOpts = PlayOpts & { internalBus?: "ambOut" | "ambIn" };

const NULL_HANDLE: SoundHandle = Object.freeze({
  stop() {},
  setPos() {},
  setVolume() {},
  setPitch() {},
  playing: false,
});

function loadVolumes(): { v: Volumes; muted: boolean } {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const j = JSON.parse(raw) as Partial<Volumes> & { muted?: boolean };
      return {
        v: {
          master: clamp(Number(j.master ?? DEFAULT_VOL.master), 0, 1),
          sfx: clamp(Number(j.sfx ?? DEFAULT_VOL.sfx), 0, 1),
          ambience: clamp(Number(j.ambience ?? DEFAULT_VOL.ambience), 0, 1),
          music: clamp(Number(j.music ?? DEFAULT_VOL.music), 0, 1),
        },
        muted: !!j.muted,
      };
    }
  } catch {
    /* private mode etc. */
  }
  return { v: { ...DEFAULT_VOL }, muted: false };
}

class Voice implements SoundHandle {
  src: AudioBufferSourceNode;
  gain: GainNode;
  air: BiquadFilterNode | null = null;
  panner: PannerNode | null = null;
  playing = true;
  readonly born: number;
  private baseVol: number;

  constructor(
    private readonly eng: Engine,
    readonly name: SfxName,
    readonly def: SfxDef,
    buf: AudioBuffer,
    opts: IPlayOpts,
    readonly isLoop: boolean,
    dest: AudioNode,
  ) {
    const ctx = eng.ctx;
    this.born = ctx.currentTime;
    this.src = ctx.createBufferSource();
    this.src.buffer = buf;
    this.src.loop = isLoop;
    const pj = opts.pitchJitter ?? def.pj ?? 0;
    const semis = pj ? eng.rng.bi() * pj : 0;
    this.src.playbackRate.value = (opts.pitch ?? 1) * Math.pow(2, semis / 12);
    this.gain = ctx.createGain();
    const vj = def.cat === "ui" || isLoop ? 1 : Math.pow(10, (eng.rng.bi() * 1.5) / 20);
    this.baseVol = (opts.volume ?? 1) * (def.vol ?? 1);
    this.gain.gain.value = this.baseVol * vj;
    let head: AudioNode = this.src;
    if (opts.lowpass) {
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = opts.lowpass;
      head.connect(lp);
      head = lp;
    }
    head.connect(this.gain);
    head = this.gain;
    if (opts.pos) {
      this.air = ctx.createBiquadFilter();
      this.air.type = "lowpass";
      this.air.Q.value = 0.5;
      const p = ctx.createPanner();
      p.panningModel = eng.panningModel;
      p.distanceModel = "inverse";
      p.refDistance = def.ref ?? 2;
      p.rolloffFactor = def.rolloff ?? 1;
      p.maxDistance = 10000;
      this.panner = p;
      head.connect(this.air).connect(p);
      head = p;
      this.setPos(opts.pos);
    }
    head.connect(dest);
    const when = ctx.currentTime + Math.max(0, opts.delay ?? 0);
    if (isLoop) this.src.start(when, eng.rng.next() * buf.duration);
    else this.src.start(when);
    this.src.onended = () => this.cleanup();
  }

  setPos(p: Vec3): void {
    if (!this.panner) return;
    const pn = this.panner;
    if (pn.positionX) {
      pn.positionX.value = p.x;
      pn.positionY.value = p.y;
      pn.positionZ.value = p.z;
    } else {
      (pn as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(p.x, p.y, p.z);
    }
    if (this.air) {
      const d = this.eng.distanceTo(p);
      this.air.frequency.value = clamp(22000 * Math.exp(-d / 32), 1500, 22000);
    }
  }

  setVolume(v: number, rampMs = 60): void {
    this.baseVol = v * (this.def.vol ?? 1);
    this.gain.gain.setTargetAtTime(this.baseVol, this.eng.ctx.currentTime, rampMs / 3000);
  }

  setPitch(rate: number, rampMs = 60): void {
    this.src.playbackRate.setTargetAtTime(clamp(rate, 0.05, 8), this.eng.ctx.currentTime, rampMs / 3000);
  }

  stop(fadeMs = 30): void {
    if (!this.playing) return;
    const t = this.eng.ctx.currentTime;
    const f = Math.max(0.005, fadeMs / 1000);
    this.gain.gain.cancelScheduledValues(t);
    this.gain.gain.setValueAtTime(this.gain.gain.value, t);
    this.gain.gain.linearRampToValueAtTime(0, t + f);
    try {
      this.src.stop(t + f + 0.01);
    } catch {
      /* not started */
    }
    this.playing = false;
    this.eng.forget(this);
  }

  cleanup(): void {
    this.playing = false;
    this.eng.forget(this);
    this.src.disconnect();
    this.gain.disconnect();
    this.air?.disconnect();
    this.panner?.disconnect();
  }
}

/** A loop handle that may be created before its buffer has been rendered. */
class PendingLoop implements SoundHandle {
  voice: Voice | null = null;
  playing = true;
  private pos?: Vec3;
  private vol: number;
  private pitch: number;
  constructor(eng: Engine, name: SfxName, private readonly opts: IPlayOpts) {
    this.pos = opts.pos;
    this.vol = opts.volume ?? 1;
    this.pitch = opts.pitch ?? 1;
    void eng.bank.whenReady("sfx:" + name).then(() => {
      if (!this.playing) return;
      this.voice = eng.startVoice(name, { ...this.opts, pos: this.pos, volume: this.vol, pitch: this.pitch }, true);
    });
  }
  stop(fadeMs?: number): void {
    this.playing = false;
    this.voice?.stop(fadeMs ?? 150);
  }
  setPos(p: Vec3): void {
    this.pos = p;
    this.voice?.setPos(p);
  }
  setVolume(v: number, rampMs?: number): void {
    this.vol = v;
    this.voice?.setVolume(v, rampMs);
  }
  setPitch(r: number, rampMs?: number): void {
    this.pitch = r;
    this.voice?.setPitch(r, rampMs);
  }
}

class Engine implements AudioEngine, AmbienceHost {
  readonly ctx: AudioContext;
  readonly bank: Bank;
  readonly rng = new Rng(Date.now() >>> 0);
  readonly ready: Promise<void>;
  readonly fullyLoaded: Promise<void>;
  readonly music: MusicPlayer;
  panningModel: PanningModelType = "HRTF";

  listenerPos: Vec3 = { x: 0, y: 0, z: 0 };
  listenerFwd: Vec3 = { x: 0, y: 0, z: -1 };

  private readonly master: GainNode;
  private readonly sfxVol: GainNode;
  private readonly ambVol: GainNode;
  private readonly musicVol: GainNode;
  private readonly worldIn: GainNode;
  readonly worldFilter: BiquadFilterNode;
  private readonly worldDuck: GainNode;
  private readonly selfIn: GainNode;
  private readonly uiIn: GainNode;
  readonly outdoorIn: GainNode;
  readonly outdoorFilter: BiquadFilterNode;
  readonly insideIn: GainNode;
  private readonly ambDuck: GainNode;
  readonly caveSend: GainNode;
  private readonly convolver: ConvolverNode;

  private vols: Volumes;
  private _muted: boolean;
  private _unlocked = false;
  private voices: Voice[] = [];
  private loops = new Set<Voice>();
  private lastVariant = new Map<SfxName, number>();
  private readonly ambience: Ambience;
  private breath: number | null = null;
  private nextBeat = 0;
  private timer: ReturnType<typeof setInterval>;

  constructor() {
    const AC: typeof AudioContext = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new AC({ latencyHint: "interactive" });
    const ctx = this.ctx;
    this.bank = new Bank(ctx);
    const { v, muted } = loadVolumes();
    this.vols = v;
    this._muted = muted;

    const gain = (v = 1) => {
      const g = ctx.createGain();
      g.gain.value = v;
      return g;
    };
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -4;
    limiter.knee.value = 3;
    limiter.ratio.value = 16;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.2;
    this.master = gain(muted ? 0 : v.master);
    this.master.connect(limiter).connect(ctx.destination);

    this.sfxVol = gain(v.sfx);
    this.sfxVol.connect(this.master);
    this.ambVol = gain(v.ambience);
    this.ambVol.connect(this.master);
    this.musicVol = gain(v.music);
    this.musicVol.connect(this.master);

    this.worldIn = gain();
    this.worldFilter = ctx.createBiquadFilter();
    this.worldFilter.type = "lowpass";
    this.worldFilter.frequency.value = 20000;
    this.worldFilter.Q.value = 0.6;
    this.worldDuck = gain();
    this.worldIn.connect(this.worldFilter).connect(this.worldDuck).connect(this.sfxVol);
    this.selfIn = gain();
    this.selfIn.connect(this.sfxVol);
    this.uiIn = gain();
    this.uiIn.connect(this.sfxVol);

    this.caveSend = gain(0);
    this.convolver = ctx.createConvolver();
    this.convolver.normalize = false;
    this.worldIn.connect(this.caveSend);
    this.selfIn.connect(this.caveSend);
    this.convolver.connect(this.worldFilter); // caveSend → convolver is connected only while in a cave (see tick)

    this.ambDuck = gain();
    this.ambDuck.connect(this.ambVol);
    this.outdoorIn = gain();
    this.outdoorFilter = ctx.createBiquadFilter();
    this.outdoorFilter.type = "lowpass";
    this.outdoorFilter.frequency.value = 20000;
    this.outdoorFilter.Q.value = 0.5;
    this.outdoorIn.connect(this.outdoorFilter).connect(this.ambDuck);
    this.insideIn = gain();
    this.insideIn.connect(this.ambDuck);
    const insideSend = gain(0.8);
    this.insideIn.connect(insideSend).connect(this.caveSend);

    this.ambience = new Ambience(this);
    this.music = new MusicPlayer(ctx, this.bank, this.musicVol);

    // ---- render everything, most urgent first
    const sfxJob = (name: SfxName): Job => ({ key: "sfx:" + name, kind: "sfx", name });
    const first = PRIORITY.map(sfxJob);
    const rest = SFX_NAMES.filter((n) => !PRIORITY.includes(n)).map(sfxJob);
    const music = this.music.preload();
    const sfx = this.bank.request([...first, ...rest], 0);
    const heavy = this.bank.request([{ key: "ir:cave", kind: "ir", name: "cave" }, ...BED_NAMES.map((name): Job => ({ key: "bed:" + name, kind: "bed", name }))], 1);
    void this.bank.whenReady("ir:cave").then(() => {
      this.convolver.buffer = this.bank.get("ir:cave")![0];
    });
    this.ready = Promise.all([sfx, music]).then(() => undefined);
    this.fullyLoaded = Promise.all([this.ready, heavy]).then(() => undefined);

    // auto-unlock on the first gesture
    const onGesture = () => {
      void this.unlock();
      if (this._unlocked) {
        removeEventListener("pointerdown", onGesture, true);
        removeEventListener("keydown", onGesture, true);
        removeEventListener("touchend", onGesture, true);
      }
    };
    addEventListener("pointerdown", onGesture, true);
    addEventListener("keydown", onGesture, true);
    addEventListener("touchend", onGesture, true);

    this.timer = setInterval(() => this.tick(), 50);
  }

  get unlocked(): boolean {
    return this._unlocked;
  }
  get muted(): boolean {
    return this._muted;
  }

  async unlock(): Promise<void> {
    if (this.ctx.state !== "running") {
      // a 1-sample silent blip satisfies iOS Safari's "must start in gesture" rule
      const b = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
      const s = this.ctx.createBufferSource();
      s.buffer = b;
      s.connect(this.ctx.destination);
      s.start();
      try {
        await this.ctx.resume();
      } catch {
        /* not allowed yet */
      }
    }
    this._unlocked = this.ctx.state === "running";
  }

  // ---------------------------------------------------------------- volumes

  private persist(): void {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ ...this.vols, muted: this._muted }));
    } catch {
      /* ignore */
    }
  }

  setVolume(bus: keyof Volumes, v: number): void {
    v = clamp(v, 0, 1);
    this.vols[bus] = v;
    const node = { master: this.master, sfx: this.sfxVol, ambience: this.ambVol, music: this.musicVol }[bus];
    const target = bus === "master" && this._muted ? 0 : v;
    node.gain.setTargetAtTime(target, this.ctx.currentTime, 0.03);
    this.persist();
  }

  getVolumes(): Volumes {
    return { ...this.vols };
  }

  setMuted(m: boolean): void {
    this._muted = m;
    this.master.gain.setTargetAtTime(m ? 0 : this.vols.master, this.ctx.currentTime, 0.03);
    this.persist();
  }

  // ---------------------------------------------------------------- listener

  setListener(pos: Vec3, forward: Vec3, up: Vec3 = { x: 0, y: 1, z: 0 }): void {
    this.listenerPos = { x: pos.x, y: pos.y, z: pos.z };
    this.listenerFwd = { x: forward.x, y: forward.y, z: forward.z };
    const l = this.ctx.listener;
    if (l.positionX) {
      l.positionX.value = pos.x;
      l.positionY.value = pos.y;
      l.positionZ.value = pos.z;
      l.forwardX.value = forward.x;
      l.forwardY.value = forward.y;
      l.forwardZ.value = forward.z;
      l.upX.value = up.x;
      l.upY.value = up.y;
      l.upZ.value = up.z;
    } else {
      const ll = l as unknown as { setPosition(x: number, y: number, z: number): void; setOrientation(a: number, b: number, c: number, d: number, e: number, f: number): void };
      ll.setPosition(pos.x, pos.y, pos.z);
      ll.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
    }
  }

  distanceTo(p: Vec3): number {
    const l = this.listenerPos;
    return Math.hypot(p.x - l.x, p.y - l.y, p.z - l.z);
  }

  // ---------------------------------------------------------------- voices

  private busNode(b: InternalBus): AudioNode {
    switch (b) {
      case "world": return this.worldIn;
      case "self": return this.selfIn;
      case "ui": return this.uiIn;
      case "amb":
      case "ambOut": return this.outdoorIn;
      case "ambIn": return this.insideIn;
    }
  }

  startVoice(name: SfxName, opts: IPlayOpts, isLoop: boolean): Voice | null {
    const def: SfxDef = SFX[name];
    const bufs = this.bank.get("sfx:" + name);
    if (!bufs) return null;
    if (opts.pos && !isLoop && this.distanceTo(opts.pos) > (def.maxDist ?? 70)) return null;
    // pick a variant, avoiding an immediate repeat
    let vi = Math.floor(this.rng.next() * bufs.length);
    if (bufs.length > 1 && vi === this.lastVariant.get(name)) vi = (vi + 1) % bufs.length;
    this.lastVariant.set(name, vi);
    if (!isLoop) {
      const same = this.voices.filter((v) => v.name === name);
      if (same.length >= (def.max ?? 6)) same[0].stop(15);
      if (this.voices.length >= MAX_VOICES) {
        // steal the oldest ambience voice if any, else the oldest voice
        (this.voices.find((v) => v.def.cat === "amb") ?? this.voices[0]).stop(15);
      }
    }
    const bus: InternalBus = opts.internalBus ?? opts.bus ?? def.cat;
    const v = new Voice(this, name, def, bufs[vi], opts, isLoop, this.busNode(bus));
    if (isLoop) this.loops.add(v);
    else this.voices.push(v);
    return v;
  }

  forget(v: Voice): void {
    const i = this.voices.indexOf(v);
    if (i >= 0) this.voices.splice(i, 1);
    this.loops.delete(v);
  }

  play(name: SfxName, opts: IPlayOpts = {}): SoundHandle {
    if (this.ctx.state !== "running" && !this.offlineOk) return NULL_HANDLE;
    return this.startVoice(name, opts, false) ?? NULL_HANDLE;
  }

  /** Allow play() while the context is suspended (test bench only). */
  offlineOk = false;

  loop(name: SfxName, opts: PlayOpts = {}): SoundHandle {
    if (this.bank.has("sfx:" + name)) return this.startVoice(name, opts, true) ?? NULL_HANDLE;
    return new PendingLoop(this, name, opts);
  }

  // ---------------------------------------------------------------- ambience & mix

  setAmbience(state: AmbienceState): void {
    this.ambience.set(state);
  }

  stopAmbience(fadeMs = 1500): void {
    this.ambience.stop(fadeMs);
    this.setBreath(null);
  }

  duck(amount: number, ms: number): void {
    const now = this.ctx.currentTime;
    const a = clamp(amount, 0, 1);
    const dur = Math.max(0.05, ms / 1000);
    for (const [g, k] of [[this.worldDuck, 0.6], [this.ambDuck, 1]] as const) {
      const p = g.gain;
      p.cancelScheduledValues(now);
      p.setValueAtTime(p.value, now);
      p.linearRampToValueAtTime(1 - a * k, now + 0.03);
      p.setValueAtTime(1 - a * k, now + 0.03 + dur * 0.25);
      p.setTargetAtTime(1, now + 0.03 + dur * 0.25, dur * 0.25);
    }
  }

  setBreath(fraction: number | null): void {
    this.breath = fraction === null ? null : clamp(fraction, 0, 1);
  }

  private reverbOn = false;
  caveWet = 0;
  private reverbIdle = 0;

  private tick(): void {
    if (this.ctx.state !== "running") return;
    const now = this.ctx.currentTime;
    // the cave convolver is the most expensive node: keep it out of the graph when unused
    const wet = this.caveWet > 0.002;
    if (wet && !this.reverbOn && this.convolver.buffer) {
      this.caveSend.connect(this.convolver);
      this.reverbOn = true;
    }
    this.reverbIdle = wet ? 0 : this.reverbIdle + 0.05;
    if (this.reverbOn && this.reverbIdle > 4) {
      this.caveSend.disconnect(this.convolver);
      this.reverbOn = false;
    }
    // heartbeat when breath is low
    if (this.breath !== null && this.breath < 0.4) {
      const u = 1 - this.breath / 0.4;
      if (this.nextBeat < now) this.nextBeat = now + 0.05;
      if (this.nextBeat < now + 0.2) {
        this.play("heartbeat", { volume: 0.35 + 0.65 * u, delay: this.nextBeat - now });
        this.nextBeat += 0.95 - 0.45 * u;
      }
    }
  }

  stats(): AudioStats {
    return {
      state: this.ctx.state,
      voices: this.voices.length,
      loops: this.loops.size,
      beds: this.ambience.bedCount,
      musicSources: this.music.sources,
      loaded: SFX_NAMES.filter((n) => this.bank.has("sfx:" + n)).length + BED_NAMES.filter((n) => this.bank.has("bed:" + n)).length,
      pending: SFX_NAMES.filter((n) => !this.bank.has("sfx:" + n)).length + BED_NAMES.filter((n) => !this.bank.has("bed:" + n)).length,
    };
  }

  /** Test-bench internals. */
  get debug() {
    return { ambience: this.ambience, bank: this.bank, voices: this.voices, loops: this.loops, master: this.master, reverbOn: this.reverbOn };
  }

  dispose(): void {
    clearInterval(this.timer);
    this.bank.dispose();
    void this.ctx.close();
  }
}

let singleton: Engine | null = null;

/** Create the audio engine (or return the existing one). Safe to call before any user gesture. */
export function createAudio(): AudioEngine {
  singleton ??= new Engine();
  return singleton;
}
export const getAudio = createAudio;

export type { Engine as AudioEngineImpl };
