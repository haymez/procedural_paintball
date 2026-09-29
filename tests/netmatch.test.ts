// Netcode behaviour end to end, in-memory: MatchHost ⇄ NetClients through a
// simulated network (delay + jitter) on a virtual clock.
import { beforeAll, describe, expect, it } from "vitest";
import { generateWorld } from "../shared/world/generate";
import { Btn, NO_WATER_Y, createEnv, waterAt, type SimEnv } from "../shared/sim/index";
import { sdf, terrainHeight } from "../shared/world/collide";
import { VehicleKind, type World } from "../shared/world/types";
import { InputBuffer } from "../worker/room/inputs";
import { SnapClock } from "../client/src/game/net/clock";
import { RemoteVehicle, hermite, interpKin } from "../client/src/game/net/interp";
import { Harness, type TestClient } from "./netmatch-harness";

let world: World;
let env: SimEnv;

beforeAll(() => {
  world = generateWorld(42, { skipDecor: true });
  env = createEnv(world);
});

/** Dry spot where a square of ±r m is flat to within 1.5 m and clear of obstacles. */
function flatSpot(r: number): { x: number; z: number; y: number } {
  for (let gz = -320; gz <= 320; gz += 8) {
    for (let gx = -320; gx <= 320; gx += 8) {
      const g = terrainHeight(world, gx, gz);
      if (g < 1.5) continue;
      let ok = true;
      for (let dz = -r; dz <= r && ok; dz += 3) {
        for (let dx = -r; dx <= r && ok; dx += 3) {
          const x = gx + dx, z = gz + dz;
          const th = terrainHeight(world, x, z);
          if (Math.abs(th - g) > 1.5 || waterAt(env, x, z) !== NO_WATER_Y) ok = false;
          else if (sdf(env.cw, x, th + 1.2, z) < 0.45) ok = false; // tree trunks, walls, rocks
        }
      }
      if (ok) return { x: gx, z: gz, y: g };
    }
  }
  throw new Error("no flat spot");
}

function place(h: Harness, id: number, x: number, z: number): void {
  h.host.sim!.teleport(id, x, NaN, z);
  const p = h.host.sim!.player(id)!;
  p.shield = 0;
  p.coats.length = 0;
  p.coatBy.length = 0;
}

/** Scripted input: run, sprint, turn, jump, shoot — deterministic by tick. */
function script(c: TestClient, t: number): void {
  const k = c.cmd;
  k.moveZ = t % 300 < 240 ? 1 : 0;
  k.moveX = t % 500 > 380 ? 1 : 0;
  k.yaw = 0.8 + Math.sin(t / 90) * 1.5;
  k.pitch = -0.1;
  k.buttons = (t % 400 < 200 ? Btn.Sprint : 0) | (t % 150 < 2 ? Btn.Jump : 0) | (t % 45 < 1 ? Btn.Fire : 0) | (t % 700 === 350 ? Btn.Crouch : 0);
}

