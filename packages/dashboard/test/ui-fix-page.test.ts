import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decideVerify, formatBlame, markFixApplied, recordBlame, recordEvent, recordRepair, recordVerdict, setFixTitle, Store, type BlameReport } from '@shadowlap/engine';
import { blameReport, EXPECT, makeRun, repairReport, verifyReport } from '../../engine/test/fix-fixtures.js';
import { fixAttemptGroups } from '../src/attempt-groups.js';
import { fixDetail, fixList } from '../src/fixes.js';
import type { Client } from '../ui/api.js';
import { FixPage } from '../ui/fixes/FixPage.js';
import { FixesPage } from '../ui/pages/Fixes.js';
import { useRoute } from '../ui/router.js';
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

/** What the project's goldens folder holds, as the page is told: every name in it, and the recordings in it already. */
type Folder = { held?: string[]; there?: Array<{ run: string; at: string }> };

/**
 * The app as the shell gives it, its server answering from the store; `inTree` stands for git saying
 * a patch is in the working tree, `held` and `there` for what the project's goldens folder holds.
 */
function app(o: { inTree?: boolean; started?: Array<[string, unknown]>; problem?: string } & Folder = {}): AppState {
  const client = {
    fix: (id: string) => Promise.resolve(fixDetail(store, id, { ...(o.inTree ? { patchInTree: () => true } : {}), ...(o.problem ? { checkRepairer: () => o.problem! } : {}), ...(o.held ? { goldensFolder: () => ({ there: o.there ?? [], held: o.held! }) } : {}) })),
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
  } as unknown as AppState;
}

/** The fix's page, opened at a step, once it has loaded. */
async function open(fixId: string, step: string | null = null, sub: string | null = null, o: { inTree?: boolean; started?: Array<[string, unknown]>; problem?: string } & Folder = {}): Promise<Rendered> {
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
  // With the flags it ran with beside its command line, as the CLI keeps them (blameRerun).
  return recordBlame(store, { runId, report: o.report ?? blameReport(runId), expect: o.expect === undefined ? EXPECT : o.expect, scope: null, command: `shadowlap blame ${runId.slice(0, 10)}`, rerun: { flags: [], command: null }, title: o.title ?? 'issue_refund called with amount 240', checkText: 'issue_refund never called with {"amount":240}', at: NOW });
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

  it('says the error bound its confidence comes from as the CLI prints it, never as a raw number', async () => {
    const run = newRun({ labels: ['refund-bug'], calls: ['api', 'tool', 'api', 'tool', 'api'] });
    const report = blameReport(run);
    // Each probe's own risk, and their sum the blame's answer is bounded by, as blame works them out.
    report.errorBound = 0.029768686911663525;
    for (const p of report.probes) p.risk = report.errorBound / 3;
    await open(blame(run, { report }).fix.fixId, 'blame');
    const cli = /^ {2}Confidence: high \((.+)\)$/m.exec(formatBlame(report))?.[1];
    expect(cli).toBe('<= 3% risk that the call is wrong: 3 probes decided, at <= 1% risk each');
    const head = text(r!.one('.sh p'));
    expect(head).toContain(` · confidence high (${cli!})`);
    expect(head).not.toContain('0.0297');
    await r!.unmount();
    // A report from before blame bounded its error says its confidence alone, as it did.
    const older = newRun({ labels: ['triage'], calls: ['api', 'tool', 'api', 'tool', 'api'] });
    await open(blame(older).fix.fixId, 'blame');
    expect(text(r!.one('.sh p'))).toMatch(/ · confidence high(?! \()/);
  });

  it('prints no bound where the CLI prints no confidence line: every attempt that passed answered the call as the recording did', async () => {
    const run = newRun({ labels: ['refund-bug'], calls: ['api', 'tool', 'api', 'tool', 'api'] });
    // As blame leaves such a report: no call blamed, the search's bound kept, with its probes' risks.
    const why = 'Every attempt that passed at #5 answered it as the recording did, so what made them pass came after that answer.';
    const report: BlameReport = { ...blameReport(run), outcome: 'unrescuable', blamed: null, lost: null, range: null, contrast: null, errorBound: 0.03, sameAnswer: { callNo: 5, runId: run, why } };
    for (const p of report.probes) p.risk = 0.01;
    expect(formatBlame(report)).not.toContain('Confidence:');
    await open(blame(run, { report }).fix.fixId, 'blame');
    const head = text(r!.one('.sh p'));
    expect(head).toContain(why);
    expect(head).not.toMatch(/risk/);
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
    report.targets[0] = { ...report.targets[0], reused: true };
    recordRepair(store, { repairId: 'repair-reused', dir: '.shadowlap/repairs/repair-reused', report, expect: EXPECT, command: 'shadowlap repair --fixes label:triage', at: NOW + 3 });
    await open(reused, 'repair');
    // Its candidates' verification alone: 2 attempts of the one it dropped, 4 of the one it accepted.
    expect(text(r!.one('.fxreceipt'))).toMatch(/^6 attempts · cost: /);
  });

  it('heads a repair that accepted nothing with when it ran, never as repaired', async () => {
    const run = newRun({ labels: ['refund-bug'] });
    const { fix } = blame(run);
    // No repair yet: the step says so in the stepper's word, as a repair's result is a change.
    await open(fix.fixId, 'repair');
    expect(text(r!.one('.stepempty h2'))).toBe('No change yet');
    expect(r!.all('.stepper a b').map(text)[1]).toBe('No change yet');
    await r!.unmount();
    recordRepair(store, { repairId: 'repair-nothing', dir: '.shadowlap/repairs/repair-nothing', report: repairReport({ targets: [run], accepted: false }), expect: EXPECT, command: 'shadowlap repair --fixes label:refund-bug', at: NOW + 1 });
    await open(fix.fixId, 'repair');
    expect([text(r!.one('.sh h2')), r!.all('.stepper a b').map(text)[1]]).toEqual(['No change yet', 'No change yet']);
    expect(text(r!.one('.sh p'))).toMatch(/^Ran [A-Z][a-z]{2} \d+, \d\d:\d\d · proposed by claude-code \(answered by claude-opus-5-5\) · 1 candidate tried, none accepted/);
    expect(text(r!.one('.fxreceipt'))).toBe('13 attempts · cost: blame ≈$0.100 · repairer ≈$0.0040 · verify ≈$0.024');
  });
});

