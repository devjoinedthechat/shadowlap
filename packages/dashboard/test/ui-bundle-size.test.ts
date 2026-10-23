import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { describe, expect, it } from 'vitest';

/**
 * The dashboard's script is split (ui-bundles.mjs, ui/pages/lazy.tsx): the first one holds the shell
 * and what the pages share, and each page's own code loads when the page first opens. It was one
 * script of 803 KB for every page. The budgets, built here as build-ui.mjs builds them, minified:
 *
 * - What the first look loads before any page (app.js and the chunks it imports up front): at most
 *   480 KB (407 KB when this was written; React DOM is half of it).
 * - What a page adds to that, its own code and the chunks only pages need: at most 200 KB each (the
 *   run page, the largest, 157 KB; Runs 99 KB; the Overview 38 KB).
 * - An exported copy's script, every page in one file since a copy has no server to load a chunk
 *   from: at most 900 KB (821 KB).
 *
 * Sizes are as served, uncompressed (a KB is 1,024 bytes): the dashboard serves the files as they are.
 */

const KB = 1024;
const FIRST_LOOK = 480 * KB;
const PAGE = 200 * KB;
const COPY = 900 * KB;

interface Bundles {
  served: esbuild.BuildOptions;
  standalone: esbuild.BuildOptions;
}

const here = fileURLToPath(new URL('..', import.meta.url));
// The options build-ui.mjs builds with; a plain script, so it is loaded by its path.
const { uiBundles } = (await import(new URL('../ui-bundles.mjs', import.meta.url).href)) as { uiBundles: (o: { ui: string; out: string }) => Bundles };

describe('the dashboard’s scripts', () => {
  it('load the shell first and each page’s code when it opens, within their budgets', async () => {
    const { served, standalone } = uiBundles({ ui: resolve(here, 'ui'), out: resolve(here, 'dist', 'budget') });
    const built = await esbuild.build({ ...served, write: false, metafile: true, absWorkingDir: here, logLevel: 'silent' });
    const outs = built.metafile.outputs;
    const bytes = (out: string) => outs[out]!.bytes;
    // An output and what it imports up front, transitively: what loading it loads.
    const loads = (out: string, seen = new Set<string>()): Set<string> => {
      if (seen.has(out)) return seen;
      seen.add(out);
      for (const i of outs[out]!.imports) if (i.kind === 'import-statement') loads(i.path, seen);
      return seen;
    };
    const sum = (files: Iterable<string>) => [...files].reduce((n, f) => n + bytes(f), 0);
    const app = Object.keys(outs).find((o) => o.endsWith('/assets/app.js'))!;
    const first = loads(app);
    const firstBytes = sum(first);
    // The pages' own scripts: chunks named after their page.
    const pages = Object.keys(outs).filter((o) => /\/chunks\/[A-Z]\w*-\w+\.js$/.test(o));
    const added = pages.map((p) => ({ page: /\/chunks\/(\w+)-/.exec(p)![1]!, bytes: sum([...loads(p)].filter((f) => !first.has(f))) }));
    const report = added
      .sort((a, b) => b.bytes - a.bytes)
      .map((a) => `${a.page} ${(a.bytes / KB).toFixed(0)} KB`)
      .join(', ');
    process.stdout.write(`first look ${(firstBytes / KB).toFixed(0)} KB in ${first.size} files; each page adds: ${report}\n`);
    expect(firstBytes).toBeLessThan(FIRST_LOOK);
    for (const a of added) expect(a.bytes, `${a.page} adds ${(a.bytes / KB).toFixed(0)} KB`).toBeLessThan(PAGE);
    // Every page the shell routes to is a chunk of its own, and the run page's code is not in the first look.
    expect(added.map((a) => a.page).sort()).toEqual(['Compare', 'Fixes', 'NewProject', 'Overview', 'Run', 'Runs', 'Settings', 'Setup', 'StoreSetup', 'Tests', 'Training']);
    const firstInputs = new Set([...first].flatMap((f) => Object.keys(outs[f]!.inputs)));
    expect(firstInputs.has('ui/pages/Run.tsx')).toBe(false);
    expect(firstInputs.has('ui/run/Inspector.tsx')).toBe(false);

    const copy = await esbuild.build({ ...standalone, write: false, metafile: true, absWorkingDir: here, logLevel: 'silent' });
    const script = Object.entries(copy.metafile.outputs).filter(([o]) => o.endsWith('.js'));
    // One script, with every page in it.
    expect(script).toHaveLength(1);
    const [, whole] = script[0]!;
    expect(Object.keys(whole.inputs)).toContain('ui/pages/Run.tsx');
    process.stdout.write(`an exported copy's script ${(whole.bytes / KB).toFixed(0)} KB\n`);
    expect(whole.bytes).toBeLessThan(COPY);
  }, 120_000);
});
