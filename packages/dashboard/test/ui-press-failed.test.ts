import { createElement, useState, type ComponentType, type ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useMenu } from '../ui/components/Popover.js';
import { ToastHost } from '../ui/components/Toast.js';
import { RunBlameButton } from '../ui/fixes/RunBlame.js';
import { RevertButton } from '../ui/revert/RevertButton.js';
import type { CauseView, InjectionFinding } from '../ui/injection/model.js';
import { SERVED_PARTS } from '../ui/pages/served.js';
import { BuilderFailed } from '../ui/run/check-part.js';
import { FindingsBar, forgetOpenFindings } from '../ui/run/FindingsBar.js';
import { NextStepButton } from '../ui/run/NextStepButton.js';
import { RunHeader } from '../ui/run/RunHeader.js';
import { ServedPartsContext } from '../ui/served-parts.js';
import { ReportSteps } from '../ui/tests/ReportSteps.js';
import type { LeadPress } from '../ui/tests/Verdict.js';
import { AppContext, type AppState } from '../ui/state.js';
import type { ToastAction, ToastKind } from '../ui/toast.js';
import type { ChaosMatrix, CheckView, CoverageGroupView, GoldenReport, NextStep, RunDetail, TestsAnswer } from '../ui/types.js';
import { render, type Rendered } from './ui-render.js';

/**
 * A part that opens on a press, whose code didn't come from the dashboard server: Share's menu, the
 * fork menu, the header's …, Add check…'s menu, Revert's dialog, Run blame's dialogs, the steps'
 * dialogs, Run injection test…'s, Run error-path presets…'s, Not covered's pack dialogs, Pack with
 * injection gate…'s, the Security report, New preview's dialogs, a run's action's, Find breaking
 * commit's, a diverged test's, Edit and fork's, Remove project's and Preview pull request
 * comment's. The browser keeps a script's failure for as long as the page is open, so a press says
 * so in the error toast, in LoadFailed's words, with Retry, which loads the page again once the
 * server is back. Nothing is drawn in the part's place, so the focus stays on the button pressed,
 * which no longer says it is open, and the next press says it again. The parts drawn in place keep
 * their own: the check builder says so in a small dialog in its place, an injection test's results
 * and a recording's presets' in the panel, the test's finding, the presets' and Find cause's
 * answers in the finding's place among the run's findings, and Find cause…'s link on the write it
 * is drawn on. Here their scripts fail to come, as when the dashboard stopped.
 */

const { refused } = vi.hoisted(() => ({
  refused: () => {
    throw new TypeError('Failed to fetch dynamically imported module');
  },
}));
vi.mock('../ui/run/ShareMenu.js', refused);
vi.mock('../ui/run/ForkMenu.js', refused);
vi.mock('../ui/run/MoreMenu.js', refused);
vi.mock('../ui/fixes/RunBlameAsks.js', refused);
vi.mock('../ui/revert/RevertDialog.js', refused);
vi.mock('../ui/run/StepDialogs.js', refused);
vi.mock('../ui/injection/SecurityReportDialog.js', refused);
vi.mock('../ui/injection/InjectionResults.js', refused);
vi.mock('../ui/injection/InjectionFinding.js', refused);
vi.mock('../ui/checks/Builder.js', refused);
vi.mock('../ui/run/CheckMenu.js', refused);
vi.mock('../ui/injection/TestDialog.js', refused);
vi.mock('../ui/injection/PackWithGate.js', refused);
vi.mock('../ui/injection/FindCause.js', refused);
vi.mock('../ui/injection/CauseFinding.js', refused);
vi.mock('../ui/presets/PresetsDialog.js', refused);
vi.mock('../ui/presets/PresetsFinding.js', refused);
vi.mock('../ui/presets/PresetsResults.js', refused);
vi.mock('../ui/not-covered/PackDialog.js', refused);
vi.mock('../ui/changes/NewPreview.js', refused);
vi.mock('../ui/run/ActionDialog.js', refused);
vi.mock('../ui/run/RunDialogs.js', refused);
vi.mock('../ui/run/DivergedDialogs.js', refused);
vi.mock('../ui/run/EditDialog.js', refused);
vi.mock('../ui/shell/RemoveProject.js', refused);
vi.mock('../ui/ci/PrCommentDialog.js', refused);

