# Repository Guidelines

## Project Structure

Read `agent.md` before planning, implementing, or delegating work: it is the
accepted architecture and orchestration guide.

This is a Bun/TypeScript prototype for an agent that discovers and plays a
text-based game. `agent/main.ts` exposes recorded execution, inspection, and
replay; `agent/` holds transport, persistence, and runner code. The dungeon
crawler lives in `game-test/`, with one module
per concern: `world.ts`, `combat.ts`, `items.ts`, `lifecycle.ts`, `protocol.ts`,
and `rng.ts`. Tests sit beside their implementations as `*.test.ts`. Game
design and scope documentation is in `idea.md` and `game-test/*-scope.md` or
`*-checklist.md`.

## Build, Test, and Development Commands

There is no package manifest or build script yet; Bun runs TypeScript directly.

```sh
bun test agent game-test
bun run game-test/main.ts --seed 42
bun run agent/main.ts --help
```

The first command runs both test suites. The second starts a seeded game.
The third lists record/replay commands. `agent.md` includes a runnable example.

## Coding Style & Naming

Use TypeScript with two-space indentation, double-quoted strings, semicolons,
and trailing commas in multiline calls, matching the existing files. Prefer
small, pure functions that accept and return explicit game state. Use
`camelCase` for functions and variables, `PascalCase` for types, and
`UPPER_SNAKE_CASE` for protocol constants. Keep implementation and unit tests
together in their respective module directory; name tests after the behavior
they protect.

## Testing Guidelines

Tests use Bun's built-in `bun:test` (`describe`, `test`, and `expect`). Preserve
determinism by supplying fixed seeds to RNG-dependent tests. The two tests
marked `PLANTED BUG` intentionally fail because they document bugs the agent
is expected to find; do not silently delete or “fix” those tests without
updating the project goal and changelog.

## Commit & Pull Requests

Use short, imperative commit subjects such as `Add protocol smoke test`.
Pull requests should explain the behavior changed, include test commands and
results, and mention any intentional expected failures. Update `CHANGELOG.md`
under `Unreleased` for every change, placing entries in `Added`, `Fixed`, or
`Docs` with newest items first.

## Configuration and Security

Use explicit seeds when reproducing behavior. Do not commit credentials,
local model configuration, generated run data, or adapter output unless the
change specifically requires a fixture.
