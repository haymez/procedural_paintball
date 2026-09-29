// Round-trip time and server clock estimate from ping/pong pairs.
//
//   offset ≈ server + rtt/2 - localAtReceive       (per sample)
//
// The estimate uses the lowest-RTT recent samples (least queueing noise) and
// slews gently so serverNow() never jumps backwards by more than a hair once
// settled. Local time is performance-based (monotonic), in epoch-ish ms.

const WINDOW = 16;
const BEST = 5;

export class ClockSync {
  /** Smoothed RTT, ms (0 until the first pong). */
  rtt = 0;
  /** Lowest RTT seen in the window, ms. */
  rttMin = 0;
  /** server - local, ms. */
  offset = 0;
  samples = 0;
  private window: { rtt: number; offset: number }[] = [];

  /** Monotonic local clock in ms (roughly epoch-aligned). */
  local(): number {
    return performance.timeOrigin + performance.now();
  }

  /** Estimated current server time (ms since epoch, the server's Date.now()). */
  serverNow(): number {
    return this.local() + this.offset;
  }

  /** Rough first estimate from a message stamped with server time (no RTT known). */
  seed(server: number): void {
    if (this.samples === 0) this.offset = server - this.local();
  }

  /** Feed a pong: `sent` = local time the ping left, `server` = server stamp. */
  sample(sent: number, server: number, received = this.local()): void {
    const rtt = Math.max(0, received - sent);
    const off = server + rtt / 2 - received;
    this.window.push({ rtt, offset: off });
    if (this.window.length > WINDOW) this.window.shift();
    this.samples++;

    this.rtt = this.samples === 1 ? rtt : this.rtt * 0.75 + rtt * 0.25;
    const best = [...this.window].sort((a, b) => a.rtt - b.rtt).slice(0, BEST);
    this.rttMin = best[0]!.rtt;
    const target = best.reduce((s, x) => s + x.offset, 0) / best.length;
    const diff = target - this.offset;
    // Settle fast at first, then slew; big disagreements (sleep, clock step) jump.
    if (this.samples <= 3 || Math.abs(diff) > 250) this.offset = target;
    else this.offset += diff * 0.2;
  }
}
