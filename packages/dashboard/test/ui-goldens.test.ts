import { describe, expect, it } from 'vitest';
import { ciQuery, commandText, dayClock, divergenceButtons, failureLines, foundLine, historyTip, reportLines, revLabel, sessionLine, shortDate, sourceText, updatePlan } from '../ui/goldens.js';
import { jobStatus } from '../ui/jobs.js';
import type { DivergenceView, FailureView, GoldenRow, TestsView } from '../ui/types.js';

/**
 * The Tests screen's words and choices, without a browser: the verdict's line, a history cell's
 * hover, the reports as the CLI prints them, the buttons a divergence gets, and the Update golden
 * dialog, against the shapes `GET /api/tests` sends.
 */
const T = new Date(2026, 9, 1, 10, 2).getTime();
const UUID = { path: '$.metadata.user_id', looks: 'a UUID', op: 'changed' as const, certain: true, normalizer: { kind: 'api' as const, path: '$.metadata.user_id', pattern: 'uuid', replace: '<UUID>' }, args: [], command: '' };

const row = (name: string, over: Partial<GoldenRow> = {}): GoldenRow => ({
  path: `goldens/${name}`,
  name,
  source: { kind: 'run', runId: '01K5CQ3W6H0000000000000000' },
  mode: 'replay',
  modeLabel: 'replay',
  modeHint: 'must send exactly the requests it recorded',
  checks: ['issue_refund called 1 time', 'send_email called 1 time'],
  history: [],
  last: { result: 'pass', failure: null, line: '8/8 replayed · checks passed', at: T, updated: false },
  runId: null,
  error: null,
  ...over,
});

const divergence = (name: string, over: Partial<DivergenceView> = {}): DivergenceView => ({
  golden: `goldens/${name}`,
  name,
  runId: '01K5CQ4V5K0000000000000000',
  callNo: 1,
  kind: 'api',
  callName: 'POST /v1/messages',
  text: `✗ ${name}: diverged at call 1 (api POST /v1/messages)\n    ✗ Diverged at call 1 (api POST /v1/messages): 0 calls replayed before divergence\n      ~ $.metadata.user_id\n          - "3f1c9a2e-5b7d-4e21-9c0a-8d6f2b1e7a43"\n          + "b84e07d1-2c9f-4a63-8e15-6f0d3a9c2b78"`,
  volatile: UUID,
  normalizerFixes: true,
  maybeReal: false,
  rerun: ['test', `goldens/${name}`],
  update: ['test', `goldens/${name}`, '--update'],
  normalizeAndTest: [['normalize', 'add', '--kind', 'api', '--path', '$.metadata.user_id', '--pattern', 'uuid', '--replace', '<UUID>'], ['test', `goldens/${name}`]],
  rulesAdded: false,
  bisect: { good: 'c91d0f4', bad: 'd2e8a1f', args: [], live: false },
  found: null,
  ...over,
});

function view(over: Partial<TestsView> = {}): TestsView {
  return {
    empty: false,
    goldens: 4,
    verdict: {
      state: 'failing',
      failing: 1,
      passing: 3,
      untested: 0,
      title: 'refund-in-limit diverged at call 1',
      first: { golden: 'goldens/refund-in-limit', name: 'refund-in-limit', reason: 'diverged at call 1 (api POST /v1/messages)', runId: null },
      session: { id: 's1', command: 'shadowlap test goldens/*', revision: 'd2e8a1f', startedAt: T - 60_000, endedAt: T, passed: 3, failed: 1, upstreamRequests: 0, actor: 'ci', interrupted: false },
    },
    revisions: ['c91d0f4', 'd2e8a1f'],
    rows: [row('refund-over-limit'), row('refund-in-limit', { last: { result: 'fail', failure: 'diverged', line: 'diverged at call 1 · $.metadata.user_id looks like a UUID', at: T, updated: false } }), row('escalate-over-limit', { checks: [] })],
    divergences: [divergence('refund-in-limit')],
    failures: [],
    diverged: ['goldens/refund-in-limit'],
    commands: { ci: 'shadowlap test goldens/* --junit report.xml', inCi: '', pack: 'shadowlap pack <run> goldens/<name>', run: ['test', 'goldens/*'], updateAll: ['test', 'goldens/refund-in-limit', '--update'] },
    note: '',
    ...over,
  };
}

