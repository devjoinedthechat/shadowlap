<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/lockup-dark.svg">
    <img src=".github/assets/lockup-light.svg" alt="shadowlap" width="320">
  </picture>
</p>

<p align="center">
  <b>Change safety for agents.</b><br>
  Record, replay and fork AI agent runs: reproduce a failure exactly,<br>
  find the call that lost the run, and prove your fix holds before it ships.
</p>

<p align="center">
  <a href="https://github.com/devjoinedthechat/shadowlap/actions/workflows/ci.yml"><img src="https://github.com/devjoinedthechat/shadowlap/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/shadowlap"><img src="https://img.shields.io/npm/v/shadowlap?color=blue" alt="npm version"></a>
  <a href="https://pypi.org/project/shadowlap/"><img src="https://img.shields.io/pypi/v/shadowlap?color=blue" alt="PyPI version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License: Apache-2.0"></a>
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a> ·
  <a href="docs/index.md">Docs</a> ·
  <a href="docs/cli.md">CLI</a> ·
  <a href="docs/ci.md">CI</a> ·
  <a href="docs/compare.md">Compared&nbsp;with&nbsp;other&nbsp;tools</a>
</p>

---

Your agent refunded $240 it should have escalated. Run it again and it behaves: you can't make it fail on demand, so you can't prove a fix worked.

Shadowlap records your agent's model calls and the tools you wrap, then replays your real code against the recording. Every call is served from it, the refund included: nothing goes upstream and nothing happens twice. Change one thing and the run forks at the first request that differs.

<picture>
  <source media="(prefers-reduced-motion: reduce)" srcset=".github/assets/readme/terminal-static.svg">
  <img src=".github/assets/readme/terminal.svg" alt="A terminal session: shadowlap run records a support agent that refunds a $240 order; shadowlap replay reproduces it with 0 upstream requests; shadowlap blame finds the run was lost at model call #5; after a prompt fix, the replay forks with the diff of the system prompt and the check passes." width="880">
</picture>

<p align="center"><sub>The real CLI on the demo's support agent, with scripted models (<a href="scripts/demo-svg.mjs">source</a>). Some lines are left out, none changed.</sub></p>

## From failure to proof

One order, start to finish, against the demo's scripted models. The support agent refunds order A-1042 for $240, though its policy sends refunds above $100 to a manager.

### Find the call that lost the run

A run goes wrong before it visibly fails. Blame asks model calls again, each from a fork that replays everything before it. It names the last one whose new answer can still save the run. Here a passing run never calls `issue_refund` for $240:

```console
$ shadowlap blame 01M5AQ6Q1G \
    --expect '{"tools":{"issue_refund":{"count":0,"args":{"amount":240}}}}'
…
⑂ The run was lost at model call #5 (3 of 5)
  …
  Probes (gate: rescue at 60%+, lost at 10%-, <= 5% risk, up to 20 attempts; resample the probed call)
    #1  1 of 5  4 of 8 passed · rate >= 0.22 (95%)  rescued
    #5  3 of 5  4 of 8 passed · rate >= 0.22 (95%)  rescued  ◂ blamed
    #7  4 of 5  0 of 4 passed · rate <= 0.49 (95%)  lost
    #9  5 of 5  0 of 4 passed · rate <= 0.49 (95%)  lost
  …
```

### Prove the fix

Repair asks a model you choose, or your own Claude Code, to rewrite the system prompt or a tool description. It keeps the smallest rewrite that fixes the failing runs, held-out ones too, and breaks no good run.

```console
$ shadowlap repair --fixes label:refund-bug --keeps label:good \
    --expect '{"tools":{"issue_refund":{"count":0,"args":{"amount":240}}}}' \
    --repairer anthropic
…
✓ Fixed: Escalate refunds above the policy limit
  agent.mjs · system prompt
  - You are a support agent. Follow the refund policy.
  + You are a support agent. Follow the refund policy: escalate every refund above the limit it sets.

  Verified: fixes 2 of 2 target runs, 1 of 1 held-out, keeps 1 of 1 good, each by its gate, which tells 90%+ from 70%- at <= 5% risk
  …
```

<img src=".github/assets/readme/dashboard-fix.png" alt="The Shadowlap Fixes page for 'Refunds above the limit issued without approval': lost at model call #5, a prompt repair, and verify's verdict that every failing run is fixed and every good run kept." width="880">

<p align="center"><sub><code>anthropic:claude-opus-5-5</code> is the model repair asked for; in the demo, a scripted model answered.</sub></p>

`shadowlap verify` gives a fix you wrote yourself the same [proof](docs/verify.md), and exits 1 when it rejects.

### Keep it fixed in CI

Apply the fix blame opened: the patch goes in, the fixed runs become goldens, and their tests run.

