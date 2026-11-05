import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DOCS, DOCS_AT, docsHref } from '../ui/docs-links.js';

/**
 * A dialog's lead ends on the docs page that says how the job works: every link has to land. Read
 * from the repository's docs/*.md with GitHub's rule for a heading's anchor: lower case, punctuation
 * out, each space a dash, a heading met again numbered.
 */
const DOCS_DIR = resolve(fileURLToPath(import.meta.url), '../../../../docs');

function slug(heading: string): string {
  return heading
    .trim()
    .replace(/`/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/** Every anchor of a page: headings outside its code blocks. */
function anchors(markdown: string): Set<string> {
  const out = new Set<string>();
  const seen = new Map<string, number>();
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    const h = !fenced && /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!h) continue;
    const base = slug(h[1]);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  return out;
}

describe('the docs a dialog links to', () => {
  it.each(Object.entries(DOCS))('%s lands on a heading of its page', (_key, link) => {
    const [file, anchor] = link.page.split('#');
    const path = resolve(DOCS_DIR, `${file}.md`);
    expect(existsSync(path), `docs/${file}.md`).toBe(true);
    if (anchor) expect(anchors(readFileSync(path, 'utf8'))).toContain(anchor);
  });

  it('names what it opens, as the link says it, and opens the page on the repository', () => {
    for (const link of Object.values(DOCS)) {
      expect(link.what).toMatch(/^[A-Z]/);
      expect(link.what).not.toMatch(/in the docs|→/);
    }
    expect(docsHref(DOCS.repairHandover)).toBe(`${DOCS_AT}repair.md#handing-it-over`);
    expect(docsHref(DOCS.mcp)).toBe(`${DOCS_AT}mcp.md`);
  });
});
