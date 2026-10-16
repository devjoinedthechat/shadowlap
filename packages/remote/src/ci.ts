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
 * could only fail on, and push, finding no credentials, warns while the tests decide the job.
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
}

/** Where a pull (or merge) request's job pushes, in the CI's own words. */
function ownFolderNote(request: 'pull request' | 'merge request'): string {
  return `A ${request}'s job pushes its runs to pr/<number>/ in the store, which Shadowlap finds from the CI's own variables; a teammate's pull brings them only with --include-pr.`;
}

function github(loc: StoreLocation, run: string): CiStep {
  const provider = loc.provider;
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
      '  - uses: actions/checkout@v7',
      `  - if: ${writerIf}`,
      `    run: ${run} --push`,
      '    env:',
      '      R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}',
      '      R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}',
      `  - if: ${prIf}   # R2 tokens can't be kept to pr/: pull requests test without pushing`,
      `    run: ${run}`,
    ].join('\n');
    return {
      ci: 'github',
      provider,
      file,
      text,
      oidc: false,
      pullRequests: 'no-push',
      notes: [
        "R2 has no OIDC: add an R2 API token's keys as secrets. R2 tokens can't be kept to a folder, so pull requests run the tests without pushing; to keep a pull request's workflow from reading the keys at all, move the push step to a job of its own with an environment only protected branches can use.",
      ],
    };
  }
  // The credentials step twice: the writer's for everything but pull requests, the pull request's for them.
  const auth: Record<Exclude<Provider, 'r2'>, (pr: boolean) => string[]> = {
    s3: (pr) => ['    uses: aws-actions/configure-aws-credentials@v4', '    with:', `      role-to-assume: arn:aws:iam::<account-id>:role/shadowlap-ci${pr ? '-pr' : ''}`, `      aws-region: ${region}`],
    gcs: (pr) => [
      '    uses: google-github-actions/auth@v2',
      '    with:',
      '      workload_identity_provider: projects/<project-number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>',
      `      service_account: shadowlap-ci${pr ? '-pr' : ''}@<project>.iam.gserviceaccount.com`,
    ],
    azure: (pr) => ['    uses: azure/login@v2', '    with:', `      client-id: \${{ vars.${pr ? 'AZURE_PR_CLIENT_ID' : 'AZURE_CLIENT_ID'} }}`, '      tenant-id: ${{ vars.AZURE_TENANT_ID }}', '      subscription-id: ${{ vars.AZURE_SUBSCRIPTION_ID }}'],
  };
  const text = [
    'permissions:',
    '  id-token: write   # the job gets short-lived cloud credentials; no stored keys',
    '  contents: read',
    '',
    'steps:',
    '  - uses: actions/checkout@v7',
    `  - if: ${writerIf}`,
    ...auth[provider](false),
    "  # a pull request's own credentials, which write only under pr/; a fork's job gets none",
    `  - if: ${ownPrIf}`,
    ...auth[provider](true),
    `  - run: ${run} --push`,
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
    oidc: true,
    pullRequests: 'own-folder',
    notes: [
      `${trust[provider]} That trust, not this file, keeps a pull request from the first credentials: a pull request can change the workflow.`,
      ownFolderNote('pull request'),
      "A pull request from a fork gets no OIDC token from GitHub, so its job skips the credentials and runs the tests without pushing; push says so in a warning.",
    ],
  };
}

function gitlab(loc: StoreLocation, run: string): CiStep {
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
      `    - ${run} --push`,
      'shadowlap-merge-request:',
      '  image: node:22',
      '  rules:',
      `    - if: ${mr}`,
      '  script:',
      `    - ${run}   # R2 tokens can't be kept to pr/: merge requests test without pushing`,
    ].join('\n');
    return {
      ci: 'gitlab',
      provider,
      file: '.gitlab-ci.yml',
      text,
      oidc: false,
      pullRequests: 'no-push',
      notes: ["R2 has no OIDC: add R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY as masked, protected CI/CD variables, which only protected branches get. R2 tokens can't be kept to a folder, so merge requests run the tests without pushing."],
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
    ...[...b.script, `${run} --push`].map((l) => `    - ${l}`),
  ].join('\n');
  return {
    ci: 'gitlab',
    provider,
    file: '.gitlab-ci.yml',
    text,
    oidc: true,
    pullRequests: 'own-folder',
    notes: [`${b.trust} That trust, not this file, keeps a merge request from the first credentials: a merge request can change the pipeline.`, ownFolderNote('merge request')],
  };
}

function other(loc: StoreLocation, run: string): CiStep {
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
      notes: [],
    };
  }
  return {
    ci: 'other',
    provider,
    file: 'your CI configuration',
    text: [...head, "# In a pull request's build, with credentials for the second policy, and the pull request's number:", `SHADOWLAP_PR=<number> ${run} --push`].join('\n'),
    oidc: false,
    pullRequests: 'own-folder',
    notes: ["Shadowlap recognises pull requests on GitHub Actions and GitLab CI by their own variables; on any other CI, SHADOWLAP_PR names the pull request, and its runs go to pr/<number>/ in the store."],
  };
}

export function ciStep(ci: CiProvider, loc: StoreLocation, packs = 'goldens/*'): CiStep {
  const run = `npx shadowlap test ${packs}`;
  if (ci === 'github') return github(loc, run);
  if (ci === 'gitlab') return gitlab(loc, run);
  return other(loc, run);
}
