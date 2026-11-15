#!/usr/bin/env node
// The verdict study: how often is a `shadowlap verify` verdict right?
//
// For each planted change (changes.mjs) it measures what the change really does, by running the
// changed agent live many times and judging each run by the oracle, then asks `shadowlap verify`
// as a developer would and scores its verdict against that measurement. A verdict that accepts a
// change which breaks a run is a false accept; one that rejects a change which breaks nothing is a
// false reject.
//
//   node --env-file=.env testing/verdict-study/study.mjs --out <folder> [options]
//
//   --out <folder>     where the projects, their stores and the results go; a run that stopped is
//                      taken up again from the same folder
//   --mock             a dry run against a stand-in model (mock.mjs): nothing is spent
//   --truth <n>        live runs that measure a change, for each order (default 20)
//   --cap <usd>        start nothing more once this much is spent (default 15)
//   --only <id,id>     these changes alone
//   --model <id>       the subject's model (default claude-haiku-4-5)
//
// It needs ANTHROPIC_API_KEY, unless --mock. Every model call it makes is the subject's own, through
// shadowlap, to the provider: a few thousand small requests for the whole corpus.
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROKEN_PROMPT, CHANGES, SUITES } from './changes.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = resolve(HERE, '../..');
const CLI = join(REPO, 'packages/cli/bin/shadowlap.js');
const ORACLE = join(HERE, 'oracle.json');

const flag = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? fallback : process.argv[at + 1];
};
const OUT = resolve(flag('out', ''));
const MOCK = process.argv.includes('--mock');
const TRUTH = Number(flag('truth', 20));
const CAP = Number(flag('cap', 15));
const ONLY = flag('only', '')?.split(',').filter(Boolean) ?? [];
const MODEL = flag('model', 'claude-haiku-4-5');
if (!flag('out', '')) throw new Error('give a folder for the results: --out <folder>');
if (!MOCK && !process.env.ANTHROPIC_API_KEY) throw new Error('set ANTHROPIC_API_KEY, or pass --mock for a dry run');

const say = (line) => process.stderr.write(`${line}\n`);
const RESULTS = join(OUT, 'results.json');
/** What the study has measured so far, kept after every step so a stopped run is taken up again. */
const results = existsSync(RESULTS) ? JSON.parse(readFileSync(RESULTS, 'utf8')) : { model: MODEL, mock: MOCK, truthRuns: TRUTH, spent: 0, suites: {}, changes: {} };
const save = () => writeFileSync(RESULTS, `${JSON.stringify(results, null, 2)}\n`);

let upstream = null;
const env = () => ({
  ...process.env,
  NO_COLOR: '1',
  SHADOWLAP_TELEMETRY: '0',
  SHADOWLAP_GUARD: 'off',
  SHADOWLAP_HOME: join(OUT, 'home'),
  STUDY_MODEL: MODEL,
  ...(upstream ? { SHADOWLAP_UPSTREAM_ANTHROPIC: upstream, ANTHROPIC_API_KEY: 'none' } : {}),
});

/** Runs the CLI in a project against one of its stores. */
function shadowlap(project, db, args) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [CLI, '--db', join(project, db), ...args], { cwd: project, env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('exit', (code) => done({ code, out, err }));
  });
}

/** `tasks` run `limit` at a time, their results in order. */
async function pooled(tasks, limit) {
  const done = [];
  let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (next < tasks.length) {
      const at = next++;
      done[at] = await tasks[at]();
    }
  }));
  return done;
}

const git = (project, ...args) => execFileSync('git', args, { cwd: project, stdio: 'ignore' });

/** A suite's project: a git repository holding the subject, below a link to the repository's packages. */
function projectOf(suite) {
  const base = join(OUT, suite);
  const project = join(base, 'project');
  if (existsSync(join(project, '.git'))) return project;
  mkdirSync(project, { recursive: true });
  symlinkSync(join(REPO, 'node_modules'), join(base, 'node_modules'), 'junction');
  cpSync(join(HERE, 'subject'), project, { recursive: true });
  if (suite === 'fixes') writeFileSync(join(project, 'prompt.txt'), BROKEN_PROMPT);
  writeFileSync(join(project, '.gitignore'), '*.db*\n.shadowlap/\n');
  git(project, 'init', '-q');
  git(project, 'config', 'user.email', 'study@example.com');
  git(project, 'config', 'user.name', 'Study');
  git(project, 'add', '.');
  git(project, 'commit', '-q', '-m', 'the subject');
  return project;
}

/** Records one run of the subject on an order, and returns its id. */
async function record(project, db, order) {
  const r = await shadowlap(project, db, ['run', '--', process.execPath, join(project, 'agent.mjs'), order]);
  const id = /recording run (\w{26})/.exec(r.out + r.err)?.[1];
  if (!id) throw new Error(`no run was recorded for ${order}:\n${r.out}${r.err}`);
  return id;
}

/** Each of the runs judged by the oracle from its recording: whether it passed, and what it spent. */
async function judged(project, db, ids) {
  const r = await shadowlap(project, db, ['check', ...ids, '--expect', `@${ORACLE}`, '--json']);
  let report;
  try {
    report = JSON.parse(r.out);
  } catch {
    throw new Error(`check printed no report:\n${r.out}${r.err}`);
  }
  const spent = await pooled(ids.map((id) => async () => JSON.parse((await shadowlap(project, db, ['show', id, '--json'])).out).summary.cost.spent ?? 0), 6);
  return ids.map((id, at) => ({ runId: id, passed: report.recordings.find((run) => run.runId === id)?.outcome === 'passed', cost: spent[at] }));
}

