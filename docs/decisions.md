# Decisions

A prompt edit or a model switch changes every request, so a replay forks at the first model call and checking the change costs a live run of every golden. `shadowlap decisions` answers the question in front of it first: what does the change *decide* differently, on your real runs? It asks each recorded model call again with only the change swapped in, compares the new answer's decision with the recorded one, and ranks what changed by what it does, writes first. No tool runs, so nothing reaches the world.

```sh
shadowlap decisions goldens/* --model claude-haiku-4-5
```

```
✗ 1 of 1 run decides a write or when to stop differently, under the model claude-haiku-4-5
  11 steps asked: 1 rank 1, 1 rank 3, 1 rank 4, 8 the same · no tool ran

goldens/research 01M58W8A0Z  11 of 11 model calls asked · 3 changed, most: rank 1 (a write changed)
  #28   step 10  rank 1  send_email is called with other arguments
         recorded send_email({"to":"team@example.com","subject":"Research summary","body":"Replay wo…)
         now      send_email({"to":"team@example.com","subject":"Research summary","body":"Replay wo…)  +0 tokens · −$0.0028
         send_email.body: "Replay works." → "Replay works; forks fence writes."
  #14   step 5  rank 3  fetch_page is no longer called
         recorded fetch_page({"url":"https://example.com/c"}) + read_file({"path":"config.json"})
         now      read_file({"path":"config.json"})  +0 tokens · −$0.0026
  #9    step 3  rank 4  search_web is asked differently
         recorded search_web({"query":"agent determinism"})
         now      search_web({"query":"determinism in agents"})  +0 tokens · −$0.0025
         search_web.query: "agent determinism" → "determinism in agents"
  the steps asked, as recorded and now: 12,260 → 12,260 input tokens · ≈$0.043 → ≈$0.014 (−67%)

! claude-sonnet-4-5-20250929 retires on the Claude API on November 30, 2026, in 42 days; Anthropic recommends claude-sonnet-5-5

  Later steps are judged in the recorded run's state: after the first changed decision, each step says what the change decides where the recorded run was, not where the changed run would have got to. shadowlap verify runs it end to end.
  Each step was asked once, and a model varies from one answer to the next: --samples 3 says how often a decision changes.
  asking: 11 upstream requests · ≈$0.014 spent · per run ≈$0.043 → ≈$0.014 (−67%)
```

That is the [reference agent](./quickstart.md) against its mock model, recorded on a Claude model that retires and asked again under another one. The email it sends at step 10 now says something else: a write with other arguments, rank 1. It also stops fetching a page at step 5 and phrases a search differently at step 3.

## The change

