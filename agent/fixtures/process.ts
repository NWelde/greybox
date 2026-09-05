import { closeSync } from "node:fs";

// Synthetic child processes for lifecycle tests; never used as the real game.
const mode = process.argv[2];
if (mode === "startup-hang") {
  setInterval(() => {}, 1000);
} else if (mode === "early-exit") {
  process.stderr.write("fixture failure\n");
  process.exit(7);
} else if (mode === "output-flood") {
  for (let i = 0; i < 100; i++) process.stderr.write("x".repeat(1024));
} else if (mode === "env") {
  // Output booleans only, never any credential values.
  console.log(JSON.stringify({
    inherited: Boolean(process.env.GREYBOX_TEST_SECRET),
    dotenv: Boolean(process.env.GREYBOX_TEST_DOTENV),
    gemini: Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
  }));
} else if (mode === "response-hang") {
  setInterval(() => {}, 1000);
  console.log("ready\n> ");
  for await (const _chunk of process.stdin) {
    // Consume once, never acknowledge, even when input is closed.
    await new Promise(() => {});
  }
} else if (mode === "empty-response") {
  console.log("ready\n> ");
  for await (const _chunk of process.stdin) break;
} else if (mode === "unsolicited") {
  process.stdout.write("ready\n> \nunsolicited\n> \n");
  for await (const _chunk of process.stdin) { /* Discard commands. */ }
} else if (mode === "unsolicited-tail") {
  process.stdout.write("ready\n> \nunsolicited-tail");
  for await (const _chunk of process.stdin) break;
} else if (mode === "closed-stdout") {
  closeSync(1);
  setInterval(() => {}, 1000);
} else if (mode === "fragmented") {
  const raw = Buffer.from("café 🧪\n> \n");
  for (const byte of raw) {
    process.stdout.write(Buffer.from([byte]));
    await Bun.sleep(1);
  }
  for await (const chunk of process.stdin) {
    process.stdout.write(chunk);
    console.log("done");
    break;
  }
} else {
  throw new Error("Unknown fixture mode");
}
