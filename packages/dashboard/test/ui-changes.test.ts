import { createElement, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { VERDICTS_WINDOW } from '../src/verdicts.js';
import { ApiError, type Client } from '../ui/api.js';
import { changesHref, comparePairHref, forgetComparePair, forgetPreviewSession, noteChangesTab, noteComparePair, notePreviewSession } from '../ui/changes-tab.js';
import { ChangesHead } from '../ui/changes/Head.js';
import { chipEmpty, kindLine, moreLimit, rowTone, verdictHref, VERDICTS_MAX, VERDICTS_STEP } from '../ui/changes/model.js';
import { RevisionPage } from '../ui/changes/RevisionPage.js';
import { forgetVerdictsKept, VerdictsTab } from '../ui/changes/Verdicts.js';
import { rememberList } from '../ui/fixes/data.js';
import { minuteStamp } from '../ui/format.js';
import { ChangesPage } from '../ui/pages/Changes.js';
import { ComparePage } from '../ui/pages/Compare.js';
import { showProject } from '../ui/projects-api.js';
import { navSection, parseRoute, routeHref, samePage } from '../ui/route.js';
import { goTarget, Keyboard } from '../ui/shell/Keyboard.js';
import { Palette } from '../ui/shell/Palette.js';
import { changesCrumbs } from '../ui/shell/top.js';
import { unshownKey, useUnshown } from '../ui/shell/unshown.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { FixesViewRow, Meta, PreviewVerdict, RunDetail, RunListItem, SessionVerdict, VerdictRevision, VerdictRow, VerdictsKind, VerdictsView, VerifyVerdict } from '../ui/types.js';
import { render, type FakeElement, type Rendered } from './ui-render.js';

/**
 * Changes: what a change does to your agent, on its own recorded runs. Its addresses, the tab it
 * comes back to, its head, Verdicts with the newest revision's verdict leading, a revision's page,
 * and Compare under the same head, as the page draws them from what the API gives.
 */

const AT = Date.parse('2026-10-01T10:12:00Z');
const REC = '01M5GRVTKSJ12EE2SE9YZ5W4J3';
const FORK = '01M5GRXFM1Y2E2VBPFX0TV2TGA';

const session = (o: Partial<SessionVerdict> = {}): SessionVerdict => ({
  kind: 'session',
  id: 'd2e8a1f',
  key: 'd2e8a1f',
  at: AT,
  title: 'Tighten refund wording',
  by: null,
  checked: '3 goldens',
  moved: ['1 golden failed'],
  word: 'failed',
  tone: 'no',
  line: '2 of 3 goldens passed',
  revision: 'd2e8a1f',
  sessionId: 'ts-01M5000000000000000000000A',
  subject: 'Tighten refund wording',
  command: 'shadowlap test goldens/* --repeat 3',
  goldens: 3,
  passed: 2,
  failed: 1,
  inconclusive: 0,
  ...o,
});
const preview = (o: Partial<PreviewVerdict> = {}): PreviewVerdict => ({
  kind: 'preview',
  id: 'dc-01M5000000000000000000000A',
  at: AT - 60_000,
  title: 'Model switch to claude-haiku-4-5',
  by: null,
  checked: '3 runs',
  moved: ['2 writes changed', '1 stop changed'],
  word: 'not verified',
  tone: 'y',
  line: '2 of 3 runs to verify',
  sessionId: 'dc-01M5000000000000000000000A',
  revision: 'd2e8a1f',
  runs: 3,
  flagged: 2,
  flaggedRank: 1,
  toVerify: 2,
  ...o,
});
const verify = (o: Partial<VerifyVerdict> = {}): VerifyVerdict =>
  ({
    kind: 'verify',
    id: 'vf-01M5000000000000000000000C',
    at: AT - 120_000,
    title: 'refund-bug',
    by: null,
    checked: '3 runs',
    moved: ['2 fixed', '1 kept'],
    word: 'accepted',
    tone: 'ok',
    line: '2 of 3 runs fixed or kept',
    verifyId: 'vf-01M5000000000000000000000C',
    fixId: 'fx-01M5000000000000000000000D',
    code: 'repair candidate 3',
    repairId: 'rp-01M5000000000000000000000E',
    candidate: 3,
    codeVersion: '370712a',
    fields: null,
    verdict: 'accepted',
    counts: true,
    ...o,
  });

const counted = (rows: VerdictRow[]): Record<VerdictsKind, number> => ({ all: rows.length, sessions: rows.filter((r) => r.kind === 'session').length, previews: rows.filter((r) => r.kind === 'preview' || r.kind === 'migration').length, verifies: rows.filter((r) => r.kind === 'verify').length });
const view = (rows: VerdictRow[], o: Partial<VerdictsView> = {}): VerdictsView => ({ lead: rows.find((r): r is SessionVerdict => r.kind === 'session') ?? null, counts: counted(rows), rows, shared: false, more: false, ...o });

const META = { project: { id: 'support-agent', name: 'support-agent', path: '/work/support-agent' } } as unknown as Meta;

function app(client: Partial<Client>, o: Partial<AppState> = {}): AppState {
  return {
    client: { jobs: () => Promise.resolve([]), compareHead: () => Promise.resolve(null), ...client } as unknown as Client,
    exported: false,
    meta: META,
    tick: 0,
    runsTick: 0,
    feeds: {},
    jobs: [],
    live: [],
    runs: [],
    actionsOff: null,
    hasKind: () => true,
    guard: (fn: () => void) => fn(),
    watchJob: () => undefined,
    toast: () => undefined,
    ...o,
  } as unknown as AppState;
}

let page: Rendered | null = null;
const g = globalThis as Record<string, unknown>;
const saved = { location: g.location, history: g.history };
afterEach(async () => {
  await page?.unmount();
  page = null;
  Object.assign(g, saved);
});

/** The address bar, as the router reads and rewrites it. */
function addressBar(hash: string): { hash: string } {
  const location = { hash, pathname: '/', search: '' };
  Object.assign(g, { location, history: { state: null, replaceState: (_s: unknown, _t: string, url: string) => (location.hash = url.slice(url.indexOf('#'))) } });
  return location;
}

/** Each project of a test its own, so what a tab notes starts fresh. */
let projects = 0;
const freshProject = () => {
  const id = `project-${++projects}`;
  showProject(id);
  return id;
};

const shown = (el: { textContent: string } | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
/** A cell's text, its line under it apart: the two are drawn one above the other, with no space between. */
const cellText = (td: FakeElement | undefined): [string, string] => {
  const sub = td?.querySelector('.rsub');
  const all = td?.textContent ?? '';
  return [shown({ textContent: all.slice(0, all.length - (sub?.textContent.length ?? 0)) }), shown(sub)];
};
const tip = (el: { getAttribute(n: string): string | null }) => JSON.parse(el.getAttribute('data-tip') ?? '{}') as { t?: string; cmd?: string };

describe('Changes’ addresses', () => {
  it('opens Verdicts at #/changes and #/changes/verdicts alike, a revision there by its key, and nothing for another tab', () => {
    expect(parseRoute('#/changes')).toEqual({ page: 'changes', tab: 'verdicts', id: null });
    expect(parseRoute('#/changes/verdicts')).toEqual(parseRoute('#/changes'));
    expect(routeHref(parseRoute('#/changes/verdicts'))).toBe('#/changes');
    expect(parseRoute('#/changes/verdicts/d2e8a1f%2Bdirty')).toEqual({ page: 'changes', tab: 'verdicts', id: 'd2e8a1f+dirty' });
    expect(routeHref(parseRoute('#/changes/verdicts/d2e8a1f+dirty'))).toBe('#/changes/verdicts/d2e8a1f%2Bdirty');
    expect(parseRoute('#/changes/verdicts/no-revision')).toMatchObject({ id: 'no-revision' });
    // A key no revision could be is the list, as a fix's bad step is.
    expect(parseRoute('#/changes/verdicts/..%2Fetc')).toEqual({ page: 'changes', tab: 'verdicts', id: null });
    expect(parseRoute('#/changes/decisions/dc-01M5000000000000000000000A')).toEqual({ page: 'changes', tab: 'decisions', id: 'dc-01M5000000000000000000000A' });
    expect(parseRoute('#/changes/migrate')).toEqual({ page: 'changes', tab: 'migrate', id: null });
    // A run's row opens its most telling step; a call, its cell. A call that isn't a number is dropped; a run that can't be an id, or more parts, is no page.
    expect(parseRoute('#/changes/decisions/dc-01M5000000000000000000000A/01M5MXZ7H9ABCDEF')).toEqual({ page: 'changes', tab: 'decisions', id: 'dc-01M5000000000000000000000A', run: '01M5MXZ7H9ABCDEF' });
    expect(parseRoute('#/changes/migrate/mg-01M5000000000000000000000B/01M5MXZ7H9ABCDEF/17')).toEqual({ page: 'changes', tab: 'migrate', id: 'mg-01M5000000000000000000000B', run: '01M5MXZ7H9ABCDEF', call: 17 });
    expect(parseRoute('#/changes/decisions/dc-01M5000000000000000000000A/01M5MXZ7H9ABCDEF/x')).toEqual({ page: 'changes', tab: 'decisions', id: 'dc-01M5000000000000000000000A', run: '01M5MXZ7H9ABCDEF' });
    expect(parseRoute('#/changes/decisions/dc-01M5000000000000000000000A/not-a-run').page).toBe('notfound');
    expect(parseRoute('#/changes/decisions/dc-01M5000000000000000000000A/01M5MXZ7H9ABCDEF/17/more').page).toBe('notfound');
    expect(parseRoute('#/changes/verdicts/d2e8a1f/more').page).toBe('notfound');
    expect(parseRoute('#/changes/other')).toMatchObject({ page: 'notfound' });
    expect(parseRoute('#/changes/verdicts/d2e8a1f/more')).toMatchObject({ page: 'notfound' });
  });

  it('sits under Changes in the nav, Compare and a revision’s page too, and counts each tab and each revision’s page as a page of its own', () => {
    for (const hash of ['#/changes', '#/changes/verdicts/d2e8a1f', '#/changes/decisions', `#/compare/${REC}/${FORK}`, '#/compare']) expect(navSection(parseRoute(hash)), hash).toBe('changes');
    // A job's way on that is already open isn't offered: a revision's page isn't Verdicts, nor one session's tab another's.
    const same = (x: string, y: string) => samePage(parseRoute(x), parseRoute(y));
    expect(same('#/changes', '#/changes/verdicts')).toBe(true);
    expect(same('#/changes/verdicts/d2e8a1f', '#/changes/verdicts/d2e8a1f')).toBe(true);
    expect(same('#/changes', '#/changes/verdicts/d2e8a1f')).toBe(false);
    expect(same('#/changes/verdicts/d2e8a1f', '#/changes/verdicts/c91d0f4')).toBe(false);
    expect(same('#/changes/decisions', '#/changes')).toBe(false);
    expect(same('#/changes/decisions/dc-1', '#/changes/decisions/dc-2')).toBe(false);
    expect(same('#/changes/decisions/dc-1', '#/changes/migrate/dc-1')).toBe(false);
    expect(same('#/compare', '#/changes')).toBe(false);
  });

  it('crumbs every tab from Changes itself, which opens Verdicts, a revision as code once its page shows it', () => {
    const crumbs = (hash: string, o = { exported: false, unshown: false }) => changesCrumbs(parseRoute(hash) as Parameters<typeof changesCrumbs>[0], o);
    expect(crumbs('#/changes')).toEqual([{ label: 'Changes', href: '#/changes' }, { label: 'Verdicts', face: 'word' }]);
    expect(crumbs('#/changes/verdicts/d2e8a1f')).toEqual([{ label: 'Changes', href: '#/changes' }, { label: 'Verdicts', href: '#/changes', face: 'word' }, { label: 'd2e8a1f', face: 'code' }]);
    expect(crumbs('#/changes/verdicts/d2e8a1f', { exported: false, unshown: true })).toEqual([{ label: 'Changes', href: '#/changes' }, { label: 'Verdicts', href: '#/changes', face: 'word' }]);
    expect(crumbs(`#/compare/${REC}/${FORK}`)).toEqual([{ label: 'Changes', href: '#/changes' }, { label: 'Compare', face: 'word' }]);
    expect(crumbs('#/compare', { exported: true, unshown: false })).toEqual([{ label: 'Compare' }]);
    // A preview reads as its tab, unlinked, never by its id.
    for (const hash of ['#/changes/decisions', `#/changes/decisions/dc-01M5000000000000000000000A/${REC}/3`]) expect(crumbs(hash)).toEqual([{ label: 'Changes', href: '#/changes' }, { label: 'Preview', face: 'word' }]);
    // A revision's page says it can't show one by its own key, which the crumbs and the title read.
    expect(unshownKey(parseRoute('#/changes/verdicts/d2e8a1f'))).toBe('changes:d2e8a1f');
    expect(unshownKey(parseRoute('#/changes'))).toBeNull();
  });
});

describe('the tab Changes comes back to', () => {
  it('is Verdicts the first time, then the tab last shown in the project, Compare at its pair', () => {
    freshProject();
    expect(changesHref()).toBe('#/changes');
    noteChangesTab('compare');
    expect(changesHref()).toBe('#/compare');
    noteComparePair(REC, FORK);
    expect(changesHref()).toBe(`#/compare/${REC}/${FORK}`);
    // Back on Verdicts the pair stays for Compare's tab.
    noteChangesTab('verdicts');
    expect(changesHref()).toBe('#/changes');
    expect(comparePairHref()).toBe(`#/compare/${REC}/${FORK}`);
    // A pair Compare found gone is forgotten: the next Compare opens as #/compare does.
    noteChangesTab('compare');
    forgetComparePair();
    expect(changesHref()).toBe('#/compare');
  });

  it('is each project’s own', () => {
    const first = freshProject();
    noteChangesTab('compare');
    noteComparePair(REC, FORK);
    freshProject();
    expect(changesHref()).toBe('#/changes');
    showProject(first);
    expect(changesHref()).toBe(`#/compare/${REC}/${FORK}`);
  });

  it('is where g c goes; an exported copy’s goes to its Compare, while it holds two runs', () => {
    freshProject();
    noteChangesTab('compare');
    noteComparePair(REC, FORK);
    expect(goTarget({ exported: false, meta: META }, 'c')).toBe(`#/compare/${REC}/${FORK}`);
    expect(goTarget({ exported: true, meta: { runIds: [REC, FORK] } as unknown as Meta }, 'c')).toBe('#/compare');
    expect(goTarget({ exported: true, meta: { runIds: [REC] } as unknown as Meta }, 'c')).toBeNull();
    expect(goTarget({ exported: true, meta: null }, 'r')).toBe('#/runs');
    expect(goTarget({ exported: true, meta: null }, 't')).toBeNull();
    expect(goTarget({ exported: false, meta: META }, 't')).toBe('#/tests');
  });

  it('opens Preview at the session it last showed, and on the newest once that one is gone', () => {
    const first = freshProject();
    noteChangesTab('decisions');
    expect(changesHref()).toBe('#/changes/decisions');
    notePreviewSession('dc-01M5000000000000000000000A');
    expect(changesHref()).toBe('#/changes/decisions/dc-01M5000000000000000000000A');
    freshProject();
    expect(changesHref()).toBe('#/changes');
    showProject(first);
    forgetPreviewSession();
    expect(changesHref()).toBe('#/changes/decisions');
  });

  it('is where Go to’s Changes row goes, a row found by verdicts, by compare and by preview', async () => {
    freshProject();
    noteChangesTab('compare');
    noteComparePair(REC, FORK);
    const location = addressBar('#/');
    const client = { search: () => Promise.resolve({ hits: [] }), runsPage: () => Promise.resolve({ runs: [], total: 0, next: null, chipCounts: {} }) };
    const shell = { conn: 'ok', runCommands: [], palette: true, setPalette: () => undefined, setSideOpen: () => undefined, setHelp: () => undefined } as const;
    page = await render(createElement(AppContext.Provider, { value: app(client as unknown as Partial<Client>, shell as unknown as Partial<AppState>) }, createElement(Palette, { route: { page: 'overview' } })));
    const rows = () => page!.all('.palit').filter((el) => el.querySelector('.pl')?.textContent === 'Changes');
    for (const typed of ['verdicts', 'compare', 'preview']) {
      await page.type(page.one('.palin input'), typed);
      expect(rows().map((el) => el.querySelector('.ph2')?.textContent), typed).toEqual(['verdicts, compare, preview']);
    }
    await page.click(rows()[0]);
    expect(location.hash).toBe(`#/compare/${REC}/${FORK}`);
  });
});

describe('the head', () => {
  it('names the project and the page, says its line, and has a one-word tab each, its command on hover', async () => {
    freshProject();
    page = await render(createElement(AppContext.Provider, { value: app({}) }, createElement(ChangesHead, { tab: 'verdicts' })));
    expect(page.one('.ph .eyebrow').textContent).toBe('support-agent · diffs');
    expect(page.one('.ph h1').textContent).toBe('Changes');
    expect(page.one('.ph p').textContent).toBe('What a change does to your agent, on its own recorded runs.');
    expect(page.one('nav.stabs').getAttribute('aria-label')).toBe('Changes');
    const tabs = page.all('nav.stabs a');
    // No tab before its page: a migration's joins with its own.
    expect(tabs.map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('aria-current')])).toEqual([
      ['Verdicts', '#/changes', 'page'],
      ['Compare', '#/compare', null],
      ['Preview', '#/changes/decisions', null],
    ]);
    expect(tabs.map(tip)).toEqual([
      { t: 'Every change checked, and its verdict', rows: [], cmd: '$ shadowlap test goldens/*' },
      { t: 'Compare two runs, call by call', rows: [], cmd: '$ shadowlap diff <a> <b>' },
      { t: 'Preview what a change decides differently', rows: [], cmd: '$ shadowlap decisions <runs> --model <model>' },
    ]);
    // Compare's tab follows the pair it last showed, named by short ids, once Compare notes it.
    noteComparePair(REC, FORK);
    await page.wait(0);
    expect(page.all('nav.stabs a')[1].getAttribute('href')).toBe(`#/compare/${REC}/${FORK}`);
    expect(tip(page.all('nav.stabs a')[1]).cmd).toBe('$ shadowlap diff 01M5GRVTKS 01M5GRXFM1');
  });

  it('notes its tab in the project it shows', async () => {
    freshProject();
    noteChangesTab('verdicts');
    page = await render(createElement(AppContext.Provider, { value: app({}) }, createElement(ChangesHead, { tab: 'compare' })));
    expect(changesHref()).toBe('#/compare');
    expect(page.one('nav.stabs a[aria-current="page"]').textContent).toBe('Compare');
  });
});

