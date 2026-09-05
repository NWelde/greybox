import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  UNKNOWN_USAGE,
  type InvariantResult,
  type ModelRequest,
  type ObservedView,
  type VerificationReport,
} from "./contracts";
import { Store, type RunConfig } from "./store";

const directories: string[] = [];
const stores: Store[] = [];

async function temporaryDatabase(name = "trace.sqlite"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "greybox-store-"));
  directories.push(directory);
  return join(directory, name);
}

function openStore(path: string, readonly = false): Store {
  const store = new Store(path, readonly);
  stores.push(store);
  return store;
}

function closeStore(store: Store) {
  store.close();
  const index = stores.indexOf(store);
  if (index >= 0) stores.splice(index, 1);
}

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

const CONFIG: RunConfig = {
  seed: 42,
  game: {
    sourceHash: "source-hash",
    runtime: "bun-test-runtime",
    promptHex: "0a3e200a",
  },
  limits: {
    maxCommands: 12,
    responseMs: 1_000,
    episodeMs: 30_000,
    maxOutputBytes: 64 * 1024,
  },
  condition: "raw",
  plannedCommands: null,
  player: {
    settings: {
      model: "gemini-2.5-flash",
      maxOutputTokens: 256,
      thinkingBudget: null,
      thinkingLevel: "low",
      temperature: 0.2,
    },
    promptVersion: "raw-v1",
    promptHash: "prompt-hash",
    tokenBudget: 10_000,
    historyBytes: 4_096,
    memoryChars: 512,
    callMs: 2_000,
    retries: 1,
  },
};

const REQUEST: ModelRequest = {
  system: "Return one decision.",
  input: "Visible game output",
  schema: {
    type: "object",
    properties: { command: { type: ["string", "null"] } },
    required: ["command"],
  },
  settings: CONFIG.player!.settings,
};

const ADAPTER_CONFIG: RunConfig = {
  ...CONFIG,
  condition: "repair",
  player: {
    ...CONFIG.player!,
    structuredPromptHash: "structured-prompt-hash",
    authorPromptHash: "author-prompt-hash",
    adapters: {
      mode: "repair",
      synthesizeAfter: 10,
      timeoutMs: 1_000,
      maxRepairAttempts: 2,
      maxExamples: 12,
      maxExampleBytes: 32_768,
      generationMaxOutputTokens: 8_192,
    },
  },
};

const VIEW: ObservedView = {
  kind: "state",
  hp: { value: 13, source: "observed" },
  maxHp: { value: 10, source: "observed" },
  score: { value: 5, source: "observed" },
  grid: { value: [".@", "*#"], source: "observed" },
  position: { value: { x: 1, y: 0 }, source: "observed" },
  inventory: { value: ["potion"], source: "observed" },
};

const INVARIANT: InvariantResult = {
  invariant: "hp_at_most_max",
  version: 1,
  status: "violated",
  observation: 0,
  previousObservation: null,
  evidence: { hp: 13, maxHp: 10 },
};

