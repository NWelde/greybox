// Public transport contract. Do not import the game's private protocol module.
export const PROMPT = Buffer.from("\n> \n");

export interface Frame {
  raw: Buffer;
  kind: "prompt" | "eof";
}

export class Framer {
  private pending = Buffer.alloc(0);

  get pendingBytes(): number { return this.pending.length; }

  push(chunk: Uint8Array): Frame[] {
    this.pending = Buffer.concat([this.pending, chunk]);
    const frames: Frame[] = [];
    let index: number;
    while ((index = this.pending.indexOf(PROMPT)) !== -1) {
      const end = index + PROMPT.length;
      frames.push({ raw: Buffer.from(this.pending.subarray(0, end)), kind: "prompt" });
      this.pending = this.pending.subarray(end);
    }
    return frames;
  }

  finish(): Frame {
    const raw = Buffer.from(this.pending);
    this.pending = Buffer.alloc(0);
    return { raw, kind: "eof" };
  }
}
