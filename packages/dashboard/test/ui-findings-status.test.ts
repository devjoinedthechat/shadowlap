import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunJudged } from '../src/run-outcome.js';
import type { Client } from '../ui/api.js';
import { pendingRunOf } from '../ui/run/delete-run.js';
import { Banner, forgetOpenFindings } from '../ui/run/FindingsBar.js';
import { outcomeFact } from '../ui/run/metrics.js';
import { checksOf, runLikeOf } from '../ui/run/model.js';
import { isFailed, matchesChip, RUN_CHIPS, type RunLike } from '../ui/runs.js';
import { RunsTable } from '../ui/runspage/RunsTable.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { RunDetail, RunListItem, RunOffers } from '../ui/types.js';
import { render, type Rendered } from './ui-render.js';

/**
 * A run's page and Runs' Status say one thing of a run: a failed test replay its golden's next replay
 * passed is `fixed by <run>`, muted and out of Failed, in its findings too, which offer nothing to mend
 * it; a capture its import judged failed is failed by the check it failed, in its finding and in what
 * a waiting delete takes off Failed's count.
 */

const REC = '01K8RG00000000000000000009';
const TEST = '01K8RG00000000000000000002';
const CAPTURE = '01K8RG00000000000000000003';
const PASSED = '01K8RG7A3M0000000000000000';

let page: Rendered | null = null;
afterEach(async () => {
  await page?.unmount();
  page = null;
  forgetOpenFindings();
});

const app = { client: { jobs: () => Promise.resolve([]) } as unknown as Client, exported: false, actionsOff: null, runs: [], jobs: [], live: [], feeds: {}, toast: () => undefined, guard: (fn: () => void) => fn(), watchJob: () => undefined, hasKind: () => true } as unknown as AppState;

const JUDGED: RunJudged = { by: 'import', verdict: 'failed', counts: { passed: 0, failed: 1, inconclusive: 0, notApplicable: 0 }, callNo: 6, first: { label: 'issue_refund.amount <= get_policy.result.limit', detail: '#6: amount 240 > 100 (#4)' }, today: false, goldens: [], why: null };

/** A test replay that diverged at #3, and its golden's next replay passed, as its page has it: the server's state still says it failed. */
const fixedTest = {
  run: { runId: TEST, parentRunId: REC, mode: 'replay', status: 'failed', divergence: { type: 'request_changed', callNo: 3, kind: 'api', name: 'POST /v1/messages', replayedBefore: 2 }, command: { argv: ['node', 'agent.mjs'], cwd: '.' }, codeVersion: 'f6c5756', startedAt: 1, endedAt: 2, meta: { labels: [], test: { golden: 'goldens/refund', session: 's1' } } },
  summary: { upstreamRequests: 0, byKind: { api: 3, tool: 2, clock: 0, random: 0 }, cost: { spent: 0, saved: 0.002, captured: 0, unknownModels: [] }, imported: false },
  calls: [],
  actions: [],
  children: [],
  parent: null,
  source: null,
  fix: null,
  notRecorded: null,
  state: { status: 'failed', kind: 'test', outcome: { kind: 'diverged', callNo: 3 }, failed: true, interrupted: false, label: 'test' },
  fixedBy: PASSED,
} as unknown as RunDetail;

/** A capture its import judged failed by the rules on calls: the index's state counts no failure of its own. */
const judgedCapture = {
  run: { runId: CAPTURE, parentRunId: null, mode: 'record', status: 'completed', divergence: null, command: { argv: ['shadowlap', 'import', 'incident.jsonl'], cwd: '.' }, codeVersion: null, startedAt: 1, endedAt: 2, meta: { labels: [] } },
  summary: { upstreamRequests: 0, byKind: { api: 4, tool: 3, clock: 0, random: 0 }, cost: { spent: 0, saved: 0, captured: 0.004, unknownModels: [] }, imported: true },
  calls: [],
  actions: [],
  children: [],
  parent: null,
  source: { file: 'incident.jsonl' },
  fix: null,
  notRecorded: null,
  state: { status: 'completed', kind: 'capture', outcome: { kind: 'none' }, failed: false, interrupted: false, label: 'capture' },
  judged: JUDGED,
} as unknown as RunDetail;

/** The run as Runs lists it: its row's `failed` is the lists' (runs-filter.ts `listFailed`), and a fixed one names the run that passed. */
function rowOf(d: RunDetail, o: { failed: boolean; fixedBy?: string }): RunListItem {
  const like = runLikeOf(d);
  return { ...like, failed: o.failed, ...(o.fixedBy ? { fixedBy: o.fixedBy } : {}), about: { text: 'refund flow', from: 'user' } } as unknown as RunListItem;
}

/** Words as they read, their no-break spaces as spaces. */
const read = (text: string | null | undefined): string => (text ?? '').replace(/\u00a0/g, ' ');

/** Runs' Status for the row: its words and its class, as the table draws them. */
async function status(row: RunListItem): Promise<{ text: string; className: string }> {
  page = await render(createElement(RunsTable, { rows: [row], picked: new Set<string>(), selectable: false, byColumn: false, sort: 'when', onSort: () => undefined, onPick: () => undefined, onPickAll: () => undefined, now: 60_000 }));
  const st = page.one('table.runst tbody tr .st');
  const out = { text: read(st.textContent), className: st.className };
  await page.unmount();
  page = null;
  return out;
}

/** The run page's own finding, with the run's checks as its page gives them: its section's class and words. */
async function finding(run: RunDetail): Promise<{ className: string; text: string; blame: number }> {
  page = await render(createElement(AppContext.Provider, { value: app }, createElement(Banner, { run, judged: run.judged, blame: null, rescued: null, checks: checksOf(run), offers: null, showDiff: false, onToggleDiff: () => undefined, onSelect: () => undefined, onAction: () => undefined })));
  const section = page.one('#findings > section');
  return { className: section.className, text: read(section.textContent), blame: page.all('#findings button').filter((b) => b.textContent?.includes('Run blame')).length };
}

