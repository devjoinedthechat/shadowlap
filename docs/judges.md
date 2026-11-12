# Judge checks

A judge check asks a model a question about a run: does the reply tell the customer why the refund was escalated, does the answer name its sources. The judge's call goes through the sidecar like any model call, so it is recorded in the run. This page covers how a judge is asked, what it reads, and how its verdicts are kept and reported.

A clean replay asks the same question about the same material and gets the recorded verdict back: free, and the same verdict every time. Only a run whose material changed, a fork, asks the judge again, and that call is recorded too. That keeps a quality gate inside `shadowlap test`, with no second tool to run and no verdict that drifts between two runs of the same golden.

```json
{
  "tests": {
    "goldens/research": {
      "expect": {
        "judge": [
          {
            "name": "summarizes",
            "question": "Does the answer say what was found?",
            "of": "answer",
            "model": "claude-haiku-4-5",
            "pass": "yes"
          }
        ]
      }
    }
  }
}
```

A judge check has these fields:

| Field      | Meaning                                                                          | Default  |
|------------|----------------------------------------------------------------------------------|----------|
| `name`     | The check's name: what its verdicts are kept under, unique within its `expect`   | —        |
| `question` | What the judge is asked, to be answered yes or no                                | —        |
| `of`       | What the judge reads: `answer`, `output` or `run` ([below](#what-a-judge-reads)) | `answer` |
| `model`    | The judge's model, by its name or with its provider before it                    | —        |
| `pass`     | The answer that passes: `yes` or `no`                                            | `yes`    |

`model` takes `claude-…`, `gpt-…` or `o3`, `o4-…`, and `gemini-…` by name. Any other model takes its provider before it, `anthropic:`, `openai:` or `gemini:`, as an OpenAI-compatible server's own names do (`openai:qwen2.5-7b`).

A judge check sits under `expect` beside the [other checks](./ci.md#outcome-checks), and works wherever they do: `shadowlap test`, `replay`, `blame`, `verify` and `repair`, and `--expect '{"judge":[…]}'`.

## Recorded once, judged free after

`shadowlap pack` judges a golden once, live, and keeps the judge's call in the pack:

```text
$ shadowlap pack 01M58VCQ8Q goldens/research
judged 1 check for the pack (1 call · 1 live (<$0.001) · 1 upstream request):
  ✓ judge "summarizes" answers yes · It says runs replay exactly. (judged live, <$0.001)
packed 1 run (31 calls, 81 blobs) to goldens/research
```

Every test of it after that is offline and free. The replay sends the judge the same request, and the recording answers it:

```text
$ shadowlap test goldens/research
✓ research: 30/30 replayed, 12.3k input tokens not re-spent, 1 check passed
    ✓ judge "summarizes" answers yes · It says runs replay exactly. (judged from the recording, free)

1 passed, 0 failed · 0 upstream requests
```

### When a judge is asked live

- **A golden that may fork** (`"fork": true`) asks the judge live wherever what the judge reads changed, and its replay keeps the call. The judge reads what the fork did, so a prompt fix is judged on the reply it gives.
- **An attempt that failed another check** fails whatever the judge says, so `shadowlap test` and `bisect` of a golden that may fork, and `bisect --fork`, don't ask the judge there. The judge check reads not applicable, `not asked: another check failed`, with no call and no cost. Where no attempt got that far, the golden's result reads `not asked: no attempt passed its other checks`.
- **A replay** (`shadowlap replay`, with the checks of the golden it came from or `--expect`) is judged the same way: from the recording when it asks what the recording asked, live when what the judge reads changed.
- **Blame, verify and repair** fork every attempt, so an attempt asks the judge live unless its recording holds the very same request. What that costs is reported apart from the agent's cost (`judge` in their JSON, and on their cost line), and counts against `--budget`.
- **A judge no attempt can ask live** (no key for its provider, and no upstream set for it) is refused before anything runs, since every attempt would read inconclusive.

### In the decision diff

The decision diff ([`decisions`](./decisions.md#text-a-judge-check-reads) and `migrate`) asks a check that reads a text-only change's words about the recorded words and the changed ones. The recorded words' verdict comes from the golden's own judge call, free. Each other request is asked once and kept with the session, so asking it again from the same store is free.

A check that comes out otherwise ranks the step 2 and flags its run, which `--then-verify` and `migrate` verify end to end. One it could not judge leaves a run nothing else flags inconclusive.

### Output, and runs that didn't complete

- **A check on the output** can't be judged when packing: a recording keeps no output, so `pack` says so, and `test --update` records its verdict from what a replay prints.
- **A run that didn't complete** (its agent exited with an error, or it was interrupted) is not judged by `pack`: no replay of it is judged either, so a verdict would never be read. Nor does the decision diff judge its text-only changes: it fails its checks whatever a judge says.

### Add a verdict with test --update

`test --update` re-records a golden that diverged, its judge checks with it, from the old golden when the answer didn't change. A golden that replayed clean but holds no verdict for a check gets that verdict asked live and added to its recording, so its pack carries it. That happens for a check added after it was packed, or one that reads the output:

```text
$ shadowlap test goldens/research --update
? research: check inconclusive: judge "sources" answers yes, but not judged: no recorded verdict and the test runs offline
    …
    ↻ keeping the verdict of sources in goldens/research: asking the judge live
      ✓ judge "sources" answers yes · It names the docs it read. (judged live, <$0.001)
      kept in goldens/research · judge: 1 call · 1 live (<$0.001) · 1 upstream request; review the change in your pull request
✓ research: 30/30 replayed, 12.3k input tokens not re-spent, 2 checks passed (judged)
```

A golden keeps its run id when it gains a verdict. A teammate's store that holds the golden from before takes in the judge's calls from the updated pack, as the same recording.

## Not judged

A check is not judged when the recording doesn't hold its verdict and the judge can't be asked live: the test runs offline, or there is no key for its provider. It reads *inconclusive* and says why, and it never passes. Nothing is sent, and nothing of the call is kept: a run, and a pack of it, only ever hold judge calls that were answered.

```text
? research: check inconclusive: judge "sources" answers yes, but not judged: no recorded verdict and the test runs offline
    ✓ judge "summarizes" answers yes · It says runs replay exactly. (judged from the recording, free)
    ? judge "sources" answers yes: inconclusive · not judged: no recorded verdict and the test runs offline
    ✓ Replay clean: 30/30 calls replayed (11 api, 17 tool, 2 clock/random), 0 upstream requests, 12.3k input tokens not re-spent (≈$0.072)
      judge: 1 call · 1 from the recording, free · 0 upstream requests

0 passed, 0 failed, 1 inconclusive (failing the run: --inconclusive warn lets them through) · 0 upstream requests
```

A golden whose only checks that did not pass are inconclusive ones is itself *inconclusive*, not failed: the agent failed no check. It is marked `?` in amber, counted apart, and fails the run all the same (exit status 3) unless `--inconclusive warn` lets it through. Elsewhere:

- the JSON report gives it `verdict: "inconclusive"` and the failure kind `inconclusive`;
- the Runs list shows the run as *inconclusive* in amber;
- blame refuses it (`inconclusive`): no probe could pass a check that can't be decided as recorded;
- the GitHub Action's fix on failure skips it, saying how to record the verdict.

### Record the verdict

Record the verdict with `shadowlap test <golden> --update`, or pack the golden again with a way to ask the judge.

`shadowlap doctor` names what can't be judged:

- **each golden that holds no verdict** for a judge check that applies to it, with that command. A judge under a [`when`](./checks.md#conditions) whose condition never held in the golden is not applicable there, and needs none.
- **each judge check whose provider has no key** in the environment (and no upstream set for it), so nothing can ask it live.

### When the recording's verdict doesn't fit

The recording may hold a verdict for the check's question that doesn't answer the request a replay sends. The reason then says which of these it is:

- `the recording's verdict was given on other material: it read "…" where it now reads "…"`: what the judge would read changed, at the line shown. A value that changes every run and that no normalizer masks (an id the agent prints, say) does this: add a [normalizer](./normalizers-and-redaction.md#normalizers) for it, then `--update`.
- `the recording's verdict was given to an older form of the judge's request`: Shadowlap changed what it sends a judge since the verdict was recorded. `--update` asks again.

### Other reasons

A check is also not judged, with the reason, when:

- the agent exited with an error or was stopped;
- the replay of a golden that may not fork diverged (the test fails on that anyway);
- the judge's call failed;
- its answer held no verdict.

A run that can't pass anyway asks no judge: one whose agent exited with an error or was stopped, or whose replay diverged where its golden may not fork. In `shadowlap test` and `bisect` of a golden that may fork, or with `bisect --fork`, an attempt that failed another check asks none either, and its judge checks read not applicable, not inconclusive.

### Keys and upstreams

A judge is asked live with its provider's key from the environment:

| Provider  | Key variables                                                        |
|-----------|----------------------------------------------------------------------|
| Anthropic | `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`                        |
| OpenAI    | `OPENAI_API_KEY`                                                     |
| Gemini    | `GEMINI_API_KEY`, `GOOGLE_API_KEY` or `GOOGLE_GENERATIVE_AI_API_KEY` |

An upstream set for its provider (`SHADOWLAP_UPSTREAM_ANTHROPIC`, or the SDK base URL a run would use) takes it there, key or no key, as it takes the agent's calls.

A model under test never answers one. [`tasks score`](./training.md#scoring-a-model) sends the agent's calls to the model it scores, and the judge's to the judge. It reports what the judge's calls cost apart from each attempt's (`judge`), counting them against `--budget`.

## What a judge reads

| `of` | The judge reads |
|---|---|
| `answer` | The text of the agent's last model response, as the model gave it |
| `output` | What the agent printed on stdout |
| `run` | Each conversation the agent had with its model, as the model read it, then the tool calls no model asked for |

A recording keeps no output, so `pack` can't judge `output`: its verdict is recorded when the agent runs, with `test --update`.

`run` gives each conversation as the model read it: the system prompt, the messages, each tool it called with its effect and arguments, and what the tool returned. Then come the tool calls no model asked for.

### Redaction and size

The project's [redaction rules](./normalizers-and-redaction.md#redaction) apply to what the judge reads, as they apply to a pack (to plain output, the rules with no path, kind or name). The report says how many applied, and the judge is told the masked values read as their replacement.

What a judge reads has these limits:

| Limit                                 | Size                                            |
|---------------------------------------|-------------------------------------------------|
| What it reads                         | At most 100,000 characters, about 25,000 tokens |
| A single system prompt or tool result | Cut at 4,000                                    |

Longer, it keeps the first 20,000 and the last 80,000, says how much it left out, and the report says so too.

### Values that change every run

What a replay's matching looks past is masked in what the judge reads of the run and the output, as the replay masks it before it compares two requests:

1. the project's [normalizers](./normalizers-and-redaction.md#normalizers): in each of the agent's requests and tool calls, and those with no path, kind or name in the output;
2. then the [dates and times](./normalizers-and-redaction.md#dates-and-times) within a day or two of the run's start, which read `<date>`, `<datetime>` or `<epoch>` (unless `"clock": "exact"`).

So a clean replay whose system prompt holds a different ticket time, or that prints today's date, reads byte for byte what its recording read, and is judged from it. The judge is told such values read as their placeholder, and the report says `values that change every run masked`.

The answer is never masked: a clean replay serves the recorded response, so it is the same as it is. A question about one of those values (is the refund dated today?) should read the answer, or the project should match runs with `"clock": "exact"`.

### Content, not ids

The material holds the run's content and nothing of its ids, times or call numbers. Conversations that ran at once are put in order by what they hold, not by which started first. So a clean replay asks byte for byte what its recording asked, which is what lets the recording answer it.

### Instructions in the material

The judge is told the material is data: instructions in it are part of what the agent read or wrote, never something to follow. A run that read a prompt injection can still be judged. The material can't end its own block: every closing tag in it, whatever its case or spacing, is escaped the same way every time.

## The request

One message goes to the judge's model with the question and the material between `<material>` tags, asking for `{"verdict": "yes" | "no", "reason": "…"}`:

- **Temperature 0** wherever the model takes a temperature. Claude Opus 4.7 and the generation 5 models refuse one, as do OpenAI's reasoning models (o1, o3, o4-mini, the gpt-5 family): they are sent none. A verdict from the recording is the same every time either way.
- **As little thinking as the model takes.** A model that thinks by default (the Claude generation 5 models and Fable) is asked for `low` effort, as is every Claude model from the 4.6 generation on; OpenAI's reasoning models are sent `reasoning_effort: "low"`. A yes or no needs no more, and a long run's material never spends the answer's room on thinking.
- **Room for the answer.** A Claude judge's answer may take up to 16,000 tokens, its thinking included: a ceiling, not a cost.
- **Structured output.** The verdict's JSON schema goes in the field each provider reads (below). Never a forced tool call, which current Claude models refuse.
- **Retried on a failure that may pass.** A rate limit, an overloaded provider or a dropped connection is retried twice, as the providers' SDKs retry, and the run keeps the attempts as one call. A failure that persists is a check not judged.
- **A refusal** reads `the judge declined to answer`: ask another model.
- **One call per check**, one after another.

The verdict's schema goes in:

| Provider             | Field                  |
|----------------------|------------------------|
| Claude 4.1 and later | `output_config.format` |
| OpenAI               | `response_format`      |
| Gemini               | `responseSchema`       |

The verdict is read from the answer's text, in a code fence or a sentence too.

Each check's request is kept with the check's name, a digest of what it asks (its question, what it reads, its model), and the version of the request Shadowlap sends. So a renamed check still finds its verdict, a changed question never reads an old one, and a verdict recorded before Shadowlap changed what it sends a judge says so.

## Matched byte for byte

A judge's verdict answers the request it was given, and nothing else. A replay serves a recorded verdict only for the very request the recording holds, compared byte for byte: none of the normalizers and none of the date masking the agent's calls are matched under apply to it.

What the judge reads already has them applied ([above](#what-a-judge-reads)), so a clean replay still asks what its recording asked. A fork whose answer differs in any way, a date the normalizers would mask included, asks the judge live.

The one thing a judge's request is compared under is the redaction rules a pack applied to it. A pack applies the rules without a path to a judge's request, as to every string it copies, and a replay of the pack masks the request it sends the same way before it compares the two.

A rule with a path never reaches a judge's request, in a pack or a replay. It names a place in the agent's requests (`$.system`), which in a judge's request would be its instructions or its whole question, and what the judge read already had it applied.

Nothing is matched fuzzily because of a judge: the agent's calls are matched as they always are, and a judge only judges the outcome.

## Never the agent's calls

A judge's calls are made in the scope `shadowlap:judge`. They are recorded in the run like any model call, and they are none of the agent's:

- **Replay strictness leaves them out.** A judge call never forks a replay, never counts as replayed, and a recorded one that wasn't asked again is no call the agent left out, so a replay never [ends early](./ci.md#a-replay-that-ends-early) on one. A missing judge call means "ask the judge live", not "the agent changed".
- **Nothing that measures the agent counts them.** Their own part is summed apart, as `judge` (below).
- **No flag names one.** `--fail-at`, `--set`, `--model`, `--inject` and `--prompt-from` refuse a judge's call by name and count the agent's model calls only; no flag rewrites a judge's request or forces it live.
- **Only Shadowlap makes them.** The scope takes a token no agent's environment holds, and any scope under `shadowlap:` is refused to an agent's call: name the agent's scopes another way.

What measures the agent, and leaves a judge's calls out:

- the run's summary: calls by origin, upstream requests, tokens, cost;
- `modelCalls`, and token and cost budgets;
- the final answer an `answer` check reads;
- blame's and repair's steps, and verify's footprints;
- `replay --repeat`'s paths and final answers;
- the prompt cache's hit rate, and the providers a run used.

## In the reports

Each verdict and its reason are beside the check wherever checks are shown:

- the terminal, passing goldens too;
- the JUnit report;
- the Markdown summary, with a line of what the judges cost, apart from the agents;
- GitHub annotations;
- the JSON.

A check's JSON entry has `status` (`passed`, `failed`, `inconclusive` or `not-applicable`), the judge's `reason`, `source` (`recording` or `live`), and `judge`:

| Field        | Type           | Meaning                                                      |
|--------------|----------------|--------------------------------------------------------------|
| `name`       | string         | The judge check's name                                       |
| `model`      | string         | The judge's model                                            |
| `of`         | string         | What it read: `answer`, `output` or `run`                    |
| `verdict`    | string or null | `yes`, `no`, or `null` when it was not judged or not asked   |
| `source`     | string or null | `recording` or `live`, or `null` without a verdict           |
| `cost`       | number or null | USD: 0 from the recording, `null` for a model with no price  |
| `redactions` | number         | How many redaction rules applied to what it read             |
| `normalized` | boolean        | Whether what it read had values that change every run masked |
| `cut`        | number         | Characters of what it read that were left out                |
| `callNo`     | number         | The judge's call in the run                                  |

Other reports carry `judge`, what the judges did and cost:

| Report | Its `judge` |
|---|---|
| A run's summary, and a golden's result in `test --json` | `calls`, `replayed`, `live`, `notAsked` (judge calls nothing could answer, not checks skipped beside a failed one), `upstreamRequests`, `spent`, `saved`, `unknownModels` |
| `blame` and `verify` JSON | `spent`, `upstreamRequests`, or `null` |
| `repair` JSON | Under its `cost` |
| `tasks score` | For each attempt, each task and the whole score, as a run's summary has it |

A golden's result has its `verdict`, and the report counts the `inconclusive` ones. The [CLI reference](./cli.md#test) lists them.

The store keeps them: each run's checks with their verdicts, and each golden's result in the test history with its verdict and what its judges cost. Every export, pack and share link of a run masks a judge's reason with the project's redaction rules, as it masks the check's label and detail, and `redact preview` counts it.

## Limits

- **A judge is a model, so it can be wrong.** Read its reasons. Across fork attempts, `repeat` and `passes`, or a [gate](./gating.md), decide how many verdicts must pass.
- **A judge only judges what it reads.** For order, arguments and counts, the other checks are exact and free; a judge is for what they can't say, such as whether a reply explains itself. What the normalizers and the date masking hide from the run and the output, it doesn't see.
- **The verdict is the recording's.** A clean replay is judged on the material its recording had. So changing what a judge reads (its question, its model, the redaction rules, the normalizers) asks it live again, or reads not judged offline until the golden is updated.
- **Its model retires too.** `shadowlap doctor` names a judge whose model its provider retires, by the [retirement table](./decisions.md#model-retirements) that ships with Shadowlap, with what to ask instead. Give the check another model and record its verdicts again with `test --update`. The retirement notices on recordings leave a judge's calls out: they are no model the agent uses.
- **Providers.** A judge is asked through Anthropic, OpenAI or Gemini (or a server that speaks one of their APIs, through `SHADOWLAP_UPSTREAM_*`), not through Bedrock, Vertex AI or Azure.

## See also

- [Checks](./checks.md#judge-checks): every kind of check, and how a check comes out.
- [CI mode](./ci.md#outcome-checks): goldens and their checks under `tests`.
- [Normalizers and redaction](./normalizers-and-redaction.md): what is masked in what a judge reads.
