import { passedWords } from '../../engine/src/checks/labels.js';
import { isAttempt as isAttemptRun } from '../../engine/src/run-roles.js';
import { FAILURE_WORDS, lostWords } from '../../engine/src/run-verdicts.js';
import { filterTerms } from '../src/links.js';
import type { RunJudged } from '../src/run-outcome.js';
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
  /** Where a replay left its recording; `diff`, on a run's page, what changed in the request there. */
  divergence: { callNo: number; type: string; diff?: ReadonlyArray<{ path?: string }> } | null;
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
  /** What it spent and its calls by origin aren't added up yet: the warm-up does, beside the server. */
  warming?: true | null;
  /** A replay made by `shadowlap test`. */
  test?: { golden: string; session?: string } | null;
  /** For an attempt the list bundles: the run it is bundled under (`normalizeRuns`, from the server's `attemptOf`). */
  attempt?: unknown;
  /**
   * What made the run an attempt, as the server classified it against the whole store (engine
   * run-roles.ts); null for a run of its own, and for an attempt whose run isn't listed, which is
   * listed like any run (`normalizeRuns`).
   */
  attemptKind?: string | null;
  /** The last blame: the call the run was lost at, and the two it was lost gradually around when no one call lost it. */
  blame?: { callNo: number | null; range?: unknown } | null;
  /** Outcome checks, as they came out for this run: `passed` of `total`, and when any, `inconclusive` and `notApplicable`. */
  checks?: CheckCounts | null;
  author?: string | null;
  /** What kind of run it is and how it came out, when the server classifies runs itself. */
  kind?: string | null;
  /** `range` on a run blame found lost gradually around two calls. */
  outcome?: { kind: string; callNo?: number; range?: unknown; checks?: number; notApplicable?: number; check?: string | null } | null;
  failed?: boolean | null;
  /** What the run was about (decision 10: the id names it), when the server says. */
  about?: { text: string; from: string } | null;
  /** Its outcome by checks, when the server judged it (run-outcome.ts): its own, a capture's by the rules on calls, or its family's goldens'. */
  judged?: JudgedLike | null;
  /** For a test replay whose agent exited with an error: the code, as its test result says it; absent where nothing kept it. */
  exitCode?: number | null;
}

/**
 * A run's outcome by checks as the server judges it (run-outcome.ts): its own checks, a capture's by
 * the rules on calls, or its family's goldens' judged from its recording, `today` when those came
 * after it was recorded. What Status and the run's first fact say; each check, for their hover, on
 * the run's page and Runs' rows.
 */
export type JudgedLike = Pick<RunJudged, 'by' | 'verdict' | 'counts' | 'callNo' | 'today'> & Partial<Pick<RunJudged, 'first' | 'goldens' | 'why' | 'checks' | 'since'>>;

export type RunType = 'recording' | 'capture' | 'fork' | 'clean' | 'replay' | 'test';

/** A run's checks counted, as the server counts them. */
export interface CheckCounts {
  passed: number;
  total: number;
  inconclusive?: number;
  notApplicable?: number;
}

/**
 * A run's checks counted as the server counts them: `passed` only those that passed, and when there
 * are any, those `inconclusive` and `notApplicable`. A check kept before checks had a status reads as
 * its `ok` says.
 */
export function countChecks(checks: ReadonlyArray<{ ok: boolean; status?: string }>): CheckCounts {
  const status = (c: { ok: boolean; status?: string }) => c.status ?? (c.ok ? 'passed' : 'failed');
  const n = (s: string) => checks.filter((c) => status(c) === s).length;
  const inconclusive = n('inconclusive');
  const notApplicable = n('not-applicable');
  return { passed: n('passed'), total: checks.length, ...(inconclusive ? { inconclusive } : {}), ...(notApplicable ? { notApplicable } : {}) };
}

/** The checks counts say failed: neither passed, inconclusive nor not applicable. */
export const checksFailed = (c: CheckCounts): number => c.total - c.passed - (c.inconclusive ?? 0) - (c.notApplicable ?? 0);

/** `2 checks passed`, `1 check passed, 2 not applicable`: a check that did not apply never counts as passed. The engine's words, as an import's verdict says them. */
export const checksPassedText = (passed: number, notApplicable = 0): string => passedWords(passed, notApplicable);

export const isLive = (r: Pick<RunLike, 'status'>): boolean => r.status === 'running';

