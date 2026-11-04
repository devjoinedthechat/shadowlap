import type { ReactNode } from 'react';
import { useApp } from '../state.js';
import { CodeBox } from './CodeBox.js';
import { Copy } from './Copy.js';

/**
 * A page's three states besides what it shows, one way each everywhere: nothing here yet
 * (`EmptyState`, or `EmptyLine` for a list that matches nothing), still loading (`Skeleton`), and
 * what couldn't be read (`ErrorState`).
 */

/**
 * Nothing here yet: a section under a hairline, its heading, one sentence saying what the page will
 * hold, and the one step that gets there (`step`, the page's lime button), with the command for a
 * terminal quiet under it ("or in a terminal"); with no step, the command is the way, in its box.
 * A command that needs a run is never offered where there is none. Its sentence is drawn as it is
 * given, and set as `Copy` sets UI copy where the page asks (`copy`): never a message the server
 * wrote, which can hold a command or a path a no-break space or a kept word would spoil.
 */
export function EmptyState({ title, text, copy = false, step, command, children }: { title: string; text?: ReactNode; copy?: boolean; step?: ReactNode; command?: string | undefined; children?: ReactNode }) {
  return (
    <section className="panel stepempty">
      <h2>{title}</h2>
      {copy && typeof text === 'string' ? <Copy>{text}</Copy> : text ? <p>{text}</p> : null}
      {step ? <div className="actions">{step}</div> : null}
      {step && command ? (
        <div className="cli">
          <span>or in a terminal</span>
          {/* the prompt is never copied with the command */}
          <code>
            <b>$ </b>
            {command}
          </code>
        </div>
      ) : command ? (
        <CodeBox command={command} />
      ) : null}
      {children}
    </section>
  );
}

/** A list with nothing to show says so in a line from the left: "No runs match.", "Nothing needs a look." */
export function EmptyLine({ children }: { children: ReactNode }) {
  return <p className="emptyline">{children}</p>;
}

/**
 * Still loading: the part in its final shape, every piece of text a quiet bar along the line it will
 * take and every mark its shape in the same tone, nothing to press. Given the part's own markup
 * (`children`, drawn with what it will hold), it draws that, inert; else `lines` bars under the
 * part's heading. A screen reader hears what is loading, once.
 */
export function Skeleton({ what, title, lines = 3, children }: { what: string; title?: string | undefined; lines?: number; children?: ReactNode }) {
  return (
    <section className={title ? 'panel sec skel' : 'skel'} aria-busy="true">
      <span className="sr" role="status">
        Loading {what}…
      </span>
      {title ? (
        <header>
          <h2>{title}</h2>
        </header>
      ) : null}
      {children ? (
        <div className="skin" aria-hidden="true" inert>
          {children}
        </div>
      ) : (
        <div className="skbars" aria-hidden="true">
          {Array.from({ length: lines }, (_, i) => (
            <i key={i} />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * What couldn't be read (a page's code, a view's, what a page asked the server for): one line in the
 * error tone, its word first ("couldn’t load"), what went wrong in a sentence, and its way on at the
 * end, Retry by default. Retry waits while the dashboard server can't be reached (`guard`).
 */
export function ErrorState({ word = 'couldn’t load', children, retry, retryLabel = 'Retry' }: { word?: string; children: ReactNode; retry?: (() => void) | undefined; retryLabel?: string }) {
  const { guard } = useApp();
  return (
    <section className="loaderr" role="alert">
      <p>
        <span className="st err">
          <i />
          {word}
        </span>
        <span>{children}</span>
      </p>
      {retry ? (
        <button className="btn" type="button" onClick={() => guard(retry)}>
          {retryLabel}
        </button>
      ) : null}
    </section>
  );
}
