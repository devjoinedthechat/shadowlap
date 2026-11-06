import { messageOf, setupRunOf } from '@shadowlap/engine';
import { liveKeys } from '../ci-workflows.js';
import type { RouteContext } from '../context.js';
import { HttpError } from '../http.js';
import { answerData } from '../read-pool.js';
import type { Router } from '../router.js';
import {
  CLEANUP_DAYS,
  SettingsRefusal,
  calibrateRun,
  cleanupArgv,
  codingAgentsSettings,
  matchingSettings,
  mcpEntryAsTyped,
  mcpServerFor,
  projectSettings,
  redactionPreview,
  redactionSettings,
  storeSettings,
  toolsSettings,
  type SettingsContext,
} from '../settings.js';
import { readTeamStoreInput } from '../team-store.js';
import type { ToolReads } from '../tool-reads.js';
import { settingsFolder } from './settings-edits.js';

/**
 * Settings (`#/settings/<tab>`): one read per tab, and the two jobs the tabs start. The edits to
 * shadowlap.config.json, and their Undo, are in settings-edits.ts.
 *
 *   GET    /api/settings/matching                  normalizers, the clock, the run Calibrate takes
 *   GET    /api/settings/redaction[?run=<id>]      redaction rules, where they apply, runs to preview
 *   GET    /api/settings/redaction/preview?run=    what the rules would mask in that run (path rules too), read on a
 *                                                   worker thread within limits (redaction-preview.ts)
 *   GET    /api/settings/agents                    the coding agents' files, and the section to paste
 *   GET    /api/settings/tools                     every tool across runs, hosts, MCP servers
 *   GET    /api/settings/tools/mcp?command=|url=   the `shadowlap mcp` line and client entry for a server (and `copy`, as typed)
 *   GET    /api/settings/project                   name, store, runs and attempts, size, address
 *   GET    /api/settings/store                     the team store: bucket, last sync, the CI step
 *
 * Job kinds: `calibrate` { runId?, write? } (the setup run, else the newest recording, when none is
 * named) and `gc` { olderThanDays? } (a dry run) or { confirm: <the dry run's job id> } (deletes
 * exactly the runs that dry run listed, or nothing; when it listed none but found blobs nothing
 * uses or unused space, a plain `gc`, which deletes no run and gives that back).
 *
 * The CI tab reads the tests feature's `GET /api/ci/workflows`; nothing for it is served here.
 */

/** Unused space worth a clean-up of its own when no run is old enough: 1 MB, as `gc` counts it. */
const UNUSED_WORTH = 1024 * 1024;

function refusal(err: unknown): never {
  if (err instanceof SettingsRefusal) throw new HttpError(err.status, err.message);
  throw err;
}

