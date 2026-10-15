# CLI

Global options: `--db <path>` (default `./.shadowlap/shadowlap.db`), `-v` / `--verbose` (sidecar log on stderr). Run ids can be abbreviated to any unique prefix.

## init

```sh
shadowlap init [--json]
```

Reads the project in the current directory and prints the steps to a first recording, filled in for it:

- the language and package manager, from `package.json`, `pyproject.toml`, requirements files and lockfiles;
- the model SDKs (Anthropic, OpenAI, Gemini, and the AI SDK and LangChain provider packages), from dependencies or imports;
- the agent framework and its version: the Vercel AI SDK, OpenAI Agents SDK, Mastra, LangChain and LangGraph, the Anthropic tool runner, Pydantic AI, the OpenAI Agents SDK for Python, CrewAI;
- the command that starts the agent, from `package.json` scripts or a conventional entry file;
- every tool definition it can find, whether it declares an effect, and a suggested effect for those that don't. The suggestion goes by the tool name's leading verb, and a name with no hint gets `write`, which never runs again after a fork;
- a model server the project already points at, such as Ollama in `OPENAI_BASE_URL`, and the `SHADOWLAP_UPSTREAM_OPENAI` value that keeps it as the upstream.

It warns about a model client constructed with a literal base URL: `shadowlap run` cannot redirect it, so its calls would not be recorded.

`init` writes one file: an empty `shadowlap.config.json`, only when there is none. The detection reads source text; it runs nothing. `--json` prints the findings as JSON.

## run

```sh
shadowlap run -- <command> [args...]
```

Records a run (`--summary-json <file>` also writes its summary as JSON). Starts a sidecar, sets `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `GOOGLE_GEMINI_BASE_URL`, `SHADOWLAP_URL` and `SHADOWLAP_RUN_ID` for the child, preloads [in-process capture](./providers.md#in-process-capture) and the network guard into Node and Python children, and exits with the child's exit code. The run's status is `completed`, `failed` (non-zero exit) or `crashed` (interrupted).

## replay

```sh
shadowlap replay <run> [options] [-- <command> [args...]]
```

Replays a recorded run; forks at the first changed call. Re-runs the recorded command unless one follows `--`.

A run imported with `unpack`, or a replay of one, carries a command someone else recorded. `replay` shows it and asks before running it. Without a terminal to ask on, it refuses: pass `--yes` once you have read the command, or give your own after `--`.

| Option | Effect |
|---|---|
| `--strict` | Exit 1 if the replay diverges (for CI) |
| `--writes block\|stub\|allow` | What `write` tools do after divergence. Default `block` |
| `--reads live\|replay` | What `read` tools do after divergence. Default `live` |
| `--live-tool <name>` | Force this tool's first call live (repeatable); use after fixing a tool |
| `--diverge-at <call>` | Force call *n* live |
| `--fail-at <call>=<status>` | Answer model call *n* with an HTTP failure instead of the recording, so the agent's own error path runs: `--fail-at 12=429` (repeatable, [details](./interventions.md#inject-a-failure)) |
| `--watch` | Replay again whenever a file in the project changes. Ctrl-C to stop |
| `--summary-json <file>` | Also write the summary (with `--repeat`, every attempt and the report) as JSON to a file |
| `--prompt-from <call>` | Apply your changed system prompt and tool definitions only from model call *n*: earlier model calls replay from the recording ([details](./interventions.md#apply-a-changed-prompt-from-a-later-call)) |
| `--override <call>=<json\|@file>` | Substitute a recorded tool result; the run forks at the first model call that sees it |
| `--inject <call>=<text>` | Append an instruction at model call *n* and keep it in place in every later request; `--inject-as system\|user` |
| `--set <call>:<key>=<value>` | Set a top-level request field from model call *n* on (repeatable) |
| `-y`, `--yes` | Run the recorded command of a run imported from a pack without asking (see below) |
| `--repeat <n>` | Run the replay *n* times and report how the attempts differ after the fork (see below) |
| `--concurrency <n>` | With `--repeat`: attempts running at once. Default 1 |
| `--model <call>:<model>` | Switch the model from model call *n* on |
| `--guard warn\|block\|off` | [Network guard](./how-it-works.md#the-network-guard) for connections that bypass Shadowlap. Default `warn` (`run` accepts `warn\|off`; `test` defaults to `block`) |

See [Interventions](./interventions.md) for what each one does to the conversation prefix.

### Repeating a fork

Everything after a fork is live, so a model may do something different each time. One good attempt doesn't show that a change fixed the behavior. `--repeat n` runs the same replay *n* times, each attempt its own run, and summarizes them:

```
⑂ 5 attempts from 01M2P9PVCP, each forked at call 11
  5 of 5 exited 0 · 20 upstream requests · 16k input tokens not re-spent

  Paths after the fork
    5×  open_ticket (stubbed) → open_ticket (stubbed) → open_ticket (stubbed)
  every attempt took the same path

  Tools after the fork
    tool         attempts   calls
    open_ticket  5 of 5     15 (15 stubbed)

  Final model responses: 5 different
