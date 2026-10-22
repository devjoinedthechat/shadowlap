import type { Provider, StoreLocation } from './url.js';

/**
 * `shadowlap store ci`: a CI step that runs the goldens and pushes every test run, written for the
 * CI and the cloud, with short-lived credentials (OIDC) wherever both allow it, so no long-lived key
 * is stored in CI. Beside it, the step for pull requests: their jobs get credentials of their own,
 * which write only under pr/ in the store (shadowlap store policy prints both policies), and
 * Shadowlap sends their runs to the pull request's folder. The cloud's trust is what keeps a pull
 * request, which can change this file, from the protected branches' credentials. R2 has no OIDC and
 * its tokens can't be kept to a folder, so pull requests run the tests there without pushing. On
 * GitHub, a pull request from a fork gets no OIDC token, so its job skips the credentials step it
 * could only fail on, and push, finding no credentials, warns while the tests decide the job. A
 * golden that runs live (one marked fork, or with an injection gate) calls the agent's providers,
 * so the step that runs the tests gets their keys too, as the caller names them.
 */

export type CiProvider = 'github' | 'gitlab' | 'other';
export const CI_PROVIDERS: readonly CiProvider[] = ['github', 'gitlab', 'other'];

export interface CiStep {
  ci: CiProvider;
  provider: Provider;
  /** Where it goes: `.github/workflows/…` or `.gitlab-ci.yml`. */
  file: string;
  /** The step for protected branches, and the pull-request step beside it. */
  text: string;
  /** Whether the credentials are short-lived (OIDC) rather than stored keys. */
  oidc: boolean;
  /** What a pull request's job does: push to its own folder in the store with its own credentials, or test without pushing. */
  pullRequests: 'own-folder' | 'no-push';
  /** What to set up once on the cloud side. */
  notes: string[];
  /**
   * GitHub's: the steps that give a job the bucket's credentials, alone, for a workflow whose own
   * step runs the tests and pushes (the dashboard's Settings → CI writes one): the writer's for your
   * branches and a pull request's own, right before that step. Null where the keys come from the
   * repository's secrets (R2), and on another CI.
   */
  credentials?: string | null;
}

/**
 * The keys of the providers the goldens that run live call, which the step that runs the tests
 * needs: by name (`ANTHROPIC_API_KEY`), and whether one of those goldens calls a provider whose key
 * can't be named (its pack can't be read, or Vertex AI's token).
 */
export interface CiStepKeys {
  keys?: readonly string[];
  keysUnknown?: boolean;
}

/** `A`, `A and B`, `A, B and C`. */
function andList(items: readonly string[]): string {
  return items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** Where a key can't be named (an unreadable pack, Vertex AI's token): the agent's own, after those that are. */
const unknownKeys = (named: boolean) => `${named ? 'and ' : ''}your agent's own provider keys: the goldens that run live call them`;

/** A GitHub step's env lines for the providers' keys, at `indent`: each from the repository's secrets, then what can't be named. */
function githubKeys(o: CiStepKeys, indent: string): string[] {
  const keys = [...new Set(o.keys ?? [])];
  return [...keys.map((k) => `${indent}${k}: \${{ secrets.${k} }}`), ...(o.keysUnknown ? [`${indent}# ${unknownKeys(keys.length > 0)}`] : [])];
}

/**
 * A GitHub step's own env for the providers' keys, at the step's `indent`. With none to name, an
 * `env:` holding only the comment is empty, which GitHub refuses: the comment goes under a
 * commented-out `env:` instead, where the keys are to be added.
 */
function githubEnv(o: CiStepKeys, indent: string): string[] {
  if ((o.keys ?? []).length) return [`${indent}env:`, ...githubKeys(o, `${indent}  `)];
  return o.keysUnknown ? [`${indent}# env:`, `${indent}#   ${unknownKeys(false)}`] : [];
}

/** What the goldens that run live need, as a note under the step: where each CI keeps the keys. */
function keysNote(ci: CiProvider, o: CiStepKeys): string[] {
  const keys = [...new Set(o.keys ?? [])];
  if (!keys.length && !o.keysUnknown) return [];
  const what = [...(keys.length ? [andList(keys)] : []), ...(o.keysUnknown ? [`your agent's ${keys.length ? 'other' : 'own'} provider keys`] : [])].join(', and ');
  const many = keys.length > 1 || !!o.keysUnknown;
  const where = ci === 'github' ? (many ? "as repository secrets, which the step's env passes on" : "as a repository secret, which the step's env passes on") : ci === 'gitlab' ? (many ? 'as masked CI/CD variables, which the job gets in its environment' : 'as a masked CI/CD variable, which the job gets in its environment') : "to the job's environment";
  return [`The goldens that run live (marked fork, or with an injection gate) call your agent's providers: add ${what}${o.keysUnknown && keys.length ? ',' : ''} ${where}.`];
}

