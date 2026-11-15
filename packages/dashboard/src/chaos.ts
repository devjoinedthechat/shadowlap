import { CHAOS_PRESETS, isChaosPreset, JUDGED_FROM, keptGate, keptPresetBound, messageOf, parsePresets, PRESET_LABELS, quoteArgv, recorderGone, recordingRule, type ChaosJudge, type ChaosResult, type ChaosResultData, type ChaosSession, type ChaosVerdict, type RunRecord, type StoreOf } from '@shadowlap/engine';

/**
 * Error-path presets as the dashboard shows them: the results `test --chaos` and `replay --chaos`
 * kept in the store, as a matrix per recording (preset × outcome, the injection matrix's layout),
 * newest result of each preset first. The fork menu's Run error-path presets and a Tests row start
 * the job (`chaos`); the CLI builds every attempt.
 */

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
  /**
   * Each attempt's run, open one to see the error path the agent took, with its verdict: inconclusive
   * when it said nothing of that path (the replay never reached the call, or only a check no attempt
   * can decide kept it from passing), never failed. `reason` says why one failed (the check, or the
   * agent's exit with its last line) or why it couldn't say; null for one that passed, or one kept
   * before attempts kept why.
   */
  runs: Array<{ runId: string; verdict: AttemptVerdict; passed: boolean; exitCode: number; reason: string | null }>;
  gate: Record<string, unknown> | null;
  /** Under a sequential gate, its bound beside the tally, as the CLI printed it: `rate >= 0.43 (95%)`; else null. */
  bound: string | null;
  /** What its attempts spent, and the requests they sent upstream. */
  spent: number;
  upstreamRequests: number;
  at: number;
  sessionId: string;
}

/** A golden's presets (or a run's, for replay --chaos): one cell per preset that has run on it, in the presets' order. */
export interface ChaosMatrix {
  /** The recording the presets forked: a golden's run, or the run they were run on. */
  runId: string;
  golden: string | null;
  cells: ChaosCell[];
  /** When the newest of them ran. */
  at: number;
  counts: { passed: number; failed: number; inconclusive: number; notApplicable: number };
  /** The newest session's command, `shadowlap replay … --chaos`; null once the store no longer holds that session. */
  command: string | null;
  /** The gate that decided them, stated once (`gate: tells 90%+ from 70%- …`), or null when none did. */
  rule: string | null;
  /**
   * What judged every attempt besides the agent exiting 0 and where it came from (`from`, in the CLI's
   * words), as the newest result kept it; one kept before results kept it gives its last attempt's
   * checks, with no source.
   * Null when no attempt ran.
   */
  judge: { source: ChaosJudge['source'] | null; checks: string[]; from: string | null } | null;
  /** What every attempt spent, and the requests they sent upstream. */
  spent: number;
  upstreamRequests: number;
  /** The tool call the tool presets hit, or null when none did. */
  toolCall: { name: string; callNo: number } | null;
}

const order = (preset: string) => {
  const i = (CHAOS_PRESETS as readonly string[]).indexOf(preset);
  return i < 0 ? CHAOS_PRESETS.length : i;
};

type AttemptVerdict = Exclude<ChaosVerdict, 'not-applicable'>;
type KeptAttempt = NonNullable<ChaosResultData['runs']>[number];

/**
 * An attempt's verdict as it was kept, or, for a result kept before attempts had one, as it was
 * decided then: one that passed passed; the last attempt of a preset inconclusive for a reason of
 * its own, which the result keeps (a gate that ran out of attempts keeps none), is the attempt that
 * never played the preset in or that a check no attempt can decide held back; any other failed.
 */
function attemptVerdict(x: KeptAttempt, r: ChaosResult, last: boolean): AttemptVerdict {
  if (x.verdict === 'passed' || x.verdict === 'failed' || x.verdict === 'inconclusive') return x.verdict;
  if (x.passed) return 'passed';
  return last && r.verdict === 'inconclusive' && typeof r.data?.reason === 'string' ? 'inconclusive' : 'failed';
}

function cellOf(r: ChaosResult): ChaosCell {
  const d = r.data ?? {};
  const runs = d.runs ?? [];
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
    runs: runs.map((x, i) => {
      const verdict = attemptVerdict(x, r, i === runs.length - 1);
      // Why it failed as the CLI prints it, the agent's last line after its exit: `the agent exited with code 1 (TimeoutError: …)`.
      const reason = verdict === 'passed' || !x.reason ? null : `${x.reason}${x.lastLine ? ` (${x.lastLine})` : ''}`;
      return { runId: x.runId, verdict, passed: x.passed, exitCode: x.exitCode, reason };
    }),
    gate: d.gate ?? null,
    bound: boundOf(r),
    spent: d.spent ?? 0,
    upstreamRequests: d.upstreamRequests ?? 0,
    at: r.at,
    sessionId: r.sessionId,
  };
}

