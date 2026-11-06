import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordBlame, recordVerdict, Store, type BlameReport, type VerifyReport } from '@shadowlap/engine';
import { blameReport, EXPECT, makeRun, verifyReport } from '../../engine/test/fix-fixtures.js';
import type { FixAttemptGroups } from '../src/attempt-groups.js';
import { blameEvidence, gateEvidence, methodWords, verifyEvidence } from '../src/evidence.js';
import { fixDetail } from '../src/fixes.js';
import { fixesView } from '../src/fixes-view.js';
import type { Client } from '../ui/api.js';
import { FixPage } from '../ui/fixes/FixPage.js';
import { AppContext, type AppState } from '../ui/state.js';
import { render, type FakeElement, type Rendered } from './ui-render.js';

/**
 * What a verdict's JSON may say beyond its tally shows on a fix's page when it says it: a gate's
 * bound method and the attempts the provider left unavailable, verify's baseline for a run and its
 * margin, blame's range of calls and its error bound. Reports without them read as they always did.
 * And each probe's and each run's attempts are grouped by what each did.
 */

let store: Store;
let r: Rendered | null = null;
beforeEach(() => {
  store = Store.open(':memory:');
});
afterEach(async () => {
  await r?.unmount();
  r = null;
  store.close();
});

const text = (el: FakeElement) => el.textContent.replace(/\s+/g, ' ').trim();
const newRun = (o: Parameters<typeof makeRun>[1] = {}): string => makeRun(store as unknown as Parameters<typeof makeRun>[0], o);

function app(groups: FixAttemptGroups | null = null): AppState {
  const client = {
    fix: (id: string) => Promise.resolve(fixDetail(store, id)),
    fixes: () => Promise.resolve(fixesView(store)),
    attemptGroups: (id: string) => Promise.resolve(groups ?? { fixId: id, blame: null, verify: [], cut: false }),
    jobs: () => Promise.resolve([]),
  } as unknown as Client;
  return { client, exported: false, meta: null, tick: 0, feeds: {}, jobs: [], actionsOff: null, hasKind: () => true, guard: (fn: () => void) => fn(), watchJob: () => undefined, toast: () => undefined } as unknown as AppState;
}

async function open(fixId: string, step: string, groups: FixAttemptGroups | null = null): Promise<Rendered> {
  r = await render(createElement(AppContext.Provider, { value: app(groups) }, createElement(FixPage, { id: fixId, step, sub: null })));
  await r.until('the fix to load', () => r!.all('h1').length === 1);
  return r;
}

/** A fix blamed with the report given, and verified with the verdict given. */
function fix(o: { blame?: (b: BlameReport) => void; verify?: (v: VerifyReport) => void } = {}): { fixId: string; run: string } {
  const run = newRun();
  const report = blameReport(run);
  o.blame?.(report);
  const { fix: f } = recordBlame(store, { runId: run, report, expect: EXPECT, scope: null, command: `shadowlap blame ${run.slice(0, 10)}`, title: 'issue_refund called with amount 240', checkText: 'issue_refund never called with {"amount":240}', at: 1_000 });
  if (o.verify) {
    const good = newRun({ status: 'completed' });
    const v = verifyReport([
      { runId: run, role: 'target', pass: true },
      { runId: good, role: 'good', pass: true },
    ]);
    o.verify(v);
    recordVerdict(store, { report: v, expect: EXPECT, command: 'shadowlap verify', at: 2_000, fixIds: [f.fixId] });
  }
  return { fixId: f.fixId, run };
}