/** Where a pull (or merge) request's job pushes, in the CI's own words. */
function ownFolderNote(request: 'pull request' | 'merge request'): string {
  return `A ${request}'s job pushes its runs to pr/<number>/ in the store, which Shadowlap finds from the CI's own variables; a teammate's pull brings them only with --include-pr.`;
}

/**
 * The steps before the tests on GitHub: the repository, Node 22.16 or later and not 23 (the CLI
 * says so on another), and the agent's own dependencies, which only the project knows: a
 * placeholder to make its own.
 */
const GITHUB_SETUP = ['  - uses: actions/checkout@v7', '  - uses: actions/setup-node@v7', '    with:', '      node-version: 22', '  - run: npm ci && npm run build   # whatever your agent needs to run'];

function github(loc: StoreLocation, run: string, o: CiStepKeys): CiStep {
  const provider = loc.provider;
  const keys = githubKeys(o, '      ');
  const region = loc.region ?? '<your bucket region>';
  const writerIf = "${{ !startsWith(github.event_name, 'pull_request') }}";
  const prIf = "startsWith(github.event_name, 'pull_request')";
  // The pull request's own credentials, for its own repository's pull requests: GitHub gives a fork's
  // job no OIDC token, so that step could only fail there, and the job with it.
  const ownPrIf = `${prIf} && github.event.pull_request.head.repo.full_name == github.repository`;
  const file = '.github/workflows/shadowlap.yml (in a job)';
  if (provider === 'r2') {
    const text = [
      'steps:',
      ...GITHUB_SETUP,
      `  - if: ${writerIf}`,
      `    run: ${run} --push`,
      '    env:',
      '      R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}',
      '      R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}',
      ...keys,
      `  - if: ${prIf}   # R2 tokens can't be kept to pr/: pull requests test without pushing`,
      `    run: ${run}`,
      ...githubEnv(o, '    '),
    ].join('\n');
    return {
      ci: 'github',
      provider,
      file,
      text,
      credentials: null,
      oidc: false,
      pullRequests: 'no-push',
      notes: [
        "R2 has no OIDC: add an R2 API token's keys as secrets. R2 tokens can't be kept to a folder, so pull requests run the tests without pushing; to keep a pull request's workflow from reading the keys at all, move the push step to a job of its own with an environment only protected branches can use.",
        ...keysNote('github', o),
      ],
    };
  }
  // The credentials step twice: the writer's for everything but pull requests, the pull request's for them.
  const auth: Record<Exclude<Provider, 'r2'>, (pr: boolean) => string[]> = {
    s3: (pr) => ['    uses: aws-actions/configure-aws-credentials@v6', '    with:', `      role-to-assume: arn:aws:iam::<account-id>:role/shadowlap-ci${pr ? '-pr' : ''}`, `      aws-region: ${region}`],
    gcs: (pr) => [
      '    uses: google-github-actions/auth@v3',
      '    with:',
      '      workload_identity_provider: projects/<project-number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>',
      `      service_account: shadowlap-ci${pr ? '-pr' : ''}@<project>.iam.gserviceaccount.com`,
    ],
    azure: (pr) => ['    uses: azure/login@v3', '    with:', `      client-id: \${{ vars.${pr ? 'AZURE_PR_CLIENT_ID' : 'AZURE_CLIENT_ID'} }}`, '      tenant-id: ${{ vars.AZURE_TENANT_ID }}', '      subscription-id: ${{ vars.AZURE_SUBSCRIPTION_ID }}'],
  };
  const credentials = [
    `  - if: ${writerIf}`,
    ...auth[provider](false),
    "  # a pull request's own credentials, which write only under pr/; a fork's job gets none",
    `  - if: ${ownPrIf}`,
    ...auth[provider](true),
  ];
  const text = [
    'permissions:',
    '  id-token: write   # the job gets short-lived cloud credentials; no stored keys',
    '  contents: read',
    '',
    'steps:',
    ...GITHUB_SETUP,
    ...credentials,
    `  - run: ${run} --push`,
    ...githubEnv(o, '    '),
  ].join('\n');
  const trust: Record<Exclude<Provider, 'r2'>, string> = {
    s3: 'Create two roles that trust token.actions.githubusercontent.com: shadowlap-ci for repo:<owner>/<repo>:ref:refs/heads/main only, with the first policy from shadowlap store policy --provider s3, and shadowlap-ci-pr for repo:<owner>/<repo>:pull_request, with the second.',
    gcs: 'Create a workload identity pool and provider for GitHub that maps attribute.ref and attribute.event_name. Let principals with attribute.ref refs/heads/main impersonate shadowlap-ci, bound with the first policy from shadowlap store policy --provider gcs, and those with attribute.event_name pull_request impersonate shadowlap-ci-pr, bound with the second.',
    azure: 'Add federated credentials to two app registrations: one for repo:<owner>/<repo>:ref:refs/heads/main, given the first assignment from shadowlap store policy --provider azure, and one for repo:<owner>/<repo>:pull_request, whose client id goes in AZURE_PR_CLIENT_ID, given the second.',
  };
  return {
    ci: 'github',
    provider,
    file,
    text,
    // The same steps as a list of a job's steps, as a workflow file has them at its own indent.
    credentials: credentials.map((l) => l.slice(2)).join('\n'),
    oidc: true,
    pullRequests: 'own-folder',
    notes: [
      `${trust[provider]} That trust, not this file, keeps a pull request from the first credentials: a pull request can change the workflow.`,
      ownFolderNote('pull request'),
      "A pull request from a fork gets no OIDC token from GitHub, so its job skips the credentials and runs the tests without pushing; push says so in a warning.",
      ...keysNote('github', o),
    ],
  };
}

