import { createRng } from "./rng";
import { createInitialState } from "./world";
import { runProtocolLoop, type ProtocolIO } from "./protocol";

const MAP_WIDTH = 8;
const MAP_HEIGHT = 8;

function parseSeed(argv: string[]): number {
  const flagIndex = argv.findIndex((a) => a === "--seed" || a === "-s");
  if (flagIndex !== -1 && argv[flagIndex + 1] !== undefined) {
    const value = Number(argv[flagIndex + 1]);
    if (!Number.isNaN(value)) return value;
  }

  const eqArg = argv.find((a) => a.startsWith("--seed="));
  if (eqArg) {
    const value = Number(eqArg.split("=")[1]);
    if (!Number.isNaN(value)) return value;
  }

  return Date.now();
}

export async function* readLines(
  input: AsyncIterable<Uint8Array | string>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of input) {
    buffer +=
      typeof chunk === "string"
        ? chunk
        : decoder.decode(chunk, { stream: true });

    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      yield buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
    }
  }

  buffer += decoder.decode();
  if (buffer.length > 0) yield buffer;
}

async function main() {
  const seed = parseSeed(process.argv.slice(2));
  const rng = createRng(seed);
  const state = createInitialState(rng, MAP_WIDTH, MAP_HEIGHT);

  const lines = readLines(process.stdin);

  const io: ProtocolIO = {
    write: (text) => console.log(text),
    readLine: async () => {
      const { value, done } = await lines.next();
      return done ? null : value;
    },
  };

  try {
    await runProtocolLoop(state, rng, io);
  } finally {
    // A win can occur while the parent keeps stdin open. Release the paused
    // iterator so the completed game exits without waiting for another command.
    await lines.return(undefined);
  }
}

if (import.meta.main) {
  await main();
}