/**
 * An attempt the lists bundle under the run it came from rather than list (a blame probe, a verify
 * attempt, a `--repeat`'s, an error-path preset's, a golden's repeated test replay): the engine's one
 * rule (run-roles.ts), as the server applied it to the list's rows.
 */
export function isAttempt(r: RunLike): boolean {
  return isAttemptRun(r);
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
  if (r.checks && checksFailed(r.checks) > 0) return true;
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
  return r.checks && checksFailed(r.checks) > 0 ? 'check failed' : 'failed';
}

export function runOrigins(r: RunLike): Origin7[] | null {
  return parseOrigins(r.origins);
}

export function runCounts(r: RunLike): OriginCounts | null {
  const o = runOrigins(r);
  return o ? countOrigins(o) : null;
}

export type GlyphKind = 'live' | 'rec' | 'fail' | 'warn' | 'clean' | 'fork' | 'cap' | 'test' | 'blame' | 'fixok' | 'fixbad' | 'project' | 'setting' | 'train';

/** Where a fork left its recording: `fork @17`, or `ended early @11` for a replay that stopped before its recording did. */
function forkAt(d: { callNo: number; type?: string }, fork = 'fork'): string {
  return `${d.type === 'ended_early' ? 'ended early' : fork} @${d.callNo}`;
}

/** The icon a run shows, with the words that go with it. */
export function runGlyph(r: RunLike): { kind: GlyphKind; label: string } {
  if (isLive(r)) return { kind: 'live', label: 'Recording now' };
  const t = runType(r);
  const failed = isFailed(r);
  const cut = isInterrupted(r) ? ', interrupted' : '';
  if (t === 'clean') return { kind: 'clean', label: 'Clean replay' };
  if (t === 'fork') return { kind: 'fork', label: `${r.divergence!.type === 'ended_early' ? 'Ended early' : 'Fork'} at #${r.divergence!.callNo}${cut}` };
  if (t === 'capture') return { kind: 'cap', label: 'Imported capture' };
  if (t === 'test') return failed ? { kind: 'fail', label: 'Test failed' } : { kind: 'test', label: `Test replay${cut}` };
  if (t === 'replay') return failed ? { kind: 'fail', label: 'Replay failed' } : { kind: 'clean', label: `Replay${cut}` };
  return failed ? { kind: 'fail', label: 'Recording, failed' } : { kind: 'rec', label: `Recording${cut}` };
}

/**
 * The chip beside a run's id on its page, its status: an interrupted recording, replay or test says
 * so, in grey; a run that failed says FAILED, a fork as any other (its eyebrow names the fork).
 * Compare's path headers name each side by its kind instead (`kindTag`).
 */
export function runTag(r: RunLike): { cls: string; text: string } {
  if (isLive(r)) return { cls: 'live', text: 'recording' };
  const t = runType(r);
  if (isInterrupted(r) && (t === 'recording' || t === 'replay' || t === 'test')) return { cls: '', text: 'interrupted' };
  if (t === 'recording') return isFailed(r) ? { cls: 'fail', text: 'failed' } : { cls: '', text: 'recording' };
  if (t === 'clean') return { cls: 'clean', text: 'clean' };
  if (t === 'fork') return isFailed(r) ? { cls: 'fail', text: 'failed' } : { cls: 'fork', text: forkAt(r.divergence!) };
  if (t === 'capture') return { cls: 'cap', text: 'capture' };
  if (t === 'test') return isFailed(r) ? { cls: 'fail', text: 'failed' } : { cls: 'test', text: 'test' };
  return isFailed(r) ? { cls: 'fail', text: 'failed' } : { cls: '', text: 'replay' };
}

/**
 * The chip beside a run's id on its page: its status only, since the eyebrow above it names what kind
 * of run it is and the meta line under it why it failed. In progress, failed, inconclusive (amber) or
 * interrupted (neutral); none for a run with nothing to report, so no word in the header says twice
 * what another says.
 */
export function headerStatus(r: RunLike): { cls: string; text: string } | null {
  if (isLive(r)) return { cls: 'live', text: 'in progress' };
  if (isFailed(r)) return { cls: 'fail', text: 'failed' };
  if (runOutcome(r).tone === 'warn') return { cls: 'inc', text: 'inconclusive' };
  if (isInterrupted(r)) return { cls: '', text: 'interrupted' };
  return null;
}

