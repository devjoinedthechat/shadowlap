import { describe, expect, it } from 'vitest';
import { actionOf, armName, compareTaskIds, resultsMarkdown, scoreEvaluation, selectTasks, signatureOf, splitRuns, unreachableRepairer, untilRepairerReached } from '../lib.mjs';

describe('selectTasks', () => {
  const ids = ['5', '7', '12', '30'];
  it('takes all, the first n, or named ids in the split\'s order', () => {
    expect(selectTasks('all', ids)).toEqual(ids);
    expect(selectTasks('first:2', ids)).toEqual(['5', '7']);
    expect(selectTasks('30,5', ids)).toEqual(['5', '30']);
    expect(() => selectTasks('5,99', ids)).toThrow('the split has no task 99');
  });

  it('orders ids as numbers when they are', () => {
    expect(['12', '5', '30', 'x'].sort(compareTaskIds)).toEqual(['5', '12', '30', 'x']);
  });
});

describe('signatureOf', () => {
  const blame = (recorded, rescued) => ({ outcome: 'blamed', contrast: { recorded, rescued } });
  it('names what the agent did where the run was lost, and what a passing run did instead', () => {
    expect(signatureOf(blame([{ type: 'tool_call', name: 'cancel_pending_order', input: {} }], [{ type: 'text', text: 'Can you confirm?' }]))).toBe('cancel_pending_order → reply');
    expect(actionOf([{ type: 'tool_call', name: 'b' }, { type: 'tool_call', name: 'a' }, { type: 'tool_call', name: 'a' }])).toBe('a+b');
    expect(signatureOf({ outcome: 'unrescuable' })).toBe('not rescued');
    expect(signatureOf({ outcome: 'error' })).toBe('not blamed');
    expect(signatureOf(undefined)).toBe('not blamed');
  });
});

describe('splitRuns', () => {
  const f = (task, signature) => ({ runId: `r${task}`, task: String(task), signature });
  it('splits every group between halves, spreads single-run groups over both, and alternates passing runs', () => {
    const s = splitRuns(
      [f(9, 'a → b'), f(1, 'a → b'), f(4, 'a → b'), f(2, 'c → d'), f(3, 'e → f'), f(8, 'not rescued')],
      [5, 6, 7, 10].map((t) => ({ runId: `p${t}`, task: String(t) })),
    );
    expect(s.clusters.map((k) => [k.signature, k.dev, k.test, k.repairable])).toEqual([
      ['a → b', ['r1', 'r9'], ['r4'], true],
      ['c → d', [], ['r2'], true],
      ['e → f', ['r3'], [], true],
      ['not rescued', [], ['r8'], false],
    ]);
    expect(s.dev).toEqual({ failed: ['r1', 'r9', 'r3'], passed: ['p5', 'p7'] });
    expect(s.test).toEqual({ failed: ['r4', 'r2', 'r8'], passed: ['p6', 'p10'] });
  });

  it('is the same split however the runs arrive', () => {
    const runs = [f(3, 'x'), f(1, 'x'), f(2, 'y')];
    expect(splitRuns(runs, [])).toEqual(splitRuns([...runs].reverse(), []));
  });
});

describe('untilRepairerReached', () => {
  const unreachable = { outcome: 'not-fixed', warnings: ['the repairer could not be asked: Claude Code answered with an error: API Error: Connection error.'] };
  const reached = { outcome: 'fixed', warnings: ['no held-out runs: the change was only tried on the runs it was written for (--holdout)'] };

  it('runs the repair again after each wait until the repairer answers', async () => {
    const reports = [unreachable, unreachable, reached];
    const slept = [];
    const notes = [];
    const got = await untilRepairerReached(async () => reports.shift(), [1, 2, 5], async (m) => slept.push(m), (why, m) => notes.push(m));
    expect(got).toBe(reached);
    expect(slept).toEqual([1, 2]);
    expect(notes).toEqual([1, 2]);
  });

  it('gives up with nothing when the repairer never answers, and takes other warnings as an answer', async () => {
    let runs = 0;
    expect(await untilRepairerReached(async () => (runs++, unreachable), [1, 2], async () => {}, () => {})).toBeNull();
    expect(runs).toBe(3);
    expect(unreachableRepairer(reached)).toBeNull();
    expect(unreachableRepairer({ outcome: 'error' })).toBeNull();
  });
});

describe('scoring and reporting', () => {
  const verify = {
    runs: [
      { role: 'target', outcome: 'fixed' },
      { role: 'target', outcome: 'not-fixed' },
      { role: 'target', outcome: 'unsettled' },
      { role: 'good', outcome: 'kept' },
      { role: 'good', outcome: 'broken' },
    ],
    cost: { spent: 1.25 },
  };

  it('counts test failures fixed and passing runs broken', () => {
    expect(scoreEvaluation(verify)).toEqual({ fixed: 1, failures: 3, broken: 1, passing: 2, unsettled: 1, spent: 1.25 });
    expect(armName('anthropic:claude-opus-5-5')).toBe('anthropic-claude-opus-5-5');
  });

  it('writes a row per arm, the control among them', () => {
    const md = resultsMarkdown({
      config: { domain: 'retail', split: 'test', agentLlm: 'openai/gpt-5-mini', userLlm: 'openai/gpt-4.1', apiBase: null, seed: 300, tau2Commit: '5bfa7e37b36656b3', rescueTemperature: 1, attempts: 5, passes: 4 },
      runs: { a: { passed: true }, b: { passed: false }, c: { passed: false } },
      blames: { b: { outcome: 'blamed' }, c: { outcome: 'unrescuable' } },
      split: { clusters: [{ signature: 'x', repairable: true }], dev: { failed: ['b'], passed: ['a'] }, test: { failed: ['c'], passed: [] } },
      arms: {
        'anthropic-claude-opus-5-5': { repairer: 'anthropic:claude-opus-5-5', repairs: [{ outcome: 'fixed', spent: 0.5 }], evaluation: { fixed: 1, failures: 1, broken: 0, passing: 0, spent: 0.25 } },
        control: { repairer: null, evaluation: { fixed: 0, failures: 1, broken: 0, passing: 0, spent: 0.2 } },
      },
      cost: { record: 1, blame: 2 },
    });
    expect(md).toContain('# tau2-bench retail, test split: repairing failures with Shadowlap');
    expect(md).toContain('**Recorded**: 3 tasks, 1 passed and 2 failed ($1.00)');
    expect(md).toContain('**Split**: 1 group of failures a fix can learn from. Dev half: 1 failure and 1 passing run; test half: 1 failure and 0 passing runs');
    expect(md).toContain('**Blamed**: 1 of 2 failures localized');
    expect(md).toContain('| anthropic-claude-opus-5-5 | `anthropic:claude-opus-5-5` | 1 of 1 group | 1 of 1 (100%) | 0 of 0 | $0.75 |');
    expect(md).toContain('| control | none (placebo) | — | 0 of 1 (0%) | 0 of 0 | $0.20 |');
  });
});
