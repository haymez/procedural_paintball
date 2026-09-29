// Headless full-match simulation with bot brains only: runs a MatchSim with
// N bots on several seeds, faster than real time, and reports how lively and
// healthy the matches are. Run through the launcher:
//
//   node scripts/botsim.mjs [--seeds=1,2,3] [--minutes=3] [--bots=20]
//                           [--difficulty=mix|easy|normal|hard] [--personality=aggressive|sneaky|explorer|sniper]
//                           [--verbose] [--json=out.json]
//
// Reports: eliminations / min per bot, fights / min, % time per state, stuck
// time, hit ratio by difficulty and distance, distance traveled, washes,
// zipline / vehicle use, pickups, and bot CPU per 30 Hz room tick.
import { writeFileSync } from "node:fs";
import { generateWorld } from "../shared/world/generate";
import { MatchSim, TICK_DT, createEnv, Move, type SimEvent } from "../shared/sim/index";
import { Navigator } from "../shared/bots/brain/mover";
import { BotBrain, prepareBotWorld, getHub, ST_NAMES, ST_COUNT, PERSONALITIES, St, type PersonalityName } from "../shared/bots/brain/index";

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => {
    const [k, ...v] = a.slice(2).split("=");
    return [k, v.join("=") || "1"];
  }),
) as Record<string, string>;
const seeds = (args.seeds ?? "1,2,3").split(",").map(Number);
const minutes = Number(args.minutes ?? 3);
const nBots = Number(args.bots ?? 20);
const diffArg = args.difficulty ?? "mix";
const persArg = args.personality as PersonalityName | undefined;
const verbose = !!args.verbose;
const DIFF_NAMES = ["easy", "normal", "hard"];

interface BotRow {
  seed: number;
  id: number;
  diff: number;
  pers: string;
  brain: BotBrain;
  kills: number;
  deaths: number;
  shots: number;
  hits: number;
  hitsByBucket: number[];
  shotsByBucket: number[];
  washes: number;
  zips: number;
  vehicles: number;
  pickups: number;
  upgrades: number;
  /** Harness-side stuck watch: seconds alive without moving 2 m in 20 s (outside hold states). */
  idleT: number;
  idleMax: number;
  lastX: number;
  lastZ: number;
  checkT: number;
}

const rows: BotRow[] = [];
const perf: number[] = [];
const spikes: string[] = [];
/** "shooterDiff>targetDiff" -> [shots, hits] */
const vs = new Map<string, [number, number]>(); // ms per room tick (2 sim steps)
const perfSteps: { think: number; step: number }[] = [];
let totalSimSeconds = 0;
const wall0 = performance.now();

