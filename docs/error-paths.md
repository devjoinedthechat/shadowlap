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
  ✓ tool timeout      passed  timed out: the agent exited 0, 1 check passed
  ✓ empty result      passed  answered with nothing: the agent exited 0, 1 check passed
  ✗ malformed JSON    failed  answered malformed JSON: the agent exited with code 1
      SyntaxError: Unterminated string in JSON at position 52 (line 1 column 53)
  ✓ oversized result  passed  answered 1,000,000 characters: the agent exited 0, 1 check passed
  ✓ provider 429      passed  failed with HTTP 429: the agent exited 0, 1 check passed
  ✓ provider 500      passed  failed with HTTP 500: the agent exited 0, 1 check passed
  checks: send_alert called at most 1 time (the write limits of the golden's expect)

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
nothing is sent. A golden that forks blocks them instead, but a blocked write raises an error in
the agent, and every preset would then test that error too; stubbed, the preset is the only failure
played in. `--writes block` blocks them anyway.

An attempt passes when the agent exits 0 and passes the checks an error path must pass. The
golden's own `expect` describes the path its recording took (a refund issued, an email sent), and
an agent that escalates when the order lookup times out is right not to take it, so not all of it
carries over:

- **By default, its write limits.** The upper bounds the golden's `expect` sets on write tools (and
  tools whose effect nothing declares) hold on any path: `"issue_refund": 1` becomes "at most once",
  `"send_email": 0` stays "never". Lower bounds, and bounds on reads, describe the recorded path, and
  are left out: a read retried after a timeout is the agent doing its job.
- **With `chaos.expect`**, those checks instead, in the grammar of `expect`:

```json
{
  "tests": {
    "goldens/refund-in-limit": {
      "expect": { "tools": { "issue_refund": 1, "send_email": 1 } },
      "chaos": { "expect": { "tools": { "issue_refund": "<= 1", "escalate": "<= 1" } } }
    }
  }
}
```

The table's last line names the checks and where they came from. A golden whose `expect` sets no
upper bound on a write, and that has no `chaos.expect`, is judged on the agent exiting 0 alone, and
the command says so.

A preset's verdict is one of four:

- **passed** and **failed**, by the gate below;
- **inconclusive**: the gate ran out of attempts between its bounds, the replay never reached the
  call (a golden that no longer replays as far as that: `shadowlap test` says why), or a
  [check](./checks.md#how-a-check-comes-out) could not be decided, such as a judge with no way to
  be asked, which no further attempt would decide either;
- **not applicable**: the recording has no call the preset can hit, or no answer it can change (a
  binary response, a result with no text or list to grow, a tool that already answered with nothing).

A preset whose change never reaches a model request (the agent reads one field of the answer, and
that field is still there) replays clean from there: it was played in, and the agent coped.

## Gating

Forks vary, so a preset can be decided over several attempts, as they come in:

- **By default**, by the golden's `repeat` and `passes`, as its own forks are.
- **With `chaos.gate`**, by a sequential test: `{ "good": 0.9, "bad": 0.5, "risk": 0.1, "max": 6 }`
  tells an agent that copes 90% of the time or more from one that copes 50% or less, each verdict
  wrong at most 10% of the time at those two rates (between them, either can come). Each preset's
  line shows its tally and the Wilson bound of its pass rate, `timed out: 4 of 4 attempts passed ·
  rate >= 0.60 (90%)`, and the table states the rule once under it: `gate: tells 90%+ from 50%- at
  <= 10% risk, up to 6 attempts`.
  Each passing attempt adds ln(good/bad) to its score, each failure ln((1−good)/(1−bad)), and it stops
  as soon as the score reaches ±ln((1−risk)/risk): with these figures, after four passes or two
  failures. Inconclusive after `max` attempts. Every figure is optional (0.9, 0.7, 0.05 and 80 when
  left out, as for a golden's own [gate](./gating.md)), and a `max` too small for an agent that
  always passes to reach the pass bound is refused, since the gate could never pass.

`--inconclusive fail` (the default) fails the command on an inconclusive preset; `--inconclusive warn`
reports it and exits 0.

## Configure a golden's presets

Under its `tests` entry in `shadowlap.config.json`, every key optional:

| Key | What it says |
|---|---|
| `presets` | Which presets `test --chaos` runs on it, such as `["timeout", "429"]`. Default all six; `--presets` overrides it |
| `expect` | What every attempt must pass besides exiting 0, in the grammar of `expect`. Default: the write limits of the golden's own `expect` |
| `tool` | The tool whose first call the tool presets hit |
| `gate` | `{ good, bad, risk, max }`, the sequential test above |
| `oversize` | How many characters an oversized answer grows to (default 1000000) |
| `timeout` | Seconds an attempt may run before it is stopped, and fails (default 300): an error path can hang |

`"chaos": false` leaves the golden out of `test --chaos`. Asked for by name, `replay --chaos` on one
of its runs still runs the presets, with the defaults.

## On any run

```sh
shadowlap replay <run> --chaos --expect '{"tools":{"issue_refund":"<= 1"}}'
```

runs the presets on a run of the store, judged by `--expect`, or, for a run of a golden, by that
golden's `chaos.expect` or write limits. It doesn't combine with the flags that change a replay,
such as `--override` or `--fail-at`: each preset is played in alone.

## In CI

Presets cost tokens, so they suit a nightly job better than every pull request:

```sh
shadowlap test goldens/* --chaos --junit chaos.xml --markdown "$GITHUB_STEP_SUMMARY"
```

`--junit` writes a case per preset, and `--markdown` a table of them, with any golden whose presets
couldn't run listed under it. Under a `chaos.gate`, the table states its rule once under the rows,
and each case the gate decided states it after its tally and Wilson bound. `--json` writes the
report, with each attempt's run ([its fields](./cli.md#error-path-presets)).

## What is kept

Each session and every preset's result are kept in the store, per golden: the call it hit, the
verdict, the attempts and their runs. Each attempt is a run of its own, bundled under the recording
it forked as blame's probes are, so Runs lists the recording and `shadowlap show` on an attempt
opens the error path the agent took.

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
