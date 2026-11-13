import { expect, type Page, type Request } from '@playwright/test';
import { NAME as CRASH, routeCrash, routeCrashFix, routeTests } from './crash-fixture.js';
import { dash, demoId, openPage, seriousViolations, type Served } from './dashboard.js';
import { routePrCommentFixture } from './pr-comment-fixture.js';
import { openReport, routeTestsFixture } from './tests-fixture.js';

/**
 * The dashboard's routes for the sweeps, and the walkers that show them. ROUTES holds one state for
 * each page, tab, view and not-found page the demo draws, with the address it opens and the selector
 * that says it has drawn: the accessibility sweep (axe and sideways scroll at 390 and 320, forced
 * colours, the heading outline) and the line-breaks sweep go over the same list. The axe sweep's
 * walkers live here too, so no spec imports another spec.
 */

/** The demo's runs by name, each by its id: every run the demo names. */
export function runs(): Array<[string, string]> {
  return Object.entries(dash().runs).flatMap(([name, v]) => (typeof v === 'string' && /^01[0-9A-Z]{24}$/.test(v) ? [[name, v] as [string, string]] : []));
}

/** The demo's fixes, by id. */
export const fixes = () => Object.values(dash().runs).filter((v): v is string => typeof v === 'string' && v.startsWith('fx-'));

/** A state of the page: its name in a failure, and how to show it. */
export type State = [string, () => Promise<void>];

/** Each violation found, under the state it was found in. */
export async function sweep(page: Page, states: State[]): Promise<string[]> {
  const found: string[] = [];
  for (const [name, show] of states) {
    await show();
    for (const v of await seriousViolations(page)) found.push(`${name}: ${v}`);
  }
  return found;
}

