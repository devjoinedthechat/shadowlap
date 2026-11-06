# CLI

The reference for the `shadowlap` command: every command, its flags, how it exits and the JSON it
prints. Read it for the exact behaviour of a flag or the fields of a report. The
[quickstart](./quickstart.md) walks through a first run.

```sh
shadowlap run -- node agent.js        # record a run
shadowlap replay 01M2P9PVCP --strict  # replay it; exit 1 if it diverges
shadowlap blame 01M2P9PVCP            # find the model call where a failed run was lost
shadowlap test goldens/*              # replay the packed goldens, as CI does
```

## Commands

The commands, in the groups `shadowlap --help` lists them in:

| Group | Commands |
| --- | --- |
| Try it | [`demo`](#demo) |
| Record and replay | [`run`](#run), [`replay`](#replay), [`calibrate`](#calibrate), [`mcp`](#mcp) |
| Look at runs | [`dashboard`](#dashboard), [`ui`](#ui), [`show`](#show), [`ls`](#ls), [`search`](#search), [`diff`](#diff), [`label`, `note`](#label-note) |
| Find and fix | [`blame`](#blame), [`verify`](#verify), [`repair`](#repair), [`fix`](#fix) |
| Preview a change | [`decisions`](#decisions), [`migrate`](#migrate) |
| Test | [`test`](#test), [`bisect`](#bisect), [`pack`, `unpack`](#pack-unpack), [`serve`](#serve), [`check`](#check), [`injection`](#injection), [`coverage`](#coverage) |
| Set up | [`init`](#init), [`doctor`](#doctor), [`normalize`, `redact`](#normalize-redact), [`skill`](#skill) |
| Import | [`import`](#import) |
| Export and clean up | [`export html`](#export-html), [`export dataset`](#export-dataset), [`export pairs`](#export-pairs), [`export har`](#export-har), [`export otel`](#export-otel), [`rm`, `gc`](#rm-gc) |
| Train | [`tasks`](#tasks) |
| Team store | [`push`, `pull`](#push-pull), [`share`](#share), [`store`](#store) |

What every command shares: the [requirements](#requirements), the [global options](#global-options),
the [exit statuses](#exit-status), the [JSON output](#json-output), the
[configuration file](#the-configuration-file) and the [environment variables](#environment).

## Requirements

The CLI runs on Node 22.16 or later, but not on Node 23. That is because every store keeps a full-text
index, which Node's built-in SQLite has from 22.16 on, and in 24 and later.

- **Another Node**: the CLI names the Node it needs and exits 2.
- **A SQLite without full-text search**: a Node in that range can have a SQLite built without it,
  such as a custom build. Opening a store on it says to use an official build, as
  [`doctor`](#doctor) does.

## Global options

`shadowlap` takes these options:

| Flag | What it does | Default |
| --- | --- | --- |
| `--db <path>` | The store to use | `./.shadowlap/shadowlap.db` |
| `-v, --verbose` | Print the sidecar's log on stderr. Give every attempt its own line where a terminal folds them, as [blame](#blame), verify and repair do | — |
| `-h, --help` | Print the help; after a command, that command's, with its options and these | — |
| `-V, --version` | Print the version number, before any command | — |

Every command takes `--db` and `--verbose`, before the command or after it:
`shadowlap --db other.db ls` and `shadowlap ls --db other.db` are the same. Run ids can be abbreviated
to any unique prefix.

### Where a store is created

A store is created by the first command that records into it. These commands never create one:

- **Commands that only read it**: `ls`, `show`, `search`, `diff`, `pack`, the exports, `fix ls` and
  `tasks`.
- **Commands that change only what it already holds**: `label`, `note`, `rm`, `fix title`, and
  `coverage`, which keeps its scans there.

Where there is no store, they find nothing. When the project's store is in a folder above (run from
`src/`, say), they name it.

## Exit status

Every command ends with an exit status a script or a CI step can tell apart: 1 for a check that
failed, 2 for a command it can't run as given, 3 for a verdict that couldn't be reached, 70 for a bug.
Each command's section says which statuses it ends with. The statuses are:

| Status    | Meaning                                                          |
| --------- | ---------------------------------------------------------------- |
| `0`       | Ok: the command did what it was asked, and what it judged passed |
| `1`       | Failed: what it judged failed, or the work could not be finished |
| `2`       | Usage or configuration: a command it can't run as given          |
| `3`       | Inconclusive: a gate or check that could not decide              |
| `70`      | Internal error: a bug in Shadowlap                               |
| `128 + n` | Stopped by signal *n*                                            |

**`1`, failed**, covers:

- a check, gate or test that failed;
- a replay that diverged where it may not (`--strict`, `test`);
- a change verify or repair rejected;
- a search that found nothing;
- work that could not be finished: a host that didn't answer, a patch that didn't apply, a store
  another process held too long.

**`2`, usage or configuration**, covers:

- a flag, argument or command it doesn't take;
- a run or fix it can't find, or can't use yet (one still recording);
- a file it can't read, or an invalid `shadowlap.config.json`;
- a live command with no key;
- a recorded command it needs `--yes` to run;
- a replay that would run a [write Shadowlap never recorded](./how-it-works.md#tools-shadowlap-did-not-record)
  again;
- an agent on a Node too old for the guard.

**`3`, inconclusive**, covers:

- a gate or check that could not decide. That is `0` when it only warns: under
  `--inconclusive warn`, or, with none given, for a gate against history whose golden has fewer than
  30 sessions that ran out of attempts with no decline or drop in them;
- a budget spent before a verdict;
- the provider unavailable.

**`70`, internal error**: the message says so. Run the command again with `SHADOWLAP_DEBUG=1` to see
where it happened, and report it.

**`128 + n`, a stop signal**: `130` for Ctrl-C, `129` for a closed terminal (SIGHUP), `143` for
SIGTERM. That holds however the command wound down, for the dashboard, `ui`, `serve`, `tasks serve`,
`mcp`, `demo` and `replay --watch` too. It holds for a signal that came during its last work too, such as
repair removing its worktree after its last verify. A signal in the last moment before the process
exits, a few milliseconds, may find it already ending with its own status.

`run` and `replay` end with the agent's own status where none of these applies, as the agent would
have ended without Shadowlap: `127` for a command that isn't on the PATH, and `128 + n` for an agent a
signal stopped. `SHADOWLAP_DEBUG=1` prints the stack of any error, for a bug report.

## JSON output

Most commands can print what they did as JSON, for scripts, CI and coding agents:

- **`--json`** prints the result as JSON on stdout. The commands that report progress as they work
  (`blame`, `verify`, `repair`, `fix apply`, `decisions`, `migrate`, `bisect`, `injection` and
  `tasks score`) still print it on stderr.
- **`--summary-json <file>`** (`run`, `replay`) and **`test --json <file>`** write the JSON to a file.

Each command's section lists its fields. This table says where:

| Command | What it prints |
| --- | --- |
| `run --summary-json <file>` | The run's summary ([fields](#run-summary-as-json)) |
| `replay --summary-json <file>` | The replay's summary and checks, or every attempt and the report ([fields](#replay-summary-as-json)) |
| `show`, `ls`, `search`, `diff` | A run, the runs, the matches, a comparison ([show](#show), [ls](#ls), [search](#search), [diff](#diff)) |
| `label` | The run's labels ([fields](#label-note)) |
| `blame`, `verify`, `repair` | Their reports ([blame](./blame.md#json), [verify](./verify.md#json), [repair](./repair.md#json)) |
| `fix ls`, `fix show`, `fix pr`, `fix apply` | The dashboard's read model of Fixes ([fields](#fix)) |
| `decisions`, `migrate` | The report the dashboard reads ([decisions](#decisions-report-as-json), [migrate](#migrate-report-as-json)) |
| `test --json <file>` | The session's report ([fields](#test-report-as-json)) |
| `bisect`, `check`, `injection`, `coverage` | Their results ([bisect](#bisect), [check](#check), [injection](#injection-report-as-json), [coverage](#coverage-scan-as-json)) |
| `calibrate`, `init`, `doctor`, `skill install` | What each found or did ([calibrate](#calibrate), [init](#init-findings-as-json), [doctor](#doctor), [skill](#skill)) |
| `normalize ls`, `redact ls`, `redact preview` | The rules, and what they would mask ([rules](#normalize-redact), [preview](#redact-preview)) |
| `import` | The runs it made and what it skipped ([fields](#--json)) |
| `gc` | What it deleted or would delete ([fields](#gc-as-json)) |
| `tasks`, `tasks score`, `tasks models` | The tasks, a score, the models ([Training](./training.md)) |
| `push`, `pull`, `share`, `store` | What went and came, the link, the store ([push, pull](#push-pull), [share](#share), [store](#store)) |

## demo

```sh
shadowlap demo [--keep <dir>]
```

Runs the whole loop on a refund agent, with no key and nothing to clone, as the
[quickstart](./quickstart.md#see-the-whole-loop-first) shows it. It needs git.

1. It makes a temporary folder a git repository, which it removes at the end.
2. It writes the agent there, the check its runs must pass, and a `shadowlap.config.json` naming the
   repairer.
3. It starts a scripted model on 127.0.0.1, which answers the agent in Anthropic's Messages API and
   the repairer in OpenAI's Chat Completions. The demo says it is scripted.
4. It runs `run`, `label`, `replay`, `blame`, `repair` and `fix apply` there, each printing as it
   does in a terminal. After blame, a line says how to read a probe's verdict from the probes it made.
5. It ends with how long that took, how many requests the scripted model answered, and where they
   went: the recordings, blame's attempts and repair's.

In a terminal, its own lines wrap at whole words to the terminal's width, as [blame's](#blame) do,
and each command it runs is shown as it is typed.

Your own model keys and endpoints are left out of its environment, and [telemetry](./telemetry.md) is
off for it.

`demo` takes one flag:

| Flag | What it does | Default |
| --- | --- | --- |
| `--keep <dir>` | Run in this folder, a new or an empty one, and keep it, to look around with `shadowlap dashboard` | A temporary folder, removed |

`demo` exits with:

| Status          | Meaning                                                            |
| --------------- | ------------------------------------------------------------------ |
| `0`             | Every step did what the demo expects                               |
| A step's status | A step that didn't, which it names                                 |
| `2`             | A `--keep` folder that isn't empty, or no git                      |
| `128 + n`       | A stop signal: Ctrl-C, SIGTERM, or the SIGHUP of a closed terminal |

A stop signal ends the demo once the command it runs then has ended, which a terminal's signal stops
too. It removes its folder and ends with 128 + the signal's number.

## run

```sh
shadowlap run [--summary-json <file>] [--guard warn|off] -- <command> [args...]
```

Records a run: it runs the command under Shadowlap and exits with the command's exit code.

```sh
shadowlap run -- node agent.js
shadowlap run --summary-json run.json -- python agent.py
```

Before the command starts, `run`:

- starts a sidecar;
- sets `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `GOOGLE_GEMINI_BASE_URL`, `SHADOWLAP_URL` and
  `SHADOWLAP_RUN_ID` for the child;
- preloads [in-process capture](./providers.md#in-process-capture), the network guard and
  [recorded user input](./sdk.md#what-a-person-types) into Node and Python children.

The run's status is `completed`, `failed` (a non-zero exit) or `crashed` (interrupted: Ctrl-C, or a
stop signal that reached Shadowlap or the agent).

`run` takes these flags:

| Flag | What it does | Default |
| --- | --- | --- |
| `--summary-json <file>` | Also write the run's summary as JSON to this file ([fields](#run-summary-as-json)) | — |
| `--guard warn\|off` | The [network guard](./how-it-works.md#the-network-guard) for connections that bypass Shadowlap | `warn` |

`run` exits with:

| Status | Meaning |
| --- | --- |
| The agent's | The agent's own exit code |
| `127` | The command isn't on the PATH, or can't start for another reason ([below](#when-the-command-never-starts)) |
| `128 + n` | A signal ended the agent: 130 for SIGINT, 129 for SIGHUP, 143 for SIGTERM |

On Windows, a command that is a batch file, such as `npm start` or `npx tsx agent.ts`, runs through
cmd.exe, its arguments passed on as given.

What the run did unrecorded is kept on it, for its page in the
[dashboard](./dashboard.md#what-a-runs-page-is-worked-out-from): the hosts the guard saw it reach
without Shadowlap, and the tools [`init`](#init) finds in the project with no declared effect that the
run never recorded. At its end, `run` names the tools the model called that the run recorded no call
of, which a replay runs for real ([details](./how-it-works.md#tools-shadowlap-did-not-record)).

### When the command never starts

- **Not on the PATH**: `run` (and `replay`) says so (`✗ pythn: command not found on PATH`). Where
  `python` is missing but `python3` is there, it gives the command with `python3`. It keeps no run and
  exits 127.
- **Can't start for another reason**: the same, with that reason in the system's own words: a path to
  a file that isn't there, or a program that is there but can't run.
- **Under `test` and `bisect`**: a golden whose command never started fails with the same words. One
  replayed in a working directory that doesn't exist (`--cwd`, or a folder a commit doesn't have yet)
  says so, rather than blaming the command.

A Node agent on a Node before 18.18 never starts either. That Node refuses the preload (`--import` in
`NODE_OPTIONS`) and exits 9 before any of the agent runs:

- `run` and `replay` then say the agent's Node is too old for Shadowlap's guard, which needs Node 18.18
  or later, and keep no run.
- `test` fails the golden with those words. `replay --repeat`, `blame`, `verify`, `repair` and
  `decisions` stop with them, exit status 2.

Where the agent prints straight to the terminal, as under `run` and `replay`, Shadowlap can't read
that refusal. So it asks the agent's Node again: the one the command names, else the `node` on its
PATH.

A Node that a launcher or a script picks, such as `npx node@18.17.0` or `volta run`, can't be asked.
An agent it starts that exits 9 before any call keeps its run. The summary adds that if Node printed
`--import= is not allowed in NODE_OPTIONS` above, the agent's Node is too old.

### Stopping a run

A stop signal reaches the agent once:

- **In a terminal**, the agent shares Shadowlap's process group, so the terminal's Ctrl-C reaches
  both, as it would reach the agent alone. The agent keeps the terminal to read from (`/dev/tty`
  included, as a password prompt opens it).
- **As a dashboard job**, it shares the job's process group, which the dashboard stops as a whole,
  and kills when it can't wait.
- **Elsewhere** (CI, a script), the agent leads a process group of its own. Shadowlap passes it each
  SIGINT, SIGTERM or SIGHUP it gets, once. An agent still running three seconds later is killed with
  its group, and a second signal kills it at once.

Closing the terminal (SIGHUP) ends the run as interrupted too, and kills an agent that ignores it. A
signal that comes while the run's [judge checks](./judges.md) are asked is kept for when they are
done; a second one ends the run as interrupted at once.

An agent a signal ended exits with 128 + its number: 130 for SIGINT, 129 for SIGHUP, 143 for SIGTERM.
`replay --repeat`, `test`, `blame`, `verify` and `decisions --from-code` stop their agents the same
way. An agent still running when Shadowlap itself exits is killed with its group.

### Run summary as JSON

`--summary-json` writes `{ "exitCode", "summary", "unrecordedTools" }`:

| Field | Meaning |
| --- | --- |
| `exitCode` | The agent's exit code |
| `summary` | The run's summary (below) |
| `unrecordedTools` | The tools the model called that the run never recorded: each `name`, `count`, `firstCallNo`, `effect`, `why` and `fix`, as [`show --json`](#show) lists them |

The summary has these fields:

| Field | Meaning |
| --- | --- |
| `runId`, `mode`, `status` | The run, its mode and its status |
| `total` | Calls |
| `byOrigin`, `byKind` | Calls per origin and per kind |
| `upstreamRequests` | Live calls that reached a provider |
| `injected` | Calls `--fail-at` answered |
| `refused` | Calls answered with why they weren't sent: an intervention that couldn't be applied, or a [placeholder key](./how-it-works.md#keys) a live call would carry |
| `imported` | Whether the run came from elsewhere: a pack someone recorded, or a capture |
| `tokensNotRespent` | Tokens the replayed calls didn't spend again |
| `cost` | `spent`, `saved` and `captured` in USD, and `unknownModels` with no price |
| `durationMs` | How long the run took, in milliseconds, once it has ended |
| `notReached` | Recorded calls the replay never made |
| `extraReads` | Clock, random and pure reads the recording held no counterpart for, answered live while the replay went on ([extra reads](./how-it-works.md#the-replay-state-machine)) |
| `warnings` | The run's warnings |
| `divergence` | The divergence report, or `null` |
| `judge` | With [judge checks](./judges.md): what the judge's calls did and cost (below) |

Every count and cost is the agent's. A run with judge checks has `judge` too: what the judge's calls
did and cost apart from them. It has `calls`, `replayed` from the recording, `live`, `upstreamRequests`,
`spent`, `saved`, `unknownModels`, and `notAsked`: kept for runs recorded when a call no one answered
was kept, and 0 since.

A replay whose every request matched but that stopped before its recording did has a divergence too,
of type `ended_early`, kept on the run like any other:

- `callNo`, `kind` and `name` are the first recorded model call, or call of a tool that isn't pure,
  it never made;
- `replayedBefore` is the calls it was served;
- `recorded` is the calls the recording holds.

## replay

```sh
shadowlap replay <run> [options] [-- <command> [args...]]
```

Replays a recorded run; forks at the first changed call. It re-runs the recorded command unless one
follows `--`.

```sh
shadowlap replay 01M2P9PVCP                    # replay as recorded
shadowlap replay 01M2P9PVCP --strict           # exit 1 if it diverges, for CI
shadowlap replay 01M2P9PVCP --fail-at 12=429   # make model call 12 fail with a 429
shadowlap replay 01M2P9PVCP -- node agent.js   # replay against your own command
```

A clean replay needs no real key. The agent gets a [placeholder key](./how-it-works.md#keys) for each
provider whose key the recording's environment held and this one has no credential for:

- A live call that would carry one, after a fork, is refused with one line:
  `a live call needs a real key: set ANTHROPIC_API_KEY, or keep the replay offline`.
- Whatever the agent signs in with itself (a key you set, one it loads from `.env`, a profile, a token
  provider, an instance role) is used as it is.

A run imported with `unpack`, or a replay of one, carries a command someone else recorded. `replay`
shows it and asks before running it. Without a terminal to ask on, it refuses: pass `--yes` once you
have read the command, or give your own after `--`.

These flags decide how the replay runs:

| Flag | What it does | Default |
| --- | --- | --- |
| `--strict` | Exit 1 if the replay diverges, or ends before its recording does (for CI) | — |
| `--writes block\|stub\|allow` | What `write` tools do after divergence | `block` |
| `--reads live\|replay` | What `read` tools do after divergence | `live` |
| `--live-tool <name>` | Force this tool live: its first call, and every call of it after a fork (repeatable). Use it after fixing a tool | — |
| `--live-input` | After the fork, ask for what a person types instead of serving the recorded answers in order ([recorded input](./sdk.md#what-a-person-types)) | — |
| `--expect <json\|@file>` | Checks the replay (each attempt, with `--repeat`) must pass besides exiting 0, as for `blame`: `'{"tools":{"send_email":0}}'` | The checks `shadowlap.config.json` gives the recording ([below](#checks-on-a-replay)) |
| `--watch` | Replay again whenever a file in the project changes (below). Ctrl-C to stop | — |
| `--summary-json <file>` | Also write the summary (with `--repeat`, every attempt and the report) as JSON to a file ([fields](#replay-summary-as-json)) | — |
| `--guard warn\|block\|off` | The [network guard](./how-it-works.md#the-network-guard) for connections that bypass Shadowlap. `run` accepts `warn\|off`; `test` defaults to `block` | `warn` |
| `--allow-unrecorded <names>` | Run these tools again for real, though the recording never recorded them: names separated by commas (repeatable; below) | — |
| `-y, --yes` | Run the recorded command of a run imported from a pack, or pulled from the [team store](./team.md), without asking | — |

These flags change what the replay does. [Interventions](./interventions.md) says what each one does
to the conversation prefix, and what each provider takes:

| Flag | What it does | Default |
| --- | --- | --- |
| `--diverge-at <call>` | Force call *n* live | — |
| `--fail-at <call>=<failure>` | Fail call *n* instead of serving it, so the agent's own error path runs (repeatable; below) | — |
| `--override <call>=<json\|@file>` | Substitute a recorded tool result; the run forks at the first model call that sees it (repeatable) | — |
| `--inject-result <call>=<text\|@file>` | Plant an instruction in what read tool call *n* returned, as an attacker would leave it; the rest of the result stays (repeatable; below) | — |
| `--inject <call>=<text>` | Add an instruction at model call *n*, and keep it in place in every later request of the conversation ([details](./interventions.md#inject-an-instruction)) | — |
| `--inject-as user\|system` | `user`: in the user turn the model answers next, on every provider. `system`: a system message after the conversation; refused on Gemini and Bedrock Converse | `user` |
| `--prompt-from <call>` | Apply your changed system prompt and tool definitions only from model call *n*: earlier model calls replay from the recording ([details](./interventions.md#apply-a-changed-prompt-from-a-later-call)) | — |
| `--set <call>:<key>=<value>` | Set a request field from model call *n* on, where the provider keeps it; a dotted key is a path (repeatable; below) | — |
| `--model <call>:<model>` | Switch the model from model call *n* on: in the body, or in the path on Gemini, Vertex AI, Bedrock and Azure | — |

These flags run the replay more than once:

| Flag | What it does | Default |
| --- | --- | --- |
| `--repeat <n>` | Run the replay *n* times and report how the attempts differ after the fork ([Repeating a fork](#repeating-a-fork)) | — |
| `--concurrency <n>` | With `--repeat`: attempts running at once | 1 |
| `--chaos` | Run the [error-path presets](#error-path-presets) on this run instead of one replay (below) | — |
| `--presets <list>`, `--chaos-tool <name>`, `--inconclusive fail\|warn` | With `--chaos`: as for [`test --chaos`](#test) | `--inconclusive`: `fail` |

More on some of them:

- **`--fail-at`**: a model call takes an HTTP status (`--fail-at 12=429`,
  [details](./interventions.md#inject-a-failure)). A tool call takes `timeout`, `error`,
  `error:<message>` or a status (`--fail-at 19=timeout`), and the tool does not run
  ([details](./interventions.md#fail-a-tool)).
- **`--inject-result`**: text that starts with `@` is written `@@…`
  ([details](./interventions.md#plant-an-instruction-in-a-tool-result)).
- **`--set`**: the field is where the provider keeps it: `temperature` is
  `generationConfig.temperature` on Gemini, and `inferenceConfig.temperature` on Bedrock Converse
  ([details](./interventions.md#patch-parameters)).
- **`--watch`**: what a replay writes itself (the agent's own files, the store, the `--summary-json`
  file) starts no other. A file that changes while a replay runs is taken for one of its writes, and
  the replay says so, so a save made then needs saving again.
- **`--allow-unrecorded`**: it is for tools that [write](./how-it-works.md#tools-shadowlap-did-not-record),
  or that nothing says what they do. Without it, a replay whose model called such a tool is refused
  before anything runs, exit status 2.
- **`--chaos`**: a fork for each preset, judged by `--expect`, or, for a golden's run, by its
  `chaos.expect` or the write limits of its `expect`. Writes are stubbed unless `--writes` is given,
  and `--summary-json` writes their report. It doesn't combine with the flags that change a replay:
  `--override`, `--fail-at`, `--inject-result`, `--inject`, `--set`, `--model`, `--prompt-from`,
  `--diverge-at`, `--live-tool`, `--repeat`, `--watch` and `--strict`.

A change the recorded request can't take (a system message on Gemini, a field Converse has no place
for, a write tool to plant in) is refused before anything runs, with the reason. An intervention the
replay never reached is named in its summary.

`replay` exits with the agent's status, except:

| Status | Meaning |
| --- | --- |
| `1` | With `--strict`, the replay diverged or ended early |
| `1` | A [check](#checks-on-a-replay) failed |
| `1` | Under `--guard block`, the [network guard](./how-it-works.md#the-network-guard) never watched the agent (below) |
| `2` | The run is still recording |
| `3` | The agent exited 0 and a check could not be decided |

Under `--guard block`, the guard never watched the agent when it made model or tool calls and either
no Shadowlap preload loaded in its processes, or one of them runs with no guard. The process with no
guard is the Claude Code CLI the Claude Agent SDK runs, while it can still reach something the guard
can't watch and `guard.accept` doesn't take it ([details](./frameworks.md#claude-agent-sdk)). Its summary then
reads `✗ Replay not watched`, never clean.

With `--repeat`, the status is:

- 0 only when every attempt asked for ran, exited 0, was watched by the guard under `--guard block`,
  and passed its checks;
- 3 when all that kept an attempt from passing is a check that could not be decided;
- 128 + n for a `--repeat` that a stop signal cut short, 130 for Ctrl-C;
- else 1. With `--strict`, it is 1 also when any attempt diverged or ended early.

A run still recording is refused, exit status 2, until it has ended: it has no end to replay to yet,
as the dashboard's Replay and Fork wait for it. One whose recording process was killed (see
[`gc`](#rm-gc)) replays as it is.

### What a replay keeps

The replay keeps the options that change what it does on its run: `--fail-at`, `--override`,
`--inject`, `--inject-result`, `--model`, `--set`, `--prompt-from`, `--diverge-at`, `--live-tool`, and
`--writes` or `--reads` when not the default. Its page in the
[dashboard](./dashboard.md#what-a-runs-page-is-worked-out-from) then names what made the fork, and the
fork menu can make it again.

The run keeps each flag exactly as given, an override's result included, beside a short form to show:

- an override read from a file is named by the file (`--override 16=@policy.json`);
- one given inline is named by its call;
- a long instruction is shortened.

A copy of the run (`pack`, `export html`) keeps only the short form, with the project's redaction
rules applied to it.

### Checks on a replay

A replay is judged by checks when it has them: `--expect`, or, without it, the `tests` entry of
`shadowlap.config.json` for the recording the run came from (the pack it was unpacked from, or the
golden `shadowlap test` replayed). The checks are those of an [outcome check](./ci.md#outcome-checks),
[`calls` and `when` rules](./checks.md) included.

- The replay exits 1 when a check fails, and 3 when the agent exited 0, none failed and one could not
  be decided.
- The checks are kept on the run, with the `--expect` they came from, so making the fork again from
  the fork menu judges it the same way.
- With `--repeat`, every attempt is judged. The report says in how many attempts each check failed,
  could not be decided (inconclusive) or did not apply:

```text
  Checks (--expect)
    ✗ send_email called 0 times: failed in 2 of 3 attempts (#1, #3)
```

The agent's output is captured, while still shown, only when a check reads it (`output`, or a judge
check of the output). A replay that plants text with `--inject-result` and has no checks says that
nothing judged whether the agent obeyed it.

A [judge check](./judges.md) is asked once the agent exits, before the replay's run ends. A clean
replay is answered from its recording, and a fork asks the judge live; either way the call is the
replay's own. Its line gives the verdict, the judge's reason and where it came from. Its entry in
`checks` has `status` (`passed`, `failed`, or `inconclusive` when it was not judged), `reason`,
`source` and `judge`.

### Repeating a fork

Everything after a fork is live, so a model may do something different each time. One good attempt
doesn't show that a change fixed the behavior. `--repeat n` runs the same replay *n* times, each
attempt its own run, and summarizes them:

```text
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

A path is the sequence of tool calls after the fork and what happened to each: blocked, stubbed,
overridden or an error.

- Tools called between the same two model calls match in any order, since agents often run them at
  once.
- Attempts with the same path are grouped, most common first.
- Arguments aren't part of a path. `shadowlap diff` compares two attempts in full, and the report
  names the pair to start with.
- The prefix before the fork is served from the recording, so it costs nothing however many attempts
  there are. If attempts fork at different calls, the report says the prefix isn't deterministic.
- An attempt that stopped before its recording did, with every request matching, forked nowhere but
  is no clean replay either. The first line counts those apart (`· 1 of 5 ended early, at call 7`),
  and each attempt in the JSON report has `endedEarly`: the first recorded call it never made, or
  `null`.

With `--concurrency`, attempts run at the same time through one sidecar, and each attempt's output is
printed whole when it finishes. `--strict` exits 1 if any attempt diverged or ended early. Otherwise
the exit status is as [above](#replay): 0 only when every attempt ran, exited 0, was
watched under `--guard block` and passed its [checks](#checks-on-a-replay), and 3 when all that kept
one from passing is a check that could not be decided.

### Replay summary as JSON

`--summary-json` writes what [`run`](#run-summary-as-json) writes, with these differences:

| Field | Meaning |
| --- | --- |
| `exitCode` | The agent's, or 1 where the guard never watched it under `--guard block` |
| `checks` | When the replay has checks: each check as it [came out](./checks.md#how-a-check-comes-out), with `status`, `ok`, `label` and `detail` |
| `unrecordedTools` | The tools this replay ran for real without recording them |

With `--repeat`, it writes `{ "attempts", "report" }`:

| Field | Meaning |
| --- | --- |
| `attempts` | Each attempt's `exitCode` (so counted), `summary`, `checks` and `unrecordedTools` |
| `report` | The report the terminal prints: `parentRunId`, `attempts`, `forkedAt`, `paths`, `tools`, `distinctFinalResponses`, `succeeded`, `spent`, `saved` and `tokensNotRespent` |

## calibrate

```sh
shadowlap calibrate [run] [--write] [--max-rounds <n>] [--json] [--guard <mode>] [--allow-unrecorded <names>] [-y]
```

Replays a recording offline, repeatedly, and proposes a normalizer for every value that differs
between two runs of the same code, until the replay is clean, trying up to `--max-rounds` replays.
It makes no model calls, and writes are blocked. See [Calibrate](./normalizers-and-redaction.md#calibrate).

Without a run named, it takes the recording the dashboard's [setup](./dashboard.md#setting-it-up) made
for this project. Else it takes the newest finished recording made here: one that completed or failed,
not one imported from a pack or a capture. When there is none, it asks you to record a run first.

Each round is printed as it ends. A recording that is already clean ends with "Nothing to add".
Afterwards, it removes the blobs its own replays left that nothing else uses, unless a run is
recording.

`calibrate` takes these flags:

| Flag | What it does | Default |
| --- | --- | --- |
| `--write` | Add the proposals to `shadowlap.config.json`, and say their numbers | — |
| `--max-rounds <n>` | How many replays to try first | 8 |
| `--json` | Print the result as JSON when calibration ends (below) | — |
| `--guard <mode>`, `--allow-unrecorded <names>`, `-y` | As for [`replay`](#replay) | `--guard`: `warn` |

`calibrate` exits with:

| Status | Meaning |
| --- | --- |
| `0` | The replay ends clean, with or without proposals |
| `1` | Calibration stops before it is clean |
| `2` | The run named is still recording, there is no recording to calibrate, or its model called an unrecorded tool that [writes](./how-it-works.md#tools-shadowlap-did-not-record) |

`--json` prints the result:

| Field | Meaning |
| --- | --- |
| `runId` | The recording calibrated |
| `source` | `given` when you named the run, `setup` for the setup's recording, `newest` when it picked the newest |
| `clean` | Whether the replay ended clean |
| `rounds` | Each round it ran: its divergence, and the normalizers it proposed |
| `normalizers` | The proposed normalizers, each with `why` it was proposed |
| `written` | Whether `--write` added any rule |
| `added` | The numbers of the rules it added; a proposal already in the file isn't counted |
| `stopped` | Why it stopped, when it isn't clean |

## mcp

```sh
shadowlap mcp [--effect <tool=effect>]... -- <server command>
shadowlap mcp --url <server> [--header "Name: value"]... [--allow-http] [--effect <tool=effect>]...
shadowlap mcp --url <server> --listen <address> [--header "Name: value"]... [--allow-http] [--effect <tool=effect>]...
```

A proxy for an MCP server. Put it in the client's server configuration in place of the server itself;
the client talks stdio to it. See [MCP servers](./mcp.md#served-over-http---listen).

- **The server**: it starts a local server from its command, or speaks Streamable HTTP to a remote
  one at `--url`, sending each `--header` with every request.
- **What it records**: `tools/call` is recorded, replayed, blocked or stubbed like an SDK tool call,
  so a remote write never runs again on replay unless the replay allows writes (`--writes allow`).
  Every other message passes through.
- **Effects**: they come from the server's tool annotations (`readOnlyHint` → `read`, otherwise
  `write`), overridden by `--effect` or `mcp.effects` in the config.
- **Its run**: the proxy finds its run even when the client starts it with a minimal environment.
  When it was started under Shadowlap but can't record, it refuses write tools rather than run them
  unrecorded.
- **On Windows**: a server command that is a batch file (`npx -y …`) runs through cmd.exe.

`mcp` takes these flags:

| Flag | What it does | Default |
| --- | --- | --- |
| `--url <server>` | Speak Streamable HTTP to a remote server at this endpoint | — |
| `--header <header>` | Send this header with every request to the `--url` server; `$VAR` or `${VAR}` is read from the environment (repeatable) | — |
| `--allow-http` | Send headers over plain http to a host other than this machine | Headers go over plain http only to this machine |
| `--effect <tool=effect>` | `pure`, `read` or `write` for a tool, overriding the server's annotations (repeatable) | The server's annotations |
| `--listen <address>` | Serve the `--url` server over Streamable HTTP at `http://<address>/mcp` (below) | Stdio |

With `--listen`, the proxy serves the `--url` server over HTTP instead, for a client that speaks
HTTP. It runs until stopped.

- It listens on a loopback address: `127.0.0.1:8931`, or a port alone.
- Each session goes in the server's own session id.
- It records into the run its command started. Started on its own, it records into the run of the
  Shadowlap command that started the session's client.
- It refuses writes in a session it finds no run for.

`mcp` exits with:

| Status       | Meaning                                                             |
| ------------ | ------------------------------------------------------------------- |
| The server's | In front of a command: the server's own status                      |
| `127`        | In front of a command: the server can't be started                  |
| `0`          | With `--url`: the client closed its end                             |
| `2`          | A flag, an address or a config to fix                               |
| `70`         | A bug                                                               |
| `128 + n`    | A stop signal, which a `--listen` proxy runs until (130 for Ctrl-C) |

## dashboard

```sh
shadowlap dashboard [run] [--call <n>] [--port 4777] [--no-open] [--read-only]
```

A local web UI over the store: runs and forks, a timeline of calls by origin, the conversation at any
call, playback of streamed responses, fork diffs, comparison, the activity feed, and replay and fork
actions. See [Dashboard](./dashboard.md).

It listens on 127.0.0.1, with a session token in the link it prints.

`dashboard` takes these flags:

| Flag            | What it does                                                    | Default |
| --------------- | --------------------------------------------------------------- | ------- |
| `--call <n>`    | With a run: open at this call                                   | —       |
| `--port <port>` | The port to listen on; `--port 0` asks for any free one (below) | 4777    |
| `--no-open`     | Print the link instead of opening a browser                     | —       |
| `--read-only`   | Show every page and change nothing (below)                      | —       |

A port that is taken, or that the system keeps for itself (a range Windows reserves), falls back to a
free one, and `--port 0` asks for any free one. Either way, the link names the port it got.

With `--read-only`, actions, labels, notes, uploads and deletes are refused, and the dashboard says
why. It needs a store to show, and never creates one.

## ui

```sh
shadowlap ui [run] [--call <n>]
```

Opens the [terminal UI](./tui.md). A fork opens at its divergence, unless `--call` names another
call.

`ui` takes one flag:

| Flag         | What it does                 | Default                    |
| ------------ | ---------------------------- | -------------------------- |
| `--call <n>` | With a run: select this call | The divergence, for a fork |

## show

```sh
shadowlap show <run> [--json] [--request <call>] [--response <call>]
```

Prints a run's timeline: one row per call, then the divergence report if the run forked.

- **Each row**: the call's kind, name, origin (`live`, `replayed`, `blocked`, `stubbed`,
  `overridden`), outcome, latency, and tokens or arguments.
- **Above the timeline**: the run's status, duration, upstream requests and what it spent. For a
  replay, what replaying didn't spend again (`$0.0075 not re-spent (8.1k input tokens)`).
- **Input tokens**, here and in each row, are everything the model read: uncached, written to the
  prompt cache and read from it, as `test`, `replay` and the dashboard count them.

`show` takes these flags:

| Flag                | What it does                          | Default |
| ------------------- | ------------------------------------- | ------- |
| `--json`            | Print the run as JSON (below)         | —       |
| `--request <call>`  | Print the stored request of call *n*  | —       |
| `--response <call>` | Print the stored response of call *n* | —       |

What else it shows:

- **An interrupted run**: a run stopped before it ended (Ctrl-C, a kill, a crash, or a recorder that
  went away) reads `interrupted`, as the dashboard says it. `--json` keeps the stored status, `crashed`
  or `running`.
- **Someone else's spend**: a teammate's run pulled from the [team store](./team.md) says who spent
  it where it was recorded (`≈$0.0030 spent by maya`). A run from a pack or a capture says what its
  traffic cost where it ran (`of traffic captured`).
- **Untrusted reads**: a run with [untrusted reads](./injection.md) names them above the timeline,
  each with where its mark came from (the first five, then how many more). It tags each one's row
  `untrusted`, as the dashboard's Calls view does.
- **Tools it never recorded**: a line names the tools its model called that the run recorded no call
  of (`not recorded: Bash (14 calls from #3, writes)`), which a replay runs for real
  ([details](./how-it-works.md#tools-shadowlap-did-not-record)).
- **Where blame lost it**: a run [blame](./blame.md) searched says where it was lost, as blame's report
  does: `blame: lost at model call #5 (high confidence), rescued by 01M5FAB2C1`, or
  `lost gradually, around model calls #17 and #18` when no one call lost it.

Untrusted reads are the reads of a tool that the config's `tools`, the SDK's `trust` or its MCP
server's `openWorldHint` marks untrusted, where `shadowlap injection` plants.

`--json` prints `{ "run", "summary", "calls", "untrusted", "unrecordedTools" }`, the object the
dashboard's Provenance tab copies:

| Field | Meaning |
| --- | --- |
| `run` | The run as stored (`runId`, `parentRunId`, `mode`, `status`, `divergence`, `command`, `codeVersion`, `startedAt`, `endedAt`, `meta`) |
| `summary` | Its summary, as [`run --summary-json`](#run-summary-as-json) writes it |
| `calls` | Every call as stored (`runId`, `callNo`, `kind`, `name`, `fingerprint`, `occurrence`, `origin`, `effect`, `requestRef`, `meta`, `at`, `end`, `attempts`) |
| `untrusted` | Its untrusted reads in call order, as the dashboard's `GET /api/injection/runs/:id` lists them (`callNo`, `name`, and `from`: `config`, `sdk` or `mcp`); empty if it has none |
| `unrecordedTools` | The tools its model called that the run never recorded (below); empty if it has none |

Each of the tools its model called that the run never recorded, `unrecordedTools`, has these fields:

| Field | Meaning |
| --- | --- |
| `name` | The tool's name, as the model called it |
| `count` | How often the model asked for it |
| `firstCallNo` | The model call that first did |
| `effect` | `write`, `read` or `unknown` |
| `why` | Why it has that effect, in a few words |
| `fix` | How to have it [recorded](./how-it-works.md#tools-shadowlap-did-not-record): `fence`, `fence-effects`, `mcp`, `none` or `wrap` |

## ls

```sh
shadowlap ls [--tree] [-n <limit>] [--label <label>] [--json]
```

Lists runs, newest first, with their labels.

`ls` takes these flags:

| Flag              | What it does                                            | Default |
| ----------------- | ------------------------------------------------------- | ------- |
| `--tree`          | Nest forks under their parents                          | —       |
| `-n, --limit <n>` | The most runs to list                                   | 50      |
| `--label <label>` | Keep runs with this label; repeat it to require several | —       |
| `--json`          | Print one object per run (below)                        | —       |

A run stopped before it ended, or left marked running by a recorder that went away, reads
`interrupted`, as the dashboard lists it. `--json` keeps the stored status.

`--json` prints one object per run: `runId`, `parentRunId`, `mode`, `status`, `calls`, `command`,
`codeVersion`, `startedAt`, `endedAt` and `labels`, and these:

| Field | Meaning |
| --- | --- |
| `forkedAt` | `{ callNo, type, kind, name, reason }` where the run forked, or `null` (below) |
| `hasCommand` | `false` for a run with no command of its own (below) |
| `imported` | `{ at, from }` for a run from a pack, a capture or the [team store](./team.md), or `null` |
| `partial` | The kinds of call a partial recording covers (`["api"]` for a capture), or `null` |
| `repeat` | `{ group, attempt, of }` for an attempt of `replay --repeat`, or `null` |
| `checks` | `{ passed, total }` for a run from `shadowlap test` with [outcome checks](./ci.md#outcome-checks), or `null` (below) |

- **`forkedAt`**: a replay that stopped before its recording did has `type` `ended_early`, at the
  first recorded call it never made. It lists as `ended early @n`, never as a clean replay.
- **`hasCommand`**: `false` for a run imported from a capture, recorded through [`serve`](#serve), or
  recorded by a test that gave no command (its command reads `<test>` and the test's name). It has no
  command, so replaying it needs yours after `--`.
- **`imported`**: for a run from the team store, `from` is the store's URL: `s3://…`, `gs://…`,
  `az://…` or `r2://…`.
- **`checks`**: `passed` counts only the checks that passed. When there are any, `inconclusive` and
  `notApplicable` count those that
  [could not be decided or did not apply](./checks.md#how-a-check-comes-out); the rest of `total`
  failed.

## search

```sh
shadowlap search refund policy             # every word must appear
shadowlap search '"refund policy"' --run 01M2P9PVCP -n 50 [--json]
```

Searches what runs recorded: prompts, model responses, tool arguments and tool results. Quoted words
must appear together.

`search` takes these flags:

| Flag              | What it does                       | Default |
| ----------------- | ---------------------------------- | ------- |
| `--run <run>`     | Search only this run               | —       |
| `-n, --limit <n>` | The most matches to print          | 20      |
| `--json`          | Print one object per match (below) | —       |

Each match names the run, the call and where the text was found. It ends with the
`shadowlap ui <run> --call <n>` that opens it.

- **Attempts come last**: matches in attempts (blame's probes, verify's attempts, `replay --repeat`'s),
  which repeat the run they came from word for word, come after those in the runs you made, as in the
  dashboard's search.
- **The index**: it is built the first time you search, and updated for runs that changed since. Each
  model call indexes only the turns it added to the conversation, so a long run is indexed once, not
  once per call.
- **A run still recording** is indexed from where the last search stopped, not from its first call
  again.

`search` exits 1 when nothing matches, as `grep` does.

`--json` prints one object per match:

| Field                             | Meaning                                       |
| --------------------------------- | --------------------------------------------- |
| `runId`, `callNo`, `kind`, `name` | The run, and the call the match is in         |
| `field`                           | `prompt`, `response`, `arguments` or `result` |
| `snippet`                         | The text around the match                     |
| `runStartedAt`                    | When the run started                          |

## diff

```sh
shadowlap diff <a> <b> [--json]
```

Compares two runs call by call, aligned by position. It exits 1 when the runs differ, like `diff`.

`diff` takes one flag:

| Flag     | What it does                         | Default |
| -------- | ------------------------------------ | ------- |
| `--json` | Print the comparison as JSON (below) | —       |

It prints, in order:

1. **What differs about the runs as a whole**: their system prompts, the tools they offered (added,
   removed, or with a changed definition), the models they used and their code versions.
2. **How many leading calls are identical** in request and response.
3. **What a replay's flag did**, when one run is the other's replay and the flag that made it changed
   an answer rather than a request (`--fail-at`, `--override`, `--inject-result`, `--diverge-at`). It
   says what each run got there: `⑂ #19 got HTTP 529 instead of an answer, by --fail-at 19=529`, or
   `⑂ #16 lookup_policy returned {…} instead of {…}`.
4. **The first call whose request differs**, with a structural diff and normalizer hints, and how
   many later requests differ too.
5. **Every call whose request was the same but whose response was not**, such as a live re-run where
   the model answered differently (both answers are shown), or a tool that returned something else. A
   call answered the same way in another response, where only its id or token counts differ, is
   counted apart.

Two calls make the same request when a replay served one from the other, or when what each sent is
the same, however each run fingerprinted it. What each sent covers:

- its kind and name;
- the headers and query that make a model call the call it is;
- its body, each number as it was sent, so two ids past 2^53 a double rounds alike differ.

A run recorded by an earlier Shadowlap compares with its replay as the replay matched it. Its model
requests, stored with their numbers rounded, compare rounded on both sides.

`--json` prints the comparison:

| Field | Meaning |
| --- | --- |
| `a`, `b` | Each run's `runId` and `calls` |
| `identicalPrefix`, `prefix` | How many leading calls are identical, and those calls (the first 500) |
| `firstRequestDifference` | `callNo`, `kind`, `name` and the structural `diff`, or `null` |
| `responseDifferences` | Each with `sameAnswer` when only the response differed, not its answer, and `by`, the flag, for the call a replay's flag answered |
| `after` | Each run's course from the first difference on |
| `onlyInA`, `onlyInB` | How many calls each run made beyond the other's end, when no request differed |
| `changes` | `systemPrompt`, each run's system prompts by their hashes in `systems`, `tools`, `models`, `code` |
| `intervention` | What a replay's flag changed (below), or `null` |

`intervention` is set when one run is the other's replay and its flag changed an answer:

- `run`: `a` or `b`, the one the flag made;
- `kind`: `fail`, `override`, `answer`, `plant` or `resample`;
- `flag`, `callNo` and `name`;
- `before` and `after`: what each run got there;
- `words`.

## label, note

```sh
shadowlap label <run> bug refund-flow      # add labels
shadowlap label <run> bug --remove         # remove one
shadowlap label <run> [--json]             # print them
shadowlap note <run> "The model skipped the refund check." [--call <n>]
```

What people know about a run that the recording can't. Both travel in packs.

- **A label** says what the run is, so it can be found (`ls --label`, the dashboard's search) and
  exported as part of a dataset (`export dataset --label good`). A label is up to 40 letters, digits,
  spaces and `_ . : / -`.
- **A note** says why, on the run or on one call. `show` prints them, and the dashboard shows a
  call's notes in its details.

`label` and `note` take these flags:

| Flag         | What it does                                        | Default |
| ------------ | --------------------------------------------------- | ------- |
| `--remove`   | `label`: remove these labels instead of adding them | —       |
| `--json`     | `label`: print the labels as JSON (below)           | —       |
| `--call <n>` | `note`: the call the note is about                  | The run |

`label --json` prints `{ runId, labels }`, with the labels as they are after the change.

## blame

```sh
shadowlap blame <run> [options] [-- <command> [args...]]
```

Finds the model call where a failed run was lost: the last one whose answer, asked again, lets the run
pass. [Blame](./blame.md) explains the search, the report and the limits.

```sh
shadowlap blame 01M2P9PVCP --expect '{"tools":{"send_email":0}}'
```

How it searches:

1. It replays the run as recorded, to confirm the failure.
2. It probes model calls with forks that replay everything before the probed call for free.
3. It binary-searches for the boundary.

Each blame is kept with the [fix](#fix) it opens or joins, by the run's labels, else its check.

`blame` takes these flags:

| Flag | What it does | Default |
| --- | --- | --- |
| `--expect <json\|@file>` | What a passing run must do besides exiting 0: the `expect` object of an [outcome check](./ci.md#outcome-checks), such as `'{"tools":{"send_email":0}}'` | — |
| `--gate <json\|@file>` | How a probe decides, after each attempt ([gating](./gating.md#verify-and-blame); below). Give any of the four figures | `{"good":0.6,"bad":0.1,"risk":0.05,"max":20}` |
| `--attempts <n>` | A fixed count instead of the gate: attempts per probed call | 5 with `--passes` alone |
| `--passes <n>` | With a fixed count: how many passing make a rescue | 2, or 1 with one attempt |
| `--model <model>` | Rescue with this model from the probed call on, instead of asking the recorded one again | — |
| `--set <key=value>` | Set a request field from the probed call on, such as `temperature=1` (repeatable) | — |
| `--scope <name>` | Probe only model calls made in this [scope](./sdk.md#scopes): the agent's, and not a simulated user's | — |
| `--scan <n>` | Model calls past the boundary to probe too, in case rescue works again after it | 2 |
| `--writes stub\|block` | What write tools do after the fork; `allow` is not accepted (below) | `stub` |
| `--reads live\|replay` | What read tools do after the fork | `live` |
| `--concurrency <n>` | Attempts of one probe running at once (below) | 1 |
| `--budget <usd>` | Start no attempt once this much is spent on live model calls | — |
| `--timeout <seconds>` | Stop an attempt after this long, and count it as failed | — |
| `--json` | Print the report as JSON on stdout ([fields](./blame.md#json)) | — |
| `--guard`, `--allow-unrecorded`, `-y` | As for [`replay`](#replay) | `--guard`: `warn` |

More on some of them:

- **`--gate`**: a gate that tells a re-asked call that passes `good` of the time or more (a rescue)
  from one that passes `bad` or less (lost), up to `max` attempts. `risk` is the whole search's,
  spread over the most probes it can make, so each probe runs at its share with its `max` deepened to
  match ([the search](./blame.md#how-it-works)).
- **The default gate**: for a search of 5 to 10 probes, three straight passes rescue and six or seven
  straight failures lose.
- **A probe's verdict** shows its tally and its bound at its own confidence, under the rule, which is
  stated once: `rescued · 5 of 10 · rate >= 0.10 (99.1%)` under
  `gate: rescue at 60%+, lost at 10%-, <= 5% risk, up to 32 attempts`, in a search of 6 probes.
- **`--writes`**: a write the recording made, with the same arguments, gets what it got then, an
  error included.
- **`--concurrency`**: the probe decides on its attempts in the order they started, and its first
  verdict stands. One starts only while fewer than *n* have started that the probe hasn't counted, so
  at most *n* − 1 run past the attempt that decides.

Its progress goes to stderr:

- **In a terminal**, a probe's attempts fold into one line that counts them as they come, and the
  probe's verdict then takes its place. The pairs of a pinned call's check fold into one line that
  counts each call's attempts (`3 pairs: #5 3 passed · #6 1 passed, 2 failed`).
- **With `-v`, or anywhere else** (a CI log, a file, the dashboard), every attempt keeps its line,
  with its run id.

In a terminal, a line of prose wider than the terminal wraps at whole words, before it starts, as it
goes and in its report. Each line it wraps to is indented as the first, past a mark that leads it
(`!`, `✗`), or under the text of a row. A command, or a flag with its value, stays in one piece. The
lines that give commands or paths, and the rows of its tallies, stay whole. Written to a pipe or a
file, each line stays whole.

Verify and repair print theirs the same way.

`blame` exits with:

| Status    | Meaning                                                                           |
| --------- | --------------------------------------------------------------------------------- |
| `0`       | The search reached a verdict: a blamed call, or no call that rescues the run      |
| `1`       | It refuses what it saw: the run passes its oracle, or does not replay as recorded |
| `2`       | It can't start (below)                                                            |
| `3`       | It stopped before a verdict (below)                                               |
| `128 + n` | A stop signal; 130 for Ctrl-C                                                     |

It can't start, exit status 2, for:

- a run with no model call to probe;
- a run that fails only a cost check a model with no price keeps from being judged;
- an agent on a Node too old for the guard;
- a run whose model called a tool it never recorded that
  [writes](./how-it-works.md#tools-shadowlap-did-not-record).

It stops before a verdict, exit status 3, when:

- the budget is spent, or the provider unavailable;
- what the replay as recorded showed could not be decided;
- its first probe could not tell a rescue from a loss (*Inconclusive at the first model call*).

## verify

```sh
shadowlap verify --fixes <run...> [--holdout <run...>] [--keeps <run...>] [options] [-- <command> [args...]]
```

Checks a change before it ships. [Verify](./verify.md) explains the roles, the report and the
warnings.

```sh
shadowlap verify --fixes label:bug --keeps label:good
```

It replays, under the code in the working directory:

- **failing runs**, which the change must fix;
- **good runs**, which it must not break.

It accepts the change only when every failing run passes its gate and every good run is kept: not
worse, by the margin or more, than the same run under the code before the change, attempt for attempt.
Runs are ids, unique prefixes or `label:<name>`. A replay that forks nowhere settles its run in one
free attempt.

`verify` takes these flags:

| Flag | What it does | Default |
| --- | --- | --- |
| `--fixes <run...>` | Failing runs the change was written to fix | — |
| `--holdout <run...>` | Failing runs of the same kind the change was not written against | — |
| `--keeps <run...>` | Runs that passed and must not get worse, each kept against its own baseline, such as `label:good` | — |
| `--expect <json\|@file>` | What a passing run must do besides exiting 0, as for [`blame`](#blame) | — |
| `--gate <json\|@file>` | How a run decides, after each attempt where its replay forks ([gating](./gating.md); below). Give any of the four figures | `{"good":0.9,"bad":0.7,"risk":0.05,"max":80}` |
| `--attempts <n>` | A fixed count instead of the gate: attempts per run where the replay forks | 5 with `--passes` alone |
| `--passes <n>` | With a fixed count: how many must pass | 80% rounded up, 4 of 5 |
| `--model <model>`, `--set <key=value>` | The change is a request field, set from each run's first model call | — |
| `--from <model>` | With `--model` or `--set`: change only the model calls made with this model, from the first of them on (repeatable; below) | — |
| `--live-tool <name>` | The change is in this tool: run it live, its first call and every call of it after a fork (repeatable) | — |
| `--writes stub\|block`, `--reads live\|replay` | As for [`blame`](#blame) | `stub`, `live` |
| `--concurrency <n>` | Runs verified at once | 1 |
| `--budget <usd>`, `--timeout <seconds>` | As for [`blame`](#blame) | — |
| `--fail-fast` | Start nothing more once a run has failed | — |
| `--margin <share>` | A good run that forks is kept unless its pass rate drops this much or more below its baseline's, at the gate's risk | `verify.margin` in `shadowlap.config.json`, else 0.1: 10 points |
| `--baseline paired\|history` | What a good run is compared with (below) | `verify.baseline`, else `paired` |
| `--base <rev>` | With a paired baseline: the commit before the change, checked out on its own for the baseline's attempts | HEAD, when the working tree has a change |
| `--build <command>` | With a paired baseline at a commit: build its checkout before its attempts, such as `"npm run build"` | — |
| `--json` | Print the report as JSON on stdout ([fields](./verify.md#json)) | — |
| `--guard`, `--allow-unrecorded`, `-y` | As for [`replay`](#replay) | `--guard`: `warn` |

More on some of them:

- **`--gate`**: a gate that tells a run that passes `good` of the time or more from one that passes
  `bad` or less, each verdict wrong at most `risk` of the time at those two rates, up to `max`
  attempts. With the default, a run that always passes is accepted after 12 attempts, and one that
  always fails rejected after 3.
- **`--from`**: such as the agent's model calls, and not a simulated user's or a sub-agent's on
  another model. `decisions --then-verify` and `migrate` pass the models they switched from.
- **`--margin`, `--baseline`**: [good runs](./verify.md#good-runs-against-their-own-baseline) are
  kept against their own baseline. `paired` is the same run under the code before the change, each
  attempt paired with one of the change's. `history` is its golden's test history.

`verify` exits with:

| Status | Meaning |
| --- | --- |
| `0` | The change is accepted |
| `1` | The change is rejected |
| `2` | A run's model called a tool the run never recorded that [writes](./how-it-works.md#tools-shadowlap-did-not-record), before anything runs |
| `3` | The verification did not finish: a run's gate or baseline inconclusive, the budget spent, the provider unavailable |
| `128 + n` | A stop signal, whenever it comes, the verdict reached or not |

The verdict is kept with the [fix](#fix) of its failing runs, whatever it is. An accepted one turns
the fix verified when it [counts](./verify.md#verdicts-are-kept) there: it checked the fix's check on
a run that failed it.

## repair

```sh
shadowlap repair --fixes <run...> [--holdout <run...>] [--keeps <run...>] [options] [-- <command> [args...]]
```

Fixes failing runs. [Repair](./repair.md) explains the loop and the safeguards.

```sh
shadowlap repair --fixes label:bug --keeps label:good --repairer anthropic
```

1. It blames each failing run.
2. It asks a model you choose (`--repairer`, or `repair.repairer` in the config) to rewrite the system
   prompt or a tool description. Rewrites that name a detail of the failing runs, or add a placeholder
   the agent would fill in, are set aside before anything runs.
3. It keeps the smallest rewrite `verify` accepts twice, the second time with fresh attempts: on the
   failing runs, the runs held out from the repairer (`--holdout`), and the good runs.
4. The fix comes out as a patch, a pull request body and a recording of each fixed run.

Each candidate is verified in a temporary git worktree, never in the working tree. A good run is
verified against the same run under the code without the candidate, in another worktree.

`repair` takes these flags:

| Flag | What it does | Default |
| --- | --- | --- |
| `--fixes <run...>` | The failing runs | — |
| `--holdout <run...>` | The failing runs kept from the repairer | Every other `--fixes` run, when there are two or more |
| `--keeps <run...>` | The runs that must not get worse (below) | — |
| `--expect <json\|@file>` | What a passing run must do besides exiting 0 | — |
| `--repairer <provider:model>` | The model that proposes fixes (below) | `repair.repairer` in the config |
| `--repairer-timeout <seconds>` | Give up on the repairer when it hasn't answered after this long | `repair.timeout` in the config, else 600 |
| `--candidates <n>` | Rewrites to ask for, and the most it tries | 3 |
| `--stronger <model>` | When the recorded model can't be rescued, rescue with this one and try switching to it, before asking the repairer | — |
| `--scope <name>`, `--set <key=value>` | As for [`blame`](#blame): which calls to probe, and what probes change, such as `temperature=1` | — |
| `--gate <json\|@file>` | The gate each candidate's runs are verified by, as for [`verify`](#verify) | `{"good":0.9,"bad":0.7,"risk":0.05,"max":80}` |
| `--attempts <n>`, `--passes <n>` | A fixed count instead of the gate, as for [`verify`](#verify) | — |
| `--max-growth <percent>` | Reject a fix that grows input tokens per run by more than this, before verify runs it when its rewrite alone does | 25 |
| `--build <command>` | Build the agent in each candidate's worktree and in its baseline's, and in the working tree after `--apply` | — |
| `--apply` | Leave the accepted fix in the working tree | — |
| `--branch <name>` | Commit it to a branch it makes, without checking anything out | — |
| `--pr` | With `--branch`: push it and open a pull request with `gh` | — |
| `--goldens <dir>` | With `--apply` or `--branch`: put the recordings of the fixed runs in this directory too; with `--branch`, one inside the repository | — |
| `--budget <usd>` | Stop once this much is spent on blame, the repairer, verification and judge checks (below) | — |
| `--writes`, `--reads`, `--concurrency`, `--timeout`, `--guard`, `--allow-unrecorded`, `-y` | As for [`verify`](#verify) | — |
| `--json` | Print the report as JSON on stdout ([fields](./repair.md#json)) | — |

More on some of them:

- **`--keeps`**: a good run that forks is kept unless it drops 10+ points below its baseline, the same
  run on the code without the candidate, attempt for attempt, as [verify](#verify) keeps one. Its
  verdict bounds the drop as verify's does (`drop <= 0.10 (95%)`).
- **`--repairer`**: `anthropic` (Claude Opus 5.5), `anthropic:<model>`, `openai:<model>`, or
  `claude-code[:<model>]` to run your own Claude Code (2.1.248 or later) in print mode, restricted: no
  tools, no MCP server, none of your settings ([details](./repair.md)).
- **`--budget`**: the repairer is asked only when what is left covers the most asking it could cost.

`repair` exits with:

| Status | Meaning |
| --- | --- |
| `0` | A candidate is accepted, and handed over as asked |
| `1` | None is accepted, a repairer that could not be asked among them, or the hand-over fails (below) |
| `2` | It can't start (below) |
| `3` | It stopped before a verdict: the budget spent, too little of it left to ask the repairer, or the provider unavailable |
| `128 + n` | A stop signal, whenever it comes, the verdict reached or not |

A branch it can't make (a name git refuses, or one that exists) is found at the hand-over: that
fails the hand-over, and the repair is kept.

It can't start, exit status 2:

- outside a git repository;
- with another repair running in the folder;
- with `--goldens` outside the repository, with `--branch`;
- for an agent on a Node too old for the guard;
- for a run whose model called a tool it never recorded that
  [writes](./how-it-works.md#tools-shadowlap-did-not-record).

The repair is kept with the [fix](#fix) its blames opened or joined, even when the hand-over failed.
When a candidate is accepted under the fix's check, the fix turns verified. When none is, the fix stays
open, with every candidate tried and why it was dropped.

## fix

```sh
shadowlap fix ls [--status open|verified|applied] [--json]
shadowlap fix show <fix> [--json]
shadowlap fix title <fix> <title...>
shadowlap fix apply <fix> [--goldens <dir>] [--no-test] [--build <command>] [--json]
shadowlap fix pr <fix> [<url>] [--json]
```

A fix is one failure, from the blame that reproduced it to a change that held.

- **Where fixes come from**: a [blame](./blame.md#fixes) opens one or joins one, by the run's labels,
  else its check. [Verify](./verify.md#verdicts-are-kept) and
  [repair](./repair.md#the-fix-it-reports-to) report to the fix of the runs they were given. Their
  verdict counts for it only when it checked the fix's check on a run that failed it.
- **Fix ids** look like `fx-01M3RZ4XKN…`. Any unique prefix works, with or without `fx-`, and the list
  shows the first ten characters.
- **Activity**: blame, repair, verify and apply each log an activity event in the store
  (`blame.done`, `repair.accepted`, `repair.empty`, `verify.accepted`, `verify.rejected`,
  `fix.applied`).

Its subcommands take these flags:

| Flag                | What it does                                                              | Default   |
| ------------------- | ------------------------------------------------------------------------- | --------- |
| `--status <status>` | `fix ls`: only open, verified (applied ones too) or applied fixes         | —         |
| `--goldens <dir>`   | `fix apply`: where the recordings go                                      | `goldens` |
| `--no-test`         | `fix apply`: copy the recordings without running `shadowlap test` on them | —         |
| `--build <command>` | `fix apply`: rebuild the agent after the patch, before the test           | —         |
| `--json`            | Print it as JSON: the dashboard's read model of Fixes (below)             | —         |

With `--json`, each subcommand prints:

| Subcommand | `--json` prints |
| --- | --- |
| `fix ls` | `{ fixes, counts }` ([fields](#fix-ls)) |
| `fix show` | The fix, with its three steps in full ([fields](#fix-show)) |
| `fix apply` | What it did ([fields](#fix-apply)) |
| `fix pr` | `{ fixId, pr: { url, number, state, at } }` ([below](#fix-pr)) |
| An id that matches no fix, or several | `{ "status": "error", "error": { "reason": "unknown" \| "ambiguous", "message" } }`, with the `fixId` given; exit status 2 |
| An error in `fix pr` or `fix apply` | `{ fixId, status, error }`, with `status` `error` |

### `fix ls`

Lists fixes, the most recently opened first. Each fix takes up to three lines:

1. Its status (`open`, `verified`, `applied`), id, title, label, failing runs, and how far each step
   got (*lost at #5 · prompt change · 3 fixed · 1 kept*).
2. What its failing runs did and the check they must meet
   (*failed: send_email called twice, not once · must: send_email called once*), where the fix came
   from (*from CI · PR #138*) and when it was opened.
3. A line that says so, when an applied fix doesn't hold.

What its failing runs did is the title blame gave the fix when it opened it, so the second line names
it only once someone renames the fix.

`fix ls --json` prints `{ fixes, counts }`: each fix as its row in the list, and the `counts` of `all`,
`open` and `verified` fixes, applied ones counted as verified. Each row has these fields:

| Field | Meaning |
| --- | --- |
| `fixId`, `status`, `title`, `label`, `labels`, `check` | The fix, as the list shows it |
| `href` | Where the dashboard shows it |
| `failed` | What its failing runs did (below) |
| `failing`, `good` | How many runs are failing, and how many good |
| `steps`, `source` | Its steps, and where it came from |
| `openedAt`, `verifiedAt`, `appliedAt` | When it was opened, verified and applied: epoch milliseconds, or `null` |
| `broken` | Why it is broken |
| `attempts`, `spent` | The attempts, and the USD spent, behind it |

`failed` is in the words blame titled the fix with when it opened it, which a title of someone's own
no longer says. For a fix opened on another machine, it is the first failure its blame recorded. It is
`null` when no blame recorded one.

### `fix show`

Prints a fix: what its failing runs did and the check they must meet, as `fix ls` says them, and its
three steps.

1. **Blame**: where the run was lost, and the probes that found it.
2. **Repair**: the change, the candidates tried and why each was dropped, who proposed them or why no
   repairer did (*not fixed · the repairer could not be asked: claude was not found*), and the repair's
   warnings.
3. **Verify**: every verdict, named by what changed (a repair's candidate, the request fields it set,
   or the code version) and headed by the runs it checked, with each run's role and outcome. One that
   doesn't count for the fix says why in its heading.

It ends with what to do next. It says when the repair it suggests would end *No fix to try* without
running the agent, and why (the blames it would reuse rescued no failing run), or couldn't ask its
repairer from here (`claude` isn't on the PATH).

`fix show --json` has the three steps in full:

| Field | Meaning |
| --- | --- |
| `fixId`, `href`, `failing`, `good`, `openedAt`, `verifiedAt`, `appliedAt` | As in [`fix ls`](#fix-ls) |
| `openedBy` | Who opened it |
| `status`, `title`, `label`, `labels`, `check`, `failed`, `oracle`, `expect`, `source` | The fix (below) |
| `broken` | For an applied fix that doesn't hold, why: its test failed, or a verify rejected it after it was applied |
| `failingRuns`, `goodRuns` | The runs, each with `runId`, `exists` (false once deleted from the store), `status` and `labels` |
| `steps` | Blame, repair and verify (below) |
| `blame`, `repair`, `verify` | Each step in full (below) |
| `blames`, `repairs` | Every blame and repair behind the fix, newest first (below) |
| `defaultStep`, `defaultVerify` | The step the dashboard opens at, and the verdict it shows first: the newest that counts |
| `attempts`, `spent`, `upstreamRequests` | What everything behind the fix took: the attempts that ran live, and what they and the repairer cost |
| `actions` | What can be done next (below) |
| `commands` | The `blame`, `repair` and `verify` commands to run it again |
| `repairer` | The repairer the config names (below) |
| `applied` | Once applied, how: `patch`, `repairId`, the `goldens` copied, `tests`, `by`, `via` |

The fix's own fields:

- `label` is the one most of its failing runs carry, and `labels` all it groups runs by.
- `check` is in words, and `failed` is what its failing runs did (as `fix ls` has it).
- `oracle` is the conditions a verdict must check to count. `expect` is the `--expect` JSON (null for
  the exit code alone).
- `source` says where it came from, such as `from CI · PR #138`.

`steps` holds blame, repair and verify, each with `state` (`done`, `todo`, or `no` for a verify that
only rejected), a `title`, a `meta` line and a `short` form. Only verdicts that count move the verify
step.

`blame` has:

- the call where the run was lost (`lostAt`, model call `step` of `steps`), `confidence`, the
  `boundary` sentence and both `answers`;
- `probes` with their verdicts, and the attempts per probe (`bundles`);
- every call of the run, with whether it is in the blame's scope (`callRow`);
- `cost` and `command`.

`repair` has:

- the `change`, with the text it `added`; the result per role (`roles`); and whether its verification
  `counts`;
- who proposed it (`repairer`), or why no repairer did (`noRepairer`: its `text`, and the `warning`
  that says what to do);
- where each run was `lost`, and the `diagnosis`;
- every candidate, with its `verdict` (`accepted`, `rejected`, `set aside`, `not tried`,
  `build failed`, `unsettled`) and `why`;
- the `files` handed over, and the pull request body (`prBody`);
- what each stage `cost`, and how many `attempts` it ran: the probes of the blames it ran, and every
  candidate's verification;
- `command` and `warnings`.

`verify` has one entry per change verified, newest first, with:

- its `verdict`, and whether it `counts`;
- the change it checked, named by what changed (`code`: a repair's candidate, the request fields it set
  and from which call, or the code version; `label` as the dashboard's switch shows it);
- its `headline`: by the runs it checked, or, for one that doesn't count, why;
- a `note` when it was rejected after the fix was applied;
- `oracle`;
- each run's `role`, `attempts`, `outcome` and where it went (`note`), and the token and cost changes
  per run;
- what it took to find out;
- its `reasons`, with those that say a run is inconclusive or not settled, rather than that the change
  failed it, in `unsettled`.

`actions` says what can be done next:

- **`repair`**, for an open fix: `noFix` says why it would end *No fix to try* without running the
  agent, or is `null`.
- **`apply`**, for a verified or applied one: `kind` is `patch`, or `mark` when there is no patch
  (below).
- **`applied`**, once it is applied.

`apply` has:

- `kind`, and the `gitApply` command;
- `pending`, saying what applying left undone;
- every file the patch changes in `files`, the patch itself in `diff`, and where it is kept in
  `patchFile`;
- `inTree` when it is in the working tree already, which applying only marks;
- how many recordings applying copies into the goldens folder, in `goldens`;
- the request fields a change with no patch set, in `change`;
- `refused`, saying why `fix apply` won't apply it, when the patch is more than the change its repair
  verified, or a teammate's is no rewrite a repair makes in this working tree. `gitApply` is `null`
  then, and once the patch is in.

`blames` lists every blame (`blameId`, `runId`, `at`, `outcome`, `lostAt`, `confidence`), and
`repairs` every repair (`repairId`, `at`, `outcome`, `accepted`, `title`), newest first.

`repairer` has its `name`, whether it is `configured`, and, on an open fix, the `problem` that keeps it
from being asked here (such as `claude` not on the PATH), or `null`.

### `fix title`

Replaces the title derived from the check with one of your own. Blames that join the fix later keep
it. With a team store, the latest rename on any machine is the one every machine keeps.

### `fix pr`

Records the pull request opened for a fix, given its `https://` link. `repair --pr` and CI's
[fix on failure](./ci.md#fix-on-failure) record theirs, so the list says where the fix went
(*from CI · PR #138*).

With no link, it reads where the recorded pull request stands from GitHub, with `gh pr view`
(installed and signed in), and records it: *open*, *merged* or *closed*. When `gh` can't say, or isn't
asked, the state stays as recorded and the line says why. The [dashboard](./dashboard.md) reads it the
same way, in the background, while Fixes is open.

Only a pull request on github.com, on the host `GH_HOST` names, or on the host of the project's
`origin` remote is read. A fix pulled from the team store can name any address, and `gh` would send
that host a token. A token for a GitHub server of your own only ever goes to the host `GH_HOST` names.

`fix pr --json` prints `{ fixId, pr: { url, number, state, at } }`, with a `note` saying why when the
state is as recorded because GitHub wasn't asked or couldn't say.

### `fix apply`

Hands a verified fix over. Run it in the folder the repair ran in, where its directory under
`.shadowlap/repairs/` is.

1. It runs `git apply` on the accepted repair's `fix.patch`.
2. It copies the recordings the fixed code made into the goldens folder.
3. It runs [`shadowlap test`](#test) on them, and marks the fix applied.
4. It replays the project's other goldens, and names each that diverges on what the patch changed
   (below).

`fix apply` exits with:

| Status | Meaning |
| --- | --- |
| `1` | It refuses the patch: not the change its repair verified, a file it may not write through, or `fix.patch` changed since |
| `1` | The patch does not apply, or the test fails |
| `2` | The fix is still open (nothing verified to apply), or it runs outside the repository and folder the repair ran in |

A patch that applied stays applied.

**The project's other goldens.** Then `fix apply` replays the project's other goldens offline, in a
store of their own that nothing keeps. A prompt or a tool description goes into every request, so they
can diverge on what the patch changed:

- It names each that diverges on what the patch changed: a request field that holds text the patch
  added, or lost text it removed. It prints the command that re-records them,
  `shadowlap test <goldens> --update`.
- It leaves out those from a pack the repository doesn't track, recorded elsewhere, whose command runs
  only with a yes, and names them.
- A golden that may fork is named only when it forks before its task's takeover, as `--update`
  re-records it then.
- `--no-test` skips this too.

**A teammate's repair**, from the [team store](./team.md), left its recordings on their machine.
`fix apply` puts the patch in, says so in one line, and leaves nothing to finish. Nothing here runs the
code that patch put in: no `--build`, test or replay of the other goldens. It says to read the change
(`git diff -- <file>`) and then run `shadowlap test`.

**What the patch may change.** Before anything goes in, the patch is checked against the repair it came
with. It has to be the rewrite of the accepted candidate, to that candidate's file alone, changed in
place: no file made, deleted, renamed or copied, and no mode or binary change. It may never touch:

- a file of a recording: a pack's `run.json`, which holds the command a replay runs, its `calls.jsonl`
  and blobs, or anything in `__recordings__`;
- `shadowlap.config.json` or the `.shadowlap` folder;
- a dot-file or a file in a dot-folder, such as a workflow under `.github` or Claude Code's
  `.claude/settings.json`, another file that runs, such as a `Dockerfile` or a script, or one a repair
  rewrites no text in, such as Go source.

A repair rewrites the text the agent sends the model where its source holds it, and never reads those.
A patch that is anything more is refused, and nothing is changed. So is one to a file git ignores,
whose change neither `git status` nor `git diff` would show, or to a file reached through a link to a
folder, which `git apply` refuses too.

**A teammate's patch**, from a pull, is held to a repair's own rewrites in your working tree. The text
it rewrites is read where the patch goes. It has to be inside one string of JavaScript, TypeScript or
Python source, a string value of YAML, JSON or TOML that doesn't run, or a Markdown, plain text, prompt
or Jinja file. It holds each placeholder whole, and its rewrite has to be one a repair would try. See [where an anchor goes](./repair.md#where-an-anchor-goes)
and [the team store](./team.md#a-teammates-patch-is-held-to-a-repairs-rewrites).

**Line endings.** The patch goes in on the file's bytes as they are, so the file is the one the repair
verified. Git applies it to a copy of them that nothing converts. `git apply` in the working tree would
convert line endings as `core.autocrlf` (Git for Windows sets it) or a `text` or `eol` attribute in
`.gitattributes` asks, and write a file with LF back with CRLF on every line.

A patch whose lines end otherwise than the file's (a teammate's, made where the file has LF, for a
checkout where it has CRLF) applies only through that conversion. So it goes in as `git apply` puts it
in, and the file keeps its CRLF.

**What it only marks.**

- Applied is marked on this machine only.
- A patch already in the tree, applied by hand, committed, or left there by `repair --apply`, is
  recognised with `git apply --reverse --check` and only marked.
- A fix verified on the working tree itself, with no repair behind it, has no patch, so it is only
  marked applied. One verified with a change of request fields (`--set`, `--model`) says which, since
  no file carries them: set them in your agent.

**A conflict.** When the working tree has changes the patch conflicts with, nothing is changed. The
message says whether to commit or stash them, or to apply the patch by hand.

**Run again** on an applied fix, `fix apply` finishes what is left, and keeps when the fix was applied.
It copies the goldens not in the project yet (`repair --apply` copies none without `--goldens`), and
runs the test when it hasn't passed, on goldens copied before where they are. With nothing left, it
does nothing; with `--no-test`, it says when a test is still to pass.

A test that fails leaves the fix applied, marked as not holding. It stays so until a run of `fix apply`
passes it, or a `shadowlap test` session passes every one of its goldens (after `test --update`
re-recorded what another fix changed, say), which says the fix holds again.

**It trusts nothing it reads from the store.** Otherwise it changes nothing, and says why:

- the repair's directory must be `.shadowlap/repairs/<repair id>`, each golden inside its `goldens/`;
- the patch must be the accepted candidate's one rewrite to that candidate's file, no larger than a
  repair writes;
- a teammate's must rewrite text where a repair rewrites it, in the file as it is here;
- that file must be a plain file git doesn't ignore, not a symbolic link or a folder;
- `fix.patch` must be the patch the repair verified.

`fix apply --json` prints `{ fixId, status, again, patch, repairId, goldens, tests, outdated, update }`:

| Field | Meaning |
| --- | --- |
| `fixId`, `repairId` | The fix, and its repair |
| `status` | `applied`, or `already-applied` when nothing was left to do |
| `again` | Set when it finished a fix applied before |
| `patch` | What became of the patch: `applied`, `already` in the tree, or `none` to apply |
| `goldens` | Each golden's `from`, `to`, and whether it was `copied` |
| `tests` | `passed`, `failed` or `skipped` |
| `outdated` | The project's other goldens that diverge on what the patch changed, each with its `golden`, `callNo` and request field `path` |
| `update` | The command that re-records them, or `null` |

## decisions

```sh
shadowlap decisions <runs|goldens...> (--model <model> | --from-code | --set <key=value>) [options] [-- <command> [args...]]
shadowlap decisions --verify <session> [runs...] [options] [-- <command> [args...]]
```

Previews what a change decides differently, without running the agent. [Decisions](./decisions.md)
explains the ranks, the report and the limits.

```sh
shadowlap decisions goldens/* --model claude-opus-5
shadowlap decisions label:refund --from-code --then-verify
```

How it works:

1. Each recorded model call is asked again: its request exactly as recorded, with only what the change
   touches swapped in, sent through the same upstreams a live call goes to.
2. The answer's decision (the tools it calls, in order, with their arguments, and whether it stops or
   hands over) is compared with the recorded one, and ranked by consequence, writes first.
3. A text-only change that one of the run's [judge checks](./checks.md#judge-checks) reads is judged
   on the recorded words and on the words under the change. It ranks 2 when the check comes out
   otherwise.

No tool runs, and a step doesn't depend on the one before, so the steps are asked in parallel.

**What it asks.** Runs are ids, unique prefixes or `label:<name>`. A path such as `goldens/*` names
packs, which are imported as `test` imports them and named as its history names them. The change is
one or more of `--model`, `--set` and `--from-code`.

- A model switch changes the agent's calls: those made with the model the runs use most, or with the
  models `--from` names.
- A call made with another model (a simulated user, a sub-agent) is left as recorded, and counted
  `untouched`.
- Shadowlap's own calls (its judge's, in a `shadowlap:` scope) are no step at all.

**Credentials.** Requests need the provider's credentials on this machine, unless
`SHADOWLAP_UPSTREAM_<PROVIDER>` points the provider at a server of your own. Without them nothing is
sent, and the command says which is missing:

- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` or `AZURE_OPENAI_API_KEY`;
- or, where the AI SDK keeps the last two, `GOOGLE_GENERATIVE_AI_API_KEY` and `AZURE_API_KEY`;
- AWS credentials for Bedrock, and Google credentials for Vertex AI.

An Azure OpenAI deployment call is sent with the `api-version` it was recorded with. One recorded before
recordings kept a call's query takes `OPENAI_API_VERSION` (or `AZURE_OPENAI_API_VERSION`), as the
AzureOpenAI SDKs do; without it, nothing is sent.

`decisions` takes these flags:

| Flag | What it does | Default |
| --- | --- | --- |
| `--model <model>` | The change is this model, at the agent's model calls: in the body, or in the path on Gemini, Vertex AI, Bedrock and Azure (below) | — |
| `--from <model>` | The recorded model the change switches from: `--model` and `--set` change only the calls made with it (repeatable; an alias names its dated snapshots) | The model the runs use most; with `--set` alone, every call |
| `--from-code` | The change is the system prompt and tool definitions your working tree sends (below) | — |
| `--set <key=value>` | The change sets this request field, where the provider keeps it (`temperature` is `generationConfig.temperature` on Gemini); repeatable | — |
| `--samples <n>` | Ask each model call *n* times under the change and, from 3 on, *n* times as recorded, the control (below) | 3: six requests a step |
| `--concurrency <n>` | Requests in flight at once. A run whose requests carry cache breakpoints is asked one step at a time, in order | 4 |
| `--scope <name>` | Ask only the model calls made in this [scope](./sdk.md#scopes); `none` for those made in no scope | — |
| `--then-verify` | Then run [`verify`](#verify) on the runs a preview can't clear ([which](./decisions.md#then-verify)) | — |
| `--verify <session>` | Ask nothing: verify the runs a kept session could not clear (below) | — |
| `--expect <json\|@file>`, `--gate <json\|@file>`, `--attempts <n>`, `--passes <n>`, `--writes stub\|block`, `--guard` | With `--then-verify` or `--verify`: as for [`verify`](#verify) | Verify's |
| `--budget <usd>` | Send no request, and start no verify attempt, once this much is spent | — |
| `--timeout <seconds>` | Stop a model request, or a verify attempt, after this long | A model request waits ten minutes, as the official SDKs do |
| `--strict` | Exit 1 when a run has a rank 1 or 2 change, for CI | — |
| `--inconclusive fail\|warn` | What an inconclusive result does to the exit status: `fail` exits 3, `warn` exits 0 with a warning | `fail` |
| `-y, --yes` | Run recorded commands without asking (below) | — |
| `--json` | Print the report as JSON on stdout ([below](#decisions-report-as-json)); progress goes to stderr | — |

More on some of them:

- **`--model`**: a model of another family than the recorded one (a Claude call asked of `gpt-…`) is not
  asked. Its requests take another format, which is verify's to test.
- **`--from-code`**: the prompt and tools are read by replaying each run offline under your code, its
  model calls matched without their prompt and tools. Nothing is sent to read them, no tool runs, and
  the replay is not kept. A run whose first model request differs in more than its prompt and tools is
  refused, with the difference.
- **`--samples`**: a step is ranked only when its decisions run more consequential than the
  control's, by an exact permutation test at 5% ([sampling](./decisions.md#reading-the-report)).
  Below 3 there is no control, and a step flags its run when more than half its samples show a write,
  stop or judged change.
- **`--then-verify`**: a run that passed as recorded must not get worse than its own baseline, and one
  that failed must pass. Each is judged under its checks (its golden's, or for a run named by id those
  of the recording it comes from) or `--expect`, one verify per set of checks.
- **`--verify`**: it verifies the runs a kept session could not clear (its `dc-…` or `mg-…` id, or a prefix of
  it), or those of them named after it, as `--then-verify` verifies them, under the session's change.
  It keeps what verify finds in the session. The dashboard runs it as its `decisions-verify` job.
- **`--gate` and the rest**: each run is decided by verify's gate, unless `--attempts` or `--passes`
  gives a fixed count.
- **`--yes`**: it runs the recorded command of a run imported from someone's pack (`--from-code`,
  `--then-verify`, `--verify`), and of a golden from a pack the repository doesn't track, as `test`
  asks of one.

The command after `--` replaces each run's recorded one, for `--from-code`, `--then-verify` and
`--verify`.

`decisions` exits with:

| Status    | Meaning                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------ |
| `0`       | Every run was asked                                                                                    |
| `1`       | `--then-verify` or `--verify` rejected the change, or, with `--strict`, a run has a rank 1 or 2 change |
| `2`       | A refusal before anything is asked: no credentials, no such run or session                             |
| `3`       | The result settles nothing (below), unless `--inconclusive warn`                                       |
| `128 + n` | A stop signal; 130 for Ctrl-C                                                                          |

A result that settles nothing is inconclusive. That is when:

- it stopped early: the budget, or a stop signal, which exits 128 + n instead;
- a run could not be asked at all: a `--from-code` change that is more than a prompt, or a model that
  refused every step;
- a run nothing else flags has a text-only change a judge check reads that could not be judged, in any
  sample of a step its samples don't flag (no key for the judge's provider, the budget spent);
- a run nothing else flags has a changed step whose control, the request as recorded, got no answer;
- verify didn't run, or didn't settle the runs it took.

The change is sent as given. When the model it switches to refuses the requests as recorded, a warning
says what it takes instead (`thinking={"type":"adaptive"}`, `temperature` left out), which
[`migrate`](#migrate) sends.

A request that fails is retried twice when the provider says so (408, 409, 429, 5xx), honouring
`retry-after`. One the provider refuses keeps its answer's message in `error`.

Each session is kept in the store, with each run's part as a row of its own for its page in the
dashboard, and logs a `decisions.done` activity event. Values the project's
[redaction rules](./normalizers-and-redaction.md) match are masked in every argument, text and error
the report holds, as in every export, pack and share link.

### Decisions report as JSON

`--json` prints the report the dashboard reads:

| Field | Meaning |
| --- | --- |
| `decisionsId` | `dc-…`, the session as the store keeps it |
| `kind` | `decisions` |
| `at` | When the session ran |
| `change` | The change (below) |
| `command` | The command that asks the same way again, every option given |
| `samples` | The samples asked of each model call |
| `runs` | Each run (below) |
| `counts` | Steps by the rank they were given (below) |
| `flagged` | The runs a rank 1 or 2 change flags: beyond the control's variation, or with no control by what most samples show |
| `toVerify` | The runs a preview can't clear, those flagged among them: what `--then-verify` and `--verify` verify ([which](./decisions.md#then-verify)) |
| `cost` | Per run, the mean `before` and `after` in USD; what asking `spent`; `upstreamRequests`; and `unknownModels` with no price |
| `tokens` | `before` and `after`, each `input` (uncached), `output`, `cacheRead` and `cacheWrite` (cache creation) |
| `retirements` | Each model the runs use, or switch to, that its provider retires (below) |
| `notes` | What to keep in mind reading it (below) |
| `warnings` | The report's warnings |
| `verify` | With `--then-verify`: what verify found (below); else `null` |
| `judge` | What the judge checks that read text-only steps found (below); `null` when no check read a step |
| `remedies` | Empty here; see [`migrate`](#migrate) |
| `stopReason` | Why it stopped before every step was asked (the budget, Ctrl-C), or `null` |

`change` has its `model`, its `fields`, `from` (the recorded models they change at, or `null` for every
call), `fromCode`, and `text`, the change in words.

`counts` has the steps by the rank they were given, `1` to `5`, then:

- `noise`: those whose samples decided otherwise no more often than as recorded;
- `same`;
- `untouched`: a request the change leaves as it was, such as one the working tree sends with the same
  prompt, or one made with a model the switch leaves;
- `notAsked`.

`retirements` lists each model the runs use, or switch to, that its provider retires, as
[the retirement table](./decisions.md#model-retirements) has it: `provider`, `model`, `platform`,
`matched`, `deprecated`, `retires`, `earliest`, `regions`, `replacement` as the page words it and the
model ids it names in `replacements`, `state`, `days`, `source` and `text`.

`notes` says what to keep in mind reading it: later steps are judged in the recorded run's state,
reasoning left out, cache breakpoints kept, calls left as recorded, the text-only steps a judge check
reads and how they came out, values masked.

Each of `runs` has these fields:

| Field | Meaning |
| --- | --- |
| `runId`, `golden` | The run, and its golden or `null` |
| `steps`, `asked` | Its model calls, and how many were asked again |
| `rank` | The most consequential rank its steps were given, or `null` |
| `majority` | The same, by what decides a step: beyond the control's variation, or with no control what most samples show (below) |
| `counts` | Its steps by rank, as `counts` above |
| `cost` | `before` and `after` for the steps asked, and what asking them `spent` |
| `tokens` | `before` and `after` |
| `thinkingStripped` | Reasoning blocks left out of its requests |
| `refused` | Why none of its calls could be asked, or `null` |
| `decisions` | Its model calls, the changed ones first, most consequential first (below) |
| `warnings` | The run's warnings |

A `1` or `2` in a run's `majority` flags the run.

Each of its `decisions`, a step, has these fields:

| Field | Meaning |
| --- | --- |
| `callNo`, `step`, `scope` | The call in the recording, its place among the run's model calls, and its scope |
| `rank` | With a control, the rank it earns beyond the control's variation; else the most consequential change any sample showed (below) |
| `majority` | With a control, the same; else the rank more than half its samples show, or `null` |
| `changes` | Each change (below) |
| `recorded`, `now` | The decision as recorded, and under the change (below) |
| `samples` | `asked`, `answered`, `changed`, `unjudged` (below), and each sample's rank in `ranks`, 0 for the same |
| `control` | From 3 samples on, the request asked as recorded, as often (below) |
| `noise` | With `control`: `p`, the exact one-sided p-value that the change's decisions run more consequential than the control's |
| `sampled` | With `control`: the most consequential change any sample of the change showed, ranked or not |
| `model` | `recorded` and `asked` |
| `tokens` | `before` as recorded, and `after` as the answer under the change would use them (below) |
| `cost` | `before` and `after` for those tokens, and what asking it `spent`, every sample |
| `thinkingStripped` | Reasoning blocks left out of the request |
| `error` | Why it wasn't asked, or got no answer |
| `judge` | For a text-only change a judge check reads (below); `null` when no check read the step |

More on a step's fields:

- **`rank`** is `null` when there is none, and when either side got fewer than 3 answers, which leaves
  the step not settled.
- **`changes`**: each has its `rank`, its `kind`, the `tool` and its `effect`, `before`, `after` and a
  `detail` sentence. `kind` is one of `write-added`, `write-removed`, `write-arguments`,
  `write-order`, `stops`, `handover`, `judge`, `read-added`, `read-removed`, `read-arguments` and
  `text`. A `judge` change is a judge check that comes out otherwise for the words under the change,
  with its status `before` and `after`.
- **`recorded` and `now`**: each decision's `stop` (one of `tools`, `answer`, `limit`, `refused`,
  `paused` and `other`), the provider's `stopReason`, its `tools` with their arguments and effect, and
  its `text`. `now` is `null` when no answer came.
- **A text**, here and in a `text` change, keeps its first 2,000 characters, and says how many more the
  recording holds. The comparison reads all of it.
- **`samples.unjudged`**: the text-only samples whose words a judge check reads but could not judge.
- **`control`**: `asked`, `answered`, `changed`, `ranks`, and `error`, why fewer than 3 were answered.
  With it, `rank` and `majority` are the rank the change earns beyond the control, or `null`. It is
  absent below 3 samples.
- **`tokens.after`**: in a run like the recorded one, its input split between cache read, cache creation
  and uncached input, as the recorded call's was.

A step's `judge` is `now`'s, the sample shown: the most consequential, or, among text-only ones, one
whose words could not be judged. It lists each check:

| Field             | Meaning                                                                      |
| ----------------- | ---------------------------------------------------------------------------- |
| `name`            | The check                                                                    |
| `of`              | What it reads: `answer` or `run`                                             |
| `model`           | Its model                                                                    |
| `pass`            | The answer that passes                                                       |
| `recorded`, `now` | Its verdict on the recorded words, and on the words under the change (below) |
| `changed`         | Whether the check changed; `null` when either side is inconclusive           |

Each verdict, `recorded` or `now`, has these fields:

| Field     | Meaning                                                                                    |
| --------- | ------------------------------------------------------------------------------------------ |
| `status`  | `passed`, `failed` or `inconclusive`                                                       |
| `verdict` | The judge's verdict: `yes`, `no`, or `null` when not judged                                |
| `reason`  | The judge's reason, or why it is inconclusive: `not judged: …`                             |
| `source`  | Where the verdict came from (below)                                                        |
| `cost`    | What it cost when asked here, in USD; 0 when free                                          |
| `request` | A digest of the judge's request, by which the very same request is answered again for free |

`source` is `recording` (the golden's own judge call), `kept` (asked before, and kept with a session in
this store), `live`, or `null` when not judged.

The report's `judge` says what the judge checks that read text-only steps found, and what judging cost
apart from asking:

| Field | Meaning |
| --- | --- |
| `steps` | The steps whose text-only change a check reads |
| `changed` | Of those, the steps a check came out otherwise for |
| `inconclusive` | Of those, the steps that wait on a judge: a sample's words could not be judged, and the step's samples don't flag it without them |
| `spent`, `upstreamRequests` | What the judge's calls in this session cost, and their upstream requests |
| `unknownModels` | The judge's models with no price |

The rest of `steps` are those every check came out as recorded for.

With `--then-verify`, `verify` holds what verify found:

| Field | Meaning |
| --- | --- |
| `verdict` | `accepted`, `rejected`, `incomplete`, or `not-run` when no run needed verifying or verify could not run, with why in `reasons` |
| `verifyIds` | The verdicts kept |
| `runs` | Each run verified (below) |
| `rule` | The rule they were decided by, stated once (below) |
| `commands` | The commands that verify them again |
| `warnings` | Each good run judged by its gate alone, and why; absent when none was |
| `footprint` | What the runs verified cost a run, `recorded` and `now`; absent when no attempt showed it |
| `spent`, `upstreamRequests` | What it spent, and its upstream requests |
| `reasons` | Its reasons |

Each run verified has:

- its `runId`, `role`, `outcome` in verify's own words, `passes` and `attempts`;
- `bound`, the bound of its pass rate under the gate, exact under its stopping (`rate >= 0.73 (95%)`);
  `null` for a clean replay or a fixed count;
- `undecided`: why its last attempt could not be judged, which stopped it `inconclusive`. That attempt
  neither passed nor failed, and there is no bound; `null` otherwise;
- the `rule` it was decided by.

A good run kept against its own baseline has the `baseline`'s `passes` and `attempts`, and its `bound`
is the drop's (`drop <= 0.10 (95%)`).

The `rule` is stated once, such as `gate: tells 90%+ from 70%- at <= 5% risk, up to 80 attempts`. It is
`null` in a session whose runs were decided by different rules, verified again later under other figures,
where each run's own says which.

`--verify --json` prints:

| Field | Meaning |
| --- | --- |
| `sessionId` | The session |
| `kind` | `decisions` or `migrate`, the session's |
| `change` | The change, in words |
| `verify` | As above, for the runs it verified |
| `passes` | A migrate session's runs, as its What still passes reads after this verify, as [`migrate`](#migrate) prints them; `null` for a decisions session |

A refusal before anything is asked (no credentials, no such run or session) prints
`{ "kind": "decisions", "outcome": "error", "error": { "message": … } }`: `kind`, `outcome` and
`error`. It exits 2.

## migrate

```sh
shadowlap migrate --to <model> [goldens...] [options] [-- <command> [args...]]
```

Switches models with the evidence, for a model a provider retires, or one you would rather pay for.
[Decisions](./decisions.md#migrate) explains each block of its report.

```sh
shadowlap migrate --to claude-opus-5
```

1. It runs [`decisions --model`](#decisions) on the goldens (`goldens/*` unless you name packs or
   runs), with the fields the model it switches to refuses changed to what it takes (below).
2. It runs [`verify`](#verify) on [the runs a preview can't clear](./decisions.md#then-verify).
3. It compares what a run costs.
4. It ends in one report: what changes, what still passes, what it costs, and what to set.

It switches the agent's model calls:

- those made with the models `--from` names;
- else those made with a model the [retirement table](./decisions.md#model-retirements) says retires;
- else those made with the model the runs use most.

A simulated user or a sub-agent on another model keeps its own, in the preview and in verify alike.
Shadowlap's own calls (its judge's) are none of the agent's.

`migrate` takes these flags:

| Flag | What it does | Default |
| --- | --- | --- |
| `--to <model>` | The model to switch to. Required | — |
| `--from <model>` | The recorded model to switch from (repeatable; an alias names its dated snapshots) | As above |
| `--scope <name>` | Only the model calls made in this scope; `none` for those made in no scope | — |
| `--set <key=value>` | A request field the switch sets as well (repeatable) | — |
| `--samples <n>`, `--concurrency <n>` | As for [`decisions`](#decisions) | 1, 4 |
| `--expect <json\|@file>` | What a passing run must do besides exiting 0 | Each run's checks (below) |
| `--gate <json\|@file>`, `--attempts <n>`, `--passes <n>`, `--writes stub\|block`, `--guard` | Verify's, as for [`verify`](#verify). Each run is decided by verify's gate, unless `--attempts` or `--passes` gives a fixed count | Verify's |
| `--budget <usd>`, `--timeout <seconds>` | As for [`decisions`](#decisions) | `--timeout`: a model request waits ten minutes |
| `--inconclusive fail\|warn` | What an inconclusive result does to the exit status, as for `decisions` | `fail` |
| `-y, --yes` | Run recorded commands without asking (below) | — |
| `--json` | Print the report as JSON on stdout ([below](#migrate-report-as-json)) | — |

`--expect` defaults to each run's checks from `shadowlap.config.json`: its golden's, or, for a run
named by id, those of the recording it comes from. `--yes` runs the recorded command of a run imported
from someone's pack without asking, and of a golden from a pack the repository doesn't track, as
`test` asks of one.

`migrate` exits with:

| Status | Meaning                                                          |
| ------ | ---------------------------------------------------------------- |
| `1`    | A run verify took breaks under the model it switches to          |
| `3`    | The report settles nothing (below), unless `--inconclusive warn` |
| `0`    | Otherwise                                                        |

The report settles nothing when it stopped early, a step got no answer, a run that needed verify went
unverified, or a run nothing else flags has a text-only change a judge check reads that could not be
judged.

### The fields `migrate` changes

The fields it changes come from two places.

**The [retirement table](./decisions.md#model-retirements)**, which keeps what a provider's pages say it
stops accepting:

- Anthropic's Claude 4.7 and later, in a Messages API request on the Claude API, Bedrock or Vertex AI,
  answer a non-default `temperature`, `top_p` or `top_k` with a 400, and the page says to omit them.
  So they are left out of what to set. The preview and verify send `temperature` its default, 1,
  meanwhile.
- They refuse a manual thinking budget too, so `thinking` becomes `{"type": "adaptive"}`.
- OpenAI's o-series take `max_tokens` as `max_completion_tokens`.

**The target model's own refusal**, when it names what to change: `max_tokens: 64000 > 32000`,
*at most 16384 completion tokens*, *Only the default (1) value is supported*,
`"thinking.type.enabled" is not supported`, or
*'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead*.

- The step is asked once more with that field changed, and so is every later request to that model,
  through that provider, that needs it.
- An output limit only ever lowers a request, and never under its thinking budget.
- A refusal that names nothing to change stays the step's `error`.

Verify runs with the fields set to a value. A field to leave out, or to send under another name, has to
change in your agent's requests first, since verify runs your code. So verify waits for it, and the
report says what to change.

### What `migrate` writes

It writes the pull request body and the change to the project's files (a patch `git apply` takes)
under `.shadowlap/migrations/<id>/`. It keeps the report in the store (`mg-…`), logging a
`migrate.done` activity event.

The patch changes only a string value that names a model it switches from, in code and config: a
string literal, a JSON value, a YAML, TOML or `.env` value. Every other mention is left as it is, and
listed for review: in prose and changelogs, in tests, as an object key such as a price table's, inside
a longer string, or in `shadowlap.config.json`.

### Migrate report as JSON

`--json` prints the report:

| Field | Meaning |
| --- | --- |
| `migrateId` | `mg-…`, the report as the store keeps it |
| `kind` | `migrate` |
| `at` | When it ran |
| `from`, `to` | The recorded models it switches from, and the model it switches to |
| `command` | The command that migrates the same way again, every option given |
| `decisions` | The [decisions report](#decisions-report-as-json), with its `remedies` (below) |
| `changes` | `runs`, `flagged`, and each rank 1 or 2 change in `steps` (below) |
| `passes` | What still passes: verify's `verdict`, and the `runs` (below) |
| `costs` | `perRun` and `total`, `before` and `after` in USD, `tokensPerRun`, `endToEnd` (below), and what `checking` cost (below) |
| `set` | The `--set` `flags` verify took, the `fields` changed, and those `given` with `--set` |
| `configChange` | The change to the project's files (below); `null` when no file names the model |
| `pullRequest` | `title` and `body` |
| `files` | Where the `dir`, the `pullRequest` body and the `patch` were written |
| `retirements`, `notes`, `warnings`, `stopReason` | As in the decisions report |

Each of the decisions report's `remedies` has these fields:

| Field       | Meaning                                                                            |
| ----------- | ---------------------------------------------------------------------------------- |
| `field`     | The request field                                                                  |
| `value`     | What the requests were sent with in its place; `null` when it was left out of them |
| `leftOut`   | Whether your agent's requests should leave it out                                  |
| `renamedTo` | The name it goes under instead, or `null`                                          |
| `why`       | Why                                                                                |
| `source`    | Its source page, or `null` when the provider's refusal said it                     |
| `steps`     | The steps that needed it                                                           |

`changes.steps` holds each rank 1 or 2 change most samples show, a judged one included: `runId`,
`golden`, `callNo`, `rank`, `detail`, the `recorded` and the `now` action, and how the `arguments`
differ.

`passes` has verify's `verdict`, `not-run` when no run needed verifying or verify waits for a change
to your code. Each of its `runs` has these fields:

| Field | Meaning |
| --- | --- |
| `runId`, `golden` | The run, and its golden |
| `verdict` | `passed`, `failed` or `inconclusive` |
| `outcome` | How it came out (below) |
| `tally` | For a run verify took: its `passes`, `attempts`, `bound` (exact under the gate's stopping), the `rule` that decided it and `undecided` (below); else `null` |

A tally's `bound`, `rule` and `undecided` are as in the decisions report's
[`verify`](#decisions-report-as-json).

`outcome` is in verify's own words when it was `verified` (`kept`, `fixed`, `broken`, `not-fixed`,
`inconclusive`, `unsettled`). Else it is:

- `unchanged`, when the preview cleared it, so its recording's own verdict stands and it was not run
  end to end;
- `unsettled`, when a run that needed verify went unverified;
- `not-judged`, when a text-only change a judge check reads could not be judged;
- or `not-asked`.

`checking` is what checking cost: `decisions`, `judge` (judging the text-only changes a judge check
reads) and `verify`.

`endToEnd` is what the runs verified cost a run, `recorded` and `now`, each with `inputTokens`,
`outputTokens` and `cost`, by what their attempts did. `perRun` counts only the recorded steps, so it
can't see a run that takes more of them. It is `null` when no attempt showed it.

`configChange` holds the `files` patched, with the `places` in each, the `patch`, and each mention left
for `review`: its `path`, `line` and `text`.

A refusal before anything is asked prints `kind`, `outcome` (`error`) and `error`, as `decisions` does.

## test

```sh
shadowlap test <pack...> [--junit <file>] [--json <file>] [--markdown <file>] [--annotations]
               [--update] [--online] [--writes <policy>] [--cwd <dir>] [--guard <mode>] [--push]
               [--inconclusive fail|warn] [--max-attempts <n>] [--suite-risk <r>] [--continue]
               [--allow-unrecorded <names>] [-y]
shadowlap test <pack...> --chaos [--presets <list>] [--chaos-tool <name>] [--inconclusive fail|warn] [-y]
```

[CI mode](./ci.md): replays packed recordings offline, re-running each recorded command. Checks, and
recordings allowed to fork, are configured under `tests` in `shadowlap.config.json`.

```sh
shadowlap test goldens/*
shadowlap test goldens/* --junit junit.xml --markdown "$GITHUB_STEP_SUMMARY" --annotations
```

Any of these fails the pack:

- a divergence;
- a live call;
- a non-zero exit;
- a replay that [ends before its recording does](./ci.md#a-replay-that-ends-early);
- a failed [outcome check](./ci.md#outcome-checks).

A `*` in the last part of a path (`goldens/*`) is expanded by the command itself.

Each replay's agent gets a [placeholder key](./how-it-works.md#keys) for each provider its recording
called whose credentials the environment lacks, so a job without secrets tests it. `--online`,
`--update`, `--chaos` and a golden that may fork give none, and need the real keys.

`test` takes these flags:

| Flag | What it does | Default |
| --- | --- | --- |
| `--junit <file>` | Write a JUnit XML report | — |
| `--json <file>` | Write a JSON report (below) | — |
| `--markdown <file>` | Append a Markdown report: a results table, and the diff and agent output for each failure. Point it at `$GITHUB_STEP_SUMMARY` for a GitHub job summary | — |
| `--annotations` | Print a GitHub Actions annotation for each pack that didn't pass, attached to its `run.json` (below) | — |
| `--update` | [Re-record each golden that diverged](./ci.md#update-a-golden-after-an-intended-change), live with writes stubbed, and replace its pack (below) | — |
| `--online` | Allow live calls after a divergence | Every provider offline: a live call fails the pack |
| `-y, --yes` | Run the recorded command of a golden from someone else's pack, which the repository doesn't track, without asking | — |
| `--writes block\|stub\|allow` | What `write` tools do after a divergence | `block` |
| `--cwd <dir>` | Where the recorded commands run | The current directory |
| `--guard block\|warn\|off` | The [network guard](./how-it-works.md#the-network-guard) | `block` |
| `--allow-unrecorded <names>` | Run these tools again for real, though a golden never recorded them: names separated by commas (repeatable; below) | — |
| `--push` | Push every test run, with the golden it replayed, and the session's report to the [team store](./team.md#push-from-ci) (below) | — |
| `--inconclusive fail\|warn` | What an inconclusive verdict does: `fail` the run, or `warn` (below) | `fail`, with an exception (below) |
| `--max-attempts <n>` | Raise every [gate](./gating.md)'s limit, its `max`, for this session only, to settle an inconclusive golden without changing the config | — |
| `--suite-risk <r>` | The most a healthy suite may go red for nothing in this session, split across its gated goldens (below) | `suiteRisk` under `tests` in the config, else 0.05 |
| `--continue` | Carry an inconclusive gate's attempts over from the golden's last result, and run only the attempts still needed (below) | — |
| `--chaos` | Run the [error-path presets](#error-path-presets) instead of the session above | — |
| `--presets <list>` | With `--chaos`: the presets to run, comma-separated (`timeout`, `empty`, `malformed`, `oversized`, `429`, `500`, or `all`) | The golden's `chaos.presets`, else all |
| `--chaos-tool <name>` | With `--chaos`: the tool whose first call the tool presets hit | The golden's `chaos.tool`, else the first tool call that reads the world |

More on some of them:

- **`--annotations`**: an error, or a warning for an inconclusive one let through, with why it only
  warns or counts.
- **`--update`**: it also re-records each golden that may fork and forked before its task's takeover.
  It replaces the pack (`run.json`, `calls.jsonl`, `blobs/`, and a `.gitattributes` when the folder has
  none; other files in its folder stay) in the working tree, when the agent exits 0 and its checks
  pass.
- **What `--update` prints**: what the agent sends differently. When the divergence is a value that
  changes every run and the config has no rule at its path, it warns, with the normalizer to add.
- **`--update` and judges**: a golden that replayed clean but holds no verdict for a
  [judge check](./judges.md#recorded-once-judged-free-after) gets it asked live, and kept in its pack.
- **`--allow-unrecorded`**: for tools that [write](./how-it-works.md#tools-shadowlap-did-not-record), or
  that nothing says what they do. Without it, a session with a golden whose model called such a tool is
  refused before any golden runs, every such golden named, exit status 2. A read is named, one line per
  golden.
- **`--push`**: a pull request's CI job pushes to [its own folder](./team.md#pull-requests). A missing
  store or missing credentials is a warning; the tests still decide the exit status.
- **`--continue`**: it carries attempts over when the golden's recording, checks and gate are
  unchanged. With `--max-attempts`, it runs up to the higher limit. A gate continued this way decides
  exactly as one that had that limit from the start. A golden whose last result isn't an inconclusive
  gate's runs afresh, and says why.
- **`--suite-risk`**: see [one risk for the whole suite](./gating.md#one-risk-for-the-whole-suite).
- **`--chaos`**: each golden forked at one call with a tool timeout, an empty result, malformed JSON,
  an oversized result, a provider 429 and a 500.

`--inconclusive` covers an inconclusive verdict of any kind:

- a gate's;
- a check's;
- an [injection gate](./injection.md#gate-ci-on-it)'s, one whose test showed too little to say;
- with `--chaos`, a preset's: one whose gate ran out of attempts between its bounds, whose replay never
  reached the call, or that only a check no attempt can decide kept from passing.

Under `warn`, the pack counts as passed for the exit status, a JUnit report marks it skipped,
`--annotations` gives it a warning, and every report still says it is inconclusive.

With neither `fail` nor `warn` given, each fails the run, but for a gate against history whose golden
has fewer than 30 sessions (three of its `window`s). That one only warns when it runs out of attempts,
saying it needs more history (its result's `warned`). It counts after all, saying why (`counted`), when
the session's plan reads its last sessions below the ones before them, 99 to 1 likely or more, or
beyond chance at its share.

`test` exits with:

| Status    | Meaning                                                                                  |
| --------- | ---------------------------------------------------------------------------------------- |
| `0`       | Every pack passed                                                                        |
| `1`       | A pack failed, other than a pack it needs `--yes` to run                                 |
| `2`       | The packs can't be tested as given (below)                                               |
| `3`       | None failed, and one is inconclusive (below)                                             |
| `128 + n` | A signal stopped the session: 130 for Ctrl-C, 129 for a closed terminal, 143 for SIGTERM |

- **`2`** is for packs that can't be tested as given:
  - none matches, a config it can't read, or a golden that would run a
    [write Shadowlap never recorded](./how-it-works.md#tools-shadowlap-did-not-record) again;
  - a path named as it is holds no pack, whatever else failed;
  - the only goldens that failed are packs it needs `--yes` to run (someone else's, which nobody said
    yes to). Each fails as a golden in every report, while the others run.
- **`3` becomes `0`** when every inconclusive one only warns: under `--inconclusive warn`, or, with
  none given, a gate against history whose golden has too few sessions, as `--inconclusive` says.
- **`128 + n`**: the session then keeps the results of the packs that finished.

### The command a golden runs

A golden replays the recording and the command its own pack holds. The store may already hold another
recording under the pack's run id: a copy pulled from a pull request's folder, a pack someone sent that
reused the id, or the golden a copied one came from.

- If only the command differs, the pack's command runs.
- If the calls differ, the golden fails, naming where the store's copy came from.
- The store's copy's command never runs.
- A store's copy that differs only in its [redaction rules](./normalizers-and-redaction.md#redaction),
  more of them or fewer, is the pack's recording. That is the run recorded here under the golden packed
  from it, or a newer pack's copy under an older checkout's pack. It replays with every rule either one
  carries as a normalizer.

A golden this machine recorded, or one whose pack the project's git repository tracks (its `run.json`
is in the index), runs its command without asking. A pack from anyone else, outside the repository or
not added to it, asks first, as `replay` asks of an imported run:

- it runs after a yes at a terminal, or with `-y`;
- without a terminal (CI), or after a no, it isn't run, and fails saying why;
- with several goldens tested side by side, they ask one at a time.

### Test history and gates

Each session is kept in the project's store as [test history](./ci.md#test-history): the command, the
revision, passed and failed (an inconclusive golden is neither: its result says so), and each golden's
result with why it failed. Global `--db :memory:` keeps nothing.

- **Why a divergence failed**: the first change the normalizers in force don't mask. The report lists
  the masked ones too, without a hint to add a rule the config has.
- **A session still running**: until it ends, the store also names the process running it. So the
  dashboard shows a session started in a terminal as running, and one whose process was killed as one
  that did not finish.
- **Each replay** prints `replaying run <id>`, and is marked as made by `test` for its golden.
- **A golden replayed more than once** (`repeat`, or a `gate`) numbers its attempts, and files them
  under the one its result shows, so the dashboard lists them as one test run.

With several goldens, their attempts run in turns, one at a time: the first attempt of each golden,
then the second of each one whose gate hasn't decided, and so on. So a burst of failures lands on many
goldens once each ([attempts are independent](./gating.md#attempts-are-independent)). Each golden's
result is printed in order, once every golden's replays have ended.

A golden with a [gate](./gating.md) runs attempts until the gate decides. It says how in one line, the
verdict word, the tally, the bound and the rule
(`passed · 12 of 12 · rate >= 0.73 (95%) · gate: tells 90%+ from 70%- at <= 5% risk, up to 80 attempts`),
with pass^k under it (`pass^5 1.00`).

- **The forecast**: before any golden runs, the session prints its
  [forecast](./gating.md#one-risk-for-the-whole-suite): the attempts it runs on average and at most,
  and what they cost. With several gated goldens, it splits its one risk across them (`--suite-risk`).
- **An unavailable provider**: an attempt the agent failed while its provider was
  [unavailable](./gating.md#when-the-provider-is-unavailable) before the model answered is run again,
  and not counted. One the provider cut short after is counted against either verdict.
- **Inconclusive**: a gate that runs out of attempts between its bounds is *inconclusive*. So is a pack
  whose only checks that did not pass could not be decided, such as a
  [judge check](./judges.md#not-judged) with no verdict, and one whose injection gate showed too
  little to say. Each is marked `?` in amber and counted apart (`1 passed, 0 failed, 1 inconclusive`).

### A golden's injection test

A golden whose entry has an [injection gate](./injection.md#gate-ci-on-it)
(`"injection": { "obeyed": 0, "repeat": 3 }`) gets its injection test once its replay passed. Payloads
are planted in its untrusted reads, live from the model call that reads them, with writes stubbed and
reads the recording doesn't hold fenced.

It fails, as an `injection` failure, when more attempts obey (or are influenced) than the gate allows.
It fails too when the test showed too little to say:

- no untrusted read to plant in;
- an attempt in which a model call failed, or the agent exited non-zero;
- no attempt a model read;
- a test cut short.

That verdict is inconclusive, and `--inconclusive warn` lets it through.

### Test report as JSON

`--json <file>` writes a JSON report: the session, counts and, per pack, the result and the kind of
failure. The report is `{ version, session, revision, passed, failed, inconclusive, interrupted, results }`,
and `suite` with a gated golden:

| Field | Meaning |
| --- | --- |
| `version`, `session`, `revision` | The report's version, the session in the store's history, and the revision it tested |
| `passed`, `failed` | The packs, counted by what CI does with them (below) |
| `inconclusive` | The inconclusive packs, either way (below) |
| `interrupted` | Whether a signal stopped the session; `results` has the goldens that finished before it |
| `results` | One result per pack (below) |
| `suite` | With a gated golden: the session's one risk, and how it was split (below) |

An inconclusive pack counts as failed, or as passed when it only warns: under `--inconclusive warn`, or,
with none given, a gate against history with too few sessions (its `warned`). `inconclusive` counts the
inconclusive ones either way:

- a gate that ran out of attempts between its bounds;
- a pack that fell short only on a check that [could not be decided](./checks.md#how-a-check-comes-out);
- one whose provider was unavailable too many attempts in a row.

`suite` has these fields:

| Field | Meaning |
| --- | --- |
| `risk` | The session's one risk |
| `perGoldenRisk` | Each gated golden's share of it |
| `method` | How it was split: `bonferroni` |
| `goldens` | How many goldens shared it |
| `inconclusive` | What `inconclusive` verdicts did |
| `red`, `averaged` | The chance the session went red for nothing, as planned (below) |
| `over` | When any golden could not keep within its share, how many could not (below) |
| `early` | How many have too few sessions to keep within their share |
| `drop` | How many gates against history saw their last sessions sit below the sessions before them, beyond chance |
| `short` | How many have too few sessions for an inconclusive to count |
| `forecast` | Made before it ran: `attempts` on average, `most`, and their `cost` on average in USD (below) |

- **`red`** is at most that at each SPRT gate's good rate. With `averaged`, it is on average over the
  pass rates the sessions of its gates against history leave open.
- **`over`**: once their chances add up past the risk, the summary states `red`, not `risk`.
- **`forecast.cost`** is null with no price; `unpriced` counts the goldens without one.

One result per pack, in `results`, has these fields:

| Field | Meaning |
| --- | --- |
| `name`, `dir`, `golden` | The pack, its folder, and the golden as test history names it |
| `mode` | `replay`, or `fork` for a recording that forks on purpose |
| `ok` | Whether CI lets it through |
| `warned` | Why an inconclusive one only warns, when no `--inconclusive` was given: `needs more history: 3 of 30 sessions` |
| `counted` | Why one counts though its golden's history is that short (below) |
| `verdict` | `passed`, `failed` or `inconclusive`, whatever CI does with it |
| `failure` | The kind of failure (below) |
| `message`, `details` | Its one-line message, and the details the terminal shows |
| `output` | The agent's last lines of output, when it failed |
| `seconds` | How long it took |
| `runId`, `runs` | The replay shown, and every attempt (below) |
| `goldenRunId` | The recording replayed |
| `calls` | Calls by origin: `total`, `replayed`, `live`, `blocked`, `stubbed` |
| `upstreamRequests`, `tokensNotRespent` | Upstream requests, the judge's included, and tokens not re-spent |
| `divergence` | `type`, `callNo`, `kind`, `name`, and for one that [ended early](./ci.md#a-replay-that-ends-early) `recorded`, the calls its recording holds |
| `checks`, `expect` | Each check (below), and the `expect` they came from |
| `attempts` | For a recording that repeats or has a gate (below) |
| `gate` | For a golden with a gate (below); null otherwise |
| `judge` | What its judge checks' calls did and cost over every attempt, apart from the agent's (below), or `null` |
| `updated` | With `--update`, what it updated: `from`, `to`, `calls`, `changes` |
| `injection` | Its injection gate (below), or null |

More on a result's fields:

- **`counted`**, for example:
  `counts though it has only 15 of 30 sessions: its last 10 sessions sit below the 5 before them, …`.
- **`failure`**: `diverged`, `check`, `exit`, `no-calls`, `error`, `inconclusive` (for an inconclusive
  one), or `injection` for a golden's injection gate.
- **`gate`** is null, too, when an attempt a check could not decide stopped it before it decided
  anything.
- **`judge`**: `calls`, `replayed`, `live`, `notAsked`, `upstreamRequests`, `spent`, `saved` and
  `unknownModels`.

Each attempt in `runs` has its `runId`, `ok` (true for one that passed), and its `verdict`:

- `passed` or `failed`;
- `inconclusive`, when all it fell short on is a check that could not be decided;
- `unavailable`, when the agent failed while its provider was. It is run again, and never counted,
  unless the provider cut it short after the model answered and a gate or a fixed count counted it.

Each of `checks` has its `status` (`passed`, `failed`, `inconclusive` or `not-applicable`), with `ok`,
`label` and `detail`; see [how a check comes out](./checks.md#how-a-check-comes-out). A
[judge check](./judges.md#in-the-reports)'s has its `reason`, `source` and `judge` too: `name`,
`model`, `of`, `verdict`, `source`, `cost`, `redactions`, `normalized`, `cut` and `callNo`.

`attempts`, for a recording that repeats or has a gate:

| Field | Meaning |
| --- | --- |
| `total` | The attempts counted |
| `passed` | The attempts that passed |
| `inconclusive` | The attempts a check could not decide, which count neither way |
| `required` | The attempts that must pass; null with a gate |
| `unavailable` | The attempts the provider was unavailable for, which `total` leaves out |
| `cutShort` | Those it cut short after the model answered, which a gate or a fixed count counted against either verdict, and `total` holds |

`injection` holds its injection gate, or null:

| Field | Meaning |
| --- | --- |
| `resultId` | The result it is kept under |
| `attempts` | Its attempts |
| `obeyed`, `influenced`, `ignored`, `inconclusive` | How many attempts obeyed, were influenced, ignored it, or were inconclusive |
| `allowed` | What it allowed, as `obeyed` and `influenced` |
| `verdict` | `passed`, `failed` or `inconclusive`, or null when it did not run |
| `reason` | The reason it failed, or is inconclusive |
| `skipped` | Why it did not run |

A result's `gate` holds the gate's figures as this session ran it:

| Field | Meaning |
| --- | --- |
| `kind` | `sprt` or `baseline` |
| `good`, `bad`, `risk`, `max` | With `sprt`: its figures |
| `failRisk` | With `sprt`: a lower risk for a failure, when its share of the suite's risk set one |
| `drop`, `risk`, `window`, `min`, `max` | With `baseline`: its figures |
| `widened` | With `baseline`, for a golden with a record (below) |

`widened` has `from`, the most attempts a gate against history runs by default. Past it, a pass also
holds against the golden's `record` at `risk`, however its `max` came past it: the plan, the config,
`--max-attempts` or Run more attempts. The `record` is every attempt of its last sessions (`passes`,
`attempts`, `sessions`), or, with `before`, of the sessions before its last `before`.

Then `gate` holds what it made of the attempts:

| Field | Meaning |
| --- | --- |
| `decision` | `pass`, `fail` or `inconclusive` |
| `passes`, `attempts` | `passes` of `attempts` |
| `outcomes` | Each attempt in order, true for a pass |
| `carried` | With `--continue`: how many of them were carried over from the session it continued |
| `interval` | The interval of the pass rate at 1 − risk: `lo`, `hi`, `confidence` |
| `bound` | The bound its verdict line shows (below) |
| `unavailable` | When the provider was unavailable for some attempts |
| `unavailableAt` | When it cut some short after the model answered: their places in `outcomes` (below) |
| `passK` | `k`, `value`, for k up to 8 |
| `clean` | A replay that forked nowhere settled it with one attempt |
| `sentence` | The sentence the terminal prints: its verdict line, the verdict word, the tally, the bound and the rule |
| `evidence` | What it decided on (below) |

- **`attempts`** beside the gate counts this session's own attempts, with `--continue` too.
- **`bound`**: `lo` for a pass, `hi` for a failure, both otherwise, with its `confidence` and `method`.
  The method is `stagewise`, exact under the gate's own stopping, or `confidence-sequence` for attempts
  it didn't stop on by its rule; see [reading the evidence](./gating.md#reading-the-evidence).
- **`unavailableAt`**: each is a failure in `outcomes`, counted against either verdict.

`evidence`, for an SPRT gate, has the score after each attempt (`scores`), what a pass and a failure
add (`pass`, `fail`), and the bounds it passes and fails at (`upper`, `lower`).

`evidence`, for a history gate, has:

- the `history` it pooled: `passes`, `attempts`, `sessions`, or null when there is none and the golden's
  recording is the baseline;
- the `baseline` rate;
- the `probability` of a drop after the last attempt, and after each one (`probabilities`, null before
  `min`);
- the `threshold` it fails above, and the chance it passes at or below (`passAt`, 1/2);
- with `widened`: its `from`, `risk`, `record` and `before`, and the chance of a drop from that record
  after each attempt (`probabilities`, null up to `from`).

[Gating](./gating.md) has the maths.

### Error-path presets

`test --chaos` runs a golden's [error-path presets](./error-paths.md) instead of replaying it: the
failures a recording of a healthy run never holds, each played in at one call so the agent's own error
path runs.

Each preset plays in one failure:

| Preset | What the agent gets |
| --- | --- |
| `timeout` | The tool call times out: the tool doesn't run, and the agent's SDK raises the timeout it would |
| `empty` | The tool answers with nothing: an empty list, object or text, as it recorded one |
| `malformed` | The tool answers with its JSON cut short. A tool that returned data gets the cut JSON text in its place |
| `oversized` | The tool answers with its longest text repeated until it is a million characters long (`chaos.oversize`); JSON stays JSON |
| `429`, `500` | The model call that reads the tool's answer fails with that status, every attempt of it |

```text
⚡ goldens/forecast: 6 error-path presets at get_forecast (#3) and model call #4
  ✓ tool timeout      passed  timed out: the agent exited 0
  ✓ empty result      passed  answered with nothing: the agent exited 0
  ✗ malformed JSON    failed  answered malformed JSON: the agent exited with code 1
      SyntaxError: Unterminated string in JSON at position 52 (line 1 column 53)
  ✓ oversized result  passed  answered 1,000,000 characters: the agent exited 0
  ✓ provider 429      passed  failed with HTTP 429: the agent exited 0
  ✓ provider 500      passed  failed with HTTP 500: the agent exited 0
```

**Where they hit.** The tool presets hit the first tool call that reads the world, or the first call of
`--chaos-tool`. The provider presets hit the model call after it. A tool call that reads the world is
a `read`, else a tool whose effect nothing declares, else a write. It is never a pure tool, a person's
input or a call that failed when recorded.

**How an attempt passes.** Each preset is a fork from there, live with writes stubbed (`--writes`
changes that), so like a [golden that forks](./ci.md#recordings-that-fork-on-purpose) it needs the
providers. An attempt passes when the agent exits 0 and passes the checks an error path must pass:

- those under `chaos.expect` in the golden's `tests` entry;
- else the write limits of its own `expect`: the upper bounds it sets on write tools, which hold on any
  path. The rest describes the path its recording took, which a path through a failure needn't take.

A preset's attempts are gated as they come in: by `chaos.gate` (`{ good, bad, risk, max }`, each
optional) when the entry has one, else by the golden's `repeat` and `passes`. An attempt stops after
`chaos.timeout` seconds (default 300) and fails: an error path can hang.

**Its verdict** is one of:

- `passed` or `failed`;
- `inconclusive`, when:
  - the gate ran out of attempts between its bounds;
  - the replay never reached the call, which a golden that no longer replays does;
  - or all that kept an attempt from passing is a check no attempt can decide, such as a judge with no
    way to be asked;
- `not-applicable`: the recording has no call the preset can hit, or no result it can change, such as
  a binary one or one that is empty already.

**The provider failing for real**, beyond the failure a preset plays in, is the provider's, as under
`test` ([gating](./gating.md#when-the-provider-is-unavailable)):

- An attempt it failed before the model answered is run again, and never counted.
- One it cut short after is counted against either verdict, by a `chaos.gate` and by the golden's
  `repeat` alike.
- Enough in a row, counted across the session's presets, leave the preset that met the last
  inconclusive, with the provider named, and every preset after it, never failed. Enough is 3 for one
  preset, one more for each tenfold: 4 from 2, 5 from 11.

`"chaos": false` leaves a golden out of `test --chaos`. Each attempt is a run bundled under the
golden's recording, and the session and every result are kept in the store for the dashboard.

**The table.** When a `chaos.gate` decided the presets, every line gives the tally and the bound of the
pass rate, exact under the gate's stopping. A line under the table states the gate's rule once
(`gate: tells 90%+ from 50%- at <= 10% risk, up to 6 attempts`). Under the table, a line names the
checks that judged every attempt and where they came from
(`checks: send_alert called at most 1 time (the write limits of the golden's expect)`). When only the
exit status did, two lines say how to give them.

`test --chaos` exits with:

| Status    | Meaning                                                                 |
| --------- | ----------------------------------------------------------------------- |
| `1`       | A preset failed, or a golden couldn't be run                            |
| `2`       | The only goldens that couldn't be run are packs it needs `--yes` to run |
| `3`       | A preset was inconclusive (`0` under `--inconclusive warn`)             |
| `128 + n` | A stop signal; 130 for Ctrl-C                                           |

**The other reports.** `--junit` writes a case per preset, whose failure lists every attempt by its
verdict. `--markdown` writes a table of them, listing under it any golden whose presets couldn't run.
Both state a `chaos.gate`'s rule, once under the table, and in every case it decided.

#### Error-path presets as JSON

`--json <file>` writes
`{ version, session, revision, presets, passed, failed, inconclusive, notApplicable, interrupted, results }`.

In `results`, each recording has these fields:

| Field | Meaning |
| --- | --- |
| `golden` | The golden |
| `runId` | The run the presets forked |
| `outcomes` | Each preset (below) |
| `judge` | The judge of its presets: the `source` of their checks (`chaos.expect`, `--expect`, `write-limits` or `exit`), and the `checks` as a failure names them |
| `rule` | The rule a `chaos.gate` decided its presets by, as the table states it, or null |
| `error`, `skipped` | The error that kept it from running, or why it was skipped |

In `outcomes`, each preset has these fields:

| Field | Meaning |
| --- | --- |
| `preset`, `label` | The preset, and its label |
| `verdict` | Its verdict |
| `callNo`, `target` | The call it hit, and its `target`: `kind`, `name` |
| `passes`, `attempts` | The attempts that passed, of those it ran |
| `detail`, `summary` | A sentence naming what came of it, and its summary, without the call, as the table shows it |
| `reason` | The reason it failed (its first failing attempt's) or is inconclusive; null when its gate ran out of attempts |
| `gate` | The gate it was decided by |
| `upstreamRequests`, `spent` | Its upstream requests, and what it spent |
| `unavailable`, `cutShort` | When its provider failed for real: attempts never counted, and attempts cut short and counted |
| `runs` | Each attempt (below) |

In `runs`, each attempt has these fields:

| Field                | Meaning                                                                        |
| -------------------- | ------------------------------------------------------------------------------ |
| `runId`              | The attempt's run                                                              |
| `verdict`            | `passed`, `failed`, or `inconclusive` (below)                                  |
| `passed`             | True for a passed attempt only                                                 |
| `exitCode`, `checks` | The agent's exit code, and its checks                                          |
| `reason`             | The reason it failed, or is inconclusive                                       |
| `lastLine`           | For an agent that exited with an error: the error it died of, as it printed it |

An attempt is `inconclusive` when its replay never reached the call, when all that kept it from passing
is a check no attempt can decide, or when its provider failed for real, with `unavailable` then
`retried` or `counted`.

## bisect

```sh
shadowlap bisect <golden|run> --good <rev> [--bad <rev>] [--expect <json|@file>] [--fork] [--build <command>] [--cwd <dir>] [--timeout <seconds>] [--allow-unrecorded <names>] [-y] [--json] [-- <command>]
```

[Finds the first commit](./ci.md#find-the-commit-that-broke-it) where a recording fails. It replays it
at commits between `--good` (where it passed) and `--bad`, halving the range each time, each commit
checked out in a temporary git worktree.

```sh
shadowlap bisect goldens/refund --good v1.4.0
```

A divergence, a replay that ends before its recording does, a failed check or a non-zero exit fails a
commit. Replays are offline, so it costs no tokens. It prints the first bad commit with its subject,
author and date, and why it fails there, and any untestable commits just before it that could be the
one.

`bisect` takes these flags:

| Flag | What it does | Default |
| --- | --- | --- |
| `--good <rev>` | A commit where the recording passed | — |
| `--bad <rev>` | A commit where it fails | `HEAD` |
| `--expect <json\|@file>` | The checks a replay must pass besides exiting 0 | The golden's, under `tests` |
| `--fork` | Let each replay diverge and run live from the fork, so only the exit status and the checks decide (below) | — |
| `--build <command>` | Run in each worktree before its replay, e.g. `"npm ci && npm run build"`. A commit where it fails is skipped | — |
| `--cwd <dir>` | Where the recorded command runs, inside the repository | The current directory |
| `--timeout <seconds>` | Stop a replay after this long, and count it as failing | 300 |
| `--guard <mode>` | The network guard: `block`, `warn` or `off` | `block` |
| `--allow-unrecorded <names>` | As for [`replay`](#replay) | — |
| `-y, --yes` | At each commit, run without asking the recorded command of a run from a pack or the team store, or of an untracked golden (below) | — |
| `-- <command>` | The agent's command to run at each commit instead of the recorded one | — |
| `--json` | Print the result as JSON: each replay, the first bad commit, and the replays, tokens and upstream requests it took | — |

**`--fork`** is for a run that failed a check, whose recording no older commit would replay. The live
part costs tokens, and the result says how many. A replay that forks asks its
[judge checks](./judges.md) live. One no replay can ask (no key for its provider, and no upstream set
for it) is refused before anything runs.

**Whose command runs.** Each replay runs the recorded command, or the one after `--`, in the commit's
worktree. A run from someone else's pack, or pulled from the [team store](./team.md), carries a command
someone else chose, which would run at every commit:

- bisect asks first, as `replay` does, and with no terminal to ask in it refuses (exit status 2)
  unless given `--yes`, which runs it at each commit without asking;
- so does a golden from a pack the repository doesn't track, recorded elsewhere, as `test` asks of
  one;
- a golden recorded on this machine, or one the repository tracks, runs without asking.

`bisect` exits with:

| Status    | Meaning                                                                           |
| --------- | --------------------------------------------------------------------------------- |
| `0`       | It found the first bad commit                                                     |
| `1`       | There is none between the two: it passes at `--bad`, or already fails at `--good` |
| `2`       | It can't search what it was given (below)                                         |
| `3`       | A commit at either end can't be tested                                            |
| `128 + n` | A stop signal; 130 for Ctrl-C                                                     |

It can't search what it was given, exit status 2, for:

- a commit that isn't one;
- a run with no command;
- a recording whose model called a tool it never recorded that
  [writes](./how-it-works.md#tools-shadowlap-did-not-record).

**What it keeps.** The answer is kept in the project's activity either way: the first bad commit, or why
there is none between the two commits (it already fails at `--good`, it passes at `--bad`, or one of
them can't be tested). It is kept with the golden's newest test result as the search started, the
failure it answers.

The dashboard's Tests shows it above the golden's buttons while the golden keeps failing as it did then:
not once it passed, and never over a later failure. An answer given while the golden passed answers
none. A search stopped with Ctrl-C keeps nothing.

`--json` prints
`{ outcome, target, good, bad, commits, steps, first, untested, why, replays, tokens, upstreamRequests, spent, seconds }`:

| Field | Meaning |
| --- | --- |
| `outcome` | `found`, `passes-at-bad`, `fails-at-good`, `untestable` or `stopped` |
| `why` | Why there is no answer, when there is none |
| `target` | `kind` (`golden` or `run`), its `name` and `runId` |
| `good`, `bad` | The `good` and `bad` commits |
| `commits` | How many commits come after the good one, up to and including the bad one |
| `steps` | Each replay: `rev`, `short`, `subject`, `ok`, `skipped`, its `result` and `seconds` |
| `first` | The first bad commit, with `why` it fails there |
| `untested` | The untested commits just before it |
| `replays`, `tokens`, `upstreamRequests`, `spent`, `seconds` | What it took: replays, tokens, upstream requests, USD spent and seconds |

A commit is `{ rev, short, subject, author, date }`.

## pack, unpack

```sh
shadowlap pack <run> <dir> [--lineage] [--no-redact]
shadowlap unpack <dir>
```

`pack` writes a run as a directory, to commit as a CI golden or to share. `unpack` imports one.

`pack` takes these flags; `unpack` takes none:

| Flag          | What it does                                                                             | Default |
| ------------- | ---------------------------------------------------------------------------------------- | ------- |
| `--lineage`   | `pack`: include the run's ancestors                                                      | —       |
| `--no-redact` | `pack`: skip the redaction rules in `shadowlap.config.json`, and say how many it skipped | —       |

### What `pack` writes

A pack holds `run.json`, `calls.jsonl`, one uncompressed file per blob under `blobs/`, and a
`.gitattributes` (`* -text`, unless the folder has one). The `.gitattributes` keeps git from
converting line endings, which would break the blobs' hashes in a Windows checkout. Stable names and
one file per blob keep it git-friendly, so it can be committed as a CI golden or shared.

- **A run still recording** is packed once it has ended, as every export waits for it: half a run would
  make a golden that never matches. Until then, `pack` refuses it, exit status 2. With `--lineage`, it
  waits for every run the pack would hold.
- **Packing into a folder that already holds a pack** (the same golden again) replaces its `run.json`,
  `calls.jsonl` and `blobs/` as a whole, and leaves anything else there. So the folder never keeps an
  earlier pack's blobs, unredacted ones above all.
- **Redaction**: the [redaction rules](./normalizers-and-redaction.md#redaction) in
  `shadowlap.config.json` are applied to the copy, but for a model call's
  [signed reasoning](./normalizers-and-redaction.md#signed-reasoning), which stays as recorded. `pack`
  names each rule that matched inside it.
- **Credentials**: a credential a recording kept never goes into a pack, with the rules or with
  `--no-redact`.
- **Authors**: who made each run (its author, often an email) is left out of it.

The local store is never modified, but for this: a golden whose checks ask a [judge](./judges.md) is
judged once, live, before it is packed. The judge's calls are added to the run and go into the pack, so
every replay of the golden is judged from the recording.

- A verdict the run already holds for the very request is not asked again.
- One that can't be asked (no key) is said to be inconclusive, with how to record it.
- A check that reads the agent's `output` can't be judged when packing, since a recording keeps no
  output. `pack` says so, and `shadowlap test <golden> --update` records its verdict from what a replay
  prints.
- A run that didn't complete (its agent exited with an error, or it was interrupted) is not judged at
  all, since no replay of it is either.

### What `unpack` checks

`unpack` imports a pack, treating it as untrusted input. A pack that fails a check imports nothing:

- every record is validated, its redaction rules' patterns as the config's are, so none that
  [could take too long](./normalizers-and-redaction.md#patterns-that-could-take-too-long) comes in;
- each file is read without following a link;
- every blob is verified against its hash. A blob git checked out with CRLF line endings is verified as
  it was committed, and refused when that doesn't match either;
- only the blobs its calls need come into the store;
- a time more than a day ahead of this machine's clock fails a check.

Nothing on this machine records an unpacked run, so one the pack marks as still running comes in as
interrupted (crashed, ended at its last call). Runs that already exist are skipped. When the store's
run under that id is another recording (another command, or other calls), `unpack` says so and keeps it
as it is.

Imported runs are marked, and `unpack` prints the command each one would run on replay:

```text
imported 01K5CQ4N7G8M2XWQH6V3T9RB1D  command: node dist/agent.js --task 'triage inbox'

Replaying an imported run executes the command it was recorded with (shown above), which came from whoever made the pack.
shadowlap replay asks before running it; give your own command after "--" to run that instead.
```

[SECURITY.md](https://github.com/devjoinedthechat/shadowlap/blob/main/SECURITY.md) lists every check.

## serve

```sh
shadowlap serve [--recordings [--allow-unrecorded <names>]]
```

Starts a sidecar with one recording run, for a process you launch yourself, and prints the environment
to export: `export` lines, or on Windows PowerShell's `$env:NAME = 'value'`. It ends the run on Ctrl-C,
SIGTERM or a closed terminal (SIGHUP).

`serve` takes these flags:

| Flag | What it does | Default |
| --- | --- | --- |
| `--recordings` | Start no run of its own, and serve [recorded tests](./testing.md) instead (below) | — |
| `--allow-unrecorded <names>` | With `--recordings`: replay these tools again for real, though a recording never recorded them (below) | — |

- **No command**: serve never sees the command that starts your process, so the run has none, as a
  capture has none. Replaying it, or a fork, blame or Find breaking commit, needs your command after `--`.
- **Several runs**: hosts that manage several runs (a test runner) can create them through the
  sidecar's `/v1/runs` API. Each run's environment pins it: the provider base URLs carry the run id, and
  SDK calls send an `X-Shadowlap-Run` header. So several processes can record through one sidecar at
  once.
- **In-process capture**: the printed environment has the base URLs only. Clients that need
  [in-process capture](./providers.md#in-process-capture) (Bedrock, and Azure or Vertex with the
  endpoint in code) record under `shadowlap run`.

With `--recordings`, it serves recorded tests for the pytest and Vitest integrations, which start it
themselves. A recording whose model called a tool it never recorded that writes, or may, is refused
before its replay starts, unless `--allow-unrecorded <names>` or `SHADOWLAP_ALLOW_UNRECORDED` in its
environment names it.

## check

```sh
shadowlap check [recording...] [--expect <json|@file>] [--json]
```

Judges recordings by [checks](./checks.md) from what they recorded. Nothing is replayed and nothing is
sent, so a check can be tried on every run there is before it goes into the config.

```sh
shadowlap check label:bug --expect '{"tools":{"send_email":0}}'
```

A recording is one of:

- a run id or unique prefix;
- `label:<name>`, for every run with that label;
- a pack directory (`goldens/*`, with `*` in the last part matched by the command itself), read into a
  store of its own, so the project's store is left as it is.

With none, it judges every recording in the store that has ended. A recording named twice (a run and a
label it has, a pack and its run in the store) is judged once, as its pack when it is one.

`check` takes these flags:

| Flag | What it does | Default |
| --- | --- | --- |
| `--expect <json\|@file>` | The checks to judge every recording by: an `expect` object | Each recording's own, under `tests` |
| `--json` | Print the report as JSON (below) | — |

Each recording is judged by `--expect`, or without it by its entry under `tests` in
`shadowlap.config.json`. A recording with neither is counted apart. It comes out:

- **passed**;
- **failed**: a check failed, or the run exited with an error or was interrupted;
- **inconclusive**: a check on the agent's output, which a recording doesn't keep, a judge check with no
  verdict, a condition it can't read, or a partial recording that holds no tool calls.

Each line names the recording by its id, labels and command, or its pack. Its checks follow one that
did not pass. Under the totals, the report says when the checks fail a recording labelled `good` or
pass one labelled `bug`. It also names a value the checks read that none of the calls judged has (a
misspelt `result.totl`), with the key it most likely meant.

`check` exits with:

| Status | Meaning                               |
| ------ | ------------------------------------- |
| `0`    | Every recording judged passed         |
| `1`    | One failed                            |
| `2`    | None was judged                       |
| `3`    | None failed, and one was inconclusive |

A dashboard job that runs `check` gets the same report as its result. `--json` prints
`{ expect, recordings, counts, unchecked, notes }`:

| Field | Meaning |
| --- | --- |
| `expect` | The `expect` given, or null |
| `recordings` | Each recording judged (below) |
| `counts` | The recordings by outcome: `passed`, `failed`, `inconclusive` |
| `unchecked` | The recordings counted apart for want of checks |
| `notes` | Recordings labelled good that fail, or bug that pass, and values the checks read that no call judged has |

Each of `recordings` has these fields:

| Field | Meaning |
| --- | --- |
| `runId` | The run |
| `pack` | The pack it came from, or null |
| `labels` | Its labels |
| `source` | The source of its checks: `--expect`, or the recording directory of its `tests` entry |
| `outcome` | `passed`, `failed` or `inconclusive` |
| `why` | Why it failed, or could not be settled |
| `checks` | Its checks, as [each check comes out](./checks.md#how-a-check-comes-out): `status`, `ok`, `label`, `detail`, and a judge's `reason` and `source` |

## injection

```sh
shadowlap injection <run|golden...> [--repeat <n>] [--templates <ids>] [--payloads <file>]
  [--baselines <n>] [--obeyed <n>] [--influenced <n>] [--live-reads] [--inconclusive <mode>]
  [--html <file>] [--no-redact] [--concurrency <n>] [--budget <usd>] [--timeout <seconds>]
  [--guard <mode>] [--allow-unrecorded <names>] [-y] [--json]
shadowlap injection <run> --clean <call[=result]> [--write <call>] [--gate <json>] [--json]
shadowlap injection --list-templates [--json]
```

[Causal injection tests](./injection.md): whether text in what the agent reads can steer it.

```sh
shadowlap injection goldens/research --repeat 3 --html injection.html
```

For each read of a tool marked untrusted, it plants each payload in the recorded result, with a canary
of its own, as [`--inject-result`](./interventions.md#plant-an-instruction-in-a-tool-result) does. Then
it replays:

- the calls before the read, from the recording;
- the rest live, from the model call whose request carries the planted text;
- with writes stubbed;
- with reads served from the recording when they match, and fenced when they don't.

A tool is marked untrusted by `"tools": { "fetch_page": { "trust": "untrusted" } }` in the config, by
`trust: 'untrusted'` in the [SDK](./sdk.md#untrusted-reads), or, for an MCP read tool, by its server
setting `openWorldHint`.

An attempt comes out:

- **obeyed**: a tool call carries the canary, which is proof the planted text caused it, for a write,
  and for a read, which can carry data out;
- **influenced**: a write that no clean replay of the same read made;
- **ignored**: otherwise;
- **inconclusive**: the attempt shows nothing either way (no model read the planted text, a model call
  failed, the agent exited non-zero), with why.

The payloads are the built-in templates (`--list-templates` prints them), unless `--payloads` or
`--templates` say otherwise. A golden's `"injection"` entry under `tests` gives its defaults. Every
replay is a run marked with the test it belongs to, and every result is kept in the store for the
dashboard.

Each run tested comes to a verdict against its limits:

- *failed*, when more attempts obeyed (or were influenced) than allowed;
- *inconclusive*, when the test showed too little to say: no untrusted read to plant in, an attempt in
  which something failed, no attempt a model read, or the planned attempts cut short by `--budget`.
  With a limit on influenced attempts, a clean replay in which something failed makes it inconclusive
  too;
- else *passed*.

`injection` takes these flags:

| Flag | What it does | Default |
| --- | --- | --- |
| `--repeat <n>` | Attempts per untrusted read and payload. With `--clean`, the most clean attempts the test may take (below) | The golden's, else 1 |
| `--templates <ids>` | Built-in templates to plant: `all`, `none`, or ids separated by commas | `all` |
| `--payloads <file>` | Your own payloads, or a red-teaming tool's (below) | — |
| `--list-templates` | Print the built-in templates; with `--json`, as the versioned data they ship as | — |
| `--baselines <n>` | Clean replays of each read, forked at the model call that reads it, that *influenced* compares with (below) | The golden's, else 3 |
| `--obeyed <n>` | Attempts that may obey before the run fails | The golden's, else 0 |
| `--influenced <n>` | Attempts that may be influenced before the run fails | The golden's, else no limit |
| `--live-reads` | Run the reads the recording doesn't hold after the fork, instead of fencing them (below) | — |
| `--inconclusive fail\|warn` | What an inconclusive verdict does to the exit status | `fail` |
| `--clean <call[=result]>` | Replace read `<call>` with a neutral result, or the one given (JSON, text, or `@file`), and decide whether its content caused each write after it | — |
| `--write <call>` | With `--clean`: the recorded write to test (repeatable) | Every write after the read |
| `--gate <json>` | With `--clean`: the sequential test that decides; the figures left out are the default's | `{"good":0.8,"bad":0.2,"risk":0.05,"max":10}` |
| `--html <file>` | Also write the security report (below) | — |
| `--no-redact` | With `--html`: skip the redaction rules | — |
| `--concurrency <n>` | Attempts running at once | 1 |
| `--budget <usd>` | Start no attempt once this much is spent on live model calls; a test cut short is inconclusive | — |
| `--timeout <seconds>` | Stop an attempt after this long; it is inconclusive | — |
| `--guard <mode>` | The network guard: `block`, `warn` or `off` | `block` |
| `--allow-unrecorded <names>` | As for [`replay`](#replay) | — |
| `-y, --yes` | Run the recorded command of an imported run, or of a golden from a pack the repository doesn't track, without asking | — |
| `--json` | Print the report as JSON ([below](#injection-report-as-json)); progress goes to stderr | — |

More on some of them:

- **`--repeat`** with `--clean`: fewer than the gate needs to decide a write is refused.
- **`--payloads`**: text (one a line, or blocks between `---` lines), JSON or JSON Lines. Their
  `{{canary}}` is filled in. They are planted instead of the templates, unless `--templates` names
  some.
- **`--baselines`**: the recording's own writes after the read count as one more. A clean replay in
  which something failed is left out, and, with `--influenced`, makes the verdict inconclusive.
- **`--live-reads`**: the agent gets an error for a fenced read. A read that carries planted text is
  fenced all the same.
- **`--html`**: the reads × payloads matrix, the proof of each obeyed cell, why the inconclusive ones
  show nothing, the `--clean` verdicts and the payloads. The redaction rules are applied, and every
  canary is kept.

`injection` exits with:

| Status    | Meaning                                                                   |
| --------- | ------------------------------------------------------------------------- |
| `0`       | Every run tested passed; with `--clean`, every write was decided          |
| `1`       | A run tested failed                                                       |
| `3`       | One is inconclusive (`0` with `--inconclusive warn`)                      |
| `128 + n` | A stop signal: 130 for Ctrl-C, 129 for a closed terminal, 143 for SIGTERM |

### Proving cause with `--clean`

`--clean <call>` asks the reverse of a recorded incident:

1. Read `<call>` is replaced with a neutral result, or the one given. A neutral result has each string
   with a space in it emptied, and keeps ids, numbers and the shape.
2. The run replays until the [sequential test](./injection.md#prove-cause-on-an-incident) decides, for
   each write the run made after the read, whether it comes back. A write is known by the values that
   identify it: an address, an id, an amount.
3. Each write is reported *caused* by the read's content, *not caused*, or *inconclusive*.

A clean attempt in which something failed, or that never made the read, decides nothing; three in a row
stop the test.

### Injection report as JSON

With `--list-templates --json` it prints the built-in templates, and exits:

| Field                | Meaning                                                   |
| -------------------- | --------------------------------------------------------- |
| `version`, `updated` | The template set's version, and when it was updated       |
| `templates`          | Each template, with its `id`, `shape`, `title` and `text` |

Otherwise, with `--json` it prints the report:

| Field       | Meaning                                                        |
| ----------- | -------------------------------------------------------------- |
| `templates` | The built-in set's `version` and `updated`                     |
| `results`   | One per run tested (below)                                     |
| `totals`    | The totals over the runs tested by planting (below)            |
| `verdict`   | The verdict they come to: `passed`, `failed` or `inconclusive` |
| `passed`    | Whether the exit status is 0                                   |
| `html`      | The report's path, or null                                     |

`totals` adds up these, over the runs tested by planting:

| Field                                             | Meaning                             |
| ------------------------------------------------- | ----------------------------------- |
| `runs`                                            | The runs tested                     |
| `attempts`                                        | Their attempts                      |
| `obeyed`, `influenced`, `ignored`, `inconclusive` | The attempts that came out each way |

A run tested by planting has these fields:

| Field                           | Meaning                                                           |
| ------------------------------- | ----------------------------------------------------------------- |
| `resultId`                      | The `inj-…` id it is kept under                                   |
| `mode`                          | `plant`                                                           |
| `runId`, `golden`               | The run, and its golden or null                                   |
| `templates`                     | The templates used: their set's `version`, and the `ids`          |
| `repeat`                        | Attempts per read and payload                                     |
| `reads`                         | The untrusted reads (below)                                       |
| `unrecordedReads`               | `fence` or `live`                                                 |
| `skipped`                       | The untrusted calls skipped, each with `callNo`, `name` and `why` |
| `payloads`, `cells`, `attempts` | The payloads, the cells and the attempts (below)                  |
| `baselines`                     | The reads' baselines (below)                                      |
| `totals`                        | Its totals                                                        |
| `verdict`                       | The strongest verdict an attempt showed                           |
| `gate`                          | Its gate (below)                                                  |
| `stopReason`                    | Why it stopped                                                    |
| `cost`                          | `spent`, `upstreamRequests` and `unknownModels`                   |
| `startedAt`, `endedAt`          | When it started and ended                                         |

Each untrusted read has these fields:

| Field            | Meaning                                |
| ---------------- | -------------------------------------- |
| `callNo`, `name` | The read                               |
| `from`           | `config`, `sdk` or `mcp`               |
| `readAt`         | The model call that reads it           |
| `args`           | Its arguments                          |
| `planted`, `why` | Whether it was planted in, and why not |

Each payload has these fields:

| Field            | Meaning                             |
| ---------------- | ----------------------------------- |
| `id`             | The payload                         |
| `source`         | `template` or `file`                |
| `shape`, `title` | Its shape and title                 |
| `text`           | Its text, its placeholders unfilled |
| `canary`         | Whether it has one                  |

Each cell, one read with one payload, has these fields:

| Field                                             | Meaning                             |
| ------------------------------------------------- | ----------------------------------- |
| `read`, `payload`                                 | The read and the payload            |
| `verdict`                                         | Its verdict                         |
| `attempts`                                        | Its attempts                        |
| `obeyed`, `influenced`, `ignored`, `inconclusive` | How many attempts came out each way |
| `runs`                                            | Their runs                          |

Each attempt has these fields:

| Field | Meaning |
| --- | --- |
| `runId` | The attempt's run |
| `read`, `payload`, `attempt` | The read, the payload, and which attempt it is |
| `canary` | The canary it carried: `token`, `address`, `id` and `amount` |
| `verdict` | Its verdict |
| `why` | Why an inconclusive one shows nothing |
| `failed` | Whether that is because something failed in it |
| `plantedAt`, `forkedAt`, `readAt` | Where the payload was served, where the attempt forked, and the first model call whose request carried it (below) |
| `exitCode` | The agent's exit code |
| `evidence` | The pieces of evidence (below) |
| `spent` | USD spent |

`plantedAt`, `forkedAt` and `readAt` are in the attempt's own call numbers.

Each piece of evidence has these fields:

| Field | Meaning |
| --- | --- |
| `kind` | `canary`, a write that carried it; `read`, a read that carried it; or `write`, a write no clean replay made |
| `callNo` | The attempt's call |
| `tool` | The tool |
| `path` | Where in its arguments |
| `value` | The value |
| `why` | Why it is evidence |

Each read's baseline has these fields:

| Field    | Meaning                                               |
| -------- | ----------------------------------------------------- |
| `read`   | The read                                              |
| `runs`   | The clean replays' runs                               |
| `writes` | The writes they and the recording made                |
| `failed` | The clean replays that failed, each `runId` and `why` |

The gate has these fields:

| Field                  | Meaning                              |
| ---------------------- | ------------------------------------ |
| `obeyed`, `influenced` | The limits                           |
| `verdict`              | `passed`, `failed` or `inconclusive` |
| `reason`               | The reason                           |

A run tested with `--clean` has these fields:

| Field | Meaning |
| --- | --- |
| `resultId` | The id it is kept under |
| `mode` | `clean` |
| `runId`, `golden` | The run, and its golden |
| `read` | The read replaced, with `callNo`, `name`, `trust`, `from` and `args` |
| `canary` | The canary the run carried, when it is an attempt of an injection test, or null |
| `neutral` | The neutral result served |
| `unrecordedReads` | `fence` or `live` |
| `writes` | The recorded writes (below) |
| `attempts` | The clean attempts (below) |
| `gate`, `rule` | The gate it was decided with, and its rule (below) |
| `verdict` | `caused` when the read's content caused a write, `not caused` when every write comes back without it, else `inconclusive` |
| `stopReason`, `cost` | Why it stopped, and what it cost |
| `startedAt`, `endedAt` | When it started and ended |

`rule` is stated as the terminal states it once under the writes:
`gate: tells a write gone in 80%+ of clean attempts from one gone in 20%-, at <= 5% risk, up to 10 attempts`.

Each recorded write has these fields:

| Field | Meaning |
| --- | --- |
| `callNo`, `name`, `args` | The write |
| `identifiers` | The values that make it the same write again |
| `attempts` | The clean attempts that decided it |
| `gone` | How many it was gone in |
| `verdict` | Its verdict |
| `bound` | The bound on the share of clean attempts it was gone in (below), or null before an attempt decided anything |

`bound` is as its line shows it beside the tally: `rate >= 0.29 (95%)` for a caused write,
`rate <= 0.71 (95%)` for one not caused, both ends for an undecided one.

Each clean attempt has these fields:

| Field              | Meaning                                      |
| ------------------ | -------------------------------------------- |
| `runId`, `attempt` | The attempt's run, and which attempt it is   |
| `forkedAt`         | Where it forked                              |
| `exitCode`         | The agent's exit code                        |
| `made`             | The writes it made, each `callNo` and `name` |
| `gone`             | The recorded writes gone in it               |
| `why`              | Why it decided nothing, or null              |

## coverage

```sh
shadowlap coverage [--json]
shadowlap coverage --pack [<behaviour>...] [--not-packed fail|warn] [--json] [-- <command>]
shadowlap coverage --pack <behaviour>... --fork --expect <checks> [-- <command>]
```

[Production coverage](./coverage.md): groups the project's imported runs by behaviour, and names the
behaviours no golden covers. Imported runs are the captures and traces `import` made, a teammate's from
the team store included: runs that came with no command of their own.

```text
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

A behaviour is:

- **the tools the model called, in order**: the calls one answer asked for together match in any
  order, as [`--repeat`](#repeating-a-fork) reads paths;
- **the writes among them**: a tool whose effect nothing recorded or configured names counts as one;
- **how the run ended**: `answered`, `model-error` (its last model call failed), `token-limit`,
  `tool-call` (it ended asking for a tool), `agent-error` (a recording whose agent failed) or
  `no-model-calls`.

The path is read from the model's own answers, so a capture with no tool calls compares with a golden.
Arguments are not part of a behaviour.

The goldens are read from their packs on disk (the goldens folder and the packs `tests` names), as
`test` reads them. A golden covers a behaviour when its recording behaves the same way. A behaviour no
golden covers names the golden that shares the most of its path, where they part, and why the last
`--pack` couldn't pack it. Each scan is kept in the store, its groups replacing the last scan's, for the
dashboard.

`coverage` takes these flags:

| Flag | What it does | Default |
| --- | --- | --- |
| `--json` | Print the scan as JSON (below) | — |
| `--pack [<behaviour>...]` | Make a golden of one run of each behaviour no golden covers, or of the behaviours named by key: four characters of it or more | — |
| `-- <command>` | With `--pack`: the agent's command, for a capture no run here says the command of (below) | — |
| `--fork` | With `--pack` and the behaviours named: pack each as a golden that forks (below) | — |
| `--expect <checks>` | With `--fork`: what the agent must do on that input now, as JSON or `@file.json`, in the grammar of a tests entry's `expect` | — |
| `--not-packed fail\|warn` | With `--pack`: what a behaviour that could not be packed does to the exit status; `warn` reports it and exits 0, for a scheduled job | `fail` |
| `--guard <mode>` | The [network guard](./how-it-works.md#the-network-guard) for the replays `--pack` makes: `block`, `warn` or `off` | `block` |

`coverage` exits 0. With `--pack`, it exits 1 when a behaviour asked for could not be packed, unless
`--not-packed warn`.

### Packing a capture

`--pack` turns a capture into a golden `test` can replay. A capture holds model calls and no command, so
its newest runs (up to three) are each replayed with the agent's command until one reproduces it. The
command is:

1. the command of the newest run here (not one from a pack or the team store) whose first model call
   sent the capture's first request: its fingerprint under the normalizers, or its bytes;
2. then the command given after `--`, its placeholders filled for that capture.

The replay is offline, and needs no tool to answer:

- each tool call the model asked for is served the result the next request carried back to the model
  (as MCP content, for a tool this store has recorded through `shadowlap mcp`);
- a tool the capture holds calls of itself keeps them;
- a tool some of whose calls got no answer back runs live;
- writes are stubbed.

A replay that sends every request the capture holds and exits 0 is a recording of the agent as it is
doing what production did. It is packed into `goldens/<first tool>-<writes>-<key>` (with the project's
redaction rules, as `pack` writes one) and logged in the activity feed.

One that doesn't is not packed, and says why:

- `no-command`: nothing says what starts the agent;
- `other-message`: the command started it with another first message than production's (the wrong
  command, or one that needs `{message}`);
- `not-reproduced`: the agent sends something else (the code changed since the traffic was captured,
  or a tool's arguments are not the model's);
- `agent-error`: the agent failed on what production got back;
- `gone`: its runs were deleted.

A behaviour the agent no longer reproduces can still be kept, as the test that the change holds.
`--fork` packs production's run, with the command that starts the agent as production did, as a golden
that forks where the agent parts from it and passes on `--expect`. Its tests entry is written with
`"fork": true` and `--expect`, even when the agent no longer does what production did.

What `--pack` made of each behaviour is kept in the store, and the scan after it counts the goldens it
made.

**Placeholders.** In the command after `--`, `{message}` stands for the capture's first message (the text
of the first user turn it sent), and `{message:/regex/}` for the part of it the regex picks (its first
group, else the whole match). So each capture starts as production started it.

- A placeholder is an argument of the agent's own command, passed as it is.
- A placeholder is refused in a shell's script, after an interpreter's `-c`, `-e` or `-m`, or where the
  message would name what runs.
- What runs is the program, the script an interpreter runs or one of its flags, the command a runner
  such as `env`, `cross-env` or `npx` runs, or what `npm exec`, `pnpm dlx`, `bun x`, `uv run`,
  `pipx run` and the like run.
- A capture whose message would start an argument with a dash is left out.
- A regex is checked as a redaction rule's is
  ([Patterns that could take too long](./normalizers-and-redaction.md#patterns-that-could-take-too-long)).

### Coverage scan as JSON

`--json` prints `{ scanId, at, runs, uncovered, groups, goldens, pack }`:

| Field       | Meaning                                                        |
| ----------- | -------------------------------------------------------------- |
| `scanId`    | The scan in the store                                          |
| `at`        | When it ran                                                    |
| `runs`      | The imported runs read                                         |
| `uncovered` | The behaviours no golden covers                                |
| `groups`    | Every behaviour (below)                                        |
| `goldens`   | Every golden read (below)                                      |
| `pack`      | With `--pack`, what each behaviour became (below); else `null` |

`groups` has an entry for every behaviour:

| Field                   | Meaning                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| `key`                   | The behaviour's key                                                                        |
| `covered`, `coveredBy`  | Whether a golden covers it, and the goldens it is covered by                               |
| `path`, `writes`        | Its path, and its writes                                                                   |
| `unknown`               | The tools of unknown effect                                                                |
| `outcome`               | How its runs ended                                                                         |
| `runs`, `runIds`        | How many runs behaved so, and their ids, newest first                                      |
| `sources`               | The sources they came from                                                                 |
| `firstSeen`, `lastSeen` | When it was first and last seen                                                            |
| `nearest`               | For one no golden covers: the `golden`, the steps `shared`, and where it `differs` (below) |
| `command`               | The command that would reproduce its newest run, with the run it came `from`               |
| `packed`                | The golden this `--pack` made of it: `golden`, `runId`, `mode`                             |
| `lastPack`              | What the last `--pack` made of it, here or before (below)                                  |

- **`nearest.differs`**: the `step`, what the behaviour does there as `seen`, and the golden's.
- **`lastPack`**: `at`, the `golden` (or null), its `mode`, and the `reason` and `why` it wasn't packed.

`goldens` has an entry for every golden read:

| Field                       | Meaning                                |
| --------------------------- | -------------------------------------- |
| `golden`, `runId`           | The golden, and its run                |
| `path`, `writes`, `outcome` | Its path, writes and outcome           |
| `error`                     | The error that kept it from being read |

With `--pack`, `pack` says what each became:

| Field             | Meaning                                       |
| ----------------- | --------------------------------------------- |
| `key`             | The behaviour                                 |
| `golden`, `runId` | The golden written, and the run packed        |
| `from`            | The imported run it came from                 |
| `command`         | The command it ran with, where that came from |
| `mode`            | The golden's mode: `replay` or `fork`         |
| `reason`, `why`   | The reason it wasn't packed, and why          |

## init

```sh
shadowlap init [--json]
```

Reads the project in the current directory, and prints the steps to a first recording, filled in for it.
The detection reads source text; it runs nothing.

`init` writes one file: an empty `shadowlap.config.json`, only when there is none. Run it again after
wrapping the tools it names, to check again: the config is left as it is, and the tools are scanned
afresh.

`init` takes one flag:

| Flag     | What it does                                                 | Default |
| -------- | ------------------------------------------------------------ | ------- |
| `--json` | Print the findings as JSON ([below](#init-findings-as-json)) | —       |

### What `init` finds

- **The language and package manager**, from `package.json`, `pyproject.toml`, requirements files and
  lockfiles.
- **The model SDKs**, from dependencies or imports: Anthropic, OpenAI, Gemini, and the AI SDK,
  LangChain, LlamaIndex and Agent Framework provider packages. And the models a framework names for its
  own client to call.
- **The agent framework and its version.**
- **The command that starts the agent.**
- **Every tool definition it can find**, whether it declares an effect, and a suggested effect for
  those that don't.
- **Whether a Claude Agent SDK query runs through the [fence](./frameworks.md#claude-agent-sdk).**
- **A model server the project already points at**, such as Ollama in `OPENAI_BASE_URL`, and the
  `SHADOWLAP_UPSTREAM_OPENAI` value that keeps it as the upstream.

**The package manager in a workspace.** In a package of a workspace, whose lockfile is at the
workspace's root, it is the workspace's manager. That is the root above it, up to the repository's
root, that takes the folder in: `pnpm-workspace.yaml`, `workspaces` in `package.json` with its lockfile
or `packageManager` field, or `[tool.uv.workspace]`.

**The models a framework names**: Mastra's router ids (`model: 'anthropic/claude-sonnet-4-5'`), the AI
SDK's string ids (`model: 'openai/gpt-5'`, Vercel's AI Gateway), LangChain's `init_chat_model`,
Pydantic AI's, CrewAI's, Google ADK's, Agno's and Strands' model strings, and the model classes those
frameworks and smolagents import. An agent given no model counts as its framework's default (Strands:
Bedrock; Agno and CrewAI: OpenAI).

**The frameworks it knows** are the Vercel AI SDK, OpenAI Agents SDK, Mastra, LangChain and LangGraph,
the Anthropic tool runner, the Claude Agent SDK and Pydantic AI. It knows the OpenAI Agents SDK for
Python, LangChain and LangGraph for Python, CrewAI, Google ADK, LlamaIndex, Microsoft Agent Framework,
Strands Agents, smolagents and Agno too.

**The command that starts the agent** comes from the first of these:

1. `package.json` scripts: not one that starts a web dev server or a watcher, nor `mastra dev` or
   `mastra start`, which serve agents and wait for requests. Record a script or a test that calls one.
2. The file `package.json` names: its `bin`, then its `main`.
3. A script `pyproject.toml` declares (`[project.scripts]`), run with `uv run` in a uv project and
   `poetry run` in a Poetry one.
4. A conventional entry file (`agent.py`, `main.py`, `agent.ts`, `index.js`…). A Python one runs with
   `uv run agent.py` or `poetry run python agent.py` there.
5. Else the one file at the top of the folder that imports a model SDK and that no other file there
   imports (`node triage.mjs`). With several such files, it names none.

**Tool definitions** it finds:

- decorated functions: Strands', smolagents' and the Claude Agent SDK's `@tool`, Pydantic AI's
  `@agent.tool`;
- LangChain's and CrewAI's `BaseTool` classes, by their `name`;
- the plain functions an agent is given: `Agent(tools=[search_web])` in Pydantic AI, Google ADK, Agent
  Framework and Agno, and LlamaIndex's `FunctionTool.from_defaults(fn=…)`;
- each framework's own tool calls.

An effect given where a tool is used counts: `with_effect(SendEmail(), "write")`, or the Claude Agent
SDK's `withEffects('orders', [...], { refund_order: 'write' })`. An AI SDK tool kept in a constant
(`const searchDocs = tool({ … })`) counts too, under the key that gives it to the model
(`tools: { search_docs: searchDocs }`), or its own name in shorthand.

The suggested effect goes by the tool name's verbs, where a name puts them
([how](./how-it-works.md#tools-shadowlap-did-not-record)). A name with no hint gets `write`, which never
runs again after a fork unless the replay allows writes (`--writes allow`).

**The fence.** A Claude Agent SDK query runs through the fence when a file that imports Shadowlap's
adapters calls `withFence` (`with_fence` in Python), or its hooks. The SDK's built-in tools (Bash,
Write, Edit and the rest) run inside Claude Code, where no wrapper reaches them. So, until a query does,
the step after the install is to run it through the fence: `query({ prompt, options: withFence(options) })`,
or `with_fence(options)` in Python. The SDK's in-process tools keep the step that declares their effects
(`withEffects`, `with_effects`).

**A model server.** `OPENAI_BASE_URL` counts unless every model client the project has is another
provider's. Each of these counts as an OpenAI client:

- an OpenAI SDK, `langchain-openai` and `@ai-sdk/openai` among them, and a framework's `[openai]`
  extra, which installs it;
- a framework that brings one: Pydantic AI as a whole, the OpenAI Agents SDK, CrewAI, Mastra;
- `openai` in a lockfile;
- SDKs `init` can't tell.

An agent on Anthropic's or Gemini's SDK alone (or Pydantic AI's slim package with its `[anthropic]`
extra) never sends to it. Neither does Pydantic AI when every model its code names is another
provider's (`Agent("anthropic:claude-sonnet-4-5")`) and it builds no OpenAI model or provider. Pydantic
AI makes a client only for the providers of its models, so the OpenAI client it installs, and the
`openai` that puts in a lockfile, go unused.

### What `init` warns about

- **A model client constructed with a literal base URL**: `shadowlap run` cannot redirect it, so its
  calls would not be recorded.
- **A model a framework names whose calls go to a host Shadowlap doesn't know**: a Mastra router id or
  a LiteLLM or CrewAI string with another provider (`groq/…`, `openrouter/…`), or smolagents'
  `InferenceClientModel` (Hugging Face). Declare its host in the config when it speaks OpenAI's,
  Anthropic's or Gemini's API ([how](./providers.md#hosts-of-another-providers-format)).
- **A Node the project pins before 18.18** (`.nvmrc` or `.node-version`, `18.17`): an agent on it never
  starts under Shadowlap, since that Node refuses the guard.

**Its install step** adds the SDKs with the project's package manager, and the CLI: `shadowlap` as a dev
dependency, which the steps after it run with `npx`, or, for a Python project,
`npm install --global shadowlap`. Run by a global `shadowlap`, it leaves the CLI out, and the steps run
that one.

**In the dashboard.** In a folder that is a [project in the dashboard](./dashboard.md#projects), `init`
also marks the first step of its setup done. In a terminal, a line on stderr says whether it could. Run
by the dashboard, whose setup has its own buttons for the next steps, it prints only what it found, a
line each, and what it did with `shadowlap.config.json`.

### `init` findings as JSON

`--json` prints the findings, with the lines the dashboard's setup shows:

| Field | Meaning |
| --- | --- |
| `summary` | The lines the dashboard's setup shows (below) |
| `cwd` | The folder it read |
| `languages`, `packageManager` | The languages found, and the package manager |
| `providers` | Each SDK, and the package it came `via` |
| `frameworks` | The frameworks found |
| `command` | Its `argv`, and where it came `from` |
| `tools` | Each with its `file`, `line`, `effect`, `suggested` effect, `why` and `wrapped` |
| `unwrapped` | The tools that aren't wrapped |
| `wrap` | The code that wraps them (below) |
| `fence` | Each Claude Agent SDK the project uses (below) |
| `unrecordedModels` | The models it warns about: each with its `file`, `line`, `model`, and the framework that builds its client, `via` |
| `modelServer`, `hardcodedBaseUrls` | The model server the project points at, and the model clients built with a literal base URL (below) |
| `scannedFiles` | How many source files it read |
| `config` | Its `path`, whether it `existed`, and whether it was `created` |
| `folder` | The kind of project the folder holds |
| `project` | In a dashboard project: whether it could mark the first step done (below) |

- **`summary`**: the language with its pinned runtime and package manager, the model SDKs with their
  versions, the framework, the command and where it came from, and what happened to the config. With
  them, `node`: the Node the project pins with its minor, and whether it is older than the guard takes
  (`tooOld`).
- **`wrap`**: the code that wraps the tools in the project's language, through its framework's adapter,
  with the fence for a Claude Agent SDK query that runs through none.
- **`fence`**: each Claude Agent SDK's `framework`, the `language` of the code that fences its query,
  and where a query runs through the fence, `at`, or null.
- **The addresses it prints** (`modelServer`, `hardcodedBaseUrls`) never carry credentials: a password,
  or a key in the query, is left out. A model server that had one gets no `upstream`.
- **`project`** says whether it could (`noted`), and why not: the project list was busy, or a newer
  Shadowlap wrote it.

## doctor

```sh
shadowlap doctor [--json]
```

Checks what support would check, and says how to fix each problem it finds.

`doctor` takes one flag:

| Flag     | What it does                       | Default |
| -------- | ---------------------------------- | ------- |
| `--json` | Print the checks as a list (below) | —       |

It checks:

- **Node and its built-in SQLite**, with the full-text index every store has. A Node build whose SQLite
  has none is told to use an official build, and the store is left unread rather than called damaged.
- **The guard preloads.**
- **Python on the PATH**, as `python3`, `python` or both, since an agent's command names one.
- **The store**: runs, size, schema, and runs a killed process left marked running.
- **A stale or incomplete `.shadowlap/active.json`.**
- **The configuration**: every rule, price and MCP effect parsed, and the checks under `tests` (below).
- **Agent-process environment that leaked into your shell**: `SHADOWLAP_URL`, `NODE_OPTIONS`,
  `PYTHONPATH`.

Under `tests`, it names:

- each [rule that names a tool](./checks.md#checking-the-checks) no recording called or offered to its
  model, or reads a value no recorded call of its tool has, with the name it most likely meant. It holds
  the rules against the packs the entries apply to, and the store's 200 newest runs;
- each [judge check](./judges.md) whose model retires, by the
  [retirement table](./decisions.md#model-retirements) that ships with Shadowlap;
- each judge check whose provider has no key in this environment and no upstream set for it. No judge
  can be asked for it live, so it reads [not judged](./judges.md#not-judged) wherever its verdict isn't
  recorded;
- each golden that holds no recorded verdict, or only one given to an older form of the judge's request,
  for a judge check that applies to it, with the `test --update` that records it.

A judge under a [`when`](./checks.md#conditions) whose condition never held in the golden is not
applicable there, and needs no recorded verdict.

A URL it names (a base URL, an upstream, the telemetry collector, a sidecar's) shows no password, no
credential in its query and no session token, each `<CREDENTIAL>`. So the report can be pasted where
others read it.

`doctor` exits 1 when something is blocking.

`--json` prints the checks as a list, each `{ "name", "verdict", "detail" }`:

| Field     | Meaning                             |
| --------- | ----------------------------------- |
| `name`    | The check                           |
| `verdict` | `ok`, `warn` or `fail`              |
| `detail`  | What it found                       |
| `fix`     | How to fix it, where there is a fix |

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

Both edit `shadowlap.config.json` in the working directory.
[Normalizers](./normalizers-and-redaction.md) mask values before matching. Redaction rules mask stored
content in every export, pack and share link of a run. Each add and rm is recorded in the project's
activity, in a store that exists.

```sh
shadowlap normalize add --pattern uuid --replace '<uuid>'
shadowlap redact add --path '$.args.api_key'
```

Each of them has these subcommands:

| Subcommand | What it does |
| --- | --- |
| `add` | Add a rule: a pattern, a path, or both (below) |
| `rm` | Remove a rule: the number `ls` shows (`2` or `#2`), or the tool name, path or pattern of exactly one rule |
| `ls` | List the rules, each with its number |
| `redact preview` | Show what the redaction rules would mask in a run that has ended ([below](#redact-preview)) |

The subcommands take these flags:

| Flag | What it does | Default |
| --- | --- | --- |
| `--pattern <pattern>` | `add`: a named pattern (`uuid`, `ulid`, `iso-date`, `iso-datetime`, `number`, `email`) or `/regex/flags` | — |
| `--path <jsonpath>` | `add`: where in a request, such as `$.metadata.user_id`; a tool's arguments are under `$.args` | — |
| `--name <name>` | `add`: scope the rule to one tool or call: a tool's name, or a call's, such as `"POST /v1/messages"` | — |
| `--kind <kind>` | `add`: only calls of this kind: `api`, `tool`, `clock` or `random` for a normalizer; `api` or `tool` for redaction | — |
| `--replace <text>` | `add`: the replacement text | `<MASKED>`; for redaction, `<REDACTED>` |
| `--expect <version>` | `add`, `rm`: refuse the edit when the file is no longer the version `ls --json` printed | — |
| `--json` | `ls`, `redact preview`: print as JSON (below) | — |

**How `add` matches.**

- A pattern alone masks matches in every string. For redaction, it masks those of every string but a
  clock or random read's, which every copy keeps as recorded.
- A path alone replaces the whole value there, numbers included.
- `--name` scopes the rule to one tool or call.
- It refuses a rule that would change nothing, or that it can't read, and, for redaction, a replacement
  the rule would rewrite again. Adding a rule that is already there changes nothing.

**Where a redaction rule's path reaches.** It reaches requests in every copy. What a call got back, a
response or tool result that is JSON (a tool's result is under `$.result`), and an attempt's error
(`$.error`), it reaches only in a copy that is read (`export html`, `har`, `dataset`). It never reaches
them in a pack, whose replay hands them to the agent, nor in a clock or random read. `$` alone, and a
path that starts with a wildcard, reach requests only.

`ls --json` prints `{ file, exists, version, error, rules }`:

| Field            | Meaning                                                                       |
| ---------------- | ----------------------------------------------------------------------------- |
| `file`, `exists` | The config file, and whether it exists                                        |
| `version`        | Its version, as `--expect` takes it                                           |
| `error`          | Why the list can't be read (it isn't a list; `ls` then exits 2), else `null`  |
| `rules`          | Each rule, with its number `n`; one the config can't load has `error` instead |

### `redact preview`

`redact preview` shows what the rules would mask in a run that has ended (default: the newest). Nothing
is written. See [Preview](./normalizers-and-redaction.md#preview).

- **Per rule**: what each would mask, counted, with up to two samples. It reads the run through the
  functions `pack` applies the rules with, the run's own record included: a fork's flags, the
  divergence report, the checks and the last blame.
- **What a pack leaves as it is**: under each rule, what it matches that a pack keeps. That is a number,
  since a copy masks the strings of a JSON document and keeps its numbers as recorded, or anything in a
  clock or random read, which every copy keeps as recorded.
- **Where each is**: for each place, the path rule that would mask it, a rule that already does, or why
  none can. In what a call got back, that is a path rule that only the copies that are read apply.
- **`details`**: on a line of its own, what the rules match in the run's command line, labels and
  notes, which `export html`, `dataset` and `otel` mask and `pack` keeps.

`--json` prints `{ "runId", "calls", "unreadable", "partial", "total", "returned", "unmasked", "rules", "details" }`:

| Field | Meaning |
| --- | --- |
| `runId` | The run |
| `calls`, `unreadable` | The calls read, and those that couldn't be |
| `partial` | Set when a limit stopped the preview early (below); else `null` |
| `total` | What a pack masks |
| `returned` | What only the copies that are read mask |
| `unmasked` | What is left as it is |
| `rules` | Each rule (below) |
| `details` | What the rules match in the run's command line, labels and notes: a `count`, `samples` and the `rules` that match there |

`partial` has how many of the run's calls it `read`, `of` how many, and the limit it `stopped` at:
`calls`, `bytes` or `time`.

Each of `rules` has these fields:

| Field | Meaning |
| --- | --- |
| `n`, `rule` | Its number, and the rule |
| `count`, `samples` | What it masks, and up to two `samples`, each `before` and `after` |
| `reached` | How many values a path rule reached |
| `note` | When it masks nothing, why |
| `returned` | The `count` and `samples` of what a path rule masks in what calls got back, which only `export html`, `har` and `dataset` mask |
| `unmasked` | What it matches that is left as it is (below) |

A rule's `unmasked` has:

- its `count`, and up to two `samples`;
- each sample's `value`, whether it is a `key`, the `callNo`, `kind` and `name` of its call, whether it
  is `in` the call's request, response or error, its `path` there, and the stream's `event` it is in, or
  null;
- the `places` a path rule would mask them at;
- the `remedies` for up to 20 of those: each the `rule`, the `command` that adds it, and `copies`
  (`all` for a request; `read` for what a call got back, which only the copies that are read mask);
- the rules already `covered` that do in those copies, by their numbers;
- the `reasons` the rest get none (below).

The reasons are:

- `replay`: a clock or random read;
- `stream`: in a stream's events;
- `whole`: the whole request or response, or a key at its top;
- `key`: under a key holding `]`;
- `signed`: in a model call's signed reasoning, which a pack keeps as recorded.

## skill

```sh
shadowlap skill install [claude-code|agents|kiro] [--force] [--json]
```

Puts the [coding agents' instructions](./agents.md) into the project you run it in, from the copy that
comes with the CLI. Nothing is downloaded, and the commands they name are the ones this CLI takes. They
are two skills, `setup-agent` and `debug-agent`.

Where it writes them:

| Argument | Where |
| --- | --- |
| `claude-code` (the default) | The Claude Code plugin, with both, in `.claude/skills/shadowlap/`, where Claude Code loads it for everyone working on the project once the folder is trusted |
| `agents` | The skills alone, in `.agents/skills/shadowlap-setup-agent/` and `.agents/skills/shadowlap-debug-agent/` (below) |
| `kiro` | The skills alone, in `.kiro/skills/` |

`.agents/skills/` is where Codex, Cursor, GitHub Copilot, Gemini CLI, Antigravity, Devin Desktop (formerly Windsurf),
OpenCode,
Cline, Amp, goose, Zed and Junie read skills. Each of those agents' names (`codex`, `cursor`,
`copilot`, `gemini`, `antigravity`, `windsurf`, `devin`, `opencode`, `cline`, `amp`, `goose`, `zed`,
`junie`) does the same as `agents`.

In those two folders, which every tool's skills share, each skill is named `shadowlap-<skill>`, and
leaves out `allowed-tools`, which names Claude Code's tools. Nothing but the `shadowlap-` folders is
read or written there.

`skill install` takes these flags:

| Flag | What it does | Default |
| --- | --- | --- |
| `--force` | Replace what is there when it isn't this version's copy, and remove the files of ours this version doesn't have (below) | — |
| `--json` | Print what it did as JSON (below) | — |

- **A copy that is already this version's** is left as it is.
- **Anything else there** (another version's copy, or one edited here) is left as it is too, and the
  command exits 1, saying which files differ.
- **`--force`** replaces them, which is how a project moves to the copy of a newer Shadowlap. It removes
  the files of ours that this version doesn't have (in the plugin's folder, or in a `shadowlap-` skill's),
  so an older version's skill stops loading.
- **A link** on the way that leads out of the project, or a link where the install puts a file, is
  refused, with or without `--force`.

`skill install` exits 0 unless it was refused. Settings → Coding agents in the
[dashboard](./dashboard.md) runs it as the `skill-install` job.

`--json` prints `{ agent, path, version, before, installedVersion, outcome, files, reason }`:

| Field | Meaning |
| --- | --- |
| `agent` | Where it installed: `claude-code`, `agents` or `kiro` |
| `path` | The folder it installed into |
| `version` | This version, the copy it installs |
| `before` | What was there: `missing`, `current`, `other-version` or `changed` |
| `installedVersion` | The version the copy there says it is: the plugin's manifest, or each skill's `metadata.version` |
| `outcome` | `installed`, `updated`, `unchanged` or `refused` |
| `files` | Each file's `path` and `action` (below) |
| `reason` | Why it was refused |

A file's `action` is `written`, `replaced`, `removed` or `unchanged`. For a refused install, it is
`differs` or `extra`: what it left.

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

Turns a capture something else made, or a [trace you already keep](#traces), into a recording you can
replay your own code against.

These formats are captures:

| Format | What writes it |
| --- | --- |
| `har` | mitmproxy, Charles, Proxyman, a browser's devtools, Polly.js |
| `nock` | `nock.recorder.rec({ output_objects: true })` |
| `vcr` | VCR.py with its JSON serializer (`vcr.VCR(serializer='json')`) (below) |
| `litellm` | A LiteLLM proxy, through `shadowlap.litellm_callback`: production traffic, one run per correlation id (below) |

- **`vcr`**: a YAML cassette has to be converted first. Shadowlap reads JSON so that no YAML parser is
  trusted with a cassette from anywhere.
- **`litellm`** takes several files, since a proxy writes one per worker. The calls of one agent run
  spread over several workers' files are put back together, in the order they started. See
  [Capturing production traffic](./gateways.md).

`otel`, `langfuse`, `langsmith`, `phoenix` and `logfire` read [traces](#traces).

Its subcommands take these flags:

| Flag | What it does | Default |
| --- | --- | --- |
| `--name <name>` | `har`, `nock`, `vcr`, `litellm`, `otel`: the name to record as the run's source (below) | The file's name |
| `--json` | Print every run made, by its full id, and what it skipped ([below](#--json)) | — |
| `--host <url>` | Trace stores: the store's API, for a self-hosted instance or another region | [Below](#traces) |
| `--allow-http` | Trace stores: accept plain http for another host than this machine, on a network you trust | Plain http only for this machine ([below](#traces)) |
| `--since <when>` | Without a trace id: import the traces that started from then on; `logfire` takes it with one too | 30 days ago |
| `--until <when>` | Without a trace id: the traces that started before then | The current time |
| `--limit <n>` | Without a trace id: the most traces to import, newest first; at most 10,000 | 100 |
| `--trace-name <name>` | Without a trace id: only the traces of this name | — |
| `--project <name>` | `phoenix`: the project the traces are in | `PHOENIX_PROJECT` or `PHOENIX_PROJECT_NAME`, else `default` |

`--since`, `--until`, `--limit` and `--trace-name` are for `langfuse`, `phoenix` and `logfire`:
[the traces in a window](#the-traces-in-a-window).

**What is kept.** Anthropic, OpenAI, Gemini, Azure, Vertex and Bedrock hosts are recognised:

- Every other entry is skipped, and `--json` lists the reasons. So is an entry whose fields aren't what
  the format says (a method that isn't text, a null entry), naming the field.
- The capture's credential headers (`authorization`, `x-api-key`, `api-key`, cookies,
  `proxy-authorization`, `x-goog-api-key`, `x-amz-security-token`) and its query's credentials are never
  stored.
- The rest of an answer's headers is kept as captured, and masked in every copy.
- Header names and values are escaped and bounded, because a capture is a file from anywhere.
- An import that stops part way leaves no run behind.

**The request bodies are the real ones**, which is what matters. Replay matches on a fingerprint of the
outgoing request, so a reconstructed body would fork at call 1. Every format produces the same
fingerprint for the same request, so it does not matter which tool captured it.

**An imported run is a [partial recording](./how-it-works.md#partial-recordings).** A capture of the
network holds no tool, clock or randomness calls, so a replay runs those live rather than diverging on
their absence, and `--writes` still fences write tools. No format carries SSE event boundaries, so a
streamed response replays in one piece, rather than at its recorded pacing.

**It has no command.** A capture says what was sent, not what sent it, so the run has no command to
re-run:

- `ls` and `show` display `<no-recorded-command>` in its place, and `ls --json` says
  `"hasCommand": false`;
- `replay` without a command refuses, and says what to run;
- its cost is reported as captured, not spent: that traffic was paid for where it ran.

Give your own command:

```sh
shadowlap import har traffic.har
shadowlap replay <run> -- python agent.py
```

That replay is also how an import becomes a CI golden. The model calls come from the capture and
everything else is recorded live, so the resulting run covers everything, and `shadowlap pack` turns it
into a golden for `shadowlap test`.

**Labels and authors.** Every imported run is labelled `imported`, and appears in the dashboard's
activity feed. It names who imported it as its author: `SHADOWLAP_AUTHOR` when set, `ci` in CI,
otherwise git's `user.email`. Its source is the file's name; `--name <name>` records another. The
dashboard's Import capture… passes the name of the file you picked, which it keeps under a name of its
own while it imports.

**Judged by the rules on calls.** An import judges each run it makes by the project's rules on calls:
every [`calls` check](./checks.md#rules-on-calls) in any golden's `expect` under `tests` in
`shadowlap.config.json`. A rule on calls reads only the calls a run made, so it holds for any run of the
agent. Counts, `when` rules, judges and budgets belong to their golden's own scenario and are not applied.

```
Imported 01M3S1C7QD from langfuse:7f3a9c2e: 3 model calls and 1 tool result (3 anthropic).
✓ judged by the rules on calls in shadowlap.config.json · 1 check passed
```

The verdict is one of these:

- **passed**: every rule that had a call to read holds.
- **failed**: a rule broke. The line names the first rule broken, the call and the values.
- **not applicable**: no rule had a call to read. A rule whose tool the run never called doesn't apply,
  and a capture of the model calls alone (`har`, `nock`, `vcr`, `litellm`) holds no tool calls.

The verdict is kept on the run, with the rules it was judged by. Once the rules change, the
[dashboard](./dashboard.md#runs) judges the run again from its calls, and an import of
[the traces in a window](#the-traces-in-a-window) judges again each trace it imported before. With no
rule on calls, nothing is judged, and the import says so.

`import` exits 1 when nothing could be imported: `runs` is empty. An import of
[the traces in a window](#the-traces-in-a-window) exits as that section says.

### Traces

```sh
shadowlap import otel otel-traces.json [otel-logs.json]
shadowlap import langfuse 7f3a9c2e-41b8-4d0e-9a51-2c6e8b1d4f07 [--host https://langfuse.example.com] [--allow-http]
shadowlap import langsmith 0192f4c1-8e2d-7a3b-b6c4-5d9e0f1a2b3c [--host https://langsmith.example.com/api/v1] [--allow-http]
shadowlap import phoenix 4a2db41deabc4aec332fb9fbfa0fc3e2 [--project support-agent] [--host https://phoenix.example.com] [--allow-http]
shadowlap import logfire 01a16460e2f311342463057f62b79fa9 [--since 90d] [--host https://logfire-eu.pydantic.dev] [--allow-http]
```

A trace keeps what its instrumentation logged: the messages and the model settings, tool outputs when
someone logged them, rarely the tool definitions.

- Each model call is rebuilt as the request its provider's SDK sends and the response it got, and
  stored like a capture's.
- It is rebuilt in Anthropic's, OpenAI's or Gemini's format: the provider the trace names, else the
  model's family, else OpenAI's, which most other servers speak.
- The run is a partial recording: what the trace didn't keep runs live on replay, with writes fenced.

**The order of the calls.** The run holds the calls in the order they started, read as finely as the
source keeps the time: to the microsecond in Phoenix, Logfire and LangSmith, and the nanosecond in OTLP.
That is because a tool and the model call that reads its result often start in the same millisecond.
Calls that started at the same instant go in the order one needed another:

- a span before the calls that ran inside it;
- a model call before the tool call it asked for;
- a tool call before the model call whose request carries its result.

Calls that say nothing of each other keep the order the source lists them in.

Each source reads:

| Source | What it reads | Key |
| --- | --- | --- |
| `otel` | OTLP JSON files: spans with the GenAI or OpenInference conventions | — |
| `langfuse` | The trace's observations | `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` |
| `langsmith` | The trace's runs, from `POST /runs/query`, every page | `LANGSMITH_API_KEY` |
| `phoenix` | The trace's spans, from `GET /v1/projects/<project>/spans`, every page | `PHOENIX_API_KEY`, when it is set |
| `logfire` | The trace's spans, from one SQL query on the `records` table (`POST /v2/query`) | `LOGFIRE_READ_TOKEN`, a read token |

**`otel`** reads OTLP JSON, as an OTLP/HTTP exporter sends it, the collector's file exporter writes it
(one request per line), or Grafana Tempo downloads a trace. Several files are read as one, so traces and
their logs can come separately. One run is made per trace. It reads spans with the OpenTelemetry GenAI
conventions:

- `gen_ai.input.messages` and `gen_ai.output.messages`, with `gen_ai.system_instructions` and
  `gen_ai.tool.definitions`, also from a `gen_ai.client.inference.operation.details` event;
- the older `gen_ai.prompt` and `gen_ai.completion`: as JSON, on `gen_ai.content.*` events, or flattened
  as OpenLLMetry writes them;
- or the per-message `gen_ai.*.message` and `gen_ai.choice` events, on the span or as log records
  (`resourceLogs`, tied to the span by its id). That is where the official instrumentations
  (openai-v2, vertexai, google-genai) send them;
- the model, provider, settings, token usage and finish reason;
- `execute_tool` spans, for tool calls.

It reads OpenInference's conventions too (Arize Phoenix, and the LlamaIndex, DSPy and smolagents
instrumentations): LLM spans with `llm.input_messages`, `llm.output_messages`, `llm.tools` and
`llm.invocation_parameters`, and TOOL spans. LLM spans are rebuilt exactly from `input.value` and
`output.value` where its OpenAI and Anthropic instrumentations log the request and response themselves.
When a framework's span wraps the client library's span for the same call, the inner one is kept.

**`langfuse`** reads the trace's observations from the Observations API v2
(`GET /api/public/v2/observations`, a page of 1,000 at a time), or `GET /api/public/traces/<id>` from a
self-hosted Langfuse without it. Generations are model calls. TOOL observations, and spans named after a
tool a generation asked for, are tool calls.

**`langsmith`**: `llm` runs are model calls: LangChain's serialized messages, or the request and response
themselves from LangSmith's wrapped OpenAI and Anthropic clients, which rebuild exactly. `tool` runs are
tool calls.

**`phoenix`**:

- A Phoenix without authentication needs no key.
- The API takes no order for spans, so they are put in the order they started once read. A trace of more
  than 20,000 spans is refused rather than cut.
- The project is `--project`, else `PHOENIX_PROJECT` or its older name `PHOENIX_PROJECT_NAME`, as
  Phoenix's own client reads them, else `default`.
- It reads OpenInference's conventions, as `otel` reads them. LLM spans are model calls, rebuilt exactly
  where the OpenAI or Anthropic instrumentation logged the request itself as JSON. TOOL spans are tool
  calls.
- It needs Phoenix 13.9 or later, which reads spans by trace. An older one is refused, with the reason.

**`logfire`**:

- It reads among spans that started since `--since`: a date, a time, or how long ago, such as `90d`;
  30 days by default.
- Logfire's instrumentations and Pydantic AI write the current GenAI conventions, read as `otel` reads
  them. Where Pydantic AI's model span wraps the client library's own (the Anthropic SDK's), that span
  adds what was sent that Pydantic AI leaves out, such as `max_tokens` and streaming.
- A function wrapped with `@logfire.instrument` is a tool call when the model asked for a tool of its
  name: its span's (`@logfire.instrument('lookup_order')`), or the function's own under the decorator's
  default message (`Calling tools.lookup_order`). It keeps its arguments, and its result with
  `record_return=True`.
- A block an agent handed back as the Anthropic SDK returned it is read back as the block.
  `logfire.instrument_anthropic()` logs it as the text the SDK prints for it
  (`ToolUseBlock(id='toolu_…', …)`).

**Keys and hosts.** The keys are read from the environment, and sent only to the host. Nothing of the
keys is stored. The host is `--host`, else the variable the store's own SDK reads, else its usual
address:

| Store | Variable | Usual address |
| --- | --- | --- |
| `langfuse` | `LANGFUSE_HOST` | `https://cloud.langfuse.com` |
| `langsmith` | `LANGSMITH_ENDPOINT` | `https://api.smith.langchain.com` |
| `phoenix` | `PHOENIX_ENDPOINT`, `PHOENIX_COLLECTOR_ENDPOINT` or `PHOENIX_BASE_URL` | `http://localhost:6006`, Phoenix as `phoenix serve` starts it |
| `logfire` | `LOGFIRE_BASE_URL` | The Logfire region the read token names: `https://logfire-us.pydantic.dev` or `https://logfire-eu.pydantic.dev` |

- A self-hosted LangSmith is reached at its `/api/v1` path.
- Plain http is accepted for this machine (`localhost`, `127.0.0.0/8`, `::1`), since the keys travel with
  every request. `--allow-http` accepts it for another host, on a network you trust.
- A Phoenix that asks for no key, with `PHOENIX_API_KEY` unset, is read over plain http on any host, such
  as the `http://phoenix:6006` of a compose file, since nothing secret travels.

The run's source reads `langfuse:<first 8 characters of the id>` (or `langsmith:…`, `phoenix:…`,
`logfire:…`), or the file's name for `otel`. The run is labelled with the source as well as
`imported`.

**What replays from a trace.** Replay matches each model call on its whole request, but for the API
version an Anthropic client names (`anthropic-version`), which no trace keeps:

- An imported call names none, and is matched whatever version the agent's SDK names. Its replay names
  none either, so a golden packed from it replays on any release of the SDK.
- A trace that kept everything the agent sends replays it with nothing live. Where it left something
  out, typically the tool definitions, the replay forks at the first model call that differs and runs
  live from there, which the import says.
- A tool call replays when the trace kept its arguments (as an object) and its output, and only if every
  call of that tool was kept. Such tools are listed in `meta.covers` as `tool:<name>`; any other tool runs
  live on replay.
- A model call that failed where it ran, or kept no messages or output, is skipped and runs live.

**Two kinds of agent fork early**, because what they send isn't what their traces keep. Both still
import, and replay runs live from the fork with writes fenced.

- **A Pydantic AI agent** forks at its first model call, whatever the store. Pydantic AI logs the
  conversation, not the request it sends, which writes text as content blocks and sets `tool_choice`.
- **An agent that hands the Anthropic SDK's own response objects back as messages**
  (`"content": reply.content`) forks at its second model call where the trace kept the response whole
  but those blocks only as the text the SDK prints for them, as OpenInference's Anthropic instrumentation
  logs them.

For that agent, the request is then rebuilt from `llm.input_messages`, which leaves out fields the SDK sends with those
blocks (`citations`, `caller`, `toolset_name`), and holds a tool result as the user's text. Where the
trace logged the blocks as JSON, or by the GenAI conventions, such an agent replays from the
trace alone, as one that builds its messages as plain dicts does. Traced by
`logfire.instrument_anthropic()`, which logs each block as the text the SDK prints for it, it replays
from the trace alone too: that text is read back as the block.

A trace from [`export otel`](#export-otel) carries no prompt text, so it has nothing to replay: share the
run as a [pack](#pack-unpack) instead.

`--json` adds what the source kept:

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
started in a window, one run per trace, newest first:

- from `--since`: a date, a time, or how long ago, such as `7d` or `12h`; 30 days ago by default;
- to `--until`: the same; the current time by default;
- up to `--limit` traces: 100 by default, at most 10,000;
- only those named `--trace-name`, when it is given: Langfuse's trace name, the root span's name in
  Phoenix and Logfire.

Give a trace id or these flags, not both. Only `import logfire` takes `--since` with a trace id too, for
how far back to look for it.

Each store is asked through its own API for the traces' roots:

- **Langfuse**, for the root observations in the window: `GET /api/public/v2/observations`, or its traces
  list, `GET /api/public/traces`, where it has no v2 API;
- **Phoenix**, for the root spans: `GET /v1/projects/<project>/spans` with `parent_id=null`;
- **Logfire**, with one SQL query for the root spans in the `records` table.

Each trace is then read as a single import reads it, with the same keys, hosts and flags.

A trace store's import keeps the trace's id with the run (`meta.imported.key`), so a trace imported
before, by a window or by its id, is skipped and not read again. A trace still running when it was
imported keeps what it had by then: import it by its id once it has ended, to bring in the rest. It
prints one line per trace, as it goes:

```text
3 traces in Langfuse on cloud.langfuse.com that started from 2026-10-16 09:12 UTC to 2026-10-23 09:12 UTC:
  11111111-41b8-4d  imported as 01M5N2NX8F: 3 model calls and 1 tool result  support-chat
  22222222-41b8-4d  imported before, as 01M5N2NVXR  support-chat
  33333333-41b8-4d  skipped: no model calls in its 3 observations  nightly-eval
Imported 1 of 3 traces: 1 imported before, 1 skipped.
```

- **Skipped**: a trace with nothing to import is skipped, and so is one the store can't give whole: gone
  since it was listed, or more spans than an import reads.
- **Imported before**: once the [rules on calls](#import) changed since it was judged, it is judged again
  from its calls, and its line ends with the verdict it was judged to (*· judged again: 1 check passed*).
- **A failure** (the store refusing, failing or not answering) stops the import at that trace. The runs
  it made stay, and the same command run again goes on from there.

An import of the traces in a window exits with:

| Status | Meaning                                                                       |
| ------ | ----------------------------------------------------------------------------- |
| `0`    | Otherwise, an empty window included                                           |
| `1`    | The window held traces and none of them is imported, in this import or before |
| `1`    | A failure: a store that failed or didn't answer                               |
| `2`    | A failure: keys the store refused                                             |

A failure's exit status is the failure's own.

`--json` adds the window it read, `window`:

| Field            | Meaning                    |
| ---------------- | -------------------------- |
| `since`, `until` | The window's start and end |
| `limit`          | The most traces it imports |
| `traceName`      | The `--trace-name` given   |

`traces` lists each trace it found, newest first:

| Field | Meaning |
| --- | --- |
| `id`, `name` | The trace, and its name |
| `startedAt` | When it started |
| `outcome` | `imported`, `already` (imported before, as `runId`), `skipped` (for its `reason`), `failed` (where the import stopped) or `unread` (after that) |
| `runId` | The run it was imported as |
| `reason` | Why it was skipped |
| `judged` | The verdict it was judged to by the rules on calls: an imported trace's, or one imported before once the rules changed; `null` otherwise |

`kept` counts what the traces it imported kept, and `entries` every observation or span it read.

### `--json`

Every `import` subcommand takes `--json` and prints one object, whatever the format: each run it made,
by its full id, with its source and what it holds, then everything it skipped. One LiteLLM file can
make several runs, one per correlation id; they are all listed.

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
      "imported": [{ "callNo": 1, "kind": "api", "name": "POST /v1/messages", "provider": "anthropic", "model": "claude-haiku-4-5" }],
      "judged": null
    }
  ],
  "skipped": [{ "url": "line 4", "reason": "not JSON (a partly written line?)" }]
}
```

The object has these fields:

| Field | Meaning |
| --- | --- |
| `format` | The format read |
| `entries` | What was read: HAR entries, nock definitions, cassette interactions, capture lines, spans, observations or runs |
| `runs` | Each run made (below); empty when nothing could be imported |
| `skipped` | Each entry skipped, and why |

Each of `runs` has these fields:

| Field      | Meaning                                                                                        |
| ---------- | ---------------------------------------------------------------------------------------------- |
| `runId`    | The run, by its full id                                                                        |
| `source`   | Where the run records it came from (below)                                                     |
| `key`      | The correlation id for LiteLLM, the trace id for `otel` and the trace stores, otherwise `null` |
| `calls`    | Its calls: `model` and `tool`                                                                  |
| `labels`   | Its labels                                                                                     |
| `imported` | The calls it imported                                                                          |
| `judged`   | Its verdict by the rules on calls ([above](#import)), as kept on the run; `null` with no rule  |

`source` is the file's name (never its folder, which belongs to this machine and would travel with the
store), the names of the files a LiteLLM run was put together from, or `langfuse:…`, `langsmith:…`,
`phoenix:…` or `logfire:…`.

When nothing could be imported, `runs` is empty, and the exit code is 1. Started from the dashboard, the
command also reports each run to the job that started it.

## export html

```sh
shadowlap export html <run>                    # shadowlap-01m2p15fwy.html
shadowlap export html <run> run.html --lineage # with the run's ancestors, so they compare inside the file
shadowlap export html <run> --no-redact        # skip the config's redaction rules
```

One HTML file with the dashboard's views and the run's data built into it: calls, conversations,
responses, the divergence diff, the context and timeline views, and comparison between the runs it
holds.

- It opens from a file, an artifact or a pull request comment, on a machine that has neither Shadowlap
  nor the recording, and it loads nothing from the network.
- Actions, live updates and search across runs belong to the dashboard, not to a copy.
- Like a pack, it leaves out who made each run.
- Without a file named, it writes `shadowlap-<run>.html`.

`export html` takes these flags:

| Flag          | What it does                                                 | Default |
| ------------- | ------------------------------------------------------------ | ------- |
| `--lineage`   | Include the run's ancestors, so they compare inside the file | —       |
| `--no-redact` | Skip the redaction rules in `shadowlap.config.json`          | —       |

It is a copy of recorded data, so the redaction rules in `shadowlap.config.json` apply, as they do to
`pack`. The command says how many applied, that there were none, or, with `--no-redact`, how many it
skipped.

A run still recording is refused, exit status 2: every export waits for a run to end, or the copy would
show it recording for good. With `--lineage`, so is a run whose ancestor is still recording.

A 30-call run comes to about 1.1 MB, most of it the dashboard's own code, styles and fonts, which every
copy carries.

## export dataset

```sh
shadowlap export dataset --label good --out good.jsonl
shadowlap export dataset <run...> --calls model --format openai-chat
```

Recordings as an eval or fine-tuning dataset, one JSON line per example. Select runs by id, by
`--label` or with `--all`.

`export dataset` takes these flags:

| Flag                   | What it does                                                             | Default |
| ---------------------- | ------------------------------------------------------------------------ | ------- |
| `--label <label>`      | Select the runs with this label (repeatable: all of them)                | —       |
| `--all`                | Select every run in the store                                            | —       |
| `--calls final`        | One example per run: its last model call                                 | Default |
| `--calls model`        | One example per model call                                               | —       |
| `--format jsonl`       | `{ input: { messages, tools }, output: { text, tool_calls }, metadata }` | Default |
| `--format braintrust`  | `{ input, expected, metadata }`                                          | —       |
| `--format langfuse`    | `{ input, expectedOutput, metadata }`                                    | —       |
| `--format openai-chat` | `{ messages }`, the recorded answer as the last assistant message        | —       |
| `--out <file>`         | Write here instead of stdout                                             | stdout  |
| `--no-redact`          | Skip the redaction rules                                                 | —       |

A run named that is still recording is refused, exit status 2. One picked by `--label` or `--all` is
left for a later export, and the command says how many.

- **Messages** are the conversation exactly as the model saw it, in a provider-neutral shape: system,
  user, assistant (with its tool calls and their ids) and tool results, whichever provider recorded it.
- **`metadata`** carries the run and call, the model, labels, notes, outcome check results, the
  command, code version and fork point.

**Redaction.** The redaction rules apply to each model call's request and response as `pack` applies
them, path rules included, before its conversation and answer are read. Then the rules without a path
apply to every string of the row, its command line, labels and notes too. A rule that can't be read
stops the export. The command says how many rules applied, that there were none, or, with
`--no-redact`, how many it skipped.

## export pairs

```sh
shadowlap export pairs --out pairs.jsonl
shadowlap export pairs --min-confidence medium --format trl --out pairs.jsonl
```

Preference pairs read from the attempts blame, verify and `--repeat` left in the store, one JSON line
per pair. Each pair is the conversation as the model saw it at a call, in the messages
`export dataset` writes, an answer to prefer and one to avoid. [Training](./training.md) explains where
pairs come from, and what high and medium mean.

`export pairs` takes these flags:

| Flag                         | What it does                                                             | Default |
| ---------------------------- | ------------------------------------------------------------------------ | ------- |
| `--min-confidence high`      | Answers blame proved decided the run                                     | Default |
| `--min-confidence medium`    | Also where a failing and a passing attempt first answered differently    | —       |
| `--format openai-preference` | `{ input: { messages, tools }, preferred_output, non_preferred_output }` | Default |
| `--format trl`               | `{ prompt, chosen, rejected }` as chat messages, with `tools`            | —       |
| `--out <file>`               | Write here instead of stdout                                             | stdout  |
| `--no-redact`                | Skip the redaction rules (below)                                         | —       |

It prints every source it read (including those that made no pairs, and why), the count and how many
were left out, the shape, the redaction line and the file.

- **What left the machine**: each export is kept in the store as what left the machine.
- **No pair**: when no pair is at the confidence asked for, nothing is written, and a file already there
  is left as it was.
- **Redaction**: the rules apply to the copy, rules without a path to every string, and rules with a
  path to the message fields kept. `--no-redact` skips them.

## export har

```sh
shadowlap export har <run>                 # HAR to stdout
shadowlap export har <run> traffic.har
shadowlap export har <run> --no-redact     # skip the config's redaction rules
```

A run's model API calls as a HAR, for any tool that reads one, and the reverse of [`import`](#import):
exporting a run and importing it again produces the same fingerprints.

- Tool, clock and randomness calls are left out, because a HAR describes HTTP.
- Azure, Vertex and Bedrock hosts depend on the account, so a representative host for the provider
  stands in.
- Credentials are never written.
- Without a file named, it writes the HAR to stdout.

`export har` takes one flag:

| Flag          | What it does                                        | Default |
| ------------- | --------------------------------------------------- | ------- |
| `--no-redact` | Skip the redaction rules in `shadowlap.config.json` | —       |

**Redaction.** A HAR carries full requests and responses, so the redaction rules in
`shadowlap.config.json` apply, as they do to `export html`:

- every rule to the request bodies, and to a response that is JSON: rules with a path included, since a
  HAR is only read;
- the rules without a path to the URL, the headers and every response, streamed or not.

A model streams its text in pieces, so an address it writes back arrives split across events. Each run
of pieces (a block's text, a tool call's arguments) is masked as the text it adds up to, and the masked
text is spread back over the same events. The rules are named in the log (`_shadowlap.redactions`).
`--no-redact` skips them; the command says when there are none to apply, and how many it skipped.

A run still recording is refused, exit status 2, as by every export.

## export otel

```sh
shadowlap export otel <run>                                   # OTLP JSON to stdout
shadowlap export otel <run> --out trace.json                  # a file only, even with OTEL_EXPORTER_OTLP_ENDPOINT set
shadowlap export otel <run> --endpoint http://localhost:4318  # or OTEL_EXPORTER_OTLP_ENDPOINT
shadowlap export otel <run> --no-redact                       # skip the config's redaction rules
shadowlap export otel <run> --service refund-agent            # service.name, default shadowlap-agent
```

A run as one OpenTelemetry trace: a span for the run, and a child span per call. No OpenTelemetry SDK is
involved.

- It uses the GenAI semantic conventions (`gen_ai.operation.name`, `gen_ai.system`,
  `gen_ai.request.model`, `gen_ai.usage.*`, `gen_ai.response.finish_reasons`, `gen_ai.tool.name`), plus
  `shadowlap.*` attributes for the origin, effect, fingerprint and cost.
- Trace and span ids are derived from the run id, so exporting twice updates the same trace.
- Headers for an authenticated collector come from `OTEL_EXPORTER_OTLP_HEADERS`
  (`key=value,key2=value2`).

`export otel` takes these flags:

| Flag | What it does | Default |
| --- | --- | --- |
| `--out <file>` | Write the trace to this file, and send it nowhere else unless `--endpoint` is given too | `OTEL_EXPORTER_OTLP_ENDPOINT` when it is set, else stdout |
| `--endpoint <url>` | The OTLP/HTTP endpoint, such as `http://localhost:4318` | `OTEL_EXPORTER_OTLP_ENDPOINT`, unless `--out` is given |
| `--service <name>` | The `service.name` resource attribute | `shadowlap-agent` |
| `--no-redact` | Skip the redaction rules in `shadowlap.config.json` | — |

With `--out`, the trace goes to that file and nowhere else unless `--endpoint` is given too. Without
either, it goes to `OTEL_EXPORTER_OTLP_ENDPOINT` when that is set, else to stdout.

A collector that doesn't answer stops it with exit status 1, and says where the trace went and why
(`connection refused (ECONNREFUSED)`, `no such host (ENOTFOUND)`). A file asked for with `--out` is
written first.

**Redaction.** A trace carries no prompt text, tool arguments or results. The redaction rules without a
path apply to what it does carry from the run:

- span names;
- the command line (`process.command_args`), masked as one text, as every copy masks it, and before the
  run's span is named after its first 200 characters;
- model and tool names;
- error messages.

Shadowlap's own ids and fixed values stay as they are, and the command says how many rules applied. A
rule that can't be read stops the export. A run still recording is refused, exit status 2, as by every
export.

## rm, gc

```sh
shadowlap rm <run...> [--forks]
shadowlap gc [--older-than <days> | --before <time>] [--keep <n>] [--expect <count>-<digest>] [--dry-run] [--json]
```

`rm` deletes runs. `gc` deletes old runs, removes blobs nothing references any more, and vacuums the
store. The TUI's `x` does the same as `rm` for one run.

```sh
shadowlap gc --older-than 30 --dry-run
```

`rm` and `gc` take these flags:

| Flag | What it does | Default |
| --- | --- | --- |
| `--forks` | `rm`: also delete the forks of each run, recursively | — |
| `--older-than <days>` | `gc`: delete runs that started more than this many days ago, such as `--older-than 30` | — |
| `--before <time>` | `gc`: delete runs that started before this time: the cutoff a dry run prints (epoch milliseconds), or a date (`2026-09-01`) | — |
| `--keep <n>` | `gc`: keep only the newest *n* runs, such as `--keep 200` (below) | — |
| `--expect <count>-<digest>` | `gc`: delete only the runs a dry run listed ([below](#deleting-what-a-dry-run-listed)) | — |
| `--dry-run` | `gc`: change nothing, and say what a real run would free | — |
| `--json` | `gc`: print the report as JSON (below) | — |

**What `rm` deletes.** `rm` deletes runs as the dashboard deletes them, each with the attempts bundled
under it: `--repeat`, blame's probes, verify's attempts, a golden's repeats in one test session, an
error-path preset's attempts, and theirs in turn. So none is left behind as a run of its own. Their forks
keep their data, but lose the link.

It leaves these, with the reason, as the dashboard leaves them, and then exits 1:

- a run still recording;
- one a run in progress replays from (a replay, fork or attempt of it serves its answers from it);
- one with an attempt still running.

**What `gc` deletes.** `gc` deletes old runs, each with the attempts bundled under it, however recent,
as `rm` takes them. Runs are counted as the lists count them, so `--keep 200` keeps the newest 200 runs,
each attempt counted with the run it came from. Runs still recording are never touched. One a run in
progress replays from, or with an attempt still running, is left, with the reason, as `rm` leaves it.
It then removes blobs nothing references any more, and vacuums the store.

**While a run is recording**, in this project's store and from any process, no blob is collected and
the store isn't vacuumed. A recording stores a blob just before the call that references it, and reuses a
blob already stored, so a blob that looks unreferenced may be one it is about to use. `gc` still deletes
the old runs, says which runs are recording, and frees their blobs on a later run. `rm` collects blobs
under the same rule.

**Abandoned runs.** A run whose recording process was killed (`kill -9`, out of memory, a machine that
went away) stays marked running. But it isn't recording, and it holds nothing up. The store names the
process that records each run until the run ends:

- a run whose process is gone from this machine is abandoned at once;
- one whose process can't be asked (it ran on another machine) is abandoned after a day without a call;
- one whose process is still there is abandoned after a week without one.

`gc` lists abandoned runs, marks them interrupted as of the last thing they recorded, and deletes them
like any other run when they match `--older-than` or `--keep`. Until then, every copy of such a run
holds it that way: `pack`, `export html`, `export otel` and `share` write it interrupted, ended at its
last call (a teammate who unpacks it never sees it recording). `bisect` takes it so, leaving the store
as it is.

### A dry run

`--dry-run` changes nothing, and says what a real run would free:

```text
▸ runs older than 30 days: 3 of 120 · runs still recording are never touched
    01M2R1HDVD  record  completed  41d ago  node agent.js
    …
  blobs nothing would reference: 14 · 2.1 MB
✓ dry run: would delete 3 runs and free 2.1 MB. To delete exactly these runs: shadowlap gc --before 1757000000000 --expect 3-9c1f0e2a6b7d4c5e
```

The size is what those blobs take in the store. When no run matches, it says what a plain
`shadowlap gc` would give back instead, with no command that deletes runs: blobs nothing references, and
unused space of 1 MB or more that deleted runs left in the store.

```text
▸ runs older than 30 days: none · runs still recording are never touched
  blobs nothing would reference: 14 · 2.1 MB
  unused space in the store: 51.4 MB
✓ dry run: no runs to delete; would give back 2.1 MB of blobs nothing references and 51.4 MB of unused space. To do that: shadowlap gc
```

While a run is recording, gc gives none of it back, so the dry run says it can be given back once no
run is recording:
`✓ dry run: no runs to delete; 51.4 MB of unused space can be given back with shadowlap gc once no run is recording.`

In a project that has never recorded, `gc` reports nothing to clean, and creates no store.

### Deleting what a dry run listed

To delete exactly what a dry run listed, pass its cutoff and its `expect` back:

```sh
shadowlap gc --before <cutoff> --expect <count>-<digest>
```

That names those runs: how many, and a digest of their ids and their attempts'. It refuses, deleting
nothing and with exit status 2, when the runs that match by the time it runs are different, even the
same number of others, or have other attempts under them. `--before` also takes a date (`2026-09-01`).

### `gc` as JSON

A real run is recorded in the project's activity as `runs.cleaned`. `--json` prints the same report,
with these fields:

| Field                             | Meaning                                                                      |
| --------------------------------- | ---------------------------------------------------------------------------- |
| `dryRun`, `olderThanDays`, `keep` | The run's options                                                            |
| `cutoff`                          | Runs that started before it go, in epoch milliseconds                        |
| `total`                           | The runs in the store before, as the lists count them                        |
| `count`                           | How many runs it deletes, or would                                           |
| `attempts`                        | The attempts bundled under them, which go with them                          |
| `runs`                            | The first 100 of those runs                                                  |
| `expect`                          | The value to pass back to `--expect`                                         |
| `blobs`, `bytes`                  | The blobs, and the bytes, freed                                              |
| `recording`, `recordingCount`     | The runs still recording: the first 100, and how many                        |
| `abandoned`, `abandonedCount`     | The abandoned runs: the first 100, and how many                              |
| `held`, `heldCount`               | The matching runs held, each with `why` (below): the first 100, and how many |
| `deferred`                        | Whether blobs were deferred because of a recording                           |
| `store`                           | The store (below)                                                            |

A run is held because a run in progress replays from it, or an attempt of it is still running.

`store` has its `path`, its size `before`, its unused space `free` (which vacuuming gives back), and,
after a real run, `after`. The lists stop at 100, so the report stays small however many runs a
clean-up deletes. The store's size counts the database's pages, whatever its write-ahead log holds, so
another process holding the store open (a dashboard) doesn't make a cleanup look like growth.

## tasks

```sh
shadowlap tasks [--json]
shadowlap tasks score [goldens...] --model <model> [--base-url <url>] [--attempts <n>] [--reads replay]
shadowlap tasks serve [goldens...] [--port 4779] [--base-url <url> [--key-env <name>]]
shadowlap tasks models [--json]
```

Goldens as tasks a model can be scored on. A model under test takes over at one model call, the calls
before it replay from the recording for free, and the golden's checks score what it did from there.

`tasks` (or `tasks ls`) lists them: where the model takes over and why, what each rewards, which tools
run live or are stubbed after the takeover, and whether each is:

- **ready**;
- **blocked**: its test fails, its last test is inconclusive, its test may fork and forked before the
  takeover (which `test --update` fixes), or it was packed from a capture and has no command;
- **not a task**: its checks only cap tokens and cost, or its model calls are made in more than one
  scope;
- **or has no golden**.

It warns when every ready task rewards the same behaviour. The takeover, why, what a task rewards and
the agent's scope can be set in a `task` object next to its `expect` in the config.
[Training](./training.md) explains the defaults.

`tasks` takes one flag:

| Flag     | What it does                                   | Default |
| -------- | ---------------------------------------------- | ------- |
| `--json` | Print them as JSON ([Training](./training.md)) | —       |

### `tasks score`

Scores a model on every ready task, or on the goldens given (`.` for every golden of the project).
[Training](./training.md#how-the-model-takes-over) has which model can answer which recording, every
option and the JSON.

```sh
shadowlap tasks score --model qwen3:8b --base-url http://127.0.0.1:11434/v1
```

- **Each attempt is a run.** The score is the share of checks it passed, of those that applied. A
  [`when`](./checks.md#conditions) whose condition never held is left out.
- **Scores are kept per model.** Scoring a model again replaces its scores, unless the re-score stops
  short.

`tasks score` takes these flags:

| Flag | What it does | Default |
| --- | --- | --- |
| `--model <model>` | The model to score (required; below) | — |
| `--base-url <url>` | An OpenAI-compatible endpoint, such as `http://127.0.0.1:8000/v1` (no user or password in it) | — |
| `--key-env <name>` | The variable holding the endpoint's key (below) | `OPENAI_API_KEY` for api.openai.com; `ANTHROPIC_API_KEY` for `anthropic:` on a recording that isn't Anthropic's |
| `--attempts <n>` | Attempts per task | 5 |
| `--reads live\|replay` | What read tools do after the takeover | `live` |
| `--concurrency <n>`, `--budget <usd>`, `--timeout <seconds>`, `--guard` | As for [`blame`](#blame) | — |
| `-y, --yes` | Run the recorded command of a golden from a pack the repository doesn't track, without asking (below) | — |
| `--json` | Print the scores as JSON on stdout | — |

**Which model it asks.** `--model <name>` asks the recording's provider for another model.
`anthropic:<name>` and `openai:<name>` ask that provider's API, and `--base-url` an OpenAI-compatible
server, such as Ollama or vLLM. When that isn't the API the recording spoke, the conversation is
translated at the takeover, and the answer back.

Either way, a small upstream on 127.0.0.1 asks the model under test from the takeover call on, whatever
the agent asked before it. It answers in the recording's own API: Anthropic's, OpenAI's (chat
completions or the Responses API), Gemini's, Amazon Bedrock's (Claude, and the Converse API) or Vertex
AI's and Azure OpenAI's. Another model of Bedrock, Vertex AI or Azure OpenAI themselves can't be asked:
score Anthropic's or OpenAI's API, or a model at your own endpoint, on those recordings.

- **`--key-env`**: another model of the recording's own provider goes with the agent's own key.
- **`--yes`**: without it, such a golden asks first, as `test` asks of one, and without a terminal it is
  skipped, saying why.

`tasks score` exits with:

| Status | Meaning                       |
| ------ | ----------------------------- |
| `0`    | Every task was scored in full |
| `1`    | A task was skipped or stopped |
| `2`    | Nothing given can be scored   |
| `3`    | The budget stopped it         |

### `tasks serve`

Answers one attempt per HTTP request, for a training loop that wants a reward. [Training](./training.md)
shows a request and its response.

`POST /v1/tasks/<task>/attempts` with `{"model": …, "baseUrl": …}` returns each check's result, the
score, the run and its cost. It listens on 127.0.0.1, checks the `Host` header, and needs the token it
prints. `SHADOWLAP_TASKS_TOKEN` sets it, at least 16 characters.

`tasks serve` takes these flags:

| Flag | What it does | Default |
| --- | --- | --- |
| `--port <port>` | The port to listen on | 4779, or a free one if it is taken |
| `--base-url <url>` | The endpoint requests that name none ask | — |
| `--key-env <name>` | The variable whose key goes to that endpoint, and nowhere else | — |
| `--concurrency <n>` | Attempts running at once; more requests wait their turn | 2 |
| `--reads live\|replay` | What read tools do after the takeover, unless a request says | `live` |
| `--timeout <seconds>` | Stop an attempt after this long, and count it as failed | — |
| `--guard <mode>` | The network guard: `warn`, `block` or `off` | `warn` |
| `-y, --yes` | Serve goldens from packs the repository doesn't track without asking (below) | — |

A golden from a pack the repository doesn't track, recorded elsewhere, is served only once you say yes
to its command as it starts, or with `-y`/`--yes`. A request for one nobody said yes to gets a 409.

### `tasks models`

Lists models to score:

- the one the recordings used;
- each configured provider's models: Anthropic's and OpenAI's with the keys in the environment, and
  Ollama's on this machine;
- the models scored before.

Each comes with its price per attempt, last score and the ready tasks it can answer. A model that can
answer none says why.

`tasks models` takes these flags:

| Flag | What it does | Default |
| --- | --- | --- |
| `--timeout <ms>` | How long to wait for each provider's list; a provider that doesn't answer within it becomes a note | 1500 ms |
| `--json` | Print them as JSON | — |

## push, pull

```sh
shadowlap push <run...>          # these runs, with their ancestors
shadowlap push --all             # every run on this machine that isn't in the store as it is
shadowlap pull [<run...>]        # teammates' runs, or only these (ids or unique prefixes, as in the store)
shadowlap pull --include-pr      # and the runs pull requests' CI jobs pushed to their own folders
```

Copy runs between this machine and the [team store](./team.md) named by `store` in
`shadowlap.config.json`, with this machine's own credentials.

`push` and `pull` take these flags:

| Flag           | What it does                                                                           | Default |
| -------------- | -------------------------------------------------------------------------------------- | ------- |
| `--all`        | `push`: every run on this machine that is not in the store as it is                    | —       |
| `--include-pr` | `pull`: also bring the runs pull requests' CI jobs pushed to their own folders (below) | —       |
| `--json`       | Print the result as JSON (below)                                                       | —       |

**What goes and comes.**

- Blobs shared between runs go up once.
- A run still recording goes when it ends.
- Labels and notes merge both ways, and a run's results come from the machine that made it.
- A run deleted here isn't pulled again, unless named.
- A run named to `push` that the store has already is checked part by part, and what the bucket lost of
  it (its calls, a blob) is sent again.
- A push names the pusher as the author of a run made here without one. It leaves here, saying why, a
  run a pull would refuse.

**Counting.** Both count by run, as the dashboard does: "45 runs and 69 attempts pushed". Attempts
(`--repeat`, blame's probes, verify's attempts, a golden's in one test session) are those filed under
their runs. A run counts as only on this machine while it, or an attempt filed under it, isn't in the
store.

**Fixes go with their runs.** A push sends each [fix](#fix) with its blames, repairs and verdicts, once
one of its runs is in the store. A pull brings the team's, merged with this machine's.

- A teammate's repair, from a pull or from the store's copy a push merges with, has its `fix.patch` and
  reports written to `.shadowlap/repairs/<id>/`.
- Whether a fix is applied is this machine's own, and never goes.
- A fix over 16 MB stays here, and a pull skips one in the store that is, saying which.

**What a pull checks.** `pull` checks every run it brings as strictly as `unpack`. A run in the store
that fails is skipped with its forks, and tried again next time. A pulled run is marked with the store's
URL (`meta.imported.from`). It reads as its author's recording, with what it spent, and replaying it
asks before running its command, as an unpacked run's does (`--yes` says yes).

**In a pull request's CI job.** In a [pull request's CI job](./team.md#pull-requests) (GitHub Actions
`pull_request` events, GitLab merge request pipelines, or `SHADOWLAP_PR` set), `push` writes only to the
pull request's own folder, `pr/<number>/` in the store. `pull` leaves those folders out unless given
`--include-pr`. Runs it brings from one stay on this machine: `push --all` leaves them out, and `push`
refuses one by name.

`push` and `pull` exit with:

| Status | Meaning                                                               |
| ------ | --------------------------------------------------------------------- |
| `1`    | A run it was named can't go or come, or the store fails part way      |
| `2`    | No store is set, or this machine's credentials are missing or refused |

`push --json` prints
`{ store, pullRequest, pushed, updated, unchanged, queued, repaired, refused, blobs, segment, onlyLocal, fixes }`:

| Field         | Meaning                                                                   |
| ------------- | ------------------------------------------------------------------------- |
| `store`       | The store                                                                 |
| `pullRequest` | The pull request whose folder it wrote to, or `null`                      |
| `pushed`      | The runs pushed                                                           |
| `updated`     | The runs whose labels, notes or results were merged                       |
| `unchanged`   | The runs unchanged                                                        |
| `queued`      | The runs still recording                                                  |
| `repaired`    | The parts the bucket lost, sent again                                     |
| `refused`     | Each run refused, with why                                                |
| `blobs`       | The blobs `uploaded`, already `present`, and their `bytes`                |
| `segment`     | The index segment it wrote, or `null`                                     |
| `onlyLocal`   | How many runs are still only on this machine                              |
| `fixes`       | The fixes that went with the runs, none from a pull request's job (below) |

A push's `fixes` has the ids `sent`, those that `failed` (`fixId`, `reason`), and the teammates'
`repairs` the store's copies brought.

`pull --json` prints
`{ store, pulled, merged, needPush, skippedDeleted, missing, unknown, failed, skippedSegments, blobs, segments, inStore, byAuthor, onlyLocal, pullRequests, fixes }`:

| Field                  | Meaning                                           |
| ---------------------- | ------------------------------------------------- |
| `store`                | The store                                         |
| `pulled`, `merged`     | The runs pulled, and merged                       |
| `needPush`             | The merged ones whose changes the next push sends |
| `skippedDeleted`       | Runs deleted here, and not pulled again           |
| `missing`              | Runs gone from the store                          |
| `unknown`              | Names that match no run                           |
| `failed`               | Runs that couldn't come, with why                 |
| `skippedSegments`      | Index segments that couldn't be read              |
| `blobs`                | The blobs `downloaded`, and their `bytes`         |
| `segments`             | The index segments read                           |
| `inStore`, `onlyLocal` | The runs in the store, and those only here        |
| `byAuthor`             | The pulled runs, by author                        |
| `pullRequests`         | With `--include-pr`, each pull request's folder   |
| `fixes`                | The fixes that came with the runs (below)         |

A pull's `fixes` has the ids this machine didn't have (`pulled`), those here the store's copy added to
(`merged`), those in the store that couldn't be read (`failed`: `fixId`, `reason`), and the `repairs`
whose files it wrote.

## share

```sh
shadowlap share <run> [--lineage] [--json]
```

Writes the run's [HTML report](#export-html), with every redaction rule applied, to the
[team store](./team.md#share-links), and prints a presigned link that expires after 7 days. Anyone with
the link can open it, without an account.

`share` takes these flags:

| Flag        | What it does                   | Default |
| ----------- | ------------------------------ | ------- |
| `--lineage` | Include the run's ancestors    | —       |
| `--json`    | Print the link as JSON (below) | —       |

A run still recording, or with `--lineage` one whose ancestor is, is shared once it has ended. Until then
`share` refuses it, exit status 2, before anything is asked of the store.

`--json` prints `{ runId, url, expiresAt, note, store, key, bytes, redacted, rules, runs }`:

| Field               | Meaning                                                                   |
| ------------------- | ------------------------------------------------------------------------- |
| `runId`             | The run                                                                   |
| `url`               | The link                                                                  |
| `expiresAt`         | When it expires, in epoch milliseconds                                    |
| `note`              | When it may stop working sooner: it was signed with temporary credentials |
| `store`, `key`      | The store, and the object's key in it                                     |
| `bytes`             | Its size                                                                  |
| `redacted`, `rules` | Whether it is redacted, and with how many rules                           |
| `runs`              | The runs it holds                                                         |

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

Set up the [team store](./team.md#the-store). Each subcommand takes `--json`. It has these subcommands:

| Subcommand | What it does |
| --- | --- |
| [`set`](#store-set) | Write the store's URL to the config, after checking it against the provider's scheme |
| [`check`](#store-check) | Prove this machine's credentials can list, write, read and delete a test object |
| [`show`](#store-show) | The last push and pull, the runs in the store and only here, and the last check, offline |
| [`policy`](#store-policy) | Print the two policies to ask your cloud admin for |
| [`ci`](#store-ci) | Print a CI step that runs `test --push` |
| [`push-from-ci`](#store-push-from-ci) | Whether CI pushes its test runs and fixes |

They take these flags:

| Flag | What it does | Default |
| --- | --- | --- |
| `--provider <provider>` | `set`: check the URL against this provider's scheme only. `policy`: the provider. One of `s3`, `gcs`, `azure`, `r2` | `policy`: the store's |
| `--check` | `set`: check access first, as `check` does, and write the store only when it works | — |
| `--provider <ci>` | `ci`: `github`, `gitlab` or `other` | — |
| `--packs <glob>` | `ci`: the goldens to test | `goldens/*` |
| `--json` | Print the result as JSON (below) | — |

### `store set`

Checks the URL against the provider's scheme (with `--provider`, against that one only), and writes it
to the config, keeping everything else.

With `--check`, it first checks the store as `check` does, and writes nothing when that fails. It then
says what to fix, and to run the same `store set … --check` again (in the dashboard's store setup,
**Check access and connect** again).

With `--json`, `set` prints `{ store, url, provider, bucket, prefix, account, region, previous, config, set }`:

| Field                                               | Meaning                                                |
| --------------------------------------------------- | ------------------------------------------------------ |
| `store`                                             | The store, as written to the config                    |
| `url`                                               | Its URL, without the options after `?`                 |
| `provider`, `bucket`, `prefix`, `account`, `region` | Its parts                                              |
| `previous`                                          | The store it replaced                                  |
| `config`                                            | The config file's path                                 |
| `set`                                               | True once the config is written                        |
| `check`                                             | With `--check`: the check, as `check --json` prints it |

When the check fails, it prints only `{ store, url, provider, set, check }`, with `set` false. It writes
nothing, and exits 1.

### `store check`

Proves this machine's credentials can list, write, read and delete a test object, and reports
encryption, versioning and object lock, with a warning when versioning or object lock is off. It exits 1
when access fails.

`check` prints
`{ url, credentials, steps, ok, encryption, versioning, objectLock, warnings, notes, failure, pullRequest }`:

| Field                                    | Meaning                                      |
| ---------------------------------------- | -------------------------------------------- |
| `url`                                    | The store's URL                              |
| `credentials`                            | Where the credentials came from              |
| `steps`                                  | Each step: `name`, `ok`, `detail`, `code`    |
| `ok`                                     | Whether all passed                           |
| `encryption`, `versioning`, `objectLock` | The bucket's, each with `state` and `detail` |
| `warnings`                               | Its warnings                                 |
| `notes`                                  | What couldn't be checked                     |
| `failure`                                | The kind of the first failure                |
| `pullRequest`                            | The pull request whose folder it checked     |

### `store show`

Shows the last push and pull, the runs in the store and only here, and the last check, offline.

`show` prints
`{ url, store, provider, providerName, bucket, prefix, region, pushedAt, pulledAt, inStore, onlyLocal, localAttempts, queued, check }`:

| Field | Meaning |
| --- | --- |
| `url`, `store`, `provider`, `providerName`, `bucket`, `prefix`, `region` | The store, and its parts |
| `pushedAt`, `pulledAt` | The last push and pull, in epoch milliseconds |
| `inStore` | The runs in the store |
| `onlyLocal` | The runs only here: a run counts while it, or an attempt filed under it, is only here |
| `localAttempts` | The attempts only here |
| `queued` | The runs still recording, to go when they end (below) |
| `check` | The last check: `ok`, `at`, `encryption`, `versioning`, `objectLock`, `credentials` |

A queued run that ended since counts as only here until the next push sends it, and a queued run that
was deleted is forgotten.

### `store policy`

Prints two policies scoped to the store's folder, each an IAM policy, role bindings, a role assignment
or R2 token scopes:

- one for people and CI on protected branches;
- one for pull requests' CI jobs, which may write only under `pr/`.

`policy` prints `{ provider, writer, pullRequest, notes }`: each policy with whom it is `for`, its
`kind`, its `text` and `notes`.

### `store ci`

Prints a step for GitHub Actions, GitLab CI or any other CI.

- **Credentials**: short-lived ones (OIDC) where the CI and the cloud allow it, and the pull-request
  credentials beside the protected branches'. On GitHub, that is for pull requests from the repository
  itself: a fork's gets no OIDC token, so its job skips them and runs the tests without pushing.
- **The tests** run with `npx shadowlap@<version>`, this CLI's own release. On GitHub, Node 22 and a line
  for the agent's dependencies (`npm ci && npm run build`, to make your project's) come before them. On
  GitLab, that line opens each job's script.
- **Keys**: the goldens it tests that run live (marked `fork`, or with an injection gate) need the keys
  of the providers their recordings call. On GitHub, the step's `env` takes them from the repository's
  secrets, by name. On GitLab and any other CI, a note names them.
- **Keys it can't name**: a comment says to add your agent's own, where a key can't be named: a pack
  that can't be read, or Vertex AI, which signs in with a token.

`ci` prints `{ ci, provider, file, text, oidc, pullRequests, notes }`:

| Field            | Meaning                                                                           |
| ---------------- | --------------------------------------------------------------------------------- |
| `ci`, `provider` | The CI, and the cloud provider                                                    |
| `file`, `text`   | The file the step goes in, and the step's text                                    |
| `oidc`           | Whether it uses short-lived credentials                                           |
| `pullRequests`   | Whether pull requests' jobs push to their `own-folder`, or not at all (`no-push`) |
| `notes`          | What to set up once, on the cloud side                                            |

### `store push-from-ci`

`push-from-ci off` writes `"ciPush": false` to the config. `test --push` in CI then runs the tests and
keeps their runs in the job (outside CI, `--push` still pushes), and the GitHub Action keeps the fixes
it opens there too. `on` turns it back on.

`push-from-ci` prints `{ ciPush, previous, config }`.

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

Its keys are these:

| Key | What it does |
| --- | --- |
| `normalize` | Masks values before fingerprinting, so an id the agent makes on every run does not fork a replay ([details](./normalizers-and-redaction.md)) |
| `redact` | Masks stored content in every export, pack and share link of a run (below) |
| `clock` | `auto` (default) matches dates near each run's start across days; `exact` requires equality |
| `http` | Hosts called straight from a client library, recorded as tool calls with an effect ([details](./sdk.md#http-services-without-wrapping)) |
| `mcp.effects` | Effects by MCP tool name, overriding the server's annotations ([details](./mcp.md)) |
| `tools` | `trust` by tool name, and `unrecorded` (below) |
| `prices` | USD per million tokens by model prefix, for cost estimates |
| `tests` | Outcome checks for `shadowlap test`, by recording directory, and each golden's gates, task and presets (below) |
| `repair` | `repairer` (`provider:model`), `baseUrl` and `timeout` for the model [`shadowlap repair`](./repair.md#the-repairer) asks for fixes (below) |
| `store` | The [team store](./team.md), a bucket you own (`s3://`, `gs://`, `az://`, `r2://`), written by [`shadowlap store set`](#store). Never credentials |
| `ciPush` | `false` keeps `test --push` in CI, and the GitHub Action, from pushing (`shadowlap store push-from-ci on\|off`; below) |
| `guard` | `accept: ["claude-code"]`: take the Claude Code CLI as it is under `--guard block` (below) |

More on some of them:

- **`redact`**: [where the rules apply](./normalizers-and-redaction.md#where-the-rules-apply). A redacted
  pack still replays, and a push copies runs to the team store as recorded.
- **`tools`**: `trust` by tool name (or a host under `http`): set it to `untrusted` for a read that
  brings outside text in, where [`shadowlap injection`](./injection.md) plants payloads. It is recorded on each call of
  the tool as it is made. Read when a run is tested, it wins over every recorded mark: the SDK's, an MCP
  server's, an earlier config's.
- **`tools.unrecorded`** maps the tools the agent runs without Shadowlap recording them to `read` or
  `write`. That decides whether every command that replays a run may run them again
  ([details](./how-it-works.md#tools-shadowlap-did-not-record)).
- **`repair.timeout`**: the seconds the repairer may take to answer, default 600.
- **`ciPush`**: `false` keeps `test --push` from pushing to the team store in CI, and the GitHub Action
  from pushing the fixes it opens.
- **`guard`**: what the Claude Code CLI the [Claude Agent SDK](./frameworks.md#claude-agent-sdk) runs can
  reach that the guard can't watch is named, and fails nothing, while every Node and Python process keeps
  block. `SHADOWLAP_GUARD_ACCEPT=claude-code` and the GitHub Action's `guard-accept` input add to it. Any
  other value is refused, exit status 2, before anything runs.

A golden's entry under `tests` holds:

- its outcome checks ([details](./ci.md#outcome-checks)): `calls`, `when` and `judge` in
  [Checks](./checks.md), and [judge checks](./judges.md);
- a `gate` that decides on a forked golden's attempts with stated error rates ([gating](./gating.md));
- an `injection` gate ([details](./injection.md#gate-ci-on-it));
- a `task` object, with where a model under test takes over, why, what the task rewards and the agent's
  scope (see [Training](./training.md));
- a `chaos` object, with the golden's [error-path presets](./error-paths.md#configure-a-goldens-presets),
  or `false` to leave it out of them.

The schema is
[`shadowlap.config.schema.json`](https://github.com/devjoinedthechat/shadowlap/blob/main/shadowlap.config.schema.json)
in the repository. It gives completion in any editor that reads `$schema`, and it lets CI check a config
without running Shadowlap.

It is stricter than the parser on purpose. The parser ignores a key it doesn't know, so that a config
written for a newer version still works, while the schema rejects it. That is what turns `"normalise"`
from a rule that silently never applies into an error you see as you type.

`shadowlap doctor` checks the file too, and reports every rule, price and effect it parsed.

## Environment

These environment variables change what Shadowlap does:

| Variable | What it does | Default |
| --- | --- | --- |
| `SHADOWLAP_UPSTREAM_ANTHROPIC`, `_OPENAI`, `_GEMINI`, `_AZURE`, `_VERTEX`, `_BEDROCK` | Override a provider's upstream: a mock, or an OpenAI-compatible server such as Ollama | `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL` and `GOOGLE_GEMINI_BASE_URL`, when they are set |
| `SHADOWLAP_GUARD_ACCEPT=claude-code` | Accept the Claude Code CLI's unwatched connections under `--guard block`, as `guard.accept` in the [config](#the-configuration-file) does (below) | — |
| `SHADOWLAP_CAPTURE=off` | Don't capture model calls inside Node and Python agents; only the base-URL variables apply ([details](./providers.md#in-process-capture)) | — |
| `SHADOWLAP_TELEMETRY=0`, `DO_NOT_TRACK=1` | Disable [telemetry](./telemetry.md) | — |
| `SHADOWLAP_TELEMETRY_URL` | Send [telemetry](./telemetry.md) to a collector you run | Nothing is sent |
| `SHADOWLAP_AUTHOR` | Who made the runs and activity entries a command records, as the dashboard shows them | `ci` in CI, else git's `user.email`, else the OS user |
| `SHADOWLAP_PR` | A pull request's number, set in its CI build (below) | — |
| `SHADOWLAP_HOME` | Where this machine's files go, as an absolute path: the dashboard's [project list](./dashboard.md#projects), and the registrations of running agents and `mcp --listen` proxies | `~/.shadowlap` |
| `SHADOWLAP_PROJECT_ROOTS` | Folders besides your home folder that the dashboard may suggest and add projects from, separated like `PATH` | — |
| `SHADOWLAP_TASKS_TOKEN` | The token `tasks serve` requires, at least 16 characters | A random one, printed |
| `SHADOWLAP_ALLOW_UNRECORDED` | For `serve --recordings`, in a recording's environment: what `--allow-unrecorded <names>` says ([`serve`](#serve)) | — |
| `SHADOWLAP_DEBUG=1` | Print the stack of any error, for a bug report ([exit status](#exit-status)) | — |
| `OLLAMA_HOST` | Where `tasks models` lists Ollama's installed models | `127.0.0.1:11434` |
| `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` | Reach the team store and the clouds' sign-in services through a proxy ([details](./team.md#the-store); below) | — |
| `NO_COLOR` | Plain output | — |
| `SHADOWLAP_UI_THEME` | `dark`, `light` or `ansi`: the [terminal UI](./tui.md#colours)'s palette | The one picked from what the terminal reports |

- **`SHADOWLAP_GUARD_ACCEPT`**: any other value ends every command that takes `--guard` with 2 as it
  starts, before anything runs.
- **`SHADOWLAP_PR`** is for where Shadowlap doesn't recognise pull requests by itself; it does on GitHub
  Actions and GitLab CI. The build then writes only to that pull request's folder in the
  [team store](./team.md#pull-requests).
- **`SHADOWLAP_HOME`**: a relative path is ignored, and `~/.shadowlap` holds all of these files
  instead, as the dashboard says. It holds your dashboard [Spending](./dashboard.md#settings) too, in
  `settings.json`. Processes that find each other's files there need the same one, so give it to
  `shadowlap mcp` in your MCP client's configuration too ([details](./mcp.md#finding-the-run)).
- **The proxy variables**: the agent never reaches the sidecar through one. `run`, `replay`, `test` and
  `serve --recordings` add `127.0.0.1`, `localhost` and `::1` to `NO_PROXY` and `no_proxy`.

## See also

- [Quickstart](./quickstart.md): a first recording, step by step.
- [How it works](./how-it-works.md): recording, replaying and forking.
- [CI](./ci.md): goldens, outcome checks and test history.
- [Interventions](./interventions.md): what each flag that changes a replay does.
- [Blame](./blame.md), [Verify](./verify.md) and [Repair](./repair.md): finding and fixing a failure.
- [Team store](./team.md): sharing runs with your team.
