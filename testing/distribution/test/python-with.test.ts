import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pythonCommand, pythonWith } from '../../python-with.mjs';

/**
 * The Python the tests run their Python cases with (testing/python-with.mjs). Without one that
 * imports what a case needs, the case skips; under CI, which installs everything they ask for, that
 * is a broken install, and the run fails on it instead of passing with the cases left out.
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
    expect(pythonCommand()).toBeNull();
    expect(pythonCommand('anthropic')).toBeNull();
  });

  it('fails under CI, naming what is missing, but for a package CI installs nowhere on this system', () => {
    nothingOnPath();
    process.env.CI = 'true';
    expect(() => pythonWith('aiohttp', 'websockets')).toThrow('no Python 3.9 or later here imports aiohttp, websockets, which CI installs for these tests (.github/workflows/ci.yml)');
    expect(() => pythonCommand('google.genai')).toThrow('no Python 3.9 or later here imports google.genai, which CI installs');
    expect(() => pythonCommand()).toThrow('no Python 3.9 or later is here, which CI installs');
    if (process.platform === 'win32') expect(pythonWith('uvloop')).toBeNull();
    else expect(() => pythonWith('uvloop')).toThrow('no Python 3.9 or later here imports uvloop');
  });

  it.skipIf(process.platform === 'win32')('runs SHADOWLAP_PYTHON before python3 and python, as the job that runs the guard on each Python sets it', () => {
    nothingOnPath();
    const dir = mkdtempSync(join(tmpdir(), 'sl-own-python-'));
    dirs.push(dir);
    const own = join(dir, 'own-python');
    writeFileSync(own, '#!/bin/sh\nexit 0\n');
    chmodSync(own, 0o755);
    process.env.SHADOWLAP_PYTHON = own;
    expect(pythonCommand('anthropic')).toBe(own);
    expect(pythonWith('aiohttp')).toEqual([own]);
  });
});
