import { createElement } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { emptyCounts, NO_TOKENS, noEstimate, Store, type DecisionChange, type DecisionRun, type DecisionStep } from '@shadowlap/engine';
import { DONE, LOOKUP, POLICY, REFUND, recordRun } from '../../engine/test/training-fixtures.js';
import { previewSession, type PreviewSession } from '../src/decision-view.js';
import { runDecisions } from '../src/decisions.js';
import { THEN_VERIFY_UNPRICED } from '../src/preview-estimate.js';
import { ApiError, type Client } from '../ui/api.js';
import { typedValue } from '../src/decisions-argv.js';
import { fieldLine, markedChange, NewPreview, previewCommand } from '../ui/changes/NewPreview.js';
import { PreviewTab } from '../ui/changes/Preview.js';
import { moreTip } from '../ui/changes/VerifyAsk.js';
import { NO_GOLDENS, targetHead, wayCommand, type PreviewTarget } from '../ui/components/NewPreviewMenu.js';
import { DecisionsView } from '../ui/run/DecisionsView.js';
import { forgetDecisionsPick, onPick, pickedSession, pickSession } from '../ui/run/decisions-pick.js';
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
    // A pick tells the views that watch it, so a preview of one run that ends shows in its view.
    let told = 0;
    const off = onPick(() => told++);
    pickSession('R', 'dc-1');
    expect(pickedSession('R')).toBe('dc-1');
    off();
    pickSession('R', 'dc-2');
    expect([pickedSession('R'), told]).toEqual(['dc-2', 1]);
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
    decisionSessions: () => Promise.resolve({ sessions: [listed()], goldens: 1, more: false }),
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
    const open1 = { ...flagged.matrix[0], verified: { outcome: 'inconclusive', tally: ' · 50 of 80', count: '50 of 80' } };
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
    expect(p.all('.dialog .dvrows p').map(shown)).toEqual([`${a} refund inconclusive 50 of 80`]);
    // The run's status, as main draws one, then its tally alone (the mock's chMoreDialog).
    expect(p.all('.dialog .dvrows .dvr .st.warn').map(shown)).toEqual(['inconclusive']);
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

