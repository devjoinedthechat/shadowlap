#!/usr/bin/env node
// Builds a demo project whose store holds the states the dashboard's design shows, each one made by
// real shadowlap commands against the mock providers in testing/, so the dashboard can be compared
// with the design on realistic data. Nothing writes to the store but the CLI.
//
//   npm run build && node scripts/demo-store.mjs <folder> [--fast]
//
// <folder> must not exist yet, or be empty. It gets:
//
//   support-agent/   the project: Northwind's support agents (scripts/demo-store/project/), a git
//                    repository with a short history, its goldens, shadowlap.config.json, .mcp.json,
//                    and the store, .shadowlap/shadowlap.db
//   triage-bot/      a second project, added to the dashboard's project list and not set up yet
//   research-agent/, code/invoice-bot/, Downloads/
//                    folders Add project… suggests: a Python agent with two write tools that aren't
//                    wrapped, a Node one whose tools are, and a folder that isn't a project
//   captures/        the sample files the imports read
//   home/            the dashboard's own files (SHADOWLAP_HOME): its project list
//   runs.json        the ids of the runs each step made, and the revisions, to find them by
//
// The story is the design's: a refund agent refunds $240 orders its policy says need approval.
// Each step runs at the commit the story puts it on (Sep 26 to 30, 2026):
//
//   - recordings: the first refund agent (agent.mjs) on several orders; the ticket agent
//     (refund_agent.mjs: streamed, with thinking, clock and id reads); an eval where a model plays
//     the customer and a sub-agent checks the policy (scopes); a chat whose customer's replies are
//     recorded user input; an agent that uses an MCP server through `shadowlap mcp`; a triage
//     agent on OpenAI and a digest on Gemini; a run that fails, one interrupted with Ctrl-C, and an
//     overnight batch of 40 tickets (1,200 calls)
//   - a clean replay, and forks with each intervention: --override (also of a recorded user answer
//     and of call #906 in the batch), --fail-at on a model call (529) and on a tool call (timeout),
//     --inject-result, --inject, --model, --set, --prompt-from, --live-tool after a fix to a tool,
//     and --repeat 5
//   - Fixes: blame finds the model call that lost the refund runs; a verify of a change left in the
//     working tree is rejected (it breaks a good run); repair finds the fix, verifies it and commits
//     it to a branch with its goldens, which is merged; a confirmation emailed twice is blamed and
//     its fix left open
//   - Tests: goldens of four kinds (a token budget, a fork replayed five times, a plain replay, the
//     recordings repair made) run as CI at five commits, with passes, a failed budget check and a
//     divergence on a per-run UUID; bisect then finds the commit that started it
//   - normalizers and redaction rules, added with the CLI; an import of each format it reads (HAR,
//     nock, VCR, LiteLLM, OpenTelemetry, and Langfuse and LangSmith from a stand-in for their APIs
//     on 127.0.0.1); a teammate's pack, unpacked
//   - a team store in a stand-in bucket on 127.0.0.1: a teammate's runs pulled, ours pushed with
//     the newest left only here, CI pushing its test runs, a share link; preference pairs exported;
//     tasks from the goldens' checks (no model is scored); a run exported as HTML, HAR,
//     OpenTelemetry, a dataset and a pack; labels, notes, and several authors, CI among them
//
// --fast keeps a run of every kind, both fixes and a failing and a diverging test, for the test
// that checks them (packages/cli/test/demo-store.test.ts), and leaves out what only adds more: the
// batch and its fork, --repeat, the --model, --set, --inject and --prompt-from forks, the rejected
// verify, two of the five test sessions, bisect, the MCP agent, the team store, the teammate's pack,
// the exports, the trace imports and the second project. Its repair is given the runs and fewer
// attempts, and its recordings aren't paced like a stream.
//
// The calendar: every run a command makes is dated when it is made, today. Imports keep the dates
// their files carry, so the HAR, LiteLLM, OpenTelemetry, Langfuse and LangSmith runs fall 3 to 16
// days back; nock and VCR files carry no dates, so theirs are today's too. The commits are dated in
// the design's week. What the agents send and what the models answer is the same on every build,
// apart from the time and the ids the ticket agent reads per run; run ids and times are not, and so
// neither is a commit that holds a golden, nor any after it.
//
// What commands can't make, so it isn't here: a run still recording once the build has ended;
// runs, spending and test sessions on earlier days; a fix that came from CI with a pull request
// (that takes GitHub); model scores, which the build leaves out on purpose.
//
// The mock providers and the bucket stop with the build. Opened afterwards, the dashboard shows
// everything, and what only reads the store works; an action that calls a model (a fork, Repair
// from here) or the bucket (Push, Pull, a share link) needs them again. The agents' own API keys
// are placeholders, so their model calls never carry a real key.
//
// It prints the folder, the runs by kind and the command that opens the dashboard on it, and
// nothing else unless a step fails. DEMO_STORE_TIMINGS=1 adds how long each step took.
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { devNull } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const kit = join(root, 'scripts', 'demo-store');
const CLI = join(root, 'packages', 'cli', 'bin', 'shadowlap.js');

