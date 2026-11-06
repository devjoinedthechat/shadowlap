import { useEffect, useRef, useState } from 'react';
import { probesPart } from '../../../engine/src/cost-words.js';
import { consentAsked } from '../actions.js';
import { JOB_KINDS, ApiError, type JobView } from '../api.js';
import { Badge } from '../components/bits.js';
import { ConsentDialog, Dialog, PromptDialog } from '../components/Dialog.js';
import { DialogSteps, DialogTip } from '../components/DialogFacts.js';
import { UpdateGoldenDialog } from '../components/UpdateGolden.js';
import { headingRef } from '../focus-manager.js';
import { Page } from '../components/Page.js';
import { NotFoundPage } from '../pages/NotFound.js';
import { Elsewhere } from '../pages/held-elsewhere.js';
import { APPLY_ASK } from '../page-ask.js';
import { Unshown } from '../shell/unshown.js';
import { copyText } from '../dom.js';
import { approx, GLUED_SEPARATOR } from '../format.js';
import { useLoad } from '../hooks.js';
import { addJobFooter } from '../job-actions.js';
import { href } from '../route.js';
import { guardedWayOn, useApp } from '../state.js';
import { errorText } from '../toast.js';
import type { FixDetail } from '../types.js';
import { copiedTo, GoldenNameFields, nameFields, nameFlags, useGoldenNames } from './ApplyNames.js';
import { BlameStepView } from './BlameStep.js';
import { rememberFix } from './data.js';
import { applySteps, keepsOf, markLead, PULLED_LINE, repairCost, updateOutdatedAsk } from './dialog-words.js';
import { FixJobButton } from './FixJobButton.js';
import { appliedButton, blameNextStep, fixAction, fixName, fixStamp, laterStamp, outdatedOf, patchLines, repairAsk, repairAside, shortFixId, statusBadge, stepFor, stepLeads } from './model.js';
import { FailedMust, Flagged } from './parts.js';
import { RepairStepView } from './RepairStep.js';
import { useTreeBusy } from './tree.js';
import { VerifyStepView } from './VerifyStep.js';
import { ACTIONS, confirmWords, STRONGER_MODEL } from '../labels.js';
import { ActionButton } from '../components/ActionButton.js';

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
        <h1 ref={headingRef}>{fix.title}</h1>
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
        <FixActions fix={fix} leads={leads} />
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
  const off = app.actionsOff;
  const kind = action.kind === 'repair' ? JOB_KINDS.repair : JOB_KINDS.applyFix;
  const missing = app.hasKind(kind) ? null : `This dashboard doesn’t run ${action.kind === 'repair' ? 'repair' : 'fix apply'}: run it in a terminal.`;
  const why = off ?? missing ?? busy;
  // Asked from the palette's Apply fix, on this page already or arriving on it: its dialog opens as
  // a press of the button would, or a toast says why it can't.
  const asked = useRef(() => {});
  asked.current = () => {
    const cant = action.kind === 'apply' ? why : action.kind === 'none' ? (off ?? action.why) : null;
    if (cant) app.toast(cant);
    else if (action.kind === 'apply') setAsking('apply');
  };
  useEffect(() => {
    const open = () => asked.current();
    if (APPLY_ASK.take(fix.fixId)) open();
    return APPLY_ASK.on(open, fix.fixId);
  }, [fix.fixId]);
  if (app.exported) return null;
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
        Show patch
      </button>
      {asking === 'patch' ? <PatchDialog fix={fix} diff={diff} onClose={() => setAsking(null)} /> : null}
    </>
  ) : null;
  if (action.kind === 'none')
    return (
      <>
        {copy}
        <ActionButton className="btn lime" why={off ?? action.why}>
          {action.label}
        </ActionButton>
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
  const aside = action.kind === 'repair' ? repairAside(fix) : null;
  const blameNext = action.kind === 'repair' ? blameNextStep(fix) : null;
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
      <ActionButton className={aside || blameNext || leads ? 'btn' : 'btn lime'} why={why} title={aside ?? undefined} onClick={() => app.guard(() => setAsking(action.kind === 'repair' ? 'repair' : 'apply'))}>
        {action.kind === 'repair' ? ACTIONS.runRepair.label : action.label}
      </ActionButton>
      {blameNext ? (
        <FixJobButton
          kind={JOB_KINDS.blame}
          fields={blameNext.kind === 'again' ? { fixId: fix.fixId, again: true } : { fixId: fix.fixId }}
          label={blameNext.label}
          verb={blameNext.kind === 'again' ? 'blame again' : 'blame it'}
          lead={!leads}
          tip={blameNext.tip}
          command={blameNext.command}
          {...(blameNext.kind === 'stronger' ? { ask: (start: (more: Record<string, unknown>) => boolean, close: () => void) => <StrongerDialog fix={fix} onRun={(model) => start({ model })} onClose={close} /> } : {})}
        />
      ) : null}
      {asking === 'repair' ? <RepairDialog fix={fix} onClose={() => setAsking(null)} onRun={(repairer) => app.guard(() => void start(JOB_KINDS.repair, { fixId: fix.fixId, repairer }))} /> : null}
      {asking === 'apply' && action.kind === 'apply' ? <ApplyDialog fix={fix} label={action.label} onClose={() => setAsking(null)} onRun={(names) => app.guard(() => void start(JOB_KINDS.applyFix, { fixId: fix.fixId, ...(names ? { names } : {}) }))} /> : null}
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
 * Asks before a repair, naming who is asked for candidates: the repairer shadowlap.config.json names,
 * read again as the dialog opens (the config can change while the page stays open), and sent with
 * the job, which the server refuses if the config names another by then. One that can't be asked
 * from here (claude isn't on the PATH) is said instead, with what to do, and nothing can start.
 */
export function RepairDialog({ fix, onClose, onRun }: { fix: FixDetail; onClose: () => void; onRun: (repairer: string) => boolean }) {
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
  const now = fresh?.fix ?? fix;
  const aside = repairAside(now);
  const repair = now.actions.repair;
  const stopped = now.actions.blameAgain?.kind === 'stopped';
  const keeps = repair ? keepsOf(repair.argv) : [];
  // A line is one sentence with no stop; the engine's own sentence keeps it where the terminal UI shows it.
  const line = ask.why?.replace(/\.$/, '') ?? aside ?? (stopped ? 'Blame stopped part way: repair blames the run again first' : null);
  // While it reads, what it is doing; then who it asks, or "the repairer" where it can't ask one from here.
  const lead = fresh ? `Asks ${ask.who ?? 'the repairer'} for prompt and tool rewrites and picks the smallest that fixes the failing runs.` : 'Reading which repairer shadowlap.config.json names…';
  return (
    <Dialog
      title={ACTIONS.runRepair.label}
      lead={lead}
      {...(fresh ? { doc: 'repair' as const } : {})}
      warn={line ? { text: line } : null}
      // A repair that ends "No fix to try" runs nothing, so none of what a repair does is said.
      facts={
        ask.why || aside
          ? []
          : [
              { label: 'Changes', value: 'nothing in your working tree', quiet: 'each candidate is tried in a worktree of its own' },
              { label: 'Hands over', value: 'the accepted one, as a patch for you to apply' },
              keeps.length ? { label: <DialogTip title="Keeps" tip="A candidate that breaks a good run is rejected">Keeps</DialogTip>, value: `${keeps.map((k) => `\`${k}\``).join(', ')} passing` } : null,
              { label: 'While it runs', value: 'leave the prompt and tools alone' },
            ]
      }
      command={ask.command}
      cost={repair && (!ask.why || repair.noFixWhy) ? repairCost(repair, stopped) : null}
      ok={ACTIONS.runRepair.label}
      okDisabled={!ask.ready}
      onClose={onClose}
      onOk={() => (ask.ready && ask.repairer ? onRun(ask.repairer) : false)}
    />
  );
}

/**
 * Run blame with stronger model asks first, for the model: it answers from each probed call instead of
 * the recorded one, live, writes stubbed, at what that model costs a call. How to read what it finds
 * is the drawer's and the docs'.
 */
export function StrongerDialog({ fix, onRun, onClose }: { fix: FixDetail; onRun: (model: string) => boolean; onClose: () => void }) {
  const s = fix.actions.blameStronger;
  const base = s ? s.command.replace(/ --model <model>$/, '') : '';
  return (
    <PromptDialog
      title={confirmWords(ACTIONS.runBlameStronger.label)}
      lead="Probes the run again with the model you name answering from each probed call."
      doc="blame"
      label="Model"
      placeholder={STRONGER_MODEL}
      ok={confirmWords(ACTIONS.runBlameStronger.label)}
      command={(model) => `${base} --model ${model.trim() || '<model>'}`}
      cost={{ price: 'Billed by your provider', parts: [...(s ? [`the last blame took ${s.attempts} attempts, ${approx(s.spent)}`] : []), probesPart()] }}
      onRun={(model) => (model.trim() ? onRun(model.trim()) : false)}
      onClose={onClose}
    />
  );
}

/** An applied fix's patch, to read: what went into the working tree, and where it is kept. */
export function PatchDialog({ fix, diff, onClose }: { fix: FixDetail; diff: string; onClose: () => void }) {
  const file = fix.actions.apply?.patchFile;
  return (
    <Dialog title="Show patch" lead="The fix as repair handed it over, in your working tree since you applied it." doc="repairHandover" facts={file ? [{ label: 'Path', value: <code>{file}</code>, wide: true }] : []} onClose={onClose}>
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

/**
 * Asks before applying: Apply fix with the patch and every file it changes, Mark fix applied for a
 * patch in the working tree already (or none to apply), Finish applying fix for what an apply left
 * undone. Each that copies goldens asks each its name under the rest (ApplyNames.tsx), and sends
 * them with the job; it waits until each will do.
 */
export function ApplyDialog({ fix, label, onClose, onRun }: { fix: FixDetail; label: string; onClose: () => void; onRun: (names: Record<string, string> | null) => boolean }) {
  const apply = fix.actions.apply!;
  const names = useGoldenNames(apply);
  const asks = { command: `shadowlap fix apply ${shortFixId(fix.fixId)}${nameFlags(names)}`, ok: label, okDisabled: !!names.problem, onOk: () => onRun(nameFields(names)), onClose, doc: 'repairHandover' as const };
  const fields = <GoldenNameFields names={names} />;
  // No patch to apply: verified on the working tree as it is, or its patch is there already.
  if (apply.kind === 'mark' || (apply.inTree && !fix.actions.applied))
    return (
      <Dialog {...asks} title={apply.inTree && apply.goldens ? 'Mark fix applied?' : 'Mark fix applied'} lead={markLead(apply)} facts={apply.pulled ? [{ label: 'Recordings', value: 'stay on the machine that ran the repair' }] : []}>
        {fields}
      </Dialog>
    );
  if (fix.actions.applied)
    return (
      <Dialog {...asks} title="Finish applying fix?" lead="Finishes what applying the fix left undone." facts={[{ label: 'Left', value: apply.pending ?? 'nothing' }]}>
        {fields}
      </Dialog>
    );
  // What goes in is what is shown: the patch itself, with every file it changes named.
  return (
    <Dialog {...asks} title={`${confirmWords(ACTIONS.applyFix.label)}?`} lead="Applies the fix to your working tree, for you to review before you commit." warn={apply.pulled ? { text: PULLED_LINE } : null}>
      {/* What the fields name, once the goldens folder was read; else every recording, as far as the page knows. */}
      <DialogSteps steps={applySteps(apply, { count: apply.held ? names.offered.length : apply.goldens, to: copiedTo(names) })} />
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
      {fields}
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
      <ActionButton className={plain ? 'btn' : 'btn lime'} disabled={started} title={ask.command} onClick={() => app.guard(() => setAsking(true))}>
        Update goldens
      </ActionButton>
      {asking ? (
        <UpdateGoldenDialog
          plan={ask}
          onClose={() => setAsking(false)}
          onUpdate={() => {
            const went = app.guard(() => app.watchJob(app.client.startJob(JOB_KINDS.testUpdate, ask.fields)));
            if (went) setStarted(true);
            return went;
          }}
        />
      ) : null}
    </>
  );
}

addJobFooter(JOB_KINDS.applyFix, ApplyFooter);
