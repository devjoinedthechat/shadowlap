import { Fragment } from 'react';
import { Words } from './Copy.js';

/**
 * Decision 9 on every page: a gate's verdict is its word, its tally and its Wilson bound (against
 * history, its baseline), `failed · 4 of 8 · rate <= 0.78 (95%)`, and the rule it was decided by is
 * stated once (under Tests' table, once in a run's family on the Forks view) or on the line's hover
 * (Needs a look, Activity); never a claimed rate. The server words every line (src/verdict.ts); these draw
 * them, one way everywhere: a line breaks only after a dot, each short part kept whole, so "4 of 8"
 * and "rate <= 0.78 (95%)" never break inside; a rule keeps each figure with its words.
 */

/**
 * The parts of a dotted line, each with its dot, the dot kept with the part before it so no line
 * starts with one: a part of `max` characters or fewer is kept whole, one of up to `soft` whole but
 * on a phone, where it may wrap (`kc`), and a longer one may wrap between its words. A part that may
 * wrap keeps its dot with its last word by a no-break space, so a dot ends a line and never starts one.
 */
export function dotParts(text: string, max = 44, soft = max): Array<{ text: string; keep: 'whole' | 'soft' | null }> {
  const parts = text.split(' · ').filter((p) => p !== '');
  return parts.map((p, i) => {
    const keep = p.length <= max ? 'whole' : p.length <= soft ? 'soft' : null;
    return { text: `${p}${i < parts.length - 1 ? (keep === 'whole' ? ' ·' : '\u00a0·') : ''}`, keep };
  });
}

/** A line of parts joined by dots, broken only after a dot: a part of `max` characters or fewer never breaks inside. */
export function DotLine({ text, max = 44, soft }: { text: string; max?: number; soft?: number }) {
  return (
    <>
      {dotParts(text, max, soft ?? max).map((p, i) => (
        <Fragment key={i}>
          {i ? ' ' : null}
          {p.keep === 'whole' ? (
            <span className="nw">{p.text}</span>
          ) : p.keep ? (
            <span className="kc">
              <Words>{p.text}</Words>
            </span>
          ) : (
            <Words>{p.text}</Words>
          )}
        </Fragment>
      ))}
    </>
  );
}

/**
 * A rule's figures, each kept with its words where the rule wraps: "tells 90%+ from 70%-", "at <= 5% risk",
 * "up to 20 attempts", and a --clean gate's "tells a write gone in 80%+", "of clean attempts" and "from one gone in 20%-".
 */
const FIGURES = /tells a write gone in \S+|of clean attempts|from one gone in \S+|tells \S+ from \S+|(?:rescue|lost) at \S+|(?:at )?<= \S+ risk|up to \d+ attempts|a drop of \S+ points|its last \d+ sessions|once \S+ likely|from \d+ attempts up to \d+|\d+ of \d+ attempts/g;

/** A rule's words with each figure glued together, so it breaks only between figures. */
export const ruleWords = (rule: string): string => rule.replace(FIGURES, (m) => m.replace(/ /g, '\u00a0'));

/** A gate's rule, stated once, breaking only between its figures, each small word kept with what follows ("from its last 10 sessions"). */
export function RuleText({ rule }: { rule: string }) {
  return <Words>{ruleWords(rule)}</Words>;
}

/** The hover a verdict line carries when its rule isn't stated beside it: the rule, under what it decided. */
export function ruleTip(title: string, rule: string | null | undefined): string | undefined {
  return rule ? JSON.stringify({ t: title, s: ruleWords(rule) }) : undefined;
}

/**
 * The Wilson interval on a 0 to 1 scale against the gate's two marks (its bad and good rates, or
 * the baseline and the drop that fails it): one that held sits right of the low mark, one that
 * failed left of the high one, an inconclusive one straddles them. Lime, red or amber by the verdict.
 */
export function IntervalBar({ lo, hi, marks, tone }: { lo: number; hi: number; marks: readonly number[]; tone: 'ok' | 'no' | 'y' }) {
  const at = (x: number) => Math.max(0, Math.min(1, x)) * 100;
  const pct = (x: number) => `${at(x).toFixed(1)}%`;
  return (
    <span className={`wib ${tone}`} aria-hidden="true">
      {/* At least a sliver wide, so an interval that narrow still shows. */}
      <i className="iv" style={{ left: pct(lo), width: `${Math.max(1.5, at(hi) - at(lo)).toFixed(1)}%` }} />
      {marks.map((m, i) => (
        <i key={i} className="mk" style={{ left: pct(m) }} />
      ))}
    </span>
  );
}
