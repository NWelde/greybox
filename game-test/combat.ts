import type { Rng } from "./rng";
import { applyDamage, type Entity } from "./world";

// Hit-chance and damage formulas, written down here since they affect how
// findable/repro-able any combat-related bug is:
//   - hit chance: flat 80%, independent of either entity's stats
//   - damage: uniform random integer in [2, 6] on a hit, 0 on a miss
export const HIT_CHANCE = 0.8;
export const MIN_DAMAGE = 2;
export const MAX_DAMAGE = 6;

export interface AttackResult {
  defender: Entity;
  hit: boolean;
  damage: number;
}

export function isDead(entity: Entity): boolean {
  return entity.hp <= 0;
}

export function resolveAttack(
  attacker: Entity,
  defender: Entity,
  rng: Rng,
): AttackResult {
  if (isDead(attacker) || isDead(defender)) {
    return { defender, hit: false, damage: 0 };
  }

  const hit = rng.next() < HIT_CHANCE;
  if (!hit) {
    return { defender, hit: false, damage: 0 };
  }

  const damage = rng.range(MIN_DAMAGE, MAX_DAMAGE);
  return { defender: applyDamage(defender, damage), hit: true, damage };
}
