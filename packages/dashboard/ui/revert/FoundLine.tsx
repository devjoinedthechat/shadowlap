import { UNTESTED_WORDS } from '../../../engine/src/bisect-words.js';
import { tipText } from '../components/HoverCard.js';
import { foundLine } from '../goldens.js';
import type { FoundCommit } from '../types.js';

/**
 * What Find breaking commit found, as Tests' report and a fix's Blame step draw it: `first bad
 * commit`, its rev, its message, who made it (where names are shown), when and what the search cost
 * (`foundLine`), then the commits just before it that couldn't be tested; why it is the one, on
 * hover. `className` places it: Tests' card under the report, a fix's under the step's lead.
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
