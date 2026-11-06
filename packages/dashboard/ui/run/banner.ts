import { approx, num, plural } from '../format.js';
import { blameStateWord } from '../../../engine/src/blame-words.js';
import { fencedLabel, toolCheckLabel, toolCountDetail } from '../../../engine/src/checks/labels.js';
import { isObject } from '../../../engine/src/is-object.js';
import { attemptVerdict, checkFailed, FAILURE_WORDS, failureReason, lostWords } from '../../../engine/src/run-verdicts.js';
import { toolFailure } from '../../../engine/src/words.js';
import type { RunType } from '../runs.js';
import { presetWhy, type PresetAttempt } from './preset.js';

/**
 * The run page's own finding: which it is, and what it says. A run has at most one, in this order:
 * recording now; an error-path preset's attempt (the preset it played in); an attempt (the fork
 * blame rescued a run with, a blame probe's, a verify's, a `--repeat`'s: what was asked again and
 * which attempt it is); a test that diverged; a fork (the flag that made it, or what changed, and
 * whether it failed, for Run blame); where blame found the run lost; the checks it passed; that it
 * was interrupted (neutral, as every list says it); or that it failed (with its fix, or Run blame).
 * What it did not record is a finding of its own beside it (findings.ts). How the run came out is the
 * server's state, the one Runs and the Overview read. No DOM here: the tests import it, and
 * `FindingsBar.tsx` draws it.
 */

/** A flag a replay ran with, as the server names it: `--fail-at` and `19=529`, and the call it names. */
/** A blame that placed the failure on no call, in the engine's word for it. */
type BlameState = ReturnType<typeof blameStateWord>;

export interface FlagView {
  flag: string;
  value?: string | null;
  callNo?: number | null;
}

export interface BannerInput {
  status: string;
  type: RunType;
  divergence: {
    callNo: number;
    type: string;
    name: string;
    replayedBefore: number;
    reason?: string;
    hints?: ReadonlyArray<{ message: string; normalizer?: unknown }>;
    diff?: ReadonlyArray<{ path: string }>;
  } | null;
  /** The flag that made the fork, when the server says: `--fail-at` and `19=529`. */
  intervention: FlagView | null;
  /** Every flag the replay ran with (`--writes stub` among them), when the server says. */
  interventions?: readonly FlagView[];
  /** The call the flag names, as the run has it: a tool's name, a model call's retries, a recorded input. */
  flagCall?: { kind: string; name: string; attempts: number; input?: boolean } | null;
  /** A fork blame rescued its parent with: the call it asked again. */
  rescued: { callNo: number | null } | null;
  /** `range`: the two calls it was lost around or between, when no one call is pinned. */
  blame: { callNo: number | null; range?: { from: number; to: number; gradual?: true } | null; modelCall?: { k: number; m: number } | null; confidence?: string | null; scope?: string | null; rescuedRunId?: string | null; outcome?: string | null; unsettled?: boolean; short?: string | null } | null;
  notRecorded: { hosts: ReadonlyArray<{ target: string; count: number | null; action: string | null }>; tools: readonly string[] } | null;
  /** Each check, with its `status` when the server says (passed, failed, inconclusive, not-applicable). */
  checks: ReadonlyArray<{ label: string; ok: boolean; count?: number; of?: number; detail?: string; status?: string }>;
  fix: { id: string; status: string; title: string } | null;
  upstreamRequests: number;
  /** What the run spent live, in dollars, which a test that went live from its fork says. */
  spent?: number;
  /** A test replay whose golden diverged on a value made anew on every run: what it looks like. */
  volatile?: { looks: string } | null;
  /** How many model calls the run made: one that made none has no answer of the model's to blame. */
  modelCalls?: number;
  /**
   * How the run came out, as the server says it for the run list too (`state.outcome`): a test whose
   * golden may fork is judged by its checks, not where it forked; a run a fix lists as failing failed
   * that fix's check. Absent from an older server: the banner works it out from the run.
   */
  outcome?: { kind: string; check?: string | null } | null;
  /** Stopped before it ended, failing nothing else (`state.interrupted`). */
  interrupted?: boolean;
  /** Whether the server counts the run as failed (`state.failed`): when it says not, no failure banner. */
  failed?: boolean;
  /**
   * The run's calls: to say a check as the CLI does, with a tool's fenced calls counted exactly
   * (`send_email called 1 time, but called 2 times (2 blocked)`), and what came before a fork
   * (`15 replayed and #16 overridden before it`).
   */
  calls?: ReadonlyArray<CheckCall & { callNo?: number }>;
  /** How many calls it made, for the interrupted banner. */
  callCount?: number;
  /** An error-path preset's attempt: the preset it played in and how it came out (preset.ts). */
  preset?: PresetAttempt | null;
  /** What made the run an attempt, when it is one: one of a blame probe's, a verify's or a `--repeat`'s attempts. */
  attempt?: AttemptInput | null;
  /** The revision the run ran: a verify attempt's is the code it verified (`· code 35034be`). */
  codeVersion?: string | null;
}

