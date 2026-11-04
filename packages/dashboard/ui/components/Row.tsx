import type { ReactNode } from 'react';

/**
 * A row of a list in a section (Needs a look, Recent runs, Activity, a fix's rows): full width
 * between hairlines, its hover tinting it 12px past its text on both sides and never moving it, and
 * where you are (a picked row, the one selected, one in focus from j and k: `sel`) on the selected
 * ground, which wins over the pointer's (`.srow`, `--bleed`). A row that opens something is a link
 * (`href`), the one where you are named so to a screen reader (`aria-current`). A table's row takes
 * the same grounds with `className="sel"` on its `tr`.
 */
export function Row({ href, sel = false, children, className }: { href?: string | undefined; sel?: boolean; children: ReactNode; className?: string | undefined }) {
  const cls = `srow${sel ? ' sel' : ''}${className ? ` ${className}` : ''}`;
  return href ? (
    <a className={cls} href={href} aria-current={sel ? 'true' : undefined}>
      {children}
    </a>
  ) : (
    <div className={cls}>{children}</div>
  );
}
