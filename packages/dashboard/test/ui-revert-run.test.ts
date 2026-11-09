import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { UNTESTED_WORDS } from '../../engine/src/bisect-words.js';
import type { Estimate } from '../../engine/src/estimates/estimate.js';
import { ApiError, type Client } from '../ui/api.js';
import { shortDate } from '../ui/goldens.js';
import { ChangeBox } from '../ui/revert/ChangeBox.js';
import { RevertButton } from '../ui/revert/RevertButton.js';
import { RevertDialog } from '../ui/revert/RevertDialog.js';
import { Banner, forgetOpenFindings } from '../ui/run/FindingsBar.js';
import { InspectorPlace, panelToggle, useFindingPanel } from '../ui/run/InspectorPanel.js';
import { panelOn, resetPanel } from '../ui/run/panel-state.js';
import { RunHeader } from '../ui/run/RunHeader.js';
import { ServedPartsContext, type ServedParts } from '../ui/served-parts.js';
import { resetSpending } from '../ui/spending.js';
import { AppContext, type AppState } from '../ui/state.js';
import { answerTestsQuestion, askQuestion, testsQuestion } from '../ui/tests-ask.js';
import type { FoundCommit, NextStep, RunDetail, RunOffers } from '../ui/types.js';
import { render, type Rendered } from './ui-render.js';

/**
 * A crash's run page once Find breaking commit named its first bad commit: the commit's finding leads
 * the crash's, Show change opens the change in the inspector's place and Hide or Esc give the focus
 * back to it; the header leads with Revert, lime and last, Open in editor and Run blame plain before
 * Fork at #n. Revert waits for Tests' jobs and for every job using the working tree, and always asks
 * in its dialog, which says what it does and what the test after it bills, and answers the server's
 * question about a golden whose test runs live with the yes it asked already. Once a later replay
 * passed, the replay reads fixed by and the commit's finding is gone.
 */

const REC = '01M5JEQWA2QMJ3NYD1C687WP08';
const PARENT = '01M5JEQXRGBX1QXGW0X8A3ZB4C';
const PASS = '01M5JF0000PASSED0000000000';
const GOLDEN = 'goldens/refund';
const HUNK = '@@ -10,3 +10,3 @@ def refund(order):\n     total = order["amount"]\n-    log(total)\n+    log(order["total"])\n     return total\n';
const CHANGE = { file: 'agent/refund.py', files: ['agent/refund.py', '../shared/log.py'], hunk: HUNK, line: 11, cut: false, merge: false, path: 'refund.py', outside: 1 };
const FOUND: FoundCommit = { rev: 'ccccccc', subject: 'Log the total', author: '', date: '2026-10-30T10:00:00Z', why: 'the agent exited 1', untested: ['bbbbbbb'], replays: 3, tokens: 0, at: 1, change: CHANGE };
const FREE: Estimate = { kind: 'tests', usd: 0, ceiling: false, parts: ['replays offline'] };
const BLAME = { offer: { from: 'exit', expect: null, failed: [] }, sub: 'Whether an answer of the model’s lost the run', command: `shadowlap blame ${REC.slice(0, 10)}` };
const STEP = { key: 'revert', label: 'Revert', golden: GOLDEN, rev: 'ccccccc', merge: false, live: [], blame: null, title: 'Revert ccccccc', sub: 'Log the total: undone in your working tree, then refund replayed offline', command: `git revert --no-commit ccccccc && shadowlap test ${GOLDEN}`, estimate: FREE } as unknown as Extract<NextStep, { key: 'revert' }>;
const OFFERS = { blame: BLAME.offer, test: null, bisect: null, commit: FOUND } as unknown as RunOffers;
const PARTS: ServedParts = { RevertDialog, ChangeBox };

let page: Rendered | null = null;
afterEach(async () => {
  await page?.unmount();
  page = null;
  forgetOpenFindings();
  resetPanel();
  resetSpending();
  askQuestion(null);
});

