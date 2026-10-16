import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordBlame, Store, type StoredFix } from '@shadowlap/engine';
import { blameReport, EXPECT, makeRun } from '../../engine/test/fix-fixtures.js';
import { isGithubPr, parsePrState, PrStates, startDashboard, type Dashboard, type FixList, type PrRead } from '../src/index.js';

/**
 * A fix's pull request moves past "open" once the forge says so: read with gh in the background as
 * the Fixes pages are read, never making a page wait, and written to the store, which brings the
 * pages up to date. A read-only dashboard asks no one.
 */

const PR = 'https://github.com/acme/support-agent/pull/138';

function fixWithPr(store: Store, url: string, state: 'open' | 'merged' | 'closed' = 'open'): StoredFix {
  const run = makeRun(store);
  const { fix } = recordBlame(store, { runId: run, report: blameReport(run), expect: EXPECT, scope: null, command: 'shadowlap blame', title: 'issue_refund called with amount 240', checkText: 'issue_refund never called with {"amount":240}', ci: 'github' });
  store.mergeFixData(fix.fixId, { source: { pr: { url, number: 138, state } } });
  return store.getFix(fix.fixId)!;
}

describe('reading a pull request’s state', () => {
  it('reads GitHub pull requests by their address, and gh’s answer', () => {
    expect(isGithubPr(PR)).toBe(true);
    expect(isGithubPr('https://ghe.example.com:8443/acme/agent/pull/7')).toBe(true);
    for (const no of ['https://gitlab.com/acme/agent/-/merge_requests/7', 'http://github.com/acme/agent/pull/7', '--repo=x', 'https://github.com/acme/agent/pull/7; rm -rf /', 42]) expect(isGithubPr(no)).toBe(false);
    expect(parsePrState('{"state":"MERGED"}')).toBe('merged');
    expect(parsePrState('{"state":"CLOSED"}\n')).toBe('closed');
    expect(parsePrState('{"state":"OPEN"}')).toBe('open');
    expect(parsePrState('{"state":"DRAFT"}')).toBeNull();
    expect(parsePrState('not json')).toBeNull();
  });

  it('asks about open GitHub pull requests not asked about lately, a few at a time, and writes what changed', () => {
    const store = Store.open(':memory:');
    const open = fixWithPr(store, PR);
    const other = fixWithPr(store, 'https://github.com/acme/support-agent/pull/139');
    const third = fixWithPr(store, 'https://github.com/acme/support-agent/pull/140');
    const merged = fixWithPr(store, 'https://github.com/acme/support-agent/pull/141', 'merged');
    const gitlab = fixWithPr(store, 'https://gitlab.com/acme/agent/-/merge_requests/7');
    let now = 1_000;
    const asked: Array<{ url: string; done: (r: PrRead) => void }> = [];
    const written: Array<[string, string]> = [];
    const prs = new PrStates({ read: (url, done) => asked.push({ url, done }), write: (id, state) => written.push([id, state]), now: () => now, parallel: 2, everyMs: 60_000 });
    prs.refresh([open, other, third, merged, gitlab]);
    // Two at once; a merged one and another forge's are never asked about.
    expect(asked.map((a) => a.url)).toEqual([PR, 'https://github.com/acme/support-agent/pull/139']);
    asked[0]!.done({ state: 'merged' });
    asked[1]!.done({ state: 'open' });
    // Only a state that moved is written.
    expect(written).toEqual([[open.fixId, 'merged']]);
    // Read again soon after: only the one not asked yet.
    prs.refresh([open, other, third]);
    expect(asked.map((a) => a.url).slice(2)).toEqual(['https://github.com/acme/support-agent/pull/140']);
    asked[2]!.done({ state: 'closed' });
    expect(written.at(-1)).toEqual([third.fixId, 'closed']);
    // Once the answer is old, it is asked about again.
    now += 61_000;
    prs.refresh([other]);
    expect(asked.at(-1)!.url).toBe('https://github.com/acme/support-agent/pull/139');
    store.close();
  });

  it('stops asking for a while once gh turns out missing or signed out, and never throws', () => {
    const store = Store.open(':memory:');
    const fix = fixWithPr(store, PR);
    let now = 0;
    let asks = 0;
    const prs = new PrStates({
      read: (_url, done) => {
        asks++;
        done({ state: null, unusable: true });
      },
      write: () => {
        throw new Error('the store is closing');
      },
      now: () => now,
      everyMs: 10,
      pauseMs: 1_000,
    });
    prs.refresh([fix]);
    now += 100;
    prs.refresh([fix]);
    expect(asks).toBe(1);
    now += 1_000;
    prs.refresh([fix]);
    expect(asks).toBe(2);
    // A write that fails leaves the next read to ask again.
    const failing = new PrStates({ read: (_url, done) => done({ state: 'merged' }), write: () => { throw new Error('gone'); }, now: () => now });
    expect(() => failing.refresh([fix])).not.toThrow();
    store.close();
  });
});