/** A result's bound as the CLI printed it beside its tally (the engine's rule): none under a fixed count, or a gate it can't read. */
function boundOf(r: ChaosResult): string | null {
  const gate = keptGate(r.data?.gate);
  return gate ? keptPresetBound({ gate, verdict: r.verdict, reason: r.data?.reason ?? null, passes: r.passes, attempts: r.attempts, cutShort: r.data?.cutShort }) : null;
}

/** What judged a recording's presets: the newest result that ran an attempt, as it kept its judge, else its last attempt's checks. */
function judgeOf(list: readonly ChaosResult[]): ChaosMatrix['judge'] {
  const ran = [...list].sort((a, b) => b.at - a.at).find((r) => r.attempts > 0);
  if (!ran) return null;
  const judge = ran.data?.judge;
  // Where its checks came from, in the CLI's words (JUDGED_FROM), for the panel's card: none for the exit alone, or one kept before results kept it.
  if (judge) return { ...judge, from: judge.source === 'exit' ? null : JUDGED_FROM[judge.source] };
  return { source: null, checks: (ran.data?.runs?.at(-1)?.checks ?? []).map((c) => c.label), from: null };
}

/** The rule its gates decided by, stated once, in the engine's words; a gate it can't read states none. */
function ruleOf(list: readonly ChaosResult[]): string | null {
  return recordingRule(list.flatMap((r) => {
    const gate = keptGate(r.data?.gate);
    return gate ? [{ attempts: r.attempts, gate, verdict: r.verdict, reason: r.data?.reason ?? null }] : [];
  }));
}

/** A session's command as `shadowlap …`, each read once; null for one the store no longer holds. */
type CommandOf = (sessionId: string) => string | null;

function commandsOf(store: StoreOf<'chaos'>): CommandOf {
  const read = new Map<string, string | null>();
  return (sessionId) => {
    if (!read.has(sessionId)) {
      const s = store.getChaosSession(sessionId);
      read.set(sessionId, s ? quoteArgv(s.command) : null);
    }
    return read.get(sessionId) ?? null;
  };
}

/** A matrix per golden and recording: two goldens that hold the same recording have one each. */
function matrices(results: readonly ChaosResult[], commandOf: CommandOf): ChaosMatrix[] {
  const byKey = new Map<string, ChaosResult[]>();
  for (const r of results) {
    const key = `${r.golden ?? ''}\n${r.runId}`;
    const list = byKey.get(key);
    if (list) list.push(r);
    else byKey.set(key, [r]);
  }
  return [...byKey.values()]
    .map((list) => {
      const cells = list.map(cellOf).sort((a, b) => order(a.preset) - order(b.preset));
      const n = (v: ChaosVerdict) => cells.filter((c) => c.verdict === v).length;
      const at = Math.max(...cells.map((c) => c.at));
      const sum = (k: 'spent' | 'upstreamRequests') => cells.reduce((t, c) => t + c[k], 0);
      const tool = cells.find((c) => c.target?.kind === 'tool' && c.callNo !== null);
      return {
        runId: list[0]!.runId,
        golden: list[0]!.golden,
        cells,
        at,
        counts: { passed: n('passed'), failed: n('failed'), inconclusive: n('inconclusive'), notApplicable: n('not-applicable') },
        command: commandOf(cells.find((c) => c.at === at)!.sessionId),
        rule: ruleOf(list),
        judge: judgeOf(list),
        spent: sum('spent'),
        upstreamRequests: sum('upstreamRequests'),
        toolCall: tool ? { name: tool.target!.name, callNo: tool.callNo! } : null,
      };
    })
    .sort((a, b) => b.at - a.at || a.runId.localeCompare(b.runId) || (a.golden ?? '').localeCompare(b.golden ?? ''));
}

/**
 * Whether a session of presets that hasn't ended is running now: the process the store names for it
 * is still there (on this machine; elsewhere, it was heard from lately: its newest result, else its
 * start), as for a test session. One whose process was killed, or that names none, did not finish.
 */
export function chaosSessionLive(store: StoreOf<'chaos'>, s: ChaosSession): boolean {
  if (s.endedAt !== null) return false;
  const owner = store.chaosSessionOwner(s.sessionId);
  return owner !== null && !recorderGone(owner, store.listChaosResults({ sessionId: s.sessionId, limit: 1 })[0]?.at ?? s.startedAt);
}

/**
 * The newest session of presets on goldens (`test --chaos`) running now, wherever it was started (a
 * terminal, another dashboard, a job), or null. It replays the goldens' packs, so while it runs the
 * jobs that replay or rewrite them wait, as they wait for a test session. Presets on a run (`replay
 * --chaos`) touch no golden.
 */
