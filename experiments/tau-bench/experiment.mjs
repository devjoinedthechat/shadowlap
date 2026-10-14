#!/usr/bin/env node
// The tau2-bench experiment: does `shadowlap repair` fix an agent's failures, on tasks it never saw,
// without breaking what worked, and for what? See README.md for the protocol and how to run it.
//
//   node experiments/tau-bench/experiment.mjs <step> [options]
//
// Steps run in order, each resumable, all state in <workspace>/state.json:
//   setup     clone tau2-bench at a pinned commit, build its environment, make the agent project
//   record    run each task once under `shadowlap run`; the task's reward decides pass or fail
//   blame     blame each failure (the agent's calls only), group the failures, split dev/test
//   repair    per repairer: `shadowlap repair` each dev group; accepted fixes accumulate in its policy
//   evaluate  per repairer, and a placebo control: `shadowlap verify` the test half under its policy
//   report    results.md and results.json
//   all       every step, for every --repairer
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { armName, count, resultsMarkdown, scoreEvaluation, selectTasks, signatureOf, splitRuns, untilRepairerReached } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const CLI = join(REPO, 'packages', 'cli', 'bin', 'shadowlap.js');
const TAU2_URL = 'https://github.com/sierra-research/tau2-bench.git';
// Pinned so the tasks, the policy and the grading are the ones the results describe.
const TAU2_COMMIT = '5bfa7e37b36656b37dc6d022156be6563c1007f3';
const CONTROL = 'control';

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    workspace: { type: 'string', default: join(HERE, 'workspace') },
    domain: { type: 'string', default: 'retail' },
    split: { type: 'string', default: 'test' },
    tasks: { type: 'string', default: 'all' },
    'agent-llm': { type: 'string' },
    'user-llm': { type: 'string' },
    'api-base': { type: 'string' },
    seed: { type: 'string', default: '300' },
    'max-steps': { type: 'string', default: '60' },
    'max-tokens': { type: 'string', default: '4096' },
    repairer: { type: 'string', multiple: true, default: [] },
    candidates: { type: 'string', default: '3' },
    attempts: { type: 'string', default: '5' },
    passes: { type: 'string', default: '4' },
    'blame-attempts': { type: 'string', default: '5' },
    'blame-passes': { type: 'string', default: '2' },
    'rescue-temperature': { type: 'string', default: '1' },
    'good-sample': { type: 'string', default: '6' },
    budget: { type: 'string' },
    'max-cost': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});
const step = positionals[0];
if (o.help || !step) {
  process.stdout.write(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 17).map((l) => l.replace(/^\/\/ ?/, '')).join('\n') + '\nOptions: see README.md.\n');
  process.exit(step ? 0 : 1);
}

const WS = resolve(o.workspace);
const TAU2 = join(WS, 'tau2-bench');
const PY = join(TAU2, '.venv', 'bin', 'python');
const PROJECT = join(WS, 'project');
const LOGS = join(WS, 'logs');
const STATE = join(WS, 'state.json');

const say = (line) => process.stdout.write(`${line}\n`);
const die = (message) => {
  process.stderr.write(`✗ ${message}\n`);
  process.exit(1);
};
const load = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { runs: {}, blames: {}, arms: {}, cost: { record: 0, blame: 0 } });
const save = (s) => writeFileSync(STATE, JSON.stringify(s, null, 2) + '\n');
const sh = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 }).toString();
const git = (...args) => sh('git', args, PROJECT);

/** Everything spent so far, so --max-cost can stop the next command before it starts. */
function spent(s) {
  const arms = Object.values(s.arms).reduce((sum, a) => sum + (a.repairs ?? []).reduce((x, r) => x + (r.spent ?? 0), 0) + (a.evaluation?.spent ?? 0), 0);
  return (s.cost.record ?? 0) + (s.cost.blame ?? 0) + arms;
}
function checkCost(s) {
  const cap = o['max-cost'] === undefined ? null : Number(o['max-cost']);
  if (cap !== null && spent(s) >= cap) die(`stopping: $${spent(s).toFixed(2)} spent, --max-cost is $${cap.toFixed(2)}. Raise it to go on; nothing is lost.`);
}

/**
 * The environment every Shadowlap command gets. The same for all of them: a replay without the
 * upstream a local model server was recorded through would reach the server directly.
 */