describe("schema 4 persistence", () => {
  test("model calls, interpretations, invariants, and verification survive a SQLite reopen", async () => {
    const path = await temporaryDatabase();
    const store = openStore(path);
    const episode = store.start(CONFIG);
    const startup = Buffer.from([0x48, 0x50, 0x3a, 0x20, 0x31, 0x30, 0x0a, 0x3e, 0x20, 0x0a]);
    const response = Buffer.from("HP: 13/10 🧪\n> \n");
    const stdout = Buffer.concat([startup, response]);
    const stderr = Buffer.from([0x77, 0x61, 0x72, 0x6e, 0x00, 0xff]);

    store.observe(episode, 0, { kind: "prompt", raw: startup });
    const callId = store.startCall(episode, 0, 0, REQUEST);
    const usage = {
      promptTokens: 11,
      outputTokens: 7,
      thinkingTokens: 3,
      cachedTokens: 2,
      totalTokens: 21,
    };
    const providerResponse = {
      candidates: [{ content: { parts: [{ text: "{\"command\":\"drink\"}" }] } }],
      responseId: "provider-response-id",
    };
    store.finishCall(callId, {
      status: "succeeded",
      response: providerResponse,
      usage,
      modelVersion: "gemini-2.5-flash-001",
      latencyMs: 87,
      error: null,
    });
    store.interpret(episode, 0, VIEW, [INVARIANT]);

    const report: VerificationReport = {
      episode,
      verified: true,
      reason: "exact prefix verified",
      throughObservation: 0,
      outcome: "playing",
      findings: [{
        invariant: "hp_at_most_max",
        version: 1,
        observation: 0,
        previousObservation: null,
        status: "confirmed",
        origin: "policy_candidate",
        evidence: { hp: 13, maxHp: 10 },
        reason: "oracle state confirms visible output",
      }],
    };
    store.verify(episode, report);
    store.intent(episode, 0, "drink");
    store.sent(episode, 0);
    store.observe(episode, 1, { kind: "prompt", raw: response }, 0);
    store.finish(episode, {
      status: "complete",
      stopReason: "model_stop",
      error: null,
      exitCode: 0,
      exitSignal: null,
      forced: false,
      stdout,
      stderr,
    });
    closeStore(store);

    const reopened = openStore(path, true);
    const restored = reopened.get(episode);
    expect(restored.config).toEqual(CONFIG);
    expect(restored.status).toBe("complete");
    expect(restored.stopReason).toBe("model_stop");
    expect(restored.stdout).toEqual(stdout);
    expect(restored.stderr).toEqual(stderr);
    expect(restored.observations).toEqual([
      { seq: 0, kind: "prompt", raw: startup },
      { seq: 1, kind: "prompt", raw: response },
    ]);
    expect(restored.commands).toEqual([{ seq: 0, text: "drink", status: "complete" }]);
    expect(restored.calls).toEqual([{
      id: callId,
      observation: 0,
      attempt: 0,
      purpose: "raw_decision",
      request: REQUEST,
      status: "succeeded",
      response: providerResponse,
      usage,
      modelVersion: "gemini-2.5-flash-001",
      latencyMs: 87,
      error: null,
    }]);
    expect(restored.interpretations).toEqual([{ observation: 0, view: VIEW }]);
    expect(restored.invariants).toEqual([INVARIANT]);
    expect(restored.verifications).toEqual([report]);
    expect(restored.adapters).toEqual([]);
    expect(restored.adapterEvents).toEqual([]);
  });

  test("finishing an episode makes an in-flight model call indeterminate", async () => {
    const path = await temporaryDatabase();
    const store = openStore(path);
    const episode = store.start(CONFIG);
    const callId = store.startCall(episode, 3, 1, REQUEST);

    store.finish(episode, {
      status: "incomplete",
      stopReason: "cancelled",
      error: "cancelled during model call",
      exitCode: null,
      forced: true,
      stdout: Buffer.from("partial output"),
      stderr: Buffer.alloc(0),
    });
    closeStore(store);

    const restored = openStore(path, true).get(episode);
    expect(restored.calls).toEqual([{
      id: callId,
      observation: 3,
      attempt: 1,
      purpose: "raw_decision",
      request: REQUEST,
      status: "indeterminate",
      response: null,
      usage: UNKNOWN_USAGE,
      modelVersion: null,
      latencyMs: null,
      error: null,
    }]);
  });

  test("persists immutable adapter attempts, lineage, ordered events, and call purposes", async () => {
    const path = await temporaryDatabase();
    const store = openStore(path);
    const episode = store.start(ADAPTER_CONFIG);
    const authorRequest = {
      ...REQUEST,
      purpose: "adapter_synthesis",
    } satisfies ModelRequest;
    const callId = store.startCall(episode, 10, 0, authorRequest);
    const source = "export function parse(raw: string) { return raw; }\n";
    const sourceHash = createHash("sha256").update(source).digest("hex");

    const first = store.startAdapter(episode, 10, "synthesis", null, 0);
    store.setAdapterSource(first, source, callId);
    expect(() => store.setAdapterSource(first, `${source}// changed`, callId)).toThrow(
      "Adapter source cannot be set",
    );
    store.finishAdapter(first, {
      status: "accepted",
      validation: { examples: 10, deterministic: true },
      error: null,
      activationObservation: 11,
    });
    expect(() => store.finishAdapter(first, {
      status: "rejected",
      validation: null,
      error: "late overwrite",
      activationObservation: null,
    })).toThrow("Adapter is not pending");

    const repair = store.startAdapter(episode, 14, "repair", first, 2);
    store.finishAdapter(repair, {
      status: "rejected",
      validation: { stage: "authoring" },
      error: "model returned no source",
      activationObservation: null,
    });
    const pending = store.startAdapter(episode, 15, "repair", first, 3);

    store.adapterEvent(episode, {
      observation: 11,
      adapter: first,
      kind: "activated",
      reason: null,
    });
    store.adapterEvent(episode, {
      observation: 11,
      adapter: first,
      kind: "hit",
      reason: null,
    });
    store.adapterEvent(episode, {
      observation: 14,
      adapter: first,
      kind: "disabled",
      reason: "timeout",
    });
    store.adapterEvent(episode, {
      observation: 14,
      adapter: null,
      kind: "fallback",
      reason: "adapter_timeout",
    });
    closeStore(store);

    const readonlyStore = openStore(path, true);
    const beforeFinish = readonlyStore.get(episode);
    expect(beforeFinish.config).toEqual(ADAPTER_CONFIG);
    expect(beforeFinish.calls).toEqual([{
      id: callId,
      observation: 10,
      attempt: 0,
      purpose: "adapter_synthesis",
      request: authorRequest,
      status: "in_flight",
      response: null,
      usage: UNKNOWN_USAGE,
      modelVersion: null,
      latencyMs: null,
      error: null,
    }]);
    expect(beforeFinish.adapters).toEqual([
      {
        id: first,
        episode,
        parent: null,
        cause: "synthesis",
        observation: 10,
        attempt: 0,
        source,
        sourceHash,
        callId,
        status: "accepted",
        validation: { examples: 10, deterministic: true },
        error: null,
        activationObservation: 11,
      },
      {
        id: repair,
        episode,
        parent: first,
        cause: "repair",
        observation: 14,
        attempt: 2,
        source: null,
        sourceHash: null,
        callId: null,
        status: "rejected",
        validation: { stage: "authoring" },
        error: "model returned no source",
        activationObservation: null,
      },
      {
        id: pending,
        episode,
        parent: first,
        cause: "repair",
        observation: 15,
        attempt: 3,
        source: null,
        sourceHash: null,
        callId: null,
        status: "pending",
        validation: null,
        error: null,
        activationObservation: null,
      },
    ]);
    expect(beforeFinish.adapterEvents).toEqual([
      { observation: 11, adapter: first, kind: "activated", reason: null },
      { observation: 11, adapter: first, kind: "hit", reason: null },
      { observation: 14, adapter: first, kind: "disabled", reason: "timeout" },
      { observation: 14, adapter: null, kind: "fallback", reason: "adapter_timeout" },
    ]);
    closeStore(readonlyStore);

    const finishing = openStore(path);
    finishing.finish(episode, {
      status: "incomplete",
      stopReason: "cancelled",
      error: null,
      exitCode: null,
      forced: true,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    });
    closeStore(finishing);

    const afterFinish = openStore(path, true).get(episode);
    expect(afterFinish.adapters.map(adapter => adapter.status)).toEqual([
      "accepted",
      "rejected",
      "indeterminate",
    ]);
  });
});

