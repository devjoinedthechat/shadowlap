import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { markFixApplied, recordBlame, recordRepair, recordVerdict, Store } from '@shadowlap/engine';
import { blameReport, EXPECT, makeRun, repairReport, verifyReport } from '../../engine/test/fix-fixtures.js';
import { fixDetail } from '../src/fixes.js';
import { fixesView } from '../src/fixes-view.js';
import { JOB_KINDS, type Client } from '../ui/api.js';
import { CHIP_EMPTY, ciCard, failingCard, fixFacts, leadCard, leadReadsFix, leadWait, rowCells, rungStatus } from '../ui/fixes/list.js';
import { unblamedBlameCard, unblamedTitle } from '../src/unblamed-words.js';
import { fixRowScope, unblamedScope } from '../ui/fixes/row-scope.js';
import { forgetRunEstimates } from '../ui/run/estimates.js';
import { FixesPage } from '../ui/pages/Fixes.js';
import { resetSpending } from '../ui/spending.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { FixesView, FixLead, FixRow } from '../ui/types.js';
import { render, type FakeElement, type Rendered } from './ui-render.js';
import type { Estimate } from '../../engine/src/estimates/estimate.js';

/**
 * Fixes as a to-do list (#/fixes): the words ui/fixes/list.ts gives a row, then the page as it renders
 * from the read model's own answer for a store built here, its chips, its states, its steps while a
 * job runs, and a row's next step pressed.
 */

const text = (el: FakeElement) => el.textContent.replace(/\s+/g, ' ').trim();
const tipOf = (el: FakeElement | undefined) => JSON.parse(String(el?.props['data-tip'])) as { t: string; s?: string; cmd?: string; est?: unknown };

// ---------------------------------------------------------------------------------------------- the words

