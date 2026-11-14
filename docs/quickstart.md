# Quickstart

Install the CLI, see the whole loop in about half a minute, then record, replay and fork the bundled reference agent and your own. Each step shows the command and what it prints.

What each part needs:

| You run | It needs |
|---|---|
| The CLI | Node 22.16 or later, not 23 |
| An agent on Node | Node 18.18 or later |
| The Python SDK | Python 3.9 or later, only if you use it |

```sh
npm install -g shadowlap
```

## See the whole loop first

```sh
npx shadowlap demo
```

It needs no key and nothing to clone, only git, and takes about half a minute. In a folder of its own, which it removes at the end (`--keep <dir>` keeps it), the demo writes a support agent that refunds $240 orders its refund policy sends to a manager. Then it runs Shadowlap's own commands on it, each printing what it prints in your terminal:

1. `run` records the agent on three such orders and a $60 one.
2. `replay` answers the first from its recording with 0 upstream requests.
3. `blame` finds the model call that lost the run.
4. `repair` asks for rewrites, and keeps the one verify proves on the failing runs, one held out from the repairer, and the good run.
5. `fix apply` puts it in the agent, and turns the fixed runs into goldens whose test runs offline.

The model is a scripted server on 127.0.0.1 that speaks Anthropic's Messages API, and the demo says so. It prints, trimmed:

```text
⑂ The run was lost at model call #5 (3 of 5)
  …
  At #5  the recording   "Issuing the refund.", issue_refund({"order_id":"A-1042","amount":240})
         a rescued fork  "Above the limit.", escalate({"reason":"refund of $240 is above $100"})
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
✓ Done in 31 s, 929 requests to the scripted model, none to a real one.
  20 recorded the four runs, 120 were blame's attempts, each asking again from its fork on, 789 were repair's: blaming the other failing run, asking the repairer, and verify's attempts; the replay and the goldens' test sent none. A real model is paid for these, and not for what the forks replayed.
```

## 1. Record the reference agent

The repository ships a 30-call streaming agent (parallel tool calls, a write tool) and a scripted fake of the Anthropic API, so this needs no API key. Clone and build it first:

```sh
git clone https://github.com/devjoinedthechat/shadowlap
cd shadowlap
npm ci
npm run build
```

Start the scripted API, point Shadowlap at it, and record the agent:

```sh
node testing/reference-agent/dist/mock-server.js &        # prints its URL, e.g. http://127.0.0.1:53188
export SHADOWLAP_UPSTREAM_ANTHROPIC=http://127.0.0.1:53188

shadowlap run -- node testing/reference-agent/dist/main.js
```

It prints the run's id and what it recorded:

```text
…
● Recorded 01M2NH0DMC753TA9M38B58EPQC: 30 calls (11 api, 17 tool, 2 clock/random), 11 upstream requests, ≈$0.072
  shadowlap show 01M2NH0DMC
```

The same agent exists in Python (`pip install anthropic` first). It records, replays and forks the same way:

```sh
shadowlap run -- python testing/reference-agent/python/agent.py
```

## 2. Replay it

Replay the run unchanged:

```sh
shadowlap replay 01M2NH0DMC
```

Every call is answered from the recording, and nothing goes upstream:

```text
…
✓ Replay clean: 30/30 calls replayed (11 api, 17 tool, 2 clock/random), 0 upstream requests, 12.3k input tokens not re-spent (≈$0.072)
  shadowlap show 01M2NH0F3K
```

## 3. Change the prompt and fork

The agent adds `AGENT_SYSTEM_SUFFIX` to its system prompt, which changes every request. Replay with it set:

```sh
AGENT_SYSTEM_SUFFIX="Be brief." shadowlap replay 01M2NH0DMC
```

The run forks at the first request that changed, and the report shows the diff:

```text
…
⑂ Forked at call 3: 2 calls replayed, then 21 live, 1 write blocked; 11 upstream requests (≈$0.072 spent, $0 not re-spent)
  21 recorded calls left unused after the fork: #4 search_web, #6 POST /v1/messages, #7 fetch_page, …
✗ Diverged at call 3 (api POST /v1/messages): 2 calls replayed before divergence
  compared with run 01M2NH0DMC…, call 3
  ~ $.system
      - "You are a research agent. Use the tools, then email a summary."
      + "You are a research agent. Use the tools, then email a summary. Be brief."
  shadowlap show 01M2NH0G7R
```

The `send_email` tool at the end of the run was **blocked**: writes never re-execute after a fork unless you say so.

## 4. Force a tool live

Try a later change: force one tool live, as you would after fixing it, and stub the write:

```sh
shadowlap replay 01M2NH0DMC --live-tool search_web --writes stub
```

The run forks at that tool's call:

