import { afterEach, expect, test } from "bun:test";
import { AdapterError, type AdapterExecutor, type AdapterMode } from "./adapter-contracts";
import { BubblewrapExecutor } from "./adapter-host";
import type { ModelClient, ModelReply, ModelRequest, ObservedView } from "./contracts";
import { runPlayer } from "./player";
import { replay } from "./replay";
import { Store } from "./store";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function view(raw: string): ObservedView {
  const hp = raw.match(/HP: (\d+)\/(\d+)/);
  const score = raw.match(/Score: (-?\d+)/);
  const fact = (value?: string) => value === undefined ? { value: null, source: "unknown" as const }
    : { value: Number(value), source: "observed" as const };
  return { kind: hp ? "state" : "error", hp: fact(hp?.[1]), maxHp: fact(hp?.[2]), score: fact(score?.[1]),
    grid: { value: null, source: "unknown" }, position: { value: null, source: "unknown" }, inventory: { value: null, source: "unknown" } };
}
function response(value: unknown): ModelReply {
  const text = JSON.stringify(value);
  return { text, response: { text }, modelVersion: "fixture", finishReason: "STOP",
    usage: { promptTokens: 50, outputTokens: 30, thinkingTokens: 20, totalTokens: 100, cachedTokens: 0 } };
}

function setup(options: { commands?: (string | null)[]; sources?: string[]; mode?: AdapterMode; failRepairs?: boolean; nondeterministic?: boolean } = {}) {
  const store = new Store(":memory:"); stores.push(store);
  const requests: ModelRequest[] = [];
  const commands = options.commands ?? ["wait", "nonsense", "wait", null];
  const sources = options.sources ?? ["first", "fixed"];
  let policyCalls = 0, authors = 0, parses = 0;
  const client: ModelClient = { generate: async request => {
    requests.push(request);
    if (request.purpose?.startsWith("adapter_")) return response({ source: sources[authors++] ?? "bad" });
    const command = commands[policyCalls++];
    if (command === undefined) throw new Error("Unexpected policy call");
    if (request.purpose === "structured_decision") return response({ command, memory: "explore" });
    return response({ view: view(JSON.parse(request.input).currentObservation), command, memory: "explore" });
  } };
  const executor: AdapterExecutor = { run: async (source, input) => {
    parses++;
    if (source === "bad" || options.failRepairs && source === "fixed") throw new AdapterError("loading", "fixture failure");
    if (source === "first" && input.raw.includes("I don't understand")) throw new AdapterError("runtime", "unsupported format");
    const result = view(input.raw);
    if (options.nondeterministic) result.hp.value = parses % 2 ? 10 : 11;
    return result;
  } };
  return { store, requests, client, executor, mode: options.mode ?? "repair" };
}

test("synthesis activates only next turn; hard failure falls back and bounded repair activates", async () => {
  const fixture = setup();
  const episode = await runPlayer({ ...fixture, seed: 42,
    adapters: { mode: fixture.mode, executor: fixture.executor, synthesizeAfter: 1 } });
  expect(episode.status).toBe("complete");
  expect(episode.config.condition).toBe("repair");
  expect(episode.adapters.map(adapter => [adapter.cause, adapter.status, adapter.activationObservation])).toEqual([
    ["synthesis", "accepted", 2], ["repair", "accepted", 3],
  ]);
  expect(episode.adapters[1].parent).toBe(episode.adapters[0].id);
  expect(episode.adapters[0].sourceHash).toHaveLength(64);
  expect(episode.calls.map(call => call.purpose)).toEqual([
    "raw_decision", "raw_decision", "adapter_synthesis", "raw_decision", "adapter_repair", "structured_decision",
  ]);
  expect(episode.adapterEvents.filter(event => event.kind === "hit").map(event => event.observation)).toEqual([3]);
  expect(episode.adapterEvents.filter(event => event.kind === "fallback").map(event => event.observation)).toEqual([0, 1, 2]);
  expect(episode.calls.reduce((sum, call) => sum + call.usage.totalTokens!, 0)).toBe(600);
  expect(episode.commands.map(command => command.text)).toEqual(["wait", "nonsense", "wait"]);
  expect((await replay(episode)).match).toBe(true);
});

test("frozen condition never repairs a hard failure", async () => {
  const fixture = setup({ mode: "frozen" });
  const episode = await runPlayer({ ...fixture, seed: 42, adapters: { mode: "frozen", executor: fixture.executor, synthesizeAfter: 1 } });
  expect(episode.status).toBe("complete");
  expect(episode.adapters).toHaveLength(1);
  expect(episode.calls.filter(call => call.purpose === "adapter_repair")).toHaveLength(0);
  expect(episode.calls.at(-1)?.purpose).toBe("raw_decision");
});

