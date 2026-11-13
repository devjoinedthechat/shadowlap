import { expect, test, type Page, type Request, type Route } from '@playwright/test';
import { dash, openPage, seriousViolations } from './dashboard.js';
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

/** The demo's runs by name, each by its id: every run the demo names. */
function runs(): Array<[string, string]> {
  return Object.entries(dash().runs).flatMap(([name, v]) => (typeof v === 'string' && /^01[0-9A-Z]{24}$/.test(v) ? [[name, v] as [string, string]] : []));
}

/** The demo's fixes, by id. */
const fixes = () => Object.values(dash().runs).filter((v): v is string => typeof v === 'string' && v.startsWith('fx-'));

/** Each violation found, under the state it was found in. */
async function sweep(page: Page, states: Array<[string, () => Promise<void>]>): Promise<string[]> {
  const found: string[] = [];
  for (const [name, show] of states) {
    await show();
    for (const v of await seriousViolations(page)) found.push(`${name}: ${v}`);
  }
  return found;
}

/** The page's requests to the dashboard's API still out: what a view shows comes with them. */
const inFlight = new WeakMap<Page, Set<Request>>();
function apiRequests(page: Page): Set<Request> {
  let open = inFlight.get(page);
  if (!open) {
    const out = new Set<Request>();
    page.on('request', (r) => {
      if (new URL(r.url()).pathname.startsWith('/api/')) out.add(r);
    });
    page.on('requestfinished', (r) => out.delete(r));
    page.on('requestfailed', (r) => out.delete(r));
    inFlight.set(page, out);
    open = out;
  }
  return open;
}

/**
 * A state swept once it has settled, never after a time that a loaded machine can outrun: what it
 * shows is up (`shows`), or what it closed is gone (`hides`); none of the page's requests to the API
 * is still out, as what a view shows comes with them; and two frames have been drawn since, so axe
 * reads what the step changed.
 */
async function settled(page: Page, o: { shows?: string; hides?: string } = {}): Promise<void> {
  const open = apiRequests(page);
  if (o.shows) await page.waitForSelector(o.shows, { state: 'visible' });
  if (o.hides) await page.waitForSelector(o.hides, { state: 'detached' });
  // Polled from here, where the requests are seen: a request still out after a minute fails the sweep, naming it.
  await expect.poll(() => [...open].map((r) => new URL(r.url()).pathname), { message: "the page's requests to the API to come back", timeout: 60_000, intervals: [25] }).toEqual([]);
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
}

/** A dialog on top, the palette's and the shortcuts' included, and a menu open. */
const DIALOG = '[role="dialog"][aria-modal="true"]';
const MENU = '.pop[role="menu"]';

const at = (page: Page, path: string, drawn = 'main#view') => async () => {
  apiRequests(page);
  await openPage(page, path, drawn);
  await settled(page);
};
const run = (page: Page, id: string, view = '') => at(page, `/run/${id}${view ? `/${view}` : ''}`, 'run');
/** A link that names nothing: the not-found page, drawn once the other projects were asked whether one holds it. */
const NOT_FOUND = 'main#view .ph h1:text-is("Nothing here")';
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
/** Changes' Verdicts, drawn with its rows. */
const VERDICTS = 'main#view table.vdt tbody tr';
/**
 * The page of the revision Verdicts leads with, by the key the API gives: a key can hold a `+`, which
 * the token link's `open=` stops at, so the page goes there from Verdicts.
 */
