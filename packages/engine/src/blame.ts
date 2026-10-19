import type { Block } from './deltas.js';
import { formatUsd } from './prices.js';
import { percent, type GateDecision, type GateResult, type SprtGate } from './stats.js';
import type { Palette } from './report.js';
import { plain } from './report.js';
import { safeLine } from './text.js';

/**
 * Where a failed run was lost. A run can go wrong long before it visibly fails: the model picks the
 * wrong tool at call 11, and everything after that follows from it. Blame finds that call by asking,
 * at a model call k, "if the model had answered k differently, could the run still have passed?"
 *
 * A probe answers it: replay the calls before k from the recording, which costs nothing, force k
 * live, let the rest of the run go live with writes fenced, and judge the outcome. Several attempts,
 * because one lucky sample proves nothing. A probe *rescues* the run when the re-asked call passes
 * at least `good` of the time (60% by default), and the run is lost there when it passes at most
 * `bad` (10%), each verdict wrong at most `risk` of the time (stats.ts); a probe between the two
 * after its last attempt is inconclusive, which the search takes as not rescued. A fixed count
 * (`needed` of `attempts`) still decides when one is given.
 *
 * Rescue gets harder the later it starts: resampling from call 1 re-runs almost the whole agent,
 * resampling the last call can only change the ending. So probes rescue up to some model call and
 * stop rescuing after it. That boundary is the answer: the last call whose recorded answer could
 * still be replaced by a passing one. Its recorded answer is the one that lost the run, and the next
 * call is where the failure had become unavoidable. The search is a binary search for it, so a run
 * with 30 model calls needs about six probes, not thirty.
 *
 * Nothing guarantees the boundary is clean: a run can be rescuable at 10, not at 12, and again at 14.
 * After the binary search a few calls past the boundary are probed too, and a rescue there moves the
 * search on and lowers the confidence it reports.
 */

export interface BlameAttempt {
  runId: string;
  passed: boolean;
  exitCode: number;
  /** Why the attempt failed the oracle: failed checks, a non-zero exit, a timeout. Empty when it passed. */
  failures: string[];
  /** Approximate USD spent on the attempt's live model calls. */
  spent: number;
  upstreamRequests: number;
}

export interface BlameProbe {
  /** The failed run's model call that was forced live, by call number. */
  callNo: number;
  /** Its position among the run's model calls, from 1. */
  step: number;
  attempts: BlameAttempt[];
  passes: number;
  /** The re-asked call passes often enough: the gate passed, or the fixed count was met. */
  rescued: boolean;
  /** A gate decided the probe: what it said, inconclusive included (`rescued` is false then). Absent for a fixed count. */
  decision?: GateDecision;
  /** A gate decided the probe: its result, with the pass rate's interval and the risk (stats.ts). */
  gate?: GateResult | null;
}

export type ProbeVerdict = 'rescued' | 'lost' | 'open';

/** A probe's verdict in a word: rescued, lost, or inconclusive. */
export const probeWord = (x: Pick<BlameProbe, 'rescued' | 'decision'>): 'rescued' | 'lost' | 'inconclusive' => (x.rescued ? 'rescued' : x.decision === 'inconclusive' ? 'inconclusive' : 'lost');

/**
 * What a probe found, in words a person reads: `passes at least 60% of the time (2 of 2 attempts)`,
 * `passes at most 10% of the time (0 of 4 attempts)`, `is inconclusive: between 10% and 60% after 10
 * attempts (4 of 10)`. A probe a fixed count decided says its tally.
 */
export function probeFinding(x: Pick<BlameProbe, 'rescued' | 'decision' | 'passes' | 'attempts'> & { gate?: Pick<GateResult, 'passes' | 'attempts'> | null | undefined }, gate: Pick<SprtGate, 'good' | 'bad'> | null | undefined): string {
  if (!gate || !x.decision) return `${x.rescued ? 'rescued' : 'lost'} ${x.passes} of ${x.attempts.length}`;
  // What it decided on: with attempts running at once, some may have ended after it decided.
  const on = x.gate && Number.isInteger(x.gate.attempts) && x.gate.attempts < x.attempts.length ? x.gate : null;
  const tally = on ? `${on.passes} of ${on.attempts}` : `${x.passes} of ${x.attempts.length}`;
  const late = on ? `, and ${x.attempts.length - on.attempts} more that ended after it decided` : '';
  if (x.decision === 'pass') return `passes at least ${percent(gate.good)} of the time (${tally} attempts${late})`;
  if (x.decision === 'fail') return `passes at most ${percent(gate.bad)} of the time (${tally} attempts${late})`;
  return `is inconclusive: between ${percent(gate.bad)} and ${percent(gate.good)} after ${on ? on.attempts : x.attempts.length} attempts (${tally}${late})`;
}

