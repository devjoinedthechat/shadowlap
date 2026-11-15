import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, createElement, Fragment, type ReactElement } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Store, unpackRun } from '@shadowlap/engine';
import { exportHtml, type StaticPayload } from '../src/index.js';
import { createExportedClient, JOB_KINDS, type ActionItem, type CallDetail } from '../ui/api.js';
import '../ui/palette-actions.js';
import { paletteSources, type PaletteContext } from '../ui/palette-sources.js';
import { CopyPages } from '../ui/pages/copy.js';
import { Elsewhere } from '../ui/pages/held-elsewhere.js';
import { useProjectRemoval, type ProjectRemoval } from '../ui/project-actions.js';
import { testRow } from '../ui/run/run-commands.js';
import { useRoute } from '../ui/router.js';
import { useActionRunner } from '../ui/run/actions.js';
import { bannerJobsShown } from '../ui/run/diverged.js';
import { EditAndFork } from '../ui/run/EditAndFork.js';
import { JobChip } from '../ui/shell/JobChip.js';
import { Keyboard } from '../ui/shell/Keyboard.js';
import { ProjectBlock } from '../ui/shell/ProjectBlock.js';
import { TopBar } from '../ui/shell/TopBar.js';
import { AppProvider, useApp, type AppState } from '../ui/state.js';
import type { RunDetail, TestBannerOffer } from '../ui/types.js';
import { render, type Rendered } from './ui-render.js';

/**
 * An exported copy is built from an entry of its own (ui/main-copy.tsx), with only the pages it
 * shows (ui/pages/copy.tsx): its runs, a run's page and Compare between them. Drawn here from a real
 * export's data, as the copy draws it, it still opens on the run that was shared, lists its runs,
 * compares them, and sends every other page to its runs. It draws nothing that opens a part only the
 * served dashboard hands in (ui/served-parts.ts), whose code its script doesn't hold, nor the dialogs
 * only such a part opens.
 */
const GOLDEN = fileURLToPath(new URL('../../../testing/golden/reference-agent', import.meta.url));

let store: Store;
let runId: string;
let forkId: string;
let attemptId: string;
let uiDir: string;

