import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { replay } from "./replay";
import { runScript } from "./runner";
import { Store, type Limits } from "./store";
import { geminiKey } from "./config";
import { GeminiClient } from "./gemini";
import { runPlayer } from "./player";
import { verifyEpisode } from "../eval/verify";
import { evaluateAdapter } from "../eval/adapter";
import type { ModelSettings } from "./contracts";
import { BubblewrapExecutor } from "./adapter-host";
import type { AdapterOptions } from "./adapters";
import type { AdapterRecord } from "./adapter-contracts";

const HELP = `Grey Box — raw/adapter Gemini player, recorded execution and verified findings

  bun run agent/main.ts play --seed 42 --max-commands 30 --token-budget 100000
  bun run agent/main.ts verify --episode <id>
  bun run agent/main.ts record --seed 42 --commands '["north","north","take","drink"]'
  bun run agent/main.ts replay --episode <id>
  bun run agent/main.ts show --episode <id>
  bun run agent/main.ts evaluate --episode <id> --adapter-episode <id>

Options:
  --db <path>              SQLite store (default: runs/greybox.sqlite)
  --max-commands <n>       Command-attempt limit (default/max: 200)
  --response-ms <n>        Startup/response deadline (default: 5000, max: 30000)
  --episode-ms <n>         Episode deadline (default/max: 300000)
  --max-output-bytes <n>   Combined stdout/stderr cap (default: 1048576, max: 16777216)

Play options:
  --model <id>            Gemini model (GEMINI_MODEL or gemini-2.5-flash)
  --token-budget <n>      Token admission budget (default: 100000)
  --call-ms <n>           Per-model-call deadline (default: 60000)
  --history-bytes <n>     Recent interaction cap (default: 12000)
  --memory-chars <n>      Working memory limit (default: 1500)
  --max-model-output <n>  Output allowance incl. thinking (default: 2048)
  --thinking-budget <n>   Thinking allowance (default: 512)
  --thinking-level <id>   Gemini 3: minimal/low/medium/high (instead of budget)
  --retries <n>           Transient retries, if usage known (default: 1)
  --model-interval-ms <n> Minimum gap between requests, including authoring (default: 0)

Adapter options (play only; Linux Bubblewrap required):
  --adapter-mode <id>     raw (default), frozen, or repair
  --synthesize-after <n>  Exchanges before initial synthesis (default: 10)
  --adapter-ms <n>        Isolated parser deadline, at most 1000 (default: 1000)
  --repair-attempts <n>   Candidates per hard failure, at most 2 (default: 2)
  --adapter-examples <n>  Retained regression examples, at most 32 (default: 12)
  --adapter-example-bytes <n> Corpus byte cap (default: 32768)
  --adapter-output-tokens <n> Authoring output allowance (default: 8192)

Evaluate options:
  --adapter-episode <id>  Episode whose accepted adapter is being evaluated
  --adapter <id>          Adapter record id (default: that episode's accepted adapter)
  --adapter-db <path>     Store for --adapter-episode (default: --db)
  --adapter-ms <n>        Isolated parser deadline, at most 1000 (default: 1000)

evaluate checks an accepted adapter against a separate withheld, independently
verified episode prefix. It makes no model calls and writes nothing to either store.

play reads GEMINI_API_KEY or GOOGLE_API_KEY from the local environment/.env.
verify runs without a model and checks the acknowledged prefix even if play
stopped at a budget. It distinguishes candidate claims from oracle-only findings.

Limits are capped at the values the independent verifier enforces, so play can
never record an episode that verify would refuse.

Commands are a JSON array of exact single-line strings. Unknown commands and
empty lines are preserved. A complete script may end before winning the game.
Replay refuses incomplete traces or changed game/runtime fingerprints.
`;

