import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactRun, Store, type Normalizer, type Price, type RunRecord } from '@shadowlap/engine';
import { callDetail, compare, lineage, listRuns, runDetail } from './api.js';
import { isAttempt } from './run-cache.js';
import type { MetaView } from './views.js';

/**
 * A run as one HTML file: the dashboard's own UI with the answers it would have asked the server
 * for built in, and nothing to run. It opens from a file, an artifact store or a pull request
 * comment, on a machine that has neither Shadowlap nor the recording.
 *
 * It is a copy of recorded data, so the redaction rules in shadowlap.config.json apply by default,
 * as they do to `shadowlap pack`, and, as a pack, it leaves out who made each run. Actions, search
 * and live updates are not in an exported copy.
 */

export interface ExportHtmlOptions {
  store: Store;
  /** The runs to include; the first is the one the file opens on. */
  runIds: string[];
  prices?: Record<string, Price>;
  /** Applied to every request and response before they are embedded. */
  redact?: Normalizer[];
  version?: string | null;
  /** The built UI; defaults to dist/ui next to this module. */
  uiDir?: string;
  /** For the tests: a fixed export time. */
  now?: number;
  /**
   * Keep who made each run (`meta.author`, often a git email). A file made to be shared leaves it
   * out unless asked, as a pack does: a share inside a team that knows its authors can keep it.
   */
  keepAuthor?: boolean;
}

export interface ExportHtmlResult {
  html: string;
  runIds: string[];
  calls: number;
  redacted: boolean;
}

/** What the browser answers its own requests from: one entry per API path the UI can ask for. */
export interface StaticPayload {
  shadowlap: string | null;
  exportedAt: number;
  runIds: string[];
  redacted: boolean;
  responses: Record<string, unknown>;
}

/** Every pair is compared in the file; beyond this many runs, only each run against the first. */
const COMPARE_ALL_UPTO = 6;

/** A run record without its author. */
function withoutAuthor(run: RunRecord): RunRecord {
  if (!run.meta || !('author' in run.meta)) return run;
  const { author: _author, ...meta } = run.meta;
  return { ...run, meta };
}

/**
 * A row of the runs list or the lineage without its author, should a read model carry one: the
 * file names nobody, whatever shape the rows take.
 */
function anonymous<T extends object>(row: T): T {
  return 'author' in row ? { ...row, author: null } : row;
}

function payload(store: Store, runIds: string[], opts: { prices?: Record<string, Price>; version?: string | null; redacted: boolean; now: number; keepAuthor: boolean }): { data: StaticPayload; calls: number } {
  const read = opts.prices ? { prices: opts.prices } : {};
  const responses: Record<string, unknown> = {};
  const keep = opts.keepAuthor;
  // Every run the file holds is listed, however old, an attempt someone chose to export included.
  const runs = listRuns(store, { ...read, ids: runIds }).map((r) => (keep ? r : anonymous(r)));
  const records = runIds.map((id) => store.getRun(id)).filter((r): r is RunRecord => r !== null);
  const attempts = records.filter(isAttempt).length;
  const meta: MetaView = {
    version: opts.version ?? null,
    dbPath: null,
    actions: false,
    readOnly: true,
    readOnlyReason: 'this is an exported copy of a run: it cannot be changed from here',
    address: null,
    storeBytes: null,
    counts: { runs: records.length - attempts, attempts },
    live: [],
    jobKinds: [],
    uploadLimit: null,
    project: null,
    static: true,
    exportedAt: opts.now,
    runIds,
    redacted: opts.redacted,
  };
  responses['meta'] = meta;
  responses['runs'] = { runs };
  let calls = 0;
  for (const runId of runIds) {
    const detail = runDetail(store, runId, read);
    if (!detail) continue;
    // Only runs in the file are linked from it: a Compare or parent link to a run left out would dead-end.
    responses[`runs/${runId}`] = { ...detail, run: keep ? detail.run : withoutAuthor(detail.run), parent: detail.parent && runIds.includes(detail.parent.runId) ? detail.parent : null };
    responses[`runs/${runId}/lineage`] = { nodes: (lineage(store, runId, read) ?? []).filter((n) => runIds.includes(n.runId)).map((n) => (keep ? n : anonymous(n))) };
    for (const call of detail.calls) {
      const one = callDetail(store, runId, call.callNo, read);
      if (one) responses[`runs/${runId}/calls/${call.callNo}`] = { ...one, actions: [] };
      calls++;
    }
  }
  const pairs = runIds.length <= COMPARE_ALL_UPTO ? runIds.flatMap((a) => runIds.map((b) => [a, b] as const)) : runIds.flatMap((a) => [[a, runIds[0]!] as const, [runIds[0]!, a] as const]);
  for (const [a, b] of pairs) {
    if (a === b) continue;
    const c = compare(store, a, b);
    if (c) responses[`compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`] = c;
  }
  return { data: { shadowlap: opts.version ?? null, exportedAt: opts.now, runIds, redacted: opts.redacted, responses }, calls };
}