describe("prediction and reconciliation", () => {
  it("predicts exactly: no corrections under 100 ms RTT with jitter", async () => {
    const h = new Harness(world);
    await h.start();
    const a = h.join(1, { owd: 50, jitter: 15 });
    const s = flatSpot(12);
    h.run(500);
    place(h, 1, s.x, s.z);
    h.run(500);
    const c0 = a.nc.totals.corrections;
    let t = 0;
    h.run(10000, (c) => script(c, t++));
    const tot = a.nc.totals;
    console.log("corrections", JSON.stringify(a.nc.corrLog));
    // the teleport above is the only server-side surprise
    expect(tot.corrections - c0).toBeLessThanOrEqual(1);
    expect(tot.shotsPredicted).toBeGreaterThan(5);
    expect(tot.shotsConfirmed).toBeGreaterThanOrEqual(tot.shotsPredicted - 2);
    expect(tot.shotsUnpredicted).toBe(0);
    // stop and let everything drain: prediction == server
    h.run(1000, (c) => { c.cmd.moveX = 0; c.cmd.moveZ = 0; c.cmd.buttons = 0; });
    const sp = h.host.sim!.player(1)!;
    const pr = a.nc.pred;
    expect(Math.hypot(sp.x - pr.x, sp.y - pr.y, sp.z - pr.z)).toBeLessThan(1e-3);
    expect(pr.hopper).toBe(sp.hopper);
    expect(pr.shotSeq).toBe(sp.shotSeq);
  }, 60000);

  it("recovers from client stalls (a frozen tab) with one correction each", async () => {
    const h = new Harness(world);
    await h.start();
    const a = h.join(1, { owd: 30, jitter: 5 });
    const s = flatSpot(12);
    h.run(500);
    place(h, 1, s.x, s.z);
    h.run(500);
    let t = 0;
    let frozen = 0;
    const c0 = a.nc.totals.corrections;
    // three 250 ms hitches where the client produces no cmds, then catches up
    for (let k = 0; k < 3; k++) {
      h.run(1500, (c) => script(c, t++));
      frozen = h.now + 250;
      const step = a.step.bind(a);
      a.step = () => { if (h.now >= frozen) step(); };
      h.run(250);
      a.step = step;
      a.nextTick = h.now;
    }
    h.run(300, (c) => script(c, t++));
    const c1 = a.nc.totals.corrections;
    h.run(3000, (c) => script(c, t++));
    const corr = c1 - c0, after = a.nc.totals.corrections - c1;
    console.log(`stalls: ${corr} corrections around 3 stalls, ${after} in the 3 s after`);
    expect(corr).toBeLessThanOrEqual(3 * 5);
    expect(after).toBeLessThanOrEqual(1); // back in step: no streak
    h.run(800, (c) => { c.cmd.moveX = 0; c.cmd.moveZ = 0; c.cmd.buttons = 0; });
    const sp = h.host.sim!.player(1)!;
    expect(Math.hypot(sp.x - a.nc.pred.x, sp.z - a.nc.pred.z)).toBeLessThan(1e-3);
  }, 60000);

  it("converges after server-side surprises (hits with knockback)", async () => {
    const h = new Harness(world);
    await h.start();
    const a = h.join(1, { owd: 60, jitter: 10 });
    h.join(2, { owd: 30 });
    const s = flatSpot(12);
    h.run(500);
    place(h, 1, s.x, s.z);
    let t = 0;
    for (let i = 0; i < 2; i++) {
      h.run(700, (c) => { if (c === a) script(c, t++); });
      h.host.sim!.paint(1, 2); // knockback + a coat, server only
    }
    h.run(700, (c) => { if (c === a) script(c, t++); });
    expect(a.nc.totals.corrections).toBeGreaterThan(0);
    expect(a.nc.totals.corrMax).toBeLessThan(1); // small: 1.6 m/s knockback over ~6 ticks
    h.run(800, (c) => { c.cmd.moveZ = 0; c.cmd.moveX = 0; c.cmd.buttons = 0; });
    const sp = h.host.sim!.player(1)!;
    const pr = a.nc.pred;
    expect(Math.hypot(sp.x - pr.x, sp.y - pr.y, sp.z - pr.z)).toBeLessThan(1e-3);
    expect(pr.coats.length).toBe(sp.coats.length);
  }, 60000);
});

