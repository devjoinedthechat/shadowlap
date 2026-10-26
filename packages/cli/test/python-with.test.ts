import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pythonWith } from './python-with.js';

/**
 * The Python the tests run their Python cases with. Without one that imports what a case needs, the
 * case skips; under CI, which installs everything they ask for, that is a broken install, and the run
 * fails on it instead of passing with the cases left out.
 */
describe('a Python for the tests', () => {
  const saved = { CI: process.env.CI, PATH: process.env.PATH, SHADOWLAP_PYTHON: process.env.SHADOWLAP_PYTHON };
  const dirs: string[] = [];
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  /** No python3, python or uv to be found. */
  const nothingOnPath = () => {
    const empty = mkdtempSync(join(tmpdir(), 'sl-no-python-'));
    dirs.push(empty);
    process.env.PATH = empty;
    delete process.env.SHADOWLAP_PYTHON;
  };

  it('is null where none imports what is asked, and a skip follows', () => {
    nothingOnPath();
    delete process.env.CI;
    expect(pythonWith('aiohttp')).toBeNull();
  });

  it('fails under CI, naming what is missing, but for a package CI installs nowhere on this system', () => {
    nothingOnPath();
    process.env.CI = 'true';
    expect(() => pythonWith('aiohttp', 'websockets')).toThrow('no Python here imports aiohttp, websockets, which CI installs for these tests (.github/workflows/ci.yml)');
    if (process.platform === 'win32') expect(pythonWith('uvloop')).toBeNull();
    else expect(() => pythonWith('uvloop')).toThrow('no Python here imports uvloop');
  });
});
