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
/**
 * The parts of pages, and the shell's palette, shortcuts sheet and Remove project dialog, in scripts of their own, by their chunk's name: the list grows as parts land.
 * The dialogs a list row's step asks in load as the step first asks: a fix's lead's (LeadDialog, on Fixes and Needs a look), and Needs a look's Find breaking commit's and Update golden's.
 */
const PARTS = ['ActionDialog', 'AttemptPage', 'Builder', 'ChangeBox', 'CheckDialog', 'CheckMenu', 'ContextView', 'DatasetDialog', 'DecisionsView', 'DivergedDialogs', 'Drawer', 'EditDialog', 'Elsewhere', 'FailedIssues', 'ForkDifferences', 'ForkMenu', 'ForksView', 'InjectionFinding', 'InjectionResults', 'JsonDiff', 'LeadDialog', 'Migrate', 'MoreMenu', 'NewPreview', 'OtelDialog', 'Palette', 'Preview', 'Proof', 'ProvenanceView', 'RemoveCheck', 'RemoveProject', 'RequestDiff', 'ResultsMatrix', 'RevertDialog', 'RevisionPage', 'RunBlameAsks', 'RunDialogs', 'RunNotes', 'SecurityReportDialog', 'ShareMenu', 'Shortcuts', 'StepDialogs', 'TimelineView', 'TurnsView', 'UpdateGolden', 'Verdicts', 'jobs'];
/** The pages an exported copy shows (ui/pages/copy.tsx). */
const COPY_PAGES = ['Compare', 'Run', 'Runs'];
/** The parts the copy shows, in its one script: a run's views but Calls, the words of a run's notes, what a fork did differently, and the shell's shortcuts sheet. Not those only the served dashboard draws, which it hands in (ui/served-parts.ts): Share's menu, and the Export dataset…, Export OpenTelemetry trace… and Security report it opens; the fork menu and the header's …; Run blame's dialogs with the check a blame asks for (CheckDialog), and the check menu at a tool call with the check builder its pick opens; Runs › Failed as issues; Revert's dialog and the change box; the dialogs a run's steps ask in; an injection test's results, and the matrix they draw; a kept test's finding, which offers them; what only an injection attempt's page draws, its proof and its marks; the palette, the job's drawer with the words of a job's kind, and Remove project's dialog; the dialog a run's action asks in, Find breaking commit's, a diverged test's and Edit and fork's; and the In page (test/ui-exported-copy.test.ts pins what keeps each undrawn in a copy). */
const COPY_PARTS = ['ContextView', 'DecisionsView', 'ForkDifferences', 'ForksView', 'JsonDiff', 'ProvenanceView', 'RequestDiff', 'RunNotes', 'Shortcuts', 'TimelineView', 'TurnsView'];

/**
 * The parts heavy enough that they must wait for a script of their own (`onShow`), by their modules:
 * the structural diff, the results matrix, the check builder (all of ui/checks/) and each Changes
 * tab with what it opens (all of ui/changes/ but the head every tab shares), Compare among them.
 * Each of them in the build is in neither the first look nor what any page but its own loads up
 * front, so opening a page never loads one. The structural diff's walk (ui/json-diff.ts) is the one
 * a page may hold up front, the one its third field names: Compare, a heavy page itself, whose rows
 * mark the words two calls differ by and whose changed request it walks.
 */
