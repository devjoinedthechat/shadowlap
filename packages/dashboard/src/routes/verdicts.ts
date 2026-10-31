import type { Normalizer } from '@shadowlap/engine';
import { commitSubjects } from '../commits-here.js';
import type { RouteContext } from '../context.js';
import { HttpError } from '../http.js';
import type { Router } from '../router.js';
import type { GoldenSource } from '../tests.js';
import { subjectRevisions, VERDICTS_KINDS, verdictRevision, verdictsView, withSubjects, type VerdictRevision, type VerdictsKind, type VerdictsView } from '../verdicts.js';
import { teamStoreFor } from './store.js';

/**
 * Changes › Verdicts: every change checked before it shipped, and the verdict it got.
 *
 *   GET /api/verdicts[?kind=all|sessions|previews|verifies&limit=]   the changes, newest first, each chip's count, and the newest revision's verdict
 *   GET /api/verdicts/:rev                                           a revision's page (`no-revision` for none): its goldens as that session judged them, and the previews asked at it
 *
 * Who checked a change is named only with a team store, where checks are shared, as the Runs page's
 * By column is. A commit's subject comes from the project's git, asked beside the server.
 */

/** The folder the project keeps its goldens in. */
const FOLDER = 'goldens';

/** A view with each revision's commit subject, from the project's git; as it is without a project folder or when git can't say. */
async function subjectsHere<T extends VerdictsView | VerdictRevision>(view: T, root: string | null | undefined): Promise<T> {
  const revs = subjectRevisions(view);
  if (!root || !revs.length) return view;
  return withSubjects(view, await commitSubjects(root, revs));
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
  const shared = () => teamStoreFor(ctx) !== null;

  router.get('/verdicts', async (r) => {
    const kind = r.query.get('kind') ?? 'all';
    if (!(VERDICTS_KINDS as readonly string[]).includes(kind)) throw new HttpError(400, `kind is ${VERDICTS_KINDS.join(', ')}`);
    const limit = Math.max(1, Math.min(200, Number(r.query.get('limit') ?? 50) || 50));
    r.tagged(await subjectsHere(verdictsView(ctx.store, goldens(), { kind: kind as VerdictsKind, limit, shared: shared(), folder: FOLDER }), ctx.project?.path));
  });

  router.get('/verdicts/:rev', async (r) => {
    const page = verdictRevision(ctx.store, goldens(), r.params.rev!, { shared: shared(), folder: FOLDER, normalizers: normalizers() });
    if (!page) throw new HttpError(404, `no change ${r.params.rev!.slice(0, 100)} checked: no test session ran every golden at it`);
    r.tagged(await subjectsHere(page, ctx.project?.path));
  });
}
