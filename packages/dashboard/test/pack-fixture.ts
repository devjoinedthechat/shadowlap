import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { packRun, Store, storeApiRequest } from '@shadowlap/engine';
import type { PackFile } from '../ui/runspage/pack-folder.js';

/**
 * Packs as the engine's own `packRun` writes them, for Import capture… → Pack to read: a recording
 * whose model call was answered after a retry, and a replay of it, each with its request's blobs and
 * its response's.
 */

const CALL = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint: 'f'.repeat(64), occurrence: 1 };

/** A recording and a replay of it, in `store`. */
export function seedRuns(store: Store, cwd = '/work'): { recording: string; replay: string } {
  const command = { argv: ['node', 'agent.js', '--task', 'triage inbox'], cwd };
  const recording = store.createRun({ mode: 'record', command });
  const request = storeApiRequest(store, { model: 'claude-sonnet-5-5', system: 'You answer refund requests.', messages: [{ role: 'user', content: 'Refund order A-1103' }] });
  const response = store.putBlob(Buffer.from('event: message_start\ndata: {}\n\n'));
  store.appendCallStart({ runId: recording.runId, callNo: 1, ...CALL, origin: 'live', effect: null, requestRef: request, meta: { provider: 'anthropic' }, at: 1 });
  store.appendCallEnd(CALL, { runId: recording.runId, callNo: 1, attempt: 0, responseRef: null, outcome: 'error', meta: { status: 429, retryable: true }, at: 2 });
  store.appendCallEnd(CALL, { runId: recording.runId, callNo: 1, attempt: 1, responseRef: response, outcome: 'ok', meta: { status: 200 }, at: 3 });
  store.endRun(recording.runId, 'completed');
  const replay = store.createRun({ mode: 'replay', parentRunId: recording.runId, command });
  store.appendCallStart({ runId: replay.runId, callNo: 1, ...CALL, origin: 'replayed', effect: null, requestRef: request, meta: {}, at: 4 });
  store.appendCallEnd(CALL, { runId: replay.runId, callNo: 1, attempt: 0, responseRef: response, outcome: 'ok', meta: { status: 200, replayedFrom: 1 }, at: 5 });
  store.endRun(replay.runId, 'completed');
  return { recording: recording.runId, replay: replay.runId };
}

/** The replay packed with the recording it came from, into `<parent>/<name>`: the folder `shadowlap pack <run> <name> --lineage` writes. */
export function writePack(name = 'support-refund', parent = mkdtempSync(join(tmpdir(), 'sl-pack-fixture-'))): { dir: string; runIds: string[] } {
  const store = Store.open(':memory:');
  try {
    const { replay } = seedRuns(store);
    const dir = join(parent, name);
    return { dir, runIds: packRun(store, replay, dir, { lineage: true }).runs };
  } finally {
    store.close();
  }
}

/** Every file under `dir`, named by its path from the folder `dir` is in, as a folder picker names them. */
export function folderFiles(dir: string): PackFile[] {
  const top = join(dir, '..');
  const out: PackFile[] = [];
  const walk = (at: string) => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name);
      const st = statSync(path);
      if (st.isDirectory()) walk(path);
      else out.push({ path: relative(top, path).split(sep).join('/'), bytes: st.size, data: new File([readFileSync(path)], name, { lastModified: st.mtimeMs }) });
    }
  };
  walk(dir);
  return out;
}
