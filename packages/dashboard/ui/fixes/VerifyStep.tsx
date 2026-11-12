import { Fragment, useRef, useState } from 'react';
import { JOB_KINDS } from '../api.js';
import { type Attempt, AttemptList, AttemptsCell } from '../components/AttemptsCell.js';
import { EmptyState } from '../components/bits.js';
import { CodeBox } from '../components/CodeBox.js';
import { Copy } from '../components/Copy.js';
import { DotParts } from '../components/DotParts.js';
import { Id } from '../components/Id.js';
import { Status } from '../components/Status.js';
import { rowOpen } from '../components/Table.js';
import { VerdictLine } from '../components/VerdictLine.js';
import type { FixEstimates } from '../estimates-api.js';
import { approx, GLUED_SEPARATOR, glued, num, shortId, wholeCounts } from '../format.js';
import { useListKeys } from '../list-keys.js';
import { navigate } from '../router.js';
import type { FixDetail, VerifyRow, VerifyStep } from '../types.js';
import type { VerifiedRunGroups } from '../../src/attempt-groups.js';
import { runOutcomeWord, verdictWord } from '../../../engine/src/verdict-words.js';
import { AttemptGroups, useAttemptGroups } from './AttemptGroups.js';
import { useFixEstimates } from './estimates.js';
import { FixJobButton } from './FixJobButton.js';
import { keepAt, moreLine, outcomeTone, tokens, verdictTone, verifyFor } from './model.js';
import { verifyLeftCard } from './lead.js';
import { leftLabel, VerifyLeftAsk } from './verify-asks.js';

/**
 * The Verify step: one change verified at a time (a switch between them, each with its own URL and
 * named by what changed), its verdict line and oracle, each run's role, outcome and attempts, the
 * failing runs an accepted verdict left out, what answered the tool calls after the fork, what the
 * change does to tokens and cost per run, and what finding out took. It opens on the newest verdict
 * that counts for the fix; one that doesn't is drawn muted, headed with why, and marked so in the
 * switch. A verdict left incomplete is amber, as inconclusive is everywhere, and the page leads with
 * what settles it (Run more attempts, or Verify again: the header's lime button), the line under
 * the verdict saying what that takes.
 */
export function VerifyStepView({ fix, sub }: { fix: FixDetail; sub: string | null }) {
  const groups = useAttemptGroups(fix.fixId);
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
      <Verdict v={v} />
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
      <Runs v={v} groups={groups?.verify.find((g) => g.verifyId === v.verifyId)?.runs ?? null} />
      <LeftOut fix={fix} v={v} />
      <Receipts v={v} />
    </>
  );
}

/** Whether a verdict leads with what settles it: one that counts for the fix, left incomplete, that the page can settle. */
const lead = (v: VerifyStep): boolean => v.counts && v.verdict === 'incomplete' && !!v.more;

/**
 * The verdict line: its word in its colour (accepted lime, rejected red, inconclusive amber; muted
 * for one that doesn't count for the fix), its headline, and what it checked under them, with a
 * note when it was rejected after the fix was applied. What settles one left incomplete is the
 * header's lime button (FixPage.tsx `FixActions`); its command is the box at the foot.
 */
function Verdict({ v }: { v: VerifyStep }) {
  return (
    <VerdictLine
      word={verdictWord(v.verdict)}
      tone={v.counts ? verdictTone(v.verdict) : 'mu'}
      className="sv"
      facts={
        <>
          {glued(keepAt(v.code))}
          {GLUED_SEPARATOR}
          {v.oracle}
          {/* Only a verdict that counts carries a note: rejected after the fix was applied. */}
          {v.note ? <span className="pline fxbad">{v.note}</span> : null}
        </>
      }
    >
      {v.headline}
    </VerdictLine>
  );
}

/**
 * Each run: its role, its id, its outcome a status, its tally and bound in one Attempts cell with
 * its interval against the gate's marks (an attempt not judged in amber, with no bar), and where it
 * went. Its attempts, and what they did, show under it on request; j and k walk the runs.
 */
