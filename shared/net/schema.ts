// Field schemas for delta-compressed entity state.
//
// A schema is an ordered list of numeric fields. Each field has a wire kind
// (how it is quantized and written) plus get/set accessors on the state
// object. Both ends keep entity state as "wire values" (the quantized
// integers / rounded floats that go on the wire) in a Float64Array per
// entity, so a field is resent only when its *quantized* value changes and
// both ends agree bit-for-bit on the baseline.
//
// Delta encoding (see writeDelta / readDelta):
//   [mask word 0 varu] … [mask word k varu]  — 30 fields per word; the top
//                                             bit of the last word = "absolute"
//   then, for every set bit in field order, the field's wire value.
// "dq" fields (positions) are fixed point sent as a signed difference from
// the receiver's current value, or absolute when the flag is set (the first
// time an entity is sent to a client) — 2 mm precision for ~2 bytes.
//
// The WebSocket is reliable and ordered, so the baseline for a client is
// simply what the server last sent that client for that entity (no acks):
// every message arrives, in order, or the connection drops and the server
// starts over from an empty baseline.
import { fromHalf, toHalf, type Reader, type Writer } from "./codec";

export type FieldKind =
  | "q16" // [min, max] → u16
  | "u8q" // [min, max] → u8
  | "i8q" // [-max, max] → i8
  | "ang16" // radians, wrapped → u16
  | "f32"
  | "f16"
  | "varu" // non-negative integer
  | "vari" // signed integer
  | "dq"; // fixed point: (v - min) · max units, delta-coded

export interface Field<S> {
  readonly name: string;
  readonly kind: FieldKind;
  readonly min: number;
  readonly max: number;
  get(s: S): number;
  set(s: S, v: number): void;
}

export interface Schema<S> {
  readonly name: string;
  readonly fields: readonly Field<S>[];
  /** Mask words (30 fields each). */
  readonly words: number;
}

const WORD = 30;
const TAU = Math.PI * 2;

export function field<S>(
  name: string,
  kind: FieldKind,
  get: (s: S) => number,
  set: (s: S, v: number) => void,
  min = 0,
  max = 1,
): Field<S> {
  return { name, kind, min, max, get, set };
}

export function schema<S>(name: string, fields: Field<S>[]): Schema<S> {
  // one spare bit for the "absolute" flag
  return { name, fields, words: Math.max(1, Math.ceil((fields.length + 1) / WORD)) };
}

/** Mask bit index of the "absolute values" flag. */
export function absBit(sc: Schema<unknown>): number {
  return sc.words * WORD - 1;
}

/** Raw value → wire value. */
export function quantize(f: Field<unknown>, v: number): number {
  switch (f.kind) {
    case "q16":
    case "u8q": {
      const steps = f.kind === "q16" ? 65535 : 255;
      let q = Math.round(((v - f.min) / (f.max - f.min)) * steps);
      if (!(q >= 0)) q = 0;
      return q > steps ? steps : q;
    }
    case "i8q": {
      let q = Math.round((v / f.max) * 127);
      if (!(q >= -127)) q = -127;
      return q > 127 ? 127 : q;
    }
    case "ang16": {
      let a = v % TAU;
      if (a < 0) a += TAU;
      if (!(a >= 0)) a = 0;
      return Math.round((a / TAU) * 65536) % 65536;
    }
    case "f32":
      return Math.fround(v);
    case "f16":
      return toHalf(v);
    case "varu":
      return v > 0 ? Math.round(v) : 0;
    case "vari":
      return Math.round(v) | 0;
    case "dq": {
      const q = Math.round((v - f.min) * f.max);
      return q > 0 ? q : 0;
    }
  }
}

/** Wire value → raw value. */
export function dequantize(f: Field<unknown>, q: number): number {
  switch (f.kind) {
    case "q16":
      return f.min + (q / 65535) * (f.max - f.min);
    case "u8q":
      return f.min + (q / 255) * (f.max - f.min);
    case "i8q":
      return (q / 127) * f.max;
    case "ang16":
      return (q / 65536) * TAU;
    case "f16":
      return fromHalf(q);
    case "dq":
      return f.min + q / f.max;
    default:
      return q;
  }
}

export function writeWire(w: Writer, kind: FieldKind, q: number, base: number | null): void {
  switch (kind) {
    case "dq":
      if (base === null) w.varu(q);
      else w.vari(q - base);
      break;
    case "q16":
    case "ang16":
    case "f16":
      w.u16(q);
      break;
    case "u8q":
      w.u8(q);
      break;
    case "i8q":
      w.i8(q);
      break;
    case "f32":
      w.f32(q);
      break;
    case "varu":
      w.varu(q);
      break;
    case "vari":
      w.vari(q);
      break;
  }
}

