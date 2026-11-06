import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RunPicker } from '../ui/compare/RunPicker.js';
import { EventIcon } from '../ui/components/RunIcon.js';
import { ResponseDifferences } from '../ui/pages/Compare.js';
import { TodayCard, WeekGrid } from '../ui/overview/panels.js';
import { matchPalette } from '../ui/palette.js';
import { RunHeader } from '../ui/run/RunHeader.js';
import { sideStatus } from '../ui/runs.js';
import { fitRunsTable, RunsTable } from '../ui/runspage/RunsTable.js';
import { RecentRuns } from '../ui/shell/Sidebar.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { CompareView, RunDetail, RunListItem } from '../ui/types.js';
import { runTestsJob, type GoldenSource } from '../src/tests.js';
import { jobTitle } from '../ui/jobs.js';
import { ACTIONS, confirmWords, dialogName, doneWords } from '../ui/labels.js';
import { ACTION_ORDER } from '../ui/palette.js';
import { shareItems } from '../ui/run/share.js';
import { sheet } from './css-sheet.js';

/**
 * A run is named by its id everywhere, with one quiet line that says what it was about (decision
 * 10): each place that names a run draws its id, in mono and whole, and its about line where it has
 * room, as the line the fitter fits (about.ts), with all of it on hover.
 */

const app = (over: Partial<AppState> = {}): AppState =>
  ({
    client: {},
    exported: false,
    meta: null,
    runs: [],
    actionsOff: null,
    hasKind: () => true,
    guard: (fn: () => void) => fn(),
    watchJob: () => undefined,
    toast: () => undefined,
    refresh: () => undefined,
    jobs: [],
    live: [],
    feeds: {},
    tick: 0,
    runsTick: 0,
    ...over,
  }) as unknown as AppState;

const inApp = (el: ReactElement, over: Partial<AppState> = {}) => renderToStaticMarkup(createElement(AppContext.Provider, { value: app(over) }, el));

const REC = '01M5GRX4VY5XKQ0MRGD13QZKZN';
const FORK = '01M5GRX8K406H4KHQ7DEKYWTSZ';

function detail(over: { runId?: string; parent?: string | null; about?: RunDetail['about']; divergence?: number | null; labels?: string[]; source?: string | null; status?: string; kind?: string; failed?: boolean } = {}): RunDetail {
  const runId = over.runId ?? FORK;
  const parent = over.parent === undefined ? REC : over.parent;
  const d = over.divergence === undefined ? 17 : over.divergence;
  return {
    run: { runId, parentRunId: parent, mode: parent ? 'replay' : 'record', status: over.status ?? 'completed', divergence: d ? { type: 'request_changed', callNo: d, kind: 'api', name: 'POST /v1/messages', replayedBefore: d - 1 } : null, command: { argv: ['node', 'refund_agent.mjs', 'T-8812'], cwd: '/work' }, codeVersion: 'f6c5756', startedAt: 1, endedAt: 2, meta: { labels: over.labels ?? ['what-if'] } },
    label: d ? `fork @${d}` : 'recording',
    about: over.about === undefined ? { text: 'override #16', from: 'change', change: { flag: '--override', callNo: 16, forkAt: 17 } } : over.about,
    source: over.source ?? null,
    summary: { cost: { spent: 0.01, saved: 0, captured: 0 }, imported: false, durationMs: 379, upstreamRequests: 8, byKind: { api: 1, tool: 1, clock: 0, random: 0 } },
    calls: [],
    parent: parent ? { runId: parent, label: 'recording' } : null,
    children: [],
    actions: [],
    fix: null,
    state: { status: over.status ?? 'completed', endedAt: 2, kind: over.kind ?? (d ? 'fork' : 'recording'), outcome: { kind: over.failed ? 'check-failed' : 'none' }, failed: !!over.failed, interrupted: false, label: d ? `fork @${d}` : 'recording' },
  } as unknown as RunDetail;
}

