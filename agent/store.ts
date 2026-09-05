import { Database } from "bun:sqlite";
import type { Frame } from "./framing";
import type { GameIdentity } from "./game";
import { UNKNOWN_USAGE, type InvariantResult, type ModelRequest, type ModelSettings, type ObservedView, type Usage, type VerificationReport } from "./contracts";

export interface Limits {
  maxCommands: number;
  responseMs: number;
  episodeMs: number;
  maxOutputBytes: number;
}

export interface RunConfig {
  seed: number;
  game: GameIdentity;
  limits: Limits;
  condition: "scripted" | "raw";
  plannedCommands: number | null;
  player?: {
    settings: ModelSettings; promptVersion: string; promptHash: string;
    tokenBudget: number; historyBytes: number; memoryChars: number;
    callMs: number; retries: number;
  };
}

export interface CallRecord {
  id: number; observation: number; attempt: number; request: ModelRequest;
  status: "in_flight" | "succeeded" | "failed" | "indeterminate";
  response: unknown; usage: Usage; modelVersion: string | null;
  latencyMs: number | null; error: string | null;
}

export interface Episode {
  id: string;
  config: RunConfig;
  status: "running" | "complete" | "incomplete";
  stopReason: string | null;
  error: string | null;
  exitCode: number | null;
  exitSignal: string | null;
  forced: boolean;
  stdout: Buffer;
  stderr: Buffer;
  observations: (Frame & { seq: number })[];
  commands: { seq: number; text: string; status: string }[];
  calls: CallRecord[];
  interpretations: { observation: number; view: ObservedView }[];
  invariants: InvariantResult[];
  verifications: VerificationReport[];
}

export class Store {
  private db: Database;
  private version: number;

