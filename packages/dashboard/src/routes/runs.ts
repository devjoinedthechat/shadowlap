import { addNote, callDetail, changeLabels, lineage, listRuns, lookupRun, provenance, runDetail } from '../api.js';
import type { RouteContext } from '../context.js';
import { ExportError, exportHtmlApart } from '../export-apart.js';
import { HttpError } from '../http.js';
import type { Router } from '../router.js';
import { recordingNow, stillRecording } from '../run-exports.js';
import { maskCount } from '../run-mask.js';
import { deleteRuns } from '../runs-list.js';
import { exportHtml, withAncestors, type ExportHtmlResult } from '../static.js';

/** Runs: the list, one run, its calls, family and provenance, labels and notes, the HTML download, delete. */
export function register(router: Router, ctx: RouteContext): void {
  // `ctx.store` is read in each handler: on a dashboard with several projects it is the current one's.
  router.get('/runs', (r) => r.tagged({ runs: listRuns(ctx.store, ctx.read) }));

  router.get('/runs/:id', (r) => {
    const store = ctx.store;
    const d = runDetail(store, r.params.id!, ctx.read);
    if (!d) throw new HttpError(404, `no run ${r.params.id}`);
    r.tagged(d);
  });

  // As the Runs page deletes: the attempts bundled under the run go with it, and a run still
  // recording, or one a replay in progress still serves answers from, is left alone. A write, so a
  // read-only dashboard refuses it before it gets here.
  router.delete('/runs/:id', (r) => {
    const store = ctx.store;
    const out = deleteRuns(store, [r.params.id!]);
    if ('error' in out) throw new HttpError(400, out.error);
    const skipped = out.skipped[0];
    if (skipped) throw skipped.reason === 'no such run' ? new HttpError(404, `no run ${r.params.id}`) : new HttpError(409, `this run can't be deleted now: ${skipped.reason}`);
    r.json({ deleted: out.done[0], attempts: out.attempts, blobs: out.blobs, bytes: out.bytes });
  });

  router.get('/runs/:id/calls/:n', (r) => {
    const store = ctx.store;
    const n = Number(r.params.n);
    const d = Number.isInteger(n) ? callDetail(store, r.params.id!, n, ctx.read) : null;
    if (!d) throw new HttpError(404, `no call #${r.params.n} in run ${r.params.id}`);
    r.tagged(d);
  });

  // The run's record for the Provenance tab, with what a copy made now would mask under the
  // project's redaction rules, read afresh as the download reads them. The count is the Redaction
  // tab's preview of the run, read on a thread of its own (run-mask.ts): a rule that takes minutes
  // on the run's text leaves it uncounted, with why, rather than holding the server up.
  router.get('/runs/:id/provenance', async (r) => {
    const store = ctx.store;
    const run = lookupRun(store, r.params.id!);
    if (!run) throw new HttpError(404, `no run ${r.params.id}`);
    const redact = ctx.options.loadConfig ? ctx.config().redact : (ctx.options.redact ?? []);
    const mask = await maskCount({ store, dbPath: ctx.options.dbPath ?? null, run, rules: redact });
    const p = provenance(store, run.runId, { ...ctx.read, ...(redact.length ? { redact } : {}), maskCount: () => mask });
    if (!p) throw new HttpError(404, `no run ${r.params.id}`);
    r.tagged(p);
  });

  router.get('/runs/:id/lineage', (r) => {
    const store = ctx.store;
    const nodes = lineage(store, r.params.id!, ctx.read);
    if (!nodes) throw new HttpError(404, `no run ${r.params.id}`);
    r.tagged({ nodes });
  });

  router.post('/runs/:id/labels', async (r) => {
    const store = ctx.store;
    const body = await r.body();
    const out = changeLabels(store, r.params.id!, body.add, body.remove);
    if ('error' in out) throw new HttpError(out.status, out.error);
    r.json(out);
  });

  router.post('/runs/:id/notes', async (r) => {
    const store = ctx.store;
    const body = await r.body();
    const out = addNote(store, r.params.id!, body.callNo, body.text);
    if ('error' in out) throw new HttpError(out.status, out.error);
    r.json(out);
  });

  // A run as one self-contained HTML file, for sharing. A read, so a read-only dashboard offers it
  // too. Its ancestors come along so a fork still shows what it parted from, and the project's
  // redaction rules apply, exactly as `shadowlap export html --lineage` does. It is made on a thread
  // of its own (export-apart.ts): a long run, or a rule that is slow on the run's text, never holds
  // the server up, and one that takes too long is stopped with the likely rule named. A run still
  // recording is copied once it has ended.
  router.get('/runs/:id/export', async (r) => {
    const store = ctx.store;
    const run = lookupRun(store, r.params.id!);
    if (!run) throw new HttpError(404, `no run ${r.params.id}`);
    if (recordingNow(store, run)) throw new HttpError(409, stillRecording(run));
    const redact = ctx.options.loadConfig ? ctx.config().redact : (ctx.options.redact ?? []);
    const runIds = withAncestors(store, run.runId);
    const version = ctx.options.version ?? null;
    const dbPath = ctx.options.dbPath;
    let out: ExportHtmlResult;
    if (dbPath && dbPath !== ':memory:') {
      try {
        out = await exportHtmlApart({ dbPath, runIds, redact, version, ...(ctx.read.prices ? { prices: ctx.read.prices } : {}), ...(ctx.options.uiDir ? { uiDir: ctx.options.uiDir } : {}) });
      } catch (err) {
        throw err instanceof ExportError ? new HttpError(err.status, err.message) : err;
      }
    } else {
      // A store with no file of its own (in memory) can't be opened from another thread.
      out = exportHtml({ store, runIds, ...ctx.read, ...(redact.length ? { redact } : {}), version, ...(ctx.options.uiDir ? { uiDir: ctx.options.uiDir } : {}) });
    }
    r.res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-disposition': `attachment; filename="shadowlap-${run.runId.slice(0, 10).toLowerCase()}.html"`,
      'x-shadowlap-redacted': redact.length ? 'yes' : 'no',
      'cache-control': 'no-store',
    });
    r.res.end(out.html);
  });
}
