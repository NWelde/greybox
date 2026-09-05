import { realpathSync } from "node:fs";
import { join } from "node:path";
import type { ObservedView } from "./contracts";
import { AdapterError, type AdapterExecutor, type AdapterInput } from "./adapter-contracts";
import { parseDecision } from "./prompts";

const SOURCE_LIMIT_BYTES = 32 * 1024;
const OUTPUT_LIMIT_BYTES = 128 * 1024;
const MAX_TIMEOUT_MS = 1000;
const CLEANUP_TIMEOUT_MS = 250;
const BWRAP = "/usr/bin/bwrap";

type StopReason = "timeout" | "cancelled" | "output_limit" | "write_failure";
type WorkerResponse =
  | { ok: true; value: unknown }
  | { ok: false; stage: "loading" | "runtime" | "schema" };

function adapterError(code: string): AdapterError {
  const messages: Record<string, string> = {
    loading: "Adapter could not be loaded",
    runtime: "Adapter execution failed",
    schema: "Adapter returned an invalid view",
    timeout: "Adapter execution timed out",
    isolation: "Adapter isolation is unavailable",
    output_limit: "Adapter output exceeded the limit",
  };
  return new AdapterError(code, messages[code] ?? "Adapter execution failed");
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function containsUnscannableDependencySyntax(source: string): boolean {
  // Bun's scanner reports literal static/dynamic imports. These conservative
  // checks close its type-only, computed-import, and CommonJS gaps.
  return /\bimport\s*(?:\/\*[\s\S]*?\*\/\s*)?\(/.test(source) ||
    /\bimport\s+type\b/.test(source) ||
    /\bimport\s*\{[^}]*\btype\b[^}]*\}\s*from\b/.test(source) ||
    /\bexport\s+type(?:\s*\{|\s+\*)/.test(source) ||
    /\brequire\s*(?:\.\s*resolve\s*)?\(/.test(source) ||
    /\bmodule\s*\.\s*require\s*\(/.test(source) ||
    /\bimport\s*\.\s*meta\s*\.\s*require\s*\(/.test(source);
}

function compile(source: string): string {
  if (typeof source !== "string" || Buffer.byteLength(source) > SOURCE_LIMIT_BYTES) {
    throw adapterError("loading");
  }

  try {
    const transpiler = new Bun.Transpiler({ loader: "ts", target: "bun" });
    const scanned = transpiler.scan(source);
    if (scanned.imports.length > 0 || containsUnscannableDependencySyntax(source)) {
      throw adapterError("loading");
    }
    const compiled = transpiler.transformSync(source);
    if (transpiler.scan(compiled).imports.length > 0 || containsUnscannableDependencySyntax(compiled)) {
      throw adapterError("loading");
    }
    return compiled;
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    throw adapterError("loading");
  }
}

function isWorkerResponse(value: unknown): value is WorkerResponse {
  if (!value || typeof value !== "object" || typeof (value as { ok?: unknown }).ok !== "boolean") return false;
  if ((value as { ok: boolean }).ok) return Object.hasOwn(value, "value");
  return ["loading", "runtime", "schema"].includes(String((value as { stage?: unknown }).stage));
}

export class BubblewrapExecutor implements AdapterExecutor {
  async run(
    source: string,
    input: AdapterInput,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<ObservedView> {
    if (options.signal?.aborted) throw adapterError("runtime");
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > MAX_TIMEOUT_MS) {
      throw adapterError("runtime");
    }

    const compiled = compile(source);
    if (options.signal?.aborted) throw adapterError("runtime");

    // Fresh per-invocation frame. The adapter's parse only receives raw and
    // previous, so it can never learn or spoof this sentinel.
    const sentinel = crypto.randomUUID();
    let payload: string;
    try {
      payload = JSON.stringify({ sentinel, source: compiled, raw: input.raw, previous: input.previous });
    } catch {
      throw adapterError("runtime");
    }

    let bunPath: string;
    let workerPath: string;
    try {
      bunPath = realpathSync(process.execPath);
      workerPath = realpathSync(join(import.meta.dir, "adapter-worker.ts"));
    } catch {
      throw adapterError("isolation");
    }
    const command = [
      BWRAP,
      "--unshare-all",
      "--die-with-parent",
      "--new-session",
      "--clearenv",
      "--ro-bind", "/usr", "/usr",
      "--ro-bind", "/lib", "/lib",
      "--ro-bind-try", "/lib64", "/lib64",
      "--dir", "/runtime",
      "--ro-bind", bunPath, "/runtime/bun",
      "--ro-bind", workerPath, "/worker.ts",
      "--tmpfs", "/tmp",
      "--proc", "/proc",
      "--dev", "/dev",
      "--chdir", "/tmp",
      "--setenv", "LANG", "C.UTF-8",
      "--setenv", "TZ", "UTC",
      "/runtime/bun", "--no-env-file", "run", "/worker.ts",
    ];

    let child: Bun.Subprocess<"pipe", "pipe", "pipe">;
    try {
      child = Bun.spawn(command, {
        cwd: "/",
        env: { LANG: "C.UTF-8", TZ: "UTC" },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch {
      throw adapterError("isolation");
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
    let captured = 0;
    let stopped: StopReason | null = null;
    let notifyStop: ((reason: StopReason) => void) | undefined;
    const stopPromise = new Promise<StopReason>(resolve => { notifyStop = resolve; });
    const stop = (reason: StopReason) => {
      if (stopped) return;
      stopped = reason;
      notifyStop?.(reason);
      try { child.kill("SIGKILL"); } catch { /* Already exited. */ }
    };

    const drain = async (stream: ReadableStream<Uint8Array>, chunks: Buffer[]) => {
      const reader = stream.getReader();
      readers.push(reader);
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          const remaining = Math.max(0, OUTPUT_LIMIT_BYTES - captured);
          if (remaining > 0) chunks.push(Buffer.from(value.subarray(0, remaining)));
          captured += Math.min(remaining, value.byteLength);
          if (value.byteLength > remaining) stop("output_limit");
        }
      } catch {
        if (!stopped) stop("write_failure");
      } finally {
        reader.releaseLock();
      }
    };
    const drains = Promise.all([
      drain(child.stdout, stdout),
      drain(child.stderr, stderr),
    ]).then(() => {});

    const abort = () => stop("cancelled");
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => stop("timeout"), options.timeoutMs);
    if (options.signal?.aborted) abort();

    try {
      try {
        await child.stdin.write(payload);
        await child.stdin.end();
      } catch {
        stop("write_failure");
      }

      const exit = child.exited.then(exitCode => ({ exitCode }));
      const stoppedExit = stopPromise.then(async reason => {
        const result = await Promise.race([
          child.exited.then(exitCode => ({ exitCode })),
          delay(CLEANUP_TIMEOUT_MS).then(() => ({ exitCode: null })),
        ]);
        return { ...result, reason };
      });
      const outcome = await Promise.race([exit, stoppedExit]);
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);

      const drained = await Promise.race([
        drains.then(() => true),
        delay(CLEANUP_TIMEOUT_MS).then(() => false),
      ]);
      if (!drained) {
        for (const reader of readers) {
          try { void reader.cancel().catch(() => {}); } catch { /* Reader already closed. */ }
        }
        child.unref();
      }

      const reason = "reason" in outcome ? outcome.reason : stopped;
      if (reason === "output_limit") throw adapterError("output_limit");
      if (reason === "timeout") throw adapterError("timeout");
      if (reason === "cancelled" || reason === "write_failure") throw adapterError("runtime");

      const stdoutBuffer = Buffer.concat(stdout);
      const stderrBuffer = Buffer.concat(stderr);
      // Stray adapter output (console.log, Bun.write(Bun.stdout, ...)) bypasses the
      // worker's write override, so parse only what follows the final sentinel.
      // That output still counts toward OUTPUT_LIMIT_BYTES and can truncate the
      // framed response, which stays a bounded, fail-closed outcome.
      const stdoutText = stdoutBuffer.toString("utf8");
      const framed = stdoutText.lastIndexOf(sentinel);
      let response: unknown;
      try {
        if (framed < 0) throw adapterError("runtime");
        response = JSON.parse(stdoutText.slice(framed + sentinel.length));
      } catch {
        if (stderrBuffer.toString("utf8").startsWith("bwrap:")) throw adapterError("isolation");
        throw adapterError("runtime");
      }
      if (response && typeof response === "object" && (response as { ok?: unknown }).ok === true &&
          !Object.hasOwn(response, "value")) {
        throw adapterError("schema");
      }
      if (!isWorkerResponse(response) || outcome.exitCode !== 0) throw adapterError("runtime");
      if (!response.ok) throw adapterError(response.stage);

      try {
        return parseDecision(JSON.stringify({ view: response.value, command: null, memory: "" }), input.previous ?? undefined).view;
      } catch {
        throw adapterError("schema");
      }
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (child.exitCode === null) {
        try { child.kill("SIGKILL"); } catch { /* Already exited. */ }
      }
    }
  }
}
