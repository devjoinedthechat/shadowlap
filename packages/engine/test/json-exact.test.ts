import { describe, expect, it } from 'vitest';
import { canonicalize } from '../src/canonical.js';
import { fingerprintTool } from '../src/fingerprint.js';
import { isRawNumber, matchable, parseJsonExact, reportable } from '../src/json-exact.js';

describe('JSON with exact numbers', () => {
  it('writes back every number as it was read', () => {
    const text = '{"id":1234567890123456789,"price":20.0,"n":[1.50,-0,1e3,7,0.1],"s":"20.0"}';
    const value = parseJsonExact(text) as Record<string, unknown>;
    expect(JSON.stringify(value)).toBe(text);
    expect(isRawNumber(value.id)).toBe(true);
    expect(value.s).toBe('20.0');
    expect((value.n as unknown[])[3]).toBe(7);
  });

  it('matches an integer past 2^53 by its digits, and other numbers by the double they read as', () => {
    expect(matchable(parseJsonExact('{"id":1234567890123456789,"p":20.0}'))).toEqual({ id: 1234567890123456789n, p: 20 });
    expect(canonicalize({ id: 1234567890123456789n })).toBe('{"id":1234567890123456789}');
    const fp = (args: string) => fingerprintTool('get_order', parseJsonExact(args), []).fingerprint;
    expect(fp('{"id":1234567890123456789}')).not.toBe(fp('{"id":1234567890123456788}'));
    // As before for numbers a double holds: a recording that stored 20 still matches a request with 20.0.
    expect(fp('{"price":20.0}')).toBe(fingerprintTool('get_order', { price: 20 }, []).fingerprint);
  });

  it('reports an integer past 2^53 by its digits, and other numbers as the double that matched', () => {
    const value = reportable(parseJsonExact('{"id":1234567890123456789,"n":[20.0,-0,1e3,9007199254740993],"s":"x"}'));
    expect(value).toEqual({ id: '1234567890123456789', n: [20, 0, 1000, '9007199254740993'], s: 'x' });
    // Plain JSON, as the run stores its divergence.
    expect(JSON.parse(JSON.stringify(value))).toEqual(value);
  });
});
