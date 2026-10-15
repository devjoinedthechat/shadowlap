import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { packRun, Store } from '@shadowlap/engine';
import { Sidecar } from '@shadowlap/sidecar';
import { RecordingHost } from '../src/recordings.js';

/** Who made a run, for runs the test-runner recordings host starts (the CLI's own commands are covered in dashboard-events). */
let store: Store;
let sidecar: Sidecar;
let host: RecordingHost;
let root: string;

beforeAll(async () => {
  process.env.SHADOWLAP_AUTHOR = 'ravi@example.com';
  store = Store.open(':memory:');
  root = mkdtempSync(join(tmpdir(), 'sl-authors-'));
  host = new RecordingHost(store, root, { codeVersion: null, redact: [] });
  sidecar = await Sidecar.start({ store, upstreams: {}, api: host.api });
  host.attach(sidecar);
});
afterAll(async () => {
  host.close();
  await sidecar.close();
  store.close();
  delete process.env.SHADOWLAP_AUTHOR;
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('runs the recordings host starts', () => {
  it('carry who recorded or replayed them', () => {
    const recorded = host.start({ recording: 'recs/new', slot: 'a' });
    expect(recorded.mode).toBe('record');
    expect(store.getRun(recorded.runId)!.meta?.author).toBe('ravi@example.com');

    // A committed recording replays: that run is stamped too.
    const golden = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd: '.' } });
    store.endRun(golden.runId, 'completed');
    packRun(store, golden.runId, join(root, 'recs', 'old'));
    const replayed = host.start({ recording: 'recs/old', slot: 'b' });
    expect(replayed.mode).toBe('replay');
    expect(store.getRun(replayed.runId)!.meta?.author).toBe('ravi@example.com');
  });
});
