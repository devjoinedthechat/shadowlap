import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { TrainingView } from '../ui/api.js';
import { TrainingPage } from '../ui/pages/Training.js';
import { trainingFacts } from '../ui/pages/training/facts.js';
import { AppContext, type AppState } from '../ui/state.js';
import { render, type Rendered } from './ui-render.js';

/**
 * Training as the design draws it: its facts under the header (none with no runs in the project,
 * and no counts on the tabs then), sections rather than cards, confidence and status in words, a
 * pair's answers a row each on one grid, what runs after the takeover a line per origin, one ready
 * task's warning said of one, and the pairs, where they come from and the tasks in the keys' reach.
 */

const RUN = '01M5GS3GZRK7Q2W8E4R6T9Y1U3';
const ATTEMPT = '01M5GS9K2PAAAAAAAAAAAAAAAA';
/** A second attempt that passed: one call of one run has one answer. */
const AGAIN = '01M5GSB4XQBBBBBBBBBBBBBBBB';

function view(o: { best?: boolean; ready?: number } = {}): TrainingView {
  const ready = o.ready ?? 1;
  return {
    strip: {
      pairs: { value: '3', sub: '2 high confidence · 1 medium', high: 2, medium: 1 },
      tasks: { value: `${ready} / 3`, sub: '1 blocked · 1 not a task', ready, total: 3, blocked: 1, notTask: 1 },
      best: o.best === false ? { value: '—', sub: 'no model scored yet', model: null, mean: null } : { value: '0.67', sub: 'claude-haiku-4-5 · 1 model scored', model: 'claude-haiku-4-5', mean: 0.67 },
      left: { value: '0', sub: 'nothing exported yet', pairs: 0, file: null, at: null },
    },
    tabs: { pairs: 3, tasks: ready },
    actions: { exportPairs: true, scoreModel: true },
    pairs: {
      counts: { all: 3, high: 2, medium: 1 },
      groups: [
        {
          key: 'g1',
          confidence: 'high',
          runId: RUN,
          callNo: 5,
          href: `#/run/${RUN}/5`,
          about: RUN,
          attemptOf: null,
          fix: { label: 'refund-bug', href: '#/fixes/f1/blame' },
          source: { key: 'blame', kind: 'blame', label: 'Blame', href: '#/fixes' },
          from: 'from blame',
          count: 2,
          context: 'read_policy returned the refund limit',
          rejected: { text: 'issue_refund({"amount":240})', what: 'the recording', runId: RUN, callNo: 5, href: `#/run/${RUN}/5` },
          chosen: [
            { text: 'escalate({"reason":"above the limit"})', what: 'blame attempt, passed', runId: ATTEMPT, callNo: 5, href: `#/run/${ATTEMPT}/5` },
            { text: 'escalate({"reason":"needs approval"})', what: 'blame attempt, passed', runId: AGAIN, callNo: 5, href: `#/run/${AGAIN}/5` },
          ],
          ids: ['p1', 'p2'],
        },
      ],
      sources: [
        { key: 'blame', kind: 'blame', label: 'Blame', href: '#/fixes', made: 2, confidence: 'high', why: 'the answer it was lost on, and one that passed' },
        { key: 'verify', kind: 'verify', label: 'Verify', href: '#/fixes', made: 0, confidence: null, why: 'attempts that verified a fix' },
      ],
      confidence: [
        { level: 'high', title: 'Blame asked this call again, and the run passed.', sub: 'This answer decided the run.' },
        { level: 'medium', title: 'A passing and a failing attempt first differ here.', sub: 'Nothing checked that this answer decided the run.' },
      ],
      footnote: 'Identical answers count once.',
      empty: null,
    },
    tasks: {
      error: null,
      empty: null,
      weak: null,
      warning: { rewards: 'escalating', name: null, once: null, fix: null },
      rows: [
        {
          golden: 'goldens/refund-bug',
          name: 'refund-bug',
          href: `#/run/${RUN}/5`,
          opens: null,
          sub: 'takes over at #5',
          checks: ['tools.escalate ≥ 1'],
          after: { live: ['read_policy', 'lookup_order', 'list_orders', 'get_customer', 'get_invoice'], stubbed: ['issue_refund'] },
          status: { key: 'ready', label: 'ready', badge: 'ok', short: null },
          update: null,
        },
        { golden: 'goldens/list-inbox', name: 'list-inbox', href: null, opens: null, sub: 'no call to take over', checks: [], after: null, status: { key: 'not-a-task', label: 'not a task', badge: 'n', short: 'no call to take over' }, update: null },
      ],
    },
    scores: { sub: 'mean share of checks passed, 1 task', empty: 'No scores yet.', cards: [], rows: [], footnote: 'Each attempt replays the golden.' },
    serve: null,
  } as unknown as TrainingView;
}