/** JSON and JavaScript inside a script element: only `</` can end it early. */
function inScript(text: string): string {
  return text.split('</').join('<\\/');
}

function dataUri(file: string, type: string): string {
  return `data:${type};base64,${readFileSync(file).toString('base64')}`;
}

export function exportHtml(opts: ExportHtmlOptions): ExportHtmlResult {
  const uiDir = opts.uiDir ?? fileURLToPath(new URL('../dist/ui/', import.meta.url));
  const rules = opts.redact ?? [];
  const asked = opts.runIds;
  if (!asked.length) throw new Error('nothing to export: name a run');

  // Redaction copies the runs into a scratch store, the way pack redacts what it writes.
  let store = opts.store;
  let scratch: Store | null = null;
  if (rules.length) {
    scratch = Store.open(':memory:');
    // Ancestors first: a copied run keeps its parent only when the parent is already there.
    const ordered = [...asked].sort((a, b) => depth(opts.store, a) - depth(opts.store, b));
    for (const runId of ordered) redactRun(opts.store, runId, rules, scratch);
    store = scratch;
  }
  try {
    const { data, calls } = payload(store, asked, { ...(opts.prices ? { prices: opts.prices } : {}), version: opts.version ?? null, redacted: rules.length > 0, now: opts.now ?? Date.now(), keepAuthor: opts.keepAuthor === true });
    const css = readFileSync(join(uiDir, 'assets', 'app.css'), 'utf8').replace(/url\(["']?\.\/fonts\/([\w.-]+)["']?\)/g, (_m, name: string) => `url(${dataUri(join(uiDir, 'assets', 'fonts', name), 'font/woff2')})`);
    const js = readFileSync(join(uiDir, 'assets', 'app.js'), 'utf8');
    const favicon = dataUri(join(uiDir, 'assets', 'favicon.svg'), 'image/svg+xml');
    const title = `Shadowlap · ${asked[0]!.slice(0, 10)}`;
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="content-security-policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${title}</title>
<link rel="icon" href="${favicon}" type="image/svg+xml">
<style>${inScript(css)}</style>
</head>
<body>
<div id="root"></div>
<noscript>This exported Shadowlap run needs JavaScript to draw itself.</noscript>
<script type="application/json" id="shadowlap-data">${inScript(JSON.stringify(data))}</script>
<script type="module">${inScript(js)}</script>
</body>
</html>
`;
    return { html, runIds: asked, calls, redacted: rules.length > 0 };
  } finally {
    scratch?.close();
  }
}

function depth(store: Store, runId: string): number {
  let n = 0;
  let run: RunRecord | null = store.getRun(runId);
  while (run?.parentRunId) {
    run = store.getRun(run.parentRunId);
    n++;
    if (n > 64) break;
  }
  return n;
}

/** A run and its ancestors, oldest first, for `--lineage`. */
export function withAncestors(store: Store, runId: string): string[] {
  const ids: string[] = [];
  let run: RunRecord | null = store.getRun(runId);
  while (run) {
    ids.unshift(run.runId);
    run = run.parentRunId ? store.getRun(run.parentRunId) : null;
    if (ids.length > 64) break;
  }
  return ids;
}
