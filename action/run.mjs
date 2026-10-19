// The GitHub Action's work: find the recordings, run `shadowlap test` on them, report through the
// job summary, annotations and step outputs, and with fix-on-failure open a fix pull request for each
// failed outcome check. Inputs arrive as environment variables from action.yml, so this runs the
// same on a laptop: SHADOWLAP_CLI=... INPUT_RECORDINGS='goldens/*' node action/run.mjs
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fixSummary, runFixes } from './fix.mjs';

const env = process.env;
const input = (name, fallback = '') => (env[`INPUT_${name}`] ?? fallback).trim();
const bool = (name, fallback) => {
  const v = input(name, String(fallback)).toLowerCase();
  if (!['true', 'false'].includes(v)) fail(`input ${name.toLowerCase().replace(/_/g, '-')} must be true or false, not "${v}"`);
  return v === 'true';
};
function fail(message) {
  process.stdout.write(`::error title=Shadowlap::${message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}\n`);
  process.exit(1);
}

const cli = env.SHADOWLAP_CLI;
if (!cli || !existsSync(cli)) fail(`the Shadowlap CLI was not found at ${cli ?? '(unset)'}`);
const workdir = resolve(input('WORKING_DIRECTORY', '.') || '.');
const writes = input('WRITES', 'block');
if (!['block', 'stub', 'allow'].includes(writes)) fail(`input writes must be block, stub or allow, not "${writes}"`);
const guard = input('GUARD', 'block');
if (!['block', 'warn', 'off'].includes(guard)) fail(`input guard must be block, warn or off, not "${guard}"`);
const fixOnFailure = bool('FIX_ON_FAILURE', false);
const budget = Number(input('FIX_BUDGET', '2.00').replace(/^\$/, ''));
if (!Number.isFinite(budget) || budget <= 0) fail(`input fix-budget must be an amount in dollars, such as 2.00, not "${input('FIX_BUDGET')}"`);
const repairer = input('REPAIRER');
if (repairer && !/^(anthropic|openai|claude-code)(:.+)?$/.test(repairer)) fail(`input repairer must be claude-code, anthropic, anthropic:<model> or openai:<model>, not "${repairer}"`);
// The test history, and the runs a fix starts from: the project's store unless one is named.
const store = input('STORE') ? resolve(workdir, input('STORE')) : null;
// The team store: the test runs and the session's report (test --push), then any fix opened.
const push = bool('PUSH', false);

/**
 * The recordings a path or pattern names, as `shadowlap test` reads them. A path as given (or one
 * that exists, a `*` in its name and all) goes to the test whatever is there, so a path that names
 * no pack fails there, as it does on the command line, rather than drop out of the test. A pattern
 * with `*` or `?` in its last part matches the packs in that directory; hidden folders never match.
 */
function expand(pattern) {
  if (existsSync(resolve(workdir, pattern))) return [pattern];
  if (/[*?]/.test(dirname(pattern))) fail(`only the last part of a recordings path may contain a wildcard: ${pattern}`);
  if (!/[*?]/.test(basename(pattern))) return [pattern];
  const dir = resolve(workdir, dirname(pattern));
  if (!existsSync(dir)) return [];
  const re = new RegExp(`^${basename(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
  return readdirSync(dir)
    .filter((name) => re.test(name) && !name.startsWith('.') && statSync(join(dir, name)).isDirectory() && existsSync(join(dir, name, 'run.json')))
    .sort()
    .map((name) => join(dirname(pattern), name));
}
const patterns = input('RECORDINGS', 'goldens/*').split(/[\n\s]+/).filter(Boolean);
const expanded = patterns.map((pattern) => ({ pattern, packs: expand(pattern) }));
// A pattern that matches no pack fails the step, each one named, as shadowlap test refuses one.
const unmatched = expanded.filter((x) => !x.packs.length).map((x) => x.pattern);
if (unmatched.length) fail(`no recordings match ${unmatched.join(' ')} in ${workdir}. A recording is a directory written by shadowlap pack, with a run.json inside.`);
const packs = [...new Set(expanded.flatMap((x) => x.packs))];

const out = mkdtempSync(join(env.RUNNER_TEMP ?? tmpdir(), 'shadowlap-'));
const json = join(out, 'shadowlap-report.json');
const markdown = join(out, 'shadowlap-report.md');
const junit = input('JUNIT') ? resolve(workdir, input('JUNIT')) : join(out, 'shadowlap-junit.xml');
const args = [cli, ...(store ? ['--db', store] : []), 'test', ...packs, '--json', json, '--markdown', markdown, '--junit', junit, '--writes', writes, '--guard', guard];
if (bool('ONLINE', false)) args.push('--online');
if (bool('ANNOTATIONS', true)) args.push('--annotations');
if (push) args.push('--push');
const cliEnv = { ...env, SHADOWLAP_TELEMETRY: env.SHADOWLAP_TELEMETRY ?? '0' };

process.stdout.write(`shadowlap test ${packs.join(' ')}\n`);
const r = spawnSync(process.execPath, args, { cwd: workdir, stdio: 'inherit', env: cliEnv });
if (!existsSync(json)) fail(`shadowlap test did not finish (exit ${r.status ?? r.signal}); its output is above`);

const report = JSON.parse(readFileSync(json, 'utf8'));
const count = (kind) => report.results.filter((x) => !x.ok && x.failure === kind).length;
let fixes = [];
// A session a signal stopped (the job is being cancelled) starts nothing that spends money.
if (report.interrupted) process.stdout.write('shadowlap test was interrupted: the report has the recordings that finished\n');
if (fixOnFailure && report.failed && !report.interrupted) {
  fixes = runFixes({ cli, db: store, workdir, report, budget, repairer, guard, push, env: cliEnv, log: (line) => process.stdout.write(`${line}\n`) });
  for (const f of fixes) {
    if (f.outcome === 'opened') process.stdout.write(`::notice title=Shadowlap::${f.name}: opened ${f.pr}\n`);
    else process.stdout.write(`${f.name}: no fix pull request: ${f.why}\n`);
  }
}
const opened = fixes.filter((f) => f.outcome === 'opened');
const outputs = {
  passed: report.passed,
  failed: report.failed,
  diverged: count('diverged'),
  // A golden whose only shortfall is a check that could not be decided is inconclusive, not a failed check.
  'checks-failed': report.results.filter((x) => !x.ok && x.failure === 'check' && x.verdict !== 'inconclusive').length,
  inconclusive: report.results.filter((x) => x.verdict === 'inconclusive').length,
  session: report.session ?? '',
  fixes: opened.length,
  'fix-prs': opened.map((f) => f.pr).join(' '),
  'report-json': json,
  'report-markdown': markdown,
  junit,
};
if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join(''));
if (bool('SUMMARY', true) && env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, readFileSync(markdown, 'utf8') + (fixes.length ? `\n${fixSummary(fixes, budget)}` : ''));

// Part of the recordings ran when a signal stopped the session: that is never a pass.
if ((report.failed && bool('FAIL_ON_DIVERGENCE', true)) || report.interrupted) process.exit(1);
