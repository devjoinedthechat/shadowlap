import { judgedAnswers, Store, type CallRecord, type DecisionJudge, type DecisionJudgeSide, type DecisionRun, type GivenAnswer, type RunRecord } from '@shadowlap/engine';
import { Sidecar } from '@shadowlap/sidecar';
import { judgeRecording } from './attempts.js';
import { judgeChecksOf, judgeLabel, type JudgeCheck, type TestSpec } from './checks.js';
import { upstreamOverrides, type ShadowlapConfig } from './config.js';
import { askPreparedJudge, heldVerdict, judgeRequestDigest, liveJudge, materialOf, prepareJudge, type JudgeMaterialSource, type JudgeRunContext, type PreparedJudge } from './judge.js';

/**
 * The decision diff's judge (`shadowlap decisions`, `migrate`). A text-only change (rank 5: the same
 * actions in other words) is counted, not judged, unless a judge check of the run reads those words:
 * one of the checks the run is judged by (its golden's from shadowlap.config.json, the tests entry
 * its recording comes from, or `--expect` with --then-verify) that reads the final answer, at the
 * run's last model call, or the run, at the last call of a conversation, whose answer no later
 * request carries (judgedAnswers). A check that reads what the agent printed reads no model call's
 * answer, and is left to verify.
 *
 * Such a check is asked about the words as recorded and the new ones, as the judge runtime asks it
 * (judge.ts): through the sidecar in the scope shadowlap:judge, at temperature 0 where the model
 * takes one, for a structured verdict, about what it reads with the project's rules applied: the run
 * as recorded, with the new answer in place of the recorded one. Each side's verdict comes from the
 * recording's own judge call for that very request when it holds one, else from an earlier ask of it
 * that a session kept, else from the judge, asked now; so asking the same again is free. Where the
 * judge can't be asked (no key, offline, the budget spent), the check is inconclusive and says why.
 *
 * The judge's calls are made in a run of their own, in a store of their own that nothing keeps: the
 * decision diff runs no agent and keeps no run. What they found is kept with the session, with each
 * request's digest (a step's `judge`), which is what answers the same request again.
 */

/** What a session kept of a judge's verdict, by the digest of the request it answered. */
interface KeptVerdict {
  verdict: 'yes' | 'no';
  reason: string;
}

const inconclusive = (reason: string, request: string | null): DecisionJudgeSide => ({ status: 'inconclusive', verdict: null, reason, source: null, cost: null, request });

const judged = (j: JudgeCheck, verdict: 'yes' | 'no', reason: string, source: NonNullable<DecisionJudgeSide['source']>, cost: number | null, request: string): DecisionJudgeSide => ({
  status: verdict === j.pass ? 'passed' : 'failed',
  verdict,
  reason: reason || 'no reason given',
  source,
  cost,
  request,
});

export class TextJudge {
  /** What judging cost, apart from asking: the judge's calls made now. */
  spent = 0;
  upstreamRequests = 0;
  readonly unknownModels = new Set<string>();
  private memory: Store | null = null;
  private sidecar: Sidecar | null = null;
  private context: Promise<JudgeRunContext> | null = null;
  private runId: string | null = null;
  /** Each request asked in this session, by digest: asked once, whichever step or sample sends it. */
  private readonly asked = new Map<string, Promise<DecisionJudgeSide>>();
  /** The verdicts earlier sessions kept, by run. */
  private readonly keptByRun = new Map<string, Map<string, KeptVerdict>>();
  private readonly upstreams: Record<string, string>;

  /**
   * `stop` says why no judge may be asked live now (Ctrl-C, the budget spent), or null; it is read
   * before each ask, with what judging has spent so far.
   */
  constructor(
    private readonly store: Store,
    private readonly config: ShadowlapConfig,
    private readonly env: NodeJS.ProcessEnv,
    private readonly stop: (judgeSpent: number) => string | null,
  ) {
    this.upstreams = upstreamOverrides(env);
  }

  /**
   * The judge checks of `spec` that read a text-only step of `run`, by the recorded model call whose
   * answer they read. A check under a `when` whose condition never held in the recording is no check
   * of the run, and reads nothing.
   */
  reads(run: RunRecord, calls: CallRecord[], spec: TestSpec | null): Map<number, JudgeCheck[]> {
    const out = new Map<number, JudgeCheck[]>();
    const judges = spec ? judgeChecksOf(spec).filter((j) => j.of !== 'output') : [];
    if (!judges.length) return out;
    const { checks } = judgeRecording(this.store, run, calls, spec, this.config.prices);
    const applies = (j: JudgeCheck) => checks.some((c) => c.label.endsWith(judgeLabel(j)) && c.status !== 'not-applicable');
    for (const of of ['answer', 'run'] as const) {
      const these = judges.filter((j) => j.of === of && applies(j));
      if (!these.length) continue;
      for (const callNo of judgedAnswers(this.store, calls, of)) out.set(callNo, [...(out.get(callNo) ?? []), ...these]);
    }
    return out;
  }

  /** The judge checks that read what the agent printed: they read no step. */
  static readsOutput(spec: TestSpec | null): JudgeCheck[] {
    return spec ? judgeChecksOf(spec).filter((j) => j.of === 'output') : [];
  }

