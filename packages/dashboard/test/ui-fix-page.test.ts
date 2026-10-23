import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decideVerify, markFixApplied, recordBlame, recordEvent, recordRepair, recordVerdict, setFixTitle, Store, type BlameReport } from '@shadowlap/engine';
import { blameReport, EXPECT, makeRun, repairReport, verifyReport } from '../../engine/test/fix-fixtures.js';
import { fixAttemptGroups } from '../src/attempt-groups.js';
import { fixDetail, fixList } from '../src/fixes.js';
import type { Client } from '../ui/api.js';
import { FixPage } from '../ui/fixes/FixPage.js';
import { FixesPage } from '../ui/pages/Fixes.js';
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
function app(o: { inTree?: boolean; started?: Array<[string, unknown]>; problem?: string } = {}): AppState {
  const client = {
    fix: (id: string) => Promise.resolve(fixDetail(store, id, { ...(o.inTree ? { patchInTree: () => true } : {}), ...(o.problem ? { checkRepairer: () => o.problem! } : {}) })),
    fixes: () => Promise.resolve(fixList(store)),
    attemptGroups: (id: string) => Promise.resolve(fixAttemptGroups(store, id)),
    jobs: () => Promise.resolve([]),
    startJob: (kind: string, fields: unknown) => {
      o.started?.push([kind, fields]);
      return new Promise(() => undefined);
    },
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
async function open(fixId: string, step: string | null = null, sub: string | null = null, o: { inTree?: boolean; started?: Array<[string, unknown]>; problem?: string } = {}): Promise<Rendered> {
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

describe('what failed', () => {
  /** A fix blame opened, titled by how its run failed, as the CLI keeps its opening; renamed when `rename` says. */
  function opened(rename?: string): string {
    const run = newRun({ labels: ['refund-bug'] });
    const { fix } = blame(run);
    recordEvent(store, { kind: 'blame.done', runId: run, ref: fix.fixId, data: { outcome: 'blamed', callNo: 5, confidence: 'high', title: fix.title, opened: true } });
    if (rename) setFixTitle(store, fix.fixId, rename);
    return fix.fixId;
  }

  it('heads a fix with what its runs must do, and what they did once its title no longer says it', async () => {
    const fixId = opened();
    await open(fixId);
    // Titled by the failure: the line keeps the check alone, labelled.
    expect(text(r!.one('h1'))).toBe('issue_refund called with amount 240');
    expect(text(r!.one('.ph p.chk'))).toBe('Must: issue_refund never called with {"amount":240}');
    await r!.unmount();
    setFixTitle(store, fixId, 'Refunds above the limit issued without approval');
    await open(fixId);
    expect(r!.all('.ph p.chk .fmu').map(text)).toEqual(['Failed: issue_refund called with amount 240', 'Must: issue_refund never called with {"amount":240}']);
    expect(text(r!.one('.ph p.chk'))).toBe('Failed: issue_refund called with amount 240 · Must: issue_refund never called with {"amount":240}');
  });

  it('says it on each row of the list, after how many runs failed', async () => {
    opened('Refunds above the limit issued without approval');
    r = await render(createElement(AppContext.Provider, { value: app() }, createElement(FixesPage, { id: null, step: null, sub: null })));
    await r.until('the list to load', () => r!.all('.pslist a').length === 1);
    expect(text(r.one('.pslist .rs .nw'))).toBe('1 failing run');
    // The check no longer follows the count unlabelled, as if it were the failure.
    expect(text(r.one('.pslist .rs'))).not.toContain('never called');
    expect(r.all('.pslist .fm .fmu').map(text)).toEqual(['Failed: issue_refund called with amount 240', 'Must: issue_refund never called with {"amount":240}']);
  });
});

describe('the Blame step', () => {
  const panels = () => r!.all('section.panel header h2').map(text);

  it('titles the row of calls by where the run was lost only when blame named the call', async () => {
    const lost = newRun({ labels: ['refund-bug'], calls: ['api', 'tool', 'api', 'tool', 'api'] });
    await open(blame(lost).fix.fixId, 'blame');
    expect(panels()[0]).toBe('Where the run was lost');
    await r!.unmount();
    // No answer of the model's rescued it: no call lost it, so its row is the run's calls, never where it was lost.
    const none = newRun({ labels: ['digest'], calls: ['api', 'tool', 'api'] });
    await open(blame(none, { report: blameReport(none, 'unrescuable'), expect: null, title: 'The agent exited with code 1' }).fix.fixId, 'blame');
    expect(panels()[0]).toBe('The run’s calls');
    expect(panels()).not.toContain('Where the run was lost');
    await r!.unmount();
    // Nor did a search that stopped part way.
    const stopped = newRun({ labels: ['triage'], calls: ['api', 'tool', 'api'] });
    await open(blame(stopped, { report: blameReport(stopped, 'stopped') }).fix.fixId, 'blame');
    expect(panels()[0]).toBe('The run’s calls');
  });
});

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
    // The attempts it ran first, its blame's and both candidates' it verified (the one it dropped and
    // the one it accepted), then what each stage cost; the line breaks only after a dot.
    expect(text(r!.one('.fxreceipt'))).toBe('17 attempts · cost: blame ≈$0.100 · repairer ≈$0.0040 · verify ≈$0.072');
    expect(r!.all('.fxreceipt .nw').map(text)).toEqual(['17 attempts ·', 'cost: blame ≈$0.100 ·', 'repairer ≈$0.0040 ·', 'verify ≈$0.072']);
  });

  it('counts the blame a repair ran, never one it reused or one made after it', async () => {
    const run = newRun({ labels: ['refund-bug'] });
    const { fix } = blame(run);
    recordRepair(store, { repairId: 'repair-munzln2i', dir: '.shadowlap/repairs/repair-munzln2i', report: repairReport({ targets: [run] }), expect: EXPECT, command: 'shadowlap repair --fixes label:refund-bug', at: NOW + 1 });
    // A blame of the run made after the repair is none of its attempts.
    recordBlame(store, { runId: run, report: blameReport(run, 'stopped'), expect: EXPECT, scope: null, command: 'shadowlap blame', title: 'issue_refund called with amount 240', checkText: 'issue_refund never called with {"amount":240}', at: NOW + 2 });
    await open(fix.fixId, 'repair');
    expect(text(r!.one('.fxreceipt'))).toMatch(/^17 attempts · cost: /);
    await r!.unmount();
    const other = newRun({ labels: ['triage'] });
    const reused = blame(other).fix.fixId;
    const report = repairReport({ targets: [other] });
    report.targets[0] = { ...report.targets[0]!, reused: true };
    recordRepair(store, { repairId: 'repair-reused', dir: '.shadowlap/repairs/repair-reused', report, expect: EXPECT, command: 'shadowlap repair --fixes label:triage', at: NOW + 3 });
    await open(reused, 'repair');
    // Its candidates' verification alone: 2 attempts of the one it dropped, 4 of the one it accepted.
    expect(text(r!.one('.fxreceipt'))).toMatch(/^6 attempts · cost: /);
  });

  it('heads a repair that accepted nothing with when it ran, never as repaired', async () => {
    const run = newRun({ labels: ['refund-bug'] });
    const { fix } = blame(run);
    recordRepair(store, { repairId: 'repair-nothing', dir: '.shadowlap/repairs/repair-nothing', report: repairReport({ targets: [run], accepted: false }), expect: EXPECT, command: 'shadowlap repair --fixes label:refund-bug', at: NOW + 1 });
    await open(fix.fixId, 'repair');
    expect(text(r!.one('.sh p'))).toMatch(/^Ran [A-Z][a-z]{2} \d+, \d\d:\d\d · proposed by claude-code \(answered by claude-opus-5-5\) · 1 candidate tried, none accepted/);
    expect(text(r!.one('.fxreceipt'))).toBe('13 attempts · cost: blame ≈$0.100 · repairer ≈$0.0040 · verify ≈$0.024');
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
    await r!.unmount();
    // Where claude can't be found the dialog says so, and still that the repair would end with no fix to try.
    await open(fix.fixId, null, null, { problem: 'This repair asks your own Claude Code, and claude was not found on this machine.' });
    await r!.click(r!.byText('.ph .actions button', 'Repair from here'));
    await r!.until('the dialog to read the fix again', () => r!.all('.dialog .fxdlg').length > 0);
    expect(text(r!.one('.dialog header p'))).toBe('This repair asks your own Claude Code, and claude was not found on this machine.');
    expect(r!.all('.dialog .fxdlg').map(text)).toEqual(['No failing run was rescued, so there is no passing path to learn from: the repair ends “No fix to try”.']);
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
    // Its command wraps between words, each flag kept with its value: never "--" at a line's end and "repairer" at the next's start.
    const kept = r!.all('.dialog .cmdline span.nw').map((e) => e.textContent);
    expect(kept).toContain('--repairer ');
    expect(kept[kept.indexOf('--repairer ') + 1]).toBe('claude-code');
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

describe('the Verify step', () => {
  /** A run blamed under the fix's check, with a verdict that counts and could not settle it, then one under the exit code alone. */
  function verdicts(): { fixId: string; counted: string; other: string } {
    const run = newRun({ labels: ['double-email'] });
    const { fix } = blame(run);
    const unsettled = verifyReport([{ runId: run, role: 'target', pass: true }]);
    unsettled.runs[0] = { ...unsettled.runs[0]!, verdict: 'open', decision: 'inconclusive' };
    Object.assign(unsettled, decideVerify(unsettled.runs, null));
    const counted = recordVerdict(store, { report: unsettled, expect: EXPECT, command: 'shadowlap verify --fixes label:double-email', at: NOW + 1 }).verdict.verifyId;
    const exitOnly = { ...verifyReport([{ runId: run, role: 'target', pass: true, recorded: true }], { oracle: ['the agent exits 0'], codeVersion: 'f353f41' }), fields: { temperature: 1 } };
    const other = recordVerdict(store, { report: exitOnly, expect: null, command: 'shadowlap verify --fixes label:double-email --set temperature=1', at: NOW + 2 }).verdict.verifyId;
    return { fixId: fix.fixId, counted, other };
  }

  it('opens on the newest verdict that counts, and says an incomplete one spent, never that it found out', async () => {
    const { fixId } = verdicts();
    await open(fixId, 'verify');
    // Incomplete, in amber: the colour of what nothing decided, as inconclusive is everywhere.
    expect(r!.one('.verdict').className).toBe('verdict warn');
    expect(r!.one('.verdict .badge').className).toBe('badge y');
    expect(text(r!.one('.verdict h2'))).toBe('Not every run settled');
    expect(r!.all('.vpick a').filter((a) => a.getAttribute('aria-pressed') === 'true').map(text)).toEqual(['370712a+dirty · incomplete']);
    // Tokens and cost per run are a quiet line, never figures bigger than the verdict; then what finding out spent.
    expect(r!.all('.deltas')).toEqual([]);
    expect(r!.all('.fxreceipt').map(text)).toEqual([expect.stringMatching(/^per run, as it would run live: 4,329 → 4,402 input tokens \(\+1\.7%\) · ≈\$[\d.]+ → ≈\$[\d.]+ \(\+1\.7%\)$/), expect.stringMatching(/^\d+ attempts · \d+ upstream requests · ≈\$[\d.]+ spent\. A run whose replay doesn’t fork/)]);
  });

  it("draws a verdict that doesn't count plain, headed with why, and marks it so in the switch, named by the field it set", async () => {
    const { fixId, other } = verdicts();
    await open(fixId, 'verify', other);
    // Accepted under its own check, but no verdict on the fix: never in lime.
    expect(r!.one('.verdict').className).toBe('verdict n');
    expect(r!.one('.verdict .badge').className).not.toContain('ok');
    expect(text(r!.one('.verdict h2'))).toBe("Doesn't count for this fix: its check leaves out issue_refund with {\"amount\":240} called 0 times");
    expect(r!.all('.vpick a').map(text)).toEqual(["temperature=1 from each run's first model call · at f353f41 · accepted · doesn't count", '370712a+dirty · incomplete']);
    // The revision stays with its "at", and no line starts on a dot.
    expect(r!.all('.vpick a')[0]!.textContent).toBe("temperature=1 from each run's first model call\u00a0· at\u00a0f353f41\u00a0· accepted\u00a0· doesn't count");
    expect(r!.one('.verdict p').textContent).toMatch(/^temperature=1 from each run's first model call\u00a0· at\u00a0f353f41\u00a0· a run passes/);
    expect(text(r!.one('.verdict p'))).toMatch(/^temperature=1 from each run's first model call · at f353f41 · a run passes when 4 of 5 attempts meet the check: the agent exits 0$/);
    expect(text(r!.all('.fxreceipt').at(-1)!)).toContain('spent to find out before it shipped');
  });

  it('heads a verdict that counts by the runs it checked', async () => {
    const runs = [newRun({ labels: ['refund-bug'] }), newRun({ labels: ['refund-bug'] })];
    let fixId = '';
    for (const x of runs) fixId = blame(x).fix.fixId;
    recordVerdict(store, { report: verifyReport([{ runId: runs[0]!, role: 'target', pass: true }]), expect: EXPECT, command: 'v', at: NOW + 1 });
    await open(fixId, 'verify');
    expect(r!.one('.verdict').className).toBe('verdict ok');
    expect(text(r!.one('.verdict h2'))).toBe('Fixes 1 of 1 target run');
    expect(text(r!.byText('nav.stepper a b', '1 fixed'))).toBe('1 fixed');
  });
});

describe('what settles a fix left unsettled', () => {
  it('leads the Verify step of a verdict a budget stopped with Run more attempts, its header plain, and says what that takes', async () => {
    const run = newRun({ labels: ['double-email'] });
    const { fix } = blame(run);
    const gate = { kind: 'sprt' as const, good: 0.9, bad: 0.7, risk: 0.05, max: 80 };
    const report = verifyReport([{ runId: run, role: 'target', pass: true }]);
    report.runs[0] = { ...report.runs[0]!, verdict: 'open', decision: 'continue' };
    Object.assign(report, decideVerify(report.runs, 'the budget of $0.01 is spent'), { gate, stopReason: 'the budget of $0.01 is spent', attemptsPerRun: 80 });
    const { verdict } = recordVerdict(store, { report, expect: EXPECT, command: 'shadowlap verify --fixes label:double-email --set temperature=1 --budget 0.012', at: NOW + 1 });
    const started: Array<[string, unknown]> = [];
    await open(fix.fixId, 'verify', null, { started });
    const more = r!.byText('.verdict .actions button', 'Run more attempts');
    expect(more.className).toBe('btn sm lime');
    expect(JSON.parse(String(more.props['data-tip']))).toMatchObject({ t: 'Verifies the change again from the start, up to 80 attempts a run', s: `$ shadowlap verify --fixes ${run} --set temperature=1` });
    // The header's Repair from here reads plain while the step leads.
    expect(r!.byText('.ph .actions button', 'Repair from here').className).toBe('btn');
    expect(text(r!.one('.fxreceipt.vmore'))).toBe(`${run.slice(0, 10)} is not settled: the budget of $0.01 is spent. Run more attempts verifies again from the start (verify has no --continue), up to 80 a run, without its --budget 0.012: about 12 attempts, ≈$0.144.`);
    // The reasons say nothing the line doesn't.
    expect(r!.all('ul.fxwarn.bad')).toEqual([]);
    await r!.click(more);
    expect(started).toEqual([['verify', { fixId: fix.fixId, verifyId: verdict.verifyId }]]);
    await r!.unmount();
    // On the Blame step, the fix's own lead is back.
    await open(fix.fixId, 'blame');
    expect(r!.byText('.ph .actions button', 'Repair from here').className).toBe('btn lime');
  });

  it('leads with Blame again a blame that couldn’t settle, and asks for the model a stronger blame asks', async () => {
    const run = newRun({ labels: ['double-email'] });
    const report = blameReport(run, 'unrescuable');
    report.gate = { kind: 'sprt', good: 0.6, bad: 0.1, risk: 0.05, max: 20 };
    report.probes = [{ ...report.probes[0]!, decision: 'inconclusive' }];
    const { fix } = blame(run, { report });
    const started: Array<[string, unknown]> = [];
    await open(fix.fixId, null, null, { started });
    expect(r!.all('.ph .actions button').map((b) => [text(b), b.className])).toEqual([
      ['Repair from here', 'btn'],
      ['Blame again', 'btn lime'],
    ]);
    await r!.click(r!.byText('.ph .actions button', 'Blame again'));
    expect(started).toEqual([['blame', { fixId: fix.fixId, again: true }]]);
    await r!.unmount();
    const other = newRun({ labels: ['digest'] });
    const { fix: plain } = blame(other, { report: blameReport(other, 'unrescuable'), title: 'The agent exited with code 1' });
    started.length = 0;
    await open(plain.fixId, null, null, { started });
    const stronger = r!.byText('.ph .actions button', 'Blame with a stronger model…');
    expect(stronger.className).toBe('btn lime');
    await r!.click(stronger);
    expect(text(r!.one('.dialog h3'))).toBe('Blame with a stronger model');
    expect(text(r!.one('.dialog header p'))).toContain('the last blame took 4 attempts');
    expect(started).toEqual([]);
  });
});

describe('Mark applied for a change of request fields', () => {
  it('says which fields, since no patch carries them, never that there is no patch to apply', async () => {
    const run = newRun({ labels: ['double-email'] });
    const { fix } = blame(run);
    recordVerdict(store, { report: { ...verifyReport([{ runId: run, role: 'target', pass: true }], { codeVersion: 'f353f41' }), fields: { temperature: 1 } }, expect: EXPECT, command: 'shadowlap verify --fixes label:double-email --set temperature=1', at: NOW + 1 });
    await open(fix.fixId);
    await r!.click(r!.byText('.ph .actions button', 'Mark applied'));
    expect(text(r!.one('.dialog header p'))).toBe("It was verified with temperature=1 from each run's first model call, a change to the requests rather than to your files: once your agent makes it, this marks the fix applied.");
  });

  it('reads Marked applied once marked, its hover naming the change, never a patch', async () => {
    const run = newRun({ labels: ['double-email'] });
    const { fix } = blame(run);
    recordVerdict(store, { report: { ...verifyReport([{ runId: run, role: 'target', pass: true }], { codeVersion: 'f353f41' }), fields: { temperature: 1 } }, expect: EXPECT, command: 'shadowlap verify --fixes label:double-email --set temperature=1', at: NOW + 1 });
    markFixApplied(store, fix.fixId, { patch: 'none', repairId: null, goldens: [], tests: 'skipped', via: 'fix apply' });
    await open(fix.fixId);
    const button = r!.byText('.ph .actions button', 'Marked applied');
    expect(button.disabled).toBe(true);
    expect(button.props.title).toBe("Verified with temperature=1 from each run's first model call, a change to the requests that your agent makes, not to your files");
    expect(r!.all('.ph .actions button').map(text)).toEqual(['Marked applied']);
  });

  it('reads Marked applied for a fix verified on the working tree, as it was', async () => {
    const run = newRun({ labels: ['double-email'] });
    const { fix } = blame(run);
    recordVerdict(store, { report: verifyReport([{ runId: run, role: 'target', pass: true }], { codeVersion: 'f353f41' }), expect: EXPECT, command: 'shadowlap verify --fixes label:double-email', at: NOW + 1 });
    markFixApplied(store, fix.fixId, { patch: 'none', repairId: null, goldens: [], tests: 'skipped', via: 'fix apply' });
    await open(fix.fixId);
    expect(r!.byText('.ph .actions button', 'Marked applied').props.title).toBe('Verified on your working tree as it was, and marked applied');
  });
});
