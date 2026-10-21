# Quickstart

Install the CLI. It needs Node ≥ 22.13 (and Python ≥ 3.9 only for the Python SDK).

```sh
npm install -g shadowlap
```

## 1. Record and replay the reference agent

The repository ships a 30-call streaming agent (parallel tool calls, a write tool) and a scripted fake of the Anthropic API, so this needs no API key. Clone and build it first:

```sh
git clone https://github.com/devjoinedthechat/shadowlap
cd shadowlap
npm ci
npm run build
```

```sh
node testing/reference-agent/dist/mock-server.js &        # prints its URL, e.g. http://127.0.0.1:53188
export SHADOWLAP_UPSTREAM_ANTHROPIC=http://127.0.0.1:53188

shadowlap run -- node testing/reference-agent/dist/main.js
```

```
● Recorded 01M2NH0DMC753TA9M38B58EPQC: 30 calls (11 api, 17 tool, 2 clock/random), 11 upstream requests, ≈$0.072
```

Replay it unchanged:

```sh
shadowlap replay 01M2NH0DMC
```

```
✓ Replay clean: 30/30 calls replayed (11 api, 17 tool, 2 clock/random), 0 upstream requests, 12k input tokens not re-spent (≈$0.072)
```

Change something and replay again. The agent adds `AGENT_SYSTEM_SUFFIX` to its system prompt, which changes every request:

```sh
AGENT_SYSTEM_SUFFIX="Be brief." shadowlap replay 01M2NH0DMC
```

```
⑂ Forked at call 3: 2 calls replayed, then 21 live, 1 write blocked; 11 upstream requests (≈$0.072 spent, $0 saved)
  21 recorded calls left unused after the fork: #4 search_web, #6 POST /v1/messages, #7 fetch_page, …
✗ Diverged at call 3 (api POST /v1/messages): 2 calls replayed before divergence
  compared with run 01M2NH0DMC…, call 3
  ~ $.system
      - "You are a research agent. Use the tools, then email a summary."
      + "You are a research agent. Use the tools, then email a summary. Be brief."
```

The `send_email` tool at the end of the run was **blocked**: writes never re-execute after a fork unless you say so. Now a late change: force one tool live, as you would after fixing it:

```sh
shadowlap replay 01M2NH0DMC --live-tool search_web --writes stub
```

```
✗ Diverged at call 4 (tool search_web): 3 calls replayed before divergence
  forced live by --live-tool search_web
```

`shadowlap doctor` checks the setup if anything along the way behaves differently.

The same agent exists in Python (`pip install anthropic` first); it records, replays and forks the same way:

```sh
shadowlap run -- python testing/reference-agent/python/agent.py
```

Look at it:

```sh
shadowlap show 01M2NH0DMC
shadowlap ls --tree
shadowlap ui 01M2NH0DMC        # the terminal UI; press ? for keys, : for actions
```

## 2. Your own agent

Start with `shadowlap init` in the agent's directory. It finds your model SDKs, framework, agent command and tools, and prints the next steps with your project's names filled in:

```
Found
  TypeScript · pnpm · 3 source files
  Model SDKs: Anthropic (@ai-sdk/anthropic)
  Framework: Vercel AI SDK 7.0.103
  Agent command: pnpm agent (package.json scripts.agent: tsx src/agent.ts)
  Tools: 3 found, 1 with an effect

! src/llm.ts:2 sets the model base URL to https://llm-proxy.internal/anthropic. Shadowlap doesn't know that host, so calls through that client would not be recorded.
  Run with SHADOWLAP_UPSTREAM_ANTHROPIC=https://llm-proxy.internal/anthropic, or read the base URL from ANTHROPIC_BASE_URL.

1. Install
     pnpm add -D shadowlap
     pnpm add @shadowlap/sdk @shadowlap/adapters   tool effects, through your framework
```

With npm and pip, the packages are:

```sh
npm install @shadowlap/sdk          # tools, clock and randomness (Node 18+)
npm install @shadowlap/adapters     # framework adapters, next to the SDK
npm install -D @shadowlap/test      # recorded tests: Vitest, node:test
pip install shadowlap               # Python 3.9+: SDK, adapters, pytest plugin
```

Run the agent the way you always do, prefixed with `shadowlap run --`. API calls are captured with no code changes: `shadowlap run` sets `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL` and `GOOGLE_GEMINI_BASE_URL` for the child process, and the official SDKs read them.

```sh
shadowlap run -- python agent.py
shadowlap run -- node dist/agent.js --task "triage inbox"
```

Then wrap your tools so Shadowlap knows what they do to the world ([SDKs](./sdk.md), [frameworks](./frameworks.md)):

```ts
import { tool } from '@shadowlap/sdk';
export const sendEmail = tool('send_email', { effect: 'write' }, async (args) => mailer.send(args));
```

Replay with `shadowlap replay <run>`. If it diverges when you changed nothing, read [Why did my replay diverge?](./troubleshooting.md): the usual cause is a value the agent makes anew on every run, such as a request id. The report proposes the normalizer that fixes it, and `shadowlap calibrate` finds them all at once.

## 3. A real model, no key

[examples/local-model](https://github.com/devjoinedthechat/shadowlap/tree/main/examples/local-model) is an on-call triage agent built on the OpenAI Agents SDK. It runs Qwen 2.5 7B through [Ollama](https://ollama.com), so it needs no API key, and the model gets the task wrong in ways worth debugging:

```sh
ollama pull qwen2.5:7b
cd examples/local-model && npm install
export SHADOWLAP_UPSTREAM_OPENAI=http://127.0.0.1:11434
shadowlap run -- node agent.mjs
```

Its README walks through a recording in which the model claims to open three tickets without ever calling the tool, a replay with Ollama stopped, and a fork at that last call.

## 4. Against the real API

Drop `SHADOWLAP_UPSTREAM_ANTHROPIC`, set your API key as usual, and record the reference agent for real. Replay needs no key: a clean replay makes no outbound connections at all.

```sh
unset SHADOWLAP_UPSTREAM_ANTHROPIC
ANTHROPIC_API_KEY=sk-ant-… shadowlap run -- node testing/reference-agent/dist/main.js
shadowlap replay <run>
```

Recordings live in `./.shadowlap/` (created with a `.gitignore`) and never contain credentials. They do contain everything else the agent saw; see [redaction](./normalizers-and-redaction.md#redaction) before sharing one.
