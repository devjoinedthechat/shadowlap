import { createElement, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Client } from '../ui/api.js';
import { shortId } from '../ui/format.js';
import type { Origin7 } from '../ui/origins.js';
import { useCallList } from '../ui/run/call-list.js';
import type { Paging } from '../ui/run/paged-run.js';
import { isPending } from '../ui/run/paging.js';
import { ScopeBar } from '../ui/run/parts.js';
import { RunHeader } from '../ui/run/RunHeader.js';
import { judgeForkWait } from '../ui/scopes.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { CallRow, RunDetail } from '../ui/types.js';
import { render, type Rendered } from './ui-render.js';

/**
 * A judge's calls on a run's page (ui/scopes.ts, run/call-list.ts, run/parts.tsx, run/RunHeader.tsx),
 * as the design has them: out of All, its views, the key's and the tabs' counts and the strip, a long
 * run's not read yet too, until the judge's chip is picked, which follows the agents' after a
 * hairline, `Agent` first where the run names no agents of its own; a judge's call picked (its
 * finding's #n, a link) picks the chip, under which the views are the judge's and the strip adds its
 * calls, dimming the rest, while Context and Timeline stay the agent's; and the head's Fork at a
 * judge's call reads Fork, waits and says why, as `f` does.
 */

const RUN = '01K8RG00000000000000000042';
const JUDGE = 'shadowlap:judge';

let page: Rendered | null = null;
afterEach(async () => {
  await page?.unmount();
  page = null;
});

const call = (callNo: number, kind: 'api' | 'tool', o: Partial<CallRow> = {}): CallRow =>
  ({ callNo, kind, name: kind === 'api' ? 'POST /v1/messages' : 'issue_refund', origin: 'live', effect: kind === 'tool' ? 'write' : null, outcome: 'ok', status: null, latencyMs: 5, model: null, stopReason: null, usage: null, cost: null, bytes: null, detail: '', attempts: 0, replayedFrom: null, error: null, startedAt: callNo, endedAt: callNo + 1, ttftMs: null, scope: null, agent: 'support-agent', ...o }) as unknown as CallRow;
const judgeCall = (callNo: number): CallRow => call(callNo, 'api', { scope: JUDGE, agent: JUDGE, reserved: true, judge: { check: 'explains-refund', verdict: 'yes' } });
/** The judge's call third, before the agent's last: never assumed to come last. */
const CALLS = [call(1, 'api'), call(2, 'tool'), judgeCall(3), call(4, 'api')];
const nos = (cs: ReadonlyArray<{ callNo: number }>) => cs.map((c) => c.callNo);

let got: ReturnType<typeof useCallList> | null = null;
/** The call list as the run page holds it, its selection moved to call `to` by its button. */
function List({ calls, paging, to }: { calls: CallRow[]; paging: Paging | null; to: number }) {
  const [selected, setSelected] = useState<number | null>(null);
  got = useCallList({ runId: RUN, calls, paging, selected, byKind: false, live: false, spend: true });
  return createElement('button', { type: 'button', onClick: () => setSelected(to) });
}

describe('a judge’s calls in the run’s lists', () => {
  it('stay out of All, its views, the counts and the strip, until a judge’s call picked picks their chip, where Context and Timeline stay the agent’s', async () => {
    page = await render(createElement(List, { calls: CALLS, paging: null, to: 3 }));
    let l = got!;
    expect([l.scope, l.bar, l.scoped, l.scopeTree, [...l.judge]]).toEqual(['all', true, false, [], [3]]);
    expect([nos(l.visible), nos(l.scopedCalls), l.tabCounts, l.counts.total]).toEqual([[1, 2, 4], [1, 2, 4], { calls: 3, turns: 2 }, 3]);
    expect([l.strip.calls.map((c) => c.n), l.strip.inScope]).toEqual([[1, 2, 4], null]);
    await page.click(page.one('button'));
    l = got!;
    expect([l.scope, l.judgeOn, nos(l.visible), l.tabCounts, nos(l.ownCalls)]).toEqual([JUDGE, true, [3], { calls: 1, turns: 1 }, [1, 2, 4]]);
    // The strip adds the judge's calls and dims the agent's.
    expect([l.strip.calls.map((c) => c.n), [1, 3].map((n) => l.strip.inScope?.(n))]).toEqual([[1, 2, 3, 4], [false, true]]);
    // All picked again holds, the judge's call still selected.
    await page.click(page.one('button'));
    l.setScope('all');
    await page.wait(0);
    expect([got!.scope, nos(got!.visible)]).toEqual(['all', [1, 2, 4]]);
    // Picked again, though selected already (its finding's #n pressed again: the page's select), it picks the chip again.
    got!.pickScope(3);
    await page.wait(0);
    expect([got!.scope, nos(got!.visible)]).toEqual([JUDGE, [3]]);
    // An agent's call picked leaves the scope as it is.
    got!.setScope('all');
    await page.wait(0);
    got!.pickScope(4);
    await page.wait(0);
    expect(got!.scope).toBe('all');
  });

  it('leave a long run’s All by the server’s numbers before their pages come: its placeholders, the key’s counts and the tabs’', async () => {
    const origins: Origin7[] = ['live', 'live', 'live', 'live', 'live'];
    const paging: Paging = { total: 5, read: 2, origins, kinds: null, judge: [4], need: () => undefined, error: null, gone: false };
    page = await render(createElement(List, { calls: CALLS.slice(0, 2), paging, to: 4 }));
    const l = got!;
    expect([nos(l.visible), l.visible.filter(isPending).map((c) => c.callNo), l.counts.total, l.tabCounts.calls]).toEqual([[1, 2, 3, 5], [3, 5], 4, 4]);
    expect(l.strip.calls.map((c) => c.n)).toEqual([1, 2, 3, 5]);
    // A link to the judge's call not read yet opens under its chip.
    await page.click(page.one('button'));
    expect([got!.scope, got!.strip.calls.map((c) => c.n), got!.strip.inScope?.(4)]).toEqual([JUDGE, [1, 2, 3, 4, 5], true]);
  });
});

