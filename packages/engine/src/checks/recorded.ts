import { canonicalize } from '../canonical.js';
import { checkStatus } from '../check-status.js';
import type { ClockReference } from '../clock.js';
import { judgeAskId, judgeMaterial, judgeRequest, judgeTarget, readVerdict, type GivenAnswer } from '../judge.js';
import { isJudgeCall, judgeRules } from '../judge-scope.js';
import { loadApiRequest } from '../manifest.js';
import { applyNormalizers } from '../normalize.js';
import type { Price } from '../prices.js';
import type { Store } from '../store.js';
import type { CallRecord, Normalizer, RunRecord } from '../types.js';
import type { VerifyRole } from '../verify.js';
import { NO_OUTPUT_KEPT } from './labels.js';
import { evaluateChecks, notJudgedWhy, storedCheckInput, type EvaluateOptions, type JudgeCheckVerdict } from './evaluate.js';
import { hasChecks, judgeChecksOf, readsOutput, withoutOutput, type CheckResult, type ExpectSpec, type JudgeCheck, type TestSpec } from './grammar.js';

/**
 * A recording judged by checks from what it holds, replaying nothing: its exit status and every
 * check but those on its output, a judge check taking the verdict the recording holds for it (its own
 * judge call). `shadowlap check` judges recordings so, and so does the dashboard a run that kept no
 * verdict of its own, by its family's checks (family-checks.ts), so the two say the same. The CLI's
 * judging at runtime (asking a judge live, through the sidecar) is the CLI's own: it reads what a run
 * already holds from here.
 */

/** Judge checks judged: what `evaluateChecks` takes as `judgeVerdicts`, and why each other check got none. */
export interface Judged {
  /** The checks that got a verdict, by name. */
  verdicts: Map<string, JudgeCheckVerdict>;
  /** Why each other check got none. */
  notJudged: Map<string, string>;
}

/**
 * What `evaluateChecks` takes of judged checks: each verdict, and for each check with none, why
 * (`not judged: …`); a check the judging never reached says so as evaluate.ts words it
 * (`notJudgedWhy`).
 */
export function judgedOptions(judged: Judged | null): EvaluateOptions {
  if (!judged) return {};
  return {
    judgeVerdicts: judged.verdicts,
    judgeMissing: (j) => {
      const why = judged.notJudged.get(j.name);
      return why === undefined ? notJudgedWhy(j) : `not judged: ${why}`;
    },
  };
}

/**
 * What the material of a judge check comes from: a run's calls, what its agent printed (null for a
 * recording, which keeps none), and the dates replay matching masks in that run (matchedClockOf).
 * `answers` gives answers in place of the ones calls recorded, by call number: the decision diff's
 * new answer at a step, judged in the recorded run's state.
 */
export interface JudgeMaterialSource {
  calls: CallRecord[];
  output: string | null;
  clock?: ClockReference;
  answers?: ReadonlyMap<number, GivenAnswer>;
}

/** What a check's judge reads in `material`, with the project's rules: its redactions, then what matching masks. */
export function judgeMaterialFor(store: Store, j: JudgeCheck, material: JudgeMaterialSource, o: { redact?: readonly Normalizer[] | undefined; normalize?: readonly Normalizer[] | undefined }): ReturnType<typeof judgeMaterial> {
  return judgeMaterial(store, material.calls, j.of, { output: material.output, redact: o.redact ?? [], ...(o.normalize?.length ? { normalize: o.normalize } : {}), ...(material.clock !== undefined ? { clock: material.clock } : {}), ...(material.answers?.size ? { answers: material.answers } : {}) });
}

/**
 * A judge's request as a replay compares it with the recording's: the body as sent, with only the
 * recording's own redaction rules that reach a judge's request applied, as the sidecar's matching
 * applies them (judgeRules). Canonical text, so two compare as strings.
 */
function comparable(body: unknown, redactions: readonly Normalizer[], name: string): string {
  const rules = judgeRules(redactions);
  return canonicalize(rules.length ? applyNormalizers(body, rules, 'api', name) : body);
}

/**
 * The verdict a run already holds for a judge check: its own judge call for the same ask (question,
 * what it reads, model), the newest that got one. With `material`, only a call that sent the very
 * request the check would send now, compared as a replay compares it (under the run's own redaction
 * rules, `redactions`), so a pack never keeps a verdict its replays would not be served.
 */
export function heldVerdict(store: Store, calls: readonly CallRecord[], j: JudgeCheck, o: { material?: JudgeMaterialSource; redact?: readonly Normalizer[]; normalize?: readonly Normalizer[]; redactions?: readonly Normalizer[] } = {}): (JudgeCheckVerdict & { callNo: number }) | null {
  const ask = judgeAskId(j);
  const target = judgeTarget(j.model);
  let wanted: string | null = null;
  if (o.material && target) {
    let m: ReturnType<typeof judgeMaterial>;
    try {
      m = judgeMaterialFor(store, j, o.material, o);
    } catch {
      return null;
    }
    if ('missing' in m) return null;
    const request = judgeRequest(target, j, m);
    wanted = comparable(request.body, o.redactions ?? [], `POST ${request.path}`);
  }
  for (const c of [...calls].reverse()) {
    if (!isJudgeCall(c) || c.meta.judge?.ask !== ask || c.end?.outcome !== 'ok' || !c.end.responseRef) continue;
    if (wanted !== null) {
      let sent: unknown;
      try {
        sent = c.requestRef ? loadApiRequest(store, c.requestRef) : null;
      } catch {
        continue;
      }
      if (comparable(sent, o.redactions ?? [], c.name) !== wanted) continue;
    }
    const provider = c.end.meta.provider ?? c.meta.provider;
    const verdict = readVerdict(store.getBlob(c.end.responseRef), c.end.meta.headers?.['content-type'], typeof provider === 'string' ? provider : undefined);
    if ('error' in verdict) continue;
    return { ...verdict, source: 'recording', cost: 0, callNo: c.callNo };
  }
  return null;
}

