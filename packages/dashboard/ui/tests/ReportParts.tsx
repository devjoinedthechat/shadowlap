import { Fragment, useReducer, type CSSProperties } from 'react';
import { UNTESTED_WORDS } from '../../../engine/src/bisect-words.js';
import { AttemptList } from '../components/AttemptsCell.js';
import { CodeBox } from '../components/CodeBox.js';
import { MatrixKey } from '../components/MatrixKey.js';
import { tipText } from '../components/HoverCard.js';
import { Icon } from '../components/Icon.js';
import { ErrorState, Skeleton } from '../components/States.js';
import { glossed } from '../components/Term.js';
import { RuleText } from '../components/Verdict.js';
import { clock, plural } from '../format.js';
import { foundLine, missedLine } from '../goldens.js';
import { useLoad } from '../hooks.js';
import { resultsKey } from '../matrix.js';
import { ChangeBox } from '../revert/ChangeBox.js';
import { href } from '../route.js';
import { useApp } from '../state.js';
import type { FoundCommit, GoldenReport, GoldenRow, ReportPart } from '../types.js';
import { Check, Checks } from './Checks.js';
import { ErrorPart } from './ErrorPart.js';
import { gated, GateIntervalBar, type GateShown } from './Evidence.js';
import { attemptsShown, setAttemptsShown } from './report-open.js';
import { RequestPart } from './RequestPart.js';
import { partId } from './until-found.js';

/**
 * A golden's report's parts, a part a row, each named in words in the margin (over it on a phone):
 * what the server found of its last result (golden-report.ts), drawn with the table's own pieces
 * where the row has them (its checks, its gate's bar). Its attempts are read once the report is
 * open, never while it is folded.
 */

const NAMES: Record<ReportPart['kind'], string> = {
  'checks-changed': 'Checks changed',
  replay: 'Replay',
  request: 'Request',
  error: 'Error',
  checks: 'Checks',
  gate: 'Gate',
  attempts: 'Attempts',
  commit: 'First bad commit',
  missed: 'Find breaking commit',
  proof: 'Proof',
  'injection-attempts': 'Attempts',
};

/** A gate's attempts past this many fold behind its caret. */
const FEW = 24;

