import { useEffect, useRef, useState } from 'react';
import { consentAsked } from '../actions.js';
import { JOB_KINDS, ApiError } from '../api.js';
import { tipCard } from '../components/HoverCard.js';
import { Link } from '../components/Link.js';
import { Status } from '../components/Status.js';
import { ConsentDialog, PromptDialog } from '../components/Dialog.js';
import { headingRef } from '../focus-manager.js';
import { Page } from '../components/Page.js';
import { NotFoundPage } from '../pages/NotFound.js';
import { Elsewhere } from '../pages/held-elsewhere.js';
import { APPLY_ASK } from '../page-ask.js';
import { Unshown } from '../shell/unshown.js';
import { copyText } from '../dom.js';
import { GLUED_SEPARATOR, shortId } from '../format.js';
import { href } from '../route.js';
import { guardedWayOn, useApp } from '../state.js';
import { errorText } from '../toast.js';
import type { FixDetail, VerifyStep } from '../types.js';
import type { FixEstimates } from '../estimates-api.js';
import { BlameStepView } from './BlameStep.js';
import { rememberFix } from './data.js';
import { blameNextAsk } from './BlameAgain.js';
import { blameNextPrice, repairCard, useFixEstimates, verifyPrice } from './estimates.js';
import { FixJobButton } from './FixJobButton.js';
import { appliedButton, blameNextStep, failingLine, fixAction, fixName, fixStamp, laterStamp, leadingVerdict, repairAside, shortFixId, stepFor } from './model.js';
import { FixStepper, REPAIR_SPENT, showPatchCard, useFitFixHead } from './head.js';
import { failingCard, leadCard, rungStatus } from './list.js';
import { useFixRead, useFollowJobs } from './page-fix.js';
import { FailedMust } from './parts.js';
import { RepairStepView } from './RepairStep.js';
import { useServerJobs, useTreeBusy } from './tree.js';
import { leadWait, verifyTip } from './lead.js';
import { CrashStepButton } from '../revert/CrashStep.js';
import { EditorButton } from '../revert/EditorButton.js';
import { VerifyAsk } from './verify-asks.js';
import { VerifyLeftButton, VerifyStepView } from './VerifyStep.js';

export { StrongerDialog } from './BlameAgain.js';
import { ApplyDialog, PatchDialog, RepairDialog } from './FixDialogs.js';
export { ApplyDialog, PatchDialog, RepairDialog } from './FixDialogs.js';
import { ACTIONS } from '../labels.js';
import { ActionButton } from '../components/ActionButton.js';

/**
 * A fix (#/fixes/<id>[/<step>[/<sub>]]): its title, check and runs; the stepper (Blame, Repair,
 * Verify), opened on the step its URL names or its last finished one; and what can be done next:
 * Run repair on an open fix, Apply fix on a verified one.
 */
export function FixPage({ id, step, sub }: { id: string; step: string | null; sub: string | null }) {
  const { client, tick, feeds, jobs } = useApp();
  // A search or a revert of this tab's running: once it ends, the crash's step it leads with moves on.
  const crashJob = jobs.some((w) => !w.job.done && !w.lost && (w.job.kind === JOB_KINDS.bisect || w.job.kind === JOB_KINDS.revert));
  // Again when runs change, or fixes do (a title set in a terminal, a repair's report), or such a job
  // ends, each answer shared with what a job of the fix ends on in the drawer.
  const loaded = useFixRead(client, id, `${tick}:${feeds.fixes ?? 0}:${crashJob}`);
  const fix = loaded.data;
  useEffect(() => {
    if (fix) rememberFix(fix, id);
  }, [fix, id]);
  useFollowJobs(id, fix);
  if (!fix) {
    const loading = (
      <Page>
        <div className="empty tall">Loading the fix…</div>
      </Page>
    );
    // Another project may hold it: a link from there, or a page left open across a switch.
    if (loaded.error instanceof ApiError && loaded.error.status === 404)
      return (
        <Elsewhere
          ask={{ what: 'fix', ids: [id] }}
          error={loaded.error}
          waiting={loading}
          retry={loaded.reload}
          fallback={
            <>
              <Unshown at={`fixes:${id}`} />
              <NotFoundPage what={`No fix ${id}.`} />
            </>
          }
        />
      );
    if (!loaded.error) return loading;
    return (
      <Page>
        <div className="empty tall">
          {`Could not load the fix: ${loaded.error.message}. `}
          <a className="more" href={href.fixes()}>
            All fixes
          </a>
        </div>
      </Page>
    );
  }
  const current = stepFor(fix, step);
  return (
    <Page>
      <FixHeader fix={fix} reload={loaded.reload} shown={leadingVerdict(fix, step, sub)} />
      <FixStepper fix={fix} current={current} />
      {current === 'repair' ? <RepairStepView fix={fix} /> : current === 'verify' ? <VerifyStepView fix={fix} sub={sub} /> : <BlameStepView fix={fix} />}
    </Page>
  );
}