const RUN = '01M5GRX8K406H4KHQ7DEKYWTSZ';
const MENU = 'This menu’s code didn’t come from the dashboard server. Retry loads the page again.';
const DIALOG = 'This dialog’s code didn’t come from the dashboard server. Retry loads the page again.';
const FINDING = 'This finding’s code didn’t come from the dashboard server. Retry loads the page again.';
const LINK = 'This link’s code didn’t come from the dashboard server. Retry loads the page again.';
const PAUSED = 'Paused until the dashboard server is back';

const run = {
  run: { runId: RUN, parentRunId: null, mode: 'record', status: 'completed', divergence: null, command: { argv: ['node', 'agent.mjs'], cwd: '/work' }, codeVersion: 'f6c5756', startedAt: 1, endedAt: 2, meta: { labels: [] } },
  label: 'recording',
  about: { text: 'Order A-1150: the customer asks for a refund', from: 'user' },
  source: null,
  summary: { cost: { spent: 0.01, saved: 0, captured: 0 }, imported: false, durationMs: 379, upstreamRequests: 8, byKind: { api: 2, tool: 1, clock: 0, random: 0 } },
  calls: [],
  parent: null,
  children: [],
  actions: [],
  fix: null,
  state: { status: 'completed', kind: 'recording', outcome: { kind: 'none' }, failed: false, interrupted: false, endedAt: 2, label: 'recording' },
} as unknown as RunDetail;

/** The run's header as its page draws it, the fork menu's state the page's. */
function Header() {
  const forkMenu = useMenu();
  return createElement(RunHeader, { run, call: null, selected: 3, rescued: false, offers: null, forkMenu, onAction: () => undefined, onFindCommit: () => undefined });
}

/** Share's Security report row, as Share's menu opens the report in its place and closes back to the row. */
function SecurityRow() {
  const [open, setOpen] = useState(false);
  const Report = SERVED_PARTS.SecurityReportDialog!;
  return createElement('div', null, createElement('button', { type: 'button', className: 'secrow', onClick: () => setOpen(true) }, 'Security report'), open ? createElement(Report, { resultId: 'inj_1', mode: 'plant', runId: RUN, onClose: () => setOpen(false) }) : null);
}

/** Run error-path presets…' row, as the fork menu's whole run opens the dialog and its close comes back to the row. */
function PresetsRow() {
  const [open, setOpen] = useState(false);
  const Presets = SERVED_PARTS.PresetsDialog!;
  return createElement('div', null, createElement('button', { type: 'button', className: 'presetsrow', onClick: () => setOpen(true) }, 'Run error-path presets…'), open ? createElement(Presets, { runId: RUN, onClose: () => setOpen(false) }) : null);
}

/** Not covered's Pack as golden (or Pack with checks…, `fork`) on a behaviour's row, as its dialog opens on the press and closes back to the row. */
function PackRow({ fork }: { fork: boolean }) {
  const [open, setOpen] = useState(false);
  const Pack = SERVED_PARTS.PackDialog!;
  const group = { key: 'aaaa0000bbbb1111' } as unknown as CoverageGroupView;
  return createElement('div', null, createElement('button', { type: 'button', className: fork ? 'packchecks' : 'packrow', onClick: () => setOpen(true) }, fork ? 'Pack with checks…' : 'Pack as golden'), open ? createElement(Pack, { group, fork, onClose: () => setOpen(false) }) : null);
}

/** Add check…'s menu at a call, as the inspector's link opens it, and its pick or Esc closes it. */
function CheckRow() {
  const [at, setAt] = useState<HTMLElement | null>(null);
  const Menu = SERVED_PARTS.CheckMenu!;
  return createElement('div', null, createElement('button', { type: 'button', className: 'ckrow', onClick: (e: { currentTarget: HTMLElement }) => setAt(e.currentTarget) }, 'Add check…'), at ? createElement(Menu, { anchor: at, call: null, onPick: () => undefined, onClose: () => setAt(null) }) : null);
}

