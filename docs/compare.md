# Compared with other tools

Shadowlap is change safety for agents, by one mechanism: it replays an agent's *real code* against a recording of what the model and the tools said last time, and forks at the first call that changed. Several other tools touch the same problem from a different side. This page says where each one is the better choice.

| | Shadowlap | HTTP cassettes | Tracing platforms | Replay evals | Framework time travel | Durable execution |
|---|---|---|---|---|---|---|
| Examples | | VCR.py, nock, Polly.js, Betamax | LangSmith, Langfuse, Braintrust, Phoenix, Helicone | Kitaru | LangGraph checkpoints, agent framework "time travel" | Temporal, Restate, Inngest |
| Re-runs your code against recorded model output, zero tokens | **yes** | partly (breaks on the first changed byte) | no | no — tools replay, the model runs live | within the framework | within the runtime |
| Continues live from the first changed call (fork) | **yes** | no | no | no — every replay starts from the top | from a chosen checkpoint | no |
| Explains *why* it forked: structural diff, hints | **yes** | no | no | no | no | no |
| Side effects fenced after a fork | **yes** (`write` tools) | no | no | a policy per tool; live by default | no | activities re-run |
| Works with any framework, TypeScript and Python | **yes** | per language | per SDK | per framework adapter | one framework | one runtime |
| Streaming responses recorded byte for byte, with per-event timing for playback | **yes** | some | n/a | n/a | n/a | n/a |
| Shows what happened in production, at scale | no — it runs on your machine and in CI | no | **yes** | **yes** (sessions) | no | **yes** (history) |
| Injects a failure to exercise the error path | **yes** (`--fail-at`, no tokens spent) | no — it can only replay an error that was recorded | no | tool results only | no | no |
| Fails a build on a token or cost regression | **yes** (outcome checks) | no | alerts on spend, does not gate a build | a budget evaluator; failing the build on it takes a script | no | no |
| Evaluates output quality | no | no | **yes** | **yes** | no | no |

## HTTP record and replay libraries

VCR.py, nock, Polly.js and their relatives record HTTP calls and replay them by matching the URL, method and body. That model breaks on agents: every model call resends the whole conversation, so the request bodies grow with each turn, any change to a prompt or a tool result changes every later body, and the cassette matches nothing. Concurrent tool calls arrive in a different order on each run. Tool calls, clock reads and random ids never touch HTTP at all.

Shadowlap matches by a canonical fingerprint of what the model actually saw, counts occurrences so that order does not matter, replays the unchanged prefix, then keeps going live with a diff of the first change instead of failing. Tools are recorded through the SDK, with an effect, so a replay never re-sends an email.

What these captures are good for is *starting* a recording. `shadowlap import` reads a HAR (what
mitmproxy, Charles, Proxyman, devtools and Polly.js write), a nock recording, or a VCR cassette in
its JSON form, and turns it into a recording you can replay your own code against — so traffic
already captured in front of an agent need not be produced again. An existing cassette suite is
therefore a starting point, not something to throw away. See [`import`](./cli.md#import) for what a
capture of the network cannot carry.

Use a cassette library when the thing under test is a plain HTTP client with stable requests.

## Tracing and observability platforms

LangSmith, Langfuse, Braintrust, Arize Phoenix, Helicone and OpenTelemetry-based tools show you what a run did: spans, prompts, latencies, costs, feedback. They are the right place to *look at* production traffic and to evaluate output quality. What they cannot do is run your code again against that trace. Their "replay" or "playground" re-sends a recorded prompt to the model, which costs tokens and returns something new, and it exercises the prompt, not the harness around it.

Shadowlap is the debugger to their dashboard: a recording is a trace you can execute. The two compose; `shadowlap export otel` sends a run as an OpenTelemetry trace with the GenAI semantic conventions to any OTLP collector.

For production runs specifically, the two also compose on the way in: a gateway already in the request path can capture what the agent sent, and [`shadowlap import litellm`](./gateways.md) turns that into a recording. The prompts stay in your own infrastructure, which is the part a hosted platform cannot offer.

Use a tracing platform for production visibility and evals. Use Shadowlap when you need to reproduce and fix.

## Replay-based evals

Kitaru also re-runs an agent's real code against a recorded session, but it holds the other side of the conversation constant. Tool calls are answered from the recording and model calls run live, so a replay measures how a different model, prompt or version of the code behaves in the same world. Sessions are recorded through a wrapper around a supported framework, or imported from Langfuse, LangSmith, Braintrust and other tracing platforms; fixed cohorts of them are replayed as experiments and scored by evaluators, LLM judges and human labels. It runs as a server on Postgres, with workers in your environment.

That answers a question Shadowlap does not: across a few hundred production sessions, is the new model better? Every replay spends tokens by design, since the model's answer is what is being measured, and every replay starts from the top.

Shadowlap replays the model's recorded answers as well, so a fix to the harness reproduces the same run at no cost, and a change forks at the first request it affects, with a diff of that request. Kitaru matches tool calls only, by name and arguments. A tool answers from the recording when you give it a `history` policy; with none set, it runs live, which Kitaru's docs point out would repeat a refund. Shadowlap fences `write` tools after every fork.

Use Kitaru to compare models and prompts across many sessions with scored evals. Use Shadowlap to reproduce one run exactly, find the call that lost it, and gate a pull request offline.

## Framework checkpoints and time travel

LangGraph and some agent frameworks checkpoint their state graph and let you resume from an earlier node, optionally with edited state. That is genuinely useful inside the framework, and it is where the framework's own state is the thing you want to rewind. It requires building on that framework, it rewinds *state* rather than replaying model behavior (resuming re-calls the model live), and it says nothing about calls made outside the graph.

Shadowlap sits under any framework, at the HTTP layer and the tool boundary, in TypeScript or Python. It replays the model's recorded answers, so a fix to the harness reproduces the same run every time, and it reports the exact request that changed.

Use framework time travel to explore alternative paths interactively inside that framework. Use Shadowlap to reproduce a run of any agent, in a test, offline.

## Durable execution

Temporal, Restate and Inngest replay a workflow's history to recover its state; a model call is an activity whose result is persisted. The mechanism is close to Shadowlap's, but it exists to survive crashes, not to debug: replay happens inside the runtime, requires writing the agent as a workflow, does not diff or fork, and re-executes activities that are not in the history.

Use durable execution to make long-running agents survive restarts. Use Shadowlap to understand and test what they did.

## Where Shadowlap does not help

- **Prompt changes fork at call 1.** A different system prompt is a different first request; there is no recorded answer to a question the model never saw. You still get the diff and a fenced fork, and every later harness change replays for free. `--prompt-from <call>` applies the new prompt only from a later model call, which answers a narrower question ("what if the prompt had been this from step *k*") without re-running the steps before it.
- **Tools you did not wrap** are not recorded. The network guard reports them so they do not surprise you.
- **Quality of the model's output** is not something a replay can judge. Pair it with an eval tool.
- **Agents spread across services** are recorded only where `shadowlap run` started them. Processes the agent starts itself inherit the environment and record into the same run — set [`SHADOWLAP_SCOPE`](./sdk.md#scopes) on each so their calls stay apart on replay — but a separate service, or another machine, does not.