/** Reads a field value; dq fields come back raw (absolute or difference, see `abs`). */
export function readWire(r: Reader, kind: FieldKind, abs: boolean): number {
  switch (kind) {
    case "dq":
      return abs ? r.varu() : r.vari();
    case "q16":
    case "ang16":
    case "f16":
      return r.u16();
    case "u8q":
      return r.u8();
    case "i8q":
      return r.i8();
    case "f32":
      return r.f32();
    case "varu":
      return r.varu();
    case "vari":
      return r.vari();
  }
}

/** Quantize a whole state into `out` (length = fields). */
export function quantizeInto<S>(sc: Schema<S>, s: S, out: Float64Array): Float64Array {
  const fs = sc.fields;
  for (let i = 0; i < fs.length; i++) out[i] = quantize(fs[i] as Field<unknown>, fs[i]!.get(s));
  return out;
}

/** Write wire values back into a state (dequantized). */
export function applyWire<S>(sc: Schema<S>, wire: Float64Array, s: S): S {
  const fs = sc.fields;
  for (let i = 0; i < fs.length; i++) fs[i]!.set(s, dequantize(fs[i] as Field<unknown>, wire[i]!));
  return s;
}

export function newWire<S>(sc: Schema<S>): Float64Array {
  return new Float64Array(sc.fields.length);
}

function same(a: number, b: number): boolean {
  // NaN-safe equality on wire values (f32 NaN never equals itself).
  return a === b || (a !== a && b !== b);
}

const _mask: number[] = [0, 0, 0, 0];

/**
 * Write the fields of `cur` that differ from `base` (all of them, flagged
 * absolute, when base is null), then copy them into base. Returns the number
 * of fields written.
 */
export function writeDelta<S>(w: Writer, sc: Schema<S>, cur: Float64Array, base: Float64Array | null): number {
  const fs = sc.fields;
  const n = fs.length;
  for (let k = 0; k < sc.words; k++) _mask[k] = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (base && same(cur[i]!, base[i]!)) continue;
    _mask[(i / WORD) | 0] += 2 ** (i % WORD);
    count++;
  }
  if (!base) _mask[sc.words - 1] += 2 ** (WORD - 1);
  for (let k = 0; k < sc.words; k++) w.varu(_mask[k]!);
  if (!count) return 0;
  for (let i = 0; i < n; i++) {
    if (base && same(cur[i]!, base[i]!)) continue;
    writeWire(w, fs[i]!.kind, cur[i]!, base ? base[i]! : null);
    if (base) base[i] = cur[i]!;
  }
  return count;
}

/** Read a delta into `wire` (in place). Returns the number of fields read. */
export function readDelta<S>(r: Reader, sc: Schema<S>, wire: Float64Array): number {
  const fs = sc.fields;
  let count = 0;
  for (let k = 0; k < sc.words; k++) _mask[k] = r.varu();
  const top = 2 ** (WORD - 1);
  const abs = _mask[sc.words - 1]! >= top;
  if (abs) _mask[sc.words - 1] -= top;
  for (let k = 0; k < sc.words; k++) {
    let m = _mask[k]!;
    if (!m) continue;
    const base = k * WORD;
    for (let b = 0; m && b < WORD; b++) {
      const bit = 2 ** b;
      if (m % (bit * 2) >= bit) {
        const i = base + b;
        if (i >= fs.length) throw new RangeError(`${sc.name}: mask bit ${i} out of range`);
        const f = fs[i]!;
        const v = readWire(r, f.kind, abs);
        wire[i] = f.kind === "dq" && !abs ? wire[i]! + v : v;
        m -= bit;
        count++;
      }
    }
  }
  return count;
}

// --- packing helpers for small arrays -------------------------------------------

/** Up to 3 small ids (0..254) as one integer: count + (id+1) per byte. */
export function packIds(ids: readonly number[]): number {
  const n = Math.min(3, ids.length);
  let v = n;
  let mul = 4;
  for (let i = 0; i < n; i++) {
    v += ((ids[i]! + 1) & 0xff) * mul;
    mul *= 256;
  }
  return v;
}

export function unpackIds(v: number, out: number[]): number[] {
  out.length = 0;
  const n = v % 4;
  let rest = Math.floor(v / 4);
  for (let i = 0; i < n; i++) {
    out.push((rest % 256) - 1);
    rest = Math.floor(rest / 256);
  }
  return out;
}

/** Up to 2 spawn indices (0..4094) as one integer. */
export function packPair(a: readonly number[]): number {
  const n = Math.min(2, a.length);
  let v = n;
  let mul = 4;
  for (let i = 0; i < n; i++) {
    v += ((a[i]! + 1) & 0xfff) * mul;
    mul *= 4096;
  }
  return v;
}

export function unpackPair(v: number, out: number[]): number[] {
  out.length = 0;
  const n = v % 4;
  let rest = Math.floor(v / 4);
  for (let i = 0; i < n; i++) {
    out.push((rest % 4096) - 1);
    rest = Math.floor(rest / 4096);
  }
  return out;
}