/** The page's requests to the dashboard's API still out: what a view shows comes with them. */
const inFlight = new WeakMap<Page, Set<Request>>();
export function apiRequests(page: Page): Set<Request> {
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
export async function settled(page: Page, o: { shows?: string; hides?: string } = {}): Promise<void> {
  const open = apiRequests(page);
  if (o.shows) await page.waitForSelector(o.shows, { state: 'visible' });
  if (o.hides) await page.waitForSelector(o.hides, { state: 'detached' });
  // Polled from here, where the requests are seen: a request still out after a minute fails the sweep, naming it.
  await expect.poll(() => [...open].map((r) => new URL(r.url()).pathname), { message: "the page's requests to the API to come back", timeout: 60_000, intervals: [25] }).toEqual([]);
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
}

/** A dialog on top, the palette's and the shortcuts' included, and a menu open. */
export const DIALOG = '[role="dialog"][aria-modal="true"]';
export const MENU = '.pop[role="menu"]';

/** A page opened and settled: the demo's, or the one `served` serves. */
export const at = (page: Page, path: string, drawn = 'main#view', served?: Served) => async () => {
  apiRequests(page);
  await openPage(page, path, drawn, served);
  await settled(page);
};
export const run = (page: Page, id: string, view = '') => at(page, `/run/${id}${view ? `/${view}` : ''}`, 'run');
/** A link that names nothing: the not-found page, drawn once the other projects were asked whether one holds it. */
export const NOT_FOUND = 'main#view .ph h1:text-is("Nothing here")';
/** Changes' Verdicts, drawn with its rows. */
export const VERDICTS = 'main#view table.vdt tbody tr';
/**
 * From Verdicts, the page of the revision it leads with, by the key the API gives: a key can hold a
 * `+`, which the token link's `open=` stops at, so the page goes there from Verdicts.
 */
async function toRevision(page: Page): Promise<void> {
  const { origin, token } = dash();
  const view = (await (await page.request.get(`${origin}/api/verdicts`, { headers: { 'x-shadowlap-token': token } })).json()) as { lead: { key: string } | null };
  if (!view.lead) throw new Error('the demo store has no test session that ran every golden');
  await page.evaluate((key) => {
    location.hash = `#/changes/verdicts/${encodeURIComponent(key)}`;
  }, view.lead.key);
  await settled(page, { shows: 'main#view table.vdg tbody tr' });
}
/** The page of the revision Verdicts leads with, opened from Verdicts. */
export const revision = (page: Page) => async () => {
  await at(page, '/changes', VERDICTS)();
  await toRevision(page);
};
/** Changes' Preview, drawn with its matrix's cells; an opened cell, drawn with its head; a run's Decisions view, drawn with its session's line. */
export const PREVIEW = 'main#view .dmx button.dc';
export const CELL = 'main#view .dcell .dch';
export const DVIEW = 'main#view .dview .dvhead';
interface Previewed {
  preview: string;
  cell: string;
  view: string;
}
/** The demo's preview, a cell of it opened and its run's Decisions view, by the addresses the API gives. */
export async function previewed(page: Page): Promise<Previewed> {
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
/**
 * The preview at `preview` as if its verify had left its first run open, as the session's read answers
 * while `on`: Run more attempts its next step. Off, the session reads as the demo keeps it.
 */
export async function moreAttempts(page: Page, preview: string): Promise<{ preview: string; on: boolean }> {
  const sessionId = preview.split('/').at(-1)!;
  const more = { preview, on: false };
  await page.route(
    (url) => url.pathname.endsWith(`/api/decisions/${sessionId}`),
    async (route) => {
      if (!more.on) return route.continue();
      // Read whole, with the session's cookie, never a 304 the page's cache would answer.
      const headers = Object.fromEntries(Object.entries(await route.request().allHeaders()).filter(([k]) => k !== 'if-none-match'));
      const res = await route.fetch({ headers });
      const s = (await res.json()) as { matrix: Array<{ runId: string; verified: unknown }>; view: { next: Record<string, unknown> } };
      const runId = s.matrix[0]!.runId;
      s.matrix[0]!.verified = { outcome: 'inconclusive', tally: ' · 50 of 80', count: '50 of 80' };
      s.view.next = { ...s.view.next, verify: null, migrate: null, more: { kind: 'more', runs: [runId], max: 160, keptMax: null, flags: ['--gate', '{"max":160}'], attempts: 80, limit: 'up to 160 attempts a run' } };
      await route.fulfill({ response: res, json: s });
    },
  );
  return more;
}
/** Every billed press asks on this page, whatever the suite's one Spending says, so a press opens its dialog and starts nothing. */
export const asksFirst = (page: Page) => page.route('**/api/user/spending', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: { askAbove: 0, set: true, problems: [] } }) : route.continue()));
/** Preview changed prompt's read of the working tree, a job, answered here as it ends: a real read replays the agent's code. */
export async function routeTreeRead(page: Page): Promise<void> {
  const read = { id: 'axe-tree-read', kind: 'decisions-read', title: 'Reading what your working tree sends', args: ['decisions', '--from-code', '--dry-run'], runId: null, opensRun: false, startedAt: Date.now(), done: true, code: 0, newRunId: null, lines: [], total: 0, result: { fromCode: { calls: 2, instructions: { before: 'You are a support agent.', after: 'You are a support agent. Never refund an order twice.' }, tools: { added: [], removed: [], changed: ['issue_refund'] } }, runs: [], notes: [], nothing: null, scope: 'agent' } };
  await page.route('**/api/jobs', (route) => (route.request().method() === 'POST' && (route.request().postDataJSON() as { kind?: string }).kind === 'decisions-read' ? route.fulfill({ status: 202, json: read }) : route.continue()));
  await page.route(`**/api/jobs/${read.id}**`, (route) => route.fulfill({ json: read }));
}
export const previews = async (page: Page, on = ''): Promise<State[]> => {
  const p = await previewed(page);
  return [
    [`Preview${on}`, at(page, p.preview, PREVIEW)],
    [`a preview’s opened cell${on}`, at(page, p.cell, CELL)],
    [`a run’s Decisions view${on}`, at(page, p.view, DVIEW)],
  ];
};
export const click = (page: Page, selector: string, text?: string, o: { shows?: string; hides?: string } = {}) => async () => {
  apiRequests(page);
  await page.locator(selector, text ? { hasText: text } : {}).first().click();
  await settled(page, o);
};
export const press = (page: Page, key: string, o: { shows?: string; hides?: string } = {}) => async () => {
  apiRequests(page);
  await page.keyboard.press(key);
  await settled(page, o);
};
/** Compare's rows, drawn; and its first row opened by a click, whichever call that is in the demo. */
const COMPARE = 'main#view .paths2 button.cprow';
const openFirstRow = (page: Page) => click(page, COMPARE, undefined, { shows: 'main#view #cmpd' })();
/** Compare on the pair it opens on, its first row opened. */
export const compareOpen = (page: Page) => async () => {
  await at(page, '/compare', COMPARE)();
  await openFirstRow(page);
};
/** Escape, and the dialog or menu it closes gone. */
export const escape = (page: Page, closes: string = DIALOG) => press(page, 'Escape', { hides: closes });

