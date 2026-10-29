import { Box, Text, useInput } from 'ink';
import type { ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CallRecord, RunRecord, Store, StoreOf } from '@shadowlap/engine';
import { safeLine, formatDuration, formatTokens, formatUsd, importedCommandSource, quoteArgv, shortModel, summarizeRun, wholeInput, type ModelResolver, type SummaryOptions, shortCallName } from '@shadowlap/engine';
import { copyToClipboard } from '../clipboard.js';
import { attemptBundles, commandIsImported, lostAt, messageOf, withAttempts, type Normalizer, type RunAbout } from '@shadowlap/engine';
import { aboutRun, fitAbout } from '../about.js';
import { expectError, fixActions, fixJob, settleJob, type BlameAction, type FixContext, type FixJob } from '../fix-actions.js';
import { attemptTallies } from '../attempts.js';
import { forkEffects } from '../fork-effects.js';
import type { RunFacts } from '../run-lines.js';
import { ago, kindFacts, loadRequest, loadResponseBytes, modelAction, runLabel, type ModelAction } from '../data.js';
import { markKey, type RunMark } from '../marks.js';
import { blameReport, isFailing, toneOf, verdictOf, type Declared, type Fact } from '../verdict.js';
import { divergenceSummary } from '../diff.js';
import { cells, fitColumns, fitItems } from '../render.js';
import { displayOrigin, kindLabel, useTheme } from '../theme.js';
import { actionContext, ActionsView, forkMenuTitle, notRun, recordingNow, terminalActions, type Action } from './ActionsView.js';
import { Inspector, TAB_KEYS, tabsFor, type InspectorView, type PlayState, type Tab } from './Inspector.js';
import { FixJobView } from './FixJobView.js';
import { OutputPane } from './OutputPane.js';
import { cell, KeyHints, Line, Row, type Cell, type Hint, type Tone } from './Row.js';
import { TextInput } from './TextInput.js';

export type SpawnCli = (args: string[]) => ChildProcess;
/** Opens a run in the dashboard, at a call when given; `opened` is false when no browser could be started. */
export type OpenDashboard = (runId: string, callNo?: number) => Promise<{ url: string; opened: boolean }>;

type Filter = 'all' | 'live' | 'replayed' | 'fenced';
const FILTERS: Filter[] = ['all', 'live', 'replayed', 'fenced'];
const SPEEDS = [1, 2, 4, 0];

interface Props {
  store: Store;
  run: RunRecord;
  calls: CallRecord[];
  width: number;
  height: number;
  onBack: () => void;
  onHelp: () => void;
  onOpenRun: (runId: string) => void;
  spawnCli?: SpawnCli;
  openDashboard?: OpenDashboard;
  initialCall?: number;
  /** Price table and model resolver for cost estimates. */
  summaryOptions?: SummaryOptions;
  /** Help is open over it: it keeps its state and takes no keys. */
  paused?: boolean;
  /** Labels a run good or bad (`+`, `-`); says what it did. */
  onMark?: (runId: string, mark: RunMark) => string;
  /** `tools.unrecorded` from shadowlap.config.json, for the unrecorded-tools warning. */
  declared?: Declared;
  /** The project's normalizers: what they mask is no difference between a fork and its parent. */
  normalizers?: readonly Normalizer[];
  /** The view was asked to open at a call (`--call`): it opens there, on the call, whatever the run's verdict. */
  askedCall?: boolean;
  /** shadowlap.config.json's `tests` as written and its folder: the check a golden's runs are blamed under. */
  tests?: unknown;
  configDir?: string | null;
  /** Moves when the run was read again (after a job, a mark or a note): what was worked out from the store once a run is worked out again. */
  version?: number;
  /** The tab to open on (a search's match: where in the call it was found). */
  initialTab?: Tab;
  /** Reads the run again from the store: after blame, repair or verify, its verdict has changed. */
  onRefresh?: (runId: string) => void;
  /** Adds a note on a call of the run (`N`), as `shadowlap note` adds one; says what it did. */
  onNote?: (runId: string, callNo: number | null, text: string) => string;
  /** The repairer shadowlap.config.json names now (`repair.repairer`), read when a repair is shown and again on its yes. */
  repairer?: () => string | null;
}

/** The runs an attempt of `run` can be among: its descendants and its siblings (a test's are filed under a sibling). */
function runsAround(store: StoreOf<'recording'>, run: RunRecord): RunRecord[] {
  const out = [run, ...(run.parentRunId ? store.childRuns(run.parentRunId) : [])];
  for (let i = 0; i < out.length && out.length < 5000; i++) if (i === 0 || out[i]!.parentRunId !== run.parentRunId) out.push(...store.childRuns(out[i]!.runId));
  return [...new Map(out.map((r) => [r.runId, r])).values()];
}

