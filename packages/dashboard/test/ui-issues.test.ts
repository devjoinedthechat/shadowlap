import { createElement, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NO_COMMAND, Store } from '@shadowlap/engine';
import { ISSUES_READS } from '../src/issues.js';
import type { NextStepWork } from '../src/next-step.js';
import { unblamedBlameCard } from '../src/unblamed-words.js';
import type { Client } from '../ui/api.js';
import { ISSUE_ASK } from '../ui/page-ask.js';
import { RevertDialog } from '../ui/revert/RevertDialog.js';
import { FailedIssues } from '../ui/runspage/FailedIssues.js';
import { ServedPartsContext } from '../ui/served-parts.js';
import { AppContext, type AppState } from '../ui/state.js';
import { crashFixtures, GOLDEN, MIN, source, T0, work } from './crash-fixtures.js';
import { addRun } from './read-model-store.js';
import { render, shownText, type FakeElement, type Rendered } from './ui-render.js';
import { OPEN_ISSUES } from '../src/issue-keys.js';
import { countName, issueGlyph, issueHref, issuesEmpty, issuesShown, lineParts, openAsked } from '../ui/runspage/issues.js';
import { shownWarming } from '../ui/runspage/rows.js';
import type { Issue, IssueRun, IssueRunsPage, IssuesPage } from '../ui/types.js';

/**
 * Runs › Failed as issues, as the page words them (ui/runspage/issues.ts): where each title goes, its
 * icon, the line under it, its count's name, the empty lines, what a waiting delete leaves of them,
 * the issues a read asks for with their runs, and the verdicts' warming line, which only Failed and
 * `status:` wait on.
 */

const run = (runId: string, startedAt: number, o: Partial<IssueRun> = {}): IssueRun => ({ runId, startedAt, about: null, command: 'python refund_agent.py', ...o }) as IssueRun;

function issue(o: Partial<Issue> = {}): Issue {
  const runs = o.runs ?? [run('01K8RG000000000000000000A2', 2_000), run('01K8RG000000000000000000A1', 1_000)];
  return {
    key: 'fail:cost at most $0.05',
    kind: 'failure',
    title: 'cost at most $0.05, but cost $0.07',
    golden: null,
    failed: 'cost at most $0.05, but cost $0.07',
    detail: null,
    planted: null,
    lost: null,
    blame: 'not blamed yet',
    production: 0,
    count: runs.length,
    first: runs.at(-1)!.startedAt,
    last: runs[0].startedAt,
    newest: { runId: runs[0].runId, about: null },
    runs,
    more: null,
    fix: null,
    notBlamed: 0,
    step: null,
    stepRun: runs[0].runId,
    ...o,
  };
}

/** An issue as a read carries one that isn't shown open: its count alone. */
const closed = (o: Partial<Issue> = {}): Issue => issue({ runs: null, more: null, ...o });

const FIX = { fixId: 'fx-01K8RG0000000000000000000A', title: 'Refunds above the limit issued without approval', rung: 'open' as const, pr: null, broken: null, status: 'open' as const };

