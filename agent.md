# Grey Box: Architecture and Build Guide

This is the accepted architecture and source of truth for Grey Box. Read it
before implementing or delegating work. `idea.md` records the original intent;
where its assumptions differ from this document, follow this document. User
instructions take precedence. Change architectural decisions only when new
evidence or user direction warrants it, and record the reason here.

## Objective and scope

Build a CLI agent that discovers a text game's interface from observations,
generates and repairs a TypeScript adapter, and reports independently verified
bugs with deterministic reproduction commands. Demonstrate correct parsing and
measured cost savings separately; an increasing adapter hit rate alone does
not prove learning. The controlled dungeon crawler is the v1 target. Generality,
vision, a web UI, competitive gameplay, and model-authored invariants are deferred.

Use Bun and TypeScript. SQLite is the authoritative run store. The runtime
player uses Gemini; make its model/settings explicit and record them. Credentials
are supplied locally through `.env`; never print, commit, copy into prompts,
store in traces, or pass them to game/adapter subprocesses. No live model calls
are needed for milestones 1–2.

## Orchestration and model selection

The main Astra agent owns architecture, interfaces, integration, acceptance
decisions, and the final review. Subagents receive bounded assignments and
disjoint file ownership, with this document as their shared contract. They
must preserve other contributors' edits and report changed files and validation.
The main agent reviews and integrates their work; delegation is not acceptance.

Choose from models actually available in the session, based on task risk:

| Assignment | Starting model/effort | Reason |
| --- | --- | --- |
| Architecture, orchestration, ambiguous failures | Astra / high | Cross-component decisions and experimental validity. |
| Bounded implementation and integration tests | Sol / medium or high | Clear contracts with substantive coding and verification. |
| Routine fixtures and mechanical documentation checks | Terra or Luna / medium | Narrow, easily checked work; delegate only if useful. |
| Independent replay/failure or experiment review | Astra / high | High-consequence omissions and adversarial review. |

These are routing preferences, not claims that a model guarantees correctness.
Escalate a task after concrete difficulty; do not maximize effort or spawn agents
by default. State the actual model and scope when delegating. Parallelize only
independent work; do not let separate agents invent incompatible contracts.

Make reasonable assumptions for routine implementation choices when they do
not change observable behavior, acceptance criteria, or project direction.
Settle material departures before doing dependent work. Complete each authorized
batch, including tests and fixes, and hand off concrete evidence at its boundary.
Do not continually redesign while coding.

## Development baseline and game contract

At discovery, the game ran but `agent/main.ts` was non-executable pseudocode.
The suite had 34 passing tests and two intentionally failing planted-bug tests.
Those failures are an explicit baseline, not permission to ignore new failures.

Decisions accepted from the discovery review:

- Emit a public `> ` prompt line whenever the game is ready for an input line.
  The wire delimiter is `\n> \n`; final output is completed by stdout EOF.
  This is disclosed transport assistance, not an action vocabulary or state API.
  The marker is reserved and must not appear as an ordinary output line.
- Spawn a scored item as well as a potion, making both planted bugs reachable.
- Score is cumulative collected score and should not decrease on drop. The
  planted bug decreases score on drop; normal pickup/drop cycles do not make it
  negative. Preserve the planted faulty behavior and correct misleading docs.
- Monsters currently move without attacking the player. Player death is not
  reachable in normal play; richer combat is not part of this batch.
- Unknown commands produce an error-only observation. `look` is unknown.
  Count all command attempts, even those that do not advance the game state.
- Rendered text does not expose all internal state. Never require adapters to
  reconstruct hidden monster HP or occluded objects. Vocabulary discoverability
  from the atmospheric banner remains an experimental limitation to measure.

## Components and information boundaries

| Component | Owns |
| --- | --- |
| Transport | Process lifecycle, one-command exchange, byte framing, stderr, exit. |
| Runner | State machine, budgets, recording, stop reasons, cleanup. |
| Model client | Raw/structured policy decisions and adapter authoring calls. |
| Adapter host | Bounded execution, schema validation, immutable versions. |
| Invariant checker | Fixed predicates and candidate findings. |
| Replay/evaluator | Model-free reproduction and independent correctness checks. |
| Reporter | Evidence derived from stored runs, including failures and costs. |

