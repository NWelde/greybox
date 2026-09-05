import { describe, expect, test } from "bun:test";
import { checkOutcome, outcomeMessage } from "./lifecycle";
import type { GameState } from "./world";

function makeState(overrides: Partial<GameState["player"]> = {}): GameState {
  return {
    map: {
      width: 3,
      height: 3,
      cells: [
        ["wall", "wall", "wall"],
        ["wall", "floor", "wall"],
        ["wall", "exit", "wall"],
      ],
    },
    player: {
      position: { x: 1, y: 1 },
      hp: 10,
      maxHp: 10,
      inventory: [],
      ...overrides,
    },
    monsters: [],
    groundItems: [],
    score: 0,
  };
}

describe("checkOutcome", () => {
  test("player HP at 0 resolves to lose", () => {
    const state = makeState({ hp: 0 });

    expect(checkOutcome(state)).toBe("lose");
  });

  test("standing on the exit tile resolves to win", () => {
    const state = makeState({ position: { x: 1, y: 2 } });

    expect(checkOutcome(state)).toBe("win");
  });

  test("mid-game state resolves to playing", () => {
    const state = makeState();

    expect(checkOutcome(state)).toBe("playing");
  });

  test("lose takes priority over win when both conditions hold", () => {
    const state = makeState({ position: { x: 1, y: 2 }, hp: 0 });

    expect(checkOutcome(state)).toBe("lose");
  });
});

describe("outcomeMessage", () => {
  test("has a non-empty message for win", () => {
    expect(outcomeMessage("win").length).toBeGreaterThan(0);
  });

  test("has a non-empty message for lose", () => {
    expect(outcomeMessage("lose").length).toBeGreaterThan(0);
  });
});
