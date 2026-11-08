import type { ReactNode } from 'react';
import { UNTESTED_WORDS } from '../../../engine/src/bisect-words.js';
import type { BisectMiss, DivergenceView, FailureView, FoundCommit, InconclusiveView } from '../api.js';
import { tipText } from '../components/HoverCard.js';
import { JobButton } from '../components/JobButton.js';
import type { TestsEstimates } from '../estimates-api.js';
import { divergenceButtons, failureHint, failureLines, foundLine, inconclusiveHint, inconclusiveLines, missedLine, reportLines, type ReportLine } from '../goldens.js';
import { ACTIONS, confirmWords } from '../labels.js';
import { FindCommitButton } from '../pages/TestsDialogs.js';
import { moreCard, normalizeCard, testsJob, updateCard } from '../pages/tests-cards.js';
import { href } from '../route.js';
import { moreAttemptsAsk, type TestsAsk } from '../tests-ask.js';
import { goldenPrice, type Price } from '../tests-estimates.js';

/**
 * Each golden that didn't pass, below Tests' table: its report as the CLI prints it, what Find
 * breaking commit found of it, and what fixes it.
 */

function ReportLines({ lines }: { lines: ReportLine[] }) {
  return (
    <pre tabIndex={0} className="report">
      {lines.map((l, i) => (
        <span key={i} className={l.tone || undefined}>
          {l.text}
          {i < lines.length - 1 ? '\n' : ''}
        </span>
      ))}
    </pre>
  );
}

/** What Find breaking commit found: the first bad commit, its message, who made it, when, and what it cost. */
function BisectCard({ found }: { found: FoundCommit }) {
  const f = foundLine(found);
  return (
    <div className="bisect" data-tip={found.why ? tipText(found.why) : undefined}>
      <span className="k">first bad commit</span>
      <code>{f.rev}</code>
      <b>{f.subject}</b>
      <span className="m">{f.meta}</span>
      {found.untested.length ? <span className="m">{UNTESTED_WORDS.line(found.untested)}</span> : null}
    </div>
  );
}

/** Find breaking commit named no first bad commit between the commits it was given: where it looked, and why. */
function BisectMissLine({ missed }: { missed: BisectMiss }) {
  return (
    <div className="bisect miss">
      <span className="k">{confirmWords(ACTIONS.findBreakingCommit.label).toLowerCase()}</span>
      <span className="m">{missedLine(missed)}</span>
    </div>
  );
}

/**
 * A failed golden's report, as the CLI prints it, with what Find breaking commit found (or that it
 * found none) above the buttons. Its id is the part a job started from it hands the focus back to,
 * the step that took the button's place, and what a link to the report scrolls to.
 */
function ReportPanel({ name, runId, lines, found, missed, children }: { name: string; runId: string | null; lines: ReportLine[]; found: FoundCommit | null; missed: BisectMiss | null; children: ReactNode }) {
  return (
    <section className="panel gpanel" id={`report-${name}`}>
      <header>
        <h2>{name}</h2>
        <span className="sub">as the report prints it</span>
        <span className="sp" />
        {runId ? (
          <a className="more" href={href.run(runId)}>
            Open the run
          </a>
        ) : null}
      </header>
      <div className="pbody">
        <ReportLines lines={lines} />
        {found ? <BisectCard found={found} /> : missed ? <BisectMissLine missed={missed} /> : null}
        {children}
      </div>
    </section>
  );
}

/**
 * A golden whose replay diverged: its report, and what fixes it, as `divergenceButtons` offers it: a
 * normalizer for a value made anew on every run (or a re-run once the rule is in the config), Update
 * golden, and Find breaking commit, but where Update golden leads (`updateLeads`: a change a patch or
 * a config change explains). Each reads plain: the verdict's step is the page's lime. `wait` says why
 * one can't start now.
 */
