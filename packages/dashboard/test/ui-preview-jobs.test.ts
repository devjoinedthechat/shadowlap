import { createElement } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { emptyCounts, NO_TOKENS, Store, type DecisionChange, type DecisionRun, type DecisionStep } from '@shadowlap/engine';
import { DONE, LOOKUP, POLICY, REFUND, recordRun } from '../../engine/test/training-fixtures.js';
import { previewSession, type PreviewSession } from '../src/decision-view.js';
import { runDecisions } from '../src/decisions.js';
import type { Client } from '../ui/api.js';
import { fieldLine, markedChange, previewCommand, typedValue } from '../ui/changes/NewPreview.js';
import { PreviewTab } from '../ui/changes/Preview.js';
import { moreTip } from '../ui/changes/VerifyAsk.js';
import { targetHead, wayCommand } from '../ui/components/NewPreviewMenu.js';
import { DecisionsView } from '../ui/run/DecisionsView.js';
import { dropPick, forgetDecisionsPick, pickedSession, pickSession } from '../ui/run/decisions-pick.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { DecisionSessionView } from '../ui/types.js';
import { render, type Rendered } from './ui-render.js';

/**
 * Starting and settling previews: New preview's head and each way's command, the command a dialog
 * shows and the value it sends, the line under a field change; then a kept preview's Verify with
 * each run in its role, Run more attempts on the runs verify left open, an opened cell's Verify this
 * run, and a run's Decisions view with New preview, its three ways and its verify.
 */