Development agents may inspect the repository. Runtime player and adapter-author
calls start with clean, deliberately restricted context: public observations,
their own interaction history, task, and interface contract only. Never include
game source, command enums, planted-bug tests, this guide, or evaluator results.
Do not expose filesystem or shell tools to the runtime player.

The evaluator may use game internals but cannot feed oracle data into the player
or adapter repair. Generated code must not read game source or evaluator data;
prevent or audit such access before claiming experimental isolation. A separate
process provides crash/timeout containment, not a security sandbox. Hardened
execution of arbitrary untrusted code is not a v1 claim.

## Episode state machine

Startup produces observation O0. Exact command At produces response Ot+1.
Only one game command may be outstanding. Persist command intent before sending.

| State | Operation and transition |
| --- | --- |
| Start | Record configuration and seed; spawn the game; enter Receive. |
| Receive | Assemble a prompt-delimited response or final EOF response. |
| Represent | Run active adapter on observation and previous observable view. |
| Decide | Model selects one command using the structured view. |
| Fallback | On absent/broken adapter, one model call returns view and command. |
| Check | Check supported invariants and termination; skip another policy call at exit. |
| Record | Commit observation, provenance, usage, and candidate findings. |
| Maintain | If scheduled, attempt synthesis/repair; activate only for subsequent observations. |
| Send | Persist intent, send exactly one newline-terminated command, then Receive. |
| Finish | Drain streams, close/terminate child, record outcome and stop reason. |

Milestone 2 substitutes scripted commands for policy decisions. Both eventual
policy modes use one model decision call per normal turn: raw mode returns its
interpretation and action together, structured mode consumes the adapter output.
Adapter hits do not imply model-free actions or guaranteed cost reduction.

Keep game outcome separate from runner stop reason. Budget exhaustion, model
failure, cancellation, unexpected exit, and a game win are different results.

## Observable state and adapter contract

Represent visible grid/player position, observed HP/max HP/score/inventory,
response kind, field provenance, and candidate command strings. Fields may be
fresh, retained, or unknown. A partial error response is not a fresh state dump.
Missing evidence makes an invariant unevaluated, not passed.

Validate shape, finite numbers, and bounded output. Do not reject overheal or
decreasing score: these are findings, not parse errors. Candidate actions are
suggestions; the policy may explore outside them. Do not inject private enums.

Provisional synthesis schedule: after ten exchanges, author a candidate from a
bounded sample of successes and errors. Store every candidate and parent/cause,
including rejected attempts. Check loading, determinism, schema, and previously
observed examples before activation. Repair only on hard failures: exceptions,
timeouts, loading errors, or malformed output. Use fallback for the affected
turn and cap repairs at two attempts per incident. Schema-valid semantic drift
is evaluated offline and does not trigger online repair in v1.

## Persistence and reproduction

One SQLite database stores authoritative records. Add tables when their milestone
needs them; do not build the entire future schema before the recorded runner.

| Record | Required information |
| --- | --- |
| Run | Actual game-file fingerprint, runtime version, model/settings and prompt versions, budgets, experimental condition. |
| Episode | Run, seed, starting adapter, timestamps, outcome and stop reason. |
| Observation | Sequence, exact stdout bytes, interpretation, field provenance, adapter and fallback cause. |
| Command | Exact line, preceding observation, persisted intent, delivery/result status. |
| Model call | Purpose, request/response, provider usage, retries, latency/error; no credentials. |
| Adapter | Source/hash, parent, cause, validation and activation. |
| Finding | Versioned predicate, evidence, evaluation status, independent replay result. |

Store raw bytes, not pipe-chunk boundaries. Retain stderr separately. Materialized
adapter files are execution copies, not competing authoritative records.
A crash around command delivery leaves an indeterminate attempt: never blindly
resume or resend it. Reproduction starts a fresh process from the seed.

