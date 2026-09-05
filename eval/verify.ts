import type {
  InvariantResult,
  VerificationFinding,
  VerificationReport,
} from "../agent/contracts";
import { gameCommand, gameIdentity, ROOT } from "../agent/game";
import { MAX_COMMANDS, MAX_EPISODE_MS, MAX_OUTPUT_BYTES, MAX_RESPONSE_MS } from "../agent/runner";
import type { Episode, Limits } from "../agent/store";
import { ProcessTransport, RunError, within } from "../agent/transport";
import { checkOutcome, outcomeMessage, type Outcome } from "../game-test/lifecycle";
import {
  applyAction,
  BANNER,
  parseCommand,
  PROMPT,
  renderState,
  UNKNOWN_COMMAND,
} from "../game-test/protocol";
import { createRng } from "../game-test/rng";
import { createInitialState, type GameState } from "../game-test/world";

const INVARIANT_VERSION = 1;

interface Prefix {
  commands: Episode["commands"];
  observations: Episode["observations"];
  limits: Limits;
}

interface ActualViolation {
  invariant: InvariantResult["invariant"];
  version: number;
  observation: number;
  previousObservation: number | null;
  evidence: Record<string, number>;
}

interface OracleResult {
  outcome: Outcome;
  violations: ActualViolation[];
  scores: Map<number, number>;
}

function unverifiedFindings(candidates: InvariantResult[], reason: string): VerificationFinding[] {
  return candidates
    .filter((candidate) => candidate?.status === "violated")
    .map((candidate) => ({
      invariant: candidate.invariant,
      version: candidate.version,
      observation: candidate.observation,
      previousObservation: candidate.previousObservation,
      status: "unverified",
      origin: "policy_candidate",
      evidence: candidate.evidence,
      reason,
    }));
}

function failedReport(
  episode: Episode,
  candidates: InvariantResult[],
  reason: string,
  throughObservation: number,
): VerificationReport {
  return {
    episode: typeof episode?.id === "string" ? episode.id : "unknown",
    verified: false,
    reason,
    throughObservation,
    outcome: "unknown",
    findings: unverifiedFindings(candidates, "The episode prefix was not independently reproduced"),
  };
}

function validatePositiveInteger(name: string, value: unknown, maximum: number): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    throw new Error(`${name} must be a positive integer at most ${maximum}`);
  }
}