/** How a probe decides, in a sentence: `a rescue: the re-asked call passes at least 60% of the time, lost at 10% or less, at most 5% risk each, up to 10 attempts`. */
export function rescueRule(r: Pick<BlameReport, 'needed' | 'attemptsPerProbe'> & { gate?: SprtGate | null | undefined }): string {
  if (!r.gate) return `a rescue needs ${r.needed} of ${r.attemptsPerProbe} attempts to pass`;
  return `a rescue: the re-asked call passes at least ${percent(r.gate.good)} of the time, lost at ${percent(r.gate.bad)} or less, at most ${percent(r.gate.risk)} risk each, up to ${r.gate.max} attempts`;
}

/**
 * A probe's verdict after `done` of `attempts` attempts, `passes` of which passed. It is settled as
 * soon as the attempts still to run cannot change it, so a probe stops early without ever deciding
 * differently from one that ran every attempt.
 */
export function probeVerdict(passes: number, done: number, attempts: number, needed: number): ProbeVerdict {
  if (passes >= needed) return 'rescued';
  if (passes + (attempts - done) < needed) return 'lost';
  return 'open';
}

/** The most probes a search makes on a run with `steps` model calls when rescue is monotone. */
export function maxProbes(steps: number, scan: number): number {
  if (steps <= 0) return 0;
  return 1 + Math.ceil(Math.log2(steps)) + Math.min(scan, Math.max(0, steps - 1));
}

export interface BlameSearchOptions {
  /** The failed run's model calls, by call number, in order. */
  steps: readonly number[];
  /** Runs the probe at a model call. Resolves null when the search has to stop (a budget, an interrupt). */
  probe: (callNo: number, step: number) => Promise<BlameProbe | null>;
  /** Model calls past the boundary to probe as well, in case rescue works again after it. */
  scan: number;
}

export type BlameOutcome = 'blamed' | 'unrescuable' | 'stopped';
export type Confidence = 'high' | 'medium' | 'low';

export interface BlameSearchResult {
  outcome: BlameOutcome;
  /** The last model call whose resampling rescued the run: the one whose recorded answer lost it. */
  blamed: BlameProbe | null;
  /** The next model call, where rescue no longer worked. Null when the blamed call is the run's last. */
  lost: BlameProbe | null;
  /** Every probe made, in call order. */
  probes: BlameProbe[];
  /** Rescue that worked again after a call where it didn't, as the pair of call numbers. */
  nonMonotone: Array<{ lost: number; rescued: number }>;
  confidence: Confidence;
}

export async function searchBlame(o: BlameSearchOptions): Promise<BlameSearchResult> {
  const steps = o.steps;
  const n = steps.length;
  if (n === 0) throw new Error('the run made no model calls, so there is nothing to blame');
  const probed = new Map<number, BlameProbe>();
  const nonMonotone: BlameSearchResult['nonMonotone'] = [];
  const at = async (i: number): Promise<BlameProbe | null> => {
    const known = probed.get(i);
    if (known) return known;
    const p = await o.probe(steps[i]!, i + 1);
    if (p) probed.set(i, p);
    return p;
  };
  const finish = (outcome: BlameOutcome, lo: number | null, hi: number | null): BlameSearchResult => {
    const blamed = lo === null ? null : (probed.get(lo) ?? null);
    const lost = hi === null || hi >= n ? null : (probed.get(hi) ?? null);
    return { outcome, blamed, lost, probes: [...probed.values()].sort((a, b) => a.callNo - b.callNo), nonMonotone, confidence: confidenceOf(outcome, lost, nonMonotone) };
  };

  const first = await at(0);
  if (!first) return finish('stopped', null, null);
  if (!first.rescued) return finish('unrescuable', null, 0);

  // Invariant: the probe at lo rescued, and nothing from hi on did. `n` stands for the recording
  // itself, which kept every recorded answer and failed.
  let lo = 0;
  let hi = n;
  for (;;) {
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      const p = await at(mid);
      if (!p) return finish('stopped', lo, hi);
      if (p.rescued) lo = mid;
      else hi = mid;
    }
    let again = -1;
    for (let j = hi + 1; j < n && j <= hi + o.scan; j++) {
      const p = await at(j);
      if (!p) return finish('stopped', lo, hi);
      if (p.rescued) {
        again = j;
        break;
      }
    }
    if (again < 0) return finish('blamed', lo, hi);
    nonMonotone.push({ lost: steps[hi]!, rescued: steps[again]! });
    lo = again;
    hi = n;
  }
}

