import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { JudgeOutcome } from '@shadowlap/engine';
import type { Client } from '../ui/api.js';
import { judgeVerdicts, judgeWhy } from '../ui/run/banner.js';
import { runFindings } from '../ui/run/findings.js';
import { Banner, forgetOpenFindings } from '../ui/run/FindingsBar.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { CheckView, RunDetail } from '../ui/types.js';
import { render, type Rendered } from './ui-render.js';

/**
 * A run's judge verdicts on its page (ui/run/banner.ts, findings.ts, FindingsBar.tsx): each a finding
 * of its own, never tinted, with its call, the check as the CLI labels it, its reason and where it
 * came from in the engine's words; none where the run's checks finding lists its checks, where a
 * judge's line carries the same, and a check that didn't apply its values on hover.
 */

const RUN = '01K8RG00000000000000000009';
const JUDGE = 'judge "explains-escalation" answers yes';
const judge = (o: Partial<JudgeOutcome> = {}): JudgeOutcome => ({ name: 'explains-escalation', model: 'claude-haiku-4-5', of: 'answer', verdict: 'yes', source: 'live', cost: 0.0004, redactions: 0, cut: 0, callNo: 15, ...o });
const passedJudge: CheckView = { label: JUDGE, ok: true, status: 'passed', reason: 'The reply names the escalation', source: 'live', judge: judge() };
const failedJudge: CheckView = { label: JUDGE, ok: false, status: 'failed', detail: 'the judge answered no', reason: 'It never says who handles it', source: 'live', judge: judge({ verdict: 'no', callNo: 16 }) };
const refund: CheckView = { label: 'issue_refund called 1 time', ok: false, status: 'failed', detail: 'called 0 times' };

function runOf(failed: boolean): RunDetail {
  return {
    run: { runId: RUN, parentRunId: null, mode: 'record', status: failed ? 'failed' : 'completed', divergence: null, command: { argv: ['node', 'agent.mjs'], cwd: '.' }, codeVersion: null, startedAt: 1, endedAt: 2, meta: { labels: [] } },
    summary: { upstreamRequests: 2, byKind: { api: 3, tool: 2, clock: 0, random: 0 }, cost: { spent: 0.01, saved: 0, captured: 0, unknownModels: [] }, imported: false },
    calls: [],
    actions: [],
    children: [],
    parent: null,
    source: null,
    fix: null,
    notRecorded: null,
    state: failed ? { status: 'failed', kind: 'record', outcome: { kind: 'check-failed', check: refund.label }, failed: true, interrupted: false, label: 'record' } : { status: 'completed', kind: 'record', outcome: { kind: 'none' }, failed: false, interrupted: false, label: 'record' },
  } as unknown as RunDetail;
}

const app = { client: { jobs: () => Promise.resolve([]) } as unknown as Client, exported: false, actionsOff: null, runs: [], jobs: [], live: [], feeds: {}, toast: () => undefined, guard: (fn: () => void) => fn(), watchJob: () => undefined, hasKind: () => true } as unknown as AppState;

let page: Rendered | null = null;
afterEach(async () => {
  await page?.unmount();
  page = null;
  forgetOpenFindings();
});

async function findings(run: RunDetail, checks: CheckView[], selected: number[] = []) {
  page = await render(createElement(AppContext.Provider, { value: app }, createElement(Banner, { run, judged: null, blame: null, rescued: null, checks, offers: null, showDiff: false, onToggleDiff: () => undefined, onSelect: (n: number) => selected.push(n), onAction: () => undefined })));
  return page;
}