/** The chips Runs counts a row under, as its picked rows say them (Runs.tsx `pickedRun`). */
const runsChips = (r: RunLike): string[] => RUN_CHIPS.flatMap(([k]) => (k !== 'all' && k !== 'local' && matchesChip(r, k) ? [k] : []));

describe('a test replay its golden passed since, on its page and in Runs', () => {
  it('reads fixed by the run that passed, muted, in Status, the first fact and its finding', async () => {
    const row = rowOf(fixedTest, { failed: false, fixedBy: PASSED });
    expect(await status(row)).toEqual({ text: 'fixed by 01K8RG7A3M', className: 'st mu' });
    expect(outcomeFact(runLikeOf(fixedTest), { tools: 0 })).toMatchObject({ tone: 'mu', words: 'fixed by 01K8RG7A3M' });
    const f = await finding(fixedTest);
    // Muted, no failure: what it diverged on, then fixed by the run that passed, and nothing to mend it.
    expect(f.className).toBe('banner n');
    expect(f.text).toBe('a request changed · fixed by 01K8RG7A3M · POST /v1/messages · 2 calls replayed before it');
    expect(f.blame).toBe(0);
    expect(page!.all('#findings .btn')).toEqual([]);
  });

  it('counts as failed nowhere, and a delete that waits takes it off the chips Runs counts it under', () => {
    const row = rowOf(fixedTest, { failed: false, fixedBy: PASSED });
    expect([isFailed(runLikeOf(fixedTest)), isFailed(row as unknown as RunLike)]).toEqual([false, false]);
    expect(pendingRunOf(fixedTest, null).chips).toEqual(runsChips(row as unknown as RunLike));
    expect(pendingRunOf(fixedTest, null).chips).toEqual(['test']);
  });

  it('says what a test replay failed on a check, then fixed by the run that passed, with no Run blame', async () => {
    const checked = { ...fixedTest, run: { ...fixedTest.run, divergence: null, meta: { ...fixedTest.run.meta, checks: [{ ok: false, status: 'failed', label: 'send_email called 0 times', detail: 'called 1 time' }] } }, state: { ...fixedTest.state!, outcome: { kind: 'check-failed', check: 'send_email called 0 times' } } } as unknown as RunDetail;
    const f = await finding(checked);
    expect(f.className).toBe('banner n');
    expect(f.text).toBe('send_email called 0 times · fixed by 01K8RG7A3M');
    expect(f.blame).toBe(0);
  });
});

describe('a capture its import judged failed, on its page and in Runs', () => {
  it('reads check failed at its call in Status and the first fact, and its finding leads with the check that failed, as a failure', async () => {
    const row = rowOf(judgedCapture, { failed: true });
    expect(await status(row)).toMatchObject({ text: 'check failed at #6' });
    expect(outcomeFact(runLikeOf(judgedCapture), { tools: 0 })).toMatchObject({ tone: 'err', words: 'check failed at', callNo: 6 });
    const f = await finding(judgedCapture);
    expect(f.className).toBe('banner blame');
    expect(f.text).toBe('issue_refund.amount <= get_policy.result.limit, but #6: amount 240 > 100 (#4) · judged when it was imported · not blamed yet');
  });

  it('counts as failed on its page as in Runs, so a delete that waits takes it off Failed too', () => {
    const row = rowOf(judgedCapture, { failed: true });
    expect([isFailed(runLikeOf(judgedCapture)), isFailed(row as unknown as RunLike)]).toEqual([true, true]);
    expect(pendingRunOf(judgedCapture, null).chips).toEqual(runsChips(row as unknown as RunLike));
    expect(pendingRunOf(judgedCapture, null).chips).toEqual(['capture', 'failed']);
  });
});

describe('a test replay whose golden’s checks changed since', () => {
  it('names the checks gone on a line of its own and ends on nothing for them, as the header leads with Run tests', async () => {
    const label = 'issue_refund called 1 time';
    const failing = { ...fixedTest, fixedBy: null, run: { ...fixedTest.run, divergence: null, meta: { ...fixedTest.run.meta, checks: [{ ok: false, status: 'failed', label, detail: 'called 0 times' }] } }, state: { ...fixedTest.state!, outcome: { kind: 'check-failed', check: label } } } as unknown as RunDetail;
    const offers = { blame: { failed: [], from: 'check' } } as unknown as RunOffers;
    const draw = async (run: RunDetail) => {
      page = await render(createElement(AppContext.Provider, { value: app }, createElement(Banner, { run, judged: run.judged, blame: null, rescued: null, checks: checksOf(run), offers, showDiff: false, onToggleDiff: () => undefined, onSelect: () => undefined, onAction: () => undefined })));
      return { lines: page.all('#findings .ckline').map((l) => read(l.textContent)), blame: page.all('#findings button').filter((b) => b.textContent.includes('Run blame')).length };
    };
    expect(await draw(failing)).toEqual({ lines: [], blame: 1 });
    await page!.unmount();
    forgetOpenFindings();
    const next = { key: 'run-tests', label: 'Run tests', golden: 'goldens/refund', gone: [label, 'send_email called 1 time'], sub: 'Its checks changed since this test: the session judges them as they are now' };
    expect(await draw({ ...failing, next } as unknown as RunDetail)).toEqual({ lines: [`checks changed since: ${label}; send_email called 1 time, no longer in shadowlap.config.json · not tested yet`], blame: 0 });
  });
});
