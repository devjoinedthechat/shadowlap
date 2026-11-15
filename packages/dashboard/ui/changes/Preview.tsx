import { Fragment, useEffect, useLayoutEffect } from 'react';
import { ApiError } from '../api.js';
import { ActionButton } from '../components/ActionButton.js';
import { CodeBox } from '../components/CodeBox.js';
import { asWords, Copy, Words } from '../components/Copy.js';
import { tipCard } from '../components/HoverCard.js';
import { Link } from '../components/Link.js';
import { MigrateButton } from '../components/MigrateDialog.js';
import { NewPreviewMenu, NO_GOLDENS, PreviewWayButtons, usePreviewDialog } from '../components/NewPreviewMenu.js';
import { EmptyState, ErrorState, failedRead, Skeleton } from '../components/States.js';
import { glossed } from '../components/Term.js';
import { VerdictLine } from '../components/VerdictLine.js';
import { forgetPreviewSession, notePreviewSession } from '../changes-tab.js';
import { nextStep, verdictState } from '../decisions.js';
import { shortId } from '../format.js';
import { useLoad } from '../hooks.js';
import { PREVIEW_ASK } from '../page-ask.js';
import { href } from '../route.js';
import { Unshown } from '../shell/unshown.js';
import { useApp } from '../state.js';
import type { Tone } from '../components/Status.js';
import type { PreviewSession, PreviewView } from '../types.js';
import { DecisionCellPanel, openCell, openedCell } from './DecisionCell.js';
import { moreTip, PreviewVerifyButton, type VerifyRow } from './VerifyAsk.js';
import { DecisionMatrix } from './DecisionMatrix.js';
import { SessionPicker } from './SessionPicker.js';

/**
 * Changes › Preview: what a change decides differently at each model call of your recorded runs,
 * before it ships (`shadowlap decisions`). The previews picker, the verdict in main's words with
 * its one next step, the matrix with its key and receipt, and the command. The bare address opens the
 * newest preview; the tab, the nav and Go to come back to the one last shown (changes-tab.ts).
 */

/** How many previews the picker lists: the most the server reads, the filter finding the rest. */
const LISTED = 200;

/**
 * `onMissing` hears that the session the address names isn't in this store, with the read that
 * found it so: the page then asks whether another project holds it (pages/Changes.tsx).
 */
export function PreviewTab(props: PreviewTabProps) {
  return (
    <>
      <PaletteAsks />
      <PreviewBody {...props} />
    </>
  );
}

interface PreviewTabProps {
  id: string | null;
  run: string | null;
  call: number | null;
  onMissing?: (error: Error) => void;
}

/** The palette's Preview model switch… and Preview changed prompt: the way's dialog on every golden, as the tab shows or at once where it shows already. */
function PaletteAsks() {
  const dialog = usePreviewDialog(EVERY_GOLDEN);
  const { open } = dialog;
  useEffect(() => {
    const offs = PALETTE_WAYS.map((way) => {
      if (PREVIEW_ASK.take(way)) open(way);
      return PREVIEW_ASK.on(() => open(way), way);
    });
    return () => offs.forEach((off) => off());
  }, [open]);
  return dialog.dialog;
}

/** The ways the palette asks Preview for. */
const PALETTE_WAYS = ['model', 'code'] as const;