```

A path is the sequence of tool calls after the fork and what happened to each: blocked, stubbed, overridden or an error. Tools called between the same two model calls match in any order, since agents often run them at once. Attempts with the same path are grouped, most common first. Arguments aren't part of a path; `shadowlap diff` compares two attempts in full, and the report names the pair to start with. The prefix before the fork is served from the recording, so it costs nothing however many attempts there are. If attempts fork at different calls, the report says the prefix isn't deterministic.

With `--concurrency`, attempts run at the same time through one sidecar; each attempt's output is printed whole when it finishes. `--strict` exits 1 if any attempt diverged; otherwise the exit code is 0 only when every attempt exited 0.

## blame

```sh
shadowlap blame <run> [options] [-- <command> [args...]]
```

Finds the model call where a failed run was lost: the last one whose answer, asked again, lets the run pass. It first replays the run as recorded to confirm the failure, then probes model calls with forks that replay everything before the probed call for free, and binary-searches for the boundary. [Blame](./blame.md) explains the search, the report and the limits.

| Option | Effect |
|---|---|
| `--expect <json\|@file>` | What a passing run must do besides exiting 0: the `expect` object of an [outcome check](./ci.md#outcome-checks), such as `'{"tools":{"send_email":0}}'` |
| `--attempts <n>` | Attempts per probed call. Default 5 |
| `--passes <n>` | Passing attempts that make a probe a rescue. Default 2 (1 with one attempt) |
| `--model <model>` | Rescue with this model from the probed call on, instead of asking the recorded one again |
| `--set <key=value>` | Set a request field from the probed call on, such as `temperature=1` (repeatable) |
| `--scope <name>` | Probe only model calls made in this [scope](./sdk.md#scopes): the agent's, and not a simulated user's |
| `--scan <n>` | Model calls past the boundary to probe too, in case rescue works again after it. Default 2 |
| `--writes stub\|block` | What write tools do after the fork. Default `stub`; `allow` is not accepted |
| `--reads live\|replay` | What read tools do after the fork. Default `live` |
| `--concurrency <n>` | Attempts of one probe running at once. Default 1 |
| `--budget <usd>` | Start no attempt once this much is spent on live model calls |
| `--timeout <seconds>` | Stop an attempt after this long and count it as failed |
| `--json` | The report as JSON on stdout ([fields](./blame.md#json)) |
| `--guard`, `-y` | As for `replay` |

Exit status 0 when the search reaches a verdict (a blamed call, or no call that rescues the run), 1 when it stops early or refuses: the run passes its oracle, or does not replay as recorded.

Each blame is kept with the [fix](#fix) it opens or joins, by the run's labels, else its check.

## verify

```sh
shadowlap verify --fixes <run...> [--holdout <run...>] [--keeps <run...>] [options] [-- <command> [args...]]
```

Checks a change before it ships. Replays failing runs, which the change must now fix, and good runs, which it must not break, under the code in the working directory, and accepts the change only when every one passes. Runs are ids, unique prefixes or `label:<name>`. A replay that forks nowhere settles its run in one free attempt. [Verify](./verify.md) explains the roles, the report and the warnings.

| Option | Effect |
|---|---|
| `--fixes <run...>` | Failing runs the change was written to fix |
| `--holdout <run...>` | Failing runs of the same kind the change was not written against |
| `--keeps <run...>` | Runs that passed and must still pass, such as `label:good` |
| `--expect <json\|@file>` | What a passing run must do besides exiting 0, as for `blame` |
| `--attempts <n>` | Attempts per run where the replay forks. Default 5 |
| `--passes <n>` | Attempts that must pass. Default 80% rounded up (4 of 5) |
| `--model <model>`, `--set <key=value>` | The change is a request field, set from each run's first model call |
| `--live-tool <name>` | The change is in this tool: run its first call live (repeatable) |
| `--writes stub\|block`, `--reads live\|replay` | As for `blame` |
| `--concurrency <n>` | Runs verified at once. Default 1 |
| `--budget <usd>`, `--timeout <seconds>` | As for `blame` |
| `--fail-fast` | Start nothing new once a run has failed |
| `--json` | The report as JSON on stdout ([fields](./verify.md#json)) |
| `--guard`, `-y` | As for `replay` |

Exit status 0 when the change is accepted, 1 when it is rejected or the verification did not finish. The verdict is kept with the [fix](#fix) of its failing runs, whatever it is; an accepted one turns the fix verified when it [counts](./verify.md#verdicts-are-kept) there: it checked the fix's check on a run that failed it.

## repair

```sh
shadowlap repair --fixes <run...> [--holdout <run...>] [--keeps <run...>] [options] [-- <command> [args...]]
```

Fixes failing runs. Blames each one, asks a model you choose (`--repairer`, or `repair.repairer` in the config) to rewrite the system prompt or a tool description, and keeps the smallest rewrite `verify` accepts on the failing runs, runs held out from the repairer, and the good runs. Rewrites that name a detail of the failing runs are set aside before anything runs. Candidates are tried in the working tree and put back; the fix comes out as a patch, a pull request body and a recording of each fixed run. [Repair](./repair.md) explains the loop and the safeguards.

| Option | Effect |
|---|---|
| `--fixes`, `--holdout`, `--keeps <run...>` | The failing runs, the failing runs kept from the repairer (default: every other `--fixes` run, when there are two or more), and the runs that must keep passing |
| `--expect <json\|@file>` | What a passing run must do besides exiting 0 |
| `--repairer <provider:model>` | `anthropic` (Claude Opus 5.5), `anthropic:<model>`, `openai:<model>`, or `claude-code[:<model>]` to run your own Claude Code in print mode |
| `--candidates <n>` | Rewrites to ask for. Default 3 |
| `--stronger <model>` | When the recorded model can't be rescued, rescue with this one and try switching to it, before asking the repairer |
| `--scope <name>`, `--set <key=value>` | As for `blame`: which calls to probe, and what probes change, such as `temperature=1` |
| `--attempts <n>`, `--passes <n>` | The gate. Default 4 of 5 |
| `--max-growth <percent>` | Reject a fix that grows input tokens per run by more than this. Default 25 |
| `--build <command>` | Rebuild the agent after its source changes and after each restore |
| `--apply` | Leave the accepted fix in the working tree |
| `--branch <name>` | Commit it to a new branch without checking anything out |
| `--pr` | With `--branch`: push it and open a pull request with `gh` |
| `--goldens <dir>` | With `--apply` or `--branch`: put the recordings of the fixed runs in this directory too; with `--branch`, one inside the repository |
| `--budget <usd>` | Stop once this much is spent on blame, the repairer and verification |
| `--writes`, `--reads`, `--concurrency`, `--timeout`, `--guard`, `-y`, `--json` | As for `verify` |

Exit status 0 when a candidate is accepted and handed over as asked, 1 otherwise. The repair is kept with the [fix](#fix) its blames opened or joined, even when the hand-over failed: when a candidate is accepted under the fix's check the fix turns verified, and when none is, the fix stays open with every candidate tried and why it was dropped.

## fix

```sh
shadowlap fix ls [--status open|verified|applied] [--json]
shadowlap fix show <fix> [--json]
shadowlap fix title <fix> <title...>
shadowlap fix apply <fix> [--goldens <dir>] [--no-test] [--build <command>] [--json]
```

A fix is one failure, from the blame that reproduced it to a change that held. A [blame](./blame.md#fixes) opens one or joins one, by the run's labels, else its check; [verify](./verify.md#verdicts-are-kept) and [repair](./repair.md#the-fix-it-reports-to) report to the fix of the runs they were given, and their verdict counts for it only when it checked the fix's check on a run that failed it. Fix ids look like `fx-01M3RZ4XKN…`; any unique prefix works, with or without `fx-`, and the list shows the first ten characters.

- **`fix ls`** lists fixes, the most recently opened first: status (`open`, `verified`, `applied`), id, title, label, failing runs, and how far each step got (*lost at #5 · prompt fix · 3 of 3 held*). A second line gives the check, where the fix came from (*from CI · PR #138*) and when it was opened, and a third says so when an applied fix doesn't hold.
- **`fix show`** prints a fix and its three steps: where the run was lost and the probes that found it; the change, the candidates tried and why each was dropped; and every verdict, with each run's role and outcome, and why one doesn't count. It ends with what to do next.
- **`fix title`** replaces the title derived from the check with one of your own; blames that join the fix later keep it.
- **`fix apply`** hands a verified fix over. It runs `git apply` on the accepted repair's `fix.patch`, copies the recordings the fixed code made into the goldens folder, runs [`shadowlap test`](#test) on them, and marks the fix applied. A patch already in the tree, applied by hand, committed, or left there by `repair --apply`, is recognised with `git apply --reverse --check` and only marked. When the working tree has changes the patch conflicts with, nothing is changed, and the message says whether to commit or stash them or to apply the patch by hand. A fix verified on the working tree itself, with no repair behind it, has no patch, so it is only marked applied.

Run again on an applied fix, `fix apply` finishes what is left, and keeps when the fix was applied: it copies the goldens not in the project yet (`repair --apply` copies none without `--goldens`), and runs the test when it hasn't passed, on goldens copied before where they are. With nothing left, it does nothing; with `--no-test` it says when a test is still to pass. A test that fails leaves the fix applied, marked as not holding, until a run of `fix apply` passes it.

It trusts nothing it reads from the store: the repair's directory must be `.shadowlap/repairs/<repair id>`, each golden inside its `goldens/`, and `fix.patch` the patch the repair verified, or it changes nothing and says why.

| Option | Effect |
|---|---|
| `--status <status>` | `fix ls`: only open, verified (applied ones too) or applied fixes |
| `--goldens <dir>` | `fix apply`: where the recordings go. Default `goldens` |
| `--no-test` | `fix apply`: copy the recordings without running `shadowlap test` on them |
| `--build <command>` | `fix apply`: rebuild the agent after the patch, before the test |
| `--json` | The list, the fix, or what `fix apply` did, as JSON: the dashboard's read model of Fixes. An id that matches no fix, or several, prints `{ "status": "error", "error": { "reason": "unknown" \| "ambiguous", "message" } }` |

`fix apply` exits 1 when the fix is still open, when the patch does not apply, or when the test fails; a patch that applied stays applied. Run it in the folder the repair ran in, where its directory under `.shadowlap/repairs/` is.

`fix show --json` has the three steps in full:

| Field | |
|---|---|
| `status`, `title`, `label`, `labels`, `check`, `oracle`, `expect`, `source` | The fix: `label` is the one most of its failing runs carry, `labels` all it groups runs by; `check` is in words, `oracle` the conditions a verdict must check to count, `expect` the `--expect` JSON (null for the exit code alone); `source` says where it came from, such as `from CI · PR #138` |
| `broken` | For an applied fix that doesn't hold, why: its test failed, or a verify rejected it after it was applied |
| `failingRuns`, `goodRuns` | The runs, each with `runId`, `exists` (false once deleted from the store), `status` and `labels` |
| `steps` | Blame, repair and verify, each with `state` (`done`, `todo`, or `no` for a verify that only rejected), a `title`, a `meta` line and a `short` form. Only verdicts that count move the verify step |
| `blame` | The call where the run was lost (`lostAt`, model call `step` of `steps`), `confidence`, the `boundary` sentence, both `answers`, `probes` with their verdicts, the attempts per probe (`bundles`), every call of the run with whether it is in the blame's scope (`callRow`), `cost` and `command` |
| `repair` | The `change` with the text it `added`, the result per role (`roles`), whether its verification `counts`, where each run was `lost`, the `diagnosis`, every candidate with its `verdict` (`accepted`, `rejected`, `set aside`, `not tried`, `build failed`, `unsettled`) and `why`, the `files` handed over, the pull request body (`prBody`) and `command` |
| `verify` | One entry per change verified, newest first: its `verdict`, whether it `counts` and a `note` saying why not (or that it was rejected after the fix was applied), `headline`, `oracle`, each run's `role`, `attempts`, `outcome` and where it went (`note`), the token and cost changes per run, and what it took to find out |
| `attempts`, `spent`, `upstreamRequests` | What everything behind the fix took: the attempts that ran live, and what they and the repairer cost |
| `actions` | What can be done next: `repair` for an open fix; `apply` for a verified or applied one (`kind` is `patch`, or `mark` when there is no patch, with the `gitApply` command, and `pending` saying what applying left undone); `applied` once it is applied |

