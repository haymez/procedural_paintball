// Jetski / speedboat water physics and the gyrocopter's arcade flight.
import { beforeAll, describe, expect, it } from "vitest";
import { generateWorld } from "../shared/world/generate";
import { sdf, terrainHeight } from "../shared/world/collide";
import { VehicleKind, type World } from "../shared/world/types";
import {
  Btn, createEnv, GYRO_CEILING, GYRO_SINK, MatchSim, Move, NO_WATER_Y, stepVehicle, TICK_DT, waterAt,
  type InputCmd, type SimEnv, type VehicleState,
} from "../shared/sim/index";
import { createVehicleState } from "../shared/sim/vehicle";

let world: World;
let env: SimEnv;
beforeAll(() => {
  world = generateWorld(42, { skipDecor: true });
  env = createEnv(world);
});

const cmd = (o: Partial<InputCmd> = {}): InputCmd => ({ seq: 0, moveX: 0, moveZ: 0, yaw: NaN, pitch: -0.14, buttons: 0, ...o });

/** A point on open water with ~250 m of deep sea ahead (heading away from the island). */
function openWater(): { x: number; z: number; yaw: number } {
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    const ux = Math.sin(a), uz = Math.cos(a);
    for (let r = 200; r < 420; r += 10) {
      let ok = true;
      for (let t = 0; t < 250 && ok; t += 5) {
        const x = ux * (r + t), z = uz * (r + t);
        if (Math.abs(x) > 490 || Math.abs(z) > 490 || terrainHeight(world, x, z) > -3) ok = false;
      }
      if (ok) return { x: ux * r, z: uz * r, yaw: a };
    }
  }
  throw new Error("no open water");
}

function boat(kind: VehicleKind, x: number, z: number, yaw: number): VehicleState {
  return createVehicleState(0, { kind, x, y: 0, z, rotY: yaw }, env);
}

describe("boats", () => {
  it("jetskis top 20 m/s and speedboats 17 m/s on open water, speedboats plane bow-up", () => {
    const o = openWater();
    for (const [kind, min] of [[VehicleKind.Jetski, 20], [VehicleKind.Speedboat, 17]] as const) {
      const v = boat(kind, o.x, o.z, o.yaw);
      let top = 0, pitch = 0;
      for (let i = 0; i < 60 * 8; i++) {
        stepVehicle(v, cmd({ moveZ: 1 }), TICK_DT, env);
        top = Math.max(top, v.speed);
        if (i === 60 * 2) pitch = v.pitch;
      }
      expect(top, VehicleKind[kind]).toBeGreaterThan(min);
      if (kind === VehicleKind.Speedboat) expect(pitch).toBeGreaterThan(0.04);
    }
  });

  it("jetskis hop on Jump and land back on the water", () => {
    const o = openWater();
    const v = boat(VehicleKind.Jetski, o.x, o.z, o.yaw);
    for (let i = 0; i < 60 * 2; i++) stepVehicle(v, cmd({ moveZ: 1 }), TICK_DT, env);
    stepVehicle(v, cmd({ moveZ: 1, buttons: Btn.Jump }), TICK_DT, env);
    expect(v.airborne).toBe(true);
    let peak = 0;
    // coast (at full speed the swells keep kicking it up too)
    for (let i = 0; i < 60 * 2; i++) { stepVehicle(v, cmd(), TICK_DT, env); peak = Math.max(peak, v.y); }
    expect(peak).toBeGreaterThan(0.5);
    expect(v.airborne).toBe(false);
    expect(v.y).toBeCloseTo(0, 3);
  });

  it("slide up onto the beach, stop, and back off into the water", () => {
    const o = openWater();
    for (const kind of [VehicleKind.Jetski, VehicleKind.Speedboat]) {
      // full throttle at the island centre from open water
      const v = boat(kind, o.x, o.z, o.yaw + Math.PI);
      for (let i = 0; i < 60 * 40; i++) {
        let d = Math.atan2(-v.x, -v.z) - v.yaw;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        stepVehicle(v, cmd({ moveZ: 1, moveX: -Math.max(-1, Math.min(1, d * 2)) }), TICK_DT, env);
        expect(sdf(env.cw, v.x, v.y + 0.4, v.z)).toBeGreaterThan(-0.05);
      }
      const g = terrainHeight(world, v.x, v.z);
      expect(Math.abs(v.speed), VehicleKind[kind]).toBeLessThan(0.5);
      expect(g).toBeLessThan(1.5); // at the water's edge, not up the hill
      expect(v.y - g).toBeGreaterThan(0.25); // hull resting on the bottom / afloat, never in it
      // reverse: back into the water, afloat
      for (let i = 0; i < 60 * 8; i++) stepVehicle(v, cmd({ moveZ: -1 }), TICK_DT, env);
      const W = waterAt(env, v.x, v.z);
      expect(W, VehicleKind[kind]).not.toBe(NO_WATER_Y);
      expect(v.y - W).toBeLessThan(0.05);
    }
  });
});

