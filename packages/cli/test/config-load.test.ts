import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

/** loadConfig's lists of rules: checked when a command first reads them, and otherwise plain properties. */
let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'sl-config-load-'));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

const write = (data: unknown) => writeFileSync(join(cwd, 'shadowlap.config.json'), JSON.stringify(data));

describe('loadConfig', () => {
  it('checks each list of rules when it is first read, naming a broken rule', () => {
    write({ normalize: [{ path: '$.a', replace: '<A>' }], redact: [{ pattern: 'emial', replace: 'x' }] });
    const config = loadConfig(cwd);
    expect(config.normalize).toEqual([{ path: '$.a', replace: '<A>' }]);
    expect(() => config.redact).toThrow(/shadowlap\.config\.json: redaction rule #1: unknown pattern "emial"/);
  });

  it('lets a command replace a list, to put rules in front of the project\'s', () => {
    write({ redact: [{ pattern: 'email', replace: '<EMAIL>' }] });
    const config = loadConfig(cwd);
    const org = { kind: 'tool' as const, path: '$.args.iban', replace: '<IBAN>' };
    config.redact = [org, ...config.redact];
    expect(config.redact).toEqual([org, { pattern: 'email', replace: '<EMAIL>' }]);
    config.normalize = [];
    expect(config.normalize).toEqual([]);
    // It copies and serializes as plain data.
    expect(JSON.parse(JSON.stringify(config))).toEqual({ normalize: [], redact: [org, { pattern: 'email', replace: '<EMAIL>' }] });
    expect({ ...config }.redact).toHaveLength(2);

    // Replacing a broken list never reads it.
    write({ redact: [{ pattern: 'emial', replace: 'x' }] });
    const broken = loadConfig(cwd);
    broken.redact = [org];
    expect(broken.redact).toEqual([org]);
  });

  it('reads a missing file as no rules', () => {
    expect(loadConfig(cwd)).toEqual({ normalize: [], redact: [] });
  });
});
