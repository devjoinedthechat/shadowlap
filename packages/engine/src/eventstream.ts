const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

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
