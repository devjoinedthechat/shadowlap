import { REASON_MAX } from '@shadowlap/engine';
import { optionLike, type TestsJob } from './tests.js';

/**
 * Update golden's reason, as its dialog sends it (`reason`), given to each `test --update` the job
 * runs as `--reason <why>`, which keeps it beside the golden (its accepted.jsonl). One line of
 * text, never one the CLI would read as an option. With none, or a blank one, the job is as it was.
 */
export function withReason(job: TestsJob, raw: unknown): TestsJob {
  if ('error' in job || raw === undefined || raw === null) return job;
  if (typeof raw !== 'string') return { error: 'the reason is text' };
  // A line break or another control character has no place in a reason, or in a command line.
  const reason = raw.replace(/[\p{Cc}\s]+/gu, ' ').trim();
  if (!reason) return job;
  if (reason.length > REASON_MAX) return { error: `the reason is at most ${REASON_MAX} characters` };
  if (optionLike(reason)) return { error: 'the reason can\'t start with a dash' };
  const add = (args: string[]): string[] => (args.includes('--update') ? [...args, '--reason', reason] : args);
  return 'args' in job ? { ...job, args: add(job.args) } : { ...job, steps: job.steps.map(add) };
}
