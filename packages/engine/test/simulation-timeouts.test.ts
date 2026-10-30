import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The engine's simulation suites, every describe of which walks gates exactly or loops sessions by the
 * hundred, give each describe its own timeout: under the load a full run puts on a machine they take
 * from half a minute to several, past vitest's 30-second default, and a suite that leans on it fails
 * for being slow, not for being wrong.
 */
const SUITES = ['unavailable-gates.test.ts', 'gate-history-budget.test.ts', 'gate-history-regression.test.ts'];

describe('the simulation suites', () => {
  it('give each of their describes a timeout of its own', () => {
    for (const suite of SUITES) {
      const text = readFileSync(new URL(`./${suite}`, import.meta.url), 'utf8');
      const describes = [...text.matchAll(/^describe\(.*$/gm)].map(([line]) => line);
      expect(describes.length, suite).toBeGreaterThan(0);
      for (const line of describes) expect(line, suite).toMatch(/\{ timeout: [^}]+ \}, \(\) => \{$/);
    }
  });
});