// The chip and the rows read are kept while the page is open, as they are for Runs: each test that picks a chip picks All again before it ends.
describe('Verdicts', () => {
  const rows = [session(), preview(), verify(), session({ id: 'c91d0f4', key: 'c91d0f4', revision: 'c91d0f4', subject: null, title: 'c91d0f4', word: 'passed', tone: 'ok', line: '3 of 3 goldens passed', moved: [], failed: 0, at: AT - 180_000 })];

  /** Verdicts drawn on a client that answers each read with `answer`, the reads it was asked kept. */
  async function open(answer: (kind: VerdictsKind, limit: number) => Promise<VerdictsView>, o: Partial<AppState> = {}) {
    const asked: Array<[VerdictsKind, number]> = [];
    const verdicts = (kind: VerdictsKind, limit: number) => (asked.push([kind, limit]), answer(kind, limit));
    page = await render(createElement(AppContext.Provider, { value: app({ verdicts }, o) }, createElement(VerdictsTab)));
    return asked;
  }
  const table = () => page!.all('table.vdt tbody tr');
  const chip = (label: string) => page!.all('.chips button').find((b) => b.childNodes[0].textContent === label)!;
  /** A row as it reads: the change and its kind line, checked on, what moved, the word and its line, when. */
  const rowText = (tr: ReturnType<typeof table>[number]) => {
    const [change, checked, moved, verdict, when] = tr.children;
    return [...cellText(change), shown(checked), shown(moved), ...cellText(verdict), shown(when)];
  };

  it('leads with the newest revision’s verdict, its way in lime while it failed or couldn’t decide', async () => {
    await open(() => Promise.resolve(view(rows)));
    await page!.until('the rows', () => table().length === 4);
    expect(page!.one('.verdict .vw').textContent).toBe('failed');
    expect(page!.one('.verdict .vw').className).toContain('err');
    expect(shown(page!.one('.verdict h2'))).toBe('failed d2e8a1f · 2 of 3 goldens passed');
    expect(shown(page!.one('.verdict p'))).toBe(`Tighten refund wording · ${minuteStamp(AT)}`);
    const go = page!.one('.verdict .actions a');
    expect([go.textContent, go.getAttribute('href'), go.className]).toEqual(['Open the change', '#/changes/verdicts/d2e8a1f', 'btn sm lime']);
    await page!.unmount();
    // A revision every golden passed at leads quietly; one titled by its revision says it once.
    const clean = session({ subject: null, title: 'd2e8a1f', word: 'passed', tone: 'ok', failed: 0, line: '3 of 3 goldens passed' });
    await open(() => Promise.resolve(view([clean])));
    await page!.until('the rows', () => table().length === 1);
    expect(page!.one('.verdict .actions a').className).toBe('btn sm');
    expect(shown(page!.one('.verdict p'))).toBe(minuteStamp(AT));
  });

  it('has no lead before a session ran every golden', async () => {
    await open(() => Promise.resolve(view([preview()])));
    await page!.until('the rows', () => table().length === 1);
    expect(page!.all('.verdict')).toHaveLength(0);
  });

  it('draws a row per change: what it is and how it was checked, what moved, its verdict in its command’s words, and when', async () => {
    await open(() => Promise.resolve(view(rows)));
    await page!.until('the rows', () => table().length === 4);
    expect(page!.all('table.vdt thead th').map((th) => [th.textContent, th.className || null])).toEqual([
      ['Change', null],
      ['Checked on', 'hide-sm'],
      ['What moved', 'hide-md'],
      ['Verdict', null],
      ['When', 'hide-sm'],
    ]);
    expect(table().map(rowText)).toEqual([
      ['Tighten refund wording', 'test session · d2e8a1f', '3 goldens', '1 golden failed', 'failed', '2 of 3 goldens passed', minuteStamp(AT)],
      ['Model switch to claude-haiku-4-5', 'preview · on d2e8a1f', '3 runs', '2 writes changed · 1 stop changed', 'not verified', '2 of 3 runs to verify', minuteStamp(AT - 60_000)],
      ['refund-bug', 'verify · repair candidate 3', '3 runs', '2 fixed · 1 kept', 'accepted', '2 of 3 runs fixed or kept', minuteStamp(AT - 120_000)],
      // Titled by its revision, which its kind line then leaves out; nothing moved.
      ['c91d0f4', 'test session', '3 goldens', '', 'passed', '3 of 3 goldens passed', minuteStamp(AT - 180_000)],
    ]);
    expect(table()[3].querySelector('td.vdc a code')!.textContent).toBe('c91d0f4');
    // Each word in the API's colour: not verified is open, in amber, never muted.
    expect(table().map((tr) => tr.querySelector('.st')!.className)).toEqual(['st err', 'st warn', 'st ok', 'st ok']);
    // A row opens its revision's page, its preview on Preview, or its fix's Verify step.
    expect(table().map((tr) => [tr.querySelector('a.rowa')?.getAttribute('href') ?? null, tr.className || null])).toEqual([
      ['#/changes/verdicts/d2e8a1f', null],
      ['#/changes/decisions/dc-01M5000000000000000000000A', null],
      ['#/fixes/fx-01M5000000000000000000000D/verify/vf-01M5000000000000000000000C', null],
      ['#/changes/verdicts/c91d0f4', null],
    ]);
    // On one machine every check is its own: the note says so, with the way to a team store.
    expect(shown(page!.one('p.vdlocal'))).toBe('This machine’s test sessions only: CI’s show here once it pushes them to a team store. Team store →');
    expect(page!.one('p.vdlocal a').getAttribute('href')).toBe('#/settings/store');
  });

  it('names who made a change only where the API does, with a team store, and leaves the note out there', async () => {
    const named = [session({ by: 'dana@northwind.example' }), preview({ by: 'lee' })];
    await open(() => Promise.resolve(view(named, { shared: true })));
    await page!.until('the rows', () => table().length === 2);
    expect(table().map((tr) => shown(tr.querySelector('.rsub')))).toEqual(['test session · d2e8a1f · dana', 'preview · on d2e8a1f · lee']);
    expect(shown(page!.one('.verdict p'))).toBe(`Tighten refund wording · dana · ${minuteStamp(AT)}`);
    expect(page!.all('p.vdlocal')).toHaveLength(0);
  });

  it('filters by chip through the API, each chip with its count, and keeps the rows until the chip’s come', async () => {
    const asked = await open((kind) => Promise.resolve(view(kind === 'verifies' ? [verify()] : rows, { counts: counted(rows) })));
    await page!.until('the rows', () => table().length === 4);
    expect(page!.one('.chips').getAttribute('aria-label')).toBe('Kind of check');
    expect(page!.all('.chips button').map((b) => [b.childNodes[0].textContent, b.querySelector('b')!.textContent, b.getAttribute('aria-pressed')])).toEqual([
      ['All', '4', 'true'],
      ['Test sessions', '2', 'false'],
      ['Previews', '1', 'false'],
      ['Verifies', '1', 'false'],
    ]);
    await page!.click(chip('Verifies'));
    await page!.until('the verifies', () => table().length === 1);
    expect(asked).toEqual([
      ['all', VERDICTS_STEP],
      ['verifies', VERDICTS_STEP],
    ]);
    // The chip is kept while the page is open: back on Verdicts, it reads the same.
    await page!.unmount();
    const again = await open(() => Promise.resolve(view([verify()], { counts: counted(rows) })));
    await page!.until('the rows', () => table().length === 1);
    expect(again).toEqual([['verifies', VERDICTS_STEP]]);
    await page!.click(chip('All'));
  });

  it('says a chip with nothing in it in a line, and an empty store with the command that fills it', async () => {
    await open(() => Promise.resolve(view([], { counts: { all: 2, sessions: 0, previews: 1, verifies: 1 } })));
    await page!.until('the line', () => page!.all('p.emptyline').length === 1);
    expect(page!.one('p.emptyline').textContent).toBe('No change checked yet.');
    await page!.click(chip('Test sessions'));
    await page!.until('the sessions’ line', () => shown(page!.one('p.emptyline')).startsWith('No test session'));
    expect(shown(page!.one('p.emptyline'))).toBe('No test session yet. Each one CI runs on a pull request lands here.');
    // The previews' line names the tab a preview is made on.
    await page!.click(chip('Previews'));
    await page!.until('the previews’ line', () => shown(page!.one('p.emptyline')).startsWith('No preview'));
    expect(shown(page!.one('p.emptyline'))).toBe('No preview yet. Preview a change on the Preview tab, before it ships.');
    expect(chipEmpty('previews')).toEqual([{ words: 'No preview yet. Preview a change on the Preview tab, before it ships.' }]);
    await page!.click(chip('All'));
    await page!.unmount();
    await open(() => Promise.resolve(view([])));
    await page!.until('the empty state', () => page!.all('.stepempty h2').length === 1);
    expect(page!.one('.stepempty h2').textContent).toBe('No change checked yet');
    expect(page!.one('.stepempty .cmdline').textContent).toContain('shadowlap test goldens/*');
    expect(page!.all('.chips')).toHaveLength(0);
  });

  it('shows its shape while it loads, and says what the server answered when it can’t be read, with Retry', async () => {
    await open(() => new Promise<VerdictsView>(() => undefined));
    expect(page!.one('.skel > .said > .sr[role="status"]').textContent).toBe('Loading the changes checked…');
    expect(page!.all('.skel table.vdt tbody tr')).toHaveLength(5);
    await page!.unmount();
    let tries = 0;
    await open(() => (++tries === 1 ? Promise.reject(new ApiError(500, 'HTTP 500')) : Promise.resolve(view(rows))));
    await page!.until('the error', () => page!.all('.loaderr').length === 1);
    expect(page!.one('.loaderr p').children.map(shown)).toEqual(['couldn’t load', 'The dashboard server answered 500 for this page’s data.']);
    await page!.click(page!.byText('.loaderr button', 'Retry'));
    await page!.until('the rows', () => table().length === 4);
  });

  it('says a chip’s read failed in place of another chip’s rows, under the chips', async () => {
    await open((kind) => (kind === 'previews' ? Promise.reject(new ApiError(503, 'HTTP 503')) : Promise.resolve(view(rows))));
    await page!.until('the rows', () => table().length === 4);
    await page!.click(chip('Previews'));
    await page!.until('the error', () => page!.all('.loaderr').length === 1);
    expect(table()).toHaveLength(0);
    expect(page!.all('.chips')).toHaveLength(1);
    expect(shown(page!.one('.loaderr p'))).toContain('answered 503');
    await page!.click(chip('All'));
  });

  it('shows 50 more at a time up to the window, then says older changes aren’t listed', async () => {
    const many = Array.from({ length: VERDICTS_MAX }, (_, i) => preview({ id: `dc-${i}`, sessionId: `dc-${i}`, at: AT - i }));
    const all = { all: 600, sessions: 0, previews: 600, verifies: 0 };
    const asked = await open((kind, limit) => Promise.resolve(view(many.slice(0, limit), { counts: all, more: true })));
    await page!.until('the rows', () => table().length === VERDICTS_STEP);
    expect(page!.one('button.attn-more').textContent).toBe('Showing 50 of 600 · Show 50 more');
    for (const n of [100, 150, 200]) {
      await page!.click(page!.one('button.attn-more'));
      await page!.until(`${n} rows`, () => table().length === n);
    }
    expect(asked.map(([, limit]) => limit)).toEqual([50, 100, 150, 200]);
    expect(page!.all('button.attn-more')).toHaveLength(0);
    expect(page!.byText('p.vdlocal', 'Older changes than these aren’t listed.')).toBeTruthy();
    // Back from a row, the list reads as far as it was left; another chip reads from the top.
    await page!.unmount();
    const back = await open((kind, limit) => Promise.resolve(view(many.slice(0, limit), { counts: all, more: true })));
    await page!.until('the rows', () => table().length === VERDICTS_MAX);
    await page!.click(chip('Previews'));
    await page!.until('the chip', () => back.length === 2);
    expect(back).toEqual([
      ['all', 200],
      ['previews', 50],
    ]);
    await page!.click(chip('All'));
  });

  it('says a Show more that failed in its button’s place, under the rows it had, and reads on with Retry', async () => {
    const many = Array.from({ length: 120 }, (_, i) => preview({ id: `dc-${i}`, sessionId: `dc-${i}`, at: AT - i }));
    const all = { all: 120, sessions: 0, previews: 120, verifies: 0 };
    let tries = 0;
    const asked = await open((_kind, limit) => (limit > VERDICTS_STEP && ++tries === 1 ? Promise.reject(new ApiError(500, 'HTTP 500')) : Promise.resolve(view(many.slice(0, limit), { counts: all }))));
    await page!.until('the rows', () => table().length === VERDICTS_STEP);
    await page!.click(page!.one('button.attn-more'));
    await page!.until('the error', () => page!.all('.loaderr').length === 1);
    expect(table()).toHaveLength(VERDICTS_STEP);
    expect(page!.all('button.attn-more')).toHaveLength(0);
    expect(shown(page!.one('.loaderr p'))).toContain('answered 500');
    await page!.click(page!.byText('.loaderr button', 'Retry'));
    await page!.until('the next rows', () => table().length === 100);
    expect(page!.all('.loaderr')).toHaveLength(0);
    expect(asked.map(([, limit]) => limit)).toEqual([50, 100, 100]);
    await page!.click(chip('All'));
  });

  it('keeps each project’s own chip: another project’s list starts at All, and the first comes back to its own', async () => {
    forgetVerdictsKept();
    const answer = (kind: VerdictsKind) => Promise.resolve(kind === 'verifies' ? view([verify()], { counts: counted(rows) }) : view(rows));
    const first = freshProject();
    await open(answer);
    await page!.until('the rows', () => table().length === rows.length);
    await page!.click(chip('Verifies'));
    await page!.until('the verifies', () => table().length === 1);
    await page!.unmount();
    freshProject();
    expect(await open(answer)).toEqual([['all', VERDICTS_STEP]]);
    await page!.unmount();
    showProject(first);
    expect(await open(answer)).toEqual([['verifies', VERDICTS_STEP]]);
    await page!.unmount();
    forgetVerdictsKept();
  });

  it('works out each row’s colour, kind line, link and how far Show more reads', () => {
    expect(VERDICTS_MAX).toBe(VERDICTS_WINDOW);
    expect([rowTone('ok'), rowTone('no'), rowTone('y'), rowTone(null)]).toEqual(['ok', 'err', 'warn', 'mu']);
    expect(kindLine(verify({ candidate: null, fields: 'temperature=1', code: 'temperature=1' }))).toEqual([{ words: 'verify' }, { words: 'temperature=1' }]);
    expect(kindLine(verify({ candidate: null, code: '370712a' }))).toEqual([{ words: 'verify' }, { words: 'on', code: '370712a' }]);
    expect(kindLine(verify({ candidate: null, codeVersion: null, code: 'working tree' }))).toEqual([{ words: 'verify' }, { words: 'working tree' }]);
    expect(kindLine(preview({ kind: 'migration', revision: null, by: 'ci' }))).toEqual([{ words: 'migration' }, { words: 'ci' }]);
    expect(kindLine(session({ revision: null, subject: null, title: 'Tested with no revision' }))).toEqual([{ words: 'test session' }]);
    expect(verdictHref(session({ key: 'd2e8a1f+dirty' }))).toBe('#/changes/verdicts/d2e8a1f%2Bdirty');
    // A preview opens on Preview; a migration leads nowhere until its tab lands.
    expect(verdictHref(preview())).toBe('#/changes/decisions/dc-01M5000000000000000000000A');
    expect(verdictHref(preview({ kind: 'migration' }))).toBeNull();
    expect(moreLimit({ shown: 50, limit: 50, count: 120 })).toBe(100);
    expect(moreLimit({ shown: 120, limit: 150, count: 120 })).toBeNull();
    expect(moreLimit({ shown: 200, limit: 200, count: 600 })).toBeNull();
  });

  it('offers on ⌘K a verify’s row its fix and each step, named as the Fixes list names it once read, else by its id', async () => {
    const fixId = verify().fixId;
    const shell = { conn: 'ok', runCommands: [], help: false, setHelp: () => undefined, sideOpen: false, setSideOpen: () => undefined, runKeys: { current: null } };
    function WithPalette() {
      const [palette, setPalette] = useState(false);
      const state = app({ verdicts: () => Promise.resolve(view([verify()])) }, { ...shell, palette, setPalette } as unknown as Partial<AppState>);
      return createElement(AppContext.Provider, { value: state }, createElement('main', { id: 'view' }, createElement(VerdictsTab)), createElement(Keyboard), createElement(Palette, { route: parseRoute('#/changes/verdicts') }));
    }
    /** ⌘K on the row j puts the focus in: the group's name, and each item's label and hint. */
    async function actions(): Promise<{ name: string; items: string[][] }> {
      await page?.unmount();
      page = await render(createElement(WithPalette));
      await page.until('the row', () => table().length === 1);
      await page.press('j');
      await page.press('k', { metaKey: true });
      await page.until('the palette', () => page!.all('.palette').length === 1);
      return { name: shown(page.one('.palg code')), items: page.all('.palit').map((el) => [shown(el.querySelector('.pl')), shown(el.querySelector('.ph2'))]) };
    }
    try {
      // Before the Fixes list was read: the fix by its id, its title on Open fix, and no step's word.
      rememberList({ fixes: [] });
      expect(await actions()).toEqual({ name: fixId.slice(0, 13), items: [['Open fix', 'refund-bug'], ['Blame', ''], ['Repair', ''], ['Verify', '']] });
      // Once read: by its label, each step hinted with its word in the list.
      const steps = [
        { key: 'blame', short: 'lost at #5' },
        { key: 'repair', short: 'prompt change' },
        { key: 'verify', short: '2 fixed · 1 kept' },
      ];
      rememberList({ fixes: [{ fixId, label: 'refund-bug', title: 'issue_refund called with amount 240', steps } as unknown as FixesViewRow] });
      expect(await actions()).toEqual({ name: 'refund-bug', items: [['Open fix', 'issue_refund called with amount 240'], ['Blame', 'lost at #5'], ['Repair', 'prompt change'], ['Verify', '2 fixed · 1 kept']] });
      // Each opens the fix at its step.
      const location = addressBar('#/changes/verdicts');
      await page!.click(page!.all('.palit').find((el) => shown(el.querySelector('.pl')) === 'Verify')!);
      expect(location.hash).toBe(`#/fixes/${fixId}/verify`);
    } finally {
      rememberList({ fixes: [] });
    }
  });
});

