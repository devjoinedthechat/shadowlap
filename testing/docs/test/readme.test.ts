// The README describes the sidecar, the environment it hands the agent, and the terminal UI.
// None of that is generated, so it drifts silently: the architecture diagram once claimed three
// providers while six were proxied, and named no route for declared HTTP hosts. These checks fail
// the build when the code grows past what the README says about it.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
});
