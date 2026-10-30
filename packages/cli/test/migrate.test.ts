import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emptyCounts, Store, type DecisionRun, type DecisionsVerify } from '@shadowlap/engine';
import { startMockAnthropic, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { referenceScript } from '@shadowlap-testing/reference-agent';
import { formatMigrate, passesOf, pullRequestBody, type MigrateReport, type MigrateRunPass } from '../src/migrate.js';
import { quoteArgv } from '../src/ui.js';
import { departures } from './json-shapes.js';

/**
 * `shadowlap migrate` through the CLI: the reference agent recorded on a model that retires, kept as a
 * golden, and switched to another. The mock decides differently under claude-haiku-4-5, refuses a
 * non-default temperature on Claude 4.7 and later, and takes at most 512 output tokens as
 * `mock-small` (decision-rules.ts in the reference agent).
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const AGENT = fileURLToPath(new URL('../../../testing/reference-agent/dist/main.js', import.meta.url));
/** Runs the agent, failing every third time (flaky-agent.mjs). */
const FLAKY = fileURLToPath(new URL('./flaky-agent.mjs', import.meta.url));
const FROM = 'claude-sonnet-4-5-20250929';

let mock: MockServer;
let cwd: string;
let db: string;
let runId: string;

function shadowlap(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; out: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, '--db', db, ...args], {
      cwd,
      env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off', SHADOWLAP_HOME: join(cwd, 'home'), AGENT_MODEL: FROM, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => ((out += d.toString()), (stdout += d.toString())));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) => resolve({ code, out, stdout }));
  });
}

const json = <T,>(r: { stdout: string; out: string }): T => {
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    throw new Error(`not JSON:\n${r.out}`);
  }
};