/** An app that records the jobs it is asked to start, as `start` answers them. */
function app(o: Partial<AppState> = {}, client: Partial<Client> = {}) {
  const started: Array<[string, Record<string, unknown>]> = [];
  const a = {
    client: {
      jobs: () => Promise.resolve([]),
      startJob: (kind: string, fields: Record<string, unknown>) => {
        started.push([kind, fields]);
        return Promise.resolve({ id: `j${started.length}` });
      },
      ...client,
    } as unknown as Client,
    exported: false,
    meta: { editor: 'code --goto <file>:<line>' },
    tick: 0,
    runsTick: 0,
    feeds: {},
    jobs: [],
    live: [],
    runs: [],
    actionsOff: null,
    hasKind: () => true,
    guard: (fn: () => void) => (fn(), true),
    watchJob: () => undefined,
    toast: () => undefined,
    ...o,
  } as unknown as AppState;
  return { a, started };
}

const within = (a: AppState, node: ReactNode, parts: ServedParts = PARTS) => createElement(AppContext.Provider, { value: a }, createElement(ServedPartsContext.Provider, { value: parts }, createElement('main', { id: 'view' }, node)));

const failedState = { status: 'completed', kind: 'test', outcome: { kind: 'check-failed', check: null }, failed: true, interrupted: false, label: 'test replay' };

/** A test replay that crashed, as its page reads it. */
function crashed(o: { next?: NextStep | null; fixedBy?: string } = {}): RunDetail {
  return {
    run: { runId: REC, parentRunId: PARENT, mode: 'replay', status: 'failed', divergence: null, command: { argv: ['python', 'agent.py'], cwd: '.' }, codeVersion: 'f6c5756', startedAt: 1, endedAt: 2, meta: { test: { golden: GOLDEN, session: 's1' } } },
    summary: { upstreamRequests: 0, byKind: { api: 3, tool: 2, clock: 0, random: 0 }, cost: { spent: 0, saved: 0, captured: 0, unknownModels: [] }, imported: false },
    calls: [],
    actions: [{ key: 'r', label: 'Replay' }],
    children: [],
    parent: { runId: PARENT, label: 'recording' },
    source: null,
    fix: null,
    blame: null,
    state: failedState,
    ...(o.next ? { next: o.next } : {}),
    ...(o.fixedBy ? { fixedBy: o.fixedBy } : {}),
  } as unknown as RunDetail;
}

const bannerProps = (run: RunDetail, offers: RunOffers | null) => ({ run, blame: null, rescued: null, checks: [], offers, showDiff: false, onToggleDiff: () => undefined, onSelect: () => undefined, onAction: () => undefined });
const header = (run: RunDetail, offers: RunOffers | null) => ({ run, judged: null, call: null, selected: 5, rescued: false, offers, forkMenu: { open: false, anchor: null, toggle: () => undefined, close: () => undefined } as never, onAction: () => undefined, onFindCommit: () => undefined });

/** The findings and the inspector's place, as the run page draws them: Show change opens the change there. */
function Place({ run, offers }: { run: RunDetail; offers: RunOffers }) {
  const p = useFindingPanel(run.run.runId);
  const inspector = createElement('section', { className: 'insp', id: 'insp' }, createElement('div', { className: 'ibody', id: 'ibody', role: 'tabpanel' }));
  return createElement('div', null, createElement(Banner, { ...bannerProps(run, offers), showChange: p.showChange, onToggleChange: p.onToggleChange }), createElement(InspectorPlace, { panel: p.panel, run, test: null, offers, onClose: p.close, onPick: () => undefined, children: inspector }));
}

const lead = (a: AppState, o: { parts?: ServedParts; lead?: boolean } = {}) => within(a, createElement(RevertButton, { step: STEP, found: FOUND, estimate: FREE, runId: REC, lead: o.lead ?? true }), o.parts);
const dialog = (a: AppState, step = STEP, estimate: Estimate = FREE) => within(a, createElement(RevertDialog, { step, found: FOUND, estimate, runId: REC, onClose: () => undefined }));

