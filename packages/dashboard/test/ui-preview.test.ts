import { act, createElement, useState } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { emptyCounts, NO_TOKENS, Store, type DecisionChange, type DecisionRun, type DecisionStep } from '@shadowlap/engine';
import { DONE, LOOKUP, POLICY, REFUND, recordRun } from '../../engine/test/training-fixtures.js';
import { previewSession, type PreviewSession } from '../src/decision-view.js';
import { runDecisions } from '../src/decisions.js';
import { viewSteps } from '../src/decision-cells.js';
import type { Client } from '../ui/api.js';
import { PreviewTab } from '../ui/changes/Preview.js';
import { argParts, cellCost, cellLead, cellLook, cellWeight, chipWhen, drawnCells, nextStep, noneLine, outcomeTone, pricePair, receiptWords, sessionHint, toolMarks, verdictState, verifyLabel } from '../ui/decisions.js';
import { forgetConversationPrefs } from '../ui/components/Conversation.js';
import { estimatesApi } from '../ui/estimates-api.js';
import { DecisionsView, forgetDecisionsPick } from '../ui/run/DecisionsView.js';
import { minuteStamp } from '../ui/format.js';
import { pageUp } from '../ui/focus-manager.js';
import { useRoute } from '../ui/router.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { DecisionCell, DecisionSessionView, RunDecisionsView } from '../ui/types.js';
import { FakeElement, render, type Rendered } from './ui-render.js';
import { withMigrateDialogs } from './ui-served-now.js';

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
  return { runId, golden, steps: decisions.length, asked: decisions.length, rank: ranks.length ? (Math.min(...ranks) as DecisionRun['rank']) : null, majority: ranks.length ? (Math.min(...ranks) as DecisionRun['majority']) : null, counts: emptyCounts(), cost: { before: 0.04, after: 0.02, spent: 0.02 }, tokens: { before: NO_TOKENS, after: NO_TOKENS }, thinkingStripped: 0, refused: null, decisions, warnings: [] };
};
const cell = (o: Partial<DecisionCell>): DecisionCell => ({ callNo: 1, step: 1, rank: 0, majority: 0, changed: 0, answered: 2, judge: null, state: 'same', sampled: null, ranks: [0, 0], control: null, detail: null, words: 'the same', open: null, ...o });

