import { describe, expect, it } from 'vitest';
import { parseJsonExact } from '../src/json-exact.js';
import { applyNormalizers, compilePattern, parsePath, stripKeysDeep } from '../src/normalize.js';

describe('parsePath', () => {
  it('parses keys, indexes, wildcards and quoted keys', () => {
    expect(parsePath('$.system[0].text')).toEqual([
      { type: 'key', key: 'system' },
      { type: 'index', index: 0 },
      { type: 'key', key: 'text' },
    ]);
    expect(parsePath('$.messages[*].content.*')).toEqual([
      { type: 'key', key: 'messages' },
      { type: 'wild' },
      { type: 'key', key: 'content' },
      { type: 'wild' },
    ]);
    expect(parsePath('$["weird.key"][-1]')).toEqual([
      { type: 'key', key: 'weird.key' },
      { type: 'index', index: -1 },
    ]);
  });

  it('rejects malformed paths', () => {
    expect(() => parsePath('system.text')).toThrow(/must start/);
    expect(() => parsePath('$.a[')).toThrow(/unterminated/);
    expect(() => parsePath('$.')).toThrow(/empty key/);
  });
});

describe('applyNormalizers', () => {
  const body = {
    system: [{ type: 'text', text: 'Today is 2026-09-15. Be brief.' }],
    messages: [{ role: 'user', content: 'hi 2026-09-15' }],
    metadata: { request_id: 'abc' },
  };

  it('rewrites only the scoped path with a named pattern', () => {
    const out = applyNormalizers(body, [{ kind: 'api', path: '$.system[*].text', pattern: 'iso-date', replace: '<DATE>' }], 'api', 'POST /v1/messages') as typeof body;
    expect(out.system[0].text).toBe('Today is <DATE>. Be brief.');
    expect(out.messages[0].content).toBe('hi 2026-09-15');
    expect(body.system[0].text).toContain('2026-09-15'); // never mutates the input
  });

  it('replaces the whole value when no pattern is given', () => {
    const out = applyNormalizers(body, [{ path: '$.metadata.request_id', replace: '<ID>' }], 'api', 'x') as typeof body;
    expect(out.metadata.request_id).toBe('<ID>');
  });

  it('honours kind and name scoping', () => {
    const args = { idempotency_key: 'k-1', title: 'T' };
    const n = { kind: 'tool' as const, name: 'create_ticket', path: '$.idempotency_key', replace: '<K>' };
    expect((applyNormalizers(args, [n], 'tool', 'create_ticket') as typeof args).idempotency_key).toBe('<K>');
    expect((applyNormalizers(args, [n], 'tool', 'other_tool') as typeof args).idempotency_key).toBe('k-1');
    expect((applyNormalizers(args, [n], 'api', 'create_ticket') as typeof args).idempotency_key).toBe('k-1');
  });

  it('supports regex literals and datetime/uuid patterns', () => {
    expect(compilePattern('/foo\\d+/i').test('FOO12')).toBe(true);
    const out = applyNormalizers(
      { a: 'at 2026-09-16T10:11:12.345Z id 123e4567-e89b-12d3-a456-426614174000' },
      [
        { path: '$.a', pattern: 'iso-datetime', replace: '<T>' },
        { path: '$.a', pattern: 'uuid', replace: '<U>' },
      ],
      'tool',
      't',
    ) as { a: string };
    expect(out.a).toBe('at <T> id <U>');
  });

  it('leaves a number kept as written as it is, wherever a rule reaches, and reports it by its digits', () => {
    // A request read with each number as it was sent: an id past 2^53, and a Python float.
    const request = parseJsonExact('{"to":"dana@example.com","order":{"id":12345678901234567891,"total":20.0},"items":[12345678901234567891]}');
    const unmasked: Array<{ text: string; what: string }> = [];
    const out = applyNormalizers(request, [{ pattern: 'email', replace: '<EMAIL>' }, { path: '$.order.*', pattern: '/\\d{19}/', replace: '<ID>' }, { pattern: '/\\d{19,}/', replace: '<N>' }], 'api', 'POST /v1/messages', { unmasked: (_i, text, at) => void unmasked.push({ text, what: at.what }) });
    // The strings are masked; each number goes out as it was written, exact and unchanged.
    expect(JSON.stringify(out)).toBe('{"to":"<EMAIL>","order":{"id":12345678901234567891,"total":20.0},"items":[12345678901234567891]}');
    // A pattern that matches a number leaves it as it is, and says so with the number's own digits.
    expect(unmasked).toEqual(expect.arrayContaining([{ text: '12345678901234567891', what: 'number' }]));
    // A path rule without a pattern masks the number whole, as it masks any value at its path.
    expect(JSON.stringify(applyNormalizers(request, [{ path: '$.order.id', replace: '<ID>' }], 'api', 'POST /v1/messages'))).toContain('"id":"<ID>"');
  });
});

describe('stripKeysDeep', () => {
  it('removes the key at any depth without touching the input', () => {
    const v = { a: { cache_control: { type: 'ephemeral' }, x: [{ cache_control: 1, y: 2 }] } };
    expect(stripKeysDeep(v, ['cache_control'])).toEqual({ a: { x: [{ y: 2 }] } });
    expect(v.a.cache_control).toBeDefined();
  });
});
