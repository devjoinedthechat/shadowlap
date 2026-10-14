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
});
