import { act, createElement, useCallback, useLayoutEffect, useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Client, RunDetail } from '../ui/api.js';
import type { RequestDiff } from '../src/request-diff.js';
import { FindingPanel } from '../ui/components/FindingPanel.js';
import { ResultsToggle } from '../ui/components/ResultsToggle.js';
import { claimCallFocus } from '../ui/focus-manager.js';
import type { Matrix } from '../ui/matrix.js';
import { InspectorPlace, useFindingPanel, usePickInView, warmDiff } from '../ui/run/InspectorPanel.js';
import { diffCallOf } from '../ui/run/model.js';
import { openResults, resetPanel } from '../ui/run/panel-state.js';
import { closePanel } from '../ui/run/run-keys.js';
import { AppContext, type AppState } from '../ui/state.js';
import { FakeElement, render, type Rendered } from './ui-render.js';

/**
 * A finding's diff or results open in the inspector's place, beside the calls, so the list keeps its
 * place: the head says what shows and hides it, the body is the panel's own (no tab labels it), and a
 * pick of a call, Hide or Esc gives the inspector back, and so does a link in it to one of the run's
 * calls. One at a time on a run's page; each run's results stay open while another run shows or opens
 * its own. A panel opened below 1160px comes into view, one the page comes back to stays where the
 * page starts. A row's pick, which brings the inspector into view below 1160px, is one function
 * whatever is selected.
 */

const at7 = { type: 'request_changed', callNo: 7, name: 'POST /v1/messages', replayedBefore: 6, diff: [{ path: '$.messages[4].content', op: 'changed', before: 'refund', after: 'refund now' }] };
const fork = (runId: string, divergence: unknown = at7) => ({ run: { runId, parentRunId: 'P', divergence, status: 'completed' }, parent: null }) as unknown as RunDetail;

/** The server's answer for a run: its request #7 as recorded and as sent, or the call `at` where the diff shows another. */
const answer = (at = 7): RequestDiff => ({ at, what: 'request', call: { kind: 'api', name: 'POST /v1/messages' }, against: { runId: 'P', callNo: at }, was: { a: 1 }, now: { a: 2 }, whole: true, leftOut: [], same: false, askedAgain: false, type: 'request_changed', path: '$.a', paths: [{ path: '$.a', what: null, fix: null }], updates: false, masked: [], outside: [], hints: [], flag: null, tool: null, next: null, test: false });

