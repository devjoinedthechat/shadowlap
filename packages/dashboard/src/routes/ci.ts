import { goldensPassed, recordEvent, resolveAuthor, WorkflowConflictError, WorkflowFileError, writeWorkflow, type StoreOf } from '@shadowlap/engine';
import { randomBytes } from 'node:crypto';
import { repositoryWorkflow, type RepositoryWorkflow } from '../ci-file.js';
import { ciWorkflows, fileOptions, fixPreview, gitFacts, goldenProviders, parseCiOptions, type CiSession, type CiWorkflowsView } from '../ci-workflows.js';
import type { RouteContext } from '../context.js';
import { HttpError } from '../http.js';
import type { Router } from '../router.js';
import { configFileError } from '../settings.js';
import { readTeamStoreInput } from '../team-store.js';
import { lastFullSession, testPatterns, testsSummary, type GoldenSource } from '../tests.js';
import { editFolder, failed, VERSION } from './settings-edits.js';
import { GOLDENS_FOLDER } from './tests.js';

/**
 * Settings → CI: your workflow against the repository's, and Write file.
 *
 *   GET  /api/ci/workflows?comment=&fix=&alerts=&budget=&repairer=&onlyMain=&secret=&inconclusive=
 *        every panel for the options the page changed, the rest as the repository's workflow sets them
 *   PUT  /api/ci/workflow       { options, expect, shown }: Write file; answers { path, version, was }
 *   POST /api/ci/workflow/undo  { was, expect }: its Undo, which puts the file back as it was, or
 *                               removes the one the write made
 *
 * Write file writes only text the server builds itself, from the options and the repository's file
 * read again, never text from the page, and only while the file is the version the page read
 * (`expect`, the view's `version`) and the file it would write is the one the page showed (`shown`,
 * the view's `workflow.shown`): either changed is a 409, so it never writes a file nobody saw. A
 * file it can't write, or a view with a `problem`, is a 422. Its Undo is held here, never sent to
 * the page, and goes back only against the version the write left. Each lands in the activity feed
 * as `ci.workflow`.
 */

/** How many Write file Undos are kept: a toast's Undo is pressed within seconds of the write. */
const UNDOS_KEPT = 20;

/** What a write replaced, for its Undo: the project and file, and the text as it was (null: there was none). */
interface Kept {
  project: string;
  path: string;
  text: string | null;
}

/** The test session the line under Your workflow names: its tally as every tally on a page counts it, inconclusive goldens apart. */
function ciSession(store: StoreOf<'tests'>, goldens: readonly GoldenSource[]): CiSession | null {
  const s = lastFullSession(store, goldens);
  if (!s) return null;
  const notPassed = [s.failed ? `${s.failed} failed` : '', s.inconclusive ? `${s.inconclusive} inconclusive` : ''].filter(Boolean).join(', ');
  return { ci: false, revision: s.revision, at: s.endedAt ?? s.startedAt, text: `${goldensPassed(s.passed, s.passed + s.failed + s.inconclusive)}${notPassed ? ` · ${notPassed}` : ''}` };
}

/** The page's options, as the PUT carries them, in the query string's form parseCiOptions reads. */
function optionsQuery(options: unknown): URLSearchParams {
  const q = new URLSearchParams();
  if (options === undefined || options === null) return q;
  if (typeof options !== 'object' || Array.isArray(options)) throw new HttpError(400, 'options are the switches as the page has them: { fix: true, budget: "2.00", … }');
  for (const [key, value] of Object.entries(options as Record<string, unknown>)) {
    if (typeof value === 'boolean') q.set(key, value ? 'on' : 'off');
    else if (typeof value === 'string') q.set(key, value);
    else if (value !== undefined && value !== null) throw new HttpError(400, `options.${key.slice(0, 40)} is on or off, or a value as the panel sets it`);
  }
  return q;
}

/** A version the page names, as the view gave it: `absent`, or a SHA-256. */
function versionOf(value: unknown, what: string): string {
  if (typeof value !== 'string' || !VERSION.test(value)) throw new HttpError(400, `${what} is the version the CI tab read: read it again and try again`);
  return value;
}

/** A write's refusal as the page shows it: the file changed (409), or it can't be written (422). */
function writeError(ctx: RouteContext, err: unknown, cwd: string): never {
  if (err instanceof WorkflowConflictError) throw new HttpError(409, err.message);
  if (err instanceof WorkflowFileError) throw new HttpError(422, err.message);
  return failed(ctx, err, cwd);
}

