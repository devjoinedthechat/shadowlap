// A release, rehearsed against a throwaway npm registry: publishes every package the release workflow
// publishes, installs `shadowlap` into an empty project the way a user would, and uses it end to end
// (record, replay, fork, pack, test, the dashboard, the adapters, the collector, the Python SDK).
// Catches what only shows up after packaging: a file missing from `files`, a dependency that
// resolves inside the workspace but not from a registry, a bin without its shebang.
//
//   npm run build && node scripts/release-rehearsal.mjs
//
// Needs network access for third-party dependencies, proxied from registry.npmjs.org.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// The release workflow's publish order: dependencies first.
const PACKAGES = ['packages/engine', 'packages/sdk', 'packages/sidecar', 'packages/adapters', 'packages/tui', 'packages/remote', 'packages/dashboard', 'packages/cli', 'packages/test', 'packages/collector'];
const VERSION = JSON.parse(readFileSync(join(root, 'packages/cli/package.json'), 'utf8')).version;
const PORT = Number(process.env.REGISTRY_PORT ?? 4873);
const REGISTRY = `http://127.0.0.1:${PORT}/`;
const work = mkdtempSync(join(tmpdir(), 'shadowlap-release-'));
const keep = process.argv.includes('--keep');
// Shadowlap's files for this machine (the dashboard's project list, the agents registered while they
// run) go in the rehearsal's own folder, for every process it starts, and go with it: never in the
// real ~/.shadowlap.
process.env.SHADOWLAP_HOME = join(work, 'sl-home');

const results = [];
const children = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  process.stdout.write(`${ok ? '✓' : '✗'} ${name}${detail ? `\n${String(detail).trim().split('\n').slice(-25).map((l) => `    ${l}`).join('\n')}` : ''}\n`);
  if (!ok) finish();
}
function finish() {
  for (const c of children) c.kill();
  if (!keep) rmSync(work, { recursive: true, force: true });
  else process.stdout.write(`kept ${work}\n`);
  const failed = results.filter((r) => !r.ok).length;
  process.stdout.write(`\n${results.length - failed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 10 * 60_000, ...opts, env: { ...process.env, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', ...opts.env } });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? r.error.message : ''}`, stdout: r.stdout ?? '' };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      // not yet
    }
    if (Date.now() > end) return null;
    await wait(250);
  }
}

// ---- 1. A registry: Verdaccio, with the Shadowlap names local-only and everything else proxied.
const registryDir = join(work, 'registry');
mkdirSync(registryDir);
writeFileSync(
  join(registryDir, 'config.yaml'),
  `storage: ${join(registryDir, 'storage')}
auth:
  htpasswd:
    file: ${join(registryDir, 'htpasswd')}
    max_users: 10
uplinks:
  npmjs:
    url: https://registry.npmjs.org/
packages:
  '@shadowlap/*':
    access: $all
    publish: $authenticated
  'shadowlap':
    access: $all
    publish: $authenticated
  '**':
    access: $all
    proxy: npmjs
log: { type: stdout, format: pretty, level: error }
`,
);
const verdaccio = spawn('npx', ['--yes', 'verdaccio@6.1.6', '--config', join(registryDir, 'config.yaml'), '--listen', `127.0.0.1:${PORT}`], { stdio: 'ignore', env: { ...process.env, npm_config_registry: 'https://registry.npmjs.org/' } });
children.push(verdaccio);
const up = await until(async () => (await fetch(`${REGISTRY}-/ping`)).ok, 120_000);
check(`starts a local registry at ${REGISTRY}`, !!up);

const user = await (await fetch(`${REGISTRY}-/user/org.couchdb.user:rehearsal`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'rehearsal', password: 'rehearsal-only' }) })).json();
const npmrc = join(work, '.npmrc');
writeFileSync(npmrc, `registry=${REGISTRY}\n//127.0.0.1:${PORT}/:_authToken=${user.token}\n`);
const npm = (args, opts = {}) => run('npm', [...args, '--userconfig', npmrc, '--registry', REGISTRY, '--no-audit', '--no-fund'], opts);

// ---- 2. Publish, dependencies first, exactly as the release workflow does (without provenance).
for (const p of PACKAGES) {
  const r = npm(['publish', '--workspace', p, '--access', 'public'], { cwd: root });
  check(`publishes ${JSON.parse(readFileSync(join(root, p, 'package.json'), 'utf8')).name}@${VERSION}`, r.code === 0, r.code === 0 ? '' : r.out);
}

