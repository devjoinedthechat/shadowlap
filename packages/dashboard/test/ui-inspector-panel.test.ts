import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunDetail } from '../ui/api.js';
import { InspectorPlace, useFindingPanel } from '../ui/run/InspectorPanel.js';
import { render, type Rendered } from './ui-render.js';

/**
 * A finding's diff opens in the inspector's place, beside the calls, so the list keeps its place:
 * its head says where the diff is and hides it, its body is the panel's own (no tab labels it), and
 * a pick of a call, Hide or another run gives the inspector back.
 */

const at7 = { type: 'request_changed', callNo: 7, name: 'POST /v1/messages', replayedBefore: 6, diff: [{ path: '$.messages[4].content', op: 'changed', before: 'refund', after: 'refund now' }] };
const fork = (runId: string, divergence: unknown = at7) => ({ run: { runId, parentRunId: 'P', divergence }, parent: null }) as unknown as RunDetail;

/** A run page's part that matters here: the finding's toggle, a call to pick and the inspector's place. */
function Page({ run }: { run: RunDetail }) {
  const p = useFindingPanel(run.run.runId);
  const inspector = createElement('section', { className: 'insp', id: 'insp', 'aria-label': 'Call 7' }, createElement('div', { className: 'ibody', id: 'ibody', role: 'tabpanel' }));
  return createElement(
    'main',
    { id: 'view' },
    createElement('button', { type: 'button', 'data-act': 'diff', onClick: p.onToggleDiff }, p.showDiff ? 'Hide diff' : 'Show diff'),
    createElement('button', { type: 'button', className: 'pick', onClick: p.close }, '#3'),
    createElement(InspectorPlace, { kind: p.kind, run, test: null, onClose: p.close, children: inspector }),
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
