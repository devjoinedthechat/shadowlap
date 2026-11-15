import {
  checkStatus,
  FAILURE_WORDS,
  failureReason,
  fixOfRun,
  formatBlame,
  isFailedOutcome,
  kindFacts,
  lostWhere,
  plain,
  runOutcome,
  shortRunId as short,
  statusTally,
  unrecordedTools,
  unrescuedKept,
  type CallRecord,
  type RunOutcome,
  type RunRecord,
  type StoreOf,
  type StoredCheck,
  type StoredFix,
  type UnrecordedTool,
} from '@shadowlap/engine';

/**
 * How a run stands, in the words the dashboard's banner and `shadowlap show` use: why it failed,
 * where blame found it lost, how its fix stands, and the tools it ran unrecorded. Worked out from
 * the engine's own verdicts; nothing here decides anything the engine hasn't. Each in the
 * dashboard's consequence colours: passed `ok`, a look or inconclusive `warn`, failed `err`, and
 * `muted` for what doesn't apply or is neither, an interrupted run's as every list says it.
 */
export type Tone = 'ok' | 'warn' | 'err' | 'muted' | 'info';
export interface Fact {
  text: string;
  tone: Tone;
}

/** `tools.unrecorded` from shadowlap.config.json: a tool's effect, by name. */
export type Declared = Readonly<Record<string, 'read' | 'write'>>;

/** How the run came out, as the engine decides it for the dashboard's Runs table. */
export function outcomeFor(store: StoreOf<'recording'>, run: RunRecord, calls: readonly CallRecord[]): RunOutcome {
  const injected = calls.some((c) => c.end?.meta.injected === true);
  return runOutcome(run, { ...kindFacts(store, run, calls.length), injected });
}

/** A failed check as the dashboard says it: `check failed: send_email called 1 time, but called 2 times`. */
export function failedCheckText(c: StoredCheck): string {
  return `check failed: ${c.label}${c.detail ? `, but ${c.detail}` : ''}`;
}

/**
 * Why the run failed, the engine's first reason (failureReason, which the dashboard's banner says
 * too): a failed check, the agent's exit, the check a fix names, an interruption, blame's
 * confirmation. Else how it came out, when it says something. Null while it records.
 */
export function standing(run: RunRecord, outcome: RunOutcome): Fact | null {
  const reason = failureReason({ status: run.status, checks: run.meta?.checks ?? [], outcome, blame: run.meta?.blame });
  if (reason?.kind === 'check') return { text: failedCheckText(reason.check), tone: 'err' };
  if (reason?.kind === 'fix-check') return { text: `check failed: “${reason.check}”`, tone: 'err' };
  if (reason) return { text: FAILURE_WORDS[reason.kind], tone: reason.kind === 'interrupted' ? 'muted' : 'err' };
  switch (outcome.kind) {
    case 'inconclusive':
      return { text: `check inconclusive${outcome.check ? `: ${outcome.check}` : ''}`, tone: 'warn' };
    case 'diverged':
      return { text: `diverged at #${outcome.callNo}`, tone: 'err' };
    case 'passed':
      return { text: statusTally(run.meta?.checks ?? []) || 'passed', tone: 'ok' };
    case 'clean':
      return { text: 'replayed clean', tone: 'ok' };
    default:
      return null;
  }
}

/** Whether the run failed, as the dashboard counts it: by its outcome, or because a fix lists it among its failing runs. */
export const isFailing = (o: RunOutcome, fix: StoredFix | null) => isFailedOutcome(o) || fix !== null;

/** What `shadowlap blame` found, as `shadowlap show` says it. */
export function blameFact(run: RunRecord): Fact | null {
  const b = run.meta?.blame;
  if (!b) return null;
  if (b.outcome === 'blamed' && Number.isInteger(b.callNo)) {
    const rescued = typeof b.rescuedRunId === 'string' ? `, rescued by ${short(b.rescuedRunId)}` : '';
    return { text: `lost ${lostWhere(b.callNo!, b.range)} (${String(b.confidence)} confidence)${rescued}`, tone: 'err' };
  }
  return { text: b.outcome === 'unrescuable' ? unrescuedKept(b) : 'blame stopped before it finished', tone: 'warn' };
}