export function DivergencePanel({ d, has, updateLeads, wait, live, prices, onNormalize, onUpdate, onFind }: { d: DivergenceView; has: (kind: string) => boolean; updateLeads: boolean; wait: (verb: string) => string | null; live: boolean; prices: TestsEstimates | null | undefined; onNormalize: (e: Price) => void; onUpdate: (e: Price) => void; onFind: () => void }) {
  const b = divergenceButtons(d, has);
  return (
    <ReportPanel name={d.name} runId={d.runId} lines={reportLines(d.text)} found={d.found} missed={d.missed}>
      {b.note === 'maybe-real' && d.volatile ? (
        <p className="hintx tnote">
          <code>{d.volatile.path}</code> changed, and it may be a real change, such as another customer or another order. If it is made anew on every run, add the normalizer; if the change was intended, update the golden.
        </p>
      ) : b.note ? (
        <p className="hintx tnote">
          The normalizer for <code>{d.volatile?.path ?? 'it'}</code> is in shadowlap.config.json now. {b.note === 'rules-added' ? 'Run the golden again to see it pass.' : 'It masks the value, but the request also carries what the recording never had: update the golden.'}
        </p>
      ) : null}
      <div className="actions">
        {b.normalize ? (
          <JobButton className="btn" why={wait(b.normalize.run === 'rerun' ? 'run it again' : 'add the normalizer')} {...testsJob(normalizeCard(d, b.normalize), goldenPrice(prices, d.golden, b.normalize.run === 'rerun' ? 'rerun' : 'normalize'), onNormalize)}>
            {b.normalize.label}
          </JobButton>
        ) : null}
        {b.update ? (
          <JobButton className="btn" why={wait('update it')} {...testsJob(updateCard(d.golden), goldenPrice(prices, d.golden, 'update'), onUpdate)}>
            {ACTIONS.updateGolden.label}
          </JobButton>
        ) : null}
        {b.bisect && !updateLeads ? <FindCommitButton f={d} live={live} why={wait('find the breaking commit')} onBisect={onFind} /> : null}
      </div>
      <p className="hintx">Normalizers apply at match time, so older goldens keep working. Update a golden only when the change was intended.</p>
    </ReportPanel>
  );
}

/**
 * A golden neither passed nor failed: its gate ran out of attempts between its bounds, or a check
 * couldn't be decided. Its report, and what settles it: for a gate, Run more attempts, which continues
 * it to twice its limit with the attempts it has; for a judge check a replay golden couldn't ask
 * offline, Update golden, which asks it once and keeps its verdict (it asks first); for one a golden
 * that forks had no key for, the key, in the hint. More attempts of a golden that forks run live, so
 * they ask first: `ask` is what that question says besides the server's words, the command among it.
 */
export function InconclusivePanel({ v, off, canRun, onMore, prices, updateOff, canUpdate, onUpdate }: { v: InconclusiveView; off: string | undefined; canRun: boolean; onMore: (job: { golden: string; maxAttempts: number; continue: true }, ask: TestsAsk, e: Price) => void; prices: TestsEstimates | null | undefined; updateOff: string | undefined; canUpdate: boolean; onUpdate: (e: Price) => void }) {
  const more = v.gate?.more ?? null;
  const update = v.judge?.update ?? null;
  return (
    <ReportPanel name={v.name} runId={v.runId} lines={inconclusiveLines(v)} found={null} missed={null}>
      {more && canRun ? (
        <div className="actions">
          <JobButton className="btn" why={off} {...testsJob(moreCard(more), goldenPrice(prices, v.golden, 'more'), (e) => onMore(more.job, moreAttemptsAsk(v.name, more), e))}>
            Run more attempts
          </JobButton>
        </div>
      ) : update && canUpdate ? (
        <div className="actions">
          <JobButton className="btn" why={updateOff} {...testsJob(updateCard(v.golden, update), goldenPrice(prices, v.golden, 'update'), onUpdate)}>
            Update golden
          </JobButton>
        </div>
      ) : null}
      <p className="hintx">{inconclusiveHint(v)}</p>
    </ReportPanel>
  );
}

/** A failed check, a non-zero exit, no calls: as `test --markdown` prints it, with no normalizer to offer. */
export function FailurePanel({ f, off, live, button, onBisect }: { f: FailureView; off: string | null | undefined; live: boolean; button: { range: boolean; live: boolean } | null; onBisect: () => void }) {
  return (
    <ReportPanel name={f.name} runId={f.runId} lines={failureLines(f)} found={f.found} missed={f.missed}>
      {button ? (
        <div className="actions">
          <FindCommitButton f={f} live={live} why={off} onBisect={onBisect} />
        </div>
      ) : null}
      <p className="hintx">{failureHint(f)}</p>
    </ReportPanel>
  );
}
