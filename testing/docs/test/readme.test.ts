// The README describes the sidecar, the environment it hands the agent, and the terminal UI.
// None of that is generated, so it drifts silently: the architecture diagram once claimed three
// providers while six were proxied, and named no route for declared HTTP hosts. These checks fail
// the build when the code grows past what the README says about it.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { providers } from '../../../packages/sidecar/src/providers.js';
import { TABS } from '../../../packages/tui/src/components/Inspector.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const readme = readFileSync(join(root, 'README.md'), 'utf8');

/** The fenced block under "## How it works". */
const diagram = (() => {
  const after = readme.slice(readme.indexOf('## How it works'));
  const open = after.indexOf('```');
  return after.slice(open + 3, after.indexOf('```', open + 3));
})();

describe('the architecture diagram', () => {
  it('names a route for every provider the sidecar proxies', () => {
    const missing = providers.map((p) => p.id).filter((id) => !diagram.includes(`/${id}/*`));
    expect(missing, 'providers proxied but absent from the README diagram').toEqual([]);
  });

  it('claims no route the sidecar does not serve', () => {
    const known = new Set([...providers.map((p) => p.id), 'v1', 'http', 't']);
    const claimed = [...diagram.matchAll(/\/([a-z0-9]+)(?:\/[a-z0-9]+)*\/\*/g)].map((m) => m[1]!);
    expect(claimed.filter((r) => !known.has(r)), 'routes in the README the sidecar cannot answer').toEqual([]);
  });

  it('only names environment variables that shadowlap run actually sets', () => {
    const agent =
      readFileSync(join(root, 'packages', 'cli', 'src', 'run-agent.ts'), 'utf8') +
      readFileSync(join(root, 'packages', 'sidecar', 'src', 'server.ts'), 'utf8');
    const named = [...new Set([...diagram.matchAll(/\b(SHADOWLAP_[A-Z_]+)\b/g)].map((m) => m[1]!))];
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((v) => !agent.includes(v)), 'named in the README but never set').toEqual([]);
  });
});

describe('the terminal UI section', () => {
  it('shows the inspector tabs the TUI renders, in order', () => {
    const strip = readme.split('\n').find((l) => l.includes('conversation') && l.includes('request'));
    expect(strip, 'no inspector tab strip in the README').toBeDefined();
    const shown = TABS.filter((t) => strip!.includes(t));
    expect(shown).toEqual([...TABS]);
  });

  it('shows the footer the TUI renders, cut only where the TUI cuts it', () => {
    const source = readFileSync(join(root, 'packages', 'tui', 'src', 'components', 'TimelineView.tsx'), 'utf8');
    const footer = /' (: actions · [^']+)'/.exec(source)?.[1];
    expect(footer, 'no timeline footer in TimelineView.tsx').toBeDefined();
    const line = readme.split('\n').find((l) => l.trimStart().startsWith(': actions'));
    expect(line, 'no footer in the README sample').toBeDefined();
    // The sample is a frame at a fixed width, so it may end in the TUI's own ellipsis; before that,
    // it must be the footer itself, hint for hint and in order, not a paraphrase that drifts.
    const shown = line!.trim().replace(/\s*…$/, '');
    expect(footer!.startsWith(shown), `the README shows "${shown}"; the TUI renders "${footer}"`).toBe(true);
    expect(shown.split('·').length, 'the README footer shows too little of the real one').toBeGreaterThanOrEqual(footer!.split('·').length - 3);
  });

  it('is one frame at one width, header and footer as the TUI cuts them at it', () => {
    const frame = /```text\n([\s\S]*?)\n```/.exec(readme.slice(readme.indexOf('## Dashboard and terminal UI')))?.[1];
    expect(frame, 'no terminal UI frame in the README').toBeDefined();
    const lines = frame!.split('\n');
    const width = [...lines[1]!].length;
    expect(lines[1]).toMatch(/^╭─+╮$/);
    expect(lines.filter((l) => [...l].length !== width), 'lines narrower or wider than the frame').toEqual([]);
  });
});

// The terminal comes in three widths, and a narrower one is drawn at its own width, never stretched
// to the column: a width on its <source> says how wide, and goes stale when npm run demo draws it anew.
describe('the README pictures', () => {
  it('are files here, and a source with a width is as wide as its picture', () => {
    const tags = [...readme.matchAll(/<(?:source|img)\b[^>]*>/g)].map((m) => m[0]);
    const local = tags.map((tag) => ({ tag, path: /(?:srcset|src)="(\.github\/[^"]+)"/.exec(tag)?.[1] })).filter((t) => t.path);
    expect(local.length).toBeGreaterThan(10);
    expect(local.filter((t) => !existsSync(join(root, t.path!))).map((t) => t.path), 'pictures the README names that are not here').toEqual([]);
    const sized = local.filter((t) => t.tag.startsWith('<source') && / width="\d+"/.test(t.tag));
    expect(sized.length).toBeGreaterThan(0);
    for (const { tag, path } of sized) {
      const svg = readFileSync(join(root, path!), 'utf8');
      expect(/ width="(\d+)"/.exec(tag)![1], path).toBe(/<svg\b[^>]* width="(\d+)"/.exec(svg)?.[1]);
    }
  });
});

/** A heading's anchor as GitHub makes it: lower case, punctuation dropped, spaces as hyphens. */
const anchor = (heading: string) =>
  heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');

/** Every anchor a Markdown file's headings give it, the second of a name with -1 after it, as GitHub numbers them. */
function anchors(markdown: string): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const m = fenced ? null : /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const base = anchor(m[1]!);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  return out;
}

/** The source files under a folder, leaving out what is built or installed there. */
function sources(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return ['node_modules', 'dist', '__pycache__', 'test', 'tests'].includes(e.name) ? [] : sources(join(dir, e.name));
    return /\.(ts|tsx|mjs|js|py)$/.test(e.name) && !e.name.endsWith('.d.ts') ? [join(dir, e.name)] : [];
  });
}

// The CLI and the dashboard print links into the repository, the telemetry notice among them: a
// heading renamed or a page moved leaves a link that lands on nothing, as #telemetry once did.
describe('links into the repository that the code prints', () => {
  it('name a file that exists, and a heading it has', () => {
    const files = [...readdirSync(join(root, 'packages')).flatMap((p) => sources(join(root, 'packages', p))), ...sources(join(root, 'sdks', 'python', 'shadowlap'))];
    const links: Array<{ where: string; url: string; path: string; hash: string | undefined }> = [];
    for (const file of files) {
      for (const m of readFileSync(file, 'utf8').matchAll(/https:\/\/github\.com\/devjoinedthechat\/shadowlap(?:\/blob\/[\w.-]+\/([\w./-]+))?(?:#([\w-]+))?/g)) {
        links.push({ where: relative(root, file), url: m[0], path: m[1] ?? 'README.md', hash: m[2] });
      }
    }
    expect(links.map((l) => l.where), 'the telemetry notice\'s link').toContain(join('packages', 'cli', 'src', 'telemetry.ts'));
    const broken = links.filter((l) => !existsSync(join(root, l.path)) || (l.hash !== undefined && !anchors(readFileSync(join(root, l.path), 'utf8')).has(l.hash)));
    expect(broken.map((l) => `${l.where}: ${l.url}`), 'links that land on no file or no heading').toEqual([]);
  });
});
