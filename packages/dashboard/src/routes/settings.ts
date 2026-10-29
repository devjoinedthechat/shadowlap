import {
  ConfigConflictError,
  ConfigFileError,
  RuleError,
  addRule,
  addRules,
  editConfigFile,
  editWhenFree,
  messageOf,
  recordEvent,
  removeRule,
  resolveAuthor,
  setClock,
  setupRunOf,
  type ConfigEvent,
  type RuleList,
} from '@shadowlap/engine';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { liveKeys } from '../ci-workflows.js';
import type { RouteContext } from '../context.js';
import { folderGoneText } from '../folder-gone.js';
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
  proposedRules,
  redactionPreview,
  redactionSettings,
  storeSettings,
  toolsSettings,
  type SettingsContext,
} from '../settings.js';
import { readTeamStoreInput } from '../team-store.js';
import type { ToolReads } from '../tool-reads.js';

/**
 * Settings (`#/settings/<tab>`): one read per tab, the edits to shadowlap.config.json, and the two
 * jobs the tabs start.
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
 *   POST   /api/settings/rules/:list               add a normalizer or redaction rule { rule, expect }
 *   DELETE /api/settings/rules/:list/:n?expect=    remove one by its number
 *   PUT    /api/settings/clock                     { mode: 'auto' | 'exact', expect }
 *   PUT    /api/settings/store/ci-push             { on, expect }: Push from CI
 *   POST   /api/settings/calibrate/write           { jobId }: add what a calibrate job proposed
 *
 * Every edit names the version of the file it was read from (`expect`, from a tab's `config`), so a
 * page showing an old list can't remove the wrong rule: a file changed on disk since is a 409. The
 * rules are checked by the engine, as `shadowlap normalize add` checks them (400 with the same
 * words); a file that can't be read or written is a 422. Each edit lands in the activity feed.
 *
 * Job kinds: `calibrate` { runId?, write? } (the setup run, else the newest recording, when none is
 * named) and `gc` { olderThanDays? } (a dry run) or { confirm: <the dry run's job id> } (deletes
 * exactly the runs that dry run listed, or nothing; when it listed none but found blobs nothing
 * uses or unused space, a plain `gc`, which deletes no run and gives that back).
 *
 * The CI tab reads the tests feature's `GET /api/ci/workflows`; nothing for it is served here.
 */

const LISTS: readonly RuleList[] = ['normalize', 'redact'];
/** Unused space worth a clean-up of its own when no run is old enough: 1 MB, as `gc` counts it. */
const UNUSED_WORTH = 1024 * 1024;
/** The version of the file an edit was based on: `absent`, or a SHA-256. */
const VERSION = /^(absent|[0-9a-f]{64})$/;

function listOf(name: string | undefined): RuleList {
  if (!LISTS.includes(name as RuleList)) throw new HttpError(404, 'rules are under /settings/rules/normalize or /settings/rules/redact');
  return name as RuleList;
}

function expectOf(value: unknown): string {
  if (typeof value !== 'string' || !VERSION.test(value)) throw new HttpError(400, "expect is the version of shadowlap.config.json the page read (its config.version): reload Settings and try again");
  return value;
}

/** An edit's error as the page shows it: the rule's fault (400), a file that changed or is busy (409), one that can't be read or written (422). */
function editError(err: unknown): never {
  if (err instanceof HttpError) throw err;
  if (err instanceof RuleError) throw new HttpError(400, err.message);
  if (err instanceof ConfigConflictError) throw new HttpError(409, err.message);
  if (err instanceof ConfigFileError) throw new HttpError(422, err.message);
  throw err;
}

function refusal(err: unknown): never {
  if (err instanceof SettingsRefusal) throw new HttpError(err.status, err.message);
  throw err;
}