/** Every judge check a run already holds a verdict for, as `evaluateChecks` takes them; the rest have no recorded verdict. */
export function recordedVerdicts(store: Store, calls: readonly CallRecord[], judges: readonly JudgeCheck[]): Judged {
  const out: Judged = { verdicts: new Map(), notJudged: new Map() };
  for (const j of judges) {
    const held = heldVerdict(store, calls, j);
    if (held) out.verdicts.set(j.name, held);
    else out.notJudged.set(j.name, j.of === 'output' ? 'no recorded verdict, and a recording keeps no output to judge' : 'no recorded verdict');
  }
  return out;
}

/** Why a recording can't settle checks that read what the agent printed (`judgeRecording`'s `unsettled`). */
export const READS_OUTPUT = "a check reads what the agent printed, which a recording doesn't keep";

export { NO_OUTPUT_KEPT };

/** A spec's checks on what the agent printed alone, under the `when` rules that hold them: what `withoutOutput` leaves out. */
function outputPart(spec: ExpectSpec): ExpectSpec {
  const when = (spec.when ?? []).map((w) => ({ ...w, then: outputPart(w.then) })).filter((w) => hasChecks(w.then));
  return { tools: [], ...(spec.output ? { output: spec.output } : {}), ...(when.length ? { when } : {}) };
}

/**
 * The checks on what the agent printed, which `judgeRecording` leaves out of a recording's results,
 * as they come out on one: inconclusive, for a recording keeps no output, never passed or failed.
 * Under a `when` they go as its condition has them: one whose condition never held does not apply,
 * and one whose condition can't be read is inconclusive for that.
 */
export function outputUnjudged(store: Store, calls: CallRecord[], spec: ExpectSpec): CheckResult[] {
  const part = outputPart(spec);
  if (!hasChecks(part)) return [];
  return evaluateChecks(part, storedCheckInput(store, calls, '')).map((r) => (r.status === 'passed' || r.status === 'failed' ? { status: 'inconclusive', ok: false, label: r.label, detail: NO_OUTPUT_KEPT } : r));
}

/** Why the checks fail a run: each failed check, and each that could not be decided (an inconclusive check never passes). */
export const checkFailures = (checks: readonly CheckResult[]): string[] => checks.filter((c) => !c.ok).map((c) => `${c.label}, but ${c.status === 'inconclusive' ? `it is inconclusive: ${c.detail!}` : c.detail!}`);

/** How a recording fares against its checks, from what it holds: `judgeRecording`'s answer. */
export interface RecordingJudged {
  /** True when it passed, false when it failed, null when the recording can't settle it. */
  passed: boolean | null;
  failures: string[];
  /** The results, the checks on the output left out. */
  checks: CheckResult[];
  /** Why the recording can't settle it, when it can't. */
  unsettled: string[];
}

/**
 * How a recorded run fares against the oracle, from what the recording holds: its exit status and
 * every check but those on its output, which is not recorded; `calls` and `when` rules read the
 * recorded arguments and results, so they cost nothing. A judge check takes the verdict the run holds
 * for it (its own judge call), and is no evidence either way without one. Null when that can't
 * settle it, and `unsettled` says why: a check on the output, a check that is inconclusive (a judge
 * with no recorded verdict), a run still recording, or a partial recording that holds no tool calls.
 * `checks` are the results, the ones on the output left out.
 */
export function judgeRecording(store: Store, run: RunRecord, calls: CallRecord[], spec: TestSpec | null, prices?: Record<string, Price>, options: EvaluateOptions = {}): RecordingJudged {
  const failures: string[] = [];
  if (run.status === 'failed') failures.push('the agent exited with a non-zero code');
  else if (run.status === 'crashed') failures.push('the run was interrupted');
  // A judge check takes the verdict the run already holds for it: the call its judge made, answered.
  const judges = spec ? judgeChecksOf(spec) : [];
  const held = judges.length && !options.judgeVerdicts ? judgedOptions(recordedVerdicts(store, calls, judges)) : {};
  const checks = spec ? evaluateChecks(withoutOutput(spec), storedCheckInput(store, calls, '', prices), { ...held, ...options }) : [];
  failures.push(...checkFailures(checks.filter((c) => checkStatus(c) === 'failed')));
  const unsettled = [
    ...(run.status === 'running' ? ['it is still recording'] : []),
    ...(spec && readsOutput(spec) ? [READS_OUTPUT] : []),
    ...(run.meta?.covers?.length && !run.meta.covers.includes('tool') ? ['it is a partial recording that holds no tool calls'] : []),
    ...checkFailures(checks.filter((c) => c.status === 'inconclusive')),
  ];
  return { passed: failures.length ? false : unsettled.length ? null : true, failures, checks, unsettled };
}

/**
 * The role a recording plays in a verify under `spec`, as `decisions --verify` and `migrate` give
 * each run: one that fails its checks as recorded must now pass (`target`); any other, one the
 * recording can't settle too, must keep passing (`good`). It reads the run's calls.
 */
export function recordedRole(store: Store, run: RunRecord, spec: TestSpec | null, prices?: Record<string, Price>): VerifyRole {
  return judgeRecording(store, run, store.getCalls(run.runId), spec, prices).passed === false ? 'target' : 'good';
}
