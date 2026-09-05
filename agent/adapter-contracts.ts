import type { ObservedView } from "./contracts";

export type AdapterMode = "frozen" | "repair";
export interface AdapterInput { raw: string; previous: ObservedView | null }
export interface AdapterExample extends AdapterInput { observation: number; expected: ObservedView; truncated?: boolean }
export interface AdapterExecutor {
  run(source: string, input: AdapterInput, options: { timeoutMs: number; signal?: AbortSignal }): Promise<ObservedView>;
}
export class AdapterError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = "AdapterError"; }
}
export interface AdapterRecord {
  id: string; episode: string; parent: string | null;
  cause: "synthesis" | "repair"; observation: number; attempt: number;
  source: string | null; sourceHash: string | null; callId: number | null;
  status: "pending" | "accepted" | "rejected" | "indeterminate";
  validation: unknown; error: string | null;
  activationObservation: number | null;
}
export interface AdapterEvent {
  observation: number; adapter: string | null;
  kind: "hit" | "fallback" | "activated" | "disabled";
  reason: string | null;
}
