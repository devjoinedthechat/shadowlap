import type { ChildProcess } from 'node:child_process';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { attemptBundles, formatTokens, shortModel, wholeInput, withAttempts, type CallRecord, type ModelResolver, type Normalizer, type RunRecord, type Store, type StoreOf } from '@shadowlap/engine';
import { aboutRun } from '../about.js';
import { attemptTallies } from '../attempts.js';
import { modelAction, type ModelAction } from '../data.js';
import type { BlameAction, FixJob } from '../fix-actions.js';
import { forkEffects } from '../fork-effects.js';
import type { RunFacts } from '../run-lines.js';
import { displayOrigin, kindLabel } from '../theme.js';
import { blameReport, verdictOf, type Declared } from '../verdict.js';
import type { Action } from './ActionsView.js';
import type { Tone } from './Row.js';

/** What a run's timeline holds while it is open: which calls it shows, how the run stands, and what is said. */

export type Filter = 'all' | 'live' | 'replayed' | 'fenced';
export const FILTERS: Filter[] = ['all', 'live', 'replayed', 'fenced'];

export type Mode =
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

export function scopeOf(c: CallRecord): string {
  return typeof c.meta.scope === 'string' ? c.meta.scope : '';
}

/** The runs an attempt of `run` can be among: its descendants and its siblings (a test's are filed under a sibling). */
function runsAround(store: StoreOf<'recording'>, run: RunRecord): RunRecord[] {
  const out = [run, ...(run.parentRunId ? store.childRuns(run.parentRunId) : [])];
  for (let i = 0; i < out.length && out.length < 5000; i++) if (i === 0 || out[i]!.parentRunId !== run.parentRunId) out.push(...store.childRuns(out[i]!.runId));
  return [...new Map(out.map((r) => [r.runId, r])).values()];
}

/** A call's key in what is worked out of it: its number, and whether it had ended then. */
const callKey = (c: CallRecord) => `${c.callNo}:${c.end ? 1 : 0}`;

/**
 * What a filter searches, a call's detail and what a model call did, worked out once a call: a call's
 * record doesn't change once it has ended, and a run still recording only adds calls.
 */
export function useCallText(store: Store, modelOf?: ModelResolver) {
  const details = useRef(new Map<string, string>());
  const searched = useRef(new Map<string, string>());
  const actions = useRef(new Map<string, ModelAction>());
  const detailOf = useCallback(
    (c: CallRecord) => {
      const k = callKey(c);
      let d = details.current.get(k);
      if (d === undefined) details.current.set(k, (d = rowDetail(store, c, modelOf)));
      return d;
    },
    [store, modelOf],
  );
  const searchText = useCallback(
    (c: CallRecord) => {
      const k = callKey(c);
      let s = searched.current.get(k);
      if (s === undefined) searched.current.set(k, (s = `${c.name} ${kindLabel[c.kind] ?? c.kind} ${detailOf(c)} ${c.end?.meta.stopReason ?? ''} ${displayOrigin(c)} ${scopeOf(c)}`.toLowerCase()));
      return s;
    },
    [detailOf],
  );
  const actionOf = useCallback(
    (c: CallRecord) => {
      const k = callKey(c);
      let a = actions.current.get(k);
      if (a === undefined) actions.current.set(k, (a = modelAction(store, c)));
      return a;
    },
    [store],
  );
  return { detailOf, searchText, actionOf };
}

/**
 * How the run stands (its checks, blame, fix, unrecorded tools), the attempts bundled under it,
 * blame's report and what a fork did differently, then what the run was about, as the dashboard
 * names it, and the calls someone left a note on: each worked out once a run, not on each key.
 */
export function useRunFacts(store: Store, run: RunRecord, calls: CallRecord[], o: { declared?: Declared | undefined; normalizers?: readonly Normalizer[] | undefined; version: number }) {
  const { declared, normalizers, version } = o;
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
  const about = useMemo(() => aboutRun(store, run, calls.length), [store, run, calls.length]);
  const notedCalls = useMemo(() => new Set((run.meta?.notes ?? []).flatMap((n) => (n.callNo === null ? [] : [n.callNo]))), [run.meta?.notes]);
  return { verdict, facts, about, notedCalls };
}

/**
 * The calls a filter (an origin, and a search's words) leaves shown, and the selected call, by its
 * number: a filter that hides it, and clears again, leaves it selected. `initial` is the call it
 * opens on, by number.
 */
export function useCallSelection(calls: CallRecord[], filter: Filter, query: string, searchText: (c: CallRecord) => string, initial: () => number | null) {
  const visibleCalls = useMemo(() => {
    const q = query.trim().toLowerCase();
    return calls.filter((c) => matches(c, filter) && (!q || searchText(c).includes(q)));
  }, [calls, filter, query, searchText]);
  const [selectedNo, setSelectedNo] = useState<number | null>(initial);
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
  return { visibleCalls, selectedNo, setSelectedNo, selected, select, move };
}

/** A line the footer shows for a while (`ms`) in its tone, in place of the keys. */
export function useToast() {
  const [toast, setToast] = useState<{ text: string; ms: number; tone: Tone } | null>(null);
  const say = (text: string, ms = 2500, tone: Tone = 'info') => setToast({ text, ms, tone });
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.ms);
    return () => clearTimeout(t);
  }, [toast]);
  return { toast, say };
}
