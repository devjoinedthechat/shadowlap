import { createElement, type ReactElement } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ActionItem, BisectChoices, CallDetail, FixDetail, NextStep, RunDetail, ScoreDialogView, TrainingView } from '../ui/types.js';
import { DatasetDialog } from '../ui/components/DatasetDialog.js';
import { ConsentDialog, Dialog, PromptDialog } from '../ui/components/Dialog.js';
import { StopJobDialog } from '../ui/components/Drawer.js';
import { UpdateGoldenDialog } from '../ui/components/UpdateGolden.js';
import { DOCS, docsHref, type DocKey } from '../ui/docs-links.js';
import { ApplyDialog, PatchDialog, RenameFixDialog, RepairDialog, StrongerDialog } from '../ui/fixes/FixPage.js';
import { CheckDialog } from '../ui/fixes/CheckDialog.js';
import { PrCommentDialog } from '../ui/ci/PrCommentDialog.js';
import { RunBlameButton } from '../ui/fixes/RunBlame.js';
import { updateOutdatedAsk } from '../ui/fixes/dialog-words.js';
import { stopAsk } from '../ui/jobs.js';
import { RecordRunDialog } from '../ui/pages/Setup.js';
import { ExportPairsDialog, ScoreDialog, TaskUpdateDialog } from '../ui/pages/Training.js';
import { FindCommitDialog, NormalizeUpdateDialog, UpdateGoldensDialog } from '../ui/pages/TestsDialogs.js';
import { ReplaceSkillsDialog } from '../ui/pages/settings/Agents.js';
import { CleanupDialog } from '../ui/pages/settings/jobs.js';
import { RuleDialog } from '../ui/pages/settings/RuleTable.js';
import { AddServerDialog } from '../ui/pages/settings/Tools.js';
import { ActionDialog } from '../ui/run/ActionDialog.js';
import { NextStepButton } from '../ui/run/NextStepButton.js';
import { EditDialog } from '../ui/run/EditDialog.js';
import { BisectDialog, DeleteRunDialog } from '../ui/run/RunDialogs.js';
import { OtelDialog } from '../ui/run/OtelDialog.js';
import { BulkBar, PackDialog } from '../ui/runspage/BulkBar.js';
import { FindCommitDialog as RunsFindCommit } from '../ui/runspage/FindCommit.js';
import { ImportDialog } from '../ui/runspage/ImportDialog.js';
import { RemoveProjectDialog } from '../ui/shell/RemoveProject.js';
import { AppContext, type AppState } from '../ui/state.js';
import { TestsAskHost } from '../ui/fixes/TestsAskHost.js';
import { answerTestsQuestion, moreAttemptsAsk, startTestsJob, type TestsAsk } from '../ui/tests-ask.js';
import { packRunCommand } from '../ui/run/share.js';
import { importWords } from '../ui/runspage/imports.js';
import { ApiError, type BisectOffer, type TestsView } from '../ui/api.js';
import { render, type Rendered } from './ui-render.js';
import { resetSpending } from '../ui/spending.js';
import { maskFirst } from '../ui/update-plan.js';

/**
 * One dialog anatomy: every dialog and every ask before a job, drawn as the page draws it, read for
 * what the anatomy promises. A title that is verb and object, ending in "?" only where it changes the
 * working tree or deletes; a lead of one sentence ending on its docs; at most one amber or red line;
 * the slots in their order; Cancel, then the way on; first focus by the rule; and a description that
 * names the warning, then the lead, never the link.
 */

/** What opens a dialog's title: an action's verb, as every button starts. */
const VERB = /^(Add|Apply|Delete|Edit and fork|Export|Fail|Find|Finish|Force|Free|Import|Inject|Mark|Override|Pack|Plant|Preview|Record|Remove|Rename|Repeat|Replace|Replay|Re-run|Run|Score|Show|Stop|Switch|Update|Use)\b/;

interface Expect {
  title: string | RegExp;
  /** Its docs link, by key; null where it has none. */
  doc: DocKey | null;
  /** What takes the focus first: a selector inside the dialog. */
  first: string;
  /** Its way on's words; null for Close alone. */
  ok: string | null;
  /** Its colour. */
  tone?: 'lime' | 'danger' | 'plain';
  warn?: string | RegExp;
  tick?: boolean;
}

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
});
beforeAll(() => {
  Object.assign(globalThis, { innerWidth: 1440, innerHeight: 900 });
});

function appWith(over: Record<string, unknown> = {}): AppState {
  return {
    exported: false,
    actionsOff: null,
    conn: 'ok',
    meta: { project: { id: 'p1', name: 'support-agent', path: '/repo' }, uploadLimit: 1024 },
    hasKind: () => true,
    guard: (fn: () => void) => {
      fn();
      return true;
    },
    toast: () => undefined,
    watchJob: () => undefined,
    reload: async () => undefined,
    jobs: [],
    client: {},
    ...over,
  } as unknown as AppState;
}

/** Reads a dialog as it is drawn, against what it promises. */
function holds(page: Rendered, want: Expect): void {
  const dialog = page.one('[role="dialog"]');
  const title = page.one('[role="dialog"] h3').textContent;
  if (typeof want.title === 'string') expect(title).toBe(want.title);
  else expect(title).toMatch(want.title);
  expect(title, 'verb and object').toMatch(VERB);
  expect(title, 'no ellipsis').not.toMatch(/…$/);
  // The lead: one sentence, in its own span, then its link.
  const lead = page.all('[role="dialog"] header p span')[0].textContent;
  expect(lead, 'a lead').toMatch(/^[A-Z].*[.…]$/);
  expect(lead, 'one sentence').not.toMatch(/\.\s+[A-Z]/);
  const links = page.all('[role="dialog"] header a');
  if (want.doc) {
    expect(links, `${title} ends on its docs`).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe(docsHref(DOCS[want.doc]));
    expect(links[0].getAttribute('target')).toBe('_blank');
    expect(links[0].getAttribute('rel')).toBe('noopener');
    expect(links[0].textContent).toBe(`${DOCS[want.doc].what} in the docs\u00a0→`);
    expect(links[0].querySelectorAll('[aria-hidden="true"]')[0].textContent).toContain('→');
  } else expect(links).toEqual([]);
  // One line at most.
  const lines = page.all('[role="dialog"] .dwarn');
  expect(lines.length, 'one line at most').toBeLessThanOrEqual(1);
  if (want.warn === undefined) expect(lines).toEqual([]);
  else if (typeof want.warn === 'string') expect(lines[0].textContent).toBe(want.warn);
  else expect(lines[0].textContent).toMatch(want.warn);
  // What a screen reader hears: the line, then the lead, never the link.
  const described = (dialog.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean);
  expect(described.length, 'described').toBeGreaterThan(0);
  expect(described.at(-1)).toMatch(/lead$/);
  if (lines.length) expect(described[0]).toMatch(/warn$/);
  // The footer: Cancel first, the way on after it.
  const footer = page.all('[role="dialog"] footer button').filter((b) => !b.getAttribute('hidden') && !b.props.hidden);
  expect(footer[0].className, 'Cancel or Close first').toContain('dlg-cancel');
  if (want.ok === null) {
    expect(footer.map((b) => b.textContent)).toEqual(['Close']);
  } else {
    const ok = page.one('[role="dialog"] .dlg-ok');
    expect(ok.textContent).toBe(want.ok);
    expect(ok.textContent, 'never a generic word').not.toMatch(/^(OK|Fork|Yes|Confirm|Run)$/);
    const tone = want.tone ?? 'lime';
    if (tone === 'plain') expect(ok.className).not.toMatch(/lime|danger|solid/);
    else expect(ok.className).toContain(tone);
  }
  // First focus by rule.
  expect(page.focused(), `${title} starts on ${want.first}`).toBe(page.all(`[role="dialog"] ${want.first}`)[0]);
}

async function open(element: ReactElement, app: AppState = appWith()): Promise<Rendered> {
  r = await render(createElement(AppContext.Provider, { value: app }, element));
  return r;
}

const closes = { onClose: () => undefined };
const FIELD = 'textarea, input[type="text"], select';
const CANCEL = '.dlg-cancel';
const OK = '.dlg-ok';

function action(key: string, label: string, extra: Partial<ActionItem> = {}): ActionItem {
  return { key, label, opensRun: true, prompt: { label: 'Answer:' }, disabled: null, ...extra };
}
const fork = (a: ActionItem, callNo: number | null = 17, callName = 'lookup_order') => createElement(ActionDialog, { runId: '01K5CQ4N7G0000000000000000', capture: false, forkAt: 15, pending: { action: a, callNo, callName }, onRun: () => true, ...closes });

