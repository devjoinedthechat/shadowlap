import { useState, type ReactNode } from 'react';
import { consentAsked } from '../actions.js';
import { tipCard } from '../components/HoverCard.js';
import { ConsentDialog } from '../components/Dialog.js';
import { useApp } from '../state.js';
import { useTreeBusy } from './tree.js';

/**
 * A button on a fix's page that starts a job running the agent from the working tree (Run blame again,
 * Run more attempts, Verify again): lime when it is the page's next step, its command on hover, and
 * plain, with why, while it can't start (a read-only dashboard, a server without the job, a repair
 * or an apply holding the tree). A job whose runs came from someone else's pack asks once more
 * before it runs their command. `ask`, when given, opens a dialog first, which starts the job with
 * the fields it adds.
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
  ask?: (start: (more: Record<string, unknown>) => void, close: () => void) => ReactNode;
}) {
  const app = useApp();
  const busy = useTreeBusy('reads', verb);
  const [asking, setAsking] = useState(false);
  const [consent, setConsent] = useState<{ why: string; confirm: string; fields: Record<string, unknown> } | null>(null);
  if (app.exported) return null;
  const missing = app.hasKind(kind) ? null : 'This dashboard doesn’t run it: run the command in a terminal.';
  const why = app.actionsOff ?? missing ?? busy;
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
      <button
        className={`${className}${lead ? ' lime' : ''}`}
        type="button"
        disabled={!!why}
        title={why ?? undefined}
        data-tip={why ? undefined : tipCard(tip, [], `$ ${command}`)}
        onClick={() => app.guard(() => (ask ? setAsking(true) : void start({})))}
      >
        {label}
      </button>
      {asking && ask
        ? ask(
            (more) => {
              setAsking(false);
              app.guard(() => void start(more));
            },
            () => setAsking(false),
          )
        : null}
      {consent ? (
        <ConsentDialog
          why={consent.why}
          ok="Run"
          onClose={() => setConsent(null)}
          onOk={() => {
            const c = consent;
            setConsent(null);
            app.guard(() => void start({ ...c.fields, yes: c.confirm }));
          }}
        />
      ) : null}
    </>
  );
}
