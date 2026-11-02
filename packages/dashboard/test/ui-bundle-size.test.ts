import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { describe, expect, it } from 'vitest';

/**
 * The dashboard's scripts (ui-bundles.mjs), built here as build-ui.mjs builds them, minified, and
 * held to their budgets. Sizes are as served, uncompressed (a KB is 1,024 bytes): the dashboard
 * serves the files as they are.
 *
 * - The served build is split. What the first look loads before any page (app.js and the chunks it
 *   imports up front): at most 480 KB (417 KB when this was written; React DOM is half of it). It
 *   was one script of 803 KB with every page in it.
 * - Each page the shell routes to is a chunk of its own that loads when the page first opens
 *   (ui/pages/lazy.tsx). What a page adds to the first look, its own code and the chunks only pages
 *   need: at most 200 KB each (the run page, the largest, 174 KB; Runs 70 KB; the Overview 38 KB).
 * - An exported copy is one script, since a file has no server to load a chunk from, built from an
 *   entry of its own (ui/main-copy.tsx) with only the pages a copy shows: its runs, a run's page and
 *   Compare between them. At most 900 KB (599 KB; 868 KB when it held every page).
 */

const KB = 1024;
const FIRST_LOOK = 480 * KB;
const PAGE = 200 * KB;
const COPY = 900 * KB;

/** The pages the shell routes to, by their chunk's name: the list grows as pages land. */
const PAGES = ['Compare', 'Fixes', 'NewProject', 'Overview', 'Run', 'Runs', 'Settings', 'Setup', 'StoreSetup', 'Tests', 'Training'];
/** The pages an exported copy shows (ui/pages/copy.tsx). */
const COPY_PAGES = ['Compare', 'Run', 'Runs'];

interface Bundles {
  served: esbuild.BuildOptions;
  copy: esbuild.BuildOptions;
}

const here = fileURLToPath(new URL('..', import.meta.url));
// The options build-ui.mjs builds with; a plain script, so it is loaded by its path.
const { uiBundles } = (await import(new URL('../ui-bundles.mjs', import.meta.url).href)) as { uiBundles: (o: { ui: string; out: string }) => Bundles };
const bundles = uiBundles({ ui: resolve(here, 'ui'), out: resolve(here, 'dist', 'budget') });
const build = (o: esbuild.BuildOptions) => esbuild.build({ ...o, write: false, metafile: true, absWorkingDir: here, logLevel: 'silent' });

/** A module's name as its chunk takes it: ui/pages/settings/StoreSetup.tsx is StoreSetup. */
const nameOf = (input: string) => /([^/]+)\.tsx?$/.exec(input)![1];
const kb = (bytes: number) => `${(bytes / KB).toFixed(0)} KB`;

describe('the dashboard’s scripts', () => {
  it('load the shell first and each page’s code when it opens, within their budgets', async () => {
    const { metafile } = await build(bundles.served);
    const outs = metafile.outputs;
    // An output and what it imports up front, transitively: what loading it loads.
    const loads = (out: string, seen = new Set<string>()): Set<string> => {
      if (seen.has(out)) return seen;
      seen.add(out);
      for (const i of outs[out].imports) if (i.kind === 'import-statement') loads(i.path, seen);
      return seen;
    };
    const sum = (files: Iterable<string>) => [...files].reduce((n, f) => n + outs[f].bytes, 0);
    const first = loads(Object.keys(outs).find((o) => o.endsWith('/assets/app.js'))!);
    const firstBytes = sum(first);
    // The pages: what the shell's page list loads when a page opens, each a chunk of its own.
    const pageEntries = metafile.inputs['ui/pages/lazy.tsx'].imports.filter((i) => i.kind === 'dynamic-import').map((i) => i.path);
    const chunkOf = (entry: string) => Object.keys(outs).find((o) => outs[o].entryPoint === entry)!;
    const added = pageEntries.map((entry) => ({ page: nameOf(entry), bytes: sum([...loads(chunkOf(entry))].filter((f) => !first.has(f))) }));
    const report = [...added]
      .sort((a, b) => b.bytes - a.bytes)
      .map((a) => `${a.page} ${kb(a.bytes)}`)
      .join(', ');
    process.stdout.write(`first look ${kb(firstBytes)} in ${first.size} files; each page adds: ${report}\n`);
    expect(firstBytes).toBeLessThan(FIRST_LOOK);
    for (const a of added) expect(a.bytes, `${a.page} adds ${kb(a.bytes)}`).toBeLessThan(PAGE);
    // Every page the shell routes to is a chunk of its own, and the run page's code is not in the first look.
    expect(added.map((a) => a.page).sort()).toEqual(PAGES);
    const firstInputs = new Set([...first].flatMap((f) => Object.keys(outs[f].inputs)));
    expect(firstInputs.has('ui/pages/Run.tsx')).toBe(false);
    expect(firstInputs.has('ui/run/Inspector.tsx')).toBe(false);
    // Nothing of an exported copy's own entry is served.
    const served = new Set(Object.values(outs).flatMap((o) => Object.keys(o.inputs)));
    expect(served.has('ui/main-copy.tsx')).toBe(false);
    expect(served.has('ui/pages/copy.tsx')).toBe(false);
  }, 120_000);

  it('give an exported copy one script with the pages it shows and none of the others, within its budget', async () => {
    const { metafile } = await build(bundles.copy);
    const script = Object.entries(metafile.outputs).filter(([o]) => o.endsWith('.js'));
    expect(script).toHaveLength(1);
    const [, whole] = script[0];
    const held = Object.keys(whole.inputs);
    const pages = held.filter((i) => /^ui\/pages\/(settings\/)?[A-Z]\w*\.tsx$/.test(i) && PAGES.includes(nameOf(i)));
    expect(pages.map(nameOf).sort()).toEqual(COPY_PAGES);
    expect(held).toContain('ui/pages/copy.tsx');
    // Not the dashboard's page list, which would bring every page with it.
    expect(held).not.toContain('ui/pages/lazy.tsx');
    expect(held).not.toContain('ui/main.tsx');
    process.stdout.write(`an exported copy's script ${kb(whole.bytes)}\n`);
    expect(whole.bytes).toBeLessThan(COPY);
  }, 120_000);
});
