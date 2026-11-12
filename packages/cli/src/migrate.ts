import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { argsDelta, besidesWords, byRule, changePct, CLEARED, controlOpen, credentialFreeCommandLine, decisionLine, endToEndWords, fieldValue, byHandNote, handOf, judgeOpen, leftBehindLines, leftBehindSentence, leftOutInFile, migrateApplyProblem, migrateHeadline, namedInSentence, quoteArgv, RANK_LABELS, remedyText, safeLine, sameModel, shortSessionId, usdOrUnknown, verifiedCount, verifiedWords, type DecisionRemedy, type DecisionRun, type DecisionsReport, type DecisionsVerify, type Footprint, type LeftBehind, type RetirementNotice, type SprtGate, type Store, type StoreOf, type VerifyTally } from '@shadowlap/engine';
import { judgeRecording } from './attempts.js';
import { type TestSpec } from './checks.js';
import { loadConfig } from './config.js';
import { keepDecisions, newSessionId, runDecisions, type DecisionTarget } from './decisions.js';
import { modelMentions, type ConfigChange } from './migrate-mentions.js';
import { type GuardMode } from './run-agent.js';
import { openStore, type GlobalOpts } from './shared.js';
import { palette as p, shortId } from './ui.js';

export { lineDiff, modelMentions, type ConfigChange, type ModelMention } from './migrate-mentions.js';
export { remedyText } from '@shadowlap/engine';

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
  tally: { passes: number; attempts: number; bound: string | null; rule: string | null; undecided?: string | null; baseline?: { passes: number; attempts: number } | null; parts?: VerifyTally | null } | null;
  /**
   * Where a golden diverges once the config change is in: one that replays exactly (not marked `fork`)
   * and makes a call with a model the switch changes diverges on `$.model` at the first such call,
   * until it is re-recorded under the new model. Null for a run, a golden that forks, and when no file
   * names the model.
   */
  diverges: { callNo: number; path: '$.model' } | null;
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
  /**
   * What to set: the flags verify took, the fields the switch needs and why, those given with `--set`,
   * and `byHand`, the names of those the config change leaves for the hand: each field it doesn't take
   * out, and each one given, which verify ran with and no patch writes.
   */
  set: { flags: string[]; fields: DecisionRemedy[]; given: Record<string, unknown>; byHand: string[] };
  /** The change to the project's files (migrate-mentions.ts); null when no file names a model it switches from. */
  configChange: ConfigChange | null;
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

const name = (r: { runId: string; golden: string | null }) => r.golden ?? shortId(r.runId);

/** The goldens the config change leaves behind, each with the first call it makes with a model the switch changes, and the command that re-records them. */
export function leftBehind(r: Pick<MigrateReport, 'passes'>): { left: LeftBehind[]; update: string } {
  const left = r.passes.runs.flatMap((x) => (x.diverges && x.golden ? [{ golden: x.golden, callNo: x.diverges.callNo }] : []));
  return { left, update: quoteArgv(['shadowlap', 'test', ...left.map((x) => x.golden), '--update']) };
}

/** The fields the config change takes out, each once, in the order it found them. */
const takenOut = (c: ConfigChange | null): string[] => [...new Set((c?.leftOut ?? []).map((x) => x.field))];

/** What still passes in the pull request: each run, the rule verify decided them by, how many ran end to end, and the goldens the switch leaves behind. */
function passesBlock(r: Omit<MigrateReport, 'pullRequest' | 'files'>, tick: (s: string) => string): string[] {
  const lines = ['', '### What still passes', ''];
  for (const x of r.passes.runs) lines.push(`- ${name(x)}: ${x.verdict} (${passWords(x)})`);
  // The rule verify decided them by, said once; each over its own runs when more than one did.
  const rules = verifiedRules(r);
  if (rules.length === 1) lines.push('', `Verified by ${tick('shadowlap verify')}, ${rules[0]!.rule}.`);
  else if (rules.length) lines.push('', `Verified by ${tick('shadowlap verify')}, each run under the rule that decided it:`, '', ...rules.map((g) => `- ${g.runs.map(name).join(', ')}: ${g.rule}`));
  lines.push('', `${verifiedCount(r.passes.runs)}.`);
  if (r.decisions.verify?.verdict === 'not-run' && r.decisions.verify.reasons.length) lines.push('', `Not verified yet: ${r.decisions.verify.reasons.join('; ')}.`);
  for (const w of r.decisions.verify?.warnings ?? []) lines.push('', `Note: ${w}.`);
  const { left, update } = leftBehind(r);
  if (left.length) lines.push('', leftBehindSentence(left, r.to, update, tick));
  return lines;
}

