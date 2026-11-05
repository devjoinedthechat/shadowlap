import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { JOB_KINDS } from '../api.js';
import { useTreeBusy } from '../fixes/tree.js';
import { shortId } from '../format.js';
import { jobFooter } from '../job-actions.js';
import { calibrationTarget, forkDivergedEarly, jobCommand, jobStatus, jobTitle, lineTone, replayDivergence, stopAsk } from '../jobs.js';
import { InSlot, usePanel } from '../overlays/slots.js';
import { href } from '../route.js';
import { switchProject } from '../shell/ProjectBlock.js';
import { useApp, type WatchedJob } from '../state.js';
import { errorText } from '../toast.js';
import { Spin } from './bits.js';
import { Dialog } from './Dialog.js';
import { Icon } from './Icon.js';

/**
 * The job drawer: a CLI run the dashboard started. Its title names the job, its output streams in,
 * it ends on the outcome and the exit code, and links to what the job made. While it runs, Stop
 * ends it as Ctrl-C would, asking first when it is changing the working tree. Closed early, a toast
 * says when the job finishes, and the top bar's chip opens it again meanwhile. A Replay that
 * diverged offers Calibrate beside the run it made.
 */
export function JobDrawer() {
  const { jobs } = useApp();
  const open = [...jobs].reverse().find((w) => w.open);
  return open ? (
    <InSlot name="dock">
      <Drawer key={open.job.id} watched={open} />
    </InSlot>
  ) : null;
}

function Drawer({ watched }: { watched: WatchedJob }) {
  const app = useApp();
  const { closeJob, client, toast, meta, guard } = app;
  const { job, lines, lost = false } = watched;
  const close = () => closeJob(job.id);
  // A job of another project than the page shows (the dashboard switched since it started): said,
  // and its links switch to that project before they open what it made there.
  const elsewhere = job.project && meta?.project?.id && job.project.id !== meta.project.id ? job.project : null;
  const follow = (to: string) => (e: { preventDefault(): void }) => {
    close();
    if (!elsewhere) return;
    e.preventDefault();
    guard(() => void switchProject(app, elsewhere.id, to));
  };
  const there = elsewhere ? `Switches to ${elsewhere.name}, where this job ran` : undefined;
  usePanel(close);
  // The drawer sits beside the page and never takes the focus; closed while the focus is in it (its
  // Close, Esc), the focus goes back to where it was before it went into the drawer, or to the page.
  const panel = useRef<HTMLDivElement>(null);
  const cameFrom = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const el = panel.current;
    return () => {
      if (!el?.contains(document.activeElement)) return;
      const back = cameFrom.current?.isConnected ? cameFrom.current : document.querySelector<HTMLElement>('#view');
      back?.focus();
    };
  }, []);
  const out = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = out.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);
  const title = jobTitle(job);
  const status = jobStatus(job, lines, lost);
  const running = !job.done && !lost;
  // Stop: sent once, then the job's own view says it is stopping until it has ended.
  const [asking, setAsking] = useState(false);
  const [sent, setSent] = useState(false);
  const stopping = running && (sent || job.stopped === true);
  const ask = stopAsk(job);
  const stop = () =>
    guard(() => {
      setSent(true);
      client.stopJob(job.id).then(
        (r) => {
          if (!r.stopped) toast(`${title} had ended already`);
        },
        (err: unknown) => {
          setSent(false);
          toast(errorText(err), 'error');
        },
      );
    });
  const files = job.files ?? [];
  const folders = files.filter((f) => f.directory);
  const links = job.links ?? [];
  // One primary action at the end of the footer; a link beside it (each failing golden's run) reads as a plain link above.
  const primary = links.filter((l) => !l.secondary);
  const beside = links.filter((l) => l.secondary);
  const opens = job.done && job.newRunId && (job.opensRun || links.length === 0) && !links.some((l) => l.href.includes(job.newRunId!));
  // What the job's own feature adds: calibrate's "Add it (--write)", a clean-up's "Delete N runs".
  // Only where the job ran: from another project's page it would act on the wrong one.
  const Footer = elsewhere ? null : jobFooter(job.kind);
  // A Replay whose request differed from its recording, or a fork that left it before the call its
  // flag acts on: Calibrate finds the normalizer when the difference is a value made anew on every
  // run. Only where the job ran, as above.
  const calibrate = !elsewhere && !lost && (replayDivergence(job, lines) || forkDivergedEarly(job, lines)) && app.hasKind(JOB_KINDS.calibrate) ? calibrationTarget(job.runId, app.runs ?? []) : null;
  return (
    <div
      className="drawer"
      role="dialog"
      aria-label={title}
      ref={panel}
      onFocus={(e) => {
        const from = e.relatedTarget;
        if (from instanceof HTMLElement && !panel.current?.contains(from)) cameFrom.current = from;
      }}
    >
      <header>
        {job.done || lost ? null : <Spin />}
        <b>{title}</b>
        {elsewhere ? <span className="st2 jin">in {elsewhere.name}</span> : null}
        <span className={`st2${status.tone ? ` ${status.tone}` : ''}`}>{status.text}</span>
        {/* What a screen reader hears of the job: how it stands, as that changes (running, stopping, how
            it ended), never each line it prints, which the output holds to be read at will. */}
        <span className="sr" role="status">{`${title}: ${status.text}`}</span>
        <span className="sp" />
        {running ? (
          <button className="btn sm" type="button" disabled={stopping} title={stopping ? 'Asked to stop: it ends once its command has' : `Stops ${jobCommand(job.args)} as Ctrl-C would`} onClick={() => (ask ? setAsking(true) : stop())}>
            {stopping ? 'Stopping…' : 'Stop'}
          </button>
        ) : null}
        <button className="ibtn" type="button" aria-label="Close" onClick={close}>
          <Icon name="x" />
        </button>
      </header>
      {/* Scrolled by keyboard too: focusable, and named for what it holds. */}
      <pre ref={out} tabIndex={0} role="region" aria-label="What the command printed">
        <span className="p">$ {jobCommand(job.args)}</span>
        {'\n'}
        {lines.map((l, i) => {
          const tone = lineTone(l);
          return (
            <span key={i} className={tone || undefined}>
              {l}
              {'\n'}
            </span>
          );
        })}
        {!job.done && !lost && lines.length === 0 ? <span>starting…</span> : null}
      </pre>
      {folders.length ? (
        <div className="jfiles">
          {folders.map((f) => (
            <span key={f.fileId} title="A folder in the project: open it from your editor or a terminal">
              <Icon name="folder" />
              {f.label ? `${f.label} · ` : ''}
              <code>{f.path ?? f.name}</code>
            </span>
          ))}
        </div>
      ) : null}
      {beside.length ? (
        <div className="jlinks">
          {beside.map((l) => (
            <a key={l.href + l.label} className="more" href={l.href} title={there} onClick={follow(l.href)}>
              {l.label}
            </a>
          ))}
        </div>
      ) : null}
      <footer>
        {files.filter((f) => !f.directory).map((f) => (
          <button
            key={f.fileId}
            className="btn"
            type="button"
            onClick={() =>
              void client.downloadFile(f).then(
                () => toast(`Saved ${f.name}`),
                (err: unknown) => toast(errorText(err), 'error'),
              )
            }
          >
            <Icon name="import" />
            {f.label ?? f.name}
          </button>
        ))}
        <button className="btn" type="button" onClick={close}>
          Close
        </button>
        {/* eslint-disable-next-line react-hooks/static-components -- the footer registered for the job's kind: one component a kind, the same on every render */}
        {Footer && !lost ? <Footer job={job} /> : null}
        {calibrate ? <CalibrateButton runId={calibrate} /> : null}
        {primary.map((l) => (
          <a key={l.href + l.label} className="btn lime" href={l.href} title={there} onClick={follow(l.href)}>
            {l.label}
          </a>
        ))}
        {opens ? (
          <a className="btn lime" href={href.run(job.newRunId!)} title={there} onClick={follow(href.run(job.newRunId!))}>
            Open run {shortId(job.newRunId!)}
          </a>
        ) : null}
      </footer>
      {asking && ask && running ? <StopJobDialog ask={ask} onClose={() => setAsking(false)} onOk={stop} /> : null}
    </div>
  );
}

