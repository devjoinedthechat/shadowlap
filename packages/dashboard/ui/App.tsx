import { useCallback, useMemo, useState } from 'react';
import { ApiError, createClient, type Action, type Client, type JobView } from './api.js';
import { ConfirmDialog, JobDrawer, PromptDialog } from './components/Actions.js';
import { CompareView } from './components/Compare.js';
import { Command, Eyebrow, Logo, RunLabel, Stat } from './components/common.js';
import { RunView } from './components/RunView.js';
import { Sidebar } from './components/Sidebar.js';
import { ago, formatUsd, shortId } from './format.js';
import { useKey, usePolling, useTheme, type Theme } from './hooks.js';
import { href, navigate, useRoute } from './router.js';

export function App({ token, client }: { token: string | null; client?: Client }) {
  if (!token)
    return (
      <div className="page gate">
        <Logo className="big" />
        <Eyebrow>session required</Eyebrow>
        <h1 className="display">Open the dashboard from its link.</h1>
        <p className="lede">Recordings hold prompts and tool data, so the dashboard serves them only to the link <code>shadowlap dashboard</code> prints. That link carries a session token for this run of the dashboard.</p>
        <Command>shadowlap dashboard</Command>
      </div>
    );
  return <Dashboard token={token} {...(client ? { provided: client } : {})} />;
}

