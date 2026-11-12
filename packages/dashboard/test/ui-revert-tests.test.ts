import { act, createElement, useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '@shadowlap/engine';
import { testsView, type GoldenSource } from '../src/tests.js';
import { bisectBlock } from '../src/tests-bisect.js';
import { JOB_KINDS, type Client, type FoundCommit, type JobView, type NextStep, type TestsView } from '../ui/api.js';
import { wayOnControl } from '../ui/dom.js';
import { handOnAtEnd, notingJobFrom } from '../ui/focus-manager.js';
import { jobFooter } from '../ui/job-actions.js';
import { TestsPage } from '../ui/pages/Tests.js';
import '../ui/revert/bisect-footer.js';
import { ChangeBox } from '../ui/revert/ChangeBox.js';
import { RevertButton } from '../ui/revert/RevertButton.js';
import { RevertDialog } from '../ui/revert/RevertDialog.js';
import { useRoute } from '../ui/router.js';
import { ServedPartsContext } from '../ui/served-parts.js';
import { AppContext, type AppState } from '../ui/state.js';
import { addressBar, watchThePage } from './ui-route-helpers.js';
import { render, type Rendered } from './ui-render.js';

/**
 * Tests once Find breaking commit named a crash's first bad commit: the change shows under the
 * commit's card, in its file's box with Open in editor and Copy git revert; Revert leads the verdict,
 * lime, and the report offers its own, plain, with the hint saying what to do with the commit; the
 * search's end hands the focus to the report's Revert, the step that took Find breaking commit's
 * place, and its drawer ends on Revert where the page now leads with it. A search a reason sends to
 * Tests says so, for the toast's Open Tests.
 */

const T0 = Date.UTC(2026, 9, 30, 10, 0);
const REC = '01M5JEQWA2QMJ3NYD1C687WP08';
const GOLDEN = 'goldens/refund';
const HUNK = '@@ -10,3 +10,3 @@ def refund(order):\n     total = order["amount"]\n-    log(total)\n+    log(order["total"])\n     return total\n';
const FOUND: FoundCommit = { rev: 'ccccccc', subject: 'Log the total', author: '', date: '2026-10-30T10:00:00Z', why: 'the agent exited 1', untested: [], replays: 3, tokens: 0, at: T0 + 2, change: { file: 'agent/refund.py', files: ['agent/refund.py'], hunk: HUNK, line: 11, cut: false, merge: false, path: 'refund.py', outside: 0 } };
const REVERT = { key: 'revert', label: 'Revert', golden: GOLDEN, rev: 'ccccccc', merge: false, live: [], blame: null, title: 'Revert ccccccc', sub: 'Log the total: undone in your working tree, then refund replayed offline', command: `git revert --no-commit ccccccc && shadowlap test ${GOLDEN}` } as unknown as NextStep;
const SEARCH = { key: 'bisect', label: 'Find breaking commit', golden: GOLDEN, starts: false, blame: null, command: `shadowlap bisect ${GOLDEN} --good <commit>` } as unknown as NextStep;
const NAMED_HINT = 'The agent stopped part way at the commit above: revert it or fix the code, then run the tests.';

/** A golden whose agent exited with an error as it replayed: before the search, and once it named the commit. */
function crashView(named: boolean): TestsView {
  const s = Store.open(':memory:');
  const session = s.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'], revision: 'd2e8a1f', startedAt: T0 });
  s.addTestResult({ sessionId: session.sessionId, golden: GOLDEN, ok: false, failure: 'exit', reason: 'the agent exited 1', runId: null, revision: 'd2e8a1f', at: T0 + 1, data: { mode: 'replay', verdict: 'failed', output: "Traceback (most recent call last):\nKeyError: 'total'" } });
  s.finishTestSession(session.sessionId, { passed: 0, failed: 1, upstreamRequests: 0, endedAt: T0 + 100 });
  const goldens: GoldenSource[] = [{ path: GOLDEN, runId: null, packedAt: T0, mode: 'replay', repeat: 1, passes: 1, checks: ['issue_refund called 1 time'] }];
  const v = testsView(s, goldens);
  s.close();
  return { ...v, failures: v.failures.map((f) => ({ ...f, runId: REC, found: named ? FOUND : null })), steps: { [GOLDEN]: named ? REVERT : SEARCH } };
}

let r: Rendered | null = null;
beforeEach(() => {
  addressBar('#/tests');
});
afterEach(async () => {
  await r?.unmount();
  r = null;
  vi.unstubAllGlobals();
});

const base = (tests: () => Promise<TestsView>, tick = 0) =>
  ({
    // Security on Tests reads its goldens' untrusted reads, and Not covered its last scan: none here.
    client: { tests, jobs: () => Promise.resolve([]), offers: () => Promise.resolve(null), startJob: () => Promise.resolve({ id: 'j1' }), injectionSecurity: () => Promise.resolve({ goldens: [], none: [], unread: [] }), coverage: () => Promise.resolve(null) } as unknown as Client,
    exported: false,
    meta: { editor: 'code --goto <file>:<line>' },
    tick,
    feeds: {},
    jobs: [],
    runs: [],
    actionsOff: null,
    hasKind: () => true,
    guard: (fn: () => void) => fn(),
    watchJob: () => undefined,
    toast: () => undefined,
  }) as unknown as AppState;

const served = (a: AppState, node: ReactNode) => createElement(AppContext.Provider, { value: a }, createElement(ServedPartsContext.Provider, { value: { RevertDialog, ChangeBox } }, node));

/** Tests as the shell shows it, the route followed, reading the view `now` gives each time `tick` moves. */
function Shown({ now, bump }: { now: () => TestsView; bump: (to: () => void) => void }) {
  useRoute();
  const [tick, setTick] = useState(0);
  bump(() => setTick((t) => t + 1));
  return served(base(() => Promise.resolve(now()), tick), createElement('main', { id: 'view' }, createElement('div', { className: 'page-in' }, createElement(TestsPage))));
}

describe('Tests, once a crash’s commit is named', () => {
  it('shows the change under the commit, leads with Revert, lime, and the report offers its own, plain, with the hint for the commit', async () => {
    r = await render(served(base(() => Promise.resolve(crashView(true))), createElement('main', { id: 'view' }, createElement(TestsPage))));
    await r.until('the report', () => r!.all('#report-refund').length === 1);
    expect(r.all('.verdict .lime').map((b) => [b.textContent, b.getAttribute('data-next')])).toEqual([['Revert', 'revert']]);
    expect(r.byText('.ph button', 'Run tests').className).toBe('btn');
    const report = r.one('#report-refund');
    expect(report.querySelector('.bisect .k')!.textContent).toBe('first bad commit');
    const box = report.querySelector('.bisectdiff')!;
    expect(box.textContent).toContain('agent/refund.py');
    expect(box.querySelectorAll('.cdacts button').map((b) => b.textContent)).toEqual(['Open in editor', 'Copy git revert']);
    expect(report.querySelectorAll('.actions button').map((b) => [b.textContent, b.className])).toEqual([['Revert', 'btn']]);
    expect(report.querySelector('.hintx')!.textContent).toBe(NAMED_HINT);
  });

  it('hands the focus from the report’s Find breaking commit to its Revert once the search’s answer is read', async () => {
    const changed = watchThePage();
    let named = false;
    let bump: () => void = () => undefined;
    r = await render(createElement(Shown, { now: () => crashView(named), bump: (to) => (bump = to) }));
    await r.until('the report', () => r!.all('#report-refund .actions button').length === 1);
    const find = r.one('#report-refund .actions button');
    expect(find.textContent).toBe('Find breaking commit…');
    expect(r.one('#report-refund .hintx').textContent).not.toBe(NAMED_HINT);
    await r.focus(find);
    await notingJobFrom(Promise.resolve({ id: 'job-b' }));
    handOnAtEnd('job-b');
    named = true;
    await act(async () => bump());
    await r.until('the answer', () => r!.all('#report-refund .bisectdiff').length === 1);
    await changed();
    await act(() => new Promise<void>((done) => setTimeout(done, 80)));
    expect(r.focused()).toBe(r.byText('#report-refund .actions button', 'Revert'));
  });
});

describe('Find breaking commit’s drawer', () => {
  const Footer = jobFooter(JOB_KINDS.bisect)!;
  /** A search's result, as the CLI's `result` event gives it: the golden searched, and the commit named by its short rev. */
  const answer = (golden: string, short: string | null) => ({ outcome: short ? 'found' : 'passes-at-bad', target: { kind: 'golden', name: golden, runId: REC }, first: short ? { rev: short.padEnd(40, '0'), short } : null });
  const job = (o: Partial<JobView>): JobView => ({ id: 'j1', args: ['bisect', GOLDEN], runId: null, opensRun: false, startedAt: T0, done: true, code: 0, newRunId: null, lines: [], total: 0, kind: 'bisect', endedAt: T0 + 9, result: answer(GOLDEN, 'ccccccc'), ...o });
  const OTHER = 'goldens/payout';
  const step = (golden: string, rev: string) => ({ ...REVERT, golden, rev, title: `Revert ${rev}`, command: `git revert --no-commit ${rev} && shadowlap test ${golden}` }) as Extract<NextStep, { key: 'revert' }>;
  /** The drawer over a page that leads with Revert, as the page's own button draws it for the answer the page has read, or with nothing. */
  const drawer = (j: JobView, lead: { step: Extract<NextStep, { key: 'revert' }>; found: FoundCommit | null } | null, plain = true) =>
    served(
      base(() => Promise.resolve(crashView(true))),
      createElement(
        'div',
        null,
        createElement('main', { id: 'view' }, lead ? createElement(RevertButton, { ...lead, estimate: undefined, runId: REC, lead: true }) : null),
        createElement('div', { className: 'drawer' }, createElement('div', { className: 'jfoot' }, createElement('span', { className: 'jkind' }, createElement(Footer, { job: j, plain })), createElement('a', { className: 'btn', href: '#/tests' }, 'Open Tests'))),
      ),
    );

  it('ends on Revert, its way on, once the page leads with the Revert of the answer it gave, pressing the page’s own', async () => {
    r = await render(drawer(job({}), { step: step(GOLDEN, 'ccccccc'), found: FOUND }));
    const way = r.one('.jkind button');
    expect([way.textContent, way.className]).toEqual(['Revert', 'btn']);
    expect(wayOnControl(r.document as unknown as ParentNode)).toBe(way);
    await r.click(way);
    expect(r.one('.dialog h3').textContent).toBe('Revert ccccccc?');
  });

  it('leaves the CLI’s link the way on where the search named no commit, is still running, searched a run, or the page leads with nothing', async () => {
    const lead = { step: step(GOLDEN, 'ccccccc'), found: FOUND };
    const run = job({ args: ['bisect', REC], result: { ...answer(GOLDEN, 'ccccccc'), target: { kind: 'run', name: '01M5JEQWA2', runId: REC } } });
    for (const [j, shown] of [[job({ result: answer(GOLDEN, null) }), lead], [job({ done: false, code: null }), lead], [run, lead], [job({}), null]] as const) {
      r = await render(drawer(j, shown));
      expect(r.all('.jkind button')).toHaveLength(0);
      expect(wayOnControl(r.document as unknown as ParentNode)?.textContent).toBe('Open Tests');
      await r.unmount();
      r = null;
    }
  });

  it('never ends on another golden’s Revert, nor on the lead of an answer the page read before the search', async () => {
    // Another golden's commit leads the page: this search was of goldens/payout.
    const leads: Array<[JobView, { step: Extract<NextStep, { key: 'revert' }>; found: FoundCommit }]> = [
      [job({ args: ['bisect', OTHER], result: answer(OTHER, 'ddddddd') }), { step: step(GOLDEN, 'ccccccc'), found: FOUND }],
      // The page still shows the answer before this one: another commit, then the same commit kept before the search started.
      [job({ result: answer(GOLDEN, 'eeeeeee') }), { step: step(GOLDEN, 'ccccccc'), found: FOUND }],
      [job({ startedAt: FOUND.at + 1, endedAt: FOUND.at + 9 }), { step: step(GOLDEN, 'ccccccc'), found: FOUND }],
    ];
    for (const [j, lead] of leads) {
      r = await render(drawer(j, lead));
      expect(r.all('#view [data-next="revert"]')).toHaveLength(1);
      expect(r.all('.jkind button')).toHaveLength(0);
      expect(wayOnControl(r.document as unknown as ParentNode)?.textContent).toBe('Open Tests');
      await r.unmount();
      r = null;
    }
    // The page's lead before its offers came, which names no answer yet: it waits for them.
    r = await render(drawer(job({}), { step: step(GOLDEN, 'ccccccc'), found: null }));
    expect(r.all('.jkind button')).toHaveLength(0);
  });
});

describe('Find breaking commit’s reasons', () => {
  const run = (status: string) => ({ runId: REC, status, command: { argv: ['node', 'agent.mjs'], cwd: '.' }, meta: {} }) as never;
  const hold = { golden: GOLDEN, cut: false, unsure: false, undecided: null, unjudged: false };

  it('send you to Tests for a replay cut short or a golden that came out inconclusive, and nowhere for the others', () => {
    expect(bisectBlock(run('crashed'), { ...hold, cut: true })).toMatchObject({ onTests: true });
    expect(bisectBlock(run('failed'), { ...hold, unsure: true })).toMatchObject({ onTests: true });
    expect(bisectBlock(run('running'), hold)).toEqual({ reason: 'this run is still recording' });
    expect(bisectBlock(run('failed'), { ...hold, undecided: 'judge "tone" answers yes' })!.onTests).toBeUndefined();
    expect(bisectBlock(run('failed'), hold)).toBeNull();
  });
});
