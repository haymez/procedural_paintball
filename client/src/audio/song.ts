// "Isola" menu tune: a lilting 6/8 barcarolle in G major for mandolin,
// nylon guitar, bass, musette accordion and whistle. 32-bar form
// (A A' B B'), four arranged passes that rotate the melody between
// instruments (~3.8 minutes before the arrangement repeats), with small
// seeded variations (grace notes, humanised timing) so it never loops
// identically. Pure data + generator; the player schedules it.

import { Rng } from "./dsp";
import type { Inst } from "./instruments";

export interface NoteEv {
  inst: Inst;
  midi: number;
  /** Start (seconds) relative to the bar / jingle start. */
  at: number;
  /** Seconds until release (sustained instruments) or until the note may be cut. */
  len: number;
  /** 0..1 */
  vel: number;
}

export const BPM_DOTTED_QUARTER = 68;
export const EIGHTH = 60 / (BPM_DOTTED_QUARTER * 3);
export const BAR = EIGHTH * 6;
const TREM_STEP = EIGHTH / 4;
export const INTRO_BARS = 2;
export const FORM_BARS = 32;

const NOTE: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function midiOf(name: string): number {
  const m = /^([A-G])(#|b)?(-?\d)$/.exec(name);
  if (!m) throw new Error("bad note " + name);
  return 12 * (Number(m[3]) + 1) + NOTE[m[1]] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0);
}

type Chord = "G" | "C" | "D" | "D7" | "Em" | "Am" | "Cm";
const CHORDS: Record<Chord, { tones: number[]; root: number; fifth: number }> = {
  G: { tones: [55, 59, 62], root: 43, fifth: 38 },
  C: { tones: [55, 60, 64], root: 48, fifth: 43 },
  D: { tones: [54, 57, 62], root: 38, fifth: 45 },
  D7: { tones: [54, 57, 60], root: 38, fifth: 45 },
  Em: { tones: [55, 59, 64], root: 40, fifth: 47 },
  Am: { tones: [57, 60, 64], root: 45, fifth: 40 },
  Cm: { tones: [55, 60, 63], root: 48, fifth: 43 },
};

const PROGRESSION: Chord[] = [
  "G", "G", "C", "G", "D7", "D7", "G", "G",
  "G", "Em", "C", "G", "Am", "D7", "G", "G",
  "C", "C", "G", "G", "D", "D7", "G", "G",
  "C", "Cm", "G", "Em", "Am", "D7", "G", "G",
];

// melody: "note:eighths", "~" = tremolo, "r" = rest. Each bar sums to 6.
const MELODY = [
  "B4:2 D5:1 G5:2 F#5:1", "E5:2 D5:1 D5:3", "E5:2 G5:1 E5:2 C5:1", "D5:3 B4:3",
  "A4:2 C5:1 F#5:2 E5:1", "D5:2 C5:1 A4:3", "B4:2 A4:1 G4:2 B4:1", "G4:5~ r:1",
  "B4:2 D5:1 G5:2 A5:1", "B5:2 A5:1 G5:2 E5:1", "E5:2 G5:1 C6:2 B5:1", "A5:2 G5:1 D5:3",
  "C5:2 E5:1 A5:2 G5:1", "F#5:2 E5:1 D5:2 C5:1", "B4:2 D5:1 A4:2 F#4:1", "G4:5~ r:1",
  "E5:3~ G5:3~", "C6:4~ B5:1 A5:1", "B5:3~ G5:3", "D5:5~ r:1",
  "F#5:2 A5:1 D6:2 C6:1", "C6:2 A5:1 F#5:3~", "G5:2 B5:1 D6:2 B5:1", "G5:5~ r:1",
  "E5:3~ G5:3~", "Eb5:3~ G5:2 Eb5:1", "D5:2 G5:1 B5:2 A5:1", "G5:2 E5:1 B4:3",
  "C5:2 E5:1 A5:2 G5:1", "F#5:2 A5:1 C6:2 A5:1", "B5:2 A5:1 G5:2 F#5:1", "G5:5~ r:1",
].map((bar) =>
  bar.split(" ").map((tok) => {
    const [n, d] = tok.split(":");
    const trem = d.endsWith("~");
    return { midi: n === "r" ? -1 : midiOf(n), eighths: parseInt(d, 10), trem };
  }),
);

const G_MAJOR = [0, 2, 4, 6, 7, 9, 11]; // pitch classes of G major, rooted at G (7)
/** Move a pitch by `steps` diatonic steps in G major (chromatic notes snap first). */
function diatonic(midi: number, steps: number): number {
  const pcs = G_MAJOR.map((p) => (p + 7) % 12).sort((a, b) => a - b);
  let m = midi;
  while (!pcs.includes(((m % 12) + 12) % 12)) m -= 1;
  const dir = Math.sign(steps);
  for (let s = 0; s < Math.abs(steps); s++) {
    do m += dir; while (!pcs.includes(((m % 12) + 12) % 12));
  }
  return m;
}

