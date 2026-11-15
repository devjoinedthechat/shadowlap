import { PR_FOLDER } from './pr.js';
import { PROVIDER_NAMES, type Provider, type StoreLocation } from './url.js';

/**
 * `shadowlap store policy`: the access to ask the cloud admin for. shadowlap has no accounts: who
 * can use the store is whoever the admin gives access to, so that access is the store's security.
 * There are two policies. People, and CI on protected branches, list, read, write and delete under
 * the store's folder. Pull requests' CI jobs run whatever the pull request says, so their own
 * credentials read the store and write only under pr/ (see pr.ts), or nothing at all where a token
 * can't be kept to a folder (R2): a pull request can't change the runs the team pulls.
 */

export interface PolicyPart {
  /** Who it is for, in words. */
  for: string;
  /** What it is: an IAM policy, role bindings, a role assignment, token scopes. */
  kind: string;
  /** The policy or the commands to hand over, ready to copy. */
  text: string;
  /** What else to know about this one. */
  notes: string[];
}

export interface AccessPolicy {
  provider: Provider;
  /** People, and CI on protected branches: everything push, pull, share and store check need. */
  writer: PolicyPart;
  /** Pull requests' CI jobs: read the store, and write only under pr/. */
  pullRequest: PolicyPart;
  /** What to know about both. */
  notes: string[];
}

const WRITER_FOR = 'people, and CI on protected branches';
const PR_FOR = "pull requests' CI jobs";

function folder(loc: StoreLocation | null): string {
  return loc?.prefix ? `${loc.prefix}/` : '';
}

/** Share reports outlive their links unless a rule removes them; nothing else in the store may expire. */
function sharesNote(loc: StoreLocation | null): string {
  return `Share reports stay in ${folder(loc)}shares/ after their links expire. A lifecycle rule that deletes objects under that prefix 7 days after they are written removes them; keep any such rule to shares/ and ${PR_FOLDER}/, since blobs are shared between runs.`;
}

/** Where pull requests' runs go, and how to keep that small. */
function pullRequestsNote(loc: StoreLocation | null): string {
  return `A pull request's job writes under ${folder(loc)}${PR_FOLDER}/<number>/, which a pull leaves out unless asked (--include-pr). A lifecycle rule may delete objects under ${folder(loc)}${PR_FOLDER}/ a few weeks after they are written.`;
}

/** What keeps a pull request to its own credentials: CI hands them out by event, and the cloud trusts accordingly. */
const TRUST_NOTE = "Give these credentials to pull requests' jobs only, and the first policy only to branches a pull request can't push to: shadowlap store ci prints the step, and what the cloud should trust.";

