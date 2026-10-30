import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { maskMultipart } from '../src/credential-shapes.js';
import { CREDENTIAL_PLACEHOLDER as C, TOKEN_IN_VALUE, maskTextCredentials } from '../src/http.js';
import { regexProblem } from '../src/safe-regex.js';
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

describe('a multipart body', () => {
  const body = (boundary: string, after = '', nl = '\r\n') =>
    [`preamble${nl}--${boundary}${after}`, 'Content-Disposition: form-data; name="api_key"', '', 'sk-test-EXAMPLE0000', `--${boundary}`, 'Content-Disposition: form-data; name="note"', '', 'hello', `--${boundary}--`, ''].join(nl);

  it('takes its boundary from its first delimiter line: spaces inside it, the spaces and tabs after it left out, 200 characters at most', () => {
    // RFC 2046's own example boundary has a space in it.
    expect(maskTextCredentials(body('simple boundary'))).toBe(body('simple boundary').replace('sk-test-EXAMPLE0000', C));
    expect(maskTextCredentials(body('EXAMPLEBOUNDARY', ' \t ', '\n'))).toBe(body('EXAMPLEBOUNDARY', ' \t ', '\n').replace('sk-test-EXAMPLE0000', C));
    expect(maskTextCredentials(body('b'.repeat(200)))).toBe(body('b'.repeat(200)).replace('sk-test-EXAMPLE0000', C));
    expect(maskTextCredentials(body('b'.repeat(201)))).toBeNull();
  });

  it('reads a long line of `--` and white space once, not once for each length its boundary could have', () => {
    const keep = () => null;
    const t = timesOf({ letters: () => maskMultipart(`--b${'a'.repeat(100_000)}`, keep), spaces: () => maskMultipart(`--${' '.repeat(100_000)}`, keep), tabs: () => maskMultipart(`--x${'\t'.repeat(100_000)}`, keep) }, { rounds: 2 });
    expect(t.spaces, `a line of spaces took ${times(t.spaces, t.letters)} as long as one of letters`).toBeLessThan(10 * t.letters);
    expect(t.tabs, `a line of tabs took ${times(t.tabs, t.letters)} as long as one of letters`).toBeLessThan(10 * t.letters);
  });
});

/** The masking's sources: every pattern in them runs on every request and response a recording keeps, and every copy of one. */
const MASKING_SOURCES = ['credential-shapes.ts', 'http.ts', 'shell-words.ts'];

interface Pattern {
  at: string;
  source: string;
  flags: string;
}

/** The patterns a source writes, literals and `RegExp` of string literals, read with TypeScript's parser; `built` places one made of anything else. */
function patternsOf(file: string): { patterns: Pattern[]; built: string[] } {
  const text = readFileSync(fileURLToPath(new URL(`../src/${file}`, import.meta.url)), 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const patterns: Pattern[] = [];
  const built: string[] = [];
  const visit = (node: ts.Node): void => {
    const at = `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
    if (ts.isRegularExpressionLiteral(node)) {
      const end = node.text.lastIndexOf('/');
      patterns.push({ at, source: node.text.slice(1, end), flags: node.text.slice(end + 1) });
    } else if ((ts.isNewExpression(node) || ts.isCallExpression(node)) && ts.isIdentifier(node.expression) && node.expression.text === 'RegExp') {
      const [pattern, flags] = node.arguments ?? [];
      if (pattern && ts.isStringLiteralLike(pattern) && (!flags || ts.isStringLiteralLike(flags))) patterns.push({ at, source: pattern.text, flags: flags ? flags.text : '' });
      else built.push(at);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { patterns, built };
}

describe('every pattern the masking writes', () => {
  const read = MASKING_SOURCES.map(patternsOf);

  it('passes regexProblem, as a redaction rule must: none can take time that grows with the square of a text', () => {
    const patterns = read.flatMap((r) => r.patterns);
    expect(patterns.length).toBeGreaterThan(40);
    const refused = patterns.flatMap((p) => {
      const why = regexProblem(p.source, p.flags);
      return why ? [`${p.at} /${p.source}/${p.flags}: ${why}`] : [];
    });
    expect(refused).toEqual([]);
  });

  it('is written out where the check can read it, none built from a value', () => {
    expect(read.flatMap((r) => r.built)).toEqual([]);
  });
});
