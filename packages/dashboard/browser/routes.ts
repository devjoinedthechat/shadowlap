import { expect, type Page, type Request } from '@playwright/test';
import { dash, demoId, openPage, seriousViolations } from './dashboard.js';
import { routeTestsFixture } from './tests-fixture.js';

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

export const at = (page: Page, path: string, drawn = 'main#view') => async () => {
  apiRequests(page);
  await openPage(page, path, drawn);
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
   * Answers routed before it opens, for a state the demo can't draw. They stay for the page's life,
   * so the table holds such states last and a sweep shows them after the rest.
   */
  fixture?: (page: Page) => Promise<unknown>;
  /** A step once the page has drawn, a row opened or a revision gone to: the state is what that shows. */
  then?: (page: Page) => Promise<void>;
  /** The one check it skips, sideways scroll at 320, and why: a page that needs a redesign there, never a silent skip. */
  narrow?: { skips: 'sideways at 320'; why: string };
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

/** Every route state, for a sweep to show one at a time with `show`. */
export const ROUTES: readonly RouteState[] = [
  route('/', 'overview'),
  route('/runs', 'main#view table.runst tbody tr'),
  ...['capture', 'test', 'failed'].map((t) => route(`/runs?types=${t}`)),
  route('/runs?q=label%3Agood'),
  ...VIEWED.flatMap((name) => RUN_VIEWS.map((v): RouteState => ({ name: `run ${name}${v ? ` · ${v}` : ''}`, path: () => `/run/${demoId(name)}${v ? `/${v}` : ''}`, drawn: 'run' }))),
  route('/compare', COMPARE),
  { name: '/compare with a row open', path: () => '/compare', drawn: COMPARE, then: openFirstRow },
  route('/changes', VERDICTS),
  { name: 'a revision’s page', path: () => '/changes', drawn: VERDICTS, then: toRevision },
  route('/changes/decisions'),
  { name: 'Preview', path: async (p) => (await previewed(p)).preview, drawn: PREVIEW },
  { name: 'a preview’s opened cell', path: async (p) => (await previewed(p)).cell, drawn: CELL },
  { name: 'a run’s Decisions view', path: async (p) => (await previewed(p)).view, drawn: DVIEW },
  route('/fixes'),
  ...STEPS.map((step): RouteState => ({ name: `a fix${step ? ` · ${step.slice(1)}` : ''}`, path: () => `/fixes/${demoId('refundFix')}${step}`, drawn: 'fix' })),
  route('/tests'),
  route('/training'),
  route('/training/tasks'),
  ...SETTINGS.map((t): RouteState => ({ name: `Settings → ${t}`, path: () => `/settings/${t}`, drawn: SETTAB })),
  route('/new'),
  route('/setup'),
  route('/setup/store'),
  ...['/nowhere', '/run/01ZZZZZZZZZZZZZZZZZZZZZZZZ', '/fixes/fx-nope'].map((p) => route(p, NOT_FOUND)),
  // Answers the demo can't give: kept last, as they stay routed for the page's life.
  { name: 'Tests with a gated golden’s evidence open', path: () => '/tests', drawn: 'main#view table.gt', fixture: routeTestsFixture, then: (p) => click(p, 'main#view button.gev', undefined, { shows: 'main#view tr.gevrow .alist' })() },
];

/** Shows a route's state: its answers routed, its address opened and drawn, its step taken, and the page settled. */
export const show = (page: Page, r: RouteState) => async () => {
  if (r.fixture) await r.fixture(page);
  await at(page, await r.path(page), r.drawn)();
  if (r.then) await r.then(page);
};

/** The table as a sweep's states, each named with `on` after it. */
export const routeStates = (page: Page, on = '', routes: readonly RouteState[] = ROUTES): State[] => routes.map((r): State => [`${r.name}${on}`, show(page, r)]);