export function register(router: Router, ctx: RouteContext): void {
  const { jobs } = ctx;

  const folder = (): string => settingsFolder(ctx);
  const settings = (options: { setupRun?: boolean } = {}): SettingsContext => {
    const cwd = folder();
    return {
      store: ctx.store,
      cwd,
      dbPath: ctx.options.dbPath ?? null,
      address: ctx.address(),
      // The projects registry names the run the project's setup recorded: calibrate takes it first.
      setupRunId: options.setupRun ? setupRunOf(cwd) : null,
      name: ctx.project?.name ?? null,
    };
  };

  // ---- reads ----

  router.get('/settings/matching', (r) => r.tagged(matchingSettings(settings({ setupRun: true }))));

  router.get('/settings/redaction', (r) => r.tagged(redactionSettings(settings(), { runId: r.query.get('run') })));

  // Read apart, on a thread of its own and within limits; a page that stops waiting (another run
  // picked, the tab left) ends it.
  router.get('/settings/redaction/preview', async (r) => {
    const run = r.query.get('run');
    if (!run) throw new HttpError(400, 'name the run to preview: ?run=<id>');
    const gone = new AbortController();
    const onClose = () => {
      if (!r.res.writableFinished) gone.abort();
    };
    r.res.once('close', onClose);
    try {
      const view = await redactionPreview(settings(), run, { signal: gone.signal });
      r.json(view);
    } catch (err) {
      if (gone.signal.aborted) return void r.res.destroy();
      refusal(err);
    } finally {
      r.res.off('close', onClose);
    }
  });

  router.get('/settings/agents', (r) => r.tagged(codingAgentsSettings(settings())));

  // Every tool call in the store and the MCP servers they came through, read beside the server; the config and the clients' files here.
  router.get('/settings/tools', async (r) => {
    const s = settings();
    r.tagged(toolsSettings(s, { reads: answerData<ToolReads>(await ctx.reads.run({ kind: 'tool-reads' })) }));
  });

  // Add MCP server…: the line and the client entry for what the dialog has so far. Nothing is written.
  router.get('/settings/tools/mcp', (r) => {
    const command = r.query.get('command');
    const url = r.query.get('url');
    if ((command ?? '').length > 4000 || (url ?? '').length > 2000) throw new HttpError(400, 'that is longer than a server command or URL can be');
    try {
      // `copy` is the entry as typed, for its Copy; the rest hides credentials, as the table does.
      r.json({ ...mcpServerFor({ command, url }), copy: mcpEntryAsTyped({ command, url }) });
    } catch (err) {
      throw new HttpError(400, messageOf(err));
    }
  });

  router.get('/settings/project', (r) => r.tagged(projectSettings(settings())));

  router.get('/settings/store', (r) => {
    const cwd = folder();
    // Copy CI step runs the goldens: the keys of those that run live go with it.
    r.tagged(storeSettings(settings(), readTeamStoreInput({ cwd }), liveKeys(cwd, ctx.options.goldens?.() ?? [])));
  });

  // ---- jobs ----

  jobs.registerJobKind('calibrate', {
    title: () => 'Calibrating',
    build: (req) => {
      if (req.write !== undefined && typeof req.write !== 'boolean') return { error: 'write is true or false' };
      if (req.runId !== undefined && req.runId !== null && typeof req.runId !== 'string') return { error: 'runId names a recording' };
      try {
        const run = calibrateRun(settings({ setupRun: true }), typeof req.runId === 'string' ? req.runId : null);
        // Without --json: the drawer shows each round as calibrate prints it, and the result arrives on fd 3.
        return { args: ['calibrate', run.runId, ...(req.write === true ? ['--write'] : [])], runId: run.runId };
      } catch (err) {
        if (err instanceof SettingsRefusal) return { error: err.message, status: err.status };
        throw err;
      }
    },
  });

  jobs.registerJobKind('gc', {
    title: () => 'Cleaning up',
    build: (req) => {
      // "Delete N runs": only after a dry run this dashboard ran, and exactly the runs it listed.
      if (req.confirm !== undefined) {
        if (typeof req.confirm !== 'string' || !req.confirm) return { error: 'confirm names the dry run whose runs to delete' };
        let dry;
        try {
          dry = jobs.view(req.confirm);
        } catch {
          return { error: 'that dry run is no longer in the dashboard: run Clean up old runs again', status: 409 };
        }
        const report = dry.result as { dryRun?: unknown; count?: unknown; cutoff?: unknown; keep?: unknown; expect?: unknown; bytes?: unknown; recordingCount?: unknown; store?: { free?: unknown } } | null;
        if (dry.kind !== 'gc' || !dry.done || dry.code !== 0 || !report || report.dryRun !== true) return { error: 'confirm names a finished dry run of Clean up old runs', status: 409 };
        if (typeof report.count !== 'number' || report.count < 0) return { error: 'the dry run found no runs to delete', status: 409 };
        // No run old enough, but blobs nothing uses or unused space to give back: a plain gc, which deletes no run.
        if (report.count === 0) {
          const bytes = typeof report.bytes === 'number' ? report.bytes : 0;
          const free = typeof report.store?.free === 'number' ? report.store.free : 0;
          if (Number(report.recordingCount) > 0) return { error: 'a run is recording: gc gives space back once it ends', status: 409 };
          if (bytes <= 0 && free < UNUSED_WORTH) return { error: 'the dry run found nothing to delete or give back', status: 409 };
          return { args: ['gc'] };
        }
        const cutoff = typeof report.cutoff === 'number' && Number.isFinite(report.cutoff) ? Math.trunc(report.cutoff) : null;
        const keep = typeof report.keep === 'number' && Number.isInteger(report.keep) && report.keep >= 0 ? report.keep : null;
        try {
          return { args: cleanupArgv({ cutoff, keep, expect: typeof report.expect === 'string' ? report.expect : '' }) };
        } catch (err) {
          return { error: messageOf(err), status: 409 };
        }
      }
      const days = req.olderThanDays ?? CLEANUP_DAYS;
      if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 36_500) return { error: 'olderThanDays is a whole number of days, at least 1' };
      // Always a dry run first: it says what it would free, and the drawer offers to delete those runs.
      return { args: ['gc', '--older-than', String(days), '--dry-run'] };
    },
  });
}