/** What to set in the pull request: each field and why, those given, and where the model is named, with what the config change takes out. */
function setBlock(r: Omit<MigrateReport, 'pullRequest' | 'files'>, tick: (s: string) => string): string[] {
  const lines = ['', '### What to set', ''];
  if (!r.set.fields.length && !Object.keys(r.set.given).length) lines.push(`Only the model: ${r.to}.`);
  for (const f of r.set.fields) lines.push(`- ${remedyText(f, tick)}: ${f.why}`);
  for (const [k, v] of Object.entries(r.set.given)) lines.push(`- ${tick(k)} = ${tick(fieldValue(v))} (given)`);
  if (r.configChange?.files.length) lines.push('', namedInSentence(r.configChange.files.map((f) => f.path), takenOut(r.configChange), tick));
  if (r.configChange?.review.length) lines.push('', `Left as they are, for review: ${r.configChange.review.length} other mention${r.configChange.review.length === 1 ? '' : 's'} in ${[...new Set(r.configChange.review.map((x) => x.path))].slice(0, 6).map(tick).join(', ')}.`);
  return lines;
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
  if (c[3] + c[4] + c[5]) lines.push('', `Besides: ${besidesWords(r.decisions)}.`);
  lines.push(...passesBlock(r, tick));
  lines.push('', '### What it costs', '', costsSentence(r));
  lines.push(...setBlock(r, tick));
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
    if (v) return { runId: r.runId, golden: r.golden, verdict: v.outcome === 'kept' || v.outcome === 'fixed' ? 'passed' : v.outcome === 'broken' || v.outcome === 'not-fixed' ? 'failed' : 'inconclusive', outcome: v.outcome, verified: true, tally: { passes: v.passes, attempts: v.attempts, bound: v.bound ?? null, rule: v.rule ?? verify?.rule ?? null, undecided: v.undecided ?? null, ...(v.baseline ? { baseline: v.baseline } : {}), ...(v.parts ? { parts: v.parts } : {}) }, diverges: null };
    // A step whose request as recorded got no answer for now waits on it (controlOpen): its change is not told from the model's own.
    const unanswered = r.decisions.some((x) => x.samples.asked > 0 && !x.samples.answered) || r.decisions.some((x) => x.error && !x.samples.asked) || (!toVerify.includes(r.runId) && r.decisions.some((x) => controlOpen(x)));
    if (unanswered) return { runId: r.runId, golden: r.golden, verdict: 'inconclusive', outcome: 'not-asked', verified: false, tally: null, diverges: null };
    if (toVerify.includes(r.runId)) return { runId: r.runId, golden: r.golden, verdict: 'inconclusive', outcome: 'unsettled', verified: false, tally: null, diverges: null };
    if (r.decisions.some((x) => judgeOpen(x))) return { runId: r.runId, golden: r.golden, verdict: 'inconclusive', outcome: 'not-judged', verified: false, tally: null, diverges: null };
    const passed = recorded(r.runId);
    return { runId: r.runId, golden: r.golden, verdict: passed === true ? 'passed' : passed === false ? 'failed' : 'inconclusive', outcome: 'unchanged', verified: false, tally: null, diverges: null };
  });
}

/**
 * Marks each golden the config change leaves behind (`diverges`): one that replays exactly, since a
 * golden marked `fork` passes on its checks wherever it forks, and makes a call with a model the
 * switch changes, at the first such call. Which agent reads the files the patch changes can't be told,
 * so every such golden is named, "once applied": `migrate apply` replays them to see.
 */
function markDiverges(passes: MigrateRunPass[], runs: readonly DecisionRun[], targets: readonly DecisionTarget[], from: readonly string[]): void {
  for (const x of passes) {
    const t = targets.find((y) => y.run.runId === x.runId);
    // Its tests entry says whether `shadowlap test` lets it fork, whatever checks verify took.
    if (!x.golden || !t || t.spec?.fork) continue;
    const steps = runs.find((r) => r.runId === x.runId)?.decisions ?? [];
    const first = steps.filter((d) => from.some((m) => sameModel(d.model.recorded, m))).sort((a, b) => a.callNo - b.callNo)[0];
    if (first) x.diverges = { callNo: first.callNo, path: '$.model' };
  }
}

