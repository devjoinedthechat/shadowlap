import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { startDashboard, type Dashboard } from '../src/index.js';
import { bisectBlocked, bisectCopy } from '../ui/run/offers.js';
import type { BisectOffer } from '../ui/types.js';
import { blameOf } from './read-model-store.js';

/**
 * Find the commit on a run blame found failing though it exited 0, from the server's offers to the
 * command the run page's dialog shows. Such a run kept no failed check of its own: bisect can only
 * judge each replay by the check blame found it failing (the fix's), as `--expect … --fork`. The tests
 * read model gives that check (`BisectChoices.expect`), so the dialog offers the commits this checkout
 * has, each by its subject, and the command carries the check.
 */

const T0 = Date.UTC(2026, 9, 1, 10, 0);
const CHECK = { tools: { issue_refund: { count: 0, args: { amount: 240 } } } };

let repo: string;
let first: string;
let second: string;
let store: Store;
let dash: Dashboard;
let blamed: string;
let atFirst: string;

const getJson = async <T>(path: string): Promise<T> => {
  const res = await fetch(`${dash.url}/api/${path}`, { headers: { 'x-shadowlap-token': dash.token } });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as T;
};

beforeAll(async () => {
  repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'sl-find-commit-')));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=dana@northwind.example', '-c', 'user.name=Dana', '-c', 'commit.gpgsign=false', ...args], { cwd: repo }).toString().trim();
  git('init', '-q', '.');
  writeFileSync(join(repo, 'policy.txt'), 'refunds above 100 need approval\n');
  git('add', '-A');
  git('commit', '-qm', 'Add the refund limit');
  first = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'policy.txt'), 'refunds need no approval\n');
  git('commit', '-qam', 'Drop the approval step');
  second = git('rev-parse', 'HEAD');

  store = Store.open(':memory:');
  const run = (codeVersion: string, at: number) => {
    const r = store.createRun({ mode: 'record', command: { argv: ['node', 'refund_agent.mjs', 'T-8813'], cwd: repo }, codeVersion, startedAt: at });
    store.endRun(r.runId, 'completed', at + 1000);
    return r.runId;
  };
  run(first, T0 - 86_400_000);
  // Exited 0, and blame confirmed it fails the check it was given: the fix's.
  blamed = run(second, T0);
  store.updateRunMeta(blamed, { blame: blameOf(3, null, T0 + 2000) });
  store.insertFix({
    fixId: 'fx-01K4ZZFIND000000000000000',
    title: 'Refunds above the limit issued without approval',
    labels: [],
    check: { expect: CHECK, key: 'check:find', oracle: ['issue_refund never called with {"amount":240}'], text: 'issue_refund never called with {"amount":240}' },
    status: 'open',
    openedAt: T0 + 2000,
    verifiedAt: null,
    appliedAt: null,
    data: {},
  });
  store.addFixLink('fx-01K4ZZFIND000000000000000', 'failing', blamed, T0 + 2000);
  // Another agent, which exited 1 at the repository's first commit.
  atFirst = store.createRun({ mode: 'record', command: { argv: ['node', 'digest.mjs'], cwd: repo }, codeVersion: first, startedAt: T0 - 3_600_000 }).runId;
  store.endRun(atFirst, 'failed', T0 - 3_590_000);
  dash = await startDashboard({ store, readOnly: false, project: { path: repo } });
});

afterAll(async () => {
  await dash?.close();
  store?.close();
  rmSync(repo, { recursive: true, force: true });
});

describe('Find the commit on a run blame found failing though it exited 0', () => {
  it('is searched by the check it fails, from the commits this checkout has', async () => {
    const offer = (await getJson<{ bisect: BisectOffer }>(`runs/${blamed}/offers`)).bisect;
    // The tests read model gives the check: the dialog offers this checkout's commits by subject,
    // and its command judges each replay by the check, forked from where the requests differ.
    expect(offer).toMatchObject({ target: { kind: 'run', runId: blamed }, failed: true, fork: true, bad: second, unavailable: null, expect: CHECK });
    expect(offer.revisions).toEqual([expect.objectContaining({ rev: first, subject: 'Add the refund limit' })]);
    const copy = bisectCopy(blamed, offer);
    expect(copy.choices[0]).toEqual({ value: first, label: `${first} · Add the refund limit` });
    expect(copy.command(first)).toBe(`shadowlap bisect ${blamed.slice(0, 10)} --good ${first} --bad ${second} --expect '${JSON.stringify(CHECK)}' --fork`);
    // Replayed with --fork, one live replay decides each commit, which a failure that comes and goes can pass.
    expect(copy.text).toBe(`Replays the run at commits between a good one and ${second}, halving each time, and names the first where it fails. One live replay decides each commit, from where its requests differ: it costs tokens, and a failure that doesn’t happen every time can pass at a commit that has it.`);
  });
});

describe('Find the commit on a run that failed at the first commit', () => {
  it('offers no search, and says there is nothing before it', async () => {
    const offer = (await getJson<{ bisect: BisectOffer & { first?: boolean } }>(`runs/${atFirst}/offers`)).bisect;
    const why = `${atFirst.slice(0, 10)} failed at the first commit, ${first}: there is nothing before it to search`;
    expect(offer).toMatchObject({ failed: true, bad: first, good: null, args: null, first: true, unavailable: why });
    // The fork menu's item is off, and says why on hover and when the palette asks for it.
    expect(bisectBlocked(atFirst, offer, true)).toBe(why);
  });
});
