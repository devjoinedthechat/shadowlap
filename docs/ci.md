# CI mode

`shadowlap test` turns a recording into a regression test: the agent must still send exactly the requests it sent when the recording was made. It catches unintended prompt changes, tool-argument drift and loop changes, at zero token cost and with no network.

## Make a golden

Record a run you consider correct, then pack it into the repository:

```sh
shadowlap run -- node dist/agent.js --task "triage inbox"
shadowlap pack 01K5CQ4N7G goldens/triage-inbox
git add goldens/triage-inbox
```

A pack is a directory: `run.json`, `calls.jsonl`, one file per blob. It's git-friendly (stable file names, one file per message), and [redaction rules](./normalizers-and-redaction.md#redaction) are applied on export. Commit only what you'd be comfortable with a colleague reading.

## Run it

```sh
shadowlap test goldens/* --junit shadowlap-junit.xml
```

For each pack, `shadowlap test` imports it into the project's store, re-runs the recorded command under a replay sidecar with **every provider set to offline**, and passes only if the replay is clean and the process exits 0. A divergence prints the report; a live call is refused with a 503 that names the call; both fail the pack. `--online` allows live calls after a divergence if you really want them; `--cwd` sets the working directory for the recorded commands; `--writes` sets the write policy. A `*` in the last part of a path is expanded by `shadowlap test` itself, so `'goldens/*'` works without a shell.

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
✓ triage-inbox: 30/30 replayed, 12k input tokens not re-spent

1 passed, 1 failed · 0 upstream requests
```

Besides dates, UUIDs and ULIDs, the report names the normalizer for an id the agent makes anew on every run: one that looks generated (16 or more hex digits, a prefix with a random tail such as `req_8f3a2c1d9e7b`, a long random token), or one under a key that names a request, a trace, a span, a session, a nonce or an idempotency key. Any other id that changed, such as a customer's number or an order's code, may be a real change: the agent acting on another customer is what the test is there to catch. The report says so, and gives the normalizer only for when you know that id changes on every run; a normalizer would hide a real change from every later test.

The JUnit report renders in GitHub, GitLab and most CI dashboards; each pack is a test case, and a failure carries the divergence report and the agent's output.

## Test history

Each `shadowlap test` is a session, kept in the project's store (`.shadowlap/shadowlap.db`, created if needed): the command as you gave it, the revision it tested, when, how many goldens passed and failed, and the upstream requests it made (0 for goldens that replay offline). For each golden the session keeps its result and why it failed: a divergence, with the report as printed; a failed check, with every check; a non-zero exit; or a replay that made no calls. Over time that is each golden's result at each revision. A golden is named by its pack directory relative to the project, so its history follows it as long as it stays there.

The replays a session makes are runs like any other, marked as made by `shadowlap test` for that golden, so you can open one: each prints `replaying run <id>` as it starts, and the JSON report (`--json`) names the session, each golden's replays and the recording it replayed. So the store doesn't fill with clean replays, only the newest one of each golden is kept; every replay that failed stays, with the last clean one before it, as does any replay you labelled, noted or forked. What a removed replay alone held, such as the live answers of a recording that may fork, goes with the next `shadowlap gc`, which is safe to run when nothing is recording. Global `--db :memory:` (given before `test`) keeps nothing.

Ctrl-C, or a dashboard job being stopped, cuts short the replay running at that moment: its agent gets the signal, with everything the agent started. The goldens after it don't run, and the session ends with the results of the ones that finished, marked as interrupted; the golden that was cut short gets no result, since a replay stopped halfway says nothing about it. `shadowlap test` then exits 130 (143 for SIGTERM), and the next session prunes the replay that was cut short.

The dashboard's **Tests** page shows this history: each golden's result at each recent revision, the verdict with the newest session that ran every golden (and any golden run again on its own since), and each failure as printed, with buttons that add the normalizer, update the golden or find the commit ([dashboard](./dashboard.md#actions)). A session's process is kept in the store while it runs, so a session started in a terminal reads as running there.

A CI job's store usually goes with the job. To keep CI's runs, `shadowlap test --push` sends every test run, with the golden it replayed, and the session's report to your [team store](./team.md#push-from-ci), a bucket you own, before any replay is pruned; teammates bring the runs to their machines with `shadowlap pull`. A pull request's job writes only to [its own folder](./team.md#pull-requests) in the store.

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
- **Models vary.** `repeat` runs the recording that many times, and `passes` (default: all of them) is how many must pass. The report shows how each attempt did.
- **Without the change** a `fork` recording replays clean, and its checks apply to the recording as it is. Adding the checks before the fix is a quick way to see them fail.

Checks work the same on recordings that don't fork: they then describe the recording itself and cost nothing.

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
✓ refund-flow: 31/31 replayed, 12k input tokens not re-spent (updated)
```

Only goldens that diverged are updated. One that fails a check, or exits with an error, is left alone: the agent needs the fix, not its golden. When what diverged is a value the agent makes anew on every run, such as a UUID, a date or a request id, updating only moves the problem to the next run, and `--update` says so, naming the path and the [normalizer](./normalizers-and-redaction.md) that fixes it for good (for an id that may be a real change, it says that the update records the new one, and gives the normalizer for the case where it changes every run):

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
- History is followed by first parents, so a merged branch counts as its merge commit. A `--good` commit on another branch works from where the two histories meet, which is checked like any good commit. The worktrees are removed after each replay, and on Ctrl-C.

## GitHub Actions

The Shadowlap action is the one step to add after your agent is built:

```yaml
- uses: actions/checkout@v4
- uses: actions/setup-node@v4
  with: { node-version: 22 }
- run: npm ci && npm run build          # whatever your agent needs to run
- uses: devjoinedthechat/shadowlap@main
  with:
    recordings: goldens/*
```

It replays each recording offline and fails the check when one diverges, makes a live call, exits with an error or fails a check. The job summary gets a table of the recordings, and for each failure the diff of the first changed request, the normalizer hint if there is one, and the agent's last output lines; when a recording diverged, it names the `shadowlap test <dir> --update` command for a change you meant. Each failure is also annotated on the pull request.

A Python agent needs its interpreter and packages installed before the action, as for any other step. The action itself needs Node 22.13 or later.

Pin the action to a release tag once there is one. Until `shadowlap` is on npm, the action builds the CLI from its own source, which adds about a minute; after the release, set `version:` to install it from npm instead.

| Input | Default | Effect |
|---|---|---|
| `recordings` | `goldens/*` | Recording directories, separated by spaces or new lines; `*` is allowed in the last part of a path |
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
| `push` | `false` | Push every test run and the session's report to the [team store](./team.md#push-from-ci) set in `shadowlap.config.json` (`shadowlap test --push`), and each fix that `fix-on-failure` opens; the job needs credentials for the bucket |
| `fix-on-failure` | `false` | Open a fix pull request when a golden fails an outcome check ([below](#fix-on-failure)) |
| `fix-budget` | `2.00` | Dollars that may be spent per failing golden on finding and proving a fix |
| `repairer` | empty | The model that proposes fixes, as for `shadowlap repair --repairer`; empty uses `repair.repairer` in the config |

Outputs: `passed`, `failed` (every failure), `diverged`, `checks-failed`, `session` (the test session's id), `fixes` and `fix-prs` (the fix pull requests opened, and their URLs), and the paths `report-json`, `report-markdown` and `junit`.

The action reads `tests` from `shadowlap.config.json` in the working directory. A recording marked `fork` calls the providers after the fork, so pass their keys to the step as environment variables (`env: ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}`).

When a recording fails and the logs aren't enough, keep the failed replay as a file to open. The action replays into a store it throws away, so these steps install the `shadowlap` CLI, replay again into a store they keep (`--db`), take the first recording that failed from the JSON report, and export its replay together with the recording. Of several attempts they take one that failed. A recording marked `fork` runs live again here. When nothing fails on the second run, the step says so and the upload finds no file.

```yaml
- if: failure()
  run: |
    # Until shadowlap is on npm; after that: npm install -g shadowlap@<version>
    git clone --depth 1 https://github.com/devjoinedthechat/shadowlap "$RUNNER_TEMP/shadowlap"
    cd "$RUNNER_TEMP/shadowlap" && npm ci && npm run build && npm link --workspace packages/cli
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
  uses: actions/upload-artifact@v4
  with: { name: shadowlap-run, path: failed-run.html }
```

On other CI systems, run the CLI directly. `--junit`, `--json` and `--markdown` write reports, as described in the [CLI reference](./cli.md#test).

## Fix on failure

When a golden fails an outcome check in CI, the action can propose the fix itself: it runs `shadowlap repair` on the failing replay, which blames it (finds the model call where it was lost), asks the repairer to rewrite the prompt or a tool description, and keeps a rewrite only when `verify` accepts it. A fix verify accepted becomes a pull request with the patch and its report.

A fix changes what the agent sends, so a golden that must replay exactly would diverge on the fix's own branch and fail the pull request's checks. The pull request's one commit therefore carries the golden re-recorded under the fix too: the recording verify accepted replaces the golden's pack (`run.json`, `calls.jsonl`, `blobs/`; other files in its folder stay), once it replays clean with the fix applied, which the action checks in its working tree before it pushes. When it can't, the golden stays as it was, and the pull request and the job summary say to run `shadowlap test <golden> --update` on the branch. A golden marked `fork` is left as it is: it passes on its checks from wherever it diverges. The step:

```yaml
# the job needs: permissions: { contents: write, pull-requests: write }
- run: npm install -g @anthropic-ai/claude-code
- uses: devjoinedthechat/shadowlap@main
  with:
    recordings: goldens/*
    fix-on-failure: true
    fix-budget: 2.00
    repairer: claude-code
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    # and your agent's own provider keys: blame and verify run it live
```

It needs:

- a model key for the repairer: `ANTHROPIC_API_KEY` for `claude-code` and `anthropic`, `OPENAI_API_KEY` for `openai:<model>`. The `claude-code` repairer runs Claude Code in print mode, so the runner needs it installed, which the first step does; `anthropic` and `openai:<model>` need nothing installed;
- your agent's own provider keys in the same `env`, as for `shadowlap run`: blame re-runs the failing replay live from the call it probes, and verify runs the agent with the fix. An agent on OpenAI with the `anthropic` repairer needs `OPENAI_API_KEY` as well as `ANTHROPIC_API_KEY`; without its keys, blame fails and no fix is proposed;
- permission to push a branch (`contents: write`) and to open the pull request (`pull-requests: write`), in the job's `permissions`, and `GH_TOKEN` for `gh`;
- a branch checked out. A pull request's own workflow checks out a detached merge commit, so check out its branch, and the fix becomes a pull request into it:

```yaml
- uses: actions/checkout@v4
  with:
    ref: ${{ github.head_ref || github.ref }}
```

It never opens a pull request for a divergence (most are intended: [update the golden](#update-a-golden-after-an-intended-change) or add a normalizer), never keeps a fix that verify rejected, never spends past the budget (each failing golden gets `fix-budget` dollars for blame, the repairer and verify together, and repair starts nothing once it is spent), and never merges anything: you review every fix. A failed check still fails the build. The job summary lists each failing golden with the pull request opened (and whether its golden was re-recorded), or why there is none, and what it spent of its budget. The fix commit is made by GitHub's Actions bot when git has no identity of its own on the runner. A session stopped by a signal, as when the job is cancelled, starts no fix. The fix in the store the job used (the `store` input) records the pull request it went to (`shadowlap fix pr`), so a dashboard on that store lists it as *from CI · PR #138*, and once the pull request is merged or closed, *from CI · PR #138 merged*: the dashboard reads its state from GitHub with `gh`, in the background, while Fixes is open. A job's store usually goes with the job, so to reach your teammates the fix has to travel: with `push: true` and a [team store](./team.md) set in `shadowlap.config.json`, the action pushes the test runs as `shadowlap test --push` does, and once a fix's pull request is open, every run the job made (`shadowlap push --all`), which takes the fix with its blame, repair and verdicts along. A teammate's `shadowlap pull` then brings it to their Fixes page. The job summary says *in the team store* beside each fix that went; one that couldn't (no store set, or the team turned [pushing from CI](./team.md#push-from-ci) off) says why in the job's log, and the job's result is the tests' all the same. A pull request's own job writes only to [its own folder](./team.md#pull-requests) and sends no fixes.

## Alerts

To hear about failures in Slack, let the action count them without failing, post the count, then fail the job:

```yaml
- uses: devjoinedthechat/shadowlap@main
  id: goldens
  with:
    recordings: goldens/*
    fail-on-divergence: false

- name: Tell Slack
  if: steps.goldens.outputs.failed != '0' && github.ref == 'refs/heads/main'
  uses: slackapi/slack-github-action@v2
  with:
    webhook: ${{ secrets.SLACK_WEBHOOK_URL }}
    webhook-type: incoming-webhook
    payload: |
      text: "Shadowlap: ${{ steps.goldens.outputs.failed }} golden(s) failed on ${{ github.ref_name }}. ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"

- name: Fail the job
  if: steps.goldens.outputs.failed != '0'
  run: exit 1
```

They need an incoming webhook from your Slack workspace, its URL as a repository secret (`SLACK_WEBHOOK_URL` here), and the test step's `id`. The `github.ref` condition keeps pull requests quiet, since their checks already show a failure; drop it to post for every branch. A golden counts as failed when its replay diverges, it tries a live call, the agent exits with an error, or a check fails (token and cost budgets included).

## Keeping goldens honest

- **Values an agent makes anew on every run** (a request id, a per-run UUID, a temp path) diverge on the first CI run. Run [`shadowlap calibrate`](./normalizers-and-redaction.md#calibrate) on a recording before you pack it, or add the [normalizer](./normalizers-and-redaction.md) the report suggests; normalizers apply at match time, so old goldens keep working. Today's date in a prompt needs neither: [dates near a run's start](./normalizers-and-redaction.md#dates-and-times) already match.
- **Intended changes** to a prompt fail the test, which is the point. [Update the golden](#update-a-golden-after-an-intended-change) with `shadowlap test --update`, and review the new recording in the pull request like any other snapshot. `shadowlap show --json` of the two runs diffs well. When what matters is the outcome rather than the exact requests, mark the recording [`fork`](#recordings-that-fork-on-purpose) and give it checks instead.
- **Tool fixes** don't change requests, so they don't fail the test; the recorded result is still served. If the fix should change behavior, re-record.
- Keep goldens small and specific. The repository's 30-call reference run packs to 79 files and 64 KB.
- **Review goldens like code.** `shadowlap test` runs the command recorded in each pack, without asking. That's safe for goldens committed to your repository, because a pull request that edits a golden could edit your CI scripts just as easily. Don't point it at packs from anywhere else before reading their `run.json`.

## Strict replays outside `test`

`shadowlap replay <run> --strict` exits 1 on divergence and is the same check against a run in the local store, for scripts and pre-commit hooks.
