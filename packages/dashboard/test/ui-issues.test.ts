import { describe, expect, it } from 'vitest';
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