describe('reading what a verdict says beyond its tally', () => {
  it('takes a well-formed field and nothing else', () => {
    expect(gateEvidence({ gate: { bound: { lo: 0.78, confidence: 0.95, method: 'sprt-stagewise' }, unavailable: 2 } })).toEqual({ method: 'exact under the gate’s stopping rule', unavailable: 2 });
    expect(gateEvidence({ bound: { method: 'clopper-pearson' }, unavailable: -1 })).toEqual({ method: 'Clopper–Pearson', unavailable: 0 });
    expect(gateEvidence({})).toEqual({ method: null, unavailable: 0 });
    expect(verifyEvidence({ baseline: { passes: 12, attempts: 12, source: 'paired', revision: 'a7b3c2e' }, margin: 0.1 })).toEqual({ method: null, unavailable: 0, baseline: { passes: 12, attempts: 12, source: 'paired', revision: 'a7b3c2e' }, margin: 0.1, drop: null });
    expect(verifyEvidence({ baseline: { passes: 13, attempts: 12, source: 'paired' }, margin: 3 })).toMatchObject({ baseline: null, margin: null, drop: null });
    // The bound on its drop, as the CLI and a fix's PR say it: the end that bears on its verdict.
    const kept = { baseline: { passes: 38, attempts: 38, source: 'paired' }, margin: 0.1, decision: 'pass', drop: { lo: -0.1, hi: 0.0962, confidence: 0.95, method: 'betting' } };
    expect(verifyEvidence(kept).drop).toBe('drop <= 0.10 (95%)');
    expect(verifyEvidence({ ...kept, decision: 'fail', drop: { lo: 0.123, hi: 0.5, confidence: 0.95, method: 'betting' } }).drop).toBe('drop >= 0.12 (95%)');
    expect(verifyEvidence({ ...kept, decision: 'inconclusive', drop: { lo: -0.04, hi: 0.18, confidence: 0.9, method: 'history' } }).drop).toBe('drop -0.04 to 0.18 (90%)');
    // A pack can carry anything: a bound that isn't one says nothing.
    expect(verifyEvidence({ ...kept, drop: { lo: 'x', hi: 3, confidence: 2 } }).drop).toBeNull();
    expect(verifyEvidence({ drop: kept.drop, decision: 'pass' }).drop).toBeNull();
    expect(verifyEvidence({ baseline: { passes: 47, attempts: 50, source: 'history', revision: '$(rm -rf)' } }).baseline).toEqual({ passes: 47, attempts: 50, source: 'history', revision: null });
    // The bound in the CLI's words needs what they say it rests on: the probes that decided, each with its risk.
    expect(blameEvidence({ range: { from: 3, to: 5 }, errorBound: 0.04 })).toEqual({ range: { from: 3, to: 5 }, errorBound: 0.04, risk: null });
    expect(blameEvidence({ range: { from: 5, to: 3 }, errorBound: 'low' })).toEqual({ range: null, errorBound: null, risk: null });
    const probes = [
      { callNo: 3, rescued: true, risk: 0.0125 },
      { callNo: 5, rescued: false, decision: 'fail', risk: 0.0125 },
    ];
    expect(blameEvidence({ outcome: 'blamed', probes, nonMonotone: [], range: { from: 3, to: 5 }, errorBound: 0.04 }).risk).toBe('<= 4% risk that the range is wrong: 2 probes decided, at <= 1.3% risk each');
    // One with nothing to rest on, or a check of the pinned call that says no risk, prints none.
    expect(blameEvidence({ outcome: 'blamed', probes: [{ callNo: 3, rescued: true }], errorBound: 0.04 }).risk).toBeNull();
    expect(blameEvidence({ outcome: 'blamed', probes, pin: { callNo: 5, next: 7, verdict: 'pinned' }, errorBound: 0.04 }).risk).toBeNull();
    expect(blameEvidence({ outcome: 'blamed', probes, nonMonotone: 'none', errorBound: 0.04 }).risk).toBeNull();
    // Every attempt that passed answered the call as the recording did: the bound is the search's, not
    // the claim that no call rescues the run, and `shadowlap blame` prints no confidence line for it.
    const sameAnswer = { callNo: 3, runId: '01M5GRX8K406H4KHQ7DEKYWTSZ', why: 'Every attempt that passed at #3 answered it as the recording did' };
    expect(blameEvidence({ outcome: 'unrescuable', probes, nonMonotone: [], range: null, errorBound: 0.04, sameAnswer })).toEqual({ range: null, errorBound: 0.04, risk: null });
    expect(methodWords('anytime_valid')).toBe('anytime-valid');
    expect(methodWords('beta-binomial')).toBe('beta binomial');
  });
});

