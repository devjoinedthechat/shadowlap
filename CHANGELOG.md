# Changelog

Entries are grouped by version; the release workflow lifts a version's section into its GitHub release notes.

## 0.1.0

First public pre-release: record, replay and fork AI agent runs.

### Record

- **Model calls at the HTTP layer.** A loopback sidecar records calls to Anthropic, OpenAI and OpenAI-compatible servers (Ollama, vLLM, OpenRouter, Groq) and Gemini, streaming responses byte for byte with per-event timing. No code changes: `shadowlap run` points the official SDKs at it through their base-URL variables, and a base URL the project already sets becomes the upstream. Credentials are forwarded and never stored.
- **Amazon Bedrock, Vertex AI and Azure OpenAI**, whose clients sign requests or fix their endpoint in code, are captured inside Node and Python agents (`fetch`, `http(s)` and `http2`; httpx, requests, botocore and urllib3) and forwarded unchanged, SigV4 signatures and HTTP/2 included. `SHADOWLAP_CAPTURE=off` turns capture off.
- **No time limit of Shadowlap's own** on a call to a provider or a declared HTTP host. A non-streaming request to a slow model, a local one writing a long answer or a reasoning model at high effort, can take more than five minutes to answer; the client's own timeout decides.
- **Tools, clock and randomness** through the TypeScript and Python SDKs. A tool declares its effect (`pure`, `read` or `write`); without Shadowlap running, `tool()` is a passthrough, so wrapped tools ship to production unchanged.
- **HTTP hosts as tools.** `"http": { "*.pinecone.io": "read" }` records calls a client library makes straight to a host, from Node and Python, with that effect.
- **MCP servers** through `shadowlap mcp -- <server>`, a stdio proxy that records, replays and fences `tools/call`, with effects from tool annotations.
- **Framework adapters**, each tested in CI against the real framework: the Vercel AI SDK, OpenAI Agents SDK, Mastra (1.x and 0.x), LangChain/LangGraph and the Anthropic tool runner in TypeScript; Pydantic AI, the OpenAI Agents SDK, LangChain/LangGraph and CrewAI in Python. Framework-injected parameters stay out of the recording.
- **Scopes** for branches that run at once: `scope()` in TypeScript, `with scope():` in Python, or `SHADOWLAP_SCOPE` for separate processes. Repeats are counted per scope, so concurrent sub-agents keep their own recorded answers.
- **`shadowlap init`** finds the model SDKs, framework, agent command and tools in a project, suggests an effect for each tool, warns about a client whose base URL is hardcoded, and prints the steps to a first recording.

### Replay and fork

- **Zero upstream requests on a clean replay.** Calls match by `(kind, fingerprint, occurrence)`, never by arrival order, so parallel calls replay in any interleaving; SDK retries collapse into one call.
- **A fork at the first changed request**, with a structural diff against the closest recorded call and a normalizer hint when the change is a date or an id. After it, model calls and `read` tools run live and `write` tools are blocked or stubbed (`--writes`). A network guard reports or refuses connections that bypass Shadowlap (`--guard warn|block|off`).
- **Fewer false forks.** Dates and timestamps near a run's start match across days (`"clock": "exact"` turns it off), and `shadowlap calibrate` replays offline until clean, proposing a normalizer for each value the agent generates on every run.
- **Interventions**: `--override` a tool result, `--inject` an instruction, `--set` a parameter, `--model`, `--live-tool`, `--diverge-at`, `--prompt-from` for a system prompt changed in code, and `--fail-at` to answer a model call with an HTTP failure. An injected failure is stored and shown as `injected` and sends no upstream request.
- **`--watch`** replays again on every save; **`--repeat n`** runs a fork *n* times and reports the paths the attempts took after the fork and how many different answers the model gave.
- **Partial recordings.** A recording built from traffic captured elsewhere declares the kinds of call it holds; a replay runs every other kind live instead of forking on its absence, and still fences writes.

### Diagnose

- **`shadowlap blame <run>`** finds the model call where a failed run was lost: the last one whose answer, asked again, lets the run pass. It confirms the failure with a free replay, then probes model calls with forks that replay everything before the probed call from the recording, binary-searching for the boundary and scanning a few calls past it. A passing run is one that exits 0 and meets `--expect`, which takes the outcome-check object. A probe resamples the call, or rescues with `--model` or `--set`. It runs `--attempts` times, rescues at `--passes`, and stops as soon as its verdict is settled. Writes are stubbed (`--writes block` to make them throw). The report names the call, the evidence on both sides of it, a confidence, and what the model answered there in the recording and in a fork that passed. It is kept on the run for `shadowlap show`, and printed as JSON with `--json`. `--budget`, `--timeout` and `--concurrency` bound the cost.
- **`shadowlap verify`** checks a change before it ships. It replays the runs the change was written to fix (`--fixes`), failing runs it was not written against (`--holdout`), and runs that worked (`--keeps label:good`) under the code as it is now. The change is accepted only when every failing run is fixed and every good run kept, each by `--passes` of `--attempts`. A replay that forks nowhere settles its run in one free attempt. The change can be in the code, a request field (`--model`, `--set`) or a tool (`--live-tool`). The report warns when held-out or good runs are missing, when a recording contradicts its role, and when a changed tool ran from its recording. It also gives each run's token and cost as recorded and under the change. It exits 1 unless accepted, and prints JSON with `--json`.
- **`shadowlap repair`** fixes failing runs and hands the fix over with its evidence. It blames each run, then asks a repairer you configure for rewrites of the system prompt or a tool description. The repairer is any Claude model through the Anthropic SDK (Claude Opus 5.5 by default), or any Chat Completions API. Only spans that appear exactly once in the source may be rewritten, and a rewrite that names an id, amount or address found only in the failing runs is set aside. Candidates are tried smallest first, in the working tree with a journal that restores it, until `verify` accepts one on the failing runs, runs held out from the repairer and the good runs. A fix may also not grow the input tokens per run past `--max-growth`. When only `--stronger <model>` rescues the runs, switching to it is tried before any repairer. The result is a patch, a pull request body and a recording of each fixed run for `shadowlap test`. `--apply` leaves the fix in the working tree, `--branch` commits it without checking anything out, and `--pr` pushes it and opens a pull request with `gh`. `shadowlap doctor` reports a repair that died with an edit applied.
- **`--repairer claude-code`** asks your own Claude Code for fixes, in print mode with no tools and a JSON schema, from an empty directory and outside any Claude Code session it was started from. Shadowlap never sees how it is signed in.
- **`--scope`** limits blame, and repair's blame, to the model calls of one part of the agent, so a simulated customer, or a planner the fix isn't for, is never blamed. Repair takes `--set` for blame's probes, such as a temperature for an agent recorded at 0.
- **A replay that goes around Shadowlap is never taken for a clean one.** When the recording has model calls and a replay made none through Shadowlap, the agent reached its model some other way, typically a local server Shadowlap was told about when recording and not when replaying. `verify` fails that attempt and says why instead of settling the run on it, `blame` refuses, and `calibrate` names the cause.
- **An experiment on tau2-bench** (`experiments/tau-bench`): record every task of a split, blame the failures, repair them on a dev half with one or more repairers, and verify each repairer's policy, and a placebo, on the test half.

