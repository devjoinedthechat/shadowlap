import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { ImportWriter, type CapturedCall } from '../src/import-capture.js';

/**
 * An import of a capture a month old, while it is still writing: the run's process is alive and
 * writing, so gc and push take it for a run being written, not one its process left, however old
 * the capture's own times are.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const DAY = 86_400_000;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sl-import-live-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const call = (i: number, at: number): CapturedCall => ({
  url: 'https://api.anthropic.com/v1/messages',
  method: 'POST',
  requestHeaders: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
  requestBody: { model: 'claude-haiku-4-5', max_tokens: 16, messages: [{ role: 'user', content: `ticket ${i}` }] },
  status: 200,
  responseHeaders: { 'content-type': 'application/json' },
  responseBytes: Buffer.from(JSON.stringify({ id: `msg_${i}`, model: 'claude-haiku-4-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 5, output_tokens: 1 } })),
  startedAt: at,
  timeMs: 100,
});

describe('an import of an old capture, while it writes', () => {
  it('is a run being written for gc in another process, and gets the capture\'s start when it ends', () => {
    const db = join(dir, 'shadowlap.db');
    const store = Store.open(db);
    const capturedAt = Date.now() - 30 * DAY;
    const writer = new ImportWriter(store, { source: 'old.har', startedAt: capturedAt, covers: ['api'] });
    for (let i = 0; i < 3; i++) expect(writer.api(call(i, capturedAt + i * 1000))).toBe(true);

    // gc --older-than 7 from another process, as a terminal runs it during the import.
    const out = execFileSync(process.execPath, [CLI, '--db', db, 'gc', '--older-than', '7', '--json'], { cwd: dir, encoding: 'utf8', env: { ...process.env, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1' } });
    expect(JSON.parse(out)).toMatchObject({ count: 0, recordingCount: 1, abandonedCount: 0 });
    expect(store.getRun(writer.run.runId)).toMatchObject({ status: 'running' });
    expect(store.getCalls(writer.run.runId)).toHaveLength(3);

    const { run } = writer.finish();
    expect(run).toMatchObject({ status: 'completed', startedAt: capturedAt, endedAt: capturedAt + 2000 + 100 });
    store.close();
  });
});