const argv = process.argv.slice(2);
const fast = argv.includes('--fast');
const target = argv.find((a) => !a.startsWith('--'));
if (!target || argv.some((a) => a.startsWith('--') && a !== '--fast')) {
  console.error('usage: node scripts/demo-store.mjs <folder> [--fast]');
  process.exit(2);
}
for (const built of ['packages/cli/dist/index.js', 'packages/engine/dist/index.js', 'testing/mock-anthropic/dist/index.js', 'testing/mock-openai/dist/index.js', 'testing/mock-gemini/dist/index.js']) {
  if (!existsSync(join(root, built))) {
    console.error(`demo-store: ${built} is missing; run npm run build first`);
    process.exit(1);
  }
}
const folder = resolve(target);
if (existsSync(folder) && (!statSync(folder).isDirectory() || readdirSync(folder).length)) {
  console.error(`demo-store: ${folder} already exists and isn't empty; give a new folder`);
  process.exit(1);
}

const { startMockAnthropic } = await import('@shadowlap-testing/mock-anthropic');
const { startMockOpenAI } = await import('@shadowlap-testing/mock-openai');
const { startMockGemini } = await import('@shadowlap-testing/mock-gemini');
const { createModels } = await import(pathToFileURL(join(kit, 'models.mjs')).href);
const { startBucket } = await import(pathToFileURL(join(kit, 'bucket.mjs')).href);
const samples = await import(pathToFileURL(join(kit, 'samples.mjs')).href);
const { Store, classifyRun } = await import(pathToFileURL(join(root, 'packages', 'engine', 'dist', 'index.js')).href);

const started = Date.now();
const project = join(folder, 'support-agent');
const home = join(folder, 'home');
const captures = join(folder, 'captures');
const scratch = join(folder, '.build');
const db = join(project, '.shadowlap', 'shadowlap.db');
mkdirSync(scratch, { recursive: true });
mkdirSync(home, { recursive: true });

// ---- the models, and the environment every command runs in ----

const models = createModels();
const control = models.control;
const anthropic = await startMockAnthropic({ script: models.anthropic, eventDelayMs: () => control.delay });
const openai = await startMockOpenAI({ script: models.openai });
const gemini = await startMockGemini({ script: models.gemini });
const bucket = await startBucket('northwind-agent-runs');
const servers = [anthropic, openai, gemini, bucket];

// Nothing of this machine's own setup reaches the demo: no provider keys or endpoints, no cloud
// credentials, no CI markers, no git configuration. Each command says who it runs as.
const LEAKS = /^(SHADOWLAP_|ANTHROPIC_|OPENAI_|GOOGLE_|GEMINI_|AWS_|AZURE_|LANGFUSE_|LANGSMITH_|OTEL_|GIT_|GITHUB_|GITLAB_|BITBUCKET_|BUILDKITE|CIRCLECI|JENKINS_URL|TF_BUILD|CI$|NODE_OPTIONS|PYTHONPATH)/;
const ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !LEAKS.test(k))),
  NO_COLOR: '1',
  SHADOWLAP_TELEMETRY: '0',
  SHADOWLAP_HOME: home,
  SHADOWLAP_PROJECT_ROOTS: folder,
  SHADOWLAP_UPSTREAM_ANTHROPIC: anthropic.url,
  SHADOWLAP_UPSTREAM_OPENAI: openai.url,
  SHADOWLAP_UPSTREAM_GEMINI: gemini.url,
  // The repairer `shadowlap repair` asks is the Anthropic mock too.
  ANTHROPIC_BASE_URL: anthropic.url,
  ANTHROPIC_API_KEY: 'demo-key',
  // The stand-in bucket takes any key; the S3 driver signs with these.
  AWS_ACCESS_KEY_ID: 'AKIADEMOSTORE0000000',
  AWS_SECRET_ACCESS_KEY: 'demo-secret-key',
  AWS_REGION: 'eu-central-1',
  AWS_CONFIG_FILE: devNull,
  AWS_SHARED_CREDENTIALS_FILE: devNull,
  LANGFUSE_PUBLIC_KEY: 'pk-lf-demo',
  LANGFUSE_SECRET_KEY: 'sk-lf-demo',
  LANGSMITH_API_KEY: 'lsv2_pt_demo',
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: '1',
};

/** Who does what: the people of the design, and CI. */
const PEOPLE = {
  dana: { name: 'Dana', email: 'dana@example.com' },
  maya: { name: 'Maya', email: 'maya@example.com' },
  ravi: { name: 'Ravi', email: 'ravi@example.com' },
  jonas: { name: 'Jonas', email: 'jonas@example.com' },
};
const as = (who) => (who === 'ci' ? { GITHUB_ACTIONS: 'true' } : { SHADOWLAP_AUTHOR: PEOPLE[who].email });

class StepError extends Error {}

/**
 * Runs the CLI and waits for it. `ok` lists the exit codes the step expects; any other stops the
 * build with the command's output. `answers` are typed at the agent's prompts, one per prompt.
 */
