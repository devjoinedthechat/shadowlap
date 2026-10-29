import type { ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { useMemo, useRef } from 'react';
import { commandIsImported, formatTokens, messageOf, type CallRecord, type RunRecord, type Store } from '@shadowlap/engine';
import type { Action } from '../actions.js';
import { copyToClipboard } from '../clipboard.js';
import { loadRequest, loadResponseBytes } from '../data.js';
import { expectError, fixActions, fixJob, settleJob, type BlameAction, type FixContext, type FixJob } from '../fix-actions.js';
import { isFailing, type Verdict } from '../verdict.js';
import type { Tab } from './Inspector.js';
import type { Tone } from './Row.js';
import type { Mode } from './timeline-state.js';

export type SpawnCli = (args: string[]) => ChildProcess;
/** Opens a run in the dashboard, at a call when given; `opened` is false when no browser could be started. */
export type OpenDashboard = (runId: string, callNo?: number) => Promise<{ url: string; opened: boolean }>;

/** What the timeline acts with: the run and the call in front of you, how the run stands, and the project's settings. */
export interface TimelineActionsInput {
  store: Store;
  run: RunRecord;
  current: CallRecord | undefined;
  tab: Tab;
  verdict: Pick<Verdict, 'outcome' | 'fix'>;
  /** A process is recording the run right now. */
  recording: boolean;
  tests?: unknown;
  configDir: string | null;
  repairer?: (() => string | null) | undefined;
  /** Moves when the run was read again (after a job): a job changes the fix the run is in, and what it selects. */
  version: number;
  spawnCli?: SpawnCli | undefined;
  openDashboard?: OpenDashboard | undefined;
  setMode: (mode: Mode) => void;
  say: (text: string, ms?: number, tone?: Tone) => void;
}

/** What the job runs after `shadowlap`, as the consent shows it: without the --yes it carries for the CLI. */
export function shownArgs(args: readonly string[]): string[] {
  const end = args.indexOf('--');
  return args.filter((a, i) => a !== '--yes' || (end >= 0 && i > end));
}

/**
 * What the timeline runs: the CLI's commands from the fork menu, the Fixes flow from this run (B, R
 * and V in the menu: blame the run, repair the fix it fails in, or verify a change for that fix),
 * and what its keys do with the call in front of you (copy it, write it out, open the dashboard).
 */
export function useTimelineActions(o: TimelineActionsInput) {
  const { store, run, current, tab, verdict, recording, tests, configDir, repairer, version, spawnCli, openDashboard, setMode, say } = o;
  const runAction = (args: string[], refresh = false) => {
    if (!spawnCli) return;
    const child = spawnCli(args);
    setMode({ kind: 'output', title: `shadowlap ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`, child, refresh });
  };
  const fixContext = useMemo<FixContext>(() => ({ failing: isFailing(verdict.outcome, verdict.fix), recording, tests, configDir, ...(repairer ? { repairer } : {}) }), [verdict, recording, tests, configDir, repairer]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- a job (version) changes the fix the run is in, and what it selects
  const fixes = useMemo(() => fixActions(store, run, fixContext), [store, run, fixContext, version]);
  const fixMenu = useMemo(() => fixes.map((f): Action => ({ key: f.key, label: f.label, flag: f.flag, hint: f.hint, opensRun: false, ...(f.disabled ? { disabled: f.disabled } : {}) })), [fixes]);
  const runFix = (fix: BlameAction, value: string) => {
    const wrong = expectError(value, fix.needsExpect);
    if (wrong) {
      setMode({ kind: 'timeline' });
      return say(`not run: ${wrong}`, 6000, 'warn');
    }
    const args = fix.build(value.trim());
    // Someone else's pack's run: its command runs only on a yes of its own, as a replay's does.
    if (commandIsImported(run)) setMode({ kind: 'consent', action: fixMenu.find((a) => a.key === fix.key)!, args: [...args, '--yes'], refresh: true });
    else runAction(args, true);
  };
  /**
   * A yes to a repair or a verify, answered against the store as it is now (`settleJob`): it runs the
   * line it showed, or shows the new one when what it would run, or whom the question names, changed.
   */
  const showings = useRef(0);
  const showJob = (job: FixJob, again?: string) => setMode({ kind: 'job', job, shown: ++showings.current, ...(again ? { again } : {}) });
  const runJob = (shown: FixJob, typed: boolean) => {
    const settled = settleJob(store, run, shown, fixContext, typed);
    if ('run' in settled) return runAction(settled.run, true);
    if ('again' in settled) return showJob(settled.again, 'What it runs changed since it was shown: read it again.');
    setMode({ kind: 'timeline' });
    say(`not run: ${settled.refused}`, 8000, 'warn');
  };
  // A replay of a run from someone else's pack, or a teammate's pulled from the team store, runs
  // their command: whatever the action asked first (attempts, an instruction), it runs only once a
  // step of its own has shown the exact command line and been answered yes, as the dashboard asks.
  const pick = (action: Action) => {
    if (action.disabled || !spawnCli) return;
    const fix = fixes.find((f) => f.key === action.key);
    if (fix?.kind === 'blame') return setMode({ kind: 'fix', fix });
    // Built as the store and the config stand now, not when the menu was drawn: who is asked, and whom the question names.
    if (fix) {
      const job = fixJob(store, store.getRun(run.runId) ?? run, fix.key, fixContext);
      if (!job.disabled) return showJob(job);
      setMode({ kind: 'timeline' });
      return say(`not run: ${job.disabled}`, 6000, 'warn');
    }
    if (action.imported === 'confirm') setMode({ kind: 'consent', action, args: action.prompt!.build('yes') });
    else if (action.prompt) setMode({ kind: 'prompt', action });
    else if (action.args) runAction(action.args);
  };

  const payloadOf = (c: CallRecord, which: 'request' | 'response'): string => {
    if (which === 'response') {
      const bytes = loadResponseBytes(store, c);
      return bytes ? bytes.toString('utf8') : '';
    }
    return JSON.stringify(loadRequest(store, c), null, 2) ?? '';
  };
  const yank = () => {
    if (!current) return;
    const which = tab === 'response' ? 'response' : 'request';
    const text = payloadOf(current, which);
    void copyToClipboard(text).then((ok) => (ok ? say(`copied ${which} of #${current.callNo} (${formatTokens(text.length)} chars)`, 2500, 'ok') : say('clipboard unavailable (pbcopy / xclip / wl-copy / clip not found)', 4000, 'warn')));
  };
  const writeOut = () => {
    if (!current) return;
    const file = resolvePath(process.cwd(), `shadowlap-${run.runId.slice(0, 10).toLowerCase()}-call${current.callNo}.json`);
    try {
      writeFileSync(file, JSON.stringify({ call: current, request: loadRequest(store, current), response: payloadOf(current, 'response') }, null, 2));
      say(`wrote ${file}`, 4000, 'ok');
    } catch (err) {
      say(`could not write: ${messageOf(err)}`, 6000, 'err');
    }
  };
  const toDashboard = () => {
    if (!openDashboard) return say('the dashboard is not available here; run shadowlap dashboard', 2500, 'warn');
    const callNo = current?.callNo;
    say('starting the dashboard…', 10_000);
    openDashboard(run.runId, callNo).then(
      ({ url, opened }) => {
        if (opened) return say(`opened ${callNo !== undefined ? `#${callNo}` : 'this run'} in the dashboard`, 2500, 'ok');
        // No browser (SSH, a container): the link stays up long enough to copy, and goes to the clipboard when there is one.
        void copyToClipboard(url).then((copied) => say(`dashboard${copied ? ' (link copied)' : ''}: ${url}`, 30_000));
      },
      (err: unknown) => say(`could not start the dashboard: ${messageOf(err)}`, 8000, 'err'),
    );
  };
  return { runAction, fixMenu, runFix, runJob, pick, yank, writeOut, toDashboard };
}
