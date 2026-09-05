import { gameCommand, gameIdentity, ROOT } from "./game";
import { type Episode, type Limits, type RunConfig, Store } from "./store";
import type { Frame } from "./framing";
import { ProcessTransport, RunError, type Transport, within } from "./transport";

export const DEFAULT_LIMITS: Limits = {
  maxCommands: 200, responseMs: 5000, episodeMs: 300_000, maxOutputBytes: 1_048_576,
};

export function validateLimits(limits: Limits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
      throw new Error(`${name} must be a positive integer at most 2147483647`);
    }
  }
}

export function validateSeed(seed: number) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) throw new Error("Seed must be an integer from 0 to 4294967295");
}

export interface DecisionContext {
  episode: string;
  observation: number;
  frame: Frame;
  history: { observation: string; command: string }[];
  remainingMs: () => number;
  signal?: AbortSignal;
}

export interface SessionOptions {
  store: Store; seed: number; limits?: Partial<Limits>;
  signal?: AbortSignal; transportFactory?: () => Transport;
  identityProvider?: typeof gameIdentity;
}

export async function runScript(options: SessionOptions & { commands: string[] }): Promise<Episode> {
  const { commands } = options;
  for (const command of commands) {
    if (typeof command !== "string" || /[\r\n\0]/.test(command) || Buffer.byteLength(command) > 4096) {
      throw new Error("Every command must be one line, without NUL, at most 4096 bytes");
    }
  }
  let index = 0;
  return runEpisode({ ...options, condition: "scripted", plannedCommands: commands.length,
    stopReason: "script_complete", decide: async () => commands[index++] ?? null });
}

export async function runEpisode(options: SessionOptions & {
  condition: RunConfig["condition"]; plannedCommands: number | null;
  player?: RunConfig["player"]; stopReason: "script_complete" | "model_stop";
  decide: (context: DecisionContext) => Promise<string | null>;
}): Promise<Episode> {
  const { store, seed, signal } = options;
  validateSeed(seed);
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  validateLimits(limits);
  const identityProvider = options.identityProvider ?? gameIdentity;
  const config: RunConfig = { seed, game: await identityProvider(), limits,
    condition: options.condition, plannedCommands: options.plannedCommands,
    ...(options.player ? { player: options.player } : {}) };
  const id = store.start(config);
  const deadline = performance.now() + limits.episodeMs;
  let transport: Transport | undefined;
  let stopReason: string = options.stopReason;
  let error: string | null = null;
  let seq = 0;
  let status: "complete" | "incomplete" = "complete";
  const remaining = () => {
    const ms = deadline - performance.now();
    if (ms <= 0) throw new RunError("episode_limit", "Episode deadline exceeded");
    return Math.min(ms, limits.responseMs);
  };
  let result: Awaited<ReturnType<Transport["close"]>> = { exitCode: null, forced: false, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  try {
    if (signal?.aborted) throw new RunError("cancelled", "Run cancelled");
    transport = options.transportFactory?.() ?? new ProcessTransport(gameCommand(seed), ROOT, limits.maxOutputBytes);
    let frame = await transport.next(remaining(), signal);
    store.observe(id, seq++, frame);
    if (frame.kind !== "prompt") throw new RunError("unexpected_exit", "Game exited before its startup prompt");
    const history: DecisionContext["history"] = [];
    for (let index = 0; ; index++) {
      if (options.plannedCommands !== null && index >= options.plannedCommands) break;
      if (index >= limits.maxCommands) throw new RunError("turn_limit", "Command-attempt limit reached");
      remaining();
      if (signal?.aborted) throw new RunError("cancelled", "Run cancelled");
      const command = await within(options.decide({ episode: id, observation: seq - 1, frame,
        history, remainingMs: () => Math.max(0, deadline - performance.now()), signal }), deadline - performance.now(), signal);
      if (command === null) break;
      if (typeof command !== "string" || /[\r\n\0]/.test(command) || Buffer.byteLength(command) > 4096) {
        throw new RunError("invalid_command", "Policy returned an invalid command line");
      }
      history.push({ observation: frame.raw.toString("utf8"), command });
      store.intent(id, index, command);
      const sendMs = remaining();
      if (signal?.aborted) throw new RunError("cancelled", "Run cancelled");
      await within(transport.send(command), sendMs, signal);
      store.sent(id, index);
      frame = await transport.next(remaining(), signal);
      if (frame.kind === "eof" && frame.raw.length === 0) {
        store.observe(id, seq++, frame);
        throw new RunError("unexpected_exit", "Game exited without acknowledging the command");
      }
      store.observe(id, seq++, frame, index);
      if (frame.kind === "eof") { stopReason = "game_exit"; break; }
    }
    if (frame.kind === "prompt") {
      transport.endInput();
      frame = await transport.next(remaining(), signal);
      store.observe(id, seq++, frame);
      if (frame.kind !== "eof") throw new RunError("unexpected_output", "Received another prompt without sending a command");
    }
  } catch (caught) {
    status = "incomplete";
    stopReason = caught instanceof RunError ? caught.code : "runner_error";
    if (stopReason === "timeout" && performance.now() >= deadline) stopReason = "episode_limit";
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    if (transport) {
      try { result = await transport.close(); } catch (caught) {
        status = "incomplete"; stopReason = "cleanup_error";
        error = caught instanceof Error ? caught.message : String(caught);
      }
    }
  }
  if (status === "complete" && (result.exitCode !== 0 || result.forced)) {
    status = "incomplete"; stopReason = "unexpected_exit";
    error = "Game did not exit cleanly";
  }
  if (status === "complete" && result.fault) {
    status = "incomplete"; stopReason = result.fault;
    error = "Transport failed while draining output";
  }
  if (status === "complete") {
    const observed = Buffer.concat(store.get(id).observations.map(frame => frame.raw));
    if (!observed.equals(result.stdout)) {
      status = "incomplete"; stopReason = "unrecorded_output";
      error = "Captured stdout differs from recorded observations";
    }
  }
  // Catch edits during an episode, not just between record and replay.
  if (status === "complete") {
    try {
      if (JSON.stringify(await identityProvider()) !== JSON.stringify(config.game)) {
        status = "incomplete"; stopReason = "game_changed";
        error = "Game source changed while recording";
      }
    } catch (caught) {
      status = "incomplete"; stopReason = "game_changed";
      error = `Cannot verify game source after recording: ${caught instanceof Error ? caught.message : String(caught)}`;
    }
  }
  store.finish(id, { ...result, status, stopReason, error });
  return store.get(id);
}
