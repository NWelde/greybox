export interface Rng {
  next(): number;
  range(min: number, max: number): number;
}

// mulberry32: small, fast, deterministic PRNG. Good enough for game logic;
// not cryptographically secure, and doesn't need to be.
export function createRng(seed: number): Rng {
  let state = seed >>> 0;

  function next(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function range(min: number, max: number): number {
    return min + Math.floor(next() * (max - min + 1));
  }

  return { next, range };
}
