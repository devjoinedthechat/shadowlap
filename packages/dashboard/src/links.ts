/**
 * The dashboard's links, `#/…`, as the server writes them into what it answers (a read model's
 * `href`, an activity entry, Needs a look, a job's drawer) and as the page writes its own: one
 * builder, so a link always opens the page it names. The routes are the page's (`ui/route.ts`, which
 * parses them back: a test round-trips every link built here through that parser). Pure, with no
 * Node imports: the page's bundle imports it too.
 *
 *   #/                                   Overview
 *   #/runs[?q=&types=&sort=&from=&to=]   Runs, filtered when the link asks
 *   #/run/<id>[/<call>[/<view>]]         a run, a call, a view
 *   #/compare[/<a>/<b>]                  Compare
 *   #/fixes[/<id>[/<step>[/<sub>]]]      Fixes
 *   #/tests  #/training[/tasks]  #/settings[/<tab>]  #/new  #/setup  #/setup/store
 */

/** A run page's views; Calls is the default and leaves the link. */
export type LinkView = 'calls' | 'turns' | 'context' | 'timeline' | 'forks' | 'provenance';

/** The chips a link to Runs can pick. */
export type RunsLinkType = 'all' | 'recording' | 'fork' | 'clean' | 'test' | 'capture' | 'failed' | 'local';
const RUNS_LINK_TYPES: readonly RunsLinkType[] = ['all', 'recording', 'fork', 'clean', 'test', 'capture', 'failed', 'local'];

/** What the Runs table is sorted by; `when`, newest first, is the default and leaves the link. */
export type RunsLinkSort = 'when' | 'calls' | 'spent';

/**
 * What Runs shows, as its address holds it: the words its filter field holds (`q`), the chip picked
 * (`types`), the sort (`sort`), and the days picked on its calendar, the first and the last, each a
 * day of the viewer's own (`from`, `to`, as `2026-10-20`). So a view of Runs can be shared, kept as
 * a bookmark, and gone back and forward through.
 */
export interface RunsFilter {
  q?: string | null;
  types?: RunsLinkType | null;
  /** The same as `types`, as links named the chip before (`#/runs?type=failed`). */
  type?: RunsLinkType | null;
  sort?: RunsLinkSort | null;
  from?: string | null;
  to?: string | null;
}

/** The filter as a link writes it and the page reads it: only what is set, every field in its place. */
export interface RunsFilterRead {
  q: string;
  types: RunsLinkType;
  sort: RunsLinkSort;
  /** The days picked, or null for none. */
  days: { from: string; to: string } | null;
}

const enc = encodeURIComponent;

/** Words for a query string, as a browser's URLSearchParams writes them, with the characters it leaves alone escaped too. */
const queryValue = (v: string) => enc(v).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** A day's key, `2026-10-20`, as the calendar keys its days. */
const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** The most words a link's filter keeps, as the field takes them. */
export const RUNS_QUERY_MAX = 200;

/** A word this long or longer is looked for in what runs recorded too: the palette's "In recorded data" and the Runs filter alike. */
export const RECORDED_MIN_CHARS = 3;

/** The filter field's terms (`filterTerms`): its words, and what each of its keys asks for. */
export interface FilterTerms {
  /** Lowercased: each must be in a run's id, about line, labels, command, source, revision or kind; a quoted run of words is one. */
  words: string[];
  /** `label:<name>`, as typed: the runs with that label exactly. */
  labels: string[];
  /** `status:<verdict>`: `passed`, `failed`, `inconclusive`, `not-applicable` or `live`, as Status says it; empty for a word it doesn't know, which matches no run. */
  statuses: string[];
  /** `type:<kind>`: `recording`, `fork`, `clean`, `test` or `capture`; empty for a word it doesn't know, which matches no run. */
  types: string[];
  /** `tool:<name>`, lowercased: the runs that called a tool whose name starts so. */
  tools: string[];
}

/** What `status:` takes, the short forms the field accepts too, each as the verdict Status says. */
const STATUS_WORDS: Readonly<Record<string, string>> = { passed: 'passed', pass: 'passed', failed: 'failed', fail: 'failed', inconclusive: 'inconclusive', inc: 'inconclusive', 'not-applicable': 'not-applicable', 'not applicable': 'not-applicable', na: 'not-applicable', 'n/a': 'not-applicable', live: 'live' };
/** What `type:` takes, a plural too: each kind as the chips name it, a replay the clean one. */
const TYPE_WORDS: Readonly<Record<string, string>> = { recording: 'recording', fork: 'fork', replay: 'clean', clean: 'clean', test: 'test', capture: 'capture' };

