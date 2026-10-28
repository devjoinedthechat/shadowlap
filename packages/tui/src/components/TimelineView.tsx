import { Box, Text, useInput } from 'ink';
import type { ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CallRecord, RunRecord, Store } from '@shadowlap/engine';
import { formatDuration, formatTokens, formatUsd, importedCommandSource, quoteArgv, shortModel, summarizeRun, wholeInput, type ModelResolver, type SummaryOptions, shortCallName } from '@shadowlap/engine';
import { copyToClipboard } from '../clipboard.js';
import { ago, kindFacts, loadRequest, loadResponseBytes, modelAction, runLabel, type ModelAction } from '../data.js';
import { divergenceSummary } from '../diff.js';
import { fitColumns, fitItems } from '../render.js';
import { displayOrigin, kindLabel, useTheme } from '../theme.js';
import { actionContext, ActionsView, forkMenuTitle, notRun, recordingNow, terminalActions, type Action } from './ActionsView.js';
import { Inspector, tabsFor, type InspectorView, type PlayState, type Tab } from './Inspector.js';
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
}

type Mode =
  | { kind: 'timeline' }
  | { kind: 'actions' }
  | { kind: 'prompt'; action: Action }
  /** A replay of someone else's run, asked once more on its own: the exact command line it runs, then a yes. */
  | { kind: 'consent'; action: Action; args: string[] }
  /** Filtering as you type; Esc puts back the filter from before. */
  | { kind: 'search'; before: string }
  | { kind: 'output'; title: string; child: ChildProcess };

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