/** A route's state, for the sweeps that walk every page. */
export interface RouteState {
  /** Its name in a failure. */
  name: string;
  /** The address the session link opens (`open=`), read when it is shown: the demo's ids and the API's addresses come from the running demo. */
  path: (page: Page) => string | Promise<string>;
  /** What says it has drawn: a selector, or a name `openPage` knows (`run`, `fix`, `overview`). */
  drawn: string;
  /**
   * Answers routed before it opens, for a state the demo can't draw: it opens in a page loaded anew,
   * as its link opens it, so what the app reads once as it starts (the job kinds, Open in editor's
   * form) is routed too. They stay for the page's life, so the table holds such states last and a
   * sweep shows them after the rest.
   */
  fixture?: (page: Page) => Promise<unknown>;
  /** A step once the page has drawn, a row opened or a revision gone to: the state is what that shows. */
  then?: (page: Page) => Promise<void>;
  /** The one check it skips, sideways scroll at 320, and why: a page that needs a redesign there, never a silent skip. */
  narrow?: { skips: 'sideways at 320'; why: string };
  /** The dashboard it opens on, where the demo's can't draw it: a store of its own (injectionRoutes). */
  served?: Served;
}

/** Each step of a fix's page: its own, then Blame, Repair and Verify. */
const STEPS = ['', '/blame', '/repair', '/verify'];
/** A run's views, Calls (its own address) first. */
const RUN_VIEWS = ['', 'turns', 'context', 'timeline', 'forks', 'provenance', 'decisions'];
/** The runs drawn in every view: a recording with writes, a fork of it, and a batch of sub-agents' calls. */
const VIEWED = ['ticket', 'override', 'batch'];
const SETTINGS = ['matching', 'redaction', 'ci', 'agents', 'tools', 'project', 'store'];
/** A Settings tab, drawn past its loading shape. */
const SETTAB = 'main#view .settab > :not(.skel)';

const route = (path: string, drawn = 'main#view'): RouteState => ({ name: path, path: () => path, drawn });

/**
 * The check builder, opened from the refund-bug recording's issue_refund call with its check menu's
 * first kind, once Suggested has drawn the rules the demo's good run gives: it asks for them after
 * the builder settles, so its read can come after the dialog's own.
 */
const openBuilder = async (page: Page): Promise<void> => {
  await click(page, 'main#view tr[data-wi]:has(td.name[title="issue_refund"])', undefined, { shows: '[data-act="ckmenu"]' })();
  await click(page, '[data-act="ckmenu"]', undefined, { shows: MENU })();
  await click(page, `${MENU}.ckm [role="menuitem"]`, 'Never call issue_refund', { shows: `${DIALOG} .cb-sug` })();
};
/** The demo golden whose checks Tests draws with Edit, Remove and Add check… (port/checks-on-tests). */
const CHECKED = 'goldens/refund-in-limit';
/** The builder from that golden's first check on Tests: the icon where a pointer hovers, Edit checks… where the checks sit under its name. */
const builderFromTests = (page: Page) => click(page, `main#view [data-ck="edit"][data-g="${CHECKED}"]:visible`, undefined, { shows: `${DIALOG} .cb-kinds` })();
/**
 * Remove's dialog from that golden's first check. Only where the row's icons show (a pointer that
 * hovers, a column wider than 840px) does Tests offer Remove, so a narrower window opens it wide and
 * is then narrowed, as a person narrows a window with it open: the dialog as a phone's sheet.
 */
const removeFromTests = async (page: Page): Promise<void> => {
  const size = page.viewportSize()!;
  if (size.width < 1440) await page.setViewportSize({ width: 1440, height: 900 });
  await click(page, `main#view [data-ck="remove"][data-g="${CHECKED}"]:visible`, undefined, { shows: DIALOG })();
  if (size.width < 1440) {
    await page.setViewportSize(size);
    await settled(page, { shows: DIALOG });
  }
};
/** A fix's head's check (port/fix-check): Edit check… on an open fix, its runs judged by the change; Add check… on a verified one. */
const fixCheck = (page: Page, shows: string) => click(page, 'main#view .ph p.chk .fmx button', undefined, { shows: `${DIALOG} ${shows}` })();
/** New preview's menu (port/preview-jobs) from `where`, and a dialog it opens. */
const newPreview = (page: Page, where: string) => click(page, where, 'New preview', { shows: MENU })();
const previewWay = (way: string, where = 'main#view button') => async (page: Page): Promise<void> => {
  await newPreview(page, where);
  await click(page, `${MENU} [role="menuitem"]`, way, { shows: DIALOG })();
};

