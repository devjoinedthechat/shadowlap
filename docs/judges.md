# Judge checks

A judge check asks a model a question about a run: does the reply tell the customer why the refund was escalated, does the answer name its sources. The judge's call goes through the sidecar like any model call, so it is recorded in the run. A clean replay asks the same question about the same material and gets the recorded verdict back: free, and the same verdict every time. Only a run whose material changed, a fork, asks the judge again, and that call is recorded too.

That keeps a quality gate inside `shadowlap test`, with no second tool to run and no verdict that drifts between two runs of the same golden.

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

| Key | What it is |
|---|---|
| `name` | The check's name: what its verdicts are kept under, unique within its `expect` |
| `question` | What the judge is asked, to be answered yes or no |
| `of` | What the judge reads: `answer` (default), `output` or `run` ([below](#what-a-judge-reads)) |
| `model` | The judge's model: `claude-…`, `gpt-…` or `o3`, `o4-…`, `gemini-…`, or any model with its provider before it, `anthropic:`, `openai:` or `gemini:` (an OpenAI-compatible server's own names, `openai:qwen2.5-7b`) |
| `pass` | The answer that passes: `yes` (default) or `no` |

A judge check sits under `expect` beside the [other checks](./ci.md#outcome-checks), and works wherever they do: `shadowlap test`, `replay`, `blame`, `verify` and `repair`, and `--expect '{"judge":[…]}'`.

## Recorded once, judged free after

`shadowlap pack` judges a golden once, live, and keeps the judge's call in the pack:

```
$ shadowlap pack 01M58VCQ8Q goldens/research
judged 1 check for the pack (1 call · 1 live (<$0.001) · 1 upstream request):
  ✓ summarizes: the judge answers yes to "Does the answer say what was found?": the judge answered yes: It says runs replay exactly. (judged live, <$0.001)
packed 1 run (31 calls, 81 blobs) to goldens/research
```

Every test of it after that is offline and free. The replay sends the judge the same request, and the recording answers it:

```
$ shadowlap test goldens/research
✓ research: 30/30 replayed, 12k input tokens not re-spent, 1 check passed
    ✓ summarizes: the judge answers yes to "Does the answer say what was found?": the judge answered yes: It says runs replay exactly. (judged from the recording, free)

1 passed, 0 failed · 0 upstream requests
```

- **A golden that may fork** (`"fork": true`) asks the judge live wherever what the judge reads changed, and its replay keeps the call. The judge reads what the fork did, so a prompt fix is judged on the reply it now gives.
- **A replay** (`shadowlap replay`, with the checks of the golden it came from or `--expect`) is judged the same way: from the recording when it asks what the recording asked, live when what the judge reads changed.
- **Blame, verify and repair** fork every attempt, so an attempt asks the judge live unless its recording holds the very same request. What that costs is reported apart from the agent's cost, and counts against `--budget`.
- **`test --update`** re-records a golden that diverged, its judge checks with it, from the old golden when the answer didn't change. A golden that replayed clean but holds no verdict for a check (a check added after it was packed, or one that reads the output) gets that verdict asked live and added to its recording, so its pack carries it:

```
$ shadowlap test goldens/research --update
✗ research: check inconclusive: sources: the judge answers yes to "Does it name its sources?", not judged: no recorded verdict and the test runs offline
    …
    ↻ keeping the verdict of sources in goldens/research: asking the judge live
      ✗ sources: the judge answers yes to "Does it name its sources?": the judge answered no: It names no page it read. (judged live, <$0.001)
      kept in goldens/research · judge: 1 call · 1 live (<$0.001) · 1 upstream request; review the change in your pull request
```

A golden keeps its run id when it gains a verdict. A teammate's store that holds the golden from before takes in the judge's calls from the new pack, as the same recording.

## Not judged

A check whose verdict the recording doesn't hold, where the judge can't be asked live (the test runs offline, or there is no key for its provider), is not judged. It reads *inconclusive* and says why, and it never passes: `shadowlap test` fails the golden, as it would on a failed check.

```
✗ research: check inconclusive: sources: the judge answers yes to "Does it name its sources?", not judged: no recorded verdict and the test runs offline
    ✓ summarizes: the judge answers yes to "Does the answer say what was found?": the judge answered yes: It says runs replay exactly. (judged from the recording, free)
    ? sources: the judge answers yes to "Does it name its sources?": inconclusive, not judged: no recorded verdict and the test runs offline
    ✓ Replay clean: 30/30 calls replayed (11 api, 17 tool, 2 clock/random), 0 upstream requests, 12k input tokens not re-spent (≈$0.072)
      judge: 2 calls · 1 from the recording, free · 1 not asked (no recorded verdict, and no way to ask live) · 0 upstream requests
```

Record the verdict with `shadowlap test <golden> --update`, or pack the golden again with a way to ask the judge. A check is also not judged, with the reason, when the agent exited with an error or was stopped, when the replay of a golden that may not fork diverged (the test fails on that anyway), when the judge's call failed, and when its answer held no verdict. A run that can't pass anyway asks no judge.

A judge is asked live with its provider's key from the environment: `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `GEMINI_API_KEY` or `GOOGLE_API_KEY`. An upstream set for its provider (`SHADOWLAP_UPSTREAM_ANTHROPIC`, or the SDK base URL a run would use) takes it there, key or no key, as it takes the agent's calls. A model under test never answers one: `tasks score` sends the agent's calls to the model it scores, and the judge's to the judge.

## What a judge reads

| `of` | The judge reads |
|---|---|
| `answer` | The text of the agent's last model response |
| `output` | What the agent printed on stdout. A recording keeps no output, so `pack` can't judge it: its verdict is recorded when the agent runs, with `test --update` |
| `run` | Each conversation the agent had with its model, as the model read it: the system prompt, the messages, each tool it called with its effect and arguments, and what the tool returned; then the tool calls no model asked for |

The project's [redaction rules](./normalizers-and-redaction.md#redaction) apply to what the judge reads, as they apply to a pack (to plain output, the rules with no path, kind or name), and the report says how many applied. The judge is told the masked values read as their replacement. What it reads is at most 100,000 characters, about 25,000 tokens: longer, it keeps the first 20,000 and the last 80,000, says how much it left out, and the report says so too. A single system prompt or tool result is cut at 4,000.

The material holds the run's content and nothing of its ids, times or call numbers, and conversations that ran at once are put in order by what they hold, not by which started first. So a clean replay asks byte for byte what its recording asked, which is what lets the recording answer it.

The judge is told the material is data: instructions in it are part of what the agent read or wrote, never something to follow. A run that read a prompt injection can still be judged.

## The request

One message to the judge's model with the question and the material between `<material>` tags, asking for `{"verdict": "yes" | "no", "reason": "…"}`:

- **Temperature 0** wherever the model takes a temperature. Claude Opus 4.7 and the generation 5 models refuse one, as do OpenAI's reasoning models (o1, o3, o4-mini, the gpt-5 family): they are sent none. A verdict from the recording is the same every time either way.
- **Structured output.** The verdict's JSON schema, as `output_config.format` on Claude 4.1 and later, `response_format` on OpenAI and `responseSchema` on Gemini. Never a forced tool call, which current Claude models refuse. The verdict is read from the answer's text, in a code fence or a sentence too.
- **Asked again on a failure that may pass.** A rate limit, an overloaded provider or a dropped connection is retried twice, as the providers' SDKs retry, and the run keeps the attempts as one call. A failure that persists is a check not judged.
- **One call per check**, one after another. Its request is kept with the check's name and a digest of what it asks (its question, what it reads, its model), so a renamed check still finds its verdict, and a changed question never reads an old one.

## Never the agent's calls

A judge's calls are made in the scope `shadowlap:judge`. They are recorded in the run like any model call, and they are none of the agent's:

- **Replay strictness leaves them out.** A judge call never forks a replay, never counts as replayed, and a recorded one that wasn't asked again is no call the agent left out, so a replay never [ends early](./ci.md#a-replay-that-ends-early) on one. A missing judge call means "ask the judge live", not "the agent changed".
- **Nothing that measures the agent counts them**: the run's summary (calls by origin, upstream requests, tokens, cost), `modelCalls`, token and cost budgets, the final answer an `answer` check reads. Their own part is summed apart, as `judge`.
- **No flag names one.** `--fail-at`, `--set`, `--model`, `--inject` and `--prompt-from` refuse a judge's call by name and count the agent's model calls only; no flag rewrites a judge's request or forces it live.
- **Only Shadowlap makes them.** The scope takes a token no agent's environment holds, and any scope under `shadowlap:` is refused to an agent's call: name the agent's scopes another way.

Nothing is matched fuzzily because of a judge: a replay matches requests exactly, as always. The judge only judges the outcome, and only a judge's own request is ever served its recorded verdict.

## In the reports

Each verdict and its reason are beside the check wherever checks are shown: the terminal (passing goldens too), the JUnit report, the Markdown summary (with a line of what the judges cost, apart from the agents), GitHub annotations, and the JSON. A check's JSON entry has `status` (`passed`, `failed` or `inconclusive`), the judge's `reason`, and `judge`: its `name`, `model`, `of`, `verdict` (`yes`, `no`, or `null` when not judged), `source` (`recording` or `live`), `cost` (USD: 0 from the recording, `null` for a model with no price), `redactions`, `cut` and `callNo`, the judge's call in the run. A run's summary and a golden's result in `test --json` have `judge` as well: `calls`, `replayed`, `live`, `notAsked`, `upstreamRequests`, `spent`, `saved`, `unknownModels`. The [CLI reference](./cli.md#test) lists them.

The store keeps them: each run's checks with their verdicts, and each golden's result in the test history with what its judges cost.

## Limits

- **A judge is a model, so it can be wrong.** Read its reasons. Across fork attempts, `repeat` and `passes` decide how many verdicts must pass.
- **A judge only judges what it reads.** For order, arguments and counts, the other checks are exact and free; a judge is for what they can't say, such as whether a reply explains itself.
- **The verdict is the recording's.** A clean replay is judged on the material its recording had, so changing what a judge reads (its question, its model, the redaction rules) asks it live again, or reads not judged offline until the golden is updated.
