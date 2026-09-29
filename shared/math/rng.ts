// Seeded, forkable PRNG. Integer-only core (sfc32), so it is bit-identical in
// every JS engine. Streams are forked by name from a key that depends only on
// the parent's key, never on how many numbers the parent has drawn, so adding
// draws to one stage can never perturb another stage.

/** FNV-1a 32-bit hash of a string. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** murmur3 finalizer: good avalanche for 32-bit ints. */
export function mix32(x: number): number {
  x |= 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}

/** Hash of two ints + seed → uint32. */
export function hash2i(x: number, y: number, seed: number): number {
  return mix32(Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ mix32(seed));
}

/** Hash of two ints + seed → [0, 1). */
export function hash2f(x: number, y: number, seed: number): number {
  return hash2i(x, y, seed) / 4294967296;
}

export class Rng {
  readonly key: number;
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number) {
    this.key = mix32(seed ^ 0x9e3779b9);
    this.a = mix32(this.key + 0x243f6a88);
    this.b = mix32(this.key + 0x85a308d3);
    this.c = mix32(this.key + 0x13198a2e);
    this.d = mix32(this.key + 0x03707344) | 1;
    for (let i = 0; i < 12; i++) this.u32();
  }

  /** Independent child stream; depends only on this.key and name. */
  fork(name: string): Rng {
    return new Rng(mix32(this.key ^ hashString(name)) ^ hashString(name + "#"));
  }

  u32(): number {
    const a = this.a, b = this.b, c = this.c, d = this.d;
    const t = (((a + b) | 0) + d) | 0;
    this.d = (d + 1) | 0;
    this.a = b ^ (b >>> 9);
    this.b = (c + (c << 3)) | 0;
    this.c = ((c << 21) | (c >>> 11)) + t | 0;
    return t >>> 0;
  }

  /** [0, 1) */
  next(): number {
    return this.u32() / 4294967296;
  }

  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  /** Integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** Integer in [lo, hi] inclusive. */
  intRange(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  /** Roughly normal(0,1) via sum of uniforms (Irwin–Hall, 4 terms). */
  gauss(): number {
    return (this.next() + this.next() + this.next() + this.next() - 2) * 1.7320508075688772;
  }

  /** Weighted pick; weights need not sum to 1. */
  weighted<T>(items: readonly T[], weights: readonly number[]): T {
    let sum = 0;
    for (const w of weights) sum += w;
    let r = this.next() * sum;
    for (let i = 0; i < items.length; i++) {
      r -= weights[i];
      if (r < 0) return items[i];
    }
    return items[items.length - 1];
  }

  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }
}
