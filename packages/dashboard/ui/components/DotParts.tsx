import { Fragment, type ReactNode } from 'react';

/**
 * A receipt's parts joined by " · ", as the mock's dotJoin() sets one: a part short enough to stay
 * whole keeps its dot and stays on one line, so the line breaks only after a dot, never inside a
 * figure ("cost: blame ≈$0.054").
 */
export function DotParts({ parts }: { parts: readonly string[] }) {
  return (
    <>
      {parts.map((p, i) => {
        const text = i < parts.length - 1 ? `${p} ·` : p;
        return (
          <Fragment key={i}>
            {i ? ' ' : null}
            {p.length <= 44 ? <span className="nw">{text}</span> : text}
          </Fragment>
        );
      })}
    </>
  );
}

/**
 * The same line with each part drawn as nodes (code, an id, kept words), measured by its text: a part
 * of `max` characters or fewer stays whole with its dot; a longer one may wrap inside, its dot kept
 * with its last word by a no-break space. The line breaks only after a dot, never before one.
 */
export function DotNodes({ parts, max = 44 }: { parts: ReadonlyArray<{ text: string; node: ReactNode }>; max?: number }) {
  return (
    <>
      {parts.map((p, i) => {
        const dot = i < parts.length - 1 ? '\u00a0·' : null;
        return (
          <Fragment key={i}>
            {i ? ' ' : null}
            {p.text.length <= max ? (
              <span className="nw">
                {p.node}
                {dot}
              </span>
            ) : (
              <>
                {p.node}
                {dot}
              </>
            )}
          </Fragment>
        );
      })}
    </>
  );
}
