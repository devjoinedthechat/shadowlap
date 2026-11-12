import { Children, Fragment, isValidElement, type ReactNode } from 'react';

/**
 * Parts each kept whole where their line holds them, an inline block ending in its dot (a cost line's,
 * a toast's): a line too narrow for all of them breaks after a dot first, and a part wider than its
 * line wraps inside itself.
 */
export function DotBlocks({ parts, className }: { parts: readonly ReactNode[]; className: string }) {
  const last = parts.length - 1;
  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={i}>
          <span className={className}>
            {part}
            {i < last ? '\u00a0·' : null}
          </span>
          {i < last ? ' ' : null}
        </Fragment>
      ))}
    </>
  );
}

/**
 * A receipt's parts joined by " · ", as the mock's dotJoin() sets one: a part short enough to stay
 * whole keeps its dot and stays on one line, so the line breaks only after a dot, never inside a
 * figure ("cost: blame ≈$0.054"); a longer one keeps its dot with its last word. `DotNodes` draws it.
 */
export function DotParts({ parts }: { parts: readonly string[] }) {
  return <DotNodes parts={parts.map((p) => ({ text: p, node: p }))} />;
}

/**
 * A long part with its dot, glued to its last word by a no-break space; a part of words that ends on
 * an element (an id, code, an origin's pill), around which a no-break space alone can't hold, keeps
 * that element and the dot in a nowrap span (the mock's dotJoin()), the words before it free to wrap.
 */
function withDot(node: ReactNode, dot: string | null): ReactNode {
  if (!dot) return node;
  if (typeof node === 'string' || typeof node === 'number') return `${node}${dot}`;
  const items = Children.toArray(node);
  const last = items[items.length - 1];
  if (items.length < 2 || !isValidElement(last))
    return (
      <>
        {node}
        {dot}
      </>
    );
  return [
    ...items.slice(0, -1),
    <span key="dot" className="nw">
      {last}
      {dot}
    </span>,
  ];
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
              withDot(p.node, dot)
            )}
          </Fragment>
        );
      })}
    </>
  );
}
