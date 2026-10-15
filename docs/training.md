# Training

Blame, verify and `--repeat` already keep every attempt they run as a run in the store, and a golden already says what a good run does. Read the right way, that is training data: **preference pairs**, an answer that lost a run next to one that went on to pass, and **tasks**, goldens a model under test takes over and is scored on by the golden's own checks. Nothing is collected for either, and nothing leaves the machine until you export it.

```sh
shadowlap export pairs --out pairs.jsonl              # answers to prefer, for preference fine-tuning
shadowlap tasks                                       # the goldens as tasks
shadowlap tasks score --model my-finetune --base-url http://127.0.0.1:8000/v1
shadowlap tasks serve                                 # one scored attempt per HTTP request, for a training loop
```

## Preference pairs

A pair is two answers to the same conversation, at the same model call: one that lost the run, and one that went on to pass. Pairs are read from attempts already in the store:

| Source | Pairs | Confidence |
|---|---|---|
| [`blame`](./blame.md) | At the blamed call, each passing attempt's answer against the recorded one | **high**: blame asked that call again and the run passed, so that answer decided it |
| [`verify`](./verify.md) | Per verified run, a failing attempt against a passing one, at the first model call where their answers differ | **medium**: the runs parted there, but nothing checked that this answer decided the run |
| `replay --repeat` | The same, by exit status, when some attempts exited 0 and others didn't | **medium** |

Identical answers count once, whichever source found them: a verify that replays a blamed run and finds the two answers blame already paired adds nothing, and the pair stays high. Answers compare by their text and tool calls, so tool-call ids, whitespace and thinking don't make two answers different. Two answers only make a pair when they answer the same conversation: attempts whose conversations parted before their answers did, as when a live read returned something else, make none, and neither does an answer that also passed, from the same point, in another attempt.

Every source is listed, including the ones that made no pairs and why: a blame that rescued nothing has no answer to prefer, and a verify where every run passed every attempt, or none, has nothing to contrast.

### Exporting pairs

```sh
shadowlap export pairs --min-confidence medium --out pairs.jsonl
```

```
▸ reading blame, verify and --repeat attempts from the store: 1 source
    blame · refund-bug  1 pair, high
  1 pair at confidence high or medium · identical answers count once (1 high, 0 medium in all)
  each: the conversation as the model saw it at that call, and two answers to it
  openai-preference: { input: { messages, tools }, preferred_output, non_preferred_output }
  redaction: 1 rule applied to the copy (rules without a path to every string, path rules to the message fields kept); the store is unchanged
✓ wrote pairs.jsonl · 1 pair
```

