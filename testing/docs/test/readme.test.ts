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
import { FORK_MENU_KEYS, FORK_MENU_LEAD, INSPECTOR_KEYS, TIMELINE_KEYS } from '../../../packages/tui/src/components/TimelineView.js';

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
    const claimed = [...diagram.matchAll(/\/([a-z0-9]+)(?:\/[a-z0-9]+)*\/\*/g)].map((m) => m[1]);
    expect(claimed.filter((r) => !known.has(r)), 'routes in the README the sidecar cannot answer').toEqual([]);
  });

  it('only names environment variables that shadowlap run actually sets', () => {
    const agent =
      readFileSync(join(root, 'packages', 'cli', 'src', 'run-agent.ts'), 'utf8') +
      // The environment the sidecar hands a run's processes (envFor, envForSlot).
      readFileSync(join(root, 'packages', 'sidecar', 'src', 'lifecycle.ts'), 'utf8');
    const named = [...new Set([...diagram.matchAll(/\b(SHADOWLAP_[A-Z_]+)\b/g)].map((m) => m[1]))];
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((v) => !agent.includes(v)), 'named in the README but never set').toEqual([]);
  });
});

/** The terminal UI frame a page shows: the first fenced block, from `from` on, with the TUI's box in it. */
function tuiFrame(page: string, from = 0): string | undefined {
  for (const m of page.slice(from).matchAll(/```[a-z]*\n([\s\S]*?)\n```/g)) if (/^╭/m.test(m[1])) return m[1];
  return undefined;
}

/** The frames the README and the terminal UI's page show, each a run's screen as the TUI's own render draws it. */
const frames: Array<[string, string | undefined]> = [
  ['README.md', tuiFrame(readme, readme.indexOf('## Dashboard and terminal UI'))],
  ['docs/tui.md', tuiFrame(readFileSync(join(root, 'docs', 'tui.md'), 'utf8'))],
];

describe('the terminal UI section', () => {
  it('shows the inspector tabs the TUI renders, in order', () => {
    const strip = readme.split('\n').find((l) => l.includes('conversation') && l.includes('request'));
    expect(strip, 'no inspector tab strip in the README').toBeDefined();
    const shown = TABS.filter((t) => strip!.includes(t));
    expect(shown).toEqual([...TABS]);
  });

  it('shows a footer the TUI renders, cut only where the TUI cuts it', () => {
    for (const [page, frame] of frames) {
      expect(frame, `no terminal UI frame in ${page}`).toBeDefined();
      const footer = frame!.split('\n').at(-1)!.trim();
      // The footer is whole hints, a key and what it does, two spaces apart, after what the keys act on
      // when there is one: the sample is a frame at a fixed width, so it may stop after the last hint
      // that fits, but each hint it shows is the TUI's own, in the TUI's order, not a paraphrase.
      const shown = footer.split(/ {2}/);
      const footers: Array<[string | null, ReadonlyArray<readonly [string, string]>]> = [
        [null, TIMELINE_KEYS],
        [null, INSPECTOR_KEYS],
        [FORK_MENU_LEAD, FORK_MENU_KEYS],
      ];
      const rendered = footers.some(([lead, keys]) => {
        const hints = lead === null ? shown : shown[0] === lead ? shown.slice(1) : null;
        if (!hints) return false;
        const all = keys.map(([k, d]) => `${k} ${d}`);
        let at = 0;
        for (const hint of hints) {
          at = all.indexOf(hint, at);
          if (at < 0) return false;
          at++;
        }
        return hints.length >= Math.min(3, all.length);
      });
      expect(rendered, `${page} shows "${footer}"; no footer of the TUI reads like that`).toBe(true);
    }
  });

  it('is one frame at one width under the two lines the TUI draws above it, header and footer as the TUI fits them to it', () => {
    for (const [page, frame] of frames) {
      expect(frame, `no terminal UI frame in ${page}`).toBeDefined();
      const lines = frame!.split('\n');
      // Above the box, what a run's screen draws there: its header (its id, what it is and its stats),
      // and under it the line saying what the run was about and how it stands.
      const [header, about, top] = lines as [string, string, string];
      expect(header, `${page}: the run's header`).toMatch(/^ [0-9A-Z]{10} \S/);
      expect(about, `${page}: the line under the header`).toMatch(/^ (?![╭│╰])/);
      expect(top, `${page}: the box's top`).toMatch(/^(╭─+╮)+$/);
      expect(lines.at(-2), `${page}: the box's bottom`).toMatch(/^(╰─+╯)+$/);
      // The box is as wide as the terminal; the lines above it and the footer under it show whole
      // items only, so they end where the last one that fits does.
      const width = [...top].length;
      const footer = lines.at(-1)!;
      expect(lines.slice(2, -1).filter((l) => [...l].length !== width), `${page}: lines of the box narrower or wider than it`).toEqual([]);
      expect([header, about, footer].filter((l) => [...l].length > width), `${page}: a header or footer wider than the frame`).toEqual([]);
    }
  });
});

describe('the README pictures', () => {
  it('are files here, and a source with a width is as wide as its picture', () => {
    const tags = [...readme.matchAll(/<(?:source|img)\b[^>]*>/g)].map((m) => m[0]);
    const local = tags.map((tag) => ({ tag, path: /(?:srcset|src)="(\.github\/[^"]+)"/.exec(tag)?.[1] })).filter((t) => t.path);
    expect(local.length).toBeGreaterThan(10);
    expect(local.filter((t) => !existsSync(join(root, t.path!))).map((t) => t.path), 'pictures the README names that are not here').toEqual([]);
    const sized = local.filter((t) => t.tag.startsWith('<source') && / width="\d+"/.test(t.tag));
    expect(sized.map((t) => t.path!.replace(/^.*\./, '')).sort()).toEqual(['png', 'png', 'png', 'png', 'svg', 'svg', 'svg', 'svg']);
    for (const { tag, path } of sized) {
      const file = readFileSync(join(root, path!));
      // A PNG's width is in its header (IHDR), at twice the pixels; an SVG's on its root element.
      const drawn = path!.endsWith('.png') ? String(file.readUInt32BE(16) / 2) : /<svg\b[^>]* width="(\d+)"/.exec(file.toString('utf8'))?.[1];
      expect(/ width="(\d+)"/.exec(tag)![1], path).toBe(drawn);
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
    const base = anchor(m[1]);
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
    // Each package's folder; a file beside them (a Finder's .DS_Store) is none.
    const packages = readdirSync(join(root, 'packages'), { withFileTypes: true }).filter((e) => e.isDirectory());
    const files = [...packages.flatMap((p) => sources(join(root, 'packages', p.name))), ...sources(join(root, 'sdks', 'python', 'shadowlap'))];
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