/**
 * An attempt, as its run's record says: a blame probe's (`meta.probe`), a verify's (`meta.verify`), or
 * one of `replay --repeat`'s (`meta.repeat` alone), with its place among the attempts made together.
 */
export interface AttemptInput {
  kind: 'probe' | 'verify' | 'repeat';
  /**
   * Which attempt it is, and how many were made with it, as the server counts them (`attemptPlace`);
   * `n` is null when it isn't known (an older server), and is never the most that could have been
   * made, which a gate that settles early doesn't reach.
   */
  k: number | null;
  n: number | null;
  /** A `--repeat`'s: how many attempts the command asked for (`replay --repeat 5`). */
  count?: number | null;
  /** A probe's: the model call it asked again. */
  callNo?: number | null;
  /** A verify attempt's: the role of the run it replayed under the change. */
  role?: string | null;
  /** How blame or verify judged it, as the record keeps it; a `--repeat`'s is worked out from its checks and exit. */
  verdict?: 'passed' | 'failed' | 'inconclusive' | null;
}

/**
 * How an attempt came out, in the design's words and colours (`em.ok`, `em.no`, `em.inc`): passed,
 * failed, inconclusive, or interrupted, in grey (`n`). `why`: for an inconclusive one, the check
 * that could not be decided, which ends its banner; why one failed is the header's red line.
 */
export interface AttemptOutcome {
  tone: 'ok' | 'no' | 'inc' | 'n';
  text: string;
  why?: string;
}

export type Banner =
  | { kind: 'recording' }
  /** An attempt's banner: where it forked, its verdict word first, then what was done (`presetWhy`), and Tests → for a golden's. */
  | { kind: 'preset'; callNo: number | null; verdict: PresetAttempt['verdict']; why: string; golden: string | null }
  /** `lead`: what the change looks like, or why it came; `why`: what came before it. The outcome says where it diverged. */
  | { kind: 'diverged'; callNo: number; name: string; lead: string; why: string; path: string | null; normalizer: boolean; diff: boolean }
  /**
   * An attempt, in the design's one grammar: its verdict (`outcome`, drawn first in its colour), then
   * `why`: what was asked again with which attempt it is, how the writes after it went, and for one
   * that could not be decided, why. `of` is `rescued` for the fork blame rescued a run with. `callNo`
   * null: the attempt replayed every call from the recording, forking nowhere.
   */
  | { kind: 'attempt'; of: AttemptInput['kind'] | 'rescued'; callNo: number | null; outcome: AttemptOutcome; why: string; flag: string | null; diff: boolean }
  /** `failed`: the fork failed (its check, or its agent's exit), so Run blame applies to it as to any failed run. */
  | { kind: 'fork'; callNo: number; name: string; why: string; flag: string | null; path: string | null; normalizer: boolean; diff: boolean; failed: boolean }
  /** `words`: where blame found the run lost, in the engine's words (lostWords): at the call, or around or between two. */
  | { kind: 'lost'; callNo: number; words: string; why: string; rescuedRunId: string | null }
  | { kind: 'not-recorded'; why: string }
  | { kind: 'checks'; checks: ReadonlyArray<{ label: string; text: string; status?: string }>; why: string | null }
  | { kind: 'interrupted'; why: string }
  /**
   * `label`: how a blame that placed the failure on no call stands, in the engine's word
   * (blameStateWord): `stopped` and `inconclusive` need a look (amber), `not rescued` is a failure.
   */
  /**
   * `lead`: what failed, which the outcome's `check failed` or `exited` stands on, said first in ink; `why`: how its blame
   * stands. A blame that placed the failure on no call says its word as the label instead, the failure in its `why`.
   */
  | { kind: 'failed'; lead?: string; why: string; fix: { id: string; status: string; title: string } | null; blamed: boolean; label?: BlameState };

/** What made a fork diverge, in words. */
export const DIVERGED: Readonly<Record<string, string>> = {
  request_changed: 'a request changed',
  new_call: 'a call the recording never made',
  forced: 'forced live',
  beyond_recording: 'past the end of the recording',
  ended_early: 'stopped before the recording did: no call made after it',
};

const replayedBefore = (n: number) => `${num(n)} ${n === 1 ? 'call' : 'calls'} replayed before it`;

