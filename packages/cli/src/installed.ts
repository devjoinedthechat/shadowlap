import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** This CLI's package folder, the one that holds `bin/` and `dist/`. */
const CLI_PACKAGE = fileURLToPath(new URL('..', import.meta.url));

/**
 * Whether this CLI came from `npm install -g`. npm puts a global package in a node_modules folder
 * with no package.json beside it (`<prefix>/lib/node_modules`, or `<prefix>\node_modules` on
 * Windows), where a project's node_modules sits next to the project's own package.json. A clone's
 * `packages/cli`, a project's copy and pnpm's store (whose folders have no package.json either) are
 * not global. What it decides is only how a hint names an install: `-g`, and no `npx`.
 */
export function installedGlobally(dir: string = CLI_PACKAGE): boolean {
  const folder = dir.replace(/[\\/]+$/, '');
  const parent = dirname(folder);
  if (basename(parent) !== 'node_modules' || folder.split(/[\\/]/).includes('.pnpm')) return false;
  return !existsSync(join(dirname(parent), 'package.json'));
}
