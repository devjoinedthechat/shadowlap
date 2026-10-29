<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/lockup-dark.svg">
    <img src=".github/assets/lockup-light.svg" alt="Shadowlap" width="320">
  </picture>
</p>

<p align="center">
  <b>Change safety for agents.</b><br>
  Record, replay and fork AI agent runs: reproduce&nbsp;a&nbsp;failure&nbsp;exactly,<br>
  find the call that lost the&nbsp;run, and&nbsp;prove&nbsp;your&nbsp;fix&nbsp;holds&nbsp;before&nbsp;it&nbsp;ships.
</p>

<p align="center">
  <a href="https://github.com/devjoinedthechat/shadowlap/actions/workflows/ci.yml"><img src="https://github.com/devjoinedthechat/shadowlap/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/shadowlap"><img src="https://img.shields.io/npm/v/shadowlap?color=blue" alt="npm version"></a>
  <a href="https://pypi.org/project/shadowlap/"><img src="https://img.shields.io/pypi/v/shadowlap?color=blue" alt="PyPI version"></a>
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a> ·
  <a href="docs/index.md">Docs</a> ·
  <a href="docs/cli.md">CLI</a> ·
  <a href="docs/ci.md">CI</a> ·
  <a href="docs/compare.md">Compare</a>
</p>

Your agent refunded $240 it should have escalated. Run it again and it behaves, so you can't make it fail on demand or prove&nbsp;a&nbsp;fix&nbsp;worked.

Shadowlap records your agent's model calls and the tools you wrap, then replays your real code against the recording. Every call is answered from the recording, the refund included: nothing goes upstream and nothing happens twice. Change one thing and the run forks at the first request&nbsp;that&nbsp;differs.

<p align="center">
  <picture>
    <source media="(max-width: 600px) and (prefers-reduced-motion: reduce)" srcset=".github/assets/readme/terminal-narrow-static.svg" width="434">
    <source media="(max-width: 600px)" srcset=".github/assets/readme/terminal-narrow.svg" width="434">
    <source media="(max-width: 1279px) and (prefers-reduced-motion: reduce)" srcset=".github/assets/readme/terminal-medium-static.svg" width="637">
    <source media="(max-width: 1279px)" srcset=".github/assets/readme/terminal-medium.svg" width="637">
    <source media="(prefers-reduced-motion: reduce)" srcset=".github/assets/readme/terminal-static.svg">
    <img src=".github/assets/readme/terminal.svg" alt="A terminal session: shadowlap run records a support agent that refunds a $240 order; shadowlap replay reproduces it with 0 upstream requests; shadowlap blame finds the run was lost at model call #5, with high confidence; after a prompt fix, the replay forks with the diff of the system prompt and the check passes." width="880">
  </picture>
  <br>
  <sub>The real CLI, with scripted models standing in for Claude: lines&nbsp;left&nbsp;out&nbsp;or&nbsp;wrapped,&nbsp;none&nbsp;changed&nbsp;(<a href="scripts/demo-svg.mjs">source</a>).</sub>
</p>

## From failure to proof

The support agent refunds order&nbsp;A&#8209;1042 for $240, though its policy sends refunds above $100 to a manager. Two more $240 orders go&nbsp;the&nbsp;same&nbsp;way.

All three runs are labelled `refund-bug`. A fourth run refunds $60, within the limit, and is&nbsp;labelled&nbsp;`good`.

### Find the call that lost the run

[`shadowlap blame`](docs/blame.md) asks model calls again, each from a fork that replays everything before it. It names the last call whose new answer can still save the run. Here a passing run never calls `issue_refund`&nbsp;for&nbsp;$240:

```console
$ shadowlap blame 01M64J32D4 --expect @refund-check.json
…
⑂ The run was lost at model call #5 (3 of 5)
…

  Probes (gate: rescue at 60%+, lost at 10%-, <= 5% risk, up to 32 attempts;
          resample the probed call)
    #1  1 of 5  5 of 10 passed · rate >= 0.10 (99.1%)  rescued
    #5  3 of 5  5 of 10 passed · rate >= 0.10 (99.1%)  rescued  ◂ blamed
    #7  4 of 5  0 of 6 passed · rate <= 0.60 (99.1%)   lost
    #9  5 of 5  0 of 6 passed · rate <= 0.60 (99.1%)   lost
…
```

### Prove the fix

