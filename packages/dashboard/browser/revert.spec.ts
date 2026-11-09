import { expect, test, type Page, type Route } from '@playwright/test';
import type { FailureView, FixDetail, FoundCommit, NextStep, TestsView } from '../ui/types.js';
import { demoId, openPage, seriousViolations } from './dashboard.js';

/**
 * Revert, once Find breaking commit named a crash's first bad commit, on invented data routed over the
 * demo's answers (the demo store has no crashed golden): on a crash's run page the commit's finding
 * leads, Show change opens the change in the inspector's place, and Revert leads the header with Open
 * in editor and Run blame plain; on Tests the change sits under the commit's card and Revert leads the
 * verdict; on the crash's fix its Blame step shows the commit, its change and where to look, and
 * Revert leads its head with Open in editor beside it and no Find breaking commit. Each has no
 * serious axe violation at 1440 and 390 with the change open, nor has Revert's
 * dialog, whose code box of the change undone keeps to its width. A revert's drawer reads Reverting,
 * then Reverted where git reverted, its status not saying reverted again, or Tried reverting where
 * git refused.
 */

const DIALOG = '[role="dialog"][aria-modal="true"]';
const REV = '9a3c5e0';
const GOLDEN = 'goldens/refund-flow';
const HUNK = '@@ -10,4 +10,4 @@ def refund(order):\n     total = order["amount"]\n-    limit = policy.limit(order)\n+    limit = policy.limit()\n     return min(total, limit)\n';
const FOUND: FoundCommit = {
  rev: REV,
  subject: 'Read the refund limit once per session',
  author: '',
  date: '2026-10-30T10:00:00Z',
  why: 'the agent exited 1',
  untested: [],
  replays: 3,
  tokens: 0,
  at: Date.now() - 60_000,
  change: { file: 'agent/refund.py', files: ['agent/refund.py'], hunk: HUNK, line: 12, cut: false, merge: false, path: 'agent/refund.py', outside: 0 },
};
const FREE = { kind: 'tests', usd: 0, ceiling: false, parts: ['replays offline'] };
const step = (runId: string) =>
  ({
    key: 'revert',
    label: 'Revert',
    golden: GOLDEN,
    rev: REV,
    merge: false,
    live: [],
    blame: { offer: { from: 'exit', expect: null, failed: [] }, sub: 'Whether an answer of the model’s lost the run', command: `shadowlap blame ${runId.slice(0, 10)}`, estimate: FREE },
    title: `Revert ${REV}`,
    sub: `${FOUND.subject}: undone in your working tree, then refund-flow replayed offline`,
    command: `git revert --no-commit ${REV} && shadowlap test ${GOLDEN}`,
    estimate: FREE,
  }) as unknown as NextStep;

/** The server's answer to the request, changed by `patch`: asked whole (never a 304 with no body to change). */
async function patched<T>(route: Route, patch: (body: T) => unknown): Promise<void> {
  const headers = Object.fromEntries(Object.entries(route.request().headers()).filter(([k]) => k !== 'if-none-match' && k !== 'if-modified-since'));
  const res = await route.fetch({ headers });
  const text = await res.text();
  await route.fulfill(text ? { response: res, json: patch(JSON.parse(text) as T) } : { response: res });
}

/** Open in editor's form on this machine, and the job kinds with revert among them. */
async function routeMeta(page: Page): Promise<void> {
  await page.route(/\/api\/meta(\?.*)?$/, (route) => patched<{ jobKinds: string[] }>(route, (meta) => ({ ...meta, editor: 'code --goto <file>:<line>', jobKinds: [...new Set([...meta.jobKinds, 'revert'])] })));
}

/** A demo run as a crashed test replay whose golden's first bad commit stands: its step and its offers. */
async function routeCrash(page: Page): Promise<string> {
  const run = demoId('ticket');
  await routeMeta(page);
  await page.route(new RegExp(`/api/runs/${run}/offers(\\?.*)?$`), (route) => patched<object>(route, (offers) => ({ ...offers, commit: FOUND })));
  await page.route(new RegExp(`/api/runs/${run}(\\?.*)?$`), (route) => patched<object>(route, (detail) => ({ ...detail, next: step(run) })));
  return run;
}

/** The demo's fix as a crash no model rescued, whose run's search named the commit: Revert leads it, and its Blame step shows the commit. */
async function routeCrashFix(page: Page): Promise<string> {
  const fix = demoId('refundFix');
  const run = await routeCrash(page);
  await page.route(new RegExp(`/api/runs/${run}/next(\\?.*)?$`), (route) => route.fulfill({ json: { next: step(run) } }));
  await page.route(new RegExp(`/api/fixes/${fix}(\\?.*)?$`), (route) =>
    patched<FixDetail>(route, (d) => ({
      ...d,
      status: 'open',
      lead: { key: 'revert', label: 'Revert', command: `git revert --no-commit ${REV} && shadowlap test ${GOLDEN}`, use: 'writes', runId: run, step: step(run) },
      blame: d.blame && { ...d.blame, outcome: 'unrescuable', answers: null, crash: { commit: FOUND, offline: true, stronger: false } },
    })),
  );
  return fix;
}

