import { num } from '../format.js';
import type { RunType } from '../runs.js';

/**
 * The run page's one banner: which it is, and what it says. A run shows at most one, in this order:
 * recording now; a fork blame rescued; a test that diverged; a fork (the flag that made it, or what
 * changed); where blame found the run lost; what was not recorded; the checks it passed; or that it
 * failed (with its fix, or Run blame). No DOM here: the tests import it, and `parts.tsx` draws it.
 */

/** A flag a replay ran with, as the server names it: `--fail-at` and `19=529`, and the call it names. */
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
  blame: { callNo: number | null; modelCall?: { k: number; m: number } | null; confidence?: string | null; scope?: string | null; rescuedRunId?: string | null; outcome?: string | null; short?: string | null } | null;
  notRecorded: { hosts: ReadonlyArray<{ target: string; count: number | null; action: string | null }>; tools: readonly string[] } | null;
  checks: ReadonlyArray<{ label: string; ok: boolean; count?: number; of?: number; detail?: string }>;
  fix: { id: string; status: string; title: string } | null;
  upstreamRequests: number;
  /** A test replay whose golden diverged on a value made anew on every run: what it looks like. */
  volatile?: { looks: string } | null;
  /** How many model calls the run made: one that made none has no answer of the model's to blame. */
  modelCalls?: number;
}

export type Banner =
  | { kind: 'recording' }
  | { kind: 'rescued'; callNo: number | null; why: string }
  | { kind: 'diverged'; callNo: number; name: string; why: string; path: string | null; normalizer: boolean; diff: boolean }
  | { kind: 'fork'; callNo: number; name: string; why: string; flag: string | null; path: string | null; normalizer: boolean; diff: boolean }
  | { kind: 'lost'; callNo: number; why: string; rescuedRunId: string | null }
  | { kind: 'not-recorded'; why: string }
  | { kind: 'checks'; checks: ReadonlyArray<{ label: string; text: string }>; why: string | null }
  | { kind: 'failed'; why: string; fix: { id: string; status: string; title: string } | null; blamed: boolean };

/** What made a fork diverge, in words. */
export const DIVERGED: Readonly<Record<string, string>> = {
  request_changed: 'a request changed',
  new_call: 'a call the recording never made',
  forced: 'forced live',
  beyond_recording: 'past the end of the recording',
};

const replayedBefore = (n: number) => `${num(n)} ${n === 1 ? 'call' : 'calls'} replayed before it`;

/** The flag as the banner names it: `--fail-at 19=529`. */
export function flagText(iv: { flag: string; value?: string | null } | null): string | null {
  if (!iv) return null;
  return iv.value ? `${iv.flag} ${iv.value}` : iv.flag;
}

/** What follows the call number in a flag's value: `529` in `19=529`, `claude-opus-5` in `15:claude-opus-5`. */
const afterCall = (value: string | null | undefined) => (value ?? '').replace(/^\d+[=:]/, '');

/** A tool failure as `--fail-at` gives it: a timeout, an error, or an HTTP status. */
function toolFailure(what: string): string {
  if (/^timeout$/i.test(what)) return 'a timeout';
  if (/^\d{3}$/.test(what)) return `HTTP ${what}`;
  return 'an error';
}

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
export function flagWhy(iv: FlagView, call: BannerInput['flagCall']): string {
  const flag = flagText(iv)!;
  const n = iv.callNo ?? null;
  const at = n === null ? '' : `#${n}`;
  switch (iv.flag) {
    case '--inject':
      return `instruction injected${at ? ` at ${at}` : ''} with ${flag}`;
    case '--fail-at':
      if (call?.kind === 'tool') return `${call.name} answered with ${toolFailure(afterCall(iv.value))} by ${flag} · the tool didn’t run`;
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
      return `${iv.value ?? 'the tool'} forced live with ${flag}`;
    default:
      return flag;
  }
}