describe("gyrocopter", () => {
  const gyros = () => world.vehicles.filter((v) => v.kind === VehicleKind.Gyrocopter);

  it("takes off after a short run, climbs to the ceiling, floats down gently and flies again", () => {
    expect(gyros().length).toBe(2);
    const s = gyros()[0];
    const v = createVehicleState(0, s, env);
    // ground run straight ahead, stick back
    let run = -1;
    for (let i = 0; i < 60 * 4 && run < 0; i++) {
      stepVehicle(v, cmd({ moveZ: 1, pitch: 0.4, yaw: s.rotY }), TICK_DT, env);
      if (v.airborne) run = Math.hypot(v.x - s.x, v.z - s.z);
    }
    expect(run).toBeGreaterThan(0);
    expect(run).toBeLessThan(25);
    // climb hard while circling over the take-off spot
    let top = 0;
    for (let i = 0; i < 60 * 40; i++) {
      stepVehicle(v, cmd({ moveZ: 1, pitch: 0.6, yaw: v.yaw + 0.6 }), TICK_DT, env);
      top = Math.max(top, v.y);
    }
    expect(top).toBeGreaterThan(GYRO_CEILING - 5);
    expect(top).toBeLessThanOrEqual(GYRO_CEILING);
    // throttle back, hands off the climb: auto-rotation sink, not a stone
    let landed = -1;
    for (let i = 0; i < 60 * 70 && landed < 0; i++) {
      stepVehicle(v, cmd({ moveZ: -1, yaw: v.yaw + 0.3 }), TICK_DT, env);
      if (v.airborne) expect(v.vy).toBeGreaterThan(-(GYRO_SINK + 0.6));
      else landed = i;
    }
    expect(landed).toBeGreaterThan(0);
    expect(v.y).toBeGreaterThan(terrainHeight(world, v.x, v.z) - 0.3);
    // and away again from wherever it came down (if that's land)
    if (waterAt(env, v.x, v.z) === NO_WATER_Y) {
      let again = false;
      for (let i = 0; i < 60 * 6 && !again; i++) {
        stepVehicle(v, cmd({ moveZ: 1, pitch: 0.4, yaw: v.yaw }), TICK_DT, env);
        again = v.airborne;
      }
      expect(again).toBe(true);
    }
  });

  it("bounces off terrain instead of burying itself", () => {
    for (const s of gyros()) {
      for (let h = 0; h < 8; h++) {
        const yaw = s.rotY + (h / 8) * Math.PI * 2;
        const v = createVehicleState(0, { ...s, rotY: yaw }, env);
        for (let i = 0; i < 60 * 20; i++) {
          // level at low altitude, then dive into whatever is ahead
          const c = i < 60 * 8 ? cmd({ moveZ: 1, yaw }) : cmd({ moveZ: 1, pitch: -1, yaw });
          stepVehicle(v, c, TICK_DT, env);
          expect(Number.isFinite(v.x + v.y + v.z + v.speed)).toBe(true);
          expect(v.y).toBeGreaterThan(terrainHeight(world, v.x, v.z) - 0.5);
          expect(v.y).toBeLessThanOrEqual(GYRO_CEILING);
        }
      }
    }
  });

  it("bailing out mid-air drops the pilot beside it; the empty gyro floats down by itself", () => {
    const sim = new MatchSim(world, { env });
    const p = sim.addPlayer(1, { name: "A", color: 0xff0000, isBot: false });
    const v = sim.vehicles.find((q) => q.kind === VehicleKind.Gyrocopter)!;
    expect(sim.enterVehicle(p, v.id, 0)).toBe(true);
    for (let i = 0; i < 60 * 6; i++) {
      sim.applyInput(1, cmd({ seq: i, moveZ: 1, pitch: 0.6, yaw: v.yaw + 0.5 }));
      sim.step();
    }
    expect(v.airborne).toBe(true);
    const h = v.y - terrainHeight(world, v.x, v.z);
    expect(h).toBeGreaterThan(5);
    sim.applyInput(1, cmd({ seq: 1000, buttons: Btn.Interact }));
    sim.step();
    sim.applyInput(1, cmd({ seq: 1001 }));
    sim.step();
    expect(p.vehicle).toBe(-1);
    expect(p.move).toBe(Move.Air);
    expect(p.y).toBeGreaterThan(terrainHeight(world, p.x, p.z) + 3);
    for (let i = 0; i < 60 * 60 && v.airborne; i++) {
      sim.applyInput(1, cmd({ seq: 1002 + i }));
      sim.step();
    }
    expect(v.airborne).toBe(false);
    expect(p.alive).toBe(true);
  });
});
