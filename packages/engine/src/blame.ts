import type { Block } from './deltas.js';
import { formatUsd } from './prices.js';
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
 * because one lucky sample proves nothing. A probe *rescues* the run when enough attempts pass.
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
  rescued: boolean;
}

export type ProbeVerdict = 'rescued' | 'lost' | 'open';

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
  // Below the bar, but not zero: the run was not reliably lost there.
  if (lost && lost.passes > 0) return 'medium';
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
  attemptsPerProbe: number;
  /** Passing attempts that make a probe a rescue. */
  needed: number;
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
 * Why a blame placed the failure on no call (`unrescuable`), as its report and the dashboard's Blame
 * step say it: the evidence, then where to look. Passing attempts that answered as the recording did,
 * or a write's recorded error every attempt met again, mean no answer of the model's lost the run.
 */
export function unrescuedWhy(r: Pick<BlameReport, 'probes' | 'needed' | 'sameAnswer' | 'failedWrite'>): { evidence: string | null; look: string } {
  const notTheAnswer = "No answer of the model's lost this run: look at the tools, the harness or the command.";
  if (r.sameAnswer) return { evidence: r.sameAnswer.why, look: notTheAnswer };
  const first = r.probes[0];
  if (r.failedWrite) return { evidence: `Every attempt from the first model call, #${r.failedWrite.callNo}, made ${r.failedWrite.name}'s recorded call again and failed on its error, as the recording did: ${r.failedWrite.message}.`, look: notTheAnswer };
  return {
    evidence: first ? `Resampling from the first model call, #${first.callNo}, passed ${first.passes} of ${first.attempts.length} attempts, fewer than the ${r.needed} a rescue needs.` : null,
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
    const after = r.lost
      ? `resampling ${call(r.lost)}, the next model call, rescued ${rate(r.lost)}.`
      : `it is the last model call, and the recording, which kept its answer, fails.`;
    lines.push(`  Resampling ${call(b)} rescued ${rate(b)} attempts; ${after}`);
  } else if (r.outcome === 'unrescuable') {
    const why = unrescuedWhy(r);
    lines.push(`${p.red('✗')} ${p.bold('Not rescued from any model call')}`);
    if (why.evidence) lines.push(`  ${safeLine(why.evidence)}`);
    lines.push(`  ${why.look}`);
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
          ? `${call(r.lost)} still passed ${rate(r.lost)}, below the bar: the run was not reliably lost there`
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
    lines.push('', `  ${p.bold('Probes')} ${p.dim(`(a rescue needs ${r.needed} of ${r.attemptsPerProbe} attempts to pass; ${describeRescue(r.rescue.fields)})`)}`);
    const w = Math.max(...r.probes.map((x) => String(x.callNo).length)) + 1;
    for (const x of r.probes) {
      const blamed = r.blamed?.callNo === x.callNo;
      const verdict = x.rescued ? p.green('rescued') : p.red('lost');
      const mark = blamed ? p.yellow('  ◂ blamed') : '';
      lines.push(`    ${`#${x.callNo}`.padEnd(w)}  ${`${x.step} of ${r.steps}`.padEnd(String(r.steps).length * 2 + 4)}  ${`${rate(x)} passed`.padEnd(14)}  ${verdict}${mark}`);
    }
  }

  if (r.warnings.length) lines.push('', ...r.warnings.map((w) => `  ${p.yellow('!')} ${safeLine(w)}`));
  const attempts = r.attempts;
  const unpriced = r.unknownModels.length ? ` (no price for ${r.unknownModels.map(safeLine).join(', ')})` : '';
  lines.push('', p.dim(`  ${attempts} attempt${attempts === 1 ? '' : 's'} · ${r.upstreamRequests} upstream requests · ≈${formatUsd(r.spent)} spent${unpriced} · every call before a probe replayed from the recording`));
  lines.push(p.dim(`  oracle: ${r.oracle.map(safeLine).join('; ')}`));
  if (r.contrast) lines.push(p.dim(`  rescued fork: shadowlap diff ${short(r.runId)} ${short(r.contrast.rescuedRunId)}    shadowlap ui ${short(r.contrast.rescuedRunId)} --call ${r.contrast.callNo}`));
  else if (r.outcome === 'unrescuable' && r.sameAnswer) lines.push(p.dim(`  an attempt that passed: shadowlap diff ${short(r.runId)} ${short(r.sameAnswer.runId)}    shadowlap ui ${short(r.sameAnswer.runId)} --call ${r.sameAnswer.callNo}`));
  return lines.join('\n');
}
