import { createElement, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Estimate } from '../../engine/src/estimates/estimate.js';
import { ApiError, type ActionItem, type JobView } from '../ui/api.js';
import { jobFooter } from '../ui/job-actions.js';
import { presetsToOpen } from '../ui/presets/job-footer.js';
import { decidedWords, expectCaption, goldenJudged, presetsCommand, PresetsDialog, sentPicks, whereWords } from '../ui/presets/PresetsDialog.js';
import { openResults, panelOn, resetPanel } from '../ui/run/panel-state.js';
import { useActionRunner } from '../ui/run/actions.js';
import { presetsRow } from '../ui/run/run-commands.js';
import { shortId } from '../ui/format.js';
import { ServedPartsContext } from '../ui/served-parts.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { ToastAction } from '../ui/toast.js';
import type { PresetsPlan, RunDetail } from '../ui/types.js';
import { render, type Rendered } from './ui-render.js';
import { shownNow } from './ui-served-now.js';

/**
 * Run error-path presets…'s dialog: the presets as toggle chips, the tool they hit and where, what
 * judges and decides each attempt, the command as picked and what it bills, from the server's plan,
 * asked again a moment after a pick. Its confirm starts `chaos` with exactly the fields the command
 * shows, and a command someone else recorded asks first, in the consent dialog.
 */

const RUN = '01K5CQ4N7GZ3W8X2V6B9TDRM4P';
const ALL = ['timeout', 'empty', 'malformed', 'oversized', '429', '500'] as const;
const price = (usd: number, o: Partial<Estimate> = {}): Estimate => ({ kind: 'presets', usd, ceiling: true, parts: [], ...o });

const PLAN: PresetsPlan = {
  target: RUN,
  golden: null,
  presets: [...ALL],
  choices: [
    { name: 'lookup_order', callNo: 2, effect: 'read' },
    { name: 'get_policy', callNo: 4, effect: 'read' },
  ],
  tool: 'lookup_order',
  at: { tool: { callNo: 2, name: 'lookup_order' }, model: { callNo: 3, name: 'POST /v1/messages' } },
  judge: { source: 'exit', checks: [], from: null },
  expect: '{"tools":{"issue_refund":"<= 200"}}',
  gate: { repeat: 1, passes: 1 },
  rule: '1 of 1 attempts must pass',
  runsHere: null,
  estimate: price(0.054),
};

const GOLDEN: PresetsPlan = { ...PLAN, golden: 'goldens/refund', presets: ['timeout', '429'], expect: null, judge: { source: 'write-limits', checks: ['issue_refund called at most 1 time'], from: "the write limits of the golden's expect" }, gate: { repeat: 3, passes: 2 }, rule: '2 of 3 attempts must pass' };

type Started = Array<[string, Record<string, unknown>]>;

function app(client: Record<string, unknown>, toasts: Array<[string, ToastAction | undefined]>): AppState {
  return {
    client: { startJob: async () => ({}), jobs: async () => [], ...client },
    meta: { project: { id: 'support-agent', name: 'support-agent', path: '/work/support-agent' } },
    runs: [],
    feeds: {},
    jobs: [],
    actionsOff: null,
    hasKind: () => true,
    guard: (fn: () => void) => (fn(), true),
    watchJob: () => undefined,
    toast: (t: string, _kind?: string, action?: ToastAction) => void toasts.push([t, action]),
  } as unknown as AppState;
}

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
});

async function dialog(first: PresetsPlan, client: Record<string, unknown> = {}) {
  const started: Started = [];
  const asked: unknown[] = [];
  const toasts: Array<[string, ToastAction | undefined]> = [];
  const all = {
    presetsPlan: (_id: string, q: Record<string, unknown>) => (Object.keys(q).length ? asked.push(q) : undefined, Promise.resolve(Object.keys(q).length ? { ...first, estimate: price(0.018) } : first)),
    startJob: async (kind: string, body: Record<string, unknown>) => (started.push([kind, body]), { id: 'j1' }),
    ...client,
  };
  r = await render(createElement(AppContext.Provider, { value: app(all, toasts) }, createElement(PresetsDialog, { runId: RUN, onClose: () => undefined })));
  await r.until('the dialog reads the plan', () => r!.all('.dialog .togchips button').length === 6);
  return { started, asked, toasts };
}

