# Changelog

Every notable change to Shadowlap is listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The release workflow lifts a version's section into its GitHub release notes.

## [Unreleased]

The first release: record, replay and fork AI agent runs, find the call that lost a run, and prove a fix before it ships.

### Added

#### Record

- **Model calls at the HTTP layer.** A sidecar on 127.0.0.1 records calls to Anthropic, OpenAI and OpenAI-compatible servers (Ollama, vLLM, OpenRouter, Groq) and Gemini, streaming responses byte for byte with their timing. `shadowlap run` points the official SDKs at it through their base-URL variables, so model calls need no code changes. Credentials are forwarded and never stored.
- **Amazon Bedrock, Vertex AI and Azure OpenAI**, whose clients sign requests or fix their endpoint in code, are captured inside Node and Python agents and forwarded unchanged, signatures and HTTP/2 included.
- **Tools, clock and randomness** through the TypeScript and Python SDKs. A tool declares its effect, `pure`, `read` or `write`; outside Shadowlap the wrapper is a passthrough, so it ships to production unchanged.
- **HTTP hosts as tools.** Hosts declared under `http` in `shadowlap.config.json`, such as a vector database or an internal API, are recorded as tool calls with an effect, from Node and Python.
- **MCP servers** behind `shadowlap mcp -- <server>`, a stdio proxy that records, replays and fences `tools/call`, with effects from the tools' annotations.
- **Framework adapters**, each tested against the real framework: the Vercel AI SDK, OpenAI Agents SDK, Mastra, LangChain and LangGraph and the Anthropic tool runner in TypeScript; Pydantic AI, the OpenAI Agents SDK, LangGraph and CrewAI in Python.
- **Scopes** for parts of an agent that run at once, so concurrent sub-agents keep their own recorded answers.
- **`shadowlap init`** finds a project's model SDKs, framework, agent command and tools, suggests an effect for each tool, warns about a client that bypasses the sidecar, and prints the steps to a first recording.
- **`shadowlap doctor`** checks Node and its SQLite, the guard preloads, Python, the store and the configuration, and gives the fix for each problem it finds.

#### Replay and fork

- **A clean replay makes no upstream requests.** Calls match by what they ask, `(kind, fingerprint, occurrence)`, never by the order they arrive in, so parallel calls replay in any order.
- **A fork at the first changed request**, with a structural diff against the closest recorded call and a normalizer hint when the change is a date or an id. After it, model calls and `read` tools run live and `write` tools are blocked or stubbed (`--writes`). A network guard reports or refuses connections that bypass Shadowlap (`--guard`).
- **Fewer false forks.** Dates and times near a run's start match across days, and `shadowlap calibrate` replays offline until clean, proposing a normalizer for each value the agent makes anew on every run.
- **What-ifs at call *k*:** `--override` a tool result, `--inject` an instruction, `--set` a request field, switch the `--model`, force a tool live (`--live-tool`) or a call (`--diverge-at`), apply a changed prompt from a later call (`--prompt-from`), and answer a model call with an HTTP failure (`--fail-at`), which sends nothing upstream.
- **`--repeat n`** runs a fork *n* times and shows the paths the attempts took; **`--watch`** replays again on every save.
- **The decision diff.** `shadowlap decisions` asks each recorded model call again with only a change swapped in (a model, a request field, or the system prompt and tools the working tree sends) and ranks what the model decides differently by consequence, a changed write first, with no tool run. `shadowlap migrate --to <model>` does it for a model a provider retires, verifies the runs whose writes change, compares the cost per run and says what to set; the providers' retirement dates ship with their sources, and nothing calls home.
- **Partial recordings.** A run imported from a capture holds only model calls; a replay runs everything else live, with writes still fenced.

#### Fixes