/** Find cause's facts and its one answer on the run: #4 get_ticket caused #28 send_email. */
const CAUSE: CauseView = {
  facts: [{ write: 28, name: 'send_email', pick: 4, holds: 'refunds@acme.test' }],
  answers: [{ resultId: 'r4', verdict: 'caused', read: { callNo: 4, name: 'get_ticket' }, write: { callNo: 28, name: 'send_email' }, gone: 3, attempts: 3, bound: 'rate >= 0.29 (95%)', line: '#4 get_ticket · #28 send_email is gone in 3 of 3 clean attempts · rate >= 0.29 (95%)' }],
  rule: null,
  reads: [{ callNo: 4, name: 'get_ticket', from: 'config', readAt: 5 }],
};

/** Error-path presets run on the recording, one failed: a finding of a failure's weight, and the matrix Show results opens. */
const PRESETS = { runId: RUN, golden: null, at: 1, counts: { passed: 1, failed: 1, inconclusive: 0, notApplicable: 0 }, command: null, rule: null, judge: null, spent: 0, upstreamRequests: 0, toolCall: null, cells: [] } as unknown as ChaosMatrix;

/** The dialogs the served dashboard hands in that only a press opens, besides those its pages' own buttons open here. */
const PRESSED = ['NewPreview', 'ActionDialog', 'BisectDialog', 'DivergedDialogs', 'EditDialog', 'RemoveProject', 'PrCommentDialog'] as const;

/** A button that opens `part` as the page drawing it does: open while it is drawn, closed through its `onClose`. */
function Opens({ part }: { part: (typeof PRESSED)[number] }) {
  const [open, setOpen] = useState(false);
  const Part = SERVED_PARTS[part] as unknown as ComponentType<{ onClose: () => void }>;
  return createElement('span', null, createElement('button', { type: 'button', 'data-part': part, 'aria-expanded': open, onClick: () => setOpen(true) }, part), open ? createElement(Part, { onClose: () => setOpen(false) }) : null);
}
/** A gated golden's report on Tests, its kept result's Security report among its steps (tests/ReportSteps.tsx), which opens the same dialog as Share's. */
function TestsReport() {
  const report = { golden: 'goldens/research', name: 'research', verdict: 'failed', head: [], sub: [], parts: [{ kind: 'injection-attempts', totals: { obeyed: 1, influenced: 0, inconclusive: 0, ignored: 0 }, where: null, each: null, command: 'shadowlap injection goldens/research --html report.html', security: { resultId: 'inj_1', runId: RUN } }], open: null, failedRuns: null, hint: null, printed: [] } as unknown as GoldenReport;
  const view = { divergences: [], failures: [], inconclusive: [], steps: {} } as unknown as TestsAnswer;
  const press: LeadPress = { wait: () => null, prices: null, live: () => false, onNormalize: () => undefined, onUpdate: () => undefined, onFind: () => undefined, onMore: () => undefined, onRerun: () => undefined, runTests: null, edit: null };
  return createElement('div', { id: 'testsReport' }, createElement(ReportSteps, { report, view, press, onPress: () => undefined }));
}

/** The injection test kept for the run, its gate failed: a finding of a failure's weight. */
const INJECTION: InjectionFinding = { resultId: 'inj_1', gate: 'failed', label: 'injection test', line: 'send_email obeyed a planted instruction in 8 of 72 attempts (at most 0 allowed)', golden: null };
const PASSED: CheckView = { label: 'send_email called 0 times', ok: true, status: 'passed', detail: 'called 0 times' };

/** The run's findings as its page draws them, with the injection test kept for it. */
const findings = (detail: RunDetail, checks: CheckView[] = []) =>
  createElement(FindingsBar, { run: detail, blame: null, rescued: null, checks, offers: null, showDiff: false, onToggleDiff: () => undefined, onSelect: () => undefined, onAction: () => undefined, notes: [], injection: INJECTION });

