import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { verdictOf, type RunVerdict } from '../src/run-verdict.js';
import type { RunJudged } from '../src/run-outcome.js';
import { outcomeTip } from '../ui/outcome-card.js';
import { outcomeFact } from '../ui/run/metrics.js';
import { RunsTable } from '../ui/runspage/RunsTable.js';
import { isFailed, outcomeOf, runGlyph, sideStatus, type RunLike, type RunOutcomeWords } from '../ui/runs.js';
import type { RunListItem } from '../ui/types.js';
import { render, type Rendered } from './ui-render.js';

/**
 * Runs' Status, row by row of the design's table of status words: one function says each
 * (`outcomeOf`), and the filter's `status:` reads the same verdict of it (`verdictOf`), so the word a
 * row shows and the runs `status:failed` lists can't tell a run apart.
 */

const BASE: RunLike = { runId: '01K8RG00000000000000000001', parentRunId: null, mode: 'record', status: 'completed', divergence: null, command: 'node agent.mjs', codeVersion: null, startedAt: 0, calls: 6, spent: 0, saved: 0, captured: 0, imported: false, covers: null, source: null, labels: [], kind: 'recording', outcome: { kind: 'none' }, failed: false };
const TEST: RunLike = { ...BASE, runId: '01K8RG00000000000000000002', parentRunId: '01K8RG00000000000000000009', mode: 'replay', kind: 'test', test: { golden: 'goldens/refund', session: 's1' } };
const FORK: RunLike = { ...BASE, runId: '01K8RG00000000000000000003', parentRunId: BASE.runId, mode: 'replay', kind: 'fork', divergence: { callNo: 4, type: 'request_changed' } };

function judged(over: Partial<RunJudged> = {}): RunJudged {
  return { by: 'own', verdict: 'failed', counts: { passed: 0, failed: 1, inconclusive: 0, notApplicable: 0 }, callNo: 6, first: { label: 'send_email called 0 times', detail: 'called 1 time' }, today: false, goldens: [], why: null, ...over };
}

/** The verdict a Status's words stand for: its tone, but for a fixed test replay, which is none. */
function verdictOfWords(out: RunOutcomeWords & { of: string }): RunVerdict | null {
  if (out.of === 'fixed') return null;
  const by: Partial<Record<RunOutcomeWords['tone'], RunVerdict>> = { live: 'live', err: 'failed', warn: 'inconclusive', ok: 'passed', mu: 'not-applicable' };
  return by[out.tone] ?? null;
}

