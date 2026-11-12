import { useEffect, useRef, useState } from 'react';
import { Dialog, pressWayOn } from '../components/Dialog.js';
import { messageOf } from '../../../engine/src/message-of.js';
import { expectProject, type RemoveDialogView } from '../projects-api.js';
import { projectsChanged } from '../project-actions.js';
import { nameMatches } from '../projects.js';
import { href } from '../route.js';
import { navigate } from '../router.js';
import { useApp, type AppState } from '../state.js';
import { errorText, type ToastAction } from '../toast.js';
import { flush } from '../pending-delete.js';

/**
 * A removal's Undo, on its toast: the project back at the place it left, the current project and
 * the page as they are. The switcher reads its list again, for the project back and for Settings →
 * Project's Remove project…, which a list of one turns off; the focus goes back to its button.
 */
function undoRemoval(app: AppState, id: string): ToastAction {
  const run = () =>
    app.client.projects.restore(id).then(
      async (back) => {
        app.toast(back.message);
        await app.reload();
        projectsChanged();
      },
      (err: unknown) => app.toast(errorText(err), 'error'),
    );
  return { label: 'Undo', undo: true, returnTo: document.querySelector<HTMLElement>('button.proj'), run: () => void app.guard(() => void run()) };
}

/**
 * Remove a project, from the switcher's × or Settings → Project (`<RemoveProjectDialog id=… />`).
 * Removing only forgets the folder, so the button reads in ink: adding the folder again brings
 * everything back. Deleting its recordings sits in a zone of its own, shown only when it has runs;
 * ticking it crosses the store out, turns the button red, and keeps it disabled until the project's
 * name is typed. Goldens in the repository are never touched.
 */
export function RemoveProjectDialog({ id, onClose, onRemoved }: { id: string; onClose: () => void; onRemoved?: (current: string) => void }) {
  const app = useApp();
  const { client, toast, guard, actionsOff } = app;
  const [view, setView] = useState<RemoveDialogView | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [del, setDel] = useState(false);
  const [typed, setTyped] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    client.projects.removal(id).then(
      (v) => alive && setView(v),
      (err: unknown) => alive && setFailed(messageOf(err)),
    );
    return () => {
      alive = false;
    };
  }, [client, id]);

  useEffect(() => {
    if (del) nameInput.current?.focus();
  }, [del]);

  if (failed) return <Dialog title="Remove project" lead="Takes the project off the dashboard; nothing on disk changes." doc="removingProject" warn={{ text: failed.replace(/\.$/, '') }} onClose={onClose} />;
  if (!view) return null;

  const zone = view.deleteZone;
  const deleting = del && !!zone;
  const mode = deleting ? zone.mode : view.keep;
  const match = !!zone && nameMatches(typed, zone.name);
  const blocked = actionsOff ?? (view.canRemove ? null : view.why);

  // It closes itself once the server has removed it, and stays open on a refusal.
  const remove = () => {
    if (deleting && !match) {
      setTried(true);
      nameInput.current?.focus();
      return false;
    }
    guard(() => {
      setBusy(true);
      // A delete waiting out its toast goes to this project's store first: removing it switches to another.
      void flush().then(() => client.projects.remove(id, { deleteRecordings: deleting, name: typed })).then(
        async (out) => {
          toast(out.message, 'notice', out.undo ? undoRemoval(app, id) : undefined);
          onRemoved?.(out.current);
          onClose();
          expectProject(out.current);
          await app.reload();
          navigate(href.overview());
        },
        (err: unknown) => {
          setBusy(false);
          toast(errorText(err), 'error');
        },
      );
    });
    return false;
  };

  return (
    <Dialog
      title={view.title}
      lead={mode.text}
      doc="removingProject"
      warn={blocked && !actionsOff ? { text: blocked } : null}
      ok={mode.button.label}
      tone={mode.button.style}
      okDisabled={busy || !!blocked || (deleting && !match)}
      onOk={remove}
      onClose={onClose}
      // A second Enter never removes it: from the switcher, Delete and Enter would.
      initialFocus="cancel"
      className="rmdlg"
    >
      <div className="rmp">
        <span className="pa">{view.project.initial}</span>
        <span className="pn">
          <b>{view.project.name}</b>
          <small>{view.project.path}</small>
        </span>
        <span className="rs">{view.project.summary}</span>
      </div>
      <div className="ondisk">
        <span className="k">On disk</span>
        <ul>
          {view.onDisk.map((row) => {
            const gone = mode.crossedOut === row.key;
            return (
              <li key={row.key} data-k={row.key} className={gone ? 'gone' : undefined}>
                <i aria-hidden="true">{gone ? '✕' : '✓'}</i>
                <span>{row.label}</span>
                <code title={row.path}>{row.path}</code>
              </li>
            );
          })}
        </ul>
        {mode.note ? <p className="rmnote">{mode.note}</p> : null}
      </div>
      {zone ? (
        <div className={`dz${deleting ? ' on' : ''}`}>
          <label className="check">
            <input type="checkbox" checked={del} onChange={(e) => setDel(e.target.checked)} />
            <span>
              <b>{zone.label}</b>
              <small>{zone.detail}</small>
            </span>
          </label>
          {deleting ? (
            <label className={`confirm${tried && !match ? ' bad' : ''}`}>
              <span>
                Type <code>{zone.name}</code> to confirm. This can’t be undone.
              </span>
              <input
                ref={nameInput}
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder={zone.placeholder}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    if (match && !blocked && !busy) pressWayOn(e.currentTarget);
                    else setTried(true);
                  }
                }}
              />
            </label>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}
