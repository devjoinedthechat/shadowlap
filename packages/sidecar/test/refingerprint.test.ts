import { describe, expect, it } from 'vitest';
import { Store, normalizersHash } from '@shadowlap/engine';
import { Sidecar } from '../src/server.js';

/**
 * A replay only recomputes the parent's fingerprints when the normalizer list (or the fingerprint
 * version) differs from the one the recording was made under; otherwise the stored ones are reused.
 */
async function toolCall(sidecar: Sidecar, runId: string, args: unknown): Promise<void> {
  const url = sidecar.envFor(runId).SHADOWLAP_URL;
  const headers = { 'content-type': 'application/json', 'x-shadowlap-run': runId };
  const r = (await (await fetch(`${url}/v1/calls/resolve`, { method: 'POST', headers, body: JSON.stringify({ kind: 'tool', name: 'read', effect: 'read', args }) })).json()) as { origin: string; callNo: number };
  if (r.origin === 'live') await fetch(`${url}/v1/calls/${r.callNo}/complete`, { method: 'POST', headers, body: JSON.stringify({ outcome: 'ok', result: 'x', latencyMs: 1 }) });
}

describe('replay start', () => {
  it('reuses stored fingerprints under the same normalizers and recomputes them under different ones', async () => {
    const store = Store.open(':memory:');
    const logs: string[] = [];
    // Exact dates: this is about normalizers, and the dates below are close to whenever the test runs.
    const a = await Sidecar.start({ store, normalizers: [], clock: 'exact', log: (l) => logs.push(l) });
    const rec = a.startRun({ mode: 'record', command: { argv: ['x'], cwd: '/' } });
    await toolCall(a, rec.runId, { date: '2026-09-15' });
    a.endRun(rec.runId, 'completed');
    expect(store.getRun(rec.runId)?.meta?.normalizersHash).toBe(normalizersHash([]));

    logs.length = 0;
    const same = a.startRun({ mode: 'replay', parentRunId: rec.runId, command: { argv: ['x'], cwd: '/' } });
    expect(logs.join('\n')).toMatch(/reusing stored fingerprints/);
    await toolCall(a, same.runId, { date: '2026-09-15' });
    expect(a.endRun(same.runId, 'completed').summary.byOrigin.replayed).toBe(1);
    await a.close();

    // A normalizer added after the recording: the parent is re-fingerprinted under it and the masked date matches.
    const b = await Sidecar.start({ store, normalizers: [{ kind: 'tool', path: '$.args.date', pattern: 'iso-date', replace: '<date>' }], clock: 'exact', log: (l) => logs.push(l) });
    logs.length = 0;
    const under = b.startRun({ mode: 'replay', parentRunId: rec.runId, command: { argv: ['x'], cwd: '/' } });
    expect(logs.join('\n')).toMatch(/re-fingerprinting 1 call/);
    await toolCall(b, under.runId, { date: '2026-09-16' });
    expect(b.endRun(under.runId, 'completed').summary.byOrigin.replayed).toBe(1);
    // The child's own fingerprints were computed under the new list.
    expect(store.getRun(under.runId)?.meta?.normalizersHash).toBe(normalizersHash([{ kind: 'tool', path: '$.args.date', pattern: 'iso-date', replace: '<date>' }]));
    await b.close();
    store.close();
  });
});
