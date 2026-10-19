<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/lockup-dark.svg">
    <img src=".github/assets/lockup-light.svg" alt="shadowlap" width="320">
  </picture>
</p>

<p align="center">
  <b>Change safety for agents.</b><br>
  Record, replay and fork AI agent runs: reproduce a failure exactly, find the call that lost the run, and prove your fix holds before it ships.
</p>

<p align="center">
  <a href="https://github.com/devjoinedthechat/shadowlap/actions/workflows/ci.yml"><img src="https://github.com/devjoinedthechat/shadowlap/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="#status"><img src="https://img.shields.io/badge/status-pre--release-8a8a8a" alt="Status: pre-release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License: Apache-2.0"></a>
</p>

<p align="center">
  <a href="docs/quickstart.md">Quickstart</a> ·
  <a href="docs/index.md">Docs</a> ·
  <a href="docs/cli.md">CLI</a> ·
  <a href="docs/ci.md">CI</a> ·
  <a href="docs/troubleshooting.md">Why did my replay diverge?</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>

---

Your agent refunded $240 it should have escalated. Run it again and it behaves: you can't make it fail on demand, so you can't prove a fix worked.

Shadowlap records every model and tool call your agent makes, then re-runs your real code against the recording. Calls that haven't changed are served from it, so the failure reproduces exactly, with no side effects repeated. The first call that differs gets a diff, and the run forks there: live from that call on, with writes fenced.

- **Reproduce** a failing run exactly: `shadowlap replay <run>`.
- **Find** the model call that lost it: `shadowlap blame <run>`.
- **Fix** it, and **prove** the fix on the failing runs, runs it never saw and the good runs: `shadowlap repair`, `shadowlap verify`.
- **Keep it fixed**: commit the run as a golden, and `shadowlap test` replays it offline in CI.
- **Ask what if**: change one thing at call *k* (a tool result, an instruction, the model, an HTTP failure) and replay the rest.

Every replayed call is one not re-sent: a clean replay makes no upstream requests and spends no tokens.

## Quickstart

Shadowlap runs from source until it is published. You need Node ≥ 22.13, and Python ≥ 3.9 for the Python SDK.

```sh
git clone https://github.com/devjoinedthechat/shadowlap && cd shadowlap
npm ci && npm run build
npm link --workspace packages/cli      # puts shadowlap on your PATH
```

Once published, `npm install -g shadowlap` installs the CLI, and the SDKs come from npm and PyPI.

The repository ships a reference agent that searches the web, reads pages and emails a summary, in 30 calls. With its scripted fake of the Anthropic API, the first minute needs no API key:

```sh
node testing/reference-agent/dist/mock-server.js &       # prints its URL
export SHADOWLAP_UPSTREAM_ANTHROPIC=http://127.0.0.1:<port>

shadowlap run -- node testing/reference-agent/dist/main.js   # record it
shadowlap replay <run>                                       # replay it from the recording
AGENT_SYSTEM_SUFFIX="Be brief." shadowlap replay <run>       # change the prompt: it forks
shadowlap dashboard                                          # step through it in the browser
```

```
● Recorded 01M4YFP3V2Y3KJ7316BYH635NV: 30 calls (11 api, 17 tool, 2 clock/random), 11 upstream requests, ≈$0.072
✓ Replay clean: 30/30 calls replayed (11 api, 17 tool, 2 clock/random), 0 upstream requests, 12k input tokens not re-spent (≈$0.072)
⑂ Forked at call 3: 2 calls replayed, then 21 live, 1 write blocked; 11 upstream requests (≈$0.072 spent, $0 saved)
✗ Diverged at call 3 (api POST /v1/messages): 2 calls replayed before divergence
  ~ $.system
      - "You are a research agent. Use the tools, then email a summary."
      + "You are a research agent. Use the tools, then email a summary. Be brief."
```

The email at the end of the run was blocked: after a fork, writes don't run again unless you say so.

