# Production coverage

Production coverage shows which behaviours seen in your imported production traffic no golden
covers, and turns one run of each into a golden.

A golden suite is only as good as what it holds. The runs you packed as goldens were the ones
someone noticed; production does more than that. Once traffic comes into the store
([`shadowlap import`](./cli.md#import) of a [LiteLLM capture](./gateways.md), a HAR, an
OpenTelemetry, Langfuse or LangSmith trace), `shadowlap coverage` groups those runs by what they
did and checks each group against the goldens:

```sh
shadowlap import litellm captures/*.jsonl
shadowlap coverage
```

```
Coverage of what 3 imported runs did: 2 behaviours, 1 not covered by a golden (1 golden read)

  ✗ 2 runs   lookup_order → read_policy → issue_refund
             writes issue_refund · answered · seen 2d ago in refund.har
             nearest golden: goldens/escalate, the same for 2 steps; then it calls issue_refund where the golden calls escalate
             runs: 01K5CQ9C4H 01K5CQ9B7Q · behaviour 3f9a2c1d5e8b7a60

  ✓ 1 run    lookup_order → read_policy → escalate
             writes escalate · answered · seen 2d ago in escalate.har
             covered by goldens/escalate
```

## What a behaviour is

Two runs behave alike when three things match:

- **The path:** the tools the model called, in order. The calls one answer asked for together match
  in any order, since an agent runs them at once. This is how [`replay --repeat`](./cli.md#repeating-a-fork)
  reads paths, but from the model's answers rather than the recorded tool calls: a capture of the
  network holds no tool calls, and a golden's answers say what its tool calls did, so the two compare.
- **The writes:** the write tools on the path, each once. A tool's effect comes from what the SDKs and
  `shadowlap mcp` recorded for it in this store and in the goldens, and from the config's MCP
  effects. A tool nothing names is counted as a write, and listed as of unknown effect.
- **How it ended:** with an answer (`answered`), on a model call that failed (`model-error`), at the
  token limit (`token-limit`), on a tool call nothing answered (`tool-call`), or, for a recording,
  with the agent failing (`agent-error`).

Arguments are not part of a behaviour: a refund of $40 and one of $240 take the same path. Give a
golden the checks that tell them apart ([outcome checks](./ci.md#outcome-checks)).

The goldens are read from their packs on disk, the goldens folder and the packs `tests` names, as
`shadowlap test` reads them, so a golden counts whether or not this machine has run it. A golden
covers a behaviour when its recording behaves the same way. For a behaviour no golden covers, the
report names the golden that shares the most of its path and the step where they part, which is
usually where the new behaviour starts.

## Make goldens of what isn't covered

```sh
shadowlap coverage --pack                          # one golden of each behaviour no golden covers
shadowlap coverage --pack 3f9a2c1d                 # of one behaviour, by its key
shadowlap coverage --pack 3f9a2c1d -- node agent.mjs B-7
```

A capture holds model calls, but no tool calls and no command, and `shadowlap test` can only replay
a run it can start. So `--pack` makes the golden the way an import becomes one: it replays the capture
with the agent's own command, and packs that replay.

1. **The command** is the one after `--`, or else the command of the newest recording in this store
   (yours, not one from a pack or the team store) whose first model call sent exactly the capture's
   first request. `coverage --json` shows it for each behaviour, as `command`.
2. **The tool results come from the capture itself.** Every model request carries the conversation
   so far, so the result of each tool the model asked for is in the next request. The replay serves
   each tool call that result, as a recording would, so nothing reaches your systems. A tool that got
   no result back in the capture runs live, with writes stubbed.
3. **It is offline.** Every model call is served from the capture. A replay that sends every request
   the capture holds, and exits 0, is a recording of your agent, as it is now, doing what production
   did. It is packed into `goldens/<first tool>-<writes>-<key>`, with your redaction rules, and kept
   in the activity feed.

A replay that forks is not packed, and the report says where it left the capture. That happens when
the agent now sends something else (the prompt or the code changed since the traffic was captured),
or when the agent passes a tool other arguments than the model's, or a result it reshaped. The
newest three runs of a behaviour are tried before it gives up. Review the new goldens in a pull
request like any other.

A golden made this way is a plain replay: it passes while the agent behaves as production did. To
keep a behaviour you don't want (production refunded what it should have escalated) as the test that
the fix holds, mark it [`fork`](./ci.md#recordings-that-fork-on-purpose) and give it the checks
that say what it must do instead.

## Every week

Production traffic changes when your users do. A scheduled job keeps the suite in step:

```sh
shadowlap import litellm /var/log/shadowlap/*.jsonl
shadowlap coverage --pack -- node agent.mjs
git add goldens && git commit -m "Keep this week's production behaviours as goldens"
```

`coverage` exits 0 whatever it finds; with `--pack`, 1 when a behaviour could not be packed, so the
job's log says which ones need a look.

## What is kept

Each scan is kept in the store: when it ran, who ran it, what it read, and the behaviours it found,
each with its runs, the goldens that cover it or the nearest one, and the command `--pack` would
reproduce it with. A scan replaces the last scan's behaviours, and keeps its totals beside the ones
before it. [`--json`](./cli.md#coverage) prints the same.

## Limits

- **Arguments and results aren't compared.** Two runs that called the same tools in the same order
  behave alike here, whatever they passed or got back.
- **A tool of unknown effect counts as a write.** Declare its effect in the SDK, or in `mcp.effects`,
  and the next scan reads it.
- **A capture from older code may not reproduce.** The replay that packs it runs the code you have
  now. When that code sends another request, the behaviour is reported as not packed, which is itself
  news: production did something your agent no longer does.
