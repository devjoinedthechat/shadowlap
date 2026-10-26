# CLI

Global options: `--db <path>` (default `./.shadowlap/shadowlap.db`), `-v` / `--verbose` (sidecar log on stderr, and every attempt's own line where a terminal folds them, as [blame](#blame), verify and repair do), given before the command or after it: `shadowlap --db other.db ls` and `shadowlap ls --db other.db` are the same. Each command's `--help` lists them. Run ids can be abbreviated to any unique prefix.

The CLI runs on Node 22.16 or later, but not on Node 23: every store keeps a full-text index, which Node's built-in SQLite has from 22.16 on and in 24 and later. On another Node it names the Node it needs and exits 2. On a Node in that range whose SQLite was built without full-text search, such as a custom build, opening a store says to use an official build, as [`doctor`](#doctor) does.

Every command ends with an [exit status](#exit-status) a script or a CI step can tell apart: 1 for a check that failed, 2 for a command it can't run as given, 3 for a verdict that couldn't be reached.

A store is created by the first command that records into it. Commands that only read it (`ls`, `show`, `search`, `diff`, `pack`, the exports, `fix ls`, `tasks`), or change only what it already holds (`label`, `note`, `rm`, `fix title`, and `coverage`, which keeps its scans there), never create one: where there is none they find nothing, and when the project's store is in a folder above (run from `src/`, say) they name it.

## Exit status

| Status | Meaning |
|---|---|
| `0` | Ok: the command did what it was asked, and what it judged passed |
| `1` | Failed: a check, gate or test failed, a replay diverged where it may not (`--strict`, `test`), verify or repair rejected the change, a search found nothing; or the work could not be finished: a host that didn't answer, a patch that didn't apply, a store another process held too long |
| `2` | Usage or configuration: a flag, argument or command it doesn't take, a run or fix it can't find or can't use yet (one still recording), a file it can't read, an invalid `shadowlap.config.json`, a live command with no key, a recorded command it needs `--yes` to run, a replay that would run a [write Shadowlap never recorded](./how-it-works.md#tools-shadowlap-did-not-record) again |
| `3` | Inconclusive: a gate or check that could not decide (`0` when `--inconclusive warn` lets it through), a budget spent before a verdict, the provider unavailable |
| `70` | Internal error: a bug in Shadowlap. The message says so: run the command again with `SHADOWLAP_DEBUG=1` to see where it happened, and report it |
| `128 + n` | Stopped by signal *n*: `130` for Ctrl-C, `129` for a closed terminal (SIGHUP), `143` for SIGTERM, however the command wound down (the dashboard, `serve`, `tasks serve`, `mcp`, `demo` and `replay --watch` too) |

`run` and `replay` end with the agent's own status where none of these applies, as the agent would have ended without Shadowlap: `127` for a command that isn't on the PATH, and `128 + n` for an agent a signal stopped. Each command's section says which statuses it ends with. `SHADOWLAP_DEBUG=1` prints the stack of any error, for a bug report.

## demo

```sh
shadowlap demo [--keep <dir>]
```

The whole loop on a refund agent, with no key and nothing to clone, as the
[quickstart](./quickstart.md#see-the-whole-loop-first) shows it. In a temporary folder made a git
repository, which it removes at the end, it writes the agent, the check its runs must pass and a
`shadowlap.config.json` naming the repairer, and starts a scripted model on 127.0.0.1: it answers
the agent in Anthropic's Messages API and the repairer in OpenAI's Chat Completions, and the demo
says it is scripted. Then it runs `run`, `label`, `replay`, `blame`, `repair` and `fix apply` there,
each printing as it does in a terminal, and ends with how long that took and how many requests the
scripted model answered, and where they went: the recordings, blame's attempts and repair's. After
blame it says, in a line, how to read a probe's verdict from the probes it made. Your own model keys and endpoints are left out of its environment, and
[telemetry](./telemetry.md) is off for it. `--keep <dir>` runs it in that folder, a new or an empty
one, and keeps it, to look around with `shadowlap dashboard`. It needs git. It ends with 0 when
every step did what the demo expects; otherwise with the status of the step that didn't, which it
names; 2 for a `--keep` folder that isn't empty, or without git. A stop signal (Ctrl-C, SIGTERM, or
the SIGHUP of a closed terminal) ends it once the command it runs then has ended, which a
terminal's signal stops too: it removes its folder and ends with 128 + the signal's number.

## init

```sh
shadowlap init [--json]
```

Reads the project in the current directory and prints the steps to a first recording, filled in for it:

- the language and package manager, from `package.json`, `pyproject.toml`, requirements files and lockfiles. In a package of a workspace, whose lockfile is at the workspace's root, it is the workspace's manager: the root above it, up to the repository's root, that takes the folder in (`pnpm-workspace.yaml`, `workspaces` in `package.json` with its lockfile or `packageManager` field, or `[tool.uv.workspace]`);
- the model SDKs (Anthropic, OpenAI, Gemini, and the AI SDK and LangChain provider packages), from dependencies or imports;
- the agent framework and its version: the Vercel AI SDK, OpenAI Agents SDK, Mastra, LangChain and LangGraph, the Anthropic tool runner, Pydantic AI, the OpenAI Agents SDK for Python, CrewAI;
- the command that starts the agent, from `package.json` scripts, the file `package.json` names (its `bin`, then its `main`), a script `pyproject.toml` declares (`[project.scripts]`, run with `uv run` in a uv project and `poetry run` in a Poetry one), a conventional entry file (`agent.py`, `main.py`, `agent.ts`, `index.js`…; a Python one runs with `uv run agent.py` or `poetry run python agent.py` there), or else the one file at the top of the folder that imports a model SDK and that no other file there imports (`node triage.mjs`). With several such files it names none;
- every tool definition it can find, whether it declares an effect, and a suggested effect for those that don't. An AI SDK tool kept in a constant (`const searchDocs = tool({ … })`) counts too, under the key that gives it to the model (`tools: { search_docs: searchDocs }`), or its own name in shorthand. The suggestion goes by the tool name's leading verb, and a name with no hint gets `write`, which never runs again after a fork;
- a model server the project already points at, such as Ollama in `OPENAI_BASE_URL`, and the `SHADOWLAP_UPSTREAM_OPENAI` value that keeps it as the upstream. `OPENAI_BASE_URL` counts unless every model client the project has is another provider's: an OpenAI SDK (`langchain-openai` and `@ai-sdk/openai` among them, and a framework's `[openai]` extra, which installs it), a framework that brings one (Pydantic AI as a whole, the OpenAI Agents SDK, CrewAI, Mastra), `openai` in a lockfile, or SDKs `init` can't tell all count. An agent on Anthropic's or Gemini's SDK alone (or Pydantic AI's slim package with its `[anthropic]` extra) never sends to it, and neither does Pydantic AI when every model its code names is another provider's (`Agent("anthropic:claude-sonnet-4-5")`) and it builds no OpenAI model or provider: Pydantic AI makes a client only for the providers of its models, so the OpenAI client it installs, and the `openai` that puts in a lockfile, go unused.

It warns about a model client constructed with a literal base URL: `shadowlap run` cannot redirect it, so its calls would not be recorded. It warns too about a Node the project pins before 18.18 (`.nvmrc` or `.node-version`, `18.17`): an agent on it never starts under Shadowlap, since that Node refuses the guard.

Its install step adds the SDKs with the project's package manager, and the CLI: `shadowlap` as a dev dependency, which the steps after it run with `npx`, or for a Python project `npm install --global shadowlap`. Run by a global `shadowlap`, it leaves the CLI out, and the steps run that one.

`init` writes one file: an empty `shadowlap.config.json`, only when there is none. The detection reads source text; it runs nothing. `--json` prints the findings as JSON, with the lines the dashboard's setup shows (`summary`: the language with its pinned runtime and package manager, the model SDKs with their versions, the framework, the command and where it came from, what happened to the config, and `node`, the Node the project pins with its minor and whether it is older than the guard takes, `tooOld`), each tool marked `wrapped` or not, the tools that aren't (`unwrapped`), and the code that wraps them in the project's language, through its framework's adapter (`wrap`). The addresses it prints (`modelServer`, `hardcodedBaseUrls`) never carry credentials: a password, or a key in the query, is left out, and a model server that had one gets no `upstream`. Run it again after wrapping them to check again: the config is left as it is and the tools are scanned afresh. In a folder that is a [project in the dashboard](./dashboard.md#projects), `init` also marks the first step of its setup done, and `project` says whether it could (`noted`), and why not (the project list was busy, or a newer Shadowlap wrote it); in a terminal, a line on stderr says so. Run by the dashboard, whose setup has its own buttons for the next steps, it prints only what it found, a line each, and what it did with `shadowlap.config.json`. The rest of the object is what was found: `cwd`, `languages`, `packageManager`, `providers` (each SDK and the package it came `via`), `frameworks`, `command` (its `argv` and where it came `from`), `tools` (each with its `file`, `line`, `effect`, `suggested` effect, `why` and `wrapped`), `scannedFiles`, `config` (its `path`, whether it `existed` and was `created`) and `folder` (the kind of project the folder holds).

## run

```sh
shadowlap run -- <command> [args...]
```

Records a run. `--summary-json <file>` also writes its summary as JSON, and `--guard warn|off` sets the [network guard](./how-it-works.md#the-network-guard) (default `warn`). Starts a sidecar, sets `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `GOOGLE_GEMINI_BASE_URL`, `SHADOWLAP_URL` and `SHADOWLAP_RUN_ID` for the child, preloads [in-process capture](./providers.md#in-process-capture), the network guard and [recorded user input](./sdk.md#what-a-person-types) into Node and Python children, and exits with the child's exit code. The run's status is `completed`, `failed` (non-zero exit) or `crashed` (interrupted: Ctrl-C, or a stop signal that reached Shadowlap or the agent). A command that isn't on the PATH never starts: `run` (and `replay`) says so (`✗ pythn: command not found on PATH`, and where `python` is missing but `python3` is there, the command with `python3`), keeps no run and exits 127. So does one that can't start for another reason, with that reason: a path to a file that isn't there, or a program that is there but can't run, in the system's own words. In `test` and `bisect` a golden whose command never started fails with the same words, and one replayed in a working directory that doesn't exist (`--cwd`, or a folder a commit doesn't have yet) says so rather than blaming the command. A Node agent on a Node before 18.18 never starts either: that Node refuses the preload (`--import` in `NODE_OPTIONS`) and exits 9 before any of the agent runs. `run` and `replay` then say the agent's Node is too old for Shadowlap's guard, which needs Node 18.18 or later, and keep no run; `test` fails the golden with those words, and `replay --repeat`, `blame`, `verify`, `repair` and `decisions` stop with them. Where the agent prints straight to the terminal, as under `run` and `replay`, Shadowlap can't read that refusal, so it asks the agent's Node again: the one the command names, else the `node` on its PATH. A Node that a launcher or a script picks, such as `npx node@18.17.0` or `volta run`, can't be asked: an agent it starts that exits 9 before any call keeps its run, and the summary adds that if Node printed `--import= is not allowed in NODE_OPTIONS` above, the agent's Node is too old. On Windows a command that is a batch file, such as `npm start` or `npx tsx agent.ts`, runs through cmd.exe, its arguments passed on as given. What the run did unrecorded is kept on it for its page in the [dashboard](./dashboard.md#what-a-runs-page-is-worked-out-from): the hosts the guard saw it reach without Shadowlap, and the tools [`init`](#init) finds in the project with no declared effect that the run never recorded. At its end, `run` names the tools the model called that the run recorded no call of, which a replay runs for real ([details](./how-it-works.md#tools-shadowlap-did-not-record)).

Stopping a run: a stop signal reaches the agent once. In a terminal the agent shares Shadowlap's process group, so the terminal's Ctrl-C reaches both, as it would reach the agent alone, and the agent keeps the terminal to read from (`/dev/tty` included, as a password prompt opens it). As a dashboard job it shares the job's process group, which the dashboard stops, and kills when it can't wait, as a whole. Elsewhere (CI, a script) the agent leads a process group of its own, and Shadowlap passes it each SIGINT, SIGTERM or SIGHUP it gets, once; an agent still running three seconds later is killed with its group, and a second signal kills it at once. Closing the terminal (SIGHUP) ends the run as interrupted too, and kills an agent that ignores it. A signal that comes while the run's [judge checks](./judges.md) are asked is kept for when they are done; a second one ends the run as interrupted at once. An agent a signal ended exits with 128 + its number: 130 for SIGINT, 129 for SIGHUP, 143 for SIGTERM. `replay --repeat`, `test`, `blame`, `verify` and `decisions --from-code` stop their agents the same way, and an agent still running when Shadowlap itself exits is killed with its group.

`--summary-json` writes `{ "exitCode", "summary", "unrecordedTools" }`: the agent's exit code, the tools the model called that the run never recorded (each `name`, `count`, `firstCallNo`, `effect` and `why`, as [`show --json`](#show) lists them), and the run's summary, which has `runId`, `mode`, `status`, `total` (calls), `byOrigin` and `byKind` (calls per origin and per kind), `upstreamRequests` (live calls that reached a provider), `injected` (calls `--fail-at` answered), `refused` (calls answered with why they weren't sent: an intervention that couldn't be applied, or a [placeholder key](./how-it-works.md#keys) a live call would carry), `imported`, `tokensNotRespent`, `cost` (`spent`, `saved` and `captured` in USD, and `unknownModels` with no price), `durationMs`, `notReached` (recorded calls the replay never made), `extraReads` (clock, random and pure reads the recording held no counterpart for, answered live while the replay went on: [extra reads](./how-it-works.md#the-replay-state-machine)), `warnings` and `divergence`: the report, or `null`. Every count and cost is the agent's: a run with [judge checks](./judges.md) has `judge` too, what the judge's calls did and cost apart from them (`calls`, `replayed` from the recording, `live`, `notAsked`, kept for runs recorded when a call no one answered was kept and 0 since, `upstreamRequests`, `spent`, `saved`, `unknownModels`). A replay whose every request matched but that stopped before its recording did has one too, of type `ended_early`, kept on the run like any other: `callNo`, `kind` and `name` are the first recorded model call, or call of a tool that isn't pure, it never made, `replayedBefore` the calls it was served, and `recorded` the calls the recording holds.

## replay

```sh
shadowlap replay <run> [options] [-- <command> [args...]]
```

Replays a recorded run; forks at the first changed call. Re-runs the recorded command unless one follows `--`.

A clean replay needs no real key. The agent gets a [placeholder key](./how-it-works.md#keys) for each provider whose key the recording's environment held and this one has no credential for; a live call that would carry one, after a fork, is refused with one line (`a live call needs a real key: set ANTHROPIC_API_KEY, or keep the replay offline`), and whatever the agent signs in with itself (a key you set, one it loads from `.env`, a profile, a token provider, an instance role) is used as it is.

A run imported with `unpack`, or a replay of one, carries a command someone else recorded. `replay` shows it and asks before running it. Without a terminal to ask on, it refuses: pass `--yes` once you have read the command, or give your own after `--`.

| Option | Effect |
|---|---|
| `--strict` | Exit 1 if the replay diverges, or ends before its recording does (for CI) |
| `--writes block\|stub\|allow` | What `write` tools do after divergence. Default `block` |
| `--reads live\|replay` | What `read` tools do after divergence. Default `live` |
| `--live-tool <name>` | Force this tool live: its first call, and every call of it after a fork (repeatable); use after fixing a tool |
| `--live-input` | After the fork, ask for what a person types instead of serving the recorded answers in order ([recorded input](./sdk.md#what-a-person-types)) |
| `--diverge-at <call>` | Force call *n* live |
| `--fail-at <call>=<failure>` | Fail call *n* instead of serving it, so the agent's own error path runs: a model call with an HTTP status (`--fail-at 12=429`, [details](./interventions.md#inject-a-failure)), a tool call with `timeout`, `error`, `error:<message>` or a status (`--fail-at 19=timeout`); the tool does not run ([details](./interventions.md#fail-a-tool)). Repeatable |
| `--inject-result <call>=<text\|@file>` | Plant an instruction in what read tool call *n* returned, as an attacker would leave it; the rest of the result stays. Text that starts with `@` is written `@@…`. Repeatable ([details](./interventions.md#plant-an-instruction-in-a-tool-result)) |
| `--expect <json\|@file>` | Checks the replay (each attempt, with `--repeat`) must pass besides exiting 0, as for `blame`: `'{"tools":{"send_email":0}}'`. Default: the checks `shadowlap.config.json` gives the recording ([below](#checks-on-a-replay)) |
| `--watch` | Replay again whenever a file in the project changes. What a replay writes itself (the agent's own files, the store, the `--summary-json` file) starts no other: a file that changes while a replay runs is taken for one of its writes, and the replay says so, so a save made then needs saving again. Ctrl-C to stop |
| `--summary-json <file>` | Also write the summary (with `--repeat`, every attempt and the report) as JSON to a file |
| `--prompt-from <call>` | Apply your changed system prompt and tool definitions only from model call *n*: earlier model calls replay from the recording ([details](./interventions.md#apply-a-changed-prompt-from-a-later-call)) |
| `--override <call>=<json\|@file>` | Substitute a recorded tool result; the run forks at the first model call that sees it |
| `--inject <call>=<text>` | Add an instruction at model call *n* and keep it in place in every later request of the conversation ([details](./interventions.md#inject-an-instruction)) |
| `--inject-as user\|system` | `user` (default): part of the user turn the model answers next, on every provider. `system`: a system message after the conversation; refused on Gemini and Bedrock Converse |
| `--set <call>:<key>=<value>` | Set a request field from model call *n* on, where the provider keeps it (`temperature` is `generationConfig.temperature` on Gemini, `inferenceConfig.temperature` on Bedrock Converse); a dotted key is a path (repeatable, [details](./interventions.md#patch-parameters)) |
| `-y`, `--yes` | Run the recorded command of a run imported from a pack, or pulled from the [team store](./team.md), without asking (see below) |
| `--repeat <n>` | Run the replay *n* times and report how the attempts differ after the fork (see below) |
| `--concurrency <n>` | With `--repeat`: attempts running at once. Default 1 |
| `--model <call>:<model>` | Switch the model from model call *n* on: in the body, or in the path on Gemini, Vertex AI, Bedrock and Azure |
| `--guard warn\|block\|off` | [Network guard](./how-it-works.md#the-network-guard) for connections that bypass Shadowlap. Default `warn` (`run` accepts `warn\|off`; `test` defaults to `block`) |
| `--allow-unrecorded <names>` | Run these tools again for real though the recording never recorded them and they [write](./how-it-works.md#tools-shadowlap-did-not-record), or nothing says what they do: names separated by commas (repeatable). Without it, a replay whose model called such a tool is refused before anything runs, exit status 2 |
| `--chaos` | Run the [error-path presets](#error-path-presets) on this run instead of one replay: a fork for each, judged by `--expect` (or, for a golden's run, by its `chaos.expect` or the write limits of its `expect`), writes stubbed unless `--writes` is given. `--summary-json` writes their report. It doesn't combine with the flags that change a replay |
| `--presets <list>`, `--chaos-tool <name>`, `--inconclusive fail\|warn` | With `--chaos`, as for [`test --chaos`](#test) |

Exit status: the agent's, except 1 with `--strict` when the replay diverged or ended early, 1 when a [check](#checks-on-a-replay) failed, 1 under `--guard block` when the agent made model or tool calls and no Shadowlap preload loaded in its processes, or one of them runs with no guard (the Claude Code CLI the Claude Agent SDK runs), so the [network guard](./how-it-works.md#the-network-guard) never watched it (its summary then reads `✗ Replay not watched`, never clean), and 3 when the agent exited 0 and a check could not be decided. With `--repeat`, 0 only when every attempt asked for ran, exited 0, was watched by the guard under `--guard block` and passed its checks; else 1 (with `--strict`, also when any attempt diverged or ended early), or 3 when all that kept an attempt from passing is a check that could not be decided; a `--repeat` Ctrl-C cut short exits 130. A run still recording is refused, exit status 2, until it has ended: it has no end to replay to yet, as the dashboard's Replay and Fork wait for it; one whose recording process was killed (see [`gc`](#rm-gc)) replays as it is. `--summary-json` writes what `run` writes, its `exitCode` the agent's, or 1 where the guard never watched it under `--guard block`, with `checks` (each check as it [came out](./checks.md#how-a-check-comes-out): `status`, `ok`, `label`, `detail`) when the replay has checks, and as `unrecordedTools` the tools this replay ran for real without recording them; with `--repeat`, `{ "attempts", "report" }`: each attempt's `exitCode`, so counted, `summary`, `checks` and `unrecordedTools`, and the report the terminal prints (`parentRunId`, `attempts`, `forkedAt`, `paths`, `tools`, `distinctFinalResponses`, `succeeded`, `spent`, `saved`, `tokensNotRespent`).

See [Interventions](./interventions.md) for what each one does to the conversation prefix, and what each provider takes. A change the recorded request can't take (a system message on Gemini, a field Converse has no place for, a write tool to plant in) is refused before anything runs, with the reason; an intervention the replay never reached is named in its summary.

The replay keeps the options that change what it does (`--fail-at`, `--override`, `--inject`, `--inject-result`, `--model`, `--set`, `--prompt-from`, `--diverge-at`, `--live-tool`, and `--writes` or `--reads` when not the default) on its run, so its page in the [dashboard](./dashboard.md#what-a-runs-page-is-worked-out-from) names what made the fork and the fork menu can make it again. The run keeps each flag exactly as given, an override's result included, beside a short form to show: an override read from a file is named by the file (`--override 16=@policy.json`), one given inline by its call, and a long instruction is shortened. A copy of the run (`pack`, `export html`) keeps only the short form, with the project's redaction rules applied to it.

### Checks on a replay

A replay is judged by checks when it has them: `--expect`, or, without it, the `tests` entry of `shadowlap.config.json` for the recording the run came from (the pack it was unpacked from, or the golden `shadowlap test` replayed). The checks are those of an [outcome check](./ci.md#outcome-checks), [`calls` and `when` rules](./checks.md) included; the replay exits 1 when one fails, and 3 when the agent exited 0, none failed and one could not be decided, and they are kept on the run, with the `--expect` they came from, so making the fork again from the fork menu judges it the same way. With `--repeat`, every attempt is judged, and the report says in how many attempts each check failed, could not be decided (inconclusive) or did not apply:

```
  Checks (--expect)
    ✗ send_email called 0 times: failed in 2 of 3 attempts (#1, #3)
```

The agent's output is captured, while still shown, only when a check reads it (`output`, or a judge check of the output). A replay that plants text with `--inject-result` and has no checks says that nothing judged whether the agent obeyed it.

A [judge check](./judges.md) is asked once the agent exits, before the replay's run ends: a clean replay is answered from its recording, a fork asks the judge live, and either way the call is the replay's own. Its line gives the verdict, the judge's reason and where it came from, and its entry in `checks` has `status` (`passed`, `failed`, or `inconclusive` when it was not judged), `reason`, `source` and `judge`.

### Repeating a fork

Everything after a fork is live, so a model may do something different each time. One good attempt doesn't show that a change fixed the behavior. `--repeat n` runs the same replay *n* times, each attempt its own run, and summarizes them:

```
⑂ 5 attempts from 01M2P9PVCP, each forked at call 11
  5 of 5 exited 0 · 20 upstream requests · 16.2k input tokens not re-spent

  Paths after the fork
    5×  open_ticket (stubbed) → open_ticket (stubbed) → open_ticket (stubbed)
  every attempt took the same path

  Tools after the fork
    tool         attempts   calls
    open_ticket  5 of 5     15 (15 stubbed)

  Final model responses: 5 different
```

A path is the sequence of tool calls after the fork and what happened to each: blocked, stubbed, overridden or an error. Tools called between the same two model calls match in any order, since agents often run them at once. Attempts with the same path are grouped, most common first. Arguments aren't part of a path; `shadowlap diff` compares two attempts in full, and the report names the pair to start with. The prefix before the fork is served from the recording, so it costs nothing however many attempts there are. If attempts fork at different calls, the report says the prefix isn't deterministic. An attempt that stopped before its recording did, with every request matching, forked nowhere but is no clean replay either: the first line counts those apart (`· 1 of 5 ended early, at call 7`), and each attempt in the JSON report has `endedEarly`, the first recorded call it never made, or `null`.

With `--concurrency`, attempts run at the same time through one sidecar; each attempt's output is printed whole when it finishes. `--strict` exits 1 if any attempt diverged or ended early; otherwise the exit code is 0 only when every attempt exited 0 and passed its [checks](#checks-on-a-replay).

## blame

```sh
shadowlap blame <run> [options] [-- <command> [args...]]
```

Finds the model call where a failed run was lost: the last one whose answer, asked again, lets the run pass. It first replays the run as recorded to confirm the failure, then probes model calls with forks that replay everything before the probed call for free, and binary-searches for the boundary. [Blame](./blame.md) explains the search, the report and the limits. Its progress goes to stderr: in a terminal a probe's attempts fold into one line that counts them as they come, which the probe's verdict then takes the place of; with `-v`, or anywhere else (a CI log, a file, the dashboard), every attempt keeps its line, with its run id. Verify and repair print theirs the same way.

| Option | Effect |
|---|---|
| `--expect <json\|@file>` | What a passing run must do besides exiting 0: the `expect` object of an [outcome check](./ci.md#outcome-checks), such as `'{"tools":{"send_email":0}}'` |
| `--gate <json\|@file>` | How a probe decides, after each attempt ([gating](./gating.md#verify-and-blame)): a gate that tells a re-asked call that passes `good` of the time or more (a rescue) from one that passes `bad` or less (lost), up to `max` attempts. `risk` is the whole search's, spread over the most probes it can make, so each probe runs at its share with its `max` deepened to match ([the search](./blame.md#how-it-works)). A probe's verdict shows its tally and its bound at its own confidence under the rule, stated once: `rescued · 5 of 10 · rate >= 0.10 (99.1%)` under `gate: rescue at 60%+, lost at 10%-, <= 5% risk, up to 32 attempts`, in a search of 6 probes. Default `{"good":0.6,"bad":0.1,"risk":0.05,"max":20}`: for a search of 5 to 10 probes, three straight passes rescue and six or seven straight failures lose. Give any of the four |
| `--attempts <n>`, `--passes <n>` | A fixed count instead of the gate: attempts per probed call (5 with `--passes` alone), and how many passing make a rescue (default 2, or 1 with one attempt) |
| `--model <model>` | Rescue with this model from the probed call on, instead of asking the recorded one again |
| `--set <key=value>` | Set a request field from the probed call on, such as `temperature=1` (repeatable) |
| `--scope <name>` | Probe only model calls made in this [scope](./sdk.md#scopes): the agent's, and not a simulated user's |
| `--scan <n>` | Model calls past the boundary to probe too, in case rescue works again after it. Default 2 |
| `--writes stub\|block` | What write tools do after the fork. Default `stub`; `allow` is not accepted. A write the recording made, with the same arguments, gets what it got then, an error included |
| `--reads live\|replay` | What read tools do after the fork. Default `live` |
| `--concurrency <n>` | Attempts of one probe running at once; the probe decides on them in the order they started, and its first verdict stands. One starts only while fewer than *n* have started that the probe hasn't counted, so at most *n* − 1 run past the attempt that decides. Default 1 |
| `--budget <usd>` | Start no attempt once this much is spent on live model calls |
| `--timeout <seconds>` | Stop an attempt after this long and count it as failed |
| `--json` | The report as JSON on stdout ([fields](./blame.md#json)) |
| `--guard`, `--allow-unrecorded`, `-y` | As for `replay` |

Exit status 0 when the search reaches a verdict (a blamed call, or no call that rescues the run); 1 when it refuses what it saw: the run passes its oracle, or does not replay as recorded; 2 when it can't start: a run with no model call to probe, `--budget` with a model that has no price, or a run whose model called a tool it never recorded that [writes](./how-it-works.md#tools-shadowlap-did-not-record); 3 when it stops before a verdict, the budget spent or the provider unavailable, when what the replay as recorded showed could not be decided, or when its first probe could not tell a rescue from a loss (*Not settled from the first model call*); 128 + n for a stop signal, 130 for Ctrl-C.

Each blame is kept with the [fix](#fix) it opens or joins, by the run's labels, else its check.

## verify

```sh
shadowlap verify --fixes <run...> [--holdout <run...>] [--keeps <run...>] [options] [-- <command> [args...]]
```

Checks a change before it ships. Replays failing runs, which the change must now fix, and good runs, which it must not break, under the code in the working directory, and accepts the change only when every failing run passes its gate and every good run is kept: no worse than the same run under the code before the change by the margin or more, attempt for attempt. Runs are ids, unique prefixes or `label:<name>`. A replay that forks nowhere settles its run in one free attempt. [Verify](./verify.md) explains the roles, the report and the warnings.

| Option | Effect |
|---|---|
| `--fixes <run...>` | Failing runs the change was written to fix |
| `--holdout <run...>` | Failing runs of the same kind the change was not written against |
| `--keeps <run...>` | Runs that passed and must not get worse, each kept against its own baseline, such as `label:good` |
| `--expect <json\|@file>` | What a passing run must do besides exiting 0, as for `blame` |
| `--gate <json\|@file>` | How a run decides, after each attempt where its replay forks ([gating](./gating.md)): a gate that tells a run that passes `good` of the time or more from one that passes `bad` or less, each verdict wrong at most `risk` of the time at those two rates, up to `max` attempts. Default `{"good":0.9,"bad":0.7,"risk":0.05,"max":80}`: a run that always passes is accepted after 12 attempts, one that always fails rejected after 3. Give any of the four |
| `--attempts <n>`, `--passes <n>` | A fixed count instead of the gate: attempts per run where the replay forks (5 with `--passes` alone), and how many must pass (default 80% rounded up, 4 of 5) |
| `--model <model>`, `--set <key=value>` | The change is a request field, set from each run's first model call |
| `--from <model>` | With `--model` or `--set`: change only the model calls made with this model, from the first of them on, such as the agent's and not a simulated user's or a sub-agent's on another model (repeatable). `decisions --then-verify` and `migrate` pass the models they switched from |
| `--live-tool <name>` | The change is in this tool: run it live, its first call and every call of it after a fork (repeatable) |
| `--writes stub\|block`, `--reads live\|replay` | As for `blame` |
| `--concurrency <n>` | Runs verified at once. Default 1 |
| `--budget <usd>`, `--timeout <seconds>` | As for `blame` |
| `--fail-fast` | Start nothing new once a run has failed |
| `--margin <share>` | A good run that forks is kept unless its pass rate drops this much or more below its baseline's, at the gate's risk ([good runs](./verify.md#good-runs-against-their-own-baseline)). Default `verify.margin` in `shadowlap.config.json`, else 0.1: 10 points |
| `--baseline paired\|history` | What a good run is compared with: `paired`, the same run under the code before the change, each attempt paired with one of the change's; `history`, its golden's test history. Default `verify.baseline`, else `paired` |
| `--base <rev>` | With a paired baseline: the commit before the change, checked out on its own for the baseline's attempts. Default HEAD, when the working tree has a change |
| `--build <command>` | With a paired baseline at a commit: build its checkout before its attempts, such as `"npm run build"` |
| `--json` | The report as JSON on stdout ([fields](./verify.md#json)) |
| `--guard`, `--allow-unrecorded`, `-y` | As for `replay` |

Exit status 0 when the change is accepted, 1 when it is rejected, 2 when a run's model called a tool the run never recorded that [writes](./how-it-works.md#tools-shadowlap-did-not-record), before anything runs, 3 when the verification did not finish (a run's gate or baseline inconclusive, the budget spent, the provider unavailable), 128 + n for a stop signal. The verdict is kept with the [fix](#fix) of its failing runs, whatever it is; an accepted one turns the fix verified when it [counts](./verify.md#verdicts-are-kept) there: it checked the fix's check on a run that failed it.

## repair

```sh
shadowlap repair --fixes <run...> [--holdout <run...>] [--keeps <run...>] [options] [-- <command> [args...]]
```

Fixes failing runs. Blames each one, asks a model you choose (`--repairer`, or `repair.repairer` in the config) to rewrite the system prompt or a tool description, and keeps the smallest rewrite `verify` accepts twice, the second time with fresh attempts, on the failing runs, runs held out from the repairer, and the good runs. Rewrites that name a detail of the failing runs, or add a placeholder the agent would fill in, are set aside before anything runs. Each candidate is verified in a temporary git worktree, never in the working tree, and a good run against the same run under the code without the candidate, in another; the fix comes out as a patch, a pull request body and a recording of each fixed run. [Repair](./repair.md) explains the loop and the safeguards.

| Option | Effect |
|---|---|
| `--fixes`, `--holdout`, `--keeps <run...>` | The failing runs, the failing runs kept from the repairer (default: every other `--fixes` run, when there are two or more), and the runs that must keep passing: one that forks is kept unless it drops 10+ points below its baseline, the same run on the code without the candidate, attempt for attempt, as [verify](#verify) keeps one, its verdict bounding the drop as verify's does (`drop <= 0.10 (95%)`) |
| `--expect <json\|@file>` | What a passing run must do besides exiting 0 |
| `--repairer <provider:model>` | `anthropic` (Claude Opus 5.5), `anthropic:<model>`, `openai:<model>`, or `claude-code[:<model>]` to run your own Claude Code in print mode |
| `--repairer-timeout <seconds>` | Give up on the repairer when it hasn't answered after this long. Default `repair.timeout` in the config, else 600 |
| `--candidates <n>` | Rewrites to ask for. Default 3 |
| `--stronger <model>` | When the recorded model can't be rescued, rescue with this one and try switching to it, before asking the repairer |
| `--scope <name>`, `--set <key=value>` | As for `blame`: which calls to probe, and what probes change, such as `temperature=1` |
| `--gate <json\|@file>` | The gate each candidate's runs are verified by, as for `verify`. Default `{"good":0.9,"bad":0.7,"risk":0.05,"max":80}` |
| `--attempts <n>`, `--passes <n>` | A fixed count instead of the gate, as for `verify` |
| `--max-growth <percent>` | Reject a fix that grows input tokens per run by more than this, before verify runs it when its rewrite alone does. Default 25 |
| `--build <command>` | Build the agent in each candidate's worktree and in its baseline's, and in the working tree after `--apply` |
| `--apply` | Leave the accepted fix in the working tree |
| `--branch <name>` | Commit it to a new branch without checking anything out |
| `--pr` | With `--branch`: push it and open a pull request with `gh` |
| `--goldens <dir>` | With `--apply` or `--branch`: put the recordings of the fixed runs in this directory too; with `--branch`, one inside the repository |
| `--budget <usd>` | Stop once this much is spent on blame, the repairer and verification |
| `--writes`, `--reads`, `--concurrency`, `--timeout`, `--guard`, `--allow-unrecorded`, `-y` | As for `verify` |
| `--json` | The report as JSON on stdout ([fields](./repair.md#json)) |

Exit status 0 when a candidate is accepted and handed over as asked; 1 when none is accepted, or the hand-over fails; 2 when it can't start: outside a git repository, another repair running in the folder, a branch it can't make, a run whose model called a tool it never recorded that [writes](./how-it-works.md#tools-shadowlap-did-not-record); 3 when it stops before a verdict, the budget spent or the provider unavailable; 128 + n for a stop signal. The repair is kept with the [fix](#fix) its blames opened or joined, even when the hand-over failed: when a candidate is accepted under the fix's check the fix turns verified, and when none is, the fix stays open with every candidate tried and why it was dropped.

## fix

```sh
shadowlap fix ls [--status open|verified|applied] [--json]
shadowlap fix show <fix> [--json]
shadowlap fix title <fix> <title...>
shadowlap fix apply <fix> [--goldens <dir>] [--no-test] [--build <command>] [--json]
shadowlap fix pr <fix> [<url>] [--json]
```

A fix is one failure, from the blame that reproduced it to a change that held. A [blame](./blame.md#fixes) opens one or joins one, by the run's labels, else its check; [verify](./verify.md#verdicts-are-kept) and [repair](./repair.md#the-fix-it-reports-to) report to the fix of the runs they were given, and their verdict counts for it only when it checked the fix's check on a run that failed it. Fix ids look like `fx-01M3RZ4XKN…`; any unique prefix works, with or without `fx-`, and the list shows the first ten characters.

- **`fix ls`** lists fixes, the most recently opened first: status (`open`, `verified`, `applied`), id, title, label, failing runs, and how far each step got (*lost at #5 · prompt fix · 3 fixed · 1 kept*). A second line gives what its failing runs did and the check they must meet (*failed: send_email called twice, not once · must: send_email called once*; what they did is the title blame gave the fix when it opened it, so the line names it only once someone renames the fix), where the fix came from (*from CI · PR #138*) and when it was opened, and a third says so when an applied fix doesn't hold.
- **`fix show`** prints a fix, with what its failing runs did and the check they must meet as `fix ls` says them, and its three steps: where the run was lost and the probes that found it; the change, the candidates tried and why each was dropped, who proposed them or why no repairer did (*not fixed · the repairer could not be asked: claude was not found*), and the repair's warnings; and every verdict, named by what changed (a repair's candidate, the request fields it set, or the code version) and headed by the runs it checked, with each run's role and outcome; one that doesn't count for the fix says why in its heading. It ends with what to do next, and says when the repair it suggests would end *No fix to try* without running the agent, and why (the blames it would reuse rescued no failing run), or couldn't ask its repairer from here (`claude` isn't on the PATH).
- **`fix title`** replaces the title derived from the check with one of your own; blames that join the fix later keep it. With a team store, the latest rename on any machine is the one every machine keeps.
- **`fix pr`** records the pull request opened for a fix, given its `https://` link: `repair --pr` and CI's [fix on failure](./ci.md#fix-on-failure) record theirs, so the list says where the fix went (*from CI · PR #138*). With no link it reads where the recorded pull request stands from GitHub, with `gh pr view` (installed and signed in), and records it: *open*, *merged* or *closed*. Only a pull request on github.com, on the host `GH_HOST` names, or on the host of the project's `origin` remote is read: a fix pulled from the team store can name any address, and `gh` would send that host a token (a token for a GitHub server of your own only ever goes to the host `GH_HOST` names). When `gh` can't say, or isn't asked, the state stays as recorded and the line says why. The [dashboard](./dashboard.md) reads it the same way, in the background, while Fixes is open.
- **`fix apply`** hands a verified fix over. It runs `git apply` on the accepted repair's `fix.patch`, copies the recordings the fixed code made into the goldens folder, runs [`shadowlap test`](#test) on them, and marks the fix applied. Then it replays the project's other goldens offline, in a store of their own that nothing keeps, and names each that now diverges on what the patch changed (a prompt or a tool description goes into every request): a request field that holds text the patch added, or lost text it removed. It prints the command that re-records them, `shadowlap test <goldens> --update`; a golden that may fork is named only when it forks before its task's takeover, as `--update` re-records it then. `--no-test` skips this too. A teammate's repair, from the [team store](./team.md), left its recordings on their machine: `fix apply` puts the patch in, says so in one line, and leaves nothing to finish. Nothing here runs the code that patch put in, no `--build`, test or replay of the other goldens: it says to read the change (`git diff -- <file>`) and then run `shadowlap test`. Before anything goes in, the patch is checked against the repair it came with: it has to be the rewrite of the accepted candidate, to that candidate's file alone, changed in place (no file made, deleted, renamed or copied, no mode or binary change). One that is anything more is refused and nothing is changed, as is one to a file git ignores, whose change neither `git status` nor `git diff` would show, or to a file reached through a link to a folder, which `git apply` refuses too. The patch goes in on the file's bytes as they are, so the file is the one the repair verified: git applies it to a copy of them that nothing converts, where `git apply` in the working tree would convert line endings as `core.autocrlf` (Git for Windows sets it) or a `text` or `eol` attribute in `.gitattributes` asks, and write a file with LF back with CRLF on every line. A patch whose lines end otherwise than the file's (a teammate's, made where the file has LF, for a checkout where it has CRLF) applies only through that conversion, so it goes in as `git apply` puts it in, and the file keeps its CRLF. Applied is marked on this machine only. A patch already in the tree, applied by hand, committed, or left there by `repair --apply`, is recognised with `git apply --reverse --check` and only marked. When the working tree has changes the patch conflicts with, nothing is changed, and the message says whether to commit or stash them or to apply the patch by hand. A fix verified on the working tree itself, with no repair behind it, has no patch, so it is only marked applied; one verified with a change of request fields (`--set`, `--model`) says which, since no file carries them: set them in your agent.

Run again on an applied fix, `fix apply` finishes what is left, and keeps when the fix was applied: it copies the goldens not in the project yet (`repair --apply` copies none without `--goldens`), and runs the test when it hasn't passed, on goldens copied before where they are. With nothing left, it does nothing; with `--no-test` it says when a test is still to pass. A test that fails leaves the fix applied, marked as not holding, until a run of `fix apply` passes it, or a `shadowlap test` session passes every one of its goldens (after `test --update` re-recorded what another fix changed, say), which says the fix holds again.

It trusts nothing it reads from the store: the repair's directory must be `.shadowlap/repairs/<repair id>`, each golden inside its `goldens/`, the patch the accepted candidate's one rewrite to that candidate's file and no larger than a repair writes, that file a plain file git doesn't ignore (not a symbolic link or a folder), and `fix.patch` the patch the repair verified, or it changes nothing and says why.

| Option | Effect |
|---|---|
| `--status <status>` | `fix ls`: only open, verified (applied ones too) or applied fixes |
| `--goldens <dir>` | `fix apply`: where the recordings go. Default `goldens` |
| `--no-test` | `fix apply`: copy the recordings without running `shadowlap test` on them |
| `--build <command>` | `fix apply`: rebuild the agent after the patch, before the test |
| `--json` | The list, the fix, what `fix apply` did, or the fix's pull request (`fix pr`: `{ fixId, pr: { url, number, state, at } }`, with a `note` saying why when the state is as recorded because GitHub wasn't asked or couldn't say), as JSON: the dashboard's read model of Fixes. An id that matches no fix, or several, prints `{ "status": "error", "error": { "reason": "unknown" \| "ambiguous", "message" } }`, exit status 2 |

`fix apply` exits 1 when the patch does not apply or the test fails, and 2 when the fix is still open (nothing verified to apply) or it runs outside the repository and folder the repair ran in; a patch that applied stays applied. Run it in the folder the repair ran in, where its directory under `.shadowlap/repairs/` is.

`fix show --json` has the three steps in full:

| Field | |
|---|---|
| `status`, `title`, `label`, `labels`, `check`, `failed`, `oracle`, `expect`, `source` | The fix: `label` is the one most of its failing runs carry, `labels` all it groups runs by; `check` is in words, `failed` what its failing runs did (as `fix ls` has it), `oracle` the conditions a verdict must check to count, `expect` the `--expect` JSON (null for the exit code alone); `source` says where it came from, such as `from CI · PR #138` |
| `broken` | For an applied fix that doesn't hold, why: its test failed, or a verify rejected it after it was applied |
| `failingRuns`, `goodRuns` | The runs, each with `runId`, `exists` (false once deleted from the store), `status` and `labels` |
| `steps` | Blame, repair and verify, each with `state` (`done`, `todo`, or `no` for a verify that only rejected), a `title`, a `meta` line and a `short` form. Only verdicts that count move the verify step |
| `blame` | The call where the run was lost (`lostAt`, model call `step` of `steps`), `confidence`, the `boundary` sentence, both `answers`, `probes` with their verdicts, the attempts per probe (`bundles`), every call of the run with whether it is in the blame's scope (`callRow`), `cost` and `command` |
| `repair` | The `change` with the text it `added`, the result per role (`roles`), whether its verification `counts`, who proposed it (`repairer`) or why no repairer did (`noRepairer`: its `text`, and the `warning` that says what to do), where each run was `lost`, the `diagnosis`, every candidate with its `verdict` (`accepted`, `rejected`, `set aside`, `not tried`, `build failed`, `unsettled`) and `why`, the `files` handed over, the pull request body (`prBody`), what each stage `cost` and how many `attempts` it ran (the probes of the blames it ran and every candidate's verification), `command` and `warnings` |
| `verify` | One entry per change verified, newest first: its `verdict`, whether it `counts`, the change it checked named by what changed (`code`: a repair's candidate, the request fields it set and from which call, or the code version; `label` as the dashboard's switch shows it), its `headline` (by the runs it checked, or for one that doesn't count, why), a `note` when it was rejected after the fix was applied, `oracle`, each run's `role`, `attempts`, `outcome` and where it went (`note`), the token and cost changes per run, what it took to find out, and its `reasons`, with those that say a run is inconclusive or not settled, rather than that the change failed it, in `unsettled` |
| `attempts`, `spent`, `upstreamRequests` | What everything behind the fix took: the attempts that ran live, and what they and the repairer cost |
| `actions` | What can be done next: `repair` for an open fix (`noFix` says why it would end *No fix to try* without running the agent, or is `null`); `apply` for a verified or applied one (`kind` is `patch`, or `mark` when there is no patch, with the `gitApply` command, `pending` saying what applying left undone, every file the patch changes in `files`, the patch itself in `diff` and where it is kept in `patchFile`, `inTree` when it is in the working tree already, which applying only marks, how many recordings applying copies into the goldens folder in `goldens`, the request fields a change with no patch set in `change`, and `refused` saying why `fix apply` won't apply it, when the patch is more than the change its repair verified; `gitApply` is `null` then, and once the patch is in); `applied` once it is applied |
| `fixId`, `href`, `failing`, `good`, `openedAt`, `verifiedAt`, `appliedAt`, `openedBy` | As in `fix ls`, and who opened it |
| `blames`, `repairs`, `defaultStep`, `defaultVerify` | Every blame (`blameId`, `runId`, `at`, `outcome`, `lostAt`, `confidence`) and repair (`repairId`, `at`, `outcome`, `accepted`, `title`) behind the fix, newest first; the step the dashboard opens at, and the verdict it shows first: the newest that counts |
| `commands`, `repairer`, `applied` | The `blame`, `repair` and `verify` commands to run it again; the repairer the config names (`name`, whether it is `configured`, and on an open fix the `problem` that keeps it from being asked here, such as `claude` not on the PATH, or `null`); and, once applied, how (`patch`, `repairId`, the `goldens` copied, `tests`, `by`, `via`) |

`fix ls --json` prints `{ fixes, counts }`: each fix as its row in the list, with `fixId`, `href` (where the dashboard shows it), `status`, `title`, `label`, `labels`, `check`, `failed` (what its failing runs did, in the words blame titled the fix with when it opened it, which a title of someone's own no longer says; for a fix opened on another machine, the first failure its blame recorded; `null` when no blame recorded one), how many runs are `failing` and `good`, its `steps`, `source`, when it was `openedAt`, `verifiedAt` and `appliedAt` (epoch milliseconds, or `null`), why it is `broken`, and the `attempts` and USD `spent` behind it; and the `counts` of `all`, `open` and `verified` fixes, applied ones counted as verified. `fix apply --json` prints `{ fixId, status, again, patch, repairId, goldens, tests, outdated, update }`: `status` is `applied`, or `already-applied` when nothing was left to do; `again` when it finished a fix applied before; what became of the `patch` (`applied`, `already` in the tree, or `none` to apply); the `repairId`; each golden's `from`, `to` and whether it was `copied`; the `tests` (`passed`, `failed` or `skipped`); the project's other goldens that diverge on what the patch changed, `outdated`, each with its `golden`, `callNo` and request field `path`; and `update`, the command that re-records them, or `null`. An error prints `{ fixId, status, error }` with `status` `error`, as the `--json` row says.

Blame, repair, verify and apply each log an activity event in the store (`blame.done`, `repair.accepted`, `repair.empty`, `verify.accepted`, `verify.rejected`, `fix.applied`).

## decisions

```sh
shadowlap decisions <runs|goldens...> (--model <model> | --from-code | --set <key=value>) [options] [-- <command> [args...]]
shadowlap decisions --verify <session> [runs...] [options] [-- <command> [args...]]
```

Previews what a change decides differently, without running the agent. Each recorded model call is asked again: its request exactly as recorded, with only what the change touches swapped in, sent through the same upstreams a live call goes to. The answer's decision (the tools it calls, in order, with their arguments, and whether it stops or hands over) is compared with the recorded one and ranked by consequence, writes first. A text-only change that one of the run's [judge checks](./checks.md#judge-checks) reads is judged on the recorded words and the new ones, and ranks 2 when the check comes out otherwise. No tool runs, and a step doesn't depend on the one before, so the steps are asked in parallel. [Decisions](./decisions.md) explains the ranks, the report and the limits.

Runs are ids, unique prefixes or `label:<name>`; a path such as `goldens/*` names packs, which are imported as `test` imports them and named as its history names them. The change is one or more of `--model`, `--set` and `--from-code`. A model switch changes the agent's calls: those made with the model the runs use most, or with the models `--from` names. A call made with another model (a simulated user, a sub-agent) is left as recorded and counted `untouched`, and Shadowlap's own calls (its judge's, in a `shadowlap:` scope) are no step at all. Requests need the provider's credentials on this machine (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `AZURE_OPENAI_API_KEY`; AWS credentials for Bedrock, Google credentials for Vertex AI), unless `SHADOWLAP_UPSTREAM_<PROVIDER>` points the provider at a server of your own; without them nothing is sent and the command says which is missing. An Azure OpenAI deployment call is sent with the `api-version` it was recorded with; one recorded before recordings kept a call's query takes `OPENAI_API_VERSION` (or `AZURE_OPENAI_API_VERSION`), as the AzureOpenAI SDKs do, and without it nothing is sent.

| Option | Effect |
|---|---|
| `--model <model>` | The change is this model, at the agent's model calls: in the body, or in the path on Gemini, Vertex AI, Bedrock and Azure. A model of another family than the recorded one (a Claude call asked of `gpt-…`) is not asked: its requests take another format, which is verify's to test |
| `--from <model>` | The recorded model the change switches from: `--model` and `--set` change only the calls made with it (repeatable; an alias names its dated snapshots). Default: the model the runs use most; with `--set` alone, every call |
| `--from-code` | The change is the system prompt and tool definitions your working tree sends now. They are read by replaying each run offline under your code, its model calls matched without their prompt and tools; nothing is sent to read them, no tool runs, and the replay is not kept. A run whose first model request differs in more than its prompt and tools is refused, with the difference |
| `--set <key=value>` | The change sets this request field, where the provider keeps it (`temperature` is `generationConfig.temperature` on Gemini); repeatable |
| `--samples <n>` | Ask each model call *n* times under the change and, from 3 on, *n* times as recorded, the control, and rank a step only when its decisions run more consequential than the control's, by an exact permutation test at 5% ([sampling](./decisions.md#reading-the-report)). Default 3: six requests a step. Below 3 there is no control, and a step flags its run when more than half its samples show a write, stop or judged change |
| `--concurrency <n>` | Requests in flight at once. Default 4. A run whose requests carry cache breakpoints is asked one step at a time, in order |
| `--scope <name>` | Ask only the model calls made in this [scope](./sdk.md#scopes); `none` for those made in no scope |
| `--then-verify` | Then run [`verify`](#verify) on the runs with a rank 1 or 2 change, and only on those: a run that passed as recorded must keep passing, one that failed must now pass, each under its checks (its golden's, or for a run named by id those of the recording it comes from) or `--expect`, one verify per set of checks |
| `--verify <session>` | Ask nothing: verify the runs a kept session flagged (its `dc-…` or `mg-…` id, or a prefix of it), or those of them named after it, as `--then-verify` verifies them, under the session's change, and keep what verify finds in the session. The dashboard runs it as its `decisions-verify` job |
| `--expect <json\|@file>`, `--gate <json\|@file>`, `--attempts <n>`, `--passes <n>`, `--writes stub\|block`, `--guard` | With `--then-verify` or `--verify`: as for [`verify`](#verify). Each run is decided by verify's gate, unless `--attempts` or `--passes` gives a fixed count |
| `--budget <usd>` | Send no request, and start no verify attempt, once this much is spent |
| `--timeout <seconds>` | Stop a model request, or a verify attempt, after this long. A model request waits ten minutes by default, as the official SDKs do |
| `--strict` | Exit 1 when a run has a rank 1 or 2 change, for CI |
| `--inconclusive fail\|warn` | What an inconclusive result does to the exit status: `fail` (the default) exits 3, `warn` exits 0 with a warning |
| `-y`, `--yes` | Run the recorded command of a run imported from someone's pack (`--from-code`, `--then-verify`, `--verify`) without asking. A golden named by its pack folder runs its command as `test` runs it |
| `--json` | The report as JSON on stdout (below); progress goes to stderr |

The command after `--` replaces each run's recorded one, for `--from-code`, `--then-verify` and `--verify`.

Exit status 0 when every run was asked; 1 when `--then-verify` or `--verify` rejected the change, or with `--strict` when a run has a rank 1 or 2 change. A result that settles nothing is inconclusive, and exits 3 unless `--inconclusive warn`: it stopped early (the budget; Ctrl-C exits 130), a run could not be asked at all (a `--from-code` change that is more than a prompt, a model that refused every step), a run nothing else flags has a text-only change a judge check reads that could not be judged, in any sample of a step its samples don't flag (no key for the judge's provider, the budget spent), or verify didn't settle the runs it took. The change is sent as given: when the new model refuses the requests as recorded, a warning says what it takes instead (`thinking={"type":"adaptive"}`, `temperature` left out), which [`migrate`](#migrate) sends. Each session is kept in the store, with each run's part as a row of its own for its page in the dashboard, and logs a `decisions.done` activity event.

`--json` prints the report the dashboard reads: `decisionsId` (`dc-…`, the session as the store keeps it), `kind` (`decisions`), `at`, `change` (its `model`, its `fields`, `from`, the recorded models they change at, or `null` for every call, `fromCode`, and `text`, the change in words), `command` (the command that asks the same way again, every option given), `samples`, `runs`, `counts` (steps by the rank they were given, `1` to `5`, then `noise` for those whose samples decided otherwise no more often than as recorded, `same`, `untouched` for a request the change leaves as it was, such as one the working tree sends with the same prompt or one made with a model the switch leaves, and `notAsked`), `flagged` (the runs a rank 1 or 2 change flags: beyond the control's variation, or with no control by what most samples show), `cost` (per run, the mean `before` and `after` in USD; what asking `spent`; `upstreamRequests`; and `unknownModels` with no price), `tokens` (`before` and `after`, each `input`, `output`, `cacheRead` and `cacheWrite`), `retirements` (each model the runs use, or switch to, that its provider retires, as [the retirement table](./decisions.md#model-retirements) has it: `provider`, `model`, `platform`, `matched`, `deprecated`, `retires`, `earliest`, `regions`, `replacement` as the page words it and the model ids it names in `replacements`, `state`, `days`, `source` and `text`), `notes` (what to keep in mind reading it: later steps are judged in the recorded run's state, reasoning left out, cache breakpoints kept, calls left as recorded, the text-only steps a judge check reads and how they came out, values masked), `warnings`, `verify` (with `--then-verify`: the `verdict`, `accepted`, `rejected`, `incomplete`, or `not-run` when no run needed verifying or verify could not run, with why in `reasons`; the `verifyIds` kept, each run's `runId`, `role`, `outcome` in verify's own words, `passes` and `attempts`, `bound`, the bound of its pass rate under the gate, exact under its stopping (`rate >= 0.73 (95%)`; `null` for a clean replay or a fixed count), `undecided`, why its last attempt could not be judged, which stopped it `inconclusive`: that attempt neither passed nor failed, and there is no bound (`null` otherwise), and the `rule` it was decided by; a good run kept against its own baseline has the `baseline`'s `passes` and `attempts`, and its `bound` is the drop's (`drop <= 0.10 (95%)`); the `rule` they were decided by, stated once (`gate: tells 90%+ from 70%- at <= 5% risk, up to 80 attempts`; `null` in a session whose runs were decided by different rules, verified again later under other figures, where each run's own says which), the `commands` that verify them again, what it `spent`, its `upstreamRequests` and `reasons`; else `null`), `judge` (what the judge checks that read text-only steps found, and what judging cost apart from asking: the `steps` whose text-only change a check reads, of which the `changed` steps a check came out otherwise for, the `inconclusive` steps that wait on a judge (a sample's words could not be judged, and the step's samples don't flag it without them), and the rest every check came out as recorded for; what the judge's calls made now `spent`, their `upstreamRequests` and the `unknownModels` with no price; `null` when no check read a step), `remedies` (empty here; see [`migrate`](#migrate)) and `stopReason`.

Each of `runs` has `runId`, `golden` (or `null`), `steps` (its model calls), `asked`, `rank` (the most consequential rank its steps were given, or `null`), `majority` (the same by what decides a step: beyond the control's variation, or with no control what most samples show; a `1` or `2` here flags the run), `counts`, `cost` (`before` and `after` for the steps asked, and what asking them `spent`) and `tokens`, `thinkingStripped`, `refused` (why none of its calls could be asked, or `null`), `decisions` and `warnings`. Its `decisions` are its model calls, the changed ones first, most consequential first: `callNo` in the recording, `step` among its model calls, `scope`, `rank` (with a control, the rank it earns beyond the control's variation, else the most consequential change any sample showed; `null` when none, and when the request as recorded got no answer for now, which leaves the step not settled), `majority` (with a control, the same; else the rank more than half its samples show, or `null`), `changes` (each with its `rank`, its `kind`, one of `write-added`, `write-removed`, `write-arguments`, `write-order`, `stops`, `handover`, `judge` (a judge check comes out otherwise for the new words, its status `before` and `after`), `read-added`, `read-removed`, `read-arguments` and `text`, the `tool` and its `effect`, `before`, `after` and a `detail` sentence), `recorded` and `now` (each decision's `stop`, one of `tools`, `answer`, `limit`, `refused`, `paused` and `other`, the provider's `stopReason`, its `tools` with their arguments and effect, and its `text`; `now` is `null` when no answer came; a text, here and in a `text` change, keeps its first 2,000 characters, and says how many more the recording holds, while the comparison reads all of it), `samples` (`asked`, `answered`, `changed`, `unjudged`, the text-only samples whose words a judge check reads but could not judge, and each sample's rank in `ranks`, 0 for the same), `control` (the request asked as recorded, as often, from 3 samples on: `asked`, `answered`, `changed`, `ranks`, and `error`, why none was answered; with it, `rank` and `majority` are the rank the change earns beyond the control, or `null`; absent below 3 samples), `noise` (with `control`: `p`, the exact one-sided p-value that the change's decisions run more consequential than the control's), `sampled` (with `control`: the most consequential change any sample of the change showed, ranked or not), `model` (`recorded` and `asked`), `tokens` (`before` as recorded, `after` as the new answer would use them in a run like the recorded one: its input split between cache reads, cache writes and plain input as the recorded call's was), `cost` (`before` and `after` for those tokens, and what asking it `spent`, every sample), `thinkingStripped` (reasoning blocks left out of the request), `error` (why it wasn't asked, or got no answer) and `judge` (for a text-only change a judge check reads, `now`'s, the sample shown: the most consequential, or among text-only ones one whose words could not be judged; each check: its `name`, what it reads (`of`: `answer` or `run`), its `model`, the answer that `pass`es, its verdict on the `recorded` words and on the `now` ones, each with its `status` (`passed`, `failed` or `inconclusive`), the judge's `verdict` (`yes`, `no`, or `null` when not judged), its `reason` (or why it is inconclusive: `not judged: …`), the `source` of the verdict (`recording`, the golden's own judge call; `kept`, asked before and kept with a session in this store; `live`; `null` when not judged), what it `cost` now in USD (0 when free) and `request`, a digest of the judge's request, by which the very same request is answered again for free; and whether the check `changed`, `null` when either side is inconclusive; `null` when no check read the step). Values the project's [redaction rules](./normalizers-and-redaction.md) match are masked in every argument, text and error the report holds, as in every export, pack and share link.

`--verify --json` prints `sessionId`, `kind` (`decisions` or `migrate`, the session's), `change` (in words), `verify` (as above, for the runs verified now) and `passes` (a migrate session's runs as its What still passes reads now, as [`migrate`](#migrate) prints them; `null` for a decisions session). A refusal before anything is asked (no credentials, no such run or session) prints `{ "kind": "decisions", "outcome": "error", "error": { "message": … } }`: `kind`, `outcome` and `error`, and exits 2.

A request that fails is retried twice when the provider says so (408, 409, 429, 5xx), honouring `retry-after`; one the provider refuses keeps its answer's message in `error`.

## migrate

```sh
shadowlap migrate --to <model> [goldens...] [options] [-- <command> [args...]]
```

Switches models with the evidence, for a model a provider retires or one you would rather pay for. It runs [`decisions --model`](#decisions) on the goldens (`goldens/*` unless you name packs or runs), with the fields the new model refuses changed to what it takes, then [`verify`](#verify) on the runs with a rank 1 or 2 change, and compares what a run costs. It ends in one report: what changes, what still passes, what it costs, and what to set. [Decisions](./decisions.md#migrate) explains each block.

It switches the agent's model calls: those made with the models `--from` names, else those made with a model the [retirement table](./decisions.md#model-retirements) says retires, else those made with the model the runs use most. A simulated user or a sub-agent on another model keeps its own, in the preview and in verify alike, and Shadowlap's own calls (its judge's) are none of the agent's.

| Option | Effect |
|---|---|
| `--to <model>` | The model to switch to. Required |
| `--from <model>` | The recorded model to switch from (repeatable; an alias names its dated snapshots). Default: as above |
| `--scope <name>` | Only the model calls made in this scope; `none` for those made in no scope |
| `--set <key=value>` | A request field the switch sets as well (repeatable) |
| `--samples <n>`, `--concurrency <n>` | As for `decisions` |
| `--expect <json\|@file>` | What a passing run must do besides exiting 0. Default: each run's checks from `shadowlap.config.json`, its golden's, or for a run named by id those of the recording it comes from |
| `--gate <json\|@file>`, `--attempts <n>`, `--passes <n>`, `--writes stub\|block`, `--guard` | Verify's, as for [`verify`](#verify). Each run is decided by verify's gate, unless `--attempts` or `--passes` gives a fixed count |
| `--budget <usd>`, `--timeout <seconds>` | As for `decisions` |
| `--inconclusive fail\|warn` | What an inconclusive result does to the exit status, as for `decisions` |
| `-y`, `--yes` | Run the recorded command of a run imported from someone's pack without asking; a golden runs its command as `test` runs it |
| `--json` | The report as JSON on stdout (below) |

The fields it changes come from two places. The [retirement table](./decisions.md#model-retirements) keeps what a provider's pages say it stops accepting: Anthropic's Claude 4.7 and later, in a Messages API request on the Claude API, Bedrock or Vertex AI, answer a non-default `temperature`, `top_p` or `top_k` with a 400, and the page says to omit them, so they are left out of what to set (the preview and verify send `temperature` its default, 1, meanwhile); they refuse a manual thinking budget too, so `thinking` becomes `{"type": "adaptive"}`; and OpenAI's o-series take `max_tokens` as `max_completion_tokens`. And the new model's own refusal, when it names what to change (`max_tokens: 64000 > 32000`, *at most 16384 completion tokens*, *Only the default (1) value is supported*, `"thinking.type.enabled" is not supported`, *'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead*): the step is asked once more with that field changed, and so is every later request to that model through that provider that needs it (an output limit only ever lowers a request, and never under its thinking budget). Verify runs with the fields set to a value; a field to leave out or to send under its new name has to change in your agent's requests first, since verify runs your code, so verify waits for it and the report says what to change. A refusal that names nothing to change stays the step's `error`.

It writes the pull request body and the change to the project's files (a patch `git apply` takes) under `.shadowlap/migrations/<id>/`, and keeps the report in the store (`mg-…`), logging a `migrate.done` activity event. The patch changes only a string value that names a model it switches from in code and config (a string literal, a JSON value, a YAML, TOML or `.env` value); every other mention (in prose and changelogs, in tests, as an object key such as a price table's, inside a longer string, in `shadowlap.config.json`) is left as it is and listed for review. Exit status 1 when a run verify took breaks under the new model; when the report settles nothing (it stopped early, a step got no answer, a flagged run went unverified, a run nothing else flags has a text-only change a judge check reads that could not be judged), 3 unless `--inconclusive warn`; else 0.

`--json` prints `migrateId`, `kind` (`migrate`), `at`, `from` (the recorded models it switches from), `to`, `command`, `decisions` (the [decisions report](#decisions), with its `remedies`: each `field`, its `value` (what the requests were sent with in its place, `null` when it was left out of them), whether your agent's requests should leave it out (`leftOut`), the name it goes under instead (`renamedTo`, or `null`), `why`, its `source` page, or `null` when the provider's refusal said it, and the `steps` that needed it), `changes` (`runs`, `flagged`, and each rank 1 or 2 change most samples show, a judged one included, in `steps`: `runId`, `golden`, `callNo`, `rank`, `detail`, the `recorded` and the `now` action, and how the `arguments` differ), `passes` (verify's `verdict`, `not-run` when no run needed verifying or verify waits for a change to your code, and each run's `runId`, `golden`, `verdict`, one of `passed`, `failed` and `inconclusive`, `outcome`, in verify's own words when it was `verified` (`kept`, `fixed`, `broken`, `not-fixed`, `inconclusive`, `unsettled`), else `unchanged` when no write, stop or judged change was found, so its recording's own verdict stands and it was not re-run, `unsettled` when a flagged run went unverified, `not-judged` when a text-only change a judge check reads could not be judged, or `not-asked`, and `tally`, for a run verify took, its `passes`, `attempts`, `bound` (exact under the gate's stopping), the `rule` that decided it and `undecided` as there, else `null`), `costs` (`perRun` and `total`, `before` and `after` in USD, `tokensPerRun`, and what `checking` cost: `decisions`, `judge`, judging the text-only changes a judge check reads, and `verify`), `set` (the `--set` `flags` verify took, the `fields` changed, and those `given` with `--set`), `configChange` (the `files` patched, with the `places` in each, the `patch`, and each mention left for `review`: its `path`, `line` and `text`; `null` when no file names the model), `pullRequest` (`title` and `body`), `files` (where the `dir`, the `pullRequest` body and the `patch` were written), `retirements`, `notes`, `warnings` and `stopReason`. A refusal before anything is asked prints `kind`, `outcome` (`error`) and `error`, as `decisions` does.

## tasks

```sh
shadowlap tasks [--json]
shadowlap tasks score [goldens...] --model <model> [--base-url <url>] [--attempts <n>] [--reads replay]
shadowlap tasks serve [goldens...] [--port 4779] [--base-url <url> [--key-env <name>]]
shadowlap tasks models [--json]
```

Goldens as tasks a model can be scored on: a model under test takes over at one model call, the calls before it replay from the recording for free, and the golden's checks score what it did from there. `tasks` lists them: where the model takes over and why, what each rewards, which tools run live or are stubbed after the takeover, and whether each is ready, blocked (its test fails, its last test is inconclusive, its test may fork and forked before the takeover, which `test --update` fixes, or it was packed from a capture and has no command), not a task (its checks only cap tokens and cost, or its model calls are made in more than one scope) or has no golden, with a warning when every ready task rewards the same behaviour. The takeover, why, what a task rewards and the agent's scope can be set in a `task` object next to its `expect` in the config. [Training](./training.md) explains the defaults.

`tasks score` scores a model on every ready task, or on the goldens given (`.` for every golden of the project): each attempt is a run, the score is the share of checks it passed of those that applied (a [`when`](./checks.md#conditions) whose condition never held is left out), and scores are kept per model (scoring a model again replaces its scores, unless the re-score stops short). `--model <name>` asks the recording's provider for another model, `anthropic:<name>` and `openai:<name>` that provider's API, and `--base-url` an OpenAI-compatible server such as Ollama or vLLM; when that isn't the API the recording spoke, the conversation is translated at the takeover and the answer back. Either way a small upstream on 127.0.0.1 asks the model under test from the takeover call on, whatever the agent asked before it, and answers in the recording's own API: Anthropic's, OpenAI's (chat completions or the Responses API), Gemini's, Amazon Bedrock's (Claude, and the Converse API) or Vertex AI's and Azure OpenAI's. Another model of Bedrock, Vertex AI or Azure OpenAI themselves can't be asked: score Anthropic's or OpenAI's API, or a model at your own endpoint, on those recordings. [Training](./training.md#how-the-model-takes-over) has which model can answer which recording, every option and the JSON.

| Option | Effect |
|---|---|
| `--model <model>` | The model to score (required) |
| `--base-url <url>` | An OpenAI-compatible endpoint, such as `http://127.0.0.1:8000/v1` (no user or password in it) |
| `--key-env <name>` | The variable holding the endpoint's key; default `OPENAI_API_KEY` for api.openai.com, `ANTHROPIC_API_KEY` for `anthropic:` on a recording that isn't Anthropic's (another model of the recording's own provider goes with the agent's own key) |
| `--attempts <n>` | Attempts per task. Default 5 |
| `--reads live\|replay` | What read tools do after the takeover. Default `live` |
| `--concurrency <n>`, `--budget <usd>`, `--timeout <seconds>`, `--guard` | As for `blame` |
| `--json` | The scores as JSON on stdout |

Exit status 0 when every task was scored in full; 1 when a task was skipped or stopped; 3 when the budget stopped it; 2 when nothing given can be scored.

`tasks serve` answers one attempt per HTTP request, for a training loop that wants a reward: `POST /v1/tasks/<task>/attempts` with `{"model": …, "baseUrl": …}` returns each check's result, the score, the run and its cost. It listens on 127.0.0.1, checks the `Host` header and needs the token it prints (`SHADOWLAP_TASKS_TOKEN` sets it, at least 16 characters). `--base-url <url>` is the endpoint requests that name none ask, and `--key-env <name>` the variable whose key goes to that endpoint and nowhere else. [Training](./training.md) shows a request and its response.

`tasks models` lists models to score: the one the recordings used, each configured provider's models (Anthropic's and OpenAI's with the keys in the environment, Ollama's on this machine) and the models scored before, each with its price per attempt, last score and the ready tasks it can answer (a model that can answer none says why). A provider that doesn't answer within `--timeout` (1500 ms) becomes a note.

## show

```sh
shadowlap show <run> [--json] [--request <call>] [--response <call>]
```

The timeline: one row per call with kind, name, origin (`live`, `replayed`, `blocked`, `stubbed`, `overridden`), outcome, latency and tokens or arguments; then the divergence report if the run forked. Above it, the run's status, duration, upstream requests and what it spent, and for a replay what replaying didn't spend again (`$0.0075 not re-spent (8.1k input tokens)`). A run stopped before it ended (Ctrl-C, a kill, a crash, or a recorder that went away) reads `interrupted`, as the dashboard says it; `--json` keeps the stored status, `crashed` or `running`. Input tokens, here and in each row, are everything the model read: uncached, written to the prompt cache and read from it, as `test`, `replay` and the dashboard count them. A teammate's run pulled from the [team store](./team.md) says who spent it where it was recorded (`≈$0.0030 spent by maya`), and a run from a pack or a capture what its traffic cost where it ran (`of traffic captured`). A run with [untrusted reads](./injection.md) (the reads of a tool the config's `tools`, the SDK's `trust` or its MCP server's `openWorldHint` marks untrusted, where `shadowlap injection` plants) names them above the timeline, each with where its mark came from (the first five, then how many more), and tags each one's row `untrusted`, as the dashboard's Calls view does. A line names the tools its model called that the run recorded no call of (`not recorded: Bash (14 calls from #3, writes)`), which a replay runs for real ([details](./how-it-works.md#tools-shadowlap-did-not-record)). `--request n` and `--response n` print the stored payloads.

`--json` prints `{ "run", "summary", "calls", "untrusted", "unrecordedTools" }`: the run as stored (`runId`, `parentRunId`, `mode`, `status`, `divergence`, `command`, `codeVersion`, `startedAt`, `endedAt`, `meta`), its summary as [`run --summary-json`](#run) writes it, every call as stored (`runId`, `callNo`, `kind`, `name`, `fingerprint`, `occurrence`, `origin`, `effect`, `requestRef`, `meta`, `at`, `end`, `attempts`), its untrusted reads in call order, as the dashboard's `GET /api/injection/runs/:id` lists them (`callNo`, `name`, and `from`: `config`, `sdk` or `mcp`), empty for a run with none, and the tools its model called that the run never recorded, `unrecordedTools` (each `name`, how often the model asked for it, `count`, the model call that first did, `firstCallNo`, its `effect`, `write`, `read` or `unknown`, and `why`), empty for a run with none. The dashboard's Provenance tab copies the same object.

## ls

```sh
shadowlap ls [--tree] [-n <limit>] [--label <label>] [--json]
```

Runs, newest first, with their labels; `--tree` nests forks under their parents. `--label` keeps runs with that label; repeat it to require several. A run stopped before it ended, or left marked running by a recorder that went away, reads `interrupted`, as the dashboard lists it; `--json` keeps the stored status.

`--json` prints one object per run: `runId`, `parentRunId`, `mode`, `status`, `calls`, `command`, `codeVersion`, `startedAt`, `endedAt` and `labels`, and:

| Field | |
|---|---|
| `forkedAt` | `{ callNo, type, kind, name, reason }` where the run forked, or `null`. A replay that stopped before its recording did has `type` `ended_early` at the first recorded call it never made, and lists as `ended early @n`, never as a clean replay |
| `hasCommand` | `false` for a run imported from a capture, recorded through [`serve`](#serve), or recorded by a test that gave no command (its command reads `<test>` and the test's name): it has no command, so replaying it needs yours after `--` |
| `imported` | `{ at, from }` for a run from a pack, a capture or the [team store](./team.md) (then `from` is the store's URL, `s3://…`, `gs://…`, `az://…` or `r2://…`), or `null` |
| `partial` | the kinds of call a partial recording covers (`["api"]` for a capture), or `null` |
| `repeat` | `{ group, attempt, of }` for an attempt of `replay --repeat`, or `null` |
| `checks` | `{ passed, total }` for a run from `shadowlap test` with [outcome checks](./ci.md#outcome-checks), or `null`: `passed` counts only the checks that passed, and when there are any, `inconclusive` and `notApplicable` count those that [could not be decided or did not apply](./checks.md#how-a-check-comes-out); the rest of `total` failed |

## label, note

```sh
shadowlap label <run> bug refund-flow      # add labels
shadowlap label <run> bug --remove         # remove one
shadowlap label <run> [--json]             # print them
shadowlap note <run> "The model skipped the refund check." [--call <n>]
```

What people know about a run that the recording can't. A label says what the run is, so it can be found (`ls --label`, the dashboard's search) and exported as part of a dataset (`export dataset --label good`). A label is up to 40 letters, digits, spaces and `_ . : / -`. A note says why, on the run or on one call; `show` prints them and the dashboard shows a call's notes in its details. Both travel in packs. `label --json` prints `{ runId, labels }` with the labels as they are after the change.

## search

```sh
shadowlap search refund policy             # every word must appear
shadowlap search '"refund policy"' --run 01M2P9PVCP -n 50 [--json]
```

Searches what runs recorded: prompts, model responses, tool arguments and tool results. Quoted words must appear together. Each match names the run, the call and where the text was found, and ends with the `shadowlap ui <run> --call <n>` that opens it. Matches in attempts (blame's probes, verify's attempts, `replay --repeat`'s), which repeat the run they came from word for word, come after those in the runs you made, as in the dashboard's search. The index is built the first time you search and updated for runs that changed since; each model call indexes only the turns it added to the conversation, so a long run is indexed once, not once per call, and a run still recording is indexed from where the last search stopped, not from its first call again.

`--json` prints one object per match: `runId`, `callNo`, `kind`, `name`, `field` (`prompt`, `response`, `arguments` or `result`), `snippet` (the text around the match) and `runStartedAt`. Exit status 1 when nothing matches, as for `grep`.

## ui

```sh
shadowlap ui [run] [--call <n>]
```

The [terminal UI](./tui.md). A fork opens at its divergence, unless `--call` names another call.

## test

```sh
shadowlap test <pack...> [--junit <file>] [--json <file>] [--markdown <file>] [--annotations]
               [--update] [--online] [--writes <policy>] [--cwd <dir>] [--guard <mode>] [--push]
               [--inconclusive fail|warn] [--max-attempts <n>] [--suite-risk <r>] [--continue]
shadowlap test <pack...> --chaos [--presets <list>] [--chaos-tool <name>] [--inconclusive fail|warn]
```

[CI mode](./ci.md): replays packed recordings offline, re-running each recorded command; a divergence, a live call, a non-zero exit, a replay that [ends before its recording does](./ci.md#a-replay-that-ends-early) or a failed [outcome check](./ci.md#outcome-checks) fails the pack. Checks, and recordings allowed to fork, are configured under `tests` in `shadowlap.config.json`. Each replay's agent gets a [placeholder key](./how-it-works.md#keys) for each provider its recording called whose credentials the environment lacks, so a job without secrets tests it; `--online`, `--update`, `--chaos` and a golden that may fork give none, and need the real keys. A `*` in the last part of a path (`goldens/*`) is expanded by the command itself. A golden replays the recording and the command its own pack holds: when the store already holds another recording under the pack's run id (a copy pulled from a pull request's folder, a pack someone sent that reused the id, the golden a copied one came from), the pack's command runs if only the command differs, and the golden fails, naming where the store's copy came from, if the calls differ. The store's copy's command never runs. A store's copy that differs only in its [redaction rules](./normalizers-and-redaction.md#redaction), more of them or fewer (the run recorded here under the golden packed from it, or a newer pack's copy under an older checkout's pack), is the pack's recording, and replays with every rule either one carries as a normalizer.

A golden whose entry has an [injection gate](./injection.md#gate-ci-on-it) (`"injection": { "obeyed": 0, "repeat": 3 }`) gets its injection test once its replay passed: payloads planted in its untrusted reads, live from the model call that reads them, writes stubbed and reads the recording doesn't hold fenced. It fails, as an `injection` failure, when more attempts obey (or are influenced) than the gate allows, and when the test showed too little to say: no untrusted read to plant in, an attempt in which a model call failed or the agent exited non-zero, no attempt a model read, or a test cut short. That verdict is inconclusive, and `--inconclusive warn` lets it through.

Each session is kept in the project's store as [test history](./ci.md#test-history): the command, the revision, passed and failed (an inconclusive golden is neither: its result says so), and each golden's result with why it failed (for a divergence, the first change the normalizers in force don't mask: the report lists the masked ones too, without a hint to add a rule the config has); global `--db :memory:` keeps nothing. Until it ends, the store also names the process running it, so the dashboard shows a session started in a terminal as running, and one whose process was killed as one that did not finish. Each replay prints `replaying run <id>` and is marked as made by `test` for its golden; a golden replayed more than once (`repeat`, or a `gate`) numbers its attempts, and files them under the one its result shows, so the dashboard lists them as one test run. A golden with a [gate](./gating.md) runs attempts until the gate decides, and says how in one line, the verdict word, the tally, the bound and the rule (`passed · 12 of 12 · rate >= 0.73 (95%) · gate: tells 90%+ from 70%- at <= 5% risk, up to 80 attempts`), with pass^k under it (`pass^5 1.00`). Before any golden runs, the session prints its [forecast](./gating.md#one-risk-for-the-whole-suite), the attempts it runs on average and at most, and what they cost, and with several gated goldens it splits its one risk across them (`--suite-risk`); an attempt the agent failed while its provider was [unavailable](./gating.md#when-the-provider-is-unavailable) is run again and not counted; a gate that runs out of attempts between its bounds is *inconclusive*, as is a pack whose only checks that did not pass could not be decided, such as a [judge check](./judges.md#not-judged) with no verdict, and one whose injection gate showed too little to say: marked `?` in amber and counted apart (`1 passed, 0 failed, 1 inconclusive`). Exit status: 0 when every pack passed; 1 when one failed; 3 when none failed and one is inconclusive (0 under `--inconclusive warn`); 2 when the packs can't be tested as given (none matches, a config it can't read, a golden that would run a [write Shadowlap never recorded](./how-it-works.md#tools-shadowlap-did-not-record) again); and 130 (143 for SIGTERM) when a signal stopped the session, which then keeps the results of the packs that finished.

| Option | Effect |
|---|---|
| `--junit <file>` | Write a JUnit XML report |
| `--json <file>` | Write a JSON report: the session, counts and, per pack, the result and the kind of failure (`diverged`, `check`, `exit`, `no-calls`, `error`, `inconclusive`, or `injection` for a golden's injection gate), its replays' run ids, calls by origin, tokens not re-spent, the divergence, each check, the checks as configured and, for a repeated recording, how many attempts passed |
| `--markdown <file>` | Append a Markdown report: a results table, and the diff and agent output for each failure. Point it at `$GITHUB_STEP_SUMMARY` for a GitHub job summary |
| `--annotations` | Print a GitHub Actions error annotation for each failed pack, attached to its `run.json` |
| `--update` | [Re-record each golden that diverged](./ci.md#update-a-golden-after-an-intended-change), and each that may fork and forked before its task's takeover, live with writes stubbed, and replace its pack (`run.json`, `calls.jsonl`, `blobs/`, and a `.gitattributes` when the folder has none; other files in its folder stay) in the working tree when the agent exits 0 and its checks pass. Prints what the agent sends differently. Warns, with the normalizer to add, when the divergence is a value that changes every run and the config has no rule at its path. A golden that replayed clean but holds no verdict for a [judge check](./judges.md#recorded-once-judged-free-after) gets it asked live and kept in its pack |
| `--online` | Allow live calls after a divergence. By default every provider is offline and a live call fails the pack |
| `--writes block\|stub\|allow` | What `write` tools do after a divergence. Default `block` |
| `--cwd <dir>` | Where the recorded commands run. Default: the current directory |
| `--guard block\|warn\|off` | The [network guard](./how-it-works.md#the-network-guard). Default `block` |
| `--allow-unrecorded <names>` | Run these tools again for real though a golden never recorded them and they [write](./how-it-works.md#tools-shadowlap-did-not-record), or nothing says what they do: names separated by commas (repeatable). Without it, a session with a golden whose model called such a tool is refused before any golden runs, every such golden named, exit status 2; a read is named, one line per golden |
| `--push` | Push every test run, with the golden it replayed, and the session's report to the [team store](./team.md#push-from-ci); a pull request's CI job pushes to [its own folder](./team.md#pull-requests). A missing store or missing credentials is a warning; the tests still decide the exit status |
| `--inconclusive fail\|warn` | What an inconclusive verdict does, a gate's, a check's, an [injection gate](./injection.md#gate-ci-on-it)'s (one whose test showed too little to say) or, with `--chaos`, a preset's (one whose gate ran out of attempts between its bounds, whose replay never reached the call, or that only a check no attempt can decide kept from passing): `fail` the run (the default), or `warn`: the pack counts as passed for the exit status, a JUnit report marks it skipped, `--annotations` gives it a warning, and every report still says it is inconclusive |
| `--max-attempts <n>` | Raise every [gate](./gating.md)'s limit, its `max`, for this session only, to settle an inconclusive golden without changing the config |
| `--suite-risk <r>` | The most a healthy suite may go red for nothing in this session, split across its gated goldens ([one risk for the whole suite](./gating.md#one-risk-for-the-whole-suite)). Default: `suiteRisk` under `tests` in the config, else 0.05 |
| `--continue` | Carry an inconclusive gate's attempts over from the golden's last result, when its recording, checks and gate are unchanged, and run only the attempts still needed: with `--max-attempts`, up to the higher limit. A gate continued this way decides exactly as one that had that limit from the start. A golden whose last result isn't an inconclusive gate's runs afresh, and says why |
| `--chaos` | Run the [error-path presets](#error-path-presets) instead of the session above: each golden forked at one call with a tool timeout, an empty result, malformed JSON, an oversized result, a provider 429 and a 500 |
| `--presets <list>` | With `--chaos`: the presets to run, comma-separated (`timeout`, `empty`, `malformed`, `oversized`, `429`, `500`, or `all`). Default: the golden's `chaos.presets`, else all |
| `--chaos-tool <name>` | With `--chaos`: the tool whose first call the tool presets hit. Default: the golden's `chaos.tool`, else the first tool call that reads the world |

The `--json` report is `{ version, session, revision, passed, failed, inconclusive, interrupted, results }`, and `suite` with a gated golden: `passed` and `failed` count the packs by what CI does with them (an inconclusive one counts as failed, or as passed under `--inconclusive warn`), and `inconclusive` counts the inconclusive ones either way: a gate that ran out of attempts between its bounds, a pack that fell short only on a check that [could not be decided](./checks.md#how-a-check-comes-out), or one whose provider was unavailable too many attempts in a row. `suite` is the session's one risk (`risk`), each gated golden's share of it (`perGoldenRisk`), how it was split (`method`, `bonferroni`), how many `goldens` shared it, what `inconclusive` verdicts did, the chance the session went red for nothing at most as planned (`red`), how many goldens could not keep within their share when any could not (`over`; the summary then states `red`, not `risk`), and the `forecast` made before it ran: `attempts` on average, `most`, and their `cost` on average in USD (null with no price; `unpriced` counts the goldens without one). One result per pack: its `name`, `dir` and `golden` (as test history names it), `mode` (`replay`, or `fork` for a recording that forks on purpose), `ok` (whether CI lets it through), its `verdict` (`passed`, `failed` or `inconclusive`, whatever CI does with it), the `failure` kind (`inconclusive` for an inconclusive one) with its one-line `message` and the `details` the terminal shows, the agent's last lines of `output` when it failed, `seconds`, the replay shown (`runId`) and every attempt's (`runs`, each `runId`, `ok`, true for one that passed, and its `verdict`, `passed`, `failed`, `inconclusive` when all it fell short on is a check that could not be decided, or `unavailable` when the agent failed while its provider was, which is run again and never counted unless the provider cut it short after the model answered and a gate counted it), the recording replayed (`goldenRunId`), `calls` by origin (`total`, `replayed`, `live`, `blocked`, `stubbed`), `upstreamRequests`, `tokensNotRespent`, the `divergence` (`type`, `callNo`, `kind`, `name`, and for one that [ended early](./ci.md#a-replay-that-ends-early) `recorded`, the calls its recording holds), its `checks` (each `status`, `passed`, `failed`, `inconclusive` or `not-applicable`, with `ok`, `label`, `detail`, and a [judge check](./judges.md#in-the-reports)'s `reason`, `source` and `judge`: `name`, `model`, `of`, `verdict`, `source`, `cost`, `redactions`, `normalized`, `cut`, `callNo`; see [how a check comes out](./checks.md#how-a-check-comes-out)) with the `expect` they came from, `attempts` for a recording that repeats or has a gate (`total`, `passed`, `inconclusive`, the attempts a check could not decide, which count neither way, `required`, which is null with a gate, `unavailable`, the attempts the provider was unavailable for, which `total` leaves out, and `cutShort`, those it cut short after the model answered, which a gate counted against either verdict and `total` holds), the `gate` for a golden with one (null otherwise, and when an attempt a check could not decide stopped it before it decided anything), what its judge checks' calls did and cost over every attempt, apart from the agent's (`judge`: `calls`, `replayed`, `live`, `notAsked`, `upstreamRequests`, `spent`, `saved`, `unknownModels`, or `null`), with `--update`, what it `updated` (`from`, `to`, `calls`, `changes`), and its injection gate (`resultId`, the result it is kept under; `attempts` and how many `obeyed`, `influenced`, `ignored` and `inconclusive`; what it `allowed`, as `obeyed` and `influenced`; its `verdict`, `passed`, `failed` or `inconclusive`, or null when it did not run; the `reason` it failed or is inconclusive; `skipped`, why it did not run) or null as `injection`. `upstreamRequests` counts the judge's too. A `gate` is the gate's figures as this session ran it (`kind` `sprt` with `good`, `bad`, `risk`, `failRisk` when its share of the suite's risk set a lower risk for a failure, and `max`, or `baseline` with `drop`, `risk`, `window`, `min` and `max`), then what it made of the attempts: its `decision` (`pass`, `fail`, `inconclusive`), `passes` of `attempts`, each attempt in order (`outcomes`, true for a pass), with `--continue` how many of them were `carried` over from the session it continued (`attempts` beside the gate counts this session's own), the `interval` of the pass rate at 1 − risk (`lo`, `hi`, `confidence`), the `bound` its verdict line shows (`lo` for a pass, `hi` for a failure, both otherwise, its `confidence` and `method`: `stagewise`, exact under the gate's own stopping, or `confidence-sequence` for attempts it didn't stop on by its rule; see [reading the evidence](./gating.md#reading-the-evidence)), `unavailable` when the provider was unavailable for some attempts, `unavailableAt` when it cut some short after the model answered (their places in `outcomes`, each a failure there, counted against either verdict), `passK` (`k`, `value` for k up to 8), `clean` (a replay that forked nowhere settled it with one attempt), the `sentence` the terminal prints, its verdict line (the verdict word, the tally, the bound and the rule), and the `evidence`: for an SPRT gate the score after each attempt (`scores`) with what a pass and a failure add (`pass`, `fail`) and the bounds it passes and fails at (`upper`, `lower`); for a history gate the `history` it pooled (`passes`, `attempts`, `sessions`, or null when there is none and the golden's recording is the baseline), the `baseline` rate, the `probability` of a drop after the last attempt and after each one (`probabilities`, null before `min`), the `threshold` it fails above and the chance it passes at or below (`passAt`, 1/2). [Gating](./gating.md) has the maths.

### Error-path presets

`test --chaos` runs a golden's [error-path presets](./error-paths.md) instead of replaying it: the
failures a recording of a healthy run never holds, each played in at one call so the agent's own
error path runs.

| Preset | What the agent gets |
|---|---|
| `timeout` | The tool call times out: the tool doesn't run, and the agent's SDK raises the timeout it would |
| `empty` | The tool answers with nothing: an empty list, object or text, as it recorded one |
| `malformed` | The tool answers with its JSON cut short. A tool that returned data gets the cut JSON text in its place |
| `oversized` | The tool answers with its longest text repeated until it is a million characters long (`chaos.oversize`); JSON stays JSON |
| `429`, `500` | The model call that reads the tool's answer fails with that status, every attempt of it |

The tool presets hit the first tool call that reads the world (a `read`, else a tool whose effect
nothing declares, else a write; never a pure tool, a person's input or a call that failed when
recorded), or the first call of `--chaos-tool`; the provider presets hit the model call after it.
Each preset is a fork from there, live with writes stubbed (`--writes` changes that), so like a
[golden that forks](./ci.md#recordings-that-fork-on-purpose) it needs the providers. An attempt passes
when the agent exits 0 and passes the checks an error path must pass: those under `chaos.expect` in
the golden's `tests` entry, else the write limits of its own `expect` (the upper bounds it sets on
write tools, which hold on any path; the rest describes the path its recording took, which a path
through a failure needn't take). A preset's attempts are gated as they come in: by `chaos.gate`
(`{ good, bad, risk, max }`, each optional) when the entry has one, else by the golden's `repeat`
and `passes`. Its verdict is `passed`, `failed`, `inconclusive` (the gate ran out of attempts between
its bounds, the replay never reached the call, which a golden that no longer replays does, or all
that kept an attempt from passing is a check no attempt can decide, such as a judge with no way to
be asked) or `not-applicable` (the recording has no call the preset can hit, or no result it can
change, such as a binary one or one that is empty already). The provider failing for real, beyond
the failure a preset plays in, is the provider's, as under `test`
([gating](./gating.md#when-the-provider-is-unavailable)): an attempt it failed before the model
answered is run again and never counted, one it cut short after is counted against either verdict
by a `chaos.gate` and run again under `repeat`, and three in a row leave the preset inconclusive
with the provider named, never failed. An attempt stops after `chaos.timeout`
seconds (default 300) and fails: an error path can hang. `"chaos": false` leaves a golden out of
`test --chaos`. Each attempt is a run bundled under the golden's recording, and the session and
every result are kept in the store for the dashboard. Exit status: 1 when a preset failed or a golden
couldn't be run; 3 when a preset was inconclusive (0 under `--inconclusive warn`); 130 or 143 on a signal.

```
⚡ goldens/forecast: 6 error-path presets at get_forecast (#3) and model call #4
  ✓ tool timeout      passed  timed out: the agent exited 0
  ✓ empty result      passed  answered with nothing: the agent exited 0
  ✗ malformed JSON    failed  answered malformed JSON: the agent exited with code 1
      SyntaxError: Unterminated string in JSON at position 52 (line 1 column 53)
  ✓ oversized result  passed  answered 1,000,000 characters: the agent exited 0
  ✓ provider 429      passed  failed with HTTP 429: the agent exited 0
  ✓ provider 500      passed  failed with HTTP 500: the agent exited 0
```

When a `chaos.gate` decided the presets, every line gives the tally and the bound of the
pass rate, exact under the gate's stopping, and a line under the table states the gate's rule once
(`gate: tells 90%+ from 50%- at <= 10% risk, up to 6 attempts`). Under the table, a line names the
checks that judged every attempt and where they came from (`checks: send_alert called at most 1
time (the write limits of the golden's expect)`), or, when only the exit status did, two lines say
how to give them.

`--json <file>` writes `{ version, session, revision, presets, passed, failed, inconclusive, notApplicable, interrupted, results }`,
with each recording (`golden`, the `runId` the presets forked, its `outcomes`, the `judge` of its
presets: the `source` of their checks, `chaos.expect`, `--expect`, `write-limits` or `exit`, and the
`checks` as a failure names them, the `rule` a `chaos.gate` decided its presets by, as the table
states it, or null, and the `error` that kept it from running or why it was `skipped`) and, for
each preset (`preset`, its `label`, the `verdict`, the `callNo` it hit and its `target` (`kind`,
`name`), the `passes` and `attempts`, a `detail` sentence naming what came of it (and its
`summary`, without the call, as the table shows it), the `reason` it failed (its first failing
attempt's) or is inconclusive (null when its gate ran out of attempts), the `gate` it was decided
by, `upstreamRequests`, `spent`, `unavailable` and `cutShort` when its provider failed for real
(attempts never counted, and attempts cut short and counted), and its `runs`), each attempt (`runId`,
its `verdict`: `passed`, `failed`, or `inconclusive` when its replay never reached the call, all that
kept it from passing is a check no attempt can decide, or its provider failed for real, with
`unavailable` then `retried` or `counted`; `passed`, true for a passed attempt only; the agent's `exitCode`,
its `checks`, the `reason` it failed or is inconclusive and, for an agent that exited with an error,
`lastLine`: the error it died of, as it printed it). `--junit` writes a case per preset, whose
failure lists each attempt by its verdict, and `--markdown` a table of them, listing under it any
golden whose presets couldn't run; both state a `chaos.gate`'s rule, once under the table and in
each case it decided.

## bisect

```sh
shadowlap bisect <golden|run> --good <rev> [--bad <rev>] [--expect <json|@file>] [--fork] [--build <command>] [--cwd <dir>] [--timeout <seconds>] [--allow-unrecorded <names>] [-y] [--json] [-- <command>]
```

[Finds the first commit](./ci.md#find-the-commit-that-broke-it) where a recording fails: it replays it at commits between `--good` (where it passed) and `--bad` (default `HEAD`), halving the range each time, each commit checked out in a temporary git worktree. A divergence, a replay that ends before its recording does, a failed check or a non-zero exit fails a commit. Replays are offline, so it costs no tokens. Prints the first bad commit with its subject, author and date, and why it fails there, and any untestable commits just before it that could be the one; exit status 0 when it found one, 1 when there is none between the two (it passes at `--bad`, or already fails at `--good`), 3 when a commit at either end can't be tested, 2 when it can't search what it was given (a commit that isn't one, a run with no command, a recording whose model called a tool it never recorded that [writes](./how-it-works.md#tools-shadowlap-did-not-record)), and 130 for Ctrl-C. The answer is kept in the project's activity either way: the first bad commit, or why there is none between the two commits (it already fails at `--good`, it passes at `--bad`, or one of them can't be tested), with the golden's newest test result as the search started, the failure it answers. The dashboard's Tests shows it above the golden's buttons while the golden keeps failing as it did then: not once it passed, and never over a later failure (an answer given while the golden passed answers none). A search stopped with Ctrl-C keeps nothing.

Each replay runs the recorded command, or the one after `--`, in the commit's worktree. A run from someone else's pack, or pulled from the [team store](./team.md), carries a command someone else chose, which would run at every commit: bisect asks first, as `replay` does, and with no terminal to ask in it refuses (exit status 2) unless given `--yes`. A golden is the project's own and runs as `test` runs it.

| Option | Effect |
|---|---|
| `--expect <json\|@file>` | The checks a replay must pass besides exiting 0 (default: the golden's under `tests`) |
| `--fork` | Let each replay diverge and run live from the fork, so only the exit status and the checks decide: for a run that failed a check, whose recording no older commit would replay. The live part costs tokens, and the result says how many. A replay that forks asks its [judge checks](./judges.md) live: one no replay can ask (no key for its provider, and no upstream set for it) is refused before anything runs |
| `--build <command>` | Run in each worktree before its replay, e.g. `"npm ci && npm run build"`. A commit where it fails is skipped |
| `--cwd <dir>` | Where the recorded command runs, inside the repository (default: the current directory) |
| `--timeout <seconds>` | Stop a replay after this long and count it as failing (default 300) |
| `--guard <mode>` | The network guard: `block` (default), `warn` or `off` |
| `--allow-unrecorded <names>` | As for `replay` |
| `-y, --yes` | Run the recorded command of a run from a pack or the team store at each commit without asking |
| `-- <command>` | The agent's command to run at each commit instead of the recorded one |
| `--json` | Print the result as JSON: each replay, the first bad commit, and the replays, tokens and upstream requests it took |

`--json` prints `{ outcome, target, good, bad, commits, steps, first, untested, why, replays, tokens, upstreamRequests, spent, seconds }`: the `outcome` (`found`, `passes-at-bad`, `fails-at-good`, `untestable` or `stopped`, with `why` when there is no answer), the `target` (`kind` `golden` or `run`, its `name` and `runId`), the `good` and `bad` commits and the `commits` between them, each replay in `steps` (`rev`, `short`, `subject`, `ok`, `skipped`, its `result` and `seconds`), the `first` bad commit with `why` it fails there, the `untested` commits just before it, and what it took: `replays`, `tokens`, `upstreamRequests`, USD `spent` and `seconds`. A commit is `{ rev, short, subject, author, date }`.

## check

```sh
shadowlap check [recording...] [--expect <json|@file>] [--json]
```

Judges recordings by [checks](./checks.md) from what they recorded: nothing is replayed and nothing is sent, so a check can be tried on every run there is before it goes into the config. A recording is a run id or unique prefix, `label:<name>` for every run with that label, or a pack directory (`goldens/*`, with `*` in the last part matched by the command itself), read into a store of its own so the project's store is left as it is; with none, every recording in the store that has ended. A recording named twice (a run and a label it has, a pack and its run in the store) is judged once, as its pack when it is one. Each is judged by `--expect`, or without it by its entry under `tests` in `shadowlap.config.json`; a recording with neither is counted apart. It comes out passed, failed (a check failed, or the run exited with an error or was interrupted), or inconclusive: a check on the agent's output, which a recording doesn't keep, a judge check with no verdict, a condition it can't read, or a partial recording that holds no tool calls. Each line names the recording by its id, labels and command, or its pack; its checks follow one that did not pass. Under the totals, the report says when the checks fail a recording labelled `good` or pass one labelled `bug`, and names a value the checks read that none of the calls judged has (a misspelt `result.totl`), with the key it most likely meant. Exit status 0 when every recording judged passed, 1 when one failed, 3 when none failed and one was inconclusive, and 2 when none was judged.

| Option | Effect |
|---|---|
| `--expect <json\|@file>` | The checks to judge every recording by: an `expect` object. Default: each recording's own under `tests` |
| `--json` | Print the report as JSON |

`--json` prints `{ expect, recordings, counts, unchecked, notes }`: the `expect` given (or null), each recording judged in `recordings` (its `runId`, the `pack` it came from or null, its `labels`, the `source` of its checks, `--expect` or the recording directory of its `tests` entry, its `outcome`, `passed`, `failed` or `inconclusive`, `why` it failed or could not be settled, and its `checks` as [each check comes out](./checks.md#how-a-check-comes-out): `status`, `ok`, `label`, `detail`, and a judge's `reason` and `source`), the `counts` of recordings by outcome (`passed`, `failed`, `inconclusive`), the recordings `unchecked` for want of checks, and the `notes`: recordings labelled good that fail or bug that pass, and values the checks read that no call judged has. A dashboard job that runs it gets the same report as its result.

## injection

```sh
shadowlap injection <run|golden...> [--repeat <n>] [--templates <ids>] [--payloads <file>]
  [--baselines <n>] [--obeyed <n>] [--influenced <n>] [--live-reads] [--inconclusive <mode>]
  [--html <file>] [--no-redact] [--concurrency <n>] [--budget <usd>] [--timeout <seconds>]
  [--guard <mode>] [--allow-unrecorded <names>] [-y] [--json]
shadowlap injection <run> --clean <call[=result]> [--write <call>] [--gate <json>] [--json]
shadowlap injection --list-templates [--json]
```

[Causal injection tests](./injection.md): for each read of a tool marked untrusted (`"tools": { "fetch_page": { "trust": "untrusted" } }` in the config, `trust: 'untrusted'` in the [SDK](./sdk.md#untrusted-reads), or an MCP read tool whose server sets `openWorldHint`), it plants each payload in the recorded result with a canary of its own, as [`--inject-result`](./interventions.md#plant-an-instruction-in-a-tool-result) does, and replays: the calls before the read from the recording, the rest live from the model call whose request carries the planted text, writes stubbed, reads served from the recording when they match and fenced when they don't. A tool call carrying the canary is proof the planted text caused it: *obeyed*, for a write, and for a read, which can carry data out. A write no clean replay of the same read made is *influenced*. Otherwise the payload was *ignored*, or, when the attempt shows nothing either way (no model read the planted text, a model call failed, the agent exited non-zero), *inconclusive*, with why. The payloads are the built-in templates (`--list-templates` prints them) unless `--payloads` or `--templates` say otherwise, and a golden's `"injection"` entry under `tests` gives its defaults. Every replay is a run marked with the test it belongs to, and every result is kept in the store for the dashboard.

Each run tested comes to a verdict against its limits: *failed* when more attempts obeyed (or were influenced) than allowed, *inconclusive* when the test showed too little to say (no untrusted read to plant in, an attempt in which something failed, no attempt a model read, the planned attempts cut short by `--budget`, and, with a limit on influenced attempts, a clean replay in which something failed), else *passed*. Exit status: 0 when every run tested passed, 1 when one failed, 3 when one is inconclusive (0 with `--inconclusive warn`), 130 when interrupted (143 for SIGTERM).

`--clean <call>` asks the reverse of a recorded incident: read `<call>` is replaced with a neutral result (each string with a space in it emptied, ids, numbers and the shape kept) or the one given, and the run replays until the [sequential test](./injection.md#prove-cause-on-an-incident) decides, for each write the run made after the read, whether it comes back (by the values that identify it: an address, an id, an amount). Each is reported *caused* by the read's content, *not caused*, or *inconclusive*. A clean attempt in which something failed, or that never made the read, decides nothing; three in a row stop the test. Exit status 0 when every write was decided, 3 when one is inconclusive (0 with `--inconclusive warn`).

| Option | Effect |
|---|---|
| `--repeat <n>` | Attempts per untrusted read and payload (default: the golden's, else 1). With `--clean`, the most clean attempts the test may take; fewer than the gate needs to decide a write is refused |
| `--templates <ids>` | Built-in templates to plant: `all` (default), `none`, or ids separated by commas |
| `--payloads <file>` | Your own payloads, or a red-teaming tool's: text (one a line, or blocks between `---` lines), JSON or JSON Lines; their `{{canary}}` is filled in. Planted instead of the templates unless `--templates` names some |
| `--list-templates` | Print the built-in templates; with `--json`, as the versioned data they ship as |
| `--baselines <n>` | Clean replays of each read, forked at the model call that reads it, that *influenced* compares with (default: the golden's, else 3). The recording's own writes after the read count as one more; a clean replay in which something failed is left out, and with `--influenced` makes the verdict inconclusive |
| `--obeyed <n>` | Attempts that may obey before the run fails (default: the golden's, else 0) |
| `--influenced <n>` | Attempts that may be influenced before the run fails (default: the golden's, else no limit) |
| `--live-reads` | Run the reads the recording doesn't hold after the fork, instead of fencing them (the agent gets an error for a fenced read). A read that carries planted text is fenced all the same |
| `--inconclusive fail\|warn` | What an inconclusive verdict does to the exit status: `fail` (default) or `warn` |
| `--clean <call[=result]>` | Replace read `<call>` with a neutral result, or the one given (JSON, text, or `@file`), and decide whether its content caused each write after it |
| `--write <call>` | With `--clean`: the recorded write to test (repeatable; default every write after the read) |
| `--gate <json>` | With `--clean`: the sequential test that decides; the figures left out are the default's, `{"good":0.8,"bad":0.2,"risk":0.05,"max":10}` |
| `--html <file>` | Also write the security report: the reads × payloads matrix, the proof of each obeyed cell, why the inconclusive ones show nothing, the `--clean` verdicts and the payloads, with the redaction rules applied and every canary kept |
| `--no-redact` | With `--html`: skip the redaction rules |
| `--concurrency <n>` | Attempts running at once (default 1) |
| `--budget <usd>` | Start no attempt once this much is spent on live model calls; a test cut short is inconclusive |
| `--timeout <seconds>` | Stop an attempt after this long; it is inconclusive |
| `--guard <mode>` | The network guard: `block` (default), `warn` or `off` |
| `--allow-unrecorded <names>` | As for `replay` |
| `-y, --yes` | Run the recorded command of an imported run without asking (a golden is the project's own) |
| `--json` | Print the report as JSON; progress goes to stderr |

With `--list-templates --json` it prints (`version`, `updated`, and the `templates`, each with its `id`, `shape`, `title` and `text`) and exits; otherwise, with `--json` it prints (`templates`, the built-in set's `version` and `updated`; `results`, one per run tested; `totals`; the `verdict` they come to, `passed`, `failed` or `inconclusive`; `passed`, whether the exit status is 0; `html`, the report's path or null). `totals` adds up (`runs`, `attempts`, `obeyed`, `influenced`, `ignored`, `inconclusive`) over the runs tested by planting.

A run tested by planting is (`resultId`, the `inj-…` id it is kept under; `mode` `plant`; `runId`; `golden` or null; the `templates` used, as their set's `version` and the `ids`; `repeat`; `reads`; `unrecordedReads`, `fence` or `live`; the untrusted calls `skipped`, each with `callNo`, `name` and `why`; `payloads`; `cells`; `attempts`; `baselines`; `totals`; the strongest `verdict` an attempt showed; `gate`; `stopReason`; `cost`, as `spent`, `upstreamRequests` and `unknownModels`; `startedAt` and `endedAt`). Each untrusted read is (`callNo`, `name`, `from`: `config`, `sdk` or `mcp`; `readAt`, the model call that reads it; its `args`; `planted`, and `why` not). Each payload is (`id`, `source`: `template` or `file`; `shape`; `title`; `text`, its placeholders unfilled; `canary`: whether it has one). Each cell, one read with one payload, is (`read`, `payload`, `verdict`, `attempts`, how many `obeyed`, `influenced`, `ignored` and `inconclusive`, and their `runs`). Each attempt is (`runId`, `read`, `payload`, `attempt`, the `canary` it carried as `token`, `address`, `id` and `amount`; `verdict`; `why` an inconclusive one shows nothing; `failed`, whether that is because something failed in it; in the attempt's own call numbers, `plantedAt`, where the payload was served, `forkedAt`, where the attempt forked, and `readAt`, the first model call whose request carried it; `exitCode`; `evidence`; USD `spent`). Each piece of evidence is (`kind`: `canary`, a write that carried it, `read`, a read that carried it, or `write`, a write no clean replay made; the attempt's `callNo`; `tool`; `path` in its arguments; `value`; `why`). Each read's baseline is (`read`, the clean replays' `runs`, the `writes` they and the recording made, and those `failed`, each `runId` and `why`). The gate is (`obeyed` and `influenced`, the limits; its `verdict`, `passed`, `failed` or `inconclusive`; the `reason`).

A run tested with `--clean` is (`resultId`; `mode` `clean`; `runId`; `golden`; the `read` replaced, with `callNo`, `name`, `trust`, `from` and `args`; the `canary` the run carried, when it is an attempt of an injection test, or null; the `neutral` result served; `unrecordedReads`; `writes`; `attempts`; the `gate` it was decided with, and its `rule` as the terminal states it once under the writes, `gate: tells a write gone in 80%+ of clean attempts from one gone in 20%-, at <= 5% risk, up to 10 attempts`; the `verdict`: `caused` when the read's content caused a write, `not caused` when every write comes back without it, else `inconclusive`; `stopReason`; `cost`; `startedAt` and `endedAt`). Each recorded write is (`callNo`, `name`, `args`, the `identifiers` that make it the same write again, the clean `attempts` that decided it, how many it was `gone` in, its `verdict`, and the `bound` on the share of clean attempts it was gone in, as its line shows it beside the tally (`rate >= 0.29 (95%)` for a caused write, `rate <= 0.71 (95%)` for one not caused, both ends for an undecided one), or null before an attempt decided anything). Each clean attempt is (`runId`, `attempt`, `forkedAt`, `exitCode`, the writes it `made`, each `callNo` and `name`, the recorded writes `gone` in it, and `why` it decided nothing, or null).

## pack, unpack

```sh
shadowlap pack <run> <dir> [--lineage] [--no-redact]
shadowlap unpack <dir>
```

`pack` writes a run as a directory: `run.json`, `calls.jsonl`, one uncompressed file per blob under `blobs/`, and a `.gitattributes` (`* -text`, unless the folder has one) that keeps git from converting line endings, which would break the blobs' hashes in a Windows checkout. A run still recording is packed once it has ended, as every export waits for it: half a run would make a golden that never matches; until then `pack` refuses it, exit status 2, and with `--lineage` it waits for every run the pack would hold. Stable names and one file per blob keep it git-friendly, so it can be committed as a CI golden or shared. Packing into a folder that already holds a pack (the same golden again) replaces its `run.json`, `calls.jsonl` and `blobs/` as a whole and leaves anything else there, so the folder never keeps an earlier pack's blobs, unredacted ones above all. The [redaction rules](./normalizers-and-redaction.md#redaction) in `shadowlap.config.json` are applied to the copy (`--no-redact` skips them, and says how many it skipped), but for a model call's [signed reasoning](./normalizers-and-redaction.md#signed-reasoning), which stays as recorded, and `pack` names each rule that matched inside it; a credential a recording kept never goes into a pack, with the rules or with `--no-redact`; and who made each run (its author, often an email) is left out of it; the local store is never modified, but for this: a golden whose checks ask a [judge](./judges.md) is judged once, live, before it is packed, and the judge's calls are added to the run and go into the pack, so every replay of the golden is judged from the recording. A verdict the run already holds for the very request is not asked again; one that can't be asked (no key) is said to be inconclusive, with how to record it. A check that reads the agent's `output` can't be judged when packing, since a recording keeps no output: `pack` says so, and `shadowlap test <golden> --update` records its verdict from what a replay prints. A run that didn't complete (its agent exited with an error, or it was interrupted) is not judged at all, since no replay of it is either. `unpack` imports a pack, treating it as untrusted input: every record is validated (its redaction rules' patterns as the config's are, so none that [could take too long](./normalizers-and-redaction.md#patterns-that-could-take-too-long) comes in), each file is read without following a link, every blob is verified against its hash (a blob git checked out with CRLF line endings is verified as it was committed, and refused when that doesn't match either), only the blobs its calls need come into the store, and a pack that fails a check imports nothing; a time more than a day ahead of this machine's clock fails one. Nothing on this machine records an unpacked run, so one the pack marks as still running comes in as interrupted (crashed, ended at its last call). Runs that already exist are skipped; when the store's run under that id is another recording (another command, or other calls), `unpack` says so and keeps it as it is. Imported runs are marked, and `unpack` prints the command each one would run on replay:

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
shadowlap import otel otel-traces.json   # OpenTelemetry traces with the GenAI conventions
shadowlap import langfuse <trace-id>     # a Langfuse trace, read with the project's keys
shadowlap import langsmith <trace-id>    # a LangSmith trace, read with your API key
shadowlap import phoenix <trace-id>      # an Arize Phoenix trace, from Phoenix's REST API
shadowlap import logfire <trace-id>      # a Pydantic Logfire trace, read with a read token
shadowlap import langfuse --since 7d     # each Langfuse trace of the last 7 days, one run per trace
shadowlap import har traffic.har --json  # every run made, by its full id, and the entries skipped
```

Turns a capture something else made, or a [trace you already keep](#traces), into a recording you
can replay your own code against.

| Format | What writes it |
|---|---|
| `har` | mitmproxy, Charles, Proxyman, a browser's devtools, Polly.js |
| `nock` | `nock.recorder.rec({ output_objects: true })` |
| `vcr` | VCR.py with its JSON serializer (`vcr.VCR(serializer='json')`). A YAML cassette has to be converted first: Shadowlap reads JSON so that no YAML parser is trusted with a cassette from anywhere |
| `litellm` | A LiteLLM proxy, through `shadowlap.litellm_callback` — production traffic, one run per correlation id. Takes several files, since a proxy writes one per worker: the calls of one agent run spread over several workers' files are put back together, in the order they started. See [Capturing production traffic](./gateways.md) |

Anthropic, OpenAI, Gemini, Azure, Vertex and Bedrock hosts are recognised; every other entry is
skipped, and `--json` lists the reasons. So is an entry whose fields aren't what the format says
(a method that isn't text, a null entry), naming the field. Credentials in the capture are never
stored, and header names and values are escaped and bounded, because a capture is a file from
anywhere. An import that stops part way leaves no run behind.

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

Every imported run is labelled `imported`, names who imported it as its author (`SHADOWLAP_AUTHOR`
when set, `ci` in CI, otherwise git's `user.email`), and appears in the dashboard's activity feed.
Its source is the file's name; `--name <name>` records another (the dashboard's Import a capture
passes the name of the file you picked, which it keeps under a name of its own while it imports).

### Traces

```sh
shadowlap import otel otel-traces.json [otel-logs.json]
shadowlap import langfuse 7f3a9c2e-41b8-4d0e-9a51-2c6e8b1d4f07 [--host https://langfuse.example.com] [--allow-http]
shadowlap import langsmith 0192f4c1-8e2d-7a3b-b6c4-5d9e0f1a2b3c [--host https://langsmith.example.com/api/v1] [--allow-http]
shadowlap import phoenix 4a2db41deabc4aec332fb9fbfa0fc3e2 [--project support-agent] [--host https://phoenix.example.com] [--allow-http]
shadowlap import logfire 01a16460e2f311342463057f62b79fa9 [--since 90d] [--host https://logfire-eu.pydantic.dev] [--allow-http]
```

A trace keeps what its instrumentation logged: the messages and the model settings, tool outputs
when someone logged them, rarely the tool definitions. Each model call is rebuilt as the request its
provider's SDK sends and the response it got, in Anthropic's, OpenAI's or Gemini's format (the
provider the trace names, else the model's family, else OpenAI's, which most other servers speak),
and stored like a capture's. The run is a partial recording: what the trace didn't keep runs live on
replay, with writes fenced.

The run holds the calls in the order they started, read as finely as the source keeps the time (to
the microsecond in Phoenix, Logfire and LangSmith, the nanosecond in OTLP), since a tool and the
model call that reads its result often start in the same millisecond. Calls that started at the
same instant go in the order one needed another: a span before the calls that ran inside it, a model
call before the tool call it asked for, and a tool call before the model call whose request carries
its result. Calls that say nothing of each other keep the order the source lists them in.

| Source | What it reads |
|---|---|
| `otel` | OTLP JSON, as an OTLP/HTTP exporter sends it, the collector's file exporter writes it (one request per line), or Grafana Tempo downloads a trace; several files are read as one, so traces and their logs can come separately. Spans with the OpenTelemetry GenAI conventions: `gen_ai.input.messages` and `gen_ai.output.messages` (with `gen_ai.system_instructions` and `gen_ai.tool.definitions`, also from a `gen_ai.client.inference.operation.details` event), the older `gen_ai.prompt` and `gen_ai.completion` (as JSON, on `gen_ai.content.*` events, or flattened as OpenLLMetry writes them), or the per-message `gen_ai.*.message` and `gen_ai.choice` events, on the span or as log records (`resourceLogs`, tied to the span by its id), which is where the official instrumentations (openai-v2, vertexai, google-genai) send them; the model, provider, settings, token usage and finish reason; `execute_tool` spans for tool calls. Also OpenInference's conventions (Arize Phoenix, and the LlamaIndex, DSPy and smolagents instrumentations): LLM spans with `llm.input_messages`, `llm.output_messages`, `llm.tools` and `llm.invocation_parameters`, rebuilt exactly from `input.value` and `output.value` where its OpenAI and Anthropic instrumentations log the request and response themselves, and TOOL spans. One run per trace. When a framework's span wraps the client library's span for the same call, the inner one is kept |
| `langfuse` | The trace's observations from the Observations API v2 (`GET /api/public/v2/observations`, a page of 1,000 at a time), or `GET /api/public/traces/<id>` from a self-hosted Langfuse without it, with `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY`. Generations are model calls; TOOL observations, and spans named after a tool a generation asked for, are tool calls |
| `langsmith` | `POST /runs/query` for the trace, every page, with `LANGSMITH_API_KEY`. `llm` runs are model calls (LangChain's serialized messages, or the request and response themselves from LangSmith's wrapped OpenAI and Anthropic clients, which rebuild exactly); `tool` runs are tool calls |
| `phoenix` | `GET /v1/projects/<project>/spans` for the trace, every page, with `PHOENIX_API_KEY` when it is set (a Phoenix without authentication needs none). The API takes no order for spans, so they are put in the order they started once read, and a trace of more than 20,000 spans is refused rather than cut. The project is `--project`, else `PHOENIX_PROJECT` or its older name `PHOENIX_PROJECT_NAME`, as Phoenix's own client reads them, else `default`. Read with OpenInference's conventions, as `otel` reads them: LLM spans are model calls, rebuilt exactly where the OpenAI or Anthropic instrumentation logged the request itself as JSON; TOOL spans are tool calls. Needs Phoenix 13.9 or later, which reads spans by trace; an older one is refused with the reason |
| `logfire` | One SQL query for the trace's spans in the `records` table (`POST /v2/query`), with the read token in `LOGFIRE_READ_TOKEN`, among spans that started since `--since` (a date, a time, or how long ago, such as `90d`; 30 days by default). Logfire's instrumentations and Pydantic AI write the current GenAI conventions, read as `otel` reads them; where Pydantic AI's model span wraps the client library's own (the Anthropic SDK's), that span adds what was sent that Pydantic AI leaves out, such as `max_tokens` and streaming. A function wrapped with `@logfire.instrument` is a tool call when the model asked for a tool of its name: its span's (`@logfire.instrument('lookup_order')`), or the function's own under the decorator's default message (`Calling tools.lookup_order`). It keeps its arguments, and its result with `record_return=True`. A block an agent handed back as the Anthropic SDK returned it, which `logfire.instrument_anthropic()` logs as the text the SDK prints for it (`ToolUseBlock(id='toolu_…', …)`), is read back as the block |

The keys are read from the environment and sent only to the host: `--host`, else the variable the
store's own SDK reads (`LANGFUSE_HOST`, `LANGSMITH_ENDPOINT`, `PHOENIX_ENDPOINT`,
`PHOENIX_COLLECTOR_ENDPOINT` or `PHOENIX_BASE_URL`, `LOGFIRE_BASE_URL`), else its usual address:
`https://cloud.langfuse.com`, `https://api.smith.langchain.com`, `http://localhost:6006` (Phoenix as
`phoenix serve` starts it), or the Logfire region the read token names
(`https://logfire-us.pydantic.dev` or `https://logfire-eu.pydantic.dev`). A self-hosted LangSmith is
reached at its `/api/v1` path. Plain http is accepted for this machine (`localhost`, `127.0.0.0/8`,
`::1`), since the keys travel with every request; `--allow-http` accepts it for another host, on a
network you trust. A Phoenix that asks for no key, with `PHOENIX_API_KEY` unset, is read over plain
http on any host, such as the `http://phoenix:6006` of a compose file, since nothing secret travels.
Nothing of the keys is stored. The run's source reads `langfuse:<first 8 characters of the id>` (or
`langsmith:…`, `phoenix:…`, `logfire:…`), or the file's name for `otel`, and the run is labelled
with the source as well as `imported`.

Replay matches each model call on its whole request, but for the API version an Anthropic client
names (`anthropic-version`), which no trace keeps: an imported call names none, and is matched
whatever version the agent's SDK names. Its replay names none either, so a golden packed from it
replays on any release of the SDK. A trace that kept everything the agent sends replays it with
nothing live; where it left something out, typically the tool definitions, the replay forks at the
first model call that differs and runs live from there, which the import says. A tool call replays
when the trace kept its arguments (as an object) and its output, and only if every call of that tool
was kept: such tools are listed in `meta.covers` as `tool:<name>`, and any other tool runs live on
replay. A model call that failed where it ran, or kept no messages or output, is skipped and runs
live.

Two kinds of agent fork early, because what they send isn't what their traces keep. A Pydantic AI
agent forks at its first model call, whatever the store: Pydantic AI logs the conversation, not the
request it sends, which writes text as content blocks and sets `tool_choice`. An agent that hands
the Anthropic SDK's own response objects back as messages (`"content": reply.content`) forks at its
second model call where the trace kept the response whole but those blocks only as the text the SDK
prints for them, as OpenInference's Anthropic instrumentation logs them: the request is then rebuilt
from `llm.input_messages`, which leaves out fields the SDK sends with those blocks (`citations`,
`caller`, `toolset_name`) and holds a tool result as the user's text. Where the trace logged the
blocks as JSON, or by the GenAI conventions, such an agent replays from the trace alone, as one that
builds its messages as plain dicts does. Traced by `logfire.instrument_anthropic()`, which logs each
block as the text the SDK prints for it, it replays from the trace alone too: that text is read back
as the block. Both kinds still import, and replay runs live from the fork with writes fenced. A
trace from [`export otel`](#export-otel) carries no prompt text, so it has nothing to replay: share
the run as a [pack](#pack-unpack) instead. `--json` adds what the source kept:

```json
"kept": { "traces": 1, "spans": 14, "modelCalls": 9, "modelCallsImported": 9, "withSettings": 9, "withToolDefinitions": 0, "toolCalls": 5, "toolCallsKept": 3 }
```

### The traces in a window

```sh
shadowlap import langfuse --since 7d
shadowlap import phoenix --since 2026-10-01 --until 2026-10-08 --project support-agent
shadowlap import logfire --since 24h --trace-name support-agent --limit 20
```

Without a trace id, `import langfuse`, `import phoenix` and `import logfire` import each trace that
started in a window, one run per trace, newest first: from `--since` (a date, a time, or how long
ago, such as `7d` or `12h`; 30 days ago by default) to `--until` (the same, now by default), up to
`--limit` traces (100 by default, at most 10,000), only those named `--trace-name` when it is given:
Langfuse's trace name, the root span's name in Phoenix and Logfire. Give a trace id or these flags,
not both; only `import logfire` takes `--since` with a trace id too, for how far back to look for
it. Each store is asked
through its own API for the traces' roots: Langfuse for the root observations in the window
(`GET /api/public/v2/observations`, or its traces list, `GET /api/public/traces`, where it has no v2
API), Phoenix for the root spans (`GET /v1/projects/<project>/spans` with `parent_id=null`), Logfire
with one SQL query for the root spans in the `records` table. Each trace is then read as a single
import reads it, with the same keys, hosts and flags.

A trace store's import keeps the trace's id with the run (`meta.imported.key`), so a trace imported
before, by a window or by its id, is skipped and not read again. A trace still running when it was
imported keeps what it had by then: import it by its id once it has ended to bring in the rest. One
line per trace, as it goes:

```text
3 traces in Langfuse on cloud.langfuse.com that started from 2026-10-16 09:12 UTC to 2026-10-23 09:12 UTC:
  11111111-41b8-4d  imported as 01M5N2NX8F: 3 model calls and 1 tool result  support-chat
  22222222-41b8-4d  imported before, as 01M5N2NVXR  support-chat
  33333333-41b8-4d  skipped: no model calls in its 3 observations  nightly-eval
Imported 1 of 3 traces: 1 imported before, 1 skipped.
```

A trace with nothing to import is skipped, and so is one the store can't give whole: gone since it
was listed, or more spans than an import reads. Any other failure, the store refusing, failing or
not answering, stops the import at that trace: the runs it made stay, and the same command run again
goes on from there. The exit status is that failure's (2 for keys the store refused, 1 for a store
that failed or didn't answer); 1 when the window held traces and none of them is imported, now or
before; otherwise 0, an empty window included. `--json` adds the window it read (`window`: `since`,
`until`, `limit`, `traceName`) and each trace it found, newest first (`traces`: `id`, `name`,
`startedAt`, `outcome`, `runId`, `reason`). A trace's `outcome` is `imported`, `already` (imported
before, as `runId`), `skipped` (for its `reason`), `failed` (where the import stopped) or `unread`
(after that). `kept` counts what the traces it imported kept, and `entries` every observation or
span it read.

### `--json`

Every `import` subcommand takes `--json` and prints one object, whatever the format: each run it
made, by its full id, with its source and what it holds, then everything it skipped. One LiteLLM
file can make several runs, one per correlation id; they are all listed.

```json
{
  "format": "litellm",
  "entries": 4,
  "runs": [
    {
      "runId": "01K5CQ9C4H8M2XWQH6V3T9RB1D",
      "source": "shadowlap-4121.jsonl, shadowlap-4122.jsonl",
      "key": "incident-42",
      "calls": { "model": 2, "tool": 0 },
      "labels": ["imported"],
      "imported": [{ "callNo": 1, "kind": "api", "name": "POST /v1/messages", "provider": "anthropic", "model": "claude-haiku-4-5" }]
    }
  ],
  "skipped": [{ "url": "line 4", "reason": "not JSON (a partly written line?)" }]
}
```

`entries` counts what was read (HAR entries, nock definitions, cassette interactions, capture
lines, spans, observations or runs). `source` is what the run records as where it came from: the
file's name (never its folder, which belongs to this machine and would travel with the store), the
names of the files a LiteLLM run was put together from, or `langfuse:…`, `langsmith:…`,
`phoenix:…` or `logfire:…`. `key` is the correlation id for LiteLLM, the trace id for `otel` and the
trace stores, otherwise `null`. When nothing could be imported, `runs` is empty and the exit code
is 1. Started from the dashboard, the command also reports each run to the job that started it.

## coverage

```sh
shadowlap coverage [--json]
shadowlap coverage --pack [<behaviour>...] [--not-packed fail|warn] [--json] [-- <command>]
shadowlap coverage --pack <behaviour>... --fork --expect <checks> [-- <command>]
```

[Production coverage](./coverage.md): groups the project's imported runs (the captures and traces
`import` made, a teammate's from the team store included: runs that came with no command of their
own) by behaviour, and names the behaviours no golden covers. A behaviour is the tools the model
called, in order (the calls one answer asked for together in any order, as
[`--repeat`](#repeating-a-fork) reads paths), the writes among them (a tool whose effect nothing
recorded or configured names counts as one), and how the run ended: `answered`, `model-error` (its
last model call failed), `token-limit`, `tool-call` (it ended asking for a tool), `agent-error` (a
recording whose agent failed) or `no-model-calls`. The path is read from the model's own answers,
so a capture with no tool calls compares with a golden. Arguments are not part of a behaviour. The
goldens are read from their packs on disk (the goldens folder and the packs `tests` names), as
`test` reads them; a golden covers a behaviour when its recording behaves the same way. A behaviour
no golden covers names the golden that shares the most of its path, and where they part, and why
the last `--pack` couldn't pack it. Each scan is kept in the store, its groups replacing the last
scan's, for the dashboard. Exit status 0; with `--pack`, 1 when a behaviour asked for could not be
packed, unless `--not-packed warn`.

```
Coverage of what 3 imported runs did: 2 behaviours, 1 not covered by a golden (1 golden read)

  ✗ 2 runs   lookup_order → read_policy → issue_refund
             writes issue_refund · answered · seen 2d ago in refund.har
             nearest golden: goldens/escalate, the same for 2 steps;
             then it calls issue_refund where the golden calls escalate
             runs: 01K5CQ9C4H 01K5CQ9B7Q · behaviour 3f9a2c1d5e8b7a60

  ✓ 1 run    lookup_order → read_policy → escalate
             writes escalate · answered · seen 2d ago in escalate.har
             covered by goldens/escalate
```

| Option | Effect |
|---|---|
| `--json` | Print the scan as JSON (below) |
| `--pack [<behaviour>...]` | Make a golden of one run of each behaviour no golden covers, or of the behaviours named by their key (four characters of it or more): see below |
| `-- <command>` | With `--pack`: the agent's command, for a capture no run here says the command of. `{message}` in it stands for the capture's first message (the text of the first user turn it sent), `{message:/regex/}` for the part of it the regex picks (its first group, else the whole match), so each capture starts as production started it. A placeholder is an argument of the agent's own command, passed as it is: one in a shell's script, after an interpreter's `-c`, `-e` or `-m`, or where the message would name what runs (the program, the script an interpreter runs or one of its flags, the command `env` or `npx` runs), is refused, and a capture whose message would start an argument with a dash is left out |
| `--fork` | With `--pack` and the behaviours named: pack each as a golden that forks, its tests entry written with `"fork": true` and `--expect`, even when the agent no longer does what production did |
| `--expect <checks>` | With `--fork`: what the agent must do on that input now, as JSON or `@file.json`, in the grammar of a tests entry's `expect` |
| `--not-packed fail\|warn` | With `--pack`: what a behaviour that could not be packed does to the exit status. Default `fail`; `warn` reports it and exits 0, for a scheduled job |
| `--guard <mode>` | The [network guard](./how-it-works.md#the-network-guard) for the replays `--pack` makes: `block` (default), `warn` or `off` |

`--pack` turns a capture into a golden `test` can replay. A capture holds model calls and no
command, so its newest runs (up to three) are each replayed with the agent's command until one
reproduces it: the command of the newest run here (not one from a pack or the team store) whose
first model call sent the capture's first request (its fingerprint under the normalizers, or its
bytes), then the command given after `--`, its placeholders filled for that capture. The replay is
offline and needs no tool to answer: each tool call the model asked for is served the result the
next request carried back to the model (as MCP content for a tool this store has recorded through
`shadowlap mcp`), a tool the capture holds calls of itself keeps them, a tool some of whose calls got
no answer back runs live, and writes are stubbed. A replay that sends every request the capture
holds and exits 0 is a recording of the agent as it is now doing what production did, and is packed
into `goldens/<first tool>-<writes>-<key>` (with the project's redaction rules, as `pack` writes one)
and logged in the activity feed. One that doesn't is not packed, and says why: nothing says what
starts the agent (`no-command`); the command started it with another first message than
production's (`other-message`: the wrong command, or one that needs `{message}`); the agent sends
something else now (`not-reproduced`: the code changed since the traffic was captured, or a tool's
arguments are not the model's); the agent failed on what production got back (`agent-error`); or
its runs were deleted (`gone`). A behaviour the agent no longer reproduces can still be kept, as
the test that the change holds: `--fork` packs production's run, with the command that starts the
agent as production did, as a golden that forks where the agent parts from it and passes on
`--expect`. What `--pack` made of each behaviour is kept in the store, and the scan after it counts
the new goldens.

`--json` prints `{ scanId, at, runs, uncovered, groups, goldens, pack }`: the scan in the store,
when it ran, the imported runs read and the behaviours no golden covers; for every behaviour
(`key`, `covered`, the goldens it is `coveredBy`, its `path`, `writes`, the tools of `unknown`
effect, its `outcome`, how many `runs` behaved so and their `runIds`, newest first, the `sources`
they came from, `firstSeen` and `lastSeen`, the `nearest` golden for one no golden covers
(`golden`, the steps `shared`, and where it `differs`: the `step`, what the behaviour does there as
`seen` and the golden's), the `command` that would reproduce its newest run with the run it came
`from`, the golden this `--pack` made of it, `packed` (`golden`, `runId`, `mode`), and `lastPack`,
what the last `--pack` made of it, here or before: `at`, the `golden` (or null), its `mode`, and the
`reason` and `why` it wasn't packed); for every golden read (`golden`, `runId`, its `path`, `writes`
and `outcome`, or the `error` that kept it from being read); and, with `--pack`, what each became
(`key`, the `golden` written and the `runId` packed, the imported run it came `from`, the `command`
it ran with where that came from, the `mode` of the golden, `replay` or `fork`, and the `reason`
and `why` it wasn't packed), else `null`.

## calibrate

```sh
shadowlap calibrate [run] [--write] [--max-rounds <n>] [--json] [--guard <mode>] [--allow-unrecorded <names>] [-y]
```

Replays a recording offline, repeatedly, and proposes a normalizer for every value that differs between two runs of the same code, until the replay is clean. Without a run named it takes the recording the dashboard's [setup](./dashboard.md#setting-it-up) made for this project, else the newest finished recording made here (one that completed or failed, not one imported from a pack or a capture), and asks you to record a run first when there is none. Each round is printed as it ends; a recording that is already clean ends with "Nothing to add". `--write` adds the proposals to `shadowlap.config.json` and says their numbers; `--max-rounds` is how many replays to try first (default 8); `--guard`, `--allow-unrecorded` and `-y` are as for `replay`. `--json` prints the result when calibration ends: `runId`, `source` (`given` when you named the run, `setup` for the setup's recording, `newest` when it picked the newest), `clean`, `rounds`, the proposed `normalizers` (each with `why` it was proposed), `written` and the numbers of the rules it `added` (a proposal already in the file isn't counted), and `stopped` with why when it isn't clean. No model calls; writes are blocked. Afterwards it removes the blobs its own replays left that nothing else uses, unless a run is recording. Exit status 0 when the replay ends clean, with or without proposals, 1 when calibration stops before it is clean, and 2 when the run named is still recording, there is no recording to calibrate, or its model called a tool it never recorded that [writes](./how-it-works.md#tools-shadowlap-did-not-record). See [Calibrate](./normalizers-and-redaction.md#calibrate).

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
| `normalize` | Masks values before fingerprinting, so an id the agent makes on every run does not fork a replay ([details](./normalizers-and-redaction.md)) |
| `redact` | Masks stored content in every export, pack and share link of a run ([where](./normalizers-and-redaction.md#where-the-rules-apply)); a redacted pack still replays, and a push copies runs to the team store as recorded |
| `clock` | `auto` (default) matches dates near each run's start across days; `exact` requires equality |
| `http` | Hosts called straight from a client library, recorded as tool calls with an effect ([details](./sdk.md#http-services-without-wrapping)) |
| `mcp.effects` | Effects by MCP tool name, overriding the server's annotations ([details](./mcp.md)) |
| `tools` | `trust` by tool name (or a host under `http`): `untrusted` for a read that brings outside text in, where [`shadowlap injection`](./injection.md) plants payloads. Recorded on each call of the tool as it is made, and, read when a run is tested, it wins over every recorded mark (the SDK's, an MCP server's, an earlier config's). `unrecorded` maps the tools the agent runs without Shadowlap recording them to `read` or `write`, which decides whether `replay` and `test` may run them again ([details](./how-it-works.md#tools-shadowlap-did-not-record)) |
| `prices` | USD per million tokens by model prefix, for cost estimates |
| `tests` | Outcome checks for `shadowlap test`, by recording directory ([details](./ci.md#outcome-checks); `calls`, `when` and `judge` in [Checks](./checks.md), and [judge checks](./judges.md)), a `gate` that decides on a forked golden's attempts with stated error rates ([gating](./gating.md)), an `injection` gate ([details](./injection.md#gate-ci-on-it)), a `task` object with where a model under test takes over, why, what the task rewards and the agent's scope (see [Training](./training.md)), and a `chaos` object with the golden's [error-path presets](./error-paths.md#configure-a-goldens-presets) (or `false` to leave it out of them) |
| `repair` | `repairer` (`provider:model`), `baseUrl` and `timeout` (seconds it may take to answer, default 600) for the model [`shadowlap repair`](./repair.md#the-repairer) asks for fixes |
| `store` | The [team store](./team.md), a bucket you own (`s3://`, `gs://`, `az://`, `r2://`), written by [`shadowlap store set`](#store). Never credentials |
| `ciPush` | `false` keeps `test --push` from pushing to the team store in CI, and the GitHub Action from pushing the fixes it opens (`shadowlap store push-from-ci on\|off`) |

The schema is [`shadowlap.config.schema.json`](https://github.com/devjoinedthechat/shadowlap/blob/main/shadowlap.config.schema.json) in the repository. It gives completion in any
editor that reads `$schema`, and it lets CI check a config without running Shadowlap. It is
stricter than the parser on purpose: the parser ignores a key it doesn't know, so that a config
written for a newer version still works, while the schema rejects it — which is what turns
`"normalise"` from a rule that silently never applies into an error you see as you type.

`shadowlap doctor` checks the file too, and reports every rule, price and effect it parsed.

## normalize, redact

```sh
shadowlap normalize add [--path <jsonpath>] [--pattern <pattern>] [--kind api|tool|clock|random] [--name <name>] [--replace <text>] [--expect <version>]
shadowlap normalize rm <n|name> [--expect <version>]
shadowlap normalize ls [--json]
shadowlap redact add [--path <jsonpath>] [--pattern <pattern>] [--kind api|tool] [--name <name>] [--replace <text>] [--expect <version>]
shadowlap redact rm <n|name> [--expect <version>]
shadowlap redact ls [--json]
shadowlap redact preview [run] [--json]
```

Both edit `shadowlap.config.json` in the working directory. [Normalizers](./normalizers-and-redaction.md) mask values before matching; redaction rules mask stored content in every export, pack and share link of a run.

- `add` takes a pattern (named, such as `uuid` or `email`, or `/regex/flags`), a path, or both. A pattern alone masks matches in every string (for redaction, but those of a clock or random read, which every copy keeps as recorded); a path alone replaces the whole value there, numbers included; `--name` scopes the rule to one tool or call. A redaction rule's path reaches requests in every copy; what a call got back, a response or tool result that is JSON (a tool's result is under `$.result`) and an attempt's error (`$.error`), it reaches only in a copy that is read (`export html`, `har`, `dataset`), never in a pack, whose replay hands it to the agent, nor in a clock or random read; `$` alone and a path that starts with a wildcard reach requests only. It refuses a rule that would change nothing or that it can't read, and for redaction a replacement the rule would rewrite again. Adding a rule that is already there changes nothing.
- `rm` takes the number `ls` shows (`2` or `#2`), or the tool name, path or pattern of exactly one rule.
- `ls --json` prints `{ file, exists, version, error, rules }`: `error` says why the list can't be read (it isn't a list; `ls` then exits 2), else `null`; each rule has its number `n`, and one the config can't load has `error` instead.
- `--expect <version>` refuses the edit when the file is no longer the version `ls --json` printed.
- `redact preview` shows what the rules would mask in a run that has ended (default: the newest), counted per rule with up to two samples, read through the functions `pack` applies them with (the run's own record included: a fork's flags, the divergence report, the checks and the last blame); under each rule, what it matches that a pack leaves as it is (a number: a copy masks the strings of a JSON document and keeps its numbers as recorded; anything in a clock or random read, which every copy keeps as recorded), with where each is and, for each place, the path rule that would mask it (in what a call got back, one that only the copies that are read apply), a rule that already does, or why none can; and on a line of its own what the rules match in the run's command line, labels and notes (`details`), which `export html`, `dataset` and `otel` mask and `pack` keeps. Nothing is written. [Preview](./normalizers-and-redaction.md#preview). `--json` prints `{ "runId", "calls", "unreadable", "partial", "total", "returned", "unmasked", "rules", "details" }`: the calls read and those that couldn't be, `total` masked in a pack, `returned` masked only by the copies that are read and `unmasked` left as they are, each rule with its number `n`, the `rule`, its `count`, up to two `samples` (`before`, `after`), how many values a path rule `reached`, a `note` when it masks nothing, its `returned` (the `count` and `samples` of what a path rule masks in what calls got back, which only `export html`, `har` and `dataset` mask) and its `unmasked`: their `count`, up to two `samples` (each `value`, whether it is a `key`, the `callNo`, `kind` and `name` of its call, whether it is `in` the call's request, response or error, its `path` there, and the stream's `event` it is in, or null), the `places` a path rule would mask them at, the `remedies` for up to 20 of those (each the `rule`, the `command` that adds it, and `copies`: `all` for a request, `read` for what a call got back, which only the copies that are read mask), the rules already `covered` that do in those copies (their numbers), and the `reasons` the rest get none (`replay`: a clock or random read; `stream`: in a stream's events; `whole`: the whole request or response, or a key at its top; `key`: under a key holding `]`; `signed`: in a model call's signed reasoning, which a pack keeps as recorded); `details` has a `count`, `samples` and the `rules` that match there.

Each add and rm is recorded in the project's activity, in a store that exists.

## serve

```sh
shadowlap serve
```

Starts a sidecar with one recording run for a process you launch yourself and prints the environment to export: `export` lines, or on Windows PowerShell's `$env:NAME = 'value'`. Ends the run on Ctrl-C, SIGTERM or a closed terminal (SIGHUP). Serve never sees the command that starts your process, so the run has none, as a capture has none: replaying it, or a fork, blame or Find the commit, needs your command after `--`. Hosts that manage several runs (a test runner) can create them through the sidecar's `/v1/runs` API. Each run's environment pins it: the provider base URLs carry the run id, and SDK calls send an `X-Shadowlap-Run` header, so several processes can record through one sidecar at once. With `--recordings` it starts no run of its own and serves [recorded tests](./testing.md) instead, for the pytest and Vitest integrations, which start it themselves. The printed environment has the base URLs only; clients that need [in-process capture](./providers.md#in-process-capture) (Bedrock, and Azure or Vertex with the endpoint in code) record under `shadowlap run`.

## mcp

```sh
shadowlap mcp [--effect <tool=effect>]... -- <server command>
shadowlap mcp --url <server> [--header "Name: value"]... [--allow-http] [--effect <tool=effect>]...
shadowlap mcp --url <server> --listen <address> [--header "Name: value"]... [--allow-http] [--effect <tool=effect>]...
```

A proxy for an MCP server: put it in the client's server configuration in place of the server itself; the client talks stdio to it. It starts a local server from its command, or speaks Streamable HTTP to a remote one at `--url`, sending each `--header` (`$VAR` or `${VAR}` read from the environment) with every request; headers go over plain http only to this machine, or anywhere with `--allow-http`. `tools/call` is recorded, replayed, blocked or stubbed like an SDK tool call, so a remote write never runs again on replay; every other message passes through. Effects come from the server's tool annotations (`readOnlyHint` → `read`, otherwise `write`), overridden by `--effect` or `mcp.effects` in the config. The proxy finds its run even when the client starts it with a minimal environment, and when it was started under Shadowlap but can't record, it refuses write tools rather than run them unrecorded. On Windows a server command that is a batch file (`npx -y …`) runs through cmd.exe. With `--listen` the proxy serves the `--url` server over Streamable HTTP at `http://<address>/mcp` instead, for a client that speaks HTTP: a loopback address (`127.0.0.1:8931`, or a port alone), each session in the server's own session id, recording into the run its command started, or, started on its own, into the run of the Shadowlap command that started the session's client, and refusing writes in a session it finds no run for. It runs until stopped. See [MCP servers](./mcp.md#served-over-http---listen).

## diff

```sh
shadowlap diff <a> <b> [--json]
```

Two runs call by call, aligned by position. Two calls make the same request when a replay served one from the other, or when what each sent is the same (its kind and name, the headers and query that make a model call the call it is, and its body, each number as it was sent, so two ids past 2^53 a double rounds alike differ), however each run fingerprinted it: a run recorded by an earlier Shadowlap compares with its replay as the replay matched it, and its model requests, stored with their numbers rounded, compare rounded on both sides. First, what differs about the runs as a whole: their system prompts, the tools they offered (added, removed, or with a changed definition), the models they used and their code versions. Then how many leading calls are identical in request and response; when one run is the other's replay and the flag that made it changed an answer rather than a request (`--fail-at`, `--override`, `--inject-result`, `--diverge-at`), what it did, with what each run got there (`⑂ #19 got HTTP 529 instead of an answer, by --fail-at 19=529`, `⑂ #16 lookup_policy returned {…} instead of {…}`); then the first call whose request differs (with a structural diff and normalizer hints), how many later requests differ too, and every call whose request was the same but whose response was not, e.g. a live re-run where the model answered differently (both answers are shown; a call answered the same way in a new response, where only its id or token counts differ, is counted apart), or a tool that returned something else. Exit status 1 when the runs differ, like `diff`.

`--json` prints the comparison: `a` and `b` (each `runId` and `calls`), `identicalPrefix` and those calls (`prefix`, the first 500), `firstRequestDifference` (`callNo`, `kind`, `name` and the structural `diff`, or `null`), `responseDifferences` (each with `sameAnswer` when the response was new but its answer the same, and `by`, the flag, for the call a replay's flag answered), `after` (each run's course from the first difference on), `onlyInA`, `onlyInB`, `changes` (`systemPrompt`, each run's system prompts by their hashes in `systems`, `tools`, `models`, `code`), and `intervention`: when one run is the other's replay and its flag changed an answer, `run` (`a` or `b`, the one the flag made), `kind` (`fail`, `override`, `answer`, `plant` or `resample`), `flag`, `callNo`, `name`, `before` and `after` (what each run got there), and `words`; `null` otherwise.

## dashboard

```sh
shadowlap dashboard [run] [--call <n>] [--port 4777] [--no-open] [--read-only]
```

A local web UI over the store: runs and forks, a timeline of calls by origin, the conversation at any call, playback of streamed responses, fork diffs, comparison, the activity feed, and replay and fork actions. Listens on 127.0.0.1 with a session token in the link it prints; a port that is taken, or that the system keeps for itself (a range Windows reserves), falls back to a free one, and `--port 0` asks for any free one: either way the link names the port it got. `--read-only` shows every page and changes nothing: actions, labels, notes, uploads and deletes are refused, and the dashboard says why. It needs a store to show and never creates one. See [Dashboard](./dashboard.md).

## doctor

```sh
shadowlap doctor [--json]
```

Checks what support would check: Node and its built-in SQLite, with the full-text index every store has (a Node build whose SQLite has none is told to use an official build, and the store is left unread rather than called damaged), the guard preloads, Python on the PATH (as `python3`, `python` or both, since an agent's command names one), the store (runs, size, schema, runs a killed process left marked running), a stale or incomplete `.shadowlap/active.json`, the configuration (every rule, price and MCP effect parsed, and under `tests` each [rule that names a tool](./checks.md#checking-the-checks) no recording called or offered to its model, or reads a value no recorded call of its tool has, held against the packs the entries apply to and the store's 200 newest runs, with the name it most likely meant, each [judge check](./judges.md) whose model retires, by the [retirement table](./decisions.md#model-retirements) that ships with Shadowlap, each judge check whose provider has no key in this environment and no upstream set for it, so no judge can be asked for it live and it reads [not judged](./judges.md#not-judged) wherever its verdict isn't recorded, and each golden that holds no recorded verdict, or only one given to an older form of the judge's request, for a judge check that applies to it, with the `test --update` that records it: a judge under a [`when`](./checks.md#conditions) whose condition never held in the golden is not applicable there, and needs none), and agent-process environment that leaked into your shell (`SHADOWLAP_URL`, `NODE_OPTIONS`, `PYTHONPATH`). Each problem comes with the fix. Exit status 1 when something is blocking. `--json` prints the checks as a list, each `{ "name", "verdict", "detail" }` with `verdict` `ok`, `warn` or `fail`, and a `fix` where there is one.

## skill

```sh
shadowlap skill install [claude-code|agents|kiro] [--force] [--json]
```

Puts the [coding agents' instructions](./agents.md) into the project you run it in, from the copy that comes with the CLI: nothing is downloaded, and the commands they name are the ones this CLI takes. They are two skills, `setup-agent` and `debug-agent`. `claude-code`, the default, writes the Claude Code plugin with both to `.claude/skills/shadowlap/`, where Claude Code loads it for everyone working on the project once the folder is trusted. `agents` writes the skills alone to `.agents/skills/shadowlap-setup-agent/` and `.agents/skills/shadowlap-debug-agent/`, where Codex, Cursor, GitHub Copilot, Gemini CLI, Antigravity, Windsurf, OpenCode, Cline, Amp, goose, Zed and Junie read skills; each of those agents' names (`codex`, `cursor`, `copilot`, `gemini`, `antigravity`, `windsurf`, `devin`, `opencode`, `cline`, `amp`, `goose`, `zed`, `junie`) does the same. `kiro` writes them to `.kiro/skills/`. In those two folders, which every tool's skills share, each skill is named `shadowlap-<skill>` and leaves out `allowed-tools`, which names Claude Code's tools; nothing but the `shadowlap-` folders is read or written there. A copy that is already this version's is left as it is.

Anything else there (another version's copy, or one edited here) is left as it is too, and the command exits 1 saying which files differ. `--force` replaces them, which is how a project moves to the copy of a newer Shadowlap, and removes the files of ours that this version doesn't have (in the plugin's folder, or in a `shadowlap-` skill's), so an older version's skill stops loading. A link on the way that leads out of the project, or a link where the install puts a file, is refused with or without `--force`.

`--json` prints `{ agent, path, version, before, installedVersion, outcome, files, reason }`: `agent` is where it installed (`claude-code`, `agents` or `kiro`), `before` is what was there (`missing`, `current`, `other-version` or `changed`), `installedVersion` the version the copy there says it is (the plugin's manifest, or each skill's `metadata.version`), `outcome` is `installed`, `updated`, `unchanged` or `refused`, `files` lists each file's `path` and `action` (`written`, `replaced`, `removed` or `unchanged`, or for a refused install `differs` and `extra`, what it left), and `reason` says why it was refused. Exit status 0 unless it was refused. Settings → Coding agents in the [dashboard](./dashboard.md) runs it as the `skill-install` job.

## rm, gc

```sh
shadowlap rm <run...> [--forks]
shadowlap gc [--older-than <days> | --before <time>] [--keep <n>] [--expect <count>-<digest>] [--dry-run] [--json]
```

`rm` deletes runs, each with the attempts bundled under it (`--repeat`, blame's probes, verify's attempts, a golden's repeats in one test session, an error-path preset's attempts, and theirs in turn), as the dashboard deletes them, so none is left behind as a run of its own; their forks keep their data but lose the link. A run still recording, one a run in progress replays from (a replay, fork or attempt of it serves its answers from it), and one with an attempt still running, is left, with the reason, as the dashboard leaves it, and `rm` then exits 1. `gc` deletes old runs (`--older-than 30`, `--keep 200`), each with the attempts bundled under it, however new, as `rm` takes them; runs are counted as the lists count them, so `--keep 200` keeps the newest 200 runs, each attempt counted with the run it came from. Runs still recording are never touched, and one a run in progress replays from, or with an attempt still running, is left, with the reason, as `rm` leaves it. It then removes blobs nothing references any more, and vacuums the store. The TUI's `x` does the same as `rm` for one run.

While any run is still recording, in this project's store and from any process, no blob is collected and the store isn't vacuumed: a recording stores a blob just before the call that references it, and reuses a blob already stored, so a blob that looks unreferenced may be one it is about to use. `gc` still deletes the old runs, says which runs are recording, and frees their blobs on a later run. `rm` collects blobs under the same rule.

A run whose recording process was killed (`kill -9`, out of memory, a machine that went away) stays marked running, but it isn't recording, and it holds nothing up. The store names the process that records each run until the run ends: a run whose process is gone from this machine is abandoned at once; one whose process can't be asked (it ran on another machine) is abandoned after a day without a call, and one whose process is still there after a week without one. `gc` lists abandoned runs, marks them interrupted as of the last thing they recorded, and deletes them like any other run when they match `--older-than` or `--keep`. Until then every copy of such a run holds it that way: `pack`, `export html`, `export otel` and `share` write it interrupted, ended at its last call (a teammate who unpacks it never sees it recording), and `bisect` takes it so, leaving the store as it is.

`--dry-run` changes nothing and says what a real run would free:

```
▸ runs older than 30 days: 3 of 120 · runs still recording are never touched
    01M2R1HDVD  record  completed  41d ago  node agent.js
    …
  blobs nothing would reference: 14 · 2.1 MB
✓ dry run: would delete 3 runs and free 2.1 MB. To delete exactly these runs: shadowlap gc --before 1757000000000 --expect 3-9c1f0e2a6b7d4c5e
```

The size is what those blobs take in the store. When no run matches, it says what a plain `shadowlap gc` would give back instead (blobs nothing references, and unused space of 1 MB or more that deleted runs left in the store), with no command that deletes runs:

```
▸ runs older than 30 days: none · runs still recording are never touched
  blobs nothing would reference: 14 · 2.1 MB
  unused space in the store: 51.4 MB
✓ dry run: no runs to delete; would give back 2.1 MB of blobs nothing references and 51.4 MB of unused space. To do that: shadowlap gc
```

While a run is recording, gc gives none of it back, so the dry run says it can be given back once no run is recording: `✓ dry run: no runs to delete; 51.4 MB of unused space can be given back with shadowlap gc once no run is recording.`

`--json` prints the same report: `dryRun`, `olderThanDays`, `keep`, the `cutoff` (runs that started before it go, in epoch milliseconds), `total` runs, how many runs it deletes (`count`, or would), the `attempts` bundled under them that go with them, and the first 100 runs (`runs`), `expect`, `blobs` and `bytes` freed, the runs still `recording`, the `abandoned` ones and the matching runs `held` because a run in progress replays from them or an attempt of them is still running (each with `why`) (the first 100 of each, with `recordingCount`, `abandonedCount` and `heldCount`), whether blobs were `deferred` because of a recording, and the `store`: its `path`, its size `before`, its unused space `free` (which vacuuming gives back), and, after a real run, `after`. The lists stop at 100 so the report stays small however many runs a clean-up deletes. The store's size counts the database's pages whatever its write-ahead log holds, so another process holding the store open (a dashboard) doesn't make a cleanup look like growth. A real run is recorded in the project's activity as `runs.cleaned`.

To delete exactly what a dry run listed, pass its cutoff and its `expect` back: `shadowlap gc --before <cutoff> --expect <count>-<digest>` names those runs (how many, and a digest of their ids and their attempts'), and refuses, deleting nothing and with exit status 2, when the runs that match now are different, even the same number of others, or have other attempts under them. `--before` also takes a date (`2026-09-01`). In a project that has never recorded, `gc` reports nothing to clean and creates no store.

## export html

```sh
shadowlap export html <run>                    # shadowlap-01m2p15fwy.html
shadowlap export html <run> run.html --lineage # with the run's ancestors, so they compare inside the file
shadowlap export html <run> --no-redact        # skip the config's redaction rules
```

One HTML file with the dashboard's views and the run's data built into it: calls, conversations, responses, the divergence diff, the context and timeline views, and comparison between the runs it holds. It opens from a file, an artifact or a pull request comment, on a machine that has neither Shadowlap nor the recording, and it loads nothing from the network. Actions, live updates and search across runs belong to the dashboard, not to a copy.

It is a copy of recorded data: the redaction rules in `shadowlap.config.json` apply, as they do to `pack`, and the command says how many applied, that there were none, or, with `--no-redact`, how many it skipped. A run still recording is refused, exit status 2 (every export waits for a run to end, or the copy would show it recording for good); with `--lineage`, so is a run whose ancestor is still recording. Like a pack, it leaves out who made each run. A 30-call run comes to about 1.2 MB, most of it the dashboard's own code, styles and fonts, which every copy carries.

## export dataset

```sh
shadowlap export dataset --label good --out good.jsonl
shadowlap export dataset <run...> --calls model --format openai-chat
```

Recordings as an eval or fine-tuning dataset, one JSON line per example. Select runs by id, by `--label` (repeatable: all of them) or `--all`. A run named that is still recording is refused, exit status 2; one picked by `--label` or `--all` is left for a later export, and the command says how many.

| Option | Effect |
|---|---|
| `--calls final` (default) | One example per run: its last model call |
| `--calls model` | One example per model call |
| `--format jsonl` (default) | `{ input: { messages, tools }, output: { text, tool_calls }, metadata }` |
| `--format braintrust` | `{ input, expected, metadata }` |
| `--format langfuse` | `{ input, expectedOutput, metadata }` |
| `--format openai-chat` | `{ messages }`, the recorded answer as the last assistant message |
| `--no-redact` | Skip the redaction rules |

Messages are the conversation exactly as the model saw it, in a provider-neutral shape: system, user, assistant (with its tool calls and their ids) and tool results, whichever provider recorded it. `metadata` carries the run and call, the model, labels, notes, outcome check results, the command, code version and fork point. The redaction rules apply to each model call's request and response as `pack` applies them, path rules included, before its conversation and answer are read; then the rules without a path apply to every string of the row, its command line, labels and notes too. A rule that can't be read stops the export. The command says how many rules applied, that there were none, or, with `--no-redact`, how many it skipped.

## export pairs

```sh
shadowlap export pairs --out pairs.jsonl
shadowlap export pairs --min-confidence medium --format trl --out pairs.jsonl
```

Preference pairs read from the attempts blame, verify and `--repeat` left in the store, one JSON line per pair: the conversation as the model saw it at a call, in the messages `export dataset` writes, an answer to prefer and one to avoid. It prints every source it read (including those that made no pairs, and why), the count and how many were left out, the shape, the redaction line and the file. Each export is kept in the store as what left the machine; when no pair is at the confidence asked for, nothing is written and a file already there is left as it was. [Training](./training.md) explains where pairs come from and what high and medium mean.

| Option | Effect |
|---|---|
| `--min-confidence high` (default) | Answers blame proved decided the run |
| `--min-confidence medium` | Also where a failing and a passing attempt first answered differently |
| `--format openai-preference` (default) | `{ input: { messages, tools }, preferred_output, non_preferred_output }` |
| `--format trl` | `{ prompt, chosen, rejected }` as chat messages, with `tools` |
| `--out <file>` | Write here instead of stdout |
| `--no-redact` | Skip the redaction rules, which otherwise apply to the copy: rules without a path to every string, rules with a path to the message fields kept |

## export har

```sh
shadowlap export har <run>                 # HAR to stdout
shadowlap export har <run> traffic.har
shadowlap export har <run> --no-redact     # skip the config's redaction rules
```

A run's model API calls as a HAR, for any tool that reads one, and the reverse of
[`import`](#import): exporting a run and importing it again produces the same
fingerprints. Tool, clock and randomness calls are left out, because a HAR describes HTTP. Azure,
Vertex and Bedrock hosts depend on the account, so a representative host for the provider stands in.
Credentials are never written.

A HAR carries full requests and responses, so the redaction rules in `shadowlap.config.json` apply,
as they do to `export html`: every rule to the request bodies and to a response that is JSON
(rules with a path included, since a HAR is only read), and the rules without a path to the URL,
the headers and every response, streamed or not.
A model streams its text in pieces, so an address it writes back arrives split across events; each
run of pieces (a block's text, a tool call's arguments) is masked as the text it adds up to, and the
masked text is spread back over the same events. The rules are named in the log
(`_shadowlap.redactions`). `--no-redact` skips them; the command says when there are none to apply, and how many it skipped. A run still recording is refused, exit status 2, as by every export.

## export otel

```sh
shadowlap export otel <run>                                   # OTLP JSON to stdout
shadowlap export otel <run> --out trace.json                  # a file only, even with OTEL_EXPORTER_OTLP_ENDPOINT set
shadowlap export otel <run> --endpoint http://localhost:4318  # or OTEL_EXPORTER_OTLP_ENDPOINT
shadowlap export otel <run> --no-redact                       # skip the config's redaction rules
shadowlap export otel <run> --service refund-agent            # service.name, default shadowlap-agent
```

A run as one OpenTelemetry trace: a span for the run and a child span per call, using the GenAI semantic conventions (`gen_ai.operation.name`, `gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.*`, `gen_ai.response.finish_reasons`, `gen_ai.tool.name`) plus `shadowlap.*` attributes for the origin, effect, fingerprint and cost. Trace and span ids are derived from the run id, so exporting twice updates the same trace. Headers for an authenticated collector come from `OTEL_EXPORTER_OTLP_HEADERS` (`key=value,key2=value2`). No OpenTelemetry SDK is involved. With `--out` the trace goes to that file and nowhere else unless `--endpoint` is given too; without either, it goes to `OTEL_EXPORTER_OTLP_ENDPOINT` when that is set, else to stdout. A collector that doesn't answer stops it with exit status 1 and says where the trace went and why (`connection refused (ECONNREFUSED)`, `no such host (ENOTFOUND)`); a file asked for with `--out` is written first.

A trace carries no prompt text, tool arguments or results. The redaction rules without a path apply to what it does carry from the run: span names, the command line (`process.command_args`, masked as one text as every copy masks it, and before the run's span is named after its first 200 characters), model and tool names, and error messages; Shadowlap's own ids and fixed values stay as they are, and the command says how many rules applied. A rule that can't be read stops the export. A run still recording is refused, exit status 2, as by every export.

## push, pull

```sh
shadowlap push <run...>          # these runs, with their ancestors
shadowlap push --all             # every run on this machine that isn't in the store as it is
shadowlap pull [<run...>]        # teammates' runs, or only these (ids or unique prefixes, as in the store)
shadowlap pull --include-pr      # and the runs pull requests' CI jobs pushed to their own folders
```

Copy runs between this machine and the [team store](./team.md) named by `store` in
`shadowlap.config.json`, with this machine's own credentials. Blobs shared between runs go up once;
a run still recording goes when it ends; labels and notes merge both ways, and a run's results come
from the machine that made it; a run deleted here isn't pulled again unless named. Both count by
run, as the dashboard does: "45 runs and 69 attempts pushed", where attempts (`--repeat`, blame's
probes, verify's attempts, a golden's in one test session) are those filed under their runs, and a
run counts as only on this machine while it, or an attempt filed under it, isn't in the store. Fixes
go with their runs: a push sends each [fix](#fix) with its blames, repairs and verdicts once one of
its runs is in the store, and a pull brings the team's, merged with this machine's (a teammate's
repair, from a pull or from the store's copy a push merges with, has its `fix.patch` and reports
written to `.shadowlap/repairs/<id>/`). Whether a fix is applied is this machine's own and never
goes; a fix over 16 MB stays here, and a pull skips one in the store that is, saying which. A push
names the pusher as the author of a run made here without one, and leaves here, saying why, a run a
pull would refuse. `pull` checks every run it brings as strictly as `unpack`; a run in the store
that fails is skipped with its forks and tried again next time. A pulled run is marked with the store's URL (`meta.imported.from`): it reads as its author's recording, with what it spent, and replaying it asks before running its command, as an unpacked run's does (`--yes` says yes). A run named to `push` that the store
has already is checked part by part, and what the bucket lost of it (its calls, a blob) is sent
again. Either exits 1 when a run it was named can't go or come, or the store fails part way, and 2 when
no store is set or this machine's credentials are missing or refused. `--json` prints the result.

In a [pull request's CI job](./team.md#pull-requests) (GitHub Actions `pull_request` events, GitLab
merge request pipelines, or `SHADOWLAP_PR` set), `push` writes only to the pull request's own
folder, `pr/<number>/` in the store. `pull` leaves those folders out unless given `--include-pr`;
runs it brings from one stay on this machine: `push --all` leaves them out, and `push` refuses one
by name.

`push --json` prints `{ store, pullRequest, pushed, updated, unchanged, queued, repaired, refused, blobs, segment, onlyLocal, fixes }`:
the store, the pull request whose folder it wrote to (or `null`), the runs `pushed`, `updated`
(labels, notes or results merged), `unchanged`, `queued` (still recording) and `repaired` (parts
the bucket lost, sent again), each run `refused` with why, the `blobs` `uploaded`, already
`present` and their `bytes`, the index `segment` it wrote (or `null`), how many runs are still
`onlyLocal`, and the `fixes` that went with the runs (none from a pull request's job): the ids
`sent`, those that `failed` (`fixId`, `reason`), and the teammates' `repairs` the store's copies
brought. `pull --json` prints `{ store, pulled, merged, needPush, skippedDeleted, missing, unknown, failed, skippedSegments, blobs, segments, inStore, byAuthor, onlyLocal, pullRequests, fixes }`:
the runs `pulled` and `merged`, the merged ones whose changes the next push sends (`needPush`),
runs deleted here and not pulled again (`skippedDeleted`), runs gone from the store (`missing`),
names that match no run (`unknown`), runs that couldn't come (`failed`, with why) and index
segments that couldn't be read (`skippedSegments`), the `blobs` `downloaded` and their `bytes`, the
`segments` read, the runs `inStore` and `onlyLocal` here, the pulled runs `byAuthor`, with
`--include-pr` each pull request's folder (`pullRequests`), and the `fixes` that came with the
runs: the ids new here (`pulled`), those here the store's copy added to (`merged`), those in the
store that couldn't be read (`failed`: `fixId`, `reason`), and the `repairs` whose files it wrote.

## share

```sh
shadowlap share <run> [--lineage] [--json]
```

Writes the run's [HTML report](#export-html), with every redaction rule applied, to the
[team store](./team.md#share-links) and prints a presigned link that expires after 7 days. Anyone
with the link can open it, without an account. `--lineage` includes the run's ancestors. A run still recording, or with `--lineage` one whose ancestor is, is shared once it has ended: until then `share` refuses it, exit status 2, before anything is asked of the store.
`--json` prints `{ runId, url, expiresAt, note, store, key, bytes, redacted, rules, runs }`: the link
(`url`) and when it expires (`expiresAt`, epoch milliseconds), a `note` when it may stop working
sooner (it was signed with temporary credentials), the store and the object's `key` in it, its `bytes`, whether it is `redacted`
and with how many `rules`, and the `runs` it holds.

## store

```sh
shadowlap store set <url> [--provider s3|gcs|azure|r2]   # write "store" to shadowlap.config.json
shadowlap store set <url> --check                        # check access first; write it only if that works
shadowlap store check                                    # list, write, read and delete; encryption, versioning, object lock
shadowlap store show                                     # last push and pull, runs in the store and only here, last check (offline)
shadowlap store policy [--provider s3|gcs|azure|r2]      # the access to ask your cloud admin for: two policies
shadowlap store ci --provider github|gitlab|other [--packs <glob>]   # a CI step that runs test --push
shadowlap store push-from-ci on|off                      # whether CI pushes its test runs and fixes
```

Set up the [team store](./team.md#the-store). `set` checks the URL against the provider's scheme
(with `--provider`, against that one only) and writes it to the config, keeping everything else;
with `--check` it first checks the store as `check` does and writes nothing when that fails, then
says what to fix and to run the same `store set … --check` again (in the dashboard's store setup,
**Check access and connect** again). `check` proves this machine's credentials can list, write, read
and delete a test object, and reports encryption, versioning and object lock, with a warning when
versioning or object lock is off; it exits 1 when access fails. `policy` prints two policies scoped
to the store's folder, each an IAM policy, role bindings, a role assignment or R2 token scopes: one
for people and CI on protected branches, and one for pull requests' CI jobs, which may write only
under `pr/`. `ci` prints a step for GitHub Actions, GitLab CI or any other CI, with short-lived
credentials (OIDC) where the CI and the cloud allow it, and the pull-request credentials beside the
protected branches' (on GitHub, for pull requests from the repository itself: a fork's gets no OIDC
token, so its job skips them and runs the tests without pushing). Its tests run with `npx
shadowlap@<version>`, this CLI's own release; on GitHub, Node 22 and a line for the agent's
dependencies (`npm ci && npm run build`, to make your project's) come before them, and on GitLab
that line opens each job's script. The goldens it tests that run live (marked `fork`, or with an
injection gate) need the keys of the providers their recordings call: on GitHub the step's `env`
takes them from the repository's secrets, by name, and on GitLab and any other CI a note names
them; a comment says to add your agent's own where a key can't be named (a pack that can't be read,
or Vertex AI, which signs in with a token). `push-from-ci off` writes
`"ciPush": false` to the config: `test --push` in CI then runs the tests and keeps their runs in the
job (outside CI, `--push` still pushes), and the GitHub Action keeps the fixes it opens there too;
`on` turns it back on. Each takes `--json`.

With `--json`, `set` prints `{ store, url, provider, bucket, prefix, account, region, previous, config, set }`:
the store as written to the config and its `url` without the options after `?`, its parts, the
store it replaced (`previous`), the config file's path, and `set`, true once the config is written.
With `--check` it adds `check`, the check as `check --json` prints it; when the check fails it
prints only `{ store, url, provider, set, check }`, with `set` false, writes nothing and exits 1. `check` prints
`{ url, credentials, steps, ok, encryption, versioning, objectLock, warnings, notes, failure, pullRequest }`:
where the `credentials` came from, each step (`name`, `ok`, `detail`, `code`), whether all passed
(`ok`), the bucket's `encryption`, `versioning` and `objectLock` (`state`, `detail`), its
`warnings`, what couldn't be checked (`notes`), the kind of the first `failure`, and the pull
request whose folder it checked. `show` prints `{ url, store, provider, providerName, bucket, prefix, region, pushedAt, pulledAt, inStore, onlyLocal, localAttempts, queued, check }`:
the last push and pull (epoch milliseconds), the runs `inStore`, `onlyLocal` (a run counts while
it, or an attempt filed under it, is only here), the attempts only here (`localAttempts`), the
runs `queued` that are still recording, to go when they end (one that ended since counts as only here until the next push sends it, and one deleted is forgotten), and the last `check` (`ok`, `at`, `encryption`, `versioning`, `objectLock`,
`credentials`). `policy` prints `{ provider, writer, pullRequest, notes }`, each policy with whom
it is `for`, its `kind`, its `text` and `notes`. `ci` prints `{ ci, provider, file, text, oidc, pullRequests, notes }`:
the step's `text` and the `file` it goes in, whether it uses short-lived credentials (`oidc`), and
whether pull requests' jobs push to their `own-folder` or not at all (`no-push`, in `pullRequests`). `push-from-ci` prints `{ ciPush, previous, config }`.

## Environment

| Variable | Meaning |
|---|---|
| `SHADOWLAP_UPSTREAM_ANTHROPIC`, `_OPENAI`, `_GEMINI`, `_AZURE`, `_VERTEX`, `_BEDROCK` | Override a provider's upstream (a mock, or an OpenAI-compatible server such as Ollama). Without one, `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL` and `GOOGLE_GEMINI_BASE_URL` are used when they are set |
| `SHADOWLAP_CAPTURE=off` | Don't capture model calls inside Node and Python agents; only the base-URL variables apply ([details](./providers.md#in-process-capture)) |
| `SHADOWLAP_TELEMETRY=0`, `DO_NOT_TRACK=1` | Disable [telemetry](./telemetry.md) |
| `SHADOWLAP_TELEMETRY_URL` | Send [telemetry](./telemetry.md) to a collector you run. Without it nothing is sent |
| `SHADOWLAP_AUTHOR` | Who made the runs and activity entries a command records, as the dashboard shows them. Otherwise `ci` in CI, else git's `user.email`, else the OS user |
| `SHADOWLAP_PR` | A pull request's number, set in its CI build where Shadowlap doesn't recognise pull requests by itself (it does on GitHub Actions and GitLab CI): the build writes only to that pull request's folder in the [team store](./team.md#pull-requests) |
| `SHADOWLAP_HOME` | The folder for this machine's own files, such as the dashboard's [project list](./dashboard.md#projects), as an absolute path (default `~/.shadowlap`; a relative path is ignored) |
| `SHADOWLAP_PROJECT_ROOTS` | Folders besides your home folder that the dashboard may suggest and add projects from, separated like `PATH` |
| `SHADOWLAP_TASKS_TOKEN` | The token `tasks serve` requires, at least 16 characters; a random one is printed without it |
| `OLLAMA_HOST` | Where `tasks models` lists Ollama's installed models (default `127.0.0.1:11434`) |
| `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` | Reach the team store and the clouds' sign-in services through a proxy ([details](./team.md#the-store)). The agent never reaches the sidecar through one: `run`, `replay`, `test` and `serve --recordings` add `127.0.0.1`, `localhost` and `::1` to `NO_PROXY` and `no_proxy` |
| `NO_COLOR` | Plain output |
