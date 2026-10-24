import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { message, startMockAnthropic, text, toolUse, type MockServer, type ScriptContext } from '@shadowlap-testing/mock-anthropic';

/**
 * Fixes through the CLI: blame opens a fix or joins one, verify and repair report to it, and
 * `fix apply` hands it over. The support agent runs in a git repository of its own; the mock plays
 * its model and the repairer. Recorded, the agent refunds $240 against policy; asked again it
 * escalates every other time, and always under a system prompt that says to escalate refunds above
 * the limit. The repairer proposes either three rewrites, the last of which works ("good"), or two
 * that don't ("bad").
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const AGENT = fileURLToPath(new URL('./support-agent.mjs', import.meta.url));
const ORACLE = JSON.stringify({ tools: { issue_refund: { count: 0, args: { amount: 240 } } } });
const ORIGINAL = 'You are a support agent. Follow the refund policy.';
const FIX = 'You are a support agent. Follow the refund policy: escalate every refund above the limit it sets.';

let mock: MockServer;
let project: string;
let mode: 'refund' | 'alternate' = 'refund';
let answers: 'good' | 'bad' = 'good';
let decisions = 0;
let counter = 0;

function script(ctx: ScriptContext) {
  const system = JSON.stringify(ctx.request.system ?? '');
  const usage = { input_tokens: Math.round(JSON.stringify(ctx.request).length / 4), output_tokens: 30 };
  if (system.includes('You improve AI agents')) {
    const user = JSON.stringify(ctx.request.messages).replace(/\\n/g, '\n');
    const anchor = (label: string) => Number(new RegExp(`\\[(\\d+)\\] ${label}, in [^:]+:`).exec(user)?.[1]);
    const named = { anchor: anchor('system prompt'), replace: 'You are a support agent. Follow the refund policy, and never refund order A-1042.', strategy: 'Forbid the failing refund', why: 'It names the case.' };
    const noop = { anchor: anchor('tool issue_refund'), replace: 'Refund an order. Check the policy first.', strategy: 'Point the refund tool at the policy', why: 'The tool is where the choice is made.' };
    const fix = { anchor: anchor('system prompt'), replace: FIX, strategy: 'Escalate refunds above the policy limit', why: 'The policy sets a limit; saying what to do above it makes the right tool clear.' };
    const candidates = answers === 'good' ? [named, noop, fix] : [named, noop];
    return { message: message([text(JSON.stringify({ diagnosis: 'The system prompt says to follow the policy but not what it asks of large refunds.', candidates }))], usage) };
  }
  const small = JSON.stringify(ctx.request.messages[0]?.content ?? '').includes('B-7');
  const order = small ? 'B-7' : 'A-1042';
  switch (ctx.assistantTurns) {
    case 0:
      return { message: message([toolUse('lookup_order', { order_id: order }, `toolu_lookup_${ctx.requestNo}`)], usage) };
    case 1:
      return { message: message([toolUse('read_policy', {}, `toolu_policy_${ctx.requestNo}`)], usage) };
    case 2: {
      if (small) return { message: message([toolUse('issue_refund', { order_id: order, amount: 40 }, `toolu_decide_${ctx.requestNo}`)], usage) };
      decisions++;
      // Asked at temperature 1 (`verify --set temperature=1`), it escalates too: a change to the requests, in no file.
      const hotter = (ctx.request as { temperature?: unknown }).temperature === 1;
      const escalates = system.includes('escalate every refund above the limit') || hotter || (mode === 'alternate' && decisions % 2 === 0);
      return {
        message: escalates
          ? message([text('Above the limit.'), toolUse('escalate', { reason: 'above the refund limit' }, `toolu_decide_${ctx.requestNo}`)], usage)
          : message([toolUse('issue_refund', { order_id: order, amount: 240 }, `toolu_decide_${ctx.requestNo}`)], usage),
      };
    }
    default:
      return { message: message([text('Done.')], { ...usage, stop_reason: 'end_turn' }) };
  }
}

beforeAll(async () => {
  mock = await startMockAnthropic({ script, eventDelayMs: () => 0 });
});
afterAll(async () => {
  await mock.close();
});

const sh = (cwd: string, cmd: string, args: string[]) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

beforeEach(() => {
  // Inside this repository, so the agent's imports resolve; a git repository of its own.
  project = join(fileURLToPath(new URL('.', import.meta.url)), `.tmp-fixes-${process.pid}-${counter++}`);
  mkdirSync(project);
  copyFileSync(AGENT, join(project, 'agent.mjs'));
  writeFileSync(join(project, '.gitignore'), '.shadowlap/\n');
  sh(project, 'git', ['init', '-q', '-b', 'main']);
  sh(project, 'git', ['config', 'user.name', 'Test']);
  sh(project, 'git', ['config', 'user.email', 'test@example.com']);
  sh(project, 'git', ['add', '.']);
  sh(project, 'git', ['commit', '-q', '-m', 'agent']);
  mode = 'refund';
  answers = 'good';
  decisions = 0;
});
afterEach(() => {
  rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

interface Result {
  code: number | null;
  out: string;
  stdout: string;
  /** What the command reported to a dashboard job over SHADOWLAP_EVENTS_FD. */
  events: Array<Record<string, unknown>>;
}

/** Not under CI, wherever the suite runs: a fix opened under CI says it came from there. */
const NOT_CI = Object.fromEntries(['CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE', 'CIRCLECI', 'JENKINS_URL', 'TF_BUILD', 'BITBUCKET_BUILD_NUMBER'].map((k) => [k, '']));

function shadowlap(args: string[], env: NodeJS.ProcessEnv = {}): Promise<Result> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: project,
      env: { ...process.env, ...NOT_CI, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: 'test-key', SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off', SHADOWLAP_AUTHOR: 'dana', SHADOWLAP_EVENTS_FD: '3', ...env },
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let stdout = '';
    let events = '';
    child.stdout!.on('data', (d: Buffer) => {
      out += d.toString();
      stdout += d.toString();
    });
    child.stderr!.on('data', (d: Buffer) => (out += d.toString()));
    (child.stdio[3] as NodeJS.ReadableStream).on('data', (d: Buffer) => (events += d.toString()));
    child.on('close', (code) => resolve({ code, out, stdout, events: events.trim() ? events.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>) : [] }));
  });
}