const run = (calls: CallRow[]): RunDetail =>
  ({
    run: { runId: RUN, parentRunId: null, mode: 'record', status: 'completed', divergence: null, command: { argv: ['node', 'agent.mjs'], cwd: '.' }, codeVersion: 'f6c5756', startedAt: 1, endedAt: 2, meta: { labels: [] } },
    summary: { upstreamRequests: 2, byKind: { api: 2, tool: 1, clock: 0, random: 0 }, cost: { spent: 0.001, saved: 0, captured: 0, unknownModels: [] }, imported: false },
    calls,
    actions: [{ key: 'r', label: 'Replay' }],
    children: [],
    parent: null,
    source: null,
    fix: null,
    blame: null,
    state: null,
  }) as unknown as RunDetail;

describe('the agents’ bar of a judged run', () => {
  const bar = async (calls: CallRow[], scopes: string[]) => {
    page = await render(createElement(ScopeBar, { run: run(calls), scopes, scope: 'all', judge: 1, onScope: () => undefined }));
    return page;
  };

  it('leads with Agent where the run names no agents of its own, then the judge’s chip after a hairline, and says what its calls count towards', async () => {
    const p = await bar(CALLS, []);
    expect(p.one('.chips').children.map((el) => (el.tagName.toLowerCase() === 'span' ? el.className : el.textContent))).toEqual(['Agent3', 'jsep', 'judge1']);
    expect(p.one('.chips .jsep').getAttribute('aria-hidden')).toBe('true');
    const chip = p.byText('.chips button', 'judge1');
    expect([chip.getAttribute('title'), chip.getAttribute('aria-pressed')]).toEqual(['shadowlap:judge: the judge’s calls, kept apart from the agent’s', 'false']);
    expect(p.one('.shint').textContent).toBe('A judge’s calls are the check’s: no count, budget or cost of the agent’s includes them');
  });

  it('leads with All beside the run’s own scopes, and gives blame’s hint, never the judge’s scope', async () => {
    const scoped = CALLS.map((c) => (c.scope === JUDGE ? c : { ...c, scope: 'agent', agent: 'agent' }));
    const p = await bar(scoped, ['agent']);
    expect(p.all('.chips button').map((b) => b.textContent)).toEqual(['All3', 'agent3', 'judge1']);
    expect(p.one('.shint').textContent).toBe(`Blame within one scope: shadowlap blame ${shortId(RUN)} --scope agent`);
  });
});

describe('the head’s Fork at a judge’s call', () => {
  it('reads Fork, waits and says why on its card and on a press, as f does', async () => {
    const said: string[] = [];
    const client = { jobs: () => Promise.resolve([]) } as unknown as Client;
    const app = { client, exported: false, meta: null, tick: 0, runsTick: 0, feeds: {}, jobs: [], live: [], runs: [], actionsOff: null, hasKind: () => true, guard: (fn: () => void) => fn(), watchJob: () => undefined, refresh: () => undefined, toast: (text: string) => void said.push(text) } as unknown as AppState;
    const head = (selected: number) =>
      createElement(AppContext.Provider, { value: app }, createElement(RunHeader, { run: run(CALLS), call: null, selected, forkWait: judgeForkWait(CALLS[selected - 1]), rescued: false, offers: null, forkMenu: { open: false, anchor: null, toggle: () => undefined, close: () => undefined } as never, onAction: () => undefined, onFindCommit: () => undefined, labels: [], setLabels: () => undefined }));
    page = await render(head(3));
    const fork = page.one('#forkBtn');
    expect([fork.textContent, fork.getAttribute('aria-disabled'), fork.getAttribute('data-why')]).toEqual(['Fork', 'true', 'A judge’s call can’t be forked']);
    expect(JSON.parse(fork.getAttribute('data-tip')!)).toMatchObject({ t: 'Fork', s: 'A judge’s call is the check’s, not the agent’s: no fork starts at it' });
    await page.click(fork);
    expect(said).toEqual(['A judge’s call can’t be forked']);
    await page.unmount();
    // At the agent's call, the fork at it, as ever.
    page = await render(head(4));
    expect([page.one('#forkBtn').textContent, page.one('#forkBtn').getAttribute('aria-disabled')]).toEqual(['Fork at #4', null]);
  });
});
