# Build checklist, by piece

Concrete tasks for each of the seven pieces in `game-scope.md`, in build
order. Each piece should be written and tested before the next one depends
on it.

## 1. Deterministic RNG — done (`game-test/rng.ts`, `game-test/rng.test.ts`)

- [x] Pick an algorithm (mulberry32 or similar small seeded PRNG; avoid
      `Math.random()` anywhere else in the codebase from this point on)
- [x] `createRng(seed: number)` returning a generator/closure
- [x] `next()` — raw float in [0, 1)
- [x] `range(min: number, max: number)` — integer in [min, max]
- [x] Test: same seed, called N times, produces the same sequence twice
- [x] Test: different seeds produce different sequences
- [x] Test: `range` never returns outside [min, max], across many calls

## 2. World state (map, player, entities) — done (`game-test/world.ts`, `game-test/world.test.ts`)

- [x] Define the map representation (2D grid, cell types: floor, wall, exit)
- [x] Define `Player` (position, HP, max HP, inventory)
- [x] Define `Monster` (position, HP, max HP)
- [x] `generateMap(rng)` — deterministic given the RNG instance
- [x] `movePlayer(state, direction)` — returns new state, blocked by walls
      and map edges
- [x] `applyDamage(entity, amount)` — clamps at 0, doesn't go negative
- [x] `moveMonster(state, monster, rng)` — whatever movement rule you pick
      (random walk, chase), deterministic given the RNG
- [x] Test: moving into a wall is a no-op (state unchanged)
- [x] Test: moving into a floor tile updates position
- [x] Test: `applyDamage` clamps at 0, never negative
- [x] Test: two `generateMap` calls with the same seed produce identical maps

## 3. Combat — done (`game-test/combat.ts`, `game-test/combat.test.ts`)

- [x] `resolveAttack(attacker, defender, rng)` — hit/miss roll, damage roll
- [x] Decide and document the hit-chance and damage formulas (write them
      down somewhere, since they affect how findable/repro-able bugs are) —
      80% hit chance, 2-6 damage, documented as constants in `combat.ts`
- [x] Handle defender reaching 0 HP inside the resolution (mark dead, don't
      let HP go negative) — reuses `applyDamage`'s clamp, plus `isDead`
- [x] Test: attack sequence with a fixed seed is reproducible
- [x] Test: damage never takes HP below 0
- [x] Test: dead entity doesn't take further damage / act again

## 4. Items and inventory — done (`game-test/items.ts`, `game-test/items.test.ts`)

- [x] Define `Item` (type: potion | scoreItem, value) — in `world.ts`,
      alongside `GroundItem` (an `Item` placed on the map) and `score` on
      `GameState`
- [x] `pickUp(state, itemId)` — moves item from map cell to inventory
- [x] `drop(state, itemId)` — moves item from inventory back to map cell
- [x] `drinkPotion(state, itemId)` — heals player HP
- [x] **Planted bug 1**: `drinkPotion` doesn't clamp HP at max — verified:
      the test asserting correct behavior fails (13 instead of 10, capped
      at 10). See `items.ts`, the `drinkPotion` heal line, and the
      `PLANTED BUG 1` test in `items.test.ts` (left failing on purpose).
- [x] Scored items: pickup adds to score
- [x] **Planted bug 2**: `drop` on a scored item subtracts its value again
      — verified: the test asserting correct behavior fails (score goes to
      0 instead of staying at 5). See `items.ts`, the `drop` score line,
      and the `PLANTED BUG 2` test in `items.test.ts` (left failing on
      purpose).
- [x] Test: potion at partial HP heals correctly and clamps at max HP (this
      test should pass — the bug is specifically the full-HP case) — passes
- [x] Test: pickup increases score by item value — passes
- [x] Note somewhere (comment or separate doc) exactly which two lines are
      the planted bugs, so they're easy to point to later when scoring —
      commented directly above each bug's line in `items.ts`, plus named
      in the two `PLANTED BUG` tests
      whether the agent found them

## 5. Win/lose and episode lifecycle — done (`game-test/lifecycle.ts`, `game-test/lifecycle.test.ts`)

- [x] Decide the win condition (reach exit tile, clear all monsters, etc.)
      — reaching the exit tile
- [x] `checkOutcome(state)` — returns `"playing" | "win" | "lose"`
- [x] Lose triggers when player HP hits 0 — checked first, so a lethal hit
      that lands on the exit tile still counts as a loss
- [x] On win/lose, produce the final message text to print —
      `outcomeMessage(outcome)`
- [ ] Wire outcome check into the turn loop (checked after every action) —
      deferred to piece 6, since there's no turn loop yet to wire it into
- [x] Test: player HP at 0 after damage resolves to `"lose"`
- [x] Test: reaching the win condition resolves to `"win"`
- [x] Test: mid-game state resolves to `"playing"`
- [x] (extra) Test: lose takes priority over win when both hold at once
- [x] (extra) Test: outcome messages are non-empty for win/lose

## 6. Text protocol — done (`game-test/protocol.ts`, `game-test/protocol.test.ts`)

- [x] Write the startup banner text (short, in-character, doesn't list
      commands outright)
- [x] `renderState(state)` — turn the world state into the text block shown
      each turn — ascii grid (`#`/`.`/`X`/`@`/`m`/`!`/`$`) plus HP, score,
      inventory lines
- [x] `parseCommand(line: string)` — map a raw input line to an internal
      action, or `null`/unknown
- [x] Unknown-command response text ("I don't understand that." or similar —
      real signal, not a stack trace)
- [x] Wire up the stdin read loop (read line, parse, apply, render, repeat)
      — `runProtocolLoop`, also picks up piece 5's deferred outcome-check
      wiring (checks `checkOutcome` after every action, prints the outcome
      message and stops on win/lose)
- [x] Manually playtest: sit down without documentation and see if you (as a
      cold reader) can figure out the verbs from the banner + errors alone
      — ran a scripted smoke test (garbage input, move, take, drink) end to
      end; banner/grid/error text read as intended and the loop even
      surfaced the planted overheal bug live (HP 13/10). A real cold-read
      by a person who hasn't seen this checklist is still worth doing
      before calling discoverability proven.
- [x] Test: `parseCommand` on garbage input returns unknown, doesn't throw
- [x] Test: `renderState` output is stable for a given state (useful for
      snapshot-testing the format later)

## 7. Entry point — done (`game-test/main.ts`, plus `createInitialState` in `game-test/world.ts`)

- [x] Parse the seed flag from argv — `--seed N`, `-s N`, or `--seed=N`;
      falls back to `Date.now()` if none given
- [x] Construct RNG, initial world state, wire the turn loop from piece 6
- [x] Confirm this file has no game logic in it — only argument parsing and
      wiring — placement/generation logic lives in `createInitialState`
      (`world.ts`), which `main.ts` just calls; `main.ts` itself only
      parses argv and adapts `process.stdin` to `ProtocolIO`
- [x] Manual end-to-end run: launch with a seed, play a full episode by hand
      — ran `--seed 42` piped through a few commands, played correctly
- [x] Manual determinism check: same seed, same typed actions, twice, diff
      the two output logs — must be byte-identical — confirmed via `diff`,
      identical

(`createInitialState`'s entity placement is logic, not wiring, so it's
tested like the other pieces: 2 tests in `world.test.ts` — same seed
produces an identical initial state twice, and player/monster/potion land
on distinct floor tiles.)
