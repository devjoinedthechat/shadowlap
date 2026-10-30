# Production coverage

Production coverage shows which behaviours seen in your imported production traffic no golden covers, and turns one run of each into a golden.

A golden suite is only as good as what it holds. The runs you packed as goldens were the ones someone noticed; production does more than that. Traffic comes into the store with [`shadowlap import`](./cli.md#import) of:

- a [LiteLLM capture](./gateways.md);
- a HAR;
- an OpenTelemetry, Langfuse, LangSmith, Phoenix or Logfire trace.

`shadowlap coverage` then groups those runs by what they did and checks each group against the goldens:

```sh
shadowlap import litellm captures/*.jsonl
shadowlap coverage
```

It prints:

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

## What a behaviour is

Two runs behave alike when three things match:

| Part         | What matches                           |
|--------------|----------------------------------------|
| The path     | The tools the model called, in order   |
| The writes   | The write tools on the path, each once |
| How it ended | Its ending, from the table below       |

**The path.** The calls one answer asked for together match in any order, since an agent runs them at once. This is how [`replay --repeat`](./cli.md#repeating-a-fork) reads paths, but from the model's answers rather than the recorded tool calls. A capture of the network holds no tool calls, and a golden's answers say what its tool calls did, so the two compare.

**The writes.** A tool's effect comes from what the SDKs and `shadowlap mcp` recorded for it in this store and in the goldens, and from the config's MCP effects. A tool nothing names is counted as a write, and listed as of unknown effect.

**How it ended.** A run ends one of these ways:

| Ending        | The run ended                           |
|---------------|-----------------------------------------|
| `answered`    | With an answer                          |
| `model-error` | On a model call that failed             |
| `token-limit` | At the token limit                      |
| `tool-call`   | On a tool call nothing answered         |
| `agent-error` | For a recording, with the agent failing |

Arguments are not part of a behaviour: a refund of $40 and one of $240 take the same path. Give a golden the checks that tell them apart ([outcome checks](./ci.md#outcome-checks)).

### What coverage reads

Coverage reads the runs that came into the store with no command of their own: captures and traces. The goldens are read from their packs on disk, the goldens folder and the packs `tests` names, as `shadowlap test` reads them. So a golden counts whether or not this machine has run it.

A golden covers a behaviour when its recording behaves the same way. For a behaviour no golden covers, the report names the golden that shares the most of its path and the step where they part. That is usually where the uncovered behaviour starts.

## Make goldens of what isn't covered

```sh
shadowlap coverage --pack                          # one golden of each behaviour no golden covers
shadowlap coverage --pack 3f9a2c1d                 # of one behaviour, by its key
shadowlap coverage --pack -- node agent.mjs '{message:/[A-Z]-\d+/}'
```

A capture holds model calls, but no tool calls and no command, and `shadowlap test` can only replay a run it can start. So `--pack` makes the golden the way an import becomes one: it replays the capture with the agent's own command, and packs that replay.

1. **It finds the command** that starts the agent on the capture's input ([below](#the-command)).
2. **It serves the tool results from the capture itself**, so nothing reaches your systems ([below](#the-tool-results)).
3. **It replays offline**, every model call served from the capture. A replay that sends every request the capture holds, and exits 0, is a recording of your agent, as it is today, doing what production did.

That replay is packed into `goldens/<first tool>-<writes>-<key>`, with your redaction rules, and kept in the activity feed. Review the goldens it makes in a pull request like any other.

### The command

The command is that of the newest run in this store (yours, not one from a pack or the team store) whose first model call sent the capture's first request. That is the same request once the normalizers have masked what changes on every run, or the same bytes. `coverage --json` shows it for each behaviour, as `command`.

Production traffic usually comes from input nobody here ran, so the command after `--` is tried next, with the capture's own input filled in:

| Placeholder         | Stands for                                                               |
|---------------------|--------------------------------------------------------------------------|
| `{message}`         | The capture's first message: the text of the first user turn it sent     |
| `{message:/regex/}` | The part of it the regex picks: its first group, or else the whole match |

`{message}` suits an agent that takes the customer's question as its argument. `{message:/regex/}` suits one that takes the order number and writes the message itself.

The value reaches the agent as one argument, as it was. A placeholder is refused where the message would run as code: in a shell's script, or after an interpreter's `-c`, `-e` or `-m`. It is refused too where the message would name what runs:

- the program;
- the script an interpreter runs (`node {message}`), or one of its own flags (`--eval={message}`);
- the command a runner such as `env`, `cross-env` or `npx` runs;
- what a package manager's subcommand runs (`npm exec`, `pnpm dlx`, `bun x`, `uv run`, `pipx run` and the like).

A capture whose message would start an argument with a dash, which the agent would read as one of its flags, is left out, saying why. A regex is checked as a redaction rule's is ([Patterns that could take too long](./normalizers-and-redaction.md#patterns-that-could-take-too-long)), and one that runs too long on a message is stopped and its capture left out.

### The tool results

Every model request carries the conversation so far, so the result of each tool the model asked for is in the next request. The replay serves each tool call that result, as a recording would, so nothing reaches your systems. A tool served through [`shadowlap mcp`](./mcp.md) gets it back as MCP content.

A tool the capture holds calls of itself (a trace that kept them, an HTTP service a HAR saw) keeps those. A tool that got no result back in the capture runs live, with writes stubbed.

### When a behaviour isn't packed

The newest three runs of a behaviour are tried before it gives up. A behaviour that isn't packed says why, in a word in `--json` (`reason`) and a sentence (`why`), and the store keeps it for the next scan and the dashboard:

| Reason | What happened | What packs it |
|---|---|---|
| `no-command` | No run here sent its first request, and no command was given, or its placeholder found nothing in the first message | The agent's command after `--`, with `{message}` where its input goes |
| `other-message` | The command started the agent with another first message than production's | The right command, or `{message}` in it |
| `not-reproduced` | Started as production started it, the agent sends something else | `--fork`, below |
| `agent-error` | The agent failed on what production got back | Its error is in the sentence |
| `gone` | Its runs were deleted | A newer capture of it |

A behaviour is `not-reproduced` when the prompt or the code changed since the traffic, or when the agent passes a tool other arguments than the model's.

## Keep what the agent no longer does

A golden made the plain way passes while the agent behaves as production did. When it no longer does (production refunded what it should have escalated, and the agent was fixed since), the behaviour can still be kept, as the test that the change holds:

```sh
shadowlap coverage --pack 1db3eff9 --fork --expect '{"tools":{"issue_refund":0,"escalate":1}}'
```

`--fork` packs production's run, with the command that starts the agent as production did, as a [golden that forks](./ci.md#recordings-that-fork-on-purpose). `shadowlap test` replays it until the agent parts from it, runs live from there, and passes on the checks `--expect` gave. They are written to its `tests` entry with `"fork": true`.

Name the behaviours (a golden that forks is one you chose) and say what the agent must do instead. Like any golden that forks, it needs the providers when it runs.

On a behaviour the agent still reproduces, `--fork` packs its replay with the same checks. They then judge what production did, so a golden whose checks it breaks fails until the agent is fixed: the test that the fix holds, written before the fix.

## Every week

Production traffic changes when your users do. A scheduled job keeps the suite in step:

```sh
shadowlap import litellm /var/log/shadowlap/*.jsonl
shadowlap coverage --pack --not-packed warn -- node agent.mjs '{message:/[A-Z]-\d+/}'
git add goldens && git commit -m "Keep this week's production behaviours as goldens"
```

`--not-packed warn` reports the behaviours it couldn't pack and exits 0, so the job goes on to commit what it did pack. Without it, `--pack` exits 1 when a behaviour asked for wasn't packed.

The ones it couldn't pack wait in the report for a person: a command, or `--fork` with the checks that say what the agent must do instead.

## What is kept

Each scan is kept in the store: when it ran, who ran it, what it read, and the behaviours it found. Each behaviour is kept with its runs, the goldens that cover it or the nearest one, and the command `--pack` would reproduce it with.

A scan replaces the last scan's behaviours, and keeps its totals beside the ones before it. What `--pack` last made of each behaviour, the golden or why not, is kept across scans. [`--json`](./cli.md#coverage) prints the same.

## Limits

- **Arguments and results aren't compared.** Two runs that called the same tools in the same order behave alike here, whatever they passed or got back.
- **A tool of unknown effect counts as a write.** Declare its effect in the SDK, or in `mcp.effects`, and the next scan reads it.
- **The agent's input has to show in its first message.** `{message}` reads it from there. An agent that reads its input from elsewhere (a queue, a database, a file) needs a command that does that, or a run here that sent the same first request.
- **A value that changes on every run must be masked.** A request id or a timestamp the agent writes into its first request keeps the replay from matching production's: add a [normalizer](./normalizers-and-redaction.md) for it, as for any golden.
- **A capture from older code may not reproduce.** The replay that packs it runs the code you have today. When that code sends another request, the behaviour is reported as not reproduced, which is itself news: production did something your agent no longer does. `--fork` keeps it.

## See also

- [`shadowlap import`](./cli.md#import) and [`shadowlap coverage`](./cli.md#coverage) in the CLI reference.
- [Capturing production traffic](./gateways.md): through a gateway, such as LiteLLM.
- [CI mode](./ci.md): goldens, their checks, and goldens that fork.
