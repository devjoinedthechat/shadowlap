import { useState } from 'react';
import { DecisionCells } from '../changes/DecisionCells.js';
import { SrSpace } from '../components/bits.js';
import { CodeBox } from '../components/CodeBox.js';
import { CodeText } from '../components/Copy.js';
import { tipCard } from '../components/HoverCard.js';
import { ErrorState } from '../components/States.js';
import { glossed } from '../components/Term.js';
import { chipWhen, noneLine, outcomeTone } from '../decisions.js';
import { minuteStamp } from '../format.js';
import { useLoad } from '../hooks.js';
import { glueBound } from '../matrix.js';
import { useApp } from '../state.js';
import type { RunDecisionsSession, RunDecisionsView, ViewStep } from '../types.js';

/**
 * A run's Decisions view (`#/run/<id>/<call>/decisions`): the previews and migrations that asked its
 * model calls again, newest first, one shown at a time (a chip each where several did, the pick kept
 * per run while the page is open); the one shown by name, when and samples, with its place in
 * Changes; the run's cells; what verify found of it, its rule once; its ranked steps most
 * consequential first, then those within the model's own variation; and the line about later steps.
 * A cell or a step selects its call, so the inspector beside it shows that call's conversation.
 */

/** The session each run shows, picked while the page is open. */
const picked = new Map<string, string>();

/** Forgets the sessions picked, for tests. */
export function forgetDecisionsPick(): void {
  picked.clear();
}

export function DecisionsView({ runId, selected, onSelect }: { runId: string; selected: number | null; onSelect: (n: number) => void }) {
  const { client, feeds } = useApp();
  // A preview or a migration that ends while the view is open joins it, as Preview reloads on the same count.
  const answer = useLoad<RunDecisionsView>(() => (client.exported ? null : client.runDecisions(runId)), `run-decisions:${runId}`, feeds.decisions ?? 0);
  const [, repick] = useState(0);
  // A copy keeps no previews, so it says so rather than that nobody previewed the run.
  if (client.exported) return <p className="dview dvnone">An exported copy holds no previews.</p>;
  if (answer.error) return <ErrorState retry={answer.reload}>{`This run’s previews could not be read: ${answer.error.message}.`}</ErrorState>;
  if (!answer.data) return <div className="empty">Loading this run’s previews…</div>;
  const { sessions, later } = answer.data;
  if (!sessions.length) return <Unpreviewed runId={runId} />;
  const s = sessions.find((x) => x.sessionId === picked.get(runId)) ?? sessions[0]!;
  const choose = (id: string) => {
    picked.set(runId, id);
    repick((n) => n + 1);
  };
  return (
    <div className="dview">
      {sessions.length > 1 ? <Pick sessions={sessions} shown={s.sessionId} onPick={choose} /> : null}
      <div className="dvhead">
        <p>
          <b>{s.name}</b>
          {` · ${minuteStamp(s.at)}`}
          {s.samples && s.samples > 1 ? ` · ${s.samples} samples a step` : ''}
        </p>
        <a className="more" href={s.changes}>
          {s.kind === 'migrate' ? 'Migration in Changes →' : 'Preview in Changes →'}
        </a>
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
        <p className="dvnone">{noneLine(s.run)}</p>
      )}
      {later ? (
        <p className="dvlater">
          <span tabIndex={0} data-tip={tipCard(later.title, [], later.card)}>{`${later.title}.`}</span>
        </p>
      ) : null}
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

/** A run nobody previewed: what a preview does, and its command. */
function Unpreviewed({ runId }: { runId: string }) {
  return (
    <div className="dview dvempty">
      <p>No change has been previewed on this run. Each of its model calls can be asked again with only the change swapped in, and no tool runs.</p>
      <CodeBox command={`shadowlap decisions ${runId} --model <model>`} />
    </div>
  );
}
