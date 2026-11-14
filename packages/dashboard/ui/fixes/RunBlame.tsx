import { useState } from 'react';
import { consentAsked } from '../actions.js';
import { ApiError, JOB_KINDS } from '../api.js';
import { Icon } from '../components/Icon.js';
import { shortId } from '../format.js';
import { useServedParts } from '../served-parts.js';
import type { ShortcutMark } from '../shortcuts.js';
import { useApp } from '../state.js';
import { errorText } from '../toast.js';
import type { TreeJob } from './model.js';
import { useTreeBusy } from './tree.js';
import { ACTIONS } from '../labels.js';
import { ActionButton } from '../components/ActionButton.js';
import { tipCard } from '../components/HoverCard.js';
import { type StepHooks, useBilledPress } from '../components/JobButton.js';
import { sentEstimate, tipEst } from '../spending.js';
import type { Estimate } from '../../../engine/src/estimates/estimate.js';
import type { BlameOffer } from '../types.js';
import { useRunEstimates } from '../run/estimates.js';

/** No jobs: where a list hands in its reason, the button reads none of its own. */
const NO_JOBS: readonly TreeJob[] = [];

/** Why Run blame waits: the reason a list handed in, else the working tree's, from a list's jobs or a read of its own. */
function useBlameWait(busy: string | null | undefined, jobs: readonly TreeJob[] | undefined): string | null {
  const tree = useTreeBusy('reads', 'blame', busy === undefined ? jobs : NO_JOBS);
  return busy === undefined ? tree : busy;
}

/** What Run blame asks in, once pressed: a capture's command, a yes above Spending, the check a blame needs, or a consent the server asks for (RunBlameAsks.tsx). */
export type BlameAsking = null | { kind: 'command' } | { kind: 'ask' } | { kind: 'check'; command: string | null } | { kind: 'consent'; why: string; confirm: string; fields: Record<string, unknown> };

/**
 * Run blame, for a failed run never blamed: a job that finds the model call where the run was lost
 * and opens or joins its fix. The server finds the check the run failed (its own --expect, the
 * config's tests for the recording it replays, the fix it fails in or its labels point to, or the
 * agent's exit); when nothing says what a passing run must do, this asks for it, naming the checks
 * the run failed (`failed`). A run whose command came from someone else's pack runs only once
 * confirmed; a capture, which has none, asks for yours first (`capture`). Disabled, with the reason,
 * where nothing runs or while a repair or an apply changes the working tree the agent would run from.
 * It starts by Spending, with the estimate it was given or, given none (the banner's), the run's own
 * from the server: at or under the threshold at once, else it asks, `Run blame on <id>`. A blame
 * that needs its check, or a capture's command, asks for it in that one dialog, priced, and starts
 * from it; a check the server asks for after all opens that dialog with the estimate kept. The
 * dialogs are a part only the served dashboard hands in (RunBlameAsks.tsx), loaded the first time one
 * asks, so the pages that draw the button carry none of them.
 */