const ok = () => r!.one('.dialog .dlg-ok');
const cmd = () => r!.one('.dialog .cmdline').textContent ?? '';
const rows = () => r!.all('.dialog .dfacts > div').map((d) => [d.querySelector('dt')?.textContent.replace(/\u00a0/g, ' '), d.querySelector('dd')?.textContent.replace(/\u00a0/g, ' ')]);
const pressed = () => r!.all('.dialog .togchips button').filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.textContent);

describe('Run error-path presets…’s words', () => {
  it('names only the flags the picks change, the checks typed for a run, and --yes for a command someone else recorded', () => {
    const picks = { presets: [...ALL], tool: 'lookup_order', expect: '' };
    expect(presetsCommand(PLAN, sentPicks(PLAN, picks))).toBe('shadowlap replay 01K5CQ4N7G --chaos');
    const some = sentPicks(PLAN, { presets: ['timeout', '500'], tool: 'get_policy', expect: ' {"tools":{"issue_refund":0}} ' });
    expect(some).toEqual({ presets: ['timeout', '500'], tool: 'get_policy', expect: '{"tools":{"issue_refund":0}}' });
    expect(presetsCommand({ ...PLAN, runsHere: { command: 'node agent.mjs', from: 'the team store', by: 'dana' } }, some)).toBe('shadowlap replay 01K5CQ4N7G --chaos --presets timeout,500 --chaos-tool get_policy --expect \'{"tools":{"issue_refund":0}}\' --yes');
    // A golden's presets run as its test, its entry's list the default; it takes no --expect.
    expect(sentPicks(GOLDEN, { presets: ['timeout', '429'], tool: 'lookup_order', expect: '{"tools":{}}' })).toEqual({});
    expect(presetsCommand(GOLDEN, sentPicks(GOLDEN, { presets: [...ALL], tool: 'lookup_order', expect: '' }))).toBe('shadowlap test goldens/refund --chaos --presets timeout,empty,malformed,oversized,429,500');
  });

  it('says where the provider presets hit, what judges and what decides each attempt', () => {
    expect(whereWords(PLAN.at)).toBe('and model call #3, which reads its answer');
    expect(whereWords({ tool: { none: 'no tool call' }, model: { callNo: 1, name: 'POST /v1/messages' } })).toBe('and model call #1');
    expect(whereWords({ ...PLAN.at, model: { none: 'the recording makes no model call' } })).toBe('no model call: the provider presets are not applicable');
    expect(goldenJudged(GOLDEN, 'goldens/refund')).toEqual({ value: 'issue_refund called at most 1 time', quiet: 'the write limits of refund’s expect' });
    expect(goldenJudged({ judge: { source: 'chaos.expect', checks: ['escalate called at least 1 time'], from: 'chaos.expect' } }, 'goldens/refund')).toEqual({ value: 'escalate called at least 1 time', quiet: 'refund’s chaos.expect' });
    expect(goldenJudged({ judge: { source: 'exit', checks: [], from: null } }, 'goldens/refund')).toEqual({ value: 'the agent exiting 0 alone', quiet: 'refund’s expect sets no limit on a write' });
    expect(expectCaption(PLAN.judge)).toBe('what every attempt must do besides exiting 0; empty, the exit alone');
    expect(expectCaption(GOLDEN.judge)).toBe("what every attempt must do besides exiting 0; empty, each attempt is judged by the write limits of the golden's expect");
    expect([decidedWords(PLAN), decidedWords(GOLDEN), decidedWords({ gate: { good: 0.95, bad: 0.7, risk: 0.05, max: 10 }, rule: 'a sequential test, at most 10 attempts' })]).toEqual(['one attempt each', '2 of 3 attempts must pass, as its golden repeats', 'its chaos.gate: a sequential test, at most 10 attempts']);
  });
});