describe('Revert', () => {
  it('shows only where the dashboard runs it and was handed its dialog, lime where it leads, and asks in its dialog even when free', async () => {
    for (const [a, parts] of [[app({ hasKind: (k: string) => k !== 'revert' }).a, PARTS], [app().a, {}]] as const) {
      page = await render(lead(a, { parts }));
      expect(page.all('button')).toHaveLength(0);
      await page.unmount();
    }
    page = await render(lead(app().a, { lead: false }));
    expect([page.one('button').className, page.one('button').getAttribute('data-next')]).toEqual(['btn', null]);
    await page.unmount();
    const { a, started } = app();
    page = await render(lead(a));
    const b = page.one('button');
    expect([b.className, b.getAttribute('data-next'), b.textContent]).toEqual(['btn lime', 'revert', 'Revert']);
    await page.click(b);
    // Free, and still it asks: it changes your working tree.
    expect(started).toEqual([]);
    expect(page.one('.dialog h3').textContent).toBe('Revert ccccccc?');
  });

  it('waits while a Tests job runs and while any job uses the working tree, saying for what', async () => {
    const search = { id: 'j0', kind: 'bisect', args: ['bisect', GOLDEN], done: false };
    page = await render(lead(app({}, { jobs: () => Promise.resolve([search]) as never }).a));
    await page.until('the wait for the search', () => page!.one('button').getAttribute('aria-disabled') === 'true');
    expect(page.one('button').getAttribute('data-why')).toBe('Find breaking commit is running: revert it once it is done.');
    expect(page.one('button').className).toBe('btn');
    await page.unmount();
    const reader = { id: 'j0', kind: 'replay', args: ['replay', REC], done: false, worktree: { use: 'reads', doing: 'a replay is running your agent', folder: null } };
    page = await render(lead(app({}, { jobs: () => Promise.resolve([reader]) as never }).a));
    await page.until('the wait for the tree', () => page!.one('button').getAttribute('aria-disabled') === 'true');
    expect(page.one('button').getAttribute('data-why')).toBe('A replay is running your agent: revert it once it is done.');
  });

  it('asks what it does, about which commit, then the test, the change undone, and what the test bills, and starts the revert of that commit', async () => {
    const { a, started } = app();
    page = await render(dialog(a));
    expect(page.one('.dialog header p').textContent).toBe('Undoes the commit in your working tree, uncommitted, for you to review.');
    expect(page.one('.dwarn').textContent).toBe('1 of the commit’s files is outside this project, and git reverts it too');
    const facts = page.all('.dfacts > div').map((d) => ({ label: d.querySelector('dt')!.textContent, value: d.querySelector('dd')!.textContent, tone: d.getAttribute('class') }));
    expect(facts.map((f) => f.label)).toEqual(['Commit', 'Untested', 'Then']);
    expect(facts[0].value).toContain('Log the total');
    expect(facts[0].value).toContain(shortDate(FOUND.date));
    expect(facts[1]).toMatchObject({ tone: 'amber' });
    expect(facts[1].value).toContain('bbbbbbb');
    expect(facts[1].value).toContain(UNTESTED_WORDS.row);
    expect(facts[2].value).toBe('refund is tested');
    // The change undone, in a code box: what the commit added taken out, what it removed put back.
    expect(page.all('pre.codebox.fxpatch span.add').map((s) => s.textContent.trim())).toEqual(['+    log(total)']);
    expect(page.all('pre.codebox.fxpatch span.del').map((s) => s.textContent.trim())).toEqual(['-    log(order["total"])']);
    // Read, not pasted: the change has no Copy of its own.
    expect(page.all('.dialog .boxwrap .fxpatch')).toHaveLength(0);
    expect(page.one('.db').textContent).toContain(`git revert --no-commit ccccccc && shadowlap test ${GOLDEN}`);
    expect(page.one('.dcost').textContent).toContain('Free');
    expect(page.one('.dcost').textContent).toContain('replays offline');
    expect(page.all('.dlgdoc')).toHaveLength(0);
    await page.click(page.byText('.dialog button', 'Revert'));
    expect(started).toEqual([['revert', { golden: GOLDEN, rev: 'ccccccc', runId: REC, estimate: { usd: 0, ceiling: false } }]]);
  });

  it('says why a golden’s test runs live, as the server’s question does, that the provider bills it, and answers that question with the yes it asked', async () => {
    const started: Array<[string, Record<string, unknown>]> = [];
    const startJob = (kind: string, fields: Record<string, unknown>) => {
      started.push([kind, fields]);
      return started.length === 1 ? Promise.reject(new ApiError(409, 'goldens/refund is marked fork, so it runs live from where it forks, writes blocked', 'yes-1', [{ path: GOLDEN, why: live }])) : Promise.resolve({ id: 'j2' });
    };
    const live = [{ kind: 'fork' }, { kind: 'judges', models: ['claude-haiku-4-5'] }, { kind: 'injection' }];
    page = await render(dialog(app({}, { startJob: startJob as never }).a, { ...STEP, live } as typeof STEP, { kind: 'tests', usd: null, ceiling: false, parts: ['live from there, writes blocked'] }));
    // The rows Run tests asks with, under the test: what runs live, its judges' model, and what it plants.
    const facts = page.all('.dfacts > div').map((d) => [d.querySelector('dt')!.textContent, d.querySelector('dd')!.textContent]);
    expect(facts.slice(2)).toEqual([
      ['Then', 'refund is tested'],
      ['Runs live', '1 golden marked forkfrom where it forks, writes blocked'],
      ['Asks', 'its judges liveclaude-haiku-4-5'],
      ['Plants', 'the payloads of 1 injection gate'],
    ]);
    expect(page.one('.dcost').textContent).toContain('Billed by your provider');
    await page.click(page.byText('.dialog button', 'Revert'));
    await page.until('the yes', () => started.length === 2);
    expect(started[1]).toEqual(['revert', { golden: GOLDEN, rev: 'ccccccc', runId: REC, yes: 'yes-1' }]);
  });

  it('gives way to the dialog that opens on Cancel for a command someone else recorded, whose Run alone sends that yes', async () => {
    const why = `${REC.slice(0, 10)} came from an imported pack: its test runs the command it was recorded with (python agent.py), under shadowlap test ${GOLDEN}. Confirm it to run it`;
    for (const press of ['Run command', 'Cancel']) {
      const started: Array<[string, Record<string, unknown>]> = [];
      const startJob = (kind: string, fields: Record<string, unknown>) => (started.push([kind, fields]), started.length === 1 ? Promise.reject(new ApiError(409, why, 'c-1')) : Promise.resolve({ id: 'j2' }));
      let closed = 0;
      const a = app({}, { startJob: startJob as never }).a;
      page = await render(within(a, createElement(RevertDialog, { step: STEP, found: FOUND, estimate: FREE, runId: REC, onClose: () => void (closed += 1) })));
      await page.click(page.byText('.dialog button', 'Revert'));
      await page.until('the question', () => page!.one('.dialog h3').textContent === 'Run command from imported pack');
      expect(page.one('.dwarn').textContent).toBe(why);
      expect(page.focused()).toBe(page.one('.dlg-cancel'));
      expect([started.length, closed]).toEqual([1, 0]);
      await page.click(page.byText('.dialog button', press));
      if (press === 'Run command') await page.until('the yes', () => started.length === 2);
      expect(started.slice(1)).toEqual(press === 'Run command' ? [['revert', { golden: GOLDEN, rev: 'ccccccc', runId: REC, estimate: { usd: 0, ceiling: false }, yes: 'c-1' }]] : []);
      await page.until('the dialog closed', () => closed === 1);
      await page.unmount();
      page = null;
    }
  });

  it('asks as Tests does where the server says the test runs live for a reason the dialog didn’t give, sending nothing until it is answered', async () => {
    const started: Array<[string, Record<string, unknown>]> = [];
    const live = [{ path: GOLDEN, why: [{ kind: 'fork' }] }];
    const startJob = (kind: string, fields: Record<string, unknown>) => (started.push([kind, fields]), started.length === 1 ? Promise.reject(new ApiError(409, 'goldens/refund is marked fork, so it runs live from where it forks, writes blocked', 'yes-2', live)) : Promise.resolve({ id: 'j2' }));
    const { a } = app({}, { startJob: startJob as never });
    page = await render(dialog(a));
    await page.click(page.byText('.dialog button', 'Revert'));
    await page.until('the question', () => testsQuestion() !== null);
    expect(testsQuestion()).toMatchObject({ title: 'Revert ccccccc?', name: 'ccccccc', ok: 'Revert', kind: 'revert', confirm: 'yes-2', live });
    expect(started).toHaveLength(1);
    answerTestsQuestion(a, true);
    await page.until('the yes', () => started.length === 2);
    expect(started[1]).toEqual(['revert', { golden: GOLDEN, rev: 'ccccccc', runId: REC, estimate: { usd: 0, ceiling: false }, yes: 'yes-2' }]);
  });
});