[`shadowlap repair`](docs/repair.md) asks a model, or your own Claude&nbsp;Code, to rewrite the system prompt or a tool description. It keeps the smallest rewrite that verify accepts twice, the second time with fresh attempts: one that fixes the failing runs, even held&#8209;out runs the model never saw, and leaves no good run 10&nbsp;points or more worse than before, at 5%&nbsp;risk a&nbsp;run. Here it rewrites one line of&nbsp;the&nbsp;system&nbsp;prompt:

```console
$ shadowlap repair --fixes label:refund-bug --keeps label:good \
>     --expect @refund-check.json --repairer anthropic
…
✓ Fixed: Escalate refunds above the policy limit
  agent.mjs · system prompt
  - You are a support agent. Follow the refund policy.
  + You are a support agent. Follow the refund policy: escalate every refund above the limit.

  Verified: fixes 2 of 2 target runs, 1 of 1 held-out, keeps 1 of 1 good,
            each failing run by its gate, which tells 90%+ from 70%- at <= 5%
            risk, and each good one against its baseline, which tells no drop
            from one of 10+ points at <= 5% risk
…
```

`--repairer anthropic` needs the Anthropic&nbsp;SDK beside&nbsp;the&nbsp;CLI:

```sh
npm install -g @anthropic-ai/sdk
```

`shadowlap verify` runs the same [proof](docs/verify.md) on a fix you write yourself, and exits&nbsp;0 only when it accepts the fix: 1&nbsp;when it rejects it, 3&nbsp;when it can't&nbsp;decide.

<p align="center">
  <picture>
    <source media="(max-width: 600px)" srcset=".github/assets/readme/dashboard-fix-phone.png" width="390">
    <source media="(max-width: 1279px)" srcset=".github/assets/readme/dashboard-fix-medium.png" width="640">
    <img src=".github/assets/readme/dashboard-fix.png" alt="The Shadowlap Fixes page for the applied fix 'issue_refund called with amount 240': blame found the runs were lost at model call #5, repair proposed the prompt change, and verify accepted it, with every failing run fixed and every good run kept against its baseline." width="880">
  </picture>
  <br>
  <sub>The same fix in the dashboard. A&nbsp;scripted&nbsp;model&nbsp;stands&nbsp;in&nbsp;for&nbsp;Claude&nbsp;(<a href="scripts/readme-shots.mjs">source</a>).</sub>
</p>

### Keep it fixed in CI

Blame opened fix `fx-01M64J3BR1` for this failure, and repair verified its patch. Apply it: the patch goes into your working tree, the fixed runs become goldens (recordings kept as tests), and those&nbsp;tests&nbsp;run.

```console
$ shadowlap fix apply fx-01M64J3BR1
⑂ Applying fx-01M64J3BR1 · issue_refund called with amount 240
…
    3 passed, 0 failed · 0 upstream requests
✓ fx-01M64J3BR1 applied: the patch is in the working tree,
  3 of 3 goldens copied to goldens/, shadowlap test passed
```

