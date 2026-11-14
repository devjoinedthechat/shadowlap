import { andList, besidesLine, byHandNote, givenField, handOf, leftBehindOf, leftOutNote, migrateApplyProblem, migrateCostLines, migrateHeadline, migratePassWords, migrateRules, noChangeWords, notVerifiedWarning, notVerifiedYet, onlyTheModel, quoteArgv, remedyText, retirementOf, shortSessionId, staysWords, verifiedCount, verifyFlagsLine, type DecisionCounts, type DecisionRemedy, type DecisionStep, type MigrateCosts, type MigrateTone, type RetirementNotice } from '@shadowlap/engine';
import { verifiedOutcome } from './decision-cells.js';
import { strings } from './fields.js';
import { applyInputOf, type AppliedState } from './migrate-applied.js';
import { goldenName } from './needs-look/row.js';
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
  /** `diverges at #1 on `$.model` once applied`, or, once applied while it waits, `until updated` on the field its replay diverged on; null otherwise. */
  leftBehind: string | null;
}

export interface MigrateApplyOffer {
  /** The config change's files, as the dialog's first step says them. */
  files: string[];
  /** The fields the patch takes out with the model, as code: `` `temperature` and `top_p` ``; null for none. */
  leftOut: string | null;
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
  /** Per run, end to end where verify ran some, and checking it, each under its label. */
  costs: Array<{ label: string; text: string }>;
  /** `sub` only while a field is refused; each reason with the fields it names as code; a field given as `` `k=v` as given ``. */
  set: { sub: string | null; fields: Array<{ text: string; why: string }>; given: string[]; only: string | null; flags: string | null };
  config: { sub: string; files: Array<{ path: string; places: number; leftOut: string[] }>; patch: string | null; leftOut: string | null; byHand: string | null; noFile: string | null; review: Array<{ path: string; line: number; text: string }>; apply: string | null };
  pullRequest: { title: string; body: string; gh: string | null } | null;
  /** Apply config change, offered, or why not. */
  apply: MigrateApplyOffer | { why: string };
  applied: AppliedState | null;
  /** `3 goldens to update under <to>: a, b and c` while any waits, each by its name. */
  appliedLine: string | null;
  next: 'apply' | 'update' | 'copy-pull-request' | null;
  command: string;
  warnings: string[];
  notes: string[];
}

type Kept = Record<string, unknown>;
const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
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
    none: steps.length ? null : `${noChangeWords(!!c?.notAsked)}.`,
    besides: (c && besidesLine({ counts: c, runs: decisions.runs ?? [] })) || null,
  };
}

type PassRun = Parameters<typeof migratePassWords>[0] & { runId: string; golden: string | null; diverges?: { callNo: number } | null; stays?: 'fork' | 'no-call' };

/** Why verify didn't run, when it didn't: What still passes says them once, and the foot leaves out the warning that says the first. */
function notRunReasons(k: Kept): string[] {
  const verify = (k.decisions as { verify?: { verdict?: string; reasons?: string[] } | null } | undefined)?.verify ?? null;
  return verify?.verdict === 'not-run' ? strings(verify.reasons) : [];
}

/** What a run migrate didn't verify came to, in Preview's words: a step that got no answer, one left to verify, one that waits on a judge. */
const UNVERIFIED: Readonly<Record<string, string>> = { 'not-asked': 'a step not asked', unsettled: 'not verified', 'not-judged': 'a step waits on a judge' };

/** A run as What still passes words it (migratePassWords), its outcome as every page says it: `not fixed, verified`, never `not-fixed`. */
const passWords = (x: PassRun): string => migratePassWords({ ...x, outcome: x.verified ? verifiedOutcome(x.outcome) : (UNVERIFIED[x.outcome] ?? x.outcome) });

function passesOf(runs: PassRun[], k: Kept, applied: AppliedState | null): MigrateView['passes'] {
  const verify = (k.decisions as { verify?: { verdict?: string; rule?: string | null; reasons?: string[]; warnings?: string[] } | null } | undefined)?.verify ?? null;
  const waiting = new Map((applied?.outdated ?? []).map((g) => [g.golden, g]));
  const name = (x: { runId: string; golden: string | null }) => x.golden ?? x.runId;
  return {
    runs: runs.map((x) => {
      const after = x.golden ? waiting.get(x.golden) : undefined;
      // Once applied, the field its replay diverged on, which migrate apply logged; before, the model, which migrate foresaw.
      const leftBehind = applied ? (after?.waits ? `diverges at #${after.callNo} on ${tick(after.path || '$.model')} until updated` : null) : x.diverges ? `diverges at #${x.diverges.callNo} on ${tick('$.model')} once applied` : null;
      return { runId: x.runId, golden: x.golden, verdict: x.verdict, words: passWords(x), leftBehind };
    }),
    rules: migrateRules(runs.map((x) => ({ ...x, tally: x.tally as { rule?: string | null } | null })), verify?.rule ?? null).map((g) => ({ rule: g.rule, runs: g.runs.map(name) })),
    verified: verifiedCount(runs),
    notVerified: notRunReasons(k).length ? `${notVerifiedYet(notRunReasons(k))}.` : null,
    notes: strings(verify?.warnings),
  };
}

