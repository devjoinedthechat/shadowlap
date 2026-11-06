import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { CHECKS_SEEN_FILE, keepSeenChecks } from '../src/checks-seen.js';

/**
 * In a run of the tests started at the repository's root, in this package's folder
 * (cd packages/dashboard && npx vitest run test/<file>) or in this one, what the dashboard keeps for
 * this machine goes in the test file's own Shadowlap home, a temporary folder. Never in the real
 * ~/.shadowlap. testing/distribution/test/home-guard.test.ts starts runs of this file in both
 * folders, with HOME a stand-in for the real home folder, which SHADOWLAP_STAND_IN_HOME names.
 */

const project = mkdtempSync(join(tmpdir(), 'sl-own-home-'));
afterAll(() => rmSync(project, { recursive: true, force: true }));
/** The project's one golden, its checks seen. */
const seen = new Map([['goldens/refund', { key: 'K-1', at: null }]]);
const inside = (path: string, folder: string) => {
  const rel = relative(folder, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};
const standIn = process.env.SHADOWLAP_STAND_IN_HOME;

describe("the dashboard's files for this machine, in a run of the tests", () => {
  it("go in the test file's own Shadowlap home, a temporary folder", () => {
    const home = process.env.SHADOWLAP_HOME ?? '';
    expect(isAbsolute(home), `SHADOWLAP_HOME is ${home || 'unset'}`).toBe(true);
    expect(inside(realpathSync.native(home), realpathSync.native(tmpdir())), home).toBe(true);
    expect(inside(home, join(homedir(), '.shadowlap')), home).toBe(false);
    expect(keepSeenChecks(project, seen)).toBe(true);
    const kept = JSON.parse(readFileSync(join(home, CHECKS_SEEN_FILE), 'utf8')) as { projects: Record<string, unknown> };
    expect(Object.keys(kept.projects)).toEqual([project]);
    // Where they went, for the run that started this one.
    if (process.env.SHADOWLAP_HOME_REPORT) writeFileSync(process.env.SHADOWLAP_HOME_REPORT, home);
  });

  // Only in a run whose HOME is the stand-in SHADOWLAP_STAND_IN_HOME names: there the write is refused,
  // so the dashboard goes on without the file, and this test fails, and the run with it.
  it.skipIf(standIn === undefined || homedir() !== standIn)("fail the run that writes them in the home folder's .shadowlap", () => {
    vi.stubEnv('SHADOWLAP_HOME', `${join(homedir(), '.shadowlap')}/`);
    const kept = keepSeenChecks(project, seen);
    vi.unstubAllEnvs();
    expect(kept).toBe(false);
  });
});