describe('a revision’s page', () => {
  const golden = (name: string, verdict: 'passed' | 'failed' | 'inconclusive', note: string, runId: string | null = null) => ({ golden: `goldens/${name}`, name, verdict, note, runId });
  const revision = (o: Partial<VerdictRevision> = {}): VerdictRevision => ({
    row: session(),
    latest: true,
    lead: golden('refund-flow', 'failed', 'diverged at call 3 · $.model', REC),
    goldens: [golden('refund-flow', 'failed', 'diverged at call 3 · $.model', REC), golden('escalate-over-limit', 'inconclusive', 'inconclusive: the judge check "polite" could not be judged'), golden('refund-in-limit', 'passed', '8/8 replayed')],
    decisions: [preview()],
    shared: false,
    ...o,
  });
  const openRevision = async (answer: () => Promise<VerdictRevision>) => {
    const Probe = () => createElement('i', { id: 'unshown' }, String(useUnshown('changes:d2e8a1f')));
    page = await render(createElement(AppContext.Provider, { value: app({ verdictRevision: answer }) }, createElement(RevisionPage, { rev: 'd2e8a1f' }), createElement(Probe)));
  };

  it('gives its verdict, its goldens worst first as that session judged them, the previews asked at it, and its command', async () => {
    await openRevision(() => Promise.resolve(revision()));
    await page!.until('the goldens', () => page!.all('table.vdg').length === 2);
    expect(shown(page!.one('.verdict h2'))).toBe('failed 2 of 3 goldens passed · refund-flow diverged at call 3 · $.model');
    expect(shown(page!.one('.verdict p'))).toBe(`d2e8a1f · Tighten refund wording · ${minuteStamp(AT)}`);
    const tests = page!.one('.verdict .actions a');
    expect([tests.textContent, tests.getAttribute('href'), tests.className]).toEqual(['Open Tests', '#/tests', 'btn sm lime']);
    const [goldens, decisions] = page!.all('section.panel.sec');
    expect([shown(goldens.querySelector('header h2')), shown(goldens.querySelector('header .sub'))]).toEqual(['Goldens', 'as this session judged them']);
    expect(goldens.querySelectorAll('tbody tr').map((tr) => [shown(tr.children[0]), ...cellText(tr.children[1]), tr.querySelector('a.rowa')!.getAttribute('href')])).toEqual([
      ['refund-flow', 'failed', 'diverged at call 3 · $.model', `#/run/${REC}`],
      ['escalate-over-limit', 'inconclusive', 'inconclusive: the judge check "polite" could not be judged', '#/tests'],
      ['refund-in-limit', 'passed', '8/8 replayed', '#/tests'],
    ]);
    expect([shown(decisions.querySelector('header h2')), shown(decisions.querySelector('header .sub'))]).toEqual(['Decisions', 'the previews asked at this revision']);
    expect(decisions.querySelectorAll('tbody tr').map((tr) => [...cellText(tr.children[0]), ...cellText(tr.children[1]), tr.className])).toEqual([['Model switch to claude-haiku-4-5', `preview · ${minuteStamp(AT - 60_000)}`, 'not verified', '2 of 3 runs to verify', '']]);
    expect(decisions.querySelector('tbody tr a.rowa')!.getAttribute('href')).toBe('#/changes/decisions/dc-01M5000000000000000000000A');
    expect(page!.one('.cmdline.chcmd').textContent).toContain('shadowlap test goldens/* --repeat 3');
    expect(page!.one('#unshown').textContent).toBe('false');
  });

  it('keeps the lime for the newest revision, and says when no preview was asked at it', async () => {
    await openRevision(() => Promise.resolve(revision({ latest: false, decisions: [] })));
    await page!.until('the page', () => page!.all('.verdict').length === 1);
    expect(page!.one('.verdict .actions a').className).toBe('btn sm');
    expect(page!.one('p.emptyline').textContent).toBe('No preview asked at this revision.');
    await page!.unmount();
    await openRevision(() => Promise.resolve(revision({ row: session({ revision: null, subject: null, key: 'no-revision', title: 'Tested with no revision' }) })));
    await page!.until('the page', () => page!.all('.verdict').length === 1);
    expect(shown(page!.one('.verdict p'))).toBe(`no revision · Tested with no revision · ${minuteStamp(AT)}`);
  });

  it('says a change no session checked, with the way back, naming only the tab meanwhile', async () => {
    await openRevision(() => Promise.reject(new ApiError(404, 'no change d2e8a1f checked: no test session ran every golden at it')));
    await page!.until('the answer', () => page!.all('.empty.tall').length === 1);
    expect(shown(page!.one('.empty.tall'))).toBe('No change d2e8a1f. Open Verdicts');
    expect(page!.all('.empty.tall code')).toHaveLength(0);
    expect(page!.one('.empty.tall a').getAttribute('href')).toBe('#/changes');
    expect(page!.one('#unshown').textContent).toBe('true');
  });
});

