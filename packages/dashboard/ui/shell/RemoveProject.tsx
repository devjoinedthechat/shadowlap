import { useEffect, useRef, useState } from 'react';
import { Dialog } from '../components/Dialog.js';
import { messageOf } from '../message-of.js';
import { expectProject, type RemoveDialogView } from '../projects-api.js';
import { nameMatches } from '../projects.js';
import { href } from '../route.js';
import { navigate } from '../router.js';
import { useApp } from '../state.js';
import { errorText } from '../toast.js';

/**
 * Remove a project, from the switcher's × or Settings → Project (`<RemoveProjectDialog id=… />`).
 * Removing only forgets the folder, so the button is a calm solid one: adding the folder again
 * brings everything back. Deleting its recordings sits in a zone of its own, shown only when it has
 * runs; ticking it crosses the store out, turns the button red, and keeps it disabled until the
 * project's name is typed. Goldens in the repository are never touched.
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

  if (failed) return <Dialog title="Remove from the dashboard" text={failed} onClose={onClose} />;
  if (!view) return null;

  const zone = view.deleteZone;
  const deleting = del && !!zone;
  const mode = deleting ? zone.mode : view.keep;
  const match = !!zone && nameMatches(typed, zone.name);
  const blocked = actionsOff ?? (view.canRemove ? null : view.why);

  const remove = () => {
    if (deleting && !match) {
      setTried(true);
      nameInput.current?.focus();
      return;
    }
    guard(() => {
      setBusy(true);
      client.projects.remove(id, { deleteRecordings: deleting, name: typed }).then(
        async (out) => {
          toast(out.message);
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
  };

  return (
    <Dialog
      title={view.title}
      text={mode.text}
      ok={mode.button.label}
      tone={mode.button.style}
      okDisabled={busy || !!blocked || (deleting && !match)}
      onOk={remove}
      onClose={onClose}
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
        <p className="rmnote">{mode.note}</p>
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
                    if (match && !blocked && !busy) remove();
                    else setTried(true);
                  }
                }}
              />
            </label>
          ) : null}
        </div>
      ) : null}
      {blocked && !actionsOff ? <p className="fieldnote">{blocked}</p> : null}
    </Dialog>
  );
}