One JSON line per pair: the conversation as the model saw it at that call, in the provider-neutral messages [`export dataset`](./cli.md#export-dataset) writes (system, user, assistant with its tool calls and their ids, tool results), the tools it was offered, and the two answers. A pair recorded against Anthropic and one recorded against OpenAI come out in the same shape.

| Option | Effect |
|---|---|
| `--min-confidence high` (default) | Only pairs blame proved |
| `--min-confidence medium` | High and medium |
| `--format openai-preference` (default) | `{ input: { messages, tools }, preferred_output, non_preferred_output }`, OpenAI's preference fine-tuning format |
| `--format trl` | `{ prompt, chosen, rejected }` as chat messages, with `tools` when the conversation had them: TRL's conversational preference format, tool-call arguments as objects and tool results named |
| `--out <file>` | Write the file (its folder is made if needed); without it, the rows go to stdout and the report to stderr |
| `--no-redact` | Skip the redaction rules |

**Redaction.** The [redaction rules](./normalizers-and-redaction.md#redaction) in `shadowlap.config.json` apply to the copy, as they do to `export dataset`. Rules without a path apply to every string of every row. Rules with a path apply to the message fields kept: a model-call rule's path to the request before its messages are read, a tool rule's `$.args…` path to that tool's calls in the conversation and in both answers, and a `$.result…` path to that tool's results that are JSON. The store is never changed.

**What left the machine.** Each export is kept in the store: how many pairs, the file, the format and confidence, when and by whom. Writing to stdout counts too. It is logged in Activity as `pairs.exported`, and a dashboard job that runs the export links to the file.

## Tasks

A golden with outcome checks is a task. A model under test takes over at one model call; everything before it replays from the recording for free, and the golden's checks score what the model did from there. Each task has, next to its `expect` in `shadowlap.config.json`, the call where the model takes over, why that call, and what the task rewards:

```json
{
  "tests": {
    "goldens/escalate-over-limit": {
      "expect": { "tools": { "issue_refund": 0, "escalate": 1 } },
      "task": { "takeover": 5, "why": "decides between refunding and escalating", "rewards": "escalate above the limit" }
    }
  }
}
```

All three are optional. Without `takeover`, a task takes over at the call blame found when the golden came from a blamed run (the decision the run turned on), else at the first model call after the last recorded user input, else at the first model call, where the model plays the whole run. Without `rewards`, a task rewards its outcome checks.

```sh
shadowlap tasks
```

```
1 of 2 tasks ready · 1 not a task
  goldens/escalate-over-limit  ready
      takes over at #5 · decides between refunding and escalating · #1–#4 replay free
      rewards: escalate above the limit
      scored by: the agent exits 0; issue_refund called 0 times; escalate called 1 time
      after the takeover: escalate stubbed
  goldens/refund-flow-budget  not a task · its checks only cap tokens and cost
      takes over at #1 · the first model call: the model plays the whole run · nothing replays first
      after the takeover: lookup_order live, escalate stubbed

! One-sided: every ready task rewards "escalate above the limit", so a model that learned only that would score full marks.
```

| Status | When |
|---|---|
| **ready** | The golden has outcome checks and its test passes |
| **blocked** | The golden's last [`shadowlap test`](./ci.md) failed. Fix the test and the task is ready again |
| **not a task** | Its checks only cap tokens and cost, which say what a run spent, not whether the agent was right; or it has no checks |
| **no golden** | A `tests` entry names a directory with no pack in it |

Every pack under `goldens/` is listed, and every directory the `tests` entries name. **One-sided** means every ready task rewards the same behaviour, so a model that does only that scores full marks: a model trained to escalate every refund passes tasks that all reward escalating. The warning names a task that rewards something else once it is ready. `--json` prints the tasks and the warning as JSON.

## Scoring a model

```sh
shadowlap tasks score --model my-finetune-step-200 --base-url http://127.0.0.1:8000/v1 --attempts 3
```

```
⑂ Scoring my-finetune-step-200 (on this machine) on 1 task · 3 attempts each
  each attempt replays the golden up to the takeover for free; from there my-finetune-step-200 answers · writes stubbed · reads live
▸ escalate-over-limit · #1–#4 replayed · my-finetune-step-200 from #5 · writes stubbed (decides between refunding and escalating)
   1 · ✓ the agent exits 0 · ✗ issue_refund called 0 times · ✗ escalate called 1 time · 0.33 01M4ZHR5D3
   2 · ✓ the agent exits 0 · ✗ issue_refund called 0 times · ✗ escalate called 1 time · 0.33 01M4ZHR5GM
   3 · ✓ the agent exits 0 · ✗ issue_refund called 0 times · ✗ escalate called 1 time · 0.33 01M4ZHR5KZ
  mean 0.33 over 3 attempts
✓ my-finetune-step-200 · mean 0.33 · 3 attempts on 1 task · $0, on this machine · every call before a takeover replayed
```

Each attempt runs the agent's real code against the golden: the calls before the takeover replay from the recording, so they cost nothing and the model under test starts from exactly the conversation the recording had; from the takeover on, the model answers, every write is stubbed, and reads run live (`--reads replay` serves them from the recording when they match). An attempt's score is the share of its checks it passed, the agent's exit status among them. Token and cost budgets are left out of the score: they cap what a run spends, and a model on your machine has no price to check.

Every attempt is a run in the store, a fork of the golden's run at the takeover, marked with the task, the model and its score, so an odd score opens like any fork. Scores are kept per model and endpoint; scoring a model again replaces its scores on the tasks it scored. Each scoring is logged in Activity as `model.scored`.

Goldens are given as directories or folders of them; without any, every ready task is scored. A task that isn't ready is skipped with the reason. A golden that doesn't replay up to its takeover (the code changed and it forks earlier) stops its task with the divergence, and so does a model that doesn't answer the takeover call, so that a score never grades an unreachable endpoint. The exit status is 0 when every task was scored in full.

### Which model

| `--model` | Asks |
|---|---|
| `<name>` | The recording's own provider for another model: only the request's `model` field changes |
| `anthropic:<name>` | Anthropic's API, with `ANTHROPIC_API_KEY` |
| `openai:<name>` | OpenAI's API (or wherever `SHADOWLAP_UPSTREAM_OPENAI` or `OPENAI_BASE_URL` points), with `OPENAI_API_KEY` |
| `<name> --base-url <url>` | An OpenAI-compatible server: Ollama (`http://127.0.0.1:11434/v1`), vLLM, or the server of the model you're training. `--key-env <name>` names the variable holding its key, if it needs one |

Keys are read from the environment and never stored. A model at a loopback address costs nothing; any other is priced from the [price table](./cli.md#the-configuration-file), and a model with no price is named rather than counted as free.

### Another provider at the takeover

A recording holds each request in its provider's shape. When the model under test speaks another API, scoring an Anthropic recording with a local OpenAI-compatible model, or an OpenAI recording with an Anthropic model, Shadowlap puts a translator where the provider would be, on 127.0.0.1. From the takeover on, it turns each request into the model's API and the answer back into the shape the agent's SDK parses, so the agent never knows.

- **Carried over:** the system prompt, every message, tool definitions, tool calls and their results (errors included), images, the tool choice, `max_tokens`, temperature, `top_p` and stop sequences; on the way back, text, tool calls, the stop reason and usage. A streaming agent gets its answer as the stream its SDK reads.
- **Dropped, and named after the task:** thinking blocks, which only the model that wrote them can read; server-side tools such as web search, which have no definition to carry; and sampling options one API has and the other lacks, such as `top_k`.
- **Fixed on the way back:** a local reasoning model's `<think>…</think>` preamble is removed, and an answer that calls a tool always stops with `tool_use` (or `tool_calls`), since a server that reports "stop" after a tool call would end the agent's loop.

Anthropic Messages and OpenAI Chat Completions recordings translate. Others can be scored only with their own provider. A Gemini, Bedrock, Vertex or Azure request names its model in the URL, and an OpenAI Responses request has no messages, so `--model` doesn't change them yet: `tasks score` stops and says so rather than scoring the recorded model.

### Options

| Option | Effect |
|---|---|
| `--attempts <n>` | Attempts per task. Default 5 |
| `--reads live\|replay` | What read tools do after the takeover. Default `live`: the services must be up |
| `--concurrency <n>` | Attempts of one task running at once. Default 1 |
| `--budget <usd>` | Start no attempt once this much is spent on live model calls |
| `--timeout <seconds>` | Stop an attempt after this long and count it as failed |
| `--guard warn\|block\|off` | The network guard for connections that bypass Shadowlap |
| `--json` | The scores as JSON on stdout; progress still goes to stderr |

`--json` prints `model`, `baseUrl`, `via`, `session`, `mean`, `attempts`, `spent`, `unknownModels` (models with no price), `skipped` (each with its reason) and `tasks`, each with `task`, `takeover`, `why`, `replayed` (calls replayed before the takeover), `mean`, `spent`, `stopped`, `dropped` (what the translation left out) and its `attempts`: `attempt`, `run`, `score`, `checks` (`check`, `pass`, `detail`), `spent` and `exitCode`.

### What a score can't tell you

- **Reads run live.** After the takeover, read tools call the real services, so those must be up. `--reads replay` serves matching calls from the recording instead.
- **Writes are stubbed.** A task can't score what a write would have caused.
- **A model learns what the checks reward.** Weak checks teach the wrong thing. That's why a golden whose checks only cap tokens and cost isn't a task, and why a set of tasks that all reward one behaviour is flagged.

## Models to score

```sh
shadowlap tasks models
```

```
Models to score on 1 ready task · an attempt uses about 3k input and 57 output tokens after its takeover
Recorded with
  claude-sonnet-5  ≈$0.0064 an attempt · scored 1.00
Anthropic API
  claude-haiku-4-5  ≈$0.0032 an attempt
Ollama, on this machine
  qwen2.5:7b  $0, not a paid API
Endpoints scored before
  my-finetune-step-200  $0, not a paid API · scored 0.33
  my-finetune-step-800  $0, not a paid API · scored 1.00
OpenAI API: OPENAI_API_KEY is not set
Your own endpoint: shadowlap tasks score --model <name> --base-url <url>
```

The models the ready tasks' recordings used, every model each configured provider lists (Anthropic's and OpenAI's `/v1/models`, with the keys already in the environment, and the models Ollama has installed on this machine, or at `OLLAMA_HOST`), and the models and endpoints scored before, each with its last mean score. An attempt's price is the model's price times the tokens the recordings used after their takeovers, averaged over the tasks; a model on this machine costs $0. Each list is asked once, all at the same time, and a provider that has no key, isn't running or doesn't answer within `--timeout` (1500 ms) becomes a note instead. Nothing is sent to Anthropic's or OpenAI's API without its key. `--json` prints the choices, each with the flags `tasks score` takes to ask it.

## From a training loop

`shadowlap tasks serve` answers one attempt per HTTP request, so a reinforcement-learning loop can use a task's score as its reward. Serve the model you're training on an OpenAI-compatible endpoint, and name it in each request.

```sh
shadowlap tasks serve --port 4779
```

```
Serving 1 ready task on http://127.0.0.1:4779
  token: b1946ac92492d2347c6235b4d2611184
  POST http://127.0.0.1:4779/v1/tasks/<task>/attempts  {"model":"my-finetune","baseUrl":"http://127.0.0.1:8000/v1"}
  with Authorization: Bearer <token>; GET /v1/tasks lists them. Ctrl-C stops.
  escalate-over-limit: takes over at #5
```

One request and its response:

```http
POST /v1/tasks/escalate-over-limit/attempts HTTP/1.1
Host: 127.0.0.1:4779
Authorization: Bearer b1946ac92492d2347c6235b4d2611184
Content-Type: application/json

{"model":"my-finetune-step-800","baseUrl":"http://127.0.0.1:8000/v1"}
```

```json
{
  "task": "escalate-over-limit",
  "model": "my-finetune-step-800",
  "takeover": 5,
  "score": 1,
  "checks": [
    { "check": "the agent exits 0", "pass": true, "detail": null },
    { "check": "issue_refund called 0 times", "pass": true, "detail": null },
    { "check": "escalate called 1 time", "pass": true, "detail": null }
  ],
  "run": "01M4ZHR6EC4THWW32YRNV4ZATN",
  "spent": 0,
  "exitCode": 0,
  "ms": 126
}
```

The task is its golden's name or path (`escalate-over-limit`, or `goldens%2Fescalate-over-limit`). The body takes `model` (required) and, as `tasks score` does, `baseUrl`, `reads` (`live` or `replay`) and `from`, a model call to take over at instead of the task's. An endpoint that needs a key gets it from the variable `tasks serve --key-env <name>` names when it starts; a request can't name one, since it could send any key in the environment to any address. The response carries each check's result, the score, the attempt's run, what it cost in USD, the agent's exit code and how long it took, and `dropped` when a translation left something out. `GET /v1/tasks` lists the tasks with their status, takeover and checks.

| Status | Means |
|---|---|
| 400 | The body isn't a JSON object with a model name, a field has the wrong type, or it names a `keyEnv` |
| 401 | No token, or the wrong one |
| 403 | The request wasn't addressed to `127.0.0.1:<port>` or `localhost:<port>`, or it came from a web page |
| 404 | No such task or route |
| 409 | The task can't be scored: it isn't ready, or its recording can't be translated for that model |
| 413 | The body is over 64 KB |
| 502 | The attempt didn't score: the golden didn't replay up to the takeover, or the model didn't answer |

It listens on 127.0.0.1 only and checks the `Host` header, so a web page can't reach it by renaming itself, and it refuses requests that carry an `Origin`. The token is `SHADOWLAP_TASKS_TOKEN` when that is set, else a new random one each start; only `GET /v1/health` answers without it. `--port` fails when the port is taken; without it, 4779 falls back to a free port. `--concurrency` (default 2) attempts run at once and further requests wait their turn; `--reads`, `--timeout` and `--guard` are as for `tasks score`, and golden directories after `serve` limit which tasks it serves.

Each attempt is a run in the store like any other, but a training loop's model changes with every step, so its scores aren't kept as a model's scores.
