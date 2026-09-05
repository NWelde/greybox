# Project instructions

## Architecture and continuation

Read `agent.md` first: it is the accepted architecture and orchestration guide.
It takes precedence over older ideas and chat summaries. Read `AGENTS.md` for
repository conventions. Do not redesign while implementing unless new evidence
requires it; record material decisions in `agent.md` before dependent changes.

Keep this file current whenever a milestone, blocker, validation result, or next
step changes so Claude can continue without the original chat. Use this existing
`CLAUDE.md`; do not create a competing lowercase `claude.md`.

## Current handoff — 2026-09-05

Batch 1 (game contract and recorded execution/replay) is implemented and verified.
Batch 2 (milestones 3–4: raw Gemini player and independently verified findings)
is implemented and offline-tested; full live acceptance remains blocked by
provider availability/quota, not missing agent-loop implementation.
Do not begin adapters/repair/comparison (milestones 5–7) yet.

Current changes:

- `agent/contracts.ts`, `prompts.ts`, `invariants.ts`, `player.ts`: typed raw
  decisions, field provenance, bounded context/tokens, fixed candidate predicates.
- `agent/gemini.ts`, `config.ts`: direct structured Gemini requests, header-only
  credentials, sanitized responses, bounded reads, cancellation and usage mapping.
- `agent/store.ts`: SQLite schema 3 adds calls, interpretations, invariant results,
  and verification reports. `runner.ts` shares scripted/raw process lifecycle.
- `agent/main.ts`: `play`, `verify`, `record`, `show`, `replay` commands.
- `eval/verify.ts`: model-free subprocess replay plus a separate seeded-state
  oracle; confirms exact candidate evidence and labels oracle-only discoveries.

Final validation: `bun --no-env-file test agent eval game-test` reports **121
passing tests and only the two intentional planted-bug failures** (123 tests,
15 files). The focused player suite passes all 15 tests. Bun's in-memory bundle
check and `git diff --check` passed. No TypeScript type-checker is configured.
Preserve
the two intentionally failing `PLANTED BUG` tests: overheal and decreasing
cumulative score. They are the experiment target, not regressions to fix.

Live evidence in ignored `runs/greybox.sqlite`:

- `24db1520-c6cb-40c3-9aea-7e2a39c3b620`: sandbox network failure, no commands.
- `2dc008c0-71c9-430a-bb27-b752ec8b89d9`: Google rejected 2.5 Flash for this
  account (HTTP 404) and recommended 3.6 Flash. No commands.
- `a246a907-e0af-45de-b23b-7aa79df97209`: explicit 3.6 Flash / low thinking;
  one successful command (`west`, 863 reported tokens), then HTTP 503 with
  unknown usage. Correctly stopped without retry. `verify` reproduced its
  acknowledged prefix through observation 1; no findings. This is NOT a completed
  game or complete exact replay, and unknown usage is NOT zero cost.
- `52132a97-830d-4114-b07b-26c9c0ce8841`: explicit 3.6 Flash / low thinking;
  six commands, 6,638 known tokens, then HTTP 429 with unknown usage. Google
  reported a free-tier request limit of five. Independent verification passed
  through observation 6; outcome still playing, no findings. No more live calls
  were made after this quota failure.

Active work / next steps:

1. Verifier fixes are integrated and tested (12 tests): valid score candidates
   across omitted observations and bounded prefixes with longer planned scripts.
   Gemini thinking-level and SQLite persistence/migration tests also pass.
   Provider retry delays are never shortened; unknown-usage calls are not retried.
2. Full live acceptance is still pending. Run a fresh bounded episode when
   provider availability/quota permits; account for the observed five-request
   free-tier limit (request pacing may need an explicit recorded setting). Then
   `verify` and (only for a complete trace) `replay`. Do not automatically retry
   unknown-usage calls or switch models inside an episode.
3. Do not claim a live-discovered bug or completed game: current live evidence
   proves bounded model-directed execution and reproducible prefixes only.
   Mocked-model integration tests independently confirm both planted bugs and a
   natural win. Finish the batch 2 live acceptance before starting batch 3.

The working tree contains both earlier batch work and current changes, all
uncommitted. Preserve them and user-owned `.gitignore`/`.env` changes. Never reset
or clean the tree to establish a baseline. Sol workers implemented the Gemini
client, verifier, and persistence tests. Astra identified two verifier issues;
the main agent integrated/tested the fixes. Follow-up subagent review hit an
account usage limit; it did not produce a clean full-review sign-off. The main
agent owns integration and acceptance. All delegated workers are closed; there
is no active background implementation or live model run to wait for.

## Commands and credentials

```sh
bun --no-env-file test agent eval
bun --no-env-file test agent eval game-test
bun run agent/main.ts play --seed 42 --model gemini-3.6-flash --thinking-level low --max-commands 20 --token-budget 100000 --episode-ms 240000
bun --no-env-file run agent/main.ts verify --episode <id>
bun --no-env-file run agent/main.ts replay --episode <complete-id>
```

Bun runs TypeScript directly; no package installation is required. `.env` now
exposes `GEMINI_API_KEY` (or `GOOGLE_API_KEY`). Never print/read its secret values
into chat, prompts, traces, or subprocess environments. `play` loads `.env`;
tests, game children, and replay use `--no-env-file`. Default model remains
2.5 Flash for compatibility; use the explicit 3.6 override for this account.
Network/subprocess permission failures may require local execution approval.

## Changelog

Every change made to this repo — by hand or by an agent — gets logged in
`CHANGELOG.md` under the `Unreleased` section, in one of three groups:
`Added`, `Fixed`, or `Docs`. Add a new group only if none of those three fit.
One or two lines per entry, newest at the top of its group. Do this as part
of making the change, not as a separate cleanup pass.
