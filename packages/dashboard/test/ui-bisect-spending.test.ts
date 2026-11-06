import { createElement } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Estimate } from '../../engine/src/estimates/estimate.js';
import type { ActionLike } from '../ui/actions.js';
import type { BisectOffer, CallDetail, Client, JobView } from '../ui/api.js';
import type { BisectQuery } from '../ui/estimates-api.js';
import { FindCommitDialog as TestsFindCommit } from '../ui/pages/TestsDialogs.js';
import { ForkMenu } from '../ui/run/actions.js';
import { BisectDialog } from '../ui/run/RunDialogs.js';
import { forgetBisectEstimates } from '../ui/runspage/bisect-estimate.js';
import { FindCommitDialog } from '../ui/runspage/FindCommit.js';
import { resetSpending } from '../ui/spending.js';
import type { BisectChoices, RunDetail } from '../ui/types.js';
import { shell } from './ui-overlays-page.js';
import { render, type FakeElement, type Rendered } from './ui-render.js';

/**
 * Find breaking commit, priced from the commit it starts at (`GET /api/estimates/bisect`): the run's
 * dialog, Runs' and Tests' each say the search's estimate once the commit has rested, follow the
 * commit typed, and start the job with the last one shown. The fork menu's row says the amount
 * alone, as a form's, from the commit its offer starts at. Until the estimate comes, the interim
 * words say what runs live; the note on what one live replay can't settle goes to the price's card.
 */

const RUN = '01M50J6C69T0S34ZZX4WBXJKD1';
const CARD = { title: 'If every commit but its own ran live', lines: ['A replay costs at most ≈$1.32, live from where it parts to its end, as the run did.', 'One live replay decides a commit: a failure that doesn’t happen every time can pass at one that has it.'] };
const priced = (good: string): Estimate => ({ kind: 'bisect', usd: good === 'aaaaaaa' ? 5.27 : 2.64, ceiling: true, parts: ['up to 4 commits', 'one live replay each, writes blocked'], card: CARD });
const OFFER = { target: { kind: 'run', runId: RUN }, failed: true, good: 'aaaaaaa', bad: 'bbbbbbb', revisions: [{ rev: 'aaaaaaa', at: 0, runs: 2, failed: 0 }], fork: true, live: true, unavailable: null, args: [] } as unknown as BisectOffer;

let r: Rendered | null = null;
beforeAll(() => {
  Object.assign(globalThis, { innerWidth: 1440, innerHeight: 900 });
});
afterEach(async () => {
  await r?.unmount();
  r = null;
  resetSpending();
  forgetBisectEstimates();
});

/** A page whose server prices a search as `priced` does, keeping what it was asked and what was started. */
async function shown(el: ReturnType<typeof createElement>) {
  resetSpending(0.5);
  const asked: BisectQuery[] = [];
  const started: Array<[string, Record<string, unknown>]> = [];
  const client = {
    // The fork menu's own rows are priced by a read that never answers here.
    estimates: { bisectEstimate: (q: BisectQuery) => (asked.push(q), Promise.resolve(priced(q.good ?? ''))), runEstimates: () => new Promise(() => undefined) },
    startJob: (kind: string, fields: Record<string, unknown>) => (started.push([kind, fields]), Promise.resolve({ id: 'j1', kind } as JobView)),
  } as unknown as Client;
  r = await render(shell({ client, hasKind: () => true, actionsOff: null, jobs: [], guard: (fn: () => void) => (fn(), true), watchJob: () => undefined }, el));
  await r.wait(0);
  return { asked, started };
}

