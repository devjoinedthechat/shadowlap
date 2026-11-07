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
 *   imports up front): at most 544 KB (421 KB when this was written; React DOM is half of it). It
 *   was one script of 803 KB with every page in it. The budget was 480 KB until port/runs took the
 *   first look to 479.79 KB; 544 KB is sized for the rest of the port.
 * - Each page the shell routes to is a chunk of its own that loads when the page first opens
 *   (ui/pages/lazy.tsx). What opening a page loads beyond the first look, its own code and the
 *   chunks only pages need: at most 200 KB each (the run page, the largest, 144 KB; Runs 70 KB; the
 *   Overview 38 KB). A page loads none of its parts as it opens (ui/components/OnShow.tsx), so that
 *   is all opening it loads: a run's views come once the pointer or the focus reaches the Views
 *   tabs, or the view first changes (test/ui-run-views.test.ts). With all five, a run's page has
 *   loaded 176 KB.
 * - A part of a page heavy enough to wait for a script of its own until it first shows (`onShow`),
 *   such as a run's views but Calls: what it adds to the first look and the page that shows it, at
 *   most 100 KB each (Provenance, the largest, 10 KB). The structural diff, the results matrix, the
 *   check builder and each Changes tab must be such parts (HEAVY).
 * - An exported copy is one script, since a file has no server to load a chunk from, built from an
 *   entry of its own (ui/main-copy.tsx) with only the pages a copy shows, its runs, a run's page and
 *   Compare between them, and the parts those pages show. At most 900 KB (606 KB; 868 KB when it
 *   held every page).
 */

const KB = 1024;
const FIRST_LOOK = 544 * KB;
const PAGE = 200 * KB;
const PART = 100 * KB;
const COPY = 900 * KB;

/** The pages the shell routes to, by their chunk's name: the list grows as pages land. */
const PAGES = ['Changes', 'Compare', 'Fixes', 'NewProject', 'Overview', 'Run', 'Runs', 'Settings', 'Setup', 'StoreSetup', 'Tests', 'Training'];
/** The parts of pages, and the shell's palette, shortcuts sheet and Remove project dialog, in scripts of their own, by their chunk's name: the list grows as parts land. */
const PARTS = ['ActionDialog', 'CheckDialog', 'ContextView', 'DatasetDialog', 'DiffPanel', 'DivergedDialogs', 'Drawer', 'EditDialog', 'ForksView', 'Palette', 'ProvenanceView', 'RemoveProject', 'RevisionPage', 'RunDialogs', 'ShareMenu', 'Shortcuts', 'TimelineView', 'TurnsView', 'Verdicts', 'jobs'];
/** The pages an exported copy shows (ui/pages/copy.tsx). */
const COPY_PAGES = ['Compare', 'Run', 'Runs'];
/** The parts the copy shows, in its one script: a run's views but Calls, and what its shell holds. */
const COPY_PARTS = ['ActionDialog', 'CheckDialog', 'ContextView', 'DatasetDialog', 'DiffPanel', 'DivergedDialogs', 'Drawer', 'EditDialog', 'ForksView', 'Palette', 'ProvenanceView', 'RemoveProject', 'RunDialogs', 'ShareMenu', 'Shortcuts', 'TimelineView', 'TurnsView', 'jobs'];

/**
 * The parts heavy enough that they must wait for a script of their own (`onShow`), by their modules:
 * the structural diff, the results matrix, the check builder (all of ui/checks/) and each Changes
 * tab with what it opens (all of ui/changes/ but the head every tab shares), Compare among them.
 * Each of them in the build is in neither the first look nor what any page but its own loads up
 * front, so opening a page never loads one.
 */