Replay uses exact commands (including invalid input), the same source fingerprint,
runtime, seed, and framing contract, with no model calls. Compare startup and
each response byte-for-byte and report the first mismatch. Refuse to claim an
exact replay when source/runtime changed or the trace is incomplete. Replay a
finding's prefix and check the predicate independently of the generated parser.

## Limits and verification

Provisional defaults: 200 command attempts, 5 seconds for startup/game response,
60 seconds per model request, 1 second per adapter call, two repair attempts per
incident, and a total episode deadline (5 minutes for scripted runs). Model runs
also require a token budget. Record defaults/overrides; freeze them before evals.
Never resend a game action after timeout. Drain stdout/stderr concurrently and
terminate the child on bounded cleanup. Support fragmented markers, coalesced
writes, split UTF-8, final output, and output-size limits. Game and adapter children
receive a minimal environment, never inherited Gemini credentials or `.env`.

Mock model, transport, clock, and adapter execution for runner tests. Use real
temporary SQLite databases and real subprocess integration tests for framing,
termination, replay, and planted-bug reachability. Run proportional validation;
do not repeat broad checks without changes, failures, or unresolved risk.

## Experimental validity and evidence

Compare raw-only, first-adapter-frozen, and hard-failure-repair conditions using
the same policy model, task, history budget, limits, and predetermined evaluation
seeds. Keep development and evaluation seeds disjoint. Reset policy history each
episode and define any other persistent memory explicitly. Since live policies
diverge, also evaluate parsers on a fixed withheld transcript corpus. Never feed
withheld answers into repair. Repeat live comparisons to expose model variance.

Report separately:

- Adapter acceptance: accepted interpretations / all complete observations.
- Verified correctness: oracle-correct interpretations / evaluated adapter
  interpretations, with sample size, coverage, and field provenance.
- Fallback rate: observations requiring model interpretation / complete observations.
- Total usage/cost: policy, synthesis, repair, retries, cache and reasoning usage
  when reported; preserve unknown usage as unknown rather than zero.
- Task performance: outcomes, valid-action rate, repeated observations, visited
  positions, distinct interactions, confirmed findings and replay success.
- Economic result: cumulative cost at comparable task performance, including
  acquisition overhead. Structured JSON may cost more than the small raw display.

Threats/controls: reject plausible constant parsers with independent ground truth;
control seed difficulty and conversation memory; count failed/early-ended episodes;
measure stuck policies; prove CLI bug reachability; define score semantics; hash
actual files including uncommitted edits; keep all oracle/source data isolated.
Renamed commands with usable in-game clues are a separate discoverability experiment.

A credible demo needs a clean runtime transcript, completed recorded episode,
exact replay, independently verified discovered bug, generated adapter working
on unseen observations, bounded repair evidence, and fully accounted cost results.
If a frozen adapter performs equally well, claim interface synthesis; iterative
improvement remains unproven. Generality requires future games.

## Milestones and batch boundaries

1. **Game contract.** Public framing, scored-item spawn, accurate cumulative-score
   docs; preserve planted bugs. Files: `game-test/protocol.ts`, `world.ts`, tests
   and scope docs. Done: both bugs reproduced through CLI; startup/error/action/exit
   framing tested. Dependency: accepted contract above. Excludes richer combat.
2. **Recorded execution/replay.** Files: `agent/transport.ts`, `store.ts`,
   `runner.ts`, `replay.ts`, `main.ts`, tests. Done: durable scripted run and exact
   replay, mismatch/fingerprint rejection, fragmented-output, timeout, early-exit,
   cleanup and uncertain-delivery tests. Depends on 1. Excludes models/adapters.
3. **Raw player.** Files: model client, prompts, runner and configuration. Done:
   bounded live model episodes, replayable commands, accounted calls and mocked
   transitions. Depends on 2. Excludes adaptation and cost-reduction claims.