/**
 * The filter field's terms: its words, lowercased, and its `label:`, `status:`, `type:` and `tool:`
 * terms, keys in any case. A label is kept as typed: a run matches one only with that label exactly,
 * as `repair --keeps label:good` and `ls --label` take it. A value with a space in it is quoted,
 * `label:"needs review"`, as a label's chip writes it (`labelTerm`); a label holds no quote. A key with
 * nothing after it is left out, and one the field doesn't know is a word. At most 20 terms. The
 * server's filter and an exported copy's read it alike.
 */
export function filterTerms(q: string | null | undefined): FilterTerms {
  const t: FilterTerms = { words: [], labels: [], statuses: [], types: [], tools: [] };
  let n = 0;
  for (const m of (q ?? '').matchAll(/(?<![^\s])(label|status|type|tool):(?:"([^"]*)"?|(\S*))|"([^"]*)"?|\S+/gi)) {
    if (n === 20) break;
    const key = m[1]?.toLowerCase();
    if (key) {
      const v = (m[2] ?? m[3] ?? '').trim().replace(/\s+/g, ' ');
      if (!v) continue;
      n++;
      if (key === 'label') t.labels.push(v);
      else if (key === 'status') t.statuses.push(STATUS_WORDS[v.toLowerCase()] ?? '');
      else if (key === 'type') t.types.push(TYPE_WORDS[v.toLowerCase().replace(/s$/, '')] ?? '');
      else t.tools.push(v.toLowerCase());
      continue;
    }
    const w = (m[4] ?? m[0]).trim().replace(/\s+/g, ' ').toLowerCase();
    if (!w) continue;
    n++;
    t.words.push(w);
  }
  return t;
}

/** The filter's term for the runs labelled `name` exactly: quoted when it holds a space. */
export function labelTerm(name: string): string {
  return /\s/.test(name) ? `label:"${name}"` : `label:${name}`;
}

/** A filter with what it doesn't set filled in, its days in order: what the page shows for it. */
export function runsFilter(f: RunsFilter = {}): RunsFilterRead {
  const q = (f.q ?? '').slice(0, RUNS_QUERY_MAX);
  const types = f.types ?? f.type ?? 'all';
  const sort = f.sort ?? 'when';
  const from = f.from && DAY.test(f.from) ? f.from : null;
  const to = f.to && DAY.test(f.to) ? f.to : null;
  const a = from ?? to;
  const b = to ?? from;
  return { q, types: RUNS_LINK_TYPES.includes(types) ? types : 'all', sort: sort === 'calls' || sort === 'spent' ? sort : 'when', days: a && b ? (a <= b ? { from: a, to: b } : { from: b, to: a }) : null };
}

/** Whether a filter shows every run, as `#/runs` alone does. */
export function isAllRuns(f: RunsFilterRead): boolean {
  return !f.q.trim() && f.types === 'all' && f.sort === 'when' && !f.days;
}

/**
 * The filter a query string asks for (what follows `#/runs?`), as the page reads it: words, a chip
 * (`types`, or `type` as links wrote it before), a sort and days. Values it doesn't know are left
 * out. Null when it asks for nothing.
 */
export function parseRunsQuery(query: string): RunsFilterRead | null {
  let p: URLSearchParams;
  try {
    p = new URLSearchParams(query);
  } catch {
    return null;
  }
  const chip = p.get('types') ?? p.get('type');
  const sort = p.get('sort');
  const f = runsFilter({
    q: p.get('q'),
    types: RUNS_LINK_TYPES.find((t) => t === chip) ?? null,
    sort: sort === 'calls' || sort === 'spent' ? sort : null,
    from: p.get('from'),
    to: p.get('to'),
  });
  return isAllRuns(f) ? null : f;
}

export const links = {
  overview: (): string => '#/',
  /**
   * Runs, filtered when the link asks: words (`q`), a chip (`types`), a sort, and days (`from`, `to`),
   * in that order, so a filter always writes one link, which `parseRunsQuery` reads back.
   */
  runs: (filter: RunsFilter = {}): string => {
    const f = runsFilter(filter);
    const parts = [
      ...(f.q.trim() ? [`q=${queryValue(f.q.trim())}`] : []),
      ...(f.types !== 'all' ? [`types=${f.types}`] : []),
      ...(f.sort !== 'when' ? [`sort=${f.sort}`] : []),
      ...(f.days ? [`from=${f.days.from}`, `to=${f.days.to}`] : []),
    ];
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
