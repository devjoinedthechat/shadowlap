import type { RouteContext } from '../context.js';
import { metaView } from '../meta.js';
import type { Router } from '../router.js';

/** `GET /api/meta`: what the shell needs once, and the status bar (counts, store size, address, live runs, read-only). */
export function register(router: Router, ctx: RouteContext): void {
  router.get('/meta', (r) =>
    r.json(
      metaView(ctx.store, {
        version: ctx.options.version ?? null,
        dbPath: ctx.options.dbPath ?? null,
        actions: ctx.jobs.available && !ctx.readOnly,
        readOnly: ctx.readOnly,
        readOnlyReason: ctx.readOnlyReason,
        address: ctx.address(),
        jobKinds: ctx.jobs.kindNames(),
        uploadLimit: ctx.project && !ctx.readOnly ? ctx.uploads.maxBytes : null,
        project: ctx.project,
      }),
    ),
  );
}