type MelodyInst = "mandolin" | "accordion" | "whistle" | null;
interface SectionPlan {
  melody: MelodyInst;
  octave: number;
  pad: boolean;
  offbeatAccordion: boolean;
  arpeggio: boolean;
  shaker: boolean;
  harmony: boolean;
  fills: boolean;
}

function plan(pass: number, bar: number): SectionPlan {
  const B = bar >= 16;
  const p = pass % 4;
  const base: SectionPlan = { melody: "mandolin", octave: 0, pad: B, offbeatAccordion: false, arpeggio: B, shaker: false, harmony: false, fills: false };
  if (p === 1) {
    if (!B) return { ...base, melody: "accordion", offbeatAccordion: false };
    return { ...base, shaker: true };
  }
  if (p === 2) {
    if (!B) return { ...base, melody: "whistle", octave: 12, fills: true };
    return { ...base, shaker: true, pad: true };
  }
  if (p === 3) {
    if (!B) return { ...base, melody: null, pad: true, fills: true, offbeatAccordion: true };
    return { ...base, shaker: true, harmony: true };
  }
  return base;
}

/**
 * Events for song bar `index` (0-based from when the music started: the first
 * INTRO_BARS are guitar + bass only, then the 32-bar form repeats).
 */
export function barEvents(index: number, rng: Rng): NoteEv[] {
  const ev: NoteEv[] = [];
  const hum = () => rng.range(-0.006, 0.006);
  const vj = (v: number) => v * rng.range(0.9, 1.08);
  const intro = index < INTRO_BARS;
  const k = intro ? 0 : index - INTRO_BARS;
  const pass = Math.floor(k / FORM_BARS);
  const bar = intro ? FORM_BARS - 1 : k % FORM_BARS;
  const chord = CHORDS[PROGRESSION[bar]];
  const pl = intro ? { ...plan(0, 0), melody: null } : plan(pass, bar);

  // bass: root on 1, fifth on 4
  ev.push({ inst: "bass", midi: chord.root, at: hum(), len: EIGHTH * 3, vel: vj(0.8) });
  ev.push({ inst: "bass", midi: chord.fifth, at: EIGHTH * 3 + hum(), len: EIGHTH * 3, vel: vj(0.62) });

  if (pl.arpeggio) {
    const [t0, t1, t2] = chord.tones;
    const seq = [t0, t1, t2, t0 + 12, t2, t1];
    seq.forEach((m, e) => ev.push({ inst: "guitar", midi: m, at: e * EIGHTH + hum(), len: EIGHTH * 2, vel: vj(e === 0 || e === 3 ? 0.42 : 0.32) }));
  } else if (!pl.offbeatAccordion) {
    for (const e of [1, 2, 4, 5]) {
      const v = e === 1 || e === 4 ? 0.34 : 0.27;
      chord.tones.forEach((m, j) => ev.push({ inst: "guitar", midi: m, at: e * EIGHTH + j * 0.011 + hum(), len: EIGHTH, vel: vj(v) }));
    }
  } else {
    for (const e of [1, 2, 4, 5]) {
      chord.tones.forEach((m) => ev.push({ inst: "accordion", midi: m + 12, at: e * EIGHTH + hum(), len: EIGHTH * 0.55, vel: vj(e === 1 || e === 4 ? 0.3 : 0.24) }));
    }
  }

  if (pl.pad) chord.tones.forEach((m) => ev.push({ inst: "accordion", midi: m, at: 0.01, len: BAR * 0.97, vel: 0.2 }));
  if (pl.shaker) for (let e = 0; e < 6; e++) ev.push({ inst: "shaker", midi: 0, at: e * EIGHTH + hum(), len: 0.1, vel: e === 0 || e === 3 ? 0.5 : 0.28 });

  if (pl.melody) {
    let t = 0;
    for (const nt of MELODY[bar]) {
      const dur = nt.eighths * EIGHTH;
      if (nt.midi >= 0) {
        const m = nt.midi + pl.octave;
        if (pl.melody === "mandolin") {
          if (nt.trem) {
            const steps = Math.max(2, Math.round(dur / TREM_STEP));
            for (let s = 0; s < steps; s++) {
              const shape = 0.85 + 0.15 * Math.sin((Math.PI * s) / steps);
              ev.push({ inst: "mandolin", midi: m, at: t + s * TREM_STEP + rng.range(-0.003, 0.003), len: s === steps - 1 ? 0.5 : TREM_STEP, vel: (s % 2 ? 0.43 : 0.55) * shape * rng.range(0.92, 1.06) });
            }
          } else {
            if (nt.eighths >= 2 && rng.chance(0.18)) ev.push({ inst: "mandolin", midi: diatonic(m, 1), at: t - 0.05, len: 0.05, vel: 0.35 });
            ev.push({ inst: "mandolin", midi: m, at: t + hum(), len: Math.max(dur, 0.3), vel: vj(0.66) });
          }
          if (pl.harmony && (nt.trem || nt.eighths >= 3)) {
            ev.push({ inst: "accordion", midi: diatonic(m, -2), at: t, len: dur * 0.95, vel: 0.28 });
          }
        } else {
          ev.push({ inst: pl.melody, midi: m, at: t + hum(), len: dur * 0.93, vel: vj(pl.melody === "whistle" ? 0.42 : 0.5) });
        }
      }
      t += dur;
    }
  }

  if (pl.fills && (bar % 4 === 3) && rng.chance(0.85)) {
    // a little descending mandolin arpeggio at phrase ends
    const top = chord.tones.map((m) => m + 24);
    [top[2], top[1], top[0], top[1]].forEach((m, j) => ev.push({ inst: "mandolin", midi: m, at: (3 + j * 0.75) * EIGHTH, len: 0.4, vel: 0.36 - j * 0.03 }));
  }
  return ev;
}

