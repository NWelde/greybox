import { isDeepStrictEqual } from "node:util";
import type { AdapterExecutor } from "../agent/adapter-contracts";
import type { Fact, ObservedView } from "../agent/contracts";
import type { Episode } from "../agent/store";
import { verifyEpisode } from "./verify";

const DEFAULT_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 1_000;
const MAX_EVALUATION_RAW_BYTES = 256 * 1024;

export const ADAPTER_EVALUATION_FIELDS = [
  "hp",
  "maxHp",
  "score",
  "grid",
  "position",
  "inventory",
] as const;

export type AdapterEvaluationField = typeof ADAPTER_EVALUATION_FIELDS[number];
export type AdapterFieldStatus = "correct" | "incorrect" | "unknown";

export interface AdapterFieldEvaluation {
  status: AdapterFieldStatus;
  expected: Fact<unknown>;
  actual: Fact<unknown>;
}

export interface AdapterEvaluationMismatch {
  field: AdapterEvaluationField | "kind" | "adapter";
  expected: unknown;
  actual: unknown;
  reason: string;
}

export interface AdapterObservationEvaluation {
  observation: number;
  accepted: boolean;
  deterministic: boolean;
  correct: boolean;
  expectedKind: ObservedView["kind"];
  actualKind: ObservedView["kind"] | null;
  error: string | null;
  previousInputObservation: number | null;
  previousAfterObservation: number | null;
  fields: Partial<Record<AdapterEvaluationField, AdapterFieldEvaluation>>;
  mismatches: AdapterEvaluationMismatch[];
}

export interface AdapterEvaluationTotals {
  observations: number;
  accepted: number;
  failures: number;
  nondeterministic: number;
  correctObservations: number;
  fields: Record<AdapterFieldStatus, number>;
}

export interface AdapterEvaluationReport {
  episode: string;
  verified: boolean;
  reason: string;
  throughObservation: number;
  totals: AdapterEvaluationTotals;
  observations: AdapterObservationEvaluation[];
}

interface PublicExpectation {
  kind: ObservedView["kind"];
  fields: Record<AdapterEvaluationField, Fact<unknown>>;
}

type Invocation =
  | { ok: true; view: ObservedView }
  | { ok: false; error: string };

function emptyTotals(): AdapterEvaluationTotals {
  return {
    observations: 0,
    accepted: 0,
    failures: 0,
    nondeterministic: 0,
    correctObservations: 0,
    fields: { correct: 0, incorrect: 0, unknown: 0 },
  };
}

function refusedReport(
  episode: Episode,
  reason: string,
  throughObservation: number,
): AdapterEvaluationReport {
  return {
    episode: typeof episode?.id === "string" ? episode.id : "unknown",
    verified: false,
    reason,
    throughObservation,
    totals: emptyTotals(),
    observations: [],
  };
}

function observed<T>(value: T): Fact<T> {
  return { value, source: "observed" };
}

function retainedExpectation(fact: Fact<unknown>): Fact<unknown> {
  if (fact.value === null || fact.source === "unknown") {
    return { value: null, source: "unknown" };
  }
  return { value: structuredClone(fact.value), source: "retained" };
}