4. **Verified findings.** Files: invariant/finding modules and separate `eval/`
   verifier. Done: positive bugs, negative controls, fabricated-parse rejection.
   Depends on 2–3. Excludes generated invariants and trace minimization.
5. **First adapter.** Files: adapter author/host/contracts. Done: immutable candidate,
   bounded execution, validation, activation, withheld observable-state evaluation.
   Depends on 3–4. Excludes online repair and semantic-drift detection.
6. **Bounded repair.** Files: adapters, runner, prompts, regression fixtures. Done:
   hard failure falls back; candidate passes old observations or budget expires
   cleanly. Depends on 5. Excludes oracle-driven repairs and arbitrary self-editing.
7. **Comparison/report.** Files: `eval/` benchmark/config and reporter. Done: three
   conditions on predetermined seeds, all costs reconciled, failures and verified
   findings reported. Depends on 4–6. Excludes dashboards and generality claims.

Build/review in three batches: **1–2**, **3–4**, then **5–7**. Finish and demonstrate
each batch before beginning the next. The main agent owns integration throughout.
Update `CHANGELOG.md` under `Unreleased` as changes are made. Keep local run data
and credentials ignored. Record architectural changes here before dependent code.
Maintain `CLAUDE.md` as the current continuation checkpoint: changed components,
validation evidence, blockers, and next steps. It points here for architecture;
it must not become a competing design or a second lowercase `claude.md`.

## Running the first batch

No package installation or API calls are required for recorded execution:

```sh
bun run agent/main.ts record --seed 42 --commands '["north","north","take","drink"]'
bun run agent/main.ts show --episode <returned-id>
bun run agent/main.ts replay --episode <returned-id>
bun test agent game-test
```

The default database is `runs/greybox.sqlite` (ignored). `--db` selects another
file. Each recording gets a new ID; existing episodes are preserved. `record`
and `replay` return nonzero on failure. The `show` command displays saved evidence.
An intentionally ended script is not a game win: `script_complete` and
`game_exit` are distinct, and milestone 2 does not infer win/lose from private
game logic. The remaining two `PLANTED BUG` failures are expected in the full
suite; new failures are not. Some sandboxes deny writes to child-process stdin;
run integration tests with the required local-process permission.

Batch 1 implementation decisions: preserve exact bytes and explicit empty EOF
after closing input; an empty EOF in response to a command is indeterminate.
Reject unsolicited output, never resend uncertain commands, and recheck budget
and cancellation after intent persistence before sending. Capture exit signals
separately from exit codes. SQLite schema versions are explicit; completed runs
are checked against actual source/runtime/framing fingerprints before replay.

Batch 1 status (2026-09-05): implemented and verified. `bun --no-env-file test
agent game-test` reports 71 passing tests and only the two intentional planted-bug
failures. A CLI recording of seed 42 with `north`, `north`, `take`, `drink` reproduced
overheal and replayed byte-for-byte. Live-stdin win termination, uncertain delivery,
unsolicited output, source mismatches, deadlines, and child cleanup have regression
coverage. Sol implemented the game contract; Astra independently reviewed failure
handling; the main agent integrated the fixes and completed final validation.
At the batch 1 checkpoint no Gemini calls had been made. Batch 2 progress follows.

## Batch 2 implementation contract

The raw player uses one Gemini decision call per prompt observation, returning
an observable view, an exact command (or null to stop), and bounded working
memory. Each field records observed/retained/unknown provenance. It receives
public output and its own recent actions only, never evaluator results. Terminal
EOF observations are recorded without another policy call and checked offline.

Gemini 2.5 Flash remains the default; explicit configuration may override it.
Use the documented HTTPS generateContent API directly through Bun fetch; no SDK
is needed for the single JSON request contract. Record model settings, prompt
version/hash, every call intent/result/retry, and provider token usage. Missing
usage stays unknown and stops further calls; timeouts are not retried because
their billing/outcome is uncertain. Retry only bounded explicit transient HTTP
failures and account for every attempt. No automatic model/key rotation.