describe("interpolation", () => {
  it("hermite hits the endpoints and follows a parabola", () => {
    expect(hermite(1, 3, 5, 3, 1, 0)).toBe(1);
    expect(hermite(1, 3, 5, 3, 1, 1)).toBe(5);
    // y = 10 t - 12.5 t^2 sampled at t = 0 and 0.2 s
    const y = hermite(0, 10, 10 * 0.2 - 12.5 * 0.04, 10 - 25 * 0.2, 0.2, 0.5);
    expect(y).toBeCloseTo(10 * 0.1 - 12.5 * 0.01, 6);
    const out = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0 };
    interpKin({ x: 0, y: 0, z: 0, vx: 6, vy: 0, vz: 0, yaw: 3.1 }, 10, { x: 0.2, y: 0, z: 0, vx: 6, vy: 0, vz: 0, yaw: -3.1 }, 12, 11, out, false);
    expect(out.x).toBeCloseTo(0.1, 6);
    expect(Math.abs(Math.abs(out.yaw) - Math.PI)).toBeLessThan(0.01); // shortest arc through ±π
  });

  it("far vehicles (sparse updates) glide instead of stop-and-go", () => {
    const st = { id: 0, kind: VehicleKind.Vespa, x: 0, y: 1, z: 0, yaw: 0, speed: 10, vy: 0, steer: 0, throttle: 1, pitch: 0, airborne: false, seats: [-1, -1], idle: 0, sx: 0, sy: 1, sz: 0, syaw: 0 };
    const rv = new RemoteVehicle(0, st);
    // a sample every 6 sim ticks (the far rate), rendered every tick ~5 ticks behind the newest
    const steps: number[] = [];
    let last = NaN;
    for (let t = 0; t <= 600; t++) {
      if (t % 6 === 0) rv.push(t, { ...st, z: (t / 60) * 10 });
      if (t < 60) continue;
      const d = rv.update(t - 5);
      if (!Number.isNaN(last)) steps.push(d.z - last);
      last = d.z;
    }
    // 10 m/s = 0.167 m per tick; no holds (≈0) and no catch-up leaps once settled
    const settled = steps.slice(120);
    expect(Math.min(...settled)).toBeGreaterThan(0.12);
    expect(Math.max(...settled)).toBeLessThan(0.22);
  });

  it("the snapshot clock settles on a delay that covers the jitter", () => {
    const c = new SnapClock();
    let s = 1;
    const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 300; i++) c.arrive(i * 2, (i * 2) / 0.06 + 40 + rand() * 30);
    expect(c.jitterMs).toBeGreaterThan(15);
    expect(c.jitterMs).toBeLessThan(31);
    expect(c.delayMs).toBeGreaterThanOrEqual(50);
    expect(c.delayMs).toBeLessThan(90);
    // renderTick advances and stays that far behind
    const now = 600 / 0.06 + 70;
    for (let i = 0; i < 120; i++) c.advance(now - (120 - i) * (1000 / 60));
    expect(c.lagMs(now)).toBeGreaterThan(c.delayMs - 20);
    expect(c.lagMs(now)).toBeLessThan(c.delayMs + 20);
  });

  it("remote players are drawn close to the true server path, smoothly", async () => {
    const h = new Harness(world);
    await h.start();
    const a = h.join(1, { owd: 40 });
    const b = h.join(2, { owd: 70, jitter: 25 });
    const s = flatSpot(12);
    h.run(300);
    place(h, 1, s.x, s.z);
    place(h, 2, s.x + 30, s.z);
    const truth = new Map<number, { x: number; y: number; z: number }>();
    h.afterTick = () => {
      const sim = h.host.sim!;
      const p = sim.player(1)!;
      for (const tk of [sim.tick - 1, sim.tick]) {
        const v = h.host.lagComp!.at(p, tk)!;
        truth.set(tk, { x: v.x, y: v.y, z: v.z });
      }
    };
    const errs: number[] = [];
    let t = 0;
    let jerkD = 0, jerkT = 0, jn = 0;
    let prev: { x: number; z: number }[] = [];
    let prevT: { x: number; z: number }[] = [];
    h.run(8000, (c) => {
      if (c === a) {
        c.cmd.moveZ = 1;
        c.cmd.yaw = 0.3 * Math.sin(t / 50);
        c.cmd.buttons = t % 120 < 60 ? Btn.Sprint : 0;
        t++;
        return;
      }
      if (!b.nc.ready || t < 120) return;
      const d = b.nc.remote(1);
      const rt = b.nc.renderTick;
      const t0 = Math.floor(rt);
      const p0 = truth.get(t0), p1 = truth.get(t0 + 1);
      if (!d || !p0 || !p1) return;
      const f = rt - t0;
      const tx = p0.x + (p1.x - p0.x) * f, tz = p0.z + (p1.z - p0.z) * f;
      errs.push(Math.hypot(d.x - tx, d.z - tz));
      prev.push({ x: d.x, z: d.z });
      prevT.push({ x: tx, z: tz });
      if (prev.length >= 3) {
        const [q0, q1, q2] = prev.slice(-3) as { x: number; z: number }[];
        const [r0, r1, r2] = prevT.slice(-3) as { x: number; z: number }[];
        jerkD += Math.hypot(q2!.x - 2 * q1!.x + q0!.x, q2!.z - 2 * q1!.z + q0!.z);
        jerkT += Math.hypot(r2!.x - 2 * r1!.x + r0!.x, r2!.z - 2 * r1!.z + r0!.z);
        jn++;
      }
      if (prev.length > 3) { prev = prev.slice(-3); prevT = prevT.slice(-3); }
    });
    errs.sort((x, y) => x - y);
    const med = errs[errs.length >> 1]!, p95 = errs[Math.floor(errs.length * 0.95)]!;
    console.log(`remote error median ${(med * 100).toFixed(1)} cm, p95 ${(p95 * 100).toFixed(1)} cm, jerk shown ${(jerkD / jn * 1000).toFixed(2)} vs truth ${(jerkT / jn * 1000).toFixed(2)} mm/tick², delay ${b.nc.stats.interpDelayMs.toFixed(0)} ms`);
    expect(errs.length).toBeGreaterThan(300);
    expect(med).toBeLessThan(0.05);
    expect(p95).toBeLessThan(0.2);
    expect(jerkD / jn).toBeLessThan(jerkT / jn + 0.004);
  }, 60000);
});