describe('a row’s words', () => {
  const pr = (number: number | null, state: 'open' | 'closed' | 'merged' | null) => ({ url: 'https://github.com/acme/agent/pull/138', number, state });

  it('says where a fix stands on the ladder, as a dot and a word', () => {
    expect(rungStatus({ status: 'open', rung: 'open', pr: null, broken: null })).toEqual({ tone: 'mu', text: 'open' });
    expect(rungStatus({ status: 'open', rung: 'blamed', pr: null, broken: null })).toEqual({ tone: 'mu', text: 'blamed' });
    expect(rungStatus({ status: 'verified', rung: 'verified', pr: null, broken: null })).toEqual({ tone: 'ok', text: 'verified' });
    expect(rungStatus({ status: 'applied', rung: 'applied', pr: null, broken: null })).toEqual({ tone: 'ok', text: 'applied' });
    expect(rungStatus({ status: 'verified', rung: 'merged', pr: pr(138, 'merged'), broken: null })).toEqual({ tone: 'ok', text: 'merged · PR #138' });
    expect(rungStatus({ status: 'applied', rung: 'applied', pr: null, broken: 'shadowlap test failed on its goldens' })).toEqual({ tone: 'err', text: 'broken' });
  });

  it('says on the from CI chip what CI did and where its pull request stands, and on the failing link which runs it opens', () => {
    expect(ciCard({ pr: null })).toBe('A blame in CI opened it.');
    expect(ciCard({ pr: pr(138, 'merged') })).toBe('Fix on failure blamed, repaired and verified it in CI, then opened pull request #138 with its evidence; it was merged.');
    expect(ciCard({ pr: pr(138, 'open') })).toBe('Fix on failure blamed, repaired and verified it in CI, then opened pull request #138 with its evidence; it is open.');
    expect(ciCard({ pr: pr(null, null) })).toBe('Fix on failure blamed, repaired and verified it in CI, then opened a pull request with its evidence.');
    expect(failingCard({ failing: 1, failingIds: ['run-aaaaaa'] })).toEqual({ title: '1 run failed its check', text: 'run-aaaaaa. Opens it on Runs, under Failed' });
    expect(failingCard({ failing: 7, failingIds: ['a', 'b', 'c', 'd', 'e'] })).toEqual({ title: '7 runs failed its check', text: 'a, b, c, d, e and 2 more. Opens them on Runs, under Failed' });
  });

  it('says a step as a job of the fix’s own runs it, and no other job changes it', () => {
    const steps: FixRow['steps'] = [
      { key: 'blame', n: '01', state: 'done', short: 'lost at #5', title: '', meta: '' },
      { key: 'repair', n: '02', state: 'todo', short: 'no change yet', title: '', meta: '' },
      { key: 'verify', n: '03', state: 'todo', short: 'not verified', title: '', meta: '' },
    ];
    const f = { fixId: 'fx-a', steps };
    const cells = (jobs: Array<{ kind: string; fixId?: string; done: boolean }>) => rowCells(f, jobs).map((c) => `${c.state} ${c.short}`);
    expect(cells([])).toEqual(['done lost at #5', 'todo no change yet', 'todo not verified']);
    expect(cells([{ kind: JOB_KINDS.blame, fixId: 'fx-a', done: false }])).toEqual(['busy blaming…', 'todo no change yet', 'todo not verified']);
    expect(cells([{ kind: JOB_KINDS.repair, fixId: 'fx-a', done: false }])[1]).toBe('busy repairing…');
    expect(cells([{ kind: JOB_KINDS.verify, fixId: 'fx-a', done: false }])[2]).toBe('busy verifying…');
    // Another fix's, one that ended, one with no fix, an apply: none is this row's step.
    expect(cells([{ kind: JOB_KINDS.repair, fixId: 'fx-b', done: false }, { kind: JOB_KINDS.verify, fixId: 'fx-a', done: true }, { kind: JOB_KINDS.blame, done: false }, { kind: JOB_KINDS.applyFix, fixId: 'fx-a', done: false }])).toEqual(cells([]));
  });

  it('gives the header no figure while there is no fix, else what is verified, open and failing, and what the attempts took', () => {
    const counts = { all: 0, open: 0, ready: 0, applied: 0, verified: 0 };
    expect(fixFacts({ counts, totals: { failing: 3, attempts: 0, spent: 0 } })).toEqual([]);
    const facts = fixFacts({ counts: { all: 3, open: 2, ready: 1, applied: 0, verified: 1 }, totals: { failing: 1, attempts: 12, spent: 0.42 } });
    expect(facts.map((f) => [f.value, f.words])).toEqual([
      ['1', 'fix verified'],
      ['2', 'open'],
      ['1', 'failing run'],
      ['12', 'attempts behind them'],
      ['$0.42', 'spent live'],
    ]);
    expect(facts[4]).toMatchObject({ money: true, tip: { title: 'What the attempts cost' } });
  });

  it('cards each lead as the fix’s page does, reads the fix only for a dialog that shows it, and says why one waits', () => {
    const again: FixLead = { key: 'blame-again', label: 'Run blame again', command: 'shadowlap blame r --again', use: 'reads', stopped: true, gate: null, soFar: 4, lastGood: null };
    const repair: FixLead = { key: 'repair', label: 'Run repair', command: 'shadowlap repair --fixes label:x', use: 'writes', repairer: null };
    const more: FixLead = { key: 'more', label: 'Run more attempts', command: 'shadowlap verify --fixes r', use: 'reads', verifyId: 'v1', max: 80, attempts: 20 };
    const apply: FixLead = { key: 'apply', label: 'Finish applying', command: 'shadowlap fix apply fx-a', use: 'writes', pending: 'the goldens weren’t re-recorded' };
    expect(leadCard(again)).toBe('Runs the search to the end, without the budget that stopped it');
    expect(leadCard({ ...again, stopped: false, gate: { good: 0.25, max: 60 } as never })).toBe('More attempts and a lower bar: a rescue at 25% or more, up to 60 attempts');
    expect(leadCard(repair)).toBe('Asks your own Claude Code for rewrites; each is tried in a worktree of its own');
    expect(leadCard({ ...repair, repairer: 'openai:gpt-5' })).toBe('Asks openai:gpt-5 for rewrites; each is tried in a worktree of its own');
    expect(leadCard(more)).toBe('Verifies the change again from the start, up to 80 attempts a run');
    expect(leadCard(apply)).toBe('The goldens weren’t re-recorded');
    expect(leadCard({ ...apply, label: 'Apply fix', pending: null })).toBe('Asks first: it changes your working tree');
    expect([again, { key: 'blame-stronger' } as const, repair, apply, more, { key: 'again' } as const].map(leadReadsFix)).toEqual([false, true, true, true, false, false]);
    const repairing = { id: 'j', done: false, worktree: { use: 'writes' as const, doing: 'a repair is running', folder: null } };
    expect(leadWait(repair, { jobs: [repairing], folder: null, hasKind: () => true })).toBe('A repair is running: repair once it is done.');
    expect(leadWait(more, { jobs: [repairing], folder: null, hasKind: () => true })).toBe('A repair is running: run more attempts once it is done.');
    expect(leadWait(more, { jobs: [], folder: null, hasKind: () => true })).toBeNull();
    expect(leadWait(more, { jobs: [], folder: null, hasKind: (k) => k !== JOB_KINDS.verify })).toBe('This dashboard doesn’t run it: run the command in a terminal.');
  });

  it('offers on ⌘K a fix’s row its page and its three steps, and the unblamed row its runs and Run blame', () => {
    const steps = [
      { key: 'blame' as const, short: 'lost at #5' },
      { key: 'repair' as const, short: 'by hand' },
      { key: 'verify' as const, short: 'held' },
    ];
    const fix = fixRowScope({ fixId: 'fx-a', label: 'refund-bug', title: 'issue_refund called with amount 240', steps });
    expect(fix.name).toBe('refund-bug');
    expect(fix.items().map((i) => [i.label, i.hint])).toEqual([
      ['Open fix', 'issue_refund called with amount 240'],
      ['Blame', 'lost at #5'],
      ['Repair', 'by hand'],
      ['Verify', 'held'],
    ]);
    const pressed: string[] = [];
    const un = unblamedScope({ name: unblamedTitle(2), command: 'shadowlap blame r1', wait: 'A repair is running: blame once it is done.', press: () => pressed.push('blame') });
    expect(un.name).toBe('2 failing runs nobody has blamed');
    expect(un.items()).toEqual([expect.objectContaining({ label: 'Open', hint: '#/runs?types=failed' }), expect.objectContaining({ label: 'Run blame', hint: 'shadowlap blame r1', job: true, wait: 'A repair is running: blame once it is done.' })]);
    un.items()[1]?.run();
    expect(pressed).toEqual(['blame']);
    // No Run blame where the row has none.
    expect(unblamedScope({ name: 'x', command: null, wait: null, press: () => undefined }).items().map((i) => i.label)).toEqual(['Open']);
    expect(unblamedBlameCard(1, 'run-012345')).toBe('Blames run-012345: finds the model call that lost it, then joins the fix its failure belongs to');
    expect(unblamedBlameCard(3, 'run-012345')).toBe('Blames the newest, run-012345: finds the model call that lost it, then joins the fix its failure belongs to');
  });
});

