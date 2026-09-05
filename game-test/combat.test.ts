import { describe, expect, test } from "bun:test";
import { resolveAttack } from "./combat";
import { createRng } from "./rng";
import type { Entity } from "./world";

function makeEntity(hp: number, maxHp = 10): Entity {
  return { position: { x: 0, y: 0 }, hp, maxHp };
}

describe("resolveAttack", () => {
  test("an attack sequence with a fixed seed is reproducible", () => {
    const attacker = makeEntity(10);
    const defenderA = makeEntity(10);
    const defenderB = makeEntity(10);

    const rngA = createRng(7);
    const rngB = createRng(7);

    const resultsA = Array.from({ length: 10 }, () =>
      resolveAttack(attacker, defenderA, rngA),
    );
    const resultsB = Array.from({ length: 10 }, () =>
      resolveAttack(attacker, defenderB, rngB),
    );

    expect(resultsA).toEqual(resultsB);
  });

  test("damage never takes hp below 0", () => {
    const attacker = makeEntity(10);
    let defender = makeEntity(3);
    const rng = createRng(1);

    // Enough swings that at least one is a hit, regardless of hit-chance
    // rolls, without depending on a specific hit/miss sequence.
    for (let i = 0; i < 50; i++) {
      const result = resolveAttack(attacker, defender, rng);
      defender = result.defender;
      expect(defender.hp).toBeGreaterThanOrEqual(0);
    }
  });

  test("a dead defender takes no further damage", () => {
    const attacker = makeEntity(10);
    const deadDefender = makeEntity(0);
    const rng = createRng(1);

    const result = resolveAttack(attacker, deadDefender, rng);

    expect(result.hit).toBe(false);
    expect(result.damage).toBe(0);
    expect(result.defender.hp).toBe(0);
  });

  test("a dead attacker cannot act", () => {
    const deadAttacker = makeEntity(0);
    const defender = makeEntity(10);
    const rng = createRng(1);

    const result = resolveAttack(deadAttacker, defender, rng);

    expect(result.hit).toBe(false);
    expect(result.damage).toBe(0);
    expect(result.defender.hp).toBe(10);
  });
});
