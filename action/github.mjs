// GitHub, for the action: the token it pushes a fix's branch, opens its pull request and comments
// with; the workflow it starts on a fix's branch when GitHub starts none; and the comment it keeps on
// a pull request. The REST API is called with Node's own fetch, which the tests replace: the action
// adds no dependency. Inputs arrive as environment variables, as for run.mjs.
import { readFileSync } from 'node:fs';

const API_VERSION = '2022-11-28';

/**
 * The token the action speaks to GitHub with, and whether GitHub starts workflows for what it does
 * with it. GitHub starts none for a push or a pull request made with the job's own GITHUB_TOKEN
 * (`SHADOWLAP_JOB_TOKEN`, which action.yml passes from `github.token`), so a fix's pull request
 * opened with it would sit with its required checks never started. A `github-token` input (a GitHub
 * App's token or a personal access token) does start them; so does a GH_TOKEN the step was given that
 * is another token than the job's, as steps written before the input had it. `source` says which:
 * `input`, `gh-token`, `github-token`, or `none`. Whichever it is, the CLI never gets it (withoutTokens).
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

/** The Authorization header git sends a token in, as actions/checkout writes it: `AUTHORIZATION: basic <base64>`. */
const basicHeader = (token) => `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;

/**
 * The environment git and gh run with to push and open a fix's pull request with `auth`'s token, for
 * those two alone. gh reads GH_TOKEN. git gets the token as an Authorization header for the server
 * through its GIT_CONFIG_* variables: an empty value clears any header the repository's config has
 * (actions/checkout leaves the job's own there unless persist-credentials is false), the next sets
 * the token's. So the push needs nothing on disk, and the token never appears in a command line.
 */
export function tokenEnv(env, auth) {
  if (!auth?.token) return env;
  const out = { ...env, GH_TOKEN: auth.token };
  const server = (env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/+$/, '');
  const n = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10) || 0;
  const key = `http.${server}/.extraheader`;
  out.GIT_CONFIG_COUNT = String(n + 2);
  out[`GIT_CONFIG_KEY_${n}`] = key;
  out[`GIT_CONFIG_VALUE_${n}`] = '';
  out[`GIT_CONFIG_KEY_${n + 1}`] = key;
  out[`GIT_CONFIG_VALUE_${n + 1}`] = basicHeader(auth.token);
  return out;
}

/**
 * The variables a job holds GitHub's tokens in: the action's input and the job's own token, which
 * action.yml passes; gh's (GH_TOKEN, GITHUB_TOKEN, and their names for a GitHub Enterprise Server);
 * the one the job asks GitHub for an OIDC token with, which can sign in to any cloud role that trusts
 * the repository; and the runner's own, for the cache and artifacts.
 */
export const TOKEN_VARIABLES = ['INPUT_GITHUB_TOKEN', 'SHADOWLAP_JOB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL', 'ACTIONS_RUNTIME_TOKEN'];

/** A token shorter than this is no token GitHub issues: a variable equal to such a value is left alone. */
const SHORTEST_TOKEN = 8;

/**
 * The environment without GitHub's tokens: what the CLI, and the agent it runs, get. Each variable in
 * TOKEN_VARIABLES goes, and so does any other that holds one of their tokens, as it is or as the
 * Authorization header git sends it in: a copy under another name (`MY_TOKEN: ${{ github.token }}`),
 * a `Bearer` header, a git setting in GIT_CONFIG_*. A token in one of git's settings takes all of
 * them with it, as git refuses a GIT_CONFIG_COUNT whose keys or values are missing.
 */
export function withoutTokens(env) {
  const tokens = [...new Set(TOKEN_VARIABLES.map((k) => (env[k] ?? '').trim()).filter((t) => t.length >= SHORTEST_TOKEN))];
  const forms = tokens.flatMap((t) => [t, Buffer.from(`x-access-token:${t}`).toString('base64')]);
  const holds = (v) => typeof v === 'string' && forms.some((f) => v.includes(f));
  const out = {};
  const gitConfig = /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/;
  const gitHolds = Object.entries(env).some(([k, v]) => gitConfig.test(k) && holds(v));
  for (const [k, v] of Object.entries(env)) {
    if (TOKEN_VARIABLES.includes(k) || holds(v) || (gitHolds && gitConfig.test(k))) continue;
    out[k] = v;
  }
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

/**
 * The pull request this job runs for, from its event: its number, and its base branch and commit.
 * Null for any other event, or an event that can't be read.
 */
export function pullRequestOf(env, read = (path) => readFileSync(path, 'utf8')) {
  if (!(env.GITHUB_EVENT_NAME ?? '').startsWith('pull_request') || !env.GITHUB_EVENT_PATH) return null;
  try {
    const pr = JSON.parse(read(env.GITHUB_EVENT_PATH)).pull_request;
    if (!pr || typeof pr.number !== 'number') return null;
    return { number: pr.number, baseRef: typeof pr.base?.ref === 'string' ? pr.base.ref : null, baseSha: typeof pr.base?.sha === 'string' ? pr.base.sha : null };
  } catch {
    return null;
  }
}

/** Why GitHub refused a comment: the token may not, which is said quietly; or anything else. */
const refusal = (r) => (r.status === 401 || r.status === 403 || r.status === 404 ? { state: 'denied', url: null, why: `the job's token may not comment on the pull request: give the job pull-requests: write (${said(r)})` } : { state: 'failed', url: null, why: said(r) });

