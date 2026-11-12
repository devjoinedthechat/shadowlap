import type { ReactNode } from 'react';

/** One row of the rule's sentence: its label, then its controls. A row the rule still wants is marked until it is filled. */
export function Row({ label, want = false, children }: { label: string; want?: boolean; children: ReactNode }) {
  return (
    <div className={`cb-r${want ? ' want' : ''}`}>
      <span className="cb-l">{label}</span>
      <div className="cb-c">{children}</div>
    </div>
  );
}