function validatePrefix(episode: Episode): Prefix {
  if (!episode || typeof episode !== "object" || !episode.config || typeof episode.config !== "object") {
    throw new Error("Episode configuration is missing");
  }
  if (episode.status !== "complete" && episode.status !== "incomplete") {
    throw new Error("A running episode cannot be independently verified");
  }
  const seed = episode.config.seed;
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new Error("Seed must be an integer from 0 to 4294967295");
  }
  const limits = episode.config.limits;
  if (!limits || typeof limits !== "object") throw new Error("Recorded limits are missing");
  validatePositiveInteger("maxCommands", limits.maxCommands, MAX_COMMANDS);
  validatePositiveInteger("responseMs", limits.responseMs, MAX_RESPONSE_MS);
  validatePositiveInteger("episodeMs", limits.episodeMs, MAX_EPISODE_MS);
  validatePositiveInteger("maxOutputBytes", limits.maxOutputBytes, MAX_OUTPUT_BYTES);
  const plannedCommands = episode.config.plannedCommands;
  if (plannedCommands !== null && (!Number.isSafeInteger(plannedCommands) || plannedCommands < 0)) {
    throw new Error("plannedCommands must be a nonnegative safe integer or null");
  }

  if (!Array.isArray(episode.commands) || !Array.isArray(episode.observations)) {
    throw new Error("Commands and observations must be arrays");
  }
  if (episode.commands.length > limits.maxCommands || episode.commands.length > MAX_COMMANDS) {
    throw new Error("Trace exceeds its command-attempt bound");
  }
  if (episode.observations.length > episode.commands.length + 2 ||
      episode.observations.length > MAX_COMMANDS + 2) {
    throw new Error("Trace has too many observations for its commands");
  }

  for (let index = 0; index < episode.commands.length; index++) {
    const command = episode.commands[index];
    if (!command || command.seq !== index) throw new Error("Command sequence numbers are not contiguous");
    if (typeof command.text !== "string" || /[\r\n\0]/.test(command.text) ||
        Buffer.byteLength(command.text) > 4096) {
      throw new Error(`Command ${index} is not a bounded single line`);
    }
    if (!["intent", "sent", "complete", "indeterminate"].includes(command.status)) {
      throw new Error(`Command ${index} has an invalid status`);
    }
  }

  let capturedBytes = 0;
  for (let index = 0; index < episode.observations.length; index++) {
    const observation = episode.observations[index];
    if (!observation || observation.seq !== index) {
      throw new Error("Observation sequence numbers are not contiguous");
    }
    if (observation.kind !== "prompt" && observation.kind !== "eof") {
      throw new Error(`Observation ${index} has an invalid frame kind`);
    }
    if (!Buffer.isBuffer(observation.raw)) throw new Error(`Observation ${index} raw output is not bytes`);
    capturedBytes += observation.raw.length;
    if (capturedBytes > limits.maxOutputBytes) throw new Error("Recorded observations exceed the output bound");
  }
  if (episode.observations[0]?.kind !== "prompt") {
    throw new Error("Observation 0 must be a startup prompt");
  }

  let completeCount = 0;
  while (episode.commands[completeCount]?.status === "complete") completeCount++;
  const uncertain = episode.commands.slice(completeCount);
  if (uncertain.length > 1 || uncertain.some((command) => command.status === "complete")) {
    throw new Error("Trace does not contain one contiguous acknowledged command prefix");
  }
  if (episode.status === "complete" && uncertain.length !== 0) {
    throw new Error("A complete episode cannot contain an uncertain command");
  }
  if (episode.observations.length < completeCount + 1) {
    throw new Error("A completed command is missing its associated observation");
  }

  const observations = episode.observations.slice(0, completeCount + 1);
  for (let index = 0; index < observations.length; index++) {
    if (index < observations.length - 1 && observations[index].kind !== "prompt") {
      throw new Error(`Terminal observation ${index} cannot precede another acknowledged command`);
    }
  }
  const ignored = episode.observations.slice(completeCount + 1);
  if (ignored.length > 1 || ignored.some((frame) => frame.kind !== "eof" || frame.raw.length !== 0)) {
    throw new Error("Trace has output that cannot be associated with the acknowledged prefix");
  }
  if (episode.status === "complete") {
    const endedAtPrompt = observations.at(-1)!.kind === "prompt";
    if ((endedAtPrompt && ignored.length !== 1) || (!endedAtPrompt && ignored.length !== 0)) {
      throw new Error("Complete episode framing does not contain its natural or deliberate EOF");
    }
    if (!Buffer.isBuffer(episode.stdout) ||
        !Buffer.concat(episode.observations.map((frame) => frame.raw)).equals(episode.stdout)) {
      throw new Error("Complete episode stdout does not match its observation frames");
    }
  }

  return {
    commands: episode.commands.slice(0, completeCount),
    observations,
    limits,
  };
}

