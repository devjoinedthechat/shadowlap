import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emptyCounts, fieldValue, NO_TOKENS, packRun, Store, unpackRun, type DecisionRun } from '@shadowlap/engine';
import { DONE, LOOKUP, POLICY, REFUND, recordRun } from '../../engine/test/training-fixtures.js';
import { decisionsArgv } from '../src/decisions-argv.js';
import { decisionsJob, decisionsReadJob, migrateJob, verifyFlaggedJob } from '../src/decisions.js';
import { injectionJob } from '../src/injection.js';
import { startDashboard, type Dashboard } from '../src/index.js';
import type { GoldenSource } from '../src/tests.js';

/**
 * A dashboard job that runs a golden's recorded command, and passes the CLI --yes so it asks nothing
 * itself (decisions with the working tree's prompt or a verify, migrate, verifying what a session
 * flagged, an injection test), asks first of a golden from a pack the repository doesn't track that
 * this machine didn't record, as `shadowlap test` asks of one: the yes is to the command it names.
 * A job with nothing to ask passes no --yes, whatever the request sent.
 */
let project = '';
let store: Store;
let mine = '';
let theirs = '';
let goldens: GoldenSource[] = [];

const golden = (path: string, runId: string): GoldenSource => ({ path, runId, packedAt: 1, mode: 'replay', repeat: 1, passes: 1, checks: [] });
const asked = (r: unknown) => r as { error: string; status: number; confirm: string };
const args = (r: unknown) => (r as { args: string[] }).args;

beforeAll(() => {
  project = realpathSync(mkdtempSync(join(tmpdir(), 'sl-golden-consent-jobs-')));
  store = Store.open(':memory:');
  // A golden recorded here, and one someone else recorded and sent: neither added to a repository.
  mine = recordRun(store, [LOOKUP, POLICY, REFUND, DONE]).run.runId;
  packRun(store, mine, join(project, 'goldens', 'own'));
  const elsewhere = Store.open(':memory:');
  theirs = recordRun(elsewhere, [LOOKUP, POLICY, REFUND, DONE], { argv: ['node', 'their-agent.mjs'] }).run.runId;
  packRun(elsewhere, theirs, join(project, 'goldens', 'sent'));
  elsewhere.close();
  goldens = [golden('goldens/own', mine), golden('goldens/sent', theirs)];
});
afterAll(() => {
  store.close();
  rmSync(project, { recursive: true, force: true });
});

