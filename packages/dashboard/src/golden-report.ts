import { relative, isAbsolute, resolve } from 'node:path';
import { checkLine, checkStatus, firstSentence, formatPassK, injectionTemplates, parseTraceback, plural, proofHead, proofLine, rateBound, safe, safeLines, testResultVerdict, type AttemptReport, type InjectionGateData, type InjectionReport, type ParsedTraceback, type PlantReport, type StoreOf, type StoredCheck, type TestResult } from '@shadowlap/engine';
import { commandLine, shortFailure } from './fix-shared.js';
import { links } from './links.js';
import { answer, type ReadTable } from './read-registry.js';
import { judgeFor, type OutcomeWork } from './run-outcome.js';
import { matchingRuns } from './runs-list.js';
import type { BisectMiss, FoundCommit } from './tests-bisect.js';
import { causeOf, divergenceOf } from './tests-normalize.js';
import type { DivergenceView, FailureView, GoldenRow, GoldenSource, InconclusiveView, TestsView } from './tests.js';

/**
 * A golden's report drawn rather than printed (Tests, under the golden's row): its verdict in one
 * sentence, a grey line of what no part says, and its parts (Replay, Error, Checks, Gate, Attempts,
 * First bad commit, Checks changed), each from the golden's last result read by key; with its lines
 * as `shadowlap test` prints them, for Show as printed and Copy report.
 *
 * Every word the CLI also prints comes from the engine helper or the stored text that words it
 * (`checkLine`, `formatPassK`, `rateBound`, the result's reason); the browser words only the hint,
 * from its key (ui/tests/report-words.ts). GET /api/tests answers on the server's thread, so nothing
 * here reads every run or every call: a run, a call and a session by key, and a golden's own results.
 */

/** A sentence in pieces: paths, checks and files are code. */
export type Piece = string | { code: string };

/** How a printed line is coloured: the golden's line red or amber, a value before red, after lime, the agent's lines dim. */
export type ReportTone = '' | 'no' | 'del' | 'add' | 'dim' | 'y';
export interface ReportLine {
  text: string;
  tone: ReportTone;
}

export type ReportPart =
  /** The golden's checks that left the config since its last test, which it failed or couldn't decide. */
  | { kind: 'checks-changed'; gone: Array<{ label: string; status: 'failed' | 'inconclusive' }> }
  /** The replay against its recording, as the mini strip draws a run: `recorded` cells, `replayed` of them replayed, `stop` the call it stopped at. */
  | { kind: 'replay'; recorded: number; replayed: number; stop: number | null; words: string }
  /** A crash: the exception it died of, the file it was raised in (in the project where it can be), and the lines it printed last. */
  | { kind: 'error'; error: ParsedTraceback; file: string | null; lines: string[] }
  /** Which of the row's checks to draw, in the row's order: the row's own component draws them. */
  | { kind: 'checks'; labels: string[] }
  /** A gate's figures: the row's `last.gate`, with its bound and, where inconclusive, its pass^5, in the engine's words. */
  | { kind: 'gate'; bound: string | null; passK: string | null }
  /** The attempts, read when the report opens: the check they failed and only what the verdict doesn't say, the attempts carried over, where they forked. */
  | { kind: 'attempts'; check: { label: string; detail: string } | null; carried: { count: number; at: number | null } | null; forked: number | null }
  | { kind: 'commit'; found: FoundCommit }
  | { kind: 'missed'; missed: BisectMiss }
  /** An injection gate's proof: the attempt it is, the engine's line of it (each `#n` a call of that attempt), and, for an attempt that showed nothing, why. */
  | { kind: 'proof'; runId: string; line: string; why: string | null }
  /** What an injection gate's attempts did, by verdict; where they were planted, while the kept result says; the command that writes every attempt. */
  | { kind: 'injection-attempts'; totals: { obeyed: number; influenced: number; inconclusive: number; ignored: number }; where: string | null; each: string | null; command: string; /** The kept result Security report writes, while the store has it. */ resultId: string | null };

/**
 * The hint under a report's next steps, by what the report is: the browser words it in one sentence
 * of why (ui/tests/report-words.ts), with what it needs (a judge's name, the hosts a guard blocked).
 */
export type HintKey =
  | { key: 'normalizer' }
  | { key: 'rules-added'; path: string; update: boolean }
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
  | { key: 'error' };

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
  /** Runs' Failed view of the golden's failed replays, with how many and the first five ids; null where there are none, or its step is a fix. */
  failedRuns: { href: string; count: number; ids: string[] } | null;
  hint: HintKey | null;
  /** The report as `shadowlap test` prints it. */
  printed: ReportLine[];
}

