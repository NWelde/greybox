import { expect, test } from "bun:test";
import { geminiKey } from "./config";
import type { ObservedView } from "./contracts";
import { checkInvariants } from "./invariants";
import { DEFAULT_MODEL } from "./player";
import { buildRequest, parseDecision } from "./prompts";

export function view(hp = 10, score = 0): ObservedView {
  return { kind: "state", hp: { value: hp, source: "observed" },
    maxHp: { value: 10, source: "observed" }, score: { value: score, source: "observed" },
    grid: { value: null, source: "unknown" }, position: { value: null, source: "unknown" },
    inventory: { value: null, source: "unknown" } };
}
const decision = (state = view(), command: string | null = "north", memory = "") => JSON.stringify({ view: state, command, memory });

test("surprising values remain evidence, not validation errors", () => {
  const parsed = parseDecision(decision(view(13, -5)));
  expect(parsed.view.hp.value).toBe(13);
  expect(checkInvariants(parsed.view, 3, { value: 5, observation: 2 }).map(result => result.status))
    .toEqual(["violated", "violated"]);
});

test("retained values come from prior evidence and cannot pass as fresh", () => {
  const next = view();
  next.kind = "error";
  next.hp = { value: 999, source: "retained" };
  next.score = { value: 999, source: "retained" };
  const parsed = parseDecision(decision(next), view(13, 5));
  expect(parsed.view.hp).toEqual({ value: 13, source: "retained" });
  expect(parsed.view.score).toEqual({ value: 5, source: "retained" });
  expect(checkInvariants(parsed.view, 3).every(result => result.status === "unevaluated")).toBe(true);
  expect(parseDecision(decision(next)).view.hp).toEqual({ value: null, source: "unknown" });
});

test("malformed views, multiline commands and unbounded memory fail closed", () => {
  expect(() => parseDecision("{}" )).toThrow();
  expect(() => parseDecision(decision(view(), "north\nsouth"))).toThrow();
  expect(() => parseDecision(decision(view(), "north", "x".repeat(1501)))).toThrow();
  const invalid = view();
  invalid.hp = { value: 10, source: "unknown" };
  expect(() => parseDecision(decision(invalid))).toThrow();
});

test("requests whitelist public inputs and keep only whole recent interactions", () => {
  const newest = { observation: "new public output", command: "north" };
  const options = { raw: "current public output", history: [{ observation: "old", command: "help" }, newest],
    memory: "abcdefgh", settings: DEFAULT_MODEL, historyBytes: Buffer.byteLength(JSON.stringify(newest)), memoryChars: 4,
    seed: 42, oracle: "private oracle", apiKey: "private credential", gameSource: "private source" };
  const request = buildRequest(options);
  const input = JSON.parse(request.input);
  expect(input.recentInteractions).toEqual([newest]);
  expect(input.memory).toBe("abcd");
  expect(input.previousView).toBeNull();
  expect(JSON.stringify(request)).not.toContain("private");
  expect(Object.keys(input)).toEqual(["recentInteractions", "memory", "previousView", "currentObservation", "memoryCharacterLimit"]);
  expect(() => buildRequest({ ...options, raw: "x".repeat(16_385) })).toThrow();
});

test("credential configuration accepts only explicit environment names", () => {
  expect(geminiKey({ GEMINI_API_KEY: " fixture-key " })).toBe("fixture-key");
  expect(geminiKey({ GOOGLE_API_KEY: "fixture-key" })).toBe("fixture-key");
  expect(() => geminiKey({ "API KEY": "do-not-echo-this" })).toThrow("GEMINI_API_KEY");
});
