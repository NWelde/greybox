import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { gameIdentity } from "./game";
import { ROOT } from "./game";
import { replay } from "./replay";
import { DEFAULT_LIMITS, runScript } from "./runner";
import { Store } from "./store";
import { ProcessTransport, RunError, type Transport } from "./transport";

const directories: string[] = [];
const stores: Store[] = [];
async function makeStore() {
  const directory = await mkdtemp(join(tmpdir(), "greybox-store-"));
  directories.push(directory);
  const path = join(directory, "trace.sqlite");
  const store = new Store(path);
  stores.push(store);
  return { store, path };
}
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("record and replay", () => {
  test("records and replays a natural win without sending the remaining script", async () => {
    const { store } = await makeStore();
    // Fixed public route for seed 42; private fixture knowledge stays in tests.
    const episode = await runScript({ store, seed: 42, commands: ["north", "north", "west", "west", "wait"], limits: { responseMs: 1000 } });
    expect(episode.status).toBe("complete");
    expect(episode.stopReason).toBe("game_exit");
    expect(episode.commands).toHaveLength(4);
    expect(episode.stdout.toString()).toEndWith("You found the exit. You win!\n");
    expect((await replay(episode)).match).toBe(true);
  });

  test("records and replays the reachable cumulative-score bug", async () => {
    const { store } = await makeStore();
    const episode = await runScript({ store, seed: 42, commands: ["south", "west", "west", "west", "west", "take", "drop coin"] });
    expect(episode.status).toBe("complete");
    const scores = Array.from(episode.stdout.toString().matchAll(/Score: (-?\d+)/g), match => Number(match[1]));
    expect(scores.slice(-2)).toEqual([5, 0]);
    expect((await replay(episode)).match).toBe(true);
  });

  test("records overheal and exact invalid inputs; survives database reopen", async () => {
    const { store, path } = await makeStore();
    const commands = ["  nonsense  ", "", "north", "north", "take", "drink"];
    const episode = await runScript({ store, seed: 42, commands });
    expect(episode.status).toBe("complete");
    expect(episode.stopReason).toBe("script_complete");
    expect(episode.stdout.toString()).toContain("HP: 13/10");
    expect(episode.commands.map(command => command.text)).toEqual(commands);
    expect(episode.commands.every(command => command.status === "complete")).toBe(true);
    store.close();
    const reopened = new Store(path, true);
    stores.push(reopened);
    const before = reopened.get(episode.id);
    expect((await replay(before)).match).toBe(true);
    expect(reopened.get(episode.id)).toEqual(before);
  });

  test("an empty script records startup and clean EOF", async () => {
    const { store } = await makeStore();
    const episode = await runScript({ store, seed: 42, commands: [] });
    expect(episode.status).toBe("complete");
    expect(episode.observations.map(frame => frame.kind)).toEqual(["prompt", "eof"]);
    expect((await replay(episode)).match).toBe(true);
  });

  test("changed source fingerprint is rejected before spawning", async () => {
    const { store } = await makeStore();
    const episode = await runScript({ store, seed: 42, commands: [] });
    episode.config.game.sourceHash = "changed";
    let spawned = false;
    const result = await replay(episode, { transportFactory: () => { spawned = true; throw new Error("must not spawn"); } });
    expect(result.match).toBe(false);
    expect(result.reason).toContain("changed");
    expect(spawned).toBe(false);
  });

  test("a different action reports the first response mismatch", async () => {
    const { store } = await makeStore();
    const episode = await runScript({ store, seed: 42, commands: ["north"] });
    episode.commands[0].text = "south";
    const result = await replay(episode);
    expect(result.match).toBe(false);
    expect(result.observation).toBe(1);
  });

  test("deleted observation cannot turn a partial prefix into exact replay", async () => {
    const { store } = await makeStore();
    const episode = await runScript({ store, seed: 42, commands: ["north"] });
    episode.observations.splice(1, 1);
    await expect(replay(episode)).rejects.toThrow("boundaries");
  });

  test("command limit leaves an explicitly incomplete trace", async () => {
    const { store } = await makeStore();
    const episode = await runScript({ store, seed: 42, commands: ["north", "north"], limits: { maxCommands: 1 } });
    expect(episode.status).toBe("incomplete");
    expect(episode.stopReason).toBe("turn_limit");
    expect(episode.commands).toHaveLength(1);
    await expect(replay(episode)).rejects.toThrow("incomplete");
  });

  test("invalid seeds and multiline actions never spawn a game", async () => {
    const { store } = await makeStore();
    for (const seed of [NaN, Infinity, -1, 0x1_0000_0000, 0.5]) {
      await expect(runScript({ store, seed, commands: [] })).rejects.toThrow("Seed");
    }
    await expect(runScript({ store, seed: 42, commands: ["north\nsouth"] })).rejects.toThrow("one line");
    await expect(runScript({ store, seed: 42, commands: [], limits: { responseMs: 0 } })).rejects.toThrow("positive integer");
  });
});