// ---------------------------------------------------------------------------------------------- the page

let store: Store;
let r: Rendered | null = null;
let tick = 0;
const DAY = 24 * 60 * 60 * 1000;
let at = 10 * DAY;

beforeEach(() => {
  store = Store.open(':memory:');
  resetSpending();
  forgetRunEstimates();
});
afterEach(async () => {
  await r?.unmount();
  r = null;
  store.close();
});

/** A run in the store, as the engine's fixtures make one (their Store is the engine's source, this test's the built one). */
const newRun = (o: Parameters<typeof makeRun>[1] = {}): string => makeRun(store as unknown as Parameters<typeof makeRun>[0], o);

/** A failing run blamed under its own check, opening a fix of its own. */
function opened(tool: string) {
  const run = newRun({ labels: [tool] });
  const expect = { tools: { [tool]: 1 } };
  const { fix } = recordBlame(store, { runId: run, report: blameReport(run), expect, scope: null, command: 'shadowlap blame', title: `${tool} called twice`, checkText: `${tool} called once`, at: (at += DAY) });
  return { run, expect, fixId: fix.fixId, href: `#/fixes/${fix.fixId}` };
}

/** A change made by hand, verified on the fix's failing run. */
function byHand(tool: string) {
  const f = opened(tool);
  recordVerdict(store, { report: verifyReport([{ runId: f.run, role: 'target', pass: true }]), expect: f.expect, command: 'shadowlap verify', at: (at += DAY) });
  return f;
}

