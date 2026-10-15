import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DATASET_FORMATS, REDACTION_EXPORTS, type Normalizer, type RedactionExport, type Store } from '@shadowlap/engine';
import { lookupRun } from './api.js';
import type { JobBuildResult, ProjectInfo } from './jobs.js';

/**
 * The run page's Share menu as dashboard jobs: the run as an HTML file, a pack, an eval dataset, an
 * OpenTelemetry trace and a HAR. Each builder checks what the browser sent and returns the CLI's
 * arguments; nothing it sent becomes an argument as it is. What a job writes goes into the project
 * folder, under `.shadowlap/exports/` unless a pack names another folder there (decision 5): the
 * drawer names the file, and HTML and HAR also download.
 */

/** The job kinds this module builds, by what they make. */
export const EXPORT_KINDS = {
  html: 'export-html',
  pack: 'pack',
  dataset: 'export-dataset',
  otel: 'export-otel',
  har: 'export-har',
} as const;

/** Where exports go, inside the project folder. */
export const EXPORTS_DIR = '.shadowlap/exports';

const short = (runId: string) => runId.slice(0, 10).toLowerCase();

type Built = JobBuildResult;

function runOf(store: Store, raw: unknown): { runId: string } | { error: string; status?: number } {
  const run = typeof raw === 'string' && raw ? lookupRun(store, raw) : null;
  return run ? { runId: run.runId } : { error: typeof raw === 'string' && raw ? `no run ${raw.slice(0, 40)}` : 'runId is required', status: typeof raw === 'string' && raw ? 404 : 400 };
}

/** The project folder resolved through links, or why exports can't be written. */
function projectRoot(project: ProjectInfo | null): string | { error: string; status: number } {
  if (!project) return { error: 'this dashboard has no project folder to write exports into: start it with shadowlap dashboard in the project', status: 501 };
  try {
    return realpathSync(project.path);
  } catch {
    return { error: `the project folder ${project.path} can't be read`, status: 500 };
  }
}

/**
 * Whether a path is inside the project folder, following links on the part of it that exists: a
 * folder that is a link out of the project is outside, however the path reads.
 */
export function insideProject(root: string, path: string): boolean {
  let at = resolve(root, path);
  while (!existsSync(at)) {
    const up = dirname(at);
    if (up === at) return false;
    at = up;
  }
  let real: string;
  try {
    real = realpathSync(at);
  } catch {
    return false;
  }
  const rel = relative(root, real);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/** Makes `.shadowlap/exports/` in the project, so the CLI can write a file into it. */
function exportsDir(root: string): string | { error: string; status: number } {
  const dir = join(root, EXPORTS_DIR);
  if (!insideProject(root, EXPORTS_DIR)) return { error: `${EXPORTS_DIR} leads outside the project folder`, status: 400 };
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    return { error: `could not make ${EXPORTS_DIR}: ${err instanceof Error ? err.message : String(err)}`, status: 500 };
  }
  return dir;
}

/** `export html <run> .shadowlap/exports/shadowlap-<id>.html --lineage`: the views in one file, with the runs it came from. */
export function exportHtmlJob(store: Store, project: ProjectInfo | null, req: Record<string, unknown>): Built {
  const run = runOf(store, req.runId);
  if ('error' in run) return run;
  const root = projectRoot(project);
  if (typeof root !== 'string') return root;
  const dir = exportsDir(root);
  if (typeof dir !== 'string') return dir;
  return { args: ['export', 'html', run.runId, `${EXPORTS_DIR}/shadowlap-${short(run.runId)}.html`, '--lineage'], runId: run.runId, title: 'Exporting HTML' };
}

/** `export har <run> .shadowlap/exports/<id>.har`: the model calls, with every redaction rule applied. */
export function exportHarJob(store: Store, project: ProjectInfo | null, req: Record<string, unknown>): Built {
  const run = runOf(store, req.runId);
  if ('error' in run) return run;
  const root = projectRoot(project);
  if (typeof root !== 'string') return root;
  const dir = exportsDir(root);
  if (typeof dir !== 'string') return dir;
  return { args: ['export', 'har', run.runId, `${EXPORTS_DIR}/${short(run.runId)}.har`], runId: run.runId, title: 'Exporting HAR' };
}

/**
 * A folder for a pack, as typed: relative to the project folder and inside it. Returned as `./…`
 * so the CLI can never read it as an option.
 */
export function packFolder(root: string, raw: unknown): string | { error: string } {
  if (typeof raw !== 'string' || !raw.trim()) return { error: 'name a folder for the pack' };
  const dir = raw.trim().replace(/\\/g, '/');
  if (dir.length > 200 || dir.includes('\0') || /[\u0000-\u001f]/.test(dir)) return { error: 'that is not a folder name' };
  if (isAbsolute(dir) || /^[A-Za-z]:/.test(dir)) return { error: 'name a folder inside the project, such as share/run or goldens/refund' };
  const rel = relative(root, resolve(root, dir)).split(sep).join('/');
  if (!rel || rel === '..' || rel.startsWith('../')) return { error: 'name a folder inside the project, such as share/run or goldens/refund' };
  if (rel === '.shadowlap' || (rel.startsWith('.shadowlap/') && !rel.startsWith(`${EXPORTS_DIR}/`))) return { error: `the store's own folder takes no packs: use ${EXPORTS_DIR}/ or a folder of your own` };
  if (!insideProject(root, rel)) return { error: 'that folder leads outside the project' };
  return `./${rel}`;
}

