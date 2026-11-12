import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { argsDelta, byRule, changePct, CLEARED, controlOpen, credentialFreeCommandLine, endToEndWords, fieldValue, judgeOpen, RANK_LABELS, safeLine, decisionLine, usdOrUnknown, verifiedCount, verifiedWords, type DecisionRemedy, type DecisionRun, type DecisionsReport, type DecisionsVerify, type Footprint, type RetirementNotice, type SprtGate, type Store, type StoreOf } from '@shadowlap/engine';
import { judgeRecording } from './attempts.js';
import { type TestSpec } from './checks.js';
import { loadConfig } from './config.js';
import { keepDecisions, newSessionId, runDecisions, type DecisionTarget } from './decisions.js';
import { physicalPath } from './real-path.js';
import { listedFiles, readInside } from './repair-tree.js';
import { type GuardMode } from './run-agent.js';
import { openStore, type GlobalOpts } from './shared.js';
import { palette as p, shortId } from './ui.js';

/**
 * `shadowlap migrate --to <model>`: the decision diff, packaged for a model switch, such as the one
 * a retirement date forces. It asks the agent's model calls of the goldens again under the new model
 * (those made with the models `--from` names, else the ones that retire, else the one used most),
 * with the fields it refuses changed to what it takes (by the providers' pages and its own
 * refusals); runs end to end every run that preview can't clear (needsVerify); compares what a run costs;
 * and ends in one report: what changes, what still passes, what it costs, what to set, with the
 * change to the project's files that name the model and a pull request body to go with it.
 */

export interface MigrateSettings {
  to: string;
  /** `--from`: the recorded models to switch from; null takes those that retire, else the one used most. */
  from: string[] | null;
  /** Only the model calls made in this scope (`none`: in none). */
  scope: string | null;
  /** Fields the switch sets besides the model, as given (`--set`). */
  fields: Record<string, unknown>;
  samples: number;
  concurrency: number;
  budget: number | null;
  timeoutMs: number | null;
  /** How verify decides each run it takes: its gate (verify's by default; `attempts` is its `max`), or with `gate` null a fixed count, `needed` of `attempts`. */
  attempts: number;
  needed: number;
  gate: SprtGate | null;
  writes: 'stub' | 'block';
  expect: { spec: TestSpec; json: unknown } | null;
  guard: GuardMode;
  argv: string[] | null;
}

/** The only verdict words a report uses. */
export type Verdict = 'passed' | 'failed' | 'inconclusive' | 'not-applicable';

/** How each run fares after the switch: verified (kept, fixed, broken…), cleared by the preview (`unchanged`), or not asked. */
export interface MigrateRunPass {
  runId: string;
  golden: string | null;
  /** passed, failed or inconclusive: what the run's outcome comes to. */
  verdict: Verdict;
  /** kept, broken, fixed, not-fixed, inconclusive, unsettled (verified, in verify's own words); unchanged (the preview cleared it, needsVerify, so not run end to end); not-asked; not-judged (it waits on a judge: a text-only change a judge check reads could not be judged). */
  outcome: string;
  verified: boolean;
  /**
   * A run verify took: its passes of its attempts, under a gate the Wilson bound of its pass rate
   * (null for a clean replay or a fixed count), the rule that decided it (null in a session kept
   * before verify said one), and `undecided`, why its last attempt could not be judged, which stopped
   * it: that attempt neither passed nor failed, and there is no bound (null otherwise). Null for a run
   * it didn't take. A good run kept against its baseline (the old model) has the baseline's tally too,
   * and the bound on its drop from it.
   */
  tally: { passes: number; attempts: number; bound: string | null; rule: string | null; undecided?: string | null; baseline?: { passes: number; attempts: number } | null } | null;
}

/** A place a project file names a model the switch changes. */
export interface ModelMention {
  path: string;
  line: number;
  text: string;
}

