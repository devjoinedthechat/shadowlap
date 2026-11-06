import type { Estimate } from '../../../engine/src/estimates/estimate.js';
import { JOB_KINDS } from '../api.js';
import { AskNote } from '../components/AskNote.js';
import { Badge, CmdLine, EmptyState, Pips } from '../components/bits.js';
import { ConfirmDialog } from '../components/Dialog.js';
import { rowOpen } from '../components/Table.js';
import { copyText } from '../dom.js';
import { approx, GLUED_SEPARATOR, glued, num, shortId, wholeCounts } from '../format.js';
import { navigate } from '../router.js';
import { useApp } from '../state.js';
import type { FixDetail, VerifyStep } from '../types.js';
import type { VerifiedRunGroups } from '../../src/attempt-groups.js';
import { runOutcomeWord, verdictWord } from '../../../engine/src/verdict-words.js';
import { ACTIONS } from '../labels.js';
import { AttemptGroups, useAttemptGroups } from './AttemptGroups.js';
import { useFixEstimates, verifyPrice } from './estimates.js';
import { FixJobButton } from './FixJobButton.js';
import { keepAt, moreLine, outcomeTone, tokens, verdictTone, verifyFor } from './model.js';

/**
 * The Verify step: one change verified at a time (a switch between them, each with its own URL and
 * named by what changed), its verdict and oracle, each run's role and outcome, what the change does
 * to tokens and cost per run, and what finding out took. It opens on the newest verdict that counts
 * for the fix; one that doesn't is drawn plain, headed with why, and marked so in the switch. A
 * verdict left incomplete is amber, as inconclusive is everywhere, and leads with what settles it:
 * Run more attempts, or Verify again, the line under it saying what that takes.
 */