for (const seed of seeds) {
  const tg = performance.now();
  const world = generateWorld(seed, { skipDecor: true });
  const env = createEnv(world);
  const genMs = performance.now() - tg;
  const tb = performance.now();
  prepareBotWorld(world, env.cw);
  const bwMs = performance.now() - tb;
  const sim = new MatchSim(world, { env, durationSec: minutes * 60 + 5, seed });
  const seedRows: BotRow[] = [];
  for (let i = 0; i < nBots; i++) {
    const id = 128 + i;
    const diff = diffArg === "mix" ? i % 3 : Math.max(0, DIFF_NAMES.indexOf(diffArg));
    const brain = new BotBrain({ id, seed, difficulty: diff, personality: persArg, name: `bot${i}` });
    sim.addPlayer(id, { name: `bot${i}`, color: 0x808080 + i * 997, isBot: true });
    const r: BotRow = {
      seed, id, diff, pers: brain.personality, brain, kills: 0, deaths: 0, shots: 0, hits: 0,
      hitsByBucket: new Array(8).fill(0), shotsByBucket: new Array(8).fill(0),
      washes: 0, zips: 0, vehicles: 0, pickups: 0, upgrades: 0, idleT: 0, idleMax: 0, lastX: 0, lastZ: 0, checkT: 0,
    };
    rows.push(r);
    seedRows.push(r);
  }
  const byId = new Map(seedRows.map((r) => [r.id, r]));
  sim.events.length = 0;
  const projDist = new Map<number, { id: number; d: number }>();
  const steps = Math.round(minutes * 60 / TICK_DT);
  let roomAcc = 0;
  let lastEv: SimEvent | null = null;
  let lastEnded: { id: number; d: number } | null = null;
  let projVsEnded: string | null = null;
  const projVs = new Map<number, string>();
  const t0 = performance.now();
  for (let s = 0; s < steps; s++) {
    const a = performance.now();
    for (const r of seedRows) {
      const q0 = performance.now();
      sim.applyInput(r.id, r.brain.think(sim, r.id, TICK_DT));
      const q = performance.now() - q0;
      if (q > 1) spikes.push(`seed ${seed} step ${s} bot ${r.id} ${q.toFixed(2)} ms state ${ST_NAMES[r.brain.state]}`);
    }
    const b = performance.now();
    sim.step(TICK_DT);
    const c = performance.now();
    roomAcc += b - a;
    if (s % 2 === 1) { perf.push(roomAcc); roomAcc = 0; }
    perfSteps.push({ think: b - a, step: c - b });
    for (const e of sim.events) {
      switch (e.type) {
        case "shot": {
          const r = byId.get(e.pid);
          if (r) {
            r.shots++;
            const d = r.brain.stats.lastShotDist;
            projDist.set(e.proj, { id: e.pid, d });
            const tr = byId.get(r.brain.stats.lastShotTarget);
            const key = `${r.diff}>${tr ? tr.diff : "h"}`;
            vs.set(key, [(vs.get(key)?.[0] ?? 0) + 1, vs.get(key)?.[1] ?? 0]);
            projVs.set(e.proj, key);
            r.shotsByBucket[Math.min(7, (d / 10) | 0)]++;
          }
          break;
        }
        case "hit": case "vest": case "shield": {
          const r = byId.get(e.shooter);
          if (r) {
            r.hits++;
            if (lastEv && lastEv.type === "projEnd" && projVsEnded) vs.get(projVsEnded)![1]++;
            if (lastEv && lastEv.type === "projEnd" && lastEnded && lastEnded.id === e.shooter) {
              r.hitsByBucket[Math.min(7, (lastEnded.d / 10) | 0)]++;
            }
          }
          break;
        }
        case "elim": {
          const k = byId.get(e.killer), v = byId.get(e.victim);
          if (k && e.killer !== e.victim) k.kills++;
          if (v) v.deaths++;
          break;
        }
        case "wash": { const r = byId.get(e.pid); if (r) r.washes++; break; }
        case "zipStart": { const r = byId.get(e.pid); if (r) r.zips++; break; }
        case "vehicleEnter": { const r = byId.get(e.pid); if (r) r.vehicles++; break; }
        case "pickup": { const r = byId.get(e.pid); if (r) { r.pickups++; if (e.kind !== 0 || e.drop) r.upgrades++; } break; }
        case "projEnd": case "splat": case "splash": lastEnded = projDist.get(e.proj) ?? null; projDist.delete(e.proj); projVsEnded = projVs.get(e.proj) ?? null; projVs.delete(e.proj); break;
      }
      lastEv = e;
    }
    sim.events.length = 0;
    // harness-side stuck watch every 5 s
    if (s % 300 === 0) {
      for (const r of seedRows) {
        const p = sim.player(r.id)!;
        const st = r.brain.state;
        const holding = st === St.Perch || st === St.Hide || st === St.Engage || st === St.Cover || st === St.Wash || st === St.Dead;
        const moved = Math.hypot(p.x - r.lastX, p.z - r.lastZ);
        if (p.alive && !holding && moved < 2 && s > 0) {
          r.idleT += 5;
          if (r.idleT > r.idleMax) r.idleMax = r.idleT;
          if (verbose && r.idleT >= 20 && r.idleT % 20 === 0) {
            const dbg = r.brain.debug();
            console.log(`  [seed ${seed} t=${(s / 60).toFixed(0)}s] ${r.id} idle ${r.idleT}s at (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}) move=${p.move} state=${ST_NAMES[dbg.state]} goal=${dbg.goal?.map((v) => v.toFixed(0)).join(",")} stuck=${dbg.stuck} path=${dbg.path}`);
          }
        } else r.idleT = 0;
        r.lastX = p.x; r.lastZ = p.z;
      }
    }
  }
  const simMs = performance.now() - t0;
  totalSimSeconds += minutes * 60;
  const hub = getHub(sim);
  console.log(`seed ${seed}: gen ${genMs.toFixed(0)} ms, bot world ${bwMs.toFixed(0)} ms, ${minutes} min simulated in ${(simMs / 1000).toFixed(1)} s ` +
    `(${(minutes * 60 * 1000 / simMs).toFixed(1)}x real time), path expansions ${hub.expansions}, wash spots ${hub.washSpots.length}, ` +
    `zips ${world.ziplines.length}, vehicles ${world.vehicles.length}`);
  void Move;
}

