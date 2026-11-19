import { describe, expect, it } from 'vitest';
import { canonicalize } from '../src/canonical.js';
import { fingerprintTool } from '../src/fingerprint.js';
import { isRawNumber, matchable, parseJsonExact, reportable } from '../src/json-exact.js';
import { times, timesOf } from './timing.js';

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

  it('keeps every number a double reads otherwise, however the text around it reads, and the rest as JSON.parse does', () => {
    // Each written so a double reads it otherwise, and some that a double keeps as written.
    const changed = ['20.0', '1.50', '-0', '-0.0', '1e3', '1E3', '1e-07', '0.0000001', '0.00000012', '9007199254740993', '1234567890123456789', '12345678901234567891', '0.1000000000000000055511151231257827', '100000000000000000000000'];
    // Two of these a double writes back as they are only by luck of their digits: read the long way, kept all the same.
    const kept = ['0', '7', '-7', '100', '0.1', '-2.5', '3.14', '0.000001', '0.0000012', '123456789012345', '0.123456789012345', '999999999999999', '1.5', '42.25', '1.5e+21', '123456789012345.67'];
    for (const n of [...changed, ...kept]) {
      const text = `{"n":${n},"s":"a1e3 20.0 -0","list":[${n},"${n}"],"esc":"\\"${n}\\\\","t":true}`;
      expect(JSON.stringify(parseJsonExact(text)), n).toBe(text);
      const flag = { raw: false };
      parseJsonExact(text, flag);
      expect(flag.raw, n).toBe(changed.includes(n));
    }
    // Quotes escaped in a string, and backslashes before its closing quote, end it where JSON ends it.
    for (const text of ['{"a":"\\"","n":20.0,"b":"\\""}', '{"a":"x\\\\","n":20.0,"b":"\\""}']) expect(JSON.stringify(parseJsonExact(text)), text).toBe(text);
    // A number only a string holds is no number, however it reads: the text parses as JSON.parse reads it.
    const quoted = '{"hash":"9007199254740993e5","b64":"MTIzNDU2Nzg5MDEyMzQ1Njc4OTA=","n":12}';
    const flag = { raw: false };
    expect(parseJsonExact(quoted, flag)).toEqual(JSON.parse(quoted));
    expect(flag.raw).toBe(false);
    // Text that isn't JSON fails as JSON.parse fails it.
    expect(() => parseJsonExact('{"n":1.')).toThrow(SyntaxError);
    expect(() => parseJsonExact('{"s":"unclosed')).toThrow(SyntaxError);
  });

  // Under coverage V8 counts every block parseJsonExact runs and nothing JSON.parse does: the ratio would time the counting.
  it.skipIf(process.env.SHADOWLAP_TEST_COVERAGE)('reads a request with no such number about as fast as JSON.parse: CPU time against it, on 4 MB', () => {
    const messages = Array.from({ length: 3000 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: 'word '.repeat(200) }, { type: 'tool_result', tool_use_id: `t${i}`, content: JSON.stringify({ id: i, score: i / 7 }) }], meta: { n: i, f: i + 0.5 } }));
    const text = JSON.stringify({ model: 'm', max_tokens: 1024, messages });
    // Rounds long enough for Windows' clock, which counts CPU time in steps of about 16 ms: ten reads
    // came to one step of JSON.parse there, so the ratio was off by up to a step either way.
    const t = timesOf({ plain: () => JSON.parse(text), exact: () => parseJsonExact(text) });
    // A reviver on every value made it five times JSON.parse; read whole only where a number needs it.
    expect(t.exact, `parseJsonExact took ${times(t.exact, t.plain)} as long as JSON.parse`).toBeLessThan(t.plain * 3);
  });
});
