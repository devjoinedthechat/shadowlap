# Decisions

`shadowlap decisions` previews what a change *decides* differently on your real runs, before you run the agent. It asks each recorded model call again with only the change swapped in, compares the answer's decision with the recorded one, and ranks what changed by what it does, writes first. No tool runs, so nothing reaches the world.

A prompt edit or a model switch changes every request, so a replay forks at the first model call, and checking the change costs a live run of every golden. Decisions answers the question in front of it first, and [`--then-verify`](#then-verify) runs the change end to end on the runs that need it.

## Preview a change

Name the runs and the change:

```sh
shadowlap decisions goldens/* --model claude-haiku-4-5
```

It prints:

```text
✗ 1 of 1 run decides a write or when to stop differently, under the model claude-haiku-4-5
  11 steps asked, 3 samples each and as many as recorded: 1 rank 1, 1 rank 3, 1 rank 4, 8 the same · no tool ran

goldens/research 01M58W8A0Z  11 of 11 model calls asked · 3 changed, most: rank 1 (a write changed)
  #28   step 10  rank 1  send_email is called with other arguments · in 3 of 3 samples, 0 of 3 as recorded
         recorded send_email({"to":"team@example.com","subject":"Research summary","body":"Replay wo…)
         now      send_email({"to":"team@example.com","subject":"Research summary","body":"Replay wo…)  +0 tokens · −$0.0028
         send_email.body: "Replay works." → "Replay works; forks fence writes."
  #14   step 5  rank 3  fetch_page is no longer called · in 3 of 3 samples, 0 of 3 as recorded
         recorded fetch_page({"url":"https://example.com/c"}) + read_file({"path":"config.json"})
         now      read_file({"path":"config.json"})  +0 tokens · −$0.0026
  #9    step 3  rank 4  search_web is asked differently · in 3 of 3 samples, 0 of 3 as recorded
         recorded search_web({"query":"agent determinism"})
         now      search_web({"query":"determinism in agents"})  +0 tokens · −$0.0025
         search_web.query: "agent determinism" → "determinism in agents"
  the steps asked, as recorded and now: 12,260 → 12,260 input tokens · ≈$0.043 → ≈$0.014 (−67%)

! claude-sonnet-4-5-20250929 retires on the Claude API on November 30, 2026, in 42 days; Anthropic recommends claude-sonnet-5-5

  Later steps are judged in the recorded run's state: after the first changed decision, each step says what the change decides where the recorded run was, not where the changed run would have got to. shadowlap verify runs it end to end.
  Each step was asked 3 times under the change and 3 times as recorded: a change is ranked only when its decisions run more consequential than the recorded request's own, by an exact permutation test at 5% a step.
  A step that reads the same can still decide otherwise some of the time: at 3 samples, one that does so 1 time in 5 is ranked 0.8% of the time.
  asking: 66 upstream requests · ≈$0.174 spent · per run ≈$0.043 → ≈$0.014 (−67%)
```

That is the [reference agent](./quickstart.md) against its mock model, recorded on a Claude model that retires and asked again under another one.

- **Step 10, rank 1.** Under the change, the email it sends says something else in all 3 samples. The request as recorded, asked 3 times too, sent it as recorded every time: a write with other arguments.
- **Step 5, rank 3.** It stops fetching a page.
- **Step 3, rank 4.** It phrases a search differently.

Each step was asked six times, three under the change and three as recorded ([below](#reading-the-report)), so asking cost about four times what one run does.

## The change

The change is one or more of these, swapped into each recorded request:

| Flag | What is swapped into each recorded request |
|---|---|
| `--model <model>` | The model, where the provider names it: the body's `model`, or the path on Gemini, Vertex AI, Bedrock and Azure |
| `--set <key=value>` | A request field, where the provider keeps it; a dotted key is a path |
| `--from-code` | The system prompt and tool definitions your working tree sends ([below](#the-prompt-your-code-sends)) |

`--set` puts a field where the provider keeps it: `temperature` is `generationConfig.temperature` on Gemini and `inferenceConfig.temperature` on Bedrock Converse.

They combine: `--from-code --model claude-sonnet-5-5` previews the working tree's prompt on another model. Everything else in the request stays exactly as recorded:

- the conversation up to that call;
- the tool results it saw;
- the other settings;
- the query it was sent with;
- the cache breakpoints the agent placed.

The change is sent as given, so a model that refuses a recorded setting answers no step. The report then says what it takes instead, by the provider's pages and its own refusal, and [`migrate`](#migrate) asks with that.

### A switch is the agent's

A recording often holds model calls that aren't the agent's decisions: a simulated user, a sub-agent on a smaller model, a judge's. So the change reaches only the agent's calls:

| Calls | Under the change |
|---|---|
| Made with the model the runs use most, or with the models `--from` names | Changed |
| Made with another model | Left as recorded and counted *untouched*; the report names whose calls stayed |
| Any call, with `--set` alone and no `--from` | Changed |
| Shadowlap's own, in a `shadowlap:` scope such as its judge's | No step of the agent's at all |

An alias such as `claude-sonnet-4-5` names its dated snapshots.

A model of another family than the recorded one (a Claude call asked of `gpt-…`) is not asked. Its requests take another format, which asking the recorded request again can't carry it into, so the report says to verify that switch instead.

### Which runs

The runs are run ids or prefixes, `label:<name>`, or goldens: `goldens/*` names every pack there, imported as [`shadowlap test`](./cli.md#test) imports them and named as its history names them.

`--scope <name>` asks only the calls made in one [scope](./sdk.md#scopes), such as the agent's and not a simulated user's. `--scope none` asks those made in no scope.

## What counts as a decision

A decision is what the agent does next because of an answer: the tools it calls, in order, with their arguments, and whether it stops or hands over. It is read the same way from every provider's answer, JSON or streamed: Anthropic's Messages API (also on Bedrock and Vertex AI), OpenAI's Chat Completions and Responses, Gemini, and Bedrock Converse.

A change ranks by its consequence:

| Rank | Change | Example |
|---:|---|---|
| 1 | A write tool added, removed or called with other arguments, or the writes in another order | `issue_refund(240)` → `escalate()` |
| 2 | When the agent stops or hands over, or a [judge check](#text-a-judge-check-reads) reads its words otherwise | It answers at step 7 instead of calling another tool; it transfers to another agent |
| 3 | A read tool added or removed | `lookup_policy` no longer called |
| 4 | Other arguments to a read | A search phrased differently |
| 5 | Text only | The same actions, other words |

A rank 2 change also covers a final reply that no longer says what a judge check asks it to.

A step takes the rank of its most consequential change, and a run that of its most consequential step.

### Which tools write

Which tools write comes from these, in this order:

1. **`mcp.effects` in the config**: what you declare today.
2. **The run's own effects**: the `effect` each tool declares where it is wrapped (see [How it works](./how-it-works.md#effects)).
3. **The other runs asked with it.**
4. **Every run in the store.** A tool the recorded run never called, such as the one the changed answer asks for, is found there.

Then:

- **A tool no recording gives an effect ranks as a write**: nothing says it doesn't act on the world.
- **Pure tools** rank as reads.
- **A tool named for a handover**, as the OpenAI Agents SDK names its handoffs (`transfer_to_<agent>`), is a handover, rank 2.

### Tools the provider runs

Tools the provider runs or defines itself are read too, by what they do:

| Tool | Counts as |
|---|---|
| Anthropic's web search, web fetch, tool search and code execution | A read |
| The Responses API's web search, file search and code interpreter | A read |
| An image the model makes | Pure |
| A computer use action (`computer.click`, `computer.type`, named for its kind) | A write, but a screenshot or a wait reads |
| The Responses API's shell and patch tools | A write |
| A remote MCP server's tool (Anthropic's MCP connector, the Responses API's `mcp` tool) | Named for the tool, its effect from `mcp.effects`, else a write |

Code execution reads because the code runs in the provider's own sandbox, where nothing outside it changes.

### What is no change

- **Values made anew.** Arguments and text are compared after the project's [normalizers](./normalizers-and-redaction.md) (and a redacted recording's rules), with dates near the run's start masked as a replay masks them. So an id or a timestamp made anew is no change.
- **Reads in another order** within a turn are the same decision.
- **Text-only changes** are counted, not judged, unless a judge check reads them.

## Text a judge check reads

A text-only change, the same actions in other words, is counted, not judged, unless a [judge check](./checks.md#judge-checks) of the run reads those words.

**Which checks.** The checks are the ones the run is judged by:

- a golden's, from `shadowlap.config.json`;
- for a run named by id, those of the recording it comes from: the golden a test replayed, or the pack it was unpacked from;
- `--expect`, with `--then-verify`.

**Which words a check reads.** It depends on what its judge reads:

| The judge reads                     | It reads a step's words when the step is |
| ----------------------------------- | ---------------------------------------- |
| The final answer (`"of": "answer"`) | The run's last model call                |
| The run (`"of": "run"`)             | The last model call of a conversation    |

**How it is asked.** The judge is asked about the recorded words and the changed ones, as a test asks it: through Shadowlap's sidecar in the judge's own scope, `shadowlap:judge`, at temperature 0 where the model takes one, for a structured verdict. It reads what it reads with the project's redaction rules applied. A judge of the run reads the run as recorded, with the changed answer in its place.

**A check that comes out otherwise ranks the step 2**, beside a changed stop, so the run is flagged: `--then-verify` verifies it, `--strict` fails on it, and `migrate` lists it under what changes.

- **Why 2.** What the agent hands back passed a check the project wrote and fails it under the change, or the other way round. As when it stops or hands over differently, what reaches the person or the next agent changed.
- **Why not 1.** No write changed, nothing acts on the world differently, and a verdict is a model's reading of the words, which can be wrong. So verify settles it end to end.

A check that comes out as recorded leaves the step text only, with the verdicts beside it.

```sh
AGENT_SYSTEM_SUFFIX="Keep the final answer short." shadowlap decisions goldens/research --from-code
```

```text
✗ 1 of 1 run is judged otherwise, under the prompt and tools in the working tree
  11 steps asked, 3 samples each and as many as recorded: 1 rank 2, 10 the same · no tool ran

goldens/research 01M58W8A0Z  11 of 11 model calls asked · 1 changed, most: rank 2 (it stops, hands over or is judged differently)
  #30   step 11  rank 2  judge "fences" fails what it says now, which passed as recorded · in 3 of 3 samples, 0 of 3 as recorded
         recorded answers and stops: "Done. Summary: recorded runs replay deterministically; forks fence…"
         now      answers and stops: "Done. Recorded runs replay deterministically."  −8 tokens · −<$0.001
         judge "fences" passed → failed · It no longer says that forks fence writes. (judged live, <$0.001)
```

The golden's check `fences` asks whether the final answer says that forks fence writes. The recording's verdict was yes, and the changed words' verdict is no.

### What judging costs

Each verdict is kept with the session, with a digest of the request it answered:

- **The recorded words' verdict** comes from the golden's own judge call, which `pack` and `test --update` keep, for free.
- **A request asked before** in a session this store keeps of the run, such as the same changed words in an earlier preview, is answered from what that session kept, for free.
- **Only the rest is asked**, once however many samples send it.

A fresh store, such as a CI job's, keeps no earlier session, so there the changed words are asked again.

What judging costs is reported apart from asking (`judging:` under the report, `judge` in its JSON), and counts against `--budget`. A judge model with no price is no free call, and the report names it.

### When the judge can't be asked

Where the judge can't be asked (no key for its provider and no upstream set for it, the budget spent, Ctrl-C), the check is *inconclusive* and says why. The step stays text only, and the warnings say what could not be judged.

A preview that can't tell whether a run would be flagged settles nothing. When nothing else flags the run, it exits 3 unless `--inconclusive warn`; after a stop signal, 128 + n, 130 for Ctrl-C. After a Ctrl-C, `--then-verify` starts no verify, and says so.

The report's notes count the steps a check reads: those it came out otherwise for, those it came out as recorded for, and those it could not judge, never one for the other.

### What no judge reads

- **A run that did not complete** (its agent exited with an error, or it was interrupted) is judged by none of its checks, as `pack` and `test` judge none. It fails its checks whatever a judge says, so its text-only changes are counted, and the report says so.
- **A check on what the agent printed** (`"of": "output"`) reads no model call's answer. The report names it, and verify judges it end to end: a run whose text changed is among [those a preview can't clear](#then-verify) when such a check reads it.
- **The words of an earlier step**, as given. The requests after it carry them back to the model as recorded, so no run holds that answer with the rest as recorded.

## Reading the report

Each run lists its changed steps, the most consequential first. The report's parts:

| Part | Meaning |
|---|---|
| The first line | How many runs decide a write or when to stop differently, and under what change |
| The counts | Steps asked, the samples each, how many steps at each rank or the same, and that no tool ran |
| A run's line | The golden and run id, the model calls asked, how many changed, and the most consequential rank |
| A step's line | The call number in the recording, the step among its model calls, the rank and what changed |
| `recorded` and `now` | The recorded and the changed action side by side, with the token and cost difference for that call |
| A changed argument | Shown field by field, the recorded value and the changed one |
| `the steps asked, as recorded and now` | Input tokens and cost of the steps asked, before and after |
| `!` | A warning, such as a model that retires |
| The notes | That later steps are judged in the recorded run's state, and the rule steps are ranked by |
| `asking:` | What asking cost: upstream requests, the spend, and a run's cost before and after |

### Later steps are judged in the recorded state

The steps don't depend on each other: step 9 is asked with the conversation as recorded up to step 9, whatever step 3 decided. That is what makes them parallel and free of side effects.

It is also the report's limit: **after the first changed decision, later steps are judged in the recorded run's state**, which the changed agent may never have reached. A model that skips a read and later acts without it looks fine at the later steps, which still see what it read. Every report says so. It narrows where to look; [`verify`](./verify.md) is the end-to-end check, and `--then-verify` runs it on [the runs a preview can't clear](#then-verify).

### Samples and the control

**Each step is asked 3 times under the change, and 3 times exactly as recorded** (`--samples <n>` sets both; 3 by default). A model asked the same request twice can answer otherwise. The samples asked as recorded, the **control**, say how often it does here, with these tools, this conversation and this model.

Each sample's decision is compared with the recorded one and ranked. A step is ranked only when its changed samples run more consequential than its control's by more than chance explains, at 5% a step. The test is an exact one-sided permutation test over every way the samples' scores could have been split between the two sides: 5 for a write, down to 1 for text only, 0 for the same decision.

When the change makes no difference to a step, both sides draw from one distribution. Then the step is ranked at most 5% of the time, whatever the model does on its own: one that writes otherwise half the time unasked is ranked 1.6% of the time at 3 samples.

A ranked step takes the most consequential rank its changed samples show more often than its control's, and flags its run at rank 1 or 2. Its line shows both sides' counts: *in 3 of 3 samples, 0 of 3 as recorded*.

With 3 samples a side, no split comes out less often than 1 in 20, so a change is ranked when every changed sample is more consequential than every sample as recorded. A change the model makes only some of the time takes more samples to tell from its own variation:

| `--samples` | A write that changed is ranked when it shows in…       |
| ----------: | ------------------------------------------------------ |
|           3 | 3 of 3 samples, and in none of 3 as recorded           |
|           5 | 4 of 5, against none as recorded; or 5 of 5, against 1 |
|          10 | 4 of 10, against none; 6 of 10, against 1              |

**Fewer than 3 samples.** With fewer than 3 samples nothing can reach 5%, so the control isn't asked. A step flags its run when more than half its samples show a write, stop or judged change, and the report says such a change was not told from the model's own variation.

### What a step that reads the same is worth

A step that reads the same can still decide otherwise some of the time. The control's test is built against false alarms, so few samples miss what a model does only sometimes, and 3 samples miss more than 1. This table gives the chance a step is ranked, in the easiest case, where it never decides otherwise as recorded:

| `--samples` | Shows 1 time in 10 | Shows 1 time in 5 | Shows 1 time in 2 |
| ---------: | ----------------: | ---------------: | ---------------: |
| 1 | 10% | 20% | 50% |
| 3 | 0.1% | 0.8% | 12.5% |
| 10 | 1.3% | 12.1% | 82.8% |
| 20 | 4.3% | 37% | 99.4% |

So no number of samples clears a run on its own, and a report with a step that reads the same says what it is worth. [Verify](#then-verify) runs the runs that have something to lose.
### Steps the control can't decide

Some steps aren't ranked, or aren't ranked against the control:

| Step | What the report does |
|---|---|
| Its samples decided otherwise no more often than its control's | Lists it with both counts, *within the model's own variation*, and counts such steps |
| A sample a judge could not judge, and its samples don't flag it | Waits on the judge, and says how many of its samples were *not judged* |
| The request as recorded can't be asked any more | Ranks it by its changed samples alone, and warns |
| The request as recorded got no answer, for a passing reason | Marks a step its samples changed *not settled* |
| Fewer than 3 answers on either side | Marks it *not settled* too, and counts it as not asked |

- **Ranked by chance.** Each step is tested on its own, so across a run of many steps one may be ranked by chance: `verify`, which runs the change end to end, settles it.
- **Which sample a step shows.** A judge reads each sample's words, on both sides alike. The step shows the sample with the most consequential change, or among text-only ones, one whose words could not be judged.
- **Waiting on the judge.** A step any sample of which a judge could not judge, and that its samples don't flag, waits on the judge, as a step asked once does. Its run settles nothing unless something else flags it.
- **The request as recorded can't be asked any more**, such as for a model that retired, or a request the provider turns away. The step is ranked by its changed samples alone, and the warnings say so.
- **No answer, for a passing reason**: the request as recorded got none because of an overload, a rate limit, a 5xx or a dropped connection. Nothing told the step's change from the model's own variation.
- **Fewer than 3 answers** on either side, whatever kept the third from coming: no split of 3 against 2 comes out rarer than 1 in 10, so it could never rank.

A step that is not settled, as with a step that waits on a judge, leaves its run settling nothing unless something else flags it: `decisions` exits 3, and `migrate` reads the run as inconclusive.

### What the report masks

The report shows what the project's [redaction rules](./normalizers-and-redaction.md) leave of a value. The arguments, texts and errors it holds are masked as in every export, pack and share link, and in a pull request's body or a comment on one, while the comparison reads the values themselves.

What a judge check reads goes to its model, so it is masked the same way before it is sent. When a judge read it, the report's notes say so.

## The prompt your code sends

`--from-code` previews the prompt and tools in your working tree before you run anything:

1. Shadowlap replays each run offline under your code, its model calls matched without their system prompt and tool definitions, the way [`--prompt-from`](./interventions.md#apply-a-changed-prompt-from-a-later-call) matches them.
2. Each model request your agent sends is captured, with its changed prompt, and answered from the recording. Every tool call is served as recorded, nothing reaches a provider, and the replay is not kept.
3. Each recorded request is asked again with the prompt your code sends at that step.

```sh
AGENT_SYSTEM_SUFFIX="Do not email the summary." shadowlap decisions 01M58VT1J5 --from-code
```

```text
✗ 1 of 1 run decides a write or when to stop differently, under the prompt and tools in the working tree
  11 steps asked, 3 samples each and as many as recorded: 1 rank 1, 10 the same · no tool ran

01M58VT1J5  11 of 11 model calls asked · 1 changed, most: rank 1 (a write changed)
  #28   step 10  rank 1  send_email is no longer called · in 3 of 3 samples, 0 of 3 as recorded
         recorded send_email({"to":"team@example.com","subject":"Research summary","body":"Replay wo…)
         now      answers and stops: "Summary: recorded runs replay deterministically, and forks fence…"  −8 tokens · −<$0.001
  the steps asked, as recorded and now: 12,260 → 12,260 input tokens · ≈$0.043 → ≈$0.043 (about the same)
```

It holds a run to its prompt and tools:

- **A first request that differs in more** than its prompt and tools, such as a changed model or setting, or another message: the run is refused, saying why. That is another change, and `verify` tests it.
- **A later request that differs in more** (the code changed what step 6 sends): the offline replay stops there. That step and the ones after it are asked with the last prompt it captured in their scope, and the run's warnings say so.
- **A request whose prompt the working tree doesn't change** is left out: asking it again would only measure noise.

## Costs, caching and thinking

### What asking costs

Decisions isn't a cost saver per call. By default it makes six model calls for each one the runs made: three under the change and three as recorded, the control. `--samples 1` asks each step once, with no control, for a sixth of that, and ranks whatever the one answer shows.

What it buys:

- steps in parallel, with no side effects;
- each change attributed to the call that made it, and told from the model's own variation;
- a live `verify` narrowed to the runs that need one.

Usage and cost are read from each answer as for any live call, under the configured prices, the control's under the recorded model's. `--budget` stops it, and `--concurrency` (4 by default) bounds the requests in flight.

### What a run costs under the change

What a run costs under the change is worked out as a run would spend it, not as asking spent it. A run's steps follow one another, each reading from the prompt cache the prefix the step before it cached. Asking them again caches otherwise: several at once each cache the prefix anew, and a second sample of a step reads all of it.

So a step's cost after the change is its changed answer's input, split between cache read, cache creation and uncached input as the recorded call's input was, and its output, priced for the model asked. What asking spent is reported apart (`spent`).

### Prompt caching

The cache breakpoints stay where the agent put them. A run whose requests carry them is asked one step at a time, in order, so each step can read the prefix it shares with the step before it. Runs go side by side, as many as `--concurrency` allows.

Anthropic bills a cache read at a tenth of the input price, and less on its newest models.

### Thinking from earlier turns

Providers tie a turn's reasoning to the prompt it was produced under ([How it works](./how-it-works.md#thinking-blocks)). When the change is the prompt, the reasoning earlier turns carry is left out of the request, as Anthropic advises for reasoning bound to another conversation:

- Anthropic's thinking blocks;
- Converse's reasoning content;
- Responses' reasoning items;
- Gemini's thought parts.

The report says how many requests that touched. Three things stay:

- **Gemini's thought signatures**, as Gemini asks for them back;
- **a turn that holds nothing but reasoning**, since a turn can't be empty;
- **the last assistant turn's thinking, with a manual thinking budget** (`budget_tokens`), which Anthropic requires that turn to begin with.

A Responses item that followed the reasoning left out is sent by its content rather than its stored id.

When the change is only the model, the reasoning is sent as recorded, as your agent would send it after a switch. Anthropic drops, unbilled, the blocks the model switched to can't read.

## Where requests go

Requests go where a live call goes: `SHADOWLAP_UPSTREAM_<PROVIDER>` (a mock, a gateway, a local server), an SDK base URL you set before Shadowlap, or the provider's own host. Three providers' hosts come from the call:

| Provider  | Host                                                     |
| --------- | -------------------------------------------------------- |
| Bedrock   | The Region the call's model ARN names, else `AWS_REGION` |
| Vertex AI | The location in the call's path                          |
| Azure     | `AZURE_OPENAI_ENDPOINT`                                  |

Credentials come from this machine and are never stored. When one is missing, nothing is sent and the command names it.

| Provider | Credentials |
|---|---|
| Anthropic | `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`) |
| OpenAI | `OPENAI_API_KEY` |
| Gemini | `GEMINI_API_KEY` (or `GOOGLE_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`) |
| Azure OpenAI | `AZURE_OPENAI_API_KEY` (or `AZURE_API_KEY`) |
| Bedrock | Your AWS credentials, as the AWS CLI finds them, signing for the AWS host the call is for |
| Vertex AI | A Google token: `GOOGLE_OAUTH_ACCESS_TOKEN` (`gcloud auth print-access-token`), or your application default credentials (`gcloud auth application-default login`) |

A gateway in front of Bedrock receives the requests signed as the agent's SDK signs them.

A call is sent with the query it was recorded with, credentials left out: an Azure OpenAI deployment's `api-version`, Gemini's `alt=sse`. A recording made before recordings kept a call's query has none to send. An Azure deployment call then takes `OPENAI_API_VERSION` (or `AZURE_OPENAI_API_VERSION`), as the AzureOpenAI SDKs read it, and without one nothing is sent.

## Then verify

```sh
shadowlap decisions goldens/* --from-code --then-verify
```

After asking, `--then-verify` runs [`verify`](./verify.md) on the runs a preview can't clear, since it asks each step in the recorded run's state and only a few times. A run asked again goes end to end when any of these holds:

- **It acts on the world.** A step as recorded calls a write tool, a tool no recording gives an effect, or hands over, however alike its steps look.
- **Any sample decided otherwise.** That covers every rank from 1 to 4, a changed read included, ranked or not.
- **Its words changed and a check reads more than them.** A preview only answers a judge of a model call's words, so any other check, such as `answer`, `output` or a token limit, is verify's.

A run with none of these is cleared and not replayed: it is listed as not run end to end. `--strict` still fails only on a rank 1 or 2 change.

- **The checks.** Each run is judged by its checks from `shadowlap.config.json` (or `--expect`): a golden's own, and for a run named by id those of the recording it comes from (the golden a test replayed, or the pack it was unpacked from). It runs one verify per set of checks.
- **The roles.** Each run plays the role its recording plays under them. A run that passes them as recorded must be kept: no worse than the same run without the change (for a switch, on the model it was recorded with) by 10 points or more, as [verify keeps a good run](./verify.md#good-runs-against-their-own-baseline). One that fails them must pass under the change.
- **The change.** Its model and fields go to verify as `--model` and `--set`, with `--from` naming the models they change at, so verify changes the same calls the preview did. A `--from-code` change is your working tree, which verify replays.
- **The gate.** Each run is replayed until verify's [gate](./gating.md) decides, as `verify` decides by default: `--gate` changes its figures, and `--attempts` and `--passes` give a fixed count instead.

The verdict is kept like any other, and the report ends with the commands that verify the runs again.

### Verify a session later

A session kept earlier can be verified later, or one run of it: `shadowlap decisions --verify dc-01M58W8A0Z… [run]` verifies the runs it could not clear the same way, without asking anything again. It keeps what verify finds in the session, over what an earlier verify found for the others. The dashboard runs it as its `decisions-verify` job.

A run whose gate ran out of attempts between its bounds, or that an attempt it could not judge stopped, is *inconclusive*, and the session stays incomplete until a verify settles it. Each run keeps the rule that decided it, so a session verified again under another gate states each rule once, over the runs it decided.

An inconclusive verify settles nothing: `decisions` and `migrate` then exit 3 unless `--inconclusive warn`, as `test` does with an inconclusive gate.

## Migrate

`shadowlap migrate --to <model>` is the decision diff packaged for a model switch, such as the one a retirement date forces:

```sh
shadowlap migrate --to claude-haiku-4-5
```

It prints:

```text
✓ claude-haiku-4-5 keeps every run passing: claude-sonnet-4-5-20250929 → claude-haiku-4-5, 1 run
  claude-sonnet-4-5-20250929 retires on the Claude API on November 30, 2026, in 42 days; Anthropic recommends claude-sonnet-5-5

What changes
  rank 1  goldens/research #28  send_email is called with other arguments
          send_email.body: "Replay works." → "Replay works; forks fence writes."
  besides: 1 read added or removed, 1 read asked differently

What still passes
  goldens/research             passed · kept, verified · 38 of 38, baseline 38 of 38 · drop <= 0.10 (95%)
  kept unless it drops 10+ points below its baseline, attempt for attempt, <= 5% risk, up to 200 pairs
  1 of 1 run verified end to end

What it costs
  per run      ≈$0.043 → ≈$0.014 (−67%) · 12,700 → 12,700 tokens
  end to end   12,260 → 12,260 input tokens · ≈$0.043 → ≈$0.014 (−67%)
  checking it  ≈$0.014 asking, ≈$2.20 verifying

What to set
  only the model: claude-haiku-4-5

The config change
  agent.config.json  1 place
```

It works in three steps:

1. It runs `decisions --model` on your goldens (`goldens/*`, or the packs and runs you name).
2. It runs `verify` on [the runs a preview can't clear](#then-verify), each decided by verify's gate as `--then-verify` decides it.
3. It compares what a run costs.

**Which calls it switches.** The agent's calls: those made with the models `--from` names, else those made with a model that retires, by the [retirement table](#model-retirements), else those made with the model the runs use most. A simulated user or a sub-agent on another model keeps its own, in the preview and in verify.

The report has four blocks, in order:

| Block | What it holds |
|---|---|
| **What changes** | Each write, stop and judged change, with the recorded and the changed action; the rest counted |
| **What still passes** | Each run's verdict: *passed*, *failed* or *inconclusive*, and how many of the runs were verified end to end |
| **What it costs** | Per run, before and after, from the recorded calls and the changed answers; end to end; and what checking cost |
| **What to set** | The fields the switch needs, each with why |

**What changes** counts the text-only changes with how many a judge check read as recorded, and how many it could not judge.

**What it costs** gives its end-to-end line from what verify's attempts did, which sees a run that takes more steps than the recorded ones.

### What still passes

Each run's verdict is *passed*, *failed* or *inconclusive*. A run verified says how verify found it:

- *kept*, *fixed*, *broken* or *not fixed*;
- *inconclusive*, when its gate ran out of attempts between its bounds or an attempt could not be judged;
- *unsettled*, when its attempts stopped before they settled it (the budget, Ctrl-C).

It gives its tally and the bound of its pass rate, or for a run kept against its baseline both tallies and the bound on its drop, under the rule that decided it, each rule stated once. An attempt that could not be judged is counted apart, never as one that failed (*2 of 2, attempt 3 not judged*).

- **Unchanged.** A run the preview cleared is *unchanged*: it is not run end to end, and its recording's own verdict under its checks stands. The first line claims only what ran: *keeps the run it verified passing*, or, when none ran, *decided the same in the preview*.
- **Not judged.** A run with a text-only change a judge check reads that could not be judged is *inconclusive* (`not-judged`): the words might read otherwise.

### What to set

What to set comes from two places: the retirement table, and the model's own refusal.

**The [retirement table](#model-retirements)** keeps what a provider's pages say its newer models stop accepting:

| Requests | Field | What to set |
|---|---|---|
| Claude 4.7 and later, in a Messages API request on the Claude API, Bedrock or Vertex AI | A non-default `temperature`, `top_p` or `top_k` | Leave them out, as the page says: they are answered with a 400 |
| The same | A manual thinking budget (`thinking: {type: "enabled", budget_tokens: …}`), which is refused | `thinking` becomes `{"type": "adaptive"}` |
| OpenAI's o-series, on Chat Completions | `max_tokens`, which doesn't work with them | The same limit as `max_completion_tokens` |

- **Meanwhile**, the preview and verify send `temperature` its default, 1, in place of a non-default value.
- **`{"type": "adaptive"}`** is what Anthropic's [extended thinking page](https://platform.claude.com/docs/en/build-with-claude/extended-thinking) says to send instead.
- **The o-series rule** comes from OpenAI's Chat Completions reference, which says `max_tokens` doesn't work with the o-series.
- **A Converse request** keeps its settings elsewhere, and is left to the model's own refusal.

**The model's own refusal.** When the model switched to refuses a request and its answer names what to change, the step is asked once more with that field changed. So is each later request to that model through that provider that needs it. Answers such as these name the field:

- `max_tokens: 64000 > 32000, which is the maximum allowed…`;
- `"thinking.type.enabled" is not supported`;
- *Use 'max_completion_tokens' instead*.

An output limit only ever lowers a request, and never under its thinking budget.

**In verify.** Verify runs with the fields set to a value, as `--set`. A field to leave out, or to send under another name, has to change in your agent's requests first, since verify runs your code. Verify waits for that, the report says what to change, and its commands verify the runs once you have.

### The config change

Migrate ends with two files, both written to `.shadowlap/migrations/<id>/`:

- **the config change**, a patch for the project's files;
- **a pull request body** with the four blocks, which names the command it was checked with, a key on it masked as in a pack.

```sh
git apply .shadowlap/migrations/mg-01M58W9A7S6YD9QC6C83ES8EP4/config.patch
gh pr create --title "Switch claude-sonnet-4-5-20250929 to claude-haiku-4-5" --body-file .shadowlap/migrations/mg-01M58W9A7S6YD9QC6C83ES8EP4/pull-request.md
```

**Which files the patch reads.** The project's files are found with `git ls-files`, recordings and the store left out. A link is read as the file it names only when git lists that file too, outside git's own folder. So no line of a `.env` git ignores, a key file kept elsewhere or git's config is quoted.

**What the patch changes.** It changes a model only where a string value names it whole, in code and config: a string literal, a JSON value, a YAML, TOML or `.env` value. Every other mention is left as it is and listed for review:

- in prose and changelogs: they say what was;
- in tests;
- as an object key, such as a price table's;
- inside a longer string;
- in `shadowlap.config.json`, whose prices and judges name models of their own.

When no string names the model (it comes from an environment variable or a deployment setting), the report says where to set it instead.

The pull request body shows what the project's redaction rules leave of the values it quotes.

**Exit status.** Migrate exits 1 when a verified run breaks. A report that settles nothing (a step got no answer, a run that needed verify went unverified, the budget ran out) exits 3 unless `--inconclusive warn`.

### Once the old model is gone

A good run is kept against the same run [on the model it was recorded with](./verify.md#the-baseline), and a model that retired can't run. The baseline then says nothing of what the switch did, so each such run is [judged by its gate on its own](./verify.md#no-baseline), and the report's warnings say why. A run that fails its checks under the model it switches to fails, whatever the old one can no longer show.

The old model's behavior can only be measured before it retires. So migrate before the date when you can: a run judged against its baseline tells a drop of 10 points, and a gate alone only tells 90% from 70%.

## Model retirements

`decisions` and `migrate` warn when a model the runs use, or the one they switch to, retires.

The dates come from a table that ships with Shadowlap as data, `packages/engine/data/model-retirements.json` in the repository. It is read from each provider's own pages on the date its `version` names, each row with its page. Nothing calls home, and a newer release ships a newer table. The same file keeps the request fields newer models stop accepting, which `migrate` changes.

| Platform | Page | What the table keeps |
|---|---|---|
| The Claude API | [platform.claude.com, model deprecations](https://platform.claude.com/docs/en/about-claude/model-deprecations) | Deprecated and retired models, with their retirement dates and replacements |
| The OpenAI API | [developers.openai.com, deprecations](https://developers.openai.com/api/docs/deprecations) | Every chat, text and computer use model's shutdown date, snapshots with the aliases the page names |
| The Gemini API | [ai.google.dev, deprecations](https://ai.google.dev/gemini-api/docs/deprecations) | Gemini 3, 2.5 and 2.0 shutdown dates |
| Vertex AI | [cloud.google.com, model versions](https://cloud.google.com/vertex-ai/generative-ai/docs/learn/model-versions) | Gemini models with a set retirement date, and retired ones |
| Amazon Bedrock | [docs.aws.amazon.com, model lifecycle](https://docs.aws.amazon.com/bedrock/latest/userguide/model-lifecycle-legacy.html) | Text models' end-of-life dates, by the Regions each covers |

- **The Claude API.** "Not sooner than" dates for active models set no date, and are left out. The table also keeps the page's note on `temperature`, `top_p` and `top_k`, and from [extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking), the models that refuse a manual thinking budget.
- **The OpenAI API.** From the [Chat Completions reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create), it keeps that the o-series take `max_completion_tokens`.
- **The Gemini API.** Google gives the dates as the earliest a model may shut down.
- **Vertex AI.** An "or later" date sets none. From [partner model deprecations](https://cloud.google.com/vertex-ai/generative-ai/docs/deprecations/partner-models), it keeps Claude and Jamba models with their shutdown dates.

### How a call is matched

- **A call is judged by the platform that served it**: a Claude model called through Bedrock has Bedrock's date, and one called through Vertex AI Google's, not Anthropic's.
- **An Anthropic alias** (`claude-sonnet-4-5`, `claude-3-7-sonnet-latest`, `claude-sonnet-4-0`) matches the one dated snapshot it names.
- **A Vertex AI version** matches the model the page lists: `gemini-2.0-flash-001` is `gemini-2.0-flash`, `claude-3-7-sonnet@20250219` is `claude-3-7-sonnet`.
- **OpenAI's aliases** match only where the page names them. Where a row retires a model by its name with its snapshots (*GPT-4o (gpt-4o-2024-08-06, gpt-4o-2024-11-20)*), the model's alias (`gpt-4o`) goes with it, and the row keeps the page's words. Where the page retires older snapshots only (*older GPT-5 and o3 model snapshots*), the alias stays.
- **Left out**: models that hold no conversation (embeddings, images, speech), and Azure OpenAI, since a call names its deployment, which can serve any model.

## In CI

```sh
shadowlap decisions goldens/* --from-code --strict
```

On a pull request, this previews the prompt and tools the branch sends against the goldens, and sends only the requests the change touches. It exits 1 when a golden's writes, stops or judged answers change.

It asks the model, so the job needs the provider's key as a secret, as a live `verify` does. `--budget` caps what it spends, and `--inconclusive warn` lets a preview that couldn't settle (the budget ran out) pass with a warning. `--json` prints the report the dashboard reads, with the same fields for a coding agent ([the reference](./cli.md#decisions)).

## Flags

These are the flags this page covers. [The CLI reference](./cli.md#decisions) lists every one, and the JSON report's fields.

| Flag | What it does | Default |
|---|---|---|
| `--model <model>` | The change is this model ([the change](#the-change)) | — |
| `--set <key=value>` | The change sets this request field | — |
| `--from-code` | The change is the prompt and tools your working tree sends ([the prompt your code sends](#the-prompt-your-code-sends)) | — |
| `--from <model>` | Change only the calls made with these models ([a switch is the agent's](#a-switch-is-the-agents)) | The model the runs use most; with `--set` alone, every call |
| `--scope <name>` | Ask only the calls made in this scope; `none` for those made in no scope | — |
| `--samples <n>` | Ask each step *n* times under the change, and *n* times as recorded ([samples](#samples-and-the-control)) | 3 |
| `--concurrency <n>` | The requests in flight | 4 |
| `--budget <usd>` | Stop once this much is spent, judging included | — |
| `--then-verify` | Verify the runs a preview can't clear ([then verify](#then-verify)) | — |
| `--verify <session>` | Verify the runs a kept session could not clear, asking nothing again | — |
| `--expect`, `--gate`, `--attempts`, `--passes` | With `--then-verify` or `--verify`: as for [`verify`](./verify.md) | — |
| `--strict` | Exit 1 when a run has a rank 1 or 2 change, for CI | — |
| `--inconclusive fail\|warn` | What a result that settles nothing does: `warn` lets it pass with a warning | `fail` |
| `--json` | Print the report as JSON on stdout | — |

## Exit status

|  Status | Meaning                                                                                     |
| ------: | ------------------------------------------------------------------------------------------- |
|       0 | Every run was asked                                                                         |
|       1 | `--then-verify` or `--verify` rejected the change, or `--strict` found a rank 1 or 2 change |
|       2 | A refusal before anything is asked, such as no credentials or no such run                   |
|       3 | The result settles nothing, unless `--inconclusive warn`                                    |
| 128 + n | A stop signal: 130 for Ctrl-C                                                               |

## Limits

- Later steps are judged in the recorded state, as above.
- A step whose recorded call failed, or that isn't a conversation (an embeddings call), is not asked, and the report says why.
- `--from-code` sees the prompt and tools; a change to anything else the requests carry is verify's.
- A switch to a model of another family is verify's: the recorded request can't be asked of it as it stands.
- A Responses request that continues a stored response (`previous_response_id`) is asked with the turns the provider holds for it, as recorded.
- An agent that thinks between its tool calls has its earlier reasoning left out under a changed prompt, as above. A provider that still wants it back refuses such a step, which is listed with the provider's words, not ranked.
- Text-only changes are counted, not judged, unless a judge check reads them, as above. The words of a step a later request carries are counted, and so are those of a run that did not complete.
- Each session is kept in the store with each run's decisions, for the dashboard. `gc` leaves sessions, which outlive the runs they name.

## See also

- [Verify](./verify.md): run the change end to end on the runs decisions flags.
- [Judge checks](./checks.md#judge-checks): the checks that rank a text-only change.
- [Gating](./gating.md): the gate `--then-verify` and `migrate` decide each run by.
- [`shadowlap decisions`](./cli.md#decisions) and [`shadowlap migrate`](./cli.md#migrate) in the CLI reference: every flag, exit status and JSON field.
