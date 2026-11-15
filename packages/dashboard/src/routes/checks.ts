import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { ConfigBusyError, ConfigConflictError, SUGGESTED_MAX, agentOfArgv, agentOfRun, editWhenFree, isObject, readConfigFile, type RunRecord } from '@shadowlap/engine';
import { lookupRun, noSuchRun } from '../api.js';
import type { CheckPreviewJob } from '../check-preview.js';
import { ENTRY_KEYS, agentGoldens, changedWords, checksConfig, goldenAgent, printsOf, restoreTestsEntry, writeTestsEntry, type EntryEdit, type TestsWritten } from '../config-tests.js';
import type { RouteContext } from '../context.js';
import { HttpError } from '../http.js';
import { goldensOf } from '../outcome-work.js';
import { sendAnswer } from '../read-pool.js';
import type { Router } from '../router.js';
import { loadRunIndex, runAffinity } from '../run-index.js';
import type { CheckSuggestionsJob } from '../suggested-checks.js';
import type { GoldenSource } from '../tests.js';
import { VERSION, editError, editFolder, failed, log } from './settings-edits.js';

/**
 * Checks: what a check says about the recordings there are before it is saved, and a golden's
 * checks written into shadowlap.config.json. The check builder reads and writes through these:
 *
 *   GET  /api/checks/goldens?run=<id>|golden=<path>   the agent's goldens with their tests entries as
 *                                                     written, the file's version and prints, whether a
 *                                                     write lays out other lines anew (config-tests.ts)
 *   GET  /api/checks/context?run=<id>&at=<n>          what the run's calls offer a check made from call
 *                                                     n: tools, arguments, number fields (pooled)
 *   POST /api/checks/preview { expect, run | golden } the draft judged on the agent's newest recordings,
 *                                                     its goldens' and the run's (pooled; changes nothing)
 *   POST /api/checks/suggestions { run, at?, have?, fix? }   at most three rules that fail the recording
 *                                                     and none of its good runs, those labelled in `have`
 *                                                     left out (suggested-checks.ts; pooled; changes nothing)
 *   PUT  /api/checks/tests { golden, version, read, entry }   the golden's entry, its `expect` set or taken
 *                                                     out (null), refused when the file changed since
 *                                                     `version`, naming what changed from `read`
 */

/** As long as a check a person writes gets, with room to spare. */
const MAX_EXPECT = 64 * 1024;
/** The agent's recordings a draft is judged on, newest first. */
export const PREVIEW_RECORDINGS = 200;
/** The labels of the builder's checks a request for suggestions may name, more than any golden holds. */
const MAX_HAVE = 200;