export type JingleKind = "win" | "lose";

export function jingleEvents(kind: JingleKind): NoteEv[] {
  const ev: NoteEv[] = [];
  const strum = (at: number, ms: number[], vel: number) => ms.forEach((m, j) => ev.push({ inst: "guitar", midi: m, at: at + j * 0.014, len: 2, vel }));
  if (kind === "win") {
    strum(0, [55, 59, 62, 67], 0.5);
    ev.push({ inst: "bass", midi: 43, at: 0, len: 0.4, vel: 0.7 });
    [67, 71, 74, 79].forEach((m, j) => ev.push({ inst: "mandolin", midi: m, at: j * 0.09, len: 0.4, vel: 0.65 }));
    strum(0.38, [55, 59, 62, 67, 71], 0.55);
    ev.push({ inst: "bass", midi: 43, at: 0.38, len: 1.5, vel: 0.8 });
    [67, 71, 74].forEach((m) => ev.push({ inst: "accordion", midi: m, at: 0.38, len: 1.5, vel: 0.3 }));
    for (let s = 0; s < 15; s++) ev.push({ inst: "mandolin", midi: 83, at: 0.38 + s * TREM_STEP, len: TREM_STEP, vel: (s % 2 ? 0.4 : 0.52) * (1 - s / 30) });
    ev.push({ inst: "mandolin", midi: 91, at: 1.5, len: 1, vel: 0.5 });
    ev.push({ inst: "mandolin", midi: 79, at: 1.5, len: 1, vel: 0.4 });
  } else {
    [[74, 0], [73, 0.3], [72, 0.6]].forEach(([m, at]) => ev.push({ inst: "accordion", midi: m, at, len: 0.27, vel: 0.75 }));
    ev.push({ inst: "accordion", midi: 71, at: 0.9, len: 1.2, vel: 0.7 });
    strum(0.9, [52, 55, 59], 0.35);
    ev.push({ inst: "bass", midi: 40, at: 0.9, len: 1.2, vel: 0.6 });
    ev.push({ inst: "mandolin", midi: 79, at: 2.2, len: 0.5, vel: 0.35 });
    ev.push({ inst: "mandolin", midi: 76, at: 2.33, len: 0.8, vel: 0.3 });
  }
  return ev;
}

/** Every (inst, midi) the song and jingles can ask for — pre-rendered up front. */
export function neededNotes(): { inst: Inst; midi: number }[] {
  const seen = new Map<string, { inst: Inst; midi: number }>();
  const add = (e: NoteEv) => seen.set(`${e.inst}:${e.midi}`, { inst: e.inst, midi: e.midi });
  const rng = new Rng(1);
  // sweep all passes with forced grace notes so ornaments are covered too
  for (let i = 0; i < INTRO_BARS + FORM_BARS * 4; i++) barEvents(i, rng).forEach(add);
  for (const bar of MELODY) for (const nt of bar) if (nt.midi >= 0) {
    for (const o of [0, 12]) add({ inst: "mandolin", midi: diatonic(nt.midi + o, 1), at: 0, len: 0, vel: 0 });
    add({ inst: "mandolin", midi: diatonic(nt.midi, 1), at: 0, len: 0, vel: 0 });
  }
  jingleEvents("win").forEach(add);
  jingleEvents("lose").forEach(add);
  // priority: the instruments heard first
  const order: Inst[] = ["guitar", "bass", "mandolin", "accordion", "shaker", "whistle"];
  return [...seen.values()].sort((a, b) => order.indexOf(a.inst) - order.indexOf(b.inst));
}
