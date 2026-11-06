import { useState, type ReactNode } from 'react';
import { consentAsked } from '../actions.js';
import { ConsentDialog } from '../components/Dialog.js';
import { useApp } from '../state.js';
import { useTreeBusy } from './tree.js';
import { JobButton } from '../components/JobButton.js';
import { sentEstimate, type Priced } from '../spending.js';

/**
 * A button on a fix's page that starts a job running the agent from the working tree (Run blame again,
 * Run more attempts, Verify again): lime when it is the page's next step, its command on hover, and
 * plain, with why, while it can't start (a read-only dashboard, a server without the job, a repair
 * or an apply holding the tree). A job whose runs came from someone else's pack asks once more
 * before it runs their command. `ask`, when given, is its dialog, which starts the job with the fields
 * it adds. With an `estimate`, a press follows Spending (JobButton): it starts at once at or under the
 * threshold, else opens `ask`, and the start, the ask's and the consent's yes all send the estimate
 * the card said. Without one, `ask` opens on every press, as a form does.
 */
export function FixJobButton({
  kind,
  fields,
  label,
  verb,
  lead,
  tip,
  command,
  className = 'btn',
  ask,
  ...priced
}: {
  kind: string;
  fields: Record<string, unknown>;
  label: string;
  /** What to do once the tree is free: "blame again once it is done". */
  verb: string;
  lead: boolean;
  /** What it does, on hover with its command. */
  tip: string;
  command: string;
  className?: string;
  ask?: (start: (more: Record<string, unknown>) => boolean, close: () => void) => ReactNode;
  /** What the job bills, when the page knows it (JobButton's `estimate`). */
  estimate?: Priced;
}) {
  const app = useApp();
  const busy = useTreeBusy('reads', verb);
  const [asking, setAsking] = useState(false);
  const [consent, setConsent] = useState<{ why: string; confirm: string; fields: Record<string, unknown> } | null>(null);
  if (app.exported) return null;
  const missing = app.hasKind(kind) ? null : 'This dashboard doesn’t run it: run the command in a terminal.';
  const why = missing ?? busy;
  const start = (more: Record<string, unknown>) =>
    app.client.startJob(kind, { ...fields, ...more }).then(
      (job) => app.watchJob(Promise.resolve(job)),
      (err: unknown) => {
        const asked = more.yes === undefined ? consentAsked(err) : null;
        if (asked) setConsent({ ...asked, fields: more });
        else app.watchJob(Promise.reject(err));
      },
    );
  return (
    <>
      <JobButton {...priced} form={!('estimate' in priced) && !!ask} className={`${className}${lead ? ' lime' : ''}`} why={why} tip={tip} command={`$ ${command}`} start={(sent) => void start(sent)} ask={() => (ask ? setAsking(true) : void start(sentEstimate(priced.estimate)))}>
        {label}
      </JobButton>
      {asking && ask
        ? ask(
            (more) => app.guard(() => void start({ ...sentEstimate(priced.estimate), ...more })),
            () => setAsking(false),
          )
        : null}
      {consent ? (
        <ConsentDialog
          why={consent.why}
          ok="Run command"
          onClose={() => setConsent(null)}
          onOk={() => app.guard(() => void start({ ...consent.fields, yes: consent.confirm }))}
        />
      ) : null}
    </>
  );
}