function app(v: TrainingView, runs?: unknown[]): AppState {
  const never = () => new Promise<never>(() => undefined);
  return {
    client: { training: async () => v, models: never, jobs: async () => [] },
    meta: { project: { id: 'support-agent', name: 'support-agent', path: '/work/support-agent' } },
    runs,
    exported: false,
    tick: 0,
    feeds: {},
    jobs: [],
    actionsOff: null,
    hasKind: () => true,
    guard: (fn: () => void) => fn(),
    watchJob: () => undefined,
    toast: () => undefined,
  } as unknown as AppState;
}

const page = (value: AppState, tab: 'pairs' | 'tasks') => render(createElement(AppContext.Provider, { value }, createElement(TrainingPage, { tab })));
const texts = (r: Rendered, selector: string) => r.all(selector).map((el) => el.textContent);
/** A verdict glues its last words with no-break spaces: read as plain spaces. */
const plain = (t: string) => t.replace(/\s+/g, ' ');

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
});

describe('Training’s facts', () => {
  it('are the pairs, the tasks ready of all, the best mean score once one is scored, and what was exported, last and quieter', () => {
    const facts = trainingFacts(view());
    expect(facts.map((f) => [f.value, f.words, f.money ?? false])).toEqual([
      ['3', 'pairs', false],
      ['1', 'of 3 tasks ready', false],
      ['0.67', 'best mean score', false],
      ['0', 'exported', true],
    ]);
    expect(facts.map((f) => f.tip)).toEqual([
      { title: '3 pairs', parts: ['2 high confidence · 1 medium'] },
      { title: '1 of 3 tasks ready', parts: ['1 blocked · 1 not a task'] },
      { title: 'Best mean score', parts: ['claude-haiku-4-5 · 1 model scored'] },
      { title: 'Exported', parts: ['nothing exported yet'] },
    ]);
    // No best score until a model is scored: the fact is left out, never a dash.
    expect(trainingFacts(view({ best: false })).map((f) => f.words)).toEqual(['pairs', 'of 3 tasks ready', 'exported']);
  });

  it('show under the header with the project in the eyebrow, and neither they nor the tabs’ counts show with no runs yet', async () => {
    r = await page(app(view()), 'pairs');
    await r.until('the page', () => r!.all('.pgroup').length > 0);
    expect(r.one('.ph .eyebrow').textContent).toBe('support-agent · training data');
    expect(texts(r, '.pfacts .metric')).toEqual(['3pairs', '1of 3 tasks ready', '0.67best mean score', '0exported']);
    expect(texts(r, '.stabs a')).toEqual(['Pairs 3', 'Tasks 1']);
    await r.unmount();
    r = await page(app(view(), []), 'pairs');
    await r.until('the page', () => r!.all('.pgroup').length > 0);
    expect(r.all('.pfacts')).toHaveLength(0);
    expect(texts(r, '.stabs a')).toEqual(['Pairs', 'Tasks']);
  });
});