// ---- 3. Install into an empty project, the way the README says.
const app = join(work, 'app');
mkdirSync(app);
writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'rehearsal-app', private: true, type: 'module' }, null, 2));
const install = npm(['install', `shadowlap@${VERSION}`, `@shadowlap/sdk@${VERSION}`, `@shadowlap/adapters@${VERSION}`, `@shadowlap/test@${VERSION}`, 'openai@7'], { cwd: app });
check('installs shadowlap, the SDK, the adapters and the test helpers from the registry', install.code === 0, install.code === 0 ? '' : install.out);
const bin = join(app, 'node_modules', '.bin', 'shadowlap');
const fp = (args, env = {}) => run(bin, args, { cwd: app, env });

const version = fp(['--version']);
check('runs the installed binary', version.code === 0 && version.stdout.trim() === VERSION, version.out);
const help = fp(['--help']);
check('lists every command', ['run', 'replay', 'test', 'pack', 'unpack', 'dashboard', 'ui', 'mcp', 'doctor', 'diff'].every((c) => new RegExp(`^\\s+${c}\\b`, 'm').test(help.stdout)), help.out);

// ---- 4. An agent against a scripted OpenAI-compatible model: a tool call, then an answer.
// In its own process: the CLI runs synchronously below and would otherwise block it.
writeFileSync(
  join(work, 'model.mjs'),
  `import { createServer } from 'node:http';
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const request = JSON.parse(body || '{}');
    const answered = (request.messages ?? []).some((m) => m.role === 'tool');
    const system = (request.messages ?? []).find((m) => m.role === 'system')?.content ?? '';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta, finish = null) => res.write('data: ' + JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'rehearsal-model', choices: [{ index: 0, delta, finish_reason: finish }] }) + '\\n\\n');
    if (!answered) {
      chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'send_report', arguments: '{"to":"team@example.com"}' } }] });
      chunk({}, 'tool_calls');
    } else {
      chunk({ role: 'assistant', content: system.includes('brief') ? 'Sent.' : 'The report was sent to the team.' });
      chunk({}, 'stop');
    }
    res.write('data: ' + JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'rehearsal-model', choices: [], usage: { prompt_tokens: 40, completion_tokens: 8 } }) + '\\n\\ndata: [DONE]\\n\\n');
    res.end();
  });
});
server.listen(0, '127.0.0.1', () => console.log('model on http://127.0.0.1:' + server.address().port));
`,
);
const model = spawn(process.execPath, [join(work, 'model.mjs')], { stdio: ['ignore', 'pipe', 'inherit'] });
children.push(model);
let modelLog = '';
model.stdout.on('data', (c) => (modelLog += c));
const upstream = await until(() => /model on (http:\/\/[^\s]+)/.exec(modelLog)?.[1], 10_000);
check('starts a scripted OpenAI-compatible model', !!upstream);
const effects = join(app, 'sent.log');
writeFileSync(
  join(app, 'agent.mjs'),
  `import { appendFileSync } from 'node:fs';
import OpenAI from 'openai';
import { tool } from '@shadowlap/sdk';

const sendReport = tool('send_report', { effect: 'write' }, async ({ to }) => {
  appendFileSync(${JSON.stringify(effects)}, to + '\\n');
  return 'sent';
});
const client = new OpenAI({ apiKey: 'unused' });
const messages = [{ role: 'system', content: 'Report to the team.' + (process.env.BRIEF ? ' Be brief.' : '') }, { role: 'user', content: 'Send the report.' }];
const tools = [{ type: 'function', function: { name: 'send_report', parameters: { type: 'object', properties: { to: { type: 'string' } } } } }];
for (;;) {
  const stream = await client.chat.completions.create({ model: 'rehearsal-model', messages, tools, stream: true, stream_options: { include_usage: true } });
  let text = '';
  const calls = [];
  for await (const c of stream) {
    const d = c.choices[0]?.delta;
    if (d?.content) text += d.content;
    for (const t of d?.tool_calls ?? []) calls[t.index] = t;
  }
  if (!calls.length) {
    console.log(text);
    break;
  }
  messages.push({ role: 'assistant', content: null, tool_calls: calls });
  for (const c of calls) {
    let result;
    try {
      result = await sendReport(JSON.parse(c.function.arguments));
    } catch (err) {
      result = 'error: ' + err.message;
    }
    messages.push({ role: 'tool', tool_call_id: c.id, content: result });
  }
}
`,
);
const env = { SHADOWLAP_UPSTREAM_OPENAI: upstream, SHADOWLAP_GUARD: 'off' };
const recorded = fp(['run', '--', process.execPath, 'agent.mjs'], env);
const runId = /recording run (\w{26})/.exec(recorded.out)?.[1];
check('records an agent', recorded.code === 0 && !!runId && recorded.out.includes('The report was sent to the team.') && recorded.out.includes('3 calls (2 api, 1 tool)'), recorded.out);
const replayed = fp(['replay', runId, '--strict'], { ...env, SHADOWLAP_UPSTREAM_OPENAI: 'http://127.0.0.1:9' });
check('replays it with the model unreachable', replayed.code === 0 && replayed.out.includes('Replay clean: 3/3') && replayed.out.includes('0 upstream requests'), replayed.out);
const forked = fp(['replay', runId], { ...env, BRIEF: '1' });
check('forks it and blocks the write', forked.code === 0 && forked.out.includes('Forked at call 1') && forked.out.includes('1 write blocked') && readFileSync(effects, 'utf8').trim().split('\n').length === 1, forked.out);
const golden = join(work, 'golden');
const packed = fp(['pack', runId, golden]);
const tested = fp(['test', golden]);
check('packs it and passes it as a golden', packed.code === 0 && tested.code === 0 && tested.out.includes('1 passed, 0 failed'), `${packed.out}\n${tested.out}`);
const doctor = fp(['doctor'], env);
check('runs doctor', /node|Node/.test(doctor.out), doctor.out);
// The coding agents' skills come inside the packages: skill install puts them into the project, offline,
// as the Claude Code plugin and in the folder the other agents read.
const skilled = fp(['skill', 'install']);
const shared = fp(['skill', 'install', 'agents']);
const manifest = join(app, '.claude', 'skills', 'shadowlap', '.claude-plugin', 'plugin.json');
const pluginVersion = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')).version : null;
const sharedSkill = join(app, '.agents', 'skills', 'shadowlap-debug-agent', 'SKILL.md');
const sharedVersion = existsSync(sharedSkill) ? /^ {2}version: (\S+)$/m.exec(readFileSync(sharedSkill, 'utf8'))?.[1] : null;
check('installs the skills from the packages, for Claude Code and the other agents', skilled.code === 0 && shared.code === 0 && pluginVersion === VERSION && sharedVersion === VERSION, `${skilled.out}\n${shared.out}`);