export function liveChaosSession(store: StoreOf<'chaos'>): ChaosSession | null {
  for (const s of store.listChaosSessions({ limit: 20 })) if (s.endedAt === null && onGoldens(s) && chaosSessionLive(store, s)) return s;
  return null;
}

/** A session's command as the CLI keeps it: `shadowlap test …` runs the presets on goldens, `shadowlap replay …` on a run. */
const onGoldens = (s: ChaosSession): boolean => s.command[1] === 'test';

/** A session's results on one recording (every session's, under an empty session id), read once for every attempt of a family that asks. */
type SessionResults = Map<string, ChaosResult[]>;

function sessionResults(store: StoreOf<'chaos'>, sessionId: string, runId: string, read: SessionResults): ChaosResult[] {
  const key = `${sessionId}\n${runId}`;
  let list = read.get(key);
  if (!list) read.set(key, (list = store.listChaosResults(sessionId ? { sessionId, runId } : { runId })));
  return list;
}

/**
 * The results a preset's attempt was decided in: those of its own session (`meta.chaos.session`) on
 * its recording, for the golden it ran for, so an attempt keeps its preset's verdict after the
 * presets run again; else those of whichever session's result lists it. Empty for a run no preset
 * made, or one no kept result lists.
 */
function attemptResults(store: StoreOf<'chaos'>, run: RunRecord, read: SessionResults = new Map()): ChaosResult[] {
  const chaos = run.meta?.chaos;
  if (!chaos || !run.parentRunId) return [];
  const golden = typeof chaos.golden === 'string' ? chaos.golden : null;
  const lists = (r: ChaosResult) => r.golden === golden && (r.data?.runs ?? []).some((x) => x.runId === run.runId);
  const ofSession = (sessionId: string) => sessionResults(store, sessionId, run.parentRunId!, read).filter((r) => r.golden === golden);
  const own = typeof chaos.session === 'string' && chaos.session ? ofSession(chaos.session) : [];
  if (own.some(lists)) return own;
  const kept = sessionResults(store, '', run.parentRunId, read).find(lists);
  return kept ? ofSession(kept.sessionId) : [];
}

/**
 * The presets matrix of one run: the run's own when presets ran on it (the newest, when goldens that
 * hold the same recording each have one); for a preset's attempt, the matrix of the session it was
 * decided in, on its recording (an attempt opens on its recording's matrix as that session left it),
 * else the recording's newest. Null when no preset has run on either.
 */
export function chaosOfRun(store: StoreOf<'recording' | 'chaos'>, runId: string): ChaosMatrix | null {
  const run = store.getRun(runId);
  if (!run) return null;
  const commandOf = commandsOf(store);
  const own = matrices(store.latestChaosResults(run.runId), commandOf)[0];
  if (own) return own;
  const chaos = run.meta?.chaos;
  if (!chaos || !run.parentRunId) return null;
  const decided = matrices(attemptResults(store, run), commandOf)[0];
  if (decided) return decided;
  const golden = typeof chaos.golden === 'string' ? chaos.golden : null;
  return matrices(store.latestChaosResults(run.parentRunId).filter((r) => r.golden === golden), commandOf)[0] ?? null;
}

/** How a preset's attempt came out, by its preset's verdict, as a family's tree marks it. */
export interface PresetMark {
  /** The preset in words: `tool timeout`. */
  label: string;
  verdict: AttemptVerdict;
  /** The session it was decided in, so the Forks view draws one node a session; the call it hit; the golden it ran for. */
  session: string;
  callNo: number | null;
  golden: string | null;
  /**
   * How that session's presets came out, the ones that couldn't apply too, and what its attempts
   * spent: the node's verdict and line, which the run's other attempts alone can't say.
   */
  counts: ChaosMatrix['counts'];
  spent: number;
}

/**
 * Each preset's attempt among `runs`, by the session it was decided in (attempts of earlier sessions
 * too, which the recording's newest matrix no longer lists): its preset's words and its own verdict.
 * A family's runs read each session's results once.
 */
export function presetMarks(store: StoreOf<'chaos'>, runs: readonly RunRecord[]): Map<string, PresetMark> {
  const out = new Map<string, PresetMark>();
  const read: SessionResults = new Map();
  const commandOf = commandsOf(store);
  for (const run of runs) {
    if (!run.meta?.chaos) continue;
    const m = matrices(attemptResults(store, run, read), commandOf)[0];
    for (const c of m?.cells ?? []) {
      const x = c.runs.find((a) => a.runId === run.runId);
      if (x) out.set(run.runId, { label: c.label, verdict: x.verdict, session: c.sessionId, callNo: c.callNo, golden: m!.golden, counts: m!.counts, spent: m!.spent });
    }
  }
  return out;
}