Blame, repair, verify and apply each log an activity event in the store (`blame.done`, `repair.accepted`, `repair.empty`, `verify.accepted`, `verify.rejected`, `fix.applied`).

## show

```sh
shadowlap show <run> [--json] [--request <call>] [--response <call>]
```

The timeline: one row per call with kind, name, origin (`live`, `replayed`, `blocked`, `stubbed`, `overridden`), outcome, latency and tokens or arguments; then the divergence report if the run forked. `--request n` and `--response n` print the stored payloads.

## ls

```sh
shadowlap ls [--tree] [-n <limit>] [--label <label>] [--json]
```

Runs, newest first, with their labels; `--tree` nests forks under their parents. `--label` keeps runs with that label; repeat it to require several.

`--json` prints one object per run: `runId`, `parentRunId`, `mode`, `status`, `calls`, `command`, `codeVersion`, `startedAt`, `endedAt` and `labels`, and:

| Field | |
|---|---|
| `forkedAt` | `{ callNo, type, kind, name, reason }` where the run forked, or `null` |
| `hasCommand` | `false` for a run imported from a capture: it has no command, so replaying it needs yours after `--` |
| `imported` | `{ at, from }` for a run from a pack or a capture, or `null` |
| `partial` | the kinds of call a partial recording covers (`["api"]` for a capture), or `null` |
| `repeat` | `{ group, attempt, of }` for an attempt of `replay --repeat`, or `null` |
| `checks` | `{ passed, total }` for a run from `shadowlap test --db` with [outcome checks](./ci.md#outcome-checks), or `null` |

## label, note

```sh
shadowlap label <run> bug refund-flow      # add labels
shadowlap label <run> bug --remove         # remove one
shadowlap label <run>                      # print them
shadowlap note <run> "The model skipped the refund check." [--call <n>]
```

What people know about a run that the recording can't. A label says what the run is, so it can be found (`ls --label`, the dashboard's search) and exported as part of a dataset (`export dataset --label good`). A label is up to 40 letters, digits, spaces and `_ . : / -`. A note says why, on the run or on one call; `show` prints them and the dashboard shows a call's notes in its details. Both travel in packs.

