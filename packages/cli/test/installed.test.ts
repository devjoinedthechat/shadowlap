import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { installedGlobally } from '../src/installed.js';

const root = mkdtempSync(join(tmpdir(), 'shadowlap-installed-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A package folder at `path` under the scratch root, with a package.json at each of `manifests`. */
function at(path: string, manifests: string[] = []): string {
  const dir = join(root, path);
  mkdirSync(dir, { recursive: true });
  for (const m of manifests) writeFileSync(join(root, m, 'package.json'), '{}');
  return dir;
}

describe('installedGlobally', () => {
  it('takes a package in a node_modules folder no package.json sits beside as npm install -g put it', () => {
    expect(installedGlobally(at('usr/local/lib/node_modules/shadowlap'))).toBe(true);
    expect(installedGlobally(`${at('AppData/Roaming/npm/node_modules/shadowlap')}/`)).toBe(true);
  });

  it('takes a project’s copy, pnpm’s store and a clone as installed where they are', () => {
    mkdirSync(join(root, 'agent'), { recursive: true });
    expect(installedGlobally(at('agent/node_modules/shadowlap', ['agent']))).toBe(false);
    expect(installedGlobally(at('agent/node_modules/.pnpm/shadowlap@0.1.0/node_modules/shadowlap'))).toBe(false);
    expect(installedGlobally(at('shadowlap/packages/cli'))).toBe(false);
  });

  it('finds this repository’s CLI installed where it is', () => {
    expect(installedGlobally()).toBe(false);
    expect(installedGlobally(fileURLToPath(new URL('..', import.meta.url)))).toBe(false);
  });
});
