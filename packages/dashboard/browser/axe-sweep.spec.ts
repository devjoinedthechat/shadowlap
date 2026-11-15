import { expect, test, type Page, type Route } from '@playwright/test';
import { dash, demoId, openPage, seriousViolations } from './dashboard.js';
import { apiRequests, asksFirst, at, cardStates, click, compareOpen, DIALOG, dialogWalk, escape, fixes, MENU, NOT_FOUND, overlayStates, presetsRecording, press, previews, revision, run, runs, settled, sweep, updateGoldens, VERDICTS, type State } from './routes.js';
import { routePrCommentFixture } from './pr-comment-fixture.js';
import { openReport, routeTestsFixture } from './tests-fixture.js';

/**
 * axe-core's WCAG 2.2 A and AA rules over everything the whole demo shows: every page, every run with
 * each view, its inspector's tabs, its menus and dialogs, Fixes and each fix's steps, Tests and its
 * dialogs, a gated golden's evidence, Settings' tabs, the team store's setup, the palette, the shortcuts on every kind of page,
 * the pull request comment's preview with every part, a merged session's flag and its card,
 * a toast with Undo and the bar that says the dashboard can't be reached; and again on a phone, 390 px
 * wide, with a not-found page of each kind and Runs while its table loads and once its read failed.
 * Any serious or critical violation fails, named with the state it was found in.
 */

// A route may still be reading the server's answer as a test ends; the page's close takes it away, and that is no failure.
test.afterEach(({ page }) => page.unrouteAll({ behavior: 'ignoreErrors' }));

/**
 * Runs with its table's read held, its rows drawn as quiet bars, then answered 500, the error line
 * with Retry in the table's place. The table reads `/api/runs/page?…`; the shell's own run list,
 * `/api/runs`, answers as ever. Opened from another page, so Runs starts its read anew.
 */
function runsTableHeld(page: Page): Array<[string, () => Promise<void>]> {
  const TABLE = /\/api\/runs\/page/;
  const held: Route[] = [];
  const fail = (route: Route) => route.fulfill({ status: 500, body: '' });
  // Held, then answered 500. The route goes only once nothing is held: its going lets what it holds through.
  let answer = (route: Route) => void held.push(route);
  const loading = async () => {
    const open = apiRequests(page);
    await page.route(TABLE, (route) => answer(route));
    await openPage(page, '/runs', 'main#view .runsec .rskrun');
    // Every other read back, so axe reads the page as it stays while the table waits.
    await expect.poll(() => [...open].map((r) => new URL(r.url()).pathname).filter((p) => p !== '/api/runs/page'), { timeout: 60_000, intervals: [25] }).toEqual([]);
    await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  };
  const failed = async () => {
    answer = (route) => void fail(route);
    await Promise.all(held.splice(0).map(fail));
    await settled(page, { shows: 'main#view .runsec .loaderr' });
    await page.unroute(TABLE);
  };
  return [
    ['Runs while its table loads on a phone', loading],
    ['Runs when its table’s read failed on a phone', failed],
  ];
}
test.describe.configure({ timeout: 300_000 });

test('every page and Settings tab has no serious or critical axe violation', async ({ page }) => {
  const pages = ['/', '/runs', '/runs?types=capture', '/runs?types=test', '/runs?types=failed', '/runs?q=label%3Agood', '/fixes', '/tests', '/training', '/training/tasks', '/compare', '/new'];
  const settings = ['matching', 'redaction', 'ci', 'agents', 'tools', 'project', 'store'];
  const changes: State[] = [['/changes', at(page, '/changes', VERDICTS)], ['a revision’s page', revision(page)], ['/compare with a row open', compareOpen(page)], ...(await previews(page))];
  expect(await sweep(page, [...pages.map((p): [string, () => Promise<void>] => [p, at(page, p)]), ...changes, ...settings.map((t): [string, () => Promise<void>] => [`Settings → ${t}`, at(page, `/settings/${t}`)])])).toEqual([]);
});

test('every run of the demo, and every view of a few, has no serious or critical axe violation', async ({ page }) => {
  const all = runs().map(([name, id]): [string, () => Promise<void>] => [`run ${name}`, run(page, id)]);
  // A capture's Turns (litellm's, whose model called no tool, hold nothing that takes the focus) and a chat's too.
  const views = ['ticket', 'override', 'batchFork', 'eval', 'litellm', 'chat'].flatMap((name) => {
    const id = dash().runs[name] as string;
    return ['turns', 'context', 'timeline', 'forks', 'provenance', 'decisions'].map((v): [string, () => Promise<void>] => [`run ${name} · ${v}`, run(page, id, v)]);
  });
  expect(await sweep(page, [...all, ...views])).toEqual([]);
});

