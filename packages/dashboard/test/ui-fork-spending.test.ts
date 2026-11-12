import { createElement, Fragment } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ActionLike } from '../ui/actions.js';
import type { CallDetail, Client, JobView } from '../ui/api.js';
import type { RunEstimates } from '../ui/estimates-api.js';
import { useActionRunner } from '../ui/run/actions.js';
import { ForkMenu } from '../ui/run/ForkMenu.js';
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
/** The recording a fork was made from: its stubbed replay is made again from it. */
const PARENT = '01M50HZZ4Q3X1R8T0V5BWN2KD7';
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
async function page(threshold: Spending, answer: RunEstimates | 'never' | ((model?: string | null) => RunEstimates), o: { rows?: ActionLike[]; forkAt?: number | null } = {}) {
  resetSpending(threshold);
  const sent: Sent[] = [];
  const client = {
    estimates: { runEstimates: (_id: string, _at?: number | null, model?: string | null) => (answer === 'never' ? new Promise(() => undefined) : Promise.resolve(typeof answer === 'function' ? answer(model) : answer)) },
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

const text = (el: FakeElement) => (el.textContent ?? '').replace(/\s+/g, ' ').trim();

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
    // The dialog an action asks in is a part of its own (actions.tsx): it shows once its script is in.
    await r!.until('its dialog', p.asked);
    expect(p.sent).toEqual([]);
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

describe('the asks of the forks that run live', () => {
  it('asks Run live from a model call in its words, its Cost line the estimate and its footer why, and starts with what it said', async () => {
    const p = await page(0.5, { blame: null, actions: { a: price(0.51, { parts: ['live from #17, writes fenced'] }) } });
    await r!.click(p.row('Run live from #17'));
    expect(text(r!.one('.dialog h3'))).toBe('Run live from #17');
    expect(text(r!.one('.dialog header'))).toContain('Asks model call #17 again, with nothing changed, so the run can take another path.');
    expect(text(r!.one('.dialog .dcost'))).toBe('≈$0.510 · live from #17, writes fenced');
    expect(text(r!.one('.dialog .dlgcost'))).toBe('Asks above $0.50 · Change');
    await r!.click(r!.byText('.dialog footer button', 'Run live from #17'));
    expect(p.sent).toEqual([{ key: 'a', sent: { estimate: { usd: 0.51, ceiling: false } } }]);
  });

  it('asks a fork’s stubbed replay with its command and what runs live, then its estimate and why, and starts with what it said', async () => {
    const hint = 'Write tools after the fork return their stub instead of being blocked, so the agent goes on as if they had worked.';
    // A fork's menu: its Repeat asks first, which is how the menu knows the run is one.
    const rows = [a('e', 'Repeat 5 times', { group: 'run', asksFirst: true }), a('s', 'Replay with writes stubbed', { group: 'run', hint, command: `shadowlap replay ${PARENT} --inject 15=Be\\ brief. --writes stub` })];
    let p = await page(0.5, 'never', { rows, forkAt: 15 });
    await r!.click(p.row('Replay with writes stubbed'));
    expect(text(r!.one('.dialog header'))).toContain(hint);
    expect(r!.one('.dialog header a').getAttribute('href')).toContain('interventions.md#repeat-a-fork');
    expect(text(r!.one('.dialog .db'))).toContain('shadowlap replay 01M50HZZ4Q --inject 15=Be\\ brief. --writes stub');
    expect(text(r!.one('.dialog .dcost'))).toBe('Billed by your provider · 1 attempt, live from #15, writes fenced');
    await r!.unmount();
    forgetRunEstimates();
    p = await page(0.5, { blame: null, actions: { s: price(0.6, { kind: 'repeat', attempts: 1, each: 0.6, parts: ['1 attempt, live from #16, writes fenced'] }) } }, { rows, forkAt: 15 });
    await r!.click(p.row('Replay with writes stubbed'));
    expect(text(r!.one('.dialog .dcost'))).toBe('≈$0.600 · 1 attempt, live from #16, writes fenced');
    expect(text(r!.one('.dialog .dlgcost'))).toBe('Asks above $0.50 · Change');
    expect(text(r!.one('.dialog .db'))).toContain('--writes stub');
    await r!.click(r!.byText('.dialog footer button', text(r!.one('.dialog h3'))));
    expect(p.sent).toEqual([{ key: 's', sent: { estimate: { usd: 0.6, ceiling: false } } }]);
  });

  it('words Use changed prompt’s ask, and a write forced live asks at Never ask with no footer', async () => {
    const rows = [a('g', 'Use changed prompt from here', { flag: '--prompt-from 17' }), a('l', 'Force issue_refund live', { flag: '--live-tool issue_refund', warns: 'issue_refund acts on your systems' })];
    let p = await page(0.5, { blame: null, actions: { g: price(0.9, { parts: ['live from #17, writes fenced'] }) } }, { rows });
    await r!.click(p.row('Use changed prompt from here'));
    expect(text(r!.one('.dialog header'))).toContain('Your code’s system prompt and tools answer from model call #17 on.');
    expect(r!.one('.dialog header a').getAttribute('href')).toContain('apply-a-changed-prompt-from-a-later-call');
    await r!.unmount();
    forgetRunEstimates();
    p = await page(null, { blame: null, actions: { l: price(0.01, { always: 'it acts on your systems', parts: ['live from #18, other writes fenced'] }) } }, { rows });
    await r!.click(p.row('Force issue_refund live'));
    expect(text(r!.one('.dialog .dcost'))).toBe('≈$0.010 · live from #18, other writes fenced');
    expect(r!.all('.dialog .dlgcost')).toHaveLength(0);
  });

  it('prices Switch model for the model typed once the field rests, as recorded while it is empty', async () => {
    const m = a('m', 'Switch model from here…', { flag: '--model 17:…', prompt: { label: 'Model from #17 on:', placeholder: 'claude-sonnet-5' } });
    const asked: (string | null | undefined)[] = [];
    const p = await page(0.5, (model) => (asked.push(model), { blame: null, actions: { m: price(model === 'claude-opus-5' ? 2.5 : 1) } }), { rows: [m] });
    await r!.click(p.row('Switch model from here…'));
    expect(text(r!.one('.dialog .dcost'))).toBe('≈$1.00');
    await r!.type(r!.one('.dialog input'), 'claude-haiku-5');
    await r!.type(r!.one('.dialog input'), 'claude-opus-5');
    expect(text(r!.one('.dialog .dcost'))).toContain('Billed by your provider');
    await r!.wait(300);
    expect([text(r!.one('.dialog .dcost')), asked]).toEqual(['≈$2.50', [undefined, 'claude-opus-5']]);
    await r!.click(r!.byText('.dialog footer button', 'Switch model from #17'));
    expect(p.sent).toEqual([{ key: 'm', sent: { estimate: { usd: 2.5, ceiling: false } } }]);
  });
});