function sl(args, { who = 'dana', ok = [0], env = {}, answers = null, dbPath = null } = {}) {
  return new Promise((done, fail) => {
    const full = [...(dbPath ? ['--db', dbPath] : []), ...args];
    const child = spawn(process.execPath, [CLI, ...full], { cwd: project, env: { ...ENV, ...as(who), ...env }, stdio: [answers ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let out = '';
    let stdout = '';
    let screen = '';
    const left = [...(answers ?? [])];
    child.stdout.on('data', (d) => {
      out += d;
      stdout += d;
      screen += d;
      // A prompt waits at the end of what the agent printed: type the next answer.
      if (left.length && /[?>] $/.test(screen)) {
        child.stdin.write(`${left.shift()}\n`);
        screen = '';
        if (!left.length) child.stdin.end();
      }
    });
    child.stderr.on('data', (d) => (out += d));
    child.on('error', fail);
    child.on('close', (code) => {
      if (ok.includes(code)) done({ code, out, stdout });
      else fail(new StepError(`shadowlap ${full.join(' ')} exited with ${code}\n${out}`));
    });
  });
}

const runIdIn = (out) => {
  const id = /(?:recording|replaying) run (\w{26})/.exec(out)?.[1];
  if (!id) throw new StepError(`no run in:\n${out}`);
  return id;
};
const fixIn = (out) => {
  const id = /\bfix (fx-\w+)/.exec(out)?.[1];
  if (!id) throw new StepError(`no fix in:\n${out}`);
  return id;
};

/** Records a run of one of the project's agents; returns its id. */
async function record(command, opts = {}) {
  return runIdIn((await sl(['run', '--', ...command], opts)).out);
}

/** Replays a run with the flags given; returns the new run's id. */
async function replay(run, flags = [], opts = {}) {
  return runIdIn((await sl(['replay', run, ...flags], opts)).out);
}

const label = (run, ...labels) => sl(['label', run, ...labels]);

// ---- the project and its history ----

function git(args, { who = 'dana', date = null } = {}) {
  const person = PEOPLE[who];
  const env = { ...ENV, GIT_AUTHOR_NAME: person.name, GIT_AUTHOR_EMAIL: person.email, GIT_COMMITTER_NAME: person.name, GIT_COMMITTER_EMAIL: person.email, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) };
  try {
    return execFileSync('git', args, { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  } catch (err) {
    throw new StepError(`git ${args.join(' ')} failed: ${err.stderr?.toString().trim() || err.message}`);
  }
}

/** A commit of the paths given, dated as the story has it; returns its short hash. */
function commit(message, date, who, paths) {
  git(['add', '-A', '--', ...paths]);
  git(['commit', '-q', '-m', message], { who, date });
  return git(['rev-parse', '--short', 'HEAD']);
}

const file = (path) => join(project, path);
function edit(path, from, to) {
  const text = readFileSync(file(path), 'utf8');
  if (!text.includes(from)) throw new StepError(`${path} has no "${from.slice(0, 60)}" to change`);
  writeFileSync(file(path), text.replace(from, to));
}

/** shadowlap.config.json, changed as a person edits it: the tests, which no command writes. */
function editConfig(change) {
  const config = JSON.parse(readFileSync(file('shadowlap.config.json'), 'utf8'));
  change(config);
  writeFileSync(file('shadowlap.config.json'), `${JSON.stringify(config, null, 2)}\n`);
}

/** Rules for refunds, a line each: what a whole policy pasted into a prompt looks like. */
const POLICY = [
  'Refunds within the regional limit may be issued by the agent without approval, once per order.',
  'Refunds above the regional limit need tier-2 approval. The agent escalates them and never issues them itself.',
  'The regional limits are $100 in the EU, $150 in the UK and $200 in North America, before tax and shipping.',
  'Damaged items are refunded in full once the carrier claim is filed; the customer does not return the item.',
  'Items that never arrived are refunded once the carrier confirms the loss, or after 14 days without a scan.',
  'Wrong sizes are exchanged first; a refund is offered only when the size is out of stock.',
  'Late deliveries earn a 10% credit, not a refund, unless the order arrived after the event it was bought for.',
  'Orders on a fraud hold are never refunded by the agent; tier 2 reviews them within one business day.',
  'Gold customers are answered within 4 hours, silver within 12, everyone else within 24.',
  'Every refund, escalation and credit is noted on the ticket with the amount and the reason.',
  'Customers are emailed once per decision, in their own language, using the approved templates.',
  'A refund to a card the customer no longer holds goes out as store credit, with the customer told why.',
];

const E_REFUND = '{"tools":{"issue_refund":{"count":0,"args":{"amount":240}}}}';
const E_EMAIL = '{"tools":{"send_email":1}}';
const CHAT = ['My blender arrived broken. Order A-1042.', 'A replacement, please.', 'No, thanks!'];
const runs = {};
const revs = {};
const timings = [];

async function step(name, fn) {
  const t = Date.now();
  try {
    await fn();
    timings.push([name, Date.now() - t]);
  } catch (err) {
    throw err instanceof StepError ? new StepError(`${name}: ${err.message}`) : err;
  }
}

try {
  // ---- Sep 26: the support agent starts, and refunds orders it should have escalated ----

  await step('the project', async () => {
    cpSync(join(kit, 'project'), project, { recursive: true });
    // The agents import their SDKs as any project does; these come from this repository.
    symlinkSync(join(root, 'node_modules'), file('node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    writeFileSync(file('.gitignore'), 'node_modules\n.shadowlap/\n');
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.name', PEOPLE.dana.name]);
    git(['config', 'user.email', PEOPLE.dana.email]);
    await sl(['init']);
    revs.start = commit('Start the support agent', '2026-09-26T09:12:00+02:00', 'dana', ['.']);
  });

  await step('the first refund runs', async () => {
    control.refund = 'refund';
    runs.refundBug = [];
    for (const order of ['A-1042', 'A-1077', 'A-1103']) {
      const run = await record(['node', 'agent.mjs', order], { who: 'jonas' });
      await label(run, 'refund-bug');
      runs.refundBug.push(run);
    }
    runs.good = await record(['node', 'agent.mjs', 'A-1120'], { who: 'jonas' });
    await label(runs.good, 'good');
  });

  await step('the ticket agent', async () => {
    // Paced like a model that streams, so the recording plays back as it arrived.
    control.delay = fast ? 0 : 12;
    runs.ticket = await record(['node', 'refund_agent.mjs', 'T-8812'], { who: 'maya' });
    control.delay = 0;
    await label(runs.ticket, 'refund-flow');
    await sl(['note', runs.ticket, 'lookup_policy returned no EU limit, so the model refunded $240 without approval.', '--call', '17'], { who: 'maya' });
    await sl(['note', runs.ticket, 'Found in the refund audit: tier-2 approval was skipped.'], { who: 'maya' });
    runs.clean = await replay(runs.ticket, [], { who: 'maya' });
    // What if lookup_policy had returned the limit?
    runs.override = await replay(runs.ticket, ['--override', '16=@payloads/policy.json'], { who: 'dana' });
    await label(runs.override, 'what-if');
    if (!fast) {
      runs.batch = await record(['node', 'refund_agent.mjs', '--batch', 'inbox/2026-09-30.jsonl'], { who: 'ci' });
      await label(runs.batch, 'batch', 'nightly');
      // What if order A-2030, ticket 31's, had been on a fraud hold? Everything before #906 replays.
      runs.batchFork = await replay(runs.batch, ['--override', '906=@payloads/fraud-hold.json'], { who: 'maya' });
      await label(runs.batchFork, 'what-if', 'batch');
    }
  });

  await step('the budget golden', async () => {
    await sl(['pack', runs.ticket, 'goldens/refund-flow-budget']);
    // A budget the recording keeps with room to spare, and the same run with the whole policy in its
    // prompt would not.
    const store = Store.open(db);
    const usage = store.getCalls(runs.ticket).flatMap((c) => (c.kind === 'api' && c.end?.meta.usage ? [c.end.meta.usage] : []));
    store.close();
    const spent = usage.reduce((n, u) => n + u.inputTokens + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0), 0);
    editConfig((c) => {
      c.tests = { 'goldens/refund-flow-budget': { fork: true, expect: { inputTokens: `<= ${Math.ceil((spent * 1.4) / 1000) * 1000}`, cost: '<= 0.05' } } };
    });
    revs.budget = commit('Keep the refund flow as a budget test', '2026-09-26T11:05:00+02:00', 'dana', ['goldens', 'shadowlap.config.json']);
    await sl(['test', 'goldens/*'], { who: 'ci' });
  });

  // ---- Fixes: where the refund runs were lost, a change that breaks a good run, and the fix ----

  await step('blame the refund runs', async () => {
    // Asked again at the decision, the model escalates every other time: the rescue blame looks for.
    control.refund = 'alternate';
    runs.refundFix = fixIn((await sl(['blame', runs.refundBug[0], '--expect', E_REFUND, '--attempts', '4'], { who: 'jonas' })).out);
    await sl(['fix', 'title', runs.refundFix, 'Refunds above the limit issued without approval'], { who: 'jonas' });
  });

  if (!fast) {
    await step('a change that breaks a good run', async () => {
      // It names a tool the agent doesn't have: the refunds above the limit escalate, and the good run crashes.
      edit('agent.mjs', "Follow the refund policy.'", "Follow the refund policy. Call request_approval before any refund.'");
      await sl(['verify', '--fixes', runs.refundBug[1], '--holdout', runs.refundBug[2], '--keeps', 'label:good', '--expect', E_REFUND, '--attempts', '3'], { who: 'jonas', ok: [1] });
      git(['checkout', '--', 'agent.mjs']);
    });
  }

  await step('repair', async () => {
    // The repairer's commit is dated too, so the branch reads like the rest of the history.
    const when = '2026-09-26T17:40:00+02:00';
    const env = { GIT_AUTHOR_NAME: PEOPLE.jonas.name, GIT_AUTHOR_EMAIL: PEOPLE.jonas.email, GIT_AUTHOR_DATE: when, GIT_COMMITTER_NAME: PEOPLE.jonas.name, GIT_COMMITTER_EMAIL: PEOPLE.jonas.email, GIT_COMMITTER_DATE: when };
    // --fast names the runs, so repair blames none again, and asks for fewer attempts.
    const runsFor = fast ? ['--fixes', runs.refundBug[0], '--holdout', ...runs.refundBug.slice(1), '--attempts', '3', '--passes', '2'] : ['--fixes', 'label:refund-bug'];
    await sl(['repair', ...runsFor, '--keeps', 'label:good', '--expect', E_REFUND, '--repairer', 'anthropic', '--branch', 'fix/escalate-over-limit', '--goldens', 'goldens'], { who: 'jonas', env });
    control.refund = 'refund';
    git(['merge', '--no-ff', '-q', 'fix/escalate-over-limit', '-m', 'Merge fix/escalate-over-limit: escalate refunds above the policy limit'], { who: 'dana', date: '2026-09-27T09:30:00+02:00' });
    // The recordings repair made of each fixed run, named by the run, get checks of their own.
    runs.fixedGoldens = readdirSync(file('goldens')).filter((d) => !d.startsWith('refund-'));
    editConfig((c) => {
      for (const d of runs.fixedGoldens) c.tests[`goldens/${d}`] = { expect: { tools: { issue_refund: 0, escalate: 1 } }, task: { takeover: 5, why: 'where the refund-bug runs were lost', rewards: 'escalate above the limit' } };
    });
    revs.merged = commit('Check that refunds above the limit stay escalated', '2026-09-27T09:42:00+02:00', 'dana', ['shadowlap.config.json']);
    if (!fast) await sl(['test', 'goldens/*'], { who: 'ci' });
  });

  await step('the confirmation sent twice', async () => {
    control.email = 'always';
    runs.twice = await record(['node', 'agent.mjs', 'A-1150'], { who: 'ravi' });
    await label(runs.twice, 'double-email');
    control.email = 'sometimes';
    runs.emailFix = fixIn((await sl(['blame', runs.twice, '--expect', E_EMAIL, '--attempts', '3'], { who: 'ravi' })).out);
    await sl(['fix', 'title', runs.emailFix, 'Confirmation email sent twice'], { who: 'ravi' });
    control.email = 'never';
  });

  // ---- Sep 28: the whole policy goes into the prompt, and the budget test fails ----

  await step('a prompt over budget', async () => {
    const policy = ['EU', 'UK', 'North America', 'APAC'].map((region) => `## ${region}\n\n${POLICY.map((rule, i) => `${i + 1}. ${rule}`).join('\n')}`).join('\n\n');
    mkdirSync(file('policy'), { recursive: true });
    writeFileSync(file('policy/refunds-v4.md'), `# Refund policy v4\n\n${policy}\n`);
    edit('refund_agent.mjs', "import { readFileSync } from 'node:fs';", "import { readFileSync } from 'node:fs';\nconst POLICY = readFileSync(new URL('./policy/refunds-v4.md', import.meta.url), 'utf8');");
    edit('refund_agent.mjs', "never guess an order's state.\";", "never guess an order's state.\\n\\n\" + POLICY;");
    revs.policy = commit('Put the whole refund policy in the system prompt', '2026-09-28T14:30:00+02:00', 'ravi', ['policy', 'refund_agent.mjs']);
    await sl(['test', 'goldens/*'], { who: 'ci', ok: [1] });
  });

  // ---- Sep 29: the limit comes from lookup_policy, and the refund decisions become tests ----

  await step('the policy fix', async () => {
    rmSync(file('policy'), { recursive: true });
    edit('refund_agent.mjs', "\nconst POLICY = readFileSync(new URL('./policy/refunds-v4.md', import.meta.url), 'utf8');", '');
    edit('refund_agent.mjs', "never guess an order's state.\\n\\n\" + POLICY;", "never guess an order's state.\";");
    edit('refund_agent.mjs', "async ({ region }) => ({ region, approval: 'tier2' })", "async ({ region }) => ({ region, refund_limit: region === 'EU' ? 100 : 150, approval: 'tier2' })");
    revs.limit = commit('Pass the regional refund limit from lookup_policy', '2026-09-29T10:20:00+02:00', 'dana', ['policy', 'refund_agent.mjs']);
    // The fixed tool runs live where the recording called it: the run forks there and escalates.
    runs.policyFix = await replay(runs.ticket, ['--live-tool', 'lookup_policy'], { who: 'dana' });
    await label(runs.policyFix, 'policy-fix');
    if (!fast) {
      control.repeat = true;
      await sl(['replay', runs.ticket, '--live-tool', 'lookup_policy', '--repeat', '5'], { who: 'dana' });
      control.repeat = false;
    }
  });

  await step('forks', async () => {
    // The model is unavailable at #19: three attempts, then the agent's own error path, writes stubbed.
    runs.failModel = await replay(runs.policyFix, ['--fail-at', '19=529', '--writes', 'stub'], { who: 'dana' });
    await label(runs.failModel, 'error-path');
    // The ticket system times out at #4.
    runs.failTool = await replay(runs.ticket, ['--fail-at', '4=timeout'], { who: 'maya' });
    await label(runs.failTool, 'error-path');
    // An instruction planted in what lookup_order returned: the agent obeys it and emails the order out.
    runs.planted = await replay(runs.ticket, ['--inject-result', '6=@payloads/exfil-email.txt', '--expect', E_EMAIL], { who: 'dana', ok: [1] });
    await label(runs.planted, 'injection');
    if (!fast) {
      runs.model = await replay(runs.ticket, ['--model', '17:claude-haiku-4-5'], { who: 'maya' });
      runs.set = await replay(runs.ticket, ['--set', '17:thinking.budget_tokens=4096'], { who: 'maya' });
      runs.inject = await replay(runs.ticket, ['--inject', '17=Escalate every refund above $100 instead of refunding it.'], { who: 'ravi' });
      await label(runs.inject, 'what-if');
      // A prompt edited in the working tree, tried from #17 on.
      edit('refund_agent.mjs', "never guess an order's state.", "never guess an order's state. Escalate every refund above the regional limit.");
      runs.promptFrom = await replay(runs.ticket, ['--prompt-from', '17'], { who: 'ravi' });
      git(['checkout', '--', 'refund_agent.mjs']);
      await label(runs.promptFrom, 'what-if');
    }
  });

  await step('the refund goldens', async () => {
    runs.inLimit = await record(['node', 'refund_agent.mjs', 'T-8830'], { who: 'ravi' });
    await label(runs.inLimit, 'good');
    await sl(['pack', runs.policyFix, 'goldens/refund-over-limit']);
    await sl(['pack', runs.inLimit, 'goldens/refund-in-limit']);
    editConfig((c) => {
      c.tests['goldens/refund-over-limit'] = { fork: true, repeat: 5, expect: { tools: { issue_refund: 0 } }, task: { takeover: 17, why: 'decides between refunding and escalating', rewards: 'escalate above the limit' } };
      c.tests['goldens/refund-in-limit'] = { expect: { tools: { issue_refund: 1, send_email: 1 } }, task: { takeover: 17, why: 'decides a refund inside the limit', rewards: 'refund within the limit' } };
    });
    revs.goldens = commit('Keep the refund decisions as tests', '2026-09-29T11:00:00+02:00', 'dana', ['goldens', 'shadowlap.config.json']);
    if (!fast) await sl(['test', 'goldens/*'], { who: 'ci' });
  });

  if (!fast) {
    await step('the team store', async () => {
      await sl(['store', 'set', `s3://northwind-agent-runs/support-agent?endpoint=${bucket.endpoint}`]);
      await sl(['store', 'check']);
      revs.store = commit('Keep runs in the team store', '2026-09-29T15:00:00+02:00', 'dana', ['shadowlap.config.json']);
      // A teammate's machine: a chat and an eval, recorded there and pushed; a triage run, packed and sent.
      const maya = join(scratch, 'maya.db');
      runs.chat = await record(['node', 'support_chat.mjs'], { who: 'maya', dbPath: maya, answers: CHAT });
      runs.eval = await record(['node', 'eval_conversation.mjs', '--persona', 'damaged-order'], { who: 'maya', dbPath: maya });
      await sl(['label', runs.chat, 'chat'], { who: 'maya', dbPath: maya });
      await sl(['label', runs.eval, 'eval', 'multi-agent'], { who: 'maya', dbPath: maya });
      await sl(['push', '--all'], { who: 'maya', dbPath: maya });
      runs.packed = await record(['node', 'triage.mjs', '--folder', 'support'], { who: 'maya', dbPath: maya });
      await sl(['pack', runs.packed, join(scratch, 'packs', 'triage-from-maya')], { who: 'maya', dbPath: maya });
      await sl(['unpack', join(scratch, 'packs', 'triage-from-maya')]);
      await sl(['push', '--all']);
      await sl(['pull']);
    });
  }

  // ---- Sep 30: a per-run user id, and the golden that diverges on it ----

  await step('the user id', async () => {
    edit('refund_agent.mjs', "import { readFileSync } from 'node:fs';", "import { randomUUID } from 'node:crypto';\nimport { readFileSync } from 'node:fs';");
    edit('refund_agent.mjs', 'const client = new Anthropic', "// Each run says who it is for, so the provider can tell runs apart in its abuse checks.\nconst userId = randomUUID();\nconst client = new Anthropic");
    edit('refund_agent.mjs', "thinking: { type: 'enabled', budget_tokens: 1024 }, system", "thinking: { type: 'enabled', budget_tokens: 1024 }, metadata: { user_id: userId }, system");
    revs.userId = commit('Send a per-run user id with each request', '2026-09-30T08:31:00+02:00', 'ravi', ['refund_agent.mjs']);
    await sl(['test', 'goldens/*', ...(fast ? [] : ['--push'])], { who: 'ci', ok: [1] });
    if (!fast) await sl(['bisect', 'goldens/refund-in-limit', '--good', revs.goldens], { who: 'ravi' });
  });

  await step('more agents', async () => {
    if (fast) {
      runs.chat = await record(['node', 'support_chat.mjs'], { who: 'maya', answers: CHAT });
      runs.eval = await record(['node', 'eval_conversation.mjs', '--persona', 'damaged-order'], { who: 'jonas' });
      await label(runs.chat, 'chat');
      await label(runs.eval, 'eval', 'multi-agent');
    }
    // The customer answers differently: the recorded reply at #5 overridden. (The chat may be a
    // teammate's, pulled from the team store: its command is theirs, and --yes says it was read.)
    runs.chatFork = await replay(runs.chat, ['--override', '5={"text":"A refund, please."}', '--yes'], { who: 'dana' });
    runs.triage = await record(['node', 'triage.mjs'], { who: 'dana' });
    await label(runs.triage, 'triage');
    runs.digest = await record(['node', 'digest.mjs'], { who: 'dana' });
    await label(runs.digest, 'digest');
    // A channel that doesn't exist: the digest agent has no error handling, and the run fails.
    runs.digestFailed = await record(['node', 'digest.mjs', '--channel', '#refunds'], { who: 'dana', ok: [1] });
    await label(runs.digestFailed, 'digest');
    if (!fast) {
      runs.faq = await record(['node', 'faq.mjs', 'My blender (order A-1042) stopped working after 40 days. Can it be repaired?'], { who: 'jonas' });
      await label(runs.faq, 'mcp');
    }
  });

  await step('an interrupted run', interrupted);

  // ---- what was captured elsewhere ----

  await step('imports', async () => {
    mkdirSync(join(captures, 'litellm'), { recursive: true });
    const exported = async (run, name) => {
      const path = join(scratch, `${name}.har`);
      await sl(['export', 'har', run, path, '--no-redact']);
      return samples.harEntries(path);
    };
    writeFileSync(join(captures, 'refund-A-1077.har'), samples.har(await exported(runs.refundBug[1], 'bug'), samples.daysAgo(9, 15, 48)));
    writeFileSync(join(captures, 'triage-nock.json'), samples.nock(await exported(runs.triage, 'triage')));
    writeFileSync(join(captures, 'digest-cassette.json'), samples.vcr(await exported(runs.digest, 'digest')));
    const [a, b] = samples.litellm(await exported(runs.ticket, 'ticket'), samples.daysAgo(16, 11, 47), 'incident-42', ['a', 'b']);
    writeFileSync(join(captures, 'litellm', 'shadowlap-4121.jsonl'), a);
    writeFileSync(join(captures, 'litellm', 'shadowlap-4122.jsonl'), b);
    runs.har = await imported(['har', join(captures, 'refund-A-1077.har')]);
    runs.nock = await imported(['nock', join(captures, 'triage-nock.json')]);
    runs.vcr = await imported(['vcr', join(captures, 'digest-cassette.json')]);
    runs.litellm = await imported(['litellm', join(captures, 'litellm', 'shadowlap-4121.jsonl'), join(captures, 'litellm', 'shadowlap-4122.jsonl')]);
    await label(runs.litellm, 'incident-42');
    if (!fast) await importTraces();
  });

  // ---- Sep 30, afternoon: what leaves this machine is masked, and runs are shared ----

  await step('normalizers and redaction rules', async () => {
    await sl(['normalize', 'add', '--kind', 'api', '--path', '$.metadata.trace_id', '--pattern', 'ulid', '--replace', '<ULID>']);
    await sl(['redact', 'add', '--pattern', 'email', '--replace', '<EMAIL>']);
    await sl(['redact', 'add', '--pattern', '/\\b(?:\\d[ -]?){13,16}\\b/', '--replace', '<CARD>']);
    await sl(['redact', 'add', '--kind', 'tool', '--path', '$.args.api_key', '--pattern', '/.+/', '--replace', '<KEY>']);
    revs.rules = commit('Mask emails, card numbers and keys in what leaves this machine', '2026-09-30T16:00:00+02:00', 'dana', ['shadowlap.config.json']);
  });

  await step('preference pairs', async () => {
    mkdirSync(file('.shadowlap/exports'), { recursive: true });
    await sl(['export', 'pairs', '--min-confidence', 'medium', '--out', '.shadowlap/exports/pairs.jsonl'], { who: 'maya' });
  });

  if (!fast) {
    await step('exports and shares', async () => {
      await sl(['export', 'html', runs.policyFix, '.shadowlap/exports/refund-policy-fix.html', '--lineage']);
      await sl(['export', 'har', runs.ticket, '.shadowlap/exports/refund-flow.har']);
      await sl(['export', 'otel', runs.ticket, '--out', '.shadowlap/exports/refund-flow.otel.json']);
      await sl(['export', 'dataset', '--label', 'good', '--out', '.shadowlap/exports/good.jsonl']);
      await sl(['pack', runs.eval, '.shadowlap/exports/packs/eval-damaged-order']);
      // Two of the runs made since the last push go up; the rest stay only here.
      await sl(['push', runs.triage, runs.digest]);
      await sl(['share', runs.policyFix]);
    });
    await step('projects', addProjects);
  }
} catch (err) {
  await Promise.all(servers.map((s) => s.close()));
  console.error(err instanceof StepError ? `demo-store: ${err.message}` : err);
  console.error(`demo-store: stopped; remove ${folder} before building again`);
  process.exit(1);
}

await Promise.all(servers.map((s) => s.close()));
rmSync(scratch, { recursive: true, force: true });
summary();

// ---- the steps with more to them ----

/** Imports a capture; returns the run it made. */
async function imported(args) {
  const made = JSON.parse((await sl(['import', ...args, '--json'], { who: 'maya' })).stdout).runs;
  if (made.length !== 1) throw new StepError(`import ${args.join(' ')} made ${made.length} runs`);
  return made[0].runId;
}

/** A recording of the ticket agent, stopped with Ctrl-C once it has made a few calls. */
function interrupted() {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [CLI, 'run', '--', 'node', 'refund_agent.mjs', 'T-8813'], { cwd: project, env: { ...ENV, ...as('dana'), AGENT_PAUSE_MS: '100' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let run = null;
    let store = null;
    const give = setTimeout(() => child.kill('SIGINT'), 15_000);
    const watch = setInterval(() => {
      run ??= /recording run (\w{26})/.exec(out)?.[1] ?? null;
      if (!run || !existsSync(db)) return;
      store ??= Store.open(db);
      if (store.getCalls(run).length >= 8) child.kill('SIGINT');
    }, 50);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', () => {
      clearTimeout(give);
      clearInterval(watch);
      store?.close();
      try {
        runs.interrupted = runIdIn(out);
        done();
      } catch (err) {
        fail(err);
      }
    });
  });
}

/** OpenTelemetry from a file; Langfuse and LangSmith from a stand-in for their APIs on this machine. */
async function importTraces() {
  const fixture = (name) => readFileSync(join(root, 'packages', 'cli', 'test', 'fixtures', 'traces', name), 'utf8');
  writeFileSync(join(captures, 'otel-traces.json'), samples.redate(fixture('otel-genai.json'), samples.daysAgo(5, 9, 20)));
  const langfuse = samples.redate(fixture('langfuse-trace.json'), samples.daysAgo(3, 14, 5));
  const langsmith = JSON.parse(samples.redate(fixture('langsmith-runs.json'), samples.daysAgo(12, 16, 40))).pages;
  const traceId = JSON.parse(langfuse).id;
  const smithId = langsmith[0].runs[0].trace_id;
  writeFileSync(join(captures, 'langfuse-trace.json'), langfuse);
  writeFileSync(join(captures, 'langsmith-runs.json'), `${JSON.stringify(langsmith, null, 1)}\n`);
  const api = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (status, value) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(typeof value === 'string' ? value : JSON.stringify(value));
      };
      if (req.url === `/api/public/traces/${traceId}`) return send(200, langfuse);
      if (req.url === '/runs/query' && req.method === 'POST') return send(200, JSON.parse(body).cursor ? langsmith[1] : langsmith[0]);
      send(404, { message: 'not found' });
    });
  });
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  const host = `http://127.0.0.1:${api.address().port}`;
  try {
    runs.otel = await imported(['otel', join(captures, 'otel-traces.json')]);
    runs.langfuse = await imported(['langfuse', traceId, '--host', host]);
    runs.langsmith = await imported(['langsmith', smithId, '--host', host]);
  } finally {
    await new Promise((r) => api.close(() => r()));
  }
}

