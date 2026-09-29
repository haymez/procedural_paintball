// Match protocol: message round trips, quantization bounds, delta encoding.
import { describe, expect, it } from "vitest";
import {
  C2S, DebugCmd, EV_TYPES, Input, MatchInit, NetStats, OWN, PickupOp, REMOTE, Reader, Roster, S2C, Snapshot, VEHICLE, Writer,
  applyDeltaRec, applyWire, decode, deltaFromState, dequantize, encode, newWire, packIds, packPair, quantize, quantizeCmd,
  quantizeInto, readDelta, unpackIds, unpackPair, writeDelta, packSeats, unpackSeats,
  type NetEvent, type SnapshotMsg,
} from "../shared/net/index";
import { createPlayerState, Move, type InputCmd, type SimEvent, type VehicleState } from "../shared/sim/index";
import { VehicleKind } from "../shared/world/types";

function rt<T>(reg: typeof C2S, def: { id: number }, msg: T): T {
  const bytes = encode(def as never, msg as never);
  const d = decode(reg, bytes);
  expect(d.def.id).toBe(def.id);
  return d.msg as T;
}

function player(): ReturnType<typeof createPlayerState> {
  const p = createPlayerState(7);
  Object.assign(p, {
    x: 123.456, y: 17.25, z: -301.9, vx: 5.43, vy: -3.2, vz: 0.07, yaw: 2.2, pitch: -0.4, move: Move.Air, moveT: 0.37,
    grounded: false, sprinting: true, aiming: false, alive: true, jumpHeld: true, stamina: 0.61, staminaDelay: 0.3,
    gnx: 0.1, gny: 0.98, gnz: -0.05, hopper: 13, reserve: 45, shotSeq: 88, fireCd: 0.05, reload: 0, shield: 0.4, breath: 0.8,
    upgrades: 0b1010, score: 4, deaths: 2, style: 9, streak: 1, vehicle: -1, seat: -1, zip: -1, zipT: 0, zipV: 0, spawnPick: -1,
    mx0: 1, my0: 2, mz0: 3, mx1: 4, my1: 5, mz1: 6, mDur: 0.3, waterY: -1e9, wash: 0.2, deadT: 0,
  });
  p.coatBy.push(3, 130);
  p.spawnChoices.push(12, 37);
  return p;
}

describe("input", () => {
  it("round-trips a batch, and quantizeCmd matches the wire exactly", () => {
    const cmds: InputCmd[] = [
      { seq: 0, moveX: 0.3, moveZ: -1, yaw: 7.1, pitch: 0.33, buttons: 1 | 4 | 256 },
      { seq: 0, moveX: -0.7071, moveZ: 0.7071, yaw: -2.5, pitch: -1.2, buttons: 0 },
      { seq: 0, moveX: 1, moveZ: 1, yaw: 0, pitch: 1.6, buttons: 0xffff },
    ];
    const q = cmds.map((c) => quantizeCmd({ ...c }));
    const m = rt(C2S, Input, { seq: 1000, cmds, view: 4321.75 });
    expect(m.seq).toBe(1000);
    expect(m.view).toBeCloseTo(4321.75, 2);
    m.cmds.forEach((c, i) => {
      expect(c.seq).toBe(1000 + i);
      expect(c.moveX).toBe(q[i]!.moveX);
      expect(c.moveZ).toBe(q[i]!.moveZ);
      expect(c.yaw).toBeCloseTo(q[i]!.yaw, 12);
      expect(c.pitch).toBeCloseTo(q[i]!.pitch, 12);
      expect(c.buttons).toBe(q[i]!.buttons);
      expect(Math.abs(c.moveX - cmds[i]!.moveX)).toBeLessThanOrEqual(0.5 / 127 + 1e-9);
    });
    // quantizing twice changes nothing (the client predicts with the wire values)
    for (const c of q) expect(quantizeCmd({ ...c })).toEqual(c);
    const b = encode(Input, { seq: 1, cmds, view: 0 });
    expect(b.length).toBeLessThan(11 + cmds.length * 9);
  });

  it("debug command round-trips", () => {
    expect(rt(C2S, DebugCmd, { op: 3, a: 131, b: 10, c: 0 })).toEqual({ op: 3, a: 131, b: 10, c: 0 });
  });
});