## search

```sh
shadowlap search refund policy             # every word must appear
shadowlap search '"refund policy"' --run 01M2P9PVCP -n 50 [--json]
```

Searches what runs recorded: prompts, model responses, tool arguments and tool results. Quoted words must appear together. Each match names the run, the call and where the text was found, and ends with the `shadowlap ui <run> --call <n>` that opens it. The index is built the first time you search and updated for runs that changed since; each model call indexes only the turns it added to the conversation, so a long run is indexed once, not once per call.

## ui

```sh
shadowlap ui [run] [--call <n>]
```

The [terminal UI](./tui.md). A fork opens at its divergence, unless `--call` names another call.

## test

```sh
shadowlap test <pack...> [--junit <file>] [--json <file>] [--markdown <file>] [--annotations] [--online] [--writes <policy>] [--cwd <dir>]
```

[CI mode](./ci.md): replays packed recordings offline, re-running each recorded command; a divergence, a live call, a non-zero exit or a failed [outcome check](./ci.md#outcome-checks) fails the pack. Checks, and recordings allowed to fork, are configured under `tests` in `shadowlap.config.json`. A pack with Bedrock calls gets [placeholder AWS credentials](./providers.md#credentials-on-replay) when the environment has none.

| Option | Effect |
|---|---|
| `--junit <file>` | Write a JUnit XML report |
| `--json <file>` | Write a JSON report: counts and, per pack, the result, calls by origin, tokens not re-spent, the divergence, each check and, for a repeated recording, how many attempts passed |
| `--markdown <file>` | Append a Markdown report: a results table, and the diff and agent output for each failure. Point it at `$GITHUB_STEP_SUMMARY` for a GitHub job summary |
| `--annotations` | Print a GitHub Actions error annotation for each failed pack, attached to its `run.json` |

## pack, unpack

```sh
shadowlap pack <run> <dir> [--lineage] [--no-redact]
shadowlap unpack <dir>
```

`pack` writes a run as a directory: `run.json`, `calls.jsonl`, one uncompressed file per blob under `blobs/`. Stable names and one file per blob keep it git-friendly, so it can be committed as a CI golden or shared. The [redaction rules](./normalizers-and-redaction.md#redaction) in `shadowlap.config.json` are applied to the copy; the local store is never modified. `unpack` imports a pack, treating it as untrusted input: every record is validated, every blob is verified against its hash, and a pack that fails a check imports nothing. Runs that already exist are skipped. Imported runs are marked, and `unpack` prints the command each one would run on replay:

```
imported 01K5CQ4N7G8M2XWQH6V3T9RB1D  command: node dist/agent.js --task 'triage inbox'

Replaying an imported run executes the command it was recorded with (shown above), which came from whoever made the pack.
shadowlap replay asks before running it; give your own command after "--" to run that instead.
```

[SECURITY.md](https://github.com/devjoinedthechat/shadowlap/blob/main/SECURITY.md) lists every check.

## import

```sh
shadowlap import har traffic.har         # model calls out of a HAR, as a recording
shadowlap import nock recording.json     # the same, from a nock recording
shadowlap import vcr cassette.json       # the same, from a VCR cassette (JSON serialization)
shadowlap import litellm cap/*.jsonl     # production traffic a LiteLLM proxy captured
shadowlap import har traffic.har --json  # the calls imported and the entries skipped
```

Turns a capture something else made into a recording you can replay your own code against.

| Format | What writes it |
|---|---|
| `har` | mitmproxy, Charles, Proxyman, a browser's devtools, Polly.js |
| `nock` | `nock.recorder.rec({ output_objects: true })` |
| `vcr` | VCR.py with its JSON serializer (`vcr.VCR(serializer='json')`). A YAML cassette has to be converted first: Shadowlap reads JSON so that no YAML parser is trusted with a cassette from anywhere |
| `litellm` | A LiteLLM proxy, through `shadowlap.litellm_callback` — production traffic, one run per correlation id. Takes several files, since a proxy writes one per worker. See [Capturing production traffic](./gateways.md) |

Anthropic, OpenAI, Gemini, Azure, Vertex and Bedrock hosts are recognised; every other entry is
skipped, and `--json` lists the reasons. Credentials in the capture are never stored, and header
names and values are escaped and bounded, because a capture is a file from anywhere.

The request bodies are the real ones, which is what matters: replay matches on a fingerprint of the
outgoing request, so a reconstructed body would fork at call 1. Every format produces the same
fingerprint for the same request, so it does not matter which tool captured it.

An imported run is a [partial recording](./how-it-works.md#partial-recordings): a capture of the
network holds no tool, clock or randomness calls, so a replay runs those live rather than diverging
on their absence, and `--writes` still fences write tools. No format carries SSE event boundaries,
so a streamed response replays in one piece rather than at its recorded pacing.

A capture says what was sent, not what sent it, so the run has no command to re-run: `ls` and `show`
display `<no-recorded-command>` in its place, `ls --json` says `"hasCommand": false`, and `replay`
without a command refuses and says what to run. Its cost is reported as captured, not spent: that
traffic was paid for where it ran. Give your own command:

```sh
shadowlap import har traffic.har
shadowlap replay <run> -- python agent.py
```

That replay is also how an import becomes a CI golden: the model calls come from the capture and
everything else is recorded live, so the resulting run covers everything and `shadowlap pack` turns
it into a golden for `shadowlap test`.

## calibrate

```sh
shadowlap calibrate [run] [--write] [--max-rounds <n>]
```

Replays a recording (default: the latest) offline, repeatedly, and proposes a normalizer for every value that differs between two runs of the same code, until the replay is clean. `--write` adds the proposals to `shadowlap.config.json`. No model calls; writes are blocked. See [Calibrate](./normalizers-and-redaction.md#calibrate).

## The configuration file

`shadowlap.config.json`, in the directory you run Shadowlap from. Every key is optional, and
`shadowlap init` writes one with a `$schema` line already in it:

```json
{
  "$schema": "https://raw.githubusercontent.com/devjoinedthechat/shadowlap/main/shadowlap.config.schema.json",
  "clock": "auto",
  "normalize": [{ "kind": "api", "pattern": "uuid", "replace": "<uuid>" }],
  "redact": [{ "pattern": "email", "replace": "<email>" }],
  "http": { "*.pinecone.io": "read" },
  "mcp": { "effects": { "write_file": "write" } },
  "prices": { "my-model": { "input": 1.5, "output": 7.5 } },
  "tests": { "goldens/*": { "expect": { "tools": { "send_email": 0 } } } }
}
```

| Key | What it does |
|---|---|
| `normalize` | Masks values before fingerprinting, so a generated id or today's date does not fork a replay ([details](./normalizers-and-redaction.md)) |
| `redact` | Masks stored content on `shadowlap pack`; a redacted pack still replays |
| `clock` | `auto` (default) matches dates near each run's start across days; `exact` requires equality |
| `http` | Hosts called straight from a client library, recorded as tool calls with an effect ([details](./sdk.md#http-services-without-wrapping)) |
| `mcp.effects` | Effects by MCP tool name, overriding the server's annotations ([details](./mcp.md)) |
| `prices` | USD per million tokens by model prefix, for cost estimates |
| `tests` | Outcome checks for `shadowlap test`, by recording directory ([details](./ci.md#outcome-checks)) |
| `repair` | `repairer` (`provider:model`) and `baseUrl` for the model [`shadowlap repair`](./repair.md#the-repairer) asks for fixes |

The schema is [`shadowlap.config.schema.json`](https://github.com/devjoinedthechat/shadowlap/blob/main/shadowlap.config.schema.json) in the repository. It gives completion in any
editor that reads `$schema`, and it lets CI check a config without running Shadowlap. It is
stricter than the parser on purpose: the parser ignores a key it doesn't know, so that a config
written for a newer version still works, while the schema rejects it — which is what turns
`"normalise"` from a rule that silently never applies into an error you see as you type.

`shadowlap doctor` checks the file too, and reports every rule, price and effect it parsed.

## normalize, redact

```sh
shadowlap normalize add --path '$.system[0].text' --pattern iso-date [--kind api] [--name <tool>] [--replace <text>]
shadowlap normalize ls
shadowlap redact add --pattern email [--path <jsonpath>] [--kind api|tool] [--name <tool>] [--replace <text>]
shadowlap redact ls
```

Both write to `shadowlap.config.json` in the working directory. [Normalizers](./normalizers-and-redaction.md) mask values before matching; redaction rules mask stored content on export.

## serve

```sh
shadowlap serve
```

Starts a sidecar with one recording run for a process you launch yourself and prints the environment to export. Ends the run on Ctrl-C. Hosts that manage several runs (a test runner) can create them through the sidecar's `/v1/runs` API. Each run's environment pins it: the provider base URLs carry the run id, and SDK calls send an `X-Shadowlap-Run` header, so several processes can record through one sidecar at once. With `--recordings` it starts no run of its own and serves [recorded tests](./testing.md) instead, for the pytest and Vitest integrations, which start it themselves. The printed environment has the base URLs only; clients that need [in-process capture](./providers.md#in-process-capture) (Bedrock, and Azure or Vertex with the endpoint in code) record under `shadowlap run`.

## mcp

```sh
shadowlap mcp [--effect <tool=effect>]... -- <server command>
```

A stdio proxy for an MCP server: put it in the client's server configuration in place of the server itself. `tools/call` is recorded, replayed, blocked or stubbed like an SDK tool call; every other message passes through. Effects come from the server's tool annotations (`readOnlyHint` → `read`, otherwise `write`), overridden by `--effect` or `mcp.effects` in the config. See [MCP servers](./mcp.md).

## diff

```sh
shadowlap diff <a> <b> [--json]
```

Two runs call by call, aligned by position. First, what differs about the runs as a whole: their system prompts, the tools they offered (added, removed, or with a changed definition), the models they used and their code versions. Then how many leading calls are identical in request and response, the first call whose request differs (with a structural diff and normalizer hints), how many later requests differ too, and every call whose request was the same but whose response was not, e.g. a live re-run where the model answered differently, or a tool that returned something else. Exit status 1 when the runs differ, like `diff`.

## dashboard

```sh
shadowlap dashboard [run] [--call <n>] [--port 4777] [--no-open]
```

A local web UI over the store: runs and forks, a timeline of calls by origin, the conversation at any call, playback of streamed responses, fork diffs, comparison, and replay and fork actions. Listens on 127.0.0.1 with a session token in the link it prints; a taken port falls back to a free one. See [Dashboard](./dashboard.md).

## doctor

```sh
shadowlap doctor [--json]
```

Checks what support would check: Node and the built-in SQLite, the guard preloads, Python on the PATH, the store (runs, size, schema, runs still marked running), a stale `.shadowlap/active.json`, the configuration (every rule, price and MCP effect parsed), and agent-process environment that leaked into your shell (`SHADOWLAP_URL`, `NODE_OPTIONS`, `PYTHONPATH`). Each problem comes with the fix. Exit status 1 when something is blocking.

## rm, gc

```sh
shadowlap rm <run...> [--forks]
shadowlap gc [--older-than <days>] [--keep <n>] [--dry-run]
```

`rm` deletes runs; their forks keep their data but lose the link. `gc` deletes old runs (`--older-than 30`, `--keep 200`; runs still recording are never touched), removes blobs nothing references any more, and vacuums the store. The TUI's `x` does the same as `rm` for one run.

## export html

```sh
shadowlap export html <run>                    # shadowlap-01m2p15fwy.html
shadowlap export html <run> run.html --lineage # with the run's ancestors, so they compare inside the file
shadowlap export html <run> --no-redact        # skip the config's redaction rules
```

One HTML file with the dashboard's views and the run's data built into it: calls, conversations, responses, the divergence diff, the context and timeline views, and comparison between the runs it holds. It opens from a file, an artifact or a pull request comment, on a machine that has neither Shadowlap nor the recording, and it loads nothing from the network. Actions, live updates and search across runs belong to the dashboard, not to a copy.

It is a copy of recorded data: the redaction rules in `shadowlap.config.json` apply, as they do to `pack`, and the command says so when there are none. A 30-call run is roughly 500 kB.

## export dataset

```sh
shadowlap export dataset --label good --out good.jsonl
shadowlap export dataset <run...> --calls model --format openai-chat
```

Recordings as an eval or fine-tuning dataset, one JSON line per example. Select runs by id, by `--label` (repeatable: all of them) or `--all`.

| Option | Effect |
|---|---|
| `--calls final` (default) | One example per run: its last model call |
| `--calls model` | One example per model call |
| `--format jsonl` (default) | `{ input: { messages, tools }, output: { text, tool_calls }, metadata }` |
| `--format braintrust` | `{ input, expected, metadata }` |
| `--format langfuse` | `{ input, expectedOutput, metadata }` |
| `--format openai-chat` | `{ messages }`, the recorded answer as the last assistant message |
| `--no-redact` | Skip the redaction rules |

Messages are the conversation exactly as the model saw it, in a provider-neutral shape: system, user, assistant (with its tool calls and their ids) and tool results, whichever provider recorded it. `metadata` carries the run and call, the model, labels, notes, outcome check results, the command, code version and fork point. Redaction rules without a path apply to every string; rules with a path apply to stored requests only, so they are skipped here.

## export har

```sh
shadowlap export har <run>                 # HAR to stdout
shadowlap export har <run> traffic.har
```

A run's model API calls as a HAR, for any tool that reads one, and the reverse of
[`import`](#import): exporting a run and importing it again produces the same
fingerprints. Tool, clock and randomness calls are left out, because a HAR describes HTTP. Azure,
Vertex and Bedrock hosts depend on the account, so a representative host for the provider stands in.
Credentials are never written, and redaction is already applied to what was stored.

## export otel

```sh
shadowlap export otel <run>                                   # OTLP JSON to stdout
shadowlap export otel <run> --out trace.json
shadowlap export otel <run> --endpoint http://localhost:4318  # or OTEL_EXPORTER_OTLP_ENDPOINT
```

A run as one OpenTelemetry trace: a span for the run and a child span per call, using the GenAI semantic conventions (`gen_ai.operation.name`, `gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.*`, `gen_ai.response.finish_reasons`, `gen_ai.tool.name`) plus `shadowlap.*` attributes for the origin, effect, fingerprint and cost. Trace and span ids are derived from the run id, so exporting twice updates the same trace. Headers for an authenticated collector come from `OTEL_EXPORTER_OTLP_HEADERS` (`key=value,key2=value2`). No OpenTelemetry SDK is involved.

## Environment

| Variable | Meaning |
|---|---|
| `SHADOWLAP_UPSTREAM_ANTHROPIC`, `_OPENAI`, `_GEMINI`, `_AZURE`, `_VERTEX`, `_BEDROCK` | Override a provider's upstream (a mock, or an OpenAI-compatible server such as Ollama). Without one, `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL` and `GOOGLE_GEMINI_BASE_URL` are used when they are set |
| `SHADOWLAP_CAPTURE=off` | Don't capture model calls inside Node and Python agents; only the base-URL variables apply ([details](./providers.md#in-process-capture)) |
| `SHADOWLAP_TELEMETRY=0`, `DO_NOT_TRACK=1` | Disable [telemetry](./telemetry.md) |
| `SHADOWLAP_TELEMETRY_URL` | Send telemetry to another collector |
| `NO_COLOR` | Plain output |
