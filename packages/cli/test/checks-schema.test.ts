import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXPECT_KEYS, OPERATORS, parseExpect, parseTests } from '../src/checks.js';

/**
 * The `expect` part of shadowlap.config.schema.json against the parser: the keys it describes are
 * the ones the parser reads, every value the parser takes the schema takes, and every value the
 * parser refuses for its shape the schema refuses too. The examples on the checks page are held to
 * both, so the page, the editor's completion and the parser say the same thing.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
type Schema = Record<string, unknown>;
const schema = JSON.parse(readFileSync(join(ROOT, 'shadowlap.config.schema.json'), 'utf8')) as Schema;

/** The schema at a JSON pointer such as `#/$defs/match`. */
function at(pointer: string): Schema {
  if (!pointer.startsWith('#')) throw new Error(`not a local reference: ${pointer}`);
  let node: unknown = schema;
  for (const raw of pointer.slice(1).split('/').filter(Boolean)) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (typeof node !== 'object' || node === null || !(key in node)) throw new Error(`${pointer} does not resolve (at ${key})`);
    node = (node as Record<string, unknown>)[key];
  }
  return node as Schema;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const typeOf = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v);

/** Whether `value` is valid under `s`: the subset of JSON Schema 2020-12 the file uses. */
function valid(s: Schema | boolean, value: unknown): boolean {
  if (s === true) return true;
  if (s === false) return false;
  if (typeof s.$ref === 'string' && !valid(at(s.$ref), value)) return false;
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    const t = typeOf(value);
    if (!types.some((x) => x === t || (x === 'number' && t === 'integer'))) return false;
  }
  if (Array.isArray(s.enum) && !s.enum.some((x) => JSON.stringify(x) === JSON.stringify(value))) return false;
  if (typeof value === 'string') {
    if (typeof s.minLength === 'number' && value.length < s.minLength) return false;
    if (typeof s.maxLength === 'number' && value.length > s.maxLength) return false;
    if (typeof s.pattern === 'string' && !new RegExp(s.pattern, 'u').test(value)) return false;
  }
  if (typeof value === 'number' && typeof s.minimum === 'number' && value < s.minimum) return false;
  if (Array.isArray(value)) {
    if (typeof s.minItems === 'number' && value.length < s.minItems) return false;
    if (s.items !== undefined && !value.every((x) => valid(s.items as Schema, x))) return false;
  }
  if (isObject(value)) {
    const keys = Object.keys(value);
    if (typeof s.minProperties === 'number' && keys.length < s.minProperties) return false;
    if (Array.isArray(s.required) && !s.required.every((k) => keys.includes(k as string))) return false;
    if (s.propertyNames !== undefined && !keys.every((k) => valid(s.propertyNames as Schema, k))) return false;
    const props = (s.properties ?? {}) as Record<string, Schema>;
    for (const k of keys) {
      if (k in props) {
        if (!valid(props[k]!, value[k])) return false;
      } else if (s.additionalProperties !== undefined && !valid(s.additionalProperties as Schema | boolean, value[k])) return false;
    }
  }
  if (Array.isArray(s.anyOf) && !s.anyOf.some((x) => valid(x as Schema, value))) return false;
  if (Array.isArray(s.oneOf) && s.oneOf.filter((x) => valid(x as Schema, value)).length !== 1) return false;
  if (s.not !== undefined && valid(s.not as Schema, value)) return false;
  return true;
}

const EXPECT = '#/properties/tests/additionalProperties/properties/expect';
const expectValid = (v: unknown) => valid(at(EXPECT), v);
const parses = (v: unknown) => {
  try {
    parseExpect(v, '--expect');
    return true;
  } catch {
    return false;
  }
};

/** Every `$ref` in the schema, wherever it is. */
function refs(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((x) => refs(x, out));
  else if (isObject(node)) for (const [k, v] of Object.entries(node)) k === '$ref' && typeof v === 'string' ? out.push(v) : refs(v, out);
  return out;
}

