import { useRef, useState, type ReactNode, type ReactElement } from 'react';
import { consentAsked } from '../actions.js';
import { ConsentDialog } from '../components/Dialog.js';
import { useApp } from '../state.js';
import type { JobView } from '../types.js';
import { refusedPress } from './page-fix.js';
import { useTreeBusy } from './tree.js';
import { JobButton } from '../components/JobButton.js';
import { sentEstimate, type Priced } from '../spending.js';

/** A fix job's ask: its dialog, given how to start the job with the fields it adds and how to close. */
type FixJobAsk = (start: (more: Record<string, unknown>) => boolean, close: () => void) => ReactNode;

/**
 * What a fix job bills and how it asks. One that bills nothing has neither and starts on a press. One
 * with an `estimate` (JobButton's: undefined while it is worked out, null for none), or a form, must
 * have the `ask` a press opens: `form` asks what to run on every setting, priced or not, and is set
 * whenever there is an `ask` and no `estimate`.
 */
type FixJobBilling = { estimate?: never; form?: never; ask?: never } | { estimate?: Priced; form?: boolean; ask: FixJobAsk };

/**
 * A button on a fix's page that starts a job running the agent from the working tree (Run blame again,
 * Run more attempts, Verify again): lime when it is the page's next step, its command on hover, and
 * plain, with why, while it can't start (a read-only dashboard, a server without the job, a repair
 * or an apply holding the tree). A job whose runs came from someone else's pack asks once more
 * before it runs their command; one refused once the fix's blame moved on offers Open Blame
 * (`refusedPress`). `ask` is its dialog, which starts the job with the fields it adds. With
 * an `estimate`, a press follows Spending (JobButton): it starts at once at or under the threshold,
 * else opens `ask`, and the start, the ask's and the consent's yes all send the estimate the card said.
 * Without one, `ask` opens on every press, as a form does. A job billed or a form has its `ask` (the
 * props say so): a press that asks never starts it instead.
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
  form,
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
} & FixJobBilling) {
  const app = useApp();
  const busy = useTreeBusy('reads', verb);
  const [asking, setAsking] = useState(false);
  const { start, consent } = useConsentStart(kind, fields);
  if (app.exported) return null;
  const missing = app.hasKind(kind) ? null : 'This dashboard doesn’t run it: run the command in a terminal.';
  const why = missing ?? busy;
  return (
    <>
      <JobButton {...priced} form={form ?? (!('estimate' in priced) && !!ask)} className={`${className}${lead ? ' lime' : ''}`} why={why} tip={tip} command={`$ ${command}`} start={(sent) => void start(sent)} ask={() => setAsking(true)}>
        {label}
      </JobButton>
      {asking && ask
        ? ask(
            (more) => app.guard(() => void start({ ...sentEstimate(priced.estimate), ...more })),
            () => setAsking(false),
          )
        : null}
      {consent}
    </>
  );
}

/** What a start does besides start: once it runs, and where it couldn't. */
export interface ConsentStartOn {
  /** Once it runs, with its job. */
  started?: (job: JobView) => void;
  /** Followed by its caller rather than in the drawer: a dialog's own read. */
  follow?: boolean;
  /** Where it couldn't start, refused (the error) or its question closed unanswered (null); without it, a refusal says why in a toast. */
  failed?: (err: unknown) => void;
}

/**
 * Starts a job of `kind` with `fields` and what the press adds (its estimate), following it in the
 * drawer; a command it runs that needs a yes (a 409 with the command) asks first in ConsentDialog, and
 * the same start goes again with the yes, which `yes` then holds, so a second job of the same
 * commands can carry it. Fixes' buttons, a new preview's dialogs and its read of the working tree
 * start this way.
 */
export function useConsentStart(kind: string, fields: Record<string, unknown>, on: ConsentStartOn = {}): { start: (more: Record<string, unknown>) => Promise<void>; consent: ReactElement | null; yes: string | null } {
  const app = useApp();
  const [consent, setConsent] = useState<{ why: string; confirm: string; fields: Record<string, unknown> } | null>(null);
  const [yes, setYes] = useState<string | null>(null);
  const start = (more: Record<string, unknown>) =>
    app.client.startJob(kind, { ...fields, ...more }).then(
      (job) => {
        if (typeof more.yes === 'string') setYes(more.yes);
        if (!on.follow) app.watchJob(Promise.resolve(job));
        on.started?.(job);
      },
      (err: unknown) => {
        const asked = more.yes === undefined ? consentAsked(err) : null;
        if (asked) setConsent({ ...asked, fields: more });
        else if (on.failed) on.failed(err);
        else refusedPress(app, kind, fields, err);
      },
    );
  // The question closes after its yes too: only one closed unanswered is a start that failed.
  const answered = useRef(false);
  const close = () => {
    setConsent(null);
    if (!answered.current) on.failed?.(null);
    answered.current = false;
  };
  const sayYes = (c: NonNullable<typeof consent>) => {
    answered.current = true;
    app.guard(() => void start({ ...c.fields, yes: c.confirm }));
  };
  return {
    start,
    consent: consent ? <ConsentDialog why={consent.why} ok="Run command" onClose={close} onOk={() => sayYes(consent)} /> : null,
    yes,
  };
}