/** A GitLab job's first script line: the agent's own dependencies, which only the project knows. */
const GITLAB_INSTALL = '    - npm ci && npm run build   # whatever your agent needs to run';

function gitlab(loc: StoreLocation, run: string, o: CiStepKeys): CiStep {
  const provider = loc.provider;
  const region = loc.region ?? '<your bucket region>';
  const mr = '$CI_PIPELINE_SOURCE == "merge_request_event"';
  const main = '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH';
  if (provider === 'r2') {
    const text = [
      'shadowlap:',
      '  image: node:22',
      '  rules:',
      `    - if: ${main}`,
      '  script:',
      GITLAB_INSTALL,
      `    - ${run} --push`,
      'shadowlap-merge-request:',
      '  image: node:22',
      '  rules:',
      `    - if: ${mr}`,
      '  script:',
      GITLAB_INSTALL,
      `    - ${run}   # R2 tokens can't be kept to pr/: merge requests test without pushing`,
    ].join('\n');
    return {
      ci: 'gitlab',
      provider,
      file: '.gitlab-ci.yml',
      text,
      oidc: false,
      pullRequests: 'no-push',
      notes: ["R2 has no OIDC: add R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY as masked, protected CI/CD variables, which only protected branches get. R2 tokens can't be kept to a folder, so merge requests run the tests without pushing.", ...keysNote('gitlab', o)],
    };
  }
  // An ID token per job, exchanged by Shadowlap itself (web identity, federation); a merge request's
  // pipeline swaps in its own role, service account or application.
  const audience = 'https://iam.googleapis.com/projects/<project-number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>';
  const blocks: Record<Exclude<Provider, 'r2'>, { token: string[]; vars: string[]; prVar: string; script: string[]; trust: string }> = {
    s3: {
      token: ['    AWS_ID_TOKEN:', '      aud: sts.amazonaws.com'],
      vars: ['    AWS_ROLE_ARN: arn:aws:iam::<account-id>:role/shadowlap-ci', `    AWS_REGION: ${region}`],
      prVar: 'AWS_ROLE_ARN: arn:aws:iam::<account-id>:role/shadowlap-ci-pr',
      script: ['echo "$AWS_ID_TOKEN" > /tmp/aws-web-identity-token', 'export AWS_WEB_IDENTITY_TOKEN_FILE=/tmp/aws-web-identity-token'],
      trust: 'Create two roles that trust your GitLab instance as an OIDC provider: shadowlap-ci for project_path:<group>/<project>:ref_type:branch:ref:main only, with the first policy from shadowlap store policy --provider s3, and shadowlap-ci-pr for project_path:<group>/<project>:*, with the second.',
    },
    gcs: {
      token: ['    GCP_ID_TOKEN:', `      aud: ${audience}`],
      vars: ['    GCP_SERVICE_ACCOUNT: shadowlap-ci@<project>.iam.gserviceaccount.com'],
      prVar: 'GCP_SERVICE_ACCOUNT: shadowlap-ci-pr@<project>.iam.gserviceaccount.com',
      script: [
        'echo "$GCP_ID_TOKEN" > /tmp/gcp-id-token',
        `printf '{"type":"external_account","audience":"//iam.googleapis.com/projects/<project-number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>","subject_token_type":"urn:ietf:params:oauth:token-type:jwt","token_url":"https://sts.googleapis.com/v1/token","credential_source":{"file":"/tmp/gcp-id-token"},"service_account_impersonation_url":"https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/%s:generateAccessToken"}' "$GCP_SERVICE_ACCOUNT" > /tmp/gcp-credentials.json`,
        'export GOOGLE_APPLICATION_CREDENTIALS=/tmp/gcp-credentials.json',
      ],
      trust: "Create a workload identity pool and provider for your GitLab instance. Let the default branch's tokens impersonate shadowlap-ci, bound with the first policy from shadowlap store policy --provider gcs, and the project's other tokens impersonate shadowlap-ci-pr, bound with the second.",
    },
    azure: {
      token: ['    AZURE_ID_TOKEN:', '      aud: api://AzureADTokenExchange'],
      vars: ['    AZURE_CLIENT_ID: <application client id>', '    AZURE_TENANT_ID: <tenant id>'],
      prVar: 'AZURE_CLIENT_ID: <pull-request application client id>',
      script: ['echo "$AZURE_ID_TOKEN" > /tmp/azure-id-token', 'export AZURE_FEDERATED_TOKEN_FILE=/tmp/azure-id-token'],
      trust: "Add federated credentials to two app registrations: one for project_path:<group>/<project>:ref_type:branch:ref:main, given the first assignment from shadowlap store policy --provider azure, and one for merge requests' pipelines, given the second.",
    },
  };
  const b = blocks[provider];
  const text = [
    'shadowlap:',
    '  image: node:22',
    '  id_tokens:',
    ...b.token,
    '  variables:',
    ...b.vars,
    '  rules:',
    `    - if: ${mr}`,
    '      variables:',
    `        ${b.prVar}   # the merge request's own credentials: they write only under pr/ in the store`,
    `    - if: ${main}`,
    '  script:',
    GITLAB_INSTALL,
    ...[...b.script, `${run} --push`].map((l) => `    - ${l}`),
  ].join('\n');
  return {
    ci: 'gitlab',
    provider,
    file: '.gitlab-ci.yml',
    text,
    oidc: true,
    pullRequests: 'own-folder',
    notes: [`${b.trust} That trust, not this file, keeps a merge request from the first credentials: a merge request can change the pipeline.`, ownFolderNote('merge request'), ...keysNote('gitlab', o)],
  };
}

