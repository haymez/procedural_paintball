// WebSocket shim: counts bytes both ways (for the net stats overlay) and,
// when asked, simulates a bad network on this client:
//
//   ?lag=120      added round trip, ms (half on send, half on receive)
//   &jitter=20    ± random extra delay per frame, ms
//   &loss=2       % of frames that get stuck behind a TCP retransmit
//                 (extra lag + 200 ms; everything behind waits too)
//
// Order is always preserved, like a real WebSocket. The settings stick for
// the tab (sessionStorage) so navigating inside the app keeps them; ?lag=0
// clears them. Installed once, before any socket opens (app/match.ts).
export const netCounters = { bytesIn: 0, bytesOut: 0, framesIn: 0, framesOut: 0 };
export const lagConfig = { lag: 0, jitter: 0, loss: 0 };
/** ?net=1 on the page that opened the tab: show the net stats overlay. */
export const netFlags = { overlay: false };

let installed = false;

function num(v: string | null): number | null {
  if (v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function load(search: string): void {
  const q = new URLSearchParams(search);
  let store: Storage | null = null;
  try {
    store = sessionStorage;
  } catch {
    /* no storage */
  }
  const saved = store?.getItem("isola:lagsim");
  if (saved) {
    try {
      Object.assign(lagConfig, JSON.parse(saved));
    } catch {
      /* ignore */
    }
  }
  if (q.has("net")) {
    netFlags.overlay = q.get("net") === "1";
    if (netFlags.overlay) store?.setItem("isola:netoverlay", "1");
    else store?.removeItem("isola:netoverlay");
  } else netFlags.overlay = store?.getItem("isola:netoverlay") === "1";
  const lag = num(q.get("lag")), jitter = num(q.get("jitter")), loss = num(q.get("loss"));
  if (lag !== null) lagConfig.lag = lag;
  if (jitter !== null) lagConfig.jitter = jitter;
  if (loss !== null) lagConfig.loss = Math.min(50, loss);
  if (lag !== null || jitter !== null || loss !== null) {
    if (lagConfig.lag || lagConfig.jitter || lagConfig.loss) store?.setItem("isola:lagsim", JSON.stringify(lagConfig));
    else store?.removeItem("isola:lagsim");
  }
}

function delay(prev: number): number {
  const now = performance.now();
  let t = now + lagConfig.lag / 2 + (Math.random() * 2 - 1) * lagConfig.jitter;
  if (lagConfig.loss && Math.random() * 100 < lagConfig.loss) t += lagConfig.lag + 200;
  return Math.max(prev, t, now);
}

/**
 * Strict FIFO delivery at (non-decreasing) times. A timer per frame is not
 * enough: setTimeout truncates fractional delays, so two frames due within
 * the same millisecond could swap.
 */
class DelayQueue {
  private q: { at: number; fn: () => void }[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  last = 0;
  push(fn: () => void): void {
    this.last = delay(this.last);
    this.q.push({ at: this.last, fn });
    if (!this.timer) this.arm();
  }
  private arm(): void {
    const head = this.q[0];
    if (!head) return;
    this.timer = setTimeout(() => this.run(), Math.max(0, Math.ceil(head.at - performance.now())));
  }
  private run(): void {
    this.timer = null;
    const now = performance.now();
    while (this.q.length && this.q[0]!.at <= now + 0.5) this.q.shift()!.fn();
    this.arm();
  }
}

function active(): boolean {
  return lagConfig.lag > 0 || lagConfig.jitter > 0 || lagConfig.loss > 0;
}

export function installNetShim(search: string): void {
  if (installed || typeof WebSocket === "undefined") return;
  installed = true;
  load(search);
  if (active()) console.info(`[net] simulating lag ${lagConfig.lag} ms, jitter ±${lagConfig.jitter} ms, loss ${lagConfig.loss} %`);
  const Orig = WebSocket;
  class ShimSocket extends Orig {
    private readonly sendQ = new DelayQueue();
    private readonly recvQ = new DelayQueue();
    override send(data: string | Blob | BufferSource): void {
      const n = typeof data === "string" ? data.length : data instanceof Blob ? data.size : data.byteLength;
      netCounters.bytesOut += n;
      netCounters.framesOut++;
      if (!active()) return super.send(data);
      this.sendQ.push(() => {
        if (this.readyState === Orig.OPEN) super.send(data);
      });
    }
    override addEventListener(type: string, listener: EventListenerOrEventListenerObject, opts?: boolean | AddEventListenerOptions): void {
      if (type !== "message" && type !== "close") return super.addEventListener(type, listener, opts);
      const call = (ev: Event) => (typeof listener === "function" ? listener.call(this, ev) : listener.handleEvent(ev));
      const wrapped = (ev: Event) => {
        if (type === "message") {
          const d = (ev as MessageEvent).data;
          netCounters.bytesIn += d instanceof ArrayBuffer ? d.byteLength : typeof d === "string" ? d.length : 0;
          netCounters.framesIn++;
        }
        if (!active()) return call(ev);
        this.recvQ.push(() => call(ev));
      };
      super.addEventListener(type, wrapped, opts);
    }
  }
  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = ShimSocket;
}
