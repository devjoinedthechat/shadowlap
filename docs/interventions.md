# Interventions

A replay forks at the first request that changes. Editing the system prompt changes every request, so a plain replay forks at call 1 and saves nothing. Interventions change *one* thing at *one* point, so everything before it still replays for free, and `--prompt-from` does the same for a prompt you edited in your code.

Each intervention is classified by what it does to the conversation prefix that [thinking blocks](./how-it-works.md#thinking-blocks) are bound to. The ones below never edit recorded history, so replayed turns stay valid on models that check.

## Override a tool result

```sh
shadowlap replay <run> --override 9='{"results":[]}'
shadowlap replay <run> --override 9=@fresh.json
```

Tool call 9 is served with your result instead of the recorded one (origin `overridden`). The agent builds its next request from it, so the run forks at the first model call that sees the new result, and the divergence diff shows exactly that change inside the request. Only tool calls can be overridden; the CLI checks the call number against the recording.

This is the cleanest "what if": nothing before call 9 changes, and no history is edited.

## Inject an instruction

```sh
shadowlap replay <run> --inject 15="Prefer sources from 2026."
shadowlap replay <run> --inject 15="…" --inject-as user
```

At model call 15 the sidecar appends a `role: "system"` message to the request, and re-inserts it at the same message position in every later request of the fork, so the conversation stays consistent from the model's point of view. Calls 1–14 replay; 15 onward run live. This is the mechanism the API documents for changing instructions mid-session, and it is append-only. On models without mid-conversation system messages (Sonnet 5), `--inject-as user` appends the text as a block of the last user message instead, likewise kept in place.

It is the closest thing to "rewind to step 15 and change the prompt" that the API permits: an addition at step 15, not a change to what steps 1–14 saw. The report says so.

## Apply a changed prompt from a later call

```sh
# edit the system prompt or the tools in your code, then:
shadowlap replay <run> --prompt-from 17
```

Model calls before 17 are matched without their system prompt and tool definitions, so they replay from the recording even though your code now sends a different prompt. Model call 17 runs live, and from there the model sees your new prompt with the recorded conversation before it. You pay for the calls from 17 on, not for the whole run, and the diff before 17 still catches anything else that changed.

Read the result as "what if the prompt had been this from step 17": the steps before it were answered under the old prompt. It suits a change aimed at a late step, such as how the agent summarizes or when it emails. A change that would have altered the early steps needs a full replay.

- `--prompt-from` takes a model call number; `shadowlap show` lists them. Pair it with `--repeat` to see whether the new prompt settles the behavior.
- The system prompt means Anthropic's and Bedrock's `system`, OpenAI's system and developer messages and Responses `instructions`, and Gemini's `systemInstruction`. The tool definitions mean `tools` and Bedrock's `toolConfig`.
- If the model calls before 17 produced reasoning (thinking blocks), they reach the model again under a different prompt. The CLI warns you before it starts. A provider that binds reasoning to the prompt it was produced under may refuse call 17; if one does, the error is recorded at call 17, and you can fork from a call before the first reasoning.

## Patch parameters

```sh
shadowlap replay <run> --set 15:max_tokens=2048 --set 15:temperature=0
shadowlap replay <run> --model 15:claude-opus-5
```

Top-level request fields are set from model call 15 on. Fields outside `system`, `tools` and `messages` are not bound by thinking-block validation. A model switch is allowed; the new model drops the earlier model's thinking blocks silently, so the fork's early turns lose that reasoning (no error).

## Force a tool live

```sh
shadowlap replay <run> --live-tool search_web
shadowlap replay <run> --diverge-at 12
```

After you fix a tool, its call key is unchanged (arguments identical), so it would keep replaying its old result. `--live-tool` forces the first call of that tool live; the run forks there. Shadowlap also warns when a tool's source hash differs from the recording, so you don't forget.

## Inject a failure

```sh
shadowlap replay <run> --fail-at 12=429      # rate limited
shadowlap replay <run> --fail-at 12=529      # overloaded
shadowlap replay <run> --fail-at 3=400 --fail-at 12=500
```

Answers model call *n* with an HTTP failure instead of the recording. Error handling is one of the
things a replay exercises for free — and the one thing no recording of a healthy run contains, so
without this there is no way to ask what the agent does when a call fails.

Nothing leaves the machine: Shadowlap writes the response itself, so the run makes no upstream
request and spends nothing. The body names Shadowlap as the source, the call is stored as
`injected`, and `show`, the terminal UI and the dashboard label it that way and count it apart from
live calls, so neither the agent's error nor the recording can be mistaken for something the
provider did.

**Every attempt of that call fails.** The official SDKs retry a 429 or a 5xx, and each retry is
answered the same way, so the retry policy runs and then gives up — which is the path worth
testing. "The retry succeeded" is what an ordinary replay already shows.

The run forks at that call, like any other intervention, and the divergence report names the flag.
Only 4xx and 5xx are accepted: the point is to run the agent's own error path, and a made-up status
would exercise neither the SDK's retry policy nor your handling.

In CI, pair it with an [outcome check](./ci.md#outcome-checks) to pin what the agent must do about
it — that it does not send the email, that it does not loop:

```json
{ "tests": { "goldens/triage-inbox": { "expect": { "tools": { "send_email": 0 }, "modelCalls": "<= 14" } } } }
```

## Replay on every save

```sh
shadowlap replay <run> --watch
```

Replays again whenever a file in the project changes, and prints each outcome under a rule. The
prefix before a fork is served from the recording, so re-running after every edit costs nothing and
takes as long as your own code. Generated, hidden and vendored directories are ignored
(`.shadowlap/`, `node_modules/`, `.git/`, `__pycache__`, and anything else beginning with a dot), so
Shadowlap's own writes don't trigger it, while `dist/` is watched because that is how a TypeScript
change reaches the replay. Ctrl-C stops. Not combinable with `--repeat`, which already re-runs.

## Repeat a fork

Every intervention above forks the run, and everything after the fork is live. Add `--repeat 5` to run it five times and see whether the change settles the behavior or one attempt got lucky; see [repeating a fork](./cli.md#repeating-a-fork).

```sh
shadowlap replay 01K5CQ4N7G --inject "15=Prefer sources from 2026." --repeat 5 --concurrency 5
```

## Find where to intervene

Every intervention needs a call number. When you don't know which call went wrong, [`shadowlap blame`](./blame.md) finds it: the last model call whose answer, asked again, lets the run pass, with what the model answered there in the recording and in a fork that passed.

## From the terminal UI

`shadowlap ui <run>`, select a call, press `:`. The actions palette offers every intervention that applies to the selected call, asks for the one line of input it needs, runs the CLI, and opens the run it created. See [Terminal UI](./tui.md). The dashboard offers the same list under **Fork at #n**; see [Dashboard](./dashboard.md#actions).

## Not offered

- **Editing a recorded assistant turn.** It would put words in the model's mouth that later recorded turns, and any reasoning bound to them, never followed from. The append-only interventions above cover the same questions without that. A changed system prompt is different: `--prompt-from` applies it from a later call and leaves what earlier calls saw as it was.
- **Replaying a model response the model never produced.** By design: replay serves recorded data, and everything after a change is new data.
- **Making a *tool* fail.** `--fail-at` answers a model request, because that is where the sidecar sits. A tool's result comes back through the SDK's resolution API, which has no shape for "this call fails for a reason nobody recorded" — adding one would mean either a new call origin across the store, the pack format and both UIs, or dressing an injected failure up as a replayed one. Until that is worth it, a tool that must fail can raise on its own: the recording will hold the error, and every replay will serve it.
