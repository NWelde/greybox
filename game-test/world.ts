import type { Rng } from "./rng";

export type Cell = "floor" | "wall" | "exit";

export interface GameMap {
  width: number;
  height: number;
  cells: Cell[][]; // cells[y][x]
}

export interface Position {
  x: number;
  y: number;
}

export interface Entity {
  position: Position;
  hp: number;
  maxHp: number;
}

export interface Item {
  id: string;
  type: "potion" | "scoreItem";
  value: number;
}

export interface GroundItem extends Item {
  position: Position;
}

export interface Player extends Entity {
  inventory: Item[];
}

export type Monster = Entity;

export interface GameState {
  map: GameMap;
  player: Player;
  monsters: Monster[];
  groundItems: GroundItem[];
  score: number;
}

export type Direction = "up" | "down" | "left" | "right";

const DELTAS: Record<Direction, Position> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

// Border is always wall, interior is floor with a single exit tile placed
// deterministically from the given rng. Simple by design: this is scoped
// as "world state," not "interesting level generation."
export function generateMap(rng: Rng, width: number, height: number): GameMap {
  const cells: Cell[][] = [];

  for (let y = 0; y < height; y++) {
    const row: Cell[] = [];
    for (let x = 0; x < width; x++) {
      const isBorder = x === 0 || y === 0 || x === width - 1 || y === height - 1;
      row.push(isBorder ? "wall" : "floor");
    }
    cells.push(row);
  }

  const exitX = rng.range(1, width - 2);
  const exitY = rng.range(1, height - 2);
  cells[exitY][exitX] = "exit";

  return { width, height, cells };
}

// Picks a floor tile (never a wall or the exit) that isn't already taken.
// Deterministic given the rng; bails out rather than looping forever if
// the map is too small/full to fit another entity.
function randomFloorPosition(
  rng: Rng,
  map: GameMap,
  taken: Position[],
): Position {
  const maxAttempts = 1000;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const x = rng.range(1, map.width - 2);
    const y = rng.range(1, map.height - 2);
    if (map.cells[y][x] !== "floor") continue;
    if (taken.some((p) => p.x === x && p.y === y)) continue;
    return { x, y };
  }
  throw new Error("could not place entity: map too small or too full");
}

export function createInitialState(
  rng: Rng,
  width: number,
  height: number,
): GameState {
  const map = generateMap(rng, width, height);

  const playerPosition = randomFloorPosition(rng, map, []);
  const monsterPosition = randomFloorPosition(rng, map, [playerPosition]);
  const potionPosition = randomFloorPosition(rng, map, [
    playerPosition,
    monsterPosition,
  ]);
  const scoreItemPosition = randomFloorPosition(rng, map, [
    playerPosition,
    monsterPosition,
    potionPosition,
  ]);

  return {
    map,
    player: { position: playerPosition, hp: 10, maxHp: 10, inventory: [] },
    monsters: [{ position: monsterPosition, hp: 5, maxHp: 5 }],
    groundItems: [
      { id: "potion-1", type: "potion", value: 3, position: potionPosition },
      {
        id: "coin-1",
        type: "scoreItem",
        value: 5,
        position: scoreItemPosition,
      },
    ],
    score: 0,
  };
}

function isWalkable(map: GameMap, position: Position): boolean {
  if (position.x < 0 || position.x >= map.width) return false;
  if (position.y < 0 || position.y >= map.height) return false;
  return map.cells[position.y][position.x] !== "wall";
}

export function movePlayer(state: GameState, direction: Direction): GameState {
  const delta = DELTAS[direction];
  const target: Position = {
    x: state.player.position.x + delta.x,
    y: state.player.position.y + delta.y,
  };

  if (!isWalkable(state.map, target)) {
    return state;
  }

  return {
    ...state,
    player: { ...state.player, position: target },
  };
}

export function applyDamage<T extends Entity>(entity: T, amount: number): T {
  return { ...entity, hp: Math.max(0, entity.hp - amount) };
}

const DIRECTIONS: Direction[] = ["up", "down", "left", "right"];

// Random walk: pick a direction; if blocked, the monster just doesn't move
// this turn. Deterministic given the rng passed in.
export function moveMonster(
  state: GameState,
  monsterIndex: number,
  rng: Rng,
): GameState {
  const monster = state.monsters[monsterIndex];
  const direction = DIRECTIONS[rng.range(0, DIRECTIONS.length - 1)];
  const delta = DELTAS[direction];
  const target: Position = {
    x: monster.position.x + delta.x,
    y: monster.position.y + delta.y,
  };

  if (!isWalkable(state.map, target)) {
    return state;
  }

  const monsters = state.monsters.slice();
  monsters[monsterIndex] = { ...monster, position: target };

  return { ...state, monsters };
}
