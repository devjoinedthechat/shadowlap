import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findPython, importFailure } from '../../frameworks/python.mjs';

/**
 * The Python framework suites find their interpreter with findPython: a framework that isn't
 * installed skips its suite, but one that is and fails to import fails it, saying why, as does any
 * failure in the interpreter SHADOWLAP_PYTHON names, as CI names it. They once skipped on both.
 */

let dir: string;
const saved = { PATH: process.env.PATH, SHADOWLAP_PYTHON: process.env.SHADOWLAP_PYTHON };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sl-pythons-'));
  process.env.PATH = dir;
  delete process.env.SHADOWLAP_PYTHON;
});
afterEach(() => {
  process.env.PATH = saved.PATH;
  if (saved.SHADOWLAP_PYTHON === undefined) delete process.env.SHADOWLAP_PYTHON;
  else process.env.SHADOWLAP_PYTHON = saved.SHADOWLAP_PYTHON;
  rmSync(dir, { recursive: true, force: true });
});

/** A Python on the PATH as `name` whose `import` ends as `raised` says, or imports when it's null. */
function python(name: string, raised: string | null): string {
  const path = join(dir, name);
  const body = raised === null ? 'exit 0' : `printf 'Traceback (most recent call last):\\n  File "<string>", line 1, in <module>\\n%s\\n' "${raised}" >&2\nexit 1`;
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe.skipIf(process.platform === 'win32')('the Python a framework suite runs on', () => {
  it('skips a suite whose framework is not installed, and runs one where it imports', () => {
    python('python3', "ModuleNotFoundError: No module named 'crewai'");
    expect(importFailure('python3', 'crewai')).toEqual({ absent: true, why: "ModuleNotFoundError: No module named 'crewai'" });
    expect(findPython('crewai')).toBeNull();
    python('python', null);
    expect(findPython('crewai')).toBe('python');
    // A part of a framework counts as the framework.
    python('python3', "ModuleNotFoundError: No module named 'llama_index.core'");
    python('python', "ModuleNotFoundError: No module named 'llama_index'");
    expect(findPython('llama_index.core')).toBeNull();
  });

  it('fails a suite whose framework is installed but raises as it imports', () => {
    python('python3', "ImportError: cannot import name 'BaseModel' from 'pydantic'");
    expect(() => findPython('crewai')).toThrow("python3 has crewai but can't import it, so this suite can't run: ImportError: cannot import name 'BaseModel' from 'pydantic'");
    // A dependency of it that isn't there is no reason to skip either.
    python('python3', "ModuleNotFoundError: No module named 'pydantic'");
    expect(() => findPython('crewai')).toThrow("python3 has crewai but can't import it");
  });

  it('fails a suite whose framework the named interpreter can not import, installed or not', () => {
    process.env.SHADOWLAP_PYTHON = python('ci-python', "ModuleNotFoundError: No module named 'crewai'");
    expect(() => findPython('crewai')).toThrow(`SHADOWLAP_PYTHON=${process.env.SHADOWLAP_PYTHON} can't import crewai, so this suite can't run: ModuleNotFoundError: No module named 'crewai'`);
    process.env.SHADOWLAP_PYTHON = join(dir, 'not-there');
    expect(() => findPython('crewai')).toThrow("can't import crewai");
    process.env.SHADOWLAP_PYTHON = python('ci-python', null);
    expect(findPython('crewai')).toBe(process.env.SHADOWLAP_PYTHON);
  });

  it('takes what is no Python for none, as Windows store alias is', () => {
    const path = join(dir, 'python3');
    writeFileSync(path, '#!/bin/sh\necho "Python was not found; run without arguments to install from the Microsoft Store" >&2\nexit 9009\n');
    chmodSync(path, 0o755);
    expect(findPython('crewai')).toBeNull();
  });
});