interface V2Fixture {
  id: string;
  config: RunConfig;
  stdout: Buffer;
  stderr: Buffer;
  observation: Buffer;
  command: string;
}

function createV2Fixture(path: string): V2Fixture {
  const db = new Database(path, { create: true, strict: true });
  db.run(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE episodes (
      id TEXT PRIMARY KEY, config TEXT NOT NULL, started_at TEXT NOT NULL,
      finished_at TEXT, status TEXT NOT NULL DEFAULT 'running',
      stop_reason TEXT, error TEXT, exit_code INTEGER, exit_signal TEXT,
      forced INTEGER NOT NULL DEFAULT 0, stdout BLOB NOT NULL DEFAULT X'',
      stderr BLOB NOT NULL DEFAULT X''
    );
    CREATE TABLE observations (
      episode_id TEXT NOT NULL REFERENCES episodes(id), seq INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('prompt','eof')), raw BLOB NOT NULL,
      PRIMARY KEY(episode_id, seq)
    );
    CREATE TABLE commands (
      episode_id TEXT NOT NULL REFERENCES episodes(id), seq INTEGER NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('intent','sent','complete','indeterminate')),
      PRIMARY KEY(episode_id, seq)
    );
    PRAGMA user_version = 2;
  `);

  const fixture: V2Fixture = {
    id: "schema-2-episode",
    config: { ...CONFIG, condition: "scripted", plannedCommands: 1, player: undefined },
    stdout: Buffer.from([0x00, 0x73, 0x74, 0x64, 0x6f, 0x75, 0x74, 0xff]),
    stderr: Buffer.from([0xfe, 0x73, 0x74, 0x64, 0x65, 0x72, 0x72, 0x00]),
    observation: Buffer.from([0x00, 0x80, 0xff, 0x0a, 0x3e, 0x20, 0x0a]),
    command: "  café 🧪\u0000north  ",
  };
  db.query(`INSERT INTO episodes
    (id, config, started_at, finished_at, status, stop_reason, exit_code, exit_signal, forced, stdout, stderr)
    VALUES (?, ?, ?, ?, 'complete', 'script_complete', 0, NULL, 0, ?, ?)`)
    .run(fixture.id, JSON.stringify(fixture.config), "2026-09-05T00:00:00.000Z",
      "2026-09-05T00:00:01.000Z", fixture.stdout, fixture.stderr);
  db.query("INSERT INTO observations VALUES (?, 0, 'prompt', ?)")
    .run(fixture.id, fixture.observation);
  db.query("INSERT INTO commands VALUES (?, 0, ?, 'complete')")
    .run(fixture.id, fixture.command);
  db.close();
  return fixture;
}

function expectV2EpisodePreserved(store: Store, fixture: V2Fixture, expectNoCalls = true) {
  const episode = store.get(fixture.id);
  expect(episode.config).toEqual(fixture.config);
  expect(episode.status).toBe("complete");
  expect(episode.stopReason).toBe("script_complete");
  expect(episode.stdout).toEqual(fixture.stdout);
  expect(episode.stderr).toEqual(fixture.stderr);
  expect(episode.observations).toEqual([{
    seq: 0,
    kind: "prompt",
    raw: fixture.observation,
  }]);
  expect(episode.commands).toEqual([{
    seq: 0,
    text: fixture.command,
    status: "complete",
  }]);
  expect(Buffer.from(episode.commands[0].text)).toEqual(Buffer.from(fixture.command));
  if (expectNoCalls) expect(episode.calls).toEqual([]);
  expect(episode.interpretations).toEqual([]);
  expect(episode.invariants).toEqual([]);
  expect(episode.verifications).toEqual([]);
  expect(episode.adapters).toEqual([]);
  expect(episode.adapterEvents).toEqual([]);
}

describe("schema 2 compatibility", () => {
  test("readonly mode loads schema 2 without modifying it", async () => {
    const path = await temporaryDatabase();
    const fixture = createV2Fixture(path);
    const store = openStore(path, true);
    expectV2EpisodePreserved(store, fixture);
    closeStore(store);

    const inspection = new Database(path, { readonly: true, strict: true });
    const version = inspection.query("PRAGMA user_version").get() as { user_version: number };
    const modelCalls = inspection.query(
      "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'model_calls'",
    ).get() as { count: number };
    expect(version.user_version).toBe(2);
    expect(modelCalls.count).toBe(0);
    inspection.close();
  });

  test("writable mode migrates schema 2 to 4 without changing episode or command bytes", async () => {
    const path = await temporaryDatabase();
    const fixture = createV2Fixture(path);
    const migrating = openStore(path);
    closeStore(migrating);

    const reopened = openStore(path, true);
    expectV2EpisodePreserved(reopened, fixture);
    closeStore(reopened);

    const inspection = new Database(path, { readonly: true, strict: true });
    const version = inspection.query("PRAGMA user_version").get() as { user_version: number };
    const tables = inspection.query(`SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN (
        'model_calls', 'interpretations', 'invariant_results', 'verifications',
        'adapters', 'adapter_events'
      )
      ORDER BY name`).all() as { name: string }[];
    const purpose = inspection.query("PRAGMA table_info(model_calls)").all()
      .find((column: any) => column.name === "purpose") as any;
    expect(version.user_version).toBe(4);
    expect(tables.map(row => row.name)).toEqual([
      "adapter_events",
      "adapters",
      "interpretations",
      "invariant_results",
      "model_calls",
      "verifications",
    ]);
    expect(purpose.notnull).toBe(1);
    expect(purpose.dflt_value).toBe("'raw_decision'");
    inspection.close();
  });
});

interface V3Fixture {
  episode: V2Fixture;
  callId: number;
  requestText: string;
  responseText: string;
  usageText: string;
}

function createV3Fixture(path: string): V3Fixture {
  const episode = createV2Fixture(path);
  const db = new Database(path, { strict: true });
  db.run(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE model_calls (
      id INTEGER PRIMARY KEY, episode_id TEXT NOT NULL REFERENCES episodes(id),
      observation INTEGER NOT NULL, attempt INTEGER NOT NULL, request TEXT NOT NULL,
      status TEXT NOT NULL, response TEXT, usage TEXT NOT NULL, model_version TEXT,
      latency_ms INTEGER, error TEXT, started_at TEXT NOT NULL, finished_at TEXT
    );
    CREATE TABLE interpretations (
      episode_id TEXT NOT NULL REFERENCES episodes(id), observation INTEGER NOT NULL,
      view TEXT NOT NULL, PRIMARY KEY(episode_id, observation)
    );
    CREATE TABLE invariant_results (
      episode_id TEXT NOT NULL REFERENCES episodes(id), observation INTEGER NOT NULL,
      invariant TEXT NOT NULL, result TEXT NOT NULL,
      PRIMARY KEY(episode_id, observation, invariant)
    );
    CREATE TABLE verifications (
      id INTEGER PRIMARY KEY, episode_id TEXT NOT NULL REFERENCES episodes(id),
      report TEXT NOT NULL, created_at TEXT NOT NULL
    );
    PRAGMA user_version = 3;
  `);
  const requestText = JSON.stringify(REQUEST);
  const responseText = JSON.stringify({ text: "legacy-response", bytes: "\u0000ÿ" });
  const usageText = JSON.stringify({
    promptTokens: 9,
    outputTokens: 4,
    thinkingTokens: null,
    cachedTokens: 1,
    totalTokens: 13,
  });
  const inserted = db.query(`INSERT INTO model_calls
    (episode_id, observation, attempt, request, status, response, usage, model_version,
      latency_ms, error, started_at, finished_at)
    VALUES (?, 0, 1, ?, 'succeeded', ?, ?, 'legacy-model', 37, NULL, ?, ?)`)
    .run(
      episode.id,
      requestText,
      responseText,
      usageText,
      "2026-09-05T00:00:00.100Z",
      "2026-09-05T00:00:00.137Z",
    );
  const callId = Number(inserted.lastInsertRowid);
  db.close();
  return { episode, callId, requestText, responseText, usageText };
}

