import { describe, expect, test } from "bun:test";
import { Framer } from "./framing";

describe("public byte framing", () => {
  test("every possible chunk boundary preserves UTF-8 and prompt bytes", () => {
    const wire = Buffer.from("café 🧪\n> \nerror\n> \nYou win!\n");
    for (let split = 0; split <= wire.length; split++) {
      const framer = new Framer();
      const frames = [...framer.push(wire.subarray(0, split)), ...framer.push(wire.subarray(split)), framer.finish()];
      expect(frames.map(frame => frame.kind)).toEqual(["prompt", "prompt", "eof"]);
      expect(frames.map(frame => frame.raw.toString())).toEqual(["café 🧪\n> \n", "error\n> \n", "You win!\n"]);
      expect(Buffer.concat(frames.map(frame => frame.raw))).toEqual(wire);
    }
  });

  test("empty EOF after a prompt and prompt-like content are distinct", () => {
    const framer = new Framer();
    expect(framer.push(Buffer.from("text > here\n> \n"))).toHaveLength(1);
    expect(framer.finish()).toEqual({ raw: Buffer.alloc(0), kind: "eof" });
  });
});
