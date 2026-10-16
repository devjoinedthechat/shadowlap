import { useEffect, useState } from 'react';
import { JOB_KINDS, ApiError } from '../api.js';
import { Badge, CmdLine } from '../components/bits.js';
import { ConfirmDialog, Dialog, PromptDialog } from '../components/Dialog.js';
import { Page } from '../components/Page.js';
import { NotFoundPage } from '../pages/NotFound.js';
import { copyText } from '../dom.js';
import { useLoad } from '../hooks.js';
import { href } from '../route.js';
import { useApp } from '../state.js';
import { errorText } from '../toast.js';
import type { FixDetail } from '../types.js';
import { BlameStepView } from './BlameStep.js';
import { rememberFix } from './data.js';
import { fixAction, fixName, fixStamp, laterStamp, repairAsk, shortFixId, statusBadge, stepFor } from './model.js';
import { RepairStepView } from './RepairStep.js';
import { useTreeBusy } from './tree.js';
import { VerifyStepView } from './VerifyStep.js';

/**
 * A fix (#/fixes/<id>[/<step>[/<sub>]]): its title, check and runs; the stepper (Blame, Repair,
 * Verify), opened on the step its URL names or its last finished one; and what can be done next:
 * Repair from here on an open fix, Apply the patch on a verified one.
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
      <FixHeader fix={fix} reload={loaded.reload} />
      <nav className="stepper" aria-label="Steps">
        {fix.steps.map((x) => (
          <a key={x.key} className={x.state} href={href.fixes(fix.fixId, x.key)} aria-current={x.key === current ? 'step' : undefined}>
            <span className="k">
              <i />
              {x.n} · {x.key}
            </span>
            <b>{x.title}</b>
            <span className="m">{x.meta}</span>
          </a>
        ))}
      </nav>
      {current === 'repair' ? <RepairStepView fix={fix} /> : current === 'verify' ? <VerifyStepView fix={fix} sub={sub} /> : <BlameStepView fix={fix} />}
    </Page>
  );
}

function FixHeader({ fix, reload }: { fix: FixDetail; reload: () => void }) {
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
          <Badge tone={badge.tone}>{badge.text}</Badge> <span>{`${fix.failing} failing run${s(fix.failing)}`}</span> · <span>{`${fix.good} good`}</span> · <span>opened {fixStamp(fix.openedAt)}</span>
          {fix.verifiedAt ? (
            <>
              {' · '}
              <span>verified {laterStamp(fix.verifiedAt, fix.openedAt)}</span>
            </>
          ) : null}
          {fix.appliedAt ? (
            <>
              {' · '}
              <span>applied {laterStamp(fix.appliedAt, fix.verifiedAt ?? fix.openedAt)}</span>
            </>
          ) : null}
          {fix.source ? (
            <>
              {' · '}
              <span className="fxsource">{fix.source}</span>
            </>
          ) : null}
          {app.exported ? null : (
            <button className="linkbtn fxrename" type="button" disabled={!!app.actionsOff} title={app.actionsOff ?? 'Give this fix a title of your own'} onClick={() => app.guard(() => setRenaming(true))}>
              Rename
            </button>
          )}
        </p>
        <p className="chk">
          <span className="k">check</span>
          <code>{fix.check}</code>
        </p>
        {fix.broken ? <p className="fxbad">This fix doesn’t hold: {fix.broken}.</p> : null}
      </div>
      <div className="actions">
        <FixActions fix={fix} />
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
 * Repair from here, or Copy git apply and Apply the patch, each asking first. Disabled, with the
 * reason, where nothing runs, while another job uses the working tree, or when there is nothing to
 * do. A repair whose runs came from someone else's pack asks once more before it runs their command.
 */
