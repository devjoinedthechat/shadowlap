import { basename, posix, resolve } from 'node:path';
import { applyGoldens, defaultGoldenNames, fixLabelInfo, goldenNamesProblem, goldensFolder, type StoreOf, type StoredFix, type StoredRepair } from '@shadowlap/engine';

/**
 * Where `fix apply` copies the recordings of the fixed runs: each into the goldens folder as a golden
 * of its own, under the name `--name <run>=<name>` gives it, else the one the fix's label makes
 * (`defaultGoldenNames`: `refund-bug`, or `refund-bug-1` and `refund-bug-2` for two). A copy made
 * before stays where it is, under the name it has: one apply made, one `repair --goldens` made under
 * the run's name, and one an apply stopped part way left. Every name is checked before anything
 * changes, by the rule the dashboard's Apply fix checks its fields by (`goldenNamesProblem`): one
 * that won't do is said, and nothing is applied.
 */

/** A name as `--name <run>=<name>` gives it: the run as typed (its id, or the start of it), and the golden's name. */
export interface GivenName {
  run: string;
  name: string;
}

/** `--name <run>=<name>` as typed, or null for one that doesn't read so. */
export function parseNameFlag(value: string): GivenName | null {
  const at = value.indexOf('=');
  const run = at > 0 ? value.slice(0, at).trim() : '';
  return run ? { run, name: value.slice(at + 1).trim() } : null;
}

/** Where a recording of a fixed run goes: `source` its folder in the repair's goldens/, `to` the golden it becomes, both from the folder apply runs in. */
export interface GoldenCopy {
  /** The run it is a recording of, by the short id the repair's goldens/ names it with. */
  run: string;
  source: string;
  to: string;
}

/** Which of the recordings `--name`'s run names, or why none: its run is none of theirs, or the start of more than one. */
function namedOne(all: ReadonlyArray<{ run: string }>, given: GivenName): number | string {
  const at = all.flatMap((x, i) => (x.run.startsWith(given.run) || given.run.startsWith(x.run) ? [i] : []));
  const runs = all.map((x) => x.run).join(', ');
  if (!at.length) return `${given.run} is not a run apply copies the recording of: ${all.length === 1 ? 'it copies the recording of' : 'it copies those of'} ${runs}`;
  return at.length > 1 ? `${given.run} is the start of more than one run apply copies the recording of (${runs}): give more of its id` : at[0]!;
}

/**
 * Where each recording of the fixed runs goes (in the repair's order), or why a name given won't
 * do, nothing changed yet. One copied before keeps where it went, and a --name for it names only
 * that: one the store says apply copied, and one in the goldens folder already (`goldensFolder`),
 * under its run's name as `repair --goldens` copies them, or the very recording under any name, as
 * an apply stopped part way left it. `sources` are the repair's goldens as apply checked them; a
 * repair a pull brought copies none here, so a name given for one names nothing.
 */
export function planCopies(store: StoreOf<'recording' | 'fixes'>, fix: StoredFix, repair: StoredRepair, o: { cwd: string; goldens: string; given: readonly GivenName[]; pulled: boolean; sources: readonly string[] }): { copies: GoldenCopy[] } | { problem: string } {
  const all = applyGoldens(fix, repair, { pulled: o.pulled }).map((g, i) => ({ ...g, source: o.sources[i] ?? g.source }));
  if (!all.length) {
    if (!o.given.length) return { copies: [] };
    return { problem: o.pulled ? `the recordings ${repair.repairId} made stay on the machine that ran it, which came with a pull: --name names none here` : `${repair.repairId} made no recordings for apply to copy: --name names none` };
  }
  const named = new Map<number, string>();
  for (const given of o.given) {
    const at = namedOne(all, given);
    if (typeof at === 'string') return { problem: `--name ${given.run}=${given.name}: ${at}` };
    if (named.has(at)) return { problem: `the recording of ${all[at]!.run} is named twice: give it one --name` };
    named.set(at, given.name);
  }
  // A golden is named with `/` between its parts on every system, as the store keeps it and the messages say it.
  const shown = o.goldens.replace(/\\/g, '/').replace(/(.)\/+$/, '$1') || '.';
  const made = defaultGoldenNames({ label: fixLabelInfo(store, fix).label, title: fix.title }, all.length);
  const nameOf = (i: number) => named.get(i) ?? made[i]!;
  const folder = goldensFolder(
    resolve(o.cwd, o.goldens),
    all.flatMap((g) => (g.copied ? [] : [{ run: g.run, source: resolve(o.cwd, g.source) }])),
  );
  const known = all.map((g) => {
    const at = folder.there.find((t) => t.run === g.run)?.at;
    return g.copied ?? (at ? posix.join(shown, at) : null);
  });
  for (const [i, name] of named) {
    const at = known[i];
    // The same --name again, after an apply stopped part way, names where it went.
    if (at && basename(at).toLowerCase() !== name) return { problem: `the recording of ${all[i]!.run} was copied before, to ${at}, and keeps that name: --name names one apply copies now` };
  }
  const fresh = all.flatMap((g, i) => (known[i] ? [] : [{ run: g.run, name: nameOf(i) }]));
  const problem = goldenNamesProblem(
    fresh.map((c) => c.name),
    { folder: shown, held: folder.held },
  );
  if (problem) {
    const c = fresh[problem.at]!;
    return { problem: `${problem.text} Nothing was changed: name the recording of ${c.run} with --name ${c.run}=<name>` };
  }
  return { copies: all.map((g, i) => ({ run: g.run, source: g.source, to: known[i] ?? posix.join(shown, nameOf(i)) })) };
}