### Test and CI

- **`shadowlap test`** replays committed recordings offline, with JUnit, JSON and Markdown reports and pull request annotations. A Bedrock golden runs without AWS secrets.
- **Outcome checks** in `shadowlap.config.json`: tool calls with counts and arguments, model and tool call counts, token and cost budgets, and text in the output or final answer. A recording marked `fork` may diverge and passes on its checks; `repeat` and `passes` handle models that vary.
- **A GitHub Action** (`uses: devjoinedthechat/shadowlap@main`) that fails the check on a divergence, with the diff in the job summary and on the pull request.
- **Recorded tests**: a pytest plugin (`@pytest.mark.shadowlap`, xdist included) and `@shadowlap/test` for Vitest and node:test. A test records on its first run and replays offline after that; assertions read the tool calls and the final answer. `SHADOWLAP_RECORD` is `missing`, `all` or `none`.

### Imports, exports and data

- **`shadowlap import har · nock · vcr · litellm`** turns a capture into a recording to replay your own code against, with one call identity across formats; `shadowlap.litellm_callback` captures production traffic at a LiteLLM gateway, one run per correlation id. A capture has no command, so its replay takes yours after `--`, and its cost is reported as captured, not spent.
- **Exports**: `pack` (with redaction rules applied), `export html` (a run as one file with the dashboard's views, redacted), `export har`, `export otel` (GenAI semantic conventions) and `export dataset` (JSONL, OpenAI chat, Braintrust, Langfuse).
- **Recordings as data**: labels and notes that travel in packs, full-text search across prompts, responses and tool calls, and `shadowlap diff`, which starts with what changed between two runs (system prompt, tools, model, code).
- **JSON for scripts and coding agents** from `ls`, `show`, `search`, `diff`, `calibrate`, `label` and `test`, `--summary-json` for `run` and `replay`, and a page of instructions for Claude Code, Cursor and Codex.

### Dashboard and terminal UI

- **`shadowlap dashboard`**: runs and their forks, an origin strip, and the calls, turns, context and cache use, timeline and family of a run; the conversation exactly as the model saw it at any call, for Anthropic, OpenAI (Chat Completions and Responses), Gemini and Bedrock; streamed responses played back at their recorded pacing; fork diffs and comparison. Its actions run every intervention, and **Download** saves a run as one redacted file. Loopback only, with a session token, Host and Origin checks, and a strict Content Security Policy.
- **`shadowlap ui`**: the run tree with check results and labels, a timeline with scopes, the inspector, playback, diffs, and an actions palette with every intervention; `o` opens the call in the dashboard.
- **Cost, model and stop reason per call**, from a price table the config can extend.

### Security

- **Packs and captures are untrusted input**: validated before anything is written, hash-checked, refused on symbolic links and oversized files, credentials dropped, header text escaped and bounded. Replaying a pack's command needs consent in the CLI, the terminal UI and the dashboard.
- **Recorded text is escaped** wherever a terminal shows it, stores are readable only by their owner, and a store written by a newer Shadowlap is refused rather than misread.
- **Telemetry** is anonymous and opt-out, and sends nothing until `SHADOWLAP_TELEMETRY_URL` names a collector. The collector, with its public stats page, is self-hostable (Fly.io and Render configs included).

### Built on

- **Open protocols**: the SDK wire protocol and the recordings protocol are specified, with a conformance suite of fourteen scenarios that runs any client against a real sidecar with no API keys. The engine is documented as a library.
- **No external runtime dependencies** in the engine, sidecar, SDKs, adapters or dashboard, and one in the CLI, enforced by a test.
- **Verified** with the official Anthropic, OpenAI and Gemini SDKs against scripted APIs on Linux, macOS and Windows; the frameworks weekly against their latest releases; a real model through Ollama weekly ([examples/local-model](examples/local-model)); every package installed from a local registry before release; and a sidecar overhead of 0.25 ms p50 per live call on an idle machine.
- `shadowlap doctor`, `rm` and `gc`, and docs built into the landing page, including a comparison with cassettes, tracing platforms, framework time travel and durable execution.
