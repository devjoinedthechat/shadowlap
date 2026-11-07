import { createElement } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { emptyCounts, NO_TOKENS, Store, type DecisionChange, type DecisionRun, type DecisionStep } from '@shadowlap/engine';
import { DONE, LOOKUP, POLICY, REFUND, recordRun } from '../../engine/test/training-fixtures.js';
import { previewSession, type PreviewSession } from '../src/decision-view.js';
import type { Client } from '../ui/api.js';
import { PreviewTab } from '../ui/changes/Preview.js';
import { cellLook, cellWeight, drawnCells, nextStep, pricePair, receiptWords, sessionHint, verdictState, verifyLabel } from '../ui/decisions.js';
import { minuteStamp } from '../ui/format.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { DecisionCell, DecisionSessionView } from '../ui/types.js';
import { render, type Rendered } from './ui-render.js';

/**
 * Changes › Preview: how a cell is drawn and the call a range stands for, the verdict's state, the
 * one next step, the picker's hint and the receipt's words; then the page on a preview the server
 * words, its picker, verdict, key, matrix, receipt and command, a preview it doesn't hold, and a
 * project with none.
 */

const AT = Date.parse('2026-10-01T10:12:00Z');
const write: DecisionChange = { rank: 1, kind: 'write-removed', tool: 'issue_refund', effect: 'write', before: { amount: 240 }, after: null, detail: 'issue_refund is no longer called' };
const step = (callNo: number, rank: DecisionStep['rank'], o: Partial<DecisionStep> = {}): DecisionStep => ({
  callNo,
  step: callNo,
  scope: null,
  rank,
  majority: rank,
  changes: rank === 1 ? [write] : [],
  recorded: { stop: 'tools', stopReason: 'tool_use', tools: [], text: '' },
  now: { stop: 'tools', stopReason: 'tool_use', tools: [], text: '' },
  samples: { asked: 2, answered: 2, changed: rank === null ? 0 : 2, ranks: [rank ?? 0, rank ?? 0] },
  model: { recorded: 'claude-sonnet-4-5-20250929', asked: 'claude-haiku-4-5' },
  tokens: { before: null, after: null },
  cost: { before: null, after: null, spent: 0 },
  thinkingStripped: 0,
  error: null,
  ...o,
});
const runOf = (runId: string, golden: string | null, decisions: DecisionStep[]): DecisionRun => {
  const ranks = decisions.map((d) => d.rank).filter((r): r is NonNullable<typeof r> => r !== null);
  return { runId, golden, steps: decisions.length, asked: decisions.length, rank: ranks.length ? (Math.min(...ranks) as DecisionRun['rank']) : null, majority: null, counts: emptyCounts(), cost: { before: 0.04, after: 0.02, spent: 0.02 }, tokens: { before: NO_TOKENS, after: NO_TOKENS }, thinkingStripped: 0, refused: null, decisions, warnings: [] };
};
const cell = (o: Partial<DecisionCell>): DecisionCell => ({ callNo: 1, step: 1, rank: 0, majority: 0, changed: 0, answered: 2, judge: null, state: 'same', sampled: null, ranks: [0, 0], control: null, detail: null, words: 'the same', ...o });

