import { baselineWords, checkLine, checkStatus, firstSentence, formatPassK, injectionTemplates, outputTail, plural, proofParts, rateBound, safe, safeLines, testResultVerdict, unavailableStop, type AttemptReport, type InjectionGateData, type InjectionReport, type PlantReport, type ProofParts, type StoreOf, type StoredCheck, type TestResult } from '@shadowlap/engine';
import { crashError, type CrashError } from './crash-error.js';
import { commandLine, shortFailure } from './fix-shared.js';
import { links } from './links.js';
import { answer, type ReadTable } from './read-registry.js';
import { judgeFor, type OutcomeWork } from './run-outcome.js';
import { entriesBodies } from './request-diff.js';
import { matchingRuns } from './runs-list.js';
import type { BisectMiss, FoundCommit } from './tests-bisect.js';
import type { ChangedCheck } from './tests-checks.js';
import { issueKey } from './issue-keys.js';
import { issueKeyOf } from './issues.js';
import { loadRunIndex } from './run-index.js';
import { forkedWords } from './tests-evidence.js';
import { causeOf, divergenceOf } from './tests-normalize.js';
import type { DivergenceView, FailureView, GoldenRow, GoldenSource, InconclusiveView, TestsView } from './tests.js';

/**
 * A golden's report drawn rather than printed (Tests, under the golden's row): its verdict in one
 * sentence, a grey line of what no part says, and its parts (Replay, Request, Error, Checks, Gate,
 * Attempts, First bad commit, Checks changed), each from the golden's last result read by key; with its lines
 * as `shadowlap test` prints them, for Show as printed and Copy report.
 *
 * Every word the CLI also prints comes from the engine helper or the stored text that words it
 * (`checkLine`, `formatPassK`, `rateBound`, the result's reason); the browser words only the hint,
 * from its key (ui/tests/report-words.ts). GET /api/tests answers on the server's thread, so nothing
 * here reads every run or every call: a run, a call and a session by key, and a golden's own results.
 */

/** A sentence in pieces: paths and files are code; a check reads as words, as the table writes it. */
export type Piece = string | { code: string };

/** How a printed line is coloured: the golden's line red or amber, a value before red, after lime, the agent's lines dim. */
export type ReportTone = '' | 'no' | 'del' | 'add' | 'dim' | 'y';
export interface ReportLine {
  text: string;
  tone: ReportTone;
}

export type ReportPart =
  /** The golden's checks that left the config since its last test, which it failed or couldn't decide. */
  | { kind: 'checks-changed'; gone: ChangedCheck[] }
  /** The replay against its recording, as the mini strip draws a run: `recorded` cells, `replayed` of them replayed, `stop` the call it stopped at. */
  | { kind: 'replay'; recorded: number; replayed: number; stop: number | null; words: string }
  /**
   * A divergence's request, drawn as Show diff draws it on a run: the replay and the call it diverged at, whose diff is read
   * once the report opens (`GET /api/runs/:id/diff`); where the replay is gone, the changes its result kept as two bodies,
   * drawn with no notes, under `against`, the recording's call they're compared with. Then what followed from it, in grey:
   * the offline refusal the agent exited on, with the body it got. A divergence that kept no changes has no `runId`,
   * `bodies` or `against`, only what followed.
   */
  | { kind: 'request'; runId: string | null; callNo: number; against: { runId: string; callNo: number } | null; bodies: { was: unknown; now: unknown } | null; followed: Followed | null }
  /** A crash: the exception it died of, the file it was raised in (in the project where it can be), and the lines it printed last. */
  | ({ kind: 'error' } & CrashError)
  /** Which of the row's checks to draw, in the row's order: the row's own component draws them. */
  | { kind: 'checks'; labels: string[] }
  /** A gate's figures: the row's `last.gate`, with its bound, against history the baseline it compared with, and where inconclusive its pass^5 (`pass^5 0.32`), each in the engine's words. */
  | { kind: 'gate'; bound: string | null; baseline: string | null; passK: string | null }
  /** The attempts, read when the report opens: the check they failed and only what the verdict doesn't say of it, the attempts carried over, where a fork golden's forked, in words. */
  | { kind: 'attempts'; check: { label: string; detail: string } | null; carried: { count: number; at: number | null } | null; forked: string | null }
  | { kind: 'commit'; found: FoundCommit }
  | { kind: 'missed'; missed: BisectMiss }
  /**
   * An injection gate's proof: the attempt it is and its proof in parts (the engine's proofParts), each call it names one of
   * that attempt's, as an attempt's finding draws it; for an attempt that showed nothing, no evidence, and why.
   */
  | { kind: 'proof'; runId: string; parts: ProofParts; why: string | null }
  /** What an injection gate's attempts did, by verdict; where they were planted, while the kept result says; the command that writes every attempt. */
  | { kind: 'injection-attempts'; totals: { obeyed: number; influenced: number; inconclusive: number; ignored: number }; where: string | null; each: string | null; command: string; /** The kept result Security report writes, and the run it tested, which its dialog names, while the store has it. */ security: { resultId: string; runId: string } | null };

