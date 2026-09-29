import { beforeAll, describe, expect, it } from "vitest";
import { generateWorld } from "../shared/world/generate";
import { sdf } from "../shared/world/collide";
import type { World } from "../shared/world/types";
import {
  BODY_R, Btn, createEnv, createPlayerState, copyPlayerState, MatchSim, Move, STEP_H, stepPlayer, TICK_DT, waterAt,
  NO_WATER_Y, probeGround, BLOCKED, PAINT_WEAR_DELAY, PAINT_WEAR_TIME, WASH_TIME, DROP_MIN_Y, DROP_MAX_Y, DROP_SCATTER, DROP_LAND_SHIELD, RESPAWN_DELAY,
  SPLAT_TIME, Fx, BOAT_DRAFT, GYRO_CEILING, type InputCmd, type PlayerState, type SimEnv, bodyHeight, captureSnapshot, restorePlayer,
} from "../shared/sim/index";
import { Dummy } from "../shared/sim/dummy";
import { VehicleKind } from "../shared/world/types";
import { terrainHeight } from "../shared/world/collide";

let world: World;
let env: SimEnv;

beforeAll(() => {
  world = generateWorld(42, { skipDecor: true });
  env = createEnv(world);
});

function cmd(o: Partial<InputCmd> = {}): InputCmd {
  return { seq: 0, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0, ...o };
}

/** Deepest penetration of the body spheres (negative = inside by that much). */
function bodyClearance(p: PlayerState): number {
  if (p.move === Move.Vehicle || p.move === Move.Dead || p.move === Move.Zipline || p.move === Move.Mantle) return 1;
  const h = bodyHeight(p.move);
  let m = Infinity;
  for (const oy of [STEP_H + BODY_R, (STEP_H + BODY_R + h - BODY_R) / 2, h - BODY_R]) {
    if (oy < STEP_H + BODY_R - 1e-6) continue;
    m = Math.min(m, sdf(env.cw, p.x, p.y + oy, p.z) - BODY_R);
  }
  return m;
}

/** A spot on dry, fairly flat ground. */
function flatSpot(): { x: number; y: number; z: number } {
  for (const s of world.spawns) {
    const g = probeGround(env, s.x, s.y + 2, s.z, 6);
    if (g === BLOCKED || g === -Infinity) continue;
    if (waterAt(env, s.x, s.z) !== NO_WATER_Y) continue;
    let ok = true;
    for (const [dx, dz] of [[12, 0], [-12, 0], [0, 12], [0, -12]]) {
      const g2 = probeGround(env, s.x + dx, g + 4, s.z + dz, 8);
      if (g2 === BLOCKED || g2 === -Infinity || Math.abs(g2 - g) > 1.2) ok = false;
    }
    if (ok) return { x: s.x, y: g, z: s.z };
  }
  throw new Error("no flat spot");
}

function spawnAt(x: number, y: number, z: number): PlayerState {
  const p = createPlayerState(1);
  p.x = x; p.y = y + 0.02; p.z = z; p.move = Move.Air; p.alive = true;
  return p;
}

