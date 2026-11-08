import { Fragment, type ReactNode } from 'react';
import { num } from '../format.js';
import { keyLines, type CellTone, type KeyItem } from '../matrix.js';
import { SrSpace } from './bits.js';
import { glossed } from './Term.js';

/**
 * One key for every matrix, in its head over the cells it explains: an injection test's and the
 * error-path presets' results (ResultsMatrix.tsx), Changes' preview, a golden's report on Tests. The
 * entries that matter first, numbers in the run page's stat style (a swatch, the figure, its words
 * muted), then the quieter ones on a line of their own; a lone quieter entry ends the first line
 * instead. A count of zero is left out (`keyLines`). Each entry keeps whole, and a line breaks only
 * between entries, into balanced lines; with under 560px of room, two aligned columns of entries, one
 * under 300px. An entry with a card takes the focus, which shows its card: the rule it stands on.
 */

/** An entry: its count and words, and its swatch, a tone's (`toneSwatch`) unless the page draws its own. */
export interface KeyEntry extends KeyItem {
  sw?: ReactNode;
}

/** A tone's swatch: a short bar in the colour of the cells it counts. */
export function toneSwatch(tone: CellTone) {
  return <i className={`mxsw ${tone}`} aria-hidden="true" />;
}

function Entry({ e, quiet }: { e: KeyEntry; quiet: boolean }) {
  return (
    <span className={quiet ? 'mxk q' : 'mxk'} tabIndex={e.tip ? 0 : undefined} data-tip={e.tip ?? undefined}>
      {e.sw ?? toneSwatch(e.tone ?? 'mu')}
      {/* the figure and its words are drawn apart by a gap: a space a screen reader says, "8 obeyed" */}
      <b>
        {num(e.n)}
        <SrSpace />
      </b>
      {glossed(e.words)}
    </span>
  );
}

/** Entries joined by a space, where a line may break. */
const joined = (list: ReactNode[]) => list.map((x, i) => <Fragment key={i}>{i ? ' ' : null}{x}</Fragment>);

export function MatrixKey({ main, quiet }: { main: readonly KeyEntry[]; quiet: readonly KeyEntry[] }) {
  const { first, second } = keyLines(main, quiet);
  if (!first.length) return null;
  return (
    <div className="mxkey">
      <p className="mxk1">{joined(first.map(({ entry, quiet: q }) => <Entry e={entry} quiet={q} />))}</p>
      {second.length ? <p className="mxk2">{joined(second.map((entry) => <Entry e={entry} quiet />))}</p> : null}
    </div>
  );
}