const all = () => true;

describe('the verdict', () => {
  it('names the command, revision, time, how the goldens stand and the upstream requests', () => {
    expect(sessionLine(view())).toEqual({ command: 'shadowlap test goldens/*', rest: 'rev d2e8a1f · Oct 1, 10:02 · 3 passed, 1 failed · 0 upstream requests' });
    const v = view();
    v.verdict!.untested = 2;
    v.verdict!.session.upstreamRequests = 1;
    expect(sessionLine(v)!.rest).toBe('rev d2e8a1f · Oct 1, 10:02 · 3 passed, 1 failed, 2 not run yet · 1 upstream request');
  });

  it('says when a session was interrupted, is still running, or never finished', () => {
    const v = view();
    v.verdict!.session.interrupted = true;
    expect(sessionLine(v)!.rest).toMatch(/ · interrupted$/);
    v.verdict!.session.interrupted = false;
    v.verdict!.session.endedAt = null;
    expect(sessionLine(v, true)!.rest).toMatch(/Oct 1, 10:01 · .* · running$/);
    expect(sessionLine(v, false)!.rest).toMatch(/ · did not finish$/);
    expect(sessionLine(view({ verdict: null }))).toBeNull();
  });
});

describe('the goldens table', () => {
  it('names each revision by its short sha, a + when it was tested with changes on top', () => {
    expect(revLabel('d2e8a1f9c0b1')).toBe('d2e8a1f');
    expect(revLabel('d2e8a1f+dirty')).toBe('d2e8a1f+');
    expect(revLabel('v2.4.0')).toBe('v2.4.0');
    expect(revLabel(null)).toBe('—');
  });

  it('says on hover how a golden did at each revision, and why it failed', () => {
    expect(historyTip({ revision: 'b7e40c2', result: 'fail', note: 'input tokens 71,940, over the 60,000 budget', updated: false, runId: null, at: T }, 'refund-flow-budget')).toEqual({ title: 'b7e40c2 · refund-flow-budget', label: 'failed', value: 'input tokens 71,940, over the 60,000 budget', color: 'var(--err)' });
    expect(historyTip({ revision: 'd2e8a1f', result: 'pass', note: null, updated: true, runId: null, at: T }, 'x')).toMatchObject({ label: 'passed', value: 'updated here: re-recorded, its checks passed', color: 'var(--o-rep)' });
    expect(historyTip({ revision: null, result: null, note: null, updated: false, runId: null, at: null }, 'x')).toMatchObject({ title: 'no revision · x', label: 'not tested here' });
    // Updated, and its new recording failed the replay after it: both are said.
    expect(historyTip({ revision: 'd2e8a1f', result: 'fail', note: 'diverged at call 8', updated: true, runId: null, at: T }, 'x').value).toBe('updated here, then diverged at call 8');
  });

  it('says where each golden came from: a run here, or a pack made elsewhere', () => {
    expect(sourceText(row('a'))).toEqual({ runId: '01K5CQ3W6H0000000000000000' });
    expect(sourceText(row('a', { source: { kind: 'pack', packedAt: new Date(2026, 8, 28).getTime() } }))).toEqual({ text: 'packed Sep 28' });
    expect(sourceText(row('a', { source: { kind: 'pack', packedAt: null } }))).toEqual({ text: 'a pack made elsewhere' });
  });
});

