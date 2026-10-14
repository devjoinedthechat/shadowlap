<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="site/brand/logo-dark.svg">
    <img src="site/brand/logo-light.svg" alt="Shadowlap" width="60" height="60">
  </picture>
</p>

<h1 align="center">Shadowlap</h1>

<p align="center">
  <b>Record, replay and fork AI agent runs.</b><br>
  Replay your agent, not a trace of it.
</p>

<p align="center">
  <a href="https://github.com/devjoinedthechat/shadowlap/actions/workflows/ci.yml"><img src="https://github.com/devjoinedthechat/shadowlap/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/devjoinedthechat/shadowlap/actions/workflows/frameworks.yml"><img src="https://github.com/devjoinedthechat/shadowlap/actions/workflows/frameworks.yml/badge.svg" alt="Frameworks"></a>
  <a href="#project-status"><img src="https://img.shields.io/badge/status-pre--alpha-8a8a8a" alt="Status: pre-alpha"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%E2%89%A5%2022.13-3c873a" alt="Node ≥ 22.13"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License: Apache-2.0"></a>
</p>
<!-- On release: add https://img.shields.io/npm/v/shadowlap and https://img.shields.io/pypi/v/shadowlap -->

<p align="center">
  <a href="docs/quickstart.md">Quickstart</a> ·
  <a href="docs/how-it-works.md">How it works</a> ·
  <a href="docs/cli.md">CLI</a> ·
  <a href="docs/frameworks.md">Frameworks</a> ·
  <a href="docs/ci.md">CI</a> ·
  <a href="docs/troubleshooting.md">Why did my replay diverge?</a> ·
  <a href="docs/compare.md">Compared with other tools</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>

<p align="center">
  <a href="docs/dashboard.md">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="site/brand/dashboard-dark.png">
      <img src="site/brand/dashboard-light.png" alt="The Shadowlap dashboard on a fork of a 30-call agent run: calls 1 to 16 served from the recording, the run forked at call 17 where an instruction was injected, calls after it ran live, and the email at call 29 blocked. The inspector shows the conversation the model saw at call 17." width="100%">
    </picture>
  </a>
</p>

---

Shadowlap records every model API call and tool call an agent makes, then re-runs the agent's **real code** against that recording. Calls that haven't changed are served from the recording: no tokens spent, no side effects repeated. The first call that differs is reported with a precise diff, and from there the run continues live as a **fork** of the original, with write tools fenced off.

## Why

Reproducing a failing agent run is expensive and unreliable. A 30-call run with an 80k-token context resends about 2.4M input tokens every time you rerun it, it can repeat real side effects (emails, writes, payments), and the model may not even fail the same way twice. Tracing tools show you what happened; none of them run your code again against it.

With Shadowlap, a fix to your harness (parsing, dispatch, state, stop conditions) replays the entire run for free against the model's exact recorded behavior. A change to a prompt or a tool forks at the first request it affects and runs only the rest live.

## Features

