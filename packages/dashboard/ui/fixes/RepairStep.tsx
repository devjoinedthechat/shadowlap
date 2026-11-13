import { Fragment, type ReactNode } from 'react';
import { EmptyState } from '../components/bits.js';
import { CodeBox } from '../components/CodeBox.js';
import { Copy, Words } from '../components/Copy.js';
import { DotParts } from '../components/DotParts.js';
import { Id } from '../components/Id.js';
import { Section } from '../components/Section.js';
import { Status } from '../components/Status.js';
import { plural, shortId } from '../format.js';
import type { FixDetail, RepairStep } from '../types.js';
import { candidateTone, changeParts, fixStamp, footWarnings, repairBy, repairReceipt, roleStatuses } from './model.js';
import { Markdown } from '../components/Markdown.js';
import { Flagged } from './parts.js';
import { StepLead } from './StepLead.js';

/**
 * The Repair step: its verdict line (accepted, headed as the Verify step heads the same verdict, or
 * rejected and why), the change it made once, inline, why it was needed, every candidate it tried
 * with why each was dropped, report.md and what it handed over. A repair that accepted nothing shows
 * the candidates it tried, the gate's rule said once over them; the fix stays open. Its facts say
 * when it ran and who proposed the candidates, or why no repairer did, with what to do (`the
 * repairer could not be asked: claude was not found: install Claude Code, …`); how many attempts it
 * ran and what every stage cost are a grey receipt above its command, and the rest of its warnings
 * are at the foot.
 */
