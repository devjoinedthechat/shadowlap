import { existsSync } from 'node:fs';
import type { ProjectEntry, ProjectHost } from '@shadowlap/engine';
import type { ProjectConfig, RouteContext } from '../context.js';
import { HELD_WHATS, type Held, type HeldWhat, type HoldingView, type OtherStore } from '../cross-project.js';
import { HttpError } from '../http.js';
import { answerData } from '../read-pool.js';
import { readingStores } from '../reading-stores.js';
import type { Router } from '../router.js';
import { ONE_STORE } from './projects.js';

/**
 * A link into another project:
 *
 *   GET /api/projects/holding?what=&id=[&id=]   which other project's store holds a run, a fix, a preview or a migration this one doesn't
 *
 * A page that can't find what its address names asks this before it says so (ui/pages/Elsewhere.tsx):
 * `what` is `run`, `fix`, `preview` or `migration`, and `id` the id, twice for Compare's pair. The
 * answer names the project the dashboard serves now (`current`), and the first other project in the
 * list's order whose store holds one of them (`held`), or null. Only the projects on the list are
 * looked in, each whose folder and store are on disk: a removed project's store never is. The read
 * opens their stores read-only, beside the server (cross-project.ts `held-by`), and a removal waits
 * for it (reading-stores.ts). The browser sends only the kind and the ids, never a path, and the
 * answer holds only a project's id and name, as the switcher lists them.
 *
 * A dashboard that serves one store (`--read-only`, the terminal UI's) has no other project: 404,
 * as the projects routes answer there.
 */

/** An id as a page's address holds one: at most 80 of these characters, as its routes take a part of it. */
const ID = /^[\w.~:@-]{1,80}$/;

/** The kind asked for, checked. */
function whatOf(raw: string | null): HeldWhat {
  const what = HELD_WHATS.find((w) => w === raw);
  if (!what) throw new HttpError(400, 'what is run, fix, preview or migration');
  return what;
}

/** The ids asked for, checked: one, or two for a pair. */
function idsOf(raw: string[]): string[] {
  if (raw.length < 1 || raw.length > 2 || !raw.every((id) => ID.test(id))) throw new HttpError(400, 'id is the id of a run, a fix, a preview or a migration, once, or twice for a pair of runs');
  return raw;
}

/** The other projects on the list whose folder and store are on disk, in the list's order. */
function otherStores(h: ProjectHost<ProjectConfig>, list: readonly ProjectEntry[], current: string): OtherStore[] {
  const stores: OtherStore[] = [];
  for (const p of list) {
    if (p.id === current || !existsSync(p.path)) continue;
    try {
      const { dbPath } = h.context(p.id);
      if (existsSync(dbPath)) stores.push({ id: p.id, name: p.name, dbPath });
    } catch {
      // Removed since the list was read: not looked in.
    }
  }
  return stores;
}

export function register(router: Router, ctx: RouteContext): void {
  router.get('/projects/holding', async (r) => {
    const h = ctx.options.projects;
    if (!h) throw new HttpError(404, ONE_STORE);
    const what = whatOf(r.query.get('what'));
    const ids = idsOf(r.query.getAll('id'));
    const here = ctx.project;
    const current = { id: here?.id ?? h.currentProject(), name: here?.name ?? h.currentProject() };
    const stores = otherStores(h, h.list(), current.id);
    const held = stores.length ? answerData<Held>(await readingStores(h, stores.map((s) => s.dbPath), () => ctx.reads.run({ kind: 'held-by', what, ids, stores }))).held : null;
    r.json({ current, held } satisfies HoldingView);
  });
}
