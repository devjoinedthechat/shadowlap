import type { RouteContext } from '../context.js';
import { HttpError } from '../http.js';
import { overviewOptions, overviewSummary } from '../overview.js';
import type { Router } from '../router.js';
import { warmRunStats } from '../run-stats.js';
import type { GoldenSource } from '../tests.js';
import { teamStoreFor } from './store.js';

/**
 * `GET /api/summary?tz=`: the Overview, worked out on the server in the viewer's days (their IANA
 * time zone, UTC without one): this week against last, the last seven days, Today, this week's runs
 * as rows of calls, the outcomes, the prompt cache, the fixes funnel and Needs a look.
 */

/** The goldens on disk the dashboard was given, or none; a folder being edited reads as none for a moment. */
export function goldensOf(ctx: RouteContext): GoldenSource[] {
  try {
    return ctx.options.goldens?.() ?? [];
  } catch {
    return [];
  }
}

export function register(router: Router, ctx: RouteContext): void {
  // Each finished run's totals are worked out once in the store's life and kept: here, a slice of
  // about 50 ms at a time while the dashboard is otherwise idle, newest runs first, so the first
  // look at the Overview or the Runs page reads one row per run instead of every call.
  const warm = () => {
    try {
      if (!warmRunStats(ctx.store)) setTimeout(warm, 20).unref();
    } catch {
      // the store was closed: the dashboard stopped
    }
  };
  setTimeout(warm, 0).unref();

  router.get('/summary', (r) => {
    const o = overviewOptions(r.query);
    if ('error' in o) throw new HttpError(400, o.error);
    const store = teamStoreFor(ctx);
    // It names the time it was worked out at, so it is never the same twice: no ETag. Runs only
    // here are the store status's count, the one Settings → Store and the CLI give.
    r.json(overviewSummary(ctx.store, { ...o, ...ctx.read, goldens: goldensOf(ctx), teamStore: store ? { name: store.name, onlyLocal: store.onlyLocal } : null }));
  });
}