function PreviewBody({ id, run, call, onMissing }: PreviewTabProps) {
  const { client, feeds } = useApp();
  const list = useLoad(() => client.decisionSessions('decisions', LISTED), 'decision-sessions', `${feeds.decisions ?? 0}`);
  const sessions = list.data?.sessions;
  const shownId = id ?? sessions?.[0]?.sessionId ?? null;
  const detail = useLoad(() => (shownId ? client.decisionSession(shownId) : null), `decision-session:${shownId ?? ''}`, `${feeds.decisions ?? 0}`);
  const gone = detail.error instanceof ApiError && detail.error.status === 404;
  const session = detail.data;
  useEffect(() => {
    if (session && session.kind === 'decisions') notePreviewSession(session.sessionId);
    else if (gone) forgetPreviewSession();
  }, [session, gone, shownId]);
  // Before the not-found line paints, so the page that asks elsewhere takes its place without a flash.
  useLayoutEffect(() => {
    if (gone && id && detail.error) onMissing?.(detail.error);
  }, [gone, id, detail.error, onMissing]);
  if (list.error && !list.data) return <ErrorState retry={list.reload}>{failedRead(list.error)}</ErrorState>;
  if (!sessions) return <Skeleton what="the previews" lines={8} />;
  if (!shownId) return <NoPreview goldens={list.data!.goldens} />;
  if (gone || (session && session.kind !== 'decisions'))
    return (
      <div className="empty tall">
        <Unshown at={`changes:${shownId}`} />
        No preview {shownId}. <Link href={href.changeSession('decisions')}>Open Preview</Link>
      </div>
    );
  if (detail.error && !session) return <ErrorState retry={detail.reload}>{failedRead(detail.error)}</ErrorState>;
  if (!session) return <Skeleton what="this preview" lines={8} />;
  const opened = openedCell(session, run, call);
  return (
    <>
      <div className="chbar">
        <SessionPicker kind="decisions" sessions={sessions} shown={session} more={list.data!.more} />
        <span className="sp" />
        <NewPreviewMenu target={{ goldens: 'all', count: list.data!.goldens }} lime={anotherChange(session.view)} why={list.data!.goldens ? null : NO_GOLDENS} />
      </div>
      <Verdict session={session} />
      <DecisionMatrix session={session} open={opened ? { run: opened.row.runId, call: opened.callNo } : null} onOpen={(r, c, current) => openCell('decisions', session.sessionId, r, c, current)} />
      {opened ? <DecisionCellPanel key={`${opened.row.runId}:${opened.callNo}`} session={session} row={opened.row} callNo={opened.callNo} /> : null}
      <CodeBox command={session.view.command} className="chcmd" />
    </>
  );
}

/** No preview kept: what one is, and the command that makes one; with no goldens, what to pack first. */
function NoPreview({ goldens }: { goldens: number }) {
  const text = 'Each recorded model call is asked again with only the change swapped in, and its decision compared with the recorded one. No tool runs, so nothing reaches the world.';
  if (!goldens)
    return (
      <EmptyState title="Preview a change on your goldens" text={text}>
        <Copy className="emptyline">
          {NO_GOLDENS} <Link href={href.runs()}>Open Runs</Link>
        </Copy>
      </EmptyState>
    );
  return <EmptyState title="Preview a change on your goldens" text={text} step={<PreviewWayButtons target={EVERY_GOLDEN} />} command="shadowlap decisions goldens/* --model <model>" />;
}

const EVERY_GOLDEN = { goldens: 'all' } as const;

/** Another change is the next step once verify rejected the shown preview's and left nothing to verify or attempt: New preview turns lime. */
const anotherChange = (v: PreviewSession['view']): boolean => verdictState(v) === 'verified' && v.verdict.word === 'rejected' && !nextStep(v.next);

const VERIFY_TONE: Record<string, Tone> = { accepted: 'ok', rejected: 'err', inconclusive: 'warn' };

/** The verdict in main's words: before verify the runs it flags lead in their colour; once verify ran, its word and head; the lines under it. */
function Verdict({ session }: { session: PreviewSession }) {
  const v = session.view;
  const h = v.headline;
  const whole = `${h.lead}${h.rest}${h.detail}`;
  const state = verdictState(v);
  const [word, tone, heading] =
    state === 'flagged'
      ? [h.lead, v.verdict.flaggedRank === 1 ? 'err' : 'warn', `${h.rest}${h.detail}`.trim()]
      : state === 'unverified'
        ? ['not verified', 'warn', whole]
        : state === 'unsettled'
          ? ['inconclusive', 'warn', v.verdict.line]
          : state === 'verified' && v.verify
            ? [v.verify.word, VERIFY_TONE[v.verify.word] ?? 'warn', v.verify.head]
            : ['nothing to verify', 'mu', whole];
  return <VerdictLine word={word} tone={tone as Tone} facts={<VerdictFacts v={v} state={state} />} actions={<NextStepButton session={session} />} className="dverdict">{heading}</VerdictLine>;
}

