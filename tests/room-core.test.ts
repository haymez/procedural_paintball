import { beforeEach, describe, expect, it } from "vitest";
import {
  BackToLobby,
  C2S,
  Chat,
  ChatMsg,
  Close,
  EndMatch,
  ErrCode,
  ErrorMsgDef,
  GRACE_MS,
  IDLE_CLOSE_MS,
  LOAD_TIMEOUT_MS,
  Leave,
  MatchBegin,
  Phase,
  Ping,
  PlayerStatus,
  Pong,
  Results,
  RoomStateMsg,
  S2C,
  SetColor,
  StartMatch,
  TICK_MS,
  UpdateSettings,
  Welcome,
  WorldReady,
  decode,
  encode,
  type MsgDef,
  type RoomListing,
  type RoomState,
} from "../shared/net/index";
import { RoomCore, type Conn } from "../worker/room/core";
import type { MatchContext, MatchSim } from "../worker/room/match";

class FakeConn implements Conn {
  inbox: { name: string; msg: unknown }[] = [];
  closedWith: number | null = null;
  send(data: Uint8Array): boolean {
    if (this.closedWith !== null) return false;
    const d = decode(S2C, data);
    this.inbox.push({ name: d.def.name, msg: d.msg });
    return true;
  }
  close(code: number): void {
    this.closedWith ??= code;
  }
  last<T>(def: MsgDef<T>): T | undefined {
    for (let i = this.inbox.length - 1; i >= 0; i--) if (this.inbox[i]!.name === def.name) return this.inbox[i]!.msg as T;
    return undefined;
  }
  all<T>(def: MsgDef<T>): T[] {
    return this.inbox.filter((m) => m.name === def.name).map((m) => m.msg as T);
  }
  get state(): RoomState {
    return this.last(RoomStateMsg)!;
  }
}

class SpySim implements MatchSim {
  events: string[] = [];
  ticks = 0;
  pending: Promise<void> | null = null;
  constructor(readonly ctx: MatchContext) {}
  onMatchStart(seed: number) {
    this.events.push(`start:${seed}`);
    return this.pending ?? undefined;
  }
  onPlayerEnter(p: { id: number }) {
    this.events.push(`enter:${p.id}`);
  }
  onPlayerLeave(p: { id: number }, why: string) {
    this.events.push(`leave:${p.id}:${why}`);
  }
  onPlayerConnection(p: { id: number }, c: boolean) {
    this.events.push(`conn:${p.id}:${c}`);
  }
  onBotsChanged(b: unknown[]) {
    this.events.push(`bots:${b.length}`);
  }
  onInput() {}
  tick() {
    this.ticks++;
  }
  results() {
    return [
      { id: 1, name: "a", color: 0, bot: false, score: 1, deaths: 0 },
      { id: 2, name: "b", color: 1, bot: false, score: 5, deaths: 2 },
    ];
  }
  dispose() {
    this.events.push("dispose");
  }
}

let now = 1_000_000;
let reports: (RoomListing | null)[] = [];
let ticking = false;
let service = false;
let sims: SpySim[] = [];
let core: RoomCore;

function send<T>(conn: FakeConn, def: MsgDef<T>, msg: T) {
  core.message(conn, encode(def, msg));
}
let tokenN = 0;
function join(name = "P", extra: Partial<{ token: string; color: number; world: number }> = {}) {
  const conn = new FakeConn();
  const token = extra.token ?? `token-${++tokenN}-xxxx`;
  const ok = core.join(conn, { token, name, color: extra.color ?? -1, world: extra.world ?? -1 });
  return { conn, token, ok, id: conn.last(Welcome)?.you ?? 0 };
}
function advance(ms: number) {
  const end = now + ms;
  while (now < end) {
    now = Math.min(end, now + 250);
    core.service();
  }
}

beforeEach(() => {
  now = 1_000_000;
  reports = [];
  ticking = false;
  service = false;
  sims = [];
  core = new RoomCore("ABCD", {
    now: () => now,
    random: () => 0.5,
    setTicking: (on) => (ticking = on),
    setService: (on) => (service = on),
    report: (l) => reports.push(l),
    createSim: (ctx) => {
      const s = new SpySim(ctx);
      sims.push(s);
      return s;
    },
    log: () => {},
  });
});

