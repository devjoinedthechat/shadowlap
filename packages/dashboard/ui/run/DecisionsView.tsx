import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { DecisionCells } from '../changes/DecisionCells.js';
import { moreTip, PreviewVerifyButton, VERIFY_THIS_RUN_TIP } from '../changes/VerifyAsk.js';
import { SrSpace } from '../components/bits.js';
import { CodeBox } from '../components/CodeBox.js';
import { CodeText, Copy } from '../components/Copy.js';
import { DotNodes } from '../components/DotParts.js';
import { tipCard } from '../components/HoverCard.js';
import { ErrorState } from '../components/States.js';
import { NewPreviewMenu, PreviewWayButtons } from '../components/NewPreviewMenu.js';
import { glossed } from '../components/Term.js';
import { chipWhen, noneLine, outcomeTone } from '../decisions.js';
import { minuteStamp } from '../format.js';
import { useLoad } from '../hooks.js';
import { ACTIONS } from '../labels.js';
import { glueBound } from '../matrix.js';
import { useApp } from '../state.js';
import type { RunDecisionsSession, RunDecisionsView, ViewStep } from '../types.js';
import { onPick, pickedSession, pickSession } from './decisions-pick.js';

/**
 * A run's Decisions view (`#/run/<id>/<call>/decisions`): the previews and migrations that asked its
 * model calls again, newest first, one shown at a time (a chip each where several did, the pick kept
 * per run while the page is open); the one shown by name, when and samples, with its place in
 * Changes; the run's cells; what verify found of it, its rule once; its ranked steps most
 * consequential first, then those within the model's own variation; and the line about later steps.
 * A cell or a step selects its call, so the inspector beside it shows that call's conversation.
 */

export { forgetDecisionsPick } from './decisions-pick.js';

/** Why New preview waits on a run still recording, as Fork does. */
const RECORDING = 'Preview once the recording finishes';

/** A session's head as its dot parts: its name, when, and how many samples a step where more than one, each dot kept with the part before it. */
function headParts(s: RunDecisionsSession): Array<{ text: string; node: ReactNode }> {
  const when = minuteStamp(s.at);
  const samples = s.samples && s.samples > 1 ? [`${s.samples} samples a step`] : [];
  return [{ text: s.name, node: <b>{s.name}</b> }, ...[when, ...samples].map((t) => ({ text: t, node: t }))];
}

export function DecisionsView({ runId, selected, onSelect, live = false }: { runId: string; selected: number | null; onSelect: (n: number) => void; live?: boolean }) {
  const { client, feeds } = useApp();
  // A preview or a migration that ends while the view is open joins it, as Preview reloads on the same count.
  const answer = useLoad<RunDecisionsView>(() => (client.exported ? null : client.runDecisions(runId)), `run-decisions:${runId}`, feeds.decisions ?? 0);
  const [, repick] = useState(0);
  // A preview of this run that ends picks itself here.
  useEffect(() => onPick(() => repick((n) => n + 1)), []);
  // A copy keeps no previews, so it says so rather than that nobody previewed the run.
  if (client.exported) return <Copy className="dview dvnone">An exported copy holds no previews.</Copy>;
  if (answer.error) return <ErrorState retry={answer.reload}>{`This run’s previews could not be read: ${answer.error.message}.`}</ErrorState>;
  if (!answer.data) return <div className="empty">Loading this run’s previews…</div>;
  const { sessions, later } = answer.data;
  if (!sessions.length) return <Unpreviewed runId={runId} live={live} />;
  const s = sessions.find((x) => x.sessionId === pickedSession(runId)) ?? sessions[0]!;
  // A pick redraws the view through onPick.
  const choose = (id: string) => pickSession(runId, id);
  return (
    <div className="dview">
      {sessions.length > 1 ? <Pick sessions={sessions} shown={s.sessionId} onPick={choose} /> : null}
      <div className="dvhead">
        <p>
          <DotNodes parts={headParts(s)} />
        </p>
        <a className="more" href={s.changes}>
          {s.kind === 'migrate' ? 'Migration in Changes →' : 'Preview in Changes →'}
        </a>
        <NewPreviewMenu target={{ runs: [runId] }} small why={live ? RECORDING : null} />
      </div>
      <DecisionCells className="dvstrip" row={s.row} open={selected} onOpen={onSelect} />
      <Verified s={s} />
      {s.steps.length ? (
        <div className="dvsteps">
          {s.steps.map((st) => (
            <Step key={st.callNo} st={st} sel={st.callNo === selected} onSelect={onSelect} />
          ))}
        </div>
      ) : (
        <Copy className="dvnone">{noneLine(s.run)}</Copy>
      )}
      {later ? (
        <p className="dvlater">
          <span tabIndex={0} data-tip={tipCard(later.title, [], later.card)}>{`${later.title}.`}</span>
        </p>
      ) : null}
      <SessionVerify s={s} runId={runId} />
    </div>
  );
}

