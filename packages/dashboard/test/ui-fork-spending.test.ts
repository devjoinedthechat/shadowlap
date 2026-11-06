import { createElement, Fragment } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ActionLike } from '../ui/actions.js';
import type { CallDetail, Client, JobView } from '../ui/api.js';
import type { RunEstimates } from '../ui/estimates-api.js';
import { ForkMenu, useActionRunner } from '../ui/run/actions.js';
import { forgetRunEstimates } from '../ui/run/estimates.js';
import { resetSpending } from '../ui/spending.js';
import type { RunDetail } from '../ui/types.js';
import type { Estimate } from '../../engine/src/estimates/estimate.js';
import type { Spending } from '../../engine/src/estimates/spending.js';
import { shell } from './ui-overlays-page.js';
import { render, type FakeElement, type Rendered } from './ui-render.js';

/**
 * The fork menu by Spending: each row's card says what it bills once the server has priced the call,
 * and a press starts at once at or under the threshold, sending that estimate, or asks first. A row
 * that bills nothing starts before the server answers; a fork's Repeat, which runs live, asks.
 */

const RUN = '01M50J6C69T0S34ZZX4WBXJKD1';
const a = (key: string, label: string, over: Partial<ActionLike> = {}): ActionLike => ({ key, label, opensRun: true, prompt: null, disabled: null, group: 'call', ...over });
const ROWS = [a('a', 'Run live from #17', { flag: '--diverge-at 17' }), a('l', 'Force issue_refund live', { flag: '--live-tool issue_refund' }), a('e', 'Repeat 5 times', { group: 'run' }), a('s', 'Replay with writes stubbed', { group: 'run' })];
const run = { run: { runId: RUN, status: 'completed' }, actions: [], source: null } as unknown as RunDetail;
const call = (actions: ActionLike[]) => ({ call: { callNo: 17, kind: 'api', name: 'POST /v1/messages', effect: null }, actions, result: null, forkTitle: 'At #17 · model call' }) as unknown as CallDetail;
const price = (usd: number, over: Partial<Estimate> = {}): Estimate => ({ kind: 'fork', usd, ceiling: false, parts: [], ...over });

let r: Rendered | null = null;
beforeAll(() => {
  Object.assign(globalThis, { innerWidth: 1440, innerHeight: 900 });
});
afterEach(async () => {
  await r?.unmount();
  r = null;
  resetSpending();
  forgetRunEstimates();
});

type Sent = { key: string; sent: Record<string, unknown> | undefined };

/** The run page's menu and its runner, the server pricing the call as `answer` says (never, for one that hasn't answered). */
async function page(threshold: Spending, answer: RunEstimates | 'never', o: { rows?: ActionLike[]; forkAt?: number | null } = {}) {
  resetSpending(threshold);
  const sent: Sent[] = [];
  const client = {
    estimates: { runEstimates: () => (answer === 'never' ? new Promise(() => undefined) : Promise.resolve(answer)) },
    action: (_id: string, key: string, _no: number | null, _v?: string, _yes?: string, more?: Record<string, unknown>) => (sent.push({ key, sent: more }), Promise.resolve({ id: 'j1' } as JobView)),
  } as unknown as Client;
  function Page() {
    const runner = useActionRunner(RUN, false, null, o.forkAt ?? null);
    return createElement(Fragment, null, createElement(ForkMenu, { anchor: null as unknown as HTMLElement, run, call: call(o.rows ?? ROWS), offers: null, onPick: runner.run, onFindCommit: () => undefined, onClose: () => undefined }), runner.dialog);
  }
  r = await render(shell({ client, hasKind: () => true, actionsOff: null, jobs: [], guard: (fn: () => void) => (fn(), true), watchJob: () => undefined }, createElement(Page)));
  await r.wait(0);
  const row = (label: string) => r!.all('[role="menu"] button').find((b) => b.querySelector('b')?.textContent === label) as FakeElement;
  return { sent, row, asked: () => r!.all('.dialog').length > 0 };
}

describe('a fork menu by Spending', () => {
  it('says each row’s price on its card once the call is priced', async () => {
    const p = await page(0.5, { blame: null, actions: { a: price(0.027) } });
    expect((JSON.parse(p.row('Run live from #17').getAttribute('data-tip') ?? '{}') as { est?: unknown }).est).toEqual({ usd: 0.027, ceiling: false });
  });

  it('starts Run live at once under $0.50 with the estimate it showed, and asks above it', async () => {
    let p = await page(0.5, { blame: null, actions: { a: price(0.027) } });
    await r!.click(p.row('Run live from #17'));
    expect([p.sent, p.asked()]).toEqual([[{ key: 'a', sent: { estimate: { usd: 0.027, ceiling: false } } }], false]);
    await r!.unmount();
    forgetRunEstimates();
    p = await page(0.5, { blame: null, actions: { a: price(0.51) } });
    await r!.click(p.row('Run live from #17'));
    expect([p.sent, p.asked()]).toEqual([[], true]);
  });

  it('starts Run live at Never ask, and still asks before forcing a write live', async () => {
    const p = await page(null, { blame: null, actions: { a: price(0.51), l: price(0.01, { always: 'it acts on your systems' }) } });
    await r!.click(p.row('Run live from #17'));
    expect(p.sent.map((s) => s.key)).toEqual(['a']);
    await r!.click(p.row('Force issue_refund live'));
    expect([p.sent.length, p.asked()]).toEqual([1, true]);
  });

  it('starts a recording’s Repeat and stubbed replay before the server answers, and asks of a fork’s', async () => {
    let p = await page(0.5, 'never');
    await r!.click(p.row('Repeat 5 times'));
    await r!.click(p.row('Replay with writes stubbed'));
    expect(p.sent).toEqual([
      { key: 'e', sent: {} },
      { key: 's', sent: {} },
    ]);
    await r!.unmount();
    p = await page(0.5, 'never', { rows: [a('e', 'Repeat 5 times', { group: 'run', asksFirst: true })] });
    await r!.click(p.row('Repeat 5 times'));
    expect([p.sent, p.asked()]).toEqual([[], true]);
  });
});
