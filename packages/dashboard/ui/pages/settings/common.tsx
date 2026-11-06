import { useEffect, useRef, useState, type ReactNode } from 'react';
import { folderGoneText } from '../../../src/folder-gone.js';
import { ApiError } from '../../api.js';
import { PAUSED } from '../../connection.js';
import { useLoad, type Loaded } from '../../hooks.js';
import { messageOf } from '../../../../engine/src/message-of.js';
import { useApp, type AppState } from '../../state.js';
import { sentence, type ToastAction } from '../../toast.js';
import { onSettingsChanged, settingsChanged } from './events.js';
import { runListKey } from './logic.js';

/**
 * What every Settings tab shares: its data, read again when it may have changed (runs moved, the
 * window came back into focus after an edit in another tool, or the tab edited the file itself);
 * edits that say what they did, or why not; and the notes a tab shows above its panels.
 */

export const CONFIG_FILE = 'shadowlap.config.json';

/**
 * The tab's read, kept while it reloads, and loaded again when the runs there are change (one added,
 * deleted or ended, or another project), when a job reports (a push, a clean-up, a calibration),
 * when the window regains focus, and after an edit. Not when a recording adds calls: the run list
 * reloads every 2 s while anything records, and a tab's read can scan every call.
 */
export function useSettingsData<T>(load: () => Promise<T>, key: string): Loaded<T> {
  const { runs, meta, feeds } = useApp();
  const runsKey = `${runListKey(runs, meta?.project?.id ?? null)}:${feeds.jobs ?? 0}`;
  const [seen, setSeen] = useState(0);
  useEffect(() => {
    // The config is edited in an editor or a terminal as often as here: back on the page, read it again.
    const again = () => document.visibilityState === 'visible' && setSeen((n) => n + 1);
    window.addEventListener('focus', again);
    document.addEventListener('visibilitychange', again);
    // ...and when something outside the tab changed it (the drawer added what calibrate proposed).
    const off = onSettingsChanged(() => setSeen((n) => n + 1));
    return () => {
      window.removeEventListener('focus', again);
      document.removeEventListener('visibilitychange', again);
      off();
    };
  }, []);
  // The first read waits for the run list and the project, which its reloads are keyed on: read
  // before them, a tab opened by its link was read twice as the page opened.
  const ready = runs !== null && meta !== null;
  return useLoad(() => (ready ? load() : null), ready ? key : `${key}:waiting`, `${runsKey}:${seen}`);
}

/**
 * Runs an edit and says how it went: `ok` words the toast after it, and the tab reads the file again
 * either way. A file changed on disk since the tab read it (409) is shown as it is now, with nothing
 * changed; anything else refused says why. Offline, it says actions are paused. `undo`, when it
 * gives one, puts the toast's Undo on it.
 */
export async function runEdit<T>(app: AppState, edit: () => Promise<T>, o: { ok: (result: T) => string; reload: () => void; undo?: ((result: T) => ToastAction | null) | undefined }): Promise<T | null> {
  if (app.actionsOff) {
    app.toast(app.actionsOff);
    return null;
  }
  if (app.conn === 'offline') {
    app.toast(PAUSED);
    return null;
  }
  try {
    const result = await edit();
    o.reload();
    app.toast(o.ok(result), 'notice', o.undo?.(result) ?? undefined);
    return result;
  } catch (err) {
    o.reload();
    app.toast(sentence(editErrorText(err)), 'error');
    return null;
  }
}

/** What an edit's controls say while the last edit is on its way. */
export const SAVING = 'Saving the last change…';

/**
 * Why nothing in the project's folder can be changed from Settings now: the folder is gone from
 * disk (moved or deleted), so its edits wait until it is back or the project is removed. Null when
 * it is there. Every tab's edits read it after the dashboard's own reason (read-only, a copy).
 */
export function useFolderGone(): string | null {
  const { meta } = useApp();
  const p = meta?.project;
  return p?.missing ? folderGoneText(p.name) : null;
}

/** What a tab says where its rules would be while shadowlap.config.json can't be read. */
export const RULES_UNREADABLE = 'The rules can’t be read until the file is fixed.';

/** The same while the project's folder is gone: the file went with it, so there is no list, empty or not. */
export const RULES_GONE = 'The rules can’t be read while the folder is gone.';

/** Where Coding agents lists the project's instruction files, while its folder is gone. */
export const FILES_GONE = 'The instruction files can’t be read while the folder is gone.';

/** Where Tools lists the tools the recordings called, while the folder, and the store in it, are gone. */
export const TOOLS_GONE = 'The recorded tool calls can’t be read while the folder is gone.';

/** Where Tools lists the MCP servers, while the folder that holds their configs is gone. */
export const MCP_GONE = 'The MCP configs can’t be read while the folder is gone.';

/**
 * Where a tab's rules would be when it has none to show for a reason other than having none: the
 * file can't be read, or the folder is gone. Null when the list is what the file says.
 */
export function rulesUnreadable(configError: string | null | undefined, gone: string | null): string | null {
  return gone ? RULES_GONE : configError ? RULES_UNREADABLE : null;
}

/**
 * What puts an edit back: the edit that does, sent against the version the edit wrote (from its
 * answer, never the tab's, which may not show that file yet), the words after it, and what to do
 * once it has landed (the focus on a rule put back).
 */