type Mode =
  | { kind: 'timeline' }
  | { kind: 'actions' }
  | { kind: 'prompt'; action: Action }
  /** A replay of someone else's run, asked once more on its own: the exact command line it runs, then a yes. */
  | { kind: 'consent'; action: Action; args: string[]; refresh?: boolean }
  /** Blame: what a passing run does, then the command runs. */
  | { kind: 'fix'; fix: BlameAction }
  /**
   * Repair or verify the run's fix: the command line, what stands in the way, and a yes; `again` says
   * why it is asked once more, and `shown` counts the showings, so each starts with nothing typed.
   */
  | { kind: 'job'; job: FixJob; again?: string; shown: number }
  /** A note on the selected call. */
  | { kind: 'note'; callNo: number | null }
  /** Filtering as you type; Esc puts back the filter and the selection from before. */
  | { kind: 'search'; before: string; beforeNo: number | null }
  /** A job's output; `refresh` reads the run again when it closes (blame, repair and verify change its verdict). */
  | { kind: 'output'; title: string; child: ChildProcess; refresh?: boolean };

function matches(c: CallRecord, f: Filter): boolean {
  if (f === 'all') return true;
  if (f === 'fenced') return c.origin === 'blocked' || c.origin === 'stubbed';
  // "live" means it reached the provider; an injected failure did not.
  if (f === 'live') return displayOrigin(c) === 'live';
  return c.origin === f;
}

/** A call worth jumping to: anything that didn't simply replay cleanly. */
function notable(c: CallRecord): boolean {
  return c.origin !== 'replayed' || c.end?.outcome === 'error';
}

function rowDetail(store: StoreOf<'recording'>, c: CallRecord, modelOf?: ModelResolver): string {
  if (c.kind === 'api') {
    const u = c.end?.meta.usage;
    const model = shortModel(c.end?.meta.model ?? c.meta.model ?? modelOf?.(c));
    return [model, u ? `${formatTokens(wholeInput(u))} in, ${formatTokens(u.outputTokens)} out` : ''].filter(Boolean).join(' · ');
  }
  if (c.kind === 'tool' && c.requestRef) {
    const req = store.getJson<{ args?: unknown }>(c.requestRef);
    return JSON.stringify(req?.args ?? null) ?? '';
  }
  return '';
}

function scopeOf(c: CallRecord): string {
  return typeof c.meta.scope === 'string' ? c.meta.scope : '';
}

/**
 * The footer's keys, in the order they are shown: `? help` first, so a narrow terminal still says
 * where the rest are. A key that does nothing for the run or the call in front of you (`d` on a run
 * that didn't fork) is left out.
 */
export const TIMELINE_KEYS: readonly Hint[] = [
  ['?', 'help'],
  [':', 'fork'],
  ['v', 'verdict'],
  ['b', 'lost at'],
  ['d', 'diff'],
  ['/', 'filter'],
  ['z', 'zoom'],
  ['[ ]', 'notable'],
  ['space', 'play'],
  ['o', 'dashboard'],
  ['y', 'copy'],
  ['w', 'write'],
  ['N', 'note'],
  ['p', 'parent'],
  ['+ -', 'good/bad'],
  ['f', 'origins'],
  ['q', 'back'],
];
export const INSPECTOR_KEYS: readonly Hint[] = [
  ['?', 'help'],
  ['j/k', 'scroll'],
  ['tab', 'next tab'],
  ['z', 'zoom'],
  ['y', 'copy'],
  ['h', 'calls'],
  ['q', 'back'],
];
/** What the fork menu's footer says before its keys. */
export const FORK_MENU_LEAD = 'a letter runs its action';
export const FORK_MENU_KEYS: readonly Hint[] = [
  ['enter', 'run'],
  ['j/k', 'move'],
  ['esc', 'close'],
];

/**
 * The line under a run's header: what it was about, quiet, then how it stands in its verdict's
 * colour. The verdict's first fact is shown whole when it can be: the about line gives way first,
 * down to a few words.
 */
function AboutLine({ about, facts, width }: { about: Pick<RunAbout, 'text' | 'from'>; facts: readonly Fact[]; width: number }) {
  const theme = useTheme();
  const tone = toneOf(facts);
  const color = tone === 'ok' ? theme.ok : tone === 'warn' ? theme.warn : tone === 'err' ? theme.err : undefined;
  const mark = { err: '✗', warn: '!', ok: '✓', info: '·' }[tone];
  const first = facts[0] ? cells(safeLine(facts[0].text)) + 5 : 0;
  const aboutWidth = facts.length ? Math.max(12, Math.min(Math.floor(width * 0.4), width - 2 - first)) : width - 2;
  const lead = ` ${safeLine(fitAbout(about, aboutWidth))}`;
  const room = Math.max(0, width - cells(lead) - 5);
  return (
    <Box height={1} width={width} flexShrink={0}>
      <Text wrap="truncate">
        <Text color={theme.dim}>{lead}</Text>
        {facts.length ? <Text {...(color ? { color } : {})}>{`  ${mark} ${fitItems(facts.map((f) => safeLine(f.text)), room)}`}</Text> : null}
      </Text>
    </Box>
  );
}

/** A row of the call list: a call, or a line drawn before one: where the run forked from its parent, or where blame found it lost. */
type Item = { kind: 'call'; at: number } | { kind: 'fork' } | { kind: 'lost' };

