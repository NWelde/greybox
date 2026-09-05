# Changelog

All notable changes to this project are logged here, newest first. Entries
are grouped as Added, Fixed, or Docs.

## Unreleased

### Added

- `game-test/main.ts`: the entry point — parses `--seed`/`-s`/`--seed=N`
  from argv, constructs the RNG and initial state, adapts
  `process.stdin`/`console.log` to `ProtocolIO`, and calls
  `runProtocolLoop`. No game logic of its own.
- `game-test/world.ts`: added `createInitialState(rng, width, height)` —
  places the player, one monster, and one potion on distinct floor tiles.
  2 new tests in `world.test.ts` (determinism, distinct-floor-tiles),
  both passing.
- Manually verified: a full episode played correctly end to end via
  `bun run game-test/main.ts --seed 42` piped a few commands, and running
  the same seed and commands twice produced byte-identical output
  (`diff`). This closes out all 7 pieces of the dungeon-crawler game from
  `game-scope.md`. Full suite: 34 pass, 2 expected-fail (the two planted
  bugs from piece 4, unchanged).
- `game-test/protocol.ts`: the text protocol layer — `BANNER`,
  `UNKNOWN_COMMAND`, `parseCommand`, `renderState` (ascii grid + HP/score/
  inventory), `applyAction` (dispatches to world/combat/items and steps
  monsters), and `runProtocolLoop` wiring all of it plus piece 5's outcome
  check to a pluggable stdin/stdout-shaped `ProtocolIO`.
- `game-test/protocol.test.ts`: 8 tests (parseCommand null-safety and
  case-insensitivity, renderState stability and content), all passing.
  Also ran a scripted smoke test of the full loop end to end — it read
  correctly and incidentally reproduced the planted overheal bug live.
- `game-test/lifecycle.ts`: `checkOutcome` (win on reaching the exit tile,
  lose on HP <= 0, lose checked first so a lethal hit that lands on the
  exit still counts as a loss) and `outcomeMessage`.
- `game-test/lifecycle.test.ts`: 6 tests, all passing. Wiring the outcome
  check into a turn loop is deferred to piece 6 — no turn loop exists yet.
- `game-test/world.ts`: added `Item`/`GroundItem` types and `score` to
  `GameState`, needed for the items piece below.
- `game-test/items.ts`: `pickUp`, `drop`, `drinkPotion`. Contains the two
  bugs planted per the design doc, each on a single marked line: `drop`
  subtracts a scored item's value again instead of leaving score alone,
  and `drinkPotion` doesn't clamp heal to max HP.
- `game-test/items.test.ts`: 4 tests. The 2 legitimate ones pass (partial-HP
  heal, pickup scoring). The 2 `PLANTED BUG` tests assert correct behavior
  and are left failing on purpose — that failure is the proof each bug is
  real (confirmed: overheal to 13 instead of capping at 10; score to 0
  instead of staying at 5). Full suite is 18 pass / 2 expected-fail across
  4 files.
- `game-test/combat.ts`: `resolveAttack` (80% hit chance, 2-6 damage,
  both documented as constants), `isDead`. Dead attacker/defender is a
  no-op rather than an error.
- `game-test/combat.test.ts`: 4 tests (seeded reproducibility, damage
  floor at 0, dead defender takes no further damage, dead attacker can't
  act), all passing.
- `game-test/world.ts`: map representation (grid of floor/wall/exit),
  `Player`/`Monster`/`GameState` types, `generateMap`, `movePlayer`,
  `applyDamage`, `moveMonster`.
- `game-test/world.test.ts`: 7 tests (wall/edge no-op, floor move,
  damage clamping, map generation determinism), all passing.
- Moved `game-scope.md` and `game-checklist.md` into `game-test/` too —
  they're game-specific docs, same reasoning as the code move below.
- Moved `src/rng.ts` into `game-test/rng.ts` and dropped the now-empty
  `src/` — `game-test/` is where the game itself lives (game source next
  to its tests), not a top-level test-only folder.
- `game-test/rng.ts`: seeded PRNG (mulberry32), `next()` and
  `range(min, max)`. Bun installed to `~/.bun` to run it.
- `game-test/rng.test.ts`: 5 tests for the RNG (determinism, seed
  divergence, `next()` bounds, `range()` bounds and boundary values), all
  passing.

### Docs

- `game-checklist.md`: per-piece build checklists (concrete
  functions/tests) for each of the seven pieces in `game-scope.md`.
- `game-scope.md`: split the dungeon-crawler game itself (idea.md's build
  order step 1) into seven separately buildable, concern-separated pieces
  (RNG, world state, combat, items/planted bugs, win/lose, text protocol,
  entry point), with a suggested build order.
- Design doc: rewrote for a human audience, stripped em dashes and
  bold-label rationale formatting, and pulled out code-level specifics
  (function signatures, package names, literal command syntax) now that
  nothing has actually been built yet. Decisions themselves (Bun,
  TypeScript, Gemini 2.5 Flash) are unchanged.
- Design doc: tech stack locked in — Bun runtime, `bun:sqlite`, `commander`
  for the CLI, `@google/genai`. Adapters and the game itself switched from
  Python to TypeScript to match, so the whole repo is one language.
- Design doc: v1 model choice is Gemini 2.5 Flash (free tier, removes model
  quality as a variable while the harness is unproven); local Qwen2.5-Coder
  on the 4050 noted as a later comparison once the loop works.
- Design doc: agent gets no preset action-vocabulary menu — it has to infer
  the interface from in-world signal, so the game must surface its own
  interface (startup banner, "unknown command" on bad input).
- Rewrote the project design doc as a human-readable doc (problem, goals,
  non-goals, how it works, design tradeoffs, data model, build order).

### Added

- `.gitignore`, excluding the local design doc from the repo.