function rowDetail(store: Store, c: CallRecord, modelOf?: ModelResolver): string {
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

/** A row of the call list: a call, or the line drawn where the run forked from its parent. */
type Item = { kind: 'call'; at: number } | { kind: 'fork' };

export function TimelineView({ store, run, calls, width, height, onBack, onHelp, onOpenRun, spawnCli, openDashboard, initialCall, summaryOptions }: Props) {
  const theme = useTheme();
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const modelOf = summaryOptions?.modelOf;
  const divergence = run.divergence;
  const tabs = useMemo(() => tabsFor(divergence), [divergence]);

  // What a filter searches and what a model call did, worked out once a call: a call's record
  // doesn't change once it has ended, and a run still recording only adds calls.
  const searched = useRef(new Map<string, string>());
  const actions = useRef(new Map<string, ModelAction>());
  const keyOf = (c: CallRecord) => `${c.callNo}:${c.end ? 1 : 0}`;
  const searchText = (c: CallRecord) => {
    const k = keyOf(c);
    let s = searched.current.get(k);
    if (s === undefined) searched.current.set(k, (s = `${c.name} ${rowDetail(store, c, modelOf)} ${displayOrigin(c)} ${scopeOf(c)}`.toLowerCase()));
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
  const [initialIndex] = useState(() => {
    const i = initialCall !== undefined ? calls.findIndex((c) => c.callNo === initialCall) : -1;
    return i >= 0 ? i : 0;
  });
  const [selected, setSelected] = useState(initialIndex);
  const [focus, setFocus] = useState<'list' | 'inspector'>('list');
  const [zoom, setZoom] = useState(false);
  // A fork opened at its divergence shows what changed there first.
  const [tab, setTab] = useState<Tab>(() => (divergence && calls[initialIndex]?.callNo === divergence.callNo ? 'diff' : 'conversation'));
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
  const bodyHeight = Math.max(3, height - 2);
  // The calls get the wider share from 100 columns: their rows carry more than the inspector's lines need.
  const listWidth = zoom ? 0 : Math.max(36, Math.floor(width * (width >= 100 ? 0.55 : 0.5)));
  const listRows = Math.max(1, bodyHeight - 2);
  const current = visibleCalls[Math.min(selected, Math.max(0, visibleCalls.length - 1))];
  const currentIndex = current ? calls.indexOf(current) : -1;

  useEffect(() => {
    if (selected > visibleCalls.length - 1) setSelected(Math.max(0, visibleCalls.length - 1));
  }, [visibleCalls.length, selected]);
  useEffect(() => setScroll(null), [selected, tab]);
  // Reset playback when the call changes, never on a tab change: `space` switches to the response
  // tab and starts playing in one keystroke, and child effects (the player) run before this one.
  useEffect(() => {
    setPlay((p) => ({ playing: false, speed: p.speed, upto: 0 }));
  }, [selected]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.ms);
    return () => clearTimeout(t);
  }, [toast]);

  const runAction = (args: string[]) => {
    if (!spawnCli) return;
    const child = spawnCli(args);
    setMode({ kind: 'output', title: `shadowlap ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`, child });
  };
  // A replay of a run from someone else's pack, or a teammate's pulled from the team store, runs
  // their command: whatever the action asked first (attempts, an instruction), it runs only once a
  // step of its own has shown the exact command line and been answered yes, as the dashboard asks.
  const pick = (action: Action) => {
    if (action.disabled || !spawnCli) return;
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
      say(`could not write: ${err instanceof Error ? err.message : String(err)}`, 6000, 'err');
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
      (err: unknown) => say(`could not start the dashboard: ${err instanceof Error ? err.message : String(err)}`, 8000, 'err'),
    );
  };
  const jump = (dir: 1 | -1) => {
    for (let i = selected + dir; i >= 0 && i < visibleCalls.length; i += dir) {
      if (notable(visibleCalls[i]!)) {
        setSelected(i);
        return;
      }
    }
    say(dir === 1 ? 'no later live, fenced or failed call' : 'no earlier live, fenced or failed call');
  };
  /** Selects the call the run forked at, when the filter shows it; false for a run that didn't fork. */
  const toFork = () => {
    if (!divergence) return false;
    const i = visibleCalls.findIndex((c) => c.callNo === divergence.callNo);
    if (i >= 0) setSelected(i);
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
      if (input === 'q') return onBack();
      if (input === '?') return onHelp();
      if (input === ':') return setMode({ kind: 'actions' });
      if (input === '/') return setMode({ kind: 'search', before: query });
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
        const t = tabs[Number(input) - 1];
        if (t) setTab(t);
        return;
      }
      if (input === 'J') return scrollBy(1);
      if (input === 'K') return scrollBy(-1);
      if (input === 'd') {
        if (!toFork()) return say('this run did not diverge: it has no diff');
        return setTab('diff');
      }
      if (input === 'f') return setFilter((f) => FILTERS[(FILTERS.indexOf(f) + 1) % FILTERS.length]!);
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
      if (input === '+' || input === '=') return setPlay((p) => ({ ...p, speed: SPEEDS[(SPEEDS.indexOf(p.speed) + 1) % SPEEDS.length]! }));
      if (input === '-') return setPlay((p) => ({ ...p, speed: SPEEDS[(SPEEDS.indexOf(p.speed) + SPEEDS.length - 1) % SPEEDS.length]! }));

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
      if (down) setSelected((s) => Math.min(visibleCalls.length - 1, s + 1));
      else if (up) setSelected((s) => Math.max(0, s - 1));
      else if (key.pageDown) setSelected((s) => Math.min(visibleCalls.length - 1, s + listRows));
      else if (key.pageUp) setSelected((s) => Math.max(0, s - listRows));
      else if (input === 'g') setSelected(0);
      else if (input === 'G') setSelected(Math.max(0, visibleCalls.length - 1));
    },
    { isActive: mode.kind === 'timeline' },
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
  const selItem = Math.max(0, items.findIndex((it) => it.kind === 'call' && it.at === selected));
  const start = Math.max(0, Math.min(selItem - Math.floor(listRows / 2), items.length - listRows));
  const shownItems = items.slice(start, start + listRows);
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
      { key: 'kind', min: 6 },
      { key: 'scope', min: longestScope ? Math.min(12, longestScope) + 2 : 0, drop: 1 },
      { key: 'name', min: 7, max: 26 },
      { key: 'origin', min: originWidth },
      { key: 'outcome', min: 4 },
      { key: 'detail', min: 0, max: Number.POSITIVE_INFINITY },
    ],
    innerWidth,
  );

  const callRow = (c: CallRecord, at: number) => {
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
      cell(`#${c.callNo}`, w.no, quiet ? { color: quiet } : {}, 2),
      cell(kindLabel[c.kind] ?? c.kind, w.kind, { color: theme.dim }),
      cell(scopeOf(c), w.scope, { color: theme.dim }, 2),
      cell(name, w.name, nameColor ? { color: nameColor } : {}, 2),
      cell(origin, w.origin, { color: theme.origin[origin] }),
      cell(outcome, w.outcome, { color: c.end?.outcome === 'error' ? theme.err : theme.faint }),
      cell(w.detail >= 4 ? rowDetail(store, c, modelOf) : '', w.detail, { color: quiet ?? theme.dim }, 0),
    ];
    return <Row key={c.callNo} width={innerWidth} cells={cells} selected={sel ? (focus === 'list' ? 'focus' : 'blur') : null} />;
  };
  const forkRow = () => {
    const text = `── ${divergenceSummary(divergence!)} `;
    return (
      <Box key="fork" height={1} width={innerWidth} flexShrink={0}>
        <Text wrap="truncate" color={theme.accent} bold>
          {text + '─'.repeat(Math.max(0, innerWidth - text.length))}
        </Text>
      </Box>
    );
  };

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
      ? [
          ['?', 'help'],
          ['j/k', 'scroll'],
          ['tab', 'next tab'],
          ['z', zoom ? 'unzoom' : 'zoom'],
          ['y', 'copy'],
          ['h', 'calls'],
          ['q', 'back'],
        ]
      : ([
          ['?', 'help'],
          [':', 'fork'],
          divergence ? ['d', 'diff'] : null,
          ['/', 'filter'],
          ['z', 'zoom'],
          ['[ ]', 'notable'],
          isModel ? ['space', 'play'] : null,
          ['o', 'dashboard'],
          ['y', 'copy'],
          ['w', 'write'],
          run.parentRunId ? ['p', 'parent'] : null,
          ['f', 'origins'],
          ['q', 'back'],
        ] as Array<Hint | null>).filter((h): h is Hint => h !== null);
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
        onChange={(v) => {
          setQuery(v.trim());
          setSelected(0);
        }}
        onSubmit={(v) => {
          setQuery(v.trim());
          setMode({ kind: 'timeline' });
        }}
        onCancel={() => {
          setQuery(mode.before);
          setMode({ kind: 'timeline' });
        }}
      />
    ) : toast ? (
      <Line width={width} tone={toast.tone}>
        {' '}
        {toast.text}
      </Line>
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
      {mode.kind === 'actions' ? (
        <ActionsView actions={terminalActions(run, current, { ...actionContext(store, current), recording })} title={forkMenuTitle(current)} width={width} height={bodyHeight} active cliAvailable={!!spawnCli} onPick={pick} onClose={() => setMode({ kind: 'timeline' })} />
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
              if (/^y(es)?$/i.test(value.trim())) runAction(args);
              else {
                setMode({ kind: 'timeline' });
                say('not run: it runs only once you type yes', 4000, 'warn');
              }
            }}
            onCancel={() => setMode({ kind: 'timeline' })}
          />
        </Box>
      ) : mode.kind === 'output' ? (
        <OutputPane title={mode.title} child={mode.child} width={width} height={bodyHeight} active onExit={() => {}} onClose={() => setMode({ kind: 'timeline' })} onOpenRun={onOpenRun} />
      ) : (
        <Box flexDirection="row" height={bodyHeight}>
          {zoom ? null : (
            <Box flexDirection="column" width={listWidth} height={bodyHeight} borderStyle="round" borderColor={focus === 'list' ? theme.accent : theme.faint}>
              {visibleCalls.length === 0 ? <Line width={innerWidth}> no calls match · Esc clears</Line> : null}
              {shownItems.map((it) => (it.kind === 'fork' ? forkRow() : callRow(visibleCalls[it.at]!, it.at)))}
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
            divergence={divergence}
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