For your own agent, run `shadowlap init` in its directory. It finds your model SDKs, framework, command and tools, and prints the steps with your project's names in them. Until the packages are published, skip its install step: the CLI you linked is on your PATH, and the SDKs install from the clone into your agent's project:

```sh
npm install path/to/shadowlap/packages/sdk          # tools, clock and randomness
npm install path/to/shadowlap/packages/adapters     # framework adapters, next to the SDK
npm install -D path/to/shadowlap/packages/test      # recorded tests: Vitest, node:test
pip install -e path/to/shadowlap/sdks/python        # Python SDK, adapters, pytest plugin
```

Then prefix the command you already run:

```sh
shadowlap run -- python agent.py
```

[docs/quickstart.md](docs/quickstart.md) has the full walkthrough, a local model with no key, and the real APIs.

## How it works

```
shadowlap run -- python agent.py
│
├── sidecar   127.0.0.1, a random port; every path carries the session's token: /t/<token>/…
│   ├── /anthropic/*  /openai/*  /gemini/*   model APIs, recorded and replayed
│   ├── /bedrock/*  /vertex/*  /azure/*      the same, for clients that sign requests or fix their endpoint
│   ├── /http/*                              HTTP hosts declared in the config, recorded as tools
│   └── /v1/calls/*                          tools, clock and randomness, from the SDKs
├── store     .shadowlap/shadowlap.db (SQLite), in your project and out of git
└── agent     ANTHROPIC_BASE_URL, OPENAI_BASE_URL, GOOGLE_GEMINI_BASE_URL   the official SDKs, pointed at the sidecar
              SHADOWLAP_URL, SHADOWLAP_RUN_ID                                the Shadowlap SDKs
```

- **Recorded at the HTTP layer.** The official SDKs read a base URL, so model calls need no code changes. Bedrock, Vertex AI and Azure OpenAI are captured inside Node and Python agents. Streams replay byte for byte.
- **Matched by what they ask.** A call's identity is a hash of its request after your [normalizers](docs/normalizers-and-redaction.md), and how many identical requests came before it; never the order calls arrive in, so parallel calls replay in any order. Nothing is matched fuzzily.
- **Forked at the first change.** A fix to the code around the model changes no request and replays in full. A prompt change forks at the first request it touches. After the fork, model calls and `read` tools run live, and `write` tools are blocked or stubbed.
- **Tools say what they do.** Wrap a tool once, with the SDK or a framework adapter, as `pure`, `read` or `write`. Outside Shadowlap the wrapper is a passthrough, so it ships to production unchanged.

```ts
import { tool } from '@shadowlap/sdk';

export const issueRefund = tool('issue_refund', { effect: 'write' }, async (args) => payments.refund(args));
```

```python
from shadowlap import tool

@tool(effect="read")
def lookup_policy(order_id: str) -> dict: ...
```

[docs/how-it-works.md](docs/how-it-works.md) covers identity, effects, the network guard, partial recordings, thinking blocks and storage.

## Fixes: blame, repair, verify

A run usually goes wrong well before it visibly fails. Fixes find where, write the change, and keep it only when it holds.

```sh
shadowlap blame <run> --expect '{"tools":{"issue_refund":0}}'
shadowlap repair --fixes label:refund-bug --keeps label:good --repairer claude-code
shadowlap verify --fixes <runs> --holdout <runs> --keeps label:good
```

- **Blame** names the model call that lost the run: the last one whose answer, asked again, lets the run pass. Every call before a probe replays from the recording, and the search halves the run each time, so 30 model calls take about six probes. [docs/blame.md](docs/blame.md)
- **Repair** asks a model you choose (Anthropic, OpenAI or a compatible server, or your own Claude Code) to rewrite the system prompt or a tool description, and keeps the smallest rewrite verify accepts. The fix comes back as a patch, a pull request body and the fixed runs as goldens; `--branch` and `--pr` hand it over. [docs/repair.md](docs/repair.md)
- **Verify** accepts a change only when the failing runs pass, failing runs it was not written against pass too, and the good runs still pass, each decided by a [gate](docs/gating.md) that tells a run passing 90% of the time or more from one passing 70% or less, at 5% risk. It exits 1 when it rejects, so it can gate a merge. [docs/verify.md](docs/verify.md)

