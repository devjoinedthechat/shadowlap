import { Box, useApp, useStdout } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { attemptBundles, deletionPlan, lostAt, messageOf, withAttempts, withNote, type CallRecord, type Normalizer, type Price, type RunRecord, type Store } from '@shadowlap/engine';
import { aboutRun } from './about.js';
import { marked, markToast, type RunMark } from './marks.js';
import type { Declared } from './verdict.js';
import { recordingNow } from './actions.js';
import { Help } from './components/Help.js';
import { RunsView } from './components/RunsView.js';
import { TimelineView, type OpenDashboard, type SpawnCli } from './components/TimelineView.js';
import type { Tab } from './components/Inspector.js';
import { loadRunTree, summaryOptions } from './data.js';
import { THEMES, ThemeContext, type ThemeName } from './theme.js';

export interface AppProps {
  store: Store;
  /** Open this run's timeline directly. */
  runId?: string;
  /** With `runId`: select this call instead of the divergence. */
  callNo?: number;
  /** Runs a CLI command (replay, pack, normalize add) for the actions palette; without it, actions are shown but disabled. */
  spawnCli?: SpawnCli;
  /** Opens a run, at a call, in the dashboard (`o`); without it, `o` says the dashboard isn't available. */
  openDashboard?: OpenDashboard;
  /** Fixed size (tests); otherwise the terminal's, tracked across resizes. */
  columns?: number;
  rows?: number;
  /** USD per million tokens by model prefix (shadowlap.config.json `prices`), on top of the built-in table. */
  prices?: Record<string, Price>;
  /** The palette for the terminal's background (`launchTui` asks the terminal); dark, the dashboard's, by default. */
  theme?: ThemeName;
  /** `tools.unrecorded` from shadowlap.config.json, which the unrecorded-tools warning reads (`launchTui` reads it). */
  unrecorded?: Declared;
  /** The project's normalizers (`normalize` in shadowlap.config.json): what they mask is no difference between a fork and its parent. */
  normalizers?: readonly Normalizer[];
  /** shadowlap.config.json's `tests` as written and the folder it is in: the check a golden's runs are blamed under. */
  tests?: unknown;
  configDir?: string | null;
  /** The repairer shadowlap.config.json names now (`repair.repairer`), read each time a repair is shown or said yes to; none: the user's own Claude Code. */
  repairer?: () => string | null;
}

type View = { kind: 'runs' } | { kind: 'timeline'; run: RunRecord; calls: CallRecord[]; initialCall?: number; askedCall: boolean; initialTab?: Tab };

export function App({ theme = 'dark', ...rest }: AppProps) {
  return (
    <ThemeContext.Provider value={THEMES[theme]}>
      <Screens {...rest} />
    </ThemeContext.Provider>
  );
}

