import { act, createElement, useState, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '@shadowlap/engine';
import { fixesView } from '../src/fixes-view.js';
import type { Client } from '../ui/api.js';
import { FixPage } from '../ui/fixes/FixPage.js';
import { RowStep } from '../ui/fixes/RowStep.js';
import { handOnAtEnd, headingRef, notingJobFrom } from '../ui/focus-manager.js';
import { NeedsLook } from '../ui/overview/NeedsLook.js';
import { ChangeBox } from '../ui/revert/ChangeBox.js';
import { RevertDialog } from '../ui/revert/RevertDialog.js';
import { useRoute } from '../ui/router.js';
import { ServedPartsContext } from '../ui/served-parts.js';
import { resetSpending } from '../ui/spending.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { FixDetail, FixLead, NeedsLookRow } from '../ui/types.js';
import { crashFixtures, GOLDEN, source, T0, MIN, work } from './crash-fixtures.js';
import { addressBar, app, watchThePage } from './ui-route-helpers.js';
import { render, type FakeElement, type Rendered } from './ui-render.js';

/**
 * A crash no model rescued, as its fix and its rows draw it: the Blame step's first bad commit, its
 * change and where to look; the fix's head leading with Find breaking commit, then Revert with Open
 * in editor beside it; the same step on a Fixes row and a Needs a look row, run on the crashed run;
 * and the focus going on from Find breaking commit to the Revert that took its place.
 */

const CHANGE = { file: 'agent/refund.py', files: ['agent/refund.py'], hunk: '@@ -1,2 +1,3 @@\n def total(items):\n+    log(items)\n     return sum(items)', line: 2, merge: false };

let store: Store;
let r: Rendered | null = null;
beforeEach(() => {
  store = Store.open(':memory:');
  resetSpending();
});
afterEach(async () => {
  await r?.unmount();
  r = null;
  store.close();
  vi.unstubAllGlobals();
});

const { named, blamed, detail } = crashFixtures(() => store);
const text = (el: FakeElement) => el.textContent.replace(/\s+/g, ' ').trim();

/** The fix of a crash, as the server serves it, its found change's path worked out as a project's would be. */
function crashFix(o: { named?: boolean; stronger?: boolean; live?: boolean } = {}): FixDetail {
  const { rec, fixId } = blamed('crashed', { stronger: !!o.stronger });
  if (o.named) named(T0 + 2 * MIN, CHANGE);
  const d = detail(fixId, work([source(rec, o.live ? { mode: 'fork' } : {})]));
  const change = d.blame?.crash?.commit?.change;
  if (change) change.path = CHANGE.file;
  return d;
}

interface Calls {
  started: Array<[string, unknown]>;
  offers: number;
}

/** The served dashboard's state around a page: its client answers a fix, the crashed run's step and offers, and records what starts. */
function served(fix: FixDetail | null, calls: Calls = { started: [], offers: 0 }, over: Partial<AppState> = {}, estimate: unknown = null): AppState {
  const step = fix?.lead?.key === 'bisect' || fix?.lead?.key === 'revert' ? fix.lead.step : null;
  const client = {
    fix: () => Promise.resolve(fix),
    jobs: () => Promise.resolve([]),
    attemptGroups: () => Promise.resolve({ blame: [], verify: [] }),
    nextStep: () => Promise.resolve({ next: step ? { ...step, estimate } : null }),
    offers: () => {
      calls.offers++;
      return Promise.resolve({ bisect: { good: 'aaaaaaa', bad: null, unavailable: null, commits: [] }, commit: fix?.blame?.crash?.commit ?? null });
    },
    startJob: (kind: string, fields: unknown) => {
      calls.started.push([kind, fields]);
      return new Promise(() => undefined);
    },
  } as unknown as Client;
  return app({ client, meta: { editor: 'vim +<line> <file>', project: { path: '/work/project', id: 'p1' } } as AppState['meta'], tick: 0, runsTick: 0, feeds: {}, jobs: [], hasKind: () => true, guard: (fn: () => void) => (fn(), true), watchJob: () => undefined, toast: () => undefined, ...over });
}

const parts = { RevertDialog, ChangeBox };
const inServed = (value: AppState, el: ReactElement) => createElement(ServedPartsContext.Provider, { value: parts }, createElement(AppContext.Provider, { value }, el));

async function fixPage(fix: FixDetail, step: string | null, calls?: Calls, estimate: unknown = null): Promise<Rendered> {
  r = await render(inServed(served(fix, calls, {}, estimate), createElement(FixPage, { id: fix.fixId, step, sub: null })));
  await r.until('the fix', () => r!.all('h1').length === 1);
  return r;
}

const head = () => r!.all('.ph .actions button').map((b) => [text(b), b.className]);

describe('a crash’s Blame step', () => {
  it('shows the first bad commit Find breaking commit named under its lead, its change, and to revert it or fix the code', async () => {
    await fixPage(crashFix({ named: true }), 'blame');
    const line = r!.one('.bisect.fxbis');
    expect(['.k', 'code', 'b'].map((q) => text(line.querySelector(q)!))).toEqual(['first bad commit', 'ccccccc', 'Log the total']);
    // Its change in its file's box, with Open in editor and Copy git revert.
    expect(r!.all('.codewrap.bisectdiff')).toHaveLength(1);
    expect(r!.all('.codewrap.bisectdiff button').map(text)).toEqual(['Open in editor', 'Copy git revert']);
    expect(text(r!.one('.fxnote'))).toBe('The agent stopped part way from ccccccc on, so the code broke the run, not an answer of the model’s. Revert the commit or fix the code, then run the tests.');
  });

  it('says to look at the code first, the search offline and free only where its golden replays so', async () => {
    await fixPage(crashFix(), 'blame');
    expect(r!.all('.bisect.fxbis')).toEqual([]);
    const say = 'The agent stopped part way, so look at the code first. Find breaking commit replays it offline and free, and names the commit that broke it. If none did, Run blame with stronger model says whether the model’s capability is the problem.';
    expect(text(r!.one('.fxnote'))).toBe(say);
    expect(r!.all('.fxnote .nw').map(text)).toEqual(['Find breaking commit', 'offline and free', 'the commit that broke it', 'Run blame with stronger model', 'the model’s capability']);
    await r!.unmount();
    store.close();
    store = Store.open(':memory:');
    await fixPage(crashFix({ live: true }), 'blame');
    expect(text(r!.one('.fxnote'))).toBe(say.replace(' offline and free,', ''));
  });

  it('says neither model rescues it once a stronger model was asked too', async () => {
    await fixPage(crashFix({ stronger: true }), 'blame');
    expect(text(r!.one('.fxnote'))).toBe('Neither model rescues it, so look at the code and the tools: every attempt ended as the recording did. Find breaking commit replays it offline and free, and names the commit that broke it.');
  });
});

describe('a crash’s fix head', () => {
  it('leads with Find breaking commit, lime and last, starting on the crashed run from where its golden passed', async () => {
    const calls: Calls = { started: [], offers: 0 };
    const fix = crashFix();
    // Where this machine names a stronger model, its blame is offered, plain before the search.
    fix.actions.blameStronger = { command: 'shadowlap blame 01M5 --model claude-opus-5-5' } as FixDetail['actions']['blameStronger'];
    resetSpending(0.5);
    await fixPage(fix, null, calls, { usd: 0, ceiling: 0 });
    // From where its golden last passed it starts at once: no dialog to ask in, so no ellipsis.
    expect(head()).toEqual([
      ['Run repair', 'btn'],
      ['Run blame with stronger model…', 'btn'],
      ['Find breaking commit', 'btn lime'],
    ]);
    await r!.click(r!.byText('.ph .actions button', 'Find breaking commit'));
    await r!.until('the search', () => calls.started.length === 1);
    expect(calls.started[0]).toEqual(['bisect', { runId: fix.blame!.runId, good: 'aaaaaaa', estimate: { usd: 0, ceiling: 0 } }]);
  });

  it('leads with Revert once the commit is named, Open in editor beside it, Find breaking commit gone, the lead the drawer presses', async () => {
    const fix = crashFix({ named: true, stronger: true });
    await fixPage(fix, null);
    expect(head().map(([t]) => t)).toEqual(['Run repair', 'Open in editor', 'Revert']);
    const revert = r!.byText('.ph .actions button', 'Revert');
    expect(revert.className).toBe('btn lime');
    const found = fix.blame!.crash!.commit!;
    expect([revert.getAttribute('data-next'), revert.getAttribute('data-golden'), revert.getAttribute('data-rev'), revert.getAttribute('data-at')]).toEqual(['revert', GOLDEN, 'ccccccc', String(found.at)]);
    await r!.click(revert);
    await r!.until('its dialog', () => r!.all('[role="dialog"]').length === 1);
    expect(text(r!.one('[role="dialog"] h3'))).toBe('Revert ccccccc?');
  });
});

describe('a crash’s step on a row', () => {
  /** A Fixes row's lead, as the list serves it: no commit on it. */
  const rowLead = (): FixLead => {
    const { rec } = blamed();
    named(T0 + 2 * MIN, CHANGE);
    return fixesView(store, { next: work([source(rec)]) }).fixes[0].next!;
  };

  it('opens Revert’s dialog on the commit its run’s offers name, never the page’s lead', async () => {
    const lead = rowLead();
    const calls: Calls = { started: [], offers: 0 };
    const fix = { blame: { crash: { commit: { rev: 'ccccccc', subject: 'Log the total', author: '', date: null, at: 1, untested: [], change: null } } } } as unknown as FixDetail;
    r = await render(inServed(served(fix, calls), createElement(RowStep, { fixId: 'fx-1', lead, why: null, version: '1' })));
    const revert = r.byText('button', 'Revert');
    expect([revert.className, revert.getAttribute('data-next')]).toEqual(['btn sm', null]);
    await r.click(revert);
    await r.until('its dialog', () => r!.all('[role="dialog"]').length === 1);
    expect(calls.offers).toBe(1);
    expect(text(r.one('[role="dialog"] h3'))).toBe('Revert ccccccc?');
  });
});

describe('Needs a look’s Find breaking commit, once its job ends', () => {
  const tick = (ms = 80) => act(() => new Promise<void>((done) => setTimeout(done, ms)));

  it('hands the focus on to the row’s Revert, the step that took its place', async () => {
    addressBar('#/');
    const changed = watchThePage();
    const { rec, run } = blamed();
    const bisect = fixesView(store, { next: work([source(rec)]) }).fixes[0].next!;
    named(T0 + 2 * MIN, CHANGE);
    const revert = fixesView(store, { next: work([source(rec)]) }).fixes[0].next!;
    const row = (lead: FixLead): NeedsLookRow => ({ kind: 'test', icon: 'fail', title: 'A golden failed: refund-in-limit', name: 'refund-in-limit', detail: 'exited with code 1', key: 'attn:failed:goldens/refund-in-limit', group: 'failing', step: { of: 'run', runId: run, step: (lead as Extract<FixLead, { key: 'bisect' | 'revert' }>).step }, href: '#/tests', runId: run, fixId: null, at: 3 });
    let show: (rows: NeedsLookRow[]) => void = () => undefined;
    const value = served(null);
    function Host() {
      useRoute();
      const [rows, setRows] = useState([row(bisect)]);
      show = setRows;
      return createElement('main', { id: 'view', tabIndex: -1 }, createElement('h1', { ref: headingRef }, 'Overview'), createElement(NeedsLook, { items: rows, total: rows.length }));
    }
    r = await render(inServed(value, createElement(Host)));
    await r.until('the row', () => r!.all('.arow .ast .btn').length === 1);
    await r.focus(r.byText('.arow .ast .btn', 'Find breaking commit'));
    await notingJobFrom(Promise.resolve({ id: 'job-bisect-1' }));
    handOnAtEnd('job-bisect-1');
    await tick();
    await act(async () => show([row(revert)]));
    await r.until('Revert in its place', () => r!.all('.arow .ast .btn').some((b) => text(b) === 'Revert'));
    await changed();
    expect(text(r.focused())).toBe('Revert');
    expect(r.focused().closest('[data-rowkey]')?.getAttribute('data-rowkey')).toBe('attn:failed:goldens/refund-in-limit');
  });
});
