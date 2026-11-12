import { andList, besidesWords, byHandNote, fieldValue, handOf, leftBehindOf, leftOutNote, migrateApplyProblem, migrateCostWords, migrateHeadline, migratePassWords, migrateRules, quoteArgv, remedyText, retirementOf, shortSessionId, verifiedCount, type DecisionCounts, type DecisionRemedy, type DecisionStep, type MigrateCosts, type MigrateTone, type RetirementNotice, type Store } from '@shadowlap/engine';
import { applyInputOf, type AppliedState } from './migrate-applied.js';
import type { VerdictTone } from './verdict.js';

/**
 * A migration as Changes › Migrate shows it, worded here from the engine's words (migrate-words.ts,
 * verified-words.ts), since a page can't load the engine: the word and the headline, the switch and
 * the retirement lines, What changes, What still passes with the goldens the switch leaves behind,
 * what it costs, What to set, the config change, the pull request, whether Apply config change is
 * offered and why not, the applied state and the one next step. Words that name code say it between
 * backticks, for the page to set as code.
 */

const tick = (s: string) => `\`${s}\``;

/** A step What changes lists: a write, stop or judged change, with the recorded and the new action. */
export interface MigrateChange {
  runId: string;
  golden: string | null;
  callNo: number;
  rank: number;
  detail: string;
  /** The arguments that changed, else `recorded → now`. */
  lines: string[];
}

/** A run under What still passes: its verdict, how it came to it, and the note of a golden the switch leaves behind. */
export interface MigratePass {
  runId: string;
  golden: string | null;
  verdict: string;
  words: string;
  /** `diverges at #1 on `$.model` once applied`, or `until updated` once applied while it waits; null otherwise. */
  leftBehind: string | null;
}

export interface MigrateApplyOffer {
  /** The config change's files, as the dialog's first step says them. */
  files: string[];
  /** The fields the patch takes out with the model. */
  leftOut: string[];
  /** The goldens it leaves behind, each with the call it diverges at. */
  leftBehind: Array<{ golden: string; callNo: number }>;
  /** Why the goldens it doesn't leave behind stay as recorded, Diverges' quiet line (`1 marked fork passes on its checks, 2 never send claude-opus-5`); null when none says. */
  stays: string | null;
  /** What the job runs. */
  command: string;
}

export interface MigrateView {
  sessionId: string;
  from: string[];
  to: string;
  /** `applied`, else Verdicts' word for the migration. */
  word: { text: string; tone: VerdictTone | null };
  headline: { tone: MigrateTone; text: string; rest: string };
  /** Each from-model's retirement, worded today (the kept words where the table no longer has it). */
  retirements: Array<{ text: string; source: string | null }>;
  changes: { sub: string; steps: MigrateChange[]; none: string | null; besides: string | null };
  passes: { runs: MigratePass[]; rules: Array<{ rule: string; runs: string[] }>; verified: string; notVerified: string | null; notes: string[] };
  costs: { perRun: string; endToEnd: string | null; checking: string };
  set: { sub: string; fields: Array<{ text: string; why: string }>; given: string[]; only: string | null; flags: string | null };
  config: { sub: string; files: Array<{ path: string; places: number; leftOut: string[] }>; patch: string | null; leftOut: string | null; byHand: string | null; noFile: string | null; review: Array<{ path: string; line: number; text: string }>; apply: string | null };
  pullRequest: { title: string; body: string; gh: string | null } | null;
  /** Apply config change, offered, or why not. */
  apply: MigrateApplyOffer | { why: string };
  applied: AppliedState | null;
  /** `3 goldens to update under <to>: a, b and c` while any waits. */
  appliedLine: string | null;
  next: 'apply' | 'update' | 'copy-pull-request' | null;
  command: string;
  warnings: string[];
  notes: string[];
}

type Kept = Record<string, unknown>;
const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const strings = (v: unknown): string[] => list<unknown>(v).filter((x): x is string => typeof x === 'string');
/** What a migration kept before it priced anything says it cost: nothing known. */
const NO_COSTS: MigrateCosts = { perRun: { before: null, after: null }, tokensPerRun: { before: 0, after: 0 }, endToEnd: null, checking: { decisions: 0, judge: 0, verify: 0 } };
const NO_FILE = /^No string in the project's code or config names /;
const REVIEW = /^\d+ other mentions? of /;

