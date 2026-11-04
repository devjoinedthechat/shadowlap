import { Fragment, type ReactNode } from 'react';
import { cmdParts } from '../cmdline.js';
import { copyText } from '../dom.js';
import { shellWords } from '../format.js';
import { ORIGIN_NAME, type Origin7 } from '../origins.js';
import { useApp } from '../state.js';
import { Icon } from './Icon.js';

/**
 * The small parts every screen is built from. Each renders the design system's classes; see
 * components/README.md for which to reach for.
 */

/** The small capitals above a title. */
export function Eyebrow({ tone, children }: { tone?: 'fork' | 'err' | 'n' | undefined; children: ReactNode }) {
  return (
    <div className={`eyebrow${tone ? ` ${tone}` : ''}`}>
      <i />
      {children}
    </div>
  );
}

/** A page's header: eyebrow, title, a line, and the page's actions on the right. */
export function PageHeader({ eyebrow, title, text, actions, eyebrowTone, className }: { eyebrow?: ReactNode; title: ReactNode; text?: ReactNode; actions?: ReactNode; eyebrowTone?: 'fork' | 'err'; className?: string | undefined }) {
  return (
    <div className={`ph${className ? ` ${className}` : ''}`}>
      <div>
        {eyebrow ? <Eyebrow tone={eyebrowTone}>{eyebrow}</Eyebrow> : null}
        <h1>{title}</h1>
        {text ? <p>{text}</p> : null}
      </div>
      {actions ? <div className="actions">{actions}</div> : null}
    </div>
  );
}

/** What a run is, beside its id: recording, clean, fork @17, capture, test, failed. */
export function Tag({ cls, children }: { cls?: string; children: ReactNode }) {
  return <span className={`tag${cls ? ` ${cls}` : ''}`}>{children}</span>;
}

/** An origin: its colour and its word. */
export function Org({ origin }: { origin: Origin7 }) {
  return (
    <span className={`org ${origin}`}>
      <i />
      {ORIGIN_NAME[origin]}
    </span>
  );
}

/** A legend of the origins present. */
export function Legend({ origins, className = 'legend' }: { origins: readonly Origin7[]; className?: string }) {
  return (
    <div className={className}>
      {origins.map((o) => (
        <span key={o}>
          <i className={`lg ${o}`} />
          {ORIGIN_NAME[o]}
        </span>
      ))}
    </div>
  );
}

/** One square per attempt: passed, partly, failed. */
export function Pips({ ok = 0, part = 0, unsure = 0, no = 0 }: { ok?: number; part?: number; unsure?: number; no?: number }) {
  return (
    // A tally drawn as dots: an image to assistive technology, its label the tally in words.
    <span className="pips" role="img" aria-label={`${ok} passed${part ? `, ${part} partly` : ''}${unsure ? `, ${unsure} inconclusive` : ''}${no ? `, ${no} failed` : ''}`}>
      {Array.from({ length: ok }, (_, i) => (
        <i key={`o${i}`} />
      ))}
      {Array.from({ length: part }, (_, i) => (
        <i key={`p${i}`} className="part" />
      ))}
      {Array.from({ length: unsure }, (_, i) => (
        <i key={`u${i}`} className="unsure" />
      ))}
      {Array.from({ length: no }, (_, i) => (
        <i key={`n${i}`} className="no" />
      ))}
    </span>
  );
}

export function Badge({ tone, children }: { tone: 'ok' | 'no' | 'y' | 'n'; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <span className="kbd">{children}</span>;
}

/** Filter chips with counts; empty ones can hide. */
export function Chips<K extends string>({ items, value, onChange, hideEmpty = false, label }: { items: ReadonlyArray<{ key: K; label: string; count?: number }>; value: K; onChange: (k: K) => void; hideEmpty?: boolean; label?: string }) {
  return (
    <div className="chips" role="group" aria-label={label}>
      {items.map((c, i) =>
        hideEmpty && i > 0 && c.count === 0 && c.key !== value ? null : (
          <button key={c.key} type="button" aria-pressed={value === c.key} onClick={() => onChange(c.key)}>
            {c.label}
            {c.count !== undefined ? <b>{c.count.toLocaleString('en-US')}</b> : null}
          </button>
        ),
      )}
    </div>
  );
}

/** Underlined tabs with optional counts. */
export function Tabs<K extends string>({ items, value, onChange, label }: { items: ReadonlyArray<{ key: K; label: string; count?: number | undefined }>; value: K; onChange: (k: K) => void; label?: string }) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {items.map((t) => (
        <button key={t.key} type="button" role="tab" aria-selected={value === t.key} onClick={() => onChange(t.key)}>
          {t.label}
          {t.count !== undefined ? <span className="count">{t.count.toLocaleString('en-US')}</span> : null}
        </button>
      ))}
    </div>
  );
}