export function VerifyStepView({ fix, sub }: { fix: FixDetail; sub: string | null }) {
  const groups = useAttemptGroups(fix.fixId);
  // What Run more attempts or Verify again would cost: the fix's estimates, one read with its header's.
  const prices = useFixEstimates(fix);
  const v = verifyFor(fix, sub);
  if (!v)
    return (
      <EmptyState
        title="Not verified yet"
        text="verify checks a change on the failing runs, on failures it was not written against, and on runs that worked, before it ships. A repair runs it for you."
        command={fix.commands.verify}
      />
    );
  return (
    <>
      {fix.verify.length > 1 ? (
        <div className="vpick seg" role="group" aria-label="Changes verified">
          {fix.verify.map((x) => (
            // Links to each verdict's own page: the one shown is the current one, never a pressed button.
            <a key={x.verifyId} href={x.href} aria-current={x.verifyId === v.verifyId ? 'page' : undefined}>
              {glued(keepAt(x.label))}
            </a>
          ))}
        </div>
      ) : null}
      <Verdict v={v} fixId={fix.fixId} estimate={verifyPrice(prices, v.verifyId)} />
      {/* What the lead step will do, in one line; the run's row and the drawer say the rest. */}
      {lead(v) ? (
        <p className="fxreceipt vmore">
          <code className="rnm">{shortId(v.more!.run.runId)}</code>
          {moreLine(v.more!)
            .split(/(--[a-z][a-z-]*(?: [\d.]+)?)/)
            .map((part, i) => (i % 2 ? <code key={i} className="nw">{part}</code> : wholeCounts(part)))}
        </p>
      ) : null}
      {v.verdict !== 'accepted' && v.reasons.length && !lead(v) ? (
        <ul className="fxwarn bad">
          {/* What the change failed in red; a run it could not settle, inconclusive or not settled, in amber. */}
          {v.reasons.map((r) => (
            <li key={r} className={v.unsettled.includes(r) ? 'unsure' : undefined}>
              {r}
            </li>
          ))}
        </ul>
      ) : null}
      <section className="panel tscroll">
        <table className="t">
          <thead>
            <tr>
              <th>Role</th>
              <th>Run</th>
              <th>Attempts</th>
              <th>Outcome</th>
              <th>Where it went</th>
            </tr>
          </thead>
          <tbody>
            {v.rows.map((x) => (
              <tr key={`${x.role}:${x.runId}`} {...rowOpen(() => navigate(x.href))}>
                <td>
                  <b className="fxrole">{x.role}</b>
                </td>
                <td>
                  <a className="rowa" href={x.href}>
                    <code>{shortId(x.runId)}</code>
                  </a>
                </td>
                <td>
                  <Pips ok={x.passes} unsure={x.inconclusive} no={x.attempts - x.passes - x.inconclusive} />{' '}
                  <span className="fxof">
                    {x.passes} of {x.attempts - x.inconclusive}
                    {x.inconclusive ? <span className="fxdim"> · {x.inconclusive} not judged</span> : null}
                    {x.rate?.bound ? (
                      <span className="fxdim" title={x.evidence?.method ? `the bound: ${x.evidence.method}` : undefined}>
                        {' '}
                        · {x.rate.bound}
                      </span>
                    ) : null}
                    {x.evidence?.unavailable ? <span className="fxdim"> · {x.evidence.unavailable} unavailable</span> : null}
                  </span>
                </td>
                <td>
                  <Badge tone={outcomeTone(x.outcome)}>{runOutcomeWord(x.outcome)}</Badge>
                </td>
                <td className="fxwhere">
                  {x.note}
                  {/* Kept against the run's own baseline, with the bound on its drop as the CLI says it, when verify's JSON says so. */}
                  {x.evidence?.baseline ? (
                    <span className="fxbase" title={x.evidence.margin !== null ? `Kept unless its pass rate drops ${Math.round(x.evidence.margin * 100)} points or more below its baseline’s` : undefined}>
                      baseline {x.evidence.baseline.passes} of {x.evidence.baseline.attempts}
                      {x.evidence.baseline.source === 'paired' ? `, paired${x.evidence.baseline.revision ? ` at ${x.evidence.baseline.revision}` : ''}` : ', from history'}
                      {x.evidence.drop ? ` · ${x.evidence.drop}` : x.evidence.margin !== null ? ` · margin ${x.evidence.margin}` : ''}
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <VerifyGroups runs={groups?.verify.find((g) => g.verifyId === v.verifyId)?.runs ?? null} />
      <Deltas v={v} />
      {/* An incomplete verdict found nothing out, so its receipt says what it spent and no more. */}
      <p className="fxreceipt">
        {num(v.attempts)} attempt{v.attempts === 1 ? '' : 's'} · {num(v.upstreamRequests)} upstream request{v.upstreamRequests === 1 ? '' : 's'} · {approx(v.spent)} spent{v.verdict === 'incomplete' ? '' : ' to find out before it shipped'}. A run whose replay doesn’t fork settles in one free attempt.
        {v.unknownModels.length ? ` No price for ${v.unknownModels.join(', ')}.` : ''}
      </p>
      {/* A teammate's verdict: its command line stays theirs; the one here is made from its report. */}
      {v.pulled ? <p className="fxnote">It ran on a teammate’s machine and came with a pull. The command here is made from its report, without what ran only there.</p> : null}
      <CmdLine>{v.command}</CmdLine>
      {v.warnings.length ? (
        <ul className="fxwarn">
          {v.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/** Whether a verdict leads with what settles it: one that counts for the fix, left incomplete, that the page can settle. */
const lead = (v: VerifyStep): boolean => v.counts && v.verdict === 'incomplete' && !!v.more;

function Verdict({ v, fixId, estimate }: { v: VerifyStep; fixId: string; estimate: Estimate | null | undefined }) {
  const { toast } = useApp();
  // One that doesn't count for the fix is no verdict on it: plain, whatever it said of its own check.
  const tone = v.counts ? verdictTone(v.verdict) : 'n';
  const more = lead(v) ? v.more! : null;
  return (
    <div className={`verdict ${tone}`}>
      <Badge tone={tone === 'warn' ? 'y' : tone}>{verdictWord(v.verdict)}</Badge>
      <div>
        <h2>{v.headline}</h2>
        <p>
          {glued(keepAt(v.code))}
          {GLUED_SEPARATOR}
          {v.oracle}
        </p>
        {/* Only a verdict that counts carries a note: rejected after the fix was applied. */}
        {v.note ? <p className="fxbad">{v.note}</p> : null}
      </div>
      <div className="actions">
        {more ? (
          <FixJobButton
            kind={JOB_KINDS.verify}
            fields={{ fixId, verifyId: v.verifyId }}
            label={more.kind === 'more' ? ACTIONS.runMoreAttempts.label : ACTIONS.verifyAgain.label}
            verb={more.kind === 'more' ? 'run more attempts' : 'verify again'}
            lead
            className="btn sm"
            tip={verifyTip(more)}
            command={more.command}
            estimate={estimate}
            ask={(start, close) => <VerifyAsk more={more} attempts={v.attempts} estimate={estimate} onRun={() => start({})} onClose={close} />}
          />
        ) : null}
        <button className="btn sm" type="button" onClick={() => void copyText(v.command).then((ok) => toast(ok ? 'Copied the command' : 'Copying was refused by the browser'))}>
          Copy command
        </button>
      </div>
    </div>
  );
}

/** What Run more attempts or Verify again does, on its card and as its ask's lead. */
const verifyTip = (more: NonNullable<VerifyStep['more']>): string => (more.kind === 'more' ? `Verifies the change again from the start, up to ${more.max} attempts a run` : 'Verifies the same runs again from the start, once the check can be judged');

/** Run more attempts' lead: verify has no --continue, so the attempts so far start over. */
const moreLead = (attempts: number): string => `Verifies the change again from the first attempt: the ${attempts.toLocaleString('en-US')} so far ${attempts === 1 ? 'doesn’t' : 'don’t'} carry over.`;

/** Run more attempts' or Verify again's ask, above the threshold or with no estimate: what it runs, and its Cost line the estimate. */
function VerifyAsk({ more, attempts, estimate, onRun, onClose }: { more: NonNullable<VerifyStep['more']>; attempts: number; estimate: Estimate | null | undefined; onRun: () => boolean; onClose: () => void }) {
  const label = more.kind === 'more' ? ACTIONS.runMoreAttempts.label : ACTIONS.verifyAgain.label;
  const lead = more.kind === 'more' ? moreLead(attempts) : 'Verifies the same runs again from the first attempt, once the judge answers.';
  return <ConfirmDialog title={label} lead={lead} doc="verify" command={more.command} cost={{ price: 'Billed by your provider', estimate }} footNote={<AskNote estimate={estimate} />} ok={label} onOk={onRun} onClose={onClose} />;
}

/**
 * Tokens and cost per run, as it would run live, as verify prints them: one quiet receipt line, never
 * figures bigger than the verdict ("per run, as it would run live: 4,329 → 5,193 input tokens (+20%)
 * · ≈$0.015 → ≈$0.018 (+16%)").
 */
function Deltas({ v }: { v: VerifyStep }) {
  if (!v.tokens && !v.cost) return null;
  return (
    <p className="fxreceipt">
      <span className="nw">per run, as it would run live:</span>{' '}
      {v.tokens ? `${tokens(v.tokens.before)} → ${tokens(v.tokens.after)} input tokens (${v.tokens.change})` : 'no attempt ran live'}
      {GLUED_SEPARATOR}
      <span className="nw">{v.cost ? `${approx(v.cost.before)} → ${approx(v.cost.after)} (${v.cost.change})` : 'no price for the model'}</span>
    </p>
  );
}

/** Each run's attempts grouped by what each did, for a run that made more than one. */
function VerifyGroups({ runs }: { runs: readonly VerifiedRunGroups[] | null }) {
  const shown = (runs ?? []).filter((r) => r.groups.length > 1);
  if (!shown.length) return null;
  return (
    <section className="panel fxgap" aria-label="What the attempts did">
      <header>
        <h2>What the attempts did</h2>
        <span className="sub">grouped by the tool calls each made from where it left its run, and how it came out</span>
      </header>
      <div className="pbody">
        {shown.map((r) => (
          <div key={`${r.role}:${r.runId}`} className="fxbundle">
            <span className="k">
              {r.role} <code>{shortId(r.runId)}</code>
            </span>
            <AttemptGroups groups={r.groups} attempts={r.attempts} label={`${r.role} run ${shortId(r.runId)}`} />
          </div>
        ))}
      </div>
    </section>
  );
}
