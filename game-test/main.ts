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

async function main() {
  const seed = parseSeed(process.argv.slice(2));
  const rng = createRng(seed);
  const state = createInitialState(rng, MAP_WIDTH, MAP_HEIGHT);

  async function* readLines() {
    let buffer = "";
    for await (const chunk of process.stdin) {
      buffer += chunk.toString();
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        yield buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
      }
    }
    if (buffer.length > 0) yield buffer;
  }

  const lines = readLines();

  const io: ProtocolIO = {
    write: (text) => console.log(text),
    readLine: async () => {
      const { value, done } = await lines.next();
      return done ? null : value;
    },
  };

  await runProtocolLoop(state, rng, io);
}

main();