/** A fix CI repaired and verified, its pull request merged. */
function merged() {
  const run = newRun({ labels: ['refund-bug'] });
  const good = newRun({ labels: ['good'], status: 'completed' });
  const { fix } = recordBlame(store, { runId: run, report: blameReport(run), expect: EXPECT, scope: null, command: 'shadowlap blame', title: 'issue_refund called with amount 240', checkText: 'issue_refund never called with {"amount":240}', at: (at += DAY) });
  recordRepair(store, { repairId: 'repair-munzln2i', dir: '.shadowlap/repairs/repair-munzln2i', report: repairReport({ targets: [run], good: [good] }), expect: EXPECT, command: 'shadowlap repair', at: (at += DAY) });
  store.mergeFixData(fix.fixId, { source: { ci: 'github', pr: { url: 'https://github.com/acme/agent/pull/138', number: 138, state: 'merged' } } });
  return { fixId: fix.fixId, href: `#/fixes/${fix.fixId}` };
}

/** What the page asked of its stand-in server. */
interface Asked {
  fixes: number;
  jobs: number;
  fix: string[];
  priced: string[];
  started: Array<[string, Record<string, unknown>]>;
}

/**
 * The app as the shell gives it, its server answering from the store: `leads` stands in for a fix's
 * next step where a test needs one the store can't give, `jobs` for what the server is running, `blame`
 * for what a run's Run blame would cost (left out, a run's estimates never answer).
 */
function app(o: { fixes?: () => Promise<FixesView>; jobs?: unknown[]; leads?: Record<string, FixLead | null>; blame?: Estimate } = {}): { state: AppState; asked: Asked } {
  const asked: Asked = { fixes: 0, jobs: 0, fix: [], priced: [], started: [] };
  const view = (): FixesView => {
    const v = fixesView(store);
    return { ...v, fixes: v.fixes.map((f) => (o.leads && f.fixId in o.leads ? { ...f, next: o.leads[f.fixId]! } : f)) };
  };
  const client = {
    fixes: () => (asked.fixes++, o.fixes ? o.fixes() : Promise.resolve(view())),
    fix: (id: string) => (asked.fix.push(id), Promise.resolve(fixDetail(store, id))),
    jobs: () => (asked.jobs++, Promise.resolve(o.jobs ?? [])),
    // A fix's estimates price nothing; a run's (Run blame's) are `blame`, else never answer.
    estimates: { fixEstimates: (id: string) => (asked.priced.push(id), Promise.resolve({ repair: null, blameAgain: null, blameStronger: null, verify: {} })), runEstimates: () => (o.blame ? Promise.resolve({ blame: o.blame, actions: {} }) : new Promise(() => undefined)) },
    startJob: (kind: string, fields: Record<string, unknown>) => (asked.started.push([kind, fields]), new Promise(() => undefined)),
  } as unknown as Client;
  // A tick of its own: what a row priced under another test's answer is never this one's.
  const state = { client, exported: false, meta: null, tick: ++tick, feeds: {}, jobs: [], actionsOff: null, hasKind: () => true, guard: (fn: () => void) => fn(), watchJob: () => undefined, toast: () => undefined } as unknown as AppState;
  return { state, asked };
}

/** The list, once it has loaded, on All: the chip is kept for the tab, so a test before may have left another. */
async function list(a = app()): Promise<Rendered> {
  r = await render(createElement(AppContext.Provider, { value: a.state }, createElement(FixesPage, { id: null, step: null, sub: null })));
  await r.until('the list to load', () => r!.all('.skel').length === 0 && r!.all('.loaderr').length === 0);
  await chip('All');
  return r;
}

async function chip(label: string): Promise<void> {
  const b = r!.all('.chips button').find((x) => text(x).startsWith(`${label} `));
  if (b && String(b.props['aria-pressed']) !== 'true') await r!.click(b);
}

const keys = () => r!.all('.pslist .psrow').map((x) => x.getAttribute('data-rowkey'));
const row = (key: string) => r!.one(`.pslist .psrow[data-rowkey="${key}"]`);
const cellsOf = (key: string) => r!.all(`.pslist .psrow[data-rowkey="${key}"] .psk`).map((x) => `${String(x.props.className).split(' ')[1]} ${text(x)}`);