  /** A check's verdict on the recorded words of the step at `callNo` and on the new ones, `answer`. */
  async compare(run: RunRecord, calls: CallRecord[], j: JudgeCheck, callNo: number, answer: GivenAnswer): Promise<DecisionJudge> {
    const recordedMaterial = materialOf(this.store, run.runId, null, this.config.clock, calls);
    const recorded = await this.side(run, calls, j, recordedMaterial);
    const now = await this.side(run, calls, j, { ...recordedMaterial, answers: new Map([[callNo, answer]]) });
    const changed = recorded.status === 'inconclusive' || now.status === 'inconclusive' ? null : recorded.status !== now.status;
    return { name: j.name, of: j.of === 'run' ? 'run' : 'answer', model: j.model, pass: j.pass, recorded, now, changed };
  }

  /** One side's verdict: the request is asked once in a session, and what an earlier ask found is free. */
  private side(run: RunRecord, calls: CallRecord[], j: JudgeCheck, material: JudgeMaterialSource): Promise<DecisionJudgeSide> {
    const prepared = prepareJudge(this.store, j, material, { redact: this.config.redact, normalize: this.config.normalize });
    if ('why' in prepared) return Promise.resolve(inconclusive(`not judged: ${prepared.why}`, null));
    const request = judgeRequestDigest(prepared.request);
    const had = this.asked.get(request);
    // Asked already in this session: the same verdict again, for nothing.
    if (had) return had.then((s) => (s.source === 'live' ? { ...s, source: 'kept', cost: 0 } : s));
    const asking = this.ask(run, calls, j, material, prepared, request);
    this.asked.set(request, asking);
    return asking;
  }

  private async ask(run: RunRecord, calls: CallRecord[], j: JudgeCheck, material: JudgeMaterialSource, prepared: PreparedJudge, request: string): Promise<DecisionJudgeSide> {
    // The recording's own judge call for this very request, compared as a replay compares it.
    const held = heldVerdict(this.store, calls, j, { material, redact: this.config.redact, normalize: this.config.normalize, redactions: run.meta?.redactions ?? [] });
    if (held) return judged(j, held.verdict, held.reason, 'recording', 0, request);
    const kept = this.kept(run.runId).get(request);
    if (kept) return judged(j, kept.verdict, kept.reason, 'kept', 0, request);
    const stopped = this.stop(this.spent);
    if (stopped) return inconclusive(`not judged: ${stopped}`, request);
    const live = liveJudge(prepared.target.provider, this.upstreams, this.env);
    if ('why' in live) return inconclusive(`not judged: no recorded verdict and ${live.why}`, request);
    let ctx: JudgeRunContext;
    try {
      ctx = await this.open();
    } catch (err) {
      return inconclusive(`not judged: the judge's sidecar could not start: ${(err as Error).message}`, request);
    }
    const v = await askPreparedJudge(j, prepared, ctx);
    if ('why' in v) return inconclusive(`not judged: ${v.why}`, request);
    if (typeof v.cost === 'number') this.spent += v.cost;
    return judged(j, v.verdict, v.reason, v.source === 'recording' ? 'recording' : 'live', v.cost ?? null, request);
  }

  /** The verdicts the sessions that asked `runId` before kept, by the digest of their request. */
  private kept(runId: string): Map<string, KeptVerdict> {
    let found = this.keptByRun.get(runId);
    if (found) return found;
    found = new Map();
    for (const row of this.store.decisionsOfRun(runId, 20)) {
      const decisions = (row.data as Partial<DecisionRun>).decisions;
      for (const step of Array.isArray(decisions) ? decisions : []) {
        for (const j of Array.isArray(step.judge) ? step.judge : []) {
          for (const side of [j.recorded, j.now]) {
            if (side?.request && (side.verdict === 'yes' || side.verdict === 'no') && !found.has(side.request)) found.set(side.request, { verdict: side.verdict, reason: typeof side.reason === 'string' ? side.reason : '' });
          }
        }
      }
    }
    this.keptByRun.set(runId, found);
    return found;
  }

  /** The sidecar the judge's calls go through, and the run they are made in, opened once, when the first is asked. */
  private open(): Promise<JudgeRunContext> {
    this.context ??= (async () => {
      const memory = Store.open(':memory:');
      this.memory = memory;
      const run = memory.createRun({ mode: 'record', command: { argv: [], cwd: process.cwd() } });
      memory.endRun(run.runId, 'completed');
      this.runId = run.runId;
      this.sidecar = await Sidecar.start({ store: memory, normalizers: this.config.normalize, upstreams: this.upstreams, ...(this.config.prices ? { prices: this.config.prices } : {}), ...(this.config.http ? { http: this.config.http } : {}) });
      this.sidecar.openForJudge(run.runId);
      return { sidecar: this.sidecar, store: memory, runId: run.runId, upstreams: this.upstreams, env: this.env, redact: this.config.redact, normalize: this.config.normalize, ...(this.config.prices ? { prices: this.config.prices } : {}) };
    })();
    return this.context;
  }

  /** Closes the judge's sidecar and its store, and takes what its calls did and cost. */
  async close(): Promise<void> {
    try {
      await this.context?.catch(() => null);
      const made = this.sidecar && this.runId ? this.sidecar.closeForJudge(this.runId) : null;
      if (made) {
        this.spent = made.spent;
        this.upstreamRequests = made.upstreamRequests;
        for (const m of made.unknownModels) this.unknownModels.add(m);
      }
    } finally {
      await this.sidecar?.close();
      this.memory?.close();
      this.sidecar = null;
      this.memory = null;
      this.context = null;
      this.runId = null;
    }
  }
}