describe('a fork’s ask', () => {
  const choices = [{ value: 'timeout', label: 'timeout' }];
  it.each<[string, ActionItem, Expect]>([
    ['Inject instruction', action('i', 'Inject instruction…', { flag: '--inject 17=… --inject-as user' }), { title: 'Inject instruction at #17', doc: 'injectInstruction', first: FIELD, ok: 'Inject instruction' }],
    ['Switch model', action('m', 'Switch model from here…', { flag: '--model 17:…' }), { title: 'Switch model from #17', doc: 'switchModel', first: FIELD, ok: 'Switch model from #17' }],
    ['Fail with HTTP status', action('f', 'Fail with HTTP status…', { flag: '--fail-at 17=429', prompt: { label: 'Status:', initial: '429', choices: [{ value: '429', label: 'HTTP 429' }] } }), { title: 'Fail #17 with HTTP status', doc: 'failWithStatus', first: FIELD, ok: 'Fail with HTTP status' }],
    ['Override result', action('o', 'Override result…', { flag: '--override 17=…' }), { title: 'Override #17 lookup_order', doc: 'overrideResult', first: FIELD, ok: 'Override result' }],
    ['Fail with tool error', action('t', 'Fail with tool error…', { flag: '--fail-at 17=timeout', prompt: { label: 'How:', initial: 'timeout', choices } }), { title: 'Fail #17 lookup_order with tool error', doc: 'failWithToolError', first: FIELD, ok: 'Fail with tool error' }],
    ['Override user reply', action('u', 'Override user reply…', { flag: '--override 17=…' }), { title: 'Override user reply at #17', doc: 'overrideResult', first: FIELD, ok: 'Override user reply' }],
    ['Plant instruction', action('x', 'Plant instruction…', { flag: '--inject-result 17=… --repeat 3', prompt: { label: 'Text:', choices } }), { title: 'Plant instruction in #17 lookup_order', doc: 'plantInstruction', first: FIELD, ok: 'Plant instruction' }],
    ['Repeat fork 5 times', action('e', 'Repeat 5 times', { flag: '--repeat 5', prompt: null, asksFirst: true, command: 'shadowlap replay 01K5CQ4N7G --repeat 5' }), { title: 'Repeat fork 5 times', doc: 'repeatFork', first: OK, ok: 'Repeat 5 times' }],
    ['Force a write live', action('l', 'Force send_email live', { flag: '--live-tool send_email', prompt: null, asksFirst: true, warns: 'send_email acts on your systems' }), { title: 'Force lookup_order live', doc: 'forceLive', first: CANCEL, ok: 'Force lookup_order live', tone: 'danger', warn: 'send_email acts on your systems' }],
    ['Replay with your command', action('r', 'Replay with your command…', { flag: 'replay', prompt: { label: 'What starts your agent?', placeholder: 'python agent.py' } }), { title: 'Replay with your command', doc: 'imports', first: FIELD, ok: 'Replay with your command' }],
  ])('%s', async (_name, a, want) => {
    const shown = a.key === 'r' ? fork(a, null) : a.key === 'l' ? createElement(ActionDialog, { runId: '01K5CQ4N7G0000000000000000', capture: false, forkAt: null, pending: { action: { ...a, label: 'Force lookup_order live' }, callNo: 17, callName: 'lookup_order' }, onRun: () => true, ...closes }) : fork(a);
    holds(await open(shown), want);
  });

  it('draws what was typed as one command, `&&`, `$&` and all, and copies it whole', async () => {
    const writes: string[] = [];
    vi.stubGlobal('navigator', { clipboard: { writeText: (t: string) => (writes.push(t), Promise.resolve()) } });
    try {
      const page = await open(fork(action('i', 'Inject instruction…', { flag: '--inject 17=… --inject-as user' })));
      await page.type(page.one('[role="dialog"] textarea'), "Check a && b first, pay $& and $' here");
      const want = 'shadowlap replay 01K5CQ4N7G --inject 17="Check a && b first, pay \\$& and \\$\' here" --inject-as user';
      expect(page.all('[role="dialog"] .cmdline .cstep')).toEqual([]);
      expect(page.one('[role="dialog"] .cmdline').textContent).toBe(`$${want}`);
      await page.click(page.one('[role="dialog"] .cmdline button.boxcopy'));
      await page.wait(0);
      expect(writes).toEqual([want]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('sets in code the tool a write forced live names in its red line, and what a tool error with no message sends', async () => {
    const live = await open(createElement(ActionDialog, { runId: '01K5CQ4N7G0000000000000000', capture: false, forkAt: null, pending: { action: action('l', 'Force send_email live', { flag: '--live-tool send_email', prompt: null, asksFirst: true, warns: 'send_email acts on your systems' }), callNo: 17, callName: 'send_email' }, onRun: () => true, ...closes }));
    expect(live.all('[role="dialog"] .dwarn code').map((c) => c.textContent)).toEqual(['send_email']);
    await live.unmount();
    const choices = [{ value: 'timeout', label: 'timeout' }, { value: 'error:', label: 'error, with a message', text: 'Message' }];
    const page = await open(fork(action('t', 'Fail with tool error…', { flag: '--fail-at 17=timeout', prompt: { label: 'How:', initial: 'error:', choices } })));
    expect(page.one('[role="dialog"] .cmdline').textContent).toBe('$shadowlap replay 01K5CQ4N7G --fail-at 17=error');
  });

  it('names a red line first to a screen reader, then the lead, and a run’s field by name', async () => {
    const page = await open(fork(action('i', 'Inject instruction…', { flag: '--inject 17=… --inject-as user', prompt: { label: 'This run came from an imported pack; replaying it runs: node a.js. Instruction to add at #17:' } })));
    holds(page, { title: 'Inject instruction at #17', doc: 'injectInstruction', first: FIELD, ok: 'Inject instruction', warn: 'This run came from an imported pack; replaying it runs: node a.js' });
    expect(page.one('[role="dialog"] textarea').getAttribute('aria-label')).toBe('The instruction');
  });

  it.each([
    ['This run from an imported pack', '01M53N822K came from an imported pack: this runs the command it was recorded with (node t.mjs). Confirm it to run it', 'Run command from imported pack'],
    ['A teammate’s', '01M53N7ZKV came from the team store: this runs the command it was recorded with (node s.mjs). Confirm it to run it', 'Run command from team store'],
    ['A program’s', '01M53N7ZKW came from a program that sent the sidecar its command: this runs the command it was recorded with (node a.mjs). Confirm it to run it', 'Run command a program sent'],
  ])('the consent question: %s', async (_name, why, title) => {
    holds(await open(createElement(ConsentDialog, { why, ok: 'Run command', onOk: () => true, ...closes })), { title, doc: 'commandsFromSomeoneElse', first: CANCEL, ok: 'Run command', warn: why });
  });
});

describe('a run’s dialogs', () => {
  const RUN = '01K5CQ4N7G0000000000000000';
  const CALL = { call: { callNo: 16, name: 'lookup_policy', kind: 'tool' }, result: { result: { a: 1 } }, actions: [] } as unknown as CallDetail;
  const OVERRIDE = action('o', 'Override result…', { flag: '--override 16=…', prompt: { label: 'Result:' } });
  const offer = { target: { kind: 'run', runId: RUN }, failed: true, good: 'c91d0f4', bad: 'd2e8a1f', revisions: [{ rev: 'c91d0f4', at: 1, runs: 3, failed: 0 }], fork: false, live: false } as unknown as BisectOffer;

  it('Delete run', async () => {
    holds(await open(createElement(DeleteRunDialog, { runId: RUN, attempts: 3, onOk: () => undefined, ...closes })), { title: 'Delete 01K5CQ4N7G?', doc: 'deletingRuns', first: CANCEL, ok: 'Delete run', tone: 'danger' });
  });
  it('Edit and fork', async () => {
    holds(await open(createElement(EditDialog, { runId: RUN, detail: CALL, action: OVERRIDE, onFork: () => Promise.resolve(), ...closes })), { title: 'Edit and fork #16 lookup_policy', doc: 'overrideResult', first: FIELD, ok: 'Edit and fork' });
  });
  it('Pack, of several', async () => {
    const client = { offers: () => new Promise(() => undefined) };
    holds(await open(createElement(PackDialog, { ids: [RUN, '01K5CQ4N9A0000000000000000'], onRun: () => true, ...closes }), appWith({ client })), { title: 'Pack 2 runs', doc: 'packs', first: FIELD, ok: 'Pack 2 runs' });
  });
  it('Export eval dataset', async () => {
    holds(await open(createElement(DatasetDialog, { ids: [RUN], rules: 2, ...closes })), { title: /^Export eval dataset of /, doc: 'datasets', first: FIELD, ok: 'Export dataset' });
  });
  it('Export OpenTelemetry trace', async () => {
    holds(await open(createElement(OtelDialog, { runId: RUN, rules: 2, onRun: () => true, ...closes })), { title: 'Export OpenTelemetry trace', doc: 'traces', first: FIELD, ok: 'Export trace' });
  });
  it('Find breaking commit', async () => {
    holds(await open(createElement(BisectDialog, { runId: RUN, offer, onRun: () => true, ...closes })), { title: 'Find breaking commit for 01K5CQ4N7G', doc: 'bisect', first: 'input[type="text"]', ok: 'Find breaking commit' });
  });
  it('Find commit that changed it', async () => {
    holds(await open(createElement(BisectDialog, { runId: RUN, offer: { ...offer, failed: false }, onRun: () => true, ...closes })), { title: 'Find commit that changed 01K5CQ4N7G', doc: 'bisect', first: 'input[type="text"]', ok: 'Find commit that changed it' });
  });
  it('Find breaking commit, from Runs', async () => {
    const choices = { good: 'c91d0f4', bad: 'd2e8a1f', target: { kind: 'run', runId: RUN }, revisions: [{ rev: 'c91d0f4', at: 1, runs: 3, failed: 0 }], unavailable: null, fork: true, live: true, expect: null } as unknown as BisectChoices;
    holds(await open(createElement(RunsFindCommit, { runId: RUN, choices, ...closes })), { title: 'Find breaking commit for 01K5CQ4N7G', doc: 'bisect', first: 'input[type="text"]', ok: 'Find breaking commit' });
  });
  it.each([
    ['a run’s', 'run'],
    ['Runs’', 'runs'],
    ['a golden’s', 'golden'],
  ])('Find breaking commit, %s: a commit picked from the list clears the one typed, and the one shown is the one sent', async (_name, where) => {
    const sent: unknown[] = [];
    const revisions = [{ rev: 'c91d0f4', at: 1, subject: 'A change', result: 'pass', sameChecks: true }] as never;
    const choices = { good: 'c91d0f4', bad: 'd2e8a1f', target: { kind: 'run', runId: RUN }, revisions: [{ rev: 'c91d0f4', at: 1, runs: 3, failed: 0 }], unavailable: null, fork: true, live: true, expect: null } as unknown as BisectChoices;
    const shown =
      where === 'run'
        ? createElement(BisectDialog, { runId: RUN, offer, onRun: (good: string) => (sent.push(good), true), ...closes })
        : where === 'runs'
          ? createElement(RunsFindCommit, { runId: RUN, choices, ...closes })
          : createElement(FindCommitDialog, { name: 'a', golden: 'goldens/a', range: null, live: true, goods: { revisions }, onRun: (f: { good?: unknown }) => void sent.push(f.good), ...closes });
    const startJob = (_kind: string, fields: { good?: string }) => (sent.push(fields.good), new Promise(() => undefined));
    const page = await open(shown, appWith({ client: { startJob } }));
    const good = () => /--good (\S+)/.exec(page.one('[role="dialog"] .cmdline').textContent)?.[1];
    const field = page.one('[role="dialog"] input[type="text"]');
    await page.type(field, 'abc1234');
    expect(good()).toBe('abc1234');
    expect(page.one('[role="dialog"] input[type="radio"]').checked).toBe(false);
    // A pick, as a radio's change.
    await page.fire(page.one('[role="dialog"] input[type="radio"]'), 'change');
    expect(field.value).toBe('');
    expect(page.one('[role="dialog"] input[type="radio"]').checked).toBe(true);
    expect(good()).toBe('c91d0f4');
    await page.click(page.one('[role="dialog"] .dlg-ok'));
    expect(sent).toEqual(['c91d0f4']);
  });
  it('Find breaking commit that can’t search says why, with Close alone', async () => {
    const choices = { good: null, bad: 'd2e8a1f', target: { kind: 'run', runId: RUN }, revisions: [], unavailable: 'Nothing before its commit to search.', fork: false, live: false, expect: null } as unknown as BisectChoices;
    holds(await open(createElement(RunsFindCommit, { runId: RUN, choices, ...closes })), { title: 'Find breaking commit for 01K5CQ4N7G', doc: 'bisect', first: CANCEL, ok: null, warn: 'Nothing before its commit to search' });
  });
  it('Run blame, asking for its check', async () => {
    holds(await open(createElement(CheckDialog, { runId: RUN, line: 'It failed “x”, a check shadowlap.config.json doesn’t give', onRun: () => Promise.resolve(null), ...closes })), { title: 'Run blame on 01K5CQ4N7G', doc: 'blame', first: FIELD, ok: 'Run blame', warn: 'It failed “x”, a check shadowlap.config.json doesn’t give' });
  });
  it('Run blame asks for its check, then someone else’s command in its place, sending both', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const confirm = 'ab'.repeat(16);
    const why = '01K5CQ4N7G came from an imported pack: this runs the command it was recorded with (node a.mjs). Confirm it to run it';
    const client = {
      startJob: (_kind: string, fields: Record<string, unknown>) => {
        sent.push(fields);
        if (fields.expect === undefined) return Promise.reject(new ApiError(422, 'no check'));
        return fields.yes === confirm ? Promise.resolve({ id: 'j' }) : Promise.reject(new ApiError(409, why, confirm));
      },
    };
    const app = appWith({ client: { ...client, jobs: () => Promise.resolve([]) }, feeds: {} });
    // Under Spending it starts at once; a check the server asks for after all is asked in its place.
    resetSpending(0.5);
    const page = await open(createElement(RunBlameButton, { runId: RUN, offer: { failed: ['x'], from: 'exit' }, estimate: { kind: 'blame', usd: 0.1, ceiling: true, parts: [] } }), app);
    await page.click(page.byText('button', 'Run blame'));
    await page.until('its check to be asked', () => page.all('[role="dialog"] textarea').length === 1);
    await page.type(page.one('[role="dialog"] textarea'), '{"tools":{"a":1}}');
    await page.click(page.one('[role="dialog"] .dlg-ok'));
    await page.until('the question', () => page.all('[role="dialog"] .dwarn').some((w) => w.textContent === why));
    holds(page, { title: 'Run command from imported pack', doc: 'commandsFromSomeoneElse', first: CANCEL, ok: 'Run blame', warn: why });
    await page.click(page.one('[role="dialog"] .dlg-ok'));
    await page.until('the job', () => sent.length === 3);
    expect(sent.at(-1)).toMatchObject({ expect: { tools: { a: 1 } }, yes: confirm, estimate: { usd: 0.1, ceiling: true } });
    await page.until('it to go', () => page.all('[role="dialog"]').length === 0);
    resetSpending();
  });
  it('Import capture', async () => {
    const client = { importSources: () => new Promise(() => undefined) };
    const page = await open(createElement(ImportDialog, closes), appWith({ client }));
    holds(page, { title: 'Import capture', doc: 'imports', first: '.drop', ok: 'Import capture' });
    // The drop zone, what it does on replay, the sample, then the command, as the mock draws them.
    expect(page.one('[role="dialog"] .impbody').children.map((c) => c.className)).toEqual(['drop', 'dfacts', 'impsamples']);
    expect(page.all('[role="dialog"] .dfacts dt').map((d) => d.textContent)).toEqual(['On replay']);
  });
});

describe('a run’s next steps that ask first', () => {
  const RUN = '01K5CQ4N7G0000000000000000';
  const GOLDEN = 'goldens/refund-in-limit';
  const run = { run: { runId: RUN, parentRunId: null, status: 'completed', meta: {} }, actions: [], children: [], calls: [] } as unknown as RunDetail;
  const served = (client: Record<string, unknown> = {}) => appWith({ client: { jobs: () => Promise.resolve([]), ...client }, feeds: {}, live: [], runs: [] });
  /** The step's lime button, pressed: the dialog it asks in. */
  async function pressed(step: NextStep, app = served()): Promise<Rendered> {
    const page = await open(createElement('div', null, createElement(NextStepButton, { run, step, offers: null, onAction: () => undefined, onFindCommit: () => undefined }), createElement(TestsAskHost)), app);
    await page.click(page.byText('button', step.label));
    return page;
  }
  const estimate = { kind: 'injection', usd: 3.11, ceiling: false, note: 'as the last test’s 6 attempts', parts: ['live from each read, writes stubbed'] } as NonNullable<NextStep['estimate']>;

  it('Run blame on a capture asks for your command first', async () => {
    const page = await open(createElement(RunBlameButton, { runId: RUN, offer: { failed: [], from: 'exit' }, capture: true, line: `shadowlap blame ${RUN.slice(0, 10)} --expect '{"calls":[]}' -- <your command>` }), served());
    await page.click(page.byText('button', 'Run blame'));
    holds(page, { title: 'Run blame on 01K5CQ4N7G', doc: 'blame', first: FIELD, ok: 'Run blame' });
  });
  it('Run blame above Spending, asked on its id with its command, its price and why it asks; one that needs its check asks for it alone', async () => {
    resetSpending(0.5);
    const estimate = { kind: 'blame', usd: 10.88, ceiling: true, parts: ['up to 7 probes of 33 attempts and a check of the call found', 'live from each probe, writes stubbed'] } as NonNullable<NextStep['estimate']>;
    let page = await open(createElement(RunBlameButton, { runId: RUN, offer: { failed: [], from: 'exit' }, estimate }), served());
    expect(JSON.parse(String(page.byText('button', 'Run blame').props['data-tip']))).toMatchObject({ est: { usd: 10.88, ceiling: true } });
    await page.click(page.byText('button', 'Run blame'));
    holds(page, { title: 'Run blame on 01K5CQ4N7G', doc: 'blame', first: OK, ok: 'Run blame' });
    expect(page.one('[role="dialog"] .dcost').textContent).toContain('At most ≈$10.88');
    expect(page.one('[role="dialog"] .dlgcost').textContent).toContain('Asks above $0.50');
    expect(page.one('[role="dialog"]').textContent).toContain(`shadowlap blame ${RUN.slice(0, 10)}`);
    await page.unmount();
    page = await open(createElement(RunBlameButton, { runId: RUN, offer: { failed: ['x'], from: 'ask' }, estimate: { ...estimate, usd: 0.1 } }), served());
    await page.click(page.byText('button', 'Run blame'));
    expect([page.all('[role="dialog"]').length, page.all('[role="dialog"] textarea').length, page.all('[role="dialog"] .dlgcost').length]).toEqual([1, 1, 0]);
    expect(page.one('[role="dialog"] .dcost').textContent).toContain('At most ≈$0.100');
    await page.unmount();
    resetSpending();
  });
  it('Update golden whose judge had no verdict', async () => {
    const step: NextStep = { key: 'update-golden', label: 'Update golden', golden: GOLDEN, test: null, sub: 'Asks the judge once, live, and keeps its verdict in the pack: every test after judges from the recording, free', command: `shadowlap test ${GOLDEN} --update` };
    holds(await pressed(step), { title: 'Update refund-in-limit?', doc: 'goldenUpdates', first: OK, ok: 'Update golden' });
  });
  it.each<[string, NextStep, Expect]>([
    ['Run injection test', { key: 'injection-test', label: 'Run injection test…', runId: RUN, command: `shadowlap injection ${RUN.slice(0, 10)}`, sub: 'It stopped early' }, { title: 'Run injection test on 01K5CQ4N7G', doc: 'injectionTests', first: OK, ok: 'Run injection test', warn: 'It stopped early' }],
    ['Re-run injection test', { key: 'injection-again', label: 'Re-run injection test', runId: RUN, job: { repeat: 2, templates: [], baselines: 3, liveReads: false }, command: `shadowlap injection ${RUN.slice(0, 10)} --repeat 2`, sub: 'It showed too little to say: no model read it', estimate }, { title: 'Re-run injection test on 01K5CQ4N7G', doc: 'injectionTests', first: OK, ok: 'Re-run injection test', warn: 'It showed too little to say: no model read it' }],
    ['Pack as golden', { key: 'pack', label: 'Pack as golden…', runId: RUN, folder: 'goldens/01k5cq4n7g', command: `shadowlap pack ${RUN.slice(0, 10)} goldens/01k5cq4n7g` }, { title: 'Pack 01K5CQ4N7G as golden?', doc: 'makeGolden', first: FIELD, ok: 'Pack as golden' }],
    ['Pack with injection gate', { key: 'pack-gate', label: 'Pack with injection gate…', runId: RUN, folder: 'goldens/01k5cq4n7g', gate: { obeyed: 0, repeat: 3 }, command: `shadowlap pack ${RUN.slice(0, 10)} goldens/01k5cq4n7g`, estimate }, { title: 'Pack 01K5CQ4N7G with injection gate?', doc: 'injectionGate', first: FIELD, ok: 'Pack with injection gate' }],
  ])('%s', async (_name, step, want) => {
    holds(await pressed(step), want);
  });
  it('Run injection test asks for a command someone else recorded as every such command is asked, Cancel first', async () => {
    const why = '01K5CQ4N7G came from an imported pack: this runs the command it was recorded with (node a.mjs). Confirm it to run it';
    const sent: Array<Record<string, unknown>> = [];
    const startJob = (_kind: string, fields: Record<string, unknown>) => {
      sent.push(fields);
      return fields.yes ? Promise.resolve({ id: 'j' }) : Promise.reject(new ApiError(409, why, 'ab'.repeat(16)));
    };
    const page = await pressed({ key: 'injection-test', label: 'Run injection test…', runId: RUN, command: `shadowlap injection ${RUN.slice(0, 10)}` }, served({ startJob }));
    await page.click(page.one('[role="dialog"] .dlg-ok'));
    await page.until('the question', () => page.all('[role="dialog"] .dwarn').some((w) => w.textContent === why));
    holds(page, { title: 'Run command from imported pack', doc: 'commandsFromSomeoneElse', first: CANCEL, ok: 'Run injection test', warn: why });
    await page.click(page.one('[role="dialog"] .dlg-ok'));
    await page.until('the job', () => sent.length === 2);
    expect(sent.at(-1)).toMatchObject({ runId: RUN, yes: 'ab'.repeat(16) });
  });
  it('Re-run test on an injection gate, asked through the Tests ask with the golden in mono', async () => {
    const startJob = () => Promise.reject(new ApiError(409, 'goldens/refund-in-limit has an injection gate. Confirm it to run it', 'c'.repeat(32), [{ path: GOLDEN, why: [{ kind: 'injection' }] }]));
    const app = served({ startJob });
    const page = await pressed({ key: 'gate-again', label: 'Re-run test', golden: GOLDEN, command: `shadowlap test ${GOLDEN}` }, app);
    await page.until('the question', () => page.all('[role="dialog"]').length === 1);
    holds(page, { title: 'Re-run refund-in-limit', doc: 'injectionTests', first: OK, ok: 'Re-run' });
    expect(page.one('[role="dialog"] h3 code').textContent).toBe('refund-in-limit');
    expect(page.one('[role="dialog"] .dcost').textContent).toContain('live from each read, writes stubbed');
    answerTestsQuestion(app, false);
    await page.until('it to go', () => page.all('[role="dialog"]').length === 0);
  });
});

describe('what a screen reader hears', () => {
  it('names the warning, then each amber or red row in order, then the lead', async () => {
    const page = await open(
      createElement(Dialog, {
        title: 'Run command from team store',
        lead: 'Runs the command a teammate recorded.',
        warn: { text: 'It runs on this machine', tone: 'red' },
        facts: [{ label: 'Runs here', value: '`node a.mjs`', tone: 'amber' }, { label: 'Writes', value: 'nothing' }],
        factsUnder: [{ label: 'As', value: 'you', tone: 'red' }],
        ok: 'Run command',
        onOk: () => true,
        ...closes,
      }),
    );
    const ids = (page.one('[role="dialog"]').getAttribute('aria-describedby') ?? '').split(' ');
    const byId = (want: string) => page.all('[id]').find((el) => el.getAttribute('id') === want);
    expect(ids.map((x) => byId(x)?.textContent)).toEqual(['It runs on this machine', 'Runs herenode a.mjs', 'Asyou', 'Runs the command a teammate recorded.']);
  });
});

describe('a golden’s dialogs', () => {
  const row = { path: 'goldens/a', name: 'a', mode: 'replay', checks: ['x'], last: { line: 'failed' } };
  const UUID = { path: '$.metadata.user_id', looks: 'a UUID', op: 'changed', certain: true };
  const div = { golden: 'goldens/a', name: 'a', callNo: 3, volatile: UUID, normalizerFixes: true, maybeReal: false, normalizeAndTest: [['normalize', 'add'], ['test', 'goldens/a']], rulesAdded: false, found: null, missed: null };
  const view = { rows: [row], divergences: [div], diverged: ['goldens/a'], inconclusive: [] } as unknown as TestsView;

  it('Update golden with its normalizer lime beside Update anyway, plain', async () => {
    const page = await open(createElement(UpdateGoldensDialog, { view, paths: ['goldens/a'], has: () => true, onUpdate: () => undefined, onInstead: () => undefined, ...closes }));
    holds(page, { title: 'Update a?', doc: 'goldenUpdates', first: '.dlg-alt', ok: 'Update anyway', tone: 'plain' });
    const footer = page.all('[role="dialog"] footer button').map((b) => b.textContent);
    expect(footer).toEqual(['Cancel', 'Update anyway', 'Add normalizer and re-run']);
    expect(page.one('.dlg-alt').className).toContain('lime');
    // Two commands, each named: on a phone each folds behind Show command, which says what it opens.
    expect(page.all('.cmdlbl').map((c) => c.textContent)).toEqual(['Add normalizer and re-runShow command', 'Update anywayShow command']);
    const show = page.all('.updshow')[0];
    expect(show.getAttribute('aria-expanded')).toBe('false');
    expect(page.all(`[id="${show.getAttribute('aria-controls')!}"]`)).toHaveLength(1);
    // The body's last cost line holds its foot, and the lime's keeps its place under its own command.
    expect(page.all('.dcost.flow')).toHaveLength(1);
    expect(page.all('.dcost')).toHaveLength(2);
  });
  it('Update goldens with their normalizer and update lime, its cost said once under Update anyway', async () => {
    const b = { ...div, golden: 'goldens/b', name: 'b' };
    const several = { ...view, rows: [row, { ...row, path: 'goldens/b', name: 'b' }], divergences: [{ ...div, newRules: [['normalize', 'add']] }, b], diverged: ['goldens/a', 'goldens/b'] } as unknown as TestsView;
    const page = await open(createElement(UpdateGoldensDialog, { view: several, paths: several.diverged, has: () => true, onUpdate: () => undefined, onInstead: () => undefined, ...closes }));
    holds(page, { title: 'Update 2 diverged goldens?', doc: 'goldenUpdates', first: '.dlg-alt', ok: 'Update anyway', tone: 'plain' });
    expect(page.all('[role="dialog"] footer button').map((x) => x.textContent)).toEqual(['Cancel', 'Update anyway', 'Add normalizer and update']);
    expect(page.all('.cmdlbl').map((c) => c.textContent)).toEqual(['Add normalizer and updateShow command', 'Update anywayShow command']);
    // The advice names the action whole, never broken across its line.
    expect(page.all('.advise p .nw').map((x) => x.textContent)).toEqual(['Add normalizer and update']);
    expect(page.one('.advise p').textContent).toBe('a diverged on a value that is new every run. Add normalizer and update masks it first.');
    expect(page.all('.dcost')).toHaveLength(1);
    expect(page.one('.dcost').textContent).toMatch(/^Billed by your provider\W+either way, as their recordings cost$/);
  });
  it('Update golden with no advice', async () => {
    const quiet = { ...view, divergences: [{ ...div, volatile: null, normalizeAndTest: null }] } as unknown as TestsView;
    holds(await open(createElement(UpdateGoldensDialog, { view: quiet, paths: ['goldens/a'], has: () => true, onUpdate: () => undefined, onInstead: () => undefined, ...closes })), { title: 'Update a?', doc: 'goldenUpdates', first: OK, ok: 'Update golden' });
  });
  it('Update goldens from the apply drawer', async () => {
    const outdated = [{ golden: 'goldens/a', callNo: 3, path: '$.x' }, { golden: 'goldens/b', callNo: 1, path: '$.y' }];
    const ask = updateOutdatedAsk(outdated);
    holds(await open(createElement(UpdateGoldenDialog, { plan: ask, onUpdate: () => undefined, ...closes })), { title: 'Update 2 diverged goldens?', doc: 'goldenUpdates', first: OK, ok: 'Update 2 goldens' });
    // One last diverged on a value made anew every run: its normalizer and the update lead, Update anyway plain.
    const masked = updateOutdatedAsk(outdated, maskFirst({ divergences: [{ ...div, newRules: [['normalize', 'add']] }] } as unknown as TestsView, ['goldens/a', 'goldens/b'], () => true));
    holds(await open(createElement(UpdateGoldenDialog, { plan: masked, onUpdate: () => undefined, onInstead: () => undefined, ...closes })), { title: 'Update 2 diverged goldens?', doc: 'goldenUpdates', first: '.dlg-alt', ok: 'Update anyway', tone: 'plain' });
  });
  it('Add normalizer and update', async () => {
    holds(await open(createElement(NormalizeUpdateDialog, { name: 'a', steps: [['normalize', 'add'], ['test', 'goldens/a', '--update']], onRun: () => undefined, ...closes })), { title: 'Add normalizer and update a?', doc: 'goldenUpdates', first: OK, ok: 'Add normalizer and update' });
  });
  it('Find breaking commit for a golden', async () => {
    const revisions = [{ rev: 'c91d0f4', at: 1, subject: 'A change', result: 'pass', sameChecks: true }] as never;
    holds(await open(createElement(FindCommitDialog, { name: 'a', golden: 'goldens/a', range: null, live: true, goods: { revisions }, onRun: () => undefined, ...closes })), { title: 'Find breaking commit for a', doc: 'bisect', first: 'input[type="text"]', ok: 'Find breaking commit' });
  });
  it('Find breaking commit saying how the golden did at each commit, and when it was tested at none', async () => {
    const revisions = [{ rev: 'c91d0f4', at: 1, subject: 'A change', result: 'fail', verdict: 'failed', sameChecks: true, rate: { passes: 4, attempts: 8 } }] as never;
    const untested = [{ rev: 'b'.repeat(40), subject: 'Before it' }];
    const page = await open(createElement(FindCommitDialog, { name: 'a', golden: 'goldens/a', range: null, live: false, goods: { revisions, untested }, onRun: () => undefined, ...closes }));
    expect(page.all('.bgood small').map((x) => x.textContent)).toEqual(['failed 4 of 8', 'not tested there']);
    const none = await open(createElement(FindCommitDialog, { name: 'a', golden: 'goldens/a', range: null, live: false, goods: { revisions: [], untested }, onRun: () => undefined, ...closes }));
    expect(none.one('.cmdlbl').textContent).toBe('Good commit · none tested yet');
    expect(none.all('.bgood small')).toHaveLength(0);
  });
  it('Find breaking commit over a range, with nothing to ask', async () => {
    const page = await open(createElement(FindCommitDialog, { name: 'a', golden: 'goldens/a', range: { good: 'c91d0f4', bad: 'd2e8a1f' }, live: false, goods: { revisions: [] }, onRun: () => undefined, ...closes }));
    holds(page, { title: 'Find breaking commit for a', doc: 'bisect', first: OK, ok: 'Find breaking commit' });
    expect(page.all('.dfacts div').map((d) => d.textContent)).toEqual(['Goodc91d0f4', 'Badd2e8a1fthe commit the last test session ran at']);
    expect(page.one('.dcost').textContent).toContain('bisect replays offline');
  });

  it.each<[string, TestsAsk, Expect]>([
    ['Run tests', { title: 'Run tests', lead: 'Replays every golden, as CI does.', doc: 'ciMode', ok: 'Run tests', commands: ['shadowlap test goldens/*'] }, { title: 'Run tests', doc: 'ciMode', first: OK, ok: 'Run tests' }],
    ['Re-run', { title: 'Re-run a', lead: 'Replays a again, live from where it forks.', doc: 'goldensThatFork', ok: 'Re-run', commands: ['shadowlap test goldens/a'] }, { title: 'Re-run a', doc: 'goldensThatFork', first: OK, ok: 'Re-run' }],
  ])('the Tests ask: %s', async (_name, say, want) => {
    const client = { startJob: () => Promise.reject(new ApiError(409, 'goldens/a is marked fork. Confirm it to run it', 'c'.repeat(32), [{ path: 'goldens/a', why: [{ kind: 'fork' }] }])) };
    const app = appWith({ client });
    const page = await open(createElement(TestsAskHost), app);
    startTestsJob(app, 'test', {}, say);
    await page.until('the question', () => page.all('[role="dialog"]').length === 1);
    holds(page, want);
    expect(page.one('[role="dialog"] .dfacts').textContent).toBe('Runs live1 golden marked forkfrom where it forks, writes blocked');
    answerTestsQuestion(app, false);
    await page.until('it to go', () => page.all('[role="dialog"]').length === 0);
  });

  const asksConsent = (sent: Array<Record<string, unknown>>) => ({
    startJob: (_kind: string, fields: Record<string, unknown>) => {
      sent.push(fields);
      return fields.yes ? Promise.resolve({ id: 'j' }) : Promise.reject(new ApiError(409, 'goldens/a is marked fork. Confirm it to run it', 'c'.repeat(32), [{ path: 'goldens/a', why: [{ kind: 'fork' }] }]));
    },
  });

  it('the Tests ask: Run more attempts, with its own rows alone and the golden in mono', async () => {
    const app = appWith({ client: asksConsent([]) });
    const page = await open(createElement(TestsAskHost), app);
    startTestsJob(app, 'test', {}, moreAttemptsAsk('a', { args: ['test', 'goldens/a', '--attempts', '8'], attempts: 8, most: 3, expected: 2.4, settles: 0.9 }));
    await page.until('the question', () => page.all('[role="dialog"]').length === 1);
    holds(page, { title: 'Run more attempts on a', doc: 'gating', first: OK, ok: 'Run more attempts' });
    expect(page.one('[role="dialog"] h3 code').textContent).toBe('a');
    expect(page.all('[role="dialog"] .dfacts dt').map((d) => d.textContent)).toEqual(['Limit', 'Settles']);
    answerTestsQuestion(app, false);
    await page.until('it to go', () => page.all('[role="dialog"]').length === 0);
  });

  it('keeps the Tests ask open, with its question, while its job can’t start', async () => {
    let online = true;
    const sent: Array<Record<string, unknown>> = [];
    const guard = (fn: () => void) => {
      if (!online) return false;
      fn();
      return true;
    };
    const app = appWith({ client: asksConsent(sent), guard });
    const page = await open(createElement(TestsAskHost), app);
    startTestsJob(app, 'test', {}, { title: 'Run tests', lead: 'Replays every golden, as CI does.', doc: 'ciMode', ok: 'Run tests', commands: ['shadowlap test goldens/*'] });
    await page.until('the question', () => page.all('[role="dialog"]').length === 1);
    online = false;
    await page.click(page.one('[role="dialog"] .dlg-ok'));
    expect(page.all('[role="dialog"]')).toHaveLength(1);
    expect(sent).toHaveLength(1);
    online = true;
    await page.click(page.one('[role="dialog"] .dlg-ok'));
    await page.until('it to go', () => page.all('[role="dialog"]').length === 0);
    expect(sent.at(-1)).toMatchObject({ yes: 'c'.repeat(32) });
  });
});

describe('a `$` row', () => {
  it('quotes what was typed as the job will take it, and says `…` or the mock’s placeholder while it is empty', () => {
    expect(packRunCommand('01K5CQ4N7G0000000000000000', 'my packs/one')).toBe("shadowlap pack 01K5CQ4N7G 'my packs/one'");
    expect(packRunCommand('01K5CQ4N7G0000000000000000', '  ')).toBe('shadowlap pack 01K5CQ4N7G …');
    const words = (o: Partial<Parameters<typeof importWords>[0]>) => importWords({ source: 'file', picked: null, id: '', host: '', project: '', keys: null, defaults: null, uploads: true, ...o }).command;
    expect(words({ picked: { file: { name: 'my trace.json' }, format: 'otel' } })).toBe("shadowlap import otel 'my trace.json'");
    expect(words({ source: 'langfuse' })).toBe('shadowlap import langfuse <trace-id>');
    expect(words({ source: 'phoenix', id: 'abc', project: 'my project', defaults: { project: 'default' } })).toBe("shadowlap import phoenix abc '--project=my project'");
  });
});

describe('a fix’s dialogs', () => {
  const APPLY = { kind: 'patch', argv: [], command: 'shadowlap fix apply', gitApply: null, pending: null, pulled: null, files: ['agent.mjs'], diff: '--- a\n+++ b\n', patchFile: '.shadowlap/repairs/r/fix.patch', refused: null, inTree: false, goldens: 1, names: [], held: null, change: null };
  const fix = (over: Record<string, unknown> = {}, actions: Record<string, unknown> = {}) =>
    ({
      fixId: 'fx-1',
      title: 'A fix',
      status: 'open',
      repairer: { name: 'claude-code', configured: false, problem: null },
      actions: { repair: { argv: ['repair', '--fixes', 'a', '--keeps', 'b', 'c'], command: 'shadowlap repair --fixes a --keeps b c', noFix: null, noFixWhy: null, candidates: 3, spent: false }, apply: null, applied: false, blameAgain: null, ...actions },
      ...over,
    }) as unknown as FixDetail;

  it('Run repair, reading first, then on its way on', async () => {
    let answer: (d: FixDetail) => void = () => undefined;
    const client = { fix: () => new Promise<FixDetail>((yes) => (answer = yes)) };
    const page = await open(createElement(RepairDialog, { fix: fix(), onRun: () => true, ...closes }), appWith({ client }));
    // While it reads, what it is doing: no docs to land on, and Cancel has the focus as the way on waits.
    expect(page.all('[role="dialog"] header p span')[0].textContent).toBe('Reading which repairer shadowlap.config.json names…');
    expect(page.all('[role="dialog"] header a')).toEqual([]);
    expect(page.focused(), 'Cancel while the way on waits').toBe(page.one('[role="dialog"] .dlg-cancel'));
    answer(fix());
    await page.until('the fix to be read', () => !page.one('.dlg-ok').disabled);
    holds(page, { title: 'Run repair', doc: 'repair', first: OK, ok: 'Run repair' });
    expect(page.all('.dfacts div').map((d) => d.querySelectorAll('dt')[0].textContent)).toEqual(['Changes', 'Hands over', 'Keeps', 'While it runs']);
    expect(page.all('.dfacts div')[2].textContent).toBe('Keepsb, c passing');
    expect(page.one('.dcost').textContent).toContain('up to 3 candidates');
  });
  it('Run repair whose repairer can’t be asked keeps the focus on Cancel, and says why in one line', async () => {
    const problem = 'This repair asks your own Claude Code, and claude was not found on the PATH: install Claude Code, or name another repairer in shadowlap.config.json (repair.repairer).';
    let answer: (d: FixDetail) => void = () => undefined;
    const client = { fix: () => new Promise<FixDetail>((yes) => (answer = yes)) };
    const page = await open(createElement(RepairDialog, { fix: fix(), onRun: () => true, ...closes }), appWith({ client }));
    expect(page.focused()).toBe(page.one('[role="dialog"] .dlg-cancel'));
    answer(fix({ repairer: { name: 'claude-code', configured: false, problem } }));
    await page.until('the fix to be read', () => page.all('[role="dialog"] .dwarn').length > 0);
    expect(page.one('[role="dialog"] .dwarn').textContent).toBe(problem.replace(/\.$/, ''));
    expect(page.one('.dlg-ok').disabled).toBe(true);
    expect(page.all('.dfacts')).toEqual([]);
    expect(page.focused(), 'the rows go, the focus stays').toBe(page.one('[role="dialog"] .dlg-cancel'));
  });
  it('Run repair that would end No fix to try', async () => {
    const noFix = fix({}, { repair: { argv: [], command: 'c', noFix: 'Blame couldn’t settle', noFixWhy: 'unsettled', candidates: 3, spent: false } });
    const page = await open(createElement(RepairDialog, { fix: noFix, onRun: () => true, ...closes }), appWith({ client: { fix: () => Promise.resolve(noFix) } }));
    await page.until('the fix to be read', () => !page.one('.dlg-ok').disabled);
    holds(page, { title: 'Run repair', doc: 'repair', first: OK, ok: 'Run repair', warn: 'Blame couldn’t settle' });
    expect(page.all('.dfacts')).toEqual([]);
    expect(page.one('.dcost').textContent).toContain('nothing runs: the blame it reuses didn’t settle');
  });
  it('Run blame with stronger model', async () => {
    const f = fix({}, { blameStronger: { command: 'shadowlap blame x --model <model>', attempts: 4, spent: 0.1 } });
    holds(await open(createElement(StrongerDialog, { fix: f, onRun: () => true, ...closes })), { title: 'Run blame with stronger model', doc: 'blame', first: FIELD, ok: 'Run blame with stronger model' });
  });
  it('Apply fix', async () => {
    const page = await open(createElement(ApplyDialog, { fix: fix({}, { apply: APPLY }), label: 'Apply fix', onRun: () => true, ...closes }));
    holds(page, { title: 'Apply fix?', doc: 'repairHandover', first: OK, ok: 'Apply fix' });
    expect(page.all('.ondisk.steps li').map((l) => l.querySelectorAll('span')[0].textContent)).toEqual(['Patch applied', 'Recording copied', 'Golden replayed', 'Other goldens replayed']);
    await page.unmount();
    // A golden it copies asks its name, under the patch: the field takes the focus.
    const named = await open(createElement(ApplyDialog, { fix: fix({}, { apply: { ...APPLY, names: [{ run: '01K5CQ2E8M', name: 'double-email' }], held: [] } }), label: 'Apply fix', onRun: () => true, ...closes }));
    holds(named, { title: 'Apply fix?', doc: 'repairHandover', first: FIELD, ok: 'Apply fix' });
  });
  it('Mark fix applied, and Finish applying fix', async () => {
    const page = await open(createElement(ApplyDialog, { fix: fix({}, { apply: { ...APPLY, kind: 'mark', goldens: 0 } }), label: 'Mark applied', onRun: () => true, ...closes }));
    holds(page, { title: 'Mark fix applied', doc: 'repairHandover', first: OK, ok: 'Mark applied' });
    await page.unmount();
    const again = await open(createElement(ApplyDialog, { fix: fix({}, { apply: { ...APPLY, pending: 'goldens' }, applied: true }), label: 'Finish applying', onRun: () => true, ...closes }));
    holds(again, { title: 'Finish applying fix?', doc: 'repairHandover', first: OK, ok: 'Finish applying' });
  });
  it('Mark fix applied asks of a merged fix whose patch is in the tree what it asks of one applied by hand, with no steps of its own', async () => {
    // Merged sits above applied on the ladder, so a merged fix's header offers no Mark applied: its dialog has no merged words.
    const inTree = { ...APPLY, inTree: true };
    const byHand = await open(createElement(ApplyDialog, { fix: fix({ status: 'verified', rung: 'verified', pr: null }, { apply: inTree }), label: 'Mark applied', onRun: () => true, ...closes }));
    const asked = byHand.one('[role="dialog"]').textContent;
    await byHand.unmount();
    const merged = await open(createElement(ApplyDialog, { fix: fix({ status: 'verified', rung: 'merged', pr: { url: 'https://github.com/acme/agent/pull/138', number: 138, state: 'merged' } }, { apply: inTree }), label: 'Mark applied', onRun: () => true, ...closes }));
    holds(merged, { title: 'Mark fix applied?', doc: 'repairHandover', first: OK, ok: 'Mark applied' });
    expect(merged.all('.ondisk.steps li')).toEqual([]);
    expect(merged.one('[role="dialog"]').textContent).toBe(asked);
  });
  it('Show patch', async () => {
    holds(await open(createElement(PatchDialog, { fix: fix({}, { apply: APPLY }), diff: '--- a\n', ...closes })), { title: 'Show patch', doc: 'repairHandover', first: CANCEL, ok: null });
  });
  it('Rename fix', async () => {
    holds(await open(createElement(RenameFixDialog, { fix: fix(), onDone: () => undefined, ...closes })), { title: 'Rename fix', doc: 'fixTitles', first: FIELD, ok: 'Rename' });
  });
});

describe('Training’s dialogs', () => {
  const exportDialog = { title: 'Export pairs', lead: 'Exports each pair as one JSON line: its conversation, the answer to prefer and the one to avoid.', rules: 2, high: 2, all: 3, out: '.shadowlap/exports/pairs.jsonl', formats: [{ value: 'trl', label: 'TRL' }], levels: [{ value: 'high', label: 'High (2)' }] };
  it('Export pairs', async () => {
    holds(await open(createElement(ExportPairsDialog, { view: { exportDialog } as unknown as TrainingView, ...closes })), { title: 'Export pairs', doc: 'pairs', first: FIELD, ok: 'Export pairs' });
  });
  it('Score model', async () => {
    const dialog = { title: 'Score model on 1 task', options: [{ key: 'm\n', id: 'm', group: 'Anthropic API', where: 'Anthropic API', baseUrl: null, perAttempt: 0.01, local: false, label: 'm', lastScore: null, note: '', request: { model: 'm', baseUrl: null, goldens: null } }], groups: ['Anthropic API'], selected: 'm\n', attempts: [5], endpoint: { key: '__endpoint', group: 'Other', label: 'Your own endpoint…', baseUrl: 'http://x/v1', model: 'm', note: '' }, notes: [], leftOut: [] } as unknown as ScoreDialogView;
    const client = { models: () => Promise.resolve({ dialog, notes: [] }) };
    const page = await open(createElement(ScoreDialog, { view: { tabs: { tasks: 1 }, tasks: { rows: [{ status: { key: 'ready' }, golden: 'goldens/a' }] } } as unknown as TrainingView, busy: null, ...closes }), appWith({ client }));
    await page.until('the models to be listed', () => page.all('.dcost').length === 1);
    holds(page, { title: 'Score model on 1 task', doc: 'scoring', first: 'select', ok: 'Score model' });
  });
  it('A task’s Update and Add normalizer', async () => {
    const update = (rerecords: boolean) => ({ golden: 'goldens/a', forkedAt: 3, takeover: 5, rerecords, normalizers: ['uuid'], steps: [['test', 'goldens/a', '--update']] });
    const page = await open(createElement(TaskUpdateDialog, { name: 'a', update: update(true), busy: null, ...closes }));
    holds(page, { title: 'Update a?', doc: 'goldenUpdates', first: OK, ok: 'Add normalizer and update', warn: 'Its test forks at #3, before the takeover at #5, so no model can take over there' });
    await page.unmount();
    holds(await open(createElement(TaskUpdateDialog, { name: 'a', update: update(false), busy: null, ...closes })), { title: 'Add normalizer for a', doc: 'tasks', first: OK, ok: 'Add normalizer and re-run', warn: 'Its test forks at #3, before the takeover at #5, so no model can take over there' });
  });
});

describe('Settings’ and the shell’s dialogs', () => {
  it.each([
    ['normalize', 'Add normalizer', 'normalizers'],
    ['redact', 'Add redaction rule', 'redaction'],
  ] as const)('%s', async (list, title, doc) => {
    holds(await open(createElement(RuleDialog, { list, kinds: ['api', 'tool'], patterns: ['uuid'], version: 'v', onAdded: () => undefined, onStale: () => undefined, ...closes } as never)), { title, doc, first: FIELD, ok: title });
  });
  it('Add redaction rule says where it masks: with a team store, which Push copies as recorded, every export, pack and share link', async () => {
    const lead = async (teamStore: boolean) => {
      const page = await open(createElement(RuleDialog, { list: 'redact', teamStore, kinds: ['api', 'tool'], patterns: ['uuid'], version: 'v', onAdded: () => undefined, onStale: () => undefined, ...closes } as never));
      const said = page.all('[role="dialog"] header p span')[0].textContent;
      await page.unmount();
      return said;
    };
    expect(await lead(true)).toBe('Masks stored content in every export, pack and share link.');
    expect(await lead(false)).toBe('Masks stored content whenever a run leaves this machine.');
  });
  it('Add MCP server', async () => {
    const client = { settings: { mcpLine: () => Promise.resolve(null) } };
    const page = await open(createElement(AddServerDialog, { files: [], ...closes } as never), appWith({ client }));
    holds(page, { title: 'Add MCP server', doc: 'mcp', first: 'input', ok: 'Copy entry' });
    expect(page.focused().closest('label')!.textContent).toContain('Name');
  });
  it('Clean up: Delete runs, red, and Free space', async () => {
    const dry = { count: 3, attempts: 12, cutoff: 1, olderThanDays: 30, keep: null, bytes: 2048, free: 0, expect: 'x' };
    const page = await open(createElement(CleanupDialog, { dry: dry as never, label: 'Delete 3 runs', onOk: () => undefined, ...closes }));
    holds(page, { title: 'Delete 3 runs?', doc: 'deletingRuns', first: CANCEL, ok: 'Delete 3 runs', tone: 'danger', warn: 'This can’t be undone' });
    expect(page.all('[role="dialog"] header p span')[0].textContent).toBe('Deletes the runs older than 30 days, their 12 attempts and the recorded data nothing else uses.');
    await page.unmount();
    holds(await open(createElement(CleanupDialog, { dry: { ...dry, count: 0, attempts: 0 } as never, label: 'Free 2 KB', onOk: () => undefined, ...closes })), { title: 'Free 2 KB?', doc: 'deletingRuns', first: OK, ok: 'Free 2 KB' });
  });
  it('Replace skills', async () => {
    holds(await open(createElement(ReplaceSkillsDialog, { title: 'Replace skills with 0.1.0’s copy?', lead: 'Puts 0.1.0’s copy in place of the skills edited here, and removes the files it doesn’t have.', path: '.agents/skills', others: true, command: 'c', onOk: () => undefined, ...closes })), { title: 'Replace skills with 0.1.0’s copy?', doc: 'agents', first: CANCEL, ok: 'Replace skills', tone: 'danger' });
  });
  it('Remove project, in ink, and its failed form', async () => {
    const view = { title: 'Remove support-agent from the dashboard?', project: { id: 'p', name: 'support-agent', path: '~/s', initial: 'S', summary: '2 runs' }, onDisk: [{ key: 'code', label: 'The folder and its code', path: '~/s' }], keep: { text: 'Takes support-agent off the dashboard; nothing on disk changes.', note: null, button: { label: 'Remove project', style: 'plain' }, crossedOut: null, done: 'x' }, deleteZone: null, canRemove: true, why: null };
    const page = await open(createElement(RemoveProjectDialog, { id: 'p', ...closes }), appWith({ client: { projects: { removal: () => Promise.resolve(view) } } }));
    await page.until('the dialog', () => page.all('[role="dialog"]').length === 1);
    holds(page, { title: 'Remove support-agent from the dashboard?', doc: 'removingProject', first: CANCEL, ok: 'Remove project', tone: 'plain' });
    await page.unmount();
    const failed = await open(createElement(RemoveProjectDialog, { id: 'p', ...closes }), appWith({ client: { projects: { removal: () => Promise.reject(new Error('No such project.')) } } }));
    await failed.until('the dialog', () => failed.all('[role="dialog"]').length === 1);
    holds(failed, { title: 'Remove project', doc: 'removingProject', first: CANCEL, ok: null, warn: 'No such project' });
  });
  it('Record run', async () => {
    const confirm = { title: 'Record run in ~/a', lead: 'Records one run: every model and tool call.', moved: null, calls: { value: 'the real API, with your keys', quiet: 'never stored' }, command: 'shadowlap run -- a', button: 'Record run' };
    holds(await open(createElement(RecordRunDialog, { confirm, onOk: () => undefined, ...closes })), { title: 'Record run in ~/a', doc: 'quickstart', first: OK, ok: 'Record run' });
  });
  it('Stop a job', async () => {
    const ask = stopAsk({ id: 'j', done: false, args: ['repair'], worktree: { use: 'writes', doing: 'a repair' } } as never)!;
    const page = await open(createElement(StopJobDialog, { ask, onOk: () => undefined, ...closes }));
    holds(page, { title: 'Stop repair', doc: 'jobs', first: CANCEL, ok: 'Stop repair', tone: 'plain' });
    expect(page.one('.dlg-cancel').textContent).toBe('Keep it running');
  });
});

describe('Settings → CI’s dialog', () => {
  it('Preview pull request comment: Close, then Copy Markdown, plain, which copies and keeps it open', async () => {
    const preview = { session: { id: 'ts-1', revision: 'd2e8a1f', at: Date.now() }, head: '1 of 1 golden passed', rows: [{ verdict: 'passed', golden: 'goldens/refund-flow', line: 'passed · replayed clean' }], decisions: null, cost: null, injection: [], postedBy: 'github-actions', foot: "The job's summary has each failure in full.", markdown: '### Shadowlap: 1 of 1 golden passed\n' };
    holds(await open(createElement(PrCommentDialog, { preview, ...closes }), appWith({ feeds: {} })), { title: 'Preview pull request comment', doc: 'prComment', first: CANCEL, ok: 'Copy Markdown', tone: 'plain' });
  });
});

describe('the bulk bar’s dialogs', () => {
  const RUNS = [{ runId: '01M5H2DJ1W0000000000000000', status: 'completed', attempts: 2 }, { runId: '01M5H2DJR40000000000000000', status: 'running', attempts: 0 }, { runId: '01M5H2DJZ90000000000000000', status: 'completed', attempts: 1 }] as never;
  const bar = () => open(createElement(BulkBar, { runs: RUNS, store: false, clear: () => undefined, onDone: () => undefined }), appWith({ client: { offers: () => new Promise(() => undefined) } }));

  it('Add label', async () => {
    const page = await bar();
    await page.click(page.byText('.bulkbar button', 'Add label…'));
    holds(page, { title: 'Add label to 3 runs', doc: 'labels', first: 'input[type="text"]', ok: 'Add label' });
    expect(page.all('[role="dialog"] .cstep')).toHaveLength(3);
  });
  it('Add label names its Copy by what the box holds, and copies every command past the five it shows', async () => {
    const writes: string[] = [];
    vi.stubGlobal('navigator', { clipboard: { writeText: (t: string) => (writes.push(t), Promise.resolve()) } });
    try {
      const six = ['A', 'B', 'C', 'D', 'E', 'F'].map((c) => ({ runId: `01M5H2DJ${c}${'0'.repeat(17)}`, status: 'completed', attempts: 0 }));
      const labelled = async (runs: typeof six) => {
        const page = await open(createElement(BulkBar, { runs: runs as never, store: false, clear: () => undefined, onDone: () => undefined }), appWith({ client: { offers: () => new Promise(() => undefined) } }));
        await page.click(page.byText('.bulkbar button', 'Add label…'));
        return page;
      };
      const many = await labelled(six);
      const copy = many.one('[role="dialog"] .cmdline button.boxcopy');
      expect(copy.getAttribute('aria-label')).toBe('Copy commands');
      await many.click(copy);
      await many.wait(0);
      expect(writes.at(-1)!.split('\n')).toEqual(six.map((x) => `shadowlap label ${x.runId.slice(0, 10)} <label>`));
      await many.unmount();
      const one = await labelled(six.slice(0, 1));
      expect(one.one('[role="dialog"] .cmdline button.boxcopy').getAttribute('aria-label')).toBe('Copy command');
      expect(one.one('[role="dialog"] .cmdline').textContent).toBe('$shadowlap label 01M5H2DJA0 <label>');
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('Delete runs, leaving alone the one still recording', async () => {
    const page = await bar();
    await page.click(page.byText('.bulkbar button', 'Delete 3 runs'));
    holds(page, { title: 'Delete 2 runs?', doc: 'deletingRuns', first: CANCEL, ok: 'Delete 2 runs', tone: 'danger' });
    expect(page.all('[role="dialog"] header p span')[0].textContent).toBe('Deletes the runs, their 3 attempts and the recorded data nothing else uses.');
    expect(page.all('.dfacts div').map((d) => d.textContent)).toEqual(['Forks, replayskeep their own datathey lose the link to them', 'Left alone01M5H2DJR4still recording']);
  });
});

describe('a way on that can’t start', () => {
  it('takes Enter on a line as a press of the way on, which waits while it can’t start, and refuses as the button does', async () => {
    const onRun = vi.fn(() => false);
    const onClose = vi.fn();
    const page = await open(createElement(PromptDialog, { title: 'Rename fix', lead: 'Gives the fix a title.', label: 'Title', ok: 'Rename', onRun, onClose }));
    await page.press('Enter', {}, page.one('[role="dialog"] input'));
    expect(onRun).not.toHaveBeenCalled();
    await page.type(page.one('[role="dialog"] input'), 'Escalate over the limit');
    await page.press('Enter', {}, page.one('[role="dialog"] input'));
    expect(onRun).toHaveBeenCalledWith('Escalate over the limit');
    expect(onClose).not.toHaveBeenCalled();
    expect(page.one('[role="dialog"] input').value).toBe('Escalate over the limit');
  });

  it('stays open with what was typed; a way on that starts closes', async () => {
    const onClose = vi.fn();
    const refusing = createElement(ConsentDialog, { why: 'x came from an imported pack: it runs y', ok: 'Run command', onOk: () => false, onClose });
    const page = await open(refusing);
    await page.click(page.one('.dlg-ok'));
    expect(onClose).not.toHaveBeenCalled();
    await page.unmount();
    const waits = createElement(ConsentDialog, { why: 'x came from an imported pack: it runs y', ok: 'Run command', onOk: () => Promise.resolve(false), onClose });
    const later = await open(waits);
    await later.click(later.one('.dlg-ok'));
    await later.until('its answer', () => true);
    expect(onClose).not.toHaveBeenCalled();
    await later.unmount();
    const goes = await open(createElement(ConsentDialog, { why: 'x came from an imported pack: it runs y', ok: 'Run command', onOk: () => true, onClose }));
    await goes.click(goes.one('.dlg-ok'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