/** The goldens whose reports Tests' fixture draws, a crash's, a failed gate's and the demo's divergence's, by the page it routed. */
const reported = new WeakMap<Page, string[]>();
const testsFixture = async (page: Page): Promise<void> => {
  const { crash, gate, diverged } = await routeTestsFixture(page);
  reported.set(page, [crash, gate, diverged]);
};
/** A gated golden's evidence open under its row, then each report the fixture draws, with its traceback and lines as printed, the divergence's request diffed. */
const openEvidence = async (page: Page): Promise<void> => {
  await click(page, 'main#view button.gev:not(.grptog)', undefined, { shows: 'main#view tr.gevrow .alist' })();
  const names = reported.get(page) ?? [];
  for (const name of names) await openReport(page, name);
  await settled(page, { shows: `main#view section[id="report-${names.at(-1)}"] .rpdiff .jl` });
};
/** Tests with the named crash's report open under its row: the change under its first bad commit. */
const crashReport = async (page: Page): Promise<void> => {
  await openReport(page, CRASH);
  await settled(page, { shows: 'main#view .bisectdiff' });
};
/** Preview pull request comment (port/pr-comment), every part drawn. */
const prPreview = (page: Page) => click(page, 'main#view button', 'Preview pull request comment', { shows: `${DIALOG} .prc` })();
/** The revision's page Verdicts leads with, then its Preview pull request comment. */
const prFromRevision = async (page: Page): Promise<void> => {
  await toRevision(page);
  await prPreview(page);
};
/** A merged session's flag on Verdicts, its card shown as the keyboard reaches it. */
const flagCard = async (page: Page): Promise<void> => {
  await page.mouse.move(2, 2);
  await page.locator('main#view .rsub.vdflag').first().focus();
  await settled(page, { shows: '#tip' });
};
/** Preview's own buttons (port/preview-jobs): its verdict's Verify, or Run more attempts where verify left a run open. */
const onVerdict = (text: string) => (page: Page) => click(page, 'main#view .dverdict .actions button', text, { shows: DIALOG })();
/** Each press asking first, and the working tree's read answered. */
const asksWithTreeRead = async (page: Page): Promise<void> => {
  await asksFirst(page);
  await routeTreeRead(page);
};
/** Each press asking first, and the demo's preview read as if its verify had left its first run open. */
const asksWithMore = async (page: Page): Promise<void> => {
  await asksFirst(page);
  (await moreAttempts(page, (await previewed(page)).preview)).on = true;
};
/** Runs with its first row ticked, then Preview change from the bar it brings, and the model switch it offers. */
const previewChange = async (page: Page): Promise<void> => {
  apiRequests(page);
  await page.locator('main#view table.runst tbody tr input[type="checkbox"]').first().check();
  await settled(page, { shows: '.bulkbar' });
  await click(page, '.bulkbar button', 'Preview change', { shows: MENU })();
  await click(page, `${MENU} [role="menuitem"]`, 'Preview model switch', { shows: DIALOG })();
};

