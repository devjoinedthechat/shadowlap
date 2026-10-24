import { links, parseRunsQuery, type LinkView, type RunsFilterRead } from '../src/links.js';

/**
 * The dashboard's routes, as the URL fragment holds them. Parsing here, building in `src/links.ts`,
 * the one builder the server's links come from too (`href`): no DOM here, so the tests import it.
 * `router.ts` holds the hooks that follow the address bar.
 *
 *   #/                                   Overview
 *   #/runs[?q=&types=&sort=&from=&to=]   Runs, with what its filter, chips, sort and calendar show
 *   #/run/<id>[/<call>[/<view>]]         a run, a call, a view (the old #/run/<id>/call/<n> still opens)
 *   #/compare[/<a>/<b>]                  Compare
 *   #/fixes[/<id>[/<step>[/<sub>]]]      Fixes
 *   #/tests  #/training[/tasks]  #/settings[/<tab>]  #/new  #/setup
 *   #/setup/store                        the team store's setup
 */

export type View = LinkView;
export const VIEWS: readonly View[] = ['calls', 'turns', 'context', 'timeline', 'forks', 'provenance'];
/** What `v` cycles through: Provenance is reached by its tab or the palette. */
export const CYCLE_VIEWS: readonly View[] = ['calls', 'turns', 'context', 'timeline', 'forks'];

export type Route =
  | { page: 'overview' }
  /** `filter`: what the address asks Runs to show; absent for `#/runs` alone. */
  | { page: 'runs'; filter?: RunsFilterRead }
  | { page: 'run'; id: string; call: number | null; view: View | null }
  | { page: 'compare'; a: string | null; b: string | null }
  | { page: 'fixes'; id: string | null; step: string | null; sub: string | null }
  | { page: 'tests' }
  | { page: 'training'; tab: 'pairs' | 'tasks' }
  | { page: 'settings'; tab: string | null }
  | { page: 'new' }
  | { page: 'setup' }
  | { page: 'store-setup' }
  | { page: 'notfound'; path: string };

export type Page = Route['page'];

const RUN_ID = /^[0-9A-Za-z]{1,26}$/;
const SEGMENT = /^[\w.~:@-]{1,80}$/;

function decode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

function callNumber(s: string | undefined): number | null {
  if (!s || !/^\d{1,7}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 ? n : null;
}

export function isView(s: unknown): s is View {
  return typeof s === 'string' && (VIEWS as readonly string[]).includes(s);
}

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, '').replace(/^\/+/, '').split(/[?&]/)[0] ?? '';
  const at = hash.indexOf('?');
  const query = at >= 0 ? hash.slice(at + 1) : '';
  const parts: string[] = [];
  for (const p of raw.split('/').filter(Boolean)) {
    const d = decode(p);
    if (d === null) return { page: 'notfound', path: raw };
    parts.push(d);
  }
  const [head, a, b, c] = parts;
  if (!head) return { page: 'overview' };
  switch (head) {
    case 'runs': {
      if (parts.length !== 1) return { page: 'notfound', path: raw };
      const filter = parseRunsQuery(query);
      return filter ? { page: 'runs', filter } : { page: 'runs' };
    }
    case 'run': {
      if (!a || !RUN_ID.test(a)) return { page: 'notfound', path: raw };
      // The CLI's old deep link: #/run/<id>/call/<n>.
      if (b === 'call') return { page: 'run', id: a, call: callNumber(c), view: null };
      if (isView(b)) return { page: 'run', id: a, call: null, view: b };
      return { page: 'run', id: a, call: callNumber(b), view: isView(c) ? c : null };
    }
    case 'compare': {
      const ok = (x: string | undefined) => (x && RUN_ID.test(x) ? x : null);
      return { page: 'compare', a: ok(a), b: ok(b) };
    }
    case 'fixes': {
      const ok = (x: string | undefined) => (x && SEGMENT.test(x) ? x : null);
      return { page: 'fixes', id: ok(a), step: ok(b), sub: ok(c) };
    }
    case 'tests':
      return { page: 'tests' };
    case 'training':
      return { page: 'training', tab: a === 'tasks' ? 'tasks' : 'pairs' };
    case 'settings':
      return { page: 'settings', tab: a && SEGMENT.test(a) ? a : null };
    case 'new':
      return { page: 'new' };
    case 'setup':
      return a === 'store' && !b ? { page: 'store-setup' } : { page: 'setup' };
    default:
      return { page: 'notfound', path: raw };
  }
}

/** The links the page writes: the server's builder (`src/links.ts`), so both write every route one way. */
export const href = links;

/** The fragment for a route, so a parsed route can be written back. */
export function routeHref(r: Route): string {
  switch (r.page) {
    case 'overview':
      return href.overview();
    case 'runs':
      return href.runs(r.filter ? { q: r.filter.q, types: r.filter.types, sort: r.filter.sort, from: r.filter.days?.from ?? null, to: r.filter.days?.to ?? null } : {});
    case 'run':
      return href.run(r.id, r.call, r.view);
    case 'compare':
      return href.compare(r.a, r.b);
    case 'fixes':
      return href.fixes(r.id, r.step, r.sub);
    case 'tests':
      return href.tests();
    case 'training':
      return href.training(r.tab);
    case 'settings':
      return href.settings(r.tab);
    case 'new':
      return href.newProject();
    case 'setup':
      return href.setup();
    case 'store-setup':
      return href.storeSetup();
    case 'notfound':
      return `#/${r.path}`;
  }
}

/**
 * The link `shadowlap dashboard` prints carries the session token, and a view to open:
 * `#token=…&open=/run/<id>/call/<n>`. The token and the view to open, or null for any other fragment.
 */
export function readTokenLink(hash: string): { token: string; open: string } | null {
  const token = /(?:^#|&)token=([A-Za-z0-9_-]+)/.exec(hash)?.[1];
  if (!token) return null;
  const open = /&open=(\/[A-Za-z0-9/_-]*)/.exec(hash)?.[1];
  return { token, open: `#${open ?? '/'}` };
}

/**
 * A token link opened in a page that is already open, as when the link a restarted dashboard printed
 * is pasted over an expired one (only the part after the # changes, so the page does not load
 * again): with the token in use, open its view; with another, load the page again to start with it.
 * Null for any other fragment.
 */
export function tokenLinkStep(hash: string, inUse: string | null): { kind: 'open'; to: string } | { kind: 'reload' } | null {
  const link = readTokenLink(hash);
  if (!link) return null;
  return inUse !== null && link.token === inUse ? { kind: 'open', to: link.open } : { kind: 'reload' };
}

/** `g` then one of these, within 0.9 s, goes to a page. */
export const GO_KEYS: Readonly<Record<string, string>> = { o: '#/', r: '#/runs', c: '#/compare', f: '#/fixes', t: '#/tests', a: '#/training', s: '#/settings' };
export const GO_WINDOW_MS = 900;

/** The next view `v` moves to. */
export function nextView(v: View | null): View {
  const i = CYCLE_VIEWS.indexOf(v ?? 'calls');
  return CYCLE_VIEWS[(i + 1) % CYCLE_VIEWS.length]!;
}

/** Which nav entry a route sits under. */
export function navSection(r: Route): 'overview' | 'runs' | 'compare' | 'fixes' | 'tests' | 'training' | 'settings' | null {
  switch (r.page) {
    case 'overview':
      return 'overview';
    case 'runs':
    case 'run':
      return 'runs';
    case 'compare':
    case 'fixes':
    case 'tests':
    case 'training':
    case 'settings':
      return r.page;
    default:
      return null;
  }
}