export interface EditUndo {
  edit: () => Promise<{ version?: string }>;
  ok: string;
  /** The control the change was made with, or what took its place: the focus goes back there once the toast is done. */
  returnTo?: HTMLElement | null | undefined;
  then?: (() => void) | undefined;
}

/** How long an Undo waits for the edit it undoes to land before it is sent: as long as the editor waits. */
const LAND_MS = 4000;

/**
 * A tab's edits, one at a time: from the click until the tab shows the file the edit wrote, `busy`
 * is true and another edit is not sent, so a double click removes one rule rather than sending a
 * second edit against the file the first one just changed. Never longer than a few seconds.
 *
 * `run`'s `undo` gives the toast an Undo (⌘Z, the undo key): it waits for the edit it undoes to
 * land rather than being dropped, then goes through the editor like any edit, so a second press
 * sends nothing more. Pressed once the tab has gone (⌘Z from another page), it is sent at once, and
 * whichever tab opens reads the file again.
 */
export function useEditor(
  version: string | null,
  reload: () => void,
): {
  busy: boolean;
  run: <T extends { version?: string }>(edit: () => Promise<T>, ok: (result: T) => string, undo?: (result: T) => EditUndo | null) => Promise<T | null>;
  /** An edit made elsewhere on the tab (the Add dialog) wrote the file's version `to`: wait for the tab to show it. */
  landed: (to: string) => void;
} {
  const app = useApp();
  const [waiting, setWaiting] = useState<{ from: string | null } | null>(null);
  // Refs, so an Undo pressed from a toast made several renders ago reads the editor as it is now.
  const live = useRef({ sending: false, waiting: false, version, mounted: true, app, reload });
  Object.assign(live.current, { waiting: waiting !== null, version, app, reload });
  useEffect(() => {
    const now = live.current;
    now.mounted = true;
    return () => {
      now.mounted = false;
    };
  }, []);
  // The tab shows another file than the one the edit started from: the edit has landed.
  useEffect(() => {
    if (waiting && version !== waiting.from) setWaiting(null);
  }, [version, waiting]);
  useEffect(() => {
    if (!waiting) return;
    const t = setTimeout(() => setWaiting(null), LAND_MS);
    return () => clearTimeout(t);
  }, [waiting]);
  const run = async <T extends { version?: string }>(edit: () => Promise<T>, ok: (result: T) => string, undo?: (result: T) => EditUndo | null): Promise<T | null> => {
    const now = live.current;
    if (now.sending || now.waiting) return null;
    now.sending = true;
    const from = now.version;
    setWaiting({ from });
    try {
      const result = await runEdit(now.app, edit, { ok, reload: now.reload, undo: undo ? (r) => undoAction(undo(r)) : undefined });
      // Refused, or nothing changed: there is no new file to wait for.
      if (!result || result.version === from) {
        now.waiting = false;
        setWaiting(null);
      }
      return result;
    } finally {
      now.sending = false;
    }
  };
  // The toast's Undo: once the edit it undoes has landed, through the editor while the tab shows; else at once.
  const undoAction = (u: EditUndo | null): ToastAction | null => {
    if (!u) return null;
    let sent = false;
    return {
      label: 'Undo',
      undo: true,
      returnTo: u.returnTo ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null),
      run: () => {
        if (sent) return;
        sent = true;
        void (async () => {
          for (let waited = 0; live.current.mounted && (live.current.sending || live.current.waiting) && waited < LAND_MS + 1000; waited += 50) await new Promise((done) => setTimeout(done, 50));
          const ok = () => u.ok;
          const back = live.current.mounted ? await run(u.edit, ok) : await runEdit(live.current.app, u.edit, { ok, reload: settingsChanged });
          if (back) u.then?.();
        })();
      },
    };
  };
  const landed = (to: string) => {
    if (to !== version) setWaiting({ from: version });
  };
  return { busy: waiting !== null, run, landed };
}

/** An edit's refusal in the page's words. */
export function editErrorText(err: unknown): string {
  if (err instanceof ApiError && err.status === 409 && /changed since it was read/.test(err.message)) return `${CONFIG_FILE} changed on disk since this page read it. It shows the file as it is now; nothing was changed.`;
  return messageOf(err);
}

/** The config can't be read: what the loader says, and that Settings shows it again once it is fixed. */
export function ConfigProblem({ error }: { error: string }) {
  return (
    <div className="verdict no">
      <span className="badge no">can’t read</span>
      <div>
        <h2>Fix {CONFIG_FILE} to change these settings</h2>
        <p>{error.replace(/\.$/, '')}. Every command refuses the file until it is fixed; Settings reads it again when you come back.</p>
      </div>
    </div>
  );
}

/** A tab whose read failed: what the server said. */
export function LoadProblem({ error, children }: { error: Error; children?: ReactNode }) {
  return (
    <section className="panel stepempty">
      <h3>This tab didn’t load</h3>
      <p>{error.message}</p>
      {children}
    </section>
  );
}

/** While a tab loads for the first time: its panel's frame, so the page doesn't jump when it arrives. */
export function Loading({ title }: { title: string }) {
  return (
    <section className="panel set">
      <header>
        <h2>{title}</h2>
      </header>
      <div className="pbody">
        <p className="muted">Loading…</p>
      </div>
    </section>
  );
}

/** A shell command as the page shows it, wrapping only between its words; the tabs take it from here. */
export { CommandLine } from '../../components/bits.js';
