// Main-thread entry point for world generation. One shared module worker,
// lazily created; requests are queued and run one at a time.
import type { World } from "../../../shared/world/types";
import type { StageTiming, WorldgenReply } from "../workers/worldgen.worker";

export type { StageTiming };
export interface WorldWithStats {
  world: World;
  timings: StageTiming[];
  totalMs: number;
}
export interface LoadOptions {
  skipDecor?: boolean;
}
type ProgressFn = (stage: string, t: number) => void;

interface Job {
  id: number;
  seed: number;
  skipDecor: boolean;
  onProgress?: ProgressFn;
  resolve(r: WorldWithStats): void;
  reject(e: Error): void;
}

let worker: Worker | null = null;
let nextId = 1;
let current: Job | null = null;
const queue: Job[] = [];

function failAll(err: Error) {
  const jobs = current ? [current, ...queue] : [...queue];
  current = null;
  queue.length = 0;
  worker?.terminate();
  worker = null;
  for (const j of jobs) j.reject(err);
}

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL("../workers/worldgen.worker.ts", import.meta.url), { type: "module" });
  w.onmessage = (e: MessageEvent<WorldgenReply>) => {
    const msg = e.data;
    const job = current;
    if (!job || msg.id !== job.id) return;
    if (msg.type === "progress") {
      job.onProgress?.(msg.stage, msg.t);
      return;
    }
    current = null;
    if (msg.type === "done") job.resolve({ world: msg.world, timings: msg.timings, totalMs: msg.totalMs });
    else job.reject(new Error(`world generation failed (seed ${job.seed}): ${msg.message}`));
    pump();
  };
  w.onerror = (e: ErrorEvent) => {
    e.preventDefault();
    failAll(new Error(`worldgen worker error: ${e.message || "failed to load worker"}`));
  };
  w.onmessageerror = () => failAll(new Error("worldgen worker: message could not be deserialized"));
  worker = w;
  return w;
}

function pump() {
  if (current || queue.length === 0) return;
  current = queue.shift()!;
  getWorker().postMessage({ id: current.id, seed: current.seed, skipDecor: current.skipDecor });
}

/** Generate a world in the worker, with per-stage timings. */
export function loadWorldWithStats(seed: number, onProgress?: ProgressFn, opts: LoadOptions = {}): Promise<WorldWithStats> {
  return new Promise<WorldWithStats>((resolve, reject) => {
    queue.push({ id: nextId++, seed, skipDecor: !!opts.skipDecor, onProgress, resolve, reject });
    pump();
  });
}

/** Generate a world in the worker. */
export async function loadWorld(seed: number, onProgress?: ProgressFn, opts: LoadOptions = {}): Promise<World> {
  return (await loadWorldWithStats(seed, onProgress, opts)).world;
}
