# CI mode

`shadowlap test` turns a recording into a regression test: the agent must still send exactly the requests it sent when the recording was made. It catches unintended prompt changes, tool-argument drift and loop changes, at zero token cost and with no network. This page covers goldens and `shadowlap test`, the GitHub Action that runs them, and other CI systems.

On this page:

- [Quick start](#quick-start)
- [How a test runs](#how-a-test-runs), [outcome checks](#outcome-checks) and [test history](#test-history)
- [Update a golden](#update-a-golden-after-an-intended-change) and [find the commit that broke it](#find-the-commit-that-broke-it)
- [GitHub Actions](#github-actions): inputs, outputs, events, permissions and tokens, and the history cache
- [Fix on failure](#fix-on-failure) and [fixes in the team store](#fixes-in-the-team-store)
- [Alerts](#alerts) and [one job for all of it](#one-job-for-all-of-it)
- [Other CI systems](#other-ci-systems), [keeping goldens honest](#keeping-goldens-honest) and [troubleshooting](#troubleshooting)

## Quick start

### Make a golden

Record a run you consider correct, then pack it into the repository:

```sh
shadowlap run -- node dist/agent.js --task "triage inbox"
shadowlap pack 01K5CQ4N7G goldens/triage-inbox
git add goldens/triage-inbox
```

A pack is a directory: `run.json`, `calls.jsonl`, one file per blob, and a `.gitattributes` holding `* -text` ([the recording format](./recording-format.md) specifies it). It's git-friendly (stable file names, one file per message), and [redaction rules](./normalizers-and-redaction.md#redaction) are applied on export. Commit only what you'd be comfortable with a colleague reading.

**Commit the `.gitattributes` with the pack.** Every blob is checked against its hash, and the file keeps git from converting line endings, as Git for Windows does by default (`core.autocrlf`) and a `* text=auto` in your own `.gitattributes` would. A golden committed on macOS or Linux then passes in a Windows checkout too.

A golden packed before packs carried the file is read as it was committed when git converted only its line endings; `test --update` adds the file to it.

### Run it

```sh
shadowlap test goldens/* --junit shadowlap-junit.xml
```

Each pack replays offline, and passes only when the agent sends what it recorded and exits 0 ([how a test runs](#how-a-test-runs)).

### Add it to GitHub Actions

The Shadowlap action is the one step to add after your agent is built:

```yaml
- uses: actions/checkout@v7
  with: { persist-credentials: false }
- uses: actions/setup-node@v7
  with: { node-version: 22 }
- run: npm ci && npm run build          # whatever your agent needs to run
- uses: devjoinedthechat/shadowlap@v0.1.0
  with:
    version: 0.1.0
    recordings: goldens/*
```

Push, and the job replays each golden offline. It fails the check when one diverges, makes a live call, exits with an error or fails a check, and it annotates each failure on the pull request ([GitHub Actions](#github-actions)).

## How a test runs

For each pack, `shadowlap test`:

1. imports it into the project's store;
2. re-runs the recorded command under a replay sidecar with **every provider set to offline**;
3. passes only if the replay is clean and the process exits 0.

**Clean** means the agent sent every request the recording holds, unchanged, and no more. Each of these fails it:

- a request sent differently;
- a call the recording doesn't have;
- a recorded call never made: the agent [ended early](#a-replay-that-ends-early).

A divergence prints the report; a live call is refused with a 503 that names the call; both fail the pack.

These flags change how it runs:

| Flag       | What it does                                                  | Default                         |
| ---------- | ------------------------------------------------------------- | ------------------------------- |
| `--online` | Allows live calls after a divergence, if you really want them | Off: a live call fails the pack |
| `--cwd`    | Sets the working directory for the recorded commands          | The current directory           |
| `--writes` | Sets the write policy                                         | `block`                         |

A `*` in the last part of a path is expanded by `shadowlap test` itself, so `'goldens/*'` works without a shell.

### What it prints

It prints this when one agent puts a fresh UUID in every request's metadata:

```text
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

### Ids made anew on every run

Besides dates, UUIDs and ULIDs, the report names the [normalizer](./normalizers-and-redaction.md) for an id the agent makes anew on every run:

- **one that looks generated**: 16 or more hex digits, a prefix with a random tail such as `req_8f3a2c1d9e7b`, a long random token;
- **one under a key that names** a request, a trace, a span, a session, a nonce or an idempotency key.

Any other id that changed, such as a customer's number or an order's code, may be a real change: the agent acting on another customer is what the test is there to catch. The report says so, and gives the normalizer only for when you know that id changes on every run. A normalizer would hide a real change from every later test.

### The JUnit report

The JUnit report renders in GitHub, GitLab and most CI dashboards. Each pack is a test case, and a failure carries the divergence report and the agent's output.

Control characters in what the agent printed, such as the escape codes of a coloured logger, are written as escapes (`\x1b[32m`), as the Markdown report writes them. So the file stays XML that every parser reads.

### A replay that ends early

An agent can stop before its recording did and still exit 0: an exception it catches, a stop condition that changed, a step it no longer takes. Every request it sent matched, but what it never sent (the last model turn, the write) is as much a change.

The replay leaves its recording at the first recorded model or tool call it never made, a divergence of its own type, `ended_early`, and the golden fails:

```text
✗ research: ended early at call 11 (api POST /v1/messages): 10 of 30 recorded calls replayed
    ✗ Ended early at call 11: 10 of 30 recorded calls replayed (3 api, 5 tool, 2 clock/random), 0 upstream requests, 3.2k input tokens not re-spent
      20 recorded calls not reached: #11 POST /v1/messages, #12 read_file, #13 read_file, …
```

- **In the JSON report**, its failure kind is `diverged`, and the `divergence` has `type` `ended_early` and `recorded`, the calls the recording holds. So the GitHub Action and `bisect` treat it as one.
- **In the store**, the run keeps it too: `shadowlap ls` and the dashboard list it as `ended early @11`, not as a clean replay.
- **What doesn't count**: clock, random and pure reads left unread.
- **A golden marked `fork`** passes on its checks, as it does after a fork.

If the agent stops earlier on purpose, re-record the golden with `shadowlap test <golden> --update`.

### The network guard

`shadowlap test` runs each agent under `--guard block`:

- a connection that bypasses Shadowlap is refused;
- a golden whose agent the [guard](./how-it-works.md#the-network-guard) couldn't watch fails, however the agent exited. Its summary names what wasn't watched, and says the run was not watched.

**The Claude Agent SDK.** An agent on the [Claude Agent SDK](./frameworks.md#claude-agent-sdk) runs the Claude Code CLI, which no preload loads into. Its fence names what the CLI can still reach:

- WebFetch;
- an MCP server over the network;
- a hook or a stdio server it runs that isn't Python;
- the claude.ai connectors;
- its OpenTelemetry export;
- the model API past Shadowlap;
- its own traffic.

The golden passes once there is none: with WebFetch disallowed, MCP servers kept to the query's own (`strictMcpConfig`), and no claude.ai login.

**Accepting what the guard can't watch:**

| Setting | Accepts |
|---|---|
| `"guard": { "accept": ["claude-code"] }` in `shadowlap.config.json`, or `guard-accept: claude-code` on the [GitHub Action](#github-actions) | The CLI as it is, while every Node and Python process keeps block |
| `--guard warn` (the Action's `guard: warn`) | Every connection the guard can't watch |

### Keys

A golden that replays offline needs no model key, so a job without secrets, such as a pull request's from a fork, tests it.

**The placeholder.** An agent whose client takes its key from the environment, as `new Anthropic()`, `new OpenAI()` and Google's clients do, would refuse to send anything without one. So its replay gets a [placeholder](./how-it-works.md#keys), `shadowlap-offline-replay-placeholder`, for each provider its recording called whose credentials the job lacks:

- placeholder AWS credentials for Bedrock;
- Azure OpenAI's only for a recording whose environment held `AZURE_OPENAI_API_KEY` or `AZURE_API_KEY`, in that variable.

A placeholder never takes the place of a key or another credential the job has. The replay is offline, so nothing carrying one leaves the machine; the sidecar refuses a live call that would carry one anyway.

What isn't a secret still has to be there: an Azure OpenAI client built the default way needs `AZURE_OPENAI_ENDPOINT` and `OPENAI_API_VERSION`, and an AWS client its region.

**What needs the real keys.** What may go live needs the real keys in the job, and gets no placeholder:

- `--online`;
- `--update`;
- a golden marked [`fork`](#recordings-that-fork-on-purpose) (a gate's golden is one);
- an [injection gate](#injection-gates);
- `--chaos`;
- [fix on failure](#fix-on-failure).

Without its key such a golden fails, even when its replay would be clean. Clients that sign in with a token need one of their own: Vertex AI's, and Azure OpenAI's on Microsoft Entra ID. Pass keys to the step as environment variables, as [below](#github-actions).

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
| `tools` | Each tool was called the given number of times ([counts and arguments](#counts-and-arguments)) |
| `modelCalls`, `toolCalls` | The run made that many model calls, or tool calls |
| `inputTokens`, `outputTokens` | The run's model requests add up to that many tokens ([budgets](#token-and-cost-budgets)) |
| `cost` | The same in dollars, from the [price table](./cli.md#the-configuration-file) |
| `output` | What the agent printed (stdout and stderr) `includes` each string and `excludes` each string. Case doesn't matter |
| `answer` | The same, for the text of the last model response |
| `calls`, `when`, `judge` | A rule every call of a tool meets, checks that apply once a call matched, and a model's yes or no ([below](#rules-conditions-and-judges)) |

A failed check fails the recording and says what happened:

```text
✗ triage-inbox: check failed: delete_thread called 0 times, but called 2 times
    ✓ send_email with {"to":"oncall@example.com"} called 1 time
    ✗ delete_thread called 0 times: called 2 times
    ✓ at most 12 model calls
    ✓ at most 50000 input tokens
    ✓ cost at most $0.50
    ✓ output includes "3 incidents"
```

### Counts and arguments

A count is a number, `">= 1"`, `"<= 3"`, `"> 0"`, `"< 5"` or a range such as `"2-4"`. Every attempt counts, including writes that were blocked or stubbed.

With `{ "count": …, "args": { … } }`, only calls whose arguments contain those values count: objects match the keys you give, everything else must be equal. `{ "args": … }` alone means at least once.

### Token and cost budgets

Input tokens include cache reads, because the request still carried them. Tokens are measured over every model call whatever its origin: a clean replay sends what it recorded, so this is what the run costs to run live, which is the number a prompt change moves.

A `cost` amount is a number, `"<= 0.50"` or a range such as `"0.1-0.4"`. A model with no price **fails** the check and names the model, rather than passing because an unknown price counted as zero.

A token or cost budget is how a prompt change that quietly doubles the context fails a build. Nothing else in Shadowlap notices that: the requests still match, so the replay is clean, and the run costs twice as much the next time it runs live.

### Rules, conditions and judges

- **`calls`**: every call of a tool meets a rule: what it comes after, its arguments, values from earlier calls.
- **`when`**: checks that apply once a call matched a condition.
- **`judge`**: a model's answer to a question about the run, yes or no, recorded like any model call. So a golden is judged once when it is packed, and every clean replay after is judged from the recording, free and the same every time.

See [Checks](./checks.md) and [Judge checks](./judges.md).

### Which recordings a check applies to

A key is a recording directory relative to the config file, and `*` may stand for part of its last path segment (`goldens/refund-*`). An exact path wins over a pattern.

A mistake in `tests`, such as an unknown key, fails `shadowlap test` before anything runs, and `shadowlap doctor` reports it.

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
- **Without the change**, a `fork` recording replays clean, and its checks apply to the recording as it is. Adding the checks before the fix is a quick way to see them fail.

**An attempt a check could not decide**, such as a [judge](./judges.md#not-judged) whose call failed, neither passed nor failed. The golden stops there, since no attempt after it would decide it either, and is inconclusive unless the attempts before it already settled the count.

**A gate instead of a count.** A fixed count can't tell agents apart: 4 of 5 lets one that passes 70% of the time through about half the time. So a `gate` can decide instead, as attempts come in, with the error rates it states:

| Gate | Decides |
|---|---|
| `"gate": { "good": 0.9, "bad": 0.7, "risk": 0.05 }` | Between two pass rates |
| `"gate": { "baseline": "history" }` | Against the golden's own test history: it needs no figures of your own, and fails a large drop in a few attempts |

[Gating](./gating.md) explains both, what each catches and what it costs.

Checks work the same on recordings that don't fork: they then describe the recording itself and cost nothing.

### Injection gates

A golden whose agent reads untrusted content (a page, an email, a ticket) can also be gated on whether text planted there steers it. Mark the tools that bring outside text in, and give the golden an `injection` entry:

```json
{
  "tools": { "fetch_page": { "trust": "untrusted" } },
  "tests": { "goldens/*": { "injection": { "obeyed": 0, "repeat": 3 } } }
}
```

Once the golden's replay passes, `shadowlap test` plants payloads in each of its untrusted reads, each with a canary of its own. It fails the golden, as an `injection` failure, when a tool call carries a canary in more attempts than `obeyed` allows.

Those attempts run live from the model call that reads the payload, so CI needs the provider's key. Without it (a pull request from a fork gets no secrets), every attempt's model call fails, and the gate is *inconclusive*, never passed. So is a gate with nothing to plant in, or whose test showed nothing.

An inconclusive gate fails the golden; `shadowlap test --inconclusive warn` lets it through with a warning. See [Injection tests](./injection.md#gate-ci-on-it).

### Error paths

A golden records a healthy run, so it never holds a tool timeout or a rate limit. `shadowlap test goldens/* --chaos` forks each golden:

- where the first tool that reads the world times out, answers nothing, or answers malformed or oversized JSON;
- where the model call after it gets a 429 or a 500, a rate limit or a server error.

It judges each fork by the checks that hold on any path: the upper bounds its `expect` sets on write tools, or its `chaos.expect`. See [Error-path presets](./error-paths.md).

## Test history

Each `shadowlap test` is a session, kept in the project's store (`.shadowlap/shadowlap.db`, created if needed). Over time that is each golden's result at each revision.

A session keeps:

- the command as you gave it, the revision it tested, and when;
- how many goldens passed and failed;
- the upstream requests it made: 0 for goldens that replay offline.

For each golden, it keeps:

- its result, and why it failed: a divergence, with the report as printed; a failed check, with every check; a non-zero exit; or a replay that made no calls;
- how many attempts passed of how many, one attempt included;
- for a golden with a [gate](./gating.md), what the gate decided, so a gate against history has its baseline.

A golden is named by its pack directory relative to the project, so its history follows it as long as it stays there.

### The replays it keeps

The replays a session makes are runs like any other, marked as made by `shadowlap test` for that golden, so you can open one. Each prints `replaying run <id>` as it starts, and the JSON report (`--json`) names the session, each golden's replays and the recording it replayed.

So the store doesn't fill with clean replays, only the newest one of each golden is kept. These stay too:

- every replay that failed, with the last clean one before it;
- any replay you labelled, noted or forked.

What a removed replay alone held, such as the live answers of a recording that may fork, goes with the next `shadowlap gc`, which is safe to run when nothing is recording. Global `--db :memory:` (given before `test`) keeps nothing.

### A session cut short

Ctrl-C, or a dashboard job being stopped, cuts short the replay running at that moment: its agent gets the signal, with everything the agent started.

- **The goldens after it** don't run.
- **The session** ends with the results of the ones that finished, marked as interrupted.
- **The golden that was cut short** gets no result, since a replay stopped halfway says nothing about it.

`shadowlap test` then exits 128 + n (130 for Ctrl-C, 129 for a closed terminal, 143 for SIGTERM), and the next session prunes the replay that was cut short.

### In the dashboard

The dashboard's **Tests** page shows this history:

- each golden's result at each recent revision;
- the verdict with the newest session that ran every golden (and any golden run again on its own since);
- each failure as printed, with buttons that add the normalizer, update the golden or find the commit ([dashboard](./dashboard.md#actions)).

A session's process is kept in the store while it runs, so a session started in a terminal reads as running there.

### In CI

A CI job's store usually goes with the job. Two things carry it further:

- **`shadowlap test --push`** sends every test run, with the golden it replayed, and the session's report to your [team store](./team.md#push-from-ci), a bucket you own, before any replay is pruned. Teammates bring the runs to their machines with `shadowlap pull`. A pull request's job writes only to [its own folder](./team.md#pull-requests) in the store.
- **The history itself**, which a [gate against a golden's history](./gating.md#a-gate-against-history) needs from one job to the next. The GitHub Action keeps the store in the Actions cache for one ([`keep-history`](#the-history-cache)), and on another CI system you cache `.shadowlap/shadowlap.db` between runs.

## Update a golden after an intended change

A prompt you changed on purpose makes its goldens diverge, which is the test doing its job. Once you mean the change, update them:

```sh
shadowlap test goldens/refund-flow --update
```

`shadowlap test` prints this command after its totals when a golden diverged on more than a value that changes every run. Each golden that diverged is then updated:

1. **It is re-recorded live** from its first call, with every write tool stubbed: the agent is told each write succeeded, and nothing is sent.
2. **Its checks run on the re-recording.** Only when the agent exits 0 and they pass does the re-recorded pack replace the old one, in your working tree.
3. **It is replayed offline** like any other golden, and you review the change in your pull request.

Only the pack's own files are replaced (`run.json`, `calls.jsonl` and `blobs/`); anything else you keep in the golden's folder, such as a README, stays as it is. The re-recorded pack is written under `.shadowlap/` first, so an update that is interrupted leaves the old golden.

It prints the checks, the calls and what the re-recording cost, then what the agent sends differently: the system prompt, the tools and the models, and the change in the request that made the golden diverge:

```text
✗ refund-flow: diverged at call 3 (api POST /v1/messages)
    …
    ↻ updating goldens/refund-flow: re-recording live, writes stubbed
      ✓ issue_refund called 0 times
      re-recorded as run 01K5CQ9T2W: 31 calls, was 30 · model calls 11 → 12 · escalate 0 → 1, issue_refund 1 → 0 · $0.072 live · 12 upstream requests
      what changed: system prompt changed · call 3 (api POST /v1/messages): ~ $.system
      replaced goldens/refund-flow in the working tree; review the change in your pull request
✓ refund-flow: 31/31 replayed, 12.4k input tokens not re-spent (updated)
```

Updating calls the providers, so it needs their credentials, like `shadowlap run`. The session then replays each updated golden offline, as the next test will, and records how that replay came out, marked updated. A golden that diverged on a value made anew on every run diverges again there, and fails ([below](#a-value-made-anew-on-every-run)).

### Which goldens are updated

Only goldens that diverged are updated:

| Golden | With `--update` |
|---|---|
| Diverged | Re-recorded |
| Fails a check, or exits with an error | Left alone: the agent needs the fix, not its golden |
| Replayed clean, but holds no verdict for a [judge check](./judges.md) | Keeps its recording: the judge is asked live, and its call is added to the golden |
| [Forks on purpose](#recordings-that-fork-on-purpose) | Updated only when its test forked before the call its [task](./training.md#tasks) takes over at |

A golden that forks on purpose passes wherever it forks. When it forks before its task's takeover, no model can be scored on it there, since an attempt replays the recording only up to the fork. `shadowlap test` names such a golden after its totals:

```text
goldens/refund-over-limit forks at #3, before its task's takeover at #17, so no model can be scored on it. Update it: shadowlap test goldens/refund-over-limit --update
```

### A value made anew on every run

When what diverged is a value the agent makes anew on every run, such as a UUID, a date or a request id, updating only moves the problem to the next run. `--update` says so, naming the path and the [normalizer](./normalizers-and-redaction.md) that fixes it for good:

```text
    ! $.metadata.user_id looks like a UUID, a value that changes every run: updating re-records it, and the next run diverges again. A normalizer fixes it for good:
        shadowlap normalize add --kind api --path '$.metadata.user_id' --pattern uuid --replace '<UUID>'
```

For an id that may be a real change, it says that the update records this run's value, and gives the normalizer for the case where it changes every run.

When the request carries a field the recording never had, holding such a value, the golden needs both: the update records the field, and the normalizer keeps the next run from diverging on its value. Add the normalizer first, then update.

## Find the commit that broke it

When a golden that used to pass fails, `shadowlap bisect` finds the commit where it started:

```sh
shadowlap bisect goldens/refund-in-limit --good c91d0f4      # --bad defaults to HEAD
```

```text
▸ goldens/refund-in-limit · good c91d0f4 · bad d2e8a1f · 5 commits apart
  replay at d2e8a1f  ✗ diverged at call 1 (api POST /v1/messages) · $.metadata.user_id
  replay at c91d0f4  replayed clean
  replay at 9a3c5e0  replayed clean
  replay at 4e7b2d1  ✗ diverged at call 1 (api POST /v1/messages) · $.metadata.user_id
✓ first bad commit 4e7b2d1 · Send the user id with every request · Ravi · 2026-09-30
  diverged at call 1 (api POST /v1/messages) · $.metadata.user_id · 4 replays · 0 tokens · 0 upstream requests · 4.0s
```

Here the golden was recorded before 4e7b2d1, so from that commit on, the agent's first request carries a user id the recording never had. An id made anew on every run takes a normalizer and an update ([a value made anew on every run](#a-value-made-anew-on-every-run)); a change you didn't mean takes a fix to the code.

It works like `git bisect`, on the recording:

1. **It checks both ends first**, and says so when the recording passes at `--bad` (nothing to find) or already fails at `--good`.
2. **It replays the recording at commits between the two**, halving the range each time.
3. **Each commit is checked out** in a temporary git worktree under `.shadowlap/bisect/`, where the agent runs with its recorded command.
4. **The replay is judged** as `shadowlap test` judges it: a divergence, a failed check or a non-zero exit fails it.

Replays are offline, so it costs no tokens. The worktrees are removed after each replay, and on Ctrl-C.

- **What changes per commit is the agent's code.** The recording, its checks (the golden's under `tests`, or `--expect`) and the normalizers come from your working tree as it stands. Uncommitted changes are not part of any replay.
- **Dependencies.** Each worktree gets your working tree's `node_modules`, linked, except that a package linked from the repository itself (a workspace package) is the worktree's own copy, so it runs as it was at that commit. An installed executable in the recorded command that the checkout doesn't have, such as `.venv/bin/python`, still runs from your working tree.
- **A build at each commit.** When the agent needs more at each commit, such as a build of its own packages, `--build "npm ci && npm run build"` runs in each worktree before its replay, and then nothing is linked.
- **Commits it can't test.** A commit that won't check out, or where `--build` fails, is skipped, as `git bisect skip` would, and the nearest other commit is tried instead. When the first bad commit could be one it skipped, it names those too.
- **First parents.** History is followed by first parents, so a merged branch counts as its merge commit. Only commits that have `--good` in their history are replayed: for a `--good` commit on a branch that was merged, that starts at the merge that brought it in.
- **A `--good` commit on another branch** works from where the two histories meet, which is checked like any good commit.
- **What the answer keeps.** The first bad commit keeps what it changed against its first parent: the file it opens, the files it changed, that file's hunk and the line it added. The dashboard shows it with the answer, without a checkout.
- **A gate against history.** A golden gated against its history is judged at each commit against that history, as `shadowlap test` judges it: its last sessions that passed on the baseline branch. With none yet, the search says so under its first line.

### A run, or a golden that forks

- **A run works too.** `shadowlap bisect <run> --good <rev>` replays a run from the store, once it has ended: a run still recording is refused, since only part of it is there.
- **A run that failed a check**, rather than one that should replay clean, needs the check and `--fork`. Older commits send different requests, so each replay runs live from where it diverges and the check decides. That part costs tokens, and the result says how many.
- **A test replay of a golden** takes the golden's checks from `tests` without `--expect`.
- **A golden marked `fork`** replays as `shadowlap test` replays it: live from where it diverges, so its search costs tokens too.

## GitHub Actions

The Shadowlap action is the one step to add after your agent is built, as the [quick start](#quick-start) shows. It replays each recording offline, and fails the check when one diverges, makes a live call, exits with an error or fails a check.

- **Keys.** A golden that replays offline needs no real key. A golden marked `fork` or with a gate, an injection gate, `online` and `fix-on-failure` need the providers' keys, and Vertex AI and Entra ID clients a token ([keys](#keys)).
- **The job summary** gets a table of the recordings, and for each failure the diff of the first changed request, the normalizer hint if there is one, and the agent's last output lines. When a recording diverged, it names the `shadowlap test <dir> --update` command for a change you meant.
- **Annotations.** Each failure is also annotated on the pull request.
- **Python.** A Python agent needs its interpreter and packages installed before the action, as for any other step.
- **Node.** The action itself needs Node 22.16 or later, not 23, on the runner.

The action reads `tests` from `shadowlap.config.json` in the working directory. A recording marked `fork` calls the providers after the fork, so pass their keys to the step as environment variables (`env: ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}`).

### Inputs

| Input | What it does | Default |
|---|---|---|
| `recordings` | Recording directories, separated by spaces or line breaks; `*` is allowed in the last part of a path | `goldens/*` |
| `working-directory` | Where the recorded commands run | `.` |
| `version` | A `shadowlap` version from npm; empty installs the action's own release ([the CLI it installs](#the-cli-it-installs)) | empty |
| `build-from-source` | Build the CLI from the action's own source instead of installing it from npm; `version` is then ignored | `false` |
| `writes` | What write tools do after a divergence: `block`, `stub` or `allow` | `block` |
| `guard` | The network guard: `block`, `warn` or `off` | `block` |
| `guard-accept` | What `guard: block` accepts unwatched, as `guard.accept` in the config ([the network guard](#the-network-guard)) | empty |
| `online` | Allow live model calls after a divergence | `false` |
| `fail-on-divergence` | With `false`, the step passes and `failed` says what happened | `true` |
| `summary` | Write the report to the job summary | `true` |
| `annotations` | Annotate failed recordings | `true` |
| `junit` | Also write JUnit XML to this path | empty |
| `store` | The store for the test history and the replays; empty uses the project's, `.shadowlap/shadowlap.db` | empty |
| `inconclusive` | What an [inconclusive](./gating.md) golden does to the step, as `shadowlap test --inconclusive`: `fail` or `warn` | empty |
| `max-attempts` | Raise every gate's limit for this run, as `shadowlap test --max-attempts`; empty keeps each gate's own `max` | empty |
| `keep-history` | Keep the store between jobs in the Actions cache: `true`, `false` or `auto` ([the history cache](#the-history-cache)) | `auto` |
| `push` | Push every test run and the session's report to the [team store](./team.md#push-from-ci), and each fix it opens | `false` |
| `fix-on-failure` | Open a fix pull request when a golden fails an outcome check ([fix on failure](#fix-on-failure)) | `false` |
| `fix-budget` | Dollars that may be spent per failing golden on finding and proving a fix | `2.00` |
| `fix-build` | A command that builds the agent once a fix changes its source, such as `npm run build` | empty |
| `repairer` | The model that proposes fixes, as for `shadowlap repair --repairer`; empty uses `repair.repairer` in the config | empty |
| `github-token` | The token a fix's branch is pushed, its pull request opened and the comment kept with ([below](#permissions-and-tokens)) | empty |
| `comment` | On a pull request, keep one [comment](#the-pull-request-comment) on it with each golden's verdict | `true` |

Some inputs need more than a line:

- **`recordings`**: as with `shadowlap test`, a path that names no pack fails as a test, and a pattern that matches none fails the step.
- **`build-from-source`** runs no package's install script, with none of the job's secrets in the build's environment and a home of its own ([building from source](#building-from-source)).
- **`guard-accept`**: `claude-code` takes the Claude Code CLI the [Claude Agent SDK](./frameworks.md#claude-agent-sdk) runs as it is, naming what it can reach and failing nothing for it. Node and Python processes keep `block` ([the network guard](#the-network-guard)).
- **`push`** is `shadowlap test --push`, with the team store set in `shadowlap.config.json`, and it pushes each fix that `fix-on-failure` opens ([fixes in the team store](#fixes-in-the-team-store)). The job needs credentials for the bucket, and a push that can't happen is a warning, never a failure.
- **`fix-build`** runs as `shadowlap repair --build` runs it ([an agent that needs a build](#an-agent-that-needs-a-build)).
- **`github-token`** is a GitHub App's token or a personal access token, for which GitHub starts the fix pull request's workflows. The CLI and your agent never get it.

**`github-token` left empty** uses a `GH_TOKEN` (or `GITHUB_TOKEN`) in the step's `env` that holds another token than the job's, else the job's `GITHUB_TOKEN`. For that one, the action [starts the workflow itself](#how-a-fix-pull-requests-checks-start).

**An inconclusive golden.** What `inconclusive` makes of one:

| `inconclusive` | An inconclusive golden |
|---|---|
| `fail` | Counts in `failed` and fails the step |
| `warn` | Goes through with a warning annotation |
| empty | As `shadowlap test` does by default: `fail`, but for a gate against history whose golden has fewer than 30 sessions |

Such a gate only warns when it runs out of attempts, until the plan reads a decline or a drop in its sessions. The `inconclusive` output counts it either way.

### Outputs

| Output            | Meaning                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------- |
| `passed`          | The recordings that passed                                                                   |
| `failed`          | Every recording that fails the step: each failure, and each inconclusive one, as below       |
| `inconclusive`    | The recordings whose verdict is inconclusive, whatever the `inconclusive` input made of them |
| `diverged`        | The recordings that failed because the agent sent a different request                        |
| `checks-failed`   | Definite check failures only                                                                 |
| `session`         | The test session's id                                                                        |
| `fixes`           | The fix pull requests opened                                                                 |
| `fix-prs`         | Their URLs                                                                                   |
| `report-json`     | The path of the JSON report                                                                  |
| `report-markdown` | The path of the Markdown report                                                              |
| `junit`           | The path of the JUnit XML report                                                             |

**What `failed` counts.** It counts each failure, and each inconclusive one unless `inconclusive` is `warn` or, left empty, it is a gate against history whose golden has too few sessions yet.

A verdict is inconclusive for a gate that ran out of attempts between its bounds, a check that could not be decided, an injection gate that showed too little to say, or a provider unavailable too many attempts in a row.

### Events it runs on

The action runs on `pull_request`, `push`, `schedule`, `workflow_dispatch` and `merge_group` alone:

| Event | What it runs |
|---|---|
| `pull_request` | A pull request's code, with what a fork may have: one from a fork gets no secrets and a token that may only read |
| `push`, `schedule`, `workflow_dispatch` | A branch of this repository |
| `merge_group` | A merge queue's branch, which holds what someone who may write here queued |

The goldens that replay offline need neither secrets nor a token that may write.

**Every other event is refused.** The agent the action runs is whatever the job checked out, which the event alone doesn't say, and the test runs it with the job's keys. So on every other event the action stops before it tests anything or opens a fix, not only fix on failure. It neither restores nor keeps the test history, whatever `keep-history` says.

Several of those events give the job the base repository's secrets, the provider keys among them, and a token that may write, and are how a pull request's code gets run beside them:

| Event | How a pull request's code runs on it |
|---|---|
| `pull_request_target` | It runs a pull request's workflow |
| `workflow_run` | It follows a workflow a pull request from a fork may have started, and is how its head gets checked out |
| `issue_comment` | It runs on a comment anyone can post, to test the pull request it names |
| `check_run`, `check_suite`, a pull request's review | They run for a pull request's checks and reviews |

Run it on `pull_request` for a pull request's code, and for a branch of this repository on `push`, `schedule` or `workflow_dispatch`, or in the workflow a `workflow_run` would have followed.

### Permissions and tokens

Each part of the step needs these in the job's `permissions`:

| Permission | Needed for |
|---|---|
| `contents: read` | The checkout, which a `permissions:` of your own otherwise takes it from |
| `pull-requests: write` | The [pull request comment](#the-pull-request-comment), and opening a fix's pull request |
| `contents: write` | Pushing a fix's branch ([fix on failure](#fix-on-failure)) |
| `actions: write` | Starting a fix pull request's checks without `github-token` ([how they start](#how-a-fix-pull-requests-checks-start)) |
| `id-token: write` | Short-lived credentials for the [team store](#fixes-in-the-team-store) on Amazon S3, Cloud Storage and Azure |

**The tokens.** The CLI, and the agent it runs, get none of GitHub's tokens. The action takes these out of their environment, so the agent can't send one to a model or write it into a recording:

- the job's own `GITHUB_TOKEN`;
- `github-token`;
- a `GH_TOKEN` or `GITHUB_TOKEN` in the step's `env`;
- the token the job asks GitHub for OIDC tokens with;
- any other variable that holds one of them.

**Pushing a fix.** The action pushes a fix's branch with the token in git's environment for that push alone, never in a command line. It pushes from a repository of its own made for the push, with no config, no hooks and none of git's user and system config, to the repository the workflow runs in. It opens the pull request through GitHub's API. So nothing the agent left in the checkout, a hook a push runs or a rewrite of the remote's URL, gets the token or sends the push elsewhere.

**The checkout.** `actions/checkout` leaves the job's token in the repository's git config, where the agent could read it from the disk, unless the step says `persist-credentials: false`, as every step on this page does: nothing after the checkout needs it.

**What this doesn't cover.** None of this keeps a token from an agent with a tool that runs code, on any runner. While the agent runs, the action's own process holds the tokens in its environment, and the agent's processes run as the same user, who can read it. The job's `permissions` are the bound on what such an agent could do with a token: give the job no more than its steps need.

### The CLI it installs

The step names a release twice: the action at its tag, and in `version:` the `shadowlap` CLI it installs from npm. Keep the two the same release, the one your project uses. When they differ, as after an update that moved only the tag, the step warns and names the version to set.

| `version:`                          | The action installs                                             |
| ----------------------------------- | --------------------------------------------------------------- |
| A release                           | That `shadowlap` release, from npm                              |
| Left out                            | Its own release: the version in its `packages/cli/package.json` |
| Any, with `build-from-source: true` | A CLI built from the action's own source                        |

With `fix-on-failure`, it installs the Anthropic SDK beside the CLI at the version the release was tested with. No package's install script runs, since the job may hold provider keys and tokens.

#### Building from source

An action used at a commit that is no release has no CLI on npm to install: `build-from-source: true` builds it from the action's own source instead, which adds about a minute.

- **No package's install script runs**, as the build needs none.
- **The build gets none of the job's environment** but what npm and Node need (`PATH`, a proxy and the like), with a home and a temporary folder of its own, empty. So no secret, key or token the step was given reaches it.
- **The code it runs still runs as the job's user**: TypeScript and esbuild, at the versions the action's lockfile pins, and the action's own scripts. That user can read the job's files, such as the checkout's git config and a cloud sign-in's credentials file.

The checkout's git config holds the job's token unless the checkout says `persist-credentials: false`. A cloud sign-in's credentials file is such as the `gha-creds-*.json` that google-github-actions/auth leaves in the workspace.

### The history cache

A [gate against a golden's history](./gating.md#a-gate-against-history) needs the [test history](#test-history) from one job to the next, and a job's store usually goes with the job. `keep-history` keeps the store, and with it the test history, between jobs in the Actions cache, so such a gate has a baseline:

| `keep-history` | The store                                                               |
| -------------- | ----------------------------------------------------------------------- |
| `auto`         | Kept when `shadowlap.config.json` gives a golden a gate against history |
| `true`         | Kept                                                                    |
| `false`        | Not kept                                                                |

Each run restores its branch's newest copy (a branch's first run, the default branch's) and saves its own under a key of its own, whether the tests passed or not. The [pull request comment](#the-pull-request-comment) reads the base branch's last session from what it restored.

On an event the action refuses, it neither restores nor keeps the history. On another CI system, cache `.shadowlap/shadowlap.db` between runs.

### The pull request comment

On a pull request, the action keeps one comment with each golden's verdict on one line, as every report says a verdict ([gating](./gating.md#reading-the-evidence)). The verdict word comes first, then for a golden with a gate its tally, bound and rule, and for one without, how its replay went or why it failed. As Markdown, before GitHub renders it:

```markdown
<!-- shadowlap-test-comment 0123456789ab -->
### Shadowlap: 1 of 3 goldens failed

| | Golden | Verdict | On `main` |
|---|---|---|---|
| ❌ | `goldens/refund-flow` | failed · check failed: issue_refund called 0 times, but called 1 time | ✅ passed |
| ✅ | `goldens/triage-inbox` | passed · replayed clean | ✅ passed |
| ✅ | `goldens/refund-gated` | passed · 12 of 12 · rate >= 0.73 (95%) · gate: tells 90%+ from 70%- at <= 5% risk, up to 80 attempts | not tested |

Compared with `main` as the test history last tested it, at `e5f6a7b`.
```

**One comment per pull request.** The comment is found again by a hidden marker, one per workflow, job, working directory and set of recordings, and edited in place on every run. So a pull request carries one, however often it is pushed and however long its thread grows: the action reads the thread's first page, then the rest newest first.

**Whose comment is edited.** Only a comment by the account the action's token posts as is edited. One anyone else made that holds the marker, quoting it or planting it, is left as it is.

| Token                   | Posts as                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------- |
| The job's own           | GitHub Actions' bot                                                                   |
| A personal access token | Its owner                                                                             |
| A GitHub App's token    | The App: it posts the comment again on each run, and the App's earlier one is removed |

GitHub names a GitHub App token's owner only once it has posted.

**The base branch's column.** When the [test history](#test-history) the job restored has a session of the pull request's base branch, the last one is a column of its own: a session whose results name the branch, or one that tested the base branch's commit. That history is kept between jobs with `keep-history`.

A fix pull request the job opened is named under the table, and the job summary has each failure in full.

**Text shows as text.** What a check found in a run, the repairer's words, a verdict the restored test history holds and GitHub's own messages go into the comment, a fix pull request's body and the job summary as text. An image, a link, a mention, an issue reference, math, an emoji or HTML in them shows as it was written, in a table cell too, and GitHub renders, links and notifies nothing.

**The fix pull request's title** is the fix commit's subject in the repairer's words, which GitHub shows as written. It goes on one line of at most 256 characters, with a mention, an issue reference and a `::` or `##[` that would start a workflow command split by a word joiner, which shows nothing.

**In the job's log** each stays on its line. A `::` that would start a workflow command there (`::error::`, `::stop-commands::`), or a `##[` anywhere in it, is escaped, so the runner reads none of it as one.

**Permissions.** The comment needs `pull-requests: write` in the job's `permissions`. A pull request from a fork gets a token from GitHub that may not comment, so it gets none: nothing is asked of GitHub, and the job summary says why, without a warning. So does a token GitHub refuses. `comment: false` turns it off.

### Keep a failed replay as a file

When a recording fails and the logs aren't enough, keep the failed replay as a file to open. These steps:

1. install the `shadowlap` CLI (the action's own isn't on the job's `PATH`);
2. replay again into a store of their own (`--db`);
3. take the first recording that failed from the JSON report, and of several attempts, one that failed;
4. export its replay together with the recording.

A recording marked `fork` runs live again here. When nothing fails on the second run, the step says so and the upload finds no file.

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

## Fix on failure

When a golden fails an outcome check in CI, the action can propose the fix itself. A fix verify accepted becomes a pull request with the patch and its report. It never merges anything: you review every fix.

### How it works

1. **Repair the failing replay.** The action runs [`shadowlap repair`](./repair.md) on it. Repair blames it (finds the model call where it was lost), asks the repairer to rewrite the prompt or a tool description, and keeps a rewrite only when `verify` accepts it twice, the second time with fresh attempts.
2. **Re-record the goldens** under the fix, once each replays clean with the fix applied ([what it holds](#what-a-fix-pull-request-holds)).
3. **Replay the other goldens** the session tested, with the fix applied, and name any it breaks.
4. **Push a branch and open the pull request**, and start its checks ([how they start](#how-a-fix-pull-requests-checks-start)).

### Goldens that fail the same check

Goldens that fail the same check are one failure, as a [blame joins them into one fix](./blame.md#fixes) (a test's replays carry no labels). So they get one repair and one pull request that re-records each of them.

- **Held out.** That repair is shown the failing replay of every other one of them, and the others' are [held out](./repair.md#guarding-against-fixes-that-fit-the-examples) from the repairer: the fix has to repair goldens it was not written against.
- **Kept.** Up to two goldens that passed the same check are kept. Each runs live under every candidate and under the code without it, within the same budget, and is kept unless it drops 10+ points below that, as `repair --keeps` keeps a run. Under a fixed count, it must pass the count on its own.
- **Gated.** Each run is decided by the failing golden's own [gate](./gating.md), or its fixed count. A golden with a gate against history, which verify doesn't take, is decided by verify's default gate.
- **One failing replay** of each golden is enough, as verify replays it as often as the gate asks.
- **A golden alone under its check** has nothing held out, and its pull request says it was verified on that golden alone.

**When no patch fixes them all**, say one of them fails in a way no prompt fix reaches, each is repaired on its own. That goes in the order the session tested them, within what is left of their budget, until a fix is accepted for one. That fix still gets the one pull request:

- it re-records the goldens it was verified for;
- it names each of the others as failing the same check without being verified under the fix, with the `shadowlap test <golden> --update` that re-records it on the branch when the fix repairs it too.

An update keeps a recording only when it passes its checks. The others get no pull request of their own. When no fix is accepted for any of them, the job summary says how each try ended.

### What a fix pull request holds

A fix changes what the agent sends, so a golden that must replay exactly would diverge on the fix's own branch and fail the pull request's checks. So the pull request's one commit carries the golden re-recorded under the fix too:

- **The recording verify accepted replaces the golden's pack** (`run.json`, `calls.jsonl`, `blobs/`, with the pack's `.gitattributes`; other files in its folder stay). It does so once it replays clean with the fix applied, which the action checks in its working tree before it pushes.
- **When it can't**, the golden stays as it was, and the pull request and the job summary say to run `shadowlap test <golden> --update` on the branch.
- **A golden marked `fork`** is left as it is: it passes on its checks from wherever it diverges.

**The other goldens.** The same change reaches the project's other goldens. So the action replays every other golden the session tested that must replay exactly, with the fix applied too:

| Golden | In the pull request and the job summary |
|---|---|
| Passed before, diverges under the fix | Named, with the `shadowlap test <goldens> --update` to run on the branch |
| Inconclusive under the fix, or before it | Named apart as such, never as one the fix broke |
| Marked `fork` | Not replayed there, as it would run live from where it diverges; the pull request names it |

**What the pull request says:**

- It says every golden the session tested replays clean on its branch only when each did, here. With one that may fork among them, it says that of the others.
- It never says its own checks pass: they run on GitHub, after it is opened.
- It says what the fix was verified on (the goldens shown to the repairer, those held out and those kept, and the gate), and how its checks start.

### Set it up

These are the steps of a job of their own: the branch checked out, Node 22.16 or later, the agent's dependencies (put your project's in place of `npm ci && npm run build`), then the action:

```yaml
# the job needs: permissions: { contents: write, pull-requests: write, actions: write }
# and workflow_dispatch: under the workflow's on:, so a fix's pull request gets its checks
- uses: actions/checkout@v7
  with:
    ref: ${{ github.event.pull_request.head.repo.full_name == github.repository && github.head_ref || github.ref }}
    persist-credentials: false
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
    # and your agent's own provider keys: blame and verify run it live
```

The job needs:

| What | Why |
|---|---|
| A model key for the repairer: `ANTHROPIC_API_KEY` for `claude-code` and `anthropic`, `OPENAI_API_KEY` for `openai:<model>` | The repairer proposes the rewrite |
| Claude Code on the runner, for `claude-code` | It runs Claude Code in print mode; the step before the action installs it |
| Your agent's own provider keys, in the same `env`, as for `shadowlap run` | Blame re-runs the failing replay live from the call it probes, and verify runs the agent with the fix |
| `contents: write` and `pull-requests: write` in the job's `permissions` | To push a branch, and to open the pull request and keep the [comment](#the-pull-request-comment) on it |
| `github-token`, or `actions: write` and a `workflow_dispatch:` trigger | For the pull request's checks to start ([how they start](#how-a-fix-pull-requests-checks-start)) |
| With Push from CI on, the bucket's credentials | So each fix reaches the [team store](#fixes-in-the-team-store) too |
| A branch checked out, as the first step does | So the fix becomes a pull request into it ([below](#the-branch-it-checks-out)) |
| Node 22.16 or later on the runner, not 23 | The second step sets it up |

The YAML's first two comments say the same of the permissions and the trigger.

- **`anthropic` and `openai:<model>`** need nothing installed.
- **An `anthropic` repairer without its key** (a secret not set, or a pull request from a fork, which gets none) is found out before anything is blamed. So the job spends nothing on it, and its summary says *the repairer could not be asked: no Anthropic credentials*.
- **An agent on OpenAI with the `anthropic` repairer** needs `OPENAI_API_KEY` as well as `ANTHROPIC_API_KEY`. Without its keys, blame fails and no fix is proposed.
- **No `gh` on the runner.** The action pushes the branch and opens the pull request through GitHub's API with the job's token, or `github-token`, so the runner needs no `gh`. Neither token goes in the step's `env`, and the CLI and your agent get neither.

**From the dashboard.** The dashboard's Settings → CI writes the agent's provider keys into the step's `env` by name, from the providers its goldens' recordings called, in place of that last comment. The comment stays after them when a golden's keys can't be named: its pack can't be read, or it calls Vertex AI, which signs in with a token.

### The branch it checks out

The first step checks out a branch, so the fix becomes a pull request into it:

| The job's event | It checks out | A fix |
|---|---|---|
| A pull request from this repository | Its branch (`github.head_ref`): its job checks out a detached merge commit otherwise | Opens a pull request into that branch |
| A pull request from a fork | Its merge commit (`github.ref`) | None: the job tests the pull request and opens no fix |
| A merge queue's job (`merge_group`) | Its branch (`github.ref`) | None: GitHub deletes its branch once its group merges or leaves the queue |

A fork's branch name could name another branch here, with other code, and its job's token may not push one.

### An agent that needs a build

Blame and verify run the agent live under the step's `guard`, as its test does. An agent that runs from what a build makes, such as a TypeScript agent's `dist/`, needs `fix-build: npm run build`, the command that builds it. It runs:

- in each candidate's worktree once the candidate is in it, as `shadowlap repair --build` runs it ([repair](./repair.md#candidates-are-tried-in-a-worktree-of-their-own));
- in the working tree around the replay of the fix's branch;
- once more when the fix is taken back out, so the steps after this one see the working tree's own build.

### What it never opens

The action never opens a pull request:

- **for a divergence**: most are intended, so [update the golden](#update-a-golden-after-an-intended-change) or add a normalizer;
- **for a golden whose only failing check is a cost check** on a model with no price: add it under `prices`;
- **from the branch of a fix it opened**: its checks say whether the fix holds;
- **from a checkout whose origin is another repository** than the one the workflow runs in, or in a job that names none. It finds that before anything is spent, since no fix could be pushed from there.

It never keeps a fix that verify rejected, and never merges anything. A failed check still fails the build. A session stopped by a signal, as when the job is cancelled, starts no fix.

### Its budget

It never starts anything past the budget. Each failing golden gets `fix-budget` dollars for blame, the repairer, verify and judge checks together; goldens repaired together have their budgets added up.

Repair starts no attempt once the budget is spent, and asks the repairer only when what is left covers the most asking could cost. What is running then finishes, so the total can pass it by an attempt or a pair.

### The job summary

The job summary lists each failing golden, or the goldens repaired together, with:

- the pull request opened: whether its goldens were re-recorded, and the other goldens it leaves diverging;
- or why there is none, such as *the repairer could not be asked: claude was not found*, when Claude Code isn't on the runner;
- what it spent of its budget.

The fix commit is made by GitHub's Actions bot when git has no identity of its own on the runner.

**The fix in the store.** The fix in the store the job used (the `store` input) records the pull request it went to (`shadowlap fix pr`). So a dashboard on that store lists it as *from CI · PR #138*, and once the pull request is merged or closed, *from CI · PR #138 merged*. The dashboard reads its state from GitHub with `gh`, in the background, while Fixes is open.

### How a fix pull request's checks start

GitHub starts no workflow for a push or a pull request made with the job's own `GITHUB_TOKEN`, so a fix pull request opened with it would sit with its required checks never started. There are two ways around it:

| Way | What the action does | The job needs |
|---|---|---|
| `github-token` | Pushes the branch and opens the pull request with it, and GitHub starts the pull request's workflows as for any other | A GitHub App's installation token or a personal access token with `contents` and `pull-requests` write |
| Without one | Pushes and opens with the job's token, and in between starts the workflow it runs in on the fix's branch | A `workflow_dispatch:` trigger in the workflow, and `actions: write` |

**With `github-token`.** A GitHub App's token can come from `actions/create-github-app-token`, say. It goes to git, as an Authorization header in git's environment for the push alone (never on a command line, nor in the repository's config), and to GitHub's API, never to the CLI or your agent. Without one, a `GH_TOKEN` (or `GITHUB_TOKEN`) in the step's `env` that holds another token than the job's goes the same way, else the job's own.

**Without one.** The action starts the workflow with a `workflow_dispatch` event, which GitHub does start for that token. That run checks the branch, and the pull request shows it. The workflow needs a `workflow_dispatch:` trigger, and the job `actions: write`:

```yaml
on:
  pull_request:
  push:
    branches: [main]
  workflow_dispatch:
```

The pull request says which happened:

- opened with `github-token` (or that `GH_TOKEN`);
- `ci.yml` started on its branch, and that other workflows that run on pull requests have not started;
- the workflow could not be started, why (no `workflow_dispatch:` trigger, no `actions: write`), and that no check has run on the branch, with what starts them.

The job summary says it beside each fix, and warns when no check started. The run on the fix's branch opens no fix of its own: a failing golden there fails its check, as it should.

## Fixes in the team store

A job's store usually goes with the job, so to reach your teammates a fix has to travel through the [team store](./team.md). With [Push from CI](./team.md#push-from-ci) on (Settings → Store, or `shadowlap store push-from-ci on`), the dashboard's Settings → CI writes the step with `push: true`, and the bucket's credentials among what it needs:

```yaml
# the job needs: permissions: { contents: write, pull-requests: write, actions: write, id-token: write }
# and workflow_dispatch: under the workflow's on:, so a fix's pull request gets its checks
- uses: actions/checkout@v7
  with:
    ref: ${{ github.event.pull_request.head.repo.full_name == github.repository && github.head_ref || github.ref }}
    persist-credentials: false
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
    # and your agent's own provider keys: blame and verify run it live
```

`push: true` pushes the test runs as `shadowlap test --push` does. Once a fix's pull request is open, it pushes every run the job made (`shadowlap push --all`), which takes the fix with its blame, repair and verdicts along. A teammate's `shadowlap pull` then brings it to their Fixes page, as *from CI · PR #138*.

Settings → CI has no switch of its own for this: the step follows Push from CI, on Settings → Store. While that is off, or the project has no team store, it is the step above without the push lines.

### Credentials on S3, Cloud Storage and Azure

Pushing needs the bucket's credentials in the job, besides the permissions the fix needs. Amazon S3, Cloud Storage and Azure give a job short-lived credentials:

1. Add `id-token: write` to the job's permissions, as the first comment says.
2. Copy the two `if:` steps that `shadowlap store ci --provider github` prints into the job where the comment stands, after the checkout and right before the action. Settings → CI's **Write file** puts them there for you.

The first gives your branches' jobs the credentials that write to the store; the second gives a pull request's job its own, which write only under `pr/`.

**Copy only those two steps.** The rest of what `store ci` prints is a job of its own, and around this step it would keep fixes from opening:

- its `run:` step tests first and fails the job on a failed check, so this step never runs;
- its checkout leaves a pull request's job on a detached merge commit;
- its `contents: read` can't push a fix's branch.

This step runs the tests itself and pushes them as that `run:` step does. So a workflow that already has the `store ci` job can put this step in place of its `run:` step, with the permissions and the checkout the fix needs.

### Credentials on Cloudflare R2

Cloudflare R2 has no OIDC, and an R2 token can't be kept to a pull request's folder. A pull request's job runs the agent as the pull request changed it, so it never gets the keys. For an R2 store, the step gives `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`, from the repository's secrets, only to jobs that aren't a pull request's, and pushes only from those, as `store ci` writes it for R2:

```yaml
# the job needs: permissions: { contents: write, pull-requests: write, actions: write }
# and workflow_dispatch: under the workflow's on:, so a fix's pull request gets its checks
# and R2 keys as secrets: they can't be kept to pr/, so pull requests don't push
- uses: actions/checkout@v7
  with:
    ref: ${{ github.event.pull_request.head.repo.full_name == github.repository && github.head_ref || github.ref }}
    persist-credentials: false
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
    R2_ACCESS_KEY_ID: ${{ !startsWith(github.event_name, 'pull_request') && secrets.R2_ACCESS_KEY_ID || '' }}
    R2_SECRET_ACCESS_KEY: ${{ !startsWith(github.event_name, 'pull_request') && secrets.R2_SECRET_ACCESS_KEY || '' }}
    # and your agent's own provider keys: blame and verify run it live
```

A pull request's job then tests and opens its fix, and says nothing about the team store. That condition lives in the workflow file, which a pull request can edit. To keep the keys from a pull request's workflow altogether, put them in an environment only protected branches can use, for a job of its own on those branches, as `store ci`'s note for R2 says.

### When a push can't happen

A push that can't happen never fails the job and never keeps a fix's pull request from opening: the pull request is opened first, and the push comes after it.

- **Beside each fix** that `shadowlap push` reported sending, the job summary says *in the team store*.
- **Beside one that didn't go**, it says *not in the team store*, with why under the table: no store set, no credentials, the store out of reach, or a push that didn't report sending it. The job's log has it as a warning.
- **A team that turned Push from CI off** is told so, without a warning.

The test runs' push is what `shadowlap test --push` always does: a warning when it can't happen, and the tests decide the job.

### Pull requests

- **A pull request's own job** writes only to [its own folder](./team.md#pull-requests), `pr/<number>/`, and sends no fixes. With short-lived credentials the job's runs go there, and the summary says the fix stays off the team's Fixes page; with R2 it pushes nothing. Fixes reach the team from jobs on your branches, such as `main`.
- **A pull request from a fork** gets no secrets, no OIDC token and a read-only `GITHUB_TOKEN` from GitHub. So its job can't sign in to the bucket or push a fix's branch: it opens no fix pull request and pushes nothing.

The pull request's credentials step that `shadowlap store ci` prints is only for pull requests from your own repository: its `if:` compares the pull request's head repository with yours. So it can't fail a fork's job. The job goes on to this step, the test runs' push warns that there are no credentials, and the tests decide the job.

## Alerts

To hear about failures in Slack, let the action count them without failing, post the count, then fail the job:

```yaml
# the job needs: permissions: { contents: read, pull-requests: write }
- uses: actions/checkout@v7
  with:
    persist-credentials: false
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

They need:

- an incoming webhook from your Slack workspace, its URL as a repository secret (`SLACK_WEBHOOK_URL` here);
- the test step's `id`;
- `pull-requests: write` in the job's `permissions`, for the action's [comment](#the-pull-request-comment) on a pull request, with `contents: read`, which a `permissions:` of your own otherwise takes away from the checkout;
- Node 22.16 or later, not 23.

**Keys for goldens that run live.** A golden that runs live, one marked `fork` (a gate's golden is one) or with an [injection gate](#injection-gates), needs its providers' keys in the test step's `env`. Otherwise it fails, and Slack hears of it on every run. The dashboard's Settings → CI adds them by name, from the providers those goldens' recordings called and their judges' (`2 goldens run live (fork) · ANTHROPIC_API_KEY`). Where it can't name them, a comment in that `env` says to add your agent's own.

**Which branches post.** The `github.ref` condition keeps pull requests quiet, since their checks already show a failure; drop it to post for every branch. The dashboard's Settings → CI writes your repository's default branch there: the branch origin's HEAD names, else `main` or `master`, whichever the repository has. It shows that branch as the base in its preview of a fix pull request, though the action opens a fix into the branch the job checked out.

**What counts as failed.** A golden counts as failed when:

- its replay diverges;
- it tries a live call where it must replay offline;
- the agent exits with an error;
- a check fails, token and cost budgets included;
- its injection gate fails;
- a gate, a judge or an injection test can't decide (inconclusive), unless the step says `inconclusive: warn`.

With `inconclusive` left out, a gate against history whose golden has fewer than 30 sessions only warns, until the plan reads a decline or a drop in its sessions. Settings → CI's **An inconclusive golden**, under Gates, writes `inconclusive: warn` for **Warns**, and leaves the input out for **Fails**.

**A config that can't be read.** While `shadowlap.config.json` can't be read, Settings → CI says so. Each step says in its `env` what it leaves out until the file is fixed: which goldens run live and their keys, and whether Fix on failure pushes.

## One job for all of it

Fix on failure, Alerts and the team store's push are inputs and steps around one run of the goldens, so they go in one job: the action runs once, with `id: goldens`, and the steps you turned on follow it. The dashboard's Settings → CI writes the whole file from its switches: **Pull request comment**, **Fix on failure** and **Alerts**, with Gates' **An inconclusive golden**. The push follows Push from CI. Its **Write file** patches your repository's file in place, and changes only the lines those switches own.

```yaml
# the job needs: permissions: { contents: write, pull-requests: write, actions: write, id-token: write }
# and workflow_dispatch: under the workflow's on:, so a fix's pull request gets its checks
- uses: actions/checkout@v7
  with:
    ref: ${{ github.event.pull_request.head.repo.full_name == github.repository && github.head_ref || github.ref }}
    persist-credentials: false
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

- **With Slack on**, the action counts the failures without failing the step (`fail-on-divergence: false`), so a fix can open and Slack can hear of it before **Fail the job** fails it. With Slack off, the action fails the job itself.
- **Each part needs what its section above says, once.** The job's permissions add up, and its `env` holds every golden's keys while Fix on failure is on (blame and verify run the agent live), else those of the goldens that run live.
- **With Push from CI on**, the step pushes whichever parts are on. So this job takes the bucket's credentials alone, the two `if:` steps `shadowlap store ci --provider github` prints, where the comment stands: no second job runs the goldens again. Settings → CI's **Write file** adds them.

## Other CI systems

On other CI systems, run the CLI directly. `--junit`, `--json` and `--markdown` write reports, as described in the [CLI reference](./cli.md#test).

- **Keys.** Pass the providers' keys as environment variables to goldens that may go live ([keys](#keys)).
- **History.** Cache `.shadowlap/shadowlap.db` between runs, so a gate against history has its baseline ([test history](#test-history)).
- **The team store.** `shadowlap test --push` sends the runs and the session's report there ([in CI](#in-ci)).

### Strict replays outside `test`

`shadowlap replay <run> --strict` exits 1 on divergence, or when the replay ends early. It is the same check against a run in the local store, for scripts and pre-commit hooks.

## Keeping goldens honest

- **Values an agent makes anew on every run** (a request id, a per-run UUID, a temp path) diverge on the first CI run. Run [`shadowlap calibrate`](./normalizers-and-redaction.md#calibrate) on a recording before you pack it, or add the [normalizer](./normalizers-and-redaction.md) the report suggests; normalizers apply at match time, so old goldens keep working.
- **Today's date in a prompt** needs neither: [dates near a run's start](./normalizers-and-redaction.md#dates-and-times) already match.
- **Intended changes** to a prompt fail the test, which is the point. [Update the golden](#update-a-golden-after-an-intended-change) with `shadowlap test --update`, and review the re-recording in the pull request like any other snapshot. `shadowlap show --json` of the two runs diffs well.
- **The outcome, not the requests.** When what matters is the outcome rather than the exact requests, mark the recording [`fork`](#recordings-that-fork-on-purpose) and give it checks instead.
- **Tool fixes** don't change requests, so they don't fail the test; the recorded result is still served. If the fix should change behavior, re-record.
- **Keep goldens small and specific.** The repository's 30-call reference run packs to 79 files and 64 KB.

### Review goldens like code

`shadowlap test` runs the command recorded in each pack, and so do `bisect`, `injection`, `decisions`, `migrate` and `tasks` on a golden. They do so without asking for goldens your repository tracks, and for ones this machine recorded with that command. That is safe for goldens committed to your repository, because a pull request that edits a golden could edit your CI scripts just as easily.

A pack from anywhere else, outside the repository or not added to it, runs its command only after a yes at a terminal or with `--yes`. In CI, with no terminal to ask at, it isn't run and fails saying why: a session in which nothing else failed ends with 2, a usage error, as `replay` ends for an imported run. Read such a pack's `run.json` before you say yes.

## Troubleshooting

| Symptom | Why | What to do |
|---|---|---|
| A golden diverges on its first CI run | A value the agent makes anew on every run, such as a request id | Add the normalizer the report suggests, or `shadowlap calibrate` before you pack |
| `ended early` | The agent stopped before its recording did | If that is on purpose, re-record it with `--update` ([ends early](#a-replay-that-ends-early)) |
| The run was not watched | A connection the guard can't watch, such as the Claude Code CLI's | `guard-accept: claude-code`, or `guard: warn` ([the network guard](#the-network-guard)) |
| A golden that may go live fails, even with a clean replay | No key for its provider in the job | Pass the providers' keys to the step as environment variables ([keys](#keys)) |
| An injection gate is *inconclusive* on a pull request from a fork | A fork gets no secrets, so every attempt's model call fails | `--inconclusive warn`, or run it where the key is ([injection gates](#injection-gates)) |
| The step warns about the version | The action's tag and `version:` name different releases | Set `version:` to the version the warning names ([the CLI it installs](#the-cli-it-installs)) |
| No comment on a pull request from a fork | Its token may not comment | Nothing: the job summary says why ([the comment](#the-pull-request-comment)) |
| A fix pull request's checks never start | It was opened with the job's `GITHUB_TOKEN` | Give `github-token`, or `actions: write` and a `workflow_dispatch:` trigger ([how they start](#how-a-fix-pull-requests-checks-start)) |
| *the repairer could not be asked: claude was not found* | Claude Code isn't on the runner | Install it before the action ([set it up](#set-it-up)) |
| No fix pull request for a failing golden | A divergence, an unpriced cost check, a fork's or a merge queue's job | See [what it never opens](#what-it-never-opens); the job summary says why |
| *not in the team store* | No store set, no credentials, the store out of reach | The job summary says why under its table ([fixes in the team store](#fixes-in-the-team-store)) |
| A pack fails in CI saying it wasn't run | It is from outside the repository, so it waits for a yes | Read its `run.json`, then commit it or pass `--yes` ([review goldens](#review-goldens-like-code)) |

## See also

- [The recording format](./recording-format.md): what a pack holds.
- [Gating](./gating.md): repeats, gates and a gate against history.
- [Checks](./checks.md) and [judge checks](./judges.md): everything `expect` can say.
- [Blame](./blame.md), [repair](./repair.md) and [verify](./verify.md): the Fixes flow fix on failure runs.
- [The team store](./team.md): push from CI, and pull on your machine.
- [`shadowlap test`](./cli.md#test) and [`shadowlap bisect`](./cli.md#bisect) in the CLI reference.
