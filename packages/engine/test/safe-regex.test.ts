import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { applyNormalizers, compilePattern, namedPatterns, rewriteStringsDeep, rewriteText } from '../src/normalize.js';
import { rewriteJsonDocument } from '../src/json-doc.js';
import { unpackRun } from '../src/pack.js';
import { PackError } from '../src/pack-schema.js';
import { previewRedaction } from '../src/redact.js';
import { PATTERN_BUDGET_MS, PATTERN_MAX, PatternBudgetError, patternProblem, regexProblem, setPatternBudget } from '../src/safe-regex.js';
import { Store } from '../src/store.js';

/**
 * A rule's pattern runs on every string of every request and response, and a pack or the team store
 * carries patterns someone else wrote. One that could take time that grows exponentially with the
 * text is refused before anything compiles it.
 */

describe('the pattern check', () => {
  it('refuses the shapes that backtrack exponentially, saying which part and why', () => {
    const refused: Array<[string, string, RegExp]> = [
      ['(a+)+$', '', /"a\+" can stop or go on at "a" inside "\(a\+\)\+"/],
      ['(a*)*', '', /"a\*" can stop or go on at "a"/],
      ['^(\\d+)*$', '', /"\\d\+" can stop or go on at "0" inside "\(\\d\+\)\*"/],
      ['^(\\w+\\s?)*$', '', /"\\w\+" can stop or go on/],
      ['(?:\\d+,?)+', '', /"\\d\+" can stop or go on/],
      ['(x+x+)+y', '', /"x\+" can stop or go on at "x"/],
      ['(.*,)+', '', /"\.\*" can stop or go on at ","/],
      // A repetition bounded but long is as bad: (.*a){12} tries the text's length to the twelfth.
      ['(.*a){12}', '', /"\.\*" can stop or go on at "a" inside "\(\.\*a\)\{12\}"/],
      ['(?:a?){30}a{30}', '', /"a\?" can stop or go on at "a"/],
      ['([a-z]+[.-]?)+@', '', /"\[a-z\]\+" can stop or go on at "a"/],
      ['((a?))+', '', /"a\?" can stop or go on|repeats a part that can match nothing/],
      ['(?:(?:a?)*b)+', '', /"\(\?:a\?\)\*" repeats a part that can match nothing/],
      // Alternatives that can start alike, under a repetition.
      ['(a|a)*', '', /the alternatives "a" and "a" can both start with "a"/],
      ['(a|ab)*c', '', /the alternatives "a" and "ab" can both start with "a"/],
      ['(\\w|\\d)+', '', /the alternatives "\\w" and "\\d" can both start with "0"/],
      ['(?:A|a)+', 'i', /the alternatives "A" and "a" can both start with "A"/],
      ['(?:\\p{L}|\\p{Lu})+', 'u', /the alternatives "\\p\{L\}" and "\\p\{Lu\}" can both start with "A"/],
      // Inside a lookaround, which runs on its own: read right to left behind.
      ['(?=(a+)+b)', '', /"a\+" can stop or go on/],
      ['(?<=(a+)+b)c', '', /"a\+" can stop or go on/],
      // Written out with no repetition at all, the same blow-up: 2^25 ways.
      [`${'a?'.repeat(25)}${'a'.repeat(25)}`, '', /it holds 25 optional or alternative parts that the next character doesn't settle/],
      ['.*a.*b.*c.*d', '', /4 of its repeated parts \("\.\*", "\.\*", "\.\*", …\) can each stop or go on/],
      // Two such parts take the cube of a line's length: the review's, about 10 s on 4 KB each.
      ['.*a.*b', '', /2 of its repeated parts \("\.\*", "\.\*"\) can each stop or go on/],
      ['[a-z]*[a-z]*!', '', /2 of its repeated parts \("\[a-z\]\*", "\[a-z\]\*"\) can each stop or go on/],
      ['\\w*a\\w*b', '', /2 of its repeated parts \("\\w\*", "\\w\*"\) can each stop or go on/],
      // A part the next character settles, after one it can take the characters of, multiplies the same, groups or not.
      ['[^b]*a[^b]*b', '', /2 of its repeated parts \("\[\^b\]\*", "\[\^b\]\*"\)/],
      ['([a-z]*)([a-z]*)!', '', /2 of its repeated parts \("\[a-z\]\*", "\[a-z\]\*"\)/],
      // Backreferences.
      ['(a)\\1', '', /"\\1" refers back to a group/],
      ['(?<n>a)\\k<n>', '', /"\\k<n>" refers back to a group/],
      ['(a)\\1', 'u', /"\\1" refers back to a group/],
    ];
    for (const [source, flags, why] of refused) {
      const problem = regexProblem(source, flags);
      expect(problem, `/${source}/${flags}`).toMatch(why);
      expect(problem, `/${source}/${flags}`).toMatch(/^(matching it could take too long: )/);
    }
  });

  it('takes the patterns rules are written with, the docs\' among them', () => {
    const taken: Array<[string, string]> = [
      // The docs' examples.
      ['\\b(?:\\d[ -]?){13,16}\\b', ''],
      ['(?<=key=)\\w+', ''],
      ['(?<=--api-key )\\S+', ''],
      ['\\/tmp\\/agent-[A-Za-z0-9_]+', ''],
      ['.+', ''],
      ['req_[a-z0-9]+', 'i'],
      // A repetition whose part ends at a character it can't take itself.
      ['(?:\\d{1,3}\\.){3}\\d{1,3}', ''],
      ['[\\w.+-]+@(?:[\\w-]+\\.)+[a-z]{2,}', ''],
      ['\\d+(?:,\\d+)*', ''],
      ['(?:\\r?\\n)+', ''],
      ['(?:"[^"]*"\\s*)+', ''],
      ['(?:.|\\n)*', ''],
      ['(?:\\s*,\\s*\\w+)+', ''],
      ['(?:\\p{Lu}\\p{Ll}+\\s?)+', 'u'],
      ['[\\p{L}--[a-z]]+', 'v'],
      ['(?:k|K)+', ''],
      // Repeated parts the next character doesn't settle, a few: time in a power of the text's length, never exponential.
      ['.*secret.*', ''],
      ['\\w+\\s*\\w+', ''],
      ['password=.*', ''],
      ['\\+?\\d[\\d -]{7,}\\d', ''],
      ['\\b(?:alice|alex|bob)\\b', 'i'],
      ['eyJ[\\w-]+\\.[\\w-]+\\.[\\w-]+', ''],
      ['sk-[a-zA-Z0-9]{20,}', ''],
    ];
    for (const [source, flags] of taken) expect(regexProblem(source, flags), `/${source}/${flags}`).toBeNull();
    // Every named pattern, written out.
    for (const name of namedPatterns()) {
      const re = compilePattern(name);
      expect(regexProblem(re.source, re.flags), name).toBeNull();
    }
  });

  it('says why a pattern isn\'t one, and caps its length', () => {
    expect(patternProblem('/(/', namedPatterns())).toBe("/(/: it isn't a regular expression: unterminated group");
    expect(patternProblem('/a/gg', namedPatterns())).toMatch(/^\/a\/gg: its flags "gg" aren't flags a regular expression takes/);
    expect(patternProblem('/a/uv', namedPatterns())).toMatch(/not u with v/);
    expect(patternProblem('uuidd', namedPatterns())).toMatch(/^unknown pattern "uuidd": use one of/);
    expect(patternProblem(`/${'a'.repeat(PATTERN_MAX)}/`, namedPatterns())).toMatch(/is 10002 characters long, over the 10000 a pattern may be/);
    expect(patternProblem('email', namedPatterns())).toBeNull();
    expect(() => compilePattern('/(a+)+$/')).toThrow(/^\/\(a\+\)\+\$\/: matching it could take too long/);
    expect(() => rewriteText('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!', [{ pattern: '/(a+)+$/', replace: 'x' }])).toThrow(/could take too long/);
  });

  it('never takes a pattern that is exponential: each one taken from 400 random ones runs fast on text that defeats it', async () => {
    // The check reads each pattern here, without running it. What it takes is then run on text that
    // defeats a backtracking pattern, in a worker with a hard time limit: a pattern with exponential
    // backtracking takes 2^40 steps on these 41 characters, hours, so one the check wrongly took
    // would be stopped at the limit and named. What the check takes runs at most a small power of
    // 40 steps, well under a second for them all.
    let seed = 20261023;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
    const gen = (depth: number): string => {
      const r = rnd();
      if (depth > 3 || r < 0.3) return pick(['a', 'b', '[ab]', '.', 'a', 'ab']);
      if (r < 0.5) return gen(depth + 1) + gen(depth + 1);
      if (r < 0.65) return `(?:${gen(depth + 1)}|${gen(depth + 1)})`;
      return `(?:${gen(depth + 1)})${pick(['*', '+', '?', '{1,3}', '{2}', '{0,2}', '*?'])}`;
    };
    const sources: string[] = [];
    let refused = 0;
    for (let k = 0; k < 400; k++) {
      const source = gen(0);
      if (regexProblem(source, '') === null) sources.push(source);
      else refused++;
    }
    expect(sources.length).toBeGreaterThan(100);
    expect(refused).toBeGreaterThan(50);
    const texts = ['a'.repeat(40), 'b'.repeat(40), 'ab'.repeat(20), 'aab'.repeat(13), 'abb'.repeat(13), 'ba'.repeat(20)].map((t) => `${t}c`);
    const worker = new Worker(
      `const { parentPort, workerData } = require('node:worker_threads');
      workerData.sources.forEach((source, i) => {
        parentPort.postMessage({ started: i });
        const anchored = new RegExp('^(?:' + source + ')$');
        const anywhere = new RegExp('(?:' + source + ')c$');
        for (const text of workerData.texts) { anchored.test(text); anywhere.test(text); }
      });
      parentPort.postMessage({ done: true });`,
      { eval: true, workerData: { sources, texts } },
    );
    let running = -1;
    const outcome = await new Promise<'done' | 'stopped'>((resolve, reject) => {
      const limit = setTimeout(() => void worker.terminate().then(() => resolve('stopped')), 15_000);
      worker.on('message', (m: { started?: number; done?: boolean }) => {
        if (m.started !== undefined) running = m.started;
        if (m.done) {
          clearTimeout(limit);
          void worker.terminate().then(() => resolve('done'));
        }
      });
      worker.on('error', (err) => {
        clearTimeout(limit);
        reject(err);
      });
    });
    expect(outcome, `still matching /${sources[running] ?? ''}/ when the time limit stopped it`).toBe('done');
  });
});

describe('a rule\'s pattern from someone else', () => {
  const GOLDEN = fileURLToPath(new URL('../../../testing/golden/reference-agent', import.meta.url));
  let dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs = [];
  });

  it('is refused in a pack before anything compiles it, the rule named by its place', () => {
    for (const [pattern, why] of [
      ['/^(\\w+\\s?)*$/', /run\.json runs\[0\]\.meta\.redactions\[1\]\.pattern: \/\^\(\\w\+\\s\?\)\*\$\/: matching it could take too long/],
      // The review's pack: a rule that took a replay 10 s a 4 KB string, and stalled it.
      ['/[a-z]*[a-z]*!/', /run\.json runs\[0\]\.meta\.redactions\[1\]\.pattern: \/\[a-z\]\*\[a-z\]\*!\/: matching it could take too long/],
      ['/(/', /run\.json runs\[0\]\.meta\.redactions\[1\]\.pattern: \/\(\/: it isn't a regular expression: unterminated group/],
      [`/${'a'.repeat(PATTERN_MAX + 1)}/`, /run\.json runs\[0\]\.meta\.redactions\[1\]\.pattern: is longer than 10000 characters/],
    ] as const) {
      const dir = mkdtempSync(join(tmpdir(), 'sl-pack-regex-'));
      dirs.push(dir);
      cpSync(GOLDEN, dir, { recursive: true });
      const manifest = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as { runs: Array<{ meta?: Record<string, unknown> }> };
      manifest.runs[0].meta = { ...manifest.runs[0].meta, redactions: [{ pattern: 'email', replace: '<EMAIL>' }, { pattern, replace: '<X>' }] };
      writeFileSync(join(dir, 'run.json'), JSON.stringify(manifest));
      const store = Store.open(':memory:');
      try {
        expect(() => unpackRun(store, dir)).toThrow(PackError);
        expect(() => unpackRun(store, dir)).toThrow(why);
        expect(store.allRuns()).toHaveLength(0);
      } finally {
        store.close();
      }
    }
    // And a path that isn't one.
    const dir = mkdtempSync(join(tmpdir(), 'sl-pack-regex-'));
    dirs.push(dir);
    cpSync(GOLDEN, dir, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as { runs: Array<{ meta?: Record<string, unknown> }> };
    manifest.runs[0].meta = { ...manifest.runs[0].meta, redactions: [{ path: 'messages', replace: '<X>' }] };
    writeFileSync(join(dir, 'run.json'), JSON.stringify(manifest));
    const store = Store.open(':memory:');
    expect(() => unpackRun(store, dir)).toThrow(/redactions\[0\]\.path: path must start with "\$"/);
    store.close();
  });

  it('is named by its number in a preview, before any call is read', () => {
    const store = Store.open(':memory:');
    const dir = mkdtempSync(join(tmpdir(), 'sl-pack-regex-'));
    dirs.push(dir);
    cpSync(GOLDEN, dir, { recursive: true });
    const [runId] = unpackRun(store, dir).imported;
    expect(() => previewRedaction(store, runId, [{ pattern: 'email', replace: '<EMAIL>' }, { pattern: '/(\\d+)*$/', replace: '<N>' }])).toThrow(/^redaction rule #2: \/\(\\d\+\)\*\$\/: matching it could take too long/);
    store.close();
  });
});

describe('the time budget a document’s rules run within', () => {
  afterEach(() => setPatternBudget(null));

  it('stops a pattern the check takes, but that reads a long text from every place, and names it, where it would have run for minutes', () => {
    setPatternBudget(200);
    // Taken by the check (one repeated part it can't settle), and still the square of the text: the review's.
    const taken = ['/(?:\\w|-)*x/', '/.*x/', 'email', '/[\\w.+-]+@[\\w-]+/'];
    for (const pattern of taken) expect(patternProblem(pattern, namedPatterns()), pattern).toBeNull();
    const long = 'a'.repeat(400_000);
    for (const pattern of taken) {
      const started = performance.now();
      expect(() => applyNormalizers({ messages: [{ role: 'user', content: long }] }, [{ pattern, replace: '<X>' }], 'api', 'POST /v1/messages'), pattern).toThrow(PatternBudgetError);
      expect(performance.now() - started, pattern).toBeLessThan(5_000);
    }
    // Every way a document is rewritten keeps to it: raw text, a JSON document, every string of a value.
    expect(() => rewriteText(long, [{ pattern: '/.*x/', replace: '<X>' }])).toThrow(/ran longer than 0\.2 s on one document and was stopped \(\/\.\*x\/\)/);
    expect(() => rewriteJsonDocument(JSON.stringify({ content: long }), [{ pattern: '/.*x/', replace: '<X>' }], null)).toThrow(PatternBudgetError);
    expect(() => rewriteStringsDeep([long], compilePattern('/.*x/'), '<X>')).toThrow(PatternBudgetError);
    // And what follows runs as before: nothing is left stopped.
    expect(rewriteText('a secret here', [{ pattern: '/secret/', replace: '<X>' }])).toBe('a <X> here');
  });

  it('lets a pattern that ends in time run as it always did, on a short document without a budget at all', () => {
    expect(PATTERN_BUDGET_MS).toBe(5_000);
    const doc = { messages: [{ role: 'user', content: `key sk-${'A'.repeat(40)} and ${'a'.repeat(200_000)}` }] };
    expect(JSON.stringify(applyNormalizers(doc, [{ pattern: '/sk-[A-Za-z0-9]{20,}/', replace: '<KEY>' }], 'api', 'POST /v1/messages'))).toContain('key <KEY> and');
    // A short one: even the square of its length is nothing.
    expect(rewriteText('aaaa', [{ pattern: '/.*x/', replace: '<X>' }])).toBe('aaaa');
  });
});
