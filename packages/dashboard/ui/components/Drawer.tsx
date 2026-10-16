import { useEffect, useRef } from 'react';
import { shortId } from '../format.js';
import { jobCommand, jobStatus, jobTitle, lineTone } from '../jobs.js';
import { href } from '../route.js';
import { switchProject } from '../shell/ProjectBlock.js';
import { useApp, useLayer, type WatchedJob } from '../state.js';
import { Spin } from './bits.js';
import { Icon } from './Icon.js';

/**
 * The job drawer: a CLI run the dashboard started. Its title names the job, its output streams in,
 * it ends on the outcome and the exit code, and links to what the job made. Closed early, a toast
 * says when the job finishes.
 */
export function JobDrawer() {
  const { jobs } = useApp();
  const open = [...jobs].reverse().find((w) => w.open);
  return open ? <Drawer key={open.job.id} watched={open} /> : null;
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
  useLayer('panel', true, close);
  const out = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = out.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);
  const title = jobTitle(job);
  const status = jobStatus(job, lines, lost);
  const files = job.files ?? [];
  const folders = files.filter((f) => f.directory);
  const links = job.links ?? [];
  const opens = job.done && job.newRunId && (job.opensRun || links.length === 0) && !links.some((l) => l.href.includes(job.newRunId!));
  return (
    <div className="drawer" role="dialog" aria-label={title} aria-live="polite">
      <header>
        {job.done || lost ? null : <Spin />}
        <b>{title}</b>
        {elsewhere ? <span className="st2 jin">in {elsewhere.name}</span> : null}
        <span className={`st2${status.tone ? ` ${status.tone}` : ''}`}>{status.text}</span>
        <span className="sp" />
        <button className="ibtn" type="button" aria-label="Close" onClick={close}>
          <Icon name="x" />
        </button>
      </header>
      <pre ref={out}>
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
      <footer>
        {files.filter((f) => !f.directory).map((f) => (
          <button
            key={f.fileId}
            className="btn"
            type="button"
            onClick={() =>
              client.downloadFile(f).then(
                () => toast(`Saved ${f.name}`),
                (err: unknown) => toast(err instanceof Error ? err.message : String(err)),
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
        {links.map((l) => (
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
    </div>
  );
}
