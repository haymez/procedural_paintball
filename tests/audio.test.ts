import { describe, expect, it } from "vitest";
import { SFX, SFX_NAMES, renderSfx } from "../client/src/audio/recipes";
import { BED_NAMES, renderBed } from "../client/src/audio/beds";
import { renderNote } from "../client/src/audio/instruments";
import { neededNotes, barEvents, jingleEvents, BAR, INTRO_BARS, FORM_BARS, EIGHTH } from "../client/src/audio/song";
import { Rng, peakOf, maxShortRms, gainToDb, rmsOf, type Chans } from "../client/src/audio/dsp";

const SR = 44100;

function finite(chs: Chans): boolean {
  for (const c of chs) for (let i = 0; i < c.length; i++) if (!Number.isFinite(c[i])) return false;
  return true;
}

/** Ratio of the wrap-around step |x[0]-x[n-1]| to the typical (p99.9) sample step. */
function loopSeam(c: Float32Array): number {
  const steps: number[] = [];
  for (let i = 1; i < c.length; i++) steps.push(Math.abs(c[i] - c[i - 1]));
  steps.sort((a, b) => a - b);
  const p = steps[Math.floor(steps.length * 0.999)] || 1e-9;
  return Math.abs(c[0] - c[c.length - 1]) / p;
}

describe("audio sfx recipes", () => {
  for (const name of SFX_NAMES) {
    it(`${name} renders clean`, () => {
      const t0 = performance.now();
      const vs = renderSfx(name, SR);
      const ms = performance.now() - t0;
      const def = SFX[name];
      expect(vs.length).toBe(def.variants ?? 1);
      for (const v of vs) {
        expect(finite(v)).toBe(true);
        const peak = peakOf(v);
        expect(peak).toBeLessThanOrEqual(0.895); // ≤ -1 dBFS (+float slack)
        const isLoop = "loop" in def && def.loop;
        // loops are normalised on long-term RMS, one-shots on their loudest 50 ms;
        // some are peak-limited below target
        const loud = gainToDb(isLoop ? rmsOf(v) : maxShortRms(v, SR));
        expect(loud).toBeGreaterThan(def.target - 9);
        expect(loud).toBeLessThan(def.target + 0.5);
        if (isLoop) for (const c of v) expect(loopSeam(c)).toBeLessThan(1.5);
        else for (const c of v) expect(Math.abs(c[c.length - 1])).toBeLessThan(1e-3);
      }
      expect(ms).toBeLessThan(2000);
    });
  }
});

describe("audio ambience beds", () => {
  for (const name of BED_NAMES) {
    it(`${name} is a seamless, non-silent loop`, () => {
      const b = renderBed(name, SR);
      expect(b.length).toBe(2);
      expect(finite(b)).toBe(true);
      expect(peakOf(b)).toBeLessThan(0.72);
      expect(gainToDb(rmsOf(b))).toBeGreaterThan(-40);
      for (const c of b) expect(loopSeam(c)).toBeLessThan(1.5);
    });
  }
});

describe("audio music", () => {
  it("every needed note renders", () => {
    const notes = neededNotes();
    expect(notes.length).toBeGreaterThan(30);
    for (const { inst, midi } of notes) {
      const [x] = renderNote(inst, midi, SR);
      expect(finite([x])).toBe(true);
      expect(peakOf([x])).toBeGreaterThan(0.1);
    }
  });
  it("bars fit the 6/8 grid and loop the form", () => {
    const rng = new Rng(9);
    const needed = new Set(neededNotes().map((n) => `${n.inst}:${n.midi}`));
    for (let b = 0; b < INTRO_BARS + FORM_BARS * 4; b++) {
      for (const e of barEvents(b, rng)) {
        expect(e.at).toBeGreaterThan(-0.08);
        expect(e.at).toBeLessThan(BAR);
        expect(needed.has(`${e.inst}:${e.midi}`)).toBe(true);
      }
    }
    for (const k of ["win", "lose"] as const) for (const e of jingleEvents(k)) expect(needed.has(`${e.inst}:${e.midi}`)).toBe(true);
    expect(EIGHTH).toBeCloseTo(60 / 204, 6);
  });
});
