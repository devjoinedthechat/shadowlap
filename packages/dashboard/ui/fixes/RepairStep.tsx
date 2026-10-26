import { Badge, CmdLine, EmptyState } from '../components/bits.js';
import { shortId } from '../format.js';
import type { FixDetail, RepairStep } from '../types.js';
import { candidateTone, changeParts, fixStamp, footWarnings, nothingAcceptedWhy, repairBy, repairReceipt, roleBadges } from './model.js';
import { DotParts, Flagged, Markdown, StepHead } from './parts.js';

/**
 * The Repair step: the change a repair proposed and what it held on, why it was needed, every
 * candidate it tried with why each was dropped, what it handed over, and the pull request body. A
 * repair that accepted nothing shows the candidates it tried; the fix stays open. Its header says
 * when it ran and who proposed them, or why no repairer did, with what to do (`the repairer could
 * not be asked: claude was not found: install Claude Code, …`); how many attempts it ran and what
 * every stage cost are a grey receipt above its command, and the rest of its warnings are at the foot.
 */
export function RepairStepView({ fix }: { fix: FixDetail }) {
  const r = fix.repair;
  if (!r)
    return (
      <EmptyState
        title="No fix yet"
        text="repair blames the failing runs, asks a model for prompt rewrites, and keeps the smallest one that fixes them without breaking the good runs. A fix of your own goes through verify."
        command={fix.commands.repair}
      />
    );
  return r.accepted && r.change ? <Accepted r={r} /> : <NothingAccepted r={r} />;
}

/** Who proposed the candidates, or why no repairer did; nothing when nothing called for one. */
function by(r: RepairStep) {
  const b = repairBy(r);
  if (!b) return null;
  if ('text' in b) return <>{b.text}</>;
  return (
    <>
      proposed by <code>{b.repairer}</code>
      {b.served ? ` (answered by ${b.served})` : ''}
    </>
  );
}

function Accepted({ r }: { r: RepairStep }) {
  const change = r.change!;
  const parts = changeParts(change);
  return (
    <>
      <StepHead
        title={r.title}
        text={
          <>
            Accepted {fixStamp(r.at)} · {by(r)}
            {r.verify && !r.verify.counts ? ' · verified under another check, so it doesn’t count for this fix' : ''}
          </>
        }
      />
      <div className="grid2">
        <section className="panel">
          <header>
            <h2>The change</h2>
            <span className="sub">
              {change.file ? (
                <>
                  <code>{change.file}</code> ·{' '}
                </>
              ) : null}
              {change.anchor}
            </span>
          </header>
          <div className="pbody pdiff">
            <p className="was">{parts.was}</p>
            <p className="now">
              {parts.head}
              {parts.added ? <mark>{parts.added}</mark> : null}
              {parts.tail}
            </p>
            {r.roles.length ? (
              <div className="vchips">
                {roleBadges(r.roles).map((b) => (
                  <Badge key={b.text} tone={b.tone}>
                    {b.text}
                  </Badge>
                ))}
                {r.rule !== null ? <span className="vn">{r.rule}</span> : null}
              </div>
            ) : null}
          </div>
        </section>
        <Why r={r} />
      </div>
      <Candidates r={r} sub="tried smallest first; the first the gate accepts twice is kept" />
      <div className="grid2 fxgap">
        <HandedOver r={r} />
        <Report r={r} />
      </div>
      <Receipt r={r} />
      <Warnings r={r} />
    </>
  );
}

/** A repair that accepted nothing: what it tried ("1 candidate tried, none accepted"), or why it found nothing to try. */
function NothingAccepted({ r }: { r: RepairStep }) {
  const n = r.candidates.length;
  const who = by(r);
  const why = nothingAcceptedWhy(r);
  const head = (
    <>
      Ran {fixStamp(r.at)}
      {who ? <> · {who}</> : null}
      {why ? (
        <>
          {' · '}
          <Flagged text={why} />
        </>
      ) : null}
    </>
  );
  return (
    <>
      <StepHead
        title="No fix yet"
        text={
          <>
            {head}
            <span className="pline">{n ? 'The fix stays open, with each candidate and why it was dropped. Repair again, or verify a fix of your own.' : 'The fix stays open. Repair again, or verify a fix of your own.'}</span>
          </>
        }
      />
      {r.candidates.length ? <Candidates r={r} sub="tried smallest first; the gate accepted none" /> : null}
      <div className={`grid2${r.candidates.length ? ' fxgap' : ''}`}>
        <Why r={r} />
        <Report r={r} />
      </div>
      <Receipt r={r} />
      <Warnings r={r} />
    </>
  );
}

