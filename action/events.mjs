// The events the action refuses, read by both of its scripts: run.mjs refuses to test or fix
// anything on one, and history.mjs keeps no test history on one, so action.yml neither restores the
// cache into such a job nor saves what the job holds as a branch's history.

/**
 * The events the action refuses to run on, each with why and what to run it on instead. Each runs
 * with the base repository's secrets (the provider keys the agent needs among them) and a token that
 * may write, and is the usual way to run a pull request's code beside them, which is what the action
 * would run as the agent: so the whole action is refused, not only fix on failure, as the test
 * session alone runs the agent with those keys.
 * @type {Readonly<Record<string, string>>}
 */
const REFUSED_EVENTS = {
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
  return Object.hasOwn(REFUSED_EVENTS, name) ? `the action does not run on ${name}, which ${String(REFUSED_EVENTS[name])}` : null;
}