const revision = (page: Page) => async () => {
  const { origin, token } = dash();
  const view = (await (await page.request.get(`${origin}/api/verdicts`, { headers: { 'x-shadowlap-token': token } })).json()) as { lead: { key: string } | null };
  if (!view.lead) throw new Error('the demo store has no test session that ran every golden');
  await at(page, '/changes', VERDICTS)();
  await page.evaluate((key) => {
    location.hash = `#/changes/verdicts/${encodeURIComponent(key)}`;
  }, view.lead.key);
  await settled(page, { shows: 'main#view table.vdg tbody tr' });
};
/** Changes' Preview, drawn with its matrix's cells; an opened cell, drawn with its head; a run's Decisions view, drawn with its session's line. */
const PREVIEW = 'main#view .dmx button.dc';
const CELL = 'main#view .dcell .dch';
const DVIEW = 'main#view .dview .dvhead';
/** The demo's preview, a cell of it opened and its run's Decisions view, by the addresses the API gives. */
async function previewed(page: Page): Promise<{ preview: string; cell: string; view: string }> {
  const { origin, token } = dash();
  const get = async <T>(path: string) => (await (await page.request.get(`${origin}/api/${path}`, { headers: { 'x-shadowlap-token': token } })).json()) as T;
  const { sessions } = await get<{ sessions: Array<{ kind: string; sessionId: string }> }>('decisions');
  const s = sessions.find((x) => x.kind === 'decisions');
  if (!s) throw new Error('the demo store has no preview');
  const { matrix } = await get<{ matrix: Array<{ runId: string; inStore: boolean }> }>(`decisions/${s.sessionId}`);
  const runId = matrix.find((r) => r.inStore)?.runId;
  if (!runId) throw new Error('the demo’s preview names no run the store holds');
  const mine = (await get<{ sessions: Array<{ sessionId: string; href: string; changes: string }> }>(`runs/${runId}/decisions`)).sessions.find((x) => x.sessionId === s.sessionId)!;
  return { preview: `/changes/decisions/${s.sessionId}`, cell: mine.changes.slice(1), view: mine.href.slice(1) };
}
const previews = async (page: Page, on = ''): Promise<Array<[string, () => Promise<void>]>> => {
  const p = await previewed(page);
  return [
    [`Preview${on}`, at(page, p.preview, PREVIEW)],
    [`a preview’s opened cell${on}`, at(page, p.cell, CELL)],
    [`a run’s Decisions view${on}`, at(page, p.view, DVIEW)],
  ];
};
const click = (page: Page, selector: string, text?: string, o: { shows?: string; hides?: string } = {}) => async () => {
  apiRequests(page);
  await page.locator(selector, text ? { hasText: text } : {}).first().click();
  await settled(page, o);
};
const press = (page: Page, key: string, o: { shows?: string; hides?: string } = {}) => async () => {
  apiRequests(page);
  await page.keyboard.press(key);
  await settled(page, o);
};
/** Compare on the pair it opens on, its first row opened by a click, whichever call that is in the demo. */
const compareOpen = (page: Page) => async () => {
  await at(page, '/compare', 'main#view .paths2 button.cprow')();
  await click(page, 'main#view .paths2 button.cprow', undefined, { shows: 'main#view #cmpd' })();
};
/** Escape, and the dialog or menu it closes gone. */
const escape = (page: Page, closes: string = DIALOG) => press(page, 'Escape', { hides: closes });
/**
 * Update goldens from Tests, as the palette opens it (`#/tests?update`): the header offers it only
 * when more than one golden diverged, and the demo has one, so its dialog is for that one.
 */
const updateGoldens = (page: Page) => async () => {
  apiRequests(page);
  await page.evaluate(() => {
    location.hash = '#/tests?update';
  });
  await settled(page, { shows: DIALOG });
};

test.describe.configure({ timeout: 300_000 });

test('every page and Settings tab has no serious or critical axe violation', async ({ page }) => {
  const pages = ['/', '/runs', '/runs?types=capture', '/runs?types=test', '/runs?types=failed', '/runs?q=label%3Agood', '/fixes', '/tests', '/training', '/training/tasks', '/compare', '/new'];
  const settings = ['matching', 'redaction', 'ci', 'agents', 'tools', 'project', 'store'];
  const changes: Array<[string, () => Promise<void>]> = [['/changes', at(page, '/changes', VERDICTS)], ['a revision’s page', revision(page)], ['/compare with a row open', compareOpen(page)], ...(await previews(page))];
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
  states.push(['run refundBug', run(page, dash().runs.refundBug as string)], ['run refundBug · a tool call', click(page, 'main#view tr[data-wi]:has(td.name[title="issue_refund"])')], ['run refundBug · the check menu', click(page, '[data-act="ckmenu"]', undefined, { shows: MENU })], ['run refundBug · the check menu closed', escape(page, MENU)]);
  expect(await sweep(page, states)).toEqual([]);
});