/** What the verdict says under it: before verify, the runs that couldn't be asked, the within-variation line and the steps line; once verify ran, the headline again, each rule once, what it says of the runs, its warnings and how many it ran end to end. */
function VerdictFacts({ v, state }: { v: PreviewView; state: ReturnType<typeof verdictState> }) {
  const h = v.headline;
  const later = v.later ? (
    <span className="vlater" tabIndex={0} data-tip={tipCard(v.later.title, [], v.later.card)}>
      {v.later.text}
    </span>
  ) : null;
  if (state === 'verified' && v.verify) {
    const f = v.verify;
    return (
      <>
        <span className="pline">
          <Words>{`${h.lead}${h.rest}${h.detail}`}</Words>
        </span>
        {v.within ? <span className="pline">{asWords(v.within)}</span> : null}
        {f.rules.map((r) => (
          <span key={r.rule ?? ''} className="pline">
            {glossed(r.rule ?? '')}
            {f.rules.length > 1 ? `: ${r.runs.map(shortId).join(', ')}` : ''}
          </span>
        ))}
        {[...f.reasons, ...f.warnings].map((w) => (
          <span key={w} className="pline dsy">
            {w}
          </span>
        ))}
        <span className="pline">{asWords(f.count)}</span>
        {later ? <span className="pline">{asWords(later)}</span> : null}
      </>
    );
  }
  const steps = [v.steps.text, ...v.steps.tail];
  return (
    <>
      {h.unasked && state !== 'unsettled' ? <span className="pline dsy">{h.unasked}</span> : null}
      {v.within ? <span className="pline">{asWords(v.within)}</span> : null}
      <span className="pline">
        <span tabIndex={v.steps.notes.length ? 0 : undefined} data-tip={v.steps.notes.length ? tipCard(v.steps.text, v.steps.notes.map((n, i) => ({ label: `${i + 1}`, value: n }))) : undefined}>
          {steps.map((s, i) => (
            <Fragment key={s}>
              {i ? '\u00a0· ' : null}
              {asWords(s)}
            </Fragment>
          ))}
        </span>
        {later ? <>{`\u00a0· `}{asWords(later)}</> : null}
      </span>
    </>
  );
}

/** The runs a verify takes, as its dialog lists them: the matrix's rows, with what verify found of each for Run more attempts. */
const verifyRows = (session: PreviewSession, runs: readonly string[], found: boolean): VerifyRow[] =>
  session.matrix.filter((r) => runs.includes(r.runId)).map((r) => ({ runId: r.runId, golden: r.golden, about: r.about?.text ?? null, verified: found ? r.verified : null }));

/** The one lime next step: Verify the runs left to verify, Run more attempts or Verify again on those verify left open, the report of a migration of the same switch, or Migrate to the model switched to. */
function NextStepButton({ session }: { session: PreviewSession }) {
  const v = session.view;
  const id = session.sessionId;
  const step = nextStep(v.next);
  if (!step) return null;
  if (step.kind === 'more') {
    const more = v.next.more!;
    const rows = verifyRows(session, step.runs, true);
    return <PreviewVerifyButton sessionId={id} change={v.change} rows={rows} label={step.label} more={more} lime tip={moreTip(more, { one: rows.length === 1 })} />;
  }
  if (step.kind === 'verify') {
    const named = step.every ? '' : ` ${step.runs.map(shortId).join(' ')}`;
    const command = `shadowlap decisions --verify ${id}${named}`;
    // A run gone from the store can't be verified (the server refuses it): Verify waits, saying why, as a job that can't start does.
    if (step.gone)
      return (
        <ActionButton className="btn lime" why={`${step.gone === 1 ? 'A run' : `${step.gone} runs`} this preview left to verify ${step.gone === 1 ? 'is' : 'are'} no longer in the store`} tip="Each runs end to end under the change, writes stubbed, until verify’s gate decides" command={`$ ${command}`}>
          {step.label}
        </ActionButton>
      );
    return <PreviewVerifyButton sessionId={id} change={v.change} rows={verifyRows(session, step.runs, false)} every={step.every} label={step.label} lime tip="Each runs end to end under the change, writes stubbed, until verify’s gate decides" />;
  }
  if (step.kind === 'report')
    return (
      <a className="btn lime" href={href.changeSession('migrate', step.sessionId)}>
        {step.label}
      </a>
    );
  return <MigrateButton s={{ from: step.from, to: step.to, goldens: step.goldens, runs: step.runs }} label={step.label} lime />;
}