test("two failed repairs disable the adapter without repeatedly authoring on later turns", async () => {
  const fixture = setup({ sources: ["first", "bad", "bad"], commands: ["wait", "nonsense", "wait", "wait", null] });
  const episode = await runPlayer({ ...fixture, seed: 42, adapters: { mode: "repair", executor: fixture.executor, synthesizeAfter: 1 } });
  expect(episode.status).toBe("complete");
  expect(episode.adapters.map(adapter => adapter.status)).toEqual(["accepted", "rejected", "rejected"]);
  expect(episode.adapters.slice(1).map(adapter => adapter.attempt)).toEqual([0, 1]);
  expect(episode.calls.filter(call => call.purpose === "adapter_repair")).toHaveLength(2);
  expect(episode.calls.at(-1)?.purpose).toBe("raw_decision");
});

test("rejected initial synthesis is not silently retried every turn", async () => {
  const fixture = setup({ sources: ["bad"], commands: ["wait", "wait", "wait", null] });
  const episode = await runPlayer({ ...fixture, seed: 42, adapters: { mode: "repair", executor: fixture.executor, synthesizeAfter: 1 } });
  expect(episode.adapters).toHaveLength(1);
  expect(episode.adapters[0].status).toBe("rejected");
  expect(episode.adapterEvents.some(event => event.kind === "hit")).toBe(false);
});

test("nondeterministic candidates never activate", async () => {
  const fixture = setup({ nondeterministic: true });
  const episode = await runPlayer({ ...fixture, seed: 42, adapters: { mode: "repair", executor: fixture.executor, synthesizeAfter: 1 } });
  expect(episode.adapters[0].error).toBe("nondeterministic");
  expect(episode.adapters[0].status).toBe("rejected");
});

test("structured policies never receive current raw output and authoring gets no oracle/source context", async () => {
  const fixture = setup({ sources: ["fixed"], commands: ["wait", "wait", "wait", null] });
  const episode = await runPlayer({ ...fixture, seed: 42, adapters: { mode: "repair", executor: fixture.executor, synthesizeAfter: 1 } });
  const structured = fixture.requests.filter(request => request.purpose === "structured_decision");
  expect(structured).toHaveLength(2);
  expect(JSON.parse(structured[0].input).currentObservation).toEqual(view(episode.observations[2].raw.toString()));
  expect(JSON.parse(structured[1].input).recentInteractions.at(-1).observation).toBe(JSON.stringify(view(episode.observations[2].raw.toString())));
  const author = JSON.parse(fixture.requests.find(request => request.purpose === "adapter_synthesis")!.input);
  expect(Object.keys(author)).toEqual(["interface", "viewSchema", "examples", "parentSource", "failure"]);
  expect(Object.keys(author.examples[0])).toEqual(["raw", "previous", "expected"]);
  expect(author.parentSource).toBeNull();
  expect(JSON.stringify(author)).not.toContain("PLANTED BUG");
  expect(JSON.stringify(author)).not.toContain("hp_at_most_max");
});

test("schema-valid semantic drift does not trigger online repairs", async () => {
  const fixture = setup({ sources: ["fixed"], commands: ["wait", "wait", "wait", null] });
  let count = 0;
  const executor: AdapterExecutor = { run: async (_, input) => {
    // Two examples checked twice during acquisition; drift begins at first unseen input.
    const parsed = view(input.raw); if (++count > 4) parsed.score.value = 99; return parsed;
  } };
  const episode = await runPlayer({ ...fixture, seed: 42, adapters: { mode: "repair", executor, synthesizeAfter: 1 } });
  expect(episode.adapters).toHaveLength(1);
  expect(episode.adapterEvents.filter(event => event.kind === "hit")).toHaveLength(2);
  expect(episode.interpretations.at(-1)?.view.score.value).toBe(99);
  expect(episode.calls.some(call => call.purpose === "adapter_repair")).toBe(false);
});

test("acquisition shares the token budget and pending attempts remain visible", async () => {
  const fixture = setup({ commands: ["wait", "wait", null] });
  const episode = await runPlayer({ ...fixture, seed: 42, tokenBudget: 10_000,
    adapters: { mode: "repair", executor: fixture.executor, synthesizeAfter: 1 } });
  expect(episode.stopReason).toBe("token_limit");
  expect(episode.adapters).toHaveLength(1);
  expect(episode.adapters[0].status).toBe("indeterminate");
  expect(episode.calls.map(call => call.purpose)).toEqual(["raw_decision", "raw_decision"]);
  expect(episode.commands).toHaveLength(1);
});

test("corpus is bounded and no generation occurs at a deliberate stop", async () => {
  const fixture = setup({ sources: ["fixed"], commands: ["wait", "wait", "wait", null] });
  const episode = await runPlayer({ ...fixture, seed: 42,
    adapters: { mode: "repair", executor: fixture.executor, synthesizeAfter: 2, maxExamples: 1 } });
  const author = fixture.requests.find(request => request.purpose === "adapter_synthesis")!;
  expect(JSON.parse(author.input).examples).toHaveLength(1);
  expect(episode.adapters[0].observation).toBe(2);
  const stop = setup({ commands: ["wait", null] });
  const stopped = await runPlayer({ ...stop, seed: 42, adapters: { mode: "repair", executor: stop.executor, synthesizeAfter: 1 } });
  expect(stopped.adapters).toHaveLength(0);
});