describe('Changes’ page', () => {
  it('opens Verdicts under its head, in a script of its own', async () => {
    freshProject();
    addressBar('#/changes');
    page = await render(createElement(AppContext.Provider, { value: app({ verdicts: () => Promise.resolve(view([session()])) }) }, createElement(ChangesPage, { tab: 'verdicts', id: null })));
    expect(page.one('.ph h1').textContent).toBe('Changes');
    await page.until('the rows', () => page!.all('table.vdt tbody tr').length === 1);
  });

  it('opens a migration’s address on Verdicts, until its tab lands', async () => {
    const bar = addressBar('#/changes/migrate/mg-01M5000000000000000000000B');
    page = await render(createElement(AppContext.Provider, { value: app({ verdicts: () => Promise.resolve(view([preview()])) }) }, createElement(ChangesPage, { tab: 'migrate', id: 'mg-01M5000000000000000000000B' })));
    await page.until('the migration’s address', () => bar.hash === '#/changes');
    expect(page.one('.ph h1').textContent).toBe('Changes');
  });

  it('opens a preview’s address on Preview, its tab current under the head and the address kept', async () => {
    freshProject();
    const bar = addressBar('#/changes/decisions/dc-01M5000000000000000000000A');
    // Not in this store, nor in another project's: the page asks once, then says so under the head.
    const asked: string[] = [];
    const holding = (what: string, ids: readonly string[]) => (asked.push(`${what} ${ids.join(' ')}`), Promise.resolve({ current: { id: 'support-agent', name: 'support-agent' }, held: null }));
    const client = { decisionSessions: () => Promise.resolve({ sessions: [], goldens: 0, retirements: { version: '', notices: [] } }), decisionSession: () => Promise.reject(new ApiError(404, 'no session')), projects: { holding } };
    page = await render(createElement(AppContext.Provider, { value: app(client as unknown as Partial<Client>) }, createElement(ChangesPage, { tab: 'decisions', id: 'dc-01M5000000000000000000000A' })));
    await page.until('the Preview tab', () => page!.all('.empty.tall').length === 1);
    expect(page.all('nav.stabs a').filter((a) => a.getAttribute('aria-current') === 'page').map((a) => a.textContent)).toEqual(['Preview']);
    expect(bar.hash).toBe('#/changes/decisions/dc-01M5000000000000000000000A');
    expect(shown(page.one('.empty.tall'))).toBe('No preview dc-01M5000000000000000000000A. Open Preview');
    await page.wait(20);
    expect(asked).toEqual(['preview dc-01M5000000000000000000000A']);
  });
});

