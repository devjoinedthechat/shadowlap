import { messageOf } from '@shadowlap/engine';

/**
 * A step the server runs between two of a job's commands (`JobBuild.step`): Pack with injection
 * gate… packs, then writes the golden's tests entry against the version the page read, then tests.
 * It runs before the command at `before`, counting the job's `args` as 0 and each of `then` from 1,
 * once the command before it exited 0. Its lines go in the job's output as it words them; one that
 * refuses (`code`) ends the job there, and no command after it runs.
 */
export interface JobStep {
  before: number;
  run: () => Promise<StepDone> | StepDone;
}

/** What a step did: its lines, and `code` when it refused, the job's exit code. */
export interface StepDone {
  lines: string[];
  code?: number;
}

/** A step's outcome, one that threw ending the job as a failure, in its words. */
export async function stepDone(step: JobStep): Promise<StepDone> {
  try {
    return await step.run();
  } catch (err) {
    return { lines: [`failed: ${messageOf(err)}`], code: 1 };
  }
}
