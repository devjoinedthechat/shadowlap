import type { WorkflowRead } from '@shadowlap/engine';
import { REPAIRER } from './ci-workflows.js';
import type { BucketCredentials } from './ci-yaml.js';

/**
 * The switches as the repository's workflow sets them, which Settings → CI starts from (E30): the
 * action step's inputs and the Slack step after it, as the engine's reader found them. A value the
 * page wouldn't take (a budget past $1,000, a repairer it can't name) is left out, so its default
 * stands. `push` is what the step does with Push from CI's credentials, kept for the patch's base:
 * Push from CI itself is the config's `ciPush`, never the file's (Q2).
 */
export interface FileSwitches {
  comment: boolean;
  fix: boolean;
  budget?: string;
  repairer?: string;
  alerts: boolean;
  onlyMain: boolean;
  secret?: string;
  /** The branch the Slack step's `if:` keeps it to, when it names one. */
  branch?: string;
  inconclusive: 'fail' | 'warn';
  push: BucketCredentials | null;
}

/** An input's `true` or `false`, as the action reads it. */
const flag = (value: string | undefined) => value?.trim().toLowerCase();

/** The switches the file sets; null when it has no step that uses the action. */
export function fileSwitches(read: WorkflowRead): FileSwitches | null {
  const step = read.action;
  if (!step) return null;
  const inputs = step.inputs;
  const budget = Number((inputs['fix-budget'] ?? '').replace(/^\$/, ''));
  const repairer = inputs.repairer?.trim();
  const slack = read.slack;
  const push = flag(inputs.push);
  return {
    comment: flag(inputs.comment) !== 'false',
    fix: flag(inputs['fix-on-failure']) === 'true',
    ...(inputs['fix-budget'] !== undefined && Number.isFinite(budget) && budget > 0 && budget <= 1000 ? { budget: budget.toFixed(2) } : {}),
    ...(repairer && REPAIRER.test(repairer) ? { repairer } : {}),
    alerts: slack !== null,
    // A Slack step whose if: names no branch posts for every branch.
    onlyMain: slack ? slack.branch !== null : true,
    ...(slack?.secret ? { secret: slack.secret } : {}),
    ...(slack?.branch ? { branch: slack.branch } : {}),
    inconclusive: flag(inputs.inconclusive) === 'warn' ? 'warn' : 'fail',
    push: push === 'true' ? 'oidc' : push && /startswith\(\s*github\.event_name/.test(push) ? 'keys' : null,
  };
}