function Dashboard({ token, provided }: { token: string; provided?: Client }) {
  const client = useMemo(() => provided ?? createClient(token), [provided, token]);
  // An exported copy never changes: load each view once.
  const refresh = client.exported ? null : 2000;
  const route = useRoute();
  const [theme, setTheme] = useTheme();
  const meta = usePolling(() => client.meta(), 'meta', null);
  const runs = usePolling(() => client.runs(), 'runs', refresh);
  const [pending, setPending] = useState<{ action: Action; runId: string; callNo: number | null } | null>(null);
  const [job, setJob] = useState<JobView | null>(null);
  const [toDelete, setToDelete] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [help, setHelp] = useState(false);

  const selectedRun = route.page === 'run' ? route.runId : null;
  const actionsEnabled = meta.data?.actions ?? false;
  const reloadRuns = runs.reload;

  const run = useCallback(
    async (action: Action, runId: string, callNo: number | null, value?: string) => {
      setPending(null);
      try {
        setJob(await client.action(runId, action.key, callNo, value));
      } catch (err) {
        setNotice(err instanceof Error ? err.message : String(err));
      }
    },
    [client],
  );
  const onAction = useCallback(
    (action: Action, callNo: number | null) => {
      if (!selectedRun) return;
      if (action.prompt) setPending({ action, runId: selectedRun, callNo });
      else void run(action, selectedRun, callNo);
    },
    [selectedRun, run],
  );
  const onFinished = useCallback(() => reloadRuns(), [reloadRuns]);

  useKey((e) => {
    if (e.key === '?') setHelp((h) => !h);
    else if (e.key === 'Escape') setHelp(false);
  });

  const unauthorized = runs.error instanceof ApiError && runs.error.status === 401;
  const offline = runs.error && !unauthorized;
  const runList = runs.data;

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href={href.home()}>
          <Logo />
          <b>shadowlap</b>
        </a>
        <span className="crumb">dashboard</span>
        <span className="spacer" />
        <ThemeSwitch theme={theme} onChange={setTheme} />
        <button type="button" className="keys" onClick={() => setHelp(true)} aria-label="Keyboard shortcuts">
          ?
        </button>
      </header>

      {unauthorized ? (
        <div className="banner bad">This link's session has ended (the dashboard was restarted). Open the new link that <code>shadowlap dashboard</code> printed.</div>
      ) : offline ? (
        <div className="banner bad">Cannot reach the dashboard server. Is <code>shadowlap dashboard</code> still running?</div>
      ) : null}
      {meta.data?.static ? (
        <div className="banner">
          An exported copy{meta.data.redacted ? ', with the project\u2019s redaction rules applied' : ''}: recorded calls and conversations, no actions, no search across runs. Exported {exportedOn(meta.data.exportedAt)} from Shadowlap {meta.data.version ?? ''}.
        </div>
      ) : !actionsEnabled && meta.data ? (
        <div className="banner">Read-only: actions are available when the dashboard is started with <code>shadowlap dashboard</code>.</div>
      ) : null}

      <div className="body">
        <Sidebar client={client} runs={runList} selected={selectedRun} loading={!runs.data && !runs.error} />
        <main className="main">
          {route.page === 'run' ? (
              <RunView key={route.runId} client={client} runId={route.runId} callNo={route.callNo} actionsEnabled={actionsEnabled} onAction={onAction} onDelete={setToDelete} refreshMs={refresh} />
          ) : route.page === 'compare' ? (
            <CompareView client={client} a={route.a} b={route.b} />
          ) : runList && runList.length === 0 ? (
            <div className="page">
              <Eyebrow>no recordings yet</Eyebrow>
              <h1 className="display">Record a run.</h1>
              <p className="lede">Put <code>shadowlap run --</code> in front of the command you already use. The run shows up here while it records.</p>
              <Command>{'shadowlap run -- node agent.js'}</Command>
              <p className="note">No agent to hand? The repository's reference agent records against a bundled mock API in a minute; see the Quickstart.</p>
            </div>
          ) : runList ? (
            <Home runs={runList} dbPath={meta.data?.dbPath ?? null} />
          ) : null}
        </main>
      </div>

      <footer className="statusbar">
        <span className="sb-item" title={meta.data?.dbPath ?? ''}>
          <span className="sb-label">store</span>
          {meta.data?.static ? 'exported copy' : meta.data?.dbPath ? shortPath(meta.data.dbPath) : '…'}
        </span>
        {runList ? (
          <span className="sb-item">
            {runList.length} {runList.length === 1 ? 'run' : 'runs'}
          </span>
        ) : null}
        <span className="spacer" />
        {meta.data?.static ? null : (
          <span className={`sb-item${offline ? ' bad' : ''}`} title="Runs refresh every 2 seconds">
            {offline ? 'offline · retrying' : runs.updatedAt ? `synced ${clock(runs.updatedAt)}` : 'connecting'}
          </span>
        )}
        {meta.data?.version ? <span className="sb-item">shadowlap {meta.data.version}</span> : null}
      </footer>

      {job ? <JobDrawer client={client} job={job} onClose={() => setJob(null)} onFinished={onFinished} /> : null}
      {pending ? <PromptDialog action={pending.action} onClose={() => setPending(null)} onRun={(v) => void run(pending.action, pending.runId, pending.callNo, v)} /> : null}
      {toDelete ? (
        <ConfirmDialog
          title={`Delete run ${shortId(toDelete)}?`}
          body="Its calls and any recorded data nothing else uses are removed from the store. Its forks keep their own data but lose the link to it. This cannot be undone."
          confirm="Delete run"
          danger
          onClose={() => setToDelete(null)}
          onConfirm={() => {
            const id = toDelete;
            setToDelete(null);
            client.remove(id).then(
              (r) => {
                setNotice(`Deleted ${shortId(r.deleted)}.`);
                reloadRuns();
                navigate(href.home());
              },
              (err: unknown) => setNotice(err instanceof Error ? err.message : String(err)),
            );
          }}
        />
      ) : null}
      {help ? <HelpDialog onClose={() => setHelp(false)} /> : null}
      {notice ? (
        <div className="toast" role="status" onAnimationEnd={() => setNotice(null)}>
          {notice}
        </div>
      ) : null}
    </div>
  );
}