/** What followed a diverged call, said apart so it never reads as a second fault: its two clauses, and the body the agent got as indented JSON, while the recording keeps it. */
export interface Followed {
  line: [string, string];
  message: string | null;
}

/**
 * The hint under a report's next steps, by what the report is: the browser words it in one sentence
 * of why (ui/tests/report-words.ts), with what it needs (a judge's name, the hosts a guard blocked).
 */
export type HintKey =
  | { key: 'normalizer' }
  | { key: 'rules-added'; path: string; update: boolean }
  /** Named only where the report draws Find breaking commit, which its steps decide. */
  | { key: 'bisect' }
  | { key: 'gate' }
  | { key: 'judge'; held: 'none' | 'older' | 'material'; name: string }
  | { key: 'judge-key'; name: string; model: string; keys: readonly string[] }
  | { key: 'undecided' }
  | { key: 'crash' }
  | { key: 'check' }
  | { key: 'no-calls' }
  | { key: 'unguarded' }
  | { key: 'no-preload' }
  | { key: 'blocked'; hosts: string[] }
  | { key: 'injection' }
  /** Why it showed too little to say: a model call that got no answer, nothing marked untrusted to plant in, attempts cut short, or nothing shown. */
  | { key: 'injection-inconclusive'; why: 'unanswered' | 'no-reads' | 'stopped' | 'nothing' }
  /** Inconclusive for the provider: unavailable for attempts in a row, or attempts it cut short decide the count. */
  | { key: 'provider'; why: 'unavailable' | 'cut' }
  | { key: 'error' }
  /** Its step is its checks' (check-steps.ts): Run tests, its checks changed since its last test; Edit check, its own recording fails a check added since. */
  | { key: 'checks-changed' }
  | { key: 'edit-check' };

export interface GoldenReport {
  golden: string;
  name: string;
  verdict: 'failed' | 'inconclusive';
  /** What happened, in one sentence. */
  head: Piece[];
  /** The grey line under it: only what no part says, in parts joined by ` · `. */
  sub: string[];
  parts: ReportPart[];
  /** The result's own run, while the store keeps it: Open run, or Open failing attempt for a golden of several attempts. */
  open: { label: string; href: string } | null;
  /** The golden's own failed replays on Runs › Failed, where the link opens its issue: how many and the first five ids; null where there are none, or its step is a fix. */
  failedRuns: { href: string; count: number; ids: string[] } | null;
  hint: HintKey | null;
  /** The report as `shadowlap test` prints it. */
  printed: ReportLine[];
}

/** GET /api/tests's answer: the page's view, and each golden that didn't pass with its report. */
export type TestsAnswer = TestsView & { reports?: Record<string, GoldenReport> };

const lines = (text: string, tone: (line: string) => ReportTone): ReportLine[] =>
  text
    .replace(/\n$/, '')
    .split('\n')
    .map((line) => ({ text: line, tone: tone(line) }));

/**
 * A golden that didn't pass, as `shadowlap test` prints it (printGolden): its line, `✗` or `?`, the
 * name and the reason; each kept check as the engine's checkLine writes it; the details; then the
 * agent's last lines after a bar. Escaped as the CLI escapes them, so a control character, a `##[` or
 * a leading `::` reads as it does in a CI log. A golden that couldn't run prints its line alone, and
 * an injection gate no tail. The notes the CLI prints under the line aren't kept with the result.
 */
export function printedLines(name: string, r: TestResult): ReportLine[] {
  const inconclusive = testResultVerdict(r) === 'inconclusive';
  const out: ReportLine[] = [{ text: `${inconclusive ? '?' : '✗'} ${safe(name)}: ${safe(r.reason ?? (inconclusive ? 'inconclusive' : 'failed'))}`, tone: inconclusive ? 'y' : 'no' }];
  const data = r.data;
  // A golden that couldn't run kept no result, only its mode and why.
  if (!data || (data.calls === undefined && data.attempts === undefined && data.checks === undefined)) return out;
  for (const c of data.checks ?? []) {
    const status = checkStatus(c);
    out.push({ text: `    ${safe(checkLine(c))}`, tone: status === 'failed' ? 'no' : status === 'inconclusive' ? 'y' : '' });
  }
  if (data.details) out.push(...lines(safeLines(data.details, '    '), (l) => (/^\s*- /.test(l) ? 'del' : /^\s*\+ /.test(l) ? 'add' : '')));
  const tail = r.failure === 'injection' || data.injection ? null : outputTail(data.output ?? '');
  if (tail) out.push(...lines(safeLines(tail, '    │ '), () => 'dim'));
  return out;
}

const upstream = (r: TestResult): string | null => (r.data?.upstreamRequests === undefined ? null : plural(r.data.upstreamRequests, 'upstream request'));

