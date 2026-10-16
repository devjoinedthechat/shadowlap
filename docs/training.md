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

Every source is listed, including the ones that made no pairs and why: a blame that rescued nothing has no answer to prefer, and a verify where every run passed every attempt, or none, has nothing to contrast. A blame is named by its run's label (`blame · refund-bug`), a verify by the code it verified (`verify · 370712a+dirty`), and a [repair](./repair.md)'s verify of one of its candidates by that candidate (`verify · repair candidate 3`); two named alike are told apart by when they ran. The attempts `tasks score` and `tasks serve` run are never read as a source, including one that stopped before it was scored.

**A simulated user.** When an agent talks to a simulated user that is itself a model, each side's model calls are made in a [scope](./sdk.md#scopes) of their own (`agent` and `user`, say), and pairs are read from the agent's calls only: the scope blame was limited to with `--scope`. Two attempts whose simulated customer said something else first saw different conversations from then on, so they make no pair there, rather than a pair of the customer's lines. A run whose model calls are made in more than one scope, with no blame to say which is the agent's, makes no verify or `--repeat` pairs, and its source says so: blame it with `--scope` once.

Reading pairs keys each stored message once, and compares two attempts of a long run (over 64 model calls) by halving: a handful of calls rather than every one. Halving holds while each call carries on the conversation of the one before it, so it is checked on every call it reads, in both attempts; when a call starts another conversation, as a sub-agent does or a context that was cut or rewritten, the attempts are compared call by call instead. What halving can't see is a side conversation between the calls it read whose answer never comes back into the main one. On a run of 1,200 calls verified ten times, the first read takes about 0.3 to 0.4 seconds. What was found is kept until a run starts, ends or changes (a run still recording changes nothing), and what was keyed is kept for the store, so reading again after an attempt ends takes 50 to 100 ms.

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

**What left the machine.** Each export is kept in the store: how many pairs, the file, the format and confidence, when and by whom. Writing to stdout counts too. It is logged in Activity as `pairs.exported`, and a dashboard job that runs the export links to the file. When no pair is at the confidence asked for, nothing is written: a file already there keeps what an earlier export put in it, nothing is recorded as having left the machine, and the command says so.

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

All three are optional. Without `takeover`, a task takes over at the call blame found when the golden came from a blamed run (the decision the run turned on), else at the first model call after the last recorded user input, else at the first model call, where the model plays the whole run. Without `rewards`, a task rewards its outcome checks. Only a call that asks a model for an answer can be a takeover (a POST to messages, chat completions, completions, responses, generateContent, converse or invoke): a model list, an embedding or a token count is passed over, and a `takeover` set at one is refused, naming the call.

A fourth key, `scope`, names the scope the agent's model calls are made in when a simulated user's are made in another; it defaults to the scope blame was limited to. The default takeover is then the agent's call, never the simulated user's, and a `takeover` set at the user's call is refused. Such a golden can't be scored yet, though: from the takeover on, every model call goes to the model under test, the simulated user's too, so the score wouldn't be the agent's. It is listed as not a task, with that reason, until scoring can keep the model under test to one scope.

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
| **blocked** | The golden's last [`shadowlap test`](./ci.md) failed (as `shadowlap test --db` keeps it in the store). Fix the test and the task is ready again. Also a golden whose test may fork (`fork` in its tests entry) when its last test forked before the takeover (*its test forks at #3, before the takeover: update the golden*): the test passes, but an attempt would leave the recording before the model answers. [Update the golden](./ci.md#update-a-golden-after-an-intended-change) (`shadowlap test <golden> --update` re-records it, and names the normalizer to add when the fork is a value that changes every run) and the task is ready again; `tasks --json` gives such a task a `fork`, the call its test forked at and that test's run. Also a golden packed straight from a capture: it has no command to start its agent, so neither its test nor a score can run. Replay it once with your agent (`shadowlap replay <run> -- <command>`) and pack that run |
| **not a task** | Its checks only cap tokens and cost, which say what a run spent, not whether the agent was right; or it has no checks; or its model calls are made in more than one scope |
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

Every attempt is a run in the store, a fork of the golden's run at the takeover, marked with the task, the model and its score, so an odd score opens like any fork; each call the model under test answered records that model. An attempt's cost is priced as the model that answered each live call: a model on this machine answers for nothing, and the provider's own calls after the takeover (an embedding, say) are priced as they would be in any run. `--budget` counts every attempt, one that stopped before it was scored included. Scores are kept per model and endpoint; scoring a model again replaces its scores on the tasks it scored, and says what it replaced. A re-score that stops short of its attempts (the budget ran out, Ctrl-C) leaves a whole earlier score in place and says so; with no earlier score, the attempts it has are kept. Each scoring is logged in Activity as `model.scored`.

