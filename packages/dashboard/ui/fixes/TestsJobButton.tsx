import type { ReactNode } from 'react';
import { JobButton } from '../components/JobButton.js';
import type { Priced } from '../spending.js';
import { useTestsWait } from './tree.js';

/** A Tests job's card: its title, the sentence under it and the command it runs; its price follows from `estimate`. */
export interface TestsCard {
  tip: string;
  sub?: string | null | undefined;
  command?: string | undefined;
}

/**
 * A button that starts a Tests job, on Tests or from another page (Add normalizer and Update golden on
 * a test replay's page): it waits as an ActionButton does, its reason on its card, while the server
 * would refuse it, as the Tests page's own buttons do. `off` is the page's reason first (a read-only
 * dashboard); `title` is the hover while it can start, `tip` a hover card drawn already, or `card` the
 * card's words, which then says the job's `estimate` where the page knows it and whether it starts at
 * once (JobButton). `lead`: it is the run's next step, which the palette presses by that name. A press
 * always posts, or opens what asks for what it does (Update golden): a job that would run goldens
 * live asks first in the server's question (TestsAskHost), which Spending answers, so it never asks twice.
 * A lime one goes plain while it waits: the page never offers a lime button that can't start.
 * `fold`: a run header's button that folds into its … menu by that name.
 */
export function TestsJobButton(props: { verb: string; off: string | null; title?: string | null; tip?: string; card?: TestsCard | undefined; estimate?: Priced; lead?: string; fold?: string; className: string; onClick: () => void; children: ReactNode }) {
  const { verb, off, title, tip, card, lead, fold, className, onClick, children } = props;
  const wait = useTestsWait(verb);
  return (
    <JobButton
      className={className}
      why={off ?? wait}
      title={title ?? undefined}
      {...card}
      {...(tip ? { 'data-tip': tip } : {})}
      {...(lead ? { 'data-next': lead } : {})}
      {...(fold ? { 'data-fold': fold } : {})}
      {...('estimate' in props ? { estimate: props.estimate } : { bills: false })}
      start={onClick}
      ask={onClick}
    >
      {children}
    </JobButton>
  );
}
