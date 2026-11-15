import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { trackInGit } from './tracked.js';
import { parseRepairer } from '../src/repairer.js';
import { githubAnnotations, markdownReport, testReport, type PackResult } from '../src/test-report.js';
import { gateResult, Store } from '@shadowlap/engine';
import { EVENTS } from '../../../action/events.mjs';
import { hasHistoryGate, historyPlan, keyPart } from '../../../action/history.mjs';

/**
 * The GitHub Action's script (action/run.mjs) run the way action.yml runs it, against the committed
 * golden recording: inputs in INPUT_* variables, outputs and the job summary in the files GitHub
 * names in GITHUB_OUTPUT and GITHUB_STEP_SUMMARY.
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const RUN = join(ROOT, 'action', 'run.mjs');
const CLI = join(ROOT, 'packages', 'cli', 'bin', 'shadowlap.js');
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function action(inputs: Record<string, string>, extraEnv: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fp-action-'));
  dirs.push(dir);
  const output = join(dir, 'output');
  const summary = join(dir, 'summary.md');
  writeFileSync(output, '');
  writeFileSync(summary, '');
  // The test history goes to a store of the test's own, not the repository's. A job for a push, as
  // GitHub names its event, unless the test names another: never the event of the job running the tests.
  const env: NodeJS.ProcessEnv = { ...process.env, SHADOWLAP_CLI: CLI, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, RUNNER_TEMP: dir, NO_COLOR: '1', SHADOWLAP_GUARD: 'off', INPUT_STORE: join(dir, 'shadowlap.db'), GITHUB_EVENT_NAME: 'push', ...extraEnv };
  for (const [k, v] of Object.entries(inputs)) env[`INPUT_${k}`] = v;
  const r = spawnSync(process.execPath, [RUN], { cwd: ROOT, env, encoding: 'utf8', timeout: 120_000 });
  const outputs = Object.fromEntries(readFileSync(output, 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  return { code: r.status, out: `${r.stdout}${r.stderr}`, outputs, summary: readFileSync(summary, 'utf8') };
}

describe('the GitHub Action', () => {
  it('passes a clean replay and reports it in the outputs and the job summary', () => {
    const r = action({ RECORDINGS: 'testing/golden/*', WORKING_DIRECTORY: ROOT, GUARD: 'off' });
    expect(r.code).toBe(0);
    expect(r.outputs).toMatchObject({ passed: '1', failed: '0', diverged: '0', 'checks-failed': '0', fixes: '0', 'fix-prs': '' });
    expect(r.outputs.session).toMatch(/^\w{26}$/);
    expect(readFileSync(r.outputs['report-json'], 'utf8')).toContain('"passed": 1');
    expect(r.summary).toContain('### shadowlap: 1 of 1 golden passed');
    expect(r.summary).toMatch(/✅ \| `reference-agent` \| clean \| 30\/30/);
    expect(r.out).not.toContain('::error');
  });

  it('fails a diverging replay, annotates it and puts the diff in the summary', () => {
    const r = action({ RECORDINGS: 'testing/golden/reference-agent', WORKING_DIRECTORY: ROOT, GUARD: 'off' }, { AGENT_SYSTEM_SUFFIX: 'Be brief.' });
    expect(r.code).toBe(1);
    expect(r.outputs).toMatchObject({ passed: '0', failed: '1', diverged: '1', 'checks-failed': '0' });
    expect(r.out).toContain('::error file=testing/golden/reference-agent/run.json,title=shadowlap%3A reference-agent::diverged at call 3');
    expect(r.summary).toContain('### shadowlap: 0 of 1 golden passed · 1 failed');
    expect(r.summary).toContain('+ "You are a research agent. Use the tools, then email a summary. Be brief."');
    expect(r.summary).toContain('update the golden: `shadowlap test testing/golden/reference-agent --update`');
  });

  it('reports without failing the step when fail-on-divergence is false', () => {
    const r = action({ RECORDINGS: 'testing/golden/reference-agent', WORKING_DIRECTORY: ROOT, GUARD: 'off', FAIL_ON_DIVERGENCE: 'false', ANNOTATIONS: 'false', SUMMARY: 'false' }, { AGENT_SYSTEM_SUFFIX: 'Be brief.' });
    expect(r.code).toBe(0);
    expect(r.outputs.failed).toBe('1');
    expect(r.out).not.toContain('::error');
    expect(r.summary).toBe('');
  });

  it('says what is wrong with its inputs', () => {
    const none = action({ RECORDINGS: 'goldens/*', WORKING_DIRECTORY: ROOT });
    expect(none.code).toBe(1);
    expect(none.out).toContain('no recordings match goldens/*');
    const bad = action({ RECORDINGS: 'testing/golden/*', WORKING_DIRECTORY: ROOT, WRITES: 'maybe' });
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('input writes must be block, stub or allow');
    const deep = action({ RECORDINGS: 'testing/*/reference-agent', WORKING_DIRECTORY: ROOT });
    expect(deep.out).toContain('only the last part of a recordings path may contain a wildcard');
    const budget = action({ RECORDINGS: 'testing/golden/*', WORKING_DIRECTORY: ROOT, FIX_BUDGET: 'lots' });
    expect(budget.out).toContain('input fix-budget must be an amount in dollars');
    const repairer = action({ RECORDINGS: 'testing/golden/*', WORKING_DIRECTORY: ROOT, REPAIRER: 'gpt' });
    expect(repairer.out).toContain('input repairer must be claude-code, claude-code:<model>, anthropic, anthropic:<model> or openai:<model>, not "gpt"');
    // One the CLI would refuse once the tests had run: an openai repairer names its model.
    expect(action({ RECORDINGS: 'testing/golden/*', WORKING_DIRECTORY: ROOT, REPAIRER: 'openai' }).out).toContain('input repairer must be claude-code, claude-code:<model>, anthropic, anthropic:<model> or openai:<model>, not "openai"');
  });

  it('never takes a hidden folder for a recording, as shadowlap test doesn\'t', () => {
    // What an interrupted update or another tool might leave beside the goldens.
    const project = mkdtempSync(join(tmpdir(), 'fp-hidden-'));
    dirs.push(project);
    cpSync(join(ROOT, 'testing', 'golden', 'reference-agent'), join(project, 'goldens', '.reference-agent.new-1'), { recursive: true });
    const r = action({ RECORDINGS: 'goldens/*', WORKING_DIRECTORY: project });
    expect(r.code).toBe(1);
    expect(r.out).toContain('no recordings match goldens/*');
  });

  it('fails a path that names no pack, and a pattern that matches none, as shadowlap test does', () => {
    // A typo in a list of goldens: the one that exists passes, the other fails the step rather than drop out of the test.
    const typo = action({ RECORDINGS: 'testing/golden/reference-agent testing/golden/reference-agnet', WORKING_DIRECTORY: ROOT, GUARD: 'off' });
    expect(typo.code).toBe(1);
    expect(typo.outputs).toMatchObject({ passed: '1', failed: '1' });
    expect(typo.out).toContain('shadowlap test testing/golden/reference-agent testing/golden/reference-agnet');
    expect(typo.out).toContain('testing/golden/reference-agnet is not a shadowlap pack (no run.json)');
    // Its annotation and its part of the summary say that once: the failure's message is all there is to it.
    expect(typo.out).toMatch(/^::error file=testing\/golden\/reference-agnet\/run\.json,title=shadowlap%3A reference-agnet::testing\/golden\/reference-agnet is not a shadowlap pack \(no run\.json\)$/m);
    expect(typo.summary.split('reference-agnet is not a shadowlap pack')).toHaveLength(3);
    // A pattern beside one that matches, which matches nothing: the step fails before anything runs.
    const empty = action({ RECORDINGS: 'testing/golden/* testing/golden/refund-*', WORKING_DIRECTORY: ROOT, GUARD: 'off' });
    expect(empty.code).toBe(1);
    expect(empty.out).toContain('no recordings match testing/golden/refund-*');
    expect(empty.out).not.toContain('shadowlap test ');
  });

  it('counts a golden whose check could not be decided apart from a failed check, and fails the job all the same', () => {
    // The committed golden in a project of its own, with a judge check no run can answer here.
    const project = mkdtempSync(join(tmpdir(), 'fp-unjudged-'));
    dirs.push(project);
    cpSync(join(ROOT, 'testing', 'golden', 'reference-agent'), join(project, 'goldens', 'reference-agent'), { recursive: true });
    symlinkSync(join(ROOT, 'testing'), join(project, 'testing'), 'dir');
    writeFileSync(join(project, 'shadowlap.config.json'), JSON.stringify({ tests: { 'goldens/reference-agent': { expect: { judge: [{ name: 'summarizes', question: 'Does the email summarize what the agent found?', model: 'claude-haiku-4-5' }] } } } }));
    trackInGit(project, 'goldens', 'shadowlap.config.json');
    const r = action({ RECORDINGS: 'goldens/*', WORKING_DIRECTORY: project, GUARD: 'off' });
    expect(r.code, r.out).toBe(1);
    expect(r.outputs).toMatchObject({ passed: '0', failed: '1', diverged: '0', 'checks-failed': '0', inconclusive: '1' });
    expect(r.summary).toContain('### shadowlap: 0 of 1 golden passed · 1 inconclusive');
    expect(r.summary).toContain('| 🟡 | `reference-agent` |');
  });

  it('opens no fix for a divergence, even with fix-on-failure on', () => {
    const r = action({ RECORDINGS: 'testing/golden/reference-agent', WORKING_DIRECTORY: ROOT, GUARD: 'off', FIX_ON_FAILURE: 'true', FAIL_ON_DIVERGENCE: 'false' }, { AGENT_SYSTEM_SUFFIX: 'Be brief.' });
    expect(r.code).toBe(0);
    expect(r.outputs).toMatchObject({ failed: '1', diverged: '1', fixes: '0' });
    expect(r.out).toContain('reference-agent: no fix pull request: diverged: never fixed automatically, because most divergences are intended');
    expect(r.summary).toContain('### shadowlap: no fix pull request opened');
  });
});

