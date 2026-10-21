import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONFIG_FILE,
  ConfigBusyError,
  ConfigConflictError,
  ConfigFileError,
  NO_CONFIG,
  RuleError,
  addRule,
  addRules,
  configClock,
  editConfigFile,
  editWhenFree,
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
/** A process id no process has: past macOS's ids, at the very top of Linux's, and no multiple of four, as every Windows one is. */
const GONE = 2 ** 22 - 7;

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
    // A cleared "Replace with" field is no replacement given, never an empty one that would delete what it matches.
    expect(validateRule('redact', { pattern: 'email', replace: '' })).toEqual({ pattern: 'email', replace: '<REDACTED>' });
    expect(validateRule('normalize', { path: '$.a', replace: null })).toEqual({ path: '$.a', replace: '<MASKED>' });
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
      ['redact', { pattern: 'email', replace: '[$&]' }, /copies matched text back \(\$&\)/],
      // A capture that is the whole match puts the secret back: "key [sk-abc123] end".
      ['redact', { pattern: '/(sk-[a-z0-9]+)/', replace: '[$1]' }, /copies matched text back \(\$1\)/],
      ['redact', { pattern: '/(?<k>sk-[a-z0-9]+)/', replace: '<$<k>>' }, /copies matched text back \(\$<name>\)/],
      ['redact', { pattern: '/key=\\w+/', replace: "$'" }, /copies matched text back/],
      // Matching no text inserts the replacement and masks nothing.
      ['normalize', { pattern: '/(?<=a)/' }, /can match without matching any text/],
      ['redact', { pattern: '/(?=sk-)/', replace: '<KEY>' }, /can match without matching any text \(in "\/\(\?=sk-\)\/"\)/],
      ['normalize', { pattern: '/\\b/' }, /can match without matching any text/],
      // The whole request with no pattern: every call would look the same.
      ['normalize', { path: '$' }, /\$ with no pattern replaces the whole of every request/],
      ['redact', { kind: 'api', path: '$', replace: '<R>' }, /replaces the whole of every api request/],
      ['normalize', 'uuid', /a rule is an object/],
    ];
    for (const [list, input, message] of bad) {
      expect(() => validateRule(list, input), JSON.stringify(input)).toThrow(RuleError);
      expect(() => validateRule(list, input), JSON.stringify(input)).toThrow(message);
    }
    // Idempotent replacements are fine, even when the pattern matches them: /.+/ turns <KEY> into <KEY>.
    expect(validateRule('redact', { kind: 'tool', path: '$.args.api_key', pattern: '/.+/', replace: '<KEY>' })).toMatchObject({ pattern: '/.+/' });
    // A literal dollar sign, a lookbehind that keeps the context, a normalizer that keeps a prefix.
    expect(validateRule('redact', { pattern: '/(?<=key=)\\w+/', replace: '$$<KEY>' }).replace).toBe('$$<KEY>');
    expect(validateRule('normalize', { pattern: '/(user_)\\d+/', replace: '$1<N>' }).replace).toBe('$1<N>');
    // The whole request of one named tool, or the whole request through a pattern.
    expect(validateRule('normalize', { kind: 'tool', name: 'get_time', path: '$' })).toEqual({ kind: 'tool', name: 'get_time', path: '$', replace: '<MASKED>' });
    expect(validateRule('redact', { path: '$', pattern: 'email' })).toMatchObject({ path: '$', pattern: 'email' });
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

  it('applies no length limit to the rules in the file, only to what a form or a command line sends', () => {
    const long = `/${Array.from({ length: 1500 }, (_, i) => `name${i}`).join('|')}/`;
    expect(long.length).toBeGreaterThan(10_000);
    expect(parseRules([{ pattern: long, replace: '<NAME>' }, { name: `tool\n${'x'.repeat(300)}`, path: '$.a', replace: 'y'.repeat(600) }], 'redact')).toHaveLength(2);
    expect(() => validateRule('redact', { pattern: long, replace: '<NAME>' })).toThrow(/pattern must be at most 10000 characters/);
    expect(validateRule('redact', { pattern: `/${Array.from({ length: 300 }, (_, i) => `name${i}`).join('|')}/`, replace: '<NAME>' }).pattern!.length).toBeGreaterThan(2000);
  });
});

