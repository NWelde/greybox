import { Framer, type Frame } from "./framing";

export class RunError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "RunError";
  }
}

export function within<T>(work: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => finish(() => reject(new RunError("cancelled", "Run cancelled")));
    const timer = setTimeout(() => finish(() => reject(new RunError("timeout", "Deadline exceeded"))), Math.max(0, ms));
    function finish(action: () => void) {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      action();
    }
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    work.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
  });
}

export interface Transport {
  next(ms: number, signal?: AbortSignal): Promise<Frame>;
  send(command: string): Promise<void>;
  endInput(): void;
  close(): Promise<{ exitCode: number | null; exitSignal?: string | null; forced: boolean; stdout: Buffer; stderr: Buffer; fault?: string }>;
}

export class ProcessTransport implements Transport {
  private process: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private frames: Frame[] = [];
  private notify?: () => void;
  private fault?: Error;
  private eof = false;
  private awaitingResponse = true; // Startup is the first expected response.
  private inputEnded = false;
  private stdoutChunks: Buffer[] = [];
  private stderrChunks: Buffer[] = [];
  private drains: Promise<void>;
  private readers: ReadableStreamDefaultReader<Uint8Array>[] = [];

  get pid(): number { return this.process.pid; }

  constructor(cmd: string[], cwd: string, maxOutputBytes = 1_048_576) {
    this.process = Bun.spawn(cmd, {
      cwd,
      // The command must also disable Bun's automatic .env loading.
      env: { LANG: "C.UTF-8", TZ: "UTC" },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    let total = 0;
    const framer = new Framer();
    const drain = async (stream: ReadableStream<Uint8Array>, stdout: boolean) => {
      const reader = stream.getReader();
      this.readers.push(reader);
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          const remaining = Math.max(0, maxOutputBytes - total);
          const chunk = Buffer.from(value.subarray(0, remaining));
          total += value.length;
          (stdout ? this.stdoutChunks : this.stderrChunks).push(chunk);
          if (total > maxOutputBytes) throw new RunError("output_limit", "Combined stdout/stderr limit exceeded; captured output is truncated");
          if (stdout) {
            if (!this.awaitingResponse && chunk.length) throw new RunError("unexpected_output", "Output arrived without an outstanding exchange");
            for (const frame of framer.push(chunk)) {
              if (!this.awaitingResponse) throw new RunError("unexpected_output", "Unsolicited prompt received");
              this.frames.push(frame);
              this.awaitingResponse = false;
            }
            if (!this.awaitingResponse && framer.pendingBytes) {
              throw new RunError("unexpected_output", "Unsolicited trailing output after a prompt");
            }
          }
          this.notify?.();
        }
        if (stdout) {
          this.frames.push(framer.finish());
          this.eof = true;
        }
      } catch (error) {
        this.fault = error instanceof Error ? error : new Error(String(error));
        this.process.kill("SIGKILL");
      } finally {
        reader.releaseLock();
        this.notify?.();
      }
    };
    this.drains = Promise.all([drain(this.process.stdout, true), drain(this.process.stderr, false)]).then(() => {});
  }

  async next(ms: number, signal?: AbortSignal): Promise<Frame> {
    const deadline = performance.now() + ms;
    while (true) {
      if (signal?.aborted) throw new RunError("cancelled", "Run cancelled");
      if (this.fault) throw this.fault;
      const frame = this.frames.shift();
      if (frame) return frame;
      if (this.eof) throw new RunError("unexpected_exit", "Read after stdout EOF");
      const changed = new Promise<void>(resolve => { this.notify = resolve; });
      try {
        await within(changed, deadline - performance.now(), signal);
      } finally {
        this.notify = undefined;
      }
    }
  }

  async send(command: string): Promise<void> {
    if (/[\r\n\0]/.test(command)) throw new RunError("invalid_command", "Commands must contain exactly one line without NUL");
    if (Buffer.byteLength(command) > 4096) throw new RunError("invalid_command", "Command exceeds 4096 bytes");
    if (this.fault) throw this.fault;
    if (this.inputEnded || this.eof) throw new RunError("unexpected_exit", "Cannot send after input/output ended");
    if (this.awaitingResponse || this.frames.length) throw new RunError("unexpected_output", "Previous exchange has not been consumed");
    this.awaitingResponse = true;
    this.process.stdin.write(command + "\n");
    await this.process.stdin.flush();
  }

  endInput(): void {
    if (this.inputEnded) return;
    this.inputEnded = true;
    this.awaitingResponse = true; // Closing input may produce a final EOF response.
    try { this.process.stdin.end(); } catch { /* Already exited. */ }
  }

  async close() {
    this.endInput();
    let forced = false;
    const finished = Promise.all([this.process.exited, this.drains]);
    try {
      await within(finished, 500);
    } catch {
      forced = true;
      this.process.kill("SIGKILL");
      try { await within(finished, 500); } catch {
        for (const reader of this.readers) {
          try { void reader.cancel().catch(() => {}); } catch { /* Lock released. */ }
        }
        this.process.unref();
      }
    }
    return {
      exitCode: this.process.exitCode,
      exitSignal: this.process.signalCode,
      forced,
      stdout: Buffer.concat(this.stdoutChunks),
      stderr: Buffer.concat(this.stderrChunks),
      fault: this.fault ? (this.fault instanceof RunError ? this.fault.code : "transport_error") : undefined,
    };
  }
}
