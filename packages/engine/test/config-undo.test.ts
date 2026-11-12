import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONFIG_FILE, ConfigConflictError, RuleError, addRule, readConfigFile, readRules, removeRule, restoreRule, setClock, validateRule } from '../src/config-file.js';

/**
 * The Undo of a Settings edit: a removed rule goes back at its number, as it was stored, and a
 * clock the file didn't have goes back to not having it. Either leaves the file byte for byte as it
 * was before the edit it undoes, under the same version, so the page's next edit still holds.
 */

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'sl-config-undo-'));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

const read = () => readFileSync(join(cwd, CONFIG_FILE), 'utf8');

describe('restoreRule', () => {
  it('puts a removed rule back at its number, the file byte for byte as it was', () => {
    addRule(cwd, 'normalize', { path: '$.body.id', pattern: 'uuid', replace: '<UUID>' });
    addRule(cwd, 'normalize', { kind: 'tool', name: 'send_email', path: '$.args.to', pattern: 'email' });
    addRule(cwd, 'normalize', { pattern: 'iso-date', replace: '<DATE>' });
    const before = read();
    const { version } = readConfigFile(cwd);
    const removed = removeRule(cwd, 'normalize', 2, { expect: version });
    expect(removed.n).toBe(2);
    const back = restoreRule(cwd, 'normalize', removed.n, removed.rule, { expect: removed.file.version });
    // The rule in the middle keeps its number, so the order rules apply in is the one it had.
    expect(back.n).toBe(2);
    expect(read()).toBe(before);
    expect(back.file.version).toBe(version);
    expect(back.event).toMatchObject({ kind: 'normalizer.added', ref: '$.args.to', data: { kind: 'tool', name: 'send_email', path: '$.args.to', pattern: 'email' } });
  });

  it('puts back a rule as it was stored, keys a newer version wrote included, and the last one into an emptied list', () => {
    writeFileSync(join(cwd, CONFIG_FILE), `${JSON.stringify({ redact: [{ pattern: 'email', replace: '<EMAIL>', since: '0.2' }] }, null, 2)}\n`);
    const before = read();
    const removed = removeRule(cwd, 'redact', 1);
    restoreRule(cwd, 'redact', 1, removed.rule, { expect: removed.file.version });
    expect(read()).toBe(before);
  });

  it('puts a number past the end last, and leaves a rule added again since where it is', () => {
    addRule(cwd, 'redact', { pattern: 'email', replace: '<EMAIL>' });
    const removed = removeRule(cwd, 'redact', 1);
    expect(restoreRule(cwd, 'redact', 5, removed.rule).n).toBe(1);
    const again = removeRule(cwd, 'redact', 1);
    addRule(cwd, 'redact', { pattern: 'uuid', replace: '<ID>' });
    addRule(cwd, 'redact', { pattern: 'email', replace: '<EMAIL>' });
    const same = restoreRule(cwd, 'redact', 1, again.rule);
    expect([same.n, same.event]).toEqual([2, null]);
    expect((JSON.parse(read()) as { redact: unknown[] }).redact).toHaveLength(2);
  });

  it('puts back any rule the file held without an error, one that `add` would refuse included', () => {
    // Each loads with no error (readRules), so Settings shows it and its Remove offers Undo; each is
    // refused as typed: a whole request with no pattern, a pattern that can match no text, a tab
    // in a tool name, matched text copied back into a redacted copy.
    const normalize = [{ path: '$', replace: '<ANY>' }, { path: '$.a', pattern: '/x*/', replace: '<X>' }, { name: 'send\temail', path: '$.args.to', replace: '<TO>' }];
    const redact = [{ pattern: '/key=(\\w+)/', replace: 'key=$1-masked' }];
    writeFileSync(join(cwd, CONFIG_FILE), `${JSON.stringify({ normalize, redact }, null, 2)}\n`);
    const before = read();
    for (const [list, rules] of [['normalize', normalize], ['redact', redact]] as const) {
      expect(readRules(readConfigFile(cwd), list).map((r) => r.error)).toEqual(rules.map(() => null));
      for (const [i, rule] of rules.entries()) {
        expect(() => validateRule(list, rule)).toThrow(RuleError);
        const removed = removeRule(cwd, list, i + 1);
        expect(restoreRule(cwd, list, removed.n, removed.rule, { expect: removed.file.version }).n).toBe(i + 1);
        expect(read()).toBe(before);
      }
    }
  });

  it('refuses a file that changed since, a rule the file couldn’t hold and a number that isn’t one', () => {
    addRule(cwd, 'normalize', { path: '$.body.id', pattern: 'uuid' });
    const removed = removeRule(cwd, 'normalize', 1);
    addRule(cwd, 'normalize', { pattern: 'iso-date' });
    expect(() => restoreRule(cwd, 'normalize', 1, removed.rule, { expect: removed.file.version })).toThrow(ConfigConflictError);
    // What a rule in the file can't be either: one with nothing to replace with, an empty path, a
    // pattern that doesn't compile, a kind no call has.
    for (const rule of [{ path: '$.body.id' }, { path: '', replace: '<X>' }, { pattern: '/(/', replace: '<X>' }, { kind: 'llm', pattern: 'uuid', replace: '<X>' }]) {
      expect(() => restoreRule(cwd, 'normalize', 1, rule)).toThrow(RuleError);
    }
    expect(() => restoreRule(cwd, 'normalize', 1, '$.body.id')).toThrow(RuleError);
    expect(() => restoreRule(cwd, 'normalize', 0, removed.rule)).toThrow(RuleError);
  });
});

describe('setClock', () => {
  it('says what it replaced, and takes the key out again with null', () => {
    writeFileSync(join(cwd, CONFIG_FILE), `${JSON.stringify({ normalize: [] }, null, 2)}\n`);
    const before = read();
    const { version } = readConfigFile(cwd);
    const set = setClock(cwd, 'exact', { expect: version });
    expect([set.clock, set.was, set.changed]).toEqual(['exact', null, true]);
    const back = setClock(cwd, set.was, { expect: set.file.version });
    expect([back.clock, back.was, back.changed]).toEqual(['auto', 'exact', true]);
    expect(back.event).toEqual({ kind: 'clock.set', ref: 'auto', data: { clock: 'auto', was: 'exact' } });
    expect(read()).toBe(before);
    expect(back.file.version).toBe(version);
    expect(() => setClock(cwd, 'soon')).toThrow(RuleError);
  });
});
