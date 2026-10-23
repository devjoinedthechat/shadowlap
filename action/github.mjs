// GitHub, for the action: the token it pushes a fix's branch and opens its pull request with, and the
// workflow it starts on a fix's branch when GitHub starts none. The REST API is called with Node's own
// fetch, which the tests replace: the action adds no dependency. Inputs arrive as environment
// variables, as for run.mjs.
const API_VERSION = '2022-11-28';

/**
 * The token the action speaks to GitHub with, and whether GitHub starts workflows for what it does
 * with it. GitHub starts none for a push or a pull request made with the job's own GITHUB_TOKEN
 * (`SHADOWLAP_JOB_TOKEN`, which action.yml passes from `github.token`), so a fix's pull request
 * opened with it would sit with its required checks never started. A `github-token` input (a GitHub
 * App's token or a personal access token) does start them; so does a GH_TOKEN the step was given that
 * is another token than the job's. `source` says which: `input`, `gh-token`, `github-token`, or `none`.
 */
export function githubToken(env) {
  const given = (env.INPUT_GITHUB_TOKEN ?? '').trim();
  const job = (env.SHADOWLAP_JOB_TOKEN ?? '').trim();
  const gh = (env.GH_TOKEN || env.GITHUB_TOKEN || '').trim();
  if (given && given !== job) return { token: given, source: 'input', startsWorkflows: true };
  if (gh && job && gh !== job) return { token: gh, source: 'gh-token', startsWorkflows: true };
  const token = given || job || gh;
  return token ? { token, source: 'github-token', startsWorkflows: false } : { token: null, source: 'none', startsWorkflows: false };
}

/**
 * The environment git and gh run with to push and open a fix's pull request with `auth`'s token. gh
 * reads GH_TOKEN. actions/checkout leaves the job's token in the repository's git config, as an
 * Authorization header for the server; a token of another kind replaces it, through git's
 * GIT_CONFIG_* variables (an empty value clears the header the config has, the next one sets the
 * token's), so it never appears in a command line.
 */
export function tokenEnv(env, auth) {
  if (!auth?.token) return env;
  const out = { ...env, GH_TOKEN: auth.token };
  if (auth.source !== 'input' && auth.source !== 'gh-token') return out;
  const server = (env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/+$/, '');
  const n = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10) || 0;
  const key = `http.${server}/.extraheader`;
  out.GIT_CONFIG_COUNT = String(n + 2);
  out[`GIT_CONFIG_KEY_${n}`] = key;
  out[`GIT_CONFIG_VALUE_${n}`] = '';
  out[`GIT_CONFIG_KEY_${n + 1}`] = key;
  out[`GIT_CONFIG_VALUE_${n + 1}`] = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${auth.token}`).toString('base64')}`;
  return out;
}

/** The environment without the tokens action.yml hands the action: what the CLI, and the agent it runs, get. */
export function withoutTokens(env) {
  const out = { ...env };
  delete out.INPUT_GITHUB_TOKEN;
  delete out.SHADOWLAP_JOB_TOKEN;
  return out;
}

/** The REST API's base URL and the repository, from the job's variables. */
export function repositoryOf(env) {
  return { api: (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, ''), repo: env.GITHUB_REPOSITORY || null };
}

/** One call to the REST API: its status, and its JSON body when it has one. */
async function call(fetchFn, { api, token }, method, path, body) {
  const res = await fetchFn(`${api}${path}`, {
    method,
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': API_VERSION, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let data = null;
  try {
    const text = await res.text();
    data = text ? JSON.parse(text) : null;
  } catch {
    // no JSON: the status says enough
  }
  return { status: res.status, ok: res.status >= 200 && res.status < 300, data };
}

/** What GitHub said about a call that failed, in its words when it gave some. */
const said = (r) => `GitHub answered ${r.status}${r.data && typeof r.data.message === 'string' ? ` (${r.data.message})` : ''}`;

/**
 * The workflow file this job runs in, as a dispatch names it (`ci.yml`), from GITHUB_WORKFLOW_REF
 * (`owner/repo/.github/workflows/ci.yml@refs/heads/main`); null outside GitHub Actions.
 */
export function workflowFile(env) {
  const m = /^[^/]+\/[^/]+\/\.github\/workflows\/([^@/]+)@/.exec(env.GITHUB_WORKFLOW_REF ?? '');
  return m ? m[1] : null;
}

/**
 * Starts the workflow this job runs in on a fix's branch (`workflow_dispatch`), as GitHub starts no
 * workflow for a pull request the job's GITHUB_TOKEN opened, and does start one that token
 * dispatches. Its run checks the branch, and the pull request shows it. Never throws:
 * `{ dispatched, workflow, why }`.
 */
export async function dispatchWorkflow({ env, auth, branch, fetch: fetchFn = globalThis.fetch }) {
  const workflow = workflowFile(env);
  const { api, repo } = repositoryOf(env);
  if (!workflow || !repo) return { dispatched: false, workflow, why: 'the job did not say which workflow it runs in (GITHUB_WORKFLOW_REF), as outside GitHub Actions' };
  if (!auth?.token) return { dispatched: false, workflow, why: 'the job has no token to start it with' };
  try {
    const r = await call(fetchFn, { api, token: auth.token }, 'POST', `/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, { ref: branch });
    if (r.ok) return { dispatched: true, workflow, why: null };
    if (r.status === 422) return { dispatched: false, workflow, why: `${workflow} has no workflow_dispatch trigger, which it needs to be started on a branch: ${said(r)}` };
    if (r.status === 403 || r.status === 404) return { dispatched: false, workflow, why: `the job's token may not start it: give the job actions: write (${said(r)})` };
    return { dispatched: false, workflow, why: said(r) };
  } catch (err) {
    return { dispatched: false, workflow, why: `GitHub could not be reached: ${err instanceof Error ? err.message : String(err)}` };
  }
}


