import { createElement } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Estimate } from '../../engine/src/estimates/estimate.js';
import type { ActionLike } from '../ui/actions.js';
import type { BisectOffer, CallDetail, Client, JobView } from '../ui/api.js';
import type { BisectQuery } from '../ui/estimates-api.js';
import { FindCommitButton, FindCommitDialog as TestsFindCommit } from '../ui/pages/TestsDialogs.js';
import { ForkMenu } from '../ui/run/ForkMenu.js';
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
    const { asked } = await shown(createElement(TestsFindCommit, { name: 'flaky', golden: 'goldens/flaky', range: { good: 'aaaaaaa', bad: 'bbbbbbb' }, live: true, goods: { revisions: [] }, onRun: (f: Record<string, unknown>) => ran.push(f), onClose: () => undefined }));
    await r!.wait(300);
    expect(asked).toEqual([{ golden: 'goldens/flaky', good: 'aaaaaaa', bad: 'bbbbbbb' }]);
    await r!.click(r!.one('.dialog .dlg-ok'));
    expect(ran).toEqual([{ good: 'aaaaaaa', bad: 'bbbbbbb', estimate: { usd: 5.27, ceiling: true } }]);
  });

  it('gives each golden’s Find breaking commit on Tests its card: a form at the amount alone where it runs live, free where it replays', async () => {
    const pressed: string[] = [];
    const golden = (over: Record<string, unknown>, live: boolean) => createElement(FindCommitButton, { f: { golden: 'goldens/flaky', bisect: { good: 'aaaaaaa', bad: 'bbbbbbb', live }, missed: null, revisions: [], ...over } as never, live, why: null, onBisect: () => pressed.push('bisect') });
    const card = () => JSON.parse(String(r!.one('button').props['data-tip'])) as { t?: string; s?: string; cmd?: string; est?: unknown };
    const { asked, started } = await shown(golden({}, true));
    expect(r!.one('button').textContent).toBe('Find breaking commit…');
    expect(card()).toMatchObject({ t: 'Find breaking commit', s: 'Runs live at each commit, so it costs tokens', cmd: 'shadowlap bisect goldens/flaky --good aaaaaaa --bad bbbbbbb' });
    expect(card().est).toBeUndefined();
    await r!.wait(300);
    expect(asked).toEqual([{ golden: 'goldens/flaky', good: 'aaaaaaa', bad: 'bbbbbbb' }]);
    expect(card().est).toEqual({ usd: 5.27, ceiling: true, form: true });
    // A form asks on every setting: the press opens its dialog, and nothing starts.
    await r!.click(r!.one('button'));
    expect([pressed, started]).toEqual([['bisect'], []]);
    await r!.unmount();
    const replays = await shown(golden({}, false));
    await r!.wait(300);
    expect(r!.one('button').textContent).toBe('Find breaking commit');
    expect(card()).toMatchObject({ s: 'Replays the golden at the commits since aaaaaaa, where it passed, offline: no tokens', cmd: 'shadowlap bisect goldens/flaky --good aaaaaaa --bad bbbbbbb' });
    expect([card().est, replays.asked]).toEqual([undefined, []]);
    await r!.unmount();
    await shown(golden({ missed: { why: 'It already failed at aaaaaaa', good: 'aaaaaaa', bad: 'bbbbbbb', outcome: 'fails-at-good' } }, false));
    expect(card()).toMatchObject({ s: 'Asks for an older commit: the last search found it failing at aaaaaaa', cmd: 'shadowlap bisect goldens/flaky --good <commit>' });
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

describe('Find breaking commit from the calendar', () => {
  const choices = (o: Record<string, unknown> = {}) => ({ ...OFFER, target: { kind: 'run', runId: RUN }, expect: null, revisions: [{ rev: 'aaaaaaa', at: Date.UTC(2026, 0, 1), runs: 2, failed: 0, subject: 'Escalate refunds above the limit' }], ...o }) as unknown as BisectChoices;
  const failure = { label: 'fork @17', command: 'python refund_agent.py T-8812', startedAt: Date.UTC(2026, 8, 30, 10, 14) };

  it('names each commit by its subject, as the server sends it, never by a date', async () => {
    await shown(createElement(FindCommitDialog, { runId: RUN, choices: choices(), failure, onClose: () => undefined }));
    const pick = text(r!.one('.dialog .bgood label'));
    expect(pick).toContain('aaaaaaa Escalate refunds above the limit');
    expect(pick).not.toMatch(/Jan 1/);
  });

  it('says the failure it starts from: its id, what it is, its command and when it ran', async () => {
    await shown(createElement(FindCommitDialog, { runId: RUN, choices: choices(), failure, onClose: () => undefined }));
    const first = r!.all('.dialog .dfacts > div')[0]!;
    expect(text(first.querySelectorAll('dt')[0])).toBe('Failure');
    expect(first.querySelector('dd a')!.getAttribute('href')).toBe(`#/run/${RUN}`);
    expect(text(first)).toContain(RUN.slice(0, 10));
    expect(text(first)).toContain('fork @17');
    expect(text(first)).toContain('python refund_agent.py T-8812');
  });

  it('names the first failure on the days picked that it passed over, a link to its run', async () => {
    const earlier = { runId: '01M50J6C69T0S34ZZX4WBXJKD0', why: '01M50J6C69 failed at the first commit, f6c5756: there is nothing before it to search' };
    await shown(createElement(FindCommitDialog, { runId: RUN, choices: choices(), failure, earlier, onClose: () => undefined }));
    const link = r!.one('.dialog .dwarn a');
    expect(link.getAttribute('href')).toBe(`#/run/${earlier.runId}`);
    expect(text(link)).toBe('01M50J6C69');
  });

  it('offers Open Tests where it can’t search and Tests finds the commit from the golden', async () => {
    const off = choices({ unavailable: 'this replay was cut short, so it says nothing about goldens/refund: find the breaking commit from the golden on Tests', onTests: true, good: null });
    await shown(createElement(FindCommitDialog, { runId: RUN, choices: off, failure, onClose: () => undefined }));
    expect(text(r!.one('.dialog .dlg-ok'))).toBe('Open Tests');
  });
});
