// Bot brain: sane commands, determinism, difficulty, stuck recovery, washing.
import { describe, expect, it } from "vitest";
import { generateWorld } from "../shared/world/generate";
import { terrainHeight } from "../shared/world/collide";
import { segmentClear } from "../shared/bots/tactics";
import { NF } from "../shared/bots/constants";
import { Btn, MatchSim, Move, TICK_DT, createEnv, type InputCmd, type SimEnv } from "../shared/sim/index";
import type { World } from "../shared/world/types";
import { BotBrain, createBotBrain, getHub, makeConfig, prepareBotWorld, St, type BotController } from "../shared/bots/brain/index";
import { createBot, DummyBot, setBotFactory } from "../worker/room/bots";

interface Ctx { world: World; env: SimEnv }
const cache = new Map<number, Ctx>();
function ctx(seed: number): Ctx {
  let c = cache.get(seed);
  if (!c) {
    const world = generateWorld(seed, { skipDecor: true });
    const env = createEnv(world);
    prepareBotWorld(world, env.cw);
    c = { world, env };
    cache.set(seed, c);
  }
  return c;
}

function match(seed: number, n: number, difficulty: (i: number) => number = (i) => i % 3) {
  const { world, env } = ctx(seed);
  const sim = new MatchSim(world, { env, seed, durationSec: 900 });
  const bots: BotBrain[] = [];
  for (let i = 0; i < n; i++) {
    const b = new BotBrain({ id: 128 + i, seed, difficulty: difficulty(i) });
    sim.addPlayer(b.id, { name: `b${i}`, color: 0x333333 * (i + 1), isBot: true });
    bots.push(b);
  }
  return { sim, bots };
}

function run(sim: MatchSim, bots: BotController[], ids: number[], steps: number, onCmd?: (id: number, c: InputCmd) => void) {
  for (let s = 0; s < steps; s++) {
    for (let i = 0; i < bots.length; i++) {
      const c = bots[i].think(sim, ids[i], TICK_DT);
      onCmd?.(ids[i], c);
      sim.applyInput(ids[i], { ...c });
    }
    sim.step(TICK_DT);
    sim.events.length = 0;
  }
}

/** A flat, open line of length D (shooter spot, target spot). */
function range(world: World, env: SimEnv, D: number): [number, number, number, number] {
  for (const s of world.spawns)
    for (let a = 0; a < 6.28; a += 0.4) {
      const x2 = s.x + Math.sin(a) * D, z2 = s.z + Math.cos(a) * D;
      const y1 = terrainHeight(world, s.x, s.z), y2 = terrainHeight(world, x2, z2);
      if (y1 < 1 || y2 < 1 || Math.abs(y1 - y2) > 1.5) continue;
      let ok = true;
      for (let k = 0; k <= 10 && ok; k++) {
        const h = terrainHeight(world, s.x + (x2 - s.x) * (k / 10), s.z + (z2 - s.z) * (k / 10));
        if (h < 0.5 || h > Math.max(y1, y2) + 0.8) ok = false;
      }
      if (ok && segmentClear(env.cw, s.x, y1 + 1.5, s.z, x2, y2 + 1.2, z2)) return [s.x, s.z, x2, z2];
    }
  throw new Error("no firing range found");
}