function changesOf(k: Kept, decisions: { counts?: DecisionCounts; runs?: Array<{ decisions: DecisionStep[] }> }, from: string[], to: string): MigrateView['changes'] {
  const steps = list<MigrateChange & { arguments?: string[]; recorded?: string; now?: string }>((k.changes as Kept | undefined)?.steps).map((s) => ({ runId: s.runId, golden: s.golden ?? null, callNo: s.callNo, rank: s.rank, detail: s.detail, lines: s.arguments?.length ? s.arguments : [`${s.recorded ?? ''} → ${s.now ?? ''}`] }));
  const c = decisions.counts;
  return {
    sub: `the calls made with ${from.join(', ') || 'the model'}, asked under ${to}`,
    steps,
    none: steps.length ? null : `No write, stop or judged change${c?.notAsked ? ' in the steps asked' : ''}.`,
    besides: c && c[3] + c[4] + c[5] ? `besides: ${besidesWords({ counts: c, runs: decisions.runs ?? [] })}` : null,
  };
}

type PassRun = Parameters<typeof migratePassWords>[0] & { runId: string; golden: string | null; diverges?: { callNo: number } | null; stays?: 'fork' | 'no-call' };

function passesOf(runs: PassRun[], k: Kept, applied: AppliedState | null): MigrateView['passes'] {
  const verify = (k.decisions as { verify?: { verdict?: string; rule?: string | null; reasons?: string[]; warnings?: string[] } | null } | undefined)?.verify ?? null;
  const waiting = new Map((applied?.outdated ?? []).map((g) => [g.golden, g]));
  const name = (x: { runId: string; golden: string | null }) => x.golden ?? x.runId;
  return {
    runs: runs.map((x) => {
      const after = x.golden ? waiting.get(x.golden) : undefined;
      const leftBehind = applied ? (after?.waits ? `diverges at #${after.callNo} on ${tick('$.model')} until updated` : null) : x.diverges ? `diverges at #${x.diverges.callNo} on ${tick('$.model')} once applied` : null;
      return { runId: x.runId, golden: x.golden, verdict: x.verdict, words: migratePassWords(x), leftBehind };
    }),
    rules: migrateRules(runs.map((x) => ({ ...x, tally: x.tally as { rule?: string | null } | null })), verify?.rule ?? null).map((g) => ({ rule: g.rule, runs: g.runs.map(name) })),
    verified: verifiedCount(runs),
    notVerified: verify?.verdict === 'not-run' && verify.reasons?.length ? `Not verified yet: ${verify.reasons.join('; ')}.` : null,
    notes: strings(verify?.warnings),
  };
}

function setOf(k: Kept, to: string): MigrateView['set'] {
  const set = (k.set ?? {}) as { fields?: DecisionRemedy[]; given?: Record<string, unknown>; flags?: string[] };
  const fields = list<DecisionRemedy>(set.fields);
  const given = Object.entries(set.given ?? {});
  return {
    sub: `each field ${to} refuses, and what it takes instead`,
    fields: fields.map((f) => ({ text: remedyText(f, tick), why: f.why })),
    given: given.map(([field, v]) => `${tick(field)} = ${tick(fieldValue(v))}, as given`),
    only: fields.length || given.length ? null : `Only the model: ${to}`,
    flags: strings(set.flags).length ? `verify takes them as: ${strings(set.flags).join(' ')}` : null,
  };
}

function configOf(k: Kept, notes: string[], applied: AppliedState | null): MigrateView['config'] {
  const c = k.configChange as { files?: Array<{ path: string; places: number }>; leftOut?: Array<{ field: string; path: string }>; review?: Array<{ path: string; line: number; text: string }>; patch?: string } | null | undefined;
  const files = list<{ path: string; places: number }>(c?.files);
  const out = list<{ field: string; path: string }>(c?.leftOut);
  const takenOut = [...new Set(out.map((x) => x.field))];
  const input = applyInputOf(k);
  const hand = handOf(input.set);
  const places = files.reduce((n, f) => n + f.places, 0);
  const patch = input.files?.patch ?? null;
  return {
    sub: files.length ? `${files.map((f) => tick(f.path)).join(', ')} · ${places} place${places === 1 ? '' : 's'}${applied ? ' · applied' : ''}` : 'no file names the model',
    files: files.map((f) => ({ path: f.path, places: f.places, leftOut: [...new Set(out.filter((x) => x.path === f.path).map((x) => x.field))] })),
    patch: typeof c?.patch === 'string' && c.patch ? c.patch : null,
    leftOut: files.length && takenOut.length ? leftOutNote(takenOut, tick) : null,
    byHand: files.length && hand.length ? byHandNote(hand, tick) : null,
    noFile: notes.find((n) => NO_FILE.test(n)) ?? null,
    review: list<{ path: string; line: number; text: string }>(c?.review),
    apply: files.length && patch ? quoteArgv(['git', 'apply', patch]) : null,
  };
}

