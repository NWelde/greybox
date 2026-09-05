import { afterEach, expect, test } from "bun:test";
import { verifyEpisode } from "../eval/verify";
import { ModelError, UNKNOWN_USAGE, type ModelClient, type ModelReply, type ModelRequest, type ObservedView } from "./contracts";
import { runPlayer } from "./player";
import { replay } from "./replay";
import { Store } from "./store";
import type { Transport } from "./transport";

const stores: Store[] = [];
const makeStore = () => { const store = new Store(":memory:"); stores.push(store); return store; };
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

function publicView(raw: string): ObservedView {
  // Test fixture only; the runtime player has no handwritten game parser.
  const hp = raw.match(/HP: (\d+)\/(\d+)/);
  const score = raw.match(/Score: (-?\d+)/);
  const numeric = (value?: string) => value === undefined
    ? { value: null, source: "unknown" as const } : { value: Number(value), source: "observed" as const };
  return { kind: hp ? "state" : "error", hp: numeric(hp?.[1]), maxHp: numeric(hp?.[2]), score: numeric(score?.[1]),
    grid: { value: null, source: "unknown" }, position: { value: null, source: "unknown" }, inventory: { value: null, source: "unknown" } };
}

function reply(request: ModelRequest, command: string | null, memory = "test memory"): ModelReply {
  const text = JSON.stringify({ view: publicView(JSON.parse(request.input).currentObservation), command, memory });
  return { text, response: { text }, usage: { promptTokens: 50, outputTokens: 30, thinkingTokens: 20, cachedTokens: 0, totalTokens: 100 },
    modelVersion: "fixture-model", finishReason: "STOP" };
}

function scripted(commands: (string | null)[]) {
  const requests: ModelRequest[] = [];
  const client: ModelClient = { generate: async request => {
    requests.push(request);
    if (requests.length > commands.length) throw new Error("Unexpected extra model call");
    return reply(request, commands[requests.length - 1]);
  } };
  return { requests, client };
}

function fakeTransport(): Transport {
  let ended = false;
  const raw = Buffer.from("HP: 10/10 Score: 0\n> \n");
  return { next: async () => ({ kind: ended ? "eof" : "prompt", raw: ended ? Buffer.alloc(0) : raw }),
    send: async () => {}, endInput: () => { ended = true; },
    close: async () => ({ exitCode: 0, forced: false, stdout: raw, stderr: Buffer.alloc(0) }) };
}

test("raw decisions persist calls, discover overheal and independently confirm it", async () => {
  const store = makeStore();
  const { client, requests } = scripted(["north", "north", "take", "drink", null]);
  const episode = await runPlayer({ store, seed: 42, client });
  expect(episode.status).toBe("complete");
  expect(episode.stopReason).toBe("model_stop");
  expect(episode.calls).toHaveLength(5);
  expect(episode.calls.every(call => call.status === "succeeded")).toBe(true);
  expect(episode.calls.reduce((sum, call) => sum + call.usage.totalTokens!, 0)).toBe(500);
  expect(episode.interpretations).toHaveLength(5);
  expect(JSON.parse(requests[1].input).memory).toBe("test memory");
  expect(JSON.parse(requests[1].input).recentInteractions[0].command).toBe("north");
  expect((await replay(episode)).match).toBe(true);
  const report = await verifyEpisode(episode, episode.invariants);
  expect(report.verified).toBe(true);
  expect(report.findings).toContainEqual(expect.objectContaining({ invariant: "hp_at_most_max", origin: "policy_candidate", status: "confirmed", observation: 4 }));
  store.verify(episode.id, report);
  expect(store.get(episode.id).verifications).toEqual([report]);
});