/** What a report is built from: the golden's last result and row, the page's inputs, the recording it replays, and the result's own run, read once. */
interface From {
  r: TestResult;
  row: GoldenRow;
  i: ReportInput;
  recording: string | null;
  replay: ReturnType<StoreOf<'recording'>['getRun']>;
}

/** The calls of the recording a replay ran against: the replay's own count where it kept one, else the recording's last call. */
function recordedCalls({ i, recording, replay }: From): number | null {
  if (replay?.divergence?.recorded) return replay.divergence.recorded;
  if (!recording || !i.store.getRun(recording)) return null;
  const last = i.store.nextCallNo(recording) - 1;
  return last > 0 ? last : null;
}

/**
 * A divergence's sentence: the call, then what changed there, its path as code and what it looks
 * like; a second path after `and`. A replay that stopped before its recording did changed no
 * request: it ended early at the first call it never made, as the CLI's line says.
 */
function divergenceHead(r: TestResult, d: NonNullable<ReturnType<typeof divergenceOf>>, normalizers: TestsNormalizers): Piece[] {
  if (d.type === 'ended_early') return [`Ended early at call ${d.callNo}`];
  const cause = causeOf(r, d, normalizers) ?? d.diff?.[0]?.path ?? null;
  if (!cause) return [`Diverged at call ${d.callNo}`];
  const looks = (path: string) => r.data?.divergence?.volatile?.values.find((v) => v.path === path)?.looks ?? null;
  const also = (d.diff ?? []).filter((e) => e.path !== cause).slice(0, 1);
  const first = looks(cause);
  if (!also.length) return [`Diverged at call ${d.callNo}: `, { code: cause }, ` changed${first ? `, ${aLooks(first)}` : ''}`];
  return [`Diverged at call ${d.callNo}: `, { code: cause }, first ? `, ${aLooks(first)}, and ` : ' and ', { code: also[0]!.path }, ' changed'];
}

/** `a UUID`, `an ISO timestamp`: what a value looks like, as the sentence names it. */
const aLooks = (looks: string): string => (/^(a|an|the) /.test(looks) ? looks : `${/^[aeiouAEIOU]/.test(looks) && !/^(UUID|URL|uuid)/.test(looks) ? 'an' : 'a'} ${looks}`);

type TestsNormalizers = Parameters<typeof causeOf>[2];

/** The exit code a crash's reason holds (`the agent exited with code 1`), as the CLI's fixes read it. */
const exitCode = (reason: string | null): number | null => {
  const m = /exited with code (\d+)/.exec(reason ?? '');
  return m ? Number(m[1]) : null;
};

/** A stored reason as a sentence of the report: capitalised, its first sentence where it runs on. */
const asSentence = (reason: string): string => {
  const one = firstSentence(reason);
  return one.charAt(0).toUpperCase() + one.slice(1);
};