export function register(router: Router, ctx: RouteContext): void {
  const goldens = (): GoldenSource[] => ctx.options.goldens?.() ?? [];
  const undos = new Map<string, Kept>();

  /** Every panel for the page's options (`q`), the switches the page didn't change as the repository's workflow sets them, and the file read. */
  const read = (q: URLSearchParams): { view: CiWorkflowsView; repo: RepositoryWorkflow | null } => {
    const project = ctx.project?.path ?? null;
    const git = gitFacts(project);
    const repo = repositoryWorkflow(project, git.root);
    const options = parseCiOptions(q, fileOptions(repo?.switches ?? null));
    if ('error' in options) throw new HttpError(400, options.error);
    const list = goldens();
    const summary = testsSummary(ctx.store, { goldens: list });
    const view = ciWorkflows(options, {
      preview: fixPreview(ctx.store, options.budget),
      failing: summary.failing,
      at: summary.lastRunAt,
      repository: git.repository,
      branch: git.branch,
      defaultBranch: git.defaultBranch,
      recordings: list.length ? testPatterns(list, GOLDENS_FOLDER).join(' ') : `${GOLDENS_FOLDER}/*`,
      // Push from CI, read as Settings → Store reads it: the step pushes when it is on.
      teamStore: project ? readTeamStoreInput({ cwd: project }) : null,
      // Which goldens run live in CI, and the providers' keys each step's env needs.
      goldens: project ? goldenProviders(project, list) : null,
      // A config that can't be read hides both: the steps say what they leave out, and Write file waits.
      configError: project ? configFileError(project) : null,
      repo,
      root: git.root,
      session: ciSession(ctx.store, list),
    });
    return { view, repo };
  };

  router.get('/ci/workflows', (r) => {
    r.tagged(read(r.query).view);
  });

  router.put('/ci/workflow', async (r) => {
    const body = await r.body();
    const expect = versionOf(body.expect, 'expect');
    if (typeof body.shown !== 'string' || !/^[0-9a-f]{64}$/.test(body.shown)) throw new HttpError(400, 'shown is the workflow the page showed (its workflow.shown): read the CI tab again and try again');
    const q = optionsQuery(body.options);
    const cwd = editFolder(ctx);
    const { view, repo } = read(q);
    if (view.version !== expect) throw new HttpError(409, `${view.file} changed since it was read`);
    if (view.problem) throw new HttpError(422, view.problem);
    // The config, the goldens or Push from CI changed what the switches build since the page showed it.
    if (view.workflow.shown !== body.shown) throw new HttpError(409, 'The workflow the switches build is no longer the one this page showed, so nothing was written: look at the change again, then write it.');
    if (view.workflow.same) return r.json({ path: view.file, version: view.version, changed: false, was: null });
    const before = repo?.file.exists ? repo.file : null;
    let written: { version: string };
    try {
      written = writeWorkflow(cwd, view.file, view.workflow.text, { expect });
    } catch (err) {
      return writeError(ctx, err, cwd);
    }
    const was = randomBytes(16).toString('hex');
    undos.set(was, { project: cwd, path: view.file, text: before ? before.text : null });
    for (const key of undos.keys()) if (undos.size > UNDOS_KEPT) undos.delete(key);
    recordEvent(ctx.store, { kind: 'ci.workflow', actor: resolveAuthor({ cwd }), ref: view.file, data: { added: view.workflow.added, removed: view.workflow.removed, created: !view.exists } });
    r.json({ path: view.file, version: written.version, changed: true, was });
  });

  // Write file's Undo: the file as the write found it, back against the version the write left.
  router.post('/ci/workflow/undo', async (r) => {
    const body = await r.body();
    const expect = versionOf(body.expect, 'expect');
    const kept = typeof body.was === 'string' ? undos.get(body.was) : undefined;
    const cwd = editFolder(ctx);
    if (!kept || kept.project !== cwd) throw new HttpError(409, 'That Undo is no longer in the dashboard: change the file in your repository by hand, or with Write file.');
    let written: { version: string };
    try {
      written = writeWorkflow(cwd, kept.path, kept.text, { expect });
    } catch (err) {
      return writeError(ctx, err, cwd);
    }
    undos.delete(body.was as string);
    const removed = kept.text === null;
    recordEvent(ctx.store, { kind: 'ci.workflow', actor: resolveAuthor({ cwd }), ref: kept.path, data: { undo: true, removed } });
    r.json({ path: kept.path, version: written.version, removed });
  });
}