beforeAll(() => {
  store = Store.open(':memory:');
  runId = unpackRun(store, GOLDEN).imported[0]!;
  const fork = store.createRun({ mode: 'replay', parentRunId: runId, command: { argv: ['node', 'agent.js'], cwd: '.' } });
  forkId = fork.runId;
  for (const c of store.getCalls(runId).slice(0, 4)) {
    const { end, attempts, ...start } = c;
    void attempts;
    store.appendCallStart({ ...start, runId: forkId, origin: c.callNo < 3 ? 'replayed' : 'live' });
    if (end) store.appendCallEnd(c, { ...end, runId: forkId });
  }
  store.setDivergence(forkId, { type: 'request_changed', callNo: 3, kind: 'api', name: 'POST /v1/messages', replayedBefore: 2 });
  store.endRun(forkId, 'completed');
  // An injection test's attempt, its mark on its own record: a copy holds the mark, never the test's results.
  const canary = { token: 'x7f3kq2m', address: 'x7f3kq2m@canary.invalid', id: 'CNRY-x7f3kq2m', amount: '4,812.00' };
  const injection = { result: 'inj-01PLANT', role: 'attempt' as const, read: 2, payload: 'system-notice', attempt: 2, of: 3, canary, verdict: 'obeyed' as const, readAt: 3, evidence: [{ kind: 'canary' as const, callNo: 4, tool: 'send_email', path: '$.to', value: canary.address }] };
  attemptId = store.createRun({ mode: 'replay', parentRunId: runId, command: { argv: ['node', 'agent.js'], cwd: '.' }, meta: { injection } }).runId;
  // The test it was in, kept for the run it tested, as the served dashboard draws its finding from.
  // The presets run on it, which the served dashboard draws as a finding and a panel: a copy keeps neither.
  store.startChaosSession({ sessionId: 'S1', startedAt: 3, command: ['shadowlap', 'replay', runId, '--chaos'], presets: ['timeout'] });
  store.addChaosResult({ sessionId: 'S1', runId, golden: null, preset: 'timeout', verdict: 'failed', callNo: 2, passes: 0, attempts: 1, at: 3, data: { detail: 'search (#2) timed out: the agent exited with code 1', runs: [{ runId: attemptId, verdict: 'failed', passed: false, exitCode: 1 }] } });
  store.putInjectionResult({ resultId: 'inj-01PLANT', runId, golden: null, sessionId: null, mode: 'plant', at: 1, endedAt: 2, attempts: 3, obeyed: 1, influenced: 0, ignored: 2, inconclusive: 0, verdict: 'obeyed', actor: null, data: { resultId: 'inj-01PLANT', mode: 'plant', gate: { obeyed: 0, influenced: null, verdict: 'failed', reason: 'send_email obeyed a planted instruction in 1 of 3 attempts (at most 0 allowed)' }, cost: { spent: 0 } } });
  for (const c of store.getCalls(runId).slice(0, 4)) {
    const { end, attempts, ...start } = c;
    void attempts;
    store.appendCallStart({ ...start, runId: attemptId, origin: c.callNo < 3 ? 'replayed' : 'live' });
    if (end) store.appendCallEnd(c, { ...end, runId: attemptId });
  }
  store.endRun(attemptId, 'completed');
  // A stand-in for the built UI: what is under test is the data the file carries, drawn by the copy's pages.
  uiDir = mkdtempSync(join(tmpdir(), 'sl-export-copy-ui-'));
  mkdirSync(join(uiDir, 'assets'), { recursive: true });
  writeFileSync(join(uiDir, 'assets', 'app.css'), '.app{}\n');
  writeFileSync(join(uiDir, 'assets', 'copy.js'), 'console.log(1);\n');
  writeFileSync(join(uiDir, 'assets', 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
});
afterAll(() => {
  store.close();
  rmSync(uiDir, { recursive: true, force: true });
});

let r: Rendered | null = null;
afterEach(async () => {
  await r?.unmount();
  r = null;
  vi.unstubAllGlobals();
});

/** The data an exported file of these runs embeds, read back as the copy reads it. */
function exported(runIds: string[]): StaticPayload {
  const { html } = exportHtml({ store, runIds, uiDir });
  return JSON.parse(/<script type="application\/json" id="shadowlap-data">([\s\S]*?)<\/script>/.exec(html)![1]) as StaticPayload;
}

/** The copy's page for the route the address bar holds, as its shell draws it. */
function Routed() {
  return createElement(CopyPages, { route: useRoute() });
}

/** A copy of these runs, opened at `hash`, with `beside` drawn beside its page as its shell draws them; the address bar it reads and rewrites. */
async function open(runIds: string[], hash: string, ...beside: ReactElement[]) {
  const bar = { hash, search: '', pathname: '/', host: '' };
  vi.stubGlobal('location', bar);
  vi.stubGlobal('history', { state: null, replaceState: (_s: unknown, _t: string, url: string) => void (bar.hash = url.slice(url.indexOf('#'))) });
  r = await render(createElement(AppProvider, { client: createExportedClient(exported(runIds)), children: createElement(Fragment, null, createElement(Routed), ...beside) }));
  return bar;
}

/** The copy's app as it stands, as a part of its shell reads it. */
const seen: { app: AppState | null } = { app: null };
function Probe() {
  seen.app = useApp();
  return null;
}
const COPY_OFF = 'This is an exported copy: nothing runs from here.';

const runOpen = () => r!.all('.rhead .rnm').map((h) => h.getAttribute('data-run'));

/** The modules of the page's code that load a module whose path matches `module`: a type alone loads nothing. */
function loadersOf(module: RegExp): string[] {
  const ui = fileURLToPath(new URL('../ui/', import.meta.url));
  return readdirSync(ui, { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.tsx?$/.test(f) && readFileSync(join(ui, f), 'utf8').split('\n').some((l) => module.test(l) && !/^import type\b/.test(l.trim())))
    .map((f) => f.split(sep).join('/'));
}

describe('an exported copy', () => {
  it('opens on the run that was shared, the one the others lead to, whichever order it lists them in', async () => {
    for (const order of [
      [forkId, runId],
      [runId, forkId],
    ]) {
      const bar = await open(order, '#/');
      await r!.until('the shared run’s page', () => runOpen().length === 1);
      // At the call where it forked, as a fork's page opens.
      expect(bar.hash).toBe(`#/run/${forkId}/3`);
      expect(runOpen()).toEqual([forkId]);
      await r!.unmount();
      r = null;
    }
  });

  it('opens each of its runs, and says so of a run it doesn’t hold', async () => {
    await open([forkId, runId], `#/run/${runId}`);
    await r!.until('the run’s page', () => runOpen().length === 1);
    expect(runOpen()).toEqual([runId]);
    await r!.unmount();
    await open([forkId], `#/run/${runId}`);
    // The page's header, as any page has it: not found, Nothing here, what was missing and the way back.
    await r!.until('what the copy says', () => r!.all('.ph h1').length > 0);
    expect(r!.one('.ph h1').textContent.replace(/\u00a0/g, ' ')).toBe('Nothing here');
    expect(r!.one('.ph .eyebrow').textContent).toBe('not found');
    expect(r!.one('.ph').textContent.replace(/\u00a0/g, ' ')).toContain(`No run ${runId} in this copy. Open Runs`);
    expect(r!.one('.ph a.more').getAttribute('href')).toBe('#/runs');
  });

  it('draws no Share on a run’s page, so nothing there opens Share’s menu, which the served dashboard alone hands in', async () => {
    await open([forkId, runId], `#/run/${forkId}`);
    await r!.until('the run’s header and what it offers', () => r!.all('.rhead .actions').length === 1);
    expect(r!.all('#shareBtn')).toHaveLength(0);
    expect(r!.all('.rhead .actions button').map((b) => b.textContent)).not.toContain('Share');
    expect(r!.all('[role="menu"]')).toHaveLength(0);
  });

  it('forks nothing, so nothing there opens the fork menu or the header’s …, which the served dashboard alone hands in', async () => {
    // The page's code that loads their scripts: the served entry's, which a copy's entry never is.
    expect(loadersOf(/\bForkMenu\.js['"]/)).toEqual(['pages/served.tsx']);
    expect(loadersOf(/\bMoreMenu\.js['"]/)).toEqual(['pages/served.tsx']);
    await open([forkId, runId], `#/run/${forkId}/4`);
    await r!.until('the run’s calls', () => r!.all('.rhead .actions').length === 1 && r!.all('tr[data-wi]').length > 0);
    // No Fork at #n in its header or on a row, so neither f nor ⌘K's Fork at #n has one to press, and no ….
    expect(r!.all('#forkBtn, #moreBtn')).toHaveLength(0);
    expect(r!.all('td.rowact button')).toHaveLength(0);
  });

  it('draws no step that asks, so nothing there opens the dialogs the served dashboard alone hands in', async () => {
    await open([forkId, runId], `#/run/${runId}`);
    await r!.until('the run’s header and what it offers', () => r!.all('.rhead .actions').length === 1);
    // What reads stays: the id to copy, and the link to compare.
    expect(r!.all('.rhead button').map((b) => b.textContent)).toEqual(['Copy ID']);
    expect(r!.all('.rhead button[data-next], .rhead button[data-fold]')).toHaveLength(0);
    expect(r!.all('.dialog')).toHaveLength(0);
  });

  it('names an injection attempt by its own record, and draws nothing of what only the test’s read holds: where it planted, its proof, the way to its results', async () => {
    await open([attemptId, runId], `#/run/${attemptId}`);
    await r!.until('the attempt’s finding', () => r!.all('.banner').length > 0);
    expect(r!.one('.rhead').textContent).toContain('injection attempt');
    const banner = r!.all('.banner').map((b) => b.textContent).join(' ').replace(/\u00a0/g, ' ');
    expect(banner).toContain('forked at#3system-notice #2, attempt 2 of 3 · writes stubbed');
    expect(banner).not.toMatch(/Results →|The answer →|planted at/);
    expect(r!.all('.injline, .pbn, mark.cnry, mark.ins-plant')).toHaveLength(0);
  });

  it('keeps no injection test, so the run it tested draws no finding of one, which the served dashboard alone hands in', async () => {
    await open([attemptId, runId], `#/run/${runId}`);
    await r!.until('the run’s header and what it offers', () => r!.all('.rhead .actions').length === 1);
    expect(r!.all('[data-finding="injection"]')).toHaveLength(0);
    expect(r!.all('[data-act="results"]')).toHaveLength(0);
  });

  it('keeps no error-path presets, so the run they ran on draws no finding of them nor their results, which the served dashboard alone hands in', async () => {
    await open([attemptId, runId], `#/run/${runId}`);
    await r!.until('the run’s header and what it offers', () => r!.all('.rhead .actions').length === 1);
    expect(r!.all('[data-finding="presets"]')).toHaveLength(0);
    expect(r!.all('.rmxp')).toHaveLength(0);
  });

  it('runs no injection test, so it offers no Run injection test…, Find cause… nor Pack with injection gate…, and loads none of their dialogs', async () => {
    // The page's code that loads their scripts: the parts the served entry hands in, which a copy's
    // entry never does, so the copy's script holds none of them (COPY_PARTS in test/ui-bundle-size.test.ts).
    for (const part of ['TestDialog', 'PackWithGate', 'FindCause', 'CauseFinding', 'CheckMenu']) expect([part, loadersOf(new RegExp(`\\b${part}\\.js['"]`))]).toEqual([part, ['pages/served.tsx']]);
    // A copy holds no test's read: no untrusted read, so its write has no Find cause…, and no finding of an answer.
    const write = store.getCalls(runId).find((c) => c.name === 'send_email')!.callNo;
    await open([forkId, runId], `#/run/${runId}/${write}`);
    await r!.until('the call’s inspector', () => r!.all('.insp').length === 1);
    expect(r!.all('[data-act="injcause"], [data-finding="cause"], .dialog')).toHaveLength(0);
    // Nor its palette: this run's row and Security's typed rows are the served dashboard's.
    expect(testRow(runId, 3, { live: false, exported: true, next: null, open: () => undefined })).toEqual([]);
    const ctx = { app: { exported: true, actionsOff: null, hasKind: () => true }, route: { page: 'run', id: runId, call: write, view: null }, go: () => undefined } as unknown as PaletteContext;
    const rows = paletteSources().flatMap((source) => {
      try {
        return source(ctx);
      } catch {
        // A source that reads more of the app than this stand-in holds offers nothing here.
        return [];
      }
    });
    expect(rows.filter((x) => x.label === 'Run injection test…')).toEqual([]);
  });

  it('keeps Failed a filter over its runs, so draws no issues, which the served dashboard alone hands in', async () => {
    await open([forkId, runId], '#/runs?types=failed');
    await r!.until('Failed picked', () => r!.all('.tbar .chips button[aria-pressed="true"]').some((b) => b.childNodes[0]?.textContent === 'Failed'));
    expect(r!.all('table.issues')).toHaveLength(0);
  });

  it('never opens Export OpenTelemetry trace…: Share’s menu alone loads its dialog, and a copy draws no Share', () => {
    // The page's code that loads the dialog's script: Share's menu, and nothing a copy draws, so the
    // copy's script holds none of it (COPY_PARTS in test/ui-bundle-size.test.ts).
    expect(loadersOf(/\bOtelDialog\.js['"]/)).toEqual(['run/ShareMenu.tsx']);
  });

  it('offers no Add check… at a tool call, in its inspector or its row, as only the served dashboard hands a page the check menu and the builder', async () => {
    await open([forkId, runId], `#/run/${runId}/4`);
    await r!.until('the tool call’s inspector, with its summary line', () => r!.all('section.insp[aria-label="Call 4"] .isumrow .isum').length === 1);
    expect(r!.one('section.insp[aria-label="Call 4"] .ct').textContent).toBe('search_web');
    expect(r!.all('[data-act="ckmenu"]')).toHaveLength(0);
    expect(r!.all('[role="menu"]')).toHaveLength(0);
  });

  it('never opens the check menu, the check builder or Run blame’s dialogs: the served entry alone loads them, and a copy offers no Add check… at a tool call', async () => {
    // The page's code that loads their scripts: the parts the served entry hands in, which a copy's
    // entry never does, so the copy's script holds none of ui/checks/ (HEAVY in test/ui-bundle-size.test.ts)
    // nor the check menu or Run blame's dialogs. A copy draws no Run blame: its one next step is Compare (test/next-step.test.ts).
    expect(loadersOf(/\bCheckMenu\.js['"]/)).toEqual(['pages/served.tsx']);
    expect(loadersOf(/\bchecks\/Builder\.js['"]/)).toEqual(['pages/served.tsx']);
    expect(loadersOf(/\bRunBlameAsks\.js['"]/)).toEqual(['pages/served.tsx']);
    // At a tool call of a finished recording, where the served dashboard offers it on the inspector.
    await open([forkId, runId], `#/run/${forkId}/4`);
    await r!.until('the call’s inspector', () => r!.all('.insp').length === 1);
    expect(r!.all('[data-act="ckmenu"]')).toHaveLength(0);
  });

  it('never opens New preview’s dialogs: the served entry alone loads them, and a copy holds no previews and offers no Preview change', async () => {
    // The page's code that loads their script: the part the served entry hands in, which a copy's
    // entry never does, so the copy's script holds none of it (COPY_PARTS in test/ui-bundle-size.test.ts).
    // Changes, where Preview's bar offers New preview, is no page of a copy.
    expect(loadersOf(/\bNewPreview\.js['"]/)).toEqual(['pages/served.tsx']);
    // A run's Decisions view, where the served dashboard offers New preview of the run.
    await open([forkId, runId], `#/run/${forkId}/1/decisions`);
    await r!.until('the Decisions view', () => r!.all('.dview').length === 1);
    expect(r!.one('.dview').textContent.replace(/\u00a0/g, ' ')).toBe('An exported copy holds no previews.');
    expect(r!.all('.dview button')).toHaveLength(0);
    // A copy's Runs picks nothing, so it draws no bulk bar, whose Preview change shows only where the
    // dashboard previews (test/ui-runs-bulk.test.ts).
    await r!.unmount();
    await open([forkId, runId], '#/runs');
    await r!.until('the runs', () => r!.all('table.runst tbody tr').length === 2);
    expect(r!.all('table.runst input[type="checkbox"]')).toHaveLength(0);
    expect(r!.all('.bulkbar')).toHaveLength(0);
  });

  it('starts and follows no job, so it draws no job’s drawer and needs none of a job’s words, which the served dashboard alone hands in', async () => {
    // The page's code that loads them: the served entry's, and modules only the served dashboard holds,
    // the drawer itself and Fixes' (COPY_PARTS in test/ui-bundle-size.test.ts).
    expect(loadersOf(/\bcomponents\/Drawer\.js['"]/)).toEqual(['pages/served.tsx']);
    // A refused job's Run again, allowing reads its job's lines, and only the drawer draws it.
    expect(loadersOf(/['"]\.\.?\/allow-again\.js['"]/)).toEqual(['components/Drawer.tsx']);
    expect(loadersOf(/['"]\.\.?\/jobs\.js['"]/).sort()).toEqual(['allow-again.tsx', 'components/Drawer.tsx', 'fixes/ApplyNames.tsx', 'pages/served.tsx']);
    await open([forkId, runId], `#/run/${runId}`, createElement('footer', { className: 'status' }, createElement(JobChip)), createElement(Probe));
    await r!.until('the run’s page', () => runOpen().length === 1);
    const app = seen.app!;
    // Each way a job comes to the page, a job's start, a run's action and one another tab follows,
    // asks the copy's client, which refuses them all: the shell draws the drawer only for a job it follows.
    await act(async () => app.watchJob(app.client.startJob(JOB_KINDS.bisect, { runId })));
    await act(async () => app.watchJob(app.client.action(runId, 'r', null)));
    await act(async () => app.openJob('job-1', true));
    await r!.wait(20);
    expect(seen.app!.jobs).toEqual([]);
    expect(seen.app!.toastText?.text).toBe('This is an exported copy: it cannot be changed from here');
    await expect(app.client.jobs()).resolves.toEqual([]);
    // Nor has its chip a job to say, the server's own jobs none: it draws nothing.
    expect(r!.all('.jobchip')).toHaveLength(0);
  });

  it('runs no action, so no action and no Find breaking commit asks in a dialog, which the served dashboard alone hands in', async () => {
    // The page's code that loads their scripts: the served entry's, the header's … (Delete run's dialog)
    // and a crash's step on Tests and Fixes, none of which a copy holds (test/ui-bundle-size.test.ts).
    expect(loadersOf(/\bActionDialog\.js['"]/)).toEqual(['pages/served.tsx']);
    expect(loadersOf(/\bRunDialogs\.js['"]/).sort()).toEqual(['pages/served.tsx', 'revert/CrashStep.tsx', 'run/MoreMenu.tsx']);
    const ran: { runner: ReturnType<typeof useActionRunner> | null } = { runner: null };
    function Runner() {
      ran.runner = useActionRunner(runId);
      return createElement('div', { className: 'runner' }, ran.runner.dialog);
    }
    await open([forkId, runId], `#/run/${runId}`, createElement(Runner), createElement(Probe));
    await r!.until('the run’s page', () => runOpen().length === 1);
    expect(seen.app!.actionsOff).toBe(COPY_OFF);
    // An action that asks its one thing first, and Find breaking commit, which asks for a commit: each says why it waits.
    const inject: ActionItem = { key: 'i', label: 'Inject instruction…', opensRun: true, prompt: { label: 'Instruction to add at #3:' }, disabled: null, group: 'call' };
    await act(async () => ran.runner!.run({ action: inject, callNo: 3 }));
    const said = seen.app!.toastText;
    expect(said?.text).toBe(COPY_OFF);
    await act(async () => void ran.runner!.findCommit());
    expect(seen.app!.toastText).not.toBe(said);
    expect(seen.app!.toastText?.text).toBe(COPY_OFF);
    await r!.wait(20);
    expect(ran.runner!.dialog).toBeNull();
    expect(r!.all('.dialog')).toHaveLength(0);
  });

  it('runs no test’s job, so a test that diverged offers none and asks in none of its dialogs, which the served dashboard alone hands in', async () => {
    expect(loadersOf(/\bDivergedDialogs\.js['"]/)).toEqual(['pages/served.tsx']);
    await open([forkId, runId], `#/run/${forkId}`, createElement(Probe));
    await r!.until('the run’s page', () => runOpen().length === 1);
    const app = seen.app!;
    // Its meta lists no job kinds, and its actions wait: a test replay that diverged, where the served
    // dashboard offers Add normalizer and update and Update golden, draws neither. Its next step is
    // only ever Compare (test/next-step.test.ts), so no step asks in them either.
    expect(app.hasKind(JOB_KINDS.normalizeAndTest)).toBe(false);
    expect(app.hasKind(JOB_KINDS.testUpdate)).toBe(false);
    const test = { golden: 'goldens/refund', normalizeAndTest: [['config', 'normalize'], ['test', 'goldens/refund', '--update']], normalized: false, passingRun: null, volatile: null } as unknown as TestBannerOffer;
    const run = { run: { runId: forkId }, actions: [{ key: 'n' }] } as unknown as RunDetail;
    expect(bannerJobsShown(app, run, test, () => false)).toBe(false);
  });

  it('says what it is in the project switcher’s place, so nothing opens Remove project, which the served dashboard alone hands in', async () => {
    // Setup, the other page that holds its words, is no page of a copy.
    expect(loadersOf(/\bRemoveProject\.js['"]/).sort()).toEqual(['pages/Setup.tsx', 'pages/served.tsx']);
    const held: { removal: ProjectRemoval | null } = { removal: null };
    function Block() {
      held.removal = useProjectRemoval();
      return createElement('div', { className: 'side' }, createElement(ProjectBlock, { meta: useApp().meta }));
    }
    await open([forkId, runId], `#/run/${runId}`, createElement(Block));
    await r!.until('the copy’s block', () => r!.all('.side .expblock').length === 1);
    expect(r!.all('.side button')).toHaveLength(0);
    expect(held.removal).toBeNull();
  });

  it('forks with no edited result, so nothing opens Edit and fork’s dialog, which the served dashboard alone hands in', async () => {
    expect(loadersOf(/\bEditDialog\.js['"]/)).toEqual(['pages/served.tsx']);
    // At a tool call, where the served dashboard offers it on the inspector.
    await open([forkId, runId], `#/run/${forkId}/4`);
    await r!.until('the call’s inspector', () => r!.all('.insp').length === 1);
    expect(r!.all('.insp button').map((b) => b.textContent)).not.toContain('Edit and fork…');
    await r!.unmount();
    // Even for a call whose fork menu would offer the override, its button draws nothing in a copy.
    const detail = { call: { callNo: 4 }, actions: [{ key: 'o', label: 'Override result…', opensRun: true, prompt: { label: 'Result to fork with:' }, disabled: null, group: 'call' }] } as unknown as CallDetail;
    await open([forkId, runId], `#/run/${forkId}`, createElement('div', { className: 'edit' }, createElement(EditAndFork, { runId: forkId, detail, live: false })));
    await r!.until('the run’s page', () => runOpen().length === 1);
    expect(r!.one('.edit').childNodes).toHaveLength(0);
  });

  it('says it holds no such run itself, never asking another project, so nothing opens the In page, which the served dashboard alone hands in', async () => {
    expect(loadersOf(/\/Elsewhere\.js['"]/)).toEqual(['pages/served.tsx']);
    // A page's not-found as the copy's run page draws it (above): its own, at once, with no look of asking.
    const ask = createElement(Elsewhere, { ask: { what: 'run', ids: ['01ZZZZZZZZZZZZZZZZZZZZZZZZ'] }, waiting: createElement('p', { className: 'asking' }, 'Loading the run…'), fallback: createElement('p', { className: 'notfound' }, 'No run here') });
    await open([forkId, runId], `#/run/${runId}`, createElement('div', { className: 'held' }, ask));
    await r!.until('the run’s page', () => runOpen().length === 1);
    expect(r!.all('.held p').map((p) => p.className)).toEqual(['notfound']);
  });

  it('opens no palette: ⌘K, / and the top bar open nothing, nor Enter on a row, which has no actions, as the served dashboard alone hands it in', async () => {
    expect(loadersOf(/\/Palette\.js['"]/)).toEqual(['pages/served.tsx']);
    await open([forkId, runId], `#/compare/${runId}/${forkId}`, createElement(TopBar, { route: { page: 'compare', a: runId, b: forkId, call: null } }), createElement(Keyboard), createElement(Probe));
    await r!.until('the comparison', () => r!.all('.prefix').length === 1);
    // No Search or jump to… in the top bar, and no key opens the palette.
    expect(r!.all('header button').map((b) => b.getAttribute('aria-label') ?? b.textContent)).not.toContainEqual(expect.stringMatching(/^Search/));
    for (const [key, mods] of [['k', { metaKey: true }], ['k', { ctrlKey: true }], ['/', {}]] as const) {
      await r!.press(key, mods);
      expect(seen.app!.palette, `${key} ${JSON.stringify(mods)}`).toBe(false);
    }
    await r!.unmount();
    // On its runs, a row in focus: ⌘K and Enter open nothing on its actions, which a copy's lists don't have.
    await open([forkId, runId], '#/runs', createElement(Keyboard), createElement(Probe));
    await r!.until('the runs', () => r!.all('table.runst tbody tr').length === 2);
    await r!.press('j');
    await r!.press('k', { metaKey: true });
    await r!.press('Enter');
    expect(seen.app!.palette).toBe(false);
  });

  it('never opens Preview pull request comment, which the served dashboard alone hands in: only Settings → CI and a revision’s page under Changes show it, which a copy sends to its runs, and its client refuses the read', async () => {
    // The page's code that loads the dialog's script: the served entry's, which a copy's entry never
    // is (COPY_PARTS in test/ui-bundle-size.test.ts). Its decisions' steps it shares with a revision's page alone.
    expect(loadersOf(/\bPrCommentDialog\.js['"]/)).toEqual(['pages/served.tsx']);
    expect(loadersOf(/\bcomment-parts\.js['"]/).sort()).toEqual(['changes/RevisionPage.tsx', 'ci/PrCommentDialog.tsx']);
    await expect(createExportedClient(exported([runId])).settings.prComment()).rejects.toThrow();
  });

  it('lists its runs, and only those', async () => {
    await open([forkId, runId], '#/runs');
    await r!.until('the runs', () => r!.all('table.runst tbody tr').length === 2);
    const rows = r!.all('table.runst tbody tr').map((tr) => tr.textContent);
    expect(rows.some((t) => t.includes(forkId.slice(0, 10)))).toBe(true);
    expect(rows.some((t) => t.includes(runId.slice(0, 10)))).toBe(true);
  });

  it('compares the runs it holds', async () => {
    await open([forkId, runId], `#/compare/${runId}/${forkId}`);
    await r!.until('the comparison', () => r!.all('.prefix').length === 1);
    expect(r!.one('.prefix b').textContent).not.toBe('');
    expect(r!.all('.pickers').length).toBe(1);
  });

  it('sends any other page to its runs, and Compare too when it holds one run', async () => {
    for (const [runIds, hash] of [
      [[forkId, runId], '#/fixes'],
      [[forkId, runId], '#/changes'],
      [[forkId, runId], '#/tests'],
      [[forkId, runId], '#/settings/ci'],
      [[forkId], '#/compare'],
    ] as const) {
      const bar = await open([...runIds], hash);
      await r!.until(`${hash} to open the runs`, () => r!.all('table.runst tbody tr').length === runIds.length);
      expect(bar.hash, hash).toBe('#/runs');
      await r!.unmount();
      r = null;
    }
  });
});
