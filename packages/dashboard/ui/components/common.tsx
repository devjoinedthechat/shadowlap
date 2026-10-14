import { useEffect, useRef, useState, type ReactNode } from 'react';
import { copy } from '../format.js';

/** What happened to a call on this run: a small square in the origin's color, and the word. */
export function Origin({ origin, error = false }: { origin: string; error?: boolean }) {
  return (
    <span className={`origin o-${origin}${error ? ' is-error' : ''}`}>
      <i aria-hidden="true" />
      {origin}
    </span>
  );
}

/**
 * What a run is, as tags: recording, capture, clean, fork @17, and failed beside it when it failed.
 * Uppercase, so they never read as the labels people add; colored only when they say something: the
 * replay accent for clean, yellow for a fork, red for a failure.
 */
export function RunLabel({ label, status }: { label: string; status: string }) {
  const failed = status === 'failed' || status === 'crashed';
  const tone = label.startsWith('fork') ? 'fork' : label === 'clean replay' ? 'clean' : 'plain';
  return (
    <span className="runlabel" title={failed ? `${label}, ${status}` : label}>
      <span className={`tag t-${tone}`}>{label === 'clean replay' ? 'clean' : label}</span>
      {failed ? <span className="tag t-bad">{status}</span> : null}
    </span>
  );
}

/** A run still recording gets a pulsing mark; a failed one says so in its tags. */
export function StatusMark({ status }: { status: string }) {
  if (status === 'running') return <i className="mark s-running" title="recording now" aria-label="recording now" />;
  return null;
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <div className="eyebrow">
      <s aria-hidden="true" />
      {children}
    </div>
  );
}

export function Stat({ value, label, note }: { value: ReactNode; label: string; note?: ReactNode }) {
  return (
    <div className="stat">
      <b>{value}</b>
      <span>{label}</span>
      {note ? <em>{note}</em> : null}
    </div>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState<null | boolean>(null);
  useEffect(() => {
    if (done === null) return;
    const t = setTimeout(() => setDone(null), 1400);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button type="button" className="textbtn" onClick={() => void copy(text).then(setDone)}>
      {done === null ? label : done ? 'Copied' : 'Copy failed'}
    </button>
  );
}

/** A collapsible JSON tree. Objects deeper than `open` start collapsed. */
export function JsonView({ value, open = 2 }: { value: unknown; open?: number }) {
  return (
    <div className="json">
      <JsonNode value={value} depth={0} open={open} />
    </div>
  );
}

function JsonNode({ value, depth, open, name }: { value: unknown; depth: number; open: number; name?: string }) {
  const key = name !== undefined ? <span className="j-key">{JSON.stringify(name)}: </span> : null;
  if (value === null || typeof value !== 'object') {
    const cls = value === null ? 'j-lit' : typeof value === 'string' ? 'j-str' : 'j-lit';
    return (
      <div className="j-row">
        {key}
        <span className={cls}>{typeof value === 'string' ? JSON.stringify(value) : String(value)}</span>
      </div>
    );
  }
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value as Record<string, unknown>);
  const [openBrace, closeBrace] = Array.isArray(value) ? ['[', ']'] : ['{', '}'];
  if (entries.length === 0)
    return (
      <div className="j-row">
        {key}
        <span className="j-punct">{openBrace + closeBrace}</span>
      </div>
    );
  return (
    <details className="j-node" open={depth < open}>
      <summary>
        {key}
        <span className="j-punct">{openBrace}</span>
        <span className="j-count">
          {' '}
          {entries.length} {Array.isArray(value) ? (entries.length === 1 ? 'item' : 'items') : entries.length === 1 ? 'key' : 'keys'} {closeBrace}
        </span>
      </summary>
      <div className="j-children">
        {entries.map(([k, v]) => (
          <JsonNode key={k} value={v} depth={depth + 1} open={open} {...(Array.isArray(value) ? {} : { name: k })} />
        ))}
      </div>
      <div className="j-punct j-close">{closeBrace}</div>
    </details>
  );
}

export function Dialog({ title, children, onClose, footer }: { title: string; children: ReactNode; onClose: () => void; footer: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('textarea, input, .btn.primary, button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <h2>{title}</h2>
        <div className="dialog-body">{children}</div>
        <div className="dialog-foot">{footer}</div>
      </div>
    </div>
  );
}

export function Logo({ className = '' }: { className?: string }) {
  return (
    <svg className={`logo ${className}`} viewBox="0 0 300 300" aria-hidden="true">
                  <g fill="none" strokeWidth="46">
        <path d="M100 262V185A122 122 0 0 1 222 63" />
        <path d="M176 262V185A46 46 0 0 1 222 139" />
      </g>
    </svg>
  );
}

/** A shell command the way the landing page shows one: a prompt, the command, a copy button. */
export function Command({ children }: { children: string }) {
  return (
    <div className="cmd">
      <code>
        {children.split('\n').map((line, i) => (
          <span key={i}>
            <b>$</b>
            {line}
          </span>
        ))}
      </code>
      <CopyButton text={children} />
    </div>
  );
}
