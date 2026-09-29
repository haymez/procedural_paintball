// Deterministic transcendental approximations built only from + - * /,
// Math.floor/round and Math.sqrt, so results are bit-identical across engines.
// Never use Math.sin/cos/atan2/exp/log/pow in world generation or the sim.

export const PI = 3.141592653589793;
export const TAU = 6.283185307179586;
export const HALF_PI = 1.5707963267948966;
const LN2 = 0.6931471805599453;
const INV_LN2 = 1.4426950408889634;

/** sin(x), |error| < 1e-9 for |x| < 1e4. */
export function sin(x: number): number {
  const k = Math.round(x / PI);
  // Cody–Waite style two-part reduction for accuracy.
  let r = x - k * 3.1415926218032837;
  r -= k * 3.178650954705639e-8;
  const r2 = r * r;
  // Taylor to r^13 on [-pi/2, pi/2].
  const s =
    r *
    (1 +
      r2 *
        (-1 / 6 +
          r2 *
            (1 / 120 +
              r2 *
                (-1 / 5040 +
                  r2 * (1 / 362880 + r2 * (-1 / 39916800 + r2 * (1 / 6227020800)))))));
  return (k & 1) === 0 ? s : -s;
}

export function cos(x: number): number {
  return sin(x + HALF_PI);
}

/** atan(x) for any x, |error| < 2e-8. */
export function atan(x: number): number {
  let neg = false;
  if (x < 0) {
    neg = true;
    x = -x;
  }
  let inv = false;
  if (x > 1) {
    inv = true;
    x = 1 / x;
  }
  // Reduce further: atan(x) = pi/6 + atan((x*sqrt3 - 1)/(sqrt3 + x)) for x > 2-sqrt3.
  let off = 0;
  if (x > 0.2679491924311228) {
    const s3 = 1.7320508075688772;
    x = (x * s3 - 1) / (s3 + x);
    off = 0.5235987755982988;
  }
  const x2 = x * x;
  // Taylor series on |x| <= 0.268 (converges fast).
  let r =
    x *
    (1 +
      x2 *
        (-1 / 3 +
          x2 *
            (1 / 5 +
              x2 * (-1 / 7 + x2 * (1 / 9 + x2 * (-1 / 11 + x2 * (1 / 13 + x2 * (-1 / 15))))))));
  r += off;
  if (inv) r = HALF_PI - r;
  return neg ? -r : r;
}

/** atan2(y, x) in (-pi, pi]. */
export function atan2(y: number, x: number): number {
  if (x > 0) return atan(y / x);
  if (x < 0) return y >= 0 ? atan(y / x) + PI : atan(y / x) - PI;
  if (y > 0) return HALF_PI;
  if (y < 0) return -HALF_PI;
  return 0;
}

/** 2^k for integer k, exact. */
export function pow2i(k: number): number {
  let p = 1;
  let b = k < 0 ? 0.5 : 2;
  let n = k < 0 ? -k : k;
  while (n > 0) {
    if (n & 1) p *= b;
    b *= b;
    n >>= 1;
  }
  return p;
}

export function exp(x: number): number {
  if (x > 700) return Infinity;
  if (x < -740) return 0;
  const k = Math.round(x * INV_LN2);
  const r = x - k * LN2; // |r| <= 0.347
  const e =
    1 +
    r *
      (1 +
        r *
          (1 / 2 +
            r *
              (1 / 6 +
                r *
                  (1 / 24 +
                    r * (1 / 120 + r * (1 / 720 + r * (1 / 5040 + r * (1 / 40320 + r * (1 / 362880)))))))));
  return e * pow2i(k);
}

/** Natural log, x > 0. */
export function log(x: number): number {
  if (!(x > 0)) return x === 0 ? -Infinity : NaN;
  let e = 0;
  while (x >= 1.4142135623730951) {
    x *= 0.5;
    e++;
  }
  while (x < 0.7071067811865476) {
    x *= 2;
    e--;
  }
  const s = (x - 1) / (x + 1);
  const s2 = s * s;
  const l =
    2 *
    s *
    (1 + s2 * (1 / 3 + s2 * (1 / 5 + s2 * (1 / 7 + s2 * (1 / 9 + s2 * (1 / 11 + s2 * (1 / 13 + s2 / 15)))))));
  return l + e * LN2;
}

/** a^b for a > 0. */
export function pow(a: number, b: number): number {
  if (a === 0) return b === 0 ? 1 : 0;
  return exp(b * log(a));
}

/** Wrap angle to (-pi, pi]. */
export function wrapAngle(a: number): number {
  a = a - TAU * Math.floor((a + PI) / TAU);
  return a;
}
