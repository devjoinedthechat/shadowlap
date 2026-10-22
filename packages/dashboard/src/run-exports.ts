import { lstatSync, mkdirSync, readdirSync, realpathSync, type Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DATASET_FORMATS, REDACTION_EXPORTS, type Normalizer, type RedactionExport, type RunRecord, type Store } from '@shadowlap/engine';
import { lookupRun } from './api.js';
import type { JobBuildResult, ProjectInfo } from './jobs.js';

/**
 * The run page's Share menu as dashboard jobs: the run as an HTML file, a pack, an eval dataset, an
 * OpenTelemetry trace and a HAR. Each builder checks what the browser sent and returns the CLI's
 * arguments; nothing it sent becomes an argument as it is. What a job writes goes into the project
 * folder, under `.shadowlap/exports/` unless a pack names another folder there (decision 5): the
 * drawer names the file, and HTML and HAR also download. A run still recording is copied once it has
 * ended (one its process left marked running was interrupted, and is copied as it is), and a file a
 * copy would write through a link (or over a folder) is refused.
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

/** Why a run can't be copied yet: it is still recording, and a copy of it would never end. */
export const stillRecording = (run: Pick<RunRecord, 'runId'>) => `${run.runId.slice(0, 10)} is still recording: copy it once it has ended`;

/**
 * Whether a process is still recording the run, as the CLI asks before it copies one. A run its
 * process left marked running was interrupted, as every list shows it: nothing will add to it, so it
 * is copied as it is.
 */
export function recordingNow(store: Store, run: Pick<RunRecord, 'runId' | 'status'>): boolean {
  return run.status === 'running' && store.recordingRuns().live.some((r) => r.run.runId === run.runId);
}

function runOf(store: Store, raw: unknown): { runId: string } | { error: string; status?: number } {
  const run = typeof raw === 'string' && raw ? lookupRun(store, raw) : null;
  if (!run) return { error: typeof raw === 'string' && raw ? `no run ${raw.slice(0, 40)}` : 'runId is required', status: typeof raw === 'string' && raw ? 404 : 400 };
  if (recordingNow(store, run)) return { error: stillRecording(run), status: 409 };
  return { runId: run.runId };
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

/** Whether something is at a path, a link that leads nowhere included. */
function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * A path inside the project as it really is, relative to the project folder and `/`-separated: the
 * part of it that exists resolved through links, and to the case its names have on disk; the rest
 * as typed. Null when the part that exists can't be resolved (a link that leads nowhere).
 */
export function realRelative(root: string, path: string): string | null {
  let at = resolve(root, path);
  const rest: string[] = [];
  while (!present(at)) {
    const up = dirname(at);
    if (up === at) return null;
    rest.unshift(basename(at));
    at = up;
  }
  try {
    return relative(realpathSync.native(root), join(realpathSync.native(at), ...rest)).split(sep).join('/');
  } catch {
    return null;
  }
}

/**
 * Whether a path is inside the project folder, following links on the part of it that exists: a
 * folder that is a link out of the project is outside, however the path reads, and so is a link
 * that leads nowhere.
 */
export function insideProject(root: string, path: string): boolean {
  const rel = realRelative(root, path);
  return rel !== null && (rel === '' || (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel)));
}

/** macOS and Windows file systems take `.Shadowlap` for `.shadowlap`. */
const FOLD_CASE = process.platform === 'darwin' || process.platform === 'win32';
const folded = (p: string) => (FOLD_CASE ? p.toLowerCase() : p);

/** Whether a project-relative path (`/`-separated) is the store's own folder or inside it, its exports folder aside. */
export function inStoreFolder(rel: string): boolean {
  const p = folded(rel);
  const store = folded(dirname(EXPORTS_DIR));
  return p === store || (p.startsWith(`${store}/`) && !p.startsWith(`${folded(EXPORTS_DIR)}/`));
}

