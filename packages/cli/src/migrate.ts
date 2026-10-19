import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { argsDelta, formatUsd, RANK_LABELS, safeLine, decisionLine, type DecisionRemedy, type DecisionRun, type DecisionsReport, type DecisionsVerify, type RetirementNotice, type Store } from '@shadowlap/engine';
import { type TestSpec } from './checks.js';
import { keepDecisions, newSessionId, runDecisions, type DecisionTarget } from './decisions.js';
import { type GuardMode } from './run-agent.js';
import { openStore, type GlobalOpts } from './shared.js';
import { palette as p, shortId } from './ui.js';

/**
 * `shadowlap migrate --to <model>`: the decision diff, packaged for a model switch, such as the one
 * a retirement date forces. It asks every model call of the goldens again under the new model, with
 * the fields it refuses changed to what it takes (by the providers' pages and its own refusals);
 * verifies the runs with a write or stop change end to end; compares what a run costs; and ends in
 * one report: what changes, what still passes, what it costs, what to set, with the change to the
 * project's files that names the model and a pull request body to go with it.
 */

export interface MigrateSettings {
  to: string;
  /** Fields the switch sets besides the model, as given (`--set`). */
  fields: Record<string, unknown>;
  samples: number;
  concurrency: number;
  budget: number | null;
  timeoutMs: number | null;
  attempts: number;
  needed: number;
  writes: 'stub' | 'block';
  expect: { spec: TestSpec; json: unknown } | null;
  guard: GuardMode;
  argv: string[] | null;
}

/** How each run fares after the switch: verified (kept, fixed, broken…), unchanged decisions, or not asked. */
export interface MigrateRunPass {
  runId: string;
  golden: string | null;
  /** kept, broken, fixed, still-failing, unsettled (verified); unchanged (no write or stop decision changed, so not re-run); not-asked. */
  outcome: string;
  verified: boolean;
}

export interface MigrateReport {
  migrateId: string | null;
  kind: 'migrate';
  at: number;
  /** The models the recordings use, and the one they switch to. */
  from: string[];
  to: string;
  command: string;
  /** The decision diff under the new model, as `decisions --json` prints it. */
  decisions: DecisionsReport;
  /** What changes: each run's write and stop changes, with the recorded and the new action. */
  changes: { runs: number; flagged: number; steps: Array<{ runId: string; golden: string | null; callNo: number; rank: number; detail: string; recorded: string; now: string; arguments: string[] }> };
  /** What still passes. */
  passes: { verdict: DecisionsVerify['verdict']; runs: MigrateRunPass[] };
  /** What it costs: per run (the mean), and for the goldens all together, before and after; and what checking cost. */
  costs: { perRun: { before: number | null; after: number | null }; total: { before: number | null; after: number | null }; tokensPerRun: { before: number; after: number }; checking: { decisions: number; verify: number } };
  /** What to set: the `--set` flags the switch needs, why each, and what to leave out of the requests. */
  set: { flags: string[]; fields: DecisionRemedy[]; given: Record<string, unknown> };
  /** The change to the project's files that name the model it switches from, or null when none does. */
  configChange: { files: Array<{ path: string; places: number }>; patch: string } | null;
  pullRequest: { title: string; body: string };
  /** Where the pull request body and the patch were written (`.shadowlap/migrations/<id>/`), relative to the project; null when they could not be. */
  files: { dir: string; pullRequest: string; patch: string | null } | null;
  retirements: RetirementNotice[];
  notes: string[];
  warnings: string[];
  stopReason: string | null;
}

const fieldValue = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

/** Files the project tracks or would (not ignored), with text, outside recordings and the store. */
function projectTextFiles(cwd: string): Array<{ path: string; content: string }> | null {
  let listed: string;
  try {
    listed = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }).toString();
  } catch {
    return null;
  }
  const out: Array<{ path: string; content: string }> = [];
  for (const path of listed.split('\0')) {
    if (!path || /(^|\/)(\.shadowlap|node_modules|blobs)\//.test(path) || /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|uv\.lock|poetry\.lock|Cargo\.lock)$/.test(path)) continue;
    // A pack's recording holds the requests the model was sent, not where the agent names it.
    if (/(^|\/)(run\.json|calls\.jsonl)$/.test(path) && existsSync(join(cwd, dirname(path), 'run.json'))) continue;
    try {
      const abs = join(cwd, path);
      if (statSync(abs).size > 1024 * 1024) continue;
      const content = readFileSync(abs, 'utf8');
      if (!content.includes('\u0000')) out.push({ path, content });
    } catch {
      // gone, or unreadable
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
      if (a[i] === b[i]) lines.push(` ${a[i]}`);
      else lines.push(`-${a[i]}`, ...(noEol ? ['\\ No newline at end of file'] : []), `+${b[i]}`);
      if (noEol && a[i] === b[i]) lines.push('\\ No newline at end of file');
    }
  }
  return `${lines.join('\n')}\n`;
}