function other(loc: StoreLocation, run: string, o: CiStepKeys): CiStep {
  const provider = loc.provider;
  const env: Record<Provider, string> = {
    s3: 'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or AWS_ROLE_ARN and AWS_WEB_IDENTITY_TOKEN_FILE for a web identity',
    gcs: 'GOOGLE_APPLICATION_CREDENTIALS (a workload identity or service-account file), or GOOGLE_OAUTH_ACCESS_TOKEN',
    azure: 'AZURE_CLIENT_ID and AZURE_TENANT_ID with AZURE_FEDERATED_TOKEN_FILE or AZURE_CLIENT_SECRET, or AZURE_STORAGE_KEY',
    r2: 'R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY',
  };
  const head = ['# any CI. On protected branches, with credentials for the first policy shadowlap store policy prints:', `# ${env[provider]}`, `${run} --push`];
  if (provider === 'r2') {
    return {
      ci: 'other',
      provider,
      file: 'your CI configuration',
      text: [...head, "# In a pull request's build, without the token (R2 tokens can't be kept to a folder):", run].join('\n'),
      oidc: false,
      pullRequests: 'no-push',
      notes: keysNote('other', o),
    };
  }
  return {
    ci: 'other',
    provider,
    file: 'your CI configuration',
    text: [...head, "# In a pull request's build, with credentials for the second policy, and the pull request's number:", `SHADOWLAP_PR=<number> ${run} --push`].join('\n'),
    oidc: false,
    pullRequests: 'own-folder',
    notes: ["Shadowlap recognises pull requests on GitHub Actions and GitLab CI by their own variables; on any other CI, SHADOWLAP_PR names the pull request, and its runs go to pr/<number>/ in the store.", ...keysNote('other', o)],
  };
}

/**
 * The CI step for a store, its tests run by the CLI at `version` (the release the caller is at, as
 * the GitHub Action's step pins it), on the packs given (`goldens/*`), with the keys the goldens
 * that run live need (`keys`, `keysUnknown`): in the env of the GitHub steps that run the tests, and
 * in a note on where each CI keeps them.
 */
export function ciStep(ci: CiProvider, loc: StoreLocation, o: { version: string; packs?: string } & CiStepKeys): CiStep {
  const run = `npx shadowlap@${o.version} test ${o.packs ?? 'goldens/*'}`;
  if (ci === 'github') return github(loc, run, o);
  if (ci === 'gitlab') return gitlab(loc, run, o);
  return other(loc, run, o);
}