function expectV3CallPreserved(store: Store, fixture: V3Fixture) {
  const episode = store.get(fixture.episode.id);
  expect(episode.calls).toEqual([{
    id: fixture.callId,
    observation: 0,
    attempt: 1,
    purpose: "raw_decision",
    request: REQUEST,
    status: "succeeded",
    response: { text: "legacy-response", bytes: "\u0000ÿ" },
    usage: {
      promptTokens: 9,
      outputTokens: 4,
      thinkingTokens: null,
      cachedTokens: 1,
      totalTokens: 13,
    },
    modelVersion: "legacy-model",
    latencyMs: 37,
    error: null,
  }]);
  expect(episode.adapters).toEqual([]);
  expect(episode.adapterEvents).toEqual([]);
}

describe("schema 3 compatibility", () => {
  test("readonly mode loads calls with the legacy purpose without modifying the schema", async () => {
    const path = await temporaryDatabase();
    const fixture = createV3Fixture(path);
    const store = openStore(path, true);
    expectV2EpisodePreserved(store, fixture.episode, false);
    expectV3CallPreserved(store, fixture);
    closeStore(store);

    const inspection = new Database(path, { readonly: true, strict: true });
    const version = inspection.query("PRAGMA user_version").get() as { user_version: number };
    const purposeColumns = inspection.query("PRAGMA table_info(model_calls)").all()
      .filter((column: any) => column.name === "purpose");
    expect(version.user_version).toBe(3);
    expect(purposeColumns).toEqual([]);
    inspection.close();
  });

  test("writable mode migrates schema 3 to 4 without changing call serialization or trace bytes", async () => {
    const path = await temporaryDatabase();
    const fixture = createV3Fixture(path);
    const migrating = openStore(path);
    closeStore(migrating);

    const reopened = openStore(path, true);
    expectV2EpisodePreserved(reopened, fixture.episode, false);
    expectV3CallPreserved(reopened, fixture);
    closeStore(reopened);

    const inspection = new Database(path, { readonly: true, strict: true });
    const version = inspection.query("PRAGMA user_version").get() as { user_version: number };
    const call = inspection.query(`SELECT request, response, usage, purpose
      FROM model_calls WHERE id = ?`).get(fixture.callId) as {
        request: string; response: string; usage: string; purpose: string;
      };
    expect(version.user_version).toBe(4);
    expect(call).toEqual({
      request: fixture.requestText,
      response: fixture.responseText,
      usage: fixture.usageText,
      purpose: "raw_decision",
    });
    inspection.close();
  });
});
