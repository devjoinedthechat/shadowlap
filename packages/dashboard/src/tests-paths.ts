import type { GoldenSource } from './tests.js';

/**
 * The goldens on disk as a command line names them: never one whose path the CLI would read as an
 * option. Apart from tests.ts, so the jobs that run them (tests-run.ts) load them without it.
 */

/**
 * A golden whose path starts with `-` (a key under the config's `tests`) would reach the CLI as an
 * option, so no command is ever built with it: it is listed as one that can't be read.
 */
export const optionLike = (path: string): boolean => path.startsWith('-');

/**
 * What `shadowlap test` is given to run every golden: the goldens folder's pattern, which the CLI
 * expands itself without a shell, and each golden kept elsewhere (a pack the config's `tests` names)
 * by its path. A path that would read as an option is left out.
 */
export function testPatterns(goldens: readonly GoldenSource[], folder = 'goldens'): string[] {
  const inFolder = (path: string) => path.startsWith(`${folder}/`) && !path.slice(folder.length + 1).includes('/');
  const elsewhere = goldens.filter((g) => !inFolder(g.path) && !optionLike(g.path)).map((g) => g.path);
  return [...(goldens.some((g) => inFolder(g.path)) || !elsewhere.length ? [`${folder}/*`] : []), ...elsewhere];
}

/** The golden a request names, as listed on disk, or null; never a path the CLI would read as an option. */
export function knownGolden(goldens: readonly GoldenSource[], raw: unknown): string | null {
  const path = typeof raw === 'string' ? (goldens.find((g) => g.path === raw)?.path ?? null) : null;
  return path !== null && !optionLike(path) ? path : null;
}
