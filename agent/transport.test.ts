import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./game";
import { ProcessTransport } from "./transport";

const children: ProcessTransport[] = [];
const directories: string[] = [];
function child(mode: string, maxOutputBytes?: number, cwd = ROOT) {
  const transport = new ProcessTransport([
    process.execPath, "--no-env-file", "run", join(import.meta.dir, "fixtures/process.ts"), mode,
  ], cwd, maxOutputBytes);
  children.push(transport);
  return transport;
}
afterEach(async () => {
  for (const transport of children.splice(0)) await transport.close();
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("real process lifecycle", () => {
  test("coalesced unsolicited prompts cannot acknowledge a later command", async () => {
    const transport = child("unsolicited");
    await expect(transport.next(2000)).rejects.toThrow("Unsolicited");
    await expect(transport.send("north")).rejects.toThrow("Unsolicited");
    expect((await transport.close()).fault).toBe("unexpected_output");
  });

  test("an unsolicited partial tail cannot become the next EOF response", async () => {
    const transport = child("unsolicited-tail");
    await expect(transport.next(2000)).rejects.toThrow("Unsolicited");
    expect((await transport.close()).fault).toBe("unexpected_output");
  });

  test("closing stdout does not evade child cleanup", async () => {
    const transport = child("closed-stdout");
    expect((await transport.next(2000)).kind).toBe("eof");
    const closed = await transport.close();
    expect(closed.forced).toBe(true);
    expect(closed.exitSignal).toBe("SIGKILL");
    expect(() => process.kill(transport.pid, 0)).toThrow();
  });

  test("streaming bytes preserve Unicode and final output", async () => {
    const transport = child("fragmented");
    const startup = await transport.next(2000);
    expect(startup.raw.toString()).toBe("café 🧪\n> \n");
    await transport.send("hello");
    const end = await transport.next(2000);
    expect(end.kind).toBe("eof");
    expect(end.raw.toString()).toBe("hello\ndone\n");
    const result = await transport.close();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toEqual(Buffer.concat([startup.raw, end.raw]));
  });

  test("a stalled startup is bounded and its child is killed", async () => {
    const transport = child("startup-hang");
    await expect(transport.next(50)).rejects.toThrow("Deadline");
    const result = await transport.close();
    expect(result.forced).toBe(true);
    expect(result.exitSignal).toBe("SIGKILL");
    expect(() => process.kill(transport.pid, 0)).toThrow();
  });

  test("a consumed but unacknowledged command times out and child cleanup is bounded", async () => {
    const transport = child("response-hang");
    await transport.next(2000);
    await transport.send("north");
    await expect(transport.next(50)).rejects.toThrow("Deadline");
    const result = await transport.close();
    expect(result.forced).toBe(true);
    expect(result.exitSignal).toBe("SIGKILL");
    expect(() => process.kill(transport.pid, 0)).toThrow();
  });

  test("nonzero exit and stderr are captured separately", async () => {
    const transport = child("early-exit");
    expect((await transport.next(2000)).kind).toBe("eof");
    const result = await transport.close();
    expect(result.exitCode).toBe(7);
    expect(result.stderr.toString()).toBe("fixture failure\n");
    expect(result.stdout).toHaveLength(0);
  });

  test("stderr flood cannot block indefinitely or exceed capture budget", async () => {
    const transport = child("output-flood", 128);
    try { await transport.next(2000); } catch { /* Either EOF or limit may arrive first. */ }
    const result = await transport.close();
    expect(result.fault).toBe("output_limit");
    expect(result.stdout.length + result.stderr.length).toBeLessThanOrEqual(128);
  });

  test("neither parent variables nor a local .env reaches the child", async () => {
    const directory = await mkdtemp(join(tmpdir(), "greybox-env-"));
    directories.push(directory);
    await writeFile(join(directory, ".env"), "GREYBOX_TEST_DOTENV=fixture-only\n");
    const previous = process.env.GREYBOX_TEST_SECRET;
    process.env.GREYBOX_TEST_SECRET = "fixture-only";
    try {
      const transport = child("env", undefined, directory);
      const frame = await transport.next(2000);
      expect(JSON.parse(frame.raw.toString())).toEqual({ inherited: false, dotenv: false, gemini: false });
    } finally {
      if (previous === undefined) delete process.env.GREYBOX_TEST_SECRET;
      else process.env.GREYBOX_TEST_SECRET = previous;
    }
  });

  test("abort interrupts an outstanding receive", async () => {
    const transport = child("startup-hang");
    const controller = new AbortController();
    const pending = transport.next(2000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
  });
});