function env(config) {
  const e = { ...process.env, TAU2_DATA_DIR: join(PROJECT, 'data'), LITELLM_LOCAL_MODEL_COST_MAP: 'True', LOGURU_LEVEL: 'WARNING' };
  if (config.apiBase) {
    e.SHADOWLAP_UPSTREAM_OPENAI = config.apiBase.replace(/\/v1\/?$/, '');
    e.OPENAI_API_KEY ??= 'local';
  }
  return e;
}

let logNo = 0;
/** Runs the Shadowlap CLI in the project; its stderr goes to a log, its stdout comes back (as JSON with --json). */
function shadowlap(config, args, label) {
  mkdirSync(LOGS, { recursive: true });
  const log = join(LOGS, `${String(++logNo).padStart(4, '0')}-${label.replace(/[^\w.-]+/g, '_')}.log`);
  writeFileSync(log, `$ shadowlap ${args.join(' ')}\n\n`);
  return new Promise((done) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: PROJECT, env: env(config), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => appendFileSync(log, d));
    child.on('exit', (code) => {
      if (stdout) appendFileSync(log, `\n--- stdout ---\n${stdout}`);
      let json = null;
      try {
        json = JSON.parse(stdout);
      } catch {
        // not a --json command, or it failed before printing
      }
      done({ code, stdout, json, log });
    });
  });
}

/** The recording settings. Recorded runs are only comparable under one set, so a change needs a new workspace. */
function configFrom(prev) {
  const c = {
    domain: o.domain,
    split: o.split,
    agentLlm: o['agent-llm'] ?? prev?.agentLlm,
    userLlm: o['user-llm'] ?? prev?.userLlm,
    apiBase: o['api-base'] ?? prev?.apiBase ?? null,
    seed: Number(o.seed),
    maxSteps: Number(o['max-steps']),
    maxTokens: Number(o['max-tokens']),
    rescueTemperature: Number(o['rescue-temperature']),
    attempts: Number(o.attempts),
    passes: Number(o.passes),
    tau2Commit: TAU2_COMMIT,
  };
  if (!c.agentLlm || !c.userLlm) die('give the models: --agent-llm <litellm model> --user-llm <litellm model>');
  if (prev) {
    for (const k of ['domain', 'split', 'agentLlm', 'userLlm', 'apiBase', 'seed', 'maxSteps', 'maxTokens']) {
      if (prev[k] !== c[k]) die(`this workspace recorded with ${k} = ${JSON.stringify(prev[k])}; use another --workspace for ${JSON.stringify(c[k])}`);
    }
  }
  return c;
}

function setup() {
  for (const tool of ['git', 'uv']) {
    try {
      sh(tool, ['--version']);
    } catch {
      die(`setup needs ${tool} on the PATH`);
    }
  }
  mkdirSync(WS, { recursive: true });
  if (!existsSync(TAU2)) {
    say(`cloning tau2-bench into ${TAU2}`);
    sh('git', ['clone', '-q', TAU2_URL, TAU2]);
  }
  sh('git', ['-C', TAU2, 'fetch', '-q', 'origin', TAU2_COMMIT]);
  sh('git', ['-C', TAU2, 'checkout', '-q', TAU2_COMMIT]);
  say(`building its environment at ${TAU2_COMMIT.slice(0, 12)} (Python 3.12, from its lockfile)`);
  sh('uv', ['sync', '-q', '--python', '3.12'], TAU2);
  // At this commit the text-mode import path reaches the voice module, which imports websockets.
  // Python 3.12, rather than 3.13, keeps audioop, which it also imports.
  sh('uv', ['pip', 'install', '-q', '--python', PY, 'websockets', join(REPO, 'sdks', 'python')]);

  if (!existsSync(join(PROJECT, '.git'))) {
    say(`making the agent project in ${PROJECT}`);
    const domain = join(PROJECT, 'data', 'tau2', 'domains', o.domain);
    mkdirSync(domain, { recursive: true });
    for (const f of ['db.json', 'policy.md', 'tasks.json', 'split_tasks.json']) copyFileSync(join(TAU2, 'data', 'tau2', 'domains', o.domain, f), join(domain, f));
    cpSync(join(TAU2, 'data', 'tau2', 'user_simulator'), join(PROJECT, 'data', 'tau2', 'user_simulator'), { recursive: true });
    copyFileSync(join(HERE, 'run_task.py'), join(PROJECT, 'run_task.py'));
    writeFileSync(join(PROJECT, '.gitignore'), '.shadowlap/\n');
    sh('git', ['init', '-q', '-b', 'main'], PROJECT);
    git('add', '.');
    git('-c', 'user.name=shadowlap experiment', '-c', 'user.email=experiment@localhost', 'commit', '-q', '-m', `tau2-bench ${o.domain} at ${TAU2_COMMIT.slice(0, 12)}: the policy repair may edit, and the task runner`);
  }
  say('✓ set up');
}

