import { approx, money, num, plural, shortId } from './format.js';
import { countOrigins, parseOrigins, type Origin7, type OriginCounts } from './origins.js';

/**
 * What a run is and what came of it, in the words every list uses: the sidebar, Runs, the Overview,
 * the palette and the Forks view. No DOM here: the tests import it.
 */

/** The fields of a run in `/api/runs` these read. Later fields are optional: shown when the API sends them. */
export interface RunLike {
  runId: string;
  parentRunId: string | null;
  mode: 'record' | 'replay';
  status: 'running' | 'completed' | 'failed' | 'crashed';
  divergence: { callNo: number; type: string } | null;
  command: string;
  codeVersion: string | null;
  startedAt: number;
  calls: number;
  spent: number;
  saved: number;
  captured: number;
  imported: boolean;
  covers: string[] | null;
  source: string | null;
  labels: string[];
  /** One character per call (see `ORIGIN_CODE`), or origin names. */
  origins?: unknown;
  /** A replay made by `shadowlap test`. */
  test?: { golden: string; session?: string } | null;
  /** What made the run an attempt (`--repeat`, a blame probe, a verify attempt): bundled, not listed. */
  attempt?: unknown;
  repeat?: unknown;
  probe?: unknown;
  verify?: unknown;
  /** The last blame: the call the run was lost at. */
  blame?: { callNo: number | null } | null;
  /** Outcome checks, as they came out for this run. */
  checks?: { passed: number; total: number } | null;
  author?: string | null;
  /** What kind of run it is and how it came out, when the server classifies runs itself. */
  kind?: string | null;
  outcome?: { kind: string; callNo?: number; checks?: number; check?: string | null } | null;
  failed?: boolean | null;
}

export type RunType = 'recording' | 'capture' | 'fork' | 'clean' | 'replay' | 'test';

export const isLive = (r: Pick<RunLike, 'status'>): boolean => r.status === 'running';

export function isAttempt(r: RunLike): boolean {
  return !!(r.attempt || r.repeat || r.probe || r.verify);
}

/**
 * Whether the run list tells attempts apart, so Runs can say they are bundled under the run they came
 * from: the server bundles them (a row counts its `attempts`, or names the run it is an attempt of),
 * or marks them, and the lists leave them out.
 */
export function bundlesAttempts(runs: readonly (RunLike & { attempts?: unknown; attemptOf?: unknown })[]): boolean {
  return runs.some((r) => typeof r.attempts === 'number' || typeof r.attemptOf === 'string' || isAttempt(r));
}

/** The server's kinds, in the words of the chips: a recording from a pack is a recording. */
const SERVER_KINDS: Readonly<Record<string, RunType>> = { recording: 'recording', pack: 'recording', capture: 'capture', fork: 'fork', clean: 'clean', replay: 'replay', test: 'test' };

export function runType(r: RunLike): RunType {
  const known = r.kind ? SERVER_KINDS[r.kind] : undefined;
  if (known) return known;
  if (r.test) return 'test';
  if (r.mode !== 'replay') return r.covers?.length || r.source ? 'capture' : 'recording';
  if (r.divergence) return 'fork';
  return r.status === 'completed' && r.calls > 0 ? 'clean' : 'replay';
}

/**
 * A run that did not do what it should: the agent failed, a check failed, a test diverged, or blame
 * found where it was lost. The server says so for every run it lists and for the run's own page
 * (`failed`); without it, the same rule: a run that was only interrupted did not fail.
 */
export function isFailed(r: RunLike): boolean {
  if (typeof r.failed === 'boolean') return r.failed;
  if (r.status === 'failed') return true;
  if (r.checks && r.checks.passed < r.checks.total) return true;
  if (r.blame && r.blame.callNo) return true;
  return !!r.test && !!r.divergence;
}

/**
 * A run that stopped before it ended (Ctrl-C, a kill, a crash, a recorder that went away) and failed
 * nothing else: every list, and its own page, says "interrupted" in a neutral tone, never a failure.
 */
export function isInterrupted(r: RunLike): boolean {
  return r.status === 'crashed' && !isFailed(r);
}

/**
 * What a failed run failed, in the words of the sidebar and Runs: a check (blame's among them, on a
 * run that exited 0), or the agent's exit, which names no check.
 */
export function failedWord(r: RunLike): string {
  const o = r.outcome;
  if (o?.kind === 'lost' || (o?.kind === 'check-failed' && (o.check || r.status !== 'failed'))) return 'check failed';
  return r.checks && r.checks.passed < r.checks.total ? 'check failed' : 'failed';
}

