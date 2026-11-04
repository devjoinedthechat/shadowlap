import type { ReactNode } from 'react';
import { Words } from './Copy.js';
import type { Tone } from './Status.js';

/**
 * A verdict is a plain line, never a tinted box (Tests and each golden's report, a preview and
 * Migrate, a fix's Verify, Training's one-sided warning, a setup that is done): its word first, in
 * its consequence colour and the line's own size ("failed", "rejected", "inconclusive", "set up",
 * "2 of 7 runs" before verify), then what it says in ink (17px, 600), a tally stated as a tally,
 * its facts muted under it and its next step at the right (under it on a phone). 24px under it
 * before what follows. A report's own verdict, inside its section, is a step smaller (`report`).
 * A verdict that isn't all clear always leads with its word in its colour, so it never reads as
 * all clear. The heading names the word too, so a screen reader moving by headings hears it. A
 * sentence given as text is glued, and a name with a hyphen in it or its facts kept whole (`Words`).
 */
export function VerdictLine({
  word,
  tone,
  children,
  facts,
  actions,
  report = false,
  className,
}: {
  /** The verdict's word or count: passed, failed, inconclusive, rejected, blocked, set up, "2 of 7 runs". */
  word: string;
  /** Its colour: `done` reads in ink (blamed), `mu` muted (not run yet). */
  tone: Tone;
  /** What it says, in a sentence or a tally: "3 of 7 goldens passed · refund-in-limit diverged at call 1". */
  children: ReactNode;
  /** Its facts, muted under it: the command, when, what it cost. */
  facts?: ReactNode;
  /** Its next step, at the right: the lime one is the page's. */
  actions?: ReactNode;
  /** A report's own verdict, inside its section: 15px, its heading an h3. */
  report?: boolean;
  className?: string | undefined;
}) {
  const H = report ? 'h3' : 'h2';
  return (
    <div className={`verdict${report ? ' gv' : ''}${className ? ` ${className}` : ''}`}>
      <span className={`vw ${tone}`} aria-hidden="true">
        {word}
      </span>
      <div>
        <H>
          <span className="sr">{word} </span>
          {typeof children === 'string' ? <Words>{children}</Words> : children}
        </H>
        {facts ? <p>{typeof facts === 'string' ? <Words glued={false}>{facts}</Words> : facts}</p> : null}
      </div>
      {actions ? <div className="actions">{actions}</div> : null}
    </div>
  );
}
