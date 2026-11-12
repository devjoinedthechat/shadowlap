import { goldenTestEstimate } from '../../../engine/src/estimates/golden-test.js';
import { isObject } from '../../../engine/src/is-object.js';
import { JOB_KINDS } from '../api.js';
import { JobButton } from '../components/JobButton.js';
import { useTestsWait } from '../fixes/tree.js';
import { goldenName } from '../format.js';
import { commandText } from '../goldens.js';
import { addJobFooter, type JobFooter } from '../job-actions.js';
import { ACTIONS } from '../labels.js';
import { useApp } from '../state.js';
import { startTestsJob, type TestsAsk } from '../tests-ask.js';

/*
 * What Pack as golden's and Pack with checks…' drawer ends on: Run test, on the golden the pack
 * wrote (the CLI's Open Tests beside it is secondary). Registered by the dialog that starts the pack
 * (PackDialog.tsx), a part a copy never draws: a copy runs nothing.
 */

/** The one golden the pack wrote, and whether it forks; null where it wrote none, or several. */
export function packedGolden(result: unknown): { golden: string; fork: boolean } | null {
  const pack = isObject(result) && Array.isArray(result.pack) ? result.pack : [];
  const made = pack.filter((p): p is { golden: string; mode?: unknown } => isObject(p) && typeof p.golden === 'string');
  return made.length === 1 ? { golden: made[0]!.golden, fork: made[0]!.mode === 'fork' } : null;
}

/**
 * Run test's question, asked where the server asks first: a golden that forks runs live from where
 * the agent parts from production's run, with no estimate until it has run once (goldenTestEstimate).
 */
export function packedTestAsk(golden: string, fork: boolean): TestsAsk {
  const name = goldenName(golden);
  return {
    title: `${ACTIONS.runTest.label} on ${name}`,
    name,
    lead: fork ? 'Replays production’s run until your agent parts from it, then judges it by your checks.' : `Replays ${name} offline.`,
    doc: 'goldensThatFork',
    ok: ACTIONS.runTest.label,
    commands: [commandText(['test', golden])],
    estimate: goldenTestEstimate(fork, null),
  };
}

const PackFooter: JobFooter = ({ job, plain }) => {
  const app = useApp();
  // It waits as Tests' buttons do: the server refuses a test while a session, an update or a pack runs.
  const wait = useTestsWait('run its test');
  const made = job.done ? packedGolden(job.result) : null;
  if (!made) return null;
  const ask = packedTestAsk(made.golden, made.fork);
  const run = () => void startTestsJob(app, JOB_KINDS.tests, { golden: made.golden }, ask);
  return (
    <JobButton
      className={plain ? 'btn' : 'btn lime'}
      why={wait}
      tip={ask.title}
      sub={ask.lead}
      command={`$ ${ask.commands![0]!}`}
      estimate={ask.estimate ?? null}
      start={run}
      ask={run}
    >
      {ACTIONS.runTest.label}
    </JobButton>
  );
};

addJobFooter(JOB_KINDS.coveragePack, PackFooter);