function Runs({ v, groups }: { v: VerifyStep; groups: readonly VerifiedRunGroups[] | null }) {
  const box = useRef<HTMLElement>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const keyOf = (x: VerifyRow) => `${x.role}:${x.runId}`;
  const inFocus = useListKeys({ rows: v.rows, keyOf, root: box, open: (x) => navigate(x.href) });
  const toggle = (key: string, on: boolean) =>
    setOpen((was) => {
      const next = new Set(was);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  return (
    <section className="panel sec tscroll vtable" ref={box}>
      <table className="t vruns">
          <thead>
            <tr>
              <th>Role</th>
              <th>Run</th>
              <th>Outcome</th>
              <th>Attempts</th>
              <th>Where it went</th>
            </tr>
          </thead>
          <tbody>
            {v.rows.map((x) => (
              <RunRow
                key={keyOf(x)}
                v={v}
                x={x}
                focus={inFocus === keyOf(x)}
                open={open.has(keyOf(x))}
                onToggle={(on) => toggle(keyOf(x), on)}
                groups={groups?.find((g) => g.role === x.role && g.runId === x.runId) ?? null}
              />
            ))}
          </tbody>
      </table>
    </section>
  );
}

function RunRow({ v, x, focus, open, onToggle, groups }: { v: VerifyStep; x: VerifyRow; focus: boolean; open: boolean; onToggle: (open: boolean) => void; groups: VerifiedRunGroups | null }) {
  const listId = `vrun-${v.verifyId}-${x.role}-${x.runId}`;
  const attempts: Attempt[] = x.tries;
  const tone = outcomeTone(x.outcome);
  return (
    <>
      <tr className={[open ? 'open' : '', focus ? 'krow' : ''].filter(Boolean).join(' ') || undefined} data-rowkey={`${x.role}:${x.runId}`} {...rowOpen(() => navigate(x.href))}>
        <td className="vr">
          <b className="fxrole">{x.role}</b>
        </td>
        <td className="vid">
          <Id id={shortId(x.runId)} href={x.href} className="rowa" />
        </td>
        <td className="vo">
          <Status tone={tone}>{runOutcomeWord(x.outcome)}</Status>
        </td>
        <td className="va">
          <AttemptsCell tally={x.tally} note={x.cutShort} bound={x.bound} boundTitle={x.evidence?.method && !x.evidence.baseline ? `the bound: ${x.evidence.method}` : undefined} interval={x.interval} marks={v.marks ?? []} tone={tone} attempts={attempts} open={open} onToggle={onToggle} listId={listId} />
          {x.evidence?.unavailable ? <span className="fxdim"> · {x.evidence.unavailable} unavailable</span> : null}
        </td>
        <td className="vnote fxwhere">
          {x.note}
          {/* Kept against the run's own baseline, when verify's JSON says so: where the baseline came from, its margin on hover. Its tally and the bound on the drop are the Attempts cell's; a report kept before that bound was gives its margin, as it said it. */}
          {x.evidence?.baseline ? (
            <span className="fxbase" title={x.evidence.margin !== null ? `Kept unless its pass rate drops ${Math.round(x.evidence.margin * 100)} points or more below its baseline’s` : undefined}>
              baseline {x.evidence.baseline.source === 'paired' ? `paired${x.evidence.baseline.revision ? ` at ${x.evidence.baseline.revision}` : ''}` : 'from history'}
              {!x.evidence.drop && x.evidence.margin !== null ? ` · margin ${x.evidence.margin}` : ''}
            </span>
          ) : null}
        </td>
      </tr>
      {open && attempts.length ? (
        <tr className="sub">
          <td colSpan={5}>
            <div id={listId}>
              {groups && groups.groups.length > 1 ? <AttemptGroups groups={groups.groups} attempts={groups.attempts} label={`${x.role} run ${shortId(x.runId)}`} /> : null}
              <AttemptList attempts={attempts} />
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}


/**
 * The failing runs of the fix an accepted verdict left out (`left`), each with its about line on
 * hover: `01M3RXQ4VB wasn’t in this verify`. While the change is in the working tree, either what
 * the header's Verify this run (or Verify these runs) does, when it leads, by the name the header
 * gives it, or a small one of the step's own.
 */
function LeftOut({ fix, v }: { fix: FixDetail; v: VerifyStep }) {
  const prices = useFixEstimates(fix);
  if (!v.left.length) return null;
  const left = fix.actions.verifyLeft;
  const can = !!left;
  const inHead = can && fix.lead?.key === 'verify-left';
  return (
    <p className="vleft">
      <span>
        {v.left.map((x, i) => (
          <Fragment key={x.runId}>
            {i ? ', ' : ''}
            <Id id={shortId(x.runId)} href={x.href} about={x.about} />
          </Fragment>
        ))}{' '}
        wasn’t in this verify
        {left && inHead ? `: ${leftLabel(left.runs)} checks the code as it is now on ${v.left.length > 1 ? 'them' : 'it'}.` : can ? ' ·' : null}
      </span>
      {can && !inHead ? <VerifyLeftButton fix={fix} prices={prices} lead={false} small /> : null}
    </p>
  );
}

/**
 * Verify this run, on the header (`lead`, lime when it is the fix's next step) or small on the Verify
 * step: the failing runs no accepted verdict checked, verified on the code as it is now, priced on
 * the fix's estimates and asking by Spending's rule (`VerifyLeftAsk`).
 */
export function VerifyLeftButton({ fix, prices, lead, small = false }: { fix: FixDetail; prices: FixEstimates | null | undefined; lead: boolean; small?: boolean }) {
  const left = fix.actions.verifyLeft;
  if (!left) return null;
  const estimate = prices === undefined ? undefined : (prices?.verifyLeft ?? null);
  return (
    <FixJobButton
      kind={JOB_KINDS.verify}
      fields={{ fixId: fix.fixId, left: true }}
      label={leftLabel(left.runs)}
      verb="verify it"
      lead={lead}
      // On the step, beside the ids it names: its card says what it does, with no ids again.
      tip={small ? `Verifies the code as it is now on the run${left.runs.length === 1 ? '' : 's'} this change wasn’t verified on` : verifyLeftCard(left.runs)}
      command={left.command}
      className={small ? 'btn sm' : 'btn'}
      estimate={estimate}
      ask={(begin, close) => <VerifyLeftAsk left={left} estimate={estimate} onRun={() => begin({})} onClose={close} />}
    />
  );
}

/**
 * What verify printed under its runs, in its order: its warnings, what answered the tool calls after
 * the fork, tokens and cost per run, then what finding out took, the judge's checks apart, and the
 * command. An incomplete verdict found nothing out, so its line says what it spent and no more.
 */
function Receipts({ v }: { v: VerifyStep }) {
  const parts = [`${num(v.attempts)} attempt${v.attempts === 1 ? '' : 's'}`, `${num(v.upstreamRequests)} upstream request${v.upstreamRequests === 1 ? '' : 's'}`, `${approx(v.spent)} spent${v.verdict === 'incomplete' ? '' : ' to find out before it shipped'}`];
  if (v.judge) parts.push(`judge checks: ${num(v.judge.upstreamRequests)} upstream request${v.judge.upstreamRequests === 1 ? '' : 's'}, ${approx(v.judge.spent)}`);
  return (
    <>
      {v.warnings.length ? (
        <ul className="fxwarn">
          {v.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}
      {/* What answered the tool calls after the fork, in the CLI report's words; none when no attempt made one. */}
      {v.afterFork ? <Copy className="fxreceipt fxafter">{v.afterFork}</Copy> : null}
      <Deltas v={v} />
      <p className="fxreceipt">
        <DotParts parts={parts} />. A run whose replay doesn’t fork settles in one free attempt.
        {v.unknownModels.length ? ` No price for ${v.unknownModels.join(', ')}.` : ''}
      </p>
      {/* A teammate's verdict: its command line stays theirs; the one here is made from its report. */}
      {v.pulled ? <Copy className="fxnote">It ran on a teammate’s machine and came with a pull. The command here is made from its report, without what ran only there.</Copy> : null}
      <CodeBox command={v.command} />
    </>
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