/** Every route state, for a sweep to show one at a time with `show`. */
export const ROUTES: readonly RouteState[] = [
  route('/', 'overview'),
  route('/runs', 'main#view table.runst tbody tr'),
  ...['capture', 'test', 'failed'].map((t) => route(`/runs?types=${t}`)),
  route('/runs?q=label%3Agood'),
  ...VIEWED.flatMap((name) => RUN_VIEWS.map((v): RouteState => ({ name: `run ${name}${v ? ` · ${v}` : ''}`, path: () => `/run/${demoId(name)}${v ? `/${v}` : ''}`, drawn: 'run' }))),
  // A dialog left open goes with its page, as the next state opens another.
  { name: 'the check builder', path: () => `/run/${demoId('refundBug')}`, drawn: 'run', then: openBuilder },
  route('/compare', COMPARE),
  { name: '/compare with a row open', path: () => '/compare', drawn: COMPARE, then: openFirstRow },
  route('/changes', VERDICTS),
  { name: 'a revision’s page', path: () => '/changes', drawn: VERDICTS, then: toRevision },
  route('/changes/decisions'),
  { name: 'Preview', path: async (p) => (await previewed(p)).preview, drawn: PREVIEW },
  { name: 'a preview’s opened cell', path: async (p) => (await previewed(p)).cell, drawn: CELL },
  { name: 'a run’s Decisions view', path: async (p) => (await previewed(p)).view, drawn: DVIEW },
  { name: 'New preview’s menu on a run’s Decisions view', path: async (p) => (await previewed(p)).view, drawn: DVIEW, then: (p) => newPreview(p, 'main#view .dview .dvhead button') },
  route('/fixes'),
  ...STEPS.map((step): RouteState => ({ name: `a fix${step ? ` · ${step.slice(1)}` : ''}`, path: () => `/fixes/${demoId('refundFix')}${step}`, drawn: 'fix' })),
  // A fix's check in the builder, each dialog closed by the next page.
  { name: 'Add check… on a verified fix', path: () => `/fixes/${demoId('refundFix')}`, drawn: 'fix', then: (p) => fixCheck(p, '.cb-kinds') },
  { name: 'Edit check… on an open fix, its runs judged', path: () => `/fixes/${demoId('emailFix')}`, drawn: 'fix', then: (p) => fixCheck(p, '.cb-fixr .cb-row') },
  route('/tests'),
  { name: 'the check builder from a golden’s check on Tests', path: () => '/tests', drawn: 'main#view table.gt', then: builderFromTests },
  route('/training'),
  { name: 'Remove’s dialog from a golden’s check on Tests', path: () => '/tests', drawn: 'main#view table.gt', then: removeFromTests },
  route('/training/tasks'),
  ...SETTINGS.map((t): RouteState => ({ name: `Settings → ${t}`, path: () => `/settings/${t}`, drawn: SETTAB })),
  route('/new'),
  route('/setup'),
  route('/setup/store'),
  ...['/nowhere', '/run/01ZZZZZZZZZZZZZZZZZZZZZZZZ', '/fixes/fx-nope'].map((p) => route(p, NOT_FOUND)),
  // Runs keeps its calendar open for the page's life once shown (a link opened in the page doesn't reload it): after every other Runs route.
  { name: '/runs with its calendar', path: () => '/runs', drawn: 'main#view table.runst tbody tr', then: (p) => click(p, 'main#view button.linkbtn[aria-expanded="false"]', 'Calendar', { shows: 'main#view .calgrid' })() },
  // Answers the demo can't give: kept last, as they stay routed for the page's life.
  { name: 'Tests with a gated golden’s evidence and three reports open', path: () => '/tests', drawn: 'main#view table.gt', fixture: testsFixture, then: openEvidence },
  // A crash whose first bad commit is named: its run page with the change open, its fix's Blame step, Tests with it leading, and Revert's dialog last.
  { name: 'a named crash’s run page with its change open', path: () => `/run/${demoId('ticket')}`, drawn: 'run', fixture: routeCrash, then: (p) => click(p, 'main#view [data-act="change"]', undefined, { shows: '#insp.fpanel[data-kind="change"]' })() },
  { name: 'a named crash’s fix · blame', path: () => `/fixes/${demoId('refundFix')}/blame`, drawn: 'fix', fixture: routeCrashFix },
  { name: 'Tests with a named crash leading, its report open', path: () => '/tests', drawn: 'main#view table.gt', fixture: routeTests, then: crashReport },
  { name: 'Revert’s dialog', path: () => `/run/${demoId('ticket')}`, drawn: 'run', fixture: routeCrash, then: (p) => click(p, '.rhead .btn.lime[data-next="revert"]', undefined, { shows: DIALOG })() },
  // The pull request comment with every part, and each session's pull request merged, flagged where it didn't pass.
  { name: 'Settings → ci with the pull request comment’s every part', path: () => '/settings/ci', drawn: 'main#view .prpanel', fixture: routePrCommentFixture },
  { name: 'Preview pull request comment from Settings → ci', path: () => '/settings/ci', drawn: 'main#view .prpanel', fixture: routePrCommentFixture, then: prPreview },
  { name: 'Verdicts with each session’s pull request', path: () => '/changes', drawn: VERDICTS, fixture: routePrCommentFixture },
  { name: 'a merged session’s flag’s card', path: () => '/changes', drawn: VERDICTS, fixture: routePrCommentFixture, then: flagCard },
  { name: 'a revision’s page with what its comment carried', path: () => '/changes', drawn: VERDICTS, fixture: routePrCommentFixture, then: toRevision },
  { name: 'Preview pull request comment from a revision’s page', path: () => '/changes', drawn: VERDICTS, fixture: routePrCommentFixture, then: prFromRevision },
  // A preview's dialogs, each press asking first: New preview's three, Verify, Runs' Preview change, and Run more attempts last, as it reads the preview as verify left it.
  { name: 'Preview model switch', path: async (p) => (await previewed(p)).preview, drawn: PREVIEW, fixture: asksFirst, then: previewWay('Preview model switch') },
  { name: 'Preview field change', path: async (p) => (await previewed(p)).preview, drawn: PREVIEW, fixture: asksFirst, then: previewWay('Preview field change') },
  { name: 'Preview changed prompt', path: async (p) => (await previewed(p)).preview, drawn: PREVIEW, fixture: asksWithTreeRead, then: previewWay('Preview changed prompt') },
  { name: 'Verify a preview’s runs', path: async (p) => (await previewed(p)).preview, drawn: PREVIEW, fixture: asksFirst, then: onVerdict('Verify') },
  { name: 'Preview change on runs', path: () => '/runs', drawn: 'main#view table.runst tbody tr', fixture: asksFirst, then: previewChange },
  { name: 'Run more attempts on a preview', path: async (p) => (await previewed(p)).preview, drawn: PREVIEW, fixture: asksWithMore, then: onVerdict('Run more attempts') },
];

