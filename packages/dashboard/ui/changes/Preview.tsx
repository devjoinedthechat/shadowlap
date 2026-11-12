import { Fragment, useEffect, useLayoutEffect, useMemo } from 'react';
import { ApiError } from '../api.js';
import { ActionButton } from '../components/ActionButton.js';
import { AskNote } from '../components/AskNote.js';
import { CodeBox } from '../components/CodeBox.js';
import { ConfirmDialog } from '../components/Dialog.js';
import { tipCard } from '../components/HoverCard.js';
import { Icon } from '../components/Icon.js';
import { Link } from '../components/Link.js';
import { MigrateAsk } from '../components/MigrateAsk.js';
import { NewPreviewMenu, PreviewWayButtons } from '../components/NewPreviewMenu.js';
import { Picker } from '../components/Picker.js';
import { useMenu } from '../components/Popover.js';
import { EmptyState, ErrorState, Skeleton } from '../components/States.js';
import { glossed } from '../components/Term.js';
import { VerdictLine } from '../components/VerdictLine.js';
import { forgetPreviewSession, notePreviewSession } from '../changes-tab.js';
import { nextStep, sessionHint, verdictState } from '../decisions.js';
import { FixJobButton } from '../fixes/FixJobButton.js';
import { shortId } from '../format.js';
import { useLoad } from '../hooks.js';
import { href } from '../route.js';
import { navigate } from '../router.js';
import { Unshown } from '../shell/unshown.js';
import { useApp } from '../state.js';
import type { Tone } from '../components/Status.js';
import type { DecisionSessionView, PreviewSession, PreviewView } from '../types.js';
import { DecisionCellPanel, revealCell } from './DecisionCell.js';
import { DecisionMatrix } from './DecisionMatrix.js';

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
export function PreviewTab({ id, run, call, onMissing }: { id: string | null; run: string | null; call: number | null; onMissing?: (error: Error) => void }) {
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
  if (list.error && !list.data) return <ErrorState retry={list.reload}>{failedWords(list.error)}</ErrorState>;
  if (!sessions) return <Skeleton what="the previews" lines={8} />;
  if (!shownId) return <NoPreview goldens={list.data!.goldens} />;
  if (gone || (session && session.kind !== 'decisions'))
    return (
      <div className="empty tall">
        <Unshown at={`changes:${shownId}`} />
        No preview {shownId}. <Link href={href.changeSession('decisions')}>Open Preview</Link>
      </div>
    );
  if (detail.error && !session) return <ErrorState retry={detail.reload}>{failedWords(detail.error)}</ErrorState>;
  if (!session) return <Skeleton what="this preview" lines={8} />;
  const opened = openedCell(session, run, call);
  return (
    <>
      <div className="chbar">
        <SessionPicker sessions={sessions} shown={session} />
        <span className="sp" />
        <NewPreviewMenu target={EVERY_GOLDEN} lime={anotherChange(session.view)} />
      </div>
      <Verdict session={session} />
      <DecisionMatrix session={session} open={opened ? { run: opened.row.runId, call: opened.callNo } : null} onOpen={(r, c, current) => openCell(session.sessionId, r, c, current)} />
      {opened ? <DecisionCellPanel key={`${opened.row.runId}:${opened.callNo}`} session={session} row={opened.row} callNo={opened.callNo} /> : null}
      <CodeBox command={session.view.command} className="chcmd" />
    </>
  );
}

/**
 * A cell opens under the matrix, and pressed again closes, in place of the address as a pick in a page
 * is: Back leaves Preview rather than walking back through every cell opened, and the page keeps its
 * scroll. A cell that opens is brought into view the nearest way, as one from a tall matrix's top row
 * could open below the window.
 */
function openCell(sessionId: string, run: string, call: number | null, current: boolean): void {
  if (!current) revealCell();
  navigate(current ? href.changeSession('decisions', sessionId) : href.changeSession('decisions', sessionId, run, call), true);
}

/** The cell an address opens: its run's row at its call; a run's address without a call, the call its row ends on, else its first. */
function openedCell(session: PreviewSession, run: string | null, call: number | null): { row: PreviewSession['matrix'][number]; callNo: number } | null {
  const row = run ? session.matrix.find((r) => r.runId === run) : undefined;
  const callNo = call ?? row?.ending.callNo ?? row?.cells[0]?.callNo ?? null;
  return row && callNo !== null ? { row, callNo } : null;
}

const failedWords = (e: Error) => (e instanceof ApiError ? `The dashboard server answered ${e.status} for this page’s data.` : e.message);

/** No preview kept: what one is, and the command that makes one; with no goldens, what to pack first. */
function NoPreview({ goldens }: { goldens: number }) {
  const text = 'Each recorded model call is asked again with only the change swapped in, and its decision compared with the recorded one. No tool runs, so nothing reaches the world.';
  if (!goldens)
    return (
      <EmptyState title="Preview a change on your goldens" text={text}>
        <p className="emptyline">
          No goldens yet: pack a run as a golden, or preview a change on one run from its Decisions view. <Link href={href.runs()}>Open Runs</Link>
        </p>
      </EmptyState>
    );
  return <EmptyState title="Preview a change on your goldens" text={text} step={<PreviewWayButtons target={EVERY_GOLDEN} />} copy command="shadowlap decisions goldens/* --model <model>" />;
}

const EVERY_GOLDEN = { goldens: 'all' } as const;

/** Another change is the next step once verify rejected the shown preview's and left nothing to verify or attempt: New preview turns lime. */
const anotherChange = (v: PreviewSession['view']): boolean => verdictState(v) === 'verified' && v.verdict.word === 'rejected' && !nextStep(v.next);

