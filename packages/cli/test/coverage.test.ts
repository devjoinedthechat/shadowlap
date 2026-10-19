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
  packed: { golden: string; runId: string } | null;
}
interface CoverageOut {
  scanId: string;
  runs: number;
  uncovered: number;
  groups: GroupJson[];
  goldens: Array<{ golden: string; path: string[] | null }>;
  pack: Array<{ key: string; golden: string | null; runId: string | null; from: string | null; command: { argv: string[]; from: string } | null; why: string | null }> | null;
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
    expect(shown.stdout).toContain('nearest golden: goldens/escalate, the same for 2 steps; then it calls issue_refund where the golden calls escalate');
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
    expect(made.golden).toBeNull();
    expect(made.why).toMatch(/doesn't reproduce \w{10}: diverged at call 1 \(api POST \/v1\/messages\)/);

    // Given the command that does reproduce it, it packs.
    const given = await shadowlap(['coverage', '--pack', group.key.slice(0, 8), '--json', '--', process.execPath, AGENT, 'A-1042'], { AGENT_SYSTEM: 'You refund everything.' });
    expect(given.code, given.out).toBe(0);
    const packed = json<CoverageOut>(given).pack![0]!;
    expect(packed).toMatchObject({ why: null, command: { argv: [process.execPath, AGENT, 'A-1042'], from: '--' } });

    // A key that names nothing, or one covered already, is refused before anything runs.
    expect((await shadowlap(['coverage', '--pack', 'ffff'])).out).toContain('no behaviour ffff in this scan');
    expect((await shadowlap(['coverage', '--pack', group.key])).out).toContain('is covered already');
    expect((await shadowlap(['coverage', '--', 'node'])).out).toContain('a command after -- is for --pack');
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
