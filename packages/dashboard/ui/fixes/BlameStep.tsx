import { useRef, useState, type ReactNode } from 'react';
import type { FixAttemptGroups } from '../../src/attempt-groups.js';
import { type Attempt, AttemptList, AttemptsCell } from '../components/AttemptsCell.js';
import { EmptyState, SrSpace } from '../components/bits.js';
import { CodeBox } from '../components/CodeBox.js';
import { DotParts } from '../components/DotParts.js';
import { tipCard, tipText } from '../components/HoverCard.js';
import { Id } from '../components/Id.js';
import { Section } from '../components/Section.js';
import { Status } from '../components/Status.js';
import { rowOpen } from '../components/Table.js';
import { glossed } from '../components/Term.js';
import { approx, minuteStamp, plural, shortId } from '../format.js';
import { useListKeys } from '../list-keys.js';
import { href } from '../route.js';
import { navigate } from '../router.js';
import { ACTIONS, confirmWords } from '../labels.js';
import { FoundCommitLine } from '../revert/FoundLine.js';
import { useServedParts } from '../served-parts.js';
import type { BlameCrash, BlameStep, FixDetail, FoundCommit } from '../types.js';
import { type CallCell, callRowCells, headBlameNext, otherBlameWords, probeTone, probeVerdictWords } from './model.js';
import { AttemptGroups, useAttemptGroups } from './AttemptGroups.js';
import { StepLead } from './StepLead.js';

type Probe = BlameStep['probes'][number];
type ProbeGroups = NonNullable<FixAttemptGroups['blame']>['probes'][number];

/**
 * The Blame step: its verdict line, where the run was lost (each probe's tally over its call on the
 * run's row of calls), the answers on both sides or the check, the probes with their attempts, and
 * what finding out took.
 */
