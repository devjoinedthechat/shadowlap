# Frameworks

If your tools are defined through a framework, declare the effect once with an adapter. Execution is routed through `tool()` from `@shadowlap/sdk`; only the framework's *input* is recorded, never its context objects (run contexts, abort signals, tracing handles). API calls need no adapter at all, whatever the framework: the sidecar records them through the provider base URL.

The TypeScript adapters live in `@shadowlap/adapters` and the Python ones in `shadowlap.adapters` (part of the `shadowlap` package); until they are published, [install them from a clone](./sdk.md#install). Both type the shapes they touch structurally and carry no framework dependencies.

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

Every executable tool needs an effect; `withEffects` throws listing the ones you forgot. Client-side tools (no `execute`) pass through. A streaming tool (`async *execute`) still streams: its progress values reach the UI as they come, its last value is recorded as the result the model is shown, and a replay yields that value alone.

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

## Python

Parameters a framework injects are never recorded, in any Python framework: a Pydantic AI `RunContext`, an OpenAI Agents `RunContextWrapper` or `ToolContext`, a LangChain `RunnableConfig`, callback manager or `Injected…` argument. The SDK recognizes them by the types in their annotation: the class, a generic's arguments (`Optional[...]`, `RunContext[Deps]`) and `Annotated`'s markers (`Annotated[str, InjectedToolArg]`), never by its descriptions, so `Annotated[str, "Injected document text"]` is still recorded. Name any other with `exclude=(...)`. Typed arguments, as Pydantic AI documents them (a Pydantic model, a dataclass, a `datetime.date`, a UUID, an `Enum`), are the tool's real input and are recorded in their JSON form, as results are; an argument that can't be recorded fails before the tool runs, with a message naming it.

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

Every adapter runs in CI against the real framework, not a stand-in: record, a replay that executes nothing, and a fork that blocks the write, through the framework's own tool path (`generateText` with the AI SDK's mock model, the Agents SDK's `FunctionTool.invoke`, Mastra's `createTool`, LangGraph's `ToolNode`, the Anthropic tool runner end to end through the sidecar, a Pydantic AI `Agent` with `FunctionModel`, the Python Agents SDK's `Runner` with a scripted model, a compiled LangGraph graph in Python, CrewAI's `BaseTool.run`). Versions are pinned in `testing/frameworks/package.json` and the Frameworks workflow, and re-tested weekly against the latest releases, on Linux, macOS and Windows.

| Framework | Pinned version |
|---|---|
| Vercel AI SDK (`ai`) | 7.0.103 |
| OpenAI Agents SDK (`@openai/agents`) | 0.18.0 |
| Mastra (`@mastra/core`) | 1.67.0 (0.x: `withEffectV0`) |
| LangChain / LangGraph (`@langchain/core`, `@langchain/langgraph`) | 1.2.11 / 1.4.15 |
| Anthropic tool runner (`@anthropic-ai/sdk`) | 0.126.0 |
| Pydantic AI (`pydantic-ai-slim`) | 2.43.0 |
| OpenAI Agents SDK for Python (`openai-agents`) | 0.20.0 |
| LangGraph for Python (`langgraph`, `langchain-core`) | 1.2.11 / 1.6.3 |
| CrewAI (`crewai`) | 1.15.22 |

## Anything else

An adapter is a few lines: wrap the framework's execute function with `tool(name, { effect }, impl)` and record only the input. `wrapFirstArg` in `@shadowlap/adapters` does that for any `(input, ...rest)` signature. Open an issue naming the framework and we'll add it.

Tools served over MCP need no adapter at all: start the server through [`shadowlap mcp`](./mcp.md).