describe('Run error-path presets…’s dialog', () => {
  it('waits for the plan in its shape, and says a read that failed in the line every page says, with Retry, which asks it again', async () => {
    const opened = (presetsPlan: () => Promise<PresetsPlan>) => createElement(AppContext.Provider, { value: app({ presetsPlan }, []) }, createElement(PresetsDialog, { runId: RUN, onClose: () => undefined }));
    r = await render(opened(() => new Promise<PresetsPlan>(() => undefined)));
    expect([r.all('.dialog .skel').length, ok().getAttribute('data-why')]).toEqual([1, 'Reading what the presets hit']);
    await r.unmount();
    let fail = true;
    r = await render(opened(() => (fail ? Promise.reject(new ApiError(500, 'HTTP 500')) : Promise.resolve(PLAN))));
    await r.until('the read fails', () => r!.all('.dialog .loaderr').length === 1);
    expect(r.one('.dialog .loaderr').getAttribute('role')).toBe('alert');
    expect(r.one('.dialog .loaderr p span:not(.st)').textContent).toBe('The dashboard server answered 500 for this page’s data.');
    expect([r.all('.dialog .dwarn').length, ok().getAttribute('data-why')]).toEqual([0, 'What the presets hit didn’t load']);
    fail = false;
    await r.click(r.byText('.dialog .loaderr button', 'Retry'));
    await r.until('the plan comes', () => r!.all('.dialog .togchips button').length === 6);
    expect(r.all('.dialog .loaderr')).toEqual([]);
  });

  it('draws a run’s plan: every preset on, the tool it hits and where, the checks its own failed check prefills, the command and its price', async () => {
    await dialog(PLAN);
    expect(r!.one('.dialog h3').textContent.replace(/\u00a0/g, ' ')).toBe('Run error-path presets on 01K5CQ4N7G');
    expect(pressed()).toEqual(['tool timeout', 'empty result', 'malformed JSON', 'oversized result', 'provider 429', 'provider 500']);
    expect(r!.one('.dialog .togchips').getAttribute('role')).toBe('group');
    expect(rows().map(([k]) => k)).toEqual(['Presets', 'At', 'Judged by', 'Decided by']);
    expect(r!.all('.dialog select option').map((o) => o.textContent)).toEqual(['lookup_order · #2, the first read', 'get_policy · #4']);
    // A recording with no read: the tool the command hits is a write, never called the first read.
    await r!.unmount();
    await dialog({ ...PLAN, choices: [{ name: 'issue_refund', callNo: 2, effect: 'write' }], tool: 'issue_refund' });
    expect(r!.all('.dialog select option').map((o) => o.textContent)).toEqual(['issue_refund · #2, what the command hits']);
    await r!.unmount();
    await dialog(PLAN);
    expect(r!.one('.dialog .cxat > span').textContent).toBe('and model call #3, which reads its answer');
    expect(r!.one('.dialog label.cxj input').value).toBe('{"tools":{"issue_refund":"<= 200"}}');
    expect(r!.one('.dialog label.cxj small').textContent).toBe('what every attempt must do besides exiting 0; empty, the exit alone');
    expect(rows().at(-1)).toEqual(['Decided by', 'one attempt each']);
    expect(cmd()).toBe('$shadowlap replay 01K5CQ4N7G --chaos --expect \'{"tools":{"issue_refund":"<= 200"}}\'');
  });

  it('asks the plan again a moment after a pick, waits on Pick at least one preset with none, and starts with exactly the fields the command shows', async () => {
    const { asked, started } = await dialog(PLAN);
    await r!.click(r!.byText('.dialog .togchips button', 'malformed JSON'));
    await r!.fire(r!.one('.dialog select'), 'change', { target: { value: 'get_policy' } } as never);
    await r!.type(r!.one('.dialog label.cxj input'), '');
    expect(cmd()).toBe('$shadowlap replay 01K5CQ4N7G --chaos --presets timeout,empty,oversized,429,500 --chaos-tool get_policy');
    await r!.wait(100);
    expect(asked).toEqual([]);
    // Until the plan for the picks comes, the confirm waits: the price in hand is the last picks'.
    expect([ok().getAttribute('aria-disabled'), ok().getAttribute('data-why')]).toEqual(['true', 'Pricing your picks']);
    await r!.until('the plan for the picks', () => asked.length === 1);
    expect(asked).toEqual([{ presets: ['timeout', 'empty', 'oversized', '429', '500'], tool: 'get_policy' }]);
    // Nothing picked: the confirm waits, and says why where the price was.
    for (const p of ['tool timeout', 'empty result', 'oversized result', 'provider 429', 'provider 500']) await r!.click(r!.byText('.dialog .togchips button', p));
    expect([ok().getAttribute('aria-disabled'), r!.one('.dialog .dcost').textContent.replace(/\u00a0/g, ' ')]).toEqual(['true', 'Pick at least one preset']);
    await r!.click(r!.byText('.dialog .togchips button', 'provider 429'));
    await r!.until('the price of the picks', () => asked.length === 2);
    await r!.until('the dialog is ready', () => ok().getAttribute('aria-disabled') !== 'true');
    await r!.click(ok());
    expect(started).toEqual([['chaos', { runId: RUN, presets: ['429'], tool: 'get_policy', estimate: { usd: 0.018, ceiling: true } }]]);
  });

  it('runs a command someone else recorded only once the consent dialog has its yes, resending the same fields', async () => {
    const started: Started = [];
    const startJob = async (kind: string, body: Record<string, unknown>) => {
      started.push([kind, body]);
      if (!body.confirmed) throw Object.assign(new Error('This run came from the team store: each preset runs its command (node agent.mjs). Confirm to run it.'), { status: 409, confirm: 'c-1' });
      return { id: 'j1' };
    };
    await dialog({ ...PLAN, expect: null, runsHere: { command: 'node agent.mjs', from: 'the team store', by: 'dana' } }, { startJob });
    expect(rows()[0]).toEqual(['Runs here', 'node agent.mjsrecorded by dana, from the team store']);
    expect(r!.all('.dialog .dfacts > div')[0].getAttribute('class')).toBe('amber');
    expect(cmd()).toBe('$shadowlap replay 01K5CQ4N7G --chaos --yes');
    await r!.click(ok());
    await r!.until('the consent dialog', () => r!.one('.dialog h3').textContent.replace(/\u00a0/g, ' ') === 'Run command from team store');
    await r!.click(ok());
    expect(started.map(([, b]) => b)).toEqual([
      { runId: RUN, estimate: { usd: 0.054, ceiling: true } },
      { runId: RUN, estimate: { usd: 0.054, ceiling: true }, confirmed: 'c-1' },
    ]);
  });

  it('runs a golden’s presets as its test: its entry’s presets on, its checks and gate said, no field to type', async () => {
    const { started } = await dialog(GOLDEN);
    expect(pressed()).toEqual(['tool timeout', 'provider 429']);
    expect(r!.all('.dialog label.cxj')).toHaveLength(0);
    expect(rows().slice(2)).toEqual([
      ['Judged by', 'issue_refund called at most 1 timethe write limits of refund’s expect'],
      ['Decided by', '2 of 3 attempts must pass, as its golden repeats'],
    ]);
    expect(cmd()).toBe('$shadowlap test goldens/refund --chaos');
    await r!.click(ok());
    expect(started).toEqual([['chaos', { golden: 'goldens/refund', estimate: { usd: 0.054, ceiling: true } }]]);
  });
});