/** Runs › Failed, where a fix's failing runs link, as its Fixes row's do. */
const FAILED = href.runs({ types: 'failed' });

/**
 * The fix's header: its name over its title, in the UI face, a fix being named by a sentence; where it
 * stands as a dot and a word, as its Fixes row says it, then its failing runs (a link to Failed),
 * good runs and stamps; what failed and what it must do; and its buttons, beside the title or
 * stacked under it, lime first, where they would crowd it (`useFitFixHead`). The source shows only
 * where the status names no pull request (`merged · PR #138` says it already).
 */
function FixHeader({ fix, reload, shown }: { fix: FixDetail; reload: () => void; shown: VerifyStep | null }) {
  const app = useApp();
  const [renaming, setRenaming] = useState(false);
  const head = useFitFixHead();
  const status = rungStatus(fix);
  const card = failingCard({ failing: fix.failing, failingIds: fix.failingRuns.slice(0, 5).map((r) => shortId(r.runId)) });
  const prNamed = fix.rung === 'merged' && fix.pr?.number != null;
  return (
    <div className="ph fxh" ref={head}>
      <div>
        <div className="eyebrow">
          fix · <code>{fixName(fix)}</code>
        </div>
        <h1 ref={headingRef}>{fix.title}</h1>
        <p className="pmeta">
          {/* Each separator is held to the item before it, so a wrapped line never starts with one. */}
          <Status tone={status.tone}>{status.text}</Status>
          {GLUED_SEPARATOR}
          <span>
            <Link href={FAILED} quiet tip={tipCard(card.title, [], card.text)}>
              {failingLine(fix)}
            </Link>
          </span>
          {GLUED_SEPARATOR}
          <span>{`${fix.good} good`}</span>
          {GLUED_SEPARATOR}
          <span>opened {fixStamp(fix.openedAt)}</span>
          {fix.verifiedAt ? (
            <>
              {GLUED_SEPARATOR}
              <span>verified {laterStamp(fix.verifiedAt, fix.openedAt)}</span>
            </>
          ) : null}
          {fix.appliedAt ? (
            <>
              {GLUED_SEPARATOR}
              <span>applied {laterStamp(fix.appliedAt, fix.verifiedAt ?? fix.openedAt)}</span>
            </>
          ) : null}
          {fix.source && !prNamed ? (
            <>
              {GLUED_SEPARATOR}
              <span className="fxsource">{fix.source}</span>
            </>
          ) : null}
          {app.exported ? null : (
            <ActionButton className="linkbtn fxrename" title="Give this fix a title of your own" onClick={() => app.guard(() => setRenaming(true))}>
              Rename
            </ActionButton>
          )}
        </p>
        {/* What failed and what it must do, as the list says it: the title says what failed until someone renames it. */}
        <p className="chk">
          <FailedMust fix={fix} />
        </p>
        {fix.broken ? <p className="fxbad">This fix doesn’t hold: {fix.broken}.</p> : null}
      </div>
      <div className="actions">
        <FixActions fix={fix} shown={shown} />
      </div>
      {renaming ? (
        <RenameFixDialog fix={fix} onClose={() => setRenaming(false)} onDone={reload} />
      ) : null}
    </div>
  );
}