describe("RoomCore joining", () => {
  it("first joiner hosts, gets welcome + state, room reports", () => {
    core.prepare({ public: true, region: "FRA" });
    const a = join("Pesce");
    expect(a.ok).toBe(true);
    expect(a.conn.last(Welcome)!.rejoined).toBe(false);
    const st = a.conn.state;
    expect(st.hostId).toBe(a.id);
    expect(st.settings.public).toBe(true);
    expect(st.players[0]!.name).toBe("Pesce");
    expect(service).toBe(true);
    expect(reports.at(-1)!.region).toBe("FRA");
    expect(reports.at(-1)!.players).toBe(1);
  });

  it("refuses bad tokens and full rooms", () => {
    const bad = new FakeConn();
    expect(core.join(bad, { token: "x", name: "", color: -1, world: -1 })).toBe(false);
    expect(bad.closedWith).toBe(Close.BadHandshake);
    for (let i = 0; i < 20; i++) expect(join(`p${i}`).ok).toBe(true);
    const late = join("late");
    expect(late.ok).toBe(false);
    expect(late.conn.closedWith).toBe(Close.Full);
    expect(late.conn.last(ErrorMsgDef)!.code).toBe(ErrCode.Full);
  });

  it("assigns unique colors and honors free preferences", () => {
    const a = join("a", { color: 5 });
    const b = join("b", { color: 5 });
    const st = b.conn.state;
    expect(st.players.find((p) => p.id === a.id)!.color).toBe(5);
    expect(st.players.find((p) => p.id === b.id)!.color).not.toBe(5);
    send(b.conn, SetColor, { color: 5 });
    expect(b.conn.last(ErrorMsgDef)!.code).toBe(ErrCode.ColorTaken);
    send(b.conn, SetColor, { color: 9 });
    expect(b.conn.state.players.find((p) => p.id === b.id)!.color).toBe(9);
  });

  it("answers pings with server time", () => {
    const a = join();
    send(a.conn, Ping, { t: 123.5, rtt: 40 });
    expect(a.conn.last(Pong)).toEqual({ t: 123.5, server: now });
  });

  it("ignores malformed frames and unknown ids without throwing", () => {
    const a = join();
    core.message(a.conn, new Uint8Array([3])); // SetColor with no payload
    core.message(a.conn, new Uint8Array([200, 1, 2]));
    core.message(a.conn, "text frame");
    expect(a.conn.closedWith).toBe(null);
  });
});

describe("RoomCore host & settings", () => {
  it("only the host can change settings, values are clamped", () => {
    const a = join("host");
    const b = join("guest");
    send(b.conn, UpdateSettings, { bots: 3 });
    expect(b.conn.state.settings.bots).toBe(0);
    send(a.conn, UpdateSettings, { bots: 50, matchMinutes: 0, seed: 99, name: "  Cala  " });
    const s = b.conn.state.settings;
    expect(s.bots).toBe(18); // 20 - 2 humans
    expect(s.matchMinutes).toBe(1);
    expect(s.seed).toBe(99);
    expect(s.name).toBe("Cala");
    expect(b.conn.state.players.filter((p) => p.bot).length).toBe(18);
  });

  it("bots yield seats to new humans", () => {
    const a = join("host");
    send(a.conn, UpdateSettings, { bots: 19 });
    const b = join("b");
    expect(b.conn.state.settings.bots).toBe(18);
    expect(b.conn.state.players.length).toBe(20);
  });

  it("promotes a new host when the host leaves", () => {
    const a = join("a");
    const b = join("b");
    send(a.conn, Leave, {});
    expect(a.conn.closedWith).toBe(Close.Left);
    expect(b.conn.state.hostId).toBe(b.id);
    expect(b.conn.state.players.length).toBe(1);
  });

  it("rate limits chat", () => {
    const a = join();
    for (let i = 0; i < 10; i++) send(a.conn, Chat, { text: `m${i}` });
    const lines = a.conn.all(ChatMsg).filter((c) => c.from !== 0);
    expect(lines.length).toBe(4);
    expect(a.conn.last(ErrorMsgDef)!.code).toBe(ErrCode.RateLimited);
    now += 5000;
    send(a.conn, Chat, { text: "later" });
    expect(a.conn.last(ChatMsg)!.text).toBe("later");
  });
});

describe("RoomCore reconnect grace", () => {
  it("keeps the slot through a drop and reclaims it with the same token", () => {
    const a = join("a");
    const b = join("b");
    core.closed(a.conn);
    expect(b.conn.state.players.find((p) => p.id === a.id)!.connected).toBe(false);
    advance(GRACE_MS - 1000);
    const again = join("a", { token: a.token });
    expect(again.conn.last(Welcome)).toMatchObject({ you: a.id, rejoined: true });
    expect(again.conn.state.hostId).toBe(a.id);
    expect(again.conn.state.players.find((p) => p.id === a.id)!.connected).toBe(true);
  });

  it("frees the slot after the grace window", () => {
    const a = join("a");
    const b = join("b");
    core.closed(a.conn);
    advance(GRACE_MS + 500);
    expect(b.conn.state.players.length).toBe(1);
    expect(b.conn.state.hostId).toBe(b.id);
  });

  it("a newer socket with the same token replaces the old one", () => {
    const a = join("a");
    const a2 = join("a", { token: a.token });
    expect(a.conn.closedWith).toBe(Close.Replaced);
    core.closed(a.conn); // late close event from the old socket must not mark a2 gone
    expect(a2.conn.state.players[0]!.connected).toBe(true);
  });

  it("shuts down with no timers when the last player is gone", () => {
    const a = join("a");
    core.closed(a.conn);
    advance(GRACE_MS + 500);
    expect(core.isEmpty).toBe(true);
    expect(service).toBe(false);
    expect(ticking).toBe(false);
    expect(reports.at(-1)).toBe(null);
  });

  it("closes idle lobbies", () => {
    const a = join("a");
    advance(IDLE_CLOSE_MS + 500);
    expect(a.conn.closedWith).toBe(Close.Idle);
    expect(core.isEmpty).toBe(true);
    expect(service).toBe(false);
  });
});