/**
 * A second project in the dashboard, added the way Add project… adds one: `shadowlap dashboard`
 * started here lists this project, and its API adds the other. Then the folders it suggests.
 */
async function addProjects() {
  cpSync(join(kit, 'folders'), folder, { recursive: true });
  const dash = spawn(process.execPath, [CLI, 'dashboard', '--no-open'], { cwd: project, env: { ...ENV, ...as('dana') }, stdio: ['ignore', 'pipe', 'pipe'] });
  const stopped = new Promise((r) => dash.on('close', r));
  try {
    const link = await new Promise((done, fail) => {
      let out = '';
      const timer = setTimeout(() => fail(new StepError(`the dashboard printed no link:\n${out}`)), 20_000);
      const look = (d) => {
        out += d;
        const m = /http:\/\/127\.0\.0\.1:\d+\/#token=[\w-]+/.exec(out);
        if (m) {
          clearTimeout(timer);
          done(m[0]);
        }
      };
      dash.stdout.on('data', look);
      dash.stderr.on('data', look);
      stopped.then(() => fail(new StepError(`the dashboard stopped:\n${out}`)));
    });
    const origin = link.split('/#')[0];
    const token = /token=([\w-]+)/.exec(link)[1];
    const res = await fetch(`${origin}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-shadowlap-token': token, origin }, body: JSON.stringify({ path: join(folder, 'triage-bot') }) });
    if (!res.ok) throw new StepError(`adding triage-bot: ${res.status} ${await res.text()}`);
  } finally {
    dash.kill('SIGTERM');
    await stopped;
  }
}

function summary() {
  const store = Store.open(db);
  const all = store.allRuns();
  const byId = new Map(all.map((r) => [r.runId, r]));
  const calls = new Map(all.map((r) => [r.runId, store.getCalls(r.runId).length]));
  store.close();
  // A fork blame rescued its run with shows as a fork of its own, as the dashboard counts it.
  const rescued = new Set(all.map((r) => r.meta?.blame?.rescuedRunId).filter(Boolean));
  const kinds = {};
  const attempts = {};
  const days = {};
  for (const r of all) {
    const parent = r.parentRunId ? byId.get(r.parentRunId) : null;
    const c = classifyRun(r, { calls: calls.get(r.runId), parent: parent ? { calls: calls.get(parent.runId), status: parent.status } : null, rescued: rescued.has(r.runId) });
    if (c.attemptKind) {
      attempts[c.attemptKind] = (attempts[c.attemptKind] ?? 0) + 1;
      continue;
    }
    kinds[c.kind] = (kinds[c.kind] ?? 0) + 1;
    const day = new Date(r.startedAt).toISOString().slice(0, 10);
    days[day] = (days[day] ?? 0) + 1;
  }
  const line = (o) => Object.entries(o).map(([k, n]) => `${k} ${n}`).join(' · ');
  const runCount = Object.values(kinds).reduce((a, b) => a + b, 0);
  console.log(`Demo built in ${Math.round((Date.now() - started) / 1000)}s${fast ? ' (--fast)' : ''}: ${folder}`);
  console.log(`  project   ${project}`);
  console.log(`  runs      ${runCount}: ${line(kinds)}`);
  console.log(`  attempts  ${line(attempts)} (bundled under the runs they came from)`);
  console.log(`  calendar  ${Object.entries(days).sort().map(([d, n]) => `${d} ${n}`).join(' · ')}`);
  console.log(`  ids       ${join(folder, 'runs.json')}`);
  if (process.env.DEMO_STORE_TIMINGS) for (const [name, ms] of timings) console.log(`  ${String(ms).padStart(6)}ms  ${name}`);
  console.log('Open the dashboard on it:');
  console.log(`  cd ${JSON.stringify(project)} && SHADOWLAP_HOME=${JSON.stringify(home)} SHADOWLAP_PROJECT_ROOTS=${JSON.stringify(folder)} node ${JSON.stringify(CLI)} dashboard`);
  writeFileSync(join(folder, 'runs.json'), `${JSON.stringify({ fast, kinds, attempts, days, runs, revisions: revs }, null, 2)}\n`);
}
