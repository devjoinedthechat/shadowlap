import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixRecords, recordBlame, recordRepair, Store, unpackRun, type RunMeta } from '@shadowlap/engine';
import { blameReport, EXPECT, repairReport } from '../../engine/test/fix-fixtures.js';
import { startFakeS3, type FakeS3 } from '../../remote/test/fakes/s3.js';
import { prepareTestPush, pushIfQueued, storeCheck, storeCi, storePolicy, storePushFromCi, storeSet, storeSetChecked, storeShow, TeamError, teamPull, teamPush, teamShare, type TeamEnv } from '../src/team.js';
import { lastCiSession, parseStoreUrl, storeKey } from '@shadowlap/remote';
import { loadConfig } from '../src/config.js';
import { testReport } from '../src/test-report.js';

/**
 * The team store, end to end in process: a project whose config names a bucket in an S3 that checks
 * every signature, and machines that push, pull and share through it, a pull request's CI job
 * among them. Nothing to add first: the store is free, and the bucket's access is the cloud's.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLI = join(ROOT, 'packages', 'cli', 'bin', 'shadowlap.js');
const GOLDEN = join(ROOT, 'testing', 'golden', 'reference-agent');
const KEY = 'AKIDTEAMEXAMPLE';
const SECRET = 'team/secret/key';
const DAY = 86_400_000;
const at = (iso: string) => Date.parse(`${iso}T12:00:00Z`);
/** The fake S3's clock, which checks a share link's expiry. */
let s3Now = at('2027-01-15');

let s3: FakeS3;
let work: string;
let uiDir: string;