describe('the reports', () => {
  it('colours a divergence as the mock does: the golden\'s line, then what was and what is', () => {
    const lines = reportLines(divergence('refund-in-limit').text);
    expect(lines.map((l) => l.tone)).toEqual(['no', '', '', 'del', 'add']);
    expect(lines[0]!.text).toBe('✗ refund-in-limit: diverged at call 1 (api POST /v1/messages)');
  });

  it('prints a failed check, a non-zero exit or no calls as test --markdown does', () => {
    const f: FailureView = {
      golden: 'goldens/refund-over-limit',
      name: 'refund-over-limit',
      runId: null,
      failure: 'check',
      reason: 'check failed: issue_refund called 0 times, but called 1 time',
      checks: [
        { ok: false, label: 'issue_refund called 0 times', detail: 'called 1 time' },
        { ok: true, label: 'exits 0', detail: null },
      ],
      details: '⑂ Forked at call 5: 4 calls replayed, then 4 live\n',
      output: 'Issuing the refund.\nDone.',
      bisect: null,
      found: null,
    };
    expect(failureLines(f)).toEqual([
      { text: '✗ refund-over-limit: check failed: issue_refund called 0 times, but called 1 time', tone: 'no' },
      { text: '    ✗ issue_refund called 0 times: called 1 time', tone: 'no' },
      { text: '    ✓ exits 0', tone: '' },
      { text: '    ⑂ Forked at call 5: 4 calls replayed, then 4 live', tone: '' },
      { text: '    │ Issuing the refund.', tone: 'dim' },
      { text: '    │ Done.', tone: 'dim' },
    ]);
  });

  it('names what Find the commit found, with who, when and its cost', () => {
    expect(foundLine({ rev: '4e7b2d1', subject: 'Send the user id with every request', author: 'Ravi', date: '2026-09-30T09:30:00+02:00', why: '', untested: [], replays: 3, tokens: 0, at: T })).toEqual({ rev: '4e7b2d1', subject: 'Send the user id with every request', meta: 'Ravi · Sep 30 · 0 tokens' });
    expect(shortDate('not a date')).toBe('not a date');
    expect(dayClock(T)).toBe('Oct 1, 10:02');
  });
});

describe('the buttons under a divergence', () => {
  it('lead with the normalizer for a value made anew on every run', () => {
    expect(divergenceButtons(divergence('a'), all)).toEqual({ normalize: { label: 'Add normalizer and re-run', lead: true, run: 'normalize' }, update: { lead: false }, bisect: { range: true, live: false }, maybeReal: false, note: null });
  });

  it('lead with neither fix for an id that may be a real change, and say so', () => {
    const b = divergenceButtons(divergence('a', { maybeReal: true, normalizerFixes: false, volatile: { ...UUID, certain: false } }), all);
    expect(b.normalize).toEqual({ label: 'Add normalizer and re-run', lead: false, run: 'normalize' });
    expect(b.note).toBe('maybe-real');
  });

  it('ask before an Add normalizer that updates the golden too, and offer none for another change', () => {
    const updates = divergence('a', { normalizerFixes: false, normalizeAndTest: [['normalize', 'add', '--path', '$.id', '--replace', '<ID>'], ['test', 'goldens/a', '--update']] });
    expect(divergenceButtons(updates, all).normalize).toEqual({ label: 'Add normalizer and update…', lead: false, run: 'normalize-update' });
    const prompt = divergence('a', { volatile: null, normalizerFixes: false, normalizeAndTest: null });
    expect(divergenceButtons(prompt, all)).toMatchObject({ normalize: null, update: { lead: false }, note: null });
  });

  it('only re-run once the rule is in the config, and say why', () => {
    expect(divergenceButtons(divergence('a', { rulesAdded: true }), all)).toMatchObject({ normalize: { label: 'Re-run', lead: true, run: 'rerun' }, note: 'rules-added' });
    const updates = divergence('a', { rulesAdded: true, normalizerFixes: false, normalizeAndTest: [['normalize', 'add', '--path', '$.id', '--replace', '<ID>'], ['test', 'goldens/a', '--update']] });
    expect(divergenceButtons(updates, all)).toMatchObject({ normalize: null, note: 'rules-added-update' });
  });

  it('leave out Find the commit once it found the commit, and what the server does not run', () => {
    const found = divergence('a', { found: { rev: '4e7b2d1', subject: 's', author: 'a', date: '', why: '', untested: [], replays: 3, tokens: 0, at: T } });
    expect(divergenceButtons(found, all).bisect).toBeNull();
    expect(divergenceButtons(divergence('a', { bisect: null }), all).bisect).toEqual({ range: false, live: false });
    expect(divergenceButtons(divergence('a'), (k) => k === 'test')).toMatchObject({ normalize: null, update: null, bisect: null });
  });
});