/** How a golden's presets came out, as Tests' row and Needs a look say it. */
export interface PresetsSummary {
  /** Failed when one failed; else inconclusive when one couldn't say; else passed. */
  verdict: 'passed' | 'failed' | 'inconclusive';
  /** The presets that ran (a preset that couldn't apply to the recording ran nothing), and how they came out. */
  ran: number;
  passed: number;
  failed: number;
  inconclusive: number;
  /** `2 of 4 presets failed: tool timeout #2, provider 429 #3 · 1 inconclusive`, `4 of 4 presets passed`. */
  line: string;
  /** The first attempt that failed (or couldn't say), else the newest preset's, to open. */
  runId: string | null;
  at: number;
  /** The recording they ran on, whose page opens with their results. */
  recording: string;
  /**
   * Every preset, in the presets' order, one that couldn't apply included: Tests' strip draws a cell of
   * each (muted for that one), its card its verdict, its tally, the call it hit, and `why`: why it
   * couldn't apply, failed or couldn't say, null for one that passed.
   */
  cells: Array<Pick<ChaosCell, 'label' | 'verdict' | 'passes' | 'attempts' | 'callNo'> & { why: string | null }>;
}

/**
 * Why a preset couldn't apply, failed or couldn't say: for one that couldn't apply, its detail as the
 * CLI keeps it (the call it would hit, then why, or why alone where there was none to hit); else its
 * reason. Null for one that passed.
 */
const cellWhy = (c: Pick<ChaosCell, 'verdict' | 'detail' | 'reason'>): string | null => (c.verdict === 'passed' ? null : c.verdict === 'not-applicable' ? c.detail || null : c.reason);

/** A preset as a line names it: `tool timeout #2`. */
const presetWords = (c: ChaosCell) => `${c.label}${c.callNo !== null ? ` #${c.callNo}` : ''}`;

/** A matrix in a line, by how its presets came out; null when none ran (every one was not applicable). */
export function presetsSummary(m: ChaosMatrix, kept: (runId: string) => boolean = () => true): PresetsSummary | null {
  const ran = m.cells.filter((c) => c.verdict !== 'not-applicable');
  if (!ran.length) return null;
  const failed = ran.filter((c) => c.verdict === 'failed');
  const unsure = ran.filter((c) => c.verdict === 'inconclusive');
  const shown = failed.length ? failed : unsure;
  const verdict = failed.length ? 'failed' : unsure.length ? 'inconclusive' : 'passed';
  const n = (x: number) => `${x} of ${ran.length} preset${ran.length === 1 ? '' : 's'}`;
  const line = shown.length ? `${n(shown.length)} ${verdict}: ${shown.map(presetWords).join(', ')}${failed.length && unsure.length ? ` · ${unsure.length} inconclusive` : ''}` : `${n(ran.length)} passed`;
  const open = [...shown, ...ran].flatMap((c) => c.runs.filter((x) => !shown.length || x.verdict !== 'passed').map((x) => x.runId)).find(kept) ?? null;
  const cells = m.cells.map((c) => ({ label: c.label, verdict: c.verdict, passes: c.passes, attempts: c.attempts, callNo: c.callNo, why: cellWhy(c) }));
  return { verdict, ran: ran.length, passed: ran.length - failed.length - unsure.length, failed: failed.length, inconclusive: unsure.length, line, runId: open, at: m.at, recording: m.runId, cells };
}

/** Every recording's presets as their matrices, newest first, without the sessions: what Needs a look and Tests read. */
export function chaosMatrices(store: StoreOf<'chaos'>): ChaosMatrix[] {
  return matrices(store.latestChaosResults(), commandsOf(store));
}

/** The `chaos` job's presets and tool, checked: `--presets` and `--chaos-tool` for the command. */
export function chaosFlags(req: Record<string, unknown>): string[] | { error: string } {
  const out: string[] = [];
  if (req.presets !== undefined) {
    const list = Array.isArray(req.presets) && req.presets.every((p) => typeof p === 'string') ? (req.presets) : null;
    if (!list) return { error: `presets is a list of presets: ${CHAOS_PRESETS.join(', ')}` };
    try {
      out.push('--presets', parsePresets(list, 'presets').join(','));
    } catch (err) {
      return { error: messageOf(err) };
    }
  }
  if (req.tool !== undefined) {
    if (typeof req.tool !== 'string' || !/^[\w.:/-]{1,200}$/.test(req.tool)) return { error: 'tool is the name of a tool the recording calls' };
    out.push('--chaos-tool', req.tool);
  }
  return out;
}