// ------------------------------------------------------------------ report
const mins = minutes;
function pct(a: number, b: number): string {
  return b > 0 ? `${((100 * a) / b).toFixed(0)}%` : "-";
}
function f(n: number, d = 2): string {
  return n.toFixed(d);
}
function group<K>(key: (r: BotRow) => K): Map<K, BotRow[]> {
  const m = new Map<K, BotRow[]>();
  for (const r of rows) {
    const k = key(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(r);
  }
  return m;
}
const sum = (rs: BotRow[], g: (r: BotRow) => number) => rs.reduce((s, r) => s + g(r), 0);

console.log(`\n=== ${rows.length} bot-matches, ${seeds.length} seeds x ${mins} min x ${nBots} bots, difficulty ${diffArg} ===`);
const hdr = ["group", "n", "elim/min", "death/min", "fights/min", "shots/min", "hit%", "hit% 10-30m", "hit% 30m+", "m/min", "stuck s/min", "stuckMax", "washes/min", "zip", "veh", "pickups/min"];
const table: string[][] = [hdr];
function line(name: string, rs: BotRow[]) {
  const n = rs.length;
  const shots = sum(rs, (r) => r.shots), hits = sum(rs, (r) => r.hits);
  const midS = sum(rs, (r) => r.shotsByBucket[1] + r.shotsByBucket[2]), midH = sum(rs, (r) => r.hitsByBucket[1] + r.hitsByBucket[2]);
  const farS = sum(rs, (r) => r.shotsByBucket.slice(3).reduce((a, b) => a + b, 0)), farH = sum(rs, (r) => r.hitsByBucket.slice(3).reduce((a, b) => a + b, 0));
  table.push([
    name, String(n),
    f(sum(rs, (r) => r.kills) / n / mins), f(sum(rs, (r) => r.deaths) / n / mins),
    f(sum(rs, (r) => r.brain.stats.fights) / n / mins),
    f(shots / n / mins, 0), pct(hits, shots), pct(midH, midS), pct(farH, farS),
    f(sum(rs, (r) => r.brain.stats.distance) / n / mins, 0),
    f(sum(rs, (r) => r.brain.stats.stuckTime) / n / mins, 1),
    f(Math.max(...rs.map((r) => r.brain.stats.stuckMax)), 1),
    f(sum(rs, (r) => r.washes) / n / mins),
    String(sum(rs, (r) => r.zips)), String(sum(rs, (r) => r.vehicles)),
    f(sum(rs, (r) => r.pickups) / n / mins),
  ]);
}
line("all", rows);
for (const [k, rs] of [...group((r) => r.diff)].sort((a, b) => a[0] - b[0])) line(DIFF_NAMES[k], rs);
for (const [k, rs] of group((r) => r.pers)) line(k, rs);
const widths = hdr.map((_, i) => Math.max(...table.map((r) => r[i].length)));
for (const r of table) console.log(r.map((c, i) => c.padStart(widths[i])).join("  "));

// state time
console.log("\n% time per state:");
const stT = new Float64Array(ST_COUNT);
for (const r of rows) for (let i = 0; i < ST_COUNT; i++) stT[i] += r.brain.stats.stateTime[i];
const tot = stT.reduce((a, b) => a + b, 0);
console.log(ST_NAMES.map((n, i) => `${n} ${pct(stT[i], tot)}`).join(" · "));
for (const p of PERSONALITIES) {
  const rs = rows.filter((r) => r.pers === p);
  if (!rs.length) continue;
  const t = new Float64Array(ST_COUNT);
  for (const r of rs) for (let i = 0; i < ST_COUNT; i++) t[i] += r.brain.stats.stateTime[i];
  const tt = t.reduce((a, b) => a + b, 0);
  console.log(`  ${p.padEnd(10)} ` + ST_NAMES.map((n, i) => (t[i] / tt > 0.005 ? `${n} ${pct(t[i], tt)}` : "")).filter(Boolean).join(" · "));
}
// hit ratio by distance bucket per difficulty
console.log("\nhit % by distance at fire time (shots):");
for (const [k, rs] of [...group((r) => r.diff)].sort((a, b) => a[0] - b[0])) {
  const cells: string[] = [];
  for (let b = 0; b < 8; b++) {
    const s = sum(rs, (r) => r.shotsByBucket[b]), h = sum(rs, (r) => r.hitsByBucket[b]);
    cells.push(`${b * 10}${b === 7 ? "+" : "-" + (b + 1) * 10}m ${pct(h, s)} (${s})`);
  }
  console.log(`  ${DIFF_NAMES[k].padEnd(7)} ${cells.join("  ")}`);
}
console.log("hit % by shooter > target difficulty: " + [...vs.keys()].sort().map((k) => `${k.replace(/\d/g, (c) => DIFF_NAMES[+c][0])} ${pct(vs.get(k)![1], vs.get(k)![0])}`).join("  "));
// misc
const idleBad = rows.filter((r) => r.idleMax >= 60);
console.log(`\nlongest harness-idle (no 2 m move in 5 s windows outside hold states): max ${Math.max(...rows.map((r) => r.idleMax))} s; bots idle >= 60 s: ${idleBad.length}` +
  (idleBad.length ? " -> " + idleBad.map((r) => `seed${r.seed}#${r.id}(${r.idleMax}s)`).join(", ") : ""));
console.log(`dives ${sum(rows, (r) => r.brain.stats.dives)}, lobs ${sum(rows, (r) => r.brain.stats.lobs)}, zip rides ${sum(rows, (r) => r.zips)}, vespa rides ${sum(rows, (r) => r.brain.stats.vespaRides)}, boat rides ${sum(rows, (r) => r.brain.stats.boatRides)}, upgrades picked ${sum(rows, (r) => r.upgrades)}, replans ${sum(rows, (r) => r.brain.stats.replans)}`);

if (verbose || spikes.length < 12) console.log(`think spikes > 1 ms: ${spikes.length}\n  ` + spikes.slice(0, 12).join("\n  "));
console.log("replans by cause:", JSON.stringify(Navigator.why));
// perf
perf.sort((a, b) => a - b);
const avg = perf.reduce((a, b) => a + b, 0) / perf.length;
const stepAvg = perfSteps.reduce((a, b) => a + b.step, 0) / perfSteps.length;
console.log(`\nbot think time per 30 Hz room tick (${nBots} bots, 2 sim steps): avg ${avg.toFixed(3)} ms, p50 ${perf[(perf.length * 0.5) | 0].toFixed(3)}, p99 ${perf[(perf.length * 0.99) | 0].toFixed(3)}, p99.9 ${perf[(perf.length * 0.999) | 0].toFixed(3)}, max ${perf[perf.length - 1].toFixed(3)} ms; sim.step avg ${stepAvg.toFixed(3)} ms/step`);
console.log(`total wall ${((performance.now() - wall0) / 1000).toFixed(1)} s for ${totalSimSeconds / 60} simulated min`);
if (args.json) {
  writeFileSync(args.json, JSON.stringify(rows.map((r) => ({ ...r, brain: undefined, stats: { ...r.brain.stats, stateTime: Array.from(r.brain.stats.stateTime), shotsAt: Array.from(r.brain.stats.shotsAt) } })), null, 1));
}
