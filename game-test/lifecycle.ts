import type { GameState } from "./world";

export type Outcome = "playing" | "win" | "lose";

// Win: standing on the exit tile. Lose: HP at or below 0. Lose is checked
// first, since a lethal hit that also happens to land you on the exit
// tile (e.g. an attack triggered by stepping onto it) should still end
// the episode as a loss.
export function checkOutcome(state: GameState): Outcome {
  if (state.player.hp <= 0) return "lose";

  const { x, y } = state.player.position;
  const cell = state.map.cells[y]?.[x];
  if (cell === "exit") return "win";

  return "playing";
}

export function outcomeMessage(outcome: Outcome): string {
  switch (outcome) {
    case "win":
      return "You found the exit. You win!";
    case "lose":
      return "You have died.";
    case "playing":
      return "";
  }
}
