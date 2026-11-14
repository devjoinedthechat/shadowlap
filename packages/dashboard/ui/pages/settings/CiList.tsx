import { Fragment, useId, useState } from 'react';
import { Icon } from '../../components/Icon.js';
import type { CiListRow } from '../../types.js';

/**
 * A list of rows, each with its dot: the row's own tone (a failure red, one that can't be decided
 * amber, a pass lime), else the list's. A value that lists several (the providers' keys) breaks only
 * after a comma, each one whole. Rows between hairlines on the page, no box.
 */
function CiList({ rows, tone = '', id, hidden }: { rows: readonly CiListRow[]; tone?: '' | 'err'; id?: string; hidden?: boolean }) {
  return (
    <ul className="cilist" id={id} hidden={hidden}>
      {rows.map((r) => (
        <li key={`${r.label}\u0000${r.value}`}>
          {/* A row's own tone first: an inconclusive golden is amber, never a failure's red. */}
          <i className={r.tone ?? (tone || undefined)} aria-hidden="true" />
          <span>{r.label}</span>
          {r.value ? (
            <code>
              {r.value.split(', ').map((v, i) => (
                <Fragment key={i}>
                  {i ? ', ' : null}
                  <span className="nw">{v}</span>
                </Fragment>
              ))}
            </code>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * A CI panel's list behind its name and how many rows it holds (`It needs 9`): what a part needs,
 * what it never does and what fails a golden are read once, so each opens on request and the panel
 * keeps to its settings and what lands. The rows are drawn either way, hidden while folded, as Your
 * workflow's file is.
 */
export function ListFold({ name, rows, tone = '' }: { name: string; rows: readonly CiListRow[]; tone?: '' | 'err' }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="cifold">
      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        {/* The space is for a reader of the button's name: the two are set apart by the line's gap. */}
        <span className="k">{name}</span> <span className="n">{rows.length}</span>
        <Icon name="caret" />
      </button>
      <CiList rows={rows} tone={tone} id={id} hidden={!open} />
    </div>
  );
}

/**
 * A row's select, named by the row's label and described by its line (`<id>-name`, `<id>-help`), or
 * by `label` where the row's words name it (Gates' figures). Waits, `disabled`, while `off` says.
 */
export function Select({ id, label, value, options, onChange, off = false }: { id?: string; label?: string; value: string; options: ReadonlyArray<{ value: string; label: string }>; onChange: (value: string) => void; off?: boolean }) {
  return (
    <select className="sel" id={id} aria-label={label} aria-labelledby={id && !label ? `${id}-name` : undefined} aria-describedby={id ? `${id}-help` : undefined} value={value} disabled={off} onChange={(e) => onChange(e.target.value)}>
      {options.map((x) => (
        <option key={x.value} value={x.value}>
          {x.label}
        </option>
      ))}
    </select>
  );
}
