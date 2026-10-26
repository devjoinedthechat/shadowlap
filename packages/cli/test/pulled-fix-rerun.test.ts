import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { quoteArgv, Store } from '@shadowlap/engine';
import { cliSpawner, startDashboard, type Dashboard, type JobView } from '@shadowlap/dashboard';
import { applyFixDoc, parseFixDoc } from '@shadowlap/remote';

/**
 * A fix document a pull brings from the team store is someone else's data. Its verdict's and its
 * blame's command lines, and the flags kept beside them, may carry a command of their own: after
 * `--`, in `--build`, or a commit for `--base`. Run more attempts and Blame again, from the
 * dashboard and through the real CLI, run neither: their arguments are made here from the records'
 * checked fields, and they run only once the user says yes to that exact command line. Every
 * command planted here would leave a file behind if it ran; none may.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const C = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const id26 = (seed: number) => Array.from({ length: 26 }, (_, i) => C[(seed * 7 + i * 13) % 32]).join('');
const STORE = 's3://team-bucket/project';

let project: string;
let store: Store;
let dash: Dashboard | null = null;
const spawned: string[][] = [];
const telemetry = process.env.SHADOWLAP_TELEMETRY;

beforeEach(() => {
  project = realpathSync(mkdtempSync(join(tmpdir(), 'sl-pulled-fix-')));
  store = Store.open(join(project, 'store.db'));
  spawned.length = 0;
  process.env.SHADOWLAP_TELEMETRY = '0';
});
afterEach(async () => {
  await dash?.close();
  dash = null;
  store.close();
  rmSync(project, { recursive: true, force: true });
  if (telemetry === undefined) delete process.env.SHADOWLAP_TELEMETRY;
  else process.env.SHADOWLAP_TELEMETRY = telemetry;
});

/** A command that leaves `name` in the project when it runs: what a planted one would do. */
const leaves = (name: string) => [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(join(project, name))}, 'ran')`];
const MARKERS = ['tail', 'build', 'rerun-build', 'rerun-command', 'blame-tail', 'blame-command'];

const footprint = { inputTokens: 0, outputTokens: 0, cost: null };

/** A teammate's fix as the bucket holds it: an incomplete verdict and a stopped blame, each planting commands. */
function pulledDoc(run: string) {
  const fixId = `fx-${id26(1)}`;
  const verifyId = `vf-${id26(2)}`;
  const blameId = `bl-${id26(4)}`;
  const doc = {
    format: 'shadowlap-store-fix',
    version: 1,
    fix: { fixId, title: 'Refunds above the limit', labels: [], check: { expect: null, key: 'check:exit', oracle: ['the agent exits 0'], text: 'the agent exits 0' }, status: 'open', openedAt: 1, verifiedAt: null, appliedAt: null, data: {} },
    links: [
      { kind: 'failing', ref: run, at: 1, data: null },
      { kind: 'blame', ref: blameId, at: 2, data: null },
      { kind: 'verify', ref: verifyId, at: 3, data: null },
    ],
    blames: [
      {
        blameId,
        runId: run,
        at: 2,
        outcome: 'stopped',
        expect: null,
        scope: null,
        command: `shadowlap blame ${run} -- ${quoteArgv(leaves('blame-tail'))}`,
        rerun: { flags: [], command: leaves('blame-command') },
        report: { outcome: 'stopped', blamed: null, lost: null, probes: [], nonMonotone: [], confidence: 'low', runId: run, steps: 1, attemptsPerProbe: 1, needed: 1, gate: null, rescue: { fields: {} }, oracle: ['the agent exits 0'], recordedFailures: [], contrast: null, attempts: 0, spent: 0, upstreamRequests: 0, unknownModels: [], stopReason: 'the budget of $0.01 is spent', warnings: [] },
      },
    ],
    verdicts: [
      {
        verifyId,
        at: 3,
        verdict: 'incomplete',
        repairId: null,
        candidate: null,
        expect: null,
        command: `shadowlap verify --fixes ${run} --build ${quoteArgv([quoteArgv(leaves('build'))])} -- ${quoteArgv(leaves('tail'))}`,
        rerun: { flags: ['--build', quoteArgv(leaves('rerun-build')), '--base', 'HEAD', '--writes', 'block'], command: leaves('rerun-command') },
        report: {
          verdict: 'incomplete',
          reasons: [],
          warnings: [],
          runs: [{ runId: run, role: 'target', attempts: [], passes: 0, deterministic: false, verdict: 'open', decision: 'continue', gate: null, recorded: { passed: false, failures: [], footprint } }],
          attemptsPerRun: 1,
          needed: 1,
          gate: null,
          oracle: ['the agent exits 0'],
          fields: {},
          codeVersion: null,
          attempts: 0,
          spent: 0,
          upstreamRequests: 0,
          unknownModels: [],
          stopReason: 'the budget of $0.01 is spent',
          replayWarnings: [],
        },
      },
    ],
    repairs: [],
  };
  return { doc, fixId, verifyId, blameId };
}

async function start(): Promise<Dashboard> {
  const real = cliSpawner({ command: [process.execPath, CLI], dbPath: join(project, 'store.db'), cwd: project });
  dash = await startDashboard({
    store,
    project: { path: project },
    spawnCli: (args, o) => {
      spawned.push(args);
      return real(args, o);
    },
  });
  return dash;
}

const api = (path: string, init: RequestInit = {}) => fetch(`${dash!.url}/api/${path}`, { ...init, headers: { 'x-shadowlap-token': dash!.token, origin: dash!.url, ...(typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}) } });
const job = (body: Record<string, unknown>) => api('jobs', { method: 'POST', body: JSON.stringify(body) });

async function finished(j: JobView): Promise<JobView> {
  for (let i = 0; i < 600; i++) {
    const view = (await (await api(`jobs/${j.id}`)).json()) as JobView;
    if (view.done) return view;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`job ${j.id} did not end`);
}

describe('a fix pulled from the team store', () => {
  it('runs more attempts and blames again from checked fields only, after a yes to the exact command, and never runs what the document planted', async () => {
    // A run recorded here, whose command ends at once: verify and blame run it, not the document's.
    const run = id26(3);
    store.createRun({ runId: run, mode: 'record', parentRunId: null, command: { argv: [process.execPath, '-e', ''], cwd: project }, startedAt: 1000, meta: {} });
    store.endRun(run, 'failed');
    const { doc, fixId, verifyId, blameId } = pulledDoc(run);
    // What a pull does with a document it lists in the bucket.
    applyFixDoc(store, parseFixDoc(Buffer.from(JSON.stringify(doc)), fixId), { from: STORE, at: 5 });
    expect(store.getVerdict(verifyId)!.pulled).toEqual({ from: STORE, at: 5 });
    expect(store.getBlame(blameId)!.pulled).toEqual({ from: STORE, at: 5 });

    await start();
    const detail = (await (await api(`fixes/${fixId}`)).json()) as { verify: Array<{ command: string; pulled: unknown; more: { argv: string[]; command: string; left: string[] } | null }>; actions: { blameAgain: { argv: string[]; left: string[] } | null }; blame: { command: string } };
    const more = detail.verify[0].more!;
    expect(more.argv).toEqual(['verify', '--fixes', run, '--attempts', '1', '--passes', '1', '--writes', 'block']);
    expect(more.left).toEqual(['--build', '--base', '--']);
    // The page offers the teammate's command line to copy nowhere: the command shown is the one made here.
    expect(detail.verify[0].command).toBe(more.command);
    expect(detail.blame.command).toBe(`shadowlap blame ${run} --attempts 1 --passes 1`);
    expect(detail.actions.blameAgain!.argv).toEqual(['blame', run, '--attempts', '1', '--passes', '1']);

    // Asked first, with the exact command line it runs; nothing runs before the yes.
    const asked = await job({ kind: 'verify', fixId, verifyId });
    expect(asked.status).toBe(409);
    const { error: why, confirm: verifyYes } = (await asked.json()) as { error: string; confirm: string };
    expect(why).toContain(`came from the team store: this runs the command shadowlap verify --fixes ${run} --attempts 1 --passes 1 --writes block, made here from its own fields, without the --build, --base and command after -- it ran with there`);
    expect(why).not.toMatch(/writeFileSync/);
    const again = await job({ kind: 'blame', fixId, again: true });
    expect(again.status).toBe(409);
    const blameQuestion = (await again.json()) as { error: string; confirm: string };
    expect(blameQuestion.error).toContain(`came from the team store: this runs the command shadowlap blame ${run} --attempts 1 --passes 1, made here from its own fields, without the command after -- it ran with there`);
    // A yes is to the line its question named: a bare one, or the verify's, says yes to no blame.
    for (const yes of [true, verifyYes]) expect((await job({ kind: 'blame', fixId, again: true, yes })).status).toBe(409);
    expect(spawned).toEqual([]);

    // Blame again first: a verify that passes the run verifies the fix, which then has nothing to blame again.
    const blamed = await job({ kind: 'blame', fixId, again: true, yes: blameQuestion.confirm });
    expect(blamed.status, await blamed.clone().text()).toBe(202);
    await finished((await blamed.json()) as JobView);
    const more1 = await job({ kind: 'verify', fixId, verifyId, yes: verifyYes });
    expect(more1.status, await more1.clone().text()).toBe(202);
    await finished((await more1.json()) as JobView);

    expect(spawned).toEqual([
      ['blame', run, '--attempts', '1', '--passes', '1', '--yes'],
      ['verify', '--fixes', run, '--attempts', '1', '--passes', '1', '--writes', 'block', '--yes'],
    ]);
    for (const m of MARKERS) expect(existsSync(join(project, m)), `${m} ran`).toBe(false);
  }, 60_000);
});