test('a run’s inspector tabs, menus and dialogs have no serious or critical axe violation', async ({ page }) => {
  const states: Array<[string, () => Promise<void>]> = [];
  for (const name of ['ticket', 'override', 'failTool', 'chat']) {
    const id = dash().runs[name] as string;
    states.push([`run ${name}`, run(page, id)]);
    for (const tab of ['Response', 'Request', 'Details', 'Conversation']) states.push([`run ${name} · inspector ${tab}`, click(page, '.insp [role="tablist"] button', tab, { shows: `.insp [role="tab"][aria-selected="true"]:has-text("${tab}")` })]);
    states.push([`run ${name} · Share`, click(page, '.rhead .actions button', 'Share', { shows: MENU })], [`run ${name} · Share closed`, escape(page, MENU)]);
    states.push([`run ${name} · the fork menu`, click(page, '#forkBtn', undefined, { shows: MENU })], [`run ${name} · the fork menu closed`, escape(page, MENU)]);
    states.push([`run ${name} · More`, click(page, '#moreBtn', undefined, { shows: MENU })], [`run ${name} · Delete`, click(page, `${MENU} [role="menuitem"]`, 'Delete run', { shows: DIALOG })], [`run ${name} · Delete closed`, escape(page)]);
  }
  // Edit and fork's dialog, from the inspector of the tool call the run failed at, which it opens on.
  states.push(['run failTool', run(page, dash().runs.failTool as string)], ['run failTool · Edit and fork', click(page, '.insp button', 'Edit and fork', { shows: DIALOG })], ['run failTool · Edit and fork closed', escape(page)]);
  // The check menu, from the inspector's Add check… on a tool call of the refund bug.
  states.push(['run refundBug', run(page, demoId('refundBug'))], ['run refundBug · a tool call', click(page, 'main#view tr[data-wi]:has(td.name[title="issue_refund"])')], ['run refundBug · the check menu', click(page, '[data-act="ckmenu"]', undefined, { shows: MENU })], ['run refundBug · the check menu closed', escape(page, MENU)]);
  // The presets' finding on their recording, and the matrix its Show results opens in the inspector's place.
  const results = 'main#view section.rmxp[data-kind="presets"]';
  states.push(['the presets’ recording', presetsRecording(page)], ['its presets’ results', click(page, 'button[data-act="results"][data-which="presets"]', undefined, { shows: results })]);
  expect(await sweep(page, states)).toEqual([]);
});

test('every overlay has no serious or critical axe violation: the switcher, a picker, a hover card, a dialog asking to discard, and each as a phone’s sheet', async ({ page }) => {
  // The overlays both sweeps open (routes.ts), then the hover cards for the keyboard's focus and the pointer's.
  const wide = await sweep(page, [...overlayStates(page), ...cardStates(page)]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect([...wide, ...(await sweep(page, overlayStates(page, ' on a phone')))]).toEqual([]);
});

test('Fixes and each fix’s steps, Tests’ dialogs, the palette, the shortcuts and a toast have no serious or critical axe violation', async ({ page }) => {
  // Held to Always ask, as the dialog sweep is: Run tests' question then waits whatever the demo's last
  // session spent, so pressing it starts no session (the suite's dashboards share one Spending).
  await page.route('**/api/user/spending', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: { askAbove: 0, set: true, problems: [] } }) : route.continue()));
  const states: Array<[string, () => Promise<void>]> = [];
  for (const fx of fixes()) for (const step of ['', '/blame', '/repair', '/verify']) states.push([`fix ${fx}${step}`, at(page, `/fixes/${fx}${step}`, 'fix')]);
  states.push(['Tests', at(page, '/tests')]);
  // Run tests' question: a session that runs goldens marked fork live asks first, and starts nothing
  // until it is answered (one that only replays would start at once, so then nothing is clicked).
  states.push(['Tests · Run tests asks', async () => {
    const runTests = page.locator('main#view button', { hasText: 'Run tests' });
    const forks = await page.locator('main#view table.gt .chip', { hasText: 'fork' }).count();
    if (!forks || !(await runTests.count()) || !(await runTests.first().isEnabled())) return;
    await runTests.first().click();
    await settled(page, { shows: DIALOG });
  }], ['Tests · Run tests asks · closed', escape(page)]);
  // Update goldens' dialog, as the palette opens it.
  states.push(['Tests · Update goldens', updateGoldens(page)], ['Tests · Update goldens closed', escape(page)]);
  states.push(['Runs', at(page, '/runs', 'main#view table.runst tbody tr')], ['Runs · Import capture…', click(page, 'main#view button', 'Import capture…', { shows: DIALOG })], ['Runs · import closed', escape(page)]);
  states.push(['Runs · a run ticked', click(page, 'main#view table.runst tbody tr input[type="checkbox"]')]);
  // The palette's hits in what was recorded come from the server: swept once they have come.
  // With the focus in the row, ⌘K opens on the row's actions; ⌫ goes back to everything.
  states.push(['the palette on a row’s actions', press(page, 'Meta+k', { shows: '.palette' })], ['the palette with results', async () => {
    await page.keyboard.press('Backspace');
    await page.keyboard.type('refund');
    await page.locator('#palList', { hasText: 'In recorded data' }).waitFor();
    await settled(page);
  }], ['the palette closed', escape(page, '.palette')]);
  // From the run ticked above, its checkbox focused again once the palette closed.
  states.push(['the shortcuts', press(page, '?', { shows: '.help' })], ['the shortcuts closed', escape(page, '.help')]);
  // The top bar's help menu: Keyboard shortcuts, Docs, Command line.
  states.push(['the help menu', click(page, '#helpBtn', undefined, { shows: '.pop.helpmenu' })], ['the help menu closed', escape(page, '.pop.helpmenu')]);
  // The shortcuts on pages of each kind: the keys that don't apply there are listed apart.
  for (const [where, path, drawn] of [['the Overview', '/', 'overview'], ['Runs', '/runs', 'runs'], ['Fixes', '/fixes', 'main#view'], ['Settings', '/settings/ci', 'main#view']] as const) {
    states.push([where, at(page, path, drawn)], [`the shortcuts on ${where}`, press(page, '?', { shows: '.help' })], [`the shortcuts on ${where} closed`, escape(page, '.help')]);
  }
  // A toast with Undo: the good/bad key pressed, then put back with u.
  states.push(['a run', run(page, dash().runs.ticket as string)], ['a toast with Undo', click(page, '.rhead .runkey button', 'good', { shows: '.toast button:has-text("Undo")' })]);
  const found = await sweep(page, states);
  await page.keyboard.press('u');
  expect(found).toEqual([]);
});