/**
 * Calibrate, after a Replay diverged, or a fork before its flag acted: the calibrate job on the
 * recording, which replays it offline until it is clean and proposes a normalizer for each value
 * that changes every run (a user id, a temporary path); its own drawer then offers to add them. It
 * runs the agent from the working tree, so it waits while a repair or an apply changes it, as
 * Settings → Matching's Calibrate does.
 */
function CalibrateButton({ runId }: { runId: string }) {
  const { client, actionsOff, guard, watchJob } = useApp();
  const tree = useTreeBusy('reads', 'calibrate');
  const off = actionsOff ?? tree;
  const id = shortId(runId);
  return (
    <button
      className="btn"
      type="button"
      disabled={!!off}
      title={off ?? `Replays ${id} offline until it is clean and proposes a normalizer for each value that changes every run: shadowlap calibrate ${id}`}
      onClick={() => guard(() => watchJob(client.startJob(JOB_KINDS.calibrate, { runId })))}
    >
      Calibrate
    </button>
  );
}

/** What Stop asks first, for a job that holds the working tree: it starts on Keep it running, as the job goes on unless you say. */
export function StopJobDialog({ ask, onOk, onClose }: { ask: NonNullable<ReturnType<typeof stopAsk>>; onOk: () => unknown; onClose: () => void }) {
  return <Dialog title={ask.title} lead={ask.lead} doc="jobs" facts={ask.facts} ok={ask.ok} tone="plain" initialFocus="cancel" cancel="Keep it running" onClose={onClose} onOk={onOk} />;
}
