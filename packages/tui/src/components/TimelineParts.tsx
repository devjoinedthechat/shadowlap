import { Box, Text } from 'ink';
import { useMemo, type ReactNode } from 'react';
import { formatDuration, formatTokens, formatUsd, importedCommandSource, lostRange, lostWords, quoteArgv, safeLine, shortCallName, wholeInput, type CallRecord, type RunAbout, type RunRecord, type RunSummary, type Store } from '@shadowlap/engine';
import { fitAbout } from '../about.js';
import type { Action } from '../actions.js';
import { ago, type ModelAction } from '../data.js';
import { divergenceSummary } from '../diff.js';
import type { BlameAction } from '../fix-actions.js';
import { cells, fitColumns, fitItems } from '../render.js';
import { displayOrigin, kindLabel, toneColour, useTheme } from '../theme.js';
import { toneOf, type Fact } from '../verdict.js';
import { actionContext, ActionsView, forkMenuTitle, notRun, terminalActions } from './ActionsView.js';
import { FixJobView } from './FixJobView.js';
import { OutputPane } from './OutputPane.js';
import { cell, Line, Row, type Cell, type Tone } from './Row.js';
import { TextInput } from './TextInput.js';
import { shownArgs, type useTimelineActions } from './timeline-actions.js';
import { scopeOf, type Mode } from './timeline-state.js';

/** The parts a run's timeline is drawn from: its header and about line, the call list, and the panes that ask before a command runs. */

/**
 * The line under a run's header: what it was about, quiet, then how it stands in its verdict's
 * colour. The verdict's first fact is shown whole when it can be: the about line gives way first,
 * down to a few words.
 */
