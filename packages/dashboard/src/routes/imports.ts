import { isAbsolute, relative, sep } from 'node:path';
import type { RouteContext } from '../context.js';
import type { Router } from '../router.js';

/**
 * Import a capture or a trace (Runs → Import a capture): a file the browser uploaded first
 * (`POST /api/uploads`), or a Langfuse or LangSmith trace by its id. The `import` job kind runs
 * `shadowlap import <format> <file>`; the CLI reports each run it made by its full id on the job's
 * events pipe, with a link to each, so the drawer shows the CLI's own words rather than its JSON.
 * A trace is fetched by the CLI with the keys already in this machine's environment, which never
 * pass through the browser. `GET /api/imports` says whether those keys are set, and where each
 * trace store is reached, without saying what the keys are.
 */

/** The file formats `shadowlap import` reads, each its own subcommand: the CLI detects nothing. */
export const FILE_FORMATS = ['har', 'nock', 'vcr', 'litellm', 'otel'] as const;
export type FileFormat = (typeof FILE_FORMATS)[number];
export const TRACE_SOURCES = ['langfuse', 'langsmith'] as const;
export type TraceSource = (typeof TRACE_SOURCES)[number];

/** Where each trace store is reached unless its own SDK's variable says otherwise (as the CLI reads them). */
const TRACE_HOSTS: Record<TraceSource, { env: string[]; fallback: string; keys: string[][] }> = {
  langfuse: { env: ['LANGFUSE_HOST', 'LANGFUSE_BASE_URL'], fallback: 'https://cloud.langfuse.com', keys: [['LANGFUSE_PUBLIC_KEY'], ['LANGFUSE_SECRET_KEY']] },
  langsmith: { env: ['LANGSMITH_ENDPOINT', 'LANGCHAIN_ENDPOINT'], fallback: 'https://api.smith.langchain.com', keys: [['LANGSMITH_API_KEY', 'LANGCHAIN_API_KEY']] },
};

/** A trace id as Langfuse and LangSmith write them, checked as the CLI checks it. */
const TRACE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;

export interface TraceSourceView {
  /** Every key the CLI reads for it is set in the dashboard's environment (what each is, never). */
  keys: boolean;
  /** The variables that hold them, for the dialog to name. */
  keyNames: string[];
  /** Where it is reached: the variable its SDK reads, else its public API. */
  host: string;
}

/** Whether this machine can fetch from each trace store, read from the environment the CLI's jobs get. */
export function traceSources(env: NodeJS.ProcessEnv): Record<TraceSource, TraceSourceView> {
  const set = (names: string[]) => names.some((n) => !!env[n]?.trim());
  const view = (s: TraceSource): TraceSourceView => {
    const t = TRACE_HOSTS[s];
    return { keys: t.keys.every(set), keyNames: t.keys.map((alts) => alts[0]!), host: t.env.map((n) => env[n]?.trim()).find(Boolean) ?? t.fallback };
  };
  return { langfuse: view('langfuse'), langsmith: view('langsmith') };
}

/**
 * A trace store's address from the dialog: https (http only for this machine, as the CLI accepts
 * without --allow-http), no credentials in it. Null when it isn't one; the CLI checks it again.
 */
export function traceHost(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 500) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null;
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export function register(router: Router, ctx: RouteContext): void {
  router.get('/imports', (r) => r.json({ formats: FILE_FORMATS, traces: traceSources(process.env), uploadLimit: ctx.project && !ctx.readOnly ? ctx.uploads.maxBytes : null }));

  ctx.jobs.registerJobKind('import', {
    title: (req) => (req.format === 'langfuse' || req.format === 'langsmith' ? 'Importing a trace' : 'Importing a capture'),
    build: (req, { upload }) => {
      const format = req.format;
      if ((TRACE_SOURCES as readonly unknown[]).includes(format)) {
        const source = format as TraceSource;
        const traceId = typeof req.traceId === 'string' ? req.traceId.trim() : '';
        if (!TRACE_ID.test(traceId)) return { error: 'traceId: the id from the trace’s page' };
        let host: string | null = null;
        if (req.host !== undefined && req.host !== null && req.host !== '') {
          host = traceHost(req.host);
          if (!host) return { error: 'host: an https address, without credentials (the keys come from this machine’s environment)' };
        }
        const env = traceSources(process.env)[source];
        if (!env.keys) return { error: `${source === 'langfuse' ? 'Langfuse' : 'LangSmith'} needs ${env.keyNames.join(' and ')} in the environment of the shadowlap dashboard process: set ${env.keyNames.length === 1 ? 'it' : 'them'} and start the dashboard again`, status: 409 };
        // The CLI goes where the environment says (its SDK's variable, else the public API) unless
        // told otherwise: a host typed in the dialog that differs from that one goes on the command
        // line, the public API included when the environment names another.
        const passHost = host && host !== (traceHost(env.host) ?? env.host) ? host : null;
        return { args: ['import', source, traceId, ...(passHost ? ['--host', passHost] : [])], opensRun: true };
      }
      if (!(FILE_FORMATS as readonly unknown[]).includes(format)) return { error: `format: one of ${[...FILE_FORMATS, ...TRACE_SOURCES].join(', ')}` };
      const file = upload(req.uploadId);
      if (!file) return { error: 'uploadId: upload the file first (POST /api/uploads), and use it for one import' };
      // The run's source is the name of the file you picked ("my capture (2).har"), not the name it
      // was kept under; a name no run's source can carry falls back to that safe one. The job runs
      // in the project folder: the upload is named from there.
      const rel = ctx.project ? relative(ctx.project.path, file.path) : '';
      const path = rel && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel) ? rel : file.path;
      return { args: ['import', format as FileFormat, path, '--name', file.original ?? file.name], opensRun: true };
    },
  });
}
