import { JOB_KINDS } from '../api.js';
import { Badge, CmdLine, EmptyState, Pips } from '../components/bits.js';
import { rowOpen } from '../components/Table.js';
import { copyText } from '../dom.js';
import { approx, GLUED_SEPARATOR, glued, num, shortId, wholeCounts } from '../format.js';
import { navigate } from '../router.js';
import { useApp } from '../state.js';
import type { FixDetail, VerifyStep } from '../types.js';
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
            <a key={x.verifyId} href={x.href} aria-pressed={x.verifyId === v.verifyId}>
              {glued(keepAt(x.label))}
            </a>
          ))}
        </div>
      ) : null}
      <Verdict v={v} fixId={fix.fixId} />
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
              <tr key={`${x.role}:${x.runId}`} onClick={rowOpen(() => navigate(x.href))}>
                <td>
                  <b className="fxrole">{x.role}</b>
                </td>
                <td>
                  <a className="fxcall" href={x.href}>
                    <code>{shortId(x.runId)}</code>
                  </a>
                </td>
                <td>
                  <Pips ok={x.passes} unsure={x.inconclusive} no={x.attempts - x.passes - x.inconclusive} />{' '}
                  <span className="fxof">
                    {x.passes} of {x.attempts - x.inconclusive}
                    {x.inconclusive ? <span className="fxdim"> · {x.inconclusive} not judged</span> : null}
                    {x.rate?.bound ? <span className="fxdim"> · {x.rate.bound}</span> : null}
                  </span>
                </td>
                <td>
                  <Badge tone={outcomeTone(x.outcome)}>{x.outcome}</Badge>
                </td>
                <td className="fxwhere">{x.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <Deltas v={v} />
      {/* An incomplete verdict found nothing out, so its receipt says what it spent and no more. */}
      <p className="fxreceipt">
        {num(v.attempts)} attempt{v.attempts === 1 ? '' : 's'} · {num(v.upstreamRequests)} upstream request{v.upstreamRequests === 1 ? '' : 's'} · {approx(v.spent)} spent{v.verdict === 'incomplete' ? '' : ' to find out before it shipped'}. A run whose replay doesn’t fork settles in one free attempt.
        {v.unknownModels.length ? ` No price for ${v.unknownModels.join(', ')}.` : ''}
      </p>
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

function Verdict({ v, fixId }: { v: VerifyStep; fixId: string }) {
  const { toast } = useApp();
  // One that doesn't count for the fix is no verdict on it: plain, whatever it said of its own check.
  const tone = v.counts ? verdictTone(v.verdict) : 'n';
  const more = lead(v) ? v.more! : null;
  return (
    <div className={`verdict ${tone}`}>
      <Badge tone={tone === 'warn' ? 'y' : tone}>{v.verdict}</Badge>
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
            label={more.kind === 'more' ? 'Run more attempts' : 'Verify again'}
            verb={more.kind === 'more' ? 'run more attempts' : 'verify again'}
            lead
            className="btn sm"
            tip={more.kind === 'more' ? `Verifies the change again from the start, up to ${more.max} attempts a run` : 'Verifies the same runs again from the start, once the check can be judged'}
            command={more.command}
          />
        ) : null}
        <button className="btn sm" type="button" onClick={() => void copyText(v.command).then((ok) => toast(ok ? 'Copied the command' : 'Copying was refused by the browser'))}>
          Copy command
        </button>
      </div>
    </div>
  );
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