export function AboutLine({ about, facts, width }: { about: Pick<RunAbout, 'text' | 'from'>; facts: readonly Fact[]; width: number }) {
  const theme = useTheme();
  const tone = toneOf(facts);
  const color = toneColour(theme, tone);
  const mark = { err: '✗', warn: '!', ok: '✓', muted: '·', info: '·' }[tone];
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

/** The header's stats, what matters most first, so a narrow terminal leaves out the least important, whole stats at a time. */
function headerStats(run: RunRecord, calls: readonly CallRecord[], summary: RunSummary, recording: boolean): string[] {
  const saved = wholeInput(summary.tokensNotRespent);
  return [
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
}

/** The run's header, one line: its id, what it is and its parent's id, then its stats. */
export function TimelineHeader({ run, label, calls, summary, recording, width }: { run: RunRecord; label: string; calls: readonly CallRecord[]; summary: RunSummary; recording: boolean; width: number }) {
  const theme = useTheme();
  // What goes before the stats: the run's id, what it is, and its parent's id.
  const lead = ` ${run.runId.slice(0, 10)} ${label}${run.parentRunId ? ` of ${run.parentRunId.slice(0, 10)}` : ''}`;
  const header = fitItems(headerStats(run, calls, summary, recording), width - lead.length - ' · '.length);
  const labelColor = label === 'clean replay' ? theme.origin.replayed : undefined;
  return (
    // One truncating Text with nested spans: sibling Texts get flex-shrunk on overflow and lose characters.
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
  );
}

/** A row of the call list: a call, or a line drawn before one: where the run forked from its parent, or where blame found it lost. */
type Item = { kind: 'call'; at: number } | { kind: 'fork' } | { kind: 'lost' };

/** The list's rows: the calls, a line where the run forked saying what changed there, and blame's call, after the fork's line when both fall before one call. */
function rowsOf(visibleCalls: readonly CallRecord[], divergence: RunRecord['divergence'], lost: number | null): Item[] {
  const items: Item[] = visibleCalls.map((_, at) => ({ kind: 'call', at }));
  if (divergence && visibleCalls.length) {
    const i = visibleCalls.findIndex((c) => c.callNo >= divergence.callNo);
    if (i >= 0) items.splice(i, 0, { kind: 'fork' });
    else if (divergence.type === 'ended_early') items.push({ kind: 'fork' });
  }
  if (lost === null) return items;
  const i = items.findIndex((it) => it.kind === 'call' && visibleCalls[it.at]!.callNo === lost);
  return i < 0 ? items : [...items.slice(0, i), { kind: 'lost' }, ...items.slice(i)];
}

/**
 * The words of the red line before the call blame found the run lost at: lost here, or, when it pinned
 * no one call, the two it was lost around or between, in the engine's words (lostWords); then its
 * confidence.
 */
function lostRuleWords(run: RunRecord): string {
  const b = run.meta?.blame;
  const where = b && typeof b.callNo === 'number' && lostRange(b.range) ? lostWords(b.callNo, b.range) : 'lost here';
  return `${where} · blame, ${String(b?.confidence ?? '')} confidence`;
}

export interface CallListProps {
  run: RunRecord;
  calls: readonly CallRecord[];
  visibleCalls: readonly CallRecord[];
  selected: number;
  lost: number | null;
  notedCalls: ReadonlySet<number>;
  focused: boolean;
  width: number;
  height: number;
  /** How many rows the list shows. */
  listRows: number;
  detailOf: (c: CallRecord) => string;
  actionOf: (c: CallRecord) => ModelAction;
}

/**
 * The run's calls, with the selected one in the middle where it can be. Columns fitted to the list's
 * width; a scope column for runs that use scopes (sub-agents, parallel branches), dropped first when
 * the list is narrow. The origin's cell holds the run's longest whole (`overridden`, where a call
 * is), so a label is never cut into the outcome.
 */
export function CallList({ run, calls, visibleCalls, selected, lost, notedCalls, focused, width, height, listRows, detailOf, actionOf }: CallListProps) {
  const theme = useTheme();
  const divergence = run.divergence;
  const rows = useMemo(() => rowsOf(visibleCalls, divergence, lost), [visibleCalls, divergence, lost]);
  const selItem = Math.max(0, rows.findIndex((it) => it.kind === 'call' && it.at === selected));
  const start = Math.max(0, Math.min(selItem - Math.floor(listRows / 2), rows.length - listRows));
  const innerWidth = Math.max(0, width - 2);
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
    const sel = at === selected;
    // Before the fork, the calls served from the recording: context, drawn quieter than what changed.
    const before = !!divergence && c.callNo < divergence.callNo && c.origin === 'replayed';
    const quiet = before ? theme.faint : undefined;
    const origin = displayOrigin(c);
    const action = c.kind === 'api' && w.name ? actionOf(c) : null;
    const name = action ? action.text : shortCallName(c.kind, c.name);
    const nameColor = action?.tone === 'err' ? theme.err : action?.tone === 'warn' ? theme.warn : (quiet ?? (c.kind === 'clock' || c.kind === 'random' ? theme.dim : undefined));
    const outcome = c.end ? (c.end.outcome === 'ok' ? 'ok' : 'ERR') : '…';
    const row: Cell[] = [
      cell(sel ? '>' : '', w.mark),
      { spans: [{ text: `#${c.callNo}`, ...(quiet ? { color: quiet } : {}) }, { text: notedCalls.has(c.callNo) ? '*' : '' }], width: w.no, gap: 1 },
      cell(kindLabel[c.kind] ?? c.kind, w.kind, { color: theme.dim }),
      cell(scopeOf(c), w.scope, { color: theme.dim }, 2),
      cell(name, w.name, nameColor ? { color: nameColor } : {}, 2),
      cell(origin, w.origin, { color: theme.origin[origin] }),
      cell(outcome, w.outcome, { color: c.end?.outcome === 'error' ? theme.err : theme.faint }),
      cell(w.detail >= 4 ? detailOf(c) : '', w.detail, { color: quiet ?? theme.dim }, 0),
    ];
    return <Row key={c.callNo} width={innerWidth} cells={row} selected={sel ? (focused ? 'focus' : 'blur') : null} />;
  };
  // The fork's line in ink, blame's in red. Its words come from the recording (a forced reason, the request's paths): made safe to show.
  const rule = (key: string, words: string, color?: string) => {
    const text = `── ${safeLine(words)} `;
    return (
      <Box key={key} height={1} width={innerWidth} flexShrink={0}>
        <Text wrap="truncate" {...(color ? { color } : {})} bold>
          {text + '─'.repeat(Math.max(0, innerWidth - cells(text)))}
        </Text>
      </Box>
    );
  };
  const draw = (it: Item) =>
    it.kind === 'fork' ? rule('fork', divergenceSummary(divergence!)) : it.kind === 'lost' ? rule('lost', lostRuleWords(run), theme.err) : callRow(visibleCalls[it.at]!, it.at);

  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="round" {...(focused ? {} : { borderColor: theme.faint })}>
      {visibleCalls.length === 0 ? <Line width={innerWidth}>{calls.length ? ' no calls match · Esc clears' : ' no calls recorded yet'}</Line> : null}
      {rows.slice(start, start + listRows).map(draw)}
    </Box>
  );
}

