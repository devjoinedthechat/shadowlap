import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { githubAnnotations, markdownReport, testReport, type PackResult } from '../src/test-report.js';
import { gateResult } from '@shadowlap/engine';
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
  // The test history goes to a store of the test's own, not the repository's.
  const env: NodeJS.ProcessEnv = { ...process.env, SHADOWLAP_CLI: CLI, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, RUNNER_TEMP: dir, NO_COLOR: '1', SHADOWLAP_GUARD: 'off', INPUT_STORE: join(dir, 'shadowlap.db'), ...extraEnv };
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
    expect(readFileSync(r.outputs['report-json']!, 'utf8')).toContain('"passed": 1');
    expect(r.summary).toContain('### Shadowlap: 1 recording passed');
    expect(r.summary).toMatch(/✅ \| `reference-agent` \| clean \| 30\/30/);
    expect(r.out).not.toContain('::error');
  });

  it('fails a diverging replay, annotates it and puts the diff in the summary', () => {
    const r = action({ RECORDINGS: 'testing/golden/reference-agent', WORKING_DIRECTORY: ROOT, GUARD: 'off' }, { AGENT_SYSTEM_SUFFIX: 'Be brief.' });
    expect(r.code).toBe(1);
    expect(r.outputs).toMatchObject({ passed: '0', failed: '1', diverged: '1', 'checks-failed': '0' });
    expect(r.out).toContain('::error file=testing/golden/reference-agent/run.json,title=Shadowlap%3A reference-agent::diverged at call 3');
    expect(r.summary).toContain('### Shadowlap: 1 of 1 recording failed');
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
    expect(repairer.out).toContain('input repairer must be claude-code, anthropic');
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
    expect(typo.out).toContain('testing/golden/reference-agnet is not a Shadowlap pack (no run.json)');
    // Its annotation and its part of the summary say that once: the failure's message is all there is to it.
    expect(typo.out).toMatch(/^::error file=testing\/golden\/reference-agnet\/run\.json,title=Shadowlap%3A reference-agnet::testing\/golden\/reference-agnet is not a Shadowlap pack \(no run\.json\)$/m);
    expect(typo.summary.split('reference-agnet is not a Shadowlap pack')).toHaveLength(3);
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
    const r = action({ RECORDINGS: 'goldens/*', WORKING_DIRECTORY: project, GUARD: 'off' });
    expect(r.code, r.out).toBe(1);
    expect(r.outputs).toMatchObject({ passed: '0', failed: '1', diverged: '0', 'checks-failed': '0', inconclusive: '1' });
    expect(r.summary).toContain('### Shadowlap: 1 of 1 recording is inconclusive');
    expect(r.summary).toContain('| 🟡 | `reference-agent` |');
  });

  it('opens no fix for a divergence, even with fix-on-failure on', () => {
    const r = action({ RECORDINGS: 'testing/golden/reference-agent', WORKING_DIRECTORY: ROOT, GUARD: 'off', FIX_ON_FAILURE: 'true', FAIL_ON_DIVERGENCE: 'false' }, { AGENT_SYSTEM_SUFFIX: 'Be brief.' });
    expect(r.code).toBe(0);
    expect(r.outputs).toMatchObject({ failed: '1', diverged: '1', fixes: '0' });
    expect(r.out).toContain('reference-agent: no fix pull request: diverged: never fixed automatically, because most divergences are intended');
    expect(r.summary).toContain('### Shadowlap: no fix pull request opened');
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
        "const at = (flag) => args[args.indexOf(flag) + 1];",
        "const warn = at('--inconclusive') === 'warn';",
        "const result = { name: 'reference-agent', dir: 'testing/golden/reference-agent', golden: 'testing/golden/reference-agent', mode: 'fork', ok: warn, verdict: 'inconclusive', failure: 'inconclusive', message: 'inconclusive: neither at least 90% nor at most 70% with 95% confidence after 80 attempts, the most the gate runs', details: null, output: null, checks: null };",
        "writeFileSync(at('--json'), JSON.stringify({ version: 1, session: '01K5CQ4N7G8M2XWQH6V3T9RB1D', revision: null, passed: warn ? 1 : 0, failed: warn ? 0 : 1, inconclusive: 1, interrupted: false, results: [result] }));",
        "appendFileSync(at('--markdown'), '### Shadowlap: 1 of 1 recording is inconclusive\\n');",
        'process.exit(warn ? 0 : 1);',
      ].join('\n'),
    );
    return { cli, args: join(dir, 'args.json') };
  })();
  const run = (inputs: Record<string, string>) => action({ RECORDINGS: 'testing/golden/reference-agent', WORKING_DIRECTORY: ROOT, ...inputs }, { SHADOWLAP_CLI: fake.cli, FAKE_ARGS: fake.args });
  const given = () => JSON.parse(readFileSync(fake.args, 'utf8')) as string[];

  it('fails the step on an inconclusive golden by default, and counts it in both outputs', () => {
    const r = run({});
    expect(r.code).toBe(1);
    expect(given()).toEqual(expect.arrayContaining(['--inconclusive', 'fail']));
    expect(given()).not.toContain('--max-attempts');
    expect(r.outputs).toMatchObject({ passed: '0', failed: '1', inconclusive: '1', diverged: '0', 'checks-failed': '0' });
  });

  it('lets it through with inconclusive: warn, still counting it, and passes max-attempts on', () => {
    const r = run({ INCONCLUSIVE: 'warn', MAX_ATTEMPTS: '160' });
    expect(r.code).toBe(0);
    const args = given();
    expect(args.slice(args.indexOf('--inconclusive'), args.indexOf('--inconclusive') + 2)).toEqual(['--inconclusive', 'warn']);
    expect(args.slice(args.indexOf('--max-attempts'), args.indexOf('--max-attempts') + 2)).toEqual(['--max-attempts', '160']);
    expect(r.outputs).toMatchObject({ passed: '1', failed: '0', inconclusive: '1' });
  });

  it('says what is wrong with those inputs', () => {
    expect(run({ INCONCLUSIVE: 'maybe' }).out).toContain('input inconclusive must be fail or warn, not "maybe"');
    expect(run({ MAX_ATTEMPTS: 'lots' }).out).toContain('input max-attempts must be a whole number of attempts');
    expect(run({ MAX_ATTEMPTS: '0' }).code).toBe(1);
  });

  it('declares the inputs and the output in action.yml, and keeps the test history in the cache around the test step', () => {
    const yml = readFileSync(join(ROOT, 'action.yml'), 'utf8');
    for (const input of ['inconclusive:', 'max-attempts:', 'keep-history:']) expect(yml).toContain(`\n  ${input}\n    description:`);
    expect(yml).toContain('\n  inconclusive:\n    description: Recordings whose verdict is inconclusive');
    expect(yml).toContain('INPUT_INCONCLUSIVE: ${{ inputs.inconclusive }}');
    expect(yml).toContain('INPUT_MAX_ATTEMPTS: ${{ inputs.max-attempts }}');
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
  const plan = (o: Partial<Parameters<typeof historyPlan>[0]> = {}) => historyPlan({ keep: 'auto', workdir: '/work', store: '', config: null, branch: 'main', defaultBranch: 'main', runId: '42', attempt: '1', ...o });
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
      path: [join('/work', '.shadowlap', 'shadowlap.db'), `${join('/work', '.shadowlap', 'shadowlap.db')}-wal`, `${join('/work', '.shadowlap', 'shadowlap.db')}-shm`],
      key: 'shadowlap-history-fix-refunds-42-1',
      restoreKeys: ['shadowlap-history-fix-refunds-', 'shadowlap-history-main-'],
    });
    expect(plan({ store: 'ci/history.db' }).path[0]).toBe(resolve('/work', 'ci/history.db'));
    expect(plan().restoreKeys).toEqual(['shadowlap-history-main-']);
    expect(keyPart('feature/a b')).toBe('feature-a-b');
  });

  it('writes its outputs as GitHub reads them, the paths over several lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fp-history-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'shadowlap.config.json'), JSON.stringify(historyGate));
    const output = join(dir, 'output');
    writeFileSync(output, '');
    const r = spawnSync(process.execPath, [join(ROOT, 'action', 'history.mjs')], { env: { ...process.env, INPUT_WORKING_DIRECTORY: dir, INPUT_KEEP_HISTORY: 'auto', INPUT_STORE: '', GITHUB_OUTPUT: output, GITHUB_REF_NAME: 'main', GITHUB_RUN_ID: '7', GITHUB_RUN_ATTEMPT: '2', DEFAULT_BRANCH: 'main' }, encoding: 'utf8' });
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
    expect(md).toContain('| ✅ | `triage` | clean | 30/30 | 1k |');
    expect(md).toContain('| ❌ | `summarize\\|thread` | diverged at call 3 (api POST /v1/messages) | 2/5 | 1k |');
    expect(md).toContain('````text\na ``` fence');
    // What to do about a divergence that was meant: the update, by the pack directory as given.
    expect(md).toContain('Once you mean it, update the golden: `shadowlap test goldens/summarize --update` re-records it live with writes stubbed');
    expect(md).not.toContain('interrupted');
    expect(markdownReport(testReport([clean], { id: 'S', revision: null, interrupted: true }))).toContain('The session was interrupted: only the recordings above finished, and the rest did not run.');
  });

  // A golden with a gate: its sentence and evidence in the reports; inconclusive in amber, counted apart.
  const gated = (verdict: PackResult['verdict'], ok: boolean, passes: number, attempts: number): PackResult => {
    const outcomes = Array.from({ length: attempts }, (_, i) => i < passes);
    const gate = gateResult({ kind: 'sprt', good: 0.9, bad: 0.7, risk: 0.05, max: 20 }, outcomes);
    return { ...failed, name: `refund-${verdict}`, dir: `goldens/refund-${verdict}`, golden: `goldens/refund-${verdict}`, mode: 'fork', ok, verdict, gate, failure: verdict === 'passed' ? null : verdict === 'inconclusive' ? 'inconclusive' : 'check', message: verdict === 'passed' ? null : gate.sentence, details: null, output: null, divergence: { type: 'request_changed', callNo: 3, kind: 'api', name: 'POST /v1/messages' }, attempts: { total: attempts, passed: passes, required: null } };
  };

  it('says a gate\'s sentence and its evidence, and counts inconclusive ones apart', () => {
    const passed = gated('passed', true, 12, 12);
    const unsure = gated('inconclusive', false, 16, 20);
    const md = markdownReport(testReport([passed, unsure, failed]));
    expect(md).toContain('### Shadowlap: 1 of 3 recordings failed, 1 inconclusive');
    expect(md).toContain('| ✅ | `refund-passed` | passed: at least 90% with 95% confidence after 12 attempts · 12 of 12 passed · pass rate ≥ 0.76 (95%, Wilson) · pass^5 1.00 · forked at call 3 | 2/5 | 1k |');
    expect(md).toContain('| 🟡 | `refund-inconclusive` | inconclusive: neither at least 90% nor at most 70% with 95% confidence after 20 attempts, the most the gate runs · 16 of 20 passed · pass rate 0.58 to 0.92 (95%, Wilson) · pass^5 0.28 | 2/5 | 1k |');
    expect(md).toContain('It fails the run unless `--inconclusive warn` is given.');
    // Under --inconclusive warn it is let through, and says so; the heading still counts it.
    const warned = markdownReport(testReport([passed, { ...unsure, ok: true }]));
    expect(warned).toContain('### Shadowlap: 1 of 2 recordings is inconclusive');
    expect(warned).toContain('This run lets inconclusive recordings through (`--inconclusive warn`).');
    expect(testReport([passed, { ...unsure, ok: true }])).toMatchObject({ passed: 2, failed: 0, inconclusive: 1 });
    expect(githubAnnotations(testReport([passed, { ...unsure, ok: true }]))).toBe(
      '::warning file=goldens/refund-inconclusive/run.json,title=Shadowlap%3A refund-inconclusive::inconclusive: neither at least 90%25 nor at most 70%25 with 95%25 confidence after 20 attempts, the most the gate runs%0A%0A16 of 20 passed · pass rate 0.58 to 0.92 (95%25, Wilson) · pass^5 0.28',
    );
  });

  it('escapes GitHub annotation properties and data', () => {
    expect(githubAnnotations(testReport([clean, failed]))).toBe('::error file=goldens/summarize/run.json,title=Shadowlap%3A summarize|thread::diverged at call 3 (api POST /v1/messages)%0A%0Aa ``` fence%0A50%25 of it: here, there');
  });
});
