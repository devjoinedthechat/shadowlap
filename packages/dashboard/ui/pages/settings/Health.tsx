import { JOB_KINDS, type Client } from '../../api.js';
import { ActionButton } from '../../components/ActionButton.js';
import { Copy } from '../../components/Copy.js';
import { Status } from '../../components/Status.js';
import { DOCTOR_WORDS, doctorChecks, doctorSum, type DoctorCheck } from '../../doctor.js';
import { useLoad } from '../../hooks.js';
import { useApp } from '../../state.js';

/** What Health says before a check has run here. */
const BEFORE = 'Checks Node, the store, the network guard and the configuration, as shadowlap doctor does, each problem with what to do.';

/**
 * The checks of the newest setup check the server keeps that ended with them, in this project (a
 * dashboard of several keeps each one's jobs), or null: its list says which, and that job's own view
 * holds its result, asked for without its lines.
 */
export async function lastChecks(client: Pick<Client, 'jobs' | 'job'>, project: string | null): Promise<DoctorCheck[] | null> {
  const ended = (await client.jobs()).find((j) => j.kind === JOB_KINDS.doctor && j.done && (!project || !j.project || j.project.id === project));
  return ended ? doctorChecks((await client.job(ended.id, ended.total)).result) : null;
}

/**
 * Health, on Settings → Project: Check setup runs `shadowlap doctor` as a job, and the checks of the
 * newest one are listed under it, each with its verdict as a status, what it found and, for a problem
 * or a warning, what to do, summed up in the CLI's own words (`1 problem, 2 warnings`). They are read
 * again as jobs move, so a check that ends shows here, and stays after its drawer is closed. None on
 * a read-only dashboard, or on one whose server doesn't run doctor.
 */
export function HealthRow() {
  const app = useApp();
  return app.actionsOff || !app.hasKind(JOB_KINDS.doctor) ? null : <Health />;
}

function Health() {
  const app = useApp();
  const project = app.meta?.project?.id ?? null;
  const checks = useLoad(() => lastChecks(app.client, project), `settings:doctor:${project ?? ''}`, String(app.feeds.jobs ?? 0)).data ?? null;
  return (
    <>
      <div className="setrow health" id="health">
        <div>
          <b id="health-name">Health</b>
          <Copy as="span" id="health-help">
            {checks ? `${sentenceOf(doctorSum(checks).text)}.` : BEFORE}
          </Copy>
        </div>
        <ActionButton className="btn sm" aria-describedby="health-help" tip="Check setup" sub="Checks the environment, the store and the configuration; it changes nothing" command="$ shadowlap doctor" onClick={() => app.guard(() => app.watchJob(app.client.startJob(JOB_KINDS.doctor, {})))}>
          Check setup
        </ActionButton>
      </div>
      {checks ? (
        <ul className="doctor" aria-labelledby="health-name">
          {checks.map((c, i) => (
            <li key={`${i}:${c.name}`}>
              <Status tone={DOCTOR_WORDS[c.verdict].tone}>{DOCTOR_WORDS[c.verdict].word}</Status>
              <b>{c.name}</b>
              <span className="dd">{c.detail}</span>
              {c.fix ? <span className="dfix">{c.fix}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/** A sum as a sentence: its first letter in capitals. */
const sentenceOf = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