/** Show diff's read as a client answers it: the answer for call `at` (or the call asked for), or what `answers` says for each ask in turn (an error fails it, null is no diff). */
type Ask = (runId: string, callNo?: number) => Promise<RequestDiff | null>;
function asker(asked: string[], at = 7, answers: Array<RequestDiff | null | Error> = []): Ask {
  return (runId, callNo) => {
    asked.push(callNo === undefined ? runId : `${runId} #${callNo}`);
    const next = answers.length ? answers.shift()! : answer(callNo ?? at);
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
}

/** The app a page sits in: a client that answers Show diff's read, counting what it was asked. */
function app(asked: string[], at = 7, requestDiff: Ask = asker(asked, at)): AppState {
  return { client: { requestDiff } as unknown as Client, exported: false, meta: null, tick: 0, runsTick: 0, feeds: {}, jobs: [], live: [], runs: [], actionsOff: null, hasKind: () => true, guard: (fn: () => void) => fn(), watchJob: () => undefined, toast: () => undefined } as unknown as AppState;
}

/** The results a page has a body for: an error-path preset's run that passed, through the matrix's own part. */
const presets: Matrix = {
  id: 'presets-A',
  label: 'Error-path presets on A',
  corner: 'run',
  rows: [{ key: 'A', label: 'A' }],
  cols: [{ key: 'tool-timeout', label: 'tool timeout' }],
  cell: () => ({ word: 'passed', tally: '6 of 6 passed', href: '#/run/A1/4' }),
};
/** An injection test's results on A with one read: its head a link to the read's call on A, its cell to the attempt's own run. */
const reads: Matrix = {
  id: 'inj-A',
  label: 'Untrusted reads by payload',
  corner: 'untrusted read',
  rows: [{ key: '4', label: '#4 get_ticket', href: '#/run/A/4' }],
  cols: [{ key: 'tool-json', label: 'tool-json' }],
  cell: () => ({ word: 'obeyed', tally: '3 of 3 obeyed', href: '#/run/A2/5' }),
};
const results = (key: string): ReactNode =>
  key === 'presets'
    ? createElement(FindingPanel, { kind: 'presets', name: 'Error-path preset results', label: 'Run × presets', meta: ['1 preset', 'just now'], cmd: 'shadowlap chaos A --presets', matrix: presets, receipt: [{ parts: ['6 requests to the model'] }] })
    : key === 'injection:R1'
      ? createElement(FindingPanel, { kind: 'injection', name: 'Injection test results', label: 'Untrusted reads × payloads', meta: ['3 attempts'], cmd: 'shadowlap injection A --attempts 3', matrix: reads, receipt: [{ parts: ['3 upstream requests'] }] })
      : null;

/** The calls the page's pick heard. */
let picked: number[] = [];

/**
 * A run page's part that matters here, in an app whose client answers Show diff's read: the findings'
 * toggles, a call to pick, the calls' rows and the inspector's place, whose pick closes the panel and
 * selects the call, as the run page's does, and whose calls take the focus a pick hands them as they
 * draw.
 */
function Page({ run, asked = [], at = 7, ask, diffAt = null }: { run: RunDetail; asked?: string[]; at?: number; ask?: Ask; diffAt?: number | null }) {
  return createElement(AppContext.Provider, { value: app(asked, at, ask) }, createElement(Place, { run, diffAt }));
}

function Place({ run, diffAt }: { run: RunDetail; diffAt: number | null }) {
  const p = useFindingPanel(run.run.runId, diffAt);
  const [selected, setSelected] = useState(7);
  useLayoutEffect(claimCallFocus);
  const pick = (n: number) => (picked.push(n), p.close(), setSelected(n));
  const inspector = createElement('section', { className: 'insp', id: 'insp', 'aria-label': `Call ${selected}` }, createElement('div', { className: 'ibody', id: 'ibody', role: 'tabpanel' }));
  const rows = [3, 4, 7].map((n) => createElement('tr', { key: n, 'data-call': n, 'aria-selected': n === selected }));
  return createElement(
    'main',
    { id: 'view' },
    createElement('button', { type: 'button', 'data-act': 'diff', onClick: p.onToggleDiff }, p.showDiff ? 'Hide diff' : 'Show diff'),
    createElement(ResultsToggle, { runId: run.run.runId, which: 'presets' }),
    createElement('button', { type: 'button', className: 'pick', onClick: p.close }, '#3'),
    createElement('div', { className: 'vbody' }, createElement('table', null, createElement('tbody', null, ...rows))),
    createElement(InspectorPlace, { panel: p.panel, run, onClose: p.close, onPick: pick, results, children: inspector }),
  );
}

let page: Rendered | null = null;
afterEach(async () => {
  await page?.unmount();
  page = null;
  picked = [];
  resetPanel();
});

describe('a finding’s diff in the inspector’s place', () => {
  it('takes the inspector’s place, named by where the run diverged, with Hide in its head', async () => {
    page = await render(createElement(Page, { run: fork('A') }));
    expect(page.all('.fpanel')).toHaveLength(0);
    await page.click(page.one('[data-act="diff"]'));
    expect(page.all('#insp')).toHaveLength(1);
    const panel = page.one('#insp');
    expect(panel.getAttribute('class')).toBe('insp fpanel');
    expect(panel.getAttribute('aria-label')).toBe('Diff at #7');
    expect(page.one('.fhead .ct').textContent).toBe('Diff at #7');
    // Hide diff as the mock draws it, with no expanded state of its own.
    expect([page.one('.fhead .nav button').textContent, page.one('.fhead .nav button').getAttribute('aria-expanded')]).toEqual(['Hide diff', null]);
    expect(page.one('[data-act="diff"]').textContent).toBe('Hide diff');
    // Its body holds the diff and no tab's panel: no tab shows to label it.
    const body = page.one('#ibody');
    expect(body.getAttribute('role')).toBeNull();
    expect(body.getAttribute('aria-labelledby')).toBeNull();
    // The diff is a part of its own, in once its script comes, and so is its drawing.
    await page.until('the diff', () => page!.all('#ibody .diffpanel .jd').length === 1);
    expect(page.one('#ibody .jdh').textContent).toBe('−Recorded request #7\u00a0· P+This run’s request #7');
  });

  it('names the call its answer shows, and asks a finished run’s answer once for the page’s life', async () => {
    const asked: string[] = [];
    page = await render(createElement(Page, { run: fork('T'), asked, at: 8 }));
    await page.click(page.one('[data-act="diff"]'));
    // After a tool a fork changed, the diff shows the next model call: the head says so once it is known.
    await page.until('the answer', () => page!.one('.fhead .ct').textContent === 'Diff at #8');
    expect(page.one('#insp').getAttribute('aria-label')).toBe('Diff at #8');
    await page.until('the diff', () => page!.all('#ibody .jd').length === 1);
    await page.click(page.one('.fhead .nav button'));
    await page.click(page.one('[data-act="diff"]'));
    await page.until('the diff again', () => page!.all('#ibody .jd').length === 1);
    expect(asked).toEqual(['T']);
  });

  it('opens at the call picked where it may differ from the recording’s, asking for that call alone', async () => {
    const asked: string[] = [];
    page = await render(createElement(Page, { run: fork('S'), asked, diffAt: 9 }));
    await page.click(page.one('[data-act="diff"]'));
    expect(page.one('.fhead .ct').textContent).toBe('Diff at #9');
    await page.until('the diff', () => page!.all('#ibody .jd').length === 1);
    expect(page.one('#ibody .jdh').textContent).toBe('−Recorded request #9\u00a0· P+This run’s request #9');
    // Never "the first that changed": it is a call past where the run left its recording.
    await page.until('its words', () => page!.all('#ibody .hint').length === 1);
    expect(page.one('#ibody .hint').textContent!.replace(/\u00a0/g, ' ')).toContain('The request at #9 differs from the recording’s #9.');
    expect(page.one('#ibody .hint').textContent).not.toContain('first');
    expect(asked).toEqual(['S #9']);
  });

  it('opens a call picked that the replay served from the recording, or none past where it left it, where it left it', () => {
    const row = (callNo: number, origin: string, outcome: 'ok' | 'error' = 'ok') => ({ callNo, origin, outcome, scope: null });
    const forked = { run: { divergence: { type: 'request_changed', callNo: 7 } } } as unknown as RunDetail;
    // Made live after the fork, or answered by an override, or failed: its request may differ.
    expect([diffCallOf(forked, row(9, 'live')), diffCallOf(forked, row(10, 'overridden')), diffCallOf(forked, row(11, 'live', 'error'))]).toEqual([9, 10, 11]);
    // Where it left the recording, before it, served from the recording, the judge's, or with none picked: where the server picks.
    expect([diffCallOf(forked, row(7, 'live')), diffCallOf(forked, row(3, 'replayed')), diffCallOf(forked, row(12, 'replayed')), diffCallOf(forked, { ...row(13, 'live'), scope: 'shadowlap:judge' }), diffCallOf(forked, null)]).toEqual([null, null, null, null, null]);
    // A replay that ended early made no call after the recording's it never made.
    const early = { run: { divergence: { type: 'ended_early', callNo: 7 } } } as unknown as RunDetail;
    expect(diffCallOf(early, row(9, 'live'))).toBeNull();
  });

  it('gives the inspector back on a pick of a call', async () => {
    page = await render(createElement(Page, { run: fork('A') }));
    await page.click(page.one('[data-act="diff"]'));
    await page.click(page.one('.pick'));
    expect(page.all('.fpanel')).toHaveLength(0);
    expect(page.one('#ibody').getAttribute('role')).toBe('tabpanel');
    expect(page.one('[data-act="diff"]').textContent).toBe('Show diff');
  });

  it('gives it back on Hide, the finding’s toggle taking the focus', async () => {
    page = await render(createElement(Page, { run: fork('A') }));
    await page.click(page.one('[data-act="diff"]'));
    await page.click(page.one('.fhead .nav button'));
    expect(page.all('.fpanel')).toHaveLength(0);
    expect(page.focused()).toBe(page.one('[data-act="diff"]'));
  });

  it('says why a failed read failed, and Retry asks again and draws the diff', async () => {
    const asked: string[] = [];
    page = await render(createElement(Page, { run: fork('E'), asked, ask: asker(asked, 7, [new Error('the dashboard server stopped')]) }));
    await page.click(page.one('[data-act="diff"]'));
    await page.until('the error', () => page!.all('#ibody .loaderr').length === 1);
    expect(page.one('#ibody .loaderr').textContent).toContain('The dashboard server stopped');
    await page.click(page.one('#ibody .loaderr button'));
    await page.until('the diff', () => page!.all('#ibody .jd').length === 1);
    expect(asked).toEqual(['E', 'E']);
  });

  it('asks again as the panel opens where the ask the pointer made on Show diff failed', async () => {
    const asked: string[] = [];
    const ask = asker(asked, 7, [new Error('the dashboard server stopped')]);
    warmDiff({ requestDiff: ask }, 'W', false);
    await import('../ui/run/RequestDiff.js');
    await new Promise((done) => setTimeout(done, 0));
    expect(asked).toEqual(['W']);
    page = await render(createElement(Page, { run: fork('W'), asked, ask }));
    await page.click(page.one('[data-act="diff"]'));
    await page.until('the diff', () => page!.all('#ibody .jd').length === 1);
    expect(asked).toEqual(['W', 'W']);
  });

  it('draws the conversation a request built from its changes leaves out as `[ … ]`, last', async () => {
    const asked: string[] = [];
    const alone = { ...answer(), was: { model: 'm', a: 1 }, now: { model: 'm', a: 2 }, whole: false, leftOut: ['messages'] };
    page = await render(createElement(Page, { run: fork('L'), asked, ask: asker(asked, 7, [alone]) }));
    await page.click(page.one('[data-act="diff"]'));
    await page.until('the diff', () => page!.all('#ibody .jd').length === 1);
    expect(page.all('#ibody .jd .jl').map((l) => l.textContent)).toEqual(['model: "m"', '−removed: a: 1', '+added: a: 2', 'messages: [ … ]']);
  });

  it('says the run kept no call to compare where the answer is none', async () => {
    const asked: string[] = [];
    page = await render(createElement(Page, { run: fork('N'), asked, ask: asker(asked, 7, [null]) }));
    await page.click(page.one('[data-act="diff"]'));
    await page.until('the words', () => page!.all('#ibody .hint').length === 1);
    expect(page.one('#ibody .hint').textContent?.replace(/\u00a0/g, ' ')).toBe('This run kept no call #7 to compare.');
    expect(page.all('#ibody .jd')).toHaveLength(0);
  });

  it('keeps the inspector where the run has no diff to show', async () => {
    page = await render(createElement(Page, { run: fork('A', null) }));
    await page.click(page.one('[data-act="diff"]'));
    expect(page.all('.fpanel')).toHaveLength(0);
    expect(page.all('#insp')).toHaveLength(1);
  });
});

describe('a finding’s results in the inspector’s place', () => {
  const toggle = () => page!.one('[data-act="results"]');

  it('take the inspector’s place as Results, with Hide results in its head, and their body the page’s', async () => {
    page = await render(createElement(Page, { run: fork('A') }));
    expect([toggle().textContent, toggle().getAttribute('aria-expanded'), toggle().getAttribute('aria-controls')]).toEqual(['Show results', 'false', 'insp']);
    await page.click(toggle());
    const panel = page.one('#insp');
    expect([panel.getAttribute('class'), panel.getAttribute('aria-label')]).toEqual(['insp fpanel', 'Results']);
    expect(page.one('.fhead .ct').textContent).toBe('Results');
    // Hide results says what it hides is expanded, as the finding's toggle does.
    expect([page.one('.fhead .nav button').textContent, page.one('.fhead .nav button').getAttribute('aria-expanded')]).toEqual(['Hide results', 'true']);
    expect([toggle().textContent, toggle().getAttribute('aria-expanded')]).toEqual(['Hide results', 'true']);
    expect(page.one('#ibody .rmxp').getAttribute('aria-label')).toBe('Error-path preset results');
    // The matrix is a part of its own, in once its script comes.
    await page.until('the matrix', () => page!.all('#ibody .rmx').length === 1);
  });

  it('leave the inspector as it is where the page has no body for them', async () => {
    page = await render(createElement(Page, { run: fork('A') }));
    await act(async () => openResults('A', 'injection:01K5CQ4N7G'));
    expect(page.all('.fpanel')).toHaveLength(0);
    expect(page.one('#insp').getAttribute('aria-label')).toBe('Call 7');
  });

  it('show one panel at a time, the newest opened', async () => {
    page = await render(createElement(Page, { run: fork('A') }));
    await page.click(toggle());
    await page.click(page.one('[data-act="diff"]'));
    expect(page.one('#insp').getAttribute('aria-label')).toBe('Diff at #7');
    expect(toggle().textContent).toBe('Show results');
    await page.click(toggle());
    expect(page.one('#insp').getAttribute('aria-label')).toBe('Results');
    expect(page.one('[data-act="diff"]').textContent).toBe('Show diff');
  });

  it('give the inspector back on Hide and on Esc, their toggle taking the focus', async () => {
    page = await render(createElement(Page, { run: fork('A') }));
    await page.click(toggle());
    await page.click(page.one('.fhead .nav button'));
    expect(page.all('.fpanel')).toHaveLength(0);
    expect(page.focused()).toBe(toggle());
    await page.click(toggle());
    page.one('#ibody').focus();
    let closed = false;
    await act(async () => void (closed = closePanel('A')));
    expect(closed).toBe(true);
    expect(page.all('.fpanel')).toHaveLength(0);
    expect(page.focused()).toBe(toggle());
    // nothing left to close: Esc goes on to leave the page
    expect(closePanel('A')).toBe(false);
  });

  it('give the inspector back on a click of a read’s head, a pick of its call taking the focus, while a cell’s link goes to its attempt’s run with them kept', async () => {
    page = await render(createElement(Page, { run: fork('A') }));
    await act(async () => openResults('A', 'injection:R1'));
    await page.until('the matrix', () => page!.all('#ibody .rmx').length === 1);
    // A cell's link opens its attempt's run as links go, the results kept for the way back; so does a
    // click that opens the read's call in another tab.
    expect((await page.fire(page.one('#ibody a.rmx-c'), 'click')).defaultPrevented).toBe(false);
    expect((await page.fire(page.one('#ibody a.rmx-rb'), 'click', { metaKey: true })).defaultPrevented).toBe(false);
    expect([page.one('#insp').getAttribute('aria-label'), picked]).toEqual(['Results', []]);
    // A click on the read's head picks its call, as a row does: the inspector comes back on it, and the
    // call takes the focus the link had once it draws as the selected one.
    await page.click(page.one('#ibody a.rmx-rb'));
    expect([page.all('.fpanel').length, page.one('#insp').getAttribute('aria-label'), picked]).toEqual([0, 'Call 4', [4]]);
    expect(page.focused()).toBe(page.one('tr[data-call="4"]'));
    // In place of the link's own way: the address is the page's to write, the view it shows kept.
    await act(async () => openResults('A', 'injection:R1'));
    await page.until('the matrix', () => page!.all('#ibody .rmx').length === 1);
    expect((await page.fire(page.one('#ibody a.rmx-rb'), 'click')).defaultPrevented).toBe(true);
    expect([page.all('.fpanel').length, picked]).toEqual([0, [4, 4]]);
  });

  it('stay open on their run while another run opens its own or a diff, and keep a run’s diff while another opens results', async () => {
    page = await render(createElement(Page, { run: fork('A') }));
    await page.click(toggle());
    await page.unmount();
    page = await render(createElement(Page, { run: fork('C') }));
    await page.click(page.one('[data-act="diff"]'));
    expect(page.one('#insp').getAttribute('aria-label')).toBe('Diff at #7');
    await page.click(toggle());
    expect(page.one('#insp').getAttribute('aria-label')).toBe('Results');
    await page.unmount();
    page = await render(createElement(Page, { run: fork('A') }));
    expect(page.one('#insp').getAttribute('aria-label')).toBe('Results');
    // Esc there closes A's alone.
    await act(async () => void closePanel('A'));
    await page.unmount();
    page = await render(createElement(Page, { run: fork('C') }));
    expect(page.one('#insp').getAttribute('aria-label')).toBe('Results');
    // A diff open on A stays while C opens its results; a diff is one at a time across runs, the newest opened.
    await page.unmount();
    page = await render(createElement(Page, { run: fork('A') }));
    await page.click(page.one('[data-act="diff"]'));
    await page.unmount();
    page = await render(createElement(Page, { run: fork('B') }));
    await page.click(toggle());
    await page.unmount();
    page = await render(createElement(Page, { run: fork('A') }));
    expect(page.one('#insp').getAttribute('aria-label')).toBe('Diff at #7');
    await page.unmount();
    page = await render(createElement(Page, { run: fork('C') }));
    await page.click(page.one('[data-act="diff"]'));
    await page.unmount();
    page = await render(createElement(Page, { run: fork('A') }));
    expect(page.all('.fpanel')).toHaveLength(0);
  });

  it('stay open while another run shows, a pick there closing only that run’s panel', async () => {
    page = await render(createElement(Page, { run: fork('A') }));
    await page.click(toggle());
    await page.unmount();
    page = await render(createElement(Page, { run: fork('B') }));
    expect(page.all('.fpanel')).toHaveLength(0);
    await page.click(page.one('.pick'));
    await page.unmount();
    page = await render(createElement(Page, { run: fork('A') }));
    expect(page.one('#insp').getAttribute('aria-label')).toBe('Results');
    await page.click(page.one('.pick'));
    expect(page.all('.fpanel')).toHaveLength(0);
  });
});

describe('a panel below 1160px', () => {
  // The test's page lays nothing out: the window is put at 1050×800, the inspector's place low in it,
  // and what brings it into view is counted.
  const own = { rect: FakeElement.prototype.getBoundingClientRect, scroll: FakeElement.prototype.scrollIntoView };
  let brought = 0;
  beforeEach(() => {
    brought = 0;
    Object.assign(globalThis, { innerWidth: 1050, innerHeight: 800 });
    FakeElement.prototype.getBoundingClientRect = function (this: FakeElement) {
      const top = this.id === 'insp' ? 700 : 0;
      return { left: 0, top, right: 0, bottom: top, width: 0, height: 0, x: 0, y: top };
    };
    FakeElement.prototype.scrollIntoView = function (this: FakeElement) {
      if (this.id === 'insp') brought++;
    };
  });
  afterEach(() => {
    FakeElement.prototype.getBoundingClientRect = own.rect;
    FakeElement.prototype.scrollIntoView = own.scroll;
    for (const k of ['innerWidth', 'innerHeight']) delete (globalThis as Record<string, unknown>)[k];
  });

  it('comes into view as it opens on the page, and leaves the page where it starts when the page comes back to it open', async () => {
    page = await render(createElement(Page, { run: fork('A') }));
    await page.click(page.one('[data-act="results"]'));
    expect(brought).toBe(1);
    // Back on the run with its results kept open: the page starts at its top.
    await page.unmount();
    page = await render(createElement(Page, { run: fork('A') }));
    expect(page.one('#insp').getAttribute('aria-label')).toBe('Results');
    expect(brought).toBe(1);
    // Opened again there, the diff in their place, it comes into view.
    await page.click(page.one('[data-act="diff"]'));
    expect(brought).toBe(2);
  });
});

describe('a row’s pick', () => {
  it('stays one function as the selection moves and the call’s details come, so a row draws again only when its own selection changes', async () => {
    type Detail = { data: { call: { callNo: number } } | null; error: Error | null };
    const picks = new Set<(n: number) => void>();
    let detailCame: (d: Detail) => void = () => undefined;
    function Rows() {
      const [selected, setSelected] = useState<number | null>(1);
      const [detail, setDetail] = useState<Detail>({ data: null, error: null });
      detailCame = setDetail;
      const select = useCallback((n: number) => setSelected(n), []);
      const pick = usePickInView(select, selected, detail);
      picks.add(pick);
      return createElement(
        'table',
        null,
        createElement('tbody', null, ...[1, 2].map((n) => createElement('tr', { key: n, 'data-call': n, 'aria-selected': selected === n, onClick: () => pick(n) }))),
      );
    }
    page = await render(createElement(Rows));
    await page.click(page.one('tr[data-call="2"]'));
    expect(page.one('tr[aria-selected="true"]').getAttribute('data-call')).toBe('2');
    await page.wait(0);
    detailCame({ data: { call: { callNo: 2 } }, error: null });
    await page.wait(0);
    await page.click(page.one('tr[data-call="1"]'));
    expect(page.one('tr[aria-selected="true"]').getAttribute('data-call')).toBe('1');
    expect(picks.size).toBe(1);
  });
});