/** How many attempts the repair ran and what every stage of it cost, as a grey line, and the command that runs it again. */
function Receipt({ r }: { r: RepairStep }) {
  return (
    <>
      <p className="fxreceipt">
        <DotParts parts={repairReceipt(r)} />
      </p>
      <CmdLine>{r.command}</CmdLine>
    </>
  );
}

function Why({ r }: { r: RepairStep }) {
  return (
    <section className="panel">
      <header>
        <h2>Why</h2>
      </header>
      <div className="pbody">
        {r.lost.length ? (
          <>
            <span className="k">where the failing runs were lost</span>
            {r.lost.map((l) => (
              <div key={l.runId} className="fxlost">
                <a className="more" href={l.href}>
                  <code>{shortId(l.runId)}</code>
                </a>{' '}
                <span className="at">· {l.at}</span>
              </div>
            ))}
          </>
        ) : null}
        {r.diagnosis ? (
          <>
            <span className="k">diagnosis</span>
            <p className="fxdiag">{r.diagnosis}</p>
          </>
        ) : null}
        {!r.lost.length && !r.diagnosis ? <p className="fxdiag">The repair kept no diagnosis.</p> : null}
      </div>
    </section>
  );
}

function Candidates({ r, sub }: { r: RepairStep; sub: string }) {
  return (
    <section className="panel fxgap">
      <header>
        <h2>Candidates</h2>
        <span className="sub">{sub}</span>
      </header>
      <div className="cands">
        {r.candidates.map((c) => (
          <div key={c.id} className="cand">
            <span className="cnum">{c.id}</span>
            <span>
              <q>{c.text}</q>
              <span className="why">
                {c.surface} · <Flagged text={c.why} />
              </span>
            </span>
            <Badge tone={candidateTone(c.verdict)}>{c.verdict}</Badge>
          </div>
        ))}
      </div>
    </section>
  );
}

function HandedOver({ r }: { r: RepairStep }) {
  const goldens = r.files.some((f) => f.name === 'goldens/');
  const out = r.output;
  return (
    <section className="panel">
      <header>
        <h2>Handed over</h2>
        <span className="sub">
          <code>{r.dir}/</code>
        </span>
      </header>
      <div className="files">
        {r.files.map((f) => (
          <div key={f.name}>
            <code>{f.name}</code>
            <span>{f.note}</span>
          </div>
        ))}
      </div>
      <div className="pbody fxfoot">
        <span>
          {/* A teammate's repair, from the team store: what it did, it did on their machine. */}
          {r.pulled ? 'It ran on a teammate’s machine and came with a pull: its patch and reports are here, and its goldens stay there, to be committed from it. ' : ''}
          {out.applied ? `repair --apply left the change in ${r.pulled ? 'their' : 'the'} working tree. ` : ''}
          {out.branch ? `Committed to the branch ${out.branch}. ` : ''}
          {out.pr ? `Pull request: ${out.pr}. ` : ''}
          {goldens ? (
            <>
              The goldens were recorded by the fixed code, so <code>shadowlap test</code> fails the build if the fix is ever undone{r.pulled ? ', once they are committed' : ''}.{' '}
            </>
          ) : null}
          {!out.branch && !out.pr ? (
            <>
              <code>--branch</code> and <code>--pr</code> hand it over as a pull request.
            </>
          ) : null}
        </span>
      </div>
    </section>
  );
}

function Report({ r }: { r: RepairStep }) {
  return (
    <section className="panel">
      <header>
        <h2>report.md</h2>
        <span className="sub">the pull request body</span>
      </header>
      <Markdown text={r.prBody} />
    </section>
  );
}

function Warnings({ r }: { r: RepairStep }) {
  const warnings = footWarnings(r);
  if (!warnings.length) return null;
  return (
    <ul className="fxwarn">
      {warnings.map((w) => (
        <li key={w}>
          <Flagged text={w} />
        </li>
      ))}
    </ul>
  );
}