export function register(router: Router, ctx: RouteContext): void {
  const { jobs } = ctx;

  /** The project folder Settings reads and edits; a dashboard without one has no Settings. */
  const folder = (): string => {
    if (!ctx.project) throw new HttpError(409, 'Settings need the project folder: start the dashboard with shadowlap dashboard in it');
    return ctx.project.path;
  };
  /** Why an edit can't be made when the folder is gone from disk: the page turns its edits off with the same words. */
  const gone = (cwd: string) => new HttpError(409, folderGoneText(ctx.project?.name ?? basename(cwd)));
  /** The folder an edit writes into: refused, saying why, when it is gone, rather than with the file system's ENOENT. */
  const editFolder = (): string => {
    const cwd = folder();
    if (!existsSync(cwd)) throw gone(cwd);
    return cwd;
  };
  /** An edit's error as the page shows it (editError); one made while the folder went away says so. */
  const failed = (err: unknown, cwd: string): never => {
    if (!existsSync(cwd)) throw gone(cwd);
    return editError(err);
  };
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
  /** Records the activity an edit leaves, as the CLI's edits do; the person is resolved as the CLI resolves them. */
  const log = (events: ReadonlyArray<ConfigEvent & { runId?: string | null }>): void => {
    if (!events.length) return;
    const actor = resolveAuthor({ cwd: folder() });
    for (const e of events) recordEvent(ctx.store, { ...e, actor });
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

  // "Add a server…": the line and the client entry for what the dialog has so far. Nothing is written.
  router.get('/settings/tools/mcp', (r) => {
    const command = r.query.get('command');
    const url = r.query.get('url');
    if ((command ?? '').length > 4000 || (url ?? '').length > 2000) throw new HttpError(400, 'that is longer than a server command or URL can be');
    try {
      // `copy` is the entry as typed, for Copy the entry; the rest hides credentials, as the table does.
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

  // ---- edits ----

  router.post('/settings/rules/:list', async (r) => {
    const list = listOf(r.params.list);
    const body = await r.body();
    const expect = expectOf(body.expect);
    const cwd = editFolder();
    try {
      const added = await editWhenFree((o) => addRule(cwd, list, body.rule, { ...o, expect }));
      log(added.event ? [added.event] : []);
      r.json({ list, n: added.n, added: added.added, rule: added.rule, version: added.file.version });
    } catch (err) {
      failed(err, cwd);
    }
  });

  router.delete('/settings/rules/:list/:n', async (r) => {
    const list = listOf(r.params.list);
    const n = Number(r.params.n);
    if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'name the rule by its number, from 1');
    const expect = expectOf(r.query.get('expect'));
    const cwd = editFolder();
    try {
      const removed = await editWhenFree((o) => removeRule(cwd, list, n, { ...o, expect }));
      log([removed.event]);
      r.json({ list, n: removed.n, rule: removed.rule, version: removed.file.version });
    } catch (err) {
      failed(err, cwd);
    }
  });

  router.put('/settings/clock', async (r) => {
    const body = await r.body();
    const expect = expectOf(body.expect);
    const cwd = editFolder();
    try {
      const set = await editWhenFree((o) => setClock(cwd, body.mode, { ...o, expect }));
      log(set.event ? [set.event] : []);
      r.json({ clock: set.clock, changed: set.changed, version: set.file.version });
    } catch (err) {
      failed(err, cwd);
    }
  });

  // Push from CI, as `shadowlap store push-from-ci on|off` writes it, with the same activity entry.
  router.put('/settings/store/ci-push', async (r) => {
    const body = await r.body();
    if (typeof body.on !== 'boolean') throw new HttpError(400, 'on is true or false');
    const on = body.on;
    const expect = expectOf(body.expect);
    const cwd = editFolder();
    try {
      let previous = true;
      const edit = await editWhenFree((o) =>
        editConfigFile(cwd, { ...o, expect }, (data) => {
          previous = data.ciPush !== false;
          data.ciPush = on;
        }),
      );
      const store = typeof edit.file.data.store === 'string' ? edit.file.data.store : null;
      if (edit.changed) recordEvent(ctx.store, { kind: 'store.ci', actor: resolveAuthor({ cwd }), ...(store ? { ref: store } : {}), data: { push: on, previous } });
      r.json({ ciPush: on, previous, changed: edit.changed, version: edit.file.version });
    } catch (err) {
      failed(err, cwd);
    }
  });

  // "Add it (--write)" after a calibrate job: exactly the rules it proposed, the ones the person just
  // read in the drawer, without replaying again. They come from the job's result, never the page.
  router.post('/settings/calibrate/write', async (r) => {
    const body = await r.body();
    if (typeof body.jobId !== 'string' || !body.jobId) throw new HttpError(400, 'jobId names the calibrate job whose normalizers to add');
    let job;
    try {
      job = jobs.view(body.jobId);
    } catch {
      throw new HttpError(404, 'that calibration is no longer in the dashboard: run Calibrate again');
    }
    if (job.kind !== 'calibrate') throw new HttpError(400, 'that job is not a calibration');
    if (!job.done) throw new HttpError(409, 'the calibration is still running');
    const result = job.result as { runId?: unknown; written?: unknown } | null;
    // The recording it replayed must be this project's: a drawer left open across a switch of
    // projects must not write one project's normalizers into another's config.
    const runId = job.runId ?? (typeof result?.runId === 'string' ? result.runId : null);
    if (!runId || !ctx.store.getRun(runId)) throw new HttpError(409, 'that calibration replayed a run this project doesn’t have: add what it proposed from its own project, or run Calibrate here');
    const rules = proposedRules(result);
    if (!rules.length) throw new HttpError(409, 'the calibration proposed nothing to add');
    const cwd = editFolder();
    try {
      const saved = await editWhenFree((o) => addRules(cwd, 'normalize', rules, o));
      log(saved.events.map((e) => ({ ...e, runId, data: { ...e.data, via: 'calibrate' } })));
      r.json({ added: saved.rules.filter((x) => x.added).map((x) => x.n), already: saved.rules.filter((x) => !x.added).map((x) => x.n), version: saved.file.version });
    } catch (err) {
      failed(err, cwd);
    }
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
