import { resolveAttack } from "./combat";
import { checkOutcome, outcomeMessage } from "./lifecycle";
import { drinkPotion, drop, pickUp } from "./items";
import type { Rng } from "./rng";
import {
  moveMonster,
  movePlayer,
  type Cell,
  type Direction,
  type GameState,
  type Item,
} from "./world";

// Short, in-character, and deliberately doesn't list commands: the agent
// (or a person) has to infer the verb set from this plus how the game
// responds to bad input, not from a printed menu.
export const BANNER =
  "You wake in a cold stone corridor. Something is down here with you.\n" +
  "Your torch is dying. Whatever you're going to do, do it now.";

export const UNKNOWN_COMMAND = "I don't understand that.";
export const PROMPT = "> ";

export type Action =
  | { kind: "move"; direction: Direction }
  | { kind: "attack"; direction: Direction }
  | { kind: "take" }
  | { kind: "drink" }
  | { kind: "drop"; itemType: Item["type"] }
  | { kind: "wait" };

const MOVE_WORDS: Record<string, Direction> = {
  north: "up",
  n: "up",
  south: "down",
  s: "down",
  east: "right",
  e: "right",
  west: "left",
  w: "left",
};

const ITEM_TYPE_WORDS: Record<string, Item["type"]> = {
  potion: "potion",
  coin: "scoreItem",
  gold: "scoreItem",
  gem: "scoreItem",
};

export function parseCommand(line: string): Action | null {
  const words = line.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;

  const [verb, arg] = words;

  if (verb in MOVE_WORDS) {
    return { kind: "move", direction: MOVE_WORDS[verb] };
  }

  if (verb === "attack" && arg in MOVE_WORDS) {
    return { kind: "attack", direction: MOVE_WORDS[arg] };
  }

  if (verb === "take" || verb === "get" || verb === "pickup") {
    return { kind: "take" };
  }

  if (verb === "drink" || verb === "quaff") {
    return { kind: "drink" };
  }

  if (verb === "drop" && arg in ITEM_TYPE_WORDS) {
    return { kind: "drop", itemType: ITEM_TYPE_WORDS[arg] };
  }

  if (verb === "wait" || verb === "z") {
    return { kind: "wait" };
  }

  return null;
}

function cellChar(cell: Cell): string {
  if (cell === "wall") return "#";
  if (cell === "exit") return "X";
  return ".";
}

function itemChar(itemType: Item["type"]): string {
  return itemType === "potion" ? "!" : "$";
}

export function renderState(state: GameState): string {
  const rows = state.map.cells.map((row) => row.map(cellChar));

  for (const item of state.groundItems) {
    rows[item.position.y][item.position.x] = itemChar(item.type);
  }
  for (const monster of state.monsters) {
    rows[monster.position.y][monster.position.x] = "m";
  }
  rows[state.player.position.y][state.player.position.x] = "@";

  const grid = rows.map((row) => row.join("")).join("\n");
  const status = `HP: ${state.player.hp}/${state.player.maxHp}  Score: ${state.score}`;
  const inventory = state.player.inventory.length
    ? `Carrying: ${state.player.inventory.map((i) => i.type).join(", ")}`
    : "Carrying: nothing";

  return [grid, status, inventory].join("\n\n");
}

function findAdjacentMonsterIndex(
  state: GameState,
  direction: Direction,
): number {
  const delta = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } }[
    direction
  ];
  const target = {
    x: state.player.position.x + delta.x,
    y: state.player.position.y + delta.y,
  };
  return state.monsters.findIndex(
    (m) => m.position.x === target.x && m.position.y === target.y,
  );
}

export function applyAction(
  state: GameState,
  action: Action,
  rng: Rng,
): GameState {
  let next = state;

  switch (action.kind) {
    case "move":
      next = movePlayer(next, action.direction);
      break;
    case "attack": {
      const index = findAdjacentMonsterIndex(next, action.direction);
      if (index !== -1) {
        const result = resolveAttack(next.player, next.monsters[index], rng);
        const monsters = next.monsters.slice();
        monsters[index] = result.defender;
        next = { ...next, monsters };
      }
      break;
    }
    case "take": {
      const item = next.groundItems.find(
        (i) =>
          i.position.x === next.player.position.x &&
          i.position.y === next.player.position.y,
      );
      if (item) next = pickUp(next, item.id);
      break;
    }
    case "drink": {
      const potion = next.player.inventory.find((i) => i.type === "potion");
      if (potion) next = drinkPotion(next, potion.id);
      break;
    }
    case "drop": {
      const item = next.player.inventory.find((i) => i.type === action.itemType);
      if (item) next = drop(next, item.id);
      break;
    }
    case "wait":
      break;
  }

  for (let i = 0; i < next.monsters.length; i++) {
    if (next.monsters[i].hp > 0) {
      next = moveMonster(next, i, rng);
    }
  }

  return next;
}

export interface ProtocolIO {
  write(text: string): void;
  readLine(): Promise<string | null>;
}

export async function runProtocolLoop(
  state: GameState,
  rng: Rng,
  io: ProtocolIO,
): Promise<GameState> {
  io.write(BANNER);
  io.write(renderState(state));

  let current = state;

  while (true) {
    io.write(PROMPT);
    const line = await io.readLine();
    if (line === null) return current;

    const action = parseCommand(line);
    if (!action) {
      io.write(UNKNOWN_COMMAND);
      continue;
    }

    current = applyAction(current, action, rng);
    io.write(renderState(current));

    const outcome = checkOutcome(current);
    if (outcome !== "playing") {
      io.write(outcomeMessage(outcome));
      return current;
    }
  }
}
