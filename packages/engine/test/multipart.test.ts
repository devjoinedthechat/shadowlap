import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fingerprintApi } from '../src/fingerprint.js';
import { multipartView, parseMultipart } from '../src/multipart.js';

/** A form as a client writes it, with the boundary it picked; base64, as the proxy stores a body that isn't JSON. */
function form(boundary: string, parts: Array<{ name: string; filename?: string; type?: string; content: string | Buffer }>): string {
  const chunks: Buffer[] = [];
  for (const p of parts) {
    const disposition = `form-data; name="${p.name}"${p.filename !== undefined ? `; filename="${p.filename}"` : ''}`;
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: ${disposition}\r\n${p.type ? `Content-Type: ${p.type}\r\n` : ''}\r\n`, 'latin1'));
    chunks.push(Buffer.isBuffer(p.content) ? p.content : Buffer.from(p.content, 'utf8'));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks).toString('base64');
}

const audio = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0xff, 0x0d, 0x0a, 0x2d, 0x2d, 0x10]);
const upload = (boundary: string, file = audio, model = 'whisper-1') =>
  form(boundary, [
    { name: 'model', content: model },
    { name: 'file', filename: 'ticket.wav', type: 'audio/wav', content: file },
  ]);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const fp = (body: unknown) => fingerprintApi({ method: 'POST', path: '/v1/audio/transcriptions', headers: {}, body }, [], []).fingerprint;

describe('multipart/form-data requests', () => {
  it('read as their parts: a field by its text, a file by its SHA-256 and size', () => {
    expect(multipartView(upload('----formdata-undici-0123456789'))).toEqual({
      multipart: [
        { name: 'model', value: 'whisper-1' },
        { name: 'file', filename: 'ticket.wav', contentType: 'audio/wav', sha256: sha(audio), bytes: audio.length },
      ],
    });
  });

  it('match whatever boundary the client picked, and differ when a part does', () => {
    const a = upload('----formdata-undici-0123456789');
    const b = upload('9f2c4e1ab37d4c0e8a5b6f7d8e9c0a1b');
    expect(a).not.toBe(b);
    expect(fp(a)).toBe(fp(b));
    expect(fp(upload('x', Buffer.from('another recording')))).not.toBe(fp(a));
    expect(fp(upload('x', audio, 'gpt-4o-transcribe'))).not.toBe(fp(a));
  });

  it('leave any other body as it is', () => {
    for (const body of [null, { model: 'gpt-5' }, 'hello', Buffer.from('--not a form').toString('base64'), Buffer.from('--b\r\nContent-Disposition: form-data; name="a"\r\n\r\nno closing delimiter').toString('base64')]) {
      expect(multipartView(body)).toBe(body);
    }
  });

  it('reads parameters quoted with escapes, unquoted, and a part with no headers', () => {
    const raw = Buffer.from('--b\r\ncontent-disposition: form-data; filename=plain.txt; name="a\\"b"\r\n\r\nx\r\n--b\r\n\r\nbare\r\n--b--', 'latin1');
    expect(parseMultipart(raw)).toEqual([
      { name: 'a"b', filename: 'plain.txt', sha256: sha(Buffer.from('x')), bytes: 1 },
      { name: null, value: 'bare' },
    ]);
  });
});
