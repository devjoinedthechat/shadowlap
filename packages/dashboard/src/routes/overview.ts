import type { RouteContext } from '../context.js';
import { HttpError } from '../http.js';
import { goldensOf, nextStepWork } from '../outcome-work.js';
import { overviewOptions } from '../overview.js';
import { sendAnswer } from '../read-pool.js';
import type { Router } from '../router.js';
import { readTeamStoreInput } from '../team-store.js';
import { configuredRepairer } from './fixes.js';
import { verifyRule } from './estimates.js';

/**
 * `GET /api/summary?tz=`: the Overview, worked out in the viewer's days (their IANA time zone, UTC
 * without one): this week against last, the last seven days, Today, this week's runs as rows of
 * calls, the outcomes, the prompt cache, the fixes funnel and Needs a look. It is worked out beside
 * the server (read-pool.ts). Each finished run's totals are worked out once in the store's life and
 * kept, ahead of time, newest first; until those of the two weeks it adds up are, it answers at once
 * with how far that has got, `{ warming: { done, total } }`, and the page asks again.
 */

export function register(router: Router, ctx: RouteContext): void {
  router.get('/summary', async (r) => {
    const o = overviewOptions(r.query);
    if ('error' in o) throw new HttpError(400, o.error);
    const project = ctx.project?.path ?? null;
    // The team store as the project's config names it: runs only here are the store status's count,
    // the one Settings → Store and the CLI give, and a setup left unfinished leads back to its page.
    const team = project ? readTeamStoreInput({ cwd: project }) : null;
    const a = await ctx.reads.run({ kind: 'summary', work: { ...o, ...ctx.read, goldens: goldensOf(ctx), team: team?.store ? team : null, project, next: nextStepWork(ctx), repairer: configuredRepairer(ctx), keptMax: verifyRule(ctx).keptMax } });
    if (a.warming) ctx.reads.warm();
    sendAnswer(r, a);
  });
}
