import { createElement, useCallback, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Client, RunDetail } from '../ui/api.js';
import type { RequestDiff } from '../src/request-diff.js';
import { InspectorPlace, useFindingPanel, usePickInView, warmDiff } from '../ui/run/InspectorPanel.js';
import { AppContext, type AppState } from '../ui/state.js';
import { render, type Rendered } from './ui-render.js';

/**
 * A finding's diff opens in the inspector's place, beside the calls, so the list keeps its place:
 * its head says where the diff is and hides it, its body is the panel's own (no tab labels it), and
 * a pick of a call, Hide or another run gives the inspector back. A row's pick, which brings the
 * inspector into view below 1160px, is one function whatever is selected.
 */

const at7 = { type: 'request_changed', callNo: 7, name: 'POST /v1/messages', replayedBefore: 6, diff: [{ path: '$.messages[4].content', op: 'changed', before: 'refund', after: 'refund now' }] };
const fork = (runId: string, divergence: unknown = at7) => ({ run: { runId, parentRunId: 'P', divergence, status: 'completed' }, parent: null }) as unknown as RunDetail;

/** The server's answer for a run: its request #7 as recorded and as sent, or the call `at` where the diff shows another. */
const answer = (at = 7): RequestDiff => ({ at, what: 'request', call: { kind: 'api', name: 'POST /v1/messages' }, against: { runId: 'P', callNo: at }, was: { a: 1 }, now: { a: 2 }, whole: true, same: false, askedAgain: false, type: 'request_changed', path: '$.a', paths: [{ path: '$.a', what: null, fix: null }], updates: false, masked: [], outside: [], hints: [], flag: null, tool: null, next: null, test: false });

/** Show diff's read as a client answers it: the answer for call `at`, or what `answers` says for each ask in turn (an error fails it, null is no diff). */
type Ask = (runId: string) => Promise<RequestDiff | null>;
function asker(asked: string[], at = 7, answers: Array<RequestDiff | null | Error> = []): Ask {
  return (runId) => {
    asked.push(runId);
    const next = answers.length ? answers.shift()! : answer(at);
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
}

/** The app a page sits in: a client that answers Show diff's read, counting what it was asked. */
function app(asked: string[], at = 7, requestDiff: Ask = asker(asked, at)): AppState {
  return { client: { requestDiff } as unknown as Client, exported: false, meta: null, tick: 0, runsTick: 0, feeds: {}, jobs: [], live: [], runs: [], actionsOff: null, hasKind: () => true, guard: (fn: () => void) => fn(), watchJob: () => undefined, toast: () => undefined } as unknown as AppState;
}

/** A run page's part that matters here: the finding's toggle, a call to pick and the inspector's place. */
function Page({ run, asked = [], at = 7, ask }: { run: RunDetail; asked?: string[]; at?: number; ask?: Ask }) {
  return createElement(AppContext.Provider, { value: app(asked, at, ask) }, createElement(Place, { run }));
}

function Place({ run }: { run: RunDetail }) {
  const p = useFindingPanel(run.run.runId);
  const inspector = createElement('section', { className: 'insp', id: 'insp', 'aria-label': 'Call 7' }, createElement('div', { className: 'ibody', id: 'ibody', role: 'tabpanel' }));
  return createElement(
    'main',
    { id: 'view' },
    createElement('button', { type: 'button', 'data-act': 'diff', onClick: p.onToggleDiff }, p.showDiff ? 'Hide diff' : 'Show diff'),
    createElement('button', { type: 'button', className: 'pick', onClick: p.close }, '#3'),
    createElement(InspectorPlace, { kind: p.kind, run, onClose: p.close, children: inspector }),
  );
}

let page: Rendered | null = null;
afterEach(async () => {
  await page?.unmount();
  page = null;
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
    expect(page.one('.fhead .nav button').textContent).toBe('Hide diff');
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