Goldens are given as directories, folders of them (`.` is the whole project), or names; a name two goldens share is refused with both paths. Without any, every ready task is scored. A task that isn't ready is skipped with the reason. A golden that doesn't replay up to its takeover (the code changed and it forks earlier) stops its task with the divergence, and so does a model that doesn't answer the takeover call, so that a score never grades an unreachable endpoint. The first attempt of each task runs on its own, so either stops the task after one attempt whatever `--concurrency` says; the attempt is kept as a run marked with why it stopped. The exit status is 0 when every task was scored in full.

### Which model

| `--model` | Asks |
|---|---|
| `<name>` | The recording's own provider for another model: only the model the request names changes (its `model` field, or the model in a Gemini URL), and the agent's own key goes with it |
| `anthropic:<name>` | Anthropic's API: on an Anthropic recording, as `<name>` does; on an OpenAI recording, translated, with `ANTHROPIC_API_KEY` |
| `openai:<name>` | OpenAI's API (or wherever `SHADOWLAP_UPSTREAM_OPENAI` or `OPENAI_BASE_URL` points): on an OpenAI recording, as `<name>` does; on an Anthropic recording, translated, with `OPENAI_API_KEY` |
| `<name> --base-url <url>` | An OpenAI-compatible server: Ollama (`http://127.0.0.1:11434/v1`), vLLM, or the server of the model you're training. `--key-env <name>` names the variable holding its key, if it needs one |