// ---- 5. The dashboard: its bundled UI and API from the installed package, its runs the ones the
// CLI lists (the recording, its replay, its fork and the golden's test run).
// Its list of projects goes in the rehearsal's own folder (SHADOWLAP_HOME, above).
const listed = JSON.parse(fp(['ls', '--json']).stdout || '[]').map((r) => r.runId).sort();
const dash = spawn(bin, ['dashboard', '--no-open', '--port', '4799'], { cwd: app, env: { ...process.env, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
children.push(dash);
let dashLog = '';
dash.stderr.on('data', (c) => (dashLog += c));
const link = await until(() => /(http:\/\/127\.0\.0\.1:\d+)\/#token=([\w-]+)/.exec(dashLog), 20_000);
let dashOk = false;
if (link) {
  const [, origin, token] = link;
  const page = await (await fetch(`${origin}/`)).text();
  const script = /src="([^"]+\.js)"/.exec(page)?.[1];
  const js = script ? await fetch(new URL(script, origin)) : null;
  const runs = await (await fetch(`${origin}/api/runs`, { headers: { 'x-shadowlap-token': token } })).json();
  const served = (runs.runs ?? []).map((r) => r.runId).sort();
  dashOk = page.includes('<title>') && !!js?.ok && listed.length === 4 && JSON.stringify(served) === JSON.stringify(listed);
}
dash.kill();
check('serves the dashboard UI and its data', dashOk, dashLog);

// ---- 5a. The same UI as one file: `export html` inlines what the installed package ships.
const exported = fp(['export', 'html', runId, 'run.html'], env);
let htmlOk = false;
let htmlDetail = exported.out;
try {
  const html = readFileSync(join(app, 'run.html'), 'utf8');
  const data = JSON.parse(/<script type="application\/json" id="shadowlap-data">(.*?)<\/script>/s.exec(html)[1].split('<\\/').join('</'));
  htmlOk = exported.code === 0 && !/<script[^>]+src=/.test(html) && !!data.responses[`runs/${String(runId)}`] && html.includes('url(data:font/woff2;base64,');
  htmlDetail += `\n${(html.length / 1024).toFixed(0)} KB, ${Object.keys(data.responses).length} views`;
} catch (err) {
  htmlDetail += `\n${err.message}`;
}
check('exports the run as one HTML file that needs nothing else', htmlOk, htmlDetail);

// ---- 5b. A recorded test with the installed @shadowlap/test: records against the model, then replays with it unreachable.
writeFileSync(
  join(app, 'recorded.fixture.mjs'),
  `import assert from 'node:assert/strict';
import { test } from 'node:test';
import OpenAI from 'openai';
import { withRecording } from '@shadowlap/test';

const client = new OpenAI({ apiKey: 'unused' });
test('a recorded test', () =>
  withRecording({ recording: '__recordings__/rehearsal' }, async () => {
    const stream = await client.chat.completions.create({ model: 'rehearsal-model', stream: true, messages: [{ role: 'user', content: 'report' }] });
    let calls = 0;
    for await (const chunk of stream) calls += chunk.choices[0]?.delta?.tool_calls?.length ?? 0;
    assert.equal(calls, 1);
  }));
`,
);
// The model asks for send_report, which the test only counts and never runs. A replay can't tell that it
// won't, so it is told the tool may run, as Shadowlap's refusal of an unrecorded write says to.
const recordedTest = (env) => run(process.execPath, ['--import', '@shadowlap/test/register', '--test', 'recorded.fixture.mjs'], { cwd: app, env: { ...env, CI: '', SHADOWLAP_RECORD: '', SHADOWLAP_ALLOW_UNRECORDED: 'send_report' } });
const recordedFirst = recordedTest({ SHADOWLAP_UPSTREAM_OPENAI: upstream });
const recordedAgain = recordedTest({ SHADOWLAP_UPSTREAM_OPENAI: 'http://127.0.0.1:9' });
check('records a test with @shadowlap/test, then replays it offline', recordedFirst.code === 0 && existsSync(join(app, '__recordings__', 'rehearsal', 'run.json')) && recordedAgain.code === 0, `${recordedFirst.out}\n${recordedAgain.out}`);

// ---- 6. The adapters and the collector as installed packages.
const adapters = run(process.execPath, ['--input-type=module', '-e', "for (const m of ['ai-sdk', 'openai-agents', 'mastra', 'anthropic', 'langchain']) { const mod = await import('@shadowlap/adapters/' + m); if (!Object.keys(mod).length) throw new Error(m); } console.log('ok')"], { cwd: app });
check('imports every adapter entry point', adapters.code === 0 && adapters.stdout.includes('ok'), adapters.out);
const collectorApp = join(work, 'collector');
mkdirSync(collectorApp);
writeFileSync(join(collectorApp, 'package.json'), '{"name":"collector-app","private":true}');
const collectorInstall = npm(['install', `@shadowlap/collector@${VERSION}`], { cwd: collectorApp });
const collector = spawn(join(collectorApp, 'node_modules', '.bin', 'shadowlap-collector'), [], { cwd: collectorApp, env: { ...process.env, PORT: '0', HOST: '127.0.0.1', COLLECTOR_DB: join(collectorApp, 'c.db') }, stdio: ['ignore', 'pipe', 'pipe'] });
children.push(collector);
let collectorLog = '';
collector.stdout.on('data', (c) => (collectorLog += c));
collector.stderr.on('data', (c) => (collectorLog += c));
const collectorUrl = await until(() => /listening on (http:\/\/[^\s]+)/.exec(collectorLog)?.[1], 20_000);
const healthy = collectorUrl ? (await fetch(new URL('/healthz', collectorUrl))).ok : false;
collector.kill();
check('installs and starts the collector', collectorInstall.code === 0 && healthy, `${collectorInstall.out}\n${collectorLog}`);

// ---- 7. The Python SDK, as a wheel in a fresh virtual environment.
const python = ['python3', 'python'].find((p) => run(p, ['--version']).code === 0);
if (python) {
  const wheels = join(work, 'wheels');
  const venv = join(work, 'venv');
  const wheel = run(python, ['-m', 'pip', 'wheel', '--no-deps', '--quiet', '-w', wheels, join(root, 'sdks', 'python')]);
  // setuptools builds in the source tree; left there, the egg-info registers the pytest plugin for anything that puts sdks/python on sys.path.
  for (const leftover of ['build', 'shadowlap.egg-info']) rmSync(join(root, 'sdks', 'python', leftover), { recursive: true, force: true });
  run(python, ['-m', 'venv', venv]);
  const py = join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const installed = existsSync(py) ? run(py, ['-m', 'pip', 'install', '--quiet', '--no-index', '--find-links', wheels, 'shadowlap']) : { code: 1, out: 'no venv' };
  const imported = run(py, ['-c', 'import shadowlap; print(shadowlap.__version__)']);
  check('builds, installs and imports the Python SDK', wheel.code === 0 && installed.code === 0 && imported.stdout.trim() === VERSION, `${wheel.out}\n${installed.out}\n${imported.out}`);
  const plugin = run(py, ['-c', "from importlib.metadata import entry_points; print([e.value for e in entry_points(group='pytest11')])"]);
  check('registers the pytest plugin', plugin.stdout.includes('shadowlap.pytest_plugin'), plugin.out);
} else {
  process.stdout.write('- skipped the Python SDK: no python3\n');
}

finish();