export function TimelineView({ store, run, calls, width, height, onBack, onHelp, onOpenRun, spawnCli, openDashboard, initialCall, summaryOptions, paused = false, onMark, declared, normalizers, askedCall = false, onRefresh, onNote, initialTab, tests, configDir = null, version = 0, repairer }: Props) {
  const theme = useTheme();
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const modelOf = summaryOptions?.modelOf;
  const divergence = run.divergence;
  const tabs = useMemo(() => tabsFor(divergence), [divergence]);

  // What a filter searches and what a model call did, worked out once a call: a call's record
  // doesn't change once it has ended, and a run still recording only adds calls.
  const details = useRef(new Map<string, string>());
  const searched = useRef(new Map<string, string>());
  const actions = useRef(new Map<string, ModelAction>());
  const keyOf = (c: CallRecord) => `${c.callNo}:${c.end ? 1 : 0}`;
  const detailOf = (c: CallRecord) => {
    const k = keyOf(c);
    let d = details.current.get(k);
    if (d === undefined) details.current.set(k, (d = rowDetail(store, c, modelOf)));
    return d;
  };
  const searchText = (c: CallRecord) => {
    const k = keyOf(c);
    let s = searched.current.get(k);
    if (s === undefined) searched.current.set(k, (s = `${c.name} ${kindLabel[c.kind] ?? c.kind} ${detailOf(c)} ${c.end?.meta.stopReason ?? ''} ${displayOrigin(c)} ${scopeOf(c)}`.toLowerCase()));
    return s;
  };
  const actionOf = (c: CallRecord) => {
    const k = keyOf(c);
    let a = actions.current.get(k);
    if (a === undefined) actions.current.set(k, (a = modelAction(store, c)));
    return a;
  };

  const visibleCalls = useMemo(() => {
    const q = query.trim().toLowerCase();
    return calls.filter((c) => matches(c, filter) && (!q || searchText(c).includes(q)));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- searchText reads only the store and the call, which its cache keys
  }, [calls, filter, query]);
  // A run that ended early forked past its last call: it opens at that last call.
  const atFork = !!divergence && initialCall === divergence.callNo;
  // How the run stands (its checks, blame, fix, unrecorded tools), the attempts bundled under it,
  // blame's report and what a fork did differently: each worked out once a run, not on each key.
  const verdict = useMemo(() => verdictOf(store, run, calls, declared), [store, run, calls, declared]);
  const attempts = useMemo(() => {
    const around = runsAround(store, run);
    const ids = withAttempts(attemptBundles(around), run.runId);
    const byId = new Map(around.map((r) => [r.runId, r]));
    return ids.length ? attemptTallies(ids.flatMap((id) => byId.get(id) ?? [])) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the attempts change when the run ends, or a job adds some (version), not each time it is read again
  }, [store, run.runId, run.status, version]);
  const blameAt = run.meta?.blame?.at;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- a new blame of the run is what changes its report
  const blame = useMemo(() => blameReport(store, run.runId), [store, run.runId, blameAt]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- a fork's effects change as its calls come, not each time it is read again
  const fork = useMemo(() => forkEffects(store, run, calls, normalizers), [store, run.runId, run.status, calls.length, normalizers]);
  const facts = useMemo<RunFacts>(() => ({ verdict, attempts, blame, fork }), [verdict, attempts, blame, fork]);
  // What the run was about, as the dashboard names it, and the calls someone left a note on.
  const about = useMemo(() => aboutRun(store, run, calls.length), [store, run, calls.length]);
  const notedCalls = useMemo(() => new Set((run.meta?.notes ?? []).flatMap((n) => (n.callNo === null ? [] : [n.callNo]))), [run.meta?.notes]);
  const lost = lostAt(run);
  const [initialIndex] = useState(() => {
    const i = initialCall !== undefined ? calls.findIndex((c) => c.callNo === initialCall) : -1;
    if (i < 0 && atFork && divergence?.type === 'ended_early') return Math.max(0, calls.length - 1);
    return i >= 0 ? i : 0;
  });
  // The selected call, by its number: a filter that hides it, and clears again, leaves it selected.
  const [selectedNo, setSelectedNo] = useState<number | null>(() => calls[initialIndex]?.callNo ?? null);
  const selected = useMemo(() => {
    if (!visibleCalls.length || selectedNo === null) return 0;
    // Hidden by the filter: the nearest call after it that is shown stands in, or the last one.
    const i = visibleCalls.findIndex((c) => c.callNo >= selectedNo);
    return i >= 0 ? i : visibleCalls.length - 1;
  }, [visibleCalls, selectedNo]);
  const select = (i: number) => {
    const c = visibleCalls[Math.max(0, Math.min(visibleCalls.length - 1, i))];
    if (c) setSelectedNo(c.callNo);
  };
  /** Moves from the latest selection, so keys pressed faster than a frame (a held j) each count. */
  const move = (by: number | 'first' | 'last') =>
    setSelectedNo((no) => {
      if (!visibleCalls.length) return no;
      let i = no === null ? 0 : visibleCalls.findIndex((c) => c.callNo >= no);
      if (i < 0) i = visibleCalls.length - 1;
      const to = by === 'first' ? 0 : by === 'last' ? visibleCalls.length - 1 : Math.max(0, Math.min(visibleCalls.length - 1, i + by));
      return visibleCalls[to]!.callNo;
    });
  const [focus, setFocus] = useState<'list' | 'inspector'>('list');
  const [zoom, setZoom] = useState(false);
  // A fork opened at its divergence shows what changed there; a failed run shows its verdict, unless
  // a call was asked for (`--call`, as each `shadowlap search` match opens one).
  const [tab, setTab] = useState<Tab>(() => initialTab ?? (atFork ? 'diff' : !askedCall && isFailing(verdict.outcome, verdict.fix) ? 'verdict' : 'conversation'));
  const [scroll, setScroll] = useState<number | null>(null);
  const view = useRef<InspectorView>({ offset: 0, max: 0, page: 1 });
  const onView = useCallback((v: InspectorView) => {
    view.current = v;
  }, []);
  const [mode, setMode] = useState<Mode>({ kind: 'timeline' });
  const [play, setPlay] = useState<PlayState>({ playing: false, speed: 1, upto: 0 });
  const [toast, setToast] = useState<{ text: string; ms: number; tone: Tone } | null>(null);
  const say = (text: string, ms = 2500, tone: Tone = 'info') => setToast({ text, ms, tone });
  const onPlayTick = useCallback((next: PlayState) => setPlay(next), []);

  const summary = useMemo(() => summarizeRun(run, calls, [], [], summaryOptions), [run, calls, summaryOptions]);
  // Marked running: still recording, or left so by a recording process that was killed.
  const recording = useMemo(() => recordingNow(store, run), [store, run]);
  // The verdict line, under the header, when the run has a verdict to give.
  // The line under the header: what the run was about, as the dashboard names it under its id, then its verdict.
  const bodyHeight = Math.max(3, height - 3);
  // The calls get the wider share from 100 columns: their rows carry more than the inspector's lines need.
  const listWidth = zoom ? 0 : Math.max(36, Math.floor(width * (width >= 100 ? 0.55 : 0.5)));
  const listRows = Math.max(1, bodyHeight - 2);
  const current = visibleCalls[Math.min(selected, Math.max(0, visibleCalls.length - 1))];
  const currentIndex = current ? calls.indexOf(current) : -1;

  const shownNo = current?.callNo;
  // A filter kept (or an origin picked) that hides the selected call makes the call standing in for
  // it the selection: clearing the filter then leaves you on the call it found.
  useEffect(() => {
    if (mode.kind === 'search' || shownNo === undefined || selectedNo === null) return;
    if (!visibleCalls.some((c) => c.callNo === selectedNo)) setSelectedNo(shownNo);
  }, [visibleCalls, mode.kind, shownNo, selectedNo]);
  useEffect(() => setScroll(null), [shownNo, tab]);
  // Reset playback when the call changes, never on a tab change: `space` switches to the response
  // tab and starts playing in one keystroke, and child effects (the player) run before this one.
  useEffect(() => {
    setPlay((p) => ({ playing: false, speed: p.speed, upto: 0 }));
  }, [shownNo]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.ms);
    return () => clearTimeout(t);
  }, [toast]);

  const runAction = (args: string[], refresh = false) => {
    if (!spawnCli) return;
    const child = spawnCli(args);
    setMode({ kind: 'output', title: `shadowlap ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`, child, refresh });
  };
  // The Fixes flow from this run (B, R, V in the fork menu): blame the run, repair the fix it fails
  // in, or verify a change for that fix.
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
  /** What the job runs after `shadowlap`, as the consent shows it: without the --yes it carries for the CLI. */
  const shownArgs = (args: readonly string[]) => {
    const end = args.indexOf('--');
    return args.filter((a, i) => a !== '--yes' || (end >= 0 && i > end));
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
  const jump = (dir: 1 | -1) => {
    for (let i = selected + dir; i >= 0 && i < visibleCalls.length; i += dir) {
      if (notable(visibleCalls[i]!)) {
        select(i);
        return;
      }
    }
    say(dir === 1 ? 'no later live, fenced or failed call' : 'no earlier live, fenced or failed call');
  };
  /** Selects the call the run forked at (an ended-early run's last call); false for a run that didn't fork. */
  const toFork = () => {
    if (!divergence) return false;
    const i = visibleCalls.findIndex((c) => c.callNo >= divergence.callNo);
    select(i >= 0 ? i : visibleCalls.length - 1);
    return true;
  };
  // Inspector scrolling, from where it is: it may have opened on a conversation's newest turns.
  const scrollBy = (n: number) => setScroll((s) => Math.max(0, Math.min(view.current.max, (s ?? view.current.offset) + n)));

  useInput(
    (input, key) => {
      if (key.escape) {
        if (query || filter !== 'all') {
          setQuery('');
          setFilter('all');
        } else if (zoom) {
          setZoom(false);
          setFocus('list');
        } else if (focus === 'inspector') setFocus('list');
        else onBack();
        return;
      }
      // Ctrl and Alt chords are none of these keys (Ctrl-G is not g).
      if (key.ctrl || key.meta) return;
      if (input === 'q') return onBack();
      if (input === '?') return onHelp();
      if (input === ':') return setMode({ kind: 'actions' });
      if (input === '/') return setMode({ kind: 'search', before: query, beforeNo: selectedNo });
      if (input === 'z') {
        setZoom(!zoom);
        return setFocus(zoom ? 'list' : 'inspector');
      }
      if (key.leftArrow || input === 'h') {
        setZoom(false);
        return setFocus('list');
      }
      if (key.rightArrow || input === 'l') return setFocus('inspector');
      if (key.tab && key.shift) return setTab((t) => tabs[(tabs.indexOf(t) + tabs.length - 1) % tabs.length]!);
      if (key.tab) return setTab((t) => tabs[(tabs.indexOf(t) + 1) % tabs.length]!);
      if (/^[1-9]$/.test(input)) {
        // By the tab's own number, which a run without one leaves unused: 5 is a fork's diff, 6 the verdict.
        const t = TAB_KEYS[Number(input) - 1];
        if (t && tabs.includes(t)) setTab(t);
        return;
      }
      if (input === 'J') return scrollBy(1);
      if (input === 'K') return scrollBy(-1);
      if (input === 'd') {
        if (!toFork()) return say('this run did not diverge: it has no diff');
        return setTab('diff');
      }
      if (input === 'f') return setFilter((f) => FILTERS[(FILTERS.indexOf(f) + 1) % FILTERS.length]!);
      if (input === 'v') return setTab('verdict');
      if (input === 'N') {
        if (!onNote) return say('notes can be added from the dashboard or with shadowlap note');
        return setMode({ kind: 'note', callNo: current?.callNo ?? null });
      }
      if (input === 'b') {
        if (lost === null) return say(run.meta?.blame ? 'blame placed the failure on no call' : `not blamed: shadowlap blame ${run.runId.slice(0, 10)} finds where it was lost`);
        const i = visibleCalls.findIndex((c) => c.callNo >= lost);
        return select(i >= 0 ? i : visibleCalls.length - 1);
      }
      const m = markKey(input);
      if (m) {
        if (onMark) say(onMark(run.runId, m), 4000, 'ok');
        return;
      }
      if (input === 'n') {
        if (!toFork()) say('this run did not diverge');
        return;
      }
      if (input === ']') return jump(1);
      if (input === '[') return jump(-1);
      if (input === 'o') return toDashboard();
      if (input === 'y') return yank();
      if (input === 'w') return writeOut();
      if (input === 'p') {
        if (run.parentRunId) onOpenRun(run.parentRunId);
        else say('this run has no parent');
        return;
      }
      if (input === ' ') {
        setTab('response');
        setPlay((p) => (p.playing ? { ...p, playing: false } : { ...p, playing: true, upto: p.upto > 0 && !p.playing ? 0 : p.upto }));
        return;
      }
      // Playback speed, as a video player has it; + and - mark the run, as on the dashboard.
      if (input === '>' || input === '.') return setPlay((p) => ({ ...p, speed: SPEEDS[(SPEEDS.indexOf(p.speed) + 1) % SPEEDS.length]! }));
      if (input === '<' || input === ',') return setPlay((p) => ({ ...p, speed: SPEEDS[(SPEEDS.indexOf(p.speed) + SPEEDS.length - 1) % SPEEDS.length]! }));

      // Movement goes to the focused pane.
      const down = key.downArrow || input === 'j';
      const up = key.upArrow || input === 'k';
      if (focus === 'inspector' || zoom) {
        if (down) scrollBy(1);
        else if (up) scrollBy(-1);
        else if (key.pageDown) scrollBy(view.current.page);
        else if (key.pageUp) scrollBy(-view.current.page);
        else if (input === 'g') setScroll(0);
        else if (input === 'G') setScroll(view.current.max);
        return;
      }
      if (down) move(1);
      else if (up) move(-1);
      else if (key.pageDown) move(listRows);
      else if (key.pageUp) move(-listRows);
      else if (input === 'g') move('first');
      else if (input === 'G') move('last');
    },
    { isActive: mode.kind === 'timeline' && !paused },
  );

  // The list's rows: the calls, and where the run forked, a line saying what changed there.
  const items = useMemo(() => {
    const out: Item[] = visibleCalls.map((_, at) => ({ kind: 'call', at }));
    if (!divergence || !visibleCalls.length) return out;
    const i = visibleCalls.findIndex((c) => c.callNo >= divergence.callNo);
    if (i >= 0) out.splice(i, 0, { kind: 'fork' });
    else if (divergence.type === 'ended_early') out.push({ kind: 'fork' });
    return out;
  }, [visibleCalls, divergence]);
  // Blame's call, after the fork's line when both fall before one call.
  const rows = useMemo((): Item[] => {
    if (lost === null) return items;
    const i = items.findIndex((it) => it.kind === 'call' && visibleCalls[it.at]!.callNo === lost);
    const line: Item = { kind: 'lost' };
    return i < 0 ? items : [...items.slice(0, i), line, ...items.slice(i)];
  }, [items, lost, visibleCalls]);
  const selItem = Math.max(0, rows.findIndex((it) => it.kind === 'call' && it.at === selected));
  const start = Math.max(0, Math.min(selItem - Math.floor(listRows / 2), rows.length - listRows));
  const shownItems = rows.slice(start, start + listRows);
  const label = runLabel(run, kindFacts(store, run, calls.length));

  // Columns fitted to the list's width; a scope column for runs that use scopes (sub-agents,
  // parallel branches), dropped first when the list is narrow. The origin's cell holds the run's
  // longest whole (`overridden`, where a call is), so a label is never cut into the outcome.
  const innerWidth = Math.max(0, listWidth - 2);
  const longestScope = useMemo(() => calls.reduce((n, c) => Math.max(n, scopeOf(c).length), 0), [calls]);
  const originWidth = useMemo(() => calls.reduce((n, c) => Math.max(n, displayOrigin(c).length + 1), 9), [calls]);
  const lastNo = calls.at(-1)?.callNo ?? 0;
  const w = fitColumns(
    [
      { key: 'mark', min: 2 },
      { key: 'no', min: String(lastNo).length + 3 },
      { key: 'kind', min: 6, drop: 1 },
      { key: 'scope', min: longestScope ? Math.min(12, longestScope) + 2 : 0, drop: 2 },
      { key: 'name', min: 6, max: 26 },
      { key: 'origin', min: originWidth },
      { key: 'outcome', min: 4 },
      { key: 'detail', min: 0, max: Number.POSITIVE_INFINITY },
    ],
    innerWidth,
  );

  const callRow = (c: CallRecord, at: number) => {
    const noted = notedCalls.has(c.callNo);
    const sel = at === selected;
    // Before the fork, the calls served from the recording: context, drawn quieter than what changed.
    const before = !!divergence && c.callNo < divergence.callNo && c.origin === 'replayed';
    const quiet = before ? theme.faint : undefined;
    const origin = displayOrigin(c);
    const action = c.kind === 'api' && w.name ? actionOf(c) : null;
    const name = action ? action.text : shortCallName(c.kind, c.name);
    const nameColor = action?.tone === 'err' ? theme.err : action?.tone === 'warn' ? theme.warn : (quiet ?? (c.kind === 'clock' || c.kind === 'random' ? theme.dim : undefined));
    const outcome = c.end ? (c.end.outcome === 'ok' ? 'ok' : 'ERR') : '…';
    const cells: Cell[] = [
      cell(sel ? '>' : '', w.mark),
      { spans: [{ text: `#${c.callNo}`, ...(quiet ? { color: quiet } : {}) }, { text: noted ? '*' : '', color: theme.warn }], width: w.no, gap: 1 },
      cell(kindLabel[c.kind] ?? c.kind, w.kind, { color: theme.dim }),
      cell(scopeOf(c), w.scope, { color: theme.dim }, 2),
      cell(name, w.name, nameColor ? { color: nameColor } : {}, 2),
      cell(origin, w.origin, { color: theme.origin[origin] }),
      cell(outcome, w.outcome, { color: c.end?.outcome === 'error' ? theme.err : theme.faint }),
      cell(w.detail >= 4 ? detailOf(c) : '', w.detail, { color: quiet ?? theme.dim }, 0),
    ];
    return <Row key={c.callNo} width={innerWidth} cells={cells} selected={sel ? (focus === 'list' ? 'focus' : 'blur') : null} />;
  };
  const rule = (key: string, words: string, color: string) => {
    // Its words come from the recording (a forced reason, the request's paths): made safe to show.
    const text = `── ${safeLine(words)} `;
    return (
      <Box key={key} height={1} width={innerWidth} flexShrink={0}>
        <Text wrap="truncate" color={color} bold>
          {text + '─'.repeat(Math.max(0, innerWidth - cells(text)))}
        </Text>
      </Box>
    );
  };
  const forkRow = () => rule('fork', divergenceSummary(divergence!), theme.accent);
  const lostRow = () => rule('lost', `lost here · blame, ${String(run.meta?.blame?.confidence ?? '')} confidence`, theme.err);

  const saved = wholeInput(summary.tokensNotRespent);
  // The header is one line: what matters most comes first, so a narrow terminal leaves out the least
  // important part, whole stats at a time.
  const headerItems = [
    `${calls.length} calls`,
    summary.byOrigin.replayed ? `${summary.byOrigin.replayed} replayed` : '',
    summary.byOrigin.live - summary.injected ? `${summary.byOrigin.live - summary.injected} ${summary.imported ? 'captured' : 'live'}` : '',
    summary.injected ? `${summary.injected} injected` : '',
    summary.byOrigin.blocked ? `${summary.byOrigin.blocked} blocked` : '',
    summary.byOrigin.stubbed ? `${summary.byOrigin.stubbed} stubbed` : '',
    summary.byOrigin.overridden ? `${summary.byOrigin.overridden} overridden` : '',
    // What replaying didn't spend again, in the words `show`, `ls` and the dashboard use.
    summary.cost.saved ? `${formatUsd(summary.cost.saved)} not re-spent${saved ? ` (${formatTokens(saved)} input tokens)` : ''}` : saved ? `${formatTokens(saved)} input tokens not re-spent` : '',
    summary.cost.spent ? `≈${formatUsd(summary.cost.spent)} spent` : '',
    summary.cost.captured ? `≈${formatUsd(summary.cost.captured)} captured` : '',
    summary.durationMs !== null ? formatDuration(summary.durationMs) : '',
    run.status === 'running' ? (recording ? 'recording…' : 'interrupted') : run.status === 'completed' ? '' : run.status,
    ago(run.startedAt),
    run.codeVersion ? `@${run.codeVersion}` : '',
  ].filter(Boolean);
  // What goes before the stats: the run's id, what it is, and its parent's id.
  const lead = ` ${run.runId.slice(0, 10)} ${label}${run.parentRunId ? ` of ${run.parentRunId.slice(0, 10)}` : ''}`;
  const header = fitItems(headerItems, width - lead.length - ' · '.length);
  const labelColor = divergence ? theme.accent : label === 'clean replay' ? theme.ok : undefined;

  const isModel = current?.kind === 'api';
  const hints: Hint[] =
    focus === 'inspector' || zoom
      ? INSPECTOR_KEYS.map(([k, d]) => (k === 'z' && zoom ? [k, 'unzoom'] : [k, d]) as Hint)
      : TIMELINE_KEYS.filter(([k]) => (k === 'd' ? !!divergence : k === 'b' ? lost !== null : k === 'space' ? isModel : k === 'p' ? !!run.parentRunId : k === '+ -' ? !!onMark : k === 'N' ? !!onNote : true));
  const filtering = query || filter !== 'all' ? `filter: ${[filter !== 'all' ? filter : '', query ? `/${query}` : ''].filter(Boolean).join(' ')} (${visibleCalls.length}/${calls.length})` : '';
  const modal = mode.kind !== 'timeline' && mode.kind !== 'search';

  const footer =
    mode.kind === 'search' ? (
      <TextInput
        label="filter calls:"
        initial={query}
        placeholder="name, arguments, origin or scope"
        enterDoes="keep"
        width={width}
        active
        onChange={(v) => setQuery(v.trim())}
        onSubmit={(v) => {
          setQuery(v.trim());
          setMode({ kind: 'timeline' });
        }}
        onCancel={() => {
          setQuery(mode.before);
          setSelectedNo(mode.beforeNo);
          setMode({ kind: 'timeline' });
        }}
      />
    ) : toast ? (
      <Line width={width} tone={toast.tone}>
        {' '}
        {toast.text}
      </Line>
    ) : mode.kind === 'actions' ? (
      <KeyHints hints={FORK_MENU_KEYS} width={width} lead={FORK_MENU_LEAD} />
    ) : modal ? (
      <Line width={width}> </Line>
    ) : (
      <KeyHints hints={filtering ? [['esc', 'clear'], ...hints] : hints} width={width} {...(filtering ? { lead: filtering } : {})} />
    );

  return (
    <Box flexDirection="column" width={width} height={height}>
      {/* One truncating Text with nested spans: sibling Texts get flex-shrunk on overflow and lose characters. */}
      <Box height={1}>
        <Text wrap="truncate">
          <Text bold> {run.runId.slice(0, 10)} </Text>
          <Text {...(labelColor ? { color: labelColor } : {})} bold>
            {label}
          </Text>
          {run.parentRunId ? <Text color={theme.dim}> of {run.parentRunId.slice(0, 10)}</Text> : null}
          {header ? <Text color={theme.dim}> · {header}</Text> : null}
        </Text>
      </Box>
      <AboutLine about={about} facts={verdict.facts} width={width} />
      {mode.kind === 'actions' ? (
        <ActionsView actions={terminalActions(run, current, { ...actionContext(store, current), recording })} fixes={fixMenu} title={forkMenuTitle(current)} width={width} height={bodyHeight} active cliAvailable={!!spawnCli} onPick={pick} onClose={() => setMode({ kind: 'timeline' })} />
      ) : mode.kind === 'fix' ? (
        <Box flexDirection="column" width={width} height={bodyHeight} borderStyle="round" borderColor={theme.accent} paddingX={1}>
          <Text bold>{mode.fix.label}</Text>
          <Text color={theme.dim}>{mode.fix.hint}</Text>
          <Text color={mode.fix.needsExpect ? theme.warn : theme.dim}>{mode.fix.needsExpect ? `It needs a check: ${mode.fix.from}.` : `It is ${mode.fix.from}; change it below, or empty it to judge by the agent's exit alone.`}</Text>
          <Text color={theme.dim}>
            It runs <Text color={theme.accent}>{quoteArgv(['shadowlap', ...mode.fix.build(mode.fix.expect)])}</Text>, and asks models live, which costs.
          </Text>
          <TextInput
            stacked
            label={mode.fix.needsExpect ? 'What a passing run does (--expect JSON):' : 'What a passing run does (--expect JSON), or nothing for its exit code alone:'}
            initial={mode.fix.expect}
            placeholder='{"tools":{"send_email":0}}'
            active
            onSubmit={(value) => runFix(mode.fix, value)}
            onCancel={() => setMode({ kind: 'timeline' })}
          />
        </Box>
      ) : mode.kind === 'job' ? (
        <FixJobView
          key={mode.shown}
          job={mode.job}
          {...(mode.again ? { again: mode.again } : {})}
          width={width}
          height={bodyHeight}
          onYes={(typed) => runJob(mode.job, typed)}
          onDecline={() => {
            setMode({ kind: 'timeline' });
            say('not run: it runs only once you type yes', 4000, 'warn');
          }}
          onCancel={() => setMode({ kind: 'timeline' })}
        />
      ) : mode.kind === 'note' ? (
        <Box flexDirection="column" width={width} height={bodyHeight} borderStyle="round" borderColor={theme.accent} paddingX={1}>
          <Text bold>Note {mode.callNo !== null ? `on #${mode.callNo}` : 'on the run'}</Text>
          <Text color={theme.dim}>Kept with the run, as shadowlap note keeps one: the dashboard shows it under the call, and a pack carries it.</Text>
          <TextInput
            stacked
            label="Note:"
            placeholder="the refund limit is per order, not per customer"
            active
            onSubmit={(value) => {
              setMode({ kind: 'timeline' });
              if (value.trim() && onNote) say(onNote(run.runId, mode.callNo, value.trim()), 4000, 'ok');
            }}
            onCancel={() => setMode({ kind: 'timeline' })}
          />
        </Box>
      ) : mode.kind === 'prompt' ? (
        <Box flexDirection="column" width={width} height={bodyHeight} borderStyle="round" borderColor={theme.accent} paddingX={1}>
          <Text bold>{mode.action.label}</Text>
          {mode.action.hint ? <Text color={theme.dim}>{mode.action.hint}</Text> : null}
          <TextInput
            stacked
            label={mode.action.prompt!.label}
            {...(mode.action.prompt!.initial !== undefined ? { initial: mode.action.prompt!.initial } : {})}
            {...(mode.action.prompt!.placeholder !== undefined ? { placeholder: mode.action.prompt!.placeholder } : {})}
            active
            onSubmit={(value) => {
              const args = value.trim() ? mode.action.prompt!.build(value.trim()) : [];
              if (args.length && mode.action.imported) setMode({ kind: 'consent', action: mode.action, args });
              else if (args.length) runAction(args);
              else {
                setMode({ kind: 'timeline' });
                if (value.trim()) say(notRun(run), 4000, 'warn');
              }
            }}
            onCancel={() => setMode({ kind: 'timeline' })}
          />
        </Box>
      ) : mode.kind === 'consent' ? (
        <Box flexDirection="column" width={width} height={bodyHeight} borderStyle="round" borderColor={theme.warn} paddingX={1}>
          <Text bold>{mode.action.label}</Text>
          <Text>
            {run.runId.slice(0, 10)} came from {importedCommandSource(run)}. Replaying it runs the command it was recorded with:
          </Text>
          <Text color={theme.warn}>  {quoteArgv(run.command.argv)}</Text>
          <Text>under</Text>
          <Text color={theme.warn}>  {quoteArgv(['shadowlap', ...shownArgs(mode.args)])}</Text>
          <TextInput
            stacked
            label="Type yes to run it:"
            placeholder="yes"
            active
            onSubmit={(value) => {
              const args = mode.args;
              if (/^y(es)?$/i.test(value.trim())) runAction(args, mode.refresh === true);
              else {
                setMode({ kind: 'timeline' });
                say('not run: it runs only once you type yes', 4000, 'warn');
              }
            }}
            onCancel={() => setMode({ kind: 'timeline' })}
          />
        </Box>
      ) : mode.kind === 'output' ? (
        <OutputPane
          title={mode.title}
          child={mode.child}
          width={width}
          height={bodyHeight}
          active
          opensRun={!mode.refresh}
          onExit={() => {}}
          onClose={() => {
            const refresh = mode.refresh === true;
            setMode({ kind: 'timeline' });
            if (refresh) onRefresh?.(run.runId);
          }}
          onOpenRun={onOpenRun}
        />
      ) : (
        <Box flexDirection="row" height={bodyHeight}>
          {zoom ? null : (
            <Box flexDirection="column" width={listWidth} height={bodyHeight} borderStyle="round" borderColor={focus === 'list' ? theme.accent : theme.faint}>
              {visibleCalls.length === 0 ? <Line width={innerWidth}>{calls.length ? ' no calls match · Esc clears' : ' no calls recorded yet'}</Line> : null}
              {shownItems.map((it) => (it.kind === 'fork' ? forkRow() : it.kind === 'lost' ? lostRow() : callRow(visibleCalls[it.at]!, it.at)))}
            </Box>
          )}
          <Inspector
            store={store}
            calls={calls}
            index={currentIndex}
            tab={tab}
            scroll={scroll}
            play={play}
            onPlayTick={onPlayTick}
            onView={onView}
            run={run}
            facts={facts}
            width={width - listWidth}
            height={bodyHeight}
            focused={focus === 'inspector' || zoom}
            {...(summaryOptions ? { summaryOptions } : {})}
          />
        </Box>
      )}
      {footer}
    </Box>
  );
}
