// Net stats overlay (F3, or ?net=1): round trip, snapshot rate, bandwidth,
// interpolation buffer, prediction corrections, server tick timing.
import type { NetClient } from "./client";
import { lagConfig, netCounters } from "./lagsim";

export class NetOverlay {
  readonly el: HTMLDivElement;
  private timer: ReturnType<typeof setInterval> | null = null;
  private last = { t: performance.now(), bin: netCounters.bytesIn, bout: netCounters.bytesOut };
  rates = { inKBs: 0, outKBs: 0 };
  private readonly onKey = (e: KeyboardEvent) => {
    if (e.code === "F3") {
      e.preventDefault();
      this.toggle();
    }
  };

  constructor(parent: HTMLElement, private readonly net: NetClient, private readonly rtt: () => number, visible: boolean) {
    const el = document.createElement("div");
    el.className = "net-overlay";
    el.style.cssText =
      "position:absolute;left:14px;top:64px;z-index:30;pointer-events:none;font:11px/1.35 ui-monospace,Menlo,monospace;" +
      "color:#fff;background:rgba(20,40,50,.62);padding:6px 9px;border-radius:8px;white-space:pre;display:none";
    parent.appendChild(el);
    this.el = el;
    addEventListener("keydown", this.onKey);
    this.timer = setInterval(() => this.update(), 500);
    if (visible) this.toggle(true);
  }

  toggle(on = this.el.style.display === "none"): void {
    this.el.style.display = on ? "block" : "none";
  }

  update(): void {
    const now = performance.now();
    const dt = Math.max(0.001, (now - this.last.t) / 1000);
    this.rates.inKBs = (netCounters.bytesIn - this.last.bin) / dt / 1024;
    this.rates.outKBs = (netCounters.bytesOut - this.last.bout) / dt / 1024;
    this.last = { t: now, bin: netCounters.bytesIn, bout: netCounters.bytesOut };
    if (this.el.style.display === "none") return;
    const s = this.net.stats;
    const sv = s.server;
    const sim = lagConfig.lag || lagConfig.jitter || lagConfig.loss ? `  sim +${lagConfig.lag}±${lagConfig.jitter} ms ${lagConfig.loss}%` : "";
    this.el.textContent = [
      `rtt ${Math.round(this.rtt())} ms${sim}`,
      `snap ${s.snapsPerSec.toFixed(0)}/s  in ${this.rates.inKBs.toFixed(1)} KB/s  out ${this.rates.outKBs.toFixed(1)} KB/s`,
      `interp ${s.interpDelayMs.toFixed(0)} ms (jitter ${s.jitterMs.toFixed(0)})  extrap ${s.extrapolating}  queue ${s.queue}`,
      `pred ${s.unacked} unacked  corr ${s.corrPerSec.toFixed(1)}/s avg ${s.corrAvgCm.toFixed(1)} max ${s.corrMaxCm.toFixed(1)} cm`,
      `remote jerk ${s.remoteJerkMm.toFixed(1)} mm/tick²`,
      sv
        ? `server tick p50 ${sv.tickP50.toFixed(2)} p95 ${sv.tickP95.toFixed(2)} max ${sv.tickMax.toFixed(1)} ms  ${sv.tickRate.toFixed(0)} Hz\n` +
          `server→me ${(sv.bytesOut / 1024).toFixed(1)} KB/s  input buf ${sv.inputDepth.toFixed(1)}  starved ${sv.starved.toFixed(1)}/s`
        : "server stats: n/a",
    ].join("\n");
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    removeEventListener("keydown", this.onKey);
    this.el.remove();
  }
}
