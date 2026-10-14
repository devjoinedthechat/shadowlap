import { describe, expect, it } from 'vitest';
import { applyNormalizers } from '../src/normalize.js';
import { covered, generalize, proposeNormalizers } from '../src/calibrate.js';
import type { DivergenceReport } from '../src/types.js';

const divergence = (diff: DivergenceReport['diff'], kind: DivergenceReport['kind'] = 'api', name = 'POST /v1/messages'): DivergenceReport => ({ type: 'request_changed', callNo: 3, kind, name, replayedBefore: 2, ...(diff ? { diff } : {}) });

describe('calibrate', () => {
  it('generalizes a varying token to a narrow pattern anchored on the fixed text before it', () => {
    const pattern = generalize('Write to /tmp/fp-x8Kq2/out.json', 'Write to /tmp/fp-Zp01a/out.json');
    expect(pattern).toBe('/\\/tmp\\/fp-[A-Za-z0-9_]+/');
    expect(generalize('session 48213 started, trace 9f2c1a', 'session 77120 started, trace 0b4e6d')).toBe('/session \\d+|trace [0-9a-f]+/');
    expect(generalize('abc', 'xyz')).toBeNull(); // no fixed text around it
    expect(generalize('The answer is yes.', 'The answer is maybe not.')).toBeNull();
  });

  it('proposes normalizers for what changed between two runs of the same code, and says what it could not explain', () => {
    const d = divergence([
      { path: '$.metadata.user_id', op: 'changed', before: 'req-3f2a91c0-8a51-4b0e-9d2f-0c5e7b1a2d34', after: 'req-a1b2c3d4-0000-4000-8000-000000000001' },
      { path: '$.system', op: 'changed', before: 'Scratch dir: /tmp/agent-k2J9/ (write here)', after: 'Scratch dir: /tmp/agent-Qm01/ (write here)' },
      { path: '$.temperature', op: 'changed', before: 0.31, after: 0.77 },
      { path: '$.messages[3]', op: 'added', after: { role: 'user', content: 'extra' } },
    ]);
    const step = proposeNormalizers(d);
    expect(step.proposals.map((p) => p.normalizer)).toEqual([
      { kind: 'api', path: '$.metadata.user_id', pattern: 'uuid', replace: '<UUID>' },
      { kind: 'api', path: '$.system', pattern: '/\\/tmp\\/agent-[A-Za-z0-9_]+/', replace: '<VAR>' },
      { kind: 'api', path: '$.temperature', replace: '<VAR>' },
    ]);
    expect(step.unexplained.map((e) => e.path)).toEqual(['$.messages[3]']);

    // The proposals make the two requests equal under matching.
    const req = (id: string, dir: string, t: number) => ({ metadata: { user_id: id }, system: `Scratch dir: ${dir} (write here)`, temperature: t });
    const n = step.proposals.map((p) => p.normalizer);
    expect(applyNormalizers(req('req-3f2a91c0-8a51-4b0e-9d2f-0c5e7b1a2d34', '/tmp/agent-k2J9/', 0.31), n, 'api', 'POST /v1/messages')).toEqual(applyNormalizers(req('req-a1b2c3d4-0000-4000-8000-000000000001', '/tmp/agent-Qm01/', 0.77), n, 'api', 'POST /v1/messages'));
  });

  it('skips changes a configured normalizer already covers, and scopes tool proposals to the tool', () => {
    const entry = { path: '$.args.path', op: 'changed' as const, before: 'out/run-4411.json', after: 'out/run-9020.json' };
    const existing = [{ kind: 'tool' as const, name: 'save', path: '$.args.path', pattern: '/run-\\d+/', replace: 'run-N' }];
    expect(covered(entry, 'tool', 'save', existing)).toBe(true);
    expect(proposeNormalizers(divergence([entry], 'tool', 'save'), existing).proposals).toEqual([]);
    expect(proposeNormalizers(divergence([entry], 'tool', 'save')).proposals[0]!.normalizer).toMatchObject({ kind: 'tool', name: 'save', path: '$.args.path' });
  });
});
