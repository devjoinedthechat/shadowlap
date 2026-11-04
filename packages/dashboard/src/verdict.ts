import { decisionWord, describeBaselineRule, describeGate, dropBound, gateOf, outcomeOf, probeFinding, rescueRule, runOutcomeWord, verdictLine, rateBound, type BlameProbe, type BlameReport, type Gate, type GateResult, type SprtGate, type VerifiedRun, type VerifyReport } from '@shadowlap/engine';

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
 * replay` for one its first attempt settled; a good run decided against its own baseline by both
 * tallies and the bound on its drop, `kept · 38 of 38, baseline 38 of 38 · drop <= 0.10 (95%)`; with a
 * fixed count, the tally alone; an attempt that could not be judged counted apart, with no bound, as
 * the CLI prints it (`inconclusive · 2 of 2 passed, attempt 3 not judged`). One its attempts left
 * open is inconclusive too, the one word a page has for it, whether its gate couldn't decide or the
 * verify stopped first (verify's report says unsettled).
 */
export function verifiedLine(x: VerifiedRun): { line: string; tone: VerdictTone } {
  const word = runOutcomeWord(outcomeOf(x));
  const tone = toneOf(word);
  if (x.undecided) {
    const judged = x.attempts.filter((a) => a.verdict !== 'inconclusive').length;
    return { line: `${word} · ${judged ? `${x.passes} of ${judged} passed, ` : ''}attempt ${x.attempts.length} not judged`, tone };
  }
  if (x.deterministic) return { line: `${word} · clean replay`, tone };
  // Against its baseline, its pass rate says nothing alone: both tallies, and the bound on the drop.
  if (x.baseline) {
    let drop: string | null;
    try {
      drop = x.drop ? dropBound(x.drop, x.decision) : null;
    } catch {
      drop = null;
    }
    return { line: [word, `${x.passes} of ${x.attempts.length}, baseline ${x.baseline.passes} of ${x.baseline.attempts}`, drop].filter(Boolean).join(' · '), tone };
  }
  let bound: string | null;
  try {
    bound = x.gate && x.attempts.length ? rateBound(x.gate) : null;
  } catch {
    bound = null;
  }
  return { line: [word, `${x.passes} of ${x.attempts.length}`, bound].filter(Boolean).join(' · '), tone };
}

/**
 * How a verify decided a run: its gate's rule (`gate: tells 90%+ from 70%- at <= 5% risk, up to 80
 * attempts`), or a fixed count's; a good run decided against its own baseline (`run.baseline`, with
 * the report's `kept`) by the baseline's (`baseline: kept unless it drops 10+ points below its
 * baseline at 35034be, attempt for attempt, <= 5% risk, up to 200 pairs`).
 */
export function runsRule(v: { gate?: SprtGate | null; needed: number; attemptsPerRun: number; kept?: VerifyReport['kept'] }, run?: Pick<VerifiedRun, 'baseline'>): string {
  const kept = v.kept ?? null;
  if (run?.baseline && kept) return `baseline: ${describeBaselineRule({ ...kept, source: run.baseline.source ?? kept.source, revision: kept.label ?? run.baseline.revision ?? kept.revision ?? null })}`;
  return v.gate ? gateRule(v.gate) : `a run passes when ${v.needed} of ${v.attemptsPerRun} attempts pass`;
}
