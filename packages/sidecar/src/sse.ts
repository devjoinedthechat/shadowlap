/**
 * Records SSE event boundaries as [byteOffset, msSinceStart] while bytes stream through, so a
 * recording can later be replayed at its original pacing. Timing cannot be reconstructed later,
 * so it is recorded from day one.
 */
export class SseTimer {
  readonly events: Array<[number, number]> = [];
  private offset = 0;
  private tail = ''; // the last few bytes, to find a boundary split across chunks
  private lastBoundary = 0;
  private readonly start: number;
  private readonly cap: number;

  constructor(start: number = Date.now(), cap = 5000) {
    this.start = start;
    this.cap = cap;
  }

  push(chunk: Buffer): void {
    const text = this.tail + chunk.toString('latin1');
    const base = this.offset - this.tail.length;
    // An event ends at a blank line, whichever line ending the server uses: Google's APIs send CRLF.
    const boundary = /\r\n\r\n|\n\n|\r\r/g;
    for (let m = boundary.exec(text); m; m = boundary.exec(text)) {
      const end = base + m.index + m[0].length;
      if (end <= this.lastBoundary) continue; // already counted from the previous chunk's tail
      this.lastBoundary = end;
      if (this.events.length < this.cap) this.events.push([end, Date.now() - this.start]);
    }
    this.offset += chunk.length;
    this.tail = text.slice(Math.max(0, text.length - 3));
  }
}
