"""A LlamaIndex agent: a FunctionAgent (llama_index.core.agent.workflow) on LlamaIndex's Anthropic LLM,
whose model calls go to whatever ANTHROPIC_BASE_URL names (the sidecar, in front of a scripted
Anthropic API), with FunctionTools made from functions wrapped by shadowlap.tool, one of them taking
the workflow's Context. QUERY is the user's request, so a replay with another forks at the first
model call. Prints a JSON summary."""

import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "sdks", "python"))

from llama_index.core.agent.workflow import FunctionAgent, ToolCallResult  # noqa: E402
from llama_index.core.tools import FunctionTool  # noqa: E402
from llama_index.core.workflow import Context  # noqa: E402
from llama_index.llms.anthropic import Anthropic  # noqa: E402

from shadowlap import tool  # noqa: E402

QUERY = os.environ.get("QUERY", "shadowlap")
executed = []


@tool(effect="read", trust="untrusted")
async def search_web(ctx: Context, query: str) -> str:
    """Search the web for a query."""
    executed.append("search_web")
    return json.dumps({"results": [f"{query} #1"]})


@tool(effect="write")
def send_email(to: str, body: str) -> str:
    """Send an email."""
    executed.append("send_email")
    return f"sent to {to}"


async def main() -> dict:
    llm = Anthropic(model="claude-opus-5", api_key="test-key", max_tokens=256, max_retries=0)
    agent = FunctionAgent(tools=[FunctionTool.from_defaults(async_fn=search_web), FunctionTool.from_defaults(fn=send_email)], llm=llm, system_prompt="Research, then email the team.")
    handler = agent.run(user_msg=f"Research {QUERY} and email the team.")
    results = []
    async for event in handler.stream_events():
        if isinstance(event, ToolCallResult):
            results.append({"name": event.tool_name, "output": str(event.tool_output.content), "is_error": bool(event.tool_output.is_error)})
    answer = await handler
    return {"answer": str(answer), "executed": executed, "results": results}


if __name__ == "__main__":
    print(json.dumps(asyncio.run(main()), default=str))