const HEAVY: ReadonlyArray<readonly [string, RegExp, string?]> = [
  ['the structural diff', /^ui\/components\/JsonDiff\.tsx$/],
  ['the structural diff’s walk', /^ui\/json-diff\.ts$/, 'ui/pages/Compare.tsx'],
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
    // The page list declares no part, and shows none itself: the In page, which a link into a project
    // that can't be opened shows in the setup's place, is handed in by the served entry, since a copy
    // never asks another project (OnShow.tsx), so neither the page list nor a copy's pages load it.
    const listed = new Set(metafile.inputs['ui/pages/lazy.tsx'].imports.filter((i) => i.kind === 'import-statement').map((i) => i.path));
    const listShows = dynamicImports(metafile).filter((d) => listed.has(d.by) && d.by.startsWith('ui/pages/'));
    expect(listShows.map((d) => [d.by, d.entry])).toEqual([]);
    expect(dynamicImports(metafile).filter((d) => d.entry === 'ui/pages/Elsewhere.tsx').map((d) => d.by)).toEqual(['ui/pages/served.tsx']);
    // The heavy parts each wait for a script of their own, wherever they show: in neither the first
    // look nor what opening any other page loads. Compare is one of them already, and the walk loads
    // with it.
    const heavy = Object.keys(metafile.inputs).flatMap((input) => HEAVY.filter(([, re]) => re.test(input)).map(([what, , page]) => ({ input, what, page })));
    expect(heavy.map((h) => h.input)).toEqual(expect.arrayContaining(['ui/pages/Compare.tsx', 'ui/json-diff.ts']));
    expect(pages.find((p) => p.name === 'Compare')?.upFront.has('ui/json-diff.ts')).toBe(true);
    for (const { input, what, page } of heavy) {
      expect(firstInputs.has(input), `${what}, ${input}, is in the first look`).toBe(false);
      for (const p of pages) if (p.entry !== input && p.entry !== page) expect(p.upFront.has(input), `${what}, ${input}, loads with ${p.name}`).toBe(false);
    }
    // The run page's code is not in the first look.
    expect(firstInputs.has('ui/pages/Run.tsx')).toBe(false);
    expect(firstInputs.has('ui/run/Inspector.tsx')).toBe(false);
    // Share's words (ui/run/share.ts) load with its menu, a part only the served dashboard hands in,
    // never with the run page, whose header, steps and keys read what they say of a copy from
    // ui/run/share-steps.ts.
    const runPage = pages.find((p) => p.name === 'Run')!;
    expect(runPage.upFront.has('ui/run/share-steps.ts')).toBe(true);
    expect(firstInputs.has('ui/run/share.ts') || runPage.upFront.has('ui/run/share.ts')).toBe(false);
    expect(inputsOf(loads(chunkOf('ui/run/ShareMenu.tsx'))).has('ui/run/share.ts')).toBe(true);
    // Find breaking commit's dialog words and Update golden's plan (ui/run/dialog-copy.ts, with the
    // find-commit.ts and update-words.ts they read) load with the parts that show them: its dialog,
    // the fork menu's card and Update golden's dialog. The run page keeps what decides its buttons
    // (ui/run/offers.ts).
    expect(runPage.upFront.has('ui/run/offers.ts')).toBe(true);
    for (const words of ['ui/run/dialog-copy.ts', 'ui/runspage/find-commit.ts', 'ui/update-words.ts']) expect(runPage.upFront.has(words), `${words} loads with the run page`).toBe(false);
    for (const part of ['ui/run/RunDialogs.tsx', 'ui/run/ForkMenu.tsx', 'ui/run/DivergedDialogs.tsx']) expect(inputsOf(loads(chunkOf(part))).has('ui/run/dialog-copy.ts'), `${part} loads its words`).toBe(true);
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
    // Nor what only the served dashboard draws, which it hands in (ui/served-parts.ts): a copy draws
    // no Share, no Fork at #n, no …, no Run blame, no Add check… and no New preview, and its actions
    // wait, so no step asks in a dialog there; and it keeps Failed a filter, so draws no issues.
    expect(held.has('ui/pages/served.tsx')).toBe(false);
    expect(held.has('ui/run/ShareMenu.tsx')).toBe(false);
    expect(held.has('ui/run/ForkMenu.tsx')).toBe(false);
    expect(held.has('ui/run/MoreMenu.tsx')).toBe(false);
    expect(held.has('ui/fixes/RunBlameAsks.tsx')).toBe(false);
    expect(held.has('ui/checks/Builder.tsx')).toBe(false);
    expect(held.has('ui/run/CheckMenu.tsx')).toBe(false);
    expect(held.has('ui/run/StepDialogs.tsx')).toBe(false);
    expect(held.has('ui/injection/SecurityReportDialog.tsx')).toBe(false);
    expect(held.has('ui/runspage/FailedIssues.tsx')).toBe(false);
    expect(held.has('ui/runspage/IssuesTable.tsx')).toBe(false);
    // Nor New preview's dialogs: its menu waits in a copy, as every server action does.
    expect(held.has('ui/changes/NewPreview.tsx')).toBe(false);
    // Nor the shell's parts a copy never draws, a run's page's dialogs a copy never opens, and the In page.
    for (const part of ['ui/shell/Palette.tsx', 'ui/components/Drawer.tsx', 'ui/jobs.ts', 'ui/shell/RemoveProject.tsx', 'ui/run/ActionDialog.tsx', 'ui/run/RunDialogs.tsx', 'ui/run/DivergedDialogs.tsx', 'ui/run/EditDialog.tsx', 'ui/pages/Elsewhere.tsx']) expect(held.has(part), `${part} is in the copy`).toBe(false);
    // The parts its pages show are in its one script: a file has no server to load them from.
    const shown = dynamicImports(metafile).filter((d) => held.has(d.by));
    for (const part of COPY_PARTS) expect(PARTS).toContain(part);
    expect(names(shown.map((d) => ({ name: nameOf(d.entry) })))).toEqual(COPY_PARTS);
    for (const d of shown) expect(held.has(d.entry), `${d.entry} is in the copy`).toBe(true);
    process.stdout.write(`an exported copy's script ${kb(whole.bytes)}\n`);
    expect(whole.bytes).toBeLessThan(COPY);
  }, 120_000);
});
