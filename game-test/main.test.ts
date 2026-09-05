import { describe, expect, test } from "bun:test";
import { readLines } from "./main";
import { UNKNOWN_COMMAND } from "./protocol";
import { createRng } from "./rng";
import {
  createInitialState,
  type GameState,
  type Position,
} from "./world";

const GAME_PATH = `${import.meta.dir}/main.ts`;
const MAP_WIDTH = 8;
const MAP_HEIGHT = 8;

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runGame(seed: number, commands: string[]): Promise<CliResult> {
  const stdin = new Blob([`${commands.join("\n")}\n`]);
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "run",
      GAME_PATH,
      "--seed",
      String(seed),
    ],
    {
      env: { LANG: "C.UTF-8", TZ: "UTC" },
      stdin,
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { stdout, stderr, exitCode };
}

interface RouteStep {
  position: Position;
  commands: string[];
}

const ROUTE_DIRECTIONS = [
  { command: "north", dx: 0, dy: -1 },
  { command: "south", dx: 0, dy: 1 },
  { command: "west", dx: -1, dy: 0 },
  { command: "east", dx: 1, dy: 0 },
] as const;

function positionKey(position: Position): string {
  return `${position.x},${position.y}`;
}

function routeTo(
  state: GameState,
  target: Position,
  allowExitAsTarget = false,
): string[] {
  const queue: RouteStep[] = [
    { position: state.player.position, commands: [] },
  ];
  const visited = new Set([positionKey(state.player.position)]);

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (positionKey(current.position) === positionKey(target)) {
      return current.commands;
    }

    for (const direction of ROUTE_DIRECTIONS) {
      const position = {
        x: current.position.x + direction.dx,
        y: current.position.y + direction.dy,
      };
      const cell = state.map.cells[position.y]?.[position.x];
      const isTarget = positionKey(position) === positionKey(target);

      if (cell === undefined || cell === "wall") continue;
      if (cell === "exit" && !(allowExitAsTarget && isTarget)) continue;
      if (visited.has(positionKey(position))) continue;

      visited.add(positionKey(position));
      queue.push({
        position,
        commands: [...current.commands, direction.command],
      });
    }
  }

  throw new Error(`no exit-avoiding route to ${positionKey(target)}`);
}

function initialState(seed: number): GameState {
  return createInitialState(createRng(seed), MAP_WIDTH, MAP_HEIGHT);
}

describe("stdin line streaming", () => {
  test("reassembles a non-ASCII command split across UTF-8 chunks", async () => {
    const encoded = new TextEncoder().encode("café\nwait\nlast");

    async function* chunks(): AsyncGenerator<Uint8Array> {
      yield encoded.slice(0, 4);
      yield encoded.slice(4, 8);
      yield encoded.slice(8);
    }

    const lines: string[] = [];
    for await (const line of readLines(chunks())) lines.push(line);

    expect(lines).toEqual(["café", "wait", "last"]);
  });
});

describe("real game CLI", () => {
  test("uses the reserved wire delimiter for startup, errors, and actions", async () => {
    const result = await runGame(42, ["not-a-command", "wait"]);
    const observations = result.stdout.split("\n> \n");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(observations).toHaveLength(4);
    expect(observations[0]).toContain("HP: 10/10");
    expect(observations[1]).toBe(UNKNOWN_COMMAND);
    expect(observations[2]).toContain("HP: 10/10");
    expect(observations[3]).toBe("");
  });

  test("ends a terminal response at EOF without another prompt", async () => {
    const seed = 42;
    const state = initialState(seed);
    let exitPosition: Position | undefined;

    for (let y = 0; y < state.map.height; y++) {
      for (let x = 0; x < state.map.width; x++) {
        if (state.map.cells[y][x] === "exit") exitPosition = { x, y };
      }
    }

    expect(exitPosition).toBeDefined();
    const commands = routeTo(state, exitPosition!, true);
    const result = await runGame(seed, commands);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toEndWith("You found the exit. You win!\n");
    expect(result.stdout).not.toEndWith("> \n");
  });

  test("reaches planted overheal bug through public commands", async () => {
    const seed = 42;
    const state = initialState(seed);
    const potion = state.groundItems.find((item) => item.type === "potion");

    expect(potion).toBeDefined();
    const commands = [...routeTo(state, potion!.position), "take", "drink"];
    const result = await runGame(seed, commands);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("HP: 13/10");
  });

  test("reaches planted cumulative-score drop bug through public commands", async () => {
    const seed = 42;
    const state = initialState(seed);
    const scoreItem = state.groundItems.find(
      (item) => item.type === "scoreItem",
    );

    expect(scoreItem).toBeDefined();
    const commands = [
      ...routeTo(state, scoreItem!.position),
      "take",
      "drop coin",
    ];
    const result = await runGame(seed, commands);
    const scores = Array.from(
      result.stdout.matchAll(/Score: (-?\d+)/g),
      (match) => Number(match[1]),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(scores.slice(-2)).toEqual([scoreItem!.value, 0]);
  });
});