describe('Run error-path presets…’s opener', () => {
  /** The fork menu's whole run hands its row to the run page's runner, as a press of the row does. */
  function Opener({ row }: { row: ActionItem }) {
    const { run, dialog } = useActionRunner(RUN);
    return createElement('div', null, createElement('button', { className: 'go', onClick: () => run({ action: row, callNo: null }) }, 'go'), dialog);
  }
  const ROW = { key: 'c', label: 'Run error-path presets…', flag: '--chaos', group: 'run', asksFirst: true, disabled: null } as unknown as ActionItem;

  it('opens the dialog from the fork menu’s row, which the served dashboard hands in, and says why where the row is off', async () => {
    const toasts: Array<[string, ToastAction | undefined]> = [];
    const client = { presetsPlan: async () => PLAN, startJob: async () => ({ id: 'j1' }) };
    const page = (row: ActionItem) => createElement(AppContext.Provider, { value: app(client, toasts) }, createElement(ServedPartsContext.Provider, { value: { PresetsDialog: shownNow(PresetsDialog) } }, createElement(Opener, { row })));
    r = await render(page(ROW));
    await r.click(r.one('button.go'));
    await r.until('the dialog', () => r!.all('.dialog .togchips button').length === 6);
    expect(r.one('.dialog h3').textContent.replace(/\u00a0/g, ' ')).toBe('Run error-path presets on 01K5CQ4N7G');
    await r.unmount();
    r = await render(page({ ...ROW, disabled: 'A preset’s attempt: run the presets on its recording' }));
    await r.click(r.one('button.go'));
    expect([r.all('.dialog').length, toasts.map(([t]) => t)]).toEqual([0, ['A preset’s attempt: run the presets on its recording']]);
  });
});

