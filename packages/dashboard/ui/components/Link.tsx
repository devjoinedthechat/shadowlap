import type { MouseEventHandler, ReactNode } from 'react';

/**
 * A link, read in ink (every page): its words at 500, underlined on hover, at its line's size. A
 * text link that names where it goes ends in → (All runs →, Fix →, Redaction preview →), the arrow
 * kept with its last word. A reference in a quiet line (`quiet`) keeps the line's weight. No page
 * sets a link's colour or size; a run's id as a link is `Id`'s, with `href`. A link that says more
 * on hover (a fix's failing runs: which, and where they open) has a card (`tip`, `tipCard`'s). One
 * that opens something where it goes says so on its click (`onClick`: a fix's issue on Runs › Failed).
 */
export function Link({ href, children, to = false, quiet = false, title, className, tip, onClick }: { href: string; children: ReactNode; to?: boolean; quiet?: boolean; title?: string | undefined; className?: string | undefined; tip?: string | undefined; onClick?: MouseEventHandler<HTMLAnchorElement> | undefined }) {
  return (
    <a className={`${quiet ? 'dlink' : 'more'}${className ? ` ${className}` : ''}`} href={href} title={title} data-tip={tip} onClick={onClick}>
      {children}
      {to ? '\u00a0→' : null}
    </a>
  );
}
