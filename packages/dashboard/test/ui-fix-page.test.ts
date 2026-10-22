import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { markFixApplied, recordBlame, recordRepair, Store, type BlameReport } from '@shadowlap/engine';
import { blameReport, EXPECT, makeRun, repairReport } from '../../engine/test/fix-fixtures.js';
import { fixDetail } from '../src/fixes.js';
import type { Client } from '../ui/api.js';
import { FixPage } from '../ui/fixes/FixPage.js';
import { AppContext, type AppState } from '../ui/state.js';
import { render, type FakeElement, type Rendered } from './ui-render.js';

/**
 * A fix's page as it renders, from the read model's own answer for a store built here: what its
 * header, its buttons, its dialogs and its steps say. The server is the read model itself, so the
 * page reads what `GET /api/fixes/:id` would send.
 */

let store: Store;
let r: Rendered | null = null;
const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;

beforeEach(() => {
  store = Store.open(':memory:');
});
afterEach(async () => {
  await r?.unmount();
  r = null;
  store.close();
});

/** The app as the shell gives it, its server answering from the store; `inTree` stands for git saying a patch is in the working tree. */
function app(o: { inTree?: boolean } = {}): AppState {
  const client = {
    fix: (id: string) => Promise.resolve(fixDetail(store, id, o.inTree ? { patchInTree: () => true } : {})),
    jobs: () => Promise.resolve([]),
    startJob: () => new Promise(() => undefined),
  } as unknown as Client;
  return {
    client,
    exported: false,
    meta: null,
    tick: 0,
    feeds: {},
    jobs: [],
    actionsOff: null,
    hasKind: () => true,
    guard: (fn: () => void) => fn(),
    watchJob: () => undefined,
    toast: () => undefined,
    registerLayer: () => () => undefined,
  } as unknown as AppState;
}

/** The fix's page, opened at a step, once it has loaded. */
async function open(fixId: string, step: string | null = null, sub: string | null = null, o: { inTree?: boolean } = {}): Promise<Rendered> {
  r = await render(createElement(AppContext.Provider, { value: app(o) }, createElement(FixPage, { id: fixId, step, sub })));
  await r.until('the fix to load', () => r!.all('h1').length === 1);
  return r;
}

const text = (el: FakeElement) => el.textContent.replace(/\s+/g, ' ').trim();

/**
 * A run as the fixtures make it, in this store. This file is type-checked with the browser code,
 * which reads the engine as it is built, while the fixtures read its sources: one store either way.
 */
const newRun = (o: Parameters<typeof makeRun>[1] = {}): string => makeRun(store as unknown as Parameters<typeof makeRun>[0], o);

function blame(runId: string, o: { report?: BlameReport; expect?: unknown; title?: string } = {}) {
  return recordBlame(store, { runId, report: o.report ?? blameReport(runId), expect: o.expect === undefined ? EXPECT : o.expect, scope: null, command: `shadowlap blame ${runId.slice(0, 10)}`, title: o.title ?? 'issue_refund called with amount 240', checkText: 'issue_refund never called with {"amount":240}', at: NOW });
}

describe('the Repair step', () => {
  it('heads an accepted repair with when and by whom, and says what every stage cost in a grey line above its command', async () => {
    const run = newRun({ labels: ['refund-bug'] });
    const { fix } = blame(run);
    recordRepair(store, { repairId: 'repair-munzln2i', dir: '.shadowlap/repairs/repair-munzln2i', report: repairReport({ targets: [run] }), expect: EXPECT, command: 'shadowlap repair --fixes label:refund-bug', at: NOW + 1 });
    await open(fix.fixId, 'repair');
    const head = text(r!.one('.sh p'));
    expect(head).toMatch(/^Accepted [A-Z][a-z]{2} \d+, \d\d:\d\d · proposed by claude-code \(answered by claude-opus-5-5\)$/);
    // The accepted candidate's verify alone is no cost of the repair's.
    expect(head).not.toMatch(/attempts|\$/);
    // Both candidates it verified: the one it dropped and the one it accepted.
    expect(text(r!.one('.fxreceipt'))).toBe('cost: blame ≈$0.100 · repairer ≈$0.0040 · verify ≈$0.072');
  });

  it('heads a repair that accepted nothing with when it ran, never as repaired', async () => {
    const run = newRun({ labels: ['refund-bug'] });
    const { fix } = blame(run);
    recordRepair(store, { repairId: 'repair-nothing', dir: '.shadowlap/repairs/repair-nothing', report: repairReport({ targets: [run], accepted: false }), expect: EXPECT, command: 'shadowlap repair --fixes label:refund-bug', at: NOW + 1 });
    await open(fix.fixId, 'repair');
    expect(text(r!.one('.sh p'))).toMatch(/^Ran [A-Z][a-z]{2} \d+, \d\d:\d\d · proposed by claude-code \(answered by claude-opus-5-5\) · 1 candidate tried, none accepted/);
    expect(text(r!.one('.fxreceipt'))).toBe('cost: blame ≈$0.100 · repairer ≈$0.0040 · verify ≈$0.024');
  });
});

