import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { message, startMockAnthropic, text, toolUse, type MockServer, type ScriptContext } from '@shadowlap-testing/mock-anthropic';

/**
 * `shadowlap blame` on runs that failed for no reason of the model's: a digest posted to a channel
 * that doesn't exist (a write's error), and a read that failed while its service was down. Probes
 * stub writes after the fork, and a stub never fails, so before blame looked at what its probes
 * answered and met, it blamed the last model call of such a run with high confidence. The mock
 * plays the model and answers the same every time, unless `varied` makes each digest's text new.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const AGENT = fileURLToPath(new URL('./digest-agent.mjs', import.meta.url));
const DIGEST = '2 refunds this week, $285 in all.';

let mock: MockServer;
let work: string;
let db: string;
let varied = false;

function script(ctx: ScriptContext) {
  const asked = JSON.stringify(ctx.request.messages[0]?.content ?? '');
  const channel = /to (#[\w-]+)/.exec(asked)?.[1] ?? '#support-leads';
  switch (ctx.assistantTurns) {
    case 0:
      return { message: message([toolUse('list_refunds', {}, 'toolu_list')]) };
    case 1:
      return { message: message([text('Posting the digest.'), toolUse('post_digest', { channel, text: varied ? `${DIGEST} (draft ${ctx.requestNo})` : DIGEST }, 'toolu_post')]) };
    default:
      return { message: message([text('Posted the digest.')], { stop_reason: 'end_turn' }) };
  }
}

beforeAll(async () => {
  mock = await startMockAnthropic({ script, eventDelayMs: () => 0 });
});
afterAll(async () => {
  await mock.close();
});
beforeEach(() => {
  if (work) rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  work = mkdtempSync(join(tmpdir(), 'fp-blame-writes-'));
  db = join(work, 'store.db');
  varied = false;
});

function shadowlap(args: string[]): Promise<{ code: number | null; out: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, '--db', db, ...args], { cwd: work, env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off', AGENT_OUTBOX: join(work, 'outbox.jsonl') }, stdio: ['ignore', 'pipe', 'pipe'] });
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

/** Records the agent, which fails: its run, with its model calls and tool calls by number. */
async function recordFailing(args: string[] = []): Promise<string> {
  const r = await shadowlap(['run', '--', process.execPath, AGENT, ...args]);
  expect(r.code, r.out).toBe(1);
  return /recording run (\w{26})/.exec(r.out)![1]!;
}