/** The login GitHub gives what the job's own GITHUB_TOKEN posts, and the App it posts through. */
const ACTIONS_BOT = { login: 'github-actions[bot]', app: 'github-actions' };

/**
 * Who posts with the token, as GitHub names the author of a comment: a person, or the bot of the
 * App whose token it is. A personal access token's owner is the one `GET /user` answers with; the
 * job's own GITHUB_TOKEN posts as GitHub Actions' bot, which `GET /user` doesn't answer for. Any other
 * token (a GitHub App's installation token) is null: GitHub names its owner only once it has posted.
 */
async function tokenOwner(fetchFn, by, auth) {
  const r = await call(fetchFn, by, 'GET', '/user');
  if (r.ok && typeof r.data?.login === 'string') return { login: r.data.login, id: typeof r.data.id === 'number' ? r.data.id : null, app: null };
  if (auth.source === 'github-token') return { login: ACTIONS_BOT.login, id: null, app: ACTIONS_BOT.app };
  return null;
}

/** Whether `owner` made comment `c`: its author's login (and id, when both are known), and for an App's bot, through that App. */
function madeBy(c, owner) {
  const user = c?.user;
  if (!owner || !user || typeof user.login !== 'string') return false;
  if (owner.id !== null && typeof user.id === 'number' && user.id !== owner.id) return false;
  const login = user.login.toLowerCase() === owner.login.toLowerCase();
  if (!owner.app) return login;
  // A person's login can't hold brackets, so `github-actions[bot]` is the bot's alone; or the App it was posted through says so.
  return user.type === 'Bot' && (login || c.performed_via_github_app?.slug === owner.app);
}

/**
 * Keeps `body` on pull request `number` in one comment of the token's own: the one it made whose body
 * holds `marker` is edited in place, else a new one is made. The comments are read a page of 100 at a
 * time. A comment anyone else made never is edited, whatever it holds: one that quotes the marker, or
 * plants it, is left as it is. With a token whose owner GitHub won't name up front (a GitHub App's),
 * the comment is posted again, and the App's earlier ones, which the new one's author names, are
 * removed. Never throws: `{ state, url, why }`, state `updated`, `created`, `denied` (the token may
 * not comment) or `failed`.
 */
export async function upsertComment({ env, auth, number, marker, body, fetch: fetchFn = globalThis.fetch }) {
  const { api, repo } = repositoryOf(env);
  if (!repo || !auth?.token) return { state: 'failed', url: null, why: 'the job has no repository or token to comment with' };
  const by = { api, token: auth.token };
  try {
    const marked = [];
    for (let page = 1; page <= 50; page++) {
      const r = await call(fetchFn, by, 'GET', `/repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`);
      if (!r.ok) return refusal(r);
      const list = Array.isArray(r.data) ? r.data : [];
      marked.push(...list.filter((c) => c && typeof c.body === 'string' && c.body.includes(marker) && typeof c.id === 'number'));
      if (list.length < 100) break;
    }
    const owner = marked.length ? await tokenOwner(fetchFn, by, auth) : null;
    const found = marked.find((c) => madeBy(c, owner)) ?? null;
    if (found) {
      const r = await call(fetchFn, by, 'PATCH', `/repos/${repo}/issues/comments/${found.id}`, { body });
      if (r.ok) return { state: 'updated', url: r.data?.html_url ?? found.html_url ?? null, why: null };
      if (r.status !== 403 && r.status !== 404) return refusal(r);
    }
    const r = await call(fetchFn, by, 'POST', `/repos/${repo}/issues/${number}/comments`, { body });
    if (!r.ok) return refusal(r);
    // Its owner unknown before, the new comment names it: an App's earlier ones go, so one is kept. A
    // person's comment stays whatever it holds, even when the token is theirs.
    if (!owner && marked.length && typeof r.data?.user?.login === 'string' && r.data.user.type === 'Bot') {
      const made = { login: r.data.user.login, id: typeof r.data.user.id === 'number' ? r.data.user.id : null, app: r.data.performed_via_github_app?.slug ?? null };
      for (const c of marked) if (c.id !== r.data.id && madeBy(c, made)) await call(fetchFn, by, 'DELETE', `/repos/${repo}/issues/comments/${c.id}`);
    }
    return { state: 'created', url: r.data?.html_url ?? null, why: null };
  } catch (err) {
    return { state: 'failed', url: null, why: `GitHub could not be reached: ${err instanceof Error ? err.message : String(err)}` };
  }
}
