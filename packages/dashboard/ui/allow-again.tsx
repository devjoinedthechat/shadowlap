import { useState } from 'react';
import { consentAsked } from './actions.js';
import { allowAgainLabel, andList } from './allow-words.js';
import { ActionButton } from './components/ActionButton.js';
import { ConsentDialog, Dialog } from './components/Dialog.js';
import { jobCommand, unrecordedAllow } from './jobs.js';
import { guardedWayOn, useApp } from './state.js';
import { errorText } from './toast.js';
import type { JobView } from './types.js';

/**
 * Run again, allowing <tools>: the way on of a job the CLI refused because its run's model called a
 * tool shadowlap never recorded that writes, or may, which a replay would run again for real. It
 * asks first, saying the tool acts on your systems, then starts the same job again with
 * `--allow-unrecorded` naming the tools the CLI named (`POST /api/jobs/:id/again`, which builds the
 * request again, checked as before). A yes its kind asks (a command someone else recorded, a golden
 * that runs live) is asked in its place before it runs. None where the CLI suggested no flag, or
 * nothing runs jobs here.
 */

export { allowAgainLabel };

/** The CLI's commands that take `--allow-unrecorded`, each replaying a recording (src/jobs.ts ALLOWS_UNRECORDED). */
const REPLAYS: ReadonlySet<string> = new Set(['replay', 'calibrate', 'blame', 'verify', 'repair', 'test', 'bisect', 'injection', 'serve']);

/** The job's command as it runs again, as its drawer will head it: the flag before its `--` where it replays a recording, as the server adds it. */
export function allowedCommand(args: readonly string[], tools: readonly string[]): string {
  if (!REPLAYS.has(args[0] ?? '')) return jobCommand(args);
  const at = args.indexOf('--');
  const flag = ['--allow-unrecorded', tools.join(',')];
  return jobCommand(at < 0 ? [...args, ...flag] : [...args.slice(0, at), ...flag, ...args.slice(at)]);
}

export function AllowAgain({ job, lines }: { job: JobView; lines: readonly string[] }) {
  const app = useApp();
  const [asking, setAsking] = useState(false);
  const tools = job.done && !job.stopped && job.code !== 0 ? unrecordedAllow(lines) : null;
  if (!tools || !app.client.jobAgain || !app.hasKind(job.kind ?? '')) return null;
  const label = allowAgainLabel(tools);
  return (
    <>
      <ActionButton className="btn" data-way="" why={app.actionsOff} tip={label} sub="Asks first: a tool that writes acts on your systems for real" command={`$ ${allowedCommand(job.args, tools)}`} onClick={() => setAsking(true)}>
        {label}
      </ActionButton>
      {asking ? <AllowAgainDialog job={job} tools={tools} onClose={() => setAsking(false)} /> : null}
    </>
  );
}

function AllowAgainDialog({ job, tools, onClose }: { job: JobView; tools: string[]; onClose: () => void }) {
  const app = useApp();
  const [consent, setConsent] = useState<{ why: string; confirm: string } | null>(null);
  const names = andList(tools);
  const one = tools.length === 1;
  const send = (yes?: string): Promise<boolean> =>
    app.client.jobAgain!(job.id, { allowUnrecorded: tools, ...(yes ? { yes } : {}) }).then(
      (started) => {
        app.watchJob(Promise.resolve(started));
        return true;
      },
      (err: unknown) => {
        const ask = yes === undefined ? consentAsked(err) : null;
        if (ask) setConsent({ why: ask.why, confirm: ask.confirm });
        else app.toast(errorText(err), 'error');
        return false;
      },
    );
  if (consent) return <ConsentDialog why={consent.why} ok="Run again" onClose={onClose} onOk={() => guardedWayOn(app.guard, () => send(consent.confirm))} />;
  return (
    <Dialog
      title={`${allowAgainLabel(tools)}?`}
      lead={`Runs the same job again, letting its replays run ${names} for real, as the agent ran ${one ? 'it' : 'them'} when the run was recorded.`}
      warn={{ text: `A tool that writes acts on your systems for real: allowed, ${names} ${one ? 'runs' : 'run'} again, and nothing undoes what ${one ? 'it does' : 'they do'}.`, tone: 'red' }}
      command={allowedCommand(job.args, tools)}
      ok="Run again"
      onOk={() => guardedWayOn(app.guard, () => send())}
      onClose={onClose}
    />
  );
}
