import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONFIG_FILE,
  ConfigConflictError,
  ConfigFileError,
  NO_CONFIG,
  RuleError,
  addRule,
  addRules,
  configClock,
  editConfigFile,
  findRule,
  parseRules,
  readConfigFile,
  readRules,
  removeRule,
  setClock,
  validateRule,
} from '../src/config-file.js';

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'sl-config-'));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

const file = () => join(cwd, CONFIG_FILE);
const write = (text: string) => writeFileSync(file(), text);
const read = () => readFileSync(file(), 'utf8');
const json = () => JSON.parse(read()) as Record<string, unknown>;

describe('readConfigFile', () => {
  it('reads a missing file as empty, with a version that says so', () => {
    expect(readConfigFile(cwd)).toMatchObject({ exists: false, version: NO_CONFIG, data: {} });
  });

  it('versions the bytes, keeps every key, and remembers the layout', () => {
    write('{\n    "$schema": "x",\n    "future": { "a": 1 }\r\n}\r\n');
    const f = readConfigFile(cwd);
    expect(f.exists).toBe(true);
    expect(f.version).toMatch(/^[0-9a-f]{64}$/);
    expect(f.data).toEqual({ $schema: 'x', future: { a: 1 } });
    expect(f.format).toEqual({ indent: '    ', eol: '\r\n' });
    write('{}');
    expect(readConfigFile(cwd).version).not.toBe(f.version);
  });

  it('reads an empty file as an empty config and refuses one that is not a JSON object', () => {
    write('  \n');
    expect(readConfigFile(cwd).data).toEqual({});
    write('{ "normalize": [ }');
    expect(() => readConfigFile(cwd)).toThrow(ConfigFileError);
    expect(() => readConfigFile(cwd)).toThrow(/shadowlap\.config\.json: not valid JSON/);
    write('[]');
    expect(() => readConfigFile(cwd)).toThrow(/must hold a JSON object/);
  });
});

describe('validateRule', () => {
  it('takes every form the add commands take', () => {
    for (const pattern of ['uuid', 'ulid', 'iso-date', 'iso-datetime', 'number', 'email', '/req_[a-z0-9]+/i']) {
      expect(validateRule('normalize', { pattern, replace: '<X>' })).toEqual({ pattern, replace: '<X>' });
    }
    // A tool name for tool scope, and a path with no pattern, which replaces the whole value.
    expect(validateRule('normalize', { kind: 'tool', name: 'create_ticket', path: '$.args.idempotency_key', replace: '<ID>' })).toEqual({ kind: 'tool', name: 'create_ticket', path: '$.args.idempotency_key', replace: '<ID>' });
    // Empty form fields mean "not given", and the replacement has a default per list.
    expect(validateRule('normalize', { kind: '', name: '', path: '$.metadata.user_id', pattern: '' })).toEqual({ path: '$.metadata.user_id', replace: '<MASKED>' });
    expect(validateRule('redact', { pattern: 'email' })).toEqual({ pattern: 'email', replace: '<REDACTED>' });
  });

  it('refuses what the CLI refuses, in its words', () => {
    const bad: Array<[Parameters<typeof validateRule>[0], unknown, RegExp]> = [
      ['normalize', { replace: '<X>' }, /a path, a pattern or both/],
      ['normalize', { pattern: 'uuidd' }, /unknown pattern "uuidd": use one of iso-datetime, iso-date, uuid, ulid, number, email/],
      ['normalize', { pattern: '/(/' }, /Invalid regular expression/],
      ['normalize', { pattern: '/a/x' }, /Invalid flags/],
      ['normalize', { path: 'metadata.user_id' }, /must start with "\$"/],
      ['normalize', { kind: 'tools', path: '$.args' }, /kind must be one of api, tool, clock, random/],
      ['redact', { kind: 'clock', pattern: 'email' }, /kind must be one of api, tool$/],
      ['normalize', { name: '  ', path: '$.a' }, /name must be a tool name/],
      ['normalize', { path: '$.a', replace: 5 }, /replace must be text/],
      ['normalize', { path: '$.a', extra: 1 }, /no field extra/],
      ['normalize', { pattern: '/x*/' }, /matches an empty string/],
      ['redact', { pattern: 'number', replace: 'n0 and 1' }, /would rewrite its own replacement/],
      ['redact', { pattern: 'email', replace: '[$&]' }, /puts the matched text back/],
      ['normalize', 'uuid', /a rule is an object/],
    ];
    for (const [list, input, message] of bad) {
      expect(() => validateRule(list, input), JSON.stringify(input)).toThrow(RuleError);
      expect(() => validateRule(list, input), JSON.stringify(input)).toThrow(message);
    }
    // Idempotent replacements are fine, even when the pattern matches them: /.+/ turns <KEY> into <KEY>.
    expect(validateRule('redact', { kind: 'tool', path: '$.args.api_key', pattern: '/.+/', replace: '<KEY>' })).toMatchObject({ pattern: '/.+/' });
  });
});

