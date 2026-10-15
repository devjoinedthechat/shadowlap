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

/**
 * A pattern with `*` or `?` in its last path segment, matched against that directory; anything else
 * as given. Hidden folders never match, as in `shadowlap test` itself.
 */
function expand(pattern) {
  if (/[*?]/.test(dirname(pattern))) fail(`only the last part of a recordings path may contain a wildcard: ${pattern}`);
  if (!/[*?]/.test(basename(pattern))) return [pattern];
  const dir = resolve(workdir, dirname(pattern));
  if (!existsSync(dir)) return [];
  const re = new RegExp(`^${basename(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
  return readdirSync(dir)
    .filter((name) => re.test(name) && !name.startsWith('.') && statSync(join(dir, name)).isDirectory())
    .sort()
    .map((name) => join(dirname(pattern), name));
}
const patterns = input('RECORDINGS', 'goldens/*').split(/[\n\s]+/).filter(Boolean);
const packs = [...new Set(patterns.flatMap(expand))].filter((p) => existsSync(join(resolve(workdir, p), 'run.json')));
if (packs.length === 0) fail(`no recordings found for ${patterns.join(' ')} in ${workdir}. A recording is a directory written by shadowlap pack, with a run.json inside.`);

const out = mkdtempSync(join(env.RUNNER_TEMP ?? tmpdir(), 'shadowlap-'));
const json = join(out, 'shadowlap-report.json');
const markdown = join(out, 'shadowlap-report.md');
const junit = input('JUNIT') ? resolve(workdir, input('JUNIT')) : join(out, 'shadowlap-junit.xml');
const args = [cli, ...(store ? ['--db', store] : []), 'test', ...packs, '--json', json, '--markdown', markdown, '--junit', junit, '--writes', writes, '--guard', guard];
if (bool('ONLINE', false)) args.push('--online');
if (bool('ANNOTATIONS', true)) args.push('--annotations');
const cliEnv = { ...env, SHADOWLAP_TELEMETRY: env.SHADOWLAP_TELEMETRY ?? '0' };

process.stdout.write(`shadowlap test ${packs.join(' ')}\n`);
const r = spawnSync(process.execPath, args, { cwd: workdir, stdio: 'inherit', env: cliEnv });
if (!existsSync(json)) fail(`shadowlap test did not finish (exit ${r.status ?? r.signal}); its output is above`);

const report = JSON.parse(readFileSync(json, 'utf8'));
const count = (kind) => report.results.filter((x) => !x.ok && x.failure === kind).length;
let fixes = [];
if (fixOnFailure && report.failed) {
  fixes = runFixes({ cli, db: store, workdir, report, budget, repairer, env: cliEnv, log: (line) => process.stdout.write(`${line}\n`) });
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
  'checks-failed': count('check'),
  session: report.session ?? '',
  fixes: opened.length,
  'fix-prs': opened.map((f) => f.pr).join(' '),
  'report-json': json,
  'report-markdown': markdown,
  junit,
};
if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join(''));
if (bool('SUMMARY', true) && env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, readFileSync(markdown, 'utf8') + (fixes.length ? `\n${fixSummary(fixes, budget)}` : ''));

if (report.failed && bool('FAIL_ON_DIVERGENCE', true)) process.exit(1);
