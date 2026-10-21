// The project's domain is shadowlap.ai. Every other shadowlap.<tld>, shadowlap.com among them, belongs to
// someone else, so a link or an address there would send people to a stranger. These checks keep every
// tracked file to the one the project has.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OURS = 'shadowlap.ai';
const SELF = 'testing/distribution/test/domains.test.ts';

/**
 * The shadowlap.<tld> host names in a text that aren't the project's, lower-cased, in order. A name that
 * goes on with a dot and a word is a namespace, not a host: OpenTelemetry's shadowlap.run.id, a file's
 * shadowlap.config.json.
 */
function foreignDomains(text: string): string[] {
  const tlds = 'com|net|org|io|dev|app|co|sh|so|run|tech|cloud|xyz|me|us|uk|eu|de|dk|ai';
  return [...text.matchAll(new RegExp(`\\bshadowlap\\.(?:${tlds})\\b(?!\\.\\w|-)`, 'gi'))]
    .map((m) => m[0].toLowerCase())
    .filter((d) => d !== OURS);
}

describe('the domains the repository names', () => {
  it('are only the one the project has', () => {
    const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter((f) => f && f !== SELF);
    const found: string[] = [];
    for (const file of files) {
      let text: string;
      try {
        text = readFileSync(join(ROOT, file), 'utf8');
      } catch {
        continue; // a file the index has and the checkout doesn't
      }
      if (text.includes('\0')) continue; // binary
      text.split('\n').forEach((line, i) => {
        for (const d of foreignDomains(line)) found.push(`${file}:${i + 1} ${d}`);
      });
    }
    expect(found).toEqual([]);
  });

  it('finds a link, an address or a host on another shadowlap domain, and not file and package names', () => {
    expect(foreignDomains('see https://shadowlap.com/docs, write to security@shadowlap.com or www.shadowlap.io, or https://shadowlap.run.')).toEqual(['shadowlap.com', 'shadowlap.com', 'shadowlap.io', 'shadowlap.run']);
    expect(foreignDomains('https://shadowlap.ai/docs · shadowlap.config.json · .shadowlap/shadowlap.db · @shadowlap/sdk · shadowlap.tool(effect="read") · shadowlap.mdc · shadowlap.run.id')).toEqual([]);
  });
});
