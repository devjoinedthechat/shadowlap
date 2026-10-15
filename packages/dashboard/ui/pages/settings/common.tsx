import { useEffect, useState, type ReactNode } from 'react';
import { ApiError } from '../../api.js';
import { useLoad, type Loaded } from '../../hooks.js';
import { useApp, type AppState } from '../../state.js';
import { onSettingsChanged } from './events.js';

/**
 * What every Settings tab shares: its data, read again when it may have changed (runs moved, the
 * window came back into focus after an edit in another tool, or the tab edited the file itself);
 * edits that say what they did, or why not; and the notes a tab shows above its panels.
 */

export const CONFIG_FILE = 'shadowlap.config.json';

/** The tab's read, kept while it reloads, and loaded again when runs change or the window regains focus. */
export function useSettingsData<T>(load: () => Promise<T>, key: string): Loaded<T> {
  const { tick } = useApp();
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
  return useLoad(load, key, `${tick}:${seen}`);
}

/**
 * Runs an edit and says how it went: `ok` words the toast after it, and the tab reads the file again
 * either way. A file changed on disk since the tab read it (409) is shown as it is now, with nothing
 * changed; anything else refused says why. Offline, it says actions are paused.
 */
export async function runEdit<T>(app: AppState, edit: () => Promise<T>, o: { ok: (result: T) => string; reload: () => void }): Promise<T | null> {
  if (app.actionsOff) {
    app.toast(app.actionsOff);
    return null;
  }
  if (app.conn === 'offline') {
    app.toast('Actions are paused until the dashboard server is back.');
    return null;
  }
  try {
    const result = await edit();
    o.reload();
    app.toast(o.ok(result));
    return result;
  } catch (err) {
    o.reload();
    app.toast(editErrorText(err));
    return null;
  }
}

/** An edit's refusal in the page's words. */
export function editErrorText(err: unknown): string {
  if (err instanceof ApiError && err.status === 409 && /changed since it was read/.test(err.message)) return `${CONFIG_FILE} changed on disk since this page read it. It shows the file as it is now; nothing was changed.`;
  return err instanceof Error ? err.message : String(err);
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
