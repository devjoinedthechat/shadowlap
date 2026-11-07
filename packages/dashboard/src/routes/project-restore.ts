import type { RouteContext } from '../context.js';
import { HttpError } from '../http.js';
import type { Router } from '../router.js';
import { ONE_STORE } from './projects.js';

/**
 * The Undo of removing a project, from the toast that says it was removed:
 *
 *   POST /api/projects/:id/restore    puts it back on the dashboard, at the place it left
 *
 * It comes back as adding its folder again brings it back (engine `ProjectRegistry.restore`): its
 * setup and confirmed commands as they were, its runs from the folder they never left, and the store
 * `--db` named for it read again. The current project stays current, so the page stays where the
 * removal left it. A project removed with its recordings, or one back already, is refused (404),
 * and so is one whose folder is gone (400): the remove's answer says when its toast can offer the
 * Undo (`undo`). Its own module: the projects module's `register` is at its size.
 */
export function register(router: Router, ctx: RouteContext): void {
  const projects = ctx.options.projects ?? null;
  router.post(
    '/projects/:id/restore',
    (r) => {
      if (!projects) throw new HttpError(404, ONE_STORE);
      const back = projects.restore(r.params.id!);
      r.json({ project: { id: back.project.id, name: back.project.name }, current: back.current, message: `${back.project.name} is back on the dashboard` });
    },
    { anyProject: true },
  );
}