/** GET /api/tests's answer: the page's view, and each golden that didn't pass with its report. */
export type TestsAnswer = TestsView & { reports?: Record<string, GoldenReport> };

/**
 * How many attempts a judge check was asked live in, and what that cost: the result's judge summary
 * (every attempt) when it is the result's only judge check and every judge model in it has a price;
 * else, for a result of one attempt, the check's own call. Null for a verdict from the recording,
 * which is free, and when the cost isn't known. The one place Tests counts a judge's asks, the row's
 * and the report's alike, so asking judges only where an attempt passed its other checks changes it here.
 */
export function judgeAsked(r: TestResult, c: StoredCheck): { cost: number; asked: number } | null {
  if (c.source !== 'live' || !c.judge) return null;
  const s = r.data?.judge;
  const judges = (r.data?.checks ?? []).filter((x) => x.judge).length;
  if (s && judges === 1 && s.live > 0 && !s.unknownModels.length) return { cost: s.spent, asked: s.live };
  return (r.data?.attempts?.total ?? 1) <= 1 && c.judge.cost !== null ? { cost: c.judge.cost, asked: 1 } : null;
}

/** The lines `shadowlap test` prints of a golden's output: its last 20, as the CLI's outputTail takes them. */
function outputTail(output: string | undefined): string | null {
  const t = (output ?? '').trim();
  return t ? t.split('\n').slice(-20).join('\n') : null;
}

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
  const tail = r.failure === 'injection' || data.injection ? null : outputTail(data.output);
  if (tail) out.push(...lines(safeLines(tail, '    │ '), () => 'dim'));
  return out;
}

const upstream = (r: TestResult): string | null => (r.data?.upstreamRequests === undefined ? null : plural(r.data.upstreamRequests, 'upstream request'));

/** The calls of the recording a replay ran against: the replay's own count where it kept one, else the recording's last call. */
function recordedCalls(store: StoreOf<'recording'>, r: TestResult, recording: string | null): number | null {
  const replay = r.runId ? store.getRun(r.runId) : null;
  if (replay?.divergence?.recorded) return replay.divergence.recorded;
  if (!recording || !store.getRun(recording)) return null;
  const last = store.nextCallNo(recording) - 1;
  return last > 0 ? last : null;
}

