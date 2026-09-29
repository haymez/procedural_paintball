// Headless load test: N fake players over real WebSockets against the dev
// server (npm run dev). Run through scripts/netload.mjs (bundles this file).
//
//   node scripts/netload.mjs [--clients=19] [--bots=1] [--seconds=180]
//        [--base=http://localhost:5173] [--lag=0] [--jitter=0] [--seed=42]
//
// Each client joins by code, reports the world ready, then plays: wanders,
// sprints, jumps, turns, and shoots at whoever it sees nearby — driving a full
// NetClient (prediction, reconciliation, interpolation) like the browser does.
// The server runs in dev mode, so it sends NetStats (its own tick timing)
// every 2 s. At the end the host ends the match and the results come back.
import {
  C2S, EndMatch, Input, MatchInit, NetStats, Ping, Pong, Results, Roster, RoomStateMsg, S2C, Snapshot, StartMatch,
  UpdateSettings, Welcome, WorldReady, decode, encode, Phase, DebugCmd, DebugOp,
  type MsgDef, type NetStatsMsg, type ResultsMsg,
} from "../shared/net/index";
import { Btn, createEnv, type InputCmd } from "../shared/sim/index";
import { generateWorld } from "../shared/world/generate";
import { worldChecksum } from "../shared/world/checksum";
import type { World } from "../shared/world/types";
import { NetClient } from "../client/src/game/net/client";

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => {
    const [k, ...v] = a.slice(2).split("=");
    return [k, v.join("=") || "1"];
  }),
);
const BASE = flags.base ?? "http://localhost:5173";
const N = Number(flags.clients ?? 19);
const BOTS = Number(flags.bots ?? 1);
const SECONDS = Number(flags.seconds ?? 180);
const LAG = Number(flags.lag ?? 0);
const JITTER = Number(flags.jitter ?? 0);
const SEED = flags.seed ? Number(flags.seed) : 42;
const WS = BASE.replace(/^http/, "ws");
void C2S;

/** FIFO delivery at non-decreasing times (a timer per frame could reorder). */
class DelayQueue {
  private q: { at: number; fn: () => void }[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private last = 0;
  push(fn: () => void): void {
    this.last = Math.max(this.last, performance.now() + LAG / 2 + (Math.random() * 2 - 1) * JITTER);
    this.q.push({ at: this.last, fn });
    if (!this.timer) this.arm();
  }
  private arm(): void {
    const h = this.q[0];
    if (h) this.timer = setTimeout(() => this.run(), Math.max(0, Math.ceil(h.at - performance.now())));
  }
  private run(): void {
    this.timer = null;
    const now = performance.now();
    while (this.q.length && this.q[0]!.at <= now + 0.5) this.q.shift()!.fn();
    this.arm();
  }
}

function token(i: number): string {
  return `load${i}x${Math.random().toString(36).slice(2, 12)}`;
}

function pct(a: number[], q: number): number {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))]!;
}

class Fake {
  ws!: WebSocket;
  id = 0;
  phase = -1;
  nc: NetClient | null = null;
  bytesIn = 0;
  bytesOut = 0;
  snaps = 0;
  stats: NetStatsMsg[] = [];
  results: ResultsMsg | null = null;
  seq = 0;
  cmd: InputCmd = { seq: 0, moveX: 0, moveZ: 1, yaw: Math.random() * 6.28, pitch: 0, buttons: 0 };
  turnT = 0;
  jumpT = 0;
  fireT = 0;
  sentReady = false;
  rtt = 0;
  private readonly sendQ = new DelayQueue();
  private readonly recvQ = new DelayQueue();
  private handlers = new Map<number, (m: unknown) => void>();

  constructor(readonly i: number, readonly world: World, readonly checksum: number) {}

  on<T>(def: MsgDef<T>, fn: (m: T) => void): void {
    this.handlers.set(def.id, fn as (m: unknown) => void);
  }

  send<T>(def: MsgDef<T>, msg: T): boolean {
    if (this.ws.readyState !== WebSocket.OPEN) return false;
    const b = encode(def, msg);
    this.bytesOut += b.length;
    if (!LAG && !JITTER) this.ws.send(b);
    else this.sendQ.push(() => this.ws.readyState === WebSocket.OPEN && this.ws.send(b));
    return true;
  }

