// Menu music player: a look-ahead scheduler ("tale of two clocks") that turns
// song.ts bar events into pre-rendered note buffers, plus results jingles.
// Also usable against an OfflineAudioContext for headless analysis.

import { Rng } from "./dsp";
import { NOTE_LEN, SUSTAINED, noteKey, type Inst } from "./instruments";
import { BAR, barEvents, jingleEvents, neededNotes, type NoteEv } from "./song";
import type { Bank } from "./bank";
import type { Job } from "./render";
import type { JingleKind, MusicControl, MusicTrack } from "./types";

const INST_GAIN: Record<Inst, number> = {
  mandolin: 0.95,
  guitar: 0.62,
  bass: 0.5,
  accordion: 0.8,
  whistle: 0.55,
  shaker: 0.22,
};

export function musicJobs(): Job[] {
  return neededNotes().map(({ inst, midi }) => ({ key: "note:" + noteKey(inst, midi), kind: "note", inst, midi }));
}

interface Active {
  src: AudioBufferSourceNode;
  g: GainNode;
  end: number;
}

/** Schedule one note into `dest` at absolute context time `t`. */
export function scheduleNote(ctx: BaseAudioContext, bank: Bank, dest: AudioNode, ev: NoteEv, t: number, rng: Rng, active?: Active[]): void {
  const buf = bank.get("note:" + noteKey(ev.inst, ev.midi))?.[0];
  if (!buf) return;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = Math.pow(2, rng.range(-3, 3) / 1200);
  const g = ctx.createGain();
  const level = ev.vel * INST_GAIN[ev.inst];
  t = Math.max(t, ctx.currentTime);
  g.gain.setValueAtTime(level, t);
  let end: number;
  if (SUSTAINED[ev.inst]) {
    const rel = Math.min(ev.len, NOTE_LEN[ev.inst] - 0.35);
    g.gain.setTargetAtTime(0, t + rel, 0.06);
    end = t + rel + 0.4;
  } else {
    const tau = ev.inst === "mandolin" && ev.len < 0.12 ? 0.025 : ev.inst === "guitar" ? 0.25 : 0.12;
    const rel = Math.min(ev.len, NOTE_LEN[ev.inst]);
    g.gain.setTargetAtTime(0, t + rel, tau);
    end = Math.min(t + NOTE_LEN[ev.inst], t + rel + tau * 7);
  }
  src.connect(g).connect(dest);
  src.start(t);
  src.stop(end);
  if (active) {
    const a = { src, g, end };
    active.push(a);
    src.onended = () => {
      g.disconnect();
      const i = active.indexOf(a);
      if (i >= 0) active.splice(i, 1);
    };
  }
}

/** Build the music output chain (dry + small hall reverb) into `dest`. Returns the input node. */
export function musicChain(ctx: BaseAudioContext, bank: Bank, dest: AudioNode): GainNode {
  const input = ctx.createGain();
  const dry = ctx.createGain();
  dry.gain.value = 1.15;
  input.connect(dry).connect(dest);
  const ir = bank.get("ir:hall")?.[0];
  if (ir) {
    const conv = ctx.createConvolver();
    conv.normalize = false;
    conv.buffer = ir;
    const wet = ctx.createGain();
    wet.gain.value = 0.4;
    input.connect(conv).connect(wet).connect(dest);
  }
  return input;
}

/** Render `seconds` of the menu loop (from bar 0) into an offline context. */
export function scheduleOffline(ctx: BaseAudioContext, bank: Bank, dest: AudioNode, seconds: number, seed = 1, startBar = 0): void {
  const rng = new Rng(seed);
  const input = musicChain(ctx, bank, dest);
  for (let b = 0; b * BAR < seconds; b++) {
    for (const ev of barEvents(startBar + b, rng)) scheduleNote(ctx, bank, input, ev, 0.05 + b * BAR + ev.at, rng);
  }
}

export function scheduleJingleOffline(ctx: BaseAudioContext, bank: Bank, dest: AudioNode, kind: JingleKind): void {
  const rng = new Rng(3);
  const input = musicChain(ctx, bank, dest);
  for (const ev of jingleEvents(kind)) scheduleNote(ctx, bank, input, ev, 0.05 + ev.at, rng);
}

export class MusicPlayer implements MusicControl {
  private loopGain: GainNode | null = null;
  private input: GainNode | null = null;
  private active: Active[] = [];
  private bar = 0;
  private barTime = 0;
  private rng = new Rng((Date.now() & 0xffff) + 1);
  private want = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private loaded: Promise<void> | null = null;

  constructor(private readonly ctx: AudioContext, private readonly bank: Bank, private readonly bus: AudioNode) {}

  get playing(): boolean {
    return this.want;
  }

  /** Kick off note rendering (idempotent). */
  preload(): Promise<void> {
    this.loaded ??= this.bank.request([{ key: "ir:hall", kind: "ir", name: "hall" }, ...musicJobs()], 0);
    return this.loaded;
  }

  private ensureChain(): GainNode {
    if (!this.input) this.input = musicChain(this.ctx, this.bank, this.bus);
    return this.input;
  }

  play(_track: MusicTrack = "menu", fadeMs = 1500): void {
    if (this.want) return;
    this.want = true;
    void this.preload().then(() => {
      if (!this.want || this.loopGain) return;
      const input = this.ensureChain();
      const g = this.ctx.createGain();
      g.connect(input);
      const now = this.ctx.currentTime;
      g.gain.setValueAtTime(0.0001, now);
      g.gain.linearRampToValueAtTime(1, now + fadeMs / 1000);
      this.loopGain = g;
      this.bar = 0;
      this.barTime = now + 0.12;
      this.tick();
      this.timer = setInterval(() => this.tick(), 50);
    });
  }

  stop(fadeMs = 1500): void {
    this.want = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const g = this.loopGain;
    this.loopGain = null;
    if (!g) return;
    const now = this.ctx.currentTime;
    g.gain.cancelScheduledValues(now);
    g.gain.setValueAtTime(g.gain.value, now);
    g.gain.linearRampToValueAtTime(0, now + Math.max(0.02, fadeMs / 1000));
    const doomed = this.active.slice();
    this.active = [];
    setTimeout(() => {
      for (const a of doomed) {
        try {
          a.src.stop();
        } catch {
          /* already stopped */
        }
      }
      g.disconnect();
    }, fadeMs + 100);
  }

  jingle(kind: JingleKind): void {
    this.stop(400);
    void this.preload().then(() => {
      const input = this.ensureChain();
      const t0 = this.ctx.currentTime + 0.3;
      const rng = new Rng(kind === "win" ? 5 : 6);
      for (const ev of jingleEvents(kind)) scheduleNote(this.ctx, this.bank, input, ev, t0 + ev.at, rng);
    });
  }

  private tick(): void {
    if (!this.want || !this.loopGain) return;
    const hidden = typeof document !== "undefined" && document.hidden;
    const ahead = hidden ? 1.6 : 0.35;
    const now = this.ctx.currentTime;
    if (this.barTime < now - BAR) this.barTime = now + 0.05; // we fell asleep; resync
    while (this.barTime < now + ahead) {
      for (const ev of barEvents(this.bar, this.rng)) scheduleNote(this.ctx, this.bank, this.loopGain, ev, this.barTime + ev.at, this.rng, this.active);
      this.bar++;
      this.barTime += BAR;
    }
  }

  get sources(): number {
    return this.active.length;
  }
}