describe('a fix’s page, with what its verdicts say beyond their tallies', () => {
  it('says where blame lost the run when no one call is pinned, its error bound, and a probe’s unavailable attempts', async () => {
    const { fixId } = fix({
      blame: (b) => {
        Object.assign(b, { range: { from: 3, to: 5 }, errorBound: 0.04 });
        for (const p of b.probes) p.risk = 0.0125;
        Object.assign(b.probes[1], { unavailable: 2 });
      },
    });
    const page = await open(fixId, 'blame');
    // The bound as the CLI prints it after the confidence.
    expect(text(page.one('.verdict p'))).toMatch(/· confidence high \(<= 4% risk that the range is wrong: 3 probes decided, at <= 1\.3% risk each\) · lost between #3 and #5/);
    const row = page.all('table.probes tbody tr')[1];
    expect(text(row)).toContain('· 2 unavailable');
  });

  it('shows a run’s baseline and the bound on its drop as the CLI says it, its bound’s method on hover and its unavailable attempts', async () => {
    const { fixId } = fix({
      verify: (v) => {
        const good = v.runs[1];
        Object.assign(good, { baseline: { passes: 12, attempts: 12, source: 'paired', revision: 'a7b3c2e' }, margin: 0.1, decision: 'pass', drop: { lo: -0.2, hi: 0.0962, confidence: 0.95, method: 'betting' }, gate: { decision: 'pass', sentence: 'passed', clean: false, attempts: 4, interval: { lo: 0.51, hi: 1, confidence: 0.95 }, bound: { lo: 0.53, confidence: 0.95, method: 'sprt-stagewise' }, unavailable: 1 } });
        Object.assign(v.runs[0], { baseline: { passes: 40, attempts: 50, source: 'history' }, margin: 0.1 });
      },
    });
    const page = await open(fixId, 'verify');
    const rows = page.all('table.t tbody tr');
    const good = rows.find((x) => text(x).startsWith('good'))!;
    expect(text(good.querySelector('.fxwhere')!)).toContain('baseline 12 of 12, paired at a7b3c2e · drop <= 0.10 (95%)');
    expect(good.querySelector('.fxbase')!.getAttribute('title')).toBe('Kept unless its pass rate drops 10 points or more below its baseline’s');
    expect(text(good)).toContain('· 1 unavailable');
    const bound = good.querySelectorAll('.fxof .fxdim').find((x) => /rate >=/.test(x.textContent))!;
    expect(bound.getAttribute('title')).toBe('the bound: exact under the gate’s stopping rule');
    // A report kept before the bound was: its margin, as it said it.
    const target = rows.find((x) => text(x).startsWith('target'))!;
    expect(text(target.querySelector('.fxwhere')!)).toContain('baseline 40 of 50, from history · margin 0.1');
  });

  it('reads a report without them as it always did', async () => {
    const { fixId } = fix({ verify: () => undefined });
    const page = await open(fixId, 'verify');
    expect(page.all('.fxbase')).toEqual([]);
    expect(page.all('table.t tbody tr').some((x) => /unavailable/.test(x.textContent))).toBe(false);
  });
});

describe('a fix’s attempts grouped by what each did', () => {
  it('groups each probe’s attempts on the Blame step, and each run’s on the Verify step', async () => {
    const { fixId, run } = fix({ verify: () => undefined });
    const detail = fixDetail(store, fixId)!;
    const example = (id: string) => ({ runId: id, href: `#/run/${id}/5` });
    const groups: FixAttemptGroups = {
      fixId,
      blame: {
        blameId: detail.blame!.blameId,
        probes: [
          {
            callNo: 5,
            attempts: 4,
            groups: [
              { path: ['escalate (stubbed)'], verdict: 'passed', count: 2, why: null, example: example('01M3RZ0011AAAAAAAAAAAAAAAA') },
              { path: ['issue_refund (blocked)'], verdict: 'failed', count: 2, why: 'issue_refund called 1 time', example: example('01M3RZ0012AAAAAAAAAAAAAAAA') },
            ],
          },
        ],
      },
      verify: [{ verifyId: detail.verify[0].verifyId, runs: [{ runId: run, role: 'target', attempts: 4, groups: [{ path: [], verdict: 'failed', count: 1, why: 'the agent exited with code 1', example: example('01M3RZ0013AAAAAAAAAAAAAAAA') }, { path: ['escalate (stubbed)'], verdict: 'passed', count: 3, why: null, example: example('01M3RZ0014AAAAAAAAAAAAAAAA') }] }] }],
      cut: false,
    };
    const blamePage = await open(fixId, 'blame', groups);
    // A probe's groups show with its attempts, under its row once it is opened.
    const probe = blamePage.all('table.probes tbody tr').find((x) => text(x).startsWith('#5'))!;
    await blamePage.click(probe.querySelector('button.xbtn')!);
    await blamePage.until('the groups', () => blamePage.all('tr.sub .agroups').length > 0);
    const lines = blamePage.all('.agroups li').map(text);
    expect(lines).toEqual(['2× escalate (stubbed) passed 01M3RZ0011 →', '2× issue_refund (blocked) failed issue_refund called 1 time 01M3RZ0012 →']);
    expect(blamePage.one('.agroups li.failed a').getAttribute('href')).toBe('#/run/01M3RZ0012AAAAAAAAAAAAAAAA/5');
    expect(text(blamePage.one('.agroups .k'))).toBe('what 4 attempts did');
    await blamePage.unmount();
    r = null;
    const verifyPage = await open(fixId, 'verify', groups);
    await verifyPage.until('the groups', () => verifyPage.all('.agroups').length > 0);
    expect(verifyPage.all('.agroups li').map(text)).toEqual(['1× no tool call failed the agent exited with code 1 01M3RZ0013 →', '3× escalate (stubbed) passed 01M3RZ0014 →']);
  });
});
