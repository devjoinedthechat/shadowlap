// The events the action runs on, read by both of its scripts: run.mjs refuses to test or fix
// anything on any other, and history.mjs keeps no test history on one, so action.yml neither
// restores the cache into such a job nor saves what the job holds as a branch's history.

/**
 * The events the action runs on, and nothing else: pull_request, which runs a pull request's code
 * with what a fork may have (from a fork, no secrets and a token that may only read), and those that
 * run a branch of this repository: push, schedule, workflow_dispatch, and merge_group, a merge
 * queue's branch, which holds what someone who may write here queued to merge. The agent the action
 * runs is whatever the job checked out, which the event alone doesn't say, and many other events
 * (pull_request_target, workflow_run, issue_comment, check_run, check_suite, a pull request's review)
 * give a job the base repository's secrets and a token that may write, beside a pull request's code;
 * so the whole action is refused on them, not only fix on failure, as the test session alone runs
 * the agent with those keys.
 */
export const EVENTS = Object.freeze(['pull_request', 'push', 'schedule', 'workflow_dispatch', 'merge_group']);

/**
 * Why the action refuses the events that are the usual way to run a pull request's code beside the
 * base repository's secrets, each with what to run it on instead.
 * @type {Readonly<Record<string, string>>}
 */
const WHY = {
  pull_request_target: "runs a pull request's workflow with the base repository's secrets and a token that may write, beside the agent as the pull request changed it: run it on pull_request",
  workflow_run: "runs with the base repository's secrets and a token that may write once another workflow ends, one a pull request from a fork may have started, and is how that pull request's code gets checked out beside them: run the action in that workflow instead, on pull_request for a pull request's code, or on push for a branch of this repository",
  issue_comment: "runs with the base repository's secrets and a token that may write on a comment anyone can post, and is how a comment gets a pull request's code tested beside them: run it on pull_request, or on workflow_dispatch for a branch of this repository",
};

/**
 * Why the action refuses the event a job runs for, in a sentence, or null when it runs on it.
 * @param {string | undefined} event GITHUB_EVENT_NAME
 * @returns {string | null}
 */
export function refusal(event) {
  const name = event ?? '';
  if (EVENTS.includes(name)) return null;
  if (Object.hasOwn(WHY, name)) return `the action does not run on ${name}, which ${String(WHY[name])}`;
  const on = `it runs on pull_request for a pull request's code, and on push, schedule, workflow_dispatch or merge_group for a branch of this repository`;
  if (!name) return `the job names no event (GITHUB_EVENT_NAME), so the action can't tell whose code it would run: ${on}`;
  return `the action does not run on ${name}: ${on}, and on another event it can't tell whose code the job checked out, which may be a pull request's beside the base repository's secrets and a token that may write`;
}