describe("lag compensation", () => {
  async function trials(enabled: boolean): Promise<{ hits: number; shots: number }> {
    const h = new Harness(world);
    await h.start();
    const a = h.join(1, { owd: 60, jitter: 5 });
    const b = h.join(2, { owd: 60, jitter: 5 });
    h.host.lagComp!.enabled = enabled;
    const s = flatSpot(12);
    h.run(300);
    let shots = 0;
    const N = 8;
    for (let i = 0; i < N; i++) {
      place(h, 1, s.x, s.z - 14);
      place(h, 2, s.x - 8, s.z);
      b.cmd.yaw = Math.PI / 2; // run +x across the shooter's view
      b.cmd.moveZ = 0;
      a.cmd.buttons = 0;
      h.run(400, (c) => { c.cmd.buttons = 0; c.cmd.moveZ = 0; });
      let t = 0;
      h.run(1800, (c) => {
        if (c === b) {
          c.cmd.moveZ = 1;
          c.cmd.yaw = Math.PI / 2;
          return;
        }
        t++;
        const me = a.nc.me();
        const tgt = a.nc.remote(2);
        c.cmd.buttons = 0;
        if (!me || !tgt) return;
        // lead the target as displayed here
        const ex = me.x, ey = me.y + 1.45, ez = me.z;
        let px = tgt.x, py = tgt.y + 0.8, pz = tgt.z;
        for (let k = 0; k < 3; k++) {
          const T = Math.hypot(px - ex, py - ey, pz - ez) / 46;
          px = tgt.x + tgt.vx * T; pz = tgt.z + tgt.vz * T; py = tgt.y + 0.8;
        }
        c.cmd.yaw = Math.atan2(px - ex, pz - ez);
        c.cmd.pitch = Math.atan2(py - ey, Math.hypot(px - ex, pz - ez));
        if (t === 45) { c.cmd.buttons = Btn.Fire; shots++; }
      });
    }
    return { hits: a.nc.totals.hitsByMe, shots };
  }

  it("hits what the shooter saw; without rewinding the same shots miss", async () => {
    const on = await trials(true);
    const off = await trials(false);
    console.log(`lag comp on: ${on.hits}/${on.shots} hits, off: ${off.hits}/${off.shots}`);
    expect(on.hits).toBeGreaterThanOrEqual(on.shots - 1);
    expect(off.hits).toBeLessThanOrEqual(off.shots / 2);
  }, 60000);
});