test('every overlay has no serious or critical axe violation: the switcher, a picker, a hover card, a dialog asking to discard, and each as a phone’s sheet', async ({ page }) => {
  const ticket = dash().runs.ticket as string;
  const overlays = (where: string): Array<[string, () => Promise<void>]> => [
    [`Runs${where}`, at(page, '/runs', 'main#view table.runst tbody tr')],
    ...(where
      ? ([['the sidebar on a phone', click(page, 'button.menu-toggle', undefined, { shows: 'aside#side.open' })]] as Array<[string, () => Promise<void>]>)
      : []),
    [`the project switcher${where}`, click(page, 'button.proj', undefined, { shows: MENU })],
    [`the project switcher closed${where}`, escape(page, MENU)],
    [`Compare${where}`, at(page, '/compare', 'main#view .pickers .rpick')],
    [`a run picker${where}`, click(page, '.rpick', undefined, { shows: '.pop.picker' })],
    [`a run picker that finds nothing${where}`, async () => {
      await page.locator('.pop.picker input.pfilter').fill('zzzz nothing like it');
      await settled(page, { shows: '.pop.picker .pnone' });
    }],
    [`a run picker closed${where}`, escape(page, '.pop.picker')],
    [`Redaction${where}`, at(page, '/settings/redaction', 'main#view .pvhead')],
    [`Redaction's run picker${where}`, click(page, '.pvhead .rpick', undefined, { shows: '.pop.picker' })],
    [`Redaction's run picker closed${where}`, escape(page, '.pop.picker')],
    [`Add redaction rule${where}`, click(page, 'main#view button', 'Add redaction rule', { shows: DIALOG })],
    [`Add redaction rule, edited${where}`, async () => {
      await page.locator(`${DIALOG} label`, { hasText: 'Replace with' }).locator('input').fill('<GONE>');
      await settled(page);
    }],
    [`Discard what you changed?${where}`, press(page, 'Escape', { shows: '.dlgask' })],
    [`Discard what you changed? answered${where}`, press(page, 'Escape', { hides: '.dlgask' })],
    [`a run${where}`, run(page, ticket)],
    [`Share${where}`, click(page, '.rhead .actions button', 'Share', { shows: MENU })],
    [`Share closed${where}`, escape(page, MENU)],
    [`the fork menu${where}`, click(page, '#forkBtn', undefined, { shows: MENU })],
    [`the fork menu closed${where}`, escape(page, MENU)],
    [`More${where}`, click(page, '#moreBtn', undefined, { shows: MENU })],
    [`Delete${where}`, click(page, `${MENU} [role="menuitem"]`, 'Delete run', { shows: DIALOG })],
    [`Delete closed${where}`, escape(page)],
    [`the shortcuts${where}`, press(page, '?', { shows: '.help' })],
    [`the shortcuts closed${where}`, escape(page, '.help')],
    [`the palette${where}`, press(page, 'Meta+k', { shows: '.palette' })],
    [`the palette closed${where}`, escape(page, '.palette')],
  ];
  // The hover card for the keyboard's focus and the pointer's, with what it points at.
  const cards: Array<[string, () => Promise<void>]> = [
    ['a run', run(page, ticket)],
    ['a cell’s hover card', async () => {
      await page.locator('.cells button').first().hover();
      await settled(page, { shows: '#tip' });
    }],
    ['a fact’s hover card', async () => {
      await page.mouse.move(2, 2);
      await page.locator('main#view .metric .st[data-tip] a').first().focus();
      await settled(page);
    }],
    ['a menu row’s hover card', async () => {
      await page.locator('.rhead .actions button', { hasText: 'Share' }).click();
      await page.locator(`${MENU} [role="menuitem"]`).nth(1).hover();
      await settled(page, { shows: '#tip' });
    }],
    ['a menu row’s hover card closed', escape(page, MENU)],
  ];
  const wide = await sweep(page, [...overlays(''), ...cards]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect([...wide, ...(await sweep(page, overlays(' on a phone')))]).toEqual([]);
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
  const states: Array<[string, () => Promise<void>]> = [];
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
  await page.route('**/api/user/spending', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: { askAbove: 0, set: true, problems: [] } }) : route.continue()));
  const ids = dash().runs;
  const id = (name: string) => ids[name] as string;
  // A row or a button that isn't there says so soon: there is no waiting it out.
  const button = (where: string, text: string, shows = DIALOG) => async () => {
    apiRequests(page);
    await page.locator(where, { hasText: text }).first().click({ timeout: 20_000 });
    await settled(page, { shows });
  };
  // Its page again is the page as it was: what is ticked stays ticked.
  const tick = async () => {
    await page.locator('main#view table.runst tbody tr input[type="checkbox"]').first().check({ timeout: 20_000 });
    await settled(page, { shows: '.bulkbar' });
  };
  const opened = (name: string, where: () => Promise<void>, ...open: Array<() => Promise<void>>): Array<[string, () => Promise<void>]> => [[`${name}: its page`, where], ...open.map((o, i): [string, () => Promise<void>] => [i === open.length - 1 ? name : `${name}: step ${i + 1}`, o]), [`${name}: closed`, press(page, 'Escape', { hides: DIALOG })]];
  const onRun = (name: string, of: string, text: string) => opened(name, run(page, id(of)), button('.rhead .actions button', text));
  const fork = (name: string, of: string, row: string) => opened(name, run(page, id(of)), click(page, '#forkBtn', undefined, { shows: MENU }), button(`${MENU} [role="menuitem"]`, row));
  // The call a row belongs to picked first: a run opens on the call its outcome names or its first write, whose menu may
  // have no model call's rows (the ticket's), nor a user reply's (the chat's, a `user_input` tool call).
  const forkOn = (call: string) => (name: string, of: string, row: string) => opened(name, run(page, id(of)), click(page, `main#view tr[data-wi]:has(td.name[title${call}])`), click(page, '#forkBtn', undefined, { shows: MENU }), button(`${MENU} [role="menuitem"]`, row));
  const forkModel = forkOn('^="POST "');
  // A write's own call picked first: Force live on it asks, with its red line.
  const forceWrite = (name: string, of: string, tool: string) => opened(name, run(page, id(of)), click(page, `main#view tr[data-wi]:has(td.name[title="${tool}"])`), click(page, '#forkBtn', undefined, { shows: MENU }), button(`${MENU} [role="menuitem"]`, `Force ${tool} live`));
  const share = (name: string, row: string) => opened(name, run(page, id('ticket')), click(page, '.rhead .actions button', 'Share', { shows: MENU }), button(`${MENU} [role="menuitem"]`, row));
  const onPage = (name: string, path: string, text: string) => opened(name, at(page, path), button('main#view button', text));
  // A golden's own buttons sit in its report, folded under its row: Tests' reports are opened first, as a person opens one.
  const reportsOpen = async () => {
    await page.locator('main#view button.grptog').first().waitFor({ timeout: 20_000 });
    const folded = page.locator('main#view button.grptog[aria-expanded="false"]');
    while (await folded.count()) await folded.first().click();
  };
  const inReport = (name: string, text: string) => opened(name, at(page, '/tests'), reportsOpen, button('main#view section.gpanel button', text));
  const bulk = (name: string, text: string) => opened(name, at(page, '/runs', 'main#view table.runst tbody tr'), tick, button('.bulkbar button', text));
  const onFix = (name: string, of: string, text: string) => opened(name, at(page, `/fixes/${id(of)}`, 'fix'), button('.ph .actions button', text));
  // The builder from a call of the refund bug, a failed recording: swept once Suggested has drawn the rules the demo's
  // good run gives, which it asks for after the builder settles, so the read can come after the dialog's own.
  const check = (name: string, rule: string) => opened(name, run(page, id('refundBug')), click(page, 'main#view tr[data-wi]:has(td.name[title="issue_refund"])'), click(page, '[data-act="ckmenu"]', undefined, { shows: MENU }), button(`${MENU} [role="menuitem"]`, rule, `${DIALOG} .cb-sug`));
  const states = (): Array<[string, () => Promise<void>]> => [
    ...opened('Delete run', run(page, id('ticket')), click(page, '#moreBtn', undefined, { shows: MENU }), button(`${MENU} [role="menuitem"]`, 'Delete run')),
    ...onRun('The consent question', 'packed', 'Replay'),
    ...onRun('Pack as golden', 'digest', 'Pack as golden'),
    ...forkModel('Inject instruction', 'ticket', 'Inject instruction'),
    ...forkModel('Switch model', 'ticket', 'Switch model'),
    ...forkModel('Fail with HTTP status', 'ticket', 'Fail with HTTP status'),
    ...fork('Override result', 'failTool', 'Override result'),
    ...fork('Fail with tool error', 'failTool', 'Fail with tool error'),
    ...fork('Plant instruction', 'failTool', 'Plant instruction'),
    ...forkOn('="user_input"')('Override user reply', 'chat', 'Override user reply'),
    ...fork('Repeat fork 5 times', 'override', 'Repeat 5 times'),
    ...fork('Replay with your command', 'har', 'Replay with your command'),
    ...forkModel('Find commit that changed it', 'ticket', 'Find commit that changed it'),
    ...fork('Find breaking commit', 'planted', 'Find breaking commit'),
    ...forceWrite('Force send_email live', 'twice', 'send_email'),
    ...opened('Edit and fork', run(page, id('failTool')), button('.insp button', 'Edit and fork')),
    ...check('Add check', 'Never call issue_refund'),
    ...check('Add check: When… then', 'When… then…'),
    ...check('Add check: Ask a judge', 'Ask a judge…'),
    ...share('Pack', 'Pack'),
    ...share('Export eval dataset', 'Eval dataset'),
    ...share('Export OpenTelemetry trace', 'OpenTelemetry trace'),
    ...bulk('Add label', 'Label'),
    ...bulk('Delete runs', 'Delete'),
    ...bulk('Pack runs', 'Pack'),
    ...bulk('Export the dataset of runs', 'Dataset'),
    ...opened('Update goldens', at(page, '/tests'), updateGoldens(page)),
    ...inReport('Update golden', 'Update golden'),
    ...inReport('Add normalizer and update', 'Add normalizer and update'),
    ...onPage('Run tests’ question', '/tests', 'Run tests'),
    ...onPage('Export pairs', '/training', 'Export pairs'),
    ...onPage('Score model', '/training/tasks', 'Score model'),
    ...onPage('A task’s Update golden', '/training/tasks', 'Update golden'),
    ...onPage('Add normalizer', '/settings/matching', 'Add normalizer'),
    ...onPage('Add redaction rule', '/settings/redaction', 'Add redaction rule'),
    ...onPage('Add MCP server', '/settings/tools', 'Add MCP server'),
    ...onPage('Remove project', '/settings/project', 'Remove project'),
    ...onPage('Write file', '/settings/ci', 'Write file'),
    ...onFix('Run repair', 'emailFix', 'Run repair'),
    ...onFix('Mark fix applied', 'refundFix', 'Mark applied'),
    ...opened('Rename fix', at(page, `/fixes/${id('emailFix')}`, 'fix'), button('main#view button.fxrename', 'Rename')),
  ];
  const wide = await sweep(page, states());
  await page.setViewportSize({ width: 390, height: 844 });
  expect([...wide, ...(await sweep(page, states()))]).toEqual([]);
});
