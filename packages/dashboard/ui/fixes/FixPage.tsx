import { useEffect, useState } from 'react';
import { consentAsked } from '../actions.js';
import { JOB_KINDS, ApiError, type JobView } from '../api.js';
import { Badge, CmdLine } from '../components/bits.js';
import { ConfirmDialog, ConsentDialog, Dialog, PromptDialog } from '../components/Dialog.js';
import { Page } from '../components/Page.js';
import { NotFoundPage } from '../pages/NotFound.js';
import { copyText } from '../dom.js';
import { approx, GLUED_SEPARATOR } from '../format.js';
import { useLoad } from '../hooks.js';
import { addJobFooter } from '../job-actions.js';
import { href } from '../route.js';
import { useApp } from '../state.js';
import { errorText } from '../toast.js';
import type { FixDetail } from '../types.js';
import { BlameStepView } from './BlameStep.js';
import { rememberFix } from './data.js';
import { FixJobButton } from './FixJobButton.js';
import { appliedButton, applyText, blameNextStep, fixAction, fixName, fixStamp, laterStamp, markText, outdatedOf, patchLines, repairAsk, repairAside, shortFixId, statusBadge, stepFor, stepLeads, updateOutdatedAsk } from './model.js';
import { FailedMust, Flagged } from './parts.js';
import { RepairStepView } from './RepairStep.js';
import { useTreeBusy } from './tree.js';
import { VerifyStepView } from './VerifyStep.js';
import { ACTIONS, confirmWords } from '../labels.js';

/**
 * A fix (#/fixes/<id>[/<step>[/<sub>]]): its title, check and runs; the stepper (Blame, Repair,
 * Verify), opened on the step its URL names or its last finished one; and what can be done next:
 * Run repair on an open fix, Apply fix on a verified one.
 */
export function FixPage({ id, step, sub }: { id: string; step: string | null; sub: string | null }) {
  const { client, tick, feeds } = useApp();
  // Again when runs change, or fixes do (a title set in a terminal, a repair's report).
  const loaded = useLoad(() => client.fix(id), `fix:${id}`, `${tick}:${feeds.fixes ?? 0}`);
  const fix = loaded.data;
  useEffect(() => {
    if (fix) rememberFix(fix, id);
  }, [fix, id]);
  if (!fix) {
    if (loaded.error instanceof ApiError && loaded.error.status === 404) return <NotFoundPage what={`No fix ${id}.`} />;
    return (
      <Page>
        <div className="empty tall">
          {loaded.error ? `Could not load the fix: ${loaded.error.message}. ` : 'Loading the fix…'}
          {loaded.error ? (
            <a className="more" href={href.fixes()}>
              All fixes
            </a>
          ) : null}
        </div>
      </Page>
    );
  }
  const current = stepFor(fix, step);
  return (
    <Page>
      <FixHeader fix={fix} reload={loaded.reload} leads={stepLeads(fix, step, sub)} />
      <nav className="stepper" aria-label="Steps">
        {fix.steps.map((x) => (
          <a key={x.key} className={x.state} href={href.fixes(fix.fixId, x.key)} aria-current={x.key === current ? 'step' : undefined}>
            <span className="k">
              <i />
              {x.n} · {x.key}
            </span>
            <b>{x.title}</b>
            <span className="m">
              <Flagged text={x.meta} />
            </span>
          </a>
        ))}
      </nav>
      {current === 'repair' ? <RepairStepView fix={fix} /> : current === 'verify' ? <VerifyStepView fix={fix} sub={sub} /> : <BlameStepView fix={fix} />}
    </Page>
  );
}