function Screens({ store, runId, callNo, spawnCli, openDashboard, columns, rows, prices, unrecorded, normalizers, tests, configDir = null, repairer }: Omit<AppProps, 'theme'>) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [size, setSize] = useState({ columns: columns ?? stdout.columns ?? 100, rows: rows ?? stdout.rows ?? 30 });
  useEffect(() => {
    if (columns !== undefined && rows !== undefined) return;
    const onResize = () => setSize({ columns: columns ?? stdout.columns ?? 100, rows: rows ?? stdout.rows ?? 30 });
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout, columns, rows]);
  const width = size.columns;
  const height = size.rows;

  const [tick, setTick] = useState(0);
  const [attemptsShown, setAttemptsShown] = useState(false);
  // Moves each time a run is read again (a job ended, a mark, a note): what a view works out once a run, it works out again.
  const [version, setVersion] = useState(0);
  const options = useMemo(() => summaryOptions(store, prices), [store, prices]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `tick` moves when the store has new runs, which loadRunTree reads from it
  const nodes = useMemo(() => loadRunTree(store, { modelOf: options.modelOf!, attempts: attemptsShown, ...(options.prices ? { prices: options.prices } : {}) }), [store, options, tick, attemptsShown]);
  const [help, setHelp] = useState(false);

  const open = (id: string, at?: number, tab?: Tab): View => {
    const run = store.getRun(id);
    if (!run) return { kind: 'runs' };
    const calls = store.getCalls(id);
    // A fork opens where it forked, a blamed run where blame found it lost.
    const initialCall = at ?? run.divergence?.callNo ?? lostAt(run) ?? undefined;
    return { kind: 'timeline', run, calls, askedCall: at !== undefined, ...(initialCall !== undefined ? { initialCall } : {}), ...(tab ? { initialTab: tab } : {}) };
  };
  const [view, setView] = useState<View>(() => (runId ? open(runId, callNo) : { kind: 'runs' }));

  // Reads a run open in the timeline again, as it stands: where it was, on the call it was on.
  const refresh = (id: string) => {
    const fresh = open(id);
    setTick((n) => n + 1);
    setVersion((n) => n + 1);
    setView((v) => (v.kind === 'timeline' && v.run.runId === id && fresh.kind === 'timeline' ? { ...fresh, askedCall: v.askedCall, ...(v.initialCall !== undefined ? { initialCall: v.initialCall } : {}) } : v));
  };

  // A note on a call, written as `shadowlap note` writes one.
  const note = (id: string, callNo: number | null, text: string): string => {
    const run = store.getRun(id);
    if (!run) return `${id.slice(0, 10)} is gone`;
    try {
      store.updateRunMeta(id, { notes: withNote(run.meta?.notes, { callNo, text, at: Date.now() }) });
      refresh(id);
      return `noted on ${id.slice(0, 10)}${callNo !== null ? ` #${callNo}` : ''}`;
    } catch (err) {
      return `not noted: ${messageOf(err)}`;
    }
  };

  // Good and bad, as the dashboard's key labels a run, written as `shadowlap label` writes labels.
  const mark = (id: string, m: RunMark): string => {
    const run = store.getRun(id);
    if (!run) return `${id.slice(0, 10)} is gone`;
    try {
      const next = marked(run.meta?.labels ?? [], m);
      store.updateRunMeta(id, { labels: next.labels });
      setTick((n) => n + 1);
      setVersion((n) => n + 1);
      setView((v) => (v.kind === 'timeline' && v.run.runId === id ? { ...v, run: store.getRun(id) ?? v.run } : v));
      return markToast(id, m, next.on);
    } catch (err) {
      return `not labelled: ${messageOf(err)}`;
    }
  };

  // Runs may still be recording: refresh the list while it is shown, and tail an open run a process
  // is still recording (one whose recording process was killed gets no more calls).
  useEffect(() => {
    if (view.kind === 'runs') {
      const t = setInterval(() => setTick((n) => n + 1), 2000);
      return () => clearInterval(t);
    }
    if (view.run.status === 'running' && recordingNow(store, view.run)) {
      const id = view.run.runId;
      const t = setInterval(() => {
        const fresh = open(id);
        if (fresh.kind === 'timeline') setView((v) => (v.kind === 'timeline' && v.run.runId === id ? { ...fresh, ...(v.initialCall !== undefined ? { initialCall: v.initialCall } : {}) } : v));
      }, 1000);
      return () => clearInterval(t);
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the timers follow the view's kind, run and status: the view and open are new on every refresh, and taking them in would restart the timers each time
  }, [view.kind, view.kind === 'timeline' ? view.run.runId : '', view.kind === 'timeline' ? view.run.status : '']);

  let screen;
  if (view.kind === 'timeline') {
    const { run, calls, initialCall } = view;
    screen = (
      <TimelineView
        key={run.runId}
        store={store}
        run={run}
        calls={calls}
        width={width}
        height={height}
        onBack={() => (runId ? exit() : setView({ kind: 'runs' }))}
        onHelp={() => setHelp(true)}
        onOpenRun={(id) => {
          setTick((n) => n + 1);
          setView(open(id));
        }}
        {...(spawnCli ? { spawnCli } : {})}
        {...(openDashboard ? { openDashboard } : {})}
        {...(initialCall !== undefined ? { initialCall } : {})}
        summaryOptions={options}
        paused={help}
        onMark={mark}
        askedCall={view.askedCall}
        {...(view.initialTab ? { initialTab: view.initialTab } : {})}
        onRefresh={refresh}
        onNote={note}
        version={version}
        configDir={configDir}
        {...(tests !== undefined ? { tests } : {})}
        {...(unrecorded ? { declared: unrecorded } : {})}
        {...(normalizers ? { normalizers } : {})}
        {...(repairer ? { repairer } : {})}
      />
    );
  } else {
    screen = (
      <RunsView
        nodes={nodes}
        width={width}
        height={height}
        onOpen={(id, at, tab) => setView(open(id, at, tab))}
        aboutOf={(n) => aboutRun(store, n.run, n.calls)}
        {...(spawnCli ? { spawnCli } : {})}
        attemptsOf={(id) => withAttempts(attemptBundles(store.allRuns()), id).length}
        onDelete={(id) => {
          // As `rm` and the dashboard delete it: with the attempts bundled under it, and left alone
          // while it records, a run in progress replays from it, or an attempt of it still runs.
          const plan = deletionPlan(store, [id]);
          const held = plan.held[0];
          if (held) return `${id.slice(0, 10)} was not deleted: ${held.why}; delete it once that has ended`;
          store.transaction(() => {
            for (const r of [...plan.runs, ...plan.attempts]) store.deleteRun(r);
          });
          store.gcBlobs();
          setTick((n) => n + 1);
          return null;
        }}
        onQuit={() => exit()}
        onHelp={() => setHelp(true)}
        {...(openDashboard ? { openDashboard } : {})}
        paused={help}
        onMark={mark}
        attemptsShown={attemptsShown}
        onToggleAttempts={() => setAttemptsShown((a) => !a)}
      />
    );
  }
  // Help is drawn over the view, which stays as it was (its filter, zoom, tab and scroll) and takes no keys meanwhile.
  return (
    <Box flexDirection="column">
      {help ? <Help width={width} height={height} context={view.kind === 'timeline' ? 'timeline' : 'runs'} onClose={() => setHelp(false)} /> : null}
      <Box display={help ? 'none' : 'flex'}>{screen}</Box>
    </Box>
  );
}
