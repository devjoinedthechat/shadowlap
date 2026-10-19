import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { message, startMockAnthropic, text, toolUse, type MockServer, type ScriptContext } from '@shadowlap-testing/mock-anthropic';
import { departures, docsOf, names, SHAPES } from './json-shapes.js';

/**
 * `shadowlap coverage`: imported runs grouped by behaviour, checked against the goldens on disk, and
 * `--pack`, which turns a capture into a golden by replaying it with the agent's command, offline,
 * its tool results taken from the capture's own conversation.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const AGENT = fileURLToPath(new URL('./support-agent.mjs', import.meta.url));

/**
 * The model: looks up the order the prompt names, reads the policy, then escalates a $240 refund and
 * issues a $40 one. Told to refund everything, it issues the refund and escalates as well.
 */
function script(ctx: ScriptContext) {
  const first = ctx.request.messages[0]?.content;
  const order = typeof first === 'string' && first.includes('B-7') ? 'B-7' : 'A-1042';
  const results = ctx.request.messages.flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<{ type: string; content?: unknown }>).filter((b) => b.type === 'tool_result').map((b) => String(b.content)) : [])).join('\n');
  const big = results.includes('"amount":240');
  const everything = JSON.stringify(ctx.request.system ?? '').includes('refund everything');
  const id = (name: string) => `toolu_${name}_${ctx.requestNo}`;
  switch (ctx.assistantTurns) {
    case 0:
      return { message: message([text('Looking the order up.'), toolUse('lookup_order', { order_id: order }, id('lookup'))]) };
    case 1:
      return { message: message([toolUse('read_policy', {}, id('policy'))]) };
    case 2:
      return big && !everything ? { message: message([toolUse('escalate', { reason: 'above $100' }, id('escalate'))]) } : { message: message([toolUse('issue_refund', { order_id: order, amount: big ? 240 : 40 }, id('refund'))]) };
    case 3:
      if (everything) return { message: message([toolUse('escalate', { reason: 'refunded above $100' }, id('escalate'))]) };
    // falls through
    default:
      return { message: message([text(big && !everything ? 'Escalated to a manager.' : 'Refunded.')], { stop_reason: 'end_turn' }) };
  }
}

let mock: MockServer;
let work: string;
const db = () => join(work, '.shadowlap', 'shadowlap.db');

beforeAll(async () => {
  mock = await startMockAnthropic({ script, eventDelayMs: () => 0 });
  work = mkdtempSync(join(tmpdir(), 'sl-coverage-'));
  writeFileSync(join(work, 'shadowlap.config.json'), '{}\n');
}, 30_000);
afterAll(async () => {
  await mock.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function shadowlap(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; out: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: work,
      env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off', SHADOWLAP_HOME: join(work, 'home'), SHADOWLAP_AUTHOR: 'dana@example.com', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => ((out += d.toString()), (stdout += d.toString())));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) => resolve({ code, out, stdout }));
  });
}
const runIdIn = (out: string) => /(?:recording|replaying) run (\w{26})/.exec(out)![1]!;
const json = <T>(r: { stdout: string; out: string }): T => {
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    throw new Error(`not JSON:\n${r.out}`);
  }
};

interface GroupJson {
  key: string;
  covered: boolean;
  coveredBy: string[];
  path: string[];
  writes: string[];
  outcome: string;
  runs: number;
  runIds: string[];
  command: { argv: string[]; from: string } | null;
  nearest: { golden: string; shared: number; differs: { step: number; seen: string | null; golden: string | null } | null } | null;
  packed: { golden: string; runId: string; mode: string | null } | null;
  lastPack: { at: number; golden: string | null; mode: string | null; reason: string | null; why: string | null } | null;
}
interface PackOut {
  key: string;
  golden: string | null;
  runId: string | null;
  from: string | null;
  command: { argv: string[]; from: string } | null;
  mode: 'replay' | 'fork' | null;
  reason: string | null;
  why: string | null;
}
interface CoverageOut {
  scanId: string;
  runs: number;
  uncovered: number;
  groups: GroupJson[];
  goldens: Array<{ golden: string; path: string[] | null }>;
  pack: PackOut[] | null;
}

let escalateRun = '';
let refundRun = '';

