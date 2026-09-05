# The game: scoped into separate concerns

`idea.md` describes the dungeon crawler in one paragraph, because from the
Grey Box project's point of view it's a single black box: "a process, an
input stream, and an output stream." But building it isn't one task. It's
several concerns that would tangle if written as one file, and tangling them
would make the planted bugs (the whole point of the game) hard to trust,
since a bug that lives in a 300-line switch statement is hard to distinguish
from an accident.

Below is that single black box split into pieces that can be built, tested,
and reasoned about independently. Each one names what it owns, what it
explicitly stays out of, and how it talks to its neighbors.

## 1. Deterministic RNG

Owns: a single seeded pseudo-random source, and nothing else. Every other
piece that needs randomness (map layout, monster placement, loot drops, combat
rolls) pulls from this module instead of calling `Math.random()` directly.

Stays out of: knowing what the randomness is *for*. It doesn't know about
monsters or maps, just `next()` and `range(min, max)`.

Why separate: "same seed and same actions produce identical output" is the
one property the whole project depends on. If it's not isolated in its own
module, it's not a claim you can verify, it's a hope. Build and test this
first, before anything that consumes it exists.

## 2. World state (map, player, entities)

Owns: the grid, what's in each cell, the player's position and HP, monster
positions and HP. Pure state plus pure transition functions: `movePlayer`,
`applyDamage`, and so on. No stdin, no stdout, no strings.

Stays out of: text parsing, text rendering, and win/lose decisions (a
transition can bring HP to 0, but deciding "that ends the episode" belongs to
the piece below).

Why separate: this is the part worth unit-testing directly, in-process,
without spawning a subprocess or parsing text. If movement rules have a bug,
you want to find it here, not by staring at terminal output.

## 3. Combat

Owns: attack resolution between player and monster (hit chance, damage
roll, death). Reads from the RNG module, writes to world state.

Stays out of: item effects. A potion healing HP and a sword's attack roll are
both "numbers changing," but combat is specifically the player-vs-monster
exchange; treating it as one bucket with items invites exactly the kind of
blurry code the overheal/cumulative-score bugs are supposed to be planted
*into* deliberately, not by accident.

## 4. Items and inventory

Owns: pickup, inventory list, and item effects: potions (heal), scored items
(add permanently to cumulative score on pickup; dropping should not change
score). This is also where
the two planted bugs from `idea.md` live:

- drinking a potion at full HP overheals past the cap
- dropping a scored item wrongly removes its value from cumulative score,
  so a normal pickup/drop cycle returns the score to its previous total

Stays out of: combat resolution, map generation.

Why separate, and why the bugs live specifically here: keeping item logic in
its own module means the planted bugs are easy to point at later ("here's
the function, here's the line") instead of buried in a shared state-mutation
path. A bug that's hard to locate in the source is a worse demo than one
that's easy to locate but hard for the *agent* to find through play alone.

## 5. Win/lose and episode lifecycle

Owns: deciding the episode is over (player HP hits 0 = lose, some win
condition is met, e.g., reach the exit tile or clear the floor) and what the
process does at that point: print a final message, exit.

Stays out of: everything about the exit code or subprocess lifecycle that's
the runner's job in the larger project (idea.md's runner spawns the process;
this piece just decides *when* to end and prints one final line).

## 6. Text protocol (the actual interface)

Owns: reading a line from stdin each turn, rendering world state to a
terminal-style text block, the startup banner, and the "unknown command"
response for unrecognized input. A public `> ` line marks every point where
the game is ready for input; with the CLI writer, responses are separated by
the reserved `\n> \n` wire delimiter. A terminal outcome has no following
prompt, and stdout EOF completes that final response.

Stays out of: deciding what the legal verbs are as a fixed enum handed
anywhere else in the codebase in an obvious way. `idea.md` is explicit that
the agent has to infer the vocabulary from in-world signal, the same way a
person would from a banner and error messages. That constraint lives here:
this module's output text is the only thing standing between "genuine
inference" and "blind guessing," so the banner and the help/error text need
to actually be adequate signal (a real short banner, a real "unknown
command" message) without being a spec dump.

Why separate: everything above this layer (world state, combat, items) is
plain data and functions, easy to test directly. This layer is the only
place stdin/stdout, formatting, and command dispatch live. Keeping it as a
thin shell over pieces 1-5 means the game's actual rules can be tested
without spawning a process at all, and the text-protocol layer can be
iterated on (banner wording, error phrasing) without touching game logic.

## 7. Game config / entry point

Owns: the seed flag, wiring the pieces above together, and matching the
"Game" record from idea.md's data model (name, launch command, seed flag).
This is the thin `main()` that the runner actually spawns.

Stays out of: any logic. If this file has an `if` statement that isn't
argument parsing, something above was scoped wrong.

## Suggested build order for this slice

1. RNG (testable alone)
2. World state + transitions (testable alone, using the RNG)
3. Combat (testable alone, using 1 and 2)
4. Items/inventory, including the two planted bugs (testable alone)
5. Win/lose lifecycle (wires 2-4 together)
6. Text protocol (wraps everything in stdin/stdout)
7. Entry point (seed flag, launch command)

This mirrors step 1 of idea.md's own build order ("The game itself: seed
flag, planted bugs") but broken down enough that each piece can be written,
tested, and reviewed on its own before the whole thing has to behave like a
program over a pipe.
