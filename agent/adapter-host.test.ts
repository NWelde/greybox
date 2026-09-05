import { afterEach, describe, expect, test } from "bun:test";
import type { ObservedView } from "./contracts";
import { AdapterError } from "./adapter-contracts";
import { BubblewrapExecutor } from "./adapter-host";

const executor = new BubblewrapExecutor();
const controllers: AbortController[] = [];

function unknownView(kind: ObservedView["kind"] = "unknown"): ObservedView {
  return {
    kind,
    hp: { value: null, source: "unknown" },
    maxHp: { value: null, source: "unknown" },
    score: { value: null, source: "unknown" },
    grid: { value: null, source: "unknown" },
    position: { value: null, source: "unknown" },
    inventory: { value: null, source: "unknown" },
  };
}

function source(body: string): string {
  return `
interface InputFact<T> { value: T | null; source: "observed" | "retained" | "unknown" }
interface View { kind: "state" | "error" | "terminal" | "unknown"; hp: InputFact<number>;
  maxHp: InputFact<number>; score: InputFact<number>; grid: InputFact<string[]>;
  position: InputFact<{ x: number; y: number }>; inventory: InputFact<string[]> }
export function parse(raw: string, previous: View | null): View {
  ${body}
}`;
}

async function run(adapterSource: string, raw = "room", previous: ObservedView | null = null, timeoutMs = 1000) {
  return executor.run(adapterSource, { raw, previous }, { timeoutMs });
}

function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  return promise.then(
    () => { throw new Error(`Expected AdapterError ${code}`); },
    error => {
      expect(error).toBeInstanceOf(AdapterError);
      expect((error as AdapterError).code).toBe(code);
      expect((error as Error).stack).not.toContain("adapter-worker");
    },
  );
}

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.abort();
  delete process.env.GREYBOX_ADAPTER_SECRET;
});

describe("BubblewrapExecutor", () => {
  test("transpiles valid TypeScript and normalizes retained fields", async () => {
    const previous = unknownView("state");
    previous.score = { value: 7, source: "observed" };
    const result = await run(source(`
      return { ...${JSON.stringify(unknownView("state"))},
        score: { value: 999, source: "retained" },
        hp: { value: Number(raw), source: "observed" },
      };
    `), "12", previous);
    expect(result.hp).toEqual({ value: 12, source: "observed" });
    expect(result.score).toEqual({ value: 7, source: "retained" });
  });

  test("whitelists raw and previous when callers pass an example object", async () => {
    const input = { raw: "room", previous: null, expected: { private: "label" }, observation: 4 };
    const result = await executor.run(source(`
      const leaked = arguments.length !== 2 || "expected" in (previous ?? {});
      return { ...${JSON.stringify(unknownView())}, score: { value: leaked ? 1 : 0, source: "observed" } };
    `), input, { timeoutMs: 1000 });
    expect(result.score.value).toBe(0);
  });

  test("rejects oversized source and all dependency forms before execution", async () => {
    await expectCode(run(" ".repeat(32 * 1024 + 1)), "loading");
    await expectCode(run('import { readFileSync } from "node:fs"; export function parse() {}'), "loading");
    await expectCode(run('import type { ObservedView } from "./contracts"; export function parse() {}'), "loading");
    await expectCode(run('export function parse() { return import("node:fs"); }'), "loading");
    await expectCode(run('export function parse() { const name = "node:fs"; return import(name); }'), "loading");
    await expectCode(run('export function parse() { return require("node:fs"); }'), "loading");
  });

  test("mounts no host files, home, dotenv, or repository", async () => {
    const paths = ["/etc/passwd", "/home", "/home/nathan/.env", "/home/nathan/greybox-agent/agent.md", "/tmp/.env"];
    const result = await run(source(`
      const visible = ${JSON.stringify(paths)}.filter(path =>
        Bun.spawnSync(["/usr/bin/test", "-e", path]).exitCode === 0);
      return { ...${JSON.stringify(unknownView())}, inventory: { value: visible, source: "observed" } };
    `));
    expect(result.inventory.value).toEqual([]);
  });

  test("passes only LANG and TZ, never the parent environment", async () => {
    process.env.GREYBOX_ADAPTER_SECRET = "must-not-cross";
    const result = await run(source(`
      const values = Object.keys(process.env).sort();
      return { ...${JSON.stringify(unknownView())}, inventory: { value: values, source: "observed" } };
    `));
    expect(result.inventory.value).toEqual(["LANG", "TZ"]);
  });

  test("has no usable network route", async () => {
    const result = await run(source(`
      const child = Bun.spawnSync(["/runtime/bun", "--no-env-file", "-e",
        "try { await fetch('http://1.1.1.1', { signal: AbortSignal.timeout(100) }); process.exit(0) } catch { process.exit(9) }"]);
      return { ...${JSON.stringify(unknownView())}, score: { value: child.exitCode, source: "observed" } };
    `));
    expect(result.score.value).not.toBe(0);
  });

  test("classifies loading, runtime, and schema failures without child details", async () => {
    await expectCode(run("export const nope = 1;"), "loading");
    await expectCode(run(source('throw new Error("private adapter detail");')), "runtime");
    await expectCode(run("export function parse() { return { kind: 'state' }; }"), "schema");
    await expectCode(run("export function parse() {}"), "schema");
    await expectCode(run("export async function parse() { return {}; }"), "runtime");
  });

  test("ignores stray adapter stdout that bypasses the write override", async () => {
    const logged = await run(source(`
      console.log("noise");
      return { ...${JSON.stringify(unknownView("state"))}, hp: { value: 3, source: "observed" } };
    `));
    expect(logged.kind).toBe("state");
    expect(logged.hp).toEqual({ value: 3, source: "observed" });

    const written = await run(source(`
      Bun.write(Bun.stdout, '{"ok":false,"stage":"runtime"}');
      return { ...${JSON.stringify(unknownView("state"))}, hp: { value: 4, source: "observed" } };
    `));
    expect(written.kind).toBe("state");
    expect(written.hp).toEqual({ value: 4, source: "observed" });
  });

  test("kills infinite loops at the deadline", async () => {
    const started = performance.now();
    await expectCode(run(source("while (true) {}"), "room", null, 50), "timeout");
    expect(performance.now() - started).toBeLessThan(750);
  });

  test("bounds combined stdout and stderr", async () => {
    await expectCode(run(source(`
      process.stderr.write("x".repeat(256 * 1024));
      return ${JSON.stringify(unknownView())};
    `)), "output_limit");
  });

  test("honors cancellation before launch and during execution, then remains usable", async () => {
    const before = new AbortController();
    before.abort();
    await expectCode(executor.run(source(`return ${JSON.stringify(unknownView())};`), { raw: "", previous: null }, {
      timeoutMs: 1000,
      signal: before.signal,
    }), "runtime");

    const during = new AbortController();
    controllers.push(during);
    const pending = executor.run(source("while (true) {}"), { raw: "", previous: null }, {
      timeoutMs: 1000,
      signal: during.signal,
    });
    setTimeout(() => during.abort(), 25);
    await expectCode(pending, "runtime");
    expect((await run(source(`return ${JSON.stringify(unknownView("state"))};`))).kind).toBe("state");
  });
});