Token control is an admission budget: before each request reserve a conservative
UTF-8 input-byte bound plus the output allowance; reconcile provider-reported
usage afterward. It is not a provider-enforced spending limit. Cap history and
memory, record those settings, and stop when the next request cannot fit.

Keep the shared transport lifecycle for scripted and model-directed episodes.
Budget-stopped episodes remain incomplete; their acknowledged prefixes may still
be verified, but must not be advertised as an exact complete replay. The verifier
independently replays those prefixes through the real subprocess and through
game-state transitions, compares public output, then checks fixed predicates.
Privileged oracle checks run only after play and never inform policy decisions.
Distinguish policy-reported candidates from findings first detected by oracle
scanning; reject fabricated interpretations instead of confirming them by reuse.

Live-validation exception (2026-09-05): Google's API rejected 2.5 Flash for this
account with HTTP 404 and recommended `gemini-3.6-flash`. Use an explicit model
override for development validation; do not silently change a running condition
or automatically fall back. Gemini 3 supports `thinkingLevel`; provide an explicit
`--thinking-level low` instead of the numeric 2.5 thinking budget. Store the actual
choice and use the same model/settings across future comparison conditions.
This is an availability-driven configuration change, not a new agent design.
See Google's [thinking configuration](https://ai.google.dev/gemini-api/docs/generate-content/thinking).

## Running and continuing batch 2

Set `GEMINI_API_KEY=your-key` locally in `.env`; an `API KEY` label is not an
environment-variable name. `GOOGLE_API_KEY` is also supported. Do not paste keys
into chat or pass them as CLI arguments. `.env.example` contains no credentials.

```sh
bun run agent/main.ts play --seed 42 --model gemini-3.6-flash --thinking-level low --max-commands 20 --token-budget 100000 --episode-ms 240000
bun --no-env-file run agent/main.ts verify --episode <returned-id>
bun --no-env-file run agent/main.ts replay --episode <complete-id>
bun --no-env-file test agent eval game-test
```

`play` persists every request before dispatch, sanitizes provider responses,
records token components without double-counting the total, and stops on unknown
usage. HTTP errors, timeouts, invalid decisions and budget stops leave explicit
incomplete records. Known-usage transient retries are bounded; a requested retry
delay over ten seconds stops the episode instead of being shortened. SQLite
schema 3 preserves earlier schema 2 traces and adds model/interpretation/finding
records. `verify` persists its independent report; it never calls a model.

Batch 2 status (2026-09-05): raw player and verifier implemented, offline coverage
complete; full live acceptance remains pending provider availability/quota.
The final offline suite reports 121 passes and only the two intentional failures
across 123 tests in 15 files. The Bun bundle check passes; no standalone TypeScript
type-checker is configured.
The model-mocked integration tests reach both planted bugs, independently confirm
their evidence, complete a natural win, and exactly replay completed traces.
Negative controls reject fabricated model evidence. Coverage includes unknown
usage, bounded retries, cancellation, deadlines, provenance, fresh-episode memory,
credential-free child processes, and SQLite reopen/migration.

Live development evidence (not a benchmark or proof of learning):

- Episode `a246a907-e0af-45de-b23b-7aa79df97209`: one command, 863 known tokens,
  then HTTP 503 with unknown usage. Independent prefix verification passed.
- Episode `52132a97-830d-4114-b07b-26c9c0ce8841`: six commands, 6,638 known
  tokens, then HTTP 429; provider reported a free-tier request limit of five.
  Independent verification passed through observation 6. No findings or win.
- Both used explicit 3.6 Flash / low thinking. Unknown failed-call usage remains
  unknown. The earlier 2.5 availability failure and sandbox failure are retained.

Do not claim a completed live game, live-discovered bug, adaptation, or cost
savings from these runs. Before batch 3, finish a bounded live acceptance run
within available provider quota, verify its evidence, and replay it if complete.
Keep development seed 42 separate from later held-out evaluation seeds. Consult
`CLAUDE.md` for the latest test results and remaining work.