// The stand-in for gh is a shell script, which Windows won't run by name.
describe.skipIf(process.platform === 'win32')('a fix’s pull request on the dashboard', () => {
  let bin: string;
  let path: string | undefined;
  let store: Store;
  let dash: Dashboard;
  let readOnly: Dashboard;
  let fixId: string;

  beforeAll(async () => {
    // gh that says the pull request was merged, after a moment, and notes each time it is asked.
    bin = mkdtempSync(join(tmpdir(), 'sl-pr-gh-'));
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$@" >> "${join(bin, 'asked')}"\nsleep 0.3\necho '{"state":"MERGED"}'\n`);
    chmodSync(join(bin, 'gh'), 0o755);
    path = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
    store = Store.open(':memory:');
    fixId = fixWithPr(store, PR).fixId;
    readOnly = await startDashboard({ store, readOnly: true });
    dash = await startDashboard({ store, readOnly: false });
  });

  afterAll(async () => {
    await dash?.close();
    await readOnly?.close();
    store?.close();
    process.env.PATH = path;
    rmSync(bin, { recursive: true, force: true });
  });

  const fixes = async (d: Dashboard) => {
    const res = await fetch(`${d.url}/api/fixes`, { headers: { 'x-shadowlap-token': d.token } });
    expect(res.status).toBe(200);
    return (await res.json()) as FixList;
  };

  it('asks no one from a read-only dashboard', async () => {
    expect((await fixes(readOnly)).fixes[0]!.source).toBe('from CI · PR #138');
    await new Promise((r) => setTimeout(r, 500));
    expect(existsSync(join(bin, 'asked'))).toBe(false);
  });

  it('answers at once, then shows the pull request merged once gh says so', async () => {
    const started = Date.now();
    expect((await fixes(dash)).fixes[0]!.source).toBe('from CI · PR #138');
    // gh takes its time; the page didn't wait for it.
    expect(Date.now() - started).toBeLessThan(300);
    for (let i = 0; i < 100 && store.getFix(fixId)!.data.source?.pr?.state !== 'merged'; i++) await new Promise((r) => setTimeout(r, 50));
    expect(store.getFix(fixId)!.data.source?.pr).toMatchObject({ url: PR, number: 138, state: 'merged' });
    expect((await fixes(dash)).fixes[0]!.source).toBe('from CI · PR #138 merged');
    expect(readFileSync(join(bin, 'asked'), 'utf8').split('\n').filter(Boolean)).toEqual(['pr', 'view', PR, '--json', 'state']);
    // Merged is where it stays: nobody asks again.
    await fixes(dash);
    await new Promise((r) => setTimeout(r, 400));
    expect(readFileSync(join(bin, 'asked'), 'utf8').split('\n').filter(Boolean)).toHaveLength(5);
  });
});
