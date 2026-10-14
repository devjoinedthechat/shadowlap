import { useEffect, useRef, useState } from 'react';
import type { Action, Client, JobView } from '../api.js';
import { shortId } from '../format.js';
import { href, navigate } from '../router.js';
import { Dialog } from './common.js';

/** A menu of CLI actions for the run (and the selected call). */
export function ActionsMenu({ actions, callNo, enabled, onPick }: { actions: Action[]; callNo: number | null; enabled: boolean; onPick: (a: Action) => void }) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<{ top: number; left: number; maxHeight: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const dismiss = () => setOpen(false);
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    window.addEventListener('resize', dismiss);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
      window.removeEventListener('resize', dismiss);
    };
  }, [open]);

  // The menu is placed against the viewport, not inside the main pane, which clips what overflows it.
  // It hangs right-aligned under its button when that stays inside the pane (the buttons at the
  // header's right), and opens rightward from the button otherwise (the header wrapped them left).
  const openMenu = () => {
    const r = toggle.current?.getBoundingClientRect();
    if (r) {
      const width = Math.min(440, window.innerWidth * 0.9);
      const margin = 12;
      const pane = ref.current?.closest('.main')?.getBoundingClientRect();
      const paneLeft = (pane?.left ?? 0) + margin;
      const preferred = r.right - width >= paneLeft ? r.right - width : r.left;
      const left = Math.max(margin, Math.min(preferred, window.innerWidth - width - margin));
      const top = r.bottom + 6;
      setPlace({ top, left, maxHeight: Math.max(160, window.innerHeight - top - 40) });
    }
    setOpen(true);
  };
  const replay = actions.find((a) => a.key === 'r');
  const rest = actions.filter((a) => a.key !== 'r');
  const title = enabled ? undefined : 'Actions run the CLI: start the dashboard with shadowlap dashboard';
  return (
    <div className="actions" ref={ref}>
      {replay ? (
        <button type="button" className="btn primary" disabled={!enabled || !!replay.disabled} title={title ?? replay.disabled ?? undefined} onClick={() => onPick(replay)}>
          Replay
        </button>
      ) : null}
      <button ref={toggle} type="button" className="btn" aria-haspopup="menu" aria-expanded={open} disabled={!enabled} title={title} onClick={() => (open ? setOpen(false) : openMenu())}>
        {callNo !== null ? `Fork at #${callNo}` : 'More'}
        <span className="caret-down" aria-hidden="true" />
      </button>
      {open ? (
        <div className="menu" role="menu" style={place ? { top: place.top, left: place.left, maxHeight: place.maxHeight } : undefined}>
          {rest.map((a) => (
            <button
              key={a.key}
              role="menuitem"
              type="button"
              disabled={!!a.disabled}
              aria-disabled={!!a.disabled}
              onClick={() => {
                if (a.disabled) return;
                setOpen(false);
                onPick(a);
              }}
            >
              <kbd>{a.key}</kbd>
              <span>
                {a.label}
                {a.disabled ? <span className="menu-why">{a.disabled}</span> : null}
              </span>
            </button>
          ))}
          <div className="menu-note">
            {rest.some((a) => a.disabled)
              ? 'A capture has no command, so the greyed-out actions need a replay with yours first. That replay records every kind of call, and every fork works on it.'
              : callNo === null
                ? 'Select a call for the fork actions at that call.'
                : 'Each runs the CLI; its output opens below.'}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function PromptDialog({ action, onRun, onClose }: { action: Action; onRun: (value: string) => void; onClose: () => void }) {
  const [value, setValue] = useState(action.prompt?.initial ?? '');
  const submit = () => value.trim() && onRun(value.trim());
  return (
    <Dialog
      title={action.label}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn quiet" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={!value.trim()} onClick={submit}>
            Run
          </button>
        </>
      }
    >
      <label className="field">
        <span>{action.prompt?.label}</span>
        <textarea
          rows={3}
          value={value}
          placeholder={action.prompt?.placeholder ?? ''}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
      </label>
      <p className="note">Runs the CLI in the directory the dashboard was started from · Enter runs · Shift+Enter adds a line</p>
    </Dialog>
  );
}

/** The output of a running or finished action, docked at the bottom. */
export function JobDrawer({ client, job: initial, onClose, onFinished }: { client: Client; job: JobView; onClose: () => void; onFinished: () => void }) {
  const [job, setJob] = useState(initial);
  const [lines, setLines] = useState<string[]>(initial.lines);
  const outRef = useRef<HTMLPreElement>(null);
  const finished = useRef(false);
  useEffect(() => {
    let alive = true;
    let count = initial.lines.length;
    const poll = async () => {
      try {
        const next = await client.job(initial.id, count);
        if (!alive) return;
        count = next.total;
        if (next.lines.length) setLines((prev) => [...prev, ...next.lines].slice(-2000));
        setJob(next);
        if (next.done) {
          if (!finished.current) {
            finished.current = true;
            onFinished();
          }
          return;
        }
      } catch {
        // keep polling; the drawer shows the last known state
      }
      if (alive) setTimeout(poll, 250);
    };
    void poll();
    return () => {
      alive = false;
    };
  }, [client, initial.id, initial.lines.length, onFinished]);
  useEffect(() => {
    const el = outRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);
  const ok = job.done && job.code === 0;
  const command = `shadowlap ${job.args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`;
  return (
    <section className="drawer" aria-label="Action output" aria-live="polite">
      <header>
        <span className={`state ${job.done ? (ok ? 'ok' : 'bad') : 'running'}`}>{job.done ? (ok ? 'Done' : `Exit ${job.code ?? '?'}`) : 'Running'}</span>
        <code className="drawer-cmd" title={command}>
          <b>$</b> {command}
        </code>
        {job.done && job.newRunId ? (
          <button type="button" className="btn primary small" onClick={() => navigate(href.run(job.newRunId!))}>
            Open {shortId(job.newRunId)}
          </button>
        ) : null}
        <button type="button" className="textbtn" onClick={onClose} aria-label="Close output">
          Close
        </button>
      </header>
      <pre ref={outRef} className="out">
        {lines.join('\n') || (job.done ? '(no output)' : 'Starting…')}
      </pre>
    </section>
  );
}

export function ConfirmDialog({ title, body, confirm, danger, onConfirm, onClose }: { title: string; body: string; confirm: string; danger?: boolean; onConfirm: () => void; onClose: () => void }) {
  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn quiet" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={`btn ${danger ? 'danger' : 'primary'}`} onClick={onConfirm}>
            {confirm}
          </button>
        </>
      }
    >
      <p>{body}</p>
    </Dialog>
  );
}