function stateExpectation(raw: Buffer, frameKind: "prompt" | "eof"): PublicExpectation | null {
  if (raw.length > MAX_EVALUATION_RAW_BYTES) {
    throw new Error(`Observation exceeds the ${MAX_EVALUATION_RAW_BYTES}-byte evaluation bound`);
  }
  const lines = raw.toString("utf8").split("\n");
  const statusIndex = lines.findIndex(line => /^HP: -?\d+\/-?\d+  Score: -?\d+$/.test(line));
  if (statusIndex < 0) return null;

  const status = lines[statusIndex].match(/^HP: (-?\d+)\/(-?\d+)  Score: (-?\d+)$/);
  if (!status) throw new Error("Visible status line could not be parsed");
  const inventoryLine = lines[statusIndex + 2];
  if (lines[statusIndex + 1] !== "" || !inventoryLine?.startsWith("Carrying: ")) {
    throw new Error("Visible inventory line could not be parsed");
  }

  let gridEnd = statusIndex - 1;
  while (gridEnd >= 0 && lines[gridEnd] === "") gridEnd--;
  let gridStart = gridEnd;
  while (gridStart >= 0 && /^[#X.!$m@]+$/.test(lines[gridStart])) gridStart--;
  const grid = lines.slice(gridStart + 1, gridEnd + 1);
  if (grid.length === 0 || grid.length > 256 || grid[0].length === 0 || grid[0].length > 256 ||
      grid.some(row => row.length !== grid[0].length)) {
    throw new Error("Visible grid could not be parsed within evaluation bounds");
  }
  const positions: { x: number; y: number }[] = [];
  for (let y = 0; y < grid.length; y++) {
    for (let x = 0; x < grid[y].length; x++) {
      if (grid[y][x] === "@") positions.push({ x, y });
    }
  }
  if (positions.length !== 1) throw new Error("Visible grid must contain exactly one player marker");

  const carrying = inventoryLine.slice("Carrying: ".length);
  const inventory = carrying === "nothing" ? [] : carrying.split(", ");
  if (inventory.length > 256 || inventory.some(item => item.length === 0 || item.length > 256)) {
    throw new Error("Visible inventory exceeds evaluation bounds");
  }

  const prompt = lines.slice(statusIndex + 3).includes("> ");
  const terminal = lines.slice(statusIndex + 3).some(line =>
    line === "You found the exit. You win!" || line === "You have died."
  );
  if ((frameKind === "prompt" && !prompt) || (frameKind === "eof" && !terminal)) {
    throw new Error("Visible state does not match its transport frame kind");
  }

  return {
    kind: frameKind === "eof" ? "terminal" : "state",
    fields: {
      hp: observed(Number(status[1])),
      maxHp: observed(Number(status[2])),
      score: observed(Number(status[3])),
      grid: observed(grid),
      position: observed(positions[0]),
      inventory: observed(inventory),
    },
  };
}

function publicExpectation(
  raw: Buffer,
  frameKind: "prompt" | "eof",
  previousPublic: PublicExpectation | null,
): PublicExpectation {
  const state = stateExpectation(raw, frameKind);
  if (state) return state;
  if (frameKind !== "prompt" || raw.toString("utf8") !== "I don't understand that.\n> \n") {
    throw new Error("Verified observation is not a supported public protocol response");
  }
  const fields = {} as Record<AdapterEvaluationField, Fact<unknown>>;
  for (const field of ADAPTER_EVALUATION_FIELDS) {
    fields[field] = previousPublic
      ? retainedExpectation(previousPublic.fields[field])
      : { value: null, source: "unknown" };
  }
  return { kind: "error", fields };
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error &&
      typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code.slice(0, 64);
  }
  return "runtime";
}

async function invoke(
  source: string,
  executor: AdapterExecutor,
  raw: string,
  previous: ObservedView | null,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Invocation> {
  try {
    const view = await executor.run(
      source,
      { raw, previous: previous === null ? null : structuredClone(previous) },
      { timeoutMs, signal },
    );
    return { ok: true, view };
  } catch (error) {
    return { ok: false, error: errorCode(error) };
  }
}

function invocationEqual(left: Invocation, right: Invocation): boolean {
  if (left.ok !== right.ok) return false;
  if (!left.ok && !right.ok) return left.error === right.error;
  return left.ok && right.ok && isDeepStrictEqual(left.view, right.view);
}

function scoreField(actual: Fact<unknown>, expected: Fact<unknown>): AdapterFieldEvaluation {
  if (actual.source === "unknown") return { status: "unknown", expected, actual };
  const correct = actual.source === expected.source && isDeepStrictEqual(actual.value, expected.value);
  return { status: correct ? "correct" : "incorrect", expected, actual };
}

function mismatchReason(field: AdapterFieldEvaluation): string {
  if (field.status === "unknown") return "Adapter reported unknown; unknown is not counted as correct";
  if (field.actual.source !== field.expected.source) return "Field provenance does not match the public evidence";
  return "Field value does not match the public evidence";
}

/**
 * Evaluates an adapter against a verified, acknowledged episode prefix. This
 * function is read-only: it performs no store writes and makes no model calls.
 */
export async function evaluateAdapter(
  source: string,
  episode: Episode,
  options: { executor: AdapterExecutor; timeoutMs?: number; signal?: AbortSignal },
): Promise<AdapterEvaluationReport> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new RangeError(`timeoutMs must be greater than zero and at most ${MAX_TIMEOUT_MS}`);
  }

  const before = await verifyEpisode(episode, [], { signal: options.signal });
  if (!before.verified) {
    const reason = options.signal?.aborted ? "Adapter evaluation cancelled" : before.reason;
    return refusedReport(episode, reason, before.throughObservation);
  }
  if (options.signal?.aborted) {
    return refusedReport(episode, "Adapter evaluation cancelled", before.throughObservation);
  }

  const totals = emptyTotals();
  const observations: AdapterObservationEvaluation[] = [];
  let previousAdapter: ObservedView | null = null;
  let previousAdapterObservation: number | null = null;
  let previousPublic: PublicExpectation | null = null;

  try {
    const frames = episode.observations.filter(frame =>
      frame.seq <= before.throughObservation && !(frame.kind === "eof" && frame.raw.length === 0)
    );
    totals.observations = frames.length;

    for (const frame of frames) {
      if (options.signal?.aborted) {
        return refusedReport(episode, "Adapter evaluation cancelled", before.throughObservation);
      }
      const expected = publicExpectation(frame.raw, frame.kind, previousPublic);
      if (expected.kind === "state" || expected.kind === "terminal") previousPublic = expected;
      const previousInputObservation = previousAdapterObservation;
      const raw = frame.raw.toString("utf8");
      const first = await invoke(source, options.executor, raw, previousAdapter, timeoutMs, options.signal);
      if (options.signal?.aborted) {
        return refusedReport(episode, "Adapter evaluation cancelled", before.throughObservation);
      }
      const second = await invoke(source, options.executor, raw, previousAdapter, timeoutMs, options.signal);
      if (options.signal?.aborted) {
        return refusedReport(episode, "Adapter evaluation cancelled", before.throughObservation);
      }

      const deterministic = invocationEqual(first, second);
      const accepted = deterministic && first.ok && second.ok;
      const result: AdapterObservationEvaluation = {
        observation: frame.seq,
        accepted,
        deterministic,
        correct: false,
        expectedKind: expected.kind,
        actualKind: first.ok ? first.view.kind : null,
        error: first.ok && second.ok ? null : [first, second]
          .filter((invocation): invocation is Extract<Invocation, { ok: false }> => !invocation.ok)
          .map(invocation => invocation.error)
          .join(", "),
        previousInputObservation,
        previousAfterObservation: previousAdapterObservation,
        fields: {},
        mismatches: [],
      };

      if (!deterministic) {
        totals.nondeterministic++;
        result.mismatches.push({
          field: "adapter",
          expected: "identical results from two fresh executions",
          actual: "different results",
          reason: "Adapter output or failure mode was nondeterministic",
        });
      }
      if (!first.ok || !second.ok) {
        totals.failures++;
        result.mismatches.push({
          field: "adapter",
          expected: "two successful executions",
          actual: result.error,
          reason: "Adapter failed; its prior view is retained for the next observation",
        });
      }

      if (accepted) {
        totals.accepted++;
        if (first.view.kind !== expected.kind) {
          result.mismatches.push({
            field: "kind",
            expected: expected.kind,
            actual: first.view.kind,
            reason: "Response kind does not match the public response",
          });
        }
        for (const field of ADAPTER_EVALUATION_FIELDS) {
          const evaluation = scoreField(first.view[field], expected.fields[field]);
          result.fields[field] = evaluation;
          totals.fields[evaluation.status]++;
          if (evaluation.status !== "correct") {
            result.mismatches.push({
              field,
              expected: evaluation.expected,
              actual: evaluation.actual,
              reason: mismatchReason(evaluation),
            });
          }
        }
        result.correct = result.mismatches.length === 0;
        if (result.correct) totals.correctObservations++;
        previousAdapter = structuredClone(first.view);
        previousAdapterObservation = frame.seq;
        result.previousAfterObservation = frame.seq;
      }
      observations.push(result);
    }
  } catch (error) {
    return refusedReport(
      episode,
      error instanceof Error ? error.message : String(error),
      before.throughObservation,
    );
  }

  const after = await verifyEpisode(episode, [], { signal: options.signal });
  if (!after.verified || options.signal?.aborted || after.throughObservation !== before.throughObservation) {
    const reason = options.signal?.aborted
      ? "Adapter evaluation cancelled"
      : after.verified
        ? "The acknowledged trace prefix changed during adapter evaluation"
        : after.reason;
    return refusedReport(episode, reason, after.throughObservation);
  }

  return {
    episode: episode.id,
    verified: true,
    reason: `Independently verified before and after evaluating observations 0 through ${after.throughObservation}`,
    throughObservation: after.throughObservation,
    totals,
    observations,
  };
}