describe("entity schemas", () => {
  it("REMOTE quantization stays within its error bounds", () => {
    const p = player();
    const wire = quantizeInto(REMOTE, p, newWire(REMOTE));
    const q = applyWire(REMOTE, wire, createPlayerState(7));
    expect(Math.abs(q.x - p.x)).toBeLessThanOrEqual(1 / 512 / 2 + 1e-9);
    expect(Math.abs(q.z - p.z)).toBeLessThanOrEqual(1 / 512 / 2 + 1e-9);
    expect(Math.abs(q.y - p.y)).toBeLessThanOrEqual(1 / 512 / 2 + 1e-9);
    expect(Math.abs(q.vx - p.vx) / Math.abs(p.vx)).toBeLessThan(1e-3);
    expect(Math.abs(q.vy - p.vy) / Math.abs(p.vy)).toBeLessThan(1e-3);
    expect(Math.abs(q.yaw - p.yaw)).toBeLessThanOrEqual(Math.PI / 65536 + 1e-9);
    expect(Math.abs(q.pitch - p.pitch)).toBeLessThanOrEqual(1.5 / 127 / 2 + 1e-9);
    expect(q.move).toBe(p.move);
    expect([q.grounded, q.sprinting, q.aiming, q.alive]).toEqual([p.grounded, p.sprinting, p.aiming, p.alive]);
    expect(q.coatBy).toEqual([3, 130]);
    expect([q.score, q.deaths, q.style, q.upgrades]).toEqual([4, 2, 9, 10]);
    expect(Math.abs(q.shield - p.shield)).toBeLessThanOrEqual(2.5 / 255);
  });

  it("OWN is float32-exact for everything stepPlayer and the marker read", () => {
    const p = player();
    const q = applyWire(OWN, quantizeInto(OWN, p, newWire(OWN)), createPlayerState(7));
    for (const f of OWN.fields) {
      if (f.kind === "f32") expect((q as unknown as Record<string, number>)[f.name]).toBe(Math.fround((p as unknown as Record<string, number>)[f.name]!));
    }
    expect([q.hopper, q.reserve, q.shotSeq, q.prevButtons, q.move]).toEqual([p.hopper, p.reserve, p.shotSeq, p.prevButtons, p.move]);
    expect(q.spawnChoices).toEqual([12, 37]);
    expect(q.coatBy).toEqual([3, 130]);
    expect(q.jumpHeld && !q.exhausted && q.alive).toBe(true);
  });

  it("delta encoding sends only changed fields and reproduces the state", () => {
    const p = player();
    const base = quantizeInto(REMOTE, p, newWire(REMOTE));
    const client = base.slice();
    const w = new Writer();
    // unchanged: a single zero mask byte
    expect(writeDelta(w, REMOTE, quantizeInto(REMOTE, p, newWire(REMOTE)), base)).toBe(0);
    expect(w.pos).toBe(1);
    p.x += 0.2;
    p.vx = 1.5;
    p.coatBy.push(9);
    const cur = quantizeInto(REMOTE, p, newWire(REMOTE));
    w.reset();
    expect(writeDelta(w, REMOTE, cur, base)).toBe(3);
    expect(w.pos).toBeLessThanOrEqual(10); // mask 2 + dx 2 + vx 2 + coats 4
    expect(Array.from(base)).toEqual(Array.from(cur)); // baseline advanced
    const n = readDelta(new Reader(w.finish()), REMOTE, client);
    expect(n).toBe(3);
    expect(Array.from(client)).toEqual(Array.from(cur));
  });

  it("vehicle schema and packers", () => {
    const v: VehicleState = {
      id: 2, kind: VehicleKind.Gondola, x: 10.5, y: 0.1, z: -40, yaw: 1.2, speed: 3.3, vy: 0, steer: -0.4, throttle: 1, pitch: 0,
      airborne: false, seats: [5, -1, 131], idle: 0, sx: 0, sy: 0, sz: 0, syaw: 0,
    };
    const q = applyWire(VEHICLE, quantizeInto(VEHICLE, v, newWire(VEHICLE)), { ...v, seats: [0, 0, 0], x: 0 });
    expect(q.x).toBe(10.5);
    expect(q.seats).toEqual([5, -1, 131]);
    const seats = [0, 0];
    unpackSeats(packSeats([-1, 7]), seats);
    expect(seats).toEqual([-1, 7]);
    expect(unpackIds(packIds([0, 254, 128]), [])).toEqual([0, 254, 128]);
    expect(unpackIds(packIds([]), [])).toEqual([]);
    expect(unpackPair(packPair([4094, 0]), [])).toEqual([4094, 0]);
    for (const f of REMOTE.fields) expect(dequantize(f as never, quantize(f as never, 0))).toBeCloseTo(f.kind === "q16" || f.kind === "u8q" ? Math.max(f.min, Math.min(f.max, 0)) : 0, 1);
    // positions: absolute on first send, then small signed differences
    const w2 = new Writer();
    const a = player(), b0 = quantizeInto(REMOTE, a, newWire(REMOTE));
    const recv = newWire(REMOTE);
    writeDelta(w2, REMOTE, b0, null);
    readDelta(new Reader(w2.finish()), REMOTE, recv);
    a.x -= 0.137; a.z += 0.25; a.y -= 3;
    const b1 = quantizeInto(REMOTE, a, newWire(REMOTE));
    const base = b0.slice();
    w2.reset();
    writeDelta(w2, REMOTE, b1, base);
    expect(w2.pos).toBeLessThanOrEqual(1 + 2 + 2 + 2);
    readDelta(new Reader(w2.finish()), REMOTE, recv);
    expect(Array.from(recv)).toEqual(Array.from(b1));
  });
});

