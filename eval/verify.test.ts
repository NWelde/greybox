import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InvariantResult } from "../agent/contracts";
import { replay } from "../agent/replay";
import { runScript } from "../agent/runner";
import { Store, type Episode, type Limits } from "../agent/store";
import { verifyEpisode } from "./verify";

const directories: string[] = [];
const stores: Store[] = [];

async function record(
  commands: string[],
  limits: Partial<Limits> = {},
): Promise<{ episode: Episode; store: Store }> {
  const directory = await mkdtemp(join(tmpdir(), "greybox-verify-"));
  directories.push(directory);
  const store = new Store(join(directory, "trace.sqlite"));
  stores.push(store);
  const episode = await runScript({
    store,
    seed: 42,
    commands,
    limits: { responseMs: 1_000, ...limits },
  });
  return { episode, store };
}

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("verifyEpisode", () => {
  test("confirms the reachable overheal bug from exact oracle evidence", async () => {
    const { episode } = await record(["north", "north", "take", "drink"]);
    const candidate: InvariantResult = {
      invariant: "hp_at_most_max",
      version: 1,
      status: "violated",
      observation: 4,
      previousObservation: null,
      evidence: { hp: 13, maxHp: 10 },
    };

    const report = await verifyEpisode(episode, [candidate]);

    expect(report.verified).toBe(true);
    expect(report.outcome).toBe("playing");
    expect(report.findings).toEqual([
      expect.objectContaining({
        invariant: "hp_at_most_max",
        observation: 4,
        status: "confirmed",
        origin: "policy_candidate",
        evidence: { hp: 13, maxHp: 10 },
      }),
    ]);
  });

  test("finds the reachable cumulative-score bug independently", async () => {
    const { episode } = await record([
      "south", "west", "west", "west", "west", "take", "drop coin",
    ]);

    const report = await verifyEpisode(episode);

    expect(report.verified).toBe(true);
    expect(report.findings).toEqual([
      expect.objectContaining({
        invariant: "cumulative_score",
        observation: 7,
        previousObservation: 6,
        status: "confirmed",
        origin: "oracle_scan",
        evidence: { previousScore: 5, score: 0 },
      }),
    ]);
  });

  test("confirms a score candidate against the player's earlier observed predecessor", async () => {
    const { episode } = await record([
      "south", "west", "west", "west", "west", "take", "wait", "drop coin",
    ]);
    const candidate: InvariantResult = {
      invariant: "cumulative_score",
      version: 1,
      status: "violated",
      observation: 8,
      previousObservation: 6,
      evidence: { previousScore: 5, score: 0 },
    };

    const report = await verifyEpisode(episode, [candidate]);

    expect(report.verified).toBe(true);
    expect(report.findings).toEqual([
      expect.objectContaining({
        invariant: "cumulative_score",
        observation: 8,
        previousObservation: 6,
        status: "confirmed",
        origin: "policy_candidate",
      }),
    ]);
  });

  test("rejects fabricated score endpoints and an error-only predecessor", async () => {
    const { episode } = await record([
      "south", "west", "west", "west", "west", "take", "nonsense", "drop coin",
    ]);
    const candidates: InvariantResult[] = [
      {
        invariant: "cumulative_score",
        version: 1,
        status: "violated",
        observation: 8,
        previousObservation: 6,
        evidence: { previousScore: 4, score: 0 },
      },
      {
        invariant: "cumulative_score",
        version: 1,
        status: "violated",
        observation: 8,
        previousObservation: 6,
        evidence: { previousScore: 5, score: 1 },
      },
      {
        invariant: "cumulative_score",
        version: 1,
        status: "violated",
        observation: 8,
        previousObservation: 7,
        evidence: { previousScore: 5, score: 0 },
      },
    ];

    const report = await verifyEpisode(episode, candidates);

    expect(report.verified).toBe(true);
    expect(report.findings.slice(0, 3).map((finding) => finding.status)).toEqual([
      "rejected", "rejected", "rejected",
    ]);
    expect(report.findings[3]).toEqual(expect.objectContaining({
      invariant: "cumulative_score",
      observation: 8,
      status: "confirmed",
      origin: "oracle_scan",
      evidence: { previousScore: 5, score: 0 },
    }));
  });

  test("has no findings for a normal negative control, including an error-only response", async () => {
    const { episode } = await record(["nonsense", "wait"]);

    const report = await verifyEpisode(episode, [{
      invariant: "hp_at_most_max",
      version: 1,
      status: "passed",
      observation: 2,
      previousObservation: null,
      evidence: { hp: 10, maxHp: 10 },
    }]);

    expect(report.verified).toBe(true);
    expect(report.findings).toEqual([]);
  });

  test("rejects fabricated parser evidence even when the real bug exists", async () => {
    const { episode } = await record(["north", "north", "take", "drink"]);
    const fabricated: InvariantResult = {
      invariant: "hp_at_most_max",
      version: 1,
      status: "violated",
      observation: 4,
      previousObservation: null,
      evidence: { hp: 99, maxHp: 10 },
    };

    const report = await verifyEpisode(episode, [fabricated]);

    expect(report.verified).toBe(true);
    expect(report.findings[0]).toEqual(expect.objectContaining({
      status: "rejected",
      origin: "policy_candidate",
      evidence: { hp: 99, maxHp: 10 },
    }));
    expect(report.findings[1]).toEqual(expect.objectContaining({
      status: "confirmed",
      origin: "oracle_scan",
      evidence: { hp: 13, maxHp: 10 },
    }));
  });

  test("does not verify mismatched raw output or a changed source identity", async () => {
    const first = await record(["wait"]);
    first.episode.observations[1].raw = Buffer.from("fabricated\n> \n");
    first.episode.stdout = Buffer.concat(first.episode.observations.map((frame) => frame.raw));
    const rawReport = await verifyEpisode(first.episode);
    expect(rawReport.verified).toBe(false);
    expect(rawReport.reason).toContain("Observation 1 differs");

    const second = await record([]);
    second.episode.config.game.sourceHash = "changed";
    const sourceReport = await verifyEpisode(second.episode);
    expect(sourceReport.verified).toBe(false);
    expect(sourceReport.reason).toContain("does not match");
  });

  test("rejects noncontiguous sequences and unsafe recorded bounds", async () => {
    const first = await record(["wait"]);
    first.episode.observations[1].seq = 2;
    const sequenceReport = await verifyEpisode(first.episode);
    expect(sequenceReport.verified).toBe(false);
    expect(sequenceReport.reason).toContain("sequence numbers");

    const second = await record([]);
    second.episode.config.limits.maxCommands = 201;
    const boundsReport = await verifyEpisode(second.episode);
    expect(boundsReport.verified).toBe(false);
    expect(boundsReport.reason).toContain("at most 200");
  });

  test("verifies only the acknowledged prefix and ignores an uncertain command", async () => {
    const { episode } = await record([
      "south", "west", "west", "west", "west", "take",
    ]);
    episode.status = "incomplete";
    episode.stopReason = "token_budget";
    episode.commands.push({
      seq: episode.commands.length,
      text: "drop coin",
      status: "indeterminate",
    });

    const report = await verifyEpisode(episode);

    expect(report.verified).toBe(true);
    expect(report.throughObservation).toBe(6);
    expect(report.findings).toEqual([]);
  });

  test("allows a planned script beyond maxCommands and verifies its executed prefix", async () => {
    const { episode } = await record(["wait", "wait"], { maxCommands: 1 });

    const report = await verifyEpisode(episode);

    expect(episode.config.plannedCommands).toBe(2);
    expect(episode.status).toBe("incomplete");
    expect(episode.stopReason).toBe("turn_limit");
    expect(episode.commands).toHaveLength(1);
    expect(report.verified).toBe(true);
    expect(report.throughObservation).toBe(1);
    await expect(replay(episode)).rejects.toThrow("incomplete");
  });

  test("handles a terminal command prefix and reports its oracle outcome", async () => {
    const { episode } = await record(["north", "north", "west", "west", "wait"]);

    const report = await verifyEpisode(episode);

    expect(episode.stopReason).toBe("game_exit");
    expect(report.verified).toBe(true);
    expect(report.outcome).toBe("win");
    expect(report.throughObservation).toBe(4);
  });

  test("is read-only with respect to stored episodes and candidate evidence", async () => {
    const { episode, store } = await record(["wait"]);
    const before = store.get(episode.id);
    const candidates: InvariantResult[] = [{
      invariant: "cumulative_score",
      version: 1,
      status: "unevaluated",
      observation: 1,
      previousObservation: 0,
      evidence: {},
    }];
    const candidateSnapshot = structuredClone(candidates);

    await verifyEpisode(episode, candidates);

    expect(store.get(episode.id)).toEqual(before);
    expect(candidates).toEqual(candidateSnapshot);
  });
});
