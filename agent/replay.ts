import { gameCommand, gameIdentity, ROOT } from "./game";
import { type Episode } from "./store";
import { validateLimits, validateSeed } from "./runner";
import { ProcessTransport, RunError, type Transport, within } from "./transport";

export interface ReplayResult {
  match: boolean;
  reason: string;
  observation?: number;
}

function assertComplete(episode: Episode): void {
  if (episode.status !== "complete" || episode.forced || episode.exitCode !== 0 ||
      !["script_complete", "model_stop", "game_exit"].includes(episode.stopReason ?? "")) {
    throw new Error("Trace is incomplete or did not exit cleanly; cannot claim exact replay");
  }
  if (episode.commands.some((command, index) => command.seq !== index || command.status !== "complete")) {
    throw new Error("Trace has missing or indeterminate commands; refusing replay");
  }
  const expectedFrames = episode.commands.length + (episode.stopReason === "game_exit" ? 1 : 2);
  if (episode.observations.length !== expectedFrames || episode.observations[0]?.kind !== "prompt" ||
      episode.observations.some((frame, index) => frame.seq !== index ||
        frame.kind !== (index === expectedFrames - 1 ? "eof" : "prompt"))) {
    throw new Error("Trace has missing or invalid response boundaries");
  }
  if (!Buffer.concat(episode.observations.map(frame => frame.raw)).equals(episode.stdout)) {
    throw new Error("Trace observations do not match captured stdout");
  }
  if (episode.stopReason === "game_exit" && episode.observations.at(-1)!.raw.length === 0) {
    throw new Error("Empty EOF does not acknowledge a game command");
  }
  validateSeed(episode.config.seed);
  validateLimits(episode.config.limits);
}

export async function replay(episode: Episode, options: {
  signal?: AbortSignal; transportFactory?: () => Transport;
} = {}): Promise<ReplayResult> {
  assertComplete(episode);
  const identity = await gameIdentity();
  if (JSON.stringify(identity) !== JSON.stringify(episode.config.game)) {
    return { match: false, reason: "Game source, Bun runtime, or framing contract changed" };
  }
  const limits = episode.config.limits;
  const deadline = performance.now() + limits.episodeMs;
  const remaining = () => {
    const left = deadline - performance.now();
    if (left <= 0) throw new RunError("episode_limit", "Replay deadline exceeded");
    return Math.min(left, limits.responseMs);
  };
  if (options.signal?.aborted) return { match: false, reason: "Replay cancelled before launch" };
  const transport = options.transportFactory?.() ?? new ProcessTransport(gameCommand(episode.config.seed), ROOT, limits.maxOutputBytes);
  let index = 0;
  let result: ReplayResult = { match: true, reason: "Startup, responses, stdout, stderr and exit match exactly; no model calls" };
  const compare = async () => {
    const actual = await transport.next(remaining(), options.signal);
    const expected = episode.observations[index];
    if (!expected || actual.kind !== expected.kind || !actual.raw.equals(expected.raw)) {
      throw new RunError("mismatch", `Response ${index} differs`);
    }
    index++;
  };
  try {
    await compare();
    for (const command of episode.commands) {
      const sendMs = remaining();
      if (options.signal?.aborted) throw new RunError("cancelled", "Replay cancelled");
      await within(transport.send(command.text), sendMs, options.signal);
      await compare();
    }
    if (episode.stopReason !== "game_exit") {
      transport.endInput();
      await compare();
    }
  } catch (error) {
    result = { match: false, reason: error instanceof Error ? error.message : String(error), observation: index };
  } finally {
    const closed = await transport.close();
    if (result.match && (closed.fault || closed.forced || closed.exitCode !== episode.exitCode ||
        !closed.stdout.equals(episode.stdout) || !closed.stderr.equals(episode.stderr))) {
      result = { match: false, reason: "Final output, stderr, or exit differs" };
    }
  }
  if (result.match) {
    try {
      if (JSON.stringify(await gameIdentity()) !== JSON.stringify(identity)) {
        return { match: false, reason: "Game source changed during replay" };
      }
    } catch {
      return { match: false, reason: "Cannot verify game source after replay" };
    }
  }
  return result;
}
