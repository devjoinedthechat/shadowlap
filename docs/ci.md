# CI mode

`shadowlap test` turns a recording into a regression test: the agent must still send exactly the requests it sent when the recording was made. It catches unintended prompt changes, tool-argument drift and loop changes, at zero token cost and with no network.

## Make a golden

Record a run you consider correct, then pack it into the repository:

```sh
shadowlap run -- node dist/agent.js --task "triage inbox"
shadowlap pack 01K5CQ4N7G goldens/triage-inbox
git add goldens/triage-inbox
```

A pack is a directory: `run.json`, `calls.jsonl`, one file per blob, and a `.gitattributes` holding `* -text` ([the recording format](./recording-format.md) specifies it). It's git-friendly (stable file names, one file per message), and [redaction rules](./normalizers-and-redaction.md#redaction) are applied on export. Commit only what you'd be comfortable with a colleague reading.

Commit the `.gitattributes` with the pack. Every blob is checked against its hash, and the file keeps git from converting line endings, as Git for Windows does by default (`core.autocrlf`) and a `* text=auto` in your own `.gitattributes` would: a golden committed on macOS or Linux then passes in a Windows checkout too. A golden packed before packs carried the file is read as it was committed when git converted only its line endings; `test --update` adds the file to it.

## Run it

```sh
shadowlap test goldens/* --junit shadowlap-junit.xml
```