test("score findings survive error-only observations without inventing fresh values", async () => {
  const store = makeStore();
  const { client } = scripted(["south", "west", "west", "west", "west", "take", "nonsense", "drop coin", null]);
  const episode = await runPlayer({ store, seed: 42, client });
  expect(episode.status).toBe("complete");
  expect(episode.invariants.filter(result => result.observation === 7).every(result => result.status === "unevaluated")).toBe(true);
  const report = await verifyEpisode(episode, episode.invariants);
  expect(report.findings).toContainEqual(expect.objectContaining({ invariant: "cumulative_score", origin: "policy_candidate", status: "confirmed", observation: 8, previousObservation: 6 }));
});

test("natural game exit makes no extra policy call", async () => {
  const { client, requests } = scripted(["north", "north", "west", "west"]);
  const episode = await runPlayer({ store: makeStore(), seed: 42, client });
  expect(episode.stopReason).toBe("game_exit");
  expect(requests).toHaveLength(4);
  expect(episode.observations.at(-1)?.kind).toBe("eof");
  expect((await replay(episode)).match).toBe(true);
  expect((await verifyEpisode(episode)).outcome).toBe("win");
});

test("bounded play leaves an independently verifiable acknowledged prefix", async () => {
  const { client } = scripted(["north"]);
  const episode = await runPlayer({ store: makeStore(), seed: 42, client, limits: { maxCommands: 1 } });
  expect(episode.stopReason).toBe("turn_limit");
  expect(episode.status).toBe("incomplete");
  expect(episode.commands[0].status).toBe("complete");
  expect((await verifyEpisode(episode)).verified).toBe(true);
  await expect(replay(episode)).rejects.toThrow("incomplete");
});

test("insufficient admission budget makes no model request", async () => {
  const { client, requests } = scripted([]);
  const episode = await runPlayer({ store: makeStore(), seed: 42, client, tokenBudget: 1, transportFactory: fakeTransport });
  expect(episode.stopReason).toBe("token_limit");
  expect(requests).toHaveLength(0);
  expect(episode.calls).toHaveLength(0);
});

test("unknown usage stops without sending the proposed command or retrying", async () => {
  const client: ModelClient = { generate: async request => ({ ...reply(request, "north"), usage: { ...UNKNOWN_USAGE } }) };
  const episode = await runPlayer({ store: makeStore(), seed: 42, client, transportFactory: fakeTransport });
  expect(episode.stopReason).toBe("usage_unknown");
  expect(episode.calls).toHaveLength(1);
  expect(episode.calls[0].usage.totalTokens).toBeNull();
  expect(episode.commands).toHaveLength(0);
});

test("malformed decisions preserve usage but send no command", async () => {
  const client: ModelClient = { generate: async request => ({ ...reply(request, "north"), text: "{}" }) };
  const episode = await runPlayer({ store: makeStore(), seed: 42, client, transportFactory: fakeTransport });
  expect(episode.stopReason).toBe("invalid_decision");
  expect(episode.calls[0].usage.totalTokens).toBe(100);
  expect(episode.commands).toHaveLength(0);
});

test("every known-usage transient retry is recorded before dispatch", async () => {
  const store = makeStore();
  let calls = 0;
  let id = "";
  const original = store.start.bind(store);
  store.start = config => (id = original(config));
  const client: ModelClient = { generate: async request => {
    expect(store.get(id).calls.at(-1)?.status).toBe("in_flight");
    if (calls++ === 0) throw new ModelError("http_503", "busy", true, { ...UNKNOWN_USAGE, totalTokens: 5 }, null, 0);
    return reply(request, null);
  } };
  const episode = await runPlayer({ store, seed: 42, client, transportFactory: fakeTransport });
  expect(episode.status).toBe("complete");
  expect(episode.calls.map(call => [call.attempt, call.status, call.usage.totalTokens])).toEqual([[0, "failed", 5], [1, "succeeded", 100]]);
});

test("unknown-usage transient errors are not retried", async () => {
  const client: ModelClient = { generate: async () => { throw new ModelError("http_429", "rate limited", true); } };
  const episode = await runPlayer({ store: makeStore(), seed: 42, client, transportFactory: fakeTransport });
  expect(episode.stopReason).toBe("http_429");
  expect(episode.calls).toHaveLength(1);
});

