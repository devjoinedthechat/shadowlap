import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const sameBytes = (a: string, b: string): boolean => {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
};

/**
 * What a project's goldens folder (`dir`) holds, for the recordings a fix's apply copies there
 * (`offered`: each by its run, with the name it would take and the folder it comes from, or none
 * where that folder is not to be read):
 *
 * - `there`, the runs whose recording is in it already under the run's own name, as
 *   `repair --goldens` copies them (and `fix apply` did before a golden had a name of its own),
 *   which keep it and take no other;
 * - `held`, every other entry by its name, which none may be given (`goldenNamesProblem` reads them
 *   without case), but one whose folder holds already the very recording given that name: the copy
 *   an apply stopped before it marked the fix applied made, which the next apply finds there.
 */
export function goldensFolder(dir: string, offered: ReadonlyArray<{ run: string; name: string; source: string }>): { there: string[]; held: string[] } {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { there: [], held: [] };
  }
  const named = new Set(entries.map((e) => e.toLowerCase()));
  const there = offered.filter((c) => named.has(c.run.toLowerCase())).map((c) => c.run);
  const own = (e: string) => offered.some((c) => !there.includes(c.run) && c.name === e.toLowerCase() && !!c.source && sameBytes(join(dir, e, 'run.json'), join(c.source, 'run.json')));
  return { there, held: entries.filter((e) => !own(e)) };
}
