# Compared with other tools

shadowlap is change safety for agents: it re-runs an agent's real code against a recording of what
its model and its tools answered. Calls that haven't changed are answered from the recording. The
first request that changed is reported with a diff, and the run forks there and continues live, with
write tools fenced.

[Blame](./blame.md), [repair](./repair.md) and [verify](./verify.md) build on those forks to find the
model call that lost a run and to prove a fix. Several other tools touch the same problem from a
different side. This page says what each one does and where it is the better choice.

What it says about other products was checked against their own documentation, repositories and
announcements on 2026-10-30.

## Which to use

Each kind of tool is the better choice for a different job:

| Kind of tool | Examples | Use it to |
|---|---|---|
| [Cassettes](#http-record-and-replay-libraries) | VCR.py, Polly.js, nock | Test a plain HTTP client with stable requests |
| [Tracing and evals](#tracing-and-eval-platforms) | LangSmith, Langfuse, Braintrust, Phoenix, Weave, Logfire, Helicone | See production, run evals across large datasets, and review by hand, with dashboards over time |
| [Replay evals](#replay-based-evals) | Kitaru | Compare models and prompts across many sessions with scored evals |
| [Agent debuggers](#agent-debuggers-with-cached-replay) | Laminar, OrcaReplay | Iterate on an agent Laminar already traces, or compare models from a checkpoint of a coding agent |
| [Time travel](#framework-checkpoints-and-time-travel) | LangGraph, Microsoft Agent Framework, Google ADK, Claude Agent SDK | Explore alternative paths inside that framework, or resume a long workflow |
| [Durable execution](#durable-execution) | Inngest, DBOS, Restate, Cloudflare Workflows, Temporal | Make long-running agents survive crashes, and resume or patch a failed run in production |
| shadowlap | — | Reproduce one run of any agent exactly, find the call that lost it, prove the fix, and gate a pull request offline |

## Side by side

Each row asks one question of every kind of tool. A cell answers yes, partly or no, then says how:

| | shadowlap | Cassettes | Tracing and evals | Replay evals | Agent debuggers | Time travel | Durable execution |
|---|---|---|---|---|---|---|---|
| Examples |  | VCR.py, Polly.js, nock | LangSmith, Langfuse, Braintrust, Phoenix, Weave, Logfire, Helicone | Kitaru | Laminar, OrcaReplay | LangGraph, Microsoft Agent Framework, Google ADK, Claude Agent SDK | Inngest, DBOS, Restate, Cloudflare Workflows, Temporal |
| Re-runs your code against the model's recorded answers | **yes** — every call before the first changed request, at zero tokens | partly — while requests match; VCR.py's default match ignores the body | partly — LangSmith's pytest cache and Braintrust's gateway can answer a request seen before; a playground or an experiment asks the model again | no — the agent's model calls run live, by design | partly — up to a call you choose; Laminar's cache key leaves out the system message | no — continuing from a checkpoint asks the model again | partly — a model call made as a step keeps its result before the restart point |
| Forks at the first changed request, with a diff | **yes** — a structural diff of that request, then live from there | no — a miss raises an error or goes live, by library | no — every call runs live | no — every replay starts from the top | partly — live from a call you choose, or from Laminar's first cache miss; OrcaReplay's `--loose` sends a request with no match live | no — from a checkpoint you choose | no — from a step you choose |
| Fences write tools after a fork | **yes** — blocked in `replay` and `test`, stubbed in `blame`, `verify` and `repair`, by default; `--writes` changes it | no — tools outside HTTP run every time | no — tools run unless your agent blocks them (LangSmith Engine's docs give `safe_tools` middleware) | partly — a policy per tool; with none set, tools run live | no — tool calls run again; OrcaReplay says replay is not a sandbox | no — tools run again after the checkpoint | no — every step after the restart point runs, writes included |
| Finds the model call that lost a run | **yes** — `blame` re-asks calls from forks and names the last one that can still save the run | no | partly — assistants read traces and propose a cause: LangSmith's Polly and Engine, Braintrust's Loop, Phoenix's PXI | partly — a failure matrix shows where failed sessions first go wrong, at an error or at a step a reviewer marks | partly — Laminar's Signals read traces for failures you describe; OrcaReplay draws the chain that produced a failure | no | no |
| Proves a fix holds | **yes** — `verify` replays failing, held-out and good runs, each at a stated error rate; `repair` proposes fixes | no | partly — LangSmith Engine replays up to 5 traces live against its pull request (private beta, LangSmith Cloud) | partly — an experiment scores your change across a cohort, with the model live | partly — a rerun of your change, graded by an eval (Laminar) or a command (OrcaReplay) | no | no |
| Gates a pull request offline, with no model key | **yes** — goldens, replayed by `shadowlap test` and the GitHub Action | yes — tests replay what the cassette recorded | partly — LangSmith's pytest cache replays requests it has seen; other evals in CI call the model | no — the model runs live; `--wait` fails only on a failed run | partly — OrcaReplay replays offline and reports in JSON, for a script you write | no | no |
| Judges output quality | partly — judge checks, recorded so a clean replay is judged free; not evals at scale | no | **yes** — LLM judges, scorers and human review over datasets | **yes** — evaluators, LLM judges and human labels | partly — evals (Laminar), a command you name (OrcaReplay) | no | no |
| Shows production traffic at scale | no — it runs on your machine and in CI; production runs come in as imports | no | **yes** | **yes** — sessions recorded in production or imported | partly — Laminar traces production; OrcaReplay records the runs it launches, and an OrcaRouter gateway the runs it routes | no | **yes** — workflow history |
| Works with any framework, TypeScript and Python | **yes** — model calls at the HTTP layer; tools through SDKs for TypeScript and Python, MCP, declared HTTP hosts or the wire protocol | partly — one language each | **yes** — through each platform's SDK, OpenTelemetry or a gateway | partly — adapters for six frameworks, in Python and TypeScript, or imported traces | partly — Laminar caches four Python integrations and the AI SDK; OrcaReplay, any agent its proxy reaches | no — that framework only | no — the agent written as a workflow for that runtime |

## HTTP record and replay libraries

VCR.py, Polly.js and nock record HTTP exchanges and replay them in tests. Which requests count as the
same depends on the library:

| Library  | Matches by default on                            | On a miss, by default                                     |
|----------|--------------------------------------------------|-----------------------------------------------------------|
| VCR.py   | The method and the URL                           | Raises an error                                           |
| Polly.js | The method, URL, headers, body and request order | Sends the request live and records it                     |
| nock     | A recorded body, exactly                         | Throws an error; other hosts are reached live, unrecorded |

So with VCR.py, a call to a model endpoint matches a recorded call to that endpoint, whatever its
prompt says, and gets that call's answer.

Exact matching breaks on agents in another way. Every model call resends the whole conversation, so a
change to a prompt or a tool result changes that request and every later one, and the cassette
matches none of them. Parallel requests arrive in a different order on each run.

Tool calls that don't go over HTTP, clock reads and random ids are not in a cassette at all.

LangSmith's pytest plugin has a cache of this kind. With `LANGSMITH_TEST_CACHE` set, it keeps HTTP
requests on disk and replays one whose method, URL and body match one it kept; any other is sent live
and kept as well. Its Vitest and Jest integrations have none.

shadowlap instead:

- matches by a canonical fingerprint of what the model actually saw;
- counts occurrences, so that order does not matter;
- replays the unchanged prefix, then keeps going live with a diff of the first change instead of
  failing;
- records tools through the SDK, with an effect, so a replay re-sends no email unless you pass
  `--writes allow`.

What these captures are good for is *starting* a recording. `shadowlap import` reads a HAR (what
mitmproxy, Charles, Proxyman, devtools and Polly.js write), a nock recording, or a VCR cassette in its
JSON form. It turns it into a recording you can replay your own code against, so traffic already
captured in front of an agent need not be produced again.

An existing cassette suite is therefore a starting point, not something to throw away. See
[`import`](./cli.md#import) for what a capture of the network cannot carry.

Use a cassette library when the thing under test is a plain HTTP client with stable requests. Use
shadowlap when it is an agent, whose requests grow with every turn and whose tools act outside HTTP.

## Tracing and eval platforms

LangSmith, Langfuse, Braintrust, Arize Phoenix, W&B Weave, Pydantic Logfire and Helicone show what
runs did in production: spans, prompts, latencies, costs, feedback. Helicone does it as a gateway in
the request path by default, or off that path through an async integration.

Most of them also run evals, with LLM judges, code scorers and human review over datasets, and run
them in CI. Langfuse's GitHub Action fails a pull request when a score breaks your threshold, and
Braintrust's posts the results on it.

Several have changed hands:

- Langfuse joined ClickHouse in January 2026;
- Weights & Biases (Weave) joined CoreWeave in May 2025, and CoreWeave's docs call CoreWeave Agent
  Lens the successor to Weave;
- Dynatrace completed its purchase of Arize (Phoenix) on 2026-10-01.

Langfuse (MIT, but for its `ee` folders) and Phoenix (Elastic License 2.0) can still be self-hosted
from their public code.

None of them runs your code against a trace's recorded answers. Braintrust's gateway can answer a
request it has seen in the last week, by default only one sent at temperature 0 or with a seed.

A playground sends one recorded call to the model again (Langfuse's Add to Playground, Phoenix's span
replay, Weave's Open chat in Playground), and an experiment runs your code over a dataset's inputs,
live. Either way the model answers again: that costs tokens, the answer can differ, and a playground
exercises one prompt, not the code around it.

shadowlap is the debugger to their dashboard: a recording is a trace you can execute. The two
compose:

- **Traces in.** `shadowlap import` turns a Langfuse, LangSmith, Phoenix or Logfire trace, or
  OpenTelemetry spans, into a recording to replay your code against ([traces](./cli.md#traces)). A
  gateway already in the request path can capture production runs for
  [`shadowlap import litellm`](./gateways.md), and [`shadowlap coverage`](./coverage.md) shows what
  that traffic does that no golden covers.
- **Runs out.** [`shadowlap export otel`](./cli.md#export-otel) sends a run to any OTLP collector as
  spans with the GenAI semantic conventions (models, tokens and cost, no prompt text), and
  [`shadowlap export dataset`](./cli.md#export-dataset) writes recordings as eval datasets, in
  Braintrust's or Langfuse's shape among others.
- **Quality in CI.** A [judge check](./judges.md) asks a model a yes-or-no question about a run inside
  `shadowlap test`. Its call is recorded, so a golden is judged once when it is packed, and every clean
  replay after that is judged from the recording, free.

Use a tracing platform for production visibility, evals across large datasets, human review and
dashboards over time. Use shadowlap to reproduce one run exactly, find the call that lost it, and
prove the fix.

### LangSmith Engine

LangSmith Engine scans a tracing project for recurring issues, and diagnoses each one against the
traces and your connected source code. With a repository connected, it proposes a fix as a pull
request: a prompt change, or a code change for an agent built with Deep Agents, LangChain or LangGraph.

Its fix validation, in private beta, checks a fix by running the agent. It replays the inputs of up to
five of the issue's traces against a baseline deployment, then against a preview deployment built from
the pull request, and judges whether each replay shows the issue again. The fix comes out Verified, Not
fixed (Engine revises it, for up to three attempts in all) or Inconclusive.

Fix validation is available only on LangSmith Cloud, for agents that run on LangSmith Cloud
deployments.

Those replays are live: the model answers again, and the agent can call its tools. Engine marks each
replay in the run's config so the agent can hold back, and its docs give middleware that runs only the
tools listed in `safe_tools`. An agent without such a guard runs every tool it calls.

`repair` and `verify` answer the same question for any agent, on your machine or in CI. A replay
serves the recorded answers up to the first request the fix changes, and after it no write tool runs:
verify stubs each one by default, or blocks it.

Verify also runs the fix on held-out failing runs and on runs that passed, not only on the runs it was
written for. It decides each at a stated error rate:

- a failing run by a [gate](./gating.md);
- a run that passed against its own baseline, the same run under the code before the fix.

Repair rewrites the system prompt, a tool description or the model's name; a fix in code is yours or a
coding agent's to write, and verify checks it.

Use LangSmith Engine when your agent is traced to LangSmith and you want issues found in production
traffic and fixes opened as pull requests; for Engine to check a fix, the agent must run on LangSmith
Cloud deployments. Use shadowlap to check a fix for an agent that runs anywhere else, when no write may
run again, or when a fix has to hold on runs it wasn't written for and on runs that already worked.

## Replay-based evals

Kitaru, from ZenML, also re-runs an agent's real code against a recorded session, but it holds the
other side of the conversation constant. The agent's model calls run live, so a replay measures how a
different model, prompt or version of the code behaves in the same world.

Tool calls are answered by a policy set per tool:

| Policy        | Answers a tool call with                                |
|---------------|---------------------------------------------------------|
| `history`     | The recorded result, matched by tool name and arguments |
| `static`      | A result you define                                     |
| `llm`         | A model's answer                                        |
| `passthrough` | The real tool, run                                      |

`passthrough` is the server's default when no policy is set, and Kitaru's docs warn that a replay can
then repeat a side effect. Every replay starts from the top; a fork is a replay with one override,
such as the model, the system prompt or the sampling parameters.

- **Recording.** Sessions are recorded through adapters for PydanticAI, LangGraph, the OpenAI Agents
  SDK, the Claude Agent SDK, Mastra and the Vercel AI SDK, with SDKs for Python and TypeScript. Or
  they are imported from Langfuse, LangSmith, Braintrust, Logfire, Phoenix and MLflow.
- **Scoring.** Fixed cohorts of sessions are replayed as experiments and scored by evaluators,
  built-in deterministic ones or LLM judges. Human labels, written on sessions, calibrate them.
- **Review.** A coding assistant drafts investigations of sessions, which you answer. A failure matrix
  places each failed session at its first failing step: where it raised an error, or a step a reviewer
  marks.
- **Running.** It runs as a server on Postgres, with workers in your environment, and a hosted plan
  exists.
- **In CI.** `kitaru experiment run start --wait` exits nonzero when the run fails, which a failed
  replay causes. A drop in scores against the baseline fails nothing until a check you write compares
  them.

That answers a question shadowlap does not: across a few hundred production sessions, is the other
model or prompt better? Every replay spends tokens by design, since the model's answer is what is
being measured.

shadowlap replays the model's recorded answers as well, so a fix to the harness reproduces the same
run at no cost, and a change forks at the first request it affects, with a diff of that request. Each
wrapped tool declares its effect once, and write tools are blocked or stubbed after every fork. A
golden's test in CI runs offline.

Use Kitaru to compare models and prompts across many sessions with scored evals. Use shadowlap to
reproduce one run exactly, find the call that lost it, and gate a pull request offline.

## Agent debuggers with cached replay

Laminar and OrcaReplay re-run an agent against the model's recorded answers, so the part of a run
before a change costs nothing, and can continue live from a point you choose.

**Laminar** is an open-source tracing platform, hosted or self-hosted, whose debugger is built for a
coding agent to drive. A debug run (`LMNR_DEBUG`) replays when it names a recorded trace
(`LMNR_DEBUG_REPLAY_TRACE_ID`) and the last model call to serve from it (`LMNR_DEBUG_CACHE_UNTIL`). It
gets its model responses from the trace through that call, or up to the first cache miss, and runs
live after it.

The cache is served from Laminar's backend, keyed by the trace and a hash of the call's input messages
without the system message. An edited system prompt therefore still replays the cached calls, which
were answered under the old prompt. Caching works with the OpenAI, Anthropic, Google GenAI and LiteLLM
integrations in Python and the AI SDK in TypeScript; with any other integration, every call runs live.
Only model responses are cached, so tool calls run again.

**OrcaReplay** is a local command-line tool aimed at coding agents such as Claude Code and Codex CLI,
and it records agent frameworks too. A local proxy, set through base-URL variables (or TLS
interception for a harness that can't be pointed elsewhere), records the run.

- `orca replay` reproduces it byte for byte with no model called. A request close to a recorded one,
  or ending in the same message, gets that one's answer, reported as a divergence; one with no match
  stops the replay, or with `--loose` goes live.
- `orca replay last --from 4 --model <model>` keeps the turns up to checkpoint 4 and lets another model
  take over.
- `orca compare` does that for several models, graded by a command you name.

It snapshots the workspace each turn. A replay still runs the recorded tool calls for real: its README
says replay is not a sandbox.

shadowlap matches every request in full, the system prompt included, and forks at the first request
your change affects; `--diverge-at` forces a call live, and `--prompt-from` applies a changed prompt
from a later call when that is the question. Tools go through the SDK with a declared effect, so a
replay serves their recorded results and a fork blocks or stubs writes. Blame, repair, verify and
offline CI goldens sit on top.

Use Laminar to iterate quickly on an agent it already traces, with a coding agent driving the loop.
Use OrcaReplay to record a coding agent you can't change and to compare models from a checkpoint,
inside a sandbox. Use shadowlap when a replay must not repeat a side effect, and when the change itself
should decide where the run forks.

## Framework checkpoints and time travel

Several agent frameworks can take a run back to an earlier point:

- **LangGraph** replays a graph from a checkpoint, or forks it with edited state (`update_state`).
  Nodes before the checkpoint don't run again; nodes after it do, model calls and API requests
  included.
- **Microsoft Agent Framework** checkpoints a workflow at the end of each superstep, and resumes from
  any checkpoint, on the same run or another.
- **Google ADK** rewinds a session to before a given request (`rewind_async`) and restores the
  session's state and artifacts. App and user state, and anything a tool changed outside, stay as they
  are.
- **Claude Agent SDK** forks a session's conversation, from an earlier message if you name one
  (`forkSession` with `upToMessageId`). With file checkpointing, `rewindFiles()` restores the files its
  Write, Edit and NotebookEdit tools changed; a file only a Bash command changed is not restored.

That is useful inside the framework, where its own state is what you want to rewind. It needs the agent
built on that framework, and continuing from the earlier point asks the model again: nothing serves the
recorded answers to your code, and nothing compares the requests sent with the recorded ones.

shadowlap sits under any framework, at the HTTP layer and the tool boundary, in TypeScript or Python.
It replays the model's recorded answers, so a fix to the harness reproduces the same run every time,
and it reports the exact request that changed.

Use framework time travel to explore alternative paths interactively inside that framework, or to
resume a long workflow. Use shadowlap to reproduce a run of any agent, in a test, offline.

## Durable execution

Durable execution runtimes record each step's result so that a workflow survives a crash. Each of these
can also run a workflow again from a step you choose, reusing the recorded results of the steps before
it:

- **Inngest** reruns a function from a step, in its dashboard, its CLI (`--from-step`) or its API,
  optionally with other input for that step.
- **DBOS** forks a workflow from a step (`fork_workflow`), optionally on another application version.
- **Restate** restarts an invocation afresh from a journal entry (`restart-as-new` with `from`),
  optionally on another deployment.
- **Cloudflare Workflows** restarts an instance from a named step (`restart()`).
- **Temporal** resets a workflow to a point in its event history (`temporal workflow reset`).

The mechanism is close to shadowlap's, and a model call can be one of those steps; Inngest's `step.ai`
makes it one, and with `step.ai.wrap` you can edit its prompt and rerun from that step. Still, you pick
the step to restart from, nothing compares the request with the recorded one, and every step after the
restart point runs live, writes included. The agent has to be written as a workflow for that runtime.

Use durable execution to make long-running agents survive crashes, and to resume or patch a failed run
in production. Use shadowlap to find what changed in a run, and to test a change before it ships.

## Where shadowlap does not help

### Prompt changes fork at call 1

A different system prompt is a different first request; there is no recorded answer to a question the
model never saw. You still get the diff and a fenced fork, and every later harness change replays for
free.

- `--prompt-from <call>` applies the edited prompt only from a later model call. It answers a narrower
  question ("what if the prompt had been this from step *k*") without re-running the steps before it.
- [`shadowlap decisions --from-code`](./decisions.md) asks each recorded model call again under the
  edited prompt, with no tool run.

### Tools you did not wrap

Tools you did not wrap are not recorded, and a replay runs them again for real. shadowlap
[names each one the model called](./how-it-works.md#tools-shadowlap-did-not-record), read from the
model's own answers, at the end of `run` and `replay`.

Every command that replays a run refuses to run one that writes, or one whose name says nothing of
what it does, until you wrap it, declare it a read or pass `--allow-unrecorded`. One that writes is a
built-in such as `Bash`, a name such as `send_email` or `get_or_create_user`, or one the config
declares a write.

A write the code makes without the model asking for it, through a database client say, goes unnamed.
The [network guard](./how-it-works.md#the-network-guard) reports the connections it opens through the
runtime, but not those a C driver opens.

### Fixes in code

`repair` rewrites the system prompt, a tool description or the model's name. A bug in the harness
needs a code change, by you or a coding agent; `verify` checks it, for free when it changes no request.

### Evals at scale and production monitoring

A judge check answers one yes-or-no question about a run. Scoring thousands of production examples,
queues for human review and dashboards over time are what an eval platform is for. shadowlap runs on
your machine and in CI, and production runs reach it as imports.

### Agents spread across services

Agents spread across services are recorded only where `shadowlap run` started them. Processes the
agent starts itself inherit the environment and record into the same run (set
[`SHADOWLAP_SCOPE`](./sdk.md#scopes) on each so their calls stay apart on replay), but
a separate service, or another machine, does not. What a separate service answers the agent can be recorded, though: declare its host, and the agent's calls to it are recorded as tools, so its answers replay without it ([agents across services](./downstream-services.md)).

## See also

- [How it works](./how-it-works.md): the mechanism behind every row above.
- [Blame](./blame.md), [repair](./repair.md) and [verify](./verify.md): find the call that lost a run,
  and prove a fix.
- [Importing traces](./cli.md#traces): bring a trace from a tracing platform in as a recording.