function sameIdentity(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function replayPrefix(episode: Episode, prefix: Prefix, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new RunError("cancelled", "Verification cancelled before launch");
  const deadline = performance.now() + prefix.limits.episodeMs;
  const remaining = () => {
    const left = deadline - performance.now();
    if (left <= 0) throw new RunError("episode_limit", "Verification deadline exceeded");
    return Math.min(left, prefix.limits.responseMs);
  };
  const transport = new ProcessTransport(
    gameCommand(episode.config.seed),
    ROOT,
    prefix.limits.maxOutputBytes,
  );
  let primaryError: unknown;
  try {
    for (let index = 0; index < prefix.observations.length; index++) {
      if (index > 0) {
        await within(transport.send(prefix.commands[index - 1].text), remaining(), signal);
      }
      const actual = await transport.next(remaining(), signal);
      const expected = prefix.observations[index];
      if (actual.kind !== expected.kind || !actual.raw.equals(expected.raw)) {
        throw new RunError("mismatch", `Observation ${index} differs from the recorded trace`);
      }
    }

    if (prefix.observations.at(-1)!.kind === "prompt") {
      transport.endInput();
      const final = await transport.next(remaining(), signal);
      if (final.kind !== "eof" || final.raw.length !== 0) {
        throw new RunError("unexpected_output", "Closing the verified prefix produced additional game output");
      }
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      const closed = await transport.close();
      if (!primaryError) {
        const expectedStdout = Buffer.concat(prefix.observations.map((frame) => frame.raw));
        if (closed.fault || closed.forced || closed.exitCode !== 0 || closed.exitSignal ||
            closed.stderr.length !== 0 || !closed.stdout.equals(expectedStdout)) {
          throw new RunError("cleanup_mismatch", "Replayed process output or termination did not close cleanly");
        }
      }
    } catch (cleanupError) {
      if (!primaryError) throw cleanupError;
    }
  }
}

function line(text: string): string {
  return `${text}\n`;
}

function initialOutput(state: GameState): Buffer {
  return Buffer.from(line(BANNER) + line(renderState(state)) + line(PROMPT));
}

function responseOutput(state: GameState, actionKnown: boolean, outcome: Outcome): Buffer {
  if (!actionKnown) return Buffer.from(line(UNKNOWN_COMMAND) + line(PROMPT));
  let output = line(renderState(state));
  if (outcome === "playing") output += line(PROMPT);
  else output += line(outcomeMessage(outcome));
  return Buffer.from(output);
}

function scanState(
  state: GameState,
  observation: number,
  previousState: GameState | null,
  previousObservation: number | null,
): ActualViolation[] {
  const violations: ActualViolation[] = [];
  if (state.player.hp > state.player.maxHp) {
    violations.push({
      invariant: "hp_at_most_max",
      version: INVARIANT_VERSION,
      observation,
      previousObservation: null,
      evidence: { hp: state.player.hp, maxHp: state.player.maxHp },
    });
  }
  if (previousState && state.score < previousState.score) {
    violations.push({
      invariant: "cumulative_score",
      version: INVARIANT_VERSION,
      observation,
      previousObservation,
      evidence: { previousScore: previousState.score, score: state.score },
    });
  }
  return violations;
}

function runOracle(episode: Episode, prefix: Prefix): OracleResult {
  const rng = createRng(episode.config.seed);
  let state = createInitialState(rng, 8, 8);
  const violations = scanState(state, 0, null, null);
  const scores = new Map<number, number>([[0, state.score]]);
  const startup = prefix.observations[0];
  const expectedStartup = initialOutput(state);
  if (startup.kind !== "prompt" || !startup.raw.equals(expectedStartup)) {
    throw new Error("Observation 0 does not match the seeded oracle output");
  }

  let outcome = checkOutcome(state);
  let previousSupportedState = state;
  let previousSupportedObservation = 0;
  for (let index = 0; index < prefix.commands.length; index++) {
    const action = parseCommand(prefix.commands[index].text);
    if (action) state = applyAction(state, action, rng);
    outcome = checkOutcome(state);
    const expected = responseOutput(state, action !== null, outcome);
    const observation = prefix.observations[index + 1];
    const expectedKind = action && outcome !== "playing" ? "eof" : "prompt";
    if (observation.kind !== expectedKind || !observation.raw.equals(expected)) {
      throw new Error(`Observation ${index + 1} does not match the seeded oracle output`);
    }
    if (action) {
      violations.push(...scanState(
        state,
        index + 1,
        previousSupportedState,
        previousSupportedObservation,
      ));
      previousSupportedState = state;
      previousSupportedObservation = index + 1;
      scores.set(index + 1, state.score);
    }
  }
  return { outcome, violations, scores };
}

function evidenceMatches(candidate: InvariantResult, actual: ActualViolation): boolean {
  const expectedKeys = actual.invariant === "hp_at_most_max"
    ? ["hp", "maxHp"]
    : ["previousScore", "score"];
  return candidate.evidence !== null && typeof candidate.evidence === "object" &&
    expectedKeys.every((key) =>
      typeof candidate.evidence[key] === "number" &&
      Number.isFinite(candidate.evidence[key]) &&
      candidate.evidence[key] === actual.evidence[key]
    );
}

function evaluateFindings(
  candidates: InvariantResult[],
  oracle: OracleResult,
): VerificationFinding[] {
  const findings: VerificationFinding[] = [];
  const confirmed = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || candidate.status !== "violated") continue;
    let actual: ActualViolation | undefined;
    if (candidate.invariant === "cumulative_score" &&
        candidate.version === INVARIANT_VERSION &&
        Number.isSafeInteger(candidate.observation) &&
        Number.isSafeInteger(candidate.previousObservation) &&
        candidate.previousObservation !== null &&
        candidate.previousObservation < candidate.observation) {
      const previousScore = oracle.scores.get(candidate.previousObservation);
      const score = oracle.scores.get(candidate.observation);
      if (previousScore !== undefined && score !== undefined && previousScore > score) {
        actual = {
          invariant: "cumulative_score",
          version: INVARIANT_VERSION,
          observation: candidate.observation,
          previousObservation: candidate.previousObservation,
          evidence: { previousScore, score },
        };
      }
    } else {
      actual = oracle.violations.find((violation) =>
        violation.invariant === candidate.invariant &&
        violation.version === candidate.version &&
        violation.observation === candidate.observation &&
        violation.previousObservation === candidate.previousObservation
      );
    }
    const valid = actual !== undefined && evidenceMatches(candidate, actual);
    if (valid) confirmed.add(`${actual.invariant}:${actual.observation}`);
    findings.push({
      invariant: candidate.invariant,
      version: candidate.version,
      observation: candidate.observation,
      previousObservation: candidate.previousObservation,
      status: valid ? "confirmed" : "rejected",
      origin: "policy_candidate",
      evidence: valid ? actual.evidence : candidate.evidence,
      reason: valid
        ? "The independently reconstructed state has this exact violation and evidence"
        : "No independently reconstructed violation matches this observation, predecessor, version, and numeric evidence",
    });
  }
  for (const violation of oracle.violations) {
    if (confirmed.has(`${violation.invariant}:${violation.observation}`)) continue;
    findings.push({
      ...violation,
      status: "confirmed",
      origin: "oracle_scan",
      reason: "The fixed predicate failed in the independently reconstructed state",
    });
  }
  return findings;
}