describe('the GitHub Action and inconclusive goldens', () => {
  // A stand-in for the CLI that keeps the arguments it was given and reports one golden as
  // inconclusive, failing or passing the run as --inconclusive says, as shadowlap test does.
  const fake = (() => {
    const dir = mkdtempSync(join(tmpdir(), 'fp-action-cli-'));
    dirs.push(dir);
    const cli = join(dir, 'fake-cli.mjs');
    writeFileSync(
      cli,
      [
        "import { appendFileSync, writeFileSync } from 'node:fs';",
        'const args = process.argv.slice(2);',
        'writeFileSync(process.env.FAKE_ARGS, JSON.stringify(args));',
        "writeFileSync(process.env.FAKE_ARGS + '.accept', process.env.SHADOWLAP_GUARD_ACCEPT ?? '(unset)');",
        "const at = (flag) => args[args.indexOf(flag) + 1];",
        "const warn = at('--inconclusive') === 'warn';",
        "const result = { name: 'reference-agent', dir: 'testing/golden/reference-agent', golden: 'testing/golden/reference-agent', mode: 'fork', ok: warn, verdict: 'inconclusive', failure: 'inconclusive', message: 'inconclusive · 64 of 80 · rate 0.70 to 0.87 (95%) · gate: tells 90%+ from 70%- at <= 5% risk, up to 80 attempts', details: null, output: null, checks: null };",
        "writeFileSync(at('--json'), JSON.stringify({ version: 1, session: '01K5CQ4N7G8M2XWQH6V3T9RB1D', revision: null, passed: warn ? 1 : 0, failed: warn ? 0 : 1, inconclusive: 1, interrupted: false, results: [result] }));",
        "appendFileSync(at('--markdown'), '### shadowlap: 0 of 1 golden passed · 1 inconclusive\\n');",
        'process.exit(warn ? 0 : 1);',
      ].join('\n'),
    );
    return { cli, args: join(dir, 'args.json') };
  })();
  const run = (inputs: Record<string, string>) => action({ RECORDINGS: 'testing/golden/reference-agent', WORKING_DIRECTORY: ROOT, ...inputs }, { SHADOWLAP_CLI: fake.cli, FAKE_ARGS: fake.args });
  const given = () => JSON.parse(readFileSync(fake.args, 'utf8')) as string[];

  it('leaves an inconclusive golden to shadowlap test by default, which fails the step on this one, and counts it in both outputs', () => {
    const r = run({});
    expect(r.code).toBe(1);
    // No --inconclusive: the CLI's default, under which only a gate against history with too few sessions yet warns.
    expect(given()).not.toContain('--inconclusive');
    expect(given()).not.toContain('--max-attempts');
    expect(r.outputs).toMatchObject({ passed: '0', failed: '1', inconclusive: '1', diverged: '0', 'checks-failed': '0' });
    // inconclusive: fail says so.
    run({ INCONCLUSIVE: 'fail' });
    expect(given()).toEqual(expect.arrayContaining(['--inconclusive', 'fail']));
  });

  it('lets it through with inconclusive: warn, still counting it, and passes max-attempts on', () => {
    const r = run({ INCONCLUSIVE: 'warn', MAX_ATTEMPTS: '160' });
    expect(r.code).toBe(0);
    const args = given();
    expect(args.slice(args.indexOf('--inconclusive'), args.indexOf('--inconclusive') + 2)).toEqual(['--inconclusive', 'warn']);
    expect(args.slice(args.indexOf('--max-attempts'), args.indexOf('--max-attempts') + 2)).toEqual(['--max-attempts', '160']);
    expect(r.outputs).toMatchObject({ passed: '1', failed: '0', inconclusive: '1' });
  });

  it('passes a recording folder named like a flag as a path, which shadowlap test reads as a folder', () => {
    // At the root, `*` finds `-x` and `--online` as they are: on the command line, flags.
    const project = mkdtempSync(join(tmpdir(), 'fp-flag-folders-'));
    dirs.push(project);
    for (const name of ['-x', '--online', 'refund']) {
      mkdirSync(join(project, name));
      writeFileSync(join(project, name, 'run.json'), '{}');
    }
    run({ RECORDINGS: '*', WORKING_DIRECTORY: project });
    const args = given();
    expect(args.slice(args.indexOf('test') + 1, args.indexOf('--json'))).toEqual(['./--online', './-x', 'refund']);
    expect(args).not.toContain('--online');
    expect(args).not.toContain('-x');
  });

  it('hands guard-accept to the CLI, which accepts the Claude Code CLI alone under guard block', () => {
    run({ GUARD_ACCEPT: ' claude-code ' });
    expect(readFileSync(`${fake.args}.accept`, 'utf8')).toBe('claude-code');
    expect(given().slice(given().indexOf('--guard'), given().indexOf('--guard') + 2)).toEqual(['--guard', 'block']);
    run({});
    expect(readFileSync(`${fake.args}.accept`, 'utf8')).toBe('(unset)');
    const node = run({ GUARD_ACCEPT: 'claude-code,node' });
    expect(node.code).toBe(1);
    expect(node.out).toContain('input guard-accept must be claude-code, not "node": a Node or Python process whose guard is off still fails guard block');
  });

  it('pushes the session to the team store with push: true, as Push from CI’s step asks, and not by default', () => {
    run({ PUSH: 'true' });
    expect(given()).toContain('--push');
    run({});
    expect(given()).not.toContain('--push');
  });

  it('says what is wrong with those inputs', () => {
    expect(run({ INCONCLUSIVE: 'maybe' }).out).toContain('input inconclusive must be fail or warn, or empty, not "maybe"');
    expect(run({ MAX_ATTEMPTS: 'lots' }).out).toContain('input max-attempts must be a whole number of attempts');
    expect(run({ MAX_ATTEMPTS: '0' }).code).toBe(1);
  });

  it('declares the inputs and the output in action.yml, and keeps the test history in the cache around the test step', () => {
    const yml = readFileSync(join(ROOT, 'action.yml'), 'utf8');
    for (const input of ['inconclusive:', 'max-attempts:', 'keep-history:', 'guard-accept:']) expect(yml).toContain(`\n  ${input}\n    description:`);
    expect(yml).toContain('INPUT_GUARD_ACCEPT: ${{ inputs.guard-accept }}');
    expect(yml).toContain('\n  inconclusive:\n    description: Recordings whose verdict is inconclusive');
    expect(yml).toContain('INPUT_INCONCLUSIVE: ${{ inputs.inconclusive }}');
    expect(yml).toContain('INPUT_MAX_ATTEMPTS: ${{ inputs.max-attempts }}');
    // The repairers it names are the ones the CLI takes (parseRepairer): a bare provider only where it needs no model.
    const repairers = /as for shadowlap repair --repairer \(([^)]*)\)/.exec(yml)![1].split(', ');
    const takes = (spec: string) => {
      try {
        parseRepairer(spec);
        return true;
      } catch {
        return false;
      }
    };
    for (const provider of ['claude-code', 'anthropic', 'openai']) {
      expect(repairers, provider).toContain(`${provider}:<model>`);
      expect(repairers.includes(provider), provider).toBe(takes(provider));
    }
    for (const r of repairers) expect(takes(r.replace('<model>', 'some-model')), r).toBe(true);
    // What makes a recording inconclusive, and when one fails the step, as docs/ci.md and shadowlap test have it.
    const outputs = yml.slice(yml.indexOf('\noutputs:'));
    const said = (name: string) => new RegExp(`\\n  ${name}:\\n    description: ([^\\n]*)`).exec(outputs)![1];
    for (const why of ['a gate that ran out of attempts between its bounds', 'a check that could not be decided', 'an injection gate that showed too little to say', 'a provider unavailable too many attempts in a row']) expect(said('inconclusive')).toContain(why);
    for (const why of ['failed a check or an injection gate', 'unless inconclusive is warn', 'fewer than 30 sessions', 'a decline or a drop']) expect(said('failed')).toContain(why);
    // Restored before the tests, saved after them whether they passed or not.
    const restore = yml.indexOf('uses: actions/cache/restore@v4');
    const test = yml.indexOf('id: test');
    const save = yml.indexOf('uses: actions/cache/save@v4');
    expect(restore).toBeGreaterThan(0);
    expect(test).toBeGreaterThan(restore);
    expect(save).toBeGreaterThan(test);
    expect(yml.slice(test, save)).toContain("if: always() && steps.history.outputs.keep == 'true'");
  });
});