/** A sentence that starts with a word of its own capitalised; one that starts with a tool's name keeps it as named. */
const capitalised = (s: string): string => (/^(the|a|an|no) /.test(s) ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** The failed check of a result's shown attempt, as its attempts failed it. */
const failedCheck = (r: TestResult): StoredCheck | null => (r.data?.checks ?? []).find((c) => checkStatus(c) === 'failed') ?? null;

/** The failure of the attempt a result of several shows, after its reason's `Attempt N:`; the reason itself for a result of one. */
const ownFailure = (r: TestResult): string => /\bAttempt \d+: ([^]+)$/.exec(r.reason ?? '')?.[1] ?? r.reason ?? '';

/**
 * What the attempt a result shows did, in the short words Fixes names it by: the check it failed
 * (`send_email called twice`), else its own failure after the reason's `Attempt N:` (`the agent
 * exited with code 1`). Null where neither says, as for a gate that ran out, whose reason is the
 * gate's own sentence: that is never read as an attempt's.
 */
function failWords(c: StoredCheck | null, r: TestResult): string | null {
  if (c) return shortFailure(c.detail ? `${c.label}, but ${c.detail}` : c.label);
  const own = /\bAttempt \d+: ([^]+)$/.exec(r.reason ?? '')?.[1];
  return own ? shortFailure(firstSentence(own.replace(/^check failed: /, ''))) : null;
}

/**
 * What the check under the attempts adds to the verdict: where the verdict's words already say how
 * often the tool was called (`send_email called twice`), only what its detail says in brackets (`2
 * blocked`); else the check's detail as the attempts gave it.
 */
function checkDetail(c: StoredCheck, words: string | null): string {
  const detail = c.detail ?? '';
  if (!detail || !/\b(once|twice|\d+ times)$/.test(words ?? '')) return detail;
  const m = /^called \S+ times?(?: \((.+)\))?$/.exec(detail);
  return m ? (m[1] ?? '') : detail;
}

/** The hint of a golden that failed, by what its attempt failed on. */
function failureHint(failure: TestResult['failure'], reason: string): HintKey {
  if (failure === 'check') return { key: 'check' };
  if (failure === 'exit') return { key: 'crash' };
  if (failure === 'no-calls') return { key: 'no-calls' };
  if (failure === 'guard') return /^The network guard could not watch every process of the agent/.test(reason) ? { key: 'unguarded' } : { key: 'no-preload' };
  return { key: 'error' };
}

export interface ReportInput {
  store: StoreOf<'recording' | 'tests' | 'injection'>;
  /** The goldens on disk, for the recording a golden replays and the checks it has now. */
  goldens: readonly GoldenSource[];
  normalizers: TestsNormalizers;
  /** The project folder, to name the file a crash was raised in from it. */
  project: string | null;
}

interface Built {
  head: Piece[];
  sub: Array<string | null>;
  parts: ReportPart[];
  hint: HintKey | null;
  /** What its header opens, where it isn't the result's own run. */
  open?: GoldenReport['open'];
}

/** The exception the attempt a result shows died of, from the lines it printed last; null where none reads as one. */
function errorPart({ r, i }: From): ReportPart | null {
  const e = crashError(r, i.project);
  return e ? { kind: 'error', ...e } : null;
}

function crashParts(f: From): Built {
  const { r, row, replay } = f;
  const code = exitCode(r.reason);
  const ended = replay?.divergence?.type === 'ended_early' ? replay.divergence : null;
  const head = code === null ? asSentence(r.reason ?? 'the agent exited with an error') : ended ? `The agent exited with code ${code} at call ${ended.callNo}` : `The agent exited with code ${code} after its last call`;
  const parts: ReportPart[] = [];
  const recorded = ended ? (ended.recorded ?? recordedCalls(f)) : null;
  if (ended && recorded) parts.push({ kind: 'replay', recorded, replayed: ended.replayedBefore, stop: ended.callNo, words: dot(`${ended.replayedBefore} of ${recorded} recorded calls replayed, then it stopped`, upstream(r)) });
  const error = errorPart(f);
  if (error) parts.push(error);
  if (row.checks.length) parts.push({ kind: 'checks', labels: row.checks });
  return { head: [head], sub: parts.some((p) => p.kind === 'replay') ? [] : [upstream(r)], parts, hint: { key: 'crash' } };
}

const dot = (...words: Array<string | null>): string => words.filter(Boolean).join(' · ');

/**
 * A divergence's hint: its rule in the config already, else a normalizer that leads, else Find
 * breaking commit's, which the report says only where it draws that button (its steps decide:
 * ui/tests/report-words.ts `reportHint`).
 */
const divergenceHint = (d: DivergenceView): HintKey => (d.rulesAdded && d.volatile ? { key: 'rules-added', path: d.volatile.path, update: !d.normalizerFixes } : d.normalizerFixes && !d.maybeReal ? { key: 'normalizer' } : { key: 'bisect' });

function divergenceParts(f: From, d: DivergenceView): Built {
  const { r, i } = f;
  const div = divergenceOf(r);
  if (!div) return { head: [`Diverged at call ${d.callNo}`], sub: [upstream(r)], parts: [], hint: divergenceHint(d) };
  const parts: ReportPart[] = [];
  const recorded = div.callNo > 1 ? recordedCalls(f) : null;
  const then = div.type === 'ended_early' ? 'it stopped' : `call ${div.callNo} diverged`;
  if (recorded) parts.push({ kind: 'replay', recorded, replayed: div.replayedBefore, stop: div.callNo, words: dot(`${div.replayedBefore} of ${recorded} recorded calls replayed, then ${then}`, upstream(r)) });
  const request = requestPart(f, div);
  if (request) parts.push(request);
  return { head: divergenceHead(r, div, i.normalizers), sub: [recorded ? null : upstream(r)], parts, hint: divergenceHint(d) };
}

/**
 * A divergence's Request part. Where its result kept changes, which is where a run offers Show diff
 * (ui/run/banner.ts), the replay's diverged call, its diff asked for once the report opens, or once
 * the replay is gone the changes themselves; then what followed it. A divergence that kept none (a
 * call new to the recording or past its end, a replay that stopped before it did) compares nothing:
 * its part is only what followed, and there is none where nothing did.
 */
function requestPart({ r, i, recording, replay }: From, div: NonNullable<ReturnType<typeof divergenceOf>>): ReportPart | null {
  const followed = r.runId && replay ? followedOf(i.store, replay, div.callNo) : null;
  if (!div.diff?.length) return followed ? { kind: 'request', runId: null, callNo: div.callNo, against: null, bodies: null, followed } : null;
  const against = recording ? { runId: recording, callNo: div.callNo } : null;
  if (r.runId && replay) return { kind: 'request', runId: r.runId, callNo: div.callNo, against, bodies: null, followed };
  return { kind: 'request', runId: null, callNo: div.callNo, against, bodies: entriesBodies(div.diff), followed: null };
}

/**
 * What followed a diverged call: the offline refusal the agent got in its place, said where the replay
 * then ended failed, with the body the call's record kept, the bytes the agent got, never one rebuilt
 * from its message. Read by key: the one call.
 */
function followedOf(store: ReportInput['store'], replay: NonNullable<From['replay']>, callNo: number): Followed | null {
  const end = store.getCalls(replay.runId, { only: [callNo] })[0]?.end;
  if (!end?.meta.offline || end.meta.status !== 503 || replay.status !== 'failed') return null;
  let message: string | null = null;
  try {
    const body = end.responseRef ? store.getJson(end.responseRef) : null;
    message = body === null ? null : JSON.stringify(body, null, 2);
  } catch {
    // A body that can't be read is left out: the line still says what followed.
  }
  return { line: ['Not served from the recording:', 'the agent exited on HTTP 503'], message };
}

/** A result's gate, where it decided (or ran out); null where it went on, which decided nothing. */
const decidedGate = (r: TestResult) => (r.data?.gate && r.data.gate.decision !== 'continue' ? r.data.gate : null);

/** Why a gate's verdict is what it is, after its attempts' count; nothing for a fixed count of attempts. */
function gateWhy(gate: ReturnType<typeof decidedGate>): string {
  if (!gate) return '';
  // Short of its limit, a gate stopped by a signal or the provider didn't run out: its evidence says where it stopped.
  if (gate.decision === 'inconclusive') return gate.attempts >= gate.max ? ', and its gate ran out before deciding' : ', and its gate stopped before deciding';
  return gate.kind === 'baseline' ? ', a drop against its own history' : ', too often for its gate';
}

/** The Attempts part's words: the check they failed and only what the verdict doesn't say, the attempts carried over and when that session started, where a fork golden's attempts forked. */
function attemptsPart({ r, row, i }: From, c: StoredCheck | null, words: string | null): ReportPart {
  const carried = r.data?.continued;
  const newest = carried?.sessions.at(-1);
  const since = newest ? i.store.getTestSession(newest) : null;
  const at = row.mode === 'fork' ? r.data?.divergence?.callNo : null;
  return { kind: 'attempts', check: c ? { label: c.label, detail: checkDetail(c, words) } : null, carried: carried?.attempts ? { count: carried.attempts, at: since?.startedAt ?? null } : null, forked: at ? forkedWords(at, true) : null };
}

/**
 * A golden of several attempts that failed, whatever its attempt failed on, or whose gate ran out
 * or stopped: what the attempt it shows did and in how many, its gate, its attempts, the exception
 * where that attempt crashed, and its other checks. Never the provider's or an undecided check's,
 * which say why in their own words.
 */
function attemptsParts(f: From): Built | null {
  const { r, row } = f;
  const gate = decidedGate(r);
  const n = gate?.attempts ?? r.data?.attempts?.total ?? 1;
  const inconclusive = testResultVerdict(r) === 'inconclusive';
  if (n <= 1 || unavailableStop(r.reason) || (inconclusive && gate?.decision !== 'inconclusive')) return null;
  const passed = gate?.passes ?? r.data?.attempts?.passed ?? 0;
  const c = failedCheck(r);
  const words = failWords(c, r);
  const parts: ReportPart[] = gate ? [{ kind: 'gate', bound: rateBound(gate), baseline: gate.evidence.kind === 'baseline' ? baselineWords(gate.evidence) : null, passK: inconclusive ? formatPassK(gate) : null }] : [];
  parts.push(attemptsPart(f, c, words));
  const error = r.failure === 'exit' ? errorPart(f) : null;
  if (error) parts.push(error);
  const others = row.checks.filter((label) => label !== c?.label);
  if (others.length) parts.push({ kind: 'checks', labels: others });
  const many = `in ${n - passed} of ${plural(n, 'attempt')}`;
  return { head: [`${words ? capitalised(`${words} ${many}`) : `Failed ${many}`}${gateWhy(gate)}`], sub: [upstream(r)], parts, hint: inconclusive ? { key: 'gate' } : failureHint(r.failure, ownFailure(r)) };
}

/** The replay of a golden's one attempt that failed a check: clean to its end; a fork golden's up to its fork, live from there. */
function checkedReplay(f: From): ReportPart | null {
  const recorded = recordedCalls(f);
  if (!recorded) return null;
  const { r, row } = f;
  if (row.mode !== 'fork') return { kind: 'replay', recorded, replayed: recorded, stop: null, words: dot(`${recorded} of ${recorded} calls replayed, clean`, upstream(r)) };
  const at = r.data?.divergence?.callNo;
  const replayed = r.data?.calls?.replayed;
  if (!at || replayed === undefined) return null;
  return { kind: 'replay', recorded, replayed: Math.min(replayed, recorded), stop: null, words: dot(`${replayed} of ${recorded} recorded calls replayed, ${forkedWords(at)}`, upstream(r)) };
}

/**
 * An inconclusive golden with no gate to say more: a check its replay couldn't decide, a judge's
 * most often; else what the provider left it, which says nothing about the agent, in the result's
 * own words. A fork golden's replay ran live from its fork, so it never says it replayed clean.
 */
function inconclusiveParts({ r, row }: From, v: InconclusiveView): Built {
  const undecided = (r.data?.checks ?? []).find((c) => checkStatus(c) === 'inconclusive') ?? null;
  const parts: ReportPart[] = row.checks.length ? [{ kind: 'checks', labels: row.checks }] : [];
  if (!undecided || unavailableStop(r.reason)) {
    const why = unavailableStop(r.reason) ? 'unavailable' : /cut short by the provider/.test(r.reason ?? '') ? 'cut' : null;
    // What to do about it is the hint's.
    const reason = (r.reason ?? 'inconclusive').replace(/^inconclusive: /, '').replace(/; run it again once the provider answers$/, '');
    return { head: [asSentence(reason)], sub: [upstream(r)], parts, hint: why ? { key: 'provider', why } : null };
  }
  const fork = row.mode === 'fork';
  const what = `${undecided.judge ? 'judge check' : 'check'} wasn’t judged`;
  const head = fork ? `Its ${what}` : `Replayed clean, but its ${what}${row.checks.includes(undecided.label) ? '' : ': the test runs offline'}`;
  const calls = r.data?.calls;
  const at = fork ? r.data?.divergence?.callNo : null;
  const j = v.judge;
  const hint: HintKey = j?.update && j.held ? { key: 'judge', held: j.held, name: j.name } : j?.keys?.length ? { key: 'judge-key', name: j.name, model: j.model, keys: j.keys } : { key: 'undecided' };
  return { head: [head], sub: [at ? forkedWords(at) : calls && !fork ? `${calls.replayed} of ${plural(calls.total, 'call')}` : null, upstream(r)], parts, hint };
}

/** A golden of one attempt that failed a check, made no calls, or was stopped by the guard or an error. */
function failureParts(f: From, v: FailureView): Built {
  const { r, row } = f;
  if (v.failure === 'check') {
    const c = failedCheck(r);
    const parts: ReportPart[] = [];
    const replay = c ? checkedReplay(f) : null;
    if (replay) parts.push(replay);
    if (row.checks.length) parts.push({ kind: 'checks', labels: row.checks });
    return { head: c ? [`Check failed: ${c.label}, but ${c.detail ?? 'failed'}`] : [asSentence(v.reason)], sub: replay ? [] : [upstream(r)], parts, hint: { key: 'check' } };
  }
  return { head: [asSentence(v.reason)], sub: [upstream(r)], parts: row.checks.length && v.checks?.length ? [{ kind: 'checks', labels: row.checks }] : [], hint: failureHint(v.failure, v.reason) };
}

/** The kept result an injection gate's verdict came from, while the store has it. */
function keptPlant(store: StoreOf<'injection'>, gate: InjectionGateData | undefined): PlantReport | null {
  const kept = gate?.resultId ? store.getInjectionResult(gate.resultId) : null;
  const report = kept?.data as unknown as InjectionReport | undefined;
  return report?.mode === 'plant' ? report : null;
}

/** The attempt an injection gate's proof is: the first that obeyed, else the first influenced, else the first that couldn't say. */
function proofAttempt(report: PlantReport | null): AttemptReport | null {
  for (const verdict of ['obeyed', 'influenced', 'inconclusive'] as const) {
    const a = report?.attempts.find((x) => x.verdict === verdict);
    if (a) return a;
  }
  return null;
}

/** Where an injection gate planted, broken at its comma: its payloads at its untrusted reads, then so many attempts each. */
function plantedWhere(report: PlantReport): { where: string; each: string } | null {
  if (!report.payloads.length || !report.reads.length) return null;
  const templates = report.payloads.filter((p) => p.source === 'template');
  const every = templates.length === injectionTemplates().templates.length;
  const named = [...(every ? ['every template'] : templates.map((p) => p.id)), ...report.payloads.filter((p) => p.source === 'file').map((p) => p.id)].join(', ');
  const planted = report.reads.filter((x) => x.planted).length;
  return { where: `${named} at ${planted === report.reads.length ? 'every untrusted read' : `${planted} of ${plural(report.reads.length, 'untrusted read')}`},`, each: `${plural(report.repeat, 'attempt')} each` };
}

/**
 * An injection gate's reason as the verdict's sentence: what obeyed and its limit, the proof left to
 * its part; for one that showed too little to say, what kept it from saying, `got HTTP 529` for a
 * call that failed (its message left to the printed lines), and the rest for the proof.
 */
function injectionWords(reason: string, failed: boolean): { head: string; rest: string } {
  if (failed) return { head: reason.replace(/^(.*?\(at most \d+ allowed\)).*$/, '$1'), rest: '' };
  const pieces = reason.split(': ');
  // How to mark a read untrusted runs on in the reason; the hint says it in a sentence.
  const n = /^no untrusted read/.test(reason) ? 1 : 2;
  return { head: pieces.slice(0, n).join(': ').replace(/ failed with (HTTP \d+)(?: \([^)]*\))?/, ' got $1'), rest: pieces.slice(n).join(': ') };
}