const sampleEvents: SimEvent[] = [
  { type: "shot", pid: 3, proj: 901, x: 10, y: 5, z: -3, vx: 40, vy: 5, vz: -12, color: 0 },
  { type: "hit", target: 4, shooter: 3, x: 11, y: 6, z: -2, dx: 0.6, dz: -0.8, coats: 2, color: 0 },
  { type: "shield", target: 4, shooter: 3, x: 1, y: 2, z: 3 },
  { type: "vest", target: 4, shooter: 3, x: 1, y: 2, z: 3 },
  { type: "splat", proj: 902, shooter: 3, x: 1, y: 2, z: 3, nx: 0, ny: 1, nz: 0, color: 0, r: 0.55, surf: 1 },
  { type: "splash", proj: 903, x: 1, y: 0, z: 3, size: 0.35 },
  { type: "projEnd", proj: 904 },
  { type: "elim", victim: 4, killer: 3, x: 1, y: 2, z: 3, tags: 5, place: "", dist: 22.5 },
  { type: "elim", victim: 4, killer: -1, x: 1, y: 2, z: 3, tags: 0, place: "", dist: 0 },
  { type: "respawn", pid: 4, x: -100, y: 20, z: 50 },
  { type: "spawnChoices", pid: 4 },
  { type: "pickup", pid: 3, pickup: 70, kind: 2, drop: 6, x: 5, y: 6, z: 7 },
  { type: "pickupSpawn", pickup: 12 },
  { type: "vehicleEnter", pid: 3, vehicle: 2, seat: 1 },
  { type: "vehicleExit", pid: 3, vehicle: 2 },
  { type: "vehicleBump", vehicle: 2, speed: 7.5 },
  { type: "vehicleReset", vehicle: 2 },
  { type: "zipStart", pid: 3, zip: 1 },
  { type: "zipEnd", pid: 3, zip: -1 },
  { type: "wash", pid: 3, coats: 1, color: 0xff6b6b },
  { type: "wear", pid: 3, coats: 0, color: 0x6bff6b },
  { type: "move", pid: 3, fx: 1 | 64, x: 1, y: 2, z: 3, speed: 8.25 },
  { type: "reload", pid: 3 },
  { type: "matchEnd" },
];

