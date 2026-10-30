// The GitHub Action's work: find the recordings, run `shadowlap test` on them, report through the
// job summary, annotations and step outputs, with fix-on-failure open a fix pull request for each
// failed outcome check, and on a pull request keep a comment with each golden's verdict. Inputs arrive
// as environment variables from action.yml, so this runs the same on a laptop:
// SHADOWLAP_CLI=... INPUT_RECORDINGS='goldens/*' node action/run.mjs
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commentNote, postComment } from './comment.mjs';
import { refusal } from './events.mjs';
import { fixSummary, runFixes, testPath } from './fix.mjs';
import { githubToken, withoutTokens } from './github.mjs';
import { annotation, logLine } from './log.mjs';

/** @import { Fetch, FixOutcome, Posted, Report, ReportResult } from './types.mjs' */

/**
 * The step's outputs from a test report and the fixes opened, each named once, as action.yml declares
 * them: `failed` counts what fails the step, `inconclusive` every recording whose verdict is
 * inconclusive whatever the inconclusive input made of it, and `checks-failed` definite check
 * failures only.
 * @param {{ passed: number; failed: number; session?: string | null; results: ReportResult[] }} report
 * @param {FixOutcome[]} fixes
 * @param {{ json: string; markdown: string; junit: string }} paths
 * @returns {Record<string, string | number>}
 */
export function outputsOf(report, fixes, paths) {
  const failedAs = (/** @type {string} */ kind) => report.results.filter((x) => !x.ok && x.failure === kind).length;
  const opened = fixes.filter((f) => f.outcome === 'opened');
  return {
    passed: report.passed,
    failed: report.failed,
    inconclusive: report.results.filter((x) => x.verdict === 'inconclusive').length,
    diverged: failedAs('diverged'),
    // A golden whose only shortfall is a check that could not be decided is inconclusive, not a failed check.
    'checks-failed': report.results.filter((x) => !x.ok && x.failure === 'check' && x.verdict !== 'inconclusive').length,
    session: report.session ?? '',
    fixes: opened.length,
    'fix-prs': opened.map((f) => f.pr).join(' '),
    'report-json': paths.json,
    'report-markdown': paths.markdown,
    junit: paths.junit,
  };
}

/**
 * Runs the action as action.yml's step does, and returns its exit code. `fetch` is GitHub's REST API's, which tests replace.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ fetch?: Fetch }} [deps]
 * @returns {Promise<number>}
 */