async function record(order?: string): Promise<string> {
  const r = await shadowlap(['run', '--', process.execPath, 'agent.mjs', ...(order ? [order] : [])]);
  expect(r.code, r.out).toBe(0);
  return /recording run (\w{26})/.exec(r.out)![1]!;
}

async function label(runId: string, ...labels: string[]): Promise<void> {
  expect((await shadowlap(['label', runId, ...labels])).code).toBe(0);
}

/** Two runs that refund the $240 order, and one good run that refunds a $40 one. */
async function runs(...labels: string[]): Promise<{ failed: [string, string]; good: string }> {
  const failed: [string, string] = [await record(), await record()];
  const good = await record('B-7');
  for (const id of failed) if (labels.length) await label(id, ...labels);
  await label(good, 'good');
  return { failed, good };
}

const agentText = () => readFileSync(join(project, 'agent.mjs'), 'utf8');
const json = <T = Record<string, any>>(r: Result): T => {
  expect(r.stdout.trim(), r.out).not.toBe('');
  return JSON.parse(r.stdout) as T;
};
const store = () => Store.open(join(project, '.shadowlap', 'shadowlap.db'));
/** Who each run says ran it, as the Runs page's By column shows it. */
function authors(runIds: string[]): Array<string | null> {
  const s = store();
  try {
    return runIds.map((id) => s.getRun(id)?.meta?.author ?? null);
  } finally {
    s.close();
  }
}
/** The model calls of a run, by call number: the agent's decision is the third. */
function modelCalls(runId: string): number[] {
  const s = store();
  try {
    return s.getCalls(runId).filter((c) => c.kind === 'api').map((c) => c.callNo);
  } finally {
    s.close();
  }
}