describe('the Update golden dialog', () => {
  it('shows one golden as a card, its checks, the amber note naming the path, and Update anyway', () => {
    const plan = updatePlan(view(), ['goldens/refund-in-limit']);
    expect(plan.title).toBe('Update refund-in-limit?');
    expect(plan.goldens).toEqual([{ path: 'goldens/refund-in-limit', name: 'refund-in-limit', where: 'diverged at call 1' }]);
    expect(plan.steps).toEqual([
      ['Re-recorded live', 'writes stubbed'],
      ['Its checks run', '2 checks'],
      ['Replaced only if they pass', 'in your working tree'],
      ['You review the change', 'in your pull request'],
    ]);
    expect(plan.advise).toEqual({ path: '$.metadata.user_id', golden: 'goldens/refund-in-limit', text: 'looks like a UUID, which changes every run. Updating re-records it, and the next run diverges again.' });
    expect(plan.command).toBe('shadowlap test goldens/refund-in-limit --update');
    expect(plan.ok).toBe('Update anyway');
  });

  it('lists several goldens, and says which diverged on values that change every run', () => {
    const v = view({ divergences: [divergence('refund-in-limit'), divergence('escalate-over-limit', { volatile: null, normalizerFixes: false, normalizeAndTest: null, callNo: 3 })], diverged: ['goldens/refund-in-limit', 'goldens/escalate-over-limit'] });
    const plan = updatePlan(v, v.diverged);
    expect(plan.title).toBe('Update 2 diverged goldens?');
    expect(plan.goldens.map((g) => g.where)).toEqual(['diverged at call 1', 'diverged at call 3']);
    expect(plan.steps[1]).toEqual(['Each one’s checks run', 'per golden']);
    expect(plan.advise).toEqual({ path: null, golden: null, text: 'refund-in-limit diverged on values that change every run. Updating re-records it, and the next run diverges again.' });
  });

  it('plainly offers Update for a change that was meant, and counts a golden with no checks by its exit status', () => {
    const v = view({ divergences: [divergence('escalate-over-limit', { volatile: null, normalizerFixes: false, normalizeAndTest: null })], diverged: ['goldens/escalate-over-limit'] });
    const plan = updatePlan(v, ['goldens/escalate-over-limit']);
    expect(plan.advise).toBeNull();
    expect(plan.ok).toBe('Update');
    expect(plan.steps[1]).toEqual(['Its checks run', 'exit status']);
    // An id that may be a real change gets no amber note: only the person knows.
    const maybe = view({ divergences: [divergence('refund-in-limit', { maybeReal: true, volatile: { ...UUID, certain: false } })] });
    expect(updatePlan(maybe, ['goldens/refund-in-limit']).advise).toBeNull();
  });

  it('quotes what a shell would need quoting in the command', () => {
    expect(commandText(['test', 'goldens/my golden', '--update'])).toBe("shadowlap test 'goldens/my golden' --update");
    expect(commandText(['test', 'goldens/*'])).toBe('shadowlap test goldens/*');
  });
});

describe('the jobs the screen starts', () => {
  it('says whether Find the commit found it', () => {
    expect(jobStatus({ args: ['bisect'], done: true, code: 0 }, ['  replay at 7f20b6a  diverged at call 1', '✓ first bad commit 4e7b2d1 · Send the user id with every request · Ravi · 2026-09-30', '  2 checks passed'])).toEqual({ text: 'found · exit 0', tone: 'ok' });
    expect(jobStatus({ args: ['bisect'], done: true, code: 1 }, ['✗ no first bad commit: every commit in the range passes'])).toEqual({ text: 'not found · exit 1', tone: 'warn' });
  });

  it('asks the CI endpoint for the panels\' options, leaving out what is not set', () => {
    expect(ciQuery()).toBe('');
    expect(ciQuery({ fix: true, budget: '5.00', repairer: 'openai:gpt-5', onlyMain: false, secret: 'TEAM_HOOK' })).toBe('?fix=on&budget=5.00&repairer=openai%3Agpt-5&onlyMain=off&secret=TEAM_HOOK');
  });
});