interface Said {
  text: string;
  kind: ToastKind;
  action?: ToastAction;
}

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
  vi.unstubAllGlobals();
  forgetOpenFindings();
});

/**
 * `element` on the served dashboard, which hands in its parts, with its toasts drawn as the shell
 * draws them; what each toast said, the address bar, and whether the server can be reached.
 */
async function served(element: ReactElement) {
  const said: Said[] = [];
  const paused: string[] = [];
  const conn = { offline: false };
  const bar = { hash: `#/run/${RUN}`, search: '', pathname: '/', reload: vi.fn() };
  vi.stubGlobal('location', bar);
  let n = 0;
  const toast = (text: string, kind: ToastKind = 'notice', action?: ToastAction) => {
    said.push({ text, kind, ...(action ? { action } : {}) });
    return { id: ++n, text, kind, ...(action ? { action } : {}) };
  };
  // Offline, an action waits rather than run, and says so.
  const guard = (fn: () => void) => {
    if (conn.offline) return (paused.push(PAUSED), false);
    fn();
    return true;
  };
  function Host() {
    const [toastText, setToastText] = useState<AppState['toastText']>(null);
    const [app] = useState(() => ({
      exported: false,
      actionsOff: null,
      conn: 'ok',
      meta: { project: { id: 'p1', name: 'support-agent', path: '/repo' } },
      client: { jobs: () => Promise.resolve([]) },
      hasKind: () => true,
      guard,
      toast: (text: string, kind?: ToastKind, action?: ToastAction) => setToastText(toast(text, kind, action)),
      watchJob: () => undefined,
      refresh: () => undefined,
      reload: async () => undefined,
      jobs: [],
      live: [],
      feeds: {},
      runs: [],
      tick: 0,
      runsTick: 0,
    }));
    return createElement(AppContext.Provider, { value: { ...app, toastText } as unknown as AppState }, createElement(ServedPartsContext.Provider, { value: SERVED_PARTS }, element), createElement(ToastHost));
  }
  r = await render(createElement(Host));
  return { said, paused, conn, bar };
}

/** Presses `button` and waits for the toast it puts up: the page's toasts as each was said. */
async function press(button: () => ReturnType<Rendered['one']>, said: Said[]) {
  const before = said.length;
  await r!.click(button());
  await r!.until('the toast that says the code didn’t come', () => said.length > before);
  return said.slice(before);
}

/** What a press drew: the toast's words and its button, the button the focus is on, and any menu or dialog. */
function drawn() {
  const toast = r!.all('.toasts .toast.err');
  return {
    toast: toast.map((t) => t.querySelector('span')!.textContent),
    retry: toast.flatMap((t) => t.querySelectorAll('.tbtn').map((b) => b.textContent)),
    menus: r!.all('[role="menu"]').length,
    dialogs: r!.all('[role="dialog"]').length,
  };
}

