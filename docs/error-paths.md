# Error-path presets

Error-path presets fork a golden where a tool or the provider fails, and check that the agent's
error path still does the right thing.

A recording of a healthy run never holds a tool timeout or a rate limit, so a golden never tests what
the agent does then. General fuzzing would, but every mutation changes the next request, so each one
costs a live run, and most of what it finds is a failure no real system produces. Six presets cover
the failures agents meet in production:

```sh
shadowlap test goldens/* --chaos
```

```
⚡ goldens/forecast: 6 error-path presets at get_forecast (#3) and model call #4
  ✓ tool timeout      passed         timed out: the agent exited 0
  ✓ empty result      passed         answered with nothing: the agent exited 0
  ✗ malformed JSON    failed         answered malformed JSON: the agent exited with code 1
      SyntaxError: Unterminated string in JSON at position 52 (line 1 column 53)
  ✓ oversized result  passed         answered 1,000,000 characters: the agent exited 0
  ✓ provider 429      passed         failed with HTTP 429: the agent exited 0
  ✓ provider 500      passed         failed with HTTP 500: the agent exited 0

5 passed, 1 failed · 2 upstream requests
```

## The presets

| Preset | What the agent gets |
|---|---|
| `timeout` | The tool times out: it doesn't run, and the agent's SDK raises the timeout its tool would (`TimeoutError`, or an HTTP library's own) |
| `empty` | The tool answers with nothing: an empty list, object or text, whichever it recorded. An HTTP tool gets an empty body of its type, an MCP tool no content |
| `malformed` | The tool answers with its JSON cut short, as a response that stopped arriving is. A tool that returned data gets the cut JSON text in its place |
| `oversized` | The tool answers with its longest text repeated until the answer is a million characters long, far past what a model's context takes. JSON stays JSON: its longest string grows, or its longest list |
| `429` | The model call that reads the tool's answer is rate-limited, every attempt of it, so the SDK's retries run out |
| `500` | The same, with a server error |

## Where they hit

Every preset hits one place in the recording, so each fork tells you about one failure:

- **The tool presets** hit the first tool call that reads the world: a `read` tool, else one whose
  effect nothing declares, else a write. Never a `pure` tool, which is your own code; never what a
  person typed; never a call that already failed when it was recorded. `--chaos-tool <name>` (or
  `chaos.tool`) picks the first call of another tool.
- **The provider presets** hit the model call after it, the one that would read its answer: the
  agent is mid-task, with state built up. With no tool call to hit, they hit the first model call.

Everything before that call is served from the recording, for free.

## How a preset is judged

Each preset is a fork: from the call it hits, the agent runs live, so like a
[golden that forks](./ci.md#recordings-that-fork-on-purpose) it needs the providers, and its later
model calls spend tokens. Writes after the fork are stubbed: the agent is told they succeeded and
nothing is sent (`--writes block` makes them fail instead).

An attempt passes when the agent exits 0 and passes the checks `chaos.expect` gives. The golden's own
`expect` doesn't judge it: those checks describe the path its recording took (a refund issued, an
email sent), and an agent that escalates when the order lookup times out is right not to take it. Say
what must hold on any path instead, such as never refunding twice:

```json
{
  "tests": {
    "goldens/refund-in-limit": {
      "expect": { "tools": { "issue_refund": 1, "send_email": 1 } },
      "chaos": { "expect": { "tools": { "issue_refund": "<= 1", "send_email": "<= 1" } } }
    }
  }
}
```

A preset's verdict is one of four:

- **passed** and **failed**, by the gate below;
- **inconclusive**: the gate ran out of attempts between its bounds, or the replay never reached the
  call (a golden that no longer replays as far as that: `shadowlap test` says why);
- **not applicable**: the recording has no call the preset can hit, or no answer it can change (a
  binary response, a result with no text or list to grow).

A preset whose change never reaches a model request (the agent reads one field of the answer, and
that field is still there) replays clean from there: it was played in, and the agent coped.

## Gating

Forks vary, so a preset can be decided over several attempts, as they come in:

- **By default**, by the golden's `repeat` and `passes`, as its own forks are.
- **With `chaos.gate`**, by a sequential test: `{ "good": 0.9, "bad": 0.5, "risk": 0.1, "max": 6 }`
  passes at 90% or more and fails at 50% or less, each with at most 10% risk of the wrong verdict.
  Each passing attempt adds ln(good/bad) to its score, each failure ln((1−good)/(1−bad)), and it stops
  as soon as the score crosses ±ln((1−risk)/risk): with these figures, after four passes or two
  failures. Inconclusive after `max` attempts.

`--inconclusive fail` (the default) fails the command on an inconclusive preset; `--inconclusive warn`
reports it and exits 0.

## Configure a golden's presets

Under its `tests` entry in `shadowlap.config.json`, every key optional:

| Key | What it says |
|---|---|
| `presets` | Which presets `test --chaos` runs on it, such as `["timeout", "429"]`. Default all six; `--presets` overrides it |
| `expect` | What every attempt must pass besides exiting 0, in the grammar of `expect` |
| `tool` | The tool whose first call the tool presets hit |
| `gate` | `{ good, bad, risk, max }`, the sequential test above |
| `oversize` | How many characters an oversized answer grows to (default 1000000) |
| `timeout` | Seconds an attempt may run before it is stopped, and fails (default 300): an error path can hang |

`"chaos": false` leaves the golden out of every `--chaos` session.

## On any run

```sh
shadowlap replay <run> --chaos --expect '{"tools":{"issue_refund":"<= 1"}}'
```

runs the presets on a run of the store, judged by `--expect` (or the `chaos.expect` of the golden the
run came from). It doesn't combine with the flags that change a replay, such as `--override` or
`--fail-at`: each preset is played in alone.

## In CI

Presets cost tokens, so they suit a nightly job better than every pull request:

```sh
shadowlap test goldens/* --chaos --junit chaos.xml --markdown "$GITHUB_STEP_SUMMARY"
```

`--junit` writes a case per preset, and `--markdown` a table of them. `--json` writes the report, with
each attempt's run ([its fields](./cli.md#error-path-presets)).

## What is kept

Each session and every preset's result are kept in the store: the call it hit, the verdict, the
attempts and their runs. Each attempt is a run of its own, bundled under the recording it forked, so
`shadowlap show` opens the error path the agent took.

## Limits

- **One place per preset.** The presets hit the first read and the model call after it. A failure
  later in the run is a fork of its own: [`--fail-at`](./interventions.md#fail-a-tool) and
  [`--override`](./cli.md#replay) play one in where you choose.
- **An oversized answer costs what it costs.** Most models refuse a request past their context, at
  no charge; one with a context of a million tokens reads it. Lower `chaos.oversize`, or leave the
  preset out, for those.
- **Every attempt of the failed model call fails.** The SDK's retries meet the same failure, and so
  does the agent's own: one that retries for ever runs until the attempt's time limit (`timeout`,
  5 minutes by default), and fails.