| Flag | What is swapped into each recorded request |
|---|---|
| `--model <model>` | The model, where the provider names it: the body's `model`, or the path on Gemini, Vertex AI, Bedrock and Azure |
| `--set <key=value>` | A request field, where the provider keeps it: `temperature` is `generationConfig.temperature` on Gemini and `inferenceConfig.temperature` on Bedrock Converse; a dotted key is a path |
| `--from-code` | The system prompt and tool definitions your working tree sends now ([below](#the-prompt-your-code-sends)) |

They combine: `--from-code --model claude-sonnet-5-5` previews a new prompt on a new model. Everything else in the request stays exactly as recorded: the conversation up to that call, the tool results it saw, the other settings, and the cache breakpoints the agent placed. The change is sent as given, so a model that refuses a recorded setting answers no step; the report then says what it takes instead, by the provider's pages and its own refusal, and [`migrate`](#migrate) asks with that.

The runs are run ids or prefixes, `label:<name>`, or goldens: `goldens/*` names every pack there, imported as [`shadowlap test`](./cli.md#test) imports them and named as its history names them. `--scope <name>` asks only the calls made in one [scope](./sdk.md#scopes), such as the agent's and not a simulated user's.

## What counts as a decision

A decision is what the agent does next because of an answer: the tools it calls, in order, with their arguments, and whether it stops or hands over. It is read the same way from every provider's answer, JSON or streamed: Anthropic's Messages API (also on Bedrock and Vertex AI), OpenAI's Chat Completions and Responses, Gemini, and Bedrock Converse. A change ranks by its consequence:

| Rank | Change | Example |
|---|---|---|
| 1 | A write tool added, removed or called with other arguments, or the writes in another order | `issue_refund(240)` → `escalate()` |
| 2 | When the agent stops or hands over | it answers at step 7 instead of calling another tool; it transfers to another agent |
| 3 | A read tool added or removed | `lookup_policy` no longer called |
| 4 | Other arguments to a read | a search phrased differently |
| 5 | Text only | the same actions, other words |

A step takes the rank of its most consequential change, and a run that of its most consequential step. Which tools write comes from the run's own effects, the `effect` each tool declares where it is wrapped (see [How it works](./how-it-works.md#effects)), then from the other runs asked with it, then from every run in the store (a tool the recorded run never called, such as the one the new answer asks for, is found there), then from `mcp.effects` in the config. **A tool no recording gives an effect ranks as a write**: nothing says it doesn't act on the world. Pure tools rank as reads. A tool named for a handover, as the OpenAI Agents SDK names its handoffs (`transfer_to_<agent>`), is a handover, rank 2.

Arguments and text are compared after the project's [normalizers](./normalizers-and-redaction.md) (and a redacted recording's rules), with dates near the run's start masked as a replay masks them, so an id or a timestamp made anew is no change. Reads asked in another order within a turn are the same decision. Text-only changes are counted, not judged.

## Reading the report

Each run lists its changed steps, the most consequential first: the call number in the recording, the step among its model calls, the rank and what changed, then the recorded and the new action side by side, with the token and cost difference for that call. A changed argument is shown field by field.

The steps don't depend on each other: step 9 is asked with the conversation as recorded up to step 9, whatever step 3 decided. That is what makes them parallel and free of side effects, and it is the report's limit: **after the first changed decision, later steps are judged in the recorded run's state**, which the changed agent may never have reached. Every report says so. It narrows where to look; [`verify`](./verify.md) is the end-to-end check, and `--then-verify` runs it on exactly the runs that need it.

`--samples <n>` asks each step *n* times and reports how often its decision changed (*in 2 of 3 samples*), which tells a changed policy from a model's own variation. With one sample and a change, the report says so.

## The prompt your code sends

`--from-code` previews the prompt and tools in your working tree before you run anything. Shadowlap replays each run offline under your code, its model calls matched without their system prompt and tool definitions, the way [`--prompt-from`](./interventions.md#apply-a-changed-prompt-from-a-later-call) matches them. Each model request your agent sends is captured, with its new prompt, and answered from the recording; every tool call is served as recorded; nothing reaches a provider; and the replay is not kept. Then each recorded request is asked again with the prompt your code sends at that step.

```sh
AGENT_SYSTEM_SUFFIX="Do not email the summary." shadowlap decisions 01M58VT1J5 --from-code
```

```
✗ 1 of 1 run decides a write or when to stop differently, under the prompt and tools in the working tree
  11 steps asked: 1 rank 1, 10 the same · no tool ran

01M58VT1J5  11 of 11 model calls asked · 1 changed, most: rank 1 (a write changed)
  #28   step 10  rank 1  send_email is no longer called
         recorded send_email({"to":"team@example.com","subject":"Research summary","body":"Replay wo…)
         now      answers and stops: "Summary: recorded runs replay deterministically, and forks fence writes…"  −8 tokens · −<$0.001
  the steps asked, as recorded and now: 12,260 → 12,260 input tokens · ≈$0.043 → ≈$0.043 (about the same)
```

It refuses a run, saying why, when its first model request differs in more than its prompt and tools: a changed model or setting, another message. That is another change, and `verify` tests it. When a later request differs in more (the code changed what step 6 sends), the offline replay stops there: that step and the ones after it are asked with the last prompt it captured in their scope, and the run's warnings say so. A request whose prompt the working tree doesn't change is left out: asking it again would only measure noise.

## Costs, caching and thinking

**It isn't a cost saver per call.** It makes as many model calls as the runs did, more with `--samples`. What it buys is steps in parallel, no side effects, each change attributed to the call that made it, and a live `verify` narrowed to the runs that need one. Usage and cost are read from each answer as for any live call, under the configured prices; `--budget` stops it, and `--concurrency` (4 by default) bounds the requests in flight.

**Prompt caching.** A run's steps share their prefix, so the cache breakpoints stay where the agent put them and a run's steps are sent in order: the prompt cache can serve the prefix from the step before. Anthropic bills a cache read at a tenth of the input price.

**Thinking from earlier turns.** Providers tie a turn's reasoning to the prompt it was produced under ([How it works](./how-it-works.md#thinking-blocks)). When the change is the prompt, the reasoning earlier turns carry is left out of the request (Anthropic's thinking blocks, Converse's reasoning content, Responses' reasoning items, Gemini's thought parts), as Anthropic advises for reasoning bound to another conversation, and the report says how many requests that touched. Three things stay: Gemini's thought signatures, as Gemini asks for them back; a turn that holds nothing but reasoning, since a turn can't be empty; and, with a manual thinking budget (`budget_tokens`), the last assistant turn's thinking, which Anthropic requires that turn to begin with. A Responses item that followed the reasoning left out is sent by its content rather than its stored id. When the change is only the model, the reasoning is sent as recorded, as your agent would send it after a switch: Anthropic drops, unbilled, the blocks the new model can't read.

## Where requests go

Requests go where a live call goes: `SHADOWLAP_UPSTREAM_<PROVIDER>` (a mock, a gateway, a local server), an SDK base URL you set before Shadowlap, or the provider's own host. Bedrock's host comes from the Region the call's model ARN names, else `AWS_REGION`; Vertex AI's from the location in the call's path; Azure's from `AZURE_OPENAI_ENDPOINT`. Credentials come from this machine and are never stored: `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`), `OPENAI_API_KEY`, `GEMINI_API_KEY` (or `GOOGLE_API_KEY`), `AZURE_OPENAI_API_KEY`; Bedrock requests are signed with your AWS credentials, as the AWS CLI finds them, and Vertex AI's carry a Google token: `GOOGLE_OAUTH_ACCESS_TOKEN` (`gcloud auth print-access-token`), or your application default credentials (`gcloud auth application-default login`). When one is missing, nothing is sent and the command names it.

## Then verify

```sh
shadowlap decisions goldens/* --from-code --then-verify
```

After asking, `--then-verify` runs [`verify`](./verify.md) on the runs with a rank 1 or 2 change, and only on those: a run that passed as recorded must keep passing, one that failed must now pass, each judged by its golden's checks from `shadowlap.config.json` (or `--expect`). The model and fields of the change go to verify as `--model` and `--set`; a `--from-code` change is your working tree, which verify replays. The verdict is kept like any other, and the report ends with the command that verifies them again. Runs whose writes and stops didn't change are not replayed.

## Migrate

`shadowlap migrate --to <model>` is the decision diff packaged for a model switch, such as the one a retirement date forces:

```sh
shadowlap migrate --to claude-haiku-4-5
```

```
✓ claude-haiku-4-5 keeps every run passing: claude-sonnet-4-5-20250929 → claude-haiku-4-5, 1 run
  claude-sonnet-4-5-20250929 retires on the Claude API on November 30, 2026, in 42 days; Anthropic recommends claude-sonnet-5-5

What changes
  rank 1  goldens/research #28  send_email is called with other arguments
          send_email.body: "Replay works." → "Replay works; forks fence writes."
  besides: 1 read added or removed, 1 read asked differently

What still passes
  goldens/research             kept · verified

What it costs
  per run      ≈$0.043 → ≈$0.014 (−67%) · 12,700 → 12,700 tokens
  checking it  ≈$0.014 asking, ≈$0.058 verifying

What to set
  only the model: claude-haiku-4-5

The config change
  agent.config.json  1 place
```

It runs `decisions --model` on your goldens (`goldens/*`, or the packs and runs you name), then `verify` on the runs with a rank 1 or 2 change, and compares what a run costs. The report has four blocks, in order:

- **What changes:** each write and stop change, with the recorded and the new action; the rest counted.
- **What still passes:** each run verified, *kept*, *fixed* or *broken* (or *not fixed*, or *unsettled* when its attempts didn't settle it); a run whose writes and stops didn't change is *unchanged* and not re-run.
- **What it costs:** per run, before and after, from the recorded calls and the new answers, and what checking cost.
- **What to set:** the fields the switch needs, each with why.

**What to set** comes from two places. The [retirement table](#model-retirements) keeps what a provider's pages say its newer models stop accepting. On Claude 4.7 and later, wherever Claude is served: a non-default `temperature`, `top_p` or `top_k` is answered with a 400, so a recorded `temperature` is set to its default, 1, and `top_p` and `top_k` are left out; and a manual thinking budget (`thinking: {type: "enabled", budget_tokens: …}`) is refused, so `thinking` becomes `{"type": "adaptive"}`, as Anthropic's [extended thinking page](https://platform.claude.com/docs/en/build-with-claude/extended-thinking) says to send instead. And when the new model refuses a request and its answer names what to change (`max_tokens: 64000 > 32000, which is the maximum allowed…`, `"thinking.type.enabled" is not supported`), the step is asked once more with that field changed. Verify runs with the fields set, as `--set`; a field left out has to leave your agent's requests first, since verify runs your code, and the report warns of it.

It ends with the **config change**, a patch for the project's files that name the old model (found with `git ls-files`, recordings and the store left out), and a **pull request body** with the four blocks, both written to `.shadowlap/migrations/<id>/`:

```sh
git apply .shadowlap/migrations/mg-01M58W9A7S6YD9QC6C83ES8EP4/config.patch
gh pr create --title "Switch claude-sonnet-4-5-20250929 to claude-haiku-4-5" --body-file .shadowlap/migrations/mg-01M58W9A7S6YD9QC6C83ES8EP4/pull-request.md
```

When no file names the model (it comes from an environment variable or a deployment setting), the report says where to set it instead. It exits 1 when a verified run breaks or a step could not be asked.

## Model retirements

`decisions` and `migrate` warn when a model the runs use, or the one they switch to, retires. The dates come from a table that ships with Shadowlap as data, `packages/engine/data/model-retirements.json` in the repository, read from each provider's own pages on the date its `version` names, each row with its page; nothing calls home, and a newer release ships a newer table. The same file keeps the request fields newer models stop accepting, which `migrate` changes.

| Platform | Page | What the table keeps |
|---|---|---|
| The Claude API | [platform.claude.com, model deprecations](https://platform.claude.com/docs/en/about-claude/model-deprecations) | Deprecated and retired models, with their retirement dates and replacements; "not sooner than" dates for active models set no date and are left out. Its note on `temperature`, `top_p` and `top_k` too, and from [extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking), the models that refuse a manual thinking budget |
| The OpenAI API | [developers.openai.com, deprecations](https://developers.openai.com/api/docs/deprecations) | Every chat, text and computer use model's shutdown date, snapshots with the aliases the page names |
| The Gemini API | [ai.google.dev, deprecations](https://ai.google.dev/gemini-api/docs/deprecations) | Gemini 3, 2.5 and 2.0 shutdown dates, which Google gives as the earliest a model may shut down |
| Vertex AI | [cloud.google.com, model versions](https://cloud.google.com/vertex-ai/generative-ai/docs/learn/model-versions) and [partner model deprecations](https://cloud.google.com/vertex-ai/generative-ai/docs/deprecations/partner-models) | Gemini models with a set retirement date (an "or later" date sets none) and retired ones; Claude and Jamba models with their shutdown dates |
| Amazon Bedrock | [docs.aws.amazon.com, model lifecycle](https://docs.aws.amazon.com/bedrock/latest/userguide/model-lifecycle-legacy.html) | Text models' end-of-life dates, by the Regions each covers |

A call is judged by the platform that served it: a Claude model called through Bedrock has Bedrock's date, and one called through Vertex AI Google's, not Anthropic's. An Anthropic alias (`claude-sonnet-4-5`) matches the one dated snapshot it names, and a Vertex AI version the model the page lists (`gemini-2.0-flash-001` is `gemini-2.0-flash`, `claude-3-7-sonnet@20250219` is `claude-3-7-sonnet`); OpenAI's aliases match only where the page names them. Models that hold no conversation (embeddings, images, speech) are left out, and so is Azure OpenAI: a call names its deployment, which can serve any model.

## In CI

```sh
shadowlap decisions goldens/* --from-code --strict
```

On a pull request, this previews the prompt and tools the branch sends against the goldens, sends only the requests the change touches, and exits 1 when a golden's writes or stops change. It asks the model, so the job needs the provider's key as a secret, as a live `verify` does; `--budget` caps what it spends. `--json` prints the report the dashboard reads, with the same fields for a coding agent ([the reference](./cli.md#decisions)).

## Limits

- Later steps are judged in the recorded state, as above.
- A step whose recorded call failed, or that isn't a conversation (an embeddings call), is not asked, and the report says why.
- `--from-code` sees the prompt and tools; a change to anything else the requests carry is verify's.
- A Responses request that continues a stored response (`previous_response_id`) is asked with the turns the provider holds for it, as recorded.
- An agent that thinks between its tool calls has its earlier reasoning left out under a new prompt, as above; a provider that still wants it back refuses such a step, which is listed with the provider's words, not ranked.
- Each session is kept in the store with each run's decisions, for the dashboard; `gc` leaves sessions, which outlive the runs they name.