/** Where the project's files name a model it switches from, and the patch that names the new one there. */
export function modelMentions(cwd: string, from: readonly string[], to: string): MigrateReport['configChange'] | 'no-git' {
  const files = projectTextFiles(cwd);
  if (!files) return 'no-git';
  const names = [...new Set(from.filter((m) => m && m !== to))].sort((x, y) => y.length - x.length);
  if (!names.length) return null;
  const re = new RegExp(`(?<![\\w.-])(${names.map(escape).join('|')})(?![\\w.-])`, 'g');
  const touched: Array<{ path: string; places: number }> = [];
  let patch = '';
  for (const f of files) {
    const places = f.content.match(re)?.length ?? 0;
    if (!places) continue;
    const after = f.content.replace(re, to);
    touched.push({ path: f.path, places });
    patch += inPlaceDiff(f.path, f.content, after);
  }
  return touched.length ? { files: touched, patch } : null;
}

/** The runs' recorded models, each once, most used first. */
function recordedModels(runs: readonly DecisionRun[]): string[] {
  const counts = new Map<string, number>();
  for (const r of runs) for (const s of r.decisions) if (s.model.recorded) counts.set(s.model.recorded, (counts.get(s.model.recorded) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m);
}

const pct = (a: number | null, b: number | null) => (a === null || b === null ? '' : a === 0 ? '' : ` (${b >= a ? '+' : '−'}${Math.round((Math.abs(b - a) / a) * 100)}%)`);
const usd = (n: number | null) => (n === null ? 'unknown' : `≈${formatUsd(n)}`);
const name = (r: { runId: string; golden: string | null }) => r.golden ?? shortId(r.runId);

/** The pull request body: the four blocks, short enough to read on the pull request. */
export function pullRequestBody(r: Omit<MigrateReport, 'pullRequest' | 'files'>): { title: string; body: string } {
  const title = r.from.length === 1 ? `Switch ${r.from[0]} to ${r.to}` : `Switch the model to ${r.to}`;
  const runs = r.decisions.runs.length;
  const lines: string[] = [`## ${title}`, '', `Checked with \`${r.command}\`: every model call of ${runs} recording${runs === 1 ? '' : 's'} asked again under ${r.to}, and the ${r.changes.flagged} with a changed write or stop verified end to end.`];
  for (const n of r.retirements.filter((x) => r.from.includes(x.model))) lines.push('', `> ${n.text} ([source](${n.source}))`);
  lines.push('', '### What changes', '');
  if (!r.changes.steps.length) lines.push('No write and no stop decision changes.');
  for (const s of r.changes.steps.slice(0, 12)) lines.push(`- ${name(s)} #${s.callNo}: ${s.detail} (\`${s.recorded}\` → \`${s.now}\`)${s.arguments.length ? `: ${s.arguments.map((a) => `\`${a}\``).join(', ')}` : ''}`);
  if (r.changes.steps.length > 12) lines.push(`- and ${r.changes.steps.length - 12} more`);
  const c = r.decisions.counts;
  if (c[3] + c[4] + c[5]) lines.push('', `Besides: ${[c[3] && `${c[3]} read added or removed`, c[4] && `${c[4]} read asked differently`, c[5] && `${c[5]} text only`].filter(Boolean).join(', ')}.`);
  lines.push('', '### What still passes', '');
  for (const x of r.passes.runs) lines.push(`- ${name(x)}: ${x.outcome}${x.verified ? '' : x.outcome === 'unchanged' ? ' (no write or stop decision changed)' : ''}`);
  lines.push('', '### What it costs', '', `Per run: ${usd(r.costs.perRun.before)} → ${usd(r.costs.perRun.after)}${pct(r.costs.perRun.before, r.costs.perRun.after)}. Checking it cost ${usd(r.costs.checking.decisions + r.costs.checking.verify)}.`);
  lines.push('', '### What to set', '');
  if (!r.set.flags.length && !r.set.fields.some((f) => f.leftOut)) lines.push(`Only the model: ${r.to}.`);
  for (const f of r.set.fields) lines.push(`- ${f.leftOut ? `leave \`${f.field}\` out` : `\`${f.field}\` = \`${fieldValue(f.value)}\``}: ${f.why}`);
  for (const [k, v] of Object.entries(r.set.given)) lines.push(`- \`${k}\` = \`${fieldValue(v)}\` (given)`);
  if (r.configChange) lines.push('', `The model is named in ${r.configChange.files.map((f) => `\`${f.path}\``).join(', ')}.`);
  return { title, body: `${lines.join('\n')}\n` };
}

/** Runs the decision diff under the new model, verifies the runs it flags, and keeps the report. */
export async function runMigrate(input: { opts: GlobalOpts; targets: DecisionTarget[]; settings: MigrateSettings; command: string; log: (line: string) => void; env?: NodeJS.ProcessEnv; now?: number }): Promise<MigrateReport> {
  const s = input.settings;
  const decisions = await runDecisions({
    opts: input.opts,
    targets: input.targets,
    settings: { model: s.to, fields: s.fields, fromCode: false, samples: s.samples, concurrency: s.concurrency, budget: s.budget, timeoutMs: s.timeoutMs, scope: null, remedies: true, guard: s.guard, argv: s.argv, thenVerify: { attempts: s.attempts, needed: s.needed, writes: s.writes, expect: s.expect } },
    command: input.command,
    log: input.log,
    kind: 'migrate',
    ...(input.env ? { env: input.env } : {}),
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  const from = recordedModels(decisions.runs);
  const verified = new Map((decisions.verify?.runs ?? []).map((r) => [r.runId, r]));
  const passes: MigrateRunPass[] = decisions.runs.map((r) => {
    const v = verified.get(r.runId);
    if (v) return { runId: r.runId, golden: r.golden, outcome: v.outcome, verified: true };
    const unanswered = r.decisions.some((x) => x.samples.asked > 0 && !x.samples.answered) || r.decisions.some((x) => x.error && !x.samples.asked);
    return { runId: r.runId, golden: r.golden, outcome: unanswered ? 'not-asked' : r.rank !== null && r.rank <= 2 ? 'unsettled' : 'unchanged', verified: false };
  });
  const steps = decisions.runs.flatMap((r) =>
    r.decisions
      .filter((x) => x.rank !== null && x.rank <= 2)
      .map((x) => ({ runId: r.runId, golden: r.golden, callNo: x.callNo, rank: x.rank!, detail: x.changes[0]?.detail ?? RANK_LABELS[x.rank!], recorded: decisionLine(x.recorded, 60), now: decisionLine(x.now, 60), arguments: x.changes.filter((c) => c.kind === 'write-arguments').flatMap((c) => argsDelta(c.before, c.after).map((d) => `${c.tool}.${d}`)) })),
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
  const flags = [...Object.entries(given), ...decisions.remedies.filter((r) => !r.leftOut).map((r) => [r.field, r.value] as const)].map(([k, v]) => `--set ${k}=${fieldValue(v)}`);
  const mentions = modelMentions(process.cwd(), from, s.to);
  const notes = [...decisions.notes];
  if (mentions === 'no-git') notes.push('The project is not a git repository, so its files were not searched for the model it switches from.');
  else if (mentions === null && from.length) notes.push(`No file in the project names ${from.join(' or ')}: set ${s.to} where your agent reads its model (an environment variable, a deployment setting).`);
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
      tokensPerRun: { before: runsAsked.length ? Math.round(runsAsked.reduce((n, r) => n + tokens(r.tokens.before), 0) / runsAsked.length) : 0, after: runsAsked.length ? Math.round(runsAsked.reduce((n, r) => n + tokens(r.tokens.after), 0) / runsAsked.length) : 0 },
      checking: { decisions: decisions.cost.spent, verify: decisions.verify?.spent ?? 0 },
    },
    set: { flags, fields: decisions.remedies, given },
    configChange: mentions === 'no-git' ? null : mentions,
    retirements: decisions.retirements,
    notes,
    warnings: decisions.warnings,
    stopReason: decisions.stopReason,
  };
  const report: MigrateReport = { ...base, pullRequest: pullRequestBody(base), files: null };
  const id = newSessionId('migrate', report.at);
  report.files = writeMigrateFiles(report, id);
  const store: Store = openStore(input.opts);
  try {
    const { decisions: d, ...rest } = report;
    report.migrateId = keepDecisions(store, { ...rest, decisions: { ...d, runs: [] }, runs: d.runs, flagged: d.flagged, change: d.change, at: d.at }, 'migrate', id);
  } finally {
    store.close();
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

/** The report as the terminal shows it: the four blocks in order. */
export function formatMigrate(r: MigrateReport): string {
  const lines: string[] = [];
  const v = r.passes.verdict;
  const head = r.changes.flagged === 0 ? `${p.green('✓')} ${p.bold(`No write or stop decision changes under ${r.to}`)}` : v === 'accepted' ? `${p.green('✓')} ${p.bold(`${r.to} keeps every run passing`)}` : v === 'rejected' ? `${p.red('✗')} ${p.bold(`${r.to} breaks runs`)}` : `${p.yellow('!')} ${p.bold('Not settled')}`;
  lines.push(`${head}: ${r.from.length ? `${r.from.join(', ')} → ` : ''}${r.to}, ${r.decisions.runs.length} run${r.decisions.runs.length === 1 ? '' : 's'}`);
  for (const n of r.retirements) lines.push(p.dim(`  ${safeLine(n.text)}`));
  lines.push('', p.bold('What changes'));
  if (!r.changes.steps.length) lines.push('  no write and no stop decision changes');
  for (const s of r.changes.steps) lines.push(`  ${s.rank === 1 ? p.red(`rank ${s.rank}`) : p.yellow(`rank ${s.rank}`)}  ${safeLine(name(s))} #${s.callNo}  ${safeLine(s.detail)}`, ...(s.arguments.length ? s.arguments.map((a) => p.dim(`          ${a}`)) : [p.dim(`          ${s.recorded} → ${s.now}`)]));
  const c = r.decisions.counts;
  if (c[3] + c[4] + c[5]) lines.push(p.dim(`  besides: ${[c[3] && `${c[3]} read added or removed`, c[4] && `${c[4]} read asked differently`, c[5] && `${c[5]} text only`].filter(Boolean).join(', ')}`));
  lines.push('', p.bold('What still passes'));
  for (const x of r.passes.runs) {
    const word = x.outcome === 'kept' || x.outcome === 'fixed' || x.outcome === 'unchanged' ? p.green(x.outcome) : x.outcome === 'broken' || x.outcome === 'still-failing' ? p.red(x.outcome) : p.yellow(x.outcome);
    lines.push(`  ${safeLine(name(x)).padEnd(28)} ${word}${x.verified ? p.dim(' · verified') : x.outcome === 'unchanged' ? p.dim(' · no write or stop decision changed, not re-run') : ''}`);
  }
  lines.push('', p.bold('What it costs'));
  lines.push(`  per run      ${usd(r.costs.perRun.before)} → ${usd(r.costs.perRun.after)}${pct(r.costs.perRun.before, r.costs.perRun.after)} · ${r.costs.tokensPerRun.before.toLocaleString('en-US')} → ${r.costs.tokensPerRun.after.toLocaleString('en-US')} tokens`);
  const unpriced = r.decisions.cost.unknownModels.length ? ` (no price for ${r.decisions.cost.unknownModels.join(', ')}: add it under "prices" in shadowlap.config.json)` : '';
  lines.push(p.dim(`  checking it  ${usd(r.costs.checking.decisions)} asking, ${usd(r.costs.checking.verify)} verifying${unpriced}`));
  lines.push('', p.bold('What to set'));
  if (!r.set.flags.length && !r.set.fields.some((f) => f.leftOut)) lines.push(`  only the model: ${r.to}`);
  for (const f of r.set.fields) lines.push(`  ${f.leftOut ? `leave ${f.field} out` : `${f.field}=${fieldValue(f.value)}`}  ${p.dim(safeLine(f.why))}`);
  for (const [k, v] of Object.entries(r.set.given)) lines.push(`  ${k}=${fieldValue(v)}  ${p.dim('as given')}`);
  if (r.set.flags.length) lines.push(p.dim(`  verify takes them as: ${r.set.flags.join(' ')}`));
  if (r.configChange) {
    lines.push('', p.bold('The config change'), ...r.configChange.files.map((f) => `  ${f.path}  ${p.dim(`${f.places} place${f.places === 1 ? '' : 's'}`)}`));
  }
  if (r.warnings.length) lines.push('', ...r.warnings.map((w) => `${p.yellow('!')} ${safeLine(w)}`));
  lines.push('', ...r.notes.map((n) => p.dim(`  ${safeLine(n)}`)));
  if (r.files) lines.push(p.dim(`  the pull request body: ${r.files.pullRequest}${r.files.patch ? ` · the config change: ${r.files.patch} (git apply ${r.files.patch})` : ''}`));
  return lines.join('\n');
}
