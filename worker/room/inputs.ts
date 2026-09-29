// Per-player input jitter buffer on the server.
//
// Clients send InputCmds (one per 60 Hz client tick) in batches every ~33 ms,
// with the last couple of already-sent cmds repeated. The server steps each
// player exactly one cmd per sim step, so a client can never move faster than
// real time by sending more (extra cmds just queue up and get trimmed).
//
//   next()  → the next cmd in seq order; when the queue is empty the last cmd
//             is repeated for a few steps (keeps a running player running
//             through a late packet), then the player idles.
//   Guesses → a filler step stands in for the next seq (and the snapshot's
//             ack says so); when that late cmd arrives it is skipped, its
//             buttons merged into the next, so the server stays on the
//             client's timeline. With held keys the guess was right and the
//             client sees no correction at all. After MAX_GUESS filler steps
//             in a row (tab hidden, connection gone) guesses stop standing in.
//   Depth   → `minDepth` (the fewest cmds waiting over the last 0.5 s) goes to
//             the client in every snapshot; the client runs its 60 Hz input
//             clock a few % fast or slow to keep it at 1–2, so jitter rarely
//             starves the buffer and latency stays low. As a backstop, if the
//             minimum stays above TRIM_ABOVE for a second (a burst after a
//             stall), one cmd per step is merged into the next. Merging ORs
//             the buttons so a tap (jump, fire, interact) is never lost.
import { emptyCmd, type InputCmd } from "../../shared/sim/types";
import type { InputMsg } from "../../shared/net/index";

const REPEAT_STEPS = 4;
const TRIM_ABOVE = 5;
const WINDOW = 60;
const REPORT_WINDOW = 30;
const HARD_MAX = 40;
const MAX_GUESS = 30;

export interface NextCmd {
  cmd: InputCmd;
  /** A cmd the client actually sent (false = repeated / idle filler). */
  real: boolean;
  /** Sim tick the client was rendering others at when it made this cmd (NaN = unknown). */
  view: number;
}

export class InputBuffer {
  /** Highest seq received. -1 = none yet (accept any). */
  lastRecv = -1;
  /** Seq of the last real cmd stepped (acked in snapshots). */
  lastApplied = 0;
  private q: InputCmd[] = [];
  private views: number[] = [];
  private last: InputCmd = emptyCmd();
  private lastView = NaN;
  private starve = 0;
  private minDepth = Infinity;
  private windowN = 0;
  private trim = 0;
  /** Seq of the last cmd the client actually sent that we stepped. */
  private lastReal = 0;
  private repMin = Infinity;
  private repN = 0;
  /** Fewest cmds waiting at any step over the last 0.5 s (reported to the client). */
  reportDepth = 0;
  private readonly out: NextCmd = { cmd: emptyCmd(), real: false, view: NaN };
  // stats (reset by takeStats)
  starved = 0;
  dropped = 0;
  depthSum = 0;
  depthN = 0;

  get depth(): number {
    return this.q.length;
  }

  /** Forget everything (tab reloaded: seq numbering restarts). */
  reset(): void {
    this.lastRecv = -1;
    this.q.length = 0;
    this.views.length = 0;
    this.starve = 0;
    this.trim = 0;
    this.lastApplied = 0;
    this.lastReal = 0;
    this.minDepth = Infinity;
    this.windowN = 0;
  }

  push(m: InputMsg): void {
    const n = m.cmds.length;
    if (!n) return;
    const newest = m.seq + n - 1;
    // A seq far below what we've seen means the client restarted its numbering.
    if (this.lastRecv >= 0 && newest < this.lastRecv - 600) this.reset();
    for (let i = 0; i < n; i++) {
      const seq = m.seq + i;
      if (this.lastRecv >= 0 && seq <= this.lastRecv) continue; // redundant copy
      const c = m.cmds[i]!;
      c.seq = seq;
      this.q.push(c);
      this.views.push(m.view - (newest - seq));
      this.lastRecv = seq;
    }
    while (this.q.length > HARD_MAX) this.dropOne();
  }

  private dropOne(count = true): void {
    const a = this.q.shift()!;
    this.views.shift();
    const b = this.q[0];
    if (b) b.buttons |= a.buttons;
    if (a.seq > this.lastApplied) this.lastApplied = a.seq;
    if (count) this.dropped++;
  }

  next(): NextCmd {
    const o = this.out;
    // depth bookkeeping (before consuming)
    const d = this.q.length;
    this.depthSum += d;
    this.depthN++;
    if (d < this.minDepth) this.minDepth = d;
    if (d < this.repMin) this.repMin = d;
    if (++this.repN >= REPORT_WINDOW) {
      this.reportDepth = this.repMin;
      this.repMin = Infinity;
      this.repN = 0;
    }
    if (++this.windowN >= WINDOW) {
      if (this.minDepth > TRIM_ABOVE && this.minDepth !== Infinity) this.trim = this.minDepth - TRIM_ABOVE;
      this.minDepth = Infinity;
      this.windowN = 0;
    }
    if (this.q.length) {
      // cmds a guess already stood in for
      while (this.q.length > 1 && this.q[0]!.seq <= this.lastApplied) this.dropOne(false);
      if (this.trim > 0 && this.q.length > 1) {
        this.dropOne();
        this.trim--;
      }
      const c = this.q.shift()!;
      const v = this.views.shift()!;
      this.starve = 0;
      this.last = c;
      this.lastView = v;
      this.lastApplied = c.seq;
      this.lastReal = c.seq;
      o.cmd = c;
      o.real = true;
      o.view = v;
      return o;
    }
    this.starve++;
    this.starved++;
    if (this.lastReal) {
      if (this.starve <= MAX_GUESS) this.lastApplied++;
      else this.lastApplied = this.lastReal;
    }
    o.real = false;
    o.view = this.lastView;
    if (this.starve <= REPEAT_STEPS) {
      o.cmd = this.last;
      return o;
    }
    // idle: keep looking the same way, let go of everything
    const idle = o.cmd === this.last ? (o.cmd = emptyCmd()) : o.cmd;
    idle.seq = this.last.seq;
    idle.moveX = 0;
    idle.moveZ = 0;
    idle.yaw = this.last.yaw;
    idle.pitch = this.last.pitch;
    idle.buttons = 0;
    return o;
  }

  takeStats(): { starved: number; dropped: number; depth: number } {
    const s = { starved: this.starved, dropped: this.dropped, depth: this.depthN ? this.depthSum / this.depthN : 0 };
    this.starved = 0;
    this.dropped = 0;
    this.depthSum = 0;
    this.depthN = 0;
    return s;
  }
}
