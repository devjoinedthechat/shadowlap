import { readFileSync } from 'node:fs';

/**
 * The dashboard's stylesheet as one text, as esbuild bundles it into assets/app.css: ui/app.css with
 * each @import replaced by the file it names (ui/css/<area>.css), in their order. The tests that read
 * the styles read this, so a rule is found in whichever file it sits, and "the last rule wins" reads
 * as the browser reads it.
 */

const APP = new URL('../ui/app.css', import.meta.url);
const IMPORT = /^@import\s+(?:url\(\s*)?['"]([^'"]+)['"]\s*\)?\s*;[ \t]*$/gm;

/** The files ui/app.css imports, in their order. */
export function sheetFiles(): URL[] {
  return [...readFileSync(APP, 'utf8').matchAll(IMPORT)].map((m) => new URL(m[1], APP));
}

/** A file's text, each of its imports replaced by that file's. */
function joined(file: URL): string {
  return readFileSync(file, 'utf8').replace(IMPORT, (_line, path: string) => joined(new URL(path, file)));
}

let whole: string | null = null;

/** The whole stylesheet, comments and all. */
export function sheet(): string {
  whole ??= joined(APP);
  return whole;
}
