# Frameworks

If your tools are defined through a framework, declare each tool's effect once with an adapter. This
page shows the setup for each framework Shadowlap supports, and what its recordings can and can't
do.

## Supported frameworks

Each framework's tool calls are recorded through the adapter or decorator in the setup column. Its
model calls need no adapter ([how adapters work](#how-adapters-work)).

| Framework | Language | How it's recorded | Setup |
|---|---|---|---|
| [Vercel AI SDK](#vercel-ai-sdk) | TypeScript | An adapter wraps each tool's `execute` | `withEffects` from `@shadowlap/adapters/ai-sdk` |
| [OpenAI Agents SDK](#openai-agents-sdk) | TypeScript | An adapter wraps the definition `tool()` takes | `withEffect` from `@shadowlap/adapters/openai-agents` |
| [Mastra](#mastra) | TypeScript | An adapter wraps the definition `createTool` takes | `withEffect` (`withEffectV0` for 0.x) from `@shadowlap/adapters/mastra` |
| [LangChain and LangGraph](#langchain-and-langgraph) | TypeScript | An adapter wraps the tool instance | `withEffect` from `@shadowlap/adapters/langchain` |
| [Anthropic tool runner](#anthropic-tool-runner) | TypeScript | An adapter wraps the definition `betaZodTool` takes | `withEffect` from `@shadowlap/adapters/anthropic` |
| [Claude Agent SDK](#claude-agent-sdk) | TypeScript | The SDK's hooks fence the built-in tools; an adapter wraps in-process MCP tools | `withFence` and `withEffects` from `@shadowlap/adapters/claude-agent-sdk` |
| [Pydantic AI](#pydantic-ai) | Python | Shadowlap's decorator, innermost | `tool` from `shadowlap` |
| [OpenAI Agents SDK](#openai-agents-sdk-python) | Python | The SDK's own `function_tool`, with an effect | `function_tool` from `shadowlap.adapters.openai_agents` |
| [LangChain and LangGraph](#langchain-and-langgraph-python) | Python | An adapter wraps the tool instance | `with_effect` from `shadowlap.adapters.langchain` |
| [Google ADK](#google-adk) | Python | Shadowlap's decorator on plain functions | `tool` from `shadowlap`, and `report_to_model` |
| [LlamaIndex](#llamaindex) | Python | Shadowlap's decorator, under `FunctionTool` | `tool` from `shadowlap` |
| [Microsoft Agent Framework](#microsoft-agent-framework) | Python | Shadowlap's decorator on plain functions | `tool` from `shadowlap` |
| [Strands](#strands) | Python | Shadowlap's decorator, under Strands' `@tool` | `tool` from `shadowlap` |
| [smolagents](#smolagents) | Python | Shadowlap's decorator, under smolagents' `@tool` | `tool` from `shadowlap` |
| [Agno](#agno) | Python | Shadowlap's decorator on plain functions | `tool` from `shadowlap` |
| [CrewAI](#crewai) | Python | An adapter wraps the tool instance | `with_effect` from `shadowlap.adapters.crewai` |
| [Claude Agent SDK](#claude-agent-sdk) | Python | The SDK's hooks fence the built-in tools; an adapter wraps in-process MCP tools | `with_fence` and `with_effects` from `shadowlap.adapters.claude_agent_sdk` |

[Tested against](#tested-against) lists the version of each framework CI runs. For a framework not
listed, see [anything else](#anything-else).

## How adapters work

- **Execution** is routed through `tool()` from `@shadowlap/sdk`. Only the framework's *input* is
  recorded, never its context objects (run contexts, abort signals, tracing handles).
- **Packages.** The TypeScript adapters live in `@shadowlap/adapters` and the Python ones in
  `shadowlap.adapters`, part of the `shadowlap` package ([install](./sdk.md#install)). Both type the
  shapes they touch structurally and carry no framework dependencies.
- **Model calls** need no adapter. Under `shadowlap run` the sidecar records them through the provider
  base URL a framework's client reads, or, for a client that reads none, by capturing the provider's
  host in the agent's process.
- **Hosts Shadowlap doesn't know.** A model the framework sends to such a host (Hugging Face's router,
  Groq) is recorded once the project's config
  [declares that host](./providers.md#hosts-of-another-providers-format) in the format it speaks.

**Untrusted tools.** A tool that brings outside text in (a page, an email, a ticket) can be marked
untrusted where its effect is declared, so [`shadowlap injection`](./injection.md) plants payloads in
what it returns: `{ effect: 'read', trust: 'untrusted' }` in TypeScript, `trust="untrusted"` to
`with_effect` and `function_tool` in Python. Or mark it in the config without touching the code:
`"tools": { "search_web": { "trust": "untrusted" } }` (see [untrusted reads](./sdk.md#untrusted-reads)).

## Vercel AI SDK

Tools are a record keyed by name; `withEffects` wraps each tool's `execute`.

```ts
import { tool } from 'ai';
import { withEffects } from '@shadowlap/adapters/ai-sdk';

const tools = withEffects(
  {
    search_web: tool({ description: 'Search', inputSchema: z.object({ query: z.string() }), execute: async ({ query }) => search(query) }),
    send_email: tool({ description: 'Email', inputSchema: z.object({ to: z.string(), body: z.string() }), execute: async (args) => mailer.send(args) }),
  },
  { search_web: 'read', send_email: { effect: 'write', onFork: () => ({ sent: false }) } },
);

await generateText({ model, tools, prompt });
```

- **Every executable tool needs an effect;** `withEffects` throws listing the ones you forgot.
  Client-side tools (no `execute`) pass through.
- **A streaming tool** (`async *execute`) still streams: its progress values reach the UI as they
  come, and every value it yields is recorded in order. A replay yields them again, the last of them
  the result the model is shown.
- **An aborted stream** stops the tool, as it does without Shadowlap, and the recording ends at the
  last value it had passed on.
- **After a fork,** a blocked write reaches the model as the tool's error, as the AI SDK passes on any
  tool that threw, and `generateText` or `streamText` goes on to the agent's answer.

### Model calls

The model calls need nothing more, whichever way the agent names its model:

| The agent names its model | Its calls |
|---|---|
| As a provider instance (`anthropic('claude-sonnet-4-5')` from `@ai-sdk/anthropic`) | Read its provider's base URL, which `shadowlap run` sets |
| As a string (`model: 'openai/gpt-5'`) | Go to Vercel's AI Gateway, which the AI SDK addresses itself, in its own format |

`shadowlap run` captures the gateway's calls in the process, and records them with their model, usage
and cost. A replay gets a placeholder `AI_GATEWAY_API_KEY`. Record, replay, forks, tests and checks
work on them as on any model call, and a tool the agent didn't wrap is found from the model's answers.

A change Shadowlap would make to the request itself takes a provider's own API. So for the gateway's
calls:

- `--inject`, `--set`, `--model` and `--prompt-from` are refused before anything runs;
- `decisions` and `migrate` leave the gateway's calls out, saying why.

## OpenAI Agents SDK

Wrap the definition before handing it to `tool()`.

```ts
import { tool } from '@openai/agents';
import { withEffect } from '@shadowlap/adapters/openai-agents';

const searchWeb = tool(withEffect({ name: 'search_web', description: 'Search', parameters, execute: async ({ query }) => search(query) }, 'read'));
```

- **Tool names.** A call is recorded under the name the model calls the tool by. `tool()` makes it
  from `name`, or from the `execute` function's own name when there is none, turning every character
  but a letter or a digit into `_`: `'lookup order'` is `lookup_order`, to the model and in the
  recording.
- **After a fork,** a blocked write reaches the model as the tool's output, in the words the SDK
  gives any tool that failed. `run()` goes on to the agent's answer, streamed (`{ stream: true }`) or
  not.
- **Trace export.** The SDK's trace export goes to `api.openai.com` while recording, as it does
  without Shadowlap; a replay answers it itself and stays clean.

## Mastra

```ts
import { createTool } from '@mastra/core/tools';
import { withEffect } from '@shadowlap/adapters/mastra';

export const searchWeb = createTool(withEffect({ id: 'search_web', description: 'Search', inputSchema, execute: async ({ query }, context) => search(query) }, 'read'));
```

- **Versions.** This is for Mastra 1.x. Mastra 0.x called `execute({ context, runtimeContext })`:
  import `withEffectV0` instead.
- **What is recorded.** The recorded input is the tool's input; the execution context (request
  context, tracing, agent and workflow handles) passes through.
- **Tool names.** An agent shows the model each tool under its key in `tools`, not its `id`, so a
  call an agent makes is recorded under that key: `tools: { searchWeb }` records `searchWeb`, the name
  a replay finds in the model's answers.
- **Other calls.** A call from anywhere else, a workflow step made from the tool
  (`createStep(searchWeb)`) or your own code, is recorded under the `id`.
- **After a fork,** a blocked write reaches an agent as the tool's error, which it hands the model,
  and the run goes on. A workflow has no model to tell: the step fails with `ShadowlapWriteBlocked`,
  and so does the run, unless the replay stubs writes (`--writes stub`).
- **Recording a served agent.** `mastra dev` and `mastra start` serve the agents and wait for
  requests, so record a script or a test that calls one
  (`await mastra.getAgent('support').generate('…')`).

### Model calls

The agent's model calls need nothing more. Mastra's model router builds the client for each model:

| Model | Its calls |
|---|---|
| `openai/…` | Recorded through `OPENAI_BASE_URL`, which `shadowlap run` sets |
| `anthropic/…` | Recorded through `ANTHROPIC_BASE_URL`, which `shadowlap run` sets |
| `google/…` | Captured in the process at Google's host |
| One the router sends elsewhere (`groq/…`, `openrouter/…`) | Not recorded: they go to a host Shadowlap doesn't know, and `shadowlap init` names any your agents use |

A replay's placeholder key goes in the variable the recording held it in,
`GOOGLE_GENERATIVE_AI_API_KEY` for Google.

## LangChain and LangGraph

Wrap the tool instance; `ToolNode` invokes it as usual.

```ts
import { tool } from '@langchain/core/tools';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { withEffect } from '@shadowlap/adapters/langchain';

const searchWeb = withEffect(tool(async ({ query }) => search(query), { name: 'search_web', schema }), 'read');
const tools = new ToolNode([searchWeb]);
```

- **What is recorded.** The adapter records the step after LangChain has validated the input and
  before it builds the `ToolMessage`. So the recorded input is the parsed arguments (never the
  `ToolCall` envelope or its id), and replayed results come back as real `ToolMessage`s.
- **Outputs.** Tool outputs must be JSON (strings, objects, or `[content, artifact]`), a LangGraph
  `Command` or a message.
- **Commands and messages.** A tool that returns a `Command` (to update the graph's state) or a
  message such as a `ToolMessage` is recorded in a tagged JSON form, its messages as `toDict()` writes
  them. It gets a real `Command` or message back on replay, made by the agent's own
  `@langchain/langgraph` and `@langchain/core`, so the state update happens again.
- **Agents.** The same tools go to `createAgent` from `langchain` or LangGraph's prebuilt
  `createReactAgent`, whose `ToolNode` runs them.
- **After a fork,** a blocked write reaches the model as the tool's message: both catch a tool's
  error by default (`handleToolErrors`), and the agent goes on to its answer, invoked or streamed.
  With `handleToolErrors: false` the block ends the run, as any tool error does.
- **Model calls.** `ChatOpenAI` and `ChatAnthropic` with no base URL in code take theirs from
  `OPENAI_BASE_URL` and `ANTHROPIC_BASE_URL`, as `shadowlap run` sets them. But they read
  `OPENAI_API_BASE` and `ANTHROPIC_API_URL` first: with either set, that model's calls bypass the
  sidecar, and the run says so.

## Anthropic tool runner

```ts
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { withEffect } from '@shadowlap/adapters/anthropic';

const searchWeb = betaZodTool(withEffect({ name: 'search_web', description: 'Search', inputSchema, run: async ({ query }) => search(query) }, 'read'));
const runner = client.beta.messages.toolRunner({ model: 'claude-opus-5', max_tokens: 1024, tools: [searchWeb], messages });
```

- **Model calls.** The runner's API calls are recorded through `ANTHROPIC_BASE_URL`, run to the end
  or streamed (`stream: true`); nothing else is needed.
- **After a fork,** a blocked write goes back to the model as a `tool_result` marked `is_error`.

## Claude Agent SDK

Its built-in tools (Bash, Write, Edit, Read, WebFetch and the rest) run inside Claude Code, where no
wrapper reaches them, so they are recorded and fenced through the SDK's hooks. Add the hooks to the
query's options, in TypeScript or Python:

```ts
import { query } from '@anthropic-ai/claude-agent-sdk';
import { withFence } from '@shadowlap/adapters/claude-agent-sdk';

for await (const message of query({ prompt, options: withFence({ cwd: project, permissionMode: 'acceptEdits' }) })) {
  // …
}
```

```python
from claude_agent_sdk import ClaudeAgentOptions, query
from shadowlap.adapters.claude_agent_sdk import with_fence

async for message in query(prompt=prompt, options=with_fence(ClaudeAgentOptions(cwd=project))):
    ...
```

- **Your own hooks.** `withFence` runs the options' own PreToolUse and PostToolUse hooks inside its
  own, and keeps their other hooks beside it.
- **Production.** Outside Shadowlap the fence answers as the options' own hooks would, so the same
  options serve production.
- **Model calls.** Claude Code's model calls are recorded through `ANTHROPIC_BASE_URL`, like any
  Anthropic client's.
- **Sessions.** Claude Code names its session, machine and account in every request's
  `metadata.user_id`, which differs in every session. Matching leaves that identifier out by itself,
  so a recording replays in the next session and on another machine with no normalizer. Another
  agent's `user_id` still counts.

### Built-in tools

While recording, each of these runs and is recorded. The model call WebFetch and WebSearch make to
read the page or search is recorded too, and Bash is recorded with the folder it left the shell in.

| Tool | Effect | On replay | After a fork |
|---|---|---|---|
| Read, Glob, Grep | read | Runs as it is, and the model gets the recorded output | Runs live, recorded |
| WebFetch, WebSearch | read | Runs as it is: its model call is answered from the recording while the page reads as it did; the model gets the recorded output | Runs live |
| Write, Edit, MultiEdit | write | A stand-in writes a file of its own in a temporary folder instead; the model gets the recorded output | Refused (`--writes block`), or the stand-in runs and the model reads it as done (`--writes stub`) |
| Bash | write | `true` runs instead, or `builtin cd` to the folder it left the shell in, past any `cd` function or alias the shell defines | Refused, or stubbed |
| NotebookEdit | write | Refused, since Claude Code takes no stand-in for it: the replay forks there | Refused |

- **A recorded Bash failure** is reproduced on replay by a command that prints its output and exits
  with its code.
- **A refusal** reaches the model as Claude Code words a hook's:
  `PreToolUse:Bash hook error: write tool Bash blocked after divergence (use --writes stub|allow to change this)`.
- **A write is never run unrecorded.** When the sidecar can't be asked, the fence refuses it, since
  this could be a replay, and a read runs unrecorded.

### What hooks can't do

Each limit, and what it means for a replay:

**Claude Code checks a call against the files on disk before any hook runs.** So a replay forks,
safely, at a call that depends on what an earlier, fenced write would have changed. That is an Edit of
a file the run created, or of text an earlier edit wrote. Claude Code refuses that call itself, the
model reads the refusal, and the run goes on live from there with writes refused; nothing reaches the
files.

**WebFetch fetches the page again.** No stand-in can take its place: Claude Code fetches over https
only, checks the page's domain with Anthropic before fetching, and summarizes the page in a model call
of its own, which the recording holds. So it runs as it is, a read like any other, and while the page
reads as it did, its model call is answered from the recording. Offline, or once the page changed,
the replay forks there.

**Some of what the model reads comes from the real call, not its output.** These replay as a fork at
the next model call:

- a Read's note about a file that isn't UTF-8;
- a background Bash command (`run_in_background`) and the output it sends later;
- a recorded failure of a tool other than Bash.

**Permissions decide as they did.** A call that `canUseTool` or a permission rule refused while
recording is recorded as not run. On replay a read is left to them to refuse again; a write is
refused with Shadowlap's own words, so the run forks at the next model call.

**Only the SDK's hooks are fenced.** Claude Code run on its own (`claude -p`) and Codex run their
built-in tools where no SDK hook reaches: their model calls are recorded, their tools aren't, and a
replay runs them again.

### Tools not in the table

Tools not in the table run as they would.

- **Add one** by the name Claude Code calls it: `withFence(options, { effects: { mcp__issues__search: 'read' } })`.
  A read runs and the model gets the recorded output; a write is refused on replay.
- **A remote MCP server's tools.** To replay them exactly, connect Claude Code to the server through
  [`shadowlap mcp`](./mcp.md).
- **A built-in left out of the table** is one the recording never holds a call of. Every command that
  replays the run [refuses it](./how-it-works.md#tools-shadowlap-did-not-record) when it writes
  (`PowerShell`, `Monitor`, `Artifact`, `SendMessage` and the others that run a command or send
  something out), naming the `effects` that record it.
- **No writes.** `Agent`, `Skill`, `AskUserQuestion`, `TodoWrite`, the plan mode's tools and the
  others that keep to the session are no writes.
- **Subagents.** A subagent's own calls go through the fence as the session's do.

### Other hooks on the same call

Claude Code runs every hook that matches a call at once, and takes a rewritten input from whichever
answers last. So a hook beside the fence could put back a recorded write's input, and the write would
run again.

So the options' own PreToolUse and PostToolUse hooks run inside the fence, first, in the order given,
each within its matcher's `timeout`:

- a refusal of theirs stands, and nothing runs;
- a rewrite of theirs is the input the call is recorded and replayed with;
- a PostToolUse rewrite applies to the recorded output as it did to the live one;
- the fence has the last word on what runs.

**Hooks read from files.** Claude Code runs the hooks it reads from files beside the fence, where
nothing can run them inside. The fence reads them where Claude Code's documentation says an SDK
session loads them
([Use Claude Code features in the SDK](https://code.claude.com/docs/en/agent-sdk/claude-code-features#control-filesystem-settings-with-settingsources),
[hook locations](https://code.claude.com/docs/en/hooks#hook-locations)):

| Under | The fence reads |
|---|---|
| `user` | `settings.json` in `CLAUDE_CONFIG_DIR` (else `~/.claude`), and the skills and subagents beside it |
| `project` | The session folder's `.claude/settings.json`; the `.claude/skills/` and `.claude/agents/` of that folder, each folder above it to the repository's root, and each in `additionalDirectories` |
| `local` | `.claude/settings.local.json` in the session's folder, at the root of the repository it is in, and for a linked worktree at the main checkout's root |

Whatever the sources, it also reads:

- the managed settings file, and every `*.json` in `managed-settings.d/` beside it;
- the organization's skills in `.claude/skills/` beside them;
- the options' `settings` (and a `--settings` given through `extraArgs`) and `managedSettings`;
- the `hooks/hooks.json`, skills and subagents of each local plugin in `plugins`.

Where the documentation leaves room:

- **The local file.** Here the documentation disagrees with itself: the Agent SDK's page names the
  session folder's alone, Claude Code's
  [settings page](https://code.claude.com/docs/en/settings#where-claude-code-keeps-the-local-file-in-a-git-repository)
  the root's, and in a worktree the main checkout's. The CLI the SDK bundles reads the root's, and the
  main checkout's, whenever its home folder exists, and the session folder's alone when it doesn't, so
  the fence reads all three.
- **A linked worktree** with no `.claude/skills/` or `.claude/agents/` of its own: the fence reads the
  main checkout's, as Claude Code's
  [skills page](https://code.claude.com/docs/en/skills#load-skills-in-monorepos-and-subdirectories)
  says of skills.
- **A skill's frontmatter hooks** run for the rest of the session once the skill is invoked, which can
  be at any turn, so the fence counts them from the start.
- **A subagent's hooks** run only while that subagent runs, so the fence counts them for that
  subagent's calls alone. A project subagent's run only in a folder you trusted, and the fence counts
  them all the same.

**A write such a hook picks.** A recorded write that one of their PreToolUse matchers picks is
refused on replay, in words that name the file, so the replay forks there. A recording says so when it
records such a write.

- **Unless `disableAllHooks`** turns that hook off as Claude Code resolves it (see
  [programs the CLI starts](#the-network-guard-and-the-claude-code-cli)). Where Claude Code may not
  read the value that would turn it off, the hook still refuses.
- **To keep it from refusing,** move that hook into the options' `hooks`, or leave its file out (its
  `settingSources` entry, or the plugin).

**Hooks the fence doesn't read beforehand** can't be refused that way:

- those of a plugin enabled from a marketplace;
- those of server-managed or MDM settings;
- those of a skill in a folder below the session's, which Claude Code loads once Claude works on files
  there.

When one replaces the fence's stand-in, the call has run for real. The fence checks what Claude Code
ran. It then hands the model what happened rather than the recording, records a stubbed call as not
stubbed, and stops the session, saying why.

### The network guard and the Claude Code CLI

The Claude Code CLI runs with no network guard. Both SDKs run Claude Code's native `claude` program,
which loads no Node or Python preload, so the [network guard](./how-it-works.md#the-network-guard)
can't watch a connection it makes itself. Its model calls go through Shadowlap
(`ANTHROPIC_BASE_URL`), and so does WebSearch, which asks the model API to search.

The fence tells the sidecar the CLI runs, as a preload says it loaded, with what the query leaves it
to reach. It works that out from the options `withFence` is given, and from the files Claude Code
reads its MCP servers from. Claude Code's documentation lists those files:
[MCP](https://code.claude.com/docs/en/mcp), [managed MCP](https://code.claude.com/docs/en/managed-mcp),
[what settingSources does not control](https://code.claude.com/docs/en/agent-sdk/claude-code-features#what-settingsources-does-not-control).

Each path is closed when:

| Path | Closed when |
|---|---|
| The model API, past Shadowlap | The CLI's `ANTHROPIC_BASE_URL` is the one Shadowlap gave the agent, and it runs on none of `CLAUDE_CODE_USE_BEDROCK`, `_VERTEX` or `_FOUNDRY` |
| WebFetch, which fetches each page itself | `disallowedTools` (`disallowed_tools`) has `WebFetch`, or a `tools` list leaves it out |
| An MCP server over the network (`http`, `sse`) | None is configured where the CLI reads one (below) |
| The claude.ai connectors | No claude.ai login brings them, or a setting turns them off (below) |
| Its nonessential traffic (updates, telemetry, error reports) | `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set, to any value but an empty one |
| A program the CLI starts | It is Python, or a stdio server is Shadowlap's own [`shadowlap mcp`](./mcp.md) (below) |
| An HTTP hook (`type: "http"`) | None is configured: the CLI posts it itself |
| Its OpenTelemetry export | `CLAUDE_CODE_ENABLE_TELEMETRY` is off, or no exporter is `otlp` (below) |

**An MCP server over the network.** The path is closed when both hold:

1. None is in `mcpServers`, `--mcp-config` (`extraArgs`) or a subagent of `agents`.
2. With `strictMcpConfig: true` (`strict_mcp_config=True`), Claude Code reads no others. Or else none
   is in a project's `.mcp.json` (under `project`), `.claude.json` in `CLAUDE_CONFIG_DIR` or the home
   folder (read whatever the sources), a local plugin, a subagent's frontmatter or the organization's
   `managedMcpServers`, and no settings file enables a plugin, whose servers the fence doesn't read.

An organization's `managed-mcp.json` takes MCP over: only its servers and the provided ones load.

**The claude.ai connectors.** No claude.ai login brings them when `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, an `apiKeyHelper`, `ANTHROPIC_PROFILE` or another provider is set. And
`strictMcpConfig`, `ENABLE_CLAUDEAI_MCP_SERVERS=false` or `disableClaudeAiConnectors: true` turns them
off.

**Nonessential traffic.** Under Shadowlap, `withFence` sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`
to `1` where the CLI reads it, the query's `env` or else the process's, unless it is set there
already. Outside Shadowlap it touches no environment.

**Programs the CLI starts:** a stdio MCP server, a command hook, or a settings file's
`apiKeyHelper`, `awsAuthRefresh`, `awsCredentialExport`, `gcpAuthRefresh` or `otelHeadersHelper`. A
Python one loads Shadowlap's preload from the `PYTHONPATH` the CLI passes on.

- **Node and native programs.** The CLI the SDK bundles passes its environment on to these but
  `NODE_OPTIONS`, so a Node program it starts (`node`, `npx`) loads no preload, and a native one never
  does.
- **Hooks** are read from every place the [hooks above](#other-hooks-on-the-same-call) are, of every
  event.
- **`disableAllHooks`** turns off those outside managed settings, and set in managed settings all of
  them. Claude Code takes it from the highest level that sets it, as any key
  ([settings precedence](https://code.claude.com/docs/en/settings#settings-precedence)): managed
  settings, the query's `settings`, the local file, the project's, the user's.
- **So a project's `false`** over the user's `true` leaves the hooks on.
- **A `true` Claude Code may not read** is not relied on; put it in the query's `settings` to be
  sure. Claude Code may not read one in:
  - the query's `managedSettings`, which it ignores on a machine with managed settings of its own;
  - a local file at the repository's root or the main checkout's, which it reads only with a home
    folder, off Windows, in a repository you own.

**Its OpenTelemetry export.** It is closed when `CLAUDE_CODE_ENABLE_TELEMETRY` is off, or no exporter
(`OTEL_METRICS_EXPORTER`, `OTEL_LOGS_EXPORTER`, and `OTEL_TRACES_EXPORTER` with the tracing beta) is
`otlp`. These are read from the environment and from the `env` of the user's, the organization's or
the query's settings: a repository's can't turn it on, as Claude Code's
[monitoring page](https://code.claude.com/docs/en/monitoring-usage) says. Turning nonessential traffic
off leaves it on.

#### When a path is left open

The run's summary names each path left open:

- **With none,** nothing the guard can't watch remains, and the run passes `--guard block`,
  `shadowlap test`'s default.
- **With any,** the run fails under block, naming them. The summary says the run was not watched, not
  that the agent exited with an error.

To pass under block:

- **Close each path** as the table says. Reach a remote MCP server through [`shadowlap mcp`](./mcp.md)
  as a stdio server (`"command": "shadowlap", "args": ["mcp", "--url", …]`), which records and fences
  its calls. A server of `type: 'http'` counts as one over the network, even at a
  `shadowlap mcp --listen` address.
- **Or accept the CLI as it is,** keeping block for every Node and Python process:
  `"guard": { "accept": ["claude-code"] }` in [`shadowlap.config.json`](./cli.md#the-configuration-file),
  the GitHub Action's `guard-accept: claude-code` ([CI](./ci.md#the-network-guard)), or
  `SHADOWLAP_GUARD_ACCEPT=claude-code`. The paths are still named.
- **Or accept every connection the guard can't watch** with `--guard warn` (the Action's
  `guard: warn`).

What the fence doesn't read can still open one:

- an `env` block in a settings file, which could point `ANTHROPIC_BASE_URL` elsewhere;
- a plugin enabled from a marketplace;
- an organization's server-managed or MDM settings;
- what a program the CLI starts runs in its turn, such as a Python hook's own `curl`.

Used by hand, `fenceHooks` (`fence_hooks`) knows only what its `query` option is given. Without it,
what the CLI reaches is unknown, and the run fails under block.

### In-process MCP servers

Tools of an in-process MCP server (`createSdkMcpServer`, `create_sdk_mcp_server`) run in the agent's
own process. Wrap them, naming the server by its key in the query's `mcpServers`, and they are
recorded and fenced like any SDK tool:

```ts
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { withEffects } from '@shadowlap/adapters/claude-agent-sdk';

const orders = createSdkMcpServer({ name: 'orders', version: '1.0.0', tools: withEffects('orders', [lookupOrder, issueRefund], { lookup_order: 'read', issue_refund: 'write' }) });
```

```python
from claude_agent_sdk import create_sdk_mcp_server
from shadowlap.adapters.claude_agent_sdk import with_effects

orders = create_sdk_mcp_server(name="orders", version="1.0.0", tools=with_effects("orders", [lookup_order, issue_refund], {"lookup_order": "read", "issue_refund": "write"}))
```

- **Names.** A call is recorded under the name the model calls the tool by
  (`mcp__orders__issue_refund`). Claude Code turns every character of either name but a letter, a
  digit, `_` and `-` into `_` in that name, and so does the name each adapter records a call under:
  the `look up` tool of `order desk` is `mcp__order_desk__look_up`.
- **After a fork,** a refused write answers as a tool that failed, so the model reads the refusal and
  carries on.

## Python

Parameters a framework injects are never recorded, in any Python framework:

| Framework         | Injected parameters                                          |
|-------------------|--------------------------------------------------------------|
| Pydantic AI       | A `RunContext`                                               |
| OpenAI Agents SDK | A `RunContextWrapper` or `ToolContext`                       |
| LangChain         | A `RunnableConfig`, callback manager or `Injected…` argument |
| Google ADK        | Its `ToolContext`                                            |
| LlamaIndex        | A workflow's `Context`                                       |

- **How they are found.** The SDK recognizes them by the types in their annotation: the class, a
  generic's arguments (`Optional[...]`, `RunContext[Deps]`) and `Annotated`'s markers
  (`Annotated[str, InjectedToolArg]`).
- **Never by descriptions or values,** so `Annotated[str, "Injected document text"]` and
  `Literal["InjectedFile", "Upload"]` are still recorded.
- **Any other** is named with `exclude=(...)`.
- **Typed arguments,** as Pydantic AI documents them (a Pydantic model, a dataclass, a
  `datetime.date`, a UUID, an `Enum`), are the tool's real input. They are recorded in their JSON
  form, as results are.
- **An argument that can't be recorded** fails before the tool runs, with a message naming it.

## Pydantic AI

Put Shadowlap's decorator innermost:

```python
from shadowlap import tool

@agent.tool
@tool(effect="read")
async def search_web(ctx: RunContext[Deps], query: str) -> dict:
    return await ctx.deps.search(query)

@agent.tool_plain
@tool(effect="write", on_fork=lambda to, body: {"sent": False})
def send_email(to: str, body: str) -> dict: ...
```

- **After a fork,** a blocked write is also Pydantic AI's `ToolFailed`: the model reads it as the
  tool's failed result, without being asked to retry, and the run carries on.
- **Your own handling.** `except ShadowlapWriteBlocked` still catches it.

## OpenAI Agents SDK (Python)

`function_tool` from the adapter is the SDK's own, with an effect.

```python
from shadowlap.adapters.openai_agents import function_tool

@function_tool(effect="read")
async def search_web(ctx: RunContextWrapper[Deps], query: str) -> str:
    return await ctx.context.search(query)

@function_tool(effect="write", name_override="send_email")
def email(to: str, body: str) -> str: ...
```

- **The SDK still does its part.** It builds the schema, validates the model's arguments and turns a
  blocked write into an error message for the model.

## LangChain and LangGraph (Python)

Wrap tool instances; `ToolNode` and agents use them as usual.

```python
from langchain_core.tools import tool
from langgraph.prebuilt import ToolNode
from shadowlap.adapters.langchain import with_effect

@tool
def search_web(query: str, state: Annotated[dict, InjectedState]) -> str:
    """Search the web."""
    ...

tools = ToolNode([with_effect(search_web, "read"), with_effect(SendEmail(), "write")])
```

- **Tool kinds.** It works on `@tool` functions, `StructuredTool.from_function` and `BaseTool`
  subclasses.
- **What is recorded.** The recording holds the arguments after LangChain validated them, a replay
  returns a real `ToolMessage`, and a `content_and_artifact` tool gets its pair back as a tuple.
- **Commands and messages.** A tool that returns a LangGraph `Command` (to update the graph's state)
  or a message such as a `ToolMessage` is recorded in a tagged JSON form, its messages as
  `messages_to_dict` writes them. It gets a real `Command` or message back on replay, so the state
  update happens again.
- **After a fork,** a blocked write is also LangGraph's `ToolInvocationError`, the one error
  `ToolNode` (and so `create_agent`) hands the model as an error `ToolMessage` as it comes, so the run
  carries on.
- **Without LangGraph** it is a `ToolException`, which LangChain reports to the model for a tool whose
  `handle_tool_error` is set. `except ShadowlapWriteBlocked` still catches it.

## Google ADK

Give ADK plain functions wrapped with `shadowlap.tool`.

```python
from google.adk.agents import LlmAgent
from shadowlap import tool
from shadowlap.adapters.google_adk import report_to_model

@tool(effect="read")
async def search_web(query: str, tool_context: ToolContext) -> dict: ...

@tool(effect="write")
def send_email(to: str, body: str) -> dict: ...

agent = LlmAgent(name="support", model="gemini-2.5-flash", tools=[search_web, send_email], on_tool_error_callback=report_to_model)
```

- **What is recorded.** Its `ToolContext` is left out of the recording.
- **After a fork.** ADK fails a run when a tool raises, so give the agent `report_to_model` as its
  tool-error callback (or the runner `shadowlap_plugin()`). A write refused after a fork then reaches
  the model as the tool's answer, and the run carries on.
- **Model calls.** Its Gemini calls are recorded through `GOOGLE_GEMINI_BASE_URL`.

## LlamaIndex

Make `FunctionTool`s from functions wrapped with `shadowlap.tool`.

```python
from llama_index.core.tools import FunctionTool
from shadowlap import tool

@tool(effect="read")
async def search_web(ctx: Context, query: str) -> str: ...

agent = FunctionAgent(tools=[FunctionTool.from_defaults(async_fn=search_web), FunctionTool.from_defaults(fn=send_email)], llm=llm)
```

- **What is recorded.** A workflow `Context` parameter is left out of the recording.
- **After a fork,** an agent such as `FunctionAgent` hands a blocked write to the model as the tool's
  error.
- **Model calls.** They are recorded through the provider's base URL, as LlamaIndex's Anthropic LLM
  reads `ANTHROPIC_BASE_URL`, or captured in the process: its default LLM, OpenAI's from
  `llama-index-llms-openai`, reads no `OPENAI_BASE_URL`.

## Microsoft Agent Framework

Give Agent Framework plain functions wrapped with `shadowlap.tool`.

```python
from agent_framework import Agent
from agent_framework.openai import OpenAIChatClient
from shadowlap import tool

@tool(effect="read")
async def search_web(query: str) -> str: ...

@tool(effect="write")
def send_email(to: str, body: str) -> str: ...

agent = Agent(client=OpenAIChatClient(model="gpt-5"), instructions="Research, then email the team.", tools=[search_web, send_email])
```

- **After a fork,** it reports a tool's error to its model, a blocked write included. It says only
  that the function failed, unless its detailed errors are on.
- **Model calls.** Agent Framework's OpenAI clients are recorded through `OPENAI_BASE_URL`.

## Strands

Give Strands functions under its own `@tool`, with Shadowlap's underneath.

```python
from strands import Agent, tool as strands_tool
from shadowlap import tool

@strands_tool
@tool(effect="write")
def send_email(to: str, body: str) -> str:
    """Send an email.

    Args:
        to: The address.
        body: The text.
    """
    ...

agent = Agent(model=model, tools=[search_web, send_email])
```

- **After a fork,** it reports a tool's error to its model, a blocked write included.
- **Model calls.** Its default model, `BedrockModel`, is captured in the process.

## smolagents

Give smolagents functions under its own `@tool`, with Shadowlap's underneath.

```python
from smolagents import ToolCallingAgent, tool as smol_tool
from shadowlap import tool

@smol_tool
@tool(effect="write")
def send_email(to: str, body: str) -> str:
    """Send an email.

    Args:
        to: The address.
        body: The text.
    """
    ...

agent = ToolCallingAgent(tools=[search_web, send_email], model=model)
```

- **After a fork,** it reports a tool's error to its model, a blocked write included. A `CodeAgent`,
  which calls the tools from the Python it writes, hands the model the error its code raised.
- **Its default model,** `InferenceClientModel`, calls Hugging Face's router. Declare it in the config,
  `"providers": [{ "host": "router.huggingface.co", "format": "openai", "root": "/v1" }]`, and its
  calls are recorded.
- **A replay** needs `HF_TOKEN` set to any `hf_` value, as the client won't start without one.

## Agno

Give Agno plain functions wrapped with `shadowlap.tool`.

```python
from agno.agent import Agent
from shadowlap import tool

@tool(effect="write")
def send_email(to: str, body: str) -> str: ...

agent = Agent(tools=[search_web, send_email])                   # its default model, OpenAIResponses
```

- **After a fork,** it reports a tool's error to its model, a blocked write included.
- **Model calls.** Agno's OpenAI clients, its default model's included, are recorded through
  `OPENAI_BASE_URL`.
- **Telemetry.** Agno sends usage telemetry to its own host, which the network guard reports:
  `AGNO_TELEMETRY=false` turns it off.

## CrewAI

Wrap tool instances before giving them to an agent: `@tool` functions and `BaseTool` subclasses both
work.

```python
from crewai.tools import tool
from shadowlap.adapters.crewai import with_effect

@tool("search_web")
def search_web(query: str) -> str:
    """Search the web for a query."""
    ...

researcher = Agent(role="Researcher", tools=[with_effect(search_web, "read"), with_effect(SendEmail(), "write")], ...)
```

- **Results** are recorded as JSON. A tool that returns a Pydantic model, a dataclass or a date gets
  its JSON form back on replay.
- **Printed results.** Frameworks that print a tool's result see the same text only if they print it
  the same way; return strings or dicts when that matters.

## Tested against

Every adapter but `withEffectV0`, for Mastra 0.x, runs in CI against the real framework, not a
stand-in. Each framework's own agent loop runs as a user writes it, on a real model client with
nothing in the agent naming Shadowlap, in front of a scripted model API. It runs one of two ways:

- through the CLI: `shadowlap run`, then `replay --strict`, then a fork on another request;
- for Google ADK and the case named last for a Python framework below, through a sidecar the test
  starts, with the base URLs `shadowlap run` sets.

In each, the recording holds the model's calls and every tool's under the name the model called it
by. The strict replay sends no request upstream and runs no tool. The fork runs the read again, blocks
the write, hands the model the refusal, and the run completes.

**TypeScript:**

- a Vercel AI SDK agent on `@ai-sdk/anthropic`, and on a model named by a string through Vercel's AI
  Gateway (`generateText` and `streamText`);
- an OpenAI Agents SDK `Agent` run by `run()` on its default provider, the Responses API, streamed
  and not;
- LangChain's `createAgent` and LangGraph's `createReactAgent` on `ChatOpenAI` and `ChatAnthropic`;
- a Mastra `Agent` on its model router (OpenAI's Responses API, Anthropic streamed, and Google), a
  Mastra workflow made of the tools, and the agent in a Vitest test under `recorded()`;
- the Anthropic tool runner, streamed and not;
- the Claude Agent SDK's `query()`, running the Claude Code CLI it brings, with built-in tools and an
  in-process MCP server's (`withEffects`).

**Python:**

- Pydantic AI on `Agent("openai:gpt-5")`;
- the OpenAI Agents SDK's `Runner` on its default client;
- LangChain's `create_agent` on `ChatOpenAI`;
- a CrewAI crew by `Crew.kickoff` on its `LLM`;
- Google ADK's `Runner` on Gemini;
- LlamaIndex's `FunctionAgent` on its default OpenAI LLM and on Anthropic;
- Microsoft Agent Framework on `OpenAIChatClient` (the Responses API) and on Chat Completions;
- Strands on its default `BedrockModel` and on Anthropic;
- smolagents' `CodeAgent` on OpenAI and on its default `InferenceClientModel` through a declared host,
  and a `ToolCallingAgent` on OpenAI;
- Agno on its default `OpenAIResponses` and on Claude;
- the Claude Agent SDK's `query()`.

Beside those, each adapter's own path runs with the framework's own pieces: the AI SDK's mock model
with streaming tools, `FunctionTool.invoke`, LangGraph's `ToolNode` with a tool that returns a
`Command`, Mastra's `createTool`, CrewAI's `BaseTool.run`, a compiled LangGraph graph.

An agent on the AI SDK's Anthropic provider runs under `shadowlap run` as written, with no base URL in
its code. `@ai-sdk/anthropic` reads `ANTHROPIC_BASE_URL` as a root that ends in `/v1` and sends
`/messages` under it, and the sidecar takes that as the API's `/v1/messages`.

Versions are pinned in `testing/frameworks/package.json` and the Frameworks workflow, and re-tested
weekly against the latest releases, on Linux, macOS and Windows:

| Framework | Pinned version |
|---|---|
| Vercel AI SDK (`ai`) | 7.0.103 |
| Its Anthropic provider (`@ai-sdk/anthropic`) | 4.0.85 |
| OpenAI Agents SDK (`@openai/agents`) | 0.18.0 |
| Mastra (`@mastra/core`) | 1.67.0 (`withEffectV0` for 0.x: a unit test of 0.x's tool shape) |
| LangChain / LangGraph (`@langchain/core`, `@langchain/langgraph`, `langchain`, `@langchain/openai`, `@langchain/anthropic`) | 1.2.11 / 1.4.15 / 1.5.11 / 1.5.13 / 1.5.10 |
| Anthropic tool runner (`@anthropic-ai/sdk`) | 0.126.0 |
| Pydantic AI (`pydantic-ai-slim`) | 2.43.0 |
| OpenAI Agents SDK for Python (`openai-agents`) | 0.20.0 |
| LangGraph for Python (`langgraph`, `langchain-core`, `langchain`, `langchain-openai`) | 1.2.11 / 1.6.3 / 1.4.3 / 1.6.2 |
| CrewAI (`crewai`) | 1.15.22 |
| Google ADK (`google-adk`) | 2.12.0 |
| LlamaIndex (`llama-index-core`, `llama-index-llms-anthropic`, `llama-index-llms-openai`) | 0.14.25 / 0.12.3 / 0.8.3 |
| Microsoft Agent Framework (`agent-framework-core`, `agent-framework-openai`) | 1.23.0 / 1.17.0 |
| Strands Agents (`strands-agents`) | 1.62.0 |
| smolagents (`smolagents`) | 1.26.0 |
| Agno (`agno`) | 3.1.10 |
| Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`, `claude-agent-sdk`), with the Claude Code CLI each brings | 0.3.309 / 0.2.173, CLI 2.1.309 |

## Anything else

An adapter is a few lines: wrap the framework's execute function with `tool(name, { effect }, impl)`
and record only the input. `wrapFirstArg` in `@shadowlap/adapters` does that for any
`(input, ...rest)` signature. Open an issue naming the framework and we'll add it.

Tools served over MCP need no adapter at all: start the server through [`shadowlap mcp`](./mcp.md).

## See also

- [SDKs](./sdk.md): `tool()`, effects, scopes and what a person types.
- [Providers](./providers.md): how each provider's model calls reach the sidecar.
- [MCP servers](./mcp.md): record tools served over MCP.
- [How it works](./how-it-works.md#the-network-guard): the network guard.
