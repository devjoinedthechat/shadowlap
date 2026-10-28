import { crc32 } from 'node:zlib';
import { isObject } from './is-object.js';

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
 * The width of a header value of a fixed-size type, by type: true and false (none), a byte, a
 * short, an integer, a long, then a timestamp (8) and a UUID (16). A byte array (6) and a string (7)
 * carry their own length.
 */
const FIXED_WIDTH: Readonly<Record<number, number>> = { 0: 0, 1: 0, 2: 1, 3: 2, 4: 4, 5: 8, 8: 8, 9: 16 };

/** The `:event-type` (or `:exception-type`) a frame's header bytes name, or null. A header of a type no reader knows ends the walk: its width is unknown. */
function frameType(body: Buffer, from: number, to: number): string | null {
  let type: string | null = null;
  let h = from;
  while (h < to) {
    const nameLength = body.readUInt8(h);
    if (h + 2 + nameLength > to) return type;
    const name = body.toString('utf8', h + 1, h + 1 + nameLength);
    const valueType = body.readUInt8(h + 1 + nameLength);
    const v = h + 2 + nameLength;
    if (valueType === 6 || valueType === 7) {
      if (v + 2 > to) return type;
      const valueLength = body.readUInt16BE(v);
      if (valueType === 7 && (name === ':event-type' || name === ':exception-type')) type = body.toString('utf8', v + 2, Math.min(v + 2 + valueLength, to));
      h = v + 2 + valueLength;
    } else {
      const width = FIXED_WIDTH[valueType];
      if (width === undefined) return type;
      h = v + width;
    }
  }
  return type;
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
    const headersEnd = Math.min(at + 12 + headerLength, at + total - 4);
    let type = frameType(body, at + 12, headersEnd);
    const payloadBuf = body.subarray(at + 12 + headerLength, at + total - 4);
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
