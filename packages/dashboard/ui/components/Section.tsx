import type { ReactNode } from 'react';
import { asWords, titled } from './Copy.js';

/**
 * A section, in place of a card (every page): a hairline above, its heading in the UI face (14px,
 * 600) with a muted, balanced sub, its rows full width between hairlines, no border, radius or
 * ground of its own (`.panel.sec`, so a panel's own rules still apply inside). A row's hover tints
 * it 12px past its text on both sides and never moves it; a table in it scrolls in a container
 * 12px wider than its text (`.tscroll`). Sections are 32px apart; two side by side (`.grid2.secs`)
 * 40px. Only what is not the page keeps a box: dialogs, drawers, menus and code. Its heading gives
 * the page its outline; a section is no landmark of its own, so a page of ten reads as one region.
 */
export function Section({
  title,
  sub,
  actions,
  children,
  className,
  id,
}: {
  title: ReactNode;
  /** One muted line beside the heading: what the section holds, or how it was worked out. */
  sub?: ReactNode;
  /** A small link or button at the heading's right. */
  actions?: ReactNode;
  children?: ReactNode;
  className?: string | undefined;
  id?: string | undefined;
}) {
  const head = titled(title);
  return (
    <section className={`panel sec${className ? ` ${className}` : ''}`} id={id}>
      <header>
        <h2 aria-label={head['aria-label']}>{head.children}</h2>
        {sub ? <span className="sub">{asWords(sub)}</span> : null}
        {actions ? (
          <>
            <span className="sp" />
            <div className="actions">{actions}</div>
          </>
        ) : null}
      </header>
      {children}
    </section>
  );
}