describe("stepPlayer", () => {
  it("lands and stays grounded on flat ground", () => {
    const s = flatSpot();
    const p = spawnAt(s.x, s.y + 1, s.z);
    for (let i = 0; i < 60; i++) stepPlayer(p, cmd(), TICK_DT, env);
    expect(p.grounded).toBe(true);
    expect(p.move).toBe(Move.Ground);
    expect(Math.abs(p.y - s.y)).toBeLessThan(0.1);
    expect(bodyClearance(p)).toBeGreaterThan(-0.02);
  });

  it("runs, sprints and jumps without ending up inside solids", () => {
    const s = flatSpot();
    const p = spawnAt(s.x, s.y, s.z);
    let worst = Infinity;
    for (let i = 0; i < 600; i++) {
      const b = (i % 90 === 0 ? Btn.Jump : 0) | (i > 200 ? Btn.Sprint : 0);
      stepPlayer(p, cmd({ moveZ: 1, moveX: i > 400 ? 0.7 : 0, yaw: i * 0.004, buttons: b }), TICK_DT, env);
      worst = Math.min(worst, bodyClearance(p));
    }
    const moved = Math.hypot(p.x - s.x, p.z - s.z);
    expect(moved).toBeGreaterThan(5);
    expect(worst).toBeGreaterThan(-0.08);
  });

  it("is deterministic for identical input streams", () => {
    const s = flatSpot();
    const a = spawnAt(s.x, s.y, s.z), b = spawnAt(s.x, s.y, s.z);
    const inputs: InputCmd[] = [];
    let r = 12345;
    const rnd = () => ((r = (r * 1103515245 + 12345) >>> 0) / 4294967296);
    for (let i = 0; i < 400; i++) inputs.push(cmd({ seq: i, moveX: rnd() * 2 - 1, moveZ: rnd() * 2 - 1, yaw: rnd() * 6, buttons: rnd() < 0.1 ? Btn.Jump : rnd() < 0.05 ? Btn.Crouch | Btn.Sprint : Btn.Sprint }));
    for (const c of inputs) stepPlayer(a, c, TICK_DT, env);
    for (const c of inputs) stepPlayer(b, c, TICK_DT, env);
    expect([a.x, a.y, a.z, a.vx, a.vy, a.vz, a.move]).toEqual([b.x, b.y, b.z, b.vx, b.vy, b.vz, b.move]);
    // rollback: copy mid-way state and replay the tail
    const c0 = spawnAt(s.x, s.y, s.z);
    for (let i = 0; i < 200; i++) stepPlayer(c0, inputs[i], TICK_DT, env);
    const saved = copyPlayerState(c0, createPlayerState(1));
    for (let i = 200; i < 400; i++) stepPlayer(saved, inputs[i], TICK_DT, env);
    expect([saved.x, saved.y, saved.z]).toEqual([a.x, a.y, a.z]);
  });

  it("slides when crouching out of a sprint", () => {
    const s = flatSpot();
    const p = spawnAt(s.x, s.y, s.z);
    for (let i = 0; i < 60; i++) stepPlayer(p, cmd({ moveZ: 1, buttons: Btn.Sprint }), TICK_DT, env);
    stepPlayer(p, cmd({ moveZ: 1, buttons: Btn.Sprint | Btn.Crouch }), TICK_DT, env);
    expect([Move.Slide, Move.Air, Move.SteepSlide]).toContain(p.move);
  });

  it("swims in the sea, dives, runs out of breath and gasps", () => {
    // find deep sea
    let x = 0, z = 0;
    for (let r = 300; r < 500; r += 10) {
      x = r; z = 0;
      if (probeGround(env, x, 0, z, 60) < -8) break;
    }
    const p = spawnAt(x, 0.5, z);
    for (let i = 0; i < 240; i++) stepPlayer(p, cmd(), TICK_DT, env);
    expect(p.move).toBe(Move.Swim);
    stepPlayer(p, cmd({ buttons: Btn.Crouch }), TICK_DT, env);
    expect(p.move).toBe(Move.Underwater);
    let gasped = false;
    for (let i = 0; i < 60 * 10; i++) {
      stepPlayer(p, cmd({ buttons: Btn.Crouch, pitch: -0.3 }), TICK_DT, env);
      if (p.gasp > 0) { gasped = true; break; }
    }
    expect(gasped).toBe(true);
    expect(p.move).toBe(Move.Swim);
    // can't dive again while gasping
    stepPlayer(p, cmd({ buttons: 0 }), TICK_DT, env);
    stepPlayer(p, cmd({ buttons: Btn.Crouch }), TICK_DT, env);
    expect(p.move).toBe(Move.Swim);
  });
});