function Home({ runs, dbPath }: { runs: import('./api.js').RunListItem[]; dbPath: string | null }) {
  const recordings = runs.filter((r) => r.mode === 'record').length;
  const forks = runs.filter((r) => r.divergence).length;
  const clean = runs.filter((r) => r.mode === 'replay' && !r.divergence && r.status === 'completed').length;
  const spent = runs.reduce((n, r) => n + r.spent, 0);
  const saved = runs.reduce((n, r) => n + r.saved, 0);
  const captured = runs.reduce((n, r) => n + r.captured, 0);
  const byId = new Map(runs.map((r) => [r.runId, r]));
  const recent = [...runs].sort((a, b) => b.startedAt - a.startedAt).slice(0, 8);
  return (
    <div className="page scroll">
      <Eyebrow>local recordings{dbPath ? ` · ${shortPath(dbPath)}` : ''}</Eyebrow>
      <h1 className="display">Every run, replayable.</h1>
      <p className="lede">Pick a run to read the conversation at any call, play a response back, see where a fork parted from its recording, or fork it again.</p>
      <div className="stats boxed">
        <Stat value={recordings} label="recordings" />
        <Stat value={clean} label="clean replays" />
        <Stat value={forks} label="forks" />
        <Stat value={spent ? `≈${formatUsd(spent)}` : '$0'} label="spent live" note={captured ? `≈${formatUsd(captured)} captured elsewhere` : undefined} />
        <Stat value={formatUsd(saved)} label="not re-spent" />
      </div>
      <section className="block">
        <div className="fighd">
          <i>latest runs</i>
        </div>
        <ol className="recent">
          {recent.map((r) => (
            <li key={r.runId}>
              <a href={href.run(r.runId)}>
                <span className="rid">{shortId(r.runId)}</span>
                <RunLabel label={r.label} status={r.status} />
                <span className="recent-cmd">
                  {r.parentRunId && byId.has(r.parentRunId) ? <span className="muted">of {shortId(r.parentRunId)} · </span> : null}
                  {r.source ? `from ${r.source}` : r.command}
                </span>
                <span className="recent-facts">
                  {r.calls} calls{r.spent ? ` · ≈${formatUsd(r.spent)}` : ''}
                  {r.captured ? ` · ≈${formatUsd(r.captured)} captured` : ''}
                </span>
                <span className="age">{ago(r.startedAt)}</span>
              </a>
            </li>
          ))}
        </ol>
      </section>
      <p className="note">
        <kbd>j</kbd> <kbd>k</kbd> move between calls · <kbd>1</kbd>–<kbd>4</kbd> inspector tabs · <kbd>n</kbd> the fork · <kbd>/</kbd> filter · <kbd>?</kbd> all keys
      </p>
    </div>
  );
}

/** The day a copy was exported: a file may be read long after, so a date beats "3 days ago". */
function exportedOn(ms: number | undefined): string {
  if (!ms) return 'from a recording';
  return new Date(ms).toISOString().slice(0, 10);
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

/** The last three segments of a path, which is what tells stores apart. */
function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : path;
}

function ThemeSwitch({ theme, onChange }: { theme: Theme; onChange: (t: Theme) => void }) {
  const labels: Record<Theme, string> = { light: 'paper', system: 'auto', dark: 'ink' };
  return (
    <div className="mode" role="group" aria-label="Theme">
      {(['light', 'system', 'dark'] as Theme[]).map((t) => (
        <button key={t} type="button" aria-pressed={theme === t} onClick={() => onChange(t)}>
          {labels[t]}
        </button>
      ))}
    </div>
  );
}

function HelpDialog({ onClose }: { onClose: () => void }) {
  const keys: Array<[string, string]> = [
    ['j / k, ↓ / ↑', 'Next or previous call'],
    ['1 – 4', 'Conversation, response, request, details'],
    ['n', 'Jump to the call where the run forked'],
    ['p', 'Open the parent run'],
    ['/', 'Filter calls'],
    ['v', 'Next view: calls, turns, context, timeline, forks'],
    ['?', 'This list'],
    ['Esc', 'Close a dialog'],
  ];
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
        <h2>Keyboard shortcuts</h2>
        <dl className="kv">
          {keys.map(([k, v]) => (
            <div key={k}>
              <dt>
                <kbd>{k}</kbd>
              </dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        <div className="dialog-foot">
          <button type="button" className="btn primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