test("a long provider Retry-After is never shortened into an early retry", async () => {
  const client: ModelClient = { generate: async () => {
    throw new ModelError("http_503", "busy", true, { ...UNKNOWN_USAGE, totalTokens: 0 }, null, 20_000);
  } };
  const episode = await runPlayer({ store: makeStore(), seed: 42, client, transportFactory: fakeTransport });
  expect(episode.stopReason).toBe("http_503");
  expect(episode.calls).toHaveLength(1);
  expect(episode.commands).toHaveLength(0);
});

test("model timeout aborts the request and never sends or retries", async () => {
  let signal: AbortSignal | undefined;
  const client: ModelClient = { generate: async (_, inputSignal) => { signal = inputSignal; return new Promise(() => {}); } };
  const episode = await runPlayer({ store: makeStore(), seed: 42, client, callMs: 15, transportFactory: fakeTransport });
  expect(episode.stopReason).toBe("timeout");
  expect(signal?.aborted).toBe(true);
  expect(episode.calls).toHaveLength(1);
  expect(episode.calls[0].status).toBe("failed");
  expect(episode.commands).toHaveLength(0);
});

test("episode deadline settles call accounting before returning", async () => {
  const store = makeStore();
  let signal: AbortSignal | undefined;
  const client: ModelClient = { generate: async (_, inputSignal) => { signal = inputSignal; return new Promise(() => {}); } };
  const episode = await runPlayer({ store, seed: 42, client, limits: { episodeMs: 25 }, transportFactory: fakeTransport });
  expect(episode.status).toBe("incomplete");
  expect(signal?.aborted).toBe(true);
  expect(episode.calls).toHaveLength(1);
  expect(episode.calls[0].status).not.toBe("in_flight");
  const before = store.get(episode.id);
  await Bun.sleep(30);
  expect(store.get(episode.id)).toEqual(before);
});

test("cancellation aborts a model that ignores its signal and settles before return", async () => {
  const controller = new AbortController();
  let signal: AbortSignal | undefined;
  const client: ModelClient = { generate: async (_, inputSignal) => {
    signal = inputSignal; queueMicrotask(() => controller.abort()); return new Promise(() => {});
  } };
  const episode = await runPlayer({ store: makeStore(), seed: 42, client, signal: controller.signal, transportFactory: fakeTransport });
  expect(episode.stopReason).toBe("cancelled");
  expect(signal?.aborted).toBe(true);
  expect(episode.calls[0].status).not.toBe("in_flight");
  expect(episode.commands).toHaveLength(0);
});

test("new episodes reset working memory and public history", async () => {
  const { client, requests } = scripted([null, null]);
  const store = makeStore();
  await runPlayer({ store, seed: 42, client, transportFactory: fakeTransport });
  await runPlayer({ store, seed: 42, client, transportFactory: fakeTransport });
  expect(requests.map(request => JSON.parse(request.input).memory)).toEqual(["", ""]);
  expect(requests.map(request => JSON.parse(request.input).recentInteractions)).toEqual([[], []]);
});

test("Gemini 3 thinking levels are validated and the actual selection is persisted", async () => {
  const store = makeStore();
  const { client } = scripted([null]);
  const episode = await runPlayer({ store, seed: 42, client, transportFactory: fakeTransport,
    settings: { model: "gemini-3.6-flash", thinkingLevel: "low" } });
  expect(episode.config.player?.settings.thinkingBudget).toBeNull();
  expect(episode.calls[0].request.settings.thinkingLevel).toBe("low");
  await expect(runPlayer({ store, seed: 42, client, settings: { thinkingLevel: "low" } })).rejects.toThrow("Gemini 3");
  await expect(runPlayer({ store, seed: 42, client, settings: { model: "gemini-3.6-flash", thinkingLevel: "low", thinkingBudget: 512 } })).rejects.toThrow("not both");
});