describe("MatchSim", () => {
  it("paintballs hit, coat and eliminate", () => {
    const sim = new MatchSim(world, { env });
    const s = flatSpot();
    const a = sim.addPlayer(1, { name: "A", color: 0xff0000, isBot: false });
    const b = sim.addPlayer(2, { name: "B", color: 0x00ff00, isBot: false });
    sim.teleport(1, s.x, s.y + 0.1, s.z);
    sim.teleport(2, s.x, s.y + 0.1, s.z + 8);
    a.shield = 0; b.shield = 0;
    for (let i = 0; i < 30; i++) sim.step();
    b.shield = 0;
    let hits = 0, elim = false;
    for (let i = 0; i < 240 && !elim; i++) {
      const dx = b.x - a.x, dz = b.z - a.z;
      const yaw = Math.atan2(dx, dz);
      const pitch = Math.atan2(b.y + 1 - (a.y + 1.45), Math.hypot(dx, dz));
      sim.applyInput(1, cmd({ seq: i, yaw, pitch, buttons: Btn.Fire | Btn.Aim }));
      sim.step();
      for (const e of sim.events) {
        if (e.type === "hit" && e.target === 2) hits++;
        if (e.type === "elim" && e.victim === 2) elim = true;
      }
      sim.events.length = 0;
    }
    expect(hits).toBeGreaterThanOrEqual(3);
    expect(elim).toBe(true);
    expect(a.score).toBe(1);
    expect(b.alive).toBe(false);
    // b drops back in from the sky
    for (let i = 0; i < 60 * 4; i++) {
      sim.applyInput(2, cmd({ seq: i }));
      sim.step();
    }
    expect(b.alive).toBe(true);
    expect(b.move).toBe(Move.Glide);
    expect(b.coats.length).toBe(0);
  });

  it("water washes paint off", () => {
    const sim = new MatchSim(world, { env });
    const p = sim.addPlayer(1, { name: "A", color: 0xff0000, isBot: false });
    sim.addPlayer(2, { name: "B", color: 0x00ff00, isBot: false });
    let x = 0;
    for (let r = 300; r < 500; r += 10) { x = r; if (probeGround(env, x, 0, 0, 60) < -8) break; }
    sim.teleport(1, x, -0.8, 0);
    p.shield = 0;
    sim.paint(1, 2);
    sim.paint(1, 2);
    expect(p.coats.length).toBe(2);
    for (let i = 0; i < 60; i++) { sim.applyInput(1, cmd({ seq: i })); sim.step(); }
    for (let i = 0; i < 60 * 3.4; i++) { sim.applyInput(1, cmd({ seq: 100 + i, buttons: Btn.Crouch, pitch: -0.2 })); sim.step(); }
    expect(p.coats.length).toBe(0);
  });

  it("paint wears off on land over time; a new hit resets the clock", () => {
    const sim = new MatchSim(world, { env });
    const s = flatSpot();
    const p = sim.addPlayer(1, { name: "A", color: 0xff0000, isBot: false });
    sim.addPlayer(2, { name: "B", color: 0x00ff00, isBot: false });
    sim.teleport(1, s.x, s.y + 0.1, s.z);
    sim.teleport(2, s.x + 30, NaN, s.z);
    p.shield = 0;
    let seq = 0;
    const wears: number[] = [];
    const run = (sec: number) => {
      for (let i = 0; i < sec * 60; i++) {
        sim.applyInput(1, cmd({ seq: seq++ }));
        sim.step();
        for (const e of sim.events) if (e.type === "wear" && e.pid === 1) wears.push(sim.time);
        sim.events.length = 0;
      }
    };
    sim.paint(1, 2);
    sim.paint(1, 2);
    expect(p.coats.length).toBe(2);
    const t0 = sim.time;
    // nothing before PAINT_WEAR_DELAY + PAINT_WEAR_TIME
    run(PAINT_WEAR_DELAY + PAINT_WEAR_TIME - 0.2);
    expect(p.coats.length).toBe(2);
    run(0.4);
    expect(p.coats.length).toBe(1);
    expect(wears[0] - t0).toBeCloseTo(PAINT_WEAR_DELAY + PAINT_WEAR_TIME, 1);
    // a fresh hit restarts the full delay
    run(2);
    sim.paint(1, 2);
    const t1 = sim.time;
    expect(p.coats.length).toBe(2);
    run(PAINT_WEAR_DELAY + PAINT_WEAR_TIME * 2 + 0.3);
    expect(p.coats.length).toBe(0);
    expect(p.paintT).toBe(0);
    expect(wears.length).toBe(3);
    expect(wears[1] - t1).toBeCloseTo(PAINT_WEAR_DELAY + PAINT_WEAR_TIME, 1);
    // later coats come off every PAINT_WEAR_TIME
    expect(wears[2] - wears[1]).toBeCloseTo(PAINT_WEAR_TIME, 1);
    // washing stays faster than wearing
    expect(WASH_TIME).toBeLessThan(PAINT_WEAR_TIME);
    expect(p.alive).toBe(true);
  });

  it("dummies roam for a minute without ending inside solids", () => {
    const sim = new MatchSim(world, { env, durationSec: 120 });
    const dummies: Dummy[] = [];
    // start on the 12 spawns nearest spawn 0 so the dummies actually meet (they only wander locally)
    const s0 = world.spawns[0];
    const near = world.spawns.map((s, k) => ({ k, d: (s.x - s0.x) ** 2 + (s.z - s0.z) ** 2 })).sort((a, b) => a.d - b.d);
    for (let i = 1; i <= 12; i++) {
      const p = sim.addPlayer(i, { name: "D" + i, color: 0xffffff, isBot: true });
      sim.respawn(p, near[i - 1].k);
      dummies.push(new Dummy(i, 42, 0.8));
    }
    let worst = Infinity, shots = 0;
    for (let t = 0; t < 60 * 60; t++) {
      for (const d of dummies) sim.applyInput(d.id, { ...d.think(sim, TICK_DT) });
      sim.step();
      for (const e of sim.events) if (e.type === "shot") shots++;
      sim.events.length = 0;
      if (t % 10 === 0) for (const p of sim.players) if (p.alive) worst = Math.min(worst, bodyClearance(p));
    }
    expect(shots).toBeGreaterThan(10);
    expect(worst).toBeGreaterThan(-0.12);
  });
});