export function runOrigins(r: RunLike): Origin7[] | null {
  return parseOrigins(r.origins);
}

export function runCounts(r: RunLike): OriginCounts | null {
  const o = runOrigins(r);
  return o ? countOrigins(o) : null;
}

export type GlyphKind = 'live' | 'rec' | 'fail' | 'clean' | 'fork' | 'cap' | 'test' | 'blame' | 'fixok' | 'fixbad' | 'project' | 'setting' | 'train';

/** The icon a run shows, with the words that go with it. */
export function runGlyph(r: RunLike): { kind: GlyphKind; label: string } {
  if (isLive(r)) return { kind: 'live', label: 'Recording now' };
  const t = runType(r);
  const failed = isFailed(r);
  const cut = isInterrupted(r) ? ', interrupted' : '';
  if (t === 'clean') return { kind: 'clean', label: 'Clean replay' };
  if (t === 'fork') return { kind: 'fork', label: `Fork at #${r.divergence!.callNo}${cut}` };
  if (t === 'capture') return { kind: 'cap', label: 'Imported capture' };
  if (t === 'test') return failed ? { kind: 'fail', label: 'Test failed' } : { kind: 'test', label: `Test replay${cut}` };
  if (t === 'replay') return failed ? { kind: 'fail', label: 'Replay failed' } : { kind: 'clean', label: `Replay${cut}` };
  return failed ? { kind: 'fail', label: 'Recording, failed' } : { kind: 'rec', label: `Recording${cut}` };
}

/** The tag beside a run's id on its page and in Compare: an interrupted recording, replay or test says so, in grey. */
export function runTag(r: RunLike): { cls: string; text: string } {
  if (isLive(r)) return { cls: 'live', text: 'recording' };
  const t = runType(r);
  if (isInterrupted(r) && (t === 'recording' || t === 'replay' || t === 'test')) return { cls: '', text: 'interrupted' };
  if (t === 'recording') return isFailed(r) ? { cls: 'fail', text: 'failed' } : { cls: '', text: 'recording' };
  if (t === 'clean') return { cls: 'clean', text: 'clean' };
  if (t === 'fork') return { cls: 'fork', text: `fork @${r.divergence!.callNo}` };
  if (t === 'capture') return { cls: 'cap', text: 'capture' };
  if (t === 'test') return isFailed(r) ? { cls: 'fail', text: 'failed' } : { cls: 'test', text: 'test' };
  return isFailed(r) ? { cls: 'fail', text: 'failed' } : { cls: '', text: 'replay' };
}

/** What kind of run it is, in a word or two: recording, replay, fork @17, capture, test. */
export function kindWord(r: RunLike): string {
  const t = runType(r);
  if (t === 'fork') return `fork @${r.divergence!.callNo}`;
  if (t === 'clean') return 'replay';
  return t;
}

/** Where a run came from, for the line under its id: the command, or the capture it was built from. */
export function runSource(r: RunLike): string {
  return r.source ? r.source : r.command;
}

/** The Runs table's line under the id, in its two parts: what the run is ("fork @17 of 01K5CQ4N7G"), and its command or capture. */
export function runSublineParts(r: RunLike): { what: string; source: string } {
  return { what: `${kindWord(r)}${r.parentRunId ? ` of ${shortId(r.parentRunId)}` : ''}`, source: runSource(r) };
}

/** The Runs table's line under the id: "fork @17 of 01K5CQ4N7G · python refund_agent.py". */
export function runSubline(r: RunLike): string {
  const p = runSublineParts(r);
  return `${p.what} · ${p.source}`;
}

/** The sidebar's line: what happened, in a few words. */
export function sideLine(r: RunLike): { text: string; err?: string } {
  const counts = runCounts(r);
  const calls = plural(r.calls, 'call');
  if (isLive(r)) return { text: `${runType(r) === 'recording' || runType(r) === 'capture' ? 'recording' : 'running'} · ${calls} so far` };
  const t = runType(r);
  if (t === 'clean') return { text: counts ? `clean replay · ${num(counts.rep)}/${num(r.calls)}` : `clean replay · ${calls}` };
  // Stopped before it ended, failing nothing else: what it is, then that, as the Forks view says it.
  if (isInterrupted(r)) return { text: `${kindWord(r)} · interrupted · ${calls}` };
  if (t === 'fork') {
    const went = counts ? ` · ${num(counts.live + counts.fail)} live${counts.block ? ` · ${num(counts.block)} blocked` : ''}${counts.stub ? ` · ${num(counts.stub)} stubbed` : ''}` : ` · ${calls}`;
    return { text: `fork @${r.divergence!.callNo}${went}` };
  }
  if (t === 'capture') return { text: `capture · ${calls}` };
  if (t === 'test') return isFailed(r) ? { err: 'test failed', text: r.divergence && r.outcome?.kind !== 'check-failed' ? ` · diverged at #${r.divergence.callNo}` : ` · ${calls}` } : { text: counts && counts.live && r.divergence ? `test · forked at #${r.divergence.callNo} · ${num(counts.live)} live` : 'test · offline · 0 upstream' };
  if (isFailed(r)) return { err: failedWord(r), text: ` · ${calls}` };
  return { text: `${runSource(r)} · ${calls}` };
}