/** Tests with the demo's first golden crashed at the commit, its failure leading the verdict. */
async function routeTests(page: Page): Promise<void> {
  await routeMeta(page);
  const run = demoId('ticket');
  await page.route(
    (url) => url.pathname === '/api/tests',
    (route) => (route.request().method() !== 'GET' ? route.continue() : patched<TestsView>(route, (real) => {
      const row = real.rows.find((r) => r.path !== real.divergences[0]?.golden) ?? real.rows[0]!;
      const crash: FailureView = {
        golden: GOLDEN,
        name: row.name,
        runId: run,
        failure: 'exit',
        reason: 'the agent exited with code 1',
        checks: null,
        details: null,
        output: 'Traceback (most recent call last):\n  File "agent/refund.py", line 12, in refund\nTypeError: limit() missing 1 required positional argument: \'order\'',
        blocked: null,
        bisect: null,
        found: FOUND,
        missed: null,
        revisions: [],
        unreadable: null,
      } as unknown as FailureView;
      const view = {
        ...real,
        rows: real.rows.map((r) => (r.path === row.path ? { ...r, path: GOLDEN } : r)),
        failures: [crash, ...real.failures],
        verdict: real.verdict ? { ...real.verdict, state: 'failing', first: { golden: GOLDEN, name: row.name, reason: crash.reason, runId: run } } : real.verdict,
        steps: { ...(real.steps ?? {}), [GOLDEN]: step(run) },
      } as TestsView;
      return view;
    })),
  );
}

for (const [width, height] of [
  [1440, 900],
  [390, 844],
] as const) {
  test(`at ${width}×${height} a named crash's run page leads with its commit and Revert, its change open in the inspector's place passing axe`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const run = await routeCrash(page);
    await openPage(page, `/run/${run}`, 'run');
    const finding = page.locator('#view section', { has: page.locator('.bk', { hasText: 'first bad commit' }) }).first();
    await expect(finding.locator('code').first()).toHaveText(REV);
    await expect(finding.locator('.why .lead')).toHaveText(FOUND.subject);
    const lead = page.locator('.rhead .btn.lime[data-next="revert"]');
    await expect(lead).toHaveText('Revert');
    const toggle = page.locator('#view [data-act="change"]');
    await toggle.click();
    const panel = page.locator('#insp.fpanel[data-kind="change"]');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.fhead .ct')).toHaveText('The change at the first bad commit');
    await expect(panel.locator('.bisectdiff')).toContainText('agent/refund.py');
    await expect(toggle).toHaveText('Hide change');
    expect(await seriousViolations(page)).toEqual([]);
    if (width === 1440) {
      // Run blame plain before Revert, lime and the last button but the menu; Open in editor before Run blame unless folded.
      const names = (await page.locator('.rhead .actions button:visible').allTextContents()).map((n) => n.trim());
      const at = (name: string) => names.findIndex((n) => n.startsWith(name));
      console.log(`a named crash's header at 1440: ${names.join(' | ')}`);
      expect(at('Run blame')).toBeGreaterThanOrEqual(0);
      expect(at('Run blame')).toBeLessThan(at('Revert'));
      if (at('Open in editor') >= 0) expect(at('Open in editor')).toBeLessThan(at('Run blame'));
      expect(names.slice(at('Revert') + 1).every((n) => n === '…' || n === '')).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(page.locator('#insp.fpanel')).toHaveCount(0);
    await expect(toggle).toBeFocused();
  });

  test(`at ${width}×${height} a named crash's fix shows the commit and its change on its Blame step and leads with Revert, passing axe`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const fix = await routeCrashFix(page);
    await openPage(page, `/fixes/${fix}/blame`, 'fix');
    const line = page.locator('#view .bisect.fxbis');
    await expect(line.locator('code')).toHaveText(REV);
    await expect(line.locator('b')).toHaveText(FOUND.subject);
    await expect(page.locator('#view .bisect.fxbis + .codewrap.bisectdiff')).toContainText('agent/refund.py');
    await expect(page.locator('#view .fxnote')).toHaveText(`The agent stopped part way from ${REV} on, so the code broke the run, not an answer of the model’s. Revert the commit or fix the code, then run the tests.`);
    const lead = page.locator('.ph .actions .btn.lime[data-next="revert"]');
    await expect(lead).toHaveText('Revert');
    await expect(lead).toHaveAttribute('data-at', String(FOUND.at));
    expect(await seriousViolations(page)).toEqual([]);
    if (width === 1440) {
      // At most four, Revert lime and last with Open in editor before it; Find breaking commit stays on the run's page.
      const names = (await page.locator('.ph .actions button:visible').allTextContents()).map((n) => n.trim());
      console.log(`a named crash's fix head at 1440: ${names.join(' | ')}`);
      expect(names.slice(-2)).toEqual(['Open in editor', 'Revert']);
      expect(names.length).toBeLessThanOrEqual(4);
      expect(names.some((n) => n.startsWith('Find breaking commit'))).toBe(false);
      const title = await page.locator('.ph h1').evaluate((h) => h.getBoundingClientRect().width);
      expect(title).toBeGreaterThanOrEqual(520);
    }
  });

  test(`at ${width}×${height} Revert's dialog shows the change it undoes in a code box that keeps to its width, passing axe`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const run = await routeCrash(page);
    await openPage(page, `/run/${run}`, 'run');
    await page.locator('.rhead .btn.lime[data-next="revert"]').click();
    const dialog = page.locator(DIALOG);
    await expect(dialog).toContainText(`Revert ${REV}?`);
    const box = dialog.locator('pre.codebox.fxpatch');
    await expect(box.locator('.add')).toHaveText('+    limit = policy.limit(order)');
    await expect(box.locator('.del')).toHaveText('-    limit = policy.limit()');
    // An added line's ground reaches the box's edges without widening it: nothing to scroll sideways.
    expect(await box.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    expect(await seriousViolations(page)).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });

  test(`at ${width}×${height} Tests shows the commit's change under its card and leads with Revert, passing axe`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await routeTests(page);
    await openPage(page, '/tests', 'main#view .bisectdiff');
    // The demo's own divergence keeps its commit's change too; the crash's is the invented one.
    await expect(page.locator('#view .bisectdiff', { hasText: 'agent/refund.py' })).toBeVisible();
    await expect(page.locator('#view .btn.lime', { hasText: /^Revert$/ }).first()).toBeVisible();
    await expect(page.locator('#view')).toContainText('The agent stopped part way at the commit above: revert it or fix the code, then run the tests.');
    expect(await seriousViolations(page)).toEqual([]);
  });
}