test("an oversized failing observation is truncated into the repair corpus, never dropped", async () => {
  const fixture = setup({ commands: ["wait", "wait", "wait", null] });
  // Fail the third parse, so the incident lands on a full-size observation.
  let parses = 0;
  const executor: AdapterExecutor = { run: async (source, input) => {
    if (source === "first" && ++parses > 2) throw new AdapterError("runtime", "unsupported format");
    return view(input.raw);
  } };
  // Below one serialized example, so the old byte guard dropped the incident and
  // left the repair corpus with nothing but the failure code.
  const episode = await runPlayer({ ...fixture, seed: 42,
    adapters: { mode: "repair", executor, synthesizeAfter: 1, maxExampleBytes: 713 } });
  expect(episode.calls.filter(call => call.purpose === "adapter_repair")).toHaveLength(1);
  expect(episode.adapters.map(adapter => adapter.cause)).toEqual(["synthesis", "repair"]);
  const repair = JSON.parse(fixture.requests.find(request => request.purpose === "adapter_repair")!.input);
  const failing = episode.observations[2].raw.toString("utf8");
  expect(repair.failure).toBe("runtime");
  expect(repair.examples).toHaveLength(1);
  expect(repair.examples[0].raw.length).toBeGreaterThan(0);
  expect(failing.startsWith(repair.examples[0].raw)).toBe(true);
  expect(repair.examples[0].truncated).toBe(true);
});

test("real isolated TypeScript versions load, regress, activate, fail and repair end to end", async () => {
  const module = (fail: boolean) => `export function parse(raw: string, previous: unknown) {
    const hp = raw.match(/HP: (\\d+)\\/(\\d+)/);
    const score = raw.match(/Score: (-?\\d+)/);
    if (${fail} && !hp) throw new Error("unsupported");
    const fact = (value?: string) => value === undefined ? {value:null,source:"unknown"} : {value:Number(value),source:"observed"};
    return {kind: hp ? "state" : "error", hp:fact(hp?.[1]),maxHp:fact(hp?.[2]),score:fact(score?.[1]),
      grid:fact(),position:fact(),inventory:fact()};
  }`;
  const fixture = setup({ sources: [module(true), module(false)] });
  const episode = await runPlayer({ ...fixture, seed: 42,
    adapters: { mode: "repair", executor: new BubblewrapExecutor(), synthesizeAfter: 1 } });
  expect(episode.status).toBe("complete");
  expect(episode.adapters.map(adapter => adapter.status)).toEqual(["accepted", "accepted"]);
  expect(episode.adapterEvents.filter(event => event.kind === "hit").map(event => event.observation)).toEqual([3]);
  expect((await replay(episode)).match).toBe(true);
});

test("request pacing covers policy and authoring starts and is persisted", async () => {
  const fixture = setup({ commands: ["wait", "wait", null] });
  const starts: number[] = [];
  const client: ModelClient = { generate: async (...args) => { starts.push(performance.now()); return fixture.client.generate(...args); } };
  const episode = await runPlayer({ ...fixture, client, seed: 42, modelIntervalMs: 25,
    adapters: { mode: "repair", executor: fixture.executor, synthesizeAfter: 1 } });
  expect(episode.status).toBe("complete");
  expect(starts).toHaveLength(4);
  for (let index = 1; index < starts.length; index++) expect(starts[index] - starts[index - 1]).toBeGreaterThanOrEqual(23);
  expect(episode.config.player?.modelIntervalMs).toBe(25);
});

test("unknown author usage halts without sending the already selected action", async () => {
  const fixture = setup();
  const client: ModelClient = { generate: async (request, signal) => {
    const result = await fixture.client.generate(request, signal);
    if (request.purpose === "adapter_synthesis") result.usage.totalTokens = null;
    return result;
  } };
  const episode = await runPlayer({ ...fixture, client, seed: 42,
    adapters: { mode: "repair", executor: fixture.executor, synthesizeAfter: 1 } });
  expect(episode.stopReason).toBe("usage_unknown");
  expect(episode.commands.map(command => command.text)).toEqual(["wait"]);
  expect(episode.adapters[0].status).toBe("indeterminate");
  expect(episode.calls.at(-1)?.request.adapterAttempt).toBe(episode.adapters[0].id);
});

test("schema-valid candidates that disagree with retained examples never activate", async () => {
  const fixture = setup();
  const executor: AdapterExecutor = { run: async (_, input) => {
    const parsed = view(input.raw); parsed.hp.value = 0; return parsed;
  } };
  const episode = await runPlayer({ ...fixture, seed: 42, adapters: { mode: "repair", executor, synthesizeAfter: 1 } });
  expect(episode.adapters[0].status).toBe("rejected");
  expect(episode.adapters[0].error).toBe("regression_mismatch");
  expect(episode.adapterEvents.some(event => event.kind === "activated")).toBe(false);
});