/** The previews picker: the one shown by its name, then its goldens or runs and when, fitted to the rest; a pick opens it. */
function SessionPicker({ sessions, shown }: { sessions: readonly DecisionSessionView[]; shown: PreviewSession }) {
  const menu = useMenu();
  const id = shown.sessionId;
  const listed = sessions.find((s) => s.sessionId === id) ?? null;
  const hint = listed ? sessionHint(listed) : '';
  return (
    <span className="pick">
      <button className="rpick dpick" type="button" aria-haspopup="listbox" aria-expanded={menu.open} aria-label={`Preview: ${shown.view.name}${hint ? `, ${hint}` : ''}`} onClick={(e) => menu.toggle(e.currentTarget)}>
        <span className="pid">{shown.view.name}</span>
        <span className="rab">{hint}</span>
        <Icon name="caret" className="caret" />
      </button>
      {menu.anchor ? <SessionList anchor={menu.anchor} sessions={sessions} picked={id} onClose={menu.close} /> : null}
    </span>
  );
}

function SessionList({ anchor, sessions, picked, onClose }: { anchor: HTMLElement; sessions: readonly DecisionSessionView[]; picked: string; onClose: () => void }) {
  const items = useMemo(
    () =>
      sessions.map((s) => {
        const hint = sessionHint(s, { full: true });
        return {
          id: s.sessionId,
          text: `${s.name} ${s.change} ${hint}`,
          current: s.sessionId === picked,
          node: (
            <>
              <span className="pid">{s.name}</span>
              <span className="rab">{hint}</span>
            </>
          ),
        };
      }),
    [sessions, picked],
  );
  return (
    <Picker
      anchor={anchor}
      label="Previews"
      placeholder="Filter by model, field or golden"
      items={items}
      onClose={onClose}
      onPick={(sid) => {
        onClose();
        if (sid !== picked) navigate(href.changeSession('decisions', sid));
      }}
    />
  );
}

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
        <span className="pline">{`${h.lead}${h.rest}${h.detail}`}</span>
        {v.within ? <span className="pline">{v.within}</span> : null}
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
        <span className="pline">{f.count}</span>
        {later ? <span className="pline">{later}</span> : null}
      </>
    );
  }
  const steps = [v.steps.text, ...v.steps.tail];
  return (
    <>
      {h.unasked && state !== 'unsettled' ? <span className="pline dsy">{h.unasked}</span> : null}
      {v.within ? <span className="pline">{v.within}</span> : null}
      <span className="pline">
        <span tabIndex={v.steps.notes.length ? 0 : undefined} data-tip={v.steps.notes.length ? tipCard(v.steps.text, v.steps.notes.map((n, i) => ({ label: `${i + 1}`, value: n }))) : undefined}>
          {steps.map((s, i) => (
            <Fragment key={s}>
              {i ? ' · ' : null}
              {s}
            </Fragment>
          ))}
        </span>
        {later ? <> · {later}</> : null}
      </span>
    </>
  );
}

/** The one lime next step: Verify the runs left to verify, or Migrate to the model switched to. Run more attempts waits for its gate. */
function NextStepButton({ session }: { session: PreviewSession }) {
  const v = session.view;
  const id = session.sessionId;
  const step = nextStep(v.next);
  if (!step || step.kind === 'more') return null;
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
    return (
      <VerifyButton
        sessionId={id}
        runs={step.every ? null : step.runs}
        label={step.label}
        command={command}
        lead={`Replays each run end to end under ${v.change || 'the change'} until verify’s gate decides.`}
      />
    );
  }
  const targets = step.goldens.length ? step.goldens : step.runs.map(shortId);
  const command = `shadowlap migrate --to ${step.to} ${targets.join(' ')}${step.from.map((f) => ` --from ${f}`).join('')}`;
  return (
    <FixJobButton
      kind="migrate"
      fields={{ to: step.to, ...(step.from.length ? { from: step.from } : {}), ...(step.goldens.length ? { goldens: step.goldens } : { runs: step.runs }) }}
      label={step.label}
      verb="migrate"
      lead
      tip="The switch checked end to end, ending on the config change and a pull request body"
      command={command}
      estimate={null}
      ask={(start, close) => <MigrateAsk from={step.from} to={step.to} command={command} ok={step.label} onOk={() => start({})} onClose={close} />}
    />
  );
}

/** Verify, priced by the runs it would verify: a press at or under the threshold starts it, else it asks. */
function VerifyButton({ sessionId, runs, label, command, lead }: { sessionId: string; runs: string[] | null; label: string; command: string; lead: string }) {
  const { client, exported, actionsOff } = useApp();
  const api = client.estimates;
  const priced = useLoad(() => (api && !exported && !actionsOff ? api.decisionEstimates(sessionId, runs ?? undefined) : null), `decision-estimate:${sessionId}:${runs?.join(',') ?? ''}`);
  const estimate = priced.data ? priced.data.verify : priced.error ? null : undefined;
  return (
    <FixJobButton
      kind="decisions-verify"
      fields={{ sessionId, ...(runs ? { runIds: runs } : {}) }}
      label={label}
      verb="verify the changed runs"
      lead
      tip="Each runs end to end under the change, writes stubbed, until verify’s gate decides"
      command={command}
      estimate={estimate}
      ask={(start, close) => <ConfirmDialog title={label} lead={lead} command={command} cost={{ price: 'Billed by your provider', estimate }} footNote={<AskNote estimate={estimate} />} ok={label} onOk={() => start({})} onClose={close} />}
    />
  );
}
