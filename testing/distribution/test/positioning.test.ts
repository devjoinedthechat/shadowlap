// "Change safety for agents" is the plain name of the job Shadowlap does, used where people compare
// tools or explain them to someone else: the README's first line, the docs' introduction, the page
// that compares Shadowlap with other tools, and the listings people find it in (npm, the GitHub
// Marketplace, Claude Code's plugin list). Each is followed by the mechanism: record, replay, fork.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { shownDescription } from '../../coding-agents/test/instructions.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const LINE = 'Change safety for agents';

/** The first paragraph of prose under a page's title. */
const lede = (markdown: string) => markdown.split('\n\n').find((p, i) => i > 0 && !p.startsWith('#'))!.trim();

describe('the name of the job', () => {
  it('is the README’s first line, and the mechanism comes next', () => {
    const header = /<p align="center">\s*<b>([^<]+)<\/b><br>\s*([^\n]+)/.exec(read('README.md'));
    expect(header?.[1]).toBe(`${LINE}.`);
    expect(header?.[2]).toMatch(/^Record, replay and fork AI agent runs/);
  });

  it('opens the docs’ introduction and the page that compares tools', () => {
    for (const page of ['docs/index.md', 'docs/compare.md']) expect(lede(read(page)), page).toMatch(new RegExp(`^Shadowlap is ${LINE.toLowerCase()}[:,]`));
  });

  it('leads the listings people find Shadowlap in', () => {
    const cli = JSON.parse(read('packages/cli/package.json')) as { description: string };
    expect(cli.description).toBe(`${LINE}: record, replay and fork AI agent runs.`);
    expect(read('packages/cli/README.md').split('\n')[2]).toBe(cli.description);
    // As Claude Code shows the plugin, before an install and after: the marketplace entry's text
    // wherever it sets one, so this reads what the user reads, not only plugin.json.
    expect(shownDescription().startsWith(`${LINE}: `), shownDescription()).toBe(true);
  });
});
