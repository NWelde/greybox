import { describe, expect, test } from "bun:test";
import { applyDamage, createInitialState, generateMap, movePlayer } from "./world";
import { createRng } from "./rng";

describe("movePlayer", () => {
  test("moving into a wall is a no-op", () => {
    const map = generateMap(createRng(1), 5, 5);
    // (0, y) is always the border wall column.
    const state = {
      map,
      player: { position: { x: 1, y: 1 }, hp: 10, maxHp: 10, inventory: [] },
      monsters: [],
      groundItems: [],
      score: 0,
    };

    const result = movePlayer(state, "left");

    expect(result.player.position).toEqual({ x: 1, y: 1 });
  });

  test("moving off the edge of the map is a no-op", () => {
    const map = generateMap(createRng(1), 5, 5);
    const state = {
      map,
      player: { position: { x: 0, y: 0 }, hp: 10, maxHp: 10, inventory: [] },
      monsters: [],
      groundItems: [],
      score: 0,
    };

    const result = movePlayer(state, "up");

    expect(result.player.position).toEqual({ x: 0, y: 0 });
  });

  test("moving into a floor tile updates position", () => {
    const map = generateMap(createRng(1), 5, 5);
    // Interior floor tiles form a ring around (1,1)-(3,3); (2,2) and (3,2)
    // are both interior, so this move is always onto floor regardless of
    // where generateMap happens to place the exit.
    const state = {
      map,
      player: { position: { x: 2, y: 2 }, hp: 10, maxHp: 10, inventory: [] },
      monsters: [],
      groundItems: [],
      score: 0,
    };

    const result = movePlayer(state, "right");

    expect(result.player.position).toEqual({ x: 3, y: 2 });
  });
});

describe("applyDamage", () => {
  test("clamps at 0, never negative", () => {
    const entity = { position: { x: 0, y: 0 }, hp: 10, maxHp: 10 };

    const result = applyDamage(entity, 999);

    expect(result.hp).toBe(0);
  });

  test("normal damage reduces hp by the given amount", () => {
    const entity = { position: { x: 0, y: 0 }, hp: 10, maxHp: 10 };

    const result = applyDamage(entity, 3);

    expect(result.hp).toBe(7);
  });
});

describe("generateMap", () => {
  test("same seed produces an identical map twice", () => {
    const mapA = generateMap(createRng(42), 8, 8);
    const mapB = generateMap(createRng(42), 8, 8);

    expect(mapA).toEqual(mapB);
  });

  test("different seeds can produce different maps", () => {
    const mapA = generateMap(createRng(1), 8, 8);
    const mapB = generateMap(createRng(2), 8, 8);

    expect(mapA).not.toEqual(mapB);
  });
});

describe("createInitialState", () => {
  test("same seed produces an identical initial state twice", () => {
    const stateA = createInitialState(createRng(42), 8, 8);
    const stateB = createInitialState(createRng(42), 8, 8);

    expect(stateA).toEqual(stateB);
  });

  test("player, monster, potion, and scored item start on distinct floor tiles", () => {
    const state = createInitialState(createRng(42), 8, 8);
    const positions = [
      state.player.position,
      state.monsters[0].position,
      ...state.groundItems.map((item) => item.position),
    ];

    for (const p of positions) {
      expect(state.map.cells[p.y][p.x]).toBe("floor");
    }

    const unique = new Set(positions.map((p) => `${p.x},${p.y}`));
    expect(unique.size).toBe(positions.length);
    expect(state.groundItems.map((item) => item.type).sort()).toEqual([
      "potion",
      "scoreItem",
    ]);
  });

  test("adding the scored item preserves the seed 42 potion position", () => {
    const state = createInitialState(createRng(42), 8, 8);
    const potion = state.groundItems.find((item) => item.type === "potion");

    expect(potion?.position).toEqual({ x: 6, y: 3 });
  });
});
