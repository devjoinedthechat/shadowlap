# Team store

The team store keeps your team's runs in a bucket you own, so teammates and CI open each other's
recordings, CI keeps its test history there, and anyone can open a share link for up to 7 days: a
report masked by your redaction rules. It is part of the open-source Shadowlap, free under
Apache-2.0 like everything else, with nothing to buy or add first.

Nothing is hosted by Shadowlap and nothing calls home. The bucket is yours, every machine reaches
it with its own credentials, and there are no accounts: who may read and write the store is whoever
your cloud admin gives access to, which [`shadowlap store policy`](#access) prints.

## Set it up

Four steps, each building on the one before, on the dashboard's setup page (`#/setup/store`:
Settings → Store's **Set up the store**, or **Set up the team store** in the palette) or in a
terminal:

```sh
shadowlap store set s3://<bucket>/<project> --check                   # 1. connect your bucket
shadowlap push --all                                                  # 2. every run on this machine
shadowlap store ci --provider github                                  # 3. a CI step that pushes test runs
git add shadowlap.config.json && git commit -m "Use the team store"   # 4. bring your team
```

`store set --check` checks this machine's access first, as [`store check`](#access) does, and
writes one line to `shadowlap.config.json` only when that works; committing it is what brings the
team in: anyone who pulls the commit and can read the bucket runs `shadowlap pull` to get the
team's runs. Credentials never go in the file. A check that fails writes nothing and says what to
fix, then to run the same `store set … --check` again (in the dashboard, **Check access and
connect** again); for access, the policy to ask for is `store policy --provider <cloud>`, since no
store is set yet.

In the dashboard each step shows its command. **Connect your bucket** picks the cloud (Amazon S3,
Google Cloud, Azure Blob or Cloudflare R2), checks the bucket and folder against its scheme, says
whose credentials this machine would use, shows the access to ask your cloud admin for (what
`store policy` prints, with Copy), and **Check access and connect** runs `store set --check`.
**Push your runs** runs `push --all`. **Push from CI** shows the step for GitHub Actions, GitLab
CI or any other CI, written for your cloud: on GitHub Actions, the job that runs your goldens is
[your workflow](./ci.md#one-job-for-all-of-it) on Settings → CI, whose step pushes while Push from CI
is on, so the setup gives only the steps that give it the bucket's credentials (for R2, the keys to
add as secrets) and **Open your workflow**, rather than a second job that runs the goldens again.
`store ci --provider github` prints those steps in a job of its own, so the page says to copy only
the two; for R2 there are none to copy, and the step shows no command. Then **I added it**, or
**Skip for now** (Settings → Store's **Copy CI step** keeps it, for the CI you picked). **Bring
your team** shows the line to commit, and **Finish** ends the setup. Until then the store works
already, and the dashboard leads back to the setup: it is first in the Overview's Needs a look,
Settings → Store names the step that is next with **Continue the setup**, the palette offers
**Continue setting up the store**, and the status bar says *setting up*. A store set in a terminal
has no setup under way: it shows as the store straight away, and the setup page shows the steps
left.

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

What this machine knows of a store (what it pushed, pulled and checked) is kept per store: its
bucket and folder, and the server an `?endpoint=` names. A region, a profile or another way of
signing in reaches the same store; another endpoint is another server, so pointing the project at
one starts afresh, and its first push sends everything.

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
fixes/<fx-id>.json         a fix, with its blames, repairs and verdicts
pr/<number>/…              what a pull request's CI job pushed, laid out the same way
```

- **Who made each run**, the Runs page's By column. A run carries its author: `SHADOWLAP_AUTHOR`
  when set, `ci` in CI (with the provider: github, gitlab, buildkite…), else your git
  `user.email`, else your OS user. A push names the pusher as the author of a run made on this
  machine that has none; a run that came from a pack or the store keeps the author it came with.
- **A run still recording** is queued and goes to the store when the command that recorded it
  ends it: `run`, `replay` (with `--repeat` too), `serve`, `blame` and `verify` push what was
  queued as they finish. Anything else that ends a run leaves it for the next push, and it counts
  as only on this machine until then; a queued run you delete goes nowhere. A run whose recorder
  is gone (killed, or out of memory) never ends by itself: a push ends it as interrupted, as `gc`
  does, and sends it, and it counts as only on this machine until then. A run the store holds as
  interrupted with fewer calls than your copy, which ended since (an import an older Shadowlap
  pushed while it was still writing), goes up whole again with the next push, and a pull then
  brings all of it; a machine that pulled the short copy gets the whole one by deleting its copy
  and pulling the run by name.
- **Labels and notes** merge both ways: something added on either machine is kept, something
  removed on either is removed, and one you add while a push or pull of that run is on its way
  goes up with the next push. A copy that never synced with the store (a golden unpacked in CI)
  joins its labels and notes with the store's.
- **Results** (blame, verify and check results) belong to the machine that made the run: its push
  writes them, and every other machine takes the store's. A result you make of a teammate's run (a
  blame of a run you pulled) stays on your copy while the store's has none of its kind, so its page
  shows it and `repair` reuses it; it never goes up.
- **Everything else about a run** (who made it, what it covers, its redaction rules) goes up with
  its first push and comes down with its first pull, and nothing changes it after that. Anyone your
  admin lets write to the bucket could edit a run there; such an edit can't change how a run on your
  machine replays, or whom it names as its author.
- **No credential goes up.** A push copies runs as recorded, with no redaction rules applied, but a
  credential a recording made by an earlier version kept in a call's record stays behind: a model
  call's query string goes without its credentials (an Azure `subscription-key`, a `key`, a
  signature) and a credential response header (`authorization`, `x-subject-token`) with
  `<CREDENTIAL>` for its value, as the sidecar records them. See
  [Redaction](./normalizers-and-redaction.md#redaction) for the names read as credentials.
- **Fixes** go with the runs they are about: a push sends a [fix](./cli.md#fix) (its blames,
  repairs and verdicts) once one of its failing or good runs is in the store, and a pull brings the
  team's, so a teammate's Fixes page shows its three steps. A fix only grows, so two machines'
  copies merge: every blame, repair and verdict either made, open turned verified by either, and a
  title someone gave it, the latest rename when it was renamed on both (`fix title` again after a
  sync replaces the title both had). A push that meets a teammate's newer copy merges it the same
  way.
- **A teammate's blame or verdict is run again only from what was checked.** A pull marks every
  blame and verdict it brings as pulled, on this machine only. **Blame again**, **Run more
  attempts** and **Verify again** build their command from the report and the flags kept beside
  it, each one a flag Shadowlap allows with a value of its shape, never from the command line the
  fix carries, and never with a value holding a control or format character. A pulled one runs
  without the teammate's `--build`, `--base` and command after `--`, which ran on their machine,
  spends at most twice what Shadowlap runs by itself (a blame's gate up to 40 attempts and 2 calls
  probed past its boundary, a verify's up to 160 a run, a fixed count up to 10), and runs only once
  you confirm the exact command line, which the question shows. Its page offers the command made
  here to copy, not theirs.
- **Applied is each machine's own.** A fix is applied in a working tree: one applied on one
  machine is verified on the others, with its patch ready to apply there, and stays in their Needs
  a look until it is. `shadowlap fix apply` there puts the patch in, or finds it in already once
  the change came through git, and marks it applied on that machine only.
- **A teammate's repair** comes with its `fix.patch` and reports, written to
  `.shadowlap/repairs/<id>/` as where it ran, so **Copy git apply** and `shadowlap fix apply` work.
  The recordings it made of the fixed runs (its goldens) stay on the machine that ran it, because a
  golden runs the command it recorded when it is tested: they are committed from there. The Fixes
  page says so, and applying the fix here puts in the patch alone, with nothing left to finish.
  Nothing here runs the code it put in (no build, test or replay of your goldens) until you have
  read the change and run `shadowlap test`. The patch is someone else's code, so a pull takes a
  fix only when each repair's patch is the one rewrite its accepted candidate makes, to that file
  alone: one that writes another file, makes, renames or deletes one, adds lines the candidate
  doesn't, or is larger than a repair writes, keeps the fix out of the pull, which names it and
  why.
- **A fix too large to read** (over 16 MB, the size a pull reads of a run's record) stays on the
  machine that has it, and the push says so; a pull that meets one in the store names it and brings
  the others.
- **A run you delete here** stays deleted: a pull doesn't bring it back unless you name it. A
  teammate's replay or fork of it still comes, without it: the fork's link to it is left unset, as
  `unpack` leaves a fork whose parent isn't there. Name the run in a pull and it comes back, linked
  to its forks here again.
- **A pulled run is someone else's recording.** It reads as what it is (a recording, a fork, a
  test), by who made it, never as a pack: with the requests it sent and what it spent where it was
  recorded, as `≈$0.0030 spent · by maya` on its page (Provenance's Upstream row names her too)
  and `≈$0.0030 spent by maya` in `shadowlap show`. That spend is the team's, so the Overview's
  spent live counts it; a capture a teammate pushed stays *as captured*, and a pack you unpack
  still says *from a pack* and isn't counted. A pulled run is checked as strictly as a
  [pack](./cli.md#pack-unpack): every record validated, every blob checked against its hash, its
  redaction rules' patterns read as the config's are, so none that could stall a replay comes in
  ([Patterns that could take too long](./normalizers-and-redaction.md#patterns-that-could-take-too-long)),
  and nothing in it that could rewrite a terminal. A command line may hold tabs and line breaks
  (`python -c '…'`), shown escaped. One the store marks as still running comes in as interrupted,
  since nothing here records it. Its replay asks before running the command it was recorded
  with, as an unpacked run's does, saying it came from the team store and who recorded it.
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
- **Only the store's folder is reached.** Anyone who can write to the folder names the objects
  in it, and a URL resolves `.` and `..`, so a pull reads only objects named as a push names them
  (an index segment is `index/<id>.json`, a run's id and a blob's hash are checked before they make
  a name) and says once which other name under `index/` it left unread. No request is ever made
  for a key with a `.` or `..` part, so `index/../../other/x.json` reaches nothing outside the
  folder, read or written with your credentials.

Blobs are shared between runs, so don't put an expiry rule on the store's folder: a rule that
removes an old blob takes it from every newer run that uses it. `shares/` and `pr/` are the
exceptions; see [Share links](#share-links) and [Pull requests](#pull-requests).

`shadowlap store show` says what this machine knows, without a request: the last push and pull, how
many runs are in the store, how many are only here, and the last check. Runs are counted as the
dashboard counts them: attempts (`--repeat`, blame's probes, verify's attempts) are filed under the
run they came from, and a run is only here while it, or an attempt filed under it, isn't in the
store, as the Runs page's `local` tag marks it. Settings → Store and the Overview's Needs a look say
the same numbers. Needs a look's row opens Runs: the runs only here carry the
`local` tag, and Push in the bulk bar sends the ones picked, with their attempts; Settings → Store's
**Push local runs** sends them all. A run in the store whose attempts aren't (a `replay --repeat`
since the push) has **Push** on its own page, which sends the attempts.

### Push from CI

```sh
shadowlap test goldens/* --push
```

pushes every test run, with the golden it replayed, and the session's report. CI needs its own
access to the bucket; `shadowlap store ci --provider github|gitlab|other` prints a step that uses
short-lived credentials (OIDC) wherever the CI and the cloud allow it: an AWS role, Google workload
identity federation or an Azure federated credential, so no key is stored in CI. Beside it is the
step for pull requests, with credentials of their own; see [Pull requests](#pull-requests). On
GitHub that step is only for pull requests from your own repository: a fork's gets no OIDC token,
so its job skips the step and runs the tests without pushing. R2 has no OIDC, so its token's keys
go in the CI's secrets, for protected branches only. A golden that runs live (one marked `fork`, or
with an injection gate) calls your agent's providers, so the step that runs the tests needs their
keys: `store ci` names those its goldens' recordings call, in the step's `env` from the repository's
secrets on GitHub, and in a note on GitLab and any other CI. A missing store or missing credentials is a
warning: the tests still decide the job's result.
`shadowlap store push-from-ci off` turns pushing from CI off for the whole team (it writes
`"ciPush": false` to `shadowlap.config.json`) without touching the CI files; `on` turns it back on.
With the GitHub Action, `push: true` does this, and also sends each fix its
[fix on failure](./ci.md#fix-on-failure) opens a pull request for, verified, with every run the job
made, so a teammate's pull brings it to their Fixes page as *from CI · PR #138*. CI fixes are part
of pushing from CI: while Push from CI is on, the step of [your workflow](./ci.md#one-job-for-all-of-it)
the dashboard's Settings → CI writes pushes, with a fix pull request or without, and says the job
needs the bucket's credentials (the two credentials steps `store ci` prints, or for R2 its keys,
which only your branches' jobs get), and while it is off, the step doesn't push and the action
keeps the fixes it opens in the job. A fix that can't go (no
credentials, the store out of reach) is a warning in the job summary and the log, with why: it
never keeps the fix's pull request from opening, and the job's result is the tests'. A pull
request's own job keeps to its folder and sends no fixes, and with R2 it pushes nothing. One from a
fork, which GitHub gives no secrets and no OIDC token, pushes nothing either: it skips the pull
request's credentials step, so the job goes on, and its push warns. See
[Fixes in the team store](./ci.md#fixes-in-the-team-store).

## Pull requests

A pull request's CI job runs what the pull request says, and anyone who can open one can change
it. With write access to the store, such a job could change the runs everyone pulls: the poisoning
CVE-2025-36852 describes for shared build caches kept in a bucket. So a pull request's job never
writes to the team's runs:

- **It writes only to its own folder,** `pr/<number>/` under the store's folder, and sends no fixes. Shadowlap
  recognises a GitHub Actions `pull_request` job (and `pull_request_target`, and reviews of pull
  requests) and a GitLab merge request pipeline by their own variables; on any other CI,
  `SHADOWLAP_PR=<number>` says the job is one. `push`, `test --push`, `share` and `store check` all
  write there. A pull request's job whose number can't be found writes nothing, and says so.
- **A pull leaves those folders out.** `shadowlap pull --include-pr` brings the runs pull
  requests' jobs pushed, to look at a failing test, say. They stay on this machine: `push --all`
  leaves them out and `push <run>` refuses one, so a pull request's run never reaches the team's
  through a teammate. A run the store itself holds always comes from the store's own folder, even
  as the parent of a pull request's run, and nothing a pull request's folder says about a run
  already here (its labels, notes or results) is taken. A run a pull request's folder brought before
  the store held it is replaced by the store's own copy on the next pull, once the team pushes it.
- **The cloud enforces it.** The CLI only puts a pull request's runs in their place; the
  pull-request policy from `shadowlap store policy` is what keeps a job from writing anywhere else.
  `shadowlap store ci` prints the step that gives a pull request's job those credentials and
  protected branches the others, and says what the cloud should trust: a role, service account or
  application for the main branch only, and another for pull requests. A pull request can edit the
  workflow file; it can't change which credentials the cloud gives it. On GitHub, a pull request
  from a fork gets no OIDC token, so the step is only for your repository's own pull requests: a
  fork's job skips it and tests without pushing, with a warning, rather than failing on it.
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
the prompts and tool data as recorded, and the command says so. Either way it holds no credential
a recording kept (a model call's query string, a response header, a captured call's query, form
body or response headers), and a report is only read, so a model's signed reasoning is masked in
it like any other text. The recording goes into the file as data, never as markup: the page draws
it without HTML from the recording, and its content policy lets it load nothing from anywhere else.

A link is signed with your credentials, for at most 7 days, and the cloud refuses it after that:
the expiry is part of what is signed. On S3, temporary ones (an SSO sign-in, an assumed role)
sign links that stop working when they expire, and the command says when. On Cloud Storage a link
needs a key to sign with (a service-account key, or HMAC keys with `?auth=hmac`). On Azure, the
account key or an Entra sign-in can sign one and a SAS token can't; an Entra sign-in needs the
Storage Blob Delegator role on the storage account (see [Access](#access)), and its links end 15
minutes short of 7 days, because Azure counts the 7 days on its own clock. The link is signed
before the report is written, so credentials that can't sign one leave nothing in the bucket.

A report stays in `shares/` after its link expires. To clear them, ask your cloud admin for a
lifecycle rule that deletes objects under the store's `shares/` prefix 7 days after they are
written (`shadowlap store policy` says so too), and keep the rule to that prefix.