/** A divergence's sentence: the call, then what changed there, its path as code and what it looks like; a second path after `and`. */
function divergenceHead(r: TestResult, d: NonNullable<ReturnType<typeof divergenceOf>>, normalizers: TestsNormalizers): Piece[] {
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

/** The failed check of a result's shown attempt, as its attempts failed it. */
const failedCheck = (r: TestResult): StoredCheck | null => (r.data?.checks ?? []).find((c) => checkStatus(c) === 'failed') ?? null;

/** What its attempts did, in the short words Fixes names them in: `send_email called twice`. */
const failWords = (c: StoredCheck | null, r: TestResult): string => (c ? shortFailure(c.detail ? `${c.label}, but ${c.detail}` : c.label) : shortFailure(r.reason ?? undefined));

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

/** The project's own name for a file the agent's traceback names: relative where it is inside the folder, else as printed. */
function fileHere(file: string, project: string | null): string {
  if (!project || !isAbsolute(file)) return file;
  const rel = relative(project, resolve(file));
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : file;
}

function crashParts(r: TestResult, i: ReportInput, row: GoldenRow, recording: string | null): Built {
  const code = exitCode(r.reason);
  const replay = r.runId ? i.store.getRun(r.runId) : null;
  const ended = replay?.divergence?.type === 'ended_early' ? replay.divergence : null;
  const head = code === null ? asSentence(r.reason ?? 'the agent exited with an error') : ended ? `The agent exited with code ${code} at call ${ended.callNo}` : `The agent exited with code ${code} after its last call`;
  const parts: ReportPart[] = [];
  const recorded = ended?.recorded ?? recordedCalls(i.store, r, recording);
  if (ended && recorded) parts.push({ kind: 'replay', recorded, replayed: ended.replayedBefore, stop: ended.callNo, words: dot(`${ended.replayedBefore} of ${recorded} recorded calls replayed, then it stopped`, upstream(r)) });
  const error = r.data?.output ? parseTraceback(r.data.output) : null;
  if (error) parts.push({ kind: 'error', error, file: error.raised ? fileHere(error.raised.file, i.project) : null, lines: r.data!.output!.split('\n') });
  if (row.checks.length) parts.push({ kind: 'checks', labels: row.checks });
  return { head: [head], sub: parts.some((p) => p.kind === 'replay') ? [] : [upstream(r)], parts, hint: { key: 'crash' } };
}

const dot = (...words: Array<string | null>): string => words.filter(Boolean).join(' · ');

function divergenceParts(r: TestResult, d: DivergenceView, i: ReportInput, recording: string | null): Built {
  const div = divergenceOf(r);
  if (!div) return { head: [`Diverged at call ${d.callNo}`], sub: [upstream(r)], parts: [], hint: null };
  const parts: ReportPart[] = [];
  const recorded = div.callNo > 1 ? recordedCalls(i.store, r, recording) : null;
  if (recorded) parts.push({ kind: 'replay', recorded, replayed: div.replayedBefore, stop: div.callNo, words: dot(`${div.replayedBefore} of ${recorded} recorded calls replayed, then call ${div.callNo} diverged`, upstream(r)) });
  const hint: HintKey | null = d.rulesAdded && d.volatile ? { key: 'rules-added', path: d.volatile.path, update: !d.normalizerFixes } : d.normalizerFixes ? { key: 'normalizer' } : d.bisect && !d.found && !d.unreadable ? { key: 'bisect' } : null;
  return { head: divergenceHead(r, div, i.normalizers), sub: [recorded ? null : upstream(r)], parts, hint };
}

/** A result's gate, where it decided (or ran out); null where it went on, which decided nothing. */
const decidedGate = (r: TestResult) => (r.data?.gate && r.data.gate.decision !== 'continue' ? r.data.gate : null);

/** Why a gate's verdict is what it is, after its attempts' count; nothing for a fixed count of attempts. */
function gateWhy(gate: ReturnType<typeof decidedGate>): string {
  if (!gate) return '';
  if (gate.decision === 'inconclusive') return ', and its gate ran out before deciding';
  return gate.kind === 'baseline' ? ', a drop against its own history' : ', too often for its gate';
}

/** The Attempts part's words: the check they failed, the attempts carried over and when that session started, where a fork golden's attempts forked. */
function attemptsPart(r: TestResult, row: GoldenRow, i: ReportInput, c: StoredCheck | null): ReportPart {
  const carried = r.data?.continued;
  const newest = carried?.sessions.at(-1);
  const since = newest ? i.store.getTestSession(newest) : null;
  const forked = row.mode === 'fork' ? (r.data?.divergence?.callNo ?? null) : null;
  return { kind: 'attempts', check: c ? { label: c.label, detail: c.detail ?? '' } : null, carried: carried?.attempts ? { count: carried.attempts, at: since?.startedAt ?? null } : null, forked };
}

/** A golden of several attempts, gated or forked a fixed count of times, whose attempts failed a check or whose gate ran out. */
function attemptsParts(r: TestResult, row: GoldenRow, i: ReportInput): Built | null {
  const gate = decidedGate(r);
  const n = gate?.attempts ?? r.data?.attempts?.total ?? 1;
  const inconclusive = gate?.decision === 'inconclusive';
  if (n <= 1 || (r.failure !== 'check' && !inconclusive)) return null;
  const passed = gate?.passes ?? r.data?.attempts?.passed ?? 0;
  const c = failedCheck(r);
  const parts: ReportPart[] = gate ? [{ kind: 'gate', bound: rateBound(gate), passK: inconclusive ? formatPassK(gate) : null }] : [];
  parts.push(attemptsPart(r, row, i, c));
  const others = row.checks.filter((label) => label !== c?.label);
  if (others.length) parts.push({ kind: 'checks', labels: others });
  return { head: [`${failWords(c, r)} in ${n - passed} of ${plural(n, 'attempt')}${gateWhy(gate)}`], sub: [upstream(r)], parts, hint: inconclusive ? { key: 'gate' } : { key: 'check' } };
}

/** An inconclusive check its replay couldn't decide, a judge's most often, with no gate to say more. */
function undecidedParts(r: TestResult, v: InconclusiveView, row: GoldenRow): Built {
  const undecided = (r.data?.checks ?? []).find((c) => checkStatus(c) === 'inconclusive') ?? null;
  const here = undecided ? row.checks.includes(undecided.label) : true;
  const calls = r.data?.calls;
  const head = `Replayed clean, but its ${undecided?.judge ? 'judge check' : 'check'} wasn’t judged${here ? '' : ': the test runs offline'}`;
  const j = v.judge;
  const hint: HintKey = j?.update && j.held ? { key: 'judge', held: j.held, name: j.name } : j?.keys?.length ? { key: 'judge-key', name: j.name, model: j.model, keys: j.keys } : { key: 'undecided' };
  return { head: [head], sub: [calls ? `${calls.replayed} of ${plural(calls.total, 'call')}` : null, upstream(r)], parts: row.checks.length ? [{ kind: 'checks', labels: row.checks }] : [], hint };
}

/** A replay golden that failed a check, made no calls, or was stopped by the guard or an error. */
function failureParts(r: TestResult, f: FailureView, row: GoldenRow, i: ReportInput, recording: string | null): Built {
  if (f.failure === 'check') {
    const c = failedCheck(r);
    const recorded = recordedCalls(i.store, r, recording);
    const parts: ReportPart[] = [];
    if (c && recorded) parts.push({ kind: 'replay', recorded, replayed: recorded, stop: null, words: dot(`${recorded} of ${recorded} calls replayed, clean`, upstream(r)) });
    if (row.checks.length) parts.push({ kind: 'checks', labels: row.checks });
    return { head: c ? ['Check failed: ', { code: c.label }, `, but ${c.detail ?? 'failed'}`] : [asSentence(f.reason)], sub: parts.length && parts[0]!.kind === 'replay' ? [] : [upstream(r)], parts, hint: { key: 'check' } };
  }
  const hint: HintKey = f.blocked?.length ? { key: 'blocked', hosts: f.blocked } : f.failure === 'no-calls' ? { key: 'no-calls' } : f.failure === 'guard' ? (/^The network guard could not watch every process of the agent/.test(f.reason) ? { key: 'unguarded' } : { key: 'no-preload' }) : { key: 'error' };
  return { head: [asSentence(f.reason)], sub: [upstream(r)], parts: row.checks.length && f.checks?.length ? [{ kind: 'checks', labels: row.checks }] : [], hint };
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
  if (a) parts.push(a.verdict === 'inconclusive' ? { kind: 'proof', runId: a.runId, line: proofHead(a), why: rest || a.why } : { kind: 'proof', runId: a.runId, line: proofLine(a) ?? proofHead(a), why: null });
  const where = report ? plantedWhere(report) : null;
  if (gate) parts.push({ kind: 'injection-attempts', totals: { obeyed: gate.obeyed, influenced: gate.influenced, inconclusive: gate.inconclusive, ignored: gate.ignored }, where: where?.where ?? null, each: where?.each ?? null, command: commandLine(['injection', golden, '--html', 'report.html']), resultId: report && gate.resultId ? gate.resultId : null });
  const call = a ? (a.evidence.find((e) => e.kind === 'canary') ?? a.evidence[0])?.callNo ?? a.readAt ?? a.forkedAt : null;
  const open = a && i.store.getRun(a.runId) ? { label: failed ? 'Open proof' : 'Open attempt', href: links.run(a.runId, call) } : null;
  // A sentence that starts with a tool's name keeps it as named.
  const lead = /^(no|the) /.test(head) ? head.charAt(0).toUpperCase() + head.slice(1) : head;
  return { head: [lead], sub: [], parts, hint: failed ? { key: 'injection' } : { key: 'injection-inconclusive', why: injectionWhy(reason) }, open };
}

/** The golden's checks its last result failed or couldn't decide that are no longer in the config. */
function checksGone(r: TestResult, row: GoldenRow): Array<{ label: string; status: 'failed' | 'inconclusive' }> {
  return (r.data?.checks ?? []).flatMap((c) => {
    const status = checkStatus(c);
    return (status === 'failed' || status === 'inconclusive') && !row.checks.includes(c.label) ? [{ label: c.label, status }] : [];
  });
}

/** What a report opens: the result's own run while the store keeps it, a golden of several attempts' as its failing attempt. */
function openOf(store: StoreOf<'recording'>, r: TestResult): GoldenReport['open'] {
  if (!r.runId || !store.getRun(r.runId)) return null;
  return { label: (r.data?.attempts?.total ?? 1) > 1 ? 'Open failing attempt' : 'Open run', href: links.run(r.runId) };
}

/** One golden's report, from its last result (read again by key) and the page's view of it. */
/** Which of Tests' lists a golden that didn't pass is in, with its view there. */
export type Listed = { kind: 'divergence'; view: DivergenceView } | { kind: 'failure'; view: FailureView } | { kind: 'inconclusive'; view: InconclusiveView };

function partsOf(r: TestResult, row: GoldenRow, listed: Listed, i: ReportInput, recording: string | null): Built {
  if (listed.kind === 'divergence') return divergenceParts(r, listed.view, i, recording);
  if (r.failure === 'injection') return injectionParts(r, i, row.path);
  if (r.failure === 'exit') return crashParts(r, i, row, recording);
  const attempts = attemptsParts(r, row, i);
  if (attempts) return attempts;
  if (listed.kind === 'failure') return failureParts(r, listed.view, row, i, recording);
  return undecidedParts(r, listed.view, row);
}

export function goldenReport(row: GoldenRow, listed: Listed, i: ReportInput): GoldenReport | null {
  const r = i.store.listTestResults({ golden: row.path, limit: 1 })[0];
  if (!r || r.ok) return null;
  const verdict = testResultVerdict(r);
  if (verdict === 'passed') return null;
  const recording = i.goldens.find((g) => g.path === row.path)?.runId ?? null;
  const built = partsOf(r, row, listed, i, recording);
  const gone = checksGone(r, row);
  if (gone.length) {
    // Its hint stays its last test's until Run tests leads such a golden, whose hint says so (port/checks-on-tests).
    built.parts.unshift({ kind: 'checks-changed', gone });
    built.sub = ['its last test, before its checks changed'];
  }
  const answered = listed.kind === 'inconclusive' ? null : listed.view;
  if (answered?.found) built.parts.push({ kind: 'commit', found: answered.found });
  else if (answered?.missed) built.parts.push({ kind: 'missed', missed: answered.missed });
  const sub = [r.data?.updated ? `updated${r.revision ? ` at ${r.revision}` : ''}` : null, ...built.sub].filter((s): s is string => !!s);
  return { golden: row.path, name: row.name, verdict, head: built.head, sub, parts: built.parts, open: built.open !== undefined ? built.open : openOf(i.store, r), failedRuns: null, hint: built.hint, printed: printedLines(row.name, r) };
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

/** Runs' filter for a golden's failed replays: its test replays, whose about line is its name, under Failed. Quoted where the name holds a space. */
const failedRunsQuery = (name: string): string => `type:test ${/\s/.test(name) ? `"${name}"` : name}`;

/** Where Failed runs → opens: Runs' Failed view of the golden's replays. */
export const failedRunsHref = (name: string): string => links.runs({ q: failedRunsQuery(name), types: 'failed' });

/** Each golden's failed replays as Runs' Failed view lists them, by its path: how many, and the first five, newest first. */
export type GoldenRunsJob = { kind: 'tests-failed-runs'; goldens: Array<{ golden: string; name: string }>; outcome?: OutcomeWork | null };

/**
 * The pooled read: the runs Failed runs → opens, matched as Runs matches them (runs-list.ts
 * `matchingRuns`, the same filter and the same judge), so the count is what the link opens. It reads
 * every run's index row, so never on the server's thread. A golden with none is left out.
 */
export const GOLDEN_REPORT_READS: ReadTable<GoldenRunsJob> = {
  'tests-failed-runs': (store, job, { whole }) => {
    const judge = judgeFor(store, job.outcome ?? null);
    const found: Record<string, { count: number; ids: string[] }> = {};
    for (const g of job.goldens) {
      const runs = matchingRuns(store, { q: failedRunsQuery(g.name), types: ['failed'], known: !whole, judge });
      if (runs.length) found[g.golden] = { count: runs.length, ids: runs.slice(0, 5).map((r) => r.runId) };
    }
    return answer(found);
  },
};

/** The reports with Runs' count of each golden's failed replays, where its step isn't a fix: a fix's failing runs are its fix's, which Open fix leads to. */
export function withFailedRuns(reports: Record<string, GoldenReport>, runs: Record<string, { count: number; ids: string[] }> | null, steps: Record<string, { key: string }> | undefined): Record<string, GoldenReport> {
  const out: Record<string, GoldenReport> = {};
  for (const [golden, report] of Object.entries(reports)) {
    const found = runs?.[golden];
    out[golden] = found && steps?.[golden]?.key !== 'fix' ? { ...report, failedRuns: { href: failedRunsHref(report.name), ...found } } : report;
  }
  return out;
}
