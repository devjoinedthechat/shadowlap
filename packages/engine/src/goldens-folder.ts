import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** A file's bytes, or null where there are none to read. */
const bytesOf = (file: string): Buffer | null => {
  try {
    return readFileSync(file);
  } catch {
    return null;
  }
};

/** A file's size, or -1 where there is none. */
const sizeOf = (file: string): number => {
  try {
    return statSync(file).size;
  } catch {
    return -1;
  }
};

/** Where a recording sits in the goldens folder already: `run`, the run it is a recording of, `at` the entry that holds it. */
export interface GoldenThere {
  run: string;
  at: string;
}

/**
 * What a project's goldens folder (`dir`) holds, for the recordings a fix's apply copies there
 * (`offered`: each by its run, with the folder it comes from, or none where that folder is not to be
 * read):
 *
 * - `there`, each whose recording is in it already, and the entry that holds it: one named by the run,
 *   as `repair --goldens` copies them (and `fix apply` did before a golden had a name of its own),
 *   else one whose run.json is the recording's own, byte for byte, under any name: the copy an apply
 *   stopped before it marked the fix applied left. Each keeps where it is and takes no other name;
 * - `held`, every entry by its name, which none of the rest may take (`goldenNamesProblem` reads them
 *   without case).
 */
export function goldensFolder(dir: string, offered: ReadonlyArray<{ run: string; source: string }>): { there: GoldenThere[]; held: string[] } {
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return { there: [], held: [] };
  }
  const byName = new Map(entries.map((e) => [e.toLowerCase(), e]));
  const there = offered.flatMap((c) => {
    const at = byName.get(c.run.toLowerCase()) ?? copyIn(dir, entries, c.source);
    return at ? [{ run: c.run, at }] : [];
  });
  return { there, held: entries };
}

/** The entry of the goldens folder whose run.json is the one in `source`, byte for byte (each entry's size read first), if any. */
function copyIn(dir: string, entries: readonly string[], source: string): string | null {
  const bytes = source ? bytesOf(join(source, 'run.json')) : null;
  if (!bytes) return null;
  return entries.find((e) => sizeOf(join(dir, e, 'run.json')) === bytes.length && !!bytesOf(join(dir, e, 'run.json'))?.equals(bytes)) ?? null;
}
