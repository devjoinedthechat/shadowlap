import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Normalizer } from '@shadowlap/engine';
import { parseStoreUrl } from '@shadowlap/remote';
import { commitAuthors, commitSubjects } from '../commits-here.js';
import type { RouteContext } from '../context.js';
import { HttpError } from '../http.js';
import type { Router } from '../router.js';
import type { GoldenSource } from '../tests.js';
import { commitsWanted, VERDICTS_KINDS, verdictRevision, verdictsLimit, verdictsView, withCommits, type VerdictRevision, type VerdictsKind, type VerdictsView } from '../verdicts.js';

/**
 * Changes › Verdicts: every change checked before it shipped, and the verdict it got.
 *
 *   GET /api/verdicts[?kind=all|sessions|previews|verifies&limit=]   the changes, newest first, each chip's count, and the newest revision's verdict
 *   GET /api/verdicts/:rev                                           a revision's page (`no-revision` for none): its goldens as that session judged them, and the previews asked at it
 *
 * Who made a change is named only with a team store, where checks are shared, as the Runs page's By
 * column is. A commit's subject and author come from the project's git, asked beside the server.
 */

/** The folder the project keeps its goldens in. */
const FOLDER = 'goldens';

/**
 * Whether the project's config names a team store, as the store's status reads it (a store URL its
 * parser takes): checks are shared there, so who made each change is named. Only that key is read,
 * on each request: no credentials, no counts of runs.
 */
export function namesTeamStore(projectPath: string | null | undefined): boolean {
  if (!projectPath) return false;
  try {
    const config = JSON.parse(readFileSync(join(projectPath, 'shadowlap.config.json'), 'utf8')) as { store?: unknown };
    if (typeof config.store !== 'string') return false;
    parseStoreUrl(config.store);
    return true;
  } catch {
    // No config, one that can't be read, or a store that isn't a store URL: nothing is shared.
    return false;
  }
}

/** A view with what the project's git says of each revision's commit: its subject, and its author where names are shown. As it is without a project folder, or when git can't say. */
async function commitsHere<T extends VerdictsView | VerdictRevision>(view: T, root: string | null | undefined): Promise<T> {
  const revs = commitsWanted(view);
  if (!root || !revs.length) return view;
  const subjects = await commitSubjects(root, revs);
  return withCommits(view, subjects, view.shared ? await commitAuthors(root, revs) : new Map());
}

export function register(router: Router, ctx: RouteContext): void {
  const goldens = (): GoldenSource[] => ctx.options.goldens?.() ?? [];
  // A config that can't be read leaves the notes' normalizers out rather than the page.
  const normalizers = (): Normalizer[] => {
    try {
      return ctx.config().normalize;
    } catch {
      return [];
    }
  };
  const shared = () => namesTeamStore(ctx.project?.path);

  router.get('/verdicts', async (r) => {
    const kind = r.query.get('kind') ?? 'all';
    if (!(VERDICTS_KINDS as readonly string[]).includes(kind)) throw new HttpError(400, `kind is ${VERDICTS_KINDS.join(', ')}`);
    const view = verdictsView(ctx.store, goldens(), { kind: kind as VerdictsKind, limit: verdictsLimit(r.query.get('limit')), shared: shared(), folder: FOLDER });
    r.tagged(await commitsHere(view, ctx.project?.path));
  });

  router.get('/verdicts/:rev', async (r) => {
    const page = verdictRevision(ctx.store, goldens(), r.params.rev!, { shared: shared(), folder: FOLDER, normalizers: normalizers() });
    if (!page) throw new HttpError(404, `no change ${r.params.rev!.slice(0, 100)} checked: no test session ran every golden at it`);
    r.tagged(await commitsHere(page, ctx.project?.path));
  });
}
