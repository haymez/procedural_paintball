// Binary writer/reader over DataView. Little-endian throughout.
//
// Pure TS, no environment globals beyond TextEncoder/TextDecoder (present in
// browsers, workerd and Node). A Reader never reads past its end: every read
// is bounds-checked and throws ProtoError, which the receiver catches and
// treats as a malformed frame.

export class ProtoError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ProtoError";
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();

// Scratch views for float16 conversion.
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** float32 -> IEEE 754 half bits (round-to-nearest-even, saturates to ±inf). */
export function toHalf(v: number): number {
  f32[0] = v;
  const x = u32[0]!;
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0); // inf / nan
  let e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00; // overflow -> inf
  if (e <= 0) {
    if (e < -10) return sign; // underflow -> ±0
    mant = (mant | 0x800000) >>> (1 - e);
    // round to nearest even
    if (mant & 0x1000 && mant & 0x2fff) mant += 0x2000;
    return sign | (mant >>> 13);
  }
  if (mant & 0x1000 && mant & 0x2fff) {
    mant += 0x2000;
    if (mant & 0x800000) {
      mant = 0;
      e++;
      if (e >= 0x1f) return sign | 0x7c00;
    }
  }
  return sign | (e << 10) | (mant >>> 13);
}

/** IEEE 754 half bits -> number. */
export function fromHalf(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >>> 10) & 0x1f;
  const mant = h & 0x3ff;
  if (exp === 0) return sign * mant * 2 ** -24;
  if (exp === 0x1f) return mant ? NaN : sign * Infinity;
  return sign * (1 + mant / 1024) * 2 ** (exp - 15);
}

export class Writer {
  private buf: ArrayBuffer;
  private dv: DataView;
  private bytes: Uint8Array<ArrayBuffer>;
  pos = 0;

  constructor(capacity = 256) {
    this.buf = new ArrayBuffer(capacity);
    this.dv = new DataView(this.buf);
    this.bytes = new Uint8Array(this.buf);
  }

  reset(): this {
    this.pos = 0;
    return this;
  }

  private need(n: number): void {
    const want = this.pos + n;
    if (want <= this.buf.byteLength) return;
    let cap = this.buf.byteLength * 2;
    while (cap < want) cap *= 2;
    const next = new ArrayBuffer(cap);
    new Uint8Array(next).set(this.bytes.subarray(0, this.pos));
    this.buf = next;
    this.dv = new DataView(next);
    this.bytes = new Uint8Array(next);
  }

  u8(v: number): this {
    this.need(1);
    this.dv.setUint8(this.pos, v);
    this.pos += 1;
    return this;
  }
  i8(v: number): this {
    this.need(1);
    this.dv.setInt8(this.pos, v);
    this.pos += 1;
    return this;
  }
  u16(v: number): this {
    this.need(2);
    this.dv.setUint16(this.pos, v, true);
    this.pos += 2;
    return this;
  }
  i16(v: number): this {
    this.need(2);
    this.dv.setInt16(this.pos, v, true);
    this.pos += 2;
    return this;
  }
  u32(v: number): this {
    this.need(4);
    this.dv.setUint32(this.pos, v >>> 0, true);
    this.pos += 4;
    return this;
  }
  i32(v: number): this {
    this.need(4);
    this.dv.setInt32(this.pos, v | 0, true);
    this.pos += 4;
    return this;
  }
  f32(v: number): this {
    this.need(4);
    this.dv.setFloat32(this.pos, v, true);
    this.pos += 4;
    return this;
  }
  f64(v: number): this {
    this.need(8);
    this.dv.setFloat64(this.pos, v, true);
    this.pos += 8;
    return this;
  }
  /** IEEE half float: ~3 significant digits, range ±65504. */
  f16(v: number): this {
    return this.u16(toHalf(v));
  }
  bool(v: boolean): this {
    return this.u8(v ? 1 : 0);
  }
  /** Unsigned LEB128 varint, any safe non-negative integer. */
  varu(v: number): this {
    v = Math.max(0, Math.floor(v));
    while (v >= 0x80) {
      this.u8((v % 0x80) | 0x80);
      v = Math.floor(v / 0x80);
    }
    return this.u8(v);
  }
  /** Signed varint (zigzag), 32-bit range. */
  vari(v: number): this {
    v |= 0;
    return this.varu(((v << 1) ^ (v >> 31)) >>> 0);
  }
  /** Quantize v in [min, max] to `bits` (1..16) bits, clamped. */
  quant(v: number, min: number, max: number, bits: 8 | 16): this {
    const steps = bits === 8 ? 255 : 65535;
    let q = Math.round(((v - min) / (max - min)) * steps);
    if (!(q >= 0)) q = 0; // also catches NaN
    if (q > steps) q = steps;
    return bits === 8 ? this.u8(q) : this.u16(q);
  }
  /** Angle in radians, wrapped, as u8 (1.4°) or u16 (0.0055°). */
  angle(rad: number, bits: 8 | 16): this {
    const turn = 2 * Math.PI;
    let a = rad % turn;
    if (a < 0) a += turn;
    const steps = bits === 8 ? 256 : 65536;
    const q = Math.round((a / turn) * steps) % steps;
    return bits === 8 ? this.u8(q) : this.u16(q);
  }
  /** UTF-8 string with a varint byte-length prefix. */
  str(s: string): this {
    const b = enc.encode(s);
    this.varu(b.length);
    return this.raw(b);
  }
  /** Bytes with a varint length prefix. */
  blob(b: Uint8Array): this {
    this.varu(b.length);
    return this.raw(b);
  }
  /** Bytes with no prefix. */
  raw(b: Uint8Array): this {
    this.need(b.length);
    this.bytes.set(b, this.pos);
    this.pos += b.length;
    return this;
  }

