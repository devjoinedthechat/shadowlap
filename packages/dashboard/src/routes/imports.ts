import { isAbsolute, relative, sep } from 'node:path';
import { ACTIONS, IMPORT_FILE_FORMATS, type ImportFileFormat } from '@shadowlap/engine';
import type { RouteContext } from '../context.js';
import type { Router } from '../router.js';

/**
 * Import a capture or a trace (Runs → Import a capture): a file the browser uploaded first
 * (`POST /api/uploads`), or a trace by its id from Langfuse, LangSmith, Phoenix or Logfire. The `import` job kind runs
 * `shadowlap import <format> <file> --name=<name picked>`. It leaves out `--json`, which a job
 * needed only for the full run ids: the CLI reports each run it made by its full id on the job's
 * events pipe (and what `--json` prints, as the job's result), with a link to each, so the drawer
 * shows the CLI's own words rather than its JSON.
 * A trace is fetched by the CLI with the keys already in this machine's environment, which never
 * pass through the browser. `GET /api/imports` says whether those keys are set, and where each
 * trace store is reached, without saying what the keys are.
 */

/** The file formats `shadowlap import` reads, each its own subcommand: the CLI detects nothing. */
export const FILE_FORMATS = Object.keys(IMPORT_FILE_FORMATS) as ImportFileFormat[];
export type FileFormat = ImportFileFormat;
export const TRACE_SOURCES = ['langfuse', 'langsmith', 'phoenix', 'logfire'] as const;
export type TraceSource = (typeof TRACE_SOURCES)[number];

/** The project Phoenix files a trace under when its instrumentation names none. */
const PHOENIX_PROJECT = 'default';

/**
 * Each trace store as the CLI reaches it: its name, the variables its own SDK reads for its address
 * (the first one set wins, less a path it may carry that isn't the API's), where it is otherwise, and
 * the keys it needs, each a variable or its alternatives. Phoenix asks for a key only with
 * authentication on: the CLI sends PHOENIX_API_KEY when it is set, and goes without otherwise. A
 * Logfire read token names its region (`pylf_v1_eu_…`); one from before regions is in the US.
 */
const TRACE_HOSTS: Record<TraceSource, { name: string; env: string[]; path?: RegExp; fallback: (env: NodeJS.ProcessEnv) => string; keys: string[][]; optional?: string }> = {
  langfuse: { name: 'Langfuse', env: ['LANGFUSE_HOST', 'LANGFUSE_BASE_URL'], fallback: () => 'https://cloud.langfuse.com', keys: [['LANGFUSE_PUBLIC_KEY'], ['LANGFUSE_SECRET_KEY']] },
  langsmith: { name: 'LangSmith', env: ['LANGSMITH_ENDPOINT', 'LANGCHAIN_ENDPOINT'], fallback: () => 'https://api.smith.langchain.com', keys: [['LANGSMITH_API_KEY', 'LANGCHAIN_API_KEY']] },
  phoenix: { name: 'Phoenix', env: ['PHOENIX_ENDPOINT', 'PHOENIX_COLLECTOR_ENDPOINT', 'PHOENIX_BASE_URL'], path: /\/v1\/traces\/?$/, fallback: () => 'http://localhost:6006', keys: [], optional: 'PHOENIX_API_KEY' },
  logfire: {
    name: 'Logfire',
    env: ['LOGFIRE_BASE_URL'],
    fallback: (env) => (/^pylf_v\d+_([a-z]+)_/.exec(env.LOGFIRE_READ_TOKEN?.trim() ?? '')?.[1] === 'eu' ? 'https://logfire-eu.pydantic.dev' : 'https://logfire-us.pydantic.dev'),
    keys: [['LOGFIRE_READ_TOKEN']],
  },
};

/**
 * A trace id, checked as the CLI checks it: as Langfuse and LangSmith write them, and as
 * OpenTelemetry does (32 hex characters) for Phoenix and Logfire.
 */
const TRACE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const OTEL_TRACE_ID = /^[0-9a-f]{32}$/i;
const traceIdOk = (s: TraceSource, id: string) => (s === 'phoenix' || s === 'logfire' ? OTEL_TRACE_ID : TRACE_ID).test(id);

export interface TraceSourceView {
  /** Every key the CLI needs for it is set in the dashboard's environment (what each is, never). */
  keys: boolean;
  /** The variables that hold them, for the dialog to name: those it needs, else the one it sends when set. */
  keyNames: string[];
  /** The key is sent only when it is set: a Phoenix without authentication needs none. */
  optional?: true;
  /** Where it is reached: the variable its SDK reads, else its public API (Phoenix: this machine); never with a user name or password. */
  host: string;
  /** Phoenix: the project the CLI looks for the trace in unless told another (PHOENIX_PROJECT, then PHOENIX_PROJECT_NAME, as Phoenix's client reads them, else default). */
  project?: string;
}

/**
 * An address from the environment as the dialog shows it: a user name or password in it stays off
 * the page. The CLI refuses such an address, and says so without repeating it.
 */
function shownHost(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  if (!url.username && !url.password) return raw;
  url.username = '';
  url.password = '';
  return url.href.replace(/\/$/, '');
}