describe('addRules and removeRule', () => {
  it('appends to the list and keeps every other key, its place and the file layout', () => {
    write('{\n    "$schema": "https://example/schema.json",\n    "normalize": [],\n    "tests": { "goldens/*": { "expect": { "tools": { "send_email": 0 } } } },\n    "future": 1\n}\n');
    const r = addRule(cwd, 'normalize', { kind: 'api', path: '$.metadata.user_id', pattern: 'uuid', replace: '<UUID>' });
    expect(r).toMatchObject({ n: 1, added: true, rule: { kind: 'api', path: '$.metadata.user_id', pattern: 'uuid', replace: '<UUID>' } });
    // The activity line names a normalizer by its path and carries the rule as stored.
    expect(r.event).toEqual({ kind: 'normalizer.added', ref: '$.metadata.user_id', data: { kind: 'api', path: '$.metadata.user_id', pattern: 'uuid', replace: '<UUID>' } });
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

  it('creates no file for an edit that changes nothing', () => {
    expect(addRules(cwd, 'normalize', [])).toMatchObject({ rules: [], events: [] });
    expect(editConfigFile(cwd, {}, () => 'looked').changed).toBe(false);
    expect(existsSync(file())).toBe(false);
  });

  it('adds several in one write, with an event for each one added', () => {
    addRule(cwd, 'normalize', { path: '$.a', replace: '<A>' });
    const r = addRules(cwd, 'normalize', [
      { path: '$.a', replace: '<A>' },
      { path: '$.b', replace: '<B>' },
      { kind: 'tool', name: 'save', path: '$.args.path', pattern: '/\\/tmp\\/x-[A-Za-z0-9_]+/', replace: '<VAR>' },
    ]);
    expect(r.rules.map((x) => [x.n, x.added])).toEqual([[1, false], [2, true], [3, true]]);
    expect(r.events.map((e) => [e.kind, e.ref])).toEqual([['normalizer.added', '$.b'], ['normalizer.added', '$.args.path']]);
    expect(r.events[1]!.data).toEqual({ kind: 'tool', name: 'save', path: '$.args.path', pattern: '/\\/tmp\\/x-[A-Za-z0-9_]+/', replace: '<VAR>' });
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
    // A redaction rule's event names it by what it puts in place, without its pattern: that can hold what it hides.
    expect(removeRule(cwd, 'redact', 'email')).toMatchObject({ n: 1, rule: { pattern: 'email' }, event: { kind: 'redaction.removed', ref: '<EMAIL>', data: { replace: '<EMAIL>' } } });
    const card = removeRule(cwd, 'redact', 'charge');
    expect(card).toMatchObject({ n: 1, rule: { name: 'charge' } });
    expect(card.event).toEqual({ kind: 'redaction.removed', ref: '<CARD>', data: { kind: 'tool', name: 'charge', path: '$.args.card', replace: '<CARD>' } });
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
    expect(() => addRule(cwd, 'normalize', { path: '$.a', replace: '<A>' })).toThrow(/being edited by another command; try again \(if no Shadowlap command is running, delete .*shadowlap\.config\.json\.lock\)$/);
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
      expect(() => addRule(cwd, 'normalize', { path: '$.b', replace: '<B>' }, { wait: 100 })).toThrow(ConfigBusyError);
      return 'done';
    });
    expect(result).toBe('done');
    expect(addRule(cwd, 'normalize', { path: '$.b', replace: '<B>' }).n).toBe(2);
  }, 10_000);

  it('takes over a lock whose writer is gone at once, and removes only its own lock', () => {
    writeFileSync(`${file()}.lock`, JSON.stringify({ pid: GONE, host: hostname(), token: 'x' }));
    const started = Date.now();
    expect(addRule(cwd, 'normalize', { path: '$.a', replace: '<A>' }).added).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(existsSync(`${file()}.lock`)).toBe(false);

    // A lock someone else holds now (here: taken over while this edit ran) is theirs to remove.
    const theirs = JSON.stringify({ pid: process.pid, host: hostname(), token: 'theirs' });
    editConfigFile(cwd, {}, (data) => {
      writeFileSync(`${file()}.lock`, theirs);
      data.clock = 'exact';
    });
    expect(readFileSync(`${file()}.lock`, 'utf8')).toBe(theirs);
    // Held by a live process and fresh: a server's edit doesn't wait, it is told to try again.
    expect(() => addRule(cwd, 'normalize', { path: '$.b', replace: '<B>' }, { wait: 0 })).toThrow(ConfigBusyError);
    expect(() => addRule(cwd, 'normalize', { path: '$.b', replace: '<B>' }, { wait: 0 })).toThrow(/being edited by another command; try again/);
  });

  it('lets a server wait for the lock without blocking', async () => {
    writeFileSync(`${file()}.lock`, JSON.stringify({ pid: process.pid, host: hostname(), token: 'other' }));
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    setTimeout(() => rmSync(`${file()}.lock`), 150);
    const r = await editWhenFree((o) => addRule(cwd, 'redact', { pattern: 'email' }, { ...o, expect: NO_CONFIG }));
    clearInterval(timer);
    expect(r.added).toBe(true);
    // Timers ran while it waited: a blocking wait would have let none fire.
    expect(ticks).toBeGreaterThan(0);
    // Still busy when the time is up: the edit is refused, and a conflict isn't retried.
    writeFileSync(`${file()}.lock`, JSON.stringify({ pid: process.pid, host: hostname(), token: 'other' }));
    await expect(editWhenFree((o) => addRule(cwd, 'redact', { pattern: 'uuid' }, o), 50)).rejects.toThrow(ConfigBusyError);
    rmSync(`${file()}.lock`);
    await expect(editWhenFree((o) => addRule(cwd, 'redact', { pattern: 'uuid' }, { ...o, expect: NO_CONFIG }))).rejects.toThrow(/changed since it was read/);
  });

  it('keeps every rule when many processes add one at once, with a lock left by a crash in the way', async () => {
    const engine = fileURLToPath(new URL('../dist/index.js', import.meta.url));
    writeFileSync(`${file()}.lock`, JSON.stringify({ pid: GONE, host: hostname(), token: 'crashed' }));
    const script = (i: number) => `const { addRule } = await import(${JSON.stringify(`file://${engine}`)}); addRule(${JSON.stringify(cwd)}, 'normalize', { path: '$.field${i}', replace: '<F${i}>' }, { wait: 20000 });`;
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => new Promise<[number | null, string]>((resolve) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', script(i)], { stdio: ['ignore', 'ignore', 'pipe'] });
        let err = '';
        child.stderr.on('data', (d: Buffer) => (err += d.toString()));
        child.on('close', (code) => resolve([code, err]));
      })),
    );
    expect(results.filter(([code]) => code !== 0)).toEqual([]);
    const paths = (json().normalize as Array<{ path: string }>).map((r) => r.path).sort();
    expect(paths).toEqual(Array.from({ length: 12 }, (_, i) => `$.field${i}`).sort());
    expect(readdirSync(cwd)).toEqual([CONFIG_FILE]);
  }, 30_000);

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

  it('says so when the folder or the file cannot be written, and leaves both as they were', () => {
    // Permissions don't bind root, and Windows has none of these.
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    write('{ "normalize": [] }\n');
    chmodSync(cwd, 0o555);
    try {
      expect(() => addRule(cwd, 'normalize', { path: '$.a' })).toThrow(ConfigFileError);
      expect(() => addRule(cwd, 'normalize', { path: '$.a' })).toThrow(/its folder .* is not writable \(EACCES\), and an edit writes a lock file and a temporary file beside it/);
    } finally {
      chmodSync(cwd, 0o755);
    }
    expect(readdirSync(cwd)).toEqual([CONFIG_FILE]);
    // A config its owner made read-only stays read-only: a rename would replace it regardless.
    chmodSync(file(), 0o444);
    expect(() => setClock(cwd, 'exact')).toThrow(/shadowlap\.config\.json is read-only/);
    expect(json()).toEqual({ normalize: [] });
    expect(readdirSync(cwd)).toEqual([CONFIG_FILE]);
  });
});

describe('setClock', () => {
  it('writes auto or exact, reports no change when it already says so, and refuses anything else', () => {
    expect(configClock(readConfigFile(cwd))).toEqual({ mode: 'auto', explicit: false });
    const r = setClock(cwd, 'exact');
    expect(r).toMatchObject({ clock: 'exact', changed: true, event: { kind: 'clock.set', ref: 'exact', data: { clock: 'exact', was: null } } });
    expect(configClock(readConfigFile(cwd))).toEqual({ mode: 'exact', explicit: true });
    expect(setClock(cwd, 'exact')).toMatchObject({ changed: false, event: null });
    expect(setClock(cwd, 'auto').event?.data).toEqual({ clock: 'auto', was: 'exact' });
    expect(() => setClock(cwd, 'fast')).toThrow(/clock must be "auto" or "exact"/);
    expect(existsSync(`${file()}.lock`)).toBe(false);
  });
});