- **`shadowlap blame`** finds the model call that lost a failed run: the last one whose answer, asked again, lets the run pass. It probes with forks that replay everything before the probed call, halving the run each time, and reports the call, a confidence, and what the model answered there in the recording and in a fork that passed. `--scope`, `--model`, `--set`, `--budget` and `--json`.
- **`shadowlap verify`** accepts a change only when the failing runs it was written for are fixed, failing runs held out from it are fixed too, and the good runs still pass, each over several attempts. A replay that forks nowhere settles its run in one free attempt. It exits 1 unless it accepts, and reports each run's token and cost change.
- **`shadowlap repair`** blames the failing runs, asks a repairer you choose for rewrites of the system prompt or a tool description, and keeps the smallest rewrite verify accepts, including on failing runs the repairer never saw. A repairer is any Claude model through the Anthropic SDK, any Chat Completions API, or your own Claude Code (`--repairer claude-code`). The fix comes as a patch, a pull request body and a recording of each fixed run; `--apply`, `--branch` and `--pr` hand it over.
- **Outcome checks** say what a passing run does (`--expect`, or `tests` in the config): tools that must or must not be called and with what arguments, call counts, token and cost budgets, and text in the output or the final answer.
- **Checks on order, conditions and earlier calls' values.** A `calls` rule says what every call of a tool comes after and what its arguments must be, against a value read from an earlier call (`"amount": {"<=": "@lookup_order.result.total"}`); a `when` rule applies checks once a call met a condition. Each check comes out passed, failed, inconclusive or not applicable, and a pass never rests on a value that was not there. `shadowlap check` tries a check on the recordings at no cost, and `doctor` names a misspelt tool or value.
- **Judge checks** ask a model a yes-or-no question about a run. The judge's call is recorded like any model call, so a golden is judged once when it is packed and every clean replay after is judged from the recording, free and the same every time; a fork asks the judge live, and its cost is reported apart from the agent's.
- **Gates with stated error rates.** verify decides each run, and blame each probe, by a sequential test between two pass rates as attempts come in, instead of a fixed count.

#### Tests and CI

- **`shadowlap test`** replays committed recordings offline and fails on a divergence, a live call, a non-zero exit or a failed check, with JUnit, JSON and Markdown reports and pull request annotations. A recording marked `fork` may diverge and passes on its checks, repeated when a model varies.
- **A GitHub Action**, `devjoinedthechat/shadowlap@main`, that replays the recordings and puts the diff of each failure in the job summary and on the pull request.
- **Recorded tests** for your own suite: a pytest plugin (`@pytest.mark.shadowlap`) and `@shadowlap/test` for Vitest and node:test. A test records on its first run and replays offline after that.
- **Gated goldens.** A golden that may fork can be decided by a sequential test between two pass rates, or against its own test history, stopping as soon as the evidence is enough. `--inconclusive fail|warn` says what CI does when a gate, a check or an injection test can't decide, and the Action can keep the test history between jobs.
- **Injection tests.** `shadowlap injection` plants payloads in every read of a tool marked untrusted, each carrying a canary that occurs nowhere else, so a tool call carrying it proves the planted text caused it; `--clean` asks whether a recorded read caused a write. A golden's `injection` gate fails CI while the agent obeys.
- **Error-path presets.** `shadowlap test --chaos` forks each golden where a tool times out or answers nothing, malformed or oversized JSON, or the provider answers 429 or 500, and judges each fork by the checks that hold on any path.
- **Production coverage.** `shadowlap coverage` groups imported production runs by behaviour, names those no golden covers, and `--pack` makes a golden of one run of each.

#### Imports, exports and data