const text = (s: string | null | undefined) => (s ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

describe('a judge’s verdict on a run', () => {
  it('says where it came from after its reason in the engine’s words, its cost as the CLI prints it', () => {
    expect(judgeWhy(passedJudge)).toBe('The reply names the escalation · judged live · <$0.001');
    expect(judgeWhy({ ...passedJudge, judge: judge({ source: 'recording', cost: 0 }) })).toBe('The reply names the escalation · judged from the recording · free');
    expect(judgeWhy({ ...passedJudge, judge: judge({ cost: 0.0042, redactions: 1 }) })).toBe('The reply names the escalation · judged live · ≈$0.0042 · read with 1 redaction rule applied');
    expect(judgeWhy({ ...passedJudge, judge: judge({ cost: null }) })).toBe('The reply names the escalation · judged live · no price for claude-haiku-4-5');
    expect(judgeWhy(refund)).toBeNull();
  });

  it('is one finding a verdict, weighing nothing, after the run’s own, and none for a judge that gave none or where the checks finding lists it', () => {
    const notJudged: CheckView = { label: JUDGE, ok: false, status: 'inconclusive', detail: 'not judged: no recorded verdict', judge: judge({ verdict: null, source: null, cost: null }) };
    const verdicts = judgeVerdicts([refund, passedJudge, failedJudge, notJudged]);
    expect(verdicts).toEqual([
      { callNo: 15, passed: true, line: JUDGE, why: 'The reply names the escalation · judged live · <$0.001' },
      { callNo: 16, passed: false, line: `${JUDGE}: the judge answered no`, why: 'It never says who handles it · judged live · <$0.001' },
    ]);
    const own = { kind: 'failed' as const, label: 'failed', lead: null, why: 'issue_refund called 1 time', fix: null, blamed: false };
    const found = runFindings({ own: own as never, judges: verdicts, differences: null, notRecorded: null, notes: [] });
    expect(found.map((f) => [f.key, f.kind, f.sev, f.says])).toEqual([
      ['own', 'failed', 2, 'failed'],
      ['judge:0', 'judge', 0, 'verdict'],
      ['judge:1', 'judge', 0, 'verdict'],
    ]);
    expect(runFindings({ own: { kind: 'checks', checks: [], why: null }, judges: verdicts, differences: null, notRecorded: null, notes: [] }).map((f) => f.kind)).toEqual(['checks']);
  });

  it('draws each verdict untinted, as the design does: verdict, its call, which selects it, ✓ or ✗ and the check, then its reason and source', async () => {
    const selected: number[] = [];
    const p = await findings(runOf(true), [refund, passedJudge, failedJudge], selected);
    const jv = p.all('#findings > section.jv');
    expect(jv.map((s) => s.className)).toEqual(['banner jv fx', 'banner jv fx']);
    expect(jv.map((s) => text(s.textContent))).toEqual([`verdict#15✓ ${JUDGE}The reply names the escalation · judged live · <$0.001`, `verdict#16✗ ${JUDGE}: the judge answered noIt never says who handles it · judged live · <$0.001`]);
    // The call comes right after the finding's label, before the check.
    expect(jv.map((s) => s.children.map((c) => c.className.split(' ')[0]))).toEqual([['bk', 'bn', 'jvw', 'why'], ['bk', 'bn', 'jvw', 'why']]);
    expect(jv.map((s) => s.querySelectorAll('.jvw b')[0].className)).toEqual(['ok', 'no']);
    const call = jv[0].querySelectorAll('button.bn')[0];
    expect(JSON.parse(call.getAttribute('data-tip')!)).toMatchObject({ t: 'Open the judge’s call' });
    await p.click(call);
    expect(selected).toEqual([15]);
  });

  it('is a line of the checks finding where every check passed: the check, its call and why; a check that didn’t apply has its values on hover', async () => {
    const na: CheckView = { label: 'when refund_amount > 100 then escalate called 1 time', ok: true, status: 'not-applicable', detail: 'the condition never held: refund_amount was 40, 60' };
    const p = await findings(runOf(false), [passedJudge, na]);
    expect(p.all('#findings > section.jv')).toEqual([]);
    const [line, notApplied] = p.all('#findings > section.ck .st');
    expect([line.className, text(line.textContent)]).toEqual(['st ok jvc', `${JUDGE}#15The reply names the escalation · judged live · <$0.001`]);
    expect([notApplied.className, text(notApplied.textContent), JSON.parse(notApplied.getAttribute('data-tip')!)]).toEqual(['st n', `${na.label} · not applicable · the condition never held`, expect.objectContaining({ t: 'refund_amount was 40, 60' })]);
  });
});
