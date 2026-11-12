import { useEffect } from 'react';
import type { DivergenceView, FailureView, InconclusiveView, TestsSessionView, TestsView } from '../api.js';
import { ActionButton, useOfflineLink } from '../components/ActionButton.js';
import { tipCard, tipText } from '../components/HoverCard.js';
import { JobButton } from '../components/JobButton.js';
import { VerdictLine } from '../components/VerdictLine.js';
import type { TestsEstimates } from '../estimates-api.js';
import { RunBlameButton } from '../fixes/RunBlame.js';
import { commandText, sessionLine } from '../goldens.js';
import { useNow } from '../hooks.js';
import { moreCard, normalizeCard, testsJob, updateCard } from '../pages/tests-cards.js';
import { FindCommitButton } from '../pages/TestsDialogs.js';
import { RevertButton } from '../revert/RevertButton.js';
import { goldenPrice, type Price } from '../tests-estimates.js';
import { keepLead } from './job-footer.js';
import type { Lead } from './lead.js';

/** What the lead step presses: the page's own jobs, as each golden's report presses them, and why one waits. */
export interface LeadPress {
  wait: (verb: string) => string | null;
  prices: TestsEstimates | null | undefined;
  live: (f: DivergenceView | FailureView) => boolean;
  onNormalize: (d: DivergenceView, e: Price) => void;
  onUpdate: (golden: string, e: Price) => void;
  onFind: (f: DivergenceView | FailureView) => void;
  onMore: (v: InconclusiveView, e: Price) => void;
  /** Re-run test of a golden whose injection gate showed too little to say: its test again, which plants the same payloads. */
  onRerun: (golden: string, e: Price) => void;
  /** Run tests as the page's header runs it, the whole session: null where the server runs no tests. */
  runTests: ReturnType<typeof testsJob> | null;
  /** The check builder on a golden at a check, by its label, and its script asked for ahead: null where the page has no builder. */
  edit: { open: (golden: string, check: string) => void; preload: () => void } | null;
}

/**
 * A golden's step: lime as the verdict's, the page's one lime button while it leads (`leadStep`);
 * plain as its report's, where the verdict's lime is the page's.
 */
export function LeadButton({ lead, p, lime = true }: { lead: Lead; p: LeadPress; lime?: boolean }) {
  const btn = lime ? 'btn lime' : 'btn';
  switch (lead.kind) {
    case 'normalize': {
      const { d, n } = lead;
      return (
        <JobButton className={btn} why={p.wait(n.run === 'rerun' ? 'run it again' : 'add the normalizer')} {...testsJob(normalizeCard(d, n), goldenPrice(p.prices, d.golden, n.run === 'rerun' ? 'rerun' : 'normalize'), (e) => p.onNormalize(d, e))}>
          {lead.label}
        </JobButton>
      );
    }
    case 'update':
      return (
        <JobButton className={btn} why={p.wait('update it')} {...testsJob(updateCard(lead.golden, lead.judge), goldenPrice(p.prices, lead.golden, 'update'), (e) => p.onUpdate(lead.golden, e))}>
          {lead.label}
        </JobButton>
      );
    case 'bisect':
      return <FindCommitButton f={lead.f} live={p.live(lead.f)} why={p.wait('find the breaking commit')} lime={lime} onBisect={() => p.onFind(lead.f)} />;
    case 'revert':
      return <RevertButton step={lead.step} found={lead.f.found} estimate={goldenPrice(p.prices, lead.f.golden, 'rerun')} runId={lead.f.runId} lead={lime} />;
    case 'more':
      return (
        <JobButton className={btn} why={p.wait('run the tests')} {...testsJob(moreCard(lead.more), goldenPrice(p.prices, lead.v.golden, 'more'), (e) => p.onMore(lead.v, e))}>
          {lead.label}
        </JobButton>
      );
    case 'rerun':
      return (
        <JobButton className={btn} why={p.wait('run it again')} {...testsJob({ tip: lead.label, sub: lead.sub ?? '', command: lead.command ?? commandText(['test', lead.golden]) }, goldenPrice(p.prices, lead.golden, 'rerun'), (e) => p.onRerun(lead.golden, e))}>
          {lead.label}
        </JobButton>
      );
    case 'proof':
      return <ProofLead lead={lead} />;
    case 'fix':
      return (
        <a className={btn} href={lead.href} data-tip={tipCard(lead.title ?? lead.label, [], `The fix for this failure: ${lead.check}`)}>
          {lead.label}
        </a>
      );
    case 'edit': {
      const ahead = () => p.edit?.preload();
      return (
        <ActionButton className="btn lime" data-step="edit-check" data-g={lead.golden} tip={lead.label} sub={lead.sub} onPointerEnter={ahead} onFocus={ahead} onClick={() => p.edit?.open(lead.golden, lead.check)}>
          {lead.label}
        </ActionButton>
      );
    }
    case 'blame':
      return <RunBlameButton runId={lead.runId} offer={lead.step.offer} className={btn} lead={lime} {...(lead.step.capture ? { capture: true } : {})} {...(lead.step.command ? { line: lead.step.command } : {})} />;
  }
}