/**
 * Tests as the demo can't draw it (tests-fixture.ts): a gated golden's evidence open under its row,
 * a crash's and a failed gate's reports open with their tracebacks and lines as printed, the demo's
 * divergence's with its request diffed, then Update goldens for two goldens, with Add normalizer and
 * update, wide and on a phone.
 */
test('Tests with a gated golden’s evidence open, reports open, and Update goldens for two goldens, have no serious or critical axe violation, wide and on a phone', async ({ page }) => {
  // Every billed press asks, so Update goldens opens its dialog and starts nothing.
  await page.route('**/api/user/spending', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: { askAbove: 0, set: true, problems: [] } }) : route.continue()));
  const { crash, gate, diverged } = await routeTestsFixture(page);
  const states = (on: string): Array<[string, () => Promise<void>]> => [
    [`Tests${on}`, at(page, '/tests', 'main#view table.gt')],
    [`a gated golden’s evidence${on}`, click(page, 'main#view button.gev:not(.grptog)', undefined, { shows: 'main#view tr.gevrow .alist' })],
    [`a crash’s report, its traceback and its lines as printed${on}`, () => openReport(page, crash)],
    [`a failed gate’s report${on}`, () => openReport(page, gate)],
    [`a divergence’s report, its request diffed${on}`, async () => {
      await openReport(page, diverged);
      await page.locator(`main#view section[id="report-${diverged}"] .rpdiff .jl`).first().waitFor();
    }],
    [`Update goldens for two${on}`, async () => {
      await click(page, 'main#view button', 'Update goldens', { shows: DIALOG })();
      await expect(page.locator(DIALOG).getByRole('button', { name: 'Add normalizer and update' })).toBeVisible();
    }],
    [`Update goldens for two closed${on}`, escape(page)],
    // Closed again, as a page that stays drawn keeps it open: the phone's sweep opens it anew.
    [`a gated golden’s evidence closed${on}`, click(page, 'main#view button.gev:not(.grptog)', undefined, { hides: 'main#view tr.gevrow' })],
  ];
  const wide = await sweep(page, states(''));
  await page.setViewportSize({ width: 390, height: 844 });
  expect([...wide, ...(await sweep(page, states(' on a phone')))]).toEqual([]);
});

