import { useState } from 'react';
import { ActionButton } from '../../components/ActionButton.js';
import { CodeBox, CopyButton } from '../../components/CodeBox.js';
import { Copy } from '../../components/Copy.js';
import { Dialog } from '../../components/Dialog.js';
import { Icon } from '../../components/Icon.js';
import { Section } from '../../components/Section.js';
import { sessionWhen } from '../../ci/words.js';
import type { CiSession, CiWorkflowOptions, CiWorkflowsView } from '../../types.js';
import { useApp } from '../../state.js';
import { TeamStoreRow } from './CiTeamStore.js';
import { useEditor, type EditUndo } from './common.js';

/**
 * Your workflow, the CI tab's first panel: where the repository's workflow stands against the one
 * the switches below build (the same, not there yet, or so many lines added and taken out), the
 * test session last seen, the file folded behind Show workflow with Copy workflow, and Write file,
 * the tab's one lime, while the two differ. The file is the server's (`GET /api/ci/workflows`): the
 * repository's with only the lines the switches own changed, each marked. Write file asks first,
 * showing every line it changes, and writes only that file, against the version read.
 */

/** `8 lines added and 1 line taken out`: each count kept whole, so a phone breaks only between them. */
function counts(added: number, removed: number): string {
  const n = (k: number, what: string) => `${k}\u00a0${k === 1 ? 'line' : 'lines'}\u00a0${what}`;
  return [added ? n(added, 'added') : '', removed ? n(removed, 'taken\u00a0out') : ''].filter(Boolean).join(' and ');
}

/** The state line: the counts bold in amber, as the design has them, or why there is nothing to write. */
function WorkflowState({ view }: { view: CiWorkflowsView }) {
  const w = view.workflow;
  if (!view.exists) {
    return (
      <Copy className="wfstate">
        <b>Not in your repository yet.</b> Write it, then commit it.
      </Copy>
    );
  }
  if (w.same) {
    return (
      <Copy className="wfstate">
        The same as your repository’s <code>{view.file}</code>.
      </Copy>
    );
  }
  return (
    <Copy className="wfstate">
      <b>{counts(w.added, w.removed)}</b> against your repository’s file. Write it, then commit it.
    </Copy>
  );
}

/**
 * `The last test session, d2e8a1f at 10:02: 2 of 7 goldens passed · 3 failed, 2 inconclusive.`; with
 * CI's own, `Last seen in CI, …`; a session with no revision says so, as Tests' line does: `no revision, just now`.
 */
export function sessionLine(s: CiSession, now = Date.now()): string {
  return `${s.ci ? 'Last seen in CI' : 'The last test session'}, ${sessionWhen(s.revision, s.at, now)}: ${s.text}.`;
}

export function YourWorkflow({ view, changed, onWritten, reload }: { view: CiWorkflowsView; changed: Partial<CiWorkflowOptions>; onWritten: () => void; reload: () => void }) {
  const w = view.workflow;
  const { client } = useApp();
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const editor = useEditor(view.version, reload);
  return (
    <Section
      className="set cip wfpanel"
      id="workflow"
      title="Your workflow"
      sub="built from the switches below"
      actions={
        w.same ? null : (
          <ActionButton className="btn lime sm" why={view.problem ?? (editor.busy ? 'Writing the workflow…' : null)} tip="Write file" sub={`Asks first: ${view.exists ? 'changes' : 'adds'} ${view.file} in your repository; nothing runs until you push it`} onClick={() => setAsking(true)}>
            Write file
          </ActionButton>
        )
      }
    >
      <div className="pbody">
        <WorkflowState view={view} />
        {w.session ? <Copy className="muted">{sessionLine(w.session)}</Copy> : null}
        {/* Why Write file waits, said where the file is: Copy workflow still has the whole file. */}
        {view.problem && !w.same ? <p className="fieldnote">{view.problem}</p> : null}
        <p className="wftog">
          <button className="linkbtn" type="button" aria-expanded={open} aria-controls="wfBox" onClick={() => setOpen(!open)}>
            {open ? 'Hide' : 'Show'} workflow
            <Icon name="caret" />
          </button>
          <CopyButton text={w.text} label="the workflow">
            Copy workflow
          </CopyButton>
        </p>
        {view.fixOnFailure.teamStore ? <TeamStoreRow store={view.fixOnFailure.teamStore} /> : null}
      </div>
      <div className="pbody cicode" id="wfBox" hidden={!open}>
        <CodeBox file={view.file} lines={w.lines} />
      </div>
      {asking ? (
        <WriteFile
          view={view}
          onClose={() => setAsking(false)}
          onWrite={() => {
            setAsking(false);
            void editor.run(
              () => client.settings.writeWorkflow(changed, view.version, w.shown),
              (r) => {
                onWritten();
                return r.changed ? `Wrote ${r.path} · commit and push it to turn it on` : `${r.path} is already the workflow the switches build`;
              },
              (r): EditUndo | null => {
                const was = r.was;
                return was ? { edit: () => client.settings.undoWorkflow(was), ok: view.exists ? `Put ${r.path} back as it was` : `Removed ${r.path}, which Write file made` } : null;
              },
            );
          }}
        />
      ) : null}
    </Section>
  );
}

/** Write file's ask: the file it writes as its title, where the change goes, and every line it changes. */
function WriteFile({ view, onClose, onWrite }: { view: CiWorkflowsView; onClose: () => void; onWrite: () => void }) {
  return (
    <Dialog
      title={`Write ${view.file}?`}
      lead={view.exists ? 'Changes the workflow in your repository to match the switches.' : 'Adds the workflow the switches build to your repository.'}
      doc="githubActions"
      facts={[{ label: 'Changes', value: 'your working tree', quiet: 'CI runs it once you commit and push it' }]}
      ok="Write file"
      onOk={onWrite}
      onClose={onClose}
    >
      <CodeBox lines={view.workflow.lines} />
    </Dialog>
  );
}
