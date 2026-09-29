// Job dispatcher shared by the synth worker and the main-thread fallback.
import { impulseResponse, type Chans } from "./dsp";
import { renderSfx, type SfxName } from "./recipes";
import { renderBed, type BedName } from "./beds";
import { renderNote, type Inst } from "./instruments";

export type Job =
  | { key: string; kind: "sfx"; name: SfxName }
  | { key: string; kind: "bed"; name: BedName }
  | { key: string; kind: "note"; inst: Inst; midi: number }
  | { key: string; kind: "ir"; name: "cave" | "hall" };

export interface JobResult {
  key: string;
  variants: Chans[];
}

export function renderJob(job: Job, sr: number): JobResult {
  switch (job.kind) {
    case "sfx":
      return { key: job.key, variants: renderSfx(job.name, sr) };
    case "bed":
      return { key: job.key, variants: [renderBed(job.name, sr)] };
    case "note":
      return { key: job.key, variants: [renderNote(job.inst, job.midi, sr)] };
    case "ir":
      return {
        key: job.key,
        variants: [
          job.name === "cave"
            ? impulseResponse(sr, 2.6, { t60: 2.2, pre: 0.02, bright: 0.35, early: 0.8, seed: 11 })
            : impulseResponse(sr, 2.0, { t60: 1.5, pre: 0.015, bright: 0.45, early: 0.4, seed: 23 }),
        ],
      };
  }
}
