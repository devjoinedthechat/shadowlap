import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectHost, ProjectRegistry, projectDbPath, recordEvent, Store, type StoredCoverageGroup } from '@shadowlap/engine';
import { startDashboard, type Dashboard, type ProjectConfig } from '../src/index.js';
import { lineage } from '../src/api.js';
import { chaosOfGolden, chaosOfRun, chaosView, type ChaosMatrix, type ChaosView } from '../src/chaos.js';
import { coverageLook, coveragePackArgs, coverageView, type CoverageView } from '../src/coverage.js';
import { treeUse } from '../src/worktree.js';
import type { GoldenSource } from '../src/tests.js';

/**
 * Production coverage and error-path presets on the dashboard's server: the read models of what the
 * CLI kept in the store (the last coverage scan, every recording's presets), their routes, and the
 * job kinds whose command lines the server builds from what a page names.
 */

const T0 = 1_760_000_000_000;
let store: Store;
let project = '';
let dash: Dashboard;
const spawned: string[][] = [];
let golden = '';
let attempt = '';
let packRun = '';
let capture = '';
/** While set, every job the stand-in CLI runs lasts this long: a job still running when the next is asked for. */
let slowMs = 0;

const group = (o: Partial<StoredCoverageGroup>): StoredCoverageGroup => ({
  key: 'aaaa000011112222',
  scanId: 'S1',
  behaviour: { path: ['lookup_order', 'issue_refund', 'send_email'], writes: ['issue_refund', 'send_email'], unknown: [], outcome: 'answered' },
  runs: 2,
  runIds: ['NOT_ANY_MORE', 'C1'],
  sources: ['prod.har'],
  firstSeen: T0 - 5_000,
  lastSeen: T0 - 1_000,
  coveredBy: [],
  nearest: { golden: 'goldens/escalate', shared: 1, differs: { step: 2, seen: 'issue_refund', golden: 'escalate' } },
  command: { argv: ['node', 'agent.mjs', 'B-7'], from: 'REC1' },
  packed: null,
  ...o,
});

const api = (path: string, init: RequestInit = {}) => fetch(`${dash.url}/api/${path}`, { ...init, headers: { 'x-shadowlap-token': dash.token, ...(typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}) } });
const getJson = async <T>(path: string): Promise<T> => {
  const res = await api(path);
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as T;
};
const jobDone = async (id: string) => {
  for (let i = 0; i < 200; i++) {
    const res = await api(`jobs/${id}`);
    if (((await res.json()) as { done: boolean }).done) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`job ${id} never ended`);
};
/** Starts a job; one that started is waited for, so the next starts on goldens nothing else is using. */
/** The goldens the dashboard is given: the project's one, and any a test adds for a moment. */
const goldens: GoldenSource[] = [];

const startJob = async (body: unknown, o: { wait?: boolean } = {}) => {
  const res = await api('jobs', { method: 'POST', body: JSON.stringify(body) });
  if (res.status === 202 && o.wait !== false) await jobDone(((await res.clone().json()) as { id: string }).id);
  return res;
};