export interface MigrateReport {
  migrateId: string | null;
  kind: 'migrate';
  at: number;
  /** The recorded models the switch changes, and the one they switch to. */
  from: string[];
  to: string;
  command: string;
  /** The decision diff under the new model, as `decisions --json` prints it. */
  decisions: DecisionsReport;
  /** What changes: each run's write, stop and judged changes, with the recorded and the new action. */
  changes: { runs: number; flagged: number; steps: Array<{ runId: string; golden: string | null; callNo: number; rank: number; detail: string; recorded: string; now: string; arguments: string[] }> };
  /** What still passes. */
  passes: { verdict: DecisionsVerify['verdict']; runs: MigrateRunPass[] };
  /**
   * What it costs: per run (the mean), and for the goldens all together, before and after, by the
   * recorded steps; `endToEnd`, what the runs verified cost a run by what their attempts did, which sees
   * a run that takes more steps (null when none was); and what checking cost: asking, judging the
   * text-only changes, verifying.
   */
  costs: { perRun: { before: number | null; after: number | null }; total: { before: number | null; after: number | null }; tokensPerRun: { before: number; after: number }; endToEnd: { recorded: Footprint; now: Footprint } | null; checking: { decisions: number; judge: number; verify: number } };
  /** What to set: the flags verify took, the fields the switch needs and why, and those given with `--set`. */
  set: { flags: string[]; fields: DecisionRemedy[]; given: Record<string, unknown> };
  /**
   * The change to the project's files: where a string value names a model it switches from (in code
   * and config), the places in each and the patch; and the mentions left for review (prose, history,
   * tests, an object key, Shadowlap's own config). Null when no file names one.
   */
  configChange: { files: Array<{ path: string; places: number }>; patch: string; review: ModelMention[] } | null;
  pullRequest: { title: string; body: string };
  /** Where the pull request body and the patch were written (`.shadowlap/migrations/<id>/`), relative to the project; null when they could not be. */
  files: { dir: string; pullRequest: string; patch: string | null } | null;
  retirements: RetirementNotice[];
  notes: string[];
  warnings: string[];
  stopReason: string | null;
}

/** What it costs, for the pull request. */
const costsSentence = (r: Omit<MigrateReport, 'pullRequest' | 'files'>): string => {
  const { perRun, endToEnd, checking } = r.costs;
  return `Per run: ${usdOrUnknown(perRun.before)} → ${usdOrUnknown(perRun.after)}${changePct(perRun.before, perRun.after)}. ${endToEnd ? `End to end: ${endToEndWords(endToEnd)}. ` : ''}Checking it cost ${usdOrUnknown(checking.decisions + checking.judge + checking.verify)}.`;
};

/** How a run came to its verdict, in words. */
const passWords = (x: MigrateRunPass): string => (x.verified ? verifiedWords(x) : x.outcome === 'unchanged' ? CLEARED : x.outcome);

/** The changes besides writes, stops and judged ones, counted: `1 read added or removed, 2 text only (1 judged as recorded, 1 not judged)`. */
function besides(r: Pick<MigrateReport, 'decisions'>): string {
  const c = r.decisions.counts;
  const text = r.decisions.runs.flatMap((x) => x.decisions).filter((s) => s.rank === 5);
  const judged = text.filter((s) => !judgeOpen(s) && s.judge?.length && s.judge.every((j) => j.changed === false)).length;
  const open = text.filter((s) => judgeOpen(s)).length;
  const how = [judged ? `${judged} judged as recorded` : '', open ? `${open} not judged` : ''].filter(Boolean).join(', ');
  return [c[3] && `${c[3]} read added or removed`, c[4] && `${c[4]} read asked differently`, c[5] && `${c[5]} text only${how ? ` (${how})` : ''}`].filter(Boolean).join(', ');
}

/**
 * The rules the verified runs were decided by, each once, with the runs it decided: one rule, unless
 * a session was verified again under other figures. A run kept before tallies named their rule takes
 * the one the decisions report's verify states.
 */
function verifiedRules(r: Pick<MigrateReport, 'passes' | 'decisions'>): Array<{ rule: string; runs: MigrateRunPass[] }> {
  return byRule(
    r.passes.runs.filter((x) => x.verified),
    (x) => x.tally?.rule,
    r.decisions.verify?.rule ?? null,
  ).flatMap((g) => (g.rule === null ? [] : [{ rule: g.rule, runs: g.runs }]));
}

/** Paths whose text is no place the agent names its model: the store, packages, recordings' blobs and lockfiles. */
const NOT_SOURCE = /(^|\/)(\.shadowlap|node_modules|blobs)\/|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|uv\.lock|poetry\.lock|Cargo\.lock)$/;

/**
 * Files the project tracks or would (not ignored), with text, outside recordings and the store. A link
 * is read as the file it ends at, under that file's own path, and only when git lists that file too
 * and it is not git's own (listedFiles, as repair reads them): the patch's context lines and the
 * review never quote a file git ignores, such as a `.env`, a key file kept elsewhere, nor git's
 * config, which can hold a credential.
 */
