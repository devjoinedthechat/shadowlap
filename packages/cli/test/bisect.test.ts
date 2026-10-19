import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NO_COMMAND, Store } from '@shadowlap/engine';
import { message, startMockAnthropic, text, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { mapArgv } from '../src/bisect.js';
import { physicalPath } from '../src/real-path.js';

/**
 * `shadowlap bisect` through the CLI, on a scratch git repository with a tiny agent: one model call,
 * its system prompt read from a file. Its history: a README edit or two, then a commit that asks for
 * brevity (the golden recorded before it diverges from there on), then one that prints a draft
 * marker (an output check fails from there on). The mock plays the model while recording; every
 * replay after that is offline.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));

/** Whether the temporary folder's volume ignores letter case, as macOS's and Windows' do by default. */
const CASE_INSENSITIVE = tmpdir() !== tmpdir().toUpperCase() && existsSync(tmpdir().toUpperCase());

const AGENT = `import { readFileSync } from 'node:fs';
const system = readFileSync(new URL('./prompt.txt', import.meta.url), 'utf8').trim();
const marker = readFileSync(new URL('./marker.txt', import.meta.url), 'utf8').trim();
const res = await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'anthropic-version': '2023-06-01' },
  body: JSON.stringify({ model: 'small-model', max_tokens: 64, system, messages: [{ role: 'user', content: 'Summarize ticket T-1.' }] }),
});
const body = await res.json();
if (!res.ok) {
  console.error(JSON.stringify(body));
  process.exit(1);
}
console.log(marker + body.content.map((b) => b.text ?? '').join(''));
`;

let mock: MockServer;
let project: string;
const rev: Record<string, string> = {};
let recordedRun = '';
let briefRun = '';

const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { cwd: project, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
function commit(name: string, files: Record<string, string | null>, author = 'Test'): void {
  for (const [f, content] of Object.entries(files)) {
    if (content === null) rmSync(join(project, f));
    else writeFileSync(join(project, f), content);
  }
  sh('git', ['add', '.']);
  sh('git', ['-c', `user.name=${author}`, 'commit', '-q', '-m', name]);
  rev[name] = sh('git', ['rev-parse', '--short', 'HEAD']);
}

function shadowlap(args: string[]): Promise<{ code: number | null; out: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: project, env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) => resolve({ code, out, stdout }));
  });
}

