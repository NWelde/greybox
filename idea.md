# Grey Box

An agent that is handed a game it has never seen, writes its own interface to
that game, plays it, and reports bugs with a deterministic repro.

## Problem

If you want an LLM to play a game (for testing, for fun, for benchmarking),
the usual approach is to hand-write an API for that specific game: a function
that returns structured state, a list of legal moves, maybe a screenshot
encoder. That adapter is bespoke work, done by a human, once per game. It
doesn't transfer, and it doesn't improve.

The interesting question isn't "can an LLM play a game if you build it the
right harness." It's whether the harness-building itself can be delegated.
Can an agent look at the raw, unstructured output of an arbitrary game
process, figure out what the bytes mean, and write its own adapter, one that
gets better the more it plays, so the tenth episode is cheaper than the
first?

That's the bet this project tests. The agent doesn't get an API. It gets a
process, an input stream, and an output stream, and has to build the rest.

## Goals

- Prove the loop: raw output, then the agent reasons over it directly, then
  the agent writes an adapter, then the adapter gets used, then the adapter
  gets cheaper and more accurate over time.
- Make "self-improving" a number, not a vibe. The fraction of turns served by
  the adapter, versus falling back to raw-text reasoning, should rise
  sharply across episodes, and token cost per episode should visibly drop.
- Produce something people can actually try. Not a paper claim: a command
  someone runs, a report file, and a bug with a seed and an action list that
  reproduces it.

## Non-goals (for this version)

- **Pixels or vision.** No screenshots, no GUI games. Text in, text out. The
  parsing problem is already hard in plain text; adding vision is a separate
  project.
- **Proving generality.** This version targets one game, written by me. That's
  a deliberate shortcut: I control the bug set, so I can tell whether the
  loop actually found something or got lucky. Pointing it at a game I didn't
  write, unmodified, is the follow-up that proves the harder claim. Doing
  both at once would mean debugging the loop and judging its output at the
  same time, with no ground truth for either.
- **Playing well.** The agent needs to finish the game and cover its state
  space, not post a high score. Skill is not the thing being measured.
- **A web UI.** A terminal run and a markdown report are enough to show the
  loop working. A dashboard is easy to add once there's something worth
  dashboarding; building it first would mean polishing a claim that isn't
  proven yet.
- **Sandboxing beyond a subprocess call.** The game is mine, so there's
  nothing to sandbox against. Revisit this the moment the target is code I
  didn't write.

## How it works

The game is a small grid dungeon crawler, played entirely over a text input
and output stream: move around, pick up items, fight, track HP and score,
win or lose. It takes a seed, and every run with the same seed and the same
actions produces identical output. Without that, there's no such thing as a
repro, and the whole "here's a bug, here's how to trigger it" claim falls
apart. It also has a couple of bugs planted on purpose, for instance,
drinking a potion at full health overhealing past the cap, or dropping a
scored item sending the score negative. A bug-finder that finds nothing
isn't a demo, so the game has to guarantee there's something to find.

The runner spawns the game as a subprocess and drives it turn by turn. For
the first several turns there's no adapter yet, so the agent reads the raw
terminal output directly and picks an action from it. This is the slow,
expensive path, but it's the one that has to work from turn one, since it's
also the fallback for whenever the fast path breaks.

The agent is never told the action vocabulary. It isn't handed a list of
verbs to pick from, or told what kind of game this is and which commands
tend to work on it. That would pre-solve the exact problem the project
exists to test. It has to infer what it's allowed to do from what the game
shows it, the same way a person sitting down at an unfamiliar terminal
program would. That only works if the game gives it something to reason
from, so the game has to behave like a real hand-written terminal game
would: print a short banner or help line on startup, and respond to
unrecognized input with something like "unknown command." Without that
signal, discovery degenerates into blind guessing into a void, which is slow
and makes for a boring demo, not an interesting one. With it, the agent is
doing genuine inference from in-world signal, closer to a person reading a
man page than to a spec being handed to it.

Once the agent has seen enough raw turns, it writes an adapter: a small
piece of code that turns the raw text into structured state, and a second
piece that lists which actions are legal from that state. From that point
on, the runner calls the adapter instead of asking the agent to re-read raw
text every turn. The agent now reasons over clean structured state, which is
both cheaper and more reliable. If the adapter fails on some later turn,
because the game printed something the parser didn't anticipate, the runner
falls back to raw text for that turn and asks the agent to write a new
version of the adapter with the failure in hand.

Alongside the adapter, a handful of invariants are checked every turn: plain
predicates like "HP never exceeds max HP" or "score is monotonic within an
episode." When one fires, the runner writes out the seed and the full action
sequence that led there. That file is the bug report, and it can be replayed
from scratch to prove the repro is real.

At the end of a run, the report is a markdown file: what got played, what
broke, the exact commands to reproduce it, and a graph of adapter-hit-rate
across episodes. That graph is the whole pitch in one picture. It should
start near zero and climb.

