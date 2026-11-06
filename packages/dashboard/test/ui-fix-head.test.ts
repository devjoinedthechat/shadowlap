import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordBlame, recordRepair, recordVerdict, Store } from '@shadowlap/engine';
import { blameReport, makeRun, repairReport, verifyReport } from '../../engine/test/fix-fixtures.js';
import { fixDetail } from '../src/fixes.js';
import type { Client } from '../ui/api.js';
import { FixPage } from '../ui/fixes/FixPage.js';
import { runningStep, showPatchCard } from '../ui/fixes/head.js';
import { rungStatus } from '../ui/fixes/list.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { FixDetail, FixRung, JobListItem } from '../ui/types.js';
import { render, type FakeElement, type Rendered } from './ui-render.js';

/**
 * A fix's header as it renders, from the read model's own answer for a store built here: where the
 * fix stands, its failing runs' link, its buttons by status with the server's lead the one lime, Run
 * repair's wait, Verify this run, and the stepper's words, a running job's among them.
 */

let store: Store;
let r: Rendered | null = null;
const DAY = 24 * 60 * 60 * 1000;
let at = 100 * DAY;
const SEND_ONCE = { tools: { send_email: 1 } };

beforeEach(() => {
  store = Store.open(':memory:');
});
afterEach(async () => {
  await r?.unmount();
  r = null;
  store.close();
});

/** The fixtures read the engine's sources, this file the engine as it is built: one store either way. */
const engineStore = () => store as unknown as Parameters<typeof makeRun>[0];

function app(o: { inTree?: boolean; started?: Array<[string, unknown]>; jobs?: JobListItem[] } = {}): AppState {
  const client = {
    fix: (id: string) => Promise.resolve(fixDetail(store, id, o.inTree ? { patchInTree: () => true } : {})),
    jobs: () => Promise.resolve(o.jobs ?? []),
    attemptGroups: () => Promise.resolve({ blame: [], verify: [] }),
    startJob: (kind: string, fields: unknown) => {
      o.started?.push([kind, fields]);
      return new Promise(() => undefined);
    },
  } as unknown as Client;
  return { client, exported: false, meta: null, tick: 0, feeds: {}, jobs: [], actionsOff: null, hasKind: () => true, guard: (fn: () => void) => fn(), watchJob: () => undefined, toast: () => undefined } as unknown as AppState;
}

async function open(fixId: string, step: string | null = null, o: Parameters<typeof app>[0] = {}): Promise<Rendered> {
  r = await render(createElement(AppContext.Provider, { value: app(o) }, createElement(FixPage, { id: fixId, step, sub: null })));
  await r.until('the fix to load', () => r!.all('h1').length === 1);
  return r;
}

const text = (el: FakeElement) => el.textContent.replace(/\s+/g, ' ').trim();
const buttons = () => r!.all('.ph .actions button').map((b) => [text(b), b.className]);

/** A run blamed under the fix's check, opening the fix or joining the one its label points to. */
function blamed(label = 'double-email') {
  const run = makeRun(engineStore(), { labels: [label] });
  const { fix } = recordBlame(store, { runId: run, report: blameReport(run), expect: SEND_ONCE, scope: null, command: 'shadowlap blame', title: 'send_email called twice', checkText: 'send_email called once', at: (at += DAY) });
  return { run, fixId: fix.fixId };
}

describe('where a fix stands', () => {
  it('is a dot and a word, as its Fixes row says it: open and blamed muted, lime from verified on, merged with its pull request, an applied one that doesn’t hold red', () => {
    const at = (rung: FixRung, o: { broken?: string; pr?: number | null } = {}) => rungStatus({ rung, status: rung === 'open' || rung === 'blamed' ? 'open' : rung === 'applied' ? 'applied' : 'verified', broken: o.broken ?? null, pr: o.pr === undefined ? null : { number: o.pr, url: '', state: 'merged' } });
    expect(at('open')).toEqual({ tone: 'mu', text: 'open' });
    expect(at('blamed')).toEqual({ tone: 'mu', text: 'blamed' });
    expect(at('verified')).toEqual({ tone: 'ok', text: 'verified' });
    expect(at('applied')).toEqual({ tone: 'ok', text: 'applied' });
    expect(at('merged', { pr: 138 })).toEqual({ tone: 'ok', text: 'merged · PR #138' });
    expect(at('merged', { pr: null })).toEqual({ tone: 'ok', text: 'merged' });
    expect(at('applied', { broken: 'shadowlap test failed on its goldens' })).toEqual({ tone: 'err', text: 'broken' });
  });

  it('heads the page in its about line, its failing runs a link to Failed, its name muted over its title', async () => {
    const f = blamed();
    await open(f.fixId);
    expect(r!.one('.ph').className).toBe('ph fxh');
    expect(r!.all('.ph .eyebrow i')).toEqual([]);
    expect(text(r!.one('.ph .eyebrow'))).toBe('fix · double-email');
    expect(text(r!.one('.ph p.pmeta .st'))).toBe('blamed');
    const failing = r!.one('.ph p.pmeta a.dlink');
    expect(text(failing)).toBe('1 failing run');
    expect(String(failing.props.href)).toContain('failed');
    expect(JSON.parse(String(failing.props['data-tip']))).toMatchObject({ t: '1 run failed its check' });
    expect(r!.all('.ph .badge')).toEqual([]);
  });

  it('says Show patch’s card by where the patch is: in the working tree once applied, on main once merged', () => {
    const fix = (rung: FixRung, applied: boolean, pulled = false) => ({ rung, actions: { applied, apply: { pulled } } as FixDetail['actions'] });
    expect(showPatchCard(fix('applied', true))).toBe('Applied: the patch is in the working tree and its goldens pass');
    expect(showPatchCard(fix('applied', true, true))).toBe('Applied: the patch is in the working tree; its goldens are on the machine that ran the repair');
    expect(showPatchCard(fix('merged', false))).toBe('Merged: the patch is on main with its pull request');
  });
});

