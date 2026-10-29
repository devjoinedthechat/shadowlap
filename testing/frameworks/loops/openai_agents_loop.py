"""An OpenAI Agents SDK agent as a user writes it: an Agent given no model, run by Runner on the
SDK's default model and client, the OpenAI SDK's, which calls the Responses API. Nothing here names
Shadowlap's address: under shadowlap run the client reads OPENAI_BASE_URL. Tools use
shadowlap.adapters.openai_agents.function_tool. QUERY is the user's request. Prints a JSON summary,
with each tool's result as the model read it."""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "sdks", "python"))

from agents import Agent, Runner
from agents.items import ToolCallItem, ToolCallOutputItem

from shadowlap.adapters.openai_agents import function_tool

QUERY = os.environ.get("QUERY", "shadowlap")
executed = []


@function_tool(effect="read", trust="untrusted")
def search_web(query: str) -> str:
    """Search the web for a query."""
    executed.append("search_web")
    return json.dumps({"results": [f"{query} #1"]})


@function_tool(effect="write")
def send_email(to: str, body: str) -> str:
    """Send an email."""
    executed.append("send_email")
    return f"sent to {to}"


def main() -> dict:
    agent = Agent(name="Researcher", instructions="Research, then email the team.", tools=[search_web, send_email])
    result = Runner.run_sync(agent, f"Research {QUERY} and email the team.")
    names = {item.raw_item.call_id: item.raw_item.name for item in result.new_items if isinstance(item, ToolCallItem)}
    results = [{"tool": names.get(item.raw_item["call_id"]), "result": str(item.output)} for item in result.new_items if isinstance(item, ToolCallOutputItem)]
    return {"answer": str(result.final_output), "model": agent.model or "default", "executed": executed, "results": results}


if __name__ == "__main__":
    print(json.dumps(main()))
