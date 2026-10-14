import { describe, expect, it } from 'vitest';
import { canonicalize } from '../src/canonical.js';

describe('canonicalize (RFC 8785)', () => {
  it('matches the RFC 8785 §3.3 example', () => {
    const input =
      '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\u002f","literals":[null,true,false]}';
    const expected = '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}';
    expect(canonicalize(JSON.parse(input))).toBe(expected);
  });

  it('sorts object members by UTF-16 code units, not code points', () => {
    // U+1F600 is the surrogate pair D83D DE00; U+FB01 is a single unit. UTF-16 order puts the pair first.
    const out = canonicalize({ 'ﬁ': 1, '\u{1F600}': 2, a: 3 });
    expect(out).toBe('{"a":3,"\u{1F600}":2,"ﬁ":1}');
  });

  it('is independent of key order and nested ordering', () => {
    expect(canonicalize({ b: [{ y: 1, x: 2 }], a: 'z' })).toBe(canonicalize({ a: 'z', b: [{ x: 2, y: 1 }] }));
  });

  it('drops undefined members and nulls undefined array items, like JSON.stringify', () => {
    expect(canonicalize({ a: undefined, b: [undefined, 1] })).toBe('{"b":[null,1]}');
  });

  it('serializes -0 as 0 and rejects non-finite numbers', () => {
    expect(canonicalize(-0)).toBe('0');
    expect(() => canonicalize(NaN)).toThrow();
    expect(() => canonicalize({ a: Infinity })).toThrow();
  });

  it('uses toJSON', () => {
    expect(canonicalize({ d: new Date(0) })).toBe('{"d":"1970-01-01T00:00:00.000Z"}');
  });
});