export function RunBlameButton({
  runId,
  offer,
  className = 'linkbtn',
  title = 'Find the model call where this run was lost',
  tip,
  icon = false,
  lead = false,
  capture = false,
  line,
  mark,
  busy,
  jobs,
  on,
  when,
  fold,
  scope,
  ...priced
}: {
  runId: string;
  /**
   * Which checks the run failed, and whether the check must be asked for (`from: 'ask'`); on a run's
   * page also the check, its agents and whether it was recorded at temperature 0, which its ask shows.
   */
  offer: Pick<BlameOffer, 'failed' | 'from'> & Partial<Pick<BlameOffer, 'expect' | 'scopes' | 'temperature0'>>;
  /** The agent to blame within, which the Agents bar picked: it asks first, to show what it runs. */
  scope?: string;
  /** What it bills, as its card said it; left out, the run's estimates are asked for as it shows. */
  estimate?: Estimate | null | undefined;
  className?: string;
  /** The hover when nothing stops it. */
  title?: string;
  /** Or a hover card. */
  tip?: string;
  /** With the fix loop's icon, as the run page's lead button. */
  icon?: boolean;
  /** It is the run's next step, which the palette presses. */
  lead?: boolean;
  capture?: boolean;
  /** The command it runs, where it knows it: a capture's asks for what fills in its `<your command>`. */
  line?: string;
  /** Its key, where it is the run's next step. */
  mark?: ShortcutMark;
  /** Why it waits, where a list works it out from its one read of the jobs (Needs a look): it then reads none of its own. */
  busy?: string | null;
  /** Or a list's jobs, read once for its rows, in place of its own read (Fixes). */
  jobs?: readonly TreeJob[];
  /** A list row's handlers: its estimate asked for as the pointer or the focus reaches it. */
  on?: StepHooks;
  /** A list row's press, which waits for its estimate where it hasn't come yet, then asks or starts with it. */
  when?: (go: (estimate: Estimate | null | undefined) => void) => () => void;
  /** A run header's plain button, which folds into its … menu by this name. */
  fold?: string;
}) {
  const app = useApp();
  const waits = useBlameWait(busy, jobs);
  const [asking, setAsking] = useState<BlameAsking>(null);
  const { RunBlameAsks: Asks } = useServedParts();
  const own = useRunEstimates(runId, 'estimate' in priced ? undefined : null);
  const estimate: Estimate | null | undefined = 'estimate' in priced ? priced.estimate : own === undefined ? undefined : (own?.blame ?? null);
  const failed = offer.failed;
  // It asks first where it needs the check or a capture's command, where the Agents bar picked its agent, and
  // where the run was recorded at temperature 0, whose blame asks the model again for nothing without temperature=1.
  const form = capture || offer.from === 'ask' || !!offer.temperature0 || scope !== undefined;
  const press = useBilledPress();
  const blameLine = line ?? `shadowlap blame ${shortId(runId)}`;
  /**
   * Starts the blame. What the check dialog should show instead comes back: why the server refused
   * the check it was given. Anything else closes the dialog: the job, the consent it needs, or its
   * failure in the drawer.
   */
  const start = (fields: Record<string, unknown>, e = estimate): Promise<string | null> =>
    app.client.startJob(JOB_KINDS.blame, { runId, ...sentEstimate(e), ...fields }).then(
      (job) => {
        setAsking(null);
        app.watchJob(Promise.resolve(job));
        return null;
      },
      (err: unknown) => {
        if (err instanceof ApiError && err.status === 422) {
          setAsking({ kind: 'check', command: typeof fields.command === 'string' ? fields.command : null });
          return 'expect' in fields ? err.message : null;
        }
        if (err instanceof ApiError && err.status === 400 && 'expect' in fields) return err.message;
        // No answer came: the check dialog stays, with what was typed and why.
        if (!(err instanceof ApiError) && 'expect' in fields) return errorText(err);
        const asked = fields.yes === undefined ? consentAsked(err) : null;
        if (asked) setAsking({ kind: 'consent', ...asked, fields });
        else {
          setAsking(null);
          app.watchJob(Promise.reject(err));
        }
        return null;
      },
    );
  const go = (e: Estimate | null | undefined) => (form ? app.guard(() => setAsking(capture ? { kind: 'command' } : offer.from === 'ask' ? { kind: 'check', command: null } : { kind: 'ask' })) : press({ estimate: e, start: () => void start({}, e), ask: () => setAsking({ kind: 'ask' }) }));
  return (
    <>
      <ActionButton
        className={className}
        why={waits}
        data-tip={tip ?? tipCard(ACTIONS.runBlame.label, [], title, `$ ${blameLine}`, tipEst(estimate, form))}
        {...(lead ? { 'data-next': 'blame' } : {})}
        {...(fold ? { 'data-fold': fold } : {})}
        onClick={when ? when(go) : () => go(estimate)}
        {...mark}
        {...on}
      >
        {icon ? <Icon name="loop" /> : null}
        {ACTIONS.runBlame.label}
      </ActionButton>
      {asking && Asks ? <Asks runId={runId} asking={asking} estimate={estimate} form={form} line={line} failed={failed} offer={offer} scope={scope} start={start} onClose={() => setAsking(null)} /> : null}
    </>
  );
}