describe("traversal", () => {
  it("mantles onto a ledge in front", () => {
    // find a box face whose top is 1.2..2 m above the ground next to it
    let found: { x: number; z: number; fx: number; fz: number; top: number } | null = null;
    for (const st of world.structures) for (const so of st.solids) {
      if (found || so.shape !== "box") continue;
      const top = so.cy + so.hy;
      const c = Math.cos(so.rotY), sn = Math.sin(so.rotY);
      for (const [lx, lz, nx, nz, half] of [[so.hx + 1.1, 0, 1, 0, so.hz], [-(so.hx + 1.1), 0, -1, 0, so.hz], [0, so.hz + 1.1, 0, 1, so.hx], [0, -(so.hz + 1.1), 0, -1, so.hx]]) {
        if (found || half < 0.7) continue;
        const x = so.cx + lx * c + lz * sn, z = so.cz - lx * sn + lz * c;
        const g = probeGround(env, x, top + 0.3, z, 4);
        if (g === BLOCKED || g === -Infinity) continue;
        const h = top - g;
        if (h > 1.2 && h < 2.0) found = { x, z, fx: -(nx * c + nz * sn), fz: -(-nx * sn + nz * c), top };
      }
    }
    expect(found).not.toBeNull();
    const f = found!;
    const p = spawnAt(f.x, probeGround(env, f.x, f.top + 0.3, f.z, 4), f.z);
    const yaw = Math.atan2(f.fx, f.fz);
    for (let i = 0; i < 10; i++) stepPlayer(p, cmd({ yaw }), TICK_DT, env);
    let mantled = false;
    for (let i = 0; i < 90; i++) {
      stepPlayer(p, cmd({ yaw, moveZ: 1, buttons: i === 20 ? Btn.Jump : 0 }), TICK_DT, env);
      if (p.move === Move.Mantle) mantled = true;
    }
    expect(mantled).toBe(true);
    expect(p.y).toBeGreaterThan(f.top - 0.5);
  });

  it("boats stay on water and vespas stay on land", () => {
    const sim = new MatchSim(world, { env });
    const p = sim.addPlayer(1, { name: "A", color: 0xff0000, isBot: false });
    for (const v of sim.vehicles) {
      sim.enterVehicle(p, v.id, 0);
      for (let i = 0; i < 60 * 12; i++) {
        sim.applyInput(1, cmd({ seq: i, moveZ: 1, moveX: Math.sin(i * 0.01) }));
        sim.step();
        if (v.kind === VehicleKind.Vespa) {
          const w = waterAt(env, v.x, v.z);
          const g = terrainHeight(world, v.x, v.z);
          if (w !== NO_WATER_Y) expect(w - g).toBeLessThan(0.9);
        } else if (v.kind === VehicleKind.Gyrocopter) {
          expect(v.y).toBeGreaterThan(terrainHeight(world, v.x, v.z) - 0.5);
          expect(v.y).toBeLessThanOrEqual(GYRO_CEILING);
        } else {
          // boats: afloat, or beached at the water's edge (never motoring inland)
          const g = terrainHeight(world, v.x, v.z);
          expect(v.y - g).toBeGreaterThan(BOAT_DRAFT - 0.05);
          if (waterAt(env, v.x, v.z) === NO_WATER_Y) expect(g).toBeLessThan(1.5);
        }
      }
      expect(p.move).toBe(Move.Vehicle);
      sim.applyInput(1, cmd({ seq: 9999, buttons: Btn.Interact }));
      sim.step();
      sim.applyInput(1, cmd({ seq: 10000 }));
      sim.step();
      expect(p.vehicle).toBe(-1);
      expect(bodyClearance(p)).toBeGreaterThan(-0.1);
      if (!p.alive) sim.respawn(p, 0);
    }
  });

  it("rides a zipline to the bottom", () => {
    const sim = new MatchSim(world, { env });
    const p = sim.addPlayer(1, { name: "A", color: 0xff0000, isBot: false });
    const z = env.ziplines[0];
    if (!z) return;
    sim.teleport(1, z.ax, z.ay - 2.2, z.az);
    for (let i = 0; i < 40; i++) { sim.applyInput(1, cmd({ seq: i })); sim.step(); }
    sim.applyInput(1, cmd({ seq: 50, buttons: Btn.Interact }));
    sim.step();
    expect(p.move).toBe(Move.Zipline);
    for (let i = 0; i < 60 * 40 && p.move === Move.Zipline; i++) { sim.applyInput(1, cmd({ seq: 100 + i })); sim.step(); }
    expect(p.move).not.toBe(Move.Zipline);
    expect(Math.hypot(p.x - z.bx, p.z - z.bz)).toBeLessThan(z.length * 0.2);
  });

  it("walls stop paintballs", () => {
    const sim = new MatchSim(world, { env });
    const a = sim.addPlayer(1, { name: "A", color: 0xff0000, isBot: false });
    const b = sim.addPlayer(2, { name: "B", color: 0x00ff00, isBot: false });
    // put B behind the biggest structure wall relative to A
    const st = world.structures.reduce((m, s) => (s.solids.length > m.solids.length ? s : m));
    const wall = st.solids.find((s) => s.shape === "box" && s.hy > 1.2 && Math.max(s.hx, s.hz) > 2 && Math.min(s.hx, s.hz) < 0.6)!;
    if (!wall) return;
    const c = Math.cos(wall.rotY), sn = Math.sin(wall.rotY);
    const thinX = wall.hx < wall.hz;
    const off = (d: number) => (thinX ? [d * c, -d * sn] : [d * sn, d * c]);
    const [ax, az] = off(6), [bx, bz] = off(-2);
    sim.teleport(1, wall.cx + ax, NaN, wall.cz + az);
    sim.teleport(2, wall.cx + bx, NaN, wall.cz + bz);
    for (let i = 0; i < 30; i++) sim.step();
    a.shield = 0; b.shield = 0;
    let hits = 0;
    for (let i = 0; i < 120; i++) {
      const dx = b.x - a.x, dz = b.z - a.z;
      sim.applyInput(1, cmd({ seq: i, yaw: Math.atan2(dx, dz), pitch: Math.atan2(b.y + 1 - (a.y + 1.45), Math.hypot(dx, dz)), buttons: Btn.Fire | Btn.Aim }));
      sim.step();
      for (const e of sim.events) if (e.type === "hit") hits++;
      sim.events.length = 0;
    }
    // B stands right behind a wall taller than both of them
    if (wall.cy + wall.hy > b.y + 1.8 && wall.cy - wall.hy < b.y + 0.3) expect(hits).toBe(0);
  });
});