/** The expect object a request gives, checked for its shape (the CLI reads the rest), or why not. */
function expectOf(raw: unknown): { expect: Record<string, unknown> | null } | { error: string } {
  if (raw === undefined || raw === null || raw === '') return { expect: null };
  let value: unknown = raw;
  if (typeof raw === 'string') {
    if (raw.length > MAX_EXPECT) return { error: 'that check is too long' };
    try {
      value = JSON.parse(raw);
    } catch {
      return { error: 'the check must be JSON, such as {"calls":[{"tool":"issue_refund","after":"lookup_order"}]}' };
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { error: 'the check is an expect object, such as {"tools":{"send_email":0}}' };
  if (JSON.stringify(value).length > MAX_EXPECT) return { error: 'that check is too long' };
  return { expect: value as Record<string, unknown> };
}

/** The project folder the builder reads and writes the config in; a dashboard without one makes no checks. */
function checksFolder(ctx: RouteContext): string {
  if (!ctx.project) throw new HttpError(409, 'Checks need the project folder: start the dashboard with shadowlap dashboard in it');
  return ctx.project.path;
}

/** The run a request names, or why not: a 404, or a 409 for a prefix several runs share. */
function runOf(ctx: RouteContext, id: string): RunRecord {
  const run = lookupRun(ctx.store, id);
  if (run) return run;
  const no = noSuchRun(ctx.store, id);
  throw new HttpError(no.status, no.message);
}

/** One of the project's goldens, by its path, with its agent; a 404 for any other. */
function goldenOf(ctx: RouteContext, path: string, dir: string): { agent: string | null; golden: GoldenSource } {
  const golden = goldensOf(ctx).find((g) => g.path === path);
  if (!golden) throw new HttpError(404, `no golden ${path.slice(0, 200)} in this project`);
  return { agent: goldenAgent(ctx.store, golden, dir), golden };
}

/** Whose checks a request is about: the run a check is made from, or a golden, and the agent either ran. */
function whose(ctx: RouteContext, dir: string, run: unknown, golden: unknown): { agent: string | null; run: RunRecord | null; golden: GoldenSource | null } {
  if (typeof run === 'string' && run) {
    const found = runOf(ctx, run);
    return { agent: agentOfRun(ctx.store, found), run: found, golden: null };
  }
  if (typeof golden === 'string' && golden) return { ...goldenOf(ctx, golden, dir), run: null };
  throw new HttpError(400, 'name the run the check is made from (run) or the golden it is for (golden)');
}

/** A call's number, 1 or more. */
function callNumber(raw: string | null): number {
  const n = Number(raw);
  if (raw === null || !(Number.isInteger(n) && n >= 1)) throw new HttpError(400, 'at is the number of the call the check is made from: a whole number, 1 or more');
  return n;
}

/** The labels of the checks the builder holds, as a request gives them, or a 400. */
function labelsOf(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_HAVE || !raw.every((l) => typeof l === 'string')) throw new HttpError(400, 'have is the labels of the checks the builder holds: at most 200, as text');
  return raw;
}

/**
 * The fix a fix's builder asks for, as a request gives it: its id or a unique prefix of it, which the
 * pooled read resolves as Fixes does; null for a check made from a call, or a 400.
 */
function fixOf(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string' || !raw.trim()) throw new HttpError(400, 'fix is the id of the fix whose check is built, or a unique prefix of it, as text');
  return raw;
}

/**
 * The calls a preview reads, as the run index counts them, so a long read is given longer: the
 * agent's newest finished recordings, as many as it judges, then its goldens' and the run it is made
 * from where they are others. A golden only its pack holds isn't counted.
 */
function previewCalls(ctx: RouteContext, agent: string, runIds: ReadonlyArray<string | null>): number {
  const { runs, byId } = loadRunIndex(ctx.store);
  const mine = runs.filter((r) => r.mode === 'record' && r.status !== 'running' && agentOfArgv(r.argv) === agent).slice(0, PREVIEW_RECORDINGS);
  const seen = new Set(mine.map((r) => r.runId));
  const others = [...new Set(runIds)].filter((id): id is string => !!id && !seen.has(id));
  return mine.reduce((n, r) => n + r.calls, 0) + others.reduce((n, id) => n + (byId.get(id)?.calls ?? 0), 0);
}

/** A golden's entry as a write sets it: only the keys it may set, `expect` an expect object or null to take its checks out. */
function entryOf(raw: unknown): EntryEdit {
  if (!isObject(raw)) throw new HttpError(400, 'entry is what changes in the golden’s tests entry, such as { "expect": { "tools": { "send_email": 0 } } }');
  const others = Object.keys(raw).filter((k) => !(ENTRY_KEYS as readonly string[]).includes(k));
  if (others.length) throw new HttpError(400, `entry sets ${ENTRY_KEYS.join(', ')} alone, not ${others.slice(0, 5).join(', ')}`);
  if (raw.expect !== undefined && raw.expect !== null) {
    if (!isObject(raw.expect)) throw new HttpError(400, 'expect is an expect object, such as {"tools":{"send_email":0}}, or null to take the checks out');
    const asked = expectOf(raw.expect);
    if ('error' in asked) throw new HttpError(400, asked.error);
  }
  return raw;
}

/** A write refused because the file changed since the page read it: a 409 naming what changed, from the file as it is now. */
function conflict(dir: string, read: ReturnType<typeof printsOf>, err: unknown): never {
  let file: ReturnType<typeof readConfigFile>;
  try {
    file = readConfigFile(dir);
  } catch {
    return editError(err);
  }
  throw new HttpError(409, changedWords(read, file));
}

export function register(router: Router, ctx: RouteContext): void {
  router.get('/checks/goldens', (r) => {
    const dir = checksFolder(ctx);
    const { agent, golden } = whose(ctx, dir, r.query.get('run'), r.query.get('golden'));
    try {
      r.tagged(checksConfig(ctx.store, dir, agentGoldens(ctx.store, goldensOf(ctx), dir, agent, golden?.path ?? null), agent));
    } catch (err) {
      editError(err);
    }
  });

  // Read beside the server, by the thread that holds the run: it reads the run's calls and results.
  router.get('/checks/context', async (r) => {
    const id = r.query.get('run');
    if (!id) throw new HttpError(400, 'name the run the check is made from: ?run=<id>&at=<n>');
    const run = runOf(ctx, id);
    const at = callNumber(r.query.get('at'));
    sendAnswer(r, await ctx.reads.run({ kind: 'check-context', runId: run.runId, at }, runAffinity(ctx.store, run.runId)));
  });

  // Judged beside the server: it reads every recording of the agent. A draft of up to 64 KB comes
  // in the body, so it is a POST, which changes nothing.
  router.post(
    '/checks/preview',
    async (r) => {
      const body = await r.body();
      const asked = expectOf(body.expect);
      if ('error' in asked) throw new HttpError(400, asked.error);
      if (!asked.expect) throw new HttpError(400, 'expect is the check to judge, an expect object');
      const dir = checksFolder(ctx);
      const { agent, run, golden } = whose(ctx, dir, body.run, body.golden);
      if (agent === null) throw new HttpError(409, `${run ? 'This run' : 'This golden’s recording'} has no command of its own, so there are no recordings of its agent to judge the check on`);
      const goldens = agentGoldens(ctx.store, goldensOf(ctx), dir, agent, golden?.path ?? null).map((g) => ({ path: g.path, runId: g.runId, pack: g.runId && ctx.store.getRun(g.runId) ? null : resolve(dir, g.path) }));
      const job: CheckPreviewJob = { kind: 'check-preview', expect: asked.expect, agent, madeFrom: run?.runId ?? null, goldens, ...(ctx.read.prices ? { prices: ctx.read.prices } : {}), limit: PREVIEW_RECORDINGS };
      sendAnswer(r, await ctx.reads.run(job, { calls: previewCalls(ctx, agent, [...goldens.map((g) => g.runId), job.madeFrom]) }));
    },
    { write: false },
  );

  // Mined beside the server: finding the good runs reads every run's record. The builder's labels
  // come in the body, so it is a POST, which changes nothing.
  router.post(
    '/checks/suggestions',
    async (r) => {
      const body = await r.body();
      if (typeof body.run !== 'string' || !body.run) throw new HttpError(400, 'name the recording the checks are suggested from (run)');
      const run = runOf(ctx, body.run);
      const at = body.at === undefined || body.at === null ? null : callNumber(String(body.at));
      const job: CheckSuggestionsJob = { kind: 'check-suggestions', runId: run.runId, at, have: labelsOf(body.have), max: SUGGESTED_MAX, fix: fixOf(body.fix) };
      const agent = agentOfRun(ctx.store, run);
      sendAnswer(r, await ctx.reads.run(job, agent === null ? runAffinity(ctx.store, run.runId) : { calls: previewCalls(ctx, agent, [run.runId]) }));
    },
    { write: false },
  );

  router.put('/checks/tests', async (r) => {
    const body = await r.body();
    const dir = editFolder(ctx, checksFolder);
    if (typeof body.golden !== 'string' || !body.golden) throw new HttpError(400, 'golden is the path of the golden whose checks change, such as goldens/refund-flow');
    const { golden } = goldenOf(ctx, body.golden, dir);
    if (typeof body.version !== 'string' || !VERSION.test(body.version)) throw new HttpError(400, 'version is the version of shadowlap.config.json the page read: open the check again and try again');
    const version = body.version;
    const entry = entryOf(body.entry);
    try {
      const written = await editWhenFree((o) => writeTestsEntry(dir, golden.path, entry, { ...o, expect: version }));
      log(ctx, written.event ? [written.event] : [], dir);
      r.json({ key: written.key, version: written.version, added: written.added, removed: written.removed, changed: written.changed, ...(written.changed ? { was: holdUndo({ dir, golden: golden.path, prior: written.prior, version: written.version }) } : {}) });
    } catch (err) {
      if (err instanceof ConfigConflictError && !(err instanceof ConfigBusyError)) conflict(dir, printsOf(body.read), err);
      failed(ctx, err, dir);
    }
  });

  // Undo of a write above, by the `was` its answer gave: the entry as that write found it goes back,
  // written only against the version the write left, so a hand edit since is never written over.
  router.post('/checks/tests/undo', async (r) => {
    const body = await r.body();
    const dir = editFolder(ctx, checksFolder);
    const held = typeof body.was === 'string' ? undos.get(body.was) : undefined;
    if (!held || held.dir !== dir) throw new HttpError(404, UNDO_GONE);
    try {
      const written = await editWhenFree((o) => restoreTestsEntry(dir, held.golden, held.prior, { ...o, expect: held.version }));
      undos.delete(body.was as string);
      log(ctx, written.event ? [written.event] : [], dir);
      r.json({ key: written.key, version: written.version, added: written.added, removed: written.removed, changed: written.changed });
    } catch (err) {
      if (err instanceof ConfigConflictError && !(err instanceof ConfigBusyError)) throw new HttpError(409, UNDO_CHANGED);
      failed(ctx, err, dir);
    }
  });
}

/** What each write's Undo puts back, by the `was` its answer gave: the golden's entry as the write found it, and the version the write left. The newest few are kept. */
const undos = new Map<string, { dir: string; golden: string; prior: TestsWritten['prior']; version: string }>();
const UNDOS_KEPT = 20;

function holdUndo(undo: { dir: string; golden: string; prior: TestsWritten['prior']; version: string }): string {
  const was = randomUUID();
  undos.set(was, undo);
  for (const old of undos.keys()) if (undos.size > UNDOS_KEPT) undos.delete(old);
  return was;
}

const UNDO_GONE = 'This change can no longer be undone from here: edit shadowlap.config.json to put it back';
const UNDO_CHANGED = 'shadowlap.config.json changed on disk since this change was saved, and Undo would write over that: nothing was changed.';
