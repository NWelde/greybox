# Grey Box

A Bun/TypeScript prototype for testing a text game through its terminal output.
The player uses Gemini to interpret observations and choose commands. Optional
adapter synthesis turns observed examples into a TypeScript parser; hard parser
failures trigger bounded repair attempts.

Every episode records exact output, command delivery, model calls, token usage,
and adapter versions in SQLite. A separate evaluator reproduces commands against
the seeded game and checks bug evidence independently of the model's interpretation.

## Try the reproducible demo

Requires Bun. No packages or API key are needed for this scripted demo. Commands
below run from the repository root.

```sh
bun --no-env-file run agent/main.ts record --db runs/demo.sqlite --seed 42 --commands '["north","north","take","drink"]'
```

Copy the returned episode ID into these commands:

```sh
bun --no-env-file run agent/main.ts verify --db runs/demo.sqlite --episode <episode-id>
bun --no-env-file run agent/main.ts replay --db runs/demo.sqlite --episode <episode-id>
```

The verifier confirms `hp_at_most_max`: drinking a potion at full health produces
13 HP with a maximum of 10. Replay reports `match: true` after comparing startup,
responses, stdout, stderr, and exit. This sequence was rerun and verified on
2026-09-05. It is a scripted reproduction of an intentionally planted bug;
the verifier labels its finding `oracle_scan`. The script completes while the
game is still playing.

The other planted bug decreases cumulative score when a collected coin is
dropped. To reproduce it, record the following sequence with seed 42, then
verify and replay its returned episode ID:

```sh
bun --no-env-file run agent/main.ts record --db runs/demo.sqlite --seed 42 --commands '["south","west","west","west","west","take","nonsense","drop coin"]'
```

This sequence was also verified and replayed on 2026-09-05: cumulative score
fell from 5 to 0, including an error-only observation between pickup and drop.

## Run the model player

Set `GEMINI_API_KEY` or `GOOGLE_API_KEY` locally in `.env`, or supply it through
the environment. `.env.example` documents configuration; `.env` and `runs/`
are ignored by Git. Select a model available to your account explicitly:

```sh
bun run agent/main.ts play --seed 42 --model <model-id> --max-commands 20 --token-budget 100000 --episode-ms 300000 --model-interval-ms 13000
```

For a Gemini 3 model, also pass `--thinking-level low`. The CLI defaults to
Gemini 2.5 Flash if no model is configured. Run `bun --no-env-file run
agent/main.ts --help` for all settings.

After play, use `verify --episode <episode-id>`. Verification can check an
acknowledged prefix after a budget or provider failure. Use `replay` only for
episodes whose status is `complete`; an incomplete prefix is not an exact
complete replay. Unknown provider usage remains unknown and stops further calls.
The token budget controls admission locally, rather than enforcing provider billing.

## Generate and evaluate an adapter

Adapter modes additionally require Linux with Bubblewrap (`bwrap`) installed and
permission to create its isolation namespaces. Add `--adapter-mode frozen` or
`--adapter-mode repair` to `play`. Synthesis starts after ten acknowledged
exchanges by default. Both modes still make a model decision call each turn.

Candidates must load, return valid observable state, and match retained examples
deterministically before activation. Repair responds to hard execution or schema
failures, with at most two candidates per incident. Semantic parsing errors are
measured offline. Adapter subprocesses receive no repository, home directory,
run database, or model credentials.

To evaluate an accepted adapter, record a separate episode with a different seed
and run:

```sh
bun --no-env-file run agent/main.ts evaluate --episode <withheld-episode-id> --adapter-episode <adapter-episode-id>
```

This command independently verifies the target trace and reports observation and
field correctness without model calls. Keep withheld observations out of adapter
authoring. Separate episode IDs alone do not establish an independent benchmark.

## Evidence and remaining work

- The full suite was rerun on 2026-09-05: **161 passing tests and two intentional
  planted-bug failures** across 18 files. Run `bun --no-env-file test agent eval
  game-test`. The suite exits nonzero because the two bug tests assert the
  intended game behavior. Subprocess and Bubblewrap tests need local execution
  permissions.
- Integration tests with mocked model responses confirm both planted bugs,
  complete a natural win, and exercise adapter activation, fallback, and repair.
- Offline adapter evaluation with a mocked model and real Bubblewrap scored
  4/4 observations and 24/24 fields on a separate seed. This small fixture
  demonstrates the evaluation path; it does not establish live generation quality.
- Recorded live runs have demonstrated model-directed commands and independently
  reproducible prefixes. A live-discovered bug, live adapter generation, and
  held-out evaluation of that generated adapter remain to be demonstrated.
  The latest attempt on 2026-09-05 executed one command before HTTP 503; its
  prefix verified independently with no findings.
- Raw/frozen/repair comparisons and total cost savings have not been measured.
  The controlled dungeon crawler is the only target; broader generality and
  iterative learning remain unproven.

## Code map

- `agent/`: transport and framing, SQLite recording, player, model client,
  adapter execution, invariant candidates, and replay.
- `eval/`: independent finding verification and adapter correctness evaluation.
- `game-test/`: seeded dungeon crawler and the two deliberately preserved bugs.
- [agent.md](agent.md): architecture, information boundaries, acceptance criteria,
  and detailed development evidence.
