import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordBlame, Store } from '@shadowlap/engine';
import { blameReport, EXPECT, makeRun } from '../../engine/test/fix-fixtures.js';

/**
 * `shadowlap fix pr`: a fix records the pull request opened for it (CI's fix on failure does this
 * once gh opened it), and, asked again with no address, reads where it stands from GitHub with gh.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const PR = 'https://github.com/acme/support-agent/pull/138';

let dir: string;
let db: string;
let bin: string;
let fixId: string;

function shadowlap(args: string[], state = 'MERGED'): Promise<{ code: number | null; stdout: string; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, '--db', db, ...args], { cwd: dir, env: { ...process.env, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', FAKE_GH_STATE: state, PATH: `${bin}${delimiter}${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let out = '';
    child.stdout.on('data', (d: Buffer) => ((stdout += d.toString()), (out += d.toString())));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('close', (code) => resolve({ code, stdout, out }));
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sl-fix-pr-'));
  db = join(dir, 'shadowlap.db');
  // A stand-in for gh: says the pull request is FAKE_GH_STATE, and notes how it was asked.
  bin = mkdtempSync(join(tmpdir(), 'sl-fix-pr-gh-'));
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(bin, 'asked')}"\nprintf '{"state":"%s"}\\n' "$FAKE_GH_STATE"\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const store = Store.open(db);
  const run = makeRun(store);
  fixId = recordBlame(store, { runId: run, report: blameReport(run), expect: EXPECT, scope: null, command: 'shadowlap blame', title: 'issue_refund called with amount 240', checkText: 'issue_refund never called with {"amount":240}', ci: 'github' }).fix.fixId;
  store.close();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
});

const fixOf = () => {
  const store = Store.open(db);
  try {
    return store.getFix(fixId)!;
  } finally {
    store.close();
  }
};

// The stand-in for gh is a shell script, which Windows won't run by name.
describe.skipIf(process.platform === 'win32')('shadowlap fix pr', () => {
  it('records the pull request opened for a fix, which Fixes then shows where it came from', async () => {
    const r = await shadowlap(['fix', 'pr', fixId.slice(0, 13), PR]);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toBe(`${fixId.slice(0, 13)} · PR #138 open\n`);
    expect(fixOf().data.source).toMatchObject({ ci: 'github', pr: { url: PR, number: 138, state: 'open' } });
    const listed = await shadowlap(['fix', 'ls', '--json']);
    expect((JSON.parse(listed.stdout) as { fixes: Array<{ source: string }> }).fixes[0]!.source).toBe('from CI · PR #138');
  });

  it('reads where the pull request stands from GitHub with gh, and records it', async () => {
    await shadowlap(['fix', 'pr', fixId, PR]);
    const r = await shadowlap(['fix', 'pr', fixId, '--json']);
    expect(r.code, r.out).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ fixId, pr: { url: PR, number: 138, state: 'merged' } });
    expect(readFileSync(join(bin, 'asked'), 'utf8').split('\n').filter(Boolean)).toEqual(['pr', 'view', PR, '--json', 'state']);
    expect(fixOf().data.source?.pr?.state).toBe('merged');
    const listed = await shadowlap(['fix', 'ls', '--json']);
    expect((JSON.parse(listed.stdout) as { fixes: Array<{ source: string }> }).fixes[0]!.source).toBe('from CI · PR #138 merged');
  });

  it('says what it can’t record or read', async () => {
    const none = await shadowlap(['fix', 'pr', fixId]);
    expect(none.code).toBe(1);
    expect(none.out).toContain('has no pull request: record one with shadowlap fix pr');
    const bad = await shadowlap(['fix', 'pr', fixId, 'acme/support-agent#138']);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("acme/support-agent#138 is not a pull request's address: give its https:// link");
    // gh can't tell (it answers nothing it knows): the state stays as recorded, and it says so.
    await shadowlap(['fix', 'pr', fixId, PR]);
    const unknown = await shadowlap(['fix', 'pr', fixId], 'DRAFT');
    expect(unknown.code, unknown.out).toBe(0);
    expect(unknown.stdout).toContain('PR #138 open');
    expect(unknown.stdout).toContain('gh could not read it, so its state is as recorded');
    const missing = await shadowlap(['fix', 'pr', 'fx-NOPE']);
    expect(missing.code).toBe(1);
  });

  it('asks gh only about a pull request on github.com or a host of this project, which a pulled fix may not name', async () => {
    await shadowlap(['fix', 'pr', fixId, 'https://evil.example/acme/support-agent/pull/7']);
    const r = await shadowlap(['fix', 'pr', fixId]);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toContain("PR #7 open · evil.example is neither github.com, GH_HOST nor this project's origin, so gh isn't asked and its state is as recorded");
    expect(existsSync(join(bin, 'asked'))).toBe(false);
  });
});
