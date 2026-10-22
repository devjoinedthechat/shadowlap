import { decisionWord, describeGate, gateOf, outcomeOf, probeFinding, rescueRule, verdictLine, wilsonBound, type BlameProbe, type BlameReport, type Gate, type GateResult, type SprtGate, type VerifiedRun } from '@shadowlap/engine';

/**
 * A gate's verdict as every page says it (decision 9): the verdict word, the tally and the Wilson
 * bound, and against history the baseline, `failed · 4 of 8 · rate <= 0.78 (95%) · against 0.94 over
 * the last 10 sessions (47 of 50)`; never a claimed rate. The rule it was decided by is said once,
 * apart: under the table that lists the goldens, under the first bundle of a report, on a line's
 * hover. Tests, Needs a look, Activity and the Forks view's bundles all take their lines from here,
 * as the CLI's reports take theirs from the engine's words.
 */

/** How a verdict colours: lime for one that held, red for one that didn't, amber for one left inconclusive. */
export type VerdictTone = 'ok' | 'no' | 'y';

/**
 * A golden's gate verdict in one line: `passed · 12 of 12 · rate >= 0.76 (95%)`. `word: false`
 * leaves the word out, for a place that shows it beside the line already (Tests' Last result). The
 * kept sentence, its rule cut off, for figures that can't be read.
 */
export function gateLine(g: GateResult, o: { word?: boolean } = {}): string {
  let line: string;
  try {
    line = verdictLine(g);
  } catch {
    line = g.sentence.replace(/ · gate: .*$/, '');
  }
  if (o.word !== false) return line;
  const word = `${decisionWord(g.decision)} · `;
  return line.startsWith(word) ? line.slice(word.length) : line;
}

/** A gate's rule, said once for the goldens or runs it decided: `gate: tells 90%+ from 70%- at <= 5% risk, up to 20 attempts`. */
export function gateRule(g: Gate): string {
  return `gate: ${describeGate(gateOf(g))}`;
}

/** A gate's rule, or null for a verdict a clean replay settled (its one attempt is the same every time) or one whose figures can't be read. */
export function gateRuleOf(g: GateResult | null | undefined): string | null {
  if (!g || g.clean) return null;
  try {
    return gateRule(g);
  } catch {
    return null;
  }
}

/** A word's tone: a verdict that held, one that didn't, or one left inconclusive (not settled). */
export function toneOf(word: string): VerdictTone {
  return /^(passed|rescued|fixed|kept)$/.test(word) ? 'ok' : /^(inconclusive|unsettled)$/.test(word) ? 'y' : 'no';
}

/** A blame probe's verdict: `rescued · 2 of 2 · rate >= 0.34 (95%)`, under its report's rule (`rescueRule`). */
export function probeLine(p: BlameProbe, r: Pick<BlameReport, 'needed' | 'attemptsPerProbe' | 'gate'>): { line: string; rule: string; tone: VerdictTone } {
  const line = probeFinding(p, r.gate ?? null);
  return { line, rule: rescueRule(r), tone: toneOf(line.split(' · ')[0]!) };
}

/**
 * A run verify took, as its verdict reads: `fixed · 12 of 12 · rate >= 0.76 (95%)`; `kept · clean
 * replay` for one its first attempt settled; with a fixed count, the tally alone; an attempt that
 * could not be judged counted apart, with no bound, as the CLI prints it (`inconclusive · 2 of 2
 * passed, attempt 3 not judged`).
 */
export function verifiedLine(x: VerifiedRun): { line: string; tone: VerdictTone } {
  const word = outcomeOf(x);
  const tone = toneOf(word);
  if (x.undecided) {
    const judged = x.attempts.filter((a) => a.verdict !== 'inconclusive').length;
    return { line: `${word} · ${judged ? `${x.passes} of ${judged} passed, ` : ''}attempt ${x.attempts.length} not judged`, tone };
  }
  if (x.deterministic) return { line: `${word} · clean replay`, tone };
  let bound: string | null = null;
  try {
    bound = x.gate && x.attempts.length ? wilsonBound(x.gate) : null;
  } catch {
    bound = null;
  }
  return { line: [word, `${x.passes} of ${x.attempts.length}`, bound].filter(Boolean).join(' · '), tone };
}

/** How a verify decided each run: its gate's rule (`gate: tells 90%+ from 70%- at <= 5% risk, up to 80 attempts`), or a fixed count's. */
export function runsRule(v: { gate?: SprtGate | null; needed: number; attemptsPerRun: number }): string {
  return v.gate ? gateRule(v.gate) : `a run passes when ${v.needed} of ${v.attemptsPerRun} attempts pass`;
}
