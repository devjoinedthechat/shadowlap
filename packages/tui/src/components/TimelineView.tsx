import { Box, Text, useInput } from 'ink';
import type { ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CallRecord, Origin, RunRecord, Store } from '@shadowlap/engine';
import { formatDuration, formatTokens, formatUsd, shortModel, summarizeRun, type ModelResolver, type SummaryOptions, shortCallName } from '@shadowlap/engine';
import { copyToClipboard } from '../clipboard.js';
import { ago, kindFacts, loadRequest, loadResponseBytes, runLabel } from '../data.js';
import { truncate } from '../render.js';
import { displayOrigin, kindLabel, originColor } from '../theme.js';
import { actionContext, ActionsView, forkMenuTitle, notRun, terminalActions, type Action } from './ActionsView.js';
import { DiffView } from './DiffView.js';
import { Inspector, TABS, type PlayState, type Tab } from './Inspector.js';
import { OutputPane } from './OutputPane.js';
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
  | { kind: 'diff' }
  | { kind: 'actions' }
  | { kind: 'prompt'; action: Action }
  | { kind: 'search' }
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
    return [u ? `${formatTokens(u.inputTokens + (u.cacheReadInputTokens ?? 0))}>${formatTokens(u.outputTokens)} tok` : '', model, c.end?.meta.stopReason ?? ''].filter(Boolean).join(' · ');
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

function searchText(store: Store, c: CallRecord, modelOf?: ModelResolver): string {
  return `${c.name} ${rowDetail(store, c, modelOf)} ${displayOrigin(c)} ${scopeOf(c)}`.toLowerCase();
}

