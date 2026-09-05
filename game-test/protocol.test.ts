import { describe, expect, test } from "bun:test";
import {
  BANNER,
  PROMPT,
  UNKNOWN_COMMAND,
  parseCommand,
  renderState,
  runProtocolLoop,
  type ProtocolIO,
} from "./protocol";
import { createRng } from "./rng";
import type { GameState } from "./world";

function makeState(): GameState {
  return {
    map: {
      width: 4,
      height: 3,
      cells: [
        ["wall", "wall", "wall", "wall"],
        ["wall", "floor", "floor", "wall"],
        ["wall", "wall", "wall", "wall"],
      ],
    },
    player: { position: { x: 1, y: 1 }, hp: 8, maxHp: 10, inventory: [] },
    monsters: [{ position: { x: 2, y: 1 }, hp: 5, maxHp: 5 }],
    groundItems: [
      { id: "p1", type: "potion", value: 3, position: { x: 1, y: 1 } },
    ],
    score: 2,
  };
}

describe("parseCommand", () => {
  test("garbage input returns null and doesn't throw", () => {
    expect(() => parseCommand("asdkfjasldkf")).not.toThrow();
    expect(parseCommand("asdkfjasldkf")).toBeNull();
  });

  test("empty input returns null", () => {
    expect(parseCommand("")).toBeNull();
  });

  test("recognizes a movement word", () => {
    expect(parseCommand("north")).toEqual({ kind: "move", direction: "up" });
  });

  test("is case-insensitive and trims whitespace", () => {
    expect(parseCommand("  NORTH  ")).toEqual({
      kind: "move",
      direction: "up",
    });
  });
});

describe("renderState", () => {
  test("output is stable for a given state", () => {
    const state = makeState();

    const a = renderState(state);
    const b = renderState(makeState());

    expect(a).toBe(b);
  });

  test("includes the player's HP", () => {
    const state = makeState();

    expect(renderState(state)).toContain("8/10");
  });
});

describe("protocol text", () => {
  test("banner is non-empty and doesn't list commands outright", () => {
    expect(BANNER.length).toBeGreaterThan(0);
    expect(BANNER.toLowerCase()).not.toContain("north");
    expect(BANNER.toLowerCase()).not.toContain("attack");
  });

  test("unknown-command response is non-empty", () => {
    expect(UNKNOWN_COMMAND.length).toBeGreaterThan(0);
  });

  test("the public prompt is reserved from ordinary output lines", () => {
    const ordinaryOutput = [BANNER, UNKNOWN_COMMAND, renderState(makeState())];
    const lines = ordinaryOutput.flatMap((output) => output.split("\n"));

    expect(PROMPT).toBe("> ");
    expect(lines).not.toContain(PROMPT);
  });
});

type ProtocolEvent =
  | { kind: "write"; text: string }
  | { kind: "read" };

function makeScriptedIo(inputs: Array<string | null>): {
  io: ProtocolIO;
  events: ProtocolEvent[];
} {
  const events: ProtocolEvent[] = [];
  let inputIndex = 0;

  return {
    events,
    io: {
      write(text) {
        events.push({ kind: "write", text });
      },
      async readLine() {
        events.push({ kind: "read" });
        return inputs[inputIndex++] ?? null;
      },
    },
  };
}

describe("runProtocolLoop", () => {
  test("frames startup, error-only, and action observations before each read", async () => {
    const state = { ...makeState(), monsters: [] };
    const { io, events } = makeScriptedIo(["not-a-command", "wait", null]);

    await runProtocolLoop(state, createRng(7), io);

    expect(events).toEqual([
      { kind: "write", text: BANNER },
      { kind: "write", text: renderState(state) },
      { kind: "write", text: PROMPT },
      { kind: "read" },
      { kind: "write", text: UNKNOWN_COMMAND },
      { kind: "write", text: PROMPT },
      { kind: "read" },
      { kind: "write", text: renderState(state) },
      { kind: "write", text: PROMPT },
      { kind: "read" },
    ]);
  });

  test("writes terminal output without a following prompt or read", async () => {
    const state: GameState = {
      map: {
        width: 4,
        height: 3,
        cells: [
          ["wall", "wall", "wall", "wall"],
          ["wall", "floor", "exit", "wall"],
          ["wall", "wall", "wall", "wall"],
        ],
      },
      player: {
        position: { x: 1, y: 1 },
        hp: 10,
        maxHp: 10,
        inventory: [],
      },
      monsters: [],
      groundItems: [],
      score: 0,
    };
    const { io, events } = makeScriptedIo(["east"]);

    const result = await runProtocolLoop(state, createRng(7), io);

    expect(result.player.position).toEqual({ x: 2, y: 1 });
    expect(events.filter((event) => event.kind === "read")).toHaveLength(1);
    expect(
      events.filter(
        (event) => event.kind === "write" && event.text === PROMPT,
      ),
    ).toHaveLength(1);
    expect(events.at(-1)).toEqual({
      kind: "write",
      text: "You found the exit. You win!",
    });
  });
});
