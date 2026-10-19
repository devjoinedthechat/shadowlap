import { CHAOS_PRESETS, isChaosPreset, parsePresets, PRESET_LABELS, presetHits, type ChaosResult, type ChaosSession, type ChaosVerdict, type Store } from '@shadowlap/engine';

/**
 * Error-path presets as the dashboard shows them: the results `test --chaos` and `replay --chaos`
 * kept in the store, as a matrix per recording (preset × outcome, the injection matrix's layout),
 * newest result of each preset first. The fork menu's Run error-path presets and a Tests row start
 * the job (`chaos`); the CLI builds every attempt.
 */

/** A preset as the matrix lists it: its id, its words, and whether it hits a tool call or a model call. */
export interface ChaosPresetInfo {
  preset: string;
  label: string;
  hits: 'tool' | 'model';
}

/** One cell: how a preset last came out on the recording. */
export interface ChaosCell {
  preset: string;
  label: string;
  verdict: ChaosVerdict;
  /** The recording's call it hit, and what that call is. */
  callNo: number | null;
  target: { kind: string; name: string } | null;
  passes: number;
  attempts: number;
  detail: string;
  reason: string | null;
  /** Each attempt's run: open one to see the error path the agent took. */
  runs: Array<{ runId: string; passed: boolean; exitCode: number }>;
  gate: Record<string, unknown> | null;
  at: number;
  sessionId: string;
}

/** A recording's presets: one cell per preset that has run on it, in the presets' order. */
export interface ChaosMatrix {
  /** The recording the presets forked: a golden's run, or the run they were run on. */
  runId: string;
  golden: string | null;
  cells: ChaosCell[];
  /** When the newest of them ran. */
  at: number;
  counts: { passed: number; failed: number; inconclusive: number; notApplicable: number };
}

export interface ChaosSessionView {
  sessionId: string;
  startedAt: number;
  endedAt: number | null;
  command: string[];
  revision: string | null;
  actor: string | null;
  presets: string[];
  passed: number;
  failed: number;
  inconclusive: number;
  upstreamRequests: number;
  interrupted: boolean;
}

export interface ChaosView {
  presets: ChaosPresetInfo[];
  /** Every recording presets have run on, newest first. */
  matrices: ChaosMatrix[];
  /** The newest sessions, newest first. */
  sessions: ChaosSessionView[];
}

export const PRESET_INFO: ChaosPresetInfo[] = CHAOS_PRESETS.map((p) => ({ preset: p, label: PRESET_LABELS[p], hits: presetHits(p) }));

const order = (preset: string) => {
  const i = (CHAOS_PRESETS as readonly string[]).indexOf(preset);
  return i < 0 ? CHAOS_PRESETS.length : i;
};

function cellOf(r: ChaosResult): ChaosCell {
  const d = r.data ?? {};
  return {
    preset: r.preset,
    label: isChaosPreset(r.preset) ? PRESET_LABELS[r.preset] : r.preset,
    verdict: r.verdict,
    callNo: r.callNo,
    target: d.target ?? null,
    passes: r.passes,
    attempts: r.attempts,
    detail: d.detail ?? '',
    reason: d.reason ?? null,
    runs: (d.runs ?? []).map((x) => ({ runId: x.runId, passed: x.passed, exitCode: x.exitCode })),
    gate: d.gate ?? null,
    at: r.at,
    sessionId: r.sessionId,
  };
}

function matrices(results: readonly ChaosResult[]): ChaosMatrix[] {
  const byRun = new Map<string, ChaosResult[]>();
  for (const r of results) {
    const list = byRun.get(r.runId);
    if (list) list.push(r);
    else byRun.set(r.runId, [r]);
  }
  return [...byRun.entries()]
    .map(([runId, list]) => {
      const cells = list.map(cellOf).sort((a, b) => order(a.preset) - order(b.preset));
      const n = (v: ChaosVerdict) => cells.filter((c) => c.verdict === v).length;
      return {
        runId,
        golden: list.find((r) => r.golden)?.golden ?? null,
        cells,
        at: Math.max(...cells.map((c) => c.at)),
        counts: { passed: n('passed'), failed: n('failed'), inconclusive: n('inconclusive'), notApplicable: n('not-applicable') },
      };
    })
    .sort((a, b) => b.at - a.at || a.runId.localeCompare(b.runId));
}

const sessionView = (s: ChaosSession): ChaosSessionView => ({ ...s });

/** Every recording's presets, and the newest sessions. */
export function chaosView(store: Store, o: { sessions?: number } = {}): ChaosView {
  return { presets: PRESET_INFO, matrices: matrices(store.latestChaosResults()), sessions: store.listChaosSessions({ limit: o.sessions ?? 20 }).map(sessionView) };
}

/**
 * The presets matrix of one run: the run's own when presets ran on it, else that of the recording
 * it is an attempt of (a preset's attempt opens on its recording's matrix). Null when no preset has
 * run on either.
 */
export function chaosOfRun(store: Store, runId: string): ChaosMatrix | null {
  const run = store.getRun(runId);
  if (!run) return null;
  const own = matrices(store.latestChaosResults().filter((r) => r.runId === run.runId))[0];
  if (own) return own;
  if (run.meta?.chaos && run.parentRunId) return matrices(store.latestChaosResults().filter((r) => r.runId === run.parentRunId))[0] ?? null;
  return null;
}

/** A Tests row's presets: the newest matrix of a golden, by its name. */
export function chaosOfGolden(store: Store, golden: string): ChaosMatrix | null {
  return matrices(store.latestChaosResults().filter((r) => r.golden === golden))[0] ?? null;
}

/** The `chaos` job's presets and tool, checked: `--presets` and `--chaos-tool` for the command. */
export function chaosFlags(req: Record<string, unknown>): string[] | { error: string } {
  const out: string[] = [];
  if (req.presets !== undefined) {
    const list = Array.isArray(req.presets) && req.presets.every((p) => typeof p === 'string') ? (req.presets as string[]) : null;
    if (!list) return { error: `presets is a list of presets: ${CHAOS_PRESETS.join(', ')}` };
    try {
      out.push('--presets', parsePresets(list, 'presets').join(','));
    } catch (err) {
      return { error: (err as Error).message };
    }
  }
  if (req.tool !== undefined) {
    if (typeof req.tool !== 'string' || !/^[\w.:/-]{1,200}$/.test(req.tool)) return { error: 'tool is the name of a tool the recording calls' };
    out.push('--chaos-tool', req.tool);
  }
  return out;
}
