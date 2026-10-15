# Team store

The team store keeps your team's runs in a bucket you own, so teammates and CI open each other's
recordings, CI keeps its test history there, and anyone can open a share link: a redacted report
that works for 7 days. It is part of the open-source Shadowlap, free under Apache-2.0 like
everything else, with nothing to buy or add first.

Nothing is hosted by Shadowlap and nothing calls home. The bucket is yours, every machine reaches
it with its own credentials, and there are no accounts: who may read and write the store is whoever
your cloud admin gives access to, which [`shadowlap store policy`](#access) prints.

## Set it up

Four steps, each building on the one before:

```sh
shadowlap store set s3://northwind-agent-runs/support-agent     # 1. connect your bucket…
shadowlap store check                                           #    …and check this machine's access
shadowlap push --all                                            # 2. every run on this machine
shadowlap store ci --provider github                            # 3. a CI step that pushes test runs
git add shadowlap.config.json && git commit -m "Use the team store"   # 4. bring your team
```

`store set` writes one line to `shadowlap.config.json`, and committing it is what brings the team
in: anyone who pulls the commit and can read the bucket runs `shadowlap pull` to get the team's
runs. Credentials never go in the file.

## The store

A store is a bucket and, if you like, a folder in it:

| Provider | URL | Credentials, as the cloud's own tools find them |
|---|---|---|
| Amazon S3 | `s3://bucket/folder` | `AWS_PROFILE` or the default profile in `~/.aws` (static keys, `credential_process`, an assumed role, IAM Identity Center after `aws sso login`), keys in the environment, web identity (`AWS_ROLE_ARN` with `AWS_WEB_IDENTITY_TOKEN_FILE`), container credentials, or the instance role |
| Google Cloud | `gs://bucket/folder` | `GOOGLE_OAUTH_ACCESS_TOKEN`, the file `GOOGLE_APPLICATION_CREDENTIALS` names (a service-account key, workload identity federation, an impersonated service account), gcloud's application default credentials, or the metadata server |
| Azure Blob | `az://account/container/folder` | `AZURE_STORAGE_CONNECTION_STRING`, `AZURE_STORAGE_KEY`, `AZURE_STORAGE_SAS_TOKEN`, a service principal (`AZURE_CLIENT_ID`, `AZURE_TENANT_ID` and `AZURE_CLIENT_SECRET` or `AZURE_FEDERATED_TOKEN_FILE`), your `az login`, or a managed identity |
| Cloudflare R2 | `r2://account-id/bucket/folder` | `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` (an R2 API token), or an AWS profile holding its keys |

A query adds what the name can't say: `?region=eu-central-1` and `?profile=<name>` for S3,
`?endpoint=https://minio.internal:9000` for another S3-compatible store (MinIO, Ceph, Wasabi,
Backblaze B2; path-style unless `&path-style=false`), `?auth=hmac` to reach Cloud Storage through
its S3-compatible API with `GCS_HMAC_ACCESS_KEY_ID` and `GCS_HMAC_SECRET_ACCESS_KEY`. Requests go
straight to the cloud; no cloud SDK is involved.

The URL is in a committed file, so it never decides where your credentials go. Google and Azure
credentials (an access token, a SAS, or an account key, whose signature doesn't name the host) are
used only with the cloud's own addresses over https (`*.googleapis.com`, `*.blob.core.windows.net`
and the other Azure Storage domains) or with this machine; an `?endpoint=` anywhere else is refused
with a message. Give Azurite or Azure Stack at another address on your machine instead, in
`AZURE_STORAGE_CONNECTION_STRING` (`BlobEndpoint=…`). A Cloud Storage emulator named by
`STORAGE_EMULATOR_HOST` is sent no credentials, as with Google's own libraries. An S3 signature
names the host it was made for, so S3-compatible stores work at any endpoint.

Behind a company proxy, set `HTTPS_PROXY` (and `NO_PROXY` for what stays inside) as for the
clouds' own CLIs: requests to the store and to the clouds' sign-in services go through it, https in
a tunnel with TLS end to end, with credentials given in the proxy URL
(`http://user:password@proxy:3128`). This machine and the metadata services of cloud machines are
never reached through a proxy. A proxy that inspects TLS needs its certificate in
`NODE_EXTRA_CA_CERTS`.

### Access

Who can use the store is whoever your cloud admin gives access to the bucket, people and CI alike;
that access is the store's security. `shadowlap store policy` prints two policies to ask for,
scoped to the store's folder:

1. **For people, and CI on protected branches:** list the folder; read, write and delete under it.
2. **For pull requests' CI jobs:** read the store, and write only under its `pr/` folder (see
   [Pull requests](#pull-requests)). Without the write part it is read-only: a pull request's push
   then fails with a warning, and its tests still decide the job.

Per cloud:

- **Amazon S3:** two IAM policies. The first also lets `store check` read the bucket's versioning,
  Object Lock and encryption settings, which only the check uses.
- **Cloud Storage:** role bindings. `roles/storage.objectUser` on the bucket, with a condition that
  keeps it to the folder: objects under it, and listings that ask for it
  (`storage.googleapis.com/objectListPrefix`). For pull requests, `roles/storage.objectViewer` the
  same way, and `roles/storage.objectUser` only on objects under `pr/`. A condition needs uniform
  bucket-level access.
- **Azure Blob:** Storage Blob Data Contributor on the container, and Storage Blob Delegator on the
  storage account, which lets `shadowlap share` sign links from an Entra sign-in: Azure hands out
  the user delegation key those links are signed with per account, never per container, and a link
  still reads only what the first role allows. For pull requests, Storage Blob Data Contributor with
  a condition that allows writing, moving and deleting blobs only under `pr/`.
- **Cloudflare R2:** an API token with Object Read & Write on the bucket. An R2 token can't be kept
  to a folder, so pull requests get Object Read only, if anything, and run their tests without
  pushing.

`shadowlap store check` proves this machine's credentials can list, write, read and delete a test
object in the folder, then reports how the bucket keeps what is written to it: encryption at rest,
versioning, and an object lock (S3 Object Lock with a default retention; on Cloud Storage, soft
delete or a retention policy; on Azure, an immutability policy). Anyone allowed to write to the
bucket can change a run's record there: versions keep its earlier state, and a lock keeps those
versions from being deleted. The check warns when either is off, and says how to turn it on. R2
keeps no versions.

### Push and pull

`shadowlap push <run…>` copies runs to the store, with their ancestors so a fork keeps its lineage;
`push --all` copies every run on this machine that isn't there as it is. `shadowlap pull` brings
teammates' runs back. In the bucket, under the folder:

```
blobs/<sha256>             each blob once, gzipped: a system prompt shared by 500 runs goes up once
runs/<run>/run.json        the run and its labels, notes, author and results
runs/<run>/calls.jsonl.gz  its calls
index/<id>.json            one per push: what it pushed, so a pull lists the store without reading every run
shares/<run>-<id>.html     reports behind share links
tests/<id>.json            the report of each test --push session
pr/<number>/…              what a pull request's CI job pushed, laid out the same way
```

- **Who made each run**, the Runs page's By column. A run carries its author: `SHADOWLAP_AUTHOR`
  when set, `ci` in CI (with the provider: github, gitlab, buildkite…), else your git
  `user.email`, else your OS user. A push names the pusher as the author of a run made on this
  machine that has none; a run that came from a pack or the store keeps the author it came with.
- **A run still recording** is queued and goes to the store when the command that recorded it
  ends it: `run`, `replay` (with `--repeat` too), `serve`, `blame` and `verify` push what was
  queued as they finish. Anything else that ends a run leaves it for the next push.
- **Labels and notes** merge both ways: something added on either machine is kept, something
  removed on either is removed. A copy that never synced with the store (a golden unpacked in CI)
  joins its labels and notes with the store's.
- **Results** (blame, verify and check results) belong to the machine that made the run: its push
  writes them, and every other machine takes the store's.
- **Everything else about a run** (who made it, what it covers, its redaction rules) goes up with
  its first push and comes down with its first pull, and nothing changes it after that. Anyone your
  admin lets write to the bucket could edit a run there; such an edit can't change how a run on your
  machine replays, or whom it names as its author.
- **A run you delete here** stays deleted: a pull doesn't bring it back unless you name it.
- **A pulled run is someone else's recording.** It is checked as strictly as a
  [pack](./cli.md#pack-unpack): every record validated, every blob checked against its hash, and
  nothing in it that could rewrite a terminal. A command line may hold tabs and line breaks
  (`python -c '…'`), shown escaped. Its replay asks before running the command it was recorded
  with, as an unpacked run's does.
- **A run a pull would refuse** never goes up: `push` checks each run with the same rules and
  leaves one that fails here, saying why. A run in the store that can't be read (changed there by
  hand, or written by a newer Shadowlap) is skipped with its forks, and the other runs come; the
  next pull tries it again.
- **A push cut short** (a dropped connection, a laptop closed) leaves nothing half done: a run is
  listed for the team once its index entry is written, and the next push lists what went up
  without one. A run you name is checked against the bucket itself, so one a retention rule or a
  person removed goes up again, and so do its calls or blobs if the bucket lost only those (a pull
  that meets such a run says so, and names the push that mends it). `push --all` trusts this
  machine's record and leaves such a run out.
- **Blobs pushed before** aren't sent again, but each is checked with the bucket before a new run
  relies on it, and sent again when the bucket no longer has it. A run whose copy here lacks a blob
  stays here, saying so.

Blobs are shared between runs, so don't put an expiry rule on the store's folder: a rule that
removes an old blob takes it from every newer run that uses it. `shares/` and `pr/` are the
exceptions; see [Share links](#share-links) and [Pull requests](#pull-requests).

`shadowlap store show` says what this machine knows, without a request: the last push and pull, how
many runs are in the store, how many are only here, and the last check.

### Push from CI

```sh
shadowlap test goldens/* --push
```

pushes every test run, with the golden it replayed, and the session's report. CI needs its own
access to the bucket; `shadowlap store ci --provider github|gitlab|other` prints a step that uses
short-lived credentials (OIDC) wherever the CI and the cloud allow it: an AWS role, Google workload
identity federation or an Azure federated credential, so no key is stored in CI. Beside it is the
step for pull requests, with credentials of their own; see [Pull requests](#pull-requests). R2 has
no OIDC, so its token's keys go in the CI's secrets, for protected branches only. A missing store
or missing credentials is a warning: the tests still decide the job's result.
`shadowlap store push-from-ci off` turns pushing from CI off for the whole team (it writes
`"ciPush": false` to `shadowlap.config.json`) without touching the CI files; `on` turns it back on.

## Pull requests

A pull request's CI job runs what the pull request says, and anyone who can open one can change
it. With write access to the store, such a job could change the runs everyone pulls: the poisoning
CVE-2025-36852 describes for shared build caches kept in a bucket. So a pull request's job never
writes to the team's runs:

- **It writes only to its own folder,** `pr/<number>/` under the store's folder. Shadowlap
  recognises a GitHub Actions `pull_request` job (and `pull_request_target`, and reviews of pull
  requests) and a GitLab merge request pipeline by their own variables; on any other CI,
  `SHADOWLAP_PR=<number>` says the job is one. `push`, `test --push`, `share` and `store check` all
  write there. A pull request's job whose number can't be found writes nothing, and says so.
- **A pull leaves those folders out.** `shadowlap pull --include-pr` brings the runs pull
  requests' jobs pushed, to look at a failing test, say. They stay on this machine: `push --all`
  leaves them out and `push <run>` refuses one, so a pull request's run never reaches the team's
  through a teammate. A run the store itself holds always comes from the store's own folder, even
  as the parent of a pull request's run, and nothing a pull request's folder says about a run
  already here (its labels, notes or results) is taken.
- **The cloud enforces it.** The CLI only puts a pull request's runs in their place; the
  pull-request policy from `shadowlap store policy` is what keeps a job from writing anywhere else.
  `shadowlap store ci` prints the step that gives a pull request's job those credentials and
  protected branches the others, and says what the cloud should trust: a role, service account or
  application for the main branch only, and another for pull requests. A pull request can edit the
  workflow file; it can't change which credentials the cloud gives it.
- **What is read is checked,** as for any run from the store: every blob against its hash, every
  record as strictly as a pack's.

Runs from pull requests stay under `pr/` until someone deletes them. A lifecycle rule that deletes
objects under `pr/` a few weeks after they are written keeps it small; a run there may then lose a
blob it shares with an older one, which a pull reports.

## Share links

```sh
shadowlap share <run> [--lineage]
```

writes the run's [HTML report](./cli.md#export-html), with every redaction rule in
`shadowlap.config.json` applied, to `shares/` in the bucket and prints a presigned link that
expires after 7 days. Anyone with the link can open it, without an account; each share is a new
object, so an older link keeps working until it expires. Without redaction rules the report holds
the prompts and tool data as recorded, and the command says so.

A link is signed with your credentials. On S3, temporary ones (an SSO sign-in, an assumed role)
sign links that stop working when they expire, and the command says when. On Cloud Storage a link
needs a key to sign with (a service-account key, or HMAC keys with `?auth=hmac`). On Azure, the
account key or an Entra sign-in can sign one and a SAS token can't; an Entra sign-in needs the
Storage Blob Delegator role on the storage account (see [Access](#access)), and its links end 15
minutes short of 7 days, because Azure counts the 7 days on its own clock. The link is signed
before the report is written, so credentials that can't sign one leave nothing in the bucket.

A report stays in `shares/` after its link expires. To clear them, ask your cloud admin for a
lifecycle rule that deletes objects under the store's `shares/` prefix 7 days after they are
written (`shadowlap store policy` says so too), and keep the rule to that prefix.
