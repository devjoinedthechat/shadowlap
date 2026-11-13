import { createElement, useState, type ComponentType, type ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useMenu } from '../ui/components/Popover.js';
import { ToastHost } from '../ui/components/Toast.js';
import { RunBlameButton } from '../ui/fixes/RunBlame.js';
import { RevertButton } from '../ui/revert/RevertButton.js';
import type { InjectionFinding } from '../ui/injection/model.js';
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
import type { CheckView, GoldenReport, NextStep, RunDetail, TestsAnswer } from '../ui/types.js';
import { render, type Rendered } from './ui-render.js';

/**
 * A part that opens on a press, whose code didn't come from the dashboard server: Share's menu, the
 * fork menu, the header's …, Revert's dialog, Run blame's dialogs, the steps' dialogs, the Security
 * report, New preview's dialogs, a run's action's, Find breaking commit's, a diverged test's, Edit
 * and fork's, Remove project's and Preview pull request comment's. The browser keeps a script's
 * failure for as long as the page is open, so a press says so in the error toast, in LoadFailed's
 * words, with Retry, which loads the page again once the server is back. Nothing is drawn in the
 * part's place, so the focus stays on the button pressed, which no longer says it is open, and the
 * next press says it again. The parts drawn in place keep their own: the check builder says so in a
 * small dialog in its place, an injection test's results in the panel, and its finding in the
 * finding's place among the run's findings. Here their scripts fail to come, as when the dashboard
 * stopped.
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

  it('says so of Run blame’s dialogs, a step’s, Revert’s and the Security report, Share’s and Tests’, in the dialog’s words, the focus kept on the button, and again on the next press', async () => {
    const step: NextStep = { key: 'update-golden', label: 'Update golden', golden: 'goldens/refund-in-limit', test: null, sub: 'Asks the judge once, live, and keeps its verdict in the pack', command: 'shadowlap test goldens/refund-in-limit --update' };
    const revert = { key: 'revert', label: 'Revert', golden: 'goldens/refund-in-limit', rev: 'ccccccc', merge: false, live: [], blame: null, title: 'Revert ccccccc', sub: 'Log the total: undone in your working tree, then refund-in-limit replayed offline', command: 'git revert --no-commit ccccccc && shadowlap test goldens/refund-in-limit' } as unknown as Extract<NextStep, { key: 'revert' }>;
    const stepRun = { run: { runId: RUN, parentRunId: null, status: 'completed', meta: {} }, actions: [], children: [], calls: [] } as unknown as RunDetail;
    const { said } = await served(
      createElement(
        'div',
        null,
        createElement(RunBlameButton, { runId: RUN, offer: { failed: [], from: 'exit' }, capture: true, line: `shadowlap blame ${RUN.slice(0, 10)} --expect '{"calls":[]}' -- <your command>` }),
        createElement(NextStepButton, { run: stepRun, step, offers: null, onAction: () => undefined, onFindCommit: () => undefined }),
        createElement(RevertButton, { step: revert, found: null, estimate: null, runId: RUN }),
        createElement(SecurityRow),
        createElement(TestsReport),
      ),
    );
    const buttons: Array<[string, () => ReturnType<Rendered['one']>]> = [
      ['Run blame', () => r!.byText('button', 'Run blame')],
      ['Update golden', () => r!.byText('button', 'Update golden')],
      ['Revert', () => r!.byText('button', 'Revert')],
      ['Security report', () => r!.one('button.secrow')],
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
  it('keeps its own: the check builder’s small dialog from its entry, and the results panel’s line, with no toast', async () => {
    const { said } = await served(
      createElement(
        'div',
        null,
        createElement(BuilderFailed.Provider, { value: createElement('p', { className: 'nobuilder' }, 'the entry’s dialog') }, createElement(SERVED_PARTS.CheckBuilder!, { golden: 'goldens/refund-in-limit', edit: null, onClose: () => undefined })),
        createElement(SERVED_PARTS.InjectionResults!, { runId: RUN, resultId: 'inj_1' }),
      ),
    );
    await r!.until('both parts’ own fallbacks', () => r!.all('.nobuilder').length === 1 && r!.all('.loaderr').length === 1);
    const line = r!.one('.loaderr');
    expect(line.getAttribute('role')).toBe('alert');
    expect(line.querySelector('p span:not(.st)')!.textContent).toBe('This panel’s code didn’t come from the dashboard server. Retry loads the page again.');
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
});
