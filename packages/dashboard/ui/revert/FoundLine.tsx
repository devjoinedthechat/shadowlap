import { UNTESTED_WORDS } from '../../../engine/src/bisect-words.js';
import { tipText } from '../components/HoverCard.js';
import { foundLine } from '../goldens.js';
import type { FoundCommit } from '../types.js';

/**
 * What Find breaking commit found, as a fix's Blame step draws it under the step's lead: `first bad
 * commit`, its rev, its message, who made it (where names are shown), when and what the search cost
 * (`foundLine`), then the commits just before it that couldn't be tested; why it is the one, on
 * hover. Tests' report draws the same facts in its First bad commit part (tests/ReportParts.tsx).
 */
export function FoundCommitLine({ found, className = 'bisect' }: { found: FoundCommit; className?: string }) {
  const f = foundLine(found);
  return (
    <div className={className} data-tip={found.why ? tipText(found.why) : undefined}>
      <span className="k">first bad commit</span>
      <code>{f.rev}</code>
      <b>{f.subject}</b>
      <span className="m">{f.meta}</span>
      {found.untested.length ? <span className="m">{UNTESTED_WORDS.line(found.untested)}</span> : null}
    </div>
  );
}
