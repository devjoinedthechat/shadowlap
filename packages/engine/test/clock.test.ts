import { describe, expect, it } from 'vitest';
import { maskClock, maskClockText } from '../src/clock.js';
import { fingerprintApi, normalizersHash } from '../src/fingerprint.js';

const REF = Date.parse('2026-09-16T10:30:00Z');

describe('clock masking', () => {
  it('masks dates and times near the reference, in the forms agents print them', () => {
    const cases: Array<[string, string]> = [
      ['Today is 2026-09-16.', 'Today is <date>.'],
      ['Yesterday was 2026-09-15 and tomorrow is 2026-09-17', 'Yesterday was <date> and tomorrow is <date>'],
      ['now: 2026-09-16T10:31:22.123Z', 'now: <datetime>'],
      ['at 2026-09-16 08:00', 'at <datetime>'],
      ['local 2026-09-16T12:31:22+02:00 and 2026-09-16T12:31:22+0200', 'local <datetime> and <datetime>'],
      ['Date: Wed, 16 Sep 2026 10:31:22 GMT', 'Date: <datetime>'],
      ['Wed Sep 16 2026 12:31:22 GMT+0200 (Central European Summer Time)!', '<datetime>!'],
      ['Today is Wednesday, September 16, 2026.', 'Today is <date>.'],
      ['on Sep 16 2026 and September 16th, 2026', 'on <date> and <date>'],
      ['Wednesday, 16 September 2026', '<date>'],
      ['ts=1789554600000 t=1789554600 py=1789554600.123456', 'ts=<epoch> t=<epoch> py=<epoch>'],
    ];
    for (const [input, output] of cases) expect(maskClockText(input, REF), input).toBe(output);
  });

  it('leaves values far from the reference, and digits that are not times, alone', () => {
    for (const s of ['Deadline 2026-01-01', 'since 2026-09-01', 'Founded September 16, 1999', 'order 1234567890123 of 9999999999', 'msg_1789554600000', 'v2026-09-16x', 'no digits here']) {
      expect(maskClockText(s, REF), s).toBe(s);
    }
    expect(maskClockText('report-2026-09-16.pdf', REF)).toBe('report-<date>.pdf');
  });

  it('masks epoch numbers in JSON, and walks objects and arrays without changing the input', () => {
    const input = { created: 1789554600, at_ms: 1789554600123, count: 1789, nested: [{ when: '2026-09-16' }], fixed: 1700000000 };
    expect(maskClock(input, REF)).toEqual({ created: '<epoch>', at_ms: '<epoch>', count: 1789, nested: [{ when: '<date>' }], fixed: 1700000000 });
    expect(input.nested[0]!.when).toBe('2026-09-16');
  });

  it('makes a request made today match the same request made on another day, relative to each run', () => {
    const request = (date: string) => ({ method: 'POST', path: '/v1/messages', headers: {}, body: { system: `Today is ${date}.`, messages: [{ role: 'user', content: 'triage' }] } });
    const recorded = fingerprintApi(request('2026-06-01'), [], [], Date.parse('2026-06-01T09:00:00Z')).fingerprint;
    expect(fingerprintApi(request('2026-09-17'), [], [], Date.parse('2026-09-17T15:00:00Z')).fingerprint).toBe(recorded);
    expect(fingerprintApi(request('2026-09-17'), [], []).fingerprint).not.toBe(fingerprintApi(request('2026-06-01'), [], []).fingerprint);
    expect(normalizersHash([], 'auto')).not.toBe(normalizersHash([], 'exact'));
    expect(normalizersHash([])).toBe(normalizersHash([], 'exact'));
  });

  it('is fast enough for large requests', () => {
    const big = { system: 'x'.repeat(200_000) + ' 2026-09-16 ' + 'word '.repeat(40_000), messages: Array.from({ length: 200 }, (_, i) => ({ role: 'user', content: `turn ${i} at 2026-09-16T10:${String(i % 60).padStart(2, '0')}:00Z` })) };
    const started = performance.now();
    maskClock(big, REF);
    expect(performance.now() - started).toBeLessThan(250);
  });
});
