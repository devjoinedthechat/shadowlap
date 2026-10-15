import { clock, isoDay, num, tildePath, whenShort } from '../format.js';
import { useNow } from '../hooks.js';
import { isAttempt } from '../runs.js';
import { useApp } from '../state.js';
import { useTeamStore } from '../teamstore.js';

/** The status bar: the store, the counts, the sync state, the address and the version. Below 640px only the left side stays. */
export function StatusBar() {
  const { meta, runs, conn, syncedAt, exported, live } = useApp();
  const now = useNow(10_000);
  // With a team store set, the right side names it and when this machine last pushed or pulled.
  const store = useTeamStore();
  const listed = runs ? runs.filter((r) => !isAttempt(r)).length : null;
  const attempts = meta?.counts?.attempts ?? (runs ? runs.length - (listed ?? 0) : null);
  const runCount = meta?.counts?.runs ?? listed;
  const readOnly = !!meta && !exported && (meta.readOnly === true || !meta.actions);
  let sync: React.ReactNode = 'connecting';
  if (conn === 'offline')
    sync = (
      <>
        <b className="off">offline</b>
        {syncedAt ? ` · last synced ${clock(syncedAt)}` : ''}
      </>
    );
  else if (conn === 'expired') sync = <b className="off">link expired</b>;
  else if (syncedAt) sync = now - syncedAt < 30_000 ? 'synced just now' : `synced ${clock(syncedAt)}`;
  return (
    <footer className="status">
      {exported ? (
        <span>EXPORTED COPY{meta?.exportedAt ? ` · ${isoDay(meta.exportedAt)}` : ''}</span>
      ) : (
        <span title={meta?.dbPath ?? undefined}>STORE {meta?.dbPath ? tildePath(meta.dbPath) : '…'}</span>
      )}
      <span className="sep" />
      <span>
        {runCount === null ? '…' : `${num(runCount)} ${runCount === 1 ? 'run' : 'runs'}`}
        {attempts ? ` · ${num(attempts)} ${attempts === 1 ? 'attempt' : 'attempts'}` : ''}
        {live.length && conn === 'ok' ? ` · ${live.length} recording` : ''}
      </span>
      <span className="sp" />
      {exported ? (
        <span>{meta?.redacted ? 'redaction rules applied' : 'as recorded, not redacted'}</span>
      ) : (
        <>
          <span>{sync}</span>
          <span className="sep" />
          <span>
            {store ? `store ${store.name} · ${store.syncedAt ? `synced ${whenShort(store.syncedAt, now)}` : 'not synced yet'}` : `${meta?.address ?? location.host} · local only`}
            {readOnly ? ' · read-only' : ''}
          </span>
        </>
      )}
      {meta?.version ? (
        <>
          <span className="sep" />
          <span>shadowlap {meta.version}</span>
        </>
      ) : null}
    </footer>
  );
}