export function accessPolicy(provider: Provider, loc: StoreLocation | null): AccessPolicy {
  const own = loc && loc.provider === provider ? loc : null;
  const f = folder(own);
  switch (provider) {
    case 's3': {
      const bucket = own?.bucket ?? 'your-bucket';
      const list = { Sid: 'ShadowlapList', Effect: 'Allow', Action: ['s3:ListBucket'], Resource: `arn:aws:s3:::${bucket}`, ...(f ? { Condition: { StringLike: { 's3:prefix': [`${f}*`] } } } : {}) };
      const writer = {
        Version: '2012-10-17',
        Statement: [
          list,
          { Sid: 'ShadowlapObjects', Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'], Resource: `arn:aws:s3:::${bucket}/${f}*` },
          { Sid: 'ShadowlapCheck', Effect: 'Allow', Action: ['s3:GetBucketVersioning', 's3:GetBucketObjectLockConfiguration', 's3:GetEncryptionConfiguration'], Resource: `arn:aws:s3:::${bucket}` },
        ],
      };
      const pullRequest = {
        Version: '2012-10-17',
        Statement: [
          list,
          { Sid: 'ShadowlapRead', Effect: 'Allow', Action: ['s3:GetObject'], Resource: `arn:aws:s3:::${bucket}/${f}*` },
          { Sid: 'ShadowlapPullRequests', Effect: 'Allow', Action: ['s3:PutObject', 's3:DeleteObject'], Resource: `arn:aws:s3:::${bucket}/${f}${PR_FOLDER}/*` },
        ],
      };
      return {
        provider,
        writer: {
          for: WRITER_FOR,
          kind: 'an IAM policy',
          text: JSON.stringify(writer, null, 2),
          notes: ['The third statement only lets shadowlap store check report versioning, object lock and encryption; push and pull work without it.'],
        },
        pullRequest: {
          for: PR_FOR,
          kind: `an IAM policy that reads the store and writes only under ${f}${PR_FOLDER}/`,
          text: JSON.stringify(pullRequest, null, 2),
          notes: ["Without the last statement it is read-only: a pull request's push then fails with a warning, and its tests still decide the job.", TRUST_NOTE],
        },
        notes: [
          'A bucket encrypted with a customer-managed KMS key also needs kms:Decrypt and kms:GenerateDataKey on that key.',
          ...(own?.endpoint ? ['For an S3-compatible store, grant the same actions in its own policy language.'] : []),
          pullRequestsNote(own),
          sharesNote(own),
        ],
      };
    }
    case 'gcs': {
      const bucket = own?.bucket ?? 'your-bucket';
      const binding = (member: string, role: string, condition: string | null) =>
        `gcloud storage buckets add-iam-policy-binding gs://${bucket} \\\n  --member=${member} \\\n  --role=${role}${condition ? ` \\\n  --condition-from-file=${condition}` : ''}`;
      const conditionFile = (file: string, title: string, description: string, expression: string[]) =>
        [`cat > ${file} <<'EOF'`, `title: ${title}`, `description: ${description}`, 'expression: >-', ...expression.map((l) => `  ${l}`), 'EOF'].join('\n');
      // Listing is checked against the bucket, not an object, so the folder condition names the
      // prefix a listing asks for as well as the objects under it.
      const storeCondition = f
        ? conditionFile('shadowlap-store-condition.yaml', 'shadowlap-store', `Objects under ${f} only`, [
            `resource.name.startsWith("projects/_/buckets/${bucket}/objects/${f}") ||`,
            `api.getAttribute("storage.googleapis.com/objectListPrefix", "").startsWith("${f}")`,
          ])
        : null;
      // Writing is checked against the object written: this condition names the objects under pr/.
      const prCondition = conditionFile('shadowlap-pull-requests-condition.yaml', 'shadowlap-pull-requests', `Objects under ${f}${PR_FOLDER}/ only`, [`resource.name.startsWith("projects/_/buckets/${bucket}/objects/${f}${PR_FOLDER}/")`]);
      const store = storeCondition ? 'shadowlap-store-condition.yaml' : null;
      const pr = 'serviceAccount:shadowlap-ci-pr@your-project.iam.gserviceaccount.com';
      return {
        provider,
        writer: {
          for: WRITER_FOR,
          kind: f ? "a role binding on the bucket, limited to the store's folder" : 'a role binding on the bucket',
          text: [storeCondition, binding('group:your-team@example.com', 'roles/storage.objectUser', store)].filter(Boolean).join('\n'),
          notes: [
            'Bind the service account CI uses on protected branches the same way.',
            "shadowlap store check reads the bucket's versioning and soft delete with storage.buckets.get; without it, they show as unknown.",
            'Share links are signed with a key: a service account\'s key, or HMAC keys used through gs://…?auth=hmac.',
          ],
        },
        pullRequest: {
          for: PR_FOR,
          kind: `two role bindings for the pull-request service account: read the store, and write only under ${f}${PR_FOLDER}/`,
          text: [storeCondition, binding(pr, 'roles/storage.objectViewer', store), prCondition, binding(pr, 'roles/storage.objectUser', 'shadowlap-pull-requests-condition.yaml')].filter(Boolean).join('\n'),
          notes: ["Without the second binding it is read-only: a pull request's push then fails with a warning, and its tests still decide the job.", TRUST_NOTE],
        },
        notes: [
          `A condition needs uniform bucket-level access on the bucket.${f ? ' For a bucket that holds only the store, the folder condition can be left out.' : ''}`,
          pullRequestsNote(own),
          sharesNote(own),
        ],
      };
    }
    case 'azure': {
      const account = own?.account ?? '<storage account>';
      const container = own?.bucket ?? '<container>';
      const scope = `$(az storage account show --name ${account} --query id -o tsv)`;
      const onContainer = `${scope}/blobServices/default/containers/${container}`;
      const assign = (assignee: string, role: string, at: string, condition: string | null) =>
        `az role assignment create \\\n  --assignee ${assignee} \\\n  --role "${role}" \\\n  --scope "${at}"${condition ? ` \\\n  --condition-version "2.0" \\\n  --condition "$(cat ${condition})"` : ''}`;
      const blobs = 'Microsoft.Storage/storageAccounts/blobServices/containers/blobs';
      // An Azure ABAC condition: writing, adding to, moving and deleting blobs only under pr/.
      const condition = [
        "cat > shadowlap-pull-requests-condition.txt <<'EOF'",
        '(',
        ' (',
        `  !(ActionMatches{'${blobs}/write'})`,
        '  AND',
        `  !(ActionMatches{'${blobs}/add/action'})`,
        '  AND',
        `  !(ActionMatches{'${blobs}/move/action'})`,
        '  AND',
        `  !(ActionMatches{'${blobs}/delete'})`,
        ' )',
        ' OR',
        ' (',
        `  @Resource[${blobs}:path] StringLike '${f}${PR_FOLDER}/*'`,
        ' )',
        ')',
        'EOF',
      ].join('\n');
      const team = "<your team's group or principal id>";
      return {
        provider,
        writer: {
          for: WRITER_FOR,
          kind: 'two role assignments: data access on the container, share links on the storage account',
          text: [assign(team, 'Storage Blob Data Contributor', onContainer, null), assign(team, 'Storage Blob Delegator', scope, null)].join('\n'),
          notes: [
            'The first lets push, pull and store check list, read, write and delete blobs in the container, and nothing else in the account. Give it to the principal CI uses on protected branches too.',
            "The second only lets shadowlap share get a user delegation key, which Azure grants per storage account, never per container; the link it signs still reads only what the first allows. Leave it out if the team doesn't share links from an Entra sign-in.",
            "With an account key (AZURE_STORAGE_KEY) no role is needed, but the key opens the whole account: keep it away from pull requests' jobs.",
          ],
        },
        pullRequest: {
          for: PR_FOR,
          kind: `a role assignment with a condition: read the container, and write only under ${f}${PR_FOLDER}/`,
          text: [condition, assign('<the pull-request principal id>', 'Storage Blob Data Contributor', onContainer, 'shadowlap-pull-requests-condition.txt')].join('\n'),
          notes: ["Storage Blob Data Reader instead, without the condition, makes it read-only: a pull request's push then fails with a warning, and its tests still decide the job.", TRUST_NOTE],
        },
        notes: [pullRequestsNote(own), sharesNote(own)],
      };
    }
    case 'r2': {
      const bucket = own?.bucket ?? 'your-bucket';
      const token = (permissions: string) => `Cloudflare dashboard → R2 → Manage API tokens → Create API token\nPermissions: ${permissions}\nApply to specific buckets only: ${bucket}`;
      return {
        provider,
        writer: {
          for: WRITER_FOR,
          kind: 'an R2 API token',
          text: token('Object Read & Write'),
          notes: ["Set the token's keys as R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY, on each machine and in CI on protected branches."],
        },
        pullRequest: {
          for: PR_FOR,
          kind: 'a read-only R2 API token, if they need one at all',
          text: token('Object Read only'),
          notes: ["An R2 token can't be kept to a folder, so pull requests' jobs never get one that writes: they run the tests without --push (shadowlap store ci prints that step).", TRUST_NOTE],
        },
        notes: [sharesNote(own)],
      };
    }
  }
}

/**
 * What `shadowlap store policy` prints, line by line, ready to hand over: the policy for people and
 * protected branches, then the one for pull requests, each under a `#` line saying who it is for
 * with its notes after it, and the notes on both last. `comment`: a `#` line. Settings → Store's
 * Copy access policy copies the same lines, so the copy and the command say the same.
 */
export function policyLines(policy: AccessPolicy): Array<{ text: string; comment: boolean }> {
  const out = [{ text: `# ${policyTitle(policy.provider)}: one policy for people and protected branches, one for pull requests`, comment: true }];
  for (const [i, part] of [policy.writer, policy.pullRequest].entries()) {
    out.push({ text: `#\n# ${i + 1}. For ${part.for}: ${part.kind}`, comment: true }, { text: part.text, comment: false });
    for (const n of part.notes) out.push({ text: `# ${n}`, comment: true });
  }
  if (policy.notes.length) out.push({ text: '#', comment: true });
  for (const n of policy.notes) out.push({ text: `# ${n}`, comment: true });
  return out;
}

export function policyTitle(provider: Provider): string {
  return `The access to ask your cloud admin for (${PROVIDER_NAMES[provider]})`;
}
