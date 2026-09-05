import { describe, expect, test } from "bun:test";
import { drinkPotion, drop, pickUp } from "./items";
import type { GameState, GroundItem } from "./world";

function makeState(groundItems: GroundItem[], playerOverrides = {}): GameState {
  return {
    map: { width: 5, height: 5, cells: [] },
    player: {
      position: { x: 2, y: 2 },
      hp: 10,
      maxHp: 10,
      inventory: [],
      ...playerOverrides,
    },
    monsters: [],
    groundItems,
    score: 0,
  };
}

describe("pickUp", () => {
  test("increases score by the item's value", () => {
    const state = makeState([
      { id: "coin-1", type: "scoreItem", value: 5, position: { x: 2, y: 2 } },
    ]);

    const result = pickUp(state, "coin-1");

    expect(result.score).toBe(5);
    expect(result.player.inventory).toHaveLength(1);
    expect(result.groundItems).toHaveLength(0);
  });
});

describe("drinkPotion", () => {
  test("at partial HP, heals correctly and stays at or under max HP", () => {
    const state = makeState([], {
      hp: 5,
      maxHp: 10,
      inventory: [{ id: "potion-1", type: "potion", value: 3 }],
    });

    const result = drinkPotion(state, "potion-1");

    expect(result.player.hp).toBe(8);
    expect(result.player.hp).toBeLessThanOrEqual(result.player.maxHp);
  });

  // PLANTED BUG 1 (see items.ts: drinkPotion's `hp` line has no clamp to
  // maxHp). This test encodes the correct behavior and is expected to
  // fail against the current implementation — that failure is the proof
  // the bug is real, not a check we're trying to make pass right now.
  test("PLANTED BUG 1: at full HP, does not overheal past max HP", () => {
    const state = makeState([], {
      hp: 10,
      maxHp: 10,
      inventory: [{ id: "potion-1", type: "potion", value: 3 }],
    });

    const result = drinkPotion(state, "potion-1");

    expect(result.player.hp).toBe(10);
  });
});

describe("drop", () => {
  // PLANTED BUG 2 (see items.ts: drop's `score` line reduces cumulative
  // collected score instead of leaving it alone). Same as above: this test is
  // expected to fail, and that failure is the proof.
  test("PLANTED BUG 2: dropping a scored item does not change score", () => {
    const state = makeState([], {
      inventory: [{ id: "coin-1", type: "scoreItem", value: 5 }],
    });
    const stateWithScore: GameState = { ...state, score: 5 };

    const result = drop(stateWithScore, "coin-1");

    expect(result.score).toBe(5);
  });
});
