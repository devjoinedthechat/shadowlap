import {
  ConfigConflictError,
  ConfigFileError,
  RuleError,
  addRule,
  addRules,
  editConfigFile,
  editWhenFree,
  recordEvent,
  removeRule,
  resolveAuthor,
  restoreRule,
  setClock,
  type ConfigEvent,
  type RuleList,
} from '@shadowlap/engine';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import type { RouteContext } from '../context.js';
import { folderGoneText } from '../folder-gone.js';
import { HttpError } from '../http.js';
import type { Router } from '../router.js';
import { proposedRules } from '../settings.js';

/**
 * Settings' edits to shadowlap.config.json, and the Undo of each that has one.
 *
 *   POST   /api/settings/rules/:list               add a normalizer or redaction rule { rule, expect }
 *   DELETE /api/settings/rules/:list/:n?expect=    remove one by its number; answers the rule as stored
 *   POST   /api/settings/rules/:list/:n/restore    { rule, expect }: put a removed rule back at its number
 *   PUT    /api/settings/clock                     { mode: 'auto' | 'exact' | null, expect }; answers `was`
 *   PUT    /api/settings/store/ci-push             { on: true | false | null, expect }: Push from CI; answers `was`
 *   POST   /api/settings/calibrate/write           { jobId }: add what a calibrate job proposed
 *
 * Every edit names the version of the file it was read from (`expect`, from a tab's `config`), so a
 * page showing an old list can't remove the wrong rule: a file changed on disk since is a 409. An
 * Undo names the version the edit it undoes wrote, from that edit's answer, so it is refused the
 * same way once anything else has changed the file. The rules are checked by the engine, as
 * `shadowlap normalize add` checks them (400 with the same words); a file that can't be read or
 * written is a 422. Each edit lands in the activity feed. Null for the clock or Push from CI takes
 * the key out of the file: how an Undo puts back a file that didn't have one.
 */

const LISTS: readonly RuleList[] = ['normalize', 'redact'];
/** The version of the file an edit was based on: `absent`, or a SHA-256. */
export const VERSION = /^(absent|[0-9a-f]{64})$/;

function listOf(name: string | undefined): RuleList {
  if (!LISTS.includes(name as RuleList)) throw new HttpError(404, 'rules are under /settings/rules/normalize or /settings/rules/redact');
  return name as RuleList;
}

function expectOf(value: unknown): string {
  if (typeof value !== 'string' || !VERSION.test(value)) throw new HttpError(400, "expect is the version of shadowlap.config.json the page read (its config.version): reload Settings and try again");
  return value;
}

function numberOf(value: string | undefined): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'name the rule by its number, from 1');
  return n;
}

/** An edit's error as the page shows it: the rule's fault (400), a file that changed or is busy (409), one that can't be read or written (422). */
export function editError(err: unknown): never {
  if (err instanceof HttpError) throw err;
  if (err instanceof RuleError) throw new HttpError(400, err.message);
  if (err instanceof ConfigConflictError) throw new HttpError(409, err.message);
  if (err instanceof ConfigFileError) throw new HttpError(422, err.message);
  throw err;
}

/** The project folder Settings reads and edits; a dashboard without one has no Settings. */
export function settingsFolder(ctx: RouteContext): string {
  if (!ctx.project) throw new HttpError(409, 'Settings need the project folder: start the dashboard with shadowlap dashboard in it');
  return ctx.project.path;
}

/** Why an edit can't be made when the folder is gone from disk: the page turns its edits off with the same words. */
const gone = (ctx: RouteContext, cwd: string) => new HttpError(409, folderGoneText(ctx.project?.name ?? basename(cwd)));

/**
 * The folder an edit writes into: refused, saying why, when it is gone, rather than with the file
 * system's ENOENT. `folder` is the project's folder as the edit's page needs it (Settings' by default).
 */
export function editFolder(ctx: RouteContext, folder: (ctx: RouteContext) => string = settingsFolder): string {
  const cwd = folder(ctx);
  if (!existsSync(cwd)) throw gone(ctx, cwd);
  return cwd;
}

/** An edit's error as the page shows it (editError); one made while the folder went away says so. */
export function failed(ctx: RouteContext, err: unknown, cwd: string): never {
  if (!existsSync(cwd)) throw gone(ctx, cwd);
  return editError(err);
}

