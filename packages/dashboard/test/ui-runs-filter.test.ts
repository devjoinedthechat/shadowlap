import { describe, expect, it } from 'vitest';
import { matchesText, type RunLike } from '../ui/runs.js';

/**
 * The filter field in an exported copy, which matches its runs in the page: `label:` exactly, as the
 * server does, `status:` by the verdict Status says, `type:` by the kind its chip lists. A copy keeps
 * no index of what its runs recorded, so `tool:` matches no run there.
 */

const BASE: RunLike = { runId: '01K8RG00000000000000000001', parentRunId: null, mode: 'record', status: 'completed', divergence: null, command: 'node agent.mjs', codeVersion: null, startedAt: 0, calls: 6, spent: 0, saved: 0, captured: 0, imported: false, covers: null, source: null, labels: ['refund-flow'], kind: 'recording', outcome: { kind: 'none' }, failed: false };
const FAILED: RunLike = { ...BASE, runId: '01K8RG00000000000000000002', outcome: { kind: 'lost', callNo: 9 }, failed: true };
const PASSED: RunLike = { ...BASE, runId: '01K8RG00000000000000000003', outcome: { kind: 'passed', checks: 2 } };
const FORK: RunLike = { ...BASE, runId: '01K8RG00000000000000000004', parentRunId: BASE.runId, mode: 'replay', kind: 'fork', divergence: { callNo: 4, type: 'request_changed' } };

const matching = (q: string) => [BASE, FAILED, PASSED, FORK].filter((r) => matchesText(r, q)).map((r) => r.runId);

describe('the filter in an exported copy', () => {
  it('reads status: as Status says it', () => {
    expect(matching('status:failed')).toEqual([FAILED.runId]);
    expect(matching('status:pass')).toEqual([PASSED.runId]);
    expect(matching('status:inconclusive')).toEqual([]);
  });

  it('reads type: as the chips list kinds, with the words and labels beside it', () => {
    expect(matching('type:forks')).toEqual([FORK.runId]);
    expect(matching('type:recording label:refund-flow status:failed')).toEqual([FAILED.runId]);
  });

  it('matches no run for tool:, which it has no index for', () => {
    expect(matching('tool:issue_refund')).toEqual([]);
  });
});