/** `#16`, `#15 and #16`, `#3, #9 and #16`. */
function callList(nos: readonly number[]): string {
  const ns = nos.map((n) => `#${n}`);
  return ns.length > 1 ? `${ns.slice(0, -1).join(', ')} and ${ns.at(-1)!}` : (ns[0] ?? '');
}

/**
 * What came before a fork, from the recording, as the Calls view shows each call: `16 calls replayed
 * before it`, never counting a call an override answered instead of the recording as replayed. The
 * call the banner's flag names already (`tool #16 overridden with --override …`) is left at that:
 * `15 calls replayed before it`, as the design words it; any other is named apart (`15 replayed and
 * #16 overridden before it`). Without the run's calls, the divergence's count alone.
 */
export function beforeFork(d: { callNo: number; replayedBefore: number }, calls?: ReadonlyArray<{ callNo?: number; origin?: string }>, named: number | null = null): string {
  const over = (calls ?? []).filter((c) => c.origin === 'overridden' && c.callNo !== undefined && c.callNo < d.callNo).map((c) => c.callNo!);
  const replayed = Math.max(0, d.replayedBefore - over.length);
  const apart = over.filter((n) => n !== named);
  if (!apart.length) return replayedBefore(replayed);
  return `${num(replayed)} replayed and ${callList(apart)} overridden before it`;
}

/** The flag as the banner names it: `--fail-at 19=529`. */
export function flagText(iv: { flag: string; value?: string | null } | null): string | null {
  if (!iv) return null;
  return iv.value ? `${iv.flag} ${iv.value}` : iv.flag;
}

/** What follows the call number in a flag's value: `529` in `19=529`, `claude-opus-5` in `15:claude-opus-5`. */
const afterCall = (value: string | null | undefined) => (value ?? '').replace(/^\d+[=:]/, '');

/** What a writes policy did after the fork, from the replay's own flags: stubbed, blocked or allowed; null when unknown. */
export function writesWord(flags: readonly FlagView[] | undefined): string | null {
  const w = flags?.find((f) => f.flag === '--writes')?.value;
  return w === 'stub' ? 'writes stubbed' : w === 'block' ? 'writes blocked' : w === 'allow' ? 'writes allowed' : null;
}

/**
 * What a flag did, in the banner's words, with the flag itself in them: "answered with HTTP 529 by
 * --fail-at 19=529 · nothing sent". The call it names says more when the run has it: a tool's name,
 * a model call's retries.
 */
export function flagWhy(iv: FlagView, call: BannerInput['flagCall'], forkName: string | null = null): string {
  const flag = flagText(iv)!;
  const n = iv.callNo ?? null;
  const at = n === null ? '' : `#${n}`;
  // The banner names the call it forked at just before: a flag on that same tool doesn't name it again.
  const named = (name: string | null | undefined) => (name && name !== forkName ? `${name} ` : '');
  switch (iv.flag) {
    case '--inject':
      return `instruction injected${at ? ` at ${at}` : ''} with ${flag}`;
    case '--fail-at':
      if (call?.kind === 'tool') return `${named(call.name)}answered with ${toolFailure(afterCall(iv.value))} by ${flag} · the tool didn’t run`;
      return `answered with HTTP ${afterCall(iv.value) || '?'} by ${flag} · nothing sent${call && call.attempts > 0 ? ` · the SDK tried ${call.attempts + 1} times, then gave up` : ''}`;
    case '--override':
      if (call?.input) return `the user answered ${at || 'the call'} differently with ${flag}`;
      return `${at ? `tool ${at}` : 'the tool'} overridden with ${flag}`;
    case '--inject-result':
      return `instruction planted in ${at}${call ? ` ${call.name}` : ''} with ${flag}`;
    case '--model':
      return `${afterCall(iv.value) || 'another model'} answers from here with ${flag}`;
    case '--set':
      return `${flag} from here`;
    case '--prompt-from':
      return `your changed prompt from here with ${flag}`;
    case '--diverge-at':
      return `asked again with ${flag}`;
    case '--live-tool':
      return `${iv.value ? named(iv.value) : 'the tool '}forced live with ${flag}`;
    default:
      return flag;
  }
}

/**
 * Where the blamed call sits among the model calls of the blame's scope: model call k of m; for a run
 * lost gradually around two calls, that call and the next, k and k + 1 of m; for one lost between two,
 * from the first's place. Without its place, the calls themselves.
 */
function lostPlace(b: NonNullable<BannerInput['blame']>): string {
  const m = b.modelCall;
  const two = b.range;
  if (!m) return two ? `calls #${two.from} ${two.gradual ? 'and' : 'to'} #${two.to}` : `call #${b.callNo!}`;
  if (two?.gradual && m.k < m.m) return `model calls ${m.k} and ${m.k + 1} of ${m.m}`;
  return `${two ? 'from ' : ''}model call ${m.k} of ${m.m}`;
}

