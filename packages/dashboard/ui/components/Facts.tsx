import type { ReactNode } from 'react';

/**
 * A page's facts, under its header, in the run page's stat style (`.metrics.pfacts`): each figure
 * first in the display face, its words muted after it, money last and quieter. What a figure is
 * made of, and what it was before, are on its hover, never beside it: a bare change ("−3") beside a
 * count reads as part of it. A figure that leads somewhere is a link, in ink. On a phone they sit
 * in a grid, three across, two when there are two or four, so none is left alone on a row. A page
 * whose first section already sums it up (Runs' calendar, Tests' verdict) has no facts row.
 */
export interface Fact {
  /** The figure: a count, a tally, a price (`4`, `2 of 7`, `$16.24`). */
  value: ReactNode;
  /** Its words: "failures reproduced", "goldens passing", "spent live". */
  words: ReactNode;
  /** Money: drawn last, and quieter. */
  money?: boolean;
  /** A figure in a verdict's colour: `ok` what passed (a verified fix), `err` what failed. */
  tone?: 'ok' | 'err';
  /** Its hover card: what it is (`title`) and what it is made of, a line of parts joined by dots. */
  tip?: { title: string; parts?: ReadonlyArray<string | null | undefined> };
  /** What it was before, last on its hover ("1 last week"). */
  was?: string | null;
  /** Where it leads: a link in ink. */
  href?: string;
}

/** A fact's hover card, in the shape the hover card layer reads (`{t, s}`): its makeup and its last value joined by dots. */
export function factTip(f: Fact): string | undefined {
  if (!f.tip && !f.was) return undefined;
  const s = [...(f.tip?.parts ?? []), f.was].filter((x): x is string => !!x).join(' · ');
  return JSON.stringify({ t: f.tip?.title ?? '', ...(s ? { s } : {}) });
}

/** The facts in the order they read: money last. */
export const factOrder = (facts: readonly Fact[]): Fact[] => [...facts.filter((f) => !f.money), ...facts.filter((f) => f.money)];

/** One fact: its figure and its words, a link where it leads somewhere. */
function FactItem({ f }: { f: Fact }) {
  const body = (
    <>
      <b className={f.money ? 'q' : f.tone}>{f.value}</b>
      <span>{f.words}</span>
    </>
  );
  const tip = factTip(f);
  return f.href ? (
    <a className="metric" href={f.href} data-tip={tip}>
      {body}
    </a>
  ) : (
    <span className="metric" data-tip={tip}>
      {body}
    </span>
  );
}

/** A row of facts, named for a screen reader by what it sums up: "Overview in figures". */
export function Facts({ facts, label }: { facts: readonly Fact[]; label: string }) {
  if (!facts.length) return null;
  return (
    <section className="metrics pfacts" aria-label={`${label} in figures`}>
      {factOrder(facts).map((f, i) => (
        <FactItem key={i} f={f} />
      ))}
    </section>
  );
}
