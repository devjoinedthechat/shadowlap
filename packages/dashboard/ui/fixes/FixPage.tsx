import { useEffect, useState } from 'react';
import { JOB_KINDS, ApiError } from '../api.js';
import { Badge } from '../components/bits.js';
import { CmdLine } from '../components/bits.js';
import { ConfirmDialog, Dialog, PromptDialog } from '../components/Dialog.js';
import { Page } from '../components/Page.js';
import { copyText } from '../dom.js';
import { useLoad } from '../hooks.js';
import { href } from '../route.js';
import { useApp } from '../state.js';
import type { FixDetail } from '../types.js';
import { BlameStepView } from './BlameStep.js';
import { rememberFix } from './data.js';
import { fixAction, fixName, fixStamp, laterStamp, shortFixId, statusBadge, stepFor } from './model.js';
import { RepairStepView } from './RepairStep.js';
import { VerifyStepView } from './VerifyStep.js';

/**
 * A fix (#/fixes/<id>[/<step>[/<sub>]]): its title, check and runs; the stepper (Blame, Repair,
 * Verify), opened on the step its URL names or its last finished one; and what can be done next:
 * Repair from here on an open fix, Apply the patch on a verified one.
 */
export function FixPage({ id, step, sub }: { id: string; step: string | null; sub: string | null }) {
  const { client, tick } = useApp();
  const loaded = useLoad(() => client.fix(id), `fix:${id}`, tick);
  const fix = loaded.data;
  useEffect(() => {
    if (fix) rememberFix(fix, id);
  }, [fix, id]);
  if (!fix) {
    const missing = loaded.error instanceof ApiError && loaded.error.status === 404;
    return (
      <Page>
        <div className="empty tall">
          {loaded.error ? (missing ? `No fix ${id}. ` : `Could not load the fix: ${loaded.error.message}. `) : 'Loading the fix…'}
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
              (err: unknown) => app.toast(err instanceof Error ? err.message : String(err)),
            );
          }}
        />
      ) : null}
    </div>
  );
}

/** Repair from here, or Copy git apply and Apply the patch, each asking first. */
export function FixActions({ fix }: { fix: FixDetail }) {
  const app = useApp();
  const [asking, setAsking] = useState<'repair' | 'apply' | null>(null);
  if (app.exported) return null;
  const action = fixAction(fix);
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
  if (action.kind === 'none') return null;
  if (action.kind === 'applied')
    return (
      <>
        {copy}
        <button className="btn" type="button" disabled title="The patch is in the working tree and its goldens pass">
          Patch applied
        </button>
      </>
    );
  const kind = action.kind === 'repair' ? JOB_KINDS.repair : JOB_KINDS.applyFix;
  const missing = app.hasKind(kind) ? null : `This dashboard doesn’t run ${action.kind === 'repair' ? 'repair' : 'fix apply'}: run it in a terminal.`;
  const why = off ?? missing;
  return (
    <>
      {copy}
      <button className="btn lime" type="button" disabled={!!why} title={why ?? undefined} onClick={() => app.guard(() => setAsking(action.kind === 'repair' ? 'repair' : 'apply'))}>
        {action.kind === 'repair' ? 'Repair from here' : action.label}
      </button>
      {asking === 'repair' ? <RepairDialog fix={fix} onClose={() => setAsking(null)} /> : null}
      {asking === 'apply' && action.kind === 'apply' ? <ApplyDialog fix={fix} label={action.label} onClose={() => setAsking(null)} /> : null}
    </>
  );
}

function RepairDialog({ fix, onClose }: { fix: FixDetail; onClose: () => void }) {
  const app = useApp();
  const who = fix.repairer.configured ? `${fix.repairer.name}, the repairer shadowlap.config.json names` : 'your own Claude Code (claude-code), unless shadowlap.config.json names another repairer';
  return (
    <Dialog
      title="Repair from here"
      text={
        <>
          Repair asks {who} for rewrites of the prompt and tool descriptions, and keeps the smallest one that fixes the failing runs without breaking the good ones. Each candidate is tried in your working tree and put back, so leave those files alone until it is done; an accepted one is kept as a patch, for you to apply.
        </>
      }
      ok="Repair"
      onClose={onClose}
      onOk={() => {
        onClose();
        app.guard(() => app.watchJob(app.client.startJob(JOB_KINDS.repair, { fixId: fix.fixId })));
      }}
    >
      <p className="fxdlg">The agent runs live from where each run was lost, with writes stubbed: its model calls are billed.</p>
      {fix.actions.repair ? <CmdLine>{fix.actions.repair.command}</CmdLine> : null}
    </Dialog>
  );
}

function ApplyDialog({ fix, label, onClose }: { fix: FixDetail; label: string; onClose: () => void }) {
  const app = useApp();
  const apply = fix.actions.apply!;
  const file = fix.repair?.change?.file ?? null;
  const run = () => {
    onClose();
    app.guard(() => app.watchJob(app.client.startJob(JOB_KINDS.applyFix, { fixId: fix.fixId })));
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
  return (
    <Dialog title="Apply the patch?" text={`This changes your working tree: git apply writes the fix into ${file ?? 'your files'}, the recordings the fixed code made are copied into goldens/, and shadowlap test replays them. Review the change before you commit it.`} ok={label} onOk={run} onClose={onClose}>
      {apply.gitApply ? <CmdLine>{apply.gitApply}</CmdLine> : null}
      <CmdLine>{command}</CmdLine>
    </Dialog>
  );
}
