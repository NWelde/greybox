import { AdapterError, type AdapterExample, type AdapterExecutor, type AdapterInput, type AdapterMode } from "./adapter-contracts";
import { authorRequest } from "./adapter-prompts";
import type { ModelSettings, ObservedView } from "./contracts";
import type { ModelSession } from "./model-session";
import { parseDecision } from "./prompts";
import type { DecisionContext } from "./runner";
import type { Store } from "./store";
import { RunError } from "./transport";

export const DEFAULT_ADAPTERS = {
  synthesizeAfter: 10, timeoutMs: 1000, maxRepairAttempts: 2,
  maxExamples: 12, maxExampleBytes: 32_768, generationMaxOutputTokens: 8192,
};
export interface AdapterOptions extends Partial<typeof DEFAULT_ADAPTERS> { mode: AdapterMode; executor: AdapterExecutor }
type Active = { id: string; source: string };

export class Adapters {
  readonly config;
  private active: Active | null = null;
  private broken: (Active & { reason: string }) | null = null;
  private synthesized = false;
  private examples: AdapterExample[] = [];

  constructor(private store: Store, private options: AdapterOptions, private model: ModelSession, private settings: ModelSettings) {
    const { executor, ...overrides } = options;
    this.config = { ...DEFAULT_ADAPTERS, ...overrides };
    const caps = { synthesizeAfter: 200, timeoutMs: 1000, maxRepairAttempts: 2, maxExamples: 32, maxExampleBytes: 65_536, generationMaxOutputTokens: 16_384 };
    for (const [key, cap] of Object.entries(caps)) {
      const value = this.config[key as keyof typeof caps];
      if (!Number.isSafeInteger(value) || value <= 0 || value > cap) throw new Error(`Invalid adapter ${key}`);
    }
    if (!["frozen", "repair"].includes(this.config.mode)) throw new Error("Invalid adapter mode");
    if (settings.thinkingBudget !== null && settings.thinkingBudget >= this.config.generationMaxOutputTokens) throw new Error("Adapter output allowance must exceed the thinking budget");
  }

  private async execute(source: string, input: AdapterInput, context: DecisionContext) {
    if (context.signal?.aborted) throw new RunError("cancelled", "Run cancelled");
    if (context.remainingMs() <= 0) throw new RunError("episode_limit", "Episode deadline exceeded");
    const view = await this.options.executor.run(source, structuredClone({ raw: input.raw, previous: input.previous }), {
      timeoutMs: Math.min(this.config.timeoutMs, context.remainingMs()), signal: context.signal,
    });
    return parseDecision(JSON.stringify({ view, command: null, memory: "" }), input.previous ?? undefined).view;
  }

  async represent(context: DecisionContext, previous?: ObservedView): Promise<ObservedView | null> {
    const active = this.active;
    if (active) {
      try {
        const view = await this.execute(active.source, { raw: context.frame.raw.toString("utf8"), previous: previous ?? null }, context);
        this.store.adapterEvent(context.episode, { observation: context.observation, adapter: active.id, kind: "hit", reason: null });
        return view;
      } catch (error) {
        if (context.signal?.aborted) throw new RunError("cancelled", "Run cancelled");
        if (context.remainingMs() <= 0) throw new RunError("episode_limit", "Episode deadline exceeded");
        const reason = error instanceof AdapterError ? error.code : "schema";
        this.broken = { ...active, reason };
        this.active = null;
        this.store.adapterEvent(context.episode, { observation: context.observation, adapter: active.id, kind: "disabled", reason });
      }
    }
    this.store.adapterEvent(context.episode, { observation: context.observation, adapter: active?.id ?? null,
      kind: "fallback", reason: this.broken?.reason ?? "no_adapter" });
    return null;
  }

  remember(context: DecisionContext, previous: ObservedView | undefined, expected: ObservedView) {
    const example: AdapterExample = { observation: context.observation, raw: context.frame.raw.toString("utf8"), previous: previous ?? null, expected };
    this.examples.push(structuredClone(example));
    const size = () => Buffer.byteLength(JSON.stringify(this.examples)); // Serialized corpus bytes, including brackets and separators.
    // Evict older examples first. The newest example may be the very input that
    // broke the parser, so it is truncated rather than dropped when it cannot fit.
    while (this.examples.length > this.config.maxExamples ||
      (this.examples.length > 1 && size() > this.config.maxExampleBytes)) this.examples.shift();
    const newest = this.examples.at(-1)!;
    while (size() > this.config.maxExampleBytes && newest.raw.length > 0) {
      const over = size() - this.config.maxExampleBytes;
      newest.raw = newest.raw.slice(0, Math.max(0, newest.raw.length - Math.max(over, 1)));
      // Recorded so authoring is told the example is partial, never silently misled.
      newest.truncated = true;
    }
  }

  async maintain(context: DecisionContext) {
    const broken = this.broken;
    const cause = broken && this.config.mode === "repair" ? "repair"
      : !this.synthesized && context.observation >= this.config.synthesizeAfter ? "synthesis" : null;
    if (!cause || !this.examples.length) return;
    // Clear only once the incident is actually handled; an unhandled hard failure
    // must survive to a later turn instead of being silently discarded.
    this.broken = null;
    this.synthesized = true;
    const attempts = cause === "repair" ? this.config.maxRepairAttempts : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const id = this.store.startAdapter(context.episode, context.observation, cause, broken?.id ?? null, attempt);
      const request = { ...authorRequest({ examples: this.examples, parentSource: broken?.source ?? null,
        failure: broken?.reason ?? null, cause,
        settings: { ...this.settings, maxOutputTokens: this.config.generationMaxOutputTokens } }), adapterAttempt: id };
      // Model/billing uncertainty ends the episode; finish() preserves this pending attempt.
      const { reply, callId } = await this.model.call(context, request);
      let source: string;
      try {
        source = JSON.parse(reply.text).source;
        if (typeof source !== "string" || !source.trim() || Buffer.byteLength(source) > 32_768) throw new Error();
      } catch {
        this.store.finishAdapter(id, { status: "rejected", validation: null, error: "invalid_source", activationObservation: null });
        continue;
      }
      this.store.setAdapterSource(id, source, callId);
      let reason: string | null = null;
      let checked = 0;
      for (const example of this.examples) {
        try {
          const first = await this.execute(source, example, context);
          const second = await this.execute(source, example, context);
          if (JSON.stringify(first) !== JSON.stringify(second)) reason = "nondeterministic";
          else if (JSON.stringify(first) !== JSON.stringify(example.expected)) reason = "regression_mismatch";
          if (reason) break;
          checked++;
        } catch (error) {
          if (context.signal?.aborted) throw new RunError("cancelled", "Run cancelled");
          if (context.remainingMs() <= 0) throw new RunError("episode_limit", "Episode deadline exceeded");
          reason = error instanceof AdapterError ? error.code : "schema";
          break;
        }
      }
      this.store.finishAdapter(id, { status: reason ? "rejected" : "accepted",
        validation: { checked, total: this.examples.length, observations: this.examples.map(example => example.observation),
          corpus: "prior_player_interpretations", deterministicRepeats: 2 },
        error: reason, activationObservation: reason ? null : context.observation + 1 });
      if (!reason) {
        this.active = { id, source };
        this.store.adapterEvent(context.episode, { observation: context.observation + 1, adapter: id, kind: "activated", reason: cause });
        break;
      }
    }
  }
}