/** Where the blamed call sits (lostPlace), then the confidence, the scope and what asking again did. */
function lostWhy(b: NonNullable<BannerInput['blame']>): string {
  return `${lostPlace(b)}${b.confidence ? ` · confidence ${b.confidence}` : ''}${b.scope ? ` · scope ${b.scope}` : ''}${b.short ? ` · ${b.short}` : ''}`;
}

function notRecordedWhy(nr: NonNullable<BannerInput['notRecorded']>): string {
  const parts: string[] = [];
  if (nr.tools.length) parts.push(`${nr.tools.length === 1 ? '1 tool wasn’t' : `${nr.tools.length} tools weren’t`} wrapped, so their calls aren’t in this recording: ${nr.tools.join(', ')}. A replay would run them for real.`);
  if (nr.hosts.length) {
    const hosts = nr.hosts.map((h) => `${h.target}${h.count !== null || h.action ? ` (${[h.count !== null ? `${num(h.count)}×` : '', h.action ?? ''].filter(Boolean).join(', ')})` : ''}`);
    parts.push(`${nr.hosts.length === 1 ? '1 host was' : `${nr.hosts.length} hosts were`} reached without Shadowlap: ${hosts.join(', ')}. A replay would reach ${nr.hosts.length === 1 ? 'it' : 'them'} for real.`);
  }
  return parts.join(' ');
}

/** A call a check counts, as the run page has it: its kind and name, its arguments in a line, and how it ran. */
export interface CheckCall {
  kind: string;
  name: string;
  detail?: string;
  origin?: string;
}

/** A tool count check as the CLI labels it: `issue_refund with {"amount":240} called 0 times`, `send_email called 1 time`. */
const TOOL_CHECK = /^(\S+?)(?: with (\{.*\}))? called (?:\d|at least |at most )/;