export function BlameStepView({ fix }: { fix: FixDetail }) {
  const groups = useAttemptGroups(fix.fixId);
  const b = fix.blame;
  // A fix starts from a blame, so this only shows for a fix whose blame was deleted from the store.
  if (!b) return <EmptyState title="Not blamed yet" text="blame finds the model call where a failed run was lost: the last one whose answer, asked again, lets the run pass." command={fix.commands.blame} />;
  const probeGroups = (callNo: number): ProbeGroups | null => (groups?.blame?.blameId === b.blameId ? (groups.blame.probes.find((p) => p.callNo === callNo) ?? null) : null);
  return (
    <>
      <StepLead line={b.line} facts={<BlameFacts b={b} />} actions={<BlameLinks b={b} />} />
      {b.crash?.commit ? <BlameCommit found={b.crash.commit} /> : null}
      <div className="grid2 fxg secs">
        {/* Where the run was lost only once blame named the call: otherwise these are the run's calls, with what each probe found. */}
        <Section title={b.outcome === 'blamed' ? 'Where the run was lost' : 'The run’s calls'} sub={callsSub(b)}>
          <div className="pbody">
            <CallRow b={b} />
          </div>
        </Section>
        {b.answers ? <Answers b={b} /> : <Checked b={b} fix={fix} />}
      </div>
      {b.probes.length ? <Probes b={b} groupsOf={probeGroups} /> : <p className="fxnote">No attempt ran: {b.stopReason ?? 'the search stopped before its first probe'}.</p>}
      <Receipts fix={fix} b={b} />
      {b.warnings.length ? (
        <ul className="fxwarn">
          {b.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/** The calls section's sub, by what the blame found. */
function callsSub(b: BlameStep): string {
  if (b.outcome === 'blamed') return 'each probe re-asks one model call; everything before it replays free';
  if (b.outcome === 'stopped') return 'stopped before the search finished';
  return b.line.word === 'inconclusive' ? 'inconclusive: the first probe couldn’t tell' : 'no probe rescued the run';
}

/**
 * Where and how sure, muted under the verdict line: the call it blamed (or the first probe's, for a
 * blame that found none), its place among the model calls, the run, the confidence with why on its
 * card and the error bound it rests on, and the two calls it was lost between when it pinned none.
 */
function BlameFacts({ b }: { b: BlameStep }) {
  const at = b.outcome === 'blamed' ? (b.probes.find((p) => p.blamed) ?? null) : b.outcome === 'unrescuable' ? (b.probes[0] ?? null) : null;
  const risk = b.evidence?.risk ?? null;
  const range = b.evidence?.range ?? null;
  return (
    <>
      {at ? `#${at.callNo} · model call ${at.step} of ${b.steps}${b.scope ? ` in scope ${b.scope}` : ''} · ` : ''}
      in <Id id={shortId(b.runId)} href={b.hrefs.run} />
      {' · '}
      <span className="dtip" tabIndex={0} data-tip={tipCard(`confidence ${b.confidence}`, [], b.confidenceWhy)}>
        confidence {b.confidence}
        {risk !== null ? ` (${risk})` : ''}
      </span>
      {range && range.from !== range.to ? ` · lost ${range.gradual ? 'gradually around' : 'between'} #${range.from} and #${range.to}` : null}
    </>
  );
}

/**
 * The step's links: the run at the call it blamed, or where a stopped search got to, or at the first
 * probe's call where that couldn't tell; Open run at the first probe's call where no call rescued
 * the run, unless its agent exited with an error, which the run page leads with; the rescued fork.
 */
function BlameLinks({ b }: { b: BlameStep }) {
  const first = b.probes[0];
  const run = !b.runExists ? null : b.hrefs.lostAt && b.lostAt !== null ? { to: b.hrefs.lostAt, label: `Open run at #${b.lostAt}` } : b.line.word === 'inconclusive' && first ? { to: first.href, label: `Open run at #${first.callNo}` } : { to: first && !b.exited ? first.href : b.hrefs.run, label: 'Open run' };
  if (!run && !b.hrefs.rescued) return null;
  return (
    <>
      {run ? (
        <a className="btn" href={run.to}>
          {run.label}
        </a>
      ) : null}
      {b.hrefs.rescued ? (
        <a className="btn" href={b.hrefs.rescued}>
          Open rescued fork
        </a>
      ) : null}
    </>
  );
}

/** What a call says on hover: its probe's verdict and tally, why no probe asked it again, or the tool's name. */
function callTip(b: BlameStep, c: CallCell, p: Probe | undefined): string {
  if (p) return `#${c.callNo} · ${p.blamed ? 'blamed: the last call that still rescues the run · ' : ''}${probeVerdictWords(p.verdict).word} · ${p.tally}${p.bound ? ` · ${p.bound}` : ''}`;
  if (c.kind !== 'm') return `#${c.callNo} · ${c.name ?? 'tool call'}`;
  if (c.dim) return `#${c.callNo} · ${b.scope ? `outside scope ${b.scope}: ` : ''}not probed`;
  const why = !c.probed ? '' : b.outcome === 'stopped' ? ': the search stopped first' : b.outcome === 'blamed' ? ': the search skipped it' : '';
  return `#${c.callNo} · not probed${why}`;
}

/** A call's ring or dot in its probe's colour: the blamed one in ink with a halo. */
const CELL_TONE: Record<NonNullable<CallCell['verdict']>, string> = { blamed: ' hot', lost: ' lost', inconclusive: ' unsure', rescued: ' ok' };

/** Past this many cells, a phone numbers only the model calls in the blame's scope, so no two labels run together. */
const DENSE = 12;

function CallRow({ b }: { b: BlameStep }) {
  if (!b.callRow.length) return <p className="fxnote">The run is no longer in the store.</p>;
  const { cells, toolsLeftOut } = callRowCells(b.callRow);
  const probes = new Map(b.probes.map((p) => [p.callNo, p]));
  return (
    <>
      <ol className={`callrow fxrow${cells.length > DENSE ? ' dense' : ''}`}>
        {cells.map((c) =>
          c.kind === 'gap' ? (
            <li key={c.callNo} className="gap" title={`${c.skipped!} calls left out`}>
              <span className="pp" />
              <span className="pl" />
              <span className="nr">…</span>
              <span className="cl" />
            </li>
          ) : (
            <li key={c.callNo} className={`${c.kind}${c.verdict ? CELL_TONE[c.verdict] : ''}${c.dim ? ' dim' : ''}`}>
              <span className="pp">{c.tally ?? ''}</span>
              <span className="pl">{c.verdict ?? ''}</span>
              <span className="nr">
                <a className="cn" href={href.run(b.runId, c.callNo)} aria-label={`Call #${c.callNo}`} data-tip={tipText(callTip(b, c, probes.get(c.callNo)))} />
              </span>
              <span className="cl">#{c.callNo}</span>
            </li>
          ),
        )}
      </ol>
      <Legend b={b} toolsLeftOut={toolsLeftOut} />
    </>
  );
}

/** The row's key: only what it shows, rescued and lost each a defined term. */
function Legend({ b, toolsLeftOut }: { b: BlameStep; toolsLeftOut: boolean }) {
  const has = (word: 'rescued' | 'lost' | 'inconclusive') => b.probes.some((p) => !p.blamed && p.verdict === word);
  return (
    <div className="legend fxleg">
      {has('rescued') ? <span className="lw ok">{glossed('rescued')}</span> : null}
      {has('lost') ? <span className="lw lost">{glossed('lost')}</span> : null}
      {has('inconclusive') ? <span className="lw unsure">inconclusive</span> : null}
      {b.probes.some((p) => p.blamed) ? <span className="lw hot">blamed: the last call that still rescues the run</span> : null}
      <span>{toolsLeftOut ? 'model calls only' : 'ring: model call · dot: tool call'}</span>
      {b.scope ? <span>dimmed: outside scope {b.scope}</span> : null}
    </div>
  );
}

/** A probe's attempts as the Attempts cell lists them, from its bundle: a passing one's note is its mark's, so it says only more. */
function attemptsOf(b: BlameStep, callNo: number): Attempt[] {
  return (b.bundles.find((x) => x.callNo === callNo)?.attempts ?? []).map((a) => ({ runId: a.runId, href: a.href, outcome: a.verdict, note: a.note === 'passed' ? null : a.note }));
}

/** Each probe: its call, its tally, bound and bar in one Attempts cell, its verdict a status; its attempts, and what they did, under it on request. j and k walk the probes. */
function Probes({ b, groupsOf }: { b: BlameStep; groupsOf: (callNo: number) => ProbeGroups | null }) {
  const box = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set());
  const inFocus = useListKeys({ rows: b.probes, keyOf: (p) => p.href, root: box, open: (p) => navigate(p.href) });
  const toggle = (callNo: number, on: boolean) =>
    setOpen((was) => {
      const next = new Set(was);
      if (on) next.add(callNo);
      else next.delete(callNo);
      return next;
    });
  return (
    <Section title="Probes" sub={`${b.rule}${b.rescue !== 'resample the probed call' ? ` · ${b.rescue}` : ''}`} className="fxgap">
      <div className="tscroll" ref={box}>
        <table className="t probes">
          <thead>
            <tr>
              <th>Call</th>
              <th>Model call</th>
              <th>Attempts</th>
              <th>Verdict</th>
            </tr>
          </thead>
          <tbody>
            {b.probes.map((p) => (
              <ProbeRow key={p.callNo} b={b} p={p} focus={inFocus === p.href} open={open.has(p.callNo)} onToggle={(on) => toggle(p.callNo, on)} groups={groupsOf(p.callNo)} />
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function ProbeRow({ b, p, focus, open, onToggle, groups }: { b: BlameStep; p: Probe; focus: boolean; open: boolean; onToggle: (open: boolean) => void; groups: ProbeGroups | null }) {
  const listId = `probe-${b.blameId}-${p.callNo}`;
  const attempts = attemptsOf(b, p.callNo);
  const { word, blamed } = probeVerdictWords(p.verdict);
  const tone = probeTone(p.verdict);
  return (
    <>
      <tr className={[p.blamed ? 'hot' : '', open ? 'open' : '', focus ? 'krow' : ''].filter(Boolean).join(' ') || undefined} data-rowkey={p.href} {...rowOpen(() => navigate(p.href))}>
        <td className="pc">
          <a className="rowa" href={p.href}>
            <code>#{p.callNo}</code>
          </a>
        </td>
        <td className="pm">
          {p.step} of {b.steps}
        </td>
        <td className="ptally">
          <AttemptsCell tally={p.tally} bound={p.bound} boundTitle={p.gate?.method ? `the bound: ${p.gate.method}` : undefined} interval={p.interval} marks={b.marks ?? []} tone={tone} attempts={attempts} rescued={b.rescuedRunId} open={open} onToggle={onToggle} listId={listId} />
          {p.gate?.unavailable ? <span className="fxdim"> · {p.gate.unavailable} unavailable</span> : null}
        </td>
        <td className="pv">
          <Status tone={tone}>{word}</Status>
          {blamed ? (
            <>
              {/* the status and the mark are two words; the mark's margin shows it */}
              <SrSpace />
              <b className="bmk">blamed</b>
            </>
          ) : null}
        </td>
      </tr>
      {open && attempts.length ? (
        <tr className="sub">
          <td colSpan={4}>
            <div id={listId}>
              {groups ? <AttemptGroups groups={groups.groups} attempts={groups.attempts} label={`probe #${p.callNo}`} /> : null}
              <AttemptList attempts={attempts} rescued={b.rescuedRunId} />
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function Answers({ b }: { b: BlameStep }) {
  const a = b.answers!;
  return (
    <Section title={`At call #${a.callNo}`}>
      <div className="pbody">
        <div className="ans one">
          <div>
            <span className="lbl">The recording</span>
            <code>{a.recorded || '(no answer)'}</code>
          </div>
          <div className="good">
            <span className="lbl">A rescued fork</span>
            {b.rescuedRunId ? (
              <>
                {' '}
                <Id id={shortId(b.rescuedRunId)} href={href.run(b.rescuedRunId)} className="rfid" />
              </>
            ) : null}
            <code>{a.rescued || '(no answer)'}</code>
          </div>
        </div>
        {b.pairs ? (
          <p className="pairnote">
            Both answers saw the same conversation, so they make a training pair.{' '}
            <a className="more nw" href={href.training()}>
              {plural(b.pairs, 'pair')} in Training →
            </a>
          </p>
        ) : null}
      </div>
    </Section>
  );
}

/**
 * The first bad commit Find breaking commit named for a crash no model rescued, under the step's
 * lead, as Tests draws it, then its change in its file's box, with Open in editor and Copy git
 * revert, where the answer kept one: the served dashboard's box (served-parts.ts), so a copy draws
 * the line alone.
 */
function BlameCommit({ found }: { found: FoundCommit }) {
  const { ChangeBox } = useServedParts();
  return (
    <>
      <FoundCommitLine found={found} className="bisect fxbis" />
      {found.change && ChangeBox ? <ChangeBox rev={found.rev} change={found.change} /> : null}
    </>
  );
}

/** Which of a crash's ways on its fix's head draws: Find breaking commit, the fix's lead before the commit is named, and Run blame with stronger model. */
interface CrashWays {
  find: boolean;
  stronger: boolean;
}

/**
 * Where to look for a crash no model rescued (fix-crash.ts): the commit Find breaking commit named;
 * else blame's own finding where it knows no answer of the model's lost the run (`look`, as `shadowlap
 * blame` says it), neither model where a stronger one was asked too, or the code first. Then Find
 * breaking commit where the fix leads with it, "offline and free" only where its golden replays so,
 * and a stronger model only where the head offers one. Each button's name and each phrase is kept whole.
 */
function crashNote(c: BlameCrash, b: BlameStep, ways: CrashWays): ReactNode {
  if (c.commit) return `The agent stopped part way from ${c.commit.rev} on, so the code broke the run, not an answer of the model’s. Revert the commit or fix the code, then run the tests.`;
  const find = ways.find ? (
    <>
      {' '}
      <b className="nw">{confirmWords(ACTIONS.findBreakingCommit.label)}</b> replays it{' '}
      {c.offline ? (
        <>
          <span className="nw">offline and free</span>, and
        </>
      ) : (
        'and'
      )}{' '}
      names <span className="nw">the commit that broke it</span>.
    </>
  ) : null;
  if (b.look) return <>{glossed(b.look)}{find}</>;
  // Every attempt failed as the recording did only where none passed: a few may pass, below the bar.
  if (c.stronger) return <>Neither model rescues it, so look at the code and the tools{b.probes.every((p) => p.passes === 0) ? ': every attempt ended as the recording did' : ''}.{find}</>;
  return (
    <>
      The agent stopped part way, so look at the code first.{find}
      {ways.stronger ? (
        <>
          {' '}
          If none did, <b className="nw">{confirmWords(ACTIONS.runBlameStronger.label)}</b> says whether <span className="nw">the model’s capability</span> is the problem.
        </>
      ) : null}
    </>
  );
}

/** What the check's section says last: how to go on from a stopped search, where to look for a crash, or where to look when no answer of the model's lost the run. */
function checkNote(b: BlameStep, fix: FixDetail): ReactNode {
  if (b.outcome === 'stopped')
    return (
      <>
        <b>Run blame again</b> searches from the first model call: blame keeps no search to resume.
      </>
    );
  if (b.outcome === 'blamed') return null;
  if (b.crash) return crashNote(b.crash, b, { find: fix.lead?.key === 'bisect', stronger: headBlameNext(fix)?.kind === 'stronger' });
  return glossed(b.look ?? 'Asking any model call again did not let the run pass often enough: the cause may be before the first model call, in a tool, or in the check itself.');
}

/** For a blame that placed the failure on no call: what it checked, and how the recording failed it. */
function Checked({ b, fix }: { b: BlameStep; fix: FixDetail }) {
  const note = checkNote(b, fix);
  return (
    <Section title="The check" sub="what a passing run must do">
      <div className="pbody">
        <ul className="fxlist">
          {b.oracle.map((o) => (
            <li key={o}>{o}</li>
          ))}
        </ul>
        {b.recordedFailures.length ? (
          <>
            <span className="lbl">As recorded</span>
            <ul className="fxlist bad">
              {b.recordedFailures.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </>
        ) : null}
        {note ? <p className="fxnote">{note}</p> : null}
      </div>
    </Section>
  );
}

/**
 * What finding out took, in one grey line with the judge's checks apart, as the CLI's report adds
 * them; a model with no price, and a pulled blame, after it; the fix's other blames, newest first,
 * each a line; then the command that blames the run the same way again.
 */
function Receipts({ fix, b }: { fix: FixDetail; b: BlameStep }) {
  const c = b.cost;
  const judge = c.judge ? `judge checks: ${plural(c.judge.upstreamRequests, 'upstream request')}, ${approx(c.judge.spent)}` : '';
  const others = fix.blames.filter((x) => x.blameId !== b.blameId);
  return (
    <>
      <p className="fxreceipt">
        <DotParts parts={[plural(c.attempts, 'attempt'), plural(c.upstreamRequests, 'upstream request'), `${approx(c.spent)} spent`, judge, 'every call before a probe replayed from the recording'].filter(Boolean)} />
      </p>
      {c.unknownModels.length ? <p className="fxreceipt">No price for {c.unknownModels.join(', ')}, so its calls count as $0.</p> : null}
      {b.pulled ? <p className="fxreceipt">It ran on a teammate’s machine and came with a pull. The command here is made from its report, without what ran only there.</p> : null}
      {others.map((o) => (
        <p key={o.blameId} className="fxreceipt">
          {o.runId !== b.runId ? (
            <>
              Also blamed <Id id={shortId(o.runId)} href={href.run(o.runId, o.lostAt ?? undefined)} />,{' '}
            </>
          ) : o.at < b.at ? (
            'Blamed before, '
          ) : (
            'Blamed again, '
          )}
          {minuteStamp(o.at)}: {otherBlameWords(o)}.
        </p>
      ))}
      <CodeBox command={b.command} />
    </>
  );
}