const text = (el: FakeElement | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const cost = () => text(r!.one('.dialog .dcost'));
const flaky = () => r!.all('.dialog .fieldhint').some((p) => /doesn’t happen every time/.test(p.textContent ?? ''));

describe('Find breaking commit, priced from its commit', () => {
  it('says the run’s search once its commit has rested, follows the commit typed, and starts with the last one shown', async () => {
    const ran: Array<[string, Record<string, unknown>]> = [];
    const { asked } = await shown(createElement(BisectDialog, { runId: RUN, offer: OFFER, onRun: (good: string, sent: Record<string, unknown>) => ran.push([good, sent]), onClose: () => undefined }));
    // Until it comes, what runs live, and under the field what one live replay can't settle.
    expect(cost()).toBe('Billed by your provider · one live replay each, writes blocked');
    expect(flaky()).toBe(true);
    await r!.wait(300);
    expect(asked).toEqual([{ runId: RUN, good: 'aaaaaaa', bad: 'bbbbbbb' }]);
    expect(cost()).toBe('At most ≈$5.27 · up to 4 commits · one live replay each, writes blocked');
    expect(flaky()).toBe(false);
    await r!.type(r!.one('.dialog input[type="text"]'), 'ccccccc');
    await r!.wait(300);
    expect(asked.at(-1)).toEqual({ runId: RUN, good: 'ccccccc', bad: 'bbbbbbb' });
    expect(cost()).toContain('At most ≈$2.64');
    await r!.click(r!.one('.dialog .dlg-ok'));
    expect(ran).toEqual([['ccccccc', { estimate: { usd: 2.64, ceiling: true } }]]);
  });

  it('prices Runs’ search from the commit picked, and its job keeps it', async () => {
    const choices = { ...OFFER, target: { kind: 'run', runId: RUN }, expect: null } as unknown as BisectChoices;
    const { asked, started } = await shown(createElement(FindCommitDialog, { runId: RUN, choices, onClose: () => undefined }));
    await r!.wait(300);
    expect(asked).toEqual([{ runId: RUN, good: 'aaaaaaa', bad: 'bbbbbbb' }]);
    expect(cost()).toContain('At most ≈$5.27');
    await r!.click(r!.one('.dialog .dlg-ok'));
    expect(started[0]?.[1]).toMatchObject({ runId: RUN, good: 'aaaaaaa', estimate: { usd: 5.27, ceiling: true } });
  });

  it('prices Tests’ search of a golden over its known range, and sends it with the range', async () => {
    const ran: Array<Record<string, unknown>> = [];
    const { asked } = await shown(createElement(TestsFindCommit, { name: 'flaky', golden: 'goldens/flaky', range: { good: 'aaaaaaa', bad: 'bbbbbbb' }, live: true, revisions: [], tried: null, onRun: (f: Record<string, unknown>) => ran.push(f), onClose: () => undefined }));
    await r!.wait(300);
    expect(asked).toEqual([{ golden: 'goldens/flaky', good: 'aaaaaaa', bad: 'bbbbbbb' }]);
    await r!.click(r!.one('.dialog .dlg-ok'));
    expect(ran).toEqual([{ good: 'aaaaaaa', bad: 'bbbbbbb', estimate: { usd: 5.27, ceiling: true } }]);
  });

  it('says the amount alone on the fork menu’s row, from the commit its offer starts at, and no estimate with none yet', async () => {
    const run = { run: { runId: RUN, status: 'failed' }, actions: [], source: null } as unknown as RunDetail;
    const call = { call: { callNo: 3, kind: 'api', name: 'POST /v1/messages', effect: null }, actions: [] as ActionLike[], result: null, forkTitle: 'At #3 · model call' } as unknown as CallDetail;
    const menu = (bisect: BisectOffer) => createElement(ForkMenu, { anchor: null as unknown as HTMLElement, run, call, offers: { bisect } as never, onPick: () => undefined, onFindCommit: () => undefined, onClose: () => undefined });
    const row = () => r!.all('[role="menu"] button').find((b) => b.querySelector('small')?.textContent === 'bisect') as FakeElement;
    const est = () => (JSON.parse(String(row().props['data-tip'])) as { est?: unknown }).est;
    await shown(menu(OFFER));
    expect(est()).toBeUndefined();
    await r!.wait(300);
    expect(est()).toEqual({ usd: 5.27, ceiling: true, form: true });
    await r!.unmount();
    await shown(menu({ ...OFFER, good: null }));
    expect(est()).toEqual({ usd: null, ceiling: false, form: true });
  });
});
