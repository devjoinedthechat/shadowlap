import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INPUT_PARTS } from '../src/tokens.js';

/**
 * A model call's input, split as every place that splits it says it (INPUT_PARTS): the pages that
 * describe the split say cache read, cache creation and uncached, and none says cache write, which
 * reads as a tool that changes something.
 */
describe("a model call's input, split in the docs", () => {
  it('reads cache creation on every page that splits it, never cache write', () => {
    for (const page of ['tui', 'decisions', 'cli', 'dashboard']) {
      const text = readFileSync(fileURLToPath(new URL(`../../../docs/${page}.md`, import.meta.url)), 'utf8').replace(/\s+/g, ' ');
      expect(text, `docs/${page}.md`).toContain(`${INPUT_PARTS.cacheRead}, ${INPUT_PARTS.cacheCreation}`);
      expect(text, `docs/${page}.md`).not.toMatch(/cache[ -]writes?\b/i);
    }
  });
});