test('a revert’s drawer reads Reverting, then Reverted once git reverted and the test ran, or Tried reverting where git refused', async ({ page }) => {
  const run = await routeCrash(page);
  const job = (git: 'done' | 'untouched', code: number | null, lines: string[]) => ({
    id: 'revertjob',
    kind: 'revert',
    title: `Reverting ${REV}`,
    args: ['test', GOLDEN],
    worktree: { folder: null, use: 'writes', doing: 'a commit is being reverted in your working tree' },
    runId: run,
    opensRun: false,
    startedAt: Date.now() - 1000,
    endedAt: code === null ? null : Date.now(),
    done: code !== null,
    stopped: false,
    code,
    git: code === null ? undefined : git,
    newRunId: null,
    runs: [],
    links: [],
    files: [],
    total: lines.length,
    lines,
    project: { id: 'support-agent', name: 'support-agent' },
  });
  const ends = [
    { git: 'done' as const, code: 1, lines: [`$ git revert --no-commit ${REV}`, `reverted ${REV} in your working tree · not committed`, `$ shadowlap test ${GOLDEN}`, '✗ 1 of 1 failed'], title: `Reverted ${REV}`, status: 'test failed · exit 1' },
    { git: 'untouched' as const, code: 128, lines: [`$ git revert --no-commit ${REV}`, 'error: Your local changes to the following files would be overwritten by merge:', '\tagent/refund.py'], title: `Tried reverting ${REV}`, status: 'not reverted · exit 128' },
  ];
  for (const end of ends) {
    let polls = 0;
    await page.unroute(/\/api\/jobs(\?.*)?$/);
    await page.unroute(/\/api\/jobs\/revertjob(\?.*)?$/);
    await page.route(/\/api\/jobs(\?.*)?$/, (route) => (route.request().method() === 'POST' ? route.fulfill({ status: 202, json: job(end.git, null, []) }) : route.fulfill({ json: { jobs: [] } })));
    await page.route(/\/api\/jobs\/revertjob(\?.*)?$/, (route) => route.fulfill({ json: ++polls >= 2 ? job(end.git, end.code, end.lines) : job(end.git, null, end.lines.slice(0, 1)) }));
    await openPage(page, `/run/${run}`, 'run');
    await page.locator('.rhead .btn.lime[data-next="revert"]').click();
    const dialog = page.locator(DIALOG);
    await expect(dialog).toContainText(`Revert ${REV}?`);
    await dialog.getByRole('button', { name: 'Revert', exact: true }).click();
    await expect(page.locator('#jtitle')).toHaveText(end.title);
    await expect(page.locator('section.drawer .st2').last()).toHaveText(end.status);
  }
});
