import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '../ui/api.js';
import { ISSUE_ASK } from '../ui/page-ask.js';
import { FailedIssues } from '../ui/runspage/FailedIssues.js';
import { AppContext, type AppState } from '../ui/state.js';
import { render, shownText, type Rendered } from './ui-render.js';
import { countName, firstPart, issueGlyph, issueHref, issuesEmpty, issuesLess, laterParts } from '../ui/runspage/issues.js';
import { shownWarming } from '../ui/runspage/rows.js';
import type { Issue, IssueRun, IssuesPage } from '../ui/types.js';

/**
 * Runs › Failed as issues, as the page words them (ui/runspage/issues.ts): where each title goes, its
 * icon, the line under it, its count's name, the empty lines, what a waiting delete leaves of them,
 * and the verdicts' warming line, which only Failed and `status:` wait on.
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
    expect(firstPart(issue({ kind: 'fix', fix: FIX }))).toEqual({ failed: 'cost at most $0.05, but cost $0.07' });
    expect(firstPart(issue({ kind: 'capture' }))).toEqual({ text: 'judged when it was imported' });
    expect(firstPart(issue({ kind: 'today' }))).toEqual({ text: 'judged from the recording' });
    const today = issue({ kind: 'today', runs: [run('01K8RG000000000000000000T1', 1_000, { judged: { today: true } as NonNullable<IssueRun['judged']> })] });
    expect(firstPart(today)).toEqual({ text: 'by today’s checks, judged from the recording' });
    expect(firstPart(issue())).toEqual({ text: 'not blamed yet' });
    expect(firstPart(issue({ kind: 'test', detail: '$.metadata.user_id, a UUID' }))).toEqual({ text: '$.metadata.user_id, a UUID' });
  });

  it('then where it was planted or lost, and how many of a fix’s runs came from production', () => {
    expect(laterParts(issue({ kind: 'planted', planted: 'planted in #2 lookup_order’s result', blame: null }))).toEqual(['planted in #2 lookup_order’s result']);
    expect(laterParts(issue({ kind: 'fix', fix: FIX, lost: 'lost at model call #9', production: 1, blame: null }))).toEqual(['lost at model call #9', '1 from production']);
    expect(laterParts(issue({ kind: 'capture', production: 2 }))).toEqual(['not blamed yet']);
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
    const less = issuesLess(page, new Set(['01K8RG000000000000000000A2', '01K8RG000000000000000000B1']));
    expect(less.total).toBe(1);
    expect(less.issues.map((x) => x.key)).toEqual([a.key]);
    expect(less.issues[0]).toMatchObject({ count: 1, last: 1_000, newest: { runId: '01K8RG000000000000000000A1' } });
    expect(issuesLess(page, new Set())).toBe(page);
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
  /** Failed's issues drawn from `page`; `before` runs once the page is up and before the issues come, as a link's ask does. */
  const draw = async (page: IssuesPage, o: { q?: string; before?: () => void } = {}) => {
    let answer: (p: IssuesPage) => void = () => undefined;
    const asked = new Promise<IssuesPage>((resolve) => (answer = resolve));
    const client = { exported: false, runsIssues: () => asked, issueRuns: () => Promise.resolve({ runs: [], more: null, count: 0 }), jobs: () => Promise.resolve([]) } as unknown as Client;
    r = await render(createElement(AppContext.Provider, { value: app(client) }, createElement(FailedIssues, { query: { q: o.q ?? '' }, refresh: '0', scrollKey: '#/runs?types=failed', above: true })));
    o.before?.();
    answer(page);
    await r.until('the issues', () => r!.all('table.issues').length + r!.all('.emptyline').length > 0);
    return r;
  };

  it('draws each issue a row whose count shows its runs, and opens the issue a link asked for, its runs shown', async () => {
    vi.stubGlobal('requestAnimationFrame', (f: () => void) => (f(), 0));
    vi.stubGlobal('CSS', { escape: (x: string) => x });
    const fix = issue({ key: `fix:${FIX.fixId}`, kind: 'fix', title: FIX.title, fix: FIX, step: { key: 'fix', label: 'Open fix', href: `#/fixes/${FIX.fixId}` } as unknown as Issue['step'], stepRun: null });
    const fail = issue();
    // As Fixes' unblamed row asks as it goes to Failed (open-issue.ts).
    const t = await draw({ issues: [fix, fail], total: 4 }, { before: () => ISSUE_ASK.ask(fail.key) });
    const rows = t.all('table.issues tbody tr.iss');
    expect(rows.map((x) => x.getAttribute('data-rowkey'))).toEqual([fix.key, fail.key]);
    expect(t.one(`tr[data-rowkey="${fix.key}"] .it a`).getAttribute('href')).toBe(`#/fixes/${FIX.fixId}`);
    const count = (key: string) => t.one(`tr[data-rowkey="${key}"] button.isn`);
    expect(count(fix.key).getAttribute('aria-expanded')).toBe('false');
    expect(count(fix.key).getAttribute('aria-label')).toBe('Show its 2 runs');
    // The issue a link asked for is open, its runs under it, newest first.
    expect(count(fail.key).getAttribute('aria-expanded')).toBe('true');
    expect(t.all('.isruns .isr').map((a) => a.getAttribute('href'))).toEqual(fail.runs.map((x) => `#/run/${x.runId}`));
    // The count shows a closed one's runs, and hides them again.
    await t.click(count(fix.key));
    expect(count(fix.key).getAttribute('aria-expanded')).toBe('true');
    expect(count(fix.key).getAttribute('aria-label')).toBe('Hide its 2 runs');
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
