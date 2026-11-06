import { act, createElement, useCallback, useState, type ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunDetail } from '../ui/api.js';
import { FindingPanel, ResultsToggle } from '../ui/components/FindingPanel.js';
import type { Matrix } from '../ui/matrix.js';
import { InspectorPlace, useFindingPanel, usePickInView } from '../ui/run/InspectorPanel.js';
import { openResults, resetPanel } from '../ui/run/panel-state.js';
import { closePanel } from '../ui/run/run-keys.js';
import { render, type Rendered } from './ui-render.js';

/**
 * A finding's diff or results open in the inspector's place, beside the calls, so the list keeps its
 * place: the head says what shows and hides it, the body is the panel's own (no tab labels it), and a
 * pick of a call, Hide or Esc gives the inspector back. One at a time; what is open on a run stays
 * open while another run shows. A row's pick, which brings the inspector into view below 1160px, is
 * one function whatever is selected.
 */

const at7 = { type: 'request_changed', callNo: 7, name: 'POST /v1/messages', replayedBefore: 6, diff: [{ path: '$.messages[4].content', op: 'changed', before: 'refund', after: 'refund now' }] };
const fork = (runId: string, divergence: unknown = at7) => ({ run: { runId, parentRunId: 'P', divergence }, parent: null }) as unknown as RunDetail;

/** The results a page has a body for: an error-path preset's run that passed, through the matrix's own part. */
const presets: Matrix = {
  id: 'presets-A',
  label: 'Error-path presets on A',
  corner: 'run',
  rows: [{ key: 'A', label: 'A' }],
  cols: [{ key: 'tool-timeout', label: 'tool timeout' }],
  cell: () => ({ word: 'passed', tally: '6 of 6 passed', href: '#/run/A1/4' }),
};
const results = (key: string): ReactNode =>
  key === 'presets' ? createElement(FindingPanel, { kind: 'presets', name: 'Error-path preset results', label: 'Run × presets', meta: ['1 preset', 'just now'], cmd: 'shadowlap chaos A --presets', matrix: presets, receipt: [{ parts: ['6 requests to the model'] }] }) : null;

/** A run page's part that matters here: the findings' toggles, a call to pick and the inspector's place. */
function Page({ run }: { run: RunDetail }) {
  const p = useFindingPanel(run.run.runId);
  const inspector = createElement('section', { className: 'insp', id: 'insp', 'aria-label': 'Call 7' }, createElement('div', { className: 'ibody', id: 'ibody', role: 'tabpanel' }));
  return createElement(
    'main',
    { id: 'view' },
    createElement('button', { type: 'button', 'data-act': 'diff', onClick: p.onToggleDiff }, p.showDiff ? 'Hide diff' : 'Show diff'),
    createElement(ResultsToggle, { runId: run.run.runId, which: 'presets' }),
    createElement('button', { type: 'button', className: 'pick', onClick: p.close }, '#3'),
    createElement(InspectorPlace, { panel: p.panel, run, test: null, onClose: p.close, results, children: inspector }),
  );
}

let page: Rendered | null = null;
afterEach(async () => {
  await page?.unmount();
  page = null;
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
    expect(page.one('.fhead .nav button').textContent).toBe('Hide diff');
    expect(page.one('[data-act="diff"]').textContent).toBe('Hide diff');
    // Its body holds the diff and no tab's panel: no tab shows to label it.
    const body = page.one('#ibody');
    expect(body.getAttribute('role')).toBeNull();
    expect(body.getAttribute('aria-labelledby')).toBeNull();
    // The diff is a part of its own, in once its script comes.
    await page.until('the diff', () => page!.all('#ibody .diffpanel').length === 1);
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
    expect(page.one('.fhead .nav button').textContent).toBe('Hide results');
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