export function fixFor(store: StoreOf<'fixes'>, runId: string): StoredFix | null {
  try {
    return fixOfRun(store, runId);
  } catch {
    return null;
  }
}

/** How the run's fix stands, in the dashboard's words; what to run next when there is none. */
export function fixFact(run: RunRecord, fix: StoredFix | null, outcome: RunOutcome): Fact | null {
  if (fix) return fix.status === 'open' ? { text: `no change yet for “${fix.title}”`, tone: 'warn' } : { text: `fixed: “${fix.title}”, ${fix.status}`, tone: 'ok' };
  if (!isFailing(outcome, fix)) return null;
  return run.meta?.blame ? { text: 'no change yet', tone: 'warn' } : { text: 'not blamed yet', tone: 'info' };
}

export function unrecordedOf(store: StoreOf<'recording'>, runId: string, declared: Declared = {}): UnrecordedTool[] {
  try {
    return unrecordedTools(store, runId, { declared });
  } catch {
    return [];
  }
}

/** `Bash (14 calls from #3, writes)`, as `shadowlap show` names an unrecorded tool. */
export function unrecordedName(t: UnrecordedTool): string {
  const effect = t.effect === 'write' ? ', writes' : t.effect === 'unknown' ? ', may write' : '';
  return `${t.name} (${t.count} call${t.count === 1 ? '' : 's'} from #${t.firstCallNo}${effect})`;
}

/** What a replay does with them: runs them for real, and refuses to while one writes. */
export function unrecordedConsequence(tools: readonly UnrecordedTool[]): string {
  const writes = tools.some((t) => t.effect === 'write');
  const unknown = tools.some((t) => t.effect === 'unknown');
  const refuses = writes || unknown ? `, and refuses to while one ${writes && unknown ? 'writes, or may' : writes ? 'writes' : 'may write'}` : '';
  return `a replay runs ${tools.length === 1 ? 'it' : 'them'} for real${refuses}`;
}

export function unrecordedFact(tools: readonly UnrecordedTool[]): Fact | null {
  if (!tools.length) return null;
  return { text: `not recorded: ${tools.map((t) => t.name).join(', ')}`, tone: 'warn' };
}

/** Everything a run's verdict line says, most important first. */
export interface Verdict {
  outcome: RunOutcome;
  facts: Fact[];
  fix: StoredFix | null;
  unrecorded: UnrecordedTool[];
}

export function verdictOf(store: StoreOf<'recording' | 'fixes'>, run: RunRecord, calls: readonly CallRecord[], declared: Declared = {}): Verdict {
  const outcome = outcomeFor(store, run, calls);
  const fix = fixFor(store, run.runId);
  const unrecorded = run.status === 'running' ? [] : unrecordedOf(store, run.runId, declared);
  const facts = [standing(run, outcome), blameFact(run), fixFact(run, fix, outcome), unrecordedFact(unrecorded)].filter((f): f is Fact => f !== null);
  return { outcome, facts, fix, unrecorded };
}

/** The worst tone among facts: the verdict line takes it. */
export function toneOf(facts: readonly Fact[]): Tone {
  for (const t of ['err', 'warn', 'ok', 'muted'] as const) if (facts.some((f) => f.tone === t)) return t;
  return 'info';
}

/** A check as the verdict tab lists it: its mark, its label and, when it says something, its detail. */
export function checkLine(c: StoredCheck): Fact {
  const s = checkStatus(c);
  const mark = s === 'passed' ? '✓' : s === 'failed' ? '✗' : s === 'inconclusive' ? '?' : '–';
  const tone: Tone = s === 'passed' ? 'ok' : s === 'failed' ? 'err' : s === 'inconclusive' ? 'warn' : 'muted';
  const why = c.detail ?? c.reason ?? null;
  return { text: `${mark} ${c.label}${s === 'not-applicable' ? ' · not applicable' : ''}${why ? ` · ${why}` : ''}`, tone };
}

/** Blame's whole report, as `shadowlap blame` printed it, from the last blame of the run. */
export function blameReport(store: StoreOf<'fixes'>, runId: string): string[] {
  try {
    const last = store.blamesOfRun(runId).at(-1);
    return last ? formatBlame(last.report, plain).split('\n') : [];
  } catch {
    return [];
  }
}