/** The names of the fields the config change leaves for the hand: each the patch doesn't take out, and each given, which no patch writes. */
function byHandOf(remedies: readonly DecisionRemedy[], given: Record<string, unknown>, change: ConfigChange | null): string[] {
  const out = new Set(takenOut(change));
  return [...remedies.map((f) => f.field).filter((f) => !out.has(f)), ...Object.keys(given)];
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
  const mentions = modelMentions(process.cwd(), from, s.to, decisions.remedies);
  const change = mentions === 'no-git' ? null : mentions;
  if (change?.files.length) markDiverges(passes, decisions.runs, input.targets, from);
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
    set: { flags: verifyFlags(given, decisions.remedies), fields: decisions.remedies, given, byHand: byHandOf(decisions.remedies, given, change) },
    configChange: change,
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

/** The report's first line, from the engine's words (migrateHeadline): its mark, the words, then the switch. */
function firstLine(r: MigrateReport): string {
  const h = migrateHeadline({ from: r.from, to: r.to, runs: r.decisions.runs.length, passes: r.passes });
  const mark = h.tone === 'fail' ? p.red('✗') : h.tone === 'pass' ? p.green('✓') : p.yellow('!');
  return `${mark} ${p.bold(h.text)}: ${h.rest}`;
}

/** What changes: each write, stop and judged change, then what changed besides. */
function changesLines(r: MigrateReport): string[] {
  const lines = ['', p.bold('What changes')];
  if (!r.changes.steps.length) lines.push(`  no write, stop or judged change${r.decisions.counts.notAsked ? ' in the steps asked' : ''}`);
  for (const s of r.changes.steps) lines.push(`  ${s.rank === 1 ? p.red(`rank ${s.rank}`) : p.yellow(`rank ${s.rank}`)}  ${safeLine(name(s))} #${s.callNo}  ${safeLine(s.detail)}`, ...(s.arguments.length ? s.arguments.map((a) => p.dim(`          ${a}`)) : [p.dim(`          ${s.recorded} → ${s.now}`)]));
  const c = r.decisions.counts;
  if (c[3] + c[4] + c[5]) lines.push(p.dim(`  besides: ${besidesWords(r.decisions)}`));
  return lines;
}

/** What still passes: each run, the rule the verified runs were decided by, how many ran end to end, and the goldens the config change leaves behind. */
function passesLines(r: MigrateReport): string[] {
  const lines = ['', p.bold('What still passes')];
  for (const x of r.passes.runs) {
    const word = x.verdict === 'passed' ? p.green(x.verdict) : x.verdict === 'failed' ? p.red(x.verdict) : p.yellow(x.verdict);
    lines.push(`  ${safeLine(name(x)).padEnd(28)} ${word}${p.dim(` · ${passWords(x)}`)}`);
  }
  // The rule the verified runs were decided by, said once under them; each with its own runs when more than one did.
  const rules = verifiedRules(r);
  if (rules.length === 1) lines.push(p.dim(`  ${safeLine(rules[0]!.rule)}`));
  else for (const g of rules) lines.push(p.dim(`  ${safeLine(g.rule)}: ${g.runs.map((x) => safeLine(name(x))).join(', ')}`));
  lines.push(p.dim(`  ${verifiedCount(r.passes.runs)}`));
  const { left, update } = leftBehind(r);
  const [head, then] = leftBehindLines(left.map((x) => ({ ...x, golden: safeLine(x.golden) })), r.to, update);
  if (head) lines.push(`  ${p.yellow('!')} ${head}`, p.dim(`    ${then!}`));
  return lines;
}

/** What it costs: per run, end to end, and checking it, with the models no price covers. */
function costsLines(r: MigrateReport): string[] {
  const lines = ['', p.bold('What it costs')];
  lines.push(`  per run      ${usdOrUnknown(r.costs.perRun.before)} → ${usdOrUnknown(r.costs.perRun.after)}${changePct(r.costs.perRun.before, r.costs.perRun.after)} · ${r.costs.tokensPerRun.before.toLocaleString('en-US')} → ${r.costs.tokensPerRun.after.toLocaleString('en-US')} tokens`);
  if (r.costs.endToEnd) lines.push(`  end to end   ${endToEndWords(r.costs.endToEnd)}`);
  // Asking's models and the judge's with no price: what they cost is not in the figures.
  const unknown = [...new Set([...r.decisions.cost.unknownModels, ...(r.decisions.judge?.unknownModels ?? [])])];
  const unpriced = unknown.length ? ` (no price for ${unknown.join(', ')}: add it under "prices" in shadowlap.config.json)` : '';
  lines.push(p.dim(`  checking it  ${usdOrUnknown(r.costs.checking.decisions)} asking, ${r.decisions.judge ? `${usdOrUnknown(r.costs.checking.judge)} judging, ` : ''}${usdOrUnknown(r.costs.checking.verify)} verifying${unpriced}`));
  return lines;
}

/** What to set: each field and why, those given, and the flags verify took them as. */
function setLines(r: MigrateReport): string[] {
  const lines = ['', p.bold('What to set')];
  if (!r.set.fields.length && !Object.keys(r.set.given).length) lines.push(`  only the model: ${r.to}`);
  for (const f of r.set.fields) lines.push(`  ${remedyText(f)}  ${p.dim(safeLine(f.why))}`);
  for (const [k, v] of Object.entries(r.set.given)) lines.push(`  ${k}=${fieldValue(v)}  ${p.dim('as given')}`);
  if (r.set.flags.length) lines.push(p.dim(`  verify takes them as: ${r.set.flags.join(' ')}`));
  return lines;
}

/** The config change: each file with its places and the fields it takes out there, what it leaves for the hand, and the mentions left for review. */
function configLines(r: MigrateReport): string[] {
  const c = r.configChange;
  const lines: string[] = [];
  if (c?.files.length) {
    const fieldsIn = (path: string) => [...new Set(c.leftOut.filter((x) => x.path === path).map((x) => x.field))];
    lines.push('', p.bold('The config change'), ...c.files.map((f) => `  ${f.path}  ${p.dim(`${f.places} place${f.places === 1 ? '' : 's'}${leftOutInFile(fieldsIn(f.path))}`)}`));
    const hand = handOf(r.set);
    if (hand.length) lines.push(`  ${p.yellow('by hand:')} ${byHandWordsOf(hand)}`);
  }
  if (c?.review.length) {
    lines.push(p.dim(`  left for review:`), ...c.review.slice(0, 8).map((m) => p.dim(`    ${m.path}:${m.line}  ${m.text}`)), ...(c.review.length > 8 ? [p.dim(`    and ${c.review.length - 8} more`)] : []));
  }
  return lines;
}

/** The terminal's by-hand line, after `by hand:`: the engine's note without its `Also` and full stop. */
const byHandWordsOf = (hand: ReturnType<typeof handOf>): string => byHandNote(hand).replace(/^Also /, '').replace(/\.$/, '');

/** Where the report's files are, and how the config change goes in: `migrate apply` where nothing stands in its way, else git apply. */
function filesLine(r: MigrateReport): string | null {
  if (!r.files) return null;
  const apply = r.files.patch && r.migrateId && !migrateApplyProblem(r) ? `shadowlap migrate apply ${shortSessionId(r.migrateId)}, or ` : '';
  return p.dim(`  the pull request body: ${r.files.pullRequest}${r.files.patch ? ` · the config change: ${r.files.patch} (${apply}git apply ${r.files.patch})` : ''}`);
}

/** The report as the terminal shows it: the four blocks in order, the config change, then what to know. */
export function formatMigrate(r: MigrateReport): string {
  const lines: string[] = [firstLine(r)];
  for (const n of r.retirements) lines.push(p.dim(`  ${safeLine(n.text)}`));
  lines.push(...changesLines(r), ...passesLines(r), ...costsLines(r), ...setLines(r), ...configLines(r));
  if (r.warnings.length) lines.push('', ...r.warnings.map((w) => `${p.yellow('!')} ${safeLine(w)}`));
  lines.push('', ...r.notes.map((n) => p.dim(`  ${safeLine(n)}`)));
  const files = filesLine(r);
  if (files) lines.push(files);
  return lines.join('\n');
}
