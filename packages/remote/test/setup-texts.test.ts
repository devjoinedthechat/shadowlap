import { describe, expect, it } from 'vitest';
import { accessPolicy, ciStep, formatStoreUrl, HttpError, objectKey, objectLockHint, parseStoreUrl, pullRequestLocation, schemeHint, shortStoreName, storeKey, StoreUrlError, credentialsMayGoTo, transportError, versioningHint } from '@shadowlap/remote';

/**
 * What store setup reads and prints: store URLs checked against each provider's scheme, the access
 * to ask a cloud admin for, and the CI step, with short-lived credentials wherever the CI and the
 * cloud allow them.
 */

describe('store URLs', () => {
  it('reads each provider, with the folder and settings the name cannot say', () => {
    expect(parseStoreUrl('s3://northwind-agent-runs/support-agent?region=eu-central-1&profile=northwind')).toMatchObject({
      provider: 's3',
      url: 's3://northwind-agent-runs/support-agent',
      bucket: 'northwind-agent-runs',
      prefix: 'support-agent',
      region: 'eu-central-1',
      profile: 'northwind',
    });
    expect(parseStoreUrl('gs://northwind-agent-runs/a/b/')).toMatchObject({ provider: 'gcs', bucket: 'northwind-agent-runs', prefix: 'a/b', url: 'gs://northwind-agent-runs/a/b' });
    expect(parseStoreUrl('az://northwindruns/agent-runs/support-agent')).toMatchObject({ provider: 'azure', account: 'northwindruns', bucket: 'agent-runs', prefix: 'support-agent' });
    expect(parseStoreUrl('r2://0123456789abcdef/agent-runs')).toMatchObject({ provider: 'r2', account: '0123456789abcdef', bucket: 'agent-runs', prefix: '' });
    expect(parseStoreUrl('s3://Runs_On_Minio/x?endpoint=http://minio.internal:9000')).toMatchObject({ bucket: 'Runs_On_Minio', endpoint: 'http://minio.internal:9000' });
    expect(parseStoreUrl('gs://agent-runs?auth=hmac').auth).toBe('hmac');
  });

  it("checks a URL against the provider picked, with the mock's words", () => {
    expect(() => parseStoreUrl('gs://agent-runs', 's3')).toThrow('An Amazon S3 store starts with s3://, then the bucket and, if you like, a folder: s3://my-bucket/agent-runs.');
    expect(schemeHint('azure')).toBe('An Azure Blob store starts with az://, then the storage account, the container and, if you like, a folder: az://myaccount/agent-runs.');
    expect(schemeHint('gcs')).toMatch(/^A Google Cloud store starts with gs:\/\//);
    expect(schemeHint('r2')).toMatch(/^A Cloudflare R2 store starts with r2:\/\//);
  });

  it('refuses what is not a store, and credentials in the URL', () => {
    const bad = [
      'https://bucket/x',
      's3://',
      's3://UPPER',
      's3://ab',
      's3://192.168.1.1',
      's3://b..c',
      's3://bucket/../x',
      's3://bucket/x?colour=blue',
      'gs://bucket?region=eu',
      's3://bucket?endpoint=http://user:pw@minio:9000',
      's3://bucket?endpoint=ftp://minio',
      'az://Bad_Account/c',
      'az://acct/x--y',
      'r2://acct',
      's3://bucket?path-style=maybe',
    ];
    for (const raw of bad) expect(() => parseStoreUrl(raw), raw).toThrow(StoreUrlError);
  });

  it('writes the URL back with its settings, and names it for a status line', () => {
    const loc = parseStoreUrl('s3://northwind-agent-runs/support-agent?profile=p&region=eu-central-1');
    expect(formatStoreUrl(loc)).toBe('s3://northwind-agent-runs/support-agent?region=eu-central-1&profile=p');
    expect(shortStoreName(loc)).toBe('northwind-agent-runs/support-agent');
    expect(shortStoreName(parseStoreUrl('az://northwindruns/agent-runs/x'))).toBe('northwindruns/agent-runs/x');
    expect(objectKey(loc, 'runs/x/run.json')).toBe('support-agent/runs/x/run.json');
    expect(objectKey(parseStoreUrl('s3://bucket-at-root'), 'index/x.json')).toBe('index/x.json');
  });

  it('keys what this machine knows of a store on the bucket and folder, and on the server an endpoint names', () => {
    const plain = 's3://northwind-agent-runs/support-agent';
    // Another region, profile or way of signing in reaches the same bucket.
    for (const raw of [plain, `${plain}?region=eu-central-1`, `${plain}?profile=ci`, `${plain}/`]) expect(storeKey(parseStoreUrl(raw)), raw).toBe(plain);
    // Another server is another store, however the endpoint is written.
    const minio = storeKey(parseStoreUrl(`${plain}?endpoint=http://MinIO.internal:9000/&region=us-east-1`));
    expect(minio).toBe(`${plain}?endpoint=http://minio.internal:9000`);
    expect(storeKey(parseStoreUrl(`${plain}?endpoint=http://ceph.internal`))).not.toBe(minio);
    // A pull request's folder is a store of its own, on the same server.
    expect(storeKey(pullRequestLocation(parseStoreUrl(`${plain}?endpoint=http://minio.internal:9000`), '42'))).toBe(`${plain}/pr/42?endpoint=http://minio.internal:9000`);
  });
});

describe('the access to ask the cloud admin for', () => {
  type Statement = { Sid: string; Action: string[]; Resource: string; Condition?: unknown };
  const statements = (text: string) => (JSON.parse(text) as { Statement: Statement[] }).Statement;

  it('scopes an IAM policy for people and protected branches to the store folder', () => {
    const p = accessPolicy('s3', parseStoreUrl('s3://northwind-agent-runs/support-agent'));
    const doc = statements(p.writer.text);
    expect(doc.map((s) => [s.Action.join(','), s.Resource])).toEqual([
      ['s3:ListBucket', 'arn:aws:s3:::northwind-agent-runs'],
      ['s3:GetObject,s3:PutObject,s3:DeleteObject', 'arn:aws:s3:::northwind-agent-runs/support-agent/*'],
      ['s3:GetBucketVersioning,s3:GetBucketObjectLockConfiguration,s3:GetEncryptionConfiguration', 'arn:aws:s3:::northwind-agent-runs'],
    ]);
    // Listing too is kept to the folder; a store at the bucket's root lists the bucket.
    expect(doc[0]!.Condition).toEqual({ StringLike: { 's3:prefix': ['support-agent/*'] } });
    expect(statements(accessPolicy('s3', parseStoreUrl('s3://northwind-agent-runs')).writer.text)[0]!.Condition).toBeUndefined();
    expect(p.writer.for).toBe('people, and CI on protected branches');
  });

  it("gives pull requests' jobs an IAM policy that reads the store and writes only under pr/", () => {
    const p = accessPolicy('s3', parseStoreUrl('s3://northwind-agent-runs/support-agent'));
    expect(p.pullRequest.for).toBe("pull requests' CI jobs");
    const doc = statements(p.pullRequest.text);
    expect(doc.map((s) => [s.Action.join(','), s.Resource])).toEqual([
      ['s3:ListBucket', 'arn:aws:s3:::northwind-agent-runs'],
      ['s3:GetObject', 'arn:aws:s3:::northwind-agent-runs/support-agent/*'],
      ['s3:PutObject,s3:DeleteObject', 'arn:aws:s3:::northwind-agent-runs/support-agent/pr/*'],
    ]);
    // Nothing it may write is outside pr/: not a run, a blob, the index or a share.
    for (const s of doc) if (s.Action.some((a) => a !== 's3:ListBucket' && a !== 's3:GetObject')) expect(s.Resource).toMatch(/\/support-agent\/pr\/\*$/);
    expect(p.pullRequest.notes.join(' ')).toMatch(/Without the last statement it is read-only/);
    // At the bucket's root, pr/ is at the root too.
    expect(statements(accessPolicy('s3', parseStoreUrl('s3://northwind-agent-runs')).pullRequest.text)[2]!.Resource).toBe('arn:aws:s3:::northwind-agent-runs/pr/*');
  });

  it('suggests an expiry rule for share reports and pull requests only, on every cloud', () => {
    for (const url of ['s3://northwind-agent-runs/support-agent', 'gs://northwind-agent-runs/support-agent', 'az://northwindruns/agent-runs/support-agent', 'r2://acct/agent-runs/support-agent']) {
      const loc = parseStoreUrl(url);
      const notes = accessPolicy(loc.provider, loc).notes.join(' ');
      expect(notes).toMatch(/support-agent\/shares\/ after their links expire\. A lifecycle rule .* 7 days after .*keep any such rule to shares\/ and pr\//);
    }
  });

  it('gives a role binding, a role assignment and R2 token scopes', () => {
    expect(accessPolicy('gcs', parseStoreUrl('gs://northwind-agent-runs/support-agent')).writer.text).toContain('--role=roles/storage.objectUser');
    expect(accessPolicy('gcs', parseStoreUrl('gs://northwind-agent-runs/support-agent')).writer.text).toContain('objects/support-agent/');
    expect(accessPolicy('azure', parseStoreUrl('az://northwindruns/agent-runs')).writer.text).toContain('--role "Storage Blob Data Contributor"');
    expect(accessPolicy('azure', parseStoreUrl('az://northwindruns/agent-runs')).writer.text).toContain('/containers/agent-runs');
    expect(accessPolicy('r2', parseStoreUrl('r2://acct/agent-runs')).writer.text).toContain('Permissions: Object Read & Write');
    // Asked for another cloud than the store's: placeholders, not the store's names.
    expect(accessPolicy('gcs', parseStoreUrl('s3://northwind-agent-runs')).writer.text).toContain('gs://your-bucket');
  });

  it('keeps a Cloud Storage binding to the folder, listing included', () => {
    const p = accessPolicy('gcs', parseStoreUrl('gs://northwind-agent-runs/support-agent'));
    // Listing is checked against the bucket: the condition names the prefix a listing asks for.
    expect(p.writer.text).toContain('resource.name.startsWith("projects/_/buckets/northwind-agent-runs/objects/support-agent/") ||');
    expect(p.writer.text).toContain('api.getAttribute("storage.googleapis.com/objectListPrefix", "").startsWith("support-agent/")');
    expect(p.writer.text).toContain('--condition-from-file=shadowlap-store-condition.yaml');
    expect(p.notes.join(' ')).toMatch(/uniform bucket-level access/);
    // A store at the bucket's root needs no condition.
    expect(accessPolicy('gcs', parseStoreUrl('gs://northwind-agent-runs')).writer.text).not.toContain('condition');
  });

  it("lets a pull request's service account read the store, and write objects only under pr/ on Cloud Storage", () => {
    const p = accessPolicy('gcs', parseStoreUrl('gs://northwind-agent-runs/support-agent'));
    const bindings = p.pullRequest.text.split(/\n(?=gcloud storage buckets add-iam-policy-binding)/);
    const viewer = bindings.find((b) => b.includes('--role=roles/storage.objectViewer'))!;
    const writer = p.pullRequest.text.slice(p.pullRequest.text.indexOf("cat > shadowlap-pull-requests-condition.yaml"));
    expect(viewer).toContain('--member=serviceAccount:shadowlap-ci-pr@your-project.iam.gserviceaccount.com');
    expect(viewer).toContain('--condition-from-file=shadowlap-store-condition.yaml');
    expect(writer).toContain('resource.name.startsWith("projects/_/buckets/northwind-agent-runs/objects/support-agent/pr/")');
    expect(writer).toContain('--role=roles/storage.objectUser');
    expect(writer).toContain('--condition-from-file=shadowlap-pull-requests-condition.yaml');
    // The only binding that writes is the one kept to pr/.
    expect(p.pullRequest.text.match(/--role=roles\/storage\.objectUser/g)).toHaveLength(1);
  });

  it('gives Azure the delegation role share links need on the storage account, and data access on the container only', () => {
    const p = accessPolicy('azure', parseStoreUrl('az://northwindruns/agent-runs/support-agent'));
    const [data, delegate] = p.writer.text.split(/\n(?=az role assignment create)/);
    expect(data).toContain('--role "Storage Blob Data Contributor"');
    expect(data).toContain('/blobServices/default/containers/agent-runs"');
    expect(delegate).toContain('--role "Storage Blob Delegator"');
    expect(delegate).toContain('--scope "$(az storage account show --name northwindruns --query id -o tsv)"');
    expect(delegate).not.toContain('containers');
  });

  it("keeps a pull request's Azure principal to writing under pr/ with a condition on the blob path", () => {
    const p = accessPolicy('azure', parseStoreUrl('az://northwindruns/agent-runs/support-agent'));
    const text = p.pullRequest.text;
    for (const action of ['write', 'add/action', 'move/action', 'delete']) expect(text).toContain(`!(ActionMatches{'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/${action}'})`);
    expect(text).toContain("@Resource[Microsoft.Storage/storageAccounts/blobServices/containers/blobs:path] StringLike 'support-agent/pr/*'");
    expect(text).toContain('--condition-version "2.0"');
    expect(text).toContain('--condition "$(cat shadowlap-pull-requests-condition.txt)"');
    expect(text).toContain('/blobServices/default/containers/agent-runs"');
    expect(text).not.toContain('Storage Blob Delegator');
  });

  it('gives pull requests a read-only R2 token, since an R2 token cannot be kept to a folder', () => {
    const p = accessPolicy('r2', parseStoreUrl('r2://acct/agent-runs'));
    expect(p.pullRequest.text).toContain('Permissions: Object Read only');
    expect(p.pullRequest.notes.join(' ')).toMatch(/run the tests without --push/);
  });

  it('says how to turn versioning and an object lock on, per provider', () => {
    expect(versioningHint(parseStoreUrl('s3://b-1'))).toContain('aws s3api put-bucket-versioning --bucket b-1');
    expect(versioningHint(parseStoreUrl('r2://a/b-1'))).toMatch(/R2 keeps no versions/);
    expect(objectLockHint(parseStoreUrl('s3://b-1'))).toContain(`aws s3api put-object-lock-configuration --bucket b-1 --object-lock-configuration '{"ObjectLockEnabled":"Enabled","Rule":{"DefaultRetention":{"Mode":"GOVERNANCE","Days":30}}}'`);
    expect(objectLockHint(parseStoreUrl('s3://b-1?endpoint=https://minio.internal:9000'))).toMatch(/store's own settings/);
    expect(objectLockHint(parseStoreUrl('gs://b-1'))).toContain('gcloud storage buckets update gs://b-1 --soft-delete-duration=30d');
    expect(objectLockHint(parseStoreUrl('az://acct1/b-1'))).toMatch(/version-level immutability/);
  });
});

describe('the CI step', () => {
  it('uses OIDC on GitHub Actions, with the pull-request role beside the protected branches one', () => {
    const s3 = ciStep('github', parseStoreUrl('s3://northwind-agent-runs/support-agent?region=eu-central-1'));
    expect(s3.oidc).toBe(true);
    expect(s3.pullRequests).toBe('own-folder');
    expect(s3.text).toContain('id-token: write');
    expect(s3.text).toContain('aws-region: eu-central-1');
    expect(s3.text).toContain('run: npx shadowlap test goldens/* --push');
    // Each role in its own step, chosen by the event: a pull request gets only its own.
    const steps = s3.text.split('\n  - ');
    const writer = steps.find((s) => s.includes('role/shadowlap-ci\n'))!;
    const pr = steps.find((s) => s.includes('role/shadowlap-ci-pr'))!;
    expect(writer).toMatch(/^if: \$\{\{ !startsWith\(github\.event_name, 'pull_request'\) \}\}/);
    expect(pr).toMatch(/^if: startsWith\(github\.event_name, 'pull_request'\)/);
    expect(s3.notes.join(' ')).toMatch(/shadowlap-ci for repo:<owner>\/<repo>:ref:refs\/heads\/main only.*shadowlap-ci-pr for repo:<owner>\/<repo>:pull_request/);
    expect(ciStep('github', parseStoreUrl('gs://b-1/x')).text).toContain('service_account: shadowlap-ci-pr@<project>.iam.gserviceaccount.com');
    expect(ciStep('github', parseStoreUrl('az://acct1/agent-runs')).text).toContain('client-id: ${{ vars.AZURE_PR_CLIENT_ID }}');
  });

  it('keeps R2 keys from pull requests, which run the tests without pushing', () => {
    const r2 = ciStep('github', parseStoreUrl('r2://acct/agent-runs'));
    expect(r2.oidc).toBe(false);
    expect(r2.pullRequests).toBe('no-push');
    const [writer, pr] = r2.text.split(/\n(?=  - if: startsWith)/);
    expect(writer).toContain('R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}');
    expect(writer).toContain('run: npx shadowlap test goldens/* --push');
    expect(pr).toContain('run: npx shadowlap test goldens/*');
    expect(pr).not.toContain('--push');
    expect(pr).not.toContain('secrets');
    const gitlab = ciStep('gitlab', parseStoreUrl('r2://acct/agent-runs'));
    expect(gitlab.text).toContain('shadowlap-merge-request:');
    expect(gitlab.text.slice(gitlab.text.indexOf('shadowlap-merge-request:'))).not.toContain('--push');
    expect(gitlab.notes.join(' ')).toMatch(/masked, protected CI\/CD variables/);
  });

  it("gives GitLab CI an ID token that Shadowlap's own credential chain exchanges, and a merge request its own role", () => {
    const s3 = ciStep('gitlab', parseStoreUrl('s3://northwind-agent-runs'));
    expect(s3.text).toContain('aud: sts.amazonaws.com');
    expect(s3.text).toContain('export AWS_WEB_IDENTITY_TOKEN_FILE=/tmp/aws-web-identity-token');
    expect(s3.text).toContain('    - if: $CI_PIPELINE_SOURCE == "merge_request_event"\n      variables:\n        AWS_ROLE_ARN: arn:aws:iam::<account-id>:role/shadowlap-ci-pr');
    expect(s3.text).toContain('    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH');
    expect(ciStep('gitlab', parseStoreUrl('az://acct1/agent-runs')).text).toContain('export AZURE_FEDERATED_TOKEN_FILE=/tmp/azure-id-token');
    const gcs = ciStep('gitlab', parseStoreUrl('gs://b-1'));
    expect(gcs.text).toContain('"type":"external_account"');
    expect(gcs.text).toContain('serviceAccounts/%s:generateAccessToken"}\' "$GCP_SERVICE_ACCOUNT"');
    expect(gcs.text).toContain('GCP_SERVICE_ACCOUNT: shadowlap-ci-pr@<project>.iam.gserviceaccount.com');
  });

  it('names the variables any other CI needs, the packs to test, and SHADOWLAP_PR for pull requests', () => {
    const other = ciStep('other', parseStoreUrl('gs://b-1'), 'tests/goldens/*');
    expect(other.text).toContain('GOOGLE_APPLICATION_CREDENTIALS');
    expect(other.text).toContain('\nnpx shadowlap test tests/goldens/* --push\n');
    expect(other.text).toMatch(/\nSHADOWLAP_PR=<number> npx shadowlap test tests\/goldens\/\* --push$/);
    expect(ciStep('other', parseStoreUrl('r2://acct/agent-runs')).text).toMatch(/\nnpx shadowlap test goldens\/\*$/);
  });
});

describe('where Google or Azure credentials may go', () => {
  it("is the cloud's own addresses over https, or this machine", () => {
    expect(credentialsMayGoTo('https://storage.googleapis.com', 'gcs')).toBe(true);
    expect(credentialsMayGoTo('https://storage-psc.p.googleapis.com', 'gcs')).toBe(true);
    expect(credentialsMayGoTo('http://storage.googleapis.com', 'gcs')).toBe(false);
    expect(credentialsMayGoTo('https://storage.googleapis.com.evil.example', 'gcs')).toBe(false);
    expect(credentialsMayGoTo('https://evil.example', 'gcs')).toBe(false);
    expect(credentialsMayGoTo('http://127.0.0.1:4443', 'gcs')).toBe(true);
    expect(credentialsMayGoTo('http://localhost:10000/devstoreaccount1', 'azure')).toBe(true);
    expect(credentialsMayGoTo('http://[::1]:10000/devstoreaccount1', 'azure')).toBe(true);
    expect(credentialsMayGoTo('https://northwindruns.blob.core.windows.net', 'azure')).toBe(true);
    expect(credentialsMayGoTo('https://northwindruns.privatelink.blob.core.windows.net', 'azure')).toBe(true);
    expect(credentialsMayGoTo('https://northwindruns.blob.core.chinacloudapi.cn', 'azure')).toBe(true);
    expect(credentialsMayGoTo('https://northwindruns.z12.blob.storage.azure.net', 'azure')).toBe(true);
    expect(credentialsMayGoTo('https://blob.core.windows.net.evil.example', 'azure')).toBe(false);
    expect(credentialsMayGoTo('http://northwindruns.blob.core.windows.net', 'azure')).toBe(false);
  });
});

describe('a failed request', () => {
  it("is the object's problem when its answer is too large, and the network's otherwise", () => {
    expect(transportError('Amazon S3', new HttpError('the answer is over the 10-byte limit', false))).toMatchObject({ code: 'too-large', message: 'Amazon S3: the answer is over the 10-byte limit' });
    expect(transportError('Amazon S3', new HttpError("couldn't reach s3.amazonaws.com: ENOTFOUND", true)).code).toBe('network');
  });
});
