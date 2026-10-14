import type { RouteContext } from '../context.js';
import type { Router } from '../router.js';

/**
 * `POST /api/uploads`: the raw bytes of a file the browser sends for a job (the name in
 * `x-filename`, percent-encoded if it is not ASCII), at most 64 MB. Answers `{ uploadId, name,
 * bytes }`; the job's fields then name the `uploadId`, and its builder resolves it with
 * `ctx.upload(uploadId)`. Unused uploads are deleted after an hour.
 */
export function register(router: Router, ctx: RouteContext): void {
  router.post('/uploads', async (r) => r.json(await ctx.uploads.receive(r.req), 201));
}
