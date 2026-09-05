import { ModelError, UNKNOWN_USAGE, type ModelClient, type ModelSettings, type ObservedView } from "./contracts";
import { checkInvariants } from "./invariants";
import { buildRequest, parseDecision, PROMPT_HASH, PROMPT_VERSION } from "./prompts";
import { runEpisode, type SessionOptions } from "./runner";
import { RunError, within } from "./transport";

export const DEFAULT_MODEL: ModelSettings = {
  model: "gemini-2.5-flash", maxOutputTokens: 2048, thinkingBudget: 512, temperature: 0.2,
};
export interface PlayerOptions extends SessionOptions {
  client: ModelClient; settings?: Partial<ModelSettings>;
  tokenBudget?: number; callMs?: number; retries?: number;
  historyBytes?: number; memoryChars?: number;
  progress?: (event: { episode: string; observation: number; command: string | null; tokens: number }) => void;
}

export async function runPlayer(options: PlayerOptions) {
  const settings = { ...DEFAULT_MODEL, ...options.settings };
  if (settings.thinkingLevel !== undefined) {
    if (!["minimal", "low", "medium", "high"].includes(settings.thinkingLevel) || !settings.model.startsWith("gemini-3")) {
      throw new Error("Thinking level requires a Gemini 3 model and minimal, low, medium, or high");
    }
    if (options.settings?.thinkingBudget != null) throw new Error("Choose a thinking level or a thinking budget, not both");
    settings.thinkingBudget = null;
  }
  const tokenBudget = options.tokenBudget ?? 100_000;
  const callMs = options.callMs ?? 60_000;
  const retries = options.retries ?? 1;
  const historyBytes = options.historyBytes ?? 12_000;
  const memoryChars = options.memoryChars ?? 1500;
  for (const [key, value] of Object.entries({ tokenBudget, callMs, historyBytes, memoryChars, maxOutputTokens: settings.maxOutputTokens })) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 1_000_000) throw new Error(`Invalid ${key}`);
  }
  if (!Number.isInteger(retries) || retries < 0 || retries > 2) throw new Error("Retries must be 0–2");
  if (!/^gemini-[a-zA-Z0-9._-]+$/.test(settings.model)) throw new Error("Invalid Gemini model identifier");
  if (!settings.thinkingLevel && (!Number.isInteger(settings.thinkingBudget) || settings.thinkingBudget! < 0 || settings.thinkingBudget! >= settings.maxOutputTokens)) throw new Error("Thinking budget must be nonnegative and less than max output tokens");
  if (!Number.isFinite(settings.temperature) || settings.temperature < 0 || settings.temperature > 2) throw new Error("Invalid temperature");

  let memory = "";
  let previous: ObservedView | undefined;
  let previousScore: { value: number; observation: number } | undefined;
  let used = 0;
  return runEpisode({ ...options, condition: "raw", plannedCommands: null, stopReason: "model_stop",
    player: { settings, tokenBudget, callMs, retries, historyBytes, memoryChars, promptVersion: PROMPT_VERSION, promptHash: PROMPT_HASH },
    decide: async context => {
      const request = buildRequest({ raw: context.frame.raw.toString("utf8"), history: context.history,
        memory, previous, settings, historyBytes, memoryChars });
      // Bytes conservatively approximate text tokens; include schema and framing overhead.
      const reservation = Buffer.byteLength(JSON.stringify(request)) + settings.maxOutputTokens + 256;
      for (let attempt = 0; attempt <= retries; attempt++) {
        if (used + reservation > tokenBudget) throw new RunError("token_limit", "Insufficient token budget for another request");
        if (context.signal?.aborted) throw new RunError("cancelled", "Run cancelled");
        if (context.remainingMs() <= 0) throw new RunError("episode_limit", "Episode deadline exceeded");
        const callId = options.store.startCall(context.episode, context.observation, attempt, request);
        const controller = new AbortController();
        const abort = () => controller.abort();
        context.signal?.addEventListener("abort", abort, { once: true });
        const started = performance.now();
        let reply;
        let error: ModelError | undefined;
        try {
          const remaining = Math.min(callMs, context.remainingMs());
          if (remaining <= 0) throw new RunError("episode_limit", "Episode deadline exceeded before model request");
          if (context.signal?.aborted) throw new RunError("cancelled", "Run cancelled");
          reply = await within(options.client.generate(request, controller.signal), remaining, context.signal);
        } catch (caught) {
          error = caught instanceof ModelError ? caught : new ModelError(
            context.signal?.aborted ? "cancelled" : caught instanceof RunError ? caught.code : "network_error",
            context.signal?.aborted ? "Model request cancelled" : "Model request failed or exceeded its deadline", false);
        } finally {
          controller.abort();
          context.signal?.removeEventListener("abort", abort);
        }
        const usage = reply?.usage ?? error?.usage ?? { ...UNKNOWN_USAGE };
        const usageKnown = Number.isSafeInteger(usage.totalTokens) && usage.totalTokens! >= 0;
        if (usageKnown) used += usage.totalTokens!;
        options.store.finishCall(callId, {
          status: error ? "failed" : "succeeded", response: reply?.response ?? error?.response ?? null,
          usage, modelVersion: reply?.modelVersion ?? null,
          latencyMs: Math.round(performance.now() - started), error: error ? `${error.code}: ${error.message}` : null,
        });
        if (error) {
          if (usageKnown && error.retryable && attempt < retries && used + reservation <= tokenBudget) {
            const wait = error.retryAfterMs ?? 500 * (attempt + 1);
            // A bounded retry must not turn a provider's minimum delay into an early retry.
            if (!Number.isFinite(wait) || wait < 0 || wait > 10_000) {
              throw new RunError(error.code, "Provider retry delay exceeds the bounded retry allowance");
            }
            if (wait >= context.remainingMs()) throw new RunError("episode_limit", "Retry would exceed episode deadline");
            await within(Bun.sleep(wait), context.remainingMs(), context.signal);
            continue;
          }
          throw new RunError(error.code, error.message);
        }
        if (!usageKnown) throw new RunError("usage_unknown", "Provider omitted total usage; stopping further calls");
        if (used > tokenBudget) throw new RunError("token_limit", "Provider-reported usage exceeded the admission budget");
        let decision;
        try { decision = parseDecision(reply!.text, previous, memoryChars); }
        catch { throw new RunError("invalid_decision", "Model response failed decision validation; see saved call"); }
        const invariants = checkInvariants(decision.view, context.observation, previousScore);
        options.store.interpret(context.episode, context.observation, decision.view, invariants);
        if (decision.view.score.source === "observed" && decision.view.score.value !== null) {
          previousScore = { value: decision.view.score.value, observation: context.observation };
        }
        previous = decision.view;
        memory = decision.memory;
        options.progress?.({ episode: context.episode, observation: context.observation, command: decision.command, tokens: used });
        return decision.command;
      }
      throw new RunError("model_error", "Model attempts exhausted");
    },
  });
}
