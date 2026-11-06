import { useMemo, type CSSProperties, type ReactNode } from 'react';
import { jsonDiff, splitRows, type JsonLine } from '../json-diff.js';

/**
 * The structural diff (ui/json-diff.ts) drawn: a line a key, the recorded side's lines signed − and
 * this run's +, washed in the diff's own colours, the words that differ marked in them; each line
 * wraps under its own key (a hanging indent), and a value with no space in it moves to the next line
 * whole rather than break. One list (Show diff, a test's report), or side by side (`split`, Compare).
 * A screen reader hears `added:` or `removed:` before a signed line, the sign being drawn only.
 *
 * Heavy enough to load with a script of its own (`onShow`) where it shows: test/ui-bundle-size.test.ts
 * fails the build if it loads with the first look or up front with any page. A box that shows a
 * change has no Copy: it is read, not pasted.
 */

/** A value's text, its differing words marked; whole (an inline block) when it has no space in it. */
function value(l: JsonLine): ReactNode {
  const text = l.value.map((p, i) =>
    p.marked ? (
      <mark key={i} className="jdw">
        {p.text}
      </mark>
    ) : (
      p.text
    ),
  );
  return l.whole ? <span className="jdq">{text}</span> : text;
}

function DiffLine({ l }: { l: JsonLine }) {
  const keyed = l.key !== null;
  return (
    <div className={l.sign === '+' ? 'jl add' : l.sign === '-' ? 'jl del' : 'jl'} style={{ '--d': l.depth } as CSSProperties}>
      <span className="js" aria-hidden="true">
        {l.sign === '+' ? '+' : l.sign === '-' ? '−' : ''}
      </span>
      <span className="jt">
        {l.sign === '+' ? <span className="sr">added: </span> : l.sign === '-' ? <span className="sr">removed: </span> : null}
        {keyed ? <span className="jk">{l.key}:</span> : null}
        {keyed && l.json ? (
          <>
            {' '}
            <span className="jq">JSON in a string</span>
          </>
        ) : keyed && l.value.length ? (
          ' '
        ) : null}
        {value(l)}
      </span>
    </div>
  );
}

/**
 * Two JSON values' structural diff: `was`, the recording's, against `now`, this run's; or `lines`
 * already walked. `children`, what is said under it from the lines it drew (Show diff's sentence).
 */
export function JsonDiff({ was, now, lines, split = false, children }: { was?: unknown; now?: unknown; lines?: readonly JsonLine[]; split?: boolean; children?: (lines: readonly JsonLine[]) => ReactNode }) {
  const all = useMemo(() => lines ?? jsonDiff(was, now), [lines, was, now]);
  const cell = (l: JsonLine | null, key: string) => (l ? <DiffLine key={key} l={l} /> : <div key={key} className="jl gap" aria-hidden="true" />);
  return (
    <>
      {split ? (
        <div className="jd jds">{splitRows(all).flatMap(([was, now], i) => [cell(was, `${i}-`), cell(now, `${i}+`)])}</div>
      ) : (
        <div className="jd">
          {all.map((l, i) => (
            <DiffLine key={i} l={l} />
          ))}
        </div>
      )}
      {children?.(all)}
    </>
  );
}