const outbox = () => (existsSync(join(work, 'outbox.jsonl')) ? readFileSync(join(work, 'outbox.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { channel: string }) : []);

function withStore<T>(fn: (s: Store) => T): T {
  const s = Store.open(db);
  try {
    return fn(s);
  } finally {
    s.close();
  }
}

interface Report {
  outcome: string;
  blamed: { callNo: number } | null;
  lost: unknown;
  contrast: { callNo: number; recorded: Array<{ name?: string; input?: { text?: string } }>; rescued: Array<{ name?: string; input?: { text?: string } }>; rescuedRunId: string } | null;
  sameAnswer: { callNo: number; runId: string; why: string } | null;
  failedWrite: { name: string; message: string; callNo: number } | null;
  probes: Array<{ callNo: number; rescued: boolean; passes: number; runs: Array<{ runId: string; passed: boolean }> }>;
  warnings: string[];
  fix: { title: string; opened: boolean } | null;
}

describe('shadowlap blame on a run that failed on a tool', () => {
  it('blames no model call for a write\'s error that every attempt meets again', async () => {
    const runId = await recordFailing(['--channel', '#refunds']);
    expect(outbox().map((e) => e.channel)).toEqual(['#refunds']);

    const r = await shadowlap(['blame', runId, '--json']);
    expect(r.code, r.out).toBe(0);
    const report = JSON.parse(r.stdout) as Report;
    expect(report).toMatchObject({ outcome: 'unrescuable', blamed: null, contrast: null, sameAnswer: null, failedWrite: { name: 'post_digest', message: 'channel_not_found: #refunds', callNo: 1 } });
    // One probe settles it: from the first model call, every attempt posts the same digest and fails.
    expect(report.probes.map((p) => [p.callNo, p.passes, p.rescued])).toEqual([[1, 0, false]]);
    // Each attempt's post was the recorded call, answered with its recorded error: none of them ran.
    expect(outbox()).toHaveLength(1);
    const posts = withStore((s) => report.probes[0]!.runs.flatMap((a) => s.getCalls(a.runId).filter((c) => c.name === 'post_digest').map((c) => [c.origin, c.end?.outcome])));
    expect(posts.length).toBe(report.probes[0]!.runs.length);
    expect(new Set(posts.map((p) => p.join(' ')))).toEqual(new Set(['replayed error']));
    // Every outcome is kept with a fix, and the run says no call was blamed.
    expect(report.fix).toMatchObject({ title: 'The agent exited with code 1', opened: true });
    expect(withStore((s) => s.getRun(runId)!.meta!.blame)).toMatchObject({ outcome: 'unrescuable', callNo: null, rescuedRunId: null });

    const shown = await shadowlap(['blame', runId]);
    expect(shown.code, shown.out).toBe(0);
    expect(shown.stdout).toContain('Not rescued from any model call');
    expect(shown.stdout).toContain("Every attempt from the first model call, #1, made post_digest's recorded call again and failed on its error, as the recording did: channel_not_found: #refunds.");
    expect(shown.stdout).toContain("No answer of the model's lost this run: look at the tools, the harness or the command.");
  });

  it('blames no model call when the attempts that passed answered it as the recording did', async () => {
    writeFileSync(join(work, 'refunds.down'), '');
    const runId = await recordFailing();
    // The service is back: after the fork the read runs live and succeeds, whatever the model answered.
    rmSync(join(work, 'refunds.down'));

    const r = await shadowlap(['blame', runId, '--json']);
    expect(r.code, r.out).toBe(0);
    const report = JSON.parse(r.stdout) as Report;
    expect(report).toMatchObject({ outcome: 'unrescuable', blamed: null, lost: null, contrast: null, failedWrite: null });
    expect(report.probes.map((p) => [p.callNo, p.rescued])).toEqual([[1, true]]);
    expect(report.sameAnswer).toEqual({
      callNo: 1,
      runId: report.probes[0]!.runs.find((a) => a.passed)!.runId,
      why: 'Every attempt that passed at #1 answered it as the recording did, so what made them pass came after that answer: a read that ran live, or a write that was stubbed.',
    });
    expect(withStore((s) => s.getRun(runId)!.meta!.blame)).toMatchObject({ outcome: 'unrescuable', callNo: null });
    // Nothing was posted: the digest after the fork was stubbed.
    expect(outbox()).toEqual([]);
  });

  it('warns when the fork that rescued the run got past a write that failed when it was recorded by a stub', async () => {
    varied = true;
    const runId = await recordFailing(['--channel', '#refunds']);
    const models = withStore((s) => s.getCalls(runId).filter((c) => c.kind === 'api').map((c) => c.callNo));
    expect(models).toEqual([1, 3]);

    const r = await shadowlap(['blame', runId, '--json']);
    expect(r.code, r.out).toBe(0);
    const report = JSON.parse(r.stdout) as Report;
    // Each digest is worded anew, so no post after a fork is the recorded one: each is stubbed, and passes.
    expect(report).toMatchObject({ outcome: 'blamed', blamed: { callNo: 3 }, sameAnswer: null, failedWrite: null });
    expect(report.contrast!.recorded.find((b) => b.name === 'post_digest')!.input!.text).not.toBe(report.contrast!.rescued.find((b) => b.name === 'post_digest')!.input!.text);
    expect(report.warnings).toContain("post_digest failed when the run was recorded (channel_not_found: #refunds), and the fork that rescued it had post_digest stubbed: a stub never fails, so the rescue may be the stub's, not the answer's");
    expect(outbox()).toHaveLength(1);
  });
});

describe('shadowlap repair on a run that failed on a tool', () => {
  const NOT_THE_ANSWER = "every attempt failed on post_digest's recorded error (channel_not_found: #refunds): no answer of the model's lost the run; look at the tools, the harness or the command";
  interface Repaired {
    outcome: string;
    why: string;
    targets: Array<{ runId: string; outcome: string; reused: boolean; note: string | null }>;
    holdout: string[];
    fixes: Array<{ fixId: string }>;
  }
  // Repair edits the agent's source, so it runs in a git repository.
  beforeEach(() => {
    execFileSync('git', ['init', '-q'], { cwd: work });
  });
  const repair = async (...fixes: string[]) => {
    const r = await shadowlap(['repair', '--fixes', ...fixes, '--repairer', 'anthropic', '--json']);
    expect(r.code, r.out).toBe(1);
    return JSON.parse(r.stdout) as Repaired;
  };

  it("says what blame found instead of suggesting a stronger model, from a blame of its own", async () => {
    const runId = await recordFailing(['--channel', '#refunds']);
    const report = await repair(runId);
    expect(report).toMatchObject({ outcome: 'no-diagnosis', why: NOT_THE_ANSWER, targets: [{ runId, outcome: 'unrescuable', reused: false }] });
    expect(report.why).not.toContain('--stronger');
  });

  it('says the same from the blame kept on the run, and leaves a run that passed out of the fix', async () => {
    // A digest that passed and one that failed, both labelled digest, and the failed one blamed: it opens the fix.
    const posted = await shadowlap(['run', '--', process.execPath, AGENT]);
    expect(posted.code, posted.out).toBe(0);
    const passed = /recording run (\w{26})/.exec(posted.out)![1]!;
    const failed = await recordFailing(['--channel', '#refunds']);
    for (const id of [passed, failed]) expect((await shadowlap(['label', id, 'digest'])).code).toBe(0);
    const blamed = JSON.parse((await shadowlap(['blame', failed, '--json'])).stdout) as Report & { fix: { fixId: string } };
    const fixId = blamed.fix.fixId;

    // label:digest brings the run that passed in; the older one is repaired, the other held out.
    const labelled = await repair('label:digest');
    expect(labelled).toMatchObject({ outcome: 'no-diagnosis', targets: [{ runId: passed, outcome: 'passes' }], holdout: [failed], fixes: [{ fixId }] });
    expect(labelled.why).toBe(`no failing run could be blamed: ${labelled.targets[0]!.note}`);
    expect(labelled.why).toContain(`${passed.slice(0, 10)} passes its oracle when replayed`);
    // The fix's failing runs are as they were: the one that passed is not one of them.
    const shown = JSON.parse((await shadowlap(['fix', 'show', fixId, '--json'])).stdout) as { failing: number; failingRuns: Array<{ runId: string }> };
    expect(shown.failingRuns.map((r) => r.runId)).toEqual([failed]);
    expect(shown.failing).toBe(1);

    // Its own failing run: the blame kept on it is used, with what it found.
    const before = mock.requests.length;
    const own = await repair(failed);
    expect(own).toMatchObject({ outcome: 'no-diagnosis', why: NOT_THE_ANSWER, targets: [{ runId: failed, outcome: 'unrescuable', reused: true }] });
    expect(mock.requests.length).toBe(before);
  });
});