beforeAll(async () => {
  project = mkdtempSync(join(tmpdir(), 'sl-coverage-chaos-routes-'));
  store = Store.open(':memory:');
  // A capture the scan read, one imported after it, a golden's recording with presets run on it, and a pack's run.
  capture = store.createRun({ runId: 'C1', mode: 'record', command: { argv: ['<no-recorded-command>'], cwd: project }, startedAt: T0 - 1_000, meta: { covers: ['api'], imported: { at: T0 - 900, from: 'prod.har' } } }).runId;
  store.endRun(capture, 'completed', T0 - 999);
  const later = store.createRun({ mode: 'record', command: { argv: ['<no-recorded-command>'], cwd: project }, startedAt: T0 - 60_000, meta: { covers: ['api'], imported: { at: T0 + 10_000, from: 'week2.har' } } });
  store.endRun(later.runId, 'completed', T0 - 59_000);
  golden = store.createRun({ mode: 'replay', command: { argv: ['node', 'forecast.mjs'], cwd: project }, startedAt: T0 }).runId;
  store.endRun(golden, 'completed', T0 + 1);
  attempt = store.createRun({ mode: 'replay', parentRunId: golden, command: { argv: ['node', 'forecast.mjs'], cwd: project }, startedAt: T0 + 2, meta: { chaos: { preset: 'malformed', callNo: 3, session: 'X1', attempt: 1, golden: 'goldens/forecast' } } }).runId;
  store.endRun(attempt, 'failed', T0 + 3);
  packRun = store.createRun({ mode: 'record', command: { argv: ['node', 'theirs.mjs'], cwd: project }, startedAt: T0, meta: { imported: { at: T0, from: '/tmp/packs/theirs' } } }).runId;
  store.endRun(packRun, 'completed', T0 + 1);

  store.saveCoverageScan({ scanId: 'S1', at: T0, runs: 3, groups: 2, uncovered: 1, goldens: 1, actor: 'dana@example.com', data: { goldens: ['goldens/escalate'] } }, [group({}), group({ key: 'bbbb000011112222', behaviour: { path: ['lookup_order', 'escalate'], writes: ['escalate'], unknown: [], outcome: 'answered' }, runs: 1, runIds: ['C1'], coveredBy: ['goldens/escalate'], nearest: null, command: null })]);
  // The last --pack found the agent no longer does what production did: Keep it as a test may pack it as a golden that forks.
  store.saveCoveragePack({ key: 'aaaa000011112222', at: T0 - 500, golden: null, runId: null, from: 'C1', mode: null, reason: 'not-reproduced', why: 'node agent.mjs B-7 doesn\'t reproduce C1: diverged at call 1 (api POST /v1/messages), where the agent sends something else now', command: { argv: ['node', 'agent.mjs', 'B-7'], from: 'REC1' } });

  store.startChaosSession({ sessionId: 'X1', startedAt: T0 + 2, command: ['shadowlap', 'test', 'goldens/forecast', '--chaos'], presets: ['timeout', 'malformed', '429'] });
  store.addChaosResult({ sessionId: 'X1', runId: golden, golden: 'goldens/forecast', preset: '429', verdict: 'passed', callNo: 4, passes: 1, attempts: 1, at: T0 + 5, data: { target: { kind: 'api', name: 'POST /v1/messages' }, detail: 'model call #4 failed with HTTP 429: the agent exited 0', runs: [{ runId: 'A3', passed: true, exitCode: 0 }] } });
  store.addChaosResult({ sessionId: 'X1', runId: golden, golden: 'goldens/forecast', preset: 'malformed', verdict: 'failed', callNo: 3, passes: 0, attempts: 1, at: T0 + 4, data: { target: { kind: 'tool', name: 'get_forecast' }, detail: 'get_forecast (#3) answered malformed JSON: the agent exited with code 1', reason: 'the agent exited with code 1', runs: [{ runId: attempt, passed: false, exitCode: 1, lastLine: 'SyntaxError: x' }] } });
  store.addChaosResult({ sessionId: 'X1', runId: golden, golden: 'goldens/forecast', preset: 'timeout', verdict: 'not-applicable', callNo: null, at: T0 + 3, data: { detail: 'the recording makes no tool call' } });
  store.finishChaosSession('X1', { passed: 1, failed: 1, inconclusive: 0, upstreamRequests: 3, endedAt: T0 + 6 });

  recordEvent(store, { kind: 'coverage.scanned', ref: 'S1', at: T0, data: { runs: 3, groups: 2, uncovered: 1, goldens: 1, packed: 1, notPacked: 1 } });
  recordEvent(store, { kind: 'chaos.session', ref: 'X1', at: T0 + 6, data: { passed: 1, failed: 1, inconclusive: 0, notApplicable: 1, goldens: 1 } });
  recordEvent(store, { kind: 'chaos.session', ref: 'X2', runId: golden, at: T0 + 7, data: { passed: 2, failed: 0, inconclusive: 1, notApplicable: 0, goldens: 0, interrupted: true } });

  goldens.push({ path: 'goldens/forecast', runId: golden, packedAt: T0, mode: 'replay', repeat: 1, passes: 1, checks: [] });
  const spawnCli = (args: string[]) => {
    spawned.push(args);
    return spawn(process.execPath, ['-e', slowMs ? `setTimeout(() => {}, ${slowMs})` : ''], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
  };
  dash = await startDashboard({ store, spawnCli, project: { path: project }, goldens: () => goldens });
});

afterAll(async () => {
  await dash?.close();
  store?.close();
  if (project) rmSync(project, { recursive: true, force: true });
});

describe('production coverage', () => {
  it('serves the last scan: the behaviours no golden covers first, with what Pack one runs', async () => {
    const view = await getJson<CoverageView>('coverage');
    expect(view).toEqual(coverageView(store));
    expect(view.scan).toMatchObject({ scanId: 'S1', runs: 3, uncovered: 1, actor: 'dana@example.com' });
    // Imported after the scan: a scan now would read it.
    expect(view.newRuns).toBe(1);
    expect(view.uncovered).toBe(1);
    const [uncovered, covered] = view.groups;
    expect(uncovered).toMatchObject({
      covered: false,
      line: 'lookup_order → issue_refund → send_email · writes issue_refund, send_email · answered',
      ended: 'answered',
      // The scan's newest run was deleted since: the newest still here opens.
      runId: 'C1',
      pack: { key: 'aaaa000011112222', args: ['coverage', '--pack', 'aaaa000011112222'], command: ['node', 'agent.mjs', 'B-7'], commandFrom: 'REC1', forkable: true },
      // Why the last --pack didn't pack it, so the panel says so before it offers Pack one again.
      lastPack: { at: T0 - 500, golden: null, mode: null, reason: 'not-reproduced', why: expect.stringContaining("doesn't reproduce C1"), command: { argv: ['node', 'agent.mjs', 'B-7'], from: 'REC1' } },
    });
    expect(covered).toMatchObject({ covered: true, coveredBy: ['goldens/escalate'], pack: null, lastPack: null });
    // Needs a look's line, in its rows' shape: it opens the newest run of the behaviour still here, as no page lists them yet.
    expect(view.needsLook).toEqual({ kind: 'coverage', icon: 'rec', title: '1 behaviour seen in production has no golden', detail: 'the newest: lookup_order → issue_refund → send_email, in prod.har', action: 'Open', href: '#/run/C1', runId: 'C1', fixId: null, at: T0 });
    expect(coverageLook(store)).toEqual(view.needsLook);
    expect(view.commands).toEqual({ scan: ['coverage'], pack: ['coverage', '--pack'] });
  });

  it('says nothing before a scan, and nothing needs a look once every behaviour has a golden', () => {
    const empty = Store.open(':memory:');
    expect(coverageView(empty)).toEqual({ scan: null, newRuns: 0, groups: [], uncovered: 0, needsLook: null, commands: { scan: ['coverage'], pack: ['coverage', '--pack'] } });
    empty.saveCoverageScan({ scanId: 'S', at: 1, runs: 1, groups: 1, uncovered: 0, goldens: 1, actor: null, data: null }, [group({ coveredBy: ['goldens/a'], command: null })]);
    expect(coverageView(empty).needsLook).toBeNull();
    expect(coverageLook(empty)).toBeNull();
    empty.close();
  });

  it('builds the jobs that scan again and pack goldens, from a behaviour the scan has and the command as typed', async () => {
    expect((await startJob({ kind: 'coverage' })).status).toBe(202);
    expect(spawned.at(-1)).toEqual(['coverage']);
    // A command the person typed runs only once they confirmed it, as a recording's does: here, every time.
    const asked = await startJob({ kind: 'coverage-pack', key: 'aaaa0000', command: 'node agent.mjs "{message:/B-\\d+/}"' });
    expect(asked.status).toBe(409);
    expect(((await asked.json()) as { error: string }).error).toBe('Run this command in this folder? Packing starts your agent with it for each capture, offline, with writes stubbed: shadowlap coverage --pack aaaa000011112222 -- node agent.mjs {message:/B-\\d+/}. Confirm it first.');
    const res = await startJob({ kind: 'coverage-pack', key: 'aaaa0000', command: 'node agent.mjs "{message:/B-\\d+/}"', confirmed: true });
    expect(res.status, await res.clone().text()).toBe(202);
    expect(spawned.at(-1)).toEqual(['coverage', '--pack', 'aaaa000011112222', '--', 'node', 'agent.mjs', '{message:/B-\\d+/}']);
    // The command a run here says needs no confirming: it is the agent's own, recorded here.
    expect((await startJob({ kind: 'coverage-pack' })).status).toBe(202);
    expect(spawned.at(-1)).toEqual(['coverage', '--pack']);
    // Kept as the test that the change holds: a golden that forks, with the checks the dialog asked for.
    const fork = await startJob({ kind: 'coverage-pack', key: 'aaaa0000', fork: true, expect: { tools: { issue_refund: 0 } } });
    expect(fork.status, await fork.clone().text()).toBe(202);
    expect(spawned.at(-1)).toEqual(['coverage', '--pack', 'aaaa000011112222', '--fork', '--expect', '{"tools":{"issue_refund":0}}']);
    expect(coveragePackArgs(store, { key: 'aaaa0000', fork: true, expect: '{"tools":{"escalate":1}}' })).toMatchObject({ args: ['coverage', '--pack', 'aaaa000011112222', '--fork', '--expect', '{"tools":{"escalate":1}}'], title: 'Packing a golden that forks of aaaa0000' });
    for (const [body, error] of [
      [{ key: 'bbbb0000' }, 'behaviour bbbb000011112222 is covered already, by goldens/escalate'],
      [{ key: 'cccc0000' }, 'the last coverage scan has no behaviour cccc0000: scan again'],
      [{ key: '--online' }, 'key is a behaviour as the last coverage scan names it (16 hex characters)'],
      [{ key: 'aaaa0000', command: 'node "agent.mjs' }, 'command: a quote is not closed'],
      [{ key: 'aaaa0000', command: 7 }, "command is the agent's command line, as you'd type it"],
      [{ key: 'aaaa0000', command: 'sh -c "node agent.mjs {message}"' }, "command: sh runs its arguments as a script, and {message} is text from production: give the agent's own command, with {message} as one of its arguments"],
      [{ key: 'aaaa0000', command: 'node -e {message}' }, "command: {message} after -e would run as code: give the agent's own command, with {message} as one of its arguments"],
      [{ fork: true, expect: { tools: { issue_refund: 0 } } }, 'a golden that forks is packed for one behaviour: name it by its key'],
      [{ key: 'aaaa0000', fork: true }, 'a golden that forks needs the checks that say what the agent must do now, such as {"tools":{"issue_refund":0}}'],
      [{ key: 'aaaa0000', fork: true, expect: {} }, 'a golden that forks needs the checks that say what the agent must do now, such as {"tools":{"issue_refund":0}}'],
      [{ key: 'aaaa0000', expect: { tools: { issue_refund: 0 } } }, 'expect goes with fork: a golden that replays its capture is judged by the replay itself'],
      [{ key: 'aaaa0000', fork: 'yes' }, 'fork is true, to pack it as a golden that forks'],
    ] as const) {
      expect(coveragePackArgs(store, body)).toEqual({ error });
      const refused = await startJob({ kind: 'coverage-pack', ...body });
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { error: string }).error).toBe(error);
    }
  });

  it("waits for a job that replays or rewrites the goldens, and they wait for it", async () => {
    slowMs = 1500;
    try {
      const presets = await startJob({ kind: 'chaos', golden: 'goldens/forecast' }, { wait: false });
      expect(presets.status).toBe(202);
      const { id } = (await presets.json()) as { id: string };
      slowMs = 0;
      const pack = await startJob({ kind: 'coverage-pack' });
      expect(pack.status).toBe(409);
      expect(((await pack.json()) as { error: string }).error).toBe('A session of error-path presets is running: pack it once it is done');
      // The presets on a run touch no golden: they don't wait.
      expect((await startJob({ kind: 'chaos', runId: golden })).status).toBe(202);
      await jobDone(id);
      slowMs = 1500;
      const packing = await startJob({ kind: 'coverage-pack' }, { wait: false });
      expect(packing.status).toBe(202);
      const packId = ((await packing.json()) as { id: string }).id;
      slowMs = 0;
      const again = await startJob({ kind: 'chaos', golden: 'goldens/forecast' });
      expect(again.status).toBe(409);
      expect(((await again.json()) as { error: string }).error).toBe('A coverage pack is running: run its presets once it is done');
      await jobDone(packId);
    } finally {
      slowMs = 0;
    }
  });

  it('counts coverage --pack as running the agent from the working tree, and a scan as not', () => {
    expect(treeUse([['coverage', '--pack', 'aaaa']])).toMatchObject({ use: 'reads', verb: 'pack' });
    expect(treeUse([['coverage']])).toBeNull();
  });
});

