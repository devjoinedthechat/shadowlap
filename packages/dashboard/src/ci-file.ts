import { diffLines, findWorkflow, readWorkflow, workflowVersion, type DiffLine, type WorkflowFile, type WorkflowRead } from '@shadowlap/engine';
import { patchWorkflow } from './ci-patch.js';
import { REPAIRER, type BucketCredentials } from './ci-yaml.js';

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

/** The repository's workflow as Settings → CI reads it: the file, its action step, and the switches it sets. */
export interface RepositoryWorkflow {
  file: WorkflowFile;
  /** Its action step and Slack step; null when the file isn't there or can't be read. */
  read: WorkflowRead | null;
  /** The switches it sets; null without an action step the reader could take. */
  switches: FileSwitches | null;
}

/**
 * The project's workflow that runs the action (findWorkflow), read narrowly: only at its
 * repository's root, where GitHub reads it (`root`); null elsewhere, and without a project.
 */
export function repositoryWorkflow(project: string | null, root: boolean): RepositoryWorkflow | null {
  if (!project || !root) return null;
  const file = findWorkflow(project);
  const read = file.exists && !file.problem ? readWorkflow(file.text) : null;
  return { file, read, switches: read && !read.problem ? fileSwitches(read) : null };
}

/** What Write file would leave, against the repository's file. */
export interface WorkflowState {
  /** The whole file: the repository's patched, else the switches' own. */
  text: string;
  lines: DiffLine[];
  added: number;
  removed: number;
  /** The repository's file is there and no line differs. */
  same: boolean;
  /** The SHA-256 of `text`. */
  shown: string;
  /** Why the repository's file can't be read or patched line by line, as the tab says it; null when it can. */
  problem: string | null;
}

/** A file Write file leaves alone, saying why after its path, and that Copy workflow has the whole file. */
const leftAlone = (path: string, why: string) => `${path} ${why}. Write file leaves it as it is: copy the workflow and change the file yourself.`;

/**
 * The file to write and its change: the repository's file patched from `base` (the whole file for
 * the options it was read as) to `want` (for the options now), keeping every line the switches
 * don't own (Q1). Without a file, or one that can't be read or patched, the switches' own file,
 * every line of it added.
 */
export function workflowState(repo: RepositoryWorkflow | null, base: string, want: string): WorkflowState {
  const file = repo?.file ?? null;
  let text = want;
  let problem: string | null = file?.problem ? leftAlone(file.path, file.problem) : null;
  if (file?.exists && !file.problem) {
    const patched = patchWorkflow(file.text, base, want);
    if ('text' in patched) text = patched.text;
    else problem = leftAlone(file.path, patched.problem);
  }
  const was = file?.exists && !file.problem ? file.text : '';
  const diff = diffLines(was, text);
  return { text, lines: diff.lines, added: diff.added, removed: diff.removed, same: !!file?.exists && !file.problem && !diff.added && !diff.removed, shown: workflowVersion(text), problem };
}
