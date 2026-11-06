import { Fragment } from 'react';

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
