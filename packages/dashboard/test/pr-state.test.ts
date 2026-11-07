import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordBlame, Store, type StoredFix } from '@shadowlap/engine';
import { blameReport, EXPECT, makeRun } from '../../engine/test/fix-fixtures.js';
import { execFileSync } from 'node:child_process';
import { ghEnv, isGithubPr, parsePrState, prHost, PrStates, readableHosts, remoteHost, startDashboard, type Dashboard, type FixesView, type PrRead } from '../src/index.js';

/**
 * A fix's pull request moves past "open" once the forge says so: read with gh in the background as
 * the Fixes pages are read, never making a page wait, and written to the store, which brings the
 * pages up to date. A read-only dashboard asks no one.
 */

const PR = 'https://github.com/acme/support-agent/pull/138';

/** A fix of its own for each title: another title is another check, which no fix joins. */
function fixWithPr(store: Store, url: string, state: 'open' | 'merged' | 'closed' = 'open', title = 'issue_refund called with amount 240'): StoredFix {
  const run = makeRun(store);
  const expect = title === 'issue_refund called with amount 240' ? EXPECT : { tools: { issue_refund: { count: 1 } } };
  const { fix } = recordBlame(store, { runId: run, report: blameReport(run), expect, scope: null, command: 'shadowlap blame', title, checkText: 'issue_refund never called with {"amount":240}', ci: 'github' });
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
    asked[0].done({ state: 'merged' });
    asked[1].done({ state: 'open' });
    // Only a state that moved is written.
    expect(written).toEqual([[open.fixId, 'merged']]);
    // Read again soon after: only the one not asked yet.
    prs.refresh([open, other, third]);
    expect(asked.map((a) => a.url).slice(2)).toEqual(['https://github.com/acme/support-agent/pull/140']);
    asked[2].done({ state: 'closed' });
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

  it('stops asking a host gh is signed out of, and every host once gh is missing', () => {
    const store = Store.open(':memory:');
    const onCom = fixWithPr(store, PR);
    const onOwn = fixWithPr(store, 'https://ghes.acme.example/acme/agent/pull/9', 'open', 'Refunds sent twice');
    let now = 0;
    const asked: string[] = [];
    let answer: PrRead = { state: null, unusable: true };
    const prs = new PrStates({ read: (url, done) => (asked.push(url), done(answer)), write: () => undefined, readable: () => true, now: () => now, everyMs: 10, pauseMs: 1_000 });
    // Signed out of the company's server: github.com is still asked.
    prs.refresh([onOwn]);
    now += 100;
    answer = { state: 'open' };
    prs.refresh([onOwn, onCom]);
    expect(asked).toEqual(['https://ghes.acme.example/acme/agent/pull/9', PR]);
    // gh is gone: nobody is asked until the pause is over.
    answer = { state: null, unusable: true, missing: true };
    now += 100;
    prs.refresh([onCom]);
    now += 100;
    prs.refresh([onCom, onOwn]);
    expect(asked).toHaveLength(3);
    now += 1_000;
    prs.refresh([onCom]);
    expect(asked).toHaveLength(4);
    store.close();
  });

  it('reads pull requests only on github.com and the project’s own GitHub hosts', async () => {
    const store = Store.open(':memory:');
    const planted = fixWithPr(store, 'https://evil.example/acme/agent/pull/1', 'open', 'Refunds sent twice');
    const asked: string[] = [];
    // A fix pulled from the team store can carry any address: one on another host is never handed to gh.
    const prs = new PrStates({ read: (url, done) => (asked.push(url), done({ state: 'open' })), write: () => undefined });
    prs.refresh([planted, fixWithPr(store, PR)]);
    expect(asked).toEqual([PR]);
    expect(prHost('https://GHES.acme.example:8443/acme/agent/pull/9')).toBe('ghes.acme.example');
    // The project's origin remote, and GH_HOST, name hosts of its own.
    const repo = mkdtempSync(join(tmpdir(), 'sl-pr-origin-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo });
      execFileSync('git', ['remote', 'add', 'origin', 'git@ghes.acme.example:acme/agent.git'], { cwd: repo });
      expect([...(await readableHosts(repo, {}))].sort()).toEqual(['ghes.acme.example', 'github.com']);
      expect([...(await readableHosts(null, { GH_HOST: 'https://other.example:8443' }))].sort()).toEqual(['github.com', 'other.example']);
      expect([...(await readableHosts(join(repo, 'missing'), {}))]).toEqual(['github.com']);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
    for (const [remote, host] of [
      ['https://github.com/acme/agent.git', 'github.com'],
      ['https://user:secret@GHES.acme.example:8443/acme/agent', 'ghes.acme.example'],
      ['ssh://git@ghes.acme.example:2222/acme/agent.git', 'ghes.acme.example'],
      ['git@github.com:acme/agent.git', 'github.com'],
      ['/srv/git/agent.git', null],
    ] as const) expect(remoteHost(remote), remote).toBe(host);
    store.close();
  });

  it('gives gh a token for a server of your own only for the host GH_HOST names', () => {
    // gh's tokens for a server of your own are named GH_…_TOKEN or GITHUB_…_TOKEN; github.com's are GH_TOKEN and GITHUB_TOKEN.
    const env = { PATH: '/bin', GH_TOKEN: 't', GITHUB_TOKEN: 't2', GH_SERVER_TOKEN: 's', GITHUB_SERVER_TOKEN: 's2', GH_HOST: 'ghes.acme.example' };
    expect(ghEnv(PR, env)).toEqual({ PATH: '/bin', GH_TOKEN: 't', GITHUB_TOKEN: 't2', GH_HOST: 'ghes.acme.example', GH_PROMPT_DISABLED: '1', NO_COLOR: '1' });
    expect(ghEnv('https://ghes.acme.example/acme/agent/pull/9', env)).toMatchObject({ GH_SERVER_TOKEN: 's', GITHUB_SERVER_TOKEN: 's2' });
    expect(ghEnv('https://ghes.acme.example/acme/agent/pull/9', { GH_SERVER_TOKEN: 's' })).not.toHaveProperty('GH_SERVER_TOKEN');
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
  let plantedId: string;

  beforeAll(async () => {
    // gh that says the pull request was merged, once a test lets it (or ten seconds on), and notes each
    // time it is asked.
    bin = mkdtempSync(join(tmpdir(), 'sl-pr-gh-'));
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$@" >> "${join(bin, 'asked')}"\nprintf '%s\\n' "\${GH_SERVER_TOKEN:-none}" >> "${join(bin, 'tokens')}"\ni=0\nwhile [ ! -e "${join(bin, 'answer')}" ] && [ $i -lt 200 ]; do sleep 0.05; i=$((i + 1)); done\necho '{"state":"MERGED"}'\n`);
    chmodSync(join(bin, 'gh'), 0o755);
    path = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
    store = Store.open(':memory:');
    fixId = fixWithPr(store, PR).fixId;
    // A fix a pull brought with an address on someone else's host.
    plantedId = fixWithPr(store, 'https://evil.example/acme/agent/pull/1', 'open', 'Refunds sent twice').fixId;
    // A token for a server of your own, which no pull request on github.com gets.
    process.env.GH_SERVER_TOKEN = 'server-token';
    readOnly = await startDashboard({ store, readOnly: true });
    dash = await startDashboard({ store, readOnly: false });
  });

  afterAll(async () => {
    await dash?.close();
    await readOnly?.close();
    store?.close();
    process.env.PATH = path;
    delete process.env.GH_SERVER_TOKEN;
    rmSync(bin, { recursive: true, force: true });
  });

  const fixes = async (d: Dashboard) => {
    const res = await fetch(`${d.url}/api/fixes`, { headers: { 'x-shadowlap-token': d.token } });
    expect(res.status).toBe(200);
    return (await res.json()) as FixesView;
  };

  const sourceOf = (list: FixesView, id: string) => list.fixes.find((f) => f.fixId === id)!.source;

  it('asks no one from a read-only dashboard', async () => {
    expect(sourceOf(await fixes(readOnly), fixId)).toBe('from CI · PR #138');
    await new Promise((r) => setTimeout(r, 500));
    expect(existsSync(join(bin, 'asked'))).toBe(false);
  });

  it('answers at once, then shows the pull request merged once gh says so', async () => {
    // gh answers only once this test lets it, after the page has: the page didn't wait for it.
    expect(sourceOf(await fixes(dash), fixId)).toBe('from CI · PR #138');
    writeFileSync(join(bin, 'answer'), '');
    for (let i = 0; i < 100 && store.getFix(fixId)!.data.source?.pr?.state !== 'merged'; i++) await new Promise((r) => setTimeout(r, 50));
    expect(store.getFix(fixId)!.data.source?.pr).toMatchObject({ url: PR, number: 138, state: 'merged' });
    expect(sourceOf(await fixes(dash), fixId)).toBe('from CI · PR #138 merged');
    // Still open: no verdict that counts for it holds, so it stays blamed, never merged, and under Open.
    expect((await fixes(dash)).fixes.find((f) => f.fixId === fixId)).toMatchObject({ rung: 'blamed', bucket: 'open', pr: { number: 138, state: 'merged' } });
    // Only github.com's was asked about, and without the server's token, which isn't for it.
    expect(readFileSync(join(bin, 'asked'), 'utf8').split('\n').filter(Boolean)).toEqual(['pr', 'view', PR, '--json', 'state']);
    expect(readFileSync(join(bin, 'tokens'), 'utf8').split('\n').filter(Boolean)).toEqual(['none']);
    expect(store.getFix(plantedId)!.data.source?.pr?.state).toBe('open');
    // Merged is where it stays: nobody asks again.
    await fixes(dash);
    await new Promise((r) => setTimeout(r, 400));
    expect(readFileSync(join(bin, 'asked'), 'utf8').split('\n').filter(Boolean)).toHaveLength(5);
  });
});
