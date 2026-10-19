import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store, type StoredCoverageGroup } from '@shadowlap/engine';
import { startDashboard, type Dashboard } from '../src/index.js';
import { chaosOfGolden, chaosOfRun, chaosView, type ChaosMatrix, type ChaosView } from '../src/chaos.js';
import { coveragePackArgs, coverageView, type CoverageView } from '../src/coverage.js';
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
const startJob = (body: unknown) => api('jobs', { method: 'POST', body: JSON.stringify(body) });

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

  store.startChaosSession({ sessionId: 'X1', startedAt: T0 + 2, command: ['shadowlap', 'test', 'goldens/forecast', '--chaos'], presets: ['timeout', 'malformed', '429'] });
  store.addChaosResult({ sessionId: 'X1', runId: golden, golden: 'goldens/forecast', preset: '429', verdict: 'passed', callNo: 4, passes: 1, attempts: 1, at: T0 + 5, data: { target: { kind: 'api', name: 'POST /v1/messages' }, detail: 'model call #4 failed with HTTP 429: the agent exited 0', runs: [{ runId: 'A3', passed: true, exitCode: 0 }] } });
  store.addChaosResult({ sessionId: 'X1', runId: golden, golden: 'goldens/forecast', preset: 'malformed', verdict: 'failed', callNo: 3, passes: 0, attempts: 1, at: T0 + 4, data: { target: { kind: 'tool', name: 'get_forecast' }, detail: 'get_forecast (#3) answered malformed JSON: the agent exited with code 1', reason: 'the agent exited with code 1', runs: [{ runId: attempt, passed: false, exitCode: 1, lastLine: 'SyntaxError: x' }] } });
  store.addChaosResult({ sessionId: 'X1', runId: golden, golden: 'goldens/forecast', preset: 'timeout', verdict: 'not-applicable', callNo: null, at: T0 + 3, data: { detail: 'the recording makes no tool call' } });
  store.finishChaosSession('X1', { passed: 1, failed: 1, inconclusive: 0, upstreamRequests: 3, endedAt: T0 + 6 });

  const goldens: GoldenSource[] = [{ path: 'goldens/forecast', runId: golden, packedAt: T0, mode: 'replay', repeat: 1, passes: 1, checks: [] }];
  const spawnCli = (args: string[]) => {
    spawned.push(args);
    return spawn(process.execPath, ['-e', ''], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
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
      pack: { key: 'aaaa000011112222', args: ['coverage', '--pack', 'aaaa000011112222'], command: ['node', 'agent.mjs', 'B-7'], commandFrom: 'REC1' },
    });
    expect(covered).toMatchObject({ covered: true, coveredBy: ['goldens/escalate'], pack: null });
    // Needs a look's line, in its rows' shape.
    expect(view.needsLook).toEqual({ kind: 'coverage', icon: 'rec', title: '1 behaviour seen in production has no golden', detail: 'the newest: lookup_order → issue_refund → send_email, in prod.har', action: 'Open', href: '#/tests', runId: 'C1', fixId: null, at: T0 });
    expect(view.commands).toEqual({ scan: ['coverage'], pack: ['coverage', '--pack'] });
  });

  it('says nothing before a scan, and nothing needs a look once every behaviour has a golden', () => {
    const empty = Store.open(':memory:');
    expect(coverageView(empty)).toEqual({ scan: null, newRuns: 0, groups: [], uncovered: 0, needsLook: null, commands: { scan: ['coverage'], pack: ['coverage', '--pack'] } });
    empty.saveCoverageScan({ scanId: 'S', at: 1, runs: 1, groups: 1, uncovered: 0, goldens: 1, actor: null, data: null }, [group({ coveredBy: ['goldens/a'], command: null })]);
    expect(coverageView(empty).needsLook).toBeNull();
    empty.close();
  });

  it('builds the jobs that scan again and pack goldens, from a behaviour the scan has and the command as typed', async () => {
    expect((await startJob({ kind: 'coverage' })).status).toBe(202);
    expect(spawned.at(-1)).toEqual(['coverage']);
    const res = await startJob({ kind: 'coverage-pack', key: 'aaaa0000', command: 'node agent.mjs "order B-7"' });
    expect(res.status, await res.clone().text()).toBe(202);
    expect(spawned.at(-1)).toEqual(['coverage', '--pack', 'aaaa000011112222', '--', 'node', 'agent.mjs', 'order B-7']);
    expect((await startJob({ kind: 'coverage-pack' })).status).toBe(202);
    expect(spawned.at(-1)).toEqual(['coverage', '--pack']);
    for (const [body, error] of [
      [{ key: 'bbbb0000' }, 'behaviour bbbb000011112222 is covered already, by goldens/escalate'],
      [{ key: 'cccc0000' }, 'the last coverage scan has no behaviour cccc0000: scan again'],
      [{ key: '--online' }, 'key is a behaviour as the last coverage scan names it (16 hex characters)'],
      [{ key: 'aaaa0000', command: 'node "agent.mjs' }, 'command: a quote is not closed'],
      [{ key: 'aaaa0000', command: 7 }, "command is the agent's command line, as you'd type it"],
    ] as const) {
      expect(coveragePackArgs(store, body)).toEqual({ error });
      const refused = await startJob({ kind: 'coverage-pack', ...body });
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { error: string }).error).toBe(error);
    }
  });

  it('counts coverage --pack as running the agent from the working tree, and a scan as not', () => {
    expect(treeUse([['coverage', '--pack', 'aaaa']])).toMatchObject({ use: 'reads', verb: 'pack' });
    expect(treeUse([['coverage']])).toBeNull();
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
    const m = view.matrices[0]!;
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

  it('builds the chaos job for a golden on disk or a run, asking before a command someone else chose runs', async () => {
    expect((await startJob({ kind: 'chaos', golden: 'goldens/forecast', presets: ['429', 'timeout'], tool: 'get_forecast' })).status).toBe(202);
    expect(spawned.at(-1)).toEqual(['test', 'goldens/forecast', '--chaos', '--presets', 'timeout,429', '--chaos-tool', 'get_forecast']);
    expect((await startJob({ kind: 'chaos', runId: golden })).status).toBe(202);
    expect(spawned.at(-1)).toEqual(['replay', golden, '--chaos']);
    const asked = await startJob({ kind: 'chaos', runId: packRun });
    expect(asked.status).toBe(409);
    expect(((await asked.json()) as { error: string }).error).toBe('This run came from an imported pack: each preset runs its command (node theirs.mjs). Confirm to run it.');
    expect((await startJob({ kind: 'chaos', runId: packRun, confirmed: true })).status).toBe(202);
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