test('the pull request comment’s preview from Settings → CI and a revision’s page, and a session merged while failing, have no serious or critical axe violation, wide and on a phone', async ({ page }) => {
  await routePrCommentFixture(page);
  // Every part drawn: the decisions at rank 1 and 2, and the three injection gates.
  const preview = (on: string, where: string): Array<[string, () => Promise<void>]> => [
    [`Preview pull request comment from ${where}${on}`, async () => {
      await click(page, 'main#view button', 'Preview pull request comment', { shows: `${DIALOG} .prc` })();
      await expect(page.locator(`${DIALOG} .prc-d`)).toHaveCount(2);
      await expect(page.locator(`${DIALOG} .prc-i`)).toHaveCount(3);
    }],
    [`Preview pull request comment from ${where} closed${on}`, escape(page)],
  ];
  const states = (on: string): Array<[string, () => Promise<void>]> => [
    [`Settings → CI with the comment’s preview${on}`, at(page, '/settings/ci', 'main#view .prpanel')],
    ...preview(on, 'Settings → CI'),
    [`Verdicts with each session’s pull request${on}`, at(page, '/changes', VERDICTS)],
    [`the flag’s card${on}`, async () => {
      await page.mouse.move(2, 2);
      await page.locator('main#view .rsub.vdflag').first().focus();
      await settled(page, { shows: '#tip' });
    }],
    [`a revision’s page with what its comment carried${on}`, async () => {
      await revision(page)();
      await expect(page.locator('main#view .vdkv dt')).toHaveCount(4);
    }],
    ...preview(on, 'a revision’s page'),
  ];
  const wide = await sweep(page, states(''));
  await page.setViewportSize({ width: 390, height: 844 });
  expect([...wide, ...(await sweep(page, states(' on a phone')))]).toEqual([]);
});

test('the bar that says the dashboard can’t be reached has no serious or critical axe violation', async ({ page }) => {
  await openPage(page, `/run/${dash().runs.ticket as string}`, 'run');
  // The server stops answering: the bar comes once the page's next look fails.
  await page.route('**/api/**', (route) => route.abort());
  await page.waitForSelector('.connbar', { state: 'visible', timeout: 30_000 });
  expect((await seriousViolations(page)).map((v) => `the connection bar: ${v}`)).toEqual([]);
  await page.unroute('**/api/**');
});

test('on a phone, every page, Settings tab, fix step and dialog has no serious or critical axe violation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const states: State[] = [];
  for (const p of ['/', '/runs', '/runs?types=failed', '/fixes', '/tests', '/training', '/compare', '/new', '/setup/store']) states.push([`${p} on a phone`, at(page, p)]);
  states.push(['/changes on a phone', at(page, '/changes', VERDICTS)], ['a revision’s page on a phone', revision(page)], ['/compare with a row open on a phone', compareOpen(page)], ...(await previews(page, ' on a phone')));
  for (const t of ['matching', 'redaction', 'ci', 'agents', 'tools', 'project', 'store']) states.push([`Settings → ${t} on a phone`, at(page, `/settings/${t}`)]);
  for (const fx of fixes()) for (const step of ['', '/blame', '/repair', '/verify']) states.push([`fix ${fx}${step} on a phone`, at(page, `/fixes/${fx}${step}`, 'fix')]);
  for (const name of ['ticket', 'litellm', 'batchFork']) {
    const id = dash().runs[name] as string;
    for (const v of ['', 'turns', 'timeline']) states.push([`run ${name}${v ? ` · ${v}` : ''} on a phone`, run(page, id, v)]);
  }
  states.push(['Runs on a phone', at(page, '/runs', 'main#view table.runst tbody tr')], ['Runs · Import capture… on a phone', click(page, 'main#view button', 'Import capture…', { shows: DIALOG })], ['Runs · import closed on a phone', escape(page)]);
  // A link that names nothing, of each kind; then Runs while its table loads, and once its read failed.
  for (const p of ['/nowhere', '/run/01ZZZZZZZZZZZZZZZZZZZZZZZZ', '/fixes/fx-nope']) states.push([`${p} on a phone`, at(page, p, NOT_FOUND)]);
  states.push(...runsTableHeld(page));
  expect(await sweep(page, states)).toEqual([]);
});

/**
 * The dialogs the demo can show, each opened as its page opens it, at 1440 and as a phone's sheet:
 * opening one runs nothing, a write forced live included. What the demo can't hold (a repair that
 * would end No fix to try, Show patch, Stop on a running repair, Run blame's check, Record run,
 * Replace skills, Clean up) is drawn in test/ui-dialog-anatomy.test.ts instead.
 */
test('every dialog has no serious or critical axe violation, wide and as a phone’s sheet', async ({ page }) => {
  test.setTimeout(600_000);
  // Every billed press asks on this page, whatever the suite's one Spending says, so opening a dialog runs nothing.
  await asksFirst(page);
  // The one list of dialogs both sweeps open (routes.ts), each as its page opens it.
  const dialogs = await dialogWalk(page);
  const wide = await sweep(page, dialogs().flat());
  await page.setViewportSize({ width: 390, height: 844 });
  expect([...wide, ...(await sweep(page, dialogs().flat()))]).toEqual([]);
});
