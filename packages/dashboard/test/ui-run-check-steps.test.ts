import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JOB_KINDS, type RunDetail } from '../ui/api.js';
import type { OnShow } from '../ui/components/OnShow.js';
import { CheckBuilderPart, type BuilderProps } from '../ui/run/check-part.js';
import { NextStepButton } from '../ui/run/NextStepButton.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { NextStep } from '../ui/types.js';
import { render, type Rendered } from './ui-render.js';

/**
 * The steps a test replay's golden's checks lead its page with (src/check-steps.ts): Run tests,
 * Tests' whole session, where its checks changed since; Edit check…, the builder on the golden at
 * the check its own recording fails, which a page with no builder (an exported copy) never draws.
 */

const RUN = '01K5CQ4N7G0000000000000000';
const GOLDEN = 'goldens/refund-in-limit';
const run = { run: { runId: RUN, parentRunId: null, status: 'completed', meta: {} }, actions: [], children: [], calls: [] } as unknown as RunDetail;
const RUN_TESTS: NextStep = { key: 'run-tests', label: 'Run tests', golden: GOLDEN, gone: ['issue_refund called 0 times'], sub: 'Its checks changed since this test: the session judges them as they are now', command: 'shadowlap test goldens/*' };
const EDIT: NextStep = { key: 'edit-check', label: 'Edit check…', golden: GOLDEN, check: 'escalate called 1 time', sub: 'It fails refund-in-limit’s own recording: edit the check, or update the golden if the agent should now do this' };

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
});

function fakeBuilder() {
  const opened: BuilderProps[] = [];
  const Part = Object.assign(
    (p: BuilderProps) => {
      opened.push(p);
      return createElement('div', { className: 'fakeb' });
    },
    { preload: vi.fn(), script: 'loaded' as const },
  ) as unknown as OnShow<BuilderProps>;
  return { Part, opened };
}

async function step(next: NextStep, o: { builder?: OnShow<BuilderProps>; actionsOff?: string } = {}) {
  const started: Array<{ kind: string; fields: Record<string, unknown> }> = [];
  const client = {
    jobs: () => Promise.resolve([]),
    startJob: (kind: string, fields: Record<string, unknown>) => {
      started.push({ kind, fields });
      return Promise.resolve({ id: 'j1' });
    },
  };
  const app = { client, exported: false, meta: null, feeds: {}, jobs: [], live: [], runs: [], actionsOff: o.actionsOff ?? null, conn: 'live', guard: (fn: () => void) => (fn(), true), watchJob: () => undefined, toast: () => undefined } as unknown as AppState;
  const button = createElement(NextStepButton, { run, step: next, offers: null, onAction: () => undefined, onFindCommit: () => undefined });
  r = await render(createElement(AppContext.Provider, { value: app }, o.builder ? createElement(CheckBuilderPart.Provider, { value: o.builder }, button) : button));
  return { page: r, started };
}

const card = (b: { getAttribute: (a: string) => string | null }) => JSON.parse(b.getAttribute('data-tip') ?? '{}') as { t?: string; s?: string };

describe('a test replay’s step by its golden’s checks', () => {
  it('runs Tests’ whole session as Run tests, lime, saying its checks changed since this test', async () => {
    const { page, started } = await step(RUN_TESTS);
    const b = page.byText('button', 'Run tests');
    expect([b.className.includes('lime'), b.getAttribute('data-next'), card(b).s]).toEqual([true, 'run-tests', RUN_TESTS.sub]);
    await page.click(b);
    await page.until('the job', () => started.length === 1);
    expect(started).toEqual([{ kind: JOB_KINDS.tests, fields: {} }]);
  });

  it('opens the builder on the golden at the check as Edit check…, and draws nothing where nothing hands the page the builder', async () => {
    const b = fakeBuilder();
    let { page } = await step(EDIT, { builder: b.Part });
    const edit = page.byText('button', 'Edit check…');
    expect([edit.className.includes('lime'), edit.getAttribute('data-next'), card(edit)]).toEqual([true, 'edit-check', { t: 'Edit check…', s: EDIT.sub, rows: [] }]);
    await page.hover(edit);
    expect(b.Part.preload).toHaveBeenCalled();
    await page.click(edit);
    expect(b.opened).toMatchObject([{ golden: GOLDEN, edit: 'escalate called 1 time' }]);
    await r!.unmount();
    // An exported copy: its one script holds no builder, so the step has nothing to open.
    ({ page } = await step(EDIT));
    expect(page.all('button')).toEqual([]);
  });

  it('keeps Edit check… on a dashboard that can’t act, saying why, and opens nothing', async () => {
    const b = fakeBuilder();
    const { page } = await step(EDIT, { builder: b.Part, actionsOff: 'This dashboard is read-only: it was started with --read-only.' });
    const edit = page.byText('button', 'Edit check…');
    expect([edit.getAttribute('aria-disabled'), edit.className.includes('lime')]).toEqual(['true', false]);
    await page.click(edit);
    expect(b.opened).toEqual([]);
  });
});