  constructor(path: string, readonly = false) {
    this.db = new Database(path, { readonly, create: !readonly, strict: true });
    this.db.run("PRAGMA foreign_keys = ON");
    const version = (this.db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    this.version = version;
    if ((readonly && ![2, 3].includes(version)) || (!readonly && ![0, 1, 2, 3].includes(version))) {
      this.db.close();
      throw new Error(`Unsupported trace schema ${version}`);
    }
    if (!readonly) {
      this.db.run("PRAGMA journal_mode = WAL");
      this.db.run("PRAGMA synchronous = FULL");
      this.db.run(`
        CREATE TABLE IF NOT EXISTS episodes (
          id TEXT PRIMARY KEY, config TEXT NOT NULL, started_at TEXT NOT NULL,
          finished_at TEXT, status TEXT NOT NULL DEFAULT 'running',
          stop_reason TEXT, error TEXT, exit_code INTEGER, exit_signal TEXT, forced INTEGER NOT NULL DEFAULT 0,
          stdout BLOB NOT NULL DEFAULT X'', stderr BLOB NOT NULL DEFAULT X''
        );
        CREATE TABLE IF NOT EXISTS observations (
          episode_id TEXT NOT NULL REFERENCES episodes(id), seq INTEGER NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('prompt','eof')), raw BLOB NOT NULL,
          PRIMARY KEY(episode_id, seq)
        );
        CREATE TABLE IF NOT EXISTS commands (
          episode_id TEXT NOT NULL REFERENCES episodes(id), seq INTEGER NOT NULL,
          text TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('intent','sent','complete','indeterminate')),
          PRIMARY KEY(episode_id, seq)
        );
      `);
      if (version === 1) this.db.run("ALTER TABLE episodes ADD COLUMN exit_signal TEXT");
      this.db.run(`
        CREATE TABLE IF NOT EXISTS model_calls (
          id INTEGER PRIMARY KEY, episode_id TEXT NOT NULL REFERENCES episodes(id),
          observation INTEGER NOT NULL, attempt INTEGER NOT NULL, request TEXT NOT NULL,
          status TEXT NOT NULL, response TEXT, usage TEXT NOT NULL, model_version TEXT,
          latency_ms INTEGER, error TEXT, started_at TEXT NOT NULL, finished_at TEXT
        );
        CREATE TABLE IF NOT EXISTS interpretations (
          episode_id TEXT NOT NULL REFERENCES episodes(id), observation INTEGER NOT NULL,
          view TEXT NOT NULL, PRIMARY KEY(episode_id, observation)
        );
        CREATE TABLE IF NOT EXISTS invariant_results (
          episode_id TEXT NOT NULL REFERENCES episodes(id), observation INTEGER NOT NULL,
          invariant TEXT NOT NULL, result TEXT NOT NULL,
          PRIMARY KEY(episode_id, observation, invariant)
        );
        CREATE TABLE IF NOT EXISTS verifications (
          id INTEGER PRIMARY KEY, episode_id TEXT NOT NULL REFERENCES episodes(id),
          report TEXT NOT NULL, created_at TEXT NOT NULL
        );
        PRAGMA user_version = 3;
      `);
      this.version = 3;
    }
  }

  start(config: RunConfig): string {
    const id = crypto.randomUUID();
    this.db.query("INSERT INTO episodes (id, config, started_at) VALUES (?, ?, ?)")
      .run(id, JSON.stringify(config), new Date().toISOString());
    return id;
  }

  observe(id: string, seq: number, frame: Frame, commandSeq?: number) {
    this.db.transaction(() => {
      this.db.query("INSERT INTO observations VALUES (?, ?, ?, ?)").run(id, seq, frame.kind, frame.raw);
      if (commandSeq !== undefined) {
        this.db.query("UPDATE commands SET status = 'complete' WHERE episode_id = ? AND seq = ?").run(id, commandSeq);
      }
    })();
  }

  intent(id: string, seq: number, text: string) {
    this.db.query("INSERT INTO commands VALUES (?, ?, ?, 'intent')").run(id, seq, text);
  }

  sent(id: string, seq: number) {
    this.db.query("UPDATE commands SET status = 'sent' WHERE episode_id = ? AND seq = ?").run(id, seq);
  }

  startCall(id: string, observation: number, attempt: number, request: ModelRequest): number {
    return Number(this.db.query(`INSERT INTO model_calls
      (episode_id, observation, attempt, request, status, usage, started_at)
      VALUES (?, ?, ?, ?, 'in_flight', ?, ?)`).run(id, observation, attempt,
        JSON.stringify(request), JSON.stringify(UNKNOWN_USAGE), new Date().toISOString()).lastInsertRowid);
  }

  finishCall(id: number, record: Omit<CallRecord, "id" | "observation" | "attempt" | "request">) {
    this.db.query(`UPDATE model_calls SET status = ?, response = ?, usage = ?, model_version = ?,
      latency_ms = ?, error = ?, finished_at = ? WHERE id = ? AND status = 'in_flight'`)
      .run(record.status, JSON.stringify(record.response), JSON.stringify(record.usage), record.modelVersion,
        record.latencyMs, record.error, new Date().toISOString(), id);
  }

  interpret(id: string, observation: number, view: ObservedView, results: InvariantResult[]) {
    this.db.transaction(() => {
      this.db.query("INSERT INTO interpretations VALUES (?, ?, ?)").run(id, observation, JSON.stringify(view));
      for (const result of results) {
        this.db.query("INSERT INTO invariant_results VALUES (?, ?, ?, ?)").run(id, observation, result.invariant, JSON.stringify(result));
      }
    })();
  }

  verify(id: string, report: VerificationReport) {
    if (report.episode !== id) throw new Error("Verification episode mismatch");
    this.db.query("INSERT INTO verifications (episode_id, report, created_at) VALUES (?, ?, ?)")
      .run(id, JSON.stringify(report), new Date().toISOString());
  }

  finish(id: string, result: {
    status: "complete" | "incomplete"; stopReason: string; error: string | null;
    exitCode: number | null; exitSignal?: string | null; forced: boolean; stdout: Buffer; stderr: Buffer;
  }) {
    this.db.transaction(() => {
      this.db.query("UPDATE commands SET status = 'indeterminate' WHERE episode_id = ? AND status IN ('intent','sent')").run(id);
      this.db.query("UPDATE model_calls SET status = 'indeterminate' WHERE episode_id = ? AND status = 'in_flight'").run(id);
      this.db.query(`UPDATE episodes SET finished_at = ?, status = ?, stop_reason = ?, error = ?,
        exit_code = ?, exit_signal = ?, forced = ?, stdout = ?, stderr = ? WHERE id = ?`)
        .run(new Date().toISOString(), result.status, result.stopReason, result.error,
          result.exitCode, result.exitSignal ?? null, Number(result.forced), result.stdout, result.stderr, id);
    })();
  }

  get(id: string): Episode {
    const row = this.db.query("SELECT * FROM episodes WHERE id = ?").get(id) as any;
    if (!row) throw new Error(`Episode not found: ${id}`);
    const observations = this.db.query("SELECT seq, kind, raw FROM observations WHERE episode_id = ? ORDER BY seq").all(id) as any[];
    const commands = this.db.query("SELECT seq, text, status FROM commands WHERE episode_id = ? ORDER BY seq").all(id) as Episode["commands"];
    return {
      id, config: JSON.parse(row.config), status: row.status, stopReason: row.stop_reason,
      error: row.error, exitCode: row.exit_code, forced: Boolean(row.forced),
      exitSignal: row.exit_signal,
      stdout: Buffer.from(row.stdout), stderr: Buffer.from(row.stderr),
      observations: observations.map(frame => ({ ...frame, raw: Buffer.from(frame.raw) })),
      commands,
      calls: this.version < 3 ? [] : (this.db.query("SELECT * FROM model_calls WHERE episode_id = ? ORDER BY id").all(id) as any[]).map(call => ({
        id: call.id, observation: call.observation, attempt: call.attempt, request: JSON.parse(call.request),
        status: call.status, response: call.response === null ? null : JSON.parse(call.response),
        usage: JSON.parse(call.usage), modelVersion: call.model_version, latencyMs: call.latency_ms, error: call.error,
      })),
      interpretations: this.version < 3 ? [] : (this.db.query("SELECT observation, view FROM interpretations WHERE episode_id = ? ORDER BY observation").all(id) as any[])
        .map(row => ({ observation: row.observation, view: JSON.parse(row.view) })),
      invariants: this.version < 3 ? [] : (this.db.query("SELECT result FROM invariant_results WHERE episode_id = ? ORDER BY observation, invariant").all(id) as { result: string }[]).map(row => JSON.parse(row.result)),
      verifications: this.version < 3 ? [] : (this.db.query("SELECT report FROM verifications WHERE episode_id = ? ORDER BY id").all(id) as { report: string }[]).map(row => JSON.parse(row.report)),
    };
  }

  close() { this.db.close(); }
}