const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A refused field's reason with each field What to set names, and any `=value` after it, as code. */
function whyCoded(why: string, names: readonly string[]): string {
  if (!names.length) return why;
  return why.replace(new RegExp(`(?<![\\w\`.-])(?:${names.map(escaped).join('|')})(?:=[^\\s.,;:)\`]+)?(?![\\w\`-])`, 'g'), tick);
}

function setOf(k: Kept, to: string): MigrateView['set'] {
  const set = (k.set ?? {}) as { fields?: DecisionRemedy[]; given?: Record<string, unknown>; flags?: string[] };
  const fields = list<DecisionRemedy>(set.fields);
  const given = Object.entries(set.given ?? {});
  const names = [...new Set(fields.flatMap((f) => [f.field, ...(f.renamedTo ? [f.renamedTo] : [])]))];
  return {
    sub: fields.length ? `each field ${to} refuses, and what it takes instead` : null,
    fields: fields.map((f) => ({ text: remedyText(f, tick), why: whyCoded(f.why, names) })),
    given: given.map(([field, v]) => `${givenField(field, v, tick)} as given`),
    only: fields.length || given.length ? null : onlyTheModel(to, tick),
    flags: verifyFlagsLine(strings(set.flags), tick) || null,
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
    leftOut: out.length ? andList([...new Set(out.map((x) => x.field))].map(tick)) : null,
    leftBehind: left,
    stays: staysWords(runs, strings(k.from), { short: true }) || null,
    command: quoteArgv(['shadowlap', 'migrate', 'apply', shortSessionId(input.migrateId!)]),
  };
}

/**
 * Each retirement notice a report kept, in today's words (the table's, by the provider and model it
 * read), its kept words where the table no longer has it; `keep` picks which. A preview's and a
 * migration's say them so.
 */
export function retirementWords(kept: unknown, now: number, keep: (n: RetirementNotice) => boolean = () => true): MigrateView['retirements'] {
  return list<RetirementNotice>(kept)
    .filter(keep)
    .map((n) => {
      const today = retirementOf(n.provider, n.model, { now });
      return { text: today?.text ?? n.text, source: (today ?? n).source ?? null };
    });
}

/** Each from-model's retirement in today's words. */
const retirementsOf = (k: Kept, from: string[], now: number): MigrateView['retirements'] => retirementWords(k.retirements, now, (n) => from.includes(n.model));

/** A kept migration (its report, its decisions' runs filled in) as the page shows it; `verdict`, Verdicts' word for it. */
export function migrateView(k: Kept & { applied?: AppliedState | null }, sessionId: string, verdict: { word: string; tone: VerdictTone | null }, now = Date.now()): MigrateView {
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
    costs: migrateCostLines((k.costs ?? NO_COSTS) as MigrateCosts, { judged: !!(k.decisions as { judge?: unknown } | undefined)?.judge, unknown: [...new Set([...strings((k.decisions as { cost?: { unknownModels?: unknown } } | undefined)?.cost?.unknownModels), ...strings((k.decisions as { judge?: { unknownModels?: unknown } | null } | undefined)?.judge?.unknownModels)])] }),
    set: setOf(k, to),
    config: configOf(k, notes, applied),
    pullRequest: pr?.title && pr.body ? { title: pr.title, body: pr.body, gh: prPath ? quoteArgv(['gh', 'pr', 'create', '--title', pr.title, '--body-file', prPath]) : null } : null,
    apply,
    applied,
    appliedLine: waiting.length ? `${waiting.length} golden${waiting.length === 1 ? '' : 's'} to update under ${to}: ${andList(waiting.map((g) => goldenName(g.golden)))}` : null,
    next: applied ? (waiting.length ? 'update' : 'copy-pull-request') : 'files' in apply ? 'apply' : null,
    command: typeof k.command === 'string' ? k.command : '',
    // Verify not run is said once, under What still passes.
    warnings: strings(k.warnings).filter((w) => !notRunReasons(k).length || w !== notVerifiedWarning(notRunReasons(k)[0]!)),
    notes: notes.filter((n) => !NO_FILE.test(n) && !REVIEW.test(n)),
  };
}
