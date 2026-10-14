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
      const escalates = system.includes('escalate every refund above the limit') || (mode === 'alternate' && decisions % 2 === 0);
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

function shadowlap(args: string[], env: NodeJS.ProcessEnv = {}): Promise<Result> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: project,
      env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: 'test-key', SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off', SHADOWLAP_AUTHOR: 'dana', SHADOWLAP_EVENTS_FD: '3', ...env },
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
/** The model calls of a run, by call number: the agent's decision is the third. */
function modelCalls(runId: string): number[] {
  const s = store();
  try {
    return s.getCalls(runId).filter((c) => c.kind === 'api').map((c) => c.callNo);
  } finally {
    s.close();
  }
}

describe('shadowlap fix', () => {
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
    expect(table).toMatch(new RegExp(`open +${fixId.slice(0, 13)} +Refunds above the limit issued without approval +refund-over-limit · 2 failing +lost at #${decision} · no fix yet · not verified`));

    // The code as it is fixes nothing: the verdict is kept, rejected, and the fix stays open.
    const rejected = await shadowlap(['verify', '--fixes', 'label:refund-over-limit', '--keeps', 'label:good', '--expect', ORACLE, '--json']);
    expect(rejected.code, rejected.out).toBe(1);
    const no = json(rejected);
    expect(no).toMatchObject({ verdict: 'rejected', fixes: [{ fixId, status: 'open' }] });
    expect(no.verifyId).toMatch(/^vf-[0-9A-Z]{26}$/);
    expect(rejected.events).toContainEqual({ type: 'link', label: 'Open the fix', href: `#/fixes/${fixId}/verify/${no.verifyId}` });

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
    expect(shown.steps[2]).toMatchObject({ short: '3 of 3 held', title: '3 of 3 runs held', meta: '1 earlier change rejected' });
    expect(shown.verify.map((v: { verdict: string }) => v.verdict)).toEqual(['accepted', 'rejected']);
    expect(shown.defaultVerify).toBe(shown.verify[0].verifyId);
    expect(shown.verify[0]).toMatchObject({ headline: 'Every failing run fixed, every good run kept', oracle: 'a run passes when 4 of 5 attempts meet the check: the agent exits 0; issue_refund with {"amount":240} called 0 times' });
    expect(shown.verify[0].rows.map((r: { role: string; outcome: string }) => [r.role, r.outcome])).toEqual([
      ['target', 'fixed'],
      ['target', 'fixed'],
      ['good', 'kept'],
    ]);
    expect(shown.verify[1]).toMatchObject({ headline: 'The change did not fix every failing run', command: `shadowlap verify --fixes label:refund-over-limit --keeps label:good --expect '${ORACLE}'` });
    expect(shown.verify[1].rows[0]).toMatchObject({ outcome: 'not fixed', deterministic: true, note: 'issue_refund called' });
    // The Blame step shows the latest blame that found the call; both are kept.
    expect(shown.blames).toHaveLength(2);
    expect(shown.blame).toMatchObject({ runId: failed[1], outcome: 'blamed', lostAt: decision, step: 3, steps: 4, confidence: 'high', needed: 2, attemptsPerProbe: 5 });
    expect(shown.blame.boundary).toMatch(new RegExp(`^Resampling #${decision} rescued \\d of \\d attempts; resampling #\\d+, the next model call, rescued 0 of 4\\.$`));
    expect(shown.blame.answers).toMatchObject({ callNo: decision, recorded: 'issue_refund({"order_id":"A-1042","amount":240})', rescued: '"Above the limit.", escalate({"reason":"above the refund limit"})' });
    expect(shown.blame.probes.find((x: { blamed: boolean }) => x.blamed)).toMatchObject({ callNo: decision, verdict: 'rescued · blamed', href: `#/run/${failed[1]}/${decision}` });
    expect(shown.blame.command).toBe(`shadowlap blame ${failed[1].slice(0, 10)} --expect '${ORACLE}'`);
    expect(shown.blame.callRow.filter((c: { kind: string }) => c.kind === 'api')).toHaveLength(4);
    // Verified on the working tree, with no repair behind it: applying it only marks it.
    expect(shown.actions).toEqual({ repair: null, apply: { kind: 'mark', argv: ['fix', 'apply', fixId], gitApply: null }, applied: false });

    const human = (await shadowlap(['fix', 'show', fixId])).stdout;
    expect(human).toContain(`${fixId}  Refunds above the limit issued without approval`);
    expect(human).toContain('check: issue_refund never called with {"amount":240}');
    expect(human).toMatch(/✓ 01 blame +Lost at model call/);
    expect(human).toContain('✓ accepted');
    expect(human).toContain('✗ rejected');
    expect(human).toContain(`next: shadowlap fix apply ${fixId.slice(0, 13)}`);

    const applied = await shadowlap(['fix', 'apply', fixId, '--json']);
    expect(applied.code, applied.out).toBe(0);
    expect(json(applied)).toEqual({ fixId, status: 'applied', patch: 'none', repairId: null, goldens: [], tests: 'skipped' });
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
      ['done', '3 of 3 held'],
    ]);
    expect(shown.steps[1]).toMatchObject({ title: 'Escalate refunds above the policy limit', meta: 'candidate 3 of 3 · proposed by anthropic:claude-opus-5-5' });
    expect(shown.repair).toMatchObject({
      repairId: report.repairId,
      accepted: true,
      title: 'Escalate refunds above the policy limit',
      repairer: 'anthropic:claude-opus-5-5',
      change: { file: 'agent.mjs', anchor: 'system prompt', before: ORIGINAL, after: FIX, added: { text: ': escalate every refund above the limit it sets' }, removed: '' },
      needed: 4,
      attemptsPerRun: 5,
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
    expect(shown.actions.apply).toEqual({ kind: 'patch', argv: ['fix', 'apply', fixId], gitApply: `git apply ${report.output.dir}/fix.patch` });

    const applied = await shadowlap(['fix', 'apply', fixId.slice(0, 13), '--json']);
    expect(applied.code, applied.out).toBe(0);
    const result = json(applied);
    expect(result).toMatchObject({ fixId, status: 'applied', patch: 'applied', repairId: report.repairId, tests: 'passed' });
    expect(result.goldens).toEqual(report.output.goldens.map((g: string) => ({ from: g, to: join('goldens', basename(g)), copied: true })));
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
      expect(s.listEvents().map((e) => e.kind).filter((k) => k !== 'blame.done')).toEqual(['fix.applied', 'repair.accepted']);
      expect(s.listEvents({ kinds: ['repair.accepted'] })[0]).toMatchObject({ ref: fixId, data: { repairId: report.repairId, title: 'Escalate refunds above the policy limit', verifyId: report.verifyId } });
    } finally {
      s.close();
    }
  });

  it('keeps a fix open after a repair that accepts nothing, with every candidate tried and why it was dropped', async () => {
    answers = 'bad';
    const { failed } = await runs('refund-over-limit');
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
    expect(shown.actions.repair.argv).toEqual(['repair', '--fixes', 'label:refund-over-limit', '--keeps', 'label:good', '--expect', ORACLE]);
    expect(shown.actions.repair.command).toBe(`shadowlap repair --fixes label:refund-over-limit --keeps label:good --expect '${ORACLE}' --repairer claude-code`);

    // Nothing verified, nothing to apply: it says how to get there.
    const refused = await shadowlap(['fix', 'apply', fixId]);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain(`${fixId.slice(0, 13)} is open: no change has been verified for it yet, so there is nothing to apply. Repair it first:`);
    expect(refused.out).toContain('shadowlap repair --fixes label:refund-over-limit');

    const s = store();
    try {
      expect(s.listEvents({ kinds: ['repair.empty'] })[0]).toMatchObject({ ref: fixId, data: { outcome: 'not-fixed', candidates: 2 } });
    } finally {
      s.close();
    }
  });

  it('recognises a patch already in the tree, and refuses to apply over changes that conflict with it', async () => {
    const { failed } = await runs();
    mode = 'alternate';
    const repaired = json(await shadowlap(['repair', '--fixes', ...failed, '--keeps', 'label:good', '--expect', ORACLE, '--repairer', 'anthropic', '--json']));
    const fixId = repaired.fixes[0].fixId as string;

    writeFileSync(join(project, 'agent.mjs'), agentText().replace(ORIGINAL, 'You are a support agent. Be kind.'));
    const refused = await shadowlap(['fix', 'apply', fixId]);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain('agent.mjs has uncommitted changes the patch conflicts with');
    expect(refused.out).toContain('Nothing was changed: commit or stash them');
    expect(agentText()).toContain('Be kind.');
    expect(existsSync(join(project, 'goldens'))).toBe(false);

    sh(project, 'git', ['checkout', '--', 'agent.mjs']);
    sh(project, 'git', ['apply', repaired.output.patch]);
    const applied = await shadowlap(['fix', 'apply', fixId, '--no-test', '--goldens', 'tests/goldens', '--json']);
    expect(applied.code, applied.out).toBe(0);
    expect(json(applied)).toMatchObject({ status: 'applied', patch: 'already', tests: 'skipped' });
    expect(existsSync(join(project, 'tests', 'goldens', failed[0].slice(0, 10), 'run.json'))).toBe(true);
    expect(agentText().split(FIX)).toHaveLength(2);
  });

  it('says which fix it could not find', async () => {
    expect((await shadowlap(['fix', 'show', 'fx-NOPE'])).out).toContain('no fix matches "fx-NOPE" (see: shadowlap fix ls)');
    expect((await shadowlap(['fix', 'apply', 'NOPE'])).out).toContain('no fix matches "NOPE"');
    expect((await shadowlap(['fix', 'ls'])).stdout).toContain("No fixes here. A fix starts from a blame: shadowlap blame <run> --expect '<check>'");
  });
});
