import type { ReactNode } from 'react';
import type { Estimate } from '../../../engine/src/estimates/estimate.js';
import { AskNote } from '../components/AskNote.js';
import { SrSpace } from '../components/bits.js';
import { Dialog } from '../components/Dialog.js';
import { Id } from '../components/Id.js';
import { glossed } from '../components/Term.js';
import { outcomeTone } from '../decisions.js';
import type { DecisionEstimates } from '../estimates-api.js';
import { FixJobButton } from '../fixes/FixJobButton.js';
import { VerifyChangeTitle } from '../fixes/verify-asks.js';
import { shortId } from '../format.js';
import { useLoad } from '../hooks.js';
import { draftCommand } from '../job-title.js';
import { glueBound } from '../matrix.js';
import { useApp } from '../state.js';
import type { PreviewNext } from '../types.js';

/**
 * A kept preview's verify, as Preview's verdict, an opened cell and a run's Decisions view start it
 * (`decisions --verify`): Verify on the runs it left to verify, each in the role it is verified in,
 * and Run more attempts or Verify again on the runs verify left open, each with what verify found
 * of it. Priced as its job runs (`decisionEstimates`), up to the limits Run more attempts raises: a
 * press at or under the threshold starts it, else its dialog asks.
 */

/** A run a verify takes, as its dialog lists it: its id, about line and golden, and what verify found of it. */
export interface VerifyRow {
  runId: string;
  golden: string | null;
  about: string | null;
  verified: { outcome: string; tally: string } | null;
}

/** Run more attempts, or Verify again, as the session's view gives it. */
export type PreviewMore = NonNullable<PreviewNext['more']>;

/** What a run must do under verify, by the role its recorded checks give it. */
const ROLE_WORDS: Record<DecisionEstimates['runs'][number]['role'], string> = { target: 'must now pass', good: 'must keep passing' };

/** Verify's lead: what it replays, under the change previewed. */
const verifyLead = (one: boolean, change: string) => `Replays ${one ? 'the run' : 'each run'} end to end under ${change || 'the change'} until verify’s gate decides.`;

/** Run more attempts' lead: verify has no --continue, so the attempts so far start over; Verify again's, once the judge answers. */
function moreLead(more: PreviewMore, one: boolean): string {
  if (more.kind === 'again') return `Verifies ${one ? 'the run' : 'each run'} again from the first attempt, once the judge answers.`;
  const n = more.attempts.toLocaleString('en-US');
  return `Verifies ${one ? `the run again from the first attempt: its ${n}` : `each run again from the first attempt: the ${n}`} so far ${more.attempts === 1 ? 'doesn’t' : 'don’t'} carry over.`;
}

/** Run more attempts' card: it starts again, up to the limits it raises, in verify's words; on one run's own view, without `a run`. */
export function moreTip(more: PreviewMore, o: { one: boolean; view?: boolean }): string {
  if (more.kind === 'again') return `Verifies ${o.one ? 'it' : 'them'} again from the first attempt, once the judge answers`;
  return `Verifies ${o.one ? 'it' : 'them'} again from the start, ${o.view ? more.limit.replace(/ a run\b/, '') : more.limit}`;
}

