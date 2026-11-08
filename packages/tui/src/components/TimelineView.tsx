import { Box, useInput } from 'ink';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { lostAt, summarizeRun, type CallRecord, type Normalizer, type RunMark, type RunRecord, type Store, type SummaryOptions } from '@shadowlap/engine';
import { kindFacts, runLabel } from '../data.js';
import { isFailing, type Declared } from '../verdict.js';
import { recordingNow } from './ActionsView.js';
import { Inspector, tabsFor, type InspectorView, type PlayState, type Tab } from './Inspector.js';
import { KeyHints, Line, type Hint } from './Row.js';
import { TextInput } from './TextInput.js';
import { useTimelineActions, type OpenDashboard, type SpawnCli } from './timeline-actions.js';
import { timelineKey } from './timeline-keys.js';
import { AboutLine, CallList, ModeBody, TimelineHeader } from './TimelineParts.js';
import { useCallSelection, useCallText, useRunFacts, useToast, type Filter, type Mode } from './timeline-state.js';

export type { OpenDashboard, SpawnCli } from './timeline-actions.js';

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

/** A call worth jumping to: anything that didn't simply replay cleanly. */
function notable(c: CallRecord): boolean {
  return c.origin !== 'replayed' || c.end?.outcome === 'error';
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
 * One run, call by call: its calls on the left and the selected call's inspector on the right, the
 * run's header and how it stands above, and the keys below. The fork menu, the Fixes flow and a
 * job's output take the body's place while they are open.
 */
export function TimelineView({ store, run, calls, width, height, onBack, onHelp, onOpenRun, spawnCli, openDashboard, initialCall, summaryOptions, paused = false, onMark, declared, normalizers, askedCall = false, onRefresh, onNote, initialTab, tests, configDir = null, version = 0, repairer }: Props) {
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const divergence = run.divergence;
  const tabs = useMemo(() => tabsFor(divergence), [divergence]);
  const { detailOf, searchText, actionOf } = useCallText(store, summaryOptions?.modelOf);
  // A run that ended early forked past its last call: it opens at that last call.
  const atFork = !!divergence && initialCall === divergence.callNo;
  const { visibleCalls, selectedNo, setSelectedNo, selected, select, move } = useCallSelection(calls, filter, query, searchText, () => {
    const i = initialCall !== undefined ? calls.findIndex((c) => c.callNo === initialCall) : -1;
    if (i < 0 && atFork && divergence?.type === 'ended_early') return calls.at(-1)?.callNo ?? null;
    return calls[i >= 0 ? i : 0]?.callNo ?? null;
  });
  const { verdict, facts, about, notedCalls } = useRunFacts(store, run, calls, { declared, normalizers, version });
  const lost = lostAt(run);
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
  const { toast, say } = useToast();
  const onPlayTick = useCallback((next: PlayState) => setPlay(next), []);

  const summary = useMemo(() => summarizeRun(run, calls, [], [], summaryOptions), [run, calls, summaryOptions]);
  // Marked running: still recording, or left so by a recording process that was killed.
  const recording = useMemo(() => recordingNow(store, run), [store, run]);
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
  }, [visibleCalls, mode.kind, shownNo, selectedNo, setSelectedNo]);
  useEffect(() => setScroll(null), [shownNo, tab]);
  // Reset playback when the call changes, never on a tab change: `space` switches to the response
  // tab and starts playing in one keystroke, and child effects (the player) run before this one.
  useEffect(() => {
    setPlay((p) => ({ playing: false, speed: p.speed, upto: 0 }));
  }, [shownNo]);

  const acts = useTimelineActions({ store, run, current, tab, verdict, recording, tests, configDir, repairer, version, spawnCli, openDashboard, setMode, say });
  const jump = (dir: 1 | -1) => {
    for (let i = selected + dir; i >= 0 && i < visibleCalls.length; i += dir) {
      if (notable(visibleCalls[i]!)) {
        select(i);
        return;
      }
    }
    say(dir === 1 ? 'no later live, blocked, stubbed or failed call' : 'no earlier live, blocked, stubbed or failed call');
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
    (input, key) =>
      timelineKey(input, key, {
        run, query, filter, zoom, focus, tabs, selectedNo, current, visibleCalls, lost, listRows, view,
        setQuery, setFilter, setZoom, setFocus, setTab, setMode, setScroll, setPlay,
        select, move, scrollBy, toFork, jump, say, onBack, onHelp, onOpenRun, onMark, canNote: !!onNote,
        toDashboard: acts.toDashboard, yank: acts.yank, writeOut: acts.writeOut,
      }),
    { isActive: mode.kind === 'timeline' && !paused },
  );

  const toTimeline = () => setMode({ kind: 'timeline' });

  const isModel = current?.kind === 'api';
  const hints: Hint[] =
    focus === 'inspector' || zoom
      ? INSPECTOR_KEYS.map(([k, d]) => (k === 'z' && zoom ? [k, 'unzoom'] : [k, d]) as Hint)
      : TIMELINE_KEYS.filter(([k]) => (k === 'd' ? !!divergence : k === 'b' ? lost !== null : k === 'space' ? isModel : k === 'p' ? !!run.parentRunId : k === '+ -' ? !!onMark : k === 'N' ? !!onNote : true));
  const filtering = query || filter !== 'all' ? `filter: ${[filter !== 'all' ? filter : '', query ? `/${query}` : ''].filter(Boolean).join(' ')} (${visibleCalls.length}/${calls.length})` : '';
  const footer = () => {
    if (mode.kind === 'search')
      return (
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
            toTimeline();
          }}
          onCancel={() => {
            setQuery(mode.before);
            setSelectedNo(mode.beforeNo);
            toTimeline();
          }}
        />
      );
    if (toast)
      return (
        <Line width={width} tone={toast.tone}>
          {' '}
          {toast.text}
        </Line>
      );
    if (mode.kind === 'actions') return <KeyHints hints={FORK_MENU_KEYS} width={width} lead={FORK_MENU_LEAD} />;
    if (mode.kind !== 'timeline') return <Line width={width}> </Line>;
    return <KeyHints hints={filtering ? [['esc', 'clear'], ...hints] : hints} width={width} {...(filtering ? { lead: filtering } : {})} />;
  };

  return (
    <Box flexDirection="column" width={width} height={height}>
      <TimelineHeader run={run} label={runLabel(run, kindFacts(store, run, calls.length))} calls={calls} summary={summary} recording={recording} width={width} />
      <AboutLine about={about} facts={verdict.facts} width={width} />
      {mode.kind === 'timeline' || mode.kind === 'search' ? (
        <Box flexDirection="row" height={bodyHeight}>
          {zoom ? null : <CallList run={run} calls={calls} visibleCalls={visibleCalls} selected={selected} lost={lost} notedCalls={notedCalls} focused={focus === 'list'} width={listWidth} height={bodyHeight} listRows={listRows} detailOf={detailOf} actionOf={actionOf} />}
          <Inspector store={store} calls={calls} index={currentIndex} tab={tab} scroll={scroll} play={play} onPlayTick={onPlayTick} onView={onView} run={run} facts={facts} width={width - listWidth} height={bodyHeight} focused={focus === 'inspector' || zoom} {...(summaryOptions ? { summaryOptions } : {})} />
        </Box>
      ) : (
        <ModeBody mode={mode} store={store} run={run} current={current} recording={recording} width={width} height={bodyHeight} cliAvailable={!!spawnCli} acts={acts} setMode={setMode} say={say} onNote={onNote} onRefresh={onRefresh} onOpenRun={onOpenRun} />
      )}
      {footer()}
    </Box>
  );
}