describe('the header’s buttons', () => {
  it('leads an open fix with Run repair, lime, as its Fixes row does', async () => {
    const f = blamed();
    await open(f.fixId);
    expect(buttons()).toEqual([['Run repair', 'btn lime']]);
  });

  it('makes Run repair wait after a repair whose gate rejected every candidate, saying why', async () => {
    const f = blamed();
    recordRepair(store, { repairId: 'repair-none', dir: '.shadowlap/repairs/repair-none', report: repairReport({ targets: [f.run], accepted: false }), expect: SEND_ONCE, command: 'shadowlap repair', at: (at += DAY) });
    await open(f.fixId);
    const repair = r!.byText('.ph .actions button', 'Run repair');
    expect([repair.className, repair.props['aria-disabled'], repair.props['data-why']]).toEqual(['btn', 'true', 'Repair rejected every candidate']);
    expect(JSON.parse(String(repair.props['data-tip']))).toMatchObject({ t: 'Run repair', s: 'Nothing has changed since its last repair, whose gate rejected every candidate: verify a change of your own' });
  });

  it('leads a verified fix with Verify this run while a failing run no accepted verdict checked is left, asking with Verify change on that run, and starts one verify of it', async () => {
    const a = blamed();
    const b = blamed();
    recordVerdict(store, { report: verifyReport([{ runId: a.run, role: 'target', pass: true }]), expect: SEND_ONCE, command: 'shadowlap verify', rerun: { flags: [], command: null }, at: (at += DAY) });
    const started: Array<[string, unknown]> = [];
    await open(a.fixId, null, { started });
    expect(buttons()).toEqual([
      ['Mark applied', 'btn'],
      ['Verify this run', 'btn lime'],
    ]);
    await r!.click(r!.byText('.ph .actions button', 'Verify this run'));
    expect(text(r!.one('.dialog h3'))).toBe(`Verify change on ${b.run.slice(0, 10)}`);
    await r!.click(r!.one('.dialog .dlg-ok'));
    expect(started).toEqual([['verify', { fixId: a.fixId, left: true }]]);
  });
});

describe('the stepper', () => {
  it('names each step in the UI face, with no number, and carries its key for Verify’s lime dot', async () => {
    const f = blamed();
    await open(f.fixId);
    expect(r!.all('nav.stepper a .k').map(text)).toEqual(['Blame', 'Repair', 'Verify']);
    expect(r!.all('nav.stepper a').map((a) => a.className)).toEqual(['done s-blame', 'todo s-repair', 'todo s-verify']);
  });

  it('says a step a job of the fix runs, from the job: its doing word, Verifying… for every verify, and what it does', async () => {
    const f = blamed();
    const d = fixDetail(store, f.fixId)!;
    const job = (kind: string, title: string, args: string[] = []) => [{ kind, title, args, fixId: f.fixId, done: false }];
    expect(runningStep(d, job('repair', 'Repairing'))).toEqual({ key: 'repair', title: 'Repairing…', meta: 'trying candidates, each in a worktree of its own' });
    expect(runningStep(d, job('blame', 'Blaming with stronger model', ['blame', f.run, '--model', 'claude-opus-5-5']))).toEqual({ key: 'blame', title: 'Blaming with stronger model…', meta: 'claude-opus-5-5 answers from the probed call' });
    expect(runningStep(d, job('verify', 'Verifying again'))).toEqual({ key: 'verify', title: 'Verifying…', meta: 'the same runs, once the judge answers' });
    expect(runningStep(d, job('verify', 'Verifying'))).toEqual({ key: 'verify', title: 'Verifying…', meta: 'the run it wasn’t verified on' });
    // Another fix's job, or one ended, says nothing here.
    expect(runningStep(d, [{ kind: 'repair', title: 'Repairing', args: [], fixId: 'other', done: false }])).toBeNull();
    expect(runningStep(d, [{ kind: 'repair', title: 'Repairing', args: [], fixId: f.fixId, done: true }])).toBeNull();
    await open(f.fixId, null, { jobs: job('repair', 'Repairing') as unknown as JobListItem[] });
    await r!.until('the jobs to load', () => r!.all('nav.stepper a.busy').length === 1);
    expect(text(r!.one('nav.stepper a.busy b'))).toBe('Repairing…');
  });
});