describe('a cell, a range and the next step, worked out', () => {
  it('draws a cell in its colour, split a band a sample with the most consequential first, hollow, dashed or ringed', () => {
    expect(cellLook(cell({ state: 'ranked', rank: 1, ranks: [1, 1] }))).toEqual({ fill: 'w', bands: null, ring: false, hollow: false, dashed: false });
    expect(cellLook(cell({ state: 'ranked', rank: 1, ranks: [0, 1, 3] })).bands).toEqual(['w', 'r', 'm']);
    expect(cellLook(cell({ state: 'noise', rank: null, sampled: 2, ranks: [2, 0] }))).toMatchObject({ fill: 's', bands: ['s', 'm'] });
    expect(cellLook(cell({ state: 'left', rank: null, ranks: [] }))).toMatchObject({ hollow: true, dashed: false, bands: null });
    expect(cellLook(cell({ state: 'not-asked', rank: null, ranks: [] }))).toMatchObject({ dashed: true });
    expect(cellLook(cell({ state: 'unsettled', rank: null, ranks: [1, 0] }))).toMatchObject({ dashed: true, bands: null });
    expect(cellLook(cell({ state: 'ranked', rank: 5, judge: 'inconclusive' })).ring).toBe(true);
    // Only words a judge couldn't read are ringed: a read change, or a write that most samples don't show, keeps its colour.
    expect(cellLook(cell({ state: 'ranked', rank: 3, ranks: [3, 3], judge: 'inconclusive' }))).toMatchObject({ fill: 'r', ring: false });
    expect(cellLook(cell({ state: 'ranked', rank: 1, majority: 5, ranks: [1, 5, 5], judge: 'inconclusive' }))).toMatchObject({ fill: 'w', bands: ['w', 'm', 'm'], ring: false });
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

  it('picks one next step: Verify the runs left, else Run more attempts or Verify again, else Migrate, else none', () => {
    expect(nextStep({ verify: { runs: ['a', 'b'], every: true, gone: 0 }, more: null, migrate: null })).toEqual({ kind: 'verify', label: 'Verify 2 runs', runs: ['a', 'b'], every: true, gone: 0 });
    expect(nextStep({ verify: null, more: { kind: 'more', runs: ['b'], max: 160, keptMax: null, flags: ['--gate', '{"max":160}'], attempts: 80, limit: 'up to 160 attempts a run' }, migrate: { to: 'claude-haiku-4-5', from: [], goldens: [], runs: ['b'] } })).toEqual({ kind: 'more', label: 'Run more attempts', runs: ['b'], max: 160, keptMax: null, flags: ['--gate', '{"max":160}'], attempts: 80, limit: 'up to 160 attempts a run' });
    expect(nextStep({ verify: null, more: { kind: 'again', runs: ['b'], max: null, keptMax: null, flags: [], attempts: 4, limit: '' }, migrate: null })).toMatchObject({ kind: 'more', label: 'Verify again', runs: ['b'] });
    expect(nextStep({ verify: null, more: null, migrate: { to: 'claude-haiku-4-5', from: ['claude-sonnet-4-5'], goldens: ['goldens/refund'], runs: [] } })).toMatchObject({ kind: 'migrate', label: 'Migrate to claude-haiku-4-5' });
    expect(nextStep({ verify: null, more: null, migrate: null })).toBeNull();
    expect([verifyLabel(1), verifyLabel(3)]).toEqual(['Verify 1 run', 'Verify 3 runs']);
  });

  it('says the picker’s hint, two prices that would read alike a place finer, and the receipt', () => {
    const s = { runs: 7, unit: 'golden' as const, samples: 3, at: AT };
    expect(sessionHint(s, { now: AT + 60_000 })).toBe(`7 goldens · ${minuteStamp(AT, AT + 60_000)}`);
    expect(sessionHint({ ...s, runs: 1, unit: 'run' }, { full: true, now: AT })).toBe(`1 run · 3 samples a step · ${minuteStamp(AT, AT)}`);
    expect([pricePair(0.028, 0.014), pricePair(0.0181, 0.0184), pricePair(0.02, 0.02)]).toEqual(['≈$0.028 → ≈$0.014', '≈$0.0181 → ≈$0.0184', '≈$0.020 → ≈$0.020']);
    const words = receiptWords({ perRun: { before: 0.028, after: 0.014, change: '−50%' }, tokens: { before: 4000, after: 5000 }, spent: 0.8, requests: 336, unknownModels: [], judge: { requests: 2, spent: 0.069, unknownModels: [] }, stopReason: null }, '4,000 → 5,000 input tokens (+25%)');
    expect(words.map((w) => w.parts)).toEqual([['per run ≈$0.028 → ≈$0.014 (−50%)', 'this preview spent ≈$0.869'], ['336 requests to the model, 2 to the judge'], ['end to end 4,000 → 5,000 input tokens (+25%)']]);
    // Its card leads with a run's tokens either way, then what asking and judging spent.
    expect(words[0].card!.rows).toEqual([['per run', '4,000 → 5,000 input tokens'], ['asking', '≈$0.800 · 336 upstream requests'], ['judging', '≈$0.069 · 2 upstream requests']]);
    const unpriced = receiptWords({ perRun: null, tokens: null, spent: 0.01, requests: 1, unknownModels: ['m-x'], judge: null, stopReason: 'the spend limit was reached' }, null);
    expect(unpriced.map((w) => w.parts)).toEqual([['this preview spent ≈$0.010 (no price for m-x)', 'stopped: the spend limit was reached'], ['1 request to the model']]);
    expect(unpriced[0].card!.rows).toEqual([['asking', '≈$0.010 · 1 upstream request']]);
  });
});

describe('an opened cell, worked out', () => {
  it('marks each tool against the other side: the very call, called otherwise, or only on one side', () => {
    const rec = { tools: [{ name: 'issue_refund', args: { amount: 240 }, effect: 'write' as const }, { name: 'lookup_policy', args: { b: 1, a: 2 }, effect: 'read' as const }, { name: 'note', args: { x: 1 }, effect: 'read' as const }] };
    const now = { tools: [{ name: 'lookup_policy', args: { a: 2, b: 1 }, effect: 'read' as const }, { name: 'note', args: { x: 2 }, effect: 'read' as const }, { name: 'send_email', args: {}, effect: 'unknown' as const }] };
    expect([toolMarks(rec, now, 'recorded'), toolMarks(now, rec, 'now')]).toEqual([
      ['gone', 'same', 'diff'],
      ['same', 'diff', 'new'],
    ]);
  });

  it('cuts arguments after a comma or brace, never inside a short quoted value, and keeps short arguments whole', () => {
    expect(argParts('{"id":"r-1"}')).toEqual([{ text: '{"id":"r-1"}', whole: true }]);
    expect(argParts('{"order":"ord_8812","note":"a refund is due, please"}')).toEqual([
      { text: '{', whole: false },
      { text: '"order"', whole: true },
      { text: ':', whole: false },
      { text: '"ord_8812"', whole: true },
      { text: ',', whole: false },
      { text: '"note"', whole: true },
      { text: ':', whole: false },
      { text: '"a refund is due, please"', whole: false },
      { text: '}', whole: false },
    ]);
  });

  it('leads with its rank and change, quieter how often, or a sentence where nothing was compared; its cost names the masking', () => {
    expect(cellLead(cell({ state: 'ranked', rank: 1, detail: 'issue_refund is no longer called', words: 'issue_refund is no longer called · in 3 of 3 samples, 0 of 3 as recorded' }))).toEqual({ rank: 1, text: 'issue_refund is no longer called', quiet: '· in 3 of 3 samples, 0 of 3 as recorded' });
    expect(cellLead(cell({ state: 'noise', rank: 0, detail: 'a write changed', words: "a write changed · within the model's own variation: in 1 of 3 samples, 1 of 3 as recorded" }))).toEqual({ rank: null, text: 'a write changed', quiet: "· within the model's own variation: in 1 of 3 samples, 1 of 3 as recorded" });
    expect([cellLead(cell({ answered: 3 })), cellLead(cell({ state: 'not-asked', words: 'not asked: HTTP 529' })), cellLead(cell({ state: 'left', words: 'left as recorded: made with gpt-4o' }))]).toEqual([{ sentence: 'The same decision in all 3 samples.' }, { sentence: 'Not asked: HTTP 529.' }, { sentence: 'Left as recorded: made with gpt-4o.' }]);
    expect([cellCost('+120 tokens · +$0.0020', { redacted: false, clock: 'auto' }), cellCost('', { redacted: true, clock: 'auto' })]).toEqual(['+120 tokens · +$0.0020 · compared after the project’s normalizers, dates near the run’s start masked', 'compared after the project’s normalizers, dates near the run’s start masked · values masked by its redaction rules']);
    // An exact clock masks no date, as decisions doesn't; a config that couldn't be read says nothing of its clock.
    expect([cellCost('', { redacted: false, clock: 'exact' }), cellCost('', { redacted: false, clock: null })]).toEqual(['compared after the project’s normalizers', 'compared after the project’s normalizers']);
  });

  it('says why a run’s Decisions view lists no step, when a session asked it on its chip, and an outcome’s colour', () => {
    const run = (o: Partial<DecisionRun>) => ({ refused: null, asked: 0, decisions: [], ...o }) as DecisionRun;
    expect([
      noneLine(run({ refused: 'it was recorded on another model\nmore' })),
      noneLine(run({ asked: 4 })),
      noneLine(run({ decisions: [step(1, null, { error: 'HTTP 529' })] })),
      noneLine(run({})),
    ]).toEqual(['Not asked: it was recorded on another model.', 'The same decision at every step asked.', 'Nothing asked: HTTP 529.', 'The change leaves this run’s requests as recorded.']);
    const now = new Date(2026, 9, 1, 18, 0).getTime();
    expect([chipWhen(new Date(2026, 9, 1, 10, 12).getTime(), now), chipWhen(new Date(2026, 8, 30, 10, 12).getTime(), now)]).toEqual(['10:12', 'Sep 30, 10:12']);
    expect(['kept', 'fixed', 'broken', 'not fixed', 'inconclusive'].map(outcomeTone)).toEqual(['ok', 'ok', 'no', 'no', 'y']);
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
    ({ client: { jobs: () => Promise.resolve([]), estimates: { decisionEstimates: () => Promise.resolve({ verify: null }), previewEstimates: () => Promise.resolve({ ways: null }) }, ...client } as unknown as Client, exported: false, meta: null, tick: 0, runsTick: 0, feeds: {}, jobs: [], live: [], runs: [], actionsOff: null, hasKind: () => true, guard: (fn: () => void) => fn(), watchJob: () => undefined, toast: () => undefined }) as unknown as AppState;
  const open = async (client: Partial<Client>, id: string | null = null) => {
    page = await render(createElement(AppContext.Provider, { value: app(client) }, withMigrateDialogs(createElement(PreviewTab, { id, run: null, call: null }))));
    return page;
  };
  const shown = (el: { textContent: string } | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

  it('opens the newest preview: its picker, its verdict in its colour, the key, a row per run, the receipt and the command', async () => {
    const asked: string[] = [];
    const p = await open({ decisionSessions: () => Promise.resolve({ sessions: [listed()], goldens: 1, more: false }), decisionSession: (id: string) => (asked.push(id), Promise.resolve(flagged)) });
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
    // The flagged run ends on what flags it, in its colour; the other decided as recorded.
    expect(p.all('.dmr .dsl').map((l) => [shown(l), l.querySelector('span')!.className])).toEqual([
      ['#3 issue_refund is no longer called', 'dsd q1'],
      ['the same decisions', 'dsm'],
    ]);
    expect(p.all('.dnotes li').map(shown)).toEqual(['1 step got no answer: rate limited']);
    expect(p.all('.mxfoot .mxr').map(shown)).toEqual(['per run ≈$0.028 → ≈$0.014 (−50%) · this preview spent ≈$0.0040', '6 requests to the model']);
    expect(shown(p.one('.cmdline'))).toContain('shadowlap decisions goldens/* --model claude-haiku-4-5');
  });

  it('says under the picker’s list where it stops, where older previews are kept than it lists', async () => {
    Object.assign(globalThis, { innerWidth: 1440, innerHeight: 900 });
    for (const more of [true, false]) {
      const p = await open({ decisionSessions: () => Promise.resolve({ sessions: [listed()], goldens: 1, more }), decisionSession: () => Promise.resolve(flagged) });
      await p.until('the picker', () => p.all('.rpick.dpick').length === 1);
      await p.click(p.one('.rpick.dpick'));
      await p.until('the list', () => p.all('.pop.picker').length === 1);
      expect(p.all('.pop.picker .pfoot').map(shown)).toEqual(more ? ['The newest 1 previews; older ones open from their runs’ Decisions views'] : []);
      await p.unmount();
      page = null;
    }
  });

  it('ends a verified run’s row on its outcome and tally, its bound kept whole, and a run it cleared as not run end to end', async () => {
    const verified: PreviewSession = { ...flagged, matrix: [{ ...flagged.matrix[0], verified: { outcome: 'kept', tally: ' · 4 of 4 · rate >= 0.6 (95%)', count: '4 of 4' } }, { ...flagged.matrix[1], cleared: true }] };
    const p = await open({ decisionSessions: () => Promise.resolve({ sessions: [listed()], goldens: 1, more: false }), decisionSession: () => Promise.resolve(verified) });
    await p.until('the matrix', () => p.all('.dmr').length === 2);
    // The outcome is a defined term, its card's words beside it: its tally follows, the bound glued to its figures.
    const [kept, cleared] = p.all('.dsv');
    expect([kept.className, kept.querySelector('b')!.textContent.startsWith('kept'), kept.textContent.endsWith(' · 4 of 4 · rate >=\u00a00.6\u00a0(95%)')]).toEqual(['dsv ok', true, true]);
    expect([cleared.className, cleared.textContent]).toEqual(['dsv', 'not run end to end']);
  });

  it('has Verify wait, plain and saying why, where a run the preview left to verify is gone from the store', async () => {
    const next = flagged.view.next;
    const gone: PreviewSession = { ...flagged, view: { ...flagged.view, next: { ...next, verify: { ...next.verify!, gone: 1 } } } };
    const p = await open({ decisionSessions: () => Promise.resolve({ sessions: [listed()], goldens: 1, more: false }), decisionSession: () => Promise.resolve(gone) });
    await p.until('the verdict', () => !!p.one('.dverdict .actions button'));
    const verify = p.one('.dverdict .actions button');
    expect([shown(verify), verify.className, verify.getAttribute('aria-disabled'), verify.getAttribute('data-why')]).toEqual(['Verify 1 run', 'btn', 'true', 'A run this preview left to verify is no longer in the store']);
  });

  it('opens a cell under the matrix: its head, its lead, both decisions marked, its cost and the conversation, folded', async () => {
    forgetConversationPrefs();
    const tools = (...t: Array<[string, unknown, 'write' | 'read' | 'unknown']>) => t.map(([name, args, effect]) => ({ name, args, effect }));
    const runs = (flagged.runs as DecisionRun[]).map((r) => (r.runId !== a ? r : { ...r, decisions: r.decisions.map((s) => (s.callNo !== 3 ? s : { ...s, recorded: { ...s.recorded, tools: tools(['issue_refund', { amount: 240 }, 'write'], ['lookup_policy', { id: 'p1' }, 'read']) }, now: { ...s.now!, text: 'Checking.', tools: tools(['lookup_policy', { id: 'p1' }, 'read'], ['send_note', {}, 'unknown']) } })) }));
    const turns = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', blocks: [{ type: 'text', text: `message ${i + 1}` }] }));
    const detail = { call: { callNo: 3, kind: 'api', outcome: 'ok' }, conversation: { turns, fromCallNo: 3, n: null } };
    const p = await render(createElement(AppContext.Provider, { value: app({ decisionSessions: () => Promise.resolve({ sessions: [listed()], goldens: 1, more: false }), decisionSession: () => Promise.resolve({ ...flagged, runs }), call: () => Promise.resolve(detail) } as unknown as Partial<Client>) }, createElement(PreviewTab, { id: ID, run: a, call: 3 })));
    page = p;
    await p.until('the cell', () => !!p.one('.dcell .dconv .ibar') && p.all('.dcell .msg').length > 0);
    expect(shown(p.one('.dcell .dch h2'))).toBe(`#3 · step 3 of ${a}`);
    expect([p.one('.dcell .dacts a.btn').getAttribute('href'), p.one('.dcell .dacts a.ibtn').getAttribute('href'), p.one('.dcell .dacts a.ibtn').getAttribute('aria-label')]).toEqual([`#/run/${a}/3/decisions`, `#/changes/decisions/${ID}`, 'Close']);
    expect(shown(p.one('.dcell .dlead'))).toBe('rank 1 issue_refund is no longer called · in 2 of 2 samples');
    expect(p.all('.dcell .dside .k').map(shown)).toEqual(['recorded · claude-sonnet-4-5-20250929', 'claude-haiku-4-5 · its most consequential sample']);
    expect(p.all('.dcell .dside')[1].className).toBe('dside q1');
    expect(p.all('.dcell .dtool').map((t) => [t.className, shown(t.querySelector('.ar')), shown(t.querySelector('.eff'))])).toEqual([
      ['dtool gone w', '−', 'write'],
      ['dtool', '→', 'read'],
      ['dtool', '→', 'read'],
      ['dtool new w', '+', 'write'],
    ]);
    expect([shown(p.one('.dcell .dsay')), p.all('.dcell .dstop').map(shown)]).toEqual(['“Checking.”', ['calls tools', 'calls tools']]);
    expect(shown(p.one('.dcell .dspend'))).toBe('compared after the project’s normalizers, dates near the run’s start masked');
    // The conversation as the inspector draws it: the first two and the last six, the two between folded.
    expect(shown(p.all('.dconv .ibar > span')[0])).toBe('10 messages · what the model saw at #3');
    expect([p.all('.dconv .msg').length, shown(p.one('.dconv .expand'))]).toEqual([8, 'Show 2 earlier messages']);
    await p.click(p.one('.dconv .expand'));
    expect(p.all('.dconv .msg').length).toBe(10);
    expect(p.all('.dmr')[0].querySelectorAll('button.dc')[1].getAttribute('aria-current')).toBe('true');
  });

  it('opens a cell in place of the address and closes it pressed again, by its × or Esc, so Back leaves Preview rather than walking the cells', async () => {
    const at = `#/changes/decisions/${ID}`;
    const bar = { hash: at, search: '', pathname: '/', host: '' };
    const replaced: string[] = [];
    vi.stubGlobal('location', bar);
    vi.stubGlobal('history', { state: null, replaceState: (_s: unknown, _t: string, url: string) => void replaced.push((bar.hash = url.slice(url.indexOf('#')))) });
    const revealed = vi.spyOn(FakeElement.prototype, 'scrollIntoView');
    try {
      const detail = { call: { callNo: 3, kind: 'api', outcome: 'ok' }, conversation: { turns: [], fromCallNo: 3, n: null } };
      const Routed = () => {
        const r = useRoute();
        return r.page === 'changes' ? createElement(PreviewTab, { id: r.id, run: r.run ?? null, call: r.call ?? null }) : null;
      };
      const p = await render(createElement(AppContext.Provider, { value: app({ decisionSessions: () => Promise.resolve({ sessions: [listed()], goldens: 1, more: false }), decisionSession: () => Promise.resolve(flagged), call: () => Promise.resolve(detail) } as unknown as Partial<Client>) }, createElement(Routed)));
      page = p;
      await p.until('the matrix', () => p.all('.dmr').length === 2);
      const cell = () => p.all('.dmr')[0].querySelectorAll('button.dc')[1];
      const opened = () => p.all('.dcell').length === 1;
      // A press opens the cell under the matrix, in place of the address, the panel brought into view and the focus kept on the cell.
      await p.click(cell());
      await p.until('the cell', opened);
      expect([replaced, revealed.mock.calls]).toEqual([[`${at}/${a}/3`], [[{ block: 'nearest' }]]]);
      expect([cell().getAttribute('aria-current'), p.focused()]).toEqual(['true', cell()]);
      // Pressed again, it closes, in place too.
      await p.click(cell());
      await p.until('the cell closed', () => !opened());
      expect(replaced).toEqual([`${at}/${a}/3`, at]);
      // Its × closes it as its link would, in place, the focus back on its cell.
      await p.click(cell());
      await p.until('the cell', opened);
      await p.click(p.one('.dcell .dacts a.ibtn'));
      await p.until('the cell closed', () => !opened());
      expect([replaced.at(-1), p.focused()]).toEqual([at, cell()]);
      // Esc, which the shell asks of the page first: in place, and the cell keeps the focus.
      await p.click(cell());
      await p.until('the cell', opened);
      await p.focus(p.one('.dcell .dacts a.btn'));
      let closed: boolean | undefined;
      await act(async () => void (closed = pageUp.current?.()));
      expect(closed).toBe(true);
      await p.until('the cell closed', () => !opened());
      expect([replaced.length, replaced.at(-1), p.focused()]).toEqual([6, at, cell()]);
      // Only a press brings a cell into view, never an address opened afresh.
      expect(revealed.mock.calls).toHaveLength(3);
    } finally {
      revealed.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('lines up every row’s calls in the widest row’s columns, dense together, and words a range and a call as their cards say them', async () => {
    const many = Array.from({ length: 130 }, (_, i) => cell({ callNo: i + 1, step: i + 1 }));
    many[5] = cell({ callNo: 6, step: 6, state: 'ranked', rank: 2, ranks: [2, 2], changed: 2, detail: 'it stops differently', words: 'it stops differently · in 2 of 2 samples', rankWords: 'it stops, hands over or is judged differently' });
    const few = Array.from({ length: 8 }, (_, i) => cell({ callNo: i + 1, step: i + 1 }));
    few[2] = cell({ callNo: 3, step: 3, state: 'ranked', rank: 1, ranks: [1, 1], changed: 2, detail: 'issue_refund is no longer called', words: 'issue_refund is no longer called · in 2 of 2 samples', rankWords: 'a write changed', scope: 'billing' });
    const wide: PreviewSession = { ...flagged, matrix: [{ ...flagged.matrix[0], cells: many }, { ...flagged.matrix[1], cells: few }] };
    const p = await open({ decisionSessions: () => Promise.resolve({ sessions: [listed()], goldens: 1, more: false }), decisionSession: () => Promise.resolve(wide) });
    await p.until('the matrix', () => p.all('.dmr').length === 2);
    // 130 calls draw as 44 ranges: the row of 8 takes the same 44 columns, so call k sits under call k, and both go dense.
    expect(p.all('.dmr .dmc').map((d) => [d.className, (d.props.style as Record<string, number>)['--n']])).toEqual([
      ['dmc dense', 44],
      ['dmc dense', 44],
    ]);
    const tip = (b: FakeElement) => JSON.parse(b.getAttribute('data-tip')!) as unknown;
    const [same, changed] = p.all('.dmr')[0].querySelectorAll('button.dc');
    expect([same.getAttribute('aria-label'), tip(same)]).toEqual(['#1–#3 · steps 1–3: the same decisions at every call asked', { t: '#1–#3 · steps 1–3', s: 'the same decisions at every call asked', rows: [] }]);
    expect([changed.getAttribute('aria-label'), tip(changed)]).toEqual(['#4–#6 · steps 4–6: 1 changed call, most: #6 it stops differently', { t: '#4–#6 · steps 4–6', s: '1 call of 3 changed', rows: [['#6', 'it stops differently', 'var(--cq-amber)']] }]);
    // A call's card: its scope in its title, its rank in its colour.
    expect(tip(p.all('.dmr')[1].querySelectorAll('button.dc')[2])).toEqual({ t: '#3 · step 3 · billing', s: 'issue_refund is no longer called · in 2 of 2 samples', rows: [['rank 1', 'a write changed', 'var(--cq-red)']] });
  });

  it('offers and prices only the runs no verify took yet, naming them in its command and its job', async () => {
    const next = flagged.view.next;
    const partial: PreviewSession = { ...flagged, view: { ...flagged.view, next: { ...next, verify: { runs: [b], every: false, gone: 0 } } } };
    const priced: Array<readonly string[] | undefined> = [];
    const started: Array<[string, Record<string, unknown>]> = [];
    const client = {
      decisionSessions: () => Promise.resolve({ sessions: [listed()], goldens: 1, more: false }),
      decisionSession: () => Promise.resolve(partial),
      estimates: { decisionEstimates: (_id: string, runIds?: readonly string[]) => (priced.push(runIds), Promise.resolve({ verify: null })) },
      startJob: (kind: string, fields: Record<string, unknown>) => (started.push([kind, fields]), Promise.resolve({ jobId: 'j1', kind, status: 'running' })),
    };
    const p = await open(client as unknown as Partial<Client>);
    await p.until('the verdict', () => !!p.one('.dverdict .actions button') && priced.length > 0);
    const verify = p.one('.dverdict .actions button');
    expect([shown(verify), priced]).toEqual(['Verify 1 run', [[b]]]);
    expect(JSON.parse(verify.getAttribute('data-tip')!)).toMatchObject({ cmd: `$ shadowlap decisions --verify ${ID} ${b.slice(0, 10)}` });
    await p.click(verify);
    await p.until('the ask', () => p.all('.dialog').length === 1);
    await p.click(p.byText('.dialog button', 'Verify 1 run'));
    await p.until('the job', () => started.length === 1);
    expect(started[0]).toEqual(['decisions-verify', expect.objectContaining({ sessionId: ID, runIds: [b] })]);
    // The estimate's address names each run apart, and none for every run left.
    const asked: string[] = [];
    const api = estimatesApi(((path: string) => (asked.push(path), Promise.resolve({ verify: null }))) as unknown as Parameters<typeof estimatesApi>[0]);
    await api.decisionEstimates(ID, [a, b]);
    await api.decisionEstimates(ID, []);
    expect(asked).toEqual([`decisions/${ID}/estimates?runId=${a}&runId=${b}`, `decisions/${ID}/estimates`]);
  });

  it('asks before Migrate in the one ask a retiring model’s row on Needs a look asks, then starts the migration it names', async () => {
    const migrating: PreviewSession = { ...flagged, view: { ...flagged.view, next: { verify: null, more: null, migrate: { to: 'claude-haiku-4-5', from: ['claude-sonnet-4-5-20250929'], goldens: ['goldens/refund'], runs: [] } } } };
    const started: Array<[string, Record<string, unknown>]> = [];
    const client = {
      decisionSessions: () => Promise.resolve({ sessions: [listed()], goldens: 1, more: false }),
      decisionSession: () => Promise.resolve(migrating),
      startJob: (kind: string, fields: Record<string, unknown>) => (started.push([kind, fields]), Promise.resolve({ jobId: 'j1', kind, status: 'running' })),
    };
    const p = await open(client as unknown as Partial<Client>);
    await p.until('the verdict', () => !!p.one('.dverdict .actions button'));
    await p.click(p.byText('.dverdict .actions button', 'Migrate to claude-haiku-4-5'));
    await p.until('the ask', () => p.all('.dialog').length === 1);
    expect([shown(p.one('.dialog h3')), shown(p.one('.dialog header p > span:not([hidden])')), shown(p.one('.dialog .dcost'))]).toEqual([
      'Migrate claude-sonnet-4-5-20250929 to claude-haiku-4-5',
      'Asks claude-sonnet-4-5-20250929’s calls again under claude-haiku-4-5, then verifies end to end the runs the preview can’t clear. Migrate in the docs →',
      'Billed by your provider',
    ]);
    expect(shown(p.one('.dialog .cmdline'))).toContain('shadowlap migrate --to claude-haiku-4-5 goldens/refund --from claude-sonnet-4-5-20250929');
    await p.click(p.one('.dialog .dlg-ok'));
    await p.until('the job', () => started.length === 1);
    expect(started[0]).toEqual(['migrate', expect.objectContaining({ to: 'claude-haiku-4-5', from: ['claude-sonnet-4-5-20250929'], goldens: ['goldens/refund'] })]);
  });

  it('prices Migrate to on the runs a preview of runs asked, as its job migrates them, never on every golden', async () => {
    const migrating: PreviewSession = { ...flagged, view: { ...flagged.view, next: { verify: null, more: null, migrate: { to: 'claude-haiku-4-5', from: ['claude-sonnet-4-5-20250929'], goldens: [], runs: [a, b] } } } };
    const priced: unknown[][] = [];
    const started: Array<[string, Record<string, unknown>]> = [];
    const client = {
      decisionSessions: () => Promise.resolve({ sessions: [listed()], goldens: 1, more: false }),
      decisionSession: () => Promise.resolve(migrating),
      estimates: { migrateEstimate: (...args: unknown[]) => (priced.push(args), Promise.resolve({ estimate: null, preview: null, scopes: [] })) },
      startJob: (kind: string, fields: Record<string, unknown>) => (started.push([kind, fields]), Promise.resolve({ jobId: 'j1', kind, status: 'running' })),
    };
    const p = await open(client as unknown as Partial<Client>);
    await p.until('the price', () => priced.length > 0);
    // Neither kept to a scope nor held to a Stop at $ until its dialog says so.
    expect(priced).toEqual([['claude-haiku-4-5', ['claude-sonnet-4-5-20250929'], [], [a, b], { scope: null, budget: null }]]);
    await p.click(p.byText('.dverdict .actions button', 'Migrate to claude-haiku-4-5'));
    await p.until('the ask', () => p.all('.dialog').length === 1);
    await p.click(p.one('.dialog .dlg-ok'));
    await p.until('the job', () => started.length === 1);
    expect(started[0]).toEqual(['migrate', expect.objectContaining({ to: 'claude-haiku-4-5', runs: [a, b] })]);
  });

  it('marks the message a forked run’s cell changed against its parent’s call, with Jump to change', async () => {
    const turns = (third: string) => Array.from({ length: 4 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', blocks: [{ type: 'text', text: i === 2 ? third : `message ${i + 1}` }] }));
    const at = (third: string) => ({ call: { callNo: 3, kind: 'api', outcome: 'ok' }, conversation: { turns: turns(third), fromCallNo: 3, n: null } });
    const forked: PreviewSession = { ...flagged, matrix: [{ ...flagged.matrix[0], parent: 'r-parent', forkAt: 2 }, flagged.matrix[1]] };
    const asked: string[] = [];
    const call = (run: string) => (asked.push(run), Promise.resolve(at(run === 'r-parent' ? 'message 3' : 'the edited prompt')));
    const p = await render(createElement(AppContext.Provider, { value: app({ decisionSessions: () => Promise.resolve({ sessions: [listed()], goldens: 1, more: false }), decisionSession: () => Promise.resolve(forked), call } as unknown as Partial<Client>) }, createElement(PreviewTab, { id: ID, run: a, call: 3 })));
    page = p;
    await p.until('the change', () => !!p.one('.dconv .msg.changed'));
    expect(asked).toEqual([a, 'r-parent']);
    expect([p.all('.dconv .msg').indexOf(p.one('.dconv .msg.changed')), shown(p.one('.dconv .msg.changed .chg'))]).toEqual([2, 'changed in this fork · first sent at #2']);
    expect(shown(p.one('.dconv .ibar .linkbtn'))).toBe('Jump to change');
  });

  it('says a preview it doesn’t hold, with the way back to the newest', async () => {
    const { ApiError } = await import('../ui/api.js');
    const p = await open({ decisionSessions: () => Promise.resolve({ sessions: [listed()], goldens: 1, more: false }), decisionSession: () => Promise.reject(new ApiError(404, 'no session')) }, 'dc-01M5NOTKEPT0000000000000');
    await p.until('the line', () => p.all('.empty.tall').length === 1);
    expect(shown(p.one('.empty.tall'))).toBe('No preview dc-01M5NOTKEPT0000000000000. Open Preview');
    expect(p.one('.empty.tall a').getAttribute('href')).toBe('#/changes/decisions');
  });

  it('says why a read failed as every page does, the status where the server sent no sentence of its own, else its sentence, with Retry', async () => {
    const { ApiError } = await import('../ui/api.js');
    let tries = 0;
    const lines = (p: Rendered) => p.all('.loaderr p > span').map(shown);
    const late = 'a decision-session job took more than 30 s, so it was stopped';
    const p = await open({ decisionSessions: () => (++tries === 1 ? Promise.reject(new ApiError(500, 'HTTP 500')) : Promise.resolve({ sessions: [listed()], goldens: 1, more: false })), decisionSession: () => Promise.reject(new ApiError(503, late)) });
    await p.until('the list’s failure', () => p.all('.loaderr').length === 1);
    expect(lines(p)).toEqual(['couldn’t load', 'The dashboard server answered 500 for this page’s data.']);
    await p.click(p.byText('.loaderr button', 'Retry'));
    await p.until('the preview’s failure', () => lines(p)[1] === late);
    expect(lines(p)).toEqual(['couldn’t load', late]);
    expect(p.all('.loaderr button').map(shown)).toEqual(['Retry']);
  });

  it('says what a preview is with none kept, and with no goldens what to pack first', async () => {
    const none = (goldens: number) => ({ decisionSessions: () => Promise.resolve({ sessions: [], goldens, more: false }) });
    let p = await open(none(0));
    await p.until('the empty state', () => p.all('.stepempty').length === 1);
    expect(shown(p.one('.stepempty h2, .stepempty h3'))).toBe('Preview a change on your goldens');
    expect(shown(p.one('.stepempty .emptyline'))).toBe('No goldens yet: pack a run as a golden, or preview a change on one run from its Decisions view. Open Runs');
    await p.unmount();
    p = await open(none(3));
    page = p;
    await p.until('the empty state', () => p.all('.stepempty').length === 1);
    expect(shown(p.one('.stepempty'))).toContain('shadowlap decisions goldens/* --model <model>');
    // The three ways, the first lime, each card with the command its dialog runs.
    expect(p.all('.stepempty .actions button').map(shown)).toEqual(['Preview model switch…', 'Preview changed prompt', 'Preview field change…']);
    expect(p.all('.stepempty .actions .btn.lime').length).toBe(1);
    expect(verdictState(flagged.view)).toBe('flagged');
  });

  describe('a run’s Decisions view', () => {
    afterEach(() => forgetDecisionsPick());
    const view = async (answer: RunDecisionsView | null, runId = a, selected: number | null = 3, client: Partial<Client> = {}) => {
      const picked: number[] = [];
      const p = await render(createElement(AppContext.Provider, { value: app({ runDecisions: () => Promise.resolve(answer!), ...client }) }, createElement(DecisionsView, { runId, selected, onSelect: (n: number) => picked.push(n) })));
      page = p;
      return { p, picked };
    };

    it('shows the preview that asked the run, its cells, its ranked steps worded and the line about later steps; a step or a cell picks its call', async () => {
      const { p, picked } = await view(runDecisions(store, a));
      await p.until('the steps', () => p.all('.dvstep').length === 1);
      expect(shown(p.one('.dvhead p'))).toBe(`Model switch to claude-haiku-4-5 · ${minuteStamp(AT)} · 2 samples a step · 1 step changed, most rank 1`);
      expect([shown(p.one('.dvhead a.more')), p.one('.dvhead a.more').getAttribute('href')]).toEqual(['Preview in Changes →', `#/changes/decisions/${ID}/${a}/3`]);
      expect(p.all('.dvstrip button.dc').map((c) => [c.getAttribute('tabindex'), c.getAttribute('aria-current')])).toEqual([['-1', 'false'], ['0', 'true']]);
      expect([p.one('.dvstep').className, shown(p.one('.dvs1'))]).toEqual(['dvstep sel', '#3 rank 1 issue_refund is no longer called · in 2 of 2']);
      expect(p.all('.dvs2').map(shown)).toEqual(['recorded calls tools', 'now calls tools']);
      expect([shown(p.one('.dvlater')), p.one('.dvlater span').getAttribute('tabindex'), p.one('.dvlater span').getAttribute('data-tip')]).toEqual(["Later steps are judged in the recorded run's state.", '0', expect.stringContaining('not where the changed run would have got to')]);
      expect(p.all('.dvpick').length).toBe(0);
      await p.click(p.one('.dvstep'));
      await p.click(p.all('.dvstrip button.dc')[0]);
      expect(picked).toEqual([3, 1]);
    });

    it('offers a chip a preview where several asked the run, the pick kept for the run while the page is open', async () => {
      const one = runDecisions(store, a);
      const older = { ...one.sessions[0], sessionId: 'dc-01M4000000000000000000000B', name: 'Model switch to gpt-4o', at: AT - 86_400_000, kind: 'migrate' as const };
      const both: RunDecisionsView = { ...one, sessions: [one.sessions[0], older] };
      let { p } = await view(both);
      await p.until('the chips', () => p.all('.dvpick button').length === 2);
      expect(p.all('.dvpick button').map((b) => [b.getAttribute('aria-pressed'), b.getAttribute('title')])).toEqual([
        ['true', `Model switch to claude-haiku-4-5 · ${minuteStamp(AT)}`],
        ['false', `Model switch to gpt-4o · ${minuteStamp(AT - 86_400_000)}`],
      ]);
      await p.click(p.all('.dvpick button')[1]);
      expect([shown(p.one('.dvhead b')), shown(p.one('.dvhead a.more'))]).toEqual(['Model switch to gpt-4o', 'Migration in Changes →']);
      await p.unmount();
      ({ p } = await view(both));
      await p.until('the chips', () => p.all('.dvpick button').length === 2);
      expect(p.all('.dvpick button').map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
    });

    it('reads the run’s previews again as a preview or a migration ends, as Preview does', async () => {
      const asked: string[] = [];
      const answer = runDecisions(store, a);
      const runDecisionsOf = (id: string) => (asked.push(id), Promise.resolve(answer));
      function Host() {
        const [ended, setEnded] = useState(0);
        return createElement(AppContext.Provider, { value: { ...app({ runDecisions: runDecisionsOf }), feeds: { decisions: ended } } }, createElement('button', { className: 'ended', type: 'button', onClick: () => setEnded((n) => n + 1) }), createElement(DecisionsView, { runId: a, selected: null, onSelect: () => undefined }));
      }
      const p = await render(createElement(Host));
      page = p;
      await p.until('the steps', () => p.all('.dvstep').length === 1);
      await p.click(p.one('button.ended'));
      await p.until('the second read', () => asked.length === 2);
      expect([asked, p.all('.dvstep').length]).toEqual([[a, a], 1]);
    });

    it('lists a step its control couldn’t settle, inconclusive in amber, so a run that changed nothing else never reads as decided as recorded', async () => {
      const open = step(3, null, { majority: null, sampled: 1, samples: { asked: 3, answered: 3, changed: 1, ranks: [1, 0, 0] }, control: { asked: 3, answered: 0, changed: 0, ranks: [], error: 'overloaded' } });
      const one = runDecisions(store, a);
      const answer: RunDecisionsView = { ...one, sessions: [{ ...one.sessions[0], steps: viewSteps(runOf(a, null, [step(1, null), open])) }] };
      const { p } = await view(answer);
      await p.until('the steps', () => p.all('.dvstep').length === 1);
      expect(shown(p.one('.dvs1 .dsy'))).toContain("inconclusive: in 1 of 3 samples; as recorded, no answer (overloaded): too few to tell from the model's own variation");
      expect(p.all('.dvnone').length).toBe(0);
    });

    it('says a run decided as recorded, a run nobody previewed with the command, and that an exported copy holds no previews', async () => {
      let { p } = await view(runDecisions(store, b), b, null);
      await p.until('the line', () => p.all('.dvnone').length === 1);
      expect([shown(p.one('.dvnone')), p.all('.dvstep').length]).toEqual(['The same decision at every step asked.', 0]);
      await p.unmount();
      ({ p } = await view({ runId: 'r-none', sessions: [], later: null }, 'r-none', null));
      await p.until('the empty view', () => p.all('.dvempty').length === 1);
      expect(shown(p.one('.dvempty p'))).toBe('No change has been previewed on this run. Each of its model calls can be asked again with only the change swapped in, and no tool runs.');
      expect(shown(p.one('.dvempty'))).toContain('shadowlap decisions r-none --model <model>');
      await p.unmount();
      ({ p } = await view(null, a, null, { exported: true }));
      expect(shown(p.one('.dview'))).toBe('An exported copy holds no previews.');
    });
  });
});
