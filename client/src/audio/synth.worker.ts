// Renders sounds off the main thread. Protocol:
//   in:  { id, sr, jobs: Job[] }
//   out: { key, variants } per job (buffers transferred), then { done: id }
import { renderJob, type Job } from "./render";

interface Req {
  id: number;
  sr: number;
  jobs: Job[];
}

self.onmessage = (e: MessageEvent<Req>) => {
  const { id, sr, jobs } = e.data;
  for (const job of jobs) {
    try {
      const r = renderJob(job, sr);
      const transfer = r.variants.flatMap((v) => v.map((c) => c.buffer as ArrayBuffer));
      self.postMessage(r, { transfer });
    } catch (err) {
      self.postMessage({ key: job.key, error: String(err) });
    }
  }
  self.postMessage({ done: id });
};
