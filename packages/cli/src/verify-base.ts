import { execFileSync, spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { messageOf } from '@shadowlap/engine';
import { linkDependencies, mapArgv } from './bisect.js';
import { scratchDir } from './goldens.js';
import { physicalPath } from './real-path.js';

/**
 * Where `shadowlap verify` runs a good run's baseline: the same run under the code before the change,
 * attempt for attempt with the change's. The base is HEAD when the working tree has a change, or the
 * commit `--base` names when the change is committed. When the change is only request fields
 * (`--model`, `--set`) on a working tree with no change, the base is the working tree itself, without
 * them. A commit is checked out in a temporary git worktree, as `shadowlap bisect` checks one out: the
 * working tree's installed packages are linked in, this repository's own as they were at that commit,
 * unless `--build` installs them. A caller that verifies a change somewhere else than the working
 * tree brings its own checkout of the code without the change (`BaseCheckout.of`): `shadowlap repair`
 * verifies each candidate in a worktree of its own, and its baseline runs in another, made the same
 * way without the candidate.
 */

export interface BaseSpec {
  /** The commit the baseline runs at, in full; null for the working tree as it is. */
  revision: string | null;
  /** How reports name it: the commit's short form, or "the working tree". */
  label: string;
  /** A command run in the checkout before its first attempt, such as "npm run build". */
  build: string | null;
}

export type BaseResolution = { base: BaseSpec } | { none: string };

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }).toString();

function gitRoot(cwd: string): string | null {
  try {
    return physicalPath(git(cwd, ['rev-parse', '--show-toplevel']).trim());
  } catch {
    return null;
  }
}

/** The working tree's change against HEAD, as `codeVersion` counts one: a tracked file that differs. */
function hasChange(root: string): boolean {
  return git(root, ['status', '--porcelain', '--untracked-files=no']).trim().length > 0;
}

/**
 * The base a good run's baseline runs at, or why there is none. `base` is `--base` as given; `fields`
 * says the change sets request fields, which the baseline leaves out wherever it runs.
 */
export function resolveBase(cwd: string, o: { base?: string | null | undefined; fields: boolean; build?: string | null | undefined }): BaseResolution {
  const build = o.build ?? null;
  const root = gitRoot(cwd);
  const here: BaseSpec = { revision: null, label: 'the working tree', build: null };
  if (!root) {
    if (o.base) return { none: `--base ${o.base} names a commit, and ${cwd} is not in a git repository` };
    if (o.fields) return { base: here };
    return { none: 'the working directory is not in a git repository, so there is no code before the change to compare a good run with' };
  }
  let revision: string;
  if (o.base) {
    // A revision that starts with "-" would reach git as an option.
    if (o.base.startsWith('-')) return { none: `--base ${o.base} is not a commit in this repository` };
    try {
      revision = git(root, ['rev-parse', '--verify', '--quiet', `${o.base}^{commit}`]).trim();
    } catch {
      return { none: `--base ${o.base} is not a commit in this repository` };
    }
  } else {
    let head: string;
    try {
      head = git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).trim();
    } catch {
      return o.fields ? { base: here } : { none: 'the repository has no commit yet, so there is no code before the change to compare a good run with' };
    }
    if (!hasChange(root)) {
      if (o.fields) return { base: here };
      return { none: 'the working tree has no change against HEAD: name the commit before the change with --base <rev>, or compare with the golden\'s history (--baseline history)' };
    }
    revision = head;
  }
  // The commit as the working tree is, with nothing changed since: only request fields can differ.
  if (!o.base || revision !== git(root, ['rev-parse', 'HEAD']).trim() || hasChange(root)) {
    return { base: { revision, label: git(root, ['rev-parse', '--short', revision]).trim(), build } };
  }
  return o.fields ? { base: here } : { none: `--base ${o.base} is the code as it is now: nothing differs to compare a good run with` };
}

/** A base checked out for its attempts: where the agent runs there, and its command pointed into it. */
export class BaseCheckout {
  private constructor(
    /** Where the agent runs. */
    readonly cwd: string,
    private readonly map: (argv: readonly string[]) => string[],
    private readonly cleanup: () => void,
  ) {}

  /**
   * Checks the base out next to the project (`.shadowlap/verify/`), or uses the working tree for a
   * base that is the working tree. Throws, saying why, when the commit won't check out or build.
   */
  static open(spec: BaseSpec, cwd: string, projectDir: string): BaseCheckout {
    if (spec.revision === null) return new BaseCheckout(cwd, (argv) => [...argv], () => undefined);
    const here = physicalPath(cwd);
    const root = gitRoot(here);
    if (!root) throw new Error(`${cwd} is not in a git repository`);
    const inRepo = relative(root, here);
    if (inRepo === '..' || inRepo.startsWith(`..${sep}`) || isAbsolute(inRepo)) throw new Error(`the working directory ${cwd} is not inside the repository at ${root}`);
    const base = scratchDir(projectDir, 'verify');
    const worktree = join(base, spec.label);
    const remove = () => {
      try {
        git(root, ['worktree', 'remove', '--force', worktree]);
      } catch {
        rmSync(worktree, { recursive: true, force: true });
      }
      try {
        git(root, ['worktree', 'prune']);
      } catch {
        // pruned on the next worktree command
      }
      rmSync(base, { recursive: true, force: true });
    };
    try {
      git(root, ['worktree', 'add', '--detach', '--force', worktree, spec.revision]);
    } catch (err) {
      remove();
      throw new Error(`the base ${spec.label} could not be checked out: ${(err as { stderr?: Buffer }).stderr?.toString().trim() || messageOf(err)}`, { cause: err });
    }
    const worktreeCwd = join(worktree, inRepo);
    if (spec.build) {
      const b = spawnSync(spec.build, { cwd: worktreeCwd, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      if (b.status !== 0) {
        remove();
        throw new Error(`the base ${spec.label} could not be built: ${`${b.stdout ?? ''}${b.stderr ?? ''}`.trim().split('\n').slice(-3).join(' · ') || `${spec.build} exited ${b.status ?? b.signal!}`}`);
      }
    } else {
      // The working tree's packages serve the checkout, this repository's own as they were at the base.
      linkDependencies(root, root, worktree, worktree);
      if (inRepo) linkDependencies(root, here, worktreeCwd, worktree);
    }
    return new BaseCheckout(worktreeCwd, (argv) => mapArgv(argv, { root, worktree, cwd: here, worktreeCwd }), remove);
  }

  /**
   * A base the caller checked out: where the agent runs (`cwd`), how a run's command, as verify was
   * given it, is pointed there (`map`), and what removes it once verify is done (`cleanup`).
   */
  static of(cwd: string, map: (argv: readonly string[]) => string[], cleanup: () => void): BaseCheckout {
    return new BaseCheckout(cwd, map, cleanup);
  }

  /** The recorded command, pointed into the checkout. */
  argv(argv: readonly string[]): string[] {
    return this.map(argv);
  }

  close(): void {
    this.cleanup();
  }
}
