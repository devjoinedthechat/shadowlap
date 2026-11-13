/** A row of a judge's card, the shape of HoverCard.tsx's TipRow, typed here so goldens.ts, which tests read without the DOM, imports nothing of the hover card's. */
export interface JudgeRow {
  label: string;
  value: string;
}

/** What a judge's card can say of it, each part where the page has it. */
export interface JudgeFacts {
  /** The question it asks. */
  question?: string | null;
  /** What it reads, in the builder's words (`the whole run`). */
  reads?: string | null;
  /** What it answered and why, where it was asked (`yes: It names the $100 limit.`). */
  answered?: string | null;
  /** The model it is asked with, or that answered. */
  model?: string | null;
}

/**
 * A judge's rows on its card, wherever a judge check shows: what it asks, what it reads, what it
 * answered, and its model, in that order, each only where the page has it. Tests' checks
 * (goldens.ts) and a fix's Must line and Blame step (fixes/parts.tsx) both take their rows from
 * here, so a judge's card reads the same on each.
 */
export function judgeRows(j: JudgeFacts): JudgeRow[] {
  const rows: [string, string | null | undefined][] = [
    ['Asks', j.question],
    ['Reads', j.reads],
    ['Answered', j.answered],
    ['Model', j.model],
  ];
  return rows.flatMap(([label, value]) => (value ? [{ label, value }] : []));
}