  connect(code: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const q = new URLSearchParams({ tk: token(this.i), name: `Load ${this.i}`, c: "-1", w: "-1" });
      const ws = new WebSocket(`${WS}/ws/room/${code}?${q}`);
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      ws.onerror = (e) => reject(e);
      ws.onclose = (e) => console.log(`client ${this.i} closed ${e.code} ${e.reason}`);
      ws.onmessage = (e) => {
        const data = e.data as ArrayBuffer;
        const handle = () => {
          this.bytesIn += data.byteLength;
          const d = decode(S2C, data);
          if (d.def === Welcome) {
            this.id = (d.msg as { you: number }).you;
            resolve();
          }
          this.handlers.get(d.def.id)?.(d.msg);
        };
        if (!LAG && !JITTER) handle();
        else this.recvQ.push(handle);
      };
      this.on(RoomStateMsg, (s) => {
        this.phase = s.phase;
        if ((s.phase === Phase.Loading || s.phase === Phase.Playing) && !this.sentReady) {
          this.sentReady = true;
          this.send(WorldReady, { seed: s.settings.seed, checksum: this.checksum });
        }
      });
      this.on(Pong, (m) => (this.rtt = performance.timeOrigin + performance.now() - m.t));
      this.on(MatchInit, (m) => {
        if (!this.nc) {
          this.nc = new NetClient(this.world, createEnv(this.world), this.id, {
            send: (def, msg) => this.send(def, msg),
            now: () => performance.now(),
            serverNow: () => Date.now(),
            endsAt: () => null,
          });
        }
        this.nc.onInit(m);
      });
      this.on(Roster, (m) => this.nc?.onRoster(m));
      this.on(Snapshot, (m) => {
        this.snaps++;
        this.nc?.onSnapshot(m, performance.now());
      });
      this.on(NetStats, (m) => {
        this.stats.push(m);
        this.nc?.onStats(m);
      });
      this.on(Results, (m) => (this.results = m));
    });
  }

  /** One 60 Hz client tick of plausible play. */
  tick(dt: number): void {
    const nc = this.nc;
    if (!nc || !nc.ready) return;
    const me = nc.me();
    const c = this.cmd;
    c.seq = ++this.seq;
    c.buttons = 0;
    if (me && !me.alive) {
      c.buttons = Math.random() < 0.02 ? Btn.SpawnA : 0;
    } else if (me) {
      this.turnT -= dt;
      if (this.turnT <= 0) {
        this.turnT = 1 + Math.random() * 2.5;
        c.yaw += (Math.random() - 0.5) * 2.5;
        c.moveZ = Math.random() < 0.85 ? 1 : 0;
        c.moveX = Math.random() < 0.3 ? (Math.random() < 0.5 ? -1 : 1) : 0;
      }
      // steer back toward the island centre near the coast
      const r = Math.hypot(me.x, me.z);
      if (r > 300) c.yaw += (Math.atan2(-me.x, -me.z) - c.yaw) * 0.05;
      if (Math.random() < 0.3) c.buttons |= Btn.Sprint;
      this.jumpT -= dt;
      if (this.jumpT <= 0 || (me.move === 0 && Math.hypot(me.vx, me.vz) < 0.5 && c.moveZ)) {
        this.jumpT = 2 + Math.random() * 4;
        c.buttons |= Btn.Jump;
      }
      // shoot at the nearest visible player within 35 m
      let best: { x: number; y: number; z: number; d: number } | null = null;
      for (const p of nc.snap.players) {
        if (p.id === me.id || !p.alive) continue;
        const d = Math.hypot(p.x - me.x, p.z - me.z);
        if (d < 35 && (!best || d < best.d)) best = { x: p.x, y: p.y, z: p.z, d };
      }
      this.fireT -= dt;
      if (best) {
        c.yaw = Math.atan2(best.x - me.x, best.z - me.z) + (Math.random() - 0.5) * 0.05;
        c.pitch = Math.atan2(best.y + 1 - (me.y + 1.45), best.d);
        if (this.fireT <= 0) {
          c.buttons |= Btn.Fire;
          if (Math.random() < 0.08) this.fireT = 0.5 + Math.random() * 1.5;
        }
      } else c.pitch = 0;
    }
    nc.input(c);
    nc.tick();
  }
}