// Verify and repair decide each run by their gate, a dozen attempts each where they used to take four: more time on a busy machine.
describe('shadowlap fix', { timeout: 120_000 }, () => {
  it('opens a fix from a blame, joins the next failing run with its label, and keeps every verdict on it', async () => {
    const { failed, good } = await runs('refund-over-limit');
    const decision = modelCalls(failed[0])[2]!;
    mode = 'alternate';

    const first = await shadowlap(['blame', failed[0], '--expect', ORACLE, '--json']);
    expect(first.code, first.out).toBe(0);
    const blamed = json(first);
    expect(blamed.fix).toMatchObject({ title: 'issue_refund called with amount 240', status: 'open', opened: true });
    const fixId = blamed.fix.fixId as string;
    expect(fixId).toMatch(/^fx-[0-9A-Z]{26}$/);
    expect(first.events).toContainEqual({ type: 'link', label: 'Open the fix', href: `#/fixes/${fixId}/blame` });
    expect(first.events).toContainEqual({ type: 'run', runId: blamed.contrast.rescuedRunId, role: 'passing' });
    expect(first.events.at(-1)).toMatchObject({ type: 'result', data: { runId: failed[0], outcome: 'blamed' } });
    // Every run the blame made says who ran it, as a fork or a test replay does: its probes, and the
    // fork that rescued the run, which Runs lists on its own.
    const probes = blamed.probes.flatMap((x: { runs: Array<{ runId: string }> }) => x.runs.map((a) => a.runId)) as string[];
    expect(probes.length).toBeGreaterThan(1);
    expect(probes).toContain(blamed.contrast.rescuedRunId);
    expect(new Set(authors(probes))).toEqual(new Set(['dana']));

    // A title of one's own stays when the next blame joins.
    const titled = await shadowlap(['fix', 'title', fixId.slice(0, 13), 'Refunds', 'above', 'the', 'limit', 'issued', 'without', 'approval']);
    expect(titled.stdout).toContain('Refunds above the limit issued without approval');

    const second = await shadowlap(['blame', failed[1], '--expect', ORACLE]);
    expect(second.code, second.out).toBe(0);
    expect(second.stdout).toContain(`fix ${fixId.slice(0, 13)} · Refunds above the limit issued without approval · joined`);

    const listed = json<{ fixes: Array<Record<string, any>>; counts: Record<string, number> }>(await shadowlap(['fix', 'ls', '--json']));
    expect(listed.counts).toEqual({ all: 1, open: 1, verified: 0 });
    expect(listed.fixes[0]).toMatchObject({ fixId, status: 'open', title: 'Refunds above the limit issued without approval', label: 'refund-over-limit', failing: 2, good: 0, check: 'issue_refund never called with {"amount":240}', source: null });
    expect(listed.fixes[0]!.steps.map((x: { short: string }) => x.short)).toEqual([`lost at #${decision}`, 'no fix yet', 'not verified']);
    expect(listed.fixes[0]!.attempts).toBeGreaterThan(0);
    const table = (await shadowlap(['fix', 'ls'])).stdout;
    // What its runs did, now that the title no longer says it, and what they must do.
    expect(table).toMatch(new RegExp(`open +${fixId.slice(0, 13)} +Refunds above the limit issued without approval +refund-over-limit · 2 failing +lost at #${decision} · no fix yet · not verified\n +failed: issue_refund called with amount 240 · must: issue_refund never called with \\{"amount":240\\} · opened \\d+s ago\n`));

    // The code as it is fixes nothing: the verdict is kept, rejected, and the fix stays open.
    const rejected = await shadowlap(['verify', '--fixes', 'label:refund-over-limit', '--keeps', 'label:good', '--expect', ORACLE, '--json']);
    expect(rejected.code, rejected.out).toBe(1);
    const no = json(rejected);
    expect(no).toMatchObject({ verdict: 'rejected', fixes: [{ fixId, status: 'open' }] });
    expect(no.verifyId).toMatch(/^vf-[0-9A-Z]{26}$/);
    expect(rejected.events).toContainEqual({ type: 'link', label: 'Open the fix', href: `#/fixes/${fixId}/verify/${no.verifyId}` });
    // Its attempts say who ran them too.
    const attempts = no.runs.flatMap((x: { runs: Array<{ runId: string }> }) => x.runs.map((a) => a.runId)) as string[];
    expect(attempts.length).toBeGreaterThan(1);
    expect(new Set(authors(attempts))).toEqual(new Set(['dana']));

    // A fix made by hand, verified: the fix turns verified.
    writeFileSync(join(project, 'agent.mjs'), agentText().replace(ORIGINAL, FIX));
    const accepted = await shadowlap(['verify', '--fixes', 'label:refund-over-limit', '--keeps', 'label:good', '--expect', ORACLE]);
    expect(accepted.code, accepted.out).toBe(0);
    expect(accepted.stdout).toContain(`fix ${fixId.slice(0, 13)} · Refunds above the limit issued without approval · verified`);

    const shown = json(await shadowlap(['fix', 'show', fixId.slice(3, 13).toLowerCase(), '--json']));
    expect(shown).toMatchObject({ fixId, status: 'verified', failing: 2, good: 1, defaultStep: 'verify', openedBy: 'dana' });
    expect(shown.verifiedAt).toBeGreaterThanOrEqual(shown.openedAt);
    expect(shown.goodRuns.map((r: { runId: string }) => r.runId)).toEqual([good]);
    expect(shown.failingRuns.map((r: { runId: string }) => r.runId)).toEqual(failed);
    expect(shown.steps.map((x: { state: string }) => x.state)).toEqual(['done', 'todo', 'done']);
    expect(shown.steps[2]).toMatchObject({ short: '2 fixed · 1 kept', title: '2 fixed · 1 kept', meta: '1 earlier change rejected' });
    expect(shown.verify.map((v: { verdict: string }) => v.verdict)).toEqual(['accepted', 'rejected']);
    expect(shown.defaultVerify).toBe(shown.verify[0].verifyId);
    expect(shown.verify[0]).toMatchObject({ headline: 'Every failing run fixed, every good run kept', oracle: "a run's attempts must meet the check: the agent exits 0; issue_refund with {\"amount\":240} called 0 times; its gate decides after each one: tells 90%+ from 70%- at <= 5% risk, up to 80 attempts" });
    // Each run shows its tally and the bound, at the confidence it was decided at.
    expect(shown.verify[0].rows[0].rate).toMatchObject({ decision: 'pass', confidence: 0.95, sentence: 'passed · 12 of 12 · rate >= 0.73 (95%) · gate: tells 90%+ from 70%- at <= 5% risk, up to 80 attempts', bound: 'rate >= 0.73 (95%)' });
    expect(shown.verify[0].rows.map((r: { role: string; outcome: string }) => [r.role, r.outcome])).toEqual([
      ['target', 'fixed'],
      ['target', 'fixed'],
      ['good', 'kept'],
    ]);
    expect(shown.verify[1]).toMatchObject({ headline: 'The change did not fix the failing runs it checked', command: `shadowlap verify --fixes label:refund-over-limit --keeps label:good --expect '${ORACLE}'` });
    expect(shown.verify[1].rows[0]).toMatchObject({ outcome: 'not fixed', deterministic: true, note: 'issue_refund called' });
    // The Blame step shows the latest blame that found the call; both are kept.
    expect(shown.blames).toHaveLength(2);
    expect(shown.blame).toMatchObject({ runId: failed[1], outcome: 'blamed', lostAt: decision, step: 3, steps: 4, confidence: 'high', needed: 2, attemptsPerProbe: 20, rule: 'gate: rescue at 60%+, lost at 10%-, <= 5% risk, up to 20 attempts' });
    expect(shown.blame.boundary).toMatch(new RegExp(`^The re-asked call #${decision}: rescued · \\d+ of \\d+ · rate >= 0\\.\\d\\d \\(95%\\); #\\d+, the next model call: lost · 0 of 4 · rate <= 0\\.61 \\(95%\\)\\.$`));
    expect(shown.blame.answers).toMatchObject({ callNo: decision, recorded: 'issue_refund({"order_id":"A-1042","amount":240})', rescued: '"Above the limit.", escalate({"reason":"above the refund limit"})' });
    expect(shown.blame.probes.find((x: { blamed: boolean }) => x.blamed)).toMatchObject({ callNo: decision, verdict: 'rescued · blamed', bound: expect.stringMatching(/^rate >= 0\.\d\d \(95%\)$/), href: `#/run/${failed[1]}/${decision}` });
    expect(shown.blame.command).toBe(`shadowlap blame ${failed[1].slice(0, 10)} --expect '${ORACLE}'`);
    expect(shown.blame.callRow.filter((c: { kind: string }) => c.kind === 'api')).toHaveLength(4);
    // Verified on the working tree, with no repair behind it: applying it only marks it.
    expect(shown.actions).toEqual({ repair: null, apply: { kind: 'mark', argv: ['fix', 'apply', fixId], gitApply: null, pending: null, pulled: false, files: [], diff: null, patchFile: null, refused: null, inTree: false, goldens: 0, change: null }, applied: false, blameAgain: null, blameStronger: null });

    const human = (await shadowlap(['fix', 'show', fixId])).stdout;
    expect(human).toContain(`${fixId}  Refunds above the limit issued without approval`);
    expect(human).toContain('\n  failed: issue_refund called with amount 240 · must: issue_refund never called with {"amount":240}\n');
    expect(human).toMatch(/✓ 01 blame +Lost at model call/);
    expect(human).toContain('✓ accepted');
    expect(human).toContain('✗ rejected');
    // Each probe and each verified run with its tally and bound, under its gate's rule.
    expect(human).toContain('probes: gate: rescue at 60%+, lost at 10%-, <= 5% risk, up to 20 attempts');
    expect(human).toMatch(/0 of 4 passed · rate <= 0\.61 \(95%\) +lost/);
    expect(human).toMatch(/kept +12 of 12 · rate >= 0\.73 \(95%\)/);
    expect(human).toContain('its gate decides after each one: tells 90%+ from 70%- at <= 5% risk, up to 80 attempts');
    expect(human).not.toMatch(/at least|at most|of the time/);
    expect(human).toContain(`next: shadowlap fix apply ${fixId.slice(0, 13)}`);

    const applied = await shadowlap(['fix', 'apply', fixId, '--json']);
    expect(applied.code, applied.out).toBe(0);
    expect(json(applied)).toEqual({ fixId, status: 'applied', again: false, patch: 'none', repairId: null, goldens: [], tests: 'skipped', outdated: [], update: null });
    expect(applied.events).toContainEqual({ type: 'link', label: 'Open the fix', href: `#/fixes/${fixId}` });

    const s = store();
    try {
      expect(s.getFix(fixId)).toMatchObject({ status: 'applied', data: { applied: { patch: 'none', tests: 'skipped', by: 'dana' } } });
      const kinds = s.listEvents().map((e) => e.kind).reverse();
      expect(kinds).toEqual(['blame.done', 'blame.done', 'verify.rejected', 'verify.accepted', 'fix.applied']);
      expect(s.listEvents({ kinds: ['blame.done'] })[1]).toMatchObject({ actor: 'dana', runId: failed[0], ref: fixId, data: { outcome: 'blamed', opened: true } });
    } finally {
      s.close();
    }
  });

  it('opens the fix from a repair of runs never blamed, turns it verified, and applies the patch with its goldens', async () => {
    const { failed, good } = await runs();
    const decision = modelCalls(failed[0])[2]!;
    mode = 'alternate';
    const r = await shadowlap(['repair', '--fixes', ...failed, '--keeps', 'label:good', '--expect', ORACLE, '--repairer', 'anthropic', '--json']);
    expect(r.code, r.out).toBe(0);
    const report = json(r);
    expect(report.outcome).toBe('fixed');
    expect(report.fixes).toHaveLength(1);
    const fixId = report.fixes[0].fixId as string;
    expect(report.fixes[0]).toMatchObject({ title: 'issue_refund called with amount 240', status: 'verified' });
    expect(report.repairId).toBe(basename(report.output.dir));
    expect(report.verifyId).toMatch(/^vf-/);
    expect(r.events).toContainEqual({ type: 'link', label: 'Open the fix', href: `#/fixes/${fixId}/repair` });
    expect(r.events).toContainEqual({ type: 'file', path: report.output.patch, label: 'fix.patch' });

    const shown = json(await shadowlap(['fix', 'show', fixId, '--json']));
    // No label, so the fix groups by its check; the held-out run joined as a failing run too.
    expect(shown).toMatchObject({ status: 'verified', label: null, failing: 2, good: 1, defaultStep: 'verify' });
    expect([...shown.failingRuns.map((x: { runId: string }) => x.runId)].sort()).toEqual([...failed].sort());
    expect(shown.goodRuns.map((x: { runId: string }) => x.runId)).toEqual([good]);
    expect(shown.steps.map((x: { state: string; short: string }) => [x.state, x.short])).toEqual([
      ['done', `lost at #${decision}`],
      ['done', 'prompt fix'],
      ['done', '2 fixed · 1 kept'],
    ]);
    expect(shown.steps[1]).toMatchObject({ title: 'Escalate refunds above the policy limit', meta: 'candidate 3 of 3 · proposed by anthropic:claude-opus-5-5' });
    expect(shown.repair).toMatchObject({
      repairId: report.repairId,
      accepted: true,
      title: 'Escalate refunds above the policy limit',
      repairer: 'anthropic:claude-opus-5-5',
      change: { file: 'agent.mjs', anchor: 'system prompt', before: ORIGINAL, after: FIX, added: { text: ': escalate every refund above the limit it sets' }, removed: '' },
      needed: 12,
      attemptsPerRun: 80,
      // The failing runs by their gate, the good one against its own baseline.
      rule: 'each failing run by its gate, which tells 90%+ from 70%- at <= 5% risk, and each good one against its baseline, which tells no drop from one of 10+ points at <= 5% risk',
      verify: { verifyId: report.verifyId },
    });
    expect(shown.repair.roles).toEqual([
      { role: 'target', held: 1, of: 1 },
      { role: 'held-out', held: 1, of: 1 },
      { role: 'good', held: 1, of: 1 },
    ]);
    expect(shown.repair.candidates.map((c: { verdict: string }) => c.verdict)).toEqual(['set aside', 'rejected', 'accepted']);
    expect(shown.repair.candidates[0].why).toContain('mentions A-1042, which only the failing runs contain');
    expect(shown.repair.candidates[1].why).toMatch(/target run \w{10} not fixed/);
    expect(shown.repair.files).toEqual([
      { name: 'fix.patch', note: '1 file · +1 −1' },
      { name: 'report.md', note: 'the pull request body' },
      { name: 'report.json', note: 'for agents and CI' },
      { name: 'goldens/', note: '2 recordings made by the fixed code' },
    ]);
    expect(shown.repair.prBody).toBe(readFileSync(join(project, report.output.report), 'utf8'));
    expect(shown.repair.lost).toEqual([{ runId: report.targets[0].runId, at: `model call #${decision} (3 of 4)`, href: `#/fixes/${fixId}/blame` }]);
    expect(shown.verify).toHaveLength(1);
    expect(shown.verify[0]).toMatchObject({ verifyId: report.verifyId, verdict: 'accepted', code: 'repair candidate 3', label: 'repair candidate 3 · accepted', candidate: 3, repairId: report.repairId });
    expect(shown.actions.apply).toEqual({ kind: 'patch', argv: ['fix', 'apply', fixId], gitApply: `git -c core.autocrlf=false apply ${report.output.dir}/fix.patch`, pending: null, pulled: false, files: ['agent.mjs'], diff: readFileSync(join(project, report.output.patch), 'utf8'), patchFile: `${report.output.dir}/fix.patch`, refused: null, inTree: false, goldens: 2, change: null });

    // A golden recorded before the fix: the prompt the patch changes goes into its every request.
    expect((await shadowlap(['pack', good, 'goldens/good-refund'])).code).toBe(0);

    const applied = await shadowlap(['fix', 'apply', fixId.slice(0, 13), '--json']);
    expect(applied.code, applied.out).toBe(0);
    const result = json(applied);
    expect(result).toMatchObject({ fixId, status: 'applied', patch: 'applied', repairId: report.repairId, tests: 'passed' });
    // It replays the other goldens offline and names the one that diverges on what the patch changed.
    expect(result.outdated).toEqual([{ golden: 'goldens/good-refund', callNo: 1, path: '$.system' }]);
    expect(result.update).toBe('shadowlap test goldens/good-refund --update');
    expect(applied.out).toContain("checking the project's other goldens against the patch: 1 replayed offline");
    expect(applied.out).toContain('! 1 golden diverges on what the patch changed (#1 $.system): goldens/good-refund');
    // The drawer's next step is updating it: the fix is a link beside it.
    expect(applied.events).toContainEqual({ type: 'link', label: 'Open the fix', href: `#/fixes/${fixId}`, secondary: true });
    // Paths as apply reports them, with forward slashes on every system.
    expect(result.goldens).toEqual(report.output.goldens.map((g: string) => ({ from: g, to: `goldens/${basename(g)}`, copied: true })));
    expect(agentText()).toContain(FIX);
    for (const g of result.goldens) expect(existsSync(join(project, g.to, 'run.json'))).toBe(true);
    expect(applied.out).toContain('2 passed, 0 failed');

    const again = await shadowlap(['fix', 'apply', fixId]);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain(`${fixId.slice(0, 13)} is already applied`);
    const listed = json(await shadowlap(['fix', 'ls', '--status', 'applied', '--json']));
    expect(listed.fixes.map((f: { fixId: string }) => f.fixId)).toEqual([fixId]);
    expect(json(await shadowlap(['fix', 'ls', '--status', 'open', '--json'])).fixes).toEqual([]);

    const s = store();
    try {
      // fix apply tests the goldens it copied, and that test session is kept like any other; its
      // check of the other goldens keeps nothing.
      expect(s.listEvents().map((e) => e.kind).filter((k) => k !== 'blame.done')).toEqual(['fix.applied', 'test.session', 'golden.packed', 'repair.accepted']);
      expect(s.listTestSessions()).toHaveLength(1);
      expect(s.listEvents({ kinds: ['test.session'] })[0]).toMatchObject({ data: { passed: 2, failed: 0 } });
      expect(s.listEvents({ kinds: ['repair.accepted'] })[0]).toMatchObject({ ref: fixId, data: { repairId: report.repairId, title: 'Escalate refunds above the policy limit', verifyId: report.verifyId } });
    } finally {
      s.close();
    }
  });

  it('names a change of request fields by the fields it set, and leaves making it to the agent once applied', async () => {
    const { failed } = await runs('refund-over-limit');
    mode = 'alternate';
    const blamed = json(await shadowlap(['blame', failed[0], '--expect', ORACLE, '--json']));
    const fixId = blamed.fix.fixId as string;
    // Titled by how its run failed: fix ls and fix show say what it must do, and leave what failed to the title.
    expect((await shadowlap(['fix', 'ls'])).stdout).toMatch(/\n +must: issue_refund never called with \{"amount":240\} · opened \d+[sm] ago\n/);
    expect((await shadowlap(['fix', 'show', fixId])).stdout).toMatch(/\n {2}open · refund-over-limit · 1 failing run · 0 good · opened \d+[sm] ago\n {2}must: issue_refund never called with \{"amount":240\}\n/);
    mode = 'refund';
    const verified = await shadowlap(['verify', '--fixes', failed[0], '--set', 'temperature=1', '--expect', ORACLE]);
    expect(verified.code, verified.out).toBe(0);
    const change = "temperature=1 from each run's first model call";
    const shown = json(await shadowlap(['fix', 'show', fixId, '--json']));
    expect(shown.status).toBe('verified');
    expect(shown.verify[0].code).toMatch(/^temperature=1 from each run's first model call · at [0-9a-f]{7,}$/);
    expect(shown.actions.apply).toMatchObject({ kind: 'mark', change, gitApply: null });
    const human = (await shadowlap(['fix', 'show', fixId])).stdout;
    expect(human).toMatch(/✓ accepted {2}temperature=1 from each run's first model call · at [0-9a-f]{7,} {2}Every failing run fixed\n/);
    expect(human).toContain(`next: shadowlap fix apply ${fixId.slice(0, 13)} (verified with ${change}: once your agent makes that change, marks it applied)\n`);

    const applied = await shadowlap(['fix', 'apply', fixId]);
    expect(applied.code, applied.out).toBe(0);
    expect(applied.out).toContain(`verified with ${change}, a change to the requests no patch carries: make it in your agent\n`);
    expect(applied.stdout).toContain(`✓ ${fixId.slice(0, 13)} applied: verified with ${change}; no patch, set it in your agent\n`);
    // Never that it was verified on the working tree, or that there was simply no patch to apply.
    expect(applied.out).not.toMatch(/verified on the working tree|no patch to apply/);
    const after = (await shadowlap(['fix', 'show', fixId])).stdout;
    expect(after).toContain(`applied: patch none (verified with ${change}: set it in your agent) · tests skipped`);
    expect(after).not.toContain('verified on the working tree');
  });

  it('keeps a fix open after a repair that accepts nothing, with every candidate tried and why it was dropped', async () => {
    answers = 'bad';
    const { failed, good } = await runs('refund-over-limit');
    mode = 'alternate';
    const r = await shadowlap(['repair', '--fixes', failed[0], '--keeps', 'label:good', '--expect', ORACLE, '--repairer', 'anthropic', '--json']);
    expect(r.code, r.out).toBe(1);
    const report = json(r);
    expect(report).toMatchObject({ outcome: 'not-fixed', verifyId: null });
    expect(report.fixes).toEqual([expect.objectContaining({ status: 'open' })]);
    const fixId = report.fixes[0].fixId as string;
    expect(r.events).toContainEqual({ type: 'link', label: 'Open the fix', href: `#/fixes/${fixId}/repair` });

    const shown = json(await shadowlap(['fix', 'show', fixId, '--json']));
    expect(shown.status).toBe('open');
    expect(shown.steps[1]).toEqual({ key: 'repair', n: '02', state: 'todo', short: 'no fix yet', title: 'No fix yet', meta: '1 candidate tried, none accepted' });
    expect(shown.repair).toMatchObject({ accepted: false, outcome: 'not-fixed', title: 'No fix yet', why: 'the gate accepted none of the 1 candidate tried', change: null, roles: [] });
    expect(shown.repair.candidates.map((c: { verdict: string; why: string }) => c.verdict)).toEqual(['set aside', 'rejected']);
    expect(shown.repair.files.map((f: { name: string }) => f.name)).toEqual(['report.md', 'report.json']);
    expect(shown.verify).toEqual([]);
    // Repaired from its own failing run: the other run labelled refund-over-limit is in no fix, so the label would repair it as failing
    // unseen. It keeps the good run the repair kept, the fix's own now, rather than every run labelled good.
    expect(shown.actions.repair.argv).toEqual(['repair', '--fixes', failed[0], '--keeps', good, '--expect', ORACLE]);
    expect(shown.actions.repair.command).toBe(`shadowlap repair --fixes ${failed[0]} --keeps ${good} --expect '${ORACLE}' --repairer claude-code`);

    // What to run next, with the repairer the config names, else the user's own Claude Code.
    expect((await shadowlap(['fix', 'show', fixId])).stdout).toContain(`next: shadowlap repair --fixes ${failed[0]} --keeps ${good} --expect '${ORACLE}' --repairer claude-code\n`);
    writeFileSync(join(project, 'shadowlap.config.json'), JSON.stringify({ repair: { repairer: 'anthropic' } }));
    expect((await shadowlap(['fix', 'show', fixId])).stdout).toContain(`next: shadowlap repair --fixes ${failed[0]} --keeps ${good} --expect '${ORACLE}'\n`);

    // Nothing verified, nothing to apply: it says how to get there.
    const refused = await shadowlap(['fix', 'apply', fixId]);
    expect(refused.code).toBe(2);
    expect(refused.out).toContain(`${fixId.slice(0, 13)} is open: no change has been verified for it yet, so there is nothing to apply. Repair it first:`);
    expect(refused.out).toContain(`shadowlap repair --fixes ${failed[0]}`);

    const s = store();
    try {
      expect(s.listEvents({ kinds: ['repair.empty'] })[0]).toMatchObject({ ref: fixId, data: { outcome: 'not-fixed', candidates: 2 } });
    } finally {
      s.close();
    }
  });

  it('says why no repairer proposed a fix when claude can’t be found, in the repair, the fix’s step and fix show', async () => {
    const { failed } = await runs('refund-over-limit');
    mode = 'alternate';
    // As on a machine without Claude Code: the repair asks it, and it isn't there.
    const claude = join(project, 'no-claude-here');
    const r = await shadowlap(['repair', '--fixes', failed[0], '--keeps', 'label:good', '--expect', ORACLE, '--repairer', 'claude-code', '--json'], { SHADOWLAP_CLAUDE: claude });
    expect(r.code, r.out).toBe(1);
    const report = json(r);
    const why = `the repairer could not be asked: ${claude} was not found`;
    const warning = `${why}: install Claude Code, or set SHADOWLAP_CLAUDE to its path`;
    expect(report).toMatchObject({ outcome: 'not-fixed', why, repairer: null, noRepairer: why, candidates: [] });
    expect(report.warnings).toContain(warning);
    const fixId = report.fixes[0].fixId as string;

    const shown = json(await shadowlap(['fix', 'show', fixId, '--json'], { SHADOWLAP_CLAUDE: claude }));
    expect(shown.steps[1]).toEqual({ key: 'repair', n: '02', state: 'todo', short: 'no fix yet', title: 'No fix yet', meta: why });
    expect(shown.repair).toMatchObject({ outcome: 'not-fixed', repairer: null, why, noRepairer: { text: why, warning } });
    // The repair it suggests next would ask the same missing claude: it says so.
    expect(shown.repairer).toEqual({ name: 'claude-code', configured: false, problem: `This repair asks your own Claude Code, and ${claude}, which SHADOWLAP_CLAUDE names, was not found: point SHADOWLAP_CLAUDE at Claude Code, or name another repairer in shadowlap.config.json (repair.repairer).` });

    const human = (await shadowlap(['fix', 'show', fixId], { SHADOWLAP_CLAUDE: claude })).stdout;
    expect(human).toMatch(/· +02 repair +No fix yet +the repairer could not be asked: /);
    expect(human).toMatch(new RegExp(`\\nRepair · ${report.repairId}, not fixed \\d+s ago · the repairer could not be asked: .*no-claude-here was not found\\n`));
    expect(human).toContain(`  ! ${warning}\n`);
    expect(human).toContain(`, which SHADOWLAP_CLAUDE names, was not found: point SHADOWLAP_CLAUDE at Claude Code`);
    expect(human).not.toContain('no repairer needed');
    expect(human).not.toContain('there was no candidate to try');
    expect(human).not.toContain('not-fixed');

    // Activity says why too.
    const s = store();
    try {
      expect(s.listEvents({ kinds: ['repair.empty'] })[0]).toMatchObject({ ref: fixId, data: { outcome: 'not-fixed', why, candidates: 0 } });
    } finally {
      s.close();
    }
  });

  it('recognises a patch already in the tree, and refuses to apply over changes that conflict with it', async () => {
    const { failed } = await runs();
    mode = 'alternate';
    // Run under CI, the blames the repair makes open a fix that says it came from there.
    const repaired = json(await shadowlap(['repair', '--fixes', ...failed, '--keeps', 'label:good', '--expect', ORACLE, '--repairer', 'anthropic', '--json'], { GITHUB_ACTIONS: 'true' }));
    const fixId = repaired.fixes[0].fixId as string;
    expect(json(await shadowlap(['fix', 'show', fixId, '--json'])).source).toBe('from CI');

    writeFileSync(join(project, 'agent.mjs'), agentText().replace(ORIGINAL, 'You are a support agent. Be kind.'));
    const refused = await shadowlap(['fix', 'apply', fixId]);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain('agent.mjs has uncommitted changes the patch conflicts with');
    expect(refused.out).toContain('Nothing was changed: commit or stash them');
    expect(agentText()).toContain('Be kind.');
    expect(existsSync(join(project, 'goldens'))).toBe(false);

    // Committed, the same change leaves a clean tree the patch no longer applies to.
    sh(project, 'git', ['commit', '-qam', 'Be kind']);
    const stale = await shadowlap(['fix', 'apply', fixId, '--json']);
    expect(stale.code).toBe(1);
    expect(json(stale)).toMatchObject({ fixId, status: 'error', error: { message: expect.stringContaining('the patch no longer applies: agent.mjs changed since the repair') } });
    expect(json(stale).error.message).toContain('apply it by hand with git apply --3way');
    expect(json(await shadowlap(['fix', 'show', fixId, '--json'])).status).toBe('verified');

    sh(project, 'git', ['reset', '-q', '--hard', 'HEAD~1']);
    sh(project, 'git', ['apply', repaired.output.patch]);
    const applied = await shadowlap(['fix', 'apply', fixId, '--no-test', '--goldens', 'tests/goldens', '--json']);
    expect(applied.code, applied.out).toBe(0);
    expect(json(applied)).toMatchObject({ status: 'applied', patch: 'already', tests: 'skipped' });
    expect(existsSync(join(project, 'tests', 'goldens', failed[0].slice(0, 10), 'run.json'))).toBe(true);
    expect(agentText().split(FIX)).toHaveLength(2);
  });

  it('says which fix it could not find, as JSON with --json', async () => {
    expect((await shadowlap(['fix', 'show', 'fx-NOPE'])).out).toContain('no fix matches "fx-NOPE" (see: shadowlap fix ls)');
    expect((await shadowlap(['fix', 'apply', 'NOPE'])).out).toContain('no fix matches "NOPE"');
    for (const args of [['fix', 'show', 'NOPE', '--json'], ['fix', 'apply', 'NOPE', '--json'], ['fix', 'show', 'fx-', '--json']]) {
      const r = await shadowlap(args);
      expect(r.code).toBe(2);
      expect(json(r)).toEqual({ fixId: args[2], status: 'error', error: { reason: 'unknown', message: `no fix matches "${args[2]}" (see: shadowlap fix ls)` } });
    }
    expect((await shadowlap(['fix', 'ls'])).stdout).toContain("No fixes here. A fix starts from a blame: shadowlap blame <run> --expect '<check>'");
  });

  it('keeps a verdict under another check without turning the fix verified', async () => {
    const { failed } = await runs('refund-over-limit');
    mode = 'alternate';
    const blamed = await shadowlap(['blame', failed[0], '--expect', ORACLE, '--json']);
    expect(blamed.code, blamed.out).toBe(0);
    const fixId = json(blamed).fix.fixId as string;

    // No --expect: the recordings already exit 0, so each replays clean and passes. That proves nothing about refunds.
    const exitOnly = await shadowlap(['verify', '--fixes', 'label:refund-over-limit', '--keeps', 'label:good', '--json']);
    expect(exitOnly.code, exitOnly.out).toBe(0);
    expect(json(exitOnly)).toMatchObject({ verdict: 'accepted', fixes: [{ fixId, status: 'open', counts: false, why: 'another-check' }] });
    const unrelated = await shadowlap(['verify', '--fixes', 'label:refund-over-limit', '--expect', '{"tools":{"send_email":0}}']);
    expect(unrelated.code, unrelated.out).toBe(0);
    expect(unrelated.stdout).toContain(`fix ${fixId.slice(0, 13)} · issue_refund called with amount 240 · accepted verdict kept, not counted (checked under another check); still open`);

    const shown = json(await shadowlap(['fix', 'show', fixId, '--json']));
    expect(shown).toMatchObject({ status: 'open', verifiedAt: null, failing: 1, good: 0 });
    expect(shown.steps[2]).toMatchObject({ state: 'todo', short: 'not verified', meta: 'verified only under another check' });
    expect(shown.verify.map((v: { verdict: string; counts: boolean }) => [v.verdict, v.counts])).toEqual([
      ['accepted', false],
      ['accepted', false],
    ]);
    expect(shown.verify[1]).toMatchObject({ note: null, headline: `Doesn't count for this fix: its check leaves out issue_refund with {"amount":240} called 0 times` });
    expect((await shadowlap(['fix', 'show', fixId])).stdout).toMatch(/✓ accepted {2}\S+ {2}Doesn't count for this fix: its check leaves out issue_refund with \{"amount":240\} called 0 times\n/);

    const refused = await shadowlap(['fix', 'apply', fixId]);
    expect(refused.code).toBe(2);
    expect(refused.out).toContain(`${fixId.slice(0, 13)} is open: a change was accepted, but under another check than this fix's (issue_refund never called with {"amount":240}), so it doesn't count. Verify it under this fix's check:`);
    // The fix's own failing run: the other labelled run was verified only under another check, so it isn't one of the fix's.
    expect(refused.out).toContain(`shadowlap verify --fixes ${failed[0]} --keeps label:good --expect '${ORACLE}'`);
    const s = store();
    try {
      expect(s.listEvents({ kinds: ['verify.accepted'] }).map((e) => e.data)).toEqual([expect.objectContaining({ fixes: [fixId], counts: [] }), expect.objectContaining({ fixes: [fixId], counts: [] })]);
    } finally {
      s.close();
    }
  });

  it('keeps a repair whose pull request could not be opened, applied by --apply, and lets fix apply finish it', async () => {
    const { failed } = await runs();
    mode = 'alternate';
    // No remote to push to: the change is applied and committed to the branch, and the pull request fails.
    const r = await shadowlap(['repair', '--fixes', ...failed, '--keeps', 'label:good', '--expect', ORACLE, '--repairer', 'anthropic', '--apply', '--branch', 'fix-refunds', '--pr', '--json']);
    expect(r.code, r.out).toBe(1);
    const report = json(r);
    expect(report).toMatchObject({ outcome: 'fixed', error: { message: expect.stringContaining('git push origin fix-refunds failed') }, output: { applied: true, branch: 'fix-refunds', pr: null } });
    expect(report.warnings).toContainEqual(expect.stringContaining('handing the fix over stopped: git push origin fix-refunds failed'));
    expect(JSON.parse(readFileSync(join(project, report.output.dir, 'report.json'), 'utf8'))).toMatchObject({ outcome: 'fixed', output: { applied: true } });
    const fixId = report.fixes[0].fixId as string;
    expect(report.fixes[0]).toMatchObject({ status: 'applied', counts: true });
    expect(agentText()).toContain(FIX);

    let shown = json(await shadowlap(['fix', 'show', fixId, '--json']));
    expect(shown).toMatchObject({ status: 'applied', applied: { patch: 'applied', via: 'repair --apply', goldens: [], tests: 'skipped', repairId: report.repairId }, repair: { output: { branch: 'fix-refunds' } } });
    expect(shown.actions).toMatchObject({ applied: true, apply: { kind: 'patch', pending: 'copy the recordings the fixed code made into the goldens folder, and run shadowlap test on them' } });

    // fix apply finishes it; a build that breaks the agent makes the test fail, and the fix shows it.
    const broken = await shadowlap(['fix', 'apply', fixId, '--build', `node -e "require('fs').writeFileSync('agent.mjs', 'process.exit(3)')"`]);
    expect(broken.code, broken.out).toBe(1);
    // Broken before it passes 80 columns, as a terminal shows it.
    expect(broken.stdout).toContain(`✗ ${fixId.slice(0, 13)} finished applying: the patch was already in the working tree,\n  2 of 2 goldens copied to goldens/, shadowlap test failed\n`);
    expect(broken.stdout).toContain(`once the test passes, run shadowlap fix apply ${fixId.slice(0, 13)} again`);
    expect(broken.out).toContain('rebuilt: node -e');
    expect((await shadowlap(['fix', 'ls'])).stdout).toContain('! shadowlap test failed on its goldens');
    shown = json(await shadowlap(['fix', 'show', fixId, '--json']));
    expect(shown).toMatchObject({ broken: 'shadowlap test failed on its goldens', applied: { tests: 'failed', via: 'fix apply', patch: 'applied' }, actions: { apply: { pending: 'run shadowlap test on its goldens' } } });
    // --no-test leaves the failed test as it is, and says so.
    const untested = await shadowlap(['fix', 'apply', fixId, '--no-test']);
    expect(untested.code).toBe(1);
    expect(untested.stdout).toMatch(new RegExp(`! ${fixId.slice(0, 13)} is already applied \\([^)]*\\), but its goldens failed their last test: run it without --no-test to test them\n`));

    sh(project, 'git', ['checkout', '--', 'agent.mjs']);
    sh(project, 'git', ['apply', report.output.patch]);
    const fixed = await shadowlap(['fix', 'apply', fixId, '--json']);
    expect(fixed.code, fixed.out).toBe(0);
    expect(json(fixed)).toMatchObject({ status: 'applied', again: true, patch: 'already', tests: 'passed', goldens: [expect.objectContaining({ copied: false }), expect.objectContaining({ copied: false })] });
    expect(json(await shadowlap(['fix', 'show', fixId, '--json']))).toMatchObject({ broken: null, applied: { tests: 'passed', goldens: [expect.stringMatching(/^goldens\//), expect.stringMatching(/^goldens\//)] }, actions: { apply: { pending: null } } });
    expect((await shadowlap(['fix', 'apply', fixId])).stdout).toMatch(new RegExp(`${fixId.slice(0, 13)} is already applied \\(\\d+s ago\\); nothing is left to do`));

    const s = store();
    try {
      expect(s.listEvents({ kinds: ['fix.applied'] }).map((e) => e.data)).toEqual([
        expect.objectContaining({ tests: 'passed', again: true }),
        expect.objectContaining({ tests: 'failed', again: true }),
        expect.objectContaining({ via: 'repair --apply', tests: 'skipped' }),
      ]);
    } finally {
      s.close();
    }
  });

  it('puts the goldens of repair --apply where an absolute --goldens says, and keeps where they went relative to the project', async () => {
    const { failed } = await runs();
    mode = 'alternate';
    const goldens = join(project, 'tests', 'goldens');
    const r = await shadowlap(['repair', '--fixes', ...failed, '--keeps', 'label:good', '--expect', ORACLE, '--repairer', 'anthropic', '--apply', '--goldens', goldens, '--json']);
    expect(r.code, r.out).toBe(0);
    const report = json(r);
    const fixId = report.fixes[0].fixId as string;
    const names = (report.output.goldens as string[]).map((g) => basename(g));
    expect(names).toHaveLength(2);
    for (const name of names) expect(existsSync(join(goldens, name, 'run.json'))).toBe(true);
    expect(json(await shadowlap(['fix', 'show', fixId, '--json'])).applied).toMatchObject({ via: 'repair --apply', goldens: names.map((n) => `tests/goldens/${n}`), tests: 'skipped' });

    // fix apply tests them where they are, and copies nothing again.
    const applied = await shadowlap(['fix', 'apply', fixId, '--json']);
    expect(applied.code, applied.out).toBe(0);
    expect(json(applied)).toMatchObject({ again: true, patch: 'already', tests: 'passed', goldens: names.map((n) => ({ to: `tests/goldens/${n}`, copied: false })) });
    expect(existsSync(join(project, 'goldens'))).toBe(false);
  });

  it('keeps a repair whose recordings could not be copied after --apply, and lets fix apply copy them', async () => {
    const { failed } = await runs();
    mode = 'alternate';
    // A file where the goldens folder should be: the change goes in, the copy fails.
    writeFileSync(join(project, 'not-a-folder'), '');
    const r = await shadowlap(['repair', '--fixes', ...failed, '--keeps', 'label:good', '--expect', ORACLE, '--repairer', 'anthropic', '--apply', '--goldens', 'not-a-folder', '--json']);
    expect(r.code, r.out).toBe(1);
    const report = json(r);
    expect(report).toMatchObject({ outcome: 'fixed', output: { applied: true }, error: { message: expect.stringContaining('the fix is in the working tree, but copying its recordings to not-a-folder failed') } });
    expect(agentText()).toContain(FIX);
    const fixId = report.fixes[0].fixId as string;
    expect(report.fixes[0]).toMatchObject({ status: 'applied', counts: true });
    const shown = json(await shadowlap(['fix', 'show', fixId, '--json']));
    expect(shown).toMatchObject({ applied: { via: 'repair --apply', goldens: [] }, actions: { apply: { pending: 'copy the recordings the fixed code made into the goldens folder, and run shadowlap test on them' } } });
    expect(shown.repair.warnings).toContainEqual(expect.stringContaining('handing the fix over stopped: the fix is in the working tree, but copying its recordings'));

    const applied = await shadowlap(['fix', 'apply', fixId, '--json']);
    expect(applied.code, applied.out).toBe(0);
    expect(json(applied)).toMatchObject({ again: true, patch: 'already', tests: 'passed', goldens: [expect.objectContaining({ copied: true }), expect.objectContaining({ copied: true })] });
  });
});