/** What the subject does on an order as the working tree has it: `n` live runs, judged. */
async function measure(project, order, n) {
  const ids = await pooled(Array.from({ length: n }, () => () => record(project, 'truth.db', order)), 4);
  const runs = await judged(project, 'truth.db', ids);
  results.spent += runs.reduce((sum, run) => sum + run.cost, 0);
  return { passed: runs.filter((run) => run.passed).length, runs: n };
}

/** A recording of the order that fares as its role needs: a good run passes, a run to fix fails. */
async function recordAs(project, order, passes) {
  for (let tries = 0; tries < 6; tries++) {
    const id = await record(project, 'store.db', order);
    const [run] = await judged(project, 'store.db', [id]);
    results.spent += run.cost;
    if (run.passed === passes) return id;
  }
  throw new Error(`six recordings of ${order} and none ${passes ? 'passed' : 'failed'} the oracle: the subject is not what the suite takes it for`);
}

/** A suite's project with its runs recorded and what the unchanged subject does measured, once. */
async function prepared(suite) {
  const project = projectOf(suite);
  if (results.suites[suite]) return project;
  say(`${suite}: recording its runs and measuring the unchanged subject`);
  const roles = SUITES[suite];
  const runs = { good: {}, fixes: {}, holdout: {} };
  for (const order of roles.good) {
    runs.good[order] = await recordAs(project, order, true);
    await shadowlap(project, 'store.db', ['label', runs.good[order], 'good']);
  }
  for (const order of roles.fixes) runs.fixes[order] = await recordAs(project, order, false);
  for (const order of roles.holdout) runs.holdout[order] = await recordAs(project, order, false);
  const base = {};
  for (const order of [...roles.good, ...roles.fixes, ...roles.holdout]) base[order] = await measure(project, order, TRUTH);
  results.suites[suite] = { runs, base };
  save();
  return project;
}

/** One verify of the working tree's change, as its report's verdict, each run's outcome and the cost. */
async function verify(project, suite, extra = []) {
  const { runs } = results.suites[suite];
  const ids = (role) => Object.values(runs[role]);
  const args = ['verify', '--keeps', 'label:good', ...(ids('fixes').length ? ['--fixes', ...ids('fixes')] : []), ...(ids('holdout').length ? ['--holdout', ...ids('holdout')] : []), '--expect', `@${ORACLE}`, '--concurrency', '2', '--budget', String(Math.max(0.5, CAP - results.spent).toFixed(2)), '--json', ...extra];
  const r = await shadowlap(project, 'store.db', args);
  let report;
  try {
    report = JSON.parse(r.out);
  } catch {
    return { verdict: 'error', exit: r.code, error: (r.err || r.out).slice(-600), runs: [], warnings: [], spent: 0, attempts: 0 };
  }
  results.spent += report.cost.spent ?? 0;
  const order = (id) => Object.entries({ ...runs.good, ...runs.fixes, ...runs.holdout }).find(([, run]) => run === id)?.[0];
  return {
    verdict: report.verdict,
    exit: r.code,
    stopReason: report.stopReason,
    warnings: report.warnings,
    spent: report.cost.spent,
    attempts: report.cost.attempts,
    runs: report.runs.map((run) => ({ order: order(run.runId), role: run.role, outcome: run.outcome, passes: run.passes, attempts: run.attempts, baseline: run.baseline ? { passes: run.baseline.passes, attempts: run.baseline.attempts } : null, deterministic: run.deterministic, sentence: run.rate?.sentence ?? null })),
  };
}

async function study(change) {
  const project = await prepared(change.suite);
  say(`${change.id}: ${change.what}`);
  for (const [file, edit] of Object.entries(change.edit)) writeFileSync(join(project, file), edit(readFileSync(join(project, file), 'utf8')));
  try {
    const roles = SUITES[change.suite];
    const measured = {};
    for (const order of [...roles.good, ...roles.fixes, ...roles.holdout]) measured[order] = await measure(project, order, TRUTH);
    const entry = { suite: change.suite, kind: change.kind, what: change.what, measured, verify: await verify(project, change.suite) };
    // A change inside a tool is seen only when the tool runs live: asked both ways, scored apart.
    if (change.liveTool) entry.verifyLive = await verify(project, change.suite, ['--live-tool', change.liveTool]);
    results.changes[change.id] = entry;
    say(`  ${entry.verify.verdict} · ${entry.verify.attempts} attempts · ≈$${results.spent.toFixed(2)} spent so far`);
  } finally {
    git(project, 'checkout', '--', '.');
    save();
  }
}

mkdirSync(OUT, { recursive: true });
let standIn = null;
if (MOCK) {
  standIn = await (await import('./mock.mjs')).startStandIn();
  upstream = standIn.url;
}
try {
  for (const change of CHANGES) {
    if (ONLY.length && !ONLY.includes(change.id)) continue;
    if (results.changes[change.id]) continue;
    if (results.spent >= CAP) {
      say(`stopped at the cap: ≈$${results.spent.toFixed(2)} of $${CAP} spent`);
      break;
    }
    await study(change);
  }
} finally {
  save();
  await standIn?.close();
}
say(`results in ${RESULTS} · ≈$${results.spent.toFixed(2)} spent · read them with: node ${join(HERE, 'report.mjs')} ${RESULTS}`);