  /** A copy of the written bytes (safe to keep; the writer can be reused). */
  finish(): Uint8Array<ArrayBuffer> {
    return this.bytes.slice(0, this.pos);
  }
  /** A view of the written bytes, valid until the next write/reset. */
  view(): Uint8Array {
    return this.bytes.subarray(0, this.pos);
  }
}

export class Reader {
  private dv: DataView;
  private bytes: Uint8Array;
  pos = 0;
  readonly end: number;

  constructor(data: ArrayBuffer | Uint8Array) {
    const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.bytes = u8;
    this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    this.end = u8.byteLength;
  }

  get remaining(): number {
    return this.end - this.pos;
  }

  private take(n: number): number {
    const p = this.pos;
    if (p + n > this.end) throw new ProtoError(`read past end (${p}+${n}>${this.end})`);
    this.pos = p + n;
    return p;
  }

  u8(): number {
    return this.dv.getUint8(this.take(1));
  }
  i8(): number {
    return this.dv.getInt8(this.take(1));
  }
  u16(): number {
    return this.dv.getUint16(this.take(2), true);
  }
  i16(): number {
    return this.dv.getInt16(this.take(2), true);
  }
  u32(): number {
    return this.dv.getUint32(this.take(4), true);
  }
  i32(): number {
    return this.dv.getInt32(this.take(4), true);
  }
  f32(): number {
    return this.dv.getFloat32(this.take(4), true);
  }
  f64(): number {
    return this.dv.getFloat64(this.take(8), true);
  }
  f16(): number {
    return fromHalf(this.u16());
  }
  bool(): boolean {
    return this.u8() !== 0;
  }
  varu(): number {
    let result = 0;
    let mul = 1;
    for (let i = 0; i < 8; i++) {
      const b = this.u8();
      result += (b & 0x7f) * mul;
      if (!(b & 0x80)) return result;
      mul *= 0x80;
    }
    throw new ProtoError("varint too long");
  }
  vari(): number {
    const z = this.varu();
    return (z >>> 1) ^ -(z & 1);
  }
  quant(min: number, max: number, bits: 8 | 16): number {
    const steps = bits === 8 ? 255 : 65535;
    const q = bits === 8 ? this.u8() : this.u16();
    return min + (q / steps) * (max - min);
  }
  angle(bits: 8 | 16): number {
    const steps = bits === 8 ? 256 : 65536;
    const q = bits === 8 ? this.u8() : this.u16();
    return (q / steps) * 2 * Math.PI;
  }
  /** Reads a string; `maxBytes` guards against hostile lengths. */
  str(maxBytes = 4096): string {
    const n = this.varu();
    if (n > maxBytes) throw new ProtoError(`string too long (${n})`);
    const p = this.take(n);
    return dec.decode(this.bytes.subarray(p, p + n));
  }
  blob(maxBytes = 1 << 20): Uint8Array {
    const n = this.varu();
    if (n > maxBytes) throw new ProtoError(`blob too long (${n})`);
    const p = this.take(n);
    return this.bytes.slice(p, p + n);
  }
  raw(n: number): Uint8Array {
    const p = this.take(n);
    return this.bytes.subarray(p, p + n);
  }
  /** Guard for list lengths read off the wire. */
  count(max: number): number {
    const n = this.varu();
    if (n > max) throw new ProtoError(`list too long (${n} > ${max})`);
    return n;
  }
}
