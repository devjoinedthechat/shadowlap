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

For each pack, `shadowlap test` unpacks it into an ephemeral store (CI never accumulates recordings), re-runs the recorded command under a replay sidecar with **every provider set to offline**, and passes only if the replay is clean and the process exits 0. A divergence prints the report; a live call is refused with a 503 that names the call; both fail the pack. `--online` allows live calls after a divergence if you really want them; `--cwd` sets the working directory for the recorded commands; `--writes` sets the write policy.

Output:

```
✓ triage-inbox: 30/30 replayed, 12k input tokens not re-spent
✗ summarize-thread: diverged at call 3 (api POST /v1/messages)
    ✗ Diverged at call 3 (api POST /v1/messages): 2 calls replayed before divergence
      ~ $.system
          - "…Today is 2026-09-15."
          + "…Today is 2026-09-16."
      hint: this looks like a date; to ignore it in matching, add a normalizer
1 passed, 1 failed
```

The JUnit report renders in GitHub, GitLab and most CI dashboards; each pack is a test case, and a failure carries the divergence report and the agent's output.

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

It replays each recording offline and fails the check when one diverges, makes a live call or exits with an error. The job summary gets a table of the recordings, and for each failure the diff of the first changed request, the normalizer hint if there is one, and the agent's last output lines. Each failure is also annotated on the pull request.

A Python agent needs its interpreter and packages installed before the action, as for any other step. The action itself needs Node 22.13 or later.

Pin the action to a release tag once there is one. Until shadowlap is on npm, the action builds the CLI from its own source, which adds about a minute; after the release, set `version:` to install it from npm instead.

| Input | Default | Effect |
|---|---|---|
| `recordings` | `goldens/*` | Recording directories, separated by spaces or new lines; `*` is allowed in the last part of a path |
| `working-directory` | `.` | Where the recorded commands run |
| `version` | empty | A shadowlap version from npm; empty builds it from the action's source |
| `writes` | `block` | What write tools do after a divergence: `block`, `stub` or `allow` |
| `guard` | `block` | The network guard: `block`, `warn` or `off` |
| `online` | `false` | Allow live model calls after a divergence |
| `fail-on-divergence` | `true` | With `false`, the step passes and `failed` says what happened |
| `summary` | `true` | Write the report to the job summary |
| `annotations` | `true` | Annotate failed recordings |
| `junit` | empty | Also write JUnit XML to this path |

Outputs: `passed`, `failed`, and the paths `report-json`, `report-markdown` and `junit`.

The action reads `tests` from `shadowlap.config.json` in the working directory. A recording marked `fork` calls the providers after the fork, so pass their keys to the step as environment variables (`env: ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}`).

When a recording fails and the logs aren't enough, keep the replay as a file to open:

```yaml
- if: failure()
  run: shadowlap export html "$(shadowlap ls --json | jq -r '.[0].runId')" failed-run.html
- if: failure()
  uses: actions/upload-artifact@v4
  with: { name: shadowlap-run, path: failed-run.html }
```

On other CI systems, run the CLI directly. `--junit`, `--json` and `--markdown` write reports, as described in the [CLI reference](./cli.md#test).

## Keeping goldens honest

- **Ambient values** (dates in prompts, request ids) will diverge on the first CI run. Add the [normalizer](./normalizers-and-redaction.md) the report suggests; normalizers apply at match time, so old goldens keep working.
- **Intended changes** to a prompt fail the test, which is the point. Re-record (`shadowlap run`, then `pack`) and review the new golden in the pull request like any other snapshot. `shadowlap show --json` of the two runs diffs well. When what matters is the outcome rather than the exact requests, mark the recording [`fork`](#recordings-that-fork-on-purpose) and give it checks instead.
- **Tool fixes** don't change requests, so they don't fail the test; the recorded result is still served. If the fix should change behavior, re-record.
- Keep goldens small and specific. A 30-call run packs to about 340 KB.
- **Review goldens like code.** `shadowlap test` runs the command recorded in each pack, without asking. That's safe for goldens committed to your repository, because a pull request that edits a golden could edit your CI scripts just as easily. Don't point it at packs from anywhere else before reading their `run.json`.

## Strict replays outside `test`

`shadowlap replay <run> --strict` exits 1 on divergence and is the same check against a run in the local store, for scripts and pre-commit hooks.