/** The Runs table's status: the outcome only, in a dot and a few words. */
export function runOutcome(r: RunLike): { tone: 'live' | 'err' | 'ok' | 'n'; text: string } {
  if (isLive(r)) return { tone: 'live', text: 'in progress' };
  const o = r.outcome;
  if (o) {
    if (o.kind === 'running') return { tone: 'live', text: 'in progress' };
    if (o.kind === 'diverged' && typeof o.callNo === 'number') return { tone: 'err', text: `diverged at #${o.callNo}` };
    if (o.kind === 'lost' && typeof o.callNo === 'number') return { tone: 'err', text: `lost at #${o.callNo}` };
    // A check, or the agent's exit (an outcome that names no check), in the sidebar's words.
    if (o.kind === 'check-failed') return { tone: 'err', text: failedWord(r) };
    if (o.kind === 'passed' && typeof o.checks === 'number') return { tone: 'ok', text: `${plural(o.checks, 'check')} passed` };
    if (o.kind === 'clean') return { tone: 'ok', text: 'clean' };
    // A run cut short (its recorder stopped before it ended) has no outcome, but says why.
    if (o.kind === 'none') return { tone: 'n', text: r.status === 'crashed' ? 'interrupted' : '—' };
  }
  if (r.test && r.divergence) return { tone: 'err', text: `diverged at #${r.divergence.callNo}` };
  if (r.blame && r.blame.callNo) return { tone: 'err', text: `lost at #${r.blame.callNo}` };
  if (r.checks && r.checks.total) {
    if (r.checks.passed < r.checks.total) return { tone: 'err', text: 'check failed' };
    return { tone: 'ok', text: `${plural(r.checks.total, 'check')} passed` };
  }
  if (r.status === 'crashed') return { tone: 'n', text: 'interrupted' };
  if (r.status === 'failed') return { tone: 'err', text: 'failed' };
  const t = runType(r);
  if (t === 'clean' || t === 'test') return { tone: 'ok', text: 'clean' };
  return { tone: 'n', text: '—' };
}

/**
 * What a run spent live. A capture's traffic reads "as captured"; a run recorded on another machine
 * (a teammate's, pulled from the team store, or a golden unpacked here) shows what it cost there.
 */
export function runSpent(r: RunLike): { text: string; captured: boolean } {
  if (runType(r) === 'capture') return { text: money(r.captured), captured: true };
  return { text: approx(r.spent || (r.imported ? r.captured : 0)), captured: false };
}

export type RunChip = 'all' | 'recording' | 'fork' | 'clean' | 'test' | 'capture' | 'failed';
export const RUN_CHIPS: ReadonlyArray<[RunChip, string]> = [
  ['all', 'All'],
  ['recording', 'Recordings'],
  ['fork', 'Forks'],
  ['clean', 'Clean'],
  ['test', 'Tests'],
  ['capture', 'Captures'],
  ['failed', 'Failed'],
];

export function matchesChip(r: RunLike, chip: RunChip): boolean {
  if (chip === 'all') return true;
  if (chip === 'failed') return isFailed(r);
  return runType(r) === chip;
}

