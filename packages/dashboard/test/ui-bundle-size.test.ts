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
 *   imports up front): at most 480 KB (420 KB when this was written; React DOM is half of it). It
 *   was one script of 803 KB with every page in it.
 * - Each page the shell routes to is a chunk of its own that loads when the page first opens
 *   (ui/pages/lazy.tsx). What a page adds to the first look, its own code and the chunks only pages
 *   need: at most 200 KB each (the run page, the largest, 144 KB; Runs 70 KB; the Overview 38 KB).
 * - A part of a page heavy enough to wait for a script of its own until it first shows (`onShow`,
 *   ui/components/OnShow.tsx), such as a run's views but Calls: what it adds to the first look and
 *   the page that shows it, at most 100 KB each (Provenance, the largest, 10 KB).
 * - An exported copy is one script, since a file has no server to load a chunk from, built from an
 *   entry of its own (ui/main-copy.tsx) with only the pages a copy shows, its runs, a run's page and
 *   Compare between them, and the parts they show. At most 900 KB (605 KB; 868 KB when it held
 *   every page).
 */

const KB = 1024;
const FIRST_LOOK = 480 * KB;
const PAGE = 200 * KB;
const PART = 100 * KB;
const COPY = 900 * KB;

/** The pages the shell routes to, by their chunk's name: the list grows as pages land. */
const PAGES = ['Compare', 'Fixes', 'NewProject', 'Overview', 'Run', 'Runs', 'Settings', 'Setup', 'StoreSetup', 'Tests', 'Training'];
/** The parts of pages in scripts of their own, by their chunk's name: the list grows as parts land. */
const PARTS = ['ContextView', 'ForksView', 'ProvenanceView', 'TimelineView', 'TurnsView'];
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
const report = (added: Array<{ name: string; bytes: number }>) =>
  [...added]
    .sort((a, b) => b.bytes - a.bytes)
    .map((a) => `${a.name} ${kb(a.bytes)}`)
    .join(', ');

/** What each module loads with `import()`, by the module that asks: the parts of the served build that wait for a script of their own. */
function dynamicImports(meta: esbuild.Metafile): Array<{ entry: string; by: string }> {
  return Object.entries(meta.inputs).flatMap(([by, input]) => input.imports.filter((i) => i.kind === 'dynamic-import').map((i) => ({ entry: i.path, by })));
}

describe('the dashboard’s scripts', () => {
  it('load the shell first, each page’s code when it opens and each part’s when it shows, within their budgets', async () => {
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
    const inputsOf = (files: Iterable<string>) => new Set([...files].flatMap((f) => Object.keys(outs[f].inputs)));
    const chunkOf = (entry: string) => Object.keys(outs).find((o) => outs[o].entryPoint === entry)!;
    const holding = (input: string) => Object.keys(outs).find((o) => input in outs[o].inputs)!;
    const first = loads(Object.keys(outs).find((o) => o.endsWith('/assets/app.js'))!);
    const firstBytes = sum(first);
    const firstInputs = inputsOf(first);

    // The pages: what the shell's page list loads when a page opens, each a chunk of its own.
    const asked = dynamicImports(metafile);
    const pages = asked.filter((d) => d.by === 'ui/pages/lazy.tsx').map((d) => ({ name: nameOf(d.entry), bytes: sum([...loads(chunkOf(d.entry))].filter((f) => !first.has(f))) }));
    // The parts: every other `import()`, with what it adds to what the module asking for it loaded.
    const parts = asked
      .filter((d) => d.by !== 'ui/pages/lazy.tsx')
      .map((d) => {
        const page = loads(holding(d.by));
        return { name: nameOf(d.entry), entry: d.entry, shownWith: inputsOf(page), bytes: sum([...loads(chunkOf(d.entry))].filter((f) => !first.has(f) && !page.has(f))) };
      });
    process.stdout.write(`first look ${kb(firstBytes)} in ${first.size} files; each page adds: ${report(pages)}; each part adds: ${report(parts)}\n`);
    expect(firstBytes).toBeLessThan(FIRST_LOOK);
    for (const a of pages) expect(a.bytes, `${a.name} adds ${kb(a.bytes)}`).toBeLessThan(PAGE);
    for (const a of parts) expect(a.bytes, `${a.name} adds ${kb(a.bytes)}`).toBeLessThan(PART);
    // Every page the shell routes to is a chunk of its own, and so is every part, loaded neither in
    // the first look nor with the page that shows it.
    expect(pages.map((a) => a.name).sort()).toEqual(PAGES);
    expect(parts.map((a) => a.name).sort()).toEqual(PARTS);
    for (const p of parts) expect(firstInputs.has(p.entry) || p.shownWith.has(p.entry), `${p.name} waits for its own script`).toBe(false);
    // The run page's code is not in the first look.
    expect(firstInputs.has('ui/pages/Run.tsx')).toBe(false);
    expect(firstInputs.has('ui/run/Inspector.tsx')).toBe(false);
    // Nothing of an exported copy's own entry is served.
    const served = inputsOf(Object.keys(outs));
    expect(served.has('ui/main-copy.tsx')).toBe(false);
    expect(served.has('ui/pages/copy.tsx')).toBe(false);
  }, 120_000);

  it('give an exported copy one script with the pages it shows and the parts they show, none of the others, within its budget', async () => {
    const { metafile } = await build(bundles.copy);
    const script = Object.entries(metafile.outputs).filter(([o]) => o.endsWith('.js'));
    expect(script).toHaveLength(1);
    const [, whole] = script[0];
    const held = new Set(Object.keys(whole.inputs));
    const pages = [...held].filter((i) => /^ui\/pages\/(settings\/)?[A-Z]\w*\.tsx$/.test(i) && PAGES.includes(nameOf(i)));
    expect(pages.map(nameOf).sort()).toEqual(COPY_PAGES);
    expect(held.has('ui/pages/copy.tsx')).toBe(true);
    // Not the dashboard's page list, which would bring every page with it.
    expect(held.has('ui/pages/lazy.tsx')).toBe(false);
    expect(held.has('ui/main.tsx')).toBe(false);
    // The parts its pages show are in its one script: a file has no server to load them from.
    const shown = dynamicImports(metafile).filter((d) => held.has(d.by));
    expect(shown.map((d) => nameOf(d.entry)).sort()).toEqual(PARTS);
    for (const d of shown) expect(held.has(d.entry), `${d.entry} is in the copy`).toBe(true);
    process.stdout.write(`an exported copy's script ${kb(whole.bytes)}\n`);
    expect(whole.bytes).toBeLessThan(COPY);
  }, 120_000);
});