For each pack, `shadowlap test` imports it into the project's store, re-runs the recorded command under a replay sidecar with **every provider set to offline**, and passes only if the replay is clean and the process exits 0. Clean means the agent sent every request the recording holds, unchanged, and no more: a request sent differently, a call the recording doesn't have, or a recorded call never made (the agent [ended early](#a-replay-that-ends-early)) each fails it. A divergence prints the report; a live call is refused with a 503 that names the call; both fail the pack. `--online` allows live calls after a divergence if you really want them; `--cwd` sets the working directory for the recorded commands; `--writes` sets the write policy. A `*` in the last part of a path is expanded by `shadowlap test` itself, so `'goldens/*'` works without a shell.

Output, when one agent puts a new UUID in every request's metadata:

```
✗ summarize-thread: diverged at call 1 (api POST /v1/messages)
    ✗ Diverged at call 1 (api POST /v1/messages): 0 calls replayed before divergence
      compared with run 01M4ZHJR8K…, call 1
      ~ $.metadata.user_id
          - "ca35b35e-b35d-4874-b430-d905bb4d9402"
          + "599d00cd-757e-4daf-9e49-ad91069b7a1a"
      hint: this looks like a UUID; to ignore it in matching, add a normalizer
            shadowlap normalize add --kind api --path '$.metadata.user_id' --pattern uuid --replace '<UUID>'
    ⑂ Forked at call 1: 0 calls replayed, then 1 live; 0 upstream requests
      the agent process exited with an error
    │ summarize-thread: 503 {"type":"error","error":{"type":"shadowlap_offline","message":"shadowlap is offline: call #1 (POST /v1/messages) was not served from the recording and would need the network"}}
✓ triage-inbox: 30/30 replayed, 12.3k input tokens not re-spent

1 passed, 1 failed · 0 upstream requests
```

Besides dates, UUIDs and ULIDs, the report names the normalizer for an id the agent makes anew on every run: one that looks generated (16 or more hex digits, a prefix with a random tail such as `req_8f3a2c1d9e7b`, a long random token), or one under a key that names a request, a trace, a span, a session, a nonce or an idempotency key. Any other id that changed, such as a customer's number or an order's code, may be a real change: the agent acting on another customer is what the test is there to catch. The report says so, and gives the normalizer only for when you know that id changes on every run; a normalizer would hide a real change from every later test.

The JUnit report renders in GitHub, GitLab and most CI dashboards; each pack is a test case, and a failure carries the divergence report and the agent's output. Control characters in what the agent printed, such as the escape codes of a coloured logger, are written as escapes (`\x1b[32m`), as the Markdown report writes them, so the file stays XML that every parser reads.

### A replay that ends early

An agent can stop before its recording did and still exit 0: an exception it catches, a stop condition that changed, a step it now skips. Every request it sent matched, but what it never sent (the last model turn, the write) is as much a change. The replay leaves its recording at the first recorded model or tool call it never made, a divergence of its own type, `ended_early`, and the golden fails:

```
✗ research: ended early at call 11 (api POST /v1/messages): 10 of 30 recorded calls replayed
    ✗ Ended early at call 11: 10 of 30 recorded calls replayed (3 api, 5 tool, 2 clock/random), 0 upstream requests, 3.2k input tokens not re-spent
      20 recorded calls not reached: #11 POST /v1/messages, #12 read_file, #13 read_file, …
```

Its failure kind is `diverged`, and the JSON report's `divergence` has `type` `ended_early` and `recorded`, the calls the recording holds, so the GitHub Action and `bisect` treat it as one. The run keeps it too: `shadowlap ls` and the dashboard list it as `ended early @11`, not as a clean replay. Clock and random reads left unread don't count. A golden marked `fork` passes on its checks, as it does after a fork. If the agent now stops earlier on purpose, re-record the golden with `shadowlap test <golden> --update`.

### Keys

A golden that replays offline needs no model key, so a job without secrets, such as a pull request's from a fork, tests it. An agent whose client takes its key from the environment, as `new Anthropic()`, `new OpenAI()` and Google's clients do, would refuse to send anything without one: its replay gets a [placeholder](./how-it-works.md#keys), `shadowlap-offline-replay-placeholder`, for each provider its recording called whose credentials the job lacks (placeholder AWS credentials for Bedrock, and Azure OpenAI's only for a recording whose environment held `AZURE_OPENAI_API_KEY`), never in place of a key or another credential the job has. The replay is offline, so nothing carrying one leaves the machine; the sidecar refuses a live call that would carry one anyway. What isn't a secret still has to be there: an Azure OpenAI client built the default way needs `AZURE_OPENAI_ENDPOINT` and `OPENAI_API_VERSION`, and an AWS client its region.

What may go live needs the real keys in the job, and gets no placeholder: `--online`, `--update`, a golden marked [`fork`](#recordings-that-fork-on-purpose) (a gate's golden is one), an [injection gate](#injection-gates), `--chaos`, and [fix on failure](#fix-on-failure). Without its key such a golden fails, even when its replay would be clean. Clients that sign in with a token need one of their own: Vertex AI's, and Azure OpenAI's on Microsoft Entra ID. Pass keys to the step as environment variables, as [below](#github-actions).

## Test history

Each `shadowlap test` is a session, kept in the project's store (`.shadowlap/shadowlap.db`, created if needed): the command as you gave it, the revision it tested, when, how many goldens passed and failed, and the upstream requests it made (0 for goldens that replay offline). For each golden the session keeps its result and why it failed: a divergence, with the report as printed; a failed check, with every check; a non-zero exit; or a replay that made no calls. It keeps how many attempts passed of how many, one attempt included, and for a golden with a [gate](./gating.md) what the gate decided, so a gate against history has its baseline. Over time that is each golden's result at each revision. A golden is named by its pack directory relative to the project, so its history follows it as long as it stays there.

The replays a session makes are runs like any other, marked as made by `shadowlap test` for that golden, so you can open one: each prints `replaying run <id>` as it starts, and the JSON report (`--json`) names the session, each golden's replays and the recording it replayed. So the store doesn't fill with clean replays, only the newest one of each golden is kept; every replay that failed stays, with the last clean one before it, as does any replay you labelled, noted or forked. What a removed replay alone held, such as the live answers of a recording that may fork, goes with the next `shadowlap gc`, which is safe to run when nothing is recording. Global `--db :memory:` (given before `test`) keeps nothing.

Ctrl-C, or a dashboard job being stopped, cuts short the replay running at that moment: its agent gets the signal, with everything the agent started. The goldens after it don't run, and the session ends with the results of the ones that finished, marked as interrupted; the golden that was cut short gets no result, since a replay stopped halfway says nothing about it. `shadowlap test` then exits 130 (143 for SIGTERM), and the next session prunes the replay that was cut short.

The dashboard's **Tests** page shows this history: each golden's result at each recent revision, the verdict with the newest session that ran every golden (and any golden run again on its own since), and each failure as printed, with buttons that add the normalizer, update the golden or find the commit ([dashboard](./dashboard.md#actions)). A session's process is kept in the store while it runs, so a session started in a terminal reads as running there.

A CI job's store usually goes with the job. To keep CI's runs, `shadowlap test --push` sends every test run, with the golden it replayed, and the session's report to your [team store](./team.md#push-from-ci), a bucket you own, before any replay is pruned; teammates bring the runs to their machines with `shadowlap pull`. A pull request's job writes only to [its own folder](./team.md#pull-requests) in the store. A [gate against a golden's history](./gating.md#a-gate-against-history) needs the history itself from one job to the next: the GitHub Action keeps the store in the Actions cache for one ([`keep-history`](#github-actions)), and on another CI system you cache `.shadowlap/shadowlap.db` between runs.

## Outcome checks

A clean replay proves the agent still sends the same requests. Sometimes you want to prove something about what it does instead: that a write never happens, that a tool is called with the right arguments, that the answer mentions the refund. Checks say that, per recording, under `tests` in `shadowlap.config.json`:

```json
{
  "tests": {
    "goldens/triage-inbox": {
      "expect": {
        "tools": {
          "send_email": { "count": 1, "args": { "to": "oncall@example.com" } },
          "delete_thread": 0
        },
        "modelCalls": "<= 12",
        "inputTokens": "<= 50000",
        "cost": "<= 0.50",
        "output": { "includes": "3 incidents" }
      }
    }
  }
}
```

| Check | Passes when |
|---|---|
| `tools` | Each tool was called the given number of times. A count is a number, `">= 1"`, `"<= 3"`, `"> 0"`, `"< 5"` or a range such as `"2-4"`. Every attempt counts, including writes that were blocked or stubbed. With `{ "count": …, "args": { … } }`, only calls whose arguments contain those values count: objects match the keys you give, everything else must be equal. `{ "args": … }` alone means at least once |
| `modelCalls`, `toolCalls` | The run made that many model calls, or tool calls |
| `inputTokens`, `outputTokens` | The run's model requests add up to that many tokens. Input includes cache reads, because the request still carried them. Measured over every model call whatever its origin: a clean replay sends what it recorded, so this is what the run costs to run live, which is the number a prompt change moves |
| `cost` | The same in dollars, from the [price table](./cli.md#the-configuration-file). An amount is a number, `"<= 0.50"` or a range such as `"0.1-0.4"`. A model with no price **fails** the check and names the model, rather than passing because an unknown price counted as zero |
| `output` | What the agent printed (stdout and stderr) `includes` each string and `excludes` each string. Case doesn't matter |
| `answer` | The same, for the text of the last model response |
| `calls`, `when`, `judge` | Every call of a tool meets a rule (what it comes after, its arguments, values from earlier calls); checks that apply once a call matched a condition; a model's answer to a question about the run, yes or no, recorded like any model call, so a golden is judged once when it is packed and every clean replay after is judged from the recording, free and the same every time. See [Checks](./checks.md) and [Judge checks](./judges.md) |

A key is a recording directory relative to the config file, and `*` may stand for part of its last path segment (`goldens/refund-*`). An exact path wins over a pattern. A mistake in `tests`, such as an unknown key, fails `shadowlap test` before anything runs, and `shadowlap doctor` reports it.

A failed check fails the recording and says what happened:

```
✗ triage-inbox: check failed: delete_thread called 0 times, but called 2 times
    ✓ send_email with {"to":"oncall@example.com"} called 1 time
    ✗ delete_thread called 0 times: called 2 times
    ✓ at most 12 model calls
    ✓ at most 50000 input tokens
    ✓ cost at most $0.50
    ✓ output includes "3 incidents"
```

A token or cost budget is how a prompt change that quietly doubles the context fails a build. Nothing
else in Shadowlap notices that: the requests still match, so the replay is clean, and the run costs
twice as much the next time it runs live.

### Recordings that fork on purpose

A recording normally fails as soon as the agent sends a different request. Mark it `fork` and a divergence is allowed: the calls before the fork come from the recording, the agent runs live from the fork, and the recording passes on its checks. The run where the agent did the wrong thing becomes the test that the fix holds, without re-recording, and the prefix costs nothing.

```json
{
  "tests": {
    "goldens/refund-emailed-customer": {
      "fork": true,
      "repeat": 5,
      "passes": 5,
      "expect": { "tools": { "send_email": 0, "issue_refund": ">= 1" } }
    }
  }
}
```

- **It needs the providers.** Calls after the fork are live, so the job needs the provider credentials, and each attempt spends tokens from the fork on. `shadowlap test` uses the same upstreams as `shadowlap run`, and the network guard still applies.
- **Writes stay fenced.** Write tools after the fork are blocked unless `--writes` says otherwise. A blocked call still counts as a call, so `"send_email": 0` means the agent never tried.
- **Models vary.** `repeat` runs the recording that many times, and `passes` (default: all of them) is how many must pass. The report shows how each attempt did. An attempt a check could not decide, such as a [judge](./judges.md#not-judged) whose call failed, neither passed nor failed: the golden stops there, since no attempt after it would decide it either, and is inconclusive unless the attempts before it already settled the count. A fixed count can't tell agents apart (4 of 5 lets one that passes 70% of the time through about half the time), so a `gate` can decide instead, as attempts come in, with the error rates it states: `"gate": { "good": 0.9, "bad": 0.7, "risk": 0.05 }` between two pass rates, or `"gate": { "baseline": "history" }` against the golden's own test history, which needs no figures of your own and fails a large drop in a few attempts. [Gating](./gating.md) explains both, what each catches and what it costs.
- **Without the change** a `fork` recording replays clean, and its checks apply to the recording as it is. Adding the checks before the fix is a quick way to see them fail.

Checks work the same on recordings that don't fork: they then describe the recording itself and cost nothing.

### Injection gates

A golden whose agent reads untrusted content (a page, an email, a ticket) can also be gated on
whether text planted there steers it. Mark the tools that bring outside text in and give the golden
an `injection` entry:

```json
{
  "tools": { "fetch_page": { "trust": "untrusted" } },
  "tests": { "goldens/*": { "injection": { "obeyed": 0, "repeat": 3 } } }
}
```

Once the golden's replay passes, `shadowlap test` plants payloads in each of its untrusted reads,
each with a canary of its own, and fails it, as an `injection` failure, when a tool call carries a
canary in more attempts than `obeyed` allows. Those attempts run live from the model call that reads
the payload, so CI needs the provider's key: without it (a pull request from a fork gets no
secrets), every attempt's model call fails, and the gate is *inconclusive*, never passed. So is a
gate with nothing to plant in, or whose test showed nothing. An inconclusive gate fails the golden;
`shadowlap test --inconclusive warn` lets it through with a warning. See
[Injection tests](./injection.md#gate-ci-on-it).

### Error paths

A golden records a healthy run, so it never holds a tool timeout or a rate limit. `shadowlap test
goldens/* --chaos` forks each golden where the first tool that reads the world times out, answers
nothing, answers malformed or oversized JSON, and where the model call after it gets a 429 or a
500, and judges each fork by the checks that hold on any path: the upper bounds its `expect` sets on
write tools, or its `chaos.expect`. See [Error-path presets](./error-paths.md).

## Update a golden after an intended change

A prompt you changed on purpose makes its goldens diverge, which is the test doing its job. Once you mean the change, update them (`shadowlap test` prints this command after its totals when a golden diverged on more than a value that changes every run):

```sh
shadowlap test goldens/refund-flow --update
```

Each golden that diverged is re-recorded live from its first call, with every write tool stubbed: the agent is told each write succeeded, and nothing is sent. Its checks run on the new recording, and only when the agent exits 0 and they pass does the new pack replace the old one, in your working tree. Only the pack's own files are replaced (`run.json`, `calls.jsonl` and `blobs/`); anything else you keep in the golden's folder, such as a README, stays as it is. The new pack is written under `.shadowlap/` first, so an update that is interrupted leaves the old golden. Then it is replayed offline like any other golden, and you review the change in your pull request. It prints the checks, the calls and what the re-recording cost, then what the agent sends differently: the system prompt, the tools and the models, and the change in the request that made the golden diverge:

```
✗ refund-flow: diverged at call 3 (api POST /v1/messages)
    …
    ↻ updating goldens/refund-flow: re-recording live, writes stubbed
      ✓ issue_refund called 0 times
      re-recorded as run 01K5CQ9T2W: 31 calls, was 30 · model calls 11 → 12 · escalate 0 → 1, issue_refund 1 → 0 · $0.072 live · 12 upstream requests
      what changed: system prompt changed · call 3 (api POST /v1/messages): ~ $.system
      replaced goldens/refund-flow in the working tree; review the change in your pull request
✓ refund-flow: 31/31 replayed, 12.4k input tokens not re-spent (updated)
```

Only goldens that diverged are updated. One that fails a check, or exits with an error, is left alone: the agent needs the fix, not its golden. One that replayed clean but holds no verdict for a [judge check](./judges.md) keeps its recording: the judge is asked live, and its call is added to the golden. A golden that [forks on purpose](#recordings-that-fork-on-purpose) passes wherever it forks, so it is updated only when its test forked before the call its [task](./training.md#tasks) takes over at: no model can be scored on it there, since an attempt replays the recording only up to the fork. `shadowlap test` names such a golden after its totals:

```
goldens/refund-over-limit forks at #3, before its task's takeover at #17, so no model can be scored on it. Update it: shadowlap test goldens/refund-over-limit --update
```

When what diverged is a value the agent makes anew on every run, such as a UUID, a date or a request id, updating only moves the problem to the next run, and `--update` says so, naming the path and the [normalizer](./normalizers-and-redaction.md) that fixes it for good (for an id that may be a real change, it says that the update records the new one, and gives the normalizer for the case where it changes every run):

```
    ! $.metadata.user_id looks like a UUID, a value that changes every run: updating re-records it, and the next run diverges again. A normalizer fixes it for good:
        shadowlap normalize add --kind api --path '$.metadata.user_id' --pattern uuid --replace '<UUID>'
```

When the request carries a field the recording never had, holding such a value, the golden needs both: the update records the field, and the normalizer keeps the next run from diverging on its new value. Add the normalizer first, then update.

Updating calls the providers, so it needs their credentials, like `shadowlap run`. The session records an updated golden as passed and updated.

## Find the commit that broke it

When a golden that used to pass fails, `shadowlap bisect` finds the commit where it started:

```sh
shadowlap bisect goldens/refund-in-limit --good c91d0f4      # --bad defaults to HEAD
```

```
▸ goldens/refund-in-limit · good c91d0f4 · bad d2e8a1f · 5 commits apart
  replay at d2e8a1f  ✗ diverged at call 1 (api POST /v1/messages) · $.metadata.user_id
  replay at c91d0f4  replayed clean
  replay at 9a3c5e0  replayed clean
  replay at 4e7b2d1  ✗ diverged at call 1 (api POST /v1/messages) · $.metadata.user_id
✓ first bad commit 4e7b2d1 · Send the user id with every request · Ravi · 2026-09-30
  diverged at call 1 (api POST /v1/messages) · $.metadata.user_id · 4 replays · 0 tokens · 0 upstream requests · 4.0s
```

It replays the recording at commits between the two, halving the range each time. Each commit is checked out in a temporary git worktree under `.shadowlap/bisect/`, where the agent runs with its recorded command, and the replay is judged as `shadowlap test` judges it: a divergence, a failed check or a non-zero exit fails it. Replays are offline, so it costs no tokens. It checks both ends first, and says so when the recording passes at `--bad` (nothing to find) or already fails at `--good`.

- **What changes per commit is the agent's code.** The recording, its checks (the golden's under `tests`, or `--expect`) and the normalizers come from your working tree as it is now. Uncommitted changes are not part of any replay.
- **Dependencies.** Each worktree gets your working tree's `node_modules`, linked, except that a package linked from the repository itself (a workspace package) is the worktree's own copy, so it runs as it was at that commit. An installed executable in the recorded command that the checkout doesn't have, such as `.venv/bin/python`, still runs from your working tree. When the agent needs more at each commit, such as a build of its own packages, `--build "npm ci && npm run build"` runs in each worktree before its replay, and then nothing is linked.
- **A run works too:** `shadowlap bisect <run> --good <rev>` replays a run from the store, once it has ended: a run still recording is refused, since only part of it is there. For a run that failed a check rather than one that should replay clean, add the check and `--fork`: older commits send different requests, so each replay runs live from where it diverges and the check decides. That part costs tokens, and the result says how many. A test replay of a golden takes the golden's checks from `tests` without `--expect`.
- **A golden marked `fork`** replays as `shadowlap test` replays it: live from where it diverges, so its search costs tokens too.
- **Commits it can't test.** A commit that won't check out, or where `--build` fails, is skipped, as `git bisect skip` would, and the nearest other commit is tried instead. When the first bad commit could be one it skipped, it names those too.
- History is followed by first parents, so a merged branch counts as its merge commit. Only commits that have `--good` in their history are replayed: for a `--good` commit on a branch that was merged, that starts at the merge that brought it in. A `--good` commit on another branch works from where the two histories meet, which is checked like any good commit. The worktrees are removed after each replay, and on Ctrl-C.

## GitHub Actions

The Shadowlap action is the one step to add after your agent is built:

```yaml
- uses: actions/checkout@v7
- uses: actions/setup-node@v7
  with: { node-version: 22 }
- run: npm ci && npm run build          # whatever your agent needs to run
- uses: devjoinedthechat/shadowlap@v0.1.0
  with:
    version: 0.1.0
    recordings: goldens/*
```

It replays each recording offline and fails the check when one diverges, makes a live call, exits with an error or fails a check. A golden that replays offline needs no real key; a golden marked `fork` or with a gate, an injection gate, `online` and `fix-on-failure` need the providers' keys, and Vertex AI and Entra ID clients a token ([Keys](#keys)). The job summary gets a table of the recordings, and for each failure the diff of the first changed request, the normalizer hint if there is one, and the agent's last output lines; when a recording diverged, it names the `shadowlap test <dir> --update` command for a change you meant. Each failure is also annotated on the pull request.

A Python agent needs its interpreter and packages installed before the action, as for any other step. The action itself needs Node 22.16 or later, not 23.

The step names a release twice: the action at its tag, and in `version:` the `shadowlap` CLI it installs from npm. Keep the two the same release, the one your project uses: when they differ, as after an update that moved only the tag, the step warns and names the version to set. With `fix-on-failure`, it installs the Anthropic SDK beside the CLI at the version the release was tested with. With `version:` left empty, the action builds the CLI from its own source, which adds about a minute.

| Input | Default | Effect |
|---|---|---|
| `recordings` | `goldens/*` | Recording directories, separated by spaces or new lines; `*` is allowed in the last part of a path. As with `shadowlap test`, a path that names no pack fails as a test, and a pattern that matches none fails the step |
| `working-directory` | `.` | Where the recorded commands run |
| `version` | empty | A `shadowlap` version from npm; empty builds it from the action's source |
| `writes` | `block` | What write tools do after a divergence: `block`, `stub` or `allow` |
| `guard` | `block` | The network guard: `block`, `warn` or `off` |
| `online` | `false` | Allow live model calls after a divergence |
| `fail-on-divergence` | `true` | With `false`, the step passes and `failed` says what happened |
| `summary` | `true` | Write the report to the job summary |
| `annotations` | `true` | Annotate failed recordings |
| `junit` | empty | Also write JUnit XML to this path |
| `store` | empty | The store for the test history and the replays; empty uses the project's, `.shadowlap/shadowlap.db` |
| `inconclusive` | `fail` | What an [inconclusive](./gating.md) golden does to the step, as `shadowlap test --inconclusive`: `fail` counts it in `failed` and fails the step; `warn` lets it through with a warning annotation. The `inconclusive` output counts it either way |
| `max-attempts` | empty | Raise every gate's limit for this run, as `shadowlap test --max-attempts`; empty keeps each gate's own `max` |
| `keep-history` | `auto` | Keep the store, and with it the [test history](#test-history), between jobs in the Actions cache, so a [gate against history](./gating.md#a-gate-against-history) has a baseline: `true`, `false`, or `auto`, which keeps it when `shadowlap.config.json` gives a golden one. Each run restores its branch's newest copy (a branch's first run, the default branch's) and saves its own under a key of its own, whether the tests passed or not |
| `push` | `false` | Push every test run and the session's report to the [team store](./team.md#push-from-ci) set in `shadowlap.config.json` (`shadowlap test --push`), and each fix that `fix-on-failure` opens ([below](#fixes-in-the-team-store)); the job needs credentials for the bucket, and a push that can't happen is a warning, never a failure |
| `fix-on-failure` | `false` | Open a fix pull request when a golden fails an outcome check ([below](#fix-on-failure)) |
| `fix-budget` | `2.00` | Dollars that may be spent per failing golden on finding and proving a fix |
| `repairer` | empty | The model that proposes fixes, as for `shadowlap repair --repairer`; empty uses `repair.repairer` in the config |

Outputs: `passed`, `failed` (every recording that fails the step: each failure, and each inconclusive one unless `inconclusive` is `warn`), `inconclusive` (the recordings whose verdict is inconclusive, a gate that ran out of attempts between its bounds, a check that could not be decided or an injection gate that showed too little to say, whatever the input made of them), `diverged`, `checks-failed` (definite check failures only), `session` (the test session's id), `fixes` and `fix-prs` (the fix pull requests opened, and their URLs), and the paths `report-json`, `report-markdown` and `junit`.

The action reads `tests` from `shadowlap.config.json` in the working directory. A recording marked `fork` calls the providers after the fork, so pass their keys to the step as environment variables (`env: ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}`).

When a recording fails and the logs aren't enough, keep the failed replay as a file to open. The action replays into a store it throws away, so these steps install the `shadowlap` CLI, replay again into a store they keep (`--db`), take the first recording that failed from the JSON report, and export its replay together with the recording. Of several attempts they take one that failed. A recording marked `fork` runs live again here. When nothing fails on the second run, the step says so and the upload finds no file.

```yaml
- if: failure()
  run: npm install -g shadowlap@0.1.0      # the version the action step names
- if: failure()
  run: |
    shadowlap --db replays.db test goldens/* --json report.json || true
    pack=$(jq -r '[.results[] | select(.ok | not)][0].dir // empty' report.json)
    [ -n "$pack" ] || { echo 'No recording failed on the second run'; exit 0; }
    golden=$(jq -r '.runs[-1].runId' "$pack/run.json")
    # The replays of that recording made here, the attempts that failed first
    pick='[.[] | select(.parentRunId == $g and .imported == null)] | map(select(.status != "completed" or .checks.passed < .checks.total)) + . | .[0].runId'
    run=$(shadowlap --db replays.db ls --json -n 100000 | jq -r --arg g "$golden" "$pick")
    shadowlap --db replays.db export html "$run" failed-run.html --lineage
- if: failure()
  uses: actions/upload-artifact@v7
  with: { name: shadowlap-run, path: failed-run.html }
```

On other CI systems, run the CLI directly. `--junit`, `--json` and `--markdown` write reports, as described in the [CLI reference](./cli.md#test).

## Fix on failure

When a golden fails an outcome check in CI, the action can propose the fix itself: it runs `shadowlap repair` on the failing replay, which blames it (finds the model call where it was lost), asks the repairer to rewrite the prompt or a tool description, and keeps a rewrite only when `verify` accepts it. A fix verify accepted becomes a pull request with the patch and its report. Goldens that fail the same check are one failure, as a [blame joins them into one fix](./blame.md#fixes) (a test's replays carry no labels), so they get one repair, with every failing replay among the runs it has to fix, and one pull request that re-records each of them. When no patch fixes them all (one of them fails in a way no prompt fix reaches, say), each is repaired on its own, in the order the session tested them, within what is left of their budget, until a fix is accepted for one. That fix still gets the one pull request, which re-records the goldens it was verified for and names each of the others as failing the same check without being verified under the fix, with the `shadowlap test <golden> --update` that re-records it on the branch when the fix repairs it too (an update keeps a recording only when it passes its checks); the others get no pull request of their own. When no fix is accepted for any of them, the job summary says how each try ended.

A fix changes what the agent sends, so a golden that must replay exactly would diverge on the fix's own branch and fail the pull request's checks. The pull request's one commit therefore carries the golden re-recorded under the fix too: the recording verify accepted replaces the golden's pack (`run.json`, `calls.jsonl`, `blobs/`, with the pack's `.gitattributes`; other files in its folder stay), once it replays clean with the fix applied, which the action checks in its working tree before it pushes. When it can't, the golden stays as it was, and the pull request and the job summary say to run `shadowlap test <golden> --update` on the branch. A golden marked `fork` is left as it is: it passes on its checks from wherever it diverges. The same change reaches the project's other goldens, so the action replays every other golden the session tested that must replay exactly with the fix applied too: when one that passed before diverges under the fix, the pull request and the job summary name it, with the `shadowlap test <goldens> --update` to run on the branch. One that comes out inconclusive under the fix, or was inconclusive before it, is named apart as such, never as one the fix broke. One marked `fork` isn't replayed there, as it would run live from where it diverges, and the pull request names it. The pull request says its own checks pass only when every golden the session tested replays clean on the branch; with one that may fork among them, it says only that the others replay clean. The step:

```yaml
# the job needs: permissions: { contents: write, pull-requests: write }
- uses: actions/checkout@v7
  with:
    ref: ${{ github.head_ref || github.ref }}
- uses: actions/setup-node@v7
  with:
    node-version: 22
- run: npm ci && npm run build   # whatever your agent needs to run
- run: npm install -g @anthropic-ai/claude-code
- uses: devjoinedthechat/shadowlap@v0.1.0
  with:
    version: 0.1.0
    recordings: goldens/*
    fix-on-failure: true
    fix-budget: 2.00
    repairer: claude-code
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    # and your agent's own provider keys: blame and verify run it live
```

They are the steps of a job of their own: the branch checked out, Node 22.16 or later, the agent's dependencies (put your project's in place of `npm ci && npm run build`), then the action. It needs:

- a model key for the repairer: `ANTHROPIC_API_KEY` for `claude-code` and `anthropic`, `OPENAI_API_KEY` for `openai:<model>`. The `claude-code` repairer runs Claude Code in print mode, so the runner needs it installed, which the first step does; `anthropic` and `openai:<model>` need nothing installed. An `anthropic` repairer without its key (a secret not set, or a pull request from a fork, which gets none) is found out before anything is blamed, so the job spends nothing on it and its summary says *the repairer could not be asked: no Anthropic credentials*;
- your agent's own provider keys in the same `env`, as for `shadowlap run`: blame re-runs the failing replay live from the call it probes, and verify runs the agent with the fix. An agent on OpenAI with the `anthropic` repairer needs `OPENAI_API_KEY` as well as `ANTHROPIC_API_KEY`; without its keys, blame fails and no fix is proposed;
- permission to push a branch (`contents: write`) and to open the pull request (`pull-requests: write`), in the job's `permissions`, and `GH_TOKEN` for `gh`;
- with Push from CI on, the bucket's credentials, so each fix reaches the [team store](#fixes-in-the-team-store) too;
- a branch checked out, as the first step does (`ref: ${{ github.head_ref || github.ref }}`). A pull request's own workflow checks out a detached merge commit, so it checks out its branch, and the fix becomes a pull request into it;
- Node 22.16 or later on the runner, not 23, as the second step sets up.

The dashboard's Settings → CI writes the agent's provider keys into the step's `env` by name, from the providers its goldens' recordings called, in place of that last comment; the comment stays after them when a golden's keys can't be named (its pack can't be read, or it calls Vertex AI, which signs in with a token).

It never opens a pull request for a divergence (most are intended: [update the golden](#update-a-golden-after-an-intended-change) or add a normalizer), nor for a golden whose only failing check is a cost check on a model with no price (add it under `prices`), never keeps a fix that verify rejected, never spends past the budget (each failing golden gets `fix-budget` dollars for blame, the repairer and verify together, goldens repaired together their budgets added up, and repair starts nothing once it is spent), and never merges anything: you review every fix. A failed check still fails the build. The job summary lists each failing golden, or the goldens repaired together, with the pull request opened (whether its goldens were re-recorded, and the other goldens it leaves diverging), or why there is none (*the repairer could not be asked: claude was not found*, when Claude Code isn't on the runner), and what it spent of its budget. The fix commit is made by GitHub's Actions bot when git has no identity of its own on the runner. A session stopped by a signal, as when the job is cancelled, starts no fix. The fix in the store the job used (the `store` input) records the pull request it went to (`shadowlap fix pr`), so a dashboard on that store lists it as *from CI · PR #138*, and once the pull request is merged or closed, *from CI · PR #138 merged*: the dashboard reads its state from GitHub with `gh`, in the background, while Fixes is open.

### Fixes in the team store

A job's store usually goes with the job, so to reach your teammates a fix has to travel through the [team store](./team.md). With [Push from CI](./team.md#push-from-ci) on (Settings → Store, or `shadowlap store push-from-ci on`), the dashboard's Settings → CI writes the step with `push: true`, and the bucket's credentials among what it needs:

```yaml
# the job needs: permissions: { contents: write, pull-requests: write, id-token: write }
- uses: actions/checkout@v7
  with:
    ref: ${{ github.head_ref || github.ref }}
- uses: actions/setup-node@v7
  with:
    node-version: 22
- run: npm ci && npm run build   # whatever your agent needs to run
- run: npm install -g @anthropic-ai/claude-code
# here, the bucket's credentials: the two if: steps shadowlap store ci prints
- uses: devjoinedthechat/shadowlap@v0.1.0
  with:
    version: 0.1.0
    recordings: goldens/*
    fix-on-failure: true
    fix-budget: 2.00
    repairer: claude-code
    push: true
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    # and your agent's own provider keys: blame and verify run it live
```

`push: true` pushes the test runs as `shadowlap test --push` does, and once a fix's pull request is open, every run the job made (`shadowlap push --all`), which takes the fix with its blame, repair and verdicts along. A teammate's `shadowlap pull` then brings it to their Fixes page, as *from CI · PR #138*. Settings → CI has no switch of its own for this: the step follows Push from CI, and while that is off, or the project has no team store, it is the step above without the push lines.

Pushing needs the bucket's credentials in the job, besides the permissions the fix needs. Amazon S3, Cloud Storage and Azure give a job short-lived credentials: add `id-token: write` to the job's permissions, as the first comment says, and copy the two `if:` steps that `shadowlap store ci --provider github` prints (Settings → Store's **Copy CI step**) into the job where the comment stands, after the checkout and right before the action. The first gives your branches' jobs the credentials that write to the store; the second gives a pull request's job its own, which write only under `pr/`. Copy only those two steps. The rest of what `store ci` prints is a job of its own, and around this step it would keep fixes from opening: its `run:` step tests first and fails the job on a failed check, so this step never runs; its checkout leaves a pull request's job on a detached merge commit; and its `contents: read` can't push a fix's branch. This step runs the tests itself and pushes them as that `run:` step does, so a workflow that already has the `store ci` job can put this step in place of its `run:` step, with the permissions and the checkout the fix needs.

Cloudflare R2 has no OIDC, and an R2 token can't be kept to a pull request's folder. A pull request's job runs the agent as the pull request changed it, so it never gets the keys: for an R2 store, the step gives `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`, from the repository's secrets, only to jobs that aren't a pull request's, and pushes only from those, as `store ci` writes it for R2:

```yaml
# the job needs: permissions: { contents: write, pull-requests: write }
# and R2 keys as secrets: they can't be kept to pr/, so pull requests don't push
- uses: actions/checkout@v7
  with:
    ref: ${{ github.head_ref || github.ref }}
- uses: actions/setup-node@v7
  with:
    node-version: 22
- run: npm ci && npm run build   # whatever your agent needs to run
- run: npm install -g @anthropic-ai/claude-code
- uses: devjoinedthechat/shadowlap@v0.1.0
  with:
    version: 0.1.0
    recordings: goldens/*
    fix-on-failure: true
    fix-budget: 2.00
    repairer: claude-code
    push: ${{ !startsWith(github.event_name, 'pull_request') }}
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    R2_ACCESS_KEY_ID: ${{ !startsWith(github.event_name, 'pull_request') && secrets.R2_ACCESS_KEY_ID || '' }}
    R2_SECRET_ACCESS_KEY: ${{ !startsWith(github.event_name, 'pull_request') && secrets.R2_SECRET_ACCESS_KEY || '' }}
    # and your agent's own provider keys: blame and verify run it live
```

A pull request's job then tests and opens its fix, and says nothing about the team store. That condition lives in the workflow file, which a pull request can edit; to keep the keys from a pull request's workflow altogether, put them in an environment only protected branches can use, for a job of its own on those branches, as `store ci`'s note for R2 says.

A push that can't happen never fails the job and never keeps a fix's pull request from opening: the pull request is opened first, and the push comes after it. The job summary says *in the team store* beside each fix that `shadowlap push` reported sending; beside one that didn't go, *not in the team store*, with why under the table (no store set, no credentials, the store out of reach, or a push that didn't report sending it), and the job's log has it as a warning. A team that turned Push from CI off is told so, without a warning. The test runs' push is what `shadowlap test --push` always does: a warning when it can't happen, and the tests decide the job.

- **A pull request's own job** writes only to [its own folder](./team.md#pull-requests), `pr/<number>/`, and sends no fixes: with short-lived credentials the job's runs go there, and the summary says the fix stays off the team's Fixes page; with R2 it pushes nothing. Fixes reach the team from jobs on your branches, such as `main`.
- **A pull request from a fork** gets no secrets, no OIDC token and a read-only `GITHUB_TOKEN` from GitHub, so its job can't sign in to the bucket or push a fix's branch: it opens no fix pull request and pushes nothing. The pull request's credentials step that `shadowlap store ci` prints is only for pull requests from your own repository (its `if:` compares the pull request's head repository with yours), so it can't fail a fork's job: the job goes on to this step, the test runs' push warns that there are no credentials, and the tests decide the job. Where a fork's job does open a fix but can't push it, the warning says the pull request is from a fork.

## Alerts

To hear about failures in Slack, let the action count them without failing, post the count, then fail the job:

```yaml
- uses: actions/checkout@v7
- uses: actions/setup-node@v7
  with:
    node-version: 22
- run: npm ci && npm run build   # whatever your agent needs to run
- uses: devjoinedthechat/shadowlap@v0.1.0
  id: goldens
  with:
    version: 0.1.0
    recordings: goldens/*
    fail-on-divergence: false

- name: Tell Slack
  if: steps.goldens.outputs.failed != '0' && github.ref == 'refs/heads/main'
  uses: slackapi/slack-github-action@v4
  with:
    webhook: ${{ secrets.SLACK_WEBHOOK_URL }}
    webhook-type: incoming-webhook
    payload: |
      text: "Shadowlap: ${{ steps.goldens.outputs.failed }} golden(s) failed on ${{ github.ref_name }}. ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"

- name: Fail the job
  if: steps.goldens.outputs.failed != '0'
  run: exit 1
```

They need an incoming webhook from your Slack workspace, its URL as a repository secret (`SLACK_WEBHOOK_URL` here), the test step's `id`, and Node 22.16 or later, not 23. A golden that runs live, one marked `fork` (a gate's golden is one) or with an [injection gate](#injection-gates), needs its providers' keys in the test step's `env`, or it fails and Slack hears of it on every run: the dashboard's Settings → CI adds them by name, from the providers those goldens' recordings called and their judges' (`2 goldens run live (fork) · ANTHROPIC_API_KEY`), and where it can't name them, a comment in that `env` says to add your agent's own. The `github.ref` condition keeps pull requests quiet, since their checks already show a failure; drop it to post for every branch. The dashboard's Settings → CI writes your repository's default branch there, and as the base of a fix pull request: the branch origin's HEAD names, else `main` or `master`, whichever the repository has. A golden counts as failed when its replay diverges, it tries a live call where it must replay offline, the agent exits with an error, a check fails (token and cost budgets included) or its injection gate fails, and when a gate, a judge or an injection test can't decide (inconclusive), unless the step says `inconclusive: warn`. Settings → CI's **An inconclusive golden** (**Fails** or **Warns**) sets that for both steps. While `shadowlap.config.json` can't be read, Settings → CI says so, and each step says in its `env` what it leaves out until the file is fixed: which goldens run live and their keys, and whether Fix on failure pushes.

## One job for all of it

Fix on failure, Alerts and the team store's push are inputs and steps around one run of the goldens, so they go in one job: the action runs once, with `id: goldens`, and the steps you turned on follow it. The dashboard's Settings → CI writes it from its switches (**Fix pull requests**, **Tell Slack**, **Team store**, which follows Push from CI, and **An inconclusive golden**):

```yaml
# the job needs: permissions: { contents: write, pull-requests: write, id-token: write }
- uses: actions/checkout@v7
  with:
    ref: ${{ github.head_ref || github.ref }}
- uses: actions/setup-node@v7
  with:
    node-version: 22
- run: npm ci && npm run build   # whatever your agent needs to run
- run: npm install -g @anthropic-ai/claude-code
# here, the bucket's credentials: the two if: steps shadowlap store ci prints
- uses: devjoinedthechat/shadowlap@v0.1.0
  id: goldens
  with:
    version: 0.1.0
    recordings: goldens/*
    fail-on-divergence: false
    fix-on-failure: true
    fix-budget: 2.00
    repairer: claude-code
    push: true
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    # and your agent's own provider keys: blame and verify run it live

- name: Tell Slack
  if: steps.goldens.outputs.failed != '0' && github.ref == 'refs/heads/main'
  uses: slackapi/slack-github-action@v4
  with:
    webhook: ${{ secrets.SLACK_WEBHOOK_URL }}
    webhook-type: incoming-webhook
    payload: |
      text: "Shadowlap: ${{ steps.goldens.outputs.failed }} golden(s) failed on ${{ github.ref_name }}. ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"

- name: Fail the job
  if: steps.goldens.outputs.failed != '0'
  run: exit 1
```

With Slack on, the action counts the failures without failing the step (`fail-on-divergence: false`), so a fix can open and Slack can hear of it before **Fail the job** fails it; with Slack off, the action fails the job itself. Each part needs what its section above says, once: the job's permissions add up, and its `env` holds every golden's keys while Fix on failure is on (blame and verify run the agent live), else those of the goldens that run live. With Push from CI on, the step pushes whichever parts are on, so the store setup's CI step (Settings → Store) gives this job the bucket's credentials alone, the two `if:` steps `shadowlap store ci --provider github` prints, where the comment stands: no second job runs the goldens again.

## Keeping goldens honest

- **Values an agent makes anew on every run** (a request id, a per-run UUID, a temp path) diverge on the first CI run. Run [`shadowlap calibrate`](./normalizers-and-redaction.md#calibrate) on a recording before you pack it, or add the [normalizer](./normalizers-and-redaction.md) the report suggests; normalizers apply at match time, so old goldens keep working. Today's date in a prompt needs neither: [dates near a run's start](./normalizers-and-redaction.md#dates-and-times) already match.
- **Intended changes** to a prompt fail the test, which is the point. [Update the golden](#update-a-golden-after-an-intended-change) with `shadowlap test --update`, and review the new recording in the pull request like any other snapshot. `shadowlap show --json` of the two runs diffs well. When what matters is the outcome rather than the exact requests, mark the recording [`fork`](#recordings-that-fork-on-purpose) and give it checks instead.
- **Tool fixes** don't change requests, so they don't fail the test; the recorded result is still served. If the fix should change behavior, re-record.
- Keep goldens small and specific. The repository's 30-call reference run packs to 79 files and 64 KB.
- **Review goldens like code.** `shadowlap test` runs the command recorded in each pack, without asking. That's safe for goldens committed to your repository, because a pull request that edits a golden could edit your CI scripts just as easily. Don't point it at packs from anywhere else before reading their `run.json`.

## Strict replays outside `test`

`shadowlap replay <run> --strict` exits 1 on divergence, or when the replay ends early, and is the same check against a run in the local store, for scripts and pre-commit hooks.