async function main(): Promise<void> {
  console.log(`netload: ${N} clients + ${BOTS} bots, ${SECONDS} s, seed ${SEED}, lag ${LAG}±${JITTER} ms against ${BASE}`);
  const t0 = performance.now();
  const world = generateWorld(SEED, { skipDecor: true });
  const checksum = worldChecksum(world);
  console.log(`world generated in ${(performance.now() - t0).toFixed(0)} ms, checksum ${checksum}`);

  const res = await fetch(`${BASE}/api/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"public":false}' });
  const { code } = (await res.json()) as { code: string };
  console.log(`room ${code}`);

  const clients: Fake[] = [];
  const host = new Fake(0, world, checksum);
  await host.connect(code);
  clients.push(host);
  host.send(UpdateSettings, { seed: SEED, bots: BOTS, matchMinutes: Math.max(1, Math.ceil(SECONDS / 60) + 1) });
  for (let i = 1; i < N; i++) {
    const c = new Fake(i, world, checksum);
    await c.connect(code);
    clients.push(c);
  }
  await new Promise((r) => setTimeout(r, 500));
  host.send(UpdateSettings, { bots: BOTS });
  await new Promise((r) => setTimeout(r, 300));
  host.send(StartMatch, {});
  const tStart = performance.now();
  while (!clients.every((c) => c.nc?.ready)) {
    if (performance.now() - tStart > 60000) throw new Error("clients never got into the match");
    await new Promise((r) => setTimeout(r, 50));
  }
  console.log(`all ${N} clients in the match after ${(performance.now() - tStart).toFixed(0)} ms`);
  host.send(DebugCmd, { op: DebugOp.Bots, a: 1, b: 0, c: 0 });

  // Each client ticks on its own input clock (NetClient.tickDt runs a few %
  // fast/slow to keep the server's input buffer fed), like the browser game.
  let running = true;
  const due = clients.map(() => performance.now());
  const loop = () => {
    if (!running) return;
    const now = performance.now();
    clients.forEach((c, i) => {
      let n = 0;
      while (due[i]! <= now && n < 5) {
        c.tick(1 / 60);
        due[i]! += (c.nc?.tickDt ?? 1 / 60) * 1000;
        n++;
      }
      if (n === 5) due[i] = now;
    });
    setTimeout(loop, Math.max(0, Math.min(...due) - performance.now()));
  };
  loop();
  const pinger = setInterval(() => {
    for (const c of clients) c.send(Ping, { t: performance.timeOrigin + performance.now(), rtt: c.rtt });
  }, 1000);

  const bytes0 = clients.map((c) => c.bytesIn);
  const snaps0 = clients.map((c) => c.snaps);
  const out0 = clients.map((c) => c.bytesOut);
  const m0 = performance.now();
  const perSec: number[][] = clients.map(() => []);
  let lastB = clients.map((c) => c.bytesIn);
  const sampler = setInterval(() => {
    clients.forEach((c, i) => {
      perSec[i]!.push(c.bytesIn - lastB[i]!);
    });
    lastB = clients.map((c) => c.bytesIn);
  }, 1000);
  const report = setInterval(() => {
    const s = host.stats[host.stats.length - 1];
    const el = ((performance.now() - m0) / 1000).toFixed(0);
    const kbs = clients.map((c, i) => (c.bytesIn - bytes0[i]!) / ((performance.now() - m0) / 1000) / 1024);
    const alive = clients.filter((c) => c.nc?.me()?.alive).length;
    const hits = clients.reduce((a, c) => a + (c.nc?.totals.hitsByMe ?? 0), 0);
    console.log(
      `t=${el}s  server tick p50 ${s?.tickP50.toFixed(2)} p95 ${s?.tickP95.toFixed(2)} max ${s?.tickMax.toFixed(1)} ms @ ${s?.tickRate.toFixed(1)} Hz` +
        `  down avg ${(kbs.reduce((a, b) => a + b, 0) / kbs.length).toFixed(1)} max ${Math.max(...kbs).toFixed(1)} KB/s  alive ${alive}/${N}  hits ${hits}`,
    );
  }, 10000);

  await new Promise((r) => setTimeout(r, SECONDS * 1000));
  const secs = (performance.now() - m0) / 1000;
  clearInterval(report);
  clearInterval(sampler);
  host.send(EndMatch, {});
  await new Promise((r) => setTimeout(r, 1500));
  running = false;
  clearInterval(pinger);

  // --- summary -------------------------------------------------------------------
  const all = clients.flatMap((c) => c.stats);
  const hostStats = host.stats.slice(2); // skip warm-up
  const kbs = clients.map((c, i) => (c.bytesIn - bytes0[i]!) / secs / 1024);
  const upKbs = clients.map((c, i) => (c.bytesOut - out0[i]!) / secs / 1024);
  const sps = clients.map((c, i) => (c.snaps - snaps0[i]!) / secs);
  const peakSec = perSec.flat().map((b) => b / 1024);
  const corr = clients.map((c) => c.nc!.totals);
  const corrN = corr.reduce((a, t) => a + t.corrections, 0);
  const corrSum = corr.reduce((a, t) => a + t.corrSum, 0);
  const corrMax = Math.max(...corr.map((t) => t.corrMax));
  const ticks = corr.reduce((a, t) => a + t.ticks, 0);
  const jerk = corr.reduce((a, t) => a + t.jerkSum, 0) / Math.max(1, corr.reduce((a, t) => a + t.jerkN, 0));
  const hist = [0, 1, 2, 3].map((k) => corr.reduce((a, t) => a + t.corrHist[k]!, 0));
  const shots = corr.reduce((a, t) => a + t.shotsPredicted, 0);
  const conf = corr.reduce((a, t) => a + t.shotsConfirmed, 0);
  const unpred = corr.reduce((a, t) => a + t.shotsUnpredicted, 0);
  const hits = corr.reduce((a, t) => a + t.hitsByMe, 0);
  console.log("\n=== netload summary ===");
  console.log(`clients ${N} + bots ${BOTS}, measured ${secs.toFixed(0)} s`);
  console.log(
    `server tick (DO, per 2 s window): p50 ${pct(hostStats.map((s) => s.tickP50), 0.5).toFixed(2)} ms, p95 median ${pct(hostStats.map((s) => s.tickP95), 0.5).toFixed(2)} worst ${Math.max(...hostStats.map((s) => s.tickP95)).toFixed(2)} ms,` +
      ` p99 worst ${Math.max(...hostStats.map((s) => s.tickP99)).toFixed(2)} ms, max ${Math.max(...hostStats.map((s) => s.tickMax)).toFixed(1)} ms; sim ${pct(hostStats.map((s) => s.simMs), 0.5).toFixed(2)} ms + snapshots ${pct(hostStats.map((s) => s.snapMs), 0.5).toFixed(2)} ms per tick; rate ${pct(hostStats.map((s) => s.tickRate), 0.5).toFixed(1)} Hz; clock live: ${hostStats.every((s) => s.clockLive)}`,
  );
  console.log(`downstream per client: avg ${(kbs.reduce((a, b) => a + b, 0) / N).toFixed(2)} KB/s, max ${Math.max(...kbs).toFixed(2)} KB/s, worst 1-s peak ${Math.max(...peakSec).toFixed(1)} KB/s (p95 of seconds ${pct(peakSec, 0.95).toFixed(1)})`);
  console.log(`upstream per client: avg ${(upKbs.reduce((a, b) => a + b, 0) / N).toFixed(2)} KB/s`);
  console.log(`snapshot rate: avg ${(sps.reduce((a, b) => a + b, 0) / N).toFixed(1)}/s, min ${Math.min(...sps).toFixed(1)}/s`);
  console.log(`server input buffer depth avg ${(all.reduce((a, s) => a + s.inputDepth, 0) / Math.max(1, all.length)).toFixed(2)}, starved ${(all.reduce((a, s) => a + s.starved, 0) / Math.max(1, all.length)).toFixed(2)}/s, dropped ${(all.reduce((a, s) => a + s.dropped, 0) / Math.max(1, all.length)).toFixed(2)}/s`);
  console.log(`prediction: ${corrN} corrections in ${ticks} client ticks (${((corrN / ticks) * 100).toFixed(2)} %), avg ${((corrSum / Math.max(1, corrN)) * 100).toFixed(1)} cm, max ${(corrMax * 100).toFixed(1)} cm, big (>4 m) ${corr.reduce((a, t) => a + t.bigCorrections, 0)}; sizes <2cm ${hist[0]} · 2-10cm ${hist[1]} · 10-30cm ${hist[2]} · >30cm ${hist[3]}`);
  console.log(`shots: ${shots} predicted, ${conf} confirmed, ${unpred} unpredicted; hits registered ${hits}`);
  console.log(`remote smoothness: mean |Δ²x| ${(jerk * 1000).toFixed(2)} mm/tick²`);
  const r = host.results;
  console.log(r ? `results: ${r.rows.length} rows, top ${r.rows.slice(0, 3).map((x) => `${x.name} ${x.score}/${x.deaths}`).join(", ")}` : "results: (none received)");
  for (const c of clients) c.ws.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