describe('Run repair', () => {
  it('says a repair that would reuse blames that rescued no run ends with no fix to try, and bills nothing', async () => {
    const run = newRun({ labels: ['digest'] });
    const report = blameReport(run, 'unrescuable');
    store.updateRunMeta(run, { blame: { at: NOW, outcome: 'unrescuable', callNo: null, confidence: 'high', rescuedRunId: null, fields: {}, oracle: report.oracle, probes: [], spent: 0 } });
    const { fix } = blame(run, { report });
    await open(fix.fixId);
    const button = r!.byText('.ph .actions button', 'Run repair');
    // Still there, but no longer the lead, with why on hover.
    expect(button.className).toBe('btn');
    expect(button.props.title).toBe('No failing run was rescued, so there is no passing path to learn from: the repair ends “No fix to try”.');
    await r!.click(button);
    await r!.until('the dialog to read the fix again', () => r!.all('.dialog .dwarn').length > 0);
    expect(text(r!.one('.dialog .dwarn'))).toBe('No failing run was rescued, so there is no passing path to learn from: the repair ends “No fix to try”.');
    // Nothing of what a repair that runs would do, and what it bills says why: nothing runs.
    expect(r!.all('.dialog .dfacts')).toEqual([]);
    expect(text(r!.one('.dialog .dcost'))).toContain('nothing runs: the blame it reuses rescued no call');
    await r!.unmount();
    // Where claude can't be found the dialog says so, and still that the repair would end with no fix to try.
    await open(fix.fixId, null, null, { problem: 'This repair asks your own Claude Code, and claude was not found on this machine.' });
    await r!.click(r!.byText('.ph .actions button', 'Run repair'));
    await r!.until('the dialog to read the fix again', () => r!.all('.dialog .dwarn').length > 0);
    expect(text(r!.one('.dialog .dwarn'))).toBe('This repair asks your own Claude Code, and claude was not found on this machine');
    expect(text(r!.one('.dialog .dcost'))).toContain('nothing runs: the blame it reuses rescued no call');
  });

  it('says the agent runs live and is billed when the repair has a passing path to learn from', async () => {
    const run = newRun({ labels: ['refund-bug'] });
    const { fix } = blame(run);
    await open(fix.fixId);
    const button = r!.byText('.ph .actions button', 'Run repair');
    expect(button.className).toBe('btn lime');
    await r!.click(button);
    await r!.until('the dialog to read the fix again', () => !r!.one('.dialog .dlg-ok').disabled);
    expect(text(r!.one('.dialog header p'))).toContain('Asks your own Claude Code for prompt and tool rewrites and picks the smallest that fixes the failing runs.');
    expect(text(r!.one('.dialog .dcost'))).toContain('live from each run’s first model call, writes stubbed');
    expect(text(r!.one('.dialog .dcost'))).toContain('up to 3 candidates');
    // Candidates are verified in a worktree of their own: the dialog never says they are tried in the working tree.
    const said = r!.all('.dialog .dfacts div').map(text);
    expect(said).toContain('Changesnothing in your working treeeach candidate is tried in a worktree of its own');
    expect(said).toContain('Hands overthe accepted one, as a patch for you to apply');
    expect(said).toContain('While it runsleave the prompt and tools alone');
    // Its command wraps between words, each flag kept with its value: never "--" at a line's end and "repairer" at the next's start.
    const kept = r!.all('.dialog .cmdline span.nw').map((e) => e.textContent);
    expect(kept).toContain('--repairer ');
    expect(kept[kept.indexOf('--repairer ') + 1]).toBe('claude-code');
  });
});