describe('Repair from here', () => {
  it('says a repair that would reuse blames that rescued no run ends with no fix to try, and bills nothing', async () => {
    const run = newRun({ labels: ['digest'] });
    const report = blameReport(run, 'unrescuable');
    store.updateRunMeta(run, { blame: { at: NOW, outcome: 'unrescuable', callNo: null, confidence: 'high', rescuedRunId: null, fields: {}, oracle: report.oracle, probes: [], spent: 0 } });
    const { fix } = blame(run, { report });
    await open(fix.fixId);
    const button = r!.byText('.ph .actions button', 'Repair from here');
    // Still there, but no longer the lead, with why on hover.
    expect(button.className).toBe('btn');
    expect(button.props.title).toBe('No failing run was rescued, so there is no passing path to learn from: the repair ends “No fix to try”.');
    await r!.click(button);
    await r!.until('the dialog to read the fix again', () => r!.all('.dialog .fxdlg').length > 0);
    const notes = r!.all('.dialog .fxdlg').map(text);
    expect(notes).toEqual(['No failing run was rescued, so there is no passing path to learn from: the repair ends “No fix to try”.']);
  });

  it('says the agent runs live and is billed when the repair has a passing path to learn from', async () => {
    const run = newRun({ labels: ['refund-bug'] });
    const { fix } = blame(run);
    await open(fix.fixId);
    const button = r!.byText('.ph .actions button', 'Repair from here');
    expect(button.className).toBe('btn lime');
    await r!.click(button);
    await r!.until('the dialog to read the fix again', () => r!.all('.dialog .fxdlg').length > 0);
    expect(r!.all('.dialog .fxdlg').map(text)).toEqual(['The agent runs live from where each run was lost, writes stubbed: its model calls are billed. Leave those files alone until it is done.']);
  });
});

describe('Apply the patch', () => {
  /** A verified fix, its repair's patch not applied yet. */
  function verified(): string {
    const run = newRun({ labels: ['refund-bug'] });
    const { fix } = blame(run);
    recordRepair(store, { repairId: 'repair-munzln2i', dir: '.shadowlap/repairs/repair-munzln2i', report: repairReport({ targets: [run] }), expect: EXPECT, command: 'shadowlap repair --fixes label:refund-bug', at: NOW + 1 });
    return fix.fixId;
  }
  const buttons = () => r!.all('.ph .actions button').map(text);

  it('offers Mark applied for a patch already in the working tree, saying what applying still does, and no git apply to copy', async () => {
    await open(verified(), null, null, { inTree: true });
    expect(buttons()).toEqual(['Mark applied']);
    await r!.click(r!.byText('.ph .actions button', 'Mark applied'));
    expect(text(r!.one('.dialog h3'))).toBe('Mark this fix applied?');
    expect(text(r!.one('.dialog header p'))).toBe('The patch is already in your working tree: this copies the goldens it is missing into goldens/, runs them with shadowlap test and marks the fix applied.');
  });

  it('offers the patch and git apply to copy while the patch is still to apply', async () => {
    await open(verified());
    expect(buttons()).toEqual(['Copy git apply', 'Apply the patch']);
  });

  it('offers the patch to read on an applied fix, never a git apply that would fail', async () => {
    const fixId = verified();
    markFixApplied(store, fixId, { patch: 'applied', repairId: 'repair-munzln2i', goldens: ['goldens/01M3RZ0001'], tests: 'passed', via: 'fix apply' });
    await open(fixId);
    expect(buttons()).toEqual(['View the patch', 'Patch applied']);
    await r!.click(r!.byText('.ph .actions button', 'View the patch'));
    expect(text(r!.one('.dialog h3'))).toBe('fix.patch');
    expect(text(r!.one('.dialog header p'))).toBe('In your working tree since the fix was applied: .shadowlap/repairs/repair-munzln2i/fix.patch');
    expect(text(r!.one('.dialog pre.fxpatch'))).toContain('+You are a support agent. Follow the refund policy: escalate every refund above the limit it sets.');
    // To read only: Close, and nothing to run.
    expect(r!.all('.dialog footer button').map(text)).toEqual(['Close']);
  });
});
