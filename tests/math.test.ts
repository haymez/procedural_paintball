import { describe, expect, it } from "vitest";
import { Rng, hashString } from "../shared/math/rng";
import { Noise } from "../shared/math/noise";
import { atan2, cos, exp, log, pow, sin } from "../shared/math/trig";

describe("deterministic trig", () => {
  it("sin/cos match Math within 1e-8 over a wide range", () => {
    for (let x = -60; x <= 60; x += 0.0137) {
      expect(Math.abs(sin(x) - Math.sin(x))).toBeLessThan(1e-8);
      expect(Math.abs(cos(x) - Math.cos(x))).toBeLessThan(1e-8);
    }
  });
  it("atan2 matches Math.atan2 within 1e-7", () => {
    for (let a = -7; a <= 7; a += 0.31)
      for (let b = -7; b <= 7; b += 0.29) expect(Math.abs(atan2(a, b) - Math.atan2(a, b))).toBeLessThan(1e-7);
    expect(atan2(0, -1)).toBeCloseTo(Math.PI, 9);
    expect(atan2(1, 0)).toBeCloseTo(Math.PI / 2, 9);
  });
  it("exp/log/pow are accurate", () => {
    for (let x = -20; x <= 20; x += 0.173) expect(Math.abs(exp(x) / Math.exp(x) - 1)).toBeLessThan(1e-9);
    for (let x = 0.001; x < 1e6; x *= 1.37) expect(Math.abs(log(x) - Math.log(x))).toBeLessThan(1e-9);
    expect(pow(2.5, 3.2) / Math.pow(2.5, 3.2)).toBeCloseTo(1, 9);
  });
});

describe("rng", () => {
  it("is deterministic and forks independently of draw count", () => {
    const a = new Rng(42), b = new Rng(42);
    for (let i = 0; i < 100; i++) expect(a.u32()).toBe(b.u32());
    const c = new Rng(7);
    const f1 = c.fork("x").u32();
    for (let i = 0; i < 50; i++) c.next();
    expect(c.fork("x").u32()).toBe(f1);
    expect(c.fork("y").u32()).not.toBe(f1);
  });
  it("produces uniform-ish floats in [0, 1)", () => {
    const r = new Rng(3);
    let sum = 0;
    for (let i = 0; i < 20000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      sum += v;
    }
    expect(Math.abs(sum / 20000 - 0.5)).toBeLessThan(0.01);
  });
  it("hashString is stable", () => {
    expect(hashString("isola")).toBe(hashString("isola"));
    expect(hashString("isola")).not.toBe(hashString("isolb"));
  });
});

describe("noise", () => {
  it("is deterministic per seed and bounded", () => {
    const n1 = new Noise(new Rng(5)), n2 = new Noise(new Rng(5)), n3 = new Noise(new Rng(6));
    let diff = 0;
    for (let i = 0; i < 2000; i++) {
      const x = i * 0.137, y = i * 0.071;
      const v = n1.n2(x, y);
      expect(v).toBe(n2.n2(x, y));
      expect(Math.abs(v)).toBeLessThanOrEqual(1.01);
      expect(Math.abs(n1.n3(x, y, x - y))).toBeLessThanOrEqual(1.01);
      const r = n1.ridged(x, y, 4);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(1);
      diff += Math.abs(v - n3.n2(x, y));
    }
    expect(diff).toBeGreaterThan(100);
  });
});