A passing run exits 0 and meets `--expect`: tools that must or must not be called and with what arguments, call counts, token and cost budgets, and text in the answer.

## Tests in CI

Commit the runs that matter as goldens. `shadowlap test` replays them offline, with no keys and no tokens, and fails when a request changes, the agent tries a live call or exits with an error, or a rule breaks:

```sh
shadowlap pack <run> goldens/refund-over-limit
shadowlap test goldens/* --junit report.xml
```

Rules live in `shadowlap.config.json`, the same checks blame and verify take:

```json
{ "tests": { "goldens/refund-*": { "expect": { "tools": { "issue_refund": 0, "escalate": 1 }, "cost": "<= 0.05" } } } }
```

On GitHub it is one step, which puts the diff in the job summary and on the pull request:

```yaml
- uses: devjoinedthechat/shadowlap@main
  with:
    recordings: goldens/*
```

Tests in your own suite work the same way: mark a test with `@pytest.mark.shadowlap`, or wrap it in `recorded()` for Vitest (`withRecording()` for node:test), and it records once and replays offline after that. [docs/ci.md](docs/ci.md) · [docs/testing.md](docs/testing.md)

## The dashboard and the terminal UI

`shadowlap dashboard` opens your runs in the browser, on 127.0.0.1: each run and its forks, a strip of every call coloured by where it came from (replayed, live, blocked, stubbed, overridden), the conversation exactly as the model saw it at any call, streamed responses at their recorded pacing, context and cache use per call, a timeline of what ran in parallel, the diff that caused a fork, and Compare for any two runs. Replay and every fork run from the page, and a run downloads as one redacted HTML file. [docs/dashboard.md](docs/dashboard.md)

`shadowlap ui` is the quick look from the terminal: where a run forked, what a call sent and got back, and a fork from the call in front of you. `o` opens the same call in the dashboard. [docs/tui.md](docs/tui.md)

```
 01K5CQ4P2R fork @17 of 01K5CQ4N7G · 30 calls · 16 replayed · 13 live · 1 blocked · 12k tok saved · 2s ago
┌─────────────────────────────────────────────────┐┌───────────────────────────────────────────────┐
│  #15  tool  fetch_page        replayed ok  {"url"││ conversation  request  response  meta         │
│  #16  tool  read_file         replayed ok  {"path││ ■ 14 events over 1.3s · stop tool_use · space │
│>!#17  api   messages          live     ok  1k>40 ││                                               │
│  #18  tool  search_web        live     ok  {"quer││ Sending the summary.                          │
│  #19  tool  send_email        blocked  ERR {"to":││ ⚙ send_email {"to":"team@example.com",…       │
└─────────────────────────────────────────────────┘└───────────────────────────────────────────────┘
 : actions · / search · [ ] jump · o dashboard · y copy · w write · p parent · space play · d diff · f filter · ? help
```

## SDKs and integrations