const AT = Date.parse('2026-10-01T10:12:00Z');
const write: DecisionChange = { rank: 1, kind: 'write-removed', tool: 'issue_refund', effect: 'write', before: { amount: 240 }, after: null, detail: 'issue_refund is no longer called' };
const step = (callNo: number, rank: DecisionStep['rank']): DecisionStep => ({
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
});
const runOf = (runId: string, golden: string | null, decisions: DecisionStep[]): DecisionRun => {
  const ranks = decisions.map((d) => d.rank).filter((r): r is NonNullable<typeof r> => r !== null);
  const rank = ranks.length ? (Math.min(...ranks) as DecisionRun['rank']) : null;
  return { runId, golden, steps: decisions.length, asked: decisions.length, rank, majority: rank, counts: emptyCounts(), cost: { before: 0.04, after: 0.02, spent: 0.02 }, tokens: { before: NO_TOKENS, after: NO_TOKENS }, thinkingStripped: 0, refused: null, decisions, warnings: [] };
};
const shown = (el: { textContent: string } | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

describe('a new preview, worked out', () => {
  it('heads its menu by who it asks, and gives each way the command it runs at its default', () => {
    expect([targetHead({ goldens: 'all' }), targetHead({ runs: ['01M5H2DJ1WDXDJVF85FRE4DWH5'] }), targetHead({ runs: ['a', 'b'] })]).toEqual(['On every golden', 'On 01M5H2DJ1W', 'On 2 runs']);
    expect([wayCommand('model', { goldens: 'all' }), wayCommand('code', { runs: ['01M5H2DJ1WDXDJVF85FRE4DWH5'] }), wayCommand('field', { goldens: 'all' })]).toEqual([
      '$ shadowlap decisions goldens/* --model <model>',
      '$ shadowlap decisions 01M5H2DJ1W --from-code --samples 1',
      '$ shadowlap decisions goldens/* --set <key=value> --samples 1',
    ]);
  });

  it('shows the job’s own command, cut to the first targets past six with Copy taking it whole, and sends a typed value as JSON where it parses', () => {
    expect(previewCommand({ targets: ['goldens/a', 'goldens/b'], model: 'claude-haiku-4-5' })).toEqual({ command: 'shadowlap decisions goldens/a goldens/b --model claude-haiku-4-5' });
    const many = previewCommand({ targets: Array.from({ length: 7 }, (_, i) => `goldens/g${i}`), fromCode: true, samples: 1 });
    expect(many.command).toBe('shadowlap decisions goldens/g0 goldens/g1 goldens/g2 … and 4 more --from-code --samples 1');
    expect((many as { full?: string }).full).toContain('goldens/g6 --from-code');
    expect([typedValue('512'), typedValue('true'), typedValue('{"a":1}'), typedValue('low')]).toEqual([512, true, { a: 1 }, 'low']);
  });

  it('marks a prompt’s change as the middle removed and added, and says under a field change what the recorded answers show or why it can’t run', () => {
    expect(markedChange('Be brief. Refund only with a receipt.', 'Be brief. Refund any order.')).toEqual({ head: 'Be brief. Refund ', del: 'only with a receipt', ins: 'any order', tail: '.' });
    expect(fieldLine('model', '1', null)).toBe('model is not a request field to set: give the model with Preview model switch…');
    expect(fieldLine('max tokens', '1', null)).toBe('A field’s name: letters, digits, _ and dots; a dotted name is a path.');
    expect(fieldLine('max_tokens', '', null)).toBe('Give it a value: a number, a word, or JSON.');
    const est = { refused: null, answers: { most: 900, cut: 2 } } as unknown as Parameters<typeof fieldLine>[2];
    expect(fieldLine('max_tokens', '512', est)).toBe('The recorded answers used up to 900 output tokens: 2 answers would be cut off.');
    expect(fieldLine('temperature', '0', { ...est!, refused: { field: 'temperature', model: 'claude-opus-4-7', says: 'claude-opus-4-7 is among Claude 4.7 and later, where temperature is gone (Anthropic)', source: '' } })).toBe('claude-opus-4-7 is among Claude 4.7 and later, where temperature is gone (Anthropic): its steps would get no answer.');
    expect(fieldLine('top_k', '5', est)).toBe('Every call is asked with it, the agent’s and any other’s.');
  });

  it('says Run more attempts’ limit in verify’s words, without `a run` on one run’s view, and drops a run’s pick once a preview of it starts', () => {
    const more = { kind: 'more' as const, runs: ['a'], max: 160, keptMax: null, flags: ['--gate', '{"max":160}'], attempts: 80, limit: 'up to 160 attempts a run' };
    expect([moreTip(more, { one: true }), moreTip(more, { one: true, view: true }), moreTip({ ...more, runs: ['a', 'b'] }, { one: false })]).toEqual([
      'Verifies it again from the start, up to 160 attempts a run',
      'Verifies it again from the start, up to 160 attempts',
      'Verifies them again from the start, up to 160 attempts a run',
    ]);
    pickSession('R', 'dc-1');
    expect(pickedSession('R')).toBe('dc-1');
    dropPick('R');
    expect(pickedSession('R')).toBeUndefined();
  });
});

describe('a kept preview’s verify', () => {
  let store: Store;
  let a = '';
  let b = '';
  let flagged: PreviewSession;
  let page: Rendered | null = null;
  const ID = 'dc-01M5000000000000000000000J';

  beforeAll(() => {
    store = Store.open(':memory:');
    // The DOM pass reads the engine as built and its fixtures as sources: the one store, either way.
    const kept = store as unknown as Parameters<typeof recordRun>[0];
    a = recordRun(kept, [LOOKUP, POLICY, REFUND, DONE], { model: 'claude-sonnet-4-5-20250929' }).run.runId;
    b = recordRun(kept, [LOOKUP, POLICY, DONE], { model: 'claude-sonnet-4-5-20250929' }).run.runId;
    const runs = [runOf(a, 'goldens/refund', [step(1, null), step(3, 1)]), runOf(b, null, [step(1, null), step(3, null)])];
    const report = { decisionsId: ID, kind: 'decisions', at: AT, change: { model: 'claude-haiku-4-5', fields: {}, from: ['claude-sonnet-4-5-20250929'], fromCode: null, text: 'the model claude-haiku-4-5' }, command: 'shadowlap decisions goldens/* --model claude-haiku-4-5', samples: 2, counts: { ...emptyCounts(), 1: 1, same: 3 }, flagged: [a], toVerify: [a], runs, cost: null, notes: [] };
    store.putDecisionSession({ sessionId: ID, kind: 'decisions', at: AT, change: report.change.text, actor: null, revision: null, data: report, runs: runs.map((r) => ({ runId: r.runId, golden: r.golden, rank: r.rank, changed: 1, data: r as unknown as Record<string, unknown> })) });
    flagged = previewSession(store, ID)!;
    // The menu places itself in the window.
    vi.stubGlobal('innerWidth', 1440);
    vi.stubGlobal('innerHeight', 900);
  });
  afterAll(() => {
    store.close();
    vi.unstubAllGlobals();
  });
  afterEach(async () => {
    await page?.unmount();
    page = null;
    forgetDecisionsPick();
  });

  const listed = (): DecisionSessionView => ({ sessionId: ID, kind: 'decisions', at: AT, change: 'the model claude-haiku-4-5', name: 'Model switch to claude-haiku-4-5', runs: 2, goldens: 1, unit: 'run', samples: 2, flagged: 1, actor: null, revision: null, href: `#/changes/decisions/${ID}` });
  const started: Array<[string, Record<string, unknown>]> = [];
  const client = (session: PreviewSession, more: Partial<Client> = {}): Partial<Client> => ({
    decisionSessions: () => Promise.resolve({ sessions: [listed()], goldens: 1, retirements: { version: '', notices: [] } }),
    decisionSession: () => Promise.resolve(session),
    // An opened cell's conversation, which these tests don't read.
    call: () => new Promise(() => undefined),
    startJob: (kind: string, fields: Record<string, unknown>) => (started.push([kind, fields]), Promise.resolve({ id: 'j1', kind, title: '', args: [], done: false, code: null } as never)),
    ...more,
  });
  const app = (c: Partial<Client>, o: Partial<AppState> = {}): AppState =>
    ({
      client: { jobs: () => Promise.resolve([]), estimates: { decisionEstimates: () => Promise.resolve({ verify: null, runs: [{ runId: a, role: 'target' }] }), previewEstimates: () => Promise.resolve({ ways: null }) }, ...c } as unknown as Client,
      exported: false,
      meta: null,
      tick: 0,
      runsTick: 0,
      feeds: {},
      jobs: [],
      live: [],
      runs: [],
      actionsOff: null,
      hasKind: () => true,
      guard: (fn: () => void) => (fn(), true),
      toast: () => undefined,
      watchJob: () => undefined,
      refresh: () => undefined,
      ...o,
    }) as unknown as AppState;
  const open = async (c: Partial<Client>, o: { run?: string; call?: number } = {}) => {
    page = await render(createElement(AppContext.Provider, { value: app(c) }, createElement(PreviewTab, { id: null, run: o.run ?? null, call: o.call ?? null })));
    return page;
  };

  it('asks before Verify with each run it takes in the role its checks give it, the lead for one run, and starts on the runs left', async () => {
    started.length = 0;
    const p = await open(client(flagged));
    await p.until('the verdict', () => p.all('.dverdict .actions button').length > 0);
    await p.click(p.byText('.dverdict .actions button', 'Verify 1 run'));
    await p.until('the dialog', () => p.all('.dialog').length === 1);
    expect(shown(p.one('.dialog h3'))).toBe('Verify 1 run');
    expect(shown(p.one('.dialog header p'))).toContain('Replays the run end to end under the model claude-haiku-4-5 until verify’s gate decides.');
    expect(p.all('.dialog .dvrows p').map(shown)).toEqual([`${a} refund must now pass`]);
    expect(shown(p.one('.dialog .cmdline'))).toContain(`shadowlap decisions --verify ${ID}`);
    await p.click(p.byText('.dialog button', 'Verify 1 run'));
    expect(started).toEqual([['decisions-verify', { sessionId: ID }]]);
  });

  it('offers Run more attempts lime on the runs verify left open, each with what verify found, at the limit its job raises', async () => {
    started.length = 0;
    const open1 = { ...flagged.matrix[0], verified: { outcome: 'inconclusive', tally: ' · 50 of 80' } };
    const more = { kind: 'more' as const, runs: [a], max: 160, keptMax: null, flags: ['--gate', '{"max":160}'], attempts: 80, limit: 'up to 160 attempts a run' };
    const session: PreviewSession = { ...flagged, matrix: [open1, flagged.matrix[1]], view: { ...flagged.view, next: { verify: null, more, migrate: null } } };
    const p = await open(client(session));
    await p.until('the verdict', () => p.all('.dverdict .actions button').length > 0);
    const button = p.byText('.dverdict .actions button', 'Run more attempts');
    expect(button.className).toContain('lime');
    expect(JSON.parse(button.getAttribute('data-tip')!)).toMatchObject({ t: 'Verifies it again from the start, up to 160 attempts a run' });
    await p.click(button);
    await p.until('the dialog', () => p.all('.dialog').length === 1);
    expect(shown(p.one('.dialog h3'))).toBe('Run more attempts');
    expect(shown(p.one('.dialog header p'))).toContain('Verifies the run again from the first attempt: its 80 so far don’t carry over.');
    expect(p.all('.dialog .dvrows p').map(shown)).toEqual([`${a} refund inconclusive · 50 of 80`]);
    expect(shown(p.one('.dialog .cmdline'))).toContain(`shadowlap decisions --verify ${ID} ${a.slice(0, 10)} --gate '{"max":160}'`);
    await p.click(p.byText('.dialog button', 'Run more attempts'));
    expect(started).toEqual([['decisions-verify', { sessionId: ID, runIds: [a], max: 160 }]]);
  });

  it('offers an opened cell’s Verify this run before Open run on a run left to verify, and waits on one the preview cleared, saying why', async () => {
    started.length = 0;
    let p = await open(client(flagged), { run: a, call: 3 });
    await p.until('the cell', () => p.all('#dcell').length === 1);
    expect(p.all('.dacts .btn').map(shown)).toEqual(['Verify this run', 'Open run']);
    await p.click(p.byText('.dacts button', 'Verify this run'));
    await p.until('the dialog', () => p.all('.dialog').length === 1);
    expect(shown(p.one('.dialog h3'))).toBe(`Verify change on ${a.slice(0, 10)}`);
    await p.click(p.byText('.dialog button', 'Verify this run'));
    expect(started).toEqual([['decisions-verify', { sessionId: ID, runIds: [a] }]]);
    await p.unmount();
    p = page = await open(client(flagged), { run: b, call: 3 });
    await p.until('the cell', () => p.all('#dcell').length === 1);
    const wait = p.byText('.dacts button', 'Verify this run');
    expect([wait.getAttribute('aria-disabled'), wait.getAttribute('data-why')]).toEqual(['true', 'Nothing to verify in this run']);
  });

  it('gives a run’s Decisions view New preview of the run, waiting while it records, and Verify this run under its steps', async () => {
    const view = runDecisions(store, a);
    const c = { runDecisions: () => Promise.resolve(view) } as Partial<Client>;
    page = await render(createElement(AppContext.Provider, { value: app(c) }, createElement(DecisionsView, { runId: a, selected: null, onSelect: () => undefined, live: true })));
    const p = page;
    await p.until('the view', () => p.all('.dvhead').length === 1);
    const menu = p.byText('.dvhead button', 'New preview');
    expect(menu.className).toBe('btn sm');
    expect(menu.getAttribute('data-why')).toBe('Preview once the recording finishes');
    expect(p.all('.dview > .actions button').map(shown)).toEqual(['Verify this run']);
    expect(p.one('.dview > .actions button').className).not.toContain('lime');
  });

  it('offers the three ways small and plain on a run nobody previewed', async () => {
    const c = { runDecisions: () => Promise.resolve({ runId: b, sessions: [], later: null }) } as unknown as Partial<Client>;
    page = await render(createElement(AppContext.Provider, { value: app(c) }, createElement(DecisionsView, { runId: b, selected: null, onSelect: () => undefined })));
    const p = page;
    await p.until('the empty view', () => p.all('.dvempty .actions button').length === 3);
    expect(p.all('.dvempty .actions button').map((x) => [shown(x), x.className])).toEqual([
      ['Preview model switch…', 'btn sm'],
      ['Preview changed prompt', 'btn sm'],
      ['Preview field change…', 'btn sm'],
    ]);
  });
});
