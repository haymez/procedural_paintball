import { describe, expect, it } from "vitest";
import {
  C2S,
  Chat,
  ChatMsg,
  Difficulty,
  LobbyList,
  MatchBegin,
  Phase,
  Ping,
  PlayerStatus,
  ProtoError,
  Reader,
  Registry,
  Results,
  RoomStateMsg,
  S2C,
  UpdateSettings,
  Welcome,
  WorldReady,
  Writer,
  decode,
  encode,
  fromHalf,
  normalizeCode,
  sanitizeChat,
  sanitizeName,
  seedFromText,
  toHalf,
  type MsgDef,
  type RoomState,
} from "../shared/net/index";

function roundTrip<T>(reg: Registry, def: MsgDef<T>, msg: T): T {
  const bytes = encode(def, msg);
  const d = decode(reg, bytes);
  expect(d.def).toBe(def);
  return d.msg as T;
}

describe("codec", () => {
  it("round-trips scalars", () => {
    const w = new Writer(4); // forces growth
    w.u8(255).i8(-128).u16(65535).i16(-32768).u32(4294967295).i32(-2147483648);
    w.f32(1.5).f64(Math.PI).bool(true).bool(false);
    const r = new Reader(w.finish());
    expect([r.u8(), r.i8(), r.u16(), r.i16(), r.u32(), r.i32()]).toEqual([
      255, -128, 65535, -32768, 4294967295, -2147483648,
    ]);
    expect(r.f32()).toBe(1.5);
    expect(r.f64()).toBe(Math.PI);
    expect(r.bool()).toBe(true);
    expect(r.bool()).toBe(false);
    expect(r.remaining).toBe(0);
  });

  it("round-trips varints across the safe range", () => {
    const vals = [0, 1, 127, 128, 300, 16383, 16384, 2 ** 31 - 1, 2 ** 32, 2 ** 53 - 1];
    const w = new Writer();
    for (const v of vals) w.varu(v);
    const r = new Reader(w.finish());
    for (const v of vals) expect(r.varu()).toBe(v);
    expect(new Writer().varu(127).finish().length).toBe(1);
    expect(new Writer().varu(128).finish().length).toBe(2);
  });

  it("round-trips zigzag varints", () => {
    const vals = [0, -1, 1, -64, 63, -65, 1000, -1000, 2147483647, -2147483648];
    const w = new Writer();
    for (const v of vals) w.vari(v);
    const r = new Reader(w.finish());
    for (const v of vals) expect(r.vari()).toBe(v);
  });

  it("encodes f16 within half precision", () => {
    for (const v of [0, 1, -1, 0.5, 3.14159, 100.25, -2048, 65504, 1e-5]) {
      const back = fromHalf(toHalf(v));
      expect(Math.abs(back - v)).toBeLessThanOrEqual(Math.max(Math.abs(v) * 1e-3, 6e-8));
    }
    expect(fromHalf(toHalf(1e6))).toBe(Infinity);
    expect(Number.isNaN(fromHalf(toHalf(NaN)))).toBe(true);
    expect(Object.is(fromHalf(toHalf(-0)), -0)).toBe(true);
  });

  it("quantizes and clamps", () => {
    const w = new Writer();
    w.quant(0.5, 0, 1, 8).quant(-3, -10, 10, 16).quant(99, 0, 1, 8).quant(NaN, 0, 1, 8);
    w.angle(Math.PI, 16).angle(-Math.PI / 2, 8);
    const r = new Reader(w.finish());
    expect(r.quant(0, 1, 8)).toBeCloseTo(0.5, 2);
    expect(r.quant(-10, 10, 16)).toBeCloseTo(-3, 3);
    expect(r.quant(0, 1, 8)).toBe(1);
    expect(r.quant(0, 1, 8)).toBe(0);
    expect(r.angle(16)).toBeCloseTo(Math.PI, 3);
    expect(r.angle(8)).toBeCloseTo((3 * Math.PI) / 2, 1);
  });

  it("round-trips utf-8 strings", () => {
    const s = "Pesce Veloce 🐟 città — ok";
    const r = new Reader(new Writer().str(s).str("").finish());
    expect(r.str()).toBe(s);
    expect(r.str()).toBe("");
  });

  it("throws ProtoError on truncated or hostile input", () => {
    const bytes = new Writer().u32(7).finish();
    expect(() => new Reader(bytes.subarray(0, 3)).u32()).toThrow(ProtoError);
    const huge = new Writer().varu(1_000_000).finish();
    expect(() => new Reader(huge).str()).toThrow(ProtoError);
    expect(() => new Reader(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])).varu()).toThrow(
      ProtoError,
    );
    expect(() => decode(C2S, new Uint8Array([250]))).toThrow(ProtoError);
    expect(() => decode(C2S, new Uint8Array([]))).toThrow(ProtoError);
  });
});

