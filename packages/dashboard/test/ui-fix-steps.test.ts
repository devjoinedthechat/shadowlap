import { act, createElement, useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { afterForkLines, markFixApplied, plain, recordBlame, recordRepair, recordVerdict, Store, type BlameReport } from '@shadowlap/engine';
import { blameReport, EXPECT, makeRun, repairReport, verifyReport } from '../../engine/test/fix-fixtures.js';
import { fixDetail, withAbouts } from '../src/fixes.js';
import { ApiError, JOB_KINDS, type Client } from '../ui/api.js';
import { JobDrawer } from '../ui/components/Drawer.js';
import { jobFooter } from '../ui/job-actions.js';
import type { WatchedJob } from '../ui/job-store.js';
import { OPEN_GOLDENS } from '../ui/fixes/job-footers.js';
import { OPEN_BLAME, refusedPress } from '../ui/fixes/page-fix.js';
import { FixPage } from '../ui/fixes/FixPage.js';
import { minuteStamp } from '../ui/format.js';
import { GLOSSARY } from '../ui/glossary.js';
import { useRoute } from '../ui/router.js';
import { AppContext, type AppState } from '../ui/state.js';
import { errorText, type ToastAction } from '../ui/toast.js';
import type { JobView } from '../ui/types.js';
import { render, type FakeElement, type Rendered } from './ui-render.js';

/**
 * A fix's steps as they render, from the read model's own answer for a store built here: each opens
 * on its verdict line and the finding under it, then its parts as sections, its rows' attempts in
 * one Attempts cell each, and its receipts in grey lines over its command.
 */

let store: Store;
let r: Rendered | null = null;
const DAY = 24 * 60 * 60 * 1000;
let at = 100 * DAY;
const SEND_ONCE = { tools: { send_email: 1 } };
/** A run of seven calls, a model call every other one, so the probes at #1, #5 and #7 are model calls 1, 3 and 4. */
const CALLS = ['api', 'tool', 'api', 'tool', 'api', 'tool', 'api'] as const;

beforeEach(() => {
  store = Store.open(':memory:');
});
afterEach(async () => {
  await r?.unmount();
  r = null;
  store.close();
});

/** The fixtures read the engine's sources, this file the engine as it is built: one store either way. */
const engineStore = () => store as unknown as Parameters<typeof makeRun>[0];

function app(): AppState {
  const client = {
    // As the fix's pooled read answers: with the about lines of the runs its steps name.
    fix: (id: string) => Promise.resolve(withAbouts(store, fixDetail(store, id)!)),
    jobs: () => Promise.resolve([]),
    attemptGroups: () => Promise.resolve({ blame: null, verify: [], cut: false }),
    startJob: () => new Promise(() => undefined),
  } as unknown as Client;
  return { client, exported: false, meta: null, tick: 0, feeds: {}, jobs: [], actionsOff: null, hasKind: () => true, guard: (fn: () => void) => fn(), watchJob: () => undefined, toast: () => undefined } as unknown as AppState;
}

async function open(fixId: string, step: string): Promise<Rendered> {
  r = await render(createElement(AppContext.Provider, { value: app() }, createElement(FixPage, { id: fixId, step, sub: null })));
  await r.until('the fix to load', () => r!.all('h1').length === 1);
  return r;
}

const text = (el: FakeElement) => el.textContent.replace(/\s+/g, ' ').trim();
const tip = (el: FakeElement): string => (JSON.parse(el.getAttribute('data-tip') ?? '{}') as { t?: string }).t ?? '';

/** A run blamed under the fix's check, opening the fix or joining the one its label points to. */
function blamed(o: { report?: (run: string) => BlameReport; label?: string; run?: string } = {}) {
  const run = o.run ?? makeRun(engineStore(), { labels: [o.label ?? 'double-email'], calls: [...CALLS] });
  const report = o.report?.(run) ?? blameReport(run);
  const { fix } = recordBlame(store, { runId: run, report, expect: SEND_ONCE, scope: null, command: `shadowlap blame ${run}`, title: 'send_email called twice', checkText: 'send_email called once', at: (at += DAY) });
  return { run, fixId: fix.fixId, at };
}

describe('the Blame step', () => {
  it('opens on its verdict line: blamed in ink, each probe’s tally a part kept whole, where and how sure under it, its links, then what was found', async () => {
    const { run, fixId } = blamed();
    const d = fixDetail(store, fixId)!;
    await open(fixId, 'blame');
    expect(text(r!.one('.verdict .vw'))).toBe('blamed');
    expect(r!.one('.verdict .vw').className).toBe('vw done');
    // The blamed call's tally, then the next one's: each part whole, the head breaking only between them.
    expect(r!.all('.verdict h2 .nw').map(text)).toEqual(['2 of 4 rescued from #5', '0 of 4 from #7']);
    expect(text(r!.one('.verdict p'))).toBe(`#5 · model call 3 of 4 · in ${run.slice(0, 10)} · confidence high`);
    // Why it is that sure is on the confidence's card, not the line's title.
    expect(JSON.parse(r!.one('.verdict p .dtip').getAttribute('data-tip')!)).toMatchObject({ t: 'confidence high', s: d.blame!.confidenceWhy });
    expect(r!.all('.verdict .actions a').map((a) => [text(a), a.getAttribute('href')])).toEqual([
      ['Open run at #5', `#/run/${run}/5`],
      ['Open rescued fork', d.blame!.hrefs.rescued],
    ]);
    expect(text(r!.one('p.fxsay'))).toBe(d.blame!.line.finding!.replace(/\s+/g, ' '));
    // The step's parts are sections, labelled in sentence case.
    expect(r!.all('section.panel.sec > header h2').map(text)).toEqual(['Where the run was lost', 'At call #5', 'Probes']);
    expect(r!.all('.ans .lbl').map(text)).toEqual(['The recording', 'A rescued fork']);
  });

  it('draws each probe’s tally over its call, says each call on hover, and keys only what the row shows', async () => {
    const { fixId } = blamed();
    await open(fixId, 'blame');
    const cells = r!.all('ol.callrow li');
    expect(cells.map((li) => text(li.querySelector('.pp')!))).toEqual(['2/3', '', '', '', '2/4', '', '0/4']);
    expect(cells.map((li) => li.className)).toEqual(['m ok', 't', 'm', 't', 'm hot', 't', 'm lost']);
    expect(r!.all('ol.callrow .cn').map(tip)).toEqual([
      '#1 · rescued · 2 of 3',
      '#2 · tool call',
      '#3 · not probed: the search skipped it',
      '#4 · tool call',
      '#5 · blamed: the last call that still rescues the run · rescued · 2 of 4',
      '#6 · tool call',
      '#7 · lost · 0 of 4',
    ]);
    // A call keeps its name for a screen reader.
    expect(r!.all('ol.callrow .cn')[0].getAttribute('aria-label')).toBe('Call #1');
    // Rescued and lost are defined terms, each with its definition for a screen reader.
    expect(r!.all('.legend.fxleg > span').map(text)).toEqual([`rescued${GLOSSARY.rescued}`, `lost${GLOSSARY.lost}`, 'blamed: the last call that still rescues the run', 'ring: model call · dot: tool call']);
  });

  it('lists the probes in one Attempts cell each, the verdict a status, the attempts under a row on request', async () => {
    const { fixId } = blamed();
    await open(fixId, 'blame');
    expect(r!.all('table.probes thead th').map(text)).toEqual(['Call', 'Model call', 'Attempts', 'Verdict']);
    const rows = r!.all('table.probes tbody tr');
    expect(rows.map((x) => text(x.querySelector('.acell')!))).toEqual(['2 of 3', '2 of 4', '0 of 4']);
    expect(rows.map((x) => [text(x.querySelector('.pv .st')!), x.querySelector('.pv .st')!.className])).toEqual([
      ['rescued', 'st ok'],
      ['rescued', 'st ok'],
      ['lost', 'st err'],
    ]);
    // The blamed call is marked apart, in ink, after a space a screen reader hears.
    expect(text(rows[1].querySelector('.pv')!)).toBe('rescued blamed');
    expect(rows[1].className).toBe('hot');
    expect(r!.all('.pips')).toEqual([]);
    const toggle = rows[1].querySelector('button.xbtn')!;
    expect(toggle.getAttribute('aria-label')).toBe('Show 4 attempts');
    await r!.click(toggle);
    await r!.until('the attempts', () => r!.all('table.probes tr.sub').length === 1);
    expect(r!.all('table.probes tr.sub .alist .al')).toHaveLength(4);
    expect(r!.one('table.probes tr.sub > td > div').getAttribute('id')).toBe(r!.one('table.probes tr.open button.xbtn').getAttribute('aria-controls'));
  });

  it('ends on one grey line of what it cost, the judge’s checks apart, the fix’s other blames newest first, and its command', async () => {
    // Another failing run of the fix, then the shown run, stopped first and blamed after.
    const other = blamed({ report: (run) => blameReport(run, 'unrescuable') });
    const before = blamed({ report: (run) => blameReport(run, 'stopped') });
    const shown = blamed({ run: before.run, report: (run) => Object.assign(blameReport(run), { judge: { upstreamRequests: 9, spent: 0.0047 } }) });
    await open(shown.fixId, 'blame');
    const receipts = r!.all('.fxreceipt').map(text);
    expect(receipts[0]).toBe('11 attempts · 22 upstream requests · ≈$0.110 spent · judge checks: 9 upstream requests, ≈$0.0047 · every call before a probe replayed from the recording');
    expect(receipts.slice(1)).toEqual([`Blamed before, ${minuteStamp(before.at)}: stopped.`, `Also blamed ${other.run.slice(0, 10)}, ${minuteStamp(other.at)}: not rescued.`]);
    expect(r!.one(`.fxreceipt a[href="#/run/${other.run}"]`)).toBeTruthy();
    expect(text(r!.one('.cmdline'))).toContain(`shadowlap blame ${shown.run}`);
  });

  it('says a stopped search, a first probe that couldn’t tell and a run no call rescued, each in its words and with its link', async () => {
    const stopped = blamed({ report: (run) => blameReport(run, 'stopped') });
    await open(stopped.fixId, 'blame');
    expect([text(r!.one('.verdict .vw')), text(r!.one('.verdict h2'))]).toEqual(['stopped', 'stopped Rescued up to #1 so far']);
    expect(text(r!.one('.verdict p'))).toBe(`in ${stopped.run.slice(0, 10)} · confidence low`);
    expect(r!.all('.verdict .actions a').map(text)).toEqual(['Open run at #1']);
    expect(text(r!.all('section.panel.sec > header .sub')[0])).toBe('stopped before the search finished');
    expect(text(r!.one('.fxnote'))).toBe('Run blame again searches from the first model call: blame keeps no search to resume.');
    await r!.unmount();
    const none = blamed({ report: (run) => blameReport(run, 'unrescuable'), label: 'digest' });
    await open(none.fixId, 'blame');
    expect([text(r!.one('.verdict .vw')), r!.all('.verdict .actions a').map((a) => [text(a), a.getAttribute('href')])]).toEqual(['not rescued', [['Open run', `#/run/${none.run}`]]]);
    expect(text(r!.one('.verdict p'))).toBe(`#1 · model call 1 of 4 · in ${none.run.slice(0, 10)} · confidence high`);
    expect(text(r!.all('section.panel.sec > header .sub')[0])).toBe('no probe rescued the run');
    await r!.unmount();
    const unsure = blamed({ report: (run) => Object.assign(blameReport(run, 'unrescuable'), { probes: blameReport(run, 'unrescuable').probes.map((p) => ({ ...p, decision: 'inconclusive' as const })) }), label: 'triage' });
    await open(unsure.fixId, 'blame');
    expect([text(r!.one('.verdict .vw')), r!.all('.verdict .actions a').map((a) => [text(a), a.getAttribute('href')])]).toEqual(['inconclusive', [['Open run at #1', `#/run/${unsure.run}/1`]]]);
    expect(text(r!.all('section.panel.sec > header .sub')[0])).toBe('inconclusive: the first probe couldn’t tell');
  });
});

/** A run blamed under refund-bug's check and repaired: accepted, or with every candidate it tried rejected, candidate 2's why naming the run. */
function repaired(accepted = true) {
  const run = makeRun(engineStore(), { labels: ['refund-bug'], calls: [...CALLS] });
  const { fix } = recordBlame(store, { runId: run, report: blameReport(run), expect: EXPECT, scope: null, command: 'shadowlap blame', title: 'issue_refund called with amount 240', checkText: 'issue_refund never called with {"amount":240}', at: (at += DAY) });
  const report = repairReport({ targets: [run], accepted });
  report.candidates[1] = { ...report.candidates[1], reason: `target run ${run.slice(0, 10)} not fixed: 0 of 2 passed` };
  recordRepair(store, { repairId: 'repair-munzln2i', dir: '.shadowlap/repairs/repair-munzln2i', report, expect: EXPECT, command: 'shadowlap repair --fixes label:refund-bug', at: (at += DAY) });
  return { run, fixId: fix.fixId };
}

describe('the Repair step', () => {
  it('opens an accepted repair on its verdict line, headed as its verdict is, then its change once, inline, the roles as status words', async () => {
    const { fixId } = repaired();
    const d = fixDetail(store, fixId)!;
    await open(fixId, 'repair');
    expect(r!.one('.verdict .vw').className).toBe('vw ok');
    expect(text(r!.one('.verdict h2'))).toBe(`accepted ${d.repair!.line.head[0]}`);
    expect(r!.all('p.fxsay')).toEqual([]);
    // Once, as the prompt reads now: no "was" line, the added words marked, the colon before them outside the mark.
    expect(r!.all('.pdiff .was')).toEqual([]);
    expect(text(r!.one('.pdiff .now'))).toBe('You are a support agent. Follow the refund policy: escalate every refund above the limit it sets.');
    expect(text(r!.one('.pdiff mark'))).toBe('escalate every refund above the limit it sets');
    expect(r!.all('.vchips .st').map((x) => [x.className, text(x)])).toEqual([['st ok', 'target 1 of 1']]);
    expect(r!.all('section.panel.sec > header h2').map(text)).toEqual(['The change', 'Why', 'Candidates', 'report.md', 'Handed over']);
    expect(r!.all('.lbl').map(text)).toEqual(['Where the failing runs were lost', 'Diagnosis']);
    expect(text(r!.one('.cmdline'))).toContain('shadowlap repair --fixes label:refund-bug');
  });

  it('folds report.md’s What failed and Candidates, each summed up beside its heading, and opens one on request', async () => {
    const { fixId } = repaired();
    await open(fixId, 'repair');
    const heads = () => r!.all('.prbody.md h4.mdh');
    expect(heads().map((h) => text(h.querySelector('.mds')!))).toEqual(['1 run · lost at model call #5', '3 candidates · the smallest the gate accepts twice kept']);
    const caret = (h: FakeElement) => h.querySelector('button.xbtn')!;
    expect(heads().map((h) => [caret(h).getAttribute('aria-label'), caret(h).getAttribute('aria-expanded')])).toEqual([
      ['Show what failed', 'false'],
      ['Show candidates', 'false'],
    ]);
    // Closed, only the evidence's table shows; the cost stays the report's last line.
    expect(r!.all('.prbody .fxtable')).toHaveLength(1);
    expect(text(r!.all('.prbody > p').at(-1)!)).toMatch(/^Cost: blame ≈\$0\.100/);
    await r!.click(caret(heads()[0]));
    const button = caret(heads()[0]);
    expect([button.getAttribute('aria-label'), button.getAttribute('aria-expanded')]).toEqual(['Hide what failed', 'true']);
    expect(r!.all(`[id="${button.getAttribute('aria-controls')!}"] .fxtable th`).map(text)).toEqual(['Run', 'Lost at', 'What the agent did there', 'What a passing run did']);
    expect(r!.all('.prbody .fxtable')).toHaveLength(2);
  });

  it('says a repair that accepted nothing as rejected and why, the gate’s rule once over its candidates, each verdict a status and its why’s run a link with its about line', async () => {
    const { run, fixId } = repaired(false);
    const d = withAbouts(store, fixDetail(store, fixId)!);
    await open(fixId, 'repair');
    expect(r!.one('.verdict .vw').className).toBe('vw err');
    expect(text(r!.one('.verdict h2'))).toBe('rejected The gate accepted none of the 1 candidate tried');
    expect(text(r!.one('p.fxsay'))).toBe('The fix stays open, with each candidate and why it was dropped. Repairing again would try the same: change the prompt yourself and verify it.');
    expect(r!.all('section.panel.sec > header h2').map(text)).toEqual(['Candidates', 'report.md', 'Why']);
    const subs = r!.all('section.panel.sec > header .sub').map(text);
    expect(subs[0]).toBe(`tried smallest first · ${d.repair!.rule!}`);
    expect(subs[1]).toBe('what the repair found');
    expect(r!.all('.cand .st').map((x) => [x.className, text(x)])).toEqual([
      ['st mu', 'set aside'],
      ['st err', 'rejected'],
    ]);
    // An order id never breaks at its hyphen; a run the why names opens, its about line on hover.
    expect(r!.all('.cand .why span.nw').map(text)).toContain('A-1042');
    const link = r!.one('.cand .why a.rlink');
    expect([link.getAttribute('href'), text(link), link.getAttribute('title')]).toEqual([`#/run/${run}`, run.slice(0, 10), d.repair!.named[0].about]);
    expect(d.repair!.named[0].about).toBeTruthy();
    expect(r!.all('.prbody.md h4.mdh .mds').map(text)).toEqual(['1 run · lost at model call #5', '2 candidates · none accepted']);
  });
});

/** Two failing runs of one fix, a change made by hand verified on the first alone; its report as `o` sets it. */
function verified(o: { judge?: boolean; afterFork?: boolean; warnings?: string[] } = {}) {
  const a = blamed();
  const b = blamed();
  const report = verifyReport([{ runId: a.run, role: 'target', pass: true }]);
  if (o.judge) report.judge = { spent: 0.002, upstreamRequests: 3 };
  if (o.afterFork) report.runs[0].attempts = report.runs[0].attempts.map((x) => ({ ...x, afterFork: { recorded: 2, inOrder: 0, live: 1, stubbed: 0, blocked: 0 } }));
  if (o.warnings) report.warnings = o.warnings;
  recordVerdict(store, { report, expect: SEND_ONCE, command: 'shadowlap verify --fixes label:double-email', rerun: { flags: [], command: null }, at: (at += DAY) });
  return { fixId: a.fixId, run: a.run, left: b.run, report };
}

describe('the Verify step', () => {
  it('opens on its verdict line with no button, then each run, its outcome a status before one Attempts cell, its attempts under the row on request', async () => {
    const { fixId, run } = verified();
    const d = fixDetail(store, fixId)!;
    await open(fixId, 'verify');
    expect(r!.one('.verdict .vw').className).toBe('vw ok');
    expect(text(r!.one('.verdict h2'))).toBe(`accepted ${d.verify[0].headline}`);
    expect(r!.all('.verdict .actions')).toEqual([]);
    expect(r!.all('table.vruns thead th').map(text)).toEqual(['Role', 'Run', 'Outcome', 'Attempts', 'Where it went']);
    const row = r!.one('table.vruns tbody tr');
    expect([row.querySelector('td.vo .st')!.className, text(row.querySelector('td.vo')!), text(row.querySelector('td.vid')!)]).toEqual(['st ok', 'fixed', run.slice(0, 10)]);
    expect(text(row.querySelector('td.va .acell')!)).toMatch(/^4 of 4/);
    expect(r!.all('table.vruns tr.sub')).toEqual([]);
    await r!.click(row.querySelector('td.va button.xbtn')!);
    expect(r!.all('table.vruns tr.sub .alist > .al')).toHaveLength(4);
    expect(text(r!.one('.cmdline'))).toContain('shadowlap verify');
  });

  it('says the failing runs an accepted verdict left out, each with its about line: what the header’s Verify this run does while it leads, else a small one of its own', async () => {
    const { fixId, left } = verified();
    const about = withAbouts(store, fixDetail(store, fixId)!).verify[0].left[0].about;
    await open(fixId, 'verify');
    const id = r!.one('.vleft a.rlink');
    expect([text(id), id.getAttribute('title')]).toEqual([left.slice(0, 10), about]);
    expect(about).toBeTruthy();
    // The header leads with Verify this run: the line only says what it does.
    expect(r!.byText('.ph .actions button', 'Verify this run').className).toBe('btn lime');
    expect(text(r!.one('.vleft'))).toBe(`${left.slice(0, 10)} wasn’t in this verify: Verify this run checks the code as it is now on it.`);
    expect(r!.all('.vleft button')).toEqual([]);
    await r!.unmount();
    // Applied, the header leads with what applying left undone, so the step offers it, small.
    markFixApplied(store, fixId, { patch: 'none', repairId: null, goldens: [], tests: 'skipped', via: 'fix apply' });
    await open(fixId, 'verify');
    const button = r!.byText('.vleft button', 'Verify this run');
    expect(button.className).toBe('btn sm');
    expect((JSON.parse(String(button.props['data-tip'])) as { t?: string }).t).toBe('Verifies the code as it is now on the run this change wasn’t verified on');
    expect(text(r!.one('.vleft > span'))).toBe(`${left.slice(0, 10)} wasn’t in this verify ·`);
  });

  it('ends on what verify printed, in its order: its warnings, what answered after the fork, per run, what it cost with the judge’s checks apart, then its command', async () => {
    const { fixId, report } = verified({ judge: true, afterFork: true, warnings: ['the base revision has uncommitted changes'] });
    await open(fixId, 'verify');
    expect(r!.all('ul.fxwarn li').map(text)).toEqual(['the base revision has uncommitted changes']);
    const receipts = r!.all('.fxreceipt').map(text);
    expect(receipts).toHaveLength(3);
    expect(receipts[0]).toBe(afterForkLines(report.runs, plain)[0].trim());
    expect(receipts[1]).toMatch(/^per run, as it would run live: /);
    expect(receipts[2]).toBe('4 attempts · 12 upstream requests · ≈$0.048 spent to find out before it shipped · judge checks: 3 upstream requests, ≈$0.0020. A run whose replay doesn’t fork settles in one free attempt.');
    // Each part kept whole, the line breaking only after a dot.
    expect(r!.all('.fxreceipt .nw').map(text)).toContain('judge checks: 3 upstream requests, ≈$0.0020');
    const order = r!.all('ul.fxwarn, .fxreceipt, .cmdline').map((x) => x.className.split(' ')[0]);
    expect(order).toEqual(['fxwarn', 'fxreceipt', 'fxreceipt', 'fxreceipt', 'cmdline']);
  });
});

describe('the drawers’ ways on', () => {
  const g = globalThis as Record<string, unknown>;
  const saved = { location: g.location, history: g.history };
  afterEach(() => void Object.assign(g, saved));

  /** The address bar as the router reads it: a replace rewrites it with no hashchange, a link followed sets it. */
  function address(first: string): { now: () => string } {
    let hash = first;
    const location = {
      pathname: '/',
      search: '',
      get hash() {
        return hash;
      },
      set hash(to: string) {
        hash = to;
        window.dispatchEvent(new Event('hashchange'));
      },
    };
    Object.assign(g, { location, history: { state: null, replaceState: (_s: unknown, _t: string, url: string) => (hash = url.slice(url.indexOf('#'))) } });
    return { now: () => hash };
  }

  // A job's id is the server's, never one seen before: when its end was first seen is kept by it.
  let jobs = 0;
  const job = (o: Partial<JobView>): JobView => ({ id: `job-${(jobs += 1)}`, args: [], worktree: null, runId: null, opensRun: false, startedAt: 1, done: false, stopped: false, code: null, newRunId: null, lines: [], total: 0, ...o });

  /** The page the address opens, the job drawer under it following `jobs` as `on.set` changes them. */
  async function page(first: JobView): Promise<{ set: (o: Partial<JobView>) => Promise<void>; toasts: string[] }> {
    const base = app();
    const on = { set: (_fn: (l: WatchedJob[]) => WatchedJob[]): void => undefined, toasts: [] as string[] };
    function Host() {
      const [jobs, setJobs] = useState<WatchedJob[]>([{ job: first, lines: [], open: true }]);
      useEffect(() => {
        on.set = setJobs;
      }, []);
      const route = useRoute();
      const value = { ...base, conn: 'ok', runs: [], jobs, dropToast: () => undefined, closeJob: () => undefined, openJob: () => undefined, toast: (t: string) => on.toasts.push(t) } as unknown as AppState;
      return createElement(AppContext.Provider, { value }, createElement('main', { id: 'view', tabIndex: -1 }, route.page === 'fixes' && route.id ? createElement(FixPage, { id: route.id, step: route.step, sub: route.sub }) : null), createElement(JobDrawer));
    }
    r = await render(createElement(Host));
    return { set: (o) => act(async () => on.set((l) => l.map((w) => ({ ...w, job: { ...w.job, done: true, code: 0, ...o } })))), toasts: on.toasts };
  }
  const wayOn = () => r!.all('.drawer .jfoot a, .drawer .jfoot .jkind button').map((b) => [text(b), b.className]);

  it('ends a blame on the fix’s next step while its page is on the screen, plain beside the page’s lime, and on the CLI’s Open fix alone elsewhere', async () => {
    const { fixId } = blamed();
    const opened = { label: 'Open fix', href: `#/fixes/${fixId}/blame` };
    const bar = address(`#/fixes/${fixId}/blame`);
    const drawer = await page(job({ kind: JOB_KINDS.blame, fixId, title: 'Blaming again' }));
    await r!.until('the fix to load', () => r!.all('h1').length === 1);
    const lime = r!.one('#view .ph .actions .btn.lime');
    await drawer.set({ links: [opened] });
    await r!.until('its next step', () => wayOn().length > 0);
    // The CLI's Open fix is this page: the drawer ends on what the header leads with, plain.
    expect(wayOn()).toEqual([[text(lime), 'btn']]);
    expect(bar.now()).toBe(`#/fixes/${fixId}/blame`);
    await r!.unmount();
    // Off the fix's page, Open fix leads, lime, with nothing beside it.
    address('#/fixes');
    const off = await page(job({ kind: JOB_KINDS.blame, fixId }));
    await off.set({ links: [opened] });
    expect(wayOn()).toEqual([['Open fix', 'btn lime']]);
  });

  it('opens a verify’s verdict in place once it ends, the drawer still open, and ends it on the fix’s next step', async () => {
    const { fixId, left } = verified();
    const bar = address(`#/fixes/${fixId}/verify`);
    const drawer = await page(job({ kind: JOB_KINDS.verify, fixId, title: 'Verifying' }));
    await r!.until('the fix to load', () => r!.all('h1').length === 1);
    const { verdict } = recordVerdict(store, { report: verifyReport([{ runId: left, role: 'target', pass: false }]), expect: SEND_ONCE, command: `shadowlap verify --fixes ${left}`, rerun: { flags: [], command: null }, at: (at += DAY) });
    await drawer.set({ code: 1, result: { verdict: 'rejected', verifyId: verdict.verifyId }, links: [{ label: 'Open fix', href: `#/fixes/${fixId}/verify/${verdict.verifyId}` }] });
    await r!.until('its verdict', () => bar.now().endsWith(verdict.verifyId));
    expect(bar.now()).toBe(`#/fixes/${fixId}/verify/${verdict.verifyId}`);
    await r!.until('the verdict shown', () => text(r!.one('.verdict .vw')) === 'rejected');
    expect(r!.all('section.drawer')).toHaveLength(1);
    await r!.until('its next step', () => wayOn().length > 0);
    expect(wayOn()).toEqual([[text(r!.one('#view .ph .actions .btn.lime')), 'btn']]);
  });

  it('ends an apply that left every other golden passing on Open goldens in Tests, unless Tests is the page', async () => {
    address('#/fixes/f1');
    const Footer = jobFooter(JOB_KINDS.applyFix)!;
    const ended = (o: Partial<JobView>, plain?: boolean) => createElement(AppContext.Provider, { value: app() }, createElement(Footer, { job: job({ kind: JOB_KINDS.applyFix, done: true, code: 0, result: { outdated: [] }, ...o }), ...(plain ? { plain } : {}) }));
    r = await render(ended({}));
    expect(r.all('a').map((a) => [text(a), a.getAttribute('href'), a.className])).toEqual([[OPEN_GOLDENS, '#/tests', 'btn lime']]);
    await r.unmount();
    r = await render(ended({}, true));
    expect(r.one('a').className).toBe('btn');
    await r.unmount();
    r = await render(ended({ code: 1 }));
    expect(r.all('a')).toEqual([]);
    await r.unmount();
    address('#/tests');
    r = await render(ended({}));
    expect(r.all('a')).toEqual([]);
  });

  it('offers Open Blame on a blame press the server refused as moved on, unless the page shows the Blame step', async () => {
    const { fixId } = blamed();
    const toasts: Array<{ text: string; action?: ToastAction }> = [];
    const watched: unknown[] = [];
    const fake = { toast: (t: string, _kind?: string, action?: ToastAction) => toasts.push({ text: t, ...(action ? { action } : {}) }), watchJob: (p: Promise<unknown>) => void p.catch((e: unknown) => watched.push(e)) };
    const moved = new ApiError(409, `${fixId.slice(0, 8)}'s blame settled where its run was lost, or the fix isn't open: there is nothing to blame again`);
    const bar = address(`#/fixes/${fixId}/repair`);
    await open(fixId, 'repair');
    refusedPress(fake, JOB_KINDS.blame, { fixId, again: true }, moved);
    expect(toasts.map((t) => [t.text, t.action?.label])).toEqual([[errorText(moved), OPEN_BLAME]]);
    toasts[0].action!.run();
    expect(bar.now()).toBe(`#/fixes/${fixId}/blame`);
    // Another refusal, or another job's, goes as every job's does.
    refusedPress(fake, JOB_KINDS.repair, { fixId }, moved);
    refusedPress(fake, JOB_KINDS.blame, { fixId }, new ApiError(400, 'name the model to blame with'));
    await r!.unmount();
    address(`#/fixes/${fixId}/blame`);
    await open(fixId, 'blame');
    refusedPress(fake, JOB_KINDS.blame, { fixId, again: true }, moved);
    await Promise.resolve();
    expect([toasts.length, watched.length]).toEqual([1, 3]);
  });
});
