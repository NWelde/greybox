# Changelog

All notable changes to this project are logged here, newest first. Entries
are grouped as Added, Fixed, or Docs.

## Unreleased

### Added

- Added an `evaluate` command that scores an accepted adapter against a separate
  withheld, independently verified episode prefix, making no model calls.
- Added `eval/adapter.test.ts`: 10 tests covering correct scoring, incorrect and
  unknown fields, provenance mismatches, nondeterminism, adapter failures,
  cancellation, timeout bounds, verification refusal, and real Bubblewrap execution.
- Started opt-in adapter synthesis and hard-failure repair, with isolated
  execution, immutable candidate records, and shared model-call accounting.
- Verified the current implementation with 157 passing tests, only the two
  intentional planted-bug failures, and a successful Bun bundle check.
- Added offline raw-player coverage for both planted findings, natural win,
  bounded failures, provenance, and SQLite model-call persistence/migration.
- Recorded two explicit Gemini 3.6 Flash development runs and independently
  verified their prefixes; provider availability/quota prevented full live acceptance.
- Added the raw Gemini player with bounded context, durable model-call records,
  fixed-invariant candidates, and independent model-free finding verification.
- Added explicit Gemini 3 thinking-level configuration after the live API rejected
  2.5 Flash for this account; model switches are explicit, never automatic retries.
- Added public prompt-delimited game framing, scored-item placement, streaming
  UTF-8 input, and real CLI coverage for both preserved planted bugs.
- Added `agent/main.ts` record/show/replay commands, byte-framed subprocess
  transport, durable SQLite traces, source fingerprints, and model-free replay.
- Added bounded subprocess cleanup, credential-free child environments,
  uncertain-delivery recording, and independent-review regression tests.
- Verified the first batch: 71 tests pass with only the two intentional bug
  failures; final CLI recording and model-free replay match byte-for-byte.

### Fixed

- Bounded runner limits by the values the verifier enforces, rejecting them before
  any episode row is written; `play` could previously record traces `verify` refused.
- Framed the isolated parser's reply with a per-invocation sentinel; stray adapter
  stdout no longer corrupts the reply or misclassifies a correct parser as broken.
- Retained the failing observation in the repair corpus instead of dropping it when
  oversized, and stopped discarding an unhandled hard-failure incident in `maintain`.
- Used `--ro-bind-try` for `/lib64` and awaited the worker stdin write so isolation
  works without `/lib64` and a large payload cannot arrive truncated.

### Docs

- Recorded two bounded live episodes that stopped correctly on HTTP 503 and HTTP
  429 with unknown usage; the second verified independently through observation 1.
  Batch 2 live acceptance remains unachieved.

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

### Fixed

- Fixed a policy-deadline race by cancelling and settling active decision work
  before the runner finalizes model-call and adapter-attempt records.
- Fixed independent verification of score candidates spanning omitted observations
  and of acknowledged prefixes shorter than their planned scripts.
- Preserve provider minimum retry delays: stop when the delay exceeds the bounded
  retry allowance instead of retrying early.
- Release the game's stdin iterator after terminal outcomes so a won game exits
  even when its parent still holds stdin open.

### Docs

- Documented batch 2 operation, explicit model availability override, verified
  live prefixes, and the remaining quota-limited acceptance step in `agent.md`.
- Expanded `CLAUDE.md` into a current continuation guide: architecture authority,
  active milestone, changed files, test commands, live evidence, and pending work.
- `agent.md`: accepted architecture, experiment controls, seven milestones, and
  main-agent ownership with task-based subagent model selection.
- Updated contributor and game docs for the accepted architecture, cumulative
  scoring, and CLI commands; ignored local run artifacts and environment files.
- Added `AGENTS.md` with repository structure, Bun commands, coding and
  testing conventions, and contribution guidance.
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
