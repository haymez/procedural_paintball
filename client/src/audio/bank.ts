// Sound bank: asks the synth workers to render jobs and turns the results
// into AudioBuffers. Two workers so the heavy ambience beds never delay the
// UI / combat sounds; falls back to rendering on the main thread (in small
// slices) if module workers are unavailable.

import type { Chans } from "./dsp";
import type { Job, JobResult } from "./render";

type Msg = JobResult | { key: string; error: string } | { done: number };

export class Bank {
  private readonly buffers = new Map<string, AudioBuffer[]>();
  private readonly waiters = new Map<string, (() => void)[]>();
  private readonly requested = new Set<string>();
  private readonly workers: (Worker | null)[] = [null, null];
  private readonly batchDone = new Map<number, () => void>();
  private nextId = 1;
  private fallback: Promise<typeof import("./render")> | null = null;
  /** Total ms spent rendering on the main thread (fallback only). */
  mainThreadMs = 0;
  readonly sr: number;

  constructor(private readonly ctx: BaseAudioContext) {
    this.sr = ctx.sampleRate;
    for (let i = 0; i < 2; i++) {
      try {
        const w = new Worker(new URL("./synth.worker.ts", import.meta.url), { type: "module", name: `isola-synth-${i}` });
        w.onmessage = (e: MessageEvent<Msg>) => this.onMessage(e.data);
        w.onerror = (e) => {
          console.warn("[audio] synth worker failed, rendering on main thread", e.message);
          this.workers[i] = null;
        };
        this.workers[i] = w;
      } catch {
        this.workers[i] = null;
      }
    }
  }

  has(key: string): boolean {
    return this.buffers.has(key);
  }

  get(key: string): AudioBuffer[] | undefined {
    return this.buffers.get(key);
  }

  whenReady(key: string): Promise<void> {
    if (this.buffers.has(key)) return Promise.resolve();
    return new Promise((res) => {
      const l = this.waiters.get(key) ?? [];
      l.push(res);
      this.waiters.set(key, l);
    });
  }

  /** Queue jobs (already-requested keys are skipped). lane 0 = fast, 1 = heavy. */
  request(jobs: Job[], lane: 0 | 1 = 0): Promise<void> {
    const todo = jobs.filter((j) => !this.requested.has(j.key));
    for (const j of todo) this.requested.add(j.key);
    if (!todo.length) return Promise.all(jobs.map((j) => this.whenReady(j.key))).then(() => undefined);
    const w = this.workers[lane] ?? this.workers[0];
    if (w) {
      const id = this.nextId++;
      const p = new Promise<void>((res) => this.batchDone.set(id, res));
      w.postMessage({ id, sr: this.sr, jobs: todo });
      return p.then(() => Promise.all(jobs.map((j) => this.whenReady(j.key)))).then(() => undefined);
    }
    return this.renderOnMain(todo);
  }

  private async renderOnMain(jobs: Job[]): Promise<void> {
    this.fallback ??= import("./render");
    const mod = await this.fallback;
    for (const job of jobs) {
      await new Promise((r) => setTimeout(r, 0));
      const t0 = performance.now();
      try {
        this.store(mod.renderJob(job, this.sr));
      } catch (err) {
        console.error("[audio] render failed", job.key, err);
      }
      this.mainThreadMs += performance.now() - t0;
    }
  }

  private onMessage(m: Msg): void {
    if ("done" in m) {
      this.batchDone.get(m.done)?.();
      this.batchDone.delete(m.done);
      return;
    }
    if ("error" in m) {
      console.error("[audio] render failed", m.key, m.error);
      return;
    }
    this.store(m);
  }

  private store(r: JobResult): void {
    const bufs = r.variants.map((ch) => this.toBuffer(ch));
    this.buffers.set(r.key, bufs);
    const w = this.waiters.get(r.key);
    if (w) {
      this.waiters.delete(r.key);
      for (const f of w) f();
    }
  }

  private toBuffer(ch: Chans): AudioBuffer {
    const b = this.ctx.createBuffer(ch.length, ch[0].length, this.sr);
    ch.forEach((c, i) => b.copyToChannel(c as Float32Array<ArrayBuffer>, i));
    return b;
  }

  dispose(): void {
    for (const w of this.workers) w?.terminate();
  }
}
