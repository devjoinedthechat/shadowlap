import { andList } from './checks/labels.js';
import { byRule, judgeOpen, migrateBreaks, migrateUnsettled, type DecisionCounts, type DecisionRemedy, type DecisionStep, type MigratePasses } from './decisions.js';
import { fieldValue } from './interventions.js';
import { quoteArgv } from './text.js';
import { changePct, CLEARED, endToEndWords, usdOrUnknown, verifiedWords, type VerifiedTally } from './verified-words.js';
import type { Footprint } from './verify.js';
import { shortSessionId } from './words.js';

/**
 * A migration's report in words, as `shadowlap migrate` prints it, its pull request body says it and
 * the dashboard's Migrate page shows it: the first line, what changed besides writes, stops and judged
 * changes, what to set for each field the new model refuses, what the config change leaves out and
 * what it leaves for the hand, the goldens the switch leaves behind, and why a migration can't be
 * applied. `code` marks a field or a value as code where a page or a pull request draws it so.
 */

/** Marks a field, a value or a command as code: the terminal leaves it plain, a pull request ticks it. */
export type CodeMark = (s: string) => string;

const plainCode: CodeMark = (s) => s;

/** The first line's mark: the switch keeps what it checked passing, breaks a run, or settles nothing. */
export type MigrateTone = 'pass' | 'fail' | 'warn';

/** What the first line reads from a report: the switch, its runs, and what still passes. */
export interface MigrateHeadlineInput {
  from: readonly string[];
  to: string;
  runs: number;
  passes: MigratePasses;
}

/**
 * The report's first line, in its parts: its tone, the words (`claude-haiku-4-5 breaks runs`,
 * `Inconclusive`, `claude-haiku-4-5 keeps every run passing`, `keeps the run it verified passing`,
 * `decided the same in the preview`) and the switch after them (`claude-sonnet-4-5 → claude-haiku-4-5,
 * 2 runs, 1 inconclusive`). It claims nothing What still passes doesn't: a run that is inconclusive
 * there leaves it inconclusive, and a run that failed as recorded is not one the switch keeps passing.
 * It claims only what ran: a run the preview cleared decided the same there, which is all that is
 * known of it.
 */
export function migrateHeadline(r: MigrateHeadlineInput): { tone: MigrateTone; text: string; rest: string } {
  const v = r.passes.verdict;
  const runs = r.passes.runs;
  const unsure = runs.filter((x) => x.verdict === 'inconclusive').length;
  const failing = runs.some((x) => x.verdict === 'failed');
  const verified = runs.filter((x) => x.verified).length;
  const cleared = runs.some((x) => !x.verified && x.verdict === 'passed');
  const kept = !cleared ? `every run${failing ? ' that passed' : ''}` : verified === 1 ? 'the run it verified' : `the ${verified} runs it verified`;
  const rest = `${r.from.length ? `${r.from.join(', ')} → ` : ''}${r.to}, ${r.runs} run${r.runs === 1 ? '' : 's'}${unsure ? `, ${unsure} inconclusive` : ''}`;
  if (v === 'rejected') return { tone: 'fail', text: `${r.to} breaks runs`, rest };
  if (!unsure && v === 'accepted') return { tone: 'pass', text: `${r.to} keeps ${kept} passing`, rest };
  if (!unsure && verified === 0 && v === 'not-run') return { tone: 'pass', text: `${r.to} decided the same in the preview`, rest };
  return { tone: 'warn', text: 'Inconclusive', rest };
}

/** The changes besides writes, stops and judged ones, counted: `1 read added or removed, 2 text only (1 judged as recorded, 1 not judged)`; empty when there are none. */
export function besidesWords(d: { counts: DecisionCounts; runs: ReadonlyArray<{ decisions: readonly DecisionStep[] }> }): string {
  const c = d.counts;
  const text = d.runs.flatMap((x) => x.decisions).filter((s) => s.rank === 5);
  const judged = text.filter((s) => !judgeOpen(s) && s.judge?.length && s.judge.every((j) => j.changed === false)).length;
  const open = text.filter((s) => judgeOpen(s)).length;
  const how = [judged ? `${judged} judged as recorded` : '', open ? `${open} not judged` : ''].filter(Boolean).join(', ');
  return [c[3] && `${c[3]} read added or removed`, c[4] && `${c[4]} read asked differently`, c[5] && `${c[5]} text only${how ? ` (${how})` : ''}`].filter(Boolean).join(', ');
}

/** What changes says with no write, stop or judged change: `No write, stop or judged change in the steps asked`, where some steps weren't asked. */
export const noChangeWords = (notAsked: boolean): string => `No write, stop or judged change${notAsked ? ' in the steps asked' : ''}`;