/** `pack <run> <folder>`: a folder to commit as a golden or hand to someone, redacted. */
export function packJob(store: Store, project: ProjectInfo | null, req: Record<string, unknown>): Built {
  const run = runOf(store, req.runId);
  if ('error' in run) return run;
  const root = projectRoot(project);
  if (typeof root !== 'string') return root;
  const folder = packFolder(root, req.dir ?? `${EXPORTS_DIR}/${short(run.runId)}`);
  if (typeof folder !== 'string') return folder;
  if (folder.startsWith(`./${EXPORTS_DIR}/`)) {
    const dir = exportsDir(root);
    if (typeof dir !== 'string') return dir;
  }
  return { args: ['pack', run.runId, folder], runId: run.runId, title: 'Packing' };
}

const RUN_ID = /^[0-9A-Za-z]{1,26}$/;
const MAX_DATASET_RUNS = 500;

/** A file name of the dataset: one run's id, or how many runs and when. */
function datasetName(runIds: readonly string[], now: Date): string {
  if (runIds.length === 1) return `dataset-${short(runIds[0]!)}.jsonl`;
  const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  return `dataset-${runIds.length}-runs-${stamp}.jsonl`;
}

/** `export dataset <runs…> --calls final|model --format …`: one JSON line per example, into `.shadowlap/exports/`. */
export function exportDatasetJob(store: Store, project: ProjectInfo | null, req: Record<string, unknown>, now = new Date()): Built {
  const raw = Array.isArray(req.runIds) ? req.runIds : req.runId !== undefined ? [req.runId] : [];
  if (!raw.length) return { error: 'name the runs to export' };
  if (raw.length > MAX_DATASET_RUNS) return { error: `at most ${MAX_DATASET_RUNS} runs at once` };
  const runIds: string[] = [];
  for (const r of raw) {
    if (typeof r !== 'string' || !RUN_ID.test(r)) return { error: 'a run id is not one' };
    const run = lookupRun(store, r);
    if (!run) return { error: `no run ${r}`, status: 404 };
    if (!runIds.includes(run.runId)) runIds.push(run.runId);
  }
  const format = req.format ?? 'jsonl';
  if (typeof format !== 'string' || !(DATASET_FORMATS as readonly string[]).includes(format)) return { error: `format is one of ${DATASET_FORMATS.join(', ')}` };
  const calls = req.calls ?? 'final';
  if (calls !== 'final' && calls !== 'model') return { error: 'calls is final (each run’s last model call) or model (every model call)' };
  const root = projectRoot(project);
  if (typeof root !== 'string') return root;
  const dir = exportsDir(root);
  if (typeof dir !== 'string') return dir;
  return { args: ['export', 'dataset', ...runIds, '--calls', calls, '--format', format, '--out', `${EXPORTS_DIR}/${datasetName(runIds, now)}`], runId: runIds.length === 1 ? runIds[0]! : null, title: 'Exporting a dataset' };
}

/** A collector's address: http or https, nothing the CLI could take for an option. */
export function collectorUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text || text.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString().replace(/\/$/, '') : null;
}

/** A file name for a trace, written into `.shadowlap/exports/`: letters, digits, `.`, `-` and `_`. */
export function traceFile(raw: unknown, runId: string): string | null {
  if (raw === undefined || raw === null || raw === '' || raw === true) return `${short(runId)}.otel.json`;
  if (typeof raw !== 'string') return null;
  const name = raw.trim().split(/[\\/]/).pop() ?? '';
  return /^[A-Za-z0-9_][\w.-]{0,99}$/.test(name) ? name : null;
}

/** `export otel <run> --endpoint <url>` to a collector, or `--out .shadowlap/exports/<file>`. */
export function exportOtelJob(store: Store, project: ProjectInfo | null, req: Record<string, unknown>): Built {
  const run = runOf(store, req.runId);
  if ('error' in run) return run;
  if (req.endpoint !== undefined && req.endpoint !== null && req.endpoint !== '') {
    const endpoint = collectorUrl(req.endpoint);
    if (!endpoint) return { error: 'a collector is an http or https address, such as http://localhost:4318' };
    return { args: ['export', 'otel', run.runId, '--endpoint', endpoint], runId: run.runId, title: 'Sending a trace' };
  }
  const file = traceFile(req.out, run.runId);
  if (!file) return { error: 'a file name is letters, digits, dots, dashes and underscores, such as trace.json' };
  const root = projectRoot(project);
  if (typeof root !== 'string') return root;
  const dir = exportsDir(root);
  if (typeof dir !== 'string') return dir;
  return { args: ['export', 'otel', run.runId, '--out', `${EXPORTS_DIR}/${file}`], runId: run.runId, title: 'Exporting a trace' };
}

// ---- what each copy applies (decision 6) -----------------------------------------------------------

export type CopyFormat = 'html' | 'pack' | 'dataset' | 'otel' | 'har';

export interface CopyRules {
  /** The project's redaction rules. */
  total: number;
  /** Of those, the rules without a path, which apply to any string. */
  pathless: number;
  /** For each copy the Share menu makes: which rules apply (as REDACTION_EXPORTS says) and how many. */
  formats: Array<{ id: CopyFormat; applies: RedactionExport['applies']; rules: number }>;
}

const SHARED: readonly CopyFormat[] = ['html', 'pack', 'dataset', 'otel', 'har'];

/**
 * How many of the project's redaction rules each copy applies. HTML, pack and HAR apply every rule;
 * a dataset applies them to the conversations and answers it keeps, path rules on their message
 * fields; a trace carries no prompt text, so only the rules without a path apply, to the names,
 * command line and errors it keeps.
 */
export function copyRules(rules: readonly Normalizer[]): CopyRules {
  const pathless = rules.filter((r) => r.path === undefined).length;
  const formats = SHARED.map((id) => {
    const applies = REDACTION_EXPORTS.find((e) => e.id === id)?.applies ?? 'all';
    return { id, applies, rules: applies === 'attributes' ? pathless : rules.length };
  });
  return { total: rules.length, pathless, formats };
}
