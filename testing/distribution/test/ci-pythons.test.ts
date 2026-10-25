import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The network guard and in-process capture run in an agent's own Python, any version the SDK
 * supports, and patch what changes between versions: CI runs their tests on the oldest the SDK
 * supports and the newest it is tested on, not on the test job's 3.12 alone.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
const pyproject = readFileSync(join(ROOT, 'sdks', 'python', 'pyproject.toml'), 'utf8');

/** A job of ci.yml, its lines up to the next job. */
function job(name: string): string {
  const lines = ci.split(/\r?\n/);
  const start = lines.indexOf(`  ${name}:`);
  if (start < 0) return '';
  const end = lines.findIndex((l, i) => i > start && /^ {2}[\w-]+:\s*$/.test(l));
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

/** The Python versions of a job's matrix. */
const pythons = (block: string): string[] => (/^\s+python: \[([^\]]*)\]/m.exec(block)?.[1] ?? '').split(',').map((v) => v.trim().replace(/^'|'$/g, '')).filter(Boolean);
const minor = (v: string) => Number(v.split('.')[1]);

describe("the Pythons CI runs the guard's tests on", () => {
  it('are the oldest the SDK supports and the newest its own tests run on, beside the test job', () => {
    const floor = /^requires-python = ">=(\d+\.\d+)"$/m.exec(pyproject)?.[1];
    expect(floor).toBeDefined();
    const newest = pythons(job('python-sdk'))
      .filter((v) => !v.endsWith('t'))
      .sort((a, b) => minor(a) - minor(b))
      .at(-1);
    const guard = job('python-guard');
    for (const suite of ['guard.test.ts', 'guard-hosts.test.ts', 'guard-udp-async.test.ts', 'python-capture-async.test.ts']) expect(guard).toContain(`packages/cli/test/${suite}`);
    expect(pythons(guard)).toEqual(expect.arrayContaining([floor, newest]));
    // Every version between them, but the test job's own.
    const tested = new Set([...pythons(guard), /python-version: '(\d+\.\d+)'/.exec(job('test'))?.[1]]);
    for (let m = minor(floor!); m <= minor(newest!); m++) expect(tested, `3.${m}`).toContain(`3.${m}`);
  });
});
