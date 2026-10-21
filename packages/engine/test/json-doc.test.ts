import { describe, expect, it } from 'vitest';
import { contextFree, isJsonText, reachesResultsOf, rewriteJsonDocument, untouched, type CallScope } from '../src/json-doc.js';
import { applyNormalizers, compilePattern, type RewriteObserver } from '../src/normalize.js';
import type { Normalizer } from '../src/types.js';
import { times, timesOf } from './timing.js';

/**
 * The JSON document a copy writes, held to a reference of this file's own: the document parsed, and
 * the rules applied to its values one after another as the docs say (a rule without a path to every
 * string, keys included; with `call`, a rule whose path reaches what the call got back at its path,
 * as in a request), then compared with the copy's text read back. Numbers and layout are held to the
 * text as recorded wherever no path rule put a value in place of another.
 */

/** mulberry32: the same documents on every run. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Every string (keys too) with `f` applied, as a rule without a path rewrites a JSON document. */
function strings(value: unknown, f: (s: string) => string): unknown {
  if (typeof value === 'string') return f(value);
  if (Array.isArray(value)) return value.map((v) => strings(v, f));
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [f(k), strings(v, f)]));
  return value;
}

/** The rules applied one after another to the parsed document. */
function reference(value: unknown, rules: Normalizer[], call: CallScope | null): unknown {
  let v = value;
  for (const rule of rules) {
    if (rule.path === undefined) {
      if (rule.pattern === undefined) continue;
      const regex = compilePattern(rule.pattern);
      v = strings(v, (s) => {
        regex.lastIndex = 0;
        return s.replace(regex, rule.replace);
      });
    } else if (call && reachesResultsOf(rule, call)) v = applyNormalizers(v, [rule], call.kind, call.name);
  }
  return v;
}

/** The tokens of a JSON text that aren't strings, and the whitespace between tokens: what a copy keeps byte for byte. */
const layout = (text: string) => text.replace(/"(?:[^"\\]|\\.)*"/g, '"');

const CALL: CallScope = { kind: 'tool', name: 'lookup' };
const RULES: Normalizer[] = [
  { pattern: 'email', replace: '<EMAIL>' },
  { pattern: '/\\b(?:\\d[ -]?){13,16}\\b/', replace: '<CARD>' },
  { pattern: '/acct-\\d+/', replace: '<ACCT>' },
  { kind: 'tool', path: '$.result.card', replace: '<CARDNO>' },
  { kind: 'tool', name: 'lookup', path: '$.result.items[*].note', pattern: 'email', replace: '<E>' },
  { path: '$.result.items[-1]', replace: '<LAST>' },
  { kind: 'tool', path: '$.result.*.owner', replace: '<OWNER>' },
  // A rule whose replacement another rule after it matches: a copy applies them in order.
  { path: '$.result.ref', replace: 'see acct-77' },
  { pattern: '/<ACCT>|see/', replace: '<SEE>' },
];