describe('Apply fix', () => {
  /** A verified fix, its repair's patch not applied yet. */
  /** A fix a repair verified, having fixed `runs` failing runs labelled refund-bug. */
  function verified(runs = 1): string {
    const fixed = Array.from({ length: runs }, () => newRun({ labels: ['refund-bug'] }));
    const { fix } = blame(fixed[0]);
    recordRepair(store, { repairId: 'repair-munzln2i', dir: '.shadowlap/repairs/repair-munzln2i', report: repairReport({ targets: fixed }), expect: EXPECT, command: 'shadowlap repair --fixes label:refund-bug', at: NOW + 1 });
    return fix.fixId;
  }
  const buttons = () => r!.all('.ph .actions button').map(text);

  it('offers Mark applied for a patch already in the working tree, saying what applying still does, and no git apply to copy', async () => {
    await open(verified(), null, null, { inTree: true });
    expect(buttons()).toEqual(['Mark applied']);
    await r!.click(r!.byText('.ph .actions button', 'Mark applied'));
    expect(text(r!.one('.dialog h3'))).toBe('Mark fix applied?');
    expect(text(r!.one('.dialog header p'))).toContain('Copies the goldens it is missing into goldens/, runs them and marks the fix applied.');
  });

  it('offers the patch and git apply to copy while the patch is still to apply', async () => {
    await open(verified());
    expect(buttons()).toEqual(['Copy git apply', 'Apply fix']);
    // Its dialog asks with its name, as one that changes your working tree, and confirms with it.
    await r!.click(r!.byText('.ph .actions button', 'Apply fix'));
    expect([text(r!.one('.dialog h3')), text(r!.one('.dialog .dlg-ok'))]).toEqual(['Apply fix?', 'Apply fix']);
  });

  it('asks a name for each golden it copies, checks it as it is typed, and sends it with the job', async () => {
    const started: Array<[string, unknown]> = [];
    const fixId = verified();
    const run = fixDetail(store, fixId)!.actions.apply!.names[0].run;
    await open(fixId, null, null, { started, held: ['refund-in-limit'] });
    await r!.click(r!.byText('.ph .actions button', 'Apply fix'));
    const field = () => r!.one('.dialog .gnames input');
    const said = () => r!.all('.dialog .fieldnote.err').map(text);
    const ok = () => r!.one('.dialog .dlg-ok');
    const command = () => text(r!.one('.dialog .cmdline'));
    const copied = () => text(r!.all('.dialog .ondisk.steps li small')[1]);
    // Under the patch, prefilled from the fix's label, never the run's id; its command and its step follow it.
    expect(text(r!.one('.dialog .gnames label'))).toBe(`The golden from ${run}goldens/`);
    expect([field().value, field().getAttribute('aria-label')]).toEqual(['refund-bug', `Name of the golden from ${run}`]);
    expect(command()).toContain(`shadowlap fix apply ${fixId.slice(0, 13)} --name ${run}=refund-bug`);
    expect(copied()).toBe('goldens/refund-bug');
    expect([said(), ok().disabled]).toEqual([[], false]);
    // Each name that won't do says why under the field, and Apply fix waits until it will.
    for (const [typed, why] of [
      ['Refund Bug', 'A golden’s name takes lower-case letters, digits and hyphens.'],
      ['', 'Give the golden a name.'],
      ['refund-in-limit', 'goldens/refund-in-limit is taken: pick another name.'],
    ]) {
      await r!.type(field(), typed);
      expect([said(), ok().disabled, field().getAttribute('aria-invalid')]).toEqual([[why], true, 'true']);
      expect(field().getAttribute('aria-describedby')).toBe(r!.one('.dialog .fieldnote.err').getAttribute('id'));
    }
    await r!.type(field(), '');
    expect(command()).toContain(`--name ${run}=<name>`);
    expect(copied()).toBe('goldens/<name>');
    await r!.type(field(), ' refund-over-limit ');
    expect([said(), ok().disabled, field().getAttribute('aria-invalid')]).toEqual([[], false, null]);
    expect(command()).toContain(`--name ${run}=refund-over-limit`);
    await r!.click(ok());
    expect(started).toEqual([['apply', { fixId, names: { [run]: 'refund-over-limit' } }]]);
  });

  it('numbers two goldens’ names, says the second of two the same won’t do, and counts what it copies now', async () => {
    const started: Array<[string, unknown]> = [];
    const fixId = verified(2);
    const runs = fixDetail(store, fixId)!.actions.apply!.names.map((n) => n.run);
    await open(fixId, null, null, { started, held: [] });
    await r!.click(r!.byText('.ph .actions button', 'Apply fix'));
    const fields = () => r!.all('.dialog .gnames input');
    // The step after the patch: what it does, and where.
    const step = () => r!.all('.dialog .ondisk.steps li')[1].children.filter((c) => c.tagName === 'SPAN' || c.tagName === 'SMALL').map(text);
    expect(fields().map((f) => f.value)).toEqual(['refund-bug-1', 'refund-bug-2']);
    expect(step()).toEqual(['2 recordings copied', 'into goldens/, as named below']);
    await r!.type(fields()[1], 'refund-bug-1');
    expect(r!.all('.dialog .fieldnote.err').map(text)).toEqual(['Each golden needs a name of its own.']);
    expect(fields().map((f) => f.getAttribute('aria-invalid'))).toEqual([null, 'true']);
    expect(r!.one('.dialog .dlg-ok').disabled).toBe(true);
    await r!.type(fields()[1], 'refund-twice');
    await r!.click(r!.one('.dialog .dlg-ok'));
    expect(started).toEqual([['apply', { fixId, names: { [runs[0]]: 'refund-bug-1', [runs[1]]: 'refund-twice' } }]]);
    // One in goldens/ already keeps its name: asked none, and copied by no step.
    await r!.unmount();
    await open(fixId, null, null, { held: [runs[1]], there: [{ run: runs[1], at: runs[1] }] });
    await r!.click(r!.byText('.ph .actions button', 'Apply fix'));
    expect(fields().map((f) => f.value)).toEqual(['refund-bug-1']);
    expect(step()).toEqual(['Recording copied', 'goldens/refund-bug-1']);
  });

  it('asks the golden’s name in Mark fix applied?, for a patch already in the working tree', async () => {
    const started: Array<[string, unknown]> = [];
    const fixId = verified();
    const run = fixDetail(store, fixId)!.actions.apply!.names[0].run;
    await open(fixId, null, null, { started, inTree: true, held: [] });
    await r!.click(r!.byText('.ph .actions button', 'Mark applied'));
    expect(text(r!.one('.dialog h3'))).toBe('Mark fix applied?');
    expect(r!.one('.dialog .gnames input').value).toBe('refund-bug');
    await r!.type(r!.one('.dialog .gnames input'), 'refund-merged');
    expect(text(r!.one('.dialog .cmdline'))).toContain(`--name ${run}=refund-merged`);
    await r!.click(r!.one('.dialog .dlg-ok'));
    expect(started).toEqual([['apply', { fixId, names: { [run]: 'refund-merged' } }]]);
  });

  it('asks Finish applying fix? the names of the goldens an apply left, and none of those it copied', async () => {
    const started: Array<[string, unknown]> = [];
    const fixId = verified(2);
    const runs = fixDetail(store, fixId)!.actions.apply!.names.map((n) => n.run);
    markFixApplied(store, fixId, { patch: 'applied', repairId: 'repair-munzln2i', goldens: ['goldens/refund-twice'], tests: 'passed', via: 'fix apply', from: { 'goldens/refund-twice': runs[0] } });
    await open(fixId, null, null, { started, held: ['refund-twice'] });
    await r!.click(r!.byText('.ph .actions button', 'Finish applying'));
    expect(text(r!.one('.dialog h3'))).toBe('Finish applying fix?');
    expect(r!.all('.dialog .gnames input').map((f) => [f.value, f.getAttribute('aria-label')])).toEqual([['refund-bug-2', `Name of the golden from ${runs[1]}`]]);
    await r!.type(r!.one('.dialog .gnames input'), 'refund-twice');
    expect(r!.all('.dialog .fieldnote.err').map(text)).toEqual(['goldens/refund-twice is taken: pick another name.']);
    await r!.type(r!.one('.dialog .gnames input'), 'refund-once');
    await r!.click(r!.one('.dialog .dlg-ok'));
    expect(started).toEqual([['apply', { fixId, names: { [runs[1]]: 'refund-once' } }]]);
  });

  it('offers the patch to read on an applied fix, never a git apply that would fail', async () => {
    const fixId = verified();
    markFixApplied(store, fixId, { patch: 'applied', repairId: 'repair-munzln2i', goldens: ['goldens/01M3RZ0001'], tests: 'passed', via: 'fix apply' });
    await open(fixId);
    expect(buttons()).toEqual(['Show patch', 'Patch applied']);
    await r!.click(r!.byText('.ph .actions button', 'Show patch'));
    expect(text(r!.one('.dialog h3'))).toBe('Show patch');
    expect(text(r!.one('.dialog header p'))).toContain('The fix as repair handed it over, in your working tree since you applied it.');
    expect(text(r!.one('.dialog .dfacts'))).toBe('Path.shadowlap/repairs/repair-munzln2i/fix.patch');
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
    unsettled.runs[0] = { ...unsettled.runs[0], verdict: 'open', decision: 'inconclusive' };
    Object.assign(unsettled, decideVerify(unsettled.runs, null));
    const counted = recordVerdict(store, { report: unsettled, expect: EXPECT, command: 'shadowlap verify --fixes label:double-email', at: NOW + 1 }).verdict.verifyId;
    const exitOnly = { ...verifyReport([{ runId: run, role: 'target', pass: true, recorded: true }], { oracle: ['the agent exits 0'], codeVersion: 'f353f41' }), fields: { temperature: 1 } };
    const other = recordVerdict(store, { report: exitOnly, expect: null, command: 'shadowlap verify --fixes label:double-email --set temperature=1', at: NOW + 2 }).verdict.verifyId;
    return { fixId: fix.fixId, counted, other };
  }

  it('opens on the newest verdict that counts, and says an incomplete one spent, never that it found out', async () => {
    const { fixId } = verdicts();
    await open(fixId, 'verify');
    // Verify's incomplete, said inconclusive in amber: the one word and colour of what nothing decided.
    expect(r!.one('.verdict').className).toBe('verdict warn');
    expect(r!.one('.verdict .badge').className).toBe('badge y');
    expect(text(r!.one('.verdict .badge'))).toBe('inconclusive');
    expect(text(r!.one('.verdict h2'))).toBe('Not every run settled');
    // Links to each verdict's page: the one shown is the current one (a link pressed is no button: axe calls that critical).
    expect(r!.all('.vpick a').filter((a) => a.getAttribute('aria-current') === 'page').map(text)).toEqual(['370712a+dirty · inconclusive']);
    expect(r!.all('.vpick a[aria-pressed]')).toEqual([]);
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
    expect(r!.all('.vpick a').map(text)).toEqual(["temperature=1 from each run's first model call · at f353f41 · accepted · doesn't count", '370712a+dirty · inconclusive']);
    // The revision stays with its "at", and no line starts on a dot.
    expect(r!.all('.vpick a')[0].textContent).toBe("temperature=1 from each run's first model call\u00a0· at\u00a0f353f41\u00a0· accepted\u00a0· doesn't count");
    expect(r!.one('.verdict p').textContent).toMatch(/^temperature=1 from each run's first model call\u00a0· at\u00a0f353f41\u00a0· a run passes/);
    expect(text(r!.one('.verdict p'))).toMatch(/^temperature=1 from each run's first model call · at f353f41 · a run passes when 4 of 5 attempts meet the check: the agent exits 0$/);
    expect(text(r!.all('.fxreceipt').at(-1)!)).toContain('spent to find out before it shipped');
  });

  it('heads a verdict that counts by the runs it checked', async () => {
    const runs = [newRun({ labels: ['refund-bug'] }), newRun({ labels: ['refund-bug'] })];
    let fixId = '';
    for (const x of runs) fixId = blame(x).fix.fixId;
    recordVerdict(store, { report: verifyReport([{ runId: runs[0], role: 'target', pass: true }]), expect: EXPECT, command: 'v', at: NOW + 1 });
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
    report.runs[0] = { ...report.runs[0], verdict: 'open', decision: 'continue' };
    // The fields its --set gave and the flags it ran with, as verify keeps them beside its command line.
    Object.assign(report, decideVerify(report.runs, 'the budget of $0.01 is spent'), { gate, stopReason: 'the budget of $0.01 is spent', attemptsPerRun: 80, fields: { temperature: 1 } });
    const { verdict } = recordVerdict(store, { report, expect: EXPECT, command: `shadowlap verify --fixes label:double-email --expect '${JSON.stringify(EXPECT)}' --set temperature=1 --budget 0.012`, rerun: { flags: ['--budget', '0.012'], command: null }, at: NOW + 1 });
    const started: Array<[string, unknown]> = [];
    await open(fix.fixId, 'verify', null, { started });
    const more = r!.byText('.verdict .actions button', 'Run more attempts');
    expect(more.className).toBe('btn sm lime');
    expect(JSON.parse(String(more.props['data-tip']))).toMatchObject({ t: 'Verifies the change again from the start, up to 80 attempts a run', cmd: `$ shadowlap verify --fixes ${run} --expect '${JSON.stringify(EXPECT)}' --set temperature=1` });
    // The header's Run repair reads plain while the step leads.
    expect(r!.byText('.ph .actions button', 'Run repair').className).toBe('btn');
    expect(text(r!.one('.fxreceipt.vmore'))).toBe(`${run.slice(0, 10)} is inconclusive: the budget of $0.01 is spent. Run more attempts verifies again from the start (verify has no --continue), up to 80 a run, without its --budget 0.012: about 12 attempts, ≈$0.144.`);
    // The reasons say nothing the line doesn't.
    expect(r!.all('ul.fxwarn.bad')).toEqual([]);
    await r!.click(more);
    expect(started).toEqual([['verify', { fixId: fix.fixId, verifyId: verdict.verifyId }]]);
    await r!.unmount();
    // On the Blame step, the fix's own lead is back.
    await open(fix.fixId, 'blame');
    expect(r!.byText('.ph .actions button', 'Run repair').className).toBe('btn lime');
  });

  it('leads with Run blame again a blame that couldn’t settle, and asks for the model a stronger blame asks', async () => {
    const run = newRun({ labels: ['double-email'] });
    const report = blameReport(run, 'unrescuable');
    report.gate = { kind: 'sprt', good: 0.6, bad: 0.1, risk: 0.05, max: 20 };
    report.probes = [{ ...report.probes[0], decision: 'inconclusive' }];
    const { fix } = blame(run, { report });
    const started: Array<[string, unknown]> = [];
    await open(fix.fixId, null, null, { started });
    expect(r!.all('.ph .actions button').map((b) => [text(b), b.className])).toEqual([
      ['Run repair', 'btn'],
      ['Run blame again', 'btn lime'],
    ]);
    await r!.click(r!.byText('.ph .actions button', 'Run blame again'));
    expect(started).toEqual([['blame', { fixId: fix.fixId, again: true }]]);
    await r!.unmount();
    const other = newRun({ labels: ['digest'] });
    const { fix: plain } = blame(other, { report: blameReport(other, 'unrescuable'), title: 'The agent exited with code 1' });
    started.length = 0;
    await open(plain.fixId, null, null, { started });
    const stronger = r!.byText('.ph .actions button', 'Run blame with stronger model…');
    expect(stronger.className).toBe('btn lime');
    await r!.click(stronger);
    // Titled with its button's name, without the ellipsis, and confirmed so.
    expect(text(r!.one('.dialog h3'))).toBe('Run blame with stronger model');
    expect(text(r!.one('.dialog .dlg-ok'))).toBe('Run blame with stronger model');
    expect(text(r!.one('.dialog .dcost'))).toContain('the last blame took 4 attempts');
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
    expect(text(r!.one('.dialog header p'))).toContain("Marks the fix applied once your agent sends temperature=1 from each run's first model call.");
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

describe('opening a fix', () => {
  const g = globalThis as Record<string, unknown>;
  const saved = { location: g.location, history: g.history };
  afterEach(() => void Object.assign(g, saved));

  it('hands the focus to the fix’s heading, where the link it was opened with went', async () => {
    const run = newRun({ labels: ['refund-bug'] });
    const { fix } = blame(run);
    // The address bar as a browser has it: a link followed sets it, and the router hears it (hashchange).
    let hash = '#/fixes';
    const location = {
      pathname: '/',
      search: '',
      get hash() {
        return hash;
      },
      set hash(to: string) {
        hash = to;
        window.dispatchEvent(new Event('hashchange'));
      },
    };
    Object.assign(g, { location, history: { state: null, replaceState: (_s: unknown, _t: string, url: string) => (hash = url.slice(url.indexOf('#'))) } });
    function Routed() {
      const route = useRoute();
      return createElement('main', { id: 'view', tabIndex: -1 }, route.page === 'fixes' ? createElement(FixesPage, { id: route.id, step: route.step, sub: route.sub }) : null);
    }
    r = await render(createElement(AppContext.Provider, { value: app() }, createElement(Routed)));
    await r.until('the list to load', () => r!.all('.pslist a').length === 1);
    const link = r.one('.pslist a');
    // Clicked (or Enter on it): the link has the focus, and the browser follows it.
    await r.click(link);
    location.hash = link.getAttribute('href')!;
    await r.until('the fix', () => r!.all('h1').some((h) => text(h) === 'issue_refund called with amount 240'));
    expect(hash).toBe(`#/fixes/${fix.fixId}`);
    expect(link.isConnected).toBe(false);
    // Not the document's body, from where Tab would start again at the top bar: the page's heading, as a target Tab never stops at.
    expect(r.focused().tagName).toBe('H1');
    expect(r.focused().getAttribute('tabindex')).toBe('-1');
  });
});