describe("registry", () => {
  it("rejects duplicate ids per direction", () => {
    const reg = new Registry("c2s");
    reg.signal(70, "a");
    expect(() => reg.signal(70, "b")).toThrow(/already used/);
    expect(() => reg.signal(0, "zero")).toThrow();
  });

  it("lets the match phase add messages in its range", () => {
    const reg = new Registry("s2c");
    const Snap = reg.define<{ tick: number; xs: number[] }>(
      64,
      "snap",
      (w, m) => {
        w.u32(m.tick).varu(m.xs.length);
        for (const x of m.xs) w.quant(x, -512, 512, 16);
      },
      (r) => {
        const tick = r.u32();
        const n = r.count(64);
        const xs: number[] = [];
        for (let i = 0; i < n; i++) xs.push(r.quant(-512, 512, 16));
        return { tick, xs };
      },
    );
    const back = roundTrip(reg, Snap, { tick: 99, xs: [0, 100.5, -400] });
    expect(back.tick).toBe(99);
    back.xs.forEach((x, i) => expect(x).toBeCloseTo([0, 100.5, -400][i]!, 1));
  });
});

describe("lobby messages", () => {
  it("round-trips client messages", () => {
    expect(roundTrip(C2S, Ping, { t: 12345.678, rtt: 42 })).toEqual({ t: 12345.678, rtt: 42 });
    expect(roundTrip(C2S, Chat, { text: "ciao!" })).toEqual({ text: "ciao!" });
    expect(roundTrip(C2S, WorldReady, { seed: 4000000000, checksum: 0xdeadbeef })).toEqual({
      seed: 4000000000,
      checksum: 0xdeadbeef,
    });
    expect(roundTrip(C2S, UpdateSettings, { bots: 5, seed: 7 })).toEqual({ bots: 5, seed: 7 });
    const full = {
      name: "Cala Limone",
      public: true,
      seed: 123,
      hideSeed: true,
      bots: 19,
      difficulty: Difficulty.Hard,
      matchMinutes: 10,
    };
    expect(roundTrip(C2S, UpdateSettings, full)).toEqual(full);
    expect(roundTrip(C2S, UpdateSettings, {})).toEqual({});
  });

  it("round-trips room state", () => {
    const st: RoomState = {
      code: "ABCD",
      phase: Phase.Loading,
      phaseEndsAt: 1_700_000_000_000,
      hostId: 1,
      settings: {
        name: "Baia",
        public: false,
        seed: 42,
        hideSeed: false,
        bots: 2,
        difficulty: Difficulty.Normal,
        matchMinutes: 10,
      },
      players: [
        { id: 1, name: "Pesce", color: 3, host: true, bot: false, connected: true, status: PlayerStatus.Ready, progress: 1, ping: 35 },
        { id: 2, name: "Polpo", color: 7, host: false, bot: false, connected: false, status: PlayerStatus.Loading, progress: 0.4, ping: 0 },
        { id: 128, name: "Bip Bop", color: 19, host: false, bot: true, connected: true, status: PlayerStatus.Idle, progress: 1, ping: 0 },
      ],
    };
    const back = roundTrip(S2C, RoomStateMsg, st);
    expect(back.players[1]!.progress).toBeCloseTo(0.4, 2);
    back.players[1]!.progress = 0.4;
    expect(back).toEqual(st);
  });

  it("round-trips server messages", () => {
    const w = { you: 3, code: "WXYZ", rejoined: true, server: 1.7e12, tickHz: 30, graceMs: 20000 };
    expect(roundTrip(S2C, Welcome, w)).toEqual(w);
    const c = { from: 0, name: "", color: 0, text: "hi", at: 5 };
    expect(roundTrip(S2C, ChatMsg, c)).toEqual(c);
    const b = { seed: 9, startAt: 1e12, endsAt: 1e12 + 600000, tick: 30 };
    expect(roundTrip(S2C, MatchBegin, b)).toEqual(b);
    const res = {
      seed: 1,
      endedAt: 2,
      rows: [{ id: 1, name: "A", color: 2, bot: false, score: 12, deaths: 3 }],
    };
    expect(roundTrip(S2C, Results, res)).toEqual(res);
    const list = {
      rooms: [
        { code: "ABCD", name: "N", host: "H", players: 3, max: 20, bots: 4, phase: Phase.Playing, seed: null, region: "FRA", public: true },
        { code: "EFGH", name: "M", host: "J", players: 1, max: 20, bots: 0, phase: Phase.Lobby, seed: 77, region: "", public: true },
      ],
    };
    expect(roundTrip(S2C, LobbyList, list)).toEqual(list);
  });
});

describe("rules helpers", () => {
  it("normalizes codes", () => {
    expect(normalizeCode(" ab-cd ")).toBe("ABCD");
    expect(normalizeCode("ABC0")).toBe(null); // 0 not in alphabet
    expect(normalizeCode("ABCDE")).toBe(null);
  });
  it("sanitizes names and chat", () => {
    expect(sanitizeName("  Pesce‮  Veloce\u0000  ")).toBe("Pesce Veloce");
    expect(Array.from(sanitizeName("🐟".repeat(40))).length).toBe(18);
    expect(sanitizeChat("x".repeat(500)).length).toBe(160);
  });
  it("derives seeds from text", () => {
    expect(seedFromText("42")).toBe(42);
    expect(seedFromText("gelato")).toBe(seedFromText(" Gelato "));
    expect(seedFromText("gelato")).toBeGreaterThanOrEqual(0);
    expect(seedFromText("gelato")).toBeLessThan(2 ** 32);
  });
});
