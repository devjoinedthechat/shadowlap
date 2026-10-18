import { describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { Sidecar } from '../src/server.js';

describe('run summary warnings', () => {
  it('says so when a recording captured no model calls', async () => {
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store });
    try {
      const empty = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '/' } });
      expect(sidecar.endRun(empty.runId, 'completed').summary.warnings.join('\n')).toMatch(/Nothing was recorded.*ANTHROPIC_BASE_URL/);

      const toolsOnly = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '/' } });
      const res = await fetch(`${sidecar.envFor(toolsOnly.runId).SHADOWLAP_URL}/v1/calls/resolve`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-shadowlap-run': toolsOnly.runId }, body: JSON.stringify({ kind: 'tool', name: 'read_file', effect: 'read', args: { path: 'a' } }) });
      expect(res.status).toBe(200);
      const { callNo } = (await res.json()) as { callNo: number };
      await fetch(`${sidecar.envFor(toolsOnly.runId).SHADOWLAP_URL}/v1/calls/${callNo}/complete`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-shadowlap-run': toolsOnly.runId }, body: JSON.stringify({ outcome: 'ok', result: 'x', latencyMs: 1 }) });
      expect(sidecar.endRun(toolsOnly.runId, 'completed').summary.warnings.join('\n')).toMatch(/1 SDK call recorded but no model API calls/);
    } finally {
      await sidecar.close();
      store.close();
    }
  });

  it('runs a --live-tool tool live after an earlier fork, and does not ask for the flag it was given', async () => {
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store });
    const call = async (runId: string, body: Record<string, unknown>, result?: unknown) => {
      const base = sidecar.envFor(runId).SHADOWLAP_URL;
      const headers = { 'content-type': 'application/json', 'x-shadowlap-run': runId };
      const r = (await (await fetch(`${base}/v1/calls/resolve`, { method: 'POST', headers, body: JSON.stringify(body) })).json()) as { origin: string; callNo: number; result?: unknown };
      if (r.origin === 'live') await fetch(`${base}/v1/calls/${r.callNo}/complete`, { method: 'POST', headers, body: JSON.stringify({ outcome: 'ok', result, latencyMs: 1 }) });
      return r;
    };
    try {
      const rec = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '/' } });
      await call(rec.runId, { kind: 'tool', name: 'lookup', effect: 'read', args: { q: 'a' } }, 'a');
      await call(rec.runId, { kind: 'tool', name: 'calc', effect: 'pure', args: { x: 2 }, implHash: 'v1' }, { doubled: 5 });
      sidecar.endRun(rec.runId, 'completed');

      // The fix changed calc and what the agent looks up, so the run forks before calc is reached.
      const rep = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command: { argv: ['agent'], cwd: '/' }, replay: { liveTools: new Set(['calc']) } });
      expect((await call(rep.runId, { kind: 'tool', name: 'lookup', effect: 'read', args: { q: 'b' } }, 'b')).origin).toBe('live');
      expect((await call(rep.runId, { kind: 'tool', name: 'calc', effect: 'pure', args: { x: 2 }, implHash: 'v2' }, { doubled: 4 })).origin).toBe('live');
      const { summary } = sidecar.endRun(rep.runId, 'completed');
      expect(summary.warnings.join('\n')).not.toMatch(/--live-tool calc/);
    } finally {
      await sidecar.close();
      store.close();
    }
  });
});