describe('an issue’s title, icon and line', () => {
  it('goes to its fix, to Tests for a golden’s, else to its newest run', () => {
    expect(issueHref(issue({ fix: FIX }))).toBe('#/fixes/fx-01K8RG0000000000000000000A');
    expect(issueHref(issue({ golden: { path: 'goldens/refund-in-limit', name: 'refund-in-limit', did: 'diverged at call 1', passed: false } }))).toBe('#/tests');
    expect(issueHref(issue())).toBe('#/run/01K8RG000000000000000000A2');
  });

  it('shows an imported capture’s icon only where every run under it is one', () => {
    expect(issueGlyph({ production: 2, count: 2 })).toEqual({ kind: 'cap', label: 'Imported capture' });
    expect(issueGlyph({ production: 1, count: 2 })).toEqual({ kind: 'fail', label: 'Failed' });
  });

  it('says what failed for a fix or a planted issue, how the rest were judged, and that nobody has blamed a failure yet', () => {
    const first = (i: Issue) => lineParts(i)[0];
    expect(first(issue({ kind: 'fix', fix: FIX }))).toEqual({ kind: 'failed', text: 'Failed: cost at most $0.05, but cost $0.07', failed: 'cost at most $0.05, but cost $0.07' });
    expect(first(issue({ kind: 'capture', blame: null }))).toEqual({ kind: 'words', text: 'judged when it was imported' });
    // Its last four words kept on one line where the line wraps.
    expect(first(issue({ kind: 'today' }))).toEqual({ kind: 'words', text: 'judged\u00a0from\u00a0the\u00a0recording' });
    // By its newest run's verdict, which a closed issue carries without its runs.
    const today = closed({ kind: 'today', count: 1, newest: { runId: '01K8RG000000000000000000T1', about: null, today: true } });
    expect(first(today)).toEqual({ kind: 'words', text: 'by today’s checks, judged\u00a0from\u00a0the\u00a0recording' });
    expect(first(issue())).toEqual({ kind: 'words', text: 'not blamed yet' });
    // A golden's path set as code, then what the value looks like, in Tests' words.
    expect(first(issue({ kind: 'test', detail: { code: '$.metadata.user_id', text: 'looks like a UUID' } }))).toEqual({ kind: 'detail', text: '$.metadata.user_id looks like a UUID', code: '$.metadata.user_id', words: 'looks like a UUID' });
  });

  it('then where it was planted or lost, how many of a fix’s runs came from production, and its newest run', () => {
    const rest = (i: Issue) => lineParts(i).slice(1).map((p) => p.text);
    expect(rest(issue({ kind: 'planted', planted: 'planted in #2 lookup_order’s result', blame: null }))).toEqual(['planted in #2 lookup_order’s result', 'newest 01K8RG0000']);
    expect(rest(issue({ kind: 'fix', fix: FIX, lost: 'lost at model call #9', production: 1, blame: null }))).toEqual(['lost at model call #9', '1 from production', 'newest 01K8RG0000']);
    // A capture's says how its import judged it, and nothing of blame, as the design's does.
    expect(lineParts(issue({ kind: 'capture', production: 2, blame: null })).map((p) => p.text)).toEqual(['judged when it was imported', 'newest 01K8RG0000']);
  });

  it('names its count as it shows or hides its runs', () => {
    expect(countName(4, false)).toBe('Show its 4 runs');
    expect(countName(1, true)).toBe('Hide its 1 run');
  });
});

describe('Failed with no issue, and a delete that waits', () => {
  it('says no failed run matches the words, or the days, else that none has failed', () => {
    expect(issuesEmpty({ q: 'refund', days: true })).toBe('No failed runs match.');
    expect(issuesEmpty({ q: ' ', days: true })).toBe('No failed runs on the days picked.');
    expect(issuesEmpty({ q: '', days: false })).toBe('No run has failed.');
  });

  it('leaves out the runs a delete waits to take, and an issue with none left', () => {
    const a = issue();
    const b = issue({ key: 'fail:other', runs: [run('01K8RG000000000000000000B1', 500)] });
    const page: IssuesPage = { issues: [a, b], total: 3 };
    const less = issuesShown(page, new Set(['01K8RG000000000000000000A2', '01K8RG000000000000000000B1']), new Map());
    expect(less.total).toBe(1);
    expect(less.issues.map((x) => x.key)).toEqual([a.key]);
    expect(less.issues[0]).toMatchObject({ count: 1, last: 1_000, newest: { runId: '01K8RG000000000000000000A1' } });
    expect(issuesShown(page, new Set(), new Map())).toBe(page);
  });

  it('takes a closed issue of one run with it, and leaves a bigger one the count its read gave, of whose runs it knows only the newest', () => {
    const one = closed({ key: 'fail:one', count: 1, newest: { runId: '01K8RG000000000000000000B1', about: null } });
    const two = closed({ key: 'fail:two' });
    const less = issuesShown({ issues: [two, one], total: 3 }, new Set(['01K8RG000000000000000000A2', '01K8RG000000000000000000B1']), new Map());
    expect(less.issues.map((x) => [x.key, x.count, x.runs])).toEqual([[two.key, 2, null]]);
    expect(less.total).toBe(2);
  });
});

