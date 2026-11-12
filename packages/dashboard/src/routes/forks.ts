import { readFileSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { buildActions, actionContext, messageOf } from '@shadowlap/engine';
import type { Normalizer } from '@shadowlap/engine';
import { importedConsent, lookupRun, noSuchRun } from '../api.js';
import { projectNormalizers, type RouteContext } from '../context.js';
import { HttpError } from '../http.js';
import { sendAnswer } from '../read-pool.js';
import { recordingNow } from '../run-exports.js';
import { runAffinity } from '../run-index.js';
import { count } from './runs.js';
import type { Router } from '../router.js';

/**
 * Forks: what a fork did differently from its parent (`GET /api/runs/:id/differences`), the request
 * it changed as recorded and as sent (`GET /api/runs/:id/diff[?call=<n>]`), the tools
 * the model called that the run never recorded, which a replay runs for real (`GET
 * /api/runs/:id/unrecorded`), and a fork
 * from a call's result as a person edited it in the inspector, the `override` job kind: the fork
 * menu's own `--override`, with the edited result sent as an upload rather than a field.
 *
 * The edited result is untrusted data. The browser uploads it as a file (`POST /api/uploads`); the
 * builder claims it, refuses one past OVERRIDE_LIMIT, one that isn't UTF-8 text, and, for a tool's
 * result, one that isn't JSON, and checks that the call is one the fork menu overrides, and that its
 * override isn't off. It builds the command as the fork menu's action builds it: the result inline
 * when it is short enough to stay on the fork's record, so the fork can be made again from it, else
 * the uploaded file's path, which the CLI reads as it reads any `@file`.
 */

/** The largest edited result taken. */
export const OVERRIDE_LIMIT = 2 * 1024 * 1024;
/** Past this, the result goes to the CLI as a file rather than in its arguments. */
export const OVERRIDE_INLINE = 64 * 1024;

export function register(router: Router, ctx: RouteContext): void {
  const normalizers = (): readonly Normalizer[] => projectNormalizers(ctx);

  // It reads every call of the fork and of its parent: worked out beside the server (read-pool.ts).
  router.get('/runs/:id/differences', async (r) => {
    const store = ctx.store;
    const run = lookupRun(store, r.params.id!);
    if (!run) {
      const no = noSuchRun(store, r.params.id!);
      throw new HttpError(no.status, no.message);
    }
    sendAnswer(r, await ctx.reads.run({ kind: 'differences', runId: run.runId, normalizers: [...normalizers()] }, runAffinity(ctx.store, run.runId)));
  });

  // The request a fork or a diverged replay changed, both bodies whole (request-diff.ts): it reads
  // the run's calls and its parent's, so it is worked out beside the server too.
  router.get('/runs/:id/diff', async (r) => {
    const store = ctx.store;
    const callNo = count(r, 'call', 'a call number') ?? null;
    const run = lookupRun(store, r.params.id!);
    if (!run) {
      const no = noSuchRun(store, r.params.id!);
      throw new HttpError(no.status, no.message);
    }
    sendAnswer(r, await ctx.reads.run({ kind: 'request-diff', runId: run.runId, callNo, normalizers: [...normalizers()] }, runAffinity(ctx.store, run.runId)));
  });

  // What the run did that Shadowlap never recorded: it reads every model call's answer, so it is worked out beside the server too.
  const declared = (): Record<string, 'read' | 'write'> => {
    if (!ctx.options.loadConfig) return {};
    try {
      return { ...(ctx.config().unrecorded ?? {}) };
    } catch {
      return {};
    }
  };
  router.get('/runs/:id/unrecorded', async (r) => {
    const store = ctx.store;
    const run = lookupRun(store, r.params.id!);
    if (!run) {
      const no = noSuchRun(store, r.params.id!);
      throw new HttpError(no.status, no.message);
    }
    sendAnswer(r, await ctx.reads.run({ kind: 'unrecorded', runId: run.runId, declared: declared() }, runAffinity(ctx.store, run.runId)));
  });

  ctx.jobs.registerJobKind('override', {
    title: () => 'Forking',
    build: (req, { store, upload, project }) => {
      const run = typeof req.runId === 'string' ? lookupRun(store, req.runId) : null;
      if (!run) return { error: 'runId: name the run to fork' };
      // As the fork menu waits for it: a recording still being made has no end to replay to yet.
      if (recordingNow(store, run)) return { error: `${run.runId.slice(0, 10)} is still recording: fork it once it has ended`, status: 409 };
      const callNo = req.callNo;
      if (typeof callNo !== 'number' || !Number.isInteger(callNo) || callNo < 1) return { error: 'callNo: the call whose result to change, a whole number' };
      const call = store.getCalls(run.runId, { only: [callNo] })[0];
      if (!call) return { error: `no call #${callNo} in run ${run.runId}` };
      // The fork menu's own override at this call: a tool's result, or what a person answered.
      const action = buildActions(run, call, actionContext(store, call)).find((a) => a.key === 'o' || a.key === 'u');
      if (!action?.prompt) return { error: `#${callNo} is a ${call.kind === 'api' ? 'model call' : `${call.kind} call`}: shadowlap replay --override changes a tool's result or what a person answered, nothing else` };
      if (action.disabled) return { error: action.disabled };
      // Someone else's command runs only once the request says yes to it: asked before the upload is taken, so the same upload goes with the yes.
      const refused = action.imported ? importedConsent(run, action.prompt.build('…'), req.yes) : null;
      if (refused) return refused;
      const file = upload(req.uploadId);
      if (!file) return { error: 'uploadId: upload the edited result first (POST /api/uploads), and use it for one fork' };
      if (file.bytes > OVERRIDE_LIMIT) return { error: `the edited result is ${file.bytes.toLocaleString('en-US')} bytes: at most ${OVERRIDE_LIMIT.toLocaleString('en-US')}`, status: 413 };
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(file.path));
      } catch {
        return { error: 'the edited result is not UTF-8 text' };
      }
      if (action.key === 'u') {
        // What a person answers is text: the action keeps the reply's own shape around it.
        if (!text.trim()) return { error: 'the answer is empty: write what the person answers' };
        if (text.length > OVERRIDE_INLINE) return { error: `the answer is ${text.length.toLocaleString('en-US')} characters: at most ${OVERRIDE_INLINE.toLocaleString('en-US')}`, status: 413 };
        return { args: action.prompt.build(text), runId: run.runId, opensRun: true };
      }
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch (err) {
        return { error: `the edited result is not JSON: ${messageOf(err)}` };
      }
      const json = JSON.stringify(value);
      if (json.length <= OVERRIDE_INLINE) return { args: action.prompt.build(json), runId: run.runId, opensRun: true };
      // Too long to stay on the fork's record: the CLI reads it from the upload, named from the
      // project folder the job runs in, with forward slashes on every system.
      const rel = project ? relative(project.path, file.path) : '';
      const path = rel && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel) ? rel.split(sep).join('/') : file.path;
      const args = action.prompt.build('{}');
      const at = args.findIndex((a) => a === '--override');
      if (at < 0 || at + 1 >= args.length) return { error: `#${callNo}'s override can't take a file` };
      args[at + 1] = `${callNo}=@${path}`;
      return { args, runId: run.runId, opensRun: true };
    },
  });
}
