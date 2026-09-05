import { describe, expect, test } from "bun:test";
import { createRng } from "./rng";

describe("createRng", () => {
  test("same seed produces the same sequence twice", () => {
    const a = createRng(42);
    const b = createRng(42);

    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());

    expect(seqA).toEqual(seqB);
  });

  test("different seeds produce different sequences", () => {
    const a = createRng(1);
    const b = createRng(2);

    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());

    expect(seqA).not.toEqual(seqB);
  });

  test("next() returns a raw float in [0, 1)", () => {
    const rng = createRng(7);

    for (let i = 0; i < 1000; i++) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  test("range() never returns outside [min, max]", () => {
    const rng = createRng(123);

    for (let i = 0; i < 1000; i++) {
      const value = rng.range(3, 8);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(3);
      expect(value).toBeLessThanOrEqual(8);
    }
  });

  test("range() can return both its min and max bound", () => {
    const rng = createRng(99);
    const seen = new Set<number>();

    for (let i = 0; i < 2000; i++) {
      seen.add(rng.range(0, 1));
    }

    expect(seen.has(0)).toBe(true);
    expect(seen.has(1)).toBe(true);
  });
});