function parseOptions(args: string[], allowed: string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (!allowed.includes(key) || value === undefined || options.has(key)) {
      throw new Error(`Unknown, missing, or repeated option: ${key}`);
    }
    options.set(key, value);
  }
  return options;
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (!mode || mode === "--help" || mode === "help") { console.log(HELP); return; }
  if (!["play", "verify", "record", "replay", "show", "evaluate"].includes(mode)) throw new Error("Expected play, verify, record, replay, show, or evaluate; use --help");
  const limitKeys = { "--max-commands": "maxCommands", "--response-ms": "responseMs", "--episode-ms": "episodeMs", "--max-output-bytes": "maxOutputBytes" } as const;
  const adapterKeys = { "--synthesize-after": "synthesizeAfter", "--adapter-ms": "timeoutMs", "--repair-attempts": "maxRepairAttempts",
    "--adapter-examples": "maxExamples", "--adapter-example-bytes": "maxExampleBytes", "--adapter-output-tokens": "generationMaxOutputTokens" } as const;
  const playerKeys = ["--model", "--token-budget", "--call-ms", "--history-bytes", "--memory-chars", "--max-model-output", "--thinking-budget", "--thinking-level", "--retries", "--model-interval-ms", "--adapter-mode", ...Object.keys(adapterKeys)];
  const allowed = mode === "record" ? ["--db", "--seed", "--commands", ...Object.keys(limitKeys)]
    : mode === "play" ? ["--db", "--seed", ...Object.keys(limitKeys), ...playerKeys]
    : mode === "evaluate" ? ["--db", "--episode", "--adapter-episode", "--adapter", "--adapter-db", "--adapter-ms"]
    : ["--db", "--episode"];
  const options = parseOptions(args, allowed);
  const path = resolve(options.get("--db") ?? "runs/greybox.sqlite");
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  let store: Store | undefined;
  let adapterStore: Store | undefined;
  try {
    if (mode === "record" || mode === "play") {
      if (!options.has("--seed")) throw new Error(`${mode} requires --seed`);
      let commands: string[] = [];
      if (mode === "record") {
        if (!options.has("--commands")) throw new Error("record requires --commands");
        commands = JSON.parse(options.get("--commands")!);
        if (!Array.isArray(commands) || commands.some(command => typeof command !== "string")) throw new Error("--commands must be a JSON array of strings");
      }
      // Validate credentials before creating any episode or subprocess.
      const client = mode === "play" ? new GeminiClient(geminiKey()) : undefined;
      const limits: Partial<Limits> = {};
      for (const [key, field] of Object.entries(limitKeys)) {
        if (options.has(key)) limits[field] = Number(options.get(key));
      }
      await mkdir(dirname(path), { recursive: true });
      store = new Store(path);
      const base = { store, seed: Number(options.get("--seed")), limits, signal: controller.signal };
      const numberOption = (name: string) => options.has(name) ? Number(options.get(name)) : undefined;
      const adapterMode = options.get("--adapter-mode") ?? "raw";
      if (!["raw", "frozen", "repair"].includes(adapterMode)) throw new Error("--adapter-mode must be raw, frozen, or repair");
      if (adapterMode === "raw" && Object.keys(adapterKeys).some(key => options.has(key))) throw new Error("Adapter options require frozen or repair mode");
      let adapters: AdapterOptions | undefined;
      if (adapterMode !== "raw") {
        adapters = { mode: adapterMode as "frozen" | "repair", executor: new BubblewrapExecutor() };
        for (const [flag, field] of Object.entries(adapterKeys)) if (options.has(flag)) adapters[field] = Number(options.get(flag));
      }
      const settings: Partial<ModelSettings> = {
        ...(options.has("--model") || process.env.GEMINI_MODEL ? { model: options.get("--model") ?? process.env.GEMINI_MODEL } : {}),
        ...(options.has("--max-model-output") ? { maxOutputTokens: numberOption("--max-model-output") } : {}),
        ...(options.has("--thinking-budget") ? { thinkingBudget: numberOption("--thinking-budget") } : {}),
        ...(options.has("--thinking-level") ? { thinkingLevel: options.get("--thinking-level") as ModelSettings["thinkingLevel"] } : {}),
      };
      const episode = mode === "record" ? await runScript({ ...base, commands }) : await runPlayer({ ...base, client: client!, settings,
        adapters, modelIntervalMs: numberOption("--model-interval-ms"),
        tokenBudget: numberOption("--token-budget"), callMs: numberOption("--call-ms"), retries: numberOption("--retries"),
        historyBytes: numberOption("--history-bytes"), memoryChars: numberOption("--memory-chars"),
        progress: event => console.error(JSON.stringify({ turn: event.observation, command: event.command, reportedTokens: event.tokens })),
      });
      const knownTokens = episode.calls.reduce((sum, call) => sum + (call.usage.totalTokens ?? 0), 0);
      console.log(JSON.stringify({ episode: episode.id, db: path, status: episode.status, stopReason: episode.stopReason,
        commands: episode.commands.length, modelCalls: episode.calls.length, knownTokens,
        unknownUsageCalls: episode.calls.filter(call => call.usage.totalTokens === null).length,
        candidateFindings: episode.invariants.filter(result => result.status === "violated").length,
        adapterAttempts: episode.adapters.length, acceptedAdapters: episode.adapters.filter(adapter => adapter.status === "accepted").length,
        adapterHits: episode.adapterEvents.filter(event => event.kind === "hit").length,
        adapterFallbacks: episode.adapterEvents.filter(event => event.kind === "fallback").length,
        usageByPurpose: Object.fromEntries([...new Set(episode.calls.map(call => call.purpose))].map(purpose => {
          const calls = episode.calls.filter(call => call.purpose === purpose);
          return [purpose, { calls: calls.length, knownTokens: calls.reduce((sum, call) => sum + (call.usage.totalTokens ?? 0), 0),
            unknownUsageCalls: calls.filter(call => call.usage.totalTokens === null).length }];
        })),
        error: episode.error }, null, 2));
      if (episode.status !== "complete") process.exitCode = 1;
    } else {
      const id = options.get("--episode");
      if (!id) throw new Error(`${mode} requires --episode`);
      store = new Store(path, mode !== "verify");
      const episode = store.get(id);
      if (mode === "verify") {
        const report = await verifyEpisode(episode, episode.invariants, { signal: controller.signal });
        store.verify(id, report);
        console.log(JSON.stringify(report, null, 2));
        if (!report.verified) process.exitCode = 1;
      } else if (mode === "show") {
        console.log(JSON.stringify({ ...episode,
          stdout: episode.stdout.toString("utf8"), stderr: episode.stderr.toString("utf8"),
          observations: episode.observations.map(frame => ({ ...frame, raw: frame.raw.toString("utf8") })),
        }, null, 2));
      } else if (mode === "evaluate") {
        const adapterEpisodeId = options.get("--adapter-episode");
        if (!adapterEpisodeId) throw new Error("evaluate requires --adapter-episode");
        const adapterDbPath = resolve(options.get("--adapter-db") ?? path);
        adapterStore = new Store(adapterDbPath, true);
        const adapterEpisode = adapterStore.get(adapterEpisodeId);
        const adapterId = options.get("--adapter");
        let record: AdapterRecord;
        if (adapterId) {
          const found = adapterEpisode.adapters.find(adapter => adapter.id === adapterId);
          if (!found) throw new Error(`Adapter not found: ${adapterId}`);
          if (found.status !== "accepted") throw new Error(`Adapter ${adapterId} is not accepted (status: ${found.status})`);
          record = found;
        } else {
          const accepted = adapterEpisode.adapters.filter(adapter => adapter.status === "accepted");
          if (accepted.length === 0) throw new Error(`No accepted adapter found in episode ${adapterEpisodeId}`);
          record = accepted.reduce((best, adapter) =>
            (adapter.activationObservation ?? -Infinity) >= (best.activationObservation ?? -Infinity) ? adapter : best);
        }
        if (record.source === null) throw new Error(`Adapter ${record.id} has no source`);
        const source: string = record.source;
        const report = await evaluateAdapter(source, episode, {
          executor: new BubblewrapExecutor(),
          timeoutMs: options.has("--adapter-ms") ? Number(options.get("--adapter-ms")) : undefined,
          signal: controller.signal,
        });
        console.log(JSON.stringify({ ...report, withheld: adapterEpisodeId !== id }, null, 2));
        if (!report.verified) process.exitCode = 1;
      } else {
        const result = await replay(episode, { signal: controller.signal });
        console.log(JSON.stringify({ episode: id, ...result }, null, 2));
        if (!result.match) process.exitCode = 1;
      }
    }
  } finally {
    store?.close();
    adapterStore?.close();
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}

if (import.meta.main) main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
