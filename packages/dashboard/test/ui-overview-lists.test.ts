import { act, createElement, type ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetLookMemory } from '../ui/overview/dismissed.js';
import { NeedsLook } from '../ui/overview/NeedsLook.js';
import { Usage } from '../ui/overview/Usage.js';
import { resetSpending } from '../ui/spending.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { NeedsLookRow, OverviewSummary } from '../ui/types.js';
import { render, type Rendered } from './ui-render.js';

/**
 * The Overview's Usage folds until asked for, and Needs a look shows every item under its group's
 * head, each row ending on its step, which runs from the row, or Open where nothing runs.
 */

const app = (actionsOff: string | null = null) => ({ actionsOff, exported: false, meta: null }) as unknown as AppState;
const inApp = (el: ReactElement, actionsOff: string | null = null) => createElement(AppContext.Provider, { value: app(actionsOff) }, el);
const text = (el: { textContent: string }) => el.textContent.replace(/\s+/g, ' ').trim();

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
  vi.unstubAllGlobals();
  resetLookMemory();
});

describe('the Overview’s Usage', () => {
  const summary = {
    sums: { week: { calls: 2785, runs: 28, origins: { r: 1030, l: 1755 } } },
    cache: { readShare: 0.87, input: 1000, cacheRead: 870, misses: [], sentAgain: 0 },
    outcomes: { spent: { value: 16.24 } },
    daily: [
      { day: '2026-10-13', start: 0, spent: 1, notRespent: 0.5 },
      { day: '2026-10-14', start: 0, spent: 2, notRespent: 1.72 },
    ],
    today: { served: 1034, notRespent: 1.72 },
  } as unknown as OverviewSummary;

  it('folds until asked for, its figures on its heading’s line, and stays open for the session', async () => {
    // The session's storage, as a browser keeps it for the tab.
    const kept = new Map<string, string>();
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) });
    r = await render(inApp(createElement(Usage, { s: summary })));
    expect(text(r.all('.ovuse > header .sub')[0])).toBe('2,785 calls in 28 runs · 37% replayed · 87% of input from the cache · $16.24 spent live this week');
    // Each figure whole, its dot kept with it: a phone's wrapped line breaks only after a dot, never starting on one.
    expect(r.all('.ovuse > header .sub')[0].textContent.split(' ').map((p) => p.endsWith('\u00a0·'))).toEqual([true, true, true, false]);
    const show = r.all('.ovuse .linkbtn')[0];
    expect([text(show), show.getAttribute('aria-expanded')]).toEqual(['Show', 'false']);
    expect(r.all('.ugrid')).toHaveLength(0);
    await r.click(show);
    expect(r.all('.ugrid .upart h3').map(text)).toEqual(['Calls by origin', 'Prompt cache', 'Spend per day']);
    expect(r.all('.ovuse .linkbtn')[0].getAttribute('aria-expanded')).toBe('true');
    expect(text(r.all('.ovuse > .leaknote')[0])).toBe('Today 1,034 calls were served from recordings: $1.72 not re-spent.');
    expect(kept.get('shadowlap-overview-usage')).toBe('open');
    // A day after the first in the same month keeps its month for a phone to hide.
    expect(r.all('.xlabels > span').map(text)).toEqual(['Oct 13', 'Oct 14']);
    expect(r.all('.xlabels .xm')).toHaveLength(1);
    // Opened once, it opens open for the rest of the session.
    await r.unmount();
    r = await render(inApp(createElement(Usage, { s: summary })));
    expect(r.all('.ugrid .upart')).toHaveLength(3);
  });

  it('names the run of each call where the cache stopped hitting by its id, its about line on hover, and the model only where the dashboard hasn’t listed the run', async () => {
    vi.stubGlobal('sessionStorage', { getItem: () => 'open', setItem: () => undefined, removeItem: () => undefined });
    const misses = [
      { runId: '01M5GRZNA5QJ8V2W3X4Y5Z6A7B', kind: 'recording', callNo: 17, scope: 'triage', model: 'sonnet-5', tokens: 8200 },
      { runId: '01M5GS3KT0QJ8V2W3X4Y5Z6A7B', kind: 'fork', callNo: 4, scope: null, model: 'sonnet-5', tokens: 3100 },
    ];
    const s = { ...summary, cache: { ...summary.cache, misses, sentAgain: 11300 } } as unknown as OverviewSummary;
    const runs = [{ runId: misses[0].runId, about: { text: 'My blender arrived broken' } }];
    r = await render(createElement(AppContext.Provider, { value: { ...app(), runs } as unknown as AppState }, createElement(Usage, { s })));
    const rows = r.all('.leaks > a');
    // The id as a list draws it, its first characters quieter; the row's own hover only where the id has none.
    expect(rows.map((a) => [text(a.querySelector('code.rnm.rl')!), a.querySelector('code')!.getAttribute('title'), a.getAttribute('title'), a.querySelectorAll('span').map(text).filter(Boolean).join()])).toEqual([
      ['01M5GRZNA5', 'My blender arrived broken', null, '#17 · triage'],
      ['01M5GS3KT0', null, 'sonnet-5 · 3,100 tokens sent again', '#4'],
    ]);
    expect(rows.map((a) => a.getAttribute('href'))).toEqual(['#/run/01M5GRZNA5QJ8V2W3X4Y5Z6A7B/17/context', '#/run/01M5GS3KT0QJ8V2W3X4Y5Z6A7B/4/context']);
  });
});

