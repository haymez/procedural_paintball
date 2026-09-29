// Snapshot clock: maps local time to server sim ticks and picks the render
// time for remote entities (the interpolation delay).
//
// Every snapshot arrival gives a sample  s = tick - localMs·0.06. The largest
// s in a sliding window is the least-delayed delivery ("present" = the newest
// tick the server has produced, as seen from here). How far typical arrivals
// fall behind it is the jitter. Remote entities are drawn at
//
//   renderTick = present - (snapshot interval + jitter·1.25 + margin)
//
// clamped to [50, 250] ms. renderTick advances one tick per client tick and
// slews ±5 % toward that target, so it never jumps (except after a stall of
// more than ~10 ticks, when it snaps).
const TICKS_PER_MS = 0.06;
const WINDOW = 90; // ~3 s of snapshots
const MIN_DELAY = 3; // ticks (50 ms)
const MAX_DELAY = 15; // ticks (250 ms)
const INTERVAL = 2; // ticks between snapshots
const MARGIN = 0.75;
const SLEW = 0.05;
const SNAP = 10;

export class SnapClock {
  private samples: number[] = [];
  private base = 0;
  private jitter = 0;
  /** Current render time (sim ticks, fractional); NaN until the first snapshot. */
  renderTick = NaN;
  /** Target delay (ticks). */
  delay = 6;
  /** Last snapshot tick received. */
  lastTick = -1;

  /** A snapshot for `tick` arrived at local time `nowMs`. */
  arrive(tick: number, nowMs: number): void {
    this.lastTick = Math.max(this.lastTick, tick);
    const s = tick - nowMs * TICKS_PER_MS;
    this.samples.push(s);
    if (this.samples.length > WINDOW) this.samples.shift();
    let hi = -Infinity;
    for (const v of this.samples) if (v > hi) hi = v;
    this.base = hi;
    // jitter: how far the 10th-percentile arrival trails the best one
    const sorted = this.samples.slice().sort((a, b) => a - b);
    const lo = sorted[Math.floor(sorted.length * 0.1)] ?? hi;
    this.jitter = hi - lo;
    this.delay = Math.min(MAX_DELAY, Math.max(MIN_DELAY, INTERVAL + this.jitter * 1.25 + MARGIN));
    if (Number.isNaN(this.renderTick)) this.renderTick = this.present(nowMs) - this.delay;
  }

  /** Newest server tick estimated to exist at local time nowMs. */
  present(nowMs: number): number {
    return nowMs * TICKS_PER_MS + this.base;
  }

  /** Advance one client tick (1/60 s). Returns renderTick. */
  advance(nowMs: number): number {
    if (Number.isNaN(this.renderTick)) return this.renderTick;
    const target = this.present(nowMs) - this.delay;
    const err = target - (this.renderTick + 1);
    if (Math.abs(err) > SNAP) this.renderTick = target;
    else this.renderTick += 1 + Math.max(-SLEW, Math.min(SLEW, err * 0.06));
    return this.renderTick;
  }

  get jitterMs(): number {
    return this.jitter / TICKS_PER_MS;
  }
  get delayMs(): number {
    return this.delay / TICKS_PER_MS;
  }
  /** How far renderTick actually trails the present (ms). */
  lagMs(nowMs: number): number {
    return (this.present(nowMs) - this.renderTick) / TICKS_PER_MS;
  }
}
