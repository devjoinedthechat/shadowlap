"""A Microsoft Agent Framework agent on its main OpenAI client, as a user writes it: OpenAIChatClient,
which calls OpenAI's Responses API, given only a model; its key and base URL come from OPENAI_API_KEY
and OPENAI_BASE_URL, which shadowlap run sets. Tools are plain functions wrapped by shadowlap.tool.
QUERY is the user's request. Prints a JSON summary."""

import asyncio
import json
import os
import sys
from typing import Annotated

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "sdks", "python"))

from agent_framework import Agent
from agent_framework.openai import OpenAIChatClient

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
    client = OpenAIChatClient(model="gpt-5")
    agent = Agent(client=client, instructions="Research, then email the team.", tools=[search_web, send_email])
    response = await agent.run(f"Research {QUERY} and email the team.")
    results = []
    for message in response.messages:
        for content in message.contents:
            if getattr(content, "type", None) == "function_result":
                results.append({"call": getattr(content, "call_id", None), "result": str(getattr(content, "result", None))})
    return {"answer": response.text, "model": type(client).__name__, "executed": executed, "results": results}


if __name__ == "__main__":
    print(json.dumps(asyncio.run(main()), default=str))