/** Open proof: the attempt that proves the gate failed, waiting while the server is out of reach, as every link to an attempt does. */
function ProofLead({ lead }: { lead: Extract<Lead, { kind: 'proof' }> }) {
  const offline = useOfflineLink();
  return (
    <a className="btn lime" href={lead.href} data-tip={tipCard(lead.title ?? lead.label, [], lead.sub)} onClick={offline}>
      {lead.label}
    </a>
  );
}

/** A word for each verdict, in its colour, as the mock says it: never a count in a tinted badge. */
const WORDS = { failing: ['failed', 'err'], inconclusive: ['inconclusive', 'warn'], passing: ['passed', 'ok'] } as const;

/** Tests' verdict: how the goldens' last results came out, the session that tested them, and the step the first failure leads with. */
export function Verdict({ view, running, lead, press }: { view: TestsView; running: boolean; lead: Lead | null; press: LeadPress }) {
  const v = view.verdict;
  // What a test job's drawer ends on over Tests: this step, as each view the page reads leads with it.
  const label = lead ? (lead.kind === 'blame' ? lead.step.label : lead.label) : null;
  useEffect(() => keepLead(label), [view, label]);
  useEffect(() => () => keepLead(null), []);
  // A session that ended within the minute says just now, then its time.
  const now = useNow();
  // A session that runs every golden: the verdict follows it, how far it has got, and no step.
  if (view.following?.whole && view.running) return <RunningVerdict s={view.running} reached={view.following.reached} total={view.following.total} />;
  if (!v) {
    const command = commandText(view.commands.run);
    // No golden replayed yet, though its error-path presets may have run: then it has been tested, and says so.
    const presets = view.rows.filter((r) => r.presets).length;
    const one = view.goldens === 1;
    const facts = (
      <>
        {presets ? `Error-path presets ran on ${presets === view.goldens ? (one ? 'it' : 'every one') : `${presets} of them`}. ` : null}
        {view.rows.some((r) => r.mode === 'fork') ? 'Run tests replays each one, those marked fork live from where they fork' : 'Run tests replays each one offline'}: <SessionCommand text={command} />
      </>
    );
    return (
      <VerdictLine className="tv" word={presets ? 'not replayed yet' : 'not run yet'} tone="mu" facts={facts}>
        {presets ? (one ? 'One golden, not replayed yet' : `${view.goldens} goldens, none replayed yet`) : one ? 'One golden, not tested yet' : `${view.goldens} goldens, none tested yet`}
      </VerdictLine>
    );
  }
  const line = sessionLine(view, running, now)!;
  const [word, tone] = WORDS[v.state];
  const facts = (
    <>
      <SessionCommand text={line.command} /> · {line.rest}
      {view.older && !line.live ? (
        <>
          {' · '}
          <span className="tstale">older than your working tree</span>
        </>
      ) : null}
      {line.since ? (
        <>
          {' · '}
          <span className="tsince" data-tip={line.sinceTip ? tipCard('run again on its own since', [], line.sinceTip) : undefined}>
            {line.since}
          </span>
        </>
      ) : null}
    </>
  );
  return (
    <VerdictLine className="tv" word={word} tone={tone} facts={facts} actions={lead ? <LeadButton lead={lead} p={press} /> : undefined}>
      {v.title}
    </VerdictLine>
  );
}

/** The verdict while a session runs every golden: `running`, the goldens it has reached of those it runs, and its facts so far. */
function RunningVerdict({ s, reached, total }: { s: TestsSessionView; reached: number; total: number }) {
  const line = sessionLine({ verdict: { session: s, since: [] } }, true)!;
  const facts = (
    <>
      <SessionCommand text={line.command} /> · {line.rest}
    </>
  );
  return (
    <VerdictLine className="tv" word="running" tone="mu" facts={facts}>
      {`${reached} of ${total} ${total === 1 ? 'golden' : 'goldens'}`}
    </VerdictLine>
  );
}

/** The session's command on the verdict's line: on one line, cut short with its whole text on hover when it is longer than the line. */
function SessionCommand({ text }: { text: string }) {
  return (
    <code className="vcmd" data-tip={tipText(text)}>
      {text}
    </code>
  );
}
