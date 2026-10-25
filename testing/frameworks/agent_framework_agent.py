"""A Microsoft Agent Framework agent: an Agent on its Chat Completions client, whose model calls go to
whatever OPENAI_BASE_URL names (the sidecar, in front of a scripted Chat Completions API), with plain
functions wrapped by shadowlap.tool as its tools. QUERY is the user's request, so a replay with
another forks at the first model call. Prints a JSON summary."""

import asyncio
import json
import os
import sys
from typing import Annotated

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "sdks", "python"))

from agent_framework import Agent
from agent_framework.openai import OpenAIChatCompletionClient

from shadowlap import tool

QUERY = os.environ.get("QUERY", "shadowlap")
executed = []


@tool(effect="read", trust="untrusted")
async def search_web(query: Annotated[str, "What to search for"]) -> str:
    """Search the web for a query."""
    executed.append("search_web")
    return json.dumps({"results": [f"{query} #1"]})


@tool(effect="write")
def send_email(to: Annotated[str, "The address"], body: Annotated[str, "The text"]) -> str:
    """Send an email."""
    executed.append("send_email")
    return f"sent to {to}"


async def main() -> dict:
    agent = Agent(client=OpenAIChatCompletionClient(model="gpt-5", api_key="test-key"), instructions="Research, then email the team.", tools=[search_web, send_email])
    response = await agent.run(f"Research {QUERY} and email the team.")
    results = []
    for message in response.messages:
        for content in message.contents:
            if getattr(content, "type", None) == "function_result":
                results.append({"call": getattr(content, "call_id", None), "result": str(getattr(content, "result", None))})
    return {"answer": response.text, "executed": executed, "results": results}


if __name__ == "__main__":
    print(json.dumps(asyncio.run(main()), default=str))