/** Apply config change: offered where migrate apply would take it, with what its dialog shows; else why not, in migrate apply's words. */
function applyOf(k: Kept, runs: PassRun[]): MigrateView['apply'] {
  const input = applyInputOf(k);
  const why = migrateApplyProblem(input);
  if (why) return { why };
  const { left } = leftBehindOf(runs);
  const out = list<{ field: string }>((k.configChange as Kept | null | undefined)?.leftOut);
  return {
    files: list<{ path: string }>(input.configChange?.files).map((f) => f.path),
    leftOut: [...new Set(out.map((x) => x.field))],
    leftBehind: left,
    stays: staysWords(runs, strings(k.from)),
    command: quoteArgv(['shadowlap', 'migrate', 'apply', shortSessionId(input.migrateId!)]),
  };
}

/** Why the goldens a switch leaves alone stay as recorded, as migrate marked them: those marked fork, then those that never send a from-model. */
function staysWords(runs: PassRun[], from: string[]): string | null {
  const n = (why: PassRun['stays']) => runs.filter((x) => x.golden && x.stays === why).length;
  const fork = n('fork');
  const none = n('no-call');
  const parts = [fork ? `${fork} marked fork ${fork === 1 ? 'passes on its checks' : 'pass on their checks'}` : '', none ? `${none} never ${none === 1 ? 'sends' : 'send'} ${from.join(' or ')}` : ''];
  return parts.filter(Boolean).join(', ') || null;
}

/** Each from-model's retirement in today's words (the table's, by the provider and model migrate read), its kept words where the table no longer has it. */
function retirementsOf(k: Kept, from: string[], now: number): MigrateView['retirements'] {
  return list<RetirementNotice>(k.retirements)
    .filter((n) => from.includes(n.model))
    .map((n) => {
      const today = retirementOf(n.provider, n.model, { now });
      return { text: today?.text ?? n.text, source: (today ?? n).source ?? null };
    });
}

/** A kept migration (its report, its decisions' runs filled in) as the page shows it; `verdict`, Verdicts' word for it. */
export function migrateView(_store: Store, k: Kept & { applied?: AppliedState | null }, sessionId: string, verdict: { word: string; tone: VerdictTone | null }, now = Date.now()): MigrateView {
  const from = strings(k.from);
  const to = typeof k.to === 'string' ? k.to : '';
  const decisions = (k.decisions ?? {}) as { counts?: DecisionCounts; runs?: Array<{ decisions: DecisionStep[] }> };
  const runs = list<PassRun>((k.passes as Kept | undefined)?.runs);
  const applied = k.applied ?? null;
  const notes = strings(k.notes);
  const input = applyInputOf({ ...k, sessionId });
  const waiting = (applied?.outdated ?? []).filter((g) => g.waits);
  const apply = applyOf({ ...k, sessionId }, runs);
  const pr = k.pullRequest as { title?: string; body?: string } | undefined;
  const prPath = input.files ? (k.files as { pullRequest?: string } | null)?.pullRequest ?? null : null;
  return {
    sessionId,
    from,
    to,
    word: applied ? { text: 'applied', tone: 'ok' } : { text: verdict.word, tone: verdict.tone },
    headline: migrateHeadline({ from, to, runs: list(decisions.runs).length, passes: input.passes }),
    retirements: retirementsOf(k, from, now),
    changes: changesOf(k, decisions, from, to),
    passes: passesOf(runs, k, applied),
    costs: migrateCostWords((k.costs ?? NO_COSTS) as MigrateCosts, { judged: !!(k.decisions as { judge?: unknown } | undefined)?.judge, unknown: [...new Set([...strings((k.decisions as { cost?: { unknownModels?: unknown } } | undefined)?.cost?.unknownModels), ...strings((k.decisions as { judge?: { unknownModels?: unknown } | null } | undefined)?.judge?.unknownModels)])] }),
    set: setOf(k, to),
    config: configOf(k, notes, applied),
    pullRequest: pr?.title && pr.body ? { title: pr.title, body: pr.body, gh: prPath ? quoteArgv(['gh', 'pr', 'create', '--title', pr.title, '--body-file', prPath]) : null } : null,
    apply,
    applied,
    appliedLine: waiting.length ? `${waiting.length} golden${waiting.length === 1 ? '' : 's'} to update under ${to}: ${andList(waiting.map((g) => g.golden))}` : null,
    next: applied ? (waiting.length ? 'update' : 'copy-pull-request') : 'files' in apply ? 'apply' : null,
    command: typeof k.command === 'string' ? k.command : '',
    warnings: strings(k.warnings),
    notes: notes.filter((n) => !NO_FILE.test(n) && !REVIEW.test(n)),
  };
}