export async function verifyEpisode(
  episode: Episode,
  candidates: InvariantResult[] = [],
  options: { signal?: AbortSignal } = {},
): Promise<VerificationReport> {
  let throughObservation = -1;
  try {
    if (!Array.isArray(candidates)) throw new Error("Candidates must be an array");
    const prefix = validatePrefix(episode);
    throughObservation = prefix.observations.length - 1;
    const before = await gameIdentity();
    if (!sameIdentity(before, episode.config.game)) {
      return failedReport(
        episode,
        candidates,
        "Game source, Bun runtime, or framing contract does not match the recording",
        throughObservation,
      );
    }

    await replayPrefix(episode, prefix, options.signal);
    const oracle = runOracle(episode, prefix);
    const after = await gameIdentity();
    if (!sameIdentity(after, episode.config.game)) {
      return failedReport(
        episode,
        candidates,
        "Game source, Bun runtime, or framing contract changed during verification",
        throughObservation,
      );
    }

    return {
      episode: episode.id,
      verified: true,
      reason: `Independently reproduced observations 0 through ${throughObservation} and matched seeded oracle output`,
      throughObservation,
      outcome: oracle.outcome,
      findings: evaluateFindings(candidates, oracle),
    };
  } catch (error) {
    return failedReport(
      episode,
      candidates,
      error instanceof Error ? error.message : String(error),
      throughObservation,
    );
  }
}