describe('the expect part of the config schema', () => {
  it('describes exactly the keys the parser reads, every operator, and every key of a rule and a judge', () => {
    expect(Object.keys((at(EXPECT).properties as object) ?? {}).sort()).toEqual([...EXPECT_KEYS].sort());
    expect(Object.keys(at('#/$defs/predicate').properties as object).sort()).toEqual([...OPERATORS].sort());
    expect(Object.keys(at('#/$defs/callRule').properties as object)).toEqual(['tool', 'after', 'args']);
    expect(Object.keys(at('#/$defs/callCondition').properties as object)).toEqual(['tool', 'args', 'result']);
    expect(Object.keys(at('#/$defs/judge').properties as object)).toEqual(['name', 'question', 'of', 'model', 'pass']);
    expect(at('#/$defs/judge').required).toEqual(['name', 'question', 'model']);
  });

  it('resolves every reference it makes, the one back to expect for a when\'s then included', () => {
    const all = refs(schema);
    expect(all).toContain(EXPECT);
    for (const r of all) expect(() => at(r), r).not.toThrow();
  });

  const accepted: unknown[] = [
    { tools: { send_email: 0 }, modelCalls: '<= 12' },
    { calls: [{ tool: 'issue_refund', after: 'lookup_order', args: { amount: { '<=': '@lookup_order.result.total' } } }] },
    { calls: [{ tool: 'issue_refund', after: ['lookup_order', 'check_policy'] }] },
    { calls: [{ tool: 'send_email', args: { to: { endsWith: '@example.com' }, cc: { not: { in: '@lookup_customer.result.*' } }, customer: { tier: 'gold', email: { includes: '@' } }, ids: [1, { '>': 0 }], amount: { '>': 0, '<': '500' } } }] },
    { calls: [{ tool: 'issue_refund', args: { order_id: '@lookup_order.args.order_id', filter: { '=': { in: 'inbox' } } } }] },
    { when: [{ if: { tool: 'lookup_order', result: { total: { '>': 200 } } }, then: { tools: { escalate: '>= 1', issue_refund: 0 } } }] },
    { when: [{ if: { tool: 'count_open', args: { region: 'EU' }, result: { '>': 3 } }, then: { when: [{ if: { tool: 'x' }, then: { calls: [{ tool: 'y', after: 'x' }] } }] } }] },
    { judge: [{ name: 'explains-escalation', question: 'Does the reply say why?', of: 'answer', model: 'claude-haiku-4-5', pass: 'yes' }] },
    { judge: [{ name: 'tone', question: 'Is it rude?', model: 'openai:gpt-5.5', pass: 'no' }] },
  ];
  it.each(accepted)('takes what the parser takes: %j', (value) => {
    expect(parses(value)).toBe(true);
    expect(expectValid(value)).toBe(true);
  });

  const refused: unknown[] = [
    { calls: { tool: 'x', after: 'y' } },
    { calls: [{ tool: 'x' }] },
    { calls: [{ tool: 'x', after: [] }] },
    { calls: [{ tool: 'x', after: 'y', when: 1 }] },
    { calls: [{ tool: 'x', args: { amount: { '<=': 5, currency: 'EUR' } } }] },
    { calls: [{ tool: 'x', args: { amount: { '<=': 'a lot' } } }] },
    { calls: [{ tool: 'x', args: { to: { in: 'ops@example.com' } } }] },
    { calls: [{ tool: 'x', args: { to: { endsWith: 5 } } }] },
    { when: [{ if: { tool: 'x' } }] },
    { when: [{ if: { tool: 'x', after: 'y' }, then: { tools: { a: 1 } } }] },
    { judge: [{ name: 'j', question: 'q?' }] },
    { judge: [{ name: 'has spaces', question: 'q?', model: 'm' }] },
    { judge: [{ name: 'j', question: 'q?', model: 'm', of: 'everything' }] },
    { judge: [{ name: 'j', question: 'q?', model: 'm', temperature: 0 }] },
  ];
  it.each(refused)('refuses what the parser refuses for its shape: %j', (value) => {
    expect(parses(value)).toBe(false);
    expect(expectValid(value)).toBe(false);
  });

  it('takes every example on the checks page, which the parser reads too', () => {
    const page = readFileSync(join(ROOT, 'docs', 'checks.md'), 'utf8');
    const blocks = [...page.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]!) as Record<string, unknown>);
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    let configs = 0;
    for (const block of blocks) {
      if ('tests' in block) {
        configs++;
        expect(valid(schema, block), JSON.stringify(block)).toBe(true);
        expect(() => parseTests(block.tests)).not.toThrow();
      } else {
        expect(valid(at(EXPECT), block.expect), JSON.stringify(block)).toBe(true);
        expect(() => parseExpect(block.expect, 'docs')).not.toThrow();
      }
    }
    expect(configs).toBeGreaterThan(0);
  });
});