describe("slopes", () => {
  it("can't walk up a cliff; slides back down instead", async () => {
    const { terrainNormal } = await import("../shared/world/collide");
    let spot: { x: number; z: number; dx: number; dz: number } | null = null;
    for (let x = -450; x < 450 && !spot; x += 3) for (let z = -450; z < 450 && !spot; z += 3) {
      const n = terrainNormal(world, x, z);
      if (n.y > 0.3 && n.y < 0.62 && terrainHeight(world, x, z) > 4 && waterAt(env, x, z) === NO_WATER_Y) {
        const l = Math.hypot(n.x, n.z);
        const m = terrainNormal(world, x - (n.x / l) * 3, z - (n.z / l) * 3);
        if (m.y < 0.62) spot = { x, z, dx: n.x / l, dz: n.z / l };
      }
    }
    if (!spot) return;
    const p = spawnAt(spot.x, terrainHeight(world, spot.x, spot.z), spot.z);
    const y0 = p.y;
    const yaw = Math.atan2(-spot.dx, -spot.dz); // face uphill
    let maxY = y0;
    for (let i = 0; i < 180; i++) {
      stepPlayer(p, cmd({ yaw, moveZ: 1, buttons: Btn.Sprint }), TICK_DT, env);
      maxY = Math.max(maxY, p.y);
    }
    expect(maxY - y0).toBeLessThan(1.2);
  });
});