/** The filter field: every word must appear in the id, command, labels or revision. */
export function matchesText(r: RunLike, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${r.runId} ${runSource(r)} ${r.labels.join(' ')} ${r.codeVersion ?? ''} ${kindWord(r)}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

export type RunSort = 'when' | 'calls' | 'spent';

export function sortRuns<R extends RunLike>(list: readonly R[], by: RunSort): R[] {
  const out = [...list];
  if (by === 'calls') out.sort((a, b) => b.calls - a.calls || b.startedAt - a.startedAt);
  else if (by === 'spent') out.sort((a, b) => b.spent - a.spent || b.startedAt - a.startedAt);
  else out.sort((a, b) => b.startedAt - a.startedAt);
  return out;
}

/** Recordings with their replays and forks under them: newest family first, children oldest first. */
export function runTree<R extends RunLike>(runs: readonly R[]): Array<{ run: R; depth: number }> {
  const ids = new Set(runs.map((r) => r.runId));
  const kids = new Map<string, R[]>();
  for (const r of runs) {
    if (!r.parentRunId || !ids.has(r.parentRunId)) continue;
    const list = kids.get(r.parentRunId) ?? [];
    list.push(r);
    kids.set(r.parentRunId, list);
  }
  const out: Array<{ run: R; depth: number }> = [];
  const walk = (r: R, depth: number) => {
    out.push({ run: r, depth });
    if (out.length > 5000) return;
    for (const k of [...(kids.get(r.runId) ?? [])].sort((a, b) => a.startedAt - b.startedAt)) walk(k, depth + 1);
  };
  const roots = runs.filter((r) => !r.parentRunId || !ids.has(r.parentRunId));
  // A family is as new as its newest member, so a fresh fork brings its recording up.
  const newest = new Map<string, number>();
  const familyTime = (r: R): number => {
    const cached = newest.get(r.runId);
    if (cached !== undefined) return cached;
    let t = r.startedAt;
    for (const k of kids.get(r.runId) ?? []) t = Math.max(t, familyTime(k));
    newest.set(r.runId, t);
    return t;
  };
  for (const r of [...roots].sort((a, b) => familyTime(b) - familyTime(a))) walk(r, 0);
  return out;
}

/**
 * The pair Compare opens with none named: the newest fork or replay and its parent, else the two
 * newest runs. An exported copy of many runs holds each run compared with one of them only
 * (`compareWith`, its first run): it opens that run against the newest other, older one first.
 */
export function defaultComparePair(runs: readonly RunLike[], compareWith: string | null = null): [string, string] | null {
  if (runs.length < 2) return null;
  const ids = new Set(runs.map((r) => r.runId));
  const byNew = [...runs].sort((a, b) => b.startedAt - a.startedAt);
  const hub = compareWith ? runs.find((r) => r.runId === compareWith) : undefined;
  if (hub) {
    const other = byNew.find((r) => r.runId !== hub.runId)!;
    return other.startedAt < hub.startedAt ? [other.runId, hub.runId] : [hub.runId, other.runId];
  }
  const child = byNew.find((r) => r.mode === 'replay' && r.parentRunId && ids.has(r.parentRunId));
  if (child) return [child.parentRunId!, child.runId];
  return [byNew[1]!.runId, byNew[0]!.runId];
}

/**
 * What a run's Compare button compares it with: a fork or replay with its parent, a recording with
 * its first fork or replay. Attempts bundled under it (blame's probes, verify's and `--repeat`'s
 * attempts, a model's scoring attempts: `attempt` on the run's children) are not, whenever they ran.
 */
export function compareTarget(run: { runId: string; parentRunId: string | null }, children: ReadonlyArray<{ runId: string; startedAt: number; attempt?: unknown }>): [string, string] | null {
  if (run.parentRunId) return [run.parentRunId, run.runId];
  const first = children.filter((c) => !c.attempt).sort((a, b) => a.startedAt - b.startedAt)[0];
  return first ? [run.runId, first.runId] : null;
}

/** What happened in a run, in one line, for the Forks view: "fork @17 · 16 replayed · 13 live · 1 blocked · ≈$0.04". */
export function familyLine(r: RunLike): string {
  const o = parseOrigins(r.origins);
  const n = o ? countOrigins(o) : null;
  const t = runType(r);
  if (r.status === 'running') return `recording · ${plural(r.calls, 'call')} so far`;
  if (isInterrupted(r)) return `${kindWord(r)} · interrupted · ${plural(r.calls, 'call')}`;
  if (t === 'fork' && r.divergence) {
    const went = n ? `${num(n.rep)} replayed · ${num(n.live + n.fail)} live${n.block ? ` · ${num(n.block)} blocked` : ''}${n.stub ? ` · ${num(n.stub)} stubbed` : ''}` : plural(r.calls, 'call');
    return `fork @${r.divergence.callNo} · ${went} · ${approx(r.spent)}`;
  }
  if (t === 'clean') return n && n.rep === r.calls ? `clean replay · ${num(r.calls)}/${num(r.calls)} · 0 upstream` : `clean replay · ${plural(r.calls, 'call')}`;
  if (t === 'test') return `test · replayed offline · ${plural(r.calls, 'call')}`;
  if (t === 'capture') return `capture · ${plural(r.calls, 'call')} · ${money(r.captured)} as captured`;
  if (t === 'replay') return `replay · ${plural(r.calls, 'call')} · ${r.status === 'completed' ? 'finished' : r.status}`;
  return `${isFailed(r) ? `${failedWord(r)} · ` : 'recording · '}${plural(r.calls, 'call')} · ${approx(r.spent)}`;
}

/** The Forks view's line, with what went wrong set apart: "check failed" in red before the rest, as the sidebar has it. */
export function familyLineParts(r: RunLike): { err: string | null; text: string } {
  const line = familyLine(r);
  const t = runType(r);
  if (t === 'recording' && isFailed(r) && !isInterrupted(r)) {
    const word = failedWord(r);
    if (line.startsWith(`${word} · `)) return { err: word, text: line.slice(word.length) };
  }
  return { err: null, text: line };
}

/** An attempt of one `replay --repeat`, as the run's family lists it. */
export interface RepeatAttempt {
  runId: string;
  status: RunLike['status'];
  divergence: { callNo: number } | null;
  spent: number;
  startedAt: number;
  repeat: { attempt: number; of: number } | null;
  checks: { passed: number; total: number } | null;
}

/**
 * One `replay --repeat` bundled in the Forks view, as the design words it: `replay --repeat 5`, then
 * "forked 5 attempts, 4 passed · ≈$0.141", then each attempt by its id. An attempt passed when its
 * checks did, or, without checks, when it exited cleanly (the first check of every outcome check is
 * the exit code). An attempt that left the path somewhere else than the others says where. One that
 * was stopped before it ended (Ctrl-C, its recorder killed) neither passed nor failed: it is counted
 * apart and marked `cut`, shown in grey as every list shows an interrupted run.
 */
export function repeatBundle(attempts: readonly RepeatAttempt[]): { title: string; line: string; attempts: Array<{ runId: string; text: string; ok: boolean; cut?: true }> } {
  const sorted = [...attempts].sort((a, b) => (a.repeat?.attempt ?? 0) - (b.repeat?.attempt ?? 0) || a.startedAt - b.startedAt);
  const ok = (n: RepeatAttempt) => (n.checks ? n.checks.passed === n.checks.total : n.status === 'completed');
  const cut = (n: RepeatAttempt) => !n.checks && n.status === 'crashed';
  const forkAt = sorted[0]?.divergence?.callNo ?? null;
  const spent = sorted.reduce((s, n) => s + n.spent, 0);
  const passed = sorted.filter(ok).length;
  const stopped = sorted.filter(cut).length;
  return {
    title: `replay --repeat ${sorted[0]?.repeat?.of ?? sorted.length}`,
    line: `${forkAt !== null ? 'forked ' : ''}${plural(sorted.length, 'attempt')}, ${num(passed)} passed${stopped ? `, ${num(stopped)} interrupted` : ''}${spent ? ` · ${approx(spent)}` : ''}`,
    attempts: sorted.map((n) => {
      const where = n.divergence && n.divergence.callNo !== forkAt ? ` · forked at #${n.divergence.callNo}` : '';
      const how = n.checks ? `checks ${n.checks.passed} of ${n.checks.total}` : n.status === 'completed' ? 'passed' : n.status === 'running' ? 'running' : n.status === 'crashed' ? 'interrupted' : 'failed';
      return { runId: n.runId, text: `${shortId(n.runId)} · ${how}${where}`, ok: ok(n), ...(cut(n) ? { cut: true as const } : {}) };
    }),
  };
}

/**
 * The run an exported copy opens on: the one the others lead to. A copy holds a run with the runs it
 * came from, in whatever order the exporter listed them; the run that no other included run names as
 * its parent is the one that was shared. With several such runs (unrelated runs exported together),
 * the first listed.
 */
export function exportStartRun(runIds: readonly string[], runs: ReadonlyArray<{ runId: string; parentRunId: string | null }>): string | null {
  const included = new Set(runIds);
  const parents = new Set(runs.filter((r) => included.has(r.runId) && r.parentRunId && included.has(r.parentRunId)).map((r) => r.parentRunId!));
  return runIds.find((id) => !parents.has(id)) ?? runIds[0] ?? null;
}

/** Whether an exported copy has Compare: it holds two runs or more. A copy of one run has nothing to compare it with. */
export function copyCompares(runIds: readonly string[] | null | undefined): boolean {
  return (runIds?.length ?? 0) >= 2;
}