/** A pane that asks before a command runs, framed in ink as the pane in focus is, or in a warning's amber. */
function Ask({ width, height, warn = false, children }: { width: number; height: number; warn?: boolean; children: ReactNode }) {
  const theme = useTheme();
  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="round" {...(warn ? { borderColor: theme.warn } : {})} paddingX={1}>
      {children}
    </Box>
  );
}

/** Blame (B): what a passing run does, as the check it starts from, which can be changed or emptied. */
export function BlamePane({ fix, width, height, onSubmit, onCancel }: { fix: BlameAction; width: number; height: number; onSubmit: (value: string) => void; onCancel: () => void }) {
  const theme = useTheme();
  return (
    <Ask width={width} height={height}>
      <Text bold>{fix.label}</Text>
      <Text color={theme.dim}>{fix.hint}</Text>
      <Text color={fix.needsExpect ? theme.warn : theme.dim}>{fix.needsExpect ? `It needs a check: ${fix.from}.` : `It is ${fix.from}; change it below, or empty it to judge by the agent's exit alone.`}</Text>
      <Text>
        <Text color={theme.dim}>It runs </Text>
        {quoteArgv(['shadowlap', ...fix.build(fix.expect)])}
        <Text color={theme.dim}>, and asks models live, which costs.</Text>
      </Text>
      <TextInput
        stacked
        label={fix.needsExpect ? 'What a passing run does (--expect JSON):' : 'What a passing run does (--expect JSON), or nothing for its exit code alone:'}
        initial={fix.expect}
        placeholder='{"tools":{"send_email":0}}'
        active
        onSubmit={onSubmit}
        onCancel={onCancel}
      />
    </Ask>
  );
}

/** A note (N) on the selected call, or on the run. */
export function NotePane({ callNo, width, height, onSubmit, onCancel }: { callNo: number | null; width: number; height: number; onSubmit: (value: string) => void; onCancel: () => void }) {
  const theme = useTheme();
  return (
    <Ask width={width} height={height}>
      <Text bold>Note {callNo !== null ? `on #${callNo}` : 'on the run'}</Text>
      <Text color={theme.dim}>Kept with the run, as shadowlap note keeps one: the dashboard shows it under the call, and a pack carries it.</Text>
      <TextInput stacked label="Note:" placeholder="the refund limit is per order, not per customer" active onSubmit={onSubmit} onCancel={onCancel} />
    </Ask>
  );
}

/** What a fork menu action asks before it runs (attempts, an instruction); nothing typed runs nothing. */
export function PromptPane({ run, action, width, height, onArgs, onNothing, onCancel }: { run: RunRecord; action: Action; width: number; height: number; onArgs: (args: string[]) => void; onNothing: (said: string | null) => void; onCancel: () => void }) {
  const theme = useTheme();
  const prompt = action.prompt!;
  return (
    <Ask width={width} height={height}>
      <Text bold>{action.label}</Text>
      {action.hint ? <Text color={theme.dim}>{action.hint}</Text> : null}
      <TextInput
        stacked
        label={prompt.label}
        {...(prompt.initial !== undefined ? { initial: prompt.initial } : {})}
        {...(prompt.placeholder !== undefined ? { placeholder: prompt.placeholder } : {})}
        active
        onSubmit={(value) => {
          const args = value.trim() ? prompt.build(value.trim()) : [];
          if (args.length) onArgs(args);
          else onNothing(value.trim() ? notRun(run) : null);
        }}
        onCancel={onCancel}
      />
    </Ask>
  );
}