describe("snapshots", () => {
  it("capture is a plain deep copy that round-trips through JSON", () => {
    const sim = new MatchSim(world, { env });
    sim.addPlayer(1, { name: "A", color: 0xff0000, isBot: false });
    sim.addPlayer(2, { name: "B", color: 0x00ff00, isBot: true });
    sim.paint(1, 2);
    for (let i = 0; i < 30; i++) { sim.applyInput(1, cmd({ seq: i, moveZ: 1, buttons: Btn.Fire })); sim.step(); }
    const snap = captureSnapshot(sim);
    const json = JSON.parse(JSON.stringify(snap));
    expect(json.players.length).toBe(2);
    expect(json.players[0].x).toBe(sim.players[0].x);
    // no aliasing
    snap.players[0].coats.push(123);
    expect(sim.players[0].coats.length).toBeLessThan(snap.players[0].coats.length);
    const p = createPlayerState(1);
    restorePlayer(p, json.players[0]);
    expect(p.lastSeq).toBe(29);
  });
});

describe("sky drop", () => {
  /** Glide p toward (tx, tz) like a player would (look at the spot, hold W) until it lands. */
  function glideTo(sim: MatchSim, id: number, tx: number, tz: number, maxSec = 60): { t: number; fx: number } {
    const p = sim.player(id)!;
    let fx = 0, t = 0;
    for (let i = 0; i < maxSec * 60 && p.move === Move.Glide; i++) {
      const dx = tx - p.x, dz = tz - p.z, d = Math.hypot(dx, dz);
      // height over the target, or over any rise on the way there
      let g = terrainHeight(world, tx, tz);
      for (const a of [30, 70]) if (a < d) g = Math.max(g, terrainHeight(world, p.x + (dx / d) * a, p.z + (dz / d) * a) + 4);
      const h = Math.max(1, p.y - g);
      const c = cmd({ seq: i, yaw: d > 1 ? Math.atan2(dx, dz) : p.yaw, pitch: -Math.min(1.45, Math.atan2(h, d)), moveZ: 1 });
      sim.applyInput(id, c);
      sim.step();
      t += TICK_DT;
      for (const e of sim.events) if (e.type === "move" && e.pid === id) fx |= e.fx;
      sim.events.length = 0;
    }
    return { t, fx };
  }

  it("starts high over the island, gliding and shielded (match start and every respawn)", () => {
    const sim = new MatchSim(world, { env });
    const p = sim.addPlayer(1, { name: "A", color: 0xff0000, isBot: false });
    let maxH = 0;
    for (let i = 0; i < world.height.length; i++) maxH = Math.max(maxH, world.height[i]);
    expect(p.alive).toBe(true);
    expect(p.move).toBe(Move.Glide);
    expect(p.y).toBeGreaterThanOrEqual(DROP_MIN_Y);
    expect(p.y).toBeLessThanOrEqual(DROP_MAX_Y);
    expect(p.y).toBeGreaterThan(maxH + 30);
    expect(Math.hypot(p.x - sim.drop.cx, p.z - sim.drop.cz)).toBeLessThanOrEqual(DROP_SCATTER + 0.01);
    expect(terrainHeight(world, sim.drop.cx, sim.drop.cz)).toBeGreaterThan(-5);
    // nobody can paint a sky diver
    sim.addPlayer(2, { name: "B", color: 0x00ff00, isBot: false });
    sim.step();
    expect(p.shield).toBeGreaterThan(0);
    sim.paint(1, 2);
    expect(p.coats.length).toBe(0);
    expect(sim.events.some((e) => e.type === "shield" && e.target === 1)).toBe(true);
    // eliminated players drop again after RESPAWN_DELAY
    p.shield = 0;
    for (let i = 0; i < 3; i++) sim.paint(1, 2);
    expect(p.alive).toBe(false);
    for (let i = 0; i < 60 * RESPAWN_DELAY + 2; i++) sim.step();
    expect(p.alive).toBe(true);
    expect(p.move).toBe(Move.Glide);
    expect(p.y).toBeGreaterThan(DROP_MIN_Y - 3);
  });

  it("eliminated players leave their leftover paint (and upgrades) behind", () => {
    const sim = new MatchSim(world, { env });
    const a = sim.addPlayer(1, { name: "A", color: 0xff0000, isBot: false });
    sim.addPlayer(2, { name: "B", color: 0x00ff00, isBot: false });
    const s = flatSpot();
    sim.teleport(1, s.x, s.y, s.z);
    for (let i = 0; i < 30; i++) sim.step();
    a.shield = 0;
    a.hopper = 12; a.reserve = 50;
    for (let i = 0; i < 3; i++) sim.paint(1, 2);
    expect(a.alive).toBe(false);
    const k = sim.pickups.find((k) => k.ammo > 0)!;
    expect(k.ammo).toBe(62);
    expect(k.drop).toBe(0);
    // someone low on paint scoops it up
    const c = sim.addPlayer(3, { name: "C", color: 0x0000ff, isBot: false });
    c.move = Move.Ground; c.shield = 0; c.reserve = 10;
    expect(sim.collect(c, k)).toBe(true);
    expect(c.reserve).toBe(72);
  });

  it("a hands-off drop (default view) takes 10-20 s and lands with a splat: no damage, no stumble, shielded a moment after", () => {
    const sim = new MatchSim(world, { env });
    const p = sim.addPlayer(1, { name: "A", color: 0xff0000, isBot: false });
    const s = flatSpot();
    let t = 0, fx = 0, splatT = 0, landShield = 0;
    // no keys, the view the drop starts with: glide along it toward the flat spot
    const yaw = Math.atan2(s.x - p.x, s.z - p.z);
    for (let i = 0; i < 60 * 30 && p.move === Move.Glide; i++) {
      sim.applyInput(1, cmd({ seq: i, yaw, pitch: -0.45 }));
      sim.step();
      t += TICK_DT;
      expect(p.shield).toBeGreaterThan(0);
      for (const e of sim.events) if (e.type === "move" && e.pid === 1) fx |= e.fx;
      sim.events.length = 0;
    }
    expect(t).toBeGreaterThan(10);
    expect(t).toBeLessThan(20);
    expect(fx & Fx.SkyLand).toBeTruthy();
    expect(fx & Fx.LandHard).toBeFalsy();
    if (p.move === Move.Splat) {
      // pancaked, then back up
      landShield = p.shield;
      for (let i = 0; i < 60 && p.move === Move.Splat; i++) { sim.applyInput(1, cmd({ seq: 5000 + i, yaw, moveZ: 1 })); sim.step(); splatT += TICK_DT; }
      expect(splatT).toBeGreaterThan(SPLAT_TIME - 0.05);
      expect(splatT).toBeLessThan(SPLAT_TIME + 0.1);
      expect(p.move).toBe(Move.Ground);
      expect(landShield).toBeGreaterThan(DROP_LAND_SHIELD - 0.05);
    }
    expect(p.stumble).toBeLessThanOrEqual(0);
    expect(p.coats.length).toBe(0);
    expect(p.alive).toBe(true);
    expect(bodyClearance(p)).toBeGreaterThan(-0.12);
    // the landing shield runs out
    for (let i = 0; i < 60 * (DROP_LAND_SHIELD + 0.2); i++) { sim.applyInput(1, cmd({ seq: 6000 + i, yaw })); sim.step(); }
    expect(p.shield).toBeLessThanOrEqual(0);
  });

  it("flies like an Apex skydive: look down to dive, W / S for speed, dive speed carries into a glide", () => {
    /** Fly for `sec` s with a fixed input from a fresh drop; returns horizontal speed and sink rate. */
    const fly = (legs: [number, Partial<InputCmd>][]) => {
      const sim = new MatchSim(world, { env });
      const p = sim.addPlayer(1, { name: "A", color: 0xff0000, isBot: false });
      p.y += 300; // plenty of air under us
      let i = 0;
      for (const [sec, c] of legs) for (let k = 0; k < sec * 60; k++) { sim.applyInput(1, cmd({ seq: i++, ...c })); sim.step(); }
      expect(p.move).toBe(Move.Glide);
      return { hs: Math.hypot(p.vx, p.vz), sink: -p.vy };
    };
    const levelW = fly([[6, { moveZ: 1 }]]), levelS = fly([[6, { moveZ: -1 }]]), level = fly([[6, {}]]);
    expect(levelW.hs).toBeGreaterThan(level.hs + 4);
    expect(level.hs).toBeGreaterThan(levelS.hs + 4);
    // level: a long flat glide; looking down: a steep fast dive
    expect(levelW.hs / levelW.sink).toBeGreaterThan(3.5);
    const dive = fly([[6, { moveZ: 1, pitch: -1.45 }]]);
    expect(dive.sink).toBeGreaterThan(45);
    expect(dive.hs).toBeLessThan(15);
    // looking up: no flatter than level, and slower
    const up = fly([[6, { moveZ: 1, pitch: 0.8 }]]);
    expect(up.hs).toBeLessThan(levelW.hs);
    // dive, then pull up: coasting faster than a level glide can go
    const swoop = fly([[4, { moveZ: 1, pitch: -1.2 }], [2, { moveZ: 1 }]]);
    expect(swoop.hs).toBeGreaterThan(levelW.hs + 8);
  });

  it("can reach any corner of the island, and land right where it aims", () => {
    const sim = new MatchSim(world, { env });
    // the spawn point farthest from the drop zone (spawns sit on dry land all over the island)
    let far = world.spawns[0], fd = 0;
    for (const s of world.spawns) {
      const d = Math.hypot(s.x - sim.drop.cx, s.z - sim.drop.cz);
      if (d > fd) { fd = d; far = s; }
    }
    expect(fd).toBeGreaterThan(350);
    let worst = 0;
    for (let k = 0; k < 4; k++) {
      const p = sim.addPlayer(10 + k, { name: "G" + k, color: 0xff0000, isBot: false });
      // start on the far side of the scatter circle: the worst case
      const ang = Math.atan2(far.x - sim.drop.cx, far.z - sim.drop.cz) + Math.PI + (k - 1.5) * 0.4;
      p.x = sim.drop.cx + Math.sin(ang) * DROP_SCATTER;
      p.z = sim.drop.cz + Math.cos(ang) * DROP_SCATTER;
      const { t } = glideTo(sim, p.id, far.x, far.z);
      expect(p.move).not.toBe(Move.Glide);
      worst = Math.max(worst, Math.hypot(p.x - far.x, p.z - far.z));
      expect(t).toBeLessThan(45);
      sim.removePlayer(p.id);
    }
    expect(worst).toBeLessThan(12);
    // and a close target, straight down
    const p = sim.addPlayer(20, { name: "H", color: 0xff0000, isBot: false });
    const s = flatSpot();
    glideTo(sim, 20, s.x, s.z);
    expect(Math.hypot(p.x - s.x, p.z - s.z)).toBeLessThan(8);
  });

  it("splashes down into a swim over water", () => {
    const sim = new MatchSim(world, { env });
    const p = sim.addPlayer(1, { name: "A", color: 0xff0000, isBot: false });
    // open sea out toward the edge
    let tx = 0;
    for (let r = 300; r < 500; r += 10) { tx = r; if (probeGround(env, sim.drop.cx + r, 0, sim.drop.cz, 60) < -3) break; }
    const { fx } = glideTo(sim, 1, sim.drop.cx + tx, sim.drop.cz);
    expect(p.move).toBe(Move.Swim);
    expect(fx & Fx.WaterEnter).toBeTruthy();
    expect(p.alive).toBe(true);
  });

  it("slides off roofs it can't stand on, and never ends up inside anything", () => {
    const sim = new MatchSim(world, { env });
    let worst = Infinity, stuck = 0;
    for (let k = 0; k < Math.min(10, world.structures.length); k++) {
      const st = world.structures[(k * 7) % world.structures.length];
      const p = sim.addPlayer(30 + k, { name: "R" + k, color: 0xff0000, isBot: false });
      glideTo(sim, p.id, st.x + 0.7, st.z - 0.4);
      // whatever we landed on: a few seconds later we're free (not wedged, not sliding forever)
      for (let i = 0; i < 60 * 3; i++) { sim.applyInput(p.id, cmd({ seq: 9000 + i })); sim.step(); if (i % 10 === 0) worst = Math.min(worst, bodyClearance(p)); }
      if (p.move === Move.Glide || p.move === Move.Splat) stuck++;
      sim.removePlayer(p.id);
    }
    expect(stuck).toBe(0);
    expect(worst).toBeGreaterThan(-0.15);
  });
});
