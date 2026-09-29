// In-memory network for netcode tests: a MatchHost and NetClients exchange
// real encoded frames through queues with configurable one-way delay and
// jitter, on a virtual clock (no timers).
import { C2S, Difficulty, MatchInit, NetStats, Roster, S2C, Snapshot, TICK_MS, decode, defaultSettings, encode, type MsgDef } from "../shared/net/index";
import { type InputCmd } from "../shared/sim/index";
import type { World } from "../shared/world/types";
import { createEnv } from "../shared/sim/index";
import { MatchHost } from "../worker/room/host";
import type { MatchContext, SimPlayer } from "../worker/room/match";
import { NetClient } from "../client/src/game/net/client";

export interface Pipe {
  owd: number;
  jitter: number;
  rand: () => number;
}

interface Frame {
  at: number;
  bytes: Uint8Array;
}

export class TestClient {
  readonly nc: NetClient;
  inbox: Frame[] = [];
  outbox: Frame[] = [];
  lastIn = 0;
  lastOut = 0;
  bytesIn = 0;
  seq = 0;
  nextTick = 0;
  cmd: InputCmd = { seq: 0, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0 };
  constructor(readonly h: Harness, readonly player: SimPlayer, readonly pipe: Pipe, world: World) {
    this.nc = new NetClient(world, createEnv(world), player.id, {
      send: <T>(def: MsgDef<T>, msg: T) => {
        const at = Math.max(this.lastOut, h.now + pipe.owd + pipe.jitter * pipe.rand());
        this.lastOut = at;
        this.outbox.push({ at, bytes: encode(def, msg) });
        return true;
      },
      now: () => h.now,
      serverNow: () => h.now,
      endsAt: () => null,
    });
  }
  deliver(bytes: Uint8Array): void {
    const at = Math.max(this.lastIn, this.h.now + this.pipe.owd + this.pipe.jitter * this.pipe.rand());
    this.lastIn = at;
    this.inbox.push({ at, bytes: bytes.slice() });
  }
  /** One 60 Hz client tick with the current cmd. */
  step(): void {
    this.cmd.seq = ++this.seq;
    this.nc.input(this.cmd);
    this.nc.tick();
  }
  pump(): void {
    while (this.inbox.length && this.inbox[0]!.at <= this.h.now) {
      const f = this.inbox.shift()!;
      this.bytesIn += f.bytes.length;
      const d = decode(S2C, f.bytes);
      if (d.def === MatchInit) this.nc.onInit(d.msg as never);
      else if (d.def === Roster) this.nc.onRoster(d.msg as never);
      else if (d.def === Snapshot) this.nc.onSnapshot(d.msg as never, this.h.now);
      else if (d.def === NetStats) this.nc.onStats(d.msg as never);
    }
    while (this.outbox.length && this.outbox[0]!.at <= this.h.now) {
      const f = this.outbox.shift()!;
      const d = decode(C2S, f.bytes);
      this.h.host.onInput(this.player, d.def, d.msg);
    }
  }
}

export class Harness {
  now = 0;
  readonly host: MatchHost;
  readonly clients = new Map<number, TestClient>();
  logs: string[] = [];
  ended = false;
  /** Called after every room tick (2 sim steps). */
  afterTick: (() => void) | null = null;
  private roomTick = 0;
  private nextRoomTick = 0;

  constructor(readonly world: World, opts: { bots?: number; minutes?: number; debug?: boolean } = {}) {
    const ctx: MatchContext = {
      now: () => this.now,
      broadcast: (def, msg) => {
        const b = encode(def, msg);
        for (const c of this.clients.values()) c.deliver(b);
      },
      send: (id, def, msg) => {
        const c = this.clients.get(id);
        if (!c) return false;
        c.deliver(encode(def, msg));
        return true;
      },
      endMatch: () => void (this.ended = true),
      log: (...a) => void this.logs.push(a.join(" ")),
    };
    this.host = new MatchHost(ctx, { world, debug: opts.debug ?? true, clock: () => performance.now() });
    this.opts = opts;
  }
  private opts: { bots?: number; minutes?: number };

  async start(): Promise<void> {
    const settings = { ...defaultSettings(), bots: this.opts.bots ?? 0, matchMinutes: this.opts.minutes ?? 10, difficulty: Difficulty.Normal };
    const bots = Array.from({ length: settings.bots }, (_, i) => ({ id: 128 + i, name: `Bot ${i}`, color: 19 - i }));
    await this.host.onMatchStart(this.world.seed, { seed: this.world.seed, settings, humans: [], bots });
  }

  join(id: number, pipe: Partial<Pipe> = {}): TestClient {
    const p = { id, name: `P${id}`, color: id % 20 };
    let s = id * 9301 + 49297;
    const rand = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
    const c = new TestClient(this, p, { owd: 0, jitter: 0, rand, ...pipe }, this.world);
    this.clients.set(id, c);
    this.host.onPlayerEnter(p);
    return c;
  }

  /** Advance virtual time by ms in 1 ms steps: client ticks at 60 Hz, room at 30 Hz. */
  run(ms: number, each?: (c: TestClient) => void): void {
    const end = this.now + ms;
    while (this.now < end) {
      this.now += 1;
      for (const c of this.clients.values()) c.pump();
      if (this.now >= this.nextRoomTick) {
        this.nextRoomTick += TICK_MS;
        this.host.tick(this.roomTick++, TICK_MS / 1000);
        this.afterTick?.();
        for (const c of this.clients.values()) c.pump();
      }
      for (const c of this.clients.values()) {
        if (!c.nextTick) c.nextTick = this.now;
        if (this.now >= c.nextTick) {
          c.nextTick += c.nc.tickDt * 1000;
          each?.(c);
          c.step();
        }
      }
    }
  }
}