describe("server input buffer", () => {
  const cmd = (seq: number, b = 0) => ({ seq, moveX: 0, moveZ: 1, yaw: 0.5, pitch: 0, buttons: b });

  it("steps one cmd per step no matter how many arrive (no speed hacks)", () => {
    const ib = new InputBuffer();
    let seq = 1;
    let applied = 0;
    for (let step = 0; step < 600; step++) {
      // a cheater sends 3 cmds per step
      ib.push({ seq, cmds: [cmd(seq), cmd(seq + 1), cmd(seq + 2)], view: 0 });
      seq += 3;
      if (ib.next().real) applied++;
    }
    expect(applied).toBe(600);
    expect(ib.depth).toBeLessThanOrEqual(40);
  });

  it("repeats the last cmd briefly when starved, then idles; trims a burst back down", () => {
    const ib = new InputBuffer();
    ib.push({ seq: 1, cmds: [cmd(1, Btn.Sprint)], view: 10 });
    expect(ib.next().real).toBe(true);
    const reps = [0, 1, 2, 3, 4, 5].map(() => { const n = ib.next(); return { real: n.real, cmd: { ...n.cmd } }; });
    expect(reps.slice(0, 4).every((r) => !r.real && r.cmd.moveZ === 1)).toBe(true);
    expect(reps[5]!.cmd.moveZ).toBe(0);
    expect(reps[5]!.cmd.buttons).toBe(0);
    expect(reps[5]!.cmd.yaw).toBe(0.5);
    // a burst of 12 after the stall, then steady 1 per step
    ib.push({ seq: 2, cmds: Array.from({ length: 12 }, (_, i) => cmd(2 + i, i === 3 ? Btn.Jump : 0)), view: 20 });
    let seq = 14;
    let sawJump = false;
    for (let step = 0; step < 200; step++) {
      ib.push({ seq, cmds: [cmd(seq)], view: 20 });
      seq++;
      const n = ib.next();
      if (n.cmd.buttons & Btn.Jump) sawJump = true;
    }
    expect(sawJump).toBe(true); // merged, never lost
    expect(ib.depth).toBeLessThanOrEqual(5); // the client input clock brings it the rest of the way
    // redundant copies are ignored
    const before = ib.depth;
    ib.push({ seq: seq - 3, cmds: [cmd(seq - 3), cmd(seq - 2), cmd(seq - 1)], view: 0 });
    expect(ib.depth).toBe(before);
  });
});