export function ReportParts({ report, row, open }: { report: GoldenReport; row: GoldenRow; open: boolean }) {
  // The fold is kept with the reports' open set (report-open.ts), so it outlives the page.
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  if (!report.parts.length) return null;
  const g = gated(row.last.gate) ? row.last.gate : null;
  const shown = attemptsShown(report.name);
  const toggle = () => {
    setAttemptsShown(report.name, !shown);
    redraw();
  };
  const fold = { many: !!g && g.attempts > FEW && report.parts.some((p) => p.kind === 'gate'), shown, toggle, id: partId('rpa', report.name) };
  return (
    <dl className="rpx">
      {report.parts.map((p, i) => (
        <Fragment key={`${p.kind}:${i}`}>
          <dt>{NAMES[p.kind]}</dt>
          <dd>
            <Part p={p} report={report} row={row} g={g} open={open} fold={fold} />
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

type Fold = { many: boolean; shown: boolean; toggle: () => void; id: string };

function Part({ p, report, row, g, open, fold }: { p: ReportPart; report: GoldenReport; row: GoldenRow; g: GateShown | null; open: boolean; fold: Fold }) {
  switch (p.kind) {
    case 'checks-changed':
      return (
        <>
          {p.gone.map((c) => (
            <p key={c.label} className="rpc">
              <span className="nw">{c.label}</span>
              {`, which it ${c.status === 'failed' ? 'failed' : 'couldn’t decide'}, is no longer in shadowlap.config.json · not tested yet`}
            </p>
          ))}
        </>
      );
    case 'replay':
      return <ReplayLine recorded={p.recorded} replayed={p.replayed} stop={p.stop} words={p.words} />;
    case 'request':
      return <RequestPart p={p} open={open} id={partId('rpm', report.name)} />;
    case 'error':
      return <ErrorPart part={p} id={partId('rpe', report.name)} />;
    case 'checks':
      return (
        <span className="chk rpck">
          <Checks row={row} labels={p.labels} />
        </span>
      );
    case 'gate':
      return g ? <GateLine g={g} p={p} fold={fold} /> : null;
    case 'attempts':
      return <AttemptsPart p={p} row={row} open={open} fold={fold} />;
    case 'commit':
      return <CommitLine found={p.found} />;
    case 'missed':
      return <p className="rpc">{missedLine(p.missed)}</p>;
    case 'proof':
      return <ProofLine runId={p.runId} line={p.line} why={p.why} />;
    case 'injection-attempts':
      return <InjectionAttempts p={p} failed={report.verdict === 'failed'} />;
  }
}

/**
 * The replay's cells, as a run's small strip draws them: replayed up to where it stopped, the call
 * it stopped at red, none after; past `max` calls each range takes the call it stopped at, else
 * replayed while any of it was.
 */
export function replayCells(recorded: number, replayed: number, stop: number | null, max = 60): Array<'rep' | 'fail' | ''> {
  const size = recorded > max ? Math.ceil(recorded / max) : 1;
  const out: Array<'rep' | 'fail' | ''> = [];
  for (let from = 1; from <= recorded; from += size) {
    const to = Math.min(from + size - 1, recorded);
    out.push(stop !== null && stop >= from && stop <= to ? 'fail' : from <= replayed ? 'rep' : '');
  }
  return out;
}

function ReplayLine({ recorded, replayed, stop, words }: { recorded: number; replayed: number; stop: number | null; words: string }) {
  const cells = replayCells(recorded, replayed, stop);
  // The strip is a picture: its words say it.
  const style: CSSProperties & { '--n': number } = { '--n': cells.length, gridTemplateColumns: `repeat(${cells.length}, minmax(0, 1fr))` };
  return (
    <span className="rpline">
      <span className="ms rpms" style={style} aria-hidden="true">
        {cells.map((c, i) => (
          <i key={i} className={c || undefined} />
        ))}
      </span>
      <span className="rpw">{words}</span>
    </span>
  );
}

/** A gate's figures: how many passed and its bound kept whole; in grey, the baseline it compared with, its pass^5 and what the provider cut short, as the server words them; its bar, the caret past 24 attempts, then its rule. */
function GateLine({ g, p, fold }: { g: GateShown; p: Extract<ReportPart, { kind: 'gate' }>; fold: Fold }) {
  const { bound } = p;
  const grey = [p.baseline, p.passK, g.words?.provider].filter(Boolean).join(' · ');
  return (
    <>
      <p className="rpg">
        <span className="nw">
          {`${g.passes} of ${g.attempts} passed`}
          {bound ? ' ·' : ''}
        </span>
        {bound ? (
          <>
            {' '}
            <span className="nw">
              {glossed(bound)}
              {grey ? ' ·' : ''}
            </span>
          </>
        ) : null}
        {grey ? (
          <>
            {' '}
            <span className="m">{glossed(grey)}</span>
          </>
        ) : null}{' '}
        <span className="ibx">
          <GateIntervalBar g={g} />
          {fold.many ? (
            <button type="button" className="xbtn" aria-expanded={fold.shown} {...(fold.shown ? { 'aria-controls': fold.id } : {})} aria-label={`${fold.shown ? 'Hide' : 'Show'} ${plural(g.attempts, 'attempt')}`} onClick={fold.toggle}>
              <Icon name="caret" />
            </button>
          ) : null}
        </span>
      </p>
      {g.rule ? (
        <p className="rpw rprule">
          <RuleText rule={g.rule} />
        </p>
      ) : null}
    </>
  );
}

/** The attempts, read once the report opens; past 24 of a gate's, folded behind its caret. Then the attempts carried over, the check they failed, and where they forked. */
function AttemptsPart({ p, row, open, fold }: { p: Extract<ReportPart, { kind: 'attempts' }>; row: GoldenRow; open: boolean; fold: Fold }) {
  const { client } = useApp();
  const loaded = useLoad(() => (open && client.testEvidence ? client.testEvidence(row.path) : null), `tests-evidence:${row.path}`, `${row.last.at ?? ''}:${open}`);
  const total = row.last.gate?.attempts ?? loaded.data?.attempts.length ?? 0;
  const list = () => {
    if (!open || !client.testEvidence || (fold.many && !fold.shown)) return null;
    if (loaded.error) return <ErrorState retry={loaded.reload}>Its attempts couldn’t be read: {loaded.error.message}</ErrorState>;
    if (!loaded.data) return <Skeleton what="the attempts" lines={2} />;
    const { attempts, gone, carried } = loaded.data;
    if (!attempts.length) return <p className="muted">The attempts aren’t in the store any more.</p>;
    return (
      <>
        <AttemptList attempts={attempts} carried={carried} id={fold.id} />
        {gone ? <p className="muted">{gone === 1 ? 'One of its attempts isn’t' : `${gone} of its attempts aren’t`} in the store any more.</p> : null}
      </>
    );
  };
  return (
    <div className="rpatw">
      {list()}
      {p.carried ? <p className="rpw">{`${p.carried.count} carried over${p.carried.at !== null ? ` from the session at ${clock(p.carried.at)}` : ''} · ${plural(Math.max(0, total - p.carried.count), 'attempt')} this session`}</p> : null}
      {p.check ? (
        <span className="chk rpck">
          <Check c={{ label: p.check.label, status: 'failed', added: false, detail: p.check.detail || null, reason: null, source: null, live: null, attempts: null }} ran />
        </span>
      ) : null}
      {p.forked ? <p className="rpw rpnote">{p.forked}</p> : null}
    </div>
  );
}

/** The first bad commit: its rev, its subject, who, when and what it cost, what it couldn't test, and its change where the answer kept one. */
function CommitLine({ found }: { found: FoundCommit }) {
  const f = foundLine(found);
  return (
    <>
      <p className="rpc" data-tip={found.why ? tipText(found.why) : undefined}>
        <code>{f.rev}</code> <b>{f.subject}</b> <span className="m rpcm">{f.meta}</span>
      </p>
      {found.untested.length ? <p className="rpw">{UNTESTED_WORDS.line(found.untested)}</p> : null}
      {found.change ? <ChangeBox rev={found.rev} change={found.change} /> : null}
    </>
  );
}

/**
 * An injection gate's proof, the engine's line of it, each call it names (`#4`) a link to that call
 * of the attempt; for an attempt that showed nothing, why, one piece after it. One component, so an
 * attempt's own page can draw its proof the same way.
 */
export function ProofLine({ runId, line, why }: { runId: string; line: string; why: string | null }) {
  return (
    <p className="rpw">
      {line.split(/(#\d+)/).map((bit, i) =>
        /^#\d+$/.test(bit) ? (
          <a key={i} className="dlink" href={href.run(runId, Number(bit.slice(1)))}>
            {bit}
          </a>
        ) : (
          <Fragment key={i}>{bit}</Fragment>
        ),
      )}
      {why ? (
        <>
          {' '}
          <span className="rpwhy">{why}</span>
        </>
      ) : null}
    </p>
  );
}

/**
 * What an injection gate's attempts did, in the results matrix's key (MatrixKey.tsx, never the matrix
 * itself), every entry in its quiet form, as a report's figures are never louder than its verdict;
 * where they were planted, each of its two clauses kept whole, so a phone breaks it at its comma; and
 * the command that writes every attempt.
 */
function InjectionAttempts({ p, failed }: { p: Extract<ReportPart, { kind: 'injection-attempts' }>; failed: boolean }) {
  const t = p.totals;
  return (
    <>
      <div className="rpmx">
        <MatrixKey {...resultsKey([['obeyed', t.obeyed], ['influenced', t.influenced], ['inconclusive', t.inconclusive], ['ignored', t.ignored]])} />
      </div>
      {p.where ? (
        <p className="rpw">
          <span className="nw">{p.where}</span>
          {p.each ? (
            <>
              {' '}
              <span className="nw">{p.each}</span>
            </>
          ) : null}
        </p>
      ) : null}
      <p className="rpw rpcap">{failed ? 'Every attempt with its proof:' : 'Every attempt, and why:'}</p>
      <CodeBox command={p.command} />
    </>
  );
}