function confidenceOf(outcome: BlameOutcome, lost: BlameProbe | null, nonMonotone: BlameSearchResult['nonMonotone']): Confidence {
  if (outcome === 'stopped' || nonMonotone.length) return 'low';
  // Not rescued, because the first probe couldn't tell: it may still be an answer the model gets right some of the time.
  if (outcome === 'unrescuable' && lost?.decision === 'inconclusive') return 'low';
  // Not reliably lost there: under a gate, it couldn't say; under a fixed count, it passed some, below the bar.
  if (lost && (lost.decision ? lost.decision === 'inconclusive' : lost.passes > 0)) return 'medium';
  return 'high';
}

/** A model response in one line: its tool calls with their arguments, and the start of its text. */
export function describeBlocks(blocks: readonly Block[], width = 100): string {
  const cut = (s: string, w: number) => (s.length > w ? `${s.slice(0, w - 1)}…` : s);
  const parts = blocks.flatMap((b) => {
    if (b.type === 'tool_call') return [`${b.name}(${cut(JSON.stringify(b.input ?? {}), Math.max(20, width - b.name.length - 2))})`];
    if (b.type === 'text' && b.text.trim()) return [`"${cut(b.text.trim().replace(/\s+/g, ' '), width)}"`];
    return [];
  });
  return parts.length ? parts.join(', ') : '(no text or tool calls)';
}

export interface BlameContrast {
  callNo: number;
  /** What the model answered at the blamed call in the failed run. */
  recorded: Block[];
  /** What it answered there in a rescued fork. */
  rescued: Block[];
  rescuedRunId: string;
}

export interface BlameReport extends BlameSearchResult {
  runId: string;
  /** Model calls in the run. */
  steps: number;
  /** The most attempts a probe takes: the gate's `max`, or the fixed count. */
  attemptsPerProbe: number;
  /** Passing attempts that make a probe a rescue: the fixed count's, or with a gate the fewest that can (2 at 0.6, 0.1, 0.05). */
  needed: number;
  /** The gate each probe was decided by; null when a fixed count decided. Absent in reports made before gates. */
  gate?: SprtGate | null;
  /** How a probe re-asked the model: resampled as it was, or with request fields changed from that call on. */
  rescue: { fields: Record<string, unknown> };
  /** The oracle, as the labels of what a passing run must do. */
  oracle: string[];
  /** How the recording itself fails the oracle. */
  recordedFailures: string[];
  contrast: BlameContrast | null;
  /**
   * Probes rescued the run, yet every attempt that passed at the call the search ended on answered
   * it as the recording did: no answer of the model's made the difference, so no call is blamed and
   * the outcome is `unrescuable`. The call, an attempt that passed, and why it passed, in a sentence
   * or two. Absent from reports made before blame looked.
   */
  sameAnswer?: { callNo: number; runId: string; why: string } | null;
  /**
   * No probe rescued the run, and every attempt from the first model call (`callNo`) made a write
   * that failed when the run was recorded, the same call again, and met its error: the likely cause.
   * The tool and the recorded error's message. Absent from reports made before blame looked.
   */
  failedWrite?: { name: string; message: string; callNo: number } | null;
  /** Every attempt run, including those of a probe the search stopped before it settled. */
  attempts: number;
  spent: number;
  upstreamRequests: number;
  /** What its judge checks' calls cost, apart from `spent` and `upstreamRequests`: only when a judge was asked. */
  judge?: { spent: number; upstreamRequests: number };
  /** Models with no price, whose cost is missing from `spent`. */
  unknownModels: string[];
  /** Why the search stopped early, for the `stopped` outcome. */
  stopReason: string | null;
  /** What the replays warned about, such as a connection that bypassed Shadowlap. */
  warnings: string[];
}

const short = (id: string) => id.slice(0, 10);

export function describeRescue(fields: Record<string, unknown>): string {
  const entries = Object.entries(fields);
  if (!entries.length) return 'resample the probed call';
  return `resample from the probed call on with ${entries.map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ')}`;
}

/**
 * A blame that placed the failure on no call only because its first probe couldn't tell: resampled
 * from the first model call, the run passed some of the time, between the gate's two rates. That is
 * no finding that the failure isn't one unlucky answer, so it reads apart, with low confidence.
 */
