import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { gateResult, parseGate, Store, type StoredCheck } from '@shadowlap/engine';
import type { InjectionGateRow } from '../src/injection-gates.js';
import { testsView, type GoldenSource } from '../src/tests.js';
import { evidenceWords } from '../src/tests-evidence.js';
import { pageUp } from '../ui/focus-manager.js';
import { ApiError, JOB_KINDS, type Client, type TestsView } from '../ui/api.js';
import type { NextStep } from '../ui/types.js';
import { jobFooter } from '../ui/job-actions.js';
import { TestsPage } from '../ui/pages/Tests.js';
import { goldenRowScope } from '../ui/tests/row-scope.js';
import { AppContext, type AppState } from '../ui/state.js';
import { sheet } from './css-sheet.js';
import { render, type FakeElement, type Rendered } from './ui-render.js';
import { withStepDialogs } from './ui-served-now.js';

/**
 * Tests tells the truth about checks, CI and judges: each check is marked by how the golden's last
 * result came out on it (no tick on one that failed, none at all before a result), the page says CI
 * replays goldens offline and runs those marked fork live, with the one documented command, and a
 * judge a replay golden couldn't ask offline is settled by Update golden, which asks first. The
 * table keeps Last result on screen at every width, by the container queries the mock's .gtw has.
 */

const T0 = Date.UTC(2026, 9, 20, 10, 0);
const JUDGE = 'judge "explains-escalation" answers yes';
const passed = (label: string): StoredCheck => ({ ok: true, status: 'passed', label, detail: null });

const golden = (path: string, checks: string[], over: Partial<GoldenSource> = {}): GoldenSource => ({ path, runId: null, packedAt: T0, mode: 'replay', repeat: 1, passes: 1, checks, ...over });
const GOLDENS: GoldenSource[] = [
  golden('goldens/passes', ['escalate called 1 time']),
  golden('goldens/refunds', ['issue_refund called 1 time', 'send_email called 1 time']),
  golden('goldens/judged', ['escalate called 1 time', JUDGE]),
  golden('goldens/budget', ['at most 29000 input tokens'], { mode: 'fork', gate: parseGate({ baseline: 'history' }, 'gate') }),
];

function view(goldens: GoldenSource[]): TestsView {
  const s = Store.open(':memory:');
  const session = s.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'], revision: 'd2e8a1f', startedAt: T0 });
  const result = (golden: string, ok: boolean, data: NonNullable<Parameters<Store['addTestResult']>[0]['data']>, failure?: 'check' | 'inconclusive') => s.addTestResult({ sessionId: session.sessionId, golden, ok, ...(failure ? { failure } : {}), reason: ok ? null : 'failed', runId: null, revision: 'd2e8a1f', at: T0 + 1, data });
  result('goldens/passes', true, { mode: 'replay', verdict: 'passed', checks: [passed('escalate called 1 time')] });
  result('goldens/refunds', false, { mode: 'replay', verdict: 'failed', checks: [{ ok: false, status: 'failed', label: 'issue_refund called 1 time', detail: 'called 0 times; tools called: add_note' }, { ok: false, status: 'failed', label: 'send_email called 1 time', detail: 'called 0 times; tools called: add_note' }] }, 'check');
  const judge = { name: 'explains-escalation', model: 'claude-haiku-4-5', of: 'answer' as const, verdict: null, source: null, cost: null, redactions: 0, cut: 0 };
  result('goldens/judged', false, { mode: 'replay', verdict: 'inconclusive', checks: [passed('escalate called 1 time'), { ok: false, status: 'inconclusive', label: JUDGE, detail: 'not judged: no recorded verdict and the test runs offline', judge }] }, 'inconclusive');
  s.finishTestSession(session.sessionId, { passed: 1, failed: 1, upstreamRequests: 0, endedAt: T0 + 100 });
  const v = testsView(s, goldens);
  s.close();
  return v;
}

const evidenceAsked: string[] = [];

/** `over`: what the app holds besides (its runs, its jobs), and how the read of the goldens answers. */
function page(started: Array<{ kind: string; fields: Record<string, unknown> }>, goldens: GoldenSource[], shape: (v: TestsView) => TestsView = (v) => v, over: { app?: Record<string, unknown>; tests?: () => Promise<TestsView>; beside?: ReactNode } = {}) {
  const v = shape(view(goldens));
  const client = {
    tests: over.tests ?? (() => Promise.resolve(v)),
    testEvidence: (golden: string) => {
      evidenceAsked.push(golden);
      return Promise.resolve({ attempts: [{ runId: 'run-a1', href: '#/run/run-a1', outcome: 'passed', note: null }], carried: 0, gone: 0 });
    },
    jobs: () => Promise.resolve([]),
    offers: () => Promise.resolve(null),
    injectionSecurity: () => Promise.resolve({ goldens: [], none: [], unread: [] }),
    startJob: (kind: string, fields: Record<string, unknown>) => {
      started.push({ kind, fields });
      return Promise.resolve({ id: 'j1' });
    },
  } as unknown as Client;
  const app = {
    client,
    exported: false,
    meta: null,
    tick: 0,
    feeds: {},
    jobs: [],
    actionsOff: null,
    hasKind: () => true,
    guard: (fn: () => void) => fn(),
    watchJob: () => undefined,
    toast: () => undefined,
    ...over.app,
  };
  return withStepDialogs(createElement(AppContext.Provider, { value: app as unknown as AppState }, createElement(TestsPage), over.beside ?? null));
}

