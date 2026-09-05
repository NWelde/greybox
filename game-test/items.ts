import type { GameState, Item } from "./world";

export function pickUp(state: GameState, itemId: string): GameState {
  const item = state.groundItems.find((i) => i.id === itemId);
  if (!item) return state;

  const isAtPlayer =
    item.position.x === state.player.position.x &&
    item.position.y === state.player.position.y;
  if (!isAtPlayer) return state;

  const { position: _position, ...bareItem } = item;
  const player = {
    ...state.player,
    inventory: [...state.player.inventory, bareItem as Item],
  };
  const groundItems = state.groundItems.filter((i) => i.id !== itemId);
  const score =
    item.type === "scoreItem" ? state.score + item.value : state.score;

  return { ...state, player, groundItems, score };
}

export function drop(state: GameState, itemId: string): GameState {
  const item = state.player.inventory.find((i) => i.id === itemId);
  if (!item) return state;

  const inventory = state.player.inventory.filter((i) => i.id !== itemId);
  const player = { ...state.player, inventory };
  const groundItems = [
    ...state.groundItems,
    { ...item, position: state.player.position },
  ];

  // PLANTED BUG 2: dropping a scored item subtracts its value again
  // instead of leaving score untouched, so a pickup-then-drop cycle nets
  // -value, and repeating it sends score negative.
  const score =
    item.type === "scoreItem" ? state.score - item.value : state.score;

  return { ...state, player, groundItems, score };
}

export function drinkPotion(state: GameState, itemId: string): GameState {
  const item = state.player.inventory.find(
    (i) => i.id === itemId && i.type === "potion",
  );
  if (!item) return state;

  const inventory = state.player.inventory.filter((i) => i.id !== itemId);
  // PLANTED BUG 1: heal is not clamped to maxHp, so drinking at full HP
  // overheals past the cap.
  const player = { ...state.player, inventory, hp: state.player.hp + item.value };

  return { ...state, player };
}