/** An injection test's finding on the run it tested, and its results in the inspector's place: the matrix of its attempts. */
const FINDING = 'main#view [data-finding="injection"]';
const RESULTS = '#insp.fpanel .rmx';
const resultsOpen = async (page: Page): Promise<void> => {
  if (!(await page.locator(RESULTS).isVisible())) await click(page, `${FINDING} button[data-act="results"]`, undefined, { shows: RESULTS })();
};
/** From the results, the attempt a cell opens, at its canary write on Request. */
const toAttempt = async (page: Page): Promise<void> => {
  await resultsOpen(page);
  await click(page, '#insp.fpanel a.rmx-c', undefined, { shows: '#insp mark.cnry' })();
};
/** Tests with the injection fixture's golden's report open: its gate failed, its proof drawn as the attempt's finding draws it. */
const gateReport = async (page: Page): Promise<void> => {
  await openReport(page, 'research');
  await settled(page);
};
/** Share's Security report, which asks in a dialog. */
const securityReport = async (page: Page): Promise<void> => {
  await click(page, '#shareBtn', undefined, { shows: MENU })();
  await click(page, `${MENU} [role="menuitem"]`, 'Security report', { shows: DIALOG })();
};

/**
 * An injection test's pages (port/injection-results), on a store of their own that real commands
 * made (injection-fixture.ts), which `served` serves: the demo keeps no injection result. The run
 * tested with its finding and its results open, an attempt at its canary write, Turns' untrusted
 * tags, the Forks view, Tests with the golden's gate and its report, Needs a look's Security row,
 * and Share's Security report last.
 */
export function injectionRoutes(served: Served, runId: string): RouteState[] {
  const on = (name: string, path: string, drawn: string, then?: RouteState['then']): RouteState => ({ name, path: () => path, drawn, served, ...(then ? { then } : {}) });
  return [
    on('an injection test’s run, its results open', `/run/${runId}`, 'run', resultsOpen),
    on('an injection attempt at its canary write', `/run/${runId}`, 'run', toAttempt),
    on('an injection test’s run · turns', `/run/${runId}/turns`, 'run'),
    on('an injection test’s run · forks', `/run/${runId}/forks`, 'main#view .fnode.fb'),
    on('Tests with an injection gate, its report open', '/tests', 'main#view table.gt', gateReport),
    on('Needs a look with a Security row', '/', 'main#view .arow[data-agrp="security"]'),
    on('Share’s Security report', `/run/${runId}`, 'run', securityReport),
  ];
}

/** Shows a route's state: its answers routed, its address opened and drawn, its step taken, and the page settled. */
export const show = (page: Page, r: RouteState) => async () => {
  if (r.fixture) {
    await r.fixture(page);
    await page.goto('about:blank');
    // Requests the page still had out as it went are cancelled with it, and the browser need not say so: a change-feed
    // poll sent as it left was neither answered nor failed, and the sweep waited a minute on it.
    apiRequests(page).clear();
  }
  await at(page, await r.path(page), r.drawn, r.served)();
  if (r.then) await r.then(page);
};

/** The table as a sweep's states, each named with `on` after it. */
export const routeStates = (page: Page, on = '', routes: readonly RouteState[] = ROUTES): State[] => routes.map((r): State => [`${r.name}${on}`, show(page, r)]);