/** A segmented switch: Chart or Table, Text or Raw. */
export function Seg<K extends string>({ items, value, onChange, label }: { items: ReadonlyArray<{ key: K; label: string }>; value: K; onChange: (k: K) => void; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {items.map((t) => (
        <button key={t.key} type="button" aria-pressed={value === t.key} onClick={() => onChange(t.key)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** A change against last week: up or down, green when that is good, red when not. */
export function DeltaPill({ now, then, format = (n: number) => n.toLocaleString('en-US'), good }: { now: number; then: number | null | undefined; format?: (n: number) => string; good?: 'up' | 'down' }) {
  if (then === null || then === undefined) return null;
  const d = Math.round((now - then) * 100) / 100;
  if (!d) return <span className="dp">no change</span>;
  const up = d > 0;
  const tone = good === 'up' ? (up ? 'good' : 'bad') : good === 'down' ? (up ? 'bad' : 'good') : '';
  return (
    <span className={`dp${tone ? ` ${tone}` : ''}`} title={`${up ? 'up' : 'down'} ${format(Math.abs(d))} from ${format(then)} last week`}>
      <Icon name={up ? 'up' : 'down'} />
      {format(Math.abs(d))}
    </span>
  );
}

/** A number with its label and a line under it; a link when it opens a page. */
export function Kpi({ k, value, pill, note, tone, href }: { k: string; value: ReactNode; pill?: ReactNode; note?: ReactNode; tone?: 'lime' | 'err' | 'warn' | ''; href?: string }) {
  const body = (
    <>
      <span className="k">{k}</span>
      <span className="kv">
        <b className={tone ?? ''}>{value}</b>
        {pill ? (
          <>
            {pill}
            <span className="vs">vs last week</span>
          </>
        ) : null}
      </span>
      {note ? <span className="n">{note}</span> : null}
    </>
  );
  return href ? (
    <a className="kpi kcell" href={href}>
      {body}
    </a>
  ) : (
    <div className="kpi kcell">{body}</div>
  );
}

/**
 * A shell command as the CLI would take it, wrapping as the mock's commands do (`cmdParts`): between
 * its words, never between a flag and its value or inside a flag, an id or a short value. Copied, it
 * reads as the command.
 */
export function CmdLine({ children }: { children: string }) {
  return (
    <div className="cmdline">
      <b>$</b>
      {cmdParts(children).map((p, i) => ('wbr' in p ? <wbr key={i} /> : p.whole ? <span key={i} className="nw">{p.text}</span> : <span key={i}>{p.text}</span>))}
    </div>
  );
}

/**
 * A shell command as the page shows it (`.cmdline`), wrapping only between its words: a flag, a
 * quoted value or a token breaks inside itself only when it is wider than the box. Copied, it
 * reads as the command.
 */
export function CommandLine({ command }: { command: string }) {
  return (
    <div className="cmdline words">
      <b>$</b>
      {shellWords(command).map((w, i) => (
        <Fragment key={i}>
          {i ? ' ' : null}
          <span>{w}</span>
        </Fragment>
      ))}
    </div>
  );
}

/** A file or snippet with Copy in its header. */
export function CodeBlock({ file, code, copyLabel = 'the code' }: { file: string; code: string; copyLabel?: string }) {
  return (
    <div className="codewrap">
      <div className="codehead">
        <span>{file}</span>
        <CopyButton text={code} label={copyLabel} />
      </div>
      {/* It scrolls sideways for a long line: by keyboard too. */}
      <pre className="codebox" tabIndex={0}>
        {code}
      </pre>
    </div>
  );
}

/** Copies, and says so in a toast. */
export function CopyButton({ text, label, children = 'Copy', className = 'linkbtn' }: { text: string; label?: string; children?: ReactNode; className?: string }) {
  const { toast } = useApp();
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        void copyText(text).then((ok) => toast(ok ? `Copied ${label ?? text}` : 'Copying was refused by the browser'));
      }}
    >
      <Icon name="copy" />
      {children}
    </button>
  );
}

/** When nothing is here yet: what it is, and the command that makes it. */
export function EmptyState({ title, text, command, children }: { title: string; text?: ReactNode; command?: string; children?: ReactNode }) {
  return (
    <section className="panel stepempty">
      <h3>{title}</h3>
      {text ? <p>{text}</p> : null}
      {command ? <CmdLine>{command}</CmdLine> : null}
      {children}
    </section>
  );
}

/**
 * In place of a page, or a part of one, whose code didn't load (`onShow`'s `failed`): one line in the
 * error tone, and Retry, which loads the page again, since a browser never asks a second time for a
 * script it failed to load. While the dashboard server can't be reached, Retry waits for it
 * (`guard`): loading the page then would leave nothing but the browser's own error.
 */
export function LoadFailed({ what }: { what: string }) {
  const { guard } = useApp();
  return (
    <section className="loaderr" role="alert">
      <p>
        <span className="st err">
          <i />
          couldn’t load
        </span>
        <span>This {what}’s code didn’t come from the dashboard server. Retry loads the page again.</span>
      </p>
      <button className="btn" type="button" onClick={() => guard(() => location.reload())}>
        Retry
      </button>
    </section>
  );
}

export interface Step {
  title: string;
  text?: ReactNode;
  /** The CLI command that does the step. */
  command?: string;
  state?: 'done' | 'cur' | 'todo';
  children?: ReactNode;
}

/** Numbered setup steps, each with the CLI command that does it. */
export function StepList({ steps }: { steps: Step[] }) {
  return (
    <ol className="setup">
      {steps.map((s, i) => (
        <li key={s.title} className={s.state ?? 'cur'}>
          <span className="sn">{s.state === 'done' ? '✓' : i + 1}</span>
          <div className="sb">
            <h3>{s.title}</h3>
            {s.text ? <p>{s.text}</p> : null}
            {s.children}
            {s.command ? (
              <div className="cli">
                <span>in a terminal</span>
                <code>$ {s.command}</code>
              </div>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function Spin() {
  return <span className="spin" aria-hidden="true" />;
}