describe('Needs a look', () => {
  const run = '01M5H2F2QC9NCJ5PSZ0M4RX7VP';
  const rows: NeedsLookRow[] = [
    { kind: 'test', icon: 'fail', title: 'A golden failed: refund-in-limit', name: 'refund-in-limit', detail: 'diverged at call 3', key: 'attn:failed:goldens/refund-in-limit', group: 'failing', step: null, href: '#/run/01M5H2EWWY8P621C63CJPVEM4A', runId: '01M5H2EWWY8P621C63CJPVEM4A', fixId: null, at: 3 },
    { kind: 'unblamed', icon: 'fail', title: '1 failing run nobody has blamed', detail: '01M5H2F2QC · failed', key: `attn:unblamed:${run}`, group: 'failing', step: { of: 'run', runId: run, step: { key: 'blame', label: 'Run blame', offer: { failed: [], from: 'config' } } as never }, href: '#/runs?types=failed', runId: run, fixId: null, at: 2 },
    { kind: 'local', icon: 'rec', title: '12 runs are only on this machine', detail: 'push them so the team can open them', key: 'attn:local', group: 'housekeeping', step: { of: 'push', label: 'Push local runs', command: 'shadowlap push --all' }, href: '#/runs?types=local', runId: null, fixId: null, at: 0 },
  ];
  // A dashboard that runs jobs: the server's jobs, read once for the section, and what a step's start asks of it.
  const running = (client: Record<string, unknown>) =>
    ({ actionsOff: null, exported: false, meta: null, conn: 'online', jobs: [], feeds: {}, runs: [{ runId: run, about: { text: 'Write this week’s refund digest', from: 'user' } }], hasKind: () => true, guard: (fn: () => void) => (fn(), true), toast: () => undefined, watchJob: () => undefined, client }) as unknown as AppState;
  const within = (value: AppState, el: ReactElement) => createElement(AppContext.Provider, { value }, el);

  it('shows every item under its group’s head, each row ending on its step, and Open for a job where nothing runs', async () => {
    const jobs = vi.fn(async () => []);
    r = await render(within(running({ jobs }), createElement(NeedsLook, { items: rows, total: 3 })));
    expect(r.all('.ovattn > header .sub').map(text)).toEqual(['3']);
    // Each group's head says its count, quietly, beside it.
    expect(r.all('.agrp').map(text)).toEqual(['Failing2', 'Housekeeping1']);
    expect(r.all('.agrp span').map(text)).toEqual(['2', '1']);
    // Each row keeps its key for the keys and the job's way back, its group, and an empty last column for Dismiss.
    expect(r.all('.arow').map((x) => [x.getAttribute('data-rowkey'), x.getAttribute('data-agrp')])).toEqual(rows.map((x) => [x.key, x.group]));
    expect(r.all('.arow .adx').map(text)).toEqual(['', '', '']);
    expect(r.all('.arow a.at').map((a) => a.getAttribute('href'))).toEqual(rows.map((x) => x.href));
    // A step is small and plain, never lime; a row with none opens what it is about.
    expect(r.all('.arow .ast').map(text)).toEqual(['Open →', 'Run blame', 'Push local runs']);
    expect(r.all('.arow .ast .btn').map((b) => b.className)).toEqual(['btn sm', 'btn sm']);
    // The run a row names is its id, with its about line on hover.
    expect(r.all('.arow .d code.rnm').map((c) => [text(c), c.getAttribute('title')])).toEqual([['01M5H2F2QC', 'Write this week’s refund digest']]);
    // One read of the server's jobs, for every row's step.
    expect(jobs).toHaveBeenCalledTimes(1);
    await r.unmount();
    r = await render(inApp(createElement(NeedsLook, { items: rows, total: 3 }), 'This dashboard is read-only: it was started with --read-only.'));
    expect(r.all('.arow .ast').map(text)).toEqual(['Open →', 'Open →', 'Open →']);
    await r.unmount();
    r = await render(inApp(createElement(NeedsLook, { items: [], total: 0 })));
    expect(r.all('.ovattn .emptyline').map(text)).toEqual(['Nothing needs a look.']);
  });

  it('ends a group on what was dismissed from it, folded under Dismissed (n), each row muted with Restore once opened', async () => {
    const away: NeedsLookRow = { ...rows[2], step: null, advice: { key: 'local', facts: ['01M5H2EWWY8P621C63CJPVEM4A'], until: 'Until another run is only on this machine', dismissed: true } };
    r = await render(inApp(createElement(NeedsLook, { items: [rows[0], away], total: 1 })));
    expect([r.all('.arow').map((x) => x.getAttribute('data-rowkey')), r.all('.agrp').map(text)]).toEqual([[rows[0].key], ['Failing1', 'Housekeeping']]);
    const fold = r.one('.aoff .linkbtn');
    expect([text(fold), fold.getAttribute('aria-expanded')]).toEqual(['Dismissed (1)', 'false']);
    await r.click(fold);
    expect(r.all('.arow.off').map((x) => [x.getAttribute('data-rowkey'), text(x.querySelector('.ast')!)])).toEqual([[away.key, 'Restore']]);
    expect(r.all('.arow .adis')).toEqual([]);
  });

  it('asks for a step’s price only once the step is reached, and a press before it came waits for it', async () => {
    const more = { args: ['test', 'goldens/refund.json', '--max-attempts', '160', '--continue'], job: { golden: 'goldens/refund.json', maxAttempts: 160, continue: true as const }, attempts: 160, most: 80, expected: 27, settles: 0.93, cost: null };
    const row: NeedsLookRow = { kind: 'test', icon: 'warn', title: 'A golden is inconclusive: refund', name: 'refund', detail: 'inconclusive · 80 of 80 attempts', key: 'attn:inconclusive:goldens/refund.json', group: 'tests', step: { of: 'more', golden: 'goldens/refund.json', label: 'Run more attempts', more }, href: '#/tests', runId: null, fixId: null, at: 0 };
    let priced: (v: unknown) => void = () => undefined;
    const testsEstimates = vi.fn(() => new Promise((res) => (priced = res)));
    const startJob = vi.fn(async () => ({ id: 'job-1' }));
    r = await render(within(running({ jobs: async () => [], startJob, estimates: { testsEstimates } }), createElement(NeedsLook, { items: [row], total: 1 })));
    expect(testsEstimates).not.toHaveBeenCalled();
    const step = r.one('.arow .ast .btn');
    expect(JSON.parse(step.getAttribute('data-tip')!).s).toBe('Raises its limit to 160 for this session only and carries its 80 attempts over. That settles it 93% of the time, in about 27 more.');
    await r.click(step);
    expect(testsEstimates).toHaveBeenCalledTimes(1);
    expect(startJob).not.toHaveBeenCalled();
    await act(async () => priced({ run: null, goldens: { 'goldens/refund.json': { rerun: null, update: null, more: { kind: 'tests', usd: 0.42, ceiling: 0.6, parts: [] } } } }));
    expect(startJob).toHaveBeenCalledWith('test', { golden: 'goldens/refund.json', maxAttempts: 160, continue: true, estimate: { usd: 0.42, ceiling: 0.6 } });
  });

  it('starts Run blame, pressed before its price came, once the price comes and with it', async () => {
    // No threshold: a priced job starts on its press.
    resetSpending(null);
    try {
      let priced: (v: unknown) => void = () => undefined;
      const nextStep = vi.fn(() => new Promise((res) => (priced = res)));
      const startJob = vi.fn(async () => ({ id: 'job-1' }));
      r = await render(within(running({ jobs: async () => [], startJob, nextStep }), createElement(NeedsLook, { items: [rows[1]], total: 1 })));
      await r.click(r.one('.arow .ast .btn'));
      expect(nextStep).toHaveBeenCalledWith(run);
      expect(startJob).not.toHaveBeenCalled();
      expect(r.all('[role="dialog"]')).toEqual([]);
      await act(async () => priced({ next: { key: 'blame', estimate: { kind: 'blame', usd: 0.42, ceiling: 0.6, parts: [] } } }));
      expect(startJob).toHaveBeenCalledWith('blame', { runId: run, estimate: { usd: 0.42, ceiling: 0.6 } });
    } finally {
      resetSpending();
    }
  });

  describe('Find breaking commit…', () => {
    const bisect: NeedsLookRow = { kind: 'test', icon: 'fail', title: 'A golden failed: refund-in-limit', name: 'refund-in-limit', detail: 'exited with code 1', key: 'attn:failed:goldens/refund-in-limit', group: 'failing', step: { of: 'run', runId: run, step: { key: 'bisect', label: 'Find breaking commit…', starts: false } as never }, href: '#/tests', runId: run, fixId: null, at: 3 };

    it('asks for the commit to start from in its dialog where the run offers no range, as the run’s page does', async () => {
      const client = { jobs: async () => [], nextStep: async () => ({ next: null }), offers: async () => ({ bisect: null }) };
      r = await render(within(running(client), createElement(NeedsLook, { items: [bisect], total: 1 })));
      await r.click(r.one('.arow .ast .btn'));
      await r.until('its dialog', () => r!.all('[role="dialog"]').length === 1);
      expect(r.one('[role="dialog"]').textContent).toContain('Find breaking commit');
    });

    it('says why where the run’s offers can’t be read, and asks nothing', async () => {
      const toast = vi.fn();
      const client = { jobs: async () => [], nextStep: async () => ({ next: null }), offers: async () => Promise.reject(new Error('the server is gone')) };
      r = await render(within({ ...running(client), toast }, createElement(NeedsLook, { items: [bisect], total: 1 })));
      await r.click(r.one('.arow .ast .btn'));
      await r.until('the toast', () => toast.mock.calls.length === 1);
      expect(toast).toHaveBeenCalledWith('The server is gone', 'error');
      expect(r.all('[role="dialog"]')).toEqual([]);
    });
  });

  it('shows a row for each failing golden one fix holds, all of them, with no two keys alike', async () => {
    // One regression failed three goldens on the same check, and blame joined their runs into one fix.
    const fixId = 'fx-01M5H2DV7NHAEH1GM5ARZXX3BG';
    const held: NeedsLookRow[] = ['refund-in-limit', 'refund-over-limit', 'refund-partial'].map((name, i) => ({ kind: 'test', icon: 'fail', title: `A golden failed: ${name}`, name, detail: 'check failed: issue_refund called 1 time', key: `attn:failed:goldens/${name}`, group: 'failing', step: null, href: `#/fixes/${fixId}`, runId: `01M5H2DV7NHAEH1GM5ARZXX3B${i}`, fixId, at: 3 - i }));
    const open: NeedsLookRow = { kind: 'open', icon: 'blame', title: 'Refunds above the limit issued without approval', detail: 'lost at model call #5 · no fix yet', key: `attn:fix:#/fixes/${fixId}`, group: 'failing', step: null, href: `#/fixes/${fixId}`, runId: null, fixId, at: 0 };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      r = await render(inApp(createElement(NeedsLook, { items: [...held, open], total: 4 })));
      expect(r.all('.arow .t').map((t) => text(t).replace(/\u00a0/g, ' '))).toEqual(['A golden failed: refund-in-limit', 'A golden failed: refund-over-limit', 'A golden failed: refund-partial', 'Refunds above the limit issued without approval']);
      // A golden's name keeps its hyphens: it never breaks inside.
      expect(r.all('.arow .t .nw').map(text)).toEqual(['refund-in-limit', 'refund-over-limit', 'refund-partial']);
      expect(r.all('.attn-more')).toHaveLength(0);
      expect(errors.mock.calls.map((c) => c.map(String).join(' ')).filter((m) => /same key/.test(m))).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });
});