/** Why an injection gate showed too little to say, by its reason, for its hint. */
const injectionWhy = (reason: string): Extract<HintKey, { key: 'injection-inconclusive' }>['why'] => (/could not be judged/.test(reason) ? 'unanswered' : /^no untrusted read/.test(reason) ? 'no-reads' : / ran \(/.test(reason) ? 'stopped' : 'nothing');

/** A golden whose verdict is its injection gate's: its proof, what its attempts did and where they were planted; its header opens the proof. */
function injectionParts(r: TestResult, i: ReportInput, golden: string): Built {
  const gate = r.data?.injection;
  const failed = testResultVerdict(r) === 'failed';
  const reason = gate?.reason ?? (r.reason ?? '').replace(/^injection( inconclusive)?: /, '');
  const { head, rest } = injectionWords(reason, failed);
  const report = keptPlant(i.store, gate);
  const a = proofAttempt(report);
  const parts: ReportPart[] = [];
  // An attempt that showed nothing proves nothing: where it was planted and read, and why.
  if (a) parts.push(a.verdict === 'inconclusive' ? { kind: 'proof', runId: a.runId, parts: { ...proofParts(a), evidence: null }, why: rest || a.why } : { kind: 'proof', runId: a.runId, parts: proofParts(a), why: null });
  const where = report ? plantedWhere(report) : null;
  if (gate) parts.push({ kind: 'injection-attempts', totals: { obeyed: gate.obeyed, influenced: gate.influenced, inconclusive: gate.inconclusive, ignored: gate.ignored }, where: where?.where ?? null, each: where?.each ?? null, command: commandLine(['injection', golden, '--html', 'report.html']), security: report && gate.resultId ? { resultId: gate.resultId, runId: report.runId } : null });
  const call = a ? (a.evidence.find((e) => e.kind === 'canary') ?? a.evidence[0])?.callNo ?? a.readAt ?? a.forkedAt : null;
  const open = a && i.store.getRun(a.runId) ? { label: failed ? 'Open proof' : 'Open attempt', href: links.run(a.runId, call) } : null;
  return { head: [capitalised(head)], sub: [], parts, hint: failed ? { key: 'injection' } : { key: 'injection-inconclusive', why: injectionWhy(reason) }, open };
}

/** What a report opens: the result's own run while the store keeps it, a golden of several attempts' as its failing attempt. */
function openOf({ r, replay }: From): GoldenReport['open'] {
  if (!r.runId || !replay) return null;
  return { label: (r.data?.attempts?.total ?? 1) > 1 ? 'Open failing attempt' : 'Open run', href: links.run(r.runId) };
}

/** Which of Tests' lists a golden that didn't pass is in, with its view there. */
export type Listed = { kind: 'divergence'; view: DivergenceView } | { kind: 'failure'; view: FailureView } | { kind: 'inconclusive'; view: InconclusiveView };

function partsOf(f: From, listed: Listed): Built {
  const built = builtOf(f, listed);
  // A connection the guard blocked is what the agent tripped on, whatever failed after it.
  const blocked = listed.kind === 'failure' ? listed.view.blocked : null;
  return blocked?.length ? { ...built, hint: { key: 'blocked', hosts: blocked } } : built;
}

/** A golden of several attempts reads by its attempts whatever they failed on; one attempt, by what it failed on. */
function builtOf(f: From, listed: Listed): Built {
  if (listed.kind === 'divergence') return divergenceParts(f, listed.view);
  if (f.r.failure === 'injection') return injectionParts(f.r, f.i, f.row.path);
  const attempts = attemptsParts(f);
  if (attempts) return attempts;
  if (f.r.failure === 'exit') return crashParts(f);
  if (listed.kind === 'failure') return failureParts(f, listed.view);
  return inconclusiveParts(f, listed.view);
}

/** One golden's report, from its last result (read again by key, its run once) and the page's view of it. */
export function goldenReport(row: GoldenRow, listed: Listed, i: ReportInput): GoldenReport | null {
  const r = i.store.listTestResults({ golden: row.path, limit: 1 })[0];
  if (!r || r.ok) return null;
  const verdict = testResultVerdict(r);
  if (verdict === 'passed') return null;
  const from: From = { r, row, i, recording: i.goldens.find((g) => g.path === row.path)?.runId ?? null, replay: r.runId ? i.store.getRun(r.runId) : null };
  const built = partsOf(from, listed);
  // Its checks changed since, by the row's one rule (tests-checks.ts' checksChanged): its step's hint says what to do (withStepHints).
  const gone = row.changed;
  if (gone) {
    built.parts.unshift({ kind: 'checks-changed', gone });
    built.sub = ['its last test, before its checks changed'];
  }
  const answered = listed.kind === 'inconclusive' ? null : listed.view;
  if (answered?.found) built.parts.push({ kind: 'commit', found: answered.found });
  else if (answered?.missed) built.parts.push({ kind: 'missed', missed: answered.missed });
  const sub = [r.data?.updated ? `updated${r.revision ? ` at ${r.revision}` : ''}` : null, ...built.sub].filter((s): s is string => !!s);
  return { golden: row.path, name: row.name, verdict, head: built.head, sub, parts: built.parts, open: built.open !== undefined ? built.open : openOf(from), failedRuns: null, hint: built.hint, printed: printedLines(row.name, r) };
}

/**
 * A report for each golden that didn't pass, by its path: those Tests lists under the table, in its
 * order. A report that fails to build is left out, never the page.
 */
export function goldenReports(view: TestsView, i: ReportInput): Record<string, GoldenReport> {
  const reports: Record<string, GoldenReport> = {};
  const listed: Listed[] = [...view.divergences.map((v) => ({ kind: 'divergence' as const, view: v })), ...view.failures.map((v) => ({ kind: 'failure' as const, view: v })), ...view.inconclusive.map((v) => ({ kind: 'inconclusive' as const, view: v }))];
  for (const l of listed) {
    const row = view.rows.find((x) => x.path === l.view.golden);
    if (!row) continue;
    try {
      const report = goldenReport(row, l, i);
      if (report) reports[l.view.golden] = report;
    } catch {
      // Left out: the row and its old lines still show.
    }
  }
  return reports;
}

/** Every golden's failed replays: its test replays under Failed, whatever its name. */
const FAILED_REPLAYS = 'type:test';

/** Runs' filter for a golden's failed replays: its test replays, whose about line is its name, under Failed. Quoted where the name holds a space. */
const failedRunsQuery = (name: string): string => `${FAILED_REPLAYS} ${/\s/.test(name) ? `"${name}"` : name}`;

/** Where Failed runs → opens: Runs' Failed view of the golden's replays, where the link opens its issue. */
export const failedRunsHref = (name: string): string => links.runs({ q: failedRunsQuery(name), types: 'failed' });

/** Each golden's failed replays, by its path: how many, and the first five, newest first. */
export type GoldenRunsJob = { kind: 'tests-failed-runs'; goldens: string[]; outcome?: OutcomeWork | null };

/**
 * The pooled read: each golden's own failed replays, the test replays Runs lists under Failed (the
 * same filter and judge as runs-list.ts) whose test is that golden (`meta.test.golden`), as the
 * golden's issue there holds them. Never Runs' word search, which matches a run's command too, so a
 * golden named as the agent's file would count every replay. A replay a fix's failing runs list,
 * open or closed, is under that fix's issue (issues.ts), so it isn't counted. Every run's index row
 * is read once: never on the server's thread. A golden with none is left out.
 */
export const GOLDEN_REPORT_READS: ReadTable<GoldenRunsJob> = {
  'tests-failed-runs': (store, job, { whole }) => {
    const asked = new Set(job.goldens);
    const found = new Map<string, { count: number; ids: string[] }>();
    const failed = matchingRuns(store, { q: FAILED_REPLAYS, types: ['failed'], known: !whole, judge: judgeFor(store, job.outcome ?? null) });
    const index = loadRunIndex(store);
    for (const r of failed) {
      const golden = r.meta.test?.golden;
      if (golden === undefined || !asked.has(golden) || issueKeyOf(store, index, r.runId) !== issueKey.golden(golden)) continue;
      const runs = found.get(golden) ?? { count: 0, ids: [] };
      runs.count += 1;
      if (runs.ids.length < 5) runs.ids.push(r.runId);
      found.set(golden, runs);
    }
    return answer(Object.fromEntries(found));
  },
};

/** The hint of a golden whose step is its checks' (check-steps.ts), which says what to do in place of its last test's. */
const STEP_HINTS: Partial<Record<string, HintKey>> = { 'run-tests': { key: 'checks-changed' }, 'edit-check': { key: 'edit-check' } };

/**
 * The reports with the hint of each golden whose checks lead it, from its step, never from the gone
 * list alone: Run tests where its checks changed since (its last test judged checks the config no
 * longer holds), Edit check where its own recording fails a check added since. Without the steps,
 * each keeps its last test's.
 */
export function withStepHints(reports: Record<string, GoldenReport>, steps: Record<string, { key: string }> | undefined): Record<string, GoldenReport> {
  const out: Record<string, GoldenReport> = {};
  for (const [golden, report] of Object.entries(reports)) {
    const hint = STEP_HINTS[steps?.[golden]?.key ?? ''];
    out[golden] = hint ? { ...report, hint } : report;
  }
  return out;
}

/** The reports with each golden's own failed replays, where its step isn't a fix: a fix's failing runs are its fix's, which Open fix leads to. */
export function withFailedRuns(reports: Record<string, GoldenReport>, runs: Record<string, { count: number; ids: string[] }> | null, steps: Record<string, { key: string }> | undefined): Record<string, GoldenReport> {
  const out: Record<string, GoldenReport> = {};
  for (const [golden, report] of Object.entries(reports)) {
    const found = runs?.[golden];
    out[golden] = found && steps?.[golden]?.key !== 'fix' ? { ...report, failedRuns: { href: failedRunsHref(report.name), ...found } } : report;
  }
  return out;
}