describe('a cell, a range and the next step, worked out', () => {
  it('draws a cell in its colour, split a band a sample with the most consequential first, hollow, dashed or ringed', () => {
    expect(cellLook(cell({ state: 'ranked', rank: 1, ranks: [1, 1] }))).toEqual({ fill: 'w', bands: null, ring: false, hollow: false, dashed: false });
    expect(cellLook(cell({ state: 'ranked', rank: 1, ranks: [0, 1, 3] })).bands).toEqual(['w', 'r', 'm']);
    expect(cellLook(cell({ state: 'noise', rank: null, sampled: 2, ranks: [2, 0] }))).toMatchObject({ fill: 's', bands: ['s', 'm'] });
    expect(cellLook(cell({ state: 'left', rank: null, ranks: [] }))).toMatchObject({ hollow: true, dashed: false, bands: null });
    expect(cellLook(cell({ state: 'not-asked', rank: null, ranks: [] }))).toMatchObject({ dashed: true });
    expect(cellLook(cell({ state: 'unsettled', rank: null, ranks: [1, 0] }))).toMatchObject({ dashed: true, bands: null });
    expect(cellLook(cell({ state: 'ranked', rank: 5, judge: 'inconclusive' })).ring).toBe(true);
  });

  it('draws a row past 60 calls as ranges, each as its most consequential call', () => {
    const cells = Array.from({ length: 130 }, (_, i) => cell({ callNo: i + 1, step: i + 1 }));
    cells[5] = cell({ callNo: 6, step: 6, state: 'ranked', rank: 2 });
    cells[4] = cell({ callNo: 5, step: 5, state: 'left', rank: null });
    const drawn = drawnCells(cells);
    expect(drawn).toHaveLength(44);
    expect(drawn.map((c) => c.count).slice(0, 2)).toEqual([3, 3]);
    expect([drawn[1].first.callNo, drawn[1].last.callNo, drawn[1].top.callNo]).toEqual([4, 6, 6]);
    expect(drawnCells(cells.slice(0, 60))).toHaveLength(60);
    expect([cellWeight(cell({ state: 'left', rank: null })), cellWeight(cell({ state: 'not-asked', rank: null })), cellWeight(cell({})), cellWeight(cell({ state: 'noise', rank: null })), cellWeight(cell({ state: 'ranked', rank: 5 })), cellWeight(cell({ state: 'ranked', rank: 1 }))]).toEqual([0, 1, 2, 2.5, 3, 8]);
  });

  it('picks one next step: Verify the runs left, else Run more attempts, else Migrate, else none', () => {
    expect(nextStep({ verify: { runs: ['a', 'b'], every: true, gone: 0 }, more: [], migrate: null })).toEqual({ kind: 'verify', label: 'Verify 2 runs', runs: ['a', 'b'], every: true, gone: 0 });
    expect(nextStep({ verify: null, more: ['b'], migrate: { to: 'claude-haiku-4-5', from: [], goldens: [], runs: ['b'] } })).toEqual({ kind: 'more', label: 'Run more attempts', runs: ['b'] });
    expect(nextStep({ verify: null, more: [], migrate: { to: 'claude-haiku-4-5', from: ['claude-sonnet-4-5'], goldens: ['goldens/refund'], runs: [] } })).toMatchObject({ kind: 'migrate', label: 'Migrate to claude-haiku-4-5' });
    expect(nextStep({ verify: null, more: [], migrate: null })).toBeNull();
    expect([verifyLabel(1), verifyLabel(3)]).toEqual(['Verify 1 run', 'Verify 3 runs']);
  });

  it('says the picker’s hint, two prices that would read alike a place finer, and the receipt', () => {
    const s = { runs: 7, unit: 'golden' as const, samples: 3, at: AT };
    expect(sessionHint(s, { now: AT + 60_000 })).toBe(`7 goldens · ${minuteStamp(AT, AT + 60_000)}`);
    expect(sessionHint({ ...s, runs: 1, unit: 'run' }, { full: true, now: AT })).toBe(`1 run · 3 samples a step · ${minuteStamp(AT, AT)}`);
    expect([pricePair(0.028, 0.014), pricePair(0.0181, 0.0184), pricePair(0.02, 0.02)]).toEqual(['≈$0.028 → ≈$0.014', '≈$0.0181 → ≈$0.0184', '≈$0.020 → ≈$0.020']);
    const words = receiptWords({ perRun: { before: 0.028, after: 0.014, change: '−50%' }, spent: 0.8, requests: 336, unknownModels: [], judge: { requests: 2, spent: 0.069, unknownModels: [] }, stopReason: null }, '4,000 → 5,000 input tokens (+25%)');
    expect(words.map((w) => w.parts)).toEqual([['per run ≈$0.028 → ≈$0.014 (−50%)', 'this preview spent ≈$0.869'], ['336 requests to the model, 2 to the judge'], ['end to end 4,000 → 5,000 input tokens (+25%)']]);
    expect(words[0].card!.rows).toEqual([['asking', '≈$0.800 · 336 upstream requests'], ['judging', '≈$0.069 · 2 upstream requests']]);
    expect(receiptWords({ perRun: null, spent: 0.01, requests: 1, unknownModels: ['m-x'], judge: null, stopReason: 'the spend limit was reached' }, null).map((w) => w.parts)).toEqual([['this preview spent ≈$0.010 (no price for m-x)', 'stopped: the spend limit was reached'], ['1 request to the model']]);
  });
});