/** Rename fix: a title of its own, kept when later blames join the fix. */
export function RenameFixDialog({ fix, onClose, onDone }: { fix: FixDetail; onClose: () => void; onDone: () => void }) {
  const app = useApp();
  return (
    <PromptDialog
      title="Rename fix"
      lead="Gives the fix a title of your own, kept when later blames join it."
      doc="fixTitles"
      label="Title"
      initial={fix.title}
      maxLength={160}
      ok="Rename"
      command={(title) => `shadowlap fix title ${shortFixId(fix.fixId)} ${title ? `"${title.replace(/(["\\$`])/g, '\\$1')}"` : '…'}`}
      onClose={onClose}
      onRun={(title) =>
        guardedWayOn(app.guard, () =>
          app.client.renameFix(fix.fixId, title).then(
            (d) => {
              rememberFix(d);
              app.toast(`Renamed: ${d.title}`);
              onDone();
              return true;
            },
            (err: unknown) => {
              app.toast(errorText(err), 'error');
              return false;
            },
          ),
        )
      }
    />
  );
}

/** What a button of the header opens: Run repair's dialog, Apply fix's (Mark applied, Finish applying), or the patch to read. */
type Ask = 'repair' | 'apply' | 'patch';

/** What each status's buttons are given: the fix, its prices, the lead that takes the lime (none while its Verify step leads), why its write waits, and what a press opens. */
interface ButtonsProps {
  fix: FixDetail;
  prices: FixEstimates | null | undefined;
  lime: FixDetail['lead'];
  why: string | null;
  ask: (what: Ask) => void;
}

/** Why the fix's write can't start (Run repair on an open fix, its apply otherwise): nothing runs here, the server doesn't run it, or a job holds the working tree. */
function useWriteWhy(fix: FixDetail): string | null {
  const app = useApp();
  const open = fix.status === 'open';
  // A repair or an apply changes the working tree: it waits for every job running the agent from it.
  const busy = useTreeBusy('writes', open ? 'repair' : 'apply the patch');
  const missing = app.hasKind(open ? JOB_KINDS.repair : JOB_KINDS.applyFix) ? null : `This dashboard doesn’t run ${open ? 'repair' : 'fix apply'}: run it in a terminal.`;
  return app.actionsOff ?? missing ?? busy;
}

/**
 * Asked from the palette's Apply fix, on this page already or arriving on it: its dialog opens as a
 * press of the button would, or a toast says why it can't. Mounted for every status, so a fix with
 * nothing to apply still says why.
 */
function usePaletteApply(fix: FixDetail, why: string | null, open: () => void): void {
  const app = useApp();
  const asked = useRef(() => {});
  asked.current = () => {
    const action = fixAction(fix);
    const cant = action.kind === 'apply' ? why : action.kind === 'none' ? (app.actionsOff ?? action.why) : null;
    if (cant) app.toast(cant);
    else if (action.kind === 'apply') open();
  };
  useEffect(() => {
    const go = () => asked.current();
    if (APPLY_ASK.take(fix.fixId)) go();
    return APPLY_ASK.on(go, fix.fixId);
  }, [fix.fixId]);
}

/**
 * The header's buttons, by where the fix stands, the server's `lead` (fix-lead.ts, which its Fixes
 * row leads with too) the one lime: an open fix's (`OpenButtons`), an applied one's
 * (`AppliedButtons`), a merged one's (`MergedButtons`), a verified one's (`VerifiedButtons`). While
 * the Verify step shows a verdict that leads with its own next step (`shown`: Run more attempts,
 * Verify again), that step is the lime one, rightmost, the rest plain before it. Each asks first as
 * its dialog says; a job whose runs came from someone else's pack asks once more before it runs their
 * command.
 */
export function FixActions({ fix, shown = null }: { fix: FixDetail; shown?: VerifyStep | null }) {
  const app = useApp();
  // What its billed jobs would cost, asked as the page opens and whenever the fix moves.
  const prices = useFixEstimates(fix);
  const why = useWriteWhy(fix);
  const [asking, setAsking] = useState<Ask | null>(null);
  const [consent, setConsent] = useState<{ why: string; confirm: string; kind: string; fields: Record<string, unknown> } | null>(null);
  usePaletteApply(fix, why, () => setAsking('apply'));
  if (app.exported) return null;
  const action = fixAction(fix);
  const diff = fix.actions.apply?.diff ?? null;
  const start = (jobKind: string, fields: Record<string, unknown>) =>
    app.client.startJob(jobKind, fields).then(
      (job) => app.watchJob(Promise.resolve(job)),
      (err: unknown) => {
        const asked = fields.yes === undefined ? consentAsked(err) : null;
        if (asked) setConsent({ ...asked, kind: jobKind, fields });
        else app.watchJob(Promise.reject(err));
      },
    );
  // The patch is only read; the rest asks before it starts anything.
  const ask = (what: Ask) => (what === 'patch' ? setAsking(what) : app.guard(() => setAsking(what)));
  const props: ButtonsProps = { fix, prices, lime: shown ? null : fix.lead, why, ask };
  const close = () => setAsking(null);
  return (
    <>
      {fix.status === 'open' ? <OpenButtons {...props} shown={!!shown} /> : fix.actions.applied ? <AppliedButtons {...props} /> : fix.rung === 'merged' ? <MergedButtons {...props} /> : <VerifiedButtons {...props} />}
      {shown ? <VerdictNext fix={fix} v={shown} prices={prices} /> : null}
      {asking === 'repair' ? <RepairDialog fix={fix} onClose={close} onRun={(repairer, sent) => app.guard(() => void start(JOB_KINDS.repair, { fixId: fix.fixId, repairer, ...sent }))} /> : null}
      {asking === 'apply' && action.kind === 'apply' ? <ApplyDialog fix={fix} label={action.label} onClose={close} onRun={(names) => app.guard(() => void start(JOB_KINDS.applyFix, { fixId: fix.fixId, ...(names ? { names } : {}) }))} /> : null}
      {asking === 'patch' && diff ? <PatchDialog fix={fix} diff={diff} onClose={close} /> : null}
      {consent ? (
        <ConsentDialog
          why={consent.why}
          ok={consent.kind === JOB_KINDS.repair ? ACTIONS.runRepair.label : 'Run command'}
          onClose={() => setConsent(null)}
          onOk={() => app.guard(() => void start(consent.kind, { ...consent.fields, yes: consent.confirm }))}
        />
      ) : null}
    </>
  );
}

/**
 * An open fix's buttons: Run repair, then blame's next step (Run blame again while its blame couldn't
 * settle or stopped part way, Run blame with stronger model while asking the recorded model again
 * rescued the run from no call). Run repair stays plain, saying why on hover, where it would end "No
 * fix to try" (`repairAside`), and waits, saying why, after a repair whose gate rejected every
 * candidate (`repair.spent`): then the fix leads with what that repair's verdict left (Run more
 * attempts, Verify again), and nothing else, unless the Verify step shows its own (`shown`).
 */
function OpenButtons({ fix, prices, lime, why, ask, shown }: ButtonsProps & { shown: boolean }) {
  const app = useApp();
  const repair = fix.actions.repair;
  const spent = !!repair?.spent;
  const aside = repairAside(fix);
  const blameNext = spent ? null : blameNextStep(fix);
  const left = spent && !shown && (lime?.key === 'more' || lime?.key === 'again') ? fix.verify.find((v) => v.verifyId === lime.verifyId) : undefined;
  const none = fixAction(fix);
  return (
    <>
      {repair ? (
        <ActionButton className={lime?.key === 'repair' ? 'btn lime' : 'btn'} why={spent ? REPAIR_SPENT.why : why} whyTip={spent ? REPAIR_SPENT.tip : undefined} {...repairCard(fix, 'repair', aside, prices)} onClick={() => ask('repair')}>
          {ACTIONS.runRepair.label}
        </ActionButton>
      ) : (
        <ActionButton className="btn" why={app.actionsOff ?? (none.kind === 'none' ? none.why : null)}>
          {ACTIONS.runRepair.label}
        </ActionButton>
      )}
      {blameNext ? (
        <FixJobButton
          kind={JOB_KINDS.blame}
          fields={blameNext.kind === 'again' ? { fixId: fix.fixId, again: true } : { fixId: fix.fixId }}
          label={blameNext.label}
          verb={blameNext.kind === 'again' ? 'blame again' : 'blame it'}
          lead={lime?.key === (blameNext.kind === 'again' ? 'blame-again' : 'blame-stronger')}
          tip={blameNext.tip}
          command={blameNext.command}
          estimate={blameNextPrice(blameNext.kind, prices)}
          form={blameNext.kind === 'stronger'}
          ask={blameNextAsk(fix, blameNext.kind, blameNextPrice(blameNext.kind, prices))}
        />
      ) : null}
      <CrashButtons fix={fix} lime={lime} />
      {left ? <VerdictNext fix={fix} v={left} prices={prices} /> : null}
    </>
  );
}

/**
 * A crash's own step at the head's end, where the fix leads with it (fix-lead.ts): Find breaking
 * commit, then, once that named the commit, Open in editor at the line the commit added and Revert,
 * the page's lead, with the commit the Blame step shows. Find breaking commit is gone once the commit
 * is named: the run's page keeps it, to search again. Each waits as its row on Fixes does.
 */
function CrashButtons({ fix, lime }: Pick<ButtonsProps, 'fix' | 'lime'>) {
  const app = useApp();
  const lead = fix.lead?.key === 'bisect' || fix.lead?.key === 'revert' ? fix.lead : null;
  const jobs = useServerJobs(!!lead);
  if (!lead) return null;
  const leads = lime?.key === lead.key;
  const why = app.actionsOff ?? leadWait(lead, { jobs, folder: app.meta?.project?.path ?? null, projectId: app.meta?.project?.id ?? null, hasKind: app.hasKind });
  const found = fix.blame?.crash?.commit ?? null;
  return (
    <>
      {lead.key === 'revert' ? <EditorButton change={found?.change} /> : null}
      <CrashStepButton runId={lead.runId} step={lead.step} why={why} className={leads ? 'btn lime' : 'btn'} lead={leads} found={found} />
    </>
  );
}

/** A verified fix's buttons: Copy git apply, Apply fix (Mark applied for a change in the working tree already, or with no patch), then Verify this run while a failing run no accepted verdict checked is left. */
function VerifiedButtons({ fix, prices, lime, why, ask }: ButtonsProps) {
  const app = useApp();
  const gitApply = fix.actions.apply?.gitApply ?? null;
  return (
    <>
      {gitApply ? (
        <button
          className="btn"
          type="button"
          data-tip={tipCard('Copy git apply', [], 'git applies the patch as it was verified, whatever core.autocrlf says', `$ ${gitApply}`)}
          onClick={() => {
            void copyText(gitApply).then((ok) => app.toast(ok ? 'Copied git apply' : 'Copying was refused by the browser'));
          }}
        >
          Copy git apply
        </button>
      ) : null}
      <ApplyButton fix={fix} lime={lime} why={why} ask={ask} />
      <VerifyLeftButton fix={fix} prices={prices} lead={lime?.key === 'verify-left'} />
    </>
  );
}

/** An applied fix's buttons: its patch to read, then Finish applying while applying left something undone; Marked applied, plain, for one with no patch, its hover naming the change. */
function AppliedButtons({ fix, lime, why, ask }: ButtonsProps) {
  const marked = appliedButton(fix.actions.apply);
  return (
    <>
      <ShowPatch fix={fix} ask={ask} />
      {fixAction(fix).kind !== 'applied' ? (
        <ApplyButton fix={fix} lime={lime} why={why} ask={ask} />
      ) : marked ? (
        <button className="btn" type="button" disabled title={marked.title}>
          {marked.label}
        </button>
      ) : null}
    </>
  );
}

/** A fix merged with its pull request: nothing waits to apply. Its patch to read, then Verify this run while a failing run no accepted verdict checked is left. */
function MergedButtons({ fix, prices, lime, ask }: ButtonsProps) {
  return (
    <>
      <ShowPatch fix={fix} ask={ask} />
      <VerifyLeftButton fix={fix} prices={prices} lead={lime?.key === 'verify-left'} />
    </>
  );
}

/** Apply fix, Mark applied or Finish applying, lime when the fix leads with it; waiting, with why, for a patch fix apply refuses. Its card is the one its Fixes row gives the same step. */
function ApplyButton({ fix, lime, why, ask }: Pick<ButtonsProps, 'fix' | 'lime' | 'why' | 'ask'>) {
  const action = fixAction(fix);
  if (action.kind === 'none')
    return (
      <ActionButton className="btn" why={action.why}>
        {action.label}
      </ActionButton>
    );
  if (action.kind !== 'apply') return null;
  const apply = fix.actions.apply;
  const sub = leadCard({ key: 'apply', label: action.label, command: apply?.command ?? '', use: 'writes', pending: fix.actions.applied ? (apply?.pending ?? null) : null });
  return (
    <ActionButton className={lime?.key === 'apply' ? 'btn lime' : 'btn'} why={why} tip={action.label} sub={sub} command={apply ? `$ ${apply.command}` : undefined} onClick={() => ask('apply')}>
      {action.label}
    </ActionButton>
  );
}

/** Show patch, on an applied or merged fix with a patch: what went in, to read, never a git apply that would fail. */
function ShowPatch({ fix, ask }: Pick<ButtonsProps, 'fix' | 'ask'>) {
  if (!fix.actions.apply?.diff) return null;
  return (
    <button className="btn" type="button" data-tip={tipCard('Show patch', [], showPatchCard(fix))} onClick={() => ask('patch')}>
      Show patch
    </button>
  );
}

/** A verdict's own next step, Run more attempts or Verify again, as the header's lime button: priced on the fix's estimates, asking by Spending's rule. */
function VerdictNext({ fix, v, prices }: { fix: FixDetail; v: VerifyStep; prices: FixEstimates | null | undefined }) {
  const more = v.more;
  if (!more) return null;
  const estimate = verifyPrice(prices, v.verifyId);
  return (
    <FixJobButton
      kind={JOB_KINDS.verify}
      fields={{ fixId: fix.fixId, verifyId: v.verifyId }}
      label={more.kind === 'more' ? ACTIONS.runMoreAttempts.label : ACTIONS.verifyAgain.label}
      verb={more.kind === 'more' ? 'run more attempts' : 'verify again'}
      lead
      tip={verifyTip(more)}
      command={more.command}
      estimate={estimate}
      ask={(begin, close) => <VerifyAsk more={more} attempts={v.attempts} estimate={estimate} onRun={() => begin({})} onClose={close} />}
    />
  );
}