```text
…
⑂ Forked at call 4: 3 calls replayed, then 20 live, 1 write stubbed; 10 upstream requests (≈$0.066 spent, $0.0061 not re-spent)
  20 recorded calls left unused after the fork: #6 POST /v1/messages, #7 fetch_page, #8 fetch_page, …
✗ Diverged at call 4 (tool search_web): 3 calls replayed before divergence
  forced live by --live-tool search_web
  shadowlap show 01M2NH0H2W
```

If anything along the way behaves differently, `shadowlap doctor` checks the setup.

## 5. Look at the run

```sh
shadowlap show 01M2NH0DMC
shadowlap ls --tree
shadowlap ui 01M2NH0DMC        # the terminal UI; press ? for keys, : for actions
```

`show` prints the run's timeline, one row per call. `ls --tree` takes your 50 newest runs (`-n` sets how many) and lists them oldest first, each fork under the run it came from. `ui` opens the run in the [terminal UI](./tui.md).

## 6. Record your own agent

Start with `shadowlap init` in the agent's directory:

```sh
cd your-agent
shadowlap init
```

It finds your model SDKs, framework, agent command and tools, and prints the next steps with your project's names filled in:

```text
Found
  TypeScript · pnpm · 3 source files
  Model SDKs: Anthropic (@ai-sdk/anthropic)
  Framework: Vercel AI SDK 7.0.103
  Agent command: pnpm agent (package.json scripts.agent: tsx src/agent.ts)
  Tools: 3 found, 1 with an effect

! src/llm.ts:2 sets the model base URL to https://llm-proxy.internal/anthropic. Shadowlap doesn't know that host, so calls through that client would not be recorded.
  Run with SHADOWLAP_UPSTREAM_ANTHROPIC=https://llm-proxy.internal/anthropic, or read the base URL from ANTHROPIC_BASE_URL.

1. Install
     pnpm add @shadowlap/sdk @shadowlap/adapters   tool effects, through your framework
…
```

With npm and pip, the packages are:

```sh
# Node 18.18+
npm install @shadowlap/sdk         # wrap tools
npm install @shadowlap/adapters    # wrap them in your framework
# Node 22.16+, not 23
npm install -D @shadowlap/test     # record tests in Vitest, Jest or node:test
# Python 3.9+
pip install shadowlap              # all three in one package
```

Run the agent the way you always do, prefixed with `shadowlap run --`:

```sh
shadowlap run -- python agent.py
shadowlap run -- node dist/agent.js --task "triage inbox"
```

API calls are captured with no code changes: `shadowlap run` sets `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL` and `GOOGLE_GEMINI_BASE_URL` for the child process, and the official SDKs read them. It prints a summary like the one in step 1.

## 7. Wrap your tools and replay

Wrap your tools so Shadowlap knows what they do to the world ([SDKs](./sdk.md), [frameworks](./frameworks.md)):

```ts
import { tool } from '@shadowlap/sdk';
export const sendEmail = tool('send_email', { effect: 'write' }, async (args) => mailer.send(args));
```

Then replay the run:

```sh
shadowlap replay <run>
```

A clean replay prints `✓ Replay clean`, as in step 2. If it diverges when you changed nothing, read [Why did my replay diverge?](./troubleshooting.md): the usual cause is a value the agent makes anew on every run, such as a request id. The report proposes the normalizer that fixes it, and `shadowlap calibrate` finds them all at once.

## 8. Try a real model with no key

[examples/local-model](https://github.com/devjoinedthechat/shadowlap/tree/main/examples/local-model) is an on-call triage agent built on the OpenAI Agents SDK. It runs Qwen 2.5 7B through [Ollama](https://ollama.com), so it needs no API key, and the model gets the task wrong in ways worth debugging:

```sh
ollama pull qwen2.5:7b
cd examples/local-model && npm install
export SHADOWLAP_UPSTREAM_OPENAI=http://127.0.0.1:11434
shadowlap run -- node agent.mjs
```

Its README walks through a recording in which the model claims to open three tickets without ever calling the tool, a replay with Ollama stopped, and a fork at that last call.

## 9. Record against the real API

Drop `SHADOWLAP_UPSTREAM_ANTHROPIC`, set your API key as usual, and record the reference agent for real:

```sh
unset SHADOWLAP_UPSTREAM_ANTHROPIC
ANTHROPIC_API_KEY=sk-ant-… shadowlap run -- node testing/reference-agent/dist/main.js
shadowlap replay <run>
```

The replay needs no key: a clean replay makes no outbound connections at all.

**Note:** recordings live in `./.shadowlap/` (created with a `.gitignore`) and never contain credentials. They do contain everything else the agent saw: see [redaction](./normalizers-and-redaction.md#redaction) before sharing one.

## Next steps

- [Why did my replay diverge?](./troubleshooting.md): the causes of a divergence, and their fixes.
- [Blame](./blame.md), [repair](./repair.md) and [verify](./verify.md): find the call that lost a run, and prove a fix.
- [CI mode](./ci.md): keep a run as a golden, and replay it on every pull request.
- [CLI reference](./cli.md): every command and flag.