describe('the issues a read carries the runs of', () => {
  it('are those shown open, the last opened first, as many as the server answers and the address holds', () => {
    expect(openAsked(new Set(['fix:a', 'fail:b']))).toEqual(['fail:b', 'fix:a']);
    const many = Array.from({ length: OPEN_ISSUES + 3 }, (_, i) => `fail:issue ${i}`);
    expect(openAsked(many)).toEqual(many.slice(3).reverse());
    expect(OPEN_ISSUES).toBe(20);
    // A key past what the address holds is asked for on its own.
    expect(openAsked(['fail:a', `fail:${'x'.repeat(4_000)}`, 'fail:c'])).toEqual(['fail:c', 'fail:a']);
  });
});

describe('the verdicts still being worked out', () => {
  const w = { done: 60, total: 200, what: 'verdicts' as const };
  it('are said under Failed, which counts by them, and with status:, but under no other chip', () => {
    expect(shownWarming(w, { chip: 'failed', q: '' })).toBe(w);
    expect(shownWarming(w, { chip: 'all', q: 'status:failed' })).toBe(w);
    expect(shownWarming(w, { chip: 'all', q: 'refund' })).toBeNull();
    const about = { done: 1, total: 2 };
    expect(shownWarming(about, { chip: 'all', q: 'refund' })).toBe(about);
  });
});

describe('Failed’s issues, drawn', () => {
  let r: Rendered | null = null;
  afterEach(async () => {
    await r?.unmount();
    r = null;
    vi.unstubAllGlobals();
  });
  const app = (client: Client) => ({ client, exported: false, meta: null, tick: 0, runsTick: 0, feeds: {}, actionsOff: null, hasKind: () => false, guard: (fn: () => void) => fn(), watchJob: () => undefined, toast: () => undefined, refresh: () => undefined }) as unknown as AppState;
  /** Failed's issues drawn from `page`, each closed one's runs answered from `runs`; `before` runs once the page is up and before the issues come, as a link's ask does. */
  const draw = async (page: IssuesPage, o: { q?: string; before?: () => void; runs?: Record<string, IssueRun[]> } = {}) => {
    let answer: (p: IssuesPage) => void = () => undefined;
    const asked = new Promise<IssuesPage>((resolve) => (answer = resolve));
    const issueRuns = (key: string): Promise<IssueRunsPage> => Promise.resolve({ runs: o.runs?.[key] ?? [], more: null, count: o.runs?.[key]?.length ?? 0 });
    const client = { exported: false, runsIssues: () => asked, issueRuns, jobs: () => Promise.resolve([]) } as unknown as Client;
    r = await render(createElement(AppContext.Provider, { value: app(client) }, createElement(FailedIssues, { query: { q: o.q ?? '' }, refresh: '0', scrollKey: '#/runs?types=failed', above: true })));
    o.before?.();
    answer(page);
    await r.until('the issues', () => r!.all('table.issues').length + r!.all('.emptyline').length > 0);
    return r;
  };

  it('draws each issue a row whose count shows its runs, and opens the issue a link asked for, its runs shown', async () => {
    vi.stubGlobal('requestAnimationFrame', (f: () => void) => (f(), 0));
    vi.stubGlobal('CSS', { escape: (x: string) => x });
    // Each closed, as the read carries them: their runs come as each opens.
    const fix = closed({ key: `fix:${FIX.fixId}`, kind: 'fix', title: FIX.title, fix: FIX, step: { key: 'fix', label: 'Open fix', href: `#/fixes/${FIX.fixId}` } as unknown as Issue['step'], stepRun: null });
    const fail = closed();
    const runs = { [fix.key]: [run('01K8RG000000000000000000F2', 2_000), run('01K8RG000000000000000000F1', 1_000)], [fail.key]: issue().runs! };
    // As Fixes' unblamed row asks as it goes to Failed (open-issue.ts).
    const t = await draw({ issues: [fix, fail], total: 4 }, { before: () => ISSUE_ASK.ask(fail.key), runs });
    const rows = t.all('table.issues tbody tr.iss');
    expect(rows.map((x) => x.getAttribute('data-rowkey'))).toEqual([fix.key, fail.key]);
    expect(t.one(`tr[data-rowkey="${fix.key}"] .it a`).getAttribute('href')).toBe(`#/fixes/${FIX.fixId}`);
    const count = (key: string) => t.one(`tr[data-rowkey="${key}"] button.isn`);
    expect(count(fix.key).getAttribute('aria-expanded')).toBe('false');
    expect(count(fix.key).getAttribute('aria-label')).toBe('Show its 2 runs');
    // The issue a link asked for is open, its runs under it, newest first.
    expect(count(fail.key).getAttribute('aria-expanded')).toBe('true');
    await t.until('its runs', () => t.all('.isruns .isr').length > 0);
    expect(t.all('.isruns .isr').map((a) => a.getAttribute('href'))).toEqual(runs[fail.key].map((x) => `#/run/${x.runId}`));
    // The count shows a closed one's runs, and hides them again.
    await t.click(count(fix.key));
    expect(count(fix.key).getAttribute('aria-expanded')).toBe('true');
    expect(count(fix.key).getAttribute('aria-label')).toBe('Hide its 2 runs');
    await t.until('its runs', () => t.all('.isruns .isr').length === runs[fail.key].length + runs[fix.key].length);
    await t.click(count(fix.key));
    expect(count(fix.key).getAttribute('aria-expanded')).toBe('false');
    // Its step: Open fix, a plain link.
    expect(t.one(`tr[data-rowkey="${fix.key}"] .isfix a.btn`).getAttribute('href')).toBe(`#/fixes/${FIX.fixId}`);
  });

  it('says no failed run matches the words, or that none has failed', async () => {
    expect(shownText((await draw({ issues: [], total: 0 }, { q: 'refund' })).one('.emptyline'))).toBe('No failed runs match.');
    await r?.unmount();
    expect(shownText((await draw({ issues: [], total: 0 })).one('.emptyline'))).toBe('No run has failed.');
  });
});