export function FixActions({ fix }: { fix: FixDetail }) {
  const app = useApp();
  const action = fixAction(fix);
  // A repair or an apply changes the working tree: it waits for every job running the agent from it.
  const busy = useTreeBusy('writes', fix.status === 'open' ? 'repair' : 'apply the patch');
  const [asking, setAsking] = useState<'repair' | 'apply' | null>(null);
  const [consent, setConsent] = useState<{ why: string; kind: string; fields: Record<string, unknown> } | null>(null);
  if (app.exported) return null;
  const off = app.actionsOff;
  const gitApply = fix.actions.apply?.gitApply ?? null;
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
  if (action.kind === 'applied')
    return (
      <>
        {copy}
        <button className="btn" type="button" disabled title={fix.actions.apply?.pulled ? 'The patch is in the working tree; its goldens are on the machine that ran the repair' : 'The patch is in the working tree and its goldens pass'}>
          Patch applied
        </button>
      </>
    );
  const kind = action.kind === 'repair' ? JOB_KINDS.repair : JOB_KINDS.applyFix;
  const missing = app.hasKind(kind) ? null : `This dashboard doesn’t run ${action.kind === 'repair' ? 'repair' : 'fix apply'}: run it in a terminal.`;
  const why = off ?? missing ?? busy;
  const start = (jobKind: string, fields: Record<string, unknown>) =>
    app.client.startJob(jobKind, fields).then(
      (job) => app.watchJob(Promise.resolve(job)),
      (err: unknown) => {
        if (err instanceof ApiError && err.status === 409 && /imported pack/.test(err.message)) setConsent({ why: err.message, kind: jobKind, fields });
        else app.watchJob(Promise.reject(err));
      },
    );
  return (
    <>
      {copy}
      <button className="btn lime" type="button" disabled={!!why} title={why ?? undefined} onClick={() => app.guard(() => setAsking(action.kind === 'repair' ? 'repair' : 'apply'))}>
        {action.kind === 'repair' ? 'Repair from here' : action.label}
      </button>
      {asking === 'repair' ? <RepairDialog fix={fix} onClose={() => setAsking(null)} onRun={(repairer) => app.guard(() => void start(JOB_KINDS.repair, { fixId: fix.fixId, repairer }))} /> : null}
      {asking === 'apply' && action.kind === 'apply' ? <ApplyDialog fix={fix} label={action.label} onClose={() => setAsking(null)} onRun={() => app.guard(() => void start(JOB_KINDS.applyFix, { fixId: fix.fixId }))} /> : null}
      {consent ? (
        <ConfirmDialog
          title="Run a command from an imported pack?"
          text={`${consent.why}.`}
          ok={consent.kind === JOB_KINDS.repair ? 'Repair' : 'Run'}
          onClose={() => setConsent(null)}
          onOk={() => {
            const c = consent;
            setConsent(null);
            app.guard(() => void start(c.kind, { ...c.fields, yes: true }));
          }}
        />
      ) : null}
    </>
  );
}

/**
 * Asks before a repair, naming who is asked for candidates: the repairer shadowlap.config.json names,
 * read again as the dialog opens (the config can change while the page stays open), and sent with
 * the job, which the server refuses if the config names another by then.
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
  const text = ask.who
    ? `Asks ${ask.who} for rewrites of the prompt and tool descriptions, and keeps the smallest one that fixes the failing runs without breaking the good ones. Each candidate is tried in your working tree and put back; the one accepted is kept as a patch for you to apply.`
    : (ask.why ?? 'Reading which repairer shadowlap.config.json names…');
  return (
    <Dialog
      title="Repair from here"
      text={text}
      ok="Repair"
      okDisabled={!ask.ready}
      onClose={onClose}
      onOk={() => {
        if (!ask.ready || !ask.repairer) return;
        onClose();
        onRun(ask.repairer);
      }}
    >
      <p className="fxdlg">The agent runs live from where each run was lost, writes stubbed: its model calls are billed. Leave those files alone until it is done.</p>
      {ask.command ? <CmdLine>{ask.command}</CmdLine> : null}
    </Dialog>
  );
}

function ApplyDialog({ fix, label, onClose, onRun }: { fix: FixDetail; label: string; onClose: () => void; onRun: () => void }) {
  const apply = fix.actions.apply!;
  const file = fix.repair?.change?.file ?? null;
  const run = () => {
    onClose();
    onRun();
  };
  const command = `shadowlap fix apply ${shortFixId(fix.fixId)}`;
  if (apply.kind === 'mark')
    return (
      <ConfirmDialog
        title="Mark this fix applied?"
        text="It was verified on your working tree as it is, so there is no patch to apply: this marks it applied."
        ok={label}
        command={command}
        onOk={run}
        onClose={onClose}
      />
    );
  if (fix.actions.applied)
    return <ConfirmDialog title="Finish applying the fix?" text={`The patch is in your working tree. What is left: ${apply.pending ?? 'nothing'}.`} ok={label} command={command} onOk={run} onClose={onClose} />;
  // A teammate's repair, from the team store: its recordings are on the machine that ran it.
  const text = apply.pulled
    ? `This changes your working tree: the patch goes into ${file ?? 'your files'} with git apply. The recordings the fixed code made stay on the machine that ran the repair, so nothing is copied or replayed here. Review the change before you commit it.`
    : `This changes your working tree: the patch goes into ${file ?? 'your files'} with git apply, the recordings the fixed code made are copied into goldens/, and shadowlap test replays them. Review the change before you commit it.`;
  return (
    <Dialog title="Apply the patch?" text={text} ok={label} onOk={run} onClose={onClose}>
      <CmdLine>{command}</CmdLine>
    </Dialog>
  );
}