describe('Training → Pairs', () => {
  it('has no heading to repeat the tab, chips with their counts, and confidence in words, never a badge', async () => {
    r = await page(app(view()), 'pairs');
    await r.until('the page', () => r!.all('.pgroup').length > 0);
    const pairs = r.one('section.pairsec');
    expect(pairs.querySelector('h2')).toBeNull();
    expect(r.all('.pairsec .chips button').map((b) => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([
      ['All 3', 'true'],
      ['High 2', 'false'],
      ['Medium 1', 'false'],
    ]);
    expect(r.one('.pg1 .pgsrc').textContent).toBe('from blame · high confidence');
    expect(texts(r, '.srcs .conf')).toEqual(['high']);
    expect(texts(r, '.lrows .ct')).toEqual(['High', 'Medium']);
    expect(r.all('.badge')).toHaveLength(0);
    expect(texts(r, '.grid2.secs > section.panel.sec > header h2')).toEqual(['Where they come from', 'Confidence']);
  });

  it('lays a pair out as rows on one grid: its label in words, the answer, and what it was with its attempt at the end', async () => {
    r = await page(app(view()), 'pairs');
    await r.until('the page', () => r!.all('.pgroup').length > 0);
    const rows = r.all('.pans .pa');
    expect(rows.map((row) => row.className)).toEqual(['pa rej', 'pa cho', 'pa cho']);
    expect(rows.map((row) => row.querySelector('.pak')!.textContent)).toEqual(['Rejected', 'Chosen', '']);
    expect(rows.map((row) => row.querySelector('.paw')!.textContent)).toEqual(['the recording', 'blame attempt, passed · 01M5GS9K2P', 'blame attempt, passed · 01M5GSB4XQ']);
    expect(r.one('.pg1 .prun').textContent).toBe('01M5GS3GZR#5');
  });

  it('puts the pairs and where they come from in the keys’ reach, a row each', async () => {
    r = await page(app(view()), 'pairs');
    await r.until('the page', () => r!.all('.pgroup').length > 0);
    expect(r.all('.pgroups .pgroup').map((g) => g.getAttribute('data-rowkey'))).toEqual(['g1']);
    expect(r.all('.srcs > a').map((a) => a.getAttribute('data-rowkey'))).toEqual(['blame', 'verify']);
  });
});

describe('Training → Tasks', () => {
  it('says one ready task rewards one thing, as a verdict line with its word first', async () => {
    r = await page(app(view()), 'tasks');
    await r.until('the page', () => r!.all('table.tasks').length > 0);
    expect(r.one('.verdict .vw').textContent).toBe('one-sided');
    expect(plain(r.one('.verdict h2').textContent)).toBe('one-sided The one ready task rewards one thing');
    expect(plain(r.one('.verdict p').textContent)).toBe('It rewards “escalating”, so a model that learned only that would score full marks.');
    await r.unmount();
    r = await page(app(view({ ready: 2 })), 'tasks');
    await r.until('the page', () => r!.all('table.tasks').length > 0);
    expect(plain(r.one('.verdict h2').textContent)).toBe('one-sided Every ready task rewards the same thing');
    expect(plain(r.one('.verdict p').textContent)).toBe('All of them reward “escalating”, so a model that learned only that would score full marks.');
  });

  it('says what runs after the takeover a line per origin, three names and how many more past four, and the status in words', async () => {
    r = await page(app(view()), 'tasks');
    await r.until('the page', () => r!.all('table.tasks').length > 0);
    const lines = r.all('td.tko .tkol');
    // Each its origin's word first. Stubbed is a glossary term, defined on hover and focus, as the design has it; live says itself.
    expect(lines.map((l) => l.querySelector('.tkk .org')!.className)).toEqual(['org live', 'org stub']);
    expect([lines[0].querySelector('.tkk')!.textContent, lines[0].querySelector('.tkk .term')]).toEqual(['live', null]);
    const stubbed = lines[1].querySelector('.tkk .org .term')!;
    expect([stubbed.textContent, stubbed.getAttribute('data-term'), stubbed.getAttribute('tabindex')]).toEqual(['stubbed', 'stubbed', '0']);
    expect(lines[0].querySelector('.tkn')!.textContent).toBe('read_policy, lookup_order, list_orders +2 more: get_customer, get_invoice');
    expect(JSON.parse(lines[0].querySelector('.tkm')!.getAttribute('data-tip')!)).toMatchObject({ t: '5 tools live', s: 'read_policy, lookup_order, list_orders, get_customer, get_invoice' });
    expect(lines[1].querySelector('.tkn')!.textContent).toBe('issue_refund');
    expect(texts(r, 'table.tasks tbody .st')).toEqual(['ready', 'not a task']);
    expect(r.all('table.tasks tbody tr').map((tr) => tr.getAttribute('data-rowkey'))).toEqual(['goldens/refund-bug', 'goldens/list-inbox']);
    expect(texts(r, 'section.panel.sec > header h2')).toEqual(['Tasks', 'Scores', 'From a training loop', 'What a score can’t tell you']);
  });
});