export async function main(env = process.env, { fetch: fetchFn = globalThis.fetch } = {}) {
  const input = (/** @type {string} */ name, fallback = '') => (env[`INPUT_${name}`] ?? fallback).trim();
  const bool = (/** @type {string} */ name, /** @type {boolean} */ fallback) => {
    const v = input(name, String(fallback)).toLowerCase();
    if (!['true', 'false'].includes(v)) fail(`input ${name.toLowerCase().replace(/_/g, '-')} must be true or false, not "${v}"`);
    return v === 'true';
  };
  /**
   * Ends the step with `message` as an error.
   * @param {string} message
   * @returns {never}
   */
  function fail(message) {
    process.stdout.write(`${annotation('error', message)}\n`);
    process.exit(1);
  }

  // Events that give a job the base repository's secrets and a token that may write, and are how a
  // pull request's code is run beside them: the agent the action runs is whatever the job checked
  // out, and from the event alone it can't tell whose code that is. pull_request runs a pull
  // request's code with what a fork may have; push, schedule and workflow_dispatch run a branch here.
  const refused = refusal(env.GITHUB_EVENT_NAME);
  if (refused) fail(refused);
  const cli = env.SHADOWLAP_CLI;
  if (!cli || !existsSync(cli)) fail(`the Shadowlap CLI was not found at ${cli ?? '(unset)'}`);
  const workdir = resolve(input('WORKING_DIRECTORY', '.') || '.');
  const writes = input('WRITES', 'block');
  if (!['block', 'stub', 'allow'].includes(writes)) fail(`input writes must be block, stub or allow, not "${writes}"`);
  const guard = input('GUARD', 'block');
  if (!['block', 'warn', 'off'].includes(guard)) fail(`input guard must be block, warn or off, not "${guard}"`);
  // What guard block accepts unwatched, as guard.accept in the config: the Claude Code CLI alone.
  const guardAccept = input('GUARD_ACCEPT').split(',').map((v) => v.trim()).filter(Boolean);
  for (const runtime of guardAccept) if (runtime !== 'claude-code') fail(`input guard-accept must be claude-code, not "${runtime}": a Node or Python process whose guard is off still fails guard block`);
  const fixOnFailure = bool('FIX_ON_FAILURE', false);
  const budget = Number(input('FIX_BUDGET', '2.00').replace(/^\$/, ''));
  if (!Number.isFinite(budget) || budget <= 0) fail(`input fix-budget must be an amount in dollars, such as 2.00, not "${input('FIX_BUDGET')}"`);
  const repairer = input('REPAIRER');
  // As shadowlap repair --repairer takes it: an openai repairer names its model.
  if (repairer && !/^(?:(?:anthropic|claude-code)(?::.+)?|openai:.+)$/.test(repairer)) fail(`input repairer must be claude-code, claude-code:<model>, anthropic, anthropic:<model> or openai:<model>, not "${repairer}"`);
  // What builds the agent once a fix changes its source, as shadowlap repair --build runs it.
  const fixBuild = input('FIX_BUILD');
  // The test history, and the runs a fix starts from: the project's store unless one is named.
  const store = input('STORE') ? resolve(workdir, input('STORE')) : null;
  // The team store: the test runs and the session's report (test --push), then any fix opened.
  const push = bool('PUSH', false);
  // What an inconclusive golden does to the step (empty: as shadowlap test does by default), and each gate's limit for this run.
  const inconclusive = input('INCONCLUSIVE').toLowerCase();
  if (inconclusive && !['fail', 'warn'].includes(inconclusive)) fail(`input inconclusive must be fail or warn, or empty, not "${inconclusive}"`);
  const maxAttempts = input('MAX_ATTEMPTS');
  if (maxAttempts && !/^[1-9]\d{0,3}$/.test(maxAttempts)) fail(`input max-attempts must be a whole number of attempts, such as 160, not "${maxAttempts}"`);
  const comment = bool('COMMENT', true);

  /**
   * The recordings a path or pattern names, as `shadowlap test` reads them. A path as given (or one
   * that exists, a `*` in its name and all) goes to the test whatever is there, so a path that names
   * no pack fails there, as it does on the command line, rather than drop out of the test. A pattern
   * with `*` or `?` in its last part matches the packs in that directory; hidden folders never match.
   * @param {string} pattern
   * @returns {string[]}
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
  // A folder named like a flag (`-x`, which `*` finds at the root as `-x`) goes as `./-x`.
  const packs = [...new Set(expanded.flatMap((x) => x.packs).map(testPath))];

  const out = mkdtempSync(join(env.RUNNER_TEMP ?? tmpdir(), 'shadowlap-'));
  const json = join(out, 'shadowlap-report.json');
  const markdown = join(out, 'shadowlap-report.md');
  const junit = input('JUNIT') ? resolve(workdir, input('JUNIT')) : join(out, 'shadowlap-junit.xml');
  const args = [cli, ...(store ? ['--db', store] : []), 'test', ...packs, '--json', json, '--markdown', markdown, '--junit', junit, '--writes', writes, '--guard', guard];
  if (bool('ONLINE', false)) args.push('--online');
  if (inconclusive) args.push('--inconclusive', inconclusive);
  if (maxAttempts) args.push('--max-attempts', maxAttempts);
  if (bool('ANNOTATIONS', true)) args.push('--annotations');
  if (push) args.push('--push');
  // The token the action pushes, opens pull requests and comments with goes to git's push and GitHub's
  // API only: the CLI, and the agent it runs, never get it, nor any other of GitHub's tokens in the job.
  const auth = githubToken(env);
  const cliEnv = { ...withoutTokens(env), SHADOWLAP_TELEMETRY: env.SHADOWLAP_TELEMETRY ?? '0', ...(guardAccept.length ? { SHADOWLAP_GUARD_ACCEPT: [...new Set(guardAccept)].join(',') } : {}) };

  process.stdout.write(`${logLine(`shadowlap test ${packs.join(' ')}`)}\n`);
  const r = spawnSync(process.execPath, args, { cwd: workdir, stdio: 'inherit', env: cliEnv });
  if (!existsSync(json)) fail(`shadowlap test did not finish (exit ${String(r.status ?? r.signal)}); its output is above`);

  const report = /** @type {Report} */ (JSON.parse(readFileSync(json, 'utf8')));
  /** @type {FixOutcome[]} */
  let fixes = [];
  // A session a signal stopped (the job is being cancelled) starts nothing that spends money.
  if (report.interrupted) process.stdout.write('shadowlap test was interrupted: the report has the recordings that finished\n');
  if (fixOnFailure && report.failed && !report.interrupted) {
    fixes = await runFixes({ cli, db: store, workdir, report, budget, repairer, guard, build: fixBuild, push, env: cliEnv, auth, fetch: fetchFn, log: (line) => process.stdout.write(`${line}\n`) });
    for (const f of fixes) {
      // A fix's why can quote a run (a write's recorded error) or git and GitHub: never a workflow command here.
      if (f.outcome === 'opened') process.stdout.write(`${annotation('notice', `${f.name}: opened ${String(f.pr)}`)}\n`);
      else process.stdout.write(`${logLine(`${f.name}: no fix pull request: ${String(f.why)}`)}\n`);
    }
  }
  // On a pull request, one comment with each golden's verdict, edited in place. Never fails the job.
  /** @type {Posted | null} */
  let posted = null;
  if (comment && !report.interrupted) {
    posted = await postComment({ env, auth, report, fixes, store: store ?? join(workdir, '.shadowlap', 'shadowlap.db'), recordings: patterns.join(' '), workdir: input('WORKING_DIRECTORY', '.') || '.', fetch: fetchFn });
    if (posted.state === 'created' || posted.state === 'updated') process.stdout.write(`${logLine(`the pull request comment is ${posted.state === 'created' ? 'posted' : 'updated'}: ${posted.url ?? ''}`)}\n`);
    else if (posted.state === 'failed') process.stdout.write(`${annotation('warning', `the pull request comment was not posted: ${String(posted.why)}`)}\n`);
    else if (posted.state !== 'none') process.stdout.write(`${logLine(`the pull request comment was not posted: ${String(posted.why)}`)}\n`);
  }
  const outputs = outputsOf(report, fixes, { json, markdown, junit });
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join(''));
  if (bool('SUMMARY', true) && env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, readFileSync(markdown, 'utf8') + (fixes.length ? `\n${fixSummary(fixes, budget)}` : '') + commentNote(posted));

  // Part of the recordings ran when a signal stopped the session: that is never a pass.
  return (report.failed && bool('FAIL_ON_DIVERGENCE', true)) || report.interrupted ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (/** @type {unknown} */ err) => {
      process.stdout.write(`${annotation('error', err instanceof Error ? err.message : String(err))}\n`);
      process.exitCode = 1;
    },
  );
}
