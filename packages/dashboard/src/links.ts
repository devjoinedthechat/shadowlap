/**
 * The dashboard's links, `#/…`, as the server writes them into what it answers (a read model's
 * `href`, an activity entry, Needs a look, a job's drawer) and as the page writes its own: one
 * builder, so a link always opens the page it names. The routes are the page's (`ui/route.ts`, which
 * parses them back: a test round-trips every link built here through that parser). Pure, with no
 * Node imports: the page's bundle imports it too.
 *
 *   #/                                   Overview
 *   #/runs[?q=<words>&type=<chip>]       Runs, filtered when the link asks
 *   #/run/<id>[/<call>[/<view>]]         a run, a call, a view
 *   #/compare[/<a>/<b>]                  Compare
 *   #/fixes[/<id>[/<step>[/<sub>]]]      Fixes
 *   #/tests  #/training[/tasks]  #/settings[/<tab>]  #/new  #/setup  #/setup/store
 */

/** A run page's views; Calls is the default and leaves the link. */
export type LinkView = 'calls' | 'turns' | 'context' | 'timeline' | 'forks' | 'provenance';

/** The chips a link to Runs can pick. */
export type RunsLinkType = 'all' | 'recording' | 'fork' | 'clean' | 'test' | 'capture' | 'failed' | 'local';

const enc = encodeURIComponent;

/** Words for a query string, as a browser's URLSearchParams writes them, with the characters it leaves alone escaped too. */
const queryValue = (v: string) => enc(v).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export const links = {
  overview: (): string => '#/',
  /** Runs, filtered by words (`q`) and a chip (`type`) when the link asks for them. */
  runs: (filter: { q?: string | null; type?: RunsLinkType | null } = {}): string => {
    const parts = [...(filter.q?.trim() ? [`q=${queryValue(filter.q.trim())}`] : []), ...(filter.type && filter.type !== 'all' ? [`type=${filter.type}`] : [])];
    return `#/runs${parts.length ? `?${parts.join('&')}` : ''}`;
  },
  /** A run, at a call, in a view. */
  run: (id: string, call?: number | null, view?: LinkView | null): string => {
    const v = view && view !== 'calls' ? `/${view}` : '';
    return `#/run/${enc(id)}${call ? `/${call}` : ''}${v}`;
  },
  compare: (a?: string | null, b?: string | null): string => (a && b ? `#/compare/${enc(a)}/${enc(b)}` : '#/compare'),
  /** Fixes, a fix, one of its steps (`blame`, `repair`, `verify`), and a verdict of its Verify step. */
  fixes: (id?: string | null, step?: string | null, sub?: string | null): string => `#/fixes${id ? `/${enc(id)}${step ? `/${enc(step)}${sub ? `/${enc(sub)}` : ''}` : ''}` : ''}`,
  tests: (): string => '#/tests',
  training: (tab?: 'pairs' | 'tasks'): string => (tab === 'tasks' ? '#/training/tasks' : '#/training'),
  /** Settings, at a tab (`matching`, `redaction`, `alerts` for CI, `agents`, `tools`, `project`, `store`). */
  settings: (tab?: string | null): string => (tab ? `#/settings/${enc(tab)}` : '#/settings'),
  newProject: (): string => '#/new',
  setup: (): string => '#/setup',
  storeSetup: (): string => '#/setup/store',
};

/**
 * What a link a command reports to its job may look like (`{"type":"link","href":"#/…"}`): a route
 * of the page, its characters those a fragment carries, at most 512 of them. The page opens it.
 */
export function isLink(href: unknown): href is string {
  return typeof href === 'string' && href.length <= 512 && /^#\/[\w\-./~%?=&+:@,!*$]*$/.test(href);
}
