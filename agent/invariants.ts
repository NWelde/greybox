import type { InvariantResult, ObservedView } from "./contracts";

export function checkInvariants(view: ObservedView, observation: number,
  previousScore?: { value: number; observation: number }): InvariantResult[] {
  const hpKnown = view.hp.source === "observed" && view.maxHp.source === "observed" &&
    view.hp.value !== null && view.maxHp.value !== null;
  const scoreKnown = view.score.source === "observed" && view.score.value !== null && previousScore !== undefined;
  return [
    { invariant: "hp_at_most_max", version: 1, observation, previousObservation: null,
      status: !hpKnown ? "unevaluated" : view.hp.value! > view.maxHp.value! ? "violated" : "passed",
      evidence: hpKnown ? { hp: view.hp.value, maxHp: view.maxHp.value } : {} },
    { invariant: "cumulative_score", version: 1, observation,
      previousObservation: scoreKnown ? previousScore!.observation : null,
      status: !scoreKnown ? "unevaluated" : view.score.value! < previousScore!.value ? "violated" : "passed",
      evidence: scoreKnown ? { previousScore: previousScore!.value, score: view.score.value } : {} },
  ];
}