beforeAll(async () => {
  mock = await startMockAnthropic({ script: referenceScript, eventDelayMs: () => 0 });
  cwd = mkdtempSync(join(tmpdir(), 'sl-migrate-'));
  db = join(cwd, '.shadowlap', 'shadowlap.db');
  // A project that names its model in a config file of its own.
  const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'dev@example.com');
  git('config', 'user.name', 'Dev');
  writeFileSync(join(cwd, 'agent.config.json'), `{\n  "name": "research",\n  "model": "${FROM}",\n  "max_tokens": 1024\n}\n`);
  writeFileSync(join(cwd, '.gitignore'), '.shadowlap/\nhome/\n');
  git('add', '.');
  git('commit', '-q', '-m', 'agent');
  const rec = await shadowlap(['run', '--', process.execPath, AGENT]);
  expect(rec.code, rec.out).toBe(0);
  runId = /recording run (\w{26})/.exec(rec.out)![1]!;
  mkdirSync(join(cwd, 'goldens'), { recursive: true });
  const packed = await shadowlap(['pack', runId, 'goldens/research']);
  expect(packed.code, packed.out).toBe(0);
}, 120_000);
afterAll(async () => {
  await mock.close();
  rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** The recorded model call whose answer called a tool, by the tool's name. */
function callOf(tool: string): number {
  const store = Store.open(db);
  try {
    const calls = store.getCalls(runId);
    const toolCall = calls.find((c) => c.kind === 'tool' && c.name === tool)!;
    return calls.filter((c) => c.kind === 'api' && c.callNo < toolCall.callNo).at(-1)!.callNo;
  } finally {
    store.close();
  }
}

describe('shadowlap migrate', () => {
  it('ends in one report: what changes, what still passes, what it costs, what to set, with the config change and a pull request body', async () => {
    const r = await shadowlap(['migrate', '--to', 'claude-haiku-4-5', '-y', '--attempts', '2', '--json']);
    expect(r.code, r.out).toBe(0);
    const report = json<MigrateReport>(r);
    expect(report).toMatchObject({ kind: 'migrate', from: [FROM], to: 'claude-haiku-4-5' });
    expect(report.changes).toMatchObject({ runs: 1, flagged: 1 });
    expect(report.changes.steps).toEqual([{ runId, golden: 'goldens/research', callNo: callOf('send_email'), rank: 1, detail: 'send_email is called with other arguments', recorded: expect.stringContaining('send_email('), now: expect.stringContaining('send_email('), arguments: ['send_email.body: "Replay works." → "Replay works; forks fence writes."'] }]);
    // A fixed count (--attempts 2) decided it: its tally, and no bound, which a gate's verdict shows.
    expect(report.passes).toEqual({ verdict: 'accepted', runs: [{ runId, golden: 'goldens/research', verdict: 'passed', outcome: 'kept', verified: true, tally: { passes: 2, attempts: 2, bound: null, rule: '2 of 2 attempts must pass', undecided: null } }] });
    expect(report.decisions.verify?.rule).toBe('2 of 2 attempts must pass');
    expect(report.costs.perRun.after!).toBeLessThan(report.costs.perRun.before!);
    expect(report.costs.checking.verify).toBeGreaterThan(0);
    expect(report.set).toEqual({ flags: [], fields: [], given: {} });
    // The model the recordings use retires; the report says when and where that is said.
    expect(report.retirements.find((n) => n.model === FROM)).toMatchObject({ retires: '2026-11-30', replacement: 'claude-sonnet-5-5' });

    // The change to the project's file that names the old model, as a patch git applies.
    expect(report.configChange!.files).toEqual([{ path: 'agent.config.json', places: 1 }]);
    expect(report.configChange!.review).toEqual([]);
    expect(report.configChange!.patch).toContain(`-  "model": "${FROM}",\n+  "model": "claude-haiku-4-5",`);
    writeFileSync(join(cwd, 'check.patch'), report.configChange!.patch);
    execFileSync('git', ['apply', '--check', 'check.patch'], { cwd });
    rmSync(join(cwd, 'check.patch'));

    expect(report.pullRequest.title).toBe(`Switch ${FROM} to claude-haiku-4-5`);
    for (const block of ['### What changes', '### What still passes', '### What it costs', '### What to set']) expect(report.pullRequest.body).toContain(block);
    expect(report.pullRequest.body).toContain('goldens/research: passed (kept, verified · 2 of 2)');
    // The rule the verified runs were decided by, once.
    expect(report.pullRequest.body).toContain('Verified by `shadowlap verify`, 2 of 2 attempts must pass.');
    expect(readFileSync(join(cwd, report.files!.pullRequest), 'utf8')).toContain(`# Switch ${FROM} to claude-haiku-4-5`);
    expect(readFileSync(join(cwd, report.files!.patch!), 'utf8')).toBe(report.configChange!.patch);

    // Kept in the store for the dashboard, with each run's decisions as rows of their own.
    const store = Store.open(db);
    try {
      const kept = store.getDecisionSession(report.migrateId!);
      expect(kept).toMatchObject({ kind: 'migrate', change: 'the model claude-haiku-4-5', runs: 1, flagged: 1 });
      expect(kept!.data).toMatchObject({ migrateId: report.migrateId, to: 'claude-haiku-4-5', passes: report.passes, files: report.files });
      expect(kept!.runRows.map((x) => x.golden)).toEqual(['goldens/research']);
    } finally {
      store.close();
    }

    const text = await shadowlap(['migrate', '--to', 'claude-haiku-4-5', 'goldens/research', '-y', '--attempts', '2']);
    expect(text.code, text.out).toBe(0);
    const blocks = ['What changes', 'What still passes', 'What it costs', 'What to set', 'The config change'].map((b) => text.stdout.indexOf(`\n${b}\n`));
    expect(blocks.every((at, i) => at > 0 && (i === 0 || at > blocks[i - 1]))).toBe(true);
  }, 240_000);

  it("verifies a golden it flags against the same run on the model it was recorded with, and states its verdict as the tallies, the bound and the rule", async () => {
    // The golden passes as recorded, so verify keeps it against its baseline: the same run on the model it was
    // recorded with, an attempt of each side in turn. The project's verify.margin, 50 points, keeps a run whose
    // every attempt passes after 6 pairs, where the default 10 points takes 38 (docs/decisions.md's migrate
    // sample shows that, held to the CLI by its docs test).
    const config = join(cwd, 'shadowlap.config.json');
    writeFileSync(config, JSON.stringify({ verify: { margin: 0.5 } }));
    try {
      const kept = (pairs: number) => `kept unless it drops 50+ points below its baseline, attempt for attempt, <= 5% risk, up to ${pairs} pairs`;
      const r = await shadowlap(['migrate', '--to', 'claude-haiku-4-5', '-y', '--json']);
      expect(r.code, r.out).toBe(0);
      const report = json<MigrateReport>(r);
      const tally = { passes: 6, attempts: 6, bound: expect.stringMatching(/^drop <= 0\.\d\d \(95%\)$/), rule: kept(200), undecided: null, baseline: { passes: 6, attempts: 6 } };
      expect(report.passes).toMatchObject({ verdict: 'accepted', runs: [{ runId, golden: 'goldens/research', verdict: 'passed', outcome: 'kept', verified: true, tally }] });
      expect(report.decisions.verify).toMatchObject({ verdict: 'accepted', rule: kept(200) });
      expect(report.decisions.verify!.commands[0]).not.toMatch(/--attempts|--passes|--gate/);
      expect(report.command).not.toMatch(/--attempts|--passes|--gate/);
      expect(report.pullRequest.body).toMatch(/- goldens\/research: passed \(kept, verified · 6 of 6, baseline 6 of 6 · drop <= 0\.\d\d \(95%\)\)/);
      expect(report.pullRequest.body).toContain(`Verified by \`shadowlap verify\`, ${kept(200)}.`);
      const text = formatMigrate(report).replace(/\x1b\[[0-9;]*m/g, '');
      expect(text).toMatch(/goldens\/research +passed · kept, verified · 6 of 6, baseline 6 of 6 · drop <= 0\.\d\d \(95%\)\n {2}kept unless it drops 50\+ points below its baseline, attempt for attempt, <= 5% risk, up to 200 pairs\n/);
      // A session verified again under other figures holds runs different rules decided: each rule is stated once, with its runs.
      const shortGate = 'gate: tells 90%+ from 50%- at <= 5% risk, up to 7 attempts';
      const other = { ...report.passes.runs[0], runId: '01M5000000000000000000000X', golden: 'goldens/other', verdict: 'inconclusive' as const, outcome: 'inconclusive', tally: { passes: 5, attempts: 7, bound: 'rate 0.36 to 0.92 (95%)', rule: shortGate } };
      const two: MigrateReport = { ...report, decisions: { ...report.decisions, verify: { ...report.decisions.verify!, rule: null } }, passes: { verdict: 'incomplete', runs: [report.passes.runs[0], other] } };
      expect(formatMigrate(two).replace(/\x1b\[[0-9;]*m/g, '')).toContain(`  ${kept(200)}: goldens/research\n  ${shortGate}: goldens/other\n`);
      expect(pullRequestBody(two).body).toContain(`Verified by \`shadowlap verify\`, each run under the rule that decided it:\n\n- goldens/research: ${kept(200)}\n- goldens/other: ${shortGate}\n`);

      // Seven pairs can't keep or break a run that passes about two times in three on each side, so it is
      // inconclusive, and so is the report, unless --inconclusive warn lets it pass. The command verify runs
      // fails every third time it starts, the baseline's attempts counted in turn with the change's. A gate's
      // max other than its default caps the pairs.
      const flaky = ['--', process.execPath, FLAKY, join(cwd, 'flaky.count'), process.execPath, AGENT];
      const short = await shadowlap(['migrate', '--to', 'claude-haiku-4-5', '-y', '--gate', '{"bad":0.5,"max":7}', '--json', ...flaky]);
      expect(short.code, short.out).toBe(3);
      const unsettled = json<MigrateReport>(short);
      expect(unsettled.passes).toEqual({ verdict: 'incomplete', runs: [{ runId, golden: 'goldens/research', verdict: 'inconclusive', outcome: 'inconclusive', verified: true, tally: { passes: 5, attempts: 7, bound: 'drop -0.72 to 0.76 (95%)', rule: kept(7), undecided: null, baseline: { passes: 5, attempts: 7 } } }] });
      expect(unsettled.decisions.verify?.rule).toBe(kept(7));
      expect(unsettled.command).toContain(`--gate '{"bad":0.5,"max":7}'`);
      const warned = await shadowlap(['migrate', '--to', 'claude-haiku-4-5', '-y', '--gate', '{"bad":0.5,"max":7}', '--inconclusive', 'warn', ...flaky]);
      expect(warned.code, warned.out).toBe(0);
      expect(warned.out).toContain('! inconclusive, and --inconclusive warn lets it pass: verify did not settle every run it took');
      // The counter goes on from where the first left it, so this time the change's failures fall elsewhere.
      expect(warned.stdout).toMatch(/goldens\/research +inconclusive · verified · \d of 7, baseline \d of 7 · drop -?\d\.\d\d to \d\.\d\d \(95%\)\n {2}kept unless it drops 50\+ points below its baseline, attempt for attempt, <= 5% risk, up to 7 pairs\n/);

      // The inconclusive migration verified again as the dashboard's Verify the changed runs verifies it: no count
      // and no gate of its own, the golden's own command. Kept against its baseline, and What still passes says so.
      const settled = await shadowlap(['decisions', '--verify', unsettled.migrateId!, '--json']);
      expect(settled.code, settled.out).toBe(0);
      const keptRun = { runId, golden: 'goldens/research', verdict: 'passed', outcome: 'kept', verified: true, tally };
      expect(json<{ kind: string; verify: MigrateReport['decisions']['verify']; passes: MigrateReport['passes']['runs'] }>(settled)).toMatchObject({ kind: 'migrate', verify: { verdict: 'accepted', rule: kept(200) }, passes: [keptRun] });
      const store = Store.open(db);
      try {
        const session = store.getDecisionSession(unsettled.migrateId!)!.data as unknown as Pick<MigrateReport, 'passes' | 'decisions'>;
        expect(session.passes).toMatchObject({ verdict: 'accepted', runs: [keptRun] });
        expect(session.decisions.verify).toMatchObject({ verdict: 'accepted', rule: kept(200) });
      } finally {
        store.close();
      }
      // A fixed count judges the run on its own, as every run once was.
      const counted = json<MigrateReport>(await shadowlap(['migrate', '--to', 'claude-haiku-4-5', '-y', '--attempts', '3', '--json']));
      expect(counted.passes.runs[0].tally).toMatchObject({ passes: 3, attempts: 3, rule: '3 of 3 attempts must pass' });
    } finally {
      rmSync(config, { force: true });
    }
  }, 300_000);

  it('sets what the new model refuses to what it takes, by the provider page, and says why', async () => {
    const before = mock.requests.length;
    const r = await shadowlap(['migrate', '--to', 'claude-sonnet-5-5', '--set', 'temperature=0.2', '-y', '--attempts', '1', '--json']);
    expect(r.code, r.out).toBe(0);
    const report = json<MigrateReport>(r);
    // The page says to leave it out: the requests (and verify) are sent its default, 1, meanwhile.
    expect(report.set.flags).toEqual(['--set temperature=1']);
    expect(report.set.given).toEqual({});
    expect(report.set.fields).toEqual([{ field: 'temperature', value: 1, leftOut: true, renamedTo: null, why: expect.stringContaining('claude-sonnet-5-5 is among Claude 4.7 and later models'), source: 'https://platform.claude.com/docs/en/about-claude/model-deprecations', steps: 11 }]);
    expect(report.pullRequest.body).toContain('- leave `temperature` out (the requests were sent `temperature=1`, its default, meanwhile): claude-sonnet-5-5 is among');
    const sent = mock.requests.slice(before).filter((q) => q.body.model === 'claude-sonnet-5-5');
    expect(sent.length).toBeGreaterThanOrEqual(11);
    expect(sent.every((q) => (q.body as { temperature?: unknown }).temperature === 1)).toBe(true);
  }, 240_000);

  it("changes what the new model's own refusal names, asks again, and verifies with it", async () => {
    const r = await shadowlap(['migrate', '--to', 'mock-small', '-y', '--attempts', '1', '--json']);
    const report = json<MigrateReport>(r);
    expect(report.set.fields).toEqual([{ field: 'max_tokens', value: 512, leftOut: false, renamedTo: null, why: 'mock-small refused the recorded request: HTTP 400: max_tokens: 1024 > 512, which is the maximum allowed number of output tokens for mock-small', source: null, steps: 11 }]);
    expect(report.set.flags).toEqual(['--set max_tokens=512']);
    expect(report.decisions.counts.notAsked).toBe(0);
    // Once refused, every request after it is sent with the fix: at most the first few are refused.
    expect(report.decisions.cost.upstreamRequests).toBeLessThan(22);
    expect(report.decisions.verify!.commands[0]).toContain('--set max_tokens=512');
    // No price for the mock's model: what it costs after is unknown, and says why.
    expect(report.costs.perRun.after).toBeNull();
    expect(report.decisions.cost.unknownModels).toEqual(['mock-small']);
    expect(r.code, r.out).toBe(0);
  }, 240_000);

  it("turns a manual thinking budget into adaptive thinking for a Claude 4.7 model, by Anthropic's page", async () => {
    const rec = await shadowlap(['run', '--', process.execPath, AGENT], { AGENT_THINKING_BUDGET: '1024' });
    expect(rec.code, rec.out).toBe(0);
    const thinkingRun = /recording run (\w{26})/.exec(rec.out)![1];
    const before = mock.requests.length;
    const r = await shadowlap(['migrate', '--to', 'claude-sonnet-5-5', thinkingRun, '-y', '--attempts', '1', '--json'], { AGENT_THINKING_BUDGET: '1024' });
    expect(r.code, r.out).toBe(0);
    const report = json<MigrateReport>(r);
    expect(report.set.fields).toEqual([{ field: 'thinking', value: { type: 'adaptive' }, leftOut: false, renamedTo: null, why: expect.stringMatching(/^claude-sonnet-5-5 is among Claude 4\.7 and later models, where extended thinking .* returns a 400 error \(Anthropic\); the requests send thinking=\{"type":"enabled","budget_tokens":1024\}\. Remove budget_tokens, set thinking: \{type: "adaptive"\}/), source: 'https://platform.claude.com/docs/en/build-with-claude/extended-thinking', steps: 11 }]);
    expect(report.set.flags).toEqual(['--set thinking={"type":"adaptive"}']);
    expect(report.decisions.counts.notAsked).toBe(0);
    expect(report.pullRequest.body).toContain('- `thinking` = `{"type":"adaptive"}`: claude-sonnet-5-5 is among Claude 4.7 and later models');
    // Every request asked adaptively, never refused, with the earlier turns' reasoning sent as recorded.
    const sent = mock.requests.slice(before).map((q) => q.body as unknown as { model: string; thinking?: unknown; messages: Array<{ role: string; content: unknown }> });
    expect(sent).toHaveLength(11);
    expect(sent.every((q) => q.model === 'claude-sonnet-5-5' && JSON.stringify(q.thinking) === '{"type":"adaptive"}')).toBe(true);
    expect(sent.every((q) => q.messages.filter((m) => m.role === 'assistant').every((m) => Array.isArray(m.content) && (m.content[0] as { type?: string }).type === 'thinking'))).toBe(true);
  }, 240_000);

  it('sends every sample of a step with the fix, and counts the step once', async () => {
    const r = await shadowlap(['migrate', '--to', 'mock-small', '--samples', '2', '--concurrency', '3', '-y', '--attempts', '1', '--json']);
    expect(r.code, r.out).toBe(0);
    const report = json<MigrateReport>(r);
    expect(report.set.fields).toEqual([expect.objectContaining({ field: 'max_tokens', value: 512, steps: 11 })]);
    const steps = report.decisions.runs[0].decisions;
    expect(steps).toHaveLength(11);
    expect(steps.every((s) => s.samples.asked === 2 && s.samples.answered === 2 && s.error === null)).toBe(true);
  }, 240_000);

  it('exits 1 when a run it verifies breaks under the new model', async () => {
    const expect_ = JSON.stringify({ tools: { send_email: { count: 1, args: { body: 'Replay works.' } } } });
    const r = await shadowlap(['migrate', '--to', 'claude-haiku-4-5', '--expect', expect_, '-y', '--attempts', '2', '--json']);
    expect(r.code, r.out).toBe(1);
    const report = json<MigrateReport>(r);
    expect(report.passes).toEqual({ verdict: 'rejected', runs: [{ runId, golden: 'goldens/research', verdict: 'failed', outcome: 'broken', verified: true, tally: { passes: 0, attempts: 1, bound: null, rule: '2 of 2 attempts must pass', undecided: null } }] });
  }, 240_000);

  it('migrates the goldens from a fresh store, as CI has one, running their commands as test runs them', async () => {
    // CI's checkout tracks its goldens: their commands run without asking, from a store that never recorded them.
    execFileSync('git', ['add', '--', 'goldens/research'], { cwd, stdio: 'ignore' });
    const fresh = join(cwd, 'fresh.db');
    const r = await new Promise<{ code: number | null; stdout: string; out: string }>((resolve) => {
      const child = spawn(process.execPath, [CLI, '--db', fresh, 'migrate', '--to', 'claude-haiku-4-5', '--attempts', '1', '--json'], { cwd, env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off', SHADOWLAP_HOME: join(cwd, 'home'), AGENT_MODEL: FROM }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let out = '';
      child.stdout.on('data', (d: Buffer) => ((stdout += d.toString()), (out += d.toString())));
      child.stderr.on('data', (d: Buffer) => (out += d.toString()));
      child.on('exit', (code) => resolve({ code, stdout, out }));
    });
    expect(r.code, r.out).toBe(0);
    expect(json<MigrateReport>(r).passes).toMatchObject({ verdict: 'accepted', runs: [{ golden: 'goldens/research', outcome: 'kept', verified: true }] });
  }, 240_000);

  it('prints the JSON its docs describe', async () => {
    const report = json<MigrateReport>(await shadowlap(['migrate', '--to', 'claude-haiku-4-5', '-y', '--attempts', '1', '--json']));
    const problems = [departures('migrate', report), departures('migrateCosts', report.costs), departures('migrateSet', report.set), departures('migratePasses', report.passes), departures('migratePass', report.passes.runs[0]), departures('migrateConfigChange', report.configChange), departures('decisions', report.decisions)];
    expect(problems.flatMap((x) => [...x.missing, ...x.extra])).toEqual([]);
    expect(existsSync(join(cwd, '.shadowlap', 'migrations'))).toBe(true);
  }, 240_000);
});

describe("migrate's first line", () => {
  // A report with what the first line reads: the switch, its runs and what still passes.
  const report = (runs: Array<Pick<MigrateRunPass, 'verdict' | 'outcome' | 'verified'>>, o: { verdict?: MigrateReport['passes']['verdict']; flagged?: number; notAsked?: number } = {}): MigrateReport =>
    ({
      from: ['claude-old'],
      to: 'claude-new',
      decisions: { runs: runs.map((_, i) => ({ runId: `R${i}` })), counts: { ...emptyCounts(), notAsked: o.notAsked ?? 0 }, verify: null, cost: { unknownModels: [] } },
      changes: { runs: runs.length, flagged: o.flagged ?? 0, steps: [] },
      passes: { verdict: o.verdict ?? 'not-run', runs: runs.map((x, i) => ({ runId: `R${i}`, golden: `goldens/g${i}`, tally: null, ...x })) },
      costs: { perRun: { before: 0.01, after: 0.01 }, total: { before: null, after: null }, tokensPerRun: { before: 1, after: 1 }, checking: { decisions: 0, judge: 0, verify: 0 } },
      set: { flags: [], fields: [], given: {} },
      configChange: null,
      retirements: [],
      notes: [],
      warnings: [],
      files: null,
    }) as unknown as MigrateReport;
  const first = (r: MigrateReport) => formatMigrate(r).split('\n')[0];
  const kept = { verdict: 'passed', outcome: 'kept', verified: true } as const;

  it('claims no run passing, and no decision unchanged, while What still passes has one inconclusive', () => {
    // Verify kept the run it took, but a step of another got no answer: that run is not settled.
    expect(first(report([kept, { verdict: 'inconclusive', outcome: 'not-asked', verified: false }], { verdict: 'accepted', flagged: 1, notAsked: 2 }))).toBe('! Not settled: claude-old → claude-new, 2 runs, 1 inconclusive');
    // Nothing flagged in the steps asked, but one run was never asked.
    const unasked = report([{ verdict: 'passed', outcome: 'unchanged', verified: false }, { verdict: 'inconclusive', outcome: 'not-asked', verified: false }], { notAsked: 3 });
    expect(first(unasked)).toBe('! Not settled: claude-old → claude-new, 2 runs, 1 inconclusive');
    expect(formatMigrate(unasked)).toContain('\n  no write, stop or judged change in the steps asked\n');
    // A run its verify left inconclusive.
    expect(first(report([{ verdict: 'inconclusive', outcome: 'inconclusive', verified: true }], { verdict: 'incomplete', flagged: 1 }))).toBe('! Not settled: claude-old → claude-new, 1 run, 1 inconclusive');
  });

  it('says what holds once every run is settled', () => {
    expect(first(report([kept], { verdict: 'accepted', flagged: 1 }))).toBe('✓ claude-new keeps every run passing: claude-old → claude-new, 1 run');
    // A run that failed as recorded is not one the switch keeps passing.
    expect(first(report([kept, { verdict: 'failed', outcome: 'unchanged', verified: false }], { verdict: 'accepted', flagged: 1 }))).toBe('✓ claude-new keeps every run that passed passing: claude-old → claude-new, 2 runs');
    expect(first(report([{ verdict: 'passed', outcome: 'unchanged', verified: false }]))).toBe('✓ No write, stop or judged change under claude-new: claude-old → claude-new, 1 run');
    expect(first(report([{ verdict: 'failed', outcome: 'broken', verified: true }, { verdict: 'inconclusive', outcome: 'not-asked', verified: false }], { verdict: 'rejected', flagged: 1 }))).toBe('✗ claude-new breaks runs: claude-old → claude-new, 2 runs, 1 inconclusive');
  });

  it('counts a verified attempt that could not be judged apart, never as one that failed', () => {
    const why = 'judge "summary" answers yes, but it is inconclusive: not judged: the judge\'s call failed: HTTP 400';
    const verify = (passes: number, attempts: number): DecisionsVerify => ({ verdict: 'incomplete', verifyIds: [], runs: [{ runId: 'R0', role: 'good', outcome: 'inconclusive', passes, attempts, bound: null, undecided: why }], rule: null, commands: [], spent: 0, upstreamRequests: 0, reasons: [] });
    const run = { runId: 'R0', golden: 'goldens/g0', decisions: [] } as unknown as DecisionRun;
    const [pass] = passesOf([run], ['R0'], verify(2, 3), () => true);
    expect(pass).toEqual({ runId: 'R0', golden: 'goldens/g0', verdict: 'inconclusive', outcome: 'inconclusive', verified: true, tally: { passes: 2, attempts: 3, bound: null, rule: null, undecided: why } });
    const r = { ...report([pass], { verdict: 'incomplete', flagged: 1 }), command: 'shadowlap migrate --to claude-new' };
    expect(formatMigrate(r)).toContain('inconclusive · verified · 2 of 2, attempt 3 not judged\n');
    expect(pullRequestBody(r).body).toContain('\n- goldens/g0: inconclusive (verified · 2 of 2, attempt 3 not judged)\n');
    // Its first attempt: nothing was judged before it.
    const [alone] = passesOf([run], ['R0'], verify(0, 1), () => true);
    expect(formatMigrate({ ...r, passes: { verdict: 'incomplete', runs: [alone] } })).toContain('inconclusive · verified · attempt 1 not judged\n');
    expect(formatMigrate(r)).not.toMatch(/2 of 3|0 of 1/);
  });

  it('names the command it was checked with in the pull request body, with a key its command line carries masked', () => {
    const command = quoteArgv(['shadowlap', 'migrate', '--to', 'claude-new', '--', 'node', 'agent.js', '--api-key', 'sk-test-EXAMPLE0000']);
    const body = pullRequestBody({ ...report([kept], { verdict: 'accepted', flagged: 1 }), command }).body;
    expect(body).not.toContain('sk-test-EXAMPLE0000');
    expect(body).toContain("Checked with `shadowlap migrate --to claude-new -- node agent.js --api-key '<CREDENTIAL>'`: ");
  });
});