/** Records the activity an edit leaves, as the CLI's edits do; the person is resolved as the CLI resolves them, in the folder the edit wrote into. */
export function log(ctx: RouteContext, events: ReadonlyArray<ConfigEvent & { runId?: string | null }>, cwd: string = settingsFolder(ctx)): void {
  if (!events.length) return;
  const actor = resolveAuthor({ cwd });
  for (const e of events) recordEvent(ctx.store, { ...e, actor });
}

export function register(router: Router, ctx: RouteContext): void {
  const { jobs } = ctx;

  /** Runs one edit of the file in the project's folder, its errors as the page shows them. */
  const edit = async <T>(fn: (cwd: string) => Promise<T>): Promise<T> => {
    const cwd = editFolder(ctx);
    try {
      return await fn(cwd);
    } catch (err) {
      return failed(ctx, err, cwd);
    }
  };

  router.post('/settings/rules/:list', async (r) => {
    const list = listOf(r.params.list);
    const body = await r.body();
    const expect = expectOf(body.expect);
    await edit(async (cwd) => {
      const added = await editWhenFree((o) => addRule(cwd, list, body.rule, { ...o, expect }));
      log(ctx, added.event ? [added.event] : []);
      r.json({ list, n: added.n, added: added.added, rule: added.rule, version: added.file.version });
    });
  });

  router.delete('/settings/rules/:list/:n', async (r) => {
    const list = listOf(r.params.list);
    const n = numberOf(r.params.n);
    const expect = expectOf(r.query.get('expect'));
    await edit(async (cwd) => {
      const removed = await editWhenFree((o) => removeRule(cwd, list, n, { ...o, expect }));
      log(ctx, [removed.event]);
      r.json({ list, n: removed.n, rule: removed.rule, version: removed.file.version });
    });
  });

  // Undo of a removal: the rule as the removal answered it, back at its number.
  router.post('/settings/rules/:list/:n/restore', async (r) => {
    const list = listOf(r.params.list);
    const n = numberOf(r.params.n);
    const body = await r.body();
    const expect = expectOf(body.expect);
    await edit(async (cwd) => {
      const back = await editWhenFree((o) => restoreRule(cwd, list, n, body.rule, { ...o, expect }));
      log(ctx, back.event ? [back.event] : []);
      r.json({ list, n: back.n, version: back.file.version });
    });
  });

  router.put('/settings/clock', async (r) => {
    const body = await r.body();
    const expect = expectOf(body.expect);
    await edit(async (cwd) => {
      const set = await editWhenFree((o) => setClock(cwd, body.mode, { ...o, expect }));
      log(ctx, set.event ? [set.event] : []);
      r.json({ clock: set.clock, was: set.was, changed: set.changed, version: set.file.version });
    });
  });

  // Push from CI, as `shadowlap store push-from-ci on|off` writes it, with the same activity entry.
  router.put('/settings/store/ci-push', async (r) => {
    const body = await r.body();
    if (typeof body.on !== 'boolean' && body.on !== null) throw new HttpError(400, 'on is true or false');
    const on: boolean | null = body.on;
    const expect = expectOf(body.expect);
    await edit(async (cwd) => {
      let previous = true;
      let was: boolean | null = null;
      const written = await editWhenFree((o) =>
        editConfigFile(cwd, { ...o, expect }, (data) => {
          previous = data.ciPush !== false;
          was = typeof data.ciPush === 'boolean' ? data.ciPush : null;
          if (on === null) delete data.ciPush;
          else data.ciPush = on;
        }),
      );
      const now = on !== false;
      const store = typeof written.file.data.store === 'string' ? written.file.data.store : null;
      if (written.changed) recordEvent(ctx.store, { kind: 'store.ci', actor: resolveAuthor({ cwd }), ...(store ? { ref: store } : {}), data: { push: now, previous } });
      r.json({ ciPush: now, previous, was, changed: written.changed, version: written.file.version });
    });
  });

  // "Add normalizer" after a calibrate job: exactly the rules it proposed, the ones the person just
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
    await edit(async (cwd) => {
      const saved = await editWhenFree((o) => addRules(cwd, 'normalize', rules, o));
      log(ctx, saved.events.map((e) => ({ ...e, runId, data: { ...e.data, via: 'calibrate' } })));
      r.json({ added: saved.rules.filter((x) => x.added).map((x) => x.n), already: saved.rules.filter((x) => !x.added).map((x) => x.n), version: saved.file.version });
    });
  });
}
