// World generation off the main thread.
//
// Request:  { id, seed, skipDecor? }
// Replies:  { type: "progress", id, stage, t }
//           { type: "done", id, world, timings, totalMs }   (typed-array buffers transferred)
//           { type: "error", id, message }
import { generateWorld } from "../../../shared/world/generate";
import type { World } from "../../../shared/world/types";

export interface WorldgenRequest {
  id: number;
  seed: number;
  skipDecor?: boolean;
}
export interface StageTiming {
  stage: string;
  ms: number;
}
export type WorldgenReply =
  | { type: "progress"; id: number; stage: string; t: number }
  | { type: "done"; id: number; world: World; timings: StageTiming[]; totalMs: number }
  | { type: "error"; id: number; message: string };

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<WorldgenRequest>) => void) | null;
  postMessage(msg: WorldgenReply, transfer?: Transferable[]): void;
};

function transferables(world: World): Transferable[] {
  const set = new Set<ArrayBufferLike>();
  const add = (a: ArrayBufferView | undefined | null) => {
    if (a && a.buffer && !(typeof SharedArrayBuffer !== "undefined" && a.buffer instanceof SharedArrayBuffer)) {
      set.add(a.buffer);
    }
  };
  add(world.height);
  add(world.water);
  add(world.flow);
  add(world.biome);
  add(world.moisture);
  add(world.path);
  add(world.holes);
  for (const p of world.props ?? []) add(p.data);
  return [...set] as Transferable[];
}

scope.onmessage = (e) => {
  const { id, seed, skipDecor } = e.data;
  const timings: StageTiming[] = [];
  let stage: string | null = null;
  const t0 = performance.now();
  let stageStart = t0;
  try {
    const world = generateWorld(seed, {
      skipDecor,
      onProgress(next, t) {
        const now = performance.now();
        if (stage !== null) timings.push({ stage, ms: now - stageStart });
        else if (now - t0 > 0.5) timings.push({ stage: "(setup)", ms: now - t0 });
        stage = next;
        stageStart = now;
        scope.postMessage({ type: "progress", id, stage: next, t });
      },
    });
    const end = performance.now();
    if (stage !== null) timings.push({ stage, ms: end - stageStart });
    const totalMs = end - t0;
    scope.postMessage({ type: "done", id, world, timings, totalMs }, transferables(world));
  } catch (err) {
    const message = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
    scope.postMessage({ type: "error", id, message });
  }
};