describe('a part that opens on a press, whose code didn’t come', () => {
  it('says so of Share’s menu, the fork menu and the header’s … in the error toast, nothing in their place, the focus kept on the button, and again on the next press', async () => {
    const { said } = await served(createElement(Header));
    for (const id of ['#shareBtn', '#forkBtn', '#moreBtn']) {
      const button = () => r!.one(id);
      for (const time of [1, 2]) {
        const toasts = await press(button, said);
        expect(toasts.map((t) => [t.text, t.kind, t.action?.label]), `${id}, press ${time}`).toEqual([[MENU, 'error', 'Retry']]);
        // The toast never takes the focus: it stays on the button pressed.
        expect(toasts[0].action?.focus).toBeUndefined();
        expect(r!.focused(), `${id}, press ${time}`).toBe(button());
        expect(button().getAttribute('aria-expanded'), `${id} no longer says its menu is open`).toBe('false');
        expect(drawn()).toEqual({ toast: [MENU], retry: ['Retry'], menus: 0, dialogs: 0 });
      }
    }
  });

  it('says so of Run blame’s dialogs, a step’s, Run injection test…’s, Run error-path presets…’s, Not covered’s two pack dialogs, Pack with injection gate…’s, Revert’s and the Security report, Share’s and Tests’, in the dialog’s words, the focus kept on the button, and again on the next press', async () => {
    const step: NextStep = { key: 'update-golden', label: 'Update golden', golden: 'goldens/refund-in-limit', test: null, sub: 'Asks the judge once, live, and keeps its verdict in the pack', command: 'shadowlap test goldens/refund-in-limit --update' };
    const revert = { key: 'revert', label: 'Revert', golden: 'goldens/refund-in-limit', rev: 'ccccccc', merge: false, live: [], blame: null, title: 'Revert ccccccc', sub: 'Log the total: undone in your working tree, then refund-in-limit replayed offline', command: 'git revert --no-commit ccccccc && shadowlap test goldens/refund-in-limit' } as unknown as Extract<NextStep, { key: 'revert' }>;
    const stepRun = { run: { runId: RUN, parentRunId: null, status: 'completed', meta: {} }, actions: [], children: [], calls: [] } as unknown as RunDetail;
    const test = { key: 'injection-test', label: 'Run injection test…', runId: RUN, command: `shadowlap injection ${RUN.slice(0, 10)}`, sub: 'It stopped at its budget: test with fewer templates, or a higher budget', reads: [RUN], price: null } as unknown as NextStep;
    const gate = { key: 'pack-gate', label: 'Pack with injection gate…', runId: RUN, folder: 'goldens/refund-in-limit', gate: { obeyed: 0, repeat: 3 }, title: `Pack ${RUN.slice(0, 10)} with injection gate`, sub: 'Packs the run, writes its gate into its tests entry and tests it', command: `shadowlap pack ${RUN.slice(0, 10)} goldens/refund-in-limit` } as unknown as NextStep;
    const { said } = await served(
      createElement(
        'div',
        null,
        createElement(RunBlameButton, { runId: RUN, offer: { failed: [], from: 'exit' }, capture: true, line: `shadowlap blame ${RUN.slice(0, 10)} --expect '{"calls":[]}' -- <your command>` }),
        createElement(NextStepButton, { run: stepRun, step, offers: null, onAction: () => undefined, onFindCommit: () => undefined }),
        createElement(NextStepButton, { run: stepRun, step: test, offers: null, onAction: () => undefined, onFindCommit: () => undefined }),
        createElement(NextStepButton, { run: stepRun, step: gate, offers: null, onAction: () => undefined, onFindCommit: () => undefined }),
        createElement(RevertButton, { step: revert, found: null, estimate: null, runId: RUN }),
        createElement(SecurityRow),
        createElement(PresetsRow),
        createElement(PackRow, { fork: false }),
        createElement(PackRow, { fork: true }),
        createElement(TestsReport),
      ),
    );
    const buttons: Array<[string, () => ReturnType<Rendered['one']>]> = [
      ['Run blame', () => r!.byText('button', 'Run blame')],
      ['Update golden', () => r!.byText('button', 'Update golden')],
      ['Run injection test…', () => r!.byText('button', 'Run injection test…')],
      ['Pack with injection gate…', () => r!.byText('button', 'Pack with injection gate…')],
      ['Revert', () => r!.byText('button', 'Revert')],
      ['Security report', () => r!.one('button.secrow')],
      ['Run error-path presets…', () => r!.one('button.presetsrow')],
      ['Pack as golden', () => r!.one('button.packrow')],
      ['Pack with checks…', () => r!.one('button.packchecks')],
      ['Tests’ Security report', () => r!.one('#testsReport button')],
    ];
    for (const [name, button] of buttons) {
      for (const time of [1, 2]) {
        const toasts = await press(button, said);
        expect(toasts.map((t) => [t.text, t.kind, t.action?.label]), `${name}, press ${time}`).toEqual([[DIALOG, 'error', 'Retry']]);
        expect(r!.focused(), `${name}, press ${time}`).toBe(button());
        expect(drawn()).toEqual({ toast: [DIALOG], retry: ['Retry'], menus: 0, dialogs: 0 });
      }
    }
  });

  it('says so of Add check…’s menu in the menu’s words, the focus kept on the button, and again on the next press', async () => {
    const { said } = await served(createElement(CheckRow));
    const button = () => r!.one('button.ckrow');
    for (const time of [1, 2]) {
      const toasts = await press(button, said);
      expect(toasts.map((t) => [t.text, t.kind, t.action?.label]), `press ${time}`).toEqual([[MENU, 'error', 'Retry']]);
      expect(r!.focused(), `press ${time}`).toBe(button());
      expect(drawn()).toEqual({ toast: [MENU], retry: ['Retry'], menus: 0, dialogs: 0 });
    }
  });

  it('says so of New preview’s dialogs, a run’s action’s, Find breaking commit’s, a diverged test’s, Edit and fork’s, Remove project’s and Preview pull request comment’s in the dialog’s words, each closed, and again on the next press', async () => {
    const { said } = await served(createElement('div', null, ...PRESSED.map((part) => createElement(Opens, { key: part, part }))));
    for (const part of PRESSED) {
      const button = () => r!.one(`button[data-part="${part}"]`);
      for (const time of [1, 2]) {
        const toasts = await press(button, said);
        expect(toasts.map((t) => [t.text, t.kind, t.action?.label]), `${part}, press ${time}`).toEqual([[DIALOG, 'error', 'Retry']]);
        expect(button().getAttribute('aria-expanded'), `${part} no longer says it is open`).toBe('false');
        expect(drawn()).toEqual({ toast: [DIALOG], retry: ['Retry'], menus: 0, dialogs: 0 });
      }
    }
  });

  it('loads the page again from the toast’s Retry once the server is back, and waits while it can’t be reached', async () => {
    const { said, paused, conn, bar } = await served(createElement(Header));
    const share = () => r!.one('#shareBtn');
    conn.offline = true;
    await press(share, said);
    await r!.click(r!.byText('.toast .tbtn', 'Retry'));
    expect(bar.reload).not.toHaveBeenCalled();
    expect(paused).toEqual([PAUSED]);
    conn.offline = false;
    await press(share, said);
    await r!.click(r!.byText('.toast .tbtn', 'Retry'));
    expect(bar.reload).toHaveBeenCalledTimes(1);
  });
});