describe('Run error-path presets… in the palette', () => {
  it('is This run’s row where the fork menu’s is on, its hint the command, opening the menu’s row; none live, in a copy or where it is off', () => {
    const target = '01JC8ZK4QF7Y2W0RECORDING';
    const row = { key: 'c', label: 'Run error-path presets…', command: `shadowlap replay ${target} --chaos` };
    const run = (a: object) => ({ actions: [{ key: 'e', label: 'Edit…' }, a] }) as unknown as RunDetail;
    const opened: string[] = [];
    const o = { live: false, exported: false, open: (a: { key: string }) => opened.push(a.key) };
    const rows = presetsRow(run(row), o);
    expect(rows.map((x) => [x.group, x.label, x.hint, x.job])).toEqual([['This run', 'Run error-path presets…', `shadowlap replay ${shortId(target)} --chaos`, true]]);
    rows[0].run();
    expect(opened).toEqual(['c']);
    expect(presetsRow(run(row), { ...o, live: true })).toEqual([]);
    expect(presetsRow(run(row), { ...o, exported: true })).toEqual([]);
    expect(presetsRow(run({ ...row, disabled: 'A preset’s attempt: run the presets on its recording' }), o)).toEqual([]);
  });
});

describe('Run error-path presets…’ drawer at its end', () => {
  const g = globalThis as Record<string, unknown>;
  const job = (o: Partial<JobView> = {}): JobView => ({ id: 'j1', kind: 'chaos', title: 'Running error-path presets', runId: RUN, done: true, code: 1, endedAt: 1000, lines: [], links: [], ...o }) as unknown as JobView;
  const ran = (attempts: number, runId: string | null = RUN) => ({ results: [{ golden: null, runId, outcomes: [{ preset: 'timeout', attempts }] }] });
  afterEach(() => {
    delete g.location;
    resetPanel();
  });

  it('opens the presets’ results as the job ends over their run’s page, never over another finding’s panel', async () => {
    expect([presetsToOpen(ran(2)), presetsToOpen(ran(0)), presetsToOpen(ran(2, null)), presetsToOpen({ results: [...ran(1).results, ...ran(1).results] }), presetsToOpen(null)]).toEqual([RUN, null, null, null, null]);
    g.location = { hash: `#/run/${RUN}` };
    const Footer = jobFooter('chaos')!;
    let set: ((j: JobView) => void) | null = null;
    function Live() {
      const [j, setJ] = useState(job({ done: false, code: null, result: null }));
      set = setJ;
      return createElement(Footer, { job: j });
    }
    const live = async (then: JobView) => {
      set = null;
      r = await render(createElement(AppContext.Provider, { value: app({}, []) }, createElement(Live)));
      await r.until('the footer', () => set !== null);
      set!(then);
    };
    // A job that had ended before its drawer opened leaves the page as it is.
    r = await render(createElement(AppContext.Provider, { value: app({}, []) }, createElement(Footer, { job: job({ result: ran(2) }) })));
    expect(panelOn(RUN)).toBeNull();
    await r.unmount();
    await live(job({ result: ran(2) }));
    await r.until('the results open', () => panelOn(RUN) !== null);
    expect(panelOn(RUN)).toEqual({ runId: RUN, kind: 'results', key: 'presets' });
    await r.unmount();
    // Another finding's results stay open.
    openResults(RUN, 'injection:res1');
    await live(job({ result: ran(2) }));
    await new Promise((ok) => setTimeout(ok, 20));
    expect(panelOn(RUN)).toEqual({ runId: RUN, kind: 'results', key: 'injection:res1' });
  });
});