/** What changed besides writes, stops and judged changes, as its line says it: `besides: 1 read added or removed`; empty when nothing did. */
export function besidesLine(d: Parameters<typeof besidesWords>[0]): string {
  const c = d.counts;
  return c[3] + c[4] + c[5] ? `besides: ${besidesWords(d)}` : '';
}

/** Why verify didn't run, as What still passes says it: `Not verified yet: <reason>; <reason>`; empty when it ran or no reason was kept. */
export const notVerifiedYet = (reasons: readonly string[]): string => (reasons.length ? `Not verified yet: ${reasons.join('; ')}` : '');

/** The warning a report keeps when verify didn't run, naming the first reason: `Not verified: <reason>`. A page that says `notVerifiedYet` leaves it out. */
export const notVerifiedWarning = (reason: string): string => `Not verified: ${reason}`;

/** What to set when the new model takes every field as recorded: `Only the model: claude-haiku-4-5`. */
export const onlyTheModel = (to: string, code: CodeMark = plainCode): string => `Only the model: ${code(to)}`;

/** The flags verify took What to set as: `verify takes them as: --set temperature=1`; empty with none. */
export const verifyFlagsLine = (flags: readonly string[], code: CodeMark = plainCode): string => (flags.length ? `verify takes them as: ${code(flags.join(' '))}` : '');

/** A field given with `--set`, as What to set lists it: `temperature=1`, then `as given` after it. */
export const givenField = (field: string, value: unknown, code: CodeMark = plainCode): string => code(`${field}=${fieldValue(value)}`);

/** What to set for one field, in words: `temperature` left out, `thinking` = `{"type":"adaptive"}`, `max_completion_tokens` in place of `max_tokens`. */
export function remedyText(f: Pick<DecisionRemedy, 'field' | 'value' | 'leftOut' | 'renamedTo'>, code: CodeMark = plainCode): string {
  if (f.renamedTo) return `send ${code(f.renamedTo)} in place of ${code(f.field)}, with the value it has`;
  if (f.leftOut) return `leave ${code(f.field)} out${f.value !== null ? ` (the requests were sent ${code(`${f.field}=${fieldValue(f.value)}`)}, its default, meanwhile)` : ''}`;
  return `${code(f.field)} = ${code(fieldValue(f.value))}`;
}

/** What the hand still does for one field the config change can't reach: `leave top_p out`, `send max_completion_tokens in place of max_tokens`, `set thinking to {"type":"adaptive"}`. */
export function handWords(f: { field: string; value: unknown; leftOut?: boolean; renamedTo?: string | null }, code: CodeMark = plainCode): string {
  if (f.renamedTo) return `send ${code(f.renamedTo)} in place of ${code(f.field)}`;
  if (f.leftOut) return `leave ${code(f.field)} out`;
  return `set ${code(f.field)} to ${code(fieldValue(f.value))}`;
}

/** What a file's line in The config change adds after its places: `, temperature left out`; nothing when the patch takes no field out there. */
export const leftOutInFile = (fields: readonly string[], code: CodeMark = plainCode): string => (fields.length ? `, ${andList(fields.map(code))} left out` : '');

/** The line under the patch that says it takes fields out: `It leaves `temperature` out too, as What to set says.` */
export const leftOutNote = (fields: readonly string[], code: CodeMark = plainCode): string => `It leaves ${andList(fields.map(code))} out too, as What to set says.`;

/** The line that says what the patch leaves for the hand: `Also leave `top_p` out, as What to set says: the patch changes the model alone.` */
export const byHandNote = (hand: ReadonlyArray<Parameters<typeof handWords>[0]>, code: CodeMark = plainCode): string => `Also ${andList(hand.map((f) => handWords(f, code)))}, as What to set says: the patch changes the model alone.`;

/** The pull request's line that names where the model is named: `The model is named in `a.py`, where the config change leaves `temperature` out too.` */
export function namedInSentence(paths: readonly string[], leftOut: readonly string[], code: CodeMark = plainCode): string {
  return `The model is named in ${paths.map(code).join(', ')}${leftOut.length ? `, where the config change leaves ${andList(leftOut.map(code))} out too` : ''}.`;
}

/** A golden the switch leaves behind: its name as the test history gives it, and the first call it makes with a model the switch changes. */
export interface LeftBehind {
  golden: string;
  callNo: number;
}

/**
 * The terminal's lines for the goldens the config change leaves behind, before anything is applied:
 * `once applied, goldens/a (#1), goldens/b (#3) diverge on $.model: they replay exactly`, then
 * `re-record them under <to>: shadowlap test … --update`. Empty when it leaves none.
 */
