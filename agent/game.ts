import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PROMPT } from "./framing";

export const ROOT = resolve(import.meta.dir, "..");

export interface GameIdentity {
  sourceHash: string;
  runtime: string;
  promptHex: string;
}

export async function gameIdentity(root = ROOT): Promise<GameIdentity> {
  const hash = createHash("sha256");
  const names = (await readdir(join(root, "game-test")))
    .filter(name => name.endsWith(".ts") && !name.endsWith(".test.ts")).sort();
  for (const name of names) {
    const content = await readFile(join(root, "game-test", name));
    hash.update(name + "\0" + content.length + "\0");
    hash.update(content);
  }
  return { sourceHash: hash.digest("hex"), runtime: `bun-${Bun.version}-${process.platform}-${process.arch}`, promptHex: PROMPT.toString("hex") };
}

export function gameCommand(seed: number, root = ROOT): string[] {
  return [process.execPath, "--no-env-file", "run", join(root, "game-test/main.ts"), "--seed", String(seed)];
}
