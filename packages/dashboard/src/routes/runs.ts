import { addNote, callDetail, changeLabels, lineage, listRuns, lookupRun, runDetail } from '../api.js';
import type { RouteContext } from '../context.js';
import { HttpError } from '../http.js';
import type { Router } from '../router.js';
import { exportHtml, withAncestors } from '../static.js';

/** Runs: the list, one run, its calls and family, labels and notes, the HTML download, delete. */
export function register(router: Router, ctx: RouteContext): void {
  const { store } = ctx;

  router.get('/runs', (r) => r.tagged({ runs: listRuns(store, ctx.read) }));

  router.get('/runs/:id', (r) => {
    const d = runDetail(store, r.params.id!, ctx.read);
    if (!d) throw new HttpError(404, `no run ${r.params.id}`);
    r.tagged(d);
  });

  router.delete('/runs/:id', (r) => {
    const run = store.getRun(r.params.id!);
    if (!run) throw new HttpError(404, `no run ${r.params.id}`);
    if (run.status === 'running') throw new HttpError(409, 'this run is still recording');
    store.deleteRun(run.runId);
    const gc = store.gcBlobs();
    r.json({ deleted: run.runId, blobs: gc.removed, bytes: gc.bytes });
  });

  router.get('/runs/:id/calls/:n', (r) => {
    const n = Number(r.params.n);
    const d = Number.isInteger(n) ? callDetail(store, r.params.id!, n, ctx.read) : null;
    if (!d) throw new HttpError(404, `no call #${r.params.n} in run ${r.params.id}`);
    r.tagged(d);
  });

  router.get('/runs/:id/lineage', (r) => {
    const nodes = lineage(store, r.params.id!, ctx.read);
    if (!nodes) throw new HttpError(404, `no run ${r.params.id}`);
    r.tagged({ nodes });
  });

  router.post('/runs/:id/labels', async (r) => {
    const body = await r.body();
    const out = changeLabels(store, r.params.id!, body.add, body.remove);
    if ('error' in out) throw new HttpError(out.status, out.error);
    r.json(out);
  });

  router.post('/runs/:id/notes', async (r) => {
    const body = await r.body();
    const out = addNote(store, r.params.id!, body.callNo, body.text);
    if ('error' in out) throw new HttpError(out.status, out.error);
    r.json(out);
  });

  // A run as one self-contained HTML file, for sharing. A read, so a read-only dashboard offers it
  // too. Its ancestors come along so a fork still shows what it parted from, and the project's
  // redaction rules apply, exactly as `shadowlap export html --lineage` does.
  router.get('/runs/:id/export', (r) => {
    const run = lookupRun(store, r.params.id!);
    if (!run) throw new HttpError(404, `no run ${r.params.id}`);
    const redact = ctx.options.loadConfig ? ctx.config().redact : (ctx.options.redact ?? []);
    const out = exportHtml({ store, runIds: withAncestors(store, run.runId), ...ctx.read, ...(redact.length ? { redact } : {}), version: ctx.options.version ?? null, ...(ctx.options.uiDir ? { uiDir: ctx.options.uiDir } : {}) });
    r.res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-disposition': `attachment; filename="shadowlap-${run.runId.slice(0, 10).toLowerCase()}.html"`,
      'x-shadowlap-redacted': redact.length ? 'yes' : 'no',
      'cache-control': 'no-store',
    });
    r.res.end(out.html);
  });
}