/** Whether a tool call's arguments (its one-line JSON) hold every key and value a check names; null when they can't be read (cut short in its row). */
function argsHold(detail: string | undefined, want: Record<string, unknown>): boolean | null {
  let args: unknown;
  try {
    args = JSON.parse(detail ?? '');
  } catch {
    return null;
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return false;
  return Object.entries(want).every(([k, v]) => JSON.stringify((args as Record<string, unknown>)[k]) === JSON.stringify(v));
}

/** A JSON object a check names its arguments with, or null. */
function argsOf(json: string | undefined): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const v: unknown = JSON.parse(json);
    return isObject(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * The calls of a tool a check counts, as the CLI counts them: every call of it, fenced ones too, and
 * when the check names arguments, those whose arguments hold them. Null when one's arguments can't
 * be read: the count is then the check's own.
 */
function countedCalls(calls: readonly CheckCall[], name: string, args: Record<string, unknown> | null): CheckCall[] | null {
  const named = calls.filter((c) => c.kind === 'tool' && c.name === name);
  if (!args) return named;
  const held = named.map((c) => argsHold(c.detail, args));
  return held.includes(null) ? null : named.filter((_, i) => held[i]);
}

/** A tool's calls fenced after a fork, said exactly: `2 blocked`, `1 stubbed`, `1 blocked, 1 stubbed`; null for none. */
export function fencedWords(calls: ReadonlyArray<Pick<CheckCall, 'origin'>>): string | null {
  return fencedLabel(calls.filter((c) => c.origin === 'blocked').length, calls.filter((c) => c.origin === 'stubbed').length) || null;
}

/**
 * What a run did against a check, as its detail says it, with a tool's calls fenced after a fork
 * counted exactly: a check kept before the CLI told blocked from stubbed says `(2 blocked or
 * stubbed)`, which the run's calls settle (`(2 blocked)`) when they give the same count.
 */
function exactDetail(c: { label: string; detail?: string | null }, calls: readonly CheckCall[] | undefined): string {
  const detail = c.detail ?? '';
  const loose = /\((\d+) blocked or stubbed\)/.exec(detail);
  const tool = TOOL_CHECK.exec(c.label);
  if (!loose || !tool || !calls) return detail;
  if (tool[2] && !argsOf(tool[2])) return detail;
  const counted = countedCalls(calls, tool[1]!, argsOf(tool[2]));
  const fenced = counted?.filter((x) => x.origin === 'blocked' || x.origin === 'stubbed') ?? [];
  const words = fencedWords(fenced);
  return words && fenced.length === Number(loose[1]) ? detail.replace(loose[0], `(${words})`) : detail;
}

/**
 * A failed check in the CLI's words, as `shadowlap test` and blame's attempts print it: what was
 * expected, then what happened, with the arguments it names (`issue_refund with {"amount":240}
 * called 0 times, but called 1 time (1 blocked)`). Given the run's calls, a tool's calls fenced after
 * a fork are counted exactly.
 */
export function failedCheckText(c: { label: string; detail?: string | null }, calls?: readonly CheckCall[]): string {
  return `check failed: ${c.label}${c.detail ? `, but ${exactDetail(c, calls)}` : ''}`;
}

/** How many times a fix's check says a tool is called (`never`, `once`, `twice`, `3 times`, `at least once`, `at most twice`, `1 to 3 times`), as a range. */
function countRange(words: string): { min: number; max: number } | null {
  const one = (w: string): number | null => (w === 'once' ? 1 : w === 'twice' ? 2 : /^\d+ times?$/.test(w) ? parseInt(w, 10) : null);
  if (words === 'never') return { min: 0, max: 0 };
  const least = /^at least (.+)$/.exec(words);
  if (least) {
    const n = one(least[1]!);
    return n === null ? null : { min: n, max: Infinity };
  }
  const most = /^at most (.+)$/.exec(words);
  if (most) {
    const n = one(most[1]!);
    return n === null ? null : { min: 0, max: n };
  }
  const span = /^(\d+) to (\d+) times$/.exec(words);
  if (span) return { min: Number(span[1]), max: Number(span[2]) };
  const n = one(words);
  return n === null ? null : { min: n, max: n };
}

/**
 * The check of the fix a failed run belongs to (`issue_refund never called with {"amount":240}`,
 * `send_email called once`), when the run kept none of its own, in the CLI's words for a check a run
 * failed: its label as `test` and blame print it, then what the run's calls did (`issue_refund with
 * {"amount":240} called 0 times, but called 1 time (1 blocked)`), as the CLI adds to it when a tool
 * was called with other arguments or not at all. A check the run's calls can't settle (arguments cut
 * short in a row, a check of another kind, one the calls here meet) is named as it is, in quotes, so
 * it never reads as what happened.
 */
export function fixCheckText(check: string, calls: readonly CheckCall[]): string {
  const quoted = `check failed: “${check}”`;
  const m = /^(\S+) (?:never called|called (.+?))(?: with (\{.*\}))?$/.exec(check);
  const range = m ? (m[2] === undefined ? { min: 0, max: 0 } : countRange(m[2])) : null;
  if (!m || !range || (m[3] && !argsOf(m[3]))) return quoted;
  const counted = countedCalls(calls, m[1]!, argsOf(m[3]));
  if (!counted) return quoted;
  const n = counted.length;
  if (n >= range.min && n <= range.max) return quoted;
  const args = argsOf(m[3]);
  const detail = toolCountDetail({
    count: n,
    blocked: counted.filter((c) => c.origin === 'blocked').length,
    stubbed: counted.filter((c) => c.origin === 'stubbed').length,
    named: calls.filter((c) => c.kind === 'tool' && c.name === m[1]).length,
    args: Boolean(args),
    tools: [...new Set(calls.filter((c) => c.kind === 'tool').map((c) => c.name))],
  });
  return failedCheckText({ label: toolCheckLabel({ name: m[1]!, count: range, ...(args ? { args } : {}) }), detail });
}

/**
 * Why a run failed, in a few words, for the banner and the line under the run's id; null when it
 * didn't. In the engine's order, which the terminal UI says it in too (failureReason): its own failed
 * check first, then the agent's exit, then the check the server's outcome names (a fix's, for a run
 * the fix lists as failing), then an interruption, then blame's confirmation.
 */
export function failureText(i: Pick<BannerInput, 'status' | 'checks' | 'blame' | 'outcome' | 'calls'>): string | null {
  const reason = failureReason(i);
  if (!reason) return null;
  if (reason.kind === 'check') return failedCheckText(reason.check, i.calls);
  if (reason.kind === 'fix-check') return fixCheckText(reason.check, i.calls ?? []);
  return FAILURE_WORDS[reason.kind];
}

/**
 * A check in the checks banner: what it asks, then for one that did not apply or could not be
 * decided, that and why in a few words (`not applicable · the condition never held`), else how many
 * attempts it held in.
 */
function checkText(c: BannerInput['checks'][number]): string {
  const why = c.detail ? ` · ${c.detail.split(':')[0]!}` : '';
  if (c.status === 'not-applicable') return `${c.label} · not applicable${why}`;
  if (c.status === 'inconclusive') return `${c.label} · inconclusive${why}`;
  return `${c.label}${c.count !== undefined && c.of !== undefined ? ` · ${c.count} of ${c.of}` : ''}`;
}

/** An interrupted run's line: what stopped, and what it kept. */
function interruptedWhy(i: Pick<BannerInput, 'type' | 'callCount'>): string {
  const n = i.callCount ?? null;
  const kept = n === null ? '' : n === 0 ? ' · no call made yet' : ` · ${n === 1 ? 'the call' : `the ${num(n)} calls`} it made ${n === 1 ? 'is' : 'are'} kept`;
  return `stopped before it ended: Ctrl-C, a kill or a crash${kept}`;
}

/** A verify attempt's run, by its role, as `shadowlap verify` names them: target, held-out, good. */
const VERIFY_ROLES: Readonly<Record<string, string>> = { target: 'target', holdout: 'held-out', good: 'good' };

/** A policy for what comes after a fork (`--writes`, `--reads`): how the fork went on, never what made it. */
const isPolicy = (iv: FlagView): boolean => iv.flag === '--writes' || iv.flag === '--reads';

/** The flag that made a replay what it is: the first it ran with that is not a policy for the calls after the fork. */
function madeBy(i: Pick<BannerInput, 'intervention' | 'interventions'>): FlagView | null {
  const all = i.interventions?.length ? i.interventions : i.intervention ? [i.intervention] : [];
  return all.find((x) => !isPolicy(x)) ?? null;
}

/**
 * How an attempt came out, in the verdict words the design leads its banner with: interrupted (grey:
 * it stopped, it did not fail); then the verdict blame or verify kept on it, or for a `--repeat`'s
 * attempt what its checks say, else its exit, as the Forks view's bundle counts it: failed (the line
 * under the run's id says what, in the CLI's words), inconclusive with the check that could not be
 * decided, or passed.
 */
export function attemptOutcome(i: Pick<BannerInput, 'status' | 'checks' | 'interrupted'>, a: Pick<AttemptInput, 'verdict'> = {}): AttemptOutcome {
  const { verdict, unsure } = attemptVerdict(i, a.verdict ?? undefined);
  if (verdict === 'interrupted') return { tone: 'n', text: 'interrupted' };
  if (verdict === 'inconclusive') return unsure ? { tone: 'inc', text: 'inconclusive', why: unsure.label } : { tone: 'inc', text: 'inconclusive' };
  return verdict === 'passed' ? { tone: 'ok', text: 'passed' } : { tone: 'no', text: 'failed' };
}

/**
 * An attempt's banner, in the design's one grammar for every attempt: how it came out, first; then
 * what was asked again (a probe's model call, the change a verify checked and the code it ran, the
 * replay `--repeat` made again) with which attempt it is of how many were made; then how the writes
 * after it went, and for one that could not be decided, why. Never "a request changed" alone: an
 * attempt says why it forked where it did. One that forked nowhere replayed every call from the
 * recording, and says that. The fork blame rescued a run with is the probe's attempt that passed.
 */
function attemptBanner(i: BannerInput, a: AttemptInput | null, rescuedAt: number | null): Banner {
  const d = i.divergence;
  const rescued = rescuedAt !== null || !a;
  // "attempt 2 of 4" and "code 35034be" are each kept whole where the line wraps, as a tally and an id are everywhere.
  const which = a && a.k !== null ? `attempt\u00a0${num(a.k)}${a.n ? `\u00a0of\u00a0${num(a.n)}` : ''}` : null;
  const iv = madeBy(i);
  const how = !d ? 'every call replayed from the recording' : d.type === 'forced' && d.reason ? d.reason : (DIVERGED[d.type] ?? d.type);
  // Where the request changed, as a fork's banner names it: the first path its diff found.
  const where = d?.type === 'request_changed' && d.diff?.[0]?.path ? ` (~ ${d.diff[0].path})` : '';
  let what: string;
  let callNo = d?.callNo ?? null;
  let flag: string | null = null;
  if (!a || a.kind === 'probe') {
    callNo = rescuedAt ?? a?.callNo ?? callNo;
    const asked = callNo !== null ? `#${callNo}` : 'the call';
    what = `${rescued ? 'rescued' : 'resampled'}${callNo !== null ? ` #${callNo}` : ''}${which ? `, ${which}` : ''}: the model was asked ${asked} again, the request as recorded`;
  } else if (a.kind === 'verify') {
    // The change it verified: a flag (`--model`, `--set`) names itself; a change in the code is in the
    // request where the attempt forked, and the code it ran is named.
    const role = VERIFY_ROLES[a.role ?? ''];
    const change = iv ? flagWhy(iv, i.flagCall ?? null, d?.name ?? null) : d?.type === 'request_changed' ? `the change it verified is in the request${where}` : how;
    // One part, held together, as the bundle names it (`verify · target`): a wrapped line never parts it.
    const head = [`verify${role ? `\u00a0· ${role}` : ''}${which ? `, ${which}` : ''}`, i.codeVersion ? `code\u00a0${i.codeVersion}` : null].filter(Boolean).join(' · ');
    what = `${head}: ${change}`;
    flag = iv ? flagText(iv) : null;
  } else {
    // A replay made again: the command and where it forked, then the flag that made it, as its fork
    // banner says it, or what changed.
    const cmd = `replay --repeat${a.count ? ` ${num(a.count)}` : ''}${d ? ` at #${d.callNo}` : ''}`;
    what = `${cmd}${which ? `, ${which}` : ''}: ${iv ? flagWhy(iv, i.flagCall ?? null, d?.name ?? null) : `${how}${where}`}`;
    flag = iv ? flagText(iv) : null;
  }
  // The rescued fork passed, which is what made it the one blame names; its writes were stubbed, as every probe's are.
  const outcome: AttemptOutcome = rescued ? { tone: 'ok', text: 'passed' } : attemptOutcome(i, a);
  const writes = d ? (writesWord(i.interventions) ?? (rescued ? 'writes stubbed' : null)) : null;
  return { kind: 'attempt', of: rescued ? 'rescued' : a.kind, callNo, outcome, why: [what, writes, outcome.why].filter(Boolean).join(' · '), flag, diff: !!d?.diff?.length };
}

/**
 * A test of a golden that may fork went live from where it left the recording, and its checks judged
 * it: where it forked is not what it failed on, so its finding is its checks, or its failure.
 */
function forkedTest(i: Pick<BannerInput, 'type' | 'divergence' | 'outcome'>): boolean {
  return i.type === 'test' && !!i.divergence && !!i.outcome && i.outcome.kind !== 'diverged';
}

/**
 * An error-path preset's attempt says which preset it played in where, in every attempt's grammar:
 * its run alone reads as a healthy fork, the failure being one Shadowlap injected. One that couldn't
 * say says why at its end.
 */
function presetBanner(i: BannerInput, p: PresetAttempt): Banner {
  const writes = writesWord(i.interventions);
  const why = [presetWhy(p), ...(writes ? [writes] : []), ...(p.verdict === 'inconclusive' ? [p.outcome] : [])].join(' · ');
  return { kind: 'preset', callNo: i.divergence?.callNo ?? p.callNo, verdict: p.verdict, why, golden: p.golden };
}

/** A test that left its recording: what the value that changed looks like, or why it came, then what came before it. */
function divergedBanner(i: BannerInput, d: NonNullable<BannerInput['divergence']>): Banner {
  const lead = i.volatile?.looks ? `this looks like ${i.volatile.looks}` : (d.hints?.[0]?.message ?? DIVERGED[d.type] ?? d.type);
  return { kind: 'diverged', callNo: d.callNo, name: d.name, lead, why: beforeFork(d, i.calls), path: d.diff?.[0]?.path ?? null, normalizer: true, diff: !!d.diff?.length };
}

/**
 * A fork: the flag that made it and how the writes after it went, or what changed (a policy for the
 * calls after a fork made no fork: one whose only flag is --writes forked where its request changed),
 * then what came before it; a model call answered with a failure says what the SDK did instead. One
 * that failed its check, or whose agent failed, is blamed as any failed run is.
 */
function forkBanner(i: BannerInput, d: NonNullable<BannerInput['divergence']>): Banner {
  const forced = d.type === 'forced' && d.reason ? d.reason.replace(/^forced live by /, '') : null;
  const iv = madeBy(i);
  const writes = writesWord(i.interventions);
  const what = `${iv ? flagWhy(iv, i.flagCall ?? null, d.name) : (forced ?? DIVERGED[d.type] ?? d.type)}${writes ? ` · ${writes}` : ''}`;
  const failedModelCall = iv?.flag === '--fail-at' && i.flagCall?.kind !== 'tool';
  // An override's or a planted result's flag names its call: what came before the fork doesn't again.
  const named = iv && (iv.flag === '--override' || iv.flag === '--inject-result') ? (iv.callNo ?? null) : null;
  const failed = i.failed ?? failureText(i) !== null;
  return { kind: 'fork', callNo: d.callNo, name: d.name, why: failedModelCall ? what : `${what} · ${beforeFork(d, i.calls, named)}`, flag: flagText(iv) ?? forced, path: d.diff?.[0]?.path ?? null, normalizer: !!d.hints?.some((h) => h.normalizer), diff: !!d.diff?.length, failed };
}

/** Where blame found the run lost, when it placed the failure on a call. */
function lostBanner(b: BannerInput['blame']): Banner | null {
  if (!b || b.callNo === null || b.outcome === 'unrescuable' || b.outcome === 'stopped') return null;
  return { kind: 'lost', callNo: b.callNo, words: lostWords(b.callNo, b.range), why: lostWhy(b), rescuedRunId: b.rescuedRunId ?? null };
}

/** A test of a golden that may fork went live from its fork: what that sent and spent, its writes fenced unless --writes said otherwise. */
function liveFrom(i: BannerInput, callNo: number): string {
  return [`live from #${callNo}`, plural(i.upstreamRequests, 'upstream request'), ...(i.spent !== undefined ? [approx(i.spent)] : []), writesWord(i.interventions) ?? 'writes fenced'].join(' · ');
}

/** No check failed: each says how it came out, one that did not apply or could not be decided too. */
function checksBanner(i: BannerInput): Banner | null {
  if (!i.checks.length || i.checks.some(checkFailed) || i.status !== 'completed') return null;
  const d = i.divergence;
  const why = i.upstreamRequests === 0 ? 'replayed offline · 0 upstream' : forkedTest(i) && d ? liveFrom(i, d.callNo) : null;
  return { kind: 'checks', checks: i.checks.map((c) => ({ label: c.label, text: checkText(c), ...(c.status ? { status: c.status } : {}) })), why };
}

/** How a blame that placed the failure on no call says what it stands on, by its word: the failure, and where blame got to. */
const UNPLACED: Readonly<Record<BlameState, (failure: string) => string>> = {
  stopped: (f) => `${f} · before it found the call`,
  inconclusive: (f) => `${f} · at the first model call`,
  'not rescued': (f) => `from any model call · ${f}`,
};

/**
 * That the run failed, and how its blame stands: its fix; where blame placed the failure on no call
 * (no answer asked again saved the run, its first probe couldn't tell, or it stopped first), which
 * its label says; why a run with no model call or one stopped can't be blamed; or not blamed yet.
 */
function failedBanner(i: BannerInput): Banner | null {
  if (i.failed === false) return null;
  const failure = failureText(i);
  if (!failure) return null;
  const b = i.blame;
  if (b && !i.fix) {
    const label = blameStateWord(b.outcome === 'stopped' ? 'stopped' : 'unrescuable', !!b.unsettled);
    return { kind: 'failed', why: UNPLACED[label](failure), fix: null, blamed: true, label };
  }
  // Blame needs a run that fails again as recorded: one with no model call, or one stopped, never does.
  const unblamable = i.modelCalls === 0 ? 'no model call to blame' : i.status === 'crashed' && !i.checks.some(checkFailed) ? 'blame needs a run that ended on its own' : null;
  const state = i.fix ? (i.fix.status === 'open' ? `no change yet for “${i.fix.title}”` : `fixed: “${i.fix.title}”, ${i.fix.status}`) : (unblamable ?? 'not blamed yet');
  return { kind: 'failed', lead: failure.replace(/^check failed: /, ''), why: state, fix: i.fix, blamed: !!b };
}

/**
 * The run's own finding, every one but what it did not record: recording now, a preset's attempt, an
 * attempt, a test that diverged or a fork, where blame found it lost, the checks it passed, that it
 * was interrupted, or that it failed. The first that applies.
 */
export function ownBanner(i: BannerInput): Banner | null {
  const d = i.divergence;
  if (i.status === 'running') return { kind: 'recording' };
  if (i.preset) return presetBanner(i, i.preset);
  // The fork blame rescued a run with is the attempt of its probe that passed: it says so, as every attempt does.
  if (i.rescued && d) return attemptBanner(i, i.attempt?.kind === 'probe' ? i.attempt : null, i.rescued.callNo ?? d.callNo);
  // An attempt of blame, verify or --repeat is one sample of many: it says so, and how it came out.
  if (i.attempt) return attemptBanner(i, i.attempt, null);
  if (d && !forkedTest(i)) return i.type === 'test' ? divergedBanner(i, d) : forkBanner(i, d);
  return lostBanner(i.blame) ?? checksBanner(i) ?? (i.interrupted ? { kind: 'interrupted', why: interruptedWhy(i) } : null) ?? failedBanner(i);
}

/** What the run did that Shadowlap did not record: a finding of its own, so it never hides the failure after it. */
export function notRecordedBanner(i: Pick<BannerInput, 'notRecorded'>): Banner | null {
  const nr = i.notRecorded;
  return nr && (nr.tools.length || nr.hosts.length) ? { kind: 'not-recorded', why: notRecordedWhy(nr) } : null;
}

/** The run's one finding where a page shows one: its own, else what it did not record. */
export function bannerFor(i: BannerInput): Banner | null {
  return ownBanner(i) ?? notRecordedBanner(i);
}
