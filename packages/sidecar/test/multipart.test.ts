import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { Sidecar } from '../src/index.js';

/**
 * A multipart upload (an audio transcription) replays from its recording: its client picks a new
 * boundary every time, which is no change to the request. The upstream gets the bytes the client
 * sent, and a change to a part still forks, with that part in the report.
 */
let upstream: Server;
let upstreamUrl: string;
const received: Buffer[] = [];
beforeAll(async () => {
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push(Buffer.concat(chunks));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ text: 'refund order A-1042' }));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((resolve) => upstream.close(() => resolve())));

describe('a multipart model request', () => {
  it('replays from the recording whatever boundary its client picks, and forks on a changed part', async () => {
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, upstreams: { openai: upstreamUrl } });
    const audio = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0xff, 0x0d, 0x0a, 0x2d, 0x2d]);
    // fetch writes a FormData body with a random boundary, as the OpenAI SDK does.
    const transcribe = async (runId: string, file = audio) => {
      const body = new FormData();
      body.append('model', 'whisper-1');
      body.append('file', new Blob([file], { type: 'audio/wav' }), 'ticket.wav');
      const res = await fetch(`${sidecar.envFor(runId).OPENAI_BASE_URL}/audio/transcriptions`, { method: 'POST', headers: { authorization: 'Bearer k' }, body });
      return { status: res.status, text: await res.text() };
    };
    try {
      const rec = sidecar.startRun({ mode: 'record', command: { argv: ['a'], cwd: '.' } });
      expect(await transcribe(rec.runId)).toEqual({ status: 200, text: '{"text":"refund order A-1042"}' });
      sidecar.endRun(rec.runId, 'completed');
      expect(received).toHaveLength(1);
      // Forwarded as sent: the client's own boundary and the file's bytes.
      expect(received[0].toString('latin1')).toMatch(/^--[^\r\n]+\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n/);
      expect(received[0].includes(Buffer.from(audio))).toBe(true);

      for (let i = 0; i < 2; i++) {
        const rep = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command: { argv: ['a'], cwd: '.' } });
        expect(await transcribe(rep.runId)).toEqual({ status: 200, text: '{"text":"refund order A-1042"}' });
        const { summary } = sidecar.endRun(rep.runId, 'completed');
        expect(summary.divergence).toBeNull();
        expect(summary.byOrigin.replayed).toBe(1);
      }
      expect(received).toHaveLength(1);

      // Another recording of the call is another request: the report names the file part.
      const changed = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command: { argv: ['a'], cwd: '.' } });
      await transcribe(changed.runId, new Uint8Array([1, 2, 3]));
      const { divergence } = sidecar.endRun(changed.runId, 'completed').summary;
      expect(divergence).toMatchObject({ type: 'request_changed', callNo: 1 });
      expect(divergence!.diff!.map((e) => e.path).sort()).toEqual(['$.multipart[1].bytes', '$.multipart[1].sha256']);
    } finally {
      await sidecar.close();
      store.close();
    }
  });
});
