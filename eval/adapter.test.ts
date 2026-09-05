import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterError, type AdapterExecutor } from "../agent/adapter-contracts";
import { BubblewrapExecutor } from "../agent/adapter-host";
import type { ObservedView } from "../agent/contracts";
import { runScript } from "../agent/runner";
import { Store, type Episode } from "../agent/store";
import { evaluateAdapter } from "./adapter";

const directories: string[] = [];
const stores: Store[] = [];

async function record(commands: string[]): Promise<{ episode: Episode; store: Store }> {
  const directory = await mkdtemp(join(tmpdir(), "greybox-adapter-eval-"));
  directories.push(directory);
  const store = new Store(join(directory, "trace.sqlite"));
  stores.push(store);
  const episode = await runScript({
    store,
    seed: 42,
    commands,
    limits: { responseMs: 1_000 },
  });
  return { episode, store };
}

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

/**
 * A correct hand-written parser for the game's public protocol. It is used both
 * in process, through fake executors, and as adapter source inside Bubblewrap.
 */
function referenceParse(raw: string, previous: any): any {
  const lines = raw.split("\n");
  const statusIndex = lines.findIndex((line: string) => /^HP: -?\d+\/-?\d+  Score: -?\d+$/.test(line));
  if (statusIndex < 0) {
    const view: any = { kind: "error" };
    for (const key of ["hp", "maxHp", "score", "grid", "position", "inventory"]) {
      const prior = previous ? previous[key] : null;
      view[key] = prior && prior.value !== null && prior.source !== "unknown"
        ? { value: prior.value, source: "retained" }
        : { value: null, source: "unknown" };
    }
    return view;
  }

  const status = lines[statusIndex].match(/^HP: (-?\d+)\/(-?\d+)  Score: (-?\d+)$/);
  const carrying = lines[statusIndex + 2].slice("Carrying: ".length);
  const inventory = carrying === "nothing" ? [] : carrying.split(", ");

  let gridEnd = statusIndex - 1;
  while (gridEnd >= 0 && lines[gridEnd] === "") gridEnd--;
  let gridStart = gridEnd;
  while (gridStart >= 0 && /^[#X.!$m@]+$/.test(lines[gridStart])) gridStart--;
  const grid = lines.slice(gridStart + 1, gridEnd + 1);

  let position = { x: 0, y: 0 };
  for (let y = 0; y < grid.length; y++) {
    const x = grid[y].indexOf("@");
    if (x >= 0) position = { x, y };
  }

  const terminal = lines.slice(statusIndex + 3).some((line: string) =>
    line === "You found the exit. You win!" || line === "You have died."
  );
  return {
    kind: terminal ? "terminal" : "state",
    hp: { value: Number(status![1]), source: "observed" },
    maxHp: { value: Number(status![2]), source: "observed" },
    score: { value: Number(status![3]), source: "observed" },
    grid: { value: grid, source: "observed" },
    position: { value: position, source: "observed" },
    inventory: { value: inventory, source: "observed" },
  };
}

const PARSER_SOURCE = `export function parse(raw, previous) {
  const impl = ${referenceParse.toString()};
  return impl(raw, previous);
}`;

function correctExecutor(): AdapterExecutor {
  return { run: async (_source, input) => referenceParse(input.raw, input.previous) as ObservedView };
}

function executorFrom(
  run: (raw: string, previous: ObservedView | null, call: number) => ObservedView,
): AdapterExecutor {
  let call = 0;
  return { run: async (_source, input) => run(input.raw, input.previous, call++) };
}

describe("evaluateAdapter", () => {
  test("scores every field correct for a hand-written parser over a real recorded episode", async () => {
    const { episode } = await record(["north", "north", "take", "drink"]);

    const report = await evaluateAdapter("hand-written", episode, { executor: correctExecutor() });

    expect(report.verified).toBe(true);
    expect(report.episode).toBe(episode.id);
    expect(report.totals.observations).toBeGreaterThan(0);
    expect(report.observations).toHaveLength(report.totals.observations);
    expect(report.totals.accepted).toBe(report.totals.observations);
    expect(report.totals.correctObservations).toBe(report.totals.observations);
    expect(report.totals.failures).toBe(0);
    expect(report.totals.nondeterministic).toBe(0);
    expect(report.totals.fields.incorrect).toBe(0);
    expect(report.totals.fields.unknown).toBe(0);
    expect(report.observations.every(observation => observation.mismatches.length === 0)).toBe(true);
  });

  test("counts a wrong field value as incorrect rather than unknown", async () => {
    const { episode } = await record(["north", "north"]);
    const executor = executorFrom((raw, previous) => {
      const view = referenceParse(raw, previous) as ObservedView;
      view.hp = { value: (view.hp.value ?? 0) + 1, source: "observed" };
      return view;
    });

    const report = await evaluateAdapter("off-by-one", episode, { executor });

    expect(report.verified).toBe(true);
    expect(report.totals.fields.incorrect).toBe(report.totals.observations);
    expect(report.totals.fields.unknown).toBe(0);
    expect(report.totals.correctObservations).toBe(0);
    expect(report.observations[0].fields.hp?.status).toBe("incorrect");
    expect(report.observations[0].mismatches).toEqual([
      expect.objectContaining({
        field: "hp",
        reason: "Field value does not match the public evidence",
      }),
    ]);
  });

  test("counts a reported unknown field as unknown and never as correct", async () => {
    const { episode } = await record(["north", "north"]);
    const executor = executorFrom((raw, previous) => {
      const view = referenceParse(raw, previous) as ObservedView;
      view.hp = { value: null, source: "unknown" };
      return view;
    });

    const report = await evaluateAdapter("unknown-hp", episode, { executor });

    expect(report.verified).toBe(true);
    expect(report.totals.fields.unknown).toBe(report.totals.observations);
    expect(report.totals.fields.incorrect).toBe(0);
    expect(report.totals.correctObservations).toBe(0);
    expect(report.observations[0].fields.hp?.status).toBe("unknown");
    expect(report.observations[0].mismatches).toEqual([
      expect.objectContaining({
        field: "hp",
        reason: "Adapter reported unknown; unknown is not counted as correct",
      }),
    ]);
  });

  test("counts wrong field provenance on an error response as incorrect", async () => {
    const { episode } = await record(["nonsense"]);
    const executor = executorFrom((raw, previous) => {
      const view = referenceParse(raw, previous) as ObservedView;
      if (view.kind !== "error") return view;
      for (const field of ["hp", "maxHp", "score", "grid", "position", "inventory"] as const) {
        if (view[field].source === "retained") {
          (view as any)[field] = { value: view[field].value, source: "observed" };
        }
      }
      return view;
    });

    const report = await evaluateAdapter("wrong-provenance", episode, { executor });

    expect(report.verified).toBe(true);
    const error = report.observations.find(observation => observation.expectedKind === "error");
    expect(error).toBeDefined();
    expect(error!.actualKind).toBe("error");
    expect(error!.correct).toBe(false);
    expect(error!.fields.hp?.status).toBe("incorrect");
    expect(error!.fields.hp?.expected.source).toBe("retained");
    expect(error!.fields.hp?.actual.source).toBe("observed");
    expect(error!.mismatches).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: "hp",
        reason: "Field provenance does not match the public evidence",
      }),
    ]));
    expect(report.observations[0].correct).toBe(true);
  });

  test("rejects nondeterministic output and does not advance the previous view", async () => {
    const { episode } = await record(["wait"]);
    const executor = executorFrom((raw, previous, call) => {
      const view = referenceParse(raw, previous) as ObservedView;
      if (call >= 2) view.score = { value: call, source: "observed" };
      return view;
    });

    const report = await evaluateAdapter("flaky", episode, { executor });

    expect(report.verified).toBe(true);
    expect(report.observations[0].accepted).toBe(true);
    expect(report.observations[0].previousAfterObservation).toBe(0);
    expect(report.observations[1].deterministic).toBe(false);
    expect(report.observations[1].accepted).toBe(false);
    expect(report.observations[1].previousInputObservation).toBe(0);
    expect(report.observations[1].previousAfterObservation).toBe(0);
    expect(report.observations[1].fields).toEqual({});
    expect(report.observations[1].mismatches).toEqual([
      expect.objectContaining({
        field: "adapter",
        reason: "Adapter output or failure mode was nondeterministic",
      }),
    ]);
    expect(report.totals.nondeterministic).toBe(1);
    expect(report.totals.accepted).toBe(1);
  });

  test("counts a throwing adapter as a failure and retains its prior view", async () => {
    const { episode } = await record(["wait", "wait"]);
    const executor = executorFrom(() => {
      throw new AdapterError("loading", "fixture failure");
    });

    const failing = await evaluateAdapter("always-throws", episode, { executor });

    expect(failing.verified).toBe(true);
    expect(failing.totals.failures).toBe(failing.totals.observations);
    expect(failing.totals.accepted).toBe(0);
    expect(failing.observations[0].error).toBe("loading, loading");
    expect(failing.observations[0].mismatches).toEqual([
      expect.objectContaining({
        field: "adapter",
        reason: "Adapter failed; its prior view is retained for the next observation",
      }),
    ]);
    expect(failing.observations.every(observation => observation.previousInputObservation === null)).toBe(true);

    const seen: (number | null)[] = [];
    const partial = executorFrom((raw, previous, call) => {
      seen.push(previous === null ? null : previous.hp.value);
      if (call === 2 || call === 3) throw new AdapterError("runtime", "fixture failure");
      return referenceParse(raw, previous) as ObservedView;
    });

    const retained = await evaluateAdapter("throws-once", episode, { executor: partial });

    expect(retained.verified).toBe(true);
    expect(retained.totals.failures).toBe(1);
    expect(retained.observations[1].error).toBe("runtime, runtime");
    expect(retained.observations[1].accepted).toBe(false);
    expect(retained.observations[2].previousInputObservation).toBe(0);
    expect(retained.observations[2].accepted).toBe(true);
  });

  test("returns the cancellation reason for an aborted signal before and during evaluation", async () => {
    const { episode } = await record(["wait", "wait"]);

    const before = new AbortController();
    before.abort();
    const upfront = await evaluateAdapter("cancelled", episode, {
      executor: correctExecutor(),
      signal: before.signal,
    });
    expect(upfront.verified).toBe(false);
    expect(upfront.reason).toBe("Adapter evaluation cancelled");
    expect(upfront.observations).toEqual([]);

    const during = new AbortController();
    let calls = 0;
    const executor = executorFrom((raw, previous) => {
      if (++calls === 2) during.abort();
      return referenceParse(raw, previous) as ObservedView;
    });
    const midway = await evaluateAdapter("cancelled", episode, { executor, signal: during.signal });

    expect(midway.verified).toBe(false);
    expect(midway.reason).toBe("Adapter evaluation cancelled");
    expect(midway.observations).toEqual([]);
    expect(midway.totals.observations).toBe(0);
    expect(calls).toBe(2);
  });

  test("throws RangeError for a timeout outside the permitted bound", async () => {
    const { episode } = await record([]);
    const executor = correctExecutor();

    for (const timeoutMs of [0, -1, 1_001, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(evaluateAdapter("bounded", episode, { executor, timeoutMs }))
        .rejects.toThrow(RangeError);
    }
  });

  test("refuses to evaluate an episode that fails independent verification", async () => {
    const { episode } = await record(["wait"]);
    episode.config.game.sourceHash = "changed";
    let calls = 0;
    const executor = executorFrom((raw, previous) => {
      calls++;
      return referenceParse(raw, previous) as ObservedView;
    });

    const report = await evaluateAdapter("never-run", episode, { executor });

    expect(report.verified).toBe(false);
    expect(report.reason).toContain("does not match");
    expect(report.observations).toEqual([]);
    expect(report.totals.observations).toBe(0);
    expect(calls).toBe(0);
  });

  test("scores a real parser end to end through the Bubblewrap executor", async () => {
    const { episode } = await record(["north", "nonsense"]);

    const report = await evaluateAdapter(PARSER_SOURCE, episode, {
      executor: new BubblewrapExecutor(),
      timeoutMs: 1_000,
    });

    expect(report.verified).toBe(true);
    expect(report.totals.observations).toBeGreaterThan(2);
    expect(report.totals.accepted).toBe(report.totals.observations);
    expect(report.totals.fields.incorrect).toBe(0);
    expect(report.totals.fields.unknown).toBe(0);
    expect(report.totals.correctObservations).toBe(report.totals.observations);
  }, 60_000);
});