describe('Failed’s issues, as they are used', () => {
  let r: Rendered | null = null;
  let store: Store | null = null;
  afterEach(async () => {
    await r?.unmount();
    r = null;
    store?.close();
    store = null;
    vi.unstubAllGlobals();
  });
  const toasts: Array<[string, string | undefined]> = [];
  const state = (client: Partial<Client>, o: Partial<AppState> = {}) =>
    ({ client: { exported: false, jobs: () => Promise.resolve([]), ...client }, exported: false, meta: null, tick: 0, runsTick: 0, feeds: {}, jobs: [], actionsOff: null, hasKind: () => true, guard: (fn: () => void) => fn(), watchJob: () => undefined, toast: (m: string, tone?: string) => void toasts.push([m, tone]), refresh: () => undefined, ...o }) as unknown as AppState;
  const failed = (q = '') => createElement(FailedIssues, { query: { q }, refresh: '0', scrollKey: '#/runs?types=failed', above: true });
  const drawn = async (value: AppState) => {
    r = await render(createElement(AppContext.Provider, { value }, failed()));
    await r.until('the issues', () => r!.all('table.issues').length > 0);
    return r;
  };
  const count = (t: Rendered, key: string) => t.one(`tr[data-rowkey="${key}"] button.isn`);
  const shownRuns = (t: Rendered) => t.all('.isruns .isr').map((a) => a.getAttribute('href')!.slice('#/run/'.length));
  const tipOf = (el: FakeElement) => JSON.parse(String(el.getAttribute('data-tip'))) as { t: string; s?: string; cmd?: string; est?: unknown };
  /** Failed's issues as the server reads them from the store, with what their steps read of the project (`next`). */
  const served = (s: Store, next: NextStepWork | null = null): IssuesPage => JSON.parse((ISSUES_READS['runs-issues'](s, { kind: 'runs-issues', options: {}, outcome: null, next }, { whole: true }) as { body: string }).body) as IssuesPage;

  it('brings an issue’s next runs with Show more, and leaves them once the words change, whose read has its runs of its own', async () => {
    const A = (n: number) => `01K8RG000000000000000000M${n}`;
    const wide = issue({ key: 'fail:show more', runs: [run(A(3), 3_000), run(A(2), 2_000)], count: 3, more: A(2) });
    const narrow = issue({ key: 'fail:show more', runs: [run(A(3), 3_000)], count: 1, more: null });
    const after: Array<string | null> = [];
    const client = {
      runsIssues: (q: { q?: string }) => Promise.resolve<IssuesPage>(q.q ? { issues: [narrow], total: 1 } : { issues: [wide], total: 3 }),
      issueRuns: (_key: string, _q: unknown, from: string | null) => (after.push(from), Promise.resolve({ runs: [run(A(1), 1_000)], more: null, count: 3 })),
    };
    // The filter's words, as the page hands them down.
    function Narrowed() {
      const [q, setQ] = useState('');
      return createElement(AppContext.Provider, { value: state(client) }, createElement('button', { id: 'narrow', type: 'button', onClick: () => setQ('refund') }), failed(q));
    }
    r = await render(createElement(Narrowed));
    await r.until('the issues', () => r!.all('table.issues').length > 0);
    await r.click(count(r, wide.key));
    expect(shownRuns(r)).toEqual([A(3), A(2)]);
    await r.click(r.one('.isruns button.attn-more'));
    await r.until('the next runs', () => shownRuns(r!).length === 3);
    expect(after).toEqual([A(2)]);
    expect(shownRuns(r)).toEqual([A(3), A(2), A(1)]);
    expect(r.all('.isruns button.attn-more')).toHaveLength(0);
    // Narrowed, the issue counts one run: those Show more brought before are not among them.
    await r.click(r.one('#narrow'));
    await r.until('the narrowed issue', () => count(r!, wide.key).getAttribute('aria-label') === 'Hide its 1 run');
    expect(shownRuns(r)).toEqual([A(3)]);
  });

  it('says why Show more couldn’t bring the next runs', async () => {
    toasts.length = 0;
    const x = issue({ key: 'fail:show more fails', count: 3, more: '01K8RG000000000000000000A1' });
    const t = await drawn(state({ runsIssues: () => Promise.resolve({ issues: [x], total: 3 }), issueRuns: () => Promise.reject(new Error('the run the last page ended on is gone: read the issues again')) }));
    await t.click(count(t, x.key));
    await t.click(t.one('.isruns button.attn-more'));
    await t.until('the toast', () => toasts.length > 0);
    expect(toasts).toEqual([['The run the last page ended on is gone: read the issues again', 'error']]);
  });

  it('asks for a closed issue’s newest runs as its count is pressed, with the loading line until they come, and a read again carries the runs of each issue shown open', async () => {
    const P = (n: number) => `01K8RG000000000000000000P${n}`;
    const key = 'fail:pressed';
    const shut = closed({ key, count: 3, newest: { runId: P(3), about: null } });
    // Read again with it open: it carries its newest, a run come since among them.
    const kept = issue({ key, runs: [run(P(4), 4_000), run(P(3), 3_000), run(P(2), 2_000), run(P(1), 1_000)] });
    const reads: Array<readonly string[]> = [];
    const asks: Array<[string, string | null]> = [];
    let answer: (p: IssueRunsPage) => void = () => undefined;
    const client = {
      runsIssues: (_q: unknown, open: readonly string[] = []) => (reads.push(open), Promise.resolve<IssuesPage>(open.includes(key) ? { issues: [kept], total: 4 } : { issues: [shut], total: 3 })),
      issueRuns: (k: string, _q: unknown, cursor: string | null) => (asks.push([k, cursor]), new Promise<IssueRunsPage>((resolve) => (answer = resolve))),
    };
    // The page's tick, as the page hands it down.
    function Ticking() {
      const [tick, setTick] = useState(0);
      return createElement(AppContext.Provider, { value: state(client) }, createElement('button', { id: 'tick', type: 'button', onClick: () => setTick((n) => n + 1) }), createElement(FailedIssues, { query: { q: '' }, refresh: String(tick), scrollKey: '#/runs?types=failed', above: true }));
    }
    r = await render(createElement(Ticking));
    await r.until('the issues', () => r!.all('table.issues').length > 0);
    // Not shown open as it was read: it came with its count alone.
    expect(reads.map((open) => open.includes(key))).toEqual([false]);
    expect(r.all('.isruns')).toHaveLength(0);
    await r.click(count(r, key));
    // Pressed, its count asks for its newest runs with no cursor, the loading line in their place until they come.
    expect(asks).toEqual([[key, null]]);
    expect(shownText(r.one('.isruns .empty'))).toBe('Loading runs…');
    expect(r.one('.isruns').getAttribute('aria-busy')).toBe('true');
    expect(shownRuns(r)).toEqual([]);
    answer({ runs: [run(P(3), 3_000), run(P(2), 2_000)], more: P(2), count: 3 });
    await r.until('its runs', () => shownRuns(r!).length === 2);
    expect(shownRuns(r)).toEqual([P(3), P(2)]);
    expect(r.all('.isruns .empty')).toHaveLength(0);
    expect(r.one('.isruns').getAttribute('aria-busy')).toBeNull();
    expect(r.one('.isruns button.attn-more').textContent).toBe('Showing 2 of 3 · Show 1 more');
    // Read again on the page's tick, it asks for the runs of the issue shown open, the last opened first, and keeps its newest: none asked for apart.
    await r.click(r.one('#tick'));
    await r.until('the read again', () => shownRuns(r!).length === 4);
    expect(reads.map((open) => open.includes(key))).toEqual([false, true]);
    expect(reads[1][0]).toBe(key);
    expect(shownRuns(r)).toEqual([P(4), P(3), P(2), P(1)]);
    expect(asks).toHaveLength(1);
  });

  it('says why a closed issue’s runs couldn’t be read where they’d be, and Retry asks for them again', async () => {
    const key = 'fail:runs unread';
    const x = closed({ key });
    const asks: Array<string | null> = [];
    let fails = true;
    const issueRuns = (_k: string, _q: unknown, cursor: string | null) => (asks.push(cursor), fails ? Promise.reject(new Error('the dashboard server could not be reached')) : Promise.resolve<IssueRunsPage>({ runs: issue().runs!, more: null, count: 2 }));
    const t = await drawn(state({ runsIssues: () => Promise.resolve({ issues: [x], total: 2 }), issueRuns }));
    await t.click(count(t, key));
    await t.until('why', () => t.all('.isruns .loaderr').length > 0);
    expect(shownText(t.one('.isruns .loaderr p'))).toContain('Its runs couldn’t be read: the dashboard server could not be reached');
    expect(t.all('.isruns .empty')).toHaveLength(0);
    fails = false;
    await t.click(t.one('.isruns .loaderr button'));
    await t.until('its runs', () => shownRuns(t).length === 2);
    expect(asks).toEqual([null, null]);
    expect(t.all('.isruns .loaderr')).toHaveLength(0);
  });

  it('keeps an issue open while the dashboard is, as Back finds it, and a reload opens each closed', async () => {
    const x = issue({ key: 'fail:kept open' });
    const value = state({ runsIssues: () => Promise.resolve({ issues: [x], total: 2 }) });
    let t = await drawn(value);
    expect(count(t, x.key).getAttribute('aria-expanded')).toBe('false');
    await t.click(count(t, x.key));
    await t.unmount();
    // Back to Runs › Failed: drawn again, it is still open.
    t = await drawn(value);
    expect(count(t, x.key).getAttribute('aria-expanded')).toBe('true');
    await t.unmount();
    // A reload starts the dashboard afresh: open is never in the address.
    vi.resetModules();
    const fresh = await import('../ui/runspage/FailedIssues.js');
    const { AppContext: FreshContext } = await import('../ui/state.js');
    r = await render(createElement(FreshContext.Provider, { value }, createElement(fresh.FailedIssues, { query: { q: '' }, refresh: '0', scrollKey: '#/runs?types=failed', above: true })));
    await r.until('the issues', () => r!.all('table.issues').length > 0);
    expect(count(r, x.key).getAttribute('aria-expanded')).toBe('false');
  });

  it('says on a phone what the count counts and which time is the last seen', async () => {
    const one = issue({ key: 'fail:one run', runs: [run('01K8RG000000000000000000O1', 1_000)] });
    const two = issue({ key: 'fail:two runs' });
    const t = await drawn(state({ runsIssues: () => Promise.resolve({ issues: [two, one], total: 3 }) }));
    const words = (key: string) => t.all(`tr[data-rowkey="${key}"] .phw`).map((x) => x.textContent);
    expect(words(two.key)).toEqual(['\u00a0runs', 'last ']);
    expect(words(one.key)).toEqual(['\u00a0run', 'last ']);
  });

  it('keeps each part of the line under the title whole with its dot, what failed among them, a long one keeping its dot with its last word, and a golden’s path as code', async () => {
    const long = 'issue_refund: amount 240 > get_policy.result.limit 100';
    const fix = issue({ key: 'fix:line', kind: 'fix', fix: FIX, failed: long, lost: 'lost at model call #9', production: 1, blame: null, step: null });
    const golden = issue({ key: 'test:line', kind: 'test', golden: { path: 'goldens/refund-in-limit', name: 'refund-in-limit', diverged: true, did: 'diverged at call 1', passed: false } as unknown as Issue['golden'], detail: { code: '$.metadata.user_id', text: 'looks like a UUID' }, blame: null, step: null });
    const t = await drawn(state({ runsIssues: () => Promise.resolve({ issues: [fix, golden], total: 4 }) }));
    const line = (key: string) => t.one(`tr[data-rowkey="${key}"] .rsub`);
    // Over 36 characters, what failed may wrap, its dot held to its last word; the rest stay whole, each with its dot.
    // What failed keeps its comparison whole as Fixes' rows do: `>`, what it compares with and the figure.
    expect(line(fix.key).textContent).toBe('Failed: issue_refund: amount 240 >\u00a0get_policy.result.limit\u00a0100\u00a0· lost at model call #9\u00a0· 1 from production\u00a0· newest 01K8RG0000');
    expect(line(fix.key).children.filter((x) => x.className === 'nw').map((x) => x.textContent)).toEqual(['lost at model call #9\u00a0·', '1 from production\u00a0·', 'newest 01K8RG0000']);
    // A golden's path set as code, whole with what it looks like.
    expect(line(golden.key).querySelector('.nw code')!.textContent).toBe('$.metadata.user_id');
    expect(line(golden.key).querySelector('.nw')!.textContent).toBe('$.metadata.user_id looks like a UUID\u00a0·');
  });

  it('draws a run’s step small and plain with no key, its card saying the command and what it costs', async () => {
    store = Store.open(':memory:');
    const runId = addRun(store, { startedAt: Date.now() - 60_000, status: 'failed', calls: 'll' });
    const page = served(store);
    const x = page.issues[0];
    expect(x).toMatchObject({ kind: 'failure', stepRun: runId, step: { key: 'blame' } });
    const t = await drawn(state({ runsIssues: () => Promise.resolve(page), nextStep: (() => Promise.resolve({ next: { ...x.step!, estimate: { kind: 'blame', usd: 0.42, ceiling: true, parts: [] } } })) as unknown as Client['nextStep'] }));
    const step = t.one(`tr[data-rowkey="${x.key}"] .isfix button`);
    expect(step.props.className).toBe('btn sm');
    expect(step.textContent).toBe('Run blame');
    expect(step.querySelectorAll('kbd')).toHaveLength(0);
    expect(step.getAttribute('aria-keyshortcuts')).toBeNull();
    await t.hover(step);
    await t.until('the estimate', () => !!tipOf(t.one(`tr[data-rowkey="${x.key}"] .isfix button`)).est);
    expect(tipOf(t.one(`tr[data-rowkey="${x.key}"] .isfix button`))).toMatchObject({ t: 'Run blame', s: unblamedBlameCard(1, runId.slice(0, 10)), cmd: `$ shadowlap blame ${runId.slice(0, 10)}`, est: { usd: 0.42, ceiling: true } });
  });

  it('links a capture’s Run blame to its page, where blame asks for your command first, its card the sentence Fixes and Needs a look say', async () => {
    store = Store.open(':memory:');
    const at = Date.now() - 60_000;
    const judged = { rules: 'r', at, verdict: 'failed', why: null, checks: [{ status: 'failed', ok: false, label: 'every issue_refund call: amount <= 100', detail: 'amount was 240' }] };
    const runId = addRun(store, { startedAt: at, argv: [NO_COMMAND], calls: 'll', meta: { imported: { at, from: '/work/cap.jsonl' }, covers: ['api'], judged } as never });
    const page = served(store);
    const x = page.issues[0];
    expect(x).toMatchObject({ kind: 'capture', stepRun: runId, step: { key: 'blame', capture: true } });
    const t = await drawn(state({ runsIssues: () => Promise.resolve(page) }));
    const link = t.one(`tr[data-rowkey="${x.key}"] .isfix a.btn`);
    expect(link.getAttribute('href')).toBe(`#/run/${runId}`);
    expect(tipOf(link)).toMatchObject({ t: 'Run blame', s: unblamedBlameCard(1, runId.slice(0, 10)) });
  });

  it('draws a crash’s Revert once Find breaking commit named its commit, waiting for a Tests job, and opens its dialog on the commit its run’s offers name', async () => {
    store = Store.open(':memory:');
    const { tested, named } = crashFixtures(() => store!);
    const rec = addRun(store, { startedAt: T0, calls: 'lll' });
    tested(rec, T0 + MIN, 'passed');
    const crash = tested(rec, T0 + 2 * MIN, 'crashed');
    named(T0 + 2 * MIN);
    const page = served(store, work([source(rec)]));
    const x = page.issues.find((i) => i.kind === 'test')!;
    expect(x).toMatchObject({ stepRun: crash, step: { key: 'revert', golden: GOLDEN, rev: 'ccccccc' } });
    let offers = 0;
    const commit = { rev: 'ccccccc', subject: 'Log the total', author: '', date: null, at: T0 + 2 * MIN + 30_000, untested: [], change: null };
    const client = (jobs: unknown[]) =>
      ({
        jobs: () => Promise.resolve(jobs),
        runsIssues: () => Promise.resolve(page),
        nextStep: () => Promise.resolve({ next: { ...x.step!, estimate: { kind: 'tests', usd: 0, parts: ['replays offline'] } } }),
        offers: () => (offers++, Promise.resolve({ commit })),
      }) as unknown as Partial<Client>;
    const inServed = (value: AppState) => createElement(ServedPartsContext.Provider, { value: { RevertDialog } }, createElement(AppContext.Provider, { value }, failed()));
    const revert = (t: Rendered) => t.one(`tr[data-rowkey="${x.key}"] .isfix button`);
    // While a test session runs, it waits for it, saying why, as the run's page's Revert does.
    r = await render(inServed(state(client([{ id: 'job-1', kind: 'test', done: false, project: null }]))));
    await r.until('its wait', () => r!.all(`tr[data-rowkey="${x.key}"] .isfix button[data-why]`).length === 1);
    expect(revert(r).getAttribute('data-why')).toBe('A test session is running: revert it once it is done.');
    await r.unmount();
    // Small and plain with no key, never a page's lead; pressed, it reads the commit and opens its dialog.
    r = await render(inServed(state(client([]))));
    await r.until('the issues', () => r!.all('table.issues').length > 0);
    const step = revert(r);
    expect([step.textContent, step.props.className, step.getAttribute('data-next')]).toEqual(['Revert', 'btn sm', null]);
    expect(step.querySelectorAll('kbd')).toHaveLength(0);
    await r.click(step);
    await r.until('its dialog', () => r!.all('[role="dialog"]').length === 1);
    expect(offers).toBe(1);
    expect(r.one('[role="dialog"] h3').textContent).toBe('Revert ccccccc?');
  });
});
