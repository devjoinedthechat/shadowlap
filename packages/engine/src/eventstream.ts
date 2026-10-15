import { crc32 } from 'node:zlib';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** One AWS event stream frame: its header bytes, its payload, and the frame as it was. */
export interface EventStreamFrame {
  headers: Buffer;
  payload: Buffer;
  raw: Buffer;
}

/**
 * The frames of an AWS event stream with both checksums of each verified, or null when `body` is not
 * one: the frames must cover it exactly. Strict on purpose, so a binary body that only looks like a
 * stream is never taken apart and written back.
 */
export function eventStreamFrames(body: Buffer): EventStreamFrame[] | null {
  const frames: EventStreamFrame[] = [];
  let at = 0;
  while (at < body.length) {
    if (at + 16 > body.length) return null;
    const total = body.readUInt32BE(at);
    const headerLength = body.readUInt32BE(at + 4);
    if (total < 16 || at + total > body.length || 16 + headerLength > total) return null;
    if (body.readUInt32BE(at + 8) !== crc32(body.subarray(at, at + 8))) return null;
    if (body.readUInt32BE(at + total - 4) !== crc32(body.subarray(at, at + total - 4))) return null;
    frames.push({ headers: body.subarray(at + 12, at + 12 + headerLength), payload: body.subarray(at + 12 + headerLength, at + total - 4), raw: body.subarray(at, at + total) });
    at += total;
  }
  return frames.length ? frames : null;
}

/** One event stream frame with the given header bytes and payload, its checksums computed. */
export function encodeEventStreamFrame(headers: Buffer, payload: Buffer): Buffer {
  const prelude = Buffer.alloc(12);
  prelude.writeUInt32BE(16 + headers.length + payload.length, 0);
  prelude.writeUInt32BE(headers.length, 4);
  prelude.writeUInt32BE(crc32(prelude.subarray(0, 8)), 8);
  const message = Buffer.concat([prelude, headers, payload]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(message), 0);
  return Buffer.concat([message, tail]);
}

/**
 * AWS event stream frames: a 12-byte prelude (total length, header length, CRC), headers, payload,
 * and a trailing CRC. Checksums are not verified here; the bytes are stored as received, and this
 * only reads what the timeline shows.
 */
export function* eventStreamMessages(body: Buffer): Generator<{ type: string | null; payload: Record<string, unknown> | null }> {
  let at = 0;
  while (at + 16 <= body.length) {
    const total = body.readUInt32BE(at);
    const headerLength = body.readUInt32BE(at + 4);
    if (total < 16 || at + total > body.length) return;
    let h = at + 12;
    const headersEnd = h + headerLength;
    let type: string | null = null;
    while (h < headersEnd && h < body.length) {
      const nameLength = body.readUInt8(h);
      const name = body.toString('utf8', h + 1, h + 1 + nameLength);
      const valueType = body.readUInt8(h + 1 + nameLength);
      let v = h + 2 + nameLength;
      if (valueType === 7) {
        // string
        const valueLength = body.readUInt16BE(v);
        const value = body.toString('utf8', v + 2, v + 2 + valueLength);
        if (name === ':event-type' || name === ':exception-type') type = value;
        v += 2 + valueLength;
      } else if (valueType === 6) {
        v += 2 + body.readUInt16BE(v); // byte buffer
      } else {
        v += [0, 0, 1, 2, 4, 8, 16, 0, 8, 4][valueType] ?? 0;
      }
      h = v;
    }
    const payloadBuf = body.subarray(headersEnd, at + total - 4);
    let payload: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(payloadBuf.toString('utf8')) as unknown;
      if (isObject(parsed)) {
        // invoke-with-response-stream wraps the provider's own event in base64.
        if (typeof parsed.bytes === 'string') {
          const inner = JSON.parse(Buffer.from(parsed.bytes, 'base64').toString('utf8')) as unknown;
          payload = isObject(inner) ? inner : null;
          if (payload && typeof payload.type === 'string') type = payload.type;
        } else payload = parsed;
      }
    } catch {
      payload = null;
    }
    yield { type, payload };
    at += total;
  }
}
