# Training

Blame, verify and `--repeat` already keep every attempt they run as a run in the store, and a golden
already says what a good run does. Read the right way, that is training data. Nothing is collected
for either, and nothing leaves the machine until you export it.

- **[Preference pairs](#preference-pairs):** an answer that lost a run next to one that went on to
  pass.
- **[Tasks](#tasks):** goldens a model under test takes over and is scored on by the golden's own
  checks.

```sh
shadowlap export pairs --out pairs.jsonl              # answers to prefer, for preference fine-tuning
shadowlap tasks                                       # the goldens as tasks
shadowlap tasks score --model my-finetune --base-url http://127.0.0.1:8000/v1
shadowlap tasks serve                                 # one scored attempt per HTTP request, for a training loop
```

This page covers:

- [Preference pairs](#preference-pairs), and [exporting them](#exporting-pairs)
- [Tasks](#tasks), [scoring a model](#scoring-a-model) on them, and [the models to score](#models-to-score)
- [The dashboard's Training page](#in-the-dashboard)
- [Scoring from a training loop](#from-a-training-loop)

## Preference pairs

A pair is two answers to the same conversation, at the same model call: one that lost the run, and
one that went on to pass. Pairs are read from attempts already in the store:

| Source | Pairs | Confidence |
|---|---|---|
| [`blame`](./blame.md) | At the blamed call, each passing attempt's answer against the recorded one | **high** |
| [`verify`](./verify.md) | Per verified run, a failing attempt against a passing one, at the first model call where their answers differ | **medium** |
| `replay --repeat` | The same, by exit status, when some attempts exited 0 and others didn't | **medium** |

- **High:** blame asked that call again and the run passed, so that answer decided it.
- **Medium:** the runs parted there, but nothing checked that this answer decided the run.
- **An attempt verify could not judge** (inconclusive) is neither passing nor failing, and pairs
  nothing.

### Which answers make a pair

- **Identical answers count once,** whichever source found them. A verify that replays a blamed run
  and finds the two answers blame already paired adds nothing, and the pair stays high.
- **Answers compare by their text and tool calls,** so tool-call ids, whitespace and thinking don't
  make two answers different.
- **Only answers to the same conversation pair.** Attempts whose conversations parted before their
  answers did, as when a live read returned something else, make none. Neither does an answer that
  also passed, from the same point, in another attempt.

### Sources

Every source is listed, including the ones that made no pairs and why: a blame that rescued nothing
has no answer to prefer, and a verify where every run passed every attempt, or none, has nothing to
contrast. Each source is named this way:

| Source                                                    | Named by             | As                            |
|-----------------------------------------------------------|----------------------|-------------------------------|
| A blame                                                   | Its run's label      | `blame · refund-bug`          |
| A verify                                                  | The code it verified | `verify · 370712a+dirty`      |
| A [repair](./repair.md)'s verify of one of its candidates | That candidate       | `verify · repair candidate 3` |

Two blames named alike are told apart by their run's id, two verifies by when they ran. The attempts
`tasks score` and `tasks serve` run are never read as a source, including one that stopped before it
was scored.

### A simulated user

When an agent talks to a simulated user that is itself a model, each side's model calls are made in a
[scope](./sdk.md#scopes) of their own (`agent` and `user`, say). Pairs are read from the agent's calls
only: the scope blame was limited to with `--scope`.

Two attempts whose simulated customer said something else first saw different conversations from then
on. So they make no pair there, rather than a pair of the customer's lines.

A run whose model calls are made in more than one scope, with no blame to say which is the agent's,
makes no verify or `--repeat` pairs, and its source says so: blame it with `--scope` once.

### Long runs

Reading pairs keys each stored message once. It compares two attempts of a long run (over 64 model
calls) by halving: a handful of calls rather than every one.

- **When halving holds.** It holds while each call carries on the conversation of the one before it,
  so it is checked on every call it reads, in both attempts.
- **When it doesn't.** When a call starts another conversation, as a sub-agent does or a context that
  was cut or rewritten, the attempts are compared call by call instead.
- **What it can't see.** A side conversation between the calls it read whose answer never comes back
  into the main one.
- **How long it takes.** On a run of 1,200 calls verified ten times, the first read takes about 0.3 to
  0.4 seconds.
- **Reading again.** What was found is kept until a run starts, ends or changes (a run still recording
  changes nothing), and what was keyed is kept for the store. So reading again after an attempt ends
  takes 50 to 100 ms.

### Exporting pairs

```sh
shadowlap export pairs --min-confidence medium --out pairs.jsonl
```

It prints:

```text
▸ reading blame, verify and --repeat attempts from the store: 1 source
    blame · refund-bug  1 pair, high
  1 pair at confidence high or medium · identical answers count once (1 high, 0 medium in all)
  each: the conversation as the model saw it at that call, and two answers to it
  openai-preference: { input: { messages, tools }, preferred_output, non_preferred_output }
  redaction: 1 rule applied to the copy (rules without a path to every string, path rules to the message fields kept); the store is unchanged
✓ wrote pairs.jsonl · 1 pair
```

The file has one JSON line per pair, holding:

- the conversation as the model saw it at that call, in the provider-neutral messages
  [`export dataset`](./cli.md#export-dataset) writes (system, user, assistant with its tool calls and
  their ids, tool results);
- the tools it was offered;
- the two answers.

A pair recorded against Anthropic and one recorded against OpenAI come out in the same shape.

| Flag | What it does |
|---|---|
| `--min-confidence high` (default) | Only pairs blame proved |
| `--min-confidence medium` | High and medium |
| `--format openai-preference` (default) | `{ input: { messages, tools }, preferred_output, non_preferred_output }`, OpenAI's preference fine-tuning format |
| `--format trl` | `{ prompt, chosen, rejected }` as chat messages, with `tools` when the conversation had them: TRL's conversational preference format |
| `--out <file>` | Write the file (its folder is made if needed); without it, the rows go to stdout and the report to stderr |
| `--no-redact` | Skip the redaction rules |

In the `trl` format, tool-call arguments are objects and tool results are named.

**Redaction.** The [redaction rules](./normalizers-and-redaction.md#redaction) in
`shadowlap.config.json` apply to the copy, as they do to `export dataset`. The store is never changed.

- **Rules without a path** apply to every string of every row, and to a tool call's arguments while
  they are still an object (its strings, not its numbers). So the JSON text an OpenAI row writes them
  as still parses.
- **Rules with a path** apply to the message fields kept:
  - a model-call rule's path, to the request before its messages are read;
  - a tool rule's `$.args…` path, to that tool's calls in the conversation and in both answers;
  - a `$.result…` path, to that tool's results that are JSON.

**What left the machine.** Each export is kept in the store: how many pairs, the file, the format and
confidence, when and by whom.

- **Writing to stdout** counts too.
- **Activity** logs it as `pairs.exported`, and a dashboard job that runs the export links to the
  file.
- **When no pair is at the confidence asked for,** nothing is written: a file already there keeps
  what an earlier export put in it, nothing is recorded as having left the machine, and the command
  says so.

## Tasks

A golden whose checks say what the agent must do, not only what it may spend, is a task. A model
under test takes over at one model call. Everything before it replays from the recording for free,
and the golden's checks score what the model did from there.

Each task has, next to its `expect` in `shadowlap.config.json`, the call where the model takes over,
why that call, and what the task rewards:

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

All the keys are optional:

| Key | What it says | Without it |
|---|---|---|
| `takeover` | The call where the model takes over | The call blame found, else the first model call after the last recorded user input, else the first model call |
| `why` | Why that call | — |
| `rewards` | What the task rewards | Its outcome checks |
| `scope` | The scope the agent's model calls are made in, when a simulated user's are made in another | The scope blame was limited to |

- **The call blame found** is the default when the golden came from a blamed run: the decision the run
  turned on. At the first model call, the model plays the whole run.
- **Only a call that asks a model for an answer can be a takeover:** a POST to messages, chat
  completions, completions, responses, generateContent, converse or invoke. A model list, an embedding
  or a token count is passed over, and a `takeover` set at one is refused, naming the call.
- **With a `scope`,** the default takeover is the agent's call, never the simulated user's, and a
  `takeover` set at the user's call is refused.

**A golden with a simulated user isn't scored.** From the takeover on, every model call would go to the
model under test, the simulated user's too, so the score wouldn't be the agent's. It is listed as not a
task, with that reason.

### List the tasks

```sh
shadowlap tasks
```

It prints:

```text
1 of 2 tasks ready · 1 not a task
  goldens/escalate-over-limit  ready
      takes over at #5 · decides between refunding and escalating · #1–#4 replay free
      rewards: escalate above the limit
      scored by: the agent exits 0; issue_refund called 0 times; escalate called 1 time
      after the takeover: escalate stubbed
  goldens/refund-flow-budget  not a task · its checks only cap tokens and cost

! One-sided: every ready task rewards "escalate above the limit", so a model that learned only that would score full marks.
```

Every pack under `goldens/` is listed, and every directory the `tests` entries name. `--json` prints
the tasks and the warning as JSON ([fields](#tasks-json)).

**One-sided** means every ready task rewards the same behaviour, so a model that does only that scores
full marks: a model trained to escalate every refund passes tasks that all reward escalating. The
warning names a task that rewards something else once it is ready.

### Task status

| Status | When |
|---|---|
| **ready** | The golden has checks on what the agent does, not only caps on tokens and cost, and its test passes |
| **blocked** | Its last test failed, was inconclusive or forked before the takeover; or it was packed straight from a capture |
| **not a task** | Its checks only cap tokens and cost, or it has no checks, or its model calls are made in more than one scope |
| **no golden** | A `tests` entry names a directory with no pack in it |

Checks that only cap tokens and cost say what a run spent, not whether the agent was right. With
those, or no checks, nothing would score a model, so it has no call to take over.

A blocked task, and what makes it ready again:

| The golden | Ready again once you |
|---|---|
| Failed its last [`shadowlap test`](./ci.md) | Fix the test |
| Was inconclusive in its last test | Settle it (the dashboard's Tests says how: more attempts, or the judge's verdict recorded) |
| Forked before the takeover in its last test | [Update the golden](./ci.md#update-a-golden-after-an-intended-change) |
| Was packed straight from a capture | Replay it once with your agent (`shadowlap replay <run> -- <command>`) and pack that run |

**A failed test.** The golden's last test is its newest result in the
[test history](./ci.md#test-history) `shadowlap test` keeps in the project's store (or the one `--db`
names). It is read by that result's verdict, as the dashboard's Tests reads it.

**An inconclusive test** neither passed nor failed, so its checks can't reward anything until it is
settled. The task's note says why:

- *its last test is inconclusive: its gate ran out of attempts*: a [gate](./gating.md) still between
  its bounds at its limit, however many of its attempts failed a check;
- *… a check could not be decided*: a check such as a [judge](./judges.md#not-judged) with no verdict;
- *… its injection test showed too little to say*.

**A test that forks before the takeover.** This applies to a golden whose test may fork (`fork` in
its tests entry), and reads *its test forks at #3, before the takeover: update the golden*. The test
passes, but an attempt would leave the recording before the model answers.
`shadowlap test <golden> --update` re-records it, and names the normalizer to add when the fork is a
value that changes every run.

**A golden packed straight from a capture** has no command to start its agent, so neither its test
nor a score can run.

### Tasks JSON

`tasks --json` prints `{ tasks, oneSided }`. Each task has:

| Field | Type | Meaning |
|---|---|---|
| `golden` | string | The golden, as the project names it (`goldens/escalate-over-limit`) |
| `name` | string | Its name (`escalate-over-limit`) |
| `status` | string | `ready`, `blocked`, `not-a-task` or `no-golden` |
| `note` | string or null | Why it isn't ready |
| `runId` | string or null | The run id of its recording |
| `takeover` | object or null | `callNo`, `why`, and `from`: `config`, `blame`, `input` for the model call after the last recorded input, or `first` |
| `scope` | string or null | The scope the model under test plays |
| `scopes` | array | The scopes the golden's model calls were made in |
| `rewards` | string or null | What it rewards |
| `checks` | array | Its checks |
| `after` | object | The tools that run after the takeover: `live`, `stubbed` |
| `prefix` | number | The calls replayed before the takeover |
| `model`, `provider` | string or null | The model and provider the recording asked at the takeover |
| `callName` | string or null | The endpoint the recording asked there |
| `tokensAfter` | object or null | The tokens it used from the takeover on |
| `fork` | object | Only for a task whose test forked before the takeover: the call it forked at, and that test's run |

`oneSided` is `null`, or:

| Field      | Type           | Meaning                                                 |
|------------|----------------|---------------------------------------------------------|
| `rewards`  | string         | What every ready task rewards                           |
| `tasks`    | array          | Those tasks                                             |
| `opposite` | object or null | The task that rewards something else, when there is one |

## Scoring a model

```sh
shadowlap tasks score --model my-finetune-step-200 --base-url http://127.0.0.1:8000/v1 --attempts 3
```

It prints:

```text
⑂ Scoring my-finetune-step-200 (on this machine) on 1 task · 3 attempts each
  each attempt replays the golden up to the takeover for free; from there my-finetune-step-200 answers · writes stubbed · reads live
▸ escalate-over-limit · #1–#4 replayed · my-finetune-step-200 from #5 · writes stubbed (decides between refunding and escalating)
   1 · ✓ the agent exits 0 · ✗ issue_refund called 0 times · ✗ escalate called 1 time · 0.33 01M4ZHR5D3
   2 · ✓ the agent exits 0 · ✗ issue_refund called 0 times · ✗ escalate called 1 time · 0.33 01M4ZHR5GM
   3 · ✓ the agent exits 0 · ✗ issue_refund called 0 times · ✗ escalate called 1 time · 0.33 01M4ZHR5KZ
  mean 0.33 over 3 attempts
✓ my-finetune-step-200 · mean 0.33 · 3 attempts on 1 task · $0, on this machine · every call before a takeover replayed
```

Each attempt runs the agent's real code against the golden:

- **Before the takeover,** the calls replay from the recording. So they cost nothing, and the model
  under test starts from exactly the conversation the recording had.
- **From the takeover on,** the model answers, every write is stubbed, and reads run live
  (`--reads replay` serves them from the recording when they match).

### How an attempt is scored

An attempt's score is the share of its checks it passed, the agent's exit status among them.

- **Token and cost budgets** are left out of the score: they cap what a run spends, and a model on your
  machine has no price to check.
- **A check that did not apply** (a [`when`](./checks.md#conditions) whose condition never held) is
  left out too: it neither passed nor failed.
- **A check that could not be decided** is no pass.

### Attempts in the store

Every attempt is a run in the store, a fork of the golden's run at the takeover, marked with the task,
the model and its score, so an odd score opens like any fork. Each call the model under test answered
records that model.

- **Cost.** An attempt's cost is priced as the model that answered each live call. A model on this
  machine answers for nothing, and the provider's own calls after the takeover (an embedding, say) are
  priced as they would be in any run.
- **Judge checks.** A [judge check](./judges.md) asks its judge, never the model scored. So what its
  calls cost is reported apart from the attempt's, as `test` and `verify` report it: on a line under
  the scores, and as `judge` in the JSON.
- **`--budget`** counts every attempt, one that stopped before it was scored included, and its judge
  checks' calls with it. Once it is spent, each task not reached by then starts no attempt and is
  reported as stopped by it.
- **Scores** are kept per model and endpoint. Scoring a model again replaces its scores on the tasks
  it scored, and says what it replaced.
- **A re-score that stops short** of its attempts (the budget ran out, Ctrl-C) leaves a whole earlier
  score in place and says so; with no earlier score, the attempts it has are kept.
- **Activity** logs each scoring as `model.scored`.

### Which tasks it scores

- **Goldens** are given as directories, folders of them (`.` is the whole project), or names; a name
  two goldens share is refused with both paths. Without any, every ready task is scored.
- **A task that isn't ready** is skipped with the reason.
- **A golden that doesn't replay up to its takeover** (the code changed and it forks earlier) stops
  its task with the divergence. So does a model that doesn't answer the takeover call, so that a score
  never grades an unreachable endpoint.
- **The first attempt of each task runs on its own,** so either stops the task after one attempt
  whatever `--concurrency` says. The attempt is kept as a run marked with why it stopped.
- **The exit status** is 0 when every task was scored in full.

Each attempt replays the recording and the command the golden's own pack holds, as `shadowlap test`
does. When the store holds another recording under its run id (a copy pulled from a pull request's
folder, a pack someone sent that reused the id):

- the pack's command runs if only the command differs;
- the task is skipped, naming where the store's copy came from, if the calls differ.

The store's copy's command never runs.

### Which model

| `--model` | Asks |
|---|---|
| `<name>` | The recording's own provider, for another model; the agent's own key goes with it |
| `anthropic:<name>` | Anthropic's API |
| `openai:<name>` | OpenAI's API, or wherever `SHADOWLAP_UPSTREAM_OPENAI` or `OPENAI_BASE_URL` points |
| `<name> --base-url <url>` | An OpenAI-compatible server: Ollama (`http://127.0.0.1:11434/v1`), vLLM, or the server of the model you're training |

- **`<name>`:** only the model the request names changes (its `model` field, or the model in a Gemini
  URL).
- **`anthropic:<name>`** on an Anthropic recording asks as `<name>` does; on an OpenAI recording, it
  translates, with `ANTHROPIC_API_KEY`.
- **`openai:<name>`** on an OpenAI recording asks as `<name>` does; on an Anthropic recording, it
  translates, with `OPENAI_API_KEY`.
- **`--key-env <name>`** names the variable holding the `--base-url` server's key, if it needs one.

Keys are read from the environment and never stored; a `--base-url` with a user or password in it is
refused. A model at a loopback address costs nothing. Any other is priced from the
[price table](./cli.md#the-configuration-file), and a model with no price is named rather than counted
as free.

### How the model takes over

For each task, Shadowlap puts a small upstream of its own where the recording's provider would be, on
127.0.0.1:

- **The first request to reach it** is the takeover call itself, whatever the agent asked before (a
  model list, an embedding, token counts), since every call before the takeover replays from the
  recording.
- **Every model call from there** goes to the model under test.
- **Anything else the agent sends that provider,** such as an embeddings call or a token count, goes
  to the provider unchanged, as it would without a takeover.
- **Each answer to a model call** says which model gave it (the `x-shadowlap-model` header), and the
  attempt's run records it. A score is kept only when the model under test answered the takeover call.

**The recording's own provider.** Only the model the request names changes: its `model` field for
Anthropic's messages and OpenAI's chat completions, completions and Responses API, the model in the
URL for Gemini. The request goes on with the agent's own key, and the answer comes back as the
provider gave it, streamed.

Another model of Amazon Bedrock, Vertex AI or Azure OpenAI themselves can't be asked:

- Bedrock signs the URL its model is in;
- Vertex AI is reached at the agent's own regional address;
- an Azure deployment picks its model.

`tasks score` refuses that before any attempt runs, rather than paying to score the recorded model. A
model of Anthropic's or OpenAI's API, or one at your own endpoint, scores those recordings instead,
translated as below.

The model the recording used is scored on it on every provider, a cloud's included
(`--model amazon.nova-pro-v1:0` on a Bedrock recording made with it). Nothing is switched, so the
request goes on as the agent made it, and that model's score is the one to beat.

**Another provider.** A recording holds each request in its provider's shape. The model under test
may speak another API, as when you score an Anthropic or Bedrock recording with a local
OpenAI-compatible model, or an Azure OpenAI recording with an Anthropic model. The upstream then
translates, so the agent never knows:

- it turns each model call into the model's API (chat completions for an OpenAI-compatible endpoint,
  the one API every such server speaks);
- it turns the answer back into the shape the agent's SDK parses, in the recording's own API.

A streaming agent gets the stream its client reads:

- Anthropic's or OpenAI's server-sent events (the Responses API's events end in `response.completed`);
- Bedrock's AWS event stream (`converse-stream`, `invoke-with-response-stream`);
- Gemini's server-sent events (`alt=sse`) or JSON array.

Claude on Vertex AI or Bedrock asked of Anthropic's API keeps its shape: only the model is named and
the cloud's `anthropic_version` field dropped. The upstream takes HTTP/1.1 and HTTP/2 alike, as an AWS
SDK that signs over HTTP/2 sends.

What the translation does:

- **Carried over:** the system prompt, every message, tool definitions, tool calls and their results
  (errors included), images, the tool choice, `max_tokens` (`maxTokens`, `maxOutputTokens`),
  temperature, `top_p` and stop sequences; on the way back, text, tool calls, the stop reason and
  usage. Gemini may give a function call no id: each gets one for the other API, and each response
  answers the next call of its name.
- **Dropped, and named after the task:** thinking blocks (Gemini's thought parts, Bedrock's reasoning
  blocks, the Responses API's reasoning items), which only the model that wrote them can read, and the
  thinking or reasoning setting with them.
- **Also dropped, and named after the task:** server-side tools such as web search, file search or Google Search, which have no
  definition to carry; and options one API has and the other lacks, such as `top_k`, Gemini's response
  schema, Bedrock's `additionalModelRequestFields` and guardrail.
- **Converted:** a JSON schema the Responses API asks for (`text.format`) carries over as chat's
  `response_format`.
- **Fixed on the way back:** a local reasoning model's `<think>…</think>` preamble is removed. An
  answer that calls a tool always stops with `tool_use` (or `tool_calls`), since a server that reports
  "stop" after a tool call would end the agent's loop. Gemini stops with `STOP` after a function call,
  as it does itself.

Which model can answer which recording:

| Recorded on | Another model of the same provider (`--model <name>`) | Anthropic's API (`anthropic:<name>`) | An OpenAI-compatible endpoint (`--base-url`, `openai:<name>`) |
|---|---|---|---|
| Anthropic API | Yes | Yes | Translated |
| OpenAI chat completions | Yes | Translated | Yes |
| OpenAI Responses API (OpenAI or Azure OpenAI) | Yes on OpenAI; no on Azure: the deployment picks the model | Translated | Translated into chat completions; `openai:<name>` on an OpenAI recording as it is |
| Gemini API | Yes | Translated | Translated |
| Azure OpenAI chat completions | No: the deployment picks the model | Translated | Yes |
| Vertex AI: Claude (`rawPredict`) | No: the agent's regional address | Yes, the same shape | Translated |
| Vertex AI: Gemini, or its OpenAI-compatible endpoint | No: the agent's regional address | Translated | Translated, or yes |
| Bedrock: Claude through InvokeModel | No: the signed URL | Yes, the same shape | Translated |
| Bedrock: the Converse API | No: the signed URL | Translated | Translated |
| Bedrock: another model through InvokeModel | No: the signed URL | No | No |

- ***Yes*** sends the request as it is, with only the model changed; ***translated*** turns it into
  the model's API and back.
- **The model a recording used** answers it on every row, as the agent asked it.
- **What isn't translated** (OpenAI's legacy completions, InvokeModel bodies other than Claude's,
  Vertex AI partner models other than Claude) can be scored only with another model of its own
  provider, where that provider can switch one.
- **A Responses API conversation kept on OpenAI's side** (`previous_response_id`) can't be carried:
  its earlier turns aren't in the request, and the task names that as dropped.
- **`tasks models`** and the dashboard say which ready tasks each listed model can answer.

### Flags

| Flag | What it does | Default |
|---|---|---|
| `--attempts <n>` | Attempts per task | 5 |
| `--reads live\|replay` | What read tools do after the takeover; with `live`, the services must be up | `live` |
| `--concurrency <n>` | Attempts of one task running at once | 1 |
| `--budget <usd>` | Start no attempt once this much is spent on live model calls, the judge checks' included | — |
| `--timeout <seconds>` | Stop an attempt after this long and count it as failed | — |
| `--guard warn\|block\|off` | The network guard for connections that bypass Shadowlap | — |
| `-y`, `--yes` | Run the recorded command of a golden from a pack the repository doesn't track without asking | — |
| `--json` | The scores as JSON on stdout; progress still goes to stderr | — |

With `--yes`, each attempt runs that command. Without it, such a golden, recorded elsewhere, asks
first, as [`test`](./cli.md#test) does, and without a terminal is skipped, saying why.

### Scores JSON

`--json` prints:

| Field           | Type           | Meaning                                             |
|-----------------|----------------|-----------------------------------------------------|
| `model`         | string         | The model scored                                    |
| `baseUrl`       | string or null | The endpoint it was asked at                        |
| `via`           | string         | Where it ran (`on this machine`)                    |
| `session`       | string         | This scoring's id                                   |
| `mean`          | number or null | The mean score over every attempt                   |
| `attempts`      | number         | How many attempts ran                               |
| `spent`         | number         | What the attempts' own calls cost, in USD           |
| `judge`         | object or null | What their judge checks' calls did and cost (below) |
| `unknownModels` | array          | Models with no price                                |
| `skipped`       | array          | Each task skipped, with its reason                  |
| `tasks`         | array          | Each task scored (below)                            |

Each of `tasks`:

| Field      | Type           | Meaning                                                                    |
|------------|----------------|----------------------------------------------------------------------------|
| `task`     | string         | The task's golden                                                          |
| `takeover` | number         | The call the model took over at                                            |
| `why`      | string         | Why that call                                                              |
| `replayed` | number         | The calls replayed before the takeover                                     |
| `mean`     | number or null | Its mean score                                                             |
| `spent`    | number         | What its attempts cost, a stopped one's included                           |
| `judge`    | object or null | What its judge checks' calls did and cost                                  |
| `stopped`  | string or null | Why it stopped short                                                       |
| `dropped`  | array          | What the translation left out                                              |
| `stored`   | string         | `new`, `replaced`, `kept-earlier` when the earlier score stands, or `none` |
| `attempts` | array          | Each attempt (below)                                                       |

Each of its `attempts`:

| Field      | Type           | Meaning                                   |
|------------|----------------|-------------------------------------------|
| `attempt`  | number         | The attempt's number                      |
| `run`      | string         | Its run                                   |
| `score`    | number         | Its score                                 |
| `checks`   | array          | Each check: `check`, `pass`, `detail`     |
| `spent`    | number         | What its own calls cost                   |
| `judge`    | object or null | What its judge checks' calls did and cost |
| `exitCode` | number         | The agent's exit code                     |

At each level, `spent` is what the attempts' own calls cost. `judge` is what their judge checks'
calls did and cost apart from `spent` (`calls`, `replayed` from the recording, `live`, `notAsked`,
`upstreamRequests`, `spent`, `saved` and `unknownModels`, as a run's summary has them), or `null`
without a judge call.

### What a score can't tell you

- **Reads run live.** After the takeover, read tools call the real services, so those must be up.
  `--reads replay` serves matching calls from the recording instead.
- **Writes are stubbed.** A task can't score what a write would have caused.
- **A model learns what the checks reward.** Weak checks teach the wrong thing. That's why a golden
  whose checks only cap tokens and cost isn't a task, and why a set of tasks that all reward one
  behaviour is flagged.
- **A golden with a simulated user isn't scored.** Its model calls are made in more than one scope,
  and the model under test would answer the simulated user's calls too.

## Models to score

```sh
shadowlap tasks models
```

It prints:

```text
Models to score on 1 ready task · an attempt uses about 3.1k input and 57 output tokens after its takeover
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

It lists:

- the models the ready tasks' recordings used;
- every model each configured provider lists: Anthropic's and OpenAI's `/v1/models`, with the keys
  already in the environment, and the models Ollama has installed on this machine, or at
  `OLLAMA_HOST`;
- the models and endpoints scored before, each with its last mean score.

How each is shown:

- **Some tasks, or none.** A model that can answer only some of the ready tasks says so
  (`on 1 of 2 tasks`), and one that can answer none says why
  (`can't answer the tasks (refund-flow: it uses the OpenAI Responses API, …)`).
- **Why, by its own provider.** The reason comes from a task recorded on its own provider when there
  is one: a Bedrock model's reason is Bedrock's, not that another task was recorded on Azure.
- **Price.** An attempt's price is the model's price times the tokens the recordings used after their
  takeovers, averaged over the tasks. A model on this machine costs $0.
- **Asking.** Each list is asked once, all at the same time. A provider that has no key, isn't running
  or doesn't answer within `--timeout` (1500 ms) becomes a note instead.
- **Ollama behind `OPENAI_BASE_URL`.** An OpenAI-compatible endpoint that is Ollama's own server
  (`OPENAI_BASE_URL` at Ollama's port) is asked once, as Ollama.
- **Keys.** Nothing is sent to Anthropic's or OpenAI's API without its key.

`--json` prints the choices, each with the flags `tasks score` takes to ask it and its `reach`: the
ready tasks it can answer (`tasks`), and each one it can't with why (`refused`).

### Models JSON

`tasks models --json` prints `{ choices, notes, tokens, tasks }`:

| Field | Type | Meaning |
|---|---|---|
| `choices` | array | Each model to score (below) |
| `notes` | array | Each provider that couldn't be listed, as a `note` under its `group` |
| `tokens` | object or null | The tokens an attempt is expected to use after its takeover, which prices are estimated from |
| `tasks` | number | The number of ready tasks |

`tokens` holds `inputTokens`, `outputTokens`, `cacheReadInputTokens` and `cacheCreationInputTokens`.
Each choice has:

| Field | Type | Meaning |
|---|---|---|
| `group` | string | The heading it is listed under (`Anthropic API`) |
| `id` | string | The model |
| `via` | string | How it was found |
| `where` | string | Where it runs |
| `baseUrl` | string or null | The endpoint it is asked at |
| `flags` | array | The flags `tasks score` takes to ask it |
| `perAttempt` | number or null | Its estimated USD per attempt |
| `local` | boolean | Whether it runs on this machine |
| `lastScore` | number or null | Its last score |
| `provider` | string | For a model asked of a recording's own provider (`--model <name>` alone): that provider, as the recordings name it (`anthropic`, `gemini`, …) |
| `reach` | object | The ready tasks it can answer (`tasks`), and each one it can't with why (`refused`) |

A task recorded on another provider than a choice's `provider` can't ask it.

## In the dashboard

The dashboard's **Training** page (`g` `a`) shows the same, on two tabs with the same strip above
them. The strip shows:

- how many pairs there are (high and medium);
- how many tasks are ready (and how many are blocked or not tasks);
- the best mean score and its model;
- how many pairs the last export wrote (*Exported*), its file and when.

### Pairs

**Pairs** groups the pairs per call. Each group shows:

- **the confidence,** and **the run and call** (opening the run there);
- **the fix the run belongs to,** opening the fix at its Blame step, or the verify it was; for a repair
  candidate the gate turned down, it opens the Repair step that lists it;
- **the conversation in one line:** what the user first asked, then the last thing the model saw (a
  tool's result read out field by field, `sent: true, to: …`, or what the user said last);
- **the answers:** the rejected answer beside the chosen ones, each linking to the attempt that gave
  it.

A verify or `--repeat` pair is shown at the run it replayed, at the call made at the same point of the
same path: the same user input, tool calls and results before it, whatever the prompt said. When that
run never got there (the change verified added a step before the call), the group is headed by the
attempt at its own call, *attempt of* the run it replayed. Every source is listed, the ones that made
none with why.

**Export pairs…** asks for the format (*OpenAI preference fine-tuning* or *prompt, chosen, rejected (TRL)*) and the confidence, and
shows the file it writes and the command. It then runs `export pairs` into
`.shadowlap/exports/pairs.jsonl` in the project folder. The job's drawer offers the file for download,
and Activity logs it.

### Tasks tab

**Tasks** lists one row per golden, ready ones first. A row shows where a model takes over and why,
what scores it, which tools run live or are stubbed after the takeover, and its status (a golden whose
checks only cap tokens and cost has no call to take over). It opens the golden's run at the takeover,
or Tests for a blocked one.

**Update golden.** A task blocked because its test forks before the takeover opens that test's run
at the call where it forked, and offers **Update golden**. A dialog shows what it runs, and the
job runs it:

- a `normalize add` for each value the fork shows that changes every run and the config doesn't mask,
  then `test <golden> --update`;
- or the normalizer and a test alone, when such values were all that changed.

It runs the agent, so it is off while a repair or an applied patch changes the working tree, and on a
read-only dashboard, with the reason on hover.

**The one-sided warning** shows here. When the task that rewards the opposite is blocked that way, the
warning offers the update instead of Tests.

**Scored models.** Each scored model has a card: where it ran, its mean, what it cost and, apart, what
its judge checks cost (*≈$0.120 spent · judge ≈$0.010*), and when.

- **Two endpoints.** A model scored at two endpoints has a card for each, named by its endpoint, as the
  strip names the best one. The strip counts such a model once.
- **Pips.** Each task has a pip per attempt (every check passed, some, or none) that opens the
  attempt's run.
- **Partial scores.** A model scored before a task became ready says *on 1 of 2 tasks* beside its
  mean.
- **The best mean score** is taken among the models scored on every ready task.

### Score a model

**Score model…** lists the models `tasks models` lists, with the keys and addresses in the
dashboard's environment, each with what an attempt costs and its last score:

- the model the recordings used;
- each provider's models;
- Ollama's installed models, when a server already answers (the dashboard never starts one);
- the models and endpoints scored before.

It offers only the models that can answer a ready task
([the table above](#how-the-model-takes-over)):

- **Some tasks.** One that answers only some is scored on those. Its note says which it leaves out and
  why, once per reason (*not azure, bedrock-claude: recorded on Azure OpenAI and Amazon Bedrock, not the
  Gemini API*).
- **None.** One that answers none is named under the picker as not offered, with the reason.
- **The first pick** is the first model not scored before that answers every ready task, else the
  first not scored before.
- **Your own endpoint…** takes a base URL and a model name.

It runs `tasks score` on every ready task it can answer with 5 or 10 attempts each, and shows that
command as you pick. The drawer says how it came out (*scored* with the mean, or how many tasks it
scored when one stopped) and links to the scores.

- **The list** is asked for when the Tasks tab opens and kept for 15 seconds. A provider that has no
  key or doesn't answer within 1.5 seconds is named under the picker instead, once, even when the
  OpenAI-compatible endpoint is Ollama's own server.
- **A read-only dashboard** asks no provider: it lists the recorded models and those scored before.
- **While the working tree changes.** Scoring runs the agent from the project's working tree. So while
  a repair or an applied patch is changing it, **Score model…** is off and says why on hover (the
  dialog says it too).

### Jobs

They run as dashboard jobs. The page names the kind and its fields, and the server builds the command:

| Job           | Fields                                                                                     |
|---------------|--------------------------------------------------------------------------------------------|
| `pairs`       | `format`, `minConfidence`                                                                  |
| `score`       | `model`, `baseUrl`, `attempts` of 5 or 10, and `goldens` (every ready task by default)     |
| `task-update` | `golden`, a task blocked by an early fork; the commands come from the store and the config |

A read-only dashboard shows the page and runs none of them. The palette offers Export pairs… and Score
model… from any page when there is something to export or score.

## From a training loop

`shadowlap tasks serve` answers one attempt per HTTP request, so a reinforcement-learning loop can use
a task's score as its reward. Serve the model you're training on an OpenAI-compatible endpoint, and
name it when the server starts or in each request.

```sh
shadowlap tasks serve --port 4779
shadowlap tasks serve --base-url https://gpu.example.com/v1 --key-env TRAINER_API_KEY
```

It prints:

```text
Serving 1 ready task on http://127.0.0.1:4779
  token: b1946ac92492d2347c6235b4d2611184e1f05a3c9d7b20f4
  POST http://127.0.0.1:4779/v1/tasks/<task>/attempts  {"model":"my-finetune","baseUrl":"http://127.0.0.1:8000/v1"}
  with Authorization: Bearer <token>; GET /v1/tasks lists them. Ctrl-C stops.
  escalate-over-limit: takes over at #5
```

One request and its response:

```http
POST /v1/tasks/escalate-over-limit/attempts HTTP/1.1
Host: 127.0.0.1:4779
Authorization: Bearer b1946ac92492d2347c6235b4d2611184e1f05a3c9d7b20f4
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

The task in the path is its golden's name or path (`escalate-over-limit`, or
`goldens%2Fescalate-over-limit`). `GET /v1/tasks` lists the tasks with their status, takeover, scope
and checks.

### The request

The body takes these fields, as `tasks score` does:

| Field     | Type   | Meaning                                            |
|-----------|--------|----------------------------------------------------|
| `model`   | string | Required: the model to ask                         |
| `baseUrl` | string | The endpoint to ask it at                          |
| `reads`   | string | `live` or `replay`                                 |
| `from`    | number | A model call to take over at instead of the task's |

- **No `baseUrl`.** A request that names no `baseUrl` (and no provider, as `anthropic:<model>` does)
  asks the endpoint `--base-url` gave when the server started.
- **Keys.** The key `--key-env <name>` names goes to that endpoint and nowhere else, so `--key-env`
  needs `--base-url`. A request can't name a key, and an endpoint a request names elsewhere is asked
  without one.

### The response

The response carries each check's result, the score, the attempt's run, what it cost in USD, the
agent's exit code and how long it took:

| Field | Meaning |
|---|---|
| `checks` | Each check's result |
| `score` | The score |
| `run` | The attempt's run |
| `spent` | What it cost, in USD |
| `exitCode` | The agent's exit code |
| `ms` | How long it took |
| `judge` | When a judge check was asked: what its calls did and cost, apart from the attempt's `spent`, as `tasks score` reports it |
| `dropped` | When a translation left something out |

Its statuses:

| Status | Meaning                                                                                              |
|-------:|------------------------------------------------------------------------------------------------------|
|    400 | The body isn't a JSON object with a model name, a field has the wrong type, or it names a `keyEnv`   |
|    400 | The task in the path isn't percent-encoded right                                                     |
|    401 | No token, or the wrong one                                                                           |
|    403 | The request wasn't addressed to `127.0.0.1:<port>` or `localhost:<port>`, or it came from a web page |
|    404 | No such task or route                                                                                |
|    409 | The task can't be scored (below)                                                                     |
|    413 | The body is over 64 KB                                                                               |
|    502 | The attempt didn't score: the golden didn't replay up to the takeover, or the model didn't answer    |

A 409 means one of these:

- the task isn't ready;
- its recording can't be sent to that model;
- `from` is a call that asks no model;
- its golden is from a pack the repository doesn't track that no one said yes to;
- two goldens share the name, and `ambiguous` lists their paths.

### Running the server

- **This machine only.** It listens on 127.0.0.1 only and checks the `Host` header, so a web page
  can't reach it by renaming itself. It refuses requests that carry an `Origin`.
- **The token** is `SHADOWLAP_TASKS_TOKEN` when that is set (at least 16 characters, since anyone on
  the machine can try a loopback port), else a fresh random one each start. Only `GET /v1/health`
  answers without it.
- **The port.** `--port` fails when the port is taken; without it, 4779 falls back to a free port.
- **Concurrency.** `--concurrency` (default 2) attempts run at once, and further requests wait their
  turn.
- **Other flags.** `--reads`, `--timeout` and `--guard` are as for `tasks score`, and golden
  directories after `serve` limit which tasks it serves.
- **A golden from a pack the repository doesn't track,** recorded elsewhere, is served only once you
  say yes to its command as the server starts, or with `--yes`. Without a terminal it isn't served, and
  the server says so as it starts.

Each attempt is a run in the store like any other, but a training loop's model changes with every
step, so its scores aren't kept as a model's scores.

## See also

- [Blame](./blame.md), [verify](./verify.md) and [repair](./repair.md): the attempts pairs are read
  from.
- [CI](./ci.md#test-history): the test history a task's status is read from.
- [Judges](./judges.md): judge checks, and what their calls cost.
- [`shadowlap tasks`](./cli.md#tasks): the commands' reference.