/** The previews that asked the run, a chip each: its name, then when, in bold; the one shown pressed. */
function Pick({ sessions, shown, onPick }: { sessions: readonly RunDecisionsSession[]; shown: string; onPick: (id: string) => void }) {
  return (
    <div className="chips dvpick" role="group" aria-label="Previews of this run">
      {sessions.map((x) => (
        <button key={x.sessionId} type="button" aria-pressed={x.sessionId === shown} title={`${x.name} · ${minuteStamp(x.at)}`} onClick={() => onPick(x.sessionId)}>
          {x.name}
          <SrSpace />
          <b>{chipWhen(x.at)}</b>
        </button>
      ))}
    </div>
  );
}

/** What verify found of the run, and the rule that decided it, once. */
function Verified({ s }: { s: RunDecisionsSession }) {
  const v = s.verified;
  if (!v) return null;
  return (
    <p className="dvsum">
      <span className={`dsv ${outcomeTone(v.outcome)}`}>
        <b>{glossed(v.outcome)}</b>
        {glueBound(v.tally)}
      </span>
      {v.rule ? <span className="dvrule">{glossed(v.rule)}</span> : null}
    </p>
  );
}

/** A step's change kept whole where it fits a line; a longer one keeps what the recording did whole at its end (`…, where the recording calls tools`). */
function Said({ detail }: { detail: string }) {
  if (detail.length <= 40) return <span className="nw">{detail}</span>;
  const m = /^(.*, where )(the recording .{1,34})$/.exec(detail);
  if (!m) return <>{detail}</>;
  return (
    <>
      {m[1]}
      <span className="nw">{m[2]}</span>
    </>
  );
}

/** One listed step: its number, rank and change with how often, then each side's decision, its cost either way and its arguments field by field. */
function Step({ st, sel, onSelect }: { st: ViewStep; sel: boolean; onSelect: (n: number) => void }) {
  return (
    <div className={`dvstep${sel ? ' sel' : ''}`} data-call={st.callNo} data-acts="" onClick={() => onSelect(st.callNo)}>
      <p className="dvs1">
        <span className="dvn">#{st.callNo}</span>
        <SrSpace />
        {st.rank === null ? null : (
          <>
            <b className={`drk q${st.rank}`}>rank {st.rank}</b>{' '}
          </>
        )}
        <Said detail={st.detail} />
        {st.within ? <span className="dlm">{`\u00a0· ${st.within}`}</span> : null}
        {st.short ? <span className="dlm">{`\u00a0· ${st.short}`}</span> : null}
        {st.waits ? <span className="dsy">{'\u00a0· waits on a judge'}</span> : null}
      </p>
      <p className="dvs2">
        <span className="k">
          recorded
          <SrSpace />
        </span>
        <CodeText>{st.recorded}</CodeText>
      </p>
      <p className="dvs2">
        <span className="k">
          now
          <SrSpace />
        </span>
        <CodeText>{st.now}</CodeText>
        {st.delta ? <span className="dlm">{st.delta}</span> : null}
      </p>
      {st.args.map((a) => (
        <p key={a} className="dvs2 dargs">
          <span className="k" />
          <CodeText>{a}</CodeText>
        </p>
      ))}
    </div>
  );
}

/**
 * Under the steps: Verify this run where the preview left it to verify and verify hasn't taken it,
 * else Run more attempts or Verify again where verify left it open; plain, as the verdict's next
 * step is Preview's. None for a migration, which Changes never verifies from here.
 */
function SessionVerify({ s, runId }: { s: RunDecisionsSession; runId: string }) {
  if (s.kind !== 'decisions') return null;
  const rows = [{ runId, golden: s.row.golden, about: null, verified: s.more ? s.verified : null }];
  let button: ReactElement | null = null;
  if (s.more) button = <PreviewVerifyButton sessionId={s.sessionId} change={s.change} rows={rows} label={s.more.kind === 'again' ? ACTIONS.verifyAgain.label : ACTIONS.runMoreAttempts.label} more={s.more} tip={moreTip(s.more, { one: true, view: true })} />;
  else if (s.toVerify && !s.verified) button = <PreviewVerifyButton sessionId={s.sessionId} change={s.change} rows={rows} label={ACTIONS.verifyThisRun.label} one tip={VERIFY_THIS_RUN_TIP} />;
  return button ? <div className="actions">{button}</div> : null;
}

/** A run nobody previewed: what a preview does, its command, and the three ways, small and plain. */
function Unpreviewed({ runId, live }: { runId: string; live: boolean }) {
  return (
    <div className="dview dvempty">
      <Copy>No change has been previewed on this run. Each of its model calls can be asked again with only the change swapped in, and no tool runs.</Copy>
      <CodeBox command={`shadowlap decisions ${runId} --model <model>`} />
      <PreviewWayButtons target={{ runs: [runId] }} small plain why={live ? RECORDING : null} />
    </div>
  );
}