describe("snapshot", () => {
  it("round-trips every section and every event type", () => {
    const p = player();
    const events: NetEvent[] = sampleEvents.map((e, i) => ({ ...e, tick: 998 + (i % 3), ...(e.type === "shot" ? { seq: 41 } : {}) }) as NetEvent);
    const msg: SnapshotMsg = {
      tick: 1000,
      ack: 777,
      buf: 3,
      own: deltaFromState(OWN, p),
      players: [{ id: 9, d: deltaFromState(REMOTE, p, ["x", "y", "z", "coats"]) }, { id: 10, d: { idx: [], vals: [] } }],
      vehicles: [{ id: 1, d: { idx: [0, 4], vals: [Math.fround(3.5), Math.fround(-2)] } }],
      pickups: [
        { id: 3, op: PickupOp.Off },
        { id: 4, op: PickupOp.On },
        { id: 80, op: PickupOp.Add, init: { id: 80, kind: 5, x: 1, y: 2, z: 3, active: true, drop: 32 } },
        { id: 81, op: PickupOp.Remove },
      ],
      events,
    };
    const got = rt(S2C, Snapshot, msg);
    expect(got.tick).toBe(1000);
    expect(got.ack).toBe(777);
    expect(got.buf).toBe(3);
    const own = newWire(OWN);
    applyDeltaRec(OWN, got.own!, own);
    expect(Array.from(own)).toEqual(Array.from(quantizeInto(OWN, p, newWire(OWN))));
    expect(got.players.map((x) => x.id)).toEqual([9, 10]);
    expect(got.players[0]!.d.idx.length).toBe(4);
    expect(got.players[1]!.d.idx.length).toBe(0);
    expect(got.vehicles[0]!.d).toEqual({ idx: [0, 4], vals: [3.5, -2], abs: false });
    expect(got.pickups.map((k) => k.op)).toEqual([PickupOp.Off, PickupOp.On, PickupOp.Add, PickupOp.Remove]);
    expect(got.pickups[2]!.init!.drop).toBe(32);
    expect(got.events.map((e) => e.type)).toEqual(sampleEvents.map((e) => e.type));
    expect(got.events.map((e) => e.tick)).toEqual(events.map((e) => e.tick));
    const shot = got.events[0] as Extract<NetEvent, { type: "shot" }>;
    expect(shot.seq).toBe(41);
    expect(shot.proj).toBe(901);
    expect(shot.vx).toBeCloseTo(40, 1);
    expect(shot.x).toBeCloseTo(10, 1);
    const hit = got.events[1] as Extract<NetEvent, { type: "hit" }>;
    expect(hit.dx).toBeCloseTo(0.6, 1);
    expect(hit.coats).toBe(2);
    expect((got.events[8] as Extract<NetEvent, { type: "elim" }>).killer).toBe(-1);
    expect((got.events[19] as Extract<NetEvent, { type: "wash" }>).color).toBe(0xff6b6b);
    expect((got.events[20] as Extract<NetEvent, { type: "wear" }>).color).toBe(0x6bff6b);
    expect(EV_TYPES.length).toBeLessThan(256);
  });

  it("a quiet snapshot is tiny", () => {
    const b = encode(Snapshot, { tick: 123456, ack: 99999, buf: 2, own: { idx: [], vals: [] }, players: [], vehicles: [], pickups: [], events: [] });
    expect(b.length).toBeLessThanOrEqual(13);
  });

  it("match init, roster and stats round-trip", () => {
    const init = {
      you: 3, tick: 500, endsAt: 1.7e12, debug: true,
      roster: [{ id: 3, name: "Pesce Veloce", color: 4, bot: false }, { id: 128, name: "Nonna Bot", color: 19, bot: true }],
      pickups: [{ id: 0, kind: 0, x: 1, y: 2, z: 3, active: true, drop: 0 }],
      paint: [{ x: 1, y: 2, z: 3, nx: 0, ny: 1, nz: 0, r: 0.5, color: 7 }],
    };
    const g = rt(S2C, MatchInit, init);
    expect(g.roster).toEqual(init.roster);
    expect(g.paint[0]!.color).toBe(7);
    expect(g.pickups[0]!.x).toBeCloseTo(1, 1);
    expect(rt(S2C, Roster, { add: [init.roster[0]!], remove: [128, 4] })).toEqual({ add: [init.roster[0]!], remove: [128, 4] });
    const st = rt(S2C, NetStats, {
      tickP50: 1, tickP95: 2, tickP99: 3, tickMax: 4, simMs: 0.5, snapMs: 0.25, tickRate: 30, humans: 19, bots: 1, bytesOut: 4000,
      snapsPerSec: 30, inputDepth: 2, starved: 0, dropped: 0, clockLive: true,
    });
    expect(st.humans).toBe(19);
  });
});
