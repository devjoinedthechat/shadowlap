import { listingInput, listModelChoices, type ModelListing, type Price, type Task } from '@shadowlap/engine';
import type { RouteContext } from '../context.js';
import { HttpError } from '../http.js';
import type { Router } from '../router.js';
import { exportPairsJob, modelsView, readTraining, scoreModelJob, sourceFixes, trainingView, type PairFilter } from '../training.js';

/**
 * Training (`#/training`, `#/training/tasks`):
 *
 *   GET /api/training[?filter=all|high|medium]   the screen: the strip, pairs, tasks and scores
 *   GET /api/models                              the models Score a model offers, each with its price per attempt (A7)
 *   POST /api/jobs { kind: "pairs", format?, minConfidence? }                  shadowlap export pairs
 *   POST /api/jobs { kind: "score", model, baseUrl?, attempts?, goldens? }    shadowlap tasks score
 *
 * Tasks come from the CLI (`DashboardOptions.training.loadTasks`): a golden's checks are the CLI's to
 * read. Listing models asks each configured provider with the keys already on this machine, and
 * Ollama only where a server already answers; nothing is started, every request times out fast, and a
 * provider that doesn't answer becomes a note. The listing is kept for a few seconds, so opening the
 * dialog again doesn't ask again.
 */

const FILTERS: readonly PairFilter[] = ['all', 'high', 'medium'];
/** How long a read of the goldens is reused: a page that reloads on every change of a live run doesn't reread them each time. */
const TASKS_TTL_MS = 1500;
/** How long a model listing is reused. */
const LISTING_TTL_MS = 15_000;
const NO_LOADER = 'This dashboard doesn’t read the project’s goldens: start it with shadowlap dashboard in the project folder.';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function register(router: Router, ctx: RouteContext): void {
  const o = ctx.options.training ?? {};

  let cached: { at: number; value: { tasks: Task[]; error: string | null } } | null = null;
  /** The project's goldens as tasks, or why they can't be read (a mistake in the config's `tests`). */
  const tasks = (fresh = false): { tasks: Task[]; error: string | null } => {
    if (!o.loadTasks) return { tasks: [], error: NO_LOADER };
    const now = Date.now();
    if (!fresh && cached && now - cached.at < TASKS_TTL_MS) return cached.value;
    try {
      const value = { tasks: o.loadTasks(ctx.store), error: null };
      cached = { at: now, value };
      return value;
    } catch (err) {
      // Not kept: a mistake in the config is read again, so fixing it shows at once.
      cached = null;
      return { tasks: [], error: message(err) };
    }
  };

  /** Prices from the config as it is now, else the ones the dashboard started with. */
  const prices = (): Record<string, Price> | undefined => {
    try {
      return ctx.config().prices ?? ctx.options.prices;
    } catch {
      return ctx.options.prices;
    }
  };

  let listing: { key: string; at: number; value: Promise<ModelListing> } | null = null;
  const listModels = (input: ReturnType<typeof listingInput>): Promise<ModelListing> => {
    const p = prices();
    const key = JSON.stringify([input, p ?? null]);
    if (listing && listing.key === key && Date.now() - listing.at < LISTING_TTL_MS) return listing.value;
    const value = listModelChoices({ ...input, ...(p ? { prices: p } : {}), ...(o.env ? { env: o.env } : {}), ...(o.fetch ? { fetch: o.fetch } : {}), ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) });
    const entry = { key, at: Date.now(), value };
    listing = entry;
    value.catch(() => {
      if (listing === entry) listing = null;
    });
    return value;
  };

  router.get('/training', (r) => {
    const filter = (r.query.get('filter') ?? 'all') as PairFilter;
    if (!FILTERS.includes(filter)) throw new HttpError(400, 'filter must be all, high or medium');
    const t = tasks();
    r.tagged(trainingView(readTraining(ctx.store, { tasks: t.tasks, tasksError: t.error, fixOf: sourceFixes(ctx.store) }), { filter }));
  });

  router.get('/models', async (r) => {
    const t = tasks();
    const scores = ctx.store.listTaskScores();
    r.json(modelsView(t.tasks, scores, await listModels(listingInput(t.tasks, scores))));
  });

  ctx.jobs.registerJobKind('pairs', {
    title: () => 'Exporting pairs',
    build: (req) => {
      const built = exportPairsJob(req);
      return 'error' in built ? built : { args: built.args };
    },
  });

  ctx.jobs.registerJobKind('score', {
    title: () => 'Scoring a model',
    build: (req) => {
      // Read now, not from the cache: a golden fixed a moment ago is a task to score.
      const t = tasks(true);
      if (t.error) return { error: t.error, status: 409 };
      const built = scoreModelJob(req, t.tasks);
      return 'error' in built ? built : { args: built.args };
    },
  });
}