const HEAVY: ReadonlyArray<readonly [string, RegExp]> = [
  ['the structural diff', /^ui\/components\/JsonDiff\.tsx$/],
  ['the results matrix', /^ui\/components\/ResultsMatrix\.tsx$/],
  ['the check builder', /^ui\/checks\//],
  ['a Changes tab', /^ui\/changes\/(?!Head\.tsx$)/],
  ['a Changes tab', /^ui\/pages\/Compare\.tsx$/],
];

interface Bundles {
  served: esbuild.BuildOptions;
  copy: esbuild.BuildOptions;
}

const here = fileURLToPath(new URL('..', import.meta.url));
// The options build-ui.mjs builds with; a plain script, so it is loaded by its path.
const { uiBundles } = (await import(new URL('../ui-bundles.mjs', import.meta.url).href)) as { uiBundles: (o: { ui: string; out: string }) => Bundles };
const bundles = uiBundles({ ui: resolve(here, 'ui'), out: resolve(here, 'dist', 'budget') });
const build = (o: esbuild.BuildOptions) => esbuild.build({ ...o, write: false, metafile: true, absWorkingDir: here, logLevel: 'silent' });
/** Each build once, for both tests: the copy's is read against the pages the served one routes to. */
const once = <T>(f: () => T): (() => T) => {
  let made: { value: T } | null = null;
  return () => (made ??= { value: f() }).value;
};
const served = once(() => build(bundles.served));
const copy = once(() => build(bundles.copy));

/** A module's name as its chunk takes it: ui/pages/settings/StoreSetup.tsx is StoreSetup. */
const nameOf = (input: string) => /([^/]+)\.tsx?$/.exec(input)![1];
const kb = (bytes: number) => `${(bytes / KB).toFixed(0)} KB`;
const report = (added: Array<{ name: string; bytes: number }>) =>
  [...added]
    .sort((a, b) => b.bytes - a.bytes)
    .map((a) => `${a.name} ${kb(a.bytes)}`)
    .join(', ');
const names = (list: Array<{ name: string }>) => [...new Set(list.map((a) => a.name))].sort();

/** What each module loads with `import()`, by the module that asks: the parts of the served build that wait for a script of their own. */
function dynamicImports(meta: esbuild.Metafile): Array<{ entry: string; by: string }> {
  return Object.entries(meta.inputs).flatMap(([by, input]) => input.imports.filter((i) => i.kind === 'dynamic-import').map((i) => ({ entry: i.path, by })));
}

/** The pages the shell routes to, by their modules: what the shell's page list loads with `import()`. */
const pageEntries = (meta: esbuild.Metafile) => dynamicImports(meta).filter((d) => d.by === 'ui/pages/lazy.tsx');

describe('the dashboard’s scripts', () => {
  it('load the shell first, each page’s code when it opens and each part’s when it shows, within their budgets', async () => {
    const { metafile } = await served();
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
    const pages = pageEntries(metafile).map((d) => {
      const opened = loads(chunkOf(d.entry));
      return { name: nameOf(d.entry), entry: d.entry, upFront: inputsOf(opened), bytes: sum([...opened].filter((f) => !first.has(f))) };
    });
    // The parts: every other `import()`, with what it adds to what the module asking for it loaded.
    const parts = dynamicImports(metafile)
      .filter((d) => d.by !== 'ui/pages/lazy.tsx')
      .map((d) => {
        const page = loads(holding(d.by));
        return { name: nameOf(d.entry), entry: d.entry, shownWith: inputsOf(page), bytes: sum([...loads(chunkOf(d.entry))].filter((f) => !first.has(f) && !page.has(f))) };
      });
    process.stdout.write(`first look ${kb(firstBytes)} in ${first.size} files; opening each page adds: ${report(pages)}; each part adds: ${report(parts)}\n`);
    expect(firstBytes).toBeLessThan(FIRST_LOOK);
    for (const a of pages) expect(a.bytes, `${a.name} adds ${kb(a.bytes)}`).toBeLessThan(PAGE);
    for (const a of parts) expect(a.bytes, `${a.name} adds ${kb(a.bytes)}`).toBeLessThan(PART);
    // Every page the shell routes to is a chunk of its own, and so is every part, loaded neither in
    // the first look nor with the page that shows it.
    expect(names(pages)).toEqual(PAGES);
    expect(names(parts)).toEqual(PARTS);
    for (const p of parts) expect(firstInputs.has(p.entry) || p.shownWith.has(p.entry), `${p.name} waits for its own script`).toBe(false);
    // The heavy parts each wait for a script of their own, wherever they show: in neither the first
    // look nor what opening any other page loads. Compare is one of them already.
    const heavy = Object.keys(metafile.inputs).flatMap((input) => HEAVY.filter(([, re]) => re.test(input)).map(([what]) => ({ input, what })));
    expect(heavy.map((h) => h.input)).toContain('ui/pages/Compare.tsx');
    for (const { input, what } of heavy) {
      expect(firstInputs.has(input), `${what}, ${input}, is in the first look`).toBe(false);
      for (const p of pages) if (p.entry !== input) expect(p.upFront.has(input), `${what}, ${input}, loads with ${p.name}`).toBe(false);
    }
    // The run page's code is not in the first look.
    expect(firstInputs.has('ui/pages/Run.tsx')).toBe(false);
    expect(firstInputs.has('ui/run/Inspector.tsx')).toBe(false);
    // Nothing of an exported copy's own entry is served.
    const all = inputsOf(Object.keys(outs));
    expect(all.has('ui/main-copy.tsx')).toBe(false);
    expect(all.has('ui/pages/copy.tsx')).toBe(false);
  }, 120_000);

  it('give an exported copy one script with the pages it shows and the parts they show, none of the others, within its budget', async () => {
    const [{ metafile }, routed] = await Promise.all([copy(), served()]);
    const script = Object.entries(metafile.outputs).filter(([o]) => o.endsWith('.js'));
    expect(script).toHaveLength(1);
    const [, whole] = script[0];
    const held = new Set(Object.keys(whole.inputs));
    // Each page the dashboard's shell routes to, wherever its module is, is in the copy exactly when
    // the copy shows it.
    const pages = pageEntries(routed.metafile).map((d) => d.entry);
    expect(pages.map(nameOf).sort()).toEqual(PAGES);
    for (const page of COPY_PAGES) expect(PAGES).toContain(page);
    for (const page of pages) expect(held.has(page), `${page} is in the copy`).toBe(COPY_PAGES.includes(nameOf(page)));
    expect(held.has('ui/pages/copy.tsx')).toBe(true);
    // Not the dashboard's page list, which would bring every page with it.
    expect(held.has('ui/pages/lazy.tsx')).toBe(false);
    expect(held.has('ui/main.tsx')).toBe(false);
    // The parts its pages show are in its one script: a file has no server to load them from.
    const shown = dynamicImports(metafile).filter((d) => held.has(d.by));
    for (const part of COPY_PARTS) expect(PARTS).toContain(part);
    expect(names(shown.map((d) => ({ name: nameOf(d.entry) })))).toEqual(COPY_PARTS);
    for (const d of shown) expect(held.has(d.entry), `${d.entry} is in the copy`).toBe(true);
    process.stdout.write(`an exported copy's script ${kb(whole.bytes)}\n`);
    expect(whole.bytes).toBeLessThan(COPY);
  }, 120_000);
});