/** Whether this machine can fetch from each trace store, read from the environment the CLI's jobs get. */
export function traceSources(env: NodeJS.ProcessEnv): Record<TraceSource, TraceSourceView> {
  const set = (names: string[]) => names.some((n) => !!env[n]?.trim());
  const view = (s: TraceSource): TraceSourceView => {
    const t = TRACE_HOSTS[s];
    const named = t.env.map((n) => env[n]?.trim()).find(Boolean);
    return {
      keys: t.keys.every(set),
      keyNames: t.optional ? [t.optional] : t.keys.map((alts) => alts[0]!),
      ...(t.optional ? { optional: true as const } : {}),
      host: shownHost(named ? (t.path ? named.replace(t.path, '') : named) : t.fallback(env)),
      ...(s === 'phoenix' ? { project: env.PHOENIX_PROJECT?.trim() || env.PHOENIX_PROJECT_NAME?.trim() || PHOENIX_PROJECT } : {}),
    };
  };
  return { langfuse: view('langfuse'), langsmith: view('langsmith'), phoenix: view('phoenix'), logfire: view('logfire') };
}

/** A Phoenix project's name or id from the dialog, as the CLI takes it. Null when it isn't one. */
export function phoenixProject(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const project = raw.trim();
  return project && project.length <= 200 && !/[/?#]/.test(project) && !/[\u0000-\u001f\u007f]/.test(project) ? project : null;
}

/**
 * A trace store's address from the dialog: https (http only for this machine, as the CLI accepts
 * without --allow-http, or anywhere with `anyHttp`, for a store sent nothing secret), no credentials
 * in it. Null when it isn't one; the CLI checks it again.
 */
export function traceHost(raw: unknown, anyHttp = false): string | null {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 500) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (loopback || anyHttp))) return null;
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export function register(router: Router, ctx: RouteContext): void {
  router.get('/imports', (r) => r.json({ formats: FILE_FORMATS, traces: traceSources(process.env), uploadLimit: ctx.project && !ctx.readOnly ? ctx.uploads.maxBytes : null }));

  ctx.jobs.registerJobKind('import', {
    // A trace from a store is imported as a capture is: Activity says which it was.
    title: () => ACTIONS.importCapture.doing,
    build: (req, { upload }) => {
      const format = req.format;
      if ((TRACE_SOURCES as readonly unknown[]).includes(format)) {
        const source = format as TraceSource;
        const traceId = typeof req.traceId === 'string' ? req.traceId.trim() : '';
        if (!traceIdOk(source, traceId)) return { error: source === 'phoenix' || source === 'logfire' ? 'traceId: the trace’s id, 32 hex characters' : 'traceId: the id from the trace’s page' };
        // A Phoenix that asks for no key is read over plain http anywhere, as the CLI reads it: nothing secret travels.
        const anyHttp = source === 'phoenix' && !process.env.PHOENIX_API_KEY?.trim();
        let host: string | null = null;
        if (req.host !== undefined && req.host !== null && req.host !== '') {
          host = traceHost(req.host, anyHttp);
          if (!host) return { error: anyHttp ? 'host: an http or https address, without credentials' : 'host: an https address, without credentials (the keys come from this machine’s environment)' };
        }
        let project: string | null = null;
        if (source === 'phoenix' && req.project !== undefined && req.project !== null && req.project !== '') {
          project = phoenixProject(req.project);
          if (!project) return { error: 'project: a Phoenix project’s name or id' };
        }
        const env = traceSources(process.env)[source];
        if (!env.keys) return { error: `${TRACE_HOSTS[source].name} needs ${env.keyNames.join(' and ')} in the environment of the shadowlap dashboard process: set ${env.keyNames.length === 1 ? 'it' : 'them'} and start the dashboard again`, status: 409 };
        // The CLI goes where the environment says (its SDK's variable, else the public API) unless
        // told otherwise: a host typed in the dialog that differs from that one goes on the command
        // line, the public API included when the environment names another.
        const passHost = host && host !== (traceHost(env.host, anyHttp) ?? env.host) ? host : null;
        // So does a Phoenix project other than the one it would look in, as one argument.
        const passProject = project && project !== env.project ? project : null;
        return { args: ['import', source, traceId, ...(passHost ? ['--host', passHost] : []), ...(passProject ? [`--project=${passProject}`] : [])], opensRun: true };
      }
      if (!(FILE_FORMATS as readonly unknown[]).includes(format)) return { error: `format: one of ${[...FILE_FORMATS, ...TRACE_SOURCES].join(', ')}` };
      const file = upload(req.uploadId);
      if (!file) return { error: 'uploadId: upload the file first (POST /api/uploads), and use it for one import' };
      // The run's source is the name of the file you picked ("my capture (2).har"), not the name it
      // was kept under; a name no run's source can carry falls back to that safe one. It goes as one
      // argument, `--name=<name>`, so a file named like a flag ("--json", "-x.har") stays a name
      // whatever the parser. The job runs in the project folder: the upload is named from there
      // (`.shadowlap/uploads/…`, which reads as no option either), with forward slashes on every
      // system, as other relative paths Shadowlap shows are.
      const rel = ctx.project ? relative(ctx.project.path, file.path) : '';
      const path = rel && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel) ? rel.split(sep).join('/') : file.path;
      return { args: ['import', format as FileFormat, path, `--name=${file.original ?? file.name}`], opensRun: true };
    },
  });
}
