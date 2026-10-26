// A project folder for a test, outside the repository, that finds packages as one inside it would.
// A test that runs an agent, or a test runner, in a project of its own needs the agent's imports
// (@shadowlap/sdk, @anthropic-ai/sdk, vitest) to resolve, which is why such projects used to be made
// in the repository, next to the test: Node finds a package in the node_modules of every folder above
// a module. Made there, a project a run left behind (a test stopped halfway, a killed run) stays in
// the checkout. Here it is a folder in the system's temporary folder, with links named node_modules
// in the folders above it: the repository's own by default, or the ones given, nearest first, as
// testing/frameworks' and then the repository's. The project's own folder holds nothing else, so a
// git repository made in it holds no link.
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository's own node_modules. */
export const REPO_MODULES = fileURLToPath(new URL('../node_modules', import.meta.url));

/** Each project made here, with the temporary folder it is in. */
const bases = new Map();

/**
 * A new, empty project folder under the system's temporary folder, below links to `modules` (nearest
 * first; one that isn't there is left out). Its path is a real one, as a command run in it sees it.
 * `removeTempProject` removes it with the folders and links above it.
 */
export function tempProject(prefix, modules = [REPO_MODULES]) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  let dir = base;
  for (const target of [...modules].reverse()) {
    // A junction on Windows, which needs no privilege; elsewhere the type is ignored.
    if (existsSync(target)) symlinkSync(target, join(dir, 'node_modules'), 'junction');
    dir = join(dir, 'project');
    mkdirSync(dir);
  }
  bases.set(dir, base);
  return dir;
}

/** Removes a project `tempProject` made, with the links above it (never what they link to). */
export function removeTempProject(project) {
  const base = bases.get(project) ?? project;
  bases.delete(project);
  rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