export function unsettledFirst(r: Pick<BlameReport, 'outcome' | 'probes' | 'sameAnswer' | 'failedWrite'>): boolean {
  return r.outcome === 'unrescuable' && !r.sameAnswer && !r.failedWrite && r.probes[0]?.decision === 'inconclusive';
}

/**
 * Why a blame placed the failure on no call (`unrescuable`), as its report and the dashboard's Blame
 * step say it: the evidence, then where to look. Passing attempts that answered as the recording did,
 * or a write's recorded error every attempt met again, mean no answer of the model's lost the run. A
 * first probe that couldn't tell says so, and how to settle it.
 */
export function unrescuedWhy(r: Pick<BlameReport, 'probes' | 'needed' | 'sameAnswer' | 'failedWrite'> & { gate?: SprtGate | null | undefined }): { evidence: string | null; look: string } {
  const notTheAnswer = "No answer of the model's lost this run: look at the tools, the harness or the command.";
  if (r.sameAnswer) return { evidence: r.sameAnswer.why, look: notTheAnswer };
  const first = r.probes[0];
  if (r.failedWrite) return { evidence: `Every attempt from the first model call, #${r.failedWrite.callNo}, made ${r.failedWrite.name}'s recorded call again and failed on its error, as the recording did: ${r.failedWrite.message}.`, look: notTheAnswer };
  const gated = !!first?.decision && !!r.gate;
  if (gated && first.decision === 'inconclusive') {
    const g = r.gate!;
    const lower = Math.max(0.05, +(g.good - 0.2).toFixed(2));
    return {
      evidence: `Resampled from the first model call, #${first.callNo}, the run ${probeFinding(first, g)}.`,
      look: `Not settled: resampled from #${first.callNo}, the run passes some of the time, too often to call it lost and too rarely to call it rescued, so it may still be an answer the model gets right only sometimes. More attempts or a lower bar settle it: --gate '{"good":${lower > g.bad ? lower : g.good},"max":${Math.min(1000, g.max * 2)}}'.`,
    };
  }
  return {
    evidence: !first
      ? null
      : gated
        ? `Resampled from the first model call, #${first.callNo}, the run ${probeFinding(first, r.gate)}.`
        : `Resampling from the first model call, #${first.callNo}, passed ${first.passes} of ${first.attempts.length} attempts, fewer than the ${r.needed} a rescue needs.`,
    look: 'The failure is not one unlucky answer: look at the prompt, the tools or the harness, or rescue with a stronger model (--model).',
  };
}

/**
 * What blame found that says no answer of the model's lost a run it placed on no call, as a clause
 * for a repair's reason (`every attempt failed on post_digest's recorded error (channel_not_found:
 * #refunds)`), or null when it found nothing that says so: then the cause may still be the prompt.
 */
export function notTheAnswer(r: Pick<BlameReport, 'sameAnswer' | 'failedWrite'>): string | null {
  if (r.sameAnswer) return `every attempt that passed at #${r.sameAnswer.callNo} answered it as the recording did`;
  if (r.failedWrite) return `every attempt failed on ${r.failedWrite.name}'s recorded error (${r.failedWrite.message})`;
  return null;
}