/** The runs a verify takes, a row each: its id and golden, then what it must do, or what verify found of it for Run more attempts. */
function VerifyRows({ rows, roles }: { rows: readonly VerifyRow[]; roles: DecisionEstimates['runs'] | undefined }) {
  return (
    <>
      {rows.map((r) => {
        const role = roles?.find((x) => x.runId === r.runId)?.role;
        return (
          <p key={r.runId}>
            <Id id={r.runId} list about={r.about} />
            <SrSpace />
            {r.golden ? (
              <>
                <span className="chip">{r.golden.replace(/^goldens\//, '')}</span>
                <SrSpace />
              </>
            ) : null}
            <span className="sp" />
            {r.verified ? (
              <span className={`dvr dsv ${outcomeTone(r.verified.outcome)}`}>
                <b>{glossed(r.verified.outcome)}</b>
                {glueBound(r.verified.tally)}
              </span>
            ) : role ? (
              <span className="dvr">{ROLE_WORDS[role]}</span>
            ) : null}
          </p>
        );
      })}
    </>
  );
}

/**
 * Verify's dialog, or Run more attempts': its title the button's words (`Verify change on <id>`
 * for Verify this run), its lead, a row a run, the command, and its cost line the estimate.
 */
function VerifyDialog({ title, lead, rows, roles, command, estimate, ok, onOk, onClose }: { title: ReactNode; lead: string; rows: readonly VerifyRow[]; roles: DecisionEstimates['runs'] | undefined; command: string; estimate: Estimate | null | undefined; ok: string; onOk: () => void; onClose: () => void }) {
  return <Dialog title={title} lead={lead} doc="verify" runs={<VerifyRows rows={rows} roles={roles} />} command={command} cost={{ price: 'Billed by your provider', estimate }} footNote={<AskNote estimate={estimate} />} ok={ok} onOk={onOk} onClose={onClose} />;
}

export interface PreviewVerifyProps {
  sessionId: string;
  /** The change previewed, as the lead names it. */
  change: string;
  rows: readonly VerifyRow[];
  /** Every run the preview left to verify: the job names none. */
  every?: boolean;
  label: string;
  /** Verify this run, on an opened cell or a run's view: its ask is titled `Verify change on <id>`. */
  one?: boolean;
  /** Run more attempts or Verify again, on the runs verify left open: its limits raised as its job runs them. */
  more?: PreviewMore | null;
  lime?: boolean;
  tip: string;
}

/** Verify, Verify this run, Run more attempts or Verify again on a kept preview, priced by the runs it takes at the limits it runs them to. */
export function PreviewVerifyButton({ sessionId, change, rows, every = false, label, one = false, more = null, lime = false, tip }: PreviewVerifyProps) {
  const { client, exported, actionsOff } = useApp();
  const api = client.estimates;
  const runIds = rows.map((r) => r.runId);
  const named = every ? undefined : runIds;
  const limits = more?.kind === 'more' ? { ...(more.max === null ? {} : { max: more.max }), ...(more.keptMax === null ? {} : { keptMax: more.keptMax }) } : {};
  const priced = useLoad(() => (api && !exported && !actionsOff ? api.decisionEstimates(sessionId, named, limits) : null), `decision-estimate:${sessionId}:${named?.join(',') ?? ''}:${limits.max ?? ''}:${limits.keptMax ?? ''}`);
  const estimate = priced.data ? priced.data.verify : priced.error ? null : undefined;
  const command = draftCommand(['decisions', '--verify', sessionId, ...(named ?? []).map(shortId), ...(more?.flags ?? [])]);
  const title = one && !more ? <VerifyChangeTitle runs={runIds} /> : label;
  const lead = more ? moreLead(more, rows.length === 1) : verifyLead(rows.length === 1, change);
  return (
    <FixJobButton
      kind="decisions-verify"
      fields={{ sessionId, ...(named ? { runIds: named } : {}), ...limits }}
      label={label}
      verb={more?.kind === 'more' ? 'run more attempts' : 'verify the changed runs'}
      lead={lime}
      tip={tip}
      command={command}
      estimate={estimate}
      ask={(start, close) => <VerifyDialog title={title} lead={lead} rows={rows} roles={priced.data?.runs} command={command} estimate={estimate} ok={label} onOk={() => start({})} onClose={close} />}
    />
  );
}

/** Verify this run's card: what it does to the one run. */
export const VERIFY_THIS_RUN_TIP = 'It runs end to end under the change, writes stubbed';

/** Why Verify this run waits on a run the preview cleared, and its card: verify takes the runs a preview can’t clear. */
export const CLEARED_RUN = { why: 'Nothing to verify in this run', tip: 'The preview cleared this run: verify takes the runs a preview can’t clear' } as const;

/** Why Verify this run waits on a run gone from the store. */
export const GONE_RUN = 'This run is no longer in the store';