/** A replay of someone else's run, asked once more on its own: the exact command line it runs, then a yes. */
export function ConsentPane({ run, action, args, width, height, onYes, onNo, onCancel }: { run: RunRecord; action: Action; args: readonly string[]; width: number; height: number; onYes: () => void; onNo: () => void; onCancel: () => void }) {
  const theme = useTheme();
  return (
    <Ask width={width} height={height} warn>
      <Text bold>{action.label}</Text>
      <Text>
        {run.runId.slice(0, 10)} came from {importedCommandSource(run)}. Replaying it runs the command it was recorded with:
      </Text>
      <Text color={theme.warn}>  {quoteArgv(run.command.argv)}</Text>
      <Text>under</Text>
      <Text color={theme.warn}>  {quoteArgv(['shadowlap', ...shownArgs(args)])}</Text>
      <TextInput stacked label="Type yes to run it:" placeholder="yes" active onSubmit={(value) => (/^y(es)?$/i.test(value.trim()) ? onYes() : onNo())} onCancel={onCancel} />
    </Ask>
  );
}

/** What the timeline's panes act with (useTimelineActions). */
type TimelineActs = ReturnType<typeof useTimelineActions>;

export interface ModeBodyProps {
  /** A mode that takes the body's place: the fork menu, the Fixes flow's panes, a note, a prompt, a consent, a job's output. */
  mode: Exclude<Mode, { kind: 'timeline' } | { kind: 'search' }>;
  store: Store;
  run: RunRecord;
  current: CallRecord | undefined;
  recording: boolean;
  width: number;
  height: number;
  cliAvailable: boolean;
  acts: TimelineActs;
  setMode: (mode: Mode) => void;
  say: (text: string, ms?: number, tone?: Tone) => void;
  onNote?: ((runId: string, callNo: number | null, text: string) => string) | undefined;
  onRefresh?: ((runId: string) => void) | undefined;
  onOpenRun: (runId: string) => void;
}

/** The pane a mode puts in the body's place, until it is done or cancelled and the timeline is back. */
export function ModeBody({ mode, store, run, current, recording, width, height, cliAvailable, acts, setMode, say, onNote, onRefresh, onOpenRun }: ModeBodyProps) {
  const toTimeline = () => setMode({ kind: 'timeline' });
  const declined = () => {
    toTimeline();
    say('not run: it runs only once you type yes', 4000, 'warn');
  };
  switch (mode.kind) {
    case 'actions':
      return <ActionsView actions={terminalActions(run, current, { ...actionContext(store, current), recording })} fixes={acts.fixMenu} title={forkMenuTitle(current)} width={width} height={height} active cliAvailable={cliAvailable} onPick={acts.pick} onClose={toTimeline} />;
    case 'fix':
      return <BlamePane fix={mode.fix} width={width} height={height} onSubmit={(value) => acts.runFix(mode.fix, value)} onCancel={toTimeline} />;
    case 'job':
      return <FixJobView key={mode.shown} job={mode.job} {...(mode.again ? { again: mode.again } : {})} width={width} height={height} onYes={(typed) => acts.runJob(mode.job, typed)} onDecline={declined} onCancel={toTimeline} />;
    case 'note':
      return (
        <NotePane
          callNo={mode.callNo}
          width={width}
          height={height}
          onSubmit={(value) => {
            toTimeline();
            if (value.trim() && onNote) say(onNote(run.runId, mode.callNo, value.trim()), 4000, 'info');
          }}
          onCancel={toTimeline}
        />
      );
    case 'prompt':
      return (
        <PromptPane
          run={run}
          action={mode.action}
          width={width}
          height={height}
          onArgs={(args) => (mode.action.imported ? setMode({ kind: 'consent', action: mode.action, args }) : acts.runAction(args))}
          onNothing={(said) => {
            toTimeline();
            if (said) say(said, 4000, 'warn');
          }}
          onCancel={toTimeline}
        />
      );
    case 'consent':
      return <ConsentPane run={run} action={mode.action} args={mode.args} width={width} height={height} onYes={() => acts.runAction(mode.args, mode.refresh === true)} onNo={declined} onCancel={toTimeline} />;
    case 'output':
      return (
        <OutputPane
          title={mode.title}
          child={mode.child}
          width={width}
          height={height}
          active
          opensRun={!mode.refresh}
          onExit={() => {}}
          onClose={() => {
            const refresh = mode.refresh === true;
            toTimeline();
            if (refresh) onRefresh?.(run.runId);
          }}
          onOpenRun={onOpenRun}
        />
      );
  }
}