/**
 * Why a copy can't write a file where it would: something is there already that is a link, which
 * the CLI would write through to wherever it leads, or not a file. Null when nothing is there or a
 * file is, which the copy replaces.
 */
export function unsafeFile(root: string, rel: string): string | null {
  let st: Stats;
  try {
    st = lstatSync(join(root, rel));
  } catch {
    return null;
  }
  if (st.isSymbolicLink()) return `${rel} is a link, and a copy is never written through one: remove it, or use another name`;
  if (!st.isFile()) return `${rel} is there already, and it is not a file`;
  return null;
}

/** Why a pack can't be written into a folder: a file it would write (run.json, calls.jsonl, a blob) is a link or not a file. */
export function unsafePack(root: string, folder: string): string | null {
  for (const name of ['run.json', 'calls.jsonl']) {
    const why = unsafeFile(root, `${folder}/${name}`);
    if (why) return why;
  }
  const blobs = `${folder}/blobs`;
  let st: Stats;
  try {
    st = lstatSync(join(root, blobs));
  } catch {
    return null;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return `${blobs} is there already, and it is not a folder of its own`;
  for (const name of readdirSync(join(root, blobs))) {
    const why = unsafeFile(root, `${blobs}/${name}`);
    if (why) return why;
  }
  return null;
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

/** The exports folder made, and the file a copy writes into it checked: its path from the project folder, or why not. */
function exportTarget(root: string, file: string): string | { error: string; status: number } {
  const dir = exportsDir(root);
  if (typeof dir !== 'string') return dir;
  const rel = `${EXPORTS_DIR}/${file}`;
  const why = unsafeFile(root, rel);
  return why ? { error: why, status: 409 } : rel;
}

/** `export html <run> .shadowlap/exports/shadowlap-<id>.html --lineage`: the views in one file, with the runs it came from. */
export function exportHtmlJob(store: Store, project: ProjectInfo | null, req: Record<string, unknown>): Built {
  const run = runOf(store, req.runId);
  if ('error' in run) return run;
  const root = projectRoot(project);
  if (typeof root !== 'string') return root;
  const target = exportTarget(root, `shadowlap-${short(run.runId)}.html`);
  if (typeof target !== 'string') return target;
  return { args: ['export', 'html', run.runId, target, '--lineage'], runId: run.runId, title: 'Exporting HTML' };
}

/** `export har <run> .shadowlap/exports/<id>.har`: the model calls, with every redaction rule applied. */
export function exportHarJob(store: Store, project: ProjectInfo | null, req: Record<string, unknown>): Built {
  const run = runOf(store, req.runId);
  if ('error' in run) return run;
  const root = projectRoot(project);
  if (typeof root !== 'string') return root;
  const target = exportTarget(root, `${short(run.runId)}.har`);
  if (typeof target !== 'string') return target;
  return { args: ['export', 'har', run.runId, target], runId: run.runId, title: 'Exporting HAR' };
}

/**
 * A folder for a pack, as typed: relative to the project folder and inside it, and not the store's
 * own folder, however its name is cased or whatever link leads there. Returned as `./…` so the CLI
 * can never read it as an option.
 */
export function packFolder(root: string, raw: unknown): string | { error: string } {
  if (typeof raw !== 'string' || !raw.trim()) return { error: 'name a folder for the pack' };
  const dir = raw.trim().replace(/\\/g, '/');
  if (dir.length > 200 || dir.includes('\0') || /[\u0000-\u001f]/.test(dir)) return { error: 'that is not a folder name' };
  if (isAbsolute(dir) || /^[A-Za-z]:/.test(dir)) return { error: 'name a folder inside the project, such as share/run or goldens/refund' };
  const rel = relative(root, resolve(root, dir)).split(sep).join('/');
  if (!rel || rel === '..' || rel.startsWith('../')) return { error: 'name a folder inside the project, such as share/run or goldens/refund' };
  const real = realRelative(root, rel);
  if (inStoreFolder(rel) || (real !== null && inStoreFolder(real))) return { error: `the store's own folder takes no packs: use ${EXPORTS_DIR}/ or a folder of your own` };
  if (!insideProject(root, rel)) return { error: 'that folder leads outside the project' };
  return `./${rel}`;
}

/** A pack's folder checked, and `.shadowlap/exports/` made when it is in there: `./…`, or why it can't be written. */
function packTarget(root: string, raw: unknown): string | { error: string; status?: number } {
  const folder = packFolder(root, raw);
  if (typeof folder !== 'string') return folder;
  if (folder.startsWith(`./${EXPORTS_DIR}/`)) {
    const dir = exportsDir(root);
    if (typeof dir !== 'string') return dir;
  }
  const unsafe = unsafePack(root, folder.slice(2));
  return unsafe ? { error: unsafe, status: 409 } : folder;
}

/**
 * `pack <run> <folder>`: a folder to commit as a golden or hand to someone, redacted. Given `runIds`
 * (the Runs page's bulk Pack), `dir` is the folder that holds a folder per run (`packFolders`), and
 * the job runs one `pack` after another, so its drawer lists every folder it wrote.
 */
export function packJob(store: Store, project: ProjectInfo | null, req: Record<string, unknown>): Built {
  if (req.runIds !== undefined) return packRunsJob(store, project, req);
  const run = runOf(store, req.runId);
  if ('error' in run) return run;
  const root = projectRoot(project);
  if (typeof root !== 'string') return root;
  const folder = packTarget(root, req.dir ?? `${EXPORTS_DIR}/${short(run.runId)}`);
  if (typeof folder !== 'string') return folder;
  return { args: ['pack', run.runId, folder], runId: run.runId, title: 'Packing' };
}

const RUN_ID = /^[0-9A-Za-z]{1,26}$/;

/** The most runs one Pack job takes: each is a command of its own, and its drawer lists every folder (ui/runspage/bulk.ts `PACK_MAX`). */
export const MAX_PACK_RUNS = 100;

/**
 * Where each run of a bulk Pack goes, inside `dir`: a folder named by the first ten characters of its
 * id in lower case, as one run's pack is named (`.shadowlap/exports/01k5cq4n7g`), or by its whole id
 * where two of the runs share those ten (runs started in the same millisecond). The bulk bar's
 * dialog shows the same names (ui/runspage/bulk.ts `packFolders`).
 */
export function packFolders(runIds: readonly string[], dir: string): Array<{ runId: string; folder: string }> {
  const parent = dir.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  const shorts = runIds.map(short);
  return runIds.map((runId, i) => ({ runId, folder: `${parent}/${shorts.indexOf(shorts[i]!) === shorts.lastIndexOf(shorts[i]!) ? shorts[i] : runId.toLowerCase()}` }));
}

/** Several runs packed by one job, each into its own folder inside `dir` (`.shadowlap/exports` unless asked). */
function packRunsJob(store: Store, project: ProjectInfo | null, req: Record<string, unknown>): Built {
  const raw = Array.isArray(req.runIds) ? req.runIds : [];
  if (!raw.length) return { error: 'name the runs to pack' };
  if (raw.length > MAX_PACK_RUNS) return { error: `at most ${MAX_PACK_RUNS} runs in one pack job` };
  const runIds: string[] = [];
  for (const r of raw) {
    if (typeof r !== 'string' || !RUN_ID.test(r)) return { error: 'a run id is not one' };
    const run = runOf(store, r);
    if ('error' in run) return run;
    if (!runIds.includes(run.runId)) runIds.push(run.runId);
  }
  const root = projectRoot(project);
  if (typeof root !== 'string') return root;
  const dir = req.dir ?? EXPORTS_DIR;
  if (typeof dir !== 'string' || !dir.trim()) return { error: 'name a folder for the packs' };
  const commands: string[][] = [];
  for (const { runId, folder } of packFolders(runIds, dir)) {
    const target = packTarget(root, folder);
    if (typeof target !== 'string') return target;
    commands.push(['pack', runId, target]);
  }
  const [first, ...rest] = commands;
  return { args: first!, ...(rest.length ? { then: rest } : {}), runId: runIds.length === 1 ? runIds[0]! : null, title: runIds.length === 1 ? 'Packing' : `Packing ${runIds.length} runs` };
}

/** The most runs one dataset takes: the Runs page's bulk bar offers Dataset up to this many (ui/runspage/bulk.ts). */
export const MAX_DATASET_RUNS = 500;

/** A file name of the dataset: one run's id, or how many runs and when (the dialog names it the same way, ui/run/share.ts `datasetFile`). */
function datasetName(runIds: readonly string[], now: Date): string {
  if (runIds.length === 1) return `dataset-${short(runIds[0]!)}.jsonl`;
  const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  return `dataset-${runIds.length}-runs-${stamp}.jsonl`;
}

/** A file name the dialog chose for a copy in `.shadowlap/exports/`: letters, digits, `.`, `-` and `_`, or null. */
function exportFile(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  return /^[A-Za-z0-9_][\w.-]{0,99}$/.test(name) ? name : null;
}

/**
 * `export dataset <runs…> --calls final|model --format …`: one JSON line per example, into
 * `.shadowlap/exports/`, under the name the dialog shows in its command (`out`), else one of its own.
 */
export function exportDatasetJob(store: Store, project: ProjectInfo | null, req: Record<string, unknown>, now = new Date()): Built {
  const raw = Array.isArray(req.runIds) ? req.runIds : req.runId !== undefined ? [req.runId] : [];
  if (!raw.length) return { error: 'name the runs to export' };
  if (raw.length > MAX_DATASET_RUNS) return { error: `at most ${MAX_DATASET_RUNS} runs at once` };
  const runIds: string[] = [];
  for (const r of raw) {
    if (typeof r !== 'string' || !RUN_ID.test(r)) return { error: 'a run id is not one' };
    const run = lookupRun(store, r);
    if (!run) return { error: `no run ${r}`, status: 404 };
    if (recordingNow(store, run)) return { error: stillRecording(run), status: 409 };
    if (!runIds.includes(run.runId)) runIds.push(run.runId);
  }
  const format = req.format ?? 'jsonl';
  if (typeof format !== 'string' || !(DATASET_FORMATS as readonly string[]).includes(format)) return { error: `format is one of ${DATASET_FORMATS.join(', ')}` };
  const calls = req.calls ?? 'final';
  if (calls !== 'final' && calls !== 'model') return { error: 'calls is final (each run’s last model call) or model (every model call)' };
  const root = projectRoot(project);
  if (typeof root !== 'string') return root;
  const file = req.out === undefined || req.out === null || req.out === '' ? datasetName(runIds, now) : exportFile(req.out);
  if (!file) return { error: 'a file name is letters, digits, dots, dashes and underscores, such as dataset.jsonl' };
  const target = exportTarget(root, file);
  if (typeof target !== 'string') return target;
  return { args: ['export', 'dataset', ...runIds, '--calls', calls, '--format', format, '--out', target], runId: runIds.length === 1 ? runIds[0]! : null, title: 'Exporting a dataset' };
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

/**
 * `export otel <run> --endpoint <url>` to a collector, or `--out .shadowlap/exports/<file>`, which
 * sends nothing: the CLI sends to `$OTEL_EXPORTER_OTLP_ENDPOINT` only when no file is asked for.
 */
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
  const target = exportTarget(root, file);
  if (typeof target !== 'string') return target;
  return { args: ['export', 'otel', run.runId, '--out', target], runId: run.runId, title: 'Exporting a trace' };
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