function generate(seed: number): string {
  const r = random(seed);
  const int = (n: number) => Math.floor(r() * n);
  const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)]!;
  let unique = 0;
  const text = () =>
    Array.from({ length: 1 + int(4) }, () =>
      pick([() => `user${unique++}@example.com`, () => `4111 1111 1111 ${1000 + int(9000)}`, () => `acct-${int(1e5)}`, () => 'refund', () => 'café 😀', () => 'line\nbreak', () => 'a "quote" and \\ back', () => '\u0001ctl', () => 'see'])(),
    ).join(' ');
  const number = () => pick(['4111111111111111', String(1_700_000_000_000 + int(1e11)), String(int(1000)), '-0.5', '1e5', '2E-3', '-0'] as const);
  const KEYS = ['card', 'owner', 'note', 'items', 'ref', 'bob@example.com', '4111111111111111', 'a"b', 'x\\y', '', 'é'];
  const value = (depth: number): unknown => {
    const roll = r();
    if (depth > 3 || roll < 0.35) return r() < 0.5 ? text() : r() < 0.8 ? JSON.parse(number()) : pick([true, false, null]);
    if (roll < 0.6) return Array.from({ length: int(4) }, () => value(depth + 1));
    return Object.fromEntries(Array.from({ length: int(4) }, () => [r() < 0.7 ? pick(KEYS) : text(), value(depth + 1)]));
  };
  const doc = { result: { card: r() < 0.5 ? 4111111111111111 : value(1), items: Array.from({ length: int(4) }, () => ({ note: value(2), owner: value(2) })), ref: value(1), more: { owner: value(2) } } };
  // Written as a person or another JSON library might: spaced out, its slashes or every character escaped.
  const indent = pick([undefined, 2, '\t']);
  let out = JSON.stringify(doc, null, indent);
  if (r() < 0.3) out = out.replace(/\//g, '\\/');
  if (r() < 0.3) out = out.replace(/[^\x20-\x7e\n\t]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  if (r() < 0.3) out = out.replace(/@/g, '\\u0040');
  return `${r() < 0.3 ? ' \n' : ''}${out}${r() < 0.3 ? '\n' : ''}`;
}

describe('rewriteJsonDocument', () => {
  it('writes what the rules make of the document, its numbers and layout as recorded, in a pack and in a copy that is read', () => {
    let changed = 0;
    for (let seed = 1; seed <= 150; seed++) {
      const text = generate(seed);
      for (const call of [null, CALL]) {
        const rules = seed % 3 ? RULES : RULES.slice().reverse();
        const out = rewriteJsonDocument(text, rules, call);
        expect(out, `seed ${seed}`).not.toBeNull();
        expect(JSON.parse(out!), `seed ${seed}`).toEqual(reference(JSON.parse(text), rules, call));
        // Without a path rule (a pack), every number, literal, bracket and space stays where it was.
        if (!call) expect(layout(out!), `seed ${seed}`).toBe(layout(text));
        if (out !== text) changed++;
      }
    }
    expect(changed).toBeGreaterThan(200);
  });

  it('reports each change as the rules make it, and each value a path rule reaches', () => {
    const text = '{"result": {"card": 4111111111111111, "note": "mail bob@example.com", "items": [{"note": {"to": "ann@example.com"}}]}}';
    const changes: Array<[number, unknown, unknown, number]> = [];
    const reached: Array<[number, unknown]> = [];
    const left: Array<[number, string, unknown]> = [];
    const observer: RewriteObserver = { changed: (i, b, a, n) => changes.push([i, b, a, n]), reached: (i, v) => reached.push([i, v]), unmasked: (i, t, at) => left.push([i, t, at]) };
    const rules: Normalizer[] = [{ pattern: '/\\d{16}/', replace: '<N>' }, { kind: 'tool', path: '$.result.card', replace: '<CARD>' }, { kind: 'tool', path: '$.result.items[*].note', pattern: 'email', replace: '<E>' }];
    expect(rewriteJsonDocument(text, rules, CALL, observer)).toBe('{"result": {"card": "<CARD>", "note": "mail bob@example.com", "items": [{"note": {"to": "ann@example.com"}}]}}');
    expect(changes).toEqual([[1, 4111111111111111, '<CARD>', 1]]);
    expect(reached).toEqual([
      [1, 4111111111111111],
      [2, { to: 'ann@example.com' }],
    ]);
    // A pattern at a path applies to a string there: what it matches inside an object there is left, with where it is.
    expect(left).toEqual([[2, 'ann@example.com', { path: ['result', 'items', 0, 'note', 'to'], what: 'string' }]]);
    // In a pack no path rule reaches it, and the number the pattern matches is left as it is.
    left.length = 0;
    expect(rewriteJsonDocument(text, rules, null, observer)).toBe(text);
    expect(left).toEqual([[0, '4111111111111111', { path: ['result', 'card'], what: 'number' }]]);
  });

  it('reads a document nested deeper than a stack would, and a long one, in one pass', () => {
    const deep = `{"result":${'['.repeat(200_000)}"mail bob@example.com"${']'.repeat(200_000)}}`;
    const out = rewriteJsonDocument(deep, [{ pattern: 'email', replace: '<EMAIL>' }], null)!;
    expect(out.length).toBe(deep.length - 'bob@example.com'.length + '<EMAIL>'.length);
    expect(out).toContain('"mail <EMAIL>"');
    const rows = JSON.stringify({ result: Array.from({ length: 200_000 }, (_, i) => ({ id: i, card: 4_000_000_000_000_000 + i, owner: `u${i}@example.com` })) });
    const rules: Normalizer[] = [{ pattern: 'email', replace: '<EMAIL>' }, { pattern: '/\\d{16}/', replace: '<CARD>' }];
    let numbers = 0;
    const masked = rewriteJsonDocument(rows, rules, null, { unmasked: () => numbers++ })!;
    expect(numbers).toBe(200_000);
    expect(masked).not.toMatch(/@example/);
    expect(masked).toContain('"card":4000000000000000');
    // Held against this machine, not a number of milliseconds: one pass, a few times what a copy of the
    // document takes (parsed, and written again).
    const t = timesOf({ rewrite: () => rewriteJsonDocument(rows, rules, null, { unmasked: () => {} }), copy: () => JSON.stringify(JSON.parse(rows)) }, { rounds: 2 });
    expect(t.rewrite, `rewriting the document took ${times(t.rewrite, t.copy)} a copy of it`).toBeLessThan(20 * t.copy);
  });

  it('is null for text that is no JSON document, which a copy masks as text', () => {
    for (const text of ['', ' ', 'card 4111', '\ufeff{"a":1}', '{"a":1} x', 'data: {"a":1}\n\n', '[1,]', '{"a" 1}']) expect(rewriteJsonDocument(text, RULES, null), JSON.stringify(text)).toBeNull();
  });
});

describe('isJsonText', () => {
  it('reads a text as one JSON document exactly when JSON.parse does', () => {
    const cases = [
      '0', '-0', '01', '-', '1.', '.5', '1e', '1e+', '1e+5', '1E-0', '-1.25e10', '2.', '00', '1_000', '0x10', 'NaN', 'Infinity', '+1',
      'true', 'tru', 'true1', 'nul', 'null ', ' null', '\tnull\r\n', '\fnull', '\u00a0null', 'null\u2028',
      '""', '"\\u0041"', '"\\u004"', '"\\x41"', "\"\\'\"", '"\\/"', '"\\b\\f\\n\\r\\t"', '"a\u0001b"', '"a\u001fb"', '"a\u007fb"', '"\u2028"', '"\ud800"', '"\\ud800"', '"abc',
      '[]', '[ ]', '[,]', '[1,]', '[1 2]', '[1,,2]', '[[[]]]', '[[]', ']', '{}', '{ }', '{,}', '{"a"}', '{"a":}', '{"a":1,}', '{"a":1 "b":2}', '{a:1}', "{'a':1}", '{"a":1}}', '{"a":[1,{"b":null}]}',
      '\ufeff{}', '{}\ufeff', '{}\n\n', '{} {}', '"a" "b"', '',
    ];
    for (const text of cases) expect(isJsonText(text), JSON.stringify(text)).toBe(parses(text));
    // Valid documents mutated a character at a time: the two agree on every one.
    const r = random(7);
    const alphabet = '{}[]",:0123456789eE+-.tfnrlusa\\ \n\t\r\u0001\u00a0\ufeffx';
    for (let n = 0; n < 4000; n++) {
      let text = generate(1 + (n % 40)).slice(0, 400);
      for (let k = 0; k < 1 + Math.floor(r() * 3); k++) {
        const at = Math.floor(r() * (text.length + 1));
        const c = alphabet[Math.floor(r() * alphabet.length)]!;
        const what = r();
        text = what < 0.4 ? text.slice(0, at) + c + text.slice(at) : what < 0.8 ? text.slice(0, at) + text.slice(at + 1) : text.slice(0, at) + c + text.slice(at + 1);
      }
      expect(isJsonText(text), JSON.stringify(text)).toBe(parses(text));
    }
  });
});

describe('untouched and contextFree', () => {
  it('says a document no rule could change is left as it is, without reading it', () => {
    const rules = RULES.filter((r) => r.path === undefined);
    expect(untouched('{"result":{"sku":"S-1","qty":5}}', rules, null)).toBe(true);
    // An escaped character may read as a match once the string is read; a path rule may reach it.
    expect(untouched('{"result":"bob\\u0040example.com"}', rules, null)).toBe(false);
    expect(rewriteJsonDocument('{"result":"bob\\u0040example.com"}', rules, null)).toBe('{"result":"<EMAIL>"}');
    expect(untouched('{"result":{"card":1}}', RULES, CALL)).toBe(false);
    expect(untouched('{"result":{"card":1}}', RULES, null)).toBe(true);
    // A pattern that reads the text around a match may match a string where the text has no match.
    expect(untouched('{"result":"12345"}', [{ pattern: '/^\\d+$/', replace: 'n' }], null)).toBe(false);
    expect(rewriteJsonDocument('{"result":"12345"}', [{ pattern: '/^\\d+$/', replace: 'n' }], null)).toBe('{"result":"n"}');
  });

  it('knows a pattern that reads the text around it', () => {
    for (const p of ['/^a/', '/a$/', '/(?=a)b/', '/(?!a)b/', '/(?<=a)b/', '/(?<!a)b/', '/a/y']) expect(contextFree(compilePattern(p)), p).toBe(false);
    for (const p of ['email', 'uuid', '/[^@\\s]+@[^@\\s]+/', '/\\$\\d+/', '/(?<name>\\d+)/', '/[$^]/', '/\\bacct\\b/']) expect(contextFree(compilePattern(p)), p).toBe(true);
  });
});

describe('reachesResultsOf', () => {
  it('reaches what a call got back for a path that starts with a key or a position, in its scope, never a clock or random read', () => {
    const rule = (r: Partial<Normalizer>): Normalizer => ({ replace: 'x', ...r });
    expect(reachesResultsOf(rule({ path: '$.result' }), { kind: 'tool', name: 't' })).toBe(true);
    expect(reachesResultsOf(rule({ path: '$.result' }), { kind: 'clock', name: 'now' })).toBe(false);
    expect(reachesResultsOf(rule({ path: '$.result' }), { kind: 'random', name: 'uuid' })).toBe(false);
    expect(reachesResultsOf(rule({ path: '$[0].x' }), { kind: 'api', name: 'POST /v1/messages' })).toBe(true);
    expect(reachesResultsOf(rule({ path: '$' , name: 't' }), { kind: 'tool', name: 't' })).toBe(false);
    expect(reachesResultsOf(rule({ path: '$.*.card' }), { kind: 'tool', name: 't' })).toBe(false);
    expect(reachesResultsOf(rule({ kind: 'api', path: '$.result' }), { kind: 'tool', name: 't' })).toBe(false);
    expect(reachesResultsOf(rule({ kind: 'tool', name: 'u', path: '$.result' }), { kind: 'tool', name: 't' })).toBe(false);
    expect(reachesResultsOf(rule({ pattern: 'email' }), { kind: 'tool', name: 't' })).toBe(false);
  });
});

function parses(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