function FixHeader({ fix, reload, leads }: { fix: FixDetail; reload: () => void; leads: boolean }) {
  const app = useApp();
  const [renaming, setRenaming] = useState(false);
  const badge = statusBadge(fix);
  const s = (n: number) => (n === 1 ? '' : 's');
  return (
    <div className="ph">
      <div>
        <div className={`eyebrow${fix.status === 'open' ? ' fork' : ''}`}>
          <i />
          fix · <code>{fixName(fix)}</code>
        </div>
        <h1>{fix.title}</h1>
        <p className="pmeta">
          {/* Each separator is held to the item before it, so a wrapped line never starts with one. */}
          <Badge tone={badge.tone}>{badge.text}</Badge> <span>{`${fix.failing} failing run${s(fix.failing)}`}</span>
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
          {fix.source ? (
            <>
              {GLUED_SEPARATOR}
              <span className="fxsource">{fix.source}</span>
            </>
          ) : null}
          {app.exported ? null : (
            <button className="linkbtn fxrename" type="button" disabled={!!app.actionsOff} title={app.actionsOff ?? 'Give this fix a title of your own'} onClick={() => app.guard(() => setRenaming(true))}>
              Rename
            </button>
          )}
        </p>
        {/* What failed and what it must do, as the list says it: the title says what failed until someone renames it. */}
        <p className="chk">
          <FailedMust fix={fix} />
        </p>
        {fix.broken ? <p className="fxbad">This fix doesn’t hold: {fix.broken}.</p> : null}
      </div>
      <div className="actions">
        <FixActions fix={fix} leads={leads} />
      </div>
      {renaming ? (
        <PromptDialog
          title="Rename this fix"
          text="A title of your own stays when later blames join the fix."
          label="Title"
          initial={fix.title}
          maxLength={160}
          ok="Rename"
          command={`shadowlap fix title ${shortFixId(fix.fixId)} …`}
          onClose={() => setRenaming(false)}
          onRun={(title) => {
            setRenaming(false);
            app.client.renameFix(fix.fixId, title).then(
              (d) => {
                rememberFix(d);
                app.toast(`Renamed: ${d.title}`);
                reload();
              },
              (err: unknown) => app.toast(errorText(err), 'error'),
            );
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Run repair, or Copy git apply and Apply fix, each asking first. Disabled, with the
 * reason, where nothing runs, while another job uses the working tree, or when there is nothing to
 * do. A repair whose runs came from someone else's pack asks once more before it runs their command.
 * Run repair is the lead action unless it would end "No fix to try", the blame of every
 * failing run having rescued it from no call: then it stays, as a plain button that says why on
 * hover (`repairAside`), and the blame's own next step leads when there is one (`blameNextStep`):
 * Run blame again, for a blame that couldn't settle or stopped part way, or Run blame with stronger
 * model, which asks for the model. A patch in the working tree already, merged or applied by hand,
 * is only to be marked applied, and an applied fix offers its patch to read: git apply would fail
 * on either. While the open step leads with its own next step (`leads`: a verdict left incomplete,
 * with Run more attempts), every button here reads plain.
 */
export function FixActions({ fix, leads = false }: { fix: FixDetail; leads?: boolean }) {
  const app = useApp();
  const action = fixAction(fix);
  // A repair or an apply changes the working tree: it waits for every job running the agent from it.
  const busy = useTreeBusy('writes', fix.status === 'open' ? 'repair' : 'apply the patch');
  const [asking, setAsking] = useState<'repair' | 'apply' | 'patch' | null>(null);
  const [consent, setConsent] = useState<{ why: string; confirm: string; kind: string; fields: Record<string, unknown> } | null>(null);
  if (app.exported) return null;
  const off = app.actionsOff;
  const gitApply = fix.actions.apply?.gitApply ?? null;
  const diff = fix.actions.applied ? (fix.actions.apply?.diff ?? null) : null;
  const copy = gitApply ? (
    <button
      className="btn"
      type="button"
      onClick={() => {
        void copyText(gitApply).then((ok) => app.toast(ok ? 'Copied git apply' : 'Copying was refused by the browser'));
      }}
    >
      Copy git apply
    </button>
  ) : diff ? (
    <>
      <button className="btn" type="button" onClick={() => setAsking('patch')}>
        View the patch
      </button>
      {asking === 'patch' ? <PatchDialog fix={fix} diff={diff} onClose={() => setAsking(null)} /> : null}
    </>
  ) : null;
  if (action.kind === 'none')
    return (
      <>
        {copy}
        <button className="btn lime" type="button" disabled title={off ?? action.why}>
          {action.label}
        </button>
      </>
    );
  if (action.kind === 'applied') {
    // A fix with no patch was only marked applied: its button says so, and never speaks of a patch.
    const done = appliedButton(fix.actions.apply);
    return (
      <>
        {copy}
        <button className="btn" type="button" disabled title={done.title}>
          {done.label}
        </button>
      </>
    );
  }
  const kind = action.kind === 'repair' ? JOB_KINDS.repair : JOB_KINDS.applyFix;
  const aside = action.kind === 'repair' ? repairAside(fix) : null;
  const blameNext = action.kind === 'repair' ? blameNextStep(fix) : null;
  const missing = app.hasKind(kind) ? null : `This dashboard doesn’t run ${action.kind === 'repair' ? 'repair' : 'fix apply'}: run it in a terminal.`;
  const why = off ?? missing ?? busy;
  const start = (jobKind: string, fields: Record<string, unknown>) =>
    app.client.startJob(jobKind, fields).then(
      (job) => app.watchJob(Promise.resolve(job)),
      (err: unknown) => {
        const asked = fields.yes === undefined ? consentAsked(err) : null;
        if (asked) setConsent({ ...asked, kind: jobKind, fields });
        else app.watchJob(Promise.reject(err));
      },
    );
  return (
    <>
      {copy}
      <button className={aside || blameNext || leads ? 'btn' : 'btn lime'} type="button" disabled={!!why} title={why ?? aside ?? undefined} onClick={() => app.guard(() => setAsking(action.kind === 'repair' ? 'repair' : 'apply'))}>
        {action.kind === 'repair' ? ACTIONS.runRepair.label : action.label}
      </button>
      {blameNext ? (
        <FixJobButton
          kind={JOB_KINDS.blame}
          fields={blameNext.kind === 'again' ? { fixId: fix.fixId, again: true } : { fixId: fix.fixId }}
          label={blameNext.label}
          verb={blameNext.kind === 'again' ? 'blame again' : 'blame it'}
          lead={!leads}
          tip={blameNext.tip}
          command={blameNext.command}
          {...(blameNext.kind === 'stronger' ? { ask: (start: (more: Record<string, unknown>) => void, close: () => void) => <StrongerDialog fix={fix} onRun={(model) => start({ model })} onClose={close} /> } : {})}
        />
      ) : null}
      {asking === 'repair' ? <RepairDialog fix={fix} onClose={() => setAsking(null)} onRun={(repairer) => app.guard(() => void start(JOB_KINDS.repair, { fixId: fix.fixId, repairer }))} /> : null}
      {asking === 'apply' && action.kind === 'apply' ? <ApplyDialog fix={fix} label={action.label} onClose={() => setAsking(null)} onRun={() => app.guard(() => void start(JOB_KINDS.applyFix, { fixId: fix.fixId }))} /> : null}
      {consent ? (
        <ConsentDialog
          why={consent.why}
          ok={consent.kind === JOB_KINDS.repair ? ACTIONS.runRepair.label : 'Run'}
          onClose={() => setConsent(null)}
          onOk={() => {
            const c = consent;
            setConsent(null);
            app.guard(() => void start(c.kind, { ...c.fields, yes: c.confirm }));
          }}
        />
      ) : null}
    </>
  );
}

/**
 * Asks before a repair, naming who is asked for candidates: the repairer shadowlap.config.json names,
 * read again as the dialog opens (the config can change while the page stays open), and sent with
 * the job, which the server refuses if the config names another by then. One that can't be asked
 * from here (claude isn't on the PATH) is said instead, with what to do, and nothing can start.
 */
function RepairDialog({ fix, onClose, onRun }: { fix: FixDetail; onClose: () => void; onRun: (repairer: string) => void }) {
  const { client } = useApp();
  const [fresh, setFresh] = useState<{ fix: FixDetail | null } | null>(null);
  useEffect(() => {
    let live = true;
    client.fix(fix.fixId).then(
      (d) => {
        if (live) setFresh({ fix: d });
      },
      () => {
        if (live) setFresh({ fix: null });
      },
    );
    return () => {
      live = false;
    };
  }, [client, fix.fixId]);
  const ask = repairAsk(fix, fresh);
  const aside = repairAside(fresh?.fix ?? fix);
  const text = ask.who
    ? `Asks ${ask.who} for rewrites of the prompt and tool descriptions, and keeps the smallest one that fixes the failing runs without breaking the good ones. Each candidate is verified in a temporary worktree made from your working tree as it is, never in the working tree itself; the one accepted is kept as a patch for you to apply.`
    : (ask.why ?? 'Reading which repairer shadowlap.config.json names…');
  return (
    <Dialog
      title={ACTIONS.runRepair.label}
      text={text}
      ok={ACTIONS.runRepair.label}
      okDisabled={!ask.ready}
      onClose={onClose}
      onOk={() => {
        if (!ask.ready || !ask.repairer) return;
        onClose();
        onRun(ask.repairer);
      }}
    >
      {/* A repair that ends "No fix to try" runs nothing live, so it bills nothing: the dialog says why instead, whatever else it says. */}
      {aside ? <p className="fxdlg">{aside}</p> : null}
      {ask.why || aside ? null : <p className="fxdlg">The agent runs live from where each run was lost, writes stubbed: its model calls are billed. A file you change meanwhile is in the candidates made after it.</p>}
      {ask.command ? <CmdLine>{ask.command}</CmdLine> : null}
    </Dialog>
  );
}

/**
 * Run blame with stronger model asks first, for the model: it answers from each probed call instead of
 * the recorded one, live, writes stubbed, at what that model costs a call. If it finds the call, the
 * model's capability is the problem; if it doesn't either, the code and the tools are.
 */
function StrongerDialog({ fix, onRun, onClose }: { fix: FixDetail; onRun: (model: string) => void; onClose: () => void }) {
  const s = fix.actions.blameStronger;
  const base = s ? s.command.replace(/ --model <model>$/, '') : '';
  return (
    <PromptDialog
      title={confirmWords(ACTIONS.runBlameStronger.label)}
      text={
        <>
          Probes the run again, with the model you name answering from each probed call instead of the recorded one asked again. If it finds a call, the model’s capability is the problem; if it doesn’t either, look at the code and the tools.
          {s ? ` Every attempt runs live from its probe, writes stubbed, at that model’s price a call: the last blame took ${s.attempts} attempts, ${approx(s.spent)}.` : ''}
        </>
      }
      label="Model"
      placeholder="claude-opus-5-5"
      ok={confirmWords(ACTIONS.runBlameStronger.label)}
      command={(model) => `${base} --model ${model.trim() || '<model>'}`}
      onRun={(model) => model.trim() && onRun(model.trim())}
      onClose={onClose}
    />
  );
}

/** An applied fix's patch, to read: what went into the working tree, and where it is kept. */
function PatchDialog({ fix, diff, onClose }: { fix: FixDetail; diff: string; onClose: () => void }) {
  const file = fix.actions.apply?.patchFile;
  return (
    <Dialog title={<code>fix.patch</code>} text={`In your working tree since the fix was applied${file ? `: ${file}` : '.'}`} onClose={onClose}>
      <pre className="fxcode fxpatch">
        {patchLines(diff).map((l, i) => (
          <span key={i} className={l.tone ?? undefined}>
            {l.text}
            {'\n'}
          </span>
        ))}
      </pre>
    </Dialog>
  );
}

function ApplyDialog({ fix, label, onClose, onRun }: { fix: FixDetail; label: string; onClose: () => void; onRun: () => void }) {
  const apply = fix.actions.apply!;
  const run = () => {
    onClose();
    onRun();
  };
  const command = `shadowlap fix apply ${shortFixId(fix.fixId)}`;
  // No patch to apply: verified on the working tree as it is, or its patch is there already.
  if (apply.kind === 'mark' || (apply.inTree && !fix.actions.applied)) return <ConfirmDialog title="Mark this fix applied?" text={markText(apply)} ok={label} command={command} onOk={run} onClose={onClose} />;
  if (fix.actions.applied)
    return <ConfirmDialog title="Finish applying the fix?" text={`The patch is in your working tree. What is left: ${apply.pending ?? 'nothing'}.`} ok={label} command={command} onOk={run} onClose={onClose} />;
  // What goes in is what is shown: the patch itself, with every file it changes named.
  return (
    <Dialog title={`${confirmWords(ACTIONS.applyFix.label)}?`} text={applyText(apply)} ok={label} onOk={run} onClose={onClose}>
      {apply.diff ? (
        <pre className="fxcode fxpatch">
          {patchLines(apply.diff).map((l, i) => (
            <span key={i} className={l.tone ?? undefined}>
              {l.text}
              {'\n'}
            </span>
          ))}
        </pre>
      ) : null}
      <CmdLine>{command}</CmdLine>
    </Dialog>
  );
}

/**
 * The apply drawer's last word when the patch made other goldens diverge: Update goldens re-records
 * them (`shadowlap test <goldens> --update`), asking first, as the Tests screen's Update goldens does.
 */
function ApplyFooter({ job, plain }: { job: JobView; plain?: boolean }) {
  const app = useApp();
  const [asking, setAsking] = useState(false);
  const [started, setStarted] = useState(false);
  const outdated = outdatedOf(job.result);
  if (!job.done || !outdated.length || !app.hasKind(JOB_KINDS.testUpdate)) return null;
  const ask = updateOutdatedAsk(outdated);
  return (
    <>
      <button className={plain ? 'btn' : 'btn lime'} type="button" disabled={started || !!app.actionsOff} title={app.actionsOff ?? ask.command} onClick={() => app.guard(() => setAsking(true))}>
        Update goldens
      </button>
      {asking ? (
        <ConfirmDialog
          title={ask.title}
          text={ask.text}
          ok={ask.ok}
          command={ask.command}
          onClose={() => setAsking(false)}
          onOk={() => {
            setAsking(false);
            setStarted(true);
            app.guard(() => app.watchJob(app.client.startJob(JOB_KINDS.testUpdate, ask.fields)));
          }}
        />
      ) : null}
    </>
  );
}

addJobFooter(JOB_KINDS.applyFix, ApplyFooter);