const g = globalThis as { location?: unknown };
let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
  delete g.location;
});

async function open(started: Array<{ kind: string; fields: Record<string, unknown> }> = [], goldens = GOLDENS, shape?: (v: TestsView) => TestsView) {
  g.location = { hash: '#/tests' };
  r = await render(page(started, goldens, shape));
  await r.until('the goldens to load', () => r!.all('table.gt tbody tr').length === goldens.length);
  return r;
}

/** The one element under `el` the selector matches. */
function one(el: FakeElement, selector: string): FakeElement {
  const found = el.querySelectorAll(selector);
  if (found.length !== 1) throw new Error(`${found.length} elements match ${selector}`);
  return found[0];
}
const all = (el: FakeElement, selector: string) => el.querySelectorAll(selector);

/** The checks of a golden's row, as the Checks column shows them: each one's class, mark and words. */
function checks(page: Rendered, name: string) {
  const tr = page.all('table.gt tbody tr').find((row) => all(row, 'code')[0].textContent === name)!;
  return all(one(tr, 'td.chk'), '.ck').map((ck) => ({ cls: ck.className, mark: all(ck, 'b.cm')[0]?.textContent ?? null, words: one(ck, '.cw').textContent }));
}

describe('the Tests page', () => {
  it('marks each check by its last status: no tick on one that failed or couldn\'t be decided, none before a result', async () => {
    const page = await open();
    expect(checks(page, 'passes')).toEqual([{ cls: 'ck passed', mark: '✓', words: 'escalate called once' }]);
    expect(checks(page, 'refunds')).toEqual([
      { cls: 'ck failed', mark: '✗', words: 'issue_refund called oncecalled 0 times; tools called: add_note' },
      { cls: 'ck failed', mark: '✗', words: 'send_email called oncecalled 0 times; tools called: add_note' },
    ]);
    expect(checks(page, 'judged')[1]).toEqual({ cls: 'ck inconclusive', mark: '?', words: `${JUDGE}not judged: no recorded verdict and the test runs offline` });
    expect(checks(page, 'budget')).toEqual([{ cls: 'ck', mark: null, words: 'input tokens ≤ 29,000' }]);
    // Each mark says its status to a screen reader.
    expect(page.all('table.gt td.chk b.cm').map((b) => b.getAttribute('aria-label'))).toEqual(['passed', 'failed', 'failed', 'passed', 'inconclusive']);
  });

  it('marks no check added to the config since the last test, and says so under it', async () => {
    const page = await open([], GOLDENS.map((x) => (x.path === 'goldens/passes' ? { ...x, checks: [...x.checks, 'send_email called 0 times'] } : x)));
    expect(checks(page, 'passes')).toEqual([
      { cls: 'ck passed', mark: '✓', words: 'escalate called once' },
      { cls: 'ck', mark: null, words: 'send_email never calledadded since its last test' },
    ]);
  });

  it('says CI runs replay goldens offline and fork goldens live, with the one command docs/gating.md has, to copy', async () => {
    const page = await open();
    // golden defined at its first use: its definition a hidden part of the paragraph.
    expect(page.one('.ph p').textContent).toMatch(/^Every golden.+ CI runs, and how it did at each revision\.$/);
    expect(all(page.one('.ph p'), '.term').map((t) => t.textContent.slice(0, 6))).toEqual(['golden']);
    expect(page.all('button').map((b) => b.textContent.trim())).not.toContain('Copy CI command');
    const ci = page.all('section.panel').find((s) => all(s, 'h2').some((h) => h.textContent === 'In CI'))!;
    expect(ci.textContent).toContain('Replay goldens run offline and need no key; a golden marked fork runs live from where it forks and needs the providers’ keys. A divergence, a non-zero exit, no calls, or a check, gate or injection test that fails or can’t decide fails a golden. A gate against history with fewer than 30 sessions only warns when it runs out of attempts, until the plan reads a decline or a drop.');
    expect(ci.textContent).not.toContain('throwaway store');
    expect(one(ci, '.cmdline').textContent).toBe(`$shadowlap test 'goldens/*' --junit report.xml --markdown "$GITHUB_STEP_SUMMARY" --annotations`);
    // In its box alone, with the box's one Copy, named by what it copies.
    expect(all(ci, 'button').map((b) => b.getAttribute('aria-label'))).toEqual(['Copy CI command']);
    // budget has a gate against history: CI must keep the store between runs.
    expect(all(ci, 'p.muted.after')[0].textContent).toBe('A gate against history needs the store kept between runs: the Action’s keep-history does it, or cache .shadowlap/shadowlap.db.');
    expect(all(ci, 'a.more').map((a) => [a.textContent, a.getAttribute('href')])).toEqual([['Settings → CI', '#/settings/ci']]);
    expect(page.document.body.textContent).toContain('A golden whose checks say what the agent must do is also a task a model can be scored on.');
  });

  it('says an injection test runs live too, and needs the keys, when a golden has one, and that a short history only warns whatever the goldens', async () => {
    // No gate against history here: the store need not be kept, and a short history still only warns.
    const page = await open([], GOLDENS.map((x) => (x.path === 'goldens/passes' ? { ...x, injection: true } : x.path === 'goldens/budget' ? { ...x, gate: null } : x)));
    const ci = page.all('section.panel').find((s) => all(s, 'h2').some((h) => h.textContent === 'In CI'))!;
    expect(all(ci, 'p.muted')[0].textContent).toBe('Replay goldens run offline and need no key; a golden marked fork runs live from where it forks, and an injection test from each payload it plants: both need the providers’ keys. A divergence, a non-zero exit, no calls, or a check, gate or injection test that fails or can’t decide fails a golden. A gate against history with fewer than 30 sessions only warns when it runs out of attempts, until the plan reads a decline or a drop.');
    expect(ci.textContent).not.toContain('keep-history');
  });

  it('settles a judge a replay golden couldn\'t ask offline with Update golden, which asks first and names its command', async () => {
    const started: Array<{ kind: string; fields: Record<string, unknown> }> = [];
    const page = await open(started);
    const panel = page.all('section.gpanel').find((s) => one(s, 'h2').textContent === 'judged')!;
    expect(panel.textContent).not.toContain('a key to ask');
    expect(one(panel, 'p.hintx').textContent).toContain('Update golden asks it once, live, and keeps its verdict in the pack');
    await page.click(all(panel, 'button').find((b) => b.textContent.trim() === 'Update golden')!);
    expect(started).toEqual([]);
    const dialog = page.one('.dialog');
    expect(all(dialog, 'h2, h3')[0].textContent).toBe('Update judged?');
    expect(dialog.textContent).toContain('nothing is re-recorded');
    // No card and no Diverged list: nothing diverged, and the title names the golden.
    expect(all(dialog, '.rmp, .ondisk.first')).toHaveLength(0);
    expect(all(dialog, '.ondisk.steps li span').map((s) => s.textContent)).toEqual(['Replayed offline, as recorded', 'Its judge asked once, live', 'Its verdict kept in the pack', 'You review the change']);
    expect(one(dialog, '.cmdline').textContent).toBe('$shadowlap test goldens/judged --update');
    await page.click(page.byText('.dialog button', 'Update golden'));
    expect(started).toEqual([{ kind: 'test-update', fields: { golden: 'goldens/judged' } }]);
  });

  it('leads with the step the first failure leads with on its run\'s page, lime, Run tests plain while it does, and none for a step Tests has no button for', async () => {
    const fix = { key: 'fix' as const, label: 'Open fix', fixId: 'fx-1', status: 'open' as const, check: 'no refund without an email', href: '#/fixes/fx-1', title: '“Refunds skip the email”' };
    const page = await open([], GOLDENS, (v) => ({ ...v, steps: { 'goldens/refunds': fix } }));
    const verdict = page.one('.verdict.tv');
    expect([one(verdict, '.vw').textContent, one(verdict, 'h2').textContent.replace(/\u00a0/g, ' ')]).toEqual(['failed', 'failed 1 of 4 goldens passed · refunds failed · 1 golden not tested yet']);
    expect(all(verdict, '.actions .btn.lime').map((b) => [b.textContent, b.getAttribute('href')])).toEqual([['Open fix', '#/fixes/fx-1']]);
    const sub = 'The fix for this failure: no refund without an email';
    expect(JSON.parse(one(verdict, '.actions .btn.lime').getAttribute('data-tip')!)).toMatchObject({ t: '“Refunds skip the email”', s: sub });
    expect(page.all('.ph .btn').filter((b) => b.className.includes('lime'))).toEqual([]);
    // ⌘K on the golden it leads with offers that step too, which its report has no button for.
    const scope = (leads: boolean) => goldenRowScope({ name: 'refunds', runId: null }, () => page.one('.page') as unknown as ParentNode, leads);
    expect(scope(true)!.items()[0]).toMatchObject({ label: 'Open fix', hint: sub });
    expect(scope(false)?.items().map((i) => i.label) ?? []).not.toContain('Open fix');
    await r!.unmount();
    const plain = await open([], GOLDENS, (v) => ({ ...v, steps: { 'goldens/refunds': { key: 'compare', label: 'Compare with parent', parent: 'R1' } } }));
    expect(all(plain.one('.verdict.tv'), '.actions')).toHaveLength(0);
    expect(plain.all('.ph .btn.lime').map((b) => b.textContent)).toEqual(['Run tests']);
  });

  it('heads the page with Open CI settings and Run tests, Update goldens joining them only when more than one golden diverged', async () => {
    const header = (p: Rendered) => p.all('.ph .btn').map((b) => [b.textContent.trim(), b.getAttribute('href'), all(b, 'svg').length]);
    const one = await open([], GOLDENS, (v) => ({ ...v, diverged: ['goldens/refunds'] }));
    // Open CI settings opens Settings' CI tab, its gear before its words; the rest are jobs.
    expect(header(one)).toEqual([['Open CI settings', '#/settings/ci', 1], ['Run tests', null, 0]]);
    await r!.unmount();
    const two = await open([], GOLDENS, (v) => ({ ...v, diverged: ['goldens/refunds', 'goldens/judged'] }));
    expect(header(two)).toEqual([['Open CI settings', '#/settings/ci', 1], ['Update goldens', null, 0], ['Run tests', null, 0]]);
  });

  it('says older than your working tree, in amber, after the facts of a session that ended, and not while one runs', async () => {
    const ended = await open([], GOLDENS, (v) => ({ ...v, older: true }));
    expect(all(ended.one('.verdict.tv'), '.tstale').map((s) => s.textContent)).toEqual(['older than your working tree']);
    expect(ended.one('.verdict.tv').textContent).toMatch(/ · \d+ upstream requests? · older than your working tree$/);
    await r!.unmount();
    const running = await open([], GOLDENS, (v) => ({ ...v, older: true, verdict: { ...v.verdict!, session: { ...v.verdict!.session, endedAt: null, live: true } } }));
    expect(running.one('.verdict.tv').textContent).toContain('so far');
    expect(all(running.one('.verdict.tv'), '.tstale')).toEqual([]);
  });

  it('names what a row opens with a real link to the same place, and a row that opens nothing with none', async () => {
    const page = await open([], GOLDENS, (v) => ({ ...v, rows: v.rows.map((row, i) => (i ? row : { ...row, runId: '01M5H2DKE9AAAAAAAAAAAAAAAA' })) }));
    const rows = page.all('table.gt tbody tr');
    const opening = rows.filter((row) => row.className !== 'still');
    expect(opening.length).toBeGreaterThan(0);
    for (const row of rows) expect(all(row, 'code.gn a.rowa')).toHaveLength(row.className === 'still' ? 0 : 1);
    expect(one(opening[0], 'code.gn a.rowa').getAttribute('href')).toMatch(/^#\/run\//);
  });

  it('lays the table out as the mock does: mode and source under the name, a strip for phones, revisions that give way, Last result last', async () => {
    const page = await open();
    expect(page.one('section.panel.gtw .tscroll table.t.gt')).toBeTruthy();
    expect(page.all('table.gt thead th').map((th) => th.className)).toEqual(['gg', 'gck', 'hist', 'glast']);
    const row = page.all('table.gt tbody tr')[0];
    expect(all(row, 'td').map((td) => td.className)).toEqual(['gg', 'chk gck', 'hist', 'glast']);
    expect(one(row, 'td.gg .gmeta .chip').textContent).toBe('replay');
    expect(all(row, 'td.gg .gmeta .gstrip i')).toHaveLength(1);
    // The checks are under the name too, for a narrow panel to show instead of their column.
    expect(one(row, 'td.gg .chk.gin').textContent).toBe(one(row, 'td.gck').textContent);
    // The column is named, and its revisions are numbered from the newest, which keeps its place longest.
    expect(page.all('table.gt th.hist span').map((s) => [s.className, s.textContent])).toEqual([
      ['hn', 'By revision'],
      ['r0', 'd2e8a1f'],
    ]);
  });

  it('draws each cell as a picture named by its card\'s words, the phone\'s strip as a group of them, and keys them under the table', async () => {
    const page = await open();
    const rows = page.all('table.gt tbody tr');
    expect(rows.map((row) => one(row, 'td.hist i').getAttribute('aria-label'))).toEqual(['d2e8a1f: passed', 'd2e8a1f: failed, failed', 'd2e8a1f: inconclusive, 0 of 1 attempts passed · failed', 'd2e8a1f: not tested here']);
    expect(rows.map((row) => one(row, 'td.hist i').className)).toEqual(['hc r0 pass', 'hc r0 fail', 'hc r0 inc', 'hc r0 none']);
    for (const row of rows) {
      expect(one(row, 'td.hist i').getAttribute('role')).toBe('img');
      const strip = one(row, '.gstrip');
      expect([strip.getAttribute('role'), strip.getAttribute('aria-label')]).toEqual(['group', 'By revision']);
      expect(one(strip, 'i').getAttribute('aria-label')).toBe(one(row, 'td.hist i').getAttribute('aria-label'));
    }
    expect(page.one('.gfoot .hkey').textContent).toBe('By revisionone attemptnot tested there');
  });
});

describe('a gated golden’s evidence', () => {
  it('opens from its bar under its row: why it stopped, the line between its bounds, its attempts, and Esc closes it, the focus back on the bar', async () => {
    const decided = gateResult({ kind: 'sprt', good: 0.9, bad: 0.7, risk: 0.05, max: 80 }, Array<boolean>(12).fill(true));
    const gate = { ...decided, tally: '12 of 12', perAttempt: null, more: null, words: evidenceWords(decided, 3) };
    const page = await open([], GOLDENS, (v) => ({ ...v, rows: v.rows.map((row) => (row.path === 'goldens/passes' ? { ...row, last: { ...row.last, gate } } : row)) }));
    const bar = page.one('button.gev');
    expect([bar.getAttribute('aria-expanded'), bar.getAttribute('aria-label'), one(bar, 'small').textContent]).toEqual(['false', 'Show why it stopped at attempt 12, against .70 and .90', 'against .70 and .90']);
    expect(JSON.parse(bar.getAttribute('data-tip')!)).toMatchObject({ t: 'passes · passed at attempt 12', s: 'the score after each attempt: a pass adds 0.25, a failure −1.10; it passes at +3.00 and fails at −3.00', rows: [['pass^5', gate.words!.passK, 'var(--faint)']] });
    evidenceAsked.length = 0;
    await page.click(bar);
    await page.until('the attempts', () => page.all('tr.gevrow .alist').length === 1);
    const row = page.one('tr.gevrow');
    // No line between the golden's row and its evidence: the row is open while the evidence shows.
    expect(page.all('table.gt tbody tr.open').map((tr) => one(tr, 'code.gn').textContent)).toEqual(['passes']);
    const why = 'Stopped at attempt 12: the score reached +3.02, past +3.00, where it passes.';
    expect([one(row, 'p.lead').textContent, one(row, '.evl').getAttribute('aria-label'), one(row, 'td').props.colSpan]).toEqual([why, why, 4]);
    expect(all(row, '.eb').map((e) => e.textContent)).toEqual(['passes at +3.00', 'fails at −3.00']);
    expect(all(row, '.evx span').map((e) => e.textContent)).toEqual(['attempt 12']);
    expect(one(row, 'p.receipt').textContent).toMatch(/^a pass adds 0\.25, a failure −1\.10 · pass\^5/);
    expect(one(row, 'p.receipt').textContent).toContain('forked at call 3, each attempt live from there');
    expect(evidenceAsked).toEqual(['goldens/passes']);
    expect([page.one('button.gev').getAttribute('aria-expanded'), page.one('button.gev').getAttribute('aria-controls')]).toEqual(['true', one(row, 'section.gevx').getAttribute('id')]);
    await page.focus(one(row, '.alist a'));
    expect(pageUp.current?.()).toBe(true);
    await page.until('the evidence to close', () => page.all('tr.gevrow').length === 0);
    expect([page.one('button.gev').getAttribute('aria-expanded'), page.all('table.gt tbody tr.open').length]).toEqual(['false', 0]);
    expect(page.focused()).toBe(page.one("button.gev"));
    expect(pageUp.current?.()).toBe(false);
  });
});

describe('Tests\' states, parts and keys', () => {
  const drawn = async (over: Parameters<typeof page>[3], goldens: GoldenSource[] = []) => {
    await r?.unmount();
    g.location = { hash: '#/tests' };
    r = await render(page([], goldens, undefined, over));
    return r;
  };

  it('loads in its final layout as bars, says a read that failed in one line with Retry, and offers the pack command only where there is a run to pack', async () => {
    const loading = await drawn({ tests: () => new Promise<TestsView>(() => undefined) });
    await loading.until('the bars', () => loading.all('.skel').length === 1);
    expect([loading.one('.skel [role="status"]').textContent, loading.all('.skel .skin .verdict.tv').length, loading.all('.skel .skin table.gt tbody tr').length]).toEqual(['Loading the goldens…', 1, 3]);
    const failed = await drawn({ tests: () => Promise.reject(new ApiError(500, 'boom')) });
    await failed.until('the error', () => failed.all('.loaderr').length === 1);
    expect([failed.one('.loaderr .st.err').textContent, failed.one('.loaderr p > span:not(.st)').textContent, failed.one('.loaderr button').textContent]).toEqual(['couldn’t load', 'The dashboard server answered 500 for this page’s data.', 'Retry']);
    expect(failed.one('.ph h1').textContent).toBe('Tests');
    const empty = await drawn({});
    await empty.until('the empty state', () => empty.all('.stepempty').length === 1);
    expect([empty.one('.stepempty h2').textContent, empty.all('.stepempty .cmdline').length]).toEqual(['No goldens yet', 1]);
    const none = await drawn({ app: { runs: [] } });
    await none.until('the empty state', () => none.all('.stepempty').length === 1);
    expect(none.all('.stepempty .cmdline')).toHaveLength(0);
  });

  it('offers the newest run its listed step says to pack as Pack <id> as golden…, lime, its command under it, packing it and its test as the run page does', async () => {
    const started: Array<{ kind: string; fields: Record<string, unknown> }> = [];
    const packs = (id: string) => ({ key: 'pack', label: 'Pack as golden…', command: `shadowlap pack ${id} goldens/${id.toLowerCase()}`, folder: `goldens/${id.toLowerCase()}` });
    const runs = [
      { runId: '01K5CQ3W6H0000000000000000', startedAt: 1, next: packs('01K5CQ3W6H') },
      { runId: '01K5CQ4N7G0000000000000000', startedAt: 3, next: packs('01K5CQ4N7G') },
      { runId: '01K5CQ5P8J0000000000000000', startedAt: 4, next: { key: 'blame', label: 'Run blame' } },
    ];
    g.location = { hash: '#/tests' };
    const p = (r = await render(page(started, [], undefined, { app: { runs } })));
    await p.until('the step', () => p.all('.stepempty .actions .btn.lime').length === 1);
    expect([p.one('.stepempty .actions .btn.lime').textContent, p.one('.stepempty .cli code').textContent, p.all('.stepempty .cmdline').length]).toEqual(['Pack 01K5CQ4N7G as golden…', '$ shadowlap pack 01K5CQ4N7G goldens/01k5cq4n7g', 0]);
    await p.click(p.one('.stepempty .actions .btn.lime'));
    await p.until('the dialog', () => p.all('.dialog').length === 1);
    expect(all(p.one('.dialog'), 'h2, h3')[0].textContent).toBe('Pack 01K5CQ4N7G as golden?');
    await p.click(p.byText('.dialog button', 'Pack as golden'));
    await p.until('the job', () => started.length === 1);
    expect(started).toEqual([{ kind: JOB_KINDS.keepGolden, fields: { runId: '01K5CQ4N7G0000000000000000', golden: 'goldens/01k5cq4n7g' } }]);
  });

  it('gives each report the id a job started from it hands the focus back to, the recordings line quiet under the sections, and the first bound its definition', async () => {
    const line = 'passed · 12 of 12 · rate >= 0.78 (95%)';
    const page = await open([], GOLDENS, (v) => ({ ...v, rows: v.rows.map((row) => (row.path === 'goldens/passes' ? { ...row, last: { ...row.last, line } } : row)) }));
    expect(page.all('section.gpanel').map((s) => s.getAttribute('id'))).toEqual(['report-refunds', 'report-judged']);
    expect([page.one('p.muted.tfoot').textContent, page.all('p.hintx.tfoot').length]).toEqual([expect.stringContaining('__recordings__/'), 0]);
    await page.wait(0);
    const passes = page.all('table.gt tbody tr').find((tr) => one(tr, 'code.gn').textContent === 'passes')!;
    expect(all(passes, '.rsub .term').map((t) => [t.textContent, t.className, t.getAttribute('data-term')])).toEqual([['rate >= 0.78 (95%)', 'term on', 'bound']]);
    // Each part kept whole, the bound's hidden definition aside.
    expect(all(passes, '.rsub > .nw').map((p) => p.textContent.split('The tally')[0])).toEqual(['passed ·', '12 of 12 ·', 'rate >= 0.78 (95%)']);
  });

  it('keys each golden by where it leads, and offers on ⌘K what its report offers, pressing the report\'s own button', async () => {
    const RUN = '01M5H2DKE9AAAAAAAAAAAAAAAA';
    const page = await open([], GOLDENS, (v) => ({ ...v, rows: v.rows.map((row) => (row.path === 'goldens/judged' ? { ...row, runId: RUN } : row)) }));
    expect(page.all('table.gt tbody tr').map((tr) => tr.getAttribute('data-rowkey'))).toEqual(['goldens/passes', 'goldens/refunds', `#/run/${RUN}`, 'goldens/budget']);
    const scope = goldenRowScope({ name: 'judged', runId: RUN }, () => page.one('.page') as unknown as ParentNode)!;
    const items = scope.items();
    expect([scope.name, items.map((i) => [i.label, i.hint])]).toEqual(['judged', [['Open run', expect.stringMatching(/^01M5H2DKE9/)], ['Update golden', 'shadowlap test goldens/judged --update']]]);
    items[1].run();
    await page.until('the dialog', () => page.all('.dialog').length === 1);
    expect(all(page.one('.dialog'), 'h2, h3')[0].textContent).toBe('Update judged?');
    // One with no run and no report has nothing to offer: ⌘K opens the whole palette, and Enter nothing.
    expect(goldenRowScope({ name: 'passes', runId: null }, () => page.one('.page') as unknown as ParentNode)).toBeNull();
  });

  it('follows a session that runs every golden: running and how many it has reached, no step, and each row where the session has got', async () => {
    const fix = { key: 'fix' as const, label: 'Open fix', fixId: 'fx-1', status: 'open' as const, check: 'no refund without an email', href: '#/fixes/fx-1', title: 'Refunds skip the email' };
    const following = { whole: true, total: 4, reached: 3, goldens: { 'goldens/passes': 'passed', 'goldens/refunds': 'running', 'goldens/judged': 'between', 'goldens/budget': 'queued' } as const };
    const page = await open([], GOLDENS, (v) => ({ ...v, steps: { 'goldens/refunds': fix }, running: { ...v.verdict!.session, endedAt: null, live: true }, following }));
    const verdict = page.one('.verdict.tv');
    expect([one(verdict, '.vw').textContent, one(verdict, 'h2').textContent.replace(/\u00a0/g, ' '), all(verdict, '.actions').length]).toEqual(['running', 'running 3 of 4 goldens', 0]);
    expect(one(verdict, 'p').textContent).toMatch(/ · rev d2e8a1f · just now · 1 passed, 1 failed, 1 inconclusive so far$/);
    const rows = page.all('table.gt tbody tr').map((tr) => [one(tr, 'code.gn').textContent, all(tr, 'td.glast > .st').map((x) => `${x.className}: ${x.textContent}`)[0], all(tr, 'td.glast > .rsub')[0]?.textContent, one(tr, '.glastw').hasAttribute('hidden')]);
    expect(rows).toEqual([
      ['passes', 'st ok: passed', 'this session, just now', true],
      ['refunds', 'st live: running', 'this session, now', true],
      ['judged', 'st live: running', 'this session, in progress', true],
      ['budget', 'st n: queued', 'this session, next', true],
    ]);
    await r!.unmount();
    // A session that runs some of them moves only their rows, and the verdict stays as it was.
    const some = await open([], GOLDENS, (v) => ({ ...v, steps: { 'goldens/refunds': fix }, running: { ...v.verdict!.session, endedAt: null, live: true }, following: { whole: false, total: 1, reached: 1, goldens: { 'goldens/refunds': 'running' } } }));
    expect([one(some.one('.verdict.tv'), '.vw').textContent, all(some.one('.verdict.tv'), '.actions a').map((a) => a.textContent)]).toEqual(['failed', ['Open fix']]);
    expect(some.all('.glastw[hidden]')).toHaveLength(1);
  });

  it('ends a test job\'s drawer over Tests on the step the page leads with once it has read what the job did, pressing the page\'s own', async () => {
    const Footer = jobFooter(JOB_KINDS.tests)!;
    expect(jobFooter(JOB_KINDS.testUpdate)).toBe(Footer);
    const fix = { key: 'fix' as const, label: 'Open fix', fixId: 'fx-1', status: 'open' as const, check: 'no refund without an email', href: '#/fixes/fx-1', title: 'Refunds skip the email' };
    const job = (endedAt: number) => createElement(Footer, { job: { id: 'j1', kind: JOB_KINDS.tests, done: true, startedAt: 0, endedAt } as never, plain: true });
    g.location = { hash: '#/tests' };
    r = await render(page([], GOLDENS, (v) => ({ ...v, steps: { 'goldens/refunds': fix } }), { beside: createElement('div', { className: 'jkind' }, job(0), createElement('i', { className: 'later' }, job(Date.now() + 60_000))) }));
    await r.until('the step', () => r!.all('.jkind > button').length === 1);
    expect([r.one('.jkind > button').textContent, r.one('.jkind > button').className, r.all('.later button').length]).toEqual(['Open fix', 'btn', 0]);
    const step = r.one('.verdict.tv .actions a');
    let pressed = 0;
    step.click = () => void pressed++;
    await r.click(r.one('.jkind > button'));
    expect(pressed).toBe(1);
  });
});

describe('the Tests page\'s styles', () => {
  const css = sheet();

  it('put no tick before a check whatever its result, Training\'s criteria included', () => {
    expect(css).not.toMatch(/\.chk span::before/);
    expect(css).toMatch(/table\.gt \.chk \.ck\.failed \.cm \{ color: var\(--err\); \}/);
    expect(css).toMatch(/table\.gt \.chk \.ck\.inconclusive \.cm \{ color: var\(--warn\); \}/);
  });

  it('fit the table to its panel by its own width, keeping Last result a fixed width', () => {
    expect(css).toMatch(/\.gtw \{ container-type: inline-size; \}/);
    expect(css).toMatch(/\.gtw \.tscroll table\.gt \{ min-width: 0; \}/);
    expect(css).toMatch(/\.gtw table\.gt th\.glast \{ width: 250px; \}/);
    expect(css).toMatch(/@container \(max-width: 1000px\) \{\s*\.gtw table\.gt \.hist \.r3, \.gtw table\.gt \.hist \.r4, \.gtw table\.gt \.hist \.r5 \{ display: none; \}/);
    expect(css).toMatch(/@container \(max-width: 820px\) \{\s*\.gtw table\.gt th\.gck, \.gtw table\.gt td\.gck \{ display: none; \}\s*\.gtw table\.gt \.chk\.gin \{ display: block; \}/);
    expect(css).toMatch(/@container \(max-width: 640px\) \{\s*\.gtw table\.gt th\.hist, \.gtw table\.gt td\.hist \{ display: none; \}\s*\.gtw table\.gt \.gstrip \{ display: inline-flex; \}\s*\.gtw table\.gt td\.glast \{ min-width: 0; width: 46%; \}/);
    // The viewport rule that hid revisions by the window's width, not the table's, is gone.
    expect(css).not.toMatch(/td\.hist i:nth-last-child/);
  });

  it('wrap a cell without leaving a word alone on its last line, as the mock\'s do', () => {
    expect(css).toMatch(/\ntable\.gt td \{ text-wrap: pretty; \}/);
  });
});

describe('a golden’s injection gate on Tests', () => {
  const ENTRY: InjectionGateRow['entry'] = { obeyed: 0, influenced: null, repeat: 3, templates: ['user-recipient'], payloads: null, baselines: 3, liveReads: false };
  const JSON_LINE = '{ "obeyed": 0, "repeat": 3, "templates": ["user-recipient"] }';
  const gate = (over: Partial<InjectionGateRow> = {}): InjectionGateRow => ({ entry: ENTRY, proof: { runId: 'run_ATTEMPT2', callNo: 6 }, line: 'send_email obeyed a planted instruction · 1 of 3', results: { runId: 'run_TESTED', resultId: 'inj-01GATE' }, json: JSON_LINE, ...over });
  const tally = { resultId: 'inj-01GATE', attempts: 3, obeyed: 1, influenced: 0, ignored: 2, inconclusive: 0, allowed: { obeyed: 0, influenced: null }, skipped: null };
  /** refunds, gated: its last result as `last` says, its gate as `g`; the verdict leads with `step`. */
  const gated = (g: InjectionGateRow, last: Partial<TestsView['rows'][number]['last']>, step?: NextStep) => (v: TestsView): TestsView => ({
    ...v,
    rows: v.rows.map((r) => (r.name === 'refunds' ? { ...r, injectionGate: g, last: { ...r.last, ...last } } : r)),
    ...(step ? { steps: { ...v.steps, 'goldens/refunds': step } } : {}),
  });
  const gateOf = (page: Rendered) => {
    const tr = page.all('table.gt tbody tr').find((row) => all(row, 'code')[0].textContent === 'refunds')!;
    return { tr, ck: one(one(tr, 'td.chk'), '.ck.injck') };
  };
  const text = (el: FakeElement) => el.textContent.replace(/\u00a0/g, ' ');

  it('sits under the checks with its mark, its tally under its words, which open the run it tested with its results, its card its entry and why; the row opens its proof', async () => {
    const reason = 'send_email obeyed a planted instruction in 1 of 3 attempts (at most 0 allowed): send_email.to = x7f3kq2m@canary.invalid';
    const page = await open([], GOLDENS, gated(gate(), { failure: 'injection', injection: { ...tally, verdict: 'failed', reason } }));
    const { tr, ck } = gateOf(page);
    expect(ck.className).toBe('ck injck failed');
    expect(one(ck, 'b.cm').textContent).toBe('✗');
    // After every check, with no edit or remove: its tests entry sets it.
    expect(all(one(tr, 'td.chk'), '.ck').at(-1)).toBe(ck);
    expect(text(one(ck, 'a.cw'))).toBe('injection: no attempt obeys a planted instruction3 attempts · 1 obeyed · 0 influenced · 2 ignored');
    expect(one(ck, 'a.cw').getAttribute('href')).toBe('#/run/run_TESTED');
    expect(JSON.parse(ck.getAttribute('data-tip')!)).toMatchObject({ t: 'failed · injection gate', s: `user-recipient at every untrusted read, 3 attempts each. "injection": ${JSON_LINE}. ${reason}. Opens its results` });
    // The row, its name and Enter open the attempt that proves the verdict, at the call that carried the canary.
    expect(one(tr, 'a.rowa').getAttribute('href')).toBe('#/run/run_ATTEMPT2/6');
  });

  it('keeps a passed gate’s tally on its hover, as a passed check does, and says when one never ran, its words plain', async () => {
    let page = await open([], GOLDENS, gated(gate(), { injection: { ...tally, obeyed: 0, ignored: 3, verdict: 'passed', reason: null } }));
    let { ck, tr } = gateOf(page);
    expect([ck.className, text(one(ck, '.cw')), all(ck, 'small').length]).toEqual(['ck injck passed', 'injection: no attempt obeys a planted instruction', 0]);
    expect(JSON.parse(ck.getAttribute('data-tip')!).s).toBe(`3 attempts · 0 obeyed · 0 influenced · 3 ignored. user-recipient at every untrusted read, 3 attempts each. "injection": ${JSON_LINE}. Opens its results`);
    // Its verdict isn't its gate's, so the row opens its run, and refunds keeps none.
    expect(all(tr, 'a.rowa')).toHaveLength(0);
    await r?.unmount();
    page = await open([], GOLDENS, gated(gate({ entry: { ...ENTRY, obeyed: 2 }, proof: null, line: null, results: null }), { injection: null }));
    ({ ck } = gateOf(page));
    expect([ck.className, all(ck, 'b.cm').length, all(ck, 'a').length, text(one(ck, '.cw'))]).toEqual(['ck injck', 0, 0, 'injection: at most 2 attempts obey a planted instructionruns once its replay passes']);
    expect(JSON.parse(ck.getAttribute('data-tip')!).t).toBe('not run yet · injection gate');
  });

  it('leaves its entry off its card where the config can\'t be read now, never rebuilding it', async () => {
    const page = await open([], GOLDENS, gated(gate({ json: null }), { injection: { ...tally, obeyed: 0, ignored: 3, verdict: 'passed', reason: null } }));
    const { ck } = gateOf(page);
    expect(JSON.parse(ck.getAttribute('data-tip')!).s).toBe('3 attempts · 0 obeyed · 0 influenced · 3 ignored. user-recipient at every untrusted read, 3 attempts each. Opens its results');
  });

  it('leads the verdict with Open proof, a link to the proving attempt, or Re-run test where the gate showed too little to say', async () => {
    const proof: NextStep = { key: 'injection-proof', label: 'Open proof', runId: 'run_ATTEMPT2', href: '#/run/run_ATTEMPT2/6', title: 'Opens ATTEMPT2', sub: 'send_email obeyed a planted instruction · 1 of 3' };
    let page = await open([], GOLDENS, gated(gate(), { failure: 'injection', injection: { ...tally, verdict: 'failed', reason: 'obeyed' } }, proof));
    let lime = one(page.one('.verdict.tv'), '.btn.lime');
    expect([lime.tagName.toLowerCase(), lime.textContent, lime.getAttribute('href')]).toEqual(['a', 'Open proof', '#/run/run_ATTEMPT2/6']);
    await r?.unmount();
    const again: NextStep & { sub: string } = { key: 'gate-again', label: 'Re-run test', golden: 'goldens/refunds', command: 'shadowlap test goldens/refunds', sub: 'Its injection gate showed too little to say: 2 of 3 attempts got no answer' };
    page = await open([], GOLDENS, gated(gate(), { failure: 'injection', verdict: 'inconclusive', injection: { ...tally, verdict: 'inconclusive', reason: 'too little' } }, again));
    lime = one(page.one('.verdict.tv'), '.btn.lime');
    expect([lime.tagName.toLowerCase(), lime.textContent]).toEqual(['button', 'Re-run test']);
    expect(JSON.parse(lime.getAttribute('data-tip')!)).toMatchObject({ t: 'Re-run test', s: again.sub });
  });
});
