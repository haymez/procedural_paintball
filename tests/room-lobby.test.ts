import { describe, expect, it } from "vitest";
import { CODE_RE, Phase, type RoomListing } from "../shared/net/index";
import { LobbyRegistry, RESERVATION_MS, ROOM_STALE_MS } from "../worker/lobby/registry";

function listing(code: string, extra: Partial<RoomListing> = {}): RoomListing {
  return {
    code,
    name: "Room",
    host: "Host",
    players: 1,
    max: 20,
    bots: 0,
    phase: Phase.Lobby,
    seed: 1,
    region: "",
    public: true,
    ...extra,
  };
}

describe("LobbyRegistry", () => {
  it("creates unique, valid, collision-checked codes", () => {
    const reg = new LobbyRegistry();
    let i = 0;
    const seq = [0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5]; // second code collides once
    const rand = () => seq[i++ % seq.length]!;
    const a = reg.create(false, 0, rand);
    const b = reg.create(false, 0, rand);
    expect(a).toMatch(CODE_RE);
    expect(b).not.toBe(a);
  });

  it("claims reserved and live codes only", () => {
    const reg = new LobbyRegistry();
    const code = reg.create(true, 0, Math.random);
    expect(reg.claim(code)).toEqual({ ok: true, public: true });
    expect(reg.claim("ZZZZ").ok).toBe(false);
    reg.report(listing(code), 1);
    expect(reg.reserved.has(code)).toBe(false);
    expect(reg.claim(code).ok).toBe(true);
  });

  it("lists public non-empty rooms, lobbies first", () => {
    const reg = new LobbyRegistry();
    reg.report(listing("AAAA", { phase: Phase.Playing, players: 9 }), 0);
    reg.report(listing("BBBB", { players: 2 }), 0);
    reg.report(listing("CCCC", { public: false }), 0);
    reg.report(listing("DDDD", { players: 0 }), 0);
    expect(reg.publicList().map((l) => l.code)).toEqual(["BBBB", "AAAA"]);
  });

  it("reports changes only when the listing changed", () => {
    const reg = new LobbyRegistry();
    expect(reg.report(listing("AAAA"), 0)).toBe(true);
    expect(reg.report(listing("AAAA"), 10)).toBe(false);
    expect(reg.report(listing("AAAA", { players: 2 }), 20)).toBe(true);
    expect(reg.remove("AAAA")).toBe(true);
    expect(reg.remove("AAAA")).toBe(false);
  });

  it("expires stale rooms and old reservations", () => {
    const reg = new LobbyRegistry();
    reg.report(listing("AAAA"), 0);
    reg.report(listing("BBBB"), ROOM_STALE_MS);
    const code = reg.create(false, 0, Math.random);
    expect(reg.sweep(ROOM_STALE_MS + 1)).toBe(true);
    expect([...reg.rooms.keys()]).toEqual(["BBBB"]);
    reg.sweep(RESERVATION_MS + 1);
    expect(reg.reserved.has(code)).toBe(false);
  });

  it("quick join prefers open lobbies, else creates a public room", () => {
    const reg = new LobbyRegistry();
    reg.report(listing("AAAA", { phase: Phase.Playing, players: 5 }), 0);
    reg.report(listing("BBBB", { players: 20 }), 0);
    expect(reg.quickJoin(0, Math.random)).toEqual({ code: "AAAA", created: false });
    reg.report(listing("CCCC", { players: 1 }), 0);
    expect(reg.quickJoin(0, Math.random).code).toBe("CCCC");
    const empty = new LobbyRegistry();
    const r = empty.quickJoin(0, Math.random);
    expect(r.created).toBe(true);
    expect(empty.claim(r.code)).toEqual({ ok: true, public: true });
  });

  it("persists through the store and reloads", () => {
    const kv = new Map<string, unknown>();
    const store = {
      putRoom: (c: string, l: RoomListing) => void kv.set(`r:${c}`, l),
      deleteRoom: (c: string) => void kv.delete(`r:${c}`),
      putReservation: (c: string, r: unknown) => void kv.set(`v:${c}`, r),
      deleteReservation: (c: string) => void kv.delete(`v:${c}`),
    };
    const reg = new LobbyRegistry(store);
    reg.report(listing("AAAA"), 0);
    const code = reg.create(true, 0, Math.random);
    const again = new LobbyRegistry(store);
    again.load(
      [...kv].filter(([k]) => k.startsWith("r:")).map(([, v]) => v as RoomListing),
      [...kv].filter(([k]) => k.startsWith("v:")).map(([k, v]) => [k.slice(2), v as { at: number; public: boolean }]),
      5,
    );
    expect(again.publicList().map((l) => l.code)).toEqual(["AAAA"]);
    expect(again.claim(code).ok).toBe(true);
  });
});