Keys are read from the environment and never stored; a `--base-url` with a user or password in it is refused. A model at a loopback address costs nothing; any other is priced from the [price table](./cli.md#the-configuration-file), and a model with no price is named rather than counted as free.

### How the model takes over

For each task, Shadowlap puts a small upstream of its own where the recording's provider would be, on 127.0.0.1. Every call before the takeover replays from the recording, so the first request that reaches it is the takeover call itself, whatever the agent asked before (a model list, an embedding, token counts), and every model call from there goes to the model under test. Anything else the agent sends that provider, such as an embeddings call or a token count, goes to the provider unchanged, as it would without a takeover. Each answer to a model call says which model gave it (the `x-shadowlap-model` header), the attempt's run records it, and a score is kept only when the model under test answered the takeover call.

**The recording's own provider.** Only the model the request names changes: its `model` field for Anthropic's messages and OpenAI's chat completions, completions and Responses API, the model in the URL for Gemini. The request goes on with the agent's own key, and the answer comes back as the provider gave it, streamed. Another model of Amazon Bedrock, Vertex AI or Azure OpenAI themselves can't be asked: Bedrock signs the URL its model is in, Vertex AI is reached at the agent's own regional address, and an Azure deployment picks its model. `tasks score` refuses that before any attempt runs, rather than paying to score the recorded model; a model of Anthropic's or OpenAI's API, or one at your own endpoint, scores those recordings instead, translated as below.

**Another provider.** A recording holds each request in its provider's shape. When the model under test speaks another API, scoring an Anthropic or Bedrock recording with a local OpenAI-compatible model, or an Azure OpenAI recording with an Anthropic model, the upstream translates: it turns each model call into the model's API (chat completions for an OpenAI-compatible endpoint, the one API every such server speaks) and the answer back into the shape the agent's SDK parses, in the recording's own API, so the agent never knows. A streaming agent gets the stream its client reads: Anthropic's or OpenAI's server-sent events (the Responses API's events end in `response.completed`), Bedrock's AWS event stream (`converse-stream`, `invoke-with-response-stream`), or Gemini's server-sent events (`alt=sse`) or JSON array. Claude on Vertex AI or Bedrock asked of Anthropic's API keeps its shape: only the model is named and the cloud's `anthropic_version` field dropped. The upstream takes HTTP/1.1 and HTTP/2 alike, as an AWS SDK that signs over HTTP/2 sends.

- **Carried over:** the system prompt, every message, tool definitions, tool calls and their results (errors included), images, the tool choice, `max_tokens` (`maxTokens`, `maxOutputTokens`), temperature, `top_p` and stop sequences; on the way back, text, tool calls, the stop reason and usage. Gemini may give a function call no id: each gets one for the other API, and each response answers the next call of its name.
- **Dropped, and named after the task:** thinking blocks (Gemini's thought parts, Bedrock's reasoning blocks, the Responses API's reasoning items), which only the model that wrote them can read, and the thinking or reasoning setting with them; server-side tools such as web search, file search or Google Search, which have no definition to carry; and options one API has and the other lacks, such as `top_k`, Gemini's response schema, Bedrock's `additionalModelRequestFields` and guardrail. A JSON schema the Responses API asks for (`text.format`) carries over as chat's `response_format`.
- **Fixed on the way back:** a local reasoning model's `<think>…</think>` preamble is removed, and an answer that calls a tool always stops with `tool_use` (or `tool_calls`), since a server that reports "stop" after a tool call would end the agent's loop. Gemini stops with `STOP` after a function call, as it does itself.

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

*Yes* sends the request as it is, with only the model changed; *translated* turns it into the model's API and back. What isn't translated (OpenAI's legacy completions, InvokeModel bodies other than Claude's, Vertex AI partner models other than Claude) can be scored only with another model of its own provider, where that provider can switch one. A Responses API conversation kept on OpenAI's side (`previous_response_id`) can't be carried: its earlier turns aren't in the request, and the task names that as dropped. `tasks models` and the dashboard say which ready tasks each listed model can answer.

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

`--json` prints `model`, `baseUrl`, `via`, `session`, `mean`, `attempts`, `spent`, `unknownModels` (models with no price), `skipped` (each with its reason) and `tasks`, each with `task`, `takeover`, `why`, `replayed` (calls replayed before the takeover), `mean`, `spent` (what its attempts cost, a stopped one's included), `stopped`, `dropped` (what the translation left out), `stored` (`new`, `replaced`, `kept-earlier` when the earlier score stands, or `none`) and its `attempts`: `attempt`, `run`, `score`, `checks` (`check`, `pass`, `detail`), `spent` and `exitCode`.

### What a score can't tell you

- **Reads run live.** After the takeover, read tools call the real services, so those must be up. `--reads replay` serves matching calls from the recording instead.
- **Writes are stubbed.** A task can't score what a write would have caused.
- **A model learns what the checks reward.** Weak checks teach the wrong thing. That's why a golden whose checks only cap tokens and cost isn't a task, and why a set of tasks that all reward one behaviour is flagged.
- **A simulated user isn't scored around yet.** A golden whose model calls are made in more than one scope can't be scored: the model under test would answer the simulated user's calls too.

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

The models the ready tasks' recordings used, every model each configured provider lists (Anthropic's and OpenAI's `/v1/models`, with the keys already in the environment, and the models Ollama has installed on this machine, or at `OLLAMA_HOST`), and the models and endpoints scored before, each with its last mean score. A model that can answer only some of the ready tasks says so (`on 1 of 2 tasks`), and one that can answer none says why (`can't answer the tasks (refund-flow: it uses the OpenAI Responses API, …)`), from a task recorded on its own provider when there is one: a Bedrock model's reason is Bedrock's, not that another task was recorded on Azure. An attempt's price is the model's price times the tokens the recordings used after their takeovers, averaged over the tasks; a model on this machine costs $0. Each list is asked once, all at the same time, and a provider that has no key, isn't running or doesn't answer within `--timeout` (1500 ms) becomes a note instead. Nothing is sent to Anthropic's or OpenAI's API without its key. `--json` prints the choices, each with the flags `tasks score` takes to ask it and its `reach`: the ready tasks it can answer (`tasks`), and each one it can't with why (`refused`).

## In the dashboard

The dashboard's **Training** page (`g` `a`) shows the same, on two tabs with the same strip above them: how many pairs there are (high and medium), how many tasks are ready (and how many are blocked or not tasks), the best mean score and its model, and how many pairs left the machine with the last export, its file and when.

- **Pairs** groups the pairs per call: the confidence, the run and call (opening the run there), the fix the run belongs to (opening the fix at its Blame step, or the verify it was, or for a repair candidate the gate turned down, the Repair step that lists it), and the conversation in one line, with the rejected answer beside the chosen ones, each linking to the attempt that gave it. A verify or `--repeat` pair is shown at the run it replayed, at the call made at the same point of the same path: the same user input, tool calls and results before it, whatever the prompt said. When that run never got there (the change verified added a step before the call), the group is headed by the attempt at its own call, *attempt of* the run it replayed. Every source is listed, the ones that made none with why. **Export pairs** asks for the format and the confidence, then runs `export pairs` into `.shadowlap/exports/pairs.jsonl` in the project folder; the job's drawer offers the file for download, and Activity logs it.
- **Tasks** lists one row per golden, ready ones first: where a model takes over and why, what scores it, which tools run live or are stubbed after the takeover, and its status (a golden whose checks only cap tokens and cost has no call to take over). A row opens the golden's run at the takeover, or Tests for a blocked one. A task blocked because its test forks before the takeover opens that test's run at the call where it forked, and offers **Update the golden…**: a dialog shows what it runs (a `normalize add` for each value the fork shows that changes every run and the config doesn't mask yet, then `test <golden> --update`; or the normalizer and a test alone, when such values were all that changed), and the job runs it. It runs the agent, so it is off while a repair or an applied patch changes the working tree, and on a read-only dashboard, with the reason on hover. The one-sided warning shows here; when the task that rewards the opposite is blocked that way, the warning offers the update instead of Tests. Each scored model has a card (where it ran, its mean, what it cost, when; a model scored at two endpoints has a card for each, named by its endpoint, as the strip names the best one), and each task a pip per attempt (every check passed, some, or none) that opens the attempt's run. A model scored before a task became ready says *on 1 of 2 tasks* beside its mean, and the best mean score is taken among the models scored on every ready task. The strip counts a model scored at two endpoints once.
- **Score a model** lists the models `tasks models` lists, with the keys and addresses in the dashboard's environment: the model the recordings used, each provider's models, Ollama's installed models when a server already answers (the dashboard never starts one), and the models and endpoints scored before, each with what an attempt costs and its last score. It offers only the models that can answer a ready task (the table above): one that answers only some is scored on those, and its note says which it leaves out and why, once per reason (*not azure, bedrock-claude: recorded on Azure OpenAI and Amazon Bedrock, not the Gemini API*); one that answers none is named under the picker as not offered, with the reason. The first model not scored yet that answers every ready task is picked, else the first not scored yet; **Your own endpoint…** takes a base URL and a model name. It runs `tasks score` on every ready task it can answer with 5 or 10 attempts each; the drawer says how it came out (*scored* with the mean, or how many tasks it scored when one stopped) and links to the scores. The list is asked for when the Tasks tab opens and kept for 15 seconds; a provider that has no key or doesn't answer within 1.5 seconds is named under the picker instead. A read-only dashboard asks no provider: it lists the recorded models and those scored before. Scoring runs the agent from the project's working tree, so while a repair or an applied patch is changing it, **Score a model** is off and says why on hover (the dialog says it too).

They run as dashboard jobs, `pairs` (`format`, `minConfidence`), `score` (`model`, `baseUrl`, `attempts` of 5 or 10, and `goldens`, every ready task by default) and `task-update` (`golden`, a task blocked by an early fork; the commands come from the store and the config): the page names the kind and those fields, and the server builds the command. A read-only dashboard shows the page and runs none of them. The palette offers Export pairs and Score a model from any page when there is something to export or score.

## From a training loop

`shadowlap tasks serve` answers one attempt per HTTP request, so a reinforcement-learning loop can use a task's score as its reward. Serve the model you're training on an OpenAI-compatible endpoint, and name it when the server starts or in each request.

```sh
shadowlap tasks serve --port 4779
shadowlap tasks serve --base-url https://gpu.example.com/v1 --key-env TRAINER_API_KEY
```

```
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

The task is its golden's name or path (`escalate-over-limit`, or `goldens%2Fescalate-over-limit`). The body takes `model` (required) and, as `tasks score` does, `baseUrl`, `reads` (`live` or `replay`) and `from`, a model call to take over at instead of the task's. A request that names no `baseUrl` (and no provider, as `anthropic:<model>` does) asks the endpoint `--base-url` gave when the server started. The key `--key-env <name>` names goes to that endpoint and nowhere else, so `--key-env` needs `--base-url`; a request can't name a key, and an endpoint a request names elsewhere is asked without one. The response carries each check's result, the score, the attempt's run, what it cost in USD, the agent's exit code and how long it took, and `dropped` when a translation left something out. `GET /v1/tasks` lists the tasks with their status, takeover, scope and checks.

| Status | Means |
|---|---|
| 400 | The body isn't a JSON object with a model name, a field has the wrong type, it names a `keyEnv`, or the task in the path isn't percent-encoded right |
| 401 | No token, or the wrong one |
| 403 | The request wasn't addressed to `127.0.0.1:<port>` or `localhost:<port>`, or it came from a web page |
| 404 | No such task or route |
| 409 | The task can't be scored: it isn't ready, its recording can't be sent to that model, or `from` is a call that asks no model; or two goldens share the name, and `ambiguous` lists their paths |
| 413 | The body is over 64 KB |
| 502 | The attempt didn't score: the golden didn't replay up to the takeover, or the model didn't answer |

It listens on 127.0.0.1 only and checks the `Host` header, so a web page can't reach it by renaming itself, and it refuses requests that carry an `Origin`. The token is `SHADOWLAP_TASKS_TOKEN` when that is set (at least 16 characters, since anyone on the machine can try a loopback port), else a new random one each start; only `GET /v1/health` answers without it. `--port` fails when the port is taken; without it, 4779 falls back to a free port. `--concurrency` (default 2) attempts run at once and further requests wait their turn; `--reads`, `--timeout` and `--guard` are as for `tasks score`, and golden directories after `serve` limit which tasks it serves.

Each attempt is a run in the store like any other, but a training loop's model changes with every step, so its scores aren't kept as a model's scores.