describe('the Fixes list', () => {
  it('leads with the failing runs nobody has blamed under All and Open, then open fixes, ready ones, applied ones, with each chip’s count', async () => {
    const open = opened('send_email');
    const ready = byHand('escalate');
    const applied = byHand('lookup');
    markFixApplied(store, applied.fixId, { patch: 'none', repairId: null, goldens: [], tests: 'failed', via: 'fix apply' });
    const ci = merged();
    newRun({ calls: ['api', 'tool', 'api'], startedAt: 1_000 });
    const newest = newRun({ calls: ['api', 'tool', 'api'], startedAt: 2_000 });
    await list();
    expect(text(r!.one('.ph .eyebrow'))).toBe('this project · failures');
    expect(r!.all('.chips button').map(text)).toEqual(['All 4', 'Open 1', 'Ready to apply 1', 'Applied 2']);
    // A figure and its words, spaced by the style.
    expect(r!.all('.pfacts .metric').map((m) => `${text(m.querySelector('b')!)} ${text(m).slice(text(m.querySelector('b')!).length)}`).slice(0, 3)).toEqual(['3 fixes verified', '1 open', '4 failing runs']);
    // The applied fixes newest first: one marked applied just now, then the one merged days ago.
    expect(keys()).toEqual(['unblamed', open.href, ready.href, applied.href, ci.href]);
    const un = row('unblamed');
    expect(text(un.querySelector('a.rt')!)).toBe('2 failing runs nobody has blamed');
    expect(un.querySelector('a.rt')!.getAttribute('href')).toBe('#/runs?types=failed');
    expect(un.querySelector('.rs')!.children.map(text)).toEqual(['failed', `newest ${newest.slice(0, 10)}`]);
    expect(text(un.querySelector('.fm')!)).toBe('Failed: The agent exited with an error');
    expect(cellsOf('unblamed')).toEqual(['todo Blame not blamed', 'todo Repair —', 'todo Verify —']);
    const blame = un.querySelector('.psn button')!;
    expect(text(blame)).toBe('Run blame');
    expect(tipOf(blame)).toMatchObject({ t: 'Run blame', s: `Blames the newest, ${newest.slice(0, 10)}: finds the model call that lost it, then joins the fix its failure belongs to` });
    await chip('Open');
    expect(keys()).toEqual(['unblamed', open.href]);
    await chip('Ready to apply');
    expect(keys()).toEqual([ready.href]);
    await chip('Applied');
    expect(keys()).toEqual([applied.href, ci.href]);
    await chip('All');
  });

  it('says on the unblamed row’s Run blame card what it would cost, from the run’s own estimate', async () => {
    const run = newRun({ calls: ['api', 'tool', 'api'] });
    await list(app({ blame: { kind: 'blame', usd: 0.42, ceiling: true, parts: [] } }));
    const blame = () => row('unblamed').querySelector('.psn button')!;
    await r!.until('the estimate', () => !!tipOf(blame()).est);
    const u = fixesView(store).unblamed!;
    expect(tipOf(blame())).toEqual({ t: 'Run blame', s: `Blames ${run.slice(0, 10)}: finds the model call that lost it, then joins the fix its failure belongs to`, rows: [], cmd: `$ ${u.next!.command!}`, est: { usd: 0.42, ceiling: true } });
  });

  it('says on each row its rung, its chips, its failing runs and its day, its three steps, and Open → where it has no step', async () => {
    const ready = byHand('escalate');
    const applied = byHand('lookup');
    markFixApplied(store, applied.fixId, { patch: 'none', repairId: null, goldens: [], tests: 'failed', via: 'fix apply' });
    const ci = merged();
    await list();
    const status = (key: string) => text(row(key).querySelector('.rs .st')!);
    expect(status(ready.href)).toBe('verified');
    expect(status(ci.href)).toBe('merged · PR #138');
    expect(row(ci.href).querySelector('.rs .st')!.props.className).toBe('st ok');
    expect(status(applied.href)).toBe('broken');
    expect(row(applied.href).querySelector('.rs .st')!.props.className).toBe('st err');
    expect(text(row(applied.href).querySelector('.fxbad')!)).toBe('doesn’t hold: shadowlap test failed on its goldens');
    // CI's chip says what CI did; a fix's own label is a chip of its own.
    const fromCi = row(ci.href).querySelectorAll('.rs .chip');
    expect(fromCi.map(text)).toEqual(['refund-bug', 'from CI']);
    expect(tipOf(fromCi[1])).toMatchObject({ t: 'From CI', s: 'Fix on failure blamed, repaired and verified it in CI, then opened pull request #138 with its evidence; it was merged.' });
    const failing = row(ready.href).querySelector('.rs a.dlink')!;
    expect(text(failing)).toBe('1 failing run');
    expect(failing.getAttribute('href')).toBe('#/runs?types=failed');
    expect(tipOf(failing)).toMatchObject({ t: '1 run failed its check', s: `${ready.run.slice(0, 10)}. Opens it on Runs, under Failed` });
    // The day it opened, in the second line: no column of its own.
    expect(row(ready.href).querySelector('.rs')!.children.map(text)).toEqual(['verified', 'escalate', '1 failing run', expect.stringMatching(/^opened \w/)]);
    expect(r!.all(`.pslist .psrow[data-rowkey="${ready.href}"] .fm .fmu`).map(text)).toEqual(['Must: escalate called once']);
    // Repair says by hand where verify ran on a change nobody's repair made.
    expect(cellsOf(ready.href)[1]).toBe('done Repair by hand');
    expect(cellsOf(applied.href)[1]).toBe('done Repair by hand');
    // Merged and applied with nothing left to do: no step, the row opens the fix.
    expect(text(row(ci.href).querySelector('.psn')!)).toBe('Open →');
    expect(row(ci.href).querySelectorAll('.psn button')).toEqual([]);
  });

  it('says so after the chips when a chip keeps no row, with no list', async () => {
    opened('send_email');
    await list();
    await chip('Applied');
    expect(r!.all('.pslist')).toEqual([]);
    expect(text(r!.one('.emptyline'))).toBe(CHIP_EMPTY.applied);
    await chip('Ready to apply');
    expect(text(r!.one('.emptyline'))).toBe('No verified fix waits to be applied.');
    await chip('All');
    expect(r!.all('.emptyline')).toEqual([]);
  });

  it('shows the failing runs nobody has blamed alone, with no chip, while there is no fix; and the empty page with blame’s command when there is neither', async () => {
    newRun({ calls: ['api', 'tool', 'api'] });
    await list();
    expect(r!.all('.chips')).toEqual([]);
    expect(r!.all('.pfacts')).toEqual([]);
    expect(keys()).toEqual(['unblamed']);
    await r!.unmount();
    store.close();
    store = Store.open(':memory:');
    await list();
    expect(r!.all('.pslist')).toEqual([]);
    expect(text(r!.document.body)).toContain('No fixes yet');
    expect(text(r!.document.body)).toContain(`shadowlap blame <run> --expect '{"tools":{"send_email":1}}'`);
  });

  it('draws the rows as bars while it loads, and says why it couldn’t load with Retry', async () => {
    opened('send_email');
    r = await render(createElement(AppContext.Provider, { value: app({ fixes: () => new Promise(() => undefined) }).state }, createElement(FixesPage, { id: null, step: null, sub: null })));
    expect(r.all('.skel .pslist .psrow')).toHaveLength(4);
    expect(text(r.one('.skel .sr'))).toBe('Loading the fixes…');
    await r.unmount();
    let fail = true;
    const a = app({ fixes: () => (fail ? Promise.reject(new Error('the dashboard server stopped')) : Promise.resolve(fixesView(store))) });
    r = await render(createElement(AppContext.Provider, { value: a.state }, createElement(FixesPage, { id: null, step: null, sub: null })));
    await r.until('the failure', () => r!.all('.loaderr').length === 1);
    expect(text(r.one('.loaderr'))).toContain('The dashboard server stopped');
    fail = false;
    await r.click(r.byText('.loaderr button', 'Retry'));
    await r.until('the list', () => r!.all('.pslist .psrow').length === 1);
  });

  it('reads the jobs once for the whole list: a fix’s running job says its step, and the rows its tree holds wait and say why', async () => {
    const a = opened('send_email');
    const b = opened('escalate');
    const c = opened('lookup');
    newRun({ calls: ['api', 'tool', 'api'] });
    const running = { id: 'j1', kind: JOB_KINDS.repair, title: 'Repairing', fixId: a.fixId, done: false, startedAt: 1, endedAt: null, worktree: { use: 'writes', doing: 'a repair is running', folder: null } };
    const repair = (fixId: string): FixLead => ({ key: 'repair', label: 'Run repair', command: `shadowlap repair --fixes ${fixId}`, use: 'writes', repairer: null });
    const more: FixLead = { key: 'more', label: 'Run more attempts', command: 'shadowlap verify --fixes r', use: 'reads', verifyId: 'v1', max: 80, attempts: 20 };
    const stand = app({ jobs: [running], leads: { [a.fixId]: repair(a.fixId), [b.fixId]: repair(b.fixId), [c.fixId]: more } });
    await list(stand);
    await r!.until('the jobs', () => cellsOf(a.href)[1] === 'busy Repair repairing…');
    expect(stand.asked.jobs).toBe(1);
    expect(cellsOf(b.href)[1]).toBe('todo Repair no change yet');
    expect(row(b.href).querySelector('.psn button')!.getAttribute('data-why')).toBe('A repair is running: repair once it is done.');
    expect(row(c.href).querySelector('.psn button')!.getAttribute('data-why')).toBe('A repair is running: run more attempts once it is done.');
    expect(row('unblamed').querySelector('.psn button')!.getAttribute('aria-disabled')).toBe('true');
  });

  it('presses a row’s next step as the fix’s page does: the fix read only for a dialog that shows it', async () => {
    const a = opened('send_email');
    const b = opened('escalate');
    const c = opened('lookup');
    const again: FixLead = { key: 'blame-again', label: 'Run blame again', command: `shadowlap blame ${a.run} --again`, use: 'reads', stopped: true, gate: null, soFar: 4, lastGood: null };
    const repair: FixLead = { key: 'repair', label: 'Run repair', command: 'shadowlap repair --fixes label:escalate', use: 'writes', repairer: null };
    const more: FixLead = { key: 'more', label: 'Run more attempts', command: 'shadowlap verify --fixes r', use: 'reads', verifyId: 'verify-1', max: 80, attempts: 20 };
    const stand = app({ leads: { [a.fixId]: again, [b.fixId]: repair, [c.fixId]: more } });
    await list(stand);
    const step = (key: string) => row(key).querySelector('.psn button')!;
    expect(text(step(a.href))).toBe('Run blame again');
    expect(tipOf(step(a.href))).toMatchObject({ t: 'Run blame again', s: 'Runs the search to the end, without the budget that stopped it', cmd: `$ shadowlap blame ${a.run} --again` });
    // Run blame again asks from the lead alone: no estimate, so its dialog asks, and the fix isn't read.
    await r!.click(step(a.href));
    await r!.until('blame again’s ask', () => r!.all('.dialog').length === 1);
    expect(text(r!.one('.dialog h3'))).toBe('Run blame again');
    expect(stand.asked.priced).toEqual([a.fixId]);
    expect(stand.asked.fix).toEqual([]);
    await r!.click(r!.one('.dialog .dlg-ok'));
    expect(stand.asked.started).toEqual([[JOB_KINDS.blame, expect.objectContaining({ fixId: a.fixId, again: true })]]);
    // Run repair's dialog shows the fix: read as it is pressed.
    await r!.click(step(b.href));
    await r!.until('repair’s dialog', () => r!.all('.dialog').length === 1);
    expect(stand.asked.fix[0]).toBe(b.fixId);
    await r!.click(r!.one('.dialog .dlg-cancel'));
    // Run more attempts asks from the lead, and starts the verdict it settles.
    const before = stand.asked.fix.length;
    await r!.click(step(c.href));
    await r!.until('more attempts’ ask', () => r!.all('.dialog').length === 1);
    expect(stand.asked.fix).toHaveLength(before);
    await r!.click(r!.one('.dialog .dlg-ok'));
    expect(stand.asked.started.at(-1)).toEqual([JOB_KINDS.verify, expect.objectContaining({ fixId: c.fixId, verifyId: 'verify-1' })]);
  });
});
