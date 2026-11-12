import { Fragment } from 'react';
import type { CiListRow } from '../../types.js';

/**
 * A list of rows, each with its dot: the row's own tone (a failure red, one that can't be decided
 * amber, a pass lime), else the list's. A value that lists several (the providers' keys) breaks only
 * after a comma, each one whole. Rows between hairlines on the page, no box.
 */
export function CiList({ rows, tone = '' }: { rows: readonly CiListRow[]; tone?: '' | 'err' }) {
  return (
    <ul className="cilist">
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