function lostWhy(b: NonNullable<BannerInput['blame']>): string {
  const where = b.modelCall ? `model call ${b.modelCall.k} of ${b.modelCall.m}` : `call #${b.callNo}`;
  return `${where}${b.confidence ? ` · confidence ${b.confidence}` : ''}${b.scope ? ` · scope ${b.scope}` : ''}${b.short ? ` · ${b.short}` : ''}`;
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

/** A failed check in the CLI's words: what was expected, and what happened when the run says. */
export function failedCheckText(c: { label: string; detail?: string | null }): string {
  return `check failed: ${c.label}${c.detail ? `, but ${c.detail}` : ''}`;
}

/**
 * A failed check as the line under the run's id says it: what happened. A check's label is what was
 * expected (`send_email called 0 times`) and its detail what the run did (`called 1 time`), so a
 * tool's count reads `send_email called 1 time`; any other check, the CLI's own words.
 */
export function failedCheckShort(c: { label: string; detail?: string | null }): string {
  const did = c.detail?.split(';')[0]?.trim();
  const at = c.label.lastIndexOf(' called ');
  if (did?.startsWith('called ') && at > 0) return `check failed: ${c.label.slice(0, at)} ${did}`;
  return failedCheckText(c);
}

/**
 * The check of the fix a failed run belongs to (`send_email never called`), when the run kept none of
 * its own, as what the run did: a tool's count from the run's calls (`send_email called 1 time`);
 * any other check named as one, so it never reads as what happened.
 */
export function fixCheckShort(check: string, calls: ReadonlyArray<{ kind: string; name: string }>): string {
  const m = /^(\S+) (?:never called|called .+)$/.exec(check);
  if (!m) return `check failed: “${check}”`;
  const n = calls.filter((c) => c.kind === 'tool' && c.name === m[1]).length;
  return `check failed: ${m[1]} called ${n === 1 ? '1 time' : `${num(n)} times`}`;
}

/** Why a run failed, in a few words, for the banner and the line under the run's id; null when it didn't. */
export function failureText(i: Pick<BannerInput, 'status' | 'checks' | 'blame'>, short = false): string | null {
  const failedCheck = i.checks.find((c) => !c.ok);
  if (failedCheck) return short ? failedCheckShort(failedCheck) : failedCheckText(failedCheck);
  if (i.status === 'failed') return 'the agent exited with an error';
  if (i.status === 'crashed') return 'the run was interrupted';
  return i.blame ? 'blame confirmed it fails' : null;
}

export function bannerFor(i: BannerInput): Banner | null {
  const d = i.divergence;
  if (i.status === 'running') return { kind: 'recording' };
  if (i.rescued && d) return { kind: 'rescued', callNo: i.rescued.callNo, why: `a blame attempt that passed: the model was asked ${i.rescued.callNo !== null ? `#${i.rescued.callNo}` : 'the call'} again · ${writesWord(i.interventions) ?? 'writes stubbed'}` };
  if (d) {
    const path = d.diff?.[0]?.path ?? null;
    const diff = !!d.diff?.length;
    if (i.type === 'test') {
      const looks = i.volatile?.looks ? `this looks like ${i.volatile.looks}` : d.hints?.[0]?.message;
      return { kind: 'diverged', callNo: d.callNo, name: d.name, why: `${replayedBefore(d.replayedBefore)}${looks ? ` · ${looks}` : ''}`, path, normalizer: true, diff };
    }
    const forced = d.type === 'forced' && d.reason ? d.reason.replace(/^forced live by /, '') : null;
    const iv = i.intervention;
    // The flag names what the fork changed, and how the writes after it went; a fork without one is a change in the code.
    const writes = iv && iv.flag !== '--writes' ? writesWord(i.interventions) : null;
    const what = iv ? `${flagWhy(iv, i.flagCall ?? null)}${writes ? ` · ${writes}` : ''}` : (forced ?? DIVERGED[d.type] ?? d.type);
    // A model call answered with a failure says what the SDK did instead, as the design's line does; any other fork, what it replayed first.
    const failedModelCall = iv?.flag === '--fail-at' && i.flagCall?.kind !== 'tool';
    return { kind: 'fork', callNo: d.callNo, name: d.name, why: failedModelCall ? what : `${what} · ${replayedBefore(d.replayedBefore)}`, flag: flagText(iv) ?? forced, path, normalizer: !!d.hints?.some((h) => h.normalizer), diff };
  }
  const b = i.blame;
  if (b && b.callNo !== null && b.outcome !== 'unrescuable' && b.outcome !== 'stopped') return { kind: 'lost', callNo: b.callNo, why: lostWhy(b), rescuedRunId: b.rescuedRunId ?? null };
  if (i.notRecorded && (i.notRecorded.tools.length || i.notRecorded.hosts.length)) return { kind: 'not-recorded', why: notRecordedWhy(i.notRecorded) };
  const failedCheck = i.checks.find((c) => !c.ok);
  if (i.checks.length && !failedCheck && i.status === 'completed')
    return {
      kind: 'checks',
      checks: i.checks.map((c) => ({ label: c.label, text: `${c.label}${c.count !== undefined && c.of !== undefined ? ` · ${c.count} of ${c.of}` : ''}` })),
      why: i.type === 'test' || i.upstreamRequests === 0 ? 'replayed offline · 0 upstream' : null,
    };
  const failure = failureText(i);
  if (!failure) return null;
  // Blame ran but placed the failure on no call: no answer asked again saved the run, or it stopped first.
  const unplaced = b ? (b.outcome === 'stopped' ? 'blame stopped before it found the call' : 'blame found no call whose answer, asked again, saves the run') : null;
  const state = i.fix ? (i.fix.status === 'open' ? `no fix yet for “${i.fix.title}”` : `fixed: “${i.fix.title}”, ${i.fix.status}`) : (unplaced ?? (i.modelCalls === 0 ? 'no model call to blame' : 'not blamed yet'));
  return { kind: 'failed', why: `${failure} · ${state}`, fix: i.fix, blamed: !!b };
}
