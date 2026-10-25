import { Box, useApp, useInput, useStdout } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { attemptBundles, deletionPlan, withAttempts, type CallRecord, type Price, type RunRecord, type Store } from '@shadowlap/engine';
import { recordingNow } from './actions.js';
import { Help } from './components/Help.js';
import { RunsView } from './components/RunsView.js';
import { TimelineView, type OpenDashboard, type SpawnCli } from './components/TimelineView.js';
import { loadRunTree, summaryOptions } from './data.js';

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
}

type View = { kind: 'runs' } | { kind: 'timeline'; run: RunRecord; calls: CallRecord[]; initialCall?: number };

export function App({ store, runId, callNo, spawnCli, openDashboard, columns, rows, prices }: AppProps) {
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
  const options = useMemo(() => summaryOptions(store, prices), [store, prices]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `tick` moves when the store has new runs, which loadRunTree reads from it
  const nodes = useMemo(() => loadRunTree(store, { modelOf: options.modelOf!, ...(options.prices ? { prices: options.prices } : {}) }), [store, options, tick]);
  const [help, setHelp] = useState(false);

  const open = (id: string, at?: number): View => {
    const run = store.getRun(id);
    if (!run) return { kind: 'runs' };
    const calls = store.getCalls(id);
    const initialCall = at ?? run.divergence?.callNo;
    return { kind: 'timeline', run, calls, ...(initialCall !== undefined ? { initialCall } : {}) };
  };
  const [view, setView] = useState<View>(() => (runId ? open(runId, callNo) : { kind: 'runs' }));

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.kind, view.kind === 'timeline' ? view.run.runId : '', view.kind === 'timeline' ? view.run.status : '']);

  useInput(
    () => {
      setHelp(false);
    },
    { isActive: help },
  );

  if (help) return <Help width={width} height={height} />;
  if (view.kind === 'timeline') {
    const { run, calls, initialCall } = view;
    return (
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
      />
    );
  }
  return (
    <Box>
      <RunsView
        nodes={nodes}
        width={width}
        height={height}
        onOpen={(id) => setView(open(id))}
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
      />
    </Box>
  );
}