export function RepairStepView({ fix }: { fix: FixDetail }) {
  const r = fix.repair;
  // Headed in the stepper's word for it, as every page says it: a repair makes a change, and none yet is "No change yet".
  if (!r)
    return (
      <EmptyState
        title={fix.steps.find((x) => x.key === 'repair')?.title ?? 'No change yet'}
        text="repair blames the failing runs, asks a model for prompt rewrites, and keeps the smallest one that fixes them without breaking the good runs. A fix of your own goes through verify."
        command={fix.commands.repair}
      />
    );
  return r.accepted && r.change ? <Accepted r={r} change={r.change} /> : <NothingAccepted r={r} />;
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

/**
 * The facts under the verdict line: when it ran and who proposed the candidates; for an accepted
 * change, `Repaired`, and under it the gate's rule and that it was verified twice. One that accepted
 * nothing never reads as repaired: `Ran`.
 */
function RepairFacts({ r }: { r: RepairStep }) {
  const who = by(r);
  const rule = [r.rule, r.again].filter(Boolean).join(' · ');
  return (
    <>
      {r.accepted ? 'Repaired' : 'Ran'} {fixStamp(r.at)}
      {who ? <> · {who}</> : null}
      {r.verify && !r.verify.counts ? ` · verified under ${r.verify.oldCheck ? 'its old check' : 'another check'}, so it doesn’t count for this fix` : ''}
      {r.accepted && rule ? (
        <span className="pline">
          <Words>{rule}</Words>
        </span>
      ) : null}
    </>
  );
}

function Accepted({ r, change }: { r: RepairStep; change: NonNullable<RepairStep['change']> }) {
  return (
    <>
      <StepLead line={r.line} facts={<RepairFacts r={r} />} />
      <div className="grid2 fxg secs">
        <Change r={r} change={change} />
        <Why r={r} />
      </div>
      <Candidates r={r} sub="tried smallest first; the first the gate accepts twice is kept" />
      <div className="grid2 fxg secs">
        <Report r={r} />
        <HandedOver r={r} />
      </div>
      <Receipt r={r} />
      <Warnings r={r} />
    </>
  );
}

/** A repair that accepted nothing: why, the candidates it tried under the gate's rule, said once, and what it found. */
function NothingAccepted({ r }: { r: RepairStep }) {
  return (
    <>
      <StepLead line={r.line} facts={<RepairFacts r={r} />} />
      {r.candidates.length ? (
        <Candidates
          r={r}
          sub={
            r.rule ? (
              <>
                tried smallest first · <Words>{r.rule}</Words>
              </>
            ) : (
              'tried smallest first; the gate accepted none'
            )
          }
        />
      ) : null}
      <div className="grid2 fxg secs">
        <Report r={r} />
        <Why r={r} />
      </div>
      <Receipt r={r} />
      <Warnings r={r} />
    </>
  );
}

/** The change, once, as the text reads now: what it took out struck, what it added marked; how each role held under it, a dot and a word each. */
function Change({ r, change }: { r: RepairStep; change: NonNullable<RepairStep['change']> }) {
  const parts = changeParts(change);
  return (
    <Section
      title="The change"
      sub={
        <>
          {change.file ? (
            <>
              <code>{change.file}</code> ·{' '}
            </>
          ) : null}
          {change.anchor}
        </>
      }
    >
      <div className="pbody pdiff">
        <p className="now">
          {parts.head}
          {parts.removed ? <del>{parts.removed}</del> : null}
          {parts.lead}
          {parts.added ? <mark>{parts.added}</mark> : null}
          {parts.tail}
        </p>
        {r.roles.length ? (
          <div className="vchips">
            {roleStatuses(r.roles).map((x) => (
              <Status key={x.text} tone={x.tone}>
                {x.text}
              </Status>
            ))}
          </div>
        ) : null}
      </div>
    </Section>
  );
}

/** How many attempts the repair ran and what every stage of it cost, as a grey line, and the command that runs it again. */
function Receipt({ r }: { r: RepairStep }) {
  return (
    <>
      <p className="fxreceipt">
        <DotParts parts={repairReceipt(r)} />
      </p>
      <CodeBox command={r.command} />
    </>
  );
}

function Why({ r }: { r: RepairStep }) {
  return (
    <Section title="Why">
      <div className="pbody">
        {r.lost.length ? (
          <>
            <span className="lbl">Where the failing runs were lost</span>
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
            <span className="lbl">Diagnosis</span>
            <p className="fxdiag">{r.diagnosis}</p>
          </>
        ) : null}
        {!r.lost.length && !r.diagnosis ? <Copy className="fxdiag">The repair kept no diagnosis.</Copy> : null}
      </div>
    </Section>
  );
}

function Candidates({ r, sub }: { r: RepairStep; sub: ReactNode }) {
  return (
    <Section title="Candidates" sub={sub} className="fxgap">
      <div className="cands">
        {r.candidates.map((c) => (
          <div key={c.id} className="cand">
            <span className="cnum">{c.id}</span>
            <span>
              <q>
                <Sentences text={c.text} />
              </q>
              <span className="why">
                <span className="nw">{c.surface} ·</span> <CandidateWhy why={c.why} named={r.named} />
              </span>
            </span>
            <Status tone={candidateTone(c.verdict)}>{c.verdict}</Status>
          </div>
        ))}
      </div>
    </Section>
  );
}

/** A candidate's rewrite, each sentence a piece of its own that wraps balanced (`.ln`). */
function Sentences({ text }: { text: string }) {
  return (
    <>
      {text.split(/(?<=[.!?]) (?=[A-Z])/).map((x, i) => (
        <Fragment key={i}>
          {i ? ' ' : ''}
          <span className="ln">
            <OrderIds text={x} />
          </span>
        </Fragment>
      ))}
    </>
  );
}

/** Text with an order id such as A-1042 kept whole, never broken at its hyphen, its flags set as code. */
function OrderIds({ text }: { text: string }) {
  return (
    <>
      {text.split(/\b([A-Z]-\d{3,})\b/).map((x, i) =>
        i % 2 ? (
          <span key={i} className="nw">
            {x}
          </span>
        ) : (
          <Flagged key={i} text={x} />
        ),
      )}
    </>
  );
}

/**
 * A candidate's why, each run it names by id (`target run 01M3RZ4XKN not fixed: …`) a link to it
 * with its about line on hover (`named`); a share in brackets kept with the word before it.
 */
function CandidateWhy({ why, named }: { why: string; named: RepairStep['named'] }) {
  const text = why.replace(/ \((\d+%)\)/g, ' ($1)');
  if (!named.length) return <OrderIds text={text} />;
  const ids = new RegExp(`\\b(${named.map((n) => n.id).join('|')})\\b`);
  return (
    <>
      {text.split(ids).map((x, i) => {
        const run = i % 2 ? named.find((n) => n.id === x) : undefined;
        return run ? <Id key={i} id={run.id} href={run.href} about={run.about} /> : <OrderIds key={i} text={x} />;
      })}
    </>
  );
}

function HandedOver({ r }: { r: RepairStep }) {
  const goldens = r.files.some((f) => f.name === 'goldens/');
  const out = r.output;
  return (
    <Section title="Handed over" sub={<code>{r.dir}/</code>}>
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
    </Section>
  );
}

/**
 * report.md as the repair wrote it, boxed: the pull request's body for an accepted change, what the
 * repair found for one that accepted nothing. What failed and the candidates are on the page already,
 * so their sections open on request, each summed up beside its heading.
 */
function Report({ r }: { r: RepairStep }) {
  const at = /^model call #\d+/.exec(r.lost[0]?.at ?? '')?.[0];
  const folds = {
    'What failed': r.lost.length ? `${plural(r.lost.length, 'run')}${at ? ` · lost at ${at}` : ''}` : 'no failing run blamed',
    Candidates: `${plural(r.candidates.length, 'candidate')} · ${r.accepted ? 'the smallest the gate accepts twice kept' : 'none accepted'}`,
  };
  return (
    <Section title="report.md" sub={r.accepted ? 'the pull request body' : 'what the repair found'}>
      <Markdown text={r.prBody} folds={folds} />
    </Section>
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