describe('parseRules', () => {
  it('checks the rules in the file and names a broken one by its number', () => {
    expect(parseRules(undefined, 'normalize')).toEqual([]);
    expect(parseRules([{ path: '$.a', replace: '<A>', addedLater: true }], 'normalize')).toEqual([{ path: '$.a', replace: '<A>', addedLater: true }]);
    expect(() => parseRules([{ path: '$.a', replace: '<A>' }, { pattern: 'uuidd', replace: '<B>' }], 'normalize')).toThrow(/shadowlap\.config\.json: normalizer #2: unknown pattern "uuidd"/);
    expect(() => parseRules([{ path: '', replace: '<A>' }], 'redact')).toThrow(/redaction rule #1: path must start/);
    expect(() => parseRules({}, 'redact')).toThrow(/redact must be a list of rules/);
    // A scope the schema allows is loaded, even where `redact add` doesn't offer it.
    expect(parseRules([{ kind: 'random', pattern: 'number', replace: '0' }], 'redact')).toHaveLength(1);
  });
});

describe('addRules and removeRule', () => {
  it('appends to the list and keeps every other key, its place and the file layout', () => {
    write('{\n    "$schema": "https://example/schema.json",\n    "normalize": [],\n    "tests": { "goldens/*": { "expect": { "tools": { "send_email": 0 } } } },\n    "future": 1\n}\n');
    const r = addRule(cwd, 'normalize', { kind: 'api', path: '$.metadata.user_id', pattern: 'uuid', replace: '<UUID>' });
    expect(r).toMatchObject({ n: 1, added: true, rule: { kind: 'api', path: '$.metadata.user_id', pattern: 'uuid', replace: '<UUID>' } });
    expect(r.event).toEqual({ kind: 'normalizer.added', ref: CONFIG_FILE, data: { rule: r.rule, n: 1 } });
    expect(Object.keys(json())).toEqual(['$schema', 'normalize', 'tests', 'future']);
    expect(read()).toMatch(/^\{\n {4}"\$schema"/);
    expect(read().endsWith('}\n')).toBe(true);
    expect(r.file.version).toBe(readConfigFile(cwd).version);

    // A list the file doesn't have yet goes at the end.
    addRule(cwd, 'redact', { pattern: 'email', replace: '<EMAIL>' });
    expect(Object.keys(json())).toEqual(['$schema', 'normalize', 'tests', 'future', 'redact']);
  });

  it('creates the file when there is none, and leaves it alone when the rule is already there', () => {
    const first = addRule(cwd, 'redact', { pattern: 'email', replace: '<EMAIL>' });
    expect(first.added).toBe(true);
    expect(json()).toEqual({ redact: [{ pattern: 'email', replace: '<EMAIL>' }] });
    const before = statSync(file()).mtimeMs;
    const again = addRule(cwd, 'redact', { pattern: 'email', replace: '<EMAIL>', path: '' });
    expect(again).toMatchObject({ added: false, n: 1, event: null });
    expect(statSync(file()).mtimeMs).toBe(before);
  });

  it('adds several in one write, with an event for each one added', () => {
    addRule(cwd, 'normalize', { path: '$.a', replace: '<A>' });
    const r = addRules(cwd, 'normalize', [
      { path: '$.a', replace: '<A>' },
      { path: '$.b', replace: '<B>' },
      { kind: 'tool', name: 'save', path: '$.args.path', pattern: '/\\/tmp\\/x-[A-Za-z0-9_]+/', replace: '<VAR>' },
    ]);
    expect(r.rules.map((x) => [x.n, x.added])).toEqual([[1, false], [2, true], [3, true]]);
    expect(r.events.map((e) => [e.kind, e.data.n])).toEqual([['normalizer.added', 2], ['normalizer.added', 3]]);
    // Nothing is written if one of them is refused.
    expect(() => addRules(cwd, 'normalize', [{ path: '$.c', replace: '<C>' }, { pattern: 'nope' }])).toThrow(RuleError);
    expect((json().normalize as unknown[]).length).toBe(3);
  });

  it('removes by number, by #number, or by the name, path or pattern of exactly one rule', () => {
    addRules(cwd, 'redact', [
      { pattern: 'email', replace: '<EMAIL>' },
      { kind: 'tool', name: 'charge', path: '$.args.card', pattern: '/\\d{12,19}/', replace: '<CARD>' },
      { kind: 'tool', path: '$.args.api_key', pattern: '/.+/', replace: '<KEY>' },
      { pattern: 'uuid', replace: '<UUID>' },
    ]);
    expect(removeRule(cwd, 'redact', 'email')).toMatchObject({ n: 1, rule: { pattern: 'email' }, event: { kind: 'redaction.removed', data: { n: 1, rule: { pattern: 'email' } } } });
    expect(removeRule(cwd, 'redact', 'charge')).toMatchObject({ n: 1, rule: { name: 'charge' } });
    expect(removeRule(cwd, 'redact', '$.args.api_key')).toMatchObject({ n: 1 });
    expect(removeRule(cwd, 'redact', '#1')).toMatchObject({ rule: { pattern: 'uuid' } });
    expect(json().redact).toEqual([]);

    addRules(cwd, 'normalize', [{ path: '$.a', replace: '<A>' }, { path: '$.a', pattern: 'uuid', replace: '<U>' }]);
    expect(() => removeRule(cwd, 'normalize', '$.a')).toThrow(/matches normalizers #1, #2; remove one by its number/);
    expect(() => removeRule(cwd, 'normalize', '3')).toThrow(/there is no normalizer #3: shadowlap\.config\.json has 2 \(shadowlap normalize ls\)/);
    expect(() => removeRule(cwd, 'normalize', 'nothing-like-it')).toThrow(/no normalizer has the name, path or pattern "nothing-like-it"/);
    expect(() => removeRule(cwd, 'redact', 1)).toThrow(/has no redaction rules/);
    expect(removeRule(cwd, 'normalize', 2).rule).toEqual({ path: '$.a', pattern: 'uuid', replace: '<U>' });
  });

  it('removes a broken rule too, so a config that no longer loads can be fixed with rm', () => {
    write(JSON.stringify({ normalize: [{ pattern: 'uuidd', replace: '<X>' }, 'junk'] }));
    expect(readRules(readConfigFile(cwd), 'normalize').map((r) => r.error)).toEqual([expect.stringMatching(/unknown pattern/), 'it is not an object']);
    expect(removeRule(cwd, 'normalize', 2).rule).toBe('junk');
    expect(removeRule(cwd, 'normalize', 'uuidd').n).toBe(1);
  });

  it('refuses to edit a list that is not a list', () => {
    write('{ "normalize": { "path": "$.a" } }');
    expect(() => addRule(cwd, 'normalize', { path: '$.b', replace: '<B>' })).toThrow(/normalize must be a list of rules; fix it/);
  });

  it('finds rules for rm without touching the file', () => {
    const rules = [{ path: '$.a', replace: '1' }, { name: 'send_email', path: '$.args.to', replace: '2' }];
    expect(findRule('normalize', rules, ' 2 ')).toBe(1);
    expect(findRule('normalize', rules, 'send_email')).toBe(1);
    expect(findRule('normalize', rules, '$.a')).toBe(0);
  });
});

describe('versions and concurrent writers', () => {
  it('refuses an edit based on a version the file no longer has', () => {
    const seen = readConfigFile(cwd).version;
    expect(seen).toBe(NO_CONFIG);
    addRule(cwd, 'normalize', { path: '$.a', replace: '<A>' }, { expect: seen });
    // The page still shows the old list: removing "#1" from it must not remove what someone added since.
    expect(() => removeRule(cwd, 'normalize', 1, { expect: seen })).toThrow(ConfigConflictError);
    expect(() => removeRule(cwd, 'normalize', 1, { expect: seen })).toThrow(/changed since it was read; reload it/);
    const now = readConfigFile(cwd).version;
    expect(removeRule(cwd, 'normalize', 1, { expect: now }).n).toBe(1);
    expect(() => setClock(cwd, 'exact', { expect: now })).toThrow(ConfigConflictError);
  });

  it('waits for another writer, takes over a lock left by a crash, and leaves no temporary files', () => {
    writeFileSync(`${file()}.lock`, '');
    const started = Date.now();
    expect(() => addRule(cwd, 'normalize', { path: '$.a', replace: '<A>' })).toThrow(/being edited by another command; try again/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1500);
    // A lock nobody touched for a while is from a writer that died holding it.
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(`${file()}.lock`, old, old);
    expect(addRule(cwd, 'normalize', { path: '$.a', replace: '<A>' }).added).toBe(true);
    expect(readdirSync(cwd)).toEqual([CONFIG_FILE]);
  });

  it('runs one edit at a time: the second sees the first', () => {
    const { result } = editConfigFile(cwd, {}, (data) => {
      data.normalize = [{ path: '$.a', replace: '<A>' }];
      // A writer that started meanwhile has to wait for the lock rather than read the old file.
      expect(() => addRule(cwd, 'normalize', { path: '$.b', replace: '<B>' })).toThrow(ConfigConflictError);
      return 'done';
    });
    expect(result).toBe('done');
    expect(addRule(cwd, 'normalize', { path: '$.b', replace: '<B>' }).n).toBe(2);
  }, 10_000);

  it('writes through a symbolic link and keeps the file mode', () => {
    if (process.platform === 'win32') return;
    const real = join(cwd, 'shared.json');
    writeFileSync(real, '{}\n');
    chmodSync(real, 0o640);
    symlinkSync(real, file());
    setClock(cwd, 'exact');
    expect(JSON.parse(readFileSync(real, 'utf8'))).toEqual({ clock: 'exact' });
    expect(statSync(real).mode & 0o777).toBe(0o640);
    expect(readdirSync(cwd).sort()).toEqual([CONFIG_FILE, 'shared.json']);
  });
});

describe('setClock', () => {
  it('writes auto or exact, reports no change when it already says so, and refuses anything else', () => {
    expect(configClock(readConfigFile(cwd))).toEqual({ mode: 'auto', explicit: false });
    const r = setClock(cwd, 'exact');
    expect(r).toMatchObject({ clock: 'exact', changed: true, event: { kind: 'clock.set', ref: CONFIG_FILE, data: { clock: 'exact', was: null } } });
    expect(configClock(readConfigFile(cwd))).toEqual({ mode: 'exact', explicit: true });
    expect(setClock(cwd, 'exact')).toMatchObject({ changed: false, event: null });
    expect(setClock(cwd, 'auto').event?.data).toEqual({ clock: 'auto', was: 'exact' });
    expect(() => setClock(cwd, 'fast')).toThrow(/clock must be "auto" or "exact"/);
    expect(existsSync(`${file()}.lock`)).toBe(false);
  });
});
