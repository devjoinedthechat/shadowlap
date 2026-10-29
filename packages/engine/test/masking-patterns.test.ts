import { describe, expect, it } from 'vitest';
import { CREDENTIAL_PLACEHOLDER as C, TOKEN_IN_VALUE } from '../src/http.js';
import { times, timesOf } from './timing.js';

/**
 * What the credential masking reads with a pattern, or read with one before: each reads a text in
 * time that grows with its length, never its square, whatever the text. Every value is invented.
 */

const CODE = 'EXAMPLE-CODE-q1w2e3';

describe('a refresh header', () => {
  const refresh = TOKEN_IN_VALUE.refresh;

  it('has the URL it sends the client to masked, quoted or not, and any other shape left as it is', () => {
    expect(refresh(`0; url=https://app.example.com/cb?code=${CODE}&state=s1`)).toBe(`0; url=https://app.example.com/cb?code=${C}&state=s1`);
    expect(refresh(`5;URL='https://app.example.com/cb?code=${CODE}'`)).toBe(`5;URL='https://app.example.com/cb?code=${C}'`);
    expect(refresh('  10 ,\turl = "https://app:sk-test-EXAMPLE0000@example.com/x"  ')).toBe(`  10 ,\turl = "https://app:${C}@example.com/x"  `);
    expect(refresh(`url=https://app.example.com/cb?code=${CODE}`)).toBe(`url=https://app.example.com/cb?code=${C}`);
    // Text after the closing quote, a second quote, a delay that isn't whole seconds, another key, nothing to mask.
    for (const value of [`0; url="https://app.example.com/cb?code=${CODE}" x`, `0; url=https://app.example.com/cb?code=${CODE}'"`, `3.5; url=https://app.example.com/cb?code=${CODE}`, `0; next=https://app.example.com/cb?code=${CODE}`, '0; url=https://example.com/plain']) {
      expect(refresh(value), value).toBe(value);
    }
  });

  it('is read once, however long a value that ends otherwise is', () => {
    const value = (n: number) => `5;url=https://example.com/${'a'.repeat(n)}${' '.repeat(n)}"x`;
    const t = timesOf({ short: () => refresh(value(1000)), long: () => refresh(value(16_000)) }, { rounds: 2 });
    expect(t.long, `16 times the value took ${times(t.long, t.short)} as long`).toBeLessThan(48 * t.short);
  });
});
