import { ModelError, UNKNOWN_USAGE, type ModelClient, type ModelRequest } from "./contracts";
import type { DecisionContext } from "./runner";
import type { Store } from "./store";
import { RunError, within } from "./transport";

/** One accounting ledger for policy, authoring, and every allowed HTTP retry. */
export class ModelSession {
  used = 0;
  private lastStarted = -Infinity;
  constructor(private options: { store: Store; client: ModelClient; tokenBudget: number; callMs: number; retries: number; modelIntervalMs?: number }) {}

  async call(context: DecisionContext, request: ModelRequest) {
    const { store, client, tokenBudget, callMs, retries } = this.options;
    const reservation = Buffer.byteLength(JSON.stringify(request)) + request.settings.maxOutputTokens + 256;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (this.used + reservation > tokenBudget) throw new RunError("token_limit", "Insufficient token budget for another request");
      if (context.signal?.aborted) throw new RunError("cancelled", "Run cancelled");
      if (context.remainingMs() <= 0) throw new RunError("episode_limit", "Episode deadline exceeded");
      const pause = (this.options.modelIntervalMs ?? 0) - (performance.now() - this.lastStarted);
      if (pause > 0) {
        if (pause >= context.remainingMs()) throw new RunError("episode_limit", "Request pacing would exceed the episode deadline");
        await within(Bun.sleep(pause), context.remainingMs(), context.signal);
      }
      if (context.signal?.aborted) throw new RunError("cancelled", "Run cancelled");
      if (context.remainingMs() <= 0) throw new RunError("episode_limit", "Episode deadline exceeded");
      const callId = store.startCall(context.episode, context.observation, attempt, request);
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
        this.lastStarted = performance.now();
        reply = await within(client.generate(request, controller.signal), remaining, context.signal);
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
      if (usageKnown) this.used += usage.totalTokens!;
      store.finishCall(callId, {
        status: error ? "failed" : "succeeded", response: reply?.response ?? error?.response ?? null,
        usage, modelVersion: reply?.modelVersion ?? null,
        latencyMs: Math.round(performance.now() - started), error: error ? `${error.code}: ${error.message}` : null,
      });
      if (error) {
        if (usageKnown && error.retryable && attempt < retries && this.used + reservation <= tokenBudget) {
          const wait = error.retryAfterMs ?? 500 * (attempt + 1);
          if (!Number.isFinite(wait) || wait < 0 || wait > 10_000) throw new RunError(error.code, "Provider retry delay exceeds the bounded retry allowance");
          if (wait >= context.remainingMs()) throw new RunError("episode_limit", "Retry would exceed episode deadline");
          await within(Bun.sleep(wait), context.remainingMs(), context.signal);
          continue;
        }
        throw new RunError(error.code, error.message);
      }
      if (!usageKnown) throw new RunError("usage_unknown", "Provider omitted total usage; stopping further calls");
      if (this.used > tokenBudget) throw new RunError("token_limit", "Provider-reported usage exceeded the admission budget");
      if (context.signal?.aborted) throw new RunError("cancelled", "Run cancelled");
      if (context.remainingMs() <= 0) throw new RunError("episode_limit", "Episode deadline exceeded");
      return { reply: reply!, callId };
    }
    throw new RunError("model_error", "Model attempts exhausted");
  }
}