export function leftBehindLines(left: readonly LeftBehind[], to: string, update: string): string[] {
  if (!left.length) return [];
  const one = left.length === 1;
  return [`once applied, ${left.map((x) => `${x.golden} (#${x.callNo})`).join(', ')} ${one ? 'diverges' : 'diverge'} on $.model: ${one ? 'it replays' : 'they replay'} exactly`, `re-record ${one ? 'it' : 'them'} under ${to}: ${update}`];
}

/** The pull request's sentence for them: `goldens/a and goldens/b replay exactly, so each diverges on `$.model` once this is in: re-record them under <to> with `…`.` */
export function leftBehindSentence(left: readonly LeftBehind[], to: string, update: string, code: CodeMark = plainCode): string {
  const one = left.length === 1;
  return `${andList(left.map((x) => x.golden))} ${one ? 'replays' : 'replay'} exactly, so ${one ? 'it diverges' : 'each diverges'} on ${code('$.model')} once this is in: re-record ${one ? 'it' : 'them'} under ${to} with ${code(update)}.`;
}

/** What to set, as a report keeps it: the fields the new model needs, those given with `--set`, and the names of those the patch leaves for the hand. */
export interface MigrateSetInput {
  fields: ReadonlyArray<Pick<DecisionRemedy, 'field' | 'value' | 'leftOut' | 'renamedTo'>>;
  given: Record<string, unknown>;
  /** Absent from a migration kept before the patch took a field out: every field was the hand's then. */
  byHand?: readonly string[] | null;
}

/** The fields the config change leaves for the hand, each as What to set says it: a remedy, or a field given with `--set`. */
export function handOf(set: MigrateSetInput): Array<Parameters<typeof handWords>[0]> {
  const names = set.byHand ?? [...set.fields.map((f) => f.field), ...Object.keys(set.given)];
  return names.map((field) => set.fields.find((f) => f.field === field) ?? { field, value: set.given[field], leftOut: false, renamedTo: null });
}

/** What `migrateApplyProblem` reads from a report or a kept migration. */
export interface MigrateApplyInput {
  migrateId: string | null;
  from: readonly string[];
  to: string;
  stopReason: string | null;
  passes: MigratePasses;
  configChange: { files: readonly unknown[] } | null;
  set: MigrateSetInput;
  files: { dir: string; patch: string | null } | null;
}

/**
 * Why a migration's config change can't be applied as it stands, or null when it can: it breaks a
 * run, or settles nothing, by the rules its exit status follows (migrateBreaks, migrateUnsettled); no
 * file of the project names the model; migrate could not write its files; or What to set asks for
 * a change the patch can't make, without which the switch is not the one verify checked. `shadowlap
 * migrate apply` refuses it with these words, and the dashboard offers no Apply then.
 */
export function migrateApplyProblem(r: MigrateApplyInput): string | null {
  const id = r.migrateId ? shortSessionId(r.migrateId) : 'the migration';
  if (migrateBreaks(r.passes)) return `${id} is not all clear: ${r.to} breaks runs. Nothing was changed`;
  const open = migrateUnsettled(r);
  if (open) return `${id} is not all clear: ${open}. Nothing was changed`;
  if (!r.configChange?.files.length) return `${id} has no config change: no string in the project's code or config names ${r.from.join(' or ') || 'the model'}, so set ${r.to} where your agent reads its model`;
  if (!r.files?.patch) return `migrate could not write ${r.files?.dir ?? `.shadowlap/migrations/${r.migrateId ?? '<id>'}`}/: run the migration again`;
  const hand = handOf(r.set);
  if (hand.length) return `What to set says to ${andList(hand.map((f) => handWords(f)))}, which the config change can't reach: applied alone it would break runs. Change ${hand.length === 1 ? 'it' : 'them'} by hand, then git apply ${r.files.patch}`;
  return null;
}

/** A run of a migration as What still passes words it: a verified run in verify's words, one the preview cleared as `CLEARED`, else its outcome (`not-asked`, `unsettled`, `not-judged`). */
export const migratePassWords = (x: { verdict: string; outcome: string; verified: boolean; tally: VerifiedTally | null }): string => (x.verified ? verifiedWords(x) : x.outcome === 'unchanged' ? CLEARED : x.outcome);

/** A run of a migration, as its passes keep it: its golden, and the first call it makes with a model the switch changes when the config change leaves it behind. */
export interface MigratePassRun {
  runId: string;
  golden: string | null;
  verified: boolean;
  tally: { rule?: string | null } | null;
  diverges?: { callNo: number } | null;
  /** Why a golden replays as recorded once switched: marked `fork`, or it sends no model the switch changes (`no-call`). */
  stays?: 'fork' | 'no-call';
}

/**
 * Why the goldens a switch leaves alone replay as recorded, by migrate's marks: those marked fork,
 * those named as left behind that the replay found as recorded (an agent the patch doesn't touch, so
 * only once `diverged` names what did), and those that never send a from-model. `short`, as Apply
 * config change's Diverges row says it; else as `migrate apply` logs it.
 */
export function staysWords(runs: ReadonlyArray<Pick<MigratePassRun, 'golden' | 'diverges' | 'stays'>>, from: readonly string[], o: { diverged?: readonly string[]; short?: boolean } = {}): string {
  const goldens = runs.filter((x) => x.golden);
  const fork = goldens.filter((x) => x.stays === 'fork').length;
  const untouched = o.diverged ? goldens.filter((x) => x.diverges && !o.diverged!.includes(x.golden!)).length : 0;
  const never = goldens.filter((x) => x.stays === 'no-call').length;
  const forks = o.short ? `${fork} marked fork ${fork === 1 ? 'passes on its checks' : 'pass on their checks'}` : `${fork} golden${fork === 1 ? ' marked fork passes on its checks wherever it forks' : 's marked fork pass on their checks wherever they fork'}`;
  return [fork ? forks : '', untouched ? `${untouched} ${untouched === 1 ? 'runs an agent' : 'run agents'} the patch doesn't touch` : '', never ? `${never} never ${never === 1 ? 'sends' : 'send'} ${from.join(' or ')}` : ''].filter(Boolean).join(o.short ? ', ' : ', and ');
}

/** The goldens a migration's config change leaves behind, each with the first call it makes with a model the switch changes, and the command that re-records them. */
export function leftBehindOf(runs: ReadonlyArray<Pick<MigratePassRun, 'golden' | 'diverges'>>): { left: LeftBehind[]; update: string } {
  const left = runs.flatMap((x) => (x.diverges && x.golden ? [{ golden: x.golden, callNo: x.diverges.callNo }] : []));
  return { left, update: quoteArgv(['shadowlap', 'test', ...left.map((x) => x.golden), '--update']) };
}

/** The rules verify decided a migration's verified runs by, each with its runs; the session's own rule for a run kept before runs carried theirs. */
export function migrateRules<T extends MigratePassRun>(runs: readonly T[], sessionRule: string | null): Array<{ rule: string; runs: T[] }> {
  return byRule(
    runs.filter((x) => x.verified),
    (x) => x.tally?.rule,
    sessionRule,
  ).flatMap((g) => (g.rule === null ? [] : [{ rule: g.rule, runs: g.runs }]));
}

/** What a migration's report keeps of what it costs. */
export interface MigrateCosts {
  perRun: { before: number | null; after: number | null };
  tokensPerRun: { before: number; after: number };
  endToEnd: { recorded: Footprint; now: Footprint } | null;
  checking: { decisions: number; judge: number; verify: number };
}

/** What it costs, line by line under the labels the terminal and the dashboard give them: per run, end to end where verify ran some, and checking it. */
export function migrateCostLines(c: MigrateCosts, o: { judged: boolean; unknown: readonly string[] }): Array<{ label: 'per run' | 'end to end' | 'checking it'; text: string }> {
  const w = migrateCostWords(c, o);
  return [{ label: 'per run', text: w.perRun }, ...(w.endToEnd ? [{ label: 'end to end' as const, text: w.endToEnd }] : []), { label: 'checking it', text: w.checking }];
}

/**
 * What it costs, as the terminal and the dashboard say it: per run (`≈$0.04 → ≈$0.03 (−25%) · 1,200 →
 * 900 tokens`), end to end where verify ran some, and checking it, each part named, with the models
 * no price covers (`unknown`: asking's and the judge's).
 */
export function migrateCostWords(c: MigrateCosts, o: { judged: boolean; unknown: readonly string[] }): { perRun: string; endToEnd: string | null; checking: string } {
  const unpriced = o.unknown.length ? ` (no price for ${o.unknown.join(', ')}: add it under "prices" in shadowlap.config.json)` : '';
  return {
    perRun: `${usdOrUnknown(c.perRun.before)} → ${usdOrUnknown(c.perRun.after)}${changePct(c.perRun.before, c.perRun.after)} · ${c.tokensPerRun.before.toLocaleString('en-US')} → ${c.tokensPerRun.after.toLocaleString('en-US')} tokens`,
    endToEnd: c.endToEnd ? endToEndWords(c.endToEnd) : null,
    checking: `${usdOrUnknown(c.checking.decisions)} asking, ${o.judged ? `${usdOrUnknown(c.checking.judge)} judging, ` : ''}${usdOrUnknown(c.checking.verify)} verifying${unpriced}`,
  };
}
