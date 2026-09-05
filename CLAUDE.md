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

Batch 1 (game contract, recorded execution/replay) and batch 2 (raw player,
verified findings) are implemented and offline-verified. Milestone 5 (first
adapter, including withheld evaluation) is now complete offline; milestone 6
(bounded repair) is implemented and tested. Full live acceptance remains blocked
by provider availability/quota, not by missing implementation. Comparison
benchmarks (milestone 7) remain out of scope until batch 2 live acceptance ends.

Adapter work implemented: shared `model-session.ts` accounting, `adapters.ts`
synthesis/repair lifecycle, public-only `adapter-prompts.ts`, schema 4
attempts/events/call purposes, opt-in `--adapter-mode frozen|repair` (raw stays
the default), Bubblewrap isolation in `adapter-host.ts`/`adapter-worker.ts`, and
recorded request pacing. `bwrap` is installed at `/usr/bin/bwrap`, so the host
tests exercise real isolation rather than a mock.

Completed this session:

- `eval/adapter.test.ts`: 10 tests over the withheld evaluator — correct scoring,
  incorrect vs. unknown fields, provenance mismatch on error frames,
  nondeterminism, adapter failure, cancellation, timeout bounds, verification
  refusal, and a real Bubblewrap end-to-end case. No bug found in `eval/adapter.ts`.
- `agent/main.ts`: read-only `evaluate` command exposing that evaluator. See
  `agent.md` for its shape and the `withheld` flag semantics.
- An independent contract audit of the adapter subsystem; its four findings are
  fixed and recorded in `agent.md` under "Milestone 5 completion and adapter audit",
  along with two accepted known limitations.
- A live acceptance attempt (episode below) that failed on provider availability
  and exposed a runner/verifier limit-bound mismatch, now fixed: the runner
  enforces the verifier's four bounds before writing any episode row.

Validation: `bun --no-env-file test agent eval game-test` reports **161 passing
tests and only the two intentional planted-bug failures** (163 tests, 18 files).
`git diff --check` is clean. No TypeScript type-checker is configured. Preserve
the two intentionally failing `PLANTED BUG` tests — overheal and decreasing
cumulative score. They are the experiment target, not regressions to fix.

Offline adapter evidence (mocked model, real Bubblewrap): an adapter synthesized
and accepted during a seed-42 episode scored 4/4 observations and 24/24 fields on
a withheld seed-7 episode, verified independently before and after. This proves
the evaluation path only. It is not a live result and not a benchmark.

Live evidence in ignored `runs/greybox.sqlite` (unchanged this session):

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
- `43b7b389-6f9b-49e6-86cf-7a2a7f93114e` (2026-09-05, this session): explicit
  3.6 Flash / low thinking, `--model-interval-ms 13000`. One command (`west`,
  913 known tokens), then HTTP 503 with unknown usage; stopped without retry.
  Provider availability, not quota — pacing never reached a rate limit. Recorded
  with `--episode-ms 420000`, which `verify` refuses, so this trace is
  unverifiable; that defect is now fixed but the episode stays unverifiable.
- `9b87ccd2-42f1-4464-9bb2-649dae15bc93` (2026-09-05, this session, retry):
  same settings within enforced limits. One command (`west`, 929 known tokens),
  then HTTP 429; Google reported a free-tier limit of 20 for 3.6 Flash and a
  19.2 s retry delay, so the player stopped instead of shortening it. `verify`
  independently reproduced observations 0-1 and matched the seeded oracle;
  outcome playing, no findings. Verifiable, unlike `43b7b389`.

Next steps:

1. Live acceptance is still the only thing standing between here and batch 3.
   Two attempts this session each reached one command before stopping — HTTP 503
   availability, then HTTP 429 quota. Free-tier request ceilings observed so far
   are five and twenty, so treat the number as variable. Retry when quota resets,
   staying within the enforced limits (`--episode-ms 300000`) and keeping
   `--model-interval-ms 13000`. Then `verify`, and `replay` only if the
   trace is complete. Never automatically retry an unknown-usage call, switch
   models inside an episode, or replay a failed episode without being asked.
2. No live adapter-generation call has been made. A `frozen` or `repair` episode
   costs extra authoring calls on top of policy calls; budget for that against
   the same quota before attempting one.
3. Do not claim a live-discovered bug, a completed live game, adaptation, or cost
   savings. Current live evidence proves bounded model-directed execution and
   reproducible prefixes only. Mocked-model integration tests independently
   confirm both planted bugs and a natural win.

The adapter work was committed and pushed to `origin/main` as `14f50ba`
(`Add adapter synthesis, repair, and withheld evaluation`), on top of `fc157bd`.
The limit-bound fix and this handoff update are not yet in a commit. Preserve user-owned `.env` changes. Never reset or
clean the tree to establish a baseline. Sol workers implemented the Gemini
client, verifier, and persistence tests. Astra identified two verifier issues and
built the adapter lifecycle. This session's subagents wrote the withheld-evaluator
tests, wired `evaluate`, audited the adapter subsystem, and applied the audit
fixes; the main agent owns integration and acceptance. All delegated workers are
closed; there is no active background implementation or live model run to wait for.

## Commands and credentials

```sh
bun --no-env-file test agent eval
bun --no-env-file test agent eval game-test
bun run agent/main.ts play --seed 42 --model gemini-3.6-flash --thinking-level low --max-commands 20 --token-budget 100000 --episode-ms 240000
bun --no-env-file run agent/main.ts verify --episode <id>
bun --no-env-file run agent/main.ts replay --episode <complete-id>
bun --no-env-file run agent/main.ts evaluate --episode <withheld-id> --adapter-episode <source-id>
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