describe("uncertain delivery and cleanup", () => {
  test("a stalled stdin flush leaves intent indeterminate and is never retried", async () => {
    const { store } = await makeStore();
    let sends = 0;
    let closed = false;
    const episode = await runScript({ store, seed: 42, commands: ["north"], limits: { responseMs: 20 }, transportFactory: () => ({
      next: async () => ({ raw: Buffer.from("ready\n> \n"), kind: "prompt" }),
      send: async () => { sends++; await new Promise(() => {}); },
      endInput: () => {},
      close: async () => { closed = true; return { exitCode: 0, forced: false, stdout: Buffer.from("ready\n> \n"), stderr: Buffer.alloc(0) }; },
    }) });
    expect(episode.stopReason).toBe("timeout");
    expect(episode.commands[0].status).toBe("indeterminate");
    expect(sends).toBe(1);
    expect(closed).toBe(true);
  });

  test("empty EOF after sending is indeterminate, not a successful game exit", async () => {
    const { store } = await makeStore();
    const episode = await runScript({ store, seed: 42, commands: ["north"],
      transportFactory: () => new ProcessTransport([process.execPath, "--no-env-file", "run", join(import.meta.dir, "fixtures/process.ts"), "empty-response"], ROOT) });
    expect(episode.status).toBe("incomplete");
    expect(episode.stopReason).toBe("unexpected_exit");
    expect(episode.commands[0].status).toBe("indeterminate");
    await expect(replay(episode)).rejects.toThrow("incomplete");
  });

  test("deadline expiring during persistence sends no command", async () => {
    const { store } = await makeStore();
    const original = store.intent.bind(store);
    store.intent = (...args) => { original(...args); Bun.sleepSync(60); };
    let sends = 0;
    const episode = await runScript({ store, seed: 42, commands: ["north"], limits: { episodeMs: 50 }, transportFactory: () => ({
      next: async () => ({ raw: Buffer.from("ready\n> \n"), kind: "prompt" }),
      send: async () => { sends++; }, endInput: () => {},
      close: async () => ({ exitCode: 0, forced: false, stdout: Buffer.from("ready\n> \n"), stderr: Buffer.alloc(0) }),
    }) });
    expect(sends).toBe(0);
    expect(episode.stopReason).toBe("episode_limit");
    expect(episode.commands[0].status).toBe("indeterminate");
  });

  test("final identity-read failure persists captured output and failure", async () => {
    const { store, path } = await makeStore();
    let reads = 0;
    const episode = await runScript({ store, seed: 42, commands: [], identityProvider: async () => {
      if (reads++ > 0) throw new Error("missing source file");
      return gameIdentity();
    } });
    expect(episode.status).toBe("incomplete");
    expect(episode.stopReason).toBe("game_changed");
    store.close();
    const reopened = new Store(path, true);
    stores.push(reopened);
    expect(reopened.get(episode.id).stdout.toString()).toContain("HP: 10/10");
    expect(reopened.get(episode.id).error).toContain("missing source file");
  });

  test("intent is durable before send and a failed response is never resent", async () => {
    const { store, path } = await makeStore();
    let sends = 0;
    let closed = false;
    let receives = 0;
    const transport: Transport = {
      next: async () => {
        if (receives++ === 0) return { raw: Buffer.from("ready\n> \n"), kind: "prompt" };
        throw new RunError("timeout", "No acknowledgment");
      },
      send: async () => {
        const witness = new Database(path, { readonly: true });
        try {
          expect(witness.query("SELECT text, status FROM commands").all()).toEqual([{ text: "north", status: "intent" }]);
        } finally { witness.close(); }
        sends++;
      },
      endInput: () => {},
      close: async () => { closed = true; return { exitCode: 0, forced: false, stdout: Buffer.from("ready\n> \n"), stderr: Buffer.alloc(0) }; },
    };
    const episode = await runScript({ store, seed: 42, commands: ["north"], transportFactory: () => transport });
    expect(sends).toBe(1);
    expect(closed).toBe(true);
    expect(episode.stopReason).toBe("timeout");
    expect(episode.commands[0].status).toBe("indeterminate");
    await expect(replay(episode)).rejects.toThrow("incomplete");
  });

  test("interrupted running records remain unreplayable after reopen", async () => {
    const { store, path } = await makeStore();
    const id = store.start({ seed: 42, game: await gameIdentity(), limits: DEFAULT_LIMITS, condition: "scripted", plannedCommands: 1 });
    store.intent(id, 0, "north");
    store.close();
    const reopened = new Store(path, true);
    stores.push(reopened);
    const unfinished = reopened.get(id);
    expect(unfinished.status).toBe("running");
    expect(unfinished.commands[0].status).toBe("intent");
    await expect(replay(unfinished)).rejects.toThrow("incomplete");
  });

  test("cancellation before launch creates an incomplete record without spawning", async () => {
    const { store } = await makeStore();
    const controller = new AbortController();
    controller.abort();
    const episode = await runScript({ store, seed: 42, commands: [], signal: controller.signal,
      transportFactory: () => { throw new Error("must not spawn"); } });
    expect(episode.stopReason).toBe("cancelled");
    expect(episode.commands).toHaveLength(0);
  });
});