describe('the activity feed', () => {
  it('words a coverage scan and a presets session', async () => {
    const page = await getJson<{ items: Array<{ kind: string; text: string; href?: string }> }>('activity?limit=10');
    expect(page.items.find((i) => i.text.startsWith('Coverage read'))).toMatchObject({ kind: 'test', text: 'Coverage read · 1 behaviour without a golden · 1 golden packed · 1 not packed', href: '#/tests' });
    expect(page.items.find((i) => i.text === 'Error-path presets ran · 1 passed, 1 failed')).toMatchObject({ kind: 'fail', href: '#/tests' });
    // A session on one run, stopped part way: it opens the run, in amber for its inconclusive preset.
    expect(page.items.find((i) => i.text === 'Error-path presets stopped · 2 passed, 0 failed, 1 inconclusive')).toMatchObject({ kind: 'warn', href: `#/run/${golden}` });
  });
});

describe('error-path presets', () => {
  it('serves every recording\'s matrix, preset by outcome in the presets\' order, and the sessions', async () => {
    const view = await getJson<ChaosView>('chaos');
    expect(view).toEqual(chaosView(store));
    expect(view.presets.map((p) => [p.preset, p.label, p.hits])).toEqual([
      ['timeout', 'tool timeout', 'tool'],
      ['empty', 'empty result', 'tool'],
      ['malformed', 'malformed JSON', 'tool'],
      ['oversized', 'oversized result', 'tool'],
      ['429', 'provider 429', 'model'],
      ['500', 'provider 500', 'model'],
    ]);
    expect(view.matrices).toHaveLength(1);
    const m = view.matrices[0];
    expect(m).toMatchObject({ runId: golden, golden: 'goldens/forecast', at: T0 + 5, counts: { passed: 1, failed: 1, inconclusive: 0, notApplicable: 1 } });
    expect(m.cells.map((c) => [c.preset, c.verdict])).toEqual([
      ['timeout', 'not-applicable'],
      ['malformed', 'failed'],
      ['429', 'passed'],
    ]);
    expect(m.cells[1]).toMatchObject({ label: 'malformed JSON', callNo: 3, target: { kind: 'tool', name: 'get_forecast' }, reason: 'the agent exited with code 1', runs: [{ runId: attempt, passed: false, exitCode: 1 }], sessionId: 'X1' });
    expect(view.sessions).toEqual([expect.objectContaining({ sessionId: 'X1', passed: 1, failed: 1, upstreamRequests: 3, endedAt: T0 + 6 })]);
  });

  it('opens a run\'s matrix: its own, or its recording\'s for one of the attempts', async () => {
    expect((await getJson<{ runId: string; matrix: ChaosMatrix | null }>(`chaos/runs/${golden}`)).matrix?.runId).toBe(golden);
    expect((await getJson<{ matrix: ChaosMatrix | null }>(`chaos/runs/${attempt}`)).matrix?.runId).toBe(golden);
    expect((await getJson<{ matrix: ChaosMatrix | null }>(`chaos/runs/${capture}`)).matrix).toBeNull();
    expect((await api('chaos/runs/NOPE')).status).toBe(404);
    expect(chaosOfRun(store, golden)).toEqual(chaosOfGolden(store, 'goldens/forecast'));
    expect(chaosOfGolden(store, 'goldens/other')).toBeNull();
  });

  it('never gives the CLI a golden whose path would read as one of its options', async () => {
    goldens.push({ path: '--update', runId: golden, packedAt: T0, mode: 'replay', repeat: 1, passes: 1, checks: [] });
    try {
      const before = spawned.length;
      const res = await startJob({ kind: 'chaos', golden: '--update' });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/^--update: its path starts with "-", which the CLI would read as an option/);
      expect(spawned.length).toBe(before);
    } finally {
      goldens.pop();
    }
  });

  it('keeps an attempt as the session that decided it, once a golden’s presets ran again', () => {
    const s = Store.open(':memory:');
    try {
      const rec = s.createRun({ mode: 'record', command: { argv: ['node', 'inbox.mjs'], cwd: project }, startedAt: T0 }).runId;
      s.endRun(rec, 'completed', T0 + 1);
      const attemptOf = (session: string, at: number, status: 'completed' | 'failed') => {
        const id = s.createRun({ mode: 'replay', parentRunId: rec, command: { argv: ['node', 'inbox.mjs'], cwd: project }, startedAt: at, meta: { chaos: { preset: 'timeout', callNo: 2, session, attempt: 1, golden: 'goldens/inbox' } } }).runId;
        s.endRun(id, status, at + 1);
        return id;
      };
      const presets = (session: string, at: number, runId: string, verdict: 'passed' | 'failed') => {
        s.startChaosSession({ sessionId: session, startedAt: at, command: ['shadowlap', 'test', 'goldens/inbox', '--chaos'], presets: ['timeout'] });
        const failed = verdict === 'failed';
        s.addChaosResult({ sessionId: session, runId: rec, golden: 'goldens/inbox', preset: 'timeout', verdict, callNo: 2, passes: failed ? 0 : 1, attempts: 1, at: at + 2, data: { target: { kind: 'tool', name: 'list_inbox' }, detail: `list_inbox (#2) timed out: the agent exited ${failed ? 'with code 1' : '0'}`, runs: [{ runId, verdict, passed: !failed, exitCode: failed ? 1 : 0, reason: failed ? 'the agent exited with code 1' : null, lastLine: 'TimeoutError: list_inbox timed out' }] } });
        s.finishChaosSession(session, { passed: failed ? 0 : 1, failed: failed ? 1 : 0, inconclusive: 0, upstreamRequests: 0, endedAt: at + 3 });
      };
      // A nightly run of the presets: the first failed, the second passed.
      const first = attemptOf('N1', T0 + 10, 'failed');
      presets('N1', T0 + 10, first, 'failed');
      const second = attemptOf('N2', T0 + 100, 'completed');
      presets('N2', T0 + 100, second, 'passed');
      // The recording's matrix is the newest session's.
      expect(chaosOfRun(s, rec)!.cells.map((c) => [c.sessionId, c.verdict])).toEqual([['N2', 'passed']]);
      // Each attempt opens on the session that decided it: the first stays failed, with why.
      expect(chaosOfRun(s, first)!.cells).toEqual([expect.objectContaining({ sessionId: 'N1', verdict: 'failed', runs: [{ runId: first, verdict: 'failed', passed: false, exitCode: 1, reason: 'the agent exited with code 1 (TimeoutError: list_inbox timed out)' }] })]);
      expect(chaosOfRun(s, second)!.cells).toEqual([expect.objectContaining({ sessionId: 'N2', verdict: 'passed', runs: [{ runId: second, verdict: 'passed', passed: true, exitCode: 0, reason: null }] })]);
      // The family marks each attempt by its own session's verdict, so the Forks view keeps the first failed.
      const family = new Map(lineage(s, rec)!.map((n) => [n.runId, n.preset]));
      expect(family.get(first)).toEqual({ label: 'tool timeout', verdict: 'failed' });
      expect(family.get(second)).toEqual({ label: 'tool timeout', verdict: 'passed' });
      expect(family.get(rec)).toBeUndefined();
      // An attempt whose mark names no session that kept it: found by the result that lists it.
      const lost = s.createRun({ mode: 'replay', parentRunId: rec, command: { argv: ['node', 'inbox.mjs'], cwd: project }, startedAt: T0 + 200, meta: { chaos: { preset: 'empty', callNo: 2, session: 'GONE', attempt: 1, golden: 'goldens/inbox' } } }).runId;
      s.endRun(lost, 'completed', T0 + 201);
      s.startChaosSession({ sessionId: 'N3', startedAt: T0 + 200, command: ['shadowlap', 'test', 'goldens/inbox', '--chaos'], presets: ['empty'] });
      s.addChaosResult({ sessionId: 'N3', runId: rec, golden: 'goldens/inbox', preset: 'empty', verdict: 'passed', callNo: 2, passes: 1, attempts: 1, at: T0 + 202, data: { detail: 'list_inbox (#2) answered with nothing: the agent exited 0', runs: [{ runId: lost, verdict: 'passed', passed: true, exitCode: 0 }] } });
      expect(chaosOfRun(s, lost)!.cells.map((c) => [c.sessionId, c.preset])).toEqual([['N3', 'empty']]);
      expect(lineage(s, rec)!.find((n) => n.runId === lost)!.preset).toEqual({ label: 'empty result', verdict: 'passed' });
    } finally {
      s.close();
    }
  });

  it('builds the chaos job for a golden on disk or a run, asking before a command someone else chose runs', async () => {
    expect((await startJob({ kind: 'chaos', golden: 'goldens/forecast', presets: ['429', 'timeout'], tool: 'get_forecast' })).status).toBe(202);
    expect(spawned.at(-1)).toEqual(['test', 'goldens/forecast', '--chaos', '--presets', 'timeout,429', '--chaos-tool', 'get_forecast']);
    expect((await startJob({ kind: 'chaos', runId: golden })).status).toBe(202);
    expect(spawned.at(-1)).toEqual(['replay', golden, '--chaos']);
    const asked = await startJob({ kind: 'chaos', runId: packRun });
    expect(asked.status).toBe(409);
    const question = (await asked.json()) as { error: string; confirm: string };
    expect(question.error).toBe(`This run came from an imported pack: each preset runs its command (node theirs.mjs), under shadowlap replay ${packRun} --chaos. Confirm to run it.`);
    // A bare true is no yes: the yes is the question's confirm, for the lines it named.
    expect((await startJob({ kind: 'chaos', runId: packRun, confirmed: true })).status).toBe(409);
    // The yes to one preset runs no other: the line it said yes to is that preset's.
    const one = (await (await startJob({ kind: 'chaos', runId: packRun, presets: ['429'] })).json()) as { error: string; confirm: string };
    expect(one.error).toMatch(/under shadowlap replay \S+ --chaos --presets 429\. Confirm to run it\.$/);
    expect(one.confirm).not.toBe(question.confirm);
    const before = spawned.length;
    expect((await startJob({ kind: 'chaos', runId: packRun, confirmed: one.confirm })).status).toBe(409);
    expect((await startJob({ kind: 'chaos', runId: packRun, presets: ['timeout'], confirmed: one.confirm })).status).toBe(409);
    expect(spawned).toHaveLength(before);
    expect((await startJob({ kind: 'chaos', runId: packRun, presets: ['429'], confirmed: one.confirm })).status).toBe(202);
    expect(spawned.at(-1)).toEqual(['replay', packRun, '--chaos', '--presets', '429', '--yes']);
    expect((await startJob({ kind: 'chaos', runId: packRun, confirmed: question.confirm })).status).toBe(202);
    expect(spawned.at(-1)).toEqual(['replay', packRun, '--chaos', '--yes']);
    for (const [body, error] of [
      [{ golden: 'goldens/none' }, 'no golden goldens/none on disk'],
      [{ runId: capture }, 'A capture has no command. Replay it with yours first; the presets run on that replay.'],
      [{ runId: 'NOPE' }, 'unknown run NOPE'],
      [{}, 'name a golden or a run'],
      [{ golden: 'goldens/forecast', presets: ['flood'] }, 'presets: unknown preset "flood" (expected timeout, empty, malformed, oversized, 429, 500, or all)'],
      [{ golden: 'goldens/forecast', tool: '--online x' }, 'tool is the name of a tool the recording calls'],
    ] as const) {
      const res = await startJob({ kind: 'chaos', ...body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(error);
    }
  });
});

describe('a dashboard over projects', () => {
  it('asks once for a command typed in a folder, and remembers it with the commands confirmed there', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sl-coverage-projects-'));
    const folder = join(home, 'support-agent');
    mkdirSync(folder, { recursive: true });
    const registry = new ProjectRegistry({ home, env: { SHADOWLAP_HOME: join(home, '.sl') }, actor: () => null });
    const own = Store.open(projectDbPath(folder));
    own.saveCoverageScan({ scanId: 'S1', at: T0, runs: 1, groups: 1, uncovered: 1, goldens: 0, actor: null, data: null }, [group({})]);
    own.close();
    const host = ProjectHost.open<ProjectConfig>(folder, { registry, loadConfig: () => ({ normalize: [], redact: [] }) });
    const ran: string[][] = [];
    const projectDash = await startDashboard({ projects: host, spawnCli: (args: string[]) => (ran.push(args), spawn(process.execPath, ['-e', ''], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] })) });
    const headers = { 'x-shadowlap-token': projectDash.token, 'content-type': 'application/json' };
    const post = async (body: unknown) => {
      const res = await fetch(`${projectDash.url}/api/jobs`, { method: 'POST', headers, body: JSON.stringify(body) });
      if (res.status !== 202) return res;
      const { id } = (await res.clone().json()) as { id: string };
      for (let i = 0; i < 200; i++) {
        const job = (await (await fetch(`${projectDash.url}/api/jobs/${id}`, { headers })).json()) as { done: boolean };
        if (job.done) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      return res;
    };
    try {
      const body = { kind: 'coverage-pack', key: 'aaaa0000', command: 'node agent.mjs {message}' };
      const first = await post(body);
      expect(first.status).toBe(409);
      expect(((await first.json()) as { error: string }).error).toContain('Run this command in this project’s folder?');
      expect((await post({ ...body, confirmed: true })).status).toBe(202);
      // Confirmed once it started: the same command runs there again without asking.
      for (let i = 0; i < 100 && !registry.list()[0]?.confirmed.length; i++) await new Promise((r) => setTimeout(r, 20));
      expect(registry.list()[0].confirmed.map((c) => c.argv)).toEqual([['node', 'agent.mjs', '{message}']]);
      expect((await post(body)).status).toBe(202);
      expect(ran.filter((a) => a[0] === 'coverage')).toHaveLength(2);
      // Another command asks again.
      expect((await post({ ...body, command: 'node agent.mjs B-7' })).status).toBe(409);
    } finally {
      await projectDash.close();
      host.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