/**
 * The tag Compare's path headers give each side, as the design's `typeTag` does: what kind of run it
 * is, a fork by where it forked (`fork @7`) whether or not it failed, since the paths under it show
 * what it did; a recording or a test that failed says FAILED, as on its page.
 */
export function kindTag(r: RunLike): { cls: string; text: string } {
  return runType(r) === 'fork' && !isLive(r) ? { cls: 'fork', text: forkAt(r.divergence!) } : runTag(r);
}

/** What kind of run it is, in a word or two: recording, clean replay, replay, fork @17, capture, test. */
export function kindWord(r: RunLike): string {
  const t = runType(r);
  if (t === 'fork') return forkAt(r.divergence!);
  if (t === 'clean') return 'clean replay';
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

/**
 * The sidebar's line: what happened, in a few words. A run that needs a look says so first, in the
 * design's sidebar words (sideNeeds): where blame found it lost (`lost at #9`), where a test diverged
 * (`diverged at #3`), how its agent exited, `check failed`, or `inconclusive`; then what it is. `err`
 * is said in red, `warn` in amber.
 */
export function sideLine(r: RunLike): { text: string; err?: string; warn?: string } {
  const counts = runCounts(r);
  const calls = plural(r.calls, 'call');
  if (isLive(r)) return { text: `${runType(r) === 'recording' || runType(r) === 'capture' ? 'recording' : 'running'} · ${calls} so far` };
  const t = runType(r);
  // Stopped before it ended, failing nothing else: what it is, then that, as the Forks view says it.
  if (isInterrupted(r)) return { text: `${kindWord(r)} · interrupted · ${calls}` };
  const needs = sideNeeds(r);
  // A recording or a capture is what a run is unless the line says otherwise: its calls follow.
  const what = ` · ${t === 'recording' || t === 'capture' ? calls : kindWord(r)}`;
  if (needs?.tone === 'err') return { err: needs.text, text: what };
  if (needs?.tone === 'warn') return { warn: needs.text, text: what };
  if (t === 'clean') return { text: counts ? `clean replay · ${num(counts.rep)}/${num(r.calls)}` : `clean replay · ${calls}` };
  if (t === 'fork') {
    const went = counts ? ` · ${num(counts.live + counts.fail)} live${counts.block ? ` · ${num(counts.block)} blocked` : ''}${counts.stub ? ` · ${num(counts.stub)} stubbed` : ''}` : ` · ${calls}`;
    return { text: `${forkAt(r.divergence!)}${went}` };
  }
  if (t === 'capture') return { text: `capture · ${calls}` };
  if (t === 'test') return { text: counts && counts.live && r.divergence ? `test · forked at #${r.divergence.callNo} · ${num(counts.live)} live` : 'test · offline · 0 upstream' };
  return { text: `${runSource(r)} · ${calls}` };
}

/** Where blame found a run lost, as the server's outcome or an older server's blame says it. */
function lostCall(r: RunLike): { callNo: number; range?: unknown } | null {
  const o = r.outcome;
  if (o) return o.kind === 'lost' && typeof o.callNo === 'number' ? { callNo: o.callNo, range: o.range } : null;
  return r.blame?.callNo ? { callNo: r.blame.callNo, range: r.blame.range } : null;
}

/**
 * What needs a look, in the design's sidebar words: the run's outcome (outcomeOf), but a run blame
 * found lost says where (`lost at #9`, the blame's finding, where Runs' Status says the check it
 * failed), and a failed check says `check failed`, its call left to Runs, which has the room.
 */
function sideNeeds(r: RunLike): { text: string; tone: 'err' | 'warn' } | null {
  const out = outcomeOf(r);
  if (out.tone === 'warn') return { text: 'inconclusive', tone: 'warn' };
  if (out.tone !== 'err') return null;
  const lost = lostCall(r);
  if (lost) return { text: lostWords(lost.callNo, lost.range), tone: 'err' };
  return { text: out.of === 'judged' || out.of === 'check' ? 'check failed' : out.text, tone: 'err' };
}

/**
 * What the sidebar, and a phone's Runs row, say after a run's about line (decision 10: the id names
 * the run, the about line says what it was): only what needs a look (sideNeeds), or how far a
 * recording has got: `9 calls` while it records, `diverged at #1`, `lost at #9`, `check failed`,
 * `inconclusive`, `interrupted`. Null for a run that needs nothing. `tone`: a failure in red,
 * inconclusive in amber.
 */
export function sideStatus(r: RunLike & { lostAt?: number | null }): { text: string; tone: 'err' | 'warn' | null } | null {
  if (isLive(r)) return { text: plural(r.calls, 'call'), tone: null };
  const needs = sideNeeds(r);
  if (needs) return needs;
  if (isInterrupted(r)) return { text: 'interrupted', tone: null };
  return null;
}

/** What a fork's fence did to the writes after it, as the sidebar counts them: `2 writes blocked`, `1 write stubbed`, `3 writes fenced` (both), `no writes fenced`. */
export function fencedText(c: Pick<OriginCounts, 'block' | 'stub'>): string {
  if (c.block && c.stub) return `${plural(c.block + c.stub, 'write')} fenced`;
  if (c.block) return `${plural(c.block, 'write')} blocked`;
  if (c.stub) return `${plural(c.stub, 'write')} stubbed`;
  return 'no writes fenced';
}

/** A run with nothing to report: a fork says what came of its writes (`forked · 2 writes blocked`), any other run a dash. */
function nothingToReport(r: RunLike): RunOutcomeWords & { of: OutcomeOf } {
  const counts = runType(r) === 'fork' && r.divergence?.type !== 'ended_early' ? runCounts(r) : null;
  return counts ? { of: 'fork', tone: 'fk', text: `forked · ${fencedText(counts)}` } : { of: 'none', tone: 'n', text: '—' };
}

/** What a status judged by today's checks adds, after its words: the checks came after the run was recorded. */
export const TODAY = 'by today’s checks';

/** A run's status: its tone and words; `at`, the words before the call it turned on and the call (a page links it); `today`, judged by checks added after it was recorded. */
export interface RunOutcomeWords {
  tone: 'live' | 'err' | 'ok' | 'warn' | 'n' | 'fk' | 'mu';
  text: string;
  at?: { words: string; callNo: number };
  today?: true;
}

/**
 * What decided a run's status, which its hover says (outcome-tip.ts): a recording in progress, a
 * divergence, the checks that judged it, a check that failed or the agent's exit, a check that could
 * not be decided, checks that passed, an interruption, a fork's writes, or nothing.
 */
export type OutcomeOf = 'live' | 'diverged' | 'judged' | 'check' | 'exit' | 'inconclusive' | 'passed' | 'interrupted' | 'fork' | 'none';

/** How the agent's exit reads in a status: `exited 1` where its code was kept, else as the engine says it. */
export const exitWords = (r: Pick<RunLike, 'exitCode'>): string => (typeof r.exitCode === 'number' && r.exitCode !== 0 ? `exited ${r.exitCode}` : FAILURE_WORDS.exit.replace(/^the agent /, ''));

/** Words that end on the call they name, for a page to link it: `diverged at #3`. */
const atCall = (tone: RunOutcomeWords['tone'], words: string, callNo: number): RunOutcomeWords => ({ tone, text: `${words} #${callNo}`, at: { words, callNo } });

/**
 * Whether the checks that judged a run say how it came out: not while it records or where a test
 * diverged, nor where the agent's exit failed it with no check of its own failing. A run blame found
 * lost failed its own check, which it names; a family's verdict never stands for a run's own failure.
 */
function judgedDecides(r: RunLike, j: JudgedLike): boolean {
  const o = r.outcome;
  if (!o || o.kind === 'none' || o.kind === 'clean' || o.kind === 'passed' || o.kind === 'inconclusive') return true;
  return j.by === 'own' && j.verdict === 'failed' && (o.kind === 'lost' || (o.kind === 'check-failed' && !!o.check));
}

/**
 * The status the checks that judged a run give it (`judged`), where they decide it (judgedDecides):
 * `check failed at #6` (`2 checks failed` with more), `inconclusive`, `2 checks passed`, `not
 * applicable`; null without a verdict to say.
 */
export function judgedOutcome(r: RunLike): RunOutcomeWords | null {
  const j = r.judged;
  if (!j || !judgedDecides(r, j)) return null;
  const today = j.today ? { today: true as const } : {};
  if (j.verdict === 'failed') {
    const words = j.counts.failed > 1 ? `${plural(j.counts.failed, 'check')} failed` : 'check failed';
    return { ...(j.callNo !== null ? atCall('err', `${words} at`, j.callNo) : { tone: 'err', text: words }), ...today };
  }
  if (j.verdict === 'inconclusive') return { tone: 'warn', text: 'inconclusive', ...today };
  if (j.verdict === 'passed') return { tone: 'ok', text: checksPassedText(j.counts.passed, j.counts.notApplicable), ...today };
  return { tone: 'mu', text: 'not applicable', ...today };
}

/**
 * How a run came out, and what decided it, in the words the Runs table's Status and a run's first
 * fact say: in progress; a test replay that diverged, at its call; the verdict of the checks that
 * judged it (judgedOutcome); a check that failed, or the agent's exit (`exited 1`); a check that
 * could not be decided, `inconclusive`; checks that passed; `interrupted`. A run no check judges says
 * nothing, a dash, a clean replay too (how faithful it was is no verdict), and a fork what came of
 * its writes, by a neutral dot (`fk`). Where blame found a run lost, the check it failed says it:
 * the sidebar and the blame's finding say where it was lost.
 */
export function outcomeOf(r: RunLike): RunOutcomeWords & { of: OutcomeOf } {
  if (isLive(r)) return { of: 'live', tone: 'live', text: 'in progress' };
  const o = r.outcome;
  if (o?.kind === 'running') return { of: 'live', tone: 'live', text: 'in progress' };
  const diverged = o ? (o.kind === 'diverged' && typeof o.callNo === 'number' ? o.callNo : null) : r.test && r.divergence ? r.divergence.callNo : null;
  if (diverged !== null) return { of: 'diverged', ...atCall('err', 'diverged at', diverged) };
  const judged = judgedOutcome(r);
  if (judged) return { of: 'judged', ...judged };
  if (o) {
    // A check, or the agent's exit (an outcome that names no check).
    if (o.kind === 'lost' || o.kind === 'check-failed') return failedWord(r) === 'check failed' ? { of: 'check', tone: 'err', text: 'check failed' } : { of: 'exit', tone: 'err', text: exitWords(r) };
    // No check failed, and one could not be decided: amber, neither a pass nor a failure.
    if (o.kind === 'inconclusive') return { of: 'inconclusive', tone: 'warn', text: 'inconclusive' };
    if (o.kind === 'passed' && typeof o.checks === 'number') return { of: 'passed', tone: 'ok', text: checksPassedText(o.checks, o.notApplicable) };
    // A clean replay is no verdict, never passed's lime: no check judges it, a dash.
    if (o.kind === 'clean') return { of: 'none', tone: 'n', text: '—' };
    // A run cut short (its recorder stopped before it ended) has no outcome, but says why.
    if (o.kind === 'none') return r.status === 'crashed' ? { of: 'interrupted', tone: 'n', text: 'interrupted' } : nothingToReport(r);
  }
  if (r.blame && r.blame.callNo) return { of: 'check', tone: 'err', text: 'check failed' };
  if (r.checks && r.checks.total) {
    if (checksFailed(r.checks) > 0) return { of: 'check', tone: 'err', text: 'check failed' };
    if (r.checks.inconclusive) return { of: 'inconclusive', tone: 'warn', text: 'inconclusive' };
    return { of: 'passed', tone: 'ok', text: checksPassedText(r.checks.passed, r.checks.notApplicable) };
  }
  if (r.status === 'crashed') return { of: 'interrupted', tone: 'n', text: 'interrupted' };
  if (r.status === 'failed') return { of: 'exit', tone: 'err', text: exitWords(r) };
  return nothingToReport(r);
}

/** The Runs table's status: the outcome only, in a dot and a few words (outcomeOf). */
export function runOutcome(r: RunLike): RunOutcomeWords {
  const { of: _of, ...words } = outcomeOf(r);
  return words;
}

/**
 * The Runs table's Status: the outcome, and for a fork, what it did that its recording didn't: what
 * came of its writes (`forked · 2 writes blocked`), or the check it failed, named in its own words
 * under `check failed` (`check`), as the run's page names a check it can tell no more of.
 */
export function runStatus(r: RunLike): RunOutcomeWords & { check?: string } {
  const out = runOutcome(r);
  const check = r.outcome?.kind === 'check-failed' ? r.outcome.check : null;
  if (out.tone === 'err' && check && runType(r) === 'fork') return { ...out, check };
  return out;
}

/**
 * What a run spent live. A capture's traffic reads "as captured"; a run recorded on another machine
 * (a teammate's, pulled from the team store, or a golden unpacked here) shows what it cost there.
 */
export function runSpent(r: RunLike): { text: string; captured: boolean } {
  if (runType(r) === 'capture') return { text: money(r.captured), captured: true };
  return { text: r.warming ? '…' : approx(r.spent || (r.imported ? r.captured : 0)), captured: false };
}

/** What a run spent, or an ellipsis while it is still being added up (`warming`). */
const spentWords = (r: RunLike): string => (r.warming ? '…' : approx(r.spent));

/** The Runs page's chips: the kinds, Failed, and with a team store Local, the runs only on this machine. */
export type RunChip = 'all' | 'recording' | 'fork' | 'clean' | 'test' | 'capture' | 'failed' | 'local';
export const RUN_CHIPS: ReadonlyArray<[RunChip, string]> = [
  ['all', 'All'],
  ['recording', 'Recordings'],
  ['fork', 'Forks'],
  ['clean', 'Clean'],
  ['test', 'Tests'],
  ['capture', 'Captures'],
  ['failed', 'Failed'],
  ['local', 'Local'],
];

/** Whether a run is one a chip shows, in a list worked out in the page (an exported copy, which has no team store: Local shows none). */
export function matchesChip(r: RunLike, chip: RunChip): boolean {
  if (chip === 'all') return true;
  if (chip === 'failed') return isFailed(r);
  if (chip === 'local') return false;
  return runType(r) === chip;
}

/** The filter field: every word must appear in the id, about line, command, labels or revision, as the server matches it. */
export function matchesText(r: RunLike, query: string): boolean {
  // As the server's filter reads it (links.ts `filterTerms`): a `label:<name>` term is that label exactly, as typed.
  const { words, labels } = filterTerms(query);
  if (!labels.every((l) => r.labels.includes(l))) return false;
  if (!words.length) return true;
  const hay = `${r.runId} ${r.about?.text ?? ''} ${runSource(r)} ${r.labels.join(' ')} ${r.codeVersion ?? ''} ${kindWord(r)}`.toLowerCase();
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
 * The deepest a row is drawn in: four steps of 18px leave the sidebar's 252px room for a run's id and
 * its time beside it, a date ("Sep 30") the widest; a fifth would push the date past the edge. A
 * longer lineage (a replay of a replay of …) keeps to this step.
 */
export const TREE_DEPTH = 4;

/**
 * The sidebar's tree as the rows shown draw it, one step in for each level: each row's depth, and
 * for its branch lines, level by level, whether a later sibling follows the run at that level of its
 * lineage (`on`, the run itself last: the line goes on through the row), and whether runs hang under
 * it (`kids`). Worked out from the rows as listed, so no line leads to a run left off the list.
 */
/** How many of the newest runs (with their families) the sidebar lists; Runs has the rest. */
export const RECENT_RUNS = 60;

/** The runs the sidebar lists, in its order: `[` and `]` step through them when Runs never showed this one. */
export function recentRunIds(runs: readonly RunLike[]): string[] {
  return runTree(runs.filter((r) => !isAttempt(r)))
    .slice(0, RECENT_RUNS)
    .map((x) => x.run.runId);
}

export function treeLines<R>(rows: ReadonlyArray<{ run: R; depth: number }>): Array<{ run: R; depth: number; on: boolean[]; kids: boolean }> {
  const depth = (i: number) => Math.min(rows[i]!.depth, TREE_DEPTH);
  return rows.map((row, i) => {
    const d = depth(i);
    const on: boolean[] = [];
    for (let k = 1; k <= d; k++) {
      // The first row after this one that leaves the level-k run's subtree: a sibling of it, or not.
      let j = i + 1;
      while (j < rows.length && depth(j) > k) j++;
      on.push(j < rows.length && depth(j) === k);
    }
    return { run: row.run, depth: d, on, kids: i + 1 < rows.length && depth(i + 1) > d };
  });
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
    return `${forkAt(r.divergence)} · ${went} · ${spentWords(r)}`;
  }
  if (t === 'clean') return n && n.rep === r.calls ? `clean replay · ${num(r.calls)}/${num(r.calls)} · 0 upstream` : `clean replay · ${plural(r.calls, 'call')}`;
  // A test of a golden that may fork went live from where it left the recording: what it did there, as
  // the sidebar says it. One that left it where its golden may not diverged there, and failed.
  if (t === 'test') {
    if (r.divergence && r.outcome?.kind === 'diverged') return `test · diverged at #${r.divergence.callNo} · ${plural(r.calls, 'call')}`;
    return n && n.live && r.divergence ? `test · forked at #${r.divergence.callNo} · ${num(n.live)} live · ${spentWords(r)}` : `test · replayed offline · ${plural(r.calls, 'call')}`;
  }
  if (t === 'capture') return `capture · ${plural(r.calls, 'call')} · ${money(r.captured)} as captured`;
  if (t === 'replay') return `replay · ${plural(r.calls, 'call')} · ${r.status === 'completed' ? 'finished' : r.status}`;
  return `${isFailed(r) ? `${failedWord(r)} · ` : 'recording · '}${plural(r.calls, 'call')} · ${spentWords(r)}`;
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
  checks: CheckCounts | null;
}

/**
 * One `replay --repeat` bundled in the Forks view, as the design words it: `replay --repeat 5`, then
 * "forked 5 attempts, 4 passed · ≈$0.141", then each attempt by its id. An attempt passed when its
 * checks did, or, without checks, when it exited cleanly (the first check of every outcome check is
 * the exit code). An attempt that left the path somewhere else than the others says where. One that
 * was stopped before it ended (Ctrl-C, its recorder killed) neither passed nor failed: it is counted
 * apart and marked `cut`, shown in grey as every list shows an interrupted run. `title` names
 * attempts made together otherwise: a golden's attempts in one test session (`test · refund-flow`).
 */
export function repeatBundle(attempts: readonly RepeatAttempt[], title?: string): { title: string; line: string; attempts: Array<{ runId: string; text: string; ok: boolean; cut?: true }> } {
  const sorted = [...attempts].sort((a, b) => (a.repeat?.attempt ?? 0) - (b.repeat?.attempt ?? 0) || a.startedAt - b.startedAt);
  // Passed: no check failed or could not be decided; one that did not apply is no failure.
  const ok = (n: RepeatAttempt) => (n.checks ? checksFailed(n.checks) === 0 && !n.checks.inconclusive : n.status === 'completed');
  const cut = (n: RepeatAttempt) => !n.checks && n.status === 'crashed';
  const forkAt = sorted[0]?.divergence?.callNo ?? null;
  const spent = sorted.reduce((s, n) => s + n.spent, 0);
  const passed = sorted.filter(ok).length;
  const stopped = sorted.filter(cut).length;
  return {
    title: title ?? `replay --repeat ${sorted[0]?.repeat?.of ?? sorted.length}`,
    line: `${forkAt !== null ? 'forked ' : ''}${plural(sorted.length, 'attempt')}, ${num(passed)} passed${stopped ? `, ${num(stopped)} interrupted` : ''}${spent ? ` · ${approx(spent)}` : ''}`,
    attempts: sorted.map((n) => {
      const where = n.divergence && n.divergence.callNo !== forkAt ? ` · forked at #${n.divergence.callNo}` : '';
      const how = n.checks ? `checks ${n.checks.passed} of ${n.checks.total}${n.checks.inconclusive ? `, ${n.checks.inconclusive} inconclusive` : ''}${n.checks.notApplicable ? `, ${n.checks.notApplicable} not applicable` : ''}` : n.status === 'completed' ? 'passed' : n.status === 'running' ? 'running' : n.status === 'crashed' ? 'interrupted' : 'failed';
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

/**
 * A run id as an exported copy's address gives it, against the runs the copy holds: the whole id, or
 * a unique prefix of one in either case, as the dashboard takes it (the pages show ten characters).
 * Anything else comes back as it was, and opens nothing.
 */
export function copyRunId(runIds: readonly string[], id: string): string {
  if (runIds.includes(id) || !/^[0-9A-Za-z]{1,26}$/.test(id)) return id;
  const want = id.toUpperCase();
  const hits = runIds.filter((r) => r.toUpperCase().startsWith(want));
  return hits.length === 1 ? hits[0]! : id;
}

/** Whether an id names no run of a copy whole but starts several of their ids: the copy says so, as the server does. */
export function copyAmbiguous(runIds: readonly string[], id: string): boolean {
  if (runIds.includes(id) || !/^[0-9A-Za-z]{1,26}$/.test(id)) return false;
  const want = id.toUpperCase();
  return runIds.filter((r) => r.toUpperCase().startsWith(want)).length > 1;
}

/** Whether an exported copy has Compare: it holds two runs or more. A copy of one run has nothing to compare it with. */
export function copyCompares(runIds: readonly string[] | null | undefined): boolean {
  return (runIds?.length ?? 0) >= 2;
}
