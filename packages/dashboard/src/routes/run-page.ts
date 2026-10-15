import { readConfigFile, type Normalizer } from '@shadowlap/engine';
import { showRunJson } from '../api.js';
import type { RouteContext } from '../context.js';
import { HttpError } from '../http.js';
import type { Router } from '../router.js';
import { EXPORT_KINDS, exportDatasetJob, exportHarJob, exportHtmlJob, exportOtelJob, packJob } from '../run-exports.js';
import { runOffers } from '../run-offers.js';
import type { GoldenSource } from '../tests.js';

/**
 * The run page beyond the run itself: `GET /api/runs/:id/offers` (what the page offers to do with a
 * run: Share's redaction counts, Push, Run blame's check, Find the commit, the diverged test's
 * actions), `GET /api/runs/:id/show` (`shadowlap show --json`, for Provenance's Copy), and the Share
 * menu's job kinds: export-html, pack, export-dataset, export-otel and export-har.
 */

/**
 * The goldens on disk, when the dashboard was started with them (`DashboardOptions.goldens`, which
 * the Tests screen's routes need too): Find the commit then bisects a test replay's golden.
 */
function goldensOf(ctx: RouteContext): GoldenSource[] {
  const fn = (ctx.options as { goldens?: unknown }).goldens;
  if (typeof fn !== 'function') return [];
  try {
    const out: unknown = fn();
    return Array.isArray(out) ? (out as GoldenSource[]) : [];
  } catch {
    return [];
  }
}

export function register(router: Router, ctx: RouteContext): void {
  const { store } = ctx;

  router.get('/runs/:id/offers', (r) => {
    // A config that can't be read stops the copies when they run, with its reason; it doesn't stop the page.
    let redact: readonly Normalizer[] = [];
    try {
      redact = ctx.options.loadConfig ? ctx.config().redact : (ctx.options.redact ?? []);
    } catch {
      redact = [];
    }
    let config: { store?: unknown; tests?: unknown } | null = null;
    if (ctx.project) {
      try {
        const file = readConfigFile(ctx.project.path);
        config = file.exists ? file.data : null;
      } catch {
        config = null;
      }
    }
    const offers = runOffers(store, r.params.id!, { redact, config, goldens: goldensOf(ctx) });
    if (!offers) throw new HttpError(404, `no run ${r.params.id}`);
    r.tagged(offers);
  });

  router.get('/runs/:id/show', (r) => {
    const out = showRunJson(store, r.params.id!, ctx.read);
    if (!out) throw new HttpError(404, `no run ${r.params.id}`);
    r.tagged(out);
  });

  const { jobs, project } = ctx;
  jobs.registerJobKind(EXPORT_KINDS.html, { title: () => 'Exporting HTML', build: (req, b) => exportHtmlJob(b.store, project, req) });
  jobs.registerJobKind(EXPORT_KINDS.pack, { title: () => 'Packing', build: (req, b) => packJob(b.store, project, req) });
  jobs.registerJobKind(EXPORT_KINDS.dataset, { title: () => 'Exporting a dataset', build: (req, b) => exportDatasetJob(b.store, project, req) });
  jobs.registerJobKind(EXPORT_KINDS.otel, { title: () => 'Exporting a trace', build: (req, b) => exportOtelJob(b.store, project, req) });
  jobs.registerJobKind(EXPORT_KINDS.har, { title: () => 'Exporting HAR', build: (req, b) => exportHarJob(b.store, project, req) });
}