- **`shadowlap import har`, `nock`, `vcr` and `litellm`** turn a capture into a recording you replay your own code against; a LiteLLM gateway's production traffic becomes one run per correlation id.
- **Exports:** `pack` (redaction rules applied), `export html` (a run as one file with the dashboard's views), `export har`, `export otel` (GenAI semantic conventions) and `export dataset` (JSONL, OpenAI chat, Braintrust, Langfuse).
- **Recordings as data:** labels and notes that travel in packs, full-text search across prompts, responses and tool calls, and `shadowlap diff`, which starts with what changed between two runs.
- **`shadowlap rm` and `gc`** delete runs, old ones by age or count, and remove the recorded data nothing references any more.
- **JSON for scripts and coding agents** from `ls`, `show`, `search`, `diff`, `calibrate`, `label`, `blame`, `verify`, `repair` and `test`, and instructions to give Claude Code, Cursor and Codex.
- **The coding agents' instructions, packaged.** A Claude Code plugin with one skill, `debug-agent`, and a Cursor rule hold what docs/agents.md gives to paste. `shadowlap skill install` puts the plugin into a project's `.claude/skills/shadowlap/`, or with `cursor` the rule into `.cursor/rules/`, from the copy that ships with the CLI. The repository is also its own Claude Code plugin marketplace, and CI runs every command they name against the reference agent.
- **The recording format, specified.** docs/recording-format.md, version 1: packs on disk and the recordings protocol over HTTP, with Shadowlap as the reference implementation.
- **A service the agent calls, recorded as a tool.** docs/downstream-services.md shows how a declared host's answers replay without the service.

#### Team store

- **Your team's runs in a bucket you own**, free and open source like the rest, with nothing to buy or add first. `shadowlap store set` names an Amazon S3, Cloudflare R2 or other S3-compatible bucket, a Cloud Storage bucket or an Azure Blob container in `shadowlap.config.json`, and every machine reaches it with its own credentials, found where the cloud's own tools keep them. Nothing is hosted, there are no accounts, and no cloud SDK is bundled.
- **`shadowlap push` and `pull`** send runs with their lineage, each blob once, and a run still recording when it ends, and bring teammates' runs back, checked as strictly as a pack. Labels and notes merge both ways, and every run says who made it, and in CI which CI. A pulled run reads as its author's recording, with the requests it sent and what it spent there (*≈$0.0030 spent · by maya*), and its replay asks before running the command it was recorded with.
- **`shadowlap test --push`** sends every test run and the session's report from CI; `shadowlap store ci` prints the step, with short-lived credentials wherever the CI and the cloud allow them, and `store push-from-ci off` turns it off for the whole team.
- **Pull requests stay in their own folder.** A pull request's CI job writes only under `pr/<number>/`, a pull leaves those folders out unless given `--include-pr`, and runs from one never go back into the team's. `shadowlap store policy` prints the two policies that make the cloud hold to it.
- **`shadowlap share`** writes a run's HTML report, with every redaction rule applied, to the bucket and prints a link that expires after 7 days.
- **`shadowlap store check`** proves this machine can list, write, read and delete in the store, and warns when versioning or an object lock is off; `store show` says what this machine knows, without a request.

#### Dashboard and terminal UI

- **`shadowlap dashboard`**: runs and their forks, a strip of every call by origin, the calls, turns, context and cache use, timeline and family of a run, the conversation exactly as the model saw it at any call, streamed responses at their recorded pacing, fork diffs and Compare. Replay and every fork run from the page, and a run downloads as one redacted HTML file.
- **`shadowlap ui`**: the run tree with check results and labels, a timeline with scopes, the inspector, playback, diffs, and an actions palette with every intervention.
- **Cost, model and stop reason** for every call, from a price table the config can extend.

#### Security

- **Local only.** The sidecar and the dashboard listen on 127.0.0.1 behind a session token; the dashboard checks Host and Origin, runs under a strict Content Security Policy, and builds every command itself.
- **Packs and captures are untrusted input:** validated before anything is written, hash-checked, refused on symbolic links and oversized files, credentials dropped. Replaying a pack's command asks first.
- **Recorded text is escaped** wherever a terminal shows it, stores are readable only by their owner, and a store written by a newer Shadowlap is refused.
- **Telemetry is off:** nothing is sent unless `SHADOWLAP_TELEMETRY_URL` names a collector you run. The collector is in the repository.

#### Built on

- **Open protocols:** the SDK wire protocol and the recording format are specified, with a conformance suite of fourteen scenarios that needs no API keys. The engine is documented as a library.
- **Few runtime dependencies, held by a test.** The engine, sidecar, SDKs and adapters install nothing else. The CLI adds commander, and the terminal UI, which the CLI and the dashboard use, adds Ink and React.

[Unreleased]: https://github.com/devjoinedthechat/shadowlap/commits/main