describe('shadowlap coverage', () => {
  it('says there is nothing to read before anything was imported', async () => {
    const r = await shadowlap(['coverage']);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toContain('No imported runs to read');
    // A store that wasn't there stays that way: coverage only reads one.
    expect(existsSync(db())).toBe(false);
  });

  it('groups imported runs by behaviour and names the ones no golden covers', async () => {
    escalateRun = runIdIn((await shadowlap(['run', '--', process.execPath, AGENT, 'A-1042'])).out);
    refundRun = runIdIn((await shadowlap(['run', '--', process.execPath, AGENT, 'B-7'])).out);
    // The escalation is kept as a golden; production then shows both behaviours, twice the refund.
    expect((await shadowlap(['pack', escalateRun, 'goldens/escalate'])).code).toBe(0);
    for (const [run, file] of [
      [escalateRun, 'escalate.har'],
      [refundRun, 'refund.har'],
    ] as const) {
      expect((await shadowlap(['export', 'har', run, file, '--no-redact'])).code).toBe(0);
    }
    for (const file of ['escalate.har', 'refund.har', 'refund.har']) expect((await shadowlap(['import', 'har', file])).code).toBe(0);

    const r = await shadowlap(['coverage', '--json']);
    expect(r.code, r.out).toBe(0);
    const out = json<CoverageOut>(r);
    expect(out.runs).toBe(3);
    expect(out.uncovered).toBe(1);
    expect(out.goldens).toEqual([expect.objectContaining({ golden: 'goldens/escalate', path: ['lookup_order', 'read_policy', 'escalate'] })]);
    const [refund, escalate] = out.groups;
    expect(refund).toMatchObject({ covered: false, coveredBy: [], path: ['lookup_order', 'read_policy', 'issue_refund'], writes: ['issue_refund'], outcome: 'answered', runs: 2 });
    // The command the refund's capture would be reproduced with: the recording that sent its first request.
    expect(refund!.command).toEqual({ argv: [process.execPath, AGENT, 'B-7'], from: refundRun });
    expect(refund!.nearest).toEqual({ golden: 'goldens/escalate', shared: 2, differs: { step: 3, seen: 'issue_refund', golden: 'escalate' } });
    expect(escalate).toMatchObject({ covered: true, coveredBy: ['goldens/escalate'], runs: 1, command: null, nearest: null });

    // Read by a person: not covered first, the nearest golden and where they part.
    const shown = await shadowlap(['coverage']);
    expect(shown.stdout).toContain('Coverage of what 3 imported runs did: 2 behaviours, 1 not covered by a golden (1 golden read)');
    expect(shown.stdout).toMatch(/✗ 2 runs\s+lookup_order → read_policy → issue_refund/);
    expect(shown.stdout).toContain('writes issue_refund · answered · seen');
    expect(shown.stdout).toContain('nearest golden: goldens/escalate, the same for 2 steps;\n             then it calls issue_refund where the golden calls escalate\n');
    expect(shown.stdout).toContain('covered by goldens/escalate');
    expect(shown.stdout).toContain('Make a golden of one run of each: shadowlap coverage --pack');

    // Each scan is kept, its groups replacing the last one's.
    const store = Store.open(db());
    try {
      const scans = store.listCoverageScans();
      expect(scans).toHaveLength(2);
      expect(scans[0]).toMatchObject({ runs: 3, groups: 2, uncovered: 1, goldens: 1, actor: 'dana@example.com' });
      const groups = store.coverageGroups();
      expect(groups.map((g) => [g.scanId === scans[0]!.scanId, g.coveredBy, g.runs])).toEqual([
        [true, [], 2],
        [true, ['goldens/escalate'], 1],
      ]);
      expect(groups[0]!.command).toEqual({ argv: [process.execPath, AGENT, 'B-7'], from: refundRun });
      // The activity feed has a line for each scan.
      expect(store.listEvents({ kinds: ['coverage.scanned'] })[0]).toMatchObject({ ref: scans[0]!.scanId, actor: 'dana@example.com', data: { runs: 3, groups: 2, uncovered: 1, goldens: 1 } });
    } finally {
      store.close();
    }
  }, 120_000);

  it('--pack reproduces a capture offline with the agent\'s command and packs a golden that test replays', async () => {
    const r = await shadowlap(['coverage', '--pack', '--json']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/reproducing \w{26} with .*support-agent\.mjs B-7: offline, 3 tool results from its conversation, writes stubbed/);
    const out = json<CoverageOut>(r);
    expect(out.pack).toHaveLength(1);
    const made = out.pack![0]!;
    expect(made).toMatchObject({ why: null, command: { argv: [process.execPath, AGENT, 'B-7'], from: refundRun } });
    expect(made.golden).toMatch(/^goldens\/lookup-order-issue-refund-[0-9a-f]{6}$/);
    // The scan after it counts the new golden: every behaviour is covered now.
    expect(out.uncovered).toBe(0);
    expect(out.groups.find((g) => g.key === made.key)).toMatchObject({ covered: true, coveredBy: [made.golden], packed: { golden: made.golden, runId: made.runId } });

    // A golden like any other: it replays offline, every call from the pack.
    const tested = await shadowlap(['test', made.golden!]);
    expect(tested.code, tested.out).toBe(0);
    expect(tested.out).toContain('1 passed, 0 failed · 0 upstream requests');
    // Its run holds the tool calls the conversation answered, with what the agent declares of them.
    const pack = JSON.parse(readFileSync(join(work, made.golden!, 'calls.jsonl'), 'utf8').split('\n')[0]!) as { runId: string };
    expect(pack.runId).toBe(made.runId);
    const store = Store.open(db());
    try {
      const events = store.listEvents({ kinds: ['golden.packed'] });
      expect(events.find((e) => e.ref === made.golden)).toMatchObject({ runId: made.from, data: expect.objectContaining({ from: 'coverage', behaviour: made.key, run: made.runId }) });
    } finally {
      store.close();
    }
    // Nothing left to pack.
    const again = await shadowlap(['coverage', '--pack']);
    expect(again.code, again.out).toBe(0);
    expect(again.out).toContain('every behaviour has a golden: nothing to pack');
  }, 120_000);

  it('says why a capture the agent no longer reproduces is not packed, and takes the command after --', async () => {
    // Production refunded A-1042 and escalated it too, under another prompt: no golden has that.
    const other = runIdIn((await shadowlap(['run', '--', process.execPath, AGENT, 'A-1042'], { AGENT_SYSTEM: 'You refund everything.' })).out);
    expect((await shadowlap(['export', 'har', other, 'other.har', '--no-redact'])).code).toBe(0);
    expect((await shadowlap(['import', 'har', 'other.har'])).code).toBe(0);
    const before = json<CoverageOut>(await shadowlap(['coverage', '--json']));
    const group = before.groups.find((g) => !g.covered)!;
    expect(group).toBeDefined();

    // The agent now sends another system prompt: the replay forks at its first model call.
    const r = await shadowlap(['coverage', '--pack', group.key.slice(0, 8), '--json']);
    expect(r.code, r.out).toBe(1);
    const made = json<CoverageOut>(r).pack![0]!;
    // From the capture of it, with the command of the run here that sent its first request.
    expect(made).toMatchObject({ golden: null, mode: null, reason: 'not-reproduced', from: group.runIds[0], command: { argv: [process.execPath, AGENT, 'A-1042'], from: other } });
    expect(made.why).toMatch(/doesn't reproduce \w{10}: diverged at call 1 \(api POST \/v1\/messages\), where the agent sends something else now/);
    // Kept: the next scan says why, and a person reads what would keep it.
    const after = json<CoverageOut>(await shadowlap(['coverage', '--json']));
    expect(after.groups.find((g) => g.key === group.key)!.lastPack).toMatchObject({ golden: null, reason: 'not-reproduced', why: made.why });
    const shown = await shadowlap(['coverage', '--pack', group.key.slice(0, 8)]);
    expect(shown.stdout).toContain(`to keep it as the test that the change holds: shadowlap coverage --pack ${group.key.slice(0, 8)} --fork --expect '<what it must do now>'`);
    expect((await shadowlap(['coverage'])).stdout).toContain('last --pack, just now: the agent no longer does this (--fork with --expect keeps it as a golden that forks)');

    // Run as production ran it, the command of the run that sent its first request reproduces it.
    const given = await shadowlap(['coverage', '--pack', group.key.slice(0, 8), '--json', '--', process.execPath, AGENT, 'A-1042'], { AGENT_SYSTEM: 'You refund everything.' });
    expect(given.code, given.out).toBe(0);
    const packed = json<CoverageOut>(given).pack![0]!;
    expect(packed).toMatchObject({ why: null, mode: 'replay', reason: null, command: { argv: [process.execPath, AGENT, 'A-1042'], from: other } });

    // A key that names nothing, or one covered already, is refused before anything runs.
    expect((await shadowlap(['coverage', '--pack', 'ffff'])).out).toContain('no behaviour ffff in this scan');
    expect((await shadowlap(['coverage', '--pack', group.key])).out).toContain('is covered already');
    expect((await shadowlap(['coverage', '--', 'node'])).out).toContain('a command after -- is for --pack');
    expect((await shadowlap(['coverage', '--fork'])).out).toContain('--fork and --expect go with --pack');
    expect((await shadowlap(['coverage', '--not-packed', 'warn'])).out).toContain('--not-packed goes with --pack');
    expect((await shadowlap(['coverage', '--pack', '--fork', '--expect', '{"tools":{"x":0}}'])).out).toContain('--fork packs the behaviours you name');
    expect((await shadowlap(['coverage', '--pack', 'abcd', '--fork'])).out).toContain('--fork needs --expect');
    expect((await shadowlap(['coverage', '--pack', 'abcd', '--expect', '{"tools":{"x":0}}'])).out).toContain('--expect goes with --fork');
    expect((await shadowlap(['coverage', '--pack', 'abcd', '--fork', '--expect', '{}'])).out).toContain('--expect: give at least one check');
    expect((await shadowlap(['coverage', '--pack', '--', 'sh', '-c', 'node agent.mjs {message}'])).out).toContain('sh runs its arguments as a script');
  }, 120_000);

  it('prints what docs/cli.md says', async () => {
    const out = json<CoverageOut & Record<string, unknown>>(await shadowlap(['coverage', '--json']));
    const problems = [departures('coverage', out), departures('coverageGroup', out.groups[0]), departures('coverageGolden', out.goldens[0])].flatMap((d) => [...d.missing, ...d.extra]);
    expect(problems).toEqual([]);
    const packed = json<CoverageOut>(await shadowlap(['coverage', '--pack', '--json']));
    expect(packed.pack).toEqual([]);
    for (const shape of ['coverage', 'coverageGroup', 'coverageGolden', 'coveragePack'] as const) {
      const missing = SHAPES[shape].fields.filter((f) => !names(docsOf(shape), f));
      expect(missing, shape).toEqual([]);
    }
  }, 60_000);
});

/**
 * Production traffic a store here never sent: each capture's input (the order its first message
 * names) is one no run here was given, so no run here says the command, and `{message}` starts the
 * agent as production started it. A capture of a prompt the agent no longer has is kept, with the
 * checks that say what it must do now, as a golden that forks.
 */
describe('coverage --pack on production traffic', () => {
  /** The model: looks up the order the first message names, reads the policy, then escalates a $240 refund and issues a $40 one; told to refund everything, it refunds and escalates. */
  function production(ctx: ScriptContext) {
    const first = ctx.request.messages[0]?.content;
    const order = (typeof first === 'string' && /[A-Z]-\d+/.exec(first)?.[0]) || 'A-1042';
    const results = ctx.request.messages.flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<{ type: string; content?: unknown }>).filter((b) => b.type === 'tool_result').map((b) => String(b.content)) : [])).join('\n');
    const big = results.includes('"amount":240');
    const everything = JSON.stringify(ctx.request.system ?? '').includes('refund everything');
    const id = (name: string) => `toolu_${name}_${ctx.requestNo}`;
    switch (ctx.assistantTurns) {
      case 0:
        return { message: message([toolUse('lookup_order', { order_id: order }, id('lookup'))]) };
      case 1:
        return { message: message([toolUse('read_policy', {}, id('policy'))]) };
      case 2:
        return big && !everything ? { message: message([toolUse('escalate', { reason: 'above $100' }, id('escalate'))]) } : { message: message([toolUse('issue_refund', { order_id: order, amount: big ? 240 : 40 }, id('refund'))]) };
      case 3:
        if (everything) return { message: message([toolUse('escalate', { reason: 'refunded above $100' }, id('escalate'))]) };
      // falls through
      default:
        return { message: message([text(big && !everything ? 'Escalated to a manager.' : 'Refunded.')], { stop_reason: 'end_turn' }) };
    }
  }

  let models: MockServer;
  let dir: string;
  const sl = (args: string[], env: NodeJS.ProcessEnv = {}) =>
    new Promise<{ code: number | null; out: string; stdout: string }>((resolve) => {
      const child = spawn(process.execPath, [CLI, ...args], {
        cwd: dir,
        env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: models.url, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off', SHADOWLAP_HOME: join(dir, 'home'), SHADOWLAP_AUTHOR: 'dana@example.com', ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let stdout = '';
      child.stdout.on('data', (d: Buffer) => ((out += d.toString()), (stdout += d.toString())));
      child.stderr.on('data', (d: Buffer) => (out += d.toString()));
      child.on('exit', (code) => resolve({ code, out, stdout }));
    });
  /** A run made in production (a store of its own), exported and imported here as traffic is. */
  const fromProduction = async (order: string, env: NodeJS.ProcessEnv = {}) => {
    const made = runIdIn((await sl(['--db', 'production.db', 'run', '--', process.execPath, AGENT, order], env)).out);
    const file = `prod-${order}-${made.slice(-4)}.har`;
    expect((await sl(['--db', 'production.db', 'export', 'har', made, file, '--no-redact'])).code).toBe(0);
    expect((await sl(['import', 'har', file])).code).toBe(0);
  };
  const byPath = (out: CoverageOut, last: string) => out.groups.find((g) => g.path.at(-1) === last && !g.covered)!;
  const ORDER = '{message:/[A-Z]-\\d+/}';

  beforeAll(async () => {
    models = await startMockAnthropic({ script: production, eventDelayMs: () => 0 });
    dir = mkdtempSync(join(tmpdir(), 'sl-coverage-prod-'));
    writeFileSync(join(dir, 'shadowlap.config.json'), '{}\n');
  }, 30_000);
  afterAll(async () => {
    await models.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it("starts each capture with its own input: {message}, or the part of it a regex picks", async () => {
    // Here: the escalation of A-1042 is a golden. Production: a refund of B-7, which nobody here ran.
    const local = runIdIn((await sl(['run', '--', process.execPath, AGENT, 'A-1042'])).out);
    expect((await sl(['pack', local, 'goldens/escalate'])).code).toBe(0);
    await fromProduction('B-7');
    const refund = byPath(json<CoverageOut>(await sl(['coverage', '--json'])), 'issue_refund');
    expect(refund).toMatchObject({ runs: 1, command: null, path: ['lookup_order', 'read_policy', 'issue_refund'] });
    const scan = await sl(['coverage']);
    expect(scan.stdout).toContain("Make a golden of one run of each: shadowlap coverage --pack -- <the agent's command, with {message} where its input goes>");

    // No run here sent its first request: nothing says what starts the agent.
    const bare = await sl(['coverage', '--pack', '--json']);
    expect(bare.code, bare.out).toBe(1);
    expect(json<CoverageOut>(bare).pack![0]).toMatchObject({ golden: null, reason: 'no-command', why: expect.stringContaining('no command: no run here sent') });
    // A command with the input fixed starts it with another first message: the wrong one for this capture.
    const fixed = await sl(['coverage', '--pack', '--json', '--', process.execPath, AGENT, 'A-1042']);
    expect(json<CoverageOut>(fixed).pack![0]).toMatchObject({ golden: null, reason: 'other-message', why: expect.stringContaining('starts the agent with another first message than') });
    expect(json<CoverageOut>(fixed).pack![0]!.why).toContain('production sent “The customer asks for a refund on order B-7.”, the agent sent “The customer asks for a refund on order A-1042.”; put {message} where the agent\'s input goes');
    // A regex that finds nothing in its first message says so.
    const nothing = await sl(['coverage', '--pack', '--json', '--', process.execPath, AGENT, '{message:/Z-\\d+/}']);
    expect(json<CoverageOut>(nothing).pack![0]).toMatchObject({ reason: 'no-command', why: expect.stringContaining('its first message has no match for /Z-\\d+/') });

    // Started as production started it, it reproduces offline and is packed.
    const packed = await sl(['coverage', '--pack', '--json', '--', process.execPath, AGENT, ORDER]);
    expect(packed.code, packed.out).toBe(0);
    expect(packed.out).toContain(`with ${process.execPath} ${AGENT} B-7: offline`);
    const made = json<CoverageOut>(packed).pack![0]!;
    expect(made).toMatchObject({ mode: 'replay', reason: null, command: { argv: [process.execPath, AGENT, 'B-7'], from: '--' } });
    const tested = await sl(['test', made.golden!]);
    expect(tested.code, tested.out).toBe(0);
    expect(tested.out).toContain('1 passed, 0 failed · 0 upstream requests');
  }, 180_000);

  it('keeps one the agent no longer does as a golden that forks, judged by the checks given', async () => {
    // Production ran another prompt, which refunded a $240 order and escalated it too.
    await fromProduction('A-1042', { AGENT_SYSTEM: 'You refund everything.' });
    const group = byPath(json<CoverageOut>(await sl(['coverage', '--json'])), 'escalate');
    expect(group.path).toEqual(['lookup_order', 'read_policy', 'issue_refund', 'escalate']);
    const key = group.key.slice(0, 8);

    // The first message is production's, the system prompt isn't: the agent no longer does this.
    const tried = await sl(['coverage', '--pack', '--', process.execPath, AGENT, ORDER]);
    expect(tried.code, tried.out).toBe(1);
    expect(tried.stdout).toContain(`not packed: ${process.execPath} ${AGENT} A-1042 doesn't reproduce`);
    expect(tried.stdout).toContain(`to keep it as the test that the change holds: shadowlap coverage --pack ${key} --fork --expect '<what it must do now>' -- <the same command>`);
    // A scheduled job reports what it couldn't pack and carries on.
    const warned = await sl(['coverage', '--pack', '--not-packed', 'warn', '--', process.execPath, AGENT, ORDER]);
    expect(warned.code, warned.out).toBe(0);
    expect(warned.stdout).toContain('1 not packed: reported, not failed (--not-packed warn)');

    const forked = await sl(['coverage', '--pack', key, '--fork', '--expect', '{"tools":{"issue_refund":0}}', '--json', '--', process.execPath, AGENT, ORDER]);
    expect(forked.code, forked.out).toBe(0);
    const made = json<CoverageOut>(forked).pack![0]!;
    expect(made).toMatchObject({ mode: 'fork', reason: null, command: { argv: [process.execPath, AGENT, 'A-1042'], from: '--' } });
    expect(made.golden).toMatch(/^goldens\/lookup-order-issue-refund-escalate-[0-9a-f]{6}$/);
    // Its tests entry says it forks and what it must do: the behaviour is covered.
    const config = JSON.parse(readFileSync(join(dir, 'shadowlap.config.json'), 'utf8')) as { tests: Record<string, unknown> };
    expect(config.tests[made.golden!]).toEqual({ fork: true, expect: { tools: { issue_refund: 0 } } });
    expect(json<CoverageOut>(forked).groups.find((g) => g.key === group.key)).toMatchObject({ covered: true, packed: { golden: made.golden, mode: 'fork' }, lastPack: { golden: made.golden, mode: 'fork', reason: null } });

    // shadowlap test replays production's run, forks where the agent parts from it, and the agent
    // as it is now escalates without refunding: it passes. (This agent stops on a blocked write, so
    // its writes after the fork are stubbed.)
    const tested = await sl(['test', made.golden!, '--writes', 'stub']);
    expect(tested.code, tested.out).toBe(0);
    expect(tested.out).toMatch(/✓ lookup-order-issue-refund-escalate-[0-9a-f]{6}: forked at call 1, .*1 check passed/);
    // Its recording, unpacked by the test, has the agent's command: it is no production traffic.
    expect(json<CoverageOut>(await sl(['coverage', '--json']))).toMatchObject({ runs: 2, uncovered: 0 });
  }, 180_000);
});