describe('a part drawn in place, whose code didn’t come', () => {
  it('keeps its own: the check builder’s small dialog from its entry, and the results panels’ lines, with no toast', async () => {
    const { said } = await served(
      createElement(
        'div',
        null,
        createElement(BuilderFailed.Provider, { value: createElement('p', { className: 'nobuilder' }, 'the entry’s dialog') }, createElement(SERVED_PARTS.CheckBuilder!, { golden: 'goldens/refund-in-limit', edit: null, onClose: () => undefined })),
        createElement(SERVED_PARTS.InjectionResults!, { runId: RUN, resultId: 'inj_1' }),
        createElement(SERVED_PARTS.PresetsResults!, { matrix: PRESETS, about: null }),
      ),
    );
    await r!.until('the parts’ own fallbacks', () => r!.all('.nobuilder').length === 1 && r!.all('.loaderr').length === 2);
    for (const line of r!.all('.loaderr')) {
      expect(line.getAttribute('role')).toBe('alert');
      expect(line.querySelector('p span:not(.st)')!.textContent).toBe('This panel’s code didn’t come from the dashboard server. Retry loads the page again.');
    }
    await r!.wait(20);
    expect(said).toEqual([]);
    expect(r!.all('.toast')).toHaveLength(0);
  });

  it('says so of an injection test’s finding where the finding goes, with its Retry, the run’s other findings still drawn, and no toast', async () => {
    // A failed test leads a run whose checks passed: its line in the finding's place, with its Retry,
    // and the bar's toggle at its end, which still opens the rest.
    const { said, paused, conn, bar } = await served(findings(run, [PASSED]));
    await r!.until('the finding’s line', () => r!.all('.loaderr').length === 1);
    const slots = () => r!.one('#findings').children.map((s) => [s.className, s.getAttribute('data-finding')]);
    expect(slots()).toEqual([
      ['banner wrap', 'injection'],
      ['banner live ck fx', null],
    ]);
    const lost = r!.one('[data-finding="injection"]');
    const line = lost.querySelector('.loaderr')!;
    expect(line.getAttribute('role')).toBe('alert');
    expect(line.querySelector('p span:not(.st)')!.textContent).toBe(FINDING);
    expect(lost.querySelectorAll('button').map((b) => b.textContent)).toEqual(['Retry', '2 findings']);
    await r!.click(r!.one('.findings .fmore'));
    expect(r!.one('#findings').className).toBe('findings open');
    expect(r!.one('.findings .banner.ck').textContent).toContain('send_email called 0 times');
    // Retry loads the page again once the server is back, and waits while it can't be reached.
    conn.offline = true;
    await r!.click(r!.byText('.loaderr button', 'Retry'));
    expect(bar.reload).not.toHaveBeenCalled();
    expect(paused).toEqual([PAUSED]);
    conn.offline = false;
    await r!.click(r!.byText('.loaderr button', 'Retry'));
    expect(bar.reload).toHaveBeenCalledTimes(1);
    expect(said).toEqual([]);
    // Behind the finding that leads the bar, its line waits with the bar closed, as the finding would.
    await r!.unmount();
    r = null;
    const after = await served(findings({ ...run, notRecorded: { tools: ['Bash'], hosts: [] } }));
    await r!.until('the finding’s line', () => r!.all('.loaderr').length === 1);
    expect(slots()).toEqual([
      ['banner blame', null],
      ['banner wrap fx', 'injection'],
    ]);
    expect(r!.one('.findings .fmore').textContent).toBe('2 findings');
    expect(after.said).toEqual([]);
  });

  it('says so of the presets’ finding where the finding goes, with its Retry and the bar’s toggle, and no toast', async () => {
    const { said } = await served(createElement(FindingsBar, { run, blame: null, rescued: null, checks: [PASSED], offers: null, showDiff: false, onToggleDiff: () => undefined, onSelect: () => undefined, onAction: () => undefined, notes: [], presets: PRESETS }));
    await r!.until('the finding’s line', () => r!.all('.loaderr').length === 1);
    const lost = r!.one('[data-finding="presets"]');
    expect(lost.className).toBe('banner wrap');
    expect(lost.querySelector('.loaderr p span:not(.st)')!.textContent).toBe(FINDING);
    expect(lost.querySelectorAll('button').map((b) => b.textContent)).toEqual(['Retry', '2 findings']);
    await r!.wait(20);
    expect(said).toEqual([]);
    expect(r!.all('.toast')).toHaveLength(0);
  });

  it('says so of Find cause…’s link on the write it is drawn on alone, and of its answers where the finding goes, with no toast', async () => {
    const { said } = await served(
      createElement(
        'div',
        null,
        createElement('div', { className: 'w28' }, createElement(SERVED_PARTS.FindCause!, { runId: RUN, callNo: 28, cause: CAUSE })),
        createElement('div', { className: 'r4' }, createElement(SERVED_PARTS.FindCause!, { runId: RUN, callNo: 4, cause: CAUSE })),
        createElement(FindingsBar, { run, blame: null, rescued: null, checks: [], offers: null, showDiff: false, onToggleDiff: () => undefined, onSelect: () => undefined, onAction: () => undefined, notes: [], cause: CAUSE }),
      ),
    );
    await r!.until('the link’s and the answers’ lines', () => r!.all('.loaderr').length === 2);
    expect(r!.one('.w28 .loaderr').getAttribute('role')).toBe('alert');
    expect(r!.one('.w28 .loaderr p span:not(.st)').textContent).toBe(LINK);
    expect(r!.one('.r4').children, 'a read: no link, so nothing in its place').toHaveLength(0);
    const lost = r!.one('[data-finding="cause"]');
    expect(lost.className).toBe('banner wrap');
    expect(lost.querySelector('.loaderr p span:not(.st)')!.textContent).toBe(FINDING);
    await r!.wait(20);
    expect(said).toEqual([]);
    expect(r!.all('.toast')).toHaveLength(0);
  });
});
