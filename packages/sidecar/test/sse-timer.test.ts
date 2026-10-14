import { describe, expect, it } from 'vitest';
import { SseTimer } from '../src/sse.js';

const offsets = (chunks: string[]) => {
  const t = new SseTimer();
  for (const c of chunks) t.push(Buffer.from(c, 'latin1'));
  return t.events.map(([offset]) => offset);
};

describe('SseTimer', () => {
  it('finds event boundaries with LF, CRLF (Google) and CR line endings', () => {
    expect(offsets(['data: a\n\ndata: b\n\n'])).toEqual([9, 18]);
    expect(offsets(['data: a\r\n\r\ndata: b\r\n\r\n'])).toEqual([11, 22]);
    expect(offsets(['data: a\r\rdata: b\r\r'])).toEqual([9, 18]);
  });

  it('finds a boundary split across chunks once', () => {
    expect(offsets(['data: a\r\n', '\r\ndata: b\r', '\n\r\n'])).toEqual([11, 22]);
    expect(offsets(['data: a\n', '\n', 'data: b\n\n'])).toEqual([9, 18]);
  });
});