describe("bot brain", () => {
  it("never emits NaN or out-of-range commands in a busy match", () => {
    const { sim, bots } = match(1, 20);
    let bad = 0, fired = 0, moved = 0;
    run(sim, bots, bots.map((b) => b.id), 60 * 45, (_id, c) => {
      const ok = Number.isFinite(c.yaw) && Number.isFinite(c.pitch) && Number.isFinite(c.moveX) && Number.isFinite(c.moveZ) &&
        Math.abs(c.moveX) <= 1 && Math.abs(c.moveZ) <= 1 && Math.abs(c.pitch) <= 1.6 && (c.buttons & ~0x1ff) === 0;
      if (!ok) bad++;
      if (c.buttons & Btn.Fire) fired++;
      if (c.moveX !== 0 || c.moveZ !== 0) moved++;
    });
    expect(bad).toBe(0);
    expect(fired).toBeGreaterThan(0);
    expect(moved).toBeGreaterThan(20 * 60 * 20);
    for (const b of bots) {
      const p = sim.player(b.id)!;
      expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)).toBe(true);
    }
  });

  it("is deterministic for the same seed", () => {
    const trace = () => {
      const { sim, bots } = match(2, 12);
      let h = 0;
      run(sim, bots, bots.map((b) => b.id), 60 * 25, (id, c) => {
        h = (Math.imul(h, 31) + id + Math.round(c.yaw * 1e4) + Math.round(c.moveZ * 1e4) * 7 + c.buttons * 13) | 0;
      });
      return { h, pos: sim.players.map((p) => [p.x, p.y, p.z, p.score, p.deaths]) };
    };
    const a = trace(), b = trace();
    expect(a.h).toBe(b.h);
    expect(a.pos).toEqual(b.pos);
  });

  it("scales skill with difficulty", () => {
    const e = makeConfig(5, 130, 0).skill, n = makeConfig(5, 130, 1).skill, h = makeConfig(5, 130, 2).skill;
    expect(e.reaction).toBeGreaterThan(n.reaction);
    expect(n.reaction).toBeGreaterThan(h.reaction);
    expect(e.aimErr).toBeGreaterThan(h.aimErr);
    expect(h.lead).toBeGreaterThan(e.lead);
    expect(h.turnSpeed).toBeGreaterThan(e.turnSpeed);
    // on a firing range against a pacing target, hard bots out-shoot easy ones
    const { world, env } = ctx(1);
    const hitRate = (difficulty: number) => {
      let shots = 0, hits = 0;
      for (let trial = 0; trial < 3; trial++) {
        const sim = new MatchSim(world, { env, seed: 11 + trial });
        const bot = new BotBrain({ id: 128, seed: 3 + trial, difficulty, personality: "sniper" });
        sim.addPlayer(128, { name: "b", color: 1, isBot: true });
        sim.addPlayer(1, { name: "t", color: 2, isBot: false });
        const [x1, z1, x2, z2] = range(world, env, 20);
        sim.teleport(128, x1, NaN, z1);
        sim.teleport(1, x2, NaN, z2);
        const ang = Math.atan2(x2 - x1, z2 - z1);
        sim.player(128)!.yaw = ang;
        const t = sim.player(1)!;
        let dir = 1;
        for (let k = 0; k < 60 * 15; k++) {
          const c = bot.think(sim, 128, TICK_DT);
          sim.applyInput(128, { ...c, moveX: 0, moveZ: 0, buttons: c.buttons & ~(Btn.Jump | Btn.Crouch | Btn.Sprint) });
          const lat = -(t.x - x2) * Math.cos(ang) + (t.z - z2) * Math.sin(ang);
          if (lat > 4) dir = -1; else if (lat < -4) dir = 1;
          sim.applyInput(1, { seq: k, moveX: dir, moveZ: 0, yaw: ang, pitch: 0, buttons: 0 });
          sim.step(TICK_DT);
          for (const ev of sim.events) {
            if (ev.type === "shot" && ev.pid === 128) shots++;
            if (ev.type === "hit" && ev.shooter === 128) hits++;
          }
          sim.events.length = 0;
          t.coats.length = 0; t.coatBy.length = 0; t.shield = 0;
          sim.player(128)!.reserve = 100;
        }
      }
      return { rate: hits / Math.max(1, shots), shots };
    };
    const easy = hitRate(0), hard = hitRate(2);
    expect(hard.shots).toBeGreaterThan(40);
    expect(hard.rate).toBeGreaterThan(easy.rate + 0.05);
    expect(hard.rate).toBeLessThan(0.8); // competent, not an aimbot
  });

  it("recovers from being stuck: jumps, sidesteps, re-plans, then picks another goal", () => {
    const { sim, bots } = match(3, 1, () => 1);
    const b = bots[0];
    const p = sim.player(b.id)!;
    const s0 = sim.world.spawns[0];
    sim.teleport(b.id, s0.x, NaN, s0.z); // skip the sky drop
    run(sim, bots, [b.id], 60 * 3); // spawn, pick a goal, start walking
    // glue the bot to the spot (as if wedged in geometry) for 12 s
    const gx = p.x, gy = p.y, gz = p.z;
    let jumps = 0;
    const st0 = { ...b.stats, stateTime: undefined };
    run(sim, bots, [b.id], 60 * 12, (_id, c) => {
      if (c.buttons & Btn.Jump) jumps++;
      p.x = gx; p.y = gy; p.z = gz; p.vx = 0; p.vz = 0;
    });
    expect(b.stats.stuckEvents).toBeGreaterThan(st0.stuckEvents + 2);
    expect(b.stats.replans).toBeGreaterThan(st0.replans);
    expect(jumps).toBeGreaterThan(0);
    // released: it gets going again
    const x0 = p.x, z0 = p.z;
    run(sim, bots, [b.id], 60 * 8);
    expect(Math.hypot(p.x - x0, p.z - z0)).toBeGreaterThan(8);
  });

  it("swims to water and dives to wash off paint", () => {
    const { world, env } = ctx(1);
    const sim = new MatchSim(world, { env, seed: 4 });
    const b = new BotBrain({ id: 128, seed: 4, difficulty: 2, personality: "sneaky" });
    sim.addPlayer(128, { name: "b", color: 1, isBot: true });
    // stand on land next to a wash spot
    const hub = getHub(sim), g = hub.bw.nav;
    let spot: [number, number] | null = null;
    for (const q of hub.washSpots) {
      // a dry land node 12-30 m from deep water
      for (let n = 0; n < g.n && !spot; n += 7) {
        if (!(g.flags[n] & NF.Land) || g.flags[n] & (NF.Wade | NF.Swim | NF.Cave)) continue;
        const d = Math.hypot(g.x[n] - g.x[q], g.z[n] - g.z[q]);
        if (d > 12 && d < 30 && g.regions.comp[g.region[n]] === 0) spot = [g.x[n], g.z[n]];
      }
      if (spot) break;
    }
    expect(spot).not.toBeNull();
    sim.teleport(128, spot![0], NaN, spot![1]);
    const p = sim.player(128)!;
    p.shield = 0;
    sim.paint(128, 99);
    sim.paint(128, 99);
    expect(p.coats.length).toBe(2);
    let washed = -1, sawWash = false;
    for (let k = 0; k < 60 * 60 && washed < 0; k++) {
      sim.applyInput(128, { ...b.think(sim, 128, TICK_DT) });
      sim.step(TICK_DT);
      sim.events.length = 0;
      if (b.state === St.Wash) sawWash = true;
      if (p.coats.length === 0) washed = k / 60;
    }
    expect(sawWash).toBe(true);
    expect(washed).toBeGreaterThan(0);
    expect(b.stats.dives).toBeGreaterThan(0);
  });

  it("sky-drops in near the action, spread out, then gets on with it", () => {
    const { world, env } = ctx(4);
    let near = 0, total = 0, spread = 0;
    for (let trial = 0; trial < 3; trial++) {
      const sim = new MatchSim(world, { env, seed: 20 + trial });
      // a fight on the ground somewhere within gliding range: two players trading paint
      const ok = world.spawns.filter((s) => Math.hypot(s.x - sim.drop.cx, s.z - sim.drop.cz) < 330);
      const s = ok[(trial * 7 + 3) % ok.length];
      sim.addPlayer(1, { name: "p1", color: 2, isBot: false });
      sim.addPlayer(2, { name: "p2", color: 3, isBot: false });
      sim.teleport(1, s.x, NaN, s.z);
      sim.teleport(2, s.x + 5, NaN, s.z);
      for (const id of [1, 2]) sim.player(id)!.shield = 0;
      sim.paint(1, 2);
      sim.paint(2, 1);
      const bots: BotBrain[] = [];
      for (let i = 0; i < 4; i++) {
        bots.push(new BotBrain({ id: 128 + i, seed: 20 + trial, difficulty: 2, personality: i % 2 ? "aggressive" : "explorer" }));
        const p = sim.addPlayer(128 + i, { name: "b" + i, color: 10 + i, isBot: true });
        expect(p.move).toBe(Move.Glide);
      }
      const dropping = () => bots.some((b) => { const m = sim.player(b.id)!.move; return m === Move.Glide || m === Move.Splat; });
      for (let k = 0; k < 60 * 45 && dropping(); k++) {
        for (const b of bots) sim.applyInput(b.id, { ...b.think(sim, b.id, TICK_DT) });
        sim.step(TICK_DT);
        sim.events.length = 0;
      }
      expect(dropping()).toBe(false);
      const land = bots.map((b) => sim.player(b.id)!).map((p) => [p.x, p.z] as const);
      for (const [x, z] of land) { total++; if (Math.hypot(x - s.x - 2.5, z - s.z) < 60) near++; }
      let far = 0;
      for (const a of land) for (const b of land) far = Math.max(far, Math.hypot(a[0] - b[0], a[1] - b[1]));
      if (far > 10) spread++;
      // and afterwards they play normally
      run(sim, bots, bots.map((b) => b.id), 60 * 4);
      for (const b of bots) expect(b.stats.distance).toBeGreaterThan(40);
    }
    expect(near).toBeGreaterThanOrEqual(total - 2);
    expect(spread).toBe(3);
  });

  it("plugs into the server's BotController seam", () => {
    const { world, env } = ctx(1);
    const sim = new MatchSim(world, { env, seed: 1 });
    setBotFactory((seat) => createBotBrain(seat));
    try {
      const ctl = createBot({ id: 130, name: "Zio Bot", difficulty: 2, seed: world.seed });
      expect(ctl).toBeInstanceOf(BotBrain);
      sim.addPlayer(130, { name: "Zio Bot", color: 1, isBot: true });
      run(sim, [ctl], [130], 60 * 3);
      expect((ctl as BotBrain).stats.distance).toBeGreaterThan(3);
      ctl.dispose?.();
    } finally {
      setBotFactory((seat) => new DummyBot(seat));
    }
  });

  it("19 bots think well within a 30 Hz server tick", () => {
    const { sim, bots } = match(1, 19);
    const ids = bots.map((b) => b.id);
    run(sim, bots, ids, 60 * 5); // warm up
    const times: number[] = [];
    for (let t = 0; t < 30 * 20; t++) {
      const t0 = performance.now();
      for (let s = 0; s < 2; s++) {
        for (let i = 0; i < bots.length; i++) sim.applyInput(ids[i], bots[i].think(sim, ids[i], TICK_DT));
        const t1 = performance.now();
        sim.step(TICK_DT);
        sim.events.length = 0;
        times.push(-(performance.now() - t1)); // exclude the sim step
      }
      times.push(performance.now() - t0);
    }
    // times holds (tick total) and negative (sim step) entries; fold them into per-tick bot time
    const ticks: number[] = [];
    for (let i = 0; i < times.length; i += 3) ticks.push(times[i + 2] + times[i] + times[i + 1]);
    ticks.sort((a, b) => a - b);
    const avg = ticks.reduce((a, b) => a + b, 0) / ticks.length;
    console.log(`botbrain: 19 bots, per 30 Hz tick avg ${avg.toFixed(3)} ms, p99 ${ticks[(ticks.length * 0.99) | 0].toFixed(3)} ms`);
    expect(avg).toBeLessThan(3);
  });
});