export function formatBlame(r: BlameReport, p: Palette = plain): string {
  const lines: string[] = [];
  const call = (x: BlameProbe) => `#${x.callNo}`;
  const rate = (x: BlameProbe) => `${x.passes} of ${x.attempts.length}`;
  const where = (x: BlameProbe) => `model call ${call(x)} (${x.step} of ${r.steps})`;

  if (r.outcome === 'blamed' && r.blamed) {
    const b = r.blamed;
    lines.push(`${p.yellow('⑂')} ${p.bold(`The run was lost at ${where(b)}`)}`);
    if (r.gate && b.decision) {
      // Decided by a gate: what each side's re-asked call does, at the gate's stated risk.
      const after = r.lost ? `${call(r.lost)}, the next model call, ${probeFinding(r.lost, r.gate)}.` : `it is the last model call, and the recording, which kept its answer, fails.`;
      lines.push(`  The re-asked call ${call(b)} ${probeFinding(b, r.gate)}; ${after}`);
    } else {
      const after = r.lost ? `resampling ${call(r.lost)}, the next model call, rescued ${rate(r.lost)}.` : `it is the last model call, and the recording, which kept its answer, fails.`;
      lines.push(`  Resampling ${call(b)} rescued ${rate(b)} attempts; ${after}`);
    }
  } else if (r.outcome === 'unrescuable') {
    const why = unrescuedWhy(r);
    const unsettled = unsettledFirst(r);
    lines.push(unsettled ? `${p.yellow('?')} ${p.bold('Not settled from the first model call')}` : `${p.red('✗')} ${p.bold('Not rescued from any model call')}`);
    if (why.evidence) lines.push(`  ${safeLine(why.evidence)}`);
    lines.push(`  ${why.look}`);
    if (unsettled) lines.push(`  Confidence: ${p.red('low')} ${p.dim(`(#${r.probes[0]!.callNo} was inconclusive)`)}`);
  } else {
    lines.push(`${p.yellow('!')} ${p.bold('Stopped before the search finished')}${r.stopReason ? `: ${r.stopReason}` : ''}`);
    lines.push(r.blamed ? `  So far: rescued up to ${call(r.blamed)}${r.lost ? `, lost from ${call(r.lost)}` : ''}.` : '  So far no probe had settled.');
  }

  if (r.outcome !== 'unrescuable') {
    const why =
      r.confidence === 'low'
        ? r.nonMonotone.length
          ? `rescue worked again at ${r.nonMonotone.map((x) => `#${x.rescued} after failing at #${x.lost}`).join(', ')}, so the boundary is not clean`
          : 'the search did not finish'
        : r.confidence === 'medium' && r.lost
          ? r.lost.decision === 'inconclusive'
            ? `${call(r.lost)} was inconclusive: the run was not reliably lost there`
            : `${call(r.lost)} still passed ${rate(r.lost)}, below the bar: the run was not reliably lost there`
          : 'rescue stops cleanly at the boundary';
    lines.push(`  Confidence: ${r.confidence === 'high' ? p.green('high') : r.confidence === 'medium' ? p.yellow('medium') : p.red('low')} ${p.dim(`(${why})`)}`);
  }

  if (r.contrast) {
    const label = `At #${r.contrast.callNo}`;
    const pad = ' '.repeat(label.length);
    lines.push('', `  ${label}  ${p.dim('the recording ')}  ${safeLine(describeBlocks(r.contrast.recorded))}`);
    lines.push(`  ${pad}  ${p.dim('a rescued fork')}  ${safeLine(describeBlocks(r.contrast.rescued))}`);
  }

  if (r.probes.length) {
    lines.push('', `  ${p.bold('Probes')} ${p.dim(`(${rescueRule(r)}; ${describeRescue(r.rescue.fields)})`)}`);
    const w = Math.max(...r.probes.map((x) => String(x.callNo).length)) + 1;
    for (const x of r.probes) {
      const blamed = r.blamed?.callNo === x.callNo;
      const word = probeWord(x);
      const verdict = word === 'rescued' ? p.green(word) : word === 'inconclusive' ? p.yellow(word) : p.red(word);
      const mark = blamed ? p.yellow('  ◂ blamed') : '';
      lines.push(`    ${`#${x.callNo}`.padEnd(w)}  ${`${x.step} of ${r.steps}`.padEnd(String(r.steps).length * 2 + 4)}  ${`${rate(x)} passed`.padEnd(14)}  ${verdict}${mark}`);
    }
  }

  if (r.warnings.length) lines.push('', ...r.warnings.map((w) => `  ${p.yellow('!')} ${safeLine(w)}`));
  const attempts = r.attempts;
  const unpriced = r.unknownModels.length ? ` (no price for ${r.unknownModels.map(safeLine).join(', ')})` : '';
  const judged = r.judge ? ` · judge checks: ${r.judge.upstreamRequests} upstream request${r.judge.upstreamRequests === 1 ? '' : 's'}, ≈${formatUsd(r.judge.spent)}` : '';
  lines.push('', p.dim(`  ${attempts} attempt${attempts === 1 ? '' : 's'} · ${r.upstreamRequests} upstream requests · ≈${formatUsd(r.spent)} spent${unpriced}${judged} · every call before a probe replayed from the recording`));
  lines.push(p.dim(`  oracle: ${r.oracle.map(safeLine).join('; ')}`));
  if (r.contrast) lines.push(p.dim(`  rescued fork: shadowlap diff ${short(r.runId)} ${short(r.contrast.rescuedRunId)}    shadowlap ui ${short(r.contrast.rescuedRunId)} --call ${r.contrast.callNo}`));
  else if (r.outcome === 'unrescuable' && r.sameAnswer) lines.push(p.dim(`  an attempt that passed: shadowlap diff ${short(r.runId)} ${short(r.sameAnswer.runId)}    shadowlap ui ${short(r.sameAnswer.runId)} --call ${r.sameAnswer.callNo}`));
  return lines.join('\n');
}