describe('the jobs that pass --yes', () => {
  it('builds a preview’s command with the helper its dialog shows it with, and refuses more runs than one preview takes in the bar’s words', () => {
    const req = { goldens: ['goldens/sent'], model: 'claude-sonnet-5-5', set: { max_tokens: 512, stop: 'END' }, from: ['claude-sonnet-4-5-20250929'], scope: 'billing', samples: 2 };
    const shown = decisionsArgv({ targets: ['goldens/sent'], model: 'claude-sonnet-5-5', set: [['max_tokens', fieldValue(512)], ['stop', fieldValue('END')]], from: ['claude-sonnet-4-5-20250929'], scope: 'billing', samples: 2 });
    expect(args(decisionsJob(req, store, goldens, project))).toEqual(shown);
    expect(shown).toEqual(['decisions', 'goldens/sent', '--model', 'claude-sonnet-5-5', '--set', 'max_tokens=512', '--set', 'stop=END', '--from', 'claude-sonnet-4-5-20250929', '--scope', 'billing', '--samples', '2']);
    expect(decisionsJob({ runs: Array.from({ length: 501 }, () => 'x'), model: 'claude-sonnet-5-5' }, store, goldens, project)).toEqual({ error: 'At most 500 runs are previewed at once: 501 are picked' });
  });

  it('ask before a decisions job runs a sent golden from the working tree, and pass --yes once the request says yes to it', () => {
    const req = { goldens: ['goldens/sent'], fromCode: true };
    const q = asked(decisionsJob(req, store, goldens, project));
    expect(q).toMatchObject({ status: 409, error: "goldens/sent is from a pack this repository doesn't track: this runs the command it was recorded with (node their-agent.mjs). Confirm it to run it", confirm: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(decisionsJob({ ...req, yes: true }, store, goldens, project)).toMatchObject({ status: 409 });
    expect(args(decisionsJob({ ...req, yes: q.confirm }, store, goldens, project)).at(-1)).toBe('--yes');
    // Asking the model again runs no agent: nothing to ask.
    expect(args(decisionsJob({ goldens: ['goldens/sent'], model: 'claude-sonnet-5-5' }, store, goldens, project))).toEqual(['decisions', 'goldens/sent', '--model', 'claude-sonnet-5-5']);
  });

  it('ask before the working tree’s read replays a sent golden offline, and pass --yes once the request says yes to it', () => {
    const q = asked(decisionsReadJob({ goldens: ['goldens/sent'] }, store, goldens, project));
    expect(q).toMatchObject({ status: 409, error: expect.stringMatching(/^goldens\/sent is from a pack this repository doesn't track: this runs the command it was recorded with \(node their-agent\.mjs\)/), confirm: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(decisionsReadJob({ goldens: ['goldens/sent'], yes: true }, store, goldens, project)).toMatchObject({ status: 409 });
    // The same yes covers the preview it reads for: both run the one command.
    expect(args(decisionsReadJob({ goldens: ['goldens/sent'], yes: q.confirm }, store, goldens, project))).toEqual(['decisions', 'goldens/sent', '--from-code', '--dry-run', '--yes']);
    expect(asked(decisionsJob({ goldens: ['goldens/sent'], fromCode: true }, store, goldens, project)).confirm).toBe(q.confirm);
    expect(args(decisionsReadJob({ goldens: ['goldens/own'], yes: 'f'.repeat(32) }, store, goldens, project))).toEqual(['decisions', 'goldens/own', '--from-code', '--dry-run']);
  });

  it('pass no --yes where nothing was asked: a golden recorded here runs as it is', () => {
    expect(args(decisionsJob({ goldens: ['goldens/own'], fromCode: true, yes: 'f'.repeat(32) }, store, goldens, project))).toEqual(['decisions', 'goldens/own', '--from-code']);
    expect(args(migrateJob({ to: 'claude-haiku-4-5', goldens: ['goldens/own'], yes: 'f'.repeat(32) }, store, goldens, project))).toEqual(['migrate', '--to', 'claude-haiku-4-5', 'goldens/own']);
  });

  it('ask before a migration of every golden runs the sent one', () => {
    const q = asked(migrateJob({ to: 'claude-haiku-4-5' }, store, goldens, project));
    expect(q).toMatchObject({ status: 409, error: expect.stringMatching(/^goldens\/sent is from a pack this repository doesn't track/) });
    expect(args(migrateJob({ to: 'claude-haiku-4-5', yes: q.confirm }, store, goldens, project))).toEqual(['migrate', '--to', 'claude-haiku-4-5', 'goldens/own', 'goldens/sent', '--yes']);
  });

  it('ask before verifying what a session flagged runs a sent golden', () => {
    const run = (runId: string, g: string): DecisionRun => ({ runId, golden: g, steps: 1, asked: 1, rank: 1, majority: 1, counts: emptyCounts(), cost: { before: 0, after: 0, spent: 0 }, tokens: { before: NO_TOKENS, after: NO_TOKENS }, thinkingStripped: 0, refused: null, decisions: [], warnings: [] });
    // The session asked the sent golden again from its pack, which brought it into the store, marked as a pack's.
    unpackRun(store, join(project, 'goldens', 'sent'));
    const sessionId = 'dc-01M5000000000000000000000C';
    const report = { decisionsId: sessionId, kind: 'decisions', at: 1, change: { model: 'claude-sonnet-5-5', fields: {}, fromCode: null, text: 'the model claude-sonnet-5-5' }, flagged: [mine, theirs], remedies: [], verify: null };
    store.putDecisionSession({ sessionId, kind: 'decisions', at: 1, change: 'the model claude-sonnet-5-5', actor: 'dev', revision: null, data: report, runs: [run(mine, 'goldens/own'), run(theirs, 'goldens/sent')].map((r) => ({ runId: r.runId, golden: r.golden, rank: r.rank, changed: 1, data: r as unknown as Record<string, unknown> })) });
    const q = asked(verifyFlaggedJob({ sessionId }, store, project));
    expect(q).toMatchObject({ status: 409, error: expect.stringMatching(/^goldens\/sent is from a pack this repository doesn't track: this runs the command it was recorded with \(node their-agent\.mjs\)/) });
    expect(args(verifyFlaggedJob({ sessionId, yes: q.confirm }, store, project))).toEqual(['decisions', '--verify', sessionId, '--yes']);
  });

  it('ask before an injection test runs a sent golden', () => {
    const b = { store, upload: () => null, project: { name: 'project', path: project } };
    const q = asked(injectionJob({ golden: 'goldens/sent' }, b, goldens));
    expect(q).toMatchObject({ status: 409, error: expect.stringMatching(/^goldens\/sent is from a pack this repository doesn't track/) });
    expect(args(injectionJob({ golden: 'goldens/sent', yes: q.confirm }, b, goldens))).toEqual(['injection', 'goldens/sent', '--json', '--yes']);
    expect(args(injectionJob({ golden: 'goldens/own', yes: 'f'.repeat(32) }, b, goldens))).toEqual(['injection', 'goldens/own', '--json']);
  });

  it('ask over HTTP, from the project the dashboard serves', async () => {
    const spawned: string[][] = [];
    const dash: Dashboard = await startDashboard({ store, project: { path: project }, goldens: () => goldens, spawnCli: (a: string[]) => (spawned.push(a), spawn(process.execPath, ['-e', ''], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] })) });
    try {
      const post = (body: unknown) => fetch(`${dash.url}/api/jobs`, { method: 'POST', headers: { 'x-shadowlap-token': dash.token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const res = await post({ kind: 'decisions', goldens: ['goldens/sent'], fromCode: true });
      expect(res.status).toBe(409);
      const { confirm } = (await res.json()) as { confirm: string };
      expect((await post({ kind: 'decisions', goldens: ['goldens/sent'], fromCode: true, yes: confirm })).status).toBe(202);
      expect(spawned.at(-1)).toEqual(['decisions', 'goldens/sent', '--from-code', '--yes']);
    } finally {
      await dash.close();
    }
  });

  it('ask nothing of a pack the repository tracks', () => {
    execFileSync('git', ['init', '-q'], { cwd: project, stdio: 'ignore' });
    execFileSync('git', ['add', '-f', '--', 'goldens/sent/run.json'], { cwd: project, stdio: 'ignore' });
    expect(args(decisionsJob({ goldens: ['goldens/sent'], fromCode: true }, store, goldens, project))).toEqual(['decisions', 'goldens/sent', '--from-code']);
  });
});
