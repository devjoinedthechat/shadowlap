# Team store

The team store keeps your team's runs in a bucket you own. Teammates and CI open each other's recordings, CI keeps its test history there, and anyone can open a share link for up to 7 days: a report masked by your redaction rules.

It is part of the open-source Shadowlap, free under Apache-2.0 like everything else, with nothing to buy or add first. Nothing is hosted by Shadowlap and nothing calls home. The bucket is yours, every machine reaches it with its own credentials, and there are no accounts: who may read and write the store is whoever your cloud admin gives access to, which [`shadowlap store policy`](#access) prints.

- [Set it up](#set-it-up)
- [The store](#the-store)
- [Push and pull](#push-and-pull)
- [A teammate's runs and fixes](#a-teammates-runs-and-fixes)
- [Push from CI](#push-from-ci)
- [Pull requests](#pull-requests)
- [Share links](#share-links)

## Set it up

Setting up takes four steps, each building on the one before. Run them in a terminal, or on the dashboard's setup page (`#/setup/store`: **Set up team store**, on Settings → Store or in the palette):

```sh
shadowlap store set s3://<bucket>/<project> --check                   # 1. connect your bucket
shadowlap push --all                                                  # 2. every run on this machine
shadowlap store ci --provider github                                  # 3. a CI step that pushes test runs
git add shadowlap.config.json && git commit -m "Use the team store"   # 4. bring your team
```

1. **Connect your bucket.** `store set --check` checks this machine's access first, as [`store check`](#check-access) does, and writes one line to `shadowlap.config.json` only when that works. Credentials never go in the file.
2. **Push your runs.** `push --all` copies every run on this machine to the store.
3. **Push from CI.** `store ci` prints the step that pushes CI's test runs: see [Push from CI](#push-from-ci).
4. **Bring your team.** Committing the file is what brings the team in: anyone who pulls the commit and can read the bucket runs `shadowlap pull` to get the team's runs.

**When the check fails**, it writes nothing and says what to fix, then to run the same `store set … --check` again (in the dashboard, **Check access and connect** again). For access, the policy to ask for is `store policy --provider <cloud>`, since no store is set yet.

### In the dashboard

In the dashboard each step shows its command:

| Step | What it does |
|---|---|
| **Connect your bucket** | picks the cloud, checks the bucket and folder against its scheme, says whose credentials this machine would use, and shows the access to ask for |
| **Push your runs** | runs `push --all` |
| **Push from CI** | turns Push from CI on for GitHub Actions, or shows the step for GitLab CI or any other CI, written for your cloud |
| **Bring your team** | shows the line to commit; **Finish** ends the setup |

- **Connect your bucket** picks Amazon S3, Google Cloud, Azure Blob or Cloudflare R2. The access to ask your cloud admin for is what `store policy` prints, with Copy, and **Check access and connect** runs `store set --check`.
- **Push from CI on GitHub Actions.** The job that runs your goldens is [your workflow](./ci.md#one-job-for-all-of-it) on Settings → CI, whose step pushes while Push from CI is on. Its **Write file** adds the steps that give it the bucket's credentials (for R2, you add the keys as secrets). So the setup asks **Turn on Push from CI** or `Skip for now`, with no second job that runs the goldens again.
- **What to copy.** On GitLab CI or any other CI, the step to paste, with **Copy**. On GitHub Actions there is none: `store ci --provider github` prints the sign-in steps in a job of its own, and Write file takes only the two. For R2 there are none.
- **After the CI step** on GitLab CI or any other CI, pick **I added it**, or `Skip for now`. Settings → Store's **Copy CI step** keeps it, for the CI you picked.
- **What the step writes.** Each choice writes Push from CI to `shadowlap.config.json`, as Settings → Store's switch does: **Turn on Push from CI** and **I added it** turn it on, and `Skip for now` turns it off.

Until **Finish**, the store works already, and the dashboard leads back to the setup:

- it is first in the Overview's Needs a look;
- Settings → Store names the step that is next, with **Continue setup**;
- the palette offers **Continue team store setup**;
- the status bar says *setting up*.

A store set in a terminal has no setup under way: it shows as the store straight away, and the setup page shows the steps left.

## The store

A store is a bucket and, if you like, a folder in it:

| Provider | URL |
|---|---|
| Amazon S3 | `s3://bucket/folder` |
| Google Cloud | `gs://bucket/folder` |
| Azure Blob | `az://account/container/folder` |
| Cloudflare R2 | `r2://account-id/bucket/folder` |

### Credentials

Each machine finds its credentials as the cloud's own tools find them:

| Provider | Credentials |
|---|---|
| Amazon S3 | `AWS_PROFILE` or the default profile in `~/.aws`, keys in the environment, web identity, container credentials, or the instance role |
| Google Cloud | `GOOGLE_OAUTH_ACCESS_TOKEN`, the file `GOOGLE_APPLICATION_CREDENTIALS` names, gcloud's application default credentials, or the metadata server |
| Azure Blob | `AZURE_STORAGE_CONNECTION_STRING`, `AZURE_STORAGE_KEY`, `AZURE_STORAGE_SAS_TOKEN`, a service principal, your `az login`, or a managed identity |
| Cloudflare R2 | `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` (an R2 API token), or an AWS profile holding its keys |

- **An AWS profile** can be static keys, `credential_process`, an assumed role, or IAM Identity Center after `aws sso login`. Web identity is `AWS_ROLE_ARN` with `AWS_WEB_IDENTITY_TOKEN_FILE`.
- **The file `GOOGLE_APPLICATION_CREDENTIALS` names** holds a service-account key, workload identity federation, or an impersonated service account.
- **An Azure service principal** is `AZURE_CLIENT_ID` and `AZURE_TENANT_ID`, with `AZURE_CLIENT_SECRET` or `AZURE_FEDERATED_TOKEN_FILE`.

### Options in the URL

A query adds what the name can't say:

| Query | What it does |
|---|---|
| `?region=eu-central-1` | names the region, for S3 |
| `?profile=<name>` | names the profile, for S3 |
| `?endpoint=https://minio.internal:9000` | reaches another S3-compatible store (MinIO, Ceph, Wasabi, Backblaze B2), path-style unless `&path-style=false` |
| `?auth=hmac` | reaches Cloud Storage through its S3-compatible API, with `GCS_HMAC_ACCESS_KEY_ID` and `GCS_HMAC_SECRET_ACCESS_KEY` |

Requests go straight to the cloud; no cloud SDK is involved.

What this machine knows of a store (what it pushed, pulled and checked) is kept per store: its bucket and folder, and the server an `?endpoint=` names. A region, a profile or another way of signing in reaches the same store. Another endpoint is another server, so pointing the project at one starts afresh, and its first push sends everything.

### Where credentials go

The URL is in a committed file, so it never decides where your credentials go.

- **Google and Azure credentials** (an access token, a SAS, or an account key, whose signature doesn't name the host) are used only with the cloud's own addresses over https, or with this machine. Those are `*.googleapis.com`, `*.blob.core.windows.net` and the other Azure Storage domains.
- **An `?endpoint=` anywhere else** is refused with a message. To reach Azurite or Azure Stack at another address, give that address on your machine instead, in `AZURE_STORAGE_CONNECTION_STRING` (`BlobEndpoint=…`).
- **A Cloud Storage emulator** named by `STORAGE_EMULATOR_HOST` is sent no credentials, as with Google's own libraries.
- **An S3 signature** names the host it was made for, so S3-compatible stores work at any endpoint.

### Behind a proxy

Behind a company proxy, set `HTTPS_PROXY` (and `NO_PROXY` for what stays inside), as for the clouds' own CLIs.

- **Through the proxy** go requests to the store and to the clouds' sign-in services, https in a tunnel with TLS end to end.
- **Proxy credentials** go in the proxy URL: `http://user:password@proxy:3128`.
- **Never through a proxy**: this machine, and the metadata services of cloud machines.
- **A proxy that inspects TLS** needs its certificate in `NODE_EXTRA_CA_CERTS`.

### Access

Who can use the store is whoever your cloud admin gives access to the bucket, people and CI alike; that access is the store's security. `shadowlap store policy` prints two policies to ask for, scoped to the store's folder:

1. **For people, and CI on protected branches:** list the folder; read, write and delete under it.
2. **For pull requests' CI jobs:** read the store, and write only under its `pr/` folder (see [Pull requests](#pull-requests)). Without the write part it is read-only: a pull request's push then fails with a warning, and its tests still decide the job.

Per cloud:

| Cloud | For people and protected branches | For pull requests |
|---|---|---|
| Amazon S3 | the first of two IAM policies | the second |
| Cloud Storage | `roles/storage.objectUser` on the bucket, with a condition that keeps it to the folder | `roles/storage.objectViewer` the same way, and `roles/storage.objectUser` only on objects under `pr/` |
| Azure Blob | Storage Blob Data Contributor on the container, and Storage Blob Delegator on the storage account | Storage Blob Data Contributor, with a condition that allows writing, moving and deleting blobs only under `pr/` |
| Cloudflare R2 | an API token with Object Read & Write on the bucket | Object Read only, if anything |

- **Amazon S3.** The first policy also lets `store check` read the bucket's versioning, Object Lock and encryption settings, which only the check uses.
- **Cloud Storage.** The policies are role bindings. A binding's condition keeps it to objects under the folder, and listings that ask for it (`storage.googleapis.com/objectListPrefix`); a condition needs uniform bucket-level access.
- **Azure Blob.** Storage Blob Delegator lets `shadowlap share` sign links from an Entra sign-in. Azure hands out the user delegation key those links are signed with per account, never per container, and a link still reads only what the first role allows.
- **Cloudflare R2.** An R2 token can't be kept to a folder, so pull requests get Object Read only, if anything, and run their tests without pushing.

In the dashboard, Settings → Store's **Copy access policy** copies what `shadowlap store policy` prints, to send your cloud admin.

### Check access

`shadowlap store check` proves this machine's credentials can list, write, read and delete a test object in the folder. Then it reports how the bucket keeps what is written to it: encryption at rest, versioning, and an object lock.

| Cloud | An object lock |
|---|---|
| Amazon S3 | S3 Object Lock with a default retention |
| Cloud Storage | soft delete or a retention policy |
| Azure | an immutability policy |

Anyone allowed to write to the bucket can change a run's record there: versions keep its earlier state, and a lock keeps those versions from being deleted. The check warns when either is off, and says how to turn it on. R2 keeps no versions.

In the dashboard, Settings → Store's **Check again** runs `shadowlap store check` as a job. It writes nothing to `shadowlap.config.json`, and a finished setup stays finished. Its result shows as the store's *Last check*, and in the activity feed (*Store checked*, or *Store check failed*).

## Push and pull

`shadowlap push <run…>` copies runs to the store, with their ancestors so a fork keeps its lineage. `push --all` copies every run on this machine that isn't there as it is. `shadowlap pull` brings teammates' runs back.

In the bucket, under the folder:

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

### What travels

Each part of a run syncs its own way:

| Part | How it syncs |
|---|---|
| Labels and notes | merged both ways |
| Results: blame, verify and check results | the machine that made the run pushes them, and every other machine takes the store's |
| Everything else: who made it, what it covers, its redaction rules | up with its first push, down with its first pull, and nothing changes it after that |
| Fixes | with the runs they are about, merged |
| Credentials | never sent: [What's masked](#whats-masked) |

**Who made each run** shows in the Runs page's By column. A run carries its author: `SHADOWLAP_AUTHOR` when set, `ci` in CI (with the provider: github, gitlab, buildkite…), else your git `user.email`, else your OS user. A push names the pusher as the author of a run made on this machine that has none; a run that came from a pack or the store keeps the author it came with.

**Labels and notes:**

- **Both ways.** Something added on either machine is kept, and something removed on either is removed. One you add while a push or pull of that run is on its way goes up with the next push.
- **A copy that never synced** with the store (a golden unpacked in CI) joins its labels and notes with the store's.

**Results:**

- **The run's own machine.** Results belong to the machine that made the run: its push writes them, and every other machine takes the store's.
- **A result you make of a teammate's run** (a blame of a run you pulled) stays on your copy while the store's has none of its kind, so its page shows it and `repair` reuses it. It never goes up.

**An edit in the bucket.** Anyone your admin lets write to the bucket could edit a run there. Such an edit can't change how a run on your machine replays, or whom it names as its author.

**What you dismiss** on the Overview stays on this machine: a push never sends it, and a pull never brings anyone's.

### Runs still recording

- **Queued.** A run still recording is queued, and goes to the store when the command that recorded it ends it. `run`, `replay` (with `--repeat` too), `serve`, `blame` and `verify` push what was queued as they finish.
- **Ended by anything else**, a run waits for the next push, and counts as only on this machine until then. A queued run you delete goes nowhere.
- **A run whose recorder is gone** (killed, or out of memory) never ends by itself. A push ends it as interrupted, as `gc` does, and sends it; it counts as only on this machine until then.
- **A short copy in the store.** A run the store holds as interrupted with fewer calls than your copy, which ended since, goes up whole again with the next push, and a pull then brings all of it. An import an older Shadowlap pushed while it was still writing is one.
- **A machine that pulled the short copy** gets the whole one by deleting its copy and pulling the run by name.

### Fixes

- **They go with the runs they are about.** A push sends a [fix](./cli.md#fix) (its blames, repairs and verdicts) once one of its failing or good runs is in the store. A pull brings the team's, so a teammate's Fixes page shows its three steps.
- **Two copies merge.** A fix only grows, so two machines' copies merge: every blame, repair and verdict either made, open turned verified by either, and a title someone gave it.
- **Titles.** A fix renamed on both machines keeps the latest rename; `fix title` again after a sync replaces the title both had.
- **Its check.** A check given with [`fix check`](./cli.md#fix) goes with the fix: the latest change wins on every machine, and each keeps the checks before it. A run the check left out of the fix is left out on every machine. A fix verified on one machine keeps the check its verdict counted under, whatever another machine changed.
- **A push that meets a teammate's newer copy** merges it the same way.
- **Command lines.** A fix goes with the command line each of its blames, verdicts and repairs ran, and the flags kept to run each again, a command after `--` and a `--build` included. A key on them goes as `<CREDENTIAL>`, as in a run's command line.
- **Too large to read.** A fix over 16 MB, the size a pull reads of a run's record, stays on the machine that has it, and the push says so. A pull that meets one in the store names it and brings the others.

### What's masked

No credential of a run goes up. A push copies runs as recorded, with no redaction rules applied, but a credential a recording made by an earlier version kept in a call's record stays behind, as the sidecar records them:

- **A model call's query string** goes without its credentials (an Azure `subscription-key`, a `key`, a signature).
- **A credential response header** (`authorization`, `x-subject-token`) goes with `<CREDENTIAL>` for its value.
- **A captured call's** name, address, body and answer go with theirs masked.
- **A key the agent's command line carries** goes as `<CREDENTIAL>`, as in a pack.

[Credentials](./normalizers-and-redaction.md#credentials) lists the names read as credentials.

### Deleted runs

A run you delete here stays deleted: a pull doesn't bring it back unless you name it. A teammate's replay or fork of it still comes, without it: the fork's link to it is left unset, as `unpack` leaves a fork whose parent isn't there. Name the run in a pull and it comes back, linked to its forks here again.

### When a push or pull goes wrong

- **A run a pull would refuse** never goes up: `push` checks each run with the same rules and leaves one that fails here, saying why.
- **A run in the store that can't be read** (changed there by hand, or written by a newer Shadowlap) is skipped with its forks, and the other runs come. The next pull tries it again.
- **A push cut short** (a dropped connection, a laptop closed) leaves nothing half done. A run is listed for the team once its index entry is written, and the next push lists what went up without one.
- **A run you name** is checked against the bucket itself, so one a retention rule or a person removed goes up again. So do its calls or blobs if the bucket lost only those; a pull that meets such a run says so, and names the push that mends it.
- **`push --all`** trusts this machine's record, and leaves such a run out.
- **Blobs pushed before** aren't sent again, but each is checked with the bucket before another run relies on it, and sent again when the bucket no longer has it. A run whose copy here lacks a blob stays here, saying so.

### Only the store's folder

Anyone who can write to the folder names the objects in it, and a URL resolves `.` and `..`. So a pull reads only objects named as a push names them: an index segment is `index/<id>.json`, and a run's id and a blob's hash are checked before they make a name. It says once which other name under `index/` it left unread.

No request is ever made for a key with a `.` or `..` part, so `index/../../other/x.json` reaches nothing outside the folder, read or written with your credentials.

**Warning:** Blobs are shared between runs, so don't put an expiry rule on the store's folder: a rule that removes an old blob takes it from every later run that uses it. `shares/` and `pr/` are the exceptions; see [Share links](#share-links) and [Pull requests](#pull-requests).

### What this machine knows

`shadowlap store show` says what this machine knows, without a request: the last push and pull, how many runs are in the store, how many are only here, and the last check.

- **Counted as the dashboard counts them.** Attempts (`--repeat`, blame's probes, verify's attempts) are filed under the run they came from. A run is only here while it, or an attempt filed under it, isn't in the store, as the Runs page's `local` tag marks it.
- **The same numbers** show in Settings → Store and the Overview's Needs a look. Needs a look's row opens Runs, where the runs only here carry the `local` tag.
- **Pushing from the dashboard.** Push in the bulk bar sends the ones picked, with their attempts. **Push local runs**, on Runs, Settings → Store and Needs a look's row, sends them all.
- **A run in the store whose attempts aren't** (a `replay --repeat` since the push) has **Push** on its own page, which sends the attempts.

## A teammate's runs and fixes

What a pull brings is someone else's work. Shadowlap checks it as strictly as a pack, marks what it brings, and runs a teammate's command or code only once you have seen it.

### A pulled run

- **It reads as what it is** (a recording, a fork, a test), by who made it, never as a pack: with the requests it sent and what it spent where it was recorded.
- **Its spend.** Its page says `≈$0.0030 spent · by maya` (Provenance's Upstream row names her too), and `shadowlap show` says `≈$0.0030 spent by maya`.
- **The team's spend.** That spend is the team's, so the Overview's spent live counts it. A capture a teammate pushed stays *as captured*, and a pack you unpack still says *from a pack* and isn't counted.
- **Checked as strictly as a [pack](./cli.md#pack-unpack).** Every record is validated, every blob checked against its hash, and nothing in it that could rewrite a terminal comes in.
- **Its redaction rules' patterns** are read as the config's are, so none that could stall a replay comes in ([Patterns that could take too long](./normalizers-and-redaction.md#patterns-that-could-take-too-long)).
- **A command line** may hold tabs and line breaks (`python -c '…'`), shown escaped.
- **One the store marks as still running** comes in as interrupted, since nothing here records it.
- **Its replay asks first** before running the command it was recorded with, as an unpacked run's does, saying it came from the team store, and in the CLI who recorded it.

### A teammate's blame or verdict

A teammate's blame or verdict is run again only from what was checked. A pull marks every blame and verdict it brings as pulled, on this machine only.

- **Run blame again**, **Run more attempts** and **Verify again** build their command from the report and the flags kept beside it: each a flag Shadowlap allows, with a value of its shape.
- **Never the fix's command line.** They never build it from the command line the fix carries, nor with a value holding a control or format character.
- **None of the teammate's commands.** A pulled one runs without the teammate's `--build`, `--base` and command after `--`, which ran on their machine.
- **A bounded budget.** It spends at most twice what Shadowlap runs by itself, as the table below gives.
- **Only after you confirm.** It runs only once you confirm the exact command line, which the question shows. Its page offers the command made here to copy, not theirs.

| Pulled step | At most |
|---|---|
| A blame's gate | 40 attempts, and 2 calls probed past its boundary |
| A verify's gate | 160 attempts a run |
| A fixed count | 10 |

### A teammate's repair

A teammate's repair comes with its `fix.patch` and reports, written to `.shadowlap/repairs/<id>/` as where it ran, so **Copy git apply** and `shadowlap fix apply` work.

- **Through no link.** It is never written into a folder that is there already, nor through a link on the way to it, which a repository could track to send them elsewhere. The pull says it couldn't write them, and why.
- **Its goldens stay where it ran.** The recordings it made of the fixed runs (its goldens) stay on the machine that ran it, because a golden runs the command it recorded when it is tested. They are committed from there.
- **The patch alone.** The Fixes page says so, and applying the fix here puts in the patch alone, with nothing left to finish.
- **Read before it runs.** Nothing here runs the code it put in (no build, test or replay of your goldens) until you have read the change and run `shadowlap test`.

The patch is someone else's code, so a pull takes a fix only when each repair's patch is the one rewrite its accepted candidate makes, to that file alone. A patch like one of these keeps the fix out of the pull, which names it and why:

- one that writes another file;
- one that makes, renames or deletes one;
- one that adds lines the candidate doesn't;
- one larger than a repair writes;
- one to a dot-file or a file in a dot-folder, such as `.github` or `.claude/settings.json`, or another file that runs, such as a `Dockerfile`, a script or `requirements.txt`.

A repair rewrites text only in a string of JavaScript, TypeScript or Python source, a string value of YAML, JSON or TOML, or a Markdown, plain text, prompt or Jinja file, and never in what runs. See [where an anchor goes](./repair.md#where-an-anchor-goes).

### A teammate's patch is held to a repair's rewrites

A teammate's machine or the bucket could have written the fix, so a pulled patch can do no more than a repair made here could. `shadowlap fix apply` reads the file where the patch goes, as it is in your working tree, and refuses the patch when what it rewrites is:

- outside any string in code, such as other code or a comment, or outside any string value in YAML, JSON or TOML, such as a key;
- past the end of the string it starts in, or the inside of a placeholder (`${…}`, `{…}`, `{{ … }}`);
- a value that runs, such as `package.json`'s `scripts` or dependencies, a script or dependency in `pyproject.toml`, or a container's `command` in a compose file or a Kubernetes manifest;
- a rewrite a repair sets aside: one that adds a quote, a backslash, a brace or a placeholder, a line break to one-line text, or YAML syntax to a plain value.

Nothing is changed, and the message says why. The Fixes page and `shadowlap fix show` say the same, and offer no `git apply` to copy.

A string can hold more than a prompt, such as a command your code runs, so read a pulled patch before you apply it.

### Applied on each machine

Applied is each machine's own. A fix is applied in a working tree: one applied on one machine is verified on the others, with its patch ready to apply there, and stays in their Needs a look until it is. `shadowlap fix apply` there puts the patch in, or finds it in already once the change came through git, and marks it applied on that machine only.

## Push from CI

`--push` on `shadowlap test` pushes every test run, with the golden it replayed, and the session's report:

```sh
shadowlap test goldens/* --push
```

The report names the CI the session ran in. `shadowlap pull` keeps the newest one a CI job pushed, which the dashboard's Settings → CI names under Your workflow (*Last seen in CI*). A person's own `--push`, and a pull request's job, are left out of it.

### CI's credentials

CI needs its own access to the bucket. `shadowlap store ci --provider github|gitlab|other` prints a step that uses short-lived credentials (OIDC) wherever the CI and the cloud allow it: an AWS role, Google workload identity federation or an Azure federated credential. So no key is stored in CI.

- **The pull requests' step.** Beside it is the step for pull requests, with credentials of their own; see [Pull requests](#pull-requests).
- **Forks on GitHub.** On GitHub that step is only for pull requests from your own repository. A fork's gets no OIDC token, so its job skips the step and runs the tests without pushing.
- **R2** has no OIDC, so its token's keys go in the CI's secrets. On GitHub they go to every job that isn't a pull request's (an environment only protected branches can use keeps them to those), and on GitLab they are protected variables.
- **Goldens that run live.** A golden that runs live (one marked `fork`, or with an injection gate) calls your agent's providers, so the step that runs the tests needs their keys. `store ci` names those its goldens' recordings call: in the step's `env` from the repository's secrets on GitHub, and in a note on GitLab and any other CI.
- **A missing store or missing credentials** is a warning: the tests still decide the job's result.

### Turning it off

`shadowlap store push-from-ci off` turns pushing from CI off for the whole team, without touching the CI files: it writes `"ciPush": false` to `shadowlap.config.json`. `on` turns it back on.

### With the GitHub Action

With the GitHub Action, `push: true` does this. It also sends each fix its [fix on failure](./ci.md#fix-on-failure) opens a pull request for, verified, with every run the job made, so a teammate's pull brings it to their Fixes page as *from CI · PR #138*.

- **CI fixes are part of pushing from CI.** While Push from CI is on, the step of [your workflow](./ci.md#one-job-for-all-of-it) the dashboard's Settings → CI writes pushes, with a fix pull request or without. It says the job needs the bucket's credentials: the two credentials steps `store ci` prints, which its **Write file** adds, or for R2 its keys, which only your branches' jobs get.
- **While it is off**, the step doesn't push, and the action keeps the fixes it opens in the job.
- **A fix that can't go** (no credentials, the store out of reach) is a warning in the job summary and the log, with why. It never keeps the fix's pull request from opening, and the job's result is the tests'.
- **A pull request's own job** keeps to its folder and sends no fixes, and with R2 it pushes nothing.
- **One from a fork**, which GitHub gives no secrets and no OIDC token, pushes nothing either. It skips the pull request's credentials step, so the job goes on, and its push warns.

See [Fixes in the team store](./ci.md#fixes-in-the-team-store).

## Pull requests

A pull request's CI job runs what the pull request says, and anyone who can open one can change it. With write access to the store, such a job could change the runs everyone pulls: the poisoning CVE-2025-36852 describes for shared build caches kept in a bucket. So a pull request's job never writes to the team's runs.

### Its own folder

A pull request's job writes only to its own folder, `pr/<number>/` under the store's folder, and sends no fixes. `push`, `test --push`, `share` and `store check` all write there. Shadowlap recognises the job by the CI's own variables:

| CI | A pull request's job |
|---|---|
| GitHub Actions | a `pull_request` job; `pull_request_target` and reviews of pull requests too |
| GitLab | a merge request pipeline |
| Any other CI | one where `SHADOWLAP_PR=<number>` says the job is one |

A pull request's job whose number can't be found writes nothing, and says so.

### Left out of a pull

A pull leaves those folders out.

- **`shadowlap pull --include-pr`** brings the runs pull requests' jobs pushed, to look at a failing test, say.
- **They stay on this machine.** `push --all` leaves them out and `push <run>` refuses one, so a pull request's run never reaches the team's through a teammate.
- **The store's own folder first.** A run the store itself holds always comes from the store's own folder, even as the parent of a pull request's run. Nothing a pull request's folder says about a run already here (its labels, notes or results) is taken.
- **Replaced once the team pushes it.** A run a pull request's folder brought before the store held it is replaced by the store's own copy on the next pull, once the team pushes it.

### The cloud enforces it

- **The policy.** The CLI only puts a pull request's runs in their place. The pull-request policy from `shadowlap store policy` is what keeps a job from writing anywhere else.
- **The CI step.** `shadowlap store ci` prints the step that gives a pull request's job those credentials, and protected branches the others. It says what the cloud should trust: a role, service account or application for the main branch only, and another for pull requests.
- **The workflow file.** A pull request can edit the workflow file; it can't change which credentials the cloud gives it.
- **Forks on GitHub.** A pull request from a fork gets no OIDC token, so the step is only for your repository's own pull requests. A fork's job skips it and tests without pushing, with a warning, rather than failing on it.

What is read is checked, as for any run from the store: every blob against its hash, every record as strictly as a pack's.

**Clearing `pr/`.** Runs from pull requests stay under `pr/` until someone deletes them. A lifecycle rule that deletes objects under `pr/` a few weeks after they are written keeps it small. A run there may then lose a blob it shares with an older one, which a pull reports.

## Share links

`shadowlap share` writes the run's [HTML report](./cli.md#export-html) to `shares/` in the bucket, with every redaction rule in `shadowlap.config.json` applied. It prints a presigned link that expires after 7 days:

```sh
shadowlap share <run> [--lineage]
```

- **Anyone with the link** can open it, without an account.
- **Each share is an object of its own**, so an older link keeps working until it expires.
- **Without redaction rules**, the report holds the prompts and tool data as recorded, and the command says so.
- **Either way, no credential.** It holds no credential a recording kept (a model call's query string or response header; a captured call's address, body or answer), nor a key the command line carries.
- **Signed reasoning is masked.** A report is only read, so a model's signed reasoning is masked in it like any other text.
- **Data, never markup.** The recording goes into the file as data: the page draws it without HTML from the recording, and its content policy lets it load nothing from anywhere else.

### Signing a link

A link is signed with your credentials, for at most 7 days, and the cloud refuses it after that: the expiry is part of what is signed. The link is signed before the report is written, so credentials that can't sign one leave nothing in the bucket.

| Cloud | What can sign a link |
|---|---|
| Amazon S3 | your credentials; temporary ones (an SSO sign-in, an assumed role) sign links that stop working when they expire, and the command says when |
| Cloud Storage | a key: a service-account key, or HMAC keys with `?auth=hmac` |
| Azure | the account key or an Entra sign-in; a SAS token can't |

On Azure, an Entra sign-in needs the Storage Blob Delegator role on the storage account (see [Access](#access)). Its links end 15 minutes short of 7 days, because Azure counts the 7 days on its own clock.

### Expired reports

A report stays in `shares/` after its link expires. To clear them, ask your cloud admin for a lifecycle rule that deletes objects under the store's `shares/` prefix 7 days after they are written (`shadowlap store policy` says so too), and keep the rule to that prefix.

## See also

- The CLI reference for [`push` and `pull`](./cli.md#push-pull), [`share`](./cli.md#share) and [`store`](./cli.md#store): every flag.
- [CI](./ci.md): the workflow that pushes from CI, and fixes in the team store.
- [Normalizers and redaction](./normalizers-and-redaction.md): the rules a share link applies, and the credentials every copy masks.
- [Security](https://github.com/devjoinedthechat/shadowlap/blob/main/SECURITY.md): the team store's checks, with the rest of Shadowlap's.