describe('the Preview page', () => {
  let store: Store;
  let a = '';
  let b = '';
  let flagged: PreviewSession;
  let page: Rendered | null = null;
  const ID = 'dc-01M5000000000000000000000A';

  beforeAll(() => {
    store = Store.open(':memory:');
    // The DOM pass reads the engine as built and its fixtures as sources: the one store, either way.
    const kept = store as unknown as Parameters<typeof recordRun>[0];
    a = recordRun(kept, [LOOKUP, POLICY, REFUND, DONE], { model: 'claude-sonnet-4-5-20250929' }).run.runId;
    b = recordRun(kept, [LOOKUP, POLICY, DONE], { model: 'claude-sonnet-4-5-20250929' }).run.runId;
    const runs = [runOf(a, 'goldens/refund', [step(1, null), step(3, 1)]), runOf(b, null, [step(1, null), step(3, null)])];
    const report = { decisionsId: ID, kind: 'decisions', at: AT, change: { model: 'claude-haiku-4-5', fields: {}, from: ['claude-sonnet-4-5-20250929'], fromCode: null, text: 'the model claude-haiku-4-5' }, command: 'shadowlap decisions goldens/* --model claude-haiku-4-5', samples: 2, counts: { ...emptyCounts(), 1: 1, same: 3 }, flagged: [a], toVerify: [a], remedies: [], notes: [], warnings: ['1 step got no answer: rate limited'], verify: null, stopReason: null, cost: { before: 0.028, after: 0.014, spent: 0.004, upstreamRequests: 6, unknownModels: [] } };
    store.putDecisionSession({ sessionId: ID, kind: 'decisions', at: AT, change: report.change.text, actor: null, revision: null, data: report, runs: runs.map((r) => ({ runId: r.runId, golden: r.golden, rank: r.rank, changed: 1, data: r as unknown as Record<string, unknown> })) });
    flagged = previewSession(store, ID)!;
  });
  afterAll(() => store.close());
  afterEach(async () => {
    await page?.unmount();
    page = null;
  });

  const listed = (): DecisionSessionView => ({ sessionId: ID, kind: 'decisions', at: AT, change: 'the model claude-haiku-4-5', name: 'Model switch to claude-haiku-4-5', runs: 2, goldens: 1, unit: 'run', samples: 2, flagged: 1, actor: null, revision: null, href: `#/changes/decisions/${ID}` });
  const app = (client: Partial<Client>): AppState =>
    ({ client: { jobs: () => Promise.resolve([]), estimates: { decisionEstimates: () => Promise.resolve({ verify: null }) }, ...client } as unknown as Client, exported: false, meta: null, tick: 0, runsTick: 0, feeds: {}, jobs: [], live: [], runs: [], actionsOff: null, hasKind: () => true, guard: (fn: () => void) => fn(), watchJob: () => undefined, toast: () => undefined }) as unknown as AppState;
  const open = async (client: Partial<Client>, id: string | null = null) => {
    page = await render(createElement(AppContext.Provider, { value: app(client) }, createElement(PreviewTab, { id, run: null, call: null })));
    return page;
  };
  const shown = (el: { textContent: string } | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

  it('opens the newest preview: its picker, its verdict in its colour, the key, a row per run, the receipt and the command', async () => {
    const asked: string[] = [];
    const p = await open({ decisionSessions: () => Promise.resolve({ sessions: [listed()], goldens: 1, retirements: { version: '', notices: [] } }), decisionSession: (id: string) => (asked.push(id), Promise.resolve(flagged)) });
    await p.until('the matrix', () => p.all('.dmr').length === 2);
    expect(asked).toEqual([ID]);
    expect(shown(p.one('.rpick.dpick .pid'))).toBe('Model switch to claude-haiku-4-5');
    expect(p.one('.rpick.dpick').getAttribute('aria-label')).toMatch(/^Preview: Model switch to claude-haiku-4-5, 2 runs · /);
    // Before verify, the runs it flags lead in their colour: red, as a write flags one.
    expect([shown(p.one('.dverdict .vw')), p.one('.dverdict .vw').className]).toEqual(['1 of 2 runs', 'vw err']);
    expect(shown(p.one('.dverdict h2'))).toBe('1 of 2 runs decides a write or when to stop differently');
    expect(shown(p.one('.dverdict p'))).toContain('4 steps asked, 2 samples each · no tool ran · later steps judged');
    expect(shown(p.one('.dverdict .actions button'))).toBe('Verify 1 run');
    expect(p.all('.mxk').map(shown)).toEqual(['1 write changed', '3 the same']);
    expect(p.all('.dmr').map((r) => shown(r.querySelector('.dmid code')))).toEqual([a, b]);
    expect(p.all('.dmr .dmid .chip').map(shown)).toEqual(['refund']);
    expect(p.all('.dmr .dmid a').map((x) => x.getAttribute('href'))).toEqual([`#/run/${a}/3/decisions`, `#/run/${b}/1/decisions`]);
    expect(p.all('.dmr')[0].querySelectorAll('button.dc').map((c) => [c.className, c.getAttribute('tabindex'), c.getAttribute('aria-label')])).toEqual([
      ['dc', '-1', '#1 · step 1: the same in every sample: calls tools'],
      ['dc w', '0', '#3 · step 3: issue_refund is no longer called · in 2 of 2 samples'],
    ]);
    expect(p.all('.dmr .dsl').map(shown)).toEqual(['#3 issue_refund is no longer called · in 2 of 2', 'the same decisions']);
    expect(p.all('.dnotes li').map(shown)).toEqual(['1 step got no answer: rate limited']);
    expect(p.all('.mxfoot .mxr').map(shown)).toEqual(['per run ≈$0.028 → ≈$0.014 (−50%) · this preview spent ≈$0.0040', '6 requests to the model']);
    expect(shown(p.one('.cmdline'))).toContain('shadowlap decisions goldens/* --model claude-haiku-4-5');
  });

  it('ends a verified run’s row on its outcome and tally, its bound kept whole, and a run it cleared as not run end to end', async () => {
    const verified: PreviewSession = { ...flagged, matrix: [{ ...flagged.matrix[0], verified: { outcome: 'kept', tally: ' · 4 of 4 · rate >= 0.6 (95%)' } }, { ...flagged.matrix[1], cleared: true }] };
    const p = await open({ decisionSessions: () => Promise.resolve({ sessions: [listed()], goldens: 1, retirements: { version: '', notices: [] } }), decisionSession: () => Promise.resolve(verified) });
    await p.until('the matrix', () => p.all('.dmr').length === 2);
    // The outcome is a defined term, its card's words beside it: its tally follows, the bound glued to its figures.
    const [kept, cleared] = p.all('.dsv');
    expect([kept.className, kept.querySelector('b')!.textContent.startsWith('kept'), kept.textContent.endsWith(' · 4 of 4 · rate >=\u00a00.6\u00a0(95%)')]).toEqual(['dsv ok', true, true]);
    expect([cleared.className, cleared.textContent]).toEqual(['dsv', 'not run end to end']);
  });

  it('says a preview it doesn’t hold, with the way back to the newest', async () => {
    const { ApiError } = await import('../ui/api.js');
    const p = await open({ decisionSessions: () => Promise.resolve({ sessions: [listed()], goldens: 1, retirements: { version: '', notices: [] } }), decisionSession: () => Promise.reject(new ApiError(404, 'no session')) }, 'dc-01M5NOTKEPT0000000000000');
    await p.until('the line', () => p.all('.empty.tall').length === 1);
    expect(shown(p.one('.empty.tall'))).toBe('No preview dc-01M5NOTKEPT0000000000000. Open Preview');
    expect(p.one('.empty.tall a').getAttribute('href')).toBe('#/changes/decisions');
  });

  it('says what a preview is with none kept, and with no goldens what to pack first', async () => {
    const none = (goldens: number) => ({ decisionSessions: () => Promise.resolve({ sessions: [], goldens, retirements: { version: '', notices: [] } }) });
    let p = await open(none(0));
    await p.until('the empty state', () => p.all('.stepempty').length === 1);
    expect(shown(p.one('.stepempty h2, .stepempty h3'))).toBe('Preview a change on your goldens');
    expect(shown(p.one('.stepempty .emptyline'))).toBe('No goldens yet: pack a run as a golden, or preview a change on one run from its Decisions view. Open Runs');
    await p.unmount();
    p = await open(none(3));
    page = p;
    await p.until('the empty state', () => p.all('.stepempty').length === 1);
    expect(shown(p.one('.stepempty'))).toContain('shadowlap decisions goldens/* --model <model>');
    expect(verdictState(flagged.view)).toBe('flagged');
  });
});
