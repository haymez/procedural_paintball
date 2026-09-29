// Message registry and framing.
//
// Framing: one WebSocket binary frame = one message = [u8 type id][payload].
// Each direction has its own id space (client->server C2S, server->client
// S2C), so id 5 can mean different things per direction.
//
// Id ranges (per direction):
//     0        reserved
//     1..63    core + lobby phase        (shared/net/lobby.ts)
//    64..239   match phase               (shared/net/match.ts — sim phase fills it)
//   240..255   debug / tooling
//
// Adding a message:
//   export const Foo = S2C.define<FooMsg>(70, "foo",
//     (w, m) => { w.u16(m.a); w.f16(m.b); },
//     (r) => ({ a: r.u16(), b: r.f16() }));
// then `net.on(Foo, (m) => …)` on the receiving side and `send(Foo, {...})`
// on the sending side. The module that defines it must be imported somewhere
// on both sides before traffic flows (shared/net/index.ts imports all).

import { ProtoError, Reader, Writer } from "./codec";

export type Dir = "c2s" | "s2c";

export interface MsgDef<T> {
  readonly id: number;
  readonly name: string;
  readonly dir: Dir;
  write(w: Writer, msg: T): void;
  read(r: Reader): T;
}

/** Payload type of a message definition. */
export type MsgOf<D> = D extends MsgDef<infer T> ? T : never;

export const ID_LOBBY_MIN = 1;
export const ID_LOBBY_MAX = 63;
export const ID_MATCH_MIN = 64;
export const ID_MATCH_MAX = 239;
export const ID_DEBUG_MIN = 240;

export class Registry {
  private readonly defs: (MsgDef<unknown> | undefined)[] = new Array(256);

  constructor(readonly dir: Dir) {}

  define<T>(id: number, name: string, write: (w: Writer, m: T) => void, read: (r: Reader) => T): MsgDef<T> {
    if (!Number.isInteger(id) || id < 1 || id > 255) throw new Error(`bad message id ${id}`);
    const prev = this.defs[id];
    // Same name again = the defining module was re-evaluated (dev hot reload): replace it.
    if (prev && prev.name !== name) throw new Error(`${this.dir} id ${id} already used by "${prev.name}" (defining "${name}")`);
    const def: MsgDef<T> = { id, name, dir: this.dir, write, read };
    this.defs[id] = def as MsgDef<unknown>;
    return def;
  }

  /** Payload-less message helper. */
  signal(id: number, name: string): MsgDef<Record<string, never>> {
    return this.define<Record<string, never>>(id, name, () => {}, () => ({}));
  }

  get(id: number): MsgDef<unknown> | undefined {
    return this.defs[id];
  }

  list(): MsgDef<unknown>[] {
    return this.defs.filter((d): d is MsgDef<unknown> => !!d);
  }
}

export const C2S = new Registry("c2s");
export const S2C = new Registry("s2c");

const shared = new Writer(1024);

/** Encodes one framed message. Returns a fresh copy (safe to queue / broadcast). */
export function encode<T>(def: MsgDef<T>, msg: T, w: Writer = shared): Uint8Array<ArrayBuffer> {
  w.reset().u8(def.id);
  def.write(w, msg);
  return w.finish();
}

export interface Decoded {
  def: MsgDef<unknown>;
  msg: unknown;
}

/** Decodes one framed message. Throws ProtoError on unknown ids or malformed payloads. */
export function decode(reg: Registry, data: ArrayBuffer | Uint8Array): Decoded {
  const r = new Reader(data);
  const id = r.u8();
  const def = reg.get(id);
  if (!def) throw new ProtoError(`unknown ${reg.dir} message id ${id}`);
  const msg = def.read(r);
  return { def, msg };
}

/** Peeks at the type id without decoding. Returns -1 for empty frames. */
export function peekId(data: ArrayBuffer | Uint8Array): number {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  return u8.length ? u8[0]! : -1;
}

/** Typed handler table. `Ctx` is whatever extra argument the receiver passes
 *  (the server passes the sending player; the client passes nothing). */
export class Dispatcher<Ctx = void> {
  private readonly handlers: (((msg: unknown, ctx: Ctx) => void)[] | undefined)[] = new Array(256);

  on<T>(def: MsgDef<T>, fn: (msg: T, ctx: Ctx) => void): () => void {
    const list = (this.handlers[def.id] ??= []);
    const h = fn as (msg: unknown, ctx: Ctx) => void;
    list.push(h);
    return () => {
      const i = list.indexOf(h);
      if (i >= 0) list.splice(i, 1);
    };
  }

  has(id: number): boolean {
    return !!this.handlers[id]?.length;
  }

  /** Returns false if nothing handled it. */
  dispatch(d: Decoded, ctx: Ctx): boolean {
    const list = this.handlers[d.def.id];
    if (!list?.length) return false;
    for (const h of list.slice()) h(d.msg, ctx);
    return true;
  }
}