| | |
|---|---|
| Providers | Anthropic, OpenAI and OpenAI-compatible servers (Ollama, vLLM, OpenRouter, Groq), Gemini; Amazon Bedrock, Vertex AI and Azure OpenAI. [docs/providers.md](docs/providers.md) |
| SDKs | TypeScript (`@shadowlap/sdk`) and Python (`shadowlap`): tools, clock, randomness and scopes. Any other language speaks the [wire protocol](docs/protocol.md). [docs/sdk.md](docs/sdk.md) |
| Frameworks | Vercel AI SDK, OpenAI Agents SDK, Mastra, LangChain and LangGraph, the Anthropic tool runner; in Python, Pydantic AI, OpenAI Agents SDK, LangGraph and CrewAI. Each adapter is tested against the real framework. [docs/frameworks.md](docs/frameworks.md) |
| MCP | `shadowlap mcp -- <server>` records, replays and fences an MCP server's tool calls. [docs/mcp.md](docs/mcp.md) |
| Coding agents | Claude Code, Cursor and Codex drive the CLI as it is: every command they need reads and writes JSON. The Claude Code plugin and the Cursor rule that tell them how go into your project with `shadowlap skill install`. [docs/agents.md](docs/agents.md) |
| Imports | HAR files, nock recordings, VCR cassettes and production traffic from a LiteLLM gateway become recordings you replay your own code against. [docs/gateways.md](docs/gateways.md) |
| Exports | Redacted packs, one-file HTML reports, HAR, OpenTelemetry traces, and datasets for evals (JSONL, OpenAI chat, Braintrust, Langfuse). [docs/cli.md](docs/cli.md#export-dataset) |

## Security

Shadowlap runs beside your agent, on your machine. A run leaves only when you export, push or share it.

- **Keys pass through.** Credentials go to the provider and are never stored. Replays need none.
- **Local only.** The sidecar and the dashboard listen on 127.0.0.1 behind a session token. The dashboard checks Host and Origin, and builds every command itself: the browser only names an action.
- **Yours to read.** Recordings stay in `.shadowlap/` in your project, readable only by you, and out of git.
- **Masked on the way out.** Your redaction rules run on every pack, HTML file, share link and dataset you export. The local store is never changed.
- **Your bucket, your credentials.** The team store is a bucket you own, reached with each machine's own credentials; nothing is hosted and there are no accounts. Runs go there as recorded, like the store on your machine, so give the bucket the access you would give `.shadowlap/`.
- **Shared runs are checked.** A pack, or a run pulled from the team store, is validated and hash-checked before anything is written, and replaying its command asks first. A pull request's CI job writes only to its own folder in the store.

[SECURITY.md](SECURITY.md) lists every check and how to report a vulnerability.

### Telemetry

Nothing is sent by default, and the project runs no collector. The client is there for teams that host their own collector (`packages/collector`): set `SHADOWLAP_TELEMETRY_URL` and the CLI sends anonymous counts and versions, never prompts, tool data, file paths or model names. `SHADOWLAP_TELEMETRY=0` or `DO_NOT_TRACK=1` turns it off either way. [docs/telemetry.md](docs/telemetry.md) lists every field.

## Status

On 2026-10-15: ✅ works in this repository today, ⬜ is being built.

| | |
|:-:|---|
| ✅ | Record model calls at the HTTP layer, streams byte for byte: Anthropic, OpenAI and OpenAI-compatible servers, Gemini, Bedrock, Vertex AI and Azure OpenAI |
| ✅ | Replay with no upstream requests; fork at the first changed call with a structural diff; writes blocked or stubbed after a fork; the network guard |
| ✅ | What-ifs at call *k*: `--override`, `--inject`, `--set`, `--model`, `--live-tool`, `--diverge-at`, `--prompt-from` and `--fail-at` on model calls; `--repeat` and `--watch` |
| ✅ | TypeScript and Python SDKs; adapters for eight frameworks in TypeScript and Python, each tested against the real one; MCP servers over stdio |
| ✅ | Fixes in the CLI: `blame`, `repair` (with `--repairer claude-code`, `--branch` and `--pr`) and `verify` |
| ✅ | `shadowlap test` with outcome checks, JUnit, JSON and Markdown reports and pull request annotations; the GitHub Action; recorded tests for pytest, Vitest and node:test |
| ✅ | Imports from HAR, nock, VCR and LiteLLM; exports to packs, HTML, HAR, OpenTelemetry and eval datasets; labels, notes, search, `diff`, `calibrate`, normalizers and redaction |
| ✅ | The dashboard (runs, the run page and its views, Compare, replay and fork actions, one-file HTML downloads) and the terminal UI |
| ✅ | `init`, `doctor`, `rm` and `gc`; CI on Linux, macOS and Windows with Node 22 and 24 |
| ✅ | The team store, free: runs in a bucket you own (S3, R2 and S3-compatible stores, Cloud Storage, Azure Blob), `push` and `pull` with each machine's own credentials, `test --push` from CI with pull requests kept to their own folders, and share links |
| ⬜ | The new dashboard: navigation, a command palette, the Overview, Runs with a 12-week calendar and bulk actions, the run page's Share menu, Provenance and fork button on every call, what a run didn't record, Compare with run pickers and change cards, connection states and a phone layout |
| ⬜ | Fixes as a page: each failure with its blame, repair and verify steps, stored verdicts, and applying the patch (`shadowlap fix apply`) |
| ⬜ | Tests as a page with each golden's history; `shadowlap test --update` after an intended change; `shadowlap bisect` to find the commit that broke a golden; fix pull requests from CI |
| ⬜ | Settings (matching, redaction, CI, coding agents, tools, project), removing a rule (`normalize rm`, `redact rm`), and several projects, each with a guided setup |
| ⬜ | Interventions on every provider's request shape; `--fail-at` on tool calls; planting an instruction in a tool result; recorded user input, so a chat agent replays without anyone typing; redacted HAR exports |
| ⬜ | Imports from OpenTelemetry, Langfuse and LangSmith; MCP servers over Streamable HTTP |
| ⬜ | Training: preference pairs from fixed failures (`shadowlap export pairs`), and scoring a model on your goldens (`shadowlap tasks score`, `tasks serve`) |
| ⬜ | Published to npm and PyPI; the release workflow is ready |

## Documentation

| Guide | Covers |
|---|---|
| [Quickstart](docs/quickstart.md) · [How it works](docs/how-it-works.md) | Record and replay the reference agent, then your own; identity, effects, the network guard, storage |
| [SDKs](docs/sdk.md) · [Frameworks](docs/frameworks.md) · [Providers](docs/providers.md) · [MCP servers](docs/mcp.md) · [Capturing production traffic](docs/gateways.md) | Recording |
| [Interventions](docs/interventions.md) · [Normalizers and redaction](docs/normalizers-and-redaction.md) · [Why did my replay diverge?](docs/troubleshooting.md) | Replays and forks |
| [Blame](docs/blame.md) · [Repair](docs/repair.md) · [Verify](docs/verify.md) | Fixes |
| [Test suites](docs/testing.md) · [CI mode](docs/ci.md) | Tests |
| [Dashboard](docs/dashboard.md) · [Terminal UI](docs/tui.md) · [Coding agents](docs/agents.md) | Looking at runs |
| [Team store](docs/team.md) | Your team's runs in a bucket you own: push, pull, CI's test runs, pull requests, share links |
| [CLI](docs/cli.md) · [Telemetry](docs/telemetry.md) · [Wire protocol](docs/protocol.md) · [Recording format](docs/recording-format.md) · [Engine](docs/engine.md) | Reference, and building on Shadowlap: the recording format specifies packs and the recordings protocol |
| [Compared with other tools](docs/compare.md) | Cassettes, tracing platforms, replay evals, framework time travel, durable execution |


## Contributing

Issues and pull requests are welcome. The most useful report is a run against your own agent that diverged or confused you. [CONTRIBUTING.md](CONTRIBUTING.md) covers setup, the test suites and the rules the code keeps; report security issues privately, as [SECURITY.md](SECURITY.md) describes.

```sh
npm ci && npm run build
npx vitest run && npm run typecheck:tests
```

## License

[Apache-2.0](LICENSE). Nothing in this repository needs an account.

Organisation features (setup on your infrastructure, evidence reports for your auditors, support with an SLA) are offered to regulated teams through paid pilots: [talk to an engineer](https://github.com/devjoinedthechat/shadowlap/issues/new?template=pilot.md).
