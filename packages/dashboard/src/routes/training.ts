import { listingInput, listModelChoices, messageOf, type ModelListing, type Normalizer, type Price, type Task } from '@shadowlap/engine';
import type { RouteContext } from '../context.js';
import { HttpError } from '../http.js';
import { sendAnswer } from '../read-pool.js';
import type { Router } from '../router.js';
import { exportPairsJob, modelsView, scoreModelJob, taskUpdateJob, type PairFilter } from '../training.js';

/**
 * Training (`#/training`, `#/training/tasks`):
 *
 *   GET /api/training[?filter=all|high|medium]   the screen: the strip, pairs, tasks and scores
 *   GET /api/models                              the models Score a model offers, each with its price per attempt (A7)
 *   POST /api/jobs { kind: "pairs", format?, minConfidence? }                  shadowlap export pairs
 *   POST /api/jobs { kind: "score", model, baseUrl?, attempts?, goldens? }    shadowlap tasks score
 *   POST /api/jobs { kind: "task-update", golden }     a task whose test forks before its takeover:
 *                                                       normalize add for each value that changes every
 *                                                       run its fork shows, then shadowlap test <golden>
 *                                                       --update (or test alone, when those rules are the fix)
 *
 * Tasks come from the CLI (`DashboardOptions.training.loadTasks`): a golden's checks are the CLI's to
 * read. Listing models asks each configured provider with the keys already on this machine, and
 * Ollama only where a server already answers; nothing is started, every request times out fast, and a
 * provider that doesn't answer becomes a note. The listing is kept for a few seconds, so opening the
 * dialog again doesn't ask again. A read-only dashboard asks no provider.
 */

const FILTERS: readonly PairFilter[] = ['all', 'high', 'medium'];
/** How long a read of the goldens is reused: a page that reloads on every change of a live run doesn't reread them each time. */
const TASKS_TTL_MS = 1500;
/** How long a model listing is reused. */
const LISTING_TTL_MS = 15_000;
const NO_LOADER = 'This dashboard doesn’t read the project’s goldens: start it with shadowlap dashboard in the project folder.';

export function register(router: Router, ctx: RouteContext): void {
  const o = ctx.options.training ?? {};

  let cached: { at: number; store: unknown; root: string | null; value: { tasks: Task[]; error: string | null } } | null = null;
  /** The project's goldens as tasks, or why they can't be read (a mistake in the config's `tests`). */
  const tasks = (fresh = false): { tasks: Task[]; error: string | null } => {
    if (!o.loadTasks) return { tasks: [], error: NO_LOADER };
    const now = Date.now();
    // The project folder the dashboard's jobs run in holds the goldens and the config's `tests`.
    const root = ctx.project?.path ?? null;
    if (!fresh && cached && cached.store === ctx.store && cached.root === root && now - cached.at < TASKS_TTL_MS) return cached.value;
    try {
      const value = { tasks: o.loadTasks(ctx.store, root), error: null };
      cached = { at: now, store: ctx.store, root, value };
      return value;
    } catch (err) {
      // Not kept: a mistake in the config is read again, so fixing it shows at once.
      cached = null;
      return { tasks: [], error: messageOf(err) };
    }
  };

  /** The normalizers in the config as it is now: a value they already mask needs no rule of its own. */
  const normalizers = (): Normalizer[] => {
    try {
      return ctx.config().normalize;
    } catch {
      return [];
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
  const listModels = (input: ReturnType<typeof listingInput> & { ask?: boolean }): Promise<ModelListing> => {
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

  // The pairs every run makes, read beside the server (read-jobs.ts `training`); the goldens and the config here.
  router.get('/training', async (r) => {
    const filter = (r.query.get('filter') ?? 'all') as PairFilter;
    if (!FILTERS.includes(filter)) throw new HttpError(400, 'filter must be all, high or medium');
    const t = tasks();
    sendAnswer(r, await ctx.reads.run({ kind: 'training', tasks: t.tasks, tasksError: t.error, normalizers: normalizers(), filter }));
  });

  router.get('/models', async (r) => {
    const t = tasks();
    const scores = ctx.store.listTaskScores();
    // Nothing can be scored from a read-only dashboard, so it asks no provider with this machine's
    // keys: it lists the recorded models and those scored before.
    r.json(modelsView(t.tasks, scores, await listModels({ ...listingInput(t.tasks, scores), ...(ctx.readOnly ? { ask: false } : {}) })));
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

  // Update the golden of a task its test's early fork blocks; once its test replays to the takeover, it is ready.
  ctx.jobs.registerJobKind('task-update', {
    title: () => 'Updating a golden',
    build: (req, { store }) => {
      const t = tasks(true);
      if (t.error) return { error: t.error, status: 409 };
      const built = taskUpdateJob(req, store, t.tasks, normalizers());
      if ('error' in built) return built;
      const [first, ...then] = built.steps;
      return { title: built.title, args: first!, ...(then.length ? { then } : {}) };
    },
  });
}