function taskIds(config) {
  const script = `import json; from tau2.run import get_tasks; print(json.dumps([t.id for t in get_tasks(${JSON.stringify(config.domain)}, task_split_name=${JSON.stringify(config.split)})]))`;
  const out = execFileSync(PY, ['-c', script], { cwd: PROJECT, env: env(config), stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  return JSON.parse(out.trim().split('\n').at(-1));
}

/**
 * An Ollama server cuts a prompt longer than its context window and says nothing: its default is
 * 4096 tokens, split between parallel slots, and tau2's agent prompt starts near 6000. A model
 * shown the tail of its conversation without the policy or the tools fails every task, which looks
 * exactly like a weak model. So before anything is recorded, each model gets a prompt of about
 * `tokens` tokens, and the server must count all of it.
 */
async function checkContext(config, tokens = 12000) {
  if (!config.apiBase) return;
  const root = config.apiBase.replace(/\/v1\/?$/, '');
  try {
    if (!(await fetch(`${root}/api/version`)).ok) return;
  } catch {
    return; // not Ollama, or not reachable yet: record will say so
  }
  const count = async (model, reps) => {
    const res = await fetch(`${root}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: `${'The quick brown fox jumps over the lazy dog. '.repeat(reps)}Say ok.` }] }),
    });
    if (!res.ok) die(`${root} refused a request for ${model}: ${res.status} ${await res.text()}`);
    return (await res.json()).usage?.prompt_tokens ?? 0;
  };
  for (const llm of new Set([config.agentLlm, config.userLlm])) {
    const model = llm.replace(/^[a-z_]+\//, '');
    const small = await count(model, 100);
    const reps = Math.ceil((100 * tokens) / Math.max(small, 1));
    const big = await count(model, reps);
    const expected = (small * reps) / 100;
    if (big < expected * 0.9) {
      die(`the server at ${root} counted ${big} of a prompt of about ${Math.round(expected)} tokens for ${model}: it cuts prompts at its context window, and would cut tau2's policy and tools out of the agent's. Start it with a larger window, such as OLLAMA_CONTEXT_LENGTH=32768 with OLLAMA_NUM_PARALLEL=2 (the window is split between slots), and record again.`);
    }
    say(`  ${model}: a ${big}-token prompt arrives whole`);
  }
}

async function record(s) {
  s.config = configFrom(s.config);
  save(s);
  await checkContext(s.config);
  const tasks = selectTasks(o.tasks, taskIds(s.config));
  const todo = tasks.filter((t) => !Object.values(s.runs).some((r) => r.task === t));
  say(`recording ${todo.length} of ${count(tasks.length, 'task')} (${s.config.domain} ${s.config.split})${todo.length < tasks.length ? '; the rest are recorded already' : ''}`);
  for (const task of todo) {
    checkCost(s);
    const summary = join(LOGS, `summary-${task}.json`);
    const argv = [PY, 'run_task.py', '--domain', s.config.domain, '--split', s.config.split, '--task', task, '--agent-llm', s.config.agentLlm, '--user-llm', s.config.userLlm, '--seed', String(s.config.seed), '--max-steps', String(s.config.maxSteps), '--max-tokens', String(s.config.maxTokens), ...(s.config.apiBase ? ['--api-base', s.config.apiBase] : [])];
    const r = await shadowlap(s.config, ['run', '--summary-json', summary, '--', ...argv], `record-${task}`);
    if (!existsSync(summary)) die(`task ${task} did not record; see ${r.log}`);
    const { summary: sum } = JSON.parse(readFileSync(summary, 'utf8'));
    const passed = r.code === 0;
    // run_task.py's last line: the reward, and why the conversation ended (the user stopped, max steps…).
    const line = r.stdout.trim().split('\n').reverse().find((l) => l.startsWith('{"task"'));
    const outcome = line ? JSON.parse(line) : {};
    s.runs[sum.runId] = { task, runId: sum.runId, passed, spent: sum.cost.spent, calls: sum.total, termination: outcome.termination?.replace(/^TerminationReason\./, '').toLowerCase() ?? null };
    s.cost.record += sum.cost.spent;
    await shadowlap(s.config, ['label', sum.runId, passed ? 'tau:pass' : 'tau:fail'], `label-${task}`);
    save(s);
    say(`  task ${task}: ${passed ? 'passed' : 'failed'}${s.runs[sum.runId].termination ? ` (${s.runs[sum.runId].termination})` : ''} · ${sum.total} calls · ${sum.runId.slice(0, 10)}`);
  }
}

async function blame(s) {
  if (!s.config) die('record first');
  const failed = Object.values(s.runs).filter((r) => !r.passed && !s.blames[r.runId]);
  say(`blaming ${count(failed.length, 'failure')} (the agent's model calls only, resampled at temperature ${s.config.rescueTemperature})`);
  for (const run of failed) {
    checkCost(s);
    const r = await shadowlap(s.config, ['blame', run.runId, '--scope', 'agent', '--set', `temperature=${s.config.rescueTemperature}`, '--attempts', o['blame-attempts'], '--passes', o['blame-passes'], '--json', ...(o.budget ? ['--budget', o.budget] : [])], `blame-${run.task}`);
    const b = r.json ?? { outcome: 'error', error: { message: `no report; see ${r.log}` } };
    const entry = { outcome: b.outcome, callNo: b.blamed?.callNo ?? null, step: b.blamed?.step ?? null, steps: b.modelCalls ?? null, signature: signatureOf(b), spent: b.cost?.spent ?? 0, ...(b.error ? { error: b.error.message.split('\n')[0] } : {}) };
    s.blames[run.runId] = entry;
    s.cost.blame += entry.spent;
    save(s);
    say(`  task ${run.task}: ${entry.outcome === 'blamed' ? `lost at agent call ${entry.step} of ${entry.steps}: ${entry.signature}` : entry.error ?? entry.outcome}`);
  }
  if (!s.split) {
    const runs = Object.values(s.runs);
    s.split = splitRuns(
      runs.filter((r) => !r.passed).map((r) => ({ runId: r.runId, task: r.task, signature: s.blames[r.runId]?.signature ?? 'not blamed' })),
      runs.filter((r) => r.passed).map((r) => ({ runId: r.runId, task: r.task })),
    );
    save(s);
  }
  for (const k of s.split.clusters) say(`  group "${k.signature}": ${k.dev.length} dev, ${k.test.length} test${k.repairable ? '' : ' (nothing to learn from)'}`);
}

async function repair(s, repairer) {
  if (!s.split) die('blame first');
  const name = armName(repairer);
  const arm = (s.arms[name] ??= { repairer, repairs: [] });
  git('checkout', '-q', '-f', '-B', `arm/${name}`, arm.repairs.length ? `arm/${name}` : 'main');
  const keeps = s.split.dev.passed.slice(0, Number(o['good-sample']));
  const groups = s.split.clusters.filter((k) => k.repairable && k.dev.length && !arm.repairs.some((r) => r.signature === k.signature));
  say(`${name}: repairing ${count(groups.length, 'group')}, checked against ${count(keeps.length, 'passing dev run')}`);
  for (const k of groups) {
    checkCost(s);
    const attempt = async () => {
      const r = await shadowlap(
        s.config,
        ['repair', '--fixes', ...k.dev, ...(keeps.length ? ['--keeps', ...keeps] : []), '--scope', 'agent', '--set', `temperature=${s.config.rescueTemperature}`, '--repairer', repairer, '--candidates', o.candidates, '--attempts', String(s.config.attempts), '--passes', String(s.config.passes), '--apply', '--json', ...(o.budget ? ['--budget', o.budget] : [])],
        `repair-${name}-${k.signature}`,
      );
      return r.json ?? { outcome: 'error', why: `no report; see ${r.log}` };
    };
    // About an hour of waiting, for a network that dropped or a laptop that slept mid-call.
    const rep = await untilRepairerReached(attempt, [1, 2, 5, 10, 15, 30], (min) => new Promise((done) => setTimeout(done, min * 60_000)), (why, min) => say(`  "${k.signature}": ${why}; trying again in ${min} min`));
    if (!rep) die(`the repairer could not be reached for an hour, so "${k.signature}" is left undone rather than recorded as unfixed. Run the same command again once it can be reached: everything done so far is kept.`);
    const accepted = rep.candidates?.find((c) => c.id === rep.accepted);
    const cost = rep.cost ? rep.cost.blame + (rep.cost.repairer ?? 0) + rep.cost.verify : 0;
    arm.repairs.push({ signature: k.signature, outcome: rep.outcome, why: rep.why ?? null, change: accepted ? { surface: accepted.surface, before: accepted.before, after: accepted.after, strategy: accepted.strategy } : null, candidates: rep.candidates?.length ?? 0, spent: cost });
    if (rep.outcome === 'fixed' && git('status', '--porcelain').trim()) {
      git('add', '-A', 'data');
      git('-c', 'user.name=shadowlap experiment', '-c', 'user.email=experiment@localhost', 'commit', '-q', '-m', `${name}: ${accepted?.strategy ?? 'repair'}`);
    }
    save(s);
    say(`  "${k.signature}": ${rep.outcome}${accepted ? `: ${accepted.strategy}` : rep.why ? ` (${rep.why})` : ''}`);
  }
  mkdirSync(join(WS, 'results'), { recursive: true });
  writeFileSync(join(WS, 'results', `${name}.patch`), git('diff', 'main', `arm/${name}`, '--', 'data'));
}

async function evaluate(s, name) {
  if (!s.split) die('blame first');
  if (name === CONTROL) {
    // A placebo: the agent reads the same policy, and every run still forks at the same call as under a fix.
    git('checkout', '-q', '-f', '-B', `arm/${CONTROL}`, 'main');
    const policy = join(PROJECT, 'data', 'tau2', 'domains', s.config.domain, 'policy.md');
    appendFileSync(policy, '\n<!-- control arm: nothing in this policy has changed -->\n');
    git('-c', 'user.name=shadowlap experiment', '-c', 'user.email=experiment@localhost', 'commit', '-q', '-am', 'control: a placebo change');
    s.arms[CONTROL] ??= { repairer: null };
  } else {
    if (!s.arms[name]) die(`no arm ${name}: repair it first`);
    git('checkout', '-q', '-f', `arm/${name}`);
  }
  checkCost(s);
  const { failed, passed } = s.split.test;
  if (!failed.length && !passed.length) die('the test half is empty: record more tasks');
  say(`${name}: verifying the test half, ${count(failed.length, 'failure')} and ${count(passed.length, 'passing run')}`);
  const r = await shadowlap(s.config, ['verify', ...(failed.length ? ['--fixes', ...failed] : []), ...(passed.length ? ['--keeps', ...passed] : []), '--attempts', String(s.config.attempts), '--passes', String(s.config.passes), '--json', ...(o.budget ? ['--budget', o.budget] : [])], `evaluate-${name}`);
  if (!r.json?.runs) die(`verify gave no report; see ${r.log}`);
  s.arms[name].evaluation = scoreEvaluation(r.json);
  save(s);
  const e = s.arms[name].evaluation;
  say(`  fixed ${e.fixed} of ${count(e.failures, 'test failure')}, broke ${e.broken} of ${count(e.passing, 'passing run')} · $${e.spent.toFixed(4)}`);
  git('checkout', '-q', '-f', 'main');
}

function report(s) {
  mkdirSync(join(WS, 'results'), { recursive: true });
  writeFileSync(join(WS, 'results', 'results.md'), resultsMarkdown(s));
  writeFileSync(join(WS, 'results', 'results.json'), JSON.stringify({ config: s.config, runs: s.runs, blames: s.blames, split: s.split, arms: s.arms, cost: s.cost, spent: spent(s) }, null, 2) + '\n');
  say(`✓ ${join(WS, 'results', 'results.md')} (and results.json, and a patch per arm)`);
}

const s = existsSync(WS) ? load() : null;
switch (step) {
  case 'setup':
    setup();
    break;
  case 'record':
    await record(s ?? die('run setup first'));
    break;
  case 'blame':
    await blame(s ?? die('run setup first'));
    break;
  case 'repair':
    if (!o.repairer.length) die('give --repairer <provider:model>, once per arm');
    for (const r of o.repairer) await repair(s, r);
    break;
  case 'evaluate':
    for (const r of o.repairer) await evaluate(s, armName(r));
    await evaluate(s, CONTROL);
    break;
  case 'report':
    report(s ?? die('nothing to report'));
    break;
  case 'all': {
    if (!o.repairer.length) die('give --repairer <provider:model>, once per arm');
    setup();
    const state = load();
    await record(state);
    await blame(state);
    for (const r of o.repairer) await repair(state, r);
    for (const r of o.repairer) await evaluate(state, armName(r));
    await evaluate(state, CONTROL);
    report(state);
    break;
  }
  default:
    die(`no step "${step}": setup, record, blame, repair, evaluate, report or all`);
}
