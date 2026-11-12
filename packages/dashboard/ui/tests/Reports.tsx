import type { ReactNode } from 'react';
import type { BisectMiss, DivergenceView, FailureView, FoundCommit, InconclusiveView, NextStep } from '../api.js';
import { Code, Copy } from '../components/Copy.js';
import { JobButton } from '../components/JobButton.js';
import type { TestsEstimates } from '../estimates-api.js';
import { divergenceButtons, failureHint, failureLines, inconclusiveHint, inconclusiveLines, missedLine, reportLines, type ReportLine } from '../goldens.js';
import { ACTIONS, confirmWords } from '../labels.js';
import { FindCommitButton } from '../pages/TestsDialogs.js';
import { moreCard, normalizeCard, testsJob, updateCard } from '../pages/tests-cards.js';
import { ChangeBox } from '../revert/ChangeBox.js';
import { FoundCommitLine } from '../revert/FoundLine.js';
import { RevertButton } from '../revert/RevertButton.js';
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

/**
 * What Find breaking commit found: the first bad commit, its message, who made it, when, and what it
 * cost, then its change in its file's box, as git shows it, with Open in editor and Copy git revert,
 * where the answer kept one.
 */
function BisectCard({ found }: { found: FoundCommit }) {
  return (
    <>
      <FoundCommitLine found={found} />
      {found.change ? <ChangeBox rev={found.rev} change={found.change} /> : null}
    </>
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
        <Copy className="hintx tnote">
          <Code>{d.volatile.path}</Code> changed, and it may be a real change, such as another customer or another order. If it is made anew on every run, add the normalizer; if the change was intended, update the golden.
        </Copy>
      ) : b.note ? (
        <Copy className="hintx tnote">
          The normalizer for <Code>{d.volatile?.path ?? 'it'}</Code> is in shadowlap.config.json now. {b.note === 'rules-added' ? 'Run the golden again to see it pass.' : 'It masks the value, but the request also carries what the recording never had: update the golden.'}
        </Copy>
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
      <Copy className="hintx">Normalizers apply at match time, so older goldens keep working. Update a golden only when the change was intended.</Copy>
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
      <Copy className="hintx">{inconclusiveHint(v)}</Copy>
    </ReportPanel>
  );
}

/** The hint under a crash whose first bad commit stands, in place of the exit's: what to do with the commit. */
const NAMED_CRASH = 'The agent stopped part way at the commit above: revert it or fix the code, then run the tests.';

/** What a failure's hint says: a crash whose commit is named, what to do with it, else as `failureHint` says (a blocked connection's first). */
const hintOf = (f: FailureView): string => (f.failure === 'exit' && f.found && !f.blocked?.length ? NAMED_CRASH : failureHint(f));

/**
 * A failed check, a non-zero exit, no calls: as `test --markdown` prints it, with no normalizer to
 * offer. A crash whose first bad commit stands offers Revert (`step`, the golden's as the server
 * leads it), plain: the verdict's step is the page's lime. The test after it is priced as Re-run test.
 */
export function FailurePanel({ f, off, live, button, step, prices, onBisect }: { f: FailureView; off: string | null | undefined; live: boolean; button: { range: boolean; live: boolean } | null; step: NextStep | undefined; prices: TestsEstimates | null | undefined; onBisect: () => void }) {
  const revert = step?.key === 'revert' ? step : null;
  return (
    <ReportPanel name={f.name} runId={f.runId} lines={failureLines(f)} found={f.found} missed={f.missed}>
      {button || revert ? (
        <div className="actions">
          {revert ? <RevertButton step={revert} found={f.found} estimate={goldenPrice(prices, f.golden, 'rerun')} runId={f.runId} /> : null}
          {button ? <FindCommitButton f={f} live={live} why={off} onBisect={onBisect} /> : null}
        </div>
      ) : null}
      <Copy className="hintx">{hintOf(f)}</Copy>
    </ReportPanel>
  );
}