describe('a named crash on its run’s page', () => {
  it('leads its findings with the first bad commit and Show change, which opens the change in the inspector’s place, Hide giving the focus back', async () => {
    page = await render(within(app().a, createElement(Place, { run: crashed(), offers: OFFERS })));
    const first = page.all('.findings section')[0] ?? page.all('section.blame')[0];
    expect(first.querySelector('.bk')!.textContent).toBe('first bad commit');
    // Its rev, then its subject leading the line in ink, as every finding's lead does, then its facts.
    expect(first.children.map((c) => c.className || c.tagName.toLowerCase())).toEqual(expect.arrayContaining(['bk', 'code', 'why']));
    expect(first.querySelector('code')!.textContent).toBe('ccccccc');
    expect(first.querySelector('.why .lead')!.textContent).toBe('Log the total');
    expect(first.querySelector('.why')!.textContent).toBe(`Log the total\u00a0· ${shortDate(FOUND.date)}\u00a0· 0 tokens`);
    const toggle = page.one('[data-act="change"]');
    expect([toggle.textContent, toggle.getAttribute('aria-expanded')]).toEqual(['Show change', 'false']);
    await page.click(toggle);
    const panel = page.one('#insp');
    expect([panel.getAttribute('class'), panel.getAttribute('data-kind'), panel.getAttribute('aria-label')]).toEqual(['insp fpanel', 'change', 'The change at the first bad commit']);
    expect(page.one('.fhead .nav button').textContent).toBe('Hide change');
    expect([page.one('[data-act="change"]').textContent, page.one('[data-act="change"]').getAttribute('aria-expanded')]).toEqual(['Hide change', 'true']);
    // The box: its file in the head, Open in editor and Copy git revert at its right, the hunk under it.
    expect(page.one('#ibody .bisectdiff').textContent).toContain('agent/refund.py');
    expect(page.all('#ibody .bisectdiff .cdacts button').map((b) => b.textContent)).toEqual(['Open in editor', 'Copy git revert']);
    // Esc hands the focus to the toggle that opened it, as Hide does.
    expect(panelToggle(panelOn(REC))).toBe(page.one('[data-act="change"]'));
    await page.click(page.one('.fhead .nav button'));
    expect(page.all('.fpanel')).toHaveLength(0);
    expect(page.focused()).toBe(page.one('[data-act="change"]'));
  });

  it('heads the page with Revert, lime and last, Open in editor and Run blame plain before Fork at #n, the findings offering neither', async () => {
    const run = crashed({ next: { ...STEP, blame: BLAME } as unknown as NextStep });
    page = await render(within(app().a, createElement('div', null, createElement(RunHeader, header(run, OFFERS)), createElement(Banner, bannerProps(run, OFFERS)))));
    expect(page.all('.rhead .actions .lime').map((b) => b.textContent)).toEqual(['Revert']);
    const buttons = page.all('.rhead .actions button').map((b) => b.textContent ?? '');
    const at = (words: string) => buttons.findIndex((b) => b.startsWith(words));
    expect(at('Open in editor')).toBeGreaterThan(-1);
    expect(at('Open in editor')).toBeLessThan(at('Run blame'));
    expect(at('Run blame')).toBeLessThan(at('Fork at'));
    expect(at('Fork at')).toBeLessThan(at('Revert'));
    expect(page.byText('.rhead .actions button', 'Run blame').className).toBe('btn');
    expect(page.all('.banner button').some((b) => b.textContent === 'Run blame' || b.textContent === 'Revert')).toBe(false);
  });

  it('reads fixed by once a later replay passed, its commit’s finding gone, and Open passing run leads', async () => {
    const passing = { key: 'passing', label: 'Open passing run', runId: PASS, href: `#/run/${PASS}`, title: `Opens ${PASS.slice(0, 10)}` } as unknown as NextStep;
    const run = crashed({ fixedBy: PASS, next: passing });
    page = await render(within(app().a, createElement('div', null, createElement(RunHeader, header(run, OFFERS)), createElement(Banner, bannerProps(run, OFFERS)))));
    expect(page.all('.bk').map((k) => k.textContent)).not.toContain('first bad commit');
    expect(page.all('[data-act="change"]')).toHaveLength(0);
    expect(page.one('.banner').textContent).toContain(`fixed by ${PASS.slice(0, 10)}`);
    expect(page.all('.rhead .actions .lime').map((b) => b.textContent)).toEqual(['Open passing run']);
  });
});