describe('the test history the GitHub Action keeps', () => {
  const plan = (o: Partial<Parameters<typeof historyPlan>[0]> = {}) => historyPlan({ keep: 'auto', workdir: '/work', store: '', config: null, branch: 'main', defaultBranch: 'main', runId: '42', attempt: '1', event: 'push', ...o });
  const historyGate = { tests: { 'goldens/refund-*': { fork: true, gate: { baseline: 'history' } } } };

  it('keeps it, with auto, when a golden has a gate against history', () => {
    expect(hasHistoryGate(historyGate)).toBe(true);
    expect(hasHistoryGate({ tests: { 'goldens/a': { fork: true, gate: { good: 0.9 } } } })).toBe(false);
    expect(hasHistoryGate(null)).toBe(false);
    expect(plan({ config: historyGate }).keep).toBe(true);
    expect(plan().keep).toBe(false);
    expect(plan({ keep: 'true' }).keep).toBe(true);
    expect(plan({ keep: 'false', config: historyGate }).keep).toBe(false);
    expect(() => plan({ keep: 'sometimes' })).toThrow('input keep-history must be auto, true or false, not "sometimes"');
  });

  it('saves the store under a key per run, and restores the branch\'s newest, then the default branch\'s', () => {
    expect(plan({ branch: 'fix/refunds', defaultBranch: 'main' })).toEqual({
      keep: false,
      refused: null,
      path: [join('/work', '.shadowlap', 'shadowlap.db'), `${join('/work', '.shadowlap', 'shadowlap.db')}-wal`, `${join('/work', '.shadowlap', 'shadowlap.db')}-shm`],
      key: 'shadowlap-history-fix-refunds-42-1',
      restoreKeys: ['shadowlap-history-fix-refunds-', 'shadowlap-history-main-'],
    });
    expect(plan({ store: 'ci/history.db' }).path[0]).toBe(resolve('/work', 'ci/history.db'));
    expect(plan().restoreKeys).toEqual(['shadowlap-history-main-']);
    expect(keyPart('feature/a b')).toBe('feature-a-b');
  });

  it('restores and saves nothing on an event the action refuses, whatever keep-history says', () => {
    for (const event of ['pull_request_target', 'workflow_run', 'issue_comment']) {
      expect(plan({ config: historyGate, event }), event).toMatchObject({ keep: false, refused: expect.stringContaining(`the action does not run on ${event}, which`) });
      expect(plan({ keep: 'true', event }).keep, event).toBe(false);
    }
    // Nor on one it doesn't name, nor in a job that names none.
    for (const event of ['check_run', 'check_suite', 'pull_request_review', 'release']) {
      expect(plan({ config: historyGate, event }), event).toMatchObject({ keep: false, refused: expect.stringContaining(`the action does not run on ${event}: it runs on pull_request`) });
      expect(plan({ keep: 'true', event }).keep, event).toBe(false);
    }
    expect(plan({ keep: 'true', event: undefined })).toMatchObject({ keep: false, refused: expect.stringContaining('the job names no event (GITHUB_EVENT_NAME)') });
    for (const event of EVENTS) expect(plan({ config: historyGate, event }), event).toMatchObject({ keep: true, refused: null });
    // As its step runs it: keep is false, so action.yml's restore and save steps are skipped, and the log says why.
    const dir = mkdtempSync(join(tmpdir(), 'fp-history-refused-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'shadowlap.config.json'), JSON.stringify(historyGate));
    const output = join(dir, 'output');
    writeFileSync(output, '');
    const r = spawnSync(process.execPath, [join(ROOT, 'action', 'history.mjs')], { env: { ...process.env, INPUT_WORKING_DIRECTORY: dir, INPUT_KEEP_HISTORY: 'true', INPUT_STORE: '', GITHUB_OUTPUT: output, GITHUB_EVENT_NAME: 'pull_request_target', GITHUB_REF_NAME: 'main', GITHUB_RUN_ID: '7', GITHUB_RUN_ATTEMPT: '1', DEFAULT_BRANCH: 'main' }, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(output, 'utf8')).toContain('keep=false\n');
    expect(r.stdout).toContain('not keeping the test history between jobs: the action does not run on pull_request_target');
  });

  it('writes its outputs as GitHub reads them, the paths over several lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fp-history-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'shadowlap.config.json'), JSON.stringify(historyGate));
    const output = join(dir, 'output');
    writeFileSync(output, '');
    const r = spawnSync(process.execPath, [join(ROOT, 'action', 'history.mjs')], { env: { ...process.env, INPUT_WORKING_DIRECTORY: dir, INPUT_KEEP_HISTORY: 'auto', INPUT_STORE: '', GITHUB_OUTPUT: output, GITHUB_EVENT_NAME: 'push', GITHUB_REF_NAME: 'main', GITHUB_RUN_ID: '7', GITHUB_RUN_ATTEMPT: '2', DEFAULT_BRANCH: 'main' }, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    const text = readFileSync(output, 'utf8');
    expect(text).toContain('keep=true\n');
    expect(text).toContain(`path<<SHADOWLAP_EOF\n${join(dir, '.shadowlap', 'shadowlap.db')}\n`);
    expect(text).toContain('key=shadowlap-history-main-7-2\n');
    expect(text).toContain('restore-keys<<SHADOWLAP_EOF\nshadowlap-history-main-\nSHADOWLAP_EOF\n');
  });
});

describe('test reports', () => {
  const failed: PackResult = { name: 'summarize|thread', dir: 'goldens\\summarize', golden: 'goldens/summarize', mode: 'replay', ok: false, verdict: 'failed', gate: null, failure: 'diverged', runId: null, runs: [], goldenRunId: null, expect: null, updated: null, message: 'diverged at call 3 (api POST /v1/messages)', details: 'a ``` fence\n50% of it: here, there', output: 'Error: boom', seconds: 1, calls: { total: 5, replayed: 2, live: 3, blocked: 0, stubbed: 0 }, upstreamRequests: 0, tokensNotRespent: 1200, divergence: { type: 'request_changed', callNo: 3, kind: 'api', name: 'POST /v1/messages' }, checks: null, attempts: null };
  const clean: PackResult = { ...failed, name: 'triage', dir: 'goldens/triage', golden: 'goldens/triage', ok: true, verdict: 'passed', failure: null, message: null, details: null, output: null, calls: { total: 30, replayed: 30, live: 0, blocked: 0, stubbed: 0 }, divergence: null };

  it('writes Markdown that survives pipes and backticks in its content', () => {
    const md = markdownReport(testReport([clean, failed]));
    expect(md).toContain('| ✅ | `triage` | clean | 30/30 | 1.2k |');
    expect(md).toContain('| ❌ | `summarize\\|thread` | diverged at call 3 (api POST /v1/messages) | 2/5 | 1.2k |');
    expect(md).toContain('````text\na ``` fence');
    // What to do about a divergence that was meant: the update, by the pack directory as given.
    expect(md).toContain('Once you mean it, update the golden: `shadowlap test goldens/summarize --update` re-records it live with writes stubbed');
    expect(md).not.toContain('interrupted');
    expect(markdownReport(testReport([clean], { id: 'S', revision: null, interrupted: true }))).toContain('The session was interrupted: only the recordings above finished, and the rest did not run.');
  });

  // A golden with a gate: its sentence and evidence in the reports; inconclusive in amber, counted apart.
  const gated = (verdict: PackResult['verdict'], ok: boolean, passes: number, attempts: number): PackResult => {
    // The failures spread out, as attempts a gate can end on: 16 passes first would have passed it at 12.
    const every = attempts / Math.max(1, attempts - passes);
    const outcomes = Array.from({ length: attempts }, (_, i) => passes === attempts || (i + 1) % every !== 0);
    const gate = gateResult({ kind: 'sprt', good: 0.9, bad: 0.7, risk: 0.05, max: 20 }, outcomes);
    // So its bound is the gate's own, exact under its stopping.
    expect(gate.bound?.method).toBe('stagewise');
    return { ...failed, name: `refund-${verdict}`, dir: `goldens/refund-${verdict}`, golden: `goldens/refund-${verdict}`, mode: 'fork', ok, verdict, gate, failure: verdict === 'passed' ? null : verdict === 'inconclusive' ? 'inconclusive' : 'check', message: verdict === 'passed' ? null : gate.sentence, details: null, output: null, divergence: { type: 'request_changed', callNo: 3, kind: 'api', name: 'POST /v1/messages' }, attempts: { total: attempts, passed: passes, required: null } };
  };

  it('says a gate\'s verdict line and its pass^k, and counts inconclusive ones apart', () => {
    const passed = gated('passed', true, 12, 12);
    const unsure = gated('inconclusive', false, 16, 20);
    const md = markdownReport(testReport([passed, unsure, failed]));
    expect(md).toContain('### shadowlap: 1 of 3 goldens passed · 1 failed, 1 inconclusive');
    // The verdict word, the tally, the bound and the rule, stated once; never a claimed rate.
    expect(md).toContain('| ✅ | `refund-passed` | passed · 12 of 12 · rate >= 0.73 (95%) · gate: tells 90%+ from 70%- at <= 5% risk, up to 20 attempts · pass^5 1.00 · forked at call 3 | 2/5 | 1.2k |');
    expect(md).toContain('| 🟡 | `refund-inconclusive` | inconclusive · 16 of 20 · rate 0.56 to 0.95 (95%) · gate: tells 90%+ from 70%- at <= 5% risk, up to 20 attempts · pass^5 0.28 | 2/5 | 1.2k |');
    expect(md).not.toMatch(/at least|at most|% confidence/);
    // With no --inconclusive given, the default: it fails the run; under --inconclusive fail, the flag.
    expect(md).toContain('By default an inconclusive recording fails the run; `--inconclusive warn` lets it through.');
    expect(md).not.toContain('A gate against history whose golden has fewer than');
    expect(markdownReport(testReport([passed, unsure, failed]), 'fail')).toContain('This run fails on each of them (`--inconclusive fail`).');
    // Under --inconclusive warn it is let through, and says so; the heading still counts it.
    const warned = markdownReport(testReport([passed, { ...unsure, ok: true }]), 'warn');
    expect(warned).toContain('### shadowlap: 1 of 2 goldens passed · 1 inconclusive');
    expect(warned).toContain('This run lets inconclusive recordings through (`--inconclusive warn`).');
    expect(testReport([passed, { ...unsure, ok: true }])).toMatchObject({ passed: 2, failed: 0, inconclusive: 1 });
    expect(githubAnnotations(testReport([passed, { ...unsure, ok: true }]))).toBe(
      '::warning file=goldens/refund-inconclusive/run.json,title=shadowlap%3A refund-inconclusive::inconclusive · 16 of 20 · rate 0.56 to 0.95 (95%25) · gate: tells 90%25+ from 70%25- at <= 5%25 risk, up to 20 attempts%0A%0Apass^5 0.28',
    );
  });

  it('names the rule a young gate against history kept with no --inconclusive given, never --inconclusive warn', () => {
    const unsure = gated('inconclusive', false, 16, 20);
    // As inconclusiveFor decides them: one with too few sessions only warns, one whose plan reads a decline counts.
    const young: PackResult = { ...unsure, name: 'refund-young', ok: true, warned: 'needs more history: 3 of 30 sessions' };
    const declining: PackResult = { ...unsure, name: 'refund-declining', counted: 'counts though it has only 15 of 30 sessions: its last 10 sessions sit below the 5 before them, 44 of 57 attempts against 30 of 31, 99 to 1 likely or more: a decline' };
    const md = markdownReport(testReport([young, declining]));
    expect(md).not.toContain('--inconclusive warn`)');
    expect(md).toContain('By default an inconclusive recording fails the run; `--inconclusive warn` lets it through. A gate against history whose golden has fewer than 30 sessions (three of its windows) only warns, unless the plan reads its last sessions below the ones before them, a decline at 99 to 1 or a drop: then it counts.');
    expect(md).toContain('`refund-young` only warns (needs more history: 3 of 30 sessions).');
    expect(md).toContain('`refund-declining` counts though it has only 15 of 30 sessions: its last 10 sessions sit below the 5 before them, 44 of 57 attempts against 30 of 31, 99 to 1 likely or more: a decline.');
    // The rule is the default's: under a flag, the flag decided every one.
    expect(markdownReport(testReport([{ ...unsure, ok: true }]), 'warn')).not.toContain('only warns');
  });

  it('says an injection gate that showed too little to say is why a golden is inconclusive, not a gate that ran out', () => {
    const injection = { resultId: 'inj-1', attempts: 5, obeyed: 0, influenced: 0, ignored: 0, inconclusive: 5, allowed: { obeyed: 0, influenced: null }, verdict: 'inconclusive' as const, reason: '5 of 5 attempts could not be judged', skipped: null };
    const unsure: PackResult = { ...failed, name: 'refused', dir: 'goldens/refused', golden: 'goldens/refused', verdict: 'inconclusive', failure: 'injection', message: 'injection inconclusive: 5 of 5 attempts could not be judged', checks: null, injection };
    const md = markdownReport(testReport([unsure]));
    expect(md).toContain('| 🟡 | `refused` | injection inconclusive: 5 of 5 attempts could not be judged |');
    expect(md).toContain('Inconclusive means an injection gate showed too little to say, as its reason says');
    expect(md).not.toContain("the gate's stated risk");
  });

  it('puts what the run did in the job summary as text GitHub links, mentions and renders nothing in', () => {
    const planted = '![x](https://evil.example/t.png) @alice <img src=x> #1 [docs](https://evil.example)';
    const hostile: PackResult = { ...failed, name: 'refund-flow', dir: 'goldens/refund-flow', golden: 'goldens/refund-flow', failure: 'check', message: `check failed: send_email with {"to":"${planted}"}`, details: null, output: null, divergence: null, checks: [{ ok: false, status: 'failed', label: `send_email with {"to":"${planted}"} called 0 times`, detail: 'called 1 time' }] };
    const md = markdownReport(testReport([hostile]));
    // Outside fenced blocks and code spans, nothing is left that GitHub would render, link or mention.
    const text = md.replace(/^(`{3,})[^\n]*\n[\s\S]*?\n\1$/gm, '').replace(/(`+)[^`]*?\1/g, '');
    expect(text).not.toMatch(/!\[|\]\(|<img|@alice|https?:\/\/|(?<!&)#1\b/);
    expect(md).toContain('<details open><summary><b>refund-flow</b>: check failed: send_email with {"to":"!&#91;x&#93;(https:<span></span>//evil.example/t.png) @<span></span>alice &lt;img src=x> #<span></span>1 &#91;docs&#93;(https:<span></span>//evil.example)"}</summary>');
  });

  it('escapes GitHub annotation properties and data', () => {
    expect(githubAnnotations(testReport([clean, failed]))).toBe('::error file=goldens/summarize/run.json,title=shadowlap%3A summarize|thread::diverged at call 3 (api POST /v1/messages)%0A%0Aa ``` fence%0A50%25 of it: here, there');
  });
});

describe('the pull request comment the GitHub Action keeps', () => {
  /** GitHub, as far as comments go: it keeps them, and every request. */
  const comments: Array<{ id: number; body: string; user: { login: string; id: number; type: string }; performed_via_github_app: { slug: string } | null; html_url: string }> = [];
  const calls: Array<{ method: string; url: string; authorization: string | undefined }> = [];
  let api = '';
  let server: import('node:http').Server;
  beforeAll(async () => {
    const { createServer } = await import('node:http');
    server = createServer((req, res) => {
      let text = '';
      req.on('data', (d: Buffer) => (text += d.toString()));
      req.on('end', () => {
        calls.push({ method: req.method ?? '', url: req.url ?? '', authorization: req.headers.authorization });
        const json = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
        if (req.method === 'GET' && /\/issues\/12\/comments\?/.test(req.url ?? '')) return json(200, comments);
        // An installation's token, as the job's own is, has no user to name.
        if (req.method === 'GET' && req.url === '/user') return json(403, { message: 'Resource not accessible by integration' });
        if (req.method === 'POST' && /\/issues\/12\/comments$/.test(req.url ?? '')) {
          const c = { id: comments.length + 1, body: (JSON.parse(text) as { body: string }).body, user: { login: 'github-actions[bot]', id: 41898282, type: 'Bot' }, performed_via_github_app: { slug: 'github-actions' }, html_url: `https://github.test/northwind/agent/pull/12#issuecomment-${comments.length + 1}` };
          comments.push(c);
          return json(201, c);
        }
        const patch = /\/issues\/comments\/(\d+)$/.exec(req.url ?? '');
        if (req.method === 'PATCH' && patch) {
          const c = comments.find((x) => x.id === Number(patch[1]))!;
          c.body = (JSON.parse(text) as { body: string }).body;
          return json(200, c);
        }
        json(404, { message: 'Not Found' });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    api = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  /** A pull_request event for pull request 12 into main, from `head`, as GITHUB_EVENT_PATH holds it. */
  function event(dir: string, head: string): string {
    const path = join(dir, 'event.json');
    writeFileSync(path, JSON.stringify({ number: 12, pull_request: { number: 12, head: { ref: 'feature', repo: { full_name: head } }, base: { ref: 'main', sha: 'e5f6a7b8c9d0e1f2', repo: { full_name: 'northwind/agent' } } } }));
    return path;
  }

  /** The action as action.yml runs it on a pull request, while the stand-in for GitHub answers. */
  function onPullRequest(inputs: Record<string, string>, head = 'northwind/agent', extraEnv: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; out: string; summary: string; dir: string }> {
    const dir = mkdtempSync(join(tmpdir(), 'fp-action-pr-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'output'), '');
    writeFileSync(join(dir, 'summary.md'), '');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SHADOWLAP_CLI: CLI,
      GITHUB_OUTPUT: join(dir, 'output'),
      GITHUB_STEP_SUMMARY: join(dir, 'summary.md'),
      RUNNER_TEMP: dir,
      NO_COLOR: '1',
      SHADOWLAP_GUARD: 'off',
      INPUT_STORE: join(dir, 'shadowlap.db'),
      GITHUB_ACTIONS: 'true',
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_EVENT_PATH: event(dir, head),
      GITHUB_API_URL: api,
      GITHUB_SERVER_URL: 'https://github.test',
      GITHUB_REPOSITORY: 'northwind/agent',
      GITHUB_RUN_ID: '7',
      GITHUB_WORKFLOW: 'CI',
      GITHUB_JOB: 'goldens',
      SHADOWLAP_JOB_TOKEN: 'ghs_job',
      GH_TOKEN: undefined,
      GITHUB_TOKEN: undefined,
      ...extraEnv,
    };
    for (const [k, v] of Object.entries(inputs)) env[`INPUT_${k}`] = v;
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [RUN], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString()));
      child.stderr.on('data', (d: Buffer) => (out += d.toString()));
      child.on('exit', (code) => resolve({ code, out, summary: readFileSync(join(dir, 'summary.md'), 'utf8'), dir }));
    });
  }

  it("keeps one comment with each golden's verdict line, compared with main from the test history, and edits it in place on the next run", async () => {
    comments.length = 0;
    calls.length = 0;
    // The test history the job restored: main's last session, at the commit the pull request is based
    // on, where the golden failed.
    const history = mkdtempSync(join(tmpdir(), 'fp-action-history-'));
    dirs.push(history);
    const store = Store.open(join(history, 'shadowlap.db'));
    const s = store.startTestSession({ command: ['shadowlap', 'test', 'testing/golden/*'], revision: 'e5f6a7b' });
    store.addTestResult({ sessionId: s.sessionId, golden: 'testing/golden/reference-agent', ok: false, failure: 'diverged', reason: 'diverged at call 3', revision: 'e5f6a7b', data: { verdict: 'failed' } });
    store.finishTestSession(s.sessionId, { passed: 0, failed: 1, upstreamRequests: 0 });
    store.close();

    const first = await onPullRequest({ RECORDINGS: 'testing/golden/*', WORKING_DIRECTORY: ROOT, GUARD: 'off', STORE: join(history, 'shadowlap.db') });
    expect(first.code, first.out).toBe(0);
    expect(first.out).toContain('the pull request comment is posted: https://github.test/northwind/agent/pull/12#issuecomment-1');
    expect(comments).toHaveLength(1);
    const body = comments[0].body;
    expect(body).toMatch(/^<!-- shadowlap-test-comment [0-9a-f]{12} -->\n### shadowlap: 1 of 1 golden passed\n/);
    expect(body).toContain('| | Golden | Verdict | On `main` |');
    expect(body).toContain('| ✅ | `testing/golden/reference-agent` | passed · replayed clean | ❌ failed |');
    expect(body).toContain('Compared with `main` as the test history last tested it, at `e5f6a7b`.');
    expect(body).toContain("[The job's summary](https://github.test/northwind/agent/actions/runs/7) has each failure in full.");
    expect(calls.every((c) => c.authorization === 'Bearer ghs_job')).toBe(true);
    expect(first.summary).not.toContain('pull request comment');

    // The next run edits that comment rather than adding one.
    const second = await onPullRequest({ RECORDINGS: 'testing/golden/*', WORKING_DIRECTORY: ROOT, GUARD: 'off', STORE: join(history, 'shadowlap.db') }, 'northwind/agent', { AGENT_SYSTEM_SUFFIX: 'Be brief.' });
    expect(second.code).toBe(1);
    expect(second.out).toContain('the pull request comment is updated');
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain('| ❌ | `testing/golden/reference-agent` | failed · diverged at call 3');
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);
  }, 120_000);

  it("posts nothing on a fork's pull request, whose token may not comment, and says so in the job summary only", async () => {
    comments.length = 0;
    calls.length = 0;
    const r = await onPullRequest({ RECORDINGS: 'testing/golden/*', WORKING_DIRECTORY: ROOT, GUARD: 'off' }, 'someone/agent');
    expect(r.code, r.out).toBe(0);
    expect(calls).toEqual([]);
    expect(r.out).not.toContain('::warning');
    expect(r.summary).toContain('The pull request comment was not posted: a pull request from a fork gets a token from GitHub that may not comment on it.');
    // Nor with comment: false.
    const off = await onPullRequest({ RECORDINGS: 'testing/golden/*', WORKING_DIRECTORY: ROOT, GUARD: 'off', COMMENT: 'false' });
    expect(off.code).toBe(0);
    expect(calls).toEqual([]);
    expect(off.summary).not.toContain('pull request comment');
  }, 120_000);

  it('never hands the CLI, nor the agent it runs, the tokens the step was given for GitHub', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fp-action-env-'));
    dirs.push(dir);
    const cli = join(dir, 'fake-cli.mjs');
    writeFileSync(
      cli,
      [
        "import { writeFileSync } from 'node:fs';",
        'const args = process.argv.slice(2);',
        "const at = (flag) => args[args.indexOf(flag) + 1];",
        `writeFileSync(${JSON.stringify(join(dir, 'env.json'))}, JSON.stringify({ input: process.env.INPUT_GITHUB_TOKEN ?? null, job: process.env.SHADOWLAP_JOB_TOKEN ?? null }));`,
        "writeFileSync(at('--json'), JSON.stringify({ version: 1, session: 'S', revision: null, passed: 1, failed: 0, inconclusive: 0, interrupted: false, results: [{ name: 'reference-agent', dir: 'testing/golden/reference-agent', golden: 'testing/golden/reference-agent', mode: 'replay', ok: true, verdict: 'passed', failure: null, message: null, runs: [] }] }));",
        "writeFileSync(at('--markdown'), '### shadowlap: 1 of 1 golden passed\\n');",
      ].join('\n'),
    );
    const r = await onPullRequest({ RECORDINGS: 'testing/golden/reference-agent', WORKING_DIRECTORY: ROOT, GITHUB_TOKEN: 'github_pat_secret' }, 'northwind/agent', { SHADOWLAP_CLI: cli });
    expect(r.code, r.out).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 'env.json'), 'utf8'))).toEqual({ input: null, job: null });
    // It commented with the token it was given.
    expect(calls.at(-1)?.authorization).toBe('Bearer github_pat_secret');
  }, 60_000);

  it("adds a run's cost and each injection gate to the comment, and with decisions: true asks decisions --from-code for the pull request it comments on alone", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fp-action-decisions-'));
    dirs.push(dir);
    const cli = join(dir, 'fake-cli.mjs');
    const log = join(dir, 'seen.jsonl');
    const injection = { resultId: 'inj-1', attempts: 6, obeyed: 0, influenced: 0, ignored: 6, inconclusive: 0, allowed: { obeyed: 0, influenced: null }, verdict: 'passed', reason: null, skipped: null };
    const result = { name: 'reference-agent', dir: 'testing/golden/reference-agent', golden: 'testing/golden/reference-agent', mode: 'replay', ok: true, verdict: 'passed', failure: null, message: null, runs: [], injection };
    const change = { rank: 1, kind: 'write-added', tool: 'issue_refund', effect: 'write', before: null, after: {}, detail: 'issue_refund is called' };
    const asked = { stop: 'tools', stopReason: 'tool_use', tools: [{ name: 'issue_refund', args: { order_id: 'A-1042' }, effect: 'write' }], text: '' };
    const decided = { counts: { 1: 1, 2: 0, 3: 0, 4: 0, 5: 0, same: 4, notAsked: 0, untouched: 0 }, flagged: ['run-1'], runs: [{ runId: 'run-1', golden: 'testing/golden/reference-agent', refused: null, decisions: [{ callNo: 2, majority: 1, changes: [change], recorded: { stop: 'answer', stopReason: 'end_turn', tools: [], text: 'Let me ask a lead.' }, now: asked }] }] };
    /** The CLI as the job runs it: `decisions` does what `asked` says, and test reports one golden that passed with its injection gate. */
    const fakeCli = (asked: string) =>
      writeFileSync(
        cli,
        [
          "import { appendFileSync, writeFileSync } from 'node:fs';",
          'const args = process.argv.slice(2);',
          'const at = (flag) => args[args.indexOf(flag) + 1];',
          `appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');`,
          `if (args.includes('decisions')) { ${asked} }`,
          `writeFileSync(at('--json'), JSON.stringify({ version: 1, session: 'S-PR', revision: null, passed: 1, failed: 0, inconclusive: 0, interrupted: false, costPerRun: { before: 0.041, after: 0.043 }, results: [${JSON.stringify(result)}] }));`,
          "writeFileSync(at('--markdown'), '### shadowlap: 1 of 1 golden passed\\n');",
        ].join('\n'),
      );
    fakeCli(`process.stdout.write(JSON.stringify(${JSON.stringify(decided)})); process.exit(0);`);
    const seen = () => readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]);
    const store = join(dir, 'ci.db');
    const inputs = { RECORDINGS: 'testing/golden/reference-agent', WORKING_DIRECTORY: ROOT, STORE: store, DECISIONS: 'true' };
    comments.length = 0;
    const r = await onPullRequest(inputs, 'northwind/agent', { SHADOWLAP_CLI: cli });
    expect(r.code, r.out).toBe(0);
    const body = comments[0].body;
    expect(body).toContain('\n#### Decisions\n\n❌ 1 of 1 golden decides a write or when to stop differently, under the prompt and tools this pull request sends\n\n- rank 1 · `testing/golden/reference-agent` #2 · issue_refund is called\n  - recorded `answers and stops: "Let me ask a lead."`\n  - now `issue_refund({"order_id":"A-1042"})`\n');
    expect(body).toContain('\nCost per run: ≈$0.041 → ≈$0.043 (+5%)\n\n#### Injection\n\n✅ `testing/golden/reference-agent` · passed · 6 attempts · 0 obeyed (at most 0 allowed) · 0 influenced · 6 ignored\n');
    // It asks with the store the test ran with, keeping the part with the test session, an inconclusive step a warning.
    expect(seen()[1]).toEqual(['--db', store, 'decisions', 'testing/golden/reference-agent', '--from-code', '--json', '--inconclusive', 'warn', '--test-session', 'S-PR']);
    expect(r.out).toContain('shadowlap decisions testing/golden/reference-agent --from-code');

    // Never off a pull request, nor on a fork's, which gets no comment, nor with the input off: the test alone runs.
    for (const [why, head, extra, given] of [
      ['a push', 'northwind/agent', { GITHUB_EVENT_NAME: 'push' }, inputs],
      ["a fork's pull request", 'someone/agent', {}, inputs],
      ['decisions off', 'northwind/agent', {}, { ...inputs, DECISIONS: 'false' }],
    ] as const) {
      rmSync(log, { force: true });
      comments.length = 0;
      const off = await onPullRequest(given, head, { SHADOWLAP_CLI: cli, ...extra });
      expect(off.code, `${why}: ${off.out}`).toBe(0);
      expect(seen().map((args) => args.includes('decisions')), why).toEqual([false]);
    }
    // Without decisions, the comment carries the cost and the injection gates alone.
    expect(comments[0].body).not.toContain('#### Decisions');
    expect(comments[0].body).toContain('#### Injection');

    // A decisions run that refuses, or stops without a report, never fails the job: the log says why, and the comment goes up without its part.
    for (const [why, asked, said] of [
      ['a refusal', "process.stdout.write(JSON.stringify({ error: { message: 'the store has no test session S-PR' } })); process.exit(2);", 'the pull request comment has no decisions: the store has no test session S-PR'],
      ['a run that stopped', 'process.exit(1);', 'the pull request comment has no decisions: shadowlap decisions did not finish (exit 1); its output is above'],
    ] as const) {
      fakeCli(asked);
      rmSync(log, { force: true });
      comments.length = 0;
      const failed = await onPullRequest(inputs, 'northwind/agent', { SHADOWLAP_CLI: cli });
      expect(failed.code, `${why}: ${failed.out}`).toBe(0);
      expect(seen().map((args) => args.includes('decisions')), why).toEqual([false, true]);
      expect(failed.out, why).toContain(said);
      expect(comments, why).toHaveLength(1);
      expect(comments[0].body, why).not.toContain('#### Decisions');
      expect(comments[0].body, why).toContain('\nCost per run: ≈$0.041 → ≈$0.043 (+5%)\n\n#### Injection\n\n✅ `testing/golden/reference-agent` · passed');
    }
  }, 120_000);
});

describe("the GitHub Action, fix on failure and the job's tokens", () => {
  /**
   * A stand-in for the CLI that writes down, for each command it is run as, its arguments and its
   * environment, then answers as shadowlap does: test with one golden that fails a check, repair with
   * no fix (the gate accepted none).
   */
  function fakeCli(dir: string): { cli: string; seen: () => Array<{ args: string[]; env: Record<string, string> }> } {
    const cli = join(dir, 'fake-cli.mjs');
    const log = join(dir, 'seen.jsonl');
    writeFileSync(
      cli,
      [
        "import { appendFileSync, writeFileSync } from 'node:fs';",
        'const args = process.argv.slice(2);',
        'const at = (flag) => args[args.indexOf(flag) + 1];',
        `appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, env: process.env }) + '\\n');`,
        "if (args.includes('repair')) { process.stdout.write(JSON.stringify({ outcome: 'not-fixed', why: 'the gate accepted none of the 1 candidate tried', cost: { blame: 0.1, repairer: 0.01, verify: 0.2 }, candidates: [], output: {} })); process.exit(1); }",
        "const result = { name: 'refund-flow', dir: 'goldens/refund-flow', golden: 'goldens/refund-flow', mode: 'replay', ok: false, verdict: 'failed', failure: 'check', message: 'check failed: issue_refund called 0 times, but called 1 time', expect: { tools: { issue_refund: 0 } }, checks: [{ ok: false, status: 'failed', label: 'issue_refund called 0 times', detail: 'called 1 time' }], runId: '01K5CQ4V3H8M2XWQH6V3T9RB1D', runs: [{ runId: '01K5CQ4V3H8M2XWQH6V3T9RB1D', ok: false, verdict: 'failed' }] };",
        "writeFileSync(at('--json'), JSON.stringify({ version: 1, session: 'S', revision: null, passed: 0, failed: 1, inconclusive: 0, interrupted: false, results: [result] }));",
        "writeFileSync(at('--markdown'), '### shadowlap: 0 of 1 golden passed · 1 failed\\n');",
        'process.exit(1);',
      ].join('\n'),
    );
    return { cli, seen: () => readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { args: string[]; env: Record<string, string> }) };
  }

  /** A project with a branch checked out, as a fix needs, and a golden folder for the test to name. */
  /** A project with a branch checked out, as a fix needs, and a golden folder for the test to name; its origin is `origin`. */
  function project(origin = 'https://github.test/northwind/agent.git'): string {
    const dir = mkdtempSync(join(tmpdir(), 'fp-action-fix-'));
    dirs.push(dir);
    const git = (...args: string[]) => spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: dir, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    cpSync(join(ROOT, 'testing', 'golden', 'reference-agent'), join(dir, 'goldens', 'refund-flow'), { recursive: true });
    git('add', '-A');
    git('commit', '-qm', 'agent');
    git('remote', 'add', 'origin', origin);
    return dir;
  }
  /** The repository the workflow runs in, as the runner names it: the one `project`'s origin names. */
  const REPO = { GITHUB_SERVER_URL: 'https://github.test', GITHUB_REPOSITORY: 'northwind/agent' };

  it("runs repair under the step's guard and fix-build, and hands neither it nor the test any of GitHub's tokens", () => {
    const dir = mkdtempSync(join(tmpdir(), 'fp-action-fix-cli-'));
    dirs.push(dir);
    const fake = fakeCli(dir);
    const job = 'ghs_job_token_for_the_test';
    const pat = 'github_pat_for_the_test';
    const oidc = 'oidc_request_token_for_the_test';
    const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${job}`).toString('base64')}`;
    const r = action(
      { RECORDINGS: 'goldens/*', WORKING_DIRECTORY: project(), GUARD: 'warn', FIX_ON_FAILURE: 'true', FIX_BUDGET: '1.00', FIX_BUILD: 'npm run build', REPAIRER: 'anthropic', FAIL_ON_DIVERGENCE: 'false', GITHUB_TOKEN: pat },
      { ...REPO, SHADOWLAP_CLI: fake.cli, GITHUB_EVENT_NAME: 'push', SHADOWLAP_JOB_TOKEN: job, GH_TOKEN: job, GITHUB_TOKEN: pat, ACTIONS_ID_TOKEN_REQUEST_TOKEN: oidc, ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.actions.test/', MY_COPY_OF_THE_TOKEN: job, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: header },
    );
    expect(r.code, r.out).toBe(0);
    const seen = fake.seen();
    expect(seen.map((s) => s.args.find((a) => a === 'test' || a === 'repair'))).toEqual(['test', 'repair']);
    for (const { args, env } of seen) {
      const text = JSON.stringify(env);
      for (const secret of [job, pat, oidc, header]) expect(text, `${args[0]}: ${secret}`).not.toContain(secret);
      for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'INPUT_GITHUB_TOKEN', 'SHADOWLAP_JOB_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'MY_COPY_OF_THE_TOKEN', 'GIT_CONFIG_COUNT']) expect(env, name).not.toHaveProperty(name);
    }
    // The test ran under the step's guard, and so did repair, with the step's build for the agent.
    const repair = seen[1].args;
    expect(seen[0].args.slice(seen[0].args.indexOf('--guard'), seen[0].args.indexOf('--guard') + 2)).toEqual(['--guard', 'warn']);
    expect(repair.slice(repair.indexOf('--guard'), repair.indexOf('--guard') + 4)).toEqual(['--guard', 'warn', '--build', 'npm run build']);
    expect(r.out).toContain('refund-flow: no fix pull request: the gate accepted none of the 1 candidate tried');
  });

  it("starts no repair where it couldn't push the fix it pays for: a checkout of another repository, or a job that names none", () => {
    for (const [origin, env, why] of [
      ['https://github.test/northwind/fork.git', REPO, "the checkout's origin is not northwind/agent, the repository this workflow runs in, so no fix is pushed from it"],
      ['https://github.test/northwind/agent.git', { GITHUB_SERVER_URL: '', GITHUB_REPOSITORY: '' }, "the job doesn't name the repository it runs in (GITHUB_SERVER_URL and GITHUB_REPOSITORY), so no fix is pushed from it"],
    ] as const) {
      const dir = mkdtempSync(join(tmpdir(), 'fp-action-fix-origin-'));
      dirs.push(dir);
      const fake = fakeCli(dir);
      const r = action({ RECORDINGS: 'goldens/*', WORKING_DIRECTORY: project(origin), FIX_ON_FAILURE: 'true', REPAIRER: 'anthropic', FAIL_ON_DIVERGENCE: 'false' }, { ...env, SHADOWLAP_CLI: fake.cli, GITHUB_EVENT_NAME: 'push' });
      expect(r.code, r.out).toBe(0);
      // The test ran; repair, which spends the budget, never started.
      expect(fake.seen().map((s) => s.args.find((a) => a === 'test' || a === 'repair'))).toEqual(['test']);
      expect(r.out).toContain(`refund-flow: no fix pull request: ${why}`);
      expect(r.outputs.fixes).toBe('0');
    }
  });

  // Each gives the job the base repository's secrets and a token that may write, and is how a pull
  // request's code gets run beside them; refused whether or not fix on failure is on, as the test alone runs the agent.
  it.each([
    ['pull_request_target', "runs a pull request's workflow with the base repository's secrets and a token that may write, beside the agent as the pull request changed it: run it on pull_request", 'true'],
    ['workflow_run', "runs with the base repository's secrets and a token that may write once another workflow ends, one a pull request from a fork may have started, and is how that pull request's code gets checked out beside them: run the action in that workflow instead, on pull_request for a pull request's code, or on push for a branch of this repository", 'false'],
    ['issue_comment', "runs with the base repository's secrets and a token that may write on a comment anyone can post, and is how a comment gets a pull request's code tested beside them: run it on pull_request, or on workflow_dispatch for a branch of this repository", 'false'],
  ])('refuses to run on %s, before anything runs', (event, why, fix) => {
    const dir = mkdtempSync(join(tmpdir(), 'fp-action-target-'));
    dirs.push(dir);
    const fake = fakeCli(dir);
    const r = action({ RECORDINGS: 'goldens/*', WORKING_DIRECTORY: project(), FIX_ON_FAILURE: fix }, { SHADOWLAP_CLI: fake.cli, GITHUB_EVENT_NAME: event });
    expect(r.code).toBe(1);
    expect(r.out).toContain(`::error title=shadowlap::the action does not run on ${event}, which ${why}`);
    expect(() => fake.seen()).toThrow();
  });

  // Every event it doesn't name too: more give the job those secrets and that token beside a pull
  // request's code (a check run or suite asked for again, a review), and from the event alone the
  // action can't tell whose code the job checked out. So is a job that names no event.
  it.each(['check_run', 'check_suite', 'pull_request_review', 'pull_request_review_comment', 'repository_dispatch', 'release', ''])('refuses to run on an event it does not name (%j), before anything runs', (event) => {
    const dir = mkdtempSync(join(tmpdir(), 'fp-action-unnamed-'));
    dirs.push(dir);
    const fake = fakeCli(dir);
    const r = action({ RECORDINGS: 'goldens/*', WORKING_DIRECTORY: project(), FIX_ON_FAILURE: 'true' }, { SHADOWLAP_CLI: fake.cli, GITHUB_EVENT_NAME: event });
    expect(r.code).toBe(1);
    const on = "it runs on pull_request for a pull request's code, and on push, schedule, workflow_dispatch or merge_group for a branch of this repository";
    expect(r.out).toContain(event ? `::error title=shadowlap::the action does not run on ${event}: ${on}` : `::error title=shadowlap::the job names no event (GITHUB_EVENT_NAME), so the action can't tell whose code it would run: ${on}`);
    expect(() => fake.seen()).toThrow();
  });

  it('runs on the events that run a branch of this repository, or a pull request with what a fork may have', () => {
    expect(EVENTS).toEqual(['pull_request', 'push', 'schedule', 'workflow_dispatch', 'merge_group']);
    for (const event of EVENTS) {
      const dir = mkdtempSync(join(tmpdir(), 'fp-action-events-'));
      dirs.push(dir);
      const fake = fakeCli(dir);
      const r = action({ RECORDINGS: 'goldens/*', WORKING_DIRECTORY: project() }, { SHADOWLAP_CLI: fake.cli, GITHUB_EVENT_NAME: event });
      expect(r.out, event).not.toContain('the action does not run on');
      expect(fake.seen().some((s) => s.args.includes('test')), event).toBe(true);
    }
  });

  it('runs on the events action.yml, docs/ci.md, SECURITY.md and the changelog name, and on those alone', () => {
    // Each says so in one list: "runs on `pull_request`, ... and `merge_group` alone".
    const named = (text: string) => /runs on ((?:`?[a-z_]+`?, )*`?[a-z_]+`? and `?[a-z_]+`?) alone/.exec(text)?.[1].split(/, | and /).map((e) => e.replace(/`/g, ''));
    for (const file of ['action.yml', 'docs/ci.md', 'SECURITY.md', 'CHANGELOG.md']) expect(named(readFileSync(join(ROOT, file), 'utf8')), file).toEqual([...EVENTS]);
  });
});
