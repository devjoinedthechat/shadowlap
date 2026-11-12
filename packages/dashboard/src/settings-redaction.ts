import { REDACTION_EXPORTS, messageOf, parseRules, readConfigFile, type Normalizer, type RedactionExport, type RunAbout, type RunRecord } from '@shadowlap/engine';
import { PREVIEW_LIMITS, PreviewError, previewApart, previewHere, type KeptPreview, type PreviewLimitsConfig } from './redaction-preview.js';
import { aboutsOf } from './run-about.js';
import { loadRunIndex, type IndexedRun } from './run-index.js';
import { asksFor } from './run-stats.js';
import { type ConfigInfo, findRun, form, loadConfigFile, type RuleForm, type RuleRow, ruleRows, runLabel, type SettingsContext, SettingsRefusal, shortRun } from './settings-shared.js';

/** Settings' Redaction tab: the rules, where they apply, the runs a preview can be made for, and the preview itself. */

export interface RedactionSettings {
  config: ConfigInfo;
  rules: RuleRow[];
  form: RuleForm;
  /** Every export, pack and share link, which rules each applies and what it does with the run's details (decision 6). A push copies runs to the team store as recorded. */
  where: readonly RedactionExport[];
  /**
   * Runs a preview can be made for: every run but those still recording, newest first. The preview
   * itself is read apart (`GET /api/settings/redaction/preview`, redactionPreview), on a thread of its
   * own, so reading a long run never holds up the server. Each with its about line (decision 10)
   * where that reads none of the run's calls (a replay's, a fork's, an attempt's, an import's); a
   * recording's quotes what its user asked, which the page takes from the run list.
   */
  runs: Array<{ runId: string; label: string; about: RunAbout | null }>;
  /** The run the tab previews first: the newest that has ended, or the one asked for. */
  previewRunId: string | null;
  /** Why there is no preview to run: no run yet, the run asked for is unknown or still recording, or rules that can't be read. */
  previewError: string | null;
}

/** How many runs the preview's run picker lists. */
const PREVIEW_RUNS = 100;

/** A recording made here with `shadowlap run`: not a replay, an import, a pack or an attempt. What a copy most often carries. */
const madeHere = (r: RunRecord) => r.mode === 'record' && !r.meta?.imported && !(Array.isArray(r.meta?.covers) && r.meta.covers.length) && !r.meta?.repeat && !r.meta?.probe && !r.meta?.verify;

/**
 * The Redaction tab: the rules, where they apply, and the runs a preview can be made for. `runId`
 * picks the run to preview first; without one, the newest recording made here that has ended (what
 * a pack most often holds, rather than an import or a replay), else the newest run that has ended.
 * Nothing here reads a run's calls: the preview is read apart (redactionPreview).
 */
export function redactionSettings(ctx: SettingsContext, options: { runId?: string | null } = {}): RedactionSettings {
  const { info, file } = loadConfigFile(ctx.cwd, 'redact');
  const rows = ruleRows(file, 'redact');
  // Every run but those a process is still recording: one its process abandoned can be previewed.
  const recording = new Set(ctx.store.recordingRuns().live.map((r) => r.run.runId));
  const ended = ctx.store.listRuns(PREVIEW_RUNS * 2).filter((r) => !recording.has(r.runId));
  const listed = ended.slice(0, PREVIEW_RUNS);
  const index = loadRunIndex(ctx.store);
  const known = listed.map((r) => index.byId.get(r.runId)).filter((r): r is IndexedRun => !!r && !asksFor(r));
  const abouts = aboutsOf(ctx.store, index, known);
  const runs = listed.map((r) => ({ runId: r.runId, label: runLabel(r), about: abouts.get(r.runId) ?? null }));
  let previewRunId: string | null = (listed.find(madeHere) ?? listed[0])?.runId ?? null;
  let previewError: string | null = null;
  if (options.runId) {
    let run: RunRecord | null = null;
    try {
      run = ctx.store.findRun(options.runId);
    } catch (err) {
      previewError = messageOf(err);
    }
    if (!run) previewError ??= `no run matches ${options.runId}`;
    else if (recording.has(run.runId)) previewError = `${shortRun(run.runId)} is still recording; preview it once it has ended`;
    previewRunId = run && !previewError ? run.runId : null;
  }
  const broken = rows.find((r) => r.error);
  if (!previewError) {
    if (!previewRunId) previewError = 'Record a run first: the preview needs one to read.';
    else if (info.error) previewError = info.error;
    else if (broken) previewError = `redaction rule #${broken.n}: ${broken.error!}`;
  }
  return { config: info, rules: rows, form: form('redact'), where: REDACTION_EXPORTS, runs, previewRunId, previewError };
}

export interface RedactionPreviewView {
  run: { runId: string; label: string };
  /**
   * What `redact preview <run> --json` prints: per rule, a count and up to two samples, and what it
   * matches that a copy leaves as it is (`unmasked`, with the path rules that mask it); the run's
   * details apart. `partial` says how far a long run was read before a limit stopped it. `kept`: the
   * run's own canaries the rules would have masked, which a copy keeps and the counts leave out.
   */
  preview: KeptPreview;
  /** The command that previews the whole run in a terminal. */
  command: string;
}

/**
 * What the project's redaction rules would mask in one run, exactly as pack applies them (path
 * rules included). The rules are the file's, as the table lists them, numbered the same way. The
 * run is read apart, on a thread of its own and within limits (redaction-preview.ts), so the server
 * answers everything else meanwhile; a store with no file is read here, within the same limits.
 * Refused for a run still recording (409), a run that isn't there (404), rules that can't be read
 * (422), a rule that takes too long on one call (422), and while other previews are read or another
 * command holds the store (503).
 */
export async function redactionPreview(ctx: Pick<SettingsContext, 'store' | 'cwd' | 'dbPath'>, runRef: string, options: { signal?: AbortSignal; limits?: PreviewLimitsConfig } = {}): Promise<RedactionPreviewView> {
  const run = findRun(ctx.store, runRef);
  if (ctx.store.recordingRuns().live.some((r) => r.run.runId === run.runId)) throw new SettingsRefusal(409, `${shortRun(run.runId)} is still recording; preview it once it has ended`);
  let rules: Normalizer[];
  try {
    rules = parseRules(readConfigFile(ctx.cwd).data.redact, 'redact');
  } catch (err) {
    throw new SettingsRefusal(422, messageOf(err));
  }
  const limits = options.limits ?? PREVIEW_LIMITS;
  let preview: KeptPreview;
  try {
    preview = ctx.dbPath && ctx.dbPath !== ':memory:' ? await previewApart({ dbPath: ctx.dbPath, runId: run.runId, rules }, { limits, ...(options.signal ? { signal: options.signal } : {}) }) : previewHere(ctx.store, run.runId, rules, limits);
  } catch (err) {
    if (err instanceof PreviewError) throw new SettingsRefusal(err.status, err.message);
    throw new SettingsRefusal(422, messageOf(err));
  }
  return { run: { runId: run.runId, label: runLabel(run) }, preview, command: `shadowlap redact preview ${shortRun(run.runId)}` };
}