describe('a new preview’s dialogs', () => {
  const RUN = '01M5H2DJ1W0000000000000000';
  const OTHER = '01M5H2DJR40000000000000000';
  const priced = { kind: 'preview', usd: 0.42, ceiling: false, parts: ['about 82 requests, half as recorded'] };
  const read = (q: Record<string, unknown>) => ({
    preview: q.model || q.set || q.fromCode ? priced : null,
    asks: { calls: 41, from: ['claude-sonnet-4-5'], control: true, runs: 2, otherFamily: null },
    recorded: [{ id: 'claude-sonnet-4-5', family: 'claude', calls: 41 }],
    answers: { most: 1840, cut: 3 },
    refused: null,
    targets: ['goldens/refund', 'goldens/budget'],
    ways: null,
    scopes: [{ scope: null, calls: 41 }],
  });
  const tree = { fromCode: { calls: 12, instructions: { before: 'Be brief.', after: 'Be brief. Never email.' }, tools: { added: [], removed: [], changed: [] } }, runs: [{ runId: RUN, golden: 'goldens/refund', changed: [1, 3], refused: null }, { runId: OTHER, golden: 'goldens/budget', changed: [], refused: null }], notes: [], nothing: null };
  let page: Rendered | null = null;
  let started: Array<[string, Record<string, unknown>]> = [];
  let stopped: string[] = [];
  let queries: Array<Record<string, unknown>> = [];
  beforeAll(() => {
    vi.stubGlobal('innerWidth', 1440);
    vi.stubGlobal('innerHeight', 900);
  });
  afterAll(() => vi.unstubAllGlobals());
  afterEach(async () => {
    await page?.unmount();
    page = null;
    started = [];
    stopped = [];
    queries = [];
  });
  /** A dialog on every golden, or `target`, its estimate `read` unless `estimate` answers instead (a throw is a failed read). */
  const open = async (way: 'model' | 'code' | 'field', startJob: (kind: string, fields: Record<string, unknown>) => Promise<unknown>, o: { target?: PreviewTarget; estimate?: (q: Record<string, unknown>) => unknown } = {}) => {
    const client = {
      jobs: () => Promise.resolve([]),
      estimates: { previewEstimates: (q: Record<string, unknown>) => (queries.push(q), Promise.resolve().then(() => (o.estimate ?? read)(q))), modelChoices: () => Promise.resolve({ choices: [], notes: [], priced: [] }) },
      startJob: (kind: string, fields: Record<string, unknown>) => (started.push([kind, fields]), startJob(kind, fields)),
      job: () => new Promise(() => undefined),
      stopJob: (id: string) => (stopped.push(id), Promise.resolve()),
    };
    const app = { client, exported: false, actionsOff: null, meta: null, jobs: [], feeds: {}, hasKind: () => true, guard: (fn: () => void) => (fn(), true), toast: () => undefined, watchJob: () => undefined } as unknown as AppState;
    page = await render(createElement(AppContext.Provider, { value: app }, createElement(NewPreview, { way, target: o.target ?? { goldens: 'all' }, onClose: () => undefined })));
    return page;
  };
  const job = (kind: string, more: Record<string, unknown> = {}) => Promise.resolve({ id: `${kind}-1`, kind, title: '', args: [], done: false, code: null, total: 0, ...more });
  const facts = (p: Rendered) => p.all('.dialog .dfacts div').map(shown);

  it('switches to the model typed, saying which calls it asks, and starts the preview with the estimate it showed', async () => {
    const p = await open('model', (kind) => job(kind));
    await p.until('its estimate', () => shown(p.one('.dialog .cmdline')).includes('goldens/refund'));
    await p.type(p.one('.dialog input[type="text"]'), 'claude-haiku-4-5');
    await p.until('the model’s calls', () => facts(p).some((f) => f.includes('the 41 calls made with claude-sonnet-4-5')));
    // A row's term, value and quiet line, as the dialog's facts draw them.
    expect(facts(p)).toEqual(['Asksthe 41 calls made with claude-sonnet-4-5, 3 samples each and 3 as recordedthe model the runs use most; as recorded is the control', 'Toolsnone runnothing reaches the world']);
    expect(shown(p.one('.dialog .cmdline'))).toContain('shadowlap decisions goldens/refund goldens/budget --model claude-haiku-4-5');
    await p.click(p.one('.dialog .dlg-ok'));
    expect(started).toHaveLength(1);
    expect(started[0][0]).toBe('decisions');
    // With the estimate its cost line showed, which its drawer says.
    expect(started[0][1]).toMatchObject({ goldens: 'all', model: 'claude-haiku-4-5', estimate: { usd: 0.42, ceiling: false } });
  });

  it('reads what the working tree sends as a job of its own, waiting on it, and stops the read when it closes unread', async () => {
    const p = await open('code', (kind) => job(kind));
    await p.until('the read to start', () => started.length === 1);
    expect(started[0]).toEqual(['decisions-read', { goldens: 'all' }]);
    expect(shown(p.one('.dialog .dlgest'))).toBe('Reading what your working tree sends…');
    // The confirm waits, saying why, until the read ends.
    expect(p.one('.dialog .dlg-ok').props['data-why']).toBe('Reading what your working tree sends');
    await p.unmount();
    page = null;
    expect(stopped).toEqual(['decisions-read-1']);
  });

  it('asks a sent golden’s consent before it reads, then shows the prompt’s change marked and the calls it asks', async () => {
    const why = 'goldens/refund came from a pack: its command runs on your machine';
    const p = await open('code', (kind, fields) => (kind === 'decisions-read' && fields.yes === undefined ? Promise.reject(new ApiError(409, why, 'c1')) : job(kind, { done: true, code: 0, result: tree })));
    await p.until('the consent question', () => p.all('.dialog').length === 2);
    await p.click(p.byText('.dialog button', 'Run command'));
    await p.until('the read', () => p.all('.dialog .dprompt').length === 1);
    expect(started.map(([k, f]) => [k, f.yes ?? null])).toEqual([['decisions-read', null], ['decisions-read', 'c1']]);
    // Only added to: nothing marked removed.
    expect([p.all('.dialog .dprompt del').length, shown(p.one('.dialog .dprompt ins'))]).toEqual([0, 'Never email.']);
    expect(facts(p)).toContain('Asks2 model calls, in 1 of 2 goldens');
    // Priced once read, on the calls the read named, asked once.
    await p.until('its price', () => shown(p.one('.dialog .dcost')).includes('≈$0.42'));
    expect(queries).toEqual([{ goldens: 'all', fromCode: true, samples: 1, changed: { [RUN]: [1, 3], [OTHER]: [] } }]);
    expect(p.one('.dialog .dlg-ok').props['data-why']).toBeUndefined();
    // The read's yes carries into the preview: the same command, asked once.
    await p.click(p.one('.dialog .dlg-ok'));
    expect(started.at(-1)).toEqual(['decisions', { goldens: 'all', fromCode: true, samples: 1, yes: 'c1', estimate: { usd: 0.42, ceiling: false } }]);
    expect(p.all('.dialog')).toHaveLength(1);
  });

  it('labels the prompt by the scope of the first call it changes, and says where the working tree changes nothing, asking no price', async () => {
    const scoped = await open('code', (kind) => job(kind, { done: true, code: 0, result: { ...tree, scope: 'agent' } }));
    await scoped.until('the read', () => scoped.all('.dialog .dprompt').length === 1);
    expect(shown(scoped.all('.dialog .dprompt .k')[0])).toBe('The agent’s system prompt');
    await scoped.unmount();
    queries = [];
    const nothing = 'Nothing to ask: the change leaves every request as recorded';
    const p = (page = await open('code', (kind) => job(kind, { done: true, code: 0, result: { ...tree, runs: tree.runs.map((r) => ({ ...r, changed: [] })), nothing } })));
    await p.until('the warning', () => p.all('.dialog .dwarn').length === 1);
    expect(shown(p.one('.dialog .dwarn'))).toBe(nothing);
    expect(p.one('.dialog .dlg-ok').props['data-why']).toBe(nothing);
    expect([p.all('.dialog .dcost').length, p.all('.dialog .dprompt').length, queries.length]).toEqual([0, 0, 0]);
  });

  it('waits on a model of another family in the engine’s words, with no cost line, and starts nothing', async () => {
    const family = 'gpt-5.1 is of another family than the calls it switches, so none can be asked again: verify that switch instead';
    const p = await open('model', (kind) => job(kind), { estimate: (q) => (q.model === 'gpt-5.1' ? { ...read(q), preview: null, asks: { ...read(q).asks, calls: 0, otherFamily: family } } : read(q)) });
    await p.until('its estimate', () => shown(p.one('.dialog .cmdline')).includes('goldens/refund'));
    await p.type(p.one('.dialog input[type="text"]'), 'gpt-5.1');
    await p.until('the other family', () => p.all('.dialog .dwarn').length === 1);
    expect(shown(p.one('.dialog .dwarn'))).toBe(family);
    expect(p.one('.dialog .dlg-ok').props['data-why']).toBe(family);
    expect(p.all('.dialog .dcost')).toHaveLength(0);
    await p.click(p.one('.dialog .dlg-ok'));
    expect(started).toEqual([]);
  });

  it('says why the confirm waits where what it asks didn’t load, in its line too', async () => {
    const p = await open('model', (kind) => job(kind), {
      estimate: () => {
        throw new ApiError(503, 'the store is busy');
      },
    });
    await p.type(p.one('.dialog input[type="text"]'), 'claude-haiku-4-5');
    await p.until('the failed read', () => p.all('.dialog .dlgest').length === 1);
    expect(shown(p.one('.dialog .dlgest'))).toBe('What it asks didn’t load: the store is busy');
    expect(p.one('.dialog .dlg-ok').props['data-why']).toBe('What it asks didn’t load: the store is busy');
  });

  it('says a read that answered a status alone in the line every page says it, what it asks and what your working tree sends', async () => {
    const p = await open('model', (kind) => job(kind), {
      estimate: () => {
        throw new ApiError(500, 'HTTP 500');
      },
    });
    await p.type(p.one('.dialog input[type="text"]'), 'claude-haiku-4-5');
    await p.until('the failed read', () => p.all('.dialog .dlgest').length === 1);
    expect(shown(p.one('.dialog .dlgest'))).toBe('What it asks didn’t load: The dashboard server answered 500 for this page’s data.');
    await p.unmount();
    page = null;
    const tree = await open('code', (kind) => (kind === 'decisions-read' ? Promise.reject(new ApiError(502, 'HTTP 502')) : job(kind)));
    await tree.until('the failed read', () => tree.all('.dialog .dlgest').length === 1);
    expect(shown(tree.one('.dialog .dlgest'))).toBe('What your working tree sends didn’t load: The dashboard server answered 502 for this page’s data.');
    expect(tree.one('.dialog .dlg-ok').props['data-why']).toBe('What your working tree sends didn’t load: The dashboard server answered 502 for this page’s data.');
  });

  it('holds each way on no golden at all with the amber line as its why, asking nothing and showing no command', async () => {
    for (const way of ['model', 'code', 'field'] as const) {
      const p = (page = await open(way, (kind) => job(kind), { target: { goldens: 'all', count: 0 } }));
      await new Promise((r) => setTimeout(r, 350));
      expect(shown(p.one('.dialog .dwarn')), way).toBe(NO_GOLDENS);
      expect(p.one('.dialog .dlg-ok').props['data-why'], way).toBe(NO_GOLDENS);
      expect([p.all('.dialog .cmdline').length, p.all('.dialog .dcost').length, queries.length, started.length], way).toEqual([0, 0, 0, 0]);
      await p.unmount();
      page = null;
    }
  });

  it('narrows a switch to the goldens, the model and the scope picked, holds it to its Stop at $ and then verifies, its command and its job saying so', async () => {
    // As the server reads the goldens picked: two models, called in the agent's scope and a simulated user's.
    const two = (q: Record<string, unknown>) => ({
      ...read(q),
      preview: q.thenVerify ? noEstimate('preview', THEN_VERIFY_UNPRICED) : priced,
      recorded: [
        { id: 'claude-sonnet-4-5', family: 'claude', calls: 30 },
        { id: 'claude-haiku-4-5', family: 'claude', calls: 11 },
      ],
      scopes: [
        { scope: 'support-agent', calls: 30 },
        { scope: 'customer', calls: 11 },
      ],
      targets: Array.isArray(q.goldens) ? q.goldens : ['goldens/refund', 'goldens/budget'],
    });
    const p = await open('model', (kind) => job(kind), { estimate: two });
    await p.until('its estimate', () => shown(p.one('.dialog .cmdline')).includes('goldens/budget'));
    await p.type(p.one('.dialog input[type="text"]'), 'claude-sonnet-5-5');
    const select = (label: string) => p.all('.dialog label').find((l) => l.textContent.startsWith(label))!.querySelector('select')!;
    await p.type(select('Switch from'), 'claude-haiku-4-5');
    await p.type(select('Scope'), 'support-agent');
    await p.click(p.byText('.dialog .togchips button', 'budget'));
    expect(shown(p.one('.dialog .nsec .n'))).toBe('1 of 2');
    await p.click(p.byText('.dialog .switch', 'Then verify what it can’t clear'));
    // A Stop at $ that is no amount holds the way on, saying why.
    await p.type(p.one('.dialog input[type="number"]'), '-1');
    await p.click(p.one('.dialog .dlg-ok'));
    expect(started).toEqual([]);
    await p.type(p.one('.dialog input[type="number"]'), '2.5');
    await p.until('the narrowed command', () => shown(p.one('.dialog .cmdline')).includes('--budget 2.50'));
    expect(shown(p.one('.dialog .cmdline'))).toBe('$shadowlap decisions goldens/refund --model claude-sonnet-5-5 --from claude-haiku-4-5 --scope support-agent --then-verify --budget 2.50');
    // Asked as the job runs it, once the form holds still; then verifying, it has no estimate until it has asked, and says why.
    await p.until('the narrowed read', () => queries.some((q) => q.budget === 2.5) && shown(p.one('.dialog .dcost')).includes(THEN_VERIFY_UNPRICED));
    expect(queries.find((q) => q.budget === 2.5)).toEqual({ goldens: ['goldens/refund'], model: 'claude-sonnet-5-5', from: ['claude-haiku-4-5'], scope: 'support-agent', thenVerify: true, budget: 2.5 });
    await p.click(p.one('.dialog .dlg-ok'));
    expect(started).toEqual([['decisions', { goldens: ['goldens/refund'], model: 'claude-sonnet-5-5', from: ['claude-haiku-4-5'], scope: 'support-agent', thenVerify: true, budget: 2.5 }]]);
  });

  it('keeps a field change to the calls made with one model, and every model by default, a scope to pick only where there are two', async () => {
    const p = await open('field', (kind) => job(kind), { estimate: (q) => ({ ...read(q), recorded: [{ id: 'claude-sonnet-4-5', family: 'claude', calls: 30 }, { id: 'gpt-5.5', family: 'gpt', calls: 11 }] }) });
    await p.until('its estimate', () => shown(p.one('.dialog .cmdline')).includes('--set max_tokens=512'));
    // One scope: nothing to pick there; two models: every one of them, until one is picked.
    expect(p.all('.dialog .narrow label').map((l) => l.childNodes[0]?.textContent)).toEqual(['Calls made with', 'Stop at $']);
    expect(p.all('.dialog .narrow select option').map(shown)).toEqual(['every model', 'claude-sonnet-4-5', 'gpt-5.5']);
    await p.type(p.one('.dialog .narrow select'), 'gpt-5.5');
    await p.until('its command', () => shown(p.one('.dialog .cmdline')).includes('--from gpt-5.5'));
    await p.click(p.one('.dialog .dlg-ok'));
    expect(started[0][1]).toMatchObject({ goldens: 'all', set: { max_tokens: 512 }, from: ['gpt-5.5'] });
  });

  it('says what the recorded answers show of max_tokens, refuses model in its own words, and sends a typed number as a number', async () => {
    const p = await open('field', (kind) => job(kind));
    await p.until('the answers', () => p.all('.dialog').some((d) => d.textContent.includes('The recorded answers used up to 1,840 output tokens: 3 answers would be cut off.')));
    const [field, value] = p.all('.dialog input[type="text"]');
    await p.type(field, 'model');
    expect(p.one('.dialog').textContent).toContain('model is not a request field to set: give the model with Preview model switch…');
    await p.type(field, 'temperature');
    await p.type(value, '0.2');
    await p.until('its estimate', () => shown(p.one('.dialog .cmdline')).includes('--set temperature=0.2'));
    await p.click(p.one('.dialog .dlg-ok'));
    expect(started[0][1]).toMatchObject({ goldens: 'all', set: { temperature: 0.2 } });
  });
});