const ROWS: Array<[string, RunLike, Pick<RunOutcomeWords, 'tone' | 'text'> & { today?: true }]> = [
  ['in progress, while it records', { ...BASE, status: 'running', outcome: { kind: 'running' } }, { tone: 'live', text: 'in progress' }],
  ['diverged at #n, a test replay that left its golden there', { ...TEST, status: 'failed', divergence: { callNo: 3, type: 'request_changed' }, outcome: { kind: 'diverged', callNo: 3 }, failed: true }, { tone: 'err', text: 'diverged at #3' }],
  ['exited 1, where its test result kept the code', { ...TEST, status: 'failed', outcome: { kind: 'check-failed', check: null }, failed: true, exitCode: 1 }, { tone: 'err', text: 'exited 1' }],
  ['exited with an error, where nothing kept the code', { ...BASE, status: 'failed', outcome: { kind: 'check-failed', check: null }, failed: true }, { tone: 'err', text: 'exited with an error' }],
  ['check failed at #n, at the call the check names', { ...BASE, outcome: { kind: 'check-failed', check: 'send_email called 0 times' }, failed: true, judged: judged() }, { tone: 'err', text: 'check failed at #6' }],
  ['2 checks failed at #n', { ...BASE, outcome: { kind: 'check-failed', check: 'send_email called 0 times' }, failed: true, judged: judged({ counts: { passed: 0, failed: 2, inconclusive: 0, notApplicable: 0 } }) }, { tone: 'err', text: '2 checks failed at #6' }],
  ['check failed, where blame found it lost', { ...BASE, outcome: { kind: 'lost', callNo: 9 }, failed: true }, { tone: 'err', text: 'check failed' }],
  ['n checks passed, with those that did not apply', { ...BASE, outcome: { kind: 'passed', checks: 2, notApplicable: 1 } }, { tone: 'ok', text: '2 checks passed, 1 not applicable' }],
  ['inconclusive, a check that could not be decided', { ...BASE, outcome: { kind: 'inconclusive' } }, { tone: 'warn', text: 'inconclusive' }],
  ['not applicable, where no check applied', { ...BASE, judged: judged({ verdict: 'not-applicable', counts: { passed: 0, failed: 0, inconclusive: 0, notApplicable: 2 }, callNo: null, first: null }) }, { tone: 'mu', text: 'not applicable' }],
  ['a capture’s verdict as its import judged it: checks passed', { ...BASE, kind: 'capture', imported: true, judged: judged({ by: 'import', verdict: 'passed', counts: { passed: 1, failed: 0, inconclusive: 0, notApplicable: 0 }, callNo: null, first: null }) }, { tone: 'ok', text: '1 check passed' }],
  ['a capture’s verdict as its import judged it: check failed at #n', { ...BASE, kind: 'capture', imported: true, failed: true, judged: judged({ by: 'import' }) }, { tone: 'err', text: 'check failed at #6' }],
  ['a capture’s verdict as its import judged it: not applicable', { ...BASE, kind: 'capture', imported: true, judged: judged({ by: 'import', verdict: 'not-applicable', counts: { passed: 0, failed: 0, inconclusive: 0, notApplicable: 1 }, callNo: null, first: null }) }, { tone: 'mu', text: 'not applicable' }],
  ['fixed by <run>, a failed test replay its golden’s next replay passed', { ...TEST, status: 'failed', divergence: { callNo: 3, type: 'request_changed' }, outcome: { kind: 'diverged', callNo: 3 }, failed: false, fixedBy: '01K8RG7A3M0000000000000000' }, { tone: 'mu', text: 'fixed by 01K8RG7A3M' }],
  ['by today’s checks, after the verdict', { ...BASE, judged: judged({ by: 'family', today: true }) }, { tone: 'err', text: 'check failed at #6', today: true }],
  ['forked · 2 writes blocked, a fork no check judges', { ...FORK, origins: 'rrrrlbb' }, { tone: 'fk', text: 'forked · 2 writes blocked' }],
  ['forked · 2 writes stubbed', { ...FORK, origins: 'rrrrlss' }, { tone: 'fk', text: 'forked · 2 writes stubbed' }],
  ['forked · 3 writes fenced', { ...FORK, origins: 'rrrrbsb' }, { tone: 'fk', text: 'forked · 3 writes fenced' }],
  ['forked · no writes fenced', { ...FORK, origins: 'rrrrll' }, { tone: 'fk', text: 'forked · no writes fenced' }],
  ['a dash, where no check judges it, a clean replay too', { ...BASE, mode: 'replay', parentRunId: BASE.runId, kind: 'clean', outcome: { kind: 'clean' } }, { tone: 'n', text: '—' }],
  ['interrupted, stopped before it ended with nothing else failing', { ...BASE, status: 'crashed' }, { tone: 'n', text: 'interrupted' }],
];

describe('Status, by the design’s table of status words', () => {
  it.each(ROWS)('%s', (_name, run, words) => {
    const out = outcomeOf(run);
    expect({ tone: out.tone, text: out.text, ...(out.today ? { today: true } : {}) }).toEqual(words);
    // The filter's status: reads the same verdict of the same run.
    expect(verdictOf(run)).toBe(verdictOfWords(out));
  });
});

describe('a failed test replay its golden passed since', () => {
  const fixed: RunLike = { ...TEST, status: 'failed', divergence: { callNo: 3, type: 'request_changed' }, outcome: { kind: 'diverged', callNo: 3 }, failed: false, fixedBy: '01K8RG7A3M0000000000000000' };

  it('names the run that passed on hover, needs no look, and draws the test’s icon', () => {
    expect(outcomeTip(fixed, outcomeOf(fixed))).toEqual({ title: 'Passes since', sub: '01K8RG7A3M replays it and passes.', rows: [], said: '01K8RG7A3M replays it and passes.' });
    expect(sideStatus(fixed)).toBeNull();
    expect(isFailed(fixed)).toBe(false);
    expect(runGlyph(fixed)).toEqual({ kind: 'test', label: 'Test replay' });
  });

  it('says so on its page’s first fact too, muted', () => {
    expect(outcomeFact(fixed, { tools: 0 })).toMatchObject({ tone: 'mu', words: 'fixed by 01K8RG7A3M', callNo: null });
  });

  let r: Rendered | null = null;
  afterEach(async () => {
    await r?.unmount();
    r = null;
  });

  it('reads muted in the table, the card on hover', async () => {
    const row = { ...fixed, about: { text: 'refund flow', from: 'user' } } as unknown as RunListItem;
    r = await render(createElement(RunsTable, { rows: [row], picked: new Set<string>(), selectable: false, byColumn: false, sort: 'when', onSort: () => undefined, onPick: () => undefined, onPickAll: () => undefined, now: 60_000 }));
    const st = r.all('table.runst tbody tr .st')[0];
    expect(st?.className).toBe('st mu');
    expect(st?.textContent).toBe('fixed by 01K8RG7A3M');
    expect(st?.getAttribute('data-tip')).toContain('Passes since');
  });
});