describe("vehicles and respawns", () => {
  it("a driver predicts their vehicle with no corrections", async () => {
    const h = new Harness(world);
    await h.start();
    const a = h.join(1, { owd: 50, jitter: 10 });
    const b = h.join(2, { owd: 30 });
    h.run(500);
    const sim = h.host.sim!;
    const vi = world.vehicles.findIndex((v) => v.kind === VehicleKind.Vespa);
    const v = sim.vehicles[vi >= 0 ? vi : 0]!;
    const p = sim.player(1)!;
    p.shield = 0;
    expect(sim.enterVehicle(p, v.id, 0)).toBe(true);
    h.run(600, (c) => { c.cmd.moveZ = 0; c.cmd.moveX = 0; c.cmd.buttons = 0; });
    const c0 = a.nc.totals.corrections;
    let t = 0;
    h.run(5000, (c) => {
      if (c !== a) return;
      c.cmd.moveZ = t % 200 < 150 ? 1 : -0.5;
      c.cmd.moveX = Math.sin(t / 40);
      t++;
    });
    const me = a.nc.me()!;
    expect(me.move).toBe(8 - 1); // Move.Vehicle
    const corr = a.nc.totals.corrections - c0;
    console.log(`vehicle: ${corr} corrections, log ${JSON.stringify(a.nc.corrLog.slice(-3))}`);
    expect(corr).toBeLessThanOrEqual(2);
    h.run(4000, (c) => { c.cmd.moveX = 0; c.cmd.moveZ = c === a && (a.nc.snap.vehicles[v.id]!.speed > 0.3) ? -1 : 0; });
    expect(Math.abs(v.speed)).toBeLessThan(0.5);
    // (the driver's copy runs ~RTT ahead, so allow for the last bit of rolling)
    expect(Math.hypot(v.x - a.nc.snap.vehicles[v.id]!.x, v.z - a.nc.snap.vehicles[v.id]!.z)).toBeLessThan(0.1);
    // the other client sees the vehicle move with its rider on it
    const rv = b.nc.snap.vehicles[v.id]!;
    expect(Math.hypot(v.x - rv.x, v.z - rv.z)).toBeLessThan(0.05);
    expect(b.nc.remote(1)!.vehicle).toBe(v.id);
  }, 60000);

  it("elimination, spawn choice and respawn reach the victim in order", async () => {
    const h = new Harness(world);
    await h.start();
    const a = h.join(1, { owd: 60, jitter: 10 });
    h.join(2, { owd: 20 });
    h.run(600);
    const events: string[] = [];
    const sim = h.host.sim!;
    sim.player(1)!.shield = 0;
    for (let i = 0; i < 3; i++) sim.paint(1, 2);
    const drain = () => { const out: { type: string }[] = []; a.nc.drain(out as never); for (const e of out) events.push(e.type); };
    h.run(2000, () => drain());
    expect(a.nc.me()!.alive).toBe(false);
    expect(events).toContain("elim");
    expect(a.nc.me()!.spawnChoices.length).toBe(2);
    h.run(3000, (c) => { drain(); c.cmd.buttons = c === a ? Btn.SpawnB : 0; });
    drain();
    const me = a.nc.me()!;
    expect(me.alive).toBe(true);
    expect(events.indexOf("elim")).toBeLessThan(events.lastIndexOf("respawn"));
    expect(events.indexOf("spawnChoices")).toBeLessThan(events.lastIndexOf("respawn"));
    const sp = sim.player(1)!;
    expect(Math.hypot(sp.x - me.x, sp.z - me.z)).toBeLessThan(0.5);
    expect(sim.results().find((r) => r.id === 2)!.score).toBe(1);
  }, 60000);
});

describe("match flow", () => {
  it("late joiners get the roster and paint; reconnects resync; results use palette colors", async () => {
    const h = new Harness(world, { bots: 3 });
    await h.start();
    const a = h.join(1, { owd: 20 });
    let t = 0;
    h.run(6000, (c) => script(c, t++));
    const b = h.join(2, { owd: 20 });
    h.run(500);
    expect(b.nc.ready).toBe(true);
    expect(b.nc.snap.players.length).toBe(5);
    expect(b.nc.snap.info.get(128)?.isBot).toBe(true);
    // a drop and return: full resync, prediction still exact afterwards
    h.host.onPlayerConnection(a.player, false);
    h.run(300, (c) => script(c, t++));
    h.host.onPlayerConnection(a.player, true);
    h.run(1500, (c) => script(c, t++));
    h.run(800, (c) => { c.cmd.moveZ = 0; c.cmd.moveX = 0; c.cmd.buttons = 0; });
    const sp = h.host.sim!.player(1)!;
    expect(Math.hypot(sp.x - a.nc.pred.x, sp.z - a.nc.pred.z)).toBeLessThan(1e-3);
    const rows = h.host.results();
    expect(rows.length).toBe(5);
    expect(rows.find((r) => r.id === 1)!.color).toBe(1);
    expect(rows.filter((r) => r.bot).length).toBe(3);
    // bots leave when the room shrinks them
    h.host.onBotsChanged([{ id: 128, name: "Bot 0", color: 19 }]);
    h.run(200);
    expect(b.nc.snap.players.length).toBe(3);
  }, 60000);
});
