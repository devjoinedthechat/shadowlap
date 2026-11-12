import { useContext, useState } from 'react';
import { MarksContext } from './marks.js';

/**
 * A JSON value as a tree: objects and arrays fold, the first two levels open, and a folded branch
 * draws nothing until it is opened, so a long request stays quick. Long strings are cut in the tree;
 * Copy copies the whole value. What an injection attempt's page marks (marks.ts) shows wherever it is:
 * its branch opens, its string is drawn whole, and it is marked.
 */
export function JsonTree({ value, open = 2 }: { value: unknown; open?: number }) {
  return (
    <div className="tree">
      <Node value={value} depth={0} open={open} />
    </div>
  );
}

function Node({ value, depth, open, name }: { value: unknown; depth: number; open: number; name?: string }) {
  const key =
    name !== undefined ? (
      <>
        <span className="tk">{name}</span>:{' '}
      </>
    ) : null;
  const marks = useContext(MarksContext);
  if (value === null || typeof value !== 'object') {
    const cls = typeof value === 'string' ? 's' : typeof value === 'number' ? 'num' : 'b';
    const cut = typeof value === 'string' && value.length > 90 && !marks.holds(value);
    const shown = typeof value === 'string' ? `"${cut ? `${value.slice(0, 90)}…` : value}"` : String(value);
    return (
      <div className="kv" title={cut ? value.slice(0, 2000) : undefined}>
        {key}
        <span className={cls}>{marks.mark(shown)}</span>
      </div>
    );
  }
  return <Branch value={value} depth={depth} open={open} label={key} />;
}

function Branch({ value, depth, open, label }: { value: object; depth: number; open: number; label: React.ReactNode }) {
  const { holds } = useContext(MarksContext);
  const [isOpen, setOpen] = useState(() => depth < open || holds(value));
  const entries = Array.isArray(value) ? value.map((v: unknown, i) => [String(i), v] as const) : Object.entries(value as Record<string, unknown>);
  const sum = Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`;
  return (
    <details open={isOpen} onToggle={(e) => setOpen((e.currentTarget).open)}>
      <summary>
        {label}
        <span className="muted">{sum}</span>
      </summary>
      {isOpen ? entries.map(([k, v]) => <Node key={k} value={v} depth={depth + 1} open={open} name={k} />) : null}
    </details>
  );
}
