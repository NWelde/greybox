export type Provenance = "observed" | "retained" | "unknown";
export interface Fact<T> { value: T | null; source: Provenance }
export interface ObservedView {
  kind: "state" | "error" | "terminal" | "unknown";
  hp: Fact<number>;
  maxHp: Fact<number>;
  score: Fact<number>;
  grid: Fact<string[]>;
  position: Fact<{ x: number; y: number }>;
  inventory: Fact<string[]>;
}
export interface Decision {
  view: ObservedView;
  command: string | null;
  memory: string;
}

export interface ModelSettings {
  model: string;
  maxOutputTokens: number;
  thinkingBudget: number | null;
  thinkingLevel?: "minimal" | "low" | "medium" | "high";
  temperature: number;
}
export interface Usage {
  promptTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  cachedTokens: number | null;
  totalTokens: number | null;
}
export const UNKNOWN_USAGE: Usage = {
  promptTokens: null, outputTokens: null, thinkingTokens: null,
  cachedTokens: null, totalTokens: null,
};
export interface ModelRequest {
  purpose?: "raw_decision" | "structured_decision" | "adapter_synthesis" | "adapter_repair";
  adapterAttempt?: string;
  system: string;
  input: string;
  schema: Record<string, unknown>;
  settings: ModelSettings;
}
export interface ModelReply {
  text: string;
  usage: Usage;
  modelVersion: string | null;
  finishReason: string | null;
  // Safe provider JSON, with credentials removed even if the server echoes them.
  response: unknown;
}
export interface ModelClient {
  generate(request: ModelRequest, signal: AbortSignal): Promise<ModelReply>;
}
export class ModelError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryable = false,
    public usage: Usage = { ...UNKNOWN_USAGE },
    public response: unknown = null,
    public retryAfterMs: number | null = null,
  ) { super(message); this.name = "ModelError"; }
}

export interface InvariantResult {
  invariant: "hp_at_most_max" | "cumulative_score";
  version: number;
  status: "passed" | "violated" | "unevaluated";
  observation: number;
  previousObservation: number | null;
  evidence: Record<string, unknown>;
}
export interface VerificationFinding {
  invariant: InvariantResult["invariant"];
  version: number;
  observation: number;
  previousObservation: number | null;
  status: "confirmed" | "rejected" | "unverified";
  origin: "policy_candidate" | "oracle_scan";
  evidence: Record<string, unknown>;
  reason: string;
}
export interface VerificationReport {
  episode: string;
  verified: boolean;
  reason: string;
  throughObservation: number;
  outcome: "win" | "lose" | "playing" | "unknown";
  findings: VerificationFinding[];
}
