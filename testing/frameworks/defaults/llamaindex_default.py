"""A LlamaIndex agent on LlamaIndex's default LLM, as a user writes it: a FunctionAgent given no llm, so
it takes LlamaIndex's default, which resolves to llama_index.llms.openai.OpenAI. That client names
https://api.openai.com/v1 itself unless OPENAI_API_BASE is set, so it ignores OPENAI_BASE_URL: under
shadowlap run its calls are captured in the process. Tools are FunctionTools over functions wrapped
by shadowlap.tool. QUERY is the user's request. Prints a JSON summary."""

import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "sdks", "python"))

from llama_index.core.agent.workflow import FunctionAgent, ToolCallResult
from llama_index.core.tools import FunctionTool

from shadowlap import tool

QUERY = os.environ.get("QUERY", "shadowlap")
executed = []


@tool(effect="read", trust="untrusted")
async def search_web(query: str) -> str:
    """Search the web for a query."""
    executed.append("search_web")
    return json.dumps({"results": [f"{query} #1"]})


@tool(effect="write")
def send_email(to: str, body: str) -> str:
    """Send an email."""
    executed.append("send_email")
    return f"sent to {to}"


async def main() -> dict:
    agent = FunctionAgent(tools=[FunctionTool.from_defaults(async_fn=search_web), FunctionTool.from_defaults(fn=send_email)], system_prompt="Research, then email the team.")
    handler = agent.run(user_msg=f"Research {QUERY} and email the team.")
    results = []
    async for event in handler.stream_events():
        if isinstance(event, ToolCallResult):
            results.append({"name": event.tool_name, "output": str(event.tool_output.content), "is_error": bool(event.tool_output.is_error)})
    answer = await handler
    return {"answer": str(answer), "model": type(agent.llm).__name__, "executed": executed, "results": results}


if __name__ == "__main__":
    print(json.dumps(asyncio.run(main()), default=str))
