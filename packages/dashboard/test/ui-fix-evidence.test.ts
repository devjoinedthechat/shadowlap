import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordBlame, recordVerdict, Store, type BlameReport, type VerifyReport } from '@shadowlap/engine';
import { blameReport, EXPECT, makeRun, verifyReport } from '../../engine/test/fix-fixtures.js';
import type { FixAttemptGroups } from '../src/attempt-groups.js';
import { blameEvidence, gateEvidence, methodWords, verifyEvidence } from '../src/evidence.js';
import { fixDetail, fixList } from '../src/fixes.js';
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
    fixes: () => Promise.resolve(fixList(store)),
    attemptGroups: (id: string) => Promise.resolve(groups ?? { fixId: id, blame: null, verify: [], cut: false }),
    jobs: () => Promise.resolve([]),
  } as unknown as Client;
  return { client, exported: false, meta: null, tick: 0, feeds: {}, jobs: [], actionsOff: null, hasKind: () => true, guard: (fn: () => void) => fn(), watchJob: () => undefined, toast: () => undefined, registerLayer: () => () => undefined } as unknown as AppState;
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
    expect(verifyEvidence({ baseline: { passes: 12, attempts: 12, source: 'paired', revision: 'a7b3c2e' }, margin: 0.1 })).toEqual({ method: null, unavailable: 0, baseline: { passes: 12, attempts: 12, source: 'paired', revision: 'a7b3c2e' }, margin: 0.1 });
    expect(verifyEvidence({ baseline: { passes: 13, attempts: 12, source: 'paired' }, margin: 3 })).toMatchObject({ baseline: null, margin: null });
    expect(verifyEvidence({ baseline: { passes: 47, attempts: 50, source: 'history', revision: '$(rm -rf)' } }).baseline).toEqual({ passes: 47, attempts: 50, source: 'history', revision: null });
    expect(blameEvidence({ range: { from: 3, to: 5 }, errorBound: 0.04 })).toEqual({ range: { from: 3, to: 5 }, errorBound: 0.04 });
    expect(blameEvidence({ range: { from: 5, to: 3 }, errorBound: 'low' })).toEqual({ range: null, errorBound: null });
    expect(methodWords('anytime_valid')).toBe('anytime-valid');
    expect(methodWords('beta-binomial')).toBe('beta binomial');
  });
});

describe('a fix’s page, with what its verdicts say beyond their tallies', () => {
  it('says where blame lost the run when no one call is pinned, its error bound, and a probe’s unavailable attempts', async () => {
    const { fixId } = fix({
      blame: (b) => {
        Object.assign(b, { range: { from: 3, to: 5 }, errorBound: 0.04 });
        Object.assign(b.probes[1]!, { unavailable: 2 });
      },
    });
    const page = await open(fixId, 'blame');
    expect(text(page.one('.sh p'))).toMatch(/· confidence high \(error ≤ 0\.04\) · lost between #3 and #5/);
    const row = page.all('table.probes tbody tr')[1]!;
    expect(text(row)).toContain('· 2 unavailable');
  });

  it('shows a run’s baseline and margin, its bound’s method on hover and its unavailable attempts', async () => {
    const { fixId } = fix({
      verify: (v) => {
        const good = v.runs[1]!;
        Object.assign(good, { baseline: { passes: 12, attempts: 12, source: 'paired', revision: 'a7b3c2e' }, margin: 0.1, gate: { decision: 'pass', sentence: 'passed', clean: false, attempts: 4, interval: { lo: 0.51, hi: 1, confidence: 0.95 }, bound: { lo: 0.53, confidence: 0.95, method: 'sprt-stagewise' }, unavailable: 1 } });
        Object.assign(v.runs[0]!, { baseline: { passes: 40, attempts: 50, source: 'history' } });
      },
    });
    const page = await open(fixId, 'verify');
    const rows = page.all('table.t tbody tr');
    const good = rows.find((x) => text(x).startsWith('good'))!;
    expect(text(good.querySelector('.fxwhere')!)).toContain('baseline 12 of 12, paired at a7b3c2e · margin 0.1');
    expect(text(good)).toContain('· 1 unavailable');
    const bound = good.querySelectorAll('.fxof .fxdim').find((x) => /rate >=/.test(x.textContent))!;
    expect(bound.getAttribute('title')).toBe('the bound: exact under the gate’s stopping rule');
    const target = rows.find((x) => text(x).startsWith('target'))!;
    expect(text(target.querySelector('.fxwhere')!)).toContain('baseline 40 of 50, from history');
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
      verify: [{ verifyId: detail.verify[0]!.verifyId, runs: [{ runId: run, role: 'target', attempts: 4, groups: [{ path: [], verdict: 'failed', count: 1, why: 'the agent exited with code 1', example: example('01M3RZ0013AAAAAAAAAAAAAAAA') }, { path: ['escalate (stubbed)'], verdict: 'passed', count: 3, why: null, example: example('01M3RZ0014AAAAAAAAAAAAAAAA') }] }] }],
      cut: false,
    };
    const blamePage = await open(fixId, 'blame', groups);
    await blamePage.until('the groups', () => blamePage.all('.agroups').length > 0);
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