const header = (run: RunDetail, runs: RunListItem[] = []) => inApp(createElement(RunHeader, { run, call: null, selected: 17, rescued: false, offers: null, forkMenu: { open: false, anchor: null, toggle: () => undefined, close: () => undefined } as never, onAction: () => undefined, onFindCommit: () => undefined }), { runs });

describe('a run’s page names it by its id, with its about line under it', () => {
  it('heads the page with the id in mono, the about line under it and the labels after it', () => {
    const html = header(detail());
    // The whole id is on Copy ID's card, and the heading's data-run: a title would show over the id's own card.
    expect(html).toMatch(/<h1 class="rnm" tabindex="0" aria-describedby="rmeta" data-run="01M5GRX8K406H4KHQ7DEKYWTSZ">01M5GRX8K4<\/h1>/);
    const about = html.slice(html.indexOf('class="rabout"'));
    expect(about).toMatch(/^class="rabout"><span class="rab" data-about="override #16" data-from="change" title="override #16">override #16<\/span><span class="labelbar">/);
    expect(about).toContain('what-if');
  });

  it('names only the kind in the eyebrow: the parent is in the crumbs, and a phone reads it after the kind', () => {
    const html = header(detail(), [{ runId: REC, about: { text: 'Ticket T-8812 arrived damaged', from: 'user' } } as RunListItem]);
    const eyebrow = html.slice(html.indexOf('class="eyebrow ek"'), html.indexOf('<h1'));
    expect(eyebrow).toContain('<span class="ebk">fork @17</span>');
    expect(eyebrow).toContain(`<span class="ebp"><span class="ebof">of</span><a href="#/run/${REC}" title="Ticket T-8812 arrived damaged"><code>01M5GRX4VY</code></a></span>`);
  });

  it('gives a clean replay, whose about line says what the eyebrow does, no line of its own: its labels sit after Copy ID', () => {
    const html = header(detail({ divergence: null, about: { text: 'clean replay', from: 'nothing', change: null }, kind: 'clean' }));
    expect(html).not.toContain('class="rabout"');
    expect(html).not.toContain('data-about');
    const title = html.slice(html.indexOf('class="rtitle"'), html.indexOf('class="meta"'));
    expect(title).toContain('class="labelbar"');
  });

  it('leaves out of an import’s meta line the file its about line names', () => {
    const html = header(detail({ parent: null, divergence: null, source: 'refund-A-1077.har', about: { text: 'refund-A-1077.har', from: 'source' }, kind: 'capture' }));
    expect(html).toContain('data-about="refund-A-1077.har"');
    expect(html.slice(html.indexOf('class="meta"'))).not.toContain('refund-A-1077.har');
  });

  it('shows the id alone for a run an older server sends no about line for', () => {
    const html = header(detail({ about: null }));
    expect(html).toContain('<h1 class="rnm"');
    expect(html).not.toContain('class="rabout"');
  });
});

/** A run as /api/runs lists it, with its about line. */
function listed(runId: string, over: Partial<RunListItem> = {}): RunListItem {
  return {
    runId,
    parentRunId: null,
    depth: 0,
    mode: 'record',
    status: 'completed',
    label: 'recording',
    divergence: null,
    command: 'node refund_agent.mjs T-8812',
    codeVersion: 'f6c5756',
    startedAt: 1_000,
    endedAt: 2_000,
    calls: 30,
    spent: 0.016,
    saved: 0,
    captured: 0,
    imported: false,
    covers: null,
    source: null,
    labels: [],
    origins: 'l'.repeat(30),
    kind: 'recording',
    outcome: { kind: 'none' },
    failed: false,
    about: { text: 'Ticket T-8812 from customer C-311: order A-1042 ($240) arrived damaged', from: 'user' },
    ...over,
  };
}

const lostRun = listed('01M5GRYF9FQK708BP829R5FNXQ', { status: 'failed', failed: true, outcome: { kind: 'lost', callNo: 9 }, lostAt: 9, about: { text: 'Order A-1150: the customer asks for a refund', from: 'user' } });
const forkRun = listed(FORK, { parentRunId: REC, mode: 'replay', label: 'fork @17', kind: 'fork', divergence: { callNo: 17, type: 'request_changed' }, labels: ['what-if'], about: { text: 'override #16', from: 'change' } });

describe('the lists name a run by its id, with its about line', () => {
  it('in the sidebar: the id and when, then the about line, followed only by what needs a look', () => {
    expect(sideStatus(lostRun)).toEqual({ text: 'lost at #9', tone: 'err' });
    expect(sideStatus(forkRun)).toBeNull();
    expect(sideStatus(listed('L', { status: 'running', calls: 9 }))).toEqual({ text: '9 calls', tone: null });
    const html = renderToStaticMarkup(createElement(RecentRuns, { runs: [lostRun, listed(REC), forkRun], current: null, loading: false }));
    // The id in its list form, its first six characters quieter.
    expect(html).toContain('<code class="rnm rl id">01M5GRYF9F</code>');
    expect(html).toContain('data-about="Order A-1150: the customer asks for a refund"');
    // What needs a look gives way before the about line would (`fitAbouts`): first to its word, then altogether.
    expect(html).toContain('<span class="r2s" data-gives=""><span class="dot">·</span><em>lost<span class="sgw"> at #9</span></em></span>');
    // A fork under its recording: its about line is what it changed, never cut.
    expect(html).toContain('data-about="override #16" data-from="change"');
    // Nothing that says what kind of run it is: the icon says that.
    expect(html).not.toContain('fork @17 ·');
  });

  it('in Runs: the id in its column, the about line in the next with the labels at its end, and under the id for a phone', () => {
    const html = renderToStaticMarkup(createElement(RunsTable, { rows: [forkRun, lostRun], picked: new Set<string>(), selectable: true, byColumn: false, sort: 'when', onSort: () => undefined, onPick: () => undefined, onPickAll: () => undefined, now: 2_000 }));
    expect(html).toContain('<th class="abcol">About</th>');
    const row = html.slice(html.indexOf('01M5GRX8K4'));
    // Each label a chip that lists the runs labelled so.
    expect(row).toMatch(/<td class="abcell"><span class="abw"><span class="rab" data-about="override #16"[^>]*>override #16<\/span><span class="labs"><a class="chip" href="#\/runs\?q=label%3Awhat-if"[^>]*>what-if<\/a><\/span><\/span><\/td>/);
    // Under the id, where About gives way (a tablet, a phone), with what needs a look after it.
    expect(html).toContain('<span class="rso"><span class="dot">·</span><em>lost at #9</em></span>');
    // The id's hover has its kind, parent and command.
    expect(row).toContain('title="fork @17 of 01M5GRX4VY · node refund_agent.mjs T-8812"');
    // No column or line names a run by its kind and command.
    expect(html).not.toContain('fork @17 of 01M5GRX4VY · <code>');
  });

  it('in Runs with a team store: who made each run as an avatar, the name on hover, so every row keeps one line', () => {
    const ci = { ...lostRun, author: 'ci', ci: 'github' } as RunListItem & { ci: string };
    const html = renderToStaticMarkup(createElement(RunsTable, { rows: [{ ...forkRun, author: 'maya@example.com' }, ci], picked: new Set<string>(), selectable: false, byColumn: true, you: 'maya@example.com', sort: 'when', onSort: () => undefined, onPick: () => undefined, onPickAll: () => undefined, now: 2_000 }));
    expect(html).toContain('<td class="bycell"><span class="byav" role="img" aria-label="maya (you)" data-tip="{&quot;t&quot;:&quot;maya (you)&quot;}"><span class="av ');
    expect(html).toContain('aria-label="ci · GitHub Actions"');
    // No name beside the avatar, and no second line for CI's provider.
    expect(html).not.toContain('class="person"');
    expect(html).not.toContain('<small>GitHub Actions</small>');
  });

  it('in the palette: the about line is the hint, and a run matches its kind, command and labels unseen', () => {
    const items = [
      { group: 'Runs' as const, label: '01M5GRX8K4', hint: 'override #16', match: 'fork @17 · node refund_agent.mjs T-8812 · what-if' },
      { group: 'Runs' as const, label: '01M5GRYF9F', hint: 'Order A-1150: the customer asks for a refund', match: 'recording · node refund_agent.mjs T-8812' },
    ];
    expect(matchPalette(items, 'what-if').map((x) => x.label)).toEqual(['01M5GRX8K4']);
    expect(matchPalette(items, 'A-1150').map((x) => x.label)).toEqual(['01M5GRYF9F']);
    expect(matchPalette(items, 'refund_agent').map((x) => x.label)).toEqual(['01M5GRX8K4', '01M5GRYF9F']);
  });

  it('in Compare’s pickers: a button with the id and its about line, never a select of ids and kinds', () => {
    const html = renderToStaticMarkup(createElement(RunPicker, { label: 'Run A', value: REC, runs: [listed(REC), forkRun], onPick: () => undefined }));
    expect(html).toContain('class="rpick"');
    expect(html).toContain('aria-haspopup="listbox"');
    // In the form of the list under it: its first six characters quieter.
    expect(html).toContain('<code class="rnm rl pid">01M5GRX4VY</code>');
    expect(html).toContain('data-about="Ticket T-8812 from customer C-311: order A-1042 ($240) arrived damaged"');
    expect(html).not.toContain('<select');
  });

  it('on the Overview: the grid’s hover card has the about line under the id, and a recording in progress shows it under its id', () => {
    const row = { runId: FORK, parentRunId: REC, depth: 1, context: false, kind: 'fork', status: 'completed', outcome: { kind: 'none' }, failed: false, label: 'fork @17', about: { text: 'override #16', from: 'change', change: null }, rescues: null, startedAt: 1, calls: 3, cells: 'rrl', forkCell: 2, origins: { r: 2, l: 1, o: 0, i: 0, f: 0, b: 0, s: 0 } };
    const grid = renderToStaticMarkup(createElement(WeekGrid, { grid: { runs: 1, calls: 3, origins: row.origins, families: [{ size: 1, cols: 30, rows: [row] }], shown: 1, more: 0 } as never, now: 2 }));
    expect(grid).toContain('&quot;s&quot;:&quot;override #16&quot;');
    const today = { day: '2026-10-22', served: 0, notRespent: 0, recording: [{ runId: '01M5GRZNA5PJ6DHP9G395YMSJG', command: 'node refund_agent.mjs T-8813', calls: 9, startedAt: 1, about: { text: 'My blender arrived broken', from: 'user' } }], replays: 0, forks: { count: 0, live: 0, blocked: 0 }, tests: { count: 0, failed: 0, inconclusive: 0, latestFailure: null }, blame: { probes: 0, attempts: 0, runs: [] } };
    const card = renderToStaticMarkup(createElement(TodayCard, { today: today as never, live: [], tests: null }));
    expect(card).toContain('Recording <code>01M5GRZNA5</code>');
    expect(card).toContain('<span class="rab d" data-about="My blender arrived broken"');
    expect(card).not.toContain('node refund_agent.mjs T-8813</span>');
  });
});

describe('Compare names each run by its whole id', () => {
  it('opens a call whose answer changed in either run, each by its id, never a few characters of it', () => {
    const c = { a: { runId: REC }, b: { runId: FORK }, firstRequestDifference: null, responseDifferences: [{ callNo: 5, kind: 'api', name: 'POST /v1/messages', detail: '"Issuing the refund." → "Above the limit."', sameAnswer: false }] } as unknown as CompareView;
    const html = renderToStaticMarkup(createElement(ResponseDifferences, { c }));
    const ids = [...html.matchAll(/<code class="rnm">([^<]*)<\/code>/g)].map((m) => m[1]);
    expect(ids).toEqual(['01M5GRX4VY', '01M5GRX8K4']);
    expect(html).toContain(`href="#/run/${REC}/5" title="Open 01M5GRX4VY at #5"`);
    expect(html).toContain(`href="#/run/${FORK}/5" title="Open 01M5GRX8K4 at #5"`);
  });
});

describe('Runs’ columns give way, measured, so About keeps its room', () => {
  /**
   * A Runs table whose About column is `about` wide, gaining what each column it leaves out gives it
   * (`org` for the strip of calls by origin, `by` for By), with labelled rows whose labels are as wide
   * as given: the measures the fit reads after layout.
   */
  function table(o: { about: number; org?: number; by?: number; byColumn?: boolean; labs?: Array<{ width: number; about: string }>; width?: number; panel?: number }) {
    const classes = new Set<string>();
    const room = () => o.about + (classes.has('no-org') ? (o.org ?? 0) : 0) + (classes.has('no-by') ? (o.by ?? 0) : 0);
    const th = { getBoundingClientRect: () => ({ width: room() }) };
    const labs = (o.labs ?? []).map((l) => ({ getBoundingClientRect: () => ({ width: l.width }), parentElement: { querySelector: () => ({ dataset: { about: l.about, from: 'user' } }) } }));
    const t = {
      classList: { add: (...c: string[]) => c.forEach((x) => classes.add(x)), remove: (...c: string[]) => c.forEach((x) => classes.delete(x)), contains: (c: string) => classes.has(c) },
      matches: (sel: string) => sel === 'table.runst',
      querySelector: (sel: string) => (sel === 'th.abcol' ? th : sel === 'th.bycol' ? (o.byColumn ? {} : null) : null),
      querySelectorAll: (sel: string) => (sel === '.abcell .labs' ? labs : []),
      closest: () => (o.panel ? { clientWidth: o.panel } : null),
      getBoundingClientRect: () => ({ width: o.width ?? 0 }),
    };
    return { el: t as unknown as HTMLElement, classes };
  }

  /** Fits it in a window `width` wide, text measured at 7px a character. */
  function fit(t: ReturnType<typeof table>, width = 1440): string[] {
    const g = globalThis as Record<string, unknown>;
    const had = { innerWidth: g.innerWidth, getComputedStyle: g.getComputedStyle, document: g.document };
    g.innerWidth = width;
    g.getComputedStyle = () => ({ font: '12.5px Inter' });
    g.document = { createElement: () => ({ getContext: () => ({ font: '', measureText: (x: string) => ({ width: x.length * 7 }) }) }) };
    try {
      fitRunsTable(t.el);
    } finally {
      for (const [k, v] of Object.entries(had)) if (v === undefined) delete g[k];
      else g[k] = v;
    }
    return [...t.classes].sort();
  }

  it('keeps every column while About has its room', () => {
    expect(fit(table({ about: 360, labs: [{ width: 120, about: 'Order A-1042: the customer asks for a refund' }] }))).toEqual([]);
  });

  it('gives up the strip of calls by origin first, then the labels, then By, before the about line goes under the id', () => {
    // The strip alone gives About its 200px.
    expect(fit(table({ about: 150, org: 60 }))).toEqual(['no-org']);
    // Labels that need more than About has, beside the shortest form of their run's line: they go next.
    expect(fit(table({ about: 250, org: 20, labs: [{ width: 200, about: 'Order A-1042: the customer asks for a refund' }] }))).toEqual(['no-labs', 'no-org']);
    // With a team store, By goes last, and gives About its room.
    expect(fit(table({ about: 120, org: 30, by: 100, byColumn: true }))).toEqual(['no-by', 'no-labs', 'no-org']);
    // Without one there is no By to give up: the about line goes under the id.
    expect(fit(table({ about: 120, org: 30, by: 100 }))).toEqual(['no-by', 'no-labs', 'no-org', 'stacked']);
  });

  it('puts the about line under the id when nothing gives About its room, or on a tablet or a phone', () => {
    expect(fit(table({ about: 100, org: 30, by: 50, byColumn: true }))).toEqual(['no-by', 'no-labs', 'no-org', 'stacked']);
    // Still wider than its panel: a status may wrap after its dot.
    expect(fit(table({ about: 100, org: 30, width: 900, panel: 700 }))).toEqual(['no-by', 'no-labs', 'no-org', 'stacked', 'tight']);
    expect(fit(table({ about: 600 }), 1000)).toEqual(['no-by', 'no-labs', 'no-org', 'stacked']);
  });

  it('keeps a phone’s row to the run and when it started, with what needs a look after the about line', () => {
    const html = renderToStaticMarkup(createElement(RunsTable, { rows: [forkRun, lostRun], picked: new Set<string>(['01M5GRYF9FQK708BP829R5FNXQ']), selectable: true, byColumn: true, sort: 'when', onSort: () => undefined, onPick: () => undefined, onPickAll: () => undefined, now: 2_000 }));
    const [head, ...body] = rowsOf(html);
    expect(body).toHaveLength(2);
    /** The cells a window `width` px wide displays, by their place in the row, the table fitted as such a window fits it. */
    const shown = (width: number) => {
      const t: CssNode = { tag: 'table', classes: ['t', 'runst', ...fit(table({ about: 0, width: width - 34, panel: width - 34 }), width)] };
      const rules = rulesAt(width);
      const places = (row: Row, part: string) => row.cells.flatMap((c, i) => (displayOf(c, [t, { tag: part, classes: [] }, row.tr], rules) === 'none' ? [] : [i]));
      const inHead = places(head, 'thead');
      for (const row of body) expect(places(row, 'tbody')).toEqual(inHead);
      return inHead.map((i) => head.cells[i].text || head.cells[i].classes.join(' '));
    };
    // A phone: the selection, Run and When; the calls by origin, Calls, Spent and Status give way.
    expect(shown(390)).toEqual(['selcell', 'Run', 'When ↓']);
    expect(shown(640)).toEqual(['selcell', 'Run', 'When ↓']);
    // The run takes what the selection and When leave of the panel, with no floor of its own that would widen the table.
    expect(rulesAt(390).filter((r) => r.selectors.includes('table.runst.stacked .runcell') && /min-width/.test(r.body)).at(-1)?.body).toMatch(/min-width: 0;/);
    // What needs a look follows the about line under the id there, as Status is gone.
    expect(rulesAt(390).some((r) => r.selectors.includes('table.runst .rline .rso') && /display: inline/.test(r.body))).toBe(true);
    expect(body[1].cells[1].text).toContain('lost at #9');
    // A tablet keeps them, the about line under the id.
    expect(shown(641)).toEqual(['selcell', 'Run', 'Calls', 'Spent', 'Status', 'When ↓']);
  });
});

/** An element as a selector reads it: its tag and classes. */
interface CssNode {
  tag: string;
  classes: string[];
}

/** A table row's markup: the row, and each cell's tag, classes and text. */
interface Row {
  tr: CssNode;
  cells: Array<CssNode & { text: string }>;
}

const appCss = sheet().replace(/\/\*[\s\S]*?\*\//g, '');

/** Each row of a table's markup, its head first. */
function rowsOf(html: string): Row[] {
  const classes = (attrs: string) => /class="([^"]*)"/.exec(attrs)?.[1].split(/\s+/).filter(Boolean) ?? [];
  return [...html.matchAll(/<tr((?:\s[^>]*)?)>([\s\S]*?)<\/tr>/g)].map((tr) => ({
    tr: { tag: 'tr', classes: classes(tr[1]) },
    cells: [...tr[2].matchAll(/<(th|td)((?:\s[^>]*)?)>([\s\S]*?)<\/\1>/g)].map((c) => ({ tag: c[1], classes: classes(c[2]), text: c[3].replace(/<[^>]+>/g, '').trim() })),
  }));
}

/**
 * The stylesheet's style rules a window `width` px wide applies, in their order: those at its top
 * level and those of each `@media` whose widths take it in. A media feature other than a width is
 * left out, as are other at-rules.
 */
function rulesAt(width: number): Array<{ selectors: string[]; body: string }> {
  const out: Array<{ selectors: string[]; body: string }> = [];
  const applies = (query: string) =>
    query.split(/\band\b/).every((part) => {
      const m = /\((max|min)-width:\s*(\d+)px\)/.exec(part);
      return !!m && (m[1] === 'max' ? width <= Number(m[2]) : width >= Number(m[2]));
    });
  const walk = (from: number, to: number, on: boolean): void => {
    for (let i = from; i < to; ) {
      const open = appCss.indexOf('{', i);
      if (open < 0 || open >= to) return;
      const head = appCss.slice(i, open).trim();
      let end = open + 1;
      for (let depth = 1; depth && end < to; end++) depth += appCss[end] === '{' ? 1 : appCss[end] === '}' ? -1 : 0;
      if (head.startsWith('@media')) walk(open + 1, end - 1, on && applies(head.slice('@media'.length)));
      else if (on && !head.startsWith('@')) out.push({ selectors: head.split(',').map((s) => s.trim()), body: appCss.slice(open + 1, end - 1) });
      i = end;
    }
  };
  walk(0, appCss.length, true);
  return out;
}

/**
 * How an element inside `ancestors` (the nearest last) is displayed under `rules`: the display of the
 * most specific rule that names it and sets one, the later of two as specific. Only selectors of tags,
 * classes and descendants are read; one with anything else names nothing here.
 */
function displayOf(el: CssNode, ancestors: CssNode[], rules: ReturnType<typeof rulesAt>): string {
  const fits = (part: string, n: CssNode) => {
    const [tag, ...classes] = part.split('.');
    return (!tag || tag === n.tag) && classes.every((c) => n.classes.includes(c));
  };
  const names = (selector: string) => {
    if (/[^\w\s.-]/.test(selector)) return false;
    const parts = selector.split(/\s+/);
    if (!fits(parts[parts.length - 1], el)) return false;
    let p = parts.length - 2;
    for (let a = ancestors.length - 1; a >= 0 && p >= 0; a--) if (fits(parts[p], ancestors[a])) p--;
    return p < 0;
  };
  const weight = (selector: string) => (selector.match(/\./g)?.length ?? 0) * 100 + selector.split(/\s+/).filter((p) => /^[a-z]/.test(p)).length;
  let best: { weight: number; display: string } | null = null;
  for (const rule of rules) {
    const display = [...rule.body.matchAll(/(?:^|;)\s*display\s*:\s*([^;!]+)/g)].at(-1)?.[1].trim();
    if (!display) continue;
    for (const s of rule.selectors) if (names(s) && (!best || weight(s) >= best.weight)) best = { weight: weight(s), display };
  }
  return best?.display ?? 'table-cell';
}

describe('one name for each action, and its forms', () => {
  it('names each action verb and object, in sentence case, with no article, an ellipsis on each that asks first', () => {
    for (const [key, words] of Object.entries(ACTIONS)) {
      // Its dialog's title and confirm too, where they aren't its label without the ellipsis.
      for (const label of [words.label, ...('title' in words ? [words.title] : []), ...('confirm' in words ? [words.confirm] : [])]) {
        expect(label, key).toMatch(/^[A-Z]/);
        expect(label.split(' ').slice(1).filter((w) => /^[A-Z][a-z]/.test(w) && !/^(OpenTelemetry|HTML|HAR)$/.test(w)), key).toEqual([]);
        expect(label, key).not.toMatch(/\b(the|a|an)\b/i);
      }
    }
    expect([ACTIONS.findBreakingCommit, ACTIONS.importCapture, ACTIONS.exportPairs, ACTIONS.scoreModel, ACTIONS.runBlameStronger].map((a) => a.label)).toEqual(['Find breaking commit…', 'Import capture…', 'Export pairs…', 'Score model…', 'Run blame with stronger model…']);
    // "Run <command>" where the bare command reads wrong; nothing to ask, no ellipsis.
    expect([ACTIONS.runRepair, ACTIONS.applyFix, ACTIONS.runBlameAgain, ACTIONS.runTests].map((a) => a.label)).toEqual(['Run repair', 'Apply fix', 'Run blame again', 'Run tests']);
  });

  it('titles and confirms a dialog with the name, its drawer in the -ing form and its toast in the past', () => {
    expect([confirmWords(ACTIONS.findBreakingCommit.label), dialogName(ACTIONS.runLive.label, 17), dialogName(ACTIONS.switchModel.label, 3)]).toEqual(['Find breaking commit', 'Run live from #17', 'Switch model from #3']);
    expect([ACTIONS.runRepair, ACTIONS.applyFix, ACTIONS.findBreakingCommit, ACTIONS.importCapture, ACTIONS.exportPairs, ACTIONS.scoreModel].map((a) => a.doing)).toEqual(['Repairing', 'Applying fix', 'Finding breaking commit', 'Importing capture', 'Exporting pairs', 'Scoring model']);
    expect(doneWords(ACTIONS.runTests.doing, 'ok')).toBe('Ran tests');
    expect(doneWords(ACTIONS.addNormalizerAndUpdate.doing, 'ok')).toBe('Added normalizer and updated golden');
    expect(doneWords(ACTIONS.findBreakingCommit.doing, 'ok')).toBe('Found breaking commit');
    expect(doneWords(ACTIONS.runBlameStronger.doing, 'ok')).toBe('Blamed with stronger model');
    // One that didn't end well says what ran, where the past tense would claim more than happened.
    expect([doneWords(ACTIONS.runRepair.doing, 'ran'), doneWords(ACTIONS.findBreakingCommit.doing, 'ran'), doneWords(ACTIONS.applyFix.doing, 'not'), doneWords(ACTIONS.importCapture.doing, 'not')]).toEqual(['Tried repairing', 'Searched for breaking commit', 'Tried applying fix', 'Tried importing capture']);
    // A past tense that says only that it ran holds once it ran, and an outcome its own status gives.
    expect([doneWords(ACTIONS.runTests.doing, 'ran'), doneWords(ACTIONS.runTests.doing, 'not'), doneWords(ACTIONS.applyFix.doing, 'ran', 'applied · tests failed · exit 1')]).toEqual(['Ran tests', 'Tried running tests', 'Applied fix']);
  });

  it('is the name each place offers it by: the palette, Share, the drawer and the server’s job titles', () => {
    expect(ACTION_ORDER).toEqual(['Update goldens', 'Export pairs…', 'Score model…', 'Run tests', 'Import capture…', 'Calibrate']);
    expect(runTestsJob([{ path: 'goldens/a' } as GoldenSource], {})).toMatchObject({ title: ACTIONS.runTests.doing });
    expect(shareItems({ can: () => true, team: null }).map((i) => i.label)).toEqual([ACTIONS.exportHtml.label, ACTIONS.pack.label, ACTIONS.exportDataset.label, ACTIONS.exportTrace.label, ACTIONS.exportHar.label]);
    expect(jobTitle({ args: ['bisect', 'R', '--good', 'x'], done: false, code: null })).toBe('Finding breaking commit');
    expect(jobTitle({ args: ['export', 'html', 'R', 'x.html'], done: false, code: null })).toBe('Exporting HTML report');
  });
});

describe('an event’s icon', () => {
  it('says what it was by its shape and how it came out by its colour', () => {
    const html = (outcome?: 'err' | 'warn') => renderToStaticMarkup(createElement(EventIcon, { kind: 'blame', ...(outcome ? { outcome } : {}) }));
    expect(html()).toContain('class="glyph blame ic"');
    // A stopped blame: the loop, amber; one that failed, red.
    expect(html('warn')).toContain('class="glyph blame ic amb"');
    expect(html('err')).toContain('class="glyph blame ic err"');
    expect(html('warn')).toContain('aria-label="Blame"');
    expect(renderToStaticMarkup(createElement(EventIcon, { kind: 'fixinc' }))).toContain('aria-label="Fix inconclusive"');
  });
});
