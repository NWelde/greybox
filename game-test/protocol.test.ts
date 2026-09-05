import { describe, expect, test } from "bun:test";
import {
  BANNER,
  UNKNOWN_COMMAND,
  parseCommand,
  renderState,
} from "./protocol";
import type { GameState } from "./world";

function makeState(): GameState {
  return {
    map: {
      width: 4,
      height: 3,
      cells: [
        ["wall", "wall", "wall", "wall"],
        ["wall", "floor", "floor", "wall"],
        ["wall", "wall", "wall", "wall"],
      ],
    },
    player: { position: { x: 1, y: 1 }, hp: 8, maxHp: 10, inventory: [] },
    monsters: [{ position: { x: 2, y: 1 }, hp: 5, maxHp: 5 }],
    groundItems: [
      { id: "p1", type: "potion", value: 3, position: { x: 1, y: 1 } },
    ],
    score: 2,
  };
}

describe("parseCommand", () => {
  test("garbage input returns null and doesn't throw", () => {
    expect(() => parseCommand("asdkfjasldkf")).not.toThrow();
    expect(parseCommand("asdkfjasldkf")).toBeNull();
  });

  test("empty input returns null", () => {
    expect(parseCommand("")).toBeNull();
  });

  test("recognizes a movement word", () => {
    expect(parseCommand("north")).toEqual({ kind: "move", direction: "up" });
  });

  test("is case-insensitive and trims whitespace", () => {
    expect(parseCommand("  NORTH  ")).toEqual({
      kind: "move",
      direction: "up",
    });
  });
});

describe("renderState", () => {
  test("output is stable for a given state", () => {
    const state = makeState();

    const a = renderState(state);
    const b = renderState(makeState());

    expect(a).toBe(b);
  });

  test("includes the player's HP", () => {
    const state = makeState();

    expect(renderState(state)).toContain("8/10");
  });
});

describe("protocol text", () => {
  test("banner is non-empty and doesn't list commands outright", () => {
    expect(BANNER.length).toBeGreaterThan(0);
    expect(BANNER.toLowerCase()).not.toContain("north");
    expect(BANNER.toLowerCase()).not.toContain("attack");
  });

  test("unknown-command response is non-empty", () => {
    expect(UNKNOWN_COMMAND.length).toBeGreaterThan(0);
  });
});