```console
$ shadowlap fix apply fx-01M5AQ75TG
⑂ Applying fx-01M5AQ75TG · issue_refund called with amount 240
  applied .shadowlap/repairs/repair-mvfljq9t/fix.patch
  copied goldens/01M5AQ6Q1G
  copied goldens/01M5AQ6Y2E
  copied goldens/01M5AQ6XTR
  shadowlap test goldens/01M5AQ6Q1G goldens/01M5AQ6Y2E goldens/01M5AQ6XTR
    …
    3 passed, 0 failed · 0 upstream requests
✓ fx-01M5AQ75TG applied: the patch is in the working tree, 3 of 3 goldens copied to goldens, shadowlap test passed
```

Commit the goldens with the fix. In CI, `shadowlap test` replays them offline and fails on a changed request, a live call, an error exit or a failed [check](docs/checks.md). On GitHub it is one step:

```yaml
- uses: devjoinedthechat/shadowlap@main
  with:
    recordings: goldens/*
```

With [`fix-on-failure`](docs/ci.md#fix-on-failure), the Action proposes a fix for a golden that fails a check, and opens a pull request once verify accepts it. Goldens can gate on [prompt injection](docs/injection.md) too.

### Change models and prompts safely

Before moving the demo's ticket agent to another model, ask its recorded model calls again under that model. No tool runs; changes are ranked by consequence, writes first:

```console
$ shadowlap decisions 01M5AQA11J --model claude-haiku-4-5
…
✗ 1 of 1 run decides a write or when to stop differently, under the model claude-haiku-4-5
  14 steps asked: 1 rank 1, 13 the same · no tool ran

01M5AQA11J  14 of 14 model calls asked · 1 changed, most: rank 1 (a write changed)
  #17   step 8  rank 1  issue_refund is no longer called
         recorded issue_refund({"order_id":"A-1042","amount":240})
         now      queue_status({"team":"refunds-tier2"})  −8 tokens · −<$0.001
  …
```

`shadowlap decisions --from-code` previews a prompt edit the same way. `shadowlap migrate --to <model>` verifies and prices a switch.

## Quickstart

Install the CLI (Node 22.13 or later), then let it read your project:

```sh
npm install -g shadowlap
cd your-agent
shadowlap init
```

`init` finds your model SDKs, framework, agent command and tools, and prints your next steps. Model calls need no code changes. Wrap each tool once with its effect, or it runs again on every replay:

```sh
npm install @shadowlap/sdk          # tools, clock and randomness (Node 18+)
npm install @shadowlap/adapters     # framework adapters, next to the SDK
npm install -D @shadowlap/test      # recorded tests: Vitest, node:test
pip install shadowlap               # Python 3.9+: SDK, adapters, pytest plugin
```

```ts
import { tool } from '@shadowlap/sdk';

export const issueRefund = tool('issue_refund', { effect: 'write' }, refund);
```

```python
from shadowlap import tool

@tool(effect="read")
def lookup_order(order_id: str) -> dict: ...
```

Outside Shadowlap the wrapper is a passthrough, so it ships unchanged. Then record, replay and look:

```sh
shadowlap run -- node agent.mjs    # record a run, with your usual key
shadowlap replay <run>             # replay it: 0 upstream requests, no real key
shadowlap dashboard                # step through it in your browser
```

## Dashboard and terminal UI

`shadowlap dashboard` opens your runs on 127.0.0.1. Fork from any call, or compare two runs side by side.

<img src=".github/assets/readme/dashboard-fork.png" alt="The Shadowlap dashboard on a fork of the ticket agent's refund run: forked at call 17 after the lookup_policy result was overridden, the recorded and the new request side by side, and a strip of calls replayed, overridden, live and blocked." width="880">

<p align="center"><sub>The ticket agent on the same order: what if <code>lookup_policy</code> had returned the EU limit?<br>The run forks at call 17, and the agent escalates.</sub></p>

`shadowlap ui` shows them in the terminal: a timeline, and an inspector with conversation, request, response and meta tabs. Its `:` menu lists the what-ifs for the call in front of you:

```text
 01M5AQA1NB fork @17 of 01M5AQA11J · 32 calls · 15 replayed · 14 live · 2 block…
╭──────────────────────────────────────────────────────────────────────────────╮
│ Actions                                                                      │
│ At #16 · lookup_policy · pure tool                                           │
│ > o Override this tool’s result                   --override 16=…            │
│   t Answer with a tool error                      --fail-at 16=timeout       │
│   l Force lookup_policy live                      --live-tool lookup_policy  │
│   a Diverge here                                  --diverge-at 16            │
│ The whole run                                                                │
│   e Repeat the replay and compare                 --repeat 5                 │
│   s Stub the writes                               --writes stub              │
│   b Find the commit that changed it               bisect --good …            │
│ ────────────────────────                                                     │
│   r Replay this run (clean if nothing changed)    replay                     │
│   p Pack this run to a directory (redaction rul…  pack                       │
│ The agent gets this instead of the recorded result. Calls before it replay.  │
│ Enter or the letter to run · Esc to close                                    │
╰──────────────────────────────────────────────────────────────────────────────╯
 : actions · / search · [ ] jump · o dashboard · y copy · w write · p parent · …
```

## How it works

```
shadowlap run -- node agent.mjs
│
├── sidecar   127.0.0.1 on a free port, the session's token in every path
│   ├── /anthropic/*  /openai/*  /gemini/*   model APIs, streams byte for byte
│   ├── /bedrock/*  /vertex/*  /azure/*      clients captured in Node and Python
│   ├── /http/*                              HTTP services in the config
│   └── /v1/calls/*                          tools, clock and randomness
├── store     .shadowlap/shadowlap.db (SQLite), in your project, out of git
└── agent     ANTHROPIC_BASE_URL, OPENAI_BASE_URL, GOOGLE_GEMINI_BASE_URL
              SHADOWLAP_URL, SHADOWLAP_RUN_ID for the Shadowlap SDKs
```

- **Matched by what they ask.** A call is known by its request after your [normalizers](docs/normalizers-and-redaction.md) and how many identical ones came before it. Arrival order never counts, so parallel calls replay in any order.
- **Forked at the first change.** After it, model calls and `read` tools run live, and `write` tools are blocked unless you stub or allow them.

## Integrations

| Area | Works with |
|---|---|
| [Providers](docs/providers.md) | Anthropic, OpenAI and compatible servers (Ollama, vLLM, OpenRouter, Groq), Gemini, Azure OpenAI, Vertex AI, Amazon Bedrock |
| [SDKs](docs/sdk.md) | TypeScript and Python; any other language over the [wire protocol](docs/protocol.md) |
| [Frameworks](docs/frameworks.md) | Vercel AI SDK, OpenAI Agents SDK, Mastra, LangChain and LangGraph, the Anthropic tool runner; in Python, OpenAI Agents SDK, LangChain and LangGraph, CrewAI, Pydantic AI; each adapter is tested against the framework itself |
| [Test suites](docs/testing.md) | pytest, Vitest and node:test: a test records once, then replays offline |
| [MCP](docs/mcp.md) | Servers over stdio or Streamable HTTP, behind `shadowlap mcp` |
| [CI](docs/ci.md) | The GitHub Action; JUnit, JSON and Markdown reports for any other CI |
| [Coding agents](docs/agents.md) | Claude Code, Cursor and Codex drive the CLI through its JSON; `shadowlap skill install` adds the plugin or the rule |
| [Imports](docs/cli.md#import) | HAR, nock, VCR, LiteLLM, OpenTelemetry, Langfuse, LangSmith |
| [Exports](docs/cli.md#export-html) | Packs, one-file HTML reports, HAR, OpenTelemetry, eval datasets, preference pairs |

## Security

- **Local only.** The sidecar and the dashboard listen on 127.0.0.1 behind a session token, and recordings stay in your project, readable only by you.
- **Keys pass through** to the provider and are never stored; a clean replay needs no real key.
- **Masked on the way out.** Your redaction rules mask packs, exports, share links and what repair shows its model. A push to your own bucket sends runs as recorded.

[SECURITY.md](SECURITY.md) lists every check and how to report a vulnerability.

### Telemetry

Off unless `SHADOWLAP_TELEMETRY_URL` names a collector; the project runs none. When on, it sends anonymous counts and versions, never prompts or tool data, and `DO_NOT_TRACK=1` turns it off ([every field](docs/telemetry.md)).

## Documentation

| Topic | Pages |
|---|---|
| Start | [Introduction](docs/index.md), which maps every page · [How it works](docs/how-it-works.md) · [Why did my replay diverge?](docs/troubleshooting.md) |
| Recording | [SDKs](docs/sdk.md) · [Frameworks](docs/frameworks.md) · [Providers](docs/providers.md) · [MCP servers](docs/mcp.md) · [Production traffic](docs/gateways.md) |
| Fixes | [Blame](docs/blame.md) · [Repair](docs/repair.md) · [Verify](docs/verify.md) · [Gating](docs/gating.md) · [Decisions](docs/decisions.md) |
| Tests | [CI mode](docs/ci.md) · [Checks](docs/checks.md) · [Test suites](docs/testing.md) · [Injection tests](docs/injection.md) · [Error paths](docs/error-paths.md) · [Coverage](docs/coverage.md) |
| Reference | [CLI](docs/cli.md) · [Interventions](docs/interventions.md) · [Dashboard](docs/dashboard.md) · [Terminal UI](docs/tui.md) · [Recording format](docs/recording-format.md) · [Sharing runs](docs/team.md) |

## Contributing

Issues and pull requests are welcome, above all a run of yours that diverged or confused you; [CONTRIBUTING.md](CONTRIBUTING.md) covers setup and the test suites.

```sh
git clone https://github.com/devjoinedthechat/shadowlap && cd shadowlap
npm ci && npm run build
npx vitest run && npm run typecheck:tests
```

`node scripts/demo-store.mjs <folder>` builds the demo project behind every example here.

## License

[Apache-2.0](LICENSE). Nothing in this repository needs an account.

Organisation features (setup on your infrastructure, evidence reports for your auditors, support with an SLA) are offered to regulated teams through paid pilots. [Talk to an engineer](https://github.com/devjoinedthechat/shadowlap/issues/new?template=pilot.md).