beforeAll(async () => {
  mock = await startMockAnthropic({ script: (ctx) => ({ message: message([text(JSON.stringify(ctx.request.system ?? '').includes('Be brief') ? 'Short.' : 'Ticket summarized.')]) }) });
  // Outside the repository, so an interrupted run never leaves a nested one behind in it.
  project = mkdtempSync(join(tmpdir(), 'sl-bisect-'));
  sh('git', ['init', '-q', '-b', 'main']);
  sh('git', ['config', 'user.email', 'test@example.com']);
  writeFileSync(join(project, '.gitignore'), '.shadowlap/\n');
  commit('Start the ticket agent', { 'agent.mjs': AGENT, 'prompt.txt': 'You summarize support tickets.\n', 'marker.txt': '\n', 'README.md': 'Ticket agent\n' });
  const recorded = await shadowlap(['run', '--', process.execPath, 'agent.mjs']);
  expect(recorded.code, recorded.out).toBe(0);
  recordedRun = /recording run (\w{26})/.exec(recorded.out)![1]!;
  expect((await shadowlap(['pack', recordedRun, 'goldens/summary'])).code).toBe(0);
  commit('Describe the agent', { 'README.md': 'Ticket agent: one model call.\n' });
  // BROKEN makes the build step some tests give fail, at this commit only.
  commit('Add usage', { 'README.md': 'Ticket agent: one model call.\n\nnode agent.mjs\n', BROKEN: 'x\n' });
  commit('Ask for brevity', { 'prompt.txt': 'You summarize support tickets. Be brief.\n', BROKEN: null }, 'Ravi');
  commit('Mention the prompt', { 'README.md': 'Ticket agent: one model call; the prompt is prompt.txt.\n' });
  const second = await shadowlap(['run', '--', process.execPath, 'agent.mjs']);
  briefRun = /recording run (\w{26})/.exec(second.out)![1]!;
  expect((await shadowlap(['pack', briefRun, 'goldens/brief'])).code).toBe(0);
  commit('Mark summaries as drafts', { 'marker.txt': 'DRAFT: \n' }, 'Jonas');
  // A branch off 'Describe the agent' where the golden passes too, never merged.
  sh('git', ['checkout', '-q', '-b', 'side', rev['Describe the agent']!]);
  commit('Side note', { 'NOTES.md': 'side\n' });
  sh('git', ['checkout', '-q', 'main']);
});
afterAll(async () => {
  await mock.close();
  rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('shadowlap bisect', () => {
  it('names the first commit where a golden diverges, at 0 tokens, and cleans up its worktrees', async () => {
    const hits = mock.requests.length;
    const r = await shadowlap(['bisect', 'goldens/summary', '--good', rev['Start the ticket agent']!]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`▸ goldens/summary · good ${rev['Start the ticket agent']} · bad ${rev['Mark summaries as drafts']} · 5 commits apart`);
    expect(r.out).toContain(`replay at ${rev['Add usage']}  replayed clean`);
    expect(r.out).toContain(`replay at ${rev['Ask for brevity']}  ✗ diverged at call 1 (api POST /v1/messages) · $.system`);
    expect(r.stdout).toMatch(new RegExp(`✓ first bad commit ${rev['Ask for brevity']} · Ask for brevity · Ravi · \\d{4}-\\d{2}-\\d{2}`));
    expect(r.stdout).toContain('diverged at call 1 (api POST /v1/messages) · $.system · 4 replays · 0 tokens · 0 upstream requests');
    expect(mock.requests.length, 'replays never reach the model').toBe(hits);
    // Every worktree is gone, from git and from disk.
    expect(sh('git', ['worktree', 'list']).split('\n')).toHaveLength(1);
    expect(readdirSync(join(project, '.shadowlap', 'bisect'))).toEqual([]);
    expect(sh('git', ['status', '--porcelain']), 'nothing left in the working tree').toBe('');
    const store = Store.open(join(project, '.shadowlap', 'shadowlap.db'));
    expect(store.listEvents({ kinds: ['bisect.found'] })[0]).toMatchObject({ ref: 'goldens/summary', data: { commit: rev['Ask for brevity'], subject: 'Ask for brevity', good: rev['Start the ticket agent'], bad: rev['Mark summaries as drafts'], first: { rev: rev['Ask for brevity'], subject: 'Ask for brevity', author: 'Ravi' }, replays: 4, tokens: 0, upstreamRequests: 0 } });
    store.close();
  });

  it('finds the commit where an outcome check starts failing, for a run in the store, as JSON', async () => {
    const r = await shadowlap(['bisect', 'goldens/brief', '--good', rev['Mention the prompt']!, '--expect', '{"output":{"excludes":"DRAFT"}}', '--json']);
    expect(r.code, r.out).toBe(0);
    const report = JSON.parse(r.stdout) as { outcome: string; first: { short: string; why: string }; steps: Array<{ short: string; ok: boolean; result: string }>; commits: number; tokens: number };
    expect(report).toMatchObject({ outcome: 'found', commits: 1, tokens: 0, first: { short: rev['Mark summaries as drafts'], why: 'check failed: output doesn\'t include "DRAFT", but found in the output' } });
    expect(report.steps.map((s) => [s.short, s.ok])).toEqual([[rev['Mark summaries as drafts'], false], [rev['Mention the prompt'], true]]);

    const byRun = await shadowlap(['bisect', recordedRun.slice(0, 12), '--good', rev['Start the ticket agent']!, '--bad', rev['Mention the prompt']!]);
    expect(byRun.code, byRun.out).toBe(0);
    expect(byRun.stdout).toContain(`first bad commit ${rev['Ask for brevity']} · Ask for brevity`);
  });

  it('with --fork, finds where a run that failed a check started failing, going live from each fork', async () => {
    const hits = mock.requests.length;
    // The second recording, whose answer is "Short.", which the check rules out.
    const r = await shadowlap(['bisect', briefRun, '--good', rev['Start the ticket agent']!, '--bad', rev['Mention the prompt']!, '--expect', '{"answer":{"excludes":"Short"}}', '--fork', '--json']);
    expect(r.code, r.out).toBe(0);
    const report = JSON.parse(r.stdout) as { first: { short: string; why: string }; upstreamRequests: number; tokens: number; steps: Array<{ short: string; ok: boolean; result: string }> };
    expect(report.first).toMatchObject({ short: rev['Ask for brevity'], why: 'check failed: final answer doesn\'t include "Short", but found in the final answer' });
    // Commits before the change diverge at the prompt and run live from there, so they cost what they cost.
    expect(report.steps.find((s) => s.short === rev['Start the ticket agent'])).toMatchObject({ ok: true, result: 'forked at call 1, 1 check passed' });
    expect(report.upstreamRequests).toBe(mock.requests.length - hits);
    expect(report.upstreamRequests).toBeGreaterThan(0);
    expect(report.tokens).toBeGreaterThan(0);
  });

  it('tells a dashboard job what it found and where that shows', async () => {
    const events = await new Promise<Array<Record<string, unknown>>>((resolve) => {
      const child = spawn(process.execPath, [CLI, 'bisect', 'goldens/summary', '--good', rev['Start the ticket agent']!, '--json'], { cwd: project, env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off', SHADOWLAP_EVENTS_FD: '3' }, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
      let raw = '';
      child.stdout!.resume();
      child.stderr!.resume();
      (child.stdio[3] as NodeJS.ReadableStream).on('data', (d: Buffer) => (raw += d.toString()));
      child.on('close', () => resolve(raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)));
    });
    expect((events.find((e) => e.type === 'result')!.data as { first: { short: string } }).first.short).toBe(rev['Ask for brevity']);
    expect(events.find((e) => e.type === 'link')).toEqual({ type: 'link', label: 'Open Tests', href: '#/tests' });
  });

  it('says when there is nothing to find, or the good commit already fails', async () => {
    const passes = await shadowlap(['bisect', 'goldens/summary', '--good', rev['Start the ticket agent']!, '--bad', rev['Add usage']!]);
    expect(passes.code).toBe(1);
    expect(passes.stdout).toContain(`no first bad commit: it passes at ${rev['Add usage']}, so there is nothing to find`);
    const fails = await shadowlap(['bisect', 'goldens/summary', '--good', rev['Ask for brevity']!]);
    expect(fails.code).toBe(1);
    expect(fails.stdout).toContain(`no first bad commit: it already fails at ${rev['Ask for brevity']}: diverged at call 1`);
    // Each answer is kept, for Tests to show above the golden's buttons until it passes again.
    const store = Store.open(join(project, '.shadowlap', 'shadowlap.db'));
    const none = store.listEvents({ kinds: ['bisect.none'] });
    store.close();
    expect(none.map((e) => [e.ref, (e.data as { outcome: string }).outcome])).toEqual([
      ['goldens/summary', 'fails-at-good'],
      ['goldens/summary', 'passes-at-bad'],
    ]);
    expect(none[0]!.data).toMatchObject({ why: expect.stringContaining(`it already fails at ${rev['Ask for brevity']}`), good: rev['Ask for brevity'], bad: rev['Mark summaries as drafts'] });
    const backwards = await shadowlap(['bisect', 'goldens/summary', '--good', rev['Mention the prompt']!, '--bad', rev['Describe the agent']!]);
    expect(backwards.code).toBe(1);
    expect(backwards.out).toContain(`--good ${rev['Mention the prompt']} comes after --bad ${rev['Describe the agent']}`);
    const unknown = await shadowlap(['bisect', 'goldens/nothing', '--good', 'HEAD~1']);
    expect(unknown.out).toContain('goldens/nothing is neither a golden');
    expect(sh('git', ['worktree', 'list']).split('\n')).toHaveLength(1);
  });

  it('names the failure each answer is about: the golden’s newest result as the search started', async () => {
    const tested = await shadowlap(['test', 'goldens/summary']);
    expect(tested.code, tested.out).toBe(1);
    const r = await shadowlap(['bisect', 'goldens/summary', '--good', rev['Start the ticket agent']!]);
    expect(r.code, r.out).toBe(0);
    const store = Store.open(join(project, '.shadowlap', 'shadowlap.db'));
    const result = store.listTestResults({ golden: 'goldens/summary', limit: 1 })[0]!;
    const found = store.listEvents({ kinds: ['bisect.found'] })[0]!;
    store.close();
    expect(found.data).toMatchObject({ commit: rev['Ask for brevity'], answered: { session: result.sessionId, at: result.at, ok: false, revision: result.revision } });
  });

  it('asks before running the recorded command of a run from someone else\'s pack at every commit, and refuses with no one to ask', async () => {
    // Someone else's recording: its command writes where it ran to a file outside the repository, then runs the agent.
    const away = mkdtempSync(join(tmpdir(), 'sl-bisect-theirs-'));
    try {
      const marker = join(away, 'ran.txt');
      const script = `require('node:fs').appendFileSync(${JSON.stringify(marker)}, process.cwd() + '\\n'); import('./agent.mjs')`;
      const theirs = join(away, 'theirs.db');
      const recorded = await shadowlap(['--db', theirs, 'run', '--', process.execPath, '-e', script]);
      expect(recorded.code, recorded.out).toBe(0);
      const runId = /recording run (\w{26})/.exec(recorded.out)![1]!;
      expect((await shadowlap(['--db', theirs, 'pack', runId, join(away, 'pack')])).code).toBe(0);
      rmSync(marker);
      expect((await shadowlap(['unpack', join(away, 'pack')])).code).toBe(0);
      const range = ['--good', rev['Start the ticket agent']!, '--bad', rev['Describe the agent']!];

      // No terminal: refused, as a replay of it is, and nothing ran.
      const refused = await shadowlap(['bisect', runId, ...range]);
      expect(refused.code, refused.out).toBe(1);
      expect(refused.out).toContain('was imported from a pack. Replaying it runs the command it was recorded with');
      expect(refused.out).toContain(`Pass --yes to run it, or give your own command: shadowlap bisect ${runId.slice(0, 10)} --good ${rev['Start the ticket agent']} -- <command>`);
      expect(refused.out).not.toContain('replay at');
      expect(existsSync(marker), 'the imported command never ran').toBe(false);
      const json = await shadowlap(['bisect', runId, ...range, '--json']);
      expect(json.code).toBe(1);
      expect(JSON.parse(json.stdout)).toMatchObject({ outcome: 'error', error: { message: expect.stringContaining('needs your consent (--yes)') } });
      expect(existsSync(marker)).toBe(false);

      // A command of your own runs without asking, in each commit's worktree (where it diverges: it was recorded at HEAD).
      const own = await shadowlap(['bisect', runId, ...range, '--', process.execPath, 'agent.mjs']);
      expect(own.out).toContain(`replay at ${rev['Describe the agent']}  ✗ diverged at call 1`);
      expect(existsSync(marker)).toBe(false);

      // --yes runs the recorded command at every commit it tries.
      const yes = await shadowlap(['bisect', runId, ...range, '--yes']);
      expect(yes.out).toContain(`replay at ${rev['Describe the agent']}  ✗ diverged at call 1`);
      expect(readFileSync(marker, 'utf8')).toContain(join('.shadowlap', 'bisect'));
    } finally {
      rmSync(away, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });

  it('refuses a run that is still recording, whose recording is not whole yet', async () => {
    const store = Store.open(join(project, '.shadowlap', 'shadowlap.db'));
    const recording = store.createRun({ mode: 'record', command: { argv: [process.execPath, 'agent.mjs'], cwd: project } });
    store.close();
    const r = await shadowlap(['bisect', recording.runId, '--good', rev['Start the ticket agent']!, '--json']);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({ outcome: 'error', error: { message: `${recording.runId.slice(0, 10)} is still recording: find the commit once it has ended` } });
    expect(sh('git', ['worktree', 'list']).split('\n')).toHaveLength(1);
  });

  it('takes a run its recorder left as it stands, interrupted, not as one still recording', async () => {
    const db = join(project, '.shadowlap', 'shadowlap.db');
    const store = Store.open(db);
    // Built from a capture, so the search stops at once, past where a run still recording is refused.
    const left = store.createRun({ mode: 'record', command: { argv: [NO_COMMAND], cwd: project } });
    store.close();
    // Its recorder was killed: the store still names it, and it is gone.
    const raw = new DatabaseSync(db);
    raw.prepare('UPDATE run_owners SET pid = ? WHERE run_id = ?').run(spawnSync(process.execPath, ['-e', '0']).pid!, left.runId);
    raw.close();
    const r = await shadowlap(['bisect', left.runId, '--good', rev['Start the ticket agent']!, '--json']);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({ outcome: 'error', error: { message: expect.stringContaining('was imported from a capture and has no command to run at each commit') } });
  });
});

describe('commits bisect cannot test', () => {
  // A build step that fails where BROKEN is, in a command line both sh and Windows' cmd.exe read alike.
  const build = `"${process.execPath}" -e "process.exit(require('fs').existsSync('BROKEN') ? 1 : 0)"`;

  it('skips a commit that won\'t build and names it when the first bad commit could be it', async () => {
    const r = await shadowlap(['bisect', 'goldens/summary', '--good', rev['Start the ticket agent']!, '--build', build, '--json']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`replay at ${rev['Add usage']}  – skipped: could not be built`);
    const report = JSON.parse(r.stdout) as { first: { short: string }; untested: Array<{ short: string; subject: string }>; steps: Array<{ short: string; skipped: boolean }> };
    expect(report.first.short).toBe(rev['Ask for brevity']);
    expect(report.untested).toEqual([expect.objectContaining({ short: rev['Add usage'], subject: 'Add usage' })]);
    expect(report.steps.find((x) => x.short === rev['Add usage'])!.skipped).toBe(true);
    const text = await shadowlap(['bisect', 'goldens/summary', '--good', rev['Start the ticket agent']!, '--build', build]);
    expect(text.stdout).toContain(`or one just before it, which could not be tested: ${rev['Add usage']} (Add usage)`);
  });

  it('searches from where the histories meet when the good commit is on another branch', async () => {
    const r = await shadowlap(['bisect', 'goldens/summary', '--good', rev['Side note']!]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`--good ${rev['Side note']} is not an ancestor of --bad HEAD: searching from where their histories meet, ${rev['Describe the agent']}`);
    expect(r.stdout).toContain(`first bad commit ${rev['Ask for brevity']}`);
  });
});

// A shell build step that sleeps, so there is time to interrupt; Windows has no sleep.
describe.skipIf(process.platform === 'win32')('an interrupted bisect', () => {
  it('stops at Ctrl-C, concludes nothing from the replay it cut short, and removes its worktrees', async () => {
    const child = spawn(process.execPath, [CLI, 'bisect', 'goldens/summary', '--good', rev['Start the ticket agent']!, '--build', 'sleep 2'], { cwd: project, env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let interrupted = false;
    // Ctrl-C once the first commit has been tried, as the next one builds (two seconds): bisect
    // listens for it by then. A fixed delay from the start ran out before that on a busy machine,
    // where the CLI was slow to start, and the signal ended it outright.
    const interrupt = () => {
      if (interrupted || !out.includes('replay at ')) return;
      interrupted = true;
      child.kill('SIGINT');
    };
    child.stdout.on('data', (d: Buffer) => ((out += d.toString()), interrupt()));
    child.stderr.on('data', (d: Buffer) => ((out += d.toString()), interrupt()));
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    expect(code, out).toBe(1);
    expect(out).toContain('no first bad commit: interrupted');
    expect(out).not.toContain('first bad commit ' + rev['Ask for brevity']);
    expect(sh('git', ['worktree', 'list']).split('\n')).toHaveLength(1);
    expect(readdirSync(join(project, '.shadowlap', 'bisect'))).toEqual([]);
  });
});

describe('a good commit on a branch that was merged', () => {
  // main:     Start ─ Main one ─ Main two ─ Merge
  //              └─ Feature prompt (good) ─ Feature breaks ─┘
  // The golden is recorded at Feature prompt. Main one and Main two never had its prompt, so their
  // replays diverge too, but neither has the good commit in its history: the first bad commit on
  // the first-parent line that does is the merge.
  let repo = '';
  const at: Record<string, string> = {};
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  const step = (name: string, files: Record<string, string>) => {
    for (const [f, content] of Object.entries(files)) writeFileSync(join(repo, f), content);
    git(['add', '.']);
    git(['commit', '-q', '-m', name]);
    at[name] = git(['rev-parse', '--short', 'HEAD']);
  };
  const run = (args: string[]) =>
    new Promise<{ code: number | null; out: string; stdout: string }>((resolve) => {
      const child = spawn(process.execPath, [CLI, ...args], { cwd: repo, env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let stdout = '';
      child.stdout.on('data', (d: Buffer) => ((out += d.toString()), (stdout += d.toString())));
      child.stderr.on('data', (d: Buffer) => (out += d.toString()));
      child.on('exit', (code) => resolve({ code, out, stdout }));
    });

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'sl-bisect-merge-'));
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    step('Start', { '.gitignore': '.shadowlap/\ngoldens/\n', 'agent.mjs': AGENT, 'prompt.txt': 'You summarize support tickets.\n', 'marker.txt': '\n', 'NOTES.md': 'start\n' });
    git(['checkout', '-q', '-b', 'feature']);
    step('Feature prompt', { 'prompt.txt': 'You summarize support tickets, in order.\n' });
    const recorded = await run(['run', '--', process.execPath, 'agent.mjs']);
    expect(recorded.code, recorded.out).toBe(0);
    expect((await run(['pack', /recording run (\w{26})/.exec(recorded.out)![1]!, 'goldens/merged'])).code).toBe(0);
    step('Feature breaks', { 'prompt.txt': 'You summarize support tickets. Be brief.\n' });
    git(['checkout', '-q', 'main']);
    step('Main one', { 'NOTES.md': 'start\none\n' });
    step('Main two', { 'NOTES.md': 'start\none\ntwo\n' });
    git(['merge', '-q', '--no-ff', 'feature', '-m', 'Merge']);
    at['Merge'] = git(['rev-parse', '--short', 'HEAD']);
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

  it('names the merge that brought the breaking commit in, not a main-line commit that never had the good one', async () => {
    const r = await run(['bisect', 'goldens/merged', '--good', at['Feature prompt']!, '--json']);
    expect(r.code, r.out).toBe(0);
    const report = JSON.parse(r.stdout) as { outcome: string; commits: number; first: { short: string }; steps: Array<{ short: string }> };
    expect(report).toMatchObject({ outcome: 'found', commits: 1, first: { short: at['Merge'] } });
    expect(report.steps.map((x) => x.short)).not.toContain(at['Main one']);
    expect(report.steps.map((x) => x.short)).not.toContain(at['Main two']);
  });
});

describe('a package this repository links into node_modules', () => {
  let repo = '';
  const at: Record<string, string> = {};
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  const step = (name: string, files: Record<string, string>) => {
    for (const [f, content] of Object.entries(files)) {
      mkdirSync(join(repo, f, '..'), { recursive: true });
      writeFileSync(join(repo, f), content);
    }
    git(['add', '.']);
    git(['commit', '-q', '-m', name]);
    at[name] = git(['rev-parse', '--short', 'HEAD']);
  };
  const run = (args: string[]) =>
    new Promise<{ code: number | null; out: string; stdout: string }>((resolve) => {
      const child = spawn(process.execPath, [CLI, ...args], { cwd: repo, env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let stdout = '';
      child.stdout.on('data', (d: Buffer) => {
        out += d.toString();
        stdout += d.toString();
      });
      child.stderr.on('data', (d: Buffer) => (out += d.toString()));
      child.on('exit', (code) => resolve({ code, out, stdout }));
    });

  beforeAll(async () => {
    // A workspace package with the prompt, linked into node_modules as npm workspaces link one.
    repo = mkdtempSync(join(tmpdir(), 'sl-bisect-ws-'));
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    const agent = AGENT.replace("const system = readFileSync(new URL('./prompt.txt', import.meta.url), 'utf8').trim();", "import { system } from '@acme/prompt';").replace("const marker = readFileSync(new URL('./marker.txt', import.meta.url), 'utf8').trim();", "const marker = '';").replace("import { readFileSync } from 'node:fs';\n", '');
    step('Start', { '.gitignore': '.shadowlap/\nnode_modules/\n', 'agent.mjs': agent, 'lib/prompt/package.json': JSON.stringify({ name: '@acme/prompt', type: 'module', exports: './index.mjs' }), 'lib/prompt/index.mjs': "export const system = 'You summarize support tickets.';\n" });
    mkdirSync(join(repo, 'node_modules', '@acme'), { recursive: true });
    symlinkSync(join('..', '..', 'lib', 'prompt'), join(repo, 'node_modules', '@acme', 'prompt'));
    const recorded = await run(['run', '--', process.execPath, 'agent.mjs']);
    expect(recorded.code, recorded.out).toBe(0);
    expect((await run(['pack', /recording run (\w{26})/.exec(recorded.out)![1]!, 'goldens/ws'])).code).toBe(0);
    step('Document it', { 'README.md': 'docs\n' });
    step('Ask for brevity in the package', { 'lib/prompt/index.mjs': "export const system = 'You summarize support tickets. Be brief.';\n" });
    step('More docs', { 'README.md': 'more docs\n' });
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

  it('replays each commit with its own copy of the package, not the working tree\'s', async () => {
    const r = await run(['bisect', 'goldens/ws', '--good', at['Start']!]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("node_modules is linked from your working tree, with this repository's own packages as they were at each commit");
    expect(r.stdout).toContain(`first bad commit ${at['Ask for brevity in the package']} · Ask for brevity in the package`);
    // The working tree's own node_modules is untouched.
    expect(lstatSync(join(repo, 'node_modules', '@acme', 'prompt')).isSymbolicLink()).toBe(true);
    expect(git(['worktree', 'list']).split('\n')).toHaveLength(1);
  });
});

describe('the command at each commit', () => {
  it('runs files from the worktree, and executables only the working tree has from there', () => {
    const root = join(project, 'repo');
    const m = { root, worktree: join(root, '.shadowlap', 'bisect', 'run-x', 'abc1234'), cwd: root, worktreeCwd: join(root, '.shadowlap', 'bisect', 'run-x', 'abc1234') };
    expect(mapArgv(['node', 'agent.mjs'], m)).toEqual(['node', 'agent.mjs']);
    expect(mapArgv(['node', join(root, 'dist', 'agent.js')], m)).toEqual(['node', join(m.worktree, 'dist', 'agent.js')]);
    expect(mapArgv([join(root, '.venv', 'bin', 'python'), 'agent.py'], m)).toEqual([join(root, '.venv', 'bin', 'python'), 'agent.py']);
    expect(mapArgv(['node', '/elsewhere/agent.js'], m)).toEqual(['node', '/elsewhere/agent.js']);
    expect(mapArgv(['node', join(`${root}-sibling`, 'agent.js')], m)).toEqual(['node', join(`${root}-sibling`, 'agent.js')]);
    expect(existsSync(m.worktree)).toBe(false);
  });

  it('maps a path that reaches the repository through a symbolic link', () => {
    const link = `${project}-link`;
    symlinkSync(project, link);
    try {
      const worktree = join(project, '.shadowlap', 'bisect', 'run-x', 'abc1234');
      const m = { root: project, worktree, cwd: project, worktreeCwd: worktree };
      expect(mapArgv(['node', join(link, 'agent.mjs')], m)).toEqual(['node', join(worktree, 'agent.mjs')]);
      expect(mapArgv(['node', join(project, 'agent.mjs')], { ...m, root: link })).toEqual(['node', join(worktree, 'agent.mjs')]);
      // The system's real path: on Windows it writes out a short name such as RUNNER~1, as git does.
      expect(physicalPath(join(link, 'not-yet', 'there.js'))).toBe(join(realpathSync.native(project), 'not-yet', 'there.js'));
    } finally {
      rmSync(link, { force: true });
    }
  });
});

describe('a repository reached through a symbolic link', () => {
  it('replays each commit\'s own copy of a command recorded through the link, and takes --cwd through it', async () => {
    const link = `${project}-via`;
    symlinkSync(project, link);
    try {
      // Recorded at the last commit, through the link: its answer is "Short." and its output is marked as a draft.
      const recorded = await shadowlap(['run', '--', process.execPath, join(link, 'agent.mjs')]);
      expect(recorded.code, recorded.out).toBe(0);
      const runId = /recording run (\w{26})/.exec(recorded.out)![1]!;
      const r = await shadowlap(['bisect', runId, '--good', rev['Mention the prompt']!, '--expect', '{"output":{"excludes":"DRAFT"}}', '--cwd', link]);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain(`replay at ${rev['Mention the prompt']}  replayed clean · 1 check passed`);
      expect(r.stdout).toContain(`first bad commit ${rev['Mark summaries as drafts']} · Mark summaries as drafts`);
      expect(sh('git', ['worktree', 'list']).split('\n')).toHaveLength(1);
    } finally {
      rmSync(link, { force: true });
    }
  });

  // Where a volume ignores case, a folder given in another case is the same folder, and git names the
  // repository in the case on disk. Where case matters (Linux), another case is another folder.
  it.skipIf(!CASE_INSENSITIVE)('takes --cwd given in another letter case, where the volume ignores case', async () => {
    const other = join(dirname(project), basename(project).toUpperCase());
    const r = await shadowlap(['bisect', briefRun, '--good', rev['Mention the prompt']!, '--expect', '{"output":{"excludes":"DRAFT"}}', '--cwd', other]);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toContain(`first bad commit ${rev['Mark summaries as drafts']} · Mark summaries as drafts`);
  });

  it('refuses a revision that would reach git as an option', async () => {
    const r = await shadowlap(['bisect', 'goldens/summary', '--good=--output=x']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('--good --output=x is not a commit in this repository');
    expect(existsSync(join(project, 'x'))).toBe(false);
  });
});