beforeAll(async () => {
  // On the machines' clock: a share link signed on Jan 15, 2027 is checked against that day, not today.
  s3 = await startFakeS3({ keys: { [KEY]: SECRET }, bucket: 'northwind-agent-runs', versioning: 'Enabled', encryption: 'aws:kms', objectLock: { mode: 'GOVERNANCE', days: 30 }, now: () => s3Now });
  work = mkdtempSync(join(tmpdir(), 'sl-team-'));
  uiDir = join(work, 'ui');
  mkdirSync(join(uiDir, 'assets', 'fonts'), { recursive: true });
  writeFileSync(join(uiDir, 'assets', 'app.css'), '.app{}\n');
  writeFileSync(join(uiDir, 'assets', 'app.js'), 'console.log(1);\n');
  writeFileSync(join(uiDir, 'assets', 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
});
afterAll(async () => {
  await s3.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

interface Machine extends TeamEnv {
  out: string[];
  err: string[];
  /** Output since the last call, for asserting on one command. */
  take(): { out: string; err: string };
}

/** A project folder on one machine: its own store, its own git email, the shared config. */
function machine(name: string, email: string, options: { now?: number; env?: NodeJS.ProcessEnv } = {}): Machine {
  const cwd = join(work, name);
  mkdirSync(cwd, { recursive: true });
  const out: string[] = [];
  const err: string[] = [];
  const m: Machine = {
    cwd,
    dbPath: join(cwd, '.shadowlap', 'shadowlap.db'),
    env: { AWS_ACCESS_KEY_ID: KEY, AWS_SECRET_ACCESS_KEY: SECRET, SHADOWLAP_AUTHOR: email, NO_COLOR: '1', ...options.env },
    now: () => options.now ?? at('2027-01-15'),
    open: { retryDelayMs: 1, home: join(work, 'no-home') },
    readFile: (path) => readFileSync(path, 'utf8'),
    io: { out: (t) => void out.push(t), err: (t) => void err.push(t) },
    out,
    err,
    take() {
      const r = { out: out.join(''), err: err.join('') };
      out.length = 0;
      err.length = 0;
      return r;
    },
  };
  return m;
}

function storeUrl(folder: string): string {
  return `s3://northwind-agent-runs/${folder}?endpoint=${s3.url}`;
}

/** A teammate's checkout: the committed config, nothing else. */
function teammate(of: Machine, name: string, email: string, env: NodeJS.ProcessEnv = {}): Machine {
  const m = machine(name, email, { env });
  writeFileSync(join(m.cwd, 'shadowlap.config.json'), readFileSync(join(of.cwd, 'shadowlap.config.json')));
  return m;
}

function goldenInto(m: Machine): string {
  const store = Store.open(m.dbPath);
  try {
    const id = unpackRun(store, GOLDEN).imported[0];
    // As if recorded here: a run this machine made carries no import marker.
    store.updateRunMeta(id, { imported: undefined } as unknown as Partial<RunMeta>);
    return id;
  } finally {
    store.close();
  }
}

/** The bucket's keys under a store folder. */
function keysUnder(folder: string): string[] {
  return [...s3.objects.keys()].filter((k) => k.startsWith(`${folder}/`)).sort();
}

describe('push and pull through the bucket', () => {
  it("pushes this machine's runs, then a teammate pulls them: nothing to add first", async () => {
    const dana = machine('team-dana', 'dana@northwind.example');
    storeSet(dana, storeUrl('team'));
    const runId = goldenInto(dana);
    dana.take();

    expect(await teamPush(dana, [], { all: true })).toBe(0);
    const pushed = dana.take();
    expect(pushed.out).toMatch(/✓ 1 run pushed · \d+ blobs uploaded/);
    expect(pushed.err).toContain(`Pushing to ${storeUrl('team').split('?')[0]} as dana@northwind.example with AWS_ACCESS_KEY_ID`);
    expect(s3.objects.has(`team/runs/${runId}/run.json`)).toBe(true);
    // Every request was signed and accepted, by a bucket whose Object Lock refuses a write without its MD5.
    expect(s3.requests.filter((r) => r.status === 403 || r.status === 400)).toEqual([]);
    // Nothing but runs, their blobs and the index.
    expect(keysUnder('team').every((k) => /^team\/(blobs|runs|index)\//.test(k))).toBe(true);

    expect(storeShow(dana, { json: true })).toBe(0);
    expect(JSON.parse(dana.take().out)).toMatchObject({ inStore: 1, onlyLocal: 0, provider: 's3', bucket: 'northwind-agent-runs', prefix: 'team' });

    // Maya has the committed config and no runs yet.
    const maya = teammate(dana, 'team-maya', 'maya@northwind.example');
    expect(await teamPull(maya, [])).toBe(0);
    expect(maya.take().out).toContain('✓ 1 run pulled (dana 1)');
    const store = Store.open(maya.dbPath);
    try {
      expect(store.getRun(runId)!.meta?.author).toBe('dana@northwind.example');
      expect(store.getCalls(runId)).toHaveLength(30);
    } finally {
      store.close();
    }

    // Maya labels the run and pushes; Dana pulls the label.
    const mstore = Store.open(maya.dbPath);
    mstore.updateRunMeta(runId, { labels: ['refund-flow'] });
    mstore.close();
    expect(await teamPush(maya, [runId])).toBe(0);
    expect(maya.take().out).toMatch(/0 runs pushed, 1 run updated/);
    expect(await teamPull(dana, [])).toBe(0);
    expect(dana.take().out).toContain("1 run's labels and notes merged");
    const dstore = Store.open(dana.dbPath);
    expect(dstore.getRun(runId)!.meta?.labels).toEqual(['refund-flow']);
    dstore.close();
  });

  it("shows a teammate's pulled run as their recording, with what it spent, and asks before replaying its command", async () => {
    const dana = machine('pulled-dana', 'dana@northwind.example');
    storeSet(dana, storeUrl('pulled'));
    const runId = goldenInto(dana);
    expect(await teamPush(dana, [], { all: true })).toBe(0);
    const jonas = teammate(dana, 'pulled-jonas', 'jonas@northwind.example');
    expect(await teamPull(jonas, [])).toBe(0);
    const env = { ...process.env, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1' };
    // Dana's recording, as she made it: its requests, and what it spent, by her.
    const shown = spawnSync(process.execPath, [CLI, 'show', runId], { cwd: jonas.cwd, env, encoding: 'utf8' });
    expect(shown.status).toBe(0);
    const [head, , facts] = shown.stdout.split('\n');
    expect(head).toMatch(new RegExp(`^${runId}  recording  completed`));
    expect(facts).toMatch(/ · 11 upstream requests · ≈\$\S+ spent by dana$/);
    expect(shown.stdout).not.toContain('captured');
    // Its command is still Dana's: a replay asks, naming where it came from, and runs nothing unasked.
    const replay = spawnSync(process.execPath, [CLI, 'replay', runId], { cwd: jonas.cwd, env, encoding: 'utf8' });
    expect(replay.status).toBe(2);
    expect(replay.stderr).toContain(`Run ${runId.slice(0, 10)} came from the team store, recorded by dana@northwind.example. Replaying it runs the command it was recorded with:`);
    expect(replay.stderr).toContain('Pass --yes to run it');
  });

  it("takes a fix with its blame, repair and verdict to a teammate, with the repair's patch beside their project", async () => {
    const dana = machine('fix-dana', 'dana@northwind.example');
    storeSet(dana, storeUrl('fixes'));
    const runId = goldenInto(dana);
    const store = Store.open(dana.dbPath);
    let fixId: string;
    try {
      store.updateRunMeta(runId, { labels: ['refund-bug'] });
      fixId = recordBlame(store, { runId, report: blameReport(runId), expect: EXPECT, scope: null, command: `shadowlap blame ${runId}`, title: 'Refunds above the limit issued without approval', checkText: 'issue_refund called 0 times', actor: 'dana@northwind.example' }).fix.fixId;
      recordRepair(store, { repairId: 'repair-munzln2i', dir: '.shadowlap/repairs/repair-munzln2i', report: repairReport({ targets: [runId] }), expect: EXPECT, command: `shadowlap repair --fixes ${runId}` });
    } finally {
      store.close();
    }
    dana.take();
    expect(await teamPush(dana, [], { all: true })).toBe(0);
    expect(dana.take().out).toContain('1 fix sent: "Refunds above the limit issued without approval"');
    expect(keysUnder('fixes')).toContain(`fixes/fixes/${fixId}.json`);

    const maya = teammate(dana, 'fix-maya', 'maya@northwind.example');
    expect(await teamPull(maya, [])).toBe(0);
    const out = maya.take().out;
    expect(out).toContain('1 fix pulled: "Refunds above the limit issued without approval"');
    expect(out).toContain(".shadowlap/repairs/repair-munzln2i");
    const mstore = Store.open(maya.dbPath);
    try {
      const fix = mstore.getFix(fixId)!;
      expect(fix.status).toBe('verified');
      const rec = fixRecords(mstore, fix);
      expect([rec.failing, rec.blames.length, rec.repairs.length, rec.verdicts.map((v) => v.verdict)]).toEqual([[runId], 1, 1, ['accepted']]);
      expect(readFileSync(join(maya.cwd, '.shadowlap', 'repairs', 'repair-munzln2i', 'fix.patch'), 'utf8')).toBe(rec.repairs[0].report.patch);
      expect(readFileSync(join(maya.cwd, '.shadowlap', 'repairs', 'repair-munzln2i', 'report.md'), 'utf8')).toContain('Escalate refunds above the policy limit');
      expect(existsSync(join(maya.cwd, '.shadowlap', 'repairs', 'repair-munzln2i', 'goldens'))).toBe(false);
      // Made on Dana's machine: marked so here, where its recordings aren't.
      expect(mstore.repairPulled('repair-munzln2i')).toMatchObject({ remote: storeUrl('fixes') });
    } finally {
      mstore.close();
    }
    const dstore = Store.open(dana.dbPath);
    expect(dstore.repairPulled('repair-munzln2i')).toBeNull();
    dstore.close();
  });

  it.skipIf(process.platform === 'win32')("writes a pulled repair's files through no link: a .shadowlap/repairs the repository tracks as one is refused, and nothing lands where it points", async () => {
    const dana = machine('fixlink-dana', 'dana@northwind.example');
    storeSet(dana, storeUrl('fixlink'));
    const runId = goldenInto(dana);
    const store = Store.open(dana.dbPath);
    try {
      recordBlame(store, { runId, report: blameReport(runId), expect: EXPECT, scope: null, command: `shadowlap blame ${runId}`, title: 'Refunds above the limit issued without approval', checkText: 'issue_refund called 0 times', actor: 'dana@northwind.example' });
      recordRepair(store, { repairId: 'repair-munzln2i', dir: '.shadowlap/repairs/repair-munzln2i', report: repairReport({ targets: [runId] }), expect: EXPECT, command: `shadowlap repair --fixes ${runId}` });
    } finally {
      store.close();
    }
    expect(await teamPush(dana, [], { all: true })).toBe(0);

    const maya = teammate(dana, 'fixlink-maya', 'maya@northwind.example');
    const elsewhere = mkdtempSync(join(tmpdir(), 'sl-team-elsewhere-'));
    try {
      // A link the repository tracks, in a .shadowlap that is a folder of its own.
      mkdirSync(join(maya.cwd, '.shadowlap'), { mode: 0o700 });
      symlinkSync(elsewhere, join(maya.cwd, '.shadowlap', 'repairs'));
      expect(await teamPull(maya, [])).toBe(0);
      const { out, err } = maya.take();
      expect(out).toContain('1 fix pulled: "Refunds above the limit issued without approval"');
      expect(`${out}${err}`).toContain(`! couldn't write .shadowlap/repairs/repair-munzln2i: .shadowlap/repairs in ${maya.cwd} is a link, which Shadowlap never writes through`);
      expect(readdirSync(elsewhere)).toEqual([]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("takes a teammate's repair on a push too, when the store's copy of the fix has it, and writes its patch here", async () => {
    const dana = machine('fixpush-dana', 'dana@northwind.example');
    storeSet(dana, storeUrl('fixpush'));
    const runId = goldenInto(dana);
    let fixId: string;
    const dstore = Store.open(dana.dbPath);
    try {
      dstore.updateRunMeta(runId, { labels: ['refund-bug'] });
      fixId = recordBlame(dstore, { runId, report: blameReport(runId), expect: EXPECT, scope: null, command: `shadowlap blame ${runId}`, title: 'Refunds above the limit issued without approval', checkText: 'issue_refund called 0 times' }).fix.fixId;
    } finally {
      dstore.close();
    }
    expect(await teamPush(dana, [], { all: true })).toBe(0);
    const maya = teammate(dana, 'fixpush-maya', 'maya@northwind.example');
    expect(await teamPull(maya, [])).toBe(0);
    const mstore = Store.open(maya.dbPath);
    recordRepair(mstore, { repairId: 'repair-mpush01', dir: '.shadowlap/repairs/repair-mpush01', report: repairReport({ targets: [runId], dir: '.shadowlap/repairs/repair-mpush01' }), expect: EXPECT, command: `shadowlap repair --fixes ${runId}` });
    mstore.close();
    expect(await teamPush(maya, [], { all: true })).toBe(0);
    // Dana names the fix and pushes, without pulling first: the push merges Maya's repair in.
    const again = Store.open(dana.dbPath);
    again.updateFix(fixId, { title: 'Escalate refunds above the policy limit' });
    again.mergeFixData(fixId, { titleEdited: true });
    again.close();
    dana.take();
    expect(await teamPush(dana, [], { all: true })).toBe(0);
    expect(dana.take().out).toContain("teammates' repairs that came with them, their patches and reports: .shadowlap/repairs/repair-mpush01");
    expect(existsSync(join(dana.cwd, '.shadowlap', 'repairs', 'repair-mpush01', 'fix.patch'))).toBe(true);
    const after = Store.open(dana.dbPath);
    try {
      expect(after.getFix(fixId)).toMatchObject({ status: 'verified', title: 'Escalate refunds above the policy limit' });
      expect(after.repairPulled('repair-mpush01')).not.toBeNull();
    } finally {
      after.close();
    }
  });

  it('ends a recording whose recorder was killed, as interrupted, and pushes it with --all', async () => {
    const m = machine('left', 'dana@northwind.example');
    storeSet(m, storeUrl('left'));
    const left = '01K4ZZ00000000000000000KXD';
    const store = Store.open(m.dbPath);
    // Killed two days ago, before it ended: still marked running, with nothing recording it.
    store.importRun({ runId: left, parentRunId: null, mode: 'record', status: 'running', divergence: null, command: { argv: ['node', 'agent.js'], cwd: m.cwd }, codeVersion: null, startedAt: Date.now() - 2 * DAY, endedAt: null });
    store.close();
    m.take();
    expect(storeShow(m, { json: true })).toBe(0);
    expect(JSON.parse(m.take().out)).toMatchObject({ onlyLocal: 1, queued: 0 });
    expect(await teamPush(m, [], { all: true })).toBe(0);
    expect(m.take().out).toMatch(/✓ 1 run pushed/);
    expect(s3.objects.has(`left/runs/${left}/run.json`)).toBe(true);
    const after = Store.open(m.dbPath);
    try {
      // Ended where it stopped: at its last call, or its start when it made none.
      expect(after.getRun(left)).toMatchObject({ status: 'crashed' });
      expect(after.getRun(left)!.endedAt).toBeLessThan(Date.now() - DAY);
    } finally {
      after.close();
    }
    expect(storeShow(m, { json: true })).toBe(0);
    expect(JSON.parse(m.take().out)).toMatchObject({ inStore: 1, onlyLocal: 0 });
  });

  it("says when this machine has no credentials for the store", async () => {
    const m = machine('nocreds', 'x@northwind.example');
    storeSet(m, storeUrl('nocreds'));
    goldenInto(m);
    m.env = { SHADOWLAP_AUTHOR: 'x@northwind.example', AWS_EC2_METADATA_DISABLED: 'true' };
    m.take();
    await expect(teamPush(m, [], { all: true })).rejects.toThrow(/No AWS credentials found/);
    expect(keysUnder('nocreds')).toEqual([]);
  });

  it('shares a redacted report behind a link that opens without credentials', async () => {
    const dana = machine('share', 'dana@northwind.example');
    storeSet(dana, storeUrl('share'));
    const runId = goldenInto(dana);
    const cfg = JSON.parse(readFileSync(join(dana.cwd, 'shadowlap.config.json'), 'utf8')) as Record<string, unknown>;
    writeFileSync(join(dana.cwd, 'shadowlap.config.json'), JSON.stringify({ ...cfg, redact: [{ pattern: 'email', replace: '<EMAIL>' }] }));
    dana.take();
    // A name that matches no run says so first, without asking the store.
    const before = s3.requests.length;
    await expect(teamShare(dana, 'ZZZZZZZZ', { uiDir })).rejects.toThrow('no run matches "ZZZZZZZZ"');
    expect(s3.requests.length).toBe(before);
    expect(await teamShare(dana, runId.slice(0, 8), { uiDir, json: true })).toBe(0);
    const share = JSON.parse(dana.take().out) as { url: string; expiresAt: number; redacted: boolean; key: string };
    expect(share.redacted).toBe(true);
    expect(share.key).toMatch(new RegExp(`^shares/${runId.toLowerCase()}-[0-9a-f]{12}\\.html$`));
    expect(share.expiresAt).toBe(at('2027-01-15') + 7 * DAY);
    expect(share.url).toContain('X-Amz-Expires=604800');
    // The fake S3 checks the link's signature and expiry against its own clock: it opens until then.
    s3Now = share.expiresAt + 1000;
    expect((await fetch(share.url)).status).toBe(403);
    s3Now = at('2027-01-15');
    const res = await fetch(share.url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const html = await res.text();
    expect(html).toContain('<EMAIL>');
    expect(html).not.toContain('team@example.com');
    // A broken normalizer leaves the report's Show diff none, with a warning naming it; a broken redaction rule stops the share, naming it.
    writeFileSync(join(dana.cwd, 'shadowlap.config.json'), JSON.stringify({ ...cfg, normalize: [{ pattern: 'uuidd', replace: '<U>' }], redact: [{ pattern: 'email', replace: '<EMAIL>' }] }));
    expect(await teamShare(dana, runId.slice(0, 8), { uiDir, json: true })).toBe(0);
    const warned = dana.take();
    expect(warned.err.match(/normalizer #1: unknown pattern "uuidd"/g)).toHaveLength(1);
    expect(JSON.parse(warned.out)).toMatchObject({ redacted: true });
    writeFileSync(join(dana.cwd, 'shadowlap.config.json'), JSON.stringify({ ...cfg, redact: [{ pattern: 'emial', replace: '<E>' }] }));
    await expect(teamShare(dana, runId.slice(0, 8), { uiDir, json: true })).rejects.toThrow('redaction rule #1: unknown pattern "emial"');
  });
});

describe("a pull request's CI job", () => {
  const github = (number: number): NodeJS.ProcessEnv => ({ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: `refs/pull/${number}/merge` });

  it('pushes only under pr/<number>/, which a pull leaves out unless asked, and whose runs never go back in', async () => {
    const dana = machine('pr-dana', 'dana@northwind.example');
    storeSet(dana, storeUrl('prs'));
    const golden = goldenInto(dana);
    expect(await teamPush(dana, [], { all: true })).toBe(0);
    const team = keysUnder('prs');

    // The job has the golden, labels it and forks it: everything it pushes goes to its own folder.
    const ci = teammate(dana, 'pr-ci', 'ci', github(42));
    goldenInto(ci);
    const cstore = Store.open(ci.dbPath);
    cstore.updateRunMeta(golden, { labels: ['approved'] });
    const fork = cstore.createRun({ mode: 'replay', parentRunId: golden, command: { argv: ['node', 'agent.js'], cwd: ci.cwd } });
    cstore.endRun(fork.runId, 'completed');
    cstore.close();
    ci.take();
    expect(await teamPush(ci, [], { all: true })).toBe(0);
    const pushed = ci.take();
    expect(pushed.err).toContain('Pushing to s3://northwind-agent-runs/prs/pr/42 as ci');
    expect(pushed.err).toContain("GitHub Actions (pull_request): its runs go to pull request 42's own folder in the store, which a pull brings only with --include-pr");
    const added = keysUnder('prs').filter((k) => !team.includes(k));
    expect(added.length).toBeGreaterThan(0);
    expect(added.every((k) => k.startsWith('prs/pr/42/'))).toBe(true);
    expect(keysUnder('prs').filter((k) => !k.startsWith('prs/pr/'))).toEqual(team);

    // A pull leaves the pull request's runs out; --include-pr brings them, marked as its.
    const maya = teammate(dana, 'pr-maya', 'maya@northwind.example');
    expect(await teamPull(maya, [])).toBe(0);
    expect(maya.take().out).toContain('✓ 1 run pulled (dana 1)');
    expect(await teamPull(maya, [], { includePr: true, json: true })).toBe(0);
    const pulled = JSON.parse(maya.take().out) as { pulled: string[]; pullRequests: Array<{ number: string; pulled: string[] }> };
    expect(pulled.pulled).toEqual([]);
    expect(pulled.pullRequests).toEqual([expect.objectContaining({ number: '42', pulled: [fork.runId] })]);
    const mstore = Store.open(maya.dbPath);
    try {
      expect(mstore.getRun(fork.runId)!.meta?.imported).toMatchObject({ pr: '42' });
      // What the pull request's folder says about the golden is never taken.
      expect(mstore.getRun(golden)!.meta?.labels).toBeUndefined();
    } finally {
      mstore.close();
    }

    // A run named is looked for in pull requests' folders only when asked.
    const ravi = teammate(dana, 'pr-ravi', 'ravi@northwind.example');
    expect(await teamPull(ravi, [fork.runId.slice(0, 10)])).toBe(1);
    expect(ravi.take().err).toContain(`✗ No run in the store matches "${fork.runId.slice(0, 10)}"`);
    expect(await teamPull(ravi, [fork.runId.slice(0, 10)], { includePr: true })).toBe(0);
    // The golden it forked comes from the store's own runs, never from the pull request's copy.
    const pulledByName = ravi.take().out;
    expect(pulledByName).toContain('✓ 1 run pulled (dana 1)');
    expect(pulledByName).toContain('✓ 1 run from pull requests pulled (#42 1)');
    const rstore = Store.open(ravi.dbPath);
    try {
      expect(rstore.getRun(golden)!.meta?.imported).toMatchObject({ from: 's3://northwind-agent-runs/prs' });
      expect(rstore.getRun(golden)!.meta?.imported?.pr).toBeUndefined();
      expect(rstore.getRun(golden)!.meta?.labels).toBeUndefined();
      expect(rstore.getRun(fork.runId)!.parentRunId).toBe(golden);
    } finally {
      rstore.close();
    }

    // Its runs stay out of the team's: not counted as only here, not pushed by --all, refused by name.
    expect(storeShow(maya, { json: true })).toBe(0);
    expect(JSON.parse(maya.take().out)).toMatchObject({ inStore: 1, onlyLocal: 0 });
    expect(await teamPush(maya, [], { all: true })).toBe(0);
    expect(s3.objects.has(`prs/runs/${fork.runId}/run.json`)).toBe(false);
    maya.take();
    expect(await teamPush(maya, [fork.runId])).toBe(1);
    expect(maya.take().err).toMatch(/1 run stayed on this machine:\n.*came from pull request 42's folder in the store/);
    expect(s3.objects.has(`prs/runs/${fork.runId}/run.json`)).toBe(false);
  });

  it('pushes test runs and the report to its folder, from a GitLab merge request too', async () => {
    const dana = machine('mr-dana', 'dana@northwind.example');
    storeSet(dana, storeUrl('mr'));
    const ci = teammate(dana, 'mr-ci', 'ci', { GITLAB_CI: 'true', CI_PIPELINE_SOURCE: 'merge_request_event', CI_MERGE_REQUEST_IID: '7' });
    const pusher = await prepareTestPush(ci);
    expect(pusher).not.toBeNull();
    expect(ci.take().err).toContain("--push: a GitLab merge request pipeline: its runs go to pull request 7's own folder in the store");
    const store = Store.open(':memory:');
    const golden = unpackRun(store, GOLDEN).imported[0];
    const attempt = store.createRun({ mode: 'replay', parentRunId: golden, command: { argv: ['node', 'agent.js'], cwd: ci.cwd } });
    store.endRun(attempt.runId, 'completed');
    await pusher!.pushRuns(store, [attempt.runId]);
    await pusher!.finish(testReport([]));
    store.close();
    expect(s3.objects.has(`mr/pr/7/runs/${attempt.runId}/run.json`)).toBe(true);
    expect(keysUnder('mr/pr/7').filter((k) => k.startsWith('mr/pr/7/tests/'))).toHaveLength(1);
    expect(keysUnder('mr').every((k) => k.startsWith('mr/pr/7/'))).toBe(true);
    expect(ci.take().err).toContain('pushed 2 runs and the report to s3://northwind-agent-runs/mr/pr/7'); // the attempt and the golden it replayed
  });

  it('writes nothing when the number of the pull request it runs for is unknown', async () => {
    const dana = machine('nonum-dana', 'dana@northwind.example');
    storeSet(dana, storeUrl('nonum'));
    // pull_request_target runs on the base branch: the number is only in the event file.
    const event = join(work, 'event.json');
    writeFileSync(event, JSON.stringify({ number: 9, pull_request: { number: 9 } }));
    const env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request_target', GITHUB_REF: 'refs/heads/main' };
    const withEvent = teammate(dana, 'nonum-ci', 'ci', { ...env, GITHUB_EVENT_PATH: event });
    goldenInto(withEvent);
    expect(await teamPush(withEvent, [], { all: true })).toBe(0);
    expect(keysUnder('nonum').length).toBeGreaterThan(0);
    expect(keysUnder('nonum').every((k) => k.startsWith('nonum/pr/9/'))).toBe(true);

    const blind = teammate(dana, 'nonum-blind', 'ci', env);
    goldenInto(blind);
    const before = keysUnder('nonum');
    await expect(teamPush(blind, [], { all: true })).rejects.toThrow(/^This is a pull request's CI job, GitHub Actions \(pull_request_target\), and its number couldn't be found, so nothing goes to the store: .*Set SHADOWLAP_PR to the pull request's number\.$/);
    expect(await prepareTestPush(blind, { annotations: true })).toBeNull();
    expect(blind.take().out).toMatch(/^::warning title=shadowlap test --push::This is a pull request's CI job/m);
    await expect(storeCheck(blind)).rejects.toThrow(TeamError);
    expect(keysUnder('nonum')).toEqual(before);
    // SHADOWLAP_PR names it, with a number and nothing else.
    blind.env = { ...blind.env, SHADOWLAP_PR: '../main' };
    await expect(teamPush(blind, [], { all: true })).rejects.toThrow(/^SHADOWLAP_PR is "\.\.\/main", which isn't a pull request's number, so nothing goes to the store/);
    expect(keysUnder('nonum')).toEqual(before);
    blind.env = { ...blind.env, SHADOWLAP_PR: '9' };
    expect(await teamPush(blind, [], { all: true })).toBe(0);
  });

  it('shares and checks inside its own folder', async () => {
    const dana = machine('prshare-dana', 'dana@northwind.example');
    storeSet(dana, storeUrl('prshare'));
    const ci = teammate(dana, 'prshare-ci', 'ci', github(5));
    const runId = goldenInto(ci);
    expect(await teamShare(ci, runId, { uiDir, json: true })).toBe(0);
    const share = JSON.parse(ci.take().out) as { store: string; key: string };
    expect(share.store).toBe('s3://northwind-agent-runs/prshare/pr/5');
    expect(s3.objects.has(`prshare/pr/5/${share.key}`)).toBe(true);
    expect(await storeCheck(ci)).toBe(0);
    expect(ci.take().out).toContain('Checking s3://northwind-agent-runs/prshare/pr/5');
    expect(keysUnder('prshare').every((k) => k.startsWith('prshare/pr/5/'))).toBe(true);
  });
});

describe('what reaches the terminal', () => {
  it('pulls the other runs when one in the store is bad, and prints nothing a terminal would act on', async () => {
    const dana = machine('esc-dana', 'dana@northwind.example');
    storeSet(dana, storeUrl('esc'));
    const runId = goldenInto(dana);
    expect(await teamPush(dana, [], { all: true })).toBe(0);
    // Someone with write access to the bucket gives the run an author that rewrites terminals.
    const key = `esc/runs/${runId}/run.json`;
    const doc = JSON.parse(s3.objects.get(key)!.body.toString()) as { run: { meta: Record<string, unknown> } };
    doc.run.meta.author = 'mallory\u001b]0;owned\u0007\u001b[2J@evil.example';
    s3.objects.get(key)!.body = Buffer.from(JSON.stringify(doc));

    const maya = teammate(dana, 'esc-maya', 'maya@northwind.example');
    expect(await teamPull(maya, [])).toBe(0);
    const { out, err } = maya.take();
    expect(out + err).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    expect(err).toContain("! 1 run in the store couldn't be pulled; the next pull tries again:");
    expect(err).toMatch(/meta\.author: contains control characters/);
    // Named, it is a failure of the command.
    expect(await teamPull(maya, [runId])).toBe(1);
  });

  it('keeps a run here that a pull would refuse, and says why', async () => {
    const m = machine('refused', 'dana@northwind.example');
    storeSet(m, storeUrl('refused'));
    const store = Store.open(m.dbPath);
    const run = store.createRun({ mode: 'record', command: { argv: ['node', '-e', 'process.stdout.write("\u001b[2J")'], cwd: m.cwd } });
    store.endRun(run.runId, 'completed');
    store.close();
    m.take();
    expect(await teamPush(m, [run.runId])).toBe(1);
    const { err } = m.take();
    expect(err).toContain('! 1 run stayed on this machine:');
    expect(err).toMatch(/argv\[2\]: contains control characters/);
    expect(s3.objects.has(`refused/runs/${run.runId}/run.json`)).toBe(false);
  });

  it('escapes what a store answers when it prints it', async () => {
    const m = machine('esc-answer', 'dana@northwind.example');
    storeSet(m, 's3://northwind-agent-runs/x?endpoint=https://minio.example');
    // An S3-compatible endpoint answers every request with an error that would rewrite a terminal.
    m.open = { ...m.open, fetch: async () => new Response('<Error><Code>SlowDown\u001b]0;owned\u0007</Code><Message>wait\u001b[2J</Message></Error>', { status: 400 }) };
    m.take();
    expect(await storeCheck(m)).toBe(1);
    const { out, err } = m.take();
    expect(out + err).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    expect(out).toContain('SlowDown\\x1b]0;owned\\x07 (wait\\x1b[2J)');
    const ci = { ...m, env: { ...m.env, GITHUB_ACTIONS: 'true' } };
    const pusher = await prepareTestPush(ci, { annotations: true });
    expect(pusher).not.toBeNull();
    const store = Store.open(':memory:');
    const run = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd: m.cwd } });
    store.endRun(run.runId, 'completed');
    await pusher!.pushRuns(store, [run.runId]);
    store.close();
    const pushed = m.take();
    expect(pushed.out + pushed.err).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    expect(pushed.out).toMatch(/^::warning title=shadowlap test --push::couldn't push /m);
  });

  it("lets a store URL with a typo stop only the store's commands", async () => {
    const m = machine('typo', 'dana@northwind.example');
    writeFileSync(join(m.cwd, 'shadowlap.config.json'), JSON.stringify({ store: 'S3:/northwind-agent-runs' }));
    expect(loadConfig(m.cwd).store).toBe('S3:/northwind-agent-runs');
    await expect(teamPush(m, [], { all: true })).rejects.toThrow(/shadowlap\.config\.json: S3:\/northwind-agent-runs isn't a store URL/);
    // A run ending with a queued push to look for is quiet about it.
    await pushIfQueued(m);
    expect(m.take()).toEqual({ out: '', err: '' });
  });
});

describe('store setup', () => {
  it("checks a store's scheme against the provider picked", () => {
    const m = machine('setup-scheme', 'x@northwind.example');
    expect(() => storeSet(m, 'gs://northwind-agent-runs/x', { provider: 's3' })).toThrow('An Amazon S3 store starts with s3://');
    expect(() => storeSet(m, 'ftp://x')).toThrow(/isn't a store URL/);
    expect(existsSync(join(m.cwd, 'shadowlap.config.json'))).toBe(false);
  });

  it('writes the store to the config, keeping everything else', () => {
    const m = machine('setup-config', 'x@northwind.example');
    writeFileSync(join(m.cwd, 'shadowlap.config.json'), JSON.stringify({ normalize: [{ path: '$.x', replace: 'X' }], tests: { 'goldens/*': {} } }));
    expect(storeSet(m, 'r2://0123456789abcdef/agent-runs/support-agent')).toBe(0);
    expect(JSON.parse(readFileSync(join(m.cwd, 'shadowlap.config.json'), 'utf8'))).toEqual({ normalize: [{ path: '$.x', replace: 'X' }], tests: { 'goldens/*': {} }, store: 'r2://0123456789abcdef/agent-runs/support-agent' });
    expect(m.take().out).toContain('✓ Store set: r2://0123456789abcdef/agent-runs/support-agent (Cloudflare R2)');
  });

  it("edits the config as the dashboard's Settings do: its own layout kept", () => {
    const m = machine('setup-layout', 'x@northwind.example');
    const file = join(m.cwd, 'shadowlap.config.json');
    writeFileSync(file, '{\r\n    "clock": "exact",\r\n    "keyFromANewerVersion": 1\r\n}\r\n');
    expect(storeSet(m, 'r2://0123456789abcdef/agent-runs/support-agent')).toBe(0);
    expect(storePushFromCi(m, 'off')).toBe(0);
    // Four spaces and CRLF as written, every key in its place, the new ones after them.
    expect(readFileSync(file, 'utf8')).toBe('{\r\n    "clock": "exact",\r\n    "keyFromANewerVersion": 1,\r\n    "store": "r2://0123456789abcdef/agent-runs/support-agent",\r\n    "ciPush": false\r\n}\r\n');
  });

  it('with --check, writes the store only once the check passes', async () => {
    const m = machine('setup-set-check', 'dana@northwind.example');
    const file = join(m.cwd, 'shadowlap.config.json');
    // A bucket these credentials can't find: nothing is written.
    expect(await storeSetChecked(m, `s3://no-such-bucket/x?endpoint=${s3.url}`, { provider: 's3' })).toBe(1);
    let { out, err } = m.take();
    expect(out).toContain('Checking s3://no-such-bucket/x');
    expect(err).toMatch(/names a bucket these credentials can't find.*Nothing was written to shadowlap\.config\.json\./);
    expect(existsSync(file)).toBe(false);
    // Credentials the store refuses: nothing either.
    const wrong = machine('setup-set-check', 'dana@northwind.example', { env: { AWS_SECRET_ACCESS_KEY: 'not/the/secret' } });
    expect(await storeSetChecked(wrong, storeUrl('set-check'))).toBe(1);
    wrong.take();
    expect(existsSync(file)).toBe(false);
    // One that works is checked, then written, and its check kept as the store's last.
    expect(await storeSetChecked(m, storeUrl('set-check'), { provider: 's3' })).toBe(0);
    ({ out } = m.take());
    expect(out).toContain('✓ list');
    expect(out).toContain(`✓ Store set: ${storeUrl('set-check')}`);
    expect(out).toContain('Next: shadowlap push --all, then commit shadowlap.config.json');
    expect(loadConfig(m.cwd).store).toBe(storeUrl('set-check'));
    expect(storeShow(m, { json: true })).toBe(0);
    expect(JSON.parse(m.take().out).check).toMatchObject({ ok: true, versioning: 'on' });
    expect(keysUnder('set-check')).toEqual([]);
  });

  it('checks list, write, read and delete, and reports encryption, versioning and object lock', async () => {
    const m = machine('setup-check', 'dana@northwind.example');
    storeSet(m, storeUrl('checked'));
    m.take();
    expect(await storeCheck(m)).toBe(0);
    const { out, err } = m.take();
    expect(out).toContain('✓ list');
    expect(out).toContain('✓ delete');
    expect(out).toContain('Encryption   aws:kms');
    expect(out).toContain('Versioning   on');
    expect(out).toContain('Object lock  on (governance mode, 30 days)');
    expect(err).toBe('');
    expect(keysUnder('checked')).toEqual([]);
    expect(storeShow(m, { json: true })).toBe(0);
    expect(JSON.parse(m.take().out).check).toMatchObject({ ok: true, versioning: 'on', objectLock: 'on', encryption: 'aws:kms', credentials: 'AWS_ACCESS_KEY_ID' });
  });

  it('warns when versioning or object lock is off', async () => {
    const bare = await startFakeS3({ keys: { [KEY]: SECRET }, bucket: 'northwind-agent-runs', versioning: null, encryption: 'AES256' });
    try {
      const m = machine('setup-unlocked', 'dana@northwind.example');
      storeSet(m, `s3://northwind-agent-runs/x?endpoint=${bare.url}`);
      m.take();
      expect(await storeCheck(m)).toBe(0);
      const { out, err } = m.take();
      expect(out).toContain('Versioning   off');
      expect(out).toContain('Object lock  off');
      expect(err).toMatch(/! Versioning is off: a run deleted or overwritten in the bucket can't be recovered/);
      expect(err).toMatch(/! Object lock is off: anyone allowed to delete in the bucket can remove a run's earlier versions for good/);
    } finally {
      await bare.close();
    }
  });

  it('fails the check, step by step, with credentials the store refuses', async () => {
    const m = machine('setup-denied', 'x@northwind.example');
    storeSet(m, storeUrl('denied'));
    m.env = { ...m.env, AWS_SECRET_ACCESS_KEY: 'wrong' };
    m.take();
    expect(await storeCheck(m)).toBe(1);
    const { out, err } = m.take();
    expect(out).toMatch(/✗ list .*secret key doesn't match/);
    expect(err).toContain("✗ The credentials on this machine don't work for s3://northwind-agent-runs/denied (see the first step above).");
  });

  it('says what a failed check means: no network, or no access', async () => {
    const m = machine('setup-failures', 'x@northwind.example');
    // Nothing listens there.
    storeSet(m, 's3://northwind-agent-runs/x?endpoint=http://127.0.0.1:9');
    expect(m.take().out).toContain('(S3-compatible)');
    expect(await storeCheck(m)).toBe(1);
    expect(m.take().err).toContain("✗ Couldn't reach s3://northwind-agent-runs/x: check the address (http://127.0.0.1:9) and this machine's network");
    const locked = await startFakeS3({ keys: { [KEY]: SECRET }, bucket: 'northwind-agent-runs', versioning: 'Enabled', deny: ['put'] });
    try {
      storeSet(m, `s3://northwind-agent-runs/x?endpoint=${locked.url}`);
      m.take();
      expect(await storeCheck(m)).toBe(1);
      expect(m.take().err).toContain("✗ These credentials can't use s3://northwind-agent-runs/x yet. Ask your cloud admin for the access shadowlap store policy prints, then run shadowlap store check again.");
    } finally {
      await locked.close();
    }
  });

  it('says what to do after a --check that failed, where nothing was set: in a terminal, and in the setup', async () => {
    const m = machine('setup-set-advice', 'dana@northwind.example');
    // No bucket by that name: the command to run again, quoted for a shell.
    const missing = `s3://no-such-bucket/x?endpoint=${s3.url}`;
    expect(await storeSetChecked(m, missing)).toBe(1);
    expect(m.take().err).toContain(`✗ s3://no-such-bucket/x names a bucket these credentials can't find. Check the name, then run shadowlap store set '${missing}' --check again. Nothing was written to shadowlap.config.json.`);
    // Credentials the store refuses.
    const wrong = machine('setup-set-advice', 'dana@northwind.example', { env: { AWS_SECRET_ACCESS_KEY: 'not/the/secret' } });
    expect(await storeSetChecked(wrong, storeUrl('advice'))).toBe(1);
    expect(wrong.take().err).toContain(`the way the cloud's own tools find them; then run shadowlap store set '${storeUrl('advice')}' --check again. Nothing was written to shadowlap.config.json.`);
    const locked = await startFakeS3({ keys: { [KEY]: SECRET }, bucket: 'northwind-agent-runs', versioning: 'Enabled', deny: ['put'] });
    try {
      // No access yet: the policy for the provider asked for, since no store is set to name it.
      const url = `s3://northwind-agent-runs/x?endpoint=${locked.url}`;
      expect(await storeSetChecked(m, url)).toBe(1);
      expect(m.take().err).toContain(`✗ These credentials can't use s3://northwind-agent-runs/x yet. Ask your cloud admin for the access shadowlap store policy --provider s3 prints, then run shadowlap store set '${url}' --check again. Nothing was written to shadowlap.config.json.`);
      // Run by the setup's Check access and connect, whose drawer shows this: its own button. Not
      // spawnSync: the bucket answers from this process.
      const r = await new Promise<{ code: number | null; stderr: string }>((done) => {
        const child = spawn(process.execPath, [CLI, 'store', 'set', url, '--check'], {
          cwd: m.cwd,
          env: { PATH: process.env.PATH ?? '', ...m.env, HOME: join(work, 'no-home'), AWS_EC2_METADATA_DISABLED: 'true', SHADOWLAP_EVENTS_FD: '3' },
          stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
        });
        let stderr = '';
        child.stderr!.on('data', (d: Buffer) => (stderr += d.toString()));
        child.on('close', (code) => done({ code, stderr }));
      });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("Ask your cloud admin for the access this step shows, then Check access and connect again. Nothing was written to shadowlap.config.json.");
      expect(existsSync(join(m.cwd, 'shadowlap.config.json'))).toBe(false);
    } finally {
      await locked.close();
    }
  });

  it('prints two policies: for people and protected branches, and for pull requests', () => {
    const m = machine('setup-policy', 'x@northwind.example');
    storeSet(m, 's3://northwind-agent-runs/support-agent');
    m.take();
    expect(storePolicy(m)).toBe(0);
    const { out, err } = m.take();
    const [writer, pr] = out.split(/\n(?=\{)/).map((x) => JSON.parse(x) as { Statement: Array<{ Action: string[]; Resource: string }> });
    expect(writer.Statement.some((s) => s.Action.includes('s3:PutObject') && s.Resource === 'arn:aws:s3:::northwind-agent-runs/support-agent/*')).toBe(true);
    expect(pr.Statement.filter((s) => s.Action.includes('s3:PutObject')).map((s) => s.Resource)).toEqual(['arn:aws:s3:::northwind-agent-runs/support-agent/pr/*']);
    expect(err).toContain('# 1. For people, and CI on protected branches: an IAM policy');
    expect(err).toContain("# 2. For pull requests' CI jobs: an IAM policy that reads the store and writes only under support-agent/pr/");
  });

  it('prints a CI step that gives the goldens that run live their providers’ keys', () => {
    const m = machine('setup-ci', 'x@northwind.example');
    storeSet(m, 's3://northwind-agent-runs/support-agent');
    // One golden forks, so it runs live in CI; its recording called Anthropic. One replays offline, on OpenAI.
    for (const [name, provider] of [['refund-over-limit', 'anthropic'], ['refund-in-limit', 'openai']] as const) {
      mkdirSync(join(m.cwd, 'goldens', name), { recursive: true });
      writeFileSync(join(m.cwd, 'goldens', name, 'run.json'), '{}');
      writeFileSync(join(m.cwd, 'goldens', name, 'calls.jsonl'), `${JSON.stringify({ runId: 'R', callNo: 1, kind: 'api', meta: { provider } })}\n`);
    }
    const config = JSON.parse(readFileSync(join(m.cwd, 'shadowlap.config.json'), 'utf8')) as Record<string, unknown>;
    writeFileSync(join(m.cwd, 'shadowlap.config.json'), JSON.stringify({ ...config, tests: { 'goldens/refund-over-limit': { fork: true, expect: { tools: { issue_refund: 0 } } } } }));
    m.take();
    expect(storeCi(m, { provider: 'github' })).toBe(0);
    const { out, err } = m.take();
    expect(out).toContain('test goldens/* --push\n    env:\n      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}\n');
    // The replay golden runs offline: no key for it.
    expect(out).not.toContain('OPENAI_API_KEY');
    expect(err).toContain("# The goldens that run live (marked fork, or with an injection gate) call your agent's providers: add ANTHROPIC_API_KEY as a repository secret, which the step's env passes on.");
    // Packs that name only the replay golden need none.
    expect(storeCi(m, { provider: 'github', packs: 'goldens/refund-in-*' })).toBe(0);
    expect(m.take().out).not.toContain('API_KEY');
  });
});

describe('a run pushed while it records, and test runs from CI', () => {
  it('goes to the store when it ends', async () => {
    const m = machine('queued', 'dana@northwind.example');
    storeSet(m, storeUrl('queued'));
    const store = Store.open(m.dbPath);
    const run = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd: m.cwd } });
    store.close();
    m.take();
    expect(await teamPush(m, [run.runId])).toBe(0);
    expect(m.take().out).toContain('1 run still recording: it goes when it ends');
    expect(s3.objects.has(`queued/runs/${run.runId}/run.json`)).toBe(false);
    const again = Store.open(m.dbPath);
    again.endRun(run.runId, 'completed');
    again.close();
    await pushIfQueued(m);
    expect(m.take().err).toContain(`pushed ${run.runId.slice(0, 10)} to s3://northwind-agent-runs/queued, as asked while it was recording`);
    expect(s3.objects.has(`queued/runs/${run.runId}/run.json`)).toBe(true);
    // Nothing queued: no request at all.
    const before = s3.requests.length;
    await pushIfQueued(m);
    expect(s3.requests.length).toBe(before);
    expect(m.take()).toEqual({ out: '', err: '' });
  });

  it('records the push when they end by run, their attempts apart, with the fixes that went too', async () => {
    const m = machine('queued-attempts', 'dana@northwind.example');
    storeSet(m, storeUrl('queued-attempts'));
    const golden = goldenInto(m);
    const store = Store.open(m.dbPath);
    // Five attempts of the golden, still running when the push is asked for (replay --repeat 5).
    const attempts = [1, 2, 3, 4, 5].map((n) => store.createRun({ mode: 'replay', parentRunId: golden, command: { argv: ['node', 'agent.js'], cwd: m.cwd }, meta: { repeat: { group: 'g', attempt: n, of: 5 } } }).runId);
    store.updateRunMeta(golden, { labels: ['refund-bug'] });
    const fixId = recordBlame(store, { runId: golden, report: blameReport(golden), expect: EXPECT, scope: null, command: 'shadowlap blame', title: 'Refunds above the limit issued without approval', checkText: 'x' }).fix.fixId;
    store.close();
    expect(await teamPush(m, attempts)).toBe(0);
    const ended = Store.open(m.dbPath);
    for (const id of attempts) ended.endRun(id, 'completed');
    ended.close();
    m.take();
    await pushIfQueued(m);
    expect(s3.objects.has(`queued-attempts/fixes/${fixId}.json`)).toBe(true);
    const events = Store.open(m.dbPath);
    try {
      const pushed = events.listEvents({ kinds: ['store.pushed'] })[0];
      expect(pushed.data).toMatchObject({ pushed: 0, attempts: 5, fixes: 0, queued: true });
      // The first push sent the golden and the fix: one run, by run, with its fix.
      expect(events.listEvents({ kinds: ['store.pushed'] })[1].data).toMatchObject({ pushed: 1, attempts: 0, fixes: 1 });
    } finally {
      events.close();
    }
  });

  it('pushes each test run and the report from a fresh checkout', async () => {
    const dana = machine('ci-dana', 'dana@northwind.example');
    storeSet(dana, storeUrl('ci'));
    const ci = teammate(dana, 'ci-runner', 'ci');
    const pusher = await prepareTestPush(ci);
    expect(pusher).not.toBeNull();
    const store = Store.open(':memory:');
    const golden = unpackRun(store, GOLDEN).imported[0];
    const attempt = store.createRun({ mode: 'replay', parentRunId: golden, command: { argv: ['node', 'agent.js'], cwd: ci.cwd } });
    store.endRun(attempt.runId, 'completed');
    await pusher!.pushRuns(store, [attempt.runId]);
    await pusher!.finish(testReport([]));
    store.close();
    expect(s3.objects.has(`ci/runs/${attempt.runId}/run.json`)).toBe(true);
    expect(s3.objects.has(`ci/runs/${golden}/run.json`)).toBe(true);
    const doc = JSON.parse(s3.objects.get(`ci/runs/${attempt.runId}/run.json`)!.body.toString()) as { run: { meta: { author?: string } } };
    expect(doc.run.meta.author).toBe('ci');
    const goldenDoc = JSON.parse(s3.objects.get(`ci/runs/${golden}/run.json`)!.body.toString()) as { run: { meta: { author?: string } } };
    expect(goldenDoc.run.meta.author).toBeUndefined();
    expect(keysUnder('ci').filter((k) => k.startsWith('ci/tests/'))).toHaveLength(1);
  });

  it('names the CI in the report, and a pull keeps the newest session CI pushed, never a person’s', async () => {
    const dana = machine('ci-seen', 'dana@northwind.example');
    storeSet(dana, storeUrl('ci-seen'));
    const verdicts = (...v: string[]) => v.map((verdict) => ({ verdict })) as unknown as Parameters<typeof testReport>[0];
    const report = (id: string, revision: string, results: ReturnType<typeof verdicts>) => ({ ...testReport([], { id, revision }), results });
    const job = teammate(dana, 'ci-seen-runner', 'ci', { GITHUB_ACTIONS: 'true' });
    // Each report a minute after the one before: its key's ULID sorts by that time.
    const minute = (m: Machine, n: number): Machine => ({ ...m, now: () => at('2027-01-15') + n * 60_000 });
    await (await prepareTestPush(minute(job, 1)))!.finish(report('S1', 'd2e8a1f9', verdicts('passed', 'passed', 'failed', 'inconclusive')));
    const docs = keysUnder('ci-seen').filter((k) => k.startsWith('ci-seen/tests/'));
    expect(docs).toHaveLength(1);
    expect(JSON.parse(s3.objects.get(docs[0])!.body.toString())).toMatchObject({ format: 'shadowlap-store-tests', ci: 'github' });
    // A person's own --push, later: no ci, so the line still names CI's.
    await (await prepareTestPush(minute(teammate(dana, 'ci-seen-laptop', 'sam@northwind.example'), 2)))!.finish(report('S2', 'aaaa111', verdicts('passed')));
    const key = (m: Machine) => {
      const store = Store.open(m.dbPath);
      try {
        return lastCiSession(store, storeKey(parseStoreUrl(storeUrl('ci-seen'))));
      } finally {
        store.close();
      }
    };
    expect(await teamPull(dana, [])).toBe(0);
    expect(key(dana)).toEqual({ ci: 'github', session: 'S1', revision: 'd2e8a1f9', at: expect.any(Number), passed: 2, failed: 1, inconclusive: 1 });
    // The next pull reads only what came since; a later CI session replaces it.
    await (await prepareTestPush(minute(job, 3)))!.finish(report('S3', 'b0b0b0b', verdicts('passed', 'passed')));
    expect(await teamPull(dana, [])).toBe(0);
    expect(key(dana)).toMatchObject({ session: 'S3', revision: 'b0b0b0b', passed: 2, failed: 0, inconclusive: 0 });
  });

  it("keeps CI from pushing when Push from CI is off, and pushes from a person's machine anyway", async () => {
    const dana = machine('ci-off', 'dana@northwind.example');
    storeSet(dana, storeUrl('ci-off'));
    dana.take();
    expect(storePushFromCi(dana, 'off')).toBe(0);
    expect(dana.take().out).toContain('✓ Push from CI off: shadowlap test --push in CI runs the tests and keeps their runs in the job, and the GitHub Action keeps the fixes it opens there.');
    expect(JSON.parse(readFileSync(join(dana.cwd, 'shadowlap.config.json'), 'utf8'))).toMatchObject({ store: expect.stringContaining('ci-off'), ciPush: false });
    const ci = teammate(dana, 'ci-off-runner', 'ci', { GITHUB_ACTIONS: 'true' });
    expect(await prepareTestPush(ci)).toBeNull();
    expect(ci.take().err).toContain('--push: Push from CI is off ("ciPush": false in shadowlap.config.json); the tests run and their runs stay in this job.');
    // On a person's machine, --push is what they asked for.
    expect(await prepareTestPush(dana)).not.toBeNull();
    expect(storePushFromCi(dana, 'on', { json: true })).toBe(0);
    expect(JSON.parse(dana.take().out)).toMatchObject({ ciPush: true, previous: false });
    // Said in words: CI fixes go with it, as the GitHub Action pushes them.
    expect(storePushFromCi(dana, 'on')).toBe(0);
    expect(dana.take().out).toContain('✓ Push from CI on: shadowlap test --push in CI pushes every test run and its report, and the GitHub Action each fix it opens.');
    writeFileSync(join(ci.cwd, 'shadowlap.config.json'), readFileSync(join(dana.cwd, 'shadowlap.config.json')));
    expect(await prepareTestPush(ci)).not.toBeNull();
  });

  it('runs the tests anyway when there is no store to push to', () => {
    const dir = join(work, 'ci-nostore');
    mkdirSync(dir, { recursive: true });
    const r = spawnSync(process.execPath, [CLI, 'test', join(dir, 'missing-pack'), '--push'], { cwd: dir, env: { ...process.env, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1' }, encoding: 'utf8' });
    expect(r.stderr).toContain('! --push: no team store is set in shadowlap.config.json (shadowlap store set <url>); the tests run without pushing.');
    expect(r.stdout).toContain('0 passed, 1 failed'); // the missing pack fails on its own account
  });
});
