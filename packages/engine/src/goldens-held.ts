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
 * What a project's goldens folder (`dir`) holds, by name, which the goldens a fix's apply copies
 * can't be named (`goldenNamesProblem` reads them without case): every entry, but one whose folder
 * holds already the very recording one of `offered` would put there under that name. That is the
 * copy an apply stopped before it marked the fix applied made, which the next apply finds there
 * rather than taken. `offered` gives each name with the folder of the recording it would hold.
 */
export function goldensHeld(dir: string, offered: ReadonlyArray<{ name: string; source: string }>): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.filter((e) => !offered.some((c) => c.name === e.toLowerCase() && sameBytes(join(dir, e, 'run.json'), join(c.source, 'run.json'))));
}
