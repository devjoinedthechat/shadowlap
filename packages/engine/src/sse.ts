/** Server-sent events as recorded: parsed events with their byte offsets. */

export interface SseEvent {
  event: string;
  data: unknown;
  /** Byte offset just past this event's terminating blank line. */
  endOffset: number;
}

export function parseSse(bytes: Buffer): SseEvent[] {
  const text = bytes.toString('latin1');
  const events: SseEvent[] = [];
  // An event ends at a blank line, whichever line ending the server uses: Google's APIs send CRLF.
  const boundary = /\r\n\r\n|\n\n|\r\r/g;
  let from = 0;
  for (let m = boundary.exec(text); m; m = boundary.exec(text)) {
    const raw = text.slice(from, m.index);
    const end = m.index + m[0].length;
    from = end;
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of raw.split(/\r\n|\r|\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) continue;
    const joined = Buffer.from(dataLines.join('\n'), 'latin1').toString('utf8');
    let data: unknown = joined;
    try {
      data = JSON.parse(joined);
    } catch {
      // keep the raw string
    }
    events.push({ event, data, endOffset: end });
  }
  return events;
}
