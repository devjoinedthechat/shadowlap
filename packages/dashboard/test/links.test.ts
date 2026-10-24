import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isLink, links } from '../src/links.js';
import { href, parseRoute, routeHref, VIEWS } from '../ui/route.js';
import { runsLinkQuery } from '../ui/runspage/query.js';

// Every link the server writes comes from one builder (src/links.ts), and every link it builds opens
// the page it names: parsed by the page's own router (ui/route.ts) and written back the same.

const RUN = '01M5MXZ4Q3FWR1ND46Y5PGVZ1X';
const OTHER = '01M5MXZ24MS0P1DGD93RKC555R';

/** Every link the builder writes, with every argument it takes. */
const built: string[] = [
  links.overview(),
  links.runs(),
  links.runs({ types: 'failed' }),
  links.runs({ q: 'refund', types: 'local', sort: 'calls', from: '2026-10-20', to: '2026-10-20' }),
  links.run(RUN),
  links.run(RUN, 17),
  links.run(RUN, 17, 'calls'),
  ...VIEWS.flatMap((v) => [links.run(RUN, null, v), links.run(RUN, 9, v)]),
  links.compare(),
  links.compare(RUN, OTHER),
  links.fixes(),
  links.fixes('fx-01M5MXZ7H9'),
  ...(['blame', 'repair', 'verify'] as const).map((step) => links.fixes('fx-01M5MXZ7H9', step)),
  links.fixes('fx-01M5MXZ7H9', 'verify', 'vf-01M5MXZ9AB'),
  links.tests(),
  links.training(),
  links.training('pairs'),
  links.training('tasks'),
  links.settings(),
  ...['matching', 'redaction', 'alerts', 'agents', 'tools', 'project', 'store'].map((tab) => links.settings(tab)),
  links.newProject(),
  links.setup(),
  links.storeSetup(),
];

describe('the link builder', () => {
  it('writes only links the page’s router opens, and reads back as it wrote them', () => {
    for (const link of built) {
      const route = parseRoute(link);
      expect(route.page, link).not.toBe('notfound');
      expect(routeHref(route), link).toBe(link);
      expect(isLink(link), link).toBe(true);
    }
  });

  it('is the builder the page writes its own links with', () => {
    expect(href).toBe(links);
  });

  it('writes a link to Runs that asks for words, a chip, a sort and days, which the Runs page reads back', () => {
    expect(parseRoute(links.runs({ types: 'failed' })).page).toBe('runs');
    expect(runsLinkQuery(links.runs({ types: 'failed' }))).toEqual({ q: '', types: 'failed', sort: 'when', days: null });
    expect(runsLinkQuery(links.runs({ types: 'local' }))).toEqual({ q: '', types: 'local', sort: 'when', days: null });
    // `type`, as callers named the chip before, writes the same link.
    expect(links.runs({ type: 'local' })).toBe(links.runs({ types: 'local' }));
    const words = links.runs({ q: 'refund (A-1042) & more', types: 'fork', sort: 'spent', from: '2026-10-20', to: '2026-10-21' });
    expect(parseRoute(words).page).toBe('runs');
    expect(routeHref(parseRoute(words))).toBe(words);
    expect(runsLinkQuery(words)).toEqual({ q: 'refund (A-1042) & more', types: 'fork', sort: 'spent', days: { from: '2026-10-20', to: '2026-10-21' } });
    expect(isLink(words)).toBe(true);
    expect(links.runs({ q: '  ', types: 'all' })).toBe('#/runs');
  });

  it('keeps a value that would break the route inside its own segment', () => {
    const odd = links.settings('a/b');
    expect(parseRoute(odd)).toEqual({ page: 'settings', tab: null });
    expect(parseRoute(links.fixes('fx-1', 'verify', 'vf 2'))).toMatchObject({ page: 'fixes', id: 'fx-1', step: 'verify' });
  });

  it('takes a command’s job link only when it is a route of the page', () => {
    expect(isLink('#/run/01M5MXZ4Q3/forks')).toBe(true);
    for (const bad of ['https://example.net/#/runs', 'javascript:alert(1)', '#/run/<script>', `#/${'x'.repeat(600)}`, 7, null]) expect(isLink(bad), String(bad)).toBe(false);
  });
});

/** The server's sources, comments left out, as the build compiles them. */
function sources(dir: string): Array<{ file: string; code: string }> {
  const out: Array<{ file: string; code: string }> = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (name.endsWith('.ts')) out.push({ file: path, code: readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1') });
  }
  return out;
}

describe('the server’s links', () => {
  it('are all built by the one builder: no file writes a #/ link of its own', () => {
    const src = fileURLToPath(new URL('../src/', import.meta.url));
    const own = sources(src).flatMap(({ file, code }) => {
      const at = file.slice(src.length);
      // The builder itself; and the decision diff's sessions, whose pages the dashboard doesn't have.
      if (at === 'links.ts') return [];
      return [...code.matchAll(/['"`]#\/[^'"`]*/g)].filter((m) => !(at === 'decisions.ts' && m[0].startsWith('`#/changes/'))).map((m) => `${at}: ${m[0]}`);
    });
    expect(own).toEqual([]);
  });

  it('and so are the links a command reports to its dashboard job: the CLI writes none of its own', () => {
    const cli = fileURLToPath(new URL('../../cli/src/', import.meta.url));
    const own = sources(cli).flatMap(({ file, code }) => [...code.matchAll(/['"`]#\/[^'"`]*/g)].map((m) => `${file.slice(cli.length)}: ${m[0]}`));
    expect(own).toEqual([]);
    // The sites that wrote them by hand build them now.
    for (const file of ['chaos-session.ts', 'run-agent.ts', 'team.ts', 'commands/coverage.ts', 'commands/testing.ts', 'commands/changes.ts', 'commands/injection.ts', 'commands/record.ts', 'commands/training.ts']) expect(readFileSync(join(cli, file), 'utf8'), file).toMatch(/import \{ [^}]*\blinks\b[^}]*\} from '@shadowlap\/dashboard'/);
  });
});