## Design decisions and tradeoffs

The agent writes invariants only as fixed predicates, not open-ended checks,
in this version. The interesting "self-improving" claim lives in the
adapter, since that's the piece whose cost and accuracy visibly change over
time. Having the agent also author the invariants is a reasonable next step,
but it adds a second axis of "is this judgment correct" without adding much
to the core proof. Writing three predicates by hand keeps the bug-finding
half of the demo solid while the adapter half is still being proven out.

Adapter repair is dumb on purpose. The tempting version of repair detects
when an adapter returns state that's plausible but wrong: it parses without
failing, but silently drifts from what the raw text actually says. Building
that well means either a second model call to cross-check every turn
(expensive, undermining the whole point of having an adapter) or a pile of
heuristics that's really its own research problem. The version here only
repairs on a hard failure. That's a much narrower, well-defined signal, and
it's enough to demonstrate that the agent notices its own tool broke and
fixes it, without taking on open-ended anomaly detection first.

Every step gets stored, because replay only works if the exact turn-by-turn
history is sitting somewhere. Storing every step (raw output, parsed state,
action taken, which path produced it) also happens to be exactly the data
the hit-rate graph and the report are built from, so it's not overhead on
top of the core loop. It's the same write, read twice.

It stays CLI-only for this version. A web UI would make the project easier
to show off, but everything it would need (the episode trace, the hit-rate
numbers, the findings) already lives in the stored run data once the CLI
version works. The UI would be a rendering layer on top of finished data,
not a dependency of the loop itself. Building it before the loop is proven
would mean designing screens for a story that might still change shape.

The model is Gemini 2.5 Flash. The two hardest tasks in this loop, inferring
an unlabeled command vocabulary from ambiguous banner text, and writing a
correct adapter, need real reasoning and code-writing ability, not just chat
competence. A small local model is capable enough to run on this machine's
hardware, but shaky enough at either task that a noisy hit-rate graph could
just as easily mean the model got confused as mean the loop design has a
problem, exactly the ambiguity to avoid while the harness itself is still
unproven. Gemini 2.5 Flash is free within its daily quota, needs no local
setup, and is strong enough that model quality stops being a variable.
Swapping in a local model later is a cheap follow-up once the loop is
proven, and a more interesting one then, since it becomes a comparison
against a working baseline instead of a leap of faith.

The main language is TypeScript, running on Bun rather than Node, since Bun
covers storage and subprocess handling out of the box without pulling in
separate libraries for either. The game, the runner, and the adapters the
agent writes are all the same language, so the whole project is one
toolchain instead of several. The adapters are TypeScript rather than
Python for the same reason: one language across the project instead of
shelling out to a separate interpreter every time an adapter changes. That's
a reasonable trust boundary for this version, since sandboxing beyond a
subprocess call is already out of scope. The game is mine, the adapters are
generated locally, and nothing here is untrusted enough to need isolation.

## Data model

- **Game**: name, launch command, seed flag.
- **Adapter**: game, version number, source code, the failure that caused it
  to be written.
- **Episode**: game, seed, adapter version used, outcome (win, lose, or
  timeout), token cost, turn count.
- **Step**: episode, turn index, raw output, parsed state, action taken,
  whether the adapter or the fallback produced the state.
- **Invariant**: game, name, source code.
- **Finding**: the invariant that fired, the episode, the seed, the action
  sequence to reproduce it.

Everything lives in one file. Every step gets stored, which is what makes
replay free.

## Build order

1. The game itself: seed flag, planted bugs.
2. Runner: spawn the game, feed it actions, capture output, store every step.
3. Fallback loop: agent reads raw text, picks actions, plays a full episode.
   Slow and ugly, but this alone is already a demo. It proves the game and
   the harness work end to end.
4. Adapter synthesis: the agent writes the parsing and action-listing logic,
   and the runner switches over to calling it.
5. Adapter repair on failure, with no versioning logic beyond keeping each
   attempt as its own file.
6. Invariant checks (hardcoded) and findings.
7. Replay: deterministic re-run of a finding from its seed and action list.
8. Report: transcript summary, findings, the adapter-hit-rate graph.

Steps 1 through 3 alone prove the harness works. Steps 4 through 8 are what
prove the actual claim: that the harness gets cheaper the more it's used.

## Later

- Point it at a game I didn't write, unmodified. This is the real test of
  the generality claim. Everything above only proves the loop works on a
  game whose bugs I already know about.
- Curses and other TUI games, where the observation problem gets much
  harder.
- Pixel games via screenshots.
- Coverage: instrument the game, show which branches the agent actually
  reached.
- Fuzzing: once an adapter exists, run cheap random play at high volume
  between the expensive model-driven episodes.
- A web UI over the stored run data, once the CLI version has something
  worth showing.