- **Zero-token replay.** Unchanged calls come from the recording byte for byte, streams included, without waiting: a replay takes as long as your own code, and a clean one makes no outbound requests.
- **Forks with a diff, not with noise.** The first changed request is reported as a structural diff against the closest recorded call. Dates in a prompt match whatever day you replay on, and `shadowlap calibrate` proposes normalizers for the ids and temp paths an agent generates.
- **Side effects fenced.** Tools declare `pure`, `read` or `write`; after a fork, writes are blocked or stubbed, and a network guard catches anything that bypasses Shadowlap. Vector databases and internal APIs need no wrapper: declare their hosts and they are recorded as tools.
- **Targeted what-ifs.** Override a tool result, inject an instruction or switch the model at step *k*, without touching code or invalidating recorded thinking blocks. Edited the system prompt? `--prompt-from k` applies it from step *k* and replays everything before.
- **Test the failure path.** `--fail-at 12=429` answers that model call with a rate limit, so the SDK's retries run out and the agent's own error handling runs: the path no recording of a healthy run contains. Nothing is sent and nothing is spent.
- **Replay on every save.** `--watch` replays again whenever a file changes. The prefix before a fork is free, so the loop costs nothing and takes as long as your own code.
- **Fixed, or lucky?** `--repeat 5` runs a fork five times and shows whether the attempts took the same path, so one good run isn't mistaken for a fix.
- **Where was it lost?** A run usually goes wrong well before it visibly fails. `shadowlap blame <run>` names the model call that lost it: the last one whose answer, asked again, lets the run pass. It binary-searches the run with forks that replay everything before the probed call for free, and shows what the model answered there in the recording and in a fork that passed ([docs/blame.md](docs/blame.md)).
- **Fixed, everywhere?** `shadowlap verify --fixes <runs> --holdout <runs> --keeps label:good` accepts a change only when it fixes the failing runs, including ones it wasn't written against, and every good run still passes, several attempts each. A run whose replay doesn't fork settles in one free attempt, so a harness fix verifies at no cost. It exits 1 when rejected, so it can gate a merge ([docs/verify.md](docs/verify.md)).
- **Fixed for you, and proven.** `shadowlap repair --fixes <runs> --keeps label:good` blames each failing run, asks a model you choose (Anthropic, OpenAI or any compatible server) to rewrite the system prompt or a tool description, and keeps the smallest rewrite that `verify` accepts, including on failing runs the model never saw. A rewrite that names a detail of the failing runs is rejected before it runs. The fix comes back as a patch, a pull request body and a regression recording; `--branch` and `--pr` hand it over ([docs/repair.md](docs/repair.md)).
- **In your test suite.** Mark a test with `@pytest.mark.shadowlap`, or wrap it in `recorded()` for Vitest or node:test. It records on the first run and replays offline after that, so it is fast, free and deterministic, and fails with the diff when a request changes ([docs/testing.md](docs/testing.md)).
- **In CI.** `shadowlap test` replays committed recordings offline on every build. Outcome checks pin what must happen (*`send_email` is never called, in 5 of 5 attempts*) and cap tokens and cost, so a prompt that quietly doubles the context fails. On GitHub it is one step that puts the diff on the pull request ([docs/ci.md](docs/ci.md)).
- **Works with your stack.** Anthropic, OpenAI and OpenAI-compatible servers, and Gemini, called directly or through Bedrock, Vertex AI and Azure OpenAI. TypeScript and Python, with adapters for the Vercel AI SDK, OpenAI Agents SDK, Mastra, LangChain/LangGraph, Pydantic AI, CrewAI and the Anthropic tool runner, and MCP servers through a stdio proxy. Model calls need no code changes.
- **Works with coding agents.** Claude Code, Cursor and Codex can record, read, replay and compare runs through the CLI's JSON output; [docs/agents.md](docs/agents.md) has the instructions to give them.
- **Recordings you didn't have to make.** `shadowlap import` turns traffic something else captured (a HAR, a nock recording, a VCR cassette, or a [LiteLLM gateway](docs/gateways.md) in production) into a recording you can replay your own code against. Tool calls it never saw run live, writes still fenced, and one replay with your command makes it a complete CI golden.
- **An SDK in any language.** Model calls need no SDK; everything else goes through one small HTTP API, [specified](docs/protocol.md) with a conformance suite of fourteen scenarios that needs no API keys. The [test-runner protocol](docs/recordings-protocol.md) and the [engine](docs/engine.md) are documented too.
- **Inspect everything.** A local dashboard and a terminal UI: the conversation exactly as the model saw it at any call, responses played back at their recorded pacing, fork diffs and one-click forks, context and cache use per call, what ran in parallel, cross-run diffs, and OpenTelemetry export.

## Quickstart

Shadowlap is not on npm yet; run it from source. You need Node ≥ 22.13.

```sh
git clone https://github.com/devjoinedthechat/shadowlap && cd shadowlap
npm install && npm run build
alias shadowlap="node $PWD/packages/cli/bin/shadowlap.js"
```

**Try it without an API key.** The repository ships a 30-call streaming agent and a scripted fake of the Anthropic API:

```sh
node testing/reference-agent/dist/mock-server.js &          # prints its URL
export SHADOWLAP_UPSTREAM_ANTHROPIC=http://127.0.0.1:<port>

shadowlap run -- node testing/reference-agent/dist/main.js      # record
shadowlap replay <run>                                          # clean replay: 0 upstream requests
AGENT_SYSTEM_SUFFIX="Be brief." shadowlap replay <run>          # a fork, with a diff; the email is blocked
shadowlap dashboard                                             # the web dashboard (or: shadowlap ui)
```

<p><img src="site/demo-static.svg" alt="Terminal output: the recording reports 30 calls and 11 upstream requests; the clean replay serves all 30 from the recording with 0 upstream requests and 12k input tokens not re-spent; a replay with a sentence appended to the system prompt forks at call 3, blocks the email at the end, and shows the diff of the prompt that caused it." width="100%"></p>

**A real model, still no key.** [examples/local-model](examples/local-model) is an incident triage agent on the OpenAI Agents SDK, running Qwen 2.5 7B through [Ollama](https://ollama.com). Record it, replay it with Ollama stopped, and fork it at the call where the model gets the task wrong.

**Your own agent.** Run `shadowlap init` in its directory: it finds your model SDKs, framework, agent command and tools, suggests an effect for each tool, and warns about a model client whose base URL is hardcoded, which would record nothing. Then prefix the command you already run. `shadowlap run` points the official Anthropic, OpenAI and Gemini SDKs at a local proxy through their base-URL variables, so model calls are recorded with no code changes:

```sh
shadowlap run -- python agent.py
shadowlap replay <run>
```

Recordings stay on your machine in `./.shadowlap/` (git-ignored automatically) and never contain credentials. The full walkthrough is in [docs/quickstart.md](docs/quickstart.md).

## Wrap your tools

Model calls are captured automatically; tools need one wrapper so Shadowlap knows what they do to the world.

```ts
import { tool, now, uuid } from '@shadowlap/sdk';

export const searchWeb = tool('search_web', { effect: 'read' }, async ({ query }) => search(query));

export const sendEmail = tool('send_email', {
  effect: 'write',
  onFork: () => ({ sent: false, suppressed: true }),   // returned instead under --writes stub
}, async (args) => mailer.send(args));

const startedAt = await now();   // recorded, so a replay sees the same value
```

```python
from shadowlap import tool

@tool(effect="write", on_fork=lambda to, body: {"sent": False, "suppressed": True})
def send_email(to: str, body: str) -> dict: ...
```

`pure` means the result depends only on the arguments, `read` reads outside state, `write` changes it. Without Shadowlap running, `tool()` is a passthrough, so wrapped tools ship to production unchanged.

<details>
<summary><b>Framework adapters and MCP</b></summary>

Declare the effect once where the framework defines the tool. Only the tool's input is recorded, never framework context objects. Each adapter is tested in CI against the real framework.

```ts
import { withEffects } from '@shadowlap/adapters/ai-sdk';          // Vercel AI SDK
const tools = withEffects({ search_web: tool({ inputSchema, execute }) }, { search_web: 'read' });

import { withEffect } from '@shadowlap/adapters/openai-agents';    // OpenAI Agents SDK
const searchWeb = tool(withEffect({ name: 'search_web', parameters, execute }, 'read'));

import { withEffect } from '@shadowlap/adapters/mastra';           // Mastra 1.x (0.x: withEffectV0)
const searchWeb = createTool(withEffect({ id: 'search_web', inputSchema, execute }, 'read'));

import { withEffect } from '@shadowlap/adapters/langchain';        // LangChain / LangGraph
const searchWeb = withEffect(tool(search, { name: 'search_web', schema }), 'read');

import { withEffect } from '@shadowlap/adapters/anthropic';        // Anthropic tool runner
const searchWeb = betaZodTool(withEffect({ name: 'search_web', inputSchema, run }, 'read'));
```

```python
@agent.tool                                   # Pydantic AI
@tool(effect="read")
async def search_web(ctx: RunContext[Deps], query: str) -> dict: ...

from shadowlap.adapters.openai_agents import function_tool     # OpenAI Agents SDK
@function_tool(effect="read")
async def search_web(ctx: RunContextWrapper[Deps], query: str) -> str: ...

from shadowlap.adapters.langchain import with_effect           # LangChain / LangGraph
tools = ToolNode([with_effect(search_web, "read"), with_effect(send_email, "write")])

from shadowlap.adapters.crewai import with_effect              # CrewAI
agent = Agent(role="Researcher", tools=[with_effect(search_web, "read")], ...)
```

Tools served by an MCP server need no code: start the server through the proxy in your MCP client's configuration.

```json
{ "command": "shadowlap", "args": ["mcp", "--", "npx", "-y", "@modelcontextprotocol/server-filesystem", "/srv/notes"] }
```

See [docs/frameworks.md](docs/frameworks.md) and [docs/mcp.md](docs/mcp.md).
</details>

## How it works

```
shadowlap run -- python agent.py
│
├── sidecar  (127.0.0.1, random port; every path carries a per-session token: /t/<token>/…)
│   ├── /anthropic/*  /openai/*  /gemini/*   record/replay proxy ──►  the provider (live calls only)
│   ├── /bedrock/*  /vertex/*  /azure/*      the same, for clients that sign requests or fix their endpoint
│   ├── /http/*                              HTTP hosts declared in the config, recorded as tools
│   ├── /v1/calls/*                          tools, clock and randomness  ◄── the SDK
│   └── store                                .shadowlap/shadowlap.db  (SQLite)
│
└── your agent   ANTHROPIC_BASE_URL, OPENAI_BASE_URL, GOOGLE_GEMINI_BASE_URL   base-URL redirect
                 SHADOWLAP_URL, SHADOWLAP_RUN_ID                                   the SDK
                 SHADOWLAP_CAPTURE, SHADOWLAP_GUARD                                in-process capture, network guard
```

- **Matching** uses `(kind, fingerprint, occurrence)`: a SHA-256 of the canonical request after normalizers, and *n* for the *n*-th identical request. Arrival order is never part of the identity, so parallel tool calls replay in any interleaving.
- **Forks happen at the first request that changes**, not where the bug is. Harness fixes change no request and replay in full; a system-prompt edit changes every request and forks at call 1. An intervention that changes a *response* instead — an overridden tool result, an injected failure — forks at the call it touches.
- **After a fork**, model calls and `read` tools run live, `pure` tools still replay when identical, and `write` tools are blocked (or stubbed, or allowed).
- **A partial recording** — one built from traffic something else captured, which never saw the tool, clock and randomness calls — declares the kinds it holds. A replay runs every other kind live rather than diverging on its absence, and still fences writes.
- **Thinking blocks stay valid.** A fork never edits recorded history: interventions only append or patch unbound fields, so replayed turns pass the provider's prefix check.

The details, including storage, normalizers and the network guard, are in [docs/how-it-works.md](docs/how-it-works.md).

## CLI

| Command | What it does |
|---|---|
| `shadowlap init` | Detect your SDKs, framework, agent command and tools, and print the steps to a first recording |
| `shadowlap run -- <cmd>` | Record a run |
| `shadowlap replay <run>` | Replay it; fork at the first changed call, with flags for every [intervention](docs/interventions.md) |
| `shadowlap dashboard [run]` | Open the local web dashboard |
| `shadowlap ui [run]` | Open the terminal UI |
| `shadowlap show <run>` | Print a run's timeline and divergence |
| `shadowlap ls --tree` | List runs with their forks |
| `shadowlap diff <a> <b>` | Compare two runs call by call |
| `shadowlap test <pack>` | Replay committed recordings offline in CI |
| `shadowlap serve --recordings` | The host the pytest and Vitest integrations start for recorded tests ([docs](docs/testing.md)) |
| `shadowlap search <words>` | Search recorded prompts, responses and tool calls across runs |
| `shadowlap label <run> <label>` | Label a run: bug, good, refund-flow; `ls --label`, `export dataset --label` |
| `shadowlap export dataset` | Recordings as an eval or fine-tuning dataset (JSONL, OpenAI chat, Braintrust, Langfuse) |
| `shadowlap calibrate [run]` | Find the values that change on every run and propose normalizers, with no model calls |
| `shadowlap pack <run> <dir>` | Export a recording, with redaction |
| `shadowlap replay <run> --watch` | Replay again on every save |
| `shadowlap import har · nock · vcr <file>` | Turn a capture from another tool into a recording: a HAR (mitmproxy, Charles, Proxyman, devtools, Polly.js), a nock recording, or a VCR cassette |
| `shadowlap import litellm <files...>` | Production traffic a LiteLLM proxy captured, one run per correlation id ([docs](docs/gateways.md)) |
| `shadowlap mcp -- <server>` | Run an MCP server behind Shadowlap |
| `shadowlap export otel <run>` | Export a run as an OpenTelemetry trace |
| `shadowlap export har <run>` | A run's model calls as a HAR, for any tool that reads one |
| `shadowlap export html <run>` | A run as one HTML file: the dashboard's views with the data built in |
| `shadowlap doctor` | Check the environment, store and config |

Every flag is documented in [docs/cli.md](docs/cli.md).

## Dashboard

`shadowlap dashboard` opens your recordings in the browser, locally: runs and their forks, a strip showing every call by origin, the conversation exactly as the model saw it at any call, streamed responses played back at their recorded pacing, the diff that caused a fork, replay and fork actions, and a download of any run as one file to share. It listens on 127.0.0.1 behind a session token and loads nothing from the network. See [docs/dashboard.md](docs/dashboard.md).

## Terminal UI

`shadowlap ui` opens the run tree, with check results and labels; `shadowlap ui <run>` opens a run, and a fork opens at its divergence (`--call <n>` opens at another call). It is the quick look from the terminal; `o` opens the run, at the selected call, in the dashboard.

```
 01K5CQ4P2R fork @17 of 01K5CQ4N7G · 30 calls · 18 replayed · 11 live · 1 blocked · 5k tok saved (≈…
┌────────────────────────────────────────────────┐┌────────────────────────────────────────────────┐
│  #14  api  messages          replayed ok  1k>4…││ conversation  request  response  meta          │
│  #15  tool fetch_page        replayed ok  {"ur…││■ 14 events over 85ms · ended: tool_use · space…│
│  #16  tool read_file         replayed ok  {"pa…││                                                │
│>!#17  api  messages          live     ok  1k>4…││⚙ search_web {"query":"side effects"}           │
│  #18  tool search_web        live     ok  {"qu…││⚙ search_web {"query":"vector clocks"}          │
│  #19  tool search_web        live     ok  {"qu…││                                                │
└────────────────────────────────────────────────┘└────────────────────────────────────────────────┘
 : actions · / search · [ ] jump · o dashboard · y copy · w write · p parent · space play · d diff …
```

Scrub the timeline, read the conversation exactly as the model saw it at any call, play a streamed response at its recorded pacing, and fork from the actions palette (`:`), which offers every [intervention](docs/interventions.md) the CLI has: force a tool live, override a result, inject an instruction, fail a call, switch the model, or repeat the replay. Keys are listed in [docs/tui.md](docs/tui.md).

## Project status

**Pre-alpha.** The core loop (record, replay, fork, CI mode) is complete and tested on Linux, macOS and Windows with Node 22 and 24, against the official Anthropic, OpenAI and Gemini SDKs and against scripted fakes of their APIs. Not yet done: publishing to npm and PyPI, and a validation run against each real API. Interfaces may still change before 1.0.

Shadowlap is an open-source project maintained by one person in their own time, not a product and not a company. There is no support channel, no response-time commitment and no hosted service; issues and pull requests are read when there is time. [CONTRIBUTING.md](CONTRIBUTING.md) says what is most likely to be merged.

<details>
<summary><b>What is built and how it is verified</b></summary>

| Area | State |
|---|---|
| Record model calls at the HTTP layer, streaming byte for byte: Anthropic, OpenAI and OpenAI-compatible servers (Ollama, vLLM, OpenRouter, Groq), Gemini | ✅ |
| Amazon Bedrock (InvokeModel and Converse), Vertex AI and Azure OpenAI, captured inside Node and Python agents with no code changes; tested with eight official clients, including SigV4 verification and HTTP/2 | ✅ |
| Replay with zero upstream requests; fork at the first changed call with a structural diff, closest counterpart and normalizer hints | ✅ |
| Effect-typed tools with writes blocked or stubbed after a fork; recorded clock and randomness | ✅ |
| Concurrency-safe matching; SDK retries collapsed into one call; normalizers applied at match time; changed-implementation warning | ✅ |
| Network guard for Node and Python: connections that bypass Shadowlap reported (`--guard warn`) or refused (`--guard block`, the default in CI) | ✅ |
| Interventions: `--override`, `--inject`, `--set`, `--model`, `--live-tool`, `--diverge-at`, `--fail-at` (an injected HTTP failure, so the agent's error path runs without spending anything), `--watch` | ✅ |
| TypeScript and Python SDKs; adapters for the Vercel AI SDK, OpenAI Agents SDK, Mastra, LangChain/LangGraph and the Anthropic tool runner, and in Python for Pydantic AI, the OpenAI Agents SDK, LangGraph and CrewAI, each tested against the real framework (pinned in CI on Linux, weekly against latest on Linux, macOS and Windows) | ✅ |
| MCP proxy: `tools/call` recorded, replayed and fenced; effects from tool annotations | ✅ |
| `shadowlap test` with JUnit, JSON and Markdown reports; `pack`/`unpack` with redaction on export; a committed golden recording replayed offline in CI | ✅ |
| False forks suppressed: dates and timestamps near each run's start match across days; `shadowlap calibrate` proposes normalizers by replaying offline until clean | ✅ |
| HTTP hosts declared in the config (vector databases, retrieval, internal APIs, webhooks) recorded as tools with effects, from `fetch`/`http` in Node and httpx/requests/botocore/urllib3 in Python | ✅ |
| `--prompt-from <call>`: a changed system prompt or tool set applies from a later model call, earlier calls replay from the recording; warns when earlier reasoning meets the new prompt | ✅ |
| Recordings as data: labels and notes (CLI and dashboard), full-text search across prompts, responses and tool calls, eval dataset export (JSONL, OpenAI chat, Braintrust, Langfuse), and what changed between two runs (system prompt, tools, model, code) | ✅ |
| Scopes for branches that run at once (`scope()` in TypeScript and Python, or `SHADOWLAP_SCOPE` when the branches are separate processes): repeats counted per scope so concurrent sub-agents keep their own answers on replay, and the dashboard's turns and timeline grouped by scope | ✅ |
| Recorded tests: a pytest plugin (xdist included), Vitest `globalSetup`/`setupFiles` with parallel workers, and node:test; record on the first run, replay offline after, fail with the diff; assertions on the tool calls and final answer; tested end to end with each runner | ✅ |
| Outcome checks for recordings: tool calls with counts and arguments, model and tool call counts, token and cost budgets, output and final answer text; recordings that fork on purpose and pass on their checks, repeated with a pass threshold | ✅ |
| `shadowlap blame`: the model call where a failed run was lost, by binary search over forks judged by the exit code and outcome checks; rescue by resampling or with another model; writes stubbed; probes that stop once settled, a scan past the boundary, a budget and JSON output; tested end to end against a scripted model | ✅ |
| `shadowlap verify`: a change accepted only when it fixes target and held-out failing runs and keeps every good run, each over several attempts; clean replays settled in one free attempt; changes in code, a request field or a tool (`--live-tool`); warnings for missing held-out or good runs and recordings that contradict their role; per-run token and cost delta; tested end to end against a scripted model | ✅ |
| `shadowlap blame --scope` and `repair --scope`: only the calls of one part of the agent are probed, so a simulated customer is never blamed; a replay that reaches its model around Shadowlap fails loudly instead of counting as clean | ✅ |
| The tau2-bench repair experiment (`experiments/tau-bench`): tasks recorded, failures blamed, grouped and split into dev and test halves, repaired per repairer, verified against a placebo; run end to end on a local model | ✅ run with hosted models ⬜ |
| `shadowlap repair`: blame, a repairer from any vendor (Anthropic SDK, or Chat Completions) proposing rewrites of spans that appear once in the source, case details screened out, candidates verified smallest first in the working tree with a crash journal, a model switch tried before any repairer; a patch, a pull request body and regression recordings, `--apply`, `--branch` (built without checkout) and `--pr`; tested end to end with a git repository, a bare remote and a stand-in `gh` | ✅ |
| GitHub Action: replays recordings, fails the check on divergence, job summary with the diff, pull request annotations; tested on Linux and Windows and when building the CLI from source | ✅ |
| Terminal UI: run tree with check results and labels, timeline with scopes, conversation at any call, playback at recorded pacing, diffs, actions palette, cost per call, and `o` to open the call in the dashboard | ✅ |
| `shadowlap export html <run>`: the dashboard's views as one file with the data built in, redaction applied, for a pull request or a CI artifact | ✅ |
| JSON for scripts and coding agents: `ls`, `show`, `search`, `diff`, `calibrate`, `label`, `blame`, `verify`, `repair` and `test --json`, `--summary-json` for `run` and `replay`, and a page of instructions to paste into `CLAUDE.md` or `AGENTS.md` | ✅ |
| Cost, model and stop reason per call (price table, overridable); cross-run `diff`; OpenTelemetry export; `rm`, `gc`, `doctor` | ✅ |
| Fidelity suite: the real `@anthropic-ai/sdk`, `openai` and `@google/genai` SDKs through the sidecar to scripted APIs; the reference agent in TypeScript and Python | ✅ |
| `shadowlap import litellm`: production traffic captured by a LiteLLM proxy in the request path, grouped into a run per correlation id, with credentials and the gateway's own body fields dropped — prompts never leave your infrastructure | ✅ |
| `shadowlap import har · nock · vcr`: model calls out of someone else's capture as a partial recording — credentials dropped, header text escaped and bounded, one call identity across all three formats, kinds the capture never saw run live on replay, writes still fenced; `shadowlap export har` is the reverse and round-trips | ✅ |
| The SDK wire protocol and the recordings protocol specified, with a conformance suite of fourteen scenarios run against a real sidecar for the TypeScript and Python clients, and for any third-party client | ✅ |
| Crashes, interrupts and commands that cannot start, through the CLI | ✅ |
| Packs treated as untrusted input: validated, hash-checked, symlink-safe; imported commands need consent in the CLI, terminal UI and dashboard; recorded text escaped in the terminal; owner-only store permissions | ✅ |
| Sidecar overhead per live call: p50 0.25 ms, p95 0.46 ms — `node testing/reference-agent/dist/bench.js`, five interleaved rounds on an **idle** machine; it prints the load average and says when the machine is too busy to believe (a loaded laptop reports 4× this) | ✅ |
| Scale: 300 model calls and 299 tool calls with a conversation growing to 0.7 MB record in 1.8 s into a 4.5 MB store (22× deduplication) and replay in 2.0 s (`scale.js`) | ✅ |
| Release rehearsal: every package published to a local npm registry, installed into an empty project and used end to end, and the Python wheel installed into a fresh virtual environment (`npm run release:rehearse`, also run by the release workflow before publishing) | ✅ |
| Anonymous telemetry client and a self-hostable collector (`packages/collector`), with Fly.io and Render configs | ✅ the CLI sends nothing; the project runs no collector |
| Landing page with the docs built in | ✅ not deployed |
| Dashboard at scale: with 500 runs and a 4,999-call run, the run list returns in 111 ms, the long run in 44 ms, and its call table renders in under 0.3 s (`scripts/dashboard-scale.mjs`) | ✅ |
| Local web dashboard (`shadowlap dashboard`): runs and forks, origin strip, call table, conversation at any call across providers, response playback, fork diffs, comparison, replay and fork actions, a run downloaded as one redacted HTML file; loopback only, session token, Host check, CSP, no network requests | ✅ |
| A real model server: the OpenAI Agents SDK on Ollama, recorded, replayed with the server unreachable, forked and run as a golden, weekly in CI (`examples/local-model`) | ✅ |
| Validation run against each hosted API (Anthropic, OpenAI, Gemini) | ⬜ |
| No external runtime dependencies in the engine, sidecar, SDKs, adapters or dashboard; one in the CLI; enforced by a test | ✅ |
| A store written by a newer Shadowlap is refused rather than read under stale assumptions, and `doctor` reports the version in the file | ✅ |
| Test files type-checked under the same strict settings as the source, in CI (`npm run typecheck:tests`) | ✅ |
| Published to npm and PyPI | ⬜ release workflow ready |

</details>

## Supply chain

Shadowlap sits in the model request path and holds recorded prompts, so what it pulls in is part of
what you are trusting. The engine, the sidecar, both SDKs, the framework adapters and the dashboard
have **no external runtime dependencies at all**; the CLI has one (`commander`); the Python SDK has
none and uses `urllib`. The terminal UI is the exception, with `ink` and `react`, and it is the one
component Shadowlap works without. The Anthropic SDK is an optional peer of the CLI: installed by you,
only to ask Claude for fixes with `shadowlap repair`, and never by npm on your behalf.

A test enforces this rather than trusting the sentence: a new dependency in any published package
fails CI until it is added to the list in `packages/cli/test/packaging.test.ts` deliberately.

## Privacy and telemetry

Recordings never leave your machine unless you export them, and they never contain credentials. Export with redaction (`shadowlap redact add --pattern email`, then `shadowlap pack`) before sharing one.

**Shadowlap collects nothing.** The CLI has no default telemetry endpoint and the project runs no collector, so nothing is sent anywhere. The telemetry client exists for teams who want their own numbers: point `SHADOWLAP_TELEMETRY_URL` at a collector you host (`packages/collector`) and it sends a random install id, versions, OS, CI system, which providers and SDK languages a run used, and per-run counts — never prompts, tool data, file paths, hostnames, run ids or model names. `SHADOWLAP_TELEMETRY=0` or `DO_NOT_TRACK=1` turns it off regardless. Details: [docs/telemetry.md](docs/telemetry.md).

## Documentation

| Guide | Covers |
|---|---|
| [Quickstart](docs/quickstart.md) | Record and replay the reference agent, then your own |
| [How it works](docs/how-it-works.md) | The sidecar, identity and matching, effects, thinking blocks, storage, the network guard |
| [CLI](docs/cli.md) · [SDKs](docs/sdk.md) · [Dashboard](docs/dashboard.md) · [Terminal UI](docs/tui.md) | Reference |
| [Frameworks](docs/frameworks.md) · [MCP servers](docs/mcp.md) · [Providers](docs/providers.md) | Integrations |
| [Interventions](docs/interventions.md) · [CI mode](docs/ci.md) · [Capturing production traffic](docs/gateways.md) · [Normalizers and redaction](docs/normalizers-and-redaction.md) | Workflows |
| [Why did my replay diverge?](docs/troubleshooting.md) | The page you'll visit most |
| [The wire protocol](docs/protocol.md) · [The recordings protocol](docs/recordings-protocol.md) · [The engine as a library](docs/engine.md) | Building on Shadowlap: an SDK for another language, an integration for another test runner |
| [Compared with other tools](docs/compare.md) | Cassettes, tracing platforms, framework time travel, durable execution |

## Contributing

Issues and pull requests are welcome; the most useful contribution right now is running Shadowlap against your own agent and reporting what diverged or confused you. There is no CLA. [CONTRIBUTING.md](CONTRIBUTING.md) covers setup, the test suites and what to expect from a part-time maintainer; report security issues privately as described in [SECURITY.md](SECURITY.md).

```sh
npm install && npm run build
npm test                 # unit tests, the fidelity suite, the golden replay, the Python agent
npm run site:build       # the landing page with the docs built in
npm run demo             # regenerate the README's terminal image (and scripts/readme-shots.mjs for the dashboard pictures)
```

## License

[Apache-2.0](LICENSE)