describe('Compare under Changes', () => {
  const listed = (runId: string): RunListItem => ({ runId, parentRunId: null, mode: 'record', status: 'completed', divergence: null, command: 'node refund_agent.mjs', codeVersion: null, startedAt: 1, calls: 3, spent: 0, saved: 0, captured: 0, imported: false, covers: null, source: null, labels: [] }) as unknown as RunListItem;
  const detail = (runId: string) => ({ run: { runId, parentRunId: null, mode: 'record', status: 'completed', divergence: null, command: { argv: ['node', 'refund_agent.mjs'], cwd: '.' }, codeVersion: null, startedAt: 1, endedAt: 2 }, parent: null, children: [], source: null, calls: [], summary: {} }) as unknown as RunDetail;

  it('stands under Changes’ head in every state, on its own tab', async () => {
    freshProject();
    addressBar('#/compare');
    page = await render(createElement(AppContext.Provider, { value: app({}, { runs: [] }) }, createElement(ComparePage, { a: null, b: null })));
    expect(page.one('.ph h1').textContent).toBe('Changes');
    expect(page.one('nav.stabs a[aria-current="page"]').textContent).toBe('Compare');
    expect(page.one('.stepempty h2').textContent).toBe('Compare needs two runs');
    expect(changesHref()).toBe('#/compare');
  });

  it('notes the pair it shows for its tab, its pickers on a row of their own, and forgets one whose run is gone', async () => {
    freshProject();
    addressBar(`#/compare/${REC}/${FORK}`);
    const client = { run: (id: string) => Promise.resolve(detail(id)), compare: () => new Promise(() => undefined) };
    page = await render(createElement(AppContext.Provider, { value: app(client as Partial<Client>, { runs: [listed(REC), listed(FORK)] }) }, createElement(ComparePage, { a: REC, b: FORK })));
    await page.until('the pair noted', () => changesHref() === `#/compare/${REC}/${FORK}`);
    expect(page.all('.pickers')).toHaveLength(1);
    expect(page.one('.pickers').className).toBe('pickers chpick');
    expect(page.one('.ph h1').textContent).toBe('Changes');
    await page.unmount();
    addressBar(`#/compare/${REC}/${FORK}`);
    // The page first asks whether another project's store holds the run that's gone (GET /api/projects/holding): none does.
    const holding = () => Promise.resolve({ current: { id: 'support-agent', name: 'support-agent' }, held: null });
    const gone = { run: (id: string) => (id === FORK ? Promise.reject(new ApiError(404, 'no run')) : Promise.resolve(detail(id))), compare: () => new Promise(() => undefined), projects: { holding } };
    page = await render(createElement(AppContext.Provider, { value: app(gone as unknown as Partial<Client>, { runs: [listed(REC), listed(FORK)] }) }, createElement(ComparePage, { a: REC, b: FORK })));
    await page.until('the pair forgotten', () => changesHref() === '#/compare');
    await page.until('the not-found', () => page!.all('.stepempty h2').length === 1);
    expect(page.one('.stepempty h2').textContent).toBe('Not in this store');
  });

  it('keeps a head of its own in an exported copy, with no tabs, and notes nothing', async () => {
    freshProject();
    addressBar(`#/compare/${REC}/${FORK}`);
    const client = { run: (id: string) => Promise.resolve(detail(id)), compare: () => new Promise(() => undefined) };
    page = await render(createElement(AppContext.Provider, { value: app(client as Partial<Client>, { exported: true, meta: null, runs: [listed(REC), listed(FORK)] }) }, createElement(ComparePage, { a: REC, b: FORK })));
    await page.until('the pickers', () => page!.all('.pickers').length === 1);
    expect([page.one('.ph .eyebrow').textContent, page.one('.ph h1').textContent, page.one('.ph p').textContent]).toEqual(['exported copy', 'Compare', 'Two runs of this copy, call by call.']);
    expect(page.all('nav.stabs')).toHaveLength(0);
    await page.wait(10);
    expect(changesHref()).toBe('#/changes');
  });
});
