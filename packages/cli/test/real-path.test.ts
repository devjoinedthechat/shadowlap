import * as fs from 'node:fs';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { physicalPath, realPath } from '../src/real-path.js';
import { goldensInRepo } from '../src/repair.js';

/**
 * Paths compared as the system names them: links resolved, the letter case on disk, and on Windows
 * short names (C:\Users\RUNNER~1) written out, as git names a repository. Bisect checks its folder
 * is in the repository this way, and repair where `--goldens` puts recordings for a branch.
 */

/** Whether the temporary folder's volume ignores letter case, as macOS's and Windows' do by default. */
const CASE_INSENSITIVE = tmpdir() !== tmpdir().toUpperCase() && fs.existsSync(tmpdir().toUpperCase());

let base: string;
let repo: string;
let outside: string;

/** A link to a folder: a junction on Windows, which needs no privilege; elsewhere the type is ignored. */
const link = (target: string, path: string) => symlinkSync(target, path, 'junction');

beforeAll(() => {
  // The system's name for it, so expectations compare with what realPath gives.
  base = fs.realpathSync.native(mkdtempSync(join(tmpdir(), 'sl-real-path-')));
  repo = join(base, 'repo');
  outside = join(base, 'outside');
  mkdirSync(join(repo, 'tests', 'goldens'), { recursive: true });
  mkdirSync(outside);
  // A link outside the repository that leads into it, and one inside it that leads out.
  link(repo, join(base, 'via'));
  link(outside, join(repo, 'out'));
});
afterAll(() => rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
afterEach(() => vi.restoreAllMocks());

describe('realPath and physicalPath', () => {
  it('resolve links, and keep the part of a path that does not exist yet as it is given', () => {
    expect(realPath(join(base, 'via'))).toBe(repo);
    expect(physicalPath(join(base, 'via', 'tests', 'goldens'))).toBe(join(repo, 'tests', 'goldens'));
    expect(physicalPath(join(base, 'via', 'not-yet', 'there.json'))).toBe(join(repo, 'not-yet', 'there.json'));
  });

  it.skipIf(!CASE_INSENSITIVE)('give the case on disk for a folder named in another case, where the volume ignores case', () => {
    const other = join(dirname(repo), basename(repo).toUpperCase(), 'TESTS');
    expect(realPath(other)).toBe(join(repo, 'tests'));
    expect(physicalPath(join(other, 'not-yet'))).toBe(join(repo, 'tests', 'not-yet'));
  });

  it("fall back to Node's own realpath where the system's can't answer", () => {
    const native = vi.spyOn(fs.realpathSync, 'native').mockImplementation(() => {
      throw Object.assign(new Error('EISDIR: illegal operation on a directory, realpath'), { code: 'EISDIR' });
    });
    expect(realPath(join(base, 'via'))).toBe(fs.realpathSync(join(base, 'via')));
    expect(physicalPath(join(base, 'via', 'not-yet'))).toBe(join(fs.realpathSync(join(base, 'via')), 'not-yet'));
    expect(native).toHaveBeenCalled();
  });
});

describe("repair's --goldens, for a commit to --branch", () => {
  it('takes a folder in the repository however it is reached, and gives it from the repository', () => {
    expect(goldensInRepo(repo, repo, join('tests', 'goldens'))).toBe(join('tests', 'goldens'));
    expect(goldensInRepo(repo, base, join('via', 'tests', 'goldens'))).toBe(join('tests', 'goldens'));
    expect(goldensInRepo(repo, outside, join(base, 'via', 'tests', 'goldens'))).toBe(join('tests', 'goldens'));
    expect(goldensInRepo(repo, repo, join('goldens', 'not-yet'))).toBe(join('goldens', 'not-yet'));
  });

  it.skipIf(!CASE_INSENSITIVE)('takes the folder named in another case, where the volume ignores case', () => {
    expect(goldensInRepo(repo, base, join(basename(repo).toUpperCase(), 'TESTS', 'goldens'))).toBe(join('tests', 'goldens'));
  });

  it('refuses a folder outside the repository, a link in the repository that leads out included', () => {
    expect(() => goldensInRepo(repo, repo, join('..', 'outside'))).toThrow(`--goldens ${join('..', 'outside')} is outside the repository, so its recordings can't be committed to a branch`);
    expect(() => goldensInRepo(repo, repo, join('out', 'goldens'))).toThrow(`--goldens ${join('out', 'goldens')} is outside the repository`);
  });
});