export function TimelineView({ store, run, calls, width, height, onBack, onHelp, onOpenRun, spawnCli, openDashboard, initialCall, summaryOptions }: Props) {
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const modelOf = summaryOptions?.modelOf;
  const visibleCalls = useMemo(() => {
    const q = query.trim().toLowerCase();
    return calls.filter((c) => matches(c, filter) && (!q || searchText(store, c, modelOf).includes(q)));
  }, [store, calls, filter, query]);
  const [selected, setSelected] = useState(() => {
    const i = initialCall !== undefined ? calls.findIndex((c) => c.callNo === initialCall) : -1;
    return i >= 0 ? i : 0;
  });
  const [focus, setFocus] = useState<'list' | 'inspector'>('list');
  const [tab, setTab] = useState<Tab>('conversation');
  const [scroll, setScroll] = useState(0);
  const [mode, setMode] = useState<Mode>({ kind: 'timeline' });
  const [diffScroll, setDiffScroll] = useState(0);
  const [play, setPlay] = useState<PlayState>({ playing: false, speed: 1, upto: 0 });
  const [toast, setToast] = useState<{ text: string; ms: number } | null>(null);
  const say = (text: string, ms = 2500) => setToast({ text, ms });
  const onPlayTick = useCallback((next: PlayState) => setPlay(next), []);

  const summary = useMemo(() => summarizeRun(run, calls, [], [], summaryOptions), [run, calls, summaryOptions]);
  const listWidth = Math.max(36, Math.floor(width * 0.5));
  // Panes are `height - 2` tall (header + footer) with a 2-row border; the inspector also spends a row on tabs.
  const listRows = Math.max(1, height - 4);
  const inspectorRows = Math.max(1, height - 5);
  const current = visibleCalls[Math.min(selected, Math.max(0, visibleCalls.length - 1))];
  const currentIndex = current ? calls.indexOf(current) : -1;

  useEffect(() => {
    if (selected > visibleCalls.length - 1) setSelected(Math.max(0, visibleCalls.length - 1));
  }, [visibleCalls.length, selected]);
  useEffect(() => setScroll(0), [selected, tab]);
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
  const pick = (action: Action) => {
    if (action.disabled || !spawnCli) return;
    if (action.prompt) setMode({ kind: 'prompt', action });
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
    void copyToClipboard(text).then((ok) => say(ok ? `copied ${which} of #${current.callNo} (${formatTokens(text.length)} chars)` : 'clipboard unavailable (pbcopy / xclip / wl-copy / clip not found)'));
  };
  const writeOut = () => {
    if (!current) return;
    const file = resolvePath(process.cwd(), `shadowlap-${run.runId.slice(0, 10).toLowerCase()}-call${current.callNo}.json`);
    try {
      writeFileSync(file, JSON.stringify({ call: current, request: loadRequest(store, current), response: payloadOf(current, 'response') }, null, 2));
      say(`wrote ${file}`);
    } catch (err) {
      say(`could not write: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const toDashboard = () => {
    if (!openDashboard) return say('the dashboard is not available here; run shadowlap dashboard');
    const callNo = current?.callNo;
    say('starting the dashboard…', 10_000);
    openDashboard(run.runId, callNo).then(
      ({ url, opened }) => {
        if (opened) return say(`opened ${callNo !== undefined ? `#${callNo}` : 'this run'} in the dashboard`);
        // No browser (SSH, a container): the link stays up long enough to copy, and goes to the clipboard when there is one.
        void copyToClipboard(url).then((copied) => say(`dashboard${copied ? ' (link copied)' : ''}: ${url}`, 30_000));
      },
      (err: unknown) => say(`could not start the dashboard: ${err instanceof Error ? err.message : String(err)}`, 8000),
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

  useInput(
    (input, key) => {
      if (mode.kind === 'diff') {
        if (key.escape || input === 'd' || input === 'q') setMode({ kind: 'timeline' });
        else if (input === 'J' || key.downArrow || input === 'j') setDiffScroll((s) => s + 1);
        else if (input === 'K' || key.upArrow || input === 'k') setDiffScroll((s) => Math.max(0, s - 1));
        return;
      }
      if (key.escape) {
        if (query) setQuery('');
        else if (focus === 'inspector') setFocus('list');
        else onBack();
        return;
      }
      if (input === 'q') return onBack();
      if (input === '?') return onHelp();
      if (input === ':') return setMode({ kind: 'actions' });
      if (input === '/') return setMode({ kind: 'search' });
      if (key.leftArrow || input === 'h') return setFocus('list');
      if (key.rightArrow || input === 'l') return setFocus('inspector');
      if (key.tab && key.shift) return setTab((t) => TABS[(TABS.indexOf(t) + TABS.length - 1) % TABS.length]!);
      if (key.tab) return setTab((t) => TABS[(TABS.indexOf(t) + 1) % TABS.length]!);
      if (/^[1-4]$/.test(input)) return setTab(TABS[Number(input) - 1]!);
      if (input === 'J') return setScroll((s) => s + 1);
      if (input === 'K') return setScroll((s) => Math.max(0, s - 1));
      if (input === 'd') {
        setDiffScroll(0);
        return setMode({ kind: 'diff' });
      }
      if (input === 'f') return setFilter((f) => FILTERS[(FILTERS.indexOf(f) + 1) % FILTERS.length]!);
      if (input === 'n' && run.divergence) {
        const i = visibleCalls.findIndex((c) => c.callNo === run.divergence!.callNo);
        if (i >= 0) setSelected(i);
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
      if (focus === 'inspector') {
        if (down) setScroll((s) => s + 1);
        else if (up) setScroll((s) => Math.max(0, s - 1));
        else if (key.pageDown) setScroll((s) => s + inspectorRows);
        else if (key.pageUp) setScroll((s) => Math.max(0, s - inspectorRows));
        else if (input === 'g') setScroll(0);
        else if (input === 'G') setScroll(Number.MAX_SAFE_INTEGER);
        return;
      }
      if (down) setSelected((s) => Math.min(visibleCalls.length - 1, s + 1));
      else if (up) setSelected((s) => Math.max(0, s - 1));
      else if (key.pageDown) setSelected((s) => Math.min(visibleCalls.length - 1, s + listRows));
      else if (key.pageUp) setSelected((s) => Math.max(0, s - listRows));
      else if (input === 'g') setSelected(0);
      else if (input === 'G') setSelected(Math.max(0, visibleCalls.length - 1));
    },
    { isActive: mode.kind === 'timeline' || mode.kind === 'diff' },
  );

  const start = Math.max(0, Math.min(selected - Math.floor(listRows / 2), visibleCalls.length - listRows));
  const rows = visibleCalls.slice(start, start + listRows);
  const label = runLabel(run, kindFacts(store, run, calls.length));
  const divergenceRow = run.divergence?.callNo;

  // Exact column widths: a row that overflows its box gets flex-shrunk by the layout engine,
  // which silently drops the narrowest columns first.
  const innerWidth = listWidth - 2;
  // Runs that use scopes (parallel branches, sub-agents) get a column naming each call's.
  const longestScope = useMemo(() => calls.reduce((n, c) => Math.max(n, scopeOf(c).length), 0), [calls]);
  const scopeWidth = longestScope && innerWidth >= 1 + 6 + 5 + 9 + 4 + 8 + 8 ? Math.min(12, longestScope + 1) : 0;
  const fixedWithoutName = 1 + 6 + 5 + scopeWidth + 9 + 4;
  const nameWidth = Math.max(8, Math.min(18, innerWidth - fixedWithoutName));
  const detailWidth = Math.max(0, innerWidth - fixedWithoutName - nameWidth);

  const saved = summary.tokensNotRespent.inputTokens + (summary.tokensNotRespent.cacheReadInputTokens ?? 0);
  // The header is one line: what matters most comes first, so a narrow terminal truncates the least important part.
  const header = [
    `${calls.length} calls`,
    summary.byOrigin.replayed ? `${summary.byOrigin.replayed} replayed` : '',
    summary.byOrigin.live - summary.injected ? `${summary.byOrigin.live - summary.injected} ${summary.imported ? 'captured' : 'live'}` : '',
    summary.injected ? `${summary.injected} injected` : '',
    summary.byOrigin.blocked ? `${summary.byOrigin.blocked} blocked` : '',
    summary.byOrigin.stubbed ? `${summary.byOrigin.stubbed} stubbed` : '',
    summary.byOrigin.overridden ? `${summary.byOrigin.overridden} overridden` : '',
    saved ? `${formatTokens(saved)} tok saved${summary.cost.saved ? ` (≈${formatUsd(summary.cost.saved)})` : ''}` : '',
    summary.cost.spent ? `≈${formatUsd(summary.cost.spent)} spent` : '',
    summary.cost.captured ? `≈${formatUsd(summary.cost.captured)} captured` : '',
    summary.durationMs !== null ? formatDuration(summary.durationMs) : '',
    run.status === 'running' ? 'recording…' : run.status === 'completed' ? '' : run.status,
    ago(run.startedAt),
    run.codeVersion ? `@${run.codeVersion}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const footer = toast
    ? ` ${toast.text}`
    : query || filter !== 'all'
      ? ` filter: ${[filter !== 'all' ? filter : '', query ? `/${query}` : ''].filter(Boolean).join(' ')} (${visibleCalls.length}/${calls.length}) · Esc clears`
      : focus === 'inspector'
        ? ' inspector: j/k scroll · PgUp/PgDn page · g/G ends · y copy · ←/h back to list'
        : ' : actions · / search · [ ] jump · o dashboard · y copy · w write · p parent · space play · d diff · f filter · ? help';

  return (
    <Box flexDirection="column" width={width} height={height}>
      {/* One truncating Text with nested spans: sibling Texts get flex-shrunk on overflow and lose characters. */}
      <Box height={1}>
        <Text wrap="truncate">
          <Text bold> {run.runId.slice(0, 10)} </Text>
          <Text color={run.divergence ? 'yellow' : label === 'clean replay' ? 'cyan' : 'white'}>{label}</Text>
          {run.parentRunId ? <Text color="gray"> of {run.parentRunId.slice(0, 10)}</Text> : null}
          <Text color="gray"> · {header}</Text>
        </Text>
      </Box>
      {mode.kind === 'diff' ? (
        <DiffView divergence={run.divergence} width={width} height={height - 2} scroll={diffScroll} />
      ) : mode.kind === 'actions' ? (
        <ActionsView actions={terminalActions(run, current, actionContext(store, current))} title={forkMenuTitle(current)} width={width} height={height - 2} active cliAvailable={!!spawnCli} onPick={pick} onClose={() => setMode({ kind: 'timeline' })} />
      ) : mode.kind === 'prompt' ? (
        <Box flexDirection="column" width={width} height={height - 2} borderStyle="round" borderColor="cyan" paddingX={1}>
          <Text bold>{mode.action.label}</Text>
          {mode.action.hint ? <Text color="gray">{mode.action.hint}</Text> : null}
          <TextInput
            label={mode.action.prompt!.label}
            {...(mode.action.prompt!.initial !== undefined ? { initial: mode.action.prompt!.initial } : {})}
            {...(mode.action.prompt!.placeholder !== undefined ? { placeholder: mode.action.prompt!.placeholder } : {})}
            active
            onSubmit={(value) => {
              const args = value.trim() ? mode.action.prompt!.build(value.trim()) : [];
              if (args.length) runAction(args);
              else {
                setMode({ kind: 'timeline' });
                if (value.trim()) say(notRun(run));
              }
            }}
            onCancel={() => setMode({ kind: 'timeline' })}
          />
        </Box>
      ) : mode.kind === 'search' ? (
        <Box flexDirection="column" width={width} height={height - 2} borderStyle="round" borderColor="cyan" paddingX={1}>
          <Text bold>Filter calls</Text>
          <TextInput
            label="name, arguments or origin contain:"
            initial={query}
            placeholder="send_email"
            active
            onSubmit={(value) => {
              setQuery(value.trim());
              setSelected(0);
              setMode({ kind: 'timeline' });
            }}
            onCancel={() => setMode({ kind: 'timeline' })}
          />
        </Box>
      ) : mode.kind === 'output' ? (
        <OutputPane title={mode.title} child={mode.child} width={width} height={height - 2} active onExit={() => {}} onClose={() => setMode({ kind: 'timeline' })} onOpenRun={onOpenRun} />
      ) : (
        <Box flexDirection="row" height={height - 2}>
          <Box flexDirection="column" width={listWidth} borderStyle="single" borderColor={focus === 'list' ? 'cyan' : 'gray'}>
            {visibleCalls.length === 0 ? <Text color="gray"> no calls match</Text> : null}
            {rows.map((c, i) => {
              const idx = start + i;
              const sel = idx === selected;
              const isDiv = c.callNo === divergenceRow;
              const outcome = c.end ? (c.end.outcome === 'ok' ? 'ok' : 'ERR') : '...';
              return (
                <Box key={c.callNo} height={1} flexShrink={0}>
                  <Text inverse={sel}>{sel ? '>' : ' '}</Text>
                  <Text {...(isDiv ? { color: 'yellow' } : {})} bold={sel || isDiv}>{`${isDiv ? '!' : ' '}#${c.callNo}`.padEnd(6).slice(0, 6)}</Text>
                  <Text color="gray">{(kindLabel[c.kind] ?? c.kind).padEnd(5).slice(0, 5)}</Text>
                  {scopeWidth ? <Text color="magenta">{truncate(scopeOf(c), scopeWidth - 1).padEnd(scopeWidth)}</Text> : null}
                  <Text bold={sel}>{truncate(shortCallName(c.kind, c.name), nameWidth - 1).padEnd(nameWidth)}</Text>
                  <Text color={originColor[displayOrigin(c)]}>{displayOrigin(c).padEnd(9).slice(0, 9)}</Text>
                  <Text color={c.end?.outcome === 'error' ? 'red' : 'gray'}>{outcome.padEnd(4)}</Text>
                  {detailWidth >= 4 ? <Text color="gray">{truncate(rowDetail(store, c, modelOf), detailWidth)}</Text> : null}
                </Box>
              );
            })}
          </Box>
          <Inspector store={store} calls={calls} index={currentIndex} tab={tab} scroll={scroll} play={play} onPlayTick={onPlayTick} width={width - listWidth} height={height - 2} focused={focus === 'inspector'} {...(summaryOptions ? { summaryOptions } : {})} />
        </Box>
      )}
      <Text color={toast ? 'yellow' : 'gray'} wrap="truncate">
        {footer}
      </Text>
    </Box>
  );
}
