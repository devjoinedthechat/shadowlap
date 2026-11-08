import { DotParts } from './DotParts.js';

/**
 * The receipt at a matrix's foot, under a hairline: what it cost in plain words, then, quieter, what
 * it asked (an injection test's or the presets' results, Changes' preview). Each line's parts are
 * joined by dots and break only after one. A line with a card takes the focus, which shows it.
 */

export interface ReceiptLine {
  parts: readonly string[];
  tip?: string | null;
}

export function Receipt({ lines }: { lines: readonly ReceiptLine[] }) {
  const shown = lines.filter((l) => l.parts.length);
  if (!shown.length) return null;
  return (
    <div className="mxfoot">
      {shown.map((l, i) => (
        <p key={i} className={i ? 'mxr q' : 'mxr'} data-tip={l.tip ?? undefined} tabIndex={l.tip ? 0 : undefined}>
          <DotParts parts={l.parts} />
        </p>
      ))}
    </div>
  );
}