describe("RoomCore match flow", () => {
  function startWith2() {
    const a = join("a");
    const b = join("b");
    send(a.conn, UpdateSettings, { seed: 777, bots: 2, matchMinutes: 1 });
    send(a.conn, StartMatch, {});
    return { a, b };
  }

  it("non-hosts can't start", () => {
    join("a");
    const b = join("b");
    send(b.conn, StartMatch, {});
    expect(b.conn.state.phase).toBe(Phase.Lobby);
  });

  it("lobby -> loading -> playing when everyone is ready", () => {
    const { a, b } = startWith2();
    expect(a.conn.state.phase).toBe(Phase.Loading);
    expect(a.conn.state.players[0]!.status).toBe(PlayerStatus.Loading);
    expect(sims[0]!.events).toContain("start:777");
    send(a.conn, WorldReady, { seed: 777, checksum: 5 });
    expect(a.conn.state.phase).toBe(Phase.Loading);
    expect(ticking).toBe(false);
    send(b.conn, WorldReady, { seed: 777, checksum: 5 });
    expect(a.conn.state.phase).toBe(Phase.Playing);
    expect(ticking).toBe(true);
    expect(a.conn.last(MatchBegin)!.seed).toBe(777);
    expect(sims[0]!.events).toEqual(expect.arrayContaining([`enter:${a.id}`, `enter:${b.id}`]));
  });

  it("ignores ready for the wrong seed and warns on checksum mismatch", () => {
    const { a, b } = startWith2();
    send(a.conn, WorldReady, { seed: 1, checksum: 5 });
    expect(a.conn.state.players[0]!.status).toBe(PlayerStatus.Loading);
    send(a.conn, WorldReady, { seed: 777, checksum: 5 });
    send(b.conn, WorldReady, { seed: 777, checksum: 6 });
    expect(b.conn.last(ErrorMsgDef)!.code).toBe(ErrCode.WorldMismatch);
  });

  it("waits for an async server world", async () => {
    const a = join("a");
    let resolve!: () => void;
    const p = new Promise<void>((r) => (resolve = r));
    // the next sim created returns a pending promise
    const orig = core["env"].createSim;
    core["env"].createSim = (ctx: MatchContext) => {
      const s = orig(ctx) as SpySim;
      s.pending = p;
      return s;
    };
    send(a.conn, StartMatch, {});
    send(a.conn, WorldReady, { seed: a.conn.state.settings.seed, checksum: 1 });
    expect(a.conn.state.phase).toBe(Phase.Loading);
    resolve();
    await p;
    await Promise.resolve();
    expect(a.conn.state.phase).toBe(Phase.Playing);
  });

  it("a dropped loader doesn't block the start; stragglers join after the timeout", () => {
    const { a, b } = startWith2();
    send(a.conn, WorldReady, { seed: 777, checksum: 5 });
    advance(LOAD_TIMEOUT_MS + 500);
    expect(a.conn.state.phase).toBe(Phase.Playing);
    expect(b.conn.state.players.find((p) => p.id === b.id)!.status).toBe(PlayerStatus.Loading);
    send(b.conn, WorldReady, { seed: 777, checksum: 5 });
    expect(b.conn.last(MatchBegin)).toBeDefined();
    expect(sims[0]!.events).toContain(`enter:${b.id}`);
  });

  it("late joiners load individually during play", () => {
    const { a, b } = startWith2();
    send(a.conn, WorldReady, { seed: 777, checksum: 5 });
    send(b.conn, WorldReady, { seed: 777, checksum: 5 });
    const c = join("c");
    const me = c.conn.state.players.find((p) => p.id === c.id)!;
    expect(c.conn.state.phase).toBe(Phase.Playing);
    expect(me.status).toBe(PlayerStatus.Loading);
    send(c.conn, WorldReady, { seed: 777, checksum: 5 });
    expect(c.conn.last(MatchBegin)).toBeDefined();
    expect(sims[0]!.events).toContain(`enter:${c.id}`);
  });

  it("a reloaded tab without the world reloads it; one with it resumes", () => {
    const { a, b } = startWith2();
    send(a.conn, WorldReady, { seed: 777, checksum: 5 });
    send(b.conn, WorldReady, { seed: 777, checksum: 5 });
    core.closed(b.conn);
    expect(sims[0]!.events).toContain(`conn:${b.id}:false`);
    const b2 = join("b", { token: b.token, world: 777 });
    expect(b2.conn.last(MatchBegin)).toBeDefined();
    expect(sims[0]!.events).toContain(`conn:${b.id}:true`);
    core.closed(b2.conn);
    const b3 = join("b", { token: b.token, world: -1 });
    expect(sims[0]!.events).toContain(`leave:${b.id}:reload`);
    expect(b3.conn.state.players.find((p) => p.id === b.id)!.status).toBe(PlayerStatus.Loading);
  });

  it("ticks at a fixed rate and ends on the timer with sorted results", () => {
    const { a, b } = startWith2();
    send(a.conn, WorldReady, { seed: 777, checksum: 5 });
    send(b.conn, WorldReady, { seed: 777, checksum: 5 });
    for (let i = 0; i < 30; i++) {
      now += TICK_MS;
      core.tick();
    }
    expect(sims[0]!.ticks).toBeGreaterThanOrEqual(29);
    expect(sims[0]!.ticks).toBeLessThanOrEqual(31);
    now += 60_000;
    core.tick();
    expect(a.conn.state.phase).toBe(Phase.Results);
    expect(ticking).toBe(false);
    expect(sims[0]!.events).toContain("dispose");
    expect(a.conn.last(Results)!.rows[0]!.score).toBe(5);
    advance(30_000);
    expect(a.conn.state.phase).toBe(Phase.Lobby);
  });

  it("keeps a typed seed across matches but rerolls a dice-rolled one", () => {
    const { a, b } = startWith2();
    for (const c of [a, b]) send(c.conn, WorldReady, { seed: 777, checksum: 5 });
    send(a.conn, EndMatch, {});
    send(a.conn, BackToLobby, {});
    expect(a.conn.state.settings.seed).toBe(777);

    send(a.conn, UpdateSettings, { seed: 4242, seedRandom: true });
    send(a.conn, StartMatch, {});
    for (const c of [a, b]) send(c.conn, WorldReady, { seed: 4242, checksum: 5 });
    send(a.conn, EndMatch, {});
    expect(a.conn.state.phase).toBe(Phase.Results);
    send(a.conn, BackToLobby, {});
    expect(a.conn.state.phase).toBe(Phase.Lobby);
    expect(a.conn.state.settings.seed).not.toBe(4242);
  });

  it("host can end early or abort to lobby", () => {
    const { a, b } = startWith2();
    send(a.conn, WorldReady, { seed: 777, checksum: 5 });
    send(b.conn, WorldReady, { seed: 777, checksum: 5 });
    send(b.conn, EndMatch, {});
    expect(a.conn.state.phase).toBe(Phase.Playing);
    send(a.conn, EndMatch, {});
    expect(a.conn.state.phase).toBe(Phase.Results);
    send(a.conn, BackToLobby, {});
    expect(a.conn.state.phase).toBe(Phase.Lobby);
    expect(ticking).toBe(false);
  });

  it("forwards match-range messages to the sim only while playing", () => {
    const Input = C2S.get(239) ?? C2S.define<{ x: number }>(239, "testInput", (w, m) => void w.u8(m.x), (r) => ({ x: r.u8() }));
    let got = 0;
    const { a, b } = startWith2();
    sims[0]!.onInput = () => void got++;
    core.message(a.conn, encode(Input as MsgDef<{ x: number }>, { x: 1 }));
    expect(got).toBe(0);
    send(a.conn, WorldReady, { seed: 777, checksum: 5 });
    send(b.conn, WorldReady, { seed: 777, checksum: 5 });
    core.message(a.conn, encode(Input as MsgDef<{ x: number }>, { x: 1 }));
    expect(got).toBe(1);
  });

  it("a throwing sim never propagates", () => {
    const { a, b } = startWith2();
    sims[0]!.tick = () => {
      throw new Error("boom");
    };
    send(a.conn, WorldReady, { seed: 777, checksum: 5 });
    send(b.conn, WorldReady, { seed: 777, checksum: 5 });
    for (let i = 0; i < 40; i++) {
      now += TICK_MS;
      expect(() => core.tick()).not.toThrow();
    }
    expect(a.conn.state.phase).toBe(Phase.Lobby);
    expect(ticking).toBe(false);
  });
});
