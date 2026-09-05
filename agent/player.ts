import { type ModelClient, type ModelSettings, type ObservedView } from "./contracts";
import { Adapters, type AdapterOptions } from "./adapters";
import { AUTHOR_HASH, parseAction, structuredRequest, STRUCTURED_HASH } from "./adapter-prompts";
import { checkInvariants } from "./invariants";
import { ModelSession } from "./model-session";
import { buildRequest, parseDecision, PROMPT_HASH, PROMPT_VERSION } from "./prompts";
import { runEpisode, type SessionOptions } from "./runner";
import { RunError } from "./transport";

export const DEFAULT_MODEL: ModelSettings = {
  model: "gemini-2.5-flash", maxOutputTokens: 2048, thinkingBudget: 512, temperature: 0.2,
};
export interface PlayerOptions extends SessionOptions {
  client: ModelClient; settings?: Partial<ModelSettings>;
  tokenBudget?: number; callMs?: number; retries?: number;
  historyBytes?: number; memoryChars?: number;
  adapters?: AdapterOptions;
  modelIntervalMs?: number;
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
  const modelIntervalMs = options.modelIntervalMs ?? 0;
  if (!Number.isSafeInteger(modelIntervalMs) || modelIntervalMs < 0 || modelIntervalMs > 60_000) throw new Error("Invalid modelIntervalMs");
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
  const model = new ModelSession({ store: options.store, client: options.client, tokenBudget, callMs, retries, modelIntervalMs });
  const adapters = options.adapters ? new Adapters(options.store, options.adapters, model, settings) : null;
  const policyHistory: { observation: string; command: string }[] = [];
  return runEpisode({ ...options, condition: adapters?.config.mode ?? "raw", plannedCommands: null, stopReason: "model_stop",
    player: { settings, tokenBudget, callMs, retries, historyBytes, memoryChars, modelIntervalMs, promptVersion: PROMPT_VERSION, promptHash: PROMPT_HASH,
      ...(adapters ? { adapters: adapters.config, structuredPromptHash: STRUCTURED_HASH, authorPromptHash: AUTHOR_HASH } : {}) },
    decide: async context => {
      const raw = context.frame.raw.toString("utf8");
      const adapted = await adapters?.represent(context, previous);
      const base = { history: adapters ? policyHistory : context.history, memory, previous, settings, historyBytes, memoryChars };
      const request = adapted ? structuredRequest({ ...base, view: adapted })
        : { ...buildRequest({ ...base, raw }), purpose: "raw_decision" as const };
      const { reply } = await model.call(context, request);
      let decision;
      try { decision = adapted ? parseAction(reply.text, adapted, memoryChars) : parseDecision(reply.text, previous, memoryChars); }
      catch { throw new RunError("invalid_decision", "Model response failed decision validation; see saved call"); }
      const invariants = checkInvariants(decision.view, context.observation, previousScore);
      options.store.interpret(context.episode, context.observation, decision.view, invariants);
      adapters?.remember(context, previous, decision.view);
      if (decision.view.score.source === "observed" && decision.view.score.value !== null) {
        previousScore = { value: decision.view.score.value, observation: context.observation };
      }
      previous = decision.view;
      memory = decision.memory;
      if (decision.command !== null) {
        policyHistory.push({ observation: adapted ? JSON.stringify(adapted) : raw, command: decision.command });
        await adapters?.maintain(context);
      }
      options.progress?.({ episode: context.episode, observation: context.observation, command: decision.command, tokens: model.used });
      return decision.command;
    },
  });
}