function projectTextFiles(cwd: string): Array<{ path: string; content: string }> | null {
  let paths: string[];
  try {
    paths = listedFiles(cwd, (path) => NOT_SOURCE.test(path));
  } catch {
    return null;
  }
  const real = physicalPath(cwd);
  const out: Array<{ path: string; content: string }> = [];
  for (const path of paths) {
    // A pack's recording holds the requests the model was sent, not where the agent names it.
    if (/(^|\/)(run\.json|calls\.jsonl)$/.test(path) && existsSync(join(real, dirname(path), 'run.json'))) continue;
    try {
      if (statSync(join(real, path)).size > 1024 * 1024) continue;
      const content = readInside(real, path);
      if (!content.includes('\u0000')) out.push({ path, content });
    } catch {
      // gone, unreadable, or a file with another name
    }
  }
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A unified diff of a file whose lines changed in place (no line added or removed), one hunk per
 * group of changed lines with three lines of context, as `git apply` reads it.
 */
export function inPlaceDiff(path: string, before: string, after: string): string {
  const a = before.split('\n');
  const b = after.split('\n');
  const changed = a.map((line, i) => line !== b[i]).flatMap((c, i) => (c ? [i] : []));
  if (!changed.length) return '';
  const hunks: Array<[number, number]> = [];
  for (const i of changed) {
    const last = hunks.at(-1);
    if (last && i - last[1] <= 6) last[1] = i;
    else hunks.push([i, i]);
  }
  const lines = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`];
  // A file that ends without a newline has one line fewer to show than `split` gives.
  const count = before.endsWith('\n') ? a.length - 1 : a.length;
  for (const [first, end] of hunks) {
    const start = Math.max(0, first - 3);
    const stop = Math.min(count - 1, end + 3);
    lines.push(`@@ -${start + 1},${stop - start + 1} +${start + 1},${stop - start + 1} @@`);
    for (let i = start; i <= stop; i++) {
      const noEol = i === count - 1 && !before.endsWith('\n');
      if (a[i] === b[i]) lines.push(` ${a[i]!}`);
      else lines.push(`-${a[i]!}`, ...(noEol ? ['\\ No newline at end of file'] : []), `+${b[i]!}`);
      if (noEol && a[i] === b[i]) lines.push('\\ No newline at end of file');
    }
  }
  return `${lines.join('\n')}\n`;
}

/** Prose and history: what a model was, never what the agent sends now. */
const PROSE = /(^|\/)(CHANGELOG|CHANGES|HISTORY|NEWS|RELEASES?)[^/]*$|\.(md|mdx|markdown|rst|adoc|txt)$/i;
/** Tests and fixtures: what a run once sent, or what a check expects. */
const TESTS = /(^|\/)(tests?|__tests__|specs?|fixtures?|__fixtures__|__recordings__|goldens|testdata)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.(py|go)$/i;
/** Shadowlap's own config: its prices are keyed by model and its judges name theirs; none is the agent's. */
const SHADOWLAP_CONFIG = /(^|\/)shadowlap\.config\.json$/;
/** A line that is a comment. */
const COMMENT = /^\s*(\/\/|#|\*|\/\*|--|;)/;

type FileKind = 'json' | 'yaml' | 'env' | 'toml' | 'code';

function kindOf(path: string): FileKind {
  if (/\.jsonc?$/i.test(path)) return 'json';
  if (/\.ya?ml$/i.test(path)) return 'yaml';
  if (/(^|\/)\.env(\.[\w.-]+)?$|\.env$/i.test(path)) return 'env';
  if (/\.toml$/i.test(path)) return 'toml';
  return 'code';
}

/**
 * Whether the mention at `at` (of `name`) on `line` is a string value naming the model whole: a JSON
 * string that is no key, a YAML, TOML or .env value, a string literal in code that is no object key.
 */
function isValue(kind: FileKind, line: string, at: number, name: string): boolean {
  if (COMMENT.test(line)) return false;
  const before = line.slice(0, at);
  const after = line.slice(at + name.length);
  const quote = before.at(-1);
  const quoted = (quote === '"' || quote === "'" || quote === '`') && after[0] === quote;
  const rest = quoted ? after.slice(1) : after;
  switch (kind) {
    case 'json':
      return quote === '"' && quoted && !/^\s*:/.test(rest);
    case 'yaml':
      return /^(\s*-\s+|\s*[\w.-]+\s*:\s*|\s*-\s+[\w.-]+\s*:\s*)$/.test(quoted ? before.slice(0, -1) : before) && /^\s*(#.*)?$/.test(rest);
    case 'env':
      return /^\s*(export\s+)?[A-Za-z_]\w*\s*=\s*$/.test(quoted ? before.slice(0, -1) : before) && /^\s*$/.test(rest);
    case 'toml':
      return quoted && /^\s*[\w.-]+\s*=\s*$/.test(before.slice(0, -1)) && /^\s*(#.*)?$/.test(rest);
    default:
      return quoted && !/^\s*:(?!:)/.test(rest);
  }
}

/**
 * Where the project's files name a model it switches from, and the patch that names the new one
 * there: only where a string value in code or config names the model whole. A mention in prose or
 * history, in a test, as an object key (a price table's), or in Shadowlap's own config is listed for
 * review and left as it is.
 */
export function modelMentions(cwd: string, from: readonly string[], to: string): MigrateReport['configChange'] | 'no-git' {
  const files = projectTextFiles(cwd);
  if (!files) return 'no-git';
  const names = [...new Set(from.filter((m) => m && m !== to))].sort((x, y) => y.length - x.length);
  if (!names.length) return null;
  // A name whole: no id character on either side, though a sentence may end on it (`… to claude-sonnet-4-6.`).
  const re = new RegExp(`(?<![\\w.-])(${names.map(escape).join('|')})(?![\\w-]|\\.\\w)`, 'g');
  const touched: Array<{ path: string; places: number }> = [];
  const review: ModelMention[] = [];
  let patch = '';
  for (const f of files) {
    if (!re.test(f.content)) continue;
    re.lastIndex = 0;
    const reviewOnly = PROSE.test(f.path) || TESTS.test(f.path) || SHADOWLAP_CONFIG.test(f.path);
    const kind = kindOf(f.path);
    let places = 0;
    const lines = f.content.split('\n').map((line, i) => {
      let changed = '';
      let last = 0;
      for (const m of line.matchAll(re)) {
        const at = m.index;
        if (!reviewOnly && isValue(kind, line, at, m[0])) {
          changed += `${line.slice(last, at)}${to}`;
          last = at + m[0].length;
          places++;
        } else review.push({ path: f.path, line: i + 1, text: safeLine(line.trim().slice(0, 160)) });
      }
      return last ? `${changed}${line.slice(last)}` : line;
    });
    if (!places) continue;
    touched.push({ path: f.path, places });
    patch += inPlaceDiff(f.path, f.content, lines.join('\n'));
  }
  // One entry per line, however many mentions it holds.
  const seen = new Set<string>();
  const listed = review.filter((r) => !seen.has(`${r.path}:${r.line}`) && seen.add(`${r.path}:${r.line}`));
  return touched.length || listed.length ? { files: touched, patch, review: listed } : null;
}

const name = (r: { runId: string; golden: string | null }) => r.golden ?? shortId(r.runId);

/** What to set for one field, in words: `temperature` left out, `thinking` = `{"type":"adaptive"}`, `max_completion_tokens` in place of `max_tokens`. */
export function remedyText(f: DecisionRemedy, code: (s: string) => string = (s) => s): string {
  if (f.renamedTo) return `send ${code(f.renamedTo)} in place of ${code(f.field)}, with the value it has`;
  if (f.leftOut) return `leave ${code(f.field)} out${f.value !== null ? ` (the requests were sent ${code(`${f.field}=${fieldValue(f.value)}`)}, its default, meanwhile)` : ''}`;
  return `${code(f.field)} = ${code(fieldValue(f.value))}`;
}

/**
 * The pull request body: the four blocks, short enough to read on the pull request. It is written to
 * be posted, so the command it names has a key its command line carries masked, as every copy of a
 * run's command line has it (credentialFreeCommandLine).
 */
export function pullRequestBody(r: Omit<MigrateReport, 'pullRequest' | 'files'>): { title: string; body: string } {
  const title = r.from.length === 1 ? `Switch ${r.from[0]!} to ${r.to}` : `Switch the model to ${r.to}`;
  const runs = r.decisions.runs.length;
  const tick = (s: string) => `\`${s}\``;
  const lines: string[] = [`## ${title}`, '', `Checked with \`${credentialFreeCommandLine(r.command)}\`: the model calls of ${runs} recording${runs === 1 ? '' : 's'} made with ${r.from.join(', ') || 'its model'} asked again under ${r.to}, and ${verifiedCount(r.passes.runs)}.`];
  for (const n of r.retirements.filter((x) => r.from.includes(x.model))) lines.push('', `> ${n.text} ([source](${n.source}))`);
  lines.push('', '### What changes', '');
  if (!r.changes.steps.length) lines.push(`No write, stop or judged change${r.decisions.counts.notAsked ? ' in the steps asked' : ''}.`);
  for (const s of r.changes.steps.slice(0, 12)) lines.push(`- ${name(s)} #${s.callNo}: ${s.detail}${s.arguments.length ? `: ${s.arguments.map(tick).join(', ')}` : ` (${tick(s.recorded)} → ${tick(s.now)})`}`);
  if (r.changes.steps.length > 12) lines.push(`- and ${r.changes.steps.length - 12} more`);
  const c = r.decisions.counts;
  if (c[3] + c[4] + c[5]) lines.push('', `Besides: ${besides(r)}.`);
  lines.push('', '### What still passes', '');
  for (const x of r.passes.runs) lines.push(`- ${name(x)}: ${x.verdict} (${passWords(x)})`);
  // The rule verify decided them by, said once; each over its own runs when more than one did.
  const rules = verifiedRules(r);
  if (rules.length === 1) lines.push('', `Verified by ${tick('shadowlap verify')}, ${rules[0]!.rule}.`);
  else if (rules.length) lines.push('', `Verified by ${tick('shadowlap verify')}, each run under the rule that decided it:`, '', ...rules.map((g) => `- ${g.runs.map(name).join(', ')}: ${g.rule}`));
  lines.push('', `${verifiedCount(r.passes.runs)}.`);
  if (r.decisions.verify?.verdict === 'not-run' && r.decisions.verify.reasons.length) lines.push('', `Not verified yet: ${r.decisions.verify.reasons.join('; ')}.`);
  for (const w of r.decisions.verify?.warnings ?? []) lines.push('', `Note: ${w}.`);
  lines.push('', '### What it costs', '', costsSentence(r));
  lines.push('', '### What to set', '');
  if (!r.set.fields.length && !Object.keys(r.set.given).length) lines.push(`Only the model: ${r.to}.`);
  for (const f of r.set.fields) lines.push(`- ${remedyText(f, tick)}: ${f.why}`);
  for (const [k, v] of Object.entries(r.set.given)) lines.push(`- ${tick(k)} = ${tick(fieldValue(v))} (given)`);
  if (r.configChange?.files.length) lines.push('', `The model is named in ${r.configChange.files.map((f) => tick(f.path)).join(', ')}.`);
  if (r.configChange?.review.length) lines.push('', `Left as they are, for review: ${r.configChange.review.length} other mention${r.configChange.review.length === 1 ? '' : 's'} in ${[...new Set(r.configChange.review.map((x) => x.path))].slice(0, 6).map(tick).join(', ')}.`);
  return { title, body: `${lines.join('\n')}\n` };
}

/**
 * How each run fares: a run verified by verify's outcome, with its tally under the rule that decided
 * it; a run the preview cleared by how its recording fares under its checks (it is not run end to
 * end); a run some step of which got no answer, as changed or, for a step it changed, as recorded
 * (controlOpen), that needed verify and did not get it, or with a step that waits on a judge
 * (judgeOpen: the words of a sample a judge check reads could not be judged, and might read
 * otherwise), is inconclusive.
 */
export function passesOf(runs: readonly DecisionRun[], toVerify: readonly string[], verify: DecisionsVerify | null, recorded: (runId: string) => boolean | null): MigrateRunPass[] {
  const verified = new Map((verify?.runs ?? []).map((r) => [r.runId, r]));
  return runs.map((r): MigrateRunPass => {
    const v = verified.get(r.runId);
    if (v) return { runId: r.runId, golden: r.golden, verdict: v.outcome === 'kept' || v.outcome === 'fixed' ? 'passed' : v.outcome === 'broken' || v.outcome === 'not-fixed' ? 'failed' : 'inconclusive', outcome: v.outcome, verified: true, tally: { passes: v.passes, attempts: v.attempts, bound: v.bound ?? null, rule: v.rule ?? verify?.rule ?? null, undecided: v.undecided ?? null, ...(v.baseline ? { baseline: v.baseline } : {}) } };
    // A step whose request as recorded got no answer for now waits on it (controlOpen): its change is not told from the model's own.
    const unanswered = r.decisions.some((x) => x.samples.asked > 0 && !x.samples.answered) || r.decisions.some((x) => x.error && !x.samples.asked) || (!toVerify.includes(r.runId) && r.decisions.some((x) => controlOpen(x)));
    if (unanswered) return { runId: r.runId, golden: r.golden, verdict: 'inconclusive', outcome: 'not-asked', verified: false, tally: null };
    if (toVerify.includes(r.runId)) return { runId: r.runId, golden: r.golden, verdict: 'inconclusive', outcome: 'unsettled', verified: false, tally: null };
    if (r.decisions.some((x) => judgeOpen(x))) return { runId: r.runId, golden: r.golden, verdict: 'inconclusive', outcome: 'not-judged', verified: false, tally: null };
    const passed = recorded(r.runId);
    return { runId: r.runId, golden: r.golden, verdict: passed === true ? 'passed' : passed === false ? 'failed' : 'inconclusive', outcome: 'unchanged', verified: false, tally: null };
  });
}

/** The `--set` flags verify takes for the switch: the fields given, and those sent with a value in place of what the new model refuses. */
export function verifyFlags(fields: Record<string, unknown>, remedies: readonly DecisionRemedy[]): string[] {
  const remedied = new Set(remedies.map((r) => r.field));
  const sent = [...Object.entries(fields).filter(([k]) => !remedied.has(k)), ...remedies.filter((r) => r.value !== null && r.renamedTo === null).map((r) => [r.field, r.value] as const)];
  return sent.map(([k, v]) => `--set ${k}=${fieldValue(v)}`);
}

/** Runs the decision diff under the new model, verifies the runs it flags, and keeps the report. */
export async function runMigrate(input: { opts: GlobalOpts; targets: DecisionTarget[]; settings: MigrateSettings; command: string; log: (line: string) => void; env?: NodeJS.ProcessEnv; now?: number }): Promise<MigrateReport> {
  const s = input.settings;
  const decisions = await runDecisions({
    opts: input.opts,
    targets: input.targets,
    settings: { model: s.to, fields: s.fields, from: s.from, fromCode: false, samples: s.samples, concurrency: s.concurrency, budget: s.budget, timeoutMs: s.timeoutMs, scope: s.scope, remedies: true, guard: s.guard, argv: s.argv, thenVerify: { attempts: s.attempts, needed: s.needed, gate: s.gate, writes: s.writes, expect: s.expect } },
    command: input.command,
    log: input.log,
    kind: 'migrate',
    ...(input.env ? { env: input.env } : {}),
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  // The models the switch changes: the ones whose calls it asked again, not every model a recording holds.
  const from = decisions.change.from ?? [];
  const store: Store = openStore(input.opts);
  let passes: MigrateRunPass[];
  try {
    const prices = loadConfig(process.cwd()).prices;
    const recorded = (runId: string) => {
      const t = input.targets.find((x) => x.run.runId === runId);
      return t ? judgeRecording(store, t.run, store.getCalls(runId), s.expect?.spec ?? t.spec, prices).passed : null;
    };
    passes = passesOf(decisions.runs, decisions.toVerify, decisions.verify, recorded);
  } finally {
    store.close();
  }
  const steps = decisions.runs.flatMap((r) =>
    r.decisions
      .filter((x) => x.majority !== null && x.majority <= 2)
      .map((x) => ({ runId: r.runId, golden: r.golden, callNo: x.callNo, rank: x.rank!, detail: x.changes[0]?.detail ?? RANK_LABELS[x.rank!], recorded: decisionLine(x.recorded, 60), now: decisionLine(x.now, 60), arguments: x.changes.filter((c) => c.kind === 'write-arguments').flatMap((c) => argsDelta(c.before, c.after).map((d) => `${c.tool!}.${d}`)) })),
  );
  const sum = (side: 'before' | 'after') => {
    const priced = decisions.runs.filter((r) => r.asked && r.cost[side] !== null);
    return priced.length ? priced.reduce((n, r) => n + r.cost[side]!, 0) : null;
  };
  const tokens = (t: DecisionRun['tokens']['before']) => t.input + t.cacheRead + t.cacheWrite + t.output;
  const runsAsked = decisions.runs.filter((r) => r.asked);
  // What the switch sets: the fields given, with what the new model needs in place of any it refuses.
  const remedied = new Set(decisions.remedies.map((r) => r.field));
  const given = Object.fromEntries(Object.entries(s.fields).filter(([k]) => !remedied.has(k)));
  const mentions = modelMentions(process.cwd(), from, s.to);
  const notes = [...decisions.notes];
  const warnings = [...decisions.warnings];
  const blocked = decisions.verify?.verdict === 'not-run' ? decisions.verify.reasons[0] : undefined;
  if (blocked) warnings.push(`Not verified: ${blocked}`);
  if (mentions === 'no-git') notes.push('The project is not a git repository, so its files were not searched for the model it switches from.');
  else if ((mentions === null || !mentions.files.length) && from.length) notes.push(`No string in the project's code or config names ${from.join(' or ')}: set ${s.to} where your agent reads its model (an environment variable, a deployment setting).`);
  if (mentions && mentions !== 'no-git' && mentions.review.length) notes.push(`${mentions.review.length} other mention${mentions.review.length === 1 ? '' : 's'} of ${from.join(' or ')} (prose, history, tests, object keys, Shadowlap's config) ${mentions.review.length === 1 ? 'is' : 'are'} left as ${mentions.review.length === 1 ? 'it is' : 'they are'}, for review.`);
  const base: Omit<MigrateReport, 'pullRequest' | 'files'> = {
    migrateId: null,
    kind: 'migrate',
    at: decisions.at,
    from,
    to: s.to,
    command: input.command,
    decisions,
    changes: { runs: decisions.runs.length, flagged: decisions.flagged.length, steps },
    passes: { verdict: decisions.verify?.verdict ?? 'not-run', runs: passes },
    costs: {
      perRun: { before: decisions.cost.before, after: decisions.cost.after },
      total: { before: sum('before'), after: sum('after') },
      endToEnd: decisions.verify?.footprint ?? null,
      tokensPerRun: { before: runsAsked.length ? Math.round(runsAsked.reduce((n, r) => n + tokens(r.tokens.before), 0) / runsAsked.length) : 0, after: runsAsked.length ? Math.round(runsAsked.reduce((n, r) => n + tokens(r.tokens.after), 0) / runsAsked.length) : 0 },
      checking: { decisions: decisions.cost.spent, judge: decisions.judge?.spent ?? 0, verify: decisions.verify?.spent ?? 0 },
    },
    set: { flags: verifyFlags(given, decisions.remedies), fields: decisions.remedies, given },
    configChange: mentions === 'no-git' ? null : mentions,
    retirements: decisions.retirements,
    notes,
    warnings,
    stopReason: decisions.stopReason,
  };
  const report: MigrateReport = { ...base, pullRequest: pullRequestBody(base), files: null };
  const id = newSessionId('migrate', report.at);
  report.files = writeMigrateFiles(report, id);
  const kept: StoreOf<'activity' | 'decisions'> = openStore(input.opts);
  try {
    const { decisions: d, ...rest } = report;
    report.migrateId = keepDecisions(kept, { ...rest, decisions: { ...d, runs: [] }, runs: d.runs, flagged: d.flagged, change: d.change, at: d.at }, 'migrate', id);
  } finally {
    kept.close();
  }
  return report;
}

/** Writes the pull request body and the config change beside the project's store, for a reviewer to copy. */
function writeMigrateFiles(r: MigrateReport, id: string): MigrateReport['files'] {
  const cwd = process.cwd();
  const dir = join(cwd, '.shadowlap', 'migrations', id);
  const rel = (f: string) => relative(cwd, f).split(sep).join('/');
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const body = join(dir, 'pull-request.md');
    writeFileSync(body, `# ${r.pullRequest.title}\n\n${r.pullRequest.body.replace(/^## [^\n]*\n\n/, '')}`);
    let patch: string | null = null;
    if (r.configChange?.patch) {
      patch = join(dir, 'config.patch');
      writeFileSync(patch, r.configChange.patch);
    }
    return { dir: rel(dir), pullRequest: rel(body), patch: patch ? rel(patch) : null };
  } catch {
    return null;
  }
}

/**
 * The report's first line. It claims nothing What still passes doesn't: a run that is inconclusive there
 * (a step not answered, a run that needed verify and did not get it, a recording its checks can't
 * settle) leaves it not settled, and a run that failed as recorded is not one the switch keeps passing.
 * It claims only what ran: a run the preview cleared decided the same there, which is all that is known of it.
 */
function firstLine(r: MigrateReport): string {
  const v = r.passes.verdict;
  const unsure = r.passes.runs.filter((x) => x.verdict === 'inconclusive').length;
  const failing = r.passes.runs.some((x) => x.verdict === 'failed');
  const verified = r.passes.runs.filter((x) => x.verified).length;
  const cleared = r.passes.runs.some((x) => !x.verified && x.verdict === 'passed');
  const kept = !cleared ? `every run${failing ? ' that passed' : ''}` : verified === 1 ? 'the run it verified' : `the ${verified} runs it verified`;
  const head =
    v === 'rejected'
      ? `${p.red('✗')} ${p.bold(`${r.to} breaks runs`)}`
      : unsure
        ? `${p.yellow('!')} ${p.bold('Not settled')}`
        : v === 'accepted'
          ? `${p.green('✓')} ${p.bold(`${r.to} keeps ${kept} passing`)}`
          : verified === 0 && v === 'not-run'
            ? `${p.green('✓')} ${p.bold(`${r.to} decided the same in the preview`)}`
            : `${p.yellow('!')} ${p.bold('Not settled')}`;
  return `${head}: ${r.from.length ? `${r.from.join(', ')} → ` : ''}${r.to}, ${r.decisions.runs.length} run${r.decisions.runs.length === 1 ? '' : 's'}${unsure ? `, ${unsure} inconclusive` : ''}`;
}

/** The report as the terminal shows it: the four blocks in order. */
export function formatMigrate(r: MigrateReport): string {
  const lines: string[] = [];
  lines.push(firstLine(r));
  for (const n of r.retirements) lines.push(p.dim(`  ${safeLine(n.text)}`));
  lines.push('', p.bold('What changes'));
  if (!r.changes.steps.length) lines.push(`  no write, stop or judged change${r.decisions.counts.notAsked ? ' in the steps asked' : ''}`);
  for (const s of r.changes.steps) lines.push(`  ${s.rank === 1 ? p.red(`rank ${s.rank}`) : p.yellow(`rank ${s.rank}`)}  ${safeLine(name(s))} #${s.callNo}  ${safeLine(s.detail)}`, ...(s.arguments.length ? s.arguments.map((a) => p.dim(`          ${a}`)) : [p.dim(`          ${s.recorded} → ${s.now}`)]));
  const c = r.decisions.counts;
  if (c[3] + c[4] + c[5]) lines.push(p.dim(`  besides: ${besides(r)}`));
  lines.push('', p.bold('What still passes'));
  for (const x of r.passes.runs) {
    const word = x.verdict === 'passed' ? p.green(x.verdict) : x.verdict === 'failed' ? p.red(x.verdict) : p.yellow(x.verdict);
    lines.push(`  ${safeLine(name(x)).padEnd(28)} ${word}${p.dim(` · ${passWords(x)}`)}`);
  }
  // The rule the verified runs were decided by, said once under them; each with its own runs when more than one did.
  const rules = verifiedRules(r);
  if (rules.length === 1) lines.push(p.dim(`  ${safeLine(rules[0]!.rule)}`));
  else for (const g of rules) lines.push(p.dim(`  ${safeLine(g.rule)}: ${g.runs.map((x) => safeLine(name(x))).join(', ')}`));
  lines.push(p.dim(`  ${verifiedCount(r.passes.runs)}`));
  lines.push('', p.bold('What it costs'));
  lines.push(`  per run      ${usdOrUnknown(r.costs.perRun.before)} → ${usdOrUnknown(r.costs.perRun.after)}${changePct(r.costs.perRun.before, r.costs.perRun.after)} · ${r.costs.tokensPerRun.before.toLocaleString('en-US')} → ${r.costs.tokensPerRun.after.toLocaleString('en-US')} tokens`);
  if (r.costs.endToEnd) lines.push(`  end to end   ${endToEndWords(r.costs.endToEnd)}`);
  // Asking's models and the judge's with no price: what they cost is not in the figures.
  const unknown = [...new Set([...r.decisions.cost.unknownModels, ...(r.decisions.judge?.unknownModels ?? [])])];
  const unpriced = unknown.length ? ` (no price for ${unknown.join(', ')}: add it under "prices" in shadowlap.config.json)` : '';
  lines.push(p.dim(`  checking it  ${usdOrUnknown(r.costs.checking.decisions)} asking, ${r.decisions.judge ? `${usdOrUnknown(r.costs.checking.judge)} judging, ` : ''}${usdOrUnknown(r.costs.checking.verify)} verifying${unpriced}`));
  lines.push('', p.bold('What to set'));
  if (!r.set.fields.length && !Object.keys(r.set.given).length) lines.push(`  only the model: ${r.to}`);
  for (const f of r.set.fields) lines.push(`  ${remedyText(f)}  ${p.dim(safeLine(f.why))}`);
  for (const [k, v] of Object.entries(r.set.given)) lines.push(`  ${k}=${fieldValue(v)}  ${p.dim('as given')}`);
  if (r.set.flags.length) lines.push(p.dim(`  verify takes them as: ${r.set.flags.join(' ')}`));
  if (r.configChange?.files.length) {
    lines.push('', p.bold('The config change'), ...r.configChange.files.map((f) => `  ${f.path}  ${p.dim(`${f.places} place${f.places === 1 ? '' : 's'}`)}`));
  }
  if (r.configChange?.review.length) {
    lines.push(p.dim(`  left for review:`), ...r.configChange.review.slice(0, 8).map((m) => p.dim(`    ${m.path}:${m.line}  ${m.text}`)), ...(r.configChange.review.length > 8 ? [p.dim(`    and ${r.configChange.review.length - 8} more`)] : []));
  }
  if (r.warnings.length) lines.push('', ...r.warnings.map((w) => `${p.yellow('!')} ${safeLine(w)}`));
  lines.push('', ...r.notes.map((n) => p.dim(`  ${safeLine(n)}`)));
  if (r.files) lines.push(p.dim(`  the pull request body: ${r.files.pullRequest}${r.files.patch ? ` · the config change: ${r.files.patch} (git apply ${r.files.patch})` : ''}`));
  return lines.join('\n');
}
