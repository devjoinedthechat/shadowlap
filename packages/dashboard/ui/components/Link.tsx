import type { ReactNode } from 'react';

/**
 * A link, read in ink (every page): its words at 500, underlined on hover, at its line's size. A
 * text link that names where it goes ends in → (All runs →, Fix →, Redaction preview →), the arrow
 * kept with its last word. A reference in a quiet line (`quiet`) keeps the line's weight. No page
 * sets a link's colour or size; a run's id as a link is `Id`'s, with `href`.
 */
export function Link({ href, children, to = false, quiet = false, title, className }: { href: string; children: ReactNode; to?: boolean; quiet?: boolean; title?: string | undefined; className?: string | undefined }) {
  return (
    <a className={`${quiet ? 'dlink' : 'more'}${className ? ` ${className}` : ''}`} href={href} title={title}>
      {children}
      {to ? '\u00a0→' : null}
    </a>
  );
}