Commit the goldens with the patch. In CI, <code>shadowlap&nbsp;test</code> replays them offline, with no real key. It fails on a changed request, a live call, an error exit or a failed [check](docs/checks.md). On GitHub, add one step after checkout, Node&nbsp;setup and&nbsp;your&nbsp;build&nbsp;([full&nbsp;workflow](docs/ci.md#github-actions)):

```yaml
- uses: devjoinedthechat/shadowlap@v0.1.0
  with:
    version: 0.1.0
    recordings: goldens/*
```

With [`fix-on-failure`](docs/ci.md#fix-on-failure), the Action proposes a fix for a golden that fails a check, verifies it on the goldens that fail the same check, every other one held out from the model that wrote it, and on goldens that pass it, then opens a pull request whose checks start. On a pull request, it keeps one comment with each golden's&nbsp;verdict.

## Model and prompt changes

A second agent, `refund_agent.mjs`, handles the same order from support ticket&nbsp;T&#8209;8812. Before you move it to another model, [<code>shadowlap&nbsp;decisions</code>](docs/decisions.md) sends its recorded model calls to that model and shows which decisions&nbsp;change.

No tool runs. Each step is asked three times under the change and three times as recorded, so a change counts only when it shows beyond the model's own variation. Changes are ranked by what they do, writes first. Under a scripted Haiku, the agent no longer issues&nbsp;the&nbsp;refund:

```console
$ shadowlap decisions 01M64J4EMP --model claude-haiku-4-5
…
✗ 1 of 1 run decides a write or when to stop differently, under the model claude-haiku-4-5
  14 steps asked, 3 samples each and as many as recorded: 1 rank 1, 13 the same · no tool ran

01M64J4EMP  14 of 14 model calls asked · 1 changed, most: rank 1 (a write changed)
  #17   step 8  rank 1  issue_refund is no longer called · in 3 of 3 samples, 0 of 3 as recorded
         recorded issue_refund({"order_id":"A-1042","amount":240})
         now      queue_status({"team":"refunds-tier2"})  −8 tokens · −<$0.001
…
```

`shadowlap decisions --from-code` previews a prompt edit in your code the same way, and <code>shadowlap&nbsp;migrate</code> verifies and prices&nbsp;a&nbsp;model&nbsp;switch.

## Quickstart

See the whole loop first, with no key and nothing to clone, in about half a&nbsp;minute:

```sh
npx shadowlap demo
```

It records a refund agent breaking its policy, replays it with 0 upstream requests, finds the model call that lost the run, and has a fix proposed, proven and applied, against a scripted model on&nbsp;127.0.0.1.

Then install the CLI (Node&nbsp;22.16 or later, not&nbsp;23) and run `init` in your&nbsp;agent's&nbsp;folder:

```sh
npm install -g shadowlap
cd your-agent
shadowlap init
```

`init` finds your model SDKs, framework, agent command and tools, and prints your next steps. Model calls need no code changes, though a Node agent needs Node&nbsp;18.18 or later. Tools and tests use&nbsp;these&nbsp;packages:

```sh
# wrap tools (Node 18.18+)
npm install @shadowlap/sdk
# wrap them in your framework (Node 18.18+)
npm install @shadowlap/adapters
# record tests in Vitest, Jest or node:test (Node 22.16+, not 23)
npm install -D @shadowlap/test
# Python 3.9+: all three in one package
pip install shadowlap
```

Wrap each tool where you define it and declare its effect: `read`, `write` or `pure`. A tool you don't wrap runs for real on every replay: `run` names each one the model called, and every command that replays a run won't run one that writes, or one nothing says the effect of, until you wrap it, declare its effect under `tools.unrecorded`, or pass `--allow-unrecorded`. Outside Shadowlap the wrapper only calls your function, so wrapped tools&nbsp;ship&nbsp;unchanged:

```ts
import { tool } from '@shadowlap/sdk';

export const issueRefund =
  tool('issue_refund', { effect: 'write' }, refund);
```

```python
from shadowlap import tool

@tool(effect="read")
def lookup_order(order_id): ...
```

Then record a run, replay it and open&nbsp;the&nbsp;dashboard:

```sh
# record, with your usual key
shadowlap run -- node agent.mjs
# replay it; no real key if clean
shadowlap replay <run>
# step through it in your browser
shadowlap dashboard
```

## Dashboard and terminal UI

`shadowlap dashboard` opens your runs on 127.0.0.1. Fork from any call, or compare two runs side by side. A failed run opens where it first failed, its calls grouped under the model call each belongs to, and a fork's page says what the fork did differently, ranked as `shadowlap decisions` ranks a change. Edit a tool's result, or what a person answered, in the call inspector and fork&nbsp;from&nbsp;it.

One press labels a run good or bad, and `u` undoes it; a fix must leave each good run no worse than its own baseline, as `repair --keeps label:good` holds it, and Runs lists them with `label:good` and keeps its filters in the address. Large stores and long runs open at once: what reads every run or every call, the search index included, is worked out beside the server, and a long run's calls come a page at a time, from any depth, while the rest is&nbsp;read.

<p align="center">
  <picture>
    <source media="(max-width: 600px)" srcset=".github/assets/readme/dashboard-fork-phone.png" width="390">
    <source media="(max-width: 1279px)" srcset=".github/assets/readme/dashboard-fork-medium.png" width="640">
    <img src=".github/assets/readme/dashboard-fork.png" alt="The Shadowlap dashboard on a fork of the second agent's refund run: forked at call 17 after the lookup_policy result was overridden, the request as recorded and as sent, what the fork did differently (the refund no longer issued, the case escalated instead), and a strip of calls replayed, overridden, live and blocked." width="880">
  </picture>
  <br>
  <sub>What if <code>lookup_policy</code> had returned the EU limit? The&nbsp;run&nbsp;forks&nbsp;at&nbsp;call&nbsp;17&nbsp;(<a href="scripts/readme-shots.mjs">source</a>).</sub>
</p>

`shadowlap ui` shows your runs in the terminal, in the dashboard's colours on a dark or a light background: why a run failed, where blame found it lost and whether its fix held, where a fork left its parent and what it then did differently, and conversation, request, response and meta tabs for each call. Press&nbsp;`:` for the what&#8209;ifs at the selected call, and to blame, repair or verify the&nbsp;run:

```text
 01M64J4H6F fork @17 of 01M64J4EMP · 32 calls · 15 replayed · …
╭──────────────────────────────────────────────────────────────╮
│ Fork menu                                                    │
│ At #16 · lookup_policy · pure tool                           │
│ > o  Override this tool’s result             --override 16=… │
│   t  Answer with a tool error           --fail-at 16=timeout │
│   l  Force lookup_policy live      --live-tool lookup_policy │
│   a  Diverge here                            --diverge-at 16 │
│ The whole run                                                │
│   e  Repeat the replay and comp…                  --repeat 5 │
│   s  Stub the writes                           --writes stub │
│   b  Find the commit that chang…             bisect --good … │
│ Fixes                                                        │
│   B  Find the call it was lost …                       blame │
│   R  Repair the fix it fails in…                      repair │
│   V  Verify a change for the fi…                      verify │
│ ────────────────────────                                     │
│   r  Replay this run (clean if …                      replay │
│   p  Pack this run to a directo…                        pack │
│ The agent gets this instead of the recorded result. Calls b… │
╰──────────────────────────────────────────────────────────────╯
 a letter runs its action  enter run  j/k move  esc close
```

## How it works

`shadowlap run` starts a sidecar on 127.0.0.1 and points your agent&nbsp;at&nbsp;it:

```
shadowlap run -- node agent.mjs
│
├─ sidecar  127.0.0.1 on a free port, a token in every path
│  ├─ /anthropic/* /openai/* /gemini/*  model APIs
│  ├─ /bedrock/* /vertex/* /azure/*     cloud clients
│  ├─ /ai-gateway/*                     Vercel's AI Gateway
│  ├─ /http/*                           HTTP services
│  └─ /v1/calls/*                       tools, clock, randomness
├─ store    .shadowlap/shadowlap.db (SQLite), out of git
└─ agent    ANTHROPIC_BASE_URL, OPENAI_BASE_URL,
            GOOGLE_GEMINI_BASE_URL for the model SDKs;
            SHADOWLAP_URL, SHADOWLAP_RUN_ID for Shadowlap's SDKs
```

- **Matched by request, not order.** A call is identified by its request and by how many identical requests came before it, after your [normalizers](docs/normalizers-and-redaction.md) mask values such as&nbsp;ids. Parallel calls match in whatever order&nbsp;they&nbsp;arrive.
- **Forked at the first change.** After it, model calls and `read` tools run live; `write` tools are blocked unless you&nbsp;stub&nbsp;or&nbsp;allow&nbsp;them.

## Integrations

| Area | Works with |
|:---|:---|
| [Providers](docs/providers.md) | Anthropic, OpenAI, Gemini, Azure&nbsp;OpenAI, Claude on Microsoft&nbsp;Foundry, Vertex&nbsp;AI and Amazon&nbsp;Bedrock (OpenAI's SDK on it too); Vercel's AI&nbsp;Gateway; OpenAI&#8209;compatible servers (Ollama,&nbsp;vLLM, OpenRouter,&nbsp;Groq); and any gateway or host that speaks one of their formats, declared in&nbsp;the&nbsp;config |
| [SDKs](docs/sdk.md) | TypeScript and Python; any other language over the&nbsp;[wire&nbsp;protocol](docs/protocol.md) |
| [Frameworks](docs/frameworks.md) | TypeScript: Mastra, Vercel&nbsp;AI&nbsp;SDK, OpenAI&nbsp;Agents&nbsp;SDK, LangChain, LangGraph, Anthropic&nbsp;tool&nbsp;runner, Claude&nbsp;Agent&nbsp;SDK<br>Python: CrewAI, OpenAI&nbsp;Agents&nbsp;SDK, LangChain, LangGraph, Pydantic&nbsp;AI, Google&nbsp;ADK, LlamaIndex, Microsoft&nbsp;Agent&nbsp;Framework, Strands, smolagents, Agno, Claude&nbsp;Agent&nbsp;SDK |
| [Test suites](docs/testing.md) | pytest, Vitest, Jest and node:test; a test records&nbsp;once, then&nbsp;replays&nbsp;offline |
| [MCP](docs/mcp.md) | Servers over stdio or Streamable&nbsp;HTTP, recorded through the <code>shadowlap&nbsp;mcp</code> proxy, which your client reaches over stdio or, with <code>--listen</code>, over&nbsp;HTTP |
| [CI](docs/ci.md) | The GitHub Action; JUnit, JSON and Markdown reports for any&nbsp;other&nbsp;CI |
| [Coding&nbsp;agents](docs/agents.md) | Claude Code, Codex, Cursor and Copilot drive the CLI through its JSON&nbsp;output; <code>skill&nbsp;install</code> adds skills that set Shadowlap up and check every change |
| [Imports](docs/cli.md#import) | HAR, nock, VCR, LiteLLM, OpenTelemetry, Langfuse, LangSmith, Arize&nbsp;Phoenix, Logfire; every trace of a window at once from Langfuse, Phoenix and Logfire (<code>--since&nbsp;7d</code>) |
| [Exports](docs/cli.md#export-html) | Packs (a run as a folder), one&#8209;file HTML reports, HAR, OpenTelemetry, eval&nbsp;datasets and&nbsp;preference&nbsp;pairs |

## Security

- **Local only.** The sidecar and the dashboard listen on 127.0.0.1 behind a session token; recordings stay in your project, readable&nbsp;only&nbsp;by&nbsp;you.
- **Keys never stored.** API keys pass through to the provider; a clean replay needs no&nbsp;real&nbsp;key.
- **Masked on the way out.** Your redaction rules mask packs, exports, share links and what repair shows its model. Runs you push to your own bucket go as recorded, with no rule applied. No copy carries a&nbsp;credential.
- **No telemetry by default.** Nothing is sent unless `SHADOWLAP_TELEMETRY_URL` names a collector you run, and [what&nbsp;is&nbsp;sent](docs/telemetry.md) never includes prompts or tool&nbsp;data. `DO_NOT_TRACK=1` opts&nbsp;out.

[SECURITY.md](SECURITY.md) lists every safeguard and how to report&nbsp;a&nbsp;vulnerability.

## Documentation

| Topic | Pages |
|:---|:---|
| Start | [Introduction](docs/index.md)&nbsp;· [How&nbsp;it&nbsp;works](docs/how-it-works.md)&nbsp;· [Why&nbsp;replays&nbsp;diverge](docs/troubleshooting.md) |
| Recording | [SDKs](docs/sdk.md)&nbsp;· [Frameworks](docs/frameworks.md)&nbsp;· [Providers](docs/providers.md)&nbsp;· [MCP&nbsp;servers](docs/mcp.md)&nbsp;· [Production&nbsp;traffic](docs/gateways.md) |
| Fixes | [Blame](docs/blame.md)&nbsp;· [Repair](docs/repair.md)&nbsp;· [Verify](docs/verify.md)&nbsp;· [Gating](docs/gating.md)&nbsp;·&nbsp;[Decisions](docs/decisions.md) |
| Tests | [CI&nbsp;mode](docs/ci.md)&nbsp;· [Test&nbsp;suites](docs/testing.md)&nbsp;· [Injection&nbsp;tests](docs/injection.md)&nbsp;· [Checks](docs/checks.md)&nbsp;· [Error&nbsp;paths](docs/error-paths.md)&nbsp;·&nbsp;[Coverage](docs/coverage.md) |
| Reference | [CLI](docs/cli.md)&nbsp;· [Recording&nbsp;format](docs/recording-format.md)&nbsp;· [Interventions](docs/interventions.md)&nbsp;· [Dashboard](docs/dashboard.md)&nbsp;· [Terminal&nbsp;UI](docs/tui.md)&nbsp;·&nbsp;[Sharing&nbsp;runs](docs/team.md) |

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) covers setup and the&nbsp;test&nbsp;suites.

```sh
git clone https://github.com/devjoinedthechat/shadowlap
cd shadowlap && npm ci && npm run build
npx vitest run && npm run typecheck:tests
# regenerate the README's terminal, examples and pictures
npm run demo && node scripts/readme-shots.mjs
```

## License

[Apache-2.0](LICENSE). Shadowlap has no accounts to sign&nbsp;up&nbsp;for.
