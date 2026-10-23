# Frameworks

If your tools are defined through a framework, declare the effect once with an adapter. Execution is routed through `tool()` from `@shadowlap/sdk`; only the framework's *input* is recorded, never its context objects (run contexts, abort signals, tracing handles). API calls need no adapter at all, whatever the framework: the sidecar records them through the provider base URL.

The TypeScript adapters live in `@shadowlap/adapters` and the Python ones in `shadowlap.adapters`, part of the `shadowlap` package ([install](./sdk.md#install)). Both type the shapes they touch structurally and carry no framework dependencies.

A tool that brings outside text in (a page, an email, a ticket) can be marked untrusted where its effect is declared, so [`shadowlap injection`](./injection.md) plants payloads in what it returns: `{ effect: 'read', trust: 'untrusted' }` in TypeScript, `trust="untrusted"` to `with_effect` and `function_tool` in Python. Or mark it in the config without touching the code: `"tools": { "search_web": { "trust": "untrusted" } }` (see [untrusted reads](./sdk.md#untrusted-reads)).

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

Every executable tool needs an effect; `withEffects` throws listing the ones you forgot. Client-side tools (no `execute`) pass through. A streaming tool (`async *execute`) still streams: its progress values reach the UI as they come, its last value is recorded as the result the model is shown, and a replay yields that value alone. An aborted stream stops the tool, as it does without Shadowlap, and records the last value it had passed on.

## OpenAI Agents SDK

Wrap the definition before handing it to `tool()`.

```ts
import { tool } from '@openai/agents';
import { withEffect } from '@shadowlap/adapters/openai-agents';

const searchWeb = tool(withEffect({ name: 'search_web', description: 'Search', parameters, execute: async ({ query }) => search(query) }, 'read'));
```

## Mastra

```ts
import { createTool } from '@mastra/core/tools';
import { withEffect } from '@shadowlap/adapters/mastra';

export const searchWeb = createTool(withEffect({ id: 'search_web', description: 'Search', inputSchema, execute: async ({ query }, context) => search(query) }, 'read'));
```

For Mastra 1.x. The recorded input is the tool's input; the execution context (request context, tracing, agent and workflow handles) passes through. Mastra 0.x called `execute({ context, runtimeContext })`: import `withEffectV0` instead.

## LangChain and LangGraph

Wrap the tool instance; `ToolNode` invokes it as usual. The adapter records the step after LangChain has validated the input and before it builds the `ToolMessage`, so the recorded input is the parsed arguments (never the `ToolCall` envelope or its id) and replayed results come back as real `ToolMessage`s. Tool outputs must be JSON (strings, objects, or `[content, artifact]`).

```ts
import { tool } from '@langchain/core/tools';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { withEffect } from '@shadowlap/adapters/langchain';

const searchWeb = withEffect(tool(async ({ query }) => search(query), { name: 'search_web', schema }), 'read');
const tools = new ToolNode([searchWeb]);
```

## Anthropic tool runner

```ts
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { withEffect } from '@shadowlap/adapters/anthropic';

const searchWeb = betaZodTool(withEffect({ name: 'search_web', description: 'Search', inputSchema, run: async ({ query }) => search(query) }, 'read'));
const runner = client.beta.messages.toolRunner({ model: 'claude-opus-5', max_tokens: 1024, tools: [searchWeb], messages });
```

The runner's API calls are recorded through `ANTHROPIC_BASE_URL`; nothing else is needed.

## Claude Agent SDK

Its built-in tools (Bash, Write, Edit, Read, WebFetch and the rest) run inside Claude Code, where no wrapper reaches them, so they are recorded and fenced through the SDK's hooks. Add the hooks to the query's options, in TypeScript or Python:

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

`withFence` keeps the options' own hooks and adds its own after them. Outside Shadowlap every hook answers at once with nothing to change, so the same options serve production. Claude Code's model calls are recorded through `ANTHROPIC_BASE_URL`, like any Anthropic client's. It names its session in every request's `metadata.user_id`, which changes from one run to the next, so add one normalizer, once:

```sh
shadowlap normalize add --kind api --path '$.metadata.user_id' --replace '<session>'
```

| Tool | Effect | Recording | Replay | After a fork |
|---|---|---|---|---|
| Read, Glob, Grep | read | runs, and its output is recorded | runs as it is, and the model gets the recorded output | runs live, recorded |
| WebFetch, WebSearch | read | runs; the model call it makes to read the page or search is recorded too | runs as it is: its model call is answered from the recording while the page reads as it did; the model gets the recorded output | runs live |
| Write, Edit, MultiEdit | write | runs, recorded | a stand-in writes a new file in a temporary folder instead; the model gets the recorded output | refused (`--writes block`), or the stand-in runs and the model reads it as done (`--writes stub`) |
| Bash | write | runs, recorded with the folder it left the shell in | `true` runs instead, or `cd` to that folder; a recorded failure is reproduced by a command that prints its output and exits with its code | refused, or stubbed |
| NotebookEdit | write | runs, recorded | refused, since Claude Code takes no stand-in for it: the replay forks there | refused |

A refusal reaches the model as Claude Code words a hook's: `PreToolUse:Bash hook error: write tool Bash blocked after divergence (use --writes stub|allow to change this)`. A write is never run unrecorded: when the sidecar can't be asked, the fence refuses it, since this could be a replay, and a read runs unrecorded.

What hooks can't do, and what that means for a replay:

- **Claude Code checks a call against the files on disk before any hook runs.** A replay forks, safely, at a call that depends on what an earlier, fenced write would have changed: an Edit of a file the run created, or of text an earlier edit wrote. Claude Code refuses that call itself, the model reads the refusal, and the run goes on live from there with writes refused. Nothing reaches the files.
- **Some of what the model reads comes from the real call, not its output.** A Read's note about a file that isn't UTF-8, a background Bash command (`run_in_background`) and the output it sends later, and a recorded failure of a tool other than Bash replay as a fork at the next model call.
- **Tools not in the table run as they would.** Add another by the name Claude Code calls it: `withFence(options, { effects: { mcp__issues__search: 'read' } })`. A read runs and the model gets the recorded output; a write is refused on replay. To replay a remote MCP server's tools exactly, connect Claude Code to it through [`shadowlap mcp`](./mcp.md).
- **Permissions decide as they did.** A call that `canUseTool` or a permission rule refused while recording is recorded as not run. On replay a read is left to them to refuse again; a write is refused with Shadowlap's own words, so the run forks at the next model call.
- **Only the SDK's hooks are fenced.** Claude Code run on its own (`claude -p`) and Codex run their built-in tools where no SDK hook reaches: their model calls are recorded, their tools aren't, and a replay runs them again.

Tools of an in-process MCP server (`createSdkMcpServer`, `create_sdk_mcp_server`) run in the agent's own process: wrap them, and they are recorded and fenced like any SDK tool, under the name the model calls them by (`mcp__orders__issue_refund`). A write refused after a fork answers as a tool that failed, so the model reads the refusal and carries on.

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

## Python

Parameters a framework injects are never recorded, in any Python framework: a Pydantic AI `RunContext`, an OpenAI Agents `RunContextWrapper` or `ToolContext`, a LangChain `RunnableConfig`, callback manager or `Injected…` argument, Google ADK's `ToolContext`, a LlamaIndex workflow's `Context`. The SDK recognizes them by the types in their annotation: the class, a generic's arguments (`Optional[...]`, `RunContext[Deps]`) and `Annotated`'s markers (`Annotated[str, InjectedToolArg]`), never by its descriptions or values, so `Annotated[str, "Injected document text"]` and `Literal["InjectedFile", "Upload"]` are still recorded. Name any other with `exclude=(...)`. Typed arguments, as Pydantic AI documents them (a Pydantic model, a dataclass, a `datetime.date`, a UUID, an `Enum`), are the tool's real input and are recorded in their JSON form, as results are; an argument that can't be recorded fails before the tool runs, with a message naming it.

### Pydantic AI

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

### OpenAI Agents SDK (Python)

`function_tool` from the adapter is the SDK's own, with an effect. The SDK still builds the schema, validates the model's arguments and turns a blocked write into an error message for the model.

```python
from shadowlap.adapters.openai_agents import function_tool

@function_tool(effect="read")
async def search_web(ctx: RunContextWrapper[Deps], query: str) -> str:
    return await ctx.context.search(query)

@function_tool(effect="write", name_override="send_email")
def email(to: str, body: str) -> str: ...
```

### LangChain and LangGraph (Python)

Wrap tool instances; `ToolNode` and agents use them as usual. It works on `@tool` functions, `StructuredTool.from_function` and `BaseTool` subclasses. The recording holds the arguments after LangChain validated them, a replay returns a real `ToolMessage`, and a `content_and_artifact` tool gets its pair back as a tuple. A tool that returns a LangGraph `Command` (to update the graph's state) or a message such as a `ToolMessage` is recorded in a tagged JSON form, its messages as `messages_to_dict` writes them, and gets a real `Command` or message back on replay, so the state update happens again.

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

### Google ADK

Give ADK plain functions wrapped with `shadowlap.tool`; its `ToolContext` is left out of the recording. ADK fails a run when a tool raises, so give the agent `report_to_model` as its tool-error callback (or the runner `shadowlap_plugin()`): a write refused after a fork then reaches the model as the tool's answer, and the run carries on. Its Gemini calls are recorded through `GOOGLE_GEMINI_BASE_URL`.

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

### LlamaIndex

Make `FunctionTool`s from functions wrapped with `shadowlap.tool`. A workflow `Context` parameter is left out of the recording, and an agent such as `FunctionAgent` hands a blocked write to the model as the tool's error. The model calls are recorded through the provider's base URL, as LlamaIndex's Anthropic LLM reads `ANTHROPIC_BASE_URL`.

```python
from llama_index.core.tools import FunctionTool
from shadowlap import tool

@tool(effect="read")
async def search_web(ctx: Context, query: str) -> str: ...

agent = FunctionAgent(tools=[FunctionTool.from_defaults(async_fn=search_web), FunctionTool.from_defaults(fn=send_email)], llm=llm)
```

### Microsoft Agent Framework, Strands, smolagents and Agno

Give each framework functions wrapped with `shadowlap.tool`, the way it takes tools: Agent Framework and Agno take plain functions; Strands and smolagents take functions under their own `@tool`, with Shadowlap's underneath. Each reports a tool's error to its model, a blocked write included (Agent Framework says only that the function failed, unless its detailed errors are on). Their model calls are recorded through the provider's base URL.

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

### CrewAI

Wrap tool instances before giving them to an agent: `@tool` functions and `BaseTool` subclasses both work.

```python
from crewai.tools import tool
from shadowlap.adapters.crewai import with_effect

@tool("search_web")
def search_web(query: str) -> str:
    """Search the web for a query."""
    ...

researcher = Agent(role="Researcher", tools=[with_effect(search_web, "read"), with_effect(SendEmail(), "write")], ...)
```

Results are recorded as JSON. A tool that returns a Pydantic model, a dataclass or a date gets its JSON form back on replay, so frameworks that print a tool's result see the same text only if they print it the same way; return strings or dicts when that matters.

## Tested against

Every adapter but `withEffectV0`, for Mastra 0.x, runs in CI against the real framework, not a stand-in: record, a replay that executes nothing, and a fork that blocks the write, through the framework's own tool path (`generateText` with the AI SDK's mock model, the Agents SDK's `FunctionTool.invoke`, Mastra's `createTool`, LangGraph's `ToolNode`, the Anthropic tool runner end to end through the sidecar, a Pydantic AI `Agent` with `FunctionModel`, the Python Agents SDK's `Runner` with a scripted model, a compiled LangGraph graph in Python, CrewAI's `BaseTool.run`, and, with their model calls recorded through the sidecar in front of a scripted model API, Google ADK's `Runner`, a LlamaIndex `FunctionAgent`, a Microsoft Agent Framework `Agent` on Chat Completions, a Strands `Agent`, a smolagents `ToolCallingAgent` and an Agno `Agent`; and the Claude Agent SDK's `query()` in TypeScript and Python, running the Claude Code CLI it brings against a scripted Anthropic API: a recording that changes the project, a replay that sends no model request and leaves it as it was, and a fork that refuses every write). An agent on the AI SDK's Anthropic provider runs under `shadowlap run` as written, with no base URL in its code: `@ai-sdk/anthropic` reads `ANTHROPIC_BASE_URL` as a root that ends in `/v1` and sends `/messages` under it, and the sidecar takes that as the API's `/v1/messages`. Versions are pinned in `testing/frameworks/package.json` and the Frameworks workflow, and re-tested weekly against the latest releases, on Linux, macOS and Windows.

| Framework | Pinned version |
|---|---|
| Vercel AI SDK (`ai`) | 7.0.103 |
| Its Anthropic provider (`@ai-sdk/anthropic`) | 4.0.85 |
| OpenAI Agents SDK (`@openai/agents`) | 0.18.0 |
| Mastra (`@mastra/core`) | 1.67.0 (`withEffectV0` for 0.x: a unit test of 0.x's tool shape) |
| LangChain / LangGraph (`@langchain/core`, `@langchain/langgraph`) | 1.2.11 / 1.4.15 |
| Anthropic tool runner (`@anthropic-ai/sdk`) | 0.126.0 |
| Pydantic AI (`pydantic-ai-slim`) | 2.43.0 |
| OpenAI Agents SDK for Python (`openai-agents`) | 0.20.0 |
| LangGraph for Python (`langgraph`, `langchain-core`) | 1.2.11 / 1.6.3 |
| CrewAI (`crewai`) | 1.15.22 |
| Google ADK (`google-adk`) | 2.12.0 |
| LlamaIndex (`llama-index-core`, `llama-index-llms-anthropic`) | 0.14.25 / 0.12.3 |
| Microsoft Agent Framework (`agent-framework-core`, `agent-framework-openai`) | 1.23.0 / 1.17.0 |
| Strands Agents (`strands-agents`) | 1.62.0 |
| smolagents (`smolagents`) | 1.26.0 |
| Agno (`agno`) | 3.1.10 |
| Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`, `claude-agent-sdk`), with the Claude Code CLI each brings | 0.3.309 / 0.2.173, CLI 2.1.309 |

## Anything else

An adapter is a few lines: wrap the framework's execute function with `tool(name, { effect }, impl)` and record only the input. `wrapFirstArg` in `@shadowlap/adapters` does that for any `(input, ...rest)` signature. Open an issue naming the framework and we'll add it.

Tools served over MCP need no adapter at all: start the server through [`shadowlap mcp`](./mcp.md).
